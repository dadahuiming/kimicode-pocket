# KimiCode Pocket — 停止脚本（看门狗 + 代理）
#
# 用法: pwsh -File scripts/stop.ps1
# 注意: 不影响 cloudflared 服务，也不影响其它隧道/域名。

$ErrorActionPreference = 'Continue'

$Root  = Split-Path -Parent $PSScriptRoot
$Proxy = Join-Path $Root 'src\proxy.mjs'
$Port  = if ($env:POCKET_PORT) { $env:POCKET_PORT } else { '50980' }

Write-Host '停止看门狗...' -ForegroundColor Yellow
# 必须同时匹配 powershell.exe 与 pwsh.exe：
# 只看 powershell.exe 的话，用 pwsh 启动的看门狗活下来，30 秒后又把代理拉起来，
# 表现为「stop 杀不掉」。
#
# 匹配条件要精确到 `-File "<真实路径>"`：只按包含关系匹配时，任何命令行里
# 恰好出现「仓库目录 + watchdog.ps1」这两个字符串的进程都会被误杀
# （实测过一次：一个内联 -Command 调用把自己连同看门狗一起带走了）。
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
        $_.Name -in @('powershell.exe', 'pwsh.exe') -and
        $_.CommandLine -and
        $_.CommandLine -like "*-File `"$Root*" -and
        $_.CommandLine -like '*watchdog.ps1*' -and
        $_.ProcessId -ne $PID
    } |
    ForEach-Object {
        Write-Host "  kill watchdog pid $($_.ProcessId) ($($_.Name))"
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }

Write-Host '停止代理...' -ForegroundColor Yellow
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$Proxy*" } |
    ForEach-Object {
        Write-Host "  kill proxy pid $($_.ProcessId)"
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }

Start-Sleep -Seconds 2
Write-Host ''
Write-Host '验证：' -ForegroundColor Cyan
try {
    Invoke-WebRequest "http://127.0.0.1:$Port/__healthz" -UseBasicParsing -TimeoutSec 3 | Out-Null
    Write-Host '  [x] 代理仍在运行（可能不是本仓库的实例，或看门狗没被杀掉）' -ForegroundColor Red
} catch {
    Write-Host '  [ok] 代理已停止' -ForegroundColor Green
}
Write-Host '  cloudflared 服务未受影响（其它域名照常）'
