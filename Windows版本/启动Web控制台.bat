@echo off
chcp 65001 >nul
title 抖音自动续火花 - Web控制台
echo ========================================
echo   抖音自动续火花工具 - Web控制台
echo ========================================
echo.

cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo [1/3] 正在创建虚拟环境...
    python -m venv .venv
)

echo [2/3] 正在安装依赖...
.venv\Scripts\pip install -r requirements.txt -q

echo [3/3] 正在启动 Web 控制台...
echo.
echo 浏览器将自动打开 http://127.0.0.1:8899
echo 按 Ctrl+C 可停止服务
echo.

start http://127.0.0.1:8899
.venv\Scripts\python webui\server.py

pause
