# 鲟鱼工作组 · 进程守护（单实例 + 自动重启）
#
# 管这些：
#   relay  9334  —— 死了就拉起来（node relay.mjs）
#   window       —— 死了就拉起来（powershell -STA -File chat-window.ps1）
#   bridge 3100  —— 只监测；连续 3 次（约 30 秒）不通才尝试 start.bat（它自己有循环）
#   body   9335  —— 死了就拉起来（node body-service.mjs）
#   snowluma 3001 —— 死了就拉起来（2026-10-26 加：它是 QQ 网关，以前没人管）
#   mod    9333  —— 只监测（游戏进程，不能替它重启）
#
# 2026-10-26 修「DSH 重启带走 bridge/supervisor/SnowLuma」：
#   病根是这些进程曾经被**在 DSH 里边**的脚本直接 Start-Process 起来，于是成了 DSH
#   进程树（job 对象）的成员，DSH 一退出整棵树被收走。现在只认一条路：
#   计划任务 XunyuAvatarSupervisor → 本脚本（父进程是 svchost/Task Scheduler）→ 所有子服务。
#   手动拉起请用 avatar\start-services.ps1（它经 WMI 脱离当前进程树），不要在本机任何
#   DSH 会话里直接 Start-Process 这些服务。
#
# 为什么需要它：中继/窗口以前是「会话的后台作业」，DSH 会话一归档就跟着死；
# 现在由计划任务把守护进程挂在系统上，和会话无关。
#
# 单实例：命名互斥量 Local\XunyuAvatarSupervisor；重复启动会立刻退出。
# 日志：state\supervisor.log（超过 2MB 轮转为 .1）
# 状态：state\supervisor.json（给窗口/排查看最近一次检查结果）

param(
    [int]$IntervalSec = 3,
    [string]$Avatar = "E:\DeepFish\avatar",
    [string]$BridgeDir = "E:\DeepFish\qq-bridge-0.2.1-r1\qq-bridge-0.2.1-r1",
    [string]$SnowLumaDir = "E:\DeepFish\SnowLuma-v2.1.1-win-x64"
)

$ErrorActionPreference = 'Continue'

# ── 单实例 ────────────────────────────────────────────────────────────────
# 2026-10-26 修（实测踩到）：守护被**强杀**（Stop-Process -Force / 任务管理器结束）时，
# 命名互斥量会变成「被遗弃」状态；下一次 WaitOne(0) 会抛 AbandonedMutexException。
# 原来这里没有 try/catch → 异常直接打断脚本 → 新实例**静默退出、日志一个字都不写**，
# 外面看起来就是「拉不起来」。23:06 实测：WMI 拉起的 pid 30240 就是这么消失的。
# 现在：这个异常恰恰说明内核已经把锁判给我们了，当拿到锁继续跑，并记一笔。
$mutex = New-Object System.Threading.Mutex($false, 'Local\XunyuAvatarSupervisor')
$gotMutex = $false
$mutexWasAbandoned = $false
try {
    $gotMutex = $mutex.WaitOne(0)
} catch [System.Threading.AbandonedMutexException] {
    $gotMutex = $true
    $mutexWasAbandoned = $true
} catch {
    $gotMutex = $false
}
if (-not $gotMutex) { exit 0 }

$logFile = Join-Path $Avatar 'state\supervisor.log'
$stateFile = Join-Path $Avatar 'state\supervisor.json'

function Write-Log([string]$msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    try {
        if ((Test-Path $logFile) -and ((Get-Item $logFile).Length -gt 2MB)) {
            Move-Item -Path $logFile -Destination ($logFile + '.1') -Force
        }
        Add-Content -Path $logFile -Value $line -Encoding UTF8
    } catch { }
}

function Test-Http([string]$url, [int]$timeoutSec = 3) {
    try {
        $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec $timeoutSec
        return [bool]($r.StatusCode -ge 200 -and $r.StatusCode -lt 500)
    } catch {
        # 401/403 说明服务活着（只是没带令牌）
        if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -in 401, 403) { return $true }
        return $false
    }
}

function Get-WindowProc {
    # D39（2026-10-28，03·维护）：旧壳 XunyuChatWindow 已退役（改名 .retired-20261028.exe），
    # 窗口监护**只认新壳** XunyuWebWindow（WebView2，06 交付）。
    # 不再回退到「标题=鲟鱼」的 ps1 窗口：新旧两个壳同时算活着时，会互相把对方判成"在"，
    # 出问题时也看不出到底是哪个壳。
    Get-Process -Name 'XunyuWebWindow' -ErrorAction SilentlyContinue | Select-Object -First 1
}

# ── 日志轮转（2026-10-25）：重定向出来的 stdout 句柄在子进程手里，外部改名会 EBUSY，
# 所以在**每次拉起子进程之前**把上一轮的日志挪走。超过 2MB 才轮转，保留 3 份。
$script:LogMaxBytes = 2MB
$script:LogKeep = 3
function Rotate-Log([string]$Path) {
    try {
        if (-not (Test-Path $Path)) { return }
        if ((Get-Item $Path).Length -lt $script:LogMaxBytes) { return }
        for ($i = $script:LogKeep - 1; $i -ge 1; $i--) {
            $from = "$Path.$i"
            $to = "$Path.$($i + 1)"
            if (Test-Path $from) { Move-Item -Force -Path $from -Destination $to -ErrorAction SilentlyContinue }
        }
        Move-Item -Force -Path $Path -Destination "$Path.1" -ErrorAction SilentlyContinue
    } catch { }
}

