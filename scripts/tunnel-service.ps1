# KimiCode Pocket — Cloudflare 隧道服务管理（Windows）
#
# 目的：把「装服务 / 配崩溃自重启 / 查状态 / 健康探测 / 定时自愈」收进一个工具，
#       不用再靠人记得手敲 sc.exe。
#
# 为什么需要它：
#   `cloudflared service install` 装出来的服务是「自动启动」，但 Windows 服务
#   在进程崩溃后**默认不会重启**（SCM 的 failure action 默认是"不操作"）。
#   不配的话，cloudflared 偶发崩溃要等到下次重启电脑才恢复，而现象是
#   「手机一片 502，本机 127.0.0.1:50980 却完全正常」——极容易误判成代理的问题。
#
# 为什么还要「健康探测」而不只是「进程存活」：
#   有一类故障是进程活着、但到 Cloudflare 边缘的连接掉了（NAT 老化、切换网络、
#   本地代理/VPN 掐断 → error 1033）。进程级看护对这类完全无感。
#   cloudflared 自己在 127.0.0.1:<metrics>/ready 暴露了真实连接数，
#   这才是可用的判据。
#
# 用法：
#   pwsh -File scripts/tunnel-service.ps1 status
#   pwsh -File scripts/tunnel-service.ps1 install -Token <YOUR_TUNNEL_TOKEN>
#   pwsh -File scripts/tunnel-service.ps1 harden
#   pwsh -File scripts/tunnel-service.ps1 check
#   pwsh -File scripts/tunnel-service.ps1 check -Restart
#   pwsh -File scripts/tunnel-service.ps1 watch -IntervalMinutes 5
#   pwsh -File scripts/tunnel-service.ps1 unwatch
#   pwsh -File scripts/tunnel-service.ps1 uninstall
#
# 需要管理员权限的子命令：install / uninstall / harden / watch / unwatch / check -Restart

param(
    [Parameter(Position = 0)]
    [ValidateSet('status', 'install', 'uninstall', 'harden', 'check', 'watch', 'unwatch')]
    [string]$Action = 'status',

    [string]$Token = $env:TUNNEL_TOKEN,
    [string]$Cloudflared = "$env:USERPROFILE\cloudflared.exe",
    [string]$ServiceName = 'cloudflared',

    # cloudflared 默认在 127.0.0.1:20241 暴露 /ready 与 /metrics。
    # 同一台机器跑多条隧道时，第二条要另配 --metrics，这里只盯一条。
    [int]$MetricsPort = 20241,

    [int]$IntervalMinutes = 5,
    [switch]$Restart,

    # 失败计数落在哪里。默认放到用户级应用数据目录，**不写进脚本所在目录**，
    # 这样本工具无论从源码目录、还是从运行目录调用，都不会污染代码树。
    [string]$StateDir = '',

    # 连续多少次探测失败才重启（防抖：一次抖动不该打断正在用的会话）
    [int]$FailThreshold = 2
)

$ErrorActionPreference = 'Stop'

if (-not $StateDir) {
    if ($env:LOCALAPPDATA) { $StateDir = Join-Path $env:LOCALAPPDATA 'kimicode-pocket' }
    else { $StateDir = Join-Path ([IO.Path]::GetTempPath()) 'kimicode-pocket' }
}
$StateFile = Join-Path $StateDir 'tunnel-health.state'
$TaskName  = 'KimiCodePocket-TunnelHealth'

