#!/usr/bin/env bash
# KimiCode Pocket — Cloudflare 隧道服务管理（macOS / Linux）
#
# 与 tunnel-service.ps1 一一对应，只是落到的服务管理器不同：
#   Linux  → systemd system unit
#   macOS  → LaunchDaemon
#
# 为什么需要它：
#   1. cloudflared 自带的 unit/plist 是否有 Restart/KeepAlive 取决于版本，
#      不能靠猜 —— 这里用 drop-in / PlistBuddy 显式声明
#   2. 「进程活着」不等于「隧道通」。进程在、但到边缘的连接掉了（NAT 老化、
#      切网、本地代理掐断 → error 1033），进程级看护完全无感。
#      cloudflared 自己在 127.0.0.1:<metrics>/ready 暴露真实连接数，用它判断。
#
# 用法：
#   ./scripts/tunnel-service.sh status
#   sudo ./scripts/tunnel-service.sh install <YOUR_TUNNEL_TOKEN>
#   sudo ./scripts/tunnel-service.sh harden
#   ./scripts/tunnel-service.sh check
#   sudo ./scripts/tunnel-service.sh check --restart
#   sudo ./scripts/tunnel-service.sh watch [--interval 5]
#   sudo ./scripts/tunnel-service.sh unwatch
#   sudo ./scripts/tunnel-service.sh uninstall
#
# 环境变量：
#   CLOUDFLARED      cloudflared 路径（默认 cloudflared）
#   SERVICE_NAME     服务名（默认 cloudflared）
#   METRICS_PORT     /ready 端口（默认 20241）
#   FAIL_THRESHOLD   连续失败几次才重启（默认 2）
#   STATE_DIR        失败计数目录（默认 ~/.local/state/kimicode-pocket 或
#                    ~/Library/Application Support/kimicode-pocket，**不写脚本目录**）
#
# 注意：本脚本在 macOS / Linux 上**未做端到端实测**，逻辑与 .ps1 逐条对应。

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# 失败计数落在用户级状态目录，**不写脚本所在目录**，
# 这样工具无论从源码目录还是运行目录调用，都不会污染代码树。
if [ -n "${STATE_DIR:-}" ]; then
    :
elif [ "$(uname -s)" = "Darwin" ]; then
    STATE_DIR="$HOME/Library/Application Support/kimicode-pocket"
else
    STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/kimicode-pocket"
fi
STATE_FILE="$STATE_DIR/tunnel-health.state"

CLOUDFLARED="${CLOUDFLARED:-cloudflared}"
SERVICE_NAME="${SERVICE_NAME:-cloudflared}"
METRICS_PORT="${METRICS_PORT:-20241}"
FAIL_THRESHOLD="${FAIL_THRESHOLD:-2}"
INTERVAL_MIN=5
RESTART=0
TOKEN=""

LAUNCHD_PLIST="/Library/LaunchDaemons/com.cloudflare.cloudflared.plist"
HEALTH_LABEL="com.kimicode.pocket.tunnel-health"
HEALTH_PLIST="/Library/LaunchDaemons/${HEALTH_LABEL}.plist"

# ---- 基础工具 --------------------------------------------------------------

ok()   { printf '  [ok] %s\n' "$*"; }
warn() { printf '  [!] %s\n' "$*"; }
err()  { printf '  [x] %s\n' "$*" >&2; }
step() { printf '  %s\n' "$*"; }

is_root() { [ "$(id -u)" -eq 0 ]; }

as_root() {
    if is_root; then "$@"; else sudo "$@"; fi
}

need_root() {
    if ! is_root; then
        err "「$1」需要 root。请用 sudo 重新执行："
        err "  sudo $0 $1 ${2:-}"
        exit 2
    fi
}

detect_init() {
    if command -v systemctl >/dev/null 2>&1 && systemctl --version >/dev/null 2>&1; then
        echo systemd
    elif command -v launchctl >/dev/null 2>&1; then
        echo launchd
    else
        echo unknown
    fi
}

INIT="$(detect_init)"

# 从 /ready 拿 readyConnections。返回 "ready reason"
probe_ready() {
    local body
    body="$(curl -fsS --max-time 5 "http://127.0.0.1:${METRICS_PORT}/ready" 2>/dev/null)" || {
        echo "0 探测失败(端口 ${METRICS_PORT} 不通)"; return
    }
    if command -v node >/dev/null 2>&1; then
        printf '%s' "$body" | node -e '
