"use strict";
/* ============================================================
   DouYinSparkFlow 前端 v13 — 重构优化版
   · SparkFX：方法论蒸馏自 greensock/GSAP-skills（gsap-core/gsap-performance）
     — 只动 transform/opacity（合成器友好，不触发 layout/paint）
     — autoAlpha 语义：0 时同时 visibility:hidden（不挡点击不耗渲染）
     — stagger：同一批元素共享一次 tween 调度，按索引偏移延迟
     — 单 rAF 循环统一驱动全部 tween（批量读写，避免 layout thrashing）
     — tween 结束立即清 will-change/transform，不残留合成层
     — overwrite:auto 同元素新动画自动杀旧动画（防堆叠泄漏）
     — prefers-reduced-motion：跳过动画直接落终态
   · keyed reconcile：列表增量调和，结构变化只动差异节点
   API 契约：全部 snake_case，与 webui/server.py 严格对齐
   ============================================================ */
import { $, toast as baseToast, api, esc, escMark, FX, reconcile, animateNumber, confirmModal, promptModal, choiceModal } from "./core.js";
const HITOKOTO_ALL = ["动画","漫画","游戏","文学","原创","来自网络","其他","影视","诗词","哲学","抖机灵"];
const CONSOLE_MAX_LINES = 500;   // 控制台 DOM 节点上限（防长任务内存膨胀）

/* ---------- 全局状态 ---------- */
const state = {
  accounts: [],
  message_template: "",
  message_presets: [],
  send_mode: "random",
  selected_preset_index: 0,
  hitokoto_types: [],
  match_mode: "short_id",
  browser_timeout: "120000",
  friend_list_wait_time: "2000",
  task_retry_times: "3",
  log_level: "INFO",
  ai_dedup: "on",
  min_interval: "3",
  max_interval: "8",
  daily_limit: "0",
  rate_limit: "on",
  schedule: { loaded: false, times: [{ hour: 9, minute: 0 }] },
  run: { state: "idle", running: false, mode: "normal" },
  ball_position: {},
  friend_nicknames: {},
  friend_remarks: {},
  friend_groups: {},
  friend_birthdays: {},
  stats: {},
};
const selected = new Set();   // 选中的好友索引
const searchKw = { v: "" };   // 好友搜索关键字
let runOffset = 0;            // 运行日志已读行数
let pollInFlight = false;     // 轮询防重入：慢响应时避免请求重叠

function setConn(online) {
  const c = $("conn");
  c.className = "conn " + (online ? "online" : "offline");
  $("connText").textContent = online ? "在线" : "离线";
}

/* ---------- window 桥接（ES 模块函数默认不挂 window） ----------
   Emotion Ball IIFE 通过包装 window.toast/setConn/switchTab 注入情绪反馈，
   必须在该 IIFE 执行前把模块函数挂到 window，包装才会真正生效。 */
window.toast = function(msg, isErr) { baseToast(msg, isErr); };
function toast(msg, isErr) { return window.toast(msg, isErr); }
window.setConn = setConn;
window.switchTab = switchTab;



/* ---------- 数据加载 ---------- */
async function loadState() {
  const j = await api("/api/state");
  // 只合并已知字段（剔除 run 的临时字段污染）
  for (const k of Object.keys(state)) {
    if (k in j) state[k] = j[k];
  }
  renderAll();
  loadStats();
}
async function loadStats() {
  try {
    const s = await api("/api/stats");
    state.stats = s;
    // 仪表盘统计卡片
    const todayEl = $("statToday");
    const weekEl = $("statWeek");
    const totalEl = $("statTotal");
    const runsEl = $("statRuns");
    if (todayEl) todayEl.textContent = s.today?.sent || 0;
    if (weekEl) weekEl.textContent = s.week?.sent || 0;
    if (totalEl) totalEl.textContent = s.total_sent || 0;
    if (runsEl) runsEl.textContent = s.total_runs || 0;
    // 统计页概览卡片
    const todaySent = s.today?.sent || 0;
    const todaySuccess = s.today?.success || 0;
    const successRate = todaySent > 0 ? Math.round(todaySuccess / todaySent * 100) + '%' : '—';
    if ($('statTodaySent')) $('statTodaySent').textContent = todaySent;
    if ($('statSuccessRate')) $('statSuccessRate').textContent = successRate;
    if ($('statWeekSent')) $('statWeekSent').textContent = s.week?.sent || 0;
    if ($('statTotalSent')) $('statTotalSent').textContent = s.total_sent || 0;
    if ($('statRunCount')) $('statRunCount').textContent = s.total_runs || 0;
    // 平均耗时：优先展示单次发送平均耗时（秒→友好文案）
    if ($('statAvgTime')) $('statAvgTime').textContent = formatDuration(s.avg_send_duration);
    renderAchievements(s.achievements || []);
    renderTrend(s.trend || []);
    renderTopFriends(s.friend_ranking || []);
    renderLargeTrend(7);
    renderRanking();
    renderHourDistribution(s.hour_distribution || []);
    renderTemplateStats(s.template_stats || []);
  } catch (e) {
    // 统计接口失败不影响主功能
  }
}
/* 最近 7 天发送趋势（纯 CSS 柱状图） */
function renderTrend(trend) {
  const box = $("trendBars");
  if (!box) return;
  if (!trend.length) {
    box.innerHTML = '<div style="font-size:11px;color:var(--text-3);padding:8px 0">暂无数据，跑一次任务看看</div>';
    return;
  }
  const max = Math.max(...trend.map(t => t.sent), 1);
  box.innerHTML = trend.map(t => {
    const pct = t.sent ? Math.max(6, Math.round(t.sent / max * 100)) : 2;
    const d = (t.date || "").slice(5); // MM-DD
    return `<div class="trend-bar-wrap" title="${t.date}：发送 ${t.sent} 条">` +
      `<div class="trend-bar" style="height:${pct}%"><span>${t.sent}</span></div>` +
      `<span class="trend-day">${esc(d)}</span></div>`;
  }).join("");
}
/* 好友活跃 TOP（最近发送最多） */
function renderTopFriends(ranking) {
  const box = $("topList");
  if (!box) return;
  if (!ranking || !ranking.length) {
    box.innerHTML = '<div style="font-size:11px;color:var(--text-3);padding:8px 0">暂无活跃记录</div>';
    return;
  }
  const top = ranking.slice(0, 3);
  const max = Math.max(...top.map(r => r.sent), 1);
  box.innerHTML = top.map((r, i) => {
    const uid = r.id || r.unique_id || "";
    const name = r.name || (uid ? nicknameOf(uid) : "") || uid;
    const w = Math.round(r.sent / max * 100);
    return `<div class="top-row">` +
      `<span class="top-rank">${i + 1}</span>` +
      `<span class="top-name" title="${esc(uid)}">${esc(name)}</span>` +
      `<span class="top-bar-bg"><span class="top-bar-fill" style="width:${w}%"></span></span>` +
      `<span class="top-n">${r.sent} 条</span></div>`;
  }).join("");
}
/* 成就渲染 + 新成就庆祝（纯视觉反馈，不做系统操作） */
let _lastAchUnlocked = -1;
function renderAchievements(achList) {
  const box = $("achievements");
  if (!box || !achList.length) return;
  // 统计已解锁数量
  const unlocked = achList.filter(a => a.unlocked).length;
  // 检测新成就：第一次加载只渲染不庆祝，后续新增才庆祝
  const isNew = _lastAchUnlocked >= 0 && unlocked > _lastAchUnlocked;
  box.innerHTML = achList.map(a => {
    const cls = a.unlocked ? "" : "locked";
    const label = a.unlocked ? a.name : `${a.name} ${a.progress}`;
    const tip = `${a.name}：${a.desc}${a.unlocked ? "" : "（" + a.progress + "）"}`;
    return `<span class="achievement ${cls}" data-tip="${esc(tip)}"><span class="ach-icon">${a.icon}</span>${esc(label)}</span>`;
  }).join("");
  if (isNew && unlocked > 0) {
    // 新成就解锁：小球庆祝动画（纯娱乐，无副作用）
    try {
      if (window.__emoCelebrate) window.__emoCelebrate();
    } catch (x) {}
    toast(`🎉 解锁新成就「${achList.filter(a => a.unlocked)[unlocked - 1].name}」！`);
  }
  _lastAchUnlocked = unlocked;
}
function account() { return state.accounts[0] || { username: "", unique_id: "", targets: [] }; }
function friends() { return account().targets || []; }

function renderAll() {
  renderAcct();
  renderRun();
  renderKpi();
  renderSchedule();
  renderFriends();
  renderGroupTags();
  renderPresets();
  renderHitokoto();
  renderSettings();
}

/* ---------- 顶栏 ---------- */
function renderAcct() {
  const a = account();
  const chip = $("acctChip");
  // 侧栏胶囊：抖音用户名 · 抖音号（均来自 Cookie 识别）
  if (chip) {
    chip.textContent = a.username && a.unique_id
      ? `${a.username} · ${a.unique_id}`
      : (a.username || a.unique_id || "未登录");
    chip.classList.toggle("is-guest", !a.cookies_count);
  }
  // 动态标题：<抖音用户名>的火花助手；未登录时兜底"我的火花助手"
  const titleSuffix = (a.username || "我") + "的火花助手";
  const t = $("appTitle");
  if (t) t.textContent = titleSuffix;
  const ht = $("heroTitle");
  if (ht) ht.textContent = titleSuffix;
  document.title = titleSuffix;
  const lg = $("appLogo");
  if (lg) lg.setAttribute("aria-label", titleSuffix);
}

/* ---------- KPI 统计卡片 ---------- */
function renderKpi() {
  const fs = friends();
  const ps = state.message_presets || [];
  const st = state.schedule || {};
  const times = Array.isArray(st.times) && st.times.length
    ? st.times : [{ hour: st.hour ?? 9, minute: st.minute ?? 0 }];

  const kFriends = $("kpiFriends");
  const kFriendsSub = $("kpiFriendsSub");
  const kPresets = $("kpiPresets");
  const kPresetsSub = $("kpiPresetsSub");
  const kSchedule = $("kpiSchedule");
  const kScheduleSub = $("kpiScheduleSub");
  const kRun = $("kpiRun");
  const kRunVal = $("kpiRunVal");
  const kRunSub = $("kpiRunSub");

  animateNumber(kFriends, fs.length, 600);
  kFriendsSub.textContent = account().username || "未配置账号";

  animateNumber(kPresets, ps.length, 600);
  kPresetsSub.textContent = state.send_mode === "random" ? "随机发送" : "固定发送";

  animateNumber(kSchedule, times.length, 600);
  kScheduleSub.textContent = st.loaded
    ? times.map(fmtHM).join("、")
    : "未设置时间";

  // 更新定时任务趋势标签（右上角）
  const kScheduleTrend = $("kpiScheduleTrend");
  if (kScheduleTrend) {
    kScheduleTrend.textContent = st.loaded ? "已启用" : "未启用";
    kScheduleTrend.style.background = st.loaded ? "var(--ok-soft)" : "var(--bg-subtle)";
    kScheduleTrend.style.color = st.loaded ? "var(--ok)" : "var(--text-3)";
  }

  const r = state.run;
  kRun.dataset.s = r.state;
  kRunVal.textContent = r.state === "running" && r.mode === "dryrun"
    ? "测试中" : (RUN_TEXT[r.state] || r.state);
  kRunSub.textContent = r.running ? "执行中…" : (r.started ? "上次 " + new Date(r.started * 1000).toLocaleTimeString("zh-CN") : "待命");
}
const RUN_TEXT = { idle:"空闲", running:"运行中", done:"已完成", error:"出错", stopped:"已停止" };
function renderRun() {
  const r = state.run;
  const el = $("runState");
  el.dataset.s = r.state;
  $("runStateText").textContent =
    r.state === "running" && r.mode === "dryrun" ? "测试运行中" : (RUN_TEXT[r.state] || r.state);
  const bits = [];
  if (r.started) bits.push("开始于 " + new Date(r.started * 1000).toLocaleTimeString("zh-CN"));
  if (r.exitcode !== null && r.exitcode !== undefined) bits.push("退出码 " + r.exitcode);
  $("runMeta").textContent = bits.join(" · ");
  $("btnStop").classList.toggle("hide", !r.running);
  $("btnRun").disabled = r.running;
  $("btnDryRun").disabled = r.running;
  // 同步 Emotion Ball 状态（区分测试/正式模式）
  if (window.setEmotionState) {
    if (r.running) {
      window.setEmotionState(r.mode === "dryrun" ? "dryrun" : "running");
    } else {
      window.setEmotionState(r.state || "idle");
    }
  }
}

/* ---------- 运行进度统计 ---------- */
const _runProgress = { names: new Set(), total: 0 };
function resetRunProgress() {
  _runProgress.names.clear();
  _runProgress.total = friends().length;
}
function updateRunProgress(newLines) {
  if (!newLines || !newLines.length) return;
  // 从日志行提取已处理好友名（去重）
  const re = /(?:已选中好友|给好友|找到目标好友)\s+([^\s，,。]+)/;
  for (const ln of newLines) {
    const m = ln.match(re);
    if (m) _runProgress.names.add(m[1]);
  }
  const total = _runProgress.total || friends().length || 1;
  const count = Math.min(_runProgress.names.size, total);
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  const fill = $("runProgressFill");
  const text = $("runProgressText");
  if (fill) fill.style.width = pct + "%";
  if (text) text.textContent = `${pct}%（${count}/${total}）`;
  // 同步 Emotion Ball 进度环
  if (window.updateProgress) {
    try { window.updateProgress(count / total); } catch(e) {}
  }
}
function finishRunProgress() {
  const fill = $("runProgressFill");
  const text = $("runProgressText");
  if (fill) fill.style.width = "100%";
  if (text) text.textContent = "已完成";
  if (window.updateProgress) { try { window.updateProgress(1); } catch(e) {} }
}
async function startRun(dryrun) {
  try {
    const j = await api("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dryrun: !!dryrun }),
    });
    if (!j.ok) return toast(j.msg || "启动失败", true);
    runOffset = 0;
    $("console").textContent = "";
    resetRunProgress();
    state.run = { state: "running", running: true, mode: dryrun ? "dryrun" : "normal", started: Date.now()/1000, exitcode: null };
    renderRun();
    toast(dryrun ? "测试运行已启动（不发消息）" : "任务已启动");
  } catch (e) { toast(e.message, true); }
}
async function stopRun() {
  try {
    const j = await api("/api/run/stop", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    toast(j.ok ? "已停止" : j.msg, !j.ok);
  } catch (e) { toast(e.message, true); }
}

/* ---------- 运行日志轮询 ---------- */
async function pollRun() {
  if (pollInFlight) return;   // 上一次请求还没回来，跳过本轮，防止重叠
  pollInFlight = true;
  try {
    const j = await api(`/api/run/status?offset=${runOffset}`);
    setConn(true);
    if (j.new_lines && j.new_lines.length) {
      const box = $("console");
      // 智能吸底：只有用户本来就在底部时才跟随滚动（上翻阅读时不打扰）
      const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 28;
      const frag = document.createDocumentFragment();   // 批量写入，一次回流
      for (const ln of j.new_lines) {
        const div = document.createElement("div");
        if (/错误|失败|error|exception/i.test(ln)) div.className = "ln-error";
        else if (/成功|完成|done/i.test(ln)) div.className = "ln-done";
        div.textContent = ln.replace(/\n$/, "");
        frag.appendChild(div);
      }
      box.appendChild(frag);
      // [修复] DOM 节点上限：超过后丢弃最早节点，防止长任务内存膨胀
      while (box.childNodes.length > CONSOLE_MAX_LINES) box.removeChild(box.firstChild);
      runOffset = j.offset;
      if (stick) box.scrollTop = box.scrollHeight;
      // 更新运行进度
      updateRunProgress(j.new_lines);
    }
    const wasRunning = state.run.running;
    // 只取状态字段，避免 new_lines/offset 污染全局 state
    state.run = {
      state: j.state, running: j.running, started: j.started,
      exitcode: j.exitcode, mode: j.mode,
    };
    renderRun();
    renderKpi();
    if (wasRunning && !j.running) {
      // 运行结束：刷新完整状态（好友/Cookies 可能变化）
      finishRunProgress();
      loadState().catch(() => {});
      toast(j.state === "done" ? "运行完成 ✓" : "运行结束：" + RUN_TEXT[j.state], j.state === "done");
    }
  } catch (e) {
    setConn(false);
  } finally {
    pollInFlight = false;
  }
}

/* ---------- 定时任务（支持每天多个时间点） ---------- */
function schedTimes() {
  // 优先读多时间点字段，回退旧单时间字段
  const s = state.schedule || {};
  if (Array.isArray(s.times) && s.times.length)
    return s.times.map(t => ({ hour: t.hour, minute: t.minute }));
  return [{ hour: s.hour ?? 9, minute: s.minute ?? 0 }];
}
function fmtHM(t) {
  return String(t.hour).padStart(2, "0") + ":" + String(t.minute).padStart(2, "0");
}
function renderSchedule() {
  const s = state.schedule || {};
  $("schedTimeText").textContent = schedTimes().map(fmtHM).join("、");
  const badge = $("schedBadge");
  badge.textContent = s.loaded ? "已启用" : "未启用";
  badge.className = "badge " + (s.loaded ? "on" : "off");
  $("btnSchedToggle").textContent = s.loaded ? "停用" : "启用";
  // 更新定时发送页面的状态显示
  const schedStatus = $("schedHeroStatus");
  if (schedStatus) {
    schedStatus.textContent = s.loaded ? "✅ 已启用" : "⏳ 未启用";
  }
  renderSchedEditors();
}
function renderSchedEditors() {
  const box = $("schedTimes");
  box.innerHTML = "";
  schedTimes().forEach((t, i) => {
    const row = document.createElement("div");
    row.className = "sched-time";
    row.innerHTML =
      `<input type="number" data-i="${i}" data-f="hour" min="0" max="23" value="${t.hour}" aria-label="第${i + 1}个时间的小时">` +
      `<span>:</span>` +
      `<input type="number" data-i="${i}" data-f="minute" min="0" max="59" value="${t.minute}" aria-label="第${i + 1}个时间的分钟">` +
      `<button class="del" data-i="${i}" title="删除此时间点" aria-label="删除第${i + 1}个时间点">删除</button>`;
    box.appendChild(row);
  });
  $("btnSchedSaveTime").classList.toggle("hide", schedTimes().length <= 1);
}
function collectSchedTimes() {
  const times = [];
  document.querySelectorAll('#schedTimes .sched-time').forEach(row => {
    const h = parseInt(row.querySelector('[data-f="hour"]').value, 10);
    const m = parseInt(row.querySelector('[data-f="minute"]').value, 10);
    if (!isNaN(h) && !isNaN(m)) times.push({ hour: h, minute: m });
  });
  return times;
}
async function schedToggle() {
  const action = state.schedule.loaded ? "disable" : "enable";
  try {
    const j = await api("/api/schedule", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    toast(j.ok ? (action === "enable" ? "定时任务已启用" : "定时任务已停用")
               : (j.err || j.msg || "操作失败"), !j.ok);
    state.schedule = await api("/api/schedule");
    renderSchedule();
    renderKpi();
  } catch (e) { toast(e.message, true); }
}
async function schedSaveTimes() {
  const times = collectSchedTimes();
  if (!times.length) return toast("至少保留一个时间点", true);
  for (const t of times)
    if (t.hour < 0 || t.hour > 23 || t.minute < 0 || t.minute > 59)
      return toast("时间不合法（时 0-23，分 0-59）", true);
  try {
    const j = await api("/api/schedule/times", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ times }),
    });
    toast(j.ok ? "已保存：每天 " + (j.times || times).map(fmtHM).join("、")
               : (j.err || j.msg || "保存失败"), !j.ok);
    state.schedule = await api("/api/schedule");
    renderSchedule();
    renderKpi();
  } catch (e) { toast(e.message, true); }
}
function schedAddTime() {
  // 就地追加一行编辑器（不写后端，保存时才提交）
  const box = $("schedTimes");
  const i = box.querySelectorAll(".sched-time").length;
  if (i >= 8) return toast("最多 8 个时间点", true);
  const row = document.createElement("div");
  row.className = "sched-time";
  row.innerHTML =
    `<input type="number" data-i="${i}" data-f="hour" min="0" max="23" value="12" aria-label="第${i + 1}个时间的小时">` +
    `<span>:</span>` +
    `<input type="number" data-i="${i}" data-f="minute" min="0" max="59" value="0" aria-label="第${i + 1}个时间的分钟">` +
    `<button class="del" data-i="${i}" title="删除此时间点" aria-label="删除第${i + 1}个时间点">删除</button>`;
  box.appendChild(row);
  FX.from(row, { y: 6, autoAlpha: 0, duration: 160, ease: "power2.out" });
  $("btnSchedSaveTime").classList.remove("hide");
}
function schedDelTime(idx) {
  const box = $("schedTimes");
  const rows = box.querySelectorAll(".sched-time");
  if (rows.length <= 1) return toast("至少保留一个时间点", true);
  rows[idx]?.remove();
  // 重新索引剩余行的 data-i 属性，避免删除后索引错位
  box.querySelectorAll(".sched-time").forEach((row, i) => {
    row.querySelectorAll("[data-i]").forEach(el => { el.dataset.i = i; });
  });
  $("btnSchedSaveTime").classList.add("hide");
}

