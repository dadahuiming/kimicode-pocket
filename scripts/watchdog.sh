#!/usr/bin/env bash
# KimiCode Pocket — 看门狗（macOS / Linux）
#
# 职责：确保 proxy.mjs 常驻（崩溃自愈）。
# 不负责 cloudflared —— 那通常由系统服务自行管理，互不干扰。
#
# 判定逻辑：轮询代理自己的 /__healthz。
#   - 200 → 代理活着（哪怕 Desktop 没开，代理自身是健康的）
#   - 连续 2 次不通 → 清掉残留进程并重新拉起
#
# 用法：
#   ./scripts/watchdog.sh                          （前台常驻）
#   nohup ./scripts/watchdog.sh >/dev/null 2>&1 &  （后台）
#
# 注意：macOS 推荐用 launchd、Linux 推荐用 systemd（Restart=always），
#       它们已覆盖本脚本功能，见 README「常驻运行」。
#
# 兼容性：不依赖 pgrep（各平台 -f 行为有差异），改用 ps + awk 的字面量匹配。

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROXY="$ROOT/src/proxy.mjs"
# 运行态一律不落在仓库里：这个目录是交付物，不是工作目录
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/kimicode-pocket"
LOGFILE="$STATE_DIR/watchdog.log"
PROXY_OUT="$STATE_DIR/proxy.out"
PROXY_ERR="$STATE_DIR/proxy.err"
PORT="${POCKET_PORT:-50980}"
NODE_BIN="${POCKET_NODE:-node}"
HEALTH_URL="http://127.0.0.1:${PORT}/__healthz"
INTERVAL_SEC=30
MAX_LOG_BYTES=$((5 * 1024 * 1024))

mkdir -p "$STATE_DIR" 2>/dev/null || true

log() {
    local line
    line="$(date '+%Y-%m-%d %H:%M:%S') $*"
    # 日志超过 5MB 就截断，避免无限增长
    if [ -f "$LOGFILE" ]; then
        local size
        size=$(wc -c <"$LOGFILE" 2>/dev/null | tr -d ' ')
        if [ -n "$size" ] && [ "$size" -gt "$MAX_LOG_BYTES" ]; then
            printf '%s [log rotated]\n' "$(date '+%Y-%m-%d %H:%M:%S')" >"$LOGFILE"
        fi
    fi
    printf '%s\n' "$line" >>"$LOGFILE" 2>/dev/null || true
}

healthy() {
    curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1
}

# 找出命令行里含本仓库 proxy.mjs 的进程。
# 用 index() 做字面量匹配 —— 路径里出现 . + ( ) 等正则元字符也不会误判。
find_proxy_pids() {
    ps -Ao pid=,args= 2>/dev/null | awk -v pat="$PROXY" 'index($0, pat) { print $1 }'
}

stop_stale() {
    # 只杀命令行里含本仓库 proxy.mjs 的进程，绝不误伤其他 node
    for pid in $(find_proxy_pids); do
        if kill -0 "$pid" 2>/dev/null; then
            if kill -9 "$pid" 2>/dev/null; then
                log "killed stale proxy pid $pid"
            else
                log "failed to kill pid $pid"
            fi
        fi
    done
}

start_proxy() {
    nohup "$NODE_BIN" "$PROXY" >>"$PROXY_OUT" 2>>"$PROXY_ERR" &
    local pid=$!
    log "started proxy pid $pid"
    return 0
}

# ---- 前置检查 ---------------------------------------------------------------

if ! command -v "$NODE_BIN" >/dev/null 2>&1; then
    printf '错误：未找到 %s。请先安装 Node.js 22+，或用 POCKET_NODE=/path/to/node 指定。\n' "$NODE_BIN" >&2
    exit 1
fi
if [ ! -f "$PROXY" ]; then
    printf '错误：找不到 %s\n' "$PROXY" >&2
    exit 1
fi

log "watchdog started (interval ${INTERVAL_SEC}s, port $PORT, node $NODE_BIN)"

misses=0
while true; do
    if healthy; then
        if [ "$misses" -gt 0 ]; then
            log "proxy recovered after $misses miss(es)"
            misses=0
        fi
    else
        misses=$((misses + 1))
        log "proxy unhealthy (miss $misses)"
        # 连续两次不健康才动手，避免瞬时抖动误杀
        if [ "$misses" -ge 2 ]; then
            stop_stale
            sleep 2
            start_proxy
            sleep 6
            if healthy; then
                log "proxy restored"
                misses=0
            else
                log "proxy still unhealthy after restart"
            fi
        fi
    fi
    sleep "$INTERVAL_SEC"
done
