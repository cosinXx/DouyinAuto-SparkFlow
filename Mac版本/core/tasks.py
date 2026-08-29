import traceback
import os
import re
import subprocess
import sys
from utils.logger import setup_logger
from utils.config import get_config, get_userData
from core.msg_builder import build_message, build_message_with_openai
from core.browser import get_browser
from playwright.sync_api import Response
import time
import json
import random


config = get_config()
userData = get_userData()
logger = setup_logger(level=config.get("logLevel", "Info"))
matchMode = config.get("matchMode", "nickname")
# 测试运行模式：DRYRUN=1 时只查找好友、不发消息（由 Web 控制台的「测试运行」按钮触发）
DRYRUN = os.getenv("DRYRUN", "0") == "1"
# 仅解析昵称模式：RESOLVE_ONLY=1 时只查询指定抖音号的昵称，不发消息
RESOLVE_ONLY = os.getenv("RESOLVE_ONLY", "0") == "1"
RESOLVE_TARGET = os.getenv("RESOLVE_TARGET", "").strip()

# 昵称缓存：任务执行过程中收集到的 {抖音号: 昵称}，结束时批量写入 .env
_nickname_cache = {}
_nickname_cache_lock = False  # 简单标志，防止重入


def _flush_nicknames_to_env():
    """将 _nickname_cache 中的昵称批量写入 .env 的 FRIEND_NICKNAMES 字段。
    [修复] 只读取一次 .env 文件，在同一次读取中既解析现有映射又保留所有行，
    避免两次读取之间的 TOCTOU 竞态（server.py 并发修改 .env 导致数据丢失）。"""
    global _nickname_cache, _nickname_cache_lock
    if _nickname_cache_lock or not _nickname_cache:
        return
    _nickname_cache_lock = True
    try:
        env_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")
        # [修复] 一次性读取所有行，后续解析和写回都基于这同一份 lines
        try:
            with open(env_path, encoding="utf-8") as f:
                lines = f.read().splitlines()
        except FileNotFoundError:
            lines = []

        # 从已读取的 lines 中解析现有 FRIEND_NICKNAMES 映射
        existing = {}
        for line in lines:
            s = line.strip()
            if s.startswith("FRIEND_NICKNAMES="):
                raw = s[len("FRIEND_NICKNAMES="):].strip()
                if raw.startswith("'") and raw.endswith("'"):
                    raw = raw[1:-1]
                try:
                    existing = json.loads(raw)
                    if not isinstance(existing, dict):
                        existing = {}
                except Exception:
                    existing = {}
                break

        # 合并新昵称
        changed = False
        for uid, nick in _nickname_cache.items():
            if existing.get(uid) != nick:
                existing[uid] = nick
                changed = True
        if not changed:
            return

        # 基于同一份 lines 做行级替换
        new_lines = []
        found = False
        value = json.dumps(existing, ensure_ascii=False)
        for line in lines:
            if line.strip().startswith("FRIEND_NICKNAMES="):
                new_lines.append(f"FRIEND_NICKNAMES='{value}'")
                found = True
            else:
                new_lines.append(line)
        if not found:
            new_lines.append(f"FRIEND_NICKNAMES='{value}'")

        # 原子写入
        tmp_path = env_path + ".tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            f.write("\n".join(new_lines) + "\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, env_path)
        logger.debug(f"已将 {len(_nickname_cache)} 个昵称写入 .env")
        _nickname_cache.clear()
    except Exception as e:
        logger.warning(f"写入昵称映射失败: {e}")
    finally:
        _nickname_cache_lock = False