let s = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (s += d));
process.stdin.on("end", () => {
  try { const o = JSON.parse(s); process.stdout.write(String(o.readyConnections ?? 0)); }
  catch { process.stdout.write("0"); }
});' 2>/dev/null | {
            read -r n
            if [ "${n:-0}" -ge 1 ] 2>/dev/null; then
                echo "$n readyConnections=$n"
            else
                echo "0 readyConnections=0（进程在，但没连上边缘）"
            fi
        }
    else
        # 没有 node 时退回 grep
        local n
        n="$(printf '%s' "$body" | grep -o '"readyConnections":[0-9]*' | head -1 | cut -d: -f2)"
        if [ "${n:-0}" -ge 1 ] 2>/dev/null; then echo "$n readyConnections=$n"; else echo "0 readyConnections=0"; fi
    fi
}

get_fail_count() {
    if [ -f "$STATE_FILE" ]; then
        local v
        v="$(cat "$STATE_FILE" 2>/dev/null || echo 0)"
        case "$v" in ''|*[!0-9]*) echo 0 ;; *) echo "$v" ;; esac
    else
        echo 0
    fi
}

set_fail_count() {
    mkdir -p "$STATE_DIR" 2>/dev/null || true
    printf '%s' "$1" >"$STATE_FILE" 2>/dev/null || true
}

# ---- status ----------------------------------------------------------------

show_status() {
    printf '\nCloudflare 隧道服务状态\n'
    printf -- '----------------------------------------------------\n'
    step "init system : $INIT"
    step "service     : $SERVICE_NAME"
    step "metrics     : 127.0.0.1:${METRICS_PORT}/ready"

    case "$INIT" in
        systemd)
            if systemctl list-unit-files "${SERVICE_NAME}.service" >/dev/null 2>&1; then
                step "ActiveState : $(systemctl show -p ActiveState --value "${SERVICE_NAME}" 2>/dev/null)"
                step "UnitFileState: $(systemctl show -p UnitFileState --value "${SERVICE_NAME}" 2>/dev/null)"
                printf '\n'
                step '重启策略（Restart=）：'
                systemctl show -p Restart --value "${SERVICE_NAME}" 2>/dev/null | sed 's/^/    /'
                printf '\n'
                step '已加载的 drop-in：'
                systemctl cat "${SERVICE_NAME}" 2>/dev/null | grep -E '^# /' | sed 's/^/    /' || echo '    （无）'
            else
                err "找不到 ${SERVICE_NAME}.service"
                step "未安装的话：sudo $0 install <TOKEN>"
                exit 1
            fi
            ;;
        launchd)
            if [ -f "$LAUNCHD_PLIST" ]; then
                step 'plist       : 存在'
                local keepalive
                keepalive="$(/usr/libexec/PlistBuddy -c 'Print :KeepAlive' "$LAUNCHD_PLIST" 2>/dev/null || echo '未设置')"
                step "KeepAlive   : $keepalive"
                launchctl print "system/${SERVICE_NAME}" 2>/dev/null | grep -E 'state =|pid =' | sed 's/^/    /' || true
            else
                err "找不到 $LAUNCHD_PLIST"
                step "未安装的话：sudo $0 install <TOKEN>"
                exit 1
            fi
            ;;
        *)
            err '既没有 systemd 也没有 launchd，本脚本不适用。'
            exit 1
            ;;
    esac

    printf '\n'
    step '边缘连接：'
    local res ready reason
    res="$(probe_ready)"; ready="${res%% *}"; reason="${res#* }"
    if [ "$ready" -ge 1 ] 2>/dev/null; then ok "$reason"; else err "$reason"; fi
    printf '\n'
}

# ---- harden ----------------------------------------------------------------

do_harden() {
    case "$INIT" in
        systemd)
            local dir="/etc/systemd/system/${SERVICE_NAME}.service.d"
            step "写入 drop-in: $dir/10-restart.conf"
            as_root mkdir -p "$dir"
            as_root tee "$dir/10-restart.conf" >/dev/null <<'EOF'
# 由 kimicode-pocket 的 tunnel-service.sh harden 写入
[Unit]
# 关掉启动频率限制：避免短时间内多次崩溃后被 systemd 永久放弃
StartLimitIntervalSec=0

