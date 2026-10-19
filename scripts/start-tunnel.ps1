# KimiCode Pocket — 公网远控启动脚本（Cloudflare 快速隧道）
#
# 用法:
#   pwsh -File scripts/start-tunnel.ps1
#   pwsh -File scripts/start-tunnel.ps1 -Cloudflared C:\tools\cloudflared.exe
#   pwsh -File scripts/start-tunnel.ps1 -RespectProxy     # 不剥离代理环境变量
#
# 流程:
#   1) 探测代理 /__healthz，确认它已找到 Desktop
#   2) 启动 quick tunnel，指向**代理的固定端口**（不是 Desktop 的动态端口）
#   3) 校验公网确实打通到 Web UI
#   4) 取一次性配对口令 —— 必须等隧道就绪后再取，否则码会在等待中变旧
#   5) 输出配对链接 + 生成二维码 PNG（有效期取服务端返回的 expiresInSec）
#
# 关于 Host: 代理已把 Host/Origin 改写成回环地址，所以**不需要** httpHostHeader。
# 不再写 cloudflared config.yml —— 少一个可能写错的地方。

param(
    [string]$Cloudflared = "$env:USERPROFILE\cloudflared.exe",
    [int]$ProxyPort = 50980,
    [string]$AppHome = "$env:USERPROFILE\.kimi-code",
    [switch]$RespectProxy,
    [switch]$OpenQr
)

$ErrorActionPreference = 'Stop'

$Root      = Split-Path -Parent $PSScriptRoot
$TokenFile = Join-Path $AppHome 'server.token'
# 运行态一律不落在仓库里：这个目录是交付物，不是工作目录
$StateDir    = Join-Path $env:LOCALAPPDATA 'kimicode-pocket'
$PairUrlFile = Join-Path $StateDir 'pair-url.txt'
$PairQrFile  = Join-Path $StateDir 'pair-qr.png'
$Base      = "http://127.0.0.1:$ProxyPort"

try { New-Item -ItemType Directory -Force -Path $StateDir | Out-Null } catch { }

function Fail($msg) {
    Write-Host "[x] $msg" -ForegroundColor Red
    exit 1
}

# ---- 1) cloudflared ---------------------------------------------------------
if (-not (Test-Path $Cloudflared)) {
    $cmd = Get-Command cloudflared -ErrorAction SilentlyContinue
    if ($cmd) { $Cloudflared = $cmd.Source }
    else { Fail "未找到 cloudflared。装一个（winget install Cloudflare.cloudflared），或用 -Cloudflared 指定路径。" }
}

# ---- 2) 代理就绪？ ----------------------------------------------------------
try {
    $hj = (Invoke-WebRequest "$Base/__healthz" -UseBasicParsing -TimeoutSec 5).Content | ConvertFrom-Json
} catch {
    Fail "代理 $Base 不可用。请先启动：node src/proxy.mjs`n原因: $($_.Exception.Message)"
}
if (-not $hj.ok) {
    Fail "代理在运行，但找不到 Kimi Code Desktop 实例。请先启动 Desktop。"
}
Write-Host "[ok] 代理 $Base -> Desktop 127.0.0.1:$($hj.desktopPort)（口令保护: $(if ($hj.pin) {'已开'} else {'未开'})）" -ForegroundColor Green

# ---- 3) 启动隧道（剥离代理环境变量）----------------------------------------
$proxyVars = @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NO_PROXY', 'no_proxy')
$saved = @{}
if (-not $RespectProxy) {
    foreach ($v in $proxyVars) {
        $item = Get-Item "env:$v" -ErrorAction SilentlyContinue
        if ($item) { $saved[$v] = $item.Value; Remove-Item "env:$v" -ErrorAction SilentlyContinue }
    }
    if ($saved.Count -gt 0) {
        Write-Host "[i] 已临时剥离 $($saved.Keys -join ', ')（cloudflared 继承本地代理会导致 error 1033）"
    }
}

$workDir = Join-Path $env:TEMP 'kimicode-pocket-tunnel'
New-Item -ItemType Directory -Force -Path $workDir | Out-Null
$cfOut = Join-Path $workDir 'cf.out'
$cfErr = Join-Path $workDir 'cf.err'
Remove-Item $cfOut, $cfErr -ErrorAction SilentlyContinue

try {
    $proc = Start-Process -FilePath $Cloudflared `
        -ArgumentList 'tunnel', '--no-autoupdate', '--url', "http://127.0.0.1:$ProxyPort" `
        -RedirectStandardOutput $cfOut -RedirectStandardError $cfErr -WindowStyle Hidden -PassThru
} finally {
    foreach ($k in $saved.Keys) { Set-Item "env:$k" $saved[$k] }
}

Write-Host "[..] 隧道启动中 (pid $($proc.Id))，通常 10-90 秒..."

