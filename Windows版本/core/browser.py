import os, sys
import subprocess
import traceback
from playwright.sync_api import sync_playwright
from utils.config import DEBUG, get_environment, Environment

PLAYWRIGHT_BROWSERS_PATH = "../chrome"

def install_browser():
    """
    安装 Chromium 浏览器
    使用当前 Python 环境自带的 playwright 模块安装（不依赖系统 PATH 里的 playwright 命令，
    避免环境残留的坏脚本导致安装失败）。
    """
    env = os.environ.copy()
    # 与 get_browser 保持一致：安装到项目 chrome/ 目录
    browsers_path = os.path.abspath(
        os.path.join(os.path.dirname(os.path.abspath(__file__)), PLAYWRIGHT_BROWSERS_PATH)
    )
    env["PLAYWRIGHT_BROWSERS_PATH"] = browsers_path
    try:
        subprocess.run(
            [sys.executable, "-m", "playwright", "install", "chromium"],
            check=True,
            env=env,
        )
        print("浏览器安装完成，请重新运行程序。")
    except subprocess.CalledProcessError as e:
        print(f"发生未知错误：{e}")


def get_browser():
    """
    启动浏览器实例
    :return: 浏览器实例
    """

    headless = True

    env = get_environment()
    if env == Environment.LOCAL:
        os.environ["PLAYWRIGHT_BROWSERS_PATH"] = os.path.abspath(
            os.path.join(os.path.dirname(__file__), PLAYWRIGHT_BROWSERS_PATH)
        )
        if DEBUG:
            headless = False
    elif env == Environment.PACKED:
        os.environ["PLAYWRIGHT_BROWSERS_PATH"] = os.path.abspath(
            os.path.join(os.path.dirname(sys.executable), PLAYWRIGHT_BROWSERS_PATH)
        )

    try:
        # 启动浏览器
        playwright = sync_playwright().start()
        browser = playwright.chromium.launch(headless=headless)
        return playwright, browser
    except Exception as e:
        # 捕获浏览器启动错误
        if "Executable doesn't exist" in str(e) and env != Environment.GITHUBACTION:
            print("浏览器可执行文件不存在！")
            install_browser()
            sys.exit(1)
        else:
            traceback.print_exc()
            # [修复] 失败必须抛出异常，否则隐式返回 None 会在调用处引发 TypeError
            raise
