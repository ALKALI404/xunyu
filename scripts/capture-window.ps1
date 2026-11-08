# scripts/capture-window.ps1 —— 抓「某个窗口」的截图（UG-006 / WS-014）
#
# 用途：换代“看画面”验证——截图必须能看见会话标题、工作区名、至少一条消息。
# 只截目标窗口（GetWindowRect 裁剪），不截全屏；不依赖第三方截图库（System.Drawing 内置）。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\capture-window.ps1 -Out logs\handoff\x.png [-Process DSH] [-TitleLike 鲟鱼]
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\capture-window.ps1 -ListCandidates [-Process "DSH NEXT"]
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\capture-window.ps1 -Session <sessionId|短id> -Out logs\handoff\x.png
#
# WS-014 新增（向后兼容：不传 -Session / -ListCandidates 时行为与旧版完全一致）：
#   -Session <id>   先 sessions.list 把 id 查成会话标题，再枚举该进程**所有顶层窗口**按标题匹配，
#                   对匹配到的窗口 PrintWindow 截图。**全程不 SetForegroundWindow / ShowWindow / Alt+Tab**。
#   -ListCandidates 只列候选窗口（hwnd / pid / 可见或最小化 / 尺寸 / 标题），不截图。
#   -MinBytes <n>   -Session 模式下的文件下限（默认 51200 = 50KB），不足按截图失败处理。
#
# 退出码：
#   0 成功（文件已落；-Session 模式下还要求 >= MinBytes）
#   1 参数错（-Session 查不到会话/查会话时连不上 DSH，等等）
#   2 找不到目标会话窗口（stderr 一行一个列出**全部候选窗口标题**）
#   3 截图失败（窗口存在但 PrintWindow/GDI 失败，或截出来全黑/全白，或不足 MinBytes）
#
# 输出：一行 JSON {ok,path,width,height,bytes,title,process,...}

param(
  [Parameter(Mandatory = $false)][string]$Out = '',
  [string]$Process = 'DSH NEXT',
  [string]$TitleLike = '',
  [string]$Session = '',
  [switch]$ListCandidates,
  [int]$MinBytes = 0
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public class WinCap {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);

  // 该进程的**所有**顶层窗口（不管可见/最小化），标题为空的不返回
  public static List<object[]> TopWindows(uint[] pids) {
    var set = new HashSet<uint>(pids);
    var res = new List<object[]>();
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (!set.Contains(pid)) return true;
      var sb = new StringBuilder(1024);
      GetWindowText(h, sb, 1024);
      var t = sb.ToString();
      if (t.Length == 0) return true;
      RECT r; GetWindowRect(h, out r);
      res.Add(new object[] { h, pid, t, IsWindowVisible(h), IsIconic(h), r.Left, r.Top, r.Right, r.Bottom });
      return true;
    }, IntPtr.Zero);
    return res;
  }
}
"@

function Write-Json([string]$s) { Write-Output $s }

# ─────────────────────────── 公共：截图 ───────────────────────────
# 返回 @{ ok; w; h; blank }；不抛异常，由调用方决定退出码
function Save-WindowShot([IntPtr]$hwnd, [string]$path) {
  $rect = New-Object WinCap+RECT
  if (-not [WinCap]::GetWindowRect($hwnd, [ref]$rect)) { return @{ ok = $false; err = 'GetWindowRect failed' } }
  $w = $rect.Right - $rect.Left
  $h = $rect.Bottom - $rect.Top
  if ($w -le 0 -or $h -le 0) { return @{ ok = $false; err = 'zero-size window' } }

  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $gfx = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $gfx.GetHdc()
  # nFlags=2 (PW_RENDERFULLCONTENT)：WebView2/Electron 需要它才能抓到内容
  $ok = [WinCap]::PrintWindow($hwnd, $hdc, 2)
  $gfx.ReleaseHdc($hdc)
  $gfx.Dispose()
  $usedPrint = $ok
  if (-not $ok) {
    # PrintWindow 失败时退回 BitBlt 式抓屏（仅窗口区域；要求窗口在屏幕上未被遮挡）
    $bmp.Dispose()
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g2 = [System.Drawing.Graphics]::FromImage($bmp)
    $g2.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size($w, $h)))
    $g2.Dispose()
  }

  # 空白检测：抽样 9x9 网格，全同色 = 没截到内容（最小化/被遮挡/GDI 失败）
  $blank = $true
  $first = $null
  for ($i = 0; $i -lt 9 -and $blank; $i++) {
    for ($j = 0; $j -lt 9; $j++) {
      $x = [int](($w - 1) * $i / 8.0)
      $y = [int](($h - 1) * $j / 8.0)
      $c = $bmp.GetPixel($x, $y)
      if ($null -eq $first) { $first = $c.ToArgb() }
      elseif ($c.ToArgb() -ne $first) { $blank = $false; break }
    }
  }

  $dir = Split-Path -Parent $path
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  $size = (Get-Item $path).Length
  return @{ ok = $true; w = $w; h = $h; bytes = $size; blank = $blank; via = $(if ($usedPrint) { 'PrintWindow' } else { 'CopyFromScreen' }) }
}

