#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if curl -fsS "http://127.0.0.1:${PORT:-8787}/health" >/dev/null 2>&1; then
  echo "GidHub 私有后端已在运行：http://127.0.0.1:${PORT:-8787}"
  exit 0
fi

mkdir -p "$HOME/.config/gidhub"
setsid nohup node server.js >>"$HOME/.config/gidhub/server.log" 2>&1 </dev/null &
echo $! >"$HOME/.config/gidhub/manual.pid"
sleep 1
curl -fsS "http://127.0.0.1:${PORT:-8787}/health" >/dev/null && echo "已启动：http://127.0.0.1:${PORT:-8787}"
echo "站主密码：$HOME/.config/gidhub/login.txt"