function Start-Relay {
    Rotate-Log (Join-Path $Avatar 'state\relay.out.log')
    Rotate-Log (Join-Path $Avatar 'state\relay.err.log')
    Start-Process -FilePath 'node' -ArgumentList 'relay.mjs' -WorkingDirectory $Avatar -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $Avatar 'state\relay.out.log') `
        -RedirectStandardError (Join-Path $Avatar 'state\relay.err.log')
}

function Start-BridgeHidden {
    # 2026-10-26：以前是 Start-Process start.bat -WindowStyle Minimized —— 那个最小化的 cmd
    # 就是主人看到的弹窗；更要命的是**桥接就活在那个控制台里**，控制台一关就 SIGHUP
    # （state\bridge-crash.log 里 18:29/18:31 两条 SIGHUP，以及之后守护又拉一次 = 又弹一个窗）。
    # 现在经 wscript 以「完全无窗口」启动：不产生可见窗口，桥接也不再依附任何用户会关掉的控制台。
    $vbs = Join-Path $BridgeDir 'start-hidden.vbs'
    if (Test-Path $vbs) {
        # 路径无空格，直接传（避免多层引号把 PS 5.1 的解析器绕进去）
        Start-Process -FilePath 'wscript.exe' -ArgumentList @('//B', '//Nologo', $vbs) -WindowStyle Hidden
        return
    }
    # 没有 vbs 就退化成隐藏窗口（至少不闪 Minimized 那个框）
    Start-Process -FilePath (Join-Path $BridgeDir 'start.bat') -WorkingDirectory $BridgeDir -WindowStyle Hidden
}

function Start-Probe {
    # 2026-10-28 D4（03·维护）：探针原来没人守 —— 起它的 cmd 宿主早断代，重启机器就没了。
    # 用现成的 start-probe.vbs（wscript //B，无控制台），与 bridge 的隐藏启动同一范式。
    $vbs = Join-Path $Avatar 'start-probe.vbs'
    if (Test-Path $vbs) {
        Start-Process -FilePath 'wscript.exe' -ArgumentList @('//B', '//Nologo', $vbs) -WindowStyle Hidden
        return
    }
    Start-Process -FilePath 'node' -ArgumentList @((Join-Path $Avatar 'probe-bridge.mjs')) -WorkingDirectory $Avatar -WindowStyle Hidden
}
function Start-Window {
    # D39（2026-10-28，03·维护）：只起新壳（winexe，天生没有控制台、启动 <0.3s）。
    # 旧壳 XunyuChatWindow.exe 已退役为 .retired-20261028.exe，**不回退**到它；
    # 回滚靠手动改名 + 本函数改回去（见 records\交付\03-20261028-D39.md）。
    # 注意**不要**给 exe 加 -WindowStyle Hidden：那会把窗体本身按 SW_HIDE 起来。
    $exePath = Join-Path $Avatar 'window\XunyuWebWindow.exe'
    if (-not (Test-Path $exePath)) { throw "找不到新壳 $exePath（旧壳已退役，不再回退）" }
    # 兜底：万一有人手动起了旧壳，先把它关掉，保证「同一时刻只有一个壳」
    Get-Process -Name 'XunyuChatWindow' -ErrorAction SilentlyContinue |
        ForEach-Object { try { $_.CloseMainWindow() | Out-Null } catch { } }
    Start-Process -FilePath $exePath -WorkingDirectory (Join-Path $Avatar 'window')
}

function Start-BodyService {
    Rotate-Log (Join-Path $Avatar 'state\body-service.out.log')
    Rotate-Log (Join-Path $Avatar 'state\body-service.err.log')
    Start-Process -FilePath 'node' -ArgumentList 'body-service.mjs' -WorkingDirectory $Avatar -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $Avatar 'state\body-service.out.log') `
        -RedirectStandardError (Join-Path $Avatar 'state\body-service.err.log')
}

# ── SnowLuma（QQ 网关，3001）──────────────────────────────────────────────
# 2026-10-26 新增。以前它完全没人看护：谁想起来就在某个会话里手动起一次，
# 于是它常年挂在 DSH 进程树里，DSH 一重启就没了。
function Test-Tcp {
    param([string]$Target = '127.0.0.1', [int]$Port = 3001, [int]$TimeoutMs = 1500)
    $c = New-Object System.Net.Sockets.TcpClient
    try {
        $iar = $c.BeginConnect($Target, $Port, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) { return $false }
        $c.EndConnect($iar)
        return [bool]$c.Connected
    } catch { return $false } finally { try { $c.Close() } catch { } }
}

function Get-SnowLumaProcs {
    # 判重：SnowLuma 是「启动器 + 真正跑的那个」两个 node 进程，命令行里都带 SnowLuma 和 index.mjs
    @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -match 'SnowLuma' -and $_.CommandLine -match 'index\.mjs' })
}

function Start-SnowLuma {
    $procs = Get-SnowLumaProcs
    if ($procs.Count -gt 0) {
        $ids = ($procs | ForEach-Object { $_.ProcessId }) -join ','
        Write-Log ('SnowLuma 需要拉起，但已有进程在（pid={0}）→ 不重复启动' -f $ids)
        return
    }
    # 2026-10-26 实测：走 SnowLuma 目录里的 start-hidden.vbs（wscript）时进程起不来、也没日志
    # （连试 5 次 3001 都没起来）；改成直接 node.exe + 重定向就正常，而且 stdout 落到
    # state\snowluma.out.log，出事能查。所以这里不用 vbs，和 relay/body 用同一种起法。
    Rotate-Log (Join-Path $Avatar 'state\snowluma.out.log')
    Rotate-Log (Join-Path $Avatar 'state\snowluma.err.log')
    Start-Process -FilePath (Join-Path $SnowLumaDir 'node.exe') -ArgumentList 'index.mjs' `
        -WorkingDirectory $SnowLumaDir -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $Avatar 'state\snowluma.out.log') `
        -RedirectStandardError (Join-Path $Avatar 'state\snowluma.err.log')
}

# ── 自己的祖先链（2026-10-26）：写进日志，事后一眼能看出是不是被 DSH 带大的 ──
# 注意：只走到 services.exe / wininit.exe 就停。Windows 会回收 PID，再往上走会撞到
# 「父 PID 已被别的进程复用」的假链（实测把 wininit 的父 PID 认成了 DSH）。
function Get-Ancestry {
    $parts = @()
    $cur = $PID
    $stopNames = @('services.exe', 'wininit.exe', 'smss.exe')
    for ($i = 0; $i -lt 8; $i++) {
        $p = Get-CimInstance Win32_Process -Filter "ProcessId=$cur" -ErrorAction SilentlyContinue
        if (-not $p) { break }
        $parts += ("{0}:{1}" -f $p.ProcessId, $p.Name)
        if ($stopNames -contains $p.Name) { break }
        if ($p.ParentProcessId -le 4 -or $p.ParentProcessId -eq $cur) { break }
        $cur = [int]$p.ParentProcessId
    }
    return ($parts -join ' <- ')
}

# ── 掉线事件（2026-10-26 23:50 新增，03）──────────────────────────────────
# 为什么加：3100 今天掉了 3 次（22:33 / 23:05 / 23:13:45），但原来只有「连续 3 次不通
# 才去拉」那一刻才写一行日志——**掉的那一刻没有任何独立痕迹**，事后回答不了
# 「几点几分掉的 / 掉了多久 / 回来的是不是同一个 pid」。
# 现在：每轮（IntervalSec=10 秒）比对状态，只在**变化**时落一行到 state\service-events.log，
# 带时间戳 + 端口 + 当时的监听 pid。启动时先落一行基线。2MB 轮转。
$script:eventLog = Join-Path $Avatar 'state\service-events.log'