/* ---------- 好友管理（keyed reconcile 增量渲染） ---------- */
function makeFriendRow() {
  const row = document.createElement("div");
  row.className = "friend-item";
  row.innerHTML =
    `<input type="checkbox">` +
    `<span class="idx"></span>` +
    `<span class="fid">` +
      `<span class="fid-main"></span>` +
      `<span class="fid-sub"></span>` +
    `</span>` +
    `<button class="remark-btn" title="编辑备注">✏️</button>` +
    `<button class="group-btn" title="分组标签">🏷️</button>` +
    `<button class="bday-btn" title="设置生日">🎂</button>` +
    `<button class="nick-btn" title="获取/刷新昵称">🔄</button>` +
    `<button class="del">删除</button>`;
  return row;
}
function nicknameOf(id) {
  return (state.friend_nicknames && state.friend_nicknames[id]) || "";
}
function remarkOf(id) {
  return (state.friend_remarks && state.friend_remarks[id]) || "";
}
function groupOf(id) {
  return (state.friend_groups && state.friend_groups[id]) || "";
}
function birthdayOf(id) {
  return (state.friend_birthdays && state.friend_birthdays[id]) || "";
}
function updateFriendRow(row, f, i, kw) {
  // 只在内容真正变化时写 DOM（搜索关键字没变就零写入）
  const cb = row.firstChild;
  if (cb.dataset.i !== String(i)) {
    cb.dataset.i = i;
    cb.setAttribute("aria-label", "选择 " + f);
    cb.checked = selected.has(i);
    row.children[1].textContent = i + 1;
    // children: 3=remark, 4=group, 5=bday, 6=nick, 7=del
    row.children[7].dataset.i = i;
    row.children[7].title = "删除 " + f;
    row.children[6].dataset.id = f;
    row.children[6].title = nicknameOf(f) ? "刷新昵称" : "获取昵称";
    row.children[5].dataset.id = f;
    row.children[5].title = birthdayOf(f) ? "生日：" + birthdayOf(f) + "（点击修改）" : "设置生日";
    row.children[4].dataset.id = f;
    row.children[4].title = groupOf(f) ? "分组：" + groupOf(f) + "（点击修改）" : "添加分组标签";
    row.children[3].dataset.id = f;
    row.children[3].title = remarkOf(f) ? "编辑备注：" + remarkOf(f) : "添加备注";
    row.children[2].title = f;
  } else if (cb.checked !== selected.has(i)) {
    cb.checked = selected.has(i);
  }
  const nick = nicknameOf(f);
  const remark = remarkOf(f);
  const group = groupOf(f);
  const bday = birthdayOf(f);
  const fidMain = row.children[2].children[0];
  const fidSub = row.children[2].children[1];
  const displayMain = remark || nick || f;
  // 副行文本：昵称 · 抖音号
  let subText = "";
  if (remark) subText = nick ? `${nick} · ${f}` : f;
  else if (nick) subText = f;
  // 徽章：分组 + 生日
  const badges = [];
  if (group) badges.push(`<span class="fid-badge g">${esc(group)}</span>`);
  if (bday) badges.push(`<span class="fid-badge b">🎂${esc(bday)}</span>`);
  // 主行（搜索关键字变化时重新高亮）
  if (row.__kw !== kw) {
    row.__kw = kw;
    fidMain.innerHTML = escMark(displayMain, kw);
  } else if (fidMain.textContent !== displayMain) {
    fidMain.innerHTML = escMark(displayMain, kw);
  }
  // 副行
  if (badges.length) {
    const html = (subText ? escMark(subText, kw) + " " : "") + badges.join(" ");
    if (fidSub.innerHTML !== html) fidSub.innerHTML = html;
    fidSub.style.display = "";
  } else {
    if (row.__kw === kw && fidSub.textContent !== subText) fidSub.innerHTML = escMark(subText, kw);
    fidSub.style.display = subText ? "" : "none";
  }
  // 备注名高亮标记（有备注时主行用特殊样式）
  row.children[2].classList.toggle("has-remark", !!remark);
}
function renderFriends() {
  const list = $("friendList");
  const fs = friends();
  // 清理失效索引
  for (const i of [...selected]) if (i >= fs.length) selected.delete(i);
  if (!fs.length) {
    $("friendCnt").textContent = "0";
    list.__nodes = new Map();
    list.innerHTML = '<div class="empty">还没有好友<br>在上方输入抖音号添加，就能开始自动续火花</div>';
    return updateBatchBar();
  }
  const kw = searchKw.v.toLowerCase();
  list.querySelector(".empty")?.remove();   // 清掉残留的空态提示
  // 按分组过滤
  let filteredFs = fs;
  if (currentGroup !== "all") {
    filteredFs = fs.filter(f => {
      const g = groupOf(f);
      return g === currentGroup || (currentGroup === "其他" && g && !GROUP_OPTIONS.includes(g));
    });
  }
  $("friendCnt").textContent = filteredFs.length + (filteredFs.length !== fs.length ? "/" + fs.length : "");
  // key = 好友值（添加时已强制去重）；dataset.i 必须使用【完整 friends() 下标】，
  // 否则在非 all 分组下删除/勾选/复制会错位到别的好友
  const idxOf = new Map(fs.map((f, i) => [f, i]));
  const fresh = reconcile(list, filteredFs,
    () => makeFriendRow(),
    (row, f) => updateFriendRow(row, f, idxOf.get(f), kw));
  // 搜索过滤：节点显隐切换（零重建）—— 同时匹配抖音号、昵称、备注
  let shown = 0;
  const hidden = kw ? new Set(filteredFs.filter(f => {
    const nick = nicknameOf(f).toLowerCase();
    const remark = remarkOf(f).toLowerCase();
    return !f.toLowerCase().includes(kw) && !nick.includes(kw) && !remark.includes(kw);
  })) : null;
  for (const [f, node] of list.__nodes) {
    const off = hidden && hidden.has(f);
    if (node.style.display === (off ? "none" : "")) { /* 无变化零写入 */ }
    else node.style.display = off ? "none" : "";
    if (!off) shown++;
  }
  // 空态提示（独立于好友节点，不影响 __nodes 调和）
  let empty = list.querySelector(".empty");
  if (!shown) {
    if (!empty) { empty = document.createElement("div"); empty.className = "empty"; list.appendChild(empty); }
    empty.innerHTML = `没有匹配「${esc(searchKw.v)}」的好友`;
    empty.style.display = "";
  } else if (empty) empty.style.display = "none";
  // 新增行入场：少量元素才 stagger（大量数据保持瞬时，性能优先）
  const visible = fresh.filter(n => n.style.display !== "none");
  if (visible.length)
    FX.from(visible.length <= 12 ? visible : visible.slice(0, 12), {
      y: 6, autoAlpha: 0, duration: 180,
      stagger: visible.length <= 8 ? 28 : 10, ease: "power2.out",
    });
  updateBatchBar();
}
function updateBatchBar() {
  const n = selected.size;
  $("batchBar").classList.toggle("show", n > 0);
  $("batchN").textContent = n;
  $("btnSelectAll").textContent = (n === friends().length && n > 0) ? "取消全选" : "全选";
}
async function saveFriends(newTargets) {
  const a = account();
  const task = { username: a.username, unique_id: a.unique_id, targets: newTargets };
  await api("/api/config", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tasks: [task] }),
  });
  await loadState();
}
async function addFriend() {
  const input = $("newFriend");
  const v = input.value.trim();
  if (!v) return;
  const fs = friends();
  if (fs.some(f => f.toLowerCase() === v.toLowerCase()))
    return toast("该好友已在列表中", true);
  if (v.includes('"') || v.includes("\\")) return toast("抖音号含非法字符", true);
  try {
    await saveFriends([...fs, v]);
    input.value = "";
    toast("已添加 " + v + "，正在获取昵称…");
    // 异步获取昵称，不阻塞用户操作
    resolveNickname(v).catch(() => {});
  } catch (e) { toast(e.message, true); }
}
async function saveRemark(uid, remark) {
  try {
    const r = await api("/api/friend/remark", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ unique_id: uid, remark: remark }),
    });
    if (r.ok) {
      state.friend_remarks = r.friend_remarks || state.friend_remarks;
      renderFriends();
      if (window.emoReact) window.emoReact("remark_saved");
    }
    return r;
  } catch (e) {
    toast("保存备注失败：" + e.message, true);
    if (window.emoReact) window.emoReact("config_fail");
    return { ok: false, msg: e.message };
  }
}
async function editRemark(uid) {
  const current = remarkOf(uid);
  const display = current || nicknameOf(uid) || uid;
  if (window.emoReact) window.emoReact("remark_open");
  const input = await promptModal({
    title: "设置备注名",
    message: `给「${display}」设置备注名，留空则删除备注。`,
    defaultValue: current,
    placeholder: "输入备注名",
    confirmText: "保存",
  });
  if (input === null) return; // 取消
  const remark = input.trim();
  saveRemark(uid, remark).then(r => {
    if (r.ok) {
      if (remark) toast(`备注已保存：${remark}`);
      else toast("备注已删除");
    }
  });
}
/* v27：好友分组标签（保存到 FRIEND_GROUPS） */
const GROUP_OPTIONS = ["闺蜜", "兄弟", "同事", "同学", "家人", "亲友", "普通朋友", "其他"];
let currentGroup = "all";
/* 动态渲染好友分组标签 */
function renderGroupTags() {
  const box = $("friendGroupTags");
  if (!box) return;
  const fs = friends();
  // 统计各分组人数
  const counts = { all: fs.length };
  for (const g of GROUP_OPTIONS) counts[g] = 0;
  for (const f of fs) {
    const g = groupOf(f);
    if (g && counts.hasOwnProperty(g)) counts[g]++;
    else if (g) counts["其他"] = (counts["其他"] || 0) + 1;
  }
  const GROUP_ICONS = {"闺蜜":"👭","兄弟":"👬","同事":"💼","同学":"🎓","家人":"👨‍👩‍👧","亲友":"🎀","普通朋友":"👤","其他":"📁"};
  let html = `<span class="group-tag${currentGroup === "all" ? " active" : ""}" data-group="all">全部 <span class="group-count">${counts.all}</span></span>`;
  for (const g of GROUP_OPTIONS) {
    const icon = GROUP_ICONS[g] || "🏷️";
    html += `<span class="group-tag${currentGroup === g ? " active" : ""}" data-group="${esc(g)}">${icon} ${esc(g)} <span class="group-count">${counts[g] || 0}</span></span>`;
  }
  box.innerHTML = html;
}
/* 分组标签点击事件 */
document.addEventListener("click", function(e) {
  const tag = e.target.closest(".group-tag");
  if (!tag || !tag.dataset.group) return;
  currentGroup = tag.dataset.group;
  selected.clear();
  updateBatchBar();
  renderGroupTags();
  renderFriends();
});

async function editGroup(uid) {
  const current = groupOf(uid);
  const display = remarkOf(uid) || nicknameOf(uid) || uid;
  const input = await promptModal({
    title: "设置分组",
    message: `给「${display}」选择分组，留空则清除。`,
    defaultValue: current,
    placeholder: `可用：${GROUP_OPTIONS.join(" / ")}`,
    confirmText: "保存",
  });
  if (input === null) return;
  const g = input.trim();
  try {
    const groups = Object.assign({}, state.friend_groups || {});
    if (g) groups[uid] = g; else delete groups[uid];
    await api("/api/ai/features", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ friend_groups: groups }),
    });
    state.friend_groups = groups;
    renderFriends();
    toast(g ? `已打标签：${g}` : "已清除分组标签");
    if (window.emoReact) window.emoReact("remark_saved");
  } catch (e) { toast(e.message, true); }
}
/* v27：好友生日（保存到 FRIEND_BIRTHDAYS，生日当天自动生成祝福） */
async function editBirthday(uid) {
  const current = birthdayOf(uid);
  const display = remarkOf(uid) || nicknameOf(uid) || uid;
  const input = await promptModal({
    title: "设置生日",
    message: `给「${display}」设置生日，格式 MM-DD，留空清除。`,
    defaultValue: current,
    placeholder: "例如 09-23",
    confirmText: "保存",
  });
  if (input === null) return;
  const b = input.trim();
  if (b && !/^\d{2}-\d{2}$/.test(b)) return toast("生日格式应为 MM-DD", true);
  try {
    const bdays = Object.assign({}, state.friend_birthdays || {});
    if (b) bdays[uid] = b; else delete bdays[uid];
    await api("/api/ai/features", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ friend_birthdays: bdays }),
    });
    state.friend_birthdays = bdays;
    renderFriends();
    toast(b ? `生日已设置：${b}` : "已清除生日");
    if (window.emoReact) window.emoReact("remark_saved");
  } catch (e) { toast(e.message, true); }
}
async function resolveNickname(uid, force, silent) {
  if (!silent && window.emoReact) window.emoReact("nick_start");
  try {
    const r = await api("/api/friend/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ unique_id: uid, force: !!force }),
    });
    if (r.ok && r.nickname) {
      state.friend_nicknames[uid] = r.nickname;
      renderFriends();
      if (!silent) toast(`已获取昵称：${r.nickname}`);
      if (!silent && window.emoReact) window.emoReact("nick_done", `拿到「${r.nickname}」啦~`, true);
    } else if (!force) {
      if (!silent) toast(r.msg || "获取昵称失败，可点击🔄重试", true);
      if (!silent && window.emoReact) window.emoReact("nick_fail", null, true);
    } else {
      if (!silent) toast(r.msg || "获取昵称失败", true);
      if (!silent && window.emoReact) window.emoReact("nick_fail", null, true);
    }
    return r;
  } catch (e) {
    if (!silent) toast("获取昵称失败：" + e.message, true);
    if (!silent && window.emoReact) window.emoReact("nick_fail", null, true);
    return { ok: false, msg: e.message };
  }
}
async function refreshAllNicknames() {
  const fs = friends();
  if (!fs.length) return toast("好友列表为空");
  const go = await confirmModal({
    title: "批量获取昵称",
    message: `将逐个获取 ${fs.length} 个好友的昵称，可能需要较长时间，是否继续？`,
    confirmText: "开始获取",
    cancelText: "取消",
  });
  if (!go) return;
  let ok = 0, fail = 0;
  if (window.emoReact) window.emoReact("nick_start");
  for (let i = 0; i < fs.length; i++) {
    const uid = fs[i];
    // 每 2 个好友更新一次进度提示，避免频繁打断
    if (i % 2 === 0 && window.emoReact) {
      window.emoReact("nick_progress", `正在获取 ${i + 1}/${fs.length} 的昵称…`);
    }
    const r = await resolveNickname(uid, true, true); // silent，由外层统一反馈
    if (r.ok && r.nickname) ok++; else fail++;
  }
  await loadState();
  renderFriends();
  if (fail === 0) {
    if (window.emoReact) window.emoReact("nick_done", null, true);
  } else {
    if (window.emoReact) window.emoReact("nick_fail", `成功 ${ok} 个，失败 ${fail} 个`, true);
  }
  toast(`完成：成功 ${ok} 个，失败 ${fail} 个`);
}
async function delFriend(i) {
  const fs = friends();
  if (!fs[i]) return;
  const ok = await confirmModal({
    title: "删除好友",
    message: `确定删除好友「${fs[i]}」吗？`,
    confirmText: "删除",
    cancelText: "取消",
    danger: true,
  });
  if (!ok) return;
  try {
    const next = fs.slice();
    next.splice(i, 1);
    selected.clear();
    await saveFriends(next);
    toast("已删除 " + fs[i]);
    if (window.emoReact) window.emoReact("friend_del");
  } catch (e) { toast(e.message, true); }
}
async function batchDel() {
  if (!selected.size) return;
  const fs = friends();
  const names = [...selected].map(i => fs[i]).filter(Boolean);
  const ok = await confirmModal({
    title: "批量删除好友",
    message: `确定删除 ${names.length} 个好友吗？\n${names.join("、")}`,
    confirmText: `删除 ${names.length} 个`,
    cancelText: "取消",
    danger: true,
  });
  if (!ok) return;
  try {
    const next = fs.filter((_, i) => !selected.has(i));
    selected.clear();
    await saveFriends(next);
    toast(`已删除 ${names.length} 个好友`);
    if (window.emoReact) window.emoReact("friend_delall");
  } catch (e) { toast(e.message, true); }
}