[Service]
Restart=always
RestartSec=5
EOF
            step 'daemon-reload + restart'
            as_root systemctl daemon-reload
            as_root systemctl restart "${SERVICE_NAME}"
            sleep 3
            step "当前 Restart=$(systemctl show -p Restart --value "${SERVICE_NAME}" 2>/dev/null)"
            ok '已生效：崩溃后 5 秒自动拉起，且不会因频繁崩溃而被放弃'
            ;;
        launchd)
            if [ ! -f "$LAUNCHD_PLIST" ]; then
                err "找不到 $LAUNCHD_PLIST"; exit 1
            fi
            step '确保 KeepAlive=true'
            as_root /usr/libexec/PlistBuddy -c 'Delete :KeepAlive' "$LAUNCHD_PLIST" 2>/dev/null || true
            as_root /usr/libexec/PlistBuddy -c 'Add :KeepAlive bool true' "$LAUNCHD_PLIST"
            step '重新加载 LaunchDaemon'
            as_root launchctl bootout "system/${SERVICE_NAME}" 2>/dev/null || true
            as_root launchctl bootstrap system "$LAUNCHD_PLIST"
            sleep 3
            step "KeepAlive=$(/usr/libexec/PlistBuddy -c 'Print :KeepAlive' "$LAUNCHD_PLIST" 2>/dev/null)"
            ok '已生效：进程退出后 launchd 会重新拉起'
            ;;
    esac
}

# ---- install / uninstall ---------------------------------------------------

do_install() {
    if [ -z "$TOKEN" ]; then
        err '缺少 token。用法：sudo ./scripts/tunnel-service.sh install <YOUR_TUNNEL_TOKEN>'
        step 'token 在 Cloudflare 控制台：Zero Trust → Networks → Tunnels → 你的隧道 → 安装命令里'
        exit 2
    fi
    command -v "$CLOUDFLARED" >/dev/null 2>&1 \
        || { err "找不到 cloudflared（$CLOUDFLARED）"; exit 1; }

    step '安装服务（token 不回显）…'
    as_root "$CLOUDFLARED" service install "$TOKEN" || { err 'cloudflared service install 失败'; exit 1; }
    sleep 3
    do_harden
    printf '\n'
    show_status
}

do_uninstall() {
    step '先移除定时健康检查…'
    do_unwatch || true
    if command -v "$CLOUDFLARED" >/dev/null 2>&1; then
        as_root "$CLOUDFLARED" service uninstall || warn 'cloudflared service uninstall 返回非零'
    else
        warn '找不到 cloudflared，尝试手动清理'
        case "$INIT" in
            systemd) as_root systemctl disable --now "${SERVICE_NAME}" 2>/dev/null || true
                     as_root rm -f "/etc/systemd/system/${SERVICE_NAME}.service" ;;
            launchd) as_root launchctl bootout "system/${SERVICE_NAME}" 2>/dev/null || true
                     as_root rm -f "$LAUNCHD_PLIST" ;;
        esac
    fi
    ok '已卸载（Cloudflare 侧的隧道不受影响，也不需要删）'
}

# ---- check -----------------------------------------------------------------

do_check() {
    local res ready reason
    res="$(probe_ready)"; ready="${res%% *}"; reason="${res#* }"

    if [ "$ready" -ge 1 ] 2>/dev/null; then
        set_fail_count 0
        [ "$RESTART" -eq 0 ] && ok "隧道健康（$reason）"
        return 0
    fi

    local n
    n=$(( $(get_fail_count) + 1 ))
    set_fail_count "$n"
    warn "隧道不健康（$reason）—— 连续第 $n 次"

    [ "$RESTART" -eq 0 ] && return 1
    if [ "$n" -lt "$FAIL_THRESHOLD" ]; then
        step "未达阈值（$FAIL_THRESHOLD 次），本轮不重启 —— 避免一次抖动打断正在用的会话"
        return 1
    fi

    step "已达阈值，重启服务 ${SERVICE_NAME} …"
    case "$INIT" in
        systemd) as_root systemctl restart "${SERVICE_NAME}" || { err '重启失败'; return 1; } ;;
        launchd) as_root launchctl kickstart -k "system/${SERVICE_NAME}" || { err '重启失败'; return 1; } ;;
    esac

    sleep 8
    res="$(probe_ready)"; ready="${res%% *}"; reason="${res#* }"
    if [ "$ready" -ge 1 ] 2>/dev/null; then
        set_fail_count 0
        ok "重启后恢复（$reason）"
        return 0
    fi
    err "重启后仍不健康（$reason）"
    return 1
}

# ---- watch / unwatch -------------------------------------------------------

do_watch() {
    local self
    self="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"

    # 定时器会把「脚本路径」钉死；从源码/发布目录里跑，目录一移动就静默失效
    if [ -f "$ROOT/package.json" ]; then
        warn "你正在一个带 package.json 的目录里运行 watch。"
        warn "定时器会绑定这个路径：$self"
        step "  如果这个目录只是待发布/待打包的源码，请把本脚本复制到一个固定的运行目录再执行 watch。"
        step "  （只跑 harden 不受影响——它只改系统服务，不写任何文件。）"
        printf '\n'
    fi

    case "$INIT" in
        systemd)
            step "创建 cloudflared-health.service / .timer（每 ${INTERVAL_MIN} 分钟）"
            as_root tee "/etc/systemd/system/${SERVICE_NAME}-health.service" >/dev/null <<EOF