function Write-SvcEvent([string]$Name, [int]$Port, [bool]$Up) {
    $ownerPid = 0
    if ($Up) {
        try {
            $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($c) { $ownerPid = [int]$c.OwningProcess }
        } catch { }
    }
    $line = "[{0}] {1,-9} {2,-4} port={3} pid={4}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Name, $(if ($Up) { 'UP' } else { 'DOWN' }), $Port, $ownerPid
    try {
        if ((Test-Path $script:eventLog) -and ((Get-Item $script:eventLog).Length -gt 2MB)) {
            Move-Item -Path $script:eventLog -Destination ($script:eventLog + '.1') -Force
        }
        Add-Content -Path $script:eventLog -Value $line -Encoding UTF8
    } catch { }
}

# ── 报丧（D7-v2，2026-10-28，03·维护）──────────────────────────────────────
# 疼痛链路的第一跳：supervisor 不再只是"发现死了就重启"，还要把这件事报出去。
# 事件：crash/exit（进程退出）、start-failed（本守护拉起失败）、restart-ok（恢复/被 heal 拉回）
# 铁律：总线没起来不许卡住、不许崩。所以这里**不等响应**，连接 250ms 上限，
#       失败一律吞掉，并写一行自己的 state\pain-sent.jsonl（sent=false + error）。
$script:painPort = 9339
$script:painLogFile = Join-Path $Avatar 'state\pain-sent.jsonl'
function Send-Pain([string]$module, [string]$pain, [string]$code) {
    $at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $rec = [ordered]@{ pain = $pain; module = $module; code = $code; at = $at; by = 'supervisor' }
    $json = ($rec | ConvertTo-Json -Compress)
    $ok = $false; $err = ''
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $iar = $client.BeginConnect('127.0.0.1', $script:painPort, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne(250, $false)) { throw 'connect timeout(250ms)' }
        $client.EndConnect($iar)
        $body = [System.Text.Encoding]::UTF8.GetBytes($json)
        $head = "POST /pain HTTP/1.1`r`nHost: 127.0.0.1:$($script:painPort)`r`nContent-Type: application/json; charset=utf-8`r`nContent-Length: $($body.Length)`r`nConnection: close`r`n`r`n"
        $hb = [System.Text.Encoding]::ASCII.GetBytes($head)
        $s = $client.GetStream()
        $s.Write($hb, 0, $hb.Length)
        $s.Write($body, 0, $body.Length)
        $s.Flush()
        $ok = $true
    } catch { $err = $_.Exception.Message } finally { try { $client.Close() } catch { } }
    $line = [ordered]@{ at = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'); module = $module; pain = $pain; code = $code; sent = $ok; error = $err }
    try { Add-Content -Path $script:painLogFile -Value ($line | ConvertTo-Json -Compress) -Encoding UTF8 } catch { }
    if (-not $ok) { Write-Log ("pain 发送失败（吞掉，不阻塞）module={0} pain={1} code={2}：{3}" -f $module, $pain, $code, $err) }
    return $ok
}

# ── 疼痛链路常驻（D7-v2 §二.2，2026-10-28，03·维护）──────────────────────────
# 两个常驻件都挂在守护下面（跟探针同级），因为它们必须比任何会话活得久：
#   pain-bus   9339      疼痛总线（04 的 avatar\pain-bus.mjs）—— 它不在，整条链路就是哑的
#   self-heal  --watch   控制器（04 的 scripts\self-heal.mjs v2）—— 它是控制器，死了等于没人自愈
# 纪律：先判重再起；任何一步失败只写日志 + 报丧，不让主循环挂掉。
# 为什么必须由守护托管：04 的 self-heal 打死不自己起进程（工单要求），而 pain-bus 原来
# 没有任何常驻入口——它只在手动测试时活过，会话一退链路就断。
#
# 2026-10-28 16:45 实测踩到：Get-CimInstance 偶发一次拿不到结果（被 SilentlyContinue 吞成空数组），
# 于是判成「不在」→ 又拉了一个 self-heal（实测 pid 46028 + 47128 并存）。两个控制器同时读
# /pain/status 会各做一遍缩回/复验。所以这里加三道闸：
#   ① 查询失败 != 不在：查空之后 250ms 再查一次，两次都空才算不在；
#   ② 拉起后轮询 ≤3s 认领 pid，别设 800ms 就下结论；
#   ③ 兜底去重：真的出现两个，只留最早那个，其余杀掉并记日志。
$script:busPort = 9339
$script:workDir = '<工作区>'
$script:selfHealPath = '<工作区>\scripts\self-heal.mjs'
$script:busRestarts = 0
$script:healRestarts = 0
$script:busPrev = $null
$script:selfHealPrev = $null
$script:selfHealPid = 0

# 按命令行找 node 进程。查不到时**再查一次**（WMI 偶发空结果，不能当「不在」用）。
function Get-NodeByCmd([string]$pattern) {
    $probe = {
        @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -and $_.CommandLine -match $pattern })
    }
    $r = @(& $probe)
    if ($r.Count -eq 0) {
        $err = $null
        try { $null = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop } catch { $err = $_.Exception.Message }
        if ($err) { Write-Log ("WMI 查询失败（不当成『不在』）：{0}" -f $err) }
        Start-Sleep -Milliseconds 250
        $r = @(& $probe)
    }
    return $r
}

function Start-PainBus {
    Rotate-Log (Join-Path $Avatar 'state\pain-bus.out.log')
    Rotate-Log (Join-Path $Avatar 'state\pain-bus.err.log')
    Start-Process -FilePath 'node' -ArgumentList 'pain-bus.mjs' -WorkingDirectory $Avatar -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $Avatar 'state\pain-bus.out.log') `
        -RedirectStandardError (Join-Path $Avatar 'state\pain-bus.err.log')
}
function Start-SelfHealWatch {
    if (-not (Test-Path $script:selfHealPath)) { throw "找不到 $($script:selfHealPath)" }
    Rotate-Log (Join-Path $script:workDir 'state\self-heal.watch.out.log')
    Rotate-Log (Join-Path $script:workDir 'state\self-heal.watch.err.log')
    Start-Process -FilePath 'node' -ArgumentList @('scripts\self-heal.mjs', '--watch') -WorkingDirectory $script:workDir -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $script:workDir 'state\self-heal.watch.out.log') `
        -RedirectStandardError (Join-Path $script:workDir 'state\self-heal.watch.err.log')
}