def send_desktop_notification(title: str, message: str, sound: bool = True):
    """
    发送 macOS 桌面通知。仅在 macOS 上生效，其他系统静默忽略。
    """
    if sys.platform != "darwin":
        return
    # 检查是否启用了桌面通知（默认启用）
    if os.getenv("DESKTOP_NOTIFICATIONS", "1") != "1":
        return
    try:
        sound_arg = f' sound name "Glass"' if sound else ""
        script = f'display notification "{message}" with title "{title}"{sound_arg}'
        subprocess.Popen(
            ["osascript", "-e", script],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception as e:
        logger.debug(f"发送桌面通知失败: {e}")


# ============================================================
# 发送统计
# ============================================================
STATS_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "send_stats.json")


def _ensure_stats_dir():
    """确保统计文件目录存在"""
    stats_dir = os.path.dirname(STATS_FILE)
    os.makedirs(stats_dir, exist_ok=True)


def _load_stats() -> dict:
    """加载统计数据"""
    try:
        if os.path.exists(STATS_FILE):
            with open(STATS_FILE, encoding="utf-8") as f:
                return json.load(f)
    except Exception:
        pass
    return {"daily": {}, "total_sent": 0, "total_runs": 0, "friend_stats": {}}


def _save_stats(stats: dict):
    """保存统计数据"""
    try:
        _ensure_stats_dir()
        tmp_path = STATS_FILE + ".tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(stats, f, ensure_ascii=False, indent=2)
        os.replace(tmp_path, STATS_FILE)
    except Exception as e:
        logger.debug(f"保存统计数据失败: {e}")


# ============================================================
# v27：限流保护 / 每日发送上限 / 消息去重
# ============================================================
MEMORY_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "sent_memory.json")


def _feat_flag(key: str) -> bool:
    """读取 .env 功能开关（main.py 已 load_dotenv）"""
    return (os.getenv(key, "0") or "").strip().lower() in ("1", "true", "yes", "on")


def _feat_int(key: str, default: int) -> int:
    try:
        return int(float(os.getenv(key, "") or default))
    except (TypeError, ValueError):
        return default


def rate_limit_sleep():
    """限流保护：每条消息之间随机延迟（模拟真人节奏，降低被识别为 AI 的风险）"""
    if not _feat_flag("SAFE_RATE"):
        return
    lo = max(0, _feat_int("RATE_MIN", 3))
    hi = max(lo, _feat_int("RATE_MAX", 8))
    delay = random.uniform(lo, hi)
    logger.debug(f"[限流] 下一条消息随机等待 {delay:.1f}s")
    time.sleep(delay)


def daily_limit_reached() -> bool:
    """每日发送上限检查（DAILY_SEND_LIMIT>0 时启用），达到上限返回 True。"""
    limit = _feat_int("DAILY_SEND_LIMIT", 0)
    if limit <= 0:
        return False
    try:
        stats = _load_stats()
        today = time.strftime("%Y-%m-%d")
        sent = stats.get("daily", {}).get(today, {}).get("sent", 0)
        return sent >= limit
    except Exception:
        return False


def _load_memory() -> dict:
    try:
        if os.path.exists(MEMORY_FILE):
            with open(MEMORY_FILE, encoding="utf-8") as f:
                return json.load(f)
    except Exception:
        pass
    return {}


def _save_memory(m: dict):
    try:
        _ensure_stats_dir()
        tmp_path = MEMORY_FILE + ".tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(m, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, MEMORY_FILE)
    except Exception:
        pass


def is_duplicate(friend_key: str, content: str) -> bool:
    """消息去重：同一好友近期是否发过同样内容"""
    if not content:
        return False
    m = _load_memory()
    return content.strip() in m.get(friend_key, [])


def remember_sent(friend_key: str, content: str):
    """记录已发内容（去重记忆，每好友保留最近 20 条）"""
    if not content:
        return
    try:
        m = _load_memory()
        lst = m.get(friend_key, [])
        lst.insert(0, content.strip())
        m[friend_key] = lst[:20]
        _save_memory(m)
    except Exception:
        pass


