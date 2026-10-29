# 鲟鱼工作组 · 手动拉起全部常驻服务（2026-10-26 新增，03 号；当日 23:15 修订）
#
# 用法（在任何地方跑都行，包括 DSH 会话里、终端里）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File E:\DeepFish\avatar\start-services.ps1
#
# 为什么要有这个文件：
#   2026-10-26 的病根是「谁想拉服务，就在某个 DSH 会话里 Start-Process 一下」——
#   于是 bridge / relay / SnowLuma 成了 DSH 进程树（job 对象）的成员，DSH 一重启全被收走。
#   正确路径只有一条：**计划任务 XunyuAvatarSupervisor**（Session 1、InteractiveToken）
#   → supervisor.ps1 → 三个服务。
#
# 2026-10-26 23:12 实测修正（重要，别再走回头路）：
#   Win32_Process.Create 这条路**不可用**。WmiPrvSE.exe 跑在 Session 0（服务会话），
#   WMI 创建出来的进程也在 Session 0：
#     · `powershell -File supervisor.ps1` 直接「拒绝访问」，进程秒退、日志一个字不写
#       （对照：同样 WMI 起 `-Command "Set-Content ..."` 能成功 → 是 -File 这条路被拒）
#     · 就算用 -Command 硬拉，Session 0 没有桌面，窗口类服务起不来
#   所以本脚本主路径改成 Start-ScheduledTask；WMI 只作最后兜底，且必须用 -Command。

param(
    [string]$Avatar = 'E:\DeepFish\avatar',
    [string]$TaskName = 'XunyuAvatarSupervisor',
    [int]$WaitSec = 90
)

$ErrorActionPreference = 'Continue'

function Get-SupervisorPid {
    $want = Join-Path $Avatar 'supervisor.ps1'
    $p = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -notmatch 'supervisor-guard' -and $_.CommandLine -match [regex]::Escape($want) } |
        Select-Object -First 1
    if ($p) { return [int]$p.ProcessId }
    return 0
}

$supPid = Get-SupervisorPid
if ($supPid -gt 0) {
    Write-Output "守护已在跑 (pid=$supPid)，它会自己把服务拉起；本脚本不动它。"
} else {
    $launched = $false
    try {
        Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
        Write-Output "经计划任务拉起守护（$TaskName）——Session 1，父进程是 svchost"
        $launched = $true
    } catch {
        Write-Output ('计划任务启动失败：{0} → 退回 WMI（注意：会在 Session 0，窗口类服务起不来）' -f $_.Exception.Message)
    }
    if (-not $launched) {
        # 兜底必须是 -Command，不能 -File（Session 0 下 -File 报"拒绝访问"，实测 23:12）
        $cmd = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "& ''{0}''"' -f (Join-Path $Avatar 'supervisor.ps1')
        $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd }
        Write-Output ('经 WMI 兜底拉起：ReturnValue={0} pid={1}' -f $r.ReturnValue, $r.ProcessId)
    }
    # 2026-10-26 修：原来只等 2 秒就判定，进程还没落到 Process 列表里就误报「没起来」（23:06 骗过一次）。
    # 改成最多轮询 20 秒，每秒看一眼。
    $supNew = 0
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Seconds 1
        $supNew = Get-SupervisorPid
        if ($supNew -gt 0) { break }
    }
    if ($supNew -gt 0) {
        $par = (Get-CimInstance Win32_Process -Filter "ProcessId=$supNew").ParentProcessId
        $parName = (Get-CimInstance Win32_Process -Filter "ProcessId=$par" -ErrorAction SilentlyContinue).Name
        Write-Output "守护已起：pid=$supNew，父进程=$par ($parName)"
    } else {
        Write-Output "守护没起来（等了 20 秒），检查 state\supervisor.log 最后几行"
    }
}

Write-Output "等服务就位（最多 $WaitSec 秒）……"
$deadline = (Get-Date).AddSeconds($WaitSec)
do {
    Start-Sleep -Seconds 3
    $p3100 = Get-NetTCPConnection -LocalPort 3100 -State Listen -ErrorAction SilentlyContinue
    $p3001 = Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue
    $p9334 = Get-NetTCPConnection -LocalPort 9334 -State Listen -ErrorAction SilentlyContinue
} until (($p3100 -and $p3001 -and $p9334) -or (Get-Date) -gt $deadline)

foreach ($item in @(
    @{ n = 'bridge 3100'; c = $p3100 },
    @{ n = 'snowluma 3001'; c = $p3001 },
    @{ n = 'relay 9334'; c = $p9334 }
)) {
    if ($item.c) {
        $o = @($item.c)[0].OwningProcess
        $pp = (Get-CimInstance Win32_Process -Filter "ProcessId=$o" -ErrorAction SilentlyContinue).ParentProcessId
        $pn = (Get-CimInstance Win32_Process -Filter "ProcessId=$pp" -ErrorAction SilentlyContinue).Name
        Write-Output ('{0,-14} LISTEN pid={1,-6} 父进程={2} ({3})' -f $item.n, $o, $pp, $pn)
    } else {
        Write-Output ('{0,-14} 没起来（看 state\supervisor.log）' -f $item.n)
    }
}