/* ---------- 消息预设（keyed reconcile 增量渲染） ---------- */
function renderPresets() {
  const list = $("presetList");
  const ps = state.message_presets || [];
  $("modeSeg").querySelectorAll("button").forEach(b =>
    b.classList.toggle("active", b.dataset.mode === state.send_mode));
  if (!ps.length) {
    list.__nodes = new Map();
    list.innerHTML = '<div class="empty">没有预设<br>添加一条文案，或留空使用下方兜底模板</div>';
    return;
  }
  let idx = state.selected_preset_index;
  if (idx < 0 || idx >= ps.length) idx = 0;
  list.querySelector(".empty")?.remove();   // 清掉残留的空态提示
  // key = "索引|内容"：内容编辑后 key 变化 → 该行重建，其余行原位复用
  const keys = ps.map((p, i) => i + "|" + p);
  const fresh = reconcile(list, keys,
    () => {
      const row = document.createElement("div");
      row.className = "preset-item";
      row.innerHTML =
        `<input type="radio" name="preset" title="固定发送此条">` +
        `<span class="txt"></span>` +
        `<button class="op edit">编辑</button>` +
        `<button class="op del">删除</button>`;
      return row;
    },
    (row, k) => {
      const i = parseInt(k, 10);
      const p = k.slice(k.indexOf("|") + 1);
      const cb = row.firstChild;
      cb.dataset.i = i;
      cb.checked = i === idx;
      cb.setAttribute("aria-label", "固定发送：" + p);
      const txt = row.children[1];
      txt.title = p;
      txt.textContent = p;
      row.children[2].dataset.i = i;
      row.children[3].dataset.i = i;
    });
  const visible = fresh;
  if (visible.length)
    FX.from(visible.length <= 12 ? visible : visible.slice(0, 12), {
      y: 6, autoAlpha: 0, duration: 180,
      stagger: visible.length <= 8 ? 28 : 10, ease: "power2.out",
    });
}
async function saveConfig(patch) {
  await api("/api/config", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  await loadState();
}
async function addPreset() {
  const input = $("newPreset");
  const v = input.value.trim();
  if (!v) return;
  try {
    await saveConfig({ message_presets: [...(state.message_presets || []), v] });
    input.value = "";
    toast("预设已添加");
  } catch (e) { toast(e.message, true); }
}
async function editPreset(i) {
  const ps = state.message_presets || [];
  if (i < 0 || i >= ps.length) return;
  const v = await promptModal({
    title: "编辑预设",
    message: "修改这条文案预设的内容：",
    defaultValue: ps[i],
    placeholder: "输入预设内容",
    confirmText: "保存",
  });
  if (v === null) return;
  const nv = v.trim();
  if (!nv) return toast("内容不能为空", true);
  const next = ps.slice();
  next[i] = nv;
  try { await saveConfig({ message_presets: next }); toast("已保存"); }
  catch (e) { toast(e.message, true); }
}
async function delPreset(i) {
  const ps = state.message_presets || [];
  if (i < 0 || i >= ps.length) return;
  const ok = await confirmModal({
    title: "删除预设",
    message: `确定删除预设「${ps[i]}」吗？`,
    confirmText: "删除",
    cancelText: "取消",
    danger: true,
  });
  if (!ok) return;
  const next = ps.slice();
  next.splice(i, 1);
  const patch = { message_presets: next };
  if (state.selected_preset_index >= next.length)
    patch.selected_preset_index = Math.max(0, next.length - 1);
  try { await saveConfig(patch); toast("已删除"); if (window.emoReact) window.emoReact("preset_del"); }
  catch (e) { toast(e.message, true); }
}

/* ---------- 一言类型 ---------- */
function renderHitokoto() {
  const box = $("hitokotoChips");
  const cur = new Set(state.hitokoto_types || []);
  box.innerHTML = "";
  HITOKOTO_ALL.forEach(t => {
    const b = document.createElement("button");
    b.className = "chip" + (cur.has(t) ? " on" : "");
    b.textContent = t;
    b.dataset.t = t;
    b.setAttribute("aria-pressed", cur.has(t) ? "true" : "false");
    box.appendChild(b);
  });
}
async function toggleHitokoto(t) {
  const cur = new Set(state.hitokoto_types || []);
  cur.has(t) ? cur.delete(t) : cur.add(t);
  if (cur.size === 0) return toast("至少保留一种类型", true);
  try { await saveConfig({ hitokoto_types: [...cur] }); }
  catch (e) { toast(e.message, true); }
}

/* ---------- 设置 ---------- */
function renderSettings() {
  $("fMatchMode").value = state.match_mode || "short_id";
  $("fLogLevel").value = state.log_level || "INFO";
  $("fTimeout").value = state.browser_timeout || "120000";
  $("fWaitTime").value = state.friend_list_wait_time || "2000";
  $("fRetry").value = state.task_retry_times || "3";
  $("fDedup").value = state.ai_dedup || "on";
  $("fMinInterval").value = state.min_interval || "3";
  $("fMaxInterval").value = state.max_interval || "8";
  $("fDailyLimit").value = state.daily_limit || "0";
  $("fRateLimit").value = state.rate_limit || "on";
  $("msgTemplate").value = state.message_template || "";
  const a = account();
  const cui = $("ckUidInput");
  // 默认显示当前账号 uid；用户手动输入过则不覆盖
  if (cui) {
    if (!cui.dataset.touched) cui.value = a.unique_id || "";
    if (!cui._bound) {
      cui._bound = true;
      cui.addEventListener("input", () => { cui.dataset.touched = "1"; });
    }
  }
  const n = a.cookies_count ?? 0;
  const cc = $("ckCount");
  cc.textContent = n + " 条";
  cc.className = "ck-count" + (n ? "" : " zero");
}
async function saveSettings() {
  const patch = {
    match_mode: $("fMatchMode").value,
    log_level: $("fLogLevel").value,
    browser_timeout: $("fTimeout").value,
    friend_list_wait_time: $("fWaitTime").value,
    task_retry_times: $("fRetry").value,
    ai_dedup: $("fDedup").value,
    min_interval: $("fMinInterval").value,
    max_interval: $("fMaxInterval").value,
    daily_limit: $("fDailyLimit").value,
    rate_limit: $("fRateLimit").value,
  };
  try {
    await saveConfig(patch); toast("设置已保存");
    if (window.emoReact) window.emoReact("settings_saved");
  } catch (e) { toast(e.message, true); }
}
async function saveTemplate() {
  try {
    await saveConfig({ message_template: $("msgTemplate").value }); toast("模板已保存");
    if (window.emoReact) window.emoReact("template_saved");
  } catch (e) { toast(e.message, true); }
}
async function saveCookies() {
  const raw = $("ckTextarea").value.trim();
  if (!raw) return toast("请先粘贴 Cookies JSON", true);
  const curUid = (account().unique_id || "").trim();
  const uid = ($("ckUidInput").value || "").trim() || curUid;
  if (!uid) return toast("缺少登录抖音号", true);
  // Cookie 验证：同账号确认 / 异账号警告
  if (curUid && uid.toLowerCase() === curUid.toLowerCase()) {
    const ok = await confirmModal({
      title: "保存 Cookie",
      message: `检测为同一个账号的 Cookie（${uid}），是否保存？`,
      confirmText: "保存",
      cancelText: "取消",
    });
    if (!ok) return;
  } else if (curUid) {
    const ok = await confirmModal({
      title: "检测到新账号",
      message: `发现非上个账号的 Cookie！\n\n当前账号：${curUid}\n新账号：${uid}\n\n保存后会清理当前脚本的所有信息（好友列表、昵称、备注、分组、生日等）并切换到新账号，连接将断开重连。\n\n此操作不可撤销，是否继续？`,
      confirmText: "确认切换",
      cancelText: "取消",
      danger: true,
    });
    if (!ok) return;
  }
  try {
    const j = await api("/api/cookies", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ unique_id: uid, cookies: raw }),
    });
    if (!j.ok) {
      toast(j.msg, true);
      if (window.emoReact) window.emoReact("config_fail");
      return;
    }
    toast(j.switched ? `已切换到账号 ${uid}（旧数据已清理）` : `Cookies 已保存（${j.count} 条）`);
    $("ckTextarea").value = "";
    if (window.emoReact) window.emoReact(j.switched ? "cookies_switched" : "cookies_saved");
    await loadState();
    // 用 Cookie 识别真实抖音昵称与抖音号
    identifyAccount(true);
  } catch (e) { toast(e.message, true); }
}

/* 从 Cookie 识别当前登录账号（昵称/抖音号），静默模式用于首屏自动触发 */
let _identifying = false;
async function identifyAccount(verbose = false) {
  if (_identifying) return;
  const a = account();
  if (!a.cookies_count) return;
  _identifying = true;
  try {
    const r = await api("/api/account/identify", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    if (r.ok && r.profile) {
      const p = r.profile;
      let changed = false;
      if (p.nickname && a.username !== p.nickname) { a.username = p.nickname; changed = true; }
      if (p.unique_id && a.unique_id !== p.unique_id) { a.unique_id = p.unique_id; changed = true; }
      if (changed) renderAcct();
      if (verbose) toast(`已识别账号：${p.nickname}（${p.unique_id}）`);
      if (changed) await loadState();
    } else if (verbose) {
      toast(r.msg || "账号识别失败", true);
    }
  } catch (e) {
    if (verbose) toast("账号识别失败：" + (e.message || e), true);
  } finally {
    _identifying = false;
  }
}
async function logoutAccount() {
  const a = account();
  const uid = a.unique_id;
  if (!uid) return toast("当前无已登录账号", true);
  if (window.emoReact) window.emoReact("working", "退出登录…");
  try {
    const j = await api("/api/cookies/logout", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ unique_id: uid }),
    });
    toast(j.ok ? `已退出账号 ${uid}` : j.msg, !j.ok);
    $("ckTextarea").value = "";
    const cui = $("ckUidInput");
    if (cui) { cui.value = ""; delete cui.dataset.touched; }
    await loadState();
    if (window.emoReact) window.emoReact("logout_done");
  } catch (e) { toast(e.message, true); }
}
/* v28：一键清除登录信息 */
async function clearAccount() {
  const ok1 = await confirmModal({
    title: "清除登录信息",
    message: "这将永久删除：\n• 所有 Cookie（连接自动断开）\n• 好友列表\n• 昵称、备注、分组、生日\n• 消息预设、模板\n• 历史日志\n\n此操作不可撤销！（建议先在「配置备份」导出配置）",
    confirmText: "我已知晓，继续",
    cancelText: "取消",
    danger: true,
  });
  if (!ok1) return;
  const ok2 = await confirmModal({
    title: "再次确认",
    message: "真的要清除全部数据并断开连接吗？",
    confirmText: "确认清除",
    cancelText: "取消",
    danger: true,
  });
  if (!ok2) return;
  if (window.emoReact) window.emoReact("working", "清除登录信息…");
  try {
    const j = await api("/api/account/clear", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    toast(j.ok ? "登录信息已全部清除，连接已断开" : j.msg, !j.ok);
    if (j.ok) {
      $("ckTextarea").value = "";
      const cui = $("ckUidInput");
      if (cui) { cui.value = ""; delete cui.dataset.touched; }
      await loadState();
      if (window.emoReact) window.emoReact("logout_done");
    }
  } catch (e) { toast(e.message, true); }
}

/* ---------- 日志 ---------- */
async function loadLogs() {
  const box = $("logFiles");
  box.innerHTML = '<div class="empty">加载中…</div>';
  try {
    const j = await api("/api/logs");
    if (!j.files || !j.files.length) {
      box.innerHTML = '<div class="empty">暂无日志文件<br>运行一次任务后会在这里出现</div>';
      return;
    }
    box.innerHTML = "";
    j.files.forEach(f => {
      const d = document.createElement("div");
      d.className = "log-file";
      const time = new Date(f.mtime * 1000).toLocaleString("zh-CN");
      const kb = (f.size / 1024).toFixed(1);
      d.innerHTML =
        `<div class="head"><span class="name">${esc(f.name)}</span>` +
        `<span>${time}</span><span>${kb} KB</span></div>` +
        `<pre>${esc(f.tail)}</pre>`;
      box.appendChild(d);
    });
  } catch (e) {
    box.innerHTML = '<div class="empty">加载失败：' + esc(e.message) + "</div>";
  }
}

/* ---------- Tab 切换 ---------- */
const tabSeen = new Set();   // 已看过一次的 tab 不再重复入场动画（克制动效）
function switchTab(name) {
  $("tabs").querySelectorAll("button").forEach(b => {
    const on = b.dataset.tab === name;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
    b.tabIndex = on ? 0 : -1;   // roving tabindex（ARIA tabs 规范）
  });
  ["dashboard", "friends", "msg", "stats", "settings", "logs"].forEach(t => {
    const panel = $("tab-" + t);
    if (panel) panel.classList.toggle("tab-hidden", t !== name);
  });
  // 首次进入该 tab：卡片做一次 180ms 的轻入场（transform/opacity，合成器动画）
  if (name === "logs") loadLogs();
  if (name === "stats") loadStats();
  if (name === "dashboard") loadDashboard();
  if (!tabSeen.has(name)) {
    tabSeen.add(name);
    const cards = $("tab-" + name).querySelectorAll(".card");
    if (cards.length) FX.from(cards, { y: 10, autoAlpha: 0, duration: 180, stagger: 45, ease: "power2.out" });
  }
  selected.clear();
  updateBatchBar();
}

/* ---------- 事件绑定 ---------- */
$("tabs").addEventListener("click", e => {
  const b = e.target.closest("button[data-tab]");
  // 走 window.switchTab：情绪球 IIFE 会在 window 入口上包装 tab 情绪反馈
  if (b) window.switchTab(b.dataset.tab);
});
// 全局 data-nav 委托（快捷操作卡片等，替代内联 onclick）
document.addEventListener("click", e => {
  const nav = e.target.closest("[data-nav]");
  if (nav) window.switchTab(nav.dataset.nav);
});
// tablist 键盘导航（左右箭头）
$("tabs").addEventListener("keydown", e => {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  const btns = [...$("tabs").querySelectorAll("button[data-tab]")];
  const cur = btns.findIndex(b => b.classList.contains("active"));
  const next = (cur + (e.key === "ArrowRight" ? 1 : -1) + btns.length) % btns.length;
  btns[next].focus();
  window.switchTab(btns[next].dataset.tab);
});

/* ---------- v32.1 键盘快捷键：1-6 切页、/ 聚焦好友搜索 ---------- */
const TAB_SHORTCUTS = ["dashboard", "friends", "msg", "stats", "settings", "logs"];
document.addEventListener("keydown", e => {
  // 输入框/文本域/下拉/可编辑区域内不拦截（避免影响打字和 IME 组合）
  const t = e.target;
  const tag = (t && t.tagName) || "";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" ||
      tag === "BUTTON" || (t && t.isContentEditable)) return;
  // 模态打开时把按键让给模态（Enter/Esc 等由模态自管）
  if (document.querySelector(".ui-modal-mask")) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key >= "1" && e.key <= "6") {
    const name = TAB_SHORTCUTS[Number(e.key) - 1];
    if (name) {
      e.preventDefault();
      window.switchTab(name);
    }
  } else if (e.key === "/") {
    const search = $("friendSearch");
    if (search) {
      e.preventDefault();
      // 搜索框在好友页：先切过去再聚焦（隐藏元素上 focus 没有可见效果）
      if ($("tab-friends").classList.contains("tab-hidden")) window.switchTab("friends");
      search.focus();
      search.select();
    }
  }
});

// 运行
$("btnRun").addEventListener("click", () => startRun(false));
$("btnDryRun").addEventListener("click", () => startRun(true));
$("btnStop").addEventListener("click", stopRun);

/* ---------- v30 新增：仪表盘 ---------- */
function loadDashboard() {
  // 更新今日概览（使用 API 加载的 state.stats）
  try {
    const s = state.stats || {};
    const todaySent = s.today?.sent || 0;
    const todaySuccess = s.today?.success || 0;
    const successRate = todaySent > 0 ? Math.round(todaySuccess / todaySent * 100) + '%' : '—';

    if ($('todaySent')) $('todaySent').textContent = todaySent;
    if ($('todaySuccess')) $('todaySuccess').textContent = successRate;
    if ($('weekSent')) $('weekSent').textContent = s.week?.sent || 0;
    if ($('totalSent')) $('totalSent').textContent = s.total_sent || 0;
  } catch(e) {}

  // 更新最近 7 天趋势
  renderDashboardTrend();

  // 更新火花预警
  updateSparkWarnings();

  // 更新最近活动
  renderRecentActivity();
}

function renderDashboardTrend() {
  const container = $('dashboardTrendBars');
  if (!container) return;
  try {
    const trend = (state.stats && state.stats.trend) || [];
    if (!trend.length) {
      container.innerHTML = '<p class="hint">暂无数据，跑一次任务看看</p>';
      return;
    }
    const days = trend.map(t => ({
      date: t.date,
      sent: t.sent || 0,
      label: (t.date || '').slice(5).replace('-', '/')
    }));
    const max = Math.max(...days.map(d => d.sent), 1);
    container.innerHTML = days.map(d => `
      <div class="trend-bar" style="height:${Math.max(d.sent / max * 100, 4)}%" title="${d.date}: ${d.sent}条">
        <span class="trend-bar-label">${d.label}</span>
      </div>
    `).join('');
  } catch(e) {
    container.innerHTML = '<p class="hint">暂无数据</p>';
  }
}