def record_send(friend_id: str, friend_name: str = "", success: bool = True):
    """记录一次发送统计"""
    try:
        stats = _load_stats()
        today = time.strftime("%Y-%m-%d")
        # 每日统计
        if today not in stats["daily"]:
            stats["daily"][today] = {"sent": 0, "success": 0, "failed": 0}
        stats["daily"][today]["sent"] += 1
        if success:
            stats["daily"][today]["success"] += 1
        else:
            stats["daily"][today]["failed"] += 1
        # 总计
        if success:
            stats["total_sent"] += 1
        # 好友统计
        if friend_id:
            if friend_id not in stats["friend_stats"]:
                stats["friend_stats"][friend_id] = {"sent": 0, "name": friend_name}
            stats["friend_stats"][friend_id]["sent"] += 1
            if friend_name:
                stats["friend_stats"][friend_id]["name"] = friend_name
        _save_stats(stats)
    except Exception as e:
        logger.debug(f"记录发送统计失败: {e}")


def record_run(success: bool = True):
    """记录一次任务运行"""
    try:
        stats = _load_stats()
        stats["total_runs"] += 1
        _save_stats(stats)
    except Exception:
        pass


def _send_message_with_retry(page, chat_input, lines, username, target_name, max_retries=2):
    """
    输入并发送消息，发送后校验输入框是否被清空（抖音发送成功会清空输入框），
    未清空则自动重试。返回是否发送成功。
    尽力而为：无法读取输入框状态时乐观视为成功，不阻塞主流程。
    """
    def _type_message():
        # 先清空输入框可能存在的残留内容
        try:
            chat_input.click()
            page.keyboard.press("Meta+A")
            page.keyboard.press("Backspace")
        except Exception:
            pass
        for i, line in enumerate(lines):
            chat_input.type(line)
            if i < len(lines) - 1:
                chat_input.press("Shift+Enter")

    def _is_input_empty():
        """判断输入框是否为空（发送成功后抖音会清空输入框）"""
        try:
            text = chat_input.inner_text()
            return text is None or text.strip() == ""
        except Exception:
            # 无法读取输入框状态时，乐观认为发送成功（不阻塞主流程）
            return True

    for attempt in range(max_retries + 1):
        try:
            _type_message()
            time.sleep(0.5)
            chat_input.press("Enter")
            time.sleep(1.5)
            if _is_input_empty():
                return True
            logger.warning(
                f"账号 {username} 给好友 {target_name} 第 {attempt + 1} 次发送后输入框未清空，疑似未发出，重试中…"
            )
        except Exception as e:
            logger.warning(f"账号 {username} 给好友 {target_name} 发送异常: {e}，重试中…")
            time.sleep(1)
    return False


def handle_response(response: Response, userIDDict: dict):
    """
    只监听你要的那个接口响应
    注意：抖音号是 unique_id 字段，不是 ShortId（ShortId 是短数字ID）
    """
    # 精准匹配目标接口 URL
    if "aweme/v1/creator/im/user_detail/" in response.url:
        try:
            json_data = response.json()
            for item in json_data.get("user_list", []):
                user = item.get("user", {})
                nickname = user.get("nickname", "")
                user_id = item.get("user_id", "")
                # 抖音号（用户填的）优先作为 key
                unique_id = user.get("unique_id") or user.get("UniqueId") or ""
                short_id = user.get("ShortId") or user.get("short_id") or ""
                if unique_id:
                    userIDDict[str(unique_id)] = {"nickname": nickname, "user_id": user_id}
                    # 自动缓存昵称，任务结束时写入 .env
                    if nickname:
                        _nickname_cache[str(unique_id)] = nickname
                if short_id:
                    userIDDict[str(short_id)] = {"nickname": nickname, "user_id": user_id}
                    if nickname:
                        _nickname_cache[str(short_id)] = nickname
        except Exception as e:
            logger.debug(f"解析接口响应失败: {e}")


