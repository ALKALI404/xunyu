# scripts/vm/wecom-watch.ps1 -- 常驻 Watcher: 一次拿到企微 hwnd 长期持有, HTTP 8766 收命令
#
# 为什么改常驻: 企微窗口会被销毁/重建(同一段代码"有时 49 个窗口、有时 0 个"), 一次性计划任务每次重枚举,天然不可靠.
# 这里由常驻进程持有 hwnd; 每 30 秒 IsWindow 探一次, 没了就重找/拉起企微, 并把 hwnd 变化写进日志.
#
# 接口(只监听 127.0.0.1, 不对外; 宿主经 ssh -L 隧道访问):
#   GET  /health  -> {ok, hwnd, visible, session, since, ts}
#   POST /send    -> {conv, text} -> {ok, code, conv, beforeHash, afterHash, ...}
#   GET  /last    -> 上一次结果
#
# 启动: 计划任务 XunyuWeComWatch (InteractiveToken, 登录即起) 或手动:
#   powershell -NoProfile -ExecutionPolicy Bypass -File C:\Temp\vm\wecom-watch.ps1
$ErrorActionPreference = 'Continue'
$logPath = 'C:\Temp\wecom-watch.log'
$lastPath = 'C:\Temp\wecom-last.json'
$script:lastResult = $null
$script:doneIds = New-Object System.Collections.ArrayList
$script:hwnd = [IntPtr]::Zero
$script:startedAt = Get-Date

function Log([string]$msg) {
  $line = (Get-Date).ToString('HH:mm:ss') + ' ' + $msg
  try { Add-Content -Path $logPath -Value $line -Encoding UTF8 } catch { }
}

. 'C:\Temp\vm\wecom-lib.ps1'
$cfg = Get-Content 'C:\Temp\wc-cfg.json' -Raw -Encoding UTF8 | ConvertFrom-Json

function Resolve-Hwnd([string]$why) {
  $h = Get-WeComMain $cfg
  if ($h) {
    if ([IntPtr]$h -ne $script:hwnd) {
      Log ("hwnd " + $script:hwnd.ToInt64() + " -> " + $h.ToInt64() + " (" + $why + ")")
      $script:hwnd = $h
    }
    return $h
  }
  Log ("no-window (" + $why + ")")
  $script:hwnd = [IntPtr]::Zero
  return $null
}

for ($i = 0; $i -lt 60; $i++) {
  if (Resolve-Hwnd 'startup') { break }
  Start-Sleep -Milliseconds 1000
}
Log ('listening on 127.0.0.1:8766  hwnd=' + $script:hwnd.ToInt64() + '  session=' + (Get-Process -Id $PID).SessionId)

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add('http://127.0.0.1:8766/')
try { $listener.Start() } catch { Log ('listen-failed: ' + $_.Exception.Message); exit 1 }

