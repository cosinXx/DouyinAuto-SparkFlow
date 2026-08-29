"""
core/msg_builder.py
解析消息模板构建具体发送的消息内容
支持：
  1. 文字预设（MESSAGE_PRESETS，多条文案）
  2. 发送模式（SEND_MODE）：random=每次随机一条 | fixed=固定用选中的那条
  3. [API] 占位符替换为一言（保留原能力）
  4. 变量替换：{昵称} {备注} {抖音号} {星期} {日期} {时间} {问候}
"""

import random
import os
import json
from datetime import datetime
from utils.config import get_config
from utils.hitokoto import request_hitokoto


def build_message_with_openai() -> str:
    """
    通过 OpenAI 接口生成续火花消息，内容丰富，不超过20字
    """
    from openai import OpenAI

    config = get_config()
    openai_config = config.get("openai", {})
    api_key = os.getenv("OPENAI_API_KEY", openai_config.get("api_key", ""))
    model = openai_config.get("model", "MiniMax-M2.7")

    if not api_key:
        return get_config().get("messageTemplate", "续火花")

    client = OpenAI(api_key=api_key)

    response = client.chat.completions.create(
        model=model,
        messages=[
            {
                "role": "system",
                "content": "你是一个擅长写续火花消息的助手。用户需要你生成一段不超过20字的续火花消息，内容要温馨、有趣、适合发给聊天对象。请直接输出消息内容，不要加引号或其他修饰。",
            },
            {"role": "user", "content": "生成一段续火花消息，直接输出内容不要思考过程"},
        ],
        extra_body={"reasoning_split": True},
    )

    return response.choices[0].message.content.strip()


# 预置 AI 生成场景（用途）
AI_SCENARIOS = {
    "spark": "你是一个擅长写抖音续火花消息的助手。生成一段不超过20字的续火花消息，内容温馨、有趣、自然，适合发给正在续火花的聊天对象。直接输出消息内容，不要引号、不要解释、不要加 emoji 之外的修饰。",
    "hello": "你是一个擅长打招呼的助手。生成一段轻松自然、不油腻的开场问候语，字数不超过20字，适合发给熟悉的朋友。直接输出内容，不要引号或解释。",
    "festival": "你是一个擅长写节日祝福的助手。生成一段温馨的节日祝福消息，字数不超过25字，自然不官方。直接输出内容，不要引号或解释。",
    "praise": "你是一个擅长真诚夸赞的助手。生成一段真诚、具体、不油腻的夸赞消息，字数不超过20字。直接输出内容，不要引号或解释。",
    "care": "你是一个擅长关心朋友的助手。生成一段体贴、自然的关心问候消息，字数不超过20字，不要油腻。直接输出内容，不要引号或解释。",
    "birthday": "你是一个擅长写生日祝福的助手。生成一段温馨、真诚、不套路的生日祝福消息，字数不超过25字，自然亲切。直接输出内容，不要引号或解释。",
    "custom": "",  # 自定义：直接用用户 prompt
}

# ============================================================
# v27：AI 个性化消息 / 节日问候 / Token 保护 支持
# ============================================================
# 公历固定节日表（MM-DD -> 节日名）。农历节日（春节/端午/中秋等）每年浮动，
# 可在前端"智能功能中心"里用"自定义节日"补充。
FESTIVALS = {
    "01-01": "元旦",
    "02-14": "情人节",
    "03-08": "妇女节",
    "04-01": "愚人节",
    "05-01": "劳动节",
    "05-04": "青年节",
    "06-01": "儿童节",
    "09-10": "教师节",
    "10-01": "国庆节",
    "10-31": "万圣节",
    "11-28": "感恩节",
    "12-24": "平安夜",
    "12-25": "圣诞节",
    "12-31": "跨年夜",
}


def _today_festival() -> str:
    """返回今天的节日名（内置公历表 + .env 自定义节日），不是节日返回空串。"""
    key = datetime.now().strftime("%m-%d")
    name = FESTIVALS.get(key, "")
    if not name:
        # 读取自定义节日 CUSTOM_FESTIVALS（.env JSON: {"MM-DD": "节日名"}）
        try:
            raw = os.getenv("CUSTOM_FESTIVALS", "{}")
            if raw.startswith("'") and raw.endswith("'"):
                raw = raw[1:-1]
            custom = json.loads(raw) if raw else {}
            if isinstance(custom, dict):
                name = custom.get(key, "") or ""
        except Exception:
            name = ""
    return name


