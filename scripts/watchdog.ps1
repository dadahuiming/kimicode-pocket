# KimiCode Pocket — 看门狗
#
# 职责：确保 proxy.mjs 常驻（崩溃自愈、开机自启）。
# 不负责 cloudflared —— 那通常由系统服务自行管理，互不干扰。
#
# 判定逻辑：轮询代理自己的 /__healthz。
#   - 200 → 代理活着（哪怕 Desktop 没开，代理自身是健康的）
#   - 连续 2 次不通 → 清掉残留进程并重新拉起（防抖，避免误杀进行中的对话）
#
# 用法：
#   pwsh -File scripts/watchdog.ps1              （前台常驻）
#   由 Startup 里的 .vbs 以隐藏窗口拉起          （推荐，见 README）
#
# 环境变量：
#   POCKET_PORT     监听端口（默认 50980，需与 proxy.mjs 一致）
#   POCKET_NODE     node 可执行文件路径（默认从 PATH 里找）

param(
    [string]$NodeExe = $env:POCKET_NODE
)

$ErrorActionPreference = 'Continue'

$Root        = Split-Path -Parent $PSScriptRoot
$Proxy       = Join-Path $Root 'src\proxy.mjs'
# 运行态一律不落在仓库里：这个目录是交付物，不是工作目录
$StateDir    = Join-Path $env:LOCALAPPDATA 'kimicode-pocket'
$LogFile     = Join-Path $StateDir 'watchdog.log'
$ProxyOut    = Join-Path $StateDir 'proxy.out'
$ProxyErr    = Join-Path $StateDir 'proxy.err'
$Port        = if ($env:POCKET_PORT) { $env:POCKET_PORT } else { '50980' }
$HealthUrl   = "http://127.0.0.1:$Port/__healthz"
$IntervalSec = 30
$MaxLogBytes = 5MB

try { New-Item -ItemType Directory -Force -Path $StateDir | Out-Null } catch { }

function Write-Log([string]$msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
    try {
        # 日志超过 5MB 就截断，避免无限增长
        if ((Test-Path $LogFile) -and ((Get-Item $LogFile).Length -gt $MaxLogBytes)) {
            Set-Content -Path $LogFile -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') [log rotated]"
        }
        Add-Content -Path $LogFile -Value $line -Encoding UTF8
    } catch { }
}

function Test-ProxyHealthy {
    try {
        $r = Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec 5
        return ($r.StatusCode -eq 200)
    } catch {
        return $false
    }
}

function Stop-StaleProxy {
    # 只杀命令行里含本仓库 proxy.mjs 的 node 进程，绝不误伤其他 node
    $targets = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -like "*$Proxy*" }
    foreach ($t in $targets) {
        try {
            Stop-Process -Id $t.ProcessId -Force -ErrorAction Stop
            Write-Log "killed stale proxy pid $($t.ProcessId)"
        } catch {
            Write-Log "failed to kill pid $($t.ProcessId): $($_.Exception.Message)"
        }
    }
}

function Start-Proxy {
    try {
        $p = Start-Process -FilePath $NodeExe -ArgumentList "`"$Proxy`"" `
            -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput $ProxyOut `
            -RedirectStandardError  $ProxyErr
        Write-Log "started proxy pid $($p.Id)"
        return $true
    } catch {
        Write-Log "failed to start proxy: $($_.Exception.Message)"
        return $false
    }
}

# ---- 前置检查 ---------------------------------------------------------------

if (-not $NodeExe) {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { $NodeExe = $cmd.Source } else { $NodeExe = 'node' }
}

if (-not (Test-Path $Proxy)) {
    Write-Host "错误：找不到 $Proxy" -ForegroundColor Red
    exit 1
}

$verOk = $false
try {
    $v = & $NodeExe --version 2>$null
    if ($v -match '^v(\d+)\.') { $verOk = [int]$Matches[1] -ge 18 }
    if (-not $verOk) { Write-Log "node 版本过低或无法识别: $v" }
} catch {
    Write-Log "无法执行 node: $($_.Exception.Message)"
}

Write-Log "watchdog started (interval ${IntervalSec}s, port $Port, node $NodeExe)"

$misses = 0

while ($true) {
    if (Test-ProxyHealthy) {
        if ($misses -gt 0) { Write-Log "proxy recovered after $misses miss(es)"; $misses = 0 }
    } else {
        $misses++
        Write-Log "proxy unhealthy (miss $misses)"
        # 连续两次不健康才动手，避免瞬时抖动误杀
        if ($misses -ge 2) {
            Stop-StaleProxy
            Start-Sleep -Seconds 2
            Start-Proxy
            Start-Sleep -Seconds 6
            if (Test-ProxyHealthy) {
                Write-Log 'proxy restored'
                $misses = 0
            } else {
                Write-Log 'proxy still unhealthy after restart'
            }
        }
    }
    Start-Sleep -Seconds $IntervalSec
}
