#!/usr/bin/env bash
# KimiCode Pocket — 公网远控启动脚本（Cloudflare 快速隧道，macOS / Linux）
#
# 用法:
#   ./scripts/start-tunnel.sh
#   CLOUDFLARED=/usr/local/bin/cloudflared ./scripts/start-tunnel.sh
#   RESPECT_PROXY=1 ./scripts/start-tunnel.sh      # 不剥离代理环境变量
#
# 流程:
#   1) 探测代理 /__healthz，确认它已找到 Desktop
#   2) 启动 quick tunnel，指向**代理的固定端口**
#   3) 校验公网确实打通
#   4) 取一次性配对口令 —— 必须等隧道就绪后再取，否则码会在等待中变旧
#   5) 输出配对链接 + 生成二维码 PNG（有效期取服务端返回的 expiresInSec）
#
# 兼容性说明: 本脚本在 Git Bash 上做过语法校验，未在真实 macOS/Linux 端到端跑通。
# 依赖只用了 curl / node / ps，不用 pgrep、不用 sed 正则、不用 GNU 专有参数。

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLOUDFLARED="${CLOUDFLARED:-cloudflared}"
PROXY_PORT="${POCKET_PORT:-50980}"
APP_HOME="${POCKET_APP_HOME:-$HOME/.kimi-code}"
TOKEN_FILE="$APP_HOME/server.token"
# 运行态一律不落在仓库里：这个目录是交付物，不是工作目录
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/kimicode-pocket"
PAIR_URL_FILE="$STATE_DIR/pair-url.txt"
PAIR_QR_FILE="$STATE_DIR/pair-qr.png"
BASE="http://127.0.0.1:${PROXY_PORT}"
WORK_DIR="${TMPDIR:-/tmp}/kimicode-pocket-tunnel"

mkdir -p "$STATE_DIR" "$WORK_DIR" 2>/dev/null || true

fail() { printf '[x] %s\n' "$*" >&2; exit 1; }

# 从 stdin 的 JSON 里取一个字段（不依赖 jq）
json_field() {
    node -e '
let s = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (s += d));
process.stdin.on("end", () => {
  try { const o = JSON.parse(s); process.stdout.write(String(o[process.argv[1]] ?? "")); }
  catch { process.stdout.write(""); }
});' "$1"
}

# ---- 0) 前置 ----------------------------------------------------------------
command -v node >/dev/null 2>&1 || fail "未找到 node。请先安装 Node.js 22+。"
command -v "$CLOUDFLARED" >/dev/null 2>&1 \
    || fail "未找到 cloudflared（$CLOUDFLARED）。安装方式见 README，或用 CLOUDFLARED=/path/to/cloudflared 指定。"

# ---- 1) 代理就绪？ ----------------------------------------------------------
HEALTH_JSON="$(curl -fsS --max-time 5 "$BASE/__healthz" 2>/dev/null)" \
    || fail "代理 $BASE 不可用。请先启动: node src/proxy.mjs"

case "$HEALTH_JSON" in
    *'"ok":true'*) ;;
    *) fail "代理在运行，但找不到 Desktop 实例。请先启动 Kimi Code Desktop。响应: $HEALTH_JSON" ;;
esac

DESKTOP_PORT="$(printf '%s' "$HEALTH_JSON" | json_field desktopPort)"
printf '[ok] 代理 %s -> Desktop 127.0.0.1:%s\n' "$BASE" "${DESKTOP_PORT:-?}"

# ---- 2) 启动隧道（默认剥离代理环境变量）------------------------------------
mkdir -p "$WORK_DIR"
CF_OUT="$WORK_DIR/cf.out"
CF_ERR="$WORK_DIR/cf.err"
rm -f "$CF_OUT" "$CF_ERR"

ENVARGS=""
if [ "${RESPECT_PROXY:-0}" != "1" ]; then
    for v in HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy NO_PROXY no_proxy; do
        if printenv "$v" >/dev/null 2>&1; then
            ENVARGS="$ENVARGS -u $v"
        fi
    done
    [ -n "$ENVARGS" ] && printf '[i] 已临时剥离代理环境变量（cloudflared 继承本地代理会导致 error 1033）\n'
fi

# shellcheck disable=SC2086
nohup env $ENVARGS "$CLOUDFLARED" tunnel --no-autoupdate --url "http://127.0.0.1:${PROXY_PORT}" \
    >"$CF_OUT" 2>"$CF_ERR" &
CF_PID=$!

printf '[..] 隧道启动中 (pid %s)，通常 10-90 秒...\n' "$CF_PID"

