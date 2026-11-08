# scripts/vm/wecom-lib.ps1 —— VM 内企微窗口操作库（只做窗口/输入，不做业务编排）
#
# 踩过的四个坑，都在这里修掉了（详见 README-WC-004.md）：
#   1. v1 的 Add-Type 把 `uint GetWindowThreadProcessId(IntPtr, out uint)` 当成 `(IntPtr, IntPtr)` 调用 →
#      C# 编译失败 → 类型不存在 → 枚举"0 个窗口"（这才是"以前枚举返回 0"的根因，不是企微没窗口）。
#   2. EnumWindows 的回调从 native 代码回来，**看不见函数局部变量**（$acc 为 null，.Add 静默失败）→
#      累加器必须放 `$script:` 作用域。
#   3. 回调里必须写 `[WeCom]::Xxx(...)`；写成 `WeCom::Xxx(...)` 会被当成命令名 → 同样"0 个窗口"。
#   4. `Start-Sleep -Milliseconds [int]$Cfg.x` 这种写法 PowerShell 不当作表达式（会把 $Cfg 整个塞进去），
#      必须写成 `([int]$Cfg.x)`。
#
# 用法（VM 内 send.ps1 里 dot-source）：
#   . C:\Temp\vm\wecom-lib.ps1
#   $opened = Open-WeComChat -Conv '文件传输助手' -Cfg $cfg
#   Send-WeComText -Text '...' -Cfg $cfg -Tag $id

$ErrorActionPreference = 'Continue'

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WeCom {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int size);
  // IsWindowVisible 返回 true 的窗口也可能是"隐形"的（DWM cloak，企微的全局搜索页关掉后就常这样）。
  // 不排掉它，脚本会以为搜索页还开着，一直点"进入聊天"。
  public static bool IsCloaked(IntPtr h) { int v = 0; int hr = DwmGetWindowAttribute(h, 14, out v, 4); return hr == 0 && v != 0; }
  public static bool IsReallyVisible(IntPtr h) { return IsWindow(h) && IsWindowVisible(h) && !IsCloaked(h); }
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr h);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr h, IntPtr dc);
  [DllImport("gdi32.dll")] public static extern uint GetPixel(IntPtr dc, int x, int y);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

  public static string ClassOf(IntPtr h) { var sb = new StringBuilder(256); GetClassNameW(h, sb, 256); return sb.ToString(); }
  public static string TitleOf(IntPtr h) { var sb = new StringBuilder(512); GetWindowTextW(h, sb, 512); return sb.ToString(); }
  public static int[] RectOf(IntPtr h) { RECT r; GetWindowRect(h, out r); return new int[] { r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top }; }
  // 客户区（去掉标题栏/边框）的屏幕坐标：坐标全部按客户区算，窗口加不加标题栏都不影响
  public static int[] ClientRect(IntPtr h) {
    RECT r; GetClientRect(h, out r);
    POINT p; p.X = 0; p.Y = 0; ClientToScreen(h, ref p);
    return new int[] { p.X, p.Y, r.Right - r.Left, r.Bottom - r.Top };
  }
  public static bool Force(IntPtr h) {
    if (!IsWindow(h)) return false;
    if (GetForegroundWindow() == h) return true;
    // 坑：SW_RESTORE(9) 用在**最大化**的窗口上会把它还原成"普通大小"——坐标比例立刻全错。
    // 2026-10-30 02:45 就这么把窗口从 1920×1044 缩成 1024×726，"画面变了"被误当成"切了会话"。
    bool zoomed = IsZoomed(h);
    ShowWindow(h, zoomed ? 3 : 9);
    uint pid = 0;
    uint tf = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
    uint tm = GetWindowThreadProcessId(h, out pid);
    bool at = false;
    if (tf != tm) at = AttachThreadInput(tf, tm, true);
    SetForegroundWindow(h);
    if (at) AttachThreadInput(tf, tm, false);
    System.Threading.Thread.Sleep(300);
    return GetForegroundWindow() == h;
  }
  public static void Normalize(IntPtr h, int x, int y, int w, int hh) {
    SetWindowPos(h, IntPtr.Zero, x, y, w, hh, 0x44);
    System.Threading.Thread.Sleep(250);
  }
  public static void Click(int x, int y) {
    SetCursorPos(x, y); System.Threading.Thread.Sleep(110);
    mouse_event(0x0002, 0, 0, 0, IntPtr.Zero); System.Threading.Thread.Sleep(55);
    mouse_event(0x0004, 0, 0, 0, IntPtr.Zero); System.Threading.Thread.Sleep(160);
  }
  public static void Key(byte vk) {
    keybd_event(vk, 0, 0, IntPtr.Zero); System.Threading.Thread.Sleep(40);
    keybd_event(vk, 0, 2, IntPtr.Zero); System.Threading.Thread.Sleep(30);
  }
  public static void Combo(string vks) {
    var arr = vks.Split(',');
    foreach (var s in arr) { keybd_event(Convert.ToByte(s), 0, 0, IntPtr.Zero); System.Threading.Thread.Sleep(35); }
    for (int i = arr.Length - 1; i >= 0; i--) { keybd_event(Convert.ToByte(arr[i]), 0, 2, IntPtr.Zero); System.Threading.Thread.Sleep(25); }
  }
  public static int InkCount(int x, int y, int w, int h, int tol) {
    IntPtr dc = GetDC(IntPtr.Zero);
    int n = 0;
    for (int yy = y; yy < y + h; yy += 2) {
      for (int xx = x; xx < x + w; xx += 2) {
        uint c = GetPixel(dc, xx, yy);
        int r = (int)(c & 0xFF), g = (int)((c >> 8) & 0xFF), b = (int)((c >> 16) & 0xFF);
        if (r < 255 - tol || g < 255 - tol || b < 255 - tol) n++;
      }
    }
    ReleaseDC(IntPtr.Zero, dc);
    return n;
  }
}
"@