def retry_operation(name, operation, retries=3, delay=2, *args, **kwargs):
    """
    通用的重试逻辑
    :param name: 操作名称（用于日志记录）
    :param operation: 要执行的异步操作
    :param retries: 最大重试次数
    :param delay: 每次重试之间的延迟（秒）
    :param args: 传递给操作的参数
    :param kwargs: 传递给操作的关键字参数
    """
    for attempt in range(retries):
        try:
            return operation(*args, **kwargs)
        except Exception as e:
            if attempt < retries - 1:
                logger.warning(f"{name} 失败，正在重试第 {attempt + 1} 次，错误：{e}")
                time.sleep(delay)
            else:
                logger.error(f"{name} 失败，已达到最大重试次数，错误：{e}")
                raise


def scroll_and_select_user(page, username, targets, userIDDict):
    """尝试滚动并查找用户名"""
    # 定义目标元素和滚动容器的选择器
    friends_tab_selector = 'xpath=//*[@id="sub-app"]/div/div/div[1]/div[2]'
    target_selector = 'xpath=//*[@id="sub-app"]/div/div[1]/div[2]/div[2]//div[contains(@class, "semi-list-item-body semi-list-item-body-flex-start")]'
    scrollable_friends_selector = 'xpath=//*[@id="sub-app"]/div/div[1]/div[2]/div[2]/div/div/div[3]/div/div/div/ul/div'
    
    # [修复] 使用模糊匹配 no-more-tip- 前缀，不再依赖精确哈希后缀
    # 同时增加文本匹配作为兜底
    no_more_selector = 'xpath=//div[contains(@class, "no-more-tip-")]'
    loading_selector = 'xpath=//div[contains(@class, "semi-spin")]'

    logger.debug(f"账号 {username} 开始查找目标好友列表")
    logger.debug(f"账号 {username} 目标好友列表: {targets}")

    logger.debug(f"账号 {username} 点击进入好友标签页")
    # 点击好友标签页
    page.wait_for_selector(friends_tab_selector)
    page.locator(friends_tab_selector).click()

    logger.debug(f"账号 {username} 进入好友列表页面")

    # 确保第一个好友元素加载完成
    first_friend_selector = 'xpath=//*[@id="sub-app"]/div/div/div[2]/div[2]/div/div/div[1]/div/div/div/ul/div/div/div[1]/li/div'
    page.wait_for_selector(first_friend_selector)
    page.locator(first_friend_selector).click()  # 点击第一个好友，确保列表激活

    logger.debug(f"账号 {username} 已激活好友列表，开始滚动查找目标好友")

    time.sleep(config["friendListTimeout"] / 1000)  # 等待好友列表加载

    found_targets = set()
    # [修改] 复制一份目标列表用于追踪进度
    remaining_targets = set(targets)

    # [修复] 新增：连续空滚动计数器（滚动后没有发现新好友的次数）
    empty_scroll_count = 0
    MAX_EMPTY_SCROLLS = 10  # 连续10次滚动没有新好友，认为到底了

    while True:
        # 查找所有目标元素
        target_elements = page.locator(target_selector).all()

        # [修复] 记录本轮循环前已发现的好友数，用于判断是否有新发现
        prev_found_count = len(found_targets)

        for element in target_elements:
            try:
                # 查找子元素 span，模糊匹配 class
                span = element.locator(
                    """xpath=.//span[contains(@class, "item-header-name-")]"""
                )
                targetName = span.inner_text()

                if targetName in found_targets:
                    continue  # 已处理过，跳过
                found_targets.add(targetName)

                logger.debug(f"账号 {username} 找到好友 {targetName}")
                # 检查是否是目标好友
                if matchMode == "short_id":
                    # targets 里是抖音号/短ID，通过昵称反查对应 ID，且该 ID 必须在 targets 里
                    targetSymbol = next(
                        (key for key, info in userIDDict.items()
                         if info.get("nickname") == targetName and key in targets),
                        None
                    )
                else:
                    targetSymbol = targetName

                if targetSymbol in targets:
                    element.click()
                    if matchMode == "short_id":
                        logger.info(
                            f"账号 {username} ✅ 匹配成功：抖音号 {targetSymbol} → 昵称「{targetName}」"
                        )
                    else:
                        logger.info(
                            f"账号 {username} ✅ 匹配成功：昵称「{targetSymbol}」"
                        )
                    yield targetName
                    
                    # [修改] 标记已找到，如果全找到了直接退出
                    if targetSymbol in remaining_targets:
                        remaining_targets.remove(targetSymbol)
                    if len(remaining_targets) == 0:
                        logger.debug(f"账号 {username} 所有目标好友均已找到，停止搜索")
                        return
                    break
            except Exception as e:
                traceback.print_exc()
        else:
            # [修复] 检查本轮是否有新好友被发现
            new_found = len(found_targets) > prev_found_count
            if new_found:
                empty_scroll_count = 0  # 有新发现，重置计数器
            else:
                empty_scroll_count += 1  # 无新发现，递增计数器

            # [修复] 状态检测逻辑（多重兜底）
            
            # 1. 检查是否到底（"没有更多了" —— 使用模糊类名匹配）
            if page.locator(no_more_selector).count() > 0:
                logger.info(f"账号 {username} 检测到'没有更多了'标志，已到达底部")
                if len(remaining_targets) > 0:
                    logger.warning(f"账号 {username} 搜索结束，仍有以下好友未找到: {remaining_targets}")
                break

            # 2. [修复] 检查连续空滚动次数，防止死循环
            if empty_scroll_count >= MAX_EMPTY_SCROLLS:
                logger.warning(f"账号 {username} 连续 {MAX_EMPTY_SCROLLS} 次滚动未发现新好友，判定已到达底部")
                if len(remaining_targets) > 0:
                    logger.warning(f"账号 {username} 搜索结束，仍有以下好友未找到: {remaining_targets}")
                break

            # 3. 检查是否正在加载
            if page.locator(loading_selector).count() > 0:
                logger.debug(f"账号 {username} 列表正在加载中 (Loading)...")
                time.sleep(1.5) # 给加载留点时间
                # 不 break，继续去滚动以触发后续内容

            # 4. 滚动容器
            scrollable_element = page.locator(
                scrollable_friends_selector
            ).element_handle()
            
            if scrollable_element:
                # [修复] 记录滚动前的 scrollTop，用于检测是否真的滚动了
                scroll_top_before = page.evaluate(
                    "(element) => element.scrollTop", scrollable_element
                )
                
                page.evaluate(
                    "(element) => element.scrollTop += 800", scrollable_element
                )
                
                # [修复] 检测滚动后的 scrollTop
                time.sleep(0.3)
                scroll_top_after = page.evaluate(
                    "(element) => element.scrollTop", scrollable_element
                )
                
                if scroll_top_before == scroll_top_after:
                    # scrollTop 没有变化，说明已经到底了
                    empty_scroll_count += 2  # 加速判定到底
                    logger.debug(f"账号 {username} scrollTop 未变化 ({scroll_top_before})，可能已到底 (空滚动计数: {empty_scroll_count}/{MAX_EMPTY_SCROLLS})")
                else:
                    logger.debug(f"账号 {username} 滚动好友列表以加载更多好友 (scrollTop: {scroll_top_before} -> {scroll_top_after})")
                
                time.sleep(1.5)
            else:
                logger.error(f"账号 {username} 未找到滚动容器，退出")
                break


