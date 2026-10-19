#!/usr/bin/env bash
# KimiCode Pocket — 停止脚本（看门狗 + 代理，macOS / Linux）
#
# 用法: ./scripts/stop.sh
# 注意: 不影响 cloudflared 服务，也不影响其它隧道/域名。
#
# 兼容性：不依赖 pgrep，改用 ps + awk 的字面量匹配。

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROXY="$ROOT/src/proxy.mjs"
PORT="${POCKET_PORT:-50980}"

printf '停止看门狗...\n'
for pid in $(ps -Ao pid=,args= 2>/dev/null | awk -v a="$ROOT" -v b="watchdog.sh" 'index($0, a) && index($0, b) { print $1 }'); do
    printf '  kill watchdog pid %s\n' "$pid"
    kill -9 "$pid" 2>/dev/null || true
done

printf '停止代理...\n'
for pid in $(ps -Ao pid=,args= 2>/dev/null | awk -v pat="$PROXY" 'index($0, pat) { print $1 }'); do
    printf '  kill proxy pid %s\n' "$pid"
    kill -9 "$pid" 2>/dev/null || true
done

sleep 2
printf '\n验证：\n'
if curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/__healthz" >/dev/null 2>&1; then
    printf '  [x] 代理仍在运行（可能不是本仓库的实例，或看门狗没被杀掉）\n'
else
    printf '  [ok] 代理已停止\n'
fi
printf '  cloudflared 服务未受影响（其它域名照常）\n'
