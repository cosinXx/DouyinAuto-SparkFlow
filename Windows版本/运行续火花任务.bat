@echo off
chcp 65001 >nul
title 抖音自动续火花 - 运行任务
echo ========================================
echo   抖音自动续火花工具 - 运行任务
echo ========================================
echo.

cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo 正在创建虚拟环境...
    python -m venv .venv
    .venv\Scripts\pip install -r requirements.txt -q
)

.venv\Scripts\python main.py

pause