# 只留一个（pid 最小的那个；同一次拉起里最早的就是它），其余杀掉。pattern 由调用方给。
function Limit-Single([string]$pattern, [int]$keepPid) {
    $all = Get-NodeByCmd $pattern
    if ($all.Count -le 1) { return $keepPid }
    $sorted = @($all | Sort-Object { [int]$_.ProcessId })
    $keep = if ($keepPid -gt 0) { $keepPid } else { [int]$sorted[0].ProcessId }
    foreach ($p in $sorted) {
        if ([int]$p.ProcessId -ne $keep) {
            Write-Log ("发现重复进程（{0}，pid={1}）→ 杀掉，只留 pid={2}" -f $pattern, $p.ProcessId, $keep)
            try { Stop-Process -Id ([int]$p.ProcessId) -Force -ErrorAction SilentlyContinue } catch { }
        }
    }
    return $keep
}

# 拉起后轮询认领 pid（≤3s）。返回 0 表示没认领到。
function Wait-NodePid([string]$pattern, [int]$timeoutMs = 3000) {
    $deadline = (Get-Date).AddMilliseconds($timeoutMs)
    while ((Get-Date) -lt $deadline) {
        $p = Get-NodeByCmd $pattern
        if ($p.Count -gt 0) { return [int](@($p | Sort-Object { [int]$_.ProcessId })[0].ProcessId) }
        Start-Sleep -Milliseconds 300
    }
    return 0
}

# 一轮判活 + 拉起。只在这两个常驻件上动手，别的一概不碰。
function Maintain-Keepers {
    # ── ① 疼痛总线：端口通即活（TCP 比 WMI 可靠，也不用 250ms 重试）────────────
    $busUp = Test-Tcp -Port $script:busPort -TimeoutMs 400
    if ($script:busPrev -eq $true -and -not $busUp) {
        Write-Log '疼痛总线 9339 掉了 → 报丧 crash/watch-exit（总线自己在死，这条只会落在 pain-sent.jsonl 的 sent=false）'
        Send-Pain 'pain-bus' 'crash' 'watch-exit' | Out-Null
    }
    if (-not $busUp) {
        $bp = Get-NodeByCmd 'pain-bus\.mjs'
        if ($bp.Count -gt 0) {
            if ($script:busPrev -ne $false) { Write-Log ("疼痛总线 9339 不通，但 pain-bus 进程在（pid={0}）→ 等它绑端口，不重复拉" -f $bp[0].ProcessId) }
            $null = Limit-Single 'pain-bus\.mjs' ([int]$bp[0].ProcessId)
        } else {
            $script:busRestarts++
            Write-Log ("疼痛总线 9339 不通且无 pain-bus 进程 → 第 {0} 次拉起" -f $script:busRestarts)
            try {
                Start-PainBus
                $deadline = (Get-Date).AddSeconds(5)
                while ((Get-Date) -lt $deadline) {
                    Start-Sleep -Milliseconds 300
                    $busUp = Test-Tcp -Port $script:busPort -TimeoutMs 400
                    if ($busUp) { break }
                }
            } catch {
                Write-Log ("疼痛总线拉起失败：{0}" -f $_.Exception.Message)
                Send-Pain 'pain-bus' 'start-failed' 'start-error' | Out-Null
            }
        }
    }
    if ($script:busPrev -eq $false -and $busUp) {
        Write-Log '疼痛总线 9339 回来了'
        Send-Pain 'pain-bus' 'restart-ok' 'up' | Out-Null
    }
    $script:busPrev = $busUp

    # ── ② 控制器 self-heal --watch：没有端口，用 pid 判活（失效才回退查命令行）──
    $alive = $false
    if ($script:selfHealPid -gt 0) { $alive = [bool](Get-Process -Id $script:selfHealPid -ErrorAction SilentlyContinue) }
    if (-not $alive) {
        $hp = Get-NodeByCmd 'self-heal\.mjs'
        if ($hp.Count -gt 0) {
            $script:selfHealPid = Limit-Single 'self-heal\.mjs' ([int](@($hp | Sort-Object { [int]$_.ProcessId })[0].ProcessId))
            $alive = $true
        }
    } else {
        $null = Limit-Single 'self-heal\.mjs' $script:selfHealPid
    }
    if ($script:selfHealPrev -eq $true -and -not $alive) {
        Write-Log 'self-heal --watch 掉了（控制器没了 = 没人自愈）→ 报丧 crash/watch-exit'
        Send-Pain 'self-heal' 'crash' 'watch-exit' | Out-Null
    }
    if (-not $alive) {
        $script:healRestarts++
        Write-Log ("self-heal --watch 不在 → 第 {0} 次拉起" -f $script:healRestarts)
        try {
            Start-SelfHealWatch
            $newPid = Wait-NodePid 'self-heal\.mjs' 3000
            if ($newPid -gt 0) { $script:selfHealPid = Limit-Single 'self-heal\.mjs' $newPid; $alive = $true }
            else { Write-Log 'self-heal --watch 拉起后 3s 内没认领到 pid（下一轮再判）' }
        } catch {
            Write-Log ("self-heal --watch 拉起失败：{0}" -f $_.Exception.Message)
            Send-Pain 'self-heal' 'start-failed' 'start-error' | Out-Null
        }
    }
    if ($script:selfHealPrev -eq $false -and $alive) {
        Write-Log ("self-heal --watch 回来了（pid={0}）" -f $script:selfHealPid)
        Send-Pain 'self-heal' 'restart-ok' 'up' | Out-Null
    }
    $script:selfHealPrev = $alive
}

# ── 受控重启入口（D7 §二.1，2026-10-28，03·维护）────────────────────────────
# 为什么要有它：self-heal 不能自己 Start-Process 服务（那样会变成 heal 的子树，DSH/会话一退出
# 就被收走）。改成：heal 打一个本地 HTTP 请求，由**守护自己**执行重启，走它原来那套 Start-*。
# 三条硬要求：只接受本机、只接受白名单、幂等 + 同模块 60s 冷却 + 写日志。
$script:healPort = 9338
$script:HealCooldownSec = 60
$script:healStateFile = Join-Path $Avatar 'state\heal-state.json'
$script:healLogFile = Join-Path $Avatar 'state\heal-endpoint.jsonl'
$script:healListener = $null

