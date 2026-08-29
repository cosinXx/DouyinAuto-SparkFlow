#!/bin/bash
# 抖音自动续火花 - Web 控制台启动脚本
# 用法: 双击运行，或在终端执行 ./webui.sh

# 切换到脚本所在目录
cd "$(dirname "$0")"

echo "========================================"
echo "  抖音自动续火花工具 - Web 控制台"
echo "========================================"
echo ""

# 检查 Python
if ! command -v python3 &> /dev/null; then
    echo "[错误] 未检测到 Python3，请先安装 Python 3.8+"
    exit 1
fi

# 创建虚拟环境（如果不存在）
if [ ! -d ".venv" ]; then
    echo "[1/3] 正在创建虚拟环境..."
    python3 -m venv .venv
fi

# 安装依赖
echo "[2/3] 正在检查依赖..."
.venv/bin/pip install -r requirements.txt -q

# 启动 Web 控制台
echo "[3/3] 正在启动 Web 控制台..."
echo ""
echo "浏览器将自动打开 http://127.0.0.1:8899"
echo "按 Ctrl+C 可停止服务"
echo ""

# 自动打开浏览器
open http://127.0.0.1:8899 2>/dev/null

# 启动服务
.venv/bin/python webui/server.py