def _today_is_birthday(friend_unique_id: str) -> bool:
    """好友生日（FRIEND_BIRTHDAYS: {抖音号: "MM-DD"}）是否就是今天"""
    if not friend_unique_id:
        return False
    try:
        raw = os.getenv("FRIEND_BIRTHDAYS", "{}")
        if raw.startswith("'") and raw.endswith("'"):
            raw = raw[1:-1]
        bd = json.loads(raw) if raw else {}
        if not isinstance(bd, dict):
            return False
        b = (bd.get(friend_unique_id) or "").strip()
        if not b:
            return False
        return b == datetime.now().strftime("%m-%d")
    except Exception:
        return False


def _feat_flag(key: str) -> bool:
    """读取 .env 开关配置（main.py 已 load_dotenv，core 进程可直接 os.getenv）"""
    return (os.getenv(key, "0") or "").strip().lower() in ("1", "true", "yes", "on")


def _feat_int(key: str, default: int) -> int:
    try:
        return int(float(os.getenv(key, "") or default))
    except (TypeError, ValueError):
        return default


def generate_ai_message(scenario: str = "spark", prompt: str = "", model: str = "") -> str:
    """
    通用 AI 消息生成（v26 新增，v27 加 Token 保护与用量统计）：
      scenario: spark续火花 / hello打招呼 / festival节日 / praise夸夸 / care关心 / custom自定义
      prompt:   自定义指令（scenario=custom 时必填，其他场景作为补充要求）
      model:    可选，覆盖默认模型
    返回生成文本；未配置 key 时抛 ValueError 提示用户先配置。
    Token 保护：开启 SAFE_TOKEN 时，每日超过 TOKEN_DAILY_LIMIT 将拒绝生成。
    """
    from openai import OpenAI

    config = get_config()
    openai_config = config.get("openai", {})
    api_key = os.getenv("OPENAI_API_KEY", openai_config.get("api_key", ""))
    if not api_key:
        raise ValueError("未配置 AI API Key")
    use_model = model or openai_config.get("model", "MiniMax-M2.7")

    # ---- v27 Token 保护 ----
    if _feat_flag("SAFE_TOKEN"):
        from utils.ai_usage import get_today_usage
        limit = _feat_int("TOKEN_DAILY_LIMIT", 50000)
        if limit > 0 and get_today_usage() >= limit:
            raise ValueError(f"今日 Token 已达上限（{limit}），已保护性停止，明天继续或调高上限")

    if scenario == "custom":
        sys_prompt = "你是一个贴心的文案助手。请严格按照用户要求输出内容，直接输出结果，不要引号、不要解释。"
        user_content = prompt or "写一句话"
    else:
        sys_prompt = AI_SCENARIOS.get(scenario, AI_SCENARIOS["spark"])
        user_content = prompt if prompt else "生成一段，直接输出内容不要思考过程"

    # 低消耗模式：更短的用户指令，省 Token
    if _feat_flag("TOKEN_LOW") and scenario != "custom":
        user_content = "生成一句，越短越好"

    client = OpenAI(api_key=api_key)
    response = client.chat.completions.create(
        model=use_model,
        messages=[
            {"role": "system", "content": sys_prompt},
            {"role": "user", "content": user_content},
        ],
        extra_body={"reasoning_split": True},
    )
    text = (response.choices[0].message.content or "").strip()
    # 用量统计（估算：输入+输出字符数/3≈token）
    try:
        usage = response.usage
        if usage is not None:
            tokens = int(getattr(usage, "total_tokens", 0) or 0) or (
                int(getattr(usage, "prompt_tokens", 0) or 0) + int(getattr(usage, "completion_tokens", 0) or 0)
            )
        else:
            tokens = max(1, (len(sys_prompt) + len(user_content) + len(text)) // 3)
        from utils.ai_usage import record_tokens
        record_tokens(tokens)
    except Exception:
        pass
    if not text:
        raise ValueError("AI 未返回有效内容")
    return text


def generate_personal_message(friend_info: dict = None, scenario: str = "spark") -> str:
    """
    v27：AI 个性化专属消息 —— 基于好友昵称/备注/分组等上下文生成更贴合的消息。
    friend_info: {nickname, remark, unique_id, group}
    未配置 key 时抛 ValueError。
    """
    from openai import OpenAI

    config = get_config()
    openai_config = config.get("openai", {})
    api_key = os.getenv("OPENAI_API_KEY", openai_config.get("api_key", ""))
    if not api_key:
        raise ValueError("未配置 AI API Key")
    use_model = openai_config.get("model", "MiniMax-M2.7")

    info = friend_info or {}
    nickname = info.get("nickname") or info.get("remark") or "朋友"
    remark = info.get("remark") or ""
    group = info.get("group") or ""
    ctx_bits = [f"对方昵称：{nickname}"]
    if remark:
        ctx_bits.append(f"备注：{remark}")
    if group:
        ctx_bits.append(f"你们的关系/分组：{group}")
    ctx = "；".join(ctx_bits)

    base = AI_SCENARIOS.get(scenario, AI_SCENARIOS["spark"])
    sys_prompt = base + f"\n请结合对方的背景信息自然融入：{ctx}。不要提及'根据你的背景'之类的话。"
    user_content = "写一句给这位朋友的专属消息，直接输出内容"

    if _feat_flag("TOKEN_LOW"):
        user_content = "写一句，越短越好"

    # Token 保护检查
    if _feat_flag("SAFE_TOKEN"):
        from utils.ai_usage import get_today_usage
        limit = _feat_int("TOKEN_DAILY_LIMIT", 50000)
        if limit > 0 and get_today_usage() >= limit:
            raise ValueError(f"今日 Token 已达上限（{limit}），已保护性停止")

    client = OpenAI(api_key=api_key)
    response = client.chat.completions.create(
        model=use_model,
        messages=[
            {"role": "system", "content": sys_prompt},
            {"role": "user", "content": user_content},
        ],
        extra_body={"reasoning_split": True},
    )
    text = (response.choices[0].message.content or "").strip()
    try:
        usage = response.usage
        if usage is not None:
            tokens = int(getattr(usage, "total_tokens", 0) or 0)
        else:
            tokens = max(1, (len(sys_prompt) + len(user_content) + len(text)) // 3)
        from utils.ai_usage import record_tokens
        record_tokens(tokens)
    except Exception:
        pass
    if not text:
        raise ValueError("AI 未返回有效内容")
    return text


def _resolve_api(content: str) -> str:
    """把文案里的 [API] 替换为一言内容"""
    if "[API]" in content:
        return content.replace("[API]", request_hitokoto())
    return content


def _get_greeting() -> str:
    """根据当前时间返回对应时段问候语"""
    now = datetime.now()
    hour = now.hour + now.minute / 60.0
    if 6 <= hour < 11:
        return "早上好！"
    elif 11 <= hour < 14:
        return "中午好！"
    elif 14 <= hour < 18:
        return "下午好！"
    elif 18 <= hour < 24:
        return "晚上好！"
    elif 4 <= hour < 6:
        return "凌晨了～"
    else:
        return "深夜了～"


def _get_time_period() -> str:
    """获取当前时段名称（如"晚上"）"""
    now = datetime.now()
    hour = now.hour
    if 5 <= hour < 9:
        return "清晨"
    elif 9 <= hour < 12:
        return "上午"
    elif 12 <= hour < 14:
        return "中午"
    elif 14 <= hour < 18:
        return "下午"
    elif 18 <= hour < 22:
        return "晚上"
    else:
        return "深夜"


def _resolve_variables(content: str, friend_info: dict = None) -> str:
    """
    替换消息中的变量：
      {昵称} - 好友抖音昵称
      {备注} - 好友备注名
      {抖音号} - 好友抖音号
      {星期} - 当前星期几（如"星期五"）
      {日期} - 当前日期（如"8月28日"）
      {时间} - 当前时间（如"21:40"）
      {时段} - 当前时段（如"晚上"）
      {问候} - 时段问候语（如"晚上好！"）
    """
    if not content:
        return content

    now = datetime.now()
    weekdays = ["星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"]

    variables = {
        "星期": weekdays[now.weekday()],
        "日期": f"{now.month}月{now.day}日",
        "时间": now.strftime("%H:%M"),
        "时段": _get_time_period(),
        "问候": _get_greeting(),
        "昵称": "",
        "备注": "",
        "抖音号": "",
    }

    if friend_info:
        variables["昵称"] = friend_info.get("nickname", "") or ""
        variables["备注"] = friend_info.get("remark", "") or ""
        variables["抖音号"] = friend_info.get("unique_id", "") or ""

    # 如果有备注，{昵称} 优先显示备注（更亲切），否则显示抖音昵称
    # 注意：这里不自动替换，用户写 {备注} 就是备注，写 {昵称} 就是昵称

    for key, value in variables.items():
        placeholder = "{" + key + "}"
        if placeholder in content:
            content = content.replace(placeholder, value)

    return content


def _load_friend_info(unique_id: str) -> dict:
    """从 .env 加载指定好友的昵称和备注信息"""
    if not unique_id:
        return {}
    try:
        env_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")
        nicknames = {}
        remarks = {}
        with open(env_path, encoding="utf-8") as f:
            for line in f:
                s = line.strip()
                if s.startswith("FRIEND_NICKNAMES="):
                    raw = s[len("FRIEND_NICKNAMES="):].strip()
                    if raw.startswith("'") and raw.endswith("'"):
                        raw = raw[1:-1]
                    try:
                        nicknames = json.loads(raw)
                    except Exception:
                        pass
                elif s.startswith("FRIEND_REMARKS="):
                    raw = s[len("FRIEND_REMARKS="):].strip()
                    if raw.startswith("'") and raw.endswith("'"):
                        raw = raw[1:-1]
                    try:
                        remarks = json.loads(raw)
                    except Exception:
                        pass
        return {
            "unique_id": unique_id,
            "nickname": nicknames.get(unique_id, ""),
            "remark": remarks.get(unique_id, ""),
        }
    except Exception:
        return {"unique_id": unique_id, "nickname": "", "remark": ""}


def build_message(friend_unique_id: str = None) -> str:
    """
    根据发送模式构建消息：
      - 有文字预设（messagePresets）且非空 → 优先用预设（纯文案，不含前后缀）
      - sendMode=random → 每次随机挑一条
      - sendMode=fixed → 用 selectedPresetIndex 指定的那条
      - 无预设 → 回退到旧 messageTemplate
      - 变量替换：{昵称} {备注} {抖音号} {星期} {日期} {时间} {时段} {问候}
      - [API] 替换为一言
      - 最终统一拼接：[续火花吧] + 时段问候语 + 文案 + 换行 + 【来自<用户名>的自动续火花脚本】
    """
    config = get_config()
    presets = config.get("messagePresets") or []

    if presets:
        send_mode = config.get("sendMode", "random")
        if send_mode == "fixed":
            idx = config.get("selectedPresetIndex", 0)
            # 越界保护
            if idx < 0 or idx >= len(presets):
                idx = 0
            content = presets[idx]
        else:
            content = random.choice(presets)
    else:
        # 回退：旧模板
        content = config.get("messageTemplate", "续火花")

    # 加载好友信息（用于变量替换）
    friend_info = _load_friend_info(friend_unique_id) if friend_unique_id else None

    # ---- v27：AI 个性化 / 节日问候 ----
    ai_personal = _feat_flag("AI_PERSONAL")
    ai_festival = _feat_flag("AI_FESTIVAL")
    festival = _today_festival()
    # 已有 AI Key？
    ai_key = os.getenv("OPENAI_API_KEY", "")
    if not ai_key:
        try:
            ai_key = get_config().get("openai", {}).get("api_key", "")
        except Exception:
            ai_key = ""

    ai_content = None
    # 生日祝福优先（开启 F_BIRTHDAY 且该好友生日是今天）
    if _feat_flag("F_BIRTHDAY") and _today_is_birthday(friend_unique_id) and ai_key:
        try:
            if ai_personal:
                ai_content = generate_personal_message(friend_info, scenario="birthday")
            else:
                ai_content = generate_ai_message(scenario="birthday")
            ai_content = ai_content.strip()[:60]
        except Exception:
            ai_content = None
    elif festival and ai_festival and ai_key:
        # 节日优先：用 AI 生成节日专属问候（个性化开启时结合好友信息）
        try:
            if ai_personal:
                ai_content = generate_personal_message(friend_info, scenario="festival")
            else:
                ai_content = generate_ai_message(scenario="festival")
            ai_content = ai_content.strip()[:60]
        except Exception:
            ai_content = None
    elif ai_personal and ai_key:
        # 个性化专属消息（平时）
        try:
            ai_content = generate_personal_message(friend_info, scenario="spark")
            ai_content = ai_content.strip()[:60]
        except Exception:
            ai_content = None
    if ai_content:
        greeting = _get_greeting()
        sender_name = config.get("account", {}).get("username") or os.getenv("DOUYIN_USERNAME", "我")
        return f"[续火花吧]{greeting}{ai_content}\n【来自{sender_name}的自动续火花脚本】"

    # 变量替换
    content = _resolve_variables(content, friend_info)
    # [API] 一言替换
    content = _resolve_api(content).strip()
    greeting = _get_greeting()
    sender_name = config.get("account", {}).get("username") or os.getenv("DOUYIN_USERNAME", "我")
    return f"[续火花吧]{greeting}{content}\n【来自{sender_name}的自动续火花脚本】"


def preview_message(content: str, friend_unique_id: str = None) -> str:
    """
    预览消息的变量替换效果（不含前后缀）。
    与 build_message 使用同一套替换逻辑，保证预览与真实发送一致。
    """
    friend_info = _load_friend_info(friend_unique_id) if friend_unique_id else None
    content = _resolve_variables(content or "", friend_info)
    content = _resolve_api(content)
    return content.strip()