function updateSparkWarnings() {
  const container = $('sparkWarnList');
  const badge = $('sparkWarnBadge');
  const lastUpdate = $('sparkLastUpdate');
  if (!container) return;

  // 从后端获取火花预警列表
  api('/api/spark/warnings').then(data => {
    if (!data.ok) {
      container.innerHTML = '<p class="hint">获取火花状态失败，请稍后重试</p>';
      return;
    }

    const warnings = data.warnings || [];

    if (warnings.length === 0) {
      container.innerHTML = '<p class="hint">暂无火花预警，所有好友火花状态良好 ✨</p>';
      if (badge) {
        badge.textContent = '0 个需关注';
        badge.classList.remove('warn');
      }
    } else {
      // 检查是否有火花已断掉（0天）
      const brokenSparks = warnings.filter(w => w.spark_days <= 0);
      const urgentSparks = warnings.filter(w => w.spark_days > 0 && w.spark_days <= 3);

      // 火花断连哀悼动画
      if (brokenSparks.length > 0) {
        triggerSparkMourning(brokenSparks);
      }

      container.innerHTML = warnings.map(w => {
        const isBroken = w.spark_days <= 0;
        const isUrgent = w.spark_days > 0 && w.spark_days <= 3;
        const itemClass = isBroken ? 'spark-warn-item broken' : (isUrgent ? 'spark-warn-item urgent' : '');
        const icon = isBroken ? '💔' : '🔥';
        const desc = isBroken
          ? '火花已断掉，快去发送消息挽回吧！'
          : `火花仅剩 ${w.spark_days} 天，建议尽快发送`;
        const daysText = isBroken ? '已断' : `${w.spark_days}天`;
        const daysClass = isBroken ? 'broken' : (isUrgent ? 'urgent' : '');

        return `
          <div class="spark-warn-item ${itemClass}">
            <div class="warn-avatar">${icon}</div>
            <div class="warn-info">
              <div class="warn-name">${esc(w.name)}</div>
              <div class="warn-desc">${desc}</div>
            </div>
            <div class="warn-days ${daysClass}">${daysText}</div>
          </div>
        `;
      }).join('');
      if (badge) {
        badge.textContent = warnings.length + ' 个需关注';
        badge.classList.add('warn');
      }
    }

    // 显示上次更新时间
    if (lastUpdate && data.last_update) {
      const date = new Date(data.last_update);
      lastUpdate.textContent = '上次更新：' + date.toLocaleString('zh-CN');
    }
  }).catch(() => {
    container.innerHTML = '<p class="hint">点击「刷新」按钮开始检测好友火花状态</p>';
  });
}

// 刷新火花状态
let _sparkPollTimer = null;
function refreshSparkStatus() {
  const btn = $('btnRefreshSpark');
  const progress = $('sparkProgress');
  const progressFill = $('sparkProgressFill');
  const progressText = $('sparkProgressText');

  // 防止重复点击产生多个轮询定时器
  if (_sparkPollTimer) { clearInterval(_sparkPollTimer); _sparkPollTimer = null; }
  if (btn) btn.disabled = true;
  if (progress) progress.classList.remove('hide');

  if (window.setEmotionState) window.setEmotionState('running');
  if (window.emoReact) window.emoReact('spark', '正在检测好友火花状态~');

  addActivity('开始刷新火花状态', '🔥');

  // 触发后端刷新
  api('/api/spark/refresh', {method: 'POST'}).then(data => {
    if (!data.ok) {
      // 409 卡死时提示是否强制重置
      if (data.msg && data.msg.includes('正在运行中')) {
        confirmModal({
          title: '监控状态卡死',
          message: '火花监控正在运行中，可能是上次检测未正常结束。\n是否强制重置后重新检测？',
          confirmText: '强制重置',
          danger: true,
        }).then(ok => {
          if (ok) {
            api('/api/spark/reset', {method: 'POST'}).then(() => {
              toast('已重置，正在重新检测...', 'info');
              setTimeout(() => refreshSparkStatus(), 500);
            });
          }
        });
      } else {
        toast(data.msg || '刷新失败', true);
      }
      if (btn) btn.disabled = false;
      if (progress) progress.classList.add('hide');
      return;
    }

    // 轮询进度
    let pollCount = 0;
    const maxPolls = 600; // 最多轮询 10 分钟

    _sparkPollTimer = setInterval(() => {
      pollCount++;
      if (pollCount > maxPolls) {
        clearInterval(_sparkPollTimer);
        _sparkPollTimer = null;
        if (btn) btn.disabled = false;
        if (progress) progress.classList.add('hide');
        // 超时后自动重置后端卡死的 running 标志
        api('/api/spark/reset', {method: 'POST'}).catch(() => {});
        toast('火花监控超时，已自动重置，请稍后重试', true);
        return;
      }

      api('/api/spark/progress').then(pdata => {
        if (!pdata.ok) return;

        // 更新进度
        const pct = pdata.total > 0 ? Math.round((pdata.current / pdata.total) * 100) : 0;
        if (progressFill) progressFill.style.width = pct + '%';
        if (progressText) progressText.textContent = pdata.message || `进度: ${pdata.current}/${pdata.total}`;

        // 完成
        if (!pdata.running && pdata.result) {
          clearInterval(_sparkPollTimer);
          _sparkPollTimer = null;
          if (btn) btn.disabled = false;
          if (progress) progress.classList.add('hide');

          if (window.setEmotionState) window.setEmotionState('done');
          if (window.emoReact) window.emoReact('spark', '火花状态检测完成！');

          addActivity('火花状态刷新完成', '✅');
          updateSparkWarnings();
        }
      }).catch(() => {});
    }, 2000);
  }).catch(err => {
    toast('刷新失败: ' + (err.message || err), true);
    if (btn) btn.disabled = false;
    if (progress) progress.classList.add('hide');
  });
}

function renderRecentActivity() {
  const container = $('recentActivity');
  if (!container) return;

  try {
    const activities = JSON.parse(localStorage.getItem('recent_activity') || '[]');
    if (activities.length === 0) {
      container.innerHTML = '<p class="hint">暂无活动记录</p>';
      return;
    }
    container.innerHTML = activities.slice(0, 10).map(a => `
      <div class="activity-item">
        <div class="activity-icon">${a.icon || '📋'}</div>
        <div class="activity-content">
          <div class="activity-text">${a.text}</div>
          <div class="activity-time">${a.time}</div>
        </div>
      </div>
    `).join('');
  } catch(e) {
    container.innerHTML = '<p class="hint">暂无活动记录</p>';
  }
}