$nextProbe = (Get-Date).AddSeconds(30)
while ($true) {
  $task = $listener.GetContextAsync()
  while (-not $task.Wait(1000)) {
    if ((Get-Date) -ge $nextProbe) {
      $nextProbe = (Get-Date).AddSeconds(30)
      $alive = ($script:hwnd -ne [IntPtr]::Zero) -and [WeCom]::IsWindow($script:hwnd)
      if (-not $alive) { [void](Resolve-Hwnd 'probe30s') }
    }
  }
  $ctx = $task.Result
  $req = $ctx.Request
  $res = $ctx.Response
  $payload = $null
  try {
    $path = $req.Url.AbsolutePath
    if ($req.HttpMethod -eq 'GET' -and $path -eq '/health') {
      $alive = ($script:hwnd -ne [IntPtr]::Zero) -and [WeCom]::IsWindow($script:hwnd)
      $payload = [ordered]@{ ok = [bool]$alive; hwnd = $script:hwnd.ToInt64(); visible = [bool]$alive; session = (Get-Process -Id $PID).SessionId; since = $script:startedAt.ToString('s'); ts = (Get-Date).ToString('s') }
    } elseif ($req.HttpMethod -eq 'POST' -and $path -eq '/bootstrap') {
      $reader = New-Object System.IO.StreamReader($req.InputStream, [System.Text.Encoding]::UTF8)
      $body = $reader.ReadToEnd(); $reader.Close()
      $job = $body | ConvertFrom-Json
      $m = Get-WeComMain $cfg
      if (-not $m) { $payload = [ordered]@{ ok = $false; code = 'no-main-window' } }
      else {
        $h = Save-HeaderRef $cfg $m ([string]$job.conv)
        $payload = [ordered]@{ ok = [bool]$h; conv = $job.conv; ref = $h; hwnd = $m.ToInt64() }
        Log ('bootstrap ' + $job.conv + ' ref=' + $h)
      }
    } elseif ($req.HttpMethod -eq 'GET' -and $path -eq '/shot') {
      Snap-Screen 'C:\Temp\wshot.png' | Out-Null
      $payload = [ordered]@{ ok = $true; file = 'C:\Temp\wshot.png'; ts = (Get-Date).ToString('s') }
    } elseif ($req.HttpMethod -eq 'GET' -and $path -eq '/shot.png') {
      # 直接回二进制：宿主一条命令就能拿到"现在屏幕上是什么"，供人眼看图确认会话
      $sp = 'C:\Temp\wshot.png'
      Snap-Screen $sp | Out-Null
      $bytes = [System.IO.File]::ReadAllBytes($sp)
      $res.ContentType = 'image/png'
      $res.StatusCode = 200
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
      $res.Close()
      $script:lastResult = [ordered]@{ ok = $true; code = 'shot'; bytes = $bytes.Length; ts = (Get-Date).ToString('s') }
      continue
    } elseif ($req.HttpMethod -eq 'GET' -and $path -eq '/refs') {
      $payload = [ordered]@{ ok = $true; refs = @(List-HeaderRefs); ts = (Get-Date).ToString('s') }
    } elseif ($req.HttpMethod -eq 'POST' -and $path -eq '/clearref') {
      $reader = New-Object System.IO.StreamReader($req.InputStream, [System.Text.Encoding]::UTF8)
      $body = $reader.ReadToEnd(); $reader.Close()
      $job = $body | ConvertFrom-Json
      $gone = Clear-HeaderRef ([string]$job.conv)
      $payload = [ordered]@{ ok = $true; conv = $job.conv; removed = [bool]$gone }
      Log ('clearref ' + $job.conv + ' removed=' + $gone)
    } elseif ($req.HttpMethod -eq 'POST' -and $path -eq '/normalize') {
      $payload = Set-WeComGeometry $cfg
      Log ('normalize ok=' + $payload.ok + ' client=' + ($payload.client | ConvertTo-Json -Compress))
    } elseif ($req.HttpMethod -eq 'POST' -and $path -eq '/open') {
      # 只定位会话、不发消息：给人留出"看一眼截图再决定"的位置（WC-004 四步里的第①步）
      $reader = New-Object System.IO.StreamReader($req.InputStream, [System.Text.Encoding]::UTF8)
      $body = $reader.ReadToEnd(); $reader.Close()
      $job = $body | ConvertFrom-Json
      if (-not (Resolve-Hwnd 'before-open')) {
        $payload = [ordered]@{ ok = $false; code = 'no-main-window'; conv = $job.conv }
      } else {
        $o = Open-WeComChat -Conv ([string]$job.conv) -Cfg $cfg
        Snap-Screen 'C:\Temp\wecom-open-now.png' | Out-Null
        $payload = [ordered]@{ ok = [bool]$o.ok; code = $o.code; why = $o.why; conv = $job.conv; beforeHash = $o.beforeHash; afterHash = $o.afterHash; ref = $o.ref; shot = 'C:\Temp\wecom-open-now.png'; hwnd = $script:hwnd.ToInt64(); ts = (Get-Date).ToString('s'); detail = $o }
        Log ('open ' + $job.conv + ' -> ' + $o.code + ' ' + $o.why)
      }
    } elseif ($req.HttpMethod -eq 'GET' -and $path -eq '/windows') {
      # 调试用：列出可见顶层窗口（类名/标题/矩形），用来认出"搜索结果页"那种临时窗口
      $list = @()
      $script:wcWinAcc = New-Object System.Collections.ArrayList
      $cb = [WeCom+EnumWindowsProc]{
        param($h, $l)
        if ([WeCom]::IsWindowVisible($h)) {
          $r = [WeCom]::RectOf($h)
          if ($r[2] -gt 200 -and $r[3] -gt 120) {
            $null = $script:wcWinAcc.Add([ordered]@{ hwnd = $h.ToInt64(); class = [WeCom]::ClassOf($h); title = [WeCom]::TitleOf($h); rect = @{ x = $r[0]; y = $r[1]; w = $r[2]; h = $r[3] } })
          }
        }
        return $true
      }
      [void][WeCom]::EnumWindows($cb, [IntPtr]::Zero)
      $list = @($script:wcWinAcc)
      $script:wcWinAcc = $null
      $payload = [ordered]@{ ok = $true; count = $list.Count; windows = $list }
    } elseif ($req.HttpMethod -eq 'GET' -and $path -eq '/panel') {
      # 调试：把 SearchTabWnd2 的每个句柄都摊开（含可见/cloak/矩形），别再用"猜"的
      $out = @()
      $script:wcWinAcc = New-Object System.Collections.ArrayList
      $cls = $cfg.searchWindowClass
      $cb = [WeCom+EnumWindowsProc]{
        param($h, $l)
        if ([WeCom]::ClassOf($h) -eq $cls) {
          $r = [WeCom]::RectOf($h)
          $null = $script:wcWinAcc.Add([ordered]@{
              hwnd = $h.ToInt64(); title = [WeCom]::TitleOf($h);
              isWindow = [bool][WeCom]::IsWindow($h); visible = [bool][WeCom]::IsWindowVisible($h);
              cloaked = [bool][WeCom]::IsCloaked($h); reallyVisible = [bool][WeCom]::IsReallyVisible($h);
              rect = @{ x = $r[0]; y = $r[1]; w = $r[2]; h = $r[3] }
            })
        }
        return $true
      }
      [void][WeCom]::EnumWindows($cb, [IntPtr]::Zero)
      $out = @($script:wcWinAcc)
      $script:wcWinAcc = $null
      $payload = [ordered]@{ ok = $true; class = $cls; count = $out.Count; windows = $out }
    } elseif ($req.HttpMethod -eq 'POST' -and $path -eq '/cleardraft') {
      # 清掉输入框里的草稿但**不发送**：搜索失败时 Ctrl+V 可能落在聊天输入框里，
      # 留下一颗"按回车就飞出去"的雷（2026-10-30 21:55 实测：输入框里残留着「鲟鱼」）。
      $f = Focus-InputBox $cfg
      if (-not $f.ok) { $payload = [ordered]@{ ok = $false; code = $f.code } }
      else {
        [WeCom]::Combo('17,65'); Start-Sleep -Milliseconds 150
        [WeCom]::Key(0x2E); Start-Sleep -Milliseconds 300
        Snap-Screen 'C:\Temp\wecom-cleardraft.png' | Out-Null
        $payload = [ordered]@{ ok = $true; code = 'draft-cleared'; shot = 'C:\Temp\wecom-cleardraft.png'; ts = (Get-Date).ToString('s') }
        Log 'cleardraft ok'
      }
    } elseif ($req.HttpMethod -eq 'POST' -and $path -eq '/clickat') {
      # 调试/校准用：按 client 相对坐标点一下（不含任何业务判定），返回点击前后截图供人眼看
      $reader = New-Object System.IO.StreamReader($req.InputStream, [System.Text.Encoding]::UTF8)
      $body = $reader.ReadToEnd(); $reader.Close()
      $job = $body | ConvertFrom-Json
      $m = Get-WeComMain $cfg
      if (-not $m) { $payload = [ordered]@{ ok = $false; code = 'no-main-window' } }
      else {
        # 注意：这里**不要** Force/Ensure-Geometry——抢焦点会把企微的临时搜索窗（搜索结果页）关掉，
        # 于是"点搜索结果"这一步永远点不到（2026-10-30 02:53 实测）。只位移+点击，不动前台。
        $cr = [WeCom]::ClientRect($m)
        $x = $cr[0] + [int]$job.x
        $y = $cr[1] + [int]$job.y
        [WeCom]::Click($x, $y)
        Start-Sleep -Milliseconds ([int]$cfg.openWaitMs)
        Snap-Screen 'C:\Temp\wecom-clickat.png' | Out-Null
        $payload = [ordered]@{ ok = $true; clicked = @{ x = $x; y = $y }; client = @{ x = $cr[0]; y = $cr[1]; w = $cr[2]; h = $cr[3] }; shot = 'C:\Temp\wecom-clickat.png'; ts = (Get-Date).ToString('s') }
        Log ('clickat ' + $x + ',' + $y)
      }
    } elseif ($req.HttpMethod -eq 'POST' -and $path -eq '/key') {
      $reader = New-Object System.IO.StreamReader($req.InputStream, [System.Text.Encoding]::UTF8)
      $body = $reader.ReadToEnd(); $reader.Close()
      $job = $body | ConvertFrom-Json
      [WeCom]::Key([byte][int]$job.vk)
      Start-Sleep -Milliseconds 400
      $payload = [ordered]@{ ok = $true; vk = $job.vk }
      Log ('key vk=' + $job.vk)
    } elseif ($req.HttpMethod -eq 'POST' -and $path -eq '/search') {
      $reader = New-Object System.IO.StreamReader($req.InputStream, [System.Text.Encoding]::UTF8)
      $body = $reader.ReadToEnd(); $reader.Close()
      $job = $body | ConvertFrom-Json
      $payload = Search-WeComChat -Conv ([string]$job.conv) -Cfg $cfg
      Log ('search ' + $job.conv + ' changed=' + $payload.searchBoxChanged + ' ink=' + $payload.dropdownInk)
    } elseif ($req.HttpMethod -eq 'GET' -and $path -eq '/geometry') {
      $m = Get-WeComMain $cfg
      $rect = if ($m) { [WeCom]::RectOf($m) } else { @(0,0,0,0) }
      $cli = if ($m) { [WeCom]::ClientRect($m) } else { @(0,0,0,0) }
      $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
      $payload = [ordered]@{ ok = [bool]$m; hwnd = $(if ($m) { $m.ToInt64() } else { 0 }); rect = @{ x = $rect[0]; y = $rect[1]; w = $rect[2]; h = $rect[3] }; client = @{ x = $cli[0]; y = $cli[1]; w = $cli[2]; h = $cli[3] }; screen = @{ w = $vs.Width; h = $vs.Height }; session = (Get-Process -Id $PID).SessionId; foreground = $(if ($m) { [bool]([WeCom]::GetForegroundWindow() -eq $m) } else { $false }); fgHwnd = [WeCom]::GetForegroundWindow().ToInt64() }
    } elseif ($req.HttpMethod -eq 'GET' -and $path -eq '/last') {
      $payload = $script:lastResult
      if (-not $payload) { $payload = @{ ok = $false; code = 'no-send-yet' } }
    } elseif ($req.HttpMethod -eq 'POST' -and $path -eq '/send') {
      $reader = New-Object System.IO.StreamReader($req.InputStream, [System.Text.Encoding]::UTF8)
      $body = $reader.ReadToEnd(); $reader.Close()
      $job = $body | ConvertFrom-Json
      Log ('send-request len=' + ([string]$job.text).Length)
      # 【幂等】2026-10-30 21:51 现网事故：宿主侧连接断了，响应写不回去（日志 respond-failed），
      # 但消息**已经发出去了**；宿主以为失败就重试 → 群里多了一条重复消息。
      # 所以带上同一个 id 的重试不再执行，直接回 duplicate-suppressed。
      $key = [string]$job.id
      if ($key -and $script:doneIds -contains $key) {
        $payload = [ordered]@{ ok = $true; code = 'duplicate-suppressed'; id = $key; conv = $job.conv; detail = '同一 id 已处理过，本次未重复发送' }
        Log ('send-dup-suppressed ' + $key)
      }
      elseif (-not (Resolve-Hwnd 'before-send')) {
        $payload = [ordered]@{ ok = $false; code = 'no-main-window'; conv = $job.conv }
      } else {
        $opened = Open-WeComChat -Conv ([string]$job.conv) -Cfg $cfg
        if (-not $opened.ok) {
          $payload = [ordered]@{ ok = $false; code = $opened.code; conv = $job.conv; beforeHash = $opened.beforeHash; afterHash = $opened.afterHash }
          Log ('send-abort ' + $opened.code)
        } else {
          $one = Send-WeComText -Text ([string]$job.text) -Cfg $cfg -Tag 'watch' -Conv ([string]$job.conv)
          $payload = [ordered]@{
            ok = [bool]$one.ok
            code = $one.code
            conv = $job.conv
            beforeHash = $one.beforeHash
            afterHash = $one.afterHash
            pastedHash = $one.pastedHash
            open = @{ before = $opened.beforeHash; after = $opened.afterHash }
            hwnd = $script:hwnd.ToInt64()
            ts = (Get-Date).ToString('s')
          }
          $bh = '-'
          if ($one.beforeHash) { $bh = ([string]$one.beforeHash).Substring(0, 12) }
          $ah = '-'
          if ($one.afterHash) { $ah = ([string]$one.afterHash).Substring(0, 12) }
          Log ('send-done ' + $one.code + ' before=' + $bh + ' after=' + $ah)
        }
        # 无论成败都登记这个 id：宿主"响应丢了"再拿同一个 id 重试时就不会重复发
        if ($key) {
          if ($script:doneIds.Count -ge 50) { $script:doneIds.RemoveAt(0) }
          [void]$script:doneIds.Add($key)
        }
      }
    } else {
      $payload = [ordered]@{ ok = $false; code = 'not-found'; path = $path }
    }
  } catch {
    $payload = [ordered]@{ ok = $false; code = 'exception'; detail = $_.Exception.Message }
    Log ('exception ' + $_.Exception.Message)
  }
  try {
    $json = $payload | ConvertTo-Json -Depth 6 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $res.ContentType = 'application/json; charset=utf-8'
    $res.StatusCode = 200
    $res.OutputStream.Write($bytes, 0, $bytes.Length)
    $res.Close()
    $script:lastResult = $payload
    try { $json | Out-File $lastPath -Encoding UTF8 } catch { }
  } catch { Log ('respond-failed ' + $_.Exception.Message) }
}
