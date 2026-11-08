# wecom-vm-ingest-agent.ps1 -- resident capture+OCR agent inside the VM (WC-009, 03)
# ASCII only (PS 5.1 + no BOM trap). Must run in the INTERACTIVE session: session 0 cannot see
# or capture session-1 windows. Started by scheduled task XunyuWeComIngest at logon.
#
# Every $IntervalMs: find WeCom main window -> PrintWindow -> save PNG -> Windows.Media.Ocr
# (zh-Hans-CN, offline) -> append one JSON line to C:\xunyu\ingest-frames.jsonl
param(
  [string]$WorkDir = 'C:\xunyu',
  [int]$IntervalMs = 2500,
  [switch]$Once
)
$ErrorActionPreference = 'SilentlyContinue'
New-Item -ItemType Directory -Force -Path (Join-Path $WorkDir 'shots') | Out-Null
$Frames = Join-Path $WorkDir 'ingest-frames.jsonl'
$AgentLog = Join-Path $WorkDir 'wecom-ingest-agent.log'
$Png = Join-Path $WorkDir 'shots\frame.png'

# 未读自动切换开关（WECOM_UNREAD_SWITCH=0 可关）
$UnreadAutoSwitch = ($env:WECOM_UNREAD_SWITCH -ne '0')

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class CapW {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  public struct RECT { public int L; public int T; public int R; public int B; }
}
"@

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]
function Await($op, $type) {
  $t = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
  $t.Wait(-1) | Out-Null
  return $t.Result
}
[void][Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
[void][Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
[void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('zh-Hans-CN'))
if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }

function Write-ALog([string]$m) {
  $line = '{0} [ingest] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m
  try {
    if ((Test-Path $AgentLog) -and ((Get-Item $AgentLog).Length -gt 2MB)) { Move-Item $AgentLog ($AgentLog + '.1') -Force }
  } catch { }
  Add-Content -Path $AgentLog -Value $line -Encoding UTF8
}

function Get-MainWindow {
  $pids = @(Get-Process WXWork | ForEach-Object { $_.Id })
  $rows = New-Object System.Collections.ArrayList
  $cb = [CapW+EnumProc]{
    param($h, $l)
    $procId = 0
    [void][CapW]::GetWindowThreadProcessId($h, [ref]$procId)
    if ($pids -contains [int]$procId) {
      $cls = New-Object System.Text.StringBuilder 256
      [void][CapW]::GetClassName($h, $cls, 256)
      if ($cls.ToString() -eq 'WeWorkWindow') {
        $r = New-Object CapW+RECT
        $null = [CapW]::GetWindowRect($h, [ref]$r)
        [void]$rows.Add([pscustomobject]@{
          hwnd = [int64]$h; visible = [bool][CapW]::IsWindowVisible($h)
          area = [int64]($r.R - $r.L) * [int64]($r.B - $r.T); w = $r.R - $r.L; h = $r.B - $r.T
        })
      }
    }
    return $true
  }
  [void][CapW]::EnumWindows($cb, [IntPtr]::Zero)
  $best = @($rows | Sort-Object -Property @{ Expression = { if ($_.visible) { 1 } else { 0 } }; Descending = $true },
                                   @{ Expression = { $_.area }; Descending = $true })
  if ($best.Count -eq 0) { return $null }
  return $best[0]
}

function Capture([int64]$hwnd, [int]$w, [int]$h) {
  if ($w -le 0 -or $h -le 0) { return $false }
  try {
    $bmp = New-Object System.Drawing.Bitmap($w, $h)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $hdc = $g.GetHdc()
    $ok = [CapW]::PrintWindow([IntPtr][int64]$hwnd, $hdc, 2)   # PW_RENDERFULLCONTENT
    $g.ReleaseHdc($hdc)
    $g.Dispose()
    if (-not $ok) { $bmp.Dispose(); return $false }
    # 2026-10-30 WC-011（主人定 B 方案）：只 OCR 消息区 + 2x 放大
    #   左边会话列表（~16%）、右边成员栏（~9.5%）、上边标题（7%）、下边输入区（15.5%）都裁掉
    #   环境变量 WECOM_OCR_CROP=0 可退回整窗 OCR（回滚用）
    if ($env:WECOM_OCR_CROP -ne '0') {
      try {
        # 2026-10-30 22:59 修：把顶部标题条一起截进来（否则分不清在哪个会话，群消息全被记到上一个会话名下）
        $cx = [int]($w * 0.16); $cy = 0
        $cw = [int]($w * 0.745); $ch = [int]($h * 0.845)
        if ($cw -gt 4 -and $ch -gt 4) {
          $rect = New-Object System.Drawing.Rectangle($cx, $cy, $cw, $ch)
          $crop = $bmp.Clone($rect, $bmp.PixelFormat)
          $scale = 3
          # 先灰度（ColorMatrix，一次 DrawImage，快）
          $gray = New-Object System.Drawing.Bitmap($cw, $ch)
          $gg = [System.Drawing.Graphics]::FromImage($gray)
          $cm = New-Object System.Drawing.Imaging.ColorMatrix
          $cm.Matrix00 = 0.299; $cm.Matrix01 = 0.299; $cm.Matrix02 = 0.299
          $cm.Matrix10 = 0.587; $cm.Matrix11 = 0.587; $cm.Matrix12 = 0.587
          $cm.Matrix20 = 0.114; $cm.Matrix21 = 0.114; $cm.Matrix22 = 0.114
          $cm.Matrix33 = 1.0; $cm.Matrix44 = 1.0
          $ia = New-Object System.Drawing.Imaging.ImageAttributes
          $ia.SetColorMatrix($cm)
          $destRect = New-Object System.Drawing.Rectangle(0, 0, $cw, $ch)
          $gg.DrawImage($crop, $destRect, 0, 0, $cw, $ch, [System.Drawing.GraphicsUnit]::Pixel, $ia)
          $gg.Dispose()
          $big = New-Object System.Drawing.Bitmap(($cw * $scale), ($ch * $scale))
          $g2 = [System.Drawing.Graphics]::FromImage($big)
          $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
          $g2.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
          $g2.DrawImage($gray, 0, 0, $big.Width, $big.Height)
          $g2.Dispose(); $gray.Dispose(); $crop.Dispose(); $bmp.Dispose()
          $big.Save($Png, [System.Drawing.Imaging.ImageFormat]::Png)
          $big.Dispose()
          return $true
        }
      } catch {   # 裁剪失败就退回整窗，绝不让采集挂掉
        try { $big.Dispose() } catch {}
      }
    }
    $bmp.Save($Png, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    return $true
  } catch { return $false }
}

function DoOcr([string]$png) {
  $res = [ordered]@{ ok = $false; width = 0; height = 0; lines = @(); error = '' }
  try {
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($png)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bmp = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $r = Await ($engine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
    $res.width = [int]$bmp.PixelWidth
    $res.height = [int]$bmp.PixelHeight
    $arr = @()
    foreach ($ln in $r.Lines) {
      $words = @($ln.Words)
      if ($words.Count -eq 0) { continue }
      $x1 = 1e9; $y1 = 1e9; $x2 = -1e9; $y2 = -1e9
      foreach ($wd in $words) {
        $rc = $wd.BoundingRect
        if ($rc.X -lt $x1) { $x1 = $rc.X }
        if ($rc.Y -lt $y1) { $y1 = $rc.Y }
        if (($rc.X + $rc.Width) -gt $x2) { $x2 = $rc.X + $rc.Width }
        if (($rc.Y + $rc.Height) -gt $y2) { $y2 = $rc.Y + $rc.Height }
      }
      $arr += @{ t = [string]$ln.Text; x = [int]$x1; y = [int]$y1; w = [int]($x2 - $x1); h = [int]($y2 - $y1) }
    }
    $res.lines = @($arr)
    $res.count = $arr.Count
    $res.ok = $true
  } catch { $res.error = $_.Exception.Message }
  return $res
}

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WeComClick {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  public struct RECT { public int L; public int T; public int R; public int B; }
  public static void ClickAt(int x, int y) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(120);
    mouse_event(0x0002, 0, 0, 0, IntPtr.Zero);
    System.Threading.Thread.Sleep(60);
    mouse_event(0x0004, 0, 0, 0, IntPtr.Zero);
    System.Threading.Thread.Sleep(120);
  }
}
"@
function Find-UnreadDot([int64]$hwnd, [int]$w, [int]$h) {
  # 扫左栏找"未读红点"：红色像素（R≥170 且 G/B≤100）聚成一簇，取最上面那一簇的 y。
  try {
    $bmp = New-Object System.Drawing.Bitmap($w, $h)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $hdc = $g.GetHdc()
    $ok = [CapW]::PrintWindow([IntPtr][int64]$hwnd, $hdc, 2)
    $g.ReleaseHdc($hdc); $g.Dispose()
    if (-not $ok) { $bmp.Dispose(); return $null }
    $x0 = [int]($w * 0.03); $x1 = [int]($w * 0.13)
    $y0 = [int]($h * 0.06); $y1 = [int]($h * 0.95)
    $hits = New-Object System.Collections.ArrayList
    for ($yy = $y0; $yy -lt $y1; $yy += 2) {
      $cnt = 0
      for ($xx = $x0; $xx -lt $x1; $xx += 2) {
        $c = $bmp.GetPixel($xx, $yy)
        if ($c.R -ge 170 -and $c.G -le 100 -and $c.B -le 100) { $cnt += 1 }
      }
      if ($cnt -ge 2) { [void]$hits.Add($yy) }
    }
    $bmp.Dispose()
    if ($hits.Count -eq 0) { return $null }
    return [int]$hits[0]
  } catch { return $null }
}

function Tick {
  $win = Get-MainWindow
  if (-not $win) { Write-ALog 'no WeWorkWindow (main window hidden or app gone)'; return }
  # 自愈：窗口存在但不可见（被"关闭到托盘"）→ 立刻拉回来。agent 本来每 2.5s 跑一次，
  # 比 30s 看护更早发现，等于给"防落托盘"加了条快路。
  if (-not $win.visible) {
    [void][CapW]::ShowWindow([IntPtr][int64]$win.hwnd, 5)   # SW_SHOW
    [void][CapW]::ShowWindow([IntPtr][int64]$win.hwnd, 3)   # SW_MAXIMIZE
    Write-ALog ('window was hidden -> restored hwnd=' + $win.hwnd)
    $win.visible = [bool][CapW]::IsWindowVisible([IntPtr][int64]$win.hwnd)
  }
  # 联调钩子：C:\xunyu\close-request.flag 出现时，对主窗发一次 WM_CLOSE（模拟"关到托盘"），然后删掉 flag。
  $flag = Join-Path $WorkDir 'close-request.flag'
  if (Test-Path $flag) {
    Remove-Item $flag -Force -ErrorAction SilentlyContinue
    [void][CapW]::PostMessage([IntPtr][int64]$win.hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
    Write-ALog ('WM_CLOSE sent to hwnd=' + $win.hwnd + ' (close-request.flag)')
  }
  $cap = Capture $win.hwnd $win.w $win.h
  if (-not $cap) { Write-ALog ('capture failed hwnd=' + $win.hwnd); return }

  # 2026-10-30 23:05（主人要求）：左栏有未读红点 → 自动点开那个会话，再重新截图。
  # 只做"点进未读会话"，不做别的输入；30 秒冷却，避免来回抢焦点。
  $switched = 0
  try {
    if ($UnreadAutoSwitch) {
      $now = Get-Date
      if (-not $script:lastSwitchAt -or ($now - $script:lastSwitchAt).TotalSeconds -ge 30) {
        $dot = Find-UnreadDot $win.hwnd $win.w $win.h
        if ($dot) {
          [WeComClick]::ClickAt([int]($win.w * 0.09), [int]$dot) | Out-Null
          Start-Sleep -Milliseconds 1400
          $script:lastSwitchAt = Get-Date
          $switched = 1
          Write-ALog ('unread red dot at y=' + [int]$dot + ' -> switched')
          $cap = Capture $win.hwnd $win.w $win.h
        }
      }
    }
  } catch { Write-ALog ('unread switch error: ' + $_.Exception.Message) }

  $ocr = DoOcr $Png
  $frame = [ordered]@{
    at = (Get-Date).ToString('s')
    ts = [int64]([DateTimeOffset]::Now.ToUnixTimeMilliseconds())
    hwnd = $win.hwnd
    w = $win.w
    h = $win.h
    autoSwitched = $switched
    ocrOk = [bool]$ocr.ok
    ocrError = [string]$ocr.error
    lineCount = @($ocr.lines).Count
    lines = @($ocr.lines)
  }
  if (@($ocr.lines).Count -eq 0) { Write-ALog ('ocr returned 0 lines (ok=' + $ocr.ok + ' err=' + $ocr.error + ')') }
  try {
    if ((Test-Path $Frames) -and ((Get-Item $Frames).Length -gt 20MB)) { Move-Item $Frames ($Frames + '.1') -Force }
  } catch { }
  Add-Content -Path $Frames -Value ($frame | ConvertTo-Json -Compress -Depth 6) -Encoding UTF8
}

Write-ALog ('agent start pid={0} interval={1}ms once={2}' -f $PID, $IntervalMs, [bool]$Once)
if ($Once) { Tick; exit 0 }
while ($true) {
  try { Tick } catch { Write-ALog ('tick error: ' + $_.Exception.Message) }
  Start-Sleep -Milliseconds $IntervalMs
}
