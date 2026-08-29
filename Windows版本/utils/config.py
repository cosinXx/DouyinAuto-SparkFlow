import os, sys
from enum import Enum
import json
import logging
from utils.logger import setup_logger

logger = setup_logger(level=logging.DEBUG)

"""
是否启用调试模式
更详细的日志打印，浏览器操作可视化等
"""
DEBUG = False
config = None
userData = None


class Environment(Enum):
    GITHUBACTION = "GITHUB_ACTION"  # GitHub Action 运行
    LOCAL = "LOCAL"  # 本地代码运行
    PACKED = "PACKED"  # PyInstaller 打包运行

    def __str__(self):
        return self.value


def get_environment():
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        return Environment.PACKED
    elif os.getenv("GITHUB_ACTIONS") == "true":
        return Environment.GITHUBACTION
    else:
        return Environment.LOCAL


def _safe_json(raw, default, name):
    """安全解析 JSON 字符串，失败时记录警告并返回默认值（防止 .env 手改坏导致整个程序崩溃）"""
    try:
        v = json.loads(raw)
        return v if isinstance(v, type(default)) else default
    except (json.JSONDecodeError, TypeError):
        logger.warning(f"环境变量 {name} 格式不正确，已回退默认值：{default!r}")
        return default


def get_config():
    """
    获取配置信息
    :return: 配置字典
    """
    global config

    if config:
        return config

    config = {
        "proxyAddress": os.getenv("PROXY_ADDRESS", ""),
        "messageTemplate": os.getenv("MESSAGE_TEMPLATE", "[盖瑞]今日火花[加一]\\n—— [右边] 每日一言 [左边] ——\\n[API]"),
        # 新：文字发送预设（多条文案），支持固定/随机发送
        "messagePresets": _safe_json(
            os.getenv("MESSAGE_PRESETS", '["[盖瑞]今日火花[加一]"]'), [], "MESSAGE_PRESETS"
        ),
        "sendMode": os.getenv("SEND_MODE", "random"),  # random=随机发一条 | fixed=固定发选中的那条
        "selectedPresetIndex": int(_safe_int(os.getenv("SELECTED_PRESET_INDEX", "0"), 0)),
        "hitokotoTypes": _safe_json(
            os.getenv("HITOKOTO_TYPES", '["文学","影视","诗词","哲学"]'),
            ["文学", "影视", "诗词", "哲学"], "HITOKOTO_TYPES"
        ),
        "matchMode": os.getenv("MATCH_MODE", "nickname"),  # 是否使用短 ID 进行好友匹配
        "browserTimeout": _safe_int(os.getenv("BROWSER_TIMEOUT", "120000"), 120000),  # 浏览器操作超时时间，单位毫秒
        "friendListTimeout": _safe_int(os.getenv("FRIEND_LIST_WAIT_TIME", "2000"), 2000),  # 好友列表加载超时时间，单位毫秒
        "taskRetryTimes": _safe_int(os.getenv("TASK_RETRY_TIMES", "3"), 3),  # 任务重试次数
        "logLevel": os.getenv("LOG_LEVEL", "DEBUG"),  # 日志级别
    }

    return config


def _safe_int(val, default):
    """安全解析整数，失败返回默认值"""
    try:
        return int(val)
    except (ValueError, TypeError):
        return default

def sanitize_cookies(cookies):
    """
    将 Cookie-Editor 导出的格式转换为 Playwright 能识别的格式。
    Cookie-Editor 导出格式 → Playwright add_cookies 期望格式：
      expirationDate (float秒)  → expires (float Unix秒)
      sameSite "no_restriction"/"lax"/"strict" → "None"/"Lax"/"Strict"
      删除 storeId / hostOnly 等 Playwright 不认识的字段
    """
    valid_samesite = {"Strict", "Lax", "None"}
    cleaned = []
    for cookie in cookies:
        # 只保留 Playwright 认识的字段
        pc = {
            "name": cookie.get("name"),
            "value": cookie.get("value"),
        }
        # domain / path / url
        if cookie.get("domain"):
            pc["domain"] = cookie["domain"]
        if cookie.get("path"):
            pc["path"] = cookie["path"]
        if cookie.get("url"):
            pc["url"] = cookie["url"]
        # 过期时间：expirationDate → expires（Playwright 用 expires）
        if cookie.get("expirationDate"):
            pc["expires"] = float(cookie["expirationDate"])
        elif cookie.get("expires"):
            pc["expires"] = float(cookie["expires"])
        # 布尔字段
        if "httpOnly" in cookie:
            pc["httpOnly"] = bool(cookie["httpOnly"])
        if "secure" in cookie:
            pc["secure"] = bool(cookie["secure"])
        # sameSite 转换：no_restriction → None 等
        ss = cookie.get("sameSite")
        if ss is not None:
            mapping = {
                "no_restriction": "None",
                "unspecified": "Lax",
                "lax": "Lax",
                "strict": "Strict",
                "none": "None",
                "None": "None",
                "Lax": "Lax",
                "Strict": "Strict",
            }
            converted = mapping.get(str(ss))
            if converted and converted in valid_samesite:
                pc["sameSite"] = converted
        # 跳过没有 name/value 的无效 cookie
        if pc.get("name") and pc.get("value") is not None:
            cleaned.append(pc)
    return cleaned


def get_userData():
    """
    获取用户数据目录
    :return: 用户数据目录路径
    """
    global userData

    if userData:
        return userData

    tasks = _safe_json(os.getenv("TASKS", "[]"), [], "TASKS")

    userData = []

    for task in tasks:
        username = task.get("username", "未知用户")
        unique_id = task.get("unique_id")
        if not unique_id:
            logger.warning(f"{username} 的任务  缺少 unique_id 字段，已跳过")
            continue
        cookies_key = f"cookies_{unique_id}".upper()
        cookies_raw = os.getenv(cookies_key, "")
        # 兼容历史格式：值可能含 \xNN 转义序列（unicode_escape 解码）
        # 注意：仅在值为纯 ASCII 时使用 unicode_escape，避免破坏 UTF-8 中文
        try:
            if cookies_raw and cookies_raw.isascii():
                cookies_str = cookies_raw.encode("utf-8").decode("unicode_escape")
            else:
                cookies_str = cookies_raw
        except UnicodeDecodeError:
            cookies_str = cookies_raw
        if not cookies_str:
            logger.warning(
                f"{username} 的任务 缺少 {cookies_key} 环境变量，已跳过"
            )
            continue
        try:
            cookies = json.loads(cookies_str)
        except json.JSONDecodeError:
            logger.warning(f"{username} 的任务 {cookies_key} 格式不正确，已跳过")
            continue

        userData.append(
            {
                "unique_id": unique_id,
                "username": username,
                "cookies": sanitize_cookies(cookies),
                "targets": task.get("targets", []),
            }
        )

    return userData