Add-Type -AssemblyName System.Windows.Forms, System.Drawing

$script:wcAcc = $null

function Snap-Screen([string]$Path) {
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap $vs.Width, $vs.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($vs.Left, $vs.Top, 0, 0, $bmp.Size)
  $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  return $Path
}

# 只截一小块（判定会话标题条这种"局部变化"，避免全屏 hash 被搜索框/下拉的绘制骗过去）
function Snap-Region([string]$Path, [int]$X, [int]$Y, [int]$W, [int]$H) {
  $bmp = New-Object System.Drawing.Bitmap $W, $H
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($X, $Y, 0, 0, $bmp.Size)
  $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  return $Path
}

# 标题条指纹：把"这个会话打开时标题条长什么样"记下来，下次比对（免 OCR 认名字）
function Get-HeaderCropPath([string]$Conv) {
  $h = ($Conv.ToCharArray() | ForEach-Object { [int]$_ }) -join '_'
  return "C:\Temp\wcref-$h.png"
}
# 群聊/单聊的标题条不一定长得一样（群聊右侧可能多成员数、群看板按钮），
# 所以 headerRegion 允许按会话名覆盖：config.headerRegionByConv["群名"] = {rx,ry,rw,rh}
function Get-HeaderBox($Cfg, [IntPtr]$Main, [string]$Conv) {
  $r = [WeCom]::ClientRect($Main)
  $spec = $Cfg.headerRegion
  if ($Cfg.headerRegionByConv -and $Conv) {
    $ov = $Cfg.headerRegionByConv.PSObject.Properties[$Conv]
    if ($ov -and $ov.Value) { $spec = $ov.Value }
  }
  return (Resolve-Box $r $spec)
}
function Save-HeaderRef($Cfg, [IntPtr]$Main, [string]$Conv) {
  $box = Get-HeaderBox $Cfg $Main $Conv
  if (-not $box) { return $null }
  # 干净度检查：裁出来是一块空白（窗口被遮挡/最小化/区域量错）时**拒绝存指纹**。
  # 事故里那张 481 字节的 "PREVIEW" 废指纹就是一块空白——存进去等于给自己发通行证。
  # 判定用"裁剪图 PNG 体积"当墨迹代理：空白块压缩后仅数百字节，带文字的标题条是 2~3 KB。
  # （原先逐像素 GetPixel 数墨迹，480×320 要几万次 GDI 调用，实测能把 watcher 卡住两分钟以上。）
  $p = Get-HeaderCropPath $Conv
  Snap-Region $p $box.x $box.y $box.w $box.h | Out-Null
  $minBytes = 800
  if ($null -ne $Cfg.headerMinBytes) { $minBytes = [int]$Cfg.headerMinBytes }
  if (-not (Test-Path $p)) { return $null }
  if ((Get-Item $p).Length -lt $minBytes) { Remove-Item $p -Force; return $null }
  return (Get-Sha256 $p)
}
function Clear-HeaderRef([string]$Conv) {
  $p = Get-HeaderCropPath $Conv
  if (Test-Path $p) { Remove-Item -Path $p -Force; return $true }
  return $false
}
function List-HeaderRefs() {
  $out = @()
  foreach ($f in @(Get-ChildItem 'C:\Temp\wcref-*.png' -ErrorAction SilentlyContinue)) {
    $codes = ($f.BaseName -replace '^wcref-', '') -split '_'
    $name = ''
    foreach ($c in $codes) { if ($c -match '^\d+$') { $name += [string][char][int]$c } }
    $out += [ordered]@{ file = $f.Name; conv = $name; bytes = $f.Length; at = $f.LastWriteTime.ToString('s'); sha256 = (Get-Sha256 $f.FullName) }
  }
  return $out
}
function Get-HeaderRefHash([string]$Conv) {
  $p = Get-HeaderCropPath $Conv
  if (-not (Test-Path $p)) { return $null }
  return (Get-Sha256 $p)
}
function Get-Sha256([string]$Path) {
  if (-not (Test-Path $Path)) { return $null }
  return (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLower()
}

function Find-WindowByClass([string]$Class, [switch]$Visible) {
  $script:wcAcc = New-Object System.Collections.ArrayList
  $cb = [WeCom+EnumWindowsProc]{
    param($h, $l)
    if ([WeCom]::ClassOf($h) -eq $Class) {
      if (-not $Visible -or [WeCom]::IsReallyVisible($h)) { $null = $script:wcAcc.Add($h) }
    }
    return $true
  }
  [void][WeCom]::EnumWindows($cb, [IntPtr]::Zero)
  $found = @($script:wcAcc)
  $script:wcAcc = $null
  return $found
}

# 主窗口：优先可见的；落托盘但句柄还在就 Show 出来；彻底没了就在交互会话里重新拉起企微
function Get-WeComMain($Cfg) {
  $all = @(Find-WindowByClass $Cfg.windowClass)
  $vis = @($all | Where-Object { [WeCom]::IsWindowVisible($_) -and [WeCom]::IsWindow($_) })
  if ($vis.Count -gt 0) { return $vis[0] }
  foreach ($h in $all) {
    if (-not [WeCom]::IsWindow($h)) { continue }
    [void][WeCom]::Force($h)
    Start-Sleep -Milliseconds 600
    if ([WeCom]::IsWindowVisible($h)) { return $h }
  }
  $exe = if ($Cfg.wecomExe) { $Cfg.wecomExe } else { 'C:\Program Files (x86)\WXWork\WXWork.exe' }
  if (Test-Path $exe) {
    Start-Process $exe -ErrorAction SilentlyContinue
    for ($i = 0; $i -lt 25; $i++) {
      Start-Sleep -Milliseconds 1000
      $now = @(Find-WindowByClass $Cfg.windowClass -Visible)
      if ($now.Count -gt 0) { return $now[0] }
    }
  }
  return $null
}

# 坐标解析：配置里既可以写绝对偏移 {dx,dy}，也可以写比例 {rx,ry}（相对主窗口宽高）。
# 比例版是为了**换分辨率不用重新量**（WC-010 把 VM 改成 1920×1080 + 字号放大，就是这么接的）。
function Resolve-Point($Rect, $Spec) {
  if (-not $Spec) { return $null }
  if ($null -ne $Spec.rx -and $null -ne $Spec.ry) {
    return @{ x = $Rect[0] + [int]($Rect[2] * [double]$Spec.rx); y = $Rect[1] + [int]($Rect[3] * [double]$Spec.ry) }
  }
  return @{ x = $Rect[0] + [int]$Spec.dx; y = $Rect[1] + [int]$Spec.dy }
}

function Resolve-Box($Rect, $Spec) {
  if (-not $Spec) { return $null }
  if ($null -ne $Spec.rx -and $null -ne $Spec.ry) {
    return @{ x = $Rect[0] + [int]($Rect[2] * [double]$Spec.rx); y = $Rect[1] + [int]($Rect[3] * [double]$Spec.ry); w = [int]($Rect[2] * [double]$Spec.rw); h = [int]($Rect[3] * [double]$Spec.rh) }
  }
  return @{ x = $Rect[0] + [int]$Spec.x; y = $Rect[1] + [int]$Spec.y; w = [int]$Spec.w; h = [int]$Spec.h }
}

# 把主窗口钉到固定几何：分辨率/最大化状态一变，所有比例坐标就得重量。
# 做法是**每次都先归位**，而不是相信"窗口现在的样子"——2026-10-30 02:45 的误判就是相信了后者。
function Ensure-Geometry([IntPtr]$Main, $Cfg) {
  if (-not $Cfg.normalize) { return }
  $mode = 'size'
  if ($null -ne $Cfg.normalize.mode) { $mode = [string]$Cfg.normalize.mode }
  if ($mode -eq 'maximize') {
    # 屏幕固定 1920×1080 → 最大化后的 client 恒为 1924×1044，比例坐标因此稳定
    if (-not [WeCom]::IsZoomed($Main)) { [void][WeCom]::ShowWindow($Main, 3); Start-Sleep -Milliseconds 500 }
    return
  }
  if ([WeCom]::IsZoomed($Main)) { [void][WeCom]::ShowWindow($Main, 9); Start-Sleep -Milliseconds 500 }
  [WeCom]::Normalize($Main, [int]$Cfg.normalize.x, [int]$Cfg.normalize.y, [int]$Cfg.normalize.w, [int]$Cfg.normalize.h)
  Start-Sleep -Milliseconds 350
}

function Set-WeComGeometry($Cfg) {
  $main = Get-WeComMain $Cfg
  if (-not $main) { return @{ ok = $false; code = 'no-main-window' } }
  [void][WeCom]::Force($main)
  Start-Sleep -Milliseconds 250
  Ensure-Geometry $main $Cfg
  $cli = [WeCom]::ClientRect($main)
  $wr = [WeCom]::RectOf($main)
  return @{ ok = $true; hwnd = $main.ToInt64(); rect = @{ x = $wr[0]; y = $wr[1]; w = $wr[2]; h = $wr[3] }; client = @{ x = $cli[0]; y = $cli[1]; w = $cli[2]; h = $cli[3] }; zoomed = [bool][WeCom]::IsZoomed($main) }
}

# 只做"搜索框输入 + 等下拉"，**不按任何键**：用来一步步看清企微到底怎么响应。
# 返回 searchBoxChanged（粘贴是否落到框里）与 dropdownBytes（下拉区裁剪图体积≈有没有结果）。
function Search-WeComChat([string]$Conv, $Cfg) {
  $main = Get-WeComMain $Cfg
  if (-not $main) { return @{ ok = $false; code = 'no-main-window' } }
  [void][WeCom]::Force($main)
  Ensure-Geometry $main $Cfg
  Start-Sleep -Milliseconds 300
  $r = [WeCom]::ClientRect($main)
  for ($i = 0; $i -lt 2; $i++) {
    $stale = (Find-WindowByClass $Cfg.searchWindowClass -Visible | Select-Object -First 1)
    if (-not $stale) { break }
    [void][WeCom]::Force($stale)
    Start-Sleep -Milliseconds 200
    [WeCom]::Key(0x1B)
    Start-Sleep -Milliseconds 400
    [void][WeCom]::Force($main)
    Start-Sleep -Milliseconds 300
  }
  $sp = Resolve-Point $r $Cfg.mainSearchBox
  [WeCom]::Click($sp.x, $sp.y)
  Start-Sleep -Milliseconds 450
  [WeCom]::Combo('17,65'); Start-Sleep -Milliseconds 150
  [WeCom]::Key(0x2E); Start-Sleep -Milliseconds 450
  $sbox = Resolve-Box $r $Cfg.searchBoxRegion
  $b1 = 'C:\Temp\wc-search-before.png'
  $a1 = 'C:\Temp\wc-search-after.png'
  Snap-Region $b1 $sbox.x $sbox.y $sbox.w $sbox.h | Out-Null
  Set-Clipboard -Value $Conv
  Start-Sleep -Milliseconds 250
  [WeCom]::Combo('17,86')
  Start-Sleep -Milliseconds 500
  Snap-Region $a1 $sbox.x $sbox.y $sbox.w $sbox.h | Out-Null
  $changed = ((Get-Sha256 $b1) -ne (Get-Sha256 $a1))
  Start-Sleep -Milliseconds ([int]$Cfg.searchWaitMs)
  $dbox = Resolve-Box $r $Cfg.dropdownRegion
  $dropBytes = 0
  $dropFile = 'C:\Temp\wc-dropdown.png'
  if ($dbox) {
    Snap-Region $dropFile $dbox.x $dbox.y $dbox.w $dbox.h | Out-Null
    if (Test-Path $dropFile) { $dropBytes = (Get-Item $dropFile).Length }
  }
  $shot = 'C:\Temp\wc-search-now.png'
  Snap-Screen $shot | Out-Null
  return @{ ok = $changed; code = if ($changed) { 'searched' } else { 'search-paste-failed' }; conv = $Conv; searchBoxChanged = [bool]$changed; dropdownBytes = $dropBytes; searchBox = @{ x = $sbox.x; y = $sbox.y; w = $sbox.w; h = $sbox.h }; dropdown = $dbox; shot = $shot; searchPoint = $sp; main = $main.ToInt64() }
}

function Focus-InputBox($Cfg) {
  $main = Get-WeComMain $Cfg
  if (-not $main) { return @{ ok = $false; code = 'no-main-window' } }
  [void][WeCom]::Force($main)
  Start-Sleep -Milliseconds 200
  $r = [WeCom]::ClientRect($main)
  $pt = Resolve-Point $r $Cfg.inputBox
  [WeCom]::Click($pt.x, $pt.y)
  Start-Sleep -Milliseconds 350
  return @{ ok = $true; main = $main; point = $pt }
}

# * 打开会话：主窗口搜索框粘贴会话名 → 点下拉第一行（必要时再点「全局搜索」页里的「进入聊天」）。
# 「打开成功」的判据**只有一个**：右侧标题条的裁剪图与本会话已存的指纹**逐像素一致**。
# 没有指纹（没 bootstrap 过）→ 一律 chat-not-verified，不输入、不回车、不发（fail-closed）。
# 同一个会话本来就开着时画面不会变，但指纹仍一致 → 判定照样通过（老版本这里会误报）。
# 历史：老版本用「↓ + 回车」打开搜索下拉第一行；2026-10-30 实测第一行默认就是选中态，
# 按 ↓ 反而移到第二行的「应用提醒」，回车于是打开了一条消息提醒——已弃用。
function Open-WeComChat([string]$Conv, $Cfg) {
  $main = Get-WeComMain $Cfg
  if (-not $main) { return @{ ok = $false; code = 'no-main-window' } }
  [void][WeCom]::Force($main)
  Ensure-Geometry $main $Cfg
  Start-Sleep -Milliseconds 350
  $r = [WeCom]::ClientRect($main)

  # ── 第 0 步：**先看目标会话是不是本来就开着** ─────────────────────────────
  # 老版本不管三七二十一先走"搜索→粘贴会话名"，而那个粘贴检查一旦误判就整条发送 abort。
  # 现网 21:43:42 的 search-paste-failed 就是这么挂的（目标「许驰(service)」当时明明就在眼前）。
  # 有指纹且当前标题条与指纹一致 → 直接算打开成功，完全不碰搜索框。
  $refFast = Get-HeaderRefHash $Conv
  if ($refFast) {
    $hboxFast = Get-HeaderBox $Cfg $main $Conv
    if ($hboxFast) {
      Snap-Region 'C:\Temp\wc-fastcheck.png' $hboxFast.x $hboxFast.y $hboxFast.w $hboxFast.h | Out-Null
      $curFast = Get-Sha256 'C:\Temp\wc-fastcheck.png'
      if ($curFast -eq $refFast) {
        return @{ ok = $true; code = 'chat-opened'; why = 'already-open-header-matches-ref'; main = $main.ToInt64(); beforeHash = $curFast; afterHash = $curFast; ref = $refFast; skippedSearch = $true }
      }
    }
  }

  # 先把可能残留的「全局搜索」窗关掉（上一次失败可能把它留在屏上，不关会误判下一次）
  for ($i = 0; $i -lt 2; $i++) {
    $stale = (Find-WindowByClass $Cfg.searchWindowClass -Visible | Select-Object -First 1)
    if (-not $stale) { break }
    [void][WeCom]::Force($stale)
    Start-Sleep -Milliseconds 200
    [WeCom]::Key(0x1B)
    Start-Sleep -Milliseconds 400
    [void][WeCom]::Force($main)
    Start-Sleep -Milliseconds 300
  }

  # 先把界面切到一个"基线会话"（不是目标），这样"目标真的切过去了"就能用画面变化证明；
  # 目标会话本身只靠搜索框定位，不点左侧列表里的目标行。
  if ($Cfg.baselineChat) {
    $bp = Resolve-Point $r $Cfg.baselineChat
    [WeCom]::Click($bp.x, $bp.y)
    Start-Sleep -Milliseconds 700
  }
  # 判定"真的切过去了"只看**会话标题条那一小条**（headerRegion）：
  # 全屏 hash 会被搜索框/下拉的绘制骗过去（WC-004 判据③ 就栽在这：不存在的会话名也"看起来变了"）。
  $hbox = Resolve-Box $r $Cfg.headerRegion
  $beforePng = 'C:\Temp\wc-opencheck-before.png'
  Snap-Region $beforePng $hbox.x $hbox.y $hbox.w $hbox.h | Out-Null
  $beforeHash = Get-Sha256 $beforePng

  # 搜索 + 点结果，最多试两次：两次都不行就判 chat-not-verified，**绝不进入输入/发送**。
  for ($try = 1; $try -le 2; $try++) {
    # 剪贴板先自检（放在点击之前）：Get-Clipboard 会去开剪贴板，夹在"点搜索框"和"Ctrl+V"之间
    # 会让搜索框丢掉焦点——2026-10-30 21:55 实测（表现为 searchbox-not-focused，而 --search 却能粘贴成功）。
    $cbBack = $null
    try { Set-Clipboard -Value $Conv; Start-Sleep -Milliseconds 200; $cbBack = Get-Clipboard -Raw } catch { $cbBack = $null }
    if ("$cbBack" -ne $Conv) {
      Snap-Screen 'C:\Temp\wc-searchfail.png' | Out-Null
      return @{ ok = $false; code = 'clipboard-unavailable'; why = 'Set-Clipboard 后回读与要发的不一致（剪贴板被别的进程占用）'; conv = $Conv; stage = 'clipboard'; got = "$cbBack".Length }
    }
    $sp = Resolve-Point $r $Cfg.mainSearchBox
    [WeCom]::Click($sp.x, $sp.y)
    Start-Sleep -Milliseconds 400
    # 清框清两遍：企微的搜索框偶尔吃掉第一下 Ctrl+A
    [WeCom]::Combo('17,65'); Start-Sleep -Milliseconds 130
    [WeCom]::Key(0x2E); Start-Sleep -Milliseconds 220
    [WeCom]::Combo('17,65'); Start-Sleep -Milliseconds 130
    [WeCom]::Key(0x2E); Start-Sleep -Milliseconds 500
    # 【W-251 事故的正面修法 + 2026-10-30 21:43 现网教训】
    # 判据用"空框"当基准，而不是"粘贴前后"：框里本来就写着同一个会话名时，
    # 前后逐像素一样 → 老版本会误报 search-paste-failed（现网就是这么挂的）。
    $sbox = Resolve-Box $r $Cfg.searchBoxRegion
    $blankBytes = 0
    $blankHash = $null
    if ($sbox) {
      Snap-Region 'C:\Temp\wc-search-blank.png' $sbox.x $sbox.y $sbox.w $sbox.h | Out-Null
      $blankHash = Get-Sha256 'C:\Temp\wc-search-blank.png'
      if (Test-Path 'C:\Temp\wc-search-blank.png') { $blankBytes = (Get-Item 'C:\Temp\wc-search-blank.png').Length }
      $blankMax = 1900
      if ($null -ne $Cfg.searchBoxBlankMaxBytes) { $blankMax = [int]$Cfg.searchBoxBlankMaxBytes }
      if ($blankBytes -gt $blankMax) {
        # 清不掉框里的旧字 → 说明焦点/按键没进去，说清楚是哪一步，不笼统报错
        [WeCom]::Key(0x1B)
        Start-Sleep -Milliseconds 200
        Snap-Screen 'C:\Temp\wc-searchfail.png' | Out-Null
        return @{ ok = $false; code = 'searchbox-clear-failed'; why = 'Ctrl+A/Del 没清掉搜索框（按键没进去：搜索框没拿到焦点）'; conv = $Conv; stage = 'clear'; blankBytes = $blankBytes }
      }
    }
    [WeCom]::Combo('17,86')
    Start-Sleep -Milliseconds 520
    if ($sbox) {
      Snap-Region 'C:\Temp\wc-search-after.png' $sbox.x $sbox.y $sbox.w $sbox.h | Out-Null
      $pastedHash = Get-Sha256 'C:\Temp\wc-search-after.png'
      if ($pastedHash -eq $blankHash) {
        # 框还是空的 = Ctrl+V 没落进搜索框（点击没点到 / 焦点不在框里）
        [WeCom]::Key(0x1B)
        Start-Sleep -Milliseconds 200
        Snap-Screen 'C:\Temp\wc-searchfail.png' | Out-Null
        return @{ ok = $false; code = 'paste-ineffective'; why = '剪贴板正常、搜索框也清空了，但 Ctrl+V 没贴进去（点击没落到搜索框/框没拿到焦点）'; conv = $Conv; stage = 'paste'; searchBox = @{ x = $sbox.x; y = $sbox.y; w = $sbox.w; h = $sbox.h } }
      }
    }
    Start-Sleep -Milliseconds ([int]$Cfg.searchWaitMs)
    # 【别再按 ↓ + 回车】2026-10-30 02:47 实测：企微搜索下拉的第一行**默认就是选中态**，
    # 先按 ↓ 反而把选中移到第二行（那个「应用提醒」条目），回车等于打开了一条消息提醒而不是会话。
    # 改为：先看下拉有没有结果（裁剪图体积），有就直接**点第一行**；没有就 Esc 收场、绝不按回车。
    $dbox2 = Resolve-Box $r $Cfg.dropdownRegion
    $dropBytes2 = 0
    if ($dbox2) {
      Snap-Region 'C:\Temp\wc-dropdown.png' $dbox2.x $dbox2.y $dbox2.w $dbox2.h | Out-Null
      if (Test-Path 'C:\Temp\wc-dropdown.png') { $dropBytes2 = (Get-Item 'C:\Temp\wc-dropdown.png').Length }
    }
    $dropMin = 2000
    if ($null -ne $Cfg.dropdownMinBytes) { $dropMin = [int]$Cfg.dropdownMinBytes }
    if ($dropBytes2 -lt $dropMin) {
      [WeCom]::Key(0x1B)
      Start-Sleep -Milliseconds 250
      Snap-Screen 'C:\Temp\wc-openfail.png' | Out-Null
      return @{ ok = $false; code = 'chat-not-found'; why = 'search dropdown empty (nothing to click)'; conv = $Conv; dropdownBytes = $dropBytes2; beforeHash = $beforeHash }
    }
    $row = Resolve-Box $r $Cfg.dropdownRow
    [WeCom]::Click(([int]($row.x + $row.w / 2)), ([int]($row.y + $row.h / 2)))
    Start-Sleep -Milliseconds ([int]$Cfg.openWaitMs)
    # 点完第一行有两种走向：
    #  (A) 下拉里那行就是会话 → 会话直接开了（也可能下拉没出来、这一下点在左侧会话列表上）；
    #  (B) 那行是「聊天记录」入口 → 弹出企微的「全局搜索」页，还得点页里的「进入聊天」。
    # 【不再用窗口句柄判断搜索页在不在】企微的搜索页关掉后句柄仍在、IsWindowVisible 依旧 true，
    # 2026-10-30 02:58/02:59 因为信它连错两次。这里改成"只认标题条画面"：
    # 标题条没变才补点一次「进入聊天」；若页面根本不在，那一点落在会话区，不做任何事（安全）。
    $hdrNow = 'C:\Temp\wc-open-now-header.png'
    for ($k = 0; $k -lt 2; $k++) {
      Snap-Region $hdrNow $hbox.x $hbox.y $hbox.w $hbox.h | Out-Null
      if ((Get-Sha256 $hdrNow) -ne $beforeHash) { break }
      if (-not $Cfg.searchPanel -or -not $Cfg.searchPanel.enterChatAt) { break }
      $ex = $r[0] + [int]$Cfg.searchPanel.enterChatAt.x
      $ey = $r[1] + [int]$Cfg.searchPanel.enterChatAt.y
      [WeCom]::Click($ex, $ey)
      Start-Sleep -Milliseconds 1500
    }
    [void][WeCom]::Force($main)
    Start-Sleep -Milliseconds 350
    Snap-Screen 'C:\Temp\wc-open-stepA.png' | Out-Null
    break
  }
  # 兜底：万一还留着全局搜索页，先关掉再判定（留着它会盖住标题条、让指纹永远对不上）
  $searchWin = (Find-WindowByClass $Cfg.searchWindowClass -Visible | Select-Object -First 1)
  if ($searchWin) {
    [void][WeCom]::Force($searchWin)
    [WeCom]::Key(0x1B)
    Start-Sleep -Milliseconds 300
    [void][WeCom]::Force($main)
    Start-Sleep -Milliseconds 300
  }

  $afterPng = 'C:\Temp\wc-opencheck-after.png'
  Snap-Region $afterPng $hbox.x $hbox.y $hbox.w $hbox.h | Out-Null
  $afterHash = Get-Sha256 $afterPng
  # 判定（免 OCR 的"认名字"）：
  #   ① 有该会话的标题条指纹 → 必须**与指纹一致**（一致＝真的是这个会话，重复发也不会误判）
  #   ② 没有指纹（第一次发）→ 要求标题条相对基线**变了**，并顺手把这次的样子存成指纹
  #   ③ 两条都不满足 → chat-not-verified，**不输入、不回车**
  $ref = Get-HeaderRefHash $Conv
  if ($ref) {
    if ($afterHash -ne $ref) {
      # 分清两种"对不上"：标题条根本没变 = 搜索没切过去（要查坐标/搜索）；
      # 标题条变了但不是这个会话 = 搜到了别的会话（要查会话名）。
      $why2 = if ($afterHash -eq $beforeHash) { 'search-did-not-switch' } else { 'header-not-match-ref' }
      Snap-Screen 'C:\Temp\wc-openfail.png' | Out-Null
      return @{ ok = $false; code = 'chat-not-verified'; why = $why2; conv = $Conv; beforeHash = $beforeHash; afterHash = $afterHash; ref = $ref }
    }
    return @{ ok = $true; code = 'chat-opened'; why = 'header-matches-ref'; main = $main.ToInt64(); beforeHash = $beforeHash; afterHash = $afterHash; ref = $ref }
  }
  # 没有指纹 = 没校准过这个会话 → 一律拒发（fail-closed）。指纹要先由人看着画面 /bootstrap 一次。
  Snap-Screen 'C:\Temp\wc-openfail.png' | Out-Null
  return @{ ok = $false; code = 'chat-not-verified'; why = 'no-reference'; conv = $Conv; beforeHash = $beforeHash; afterHash = $afterHash }
}

# 发送：点输入框 → 清旧稿 → 截图 before → 剪贴板回读校验 → Ctrl+V → 截图 pasted → 回车 → 截图 after
function Send-WeComText([string]$Text, $Cfg, [string]$Tag = 'send', [string]$Conv = '') {
  $focus = Focus-InputBox $Cfg
  if (-not $focus.ok) { return @{ ok = $false; code = $focus.code } }
  [WeCom]::Combo('17,65'); Start-Sleep -Milliseconds 120
  [WeCom]::Key(0x2E); Start-Sleep -Milliseconds 250

  $before = "C:\Temp\wc-$Tag-before.png"
  Snap-Screen $before | Out-Null
  $beforeHash = Get-Sha256 $before

  Set-Clipboard -Value $Text
  Start-Sleep -Milliseconds 200
  $readBack = Get-Clipboard -Raw
  if ($readBack -ne $Text) {
    return @{ ok = $false; code = 'clipboard-mismatch'; want = $Text.Length; got = "$readBack".Length; beforeHash = $beforeHash; beforePath = $before }
  }
  [WeCom]::Combo('17,86')
  Start-Sleep -Milliseconds 900

  $pasted = "C:\Temp\wc-$Tag-pasted.png"
  Snap-Screen $pasted | Out-Null
  $pastedHash = Get-Sha256 $pasted
  if ($pastedHash -eq $beforeHash) {
    return @{ ok = $false; code = 'paste-no-effect'; beforeHash = $beforeHash; beforePath = $before; pastedPath = $pasted }
  }

  # 【回车前的最后一道】标题条必须仍是这个会话的指纹——粘贴这一下有可能把焦点带走/切了会话。
  # 不一致就 Esc 掉、不回车：宁可这条没发出去，也不发到别人那儿。
  if ($Conv) {
    $refNow = Get-HeaderRefHash $Conv
    if ($refNow) {
      $main2 = Get-WeComMain $Cfg
      if ($main2) {
        $hb2 = Get-HeaderBox $Cfg $main2 $Conv
        if ($hb2) {
          $hdrNow = 'C:\Temp\wc-presend-header.png'
          Snap-Region $hdrNow $hb2.x $hb2.y $hb2.w $hb2.h | Out-Null
          $curHash = Get-Sha256 $hdrNow
          if ($curHash -ne $refNow) {
            [WeCom]::Key(0x1B)
            Start-Sleep -Milliseconds 200
            return @{ ok = $false; code = 'chat-switched'; why = 'header no longer matches ref before Enter'; conv = $Conv; ref = $refNow; now = $curHash; beforeHash = $beforeHash; pastedHash = $pastedHash }
          }
        }
      }
    }
  }

  [WeCom]::Key(0x0D)
  Start-Sleep -Milliseconds ([int]$Cfg.sendWaitMs)

  $after = "C:\Temp\wc-$Tag-after.png"
  Snap-Screen $after | Out-Null
  $afterHash = Get-Sha256 $after
  return @{
    ok = ($afterHash -ne $beforeHash)
    code = if ($afterHash -ne $beforeHash) { 'sent' } else { 'no-visual-change' }
    beforeHash = $beforeHash; afterHash = $afterHash; pastedHash = $pastedHash
    beforePath = $before; pastedPath = $pasted; afterPath = $after
  }
}