# 白名单表：只有这里列出的模块能被 heal。
# mod(9333) 只监测不重启；supervisor 自己不在表里（避免自杀式循环）；wecom(8788) 归另一个 watchdog。
$script:healModules = [ordered]@{
    'relay'    = @{ port = 9334; kind = 'port';   start = 'Start-Relay';        note = '中继（窗口/QQ 右侧链路）' }
    'body'     = @{ port = 9335; kind = 'port';   start = 'Start-BodyService';  note = '身体服务（/say /anim）' }
    'snowluma' = @{ port = 3001; kind = 'port';   start = 'Start-SnowLuma';     note = 'QQ 网关 OneBot' }
    'bridge'   = @{ port = 3100; kind = 'port';   start = 'Start-BridgeHidden'; note = '桥接；连 start.bat 宿主一起杀，再由守护经 wscript 重起' }
    'probe'    = @{ port = 9337; kind = 'port';   start = 'Start-Probe';        note = 'bridge 契约探针（D4 纳入守护）' }
    'window'   = @{ port = 0;    kind = 'window'; start = 'Start-Window';       note = '对话窗 GUI；主人点 × 关掉的不救' }
}
$script:healLast = @{}

try {
    $st = Get-Content $script:healStateFile -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($p in $st.PSObject.Properties) {
        try { $script:healLast[$p.Name] = [datetime]::Parse($st.$($p.Name).at) } catch { }
    }
} catch { }

