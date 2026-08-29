"""
火花监控模块 - 准确获取每个好友的火花天数
通过 Playwright 进入好友私信界面，读取实际火花天数
"""
import os
import sys
import re
import time
import json
import traceback
from datetime import datetime, timedelta

# 确保能导入项目模块
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

from core.browser import get_browser
from utils.config import get_environment, Environment
from utils.logger import setup_logger

# 初始化日志记录器
logger = setup_logger(level="INFO")

# 火花状态缓存文件
SPARK_CACHE_FILE = os.path.join(BASE_DIR, "data", "spark_status.json")

# 火花天数选择器（多种尝试）
SPARK_DAY_SELECTORS = [
    "xpath=//div[contains(@class, 'spark-') and contains(text(), '天')]",
    "xpath=//span[contains(@class, 'spark-') and contains(text(), '天')]",
    "xpath=//div[contains(text(), '火花') and contains(text(), '天')]",
    "xpath=//span[contains(text(), '火花') and contains(text(), '天')]",
    "xpath=//div[contains(@class, 'chat-header')]//span[contains(text(), '天')]",
    "xpath=//div[contains(@class, 'conversation-header')]//span[contains(text(), '天')]",
]

# 好友列表项选择器
FRIEND_ITEM_SELECTORS = [
    "xpath=//div[contains(@class, 'conversation-item')]",
    "xpath=//div[contains(@class, 'chat-item')]",
    "xpath=//div[contains(@class, 'friend-item')]",
    "xpath=//li[contains(@class, 'conversation')]",
]


def ensure_data_dir():
    """确保 data 目录存在"""
    data_dir = os.path.join(BASE_DIR, "data")
    if not os.path.exists(data_dir):
        os.makedirs(data_dir)