def do_user_task(browser, username, cookies, targets):
    # [修复] try/finally 保证 context 一定会被关闭（异常时不再泄漏浏览器上下文）
    context = browser.new_context()  # 每个任务使用独立的上下文
    try:
        context.set_default_navigation_timeout(config["browserTimeout"])  # 导航超时
        context.set_default_timeout(config["browserTimeout"])  # 所有操作的默认超时

        page = context.new_page()

        # [修复] userIDDict 作为局部变量，避免多账号串行运行时数据污染
        userIDDict = {}

        if matchMode == "short_id":  # 使用抖音号进行匹配
            page.on("response", lambda response: handle_response(response, userIDDict))

        # [修复] 先注入 Cookie，再打开页面（原代码先 goto 后注入，首次请求无登录态，会被重定向到登录页）
        context.add_cookies(cookies)

        # 打开抖音创作者中心
        retry_operation(
            "打开抖音创作者中心",
            page.goto,
            retries=config["taskRetryTimes"],
            delay=5,
            url="https://creator.douyin.com/",
        )

        # 导航到消息页面
        retry_operation(
            "导航到消息页面",
            page.goto,
            retries=config["taskRetryTimes"],
            delay=5,
            url="https://creator.douyin.com/creator-micro/data/following/chat",
        )

        logger.debug(f"账号 {username} 开始发送消息")
        sent_count = 0
        # 滚动并选择用户
        for targetName in scroll_and_select_user(page, username, targets, userIDDict):
            logger.info(f"账号 {username} 已选中好友 {targetName}")

            # 测试运行模式：只查找好友，不实际发送消息
            if DRYRUN:
                logger.info(f"[测试模式] 找到目标好友 {targetName}，跳过发送（未真实发消息）")
                continue

            # v27 每日发送上限保护：达到上限提前结束
            if daily_limit_reached():
                logger.warning(f"账号 {username} 已达今日发送上限，任务提前结束")
                break

            # 等待聊天输入框元素加载完成，使用更稳定的属性选择器
            chat_input_selector = "xpath=//div[contains(@class, 'chat-input-')]"
            page.wait_for_selector(chat_input_selector, timeout=config["browserTimeout"])
            chat_input = page.locator(chat_input_selector)

            # 在 chat-input 中输入内容
            # 反查当前好友的抖音号（用于消息变量替换）
            friend_unique_id = None
            if matchMode == "short_id":
                for uid, info in userIDDict.items():
                    if info.get("nickname") == targetName and uid in targets:
                        friend_unique_id = uid
                        break
            else:
                # nickname 模式下，targetName 就是 targets 中的值
                if targetName in targets:
                    friend_unique_id = targetName
            message = build_message(friend_unique_id)
            # v27 消息去重：与历史重复时自动加个小尾巴，避免一模一样（同时保证不漏发）
            if _feat_flag("AI_DEDUP") and is_duplicate(friend_unique_id or targetName, message):
                marker = random.choice([" ✨", " ^_^", " 🌟", " 💬", " 👋"])
                message = message.rstrip() + marker
                logger.debug(f"[去重] 好友 {targetName} 消息与历史重复，已自动追加小变化")
            # [修复] 兼容两种换行表示：字面 \n（历史模板）与真实换行符（前端 textarea 输入）
            lines = [l for l in re.split(r"\\n|\n", message) if l != ""] or [message]

            logger.debug(
                f"账号 {username} 准备发送消息给好友 {targetName}：\n\t{message}"
            )
            # 发送消息（含失败自动重试，最多重试 2 次）
            ok = _send_message_with_retry(page, chat_input, lines, username, targetName)
            if ok:
                sent_count += 1
                if not DRYRUN:
                    record_send(friend_unique_id or targetName, targetName, success=True)
                    remember_sent(friend_unique_id or targetName, message)
                logger.info(f"账号 {username} 给好友 {targetName} 发送消息完成")
            else:
                if not DRYRUN:
                    record_send(friend_unique_id or targetName, targetName, success=False)
                logger.warning(f"账号 {username} 给好友 {targetName} 重试后仍未确认发送成功，跳过")
            # v27 限流保护：随机延迟 + 基础等待，模拟真人节奏
            rate_limit_sleep()

        logger.info(f"账号 {username} 任务完成，共发送 {sent_count} 条消息")
    finally:
        context.close()  # 无论成功或异常都关闭上下文


