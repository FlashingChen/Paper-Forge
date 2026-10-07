#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${1:-3000}"

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "==> 端口 $PORT 已被占用，先停掉旧进程"
  pids="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t || true)"
  [ -n "$pids" ] && kill $pids 2>/dev/null || true
  sleep 1
fi

if [ -d .next-dev ]; then
  echo "==> 清理开发缓存"
  rm -rf .next-dev
fi

echo "==> 启动 dev server :$PORT"
exec npx next dev -p "$PORT"