$url = $null
for ($i = 0; $i -lt 45; $i++) {
    Start-Sleep -Seconds 2
    $text = (Get-Content $cfOut -Raw -EA SilentlyContinue) + (Get-Content $cfErr -Raw -EA SilentlyContinue)
    if ($text -match 'https://[a-z0-9]+(-[a-z0-9]+)+\.trycloudflare\.com') { $url = $Matches[0]; break }
    if ($proc.HasExited) { break }
}
if (-not $url) {
    Write-Host "[x] 隧道未就绪。日志尾部：" -ForegroundColor Red
    Get-Content $cfErr -Tail 20 -EA SilentlyContinue
    Write-Host ""
    Write-Host "常见原因：" -ForegroundColor Yellow
    Write-Host "  · 本机代理/VPN（Clash TUN、v2ray 等）掐断了 *.argotunnel.com —— 试试关掉 TUN，或彻底退出代理软件"
    Write-Host "  · 企业/校园网拦截出站 —— 让 IT 放行，或改用手机热点"
    exit 1
}
Write-Host "[ok] 隧道地址: $url"

# ---- 4) 校验公网可达 --------------------------------------------------------
Start-Sleep -Seconds 3
try {
    $resp = Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 30 -MaximumRedirection 0
    $status = $resp.StatusCode
    $body = $resp.Content
} catch {
    # 302（开启口令保护时会跳登录页）在 PS 里会抛异常，单独取状态码
    $status = $_.Exception.Response.StatusCode.value__
    $body = ''
}

if ($status -eq 200) {
    if ($body -notmatch '<title>Kimi Code</title>') { Fail "公网返回的不是 Kimi Code 页面，请检查代理是否正常。" }
    Write-Host "[ok] 公网已直达 Web UI" -ForegroundColor Green
} elseif ($status -eq 302 -or $status -eq 401) {
    Write-Host "[ok] 公网已可达（口令保护生效，浏览器会先要口令）" -ForegroundColor Green
} else {
    Fail "公网校验失败（HTTP $status）。看上面的 cf 日志。"
}

# ---- 5) 取一次性配对口令 ----------------------------------------------------
# 必须放在隧道就绪之后：否则等 90 秒隧道 + 30 秒校验过来，码已经老掉一半，
# 标签上写的"多少秒有效"就是假话。
$code = $null
$ttlSec = $null
try {
    $pj = (Invoke-WebRequest "$Base/__paircode" -UseBasicParsing -TimeoutSec 5).Content | ConvertFrom-Json
    $code = $pj.code
    $ttlSec = $pj.expiresInSec
} catch {
    Write-Host "[!] 取配对口令失败，回退到 #token= 方式（该地址含长期凭证，别外发）" -ForegroundColor Yellow
}

# ---- 6) 输出配对地址 + 二维码 ----------------------------------------------
$pairUrl = if ($code) { "$url/__pair?code=$code" } else {
    $token = ''
    if (Test-Path $TokenFile) { $token = (Get-Content $TokenFile -Raw).Trim() }
    if ($token) { "$url/#token=$token" } else { $url }
}

Write-Host ""
Write-Host "===== 公网远控已就绪 =====" -ForegroundColor Green
if ($code) {
    Write-Host "配对链接（有效期 $(if ($ttlSec) { $ttlSec } else { 180 }) 秒，用一次就失效）:"
} else {
    Write-Host "配对链接（含长期凭证，用完即关，勿外发）:"
}
Write-Host $pairUrl -ForegroundColor Cyan

Set-Content -Path $PairUrlFile -Value $pairUrl -Encoding UTF8

# 二维码：让代理本地渲染，绝不用第三方在线二维码服务（那等于把地址发给别人）
$qrOk = $false
try {
    Invoke-WebRequest "$Base/__qrcode" -Method POST -Body $pairUrl -ContentType 'text/plain' `
        -OutFile $PairQrFile -UseBasicParsing -TimeoutSec 10 | Out-Null
    $qrOk = (Test-Path $PairQrFile) -and ((Get-Item $PairQrFile).Length -gt 0)
} catch {
    $qrOk = $false
}

if ($qrOk) {
    Write-Host ""
    Write-Host "二维码已保存: $PairQrFile" -ForegroundColor Cyan
    Write-Host "  手机直接扫这个屏幕上的图（电脑上打开它）"
    if ($OpenQr) { Start-Process $PairQrFile }
}

Write-Host ""
Write-Host "注意:"
Write-Host "  · 快速隧道地址每次重启都会变（要固定域名见 README「固定域名」）"
Write-Host "  · 配对后手机端凭证 7 天过期，到时重新跑本脚本"
Write-Host "  · 停止隧道: Stop-Process -Id $($proc.Id)"
Write-Host ""

"CFPID=$($proc.Id)`nURL=$url" | Set-Content (Join-Path $workDir 'pid.txt')