function addActivity(text, icon) {
  try {
    const activities = JSON.parse(localStorage.getItem('recent_activity') || '[]');
    activities.unshift({
      text,
      icon: icon || '📋',
      time: new Date().toLocaleString('zh-CN', {month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'})
    });
    localStorage.setItem('recent_activity', JSON.stringify(activities.slice(0, 50)));
  } catch(e) {}
}

/* ---------- v30 新增：统计 ---------- */
function renderLargeTrend(days) {
  const container = $('trendBarsLarge');
  if (!container) return;
  try {
    const trend = (state.stats && state.stats.trend) || [];
    const data = trend.slice(-days).map(t => ({
      date: t.date,
      sent: t.sent || 0,
      label: (t.date || '').slice(5).replace('-', '/')
    }));
    if (!data.length) {
      container.innerHTML = '<p class="hint">暂无数据</p>';
      return;
    }
    const max = Math.max(...data.map(d => d.sent), 1);
    container.innerHTML = data.map(d => `
      <div class="trend-bar-large" style="height:${Math.max(d.sent / max * 100, 2)}%">
        <div class="bar-tooltip">${d.date}: ${d.sent}条</div>
      </div>
    `).join('');
  } catch(e) {
    container.innerHTML = '<p class="hint">暂无数据</p>';
  }
}

function renderRanking() {
  const container = $('rankingList');
  if (!container) return;
  try {
    const ranking = (state.stats && state.stats.friend_ranking) || [];
    if (!ranking.length) {
      container.innerHTML = '<p class="hint">暂无数据</p>';
      return;
    }
    container.innerHTML = ranking.slice(0, 10).map((r, i) => {
      const uid = r.id || r.unique_id || '';
      const name = r.name || (uid ? nicknameOf(uid) : '') || uid;
      return `<div class="ranking-item"><div class="rank-num">${i + 1}</div><div class="rank-name" title="${esc(uid)}">${esc(name)}</div><div class="rank-count">${r.sent || 0}次</div></div>`;
    }).join('');
  } catch(e) {
    container.innerHTML = '<p class="hint">暂无数据</p>';
  }
}

/* 秒数 → 友好耗时文案（<60s 显示秒，否则分秒） */
function formatDuration(sec) {
  const n = Number(sec);
  if (!isFinite(n) || n <= 0) return "—";
  if (n < 60) return (n >= 10 ? Math.round(n) : n.toFixed(1)) + " 秒";
  const m = Math.floor(n / 60);
  const s = Math.round(n % 60);
  return s ? `${m} 分 ${s} 秒` : `${m} 分`;
}

function renderHourDistribution(hours) {
  const container = $('hourDistribution');
  if (!container) return;
  const buckets = Array.isArray(hours) && hours.length === 24
    ? hours.map(h => Number(h.sent) || 0)
    : new Array(24).fill(0);
  const total = buckets.reduce((a, b) => a + b, 0);
  if (!total) {
    container.innerHTML = '<p class="hint hd-empty">运行一次发送任务后，这里会显示你习惯在哪些时段续火花</p>';
    return;
  }
  const max = Math.max(...buckets, 1);
  // 时段分段：凌晨 0-5 / 上午 6-11 / 下午 12-17 / 晚上 18-23
  const periodOf = h => h < 6 ? "凌晨" : h < 12 ? "上午" : h < 18 ? "下午" : "晚上";
  container.innerHTML =
    '<div class="hd-chart">' +
    buckets.map((v, h) => {
      const pct = v ? Math.max(4, Math.round(v / max * 100)) : 0;
      const label = String(h).padStart(2, "0") + ":00";
      return `<div class="hd-col${v ? "" : " zero"}" title="${label} ${periodOf(h)} · ${v} 条">` +
        `<span class="hd-bar" style="height:${pct}%"></span>` +
        (h % 3 === 0 ? `<span class="hd-tick">${h}</span>` : `<span class="hd-tick"></span>`) +
        `</div>`;
    }).join("") +
    '</div>' +
    '<div class="hd-legend"><span>0时</span><span>6时</span><span>12时</span><span>18时</span><span>23时</span></div>';
}

/* 模板维度使用统计（后端 template_stats：{key,name,kind,sent}） */
function renderTemplateStats(list) {
  const container = $('templateStats');
  if (!container) return;
  if (!Array.isArray(list) || !list.length) {
    container.innerHTML = '<p class="hint">暂无模板使用数据，发送后自动统计</p>';
    return;
  }
  const max = Math.max(...list.map(t => Number(t.sent) || 0), 1);
  const kindIcon = { ai: "✨", preset: "💬", legacy: "📄" };
  const kindName = { ai: "AI 生成", preset: "文案预设", legacy: "旧版模板" };
  container.innerHTML =
    '<div class="tpl-list">' +
    list.slice(0, 8).map(t => {
      const pct = Math.max(2, Math.round((Number(t.sent) || 0) / max * 100));
      const icon = kindIcon[t.kind] || "💬";
      const kn = kindName[t.kind] || "文案";
      return `<div class="tpl-row">` +
        `<div class="tpl-head"><span class="tpl-name" title="${esc(t.name || "")}">${icon} ${esc(t.name || "未命名模板")}</span>` +
        `<span class="tpl-meta">${kn} · ${Number(t.sent) || 0} 次</span></div>` +
        `<div class="tpl-bar-bg"><div class="tpl-bar-fill" style="width:${pct}%"></div></div>` +
        `</div>`;
    }).join("") +
    '</div>';
}

// 趋势周期切换
document.addEventListener('click', e => {
  const btn = e.target.closest('.trend-period-btn');
  if (btn) {
    document.querySelectorAll('.trend-period-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderLargeTrend(parseInt(btn.dataset.period));
  }
});

/* ---------- v30 新增：系统健康检查 ---------- */
function runHealthCheck() {
  if (window.setEmotionState) window.setEmotionState('running');
  if (window.emoReact) window.emoReact('health', '正在检查系统健康状态~');

  const checks = [
    {name: 'Cookie 有效性', icon: '🍪', check: () => new Promise(resolve => {
      api('/api/state').then(r => {
        const cookieCount = (r.accounts && r.accounts[0] && r.accounts[0].cookies_count) || 0;
        const ok = cookieCount > 0;
        resolve({ok: ok, desc: ok ? 'Cookie 已配置（' + cookieCount + ' 条）' : '未配置 Cookie，请在设置页添加'});
      }).catch(() => resolve({ok: false, desc: '无法获取连接状态'}));
    })},
    {name: '后端连接', icon: '🌐', check: () => new Promise(resolve => {
      api('/api/state').then(() => {
        resolve({ok: true, desc: '后端服务连接正常'});
      }).catch(() => resolve({ok: false, desc: '无法连接后端服务'}));
    })},
    {name: '好友配置', icon: '👥', check: () => new Promise(resolve => {
      try {
        const friendList = (state.accounts && state.accounts[0] && state.accounts[0].targets) || [];
        const ok = friendList.length > 0;
        resolve({ok: ok, desc: ok ? '已配置 ' + friendList.length + ' 个好友' : '尚未添加好友'});
      } catch(e) { resolve({ok: false, desc: '好友配置读取失败'}); }
    })},
    {name: '消息模板', icon: '💬', check: () => new Promise(resolve => {
      try {
        const presets = state.message_presets || [];
        const ok = presets.length > 0;
        resolve({ok: ok, desc: ok ? '已配置 ' + presets.length + ' 条消息预设' : '尚未配置消息预设'});
      } catch(e) { resolve({ok: false, desc: '消息预设读取失败'}); }
    })},
    {name: '定时任务', icon: '⏰', check: () => new Promise(resolve => {
      api('/api/schedule').then(r => {
        const ok = r.loaded === true;
        resolve({ok: ok, desc: ok ? '定时任务已启用' : '定时任务未启用'});
      }).catch(() => resolve({ok: false, desc: '无法获取定时任务状态'}));
    })}
  ];

  // 显示健康检查结果（在控制台输出）
  console.log('=== 系统健康检查 ===');
  checks.forEach(check => {
    check.check().then(result => {
      console.log(`${check.icon} ${check.name}: ${result.ok ? '✅' : '⚠️'} ${result.desc}`);
      addActivity(`健康检查: ${check.name} - ${result.desc}`, result.ok ? '✅' : '⚠️');
    });
  });

  setTimeout(() => {
    if (window.setEmotionState) window.setEmotionState('done');
    if (window.emoReact) window.emoReact('health', '健康检查完成！');
  }, 2000);
}

// 快捷操作按钮事件绑定
document.addEventListener('DOMContentLoaded', () => {
  if ($('btnQuickRefreshNick')) {
    $('btnQuickRefreshNick').addEventListener('click', () => {
      addActivity('刷新所有好友昵称', '🔄');
      if (typeof refreshAllNicknames === 'function') refreshAllNicknames();
    });
  }
  if ($('btnQuickHealth')) {
    $('btnQuickHealth').addEventListener('click', runHealthCheck);
  }
  if ($('btnExportStats')) {
    $('btnExportStats').addEventListener('click', () => {
      const stats = JSON.stringify(state.stats || {});
      const blob = new Blob([stats], {type: 'application/json'});
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = '统计报告_' + new Date().toISOString().slice(0, 10) + '.json';
      a.click();
      URL.revokeObjectURL(url);
      addActivity('导出统计报告', '📄');
    });
  }
  if ($('btnResetStats')) {
    $('btnResetStats').addEventListener('click', async () => {
      const ok = await confirmModal({
        title: '重置统计数据',
        message: '将清空每日发送、好友排行、时段与模板统计（不影响去重记忆与配置）。\n重置前会自动留存一份备份，确认继续？',
        confirmText: '确认重置',
        cancelText: '再想想',
        danger: true,
      });
      if (!ok) return;
      try {
        const r = await api('/api/stats/reset', { method: 'POST' });
        toast(r.msg || '统计数据已重置');
        addActivity('重置统计数据', '🔄');
        await loadStats();
      } catch (e) {
        toast('重置失败：' + (e.message || e), true);
      }
    });
  }
  // 火花预警刷新按钮
  if ($('btnRefreshSpark')) {
    $('btnRefreshSpark').addEventListener('click', async () => {
      const ok = await confirmModal({
        title: '检测火花状态',
        message: '需要逐个进入好友聊天界面检测，可能持续几分钟。\n检测期间请勿操作浏览器窗口。',
        confirmText: '开始检测',
        cancelText: '取消',
      });
      if (ok) refreshSparkStatus();
    });
  }
});

/* ---------- v30 新增：发送记录查看器 ---------- */
let _sendRecordsData = null;

// 日志子标签页切换
document.addEventListener('click', e => {
  const tab = e.target.closest('.log-subtab');
  if (tab) {
    document.querySelectorAll('.log-subtab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const logtab = tab.dataset.logtab;
    ['history', 'records', 'friends'].forEach(name => {
      const el = $('logTab-' + name);
      if (el) el.classList.toggle('hide', name !== logtab);
    });
    if (logtab === 'records') loadSendRecords();
    if (logtab === 'friends') loadFriendStats();
  }
});

// 加载发送记录
function loadSendRecords() {
  const list = $('sendRecordsList');
  const cnt = $('recordCnt');
  if (!list) return;

  list.innerHTML = '<p class="hint">加载中...</p>';

  api('/api/send/records').then(data => {
    if (!data.ok) {
      list.innerHTML = '<p class="hint">加载失败: ' + (data.msg || '未知错误') + '</p>';
      return;
    }

    _sendRecordsData = data;
    if (cnt) cnt.textContent = data.total_records;

    // 填充好友筛选下拉框
    const filter = $('recordFilter');
    if (filter && data.friend_summary) {
      filter.innerHTML = '<option value="all">全部好友</option>';
      data.friend_summary.forEach(f => {
        const opt = document.createElement('option');
        opt.value = f.friend_id;
        opt.textContent = f.friend_name + ' (' + f.sent_count + '条)';
        filter.appendChild(opt);
      });
    }

    renderSendRecords();
  }).catch(err => {
    list.innerHTML = '<p class="hint">加载失败: ' + err.message + '</p>';
  });
}

// 渲染发送记录（支持搜索和筛选）
function renderSendRecords() {
  const list = $('sendRecordsList');
  if (!list || !_sendRecordsData) return;

  const search = ($('recordSearch')?.value || '').toLowerCase();
  const filter = $('recordFilter')?.value || 'all';

  let records = _sendRecordsData.records || [];

  // 按好友筛选
  if (filter !== 'all') {
    records = records.filter(r => r.friend_id === filter);
  }

  // 按搜索词筛选（转义前先按原文过滤）
  if (search) {
    records = records.filter(r =>
      String(r.friend_name || "").toLowerCase().includes(search) ||
      String(r.message || "").toLowerCase().includes(search)
    );
  }

  if (records.length === 0) {
    list.innerHTML = '<p class="hint">没有找到匹配的记录</p>';
    return;
  }

  list.innerHTML = records.map(r => `
    <div class="send-record-item">
      <div class="sr-head">
        <span class="sr-name">👤 ${esc(r.friend_name || "未知好友")}</span>
        <span class="sr-uid">${esc(r.friend_id || "")}</span>
      </div>
      <div class="sr-msg">${esc(r.message || "")}</div>
    </div>
  `).join('');
}

// 加载好友统计
function loadFriendStats() {
  const list = $('friendStatsList');
  if (!list) return;

  list.innerHTML = '<p class="hint">加载中...</p>';

  api('/api/send/records').then(data => {
    if (!data.ok || !data.friend_summary) {
      list.innerHTML = '<p class="hint">加载失败</p>';
      return;
    }

    const friends = data.friend_summary;
    const maxSent = Math.max(...friends.map(f => f.sent_count), 1);

    list.innerHTML = friends.map((f, i) => {
      const pct = Math.max(0, Math.min(100, (f.sent_count / maxSent) * 100)).toFixed(1);
      return `
      <div class="friend-stat-item">
        <div class="fs-head">
          <span class="fs-name">${i + 1}. 👤 ${esc(f.friend_name || f.friend_id || "未知好友")}</span>
          <span class="fs-count">${Number(f.sent_count) || 0}条</span>
        </div>
        <div class="fs-bar-bg">
          <div class="fs-bar-fill" style="width:${pct}%"></div>
        </div>
        <div class="fs-meta">消息模板: ${Number(f.message_count) || 0}条 · 抖音号: ${esc(f.friend_id || "")}</div>
      </div>
    `;}).join('');
  }).catch(err => {
    list.innerHTML = '<p class="hint">加载失败: ' + err.message + '</p>';
  });
}

// 发送记录搜索和筛选事件
document.addEventListener('input', e => {
  if (e.target.id === 'recordSearch') renderSendRecords();
});
document.addEventListener('change', e => {
  if (e.target.id === 'recordFilter') renderSendRecords();
});
document.addEventListener('click', e => {
  if (e.target.id === 'btnRefreshRecords') loadSendRecords();
});

/* ---------- v30 新增：Cookie 有效性检测 ---------- */
let cookieCheckTimer = null;

// 检测 Cookie 有效性
async function checkCookies(showToast = false) {
  const btn = $('btnCheckCookies');
  const resultEl = $('cookieCheckResult');

  if (btn) {
    btn.disabled = true;
    btn.textContent = '🔍 检测中...';
  }

  try {
    const data = await api('/api/cookies/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });

    if (resultEl) {
      resultEl.classList.remove('hide');
      const confidence = data.confidence || 'low';
      const confText = { high: '高置信度', medium: '中置信度', low: '基础检查' }[confidence] || '基础检查';

      if (data.valid) {
        const isLowConf = confidence === 'low';
        resultEl.style.background = isLowConf ? 'rgba(249, 168, 37, 0.1)' : 'rgba(46, 125, 50, 0.1)';
        resultEl.style.border = isLowConf ? '1px solid rgba(249, 168, 37, 0.3)' : '1px solid rgba(46, 125, 50, 0.3)';
        resultEl.style.color = isLowConf ? 'var(--yellow, #f9a825)' : 'var(--green, #2e7d32)';
        resultEl.innerHTML = `
          ${isLowConf ? '⚠️' : '✅'} <b>Cookie 基础检查通过</b>
          <br><span style="font-size:12px;opacity:0.8;">账号：${data.account || '未知'} | ${confText} | ${data.reason}</span>
          ${isLowConf ? '<br><span style="font-size:11px;opacity:0.7;">建议点击「测试运行」实际验证发送功能</span>' : ''}
        `;
      } else {
        resultEl.style.background = 'rgba(255, 45, 85, 0.1)';
        resultEl.style.border = '1px solid rgba(255, 45, 85, 0.3)';
        resultEl.style.color = 'var(--err, #ff2d55)';
        resultEl.innerHTML = `
          ❌ <b>Cookie 已过期</b>
          <br><span style="font-size:12px;opacity:0.8;">账号：${data.account || '未知'} | ${confText} | ${data.reason}</span>
          <br><span style="font-size:11px;opacity:0.7;">请重新从抖音获取 Cookie 并粘贴保存</span>
        `;
      }
    }

    if (showToast) {
      toast(data.valid ? 'Cookie 检查完成 ✓' : 'Cookie 可能已过期 ⚠️', !data.valid);
    }

    // 只有高/中置信度的过期才显示全局警告，低置信度不警告（避免误报）
    if (!data.valid && (data.confidence === 'high' || data.confidence === 'medium')) {
      showCookieWarning(data.reason, data.account);
    } else {
      hideCookieWarning();
    }

    return data.valid;
  } catch (e) {
    if (resultEl) {
      resultEl.classList.remove('hide');
      resultEl.style.background = 'rgba(249, 168, 37, 0.1)';
      resultEl.style.border = '1px solid rgba(249, 168, 37, 0.3)';
      resultEl.style.color = 'var(--yellow, #f9a825)';
      resultEl.innerHTML = `⚠️ <b>检测失败</b><br><span style="font-size:12px;opacity:0.8;">${e.message}</span>`;
    }
    if (showToast) toast('检测失败: ' + e.message, true);
    return null;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '🔍 检测 Cookie';
    }
  }
}

// 显示全局 Cookie 警告条
function showCookieWarning(reason, account) {
  let warning = $('cookieWarningBar');
  if (!warning) {
    warning = document.createElement('div');
    warning.id = 'cookieWarningBar';
    warning.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:linear-gradient(90deg,#ff2d55,#ff6b6b);color:#fff;padding:10px 20px;font-size:13px;display:flex;align-items:center;justify-content:space-between;box-shadow:0 2px 10px rgba(0,0,0,0.2);';
    document.body.appendChild(warning);
  }
  warning.textContent = "";
  const msg = document.createElement("span");
  msg.textContent = `⚠️ Cookie 可能已过期（${account || "未知账号"}）：${reason}。发送任务可能会失败，请重新获取 Cookie。`;
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "cookie-warn-close";
  closeBtn.textContent = "知道了";
  closeBtn.addEventListener("click", () => warning.remove());
  warning.append(msg, closeBtn);
  warning.style.display = "flex";
}

// 隐藏全局 Cookie 警告
function hideCookieWarning() {
  const warning = $('cookieWarningBar');
  if (warning) warning.remove();
}

// 绑定检测按钮
if ($('btnCheckCookies')) {
  $('btnCheckCookies').addEventListener('click', () => checkCookies(true));
}

// 页面加载后自动检测 Cookie（延迟 3 秒，避免影响首屏加载）
setTimeout(() => {
  checkCookies(false).catch(() => {});
  // 每 30 分钟自动检测一次
  cookieCheckTimer = setInterval(() => {
    checkCookies(false).catch(() => {});
  }, 30 * 60 * 1000);
}, 3000);

/* ---------- v30 新增：外观设置（字体大小/动画速度/界面密度/侧边栏） ---------- */
const APPEARANCE_DEFAULTS = {
  fontSize: 'medium',
  animSpeed: 'normal',
  uiDensity: 'normal',
  sidebarMode: 'full',
};

function applyAppearance(config) {
  const html = document.documentElement;
  const body = document.body;

  // 字体大小
  const fontSizes = { small: '13px', medium: '14px', large: '16px' };
  html.style.fontSize = fontSizes[config.fontSize] || '14px';

  // 动画速度
  const animSpeeds = { fast: '0.15s', normal: '0.3s', slow: '0.6s', off: '0s' };
  html.style.setProperty('--anim-speed', animSpeeds[config.animSpeed] || '0.3s');
  if (config.animSpeed === 'off') {
    body.classList.add('anim-off');
  } else {
    body.classList.remove('anim-off');
  }

  // 界面密度
  const densities = { compact: '0.85', normal: '1', comfortable: '1.15' };
  html.style.setProperty('--density-scale', densities[config.uiDensity] || '1');

  // 侧边栏模式
  const sidebar = document.querySelector('.sidebar') || document.querySelector('aside');
  if (sidebar) {
    sidebar.classList.remove('sidebar-mini', 'sidebar-hidden');
    if (config.sidebarMode === 'mini') {
      sidebar.classList.add('sidebar-mini');
    } else if (config.sidebarMode === 'hidden') {
      sidebar.classList.add('sidebar-hidden');
    }
  }
}

function loadAppearance() {
  try {
    const saved = JSON.parse(localStorage.getItem('dsf-appearance') || '{}');
    const config = { ...APPEARANCE_DEFAULTS, ...saved };

    // 设置下拉框的值
    if ($('fFontSize')) $('fFontSize').value = config.fontSize;
    if ($('fAnimSpeed')) $('fAnimSpeed').value = config.animSpeed;
    if ($('fDensity')) $('fDensity').value = config.uiDensity;
    if ($('fSidebar')) $('fSidebar').value = config.sidebarMode;

    applyAppearance(config);
    return config;
  } catch (e) {
    return { ...APPEARANCE_DEFAULTS };
  }
}

function saveAppearance() {
  const config = {
    fontSize: $('fFontSize') ? $('fFontSize').value : 'medium',
    animSpeed: $('fAnimSpeed') ? $('fAnimSpeed').value : 'normal',
    uiDensity: $('fDensity') ? $('fDensity').value : 'normal',
    sidebarMode: $('fSidebar') ? $('fSidebar').value : 'full',
  };
  localStorage.setItem('dsf-appearance', JSON.stringify(config));
  applyAppearance(config);
  toast('外观设置已保存 ✓', false);
  if (window.elasticPop) try { window.elasticPop(1.05); } catch(e) {}
}

function resetAppearance() {
  localStorage.removeItem('dsf-appearance');
  loadAppearance();
  toast('已恢复默认外观', false);
}

// 绑定事件
if ($('btnSaveAppearance')) $('btnSaveAppearance').addEventListener('click', saveAppearance);
if ($('btnResetAppearance')) $('btnResetAppearance').addEventListener('click', resetAppearance);

// 下拉框即时预览
['fFontSize', 'fAnimSpeed', 'fDensity', 'fSidebar'].forEach(id => {
  const el = $(id);
  if (el) {
    el.addEventListener('change', () => {
      const config = {
        fontSize: $('fFontSize') ? $('fFontSize').value : 'medium',
        animSpeed: $('fAnimSpeed') ? $('fAnimSpeed').value : 'normal',
        uiDensity: $('fDensity') ? $('fDensity').value : 'normal',
        sidebarMode: $('fSidebar') ? $('fSidebar').value : 'full',
      };
      applyAppearance(config);
    });
  }
});

// 页面加载时应用外观设置
loadAppearance();

/* ---------- v30 新增：火花断连哀悼动画 ---------- */
let _mourningTriggered = false;

function triggerSparkMourning(brokenSparks) {
  // 避免重复触发
  if (_mourningTriggered) return;
  _mourningTriggered = true;
  setTimeout(() => { _mourningTriggered = false; }, 60000); // 1分钟内不重复触发

  const names = brokenSparks.map(s => s.name).join('、');

  // 1. 小球哭脸动画
  if (window.setEmotionState) {
    try { window.setEmotionState('error'); } catch(e) {}
  }
  if (window.emoReact) {
    try { window.emoReact('error', '有火花断掉了...呜呜呜'); } catch(e) {}
  }

  // 2. 安慰提示弹窗
  showMourningModal(names, brokenSparks.length);

  // 3. 控制台输出安慰信息
  console.log('%c💔 火花断连哀悼', 'color:#ff2d55;font-size:14px;font-weight:bold;');
  console.log(`%c有 ${brokenSparks.length} 个好友的火花断掉了：${names}`, 'color:#666;');
  console.log('%c别难过，快去发送消息挽回吧！每一段友谊都值得珍惜 ✨', 'color:#2e7d32;');
}

async function showMourningModal(names, count) {
  // 复用统一玻璃模态（文本走 textContent，天然免疫昵称注入；不再手写 z-index 内联弹窗）
  const go = await confirmModal({
    title: "哎呀，有火花断掉了 😢",
    message: `「${names}」的火花已经断掉了…\n别难过！每一段友谊都值得珍惜。\n现在去发送一条消息，就能重新点燃火花 ✨`,
    confirmText: "💬 去发送消息",
    cancelText: "知道了",
  });
  if (go) {
    window.switchTab('friends');
    toast('快去发送消息，重新点燃火花吧！🔥', false);
  }
}

/* ---------- 使用说明书（v26） ---------- */
function openHelp() {
  $("helpMask").classList.remove("hide");
  if (window.emoReact) window.emoReact("logs", "看说明书~");
}
function closeHelp() {
  $("helpMask").classList.add("hide");
}
$("btnHelp").addEventListener("click", openHelp);
$("btnHelpClose").addEventListener("click", closeHelp);
$("btnHelpOk").addEventListener("click", closeHelp);
$("helpMask").addEventListener("click", e => { if (e.target === $("helpMask")) closeHelp(); });
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("helpMask").classList.contains("hide")) closeHelp(); });

/* ---------- 操作状态条（v26，联动 emoReact） ---------- */
const ACTIVITY_HIST_MAX = 8;
let _actHist = [];
function actNow(level, txt) {
  const strip = $("activityStrip"), text = $("activityText");
  if (!strip) return;
  strip.classList.remove("busy", "done", "error");
  if (level) strip.classList.add(level);
  if (text) text.textContent = txt || "就绪";
}
function actPush(level, txt) {
  _actHist.unshift({ level: level || "done", txt: txt, time: new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) });
  if (_actHist.length > ACTIVITY_HIST_MAX) _actHist.pop();
  renderActHist();
}
function renderActHist() {
  const box = $("activityHistory");
  if (!box) return;
  box.innerHTML = _actHist.map(a =>
    `<div class="act-item ${a.level}"><span class="act-dot"></span>` +
    `<span class="act-txt">${esc(a.txt)}</span><span class="act-time">${esc(a.time)}</span></div>`).join("");
}
$("activityNow").addEventListener("click", () => {
  const h = $("activityHistory");
  h.classList.toggle("hide");
});
$("activityToggle").addEventListener("click", e => {
  e.stopPropagation();
  const h = $("activityHistory");
  h.classList.toggle("hide");
});
document.addEventListener("click", e => {
  const strip = $("activityStrip");
  if (strip && !strip.contains(e.target)) $("activityHistory").classList.add("hide");
});
/* 安装活动条联动（需在 Emotion Ball 引擎加载后调用，见启动区） */
function installActivityHooks() {
  const origEmo = window.emoReact;
  if (typeof origEmo === "function") {
    window.emoReact = function(action, msg, restore) {
      origEmo(action, msg, restore);
      try {
        const map = {
          nick_start:["busy", msg || "正在获取昵称…"], nick_progress:["busy", msg || "获取昵称中…"],
          nick_done:["done", "昵称获取完成"], nick_fail:["error", "昵称获取失败"],
          remark_open:["busy", "编辑备注…"], remark_saved:["done", "备注已保存"],
          friend_added:["done", "添加了好友"], friend_del:["done", "删除好友"], friend_delall:["done", "批量删除好友"],
          preset_add:["done", "添加预设"], preset_del:["done", "删除预设"], template_saved:["done", "模板已保存"],
          msg_preview:["done", "预览消息"], ai_start:["busy", msg || "AI 思考中…"],
          ai_done:["done", "AI 文案生成成功"], ai_fail:["error", "AI 生成失败"],
          settings_saved:["done", "设置已保存"], cookies_saved:["done", "Cookies 已保存"],
          config_export:["done", "配置已导出"], config_import:["done", "配置已导入"], config_fail:["error", "操作失败"],
          sched_toggle:["done", "定时开关切换"], sched_add:["done", "添加时间点"], sched_save:["done", "时间表已保存"],
          logs:["done", "查看日志"], theme:["done", "切换主题"], working:["busy", msg || "处理中…"],
        };
        const m = map[action];
        if (m) { actNow(m[0], m[1]); actPush(m[0], m[1]); }
      } catch (x) {}
    };
  }
  const origSet = window.setEmotionState;
  let _lastRunState = null;
  if (typeof origSet === "function") {
    window.setEmotionState = function(ns) {
      origSet(ns);
      try {
        const map = { running:["busy","正在发送火花…"], dryrun:["busy","测试运行中…"], sending:["busy","发送中…"], idle:["done","空闲"], done:["done","任务完成"], error:["error","任务出错"], stopped:["done","已停止"] };
        const m = map[ns];
        if (m) {
          // 运行状态去重：idle 只在"之前非 idle"时更新，避免 pollRun 每 2 秒覆盖操作反馈
          if (ns === "idle") {
            if (_lastRunState && _lastRunState !== "idle") { actNow(m[0], m[1]); }
          } else {
            actNow(m[0], m[1]);
            if (ns === "running" || ns === "dryrun" || ns === "sending") actPush(m[0], m[1]);
          }

          // 任务刚结束（完成/出错/停止）：静默刷新仪表盘与统计数据，
          // 不再强制重启后端（旧实现会 os.execv 并 reload 页面，体验突兀）。
          const finishedStates = ["done", "error", "stopped"];
          const runningStates = ["running", "dryrun", "sending"];
          if (finishedStates.includes(ns) && runningStates.includes(_lastRunState)) {
            setTimeout(() => {
              try { loadDashboard(); } catch (x) {}
              try { loadStats(); } catch (x) {}
              try { renderKpi(); renderSchedule(); } catch (x) {}
            }, 1200);
          }

          _lastRunState = ns;
        }
      } catch (x) {}
    };
  }
}

// 定时
$("btnSchedToggle").addEventListener("click", schedToggle);
$("btnSchedAddTime").addEventListener("click", schedAddTime);
$("btnSchedSaveTime").addEventListener("click", schedSaveTimes);
$("schedTimes").addEventListener("click", e => {
  const del = e.target.closest("button.del");
  if (del) return schedDelTime(parseInt(del.dataset.i, 10));
});

// 好友
$("btnAddFriend").addEventListener("click", addFriend);
$("newFriend").addEventListener("keydown", e => { if (e.key === "Enter") addFriend(); });
$("btnRefreshNick").addEventListener("click", refreshAllNicknames);
// [优化] 搜索防抖：连续输入只触发一次渲染（keyed 渲染本身已很便宜，防抖兜底极端输入速度）
let searchDeb = 0;
$("friendSearch").addEventListener("input", e => {
  const v = e.target.value.trim();
  clearTimeout(searchDeb);
  searchDeb = setTimeout(() => {
    if (searchKw.v === v) return;
    searchKw.v = v;
    renderFriends();
  }, 120);
});
$("friendList").addEventListener("click", e => {
  const del = e.target.closest("button.del");
  if (del) return delFriend(parseInt(del.dataset.i, 10));
  const nickBtn = e.target.closest("button.nick-btn");
  if (nickBtn) {
    const uid = nickBtn.dataset.id;
    if (uid) {
      nickBtn.disabled = true;
      nickBtn.textContent = "⏳";
      resolveNickname(uid, true).finally(() => {
        nickBtn.disabled = false;
        nickBtn.textContent = "🔄";
      });
    }
    return;
  }
  const remarkBtn = e.target.closest("button.remark-btn");
  if (remarkBtn) {
    const uid = remarkBtn.dataset.id;
    if (uid) editRemark(uid);
    return;
  }
  const groupBtn = e.target.closest("button.group-btn");
  if (groupBtn) {
    const uid = groupBtn.dataset.id;
    if (uid) editGroup(uid);
    return;
  }
  const bdayBtn = e.target.closest("button.bday-btn");
  if (bdayBtn) {
    const uid = bdayBtn.dataset.id;
    if (uid) editBirthday(uid);
    return;
  }
  const fidMain = e.target.closest(".fid-main");
  if (fidMain) {
    const row = fidMain.closest(".friend-item");
    if (row) {
      // 直接取勾选框上的全量数组索引（搜索过滤/分组下序号文本可能不连续，DOM 位置不可靠）
      const cb = row.querySelector('input[type="checkbox"]');
      const idx = cb ? parseInt(cb.dataset.i, 10) : NaN;
      const uid = friends()[idx];
      if (uid) {
        navigator.clipboard.writeText(uid).then(() => {
          toast(`已复制抖音号：${uid}`);
        }).catch(() => {
          // 降级方案
          const ta = document.createElement("textarea");
          ta.value = uid; document.body.appendChild(ta); ta.select();
          try { document.execCommand("copy"); toast(`已复制抖音号：${uid}`); }
          catch(e) { toast("复制失败", true); }
          document.body.removeChild(ta);
        });
      }
    }
    return;
  }
  const cb = e.target.closest("input[type=checkbox]");
  if (cb) {
    const i = parseInt(cb.dataset.i, 10);
    cb.checked ? selected.add(i) : selected.delete(i);
    updateBatchBar();
  }
});
$("btnBatchDel").addEventListener("click", batchDel);
$("btnBatchCancel").addEventListener("click", () => { selected.clear(); renderFriends(); });
$("btnSelectAll").addEventListener("click", () => {
  const fs = friends();
  if (selected.size === fs.length) selected.clear();
  else fs.forEach((_, i) => selected.add(i));
  renderFriends();
});

// 预设
$("btnAddPreset").addEventListener("click", addPreset);
$("newPreset").addEventListener("keydown", e => { if (e.key === "Enter") addPreset(); });
$("presetList").addEventListener("click", e => {
  const edit = e.target.closest("button.edit");
  if (edit) return editPreset(parseInt(edit.dataset.i, 10));
  const del = e.target.closest("button.del");
  if (del) return delPreset(parseInt(del.dataset.i, 10));
  const radio = e.target.closest("input[type=radio]");
  if (radio) {
    const i = parseInt(radio.dataset.i, 10);
    saveConfig({ selected_preset_index: i }).catch(err => toast(err.message, true));
  }
});
$("modeSeg").addEventListener("click", e => {
  const b = e.target.closest("button[data-mode]");
  if (!b || b.dataset.mode === state.send_mode) return;
  saveConfig({ send_mode: b.dataset.mode })
    .then(() => toast(b.dataset.mode === "random" ? "已切换为随机发送" : "已切换为固定发送"))
    .catch(err => toast(err.message, true));
});

// 一言
$("hitokotoChips").addEventListener("click", e => {
  const c = e.target.closest(".chip");
  if (c) toggleHitokoto(c.dataset.t);
});

// 模板 & 设置 & Cookies
$("btnSaveTemplate").addEventListener("click", saveTemplate);
$("btnSaveSettings").addEventListener("click", saveSettings);
$("btnSaveCookies").addEventListener("click", saveCookies);
$("btnLogout").addEventListener("click", logoutAccount);
$("btnClearAccount").addEventListener("click", clearAccount);

// 消息预览
async function previewMessage() {
  const pv = $("msgPreview");
  if (window.emoReact) window.emoReact("msg_preview");
  try {
    // 取当前生效的内容：有预设用预设（固定模式用选中，随机模式用第一条），否则用兜底模板
    const ps = state.message_presets || [];
    let content = "";
    if (ps.length) {
      if (state.send_mode === "fixed") {
        const idx = state.selected_preset_index || 0;
        content = ps[Math.min(idx, ps.length - 1)] || "";
      } else {
        content = ps[0] || "";
      }
    } else {
      content = $("msgTemplate").value || "";
    }
    if (!content.trim()) {
      toast("当前没有可预览的消息内容", true);
      return;
    }
    // 用第一个好友作为变量示例
    const fs = friends();
    const uid = fs.length ? fs[0] : "";
    const r = await api("/api/msg/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: content, unique_id: uid }),
    });
    if (r.ok) {
      const name = uid ? (remarkOf(uid) || nicknameOf(uid) || uid) : "示例好友";
      const curUser = account().username || "我";
      pv.innerHTML =
        `<span class="pv-label">以「${esc(name)}」为例的最终消息：</span>` +
        esc(r.preview.replace(/\\n/g, "\n")) +
        `<div class="pv-send">实际发送时会自动拼接问候语和结尾，如：<b>[续火花吧]晚上好！</b>${esc(String(r.preview || "").split("\n")[0])}<b>…【来自${esc(curUser)}的自动续火花脚本】</b></div>`;
      pv.classList.remove("hide");
      toast("预览已更新");
    } else {
      toast(r.msg || "预览失败", true);
    }
  } catch (e) {
    toast("预览失败：" + e.message, true);
  }
}
$("btnPreviewMsg").addEventListener("click", previewMessage);

