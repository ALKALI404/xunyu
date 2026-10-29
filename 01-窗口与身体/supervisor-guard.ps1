# 鲟鱼工作组 · 守护的守护（watchdog of watchdog）
#
# 为什么需要：supervisor.ps1 是单实例（命名互斥量）。万一它卡死——进程还在、
# 互斥量还占着、但循环不再推进——计划任务每 5 分钟拉起的新实例会直接退出，
# 结果就是「守护看着在，其实没人管」。这个脚本专门处理这种情况。
#
# 判定：state\supervisor.json 里的 at 超过 120 秒没更新 = 卡死。
# 处理：确认那个 pid 确实是 supervisor.ps1 → 杀掉 → 重新启动计划任务。
#
# 由计划任务 XunyuAvatarSupervisorGuard 每 5 分钟跑一次（XML 里是 PT5M；2026-10-26 核对过），跑完即退。

param(
    [string]$Avatar = "E:\DeepFish\avatar",
    [int]$StaleSec = 120,
    [string]$TaskName = 'XunyuAvatarSupervisor'
)

$ErrorActionPreference = 'Continue'
$stateFile = Join-Path $Avatar 'state\supervisor.json'
$logFile = Join-Path $Avatar 'state\supervisor-guard.log'

function Write-GuardLog([string]$msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    try {
        if ((Test-Path $logFile) -and ((Get-Item $logFile).Length -gt 1MB)) {
            Move-Item -Path $logFile -Destination ($logFile + '.1') -Force
        }
        Add-Content -Path $logFile -Value $line -Encoding UTF8
    } catch { }
}

function Get-SupervisorPid {
    # 2026-10-26：原来用 -like '*supervisor.ps1*' —— 计划任务每 5 分钟的触发会起一个
    # 短命实例（拿到不互斥量就退出），通配符可能正好抓到它，把"卡死判定"建立在错误 pid 上；
    # 更糟的是它也可能匹配到别的脚本。改成匹配**精确的 -File 路径**，并排除 guard 自身。
    try {
        $want = 'E:\DeepFish\avatar\supervisor.ps1'
        $p = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction Stop |
            Where-Object {
                $_.CommandLine -and
                $_.CommandLine -notmatch 'supervisor-guard\.ps1' -and
                $_.CommandLine -match ('-File\s+"?' + [regex]::Escape($want) + '"?(\s|$)')
            } |
            Select-Object -First 1
        if ($p) { return [int]$p.ProcessId }
    } catch { }
    return 0
}

$stale = $true
$ageSec = -1
$pidFromFile = 0
try {
    $j = Get-Content $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $pidFromFile = [int]$j.pid
    $t = [datetime]::ParseExact($j.at, 'yyyy-MM-dd HH:mm:ss', $null)
    $ageSec = [int]((Get-Date) - $t).TotalSeconds
    if ($ageSec -le $StaleSec) { $stale = $false }
} catch {
    Write-GuardLog "读不到 supervisor.json（$($_.Exception.Message)），按卡死处理"
}

if (-not $stale) { exit 0 }

Write-GuardLog "supervisor 心跳停了 ${ageSec}s（记录 pid=$pidFromFile）→ 处理"

# 先确认 pid 确实是我们的守护，别误杀别的 powershell
$killed = $false
$livePid = Get-SupervisorPid
foreach ($cand in @($livePid, $pidFromFile)) {
    if ($cand -le 0) { continue }
    try {
        $proc = Get-Process -Id $cand -ErrorAction Stop
        if ($proc.ProcessName -ne 'powershell') { continue }
        if ($livePid -ne $cand) { continue }   # 只杀命令行确认过的那一个
        Stop-Process -Id $cand -Force -ErrorAction Stop
        Write-GuardLog "已杀掉卡死的守护 pid=$cand"
        $killed = $true
    } catch { }
    break
}
if (-not $killed) { Write-GuardLog "没找到活着的守护进程（可能已退出），直接重启" }

Start-Sleep -Seconds 2
try {
    Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    Write-GuardLog "已通过计划任务重启守护（$TaskName）"
} catch {
    Write-GuardLog "计划任务重启失败（$($_.Exception.Message)），改为直接拉起"
    try {
        Start-Process -FilePath 'powershell.exe' `
            -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', (Join-Path $Avatar 'supervisor.ps1') `
            -WindowStyle Hidden
    } catch { Write-GuardLog "直接拉起也失败：$($_.Exception.Message)" }
}