function Write-Step($msg) { Write-Host "  $msg" }
function Write-Ok($msg)   { Write-Host "  [ok] $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "  [!] $msg" -ForegroundColor Yellow }
function Write-Err2($msg) { Write-Host "  [x] $msg" -ForegroundColor Red }

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p = New-Object Security.Principal.WindowsPrincipal($id)
    return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Require-Admin([string]$why) {
    if (-not (Test-Admin)) {
        Write-Err2 "「$why」需要管理员权限。请右键 PowerShell → 以管理员身份运行，再执行本命令。"
        exit 2
    }
}

function Get-ScValue([string]$sub, [string[]]$args_) {
    $out = & sc.exe $sub $ServiceName @args_ 2>&1
    return @{ code = $LASTEXITCODE; text = ($out -join "`n") }
}

# 探测隧道是否真的连着 Cloudflare 边缘。
# 返回 @{ ok=bool; ready=int; reason=string }
function Get-TunnelHealth {
    try {
        $r = Invoke-WebRequest "http://127.0.0.1:$MetricsPort/ready" -UseBasicParsing -TimeoutSec 5
        if ($r.StatusCode -ne 200) {
            return @{ ok = $false; ready = 0; reason = "HTTP $($r.StatusCode)" }
        }
        $j = $r.Content | ConvertFrom-Json
        $ready = 0
        if ($null -ne $j.readyConnections) { $ready = [int]$j.readyConnections }
        if ($ready -lt 1) {
            return @{ ok = $false; ready = 0; reason = "readyConnections=0（进程在，但没连上边缘）" }
        }
        return @{ ok = $true; ready = $ready; reason = "readyConnections=$ready" }
    } catch {
        return @{ ok = $false; ready = 0; reason = "探测失败: $($_.Exception.Message)" }
    }
}

function Get-FailCount {
    if (Test-Path $StateFile) {
        $v = (Get-Content $StateFile -Raw -ErrorAction SilentlyContinue)
        if ($v -match '^\d+$') { return [int]$v }
    }
    return 0
}

function Set-FailCount([int]$n) {
    try {
        New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
        Set-Content -Path $StateFile -Value $n -Encoding ASCII
    } catch { }
}

function Get-ServiceState {
    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if (-not $svc) { return $null }
    return $svc
}

# ---- status ----------------------------------------------------------------

function Show-Status {
    Write-Host "`nCloudflare 隧道服务状态" -ForegroundColor Cyan
    Write-Host ("-" * 52)

    $svc = Get-ServiceState
    if (-not $svc) {
        Write-Err2 "找不到名为「$ServiceName」的服务。"
        Write-Step "未安装的话，用：pwsh -File scripts/tunnel-service.ps1 install -Token <TOKEN>"
        Write-Step "或者你本来就是用「快速隧道」脚本临时跑的，那不需要服务。"
        exit 1
    }

    Write-Step "服务名   : $ServiceName"
    Write-Step "状态     : $($svc.Status)"

    $wmi = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'" -ErrorAction SilentlyContinue
    if ($wmi -and $wmi.ProcessId) { Write-Step "进程 PID : $($wmi.ProcessId)" }

    $qc = Get-ScValue 'qc'
    if ($qc.code -eq 0) {
        $startLine = ($qc.text -split "`n" | Where-Object { $_ -match '(?i)START_TYPE|启动类型' } | Select-Object -First 1)
        if ($startLine) { Write-Step ("启动类型 : " + ($startLine -replace '.*:\s*', '').Trim()) }
    } else {
        Write-Warn2 "读不到服务配置（需要管理员权限才能执行 sc qc）"
    }

    Write-Host ''
    Write-Step '崩溃重启策略：'
    $qf = Get-ScValue 'qfailure'
    if ($qf.code -eq 0) {
        $qf.text -split "`n" | Where-Object { $_.Trim() } | ForEach-Object { Write-Host "    $($_.Trim())" }
        $hasRestart = $qf.text -match '(?i)RESTART|重新启动|再启动'
        Write-Host ''
        if ($hasRestart) { Write-Ok '已配置失败后自动重启' }
        else { Write-Warn2 '未配置失败后自动重启 —— 崩溃后不会自愈，跑一次 harden' }
    } else {
        Write-Warn2 "读不到失败策略（需要管理员权限）。用管理员跑：sc.exe qfailure $ServiceName"
    }

    Write-Host ''
    Write-Step "边缘连接（127.0.0.1:$MetricsPort/ready）："
    $h = Get-TunnelHealth
    if ($h.ok) { Write-Ok $h.reason }
    else {
        Write-Err2 $h.reason
        Write-Step '  · 端口不是默认的 20241？用 -MetricsPort 指定'
        Write-Step '  · 服务没带 --metrics？cloudflared 默认会开 127.0.0.1:20241'
    }
    Write-Host ''
}

# ---- harden ----------------------------------------------------------------

function Invoke-Harden {
    $svc = Get-ServiceState
    if (-not $svc) { Write-Err2 "服务「$ServiceName」不存在"; exit 1 }

    Write-Step '设置启动类型为「自动」…'
    $r1 = & sc.exe config $ServiceName start= auto 2>&1
    if ($LASTEXITCODE -ne 0) { Write-Err2 ($r1 -join ' '); exit 1 }
    Write-Ok 'start= auto'

    Write-Step '配置失败后自动重启（首次 5s、二次 10s、之后 30s，计数 24h 后重置）…'
    $r2 = & sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/10000/restart/30000 2>&1
    if ($LASTEXITCODE -ne 0) { Write-Err2 ($r2 -join ' '); exit 1 }
    Write-Ok 'failure actions 已写入'

    Write-Step '允许「非零退出码」也触发失败动作（failureflag=1）…'
    $r3 = & sc.exe failureflag $ServiceName 1 2>&1
    if ($LASTEXITCODE -eq 0) { Write-Ok 'failureflag=1' }
    else { Write-Warn2 "failureflag 设置失败（部分系统不支持该子命令）：$($r3 -join ' ')" }

    Write-Host ''
    Write-Step '复核：'
    $qf = & sc.exe qfailure $ServiceName 2>&1
    $qf | Where-Object { $_.Trim() } | ForEach-Object { Write-Host "    $($_.Trim())" }
    $hasRestart = ($qf -join "`n") -match '(?i)RESTART|重新启动|再启动'
    Write-Host ''
    if ($hasRestart) { Write-Ok '已生效。现在 cloudflared 崩溃会自动拉起。' }
    else { Write-Warn2 '输出里没看到 restart 关键字。可能是本地化文本，请人工确认上面几行。' }
}

# ---- install / uninstall ---------------------------------------------------

function Invoke-Install {
    if (-not $Token) {
        Write-Err2 '缺少 token。用法：install -Token <YOUR_TUNNEL_TOKEN>，或先设 $env:TUNNEL_TOKEN'
        Write-Step '  token 在 Cloudflare 控制台：Zero Trust → Networks → Tunnels → 你的隧道 → 安装命令里'
        exit 2
    }
    if (-not (Test-Path $Cloudflared)) {
        $cmd = Get-Command cloudflared -ErrorAction SilentlyContinue
        if ($cmd) { $Cloudflared = $cmd.Source }
        else { Write-Err2 "找不到 cloudflared。装一个（winget install Cloudflare.cloudflared），或用 -Cloudflared 指定路径"; exit 1 }
    }

    $svc = Get-ServiceState
    if ($svc) {
        Write-Warn2 "服务「$ServiceName」已存在（状态 $($svc.Status)）。先 uninstall 再装，避免残留配置。"
        Write-Step '如果只是想补上自动重启，直接跑：harden'
        exit 1
    }

    Write-Step "安装服务（token 不回显）…"
    & $Cloudflared service install $Token 2>&1 | ForEach-Object { Write-Host "    $_" }
    if ($LASTEXITCODE -ne 0) { Write-Err2 'cloudflared service install 失败'; exit 1 }

    Start-Sleep -Seconds 3
    Invoke-Harden | Out-Null
    Write-Host ''
    Show-Status
}

function Invoke-Uninstall {
    $svc = Get-ServiceState
    if (-not $svc) { Write-Warn2 "服务「$ServiceName」本来就不存在"; return }

    Write-Step '先移除定时健康检查任务（如果装过）…'
    & schtasks.exe /Delete /TN $TaskName /F 2>&1 | Out-Null

    if (Test-Path $Cloudflared) {
        Write-Step '卸载服务…'
        & $Cloudflared service uninstall 2>&1 | ForEach-Object { Write-Host "    $_" }
    } else {
        Write-Warn2 "找不到 cloudflared.exe，退回用 sc.exe delete"
        & sc.exe stop $ServiceName 2>&1 | Out-Null
        & sc.exe delete $ServiceName 2>&1 | ForEach-Object { Write-Host "    $_" }
    }
    Write-Ok '已卸载。注意：不会删除 Cloudflare 侧的隧道，也不需要删。'
}

# ---- check -----------------------------------------------------------------

function Invoke-Check {
    $h = Get-TunnelHealth
    $svc = Get-ServiceState

    if ($h.ok) {
        Set-FailCount 0
        if (-not $Restart) { Write-Ok "隧道健康（$($h.reason)）" }
        return 0
    }

    $n = (Get-FailCount) + 1
    Set-FailCount $n
    Write-Warn2 "隧道不健康（$($h.reason)）—— 连续第 $n 次"

    if (-not $Restart) { return 1 }
    if (-not $svc) { Write-Err2 "服务不存在，无法重启"; return 1 }

    if ($n -lt $FailThreshold) {
        Write-Step "未达阈值（$FailThreshold 次），本轮不重启 —— 避免一次抖动打断正在用的会话"
        return 1
    }

    Write-Step "已达阈值，重启服务 $ServiceName …"
    try {
        Restart-Service -Name $ServiceName -Force -ErrorAction Stop
        Start-Sleep -Seconds 8
        $h2 = Get-TunnelHealth
        if ($h2.ok) {
            Set-FailCount 0
            Write-Ok "重启后恢复（$($h2.reason)）"
            return 0
        }
        Write-Err2 "重启后仍不健康（$($h2.reason)）"
        return 1
    } catch {
        Write-Err2 "重启失败：$($_.Exception.Message)"
        return 1
    }
}

# ---- watch / unwatch -------------------------------------------------------

function Invoke-Watch {
    $svc = Get-ServiceState
    if (-not $svc) { Write-Err2 "服务「$ServiceName」不存在，先 install"; exit 1 }

    $psExe = (Get-Process -Id $PID).Path
    $script = $PSCommandPath
    $arg = "-NoProfile -ExecutionPolicy Bypass -File `"$script`" check -Restart -MetricsPort $MetricsPort -FailThreshold $FailThreshold -StateDir `"$StateDir`""

    # 计划任务会把「脚本路径」钉死。如果你是从源码/发布目录里跑的，
    # 那个目录一旦被移动、重命名或删掉，任务就会静默失效。
    $repoMarker = Join-Path (Split-Path -Parent $PSScriptRoot) 'package.json'
    if (Test-Path $repoMarker) {
        Write-Warn2 "你正在一个带 package.json 的目录里运行 watch。"
        Write-Warn2 "计划任务会绑定这个路径：$script"
        Write-Step  "  如果这个目录只是待发布/待打包的源码，请把本脚本复制到一个固定的运行目录再执行 watch。"
        Write-Step  "  （只跑 harden 不受影响——它只改系统服务，不写任何文件。）"
        Write-Host ''
    }

    Write-Step "注册计划任务「$TaskName」，每 $IntervalMinutes 分钟探测一次…"
    & schtasks.exe /Create /TN $TaskName /TR "`"$psExe`" $arg" /SC MINUTE /MO $IntervalMinutes /RU SYSTEM /RL HIGHEST /F 2>&1 |
        ForEach-Object { Write-Host "    $_" }
    if ($LASTEXITCODE -ne 0) { Write-Err2 '创建计划任务失败'; exit 1 }

    Write-Host ''
    Write-Ok "已注册。每 $IntervalMinutes 分钟检查 /ready，连续 $FailThreshold 次不健康才重启服务。"
    Write-Step '查看：schtasks /Query /TN ' + $TaskName + ' /V /FO LIST'
    Write-Step '立即跑一次：schtasks /Run /TN ' + $TaskName
    Write-Step '移除：pwsh -File scripts/tunnel-service.ps1 unwatch'
    Write-Host ''
    Write-Warn2 '这条隧道上可能还挂着别的域名（同一隧道多个 hostname），重启会短暂中断它们。'
}

function Invoke-Unwatch {
    & schtasks.exe /Delete /TN $TaskName /F 2>&1 | ForEach-Object { Write-Host "    $_" }
    if ($LASTEXITCODE -eq 0) { Write-Ok "已移除计划任务 $TaskName" }
    else { Write-Warn2 '计划任务本来就不存在' }
}

# ---- 分发 ------------------------------------------------------------------

switch ($Action) {
    'status'    { Show-Status }
    'harden'    { Require-Admin 'harden'; Invoke-Harden }
    'install'   { Require-Admin 'install'; Invoke-Install }
    'uninstall' { Require-Admin 'uninstall'; Invoke-Uninstall }
    'check'     {
        if ($Restart) { Require-Admin 'check -Restart' }
        $code = Invoke-Check
        exit $code
    }
    'watch'     { Require-Admin 'watch'; Invoke-Watch }
    'unwatch'   { Require-Admin 'unwatch'; Invoke-Unwatch }
}