// 日志
$("btnRefreshLogs").addEventListener("click", loadLogs);

// 系统管理
$("btnRestartFrontend").addEventListener("click", async function() {
  const ok = await confirmModal({
    title: "刷新前端",
    message: "确定要刷新前端页面吗？",
    confirmText: "刷新",
    cancelText: "取消",
  });
  if (ok) location.reload();
});
$("btnRestartBackend").addEventListener("click", async function() {
  const ok = await confirmModal({
    title: "重启后端",
    message: "这会中断当前所有操作（包括正在运行的任务）。\n后端重启后页面会自动刷新。",
    confirmText: "确认重启",
    cancelText: "取消",
    danger: true,
  });
  if (!ok) return;
  var btn = $("btnRestartBackend");
  btn.disabled = true; btn.textContent = "重启中…";
  api("/api/restart", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({target: "backend"})
  }).then(function(j) {
    toast(j.msg || "正在重启…");
    /* 后端重启后轮询检测恢复，然后自动刷新 */
    var checks = 0;
    var poll = setInterval(function() {
      checks++;
      fetch("/api/state").then(function() {
        clearInterval(poll);
        toast("后端已恢复，正在刷新…");
        setTimeout(function(){ location.reload(); }, 500);
      }).catch(function() {
        if(checks > 30) { clearInterval(poll); toast("重启超时，请手动检查", true); btn.disabled=false; btn.textContent="重启后端"; }
      });
    }, 1000);
  }).catch(function(e) {
    /* 请求本身就失败了（后端已重启），开始轮询 */
    var checks = 0;
    var poll = setInterval(function() {
      checks++;
      fetch("/api/state").then(function() {
        clearInterval(poll);
        toast("后端已恢复，正在刷新…");
        setTimeout(function(){ location.reload(); }, 500);
      }).catch(function() {
        if(checks > 30) { clearInterval(poll); toast("重启超时，请手动检查", true); btn.disabled=false; btn.textContent="重启后端"; }
      });
    }, 1000);
  });
});
$("btnClearLogs").addEventListener("click", async function() {
  const ok = await confirmModal({
    title: "清空历史日志",
    message: "这会删除 logs/ 目录下的所有 .log 文件，不可恢复。",
    confirmText: "确认清空",
    cancelText: "取消",
    danger: true,
  });
  if (!ok) return;
  try {
    const j = await api("/api/logs/clear", { method: "POST", headers: {"Content-Type":"application/json"}, body: "{}" });
    toast(j.msg || "日志已清空");
    if (window.emoReact) window.emoReact("logs", "日志已清空");
  } catch (e) { toast(e.message, true); }
});