def load_spark_cache():
    """加载火花状态缓存"""
    ensure_data_dir()
    if os.path.exists(SPARK_CACHE_FILE):
        try:
            with open(SPARK_CACHE_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception as e:
            logger.warning(f"加载火花缓存失败: {e}")
    return {"friends": {}, "last_update": None}


def save_spark_cache(data):
    """保存火花状态缓存
    [修复] 改为 tmp+rename 原子写入，防止进程中途崩溃导致文件截断损坏。"""
    ensure_data_dir()
    try:
        tmp_path = SPARK_CACHE_FILE + ".tmp"
        with open(tmp_path, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, SPARK_CACHE_FILE)
    except Exception as e:
        logger.warning(f"保存火花缓存失败: {e}")


def extract_spark_days(text):
    """从文本中提取火花天数"""
    if not text:
        return None
    # 匹配 "火花 30天"、"30天"、"火花30天" 等格式
    patterns = [
        r'火花\s*(\d+)\s*天',
        r'(\d+)\s*天\s*火花',
        r'火花.*?(\d+)\s*天',
        r'(\d+)\s*天',
    ]
    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            return int(match.group(1))
    return None


def get_spark_days_from_page(page):
    """从当前聊天页面获取火花天数"""
    for selector in SPARK_DAY_SELECTORS:
        try:
            elements = page.locator(selector)
            count = elements.count()
            if count > 0:
                for i in range(min(count, 5)):
                    try:
                        text = elements.nth(i).inner_text(timeout=2000)
                        days = extract_spark_days(text)
                        if days is not None:
                            logger.debug(f"从选择器 {selector} 获取到火花天数: {days}")
                            return days
                    except Exception:
                        continue
        except Exception:
            continue

    # 尝试从页面标题或头部获取
    try:
        title = page.title()
        days = extract_spark_days(title)
        if days is not None:
            return days
    except Exception:
        pass

    return None


def scroll_and_get_friends(page, max_friends=50):
    """滚动好友列表并获取所有好友"""
    friends = []
    seen_names = set()

    # 尝试多种好友列表项选择器
    friend_selector = None
    for selector in FRIEND_ITEM_SELECTORS:
        try:
            count = page.locator(selector).count()
            if count > 0:
                friend_selector = selector
                logger.debug(f"使用好友列表选择器: {selector}, 找到 {count} 个好友")
                break
        except Exception:
            continue

    if not friend_selector:
        logger.warning("未找到好友列表")
        return friends

    # 滚动加载更多好友
    for scroll_attempt in range(10):
        try:
            elements = page.locator(friend_selector)
            count = elements.count()

            for i in range(count):
                try:
                    elem = elements.nth(i)
                    text = elem.inner_text(timeout=1000)
                    if text and text not in seen_names:
                        seen_names.add(text)
                        friends.append({"name": text, "element": elem})
                except Exception:
                    continue

            if len(friends) >= max_friends:
                break

            # [修复] 抖音好友列表是内部可滚动容器，window.scrollTo 对 body 无效，
            # 必须定位滚动容器并修改其 scrollTop（参照 tasks.py scroll_and_select_user 的实现）
            try:
                scrollable = page.locator(
                    'xpath=//*[@id="sub-app"]/div/div[1]/div[2]/div[2]/div/div/div[3]/div/div/div/ul/div'
                ).element_handle()
                if scrollable:
                    scroll_top_before = page.evaluate("(el) => el.scrollTop", scrollable)
                    page.evaluate("(el) => el.scrollTop += 800", scrollable)
                    time.sleep(0.3)
                    scroll_top_after = page.evaluate("(el) => el.scrollTop", scrollable)
                    if scroll_top_before == scroll_top_after:
                        logger.debug("火花监控: scrollTop 未变化，可能已到底部")
                        break
                else:
                    logger.debug("火花监控: 未找到滚动容器，回退 window.scrollTo")
                    page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            except Exception as scroll_err:
                logger.debug(f"火花监控: 容器滚动失败，回退 window.scrollTo: {scroll_err}")
                page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            time.sleep(1)

        except Exception as e:
            logger.debug(f"滚动好友列表失败: {e}")
            break

    return friends


def monitor_spark_status(cookies, username, targets=None, progress_callback=None):
    """
    监控所有好友的火花状态

    Args:
        cookies: 登录 Cookie
        username: 登录用户名
        targets: 目标好友列表（如果为 None，则监控所有好友）
        progress_callback: 进度回调函数 callback(current, total, message)

    Returns:
        dict: 好友火花状态
    """
    result = {
        "friends": {},
        "total": 0,
        "checked": 0,
        "errors": [],
        "start_time": datetime.now().isoformat(),
    }

    playwright = None
    browser = None

    try:
        playwright, browser = get_browser()
        context = browser.new_context()
        context.set_default_navigation_timeout(30000)
        context.set_default_timeout(15000)

        page = context.new_page()

        # 注入 Cookie
        context.add_cookies(cookies)

        # 打开抖音创作者中心
        logger.info("正在打开抖音创作者中心...")
        if progress_callback:
            progress_callback(0, 0, "正在打开抖音创作者中心...")

        page.goto("https://creator.douyin.com/", wait_until="domcontentloaded")
        time.sleep(3)

        # 导航到消息页面
        logger.info("正在导航到消息页面...")
        if progress_callback:
            progress_callback(0, 0, "正在导航到消息页面...")

        page.goto("https://creator.douyin.com/creator-micro/data/following/chat", wait_until="domcontentloaded")
        time.sleep(3)

        # 获取好友列表
        logger.info("正在获取好友列表...")
        if progress_callback:
            progress_callback(0, 0, "正在获取好友列表...")

        friends = scroll_and_get_friends(page, max_friends=100)
        logger.info(f"找到 {len(friends)} 个好友")

        # 如果指定了目标好友，只监控目标好友
        if targets:
            friends = [f for f in friends if f["name"] in targets or any(t in f["name"] for t in targets)]

        result["total"] = len(friends)

        # 遍历好友，获取火花天数
        for idx, friend in enumerate(friends):
            friend_name = friend["name"]
            logger.info(f"正在检查好友 {idx + 1}/{len(friends)}: {friend_name}")

            if progress_callback:
                progress_callback(idx + 1, len(friends), f"正在检查好友: {friend_name}")

            try:
                # 点击好友进入聊天界面
                friend["element"].click()
                time.sleep(2)

                # 获取火花天数
                spark_days = get_spark_days_from_page(page)

                if spark_days is not None:
                    result["friends"][friend_name] = {
                        "spark_days": spark_days,
                        "status": "active" if spark_days > 0 else "none",
                        "warning": spark_days <= 3,
                        "last_check": datetime.now().isoformat(),
                    }
                    logger.info(f"好友 {friend_name} 火花天数: {spark_days}")
                else:
                    result["friends"][friend_name] = {
                        "spark_days": 0,
                        "status": "unknown",
                        "warning": False,
                        "last_check": datetime.now().isoformat(),
                        "note": "未检测到火花标识",
                    }
                    logger.info(f"好友 {friend_name} 未检测到火花标识")

                result["checked"] += 1

            except Exception as e:
                logger.error(f"检查好友 {friend_name} 失败: {e}")
                result["errors"].append({"friend": friend_name, "error": str(e)})
                result["friends"][friend_name] = {
                    "spark_days": 0,
                    "status": "error",
                    "warning": False,
                    "last_check": datetime.now().isoformat(),
                    "error": str(e),
                }

            # 限流：每个好友之间等待 1-2 秒
            time.sleep(1)

        # 保存缓存
        result["end_time"] = datetime.now().isoformat()
        result["duration_seconds"] = (datetime.fromisoformat(result["end_time"]) - datetime.fromisoformat(result["start_time"])).total_seconds()

        cache_data = load_spark_cache()
        cache_data["friends"] = result["friends"]
        cache_data["last_update"] = datetime.now().isoformat()
        cache_data["username"] = username
        save_spark_cache(cache_data)

        logger.info(f"火花监控完成，共检查 {result['checked']}/{result['total']} 个好友，{len(result['errors'])} 个错误")

    except Exception as e:
        logger.error(f"火花监控失败: {e}")
        traceback.print_exc()
        result["errors"].append({"friend": "system", "error": str(e)})
    finally:
        if browser:
            try:
                browser.close()
            except Exception:
                pass
        if playwright:
            try:
                playwright.stop()
            except Exception:
                pass

    return result


def get_spark_warnings():
    """获取需要关注的火花预警（火花天数 <= 3 天）"""
    cache = load_spark_cache()
    warnings = []

    for friend_name, info in cache.get("friends", {}).items():
        if info.get("warning") or (info.get("spark_days", 0) > 0 and info.get("spark_days", 0) <= 3):
            warnings.append({
                "name": friend_name,
                "spark_days": info.get("spark_days", 0),
                "status": info.get("status", "unknown"),
                "last_check": info.get("last_check", ""),
            })

    # 按火花天数升序排列（最少的在前面）
    warnings.sort(key=lambda x: x["spark_days"])

    return {
        "warnings": warnings,
        "total_friends": len(cache.get("friends", {})),
        "warning_count": len(warnings),
        "last_update": cache.get("last_update"),
    }


if __name__ == "__main__":
    # 测试运行
    from utils.config import config, userData

    if userData:
        user = userData[0]
        result = monitor_spark_status(
            cookies=user["cookies"],
            username=user.get("username", "未知用户"),
            targets=user.get("targets"),
        )
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print("未配置用户数据")
