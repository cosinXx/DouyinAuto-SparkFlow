@echo off
chcp 65001 >nul
title 安装依赖
echo ========================================
echo   抖音自动续火花 - 安装依赖
echo ========================================
echo.

cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo 正在创建虚拟环境...
    python -m venv .venv
)

echo 正在安装依赖包...
.venv\Scripts\pip install -r requirements.txt

echo.
echo 依赖安装完成！
pause