def runTasks():
    playwright, browser = get_browser()
    try:
        # 检查是否启用多任务和任务数量
        # 创建信号量以限制并发任务数量
        logger.info("开始执行任务")
        logger.debug(f"当前配置如下：")
        logger.debug(f"消息预设: {config.get('messagePresets', '未找到')}")
        logger.debug(f"发送模式: {config.get('sendMode', 'random')}")
        logger.debug(f"一言类型: {config['hitokotoTypes']}")
        for user in userData:
            logger.debug(f"用户: {user.get('username', '未知用户')}, 目标好友: {user['targets']}")

        success_count = 0
        fail_count = 0
        for user in userData:
            cookies = user["cookies"]
            targets = user["targets"]
            username = user.get("username", "未知用户")
            logger.info(f"开始处理账号 {username}")
            # [修复] 单账号失败不再中断后续账号（如 cookies 失效只影响该账号）
            try:
                do_user_task(browser, username, cookies, targets)
                logger.info(f"账号 {username} 任务完成")
                success_count += 1
            except Exception:
                logger.error(f"账号 {username} 任务失败，继续处理下一个账号")
                logger.error(traceback.format_exc())
                fail_count += 1
    finally:
        # [修复] 记录本次任务运行次数（之前从未调用，导致 total_runs 永远为 0，成就系统失效）
        record_run(success=(fail_count == 0))
        # 任务结束时将收集到的昵称写入 .env
        _flush_nicknames_to_env()
        # 发送桌面通知
        if not RESOLVE_ONLY:
            mode_text = "（测试模式）" if DRYRUN else ""
            if fail_count == 0 and success_count > 0:
                send_desktop_notification(
                    "火花续完啦 🔥",
                    f"全部 {success_count} 个账号任务完成{mode_text}",
                )
            elif success_count > 0:
                send_desktop_notification(
                    "任务部分完成 ⚠️",
                    f"成功 {success_count} 个，失败 {fail_count} 个{mode_text}",
                    sound=False,
                )
            elif fail_count > 0:
                send_desktop_notification(
                    "任务全部失败 ❌",
                    f"{fail_count} 个账号任务失败，请查看日志",
                    sound=False,
                )
        # 关闭浏览器实例
        browser.close()

        playwright.stop()


