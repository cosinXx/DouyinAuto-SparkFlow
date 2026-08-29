# 尝试从 .env 文件加载环境变量
import os
if os.path.exists(".env"):
    from dotenv import load_dotenv

    load_dotenv(".env")

from core.tasks import runTasks, resolve_nickname_only

if os.getenv("RESOLVE_ONLY", "0") == "1":
    resolve_nickname_only()
else:
    runTasks()
