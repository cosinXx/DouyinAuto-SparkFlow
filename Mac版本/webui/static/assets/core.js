/**
 * core.js — DouYinSparkFlow 前端基础设施层（零依赖，纯 ES Module）
 * 内容：DOM 简写 / HTTP / 转义 / Toast / SparkFX 动效引擎 / keyed reconcile / 数字动画
 * 规则：本文件不依赖应用状态，可被任意业务模块 import；禁止反向依赖 app.js
 */
export const $ = id => document.getElementById(id);
let toastTimer = null;
export function toast(msg, isErr) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "show" + (isErr ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ""; }, 2400);
}
export async function api(path, opts) {
  const r = await fetch(path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.msg || ("HTTP " + r.status));
  return j;
}
export function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}
/* 高亮搜索命中的所有片段（输入已转义）——一次扫描 O(n) 标记全部出现位置 */
export function escMark(s, kw) {
  if (!kw) return esc(s);
  const low = s.toLowerCase();
  const out = [];
  let i = 0;
  for (;;) {
    const j = low.indexOf(kw, i);
    if (j < 0) { out.push(esc(s.slice(i))); break; }
    out.push(esc(s.slice(i, j)), "<mark>", esc(s.slice(j, j + kw.length)), "</mark>");
    i = j + kw.length;
  }
  return out.join("");
}
/* ---------- SparkFX 微动效引擎（GSAP 方法论，零依赖内联） ---------- */
export const FX = (() => {
  const RM = matchMedia("(prefers-reduced-motion: reduce)");
  // ease 曲线（GSAP 同名语义；power 数字越大越陡）
  const EASE = {
    "none": t => t,
    "power1.out": t => 1 - Math.pow(1 - t, 2),
    "power2.out": t => 1 - Math.pow(1 - t, 3),
    "power3.out": t => 1 - Math.pow(1 - t, 4),
    "back.out": t => { const c1 = 1.4, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
  };
  const tweens = new Set();   // 活跃 tween 池（单 rAF 统一驱动）
  let rafId = 0;

  /* 每元素维护 __fx 变换状态：写入前零 getComputedStyle 读取（避免 layout thrashing） */
  function fstate(el) {
    if (!el.__fx) el.__fx = { x: 0, y: 0, scale: 1, opacity: 1 };
    return el.__fx;
  }
  function apply(el) {
    const s = fstate(el);
    let tf = "";
    if (s.x || s.y) tf += `translate(${s.x}px,${s.y}px)`;
    if (s.scale !== 1) tf += ` scale(${s.scale})`;
    el.style.transform = tf;
    // autoAlpha 语义：0 时 visibility:hidden（不挡指针、不耗渲染），非 0 恢复
    if (s.opacity <= 0) { el.style.visibility = "hidden"; el.style.opacity = 0; }
    else { el.style.visibility = ""; el.style.opacity = s.opacity; }
  }
  function finalize(el) {
    const s = fstate(el);
    if (!s.x && !s.y && s.scale === 1) el.style.transform = "";  // 清理，让 CSS 重新接管
    if (s.opacity >= 1) { el.style.opacity = ""; el.style.visibility = ""; }
    el.style.willChange = "";
    el.classList.remove("entering");
  }
  function killTweens(el) {
    for (const tw of tweens) if (tw.items.some(it => it.el === el)) tweens.delete(tw);
  }

  function tick() {
    const now = performance.now();
    for (const tw of tweens) {
      let allDone = true;
      for (const it of tw.items) {
        const t0 = tw.start + (tw.stagger || 0) * it.i;
        if (now < t0) { allDone = false; continue; }             // 还在 stagger 延迟里
        const p = Math.min(1, (now - t0) / tw.dur);
        const e = tw.ease(p);
        const s = fstate(it.el);
        for (const [k, from, to] of it.props) s[k] = from + (to - from) * e;
        apply(it.el);
        if (p < 1) allDone = false;
      }
      if (allDone) {
        tweens.delete(tw);
        tw.items.forEach(it => finalize(it.el));
        tw.onComplete && tw.onComplete(tw.items.map(it => it.el));
      }
    }
    rafId = tweens.size ? requestAnimationFrame(tick) : 0;
  }

  /* vars: { x, y, scale, autoAlpha, duration(ms), delay(ms), ease, stagger(ms), onComplete, set } */
  function tween(targets, vars, isFrom) {
    const els = (targets instanceof Element) ? [targets] : [...targets];
    if (!els.length) return;
    const dur = Math.max(1, vars.duration ?? 200);
    const ease = EASE[vars.ease || "power2.out"] || EASE["power2.out"];

    // 提取要动的通道；from 模式起点用 vars 值，to 模式终点用 vars 值
    const chans = [];
    for (const k of ["x", "y", "scale"]) if (k in vars) chans.push([k, vars[k]]);
    if ("autoAlpha" in vars) chans.push(["opacity", vars.autoAlpha]);

    // reduced-motion / set：跳过动画直接落终态（GSAP matchMedia 同款语义）
    if (RM.matches || vars.set) {
      els.forEach(el => {
        killTweens(el);
        // from() 的终态就是当前状态 → 原地不动；to()/set() 落 vars 值
        if (!isFrom) {
          const s = fstate(el);
          for (const [k, v] of chans) s[k] = v;
          apply(el);
        }
        finalize(el);
      });
      vars.onComplete && vars.onComplete(els);
      return;
    }

    els.forEach(el => killTweens(el));                           // overwrite:auto
    const start = performance.now() + (vars.delay || 0);
    const items = els.map((el, i) => {
      const s = fstate(el);
      el.classList.add("entering");
      el.style.willChange = "transform, opacity";
      // from 模式先把起始态落上去（immediateRender 语义，防闪）
      const props = chans.map(([k, v]) => [k, isFrom ? v : s[k], isFrom ? s[k] : v]);
      if (isFrom) {
        for (const [k, from] of props) s[k] = from;
        apply(el);
      }
      return { el, i, props };
    });
    tweens.add({ items, dur, ease, stagger: vars.stagger || 0, start, onComplete: vars.onComplete });
    if (!rafId) rafId = requestAnimationFrame(tick);
  }
  return {
    to: (els, vars) => tween(els, vars, false),
    from: (els, vars) => tween(els, vars, true),
    set: (els, vars) => tween(els, { ...vars, set: true }, false),
    kill: killTweens,
    busy: () => tweens.size,
  };
})();
/* ---------- keyed reconcile：列表增量调和（核心显示算法） ----------
   结构变化（增/删/排序/首次加载）只动差异节点；已有节点原位复用。
   返回本次新建的节点数组（供入场动画）。 */
export function reconcile(box, keys, create, update) {
  const prev = box.__nodes || new Map();
  const next = new Set(keys);
  for (const [k, node] of prev) if (!next.has(k)) node.remove();  // 删除消失项
  const nodes = new Map();
  const fresh = [];
  const frag = document.createDocumentFragment();
  keys.forEach((k, idx) => {
    let node = prev.get(k);
    if (node) update && update(node, k);
    else { node = create(k); fresh.push(node); update && update(node, k); }  // 新建节点同样要填充内容
    nodes.set(k, node);
    // 仅当节点缺失或相对位置错误时才移动：已在位的节点不重新插入 DOM，
    // 否则浏览器会对整列重放入场动画（每次搜索/勾选都闪一遍）
    const expectedPrev = idx === 0 ? null : nodes.get(keys[idx - 1]);
    if (node.parentNode !== box || node.previousSibling !== expectedPrev) {
      frag.appendChild(node);
    }
  });
  box.appendChild(frag);
  box.__nodes = nodes;
  return fresh;
}
/* ---------- 数字动画（respect reduced-motion） ---------- */
export function animateNumber(element, target, duration = 800) {
  if (!element) return;
  target = Number(target) || 0;
  const start = parseInt(element.textContent) || 0;
  if (start === target) { element.textContent = target; return; }
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || duration <= 0) {
    element.textContent = target;
    return;
  }
  const startTime = performance.now();
  function update(currentTime) {
    const elapsed = currentTime - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const easeProgress = 1 - Math.pow(1 - progress, 3); // easeOutCubic
    element.textContent = Math.round(start + (target - start) * easeProgress);
    if (progress < 1) requestAnimationFrame(update);
  }
  requestAnimationFrame(update);
}

