"""
utils/ai_usage.py
AI Token 用量统计（Token 保护机制的数据基础）。
持久化到 data/ai_usage.json，按天记录。
"""
import json
import os
import datetime

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "data")
USAGE_FILE = os.path.join(DATA_DIR, "ai_usage.json")

_lock = __import__("threading").Lock()


def _load() -> dict:
    try:
        with open(USAGE_FILE, encoding="utf-8") as f:
            d = json.load(f)
        if isinstance(d, dict):
            return d
    except Exception:
        pass
    return {}


def _save(d: dict):
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(USAGE_FILE, "w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


def _today() -> str:
    return datetime.date.today().strftime("%Y-%m-%d")


def get_today_usage() -> int:
    """今日已用 Token 数"""
    with _lock:
        d = _load()
        return int(d.get("daily", {}).get(_today(), {}).get("tokens", 0) or 0)


def get_usage() -> dict:
    """返回用量结构：{date: {tokens, calls}}"""
    with _lock:
        return _load()


def record_tokens(n: int):
    """记录一次 AI 调用消耗的 Token 数（n 可含输入+输出估算）"""
    with _lock:
        d = _load()
        day = d.setdefault("daily", {}).setdefault(_today(), {"tokens": 0, "calls": 0})
        day["tokens"] = int(day.get("tokens", 0) or 0) + max(0, int(n or 0))
        day["calls"] = int(day.get("calls", 0) or 0) + 1
        # 只保留最近 30 天
        ds = d.get("daily", {})
        keys = sorted(ds.keys())[-30:]
        d["daily"] = {k: ds[k] for k in keys}
        _save(d)


def reset_usage():
    """清零今日用量"""
    with _lock:
        d = _load()
        d.setdefault("daily", {})[_today()] = {"tokens": 0, "calls": 0}
        _save(d)
