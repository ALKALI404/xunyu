# wecom-vm-watchdog.ps1 -- keeps WeCom main window alive inside the VM (WC-005, 03)
# ASCII only on purpose: Windows PowerShell 5.1 mis-parses non-ASCII when the file has no BOM.
#
# What it does every run:
#   1) no WXWork process  -> start it
#   2) process exists but no top-level window (window destroyed / tray) -> wake by a second
#      launch; if that fails -> restart the app (rate limited)
#   3) window exists -> ShowWindow(SW_RESTORE) if minimized, then SW_MAXIMIZE to keep it visible
#
# Must run in the *interactive user session* (session 2). Started by scheduled task
# XunyuWeComWatchdog (logon trigger + repeat every minute). Running it from ssh puts it in
# session 0 where no window can ever appear -- that is a trap we hit on 2026-10-29.
param(
  [string]$Exe = 'C:\Program Files (x86)\WXWork\WXWork.exe',
  [string]$WorkDir = 'C:\xunyu',
  [switch]$Once,
  [int]$IntervalSec = 60
)

$ErrorActionPreference = 'SilentlyContinue'
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
$LogFile = Join-Path $WorkDir 'wecom-watchdog.log'
$StateFile = Join-Path $WorkDir 'wecom-watchdog-state.json'
$StatusFile = Join-Path $WorkDir 'wecom-watchdog-status.json'

# The status file is the ONLY way another session can see window facts: ssh lands in
# session 0, where EnumWindows cannot see session 2 windows (MainWindowHandle is 0 too),
# so the health probe must read this file instead of enumerating by itself.
function Save-Status($main, [string]$action) {
  try {
    $wc = @(Get-Process WXWork -ErrorAction SilentlyContinue).Count
    $hwnd = 0; $wpid = 0; $cls = ''; $txt = ''; $vis = $false
    if ($main) {
      $hwnd = [int64]$main.hwnd
      $wpid = [int]$main.pid
      $cls = [string]$main.cls
      # 窗口标题里有中文；PS 5.1 的 ConvertTo-Json + 文件编码在不同代码页下会被读成乱码，
      # 而标题对健康判定没用（判定只看 hwnd/visible），所以这里只保留 ASCII。
      $txt = ([string]$main.text) -replace '[^\x20-\x7E]', '?'
      $vis = [bool]$main.visible
    }
    # hwnd change tracking (WC-005 rev2): 04's sender needs to know WHEN the handle moved.
    # Every change is logged as a separate line and kept in the status file (last 10).
    $prevHwnd = 0
    $hist = @()
    $prev = $null
    try { $prev = Get-Content $StatusFile -Raw | ConvertFrom-Json } catch { }
    if ($prev) {
      $prevHwnd = [int64]$prev.hwnd
      if ($prev.history) { $hist = @($prev.history) }
    }
    $changedAt = ''
    if ($hwnd -gt 0 -and $prevHwnd -gt 0 -and $hwnd -ne $prevHwnd) {
      $changedAt = (Get-Date).ToString('s')
      Write-WLog ("hwnd CHANGED old={0} new={1} pid={2}" -f $prevHwnd, $hwnd, $wpid)
      $hist = @($hist + [pscustomobject]@{ at = $changedAt; old = $prevHwnd; new = $hwnd })
      if ($hist.Count -gt 10) { $hist = @($hist | Select-Object -Last 10) }
    }
    ([ordered]@{
      at = (Get-Date).ToString('s')
      sessionId = (Get-Process -Id $PID).SessionId
      action = $action
      hwnd = $hwnd
      prevHwnd = $prevHwnd
      changedAt = $changedAt
      history = @($hist)
      pid = $wpid
      class = $cls
      title = $txt
      visible = $vis
      wxworkCount = $wc
    }) | ConvertTo-Json -Compress -Depth 5 | Set-Content $StatusFile -Encoding UTF8
  } catch { }
}

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WDog {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public struct RECT { public int L; public int T; public int R; public int B; }
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
"@

function Write-WLog([string]$msg) {
  $line = '{0} [watchdog] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  try {
    if ((Test-Path $LogFile) -and ((Get-Item $LogFile).Length -gt 5MB)) {
      Move-Item $LogFile ($LogFile + '.1') -Force
    }
  } catch { }
  Add-Content -Path $LogFile -Value $line -Encoding UTF8
}

