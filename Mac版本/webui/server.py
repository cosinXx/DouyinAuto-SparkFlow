#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
DouYinSparkFlow Web 控制台后端 v2
零依赖（仅 Python 标准库），用项目自带 .venv 的 Python 运行即可。
启动：.venv/bin/python webui/server.py
"""
import json
import os
import plistlib
import re
import signal
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

# ---------- 路径 ----------
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# 确保能 import core 包（server.py 从 webui/ 启动时 sys.path 不含项目根）
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)
ENV_PATH = os.path.join(BASE_DIR, ".env")
STATIC_DIR = os.path.join(BASE_DIR, "webui", "static")
LOGS_DIR = os.path.join(BASE_DIR, "logs")
PLIST_PATH = os.path.expanduser("~/Library/LaunchAgents/com.douyin.sparkflow.plist")
PLIST_LABEL = "com.douyin.sparkflow"

HOST = "127.0.0.1"
PORT = 8899

# ---------- 安全常量 ----------
MAX_REQUEST_BODY = 512 * 1024  # 512 KB，足够 cookies 等大 payload
MAX_LOG_TAIL_BYTES = 256 * 1024  # 单日志文件最大读取字节
MAX_LOG_FILES = 10  # 最多返回日志文件数

# ---------- v27 AI 功能配置映射（前端字段 -> .env 键） ----------
AI_FEATURES = {
    "ai_personal": ("AI_PERSONAL", "0"),      # AI 个性化专属消息
    "ai_festival": ("AI_FESTIVAL", "0"),      # 节日问候
    "ai_dedup": ("AI_DEDUP", "0"),            # 消息去重
    "safe_rate": ("SAFE_RATE", "0"),          # 限流保护
    "rate_min": ("RATE_MIN", "3"),            # 发送间隔下限(秒)
    "rate_max": ("RATE_MAX", "8"),            # 发送间隔上限(秒)
    "daily_send_limit": ("DAILY_SEND_LIMIT", "0"),  # 每日发送上限(0=不限)
    "safe_token": ("SAFE_TOKEN", "0"),        # Token 保护
    "token_daily_limit": ("TOKEN_DAILY_LIMIT", "50000"),  # 每日 Token 上限
    "token_low": ("TOKEN_LOW", "0"),          # 低消耗模式
    # ---- 平台深度集成（智能功能中心） ----
    "f_spark_monitor": ("F_SPARK_MONITOR", "0"),  # 火花状态监控
    "f_birthday": ("F_BIRTHDAY", "0"),            # 好友生日祝福
    "f_online_greet": ("F_ONLINE_GREET", "0"),    # 在线状态打招呼
    "f_auto_reply": ("F_AUTO_REPLY", "0"),        # 自动回复私信
    "f_auto_like": ("F_AUTO_LIKE", "0"),          # 自动点赞评论
    "f_new_fan": ("F_NEW_FAN", "0"),              # 新粉丝欢迎
    "f_post_alert": ("F_POST_ALERT", "0"),        # 作品发布提醒
    "f_groups": ("F_GROUPS", "0"),                # 好友分组标签
}
MAX_RUN_LINES = 50000  # 运行输出在内存中的最大行数（防长任务内存膨胀）

HITOKOTO_TYPES = ["动画", "漫画", "游戏", "文学", "原创", "来自网络", "其他",
                  "影视", "诗词", "哲学", "抖机灵"]

# ---------- 运行状态（全局） ----------
_run = {
    "proc": None,
    "state": "idle",  # idle | running | done | error | stopped
    "lines": [],
    "started": None,
    "exitcode": None,
    "mode": "normal",  # normal | dryrun
}
_run_lock = threading.Lock()

# ---------- .env 文件锁（防止并发写入丢数据） ----------
_env_lock = threading.Lock()

# ---------- 火花监控进度（异步任务状态） ----------
_spark_monitor_progress = {
    "running": False,
    "current": 0,
    "total": 0,
    "message": "",
    "result": None,
}


# ============================================================
# .env 读写（行级替换，保留注释与其他行不动）
# ============================================================
def read_env_lines():
    """读取 .env 文件行，使用文件锁防止并发写冲突。"""
    with _env_lock:
        try:
            with open(ENV_PATH, encoding="utf-8") as f:
                return f.read().splitlines()
        except FileNotFoundError:
            return []


def _write_env_lines_atomic(lines):
    """原子写入 .env：先写临时文件再 rename，避免写入中途崩溃导致文件损坏。"""
    tmp_path = ENV_PATH + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp_path, ENV_PATH)


def write_env_lines(lines):
    with _env_lock:
        _write_env_lines_atomic(lines)


def _strip_outer_quote(val):
    val = val.strip()
    if len(val) >= 2 and val[0] in "\"'" and val[-1] == val[0]:
        return val[1:-1]
    return val


def parse_env():
    """解析 .env 为 dict。cookies 值去掉外层单引号后原样返回。"""
    result = {}
    for line in read_env_lines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        if "=" not in s:
            continue
        key, _, val = s.partition("=")
        key = key.strip()
        val = val.strip()
        # [修复] .env 格式本身不支持行内注释（# 必须在行首才是注释）。
        # 原代码用 r"\s+#" 剥行尾注释会截断合法配置值中包含的 " #"（如消息文案中的话题标签）。
        result[key] = _strip_outer_quote(val)
    return result


def set_env_value(key, value, quote=None):
    """
    行级替换/追加某个 KEY 的值。
    quote: None 原样写；"'" 单引号包裹；'"' 双引号包裹。
    使用原子写入，保证并发安全。
    """
    with _env_lock:
        lines = []
        try:
            with open(ENV_PATH, encoding="utf-8") as f:
                lines = f.read().splitlines()
        except FileNotFoundError:
            lines = []

        new_lines = []
        found = False
        for line in lines:
            if re.match(rf"^\s*{re.escape(key)}\s*=", line):
                if quote == "'":
                    new_lines.append(f"{key}='{value}'")
                elif quote == '"':
                    new_lines.append(f'{key}="{value}"')
                else:
                    new_lines.append(f"{key}={value}")
                found = True
            else:
                new_lines.append(line)
        if not found:
            if quote == "'":
                new_lines.append(f"{key}='{value}'")
            elif quote == '"':
                new_lines.append(f'{key}="{value}"')
            else:
                new_lines.append(f"{key}={value}")
        _write_env_lines_atomic(new_lines)


def del_env_value(key):
    """从 .env 删除某个 KEY（原子写入）。删除不存在的键是幂等操作。"""
    with _env_lock:
        try:
            with open(ENV_PATH, encoding="utf-8") as f:
                lines = f.read().splitlines()
        except FileNotFoundError:
            return
        new_lines = [line for line in lines if not re.match(rf"^\s*{re.escape(key)}\s*=", line)]
        _write_env_lines_atomic(new_lines)


def _safe_json_loads(raw, default):
    """安全解析 JSON，失败返回默认值。"""
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return default


def read_tasks():
    """读取并解析 TASKS，返回 list。"""
    env = parse_env()
    raw = env.get("TASKS", "[]")
    tasks = _safe_json_loads(raw, [])
    if not isinstance(tasks, list):
        return []
    return tasks


def write_tasks(tasks):
    set_env_value("TASKS", json.dumps(tasks, ensure_ascii=False))


def read_nicknames():
    """读取好友昵称映射 FRIEND_NICKNAMES，返回 dict {抖音号: 昵称}。"""
    env = parse_env()
    raw = env.get("FRIEND_NICKNAMES", "{}")
    d = _safe_json_loads(raw, {})
    return d if isinstance(d, dict) else {}


def write_nicknames(nick_map):
    """写入好友昵称映射。"""
    if not isinstance(nick_map, dict):
        return
    set_env_value("FRIEND_NICKNAMES", json.dumps(nick_map, ensure_ascii=False))


def update_nickname(unique_id, nickname):
    """更新单个好友的昵称，返回更新后的完整映射。"""
    if not unique_id or not nickname:
        return read_nicknames()
    m = read_nicknames()
    if m.get(unique_id) == nickname:
        return m  # 无变化，零写入
    m[unique_id] = nickname
    write_nicknames(m)
    return m


def read_remarks():
    """读取好友备注映射 FRIEND_REMARKS，返回 dict {抖音号: 备注}。"""
    env = parse_env()
    raw = env.get("FRIEND_REMARKS", "{}")
    d = _safe_json_loads(raw, {})
    return d if isinstance(d, dict) else {}


def write_remarks(remark_map):
    """写入好友备注映射。"""
    if not isinstance(remark_map, dict):
        return
    set_env_value("FRIEND_REMARKS", json.dumps(remark_map, ensure_ascii=False))


def update_remark(unique_id, remark):
    """更新单个好友的备注，返回更新后的完整映射。空字符串则删除备注。"""
    if not unique_id:
        return read_remarks()
    m = read_remarks()
    if remark:
        if m.get(unique_id) == remark:
            return m
        m[unique_id] = remark
    else:
        if unique_id in m:
            del m[unique_id]
        else:
            return m
    write_remarks(m)
    return m


def count_cookies(raw_json):
    try:
        arr = json.loads(raw_json)
        if isinstance(arr, list):
            return len(arr)
    except Exception:
        pass
    return 0


def _calc_achievements(stats):
    """基于统计数据计算成就解锁状态。纯计算，无副作用。"""
    import datetime
    daily = stats.get("daily", {}) or {}
    total_sent = stats.get("total_sent", 0) or 0
    total_runs = stats.get("total_runs", 0) or 0

    def _day_sent(date_str):
        d = daily.get(date_str)
        return d.get("sent", 0) if d else 0

    def _day_failed(date_str):
        d = daily.get(date_str)
        return d.get("failed", 0) if d else 0

    # 连续发送天数
    streak = 0
    d = datetime.date.today()
    while _day_sent(d.strftime("%Y-%m-%d")) > 0:
        streak += 1
        d -= datetime.timedelta(days=1)

    # 连续零失败天数
    perfect = 0
    d = datetime.date.today()
    while _day_sent(d.strftime("%Y-%m-%d")) > 0 and _day_failed(d.strftime("%Y-%m-%d")) == 0:
        perfect += 1
        d -= datetime.timedelta(days=1)

    def ach(id, name, desc, icon, unlocked, progress):
        return {"id": id, "name": name, "desc": desc, "icon": icon,
                "unlocked": bool(unlocked), "progress": progress}

    achievements = [
        ach("first_run", "初次见面", "完成第 1 次自动运行", "🌱", total_runs >= 1, f"{min(total_runs,1)}/1"),
        ach("runner_10", "持之以恒", "累计运行 10 次", "⚡", total_runs >= 10, f"{min(total_runs,10)}/10"),
        ach("sent_10", "小试牛刀", "累计发送 10 条火花", "🔥", total_sent >= 10, f"{min(total_sent,10)}/10"),
        ach("sent_50", "渐入佳境", "累计发送 50 条火花", "🌟", total_sent >= 50, f"{min(total_sent,50)}/50"),
        ach("sent_100", "火花大师", "累计发送 100 条火花", "🏆", total_sent >= 100, f"{min(total_sent,100)}/100"),
        ach("streak_3", "三天打鱼", "连续 3 天发送火花", "🐟", streak >= 3, f"{min(streak,3)}/3"),
        ach("streak_7", "一周之约", "连续 7 天发送火花", "📅", streak >= 7, f"{min(streak,7)}/7"),
        ach("streak_30", "满月之约", "连续 30 天发送火花", "🌙", streak >= 30, f"{min(streak,30)}/30"),
        ach("perfect_3", "完美开局", "连续 3 天零失败", "💯", perfect >= 3, f"{min(perfect,3)}/3"),
        ach("perfect_7", "完美全勤", "连续 7 天零失败", "👑", perfect >= 7, f"{min(perfect,7)}/7"),
    ]
    unlocked_count = sum(1 for a in achievements if a["unlocked"])
    return achievements, unlocked_count


# ============================================================
# 定时任务 (launchctl / plist)
# ============================================================
def _read_schedule_times():
    """从 plist 读取执行时间列表，统一返回 [{'hour':int,'minute':int}, ...]。"""
    if not os.path.exists(PLIST_PATH):
        return []
    with open(PLIST_PATH, "rb") as f:
        p = plistlib.load(f)
    si = p.get("StartCalendarInterval", {})
    times = []
    if isinstance(si, dict):  # 单时间点（旧格式）
        times.append({"hour": int(si.get("Hour", 9)),
                      "minute": int(si.get("Minute", 0))})
    elif isinstance(si, list):  # 多时间点
        for item in si:
            if isinstance(item, dict) and "Hour" in item:
                times.append({"hour": int(item["Hour"]),
                              "minute": int(item.get("Minute", 0))})
    return times


def _write_schedule_times(times, was_loaded):
    """把时间列表写入 plist（多时间点用数组格式），必要时重载。"""
    with open(PLIST_PATH, "rb") as f:
        p = plistlib.load(f)
    if len(times) == 1:
        p["StartCalendarInterval"] = {"Hour": times[0]["hour"],
                                      "Minute": times[0]["minute"]}
    else:
        p["StartCalendarInterval"] = [
            {"Hour": t["hour"], "Minute": t["minute"]} for t in times
        ]
    # 原子写入 plist
    tmp = PLIST_PATH + ".tmp"
    with open(tmp, "wb") as f:
        plistlib.dump(p, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, PLIST_PATH)
    if was_loaded:
        # 改时间后必须重载才会生效；显式指定 GUI 域（与 _service_loaded 同理）
        subprocess.run(["launchctl", "bootout", f"{_gui_domain()}/{PLIST_LABEL}"],
                       capture_output=True, timeout=15)
        subprocess.run(["launchctl", "bootstrap", _gui_domain(), PLIST_PATH],
                       capture_output=True, timeout=15)


def _gui_domain():
    """当前用户的 GUI launchd 域（显式指定，避免依赖调用者自己的会话域）。"""
    return f"gui/{os.getuid()}"


def _service_loaded():
    """检测定时任务是否已加载到 launchd。

    关键修复：
    1. 不能只看 returncode——服务不存在时 returncode 可能是 113，也可能是 0
    2. 不能只看域全量列表中是否有 label——plist 文件存在时会显示 "enabled"，但服务不一定已加载
    3. 必须检查单个服务的详细输出中是否包含 "state =" 或 "path =" 等关键字段

    判断逻辑：
    - launchctl print gui/<uid>/<label> 输出包含 "state =" 或 "path =" → 已加载
    - 输出包含 "Could not find service" 或 "Bad request" → 未加载
    - 兜底：launchctl list 中能找到服务 → 已加载
    """
    # ① 精确查询单个服务（最可靠）
    try:
        r = subprocess.run(
            ["launchctl", "print", f"{_gui_domain()}/{PLIST_LABEL}"],
            capture_output=True, text=True, timeout=10,
        )
        output = r.stdout + r.stderr
        # 检查是否明确说服务不存在
        if "Could not find service" in output or "Bad request" in output:
            return False, None
        # 检查是否包含服务的详细信息（说明已加载）
        if "state =" in output or "path =" in output or "program =" in output:
            pid = None
            for line in output.splitlines():
                ls = line.strip()
                if ls.startswith("pid ="):
                    v = ls.split("=", 1)[1].strip()
                    if v.isdigit():
                        pid = v
                    break
            return True, pid
    except Exception:
        pass

    # ② 兜底：裸 list（GUI 会话内启动的进程可命中）
    try:
        out = subprocess.run(
            ["launchctl", "list"], capture_output=True, text=True, timeout=10
        ).stdout
        for line in out.splitlines():
            if PLIST_LABEL in line:
                parts = line.split()
                pid = parts[0] if len(parts) >= 2 and parts[0].isdigit() else None
                return True, pid
    except Exception:
        pass

    return False, None


def schedule_status():
    info = {"loaded": False, "pid": None, "times": []}
    info["loaded"], info["pid"] = _service_loaded()

    # 读 plist 里的时间（兼容单/多时间点格式）
    try:
        times = _read_schedule_times()
        info["times"] = times
        # 兼容字段：旧客户端只读 hour/minute，取第一个时间点
        if times:
            info["hour"] = times[0]["hour"]
            info["minute"] = times[0]["minute"]
        if not os.path.exists(PLIST_PATH):
            info["plist_missing"] = True
    except Exception:
        pass
    return info


def schedule_enable():
    if not os.path.exists(PLIST_PATH):
        return {"ok": False, "err": f"plist 文件不存在: {PLIST_PATH}"}
    # 先踢掉旧实例再注册；显式 GUI 域，避免依赖调用者会话域
    subprocess.run(
        ["launchctl", "bootout", f"{_gui_domain()}/{PLIST_LABEL}"],
        capture_output=True, timeout=15,
    )
    r = subprocess.run(
        ["launchctl", "bootstrap", _gui_domain(), PLIST_PATH],
        capture_output=True, text=True, timeout=15,
    )
    if r.returncode == 0:
        subprocess.run(
            ["launchctl", "enable", f"{_gui_domain()}/{PLIST_LABEL}"],
            capture_output=True, timeout=10,
        )
    return {"ok": r.returncode == 0, "out": r.stdout, "err": r.stderr}


def schedule_disable():
    if not os.path.exists(PLIST_PATH):
        return {"ok": False, "err": f"plist 文件不存在: {PLIST_PATH}"}
    r = subprocess.run(
        ["launchctl", "bootout", f"{_gui_domain()}/{PLIST_LABEL}"],
        capture_output=True, text=True, timeout=15,
    )
    return {"ok": r.returncode == 0, "out": r.stdout, "err": r.stderr}


def schedule_set_time(hour, minute):
    """修改 plist 里的执行时间（单时间点，兼容旧客户端）。"""
    return schedule_set_times([{"hour": hour, "minute": minute}])


def schedule_set_times(times):
    """设置多时间点执行（每天多次），times 为 [{'hour':..,'minute':..}, ...]。"""
    if not isinstance(times, list) or not times:
        return {"ok": False, "err": "times 须为非空数组"}
    if len(times) > 8:
        return {"ok": False, "err": "每天最多 8 个时间点"}
    clean = []
    for t in times:
        try:
            h = int(t.get("hour"))
            m = int(t.get("minute"))
        except (ValueError, TypeError, AttributeError):
            return {"ok": False, "err": "hour/minute 必须为整数"}
        if not (0 <= h <= 23 and 0 <= m <= 59):
            return {"ok": False, "err": "hour 须在 0-23，minute 须在 0-59"}
        clean.append({"hour": h, "minute": m})
    # 排序去重
    clean = sorted({(t["hour"], t["minute"]) for t in clean})
    clean = [{"hour": h, "minute": m} for h, m in clean]

    if not os.path.exists(PLIST_PATH):
        return {"ok": False, "err": f"plist 文件不存在: {PLIST_PATH}"}
    was_loaded = schedule_status()["loaded"]
    try:
        _write_schedule_times(clean, was_loaded)
        return {"ok": True, "times": clean}
    except Exception as e:
        return {"ok": False, "err": str(e)}


# ============================================================
# 运行任务
# ============================================================
def resolve_nickname_sync(unique_id, timeout=60):
    """
    同步查询单个抖音号的昵称（启动子进程运行 main.py 的 RESOLVE_ONLY 模式）。
    阻塞当前线程直到查询完成或超时。适合在 API 请求中调用。
    """
    env = os.environ.copy()
    env["RESOLVE_ONLY"] = "1"
    env["RESOLVE_TARGET"] = unique_id
    try:
        proc = subprocess.Popen(
            [sys.executable, "main.py"],
            cwd=BASE_DIR,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            env=env,
            start_new_session=True,
        )
    except Exception as e:
        return {"ok": False, "msg": f"启动查询进程失败: {e}", "unique_id": unique_id}

    try:
        stdout, _ = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        # 超时则杀掉进程组
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except Exception:
            proc.kill()
        return {"ok": False, "msg": "查询超时（60秒），好友列表可能过长或网络较慢", "unique_id": unique_id}

    # 查询完成后读取最新昵称
    nickname = read_nicknames().get(unique_id)
    if nickname:
        return {"ok": True, "unique_id": unique_id, "nickname": nickname, "cached": False}
    # 没找到，从输出中提取错误信息
    last_lines = "\n".join(stdout.strip().splitlines()[-5:]) if stdout else ""
    return {"ok": False, "msg": f"未找到该抖音号的昵称，请确认该账号是你的抖音好友\n{last_lines}", "unique_id": unique_id}


def start_run(dryrun=False):
    global _run
    with _run_lock:
        if _run["proc"] is not None and _run["proc"].poll() is None:
            return {"ok": False, "msg": "任务正在运行中，请先点击「停止」"}
        _run["lines"] = []
        _run["state"] = "running"
        _run["started"] = time.time()
        _run["exitcode"] = None
        _run["mode"] = "dryrun" if dryrun else "normal"
        try:
            env = os.environ.copy()
            if dryrun:
                env["DRYRUN"] = "1"
            proc = subprocess.Popen(
                [sys.executable, "main.py"],
                cwd=BASE_DIR,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
                env=env,
                start_new_session=True,  # 独立进程组，方便整体终止（含 Chromium）
            )
        except Exception as e:
            _run["state"] = "error"
            _run["exitcode"] = -1
            _run["lines"].append(f"[启动失败] {e}\n")
            return {"ok": False, "msg": str(e)}
        _run["proc"] = proc

        def _reader():
            try:
                for line in proc.stdout:
                    with _run_lock:
                        # [修复] 行数上限保护，防止长任务输出无限增长导致内存膨胀
                        if len(_run["lines"]) < MAX_RUN_LINES:
                            _run["lines"].append(line)
                        elif len(_run["lines"]) == MAX_RUN_LINES:
                            _run["lines"].append("[输出已达上限，后续行已截断]\n")
            except Exception as e:
                with _run_lock:
                    _run["lines"].append(f"[读取输出失败] {e}\n")
            finally:
                proc.wait()
                with _run_lock:
                    _run["exitcode"] = proc.returncode
                    # [修复] 不覆盖手动停止状态：stop_run() 已将 state 设为 "stopped"
                    if _run["state"] != "stopped":
                        _run["state"] = "done" if proc.returncode == 0 else "error"

        threading.Thread(target=_reader, daemon=True).start()
        return {"ok": True, "msg": "测试运行已启动" if dryrun else "任务已启动"}


def stop_run():
    """停止正在运行的任务（终止整个进程组，连带 Chromium）"""
    global _run
    with _run_lock:
        proc = _run["proc"]
        if proc is None or proc.poll() is not None:
            return {"ok": False, "msg": "当前没有运行中的任务"}
        pid = proc.pid
        pgid = None
        try:
            pgid = os.getpgid(pid)
        except Exception:
            pass

    # 在锁外执行等待，避免长时间阻塞其它 API
    try:
        if pgid is not None:
            os.killpg(pgid, signal.SIGTERM)
        else:
            proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            if pgid is not None:
                os.killpg(pgid, signal.SIGKILL)
            else:
                proc.kill()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                pass
        with _run_lock:
            _run["state"] = "stopped"
            _run["exitcode"] = proc.returncode
            _run["lines"].append("\n[已手动停止任务]\n")
        return {"ok": True, "msg": "任务已停止"}
    except Exception as e:
        return {"ok": False, "msg": f"停止失败: {e}"}


def run_status():
    with _run_lock:
        proc = _run["proc"]
        running = proc is not None and proc.poll() is None
        return {
            "state": _run["state"] if not running else "running",
            "running": running,
            "started": _run["started"],
            "exitcode": _run["exitcode"],
            "total_lines": len(_run["lines"]),
            "mode": _run["mode"],
        }


def get_run_lines(offset=0):
    with _run_lock:
        return _run["lines"][offset:]


# ============================================================
# 日志
# ============================================================
def list_logs():
    if not os.path.isdir(LOGS_DIR):
        return []
    files = []
    for name in os.listdir(LOGS_DIR):
        if name.endswith(".log"):
            p = os.path.join(LOGS_DIR, name)
            # 确保是文件，跳过目录等
            if not os.path.isfile(p):
                continue
            files.append({"name": name, "mtime": os.path.getmtime(p),
                          "size": os.path.getsize(p)})
    files.sort(key=lambda x: x["mtime"], reverse=True)
    return files


def _safe_log_path(name):
    """验证日志文件名安全性，防止路径穿越。返回绝对路径或 None。"""
    if not name or not name.endswith(".log"):
        return None
    # 禁止任何路径分隔符或 .. 
    if "/" in name or "\\" in name or ".." in name:
        return None
    full = os.path.join(LOGS_DIR, name)
    # 用 realpath 解析后确认仍在 LOGS_DIR 内
    real_full = os.path.realpath(full)
    real_logs = os.path.realpath(LOGS_DIR)
    if not real_full.startswith(real_logs + os.sep):
        return None
    if not os.path.isfile(real_full):
        return None
    return real_full


def tail_file(path, n=200, max_bytes=MAX_LOG_TAIL_BYTES):
    """安全 tail：限制最大读取字节，防止大文件爆内存"""
    try:
        size = os.path.getsize(path)
        read_from = max(0, size - max_bytes)
        with open(path, "rb") as f:
            if read_from > 0:
                f.seek(read_from)
                f.readline()  # 跳过可能截断的首行
            data = f.read().decode("utf-8", errors="replace")
        lines = data.splitlines(keepends=True)
        return "".join(lines[-n:])
    except Exception as e:
        return f"[读取失败] {e}\n"


# ============================================================
# HTTP 安全头
# ============================================================
def _send_security_headers(handler):
    """发送通用安全响应头。"""
    handler.send_header("X-Content-Type-Options", "nosniff")
    handler.send_header("X-Frame-Options", "DENY")
    handler.send_header("Referrer-Policy", "no-referrer")
    handler.send_header("X-XSS-Protection", "1; mode=block")
    # CSP：仅允许同源资源
    handler.send_header("Content-Security-Policy",
                        "default-src 'self'; "
                        "script-src 'self' 'unsafe-inline'; "
                        "style-src 'self' 'unsafe-inline'; "
                        "img-src 'self' data:; "
                        "connect-src 'self'")
    # CORS：仅允许本地
    handler.send_header("Access-Control-Allow-Origin", f"http://{HOST}:{PORT}")
    handler.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    handler.send_header("Access-Control-Allow-Headers", "Content-Type")


def _safe_int(val, default=0):
    """安全解析整数，失败返回默认值。"""
    try:
        return int(val)
    except (ValueError, TypeError):
        return default


# ============================================================
# HTTP 处理
# ============================================================
class Handler(BaseHTTPRequestHandler):
    # 限制请求体大小
    max_request_body = MAX_REQUEST_BODY

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        _send_security_headers(self)
        self.end_headers()
        self.wfile.write(body)

    def _html(self, path):
        # 防路径穿越：用 realpath 校验
        full = os.path.realpath(os.path.join(STATIC_DIR, path))
        static_real = os.path.realpath(STATIC_DIR)
        if not (full == static_real or full.startswith(static_real + os.sep)):
            self.send_error(403)
            return
        if not os.path.isfile(full):
            self.send_error(404)
            return
        try:
            with open(full, "rb") as f:
                body = f.read()
        except OSError:
            self.send_error(500)
            return
        self.send_response(200)
        if path.endswith(".html"):
            self.send_header("Content-Type", "text/html; charset=utf-8")
        elif path.endswith(".js"):
            self.send_header("Content-Type", "application/javascript; charset=utf-8")
        elif path.endswith(".css"):
            self.send_header("Content-Type", "text/css; charset=utf-8")
        else:
            self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        _send_security_headers(self)
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        length = _safe_int(self.headers.get("Content-Length", 0))
        if length <= 0:
            return {}
        if length > self.max_request_body:
            # 拒绝过大的请求体
            try:
                self.rfile.read(length)  # 消耗掉请求体
            except Exception:
                pass
            return {"_error": "请求体过大"}
        try:
            raw = self.rfile.read(length)
            return json.loads(raw.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return {}

    def do_OPTIONS(self):
        """处理 CORS 预检请求。"""
        self.send_response(204)
        _send_security_headers(self)
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)

        if path == "/" or path == "/index.html":
            return self._html("index.html")

        if path.endswith(".js") or path.endswith(".css") or path.endswith(".svg"):
            return self._html(path.lstrip("/"))

        if path == "/api/state":
            env = parse_env()
            tasks = read_tasks()
            accounts = []
            for t in tasks:
                uid = (t.get("unique_id") or "").upper()
                ck_raw = env.get(f"COOKIES_{uid}", "")
                accounts.append({
                    "username": t.get("username", ""),
                    "unique_id": t.get("unique_id", ""),
                    "targets": t.get("targets", []),
                    "cookies_count": count_cookies(ck_raw),
                })
            # 有 Cookie 的账号排最前（作为当前登录账号），保证前端 account() 正确
            accounts.sort(key=lambda a: 0 if (a.get("cookies_count") or 0) > 0 else 1)
            return self._json({
                "accounts": accounts,
                "message_template": env.get("MESSAGE_TEMPLATE", ""),
                "message_presets": _safe_json_loads(env.get("MESSAGE_PRESETS", "[]"), []),
                "send_mode": env.get("SEND_MODE", "random"),
                "selected_preset_index": _safe_int(env.get("SELECTED_PRESET_INDEX", "0")),
                "hitokoto_types": _safe_json_loads(env.get("HITOKOTO_TYPES", "[]"), []),
                "match_mode": env.get("MATCH_MODE", "nickname"),
                "browser_timeout": env.get("BROWSER_TIMEOUT", "120000"),
                "friend_list_wait_time": env.get("FRIEND_LIST_WAIT_TIME", "2000"),
                "task_retry_times": env.get("TASK_RETRY_TIMES", "3"),
                "log_level": env.get("LOG_LEVEL", "INFO"),
                "ai_dedup": env.get("AI_DEDUP", "on"),
                "min_interval": env.get("MIN_INTERVAL", "3"),
                "max_interval": env.get("MAX_INTERVAL", "8"),
                "daily_limit": env.get("DAILY_LIMIT", "0"),
                "rate_limit": env.get("RATE_LIMIT", "on"),
                "schedule": schedule_status(),
                "run": run_status(),
                "ball_position": _safe_json_loads(env.get("BALL_POSITION", "{}"), {}),
                "friend_nicknames": read_nicknames(),
                "friend_remarks": read_remarks(),
                "friend_groups": _safe_json_loads(env.get("FRIEND_GROUPS", "{}"), {}),
                "friend_birthdays": _safe_json_loads(env.get("FRIEND_BIRTHDAYS", "{}"), {}),
            })

        if path == "/api/ai/config":
            """返回 AI 配置状态（是否已配置、模型、接口地址）"""
            has_key = bool((os.getenv("OPENAI_API_KEY") or "").strip())
            model = os.getenv("OPENAI_MODEL", "")
            base_url = os.getenv("OPENAI_BASE_URL", "")
            if not has_key:
                try:
                    from utils.config import get_config
                    ocfg = get_config().get("openai", {})
                    has_key = bool((ocfg.get("api_key") or "").strip())
                    if not model:
                        model = ocfg.get("model", "")
                except Exception:
                    pass
            return self._json({
                "ok": True,
                "configured": has_key,
                "model": model or "MiniMax-M2.7",
                "base_url": base_url,
                "provider": os.getenv("OPENAI_PROVIDER", "") or "",
            })

        if path == "/api/ai/features":
            """AI 功能配置读取（v27）：个性化 / 安全保护 / 平台集成开关 + 分组/生日/自定义节日"""
            env = parse_env()
            out = {}
            for key, (env_key, default) in AI_FEATURES.items():
                out[key] = env.get(env_key, default)
            out["friend_groups"] = _safe_json_loads(env.get("FRIEND_GROUPS", "{}"), {})
            out["friend_birthdays"] = _safe_json_loads(env.get("FRIEND_BIRTHDAYS", "{}"), {})
            out["custom_festivals"] = _safe_json_loads(env.get("CUSTOM_FESTIVALS", "{}"), {})
            return self._json({"ok": True, **out})

        if path == "/api/ai/usage":
            """AI Token 用量统计（Token 保护）"""
            from utils.ai_usage import get_usage
            u = get_usage()
            daily = u.get("daily", {})
            today_key = time.strftime("%Y-%m-%d")
            today = daily.get(today_key, {"tokens": 0, "calls": 0})
            limit = _safe_int(os.getenv("TOKEN_DAILY_LIMIT", "50000"), 50000)
            return self._json({
                "ok": True,
                "today_tokens": today.get("tokens", 0),
                "today_calls": today.get("calls", 0),
                "daily_limit": limit,
                "limit_enabled": _safe_int(os.getenv("SAFE_TOKEN", "0"), 0) == 1,
                "history": dict(list(daily.items())[-7:]),
            })

        if path == "/api/run":
            """运行状态（供前端轮询，含最近日志行用于活动叙述）"""
            status = run_status()
            with _run_lock:
                lines = _run["lines"][-5:]
            return self._json({**status, "lines": lines})

        if path == "/api/run/status":
            offset = _safe_int(qs.get("offset", ["0"])[0])
            if offset < 0:
                offset = 0
            new_lines = get_run_lines(offset)
            return self._json({
                **run_status(),
                "new_lines": new_lines,
                "offset": offset + len(new_lines),
            })

        if path == "/api/logs":
            files = list_logs()
            result = []
            for f in files[:MAX_LOG_FILES]:
                safe_path = _safe_log_path(f["name"])
                if safe_path is None:
                    continue
                result.append({
                    "name": f["name"],
                    "mtime": f["mtime"],
                    "size": f["size"],
                    "tail": tail_file(safe_path),
                })
            return self._json({"files": result})

        # 发送记录 API
        if path == "/api/send/records":
            """获取发送记录列表（支持按好友、日期筛选）"""
            try:
                data_dir = os.path.join(BASE_DIR, "data")
                memory_file = os.path.join(data_dir, "sent_memory.json")
                stats_file = os.path.join(data_dir, "send_stats.json")

                # 读取发送记忆
                memory = {}
                if os.path.exists(memory_file):
                    with open(memory_file, encoding="utf-8") as f:
                        memory = json.load(f)

                # 读取统计数据
                stats = {}
                if os.path.exists(stats_file):
                    with open(stats_file, encoding="utf-8") as f:
                        stats = json.load(f)

                # 构建发送记录
                records = []
                friend_stats = stats.get("friend_stats", {})
                nicknames = read_nicknames()

                for friend_id, messages in memory.items():
                    friend_name = friend_stats.get(friend_id, {}).get("name", "")
                    if not friend_name:
                        friend_name = nicknames.get(friend_id, friend_id)

                    for msg in messages[-20:]:  # 每个好友最多显示最近20条
                        records.append({
                            "friend_id": friend_id,
                            "friend_name": friend_name,
                            "message": msg,
                            "message_preview": msg[:50] + "..." if len(msg) > 50 else msg,
                        })

                # 按好友统计
                friend_summary = []
                for friend_id, info in friend_stats.items():
                    friend_name = info.get("name", nicknames.get(friend_id, friend_id))
                    friend_summary.append({
                        "friend_id": friend_id,
                        "friend_name": friend_name,
                        "sent_count": info.get("sent", 0),
                        "message_count": len(memory.get(friend_id, [])),
                    })
                friend_summary.sort(key=lambda x: x["sent_count"], reverse=True)

                return self._json({
                    "ok": True,
                    "total_records": len(records),
                    "records": records[:200],  # 最多返回200条
                    "friend_summary": friend_summary,
                    "daily_stats": stats.get("daily", {}),
                    "total_sent": stats.get("total_sent", 0),
                    "total_runs": stats.get("total_runs", 0),
                })
            except Exception as e:
                return self._json({"ok": False, "msg": str(e)}, 500)

        if path == "/api/config/export":
            """导出全部配置为 JSON（不含 cookies，保护隐私）"""
            env = parse_env()
            export_data = {
                "version": 1,
                "export_time": time.strftime("%Y-%m-%d %H:%M:%S"),
                "tasks": _safe_json_loads(env.get("TASKS", "[]"), []),
                "message_template": env.get("MESSAGE_TEMPLATE", ""),
                "message_presets": _safe_json_loads(env.get("MESSAGE_PRESETS", "[]"), []),
                "send_mode": env.get("SEND_MODE", "random"),
                "selected_preset_index": env.get("SELECTED_PRESET_INDEX", "0"),
                "hitokoto_types": _safe_json_loads(env.get("HITOKOTO_TYPES", "[]"), []),
                "match_mode": env.get("MATCH_MODE", "nickname"),
                "browser_timeout": env.get("BROWSER_TIMEOUT", "120000"),
                "friend_list_wait_time": env.get("FRIEND_LIST_WAIT_TIME", "2000"),
                "task_retry_times": env.get("TASK_RETRY_TIMES", "3"),
                "log_level": env.get("LOG_LEVEL", "INFO"),
                "friend_nicknames": read_nicknames(),
                "friend_remarks": read_remarks(),
                "friend_groups": _safe_json_loads(env.get("FRIEND_GROUPS", "{}"), {}),
                "friend_birthdays": _safe_json_loads(env.get("FRIEND_BIRTHDAYS", "{}"), {}),
                "ball_position": _safe_json_loads(env.get("BALL_POSITION", "{}"), {}),
            }
            return self._json(export_data)

        if path == "/api/stats":
            """获取发送统计数据"""
            stats_file = os.path.join(BASE_DIR, "data", "send_stats.json")
            stats = {}
            try:
                if os.path.exists(stats_file):
                    with open(stats_file, encoding="utf-8") as f:
                        stats = json.load(f)
            except Exception:
                stats = {}
            daily = stats.get("daily", {})
            today = time.strftime("%Y-%m-%d")
            today_stats = daily.get(today, {"sent": 0, "success": 0, "failed": 0})
            # 计算本周数据
            import datetime
            now = datetime.datetime.now()
            week_start = (now - datetime.timedelta(days=now.weekday())).strftime("%Y-%m-%d")
            week_sent = 0
            week_success = 0
            for date_str, d in daily.items():
                if date_str >= week_start:
                    week_sent += d.get("sent", 0)
                    week_success += d.get("success", 0)
            # 最近 7 天趋势
            trend = []
            for i in range(6, -1, -1):
                d = (now - datetime.timedelta(days=i)).strftime("%Y-%m-%d")
                day_data = daily.get(d, {"sent": 0, "success": 0})
                trend.append({"date": d, "sent": day_data.get("sent", 0), "success": day_data.get("success", 0)})
            # 好友发送排行
            friend_stats = stats.get("friend_stats", {})
            friend_ranking = sorted(
                [{"id": k, "name": v.get("name", k), "sent": v.get("sent", 0)} for k, v in friend_stats.items()],
                key=lambda x: x["sent"],
                reverse=True,
            )[:10]
            # 成就系统（基于统计数据解锁）
            achievements, unlocked_count = _calc_achievements(stats)
            return self._json({
                "today": today_stats,
                "week": {"sent": week_sent, "success": week_success},
                "total_sent": stats.get("total_sent", 0),
                "total_runs": stats.get("total_runs", 0),
                "trend": trend,
                "friend_ranking": friend_ranking,
                "achievements": achievements,
                "unlocked_count": unlocked_count,
            })

        if path == "/api/schedule":
            return self._json(schedule_status())

        # 火花监控 API
        if path == "/api/spark/status":
            """获取缓存的火花状态"""
            try:
                from core.spark_monitor import load_spark_cache
                cache = load_spark_cache()
                return self._json({
                    "ok": True,
                    "friends": cache.get("friends", {}),
                    "last_update": cache.get("last_update"),
                    "username": cache.get("username"),
                })
            except Exception as e:
                return self._json({"ok": False, "msg": str(e)}, 500)

        if path == "/api/spark/warnings":
            """获取火花预警列表（火花天数 <= 3 天）"""
            try:
                from core.spark_monitor import get_spark_warnings
                result = get_spark_warnings()
                return self._json({"ok": True, **result})
            except Exception as e:
                return self._json({"ok": False, "msg": str(e)}, 500)

        if path == "/api/spark/progress":
            """获取火花监控刷新进度"""
            global _spark_monitor_progress
            progress = _spark_monitor_progress
            return self._json({
                "ok": True,
                "running": progress.get("running", False),
                "current": progress.get("current", 0),
                "total": progress.get("total", 0),
                "message": progress.get("message", ""),
                "result": progress.get("result"),
            })

        return self.send_error(404)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        body = self._read_body()

        # 检查请求体是否被拒绝
        if isinstance(body, dict) and body.get("_error"):
            return self._json({"ok": False, "msg": body["_error"]}, 413)

        if path == "/api/config":
            # 保存简单配置项
            if "message_template" in body:
                set_env_value("MESSAGE_TEMPLATE", body["message_template"])
            if "message_presets" in body:
                mp = body["message_presets"]
                if isinstance(mp, list):
                    set_env_value("MESSAGE_PRESETS",
                                  json.dumps(mp, ensure_ascii=False))
            if "send_mode" in body:
                sm = body["send_mode"]
                if sm in ("random", "fixed"):
                    set_env_value("SEND_MODE", sm)
            if "selected_preset_index" in body:
                idx = _safe_int(body["selected_preset_index"])
                set_env_value("SELECTED_PRESET_INDEX", str(idx))
            if "hitokoto_types" in body:
                ht = body["hitokoto_types"]
                if isinstance(ht, list):
                    set_env_value("HITOKOTO_TYPES",
                                  json.dumps(ht, ensure_ascii=False))
            if "match_mode" in body:
                mm = body["match_mode"]
                if mm in ("nickname", "short_id"):
                    set_env_value("MATCH_MODE", mm)
            if "browser_timeout" in body:
                set_env_value("BROWSER_TIMEOUT", str(_safe_int(body["browser_timeout"], 120000)))
            if "friend_list_wait_time" in body:
                set_env_value("FRIEND_LIST_WAIT_TIME",
                              str(_safe_int(body["friend_list_wait_time"], 2000)))
            if "task_retry_times" in body:
                set_env_value("TASK_RETRY_TIMES", str(_safe_int(body["task_retry_times"], 3)))
            if "log_level" in body:
                ll = body["log_level"]
                if ll in ("ERROR", "WARNING", "INFO", "DEBUG"):
                    set_env_value("LOG_LEVEL", ll)
            if "ai_dedup" in body:
                set_env_value("AI_DEDUP", "on" if body["ai_dedup"] == "on" else "off")
            if "min_interval" in body:
                set_env_value("MIN_INTERVAL", str(_safe_int(body["min_interval"], 3)))
            if "max_interval" in body:
                set_env_value("MAX_INTERVAL", str(_safe_int(body["max_interval"], 8)))
            if "daily_limit" in body:
                set_env_value("DAILY_LIMIT", str(_safe_int(body["daily_limit"], 0)))
            if "rate_limit" in body:
                set_env_value("RATE_LIMIT", "on" if body["rate_limit"] == "on" else "off")
            if "tasks" in body:
                tasks = body["tasks"]
                if isinstance(tasks, list):
                    write_tasks(tasks)
            # [修复 D3] ball_position 之前被后端静默忽略，现在写入 .env 的 BALL_POSITION（JSON 格式）
            if "ball_position" in body:
                bp = body["ball_position"]
                if isinstance(bp, dict):
                    set_env_value("BALL_POSITION", json.dumps(bp, ensure_ascii=False), quote="'")
                    os.environ["BALL_POSITION"] = json.dumps(bp, ensure_ascii=False)
            return self._json({"ok": True})

        if path == "/api/cookies":
            uid = (body.get("unique_id") or "").strip()
            cookies = body.get("cookies") or ""
            if not uid:
                return self._json({"ok": False, "msg": "缺少 unique_id"}, 400)
            if not cookies.strip():
                return self._json({"ok": False, "msg": "cookies 为空"}, 400)
            # 校验是否为合法 JSON（允许外层已有单引号）
            raw = cookies.strip()
            if raw.startswith("'") and raw.endswith("'"):
                raw = raw[1:-1]
            try:
                arr = json.loads(raw)
                if not isinstance(arr, list):
                    raise ValueError
            except Exception:
                return self._json({"ok": False, "msg": "cookies 不是合法 JSON 数组"}, 400)
            # ensure_ascii=True：纯 ASCII 写入，规避 config.py unicode_escape 解码对非 ASCII 的破坏
            set_env_value(f"COOKIES_{uid.upper()}", json.dumps(arr, ensure_ascii=True), quote="'")
            # ---- 账号切换与干净清理 ----
            # 若保存的 uid 不是现有账号 → 切换账号：更新/新增账号身份
            tasks = read_tasks()
            uid_upper = uid.upper()
            exists = any((t.get("unique_id") or "").upper() == uid_upper for t in tasks)
            if not exists:
                if len(tasks) == 1:
                    # 单账号主导：把唯一账号切换成新账号（清空旧好友列表，因为新账号好友不同）
                    tasks[0]["unique_id"] = uid
                    tasks[0]["username"] = uid
                    tasks[0]["targets"] = []
                else:
                    tasks.append({"username": uid, "unique_id": uid, "targets": []})
                write_tasks(tasks)
                # 异账号切换：清空好友衍生数据（昵称/备注/分组/生日），因为是新账号
                for key in ["FRIEND_NICKNAMES", "FRIEND_REMARKS", "FRIEND_GROUPS", "FRIEND_BIRTHDAYS"]:
                    set_env_value(key, "{}", quote="'")
                    os.environ[key] = "{}"
            # 干净清理：删除其他所有账号的 COOKIES_*，确保不出现多账号共存
            env_now = parse_env()
            for k in list(env_now.keys()):
                if k.startswith("COOKIES_") and k != f"COOKIES_{uid_upper}":
                    del_env_value(k)
            return self._json({"ok": True, "count": len(arr), "switched": not exists, "account": uid})

        if path == "/api/cookies/logout":
            """退出登录：删除指定账号的 Cookie"""
            uid = (body.get("unique_id") or "").strip()
            if not uid:
                return self._json({"ok": False, "msg": "缺少 unique_id"}, 400)
            del_env_value(f"COOKIES_{uid.upper()}")
            return self._json({"ok": True, "account": uid})

        if path == "/api/cookies/check":
            """检测 Cookie 是否有效（轻量级检测，基于页面重定向和内容分析）"""
            try:
                import requests
                import re
                env = parse_env()
                tasks = read_tasks()

                # 找到有 Cookie 的账号
                current_user = None
                for t in tasks:
                    uid = (t.get("unique_id") or "").upper()
                    ck_raw = env.get(f"COOKIES_{uid}", "")
                    if ck_raw:
                        current_user = t
                        break

                if not current_user:
                    return self._json({
                        "ok": True,
                        "valid": False,
                        "reason": "未配置 Cookie",
                        "account": None,
                    })

                uid = (current_user.get("unique_id") or "").upper()
                ck_raw = env.get(f"COOKIES_{uid}", "")

                # 解析 Cookie
                try:
                    cookies_list = json.loads(ck_raw)
                except Exception:
                    return self._json({
                        "ok": True,
                        "valid": False,
                        "reason": "Cookie 格式错误",
                        "account": current_user.get("username", ""),
                    })

                # 转换为 requests 可用的 cookie 字典
                cookie_dict = {}
                for c in cookies_list:
                    if isinstance(c, dict) and "name" in c and "value" in c:
                        cookie_dict[c["name"]] = c["value"]

                # 检查关键 Cookie 字段
                has_session = "sessionid" in cookie_dict
                has_ttwid = "ttwid" in cookie_dict
                has_passport = "passport_csrf_token" in cookie_dict

                # 基础检查：如果没有 sessionid，肯定过期了
                if not has_session:
                    return self._json({
                        "ok": True,
                        "valid": False,
                        "reason": "缺少 sessionid，Cookie 已过期",
                        "account": current_user.get("username", ""),
                        "checks": {"sessionid": has_session, "ttwid": has_ttwid, "passport_csrf": has_passport},
                        "confidence": "high",
                    })

                # 使用 requests 访问抖音首页，检查是否被重定向到登录页
                try:
                    headers = {
                        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
                        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
                        "Referer": "https://www.douyin.com/",
                    }

                    # 访问抖音首页，不允许重定向
                    resp = requests.get(
                        "https://www.douyin.com/",
                        cookies=cookie_dict,
                        headers=headers,
                        timeout=15,
                        allow_redirects=False,
                    )

                    # 情况1：302 重定向到登录页 = Cookie 过期
                    if resp.status_code == 302:
                        location = resp.headers.get("Location", "")
                        if "login" in location.lower() or "passport" in location.lower():
                            return self._json({
                                "ok": True,
                                "valid": False,
                                "reason": "Cookie 已过期（被重定向到登录页）",
                                "account": current_user.get("username", ""),
                                "checks": {"sessionid": has_session, "ttwid": has_ttwid, "passport_csrf": has_passport},
                                "confidence": "high",
                            })

                    # 情况2：200 正常返回，分析页面内容
                    if resp.status_code == 200:
                        html = resp.text

                        # 检查页面是否包含登录相关的元素（未登录状态）
                        login_indicators = [
                            'id="login-pannel"',
                            'class="login-panel"',
                            'data-e2e="login-panel"',
                            '立即登录',
                            '登录后查看',
                            '扫码登录',
                            '验证码登录',
                        ]
                        has_login_indicator = any(ind in html for ind in login_indicators)

                        # 检查页面是否包含已登录的特征（用户昵称、头像等）
                        logged_in_indicators = [
                            'data-e2e="user-info"',
                            'class="user-info"',
                            '个人主页',
                            '创作者中心',
                            '我的作品',
                        ]
                        has_logged_in_indicator = any(ind in html for ind in logged_in_indicators)

                        # 如果有明确的登录元素，且没有已登录特征 = Cookie 过期
                        if has_login_indicator and not has_logged_in_indicator:
                            return self._json({
                                "ok": True,
                                "valid": False,
                                "reason": "Cookie 已过期（页面显示登录界面）",
                                "account": current_user.get("username", ""),
                                "checks": {"sessionid": has_session, "ttwid": has_ttwid, "passport_csrf": has_passport},
                                "confidence": "medium",
                            })

                        # 如果有已登录特征 = Cookie 有效
                        if has_logged_in_indicator:
                            return self._json({
                                "ok": True,
                                "valid": True,
                                "reason": "Cookie 有效（页面检测到已登录状态）",
                                "account": current_user.get("username", ""),
                                "checks": {"sessionid": has_session, "ttwid": has_ttwid, "passport_csrf": has_passport},
                                "confidence": "high",
                            })

                        # 无法确定（页面内容不明确），保守认为有效
                        return self._json({
                            "ok": True,
                            "valid": True,
                            "reason": "Cookie 存在，基础检查通过（页面内容无法完全确认，建议实际发送测试）",
                            "account": current_user.get("username", ""),
                            "checks": {"sessionid": has_session, "ttwid": has_ttwid, "passport_csrf": has_passport},
                            "confidence": "low",
                        })

                    # 其他状态码，保守认为有效
                    return self._json({
                        "ok": True,
                        "valid": True,
                        "reason": f"Cookie 存在，基础检查通过（HTTP {resp.status_code}，无法完全确认）",
                        "account": current_user.get("username", ""),
                        "checks": {"sessionid": has_session, "ttwid": has_ttwid, "passport_csrf": has_passport},
                        "confidence": "low",
                    })

                except requests.exceptions.RequestException as e:
                    # 网络错误，无法检测，保守认为 Cookie 存在且可能有效
                    return self._json({
                        "ok": True,
                        "valid": True,
                        "reason": f"网络错误，无法检测（{str(e)[:50]}），Cookie 存在，基础检查通过",
                        "account": current_user.get("username", ""),
                        "checks": {"sessionid": has_session, "ttwid": has_ttwid, "passport_csrf": has_passport},
                        "confidence": "low",
                    })

            except Exception as e:
                return self._json({"ok": False, "msg": f"检测失败: {str(e)}"}, 500)

        if path == "/api/account/clear":
            """一键清除登录信息：删除所有 Cookie + 清空好友/昵称/备注/分组/生日/消息预设/日志
            保留账号身份（unique_id/username），连接自动断开。"""
            import shutil
            import glob
            cleared = []
            # 1. 删除所有 COOKIES_*（断开连接）
            env_now = parse_env()
            for k in list(env_now.keys()):
                if k.startswith("COOKIES_"):
                    del_env_value(k)
                    cleared.append("Cookie")
            # 2. 清空所有账号的好友列表（保留账号身份）
            tasks = read_tasks()
            for t in tasks:
                if t.get("targets"):
                    t["targets"] = []
                    cleared.append("好友列表")
            write_tasks(tasks)
            # 3. 清空好友衍生数据
            for key in ["FRIEND_NICKNAMES", "FRIEND_REMARKS", "FRIEND_GROUPS", "FRIEND_BIRTHDAYS"]:
                if parse_env().get(key):
                    set_env_value(key, "{}", quote="'")
                    os.environ[key] = "{}"
                    cleared.append(key.replace("FRIEND_", ""))
            # 4. 清空消息预设/模板
            for key, default in [("MESSAGE_PRESETS", "[]"), ("MESSAGE_TEMPLATE", "")]:
                if parse_env().get(key):
                    set_env_value(key, default, quote="'")
                    os.environ[key] = default
                    cleared.append(key.replace("MESSAGE_", ""))
            # 5. 清空日志
            log_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "logs")
            if os.path.isdir(log_dir):
                for f in glob.glob(os.path.join(log_dir, "*")):
                    try:
                        if os.path.isfile(f):
                            os.remove(f)
                        elif os.path.isdir(f):
                            shutil.rmtree(f)
                    except Exception:
                        pass
                cleared.append("日志")
            return self._json({"ok": True, "msg": "登录信息已全部清除，连接已断开", "cleared": list(set(cleared))})

        if path == "/api/run":
            dryrun = bool(body.get("dryrun"))
            return self._json(start_run(dryrun=dryrun))

        if path == "/api/run/stop":
            return self._json(stop_run())

        if path == "/api/logs/clear":
            """清空所有日志文件（保留目录）"""
            import glob
            cleared = 0
            if os.path.isdir(LOGS_DIR):
                for f in glob.glob(os.path.join(LOGS_DIR, "*.log")):
                    try:
                        os.remove(f)
                        cleared += 1
                    except Exception:
                        pass
            return self._json({"ok": True, "cleared": cleared, "msg": f"已清空 {cleared} 个日志文件"})

        if path == "/api/restart":
            target = body.get("target", "backend")
            if target == "frontend":
                return self._json({"ok": True, "msg": "前端即将刷新"})
            if target == "backend":
                # 先发响应，再重启后端进程
                self._json({"ok": True, "msg": "后端即将重启，页面将自动刷新"})
                import threading
                def _do_restart():
                    import time; time.sleep(0.5)
                    # [修复] 重启前先终止运行中的任务子进程，防止其变为孤儿进程
                    # （任务子进程用 start_new_session=True 启动在独立进程组，os.execv 不会杀死它）
                    with _run_lock:
                        proc = _run["proc"]
                        if proc is not None and proc.poll() is None:
                            try:
                                pgid = os.getpgid(proc.pid)
                                os.killpg(pgid, signal.SIGTERM)
                                proc.wait(timeout=5)
                            except Exception:
                                try:
                                    proc.kill()
                                    proc.wait(timeout=3)
                                except Exception:
                                    pass
                    os.execv(sys.executable, [sys.executable] + sys.argv)
                threading.Thread(target=_do_restart, daemon=True).start()
                return
            return self._json({"ok": False, "msg": "未知 target"}, 400)

        if path == "/api/schedule":
            action = body.get("action")
            if action == "enable":
                return self._json(schedule_enable())
            if action == "disable":
                return self._json(schedule_disable())
            return self._json({"ok": False, "msg": "未知 action"}, 400)

        if path == "/api/schedule/time":
            hour = body.get("hour")
            minute = body.get("minute")
            if hour is None or minute is None:
                return self._json({"ok": False, "msg": "缺少 hour/minute"}, 400)
            return self._json(schedule_set_time(hour, minute))

        if path == "/api/schedule/times":
            times = body.get("times")
            if not isinstance(times, list):
                return self._json({"ok": False, "msg": "缺少 times 数组"}, 400)
            return self._json(schedule_set_times(times))

        if path == "/api/friend/nickname":
            """保存单个好友昵称 {unique_id, nickname}"""
            uid = (body.get("unique_id") or "").strip()
            nickname = (body.get("nickname") or "").strip()
            if not uid:
                return self._json({"ok": False, "msg": "缺少 unique_id"}, 400)
            m = update_nickname(uid, nickname)
            return self._json({"ok": True, "nickname": m.get(uid), "friend_nicknames": m})

        if path == "/api/msg/preview":
            """预览消息变量替换效果 {content, unique_id}"""
            content = (body.get("content") or "").strip()
            uid = (body.get("unique_id") or "").strip()
            try:
                from core.msg_builder import preview_message
                result = preview_message(content, uid or None)
                return self._json({"ok": True, "preview": result})
            except Exception as e:
                return self._json({"ok": False, "msg": f"预览失败: {e}"}, 500)

        if path == "/api/ai/config":
            """保存 AI 配置到 .env（POST），前端可直接操作，无需改文件"""
            api_key = (body.get("api_key") or "").strip()
            model = (body.get("model") or "").strip() or "MiniMax-M2.7"
            base_url = (body.get("base_url") or "").strip()
            provider = (body.get("provider") or "").strip()
            saved = []
            # 保存到 .env（原子写入），并同步到当前进程环境变量
            if "api_key" in body:
                if api_key:
                    set_env_value("OPENAI_API_KEY", api_key, quote="'")
                    os.environ["OPENAI_API_KEY"] = api_key
                    saved.append("API Key")
                else:
                    # 用户清空 Key 保存 = 清除已配置的 Key（恢复未配置状态）
                    try:
                        set_env_value("OPENAI_API_KEY", "", quote="'")
                    except Exception:
                        pass
                    os.environ.pop("OPENAI_API_KEY", None)
                    saved.append("清除 API Key")
            set_env_value("OPENAI_MODEL", model, quote="'")
            os.environ["OPENAI_MODEL"] = model
            saved.append("模型")
            if provider:
                set_env_value("OPENAI_PROVIDER", provider, quote="'")
                os.environ["OPENAI_PROVIDER"] = provider
                saved.append("提供商")
            if base_url:
                set_env_value("OPENAI_BASE_URL", base_url, quote="'")
                os.environ["OPENAI_BASE_URL"] = base_url
                saved.append("接口地址")
            else:
                # 清除已保存的 base_url（若之前设过）
                try:
                    set_env_value("OPENAI_BASE_URL", "", quote="'")
                except Exception:
                    pass
                os.environ.pop("OPENAI_BASE_URL", None)
            return self._json({"ok": True, "msg": f"已保存：{', '.join(saved)}", "saved": saved})

        if path == "/api/ai/features":
            """AI 功能配置保存（v27）：个性化消息 / 安全保护 / 平台深度集成开关"""
            saved = []
            for key, val in (body or {}).items():
                if key in AI_FEATURES:
                    env_key, _default = AI_FEATURES[key]
                    set_env_value(env_key, str(val), quote="'")
                    os.environ[env_key] = str(val)
                    saved.append(env_key)
                elif key == "friend_groups" and isinstance(val, dict):
                    set_env_value("FRIEND_GROUPS", json.dumps(val, ensure_ascii=False), quote="'")
                    os.environ["FRIEND_GROUPS"] = json.dumps(val, ensure_ascii=False)
                    saved.append("好友分组")
                elif key == "friend_birthdays" and isinstance(val, dict):
                    set_env_value("FRIEND_BIRTHDAYS", json.dumps(val, ensure_ascii=False), quote="'")
                    os.environ["FRIEND_BIRTHDAYS"] = json.dumps(val, ensure_ascii=False)
                    saved.append("好友生日")
                elif key == "custom_festivals" and isinstance(val, dict):
                    set_env_value("CUSTOM_FESTIVALS", json.dumps(val, ensure_ascii=False), quote="'")
                    os.environ["CUSTOM_FESTIVALS"] = json.dumps(val, ensure_ascii=False)
                    saved.append("自定义节日")
            return self._json({"ok": True, "msg": f"已保存：{', '.join(saved) or '无变更'}"})

        if path == "/api/ai/usage/reset":
            """清零今日 AI Token 用量"""
            from utils.ai_usage import reset_usage
            reset_usage()
            return self._json({"ok": True, "msg": "今日用量已清零"})

        if path == "/api/ai/test":
            """测试 AI 连接与 Key 有效性（发一个最小请求）"""
            test_key = (body.get("api_key") or "").strip()
            api_key = test_key or os.getenv("OPENAI_API_KEY", "")
            if not api_key:
                return self._json({"ok": False, "msg": "尚未配置 API Key"})
            try:
                from openai import OpenAI
                from utils.config import get_config
                model = os.getenv("OPENAI_MODEL", "") or get_config().get("openai", {}).get("model", "") or "MiniMax-M2.7"
                base_url = os.getenv("OPENAI_BASE_URL", "") or None
                client = OpenAI(api_key=api_key, base_url=base_url) if base_url else OpenAI(api_key=api_key)
                resp = client.chat.completions.create(
                    model=model,
                    messages=[{"role": "user", "content": "回复：OK"}],
                    max_tokens=10,
                )
                text = (resp.choices[0].message.content or "").strip()
                return self._json({"ok": True, "msg": "连接成功", "model": model, "reply": text})
            except Exception as e:
                return self._json({"ok": False, "msg": f"连接失败: {e}"})

        if path == "/api/msg/ai":
            """AI 生成文案。支持 {scenario, prompt, model}：
               scenario: spark续火花 / hello打招呼 / festival节日 / praise夸夸 / care关心 / custom自定义"""
            # 检查是否配置了 key（环境变量或 config）
            has_key = bool((os.getenv("OPENAI_API_KEY") or "").strip())
            if not has_key:
                try:
                    from utils.config import get_config
                    ocfg = get_config().get("openai", {})
                    has_key = bool((ocfg.get("api_key") or "").strip())
                except Exception:
                    pass
            if not has_key:
                return self._json({
                    "ok": False,
                    "msg": "尚未配置 AI。请到「AI 智能」页填写 API Key 后使用（也可在 .env 配置 OPENAI_API_KEY）。",
                    "need_config": True,
                })
            scenario = (body.get("scenario") or "spark").strip()
            prompt = (body.get("prompt") or "").strip()
            model = (body.get("model") or "").strip()
            try:
                from core.msg_builder import generate_ai_message
                content = generate_ai_message(scenario=scenario, prompt=prompt, model=model)
                return self._json({"ok": True, "content": content.strip()})
            except Exception as e:
                return self._json({"ok": False, "msg": f"AI 生成失败: {e}"}, 500)

        if path == "/api/friend/remark":
            """保存单个好友备注 {unique_id, remark}，remark 为空则删除"""
            uid = (body.get("unique_id") or "").strip()
            remark = (body.get("remark") or "").strip()
            if not uid:
                return self._json({"ok": False, "msg": "缺少 unique_id"}, 400)
            m = update_remark(uid, remark)
            return self._json({"ok": True, "remark": m.get(uid, ""), "friend_remarks": m})

        if path == "/api/friend/resolve":
            """实时查询抖音号昵称（启动浏览器子进程），超时 60 秒"""
            uid = (body.get("unique_id") or "").strip()
            if not uid:
                return self._json({"ok": False, "msg": "缺少 unique_id"}, 400)
            # 如果已有昵称，直接返回
            existing = read_nicknames().get(uid)
            if existing and not body.get("force"):
                return self._json({"ok": True, "unique_id": uid, "nickname": existing, "cached": True})
            result = resolve_nickname_sync(uid, timeout=60)
            return self._json(result)

        if path == "/api/config/import":
            """导入配置 JSON（不含 cookies，保护隐私）。mode=merge 合并（默认），mode=replace 替换"""
            data = body.get("config") or body
            if not isinstance(data, dict):
                return self._json({"ok": False, "msg": "配置格式错误，应为 JSON 对象"}, 400)
            mode = body.get("mode", "merge") if isinstance(body, dict) else "merge"
            imported = []
            try:
                if "tasks" in data and isinstance(data["tasks"], list):
                    if mode == "replace":
                        write_tasks(data["tasks"])
                    else:
                        # 合并：保留已有账号，追加新账号（按 unique_id 去重）
                        existing = read_tasks()
                        existing_ids = {t.get("unique_id") for t in existing if t.get("unique_id")}
                        for t in data["tasks"]:
                            if isinstance(t, dict) and t.get("unique_id") and t["unique_id"] not in existing_ids:
                                existing.append(t)
                                existing_ids.add(t["unique_id"])
                        write_tasks(existing)
                    imported.append("tasks")
                if "message_template" in data:
                    set_env_value("MESSAGE_TEMPLATE", str(data["message_template"]))
                    imported.append("message_template")
                if "message_presets" in data and isinstance(data["message_presets"], list):
                    set_env_value("MESSAGE_PRESETS", json.dumps(data["message_presets"], ensure_ascii=False))
                    imported.append("message_presets")
                if "send_mode" in data and data["send_mode"] in ("random", "fixed"):
                    set_env_value("SEND_MODE", data["send_mode"])
                    imported.append("send_mode")
                if "hitokoto_types" in data and isinstance(data["hitokoto_types"], list):
                    set_env_value("HITOKOTO_TYPES", json.dumps(data["hitokoto_types"], ensure_ascii=False))
                    imported.append("hitokoto_types")
                if "match_mode" in data and data["match_mode"] in ("nickname", "short_id"):
                    set_env_value("MATCH_MODE", data["match_mode"])
                    imported.append("match_mode")
                if "friend_nicknames" in data and isinstance(data["friend_nicknames"], dict):
                    if mode == "replace":
                        write_nicknames(data["friend_nicknames"])
                    else:
                        m = read_nicknames()
                        m.update(data["friend_nicknames"])
                        write_nicknames(m)
                    imported.append("friend_nicknames")
                if "friend_remarks" in data and isinstance(data["friend_remarks"], dict):
                    if mode == "replace":
                        write_remarks(data["friend_remarks"])
                    else:
                        m = read_remarks()
                        m.update(data["friend_remarks"])
                        write_remarks(m)
                    imported.append("friend_remarks")
                if "friend_groups" in data and isinstance(data["friend_groups"], dict):
                    if mode == "replace":
                        set_env_value("FRIEND_GROUPS", json.dumps(data["friend_groups"], ensure_ascii=False), quote="'")
                        os.environ["FRIEND_GROUPS"] = json.dumps(data["friend_groups"], ensure_ascii=False)
                    else:
                        m = _safe_json_loads(parse_env().get("FRIEND_GROUPS", "{}"), {})
                        m.update(data["friend_groups"])
                        set_env_value("FRIEND_GROUPS", json.dumps(m, ensure_ascii=False), quote="'")
                        os.environ["FRIEND_GROUPS"] = json.dumps(m, ensure_ascii=False)
                    imported.append("friend_groups")
                if "friend_birthdays" in data and isinstance(data["friend_birthdays"], dict):
                    if mode == "replace":
                        set_env_value("FRIEND_BIRTHDAYS", json.dumps(data["friend_birthdays"], ensure_ascii=False), quote="'")
                        os.environ["FRIEND_BIRTHDAYS"] = json.dumps(data["friend_birthdays"], ensure_ascii=False)
                    else:
                        m = _safe_json_loads(parse_env().get("FRIEND_BIRTHDAYS", "{}"), {})
                        m.update(data["friend_birthdays"])
                        set_env_value("FRIEND_BIRTHDAYS", json.dumps(m, ensure_ascii=False), quote="'")
                        os.environ["FRIEND_BIRTHDAYS"] = json.dumps(m, ensure_ascii=False)
                    imported.append("friend_birthdays")
                return self._json({"ok": True, "imported": imported, "mode": mode})
            except Exception as e:
                return self._json({"ok": False, "msg": f"导入失败: {e}"}, 500)

        # 火花监控刷新 API
        if path == "/api/spark/refresh":
            """触发火花状态刷新（异步执行）"""
            global _spark_monitor_progress

            if _spark_monitor_progress.get("running"):
                return self._json({
                    "ok": False,
                    "msg": "火花监控正在运行中，请稍候...",
                    "progress": _spark_monitor_progress,
                }, 409)

            # 获取当前登录账号的 Cookie 和好友列表
            env = parse_env()
            tasks = read_tasks()
            if not tasks:
                return self._json({"ok": False, "msg": "未配置账号，请先在设置页面配置 Cookie"}, 400)

            # 找到有 Cookie 的账号
            current_user = None
            for t in tasks:
                uid = (t.get("unique_id") or "").upper()
                ck_raw = env.get(f"COOKIES_{uid}", "")
                if ck_raw:
                    current_user = t
                    break

            if not current_user:
                return self._json({"ok": False, "msg": "未找到有效的登录账号，请先配置 Cookie"}, 400)

            # 解析 Cookie
            try:
                cookies = json.loads(env.get(f"COOKIES_{(current_user.get('unique_id') or '').upper()}", "[]"))
            except Exception:
                cookies = []

            if not cookies:
                return self._json({"ok": False, "msg": "Cookie 解析失败，请重新配置"}, 400)

            # 初始化进度
            _spark_monitor_progress = {
                "running": True,
                "current": 0,
                "total": 0,
                "message": "正在启动火花监控...",
                "result": None,
            }

            # 进度回调函数
            def progress_callback(current, total, message):
                _spark_monitor_progress["current"] = current
                _spark_monitor_progress["total"] = total
                _spark_monitor_progress["message"] = message

            # 异步执行火花监控
            def run_monitor():
                try:
                    from core.spark_monitor import monitor_spark_status
                    result = monitor_spark_status(
                        cookies=cookies,
                        username=current_user.get("username", "未知用户"),
                        targets=current_user.get("targets"),
                        progress_callback=progress_callback,
                    )
                    _spark_monitor_progress["result"] = result
                    _spark_monitor_progress["message"] = f"监控完成，共检查 {result.get('checked', 0)}/{result.get('total', 0)} 个好友"
                except Exception as e:
                    _spark_monitor_progress["result"] = {"error": str(e)}
                    _spark_monitor_progress["message"] = f"监控失败: {e}"
                finally:
                    _spark_monitor_progress["running"] = False

            thread = threading.Thread(target=run_monitor, daemon=True)
            thread.start()

            return self._json({
                "ok": True,
                "msg": "火花监控已启动，请通过 /api/spark/progress 查询进度",
                "progress": _spark_monitor_progress,
            })

        return self.send_error(404)

    def log_message(self, fmt, *args):
        # 输出到 stdout 方便调试
        try:
            print(f"[{self.address_string()}] {fmt % args}")
        except Exception:
            pass


def main():
    print(f"DouYinSparkFlow Web 控制台已启动")
    print(f"请在浏览器打开: http://{HOST}:{PORT}")

    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    srv.daemon_threads = True  # 守护线程，确保退出时不挂起

    # 注册信号处理：Ctrl+C 优雅退出
    def _shutdown(signum, frame):
        print("\n正在关闭服务器...")
        srv.shutdown()
    signal.signal(signal.SIGINT, _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)

    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()
        print("服务器已关闭。")


if __name__ == "__main__":
    main()