URL=""
i=0
while [ "$i" -lt 45 ]; do
    i=$((i + 1))
    sleep 2
    URL="$(grep -Eoh 'https://[a-z0-9]+(-[a-z0-9]+)+\.trycloudflare\.com' "$CF_ERR" "$CF_OUT" 2>/dev/null | head -1)"
    [ -n "$URL" ] && break
    kill -0 "$CF_PID" 2>/dev/null || break
done

if [ -z "$URL" ]; then
    printf '[x] 隧道未就绪。日志尾部：\n' >&2
    tail -20 "$CF_ERR" 2>/dev/null >&2
    printf '\n常见原因：\n' >&2
    printf '  · 本机代理/VPN（Clash TUN、v2ray 等）掐断了 *.argotunnel.com\n' >&2
    printf '  · 企业/校园网拦截出站\n' >&2
    exit 1
fi
printf '[ok] 隧道地址: %s\n' "$URL"

# ---- 3) 校验公网可达 --------------------------------------------------------
sleep 3
STATUS="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$URL" 2>/dev/null || echo 000)"
case "$STATUS" in
    200)
        BODY="$(curl -fsS --max-time 30 "$URL" 2>/dev/null || true)"
        case "$BODY" in
            *'<title>Kimi Code</title>'*) printf '[ok] 公网已直达 Web UI\n' ;;
            *) fail "公网返回的不是 Kimi Code 页面，请检查代理。" ;;
        esac
        ;;
    302|401) printf '[ok] 公网已可达（口令保护生效，浏览器会先要口令）\n' ;;
    *) fail "公网校验失败（HTTP $STATUS）。看上面的 cf 日志。" ;;
esac

# ---- 4) 取一次性配对口令 ----------------------------------------------------
# 必须放在隧道就绪之后：取码在启动隧道之前做，等 90 秒隧道 + 30 秒校验过来，
# 码已经老掉一半了，标签上写的"多少秒有效"就成了假话。
CODE=""
TTL_SEC=""
CODE_JSON="$(curl -fsS --max-time 5 "$BASE/__paircode" 2>/dev/null)" || CODE_JSON=""
if [ -n "$CODE_JSON" ]; then
    CODE="$(printf '%s' "$CODE_JSON" | json_field code)"
    TTL_SEC="$(printf '%s' "$CODE_JSON" | json_field expiresInSec)"
fi
if [ -z "$CODE" ]; then
    printf '[!] 取配对口令失败，回退到 #token= 方式（该地址含长期凭证，别外发）\n' >&2
fi

# ---- 5) 输出配对地址 + 二维码 ----------------------------------------------
if [ -n "$CODE" ]; then
    PAIR_URL="${URL}/__pair?code=${CODE}"
    LABEL="配对链接（有效期 ${TTL_SEC:-180} 秒，用一次就失效）:"
else
    TOKEN=""
    [ -f "$TOKEN_FILE" ] && TOKEN="$(tr -d '\r\n' <"$TOKEN_FILE")"
    if [ -n "$TOKEN" ]; then PAIR_URL="${URL}/#token=${TOKEN}"; else PAIR_URL="$URL"; fi
    LABEL="配对链接（含长期凭证，用完即关，勿外发）:"
fi

printf '\n===== 公网远控已就绪 =====\n'
printf '%s\n' "$LABEL"
printf '%s\n' "$PAIR_URL"
printf '%s\n' "$PAIR_URL" >"$PAIR_URL_FILE"

# 二维码：本地渲染，绝不用第三方在线二维码服务（那等于把地址发给别人）
if curl -fsS --max-time 10 -X POST --data-binary "$PAIR_URL" \
        -H 'content-type: text/plain' -o "$PAIR_QR_FILE" "$BASE/__qrcode" 2>/dev/null \
        && [ -s "$PAIR_QR_FILE" ]; then
    printf '\n二维码已保存: %s\n' "$PAIR_QR_FILE"
    printf '  打开它，用手机扫（iPhone: 相机 / Android: 浏览器扫码）\n'
else
    printf '\n[!] 二维码生成失败，直接用上面的链接。\n'
fi

printf '\n注意:\n'
printf '  · 快速隧道地址每次重启都会变（要固定域名见 README「固定域名」）\n'
printf '  · 配对后手机端凭证 7 天过期，到时重新跑本脚本\n'
printf '  · 停止隧道: kill %s\n\n' "$CF_PID"

printf 'CFPID=%s\nURL=%s\n' "$CF_PID" "$URL" >"$WORK_DIR/pid.txt"