def resolve_nickname_only():
    """
    RESOLVE_ONLY 模式：只查询指定抖音号的昵称，不发消息。
    由环境变量 RESOLVE_TARGET 指定要查询的抖音号。
    查询到的昵称会自动写入 .env 的 FRIEND_NICKNAMES 字段。
    """
    if not RESOLVE_TARGET:
        logger.error("RESOLVE_ONLY 模式下必须设置 RESOLVE_TARGET 环境变量")
        return
    if not userData:
        logger.error("没有配置任何账号，无法查询昵称")
        return

    target = RESOLVE_TARGET
    # 使用第一个账号的 cookies 进行查询
    user = userData[0]
    cookies = user["cookies"]
    username = user.get("username", "未知用户")

    logger.info(f"[昵称解析模式] 开始查询抖音号 {target} 的昵称（使用账号 {username}）")

    playwright, browser = get_browser()
    try:
        context = browser.new_context()
        try:
            context.set_default_navigation_timeout(config["browserTimeout"])
            context.set_default_timeout(config["browserTimeout"])
            page = context.new_page()

            userIDDict = {}
            # 强制使用 short_id 模式来监听接口
            page.on("response", lambda response: handle_response(response, userIDDict))

            context.add_cookies(cookies)

            # 打开抖音创作者中心
            retry_operation(
                "打开抖音创作者中心",
                page.goto,
                retries=config["taskRetryTimes"],
                delay=5,
                url="https://creator.douyin.com/",
            )

            # 导航到消息页面
            retry_operation(
                "导航到消息页面",
                page.goto,
                retries=config["taskRetryTimes"],
                delay=5,
                url="https://creator.douyin.com/creator-micro/data/following/chat",
            )

            # 滚动好友列表，直到找到目标抖音号或到底
            friends_tab_selector = 'xpath=//*[@id="sub-app"]/div/div/div[1]/div[2]'
            target_selector = 'xpath=//*[@id="sub-app"]/div/div[1]/div[2]/div[2]//div[contains(@class, "semi-list-item-body semi-list-item-body-flex-start")]'
            scrollable_friends_selector = 'xpath=//*[@id="sub-app"]/div/div[1]/div[2]/div[2]/div/div/div[3]/div/div/div/ul/div'
            no_more_selector = 'xpath=//div[contains(@class, "no-more-tip-")]'
            loading_selector = 'xpath=//div[contains(@class, "semi-spin")]'

            logger.debug(f"点击进入好友标签页")
            page.wait_for_selector(friends_tab_selector)
            page.locator(friends_tab_selector).click()

            first_friend_selector = 'xpath=//*[@id="sub-app"]/div/div/div[2]/div[2]/div/div/div[1]/div/div/div/ul/div/div/div[1]/li/div'
            page.wait_for_selector(first_friend_selector)
            page.locator(first_friend_selector).click()

            time.sleep(config["friendListTimeout"] / 1000)

            found = False
            empty_scroll_count = 0
            MAX_EMPTY_SCROLLS = 15
            max_scrolls = 50  # 最多滚动 50 次，防止无限循环
            scroll_count = 0

            while scroll_count < max_scrolls:
                scroll_count += 1
                # 检查是否已经找到
                if target in userIDDict:
                    found = True
                    nickname = userIDDict[target]["nickname"]
                    logger.info(f"[昵称解析模式] ✅ 找到抖音号 {target} 的昵称：{nickname}")
                    break

                target_elements = page.locator(target_selector).all()
                new_found = False
                for element in target_elements:
                    try:
                        span = element.locator(
                            """xpath=.//span[contains(@class, "item-header-name-")]"""
                        )
                        targetName = span.inner_text()
                        # 通过昵称反查抖音号
                        for uid, info in userIDDict.items():
                            if info.get("nickname") == targetName and uid == target:
                                found = True
                                logger.info(f"[昵称解析模式] ✅ 通过昵称匹配找到 {target}：{targetName}")
                                break
                        if found:
                            break
                    except Exception:
                        continue
                if found:
                    break

                # 检查是否到底
                if page.locator(no_more_selector).count() > 0:
                    logger.info(f"[昵称解析模式] 检测到'没有更多了'，已到达底部")
                    break

                if empty_scroll_count >= MAX_EMPTY_SCROLLS:
                    logger.warning(f"[昵称解析模式] 连续 {MAX_EMPTY_SCROLLS} 次滚动未发现新好友，判定已到达底部")
                    break

                if page.locator(loading_selector).count() > 0:
                    time.sleep(1.5)
                    continue

                # 滚动
                try:
                    scrollable_element = page.locator(scrollable_friends_selector).element_handle()
                    if scrollable_element:
                        scroll_top_before = page.evaluate("(element) => element.scrollTop", scrollable_element)
                        page.evaluate("(element) => element.scrollTop += 800", scrollable_element)
                        time.sleep(0.3)
                        scroll_top_after = page.evaluate("(element) => element.scrollTop", scrollable_element)
                        if scroll_top_before == scroll_top_after:
                            empty_scroll_count += 2
                        else:
                            empty_scroll_count = 0
                        time.sleep(1.5)
                    else:
                        break
                except Exception:
                    break

            if not found:
                logger.warning(f"[昵称解析模式] ❌ 未找到抖音号 {target} 的昵称")
                logger.warning(f"[昵称解析模式] 已收集到 {len(userIDDict)} 个好友信息：{list(userIDDict.keys())[:10]}")

        finally:
            context.close()
    finally:
        _flush_nicknames_to_env()
        browser.close()
        playwright.stop()

        