function Save-HealState {
    $o = [ordered]@{}
    foreach ($k in @($script:healLast.Keys)) { $o[$k] = @{ at = $script:healLast[$k].ToString('yyyy-MM-dd HH:mm:ss') } }
    try { ($o | ConvertTo-Json -Depth 4 -Compress) | Set-Content -Path $script:healStateFile -Encoding UTF8 } catch { }
}
function Write-HealLog($rec) {
    try { Add-Content -Path $script:healLogFile -Value ($rec | ConvertTo-Json -Compress -Depth 5) -Encoding UTF8 } catch { }
}
function Get-PortPid([int]$p) {
    try {
        $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($c) { return [int]$c.OwningProcess }
    } catch { }
    return 0
}
function Invoke-Heal([string]$mod, [string]$who) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $res = [ordered]@{ at = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'); module = $mod; ok = $false; by = $who }
    if (-not $script:healModules.Contains($mod)) {
        $res.code = 'unknown-module'; $res.http = 400; $res.error = "白名单里没有 $mod（可 heal：$($script:healModules.Keys -join ',')）"
        Write-HealLog $res; return $res
    }
    $m = $script:healModules[$mod]
    # 冷却 = 幂等保护：同模块 60s 内只干一次
    if ($script:healLast.ContainsKey($mod)) {
        $age = ((Get-Date) - $script:healLast[$mod]).TotalSeconds
        if ($age -lt $script:HealCooldownSec) {
            $res.code = 'cooldown'; $res.http = 429
            $res.retryAfterSec = [int][math]::Ceiling($script:HealCooldownSec - $age)
            $res.error = "同模块 60s 冷却中，还剩 $($res.retryAfterSec)s"
            Write-HealLog $res
            Write-Log ("heal {0} 被冷却挡下（还剩 {1}s，请求方 {2}）" -f $mod, $res.retryAfterSec, $who)
            return $res
        }
    }
    if ($m.kind -eq 'window' -and (Test-Path (Join-Path $Avatar 'state\window-user-closed'))) {
        $res.code = 'window-closed-by-user'; $res.http = 409
        $res.error = '主人点 × 关掉的窗口，按关窗策略 C 不救'
        Write-HealLog $res; Write-Log ("heal window 被拒：窗口是用户关的（marker 在）") ; return $res
    }
    $before = 0
    if ($m.kind -eq 'window') { $w = Get-WindowProc; if ($w) { $before = [int]$w.Id } }
    else { $before = Get-PortPid ([int]$m.port) }
    $res.pidBefore = $before
    $script:healLast[$mod] = Get-Date
    Save-HealState
    Write-Log ("heal 请求 module={0} by={1} 当前 pid={2} → 受控重启" -f $mod, $who, $before)
    # 杀（bridge 要连 start.bat 宿主；snowluma 是启动器+服务两个 node）
    try {
        if ($m.kind -eq 'window') {
            if ($before -gt 0) { Stop-Process -Id $before -Force -ErrorAction SilentlyContinue }
        } elseif ($mod -eq 'bridge') {
            $nodes = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*src/bridge.js*' })
            $hosts = @(Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and $_.CommandLine -match 'start\.bat' })
            foreach ($n in $nodes) { Stop-Process -Id ([int]$n.ProcessId) -Force -ErrorAction SilentlyContinue }
            foreach ($h in $hosts) { Stop-Process -Id ([int]$h.ProcessId) -Force -ErrorAction SilentlyContinue }
        } elseif ($mod -eq 'snowluma') {
            $ps2 = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and $_.CommandLine -match 'SnowLuma' -and $_.CommandLine -match 'index\.mjs' })
            foreach ($x in $ps2) { Stop-Process -Id ([int]$x.ProcessId) -Force -ErrorAction SilentlyContinue }
        } else {
            if ($before -gt 0) { Stop-Process -Id $before -Force -ErrorAction SilentlyContinue }
        }
    } catch { }
    # 拉起：复用守护自己的 Start-*（heal 自己不起进程）
    try { & $m.start } catch { Write-Log ("heal {0} 调用 {1} 失败：{2}" -f $mod, $m.start, $_.Exception.Message) }
    # 等回来（≤20s）
    $deadline = (Get-Date).AddSeconds(20)
    $after = 0
    while ((Get-Date) -lt $deadline) {
        if ($m.kind -eq 'window') {
            $w2 = Get-WindowProc; if ($w2) { $after = [int]$w2.Id; break }
        } else {
            $after = Get-PortPid ([int]$m.port)
            if ($after -gt 0 -and $after -ne $before) { break }
        }
        Start-Sleep -Milliseconds 250
    }
    $sw.Stop()
    $res.pidAfter = $after
    $res.ms = [int]$sw.ElapsedMilliseconds
    $res.healed = ($after -gt 0)
    $res.ok = [bool]$res.healed
    $res.http = 200
    if (-not $res.healed) { $res.code = 'not-recovered'; $res.error = '20s 内端口/窗口没回来' }
    if ($res.healed) { Write-Log ("heal {0} 完成：pid {1} → {2}，{3}ms" -f $mod, $before, $after, $res.ms); Send-Pain $mod 'restart-ok' 'heal' | Out-Null }
    else { Write-Log ("heal {0} 未恢复：{1}ms 内没回来" -f $mod, $res.ms) }
    Write-HealLog $res
    return $res
}
function Read-HttpText($client, [int]$maxBytes = 8192) {
    $stream = $client.GetStream()
    $stream.ReadTimeout = 2000
    $buf = New-Object byte[] 1024
    $sb = New-Object System.Text.StringBuilder
    $deadline = (Get-Date).AddSeconds(2)
    while ((Get-Date) -lt $deadline) {
        if ($stream.DataAvailable) {
            $n = $stream.Read($buf, 0, $buf.Length)
            if ($n -le 0) { break }
            [void]$sb.Append([System.Text.Encoding]::ASCII.GetString($buf, 0, $n))
            if ($sb.Length -gt $maxBytes) { break }
            if ($sb.ToString().Contains("`r`n`r`n")) { break }
        } else { Start-Sleep -Milliseconds 15 }
    }
    return $sb.ToString()
}
function Send-HttpJson($client, [int]$code, $obj) {
    $reason = switch ($code) { 200 { 'OK' } 400 { 'Bad Request' } 403 { 'Forbidden' } 404 { 'Not Found' } 405 { 'Method Not Allowed' } 409 { 'Conflict' } 429 { 'Too Many Requests' } default { 'OK' } }
    $body = if ($obj -is [string]) { $obj } else { ($obj | ConvertTo-Json -Compress -Depth 5) }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
    $head = "HTTP/1.1 $code $reason`r`nContent-Type: application/json; charset=utf-8`r`nContent-Length: $($bytes.Length)`r`nConnection: close`r`n`r`n"
    $hb = [System.Text.Encoding]::ASCII.GetBytes($head)
    try {
        $s = $client.GetStream()
        $s.Write($hb, 0, $hb.Length)
        $s.Write($bytes, 0, $bytes.Length)
        $s.Flush()
    } catch { }
    try { $client.Close() } catch { }
}
function Serve-HealPending {
    if (-not $script:healListener) { return }
    try {
        while ($script:healListener.Pending()) {
            $client = $script:healListener.AcceptTcpClient()
            try {
                $remote = $client.Client.RemoteEndPoint
                $req = Read-HttpText $client
                $first = ($req -split "`r`n")[0]
                $parts = $first -split ' '
                if ($parts.Count -lt 2) { Send-HttpJson $client 400 '{"ok":false,"error":"bad request"}'; continue }
                $method = $parts[0]; $target = $parts[1]
                $loop = $remote.Address.Equals([System.Net.IPAddress]::Loopback)
                if (-not $loop) { Write-Log ("heal 入口拒绝非本机请求：{0}" -f $remote.Address); Send-HttpJson $client 403 '{"ok":false,"error":"loopback only"}'; continue }
                $who = '{0}:{1}' -f $remote.Address, $remote.Port
                $u = [uri]('http://127.0.0.1' + $target)
                switch ($u.AbsolutePath) {
                    '/heal' {
                        if ($method -ne 'POST' -and $method -ne 'GET') { Send-HttpJson $client 405 '{"ok":false,"error":"用 POST"}'; continue }
                        $mod = ''
                        foreach ($kv in (($u.Query.TrimStart('?') -split '&'))) {
                            if ($kv -match '^module=(.+)$') { $mod = [uri]::UnescapeDataString($matches[1]) }
                        }
                        if (-not $mod) { Send-HttpJson $client 400 '{"ok":false,"error":"需要 module=xxx"}'; continue }
                        $r = Invoke-Heal $mod $who
                        $code = if ($r.http) { [int]$r.http } else { 200 }
                        Send-HttpJson $client $code $r
                    }
                    '/modules' {
                        $rows = @()
                        foreach ($k in $script:healModules.Keys) {
                            $mm = $script:healModules[$k]
                            $cd = 0
                            if ($script:healLast.ContainsKey($k)) { $cd = [int][math]::Max(0, $script:HealCooldownSec - ((Get-Date) - $script:healLast[$k]).TotalSeconds) }
                            $rows += [ordered]@{ module = $k; port = $mm.port; kind = $mm.kind; starter = $mm.start; note = $mm.note; cooldownRemainingSec = $cd }
                        }
                        Send-HttpJson $client 200 ([ordered]@{ ok = $true; count = $rows.Count; cooldownSec = $script:HealCooldownSec; modules = $rows })
                    }
                    '/status' {
                        Send-HttpJson $client 200 ([ordered]@{ ok = $true; pid = $PID; intervalSec = $IntervalSec; healPort = $script:healPort; whitelist = @($script:healModules.Keys); at = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') })
                    }
                    default { Send-HttpJson $client 404 '{"ok":false,"error":"only /heal /modules /status"}' }
                }
            } catch { try { $client.Close() } catch { } }
        }
    } catch { }
}

# ── 计数 ──────────────────────────────────────────────────────────────────
$relayRestarts = 0
$windowRestarts = 0
$bodyRestarts = 0
$snowRestarts = 0
$bridgeFails = 0
$bridgeRestarts = 0
$lastBridgeStart = [DateTime]::MinValue
$probeRestarts = 0
$lastProbeStart = [DateTime]::MinValue
$script:svcPrev = @{}
$lastWindowStart = [DateTime]::MinValue
$lastBodyStart = [DateTime]::MinValue
$lastSnowStart = [DateTime]::MinValue
$lastHeartbeat = [DateTime]::MinValue
$script:lastLogSweep = [DateTime]::MinValue

Write-Log "守护启动 (pid=$PID, interval=${IntervalSec}s, avatar=$Avatar)"
if ($mutexWasAbandoned) { Write-Log "互斥量是遗弃状态（上一个守护被强杀）→ 本实例已接管，不是重复实例" }
Write-Log "祖先链：$(Get-Ancestry)（父进程应当是 svchost/Task Scheduler；出现 DSH 说明这次是被会话拉起的，DSH 重启会带走）"
# 受控重启入口：只绑回环（本机才连得上），非管理员也能建（HttpListener 需要 urlacl，TcpListener 不需要）
try {
    $script:healListener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $script:healPort)
    # 2026-10-28（03·维护）：监听句柄必须**不可继承**。实测踩到 —— 守护重启时旧监听套接字被它拉起的
    # 子进程（relay/body/probe/bridge…）继承了句柄，旧守护一死套接字仍被占，新守护 bind 报
    # 「通常每个套接字地址只允许使用一次」→ heal 入口静默死掉（9338 直接超时）。
    if (-not ('Win32Handle' -as [type])) {
        Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class Win32Handle { [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetHandleInformation(IntPtr h, int mask, int flags); }' -ErrorAction Stop
    }
    try {
        [void][Win32Handle]::SetHandleInformation($script:healListener.Server.Handle, 0x1, 0x0)   # HANDLE_FLAG_INHERIT 清零
        Write-Log 'heal 监听句柄已设为不可继承（子进程不会再占住 9338）'
    } catch { Write-Log ('heal 句柄设不可继承失败（不致命）：{0}' -f $_.Exception.Message) }
    $healBound = $false
    for ($healTry = 1; $healTry -le 5; $healTry++) {
        try { $script:healListener.Start(); $healBound = $true; break }
        catch {
            Write-Log ('heal 入口绑定失败（第 {0}/5 次）：{1}' -f $healTry, $_.Exception.Message)
            Start-Sleep -Milliseconds 400
        }
    }
    if (-not $healBound) { throw 'heal 入口 5 次绑定都失败（旧监听套接字被别的进程占着）' }
    Write-Log ("heal 入口已监听 127.0.0.1:{0}（白名单 {1} 个：{2}）" -f $script:healPort, $script:healModules.Count, (@($script:healModules.Keys) -join ','))
} catch {
    Write-Log ("heal 入口没起来（127.0.0.1:{0}）：{1}" -f $script:healPort, $_.Exception.Message)
    $script:healListener = $null
}
# 2026-10-26 修：这里原来写着 `$mutex.ReleaseMutex()` 然后 `$null = $mutex.WaitOne(0)`
# ——中间几微秒是空的，另一个守护实例正好能在那一刻抢到互斥量，而本实例重新 WaitOne(0)
# 失败的结果又被 `$null =` 吞掉，于是**两个守护同时跑**（实测抓到 pid 35376 + 6784）。
# 两个守护各自轮询，会互相抢着重启窗口/中继，表现为窗口重复弹出、relay 反复重启、CPU 毛刺。
# 现在：互斥量在第 27 行已 WaitOne(0) 持有，本文件后面**任何地方都不许再 Release 它**。

while ($true) {
    $now = Get-Date
    # D7-v2: keepers (pain-bus 9339 / self-heal --watch) check + start, before all health checks
    Maintain-Keepers
    $relayOk = Test-Http 'http://127.0.0.1:9334/health'
    $bodyOk = Test-Http 'http://127.0.0.1:9335/health'
    $modOk = Test-Http 'http://127.0.0.1:9333/ping'
    $bridgeOk = Test-Http 'http://127.0.0.1:3100/api/health'
    $snowOk = Test-Tcp -Port 3001
    $probeOk = Test-Tcp -Port 9337
    $win = Get-WindowProc
    $winOk = [bool]$win

    # 状态边沿：必须在**拉起动作之前**记 —— 记录的是「本轮观测到的原始事实」。
    # 2026-10-26 23:49 修：一开始放在拉起之后，结果 relay/body 在同一轮里被杀又被救活，
    # 观测值早被覆盖成 ok，DOWN 事件被吞掉（实测只抓到 bridge 的 DOWN）。挪到这里才对。
    foreach ($svc in @(
        @{ n = 'relay';    ok = $relayOk;  port = 9334 },
        @{ n = 'body';     ok = $bodyOk;   port = 9335 },
        @{ n = 'snowluma'; ok = $snowOk;   port = 3001 },
        @{ n = 'probe';    ok = $probeOk;  port = 9337 },
        @{ n = 'bridge';   ok = $bridgeOk; port = 3100 }
    )) {
        $prev = $script:svcPrev[$svc.n]
        if ($null -eq $prev) {
            Write-SvcEvent $svc.n $svc.port $svc.ok      # 基线
        } elseif ([bool]$prev -ne [bool]$svc.ok) {
            Write-SvcEvent $svc.n $svc.port $svc.ok
            # D7-v2 报丧：掉线=crash/exit，恢复=restart-ok/up（首轮基线不报）
            if (-not $svc.ok) { Send-Pain $svc.n 'crash' 'exit' | Out-Null }
            else { Send-Pain $svc.n 'restart-ok' 'up' | Out-Null }
        }
        $script:svcPrev[$svc.n] = $svc.ok
    }

    if (-not $relayOk) {
        $relayRestarts++
        Write-Log "relay 9334 不通 → 第 $relayRestarts 次拉起"
        try { Start-Relay; Start-Sleep -Seconds 3 } catch { Write-Log "relay 启动失败：$($_.Exception.Message)"; Send-Pain 'relay' 'start-failed' 'start-error' | Out-Null }
        $relayOk = Test-Http 'http://127.0.0.1:9334/health'
    }

    if (-not $bodyOk -and ($now - $lastBodyStart).TotalSeconds -gt 15) {
        $bodyRestarts++
        Write-Log "身体服务 9335 不通 → 第 $bodyRestarts 次拉起"
        try { Start-BodyService; $lastBodyStart = $now; Start-Sleep -Seconds 2 } catch { Write-Log "身体服务启动失败：$($_.Exception.Message)"; Send-Pain 'body' 'start-failed' 'start-error' | Out-Null }
        $bodyOk = Test-Http 'http://127.0.0.1:9335/health'
    }

    if (-not $snowOk -and ($now - $lastSnowStart).TotalSeconds -gt 20) {
        $snowRestarts++
        Write-Log "SnowLuma 3001 不通 → 第 $snowRestarts 次拉起"
        try { Start-SnowLuma; $lastSnowStart = $now; Start-Sleep -Seconds 3 } catch { Write-Log "SnowLuma 启动失败：$($_.Exception.Message)"; Send-Pain 'snowluma' 'start-failed' 'start-error' | Out-Null }
        $snowOk = Test-Tcp -Port 3001
    }
    if (-not $probeOk -and ($now - $lastProbeStart).TotalSeconds -gt 20) {
        $probeRestarts++
        Write-Log "探针 9337 不通 → 第 $probeRestarts 次拉起"
        try { Start-Probe; $lastProbeStart = $now; Start-Sleep -Seconds 2 } catch { Write-Log "探针启动失败：$($_.Exception.Message)"; Send-Pain 'probe' 'start-failed' 'start-error' | Out-Null }
        $probeOk = Test-Tcp -Port 9337
    }

    # 关窗策略 C（2026-10-26 主人拍板）：用户点 × 关掉的窗口**不要拉起**；
    # 崩溃/被杀（没有 marker）照旧救。marker 由 exe 在 CloseReason=UserClosing 时写，
    # exe 正常启动时会删掉它（手动双击或脚本拉起都算"我要它回来"）。
    $closedByUser = Test-Path (Join-Path $Avatar 'state\window-user-closed')
    if ($closedByUser) {
        if (-not $script:closedByUserLogged) {
            Write-Log "窗口被用户关闭（检测到 window-user-closed）→ 暂停自动拉起；手动启动窗口后恢复"
            $script:closedByUserLogged = $true
        }
    } else {
        $script:closedByUserLogged = $false
    }

    if (-not $winOk -and -not $closedByUser -and ($now - $lastWindowStart).TotalSeconds -gt 20) {
        $windowRestarts++
        Write-Log "窗口不在 → 第 $windowRestarts 次拉起"
        try { Start-Window; $lastWindowStart = $now } catch { Write-Log "窗口启动失败：$($_.Exception.Message)"; Send-Pain 'window' 'start-failed' 'start-error' | Out-Null }
    }

    # 2026-10-27 16:10（03·维护）：桥接从「连续 3 轮才拉（≈30 秒）」改成「第一轮就判定」，
    # 并把拉起次数计入 bridgeRestarts（以前只有 $bridgeFails，不进 supervisor.json、也不进心跳，
    # 所以外面根本看不出桥接有没有被守护管过）。
    # 为什么改：只杀 node 时 start.bat:16-27 的 :loop 5 秒就能拉回；一旦宿主 cmd 和 node 一起被杀
    # （15:53 那次、以及「整棵树一起杀」的任何场景），桥接就只剩守护这一条命——原来要等 3 轮，
    # 实测空窗 38 秒。现在：端口不通 + 没有 bridge.js 进程 → 当场拉；有进程在跑就不重复拉
    # （沿用原判重，避免两个 start.bat 宿主抢锁）；再加 20 秒冷却，防止一轮风暴里连拉多个宿主。
    if (-not $bridgeOk) {
        $bridgeProcs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -like '*src/bridge.js*' })
        $bridgeFails++
        if ($bridgeProcs.Count -gt 0) {
            if ($bridgeFails -eq 1) {
                Write-Log "bridge 3100 不通，但已有 bridge.js 在跑（pid=$($bridgeProcs[0].ProcessId)）→ 等它绑端口，不重复拉起"
            }
        } elseif (($now - $lastBridgeStart).TotalSeconds -gt 20) {
            $bridgeRestarts++
            Write-Log "bridge 3100 不通且无 bridge.js 进程（连续 $bridgeFails 轮）→ 第 $bridgeRestarts 次隐藏拉起 start.bat"
            try {
                Start-BridgeHidden
                $lastBridgeStart = $now
                Start-Sleep -Seconds 3
            } catch { Write-Log "bridge 启动失败：$($_.Exception.Message)"; Send-Pain 'bridge' 'start-failed' 'start-error' | Out-Null }
            $bridgeOk = Test-Http 'http://127.0.0.1:3100/api/health'
        }
    } else {
        $bridgeFails = 0
    }

    try {
        $status = [ordered]@{
            at = $now.ToString('yyyy-MM-dd HH:mm:ss')
            pid = $PID
            relay = if ($relayOk) { 'ok' } else { 'fail' }
            body = if ($bodyOk) { 'ok' } else { 'fail' }
            snowluma = if ($snowOk) { 'ok' } else { 'fail' }
            mod = if ($modOk) { 'ok' } else { 'fail' }
            bridge = if ($bridgeOk) { 'ok' } else { 'fail' }
            probe = if ($probeOk) { 'ok' } else { 'fail' }
            window = if ($winOk) { 'ok' } else { 'fail' }
            windowShell = 'XunyuWebWindow'
            relayRestarts = $relayRestarts
            windowRestarts = $windowRestarts
            bodyRestarts = $bodyRestarts
            snowlumaRestarts = $snowRestarts
            bridgeRestarts = $bridgeRestarts
            probeRestarts = $probeRestarts
            busRestarts = $script:busRestarts
            healRestarts = $script:healRestarts
        }
        ($status | ConvertTo-Json -Compress) | Set-Content -Path $stateFile -Encoding UTF8
    } catch { }

    if (($now - $lastHeartbeat).TotalMinutes -ge 5) {
        Write-Log "心跳 relay=$relayOk body=$bodyOk snow=$snowOk mod=$modOk bridge=$bridgeOk probe=$probeOk window=$winOk (busRestarts=$($script:busRestarts) healRestarts=$($script:healRestarts) relay重启=$relayRestarts 身体重启=$bodyRestarts snow重启=$snowRestarts 窗口重启=$windowRestarts bridge重启=$bridgeRestarts 探针重启=$probeRestarts)"
        $lastHeartbeat = $now
    }

    # ── 每天一次的日志清理（2026-10-27 00:10 新增，03）────────────────────
    # SnowLuma 自己的按天日志（logs\snowluma-YYYY-MM-DD.log）约 1MB/天，它只切不删，
    # 一个月就是 30MB、一年 365MB。这里每天清一次 30 天前的。
    # 只碰 SnowLuma\logs 下匹配 snowluma-*.log 的文件，其他一概不动。
    if ($now.Date -ne $script:lastLogSweep) {
        $script:lastLogSweep = $now.Date
        $slLogDir = Join-Path $SnowLumaDir 'logs'
        if (Test-Path $slLogDir) {
            $old = @(Get-ChildItem -Path $slLogDir -Filter 'snowluma-*.log' -File -ErrorAction SilentlyContinue |
                Where-Object { $_.LastWriteTime -lt $now.AddDays(-30) })
            $n = 0
            foreach ($f in $old) {
                try { Remove-Item $f.FullName -Force -ErrorAction Stop; $n++ } catch { }
            }
            if ($n -gt 0) { Write-Log "日志清理：删除 $n 个 30 天前的 SnowLuma 日志（$slLogDir）" }
        }
    }

    # 睡眠期间每 100ms 看一眼有没有 heal 请求（不另起线程/作业，保持单实例状态）
    $remainMs = $IntervalSec * 1000
    while ($remainMs -gt 0) {
        Serve-HealPending
        Start-Sleep -Milliseconds 100
        $remainMs -= 100
    }
    Serve-HealPending
}