/* ---------- 配置导入导出 ---------- */
async function exportConfig() {
  try {
    const data = await api("/api/config/export");
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const ts = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `douyin-spark-config-${ts}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast("配置已导出");
    if (window.emoReact) window.emoReact("config_export");
  } catch (e) {
    toast("导出失败：" + e.message, true);
    if (window.emoReact) window.emoReact("config_fail");
  }
}
function importConfig() {
  $("importConfigFile").click();
}
$("importConfigFile").addEventListener("change", async function(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const mode = await choiceModal({
      title: "选择导入模式",
      message: "请选择配置导入方式：",
      choices: [
        { value: "merge", label: "合并模式", desc: "保留现有配置，追加新内容" },
        { value: "replace", label: "替换模式", desc: "完全覆盖现有配置", danger: true },
      ],
    });
    if (!mode) { e.target.value = ""; return; }
    const btn = $("btnImportConfig");
    btn.disabled = true; btn.textContent = "导入中…";
    const r = await api("/api/config/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: data, mode: mode }),
    });
    if (r.ok) {
      toast(`导入成功（${mode === "merge" ? "合并" : "替换"}）：${r.imported.join("、")}`);
      if (window.emoReact) window.emoReact("config_import");
      await loadState();
      renderFriends();
      renderPresets();
      setTimeout(() => location.reload(), 800);
    } else {
      toast(r.msg || "导入失败", true);
      if (window.emoReact) window.emoReact("config_fail");
    }
    btn.disabled = false; btn.textContent = "📥 导入配置";
  } catch (err) {
    toast("导入失败：" + err.message, true);
    $("btnImportConfig").disabled = false;
    $("btnImportConfig").textContent = "📥 导入配置";
  }
  e.target.value = ""; // 重置，允许重复选择同一文件
});
$("btnExportConfig").addEventListener("click", exportConfig);
$("btnImportConfig").addEventListener("click", importConfig);

/* ---------- 主题切换（多主题色点选择器） ---------- */
(function() {
  var html = document.documentElement;
  var THEME_NAMES = { gray: "雾灰", sky: "奶油天空蓝", white: "纯白", red: "抖音红", green: "森绿", yellow: "奶油黄", dark: "深夜" };

  function applyTheme(theme, animate) {
    if (animate) {
      html.classList.add("theme-transition");
      setTimeout(function() { html.classList.remove("theme-transition"); }, 400);
    }
    // v32：默认（无 data-theme）即雾灰；所有主题（含 red）均显式设置
    if (!theme || theme === "gray") {
      html.removeAttribute("data-theme");
    } else {
      html.setAttribute("data-theme", theme);
    }
    // 同时更新所有主题选择器的状态
    document.querySelectorAll(".theme-picker").forEach(function(picker) {
      var dots = picker.querySelectorAll(".theme-dot");
      var label = picker.querySelector(".theme-label");
      dots.forEach(function(d) { d.classList.toggle("active", d.dataset.t === (theme || "gray")); });
      if (label) label.textContent = THEME_NAMES[theme] || THEME_NAMES.gray;
    });
  }

  var saved = localStorage.getItem("dsf-theme") || "gray";
  applyTheme(saved, false);

  // 绑定所有主题选择器的点击事件（包括侧边栏和设置页面）
  document.querySelectorAll(".theme-picker").forEach(function(picker) {
    picker.addEventListener("click", function(e) {
      var dot = e.target.closest(".theme-dot");
      if (!dot) return;
      var t = dot.dataset.t;
      applyTheme(t, true);
      localStorage.setItem("dsf-theme", t);
      // Emotion Ball 反馈
      if (window.elasticPop) try { window.elasticPop(1.08); } catch(e) {}
      if (window.briefEmotion) try { window.briefEmotion('13', 1500, '新衣服！'); } catch(e) {}
    });
  });
})();

/* ---------- Emotion Ball 拟生化反馈系统 v5（情绪调度重写） ---------- */
(function() {
  var botEl = $('emotionBot');
  var tipEl = $('emotionTip');
  var emoBall = null;
  var tipTimer = null;
  var touchCount = 0, lastTouchTime = 0;

  var STATE_MAP = { idle:'02', running:'32', dryrun:'36', done:'33', error:'34', sending:'31', stopped:'41' };
  var TIP_MAP   = { idle:'空闲中~', running:'发送火花中…', dryrun:'测试运行中~', done:'任务完成！', error:'出错了…', sending:'接到任务！', stopped:'已停止' };

  /* ===== 生命态基础函数 ===== */
  function startBreath(mood) {
    if(!botEl) return;
    botEl.classList.remove('idle-breath');
    void botEl.offsetWidth;
    var speeds = {calm:[3.6,1.03],happy:[2.4,1.06],sad:[5.5,1.02],alert:[1.8,1.05],sleepy:[6.0,1.015]};
    var s = speeds[mood] || speeds.calm;
    botEl.style.setProperty('--breath-dur', s[0]+'s');
    botEl.style.setProperty('--breath-top', s[1]);
    botEl.style.setProperty('--breath-delay', (Math.random()*1.5).toFixed(1)+'s');
    botEl.style.setProperty('--look-delay', (3+Math.random()*5).toFixed(1)+'s');
    botEl.classList.add('idle-breath');
  }
  function stopBreath()   { botEl && botEl.classList.remove('idle-breath'); }
  function elasticPop(s, doBounce) {
    if(!botEl)return; stopBreath();
    botEl.classList.remove('pressed','bounce-anim');
    botEl.classList.add('pop');
    botEl.style.transform='scale('+s+')';
    setTimeout(function(){
      botEl.style.transform=''; botEl.classList.remove('pop');
      if(doBounce){botEl.classList.add('bounce-anim');setTimeout(function(){botEl.classList.remove('bounce-anim');startBreath('happy');},520);}
      else startBreath();
    },360);
  }
  function squash(s,d)    { if(!botEl)return; botEl.style.transform='scale('+s+')'; setTimeout(function(){botEl.style.transform='';},d||220); }
  function pressIn()      { botEl && botEl.classList.add('pressed'); }
  function pressOut()     { botEl && botEl.classList.remove('pressed'); startBreath(); }

  /* ===== 引擎初始化（保留引擎原生 idle：60s 待机 → 180s 睡眠） ===== */
  if (window.EmotionBall && botEl) {
    try {
      emoBall = EmotionBall.create(botEl, { emotion:'02', idle:true });
      emoBall.on('change', function(p) {
        /* 引擎回调载荷是 { id, def, auto }，不是 id 字符串（v32.1 修正） */
        var id = p && p.id;
        for (var k in STATE_MAP) if (STATE_MAP[k]===id) { showTip(TIP_MAP[k]||''); break; }
      });
    } catch(e) { console.warn('[EmotionBall]', e); }
  }

  /* 左界：桌面端不能钻进侧栏底下（mini/隐藏模式按侧栏实时宽度算）；移动端侧栏在文档流顶部，左界=4 */
  function ballLeftBound() {
    if (window.innerWidth <= 720) return 4;
    if (document.body.classList.contains('sidebar-hidden')) return 4;
    var sb = document.querySelector('.sidebar');
    return sb && sb.offsetWidth ? sb.offsetWidth + 4 : 232;
  }
  /* 上界：移动端侧栏/顶栏是文档流顶部的横条，球不能压在导航条上；桌面端留 4px 即可 */
  function ballTopBound() {
    if (window.innerWidth > 720) return 4;
    var sb = document.querySelector('.sidebar');
    if (sb) {
      var pos = getComputedStyle(sb).position;
      if (pos === 'static' || pos === 'relative') return sb.offsetHeight + 8;
    }
    return 4;
  }
  /* 位置持久化（localStorage 即时恢复 + 后端异步同步） */
  function placeBall(x, y) {
    if (!botEl) return { x: x, y: y };
    var w = botEl.offsetWidth || 88, h = botEl.offsetHeight || 88;
    // v32.1：窗口缩小/跨设备分辨率不一致时，把球夹回可视区（且避开侧栏/移动导航），避免只露半个
    x = Math.max(ballLeftBound(), Math.min(x, window.innerWidth - w - 4));
    y = Math.max(ballTopBound(), Math.min(y, window.innerHeight - h - 4));
    botEl.style.left = x + 'px'; botEl.style.top = y + 'px';
    botEl.style.right = 'auto'; botEl.style.bottom = 'auto';
    return { x: x, y: y };
  }
  if (botEl) {
    try {
      var sp = JSON.parse(localStorage.getItem('emoPos'));
      if (sp && typeof sp.x==='number' && typeof sp.y==='number') {
        placeBall(sp.x, sp.y);
      }
    } catch(e) {}
    startBreath();
  }
  /* loadState 完成后从后端同步位置（跨设备） */
  function syncBallPos() {
    if(!botEl) return;
    var bp = (typeof state!=='undefined' && state.ball_position) || {};
    if(typeof bp.x==='number' && typeof bp.y==='number') {
      var c = placeBall(bp.x, bp.y);
      try{localStorage.setItem('emoPos',JSON.stringify(c));}catch(e){}
    }
  }
  /* 等 loadState 完成后执行一次同步 */
  if(typeof loadState!=='undefined'){
    var origLS=loadState;
    loadState=async function(){await origLS();syncBallPos();};
  }
  /* v32：窗口尺寸变化后防止球溢出屏幕（防抖 200ms） */
  var _ballResizeT = null;
  window.addEventListener('resize', function() {
    if (!botEl) return;
    clearTimeout(_ballResizeT);
    _ballResizeT = setTimeout(function() {
      var rc = botEl.getBoundingClientRect();
      var c = placeBall(rc.left, rc.top);
      try{localStorage.setItem('emoPos', JSON.stringify(c));}catch(e){}
    }, 200);
  });

  /* ===== 光效与提示 ===== */
  function getBrandGlow(a) {
    var cs=getComputedStyle(document.documentElement), b=cs.getPropertyValue('--brand').trim()||'#ff2d55';
    return 'rgba('+parseInt(b.slice(1,3),16)+','+parseInt(b.slice(3,5),16)+','+parseInt(b.slice(5,7),16)+','+(a||0.3)+')';
  }
  function setGlow(a,sz) { if(!botEl)return; botEl.style.filter='drop-shadow(0 0 '+(sz||12)+'px '+getBrandGlow(a||0.3)+')'; setTimeout(function(){botEl.style.filter='';},1500); }
  function pulseGlow() {
    if(!botEl)return;
    botEl.style.transition='filter 0.15s ease-out';
    botEl.style.filter='drop-shadow(0 0 20px '+getBrandGlow(0.5)+')';
    setTimeout(function(){ botEl.style.filter='drop-shadow(0 0 8px '+getBrandGlow(0.2)+')'; setTimeout(function(){botEl.style.filter='';botEl.style.transition='';},300); },150);
  }
  function showTip(txt) { if(!tipEl)return; tipEl.textContent=txt; tipEl.classList.add('show'); clearTimeout(tipTimer); tipTimer=setTimeout(function(){tipEl.classList.remove('show');},2800); }
  function clamp(v,a,b){return v<a?a:v>b?b:v;}

  /*
   * ===== 情绪调度核心（v5 重写）=====
   *
   * 设计理念：引擎原生 idle（60s→standby '02', 180s→sleep '00'）管理长期状态，
   * 我们只在有明确用户交互时临时介入，绝不干扰引擎 idle 循环。
   *
   * 三种介入模式：
   *   briefEmotion(id, dur, tip) — 短暂反应（触碰/按钮/Tab），到期后引擎 idle 自然接管
   *   stateChange(id, tip)       — 运行状态变化（running/done/error），持久生效直到下次状态变化
   *   directSet(id, tip)         — 直接设置（接近/甩动），引擎 idle 在无交互后自然恢复
   */
  var stateMoodId = null;   /* 当前运行状态情绪（优先级最高，不被 brief 覆盖） */
  var briefTimer = null;    /* 短暂反馈回落定时器（brief/flash 共用，单一真源防竞态） */

  /* 表情 → 容器 CSS 呼吸节奏（引擎内部动画之外的环境呼吸） */
  var MOOD_CSS = {
    '10':'happy','13':'happy','19':'happy','50':'happy','51':'happy','54':'happy',
    '12':'sad','15':'sad','18':'sad','55':'sad',
    '00':'sleepy','52':'sleepy',
    '01':'alert','03':'alert','11':'alert','16':'alert','17':'alert',
    '20':'alert','21':'alert','40':'alert','56':'alert','57':'alert'
  };

  /* brief/flash 结束后的统一回落：有运行态锁回运行态，否则回待机 02 */
  function backToAnchor() {
    briefTimer = null;
    if (!emoBall) return;
    var anchor = stateMoodId || '02';
    try { emoBall.setEmotion(anchor); } catch(e) {}
    startBreath(stateMoodId ? 'alert' : 'calm');
  }

  function briefEmotion(id, dur, tip) {
    if(!emoBall || stateMoodId) return;
    clearTimeout(briefTimer);
    try { emoBall.setEmotion(id); } catch(e) {}
    pulseGlow();
    if(tip) showTip(tip);
    startBreath(MOOD_CSS[id] || 'calm');
    if(dur) briefTimer = setTimeout(backToAnchor, dur);
  }

  /* 运行态中的关键节点闪回（发送成功 / 跳过 / 重试 / 失败）：
     无视状态锁临时变脸，结束后回到当前运行态，不让观察者丢失"还在跑"的语义 */
  function flashEmotion(id, dur, tip) {
    if(!emoBall) return;
    clearTimeout(briefTimer);
    try { emoBall.setEmotion(id); } catch(e) {}
    if(tip) showTip(tip);
    startBreath(MOOD_CSS[id] || 'calm');
    briefTimer = setTimeout(backToAnchor, dur || 1300);
  }

  function stateChange(id, tip) {
    if(!emoBall) return;
    clearTimeout(briefTimer); briefTimer = null;
    stateMoodId = id;
    try { emoBall.setEmotion(id); } catch(e) {}
    pulseGlow();
    if(tip) showTip(tip);
  }

  function directSet(id, tip) {
    if(!emoBall || stateMoodId) return;
    clearTimeout(briefTimer);
    try { emoBall.setEmotion(id); } catch(e) {}
    if(tip) showTip(tip);
    if(!dragMoved) startBreath(MOOD_CSS[id] || 'calm');
  }

  /* 运行状态接口 */
  var doneResetTimer = null;
  /* 成就庆祝（纯娱乐视觉反馈，不涉及系统操作） */
  window.__emoCelebrate = function() {
    if(!emoBall || !botEl) return;
    try {
      /* 54 雀跃自带两圈自旋甩彩带，再补一把撒花即可，不叠加容器级 pop/bounce */
      if(stateMoodId) { stateMoodId = null; clearTimeout(doneResetTimer); }
      emoBall.setEmotion('54');
      if(emoBall.burst) emoBall.burst(22);
      showTip('🎉 太棒啦！');
      setGlow(0.7, 26);
      clearTimeout(briefTimer);
      briefTimer = setTimeout(backToAnchor, 2600);
    } catch(x) {}
  };
  var lastSetState = null;  /* 记录最后一次设置的状态，用于去重 */
  window.setEmotionState = function(ns) {
    var id = STATE_MAP[ns];
    if(!id || !emoBall) return;
    /* 状态去重：相同的 done/error 状态不重复设置，避免反复清除自动恢复定时器 */
    if(ns === lastSetState && (ns === 'done' || ns === 'error')) return;
    lastSetState = ns;
    clearTimeout(doneResetTimer);
    /* 进度环状态 */
    var isRunning = (ns==='running' || ns==='dryrun' || ns==='sending');
    botEl.classList.toggle('running', isRunning);
    if(!isRunning) updateProgress(0);
    if(ns==='idle') {
      stateMoodId = null;   /* 释放，引擎 idle 接管 */
      clearTimeout(briefTimer); briefTimer = null;
      try { emoBall.setEmotion('02'); } catch(e) {}
      startBreath();
      return;
    }
    stateChange(id, TIP_MAP[ns]||'');
    if(ns==='running') setGlow(0.4,18);
    else if(ns==='dryrun') setGlow(0.3,14);
    else if(ns==='done'||ns==='error') {
      setGlow(0.5,22);
      /* 33 完成自带「笑眼起跳 + 自旋甩彩带 + 撒花」sequence，不再叠加容器级弹跳，避免效果打架 */
      /* 完成/出错 8 秒后自动恢复 idle，不让球卡死 */
      doneResetTimer = setTimeout(function(){
        stateMoodId = null;
        clearTimeout(briefTimer); briefTimer = null;
        lastSetState = null;  /* 重置去重状态，允许下次任务完成时重新触发 */
        try { emoBall.setEmotion('02'); } catch(e) {}
        startBreath('calm');
        showTip('空闲中~');
      }, 8000);
    }
  };

  /* 进度环更新 */
  var progressFg = botEl ? botEl.querySelector('.emo-progress-fg') : null;
  var CIRCUMFERENCE = 2 * Math.PI * 46; // ≈289.03
  function updateProgress(percent) {
    if(!progressFg) return;
    var p = Math.max(0, Math.min(1, percent));
    progressFg.style.strokeDashoffset = (CIRCUMFERENCE * (1 - p)).toFixed(2);
  }

  /* ===== 9. 全局操作反馈（拟人伙伴感知一切操作） =====
   * window.emoReact(action, msg)
   *  - dur===0  → 持续性状态（忙碌/专注），用 stateChange + glow，由 emoIdle 恢复
   *  - dur>0    → 一次性表情反馈（briefEmotion）
   * window.emoIdle(msg) → 恢复空闲，球回到默认状态
   */
  var EMO_REACT = {
    /* 好友 */
    nick_start:   {id:'16', dur:0, tip:'正在获取昵称…'},
    nick_progress:{id:'16', dur:0, tip:''},              // 动态 msg
    nick_done:    {id:'19', dur:2200, tip:'昵称都更新好啦~'},
    nick_fail:    {id:'20', dur:2600, tip:'昵称获取遇到点问题…'},
    remark_open:  {id:'35', dur:1500, tip:'记个备注？'},
    remark_saved: {id:'19', dur:1800, tip:'备注记下了~'},
    friend_added: {id:'50', dur:2500, tip:'新朋友！欢迎~'},
    friend_del:   {id:'55', dur:2500, tip:'送走一位…'},
    friend_delall:{id:'55', dur:2800, tip:'一下子少了好多…'},
    search_on:    {id:'40', dur:0, tip:''},              // 搜索中
    /* 消息 */
    preset_add:   {id:'13', dur:1500, tip:'新预设就位'},
    preset_del:   {id:'18', dur:2000, tip:'删掉一条预设'},
    template_saved:{id:'19', dur:1800, tip:'模板存好了'},
    msg_preview:  {id:'35', dur:1800, tip:'帮你看看效果~'},
    ai_start:     {id:'20', dur:0, tip:'让我想想怎么夸你…'},
    ai_done:      {id:'13', dur:2200, tip:'AI 文案写好啦~'},
    ai_fail:      {id:'20', dur:2600, tip:'AI 没配好，暂时用不了'},
    /* 设置 */
    settings_saved:{id:'19', dur:1600, tip:'设置已保存'},
    cookies_saved:{id:'10', dur:1800, tip:'饼干收好了~'},
    config_export:{id:'13', dur:1500, tip:'打包带走~'},
    config_import:{id:'19', dur:2000, tip:'配置导入了'},
    config_fail:  {id:'20', dur:2200, tip:'这个操作出了点问题…'},
    sched_toggle: {id:'16', dur:1500, tip:'定时开关拨动'},
    sched_add:    {id:'13', dur:1500, tip:'加时间点'},
    sched_save:   {id:'19', dur:1600, tip:'时间表保存了'},
    logs:         {id:'40', dur:1500, tip:'翻翻日志…'},
    theme:        {id:'13', dur:1200, tip:'换个心情~'},
    /* 通用 */
    working:      {id:'16', dur:0, tip:'处理中…'},
  };
  window.emoReact = function(action, msg, restore) {
    var cfg = EMO_REACT[action];
    if(!cfg || !emoBall) return;
    if(cfg.dur===0) {
      stateChange(cfg.id, msg || cfg.tip);
      setGlow(0.3, 14);
    } else {
      /* 运行锁定中走 flash（结束自动回到运行态），不冲掉状态锁；空闲时走 brief 回待机 */
      if(stateMoodId) flashEmotion(cfg.id, cfg.dur, msg || cfg.tip);
      else briefEmotion(cfg.id, cfg.dur, msg || cfg.tip);
      /* restore=true 且当前不在运行态时，反馈播完后回到空闲 */
      if(restore && !stateMoodId) setTimeout(function(){ if(window.emoIdle) window.emoIdle(); }, cfg.dur + 300);
    }
  };
  window.emoIdle = function(msg) {
    clearTimeout(doneResetTimer);
    stateMoodId = null;
    try { emoBall.setEmotion('02'); } catch(e) {}
    startBreath('calm');
    showTip(msg || '空闲中~');
  };

  /* ===== 1. 自由拖拽 + 单击自旋甩彩带 + 连点彩蛋 + 长按表情巡演 ===== */
  var dragMoved=false, longPressed=false, pressTimer=null;
  var dragStartX=0, dragStartY=0, dragBaseLeft=0, dragBaseTop=0;
  var clickArmed=null;   /* 单击延迟消歧定时器（避免单击/连点效果叠加） */

  /* 全表情巡演清单（含 32 套内置 + 自定义彩蛋） */
  var TOUR_IDS = (window.EmotionBall && EmotionBall.config && EmotionBall.config.list)
    ? EmotionBall.config.list().map(function(d){ return d.id; }) : [];
  var GREETINGS = ['你好呀~','嗨！','哟~','在呢在呢','点我干嘛呀~','嘿嘿，我超有精神！'];

  function stopTour() {
    if (emoBall && emoBall.touring) {
      try { emoBall.stopTour(); } catch(e) {}
      if(botEl) botEl.classList.remove('touring');
      clearTimeout(briefTimer);
      briefTimer = setTimeout(backToAnchor, 350);
      showTip('巡演结束~');
    }
  }

  function doSingleClick() {
    if (emoBall && emoBall.touring) { stopTour(); return; }
    if (stateMoodId) return;            /* 运行状态中单击不抢戏 */
    /* 招牌动作：原地自旋甩出彩带（引擎 yaw 弹簧，不改变当前表情语义） */
    try { emoBall.spin(1); emoBall.resetIdle(); } catch(e) {}
    squash(0.9, 150);
    showTip(GREETINGS[Math.floor(Math.random()*GREETINGS.length)]);
  }

  function doMultiClick(n) {
    if (emoBall && emoBall.touring) { stopTour(); return; }
    if (n===2) {
      briefEmotion('13', 1800, '哎呀~');
      try{emoBall.burst(10);}catch(e){}
    } else if (n===3) {
      briefEmotion('14', 2200, '别摸了~');
    } else if (n===4) {
      briefEmotion('56', 2200, '嘻嘻，抓不到我~');
    } else if (n===5) {
      briefEmotion('21', 2400, '够了啊！');
      try{emoBall.burst(16);}catch(e){}
    } else {
      /* 6 连：终极彩蛋 —— 雀跃转体甩彩带 + 满屏撒花 */
      if(stateMoodId){stateMoodId=null;clearTimeout(doneResetTimer);}
      try{emoBall.setEmotion('54');emoBall.burst(26);emoBall.resetIdle();}catch(e){}
      showTip('哈哈哈好开心！');
      clearTimeout(briefTimer);
      briefTimer = setTimeout(backToAnchor, 2800);
      touchCount = 0;
    }
  }

  botEl.addEventListener('pointerdown', function(e) {
    e.preventDefault();
    var now=Date.now();
    if(now-lastTouchTime<600) touchCount++; else touchCount=1;
    lastTouchTime=now;
    dragMoved=false; longPressed=false;
    dragStartX=e.clientX; dragStartY=e.clientY;
    var rect=botEl.getBoundingClientRect();
    dragBaseLeft=rect.left; dragBaseTop=rect.top;
    pressIn();
    try{botEl.setPointerCapture(e.pointerId);}catch(x){}
    try{if(emoBall)emoBall.resetIdle();}catch(x){}
    clearTimeout(pressTimer);
    pressTimer=setTimeout(function(){
      if(!dragMoved&&!longPressed){
        longPressed=true;
        /* 长按：全表情巡演，再点一下停止 */
        if(emoBall && emoBall.touring) { stopTour(); return; }
        if(!emoBall || !TOUR_IDS.length || stateMoodId) return;
        try {
          emoBall.startTour(TOUR_IDS, 1400);
          botEl.classList.add('touring');
          showTip('表情巡演中，点我停止~');
        } catch(x) {}
      }
    },600);
    function onMove(ev) {
      var dx=ev.clientX-dragStartX, dy=ev.clientY-dragStartY;
      if(!dragMoved&&Math.sqrt(dx*dx+dy*dy)>6) {
        dragMoved=true; clearTimeout(pressTimer); stopBreath();
        botEl.classList.add('dragging');
        var rc=botEl.getBoundingClientRect();
        botEl.style.left=rc.left+'px'; botEl.style.top=rc.top+'px';
        botEl.style.right='auto'; botEl.style.bottom='auto';
        directSet('16');
      }
      if(dragMoved) {
        botEl.style.left=clamp(dragBaseLeft+dx,ballLeftBound(),window.innerWidth-botEl.offsetWidth-4)+'px';
        /* v32.1：上界同样钳制，移动端拖动不能压到顶部导航条 */
        botEl.style.top=clamp(dragBaseTop+dy,ballTopBound(),window.innerHeight-botEl.offsetHeight-4)+'px';
      }
    }
    function onUp() {
      botEl.removeEventListener('pointermove',onMove);
      botEl.removeEventListener('pointerup',onUp);
      botEl.removeEventListener('pointercancel',onUp);
      clearTimeout(pressTimer); pressOut();
      if(dragMoved) {
        botEl.classList.remove('dragging'); touchCount=0;
        try{localStorage.setItem('emoPos',JSON.stringify({x:parseInt(botEl.style.left),y:parseInt(botEl.style.top)}));}catch(x){}
        /* 同步到后端（跨设备持久化） */
        try{api('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ball_position:{x:parseInt(botEl.style.left),y:parseInt(botEl.style.top)}})}).catch(function(){});}catch(x){}
        briefEmotion('19',1500,'放好了~');
        return;
      }
      if(longPressed) return;
      if(touchCount===1){
        /* 延迟 240ms 确认是单击，给第二次点留消歧窗口 */
        clearTimeout(clickArmed);
        clickArmed=setTimeout(function(){ clickArmed=null; doSingleClick(); },240);
      } else {
        clearTimeout(clickArmed); clickArmed=null;
        doMultiClick(touchCount);
      }
    }
    botEl.addEventListener('pointermove',onMove);
    botEl.addEventListener('pointerup',onUp);
    botEl.addEventListener('pointercancel',onUp);
  });

  /* ===== 2. 眼神跟随鼠标（只动眼神，不靠乱切表情刷存在感） ===== */
  /* 眼神跟随鼠标：全视口覆盖。远距离用 sqrt 缓曲线性比例，近处灵敏远处收敛，自然又不突兀。
   * 待机 '02' 眼睛半闭，看不到 gaze；鼠标移动时切 '03' 好奇（睁眼）让 gaze 可见，
   * 鼠标停 2.5s 后回落 '02' —— 不是乱切表情，是「你在动 → 我看着你」的因果。 */
  var gazeActive=false, watchTimer=null, watching=false;
  var mouseTrack={x:0,y:0,t:0}, swayCd=0;
  function startWatching() {
    if (stateMoodId || (emoBall && emoBall.touring)) return;
    if (!watching) {
      watching = true;
      try { emoBall.setEmotion('03'); } catch(x) {}
    }
    clearTimeout(watchTimer);
    watchTimer = setTimeout(function() {
      watching = false;
      if (!stateMoodId && !(emoBall && emoBall.touring)) {
        try { emoBall.setEmotion('02'); } catch(x) {}
      }
    }, 2500);
  }
  document.addEventListener('mousemove',function(e){
    if(!emoBall||!botEl) return;
    var rect=botEl.getBoundingClientRect(), cx=rect.left+rect.width/2, cy=rect.top+rect.height/2;
    var dx=e.clientX-cx, dy=e.clientY-cy;
    /* 用视口对角线做归一化基准，保证鼠标在任何角落眼睛都看过去 */
    var diag=Math.sqrt(window.innerWidth*window.innerWidth+window.innerHeight*window.innerHeight);
    var nx=clamp(dx/diag*2.2,-1,1), ny=clamp(dy/diag*2.2,-1,1);
    /* sqrt 曲线：近处快速响应、远处平缓收敛 */
    nx=Math.sign(nx)*Math.sqrt(Math.abs(nx));
    ny=Math.sign(ny)*Math.sqrt(Math.abs(ny));
    try{emoBall.setGaze(nx,ny);}catch(x){}
    gazeActive=true;
    /* 鼠标在动 → 切睁眼表情让 gaze 可见 */
    startWatching();
    /* 鼠标甩动检测：只有空闲时才会被吓到，运行 / 巡演中保持专注不打断 */
    var now=Date.now();
    if(!stateMoodId && !(emoBall&&emoBall.touring)){
      if(mouseTrack.t&&now-mouseTrack.t<80){
        var spd=Math.abs(e.clientX-mouseTrack.x)/Math.max(now-mouseTrack.t,1);
        if(spd>25&&now-swayCd>8000&&!dragMoved){swayCd=now;squash(0.88,150);briefEmotion('17',1800,'慢点慢点！');}
      }
    }
    mouseTrack.x=e.clientX;mouseTrack.y=e.clientY;mouseTrack.t=now;
  },{passive:true});
  document.addEventListener('mouseleave',function(){if(gazeActive&&emoBall){try{emoBall.clearGaze();}catch(x){}gazeActive=false;}});

  /* 任何键盘 / 指针活动都重置引擎闲置计时：你在用电脑，它就不睡（参考 aora-bot 交互规范） */
  document.addEventListener('keydown',function(){try{if(emoBall)emoBall.resetIdle();}catch(x){}},{passive:true});
  document.addEventListener('pointerdown',function(){try{if(emoBall)emoBall.resetIdle();}catch(x){}},{passive:true});

  /* ===== 3. 按钮差异化（含弹性反馈） ===== */
  var BTN_MAP={
    btnRun:{id:'31',dur:0,tip:'接收任务！开始发送~',pop:1.12},btnDryRun:{id:'36',dur:2500,tip:'测试模式~',pop:1.08},
    btnStop:{id:'41',dur:2500,tip:'停下来了…',sq:0.88},btnAddFriend:{id:'50',dur:2500,tip:'新朋友！欢迎~',pop:1.12},
    btnAddPreset:{id:'19',dur:2000,tip:'新预设就位',pop:1.06},btnSaveTemplate:{id:'53',dur:1800,tip:'模板存好了',pop:1.06},
    btnBatchDel:{id:'55',dur:2500,tip:'要删掉这么多…',sq:0.9},btnBatchCancel:{id:'02',dur:1200,tip:'那算了'},
    btnSelectAll:{id:'13',dur:1800,tip:'全选了！',pop:1.1},btnSaveSettings:{id:'53',dur:1600,tip:'设置已保存',pop:1.06},
    btnSaveCookies:{id:'50',dur:1800,tip:'饼干收好了~',pop:1.06},btnSchedToggle:{id:'16',dur:1800,tip:'定时开关拨动'},
    btnSchedAddTime:{id:'13',dur:1500,tip:'加时间点',pop:1.08},btnSchedSaveTime:{id:'53',dur:1600,tip:'时间表保存了',pop:1.06},
    btnRefreshLogs:{id:'57',dur:1500,tip:'翻翻日志…'},
    btnRefreshNick:{id:'16',dur:2000,tip:'刷新昵称中…',pop:1.06},
    btnRestartFrontend:{id:'07',dur:1500,tip:'刷新页面~',pop:1.06},
    btnRestartBackend:{id:'55',dur:2500,tip:'重启后端…',sq:0.88},
    /* v32.1 补齐：以下按钮此前点击无反馈 */
    btnHelp:{id:'40',dur:2000,tip:'看看说明书~',pop:1.06},
    activityToggle:{id:'40',dur:1500,tip:'翻翻历史~'},
    btnQuickRefreshNick:{id:'16',dur:2000,tip:'刷新昵称中…',pop:1.06},
    btnQuickHealth:{id:'11',dur:1800,tip:'体检中~',pop:1.06},
    btnRefreshSpark:{id:'16',dur:2000,tip:'查火花状态~',pop:1.06},
    btnPreviewMsg:{id:'35',dur:2000,tip:'看看效果~',pop:1.06},
    btnExportStats:{id:'53',dur:1800,tip:'报告导出~',pop:1.06},
    btnResetStats:{id:'18',dur:2200,tip:'数据清零了…',sq:0.9},
    btnCheckCookies:{id:'57',dur:2000,tip:'检测中~',pop:1.06},
    btnLogout:{id:'02',dur:2000,tip:'拜拜~',sq:0.9},
    btnClearAccount:{id:'18',dur:2500,tip:'清除了…',sq:0.88},
    btnClearLogs:{id:'18',dur:2000,tip:'日志清空了',sq:0.9},
    btnExportConfig:{id:'53',dur:1800,tip:'配置导出~',pop:1.06},
    btnImportConfig:{id:'50',dur:2000,tip:'导入中~',pop:1.06},
    btnSaveAppearance:{id:'53',dur:1600,tip:'外观保存了',pop:1.06},
    btnResetAppearance:{id:'02',dur:1800,tip:'恢复默认~',sq:0.9},
    btnRefreshRecords:{id:'57',dur:1500,tip:'刷新记录~'},
    btnHelpOk:{id:'02',dur:800,tip:'明白！'}
  };
  document.addEventListener('click',function(e){
    var btn=e.target.closest('button');if(!btn||!btn.id)return;
    var cfg=BTN_MAP[btn.id];
    if(cfg){
      if(cfg.pop) elasticPop(cfg.pop); else if(cfg.sq) squash(cfg.sq);
      if(cfg.dur===0) stateChange(cfg.id,cfg.tip); else briefEmotion(cfg.id,cfg.dur,cfg.tip);
    }else{
      /* 通用兜底：未登记按钮点击也给一个轻反馈，不漏掉任何交互 */
      squash(0.92,150);
    }
  });

  /* ===== 4. Tab 切换（id 必须是引擎已注册表情；'25' 不存在曾导致回退警告，v32.1 修正） ===== */
  var TAB_MOODS={friends:{id:'03',tip:'看看好友'},msg:{id:'39',tip:'消息设置'},stats:{id:'19',tip:'看看战绩'},settings:{id:'11',tip:'调一调设置'},logs:{id:'57',tip:'翻日志咯'},dashboard:{id:'02',tip:'回主页'}};
  // v32 修复：ES 模块下 switchTab 不挂 window，直接引用模块内函数
  var origSwitchTab = (typeof window.switchTab === "function")
    ? window.switchTab
    : (typeof switchTab === "function" ? switchTab : null);
  if (origSwitchTab) {
    window.switchTab = function(name) {
      origSwitchTab(name);
      var c = TAB_MOODS[name] || { id: '03', tip: '' };
      try { briefEmotion(c.id, 1500, c.tip); } catch (e) {}
    };
  }

  /* ===== 5. 输入框反馈（聚焦=等待输入且保持稳定，打字过程不乱切表情；失焦回落） ===== */
  function relaxToIdle() { if(!stateMoodId){ clearTimeout(briefTimer); try{emoBall.setEmotion('02');}catch(e){} startBreath('calm'); } }
  ['newFriend','newPreset','msgTemplate','ckTextarea'].forEach(function(id){
    var el=$(id);if(!el)return;
    el.addEventListener('focus',function(){directSet('35','等你输入…');});
    el.addEventListener('blur',relaxToIdle);
  });
  var sf=$('friendSearch');
  if(sf){
    sf.addEventListener('focus',function(){directSet('57','找谁？');});
    sf.addEventListener('blur',relaxToIdle);
  }
  ['fLogLevel','fMatchMode','fRetry','fTimeout','fWaitTime'].forEach(function(id){var el=$(id);if(el)el.addEventListener('change',function(){briefEmotion('11',1500,'换了个选项');});});

  /* ===== 6. 网络状态联动 ===== */
  var origSC=window.setConn, connInited=false, lastConnState=null;
  if(typeof origSC==='function'){
    window.setConn=function(online){
      origSC(online);
      /* 只在连接状态真正变化时反馈，避免 pollRun 每 2 秒触发"连上了！"覆盖其他操作反馈 */
      if(!connInited){connInited=true;lastConnState=online;return;}
      if(online===lastConnState)return;
      lastConnState=online;
      if(!online)stateChange('34','连接断了！');
      else{stateMoodId=null;briefEmotion('01',2000,'连上了！');}
    };
  }

  /* ===== 7. 失焦睡眠 / 聚焦唤醒（对齐上游：页面隐藏睡 00；巡演中先停巡演） ===== */
  document.addEventListener('visibilitychange',function(){
    if(!emoBall||stateMoodId)return;
    if(document.hidden){
      if(emoBall.touring)stopTour();
      stopBreath();directSet('00','zzz…');
    }else{
      startBreath('happy');
      /* 01 是 sequence 表情（唤醒~2100ms 后自动 settle 到 02），时长给足不打断 */
      clearTimeout(briefTimer);
      try{emoBall.setEmotion('01');}catch(e){}
    }
  });

  /* ===== 8. 活动叙述器（日志联动 · 语义化）=====
   * 设计：运行中（32 真发 / 36 测试）主表情稳定不变，只在「跳过 / 失败 / 重试 / 发送成功」
   * 四类关键节点做短暂表情闪回（flashEmotion，结束自动回到运行态）；
   * 匹配 / 选中这类高频过程节点只更新提示文字，绝不每条日志都变脸 ——
   * 让「系统在干什么」一眼可辨，而不是看起来在随机乱跳。 */
  var activityCd=0, staleTimer=null;
  var ACTION_VERBS=['发送','匹配','查找','检查','保存','加载','连接','获取','刷新','停止','启动','处理','等待','创建','更新','添加','删除','搜索','导入','导出'];
  var lastLogFlash=0;
  var LOG_FLASH_CD=900;   /* 同批日志（间隔常 <300ms）内不重复变脸 */

  function nickOf(t) { var m=String(t).match(/[「『]([^」』]+)[」』]/); return m ? m[1] : ''; }
  function logFlash(id, dur, tip) {
    var n=Date.now();
    if(n-lastLogFlash<LOG_FLASH_CD) { if(tip) showTip(tip); return; }
    lastLogFlash=n;
    flashEmotion(id, dur, tip);
  }

  function narrateActivity(txt) {
    if(!txt) return;
    if(stateMoodId!=='32' && stateMoodId!=='36') return;
    var now=Date.now(), nick=nickOf(txt);

    /* 1) 关键节点：语义表情闪回 */
    if(txt.indexOf('跳过')!==-1) {
      logFlash('18', 1300, nick ? ('测试跳过：'+nick) : '这一条跳过~');
      return;
    }
    if(/失败|异常|错误|出错/.test(txt)) {
      logFlash('21', 1600, '这一条出问题了…');
      return;
    }
    if(txt.indexOf('重试')!==-1) {
      logFlash('17', 1200, '别慌，再试一次！');
      return;
    }
    if(/发送成功|已发送|续火花|火花成功|消息已发|发送完成/.test(txt)) {
      logFlash('10', 1400, nick ? ('火花已续：'+nick) : '发送成功~');
      return;
    }

    /* 2) 高频过程节点：2.8s 冷却内只保留一条提示，不切表情 */
    if(now-activityCd<2800) return;
    activityCd=now;
    if(txt.indexOf('匹配成功')!==-1) {
      showTip(nick ? ('找到了「'+nick+'」') : '匹配成功~');
    } else if(txt.indexOf('选中')!==-1) {
      showTip(nick ? ('准备发给 '+nick) : '选中好友~');
    } else {
      for(var j=0;j<ACTION_VERBS.length;j++){
        if(txt.indexOf(ACTION_VERBS[j])!==-1){
          var short=txt.length>18?txt.substring(0,18)+'…':txt;
          showTip(short);
          clearTimeout(staleTimer);
          staleTimer=setTimeout(function(){showTip('还在忙…');},6000);
          return;
        }
      }
    }
  }

  /* 运行状态情绪联动已由 renderRun() 内的 window.setEmotionState 统一处理；
     控制台新行叙述由下方 MutationObserver 负责（旧的 window.pollRun 包装
     在 ES 模块化后恒为 undefined、永不生效，且会打一个 404 的 /api/run，已移除）。 */

  /* 控制台 DOM 叙述（真发 32 / 测试 36 都联动；光晕 600ms 冷却，批量日志不狂闪） */
  var consoleEl=$('console'), lastConsoleGlow=0;
  if(consoleEl){
    new MutationObserver(function(muts){
      if(stateMoodId!=='32' && stateMoodId!=='36') return;
      for(var i=0;i<muts.length;i++){
        var n=muts[i]; if(n.addedNodes.length===0) continue;
        var last=n.addedNodes[n.addedNodes.length-1];
        var txt=last.textContent||'';
        if(txt.length>3){
          narrateActivity(txt);
          var g=Date.now();
          if(g-lastConsoleGlow>600){lastConsoleGlow=g;pulseGlow();}
        }
      }
    }).observe(consoleEl,{childList:true});
  }

  /* idle 时的「活着」的感觉全部交给引擎原生能力，不再外部随机切表情：
     02 待机自带左右张望 glance、每只眼睛错相微漂移，以及 9~18s 随机自旋甩彩带 /
     弹跳 / 眨眼（antics）。外部定时器每 15~35s 乱切好奇/发呆/专注，正是
     「表情看起来很随机」的根因，已移除。 */

  /* ===== 9. 主题反馈（滚动 / resize 不再刷表情：那些不是情绪，只会制造随机感） ===== */
  var picker=$('themePicker');
  if(picker) picker.addEventListener('click',function(e){if(e.target.closest('.theme-dot')){elasticPop(1.08);briefEmotion('13',1500,'新衣服！');}});

  /* ===== 10. Toast 联动（运行态中走 flash，反馈完自动回到运行态） ===== */
  var origToast=window.toast;
  if(typeof origToast==='function'){window.toast=function(msg,isErr){
    origToast(msg,isErr);
    if(!emoBall)return;
    var react = stateMoodId ? flashEmotion : briefEmotion;
    if(isErr){squash(0.85,200);react('21',2000);}
    else if(msg&&msg.indexOf('完成')!==-1){elasticPop(1.1);react('10',2000);}
  };}

  /* ===== 11. 对外导出（外观保存、主题切换等模块级代码在调用） ===== */
  window.elasticPop = elasticPop;
  window.briefEmotion = briefEmotion;
})();


/* ---------- 启动 ---------- */
loadState().then(() => {
  setConn(true);
  /* Emotion Ball 引擎此时已加载，安装活动条联动 */
  try { installActivityHooks(); } catch (x) {}
  tabSeen.add("dashboard");   // 首屏 tab 的入场动画
  window.switchTab("dashboard");
  loadDashboard();
  pollRun();
  setInterval(pollRun, 2000);

  /* v31 仪表盘新功能：时间更新 + 问候语 */
  try { initDashboardHero(); } catch (x) {}

  /* 有 Cookie 且昵称尚未识别（仍是抖音号占位）时，静默从 Cookie 识别账号 */
  try {
    const a = account();
    if (a.cookies_count && (!a.username ||
        a.username.toLowerCase() === (a.unique_id || "").toLowerCase())) {
      setTimeout(() => identifyAccount(false).catch(() => {}), 1500);
    }
  } catch (x) {}
}).catch(() => setConn(false));

/* ---------- v31 仪表盘顶部欢迎区域 ---------- */
function initDashboardHero() {
  updateHeroTime();
  setInterval(updateHeroTime, 1000);
  updateHeroGreeting();
}

function updateHeroTime() {
  const now = new Date();
  const timeEl = document.getElementById('heroTime');
  const dateEl = document.getElementById('heroDate');
  const schedTimeEl = document.getElementById('schedHeroTime');
  const schedDateEl = document.getElementById('schedHeroDate');
  if (timeEl) {
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');
    timeEl.textContent = `${h}:${m}`;
  }
  if (schedTimeEl) {
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    schedTimeEl.textContent = `${h}:${m}`;
  }
  if (dateEl) {
    const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    dateEl.textContent = `${now.getFullYear()}年${now.getMonth()+1}月${now.getDate()}日 ${weekdays[now.getDay()]}`;
  }
  if (schedDateEl) {
    const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    schedDateEl.textContent = `${now.getFullYear()}年${now.getMonth()+1}月${now.getDate()}日 ${weekdays[now.getDay()]}`;
  }
}

function updateHeroGreeting() {
  const hour = new Date().getHours();
  const greetingEl = document.getElementById('heroGreeting');
  const subtitleEl = document.getElementById('heroSubtitle');

  let greeting, subtitle;
  if (hour >= 5 && hour < 9) {
    greeting = '早上好 🌅';
    subtitle = '新的一天，从维护友谊开始 ✨';
  } else if (hour >= 9 && hour < 12) {
    greeting = '上午好 ☀️';
    subtitle = '工作再忙，也别忘了朋友哦 💫';
  } else if (hour >= 12 && hour < 14) {
    greeting = '中午好 🍜';
    subtitle = '午休时间，给朋友发个消息吧 💬';
  } else if (hour >= 14 && hour < 18) {
    greeting = '下午好 ☕';
    subtitle = '下午茶时间，友谊也要保温哦 🔥';
  } else if (hour >= 18 && hour < 22) {
    greeting = '晚上好 🌙';
    subtitle = '今天也要好好维护友谊哦 ✨';
  } else {
    greeting = '夜深了 🌃';
    subtitle = '早点休息，明天继续守护友谊 💤';
  }

  if (greetingEl) greetingEl.textContent = greeting;
  if (subtitleEl) subtitleEl.textContent = subtitle;
}

