#!/bin/zsh
# macOS 双击启动入口；先定位项目目录，避免依赖 Finder 的工作目录。
cd -- "${0:A:h}" || exit 1
# Finder 启动的终端可能没有加载 Node.js 的常用安装路径。
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
exec npm start