/* ---------- 统一玻璃风模态（confirm / prompt / choice，替代原生阻塞弹窗） ----------
   每个模态持有自包含闭包状态（closed 标志 + 自身 mask/监听引用），
   新开模态会先以“取消值”关闭上一个并独立解绑其监听/移除其 DOM，
   不依赖共享的模块级“当前元素”指针，杜绝旧 Promise 永挂与 Esc 误关新模态。 */
let _modalTop = null;  // {cancel} 当前栈顶模态
function _openModal({ title, message = "", confirmText = "确定", cancelText = "取消",
                      danger = false, inputCfg = null, choices = null }) {
  return new Promise(resolve => {
    if (_modalTop) { const prev = _modalTop; _modalTop = null; prev.cancel(); }

    const mask = document.createElement("div");
    mask.className = "ui-modal-mask";
    const box = document.createElement("div");
    box.className = "ui-modal" + (danger ? " danger" : "");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");

    const titleEl = document.createElement("div");
    titleEl.className = "ui-modal-title";
    titleEl.textContent = title;
    const msgEl = document.createElement("div");
    msgEl.className = "ui-modal-msg";
    msgEl.style.whiteSpace = "pre-line";
    msgEl.textContent = message;
    box.append(titleEl, msgEl);

    // 取消值语义：prompt/choice 为 null，confirm 为 false
    const cancelValue = (inputCfg || choices) ? null : false;
    let inputEl = null;
    let okBtn = null;
    let choiceBtns = [];

    if (inputCfg) {
      inputEl = document.createElement(inputCfg.multiline ? "textarea" : "input");
      inputEl.className = "ui-modal-input";
      inputEl.placeholder = inputCfg.placeholder || "";
      inputEl.value = inputCfg.defaultValue || "";
      if (inputCfg.multiline) inputEl.rows = 3;
      box.appendChild(inputEl);
    }

    if (choices) {
      const list = document.createElement("div");
      list.className = "ui-choice-list";
      choiceBtns = choices.map(c => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "ui-choice-item" + (c.danger ? " danger" : "");
        const lab = document.createElement("span");
        lab.className = "ui-choice-label";
        lab.textContent = c.label;
        b.appendChild(lab);
        if (c.desc) {
          const d = document.createElement("span");
          d.className = "ui-choice-desc";
          d.textContent = c.desc;
          b.appendChild(d);
        }
        list.appendChild(b);
        return b;
      });
      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "btn ui-modal-cancel";
      cancelBtn.textContent = cancelText;
      box.append(list, cancelBtn);
      okBtn = cancelBtn;  // 仅用于兜底焦点
    } else {
      const actions = document.createElement("div");
      actions.className = "ui-modal-actions";
      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "btn ui-modal-cancel";
      cancelBtn.textContent = cancelText;
      okBtn = document.createElement("button");
      okBtn.type = "button";
      okBtn.className = "btn primary ui-modal-ok";
      if (danger) okBtn.classList.add("danger");
      okBtn.textContent = confirmText;
      actions.append(cancelBtn, okBtn);
      box.appendChild(actions);
      cancelBtn.addEventListener("click", () => finish(cancelValue));
      okBtn.addEventListener("click", () => finish(inputEl ? inputEl.value : true));
    }
    mask.appendChild(box);

    let closed = false;
    function finish(val) {
      if (closed) return;
      closed = true;
      if (_modalTop === api) _modalTop = null;
      document.removeEventListener("keydown", onKey, true);
      box.classList.add("closing");
      mask.classList.add("closing");
      const el = mask;
      setTimeout(() => el.remove(), 180);
      resolve(val);
    }
    function onKey(e) {
      // IME 组词中（含 keyCode 229 兼容）Enter 不提交，否则中文输到一半会被确认
      const composing = e.isComposing || e.keyCode === 229;
      if (e.key === "Escape") {
        e.preventDefault();
        finish(cancelValue);
        return;
      }
      if (e.key === "Enter" && !composing && !choices) {
        if (!inputEl) {
          e.preventDefault();
          finish(true);
        } else if (!inputCfg.multiline && document.activeElement === inputEl) {
          e.preventDefault();
          finish(inputEl.value);
        }
      }
    }

    const api = { cancel: () => finish(cancelValue) };
    _modalTop = api;
    if (choices) {
      choiceBtns.forEach((b, i) => b.addEventListener("click", () => finish(choices[i].value)));
      okBtn.addEventListener("click", () => finish(cancelValue));
    }
    mask.addEventListener("mousedown", e => { if (e.target === mask) finish(cancelValue); });
    document.addEventListener("keydown", onKey, true);

    document.body.appendChild(mask);
    FX.from(box, { autoAlpha: 0, y: 14, scale: 0.97, duration: 220, ease: "back.out" });
    setTimeout(() => {
      if (closed) return;
      if (inputEl) inputEl.focus();
      else if (choiceBtns[0]) choiceBtns[0].focus();
      else if (okBtn) okBtn.focus();
    }, 30);
  });
}

export function confirmModal(opts) {
  return _openModal({ ...opts, inputCfg: null, choices: null });
}
export function promptModal(opts = {}) {
  const { placeholder = "", defaultValue = "", multiline = false, ...rest } = opts;
  return _openModal({ ...rest, choices: null, inputCfg: { placeholder, defaultValue, multiline } });
}
/* 多选项模态：choices = [{value,label,desc,danger}]，返回选中 value 或 null */
export function choiceModal({ title, message = "", choices = [], cancelText = "取消" }) {
  return _openModal({ title, message, choices, cancelText });
}