[Unit]
Description=KimiCode Pocket tunnel health check
After=${SERVICE_NAME}.service

[Service]
Type=oneshot
ExecStart=/bin/bash "${self}" check --restart
Environment=METRICS_PORT=${METRICS_PORT}
Environment=FAIL_THRESHOLD=${FAIL_THRESHOLD}
EOF
            as_root tee "/etc/systemd/system/${SERVICE_NAME}-health.timer" >/dev/null <<EOF
[Unit]
Description=Periodic tunnel health check

[Timer]
OnBootSec=2min
OnUnitActiveSec=${INTERVAL_MIN}min
Unit=${SERVICE_NAME}-health.service

[Install]
WantedBy=timers.target
EOF
            as_root systemctl daemon-reload
            as_root systemctl enable --now "${SERVICE_NAME}-health.timer"
            ok "已启用。查看：systemctl list-timers ${SERVICE_NAME}-health.timer"
            ;;

        launchd)
            step "创建 LaunchDaemon ${HEALTH_LABEL}（StartInterval=${INTERVAL_MIN} 分钟）"
            as_root tee "$HEALTH_PLIST" >/dev/null <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${HEALTH_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${self}</string>
    <string>check</string>
    <string>--restart</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>METRICS_PORT</key><string>${METRICS_PORT}</string>
    <key>FAIL_THRESHOLD</key><string>${FAIL_THRESHOLD}</string>
  </dict>
  <key>StartInterval</key><integer>$((INTERVAL_MIN * 60))</integer>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>/var/log/${HEALTH_LABEL}.log</string>
  <key>StandardErrorPath</key><string>/var/log/${HEALTH_LABEL}.err.log</string>
</dict>
</plist>
EOF
            as_root chown root:wheel "$HEALTH_PLIST"
            as_root chmod 644 "$HEALTH_PLIST"
            as_root launchctl bootout "system/${HEALTH_LABEL}" 2>/dev/null || true
            as_root launchctl bootstrap system "$HEALTH_PLIST"
            ok "已启用。查看：sudo launchctl print system/${HEALTH_LABEL}"
            ;;
    esac

    printf '\n'
    warn '这条隧道上可能还挂着别的域名（同一隧道多个 hostname），重启会短暂中断它们。'
}

do_unwatch() {
    case "$INIT" in
        systemd)
            as_root systemctl disable --now "${SERVICE_NAME}-health.timer" 2>/dev/null || true
            as_root rm -f "/etc/systemd/system/${SERVICE_NAME}-health.timer" \
                         "/etc/systemd/system/${SERVICE_NAME}-health.service"
            as_root systemctl daemon-reload
            ok '已移除 cloudflared-health timer'
            ;;
        launchd)
            if [ -f "$HEALTH_PLIST" ]; then
                as_root launchctl bootout "system/${HEALTH_LABEL}" 2>/dev/null || true
                as_root rm -f "$HEALTH_PLIST"
                ok '已移除 LaunchDaemon'
            else
                warn '健康检查 LaunchDaemon 本来就不存在'
            fi
            ;;
    esac
}

# ---- 参数解析 --------------------------------------------------------------

ACTION="${1:-status}"
shift || true

while [ $# -gt 0 ]; do
    case "$1" in
        --restart)     RESTART=1 ;;
        --interval)    INTERVAL_MIN="${2:-5}"; shift ;;
        --port)        METRICS_PORT="${2:-20241}"; shift ;;
        --state-dir)   STATE_DIR="${2:-$STATE_DIR}"; STATE_FILE="$STATE_DIR/tunnel-health.state"; shift ;;
        --fail-threshold) FAIL_THRESHOLD="${2:-2}"; shift ;;
        -h|--help)     sed -n '1,40p' "$0"; exit 0 ;;
        *)             [ -z "$TOKEN" ] && TOKEN="$1" || warn "忽略多余参数: $1" ;;
    esac
    shift
done

# ---- 分发 ------------------------------------------------------------------

case "$ACTION" in
    status)    show_status ;;
    harden)    need_root harden; do_harden ;;
    install)   need_root install '<TOKEN>'; do_install ;;
    uninstall) need_root uninstall; do_uninstall ;;
    check)
        if [ "$RESTART" -eq 1 ]; then need_root check '--restart'; fi
        do_check
        exit $?
        ;;
    watch)     need_root watch; do_watch ;;
    unwatch)   need_root unwatch; do_unwatch ;;
    *)         err "未知动作: $ACTION"; sed -n '15,30p' "$0"; exit 2 ;;
esac