# ─────────────────────────── 路径 A：-Session / -ListCandidates ───────────────────────────
$wantSession = ($Session -ne '') -or $ListCandidates

if ($wantSession) {
  $procs = @(Get-Process -Name $Process -ErrorAction SilentlyContinue)
  if ($procs.Count -eq 0) {
    [Console]::Error.WriteLine(("找不到进程 " + $Process + "（-ListCandidates / -Session 都要先有它在跑）"))
    Write-Json ('{"ok":false,"error":"no process ' + $Process + '"}')
    exit 2
  }
  $pids = [uint32[]]($procs | ForEach-Object { [uint32]$_.Id })
  $wins = [WinCap]::TopWindows($pids)

  # 归一化：去空白、去 App 名后缀、小写（PowerShell 里函数要先定义后调用，所以放在这里）
  function Norm-Title([string]$s) {
    if ($null -eq $s) { return '' }
    $t = $s -replace '\s+', ''
    $t = $t -replace '—DeepSeekHarness$', ''
    $t = $t -replace '-DeepSeekHarness$', ''
    $t = $t -replace '–DeepSeekHarness$', ''
    return $t.ToLowerInvariant()
  }

  # 列候选（stderr，一行一个；exit 2 时也要用同一份）
  function Dump-Candidates {
    if ($wins.Count -eq 0) { [Console]::Error.WriteLine('（该进程一扇有标题的顶层窗口都没有）'); return }
    foreach ($w in $wins) {
      $state = if ($w[4]) { 'min' } elseif ($w[3]) { 'vis' } else { 'hid' }
      $wh = "$($w[7] - $w[5])x$($w[8] - $w[6])"
      [Console]::Error.WriteLine(("{0}  pid={1}  {2}  {3}  {4}" -f $w[2], $w[1], $state, $wh, $w[0]))
    }
  }

  # 读会话标题：session-lookup.mjs --id <id>
  $sessionTitle = ''
  if (-not $ListCandidates) {
    $lookup = Join-Path $PSScriptRoot 'session-lookup.mjs'
    if (-not (Test-Path $lookup)) {
      [Console]::Error.WriteLine("缺 helper：$lookup（-Session 需要它把 id 查成标题）")
      Write-Json '{"ok":false,"error":"missing session-lookup.mjs"}'
      exit 1
    }
    # 走 cmd /c 拿输出：PowerShell 里对原生命令用 2>&1，在 $ErrorActionPreference=Stop 下
    # 会把 stderr 变成 NativeCommandError 终止脚本（实测 exit 1，把 exit 2 吞掉）。cmd /c 合并成纯文本。
    $rawText = (& cmd /c "node `"$lookup`" --id `"$Session`" 2>&1") -join "`n"
    $code = $LASTEXITCODE
    $raw = @($rawText -split "`r?`n")
    if ($code -eq 2) {
      # 契约判据③：不存在/查不到的 id 一律 exit 2，并且 stderr 要能看到候选（会话候选 + 窗口候选）
      [Console]::Error.WriteLine("查不到会话「$Session」，session-lookup 的候选：")
      $raw | Where-Object { $_ -is [string] } | ForEach-Object { [Console]::Error.WriteLine($_) }
      [Console]::Error.WriteLine("候选窗口（标题 / pid / 可见性 / 尺寸 / hwnd）：")
      Dump-Candidates
      Write-Json ('{"ok":false,"error":"session not found","session":"' + $Session + '"}')
      exit 2
    }
    if ($code -ne 0) {
      [Console]::Error.WriteLine("查会话标题失败（session-lookup exit=$code）：")
      $raw | Where-Object { $_ -is [string] } | ForEach-Object { [Console]::Error.WriteLine($_) }
      Write-Json '{"ok":false,"error":"session-lookup failed"}'
      exit 1
    }
    $jsonLine = ($raw | Where-Object { $_ -is [string] -and $_ -match '"ok"\s*:\s*true' } | Select-Object -First 1)
    if (-not $jsonLine) {
      [Console]::Error.WriteLine('session-lookup 没给出 {ok:true,...} 的 JSON')
      Write-Json '{"ok":false,"error":"bad session-lookup output"}'
      exit 1
    }
    $sessionTitle = [string](($jsonLine | ConvertFrom-Json).title)
  }

  if ($ListCandidates) {
    "[候选窗口] 进程=$Process  共 $($wins.Count) 扇（标题 | pid | 可见性 | 尺寸 | hwnd）"
    if ($wins.Count -eq 0) { "（无）" }
    foreach ($w in $wins) {
      $state = if ($w[4]) { 'min' } elseif ($w[3]) { 'vis' } else { 'hid' }
      "$($w[2])`t$($w[1])`t$state`t$($w[7] - $w[5])x$($w[8] - $w[6])`t$($w[0])"
    }
    if ($sessionTitle -ne '') { "[目标会话] $Session → $sessionTitle" }
    exit 0
  }

  if ($sessionTitle -eq '' -or $sessionTitle -eq '(无标题)') {
    [Console]::Error.WriteLine("会话「$Session」的标题不可用（'$sessionTitle'），没法按标题定位窗口。")
    Dump-Candidates
    Write-Json ('{"ok":false,"error":"session has no usable title","session":"' + $Session + '"}')
    exit 2
  }
  if ($Out -eq '') {
    [Console]::Error.WriteLine('用法：-Session <id> 必须同时给 -Out <png>')
    exit 1
  }

  # 同名歧义：DSH 的会话标题会重复（例：两条定时任务会话标题都是「【当前时间】…（A」）。
  # 按标题定位时同名就证明不了“这扇窗是那一条”，至少嚷嚷一声，别让人把图当铁证。
  $allLines = & node (Join-Path $PSScriptRoot 'session-lookup.mjs') --list 2>$null
  $same = @($allLines | Where-Object { $_ -is [string] -and $_.Contains("`t" + $sessionTitle) })
  if ($same.Count -gt 1) {
    [Console]::Error.WriteLine("⚠ 有 $($same.Count) 个会话同名「$sessionTitle」，按标题定位不能区分是哪一条：")
    $same | ForEach-Object { [Console]::Error.WriteLine("  $_") }
    [Console]::Error.WriteLine("  ⇒ 图能证明「窗口开着这个标题的会话」，不能证明「就是 $Session 这一条」。")
  }

  $want = Norm-Title $sessionTitle
  # 注意：不要用 `$hits = @(); $hits += $w`——那会把 object[] 拆平（PowerShell 的 += 对数组是拼接），
  # 结果 $hits[0] 变成单个 IntPtr，后面按行取标题就全错。用 ArrayList 明确"加一整个窗口记录"。
  $hits = New-Object System.Collections.ArrayList
  foreach ($w in $wins) {
    $n = Norm-Title ([string]$w[2])
    # 窗口标题 = "<会话标题> — DeepSeek Harness"；归一化后只认三种：
    #   ① 完全相等 ② 窗口标题以会话标题开头（后面挂 App 名） ③ 窗口标题是会话标题的截断版（至少 10 字，避免「前」这种短串误命中）
    $match = ($n -eq $want) -or ($n.Length -ge 6 -and $n.StartsWith($want)) -or ($n.Length -ge 10 -and $want.StartsWith($n))
    if ($match) { [void]$hits.Add($w) }
  }

  if ($hits.Count -eq 0) {
    [Console]::Error.WriteLine("找不到目标会话窗口：$Session（$sessionTitle）")
    [Console]::Error.WriteLine("前提提醒：这版 DSH NEXT 是**单主窗口**应用，窗口标题跟着「当前打开的会话」变——")
    [Console]::Error.WriteLine("目标会话没被打开时，本机就没有它那扇窗，这是 exit 2，不是截图能救的。")
    [Console]::Error.WriteLine("候选窗口（标题 / pid / 可见性 / 尺寸 / hwnd）：")
    Dump-Candidates
    Write-Json ('{"ok":false,"error":"no window for session","session":"' + $Session + '","title":"' + ($sessionTitle -replace '"', '') + '"}')
    exit 2
  }

  # 有多个命中：可见非最小化 > 最小化 > 隐藏
  $ordered = @($hits | Sort-Object -Property @{ Expression = { if ($_[3] -and -not $_[4]) { 0 } elseif ($_[4]) { 1 } else { 2 } } })
  $target = $ordered[0]

  $r = Save-WindowShot ([IntPtr]$target[0]) $Out
  if (-not $r.ok) {
    [Console]::Error.WriteLine("截图失败：$($r.err)（窗口：$($target[2])）")
    Write-Json '{"ok":false,"error":"capture failed"}'
    exit 3
  }
  if ($r.blank) {
    [Console]::Error.WriteLine("截出来是全白/全黑（窗口可能最小化或被遮挡）：$($target[2])")
    [Console]::Error.WriteLine("按规则不还原窗口、不抢焦点；请先把窗口切出来再截。")
    Write-Json ('{"ok":false,"error":"blank capture","path":"' + ($Out -replace '\\', '\\') + '"}')
    exit 3
  }
  $min = if ($MinBytes -gt 0) { $MinBytes } else { 51200 }
  if ($r.bytes -lt $min) {
    [Console]::Error.WriteLine("截图只有 $($r.bytes) B（<$min B），按失败处理：$Out")
    Write-Json ('{"ok":false,"error":"too small","bytes":' + $r.bytes + ',"path":"' + ($Out -replace '\\', '\\') + '"}')
    exit 3
  }
  Write-Json ('{"ok":true,"path":"' + ($Out -replace '\\', '\\') + '","width":' + $r.w + ',"height":' + $r.h + ',"bytes":' + $r.bytes + ',"title":"' + ([string]$target[2] -replace '"', '') + '","process":"' + $Process + '","session":"' + $Session + '","via":"' + $r.via + '"}')
  exit 0
}

# ─────────────────────────── 路径 B：旧行为（不传 -Session）───────────────────────────
if ($Out -eq '') {
  [Console]::Error.WriteLine('用法：-Out <png> 必填（或用 -ListCandidates / -Session）')
  exit 1
}

$procs = @(Get-Process -Name $Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })
if ($procs.Count -eq 0 -and $Process -ne 'DSH') {
  # 旧默认进程名兜底（历史调用方可能写 -Process DSH）
  $procs = @(Get-Process -Name 'DSH' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })
}
if ($procs.Count -eq 0) {
  # 兜底：按主窗口标题找（Electron 的进程名可能不是 DSH）
  $procs = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*$TitleLike*" })
}
if ($TitleLike -ne '') {
  $picked = $procs | Where-Object { $_.MainWindowTitle -like "*$TitleLike*" } | Select-Object -First 1
  if ($picked) { $procs = @($picked) }
}
$target = $procs | Select-Object -First 1
if (-not $target) {
  Write-Output ('{"ok":false,"error":"no window for process ' + $Process + '"}')
  exit 1
}

$h = $target.MainWindowHandle
if (-not [WinCap]::IsWindowVisible($h)) {
  Write-Output ('{"ok":false,"error":"window not visible","title":"' + $target.MainWindowTitle + '"}')
  exit 1
}

$r = Save-WindowShot ([IntPtr]$h) $Out
if (-not $r.ok) {
  Write-Output ('{"ok":false,"error":"' + $r.err + '"}')
  exit 1
}
$json = '{"ok":true,"path":"' + ($Out -replace '\\', '\\') + '","width":' + $r.w + ',"height":' + $r.h + ',"bytes":' + $r.bytes + ',"title":"' + ($target.MainWindowTitle -replace '"', '') + '","process":"' + $target.ProcessName + '"}'
Write-Output $json
exit 0