function Get-MyWxWindows {
  $pids = @(Get-Process WXWork -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  $rows = New-Object System.Collections.ArrayList
  if ($pids.Count -eq 0) { return @() }
  $cb = [WDog+EnumProc]{
    param($h, $l)
    $procId = 0
    [void][WDog]::GetWindowThreadProcessId($h, [ref]$procId)
    if ($pids -contains [int]$procId) {
      $cls = New-Object System.Text.StringBuilder 256
      [void][WDog]::GetClassName($h, $cls, 256)
      $txt = New-Object System.Text.StringBuilder 512
      [void][WDog]::GetWindowText($h, $txt, 512)
      $rect = New-Object WDog+RECT
      $area = 0
      if ([WDog]::GetWindowRect($h, [ref]$rect)) { $area = [int64]($rect.R - $rect.L) * [int64]($rect.B - $rect.T) }
      [void]$rows.Add([pscustomobject]@{
        hwnd = [int64]$h
        pid = [int]$procId
        visible = [bool][WDog]::IsWindowVisible($h)
        iconic = [bool][WDog]::IsIconic($h)
        cls = $cls.ToString()
        text = $txt.ToString()
        area = $area
      })
    }
    return $true
  }
  [void][WDog]::EnumWindows($cb, [IntPtr]::Zero)
  return @($rows)
}

function Select-MainWindow($wins) {
  if (-not $wins -or $wins.Count -eq 0) { return $null }
  # 优先沿用上一次的 hwnd（hwnd 稳定是 04 发送器的前提）；它没了再按"有标题+面积最大"重挑。
  $prevHwnd = 0
  try {
    $st = Get-Content $StatusFile -Raw | ConvertFrom-Json
    if ($st) { $prevHwnd = [int64]$st.hwnd }
  } catch { }
  if ($prevHwnd -gt 0) {
    $same = @($wins | Where-Object { [int64]$_.hwnd -eq $prevHwnd })
    if ($same.Count -gt 0) { return $same[0] }
  }
  $scored = $wins | Sort-Object -Property @{ Expression = { if ($_.text) { 1 } else { 0 } }; Descending = $true },
                                        @{ Expression = { [int64]$_.area }; Descending = $true }
  return @($scored)[0]
}

function Read-State {
  try { return (Get-Content $StateFile -Raw | ConvertFrom-Json) } catch { return $null }
}
function Save-State($obj) {
  try { $obj | ConvertTo-Json -Compress | Set-Content $StateFile -Encoding UTF8 } catch { }
}
function Test-RateAllowed {
  $st = Read-State
  $now = Get-Date
  $cut = $now.AddMinutes(-10)
  $stamps = @()
  if ($st -and $st.restarts) { $stamps = @($st.restarts | ForEach-Object { [datetime]$_ } | Where-Object { $_ -gt $cut }) }
  return @{ allowed = ($stamps.Count -lt 3); stamps = $stamps }
}
function Add-RestartStamp {
  $st = Read-State
  $cut = (Get-Date).AddMinutes(-10)
  $stamps = @()
  if ($st -and $st.restarts) { $stamps = @($st.restarts | ForEach-Object { [datetime]$_ } | Where-Object { $_ -gt $cut }) }
  $stamps += Get-Date
  Save-State @{ restarts = @($stamps | ForEach-Object { $_.ToString('s') }) }
}

function Tick {
  $procs = @(Get-Process WXWork -ErrorAction SilentlyContinue)
  if ($procs.Count -eq 0) {
    if (-not (Test-Path $Exe)) { Write-WLog "no WXWork process and exe missing: $Exe"; return }
    Start-Process -FilePath $Exe -WorkingDirectory (Split-Path $Exe -Parent)
    Write-WLog 'no WXWork process -> started'
    Start-Sleep -Seconds 8
  }

  $wins = @(Get-MyWxWindows)
  if ($wins.Count -gt 0) {
    $main = Select-MainWindow $wins
    $h = [IntPtr][int64]$main.hwnd
    if ($main.iconic) { [void][WDog]::ShowWindow($h, 9) }           # SW_RESTORE
    if (-not $main.visible) { [void][WDog]::ShowWindow($h, 5) }     # SW_SHOW
    [void][WDog]::ShowWindow($h, 3)                                 # SW_MAXIMIZE
    [void][WDog]::SetForegroundWindow($h)
    $main.visible = [bool][WDog]::IsWindowVisible($h)   # 记 ShowWindow 之后的事实，别把旧值写进状态
    Write-WLog ("window ok hwnd={0} pid={1} class={2} title={3}" -f $main.hwnd, $main.pid, $main.cls, $main.text)
    Save-Status $main 'ok'
    return
  }

  # 2) process alive but zero top-level windows (destroyed / stuck in tray)
  Write-WLog 'no top-level window -> try wake by second launch'
  if (Test-Path $Exe) { Start-Process -FilePath $Exe -WorkingDirectory (Split-Path $Exe -Parent) | Out-Null }
  Start-Sleep -Seconds 6
  $wins = @(Get-MyWxWindows)
  if ($wins.Count -gt 0) {
    $main = Select-MainWindow $wins
    [void][WDog]::ShowWindow([IntPtr][int64]$main.hwnd, 3)
    $main.visible = [bool][WDog]::IsWindowVisible([IntPtr][int64]$main.hwnd)
    Write-WLog ("wake worked hwnd={0}" -f $main.hwnd)
    Save-Status $main 'woke'
    return
  }

  $rate = Test-RateAllowed
  if (-not $rate.allowed) {
    Write-WLog ('wake failed; restart suppressed (already {0} restarts in 10min)' -f $rate.stamps.Count)
    Save-Status $null 'no-window-suppressed'
    return
  }
  Add-RestartStamp
  Write-WLog 'wake failed -> restart WXWork'
  Get-Process WXWork -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 3
  if (Test-Path $Exe) { Start-Process -FilePath $Exe -WorkingDirectory (Split-Path $Exe -Parent) | Out-Null }
  Start-Sleep -Seconds 12
  $wins = @(Get-MyWxWindows)
  if ($wins.Count -gt 0) {
    $main = Select-MainWindow $wins
    [void][WDog]::ShowWindow([IntPtr][int64]$main.hwnd, 3)
    $main.visible = [bool][WDog]::IsWindowVisible([IntPtr][int64]$main.hwnd)
    Write-WLog ("restart recovered window hwnd={0}" -f $main.hwnd)
    Save-Status $main 'restarted'
  } else {
    Write-WLog 'restart done but still no window'
    Save-Status $null 'no-window'
  }
}

Write-WLog ('start pid={0} exe={1} once={2} interval={3}s' -f $PID, $Exe, [bool]$Once, $IntervalSec)
if ($Once) {
  Tick
  exit 0
}
while ($true) {
  try { Tick } catch { Write-WLog ('tick error: ' + $_.Exception.Message) }
  Start-Sleep -Seconds $IntervalSec
}
