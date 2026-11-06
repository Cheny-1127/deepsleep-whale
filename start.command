#!/bin/zsh
# macOS 双击启动入口；先定位项目目录，避免依赖 Finder 的工作目录。
cd -- "${0:A:h}" || exit 1
# Finder 启动的终端可能没有加载 Node.js 的常用安装路径。
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
command -v npm >/dev/null 2>&1 || { print -u2 '未找到 npm，请先安装 Node.js。'; exit 1; }

umask 077
log_dir="$HOME/Library/Logs/deepsleep-whale"
mkdir -p -- "$log_dir" || exit 1
log_file="$log_dir/startup.log"
# 脱离终端并断开标准输入输出，关闭启动窗口后应用继续运行。
nohup npm start >> "$log_file" 2>&1 < /dev/null &!
print "已提交后台启动，可关闭此终端窗口。日志：$log_file"
