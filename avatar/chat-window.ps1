# 鲟鱼的独立聊天窗（浅色版 · 可缩放）
#
# 设计：无边框 + 圆角 + 柔和配色；她在左（淡蓝灰气泡），你在右（蓝紫气泡）。
# 为什么不用游戏内面板：莉莉丝是透明置顶窗口，只有角色 collider 收鼠标，面板会被穿透。
#
# 踩过的坑：
#   · PowerShell 的 $input 是自动变量，不能当文本框名字（否则点发送永远是空的）
#   · Windows PowerShell 5.1 读无 BOM 的 UTF-8 会乱码，这个文件必须带 BOM
#   · Paint 事件里别依赖闭包变量，颜色走控件的 Tag
#   · 无边框窗口要能拖边角缩放，必须自己处理 WM_NCHITTEST（见下面 DshForm）
#
# 用法：powershell.exe -STA -NoProfile -ExecutionPolicy Bypass -File avatar\chat-window.ps1
param(
    [string]$Relay = "http://127.0.0.1:9334",
    [int]$PollMs = 1200
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$cs = @"
using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public class DshWin32 {
    [DllImport("gdi32.dll")] public static extern IntPtr CreateRoundRectRgn(int l, int t, int r, int b, int w, int h);
    [DllImport("user32.dll")] public static extern int SetWindowRgn(IntPtr hWnd, IntPtr hRgn, bool redraw);
    [DllImport("user32.dll")] public static extern bool ReleaseCapture();
    [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
}

// 无边框窗体：自己处理 WM_NCHITTEST，四边四角都能拖动缩放。
public class DshForm : Form {
    const int WM_NCHITTEST = 0x84;
    public int CornerRadius { get; set; }
    public int ResizeBorder { get; set; }
    public DshForm() { CornerRadius = 20; ResizeBorder = 6; }

    protected override void WndProc(ref Message m) {
        if (m.Msg == WM_NCHITTEST) {
            Point p = PointToClient(new Point(m.LParam.ToInt32()));
            int b = ResizeBorder;
            bool left = p.X <= b;
            bool right = p.X >= ClientSize.Width - b;
            bool top = p.Y <= b;
            bool bottom = p.Y >= ClientSize.Height - b;
            if (top && left) { m.Result = (IntPtr)13; return; }
            if (top && right) { m.Result = (IntPtr)14; return; }
            if (bottom && left) { m.Result = (IntPtr)16; return; }
            if (bottom && right) { m.Result = (IntPtr)17; return; }
            if (left) { m.Result = (IntPtr)10; return; }
            if (right) { m.Result = (IntPtr)11; return; }
            if (top) { m.Result = (IntPtr)12; return; }
            if (bottom) { m.Result = (IntPtr)15; return; }
        }
        base.WndProc(ref m);
    }

    public void ApplyRoundCorners() {
        IntPtr rgn = DshWin32.CreateRoundRectRgn(0, 0, Width + 1, Height + 1, CornerRadius, CornerRadius);
        DshWin32.SetWindowRgn(Handle, rgn, true);
    }
}
"@

Add-Type -TypeDefinition $cs -ReferencedAssemblies System.Windows.Forms, System.Drawing

$C_BG     = [System.Drawing.Color]::FromArgb(250, 247, 242)
$C_HEADER = [System.Drawing.Color]::FromArgb(255, 255, 255)
$C_TEXT   = [System.Drawing.Color]::FromArgb(43, 43, 43)
$C_MUTED  = [System.Drawing.Color]::FromArgb(150, 145, 138)
$C_HER    = [System.Drawing.Color]::FromArgb(232, 238, 247)
$C_ME     = [System.Drawing.Color]::FromArgb(91, 124, 250)
$C_INPUT  = [System.Drawing.Color]::FromArgb(241, 237, 230)

$W = 420
$H = 620
$HEADER_H = 46
$FOOTER_H = 66

function New-RoundPath([int]$w, [int]$h, [int]$r) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $p.AddArc(0, 0, $d, $d, 180, 90)
    $p.AddArc($w - $d, 0, $d, $d, 270, 90)
    $p.AddArc($w - $d, $h - $d, $d, $d, 0, 90)
    $p.AddArc(0, $h - $d, $d, $d, 90, 90)
    $p.CloseFigure()
    return $p
}

$script:cursor = 0
$script:busy = $false
$script:relay = $Relay
$script:target = "xunyu"   # xunyu=鲟鱼  dsh=DSH
$stateFile = Join-Path $PSScriptRoot 'ui-state.json'
try {
    if (Test-Path $stateFile) {
        $st = Get-Content $stateFile -Raw | ConvertFrom-Json
        if ($st.target -eq 'dsh' -or $st.target -eq 'xunyu') { $script:target = $st.target }
    }
} catch { }

$form = New-Object DshForm
$form.Text = "鲟鱼"
$form.Width = $W
$form.Height = $H
$form.MinimumSize = New-Object System.Drawing.Size(320, 380)
$form.StartPosition = "Manual"
$form.Location = New-Object System.Drawing.Point(80, 120)
$form.TopMost = $true
$form.FormBorderStyle = "None"
$form.BackColor = $C_BG
$form.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 9.5)

$header = New-Object System.Windows.Forms.Panel
$header.Dock = "Top"
$header.Height = $HEADER_H
$header.BackColor = $C_HEADER

$title = New-Object System.Windows.Forms.Label
$title.Text = if ($script:target -eq "dsh") { "DSH" } else { "鲟鱼" }
$title.Left = 16
$title.Top = 11
$title.Width = 120
$title.Height = 24
$title.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 10.5, [System.Drawing.FontStyle]::Bold)
$title.ForeColor = $C_TEXT
$title.BackColor = $C_HEADER

$script:dot = New-Object System.Windows.Forms.Label
$script:dot.Text = "●"
$script:dot.AutoSize = $true
$script:dot.Left = 60
$script:dot.Top = 13
$script:dot.ForeColor = [System.Drawing.Color]::FromArgb(200, 60, 60)
$script:dot.BackColor = $C_HEADER

# 健康状态文字：中继离线 / 身体未连接 / 在线（颜色 + 文字双通道，别只靠一个小圆点）
$script:status = New-Object System.Windows.Forms.Label
$script:status.Text = "连接中…"
$script:status.AutoSize = $true
$script:status.Left = 76
$script:status.Top = 15
$script:status.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 8.5)
$script:status.ForeColor = $C_MUTED
$script:status.BackColor = $C_HEADER

$close = New-Object System.Windows.Forms.Label
$close.Text = "×"
$close.Width = 34
$close.Height = 30
$close.Top = 8
$close.Left = $W - 48
$close.Anchor = "Top,Right"
$close.TextAlign = "MiddleCenter"
$close.Font = New-Object System.Drawing.Font("Segoe UI", 13)
$close.ForeColor = $C_MUTED
$close.BackColor = $C_HEADER
$close.Add_Click({ $form.Close() })

$header.Controls.Add($title)
$header.Controls.Add($script:dot)
$header.Controls.Add($script:status)
$header.Controls.Add($close)

# ── 联系人切换：鲟鱼 / DSH ──────────────────────────────────────────────
$tabXunyu = New-Object System.Windows.Forms.Label
$tabXunyu.Text = "鲟鱼"
$tabXunyu.AutoSize = $false
$tabXunyu.Width = 56
$tabXunyu.Height = 26
$tabXunyu.Left = 150
$tabXunyu.Top = 10
$tabXunyu.TextAlign = "MiddleCenter"
$tabXunyu.Cursor = [System.Windows.Forms.Cursors]::Hand
if ($script:target -eq 'xunyu') {
    $tabXunyu.BackColor = $C_ME
    $tabXunyu.ForeColor = [System.Drawing.Color]::White
} else {
    $tabXunyu.BackColor = $C_HEADER
    $tabXunyu.ForeColor = $C_MUTED
}

$tabDsh = New-Object System.Windows.Forms.Label
$tabDsh.Text = "DSH"
$tabDsh.AutoSize = $false
$tabDsh.Width = 56
$tabDsh.Height = 26
$tabDsh.Left = 210
$tabDsh.Top = 10
$tabDsh.TextAlign = "MiddleCenter"
$tabDsh.Cursor = [System.Windows.Forms.Cursors]::Hand
if ($script:target -eq 'dsh') {
    $tabDsh.BackColor = $C_ME
    $tabDsh.ForeColor = [System.Drawing.Color]::White
} else {
    $tabDsh.BackColor = $C_HEADER
    $tabDsh.ForeColor = $C_MUTED
}

$header.Controls.Add($tabXunyu)
$header.Controls.Add($tabDsh)

$dragHandler = {
    [DshWin32]::ReleaseCapture() | Out-Null
    [DshWin32]::SendMessage($form.Handle, 0xA1, [IntPtr]2, [IntPtr]::Zero) | Out-Null
}
$header.Add_MouseDown($dragHandler)
$title.Add_MouseDown($dragHandler)

$flow = New-Object System.Windows.Forms.FlowLayoutPanel
$flow.Dock = "Fill"
$flow.FlowDirection = "TopDown"
$flow.WrapContents = $false
$flow.AutoScroll = $true
$flow.BackColor = $C_BG
$flow.Padding = New-Object System.Windows.Forms.Padding(10, 8, 10, 8)

$footer = New-Object System.Windows.Forms.Panel
$footer.Dock = "Bottom"
$footer.Height = $FOOTER_H
$footer.BackColor = $C_BG

$txtBack = New-Object System.Windows.Forms.Panel
$txtBack.Left = 12
$txtBack.Top = 10
$txtBack.Width = $W - 108
$txtBack.Height = 44
$txtBack.Anchor = "Top,Left,Right"
$txtBack.BackColor = $C_BG
$txtBack.Tag = $C_INPUT
$txtBack.Add_Paint({
    param($s, $e)
    $e.Graphics.SmoothingMode = "AntiAlias"
    $path = New-RoundPath $s.Width $s.Height 12
    $brush = New-Object System.Drawing.SolidBrush($s.Tag)
    $e.Graphics.FillPath($brush, $path)
    $brush.Dispose(); $path.Dispose()
})

$script:txt = New-Object System.Windows.Forms.TextBox
$script:txt.Multiline = $true
$script:txt.BorderStyle = "None"
$script:txt.BackColor = $C_INPUT
$script:txt.ForeColor = $C_TEXT
$script:txt.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 10)
$script:txt.Left = 12
$script:txt.Top = 8
$script:txt.Width = $txtBack.Width - 24
$script:txt.Height = 30
$script:txt.Anchor = "Top,Left,Right"
$txtBack.Controls.Add($script:txt)

$script:btn = New-Object System.Windows.Forms.Label
$script:btn.Text = "发送"
$script:btn.Width = 72
$script:btn.Height = 34
$script:btn.Top = 15
$script:btn.Left = $W - 88
$script:btn.Anchor = "Top,Right"
$script:btn.TextAlign = "MiddleCenter"
$script:btn.BackColor = $C_BG
$script:btn.ForeColor = [System.Drawing.Color]::White
$script:btn.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 9.5)
$script:btn.Cursor = [System.Windows.Forms.Cursors]::Hand
$script:btn.Tag = $C_ME
$script:btn.Add_Paint({
    param($s, $e)
    $e.Graphics.SmoothingMode = "AntiAlias"
    $path = New-RoundPath $s.Width $s.Height 12
    $brush = New-Object System.Drawing.SolidBrush($s.Tag)
    $e.Graphics.FillPath($brush, $path)
    $brush.Dispose(); $path.Dispose()
    $fmt = New-Object System.Drawing.StringFormat
    $fmt.Alignment = "Center"
    $fmt.LineAlignment = "Center"
    $e.Graphics.DrawString($s.Text, $s.Font, [System.Drawing.Brushes]::White, (New-Object System.Drawing.RectangleF(0, 0, $s.Width, $s.Height)), $fmt)
    $fmt.Dispose()
})

$footer.Controls.Add($txtBack)
$footer.Controls.Add($script:btn)

# ── 审批卡片（有挂起项才显示）────────────────────────────────────────────
$approval = New-Object System.Windows.Forms.Panel
$approval.Dock = "Bottom"
$approval.Height = 104
$approval.Visible = $false
$approval.BackColor = [System.Drawing.Color]::FromArgb(255, 248, 235)

$apTitle = New-Object System.Windows.Forms.Label
$apTitle.Left = 12
$apTitle.Top = 6
$apTitle.Width = $W - 30
$apTitle.Height = 20
$apTitle.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 9.5, [System.Drawing.FontStyle]::Bold)
$apTitle.ForeColor = [System.Drawing.Color]::FromArgb(160, 90, 20)
$apTitle.BackColor = $approval.BackColor

$apDetail = New-Object System.Windows.Forms.Label
$apDetail.Left = 12
$apDetail.Top = 28
$apDetail.Width = $W - 30
$apDetail.Height = 34
$apDetail.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 8.5)
$apDetail.ForeColor = $C_TEXT
$apDetail.BackColor = $approval.BackColor

function New-ApButton([string]$text, [int]$left, [int]$width, $color) {
    $b = New-Object System.Windows.Forms.Button
    $b.Text = $text
    $b.Left = $left
    $b.Top = 68
    $b.Width = $width
    $b.Height = 26
    $b.FlatStyle = "Flat"
    $b.BackColor = $color
    $b.ForeColor = [System.Drawing.Color]::White
    $b.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 9)
    return $b
}

$btnApprove = New-ApButton "通过" 12 76 ([System.Drawing.Color]::FromArgb(60, 150, 95))
$btnDeny = New-ApButton "拒绝" 96 76 ([System.Drawing.Color]::FromArgb(190, 80, 80))
$btnWindow = New-ApButton "允许代批 30 分钟" 180 150 ([System.Drawing.Color]::FromArgb(91, 124, 250))

$approval.Controls.Add($apTitle)
$approval.Controls.Add($apDetail)
$approval.Controls.Add($btnApprove)
$approval.Controls.Add($btnDeny)
$approval.Controls.Add($btnWindow)

$form.Controls.Add($flow)
$form.Controls.Add($approval)
$form.Controls.Add($footer)
$form.Controls.Add($header)

function Add-Bubble([string]$who, [string]$text) {
    # 宽度跟着当前窗口走（可缩放）
    $maxW = [Math]::Max(120, $flow.ClientSize.Width - 60)
    $f = New-Object System.Drawing.Font("Microsoft YaHei UI", 9.5)
    $measure = [System.Windows.Forms.TextRenderer]::MeasureText($text, $f, (New-Object System.Drawing.Size($maxW, 4000)), "WordBreak")
    $bw = $maxW + 24
    $bh = $measure.Height + 26

    $row = New-Object System.Windows.Forms.Panel
    $row.Width = $maxW + 44
    $row.Height = $bh + 8
    $row.BackColor = $C_BG

    $bubbleColor = if ($who -eq "me") { $C_ME } else { $C_HER }
    $textColor = if ($who -eq "me") { [System.Drawing.Color]::White } else { $C_TEXT }

    $bubble = New-Object System.Windows.Forms.Panel
    $bubble.Width = $bw
    $bubble.Height = $bh
    $bubble.Top = 4
    $bubble.Left = if ($who -eq "me") { [Math]::Max(0, $row.Width - $bw) } else { 0 }
    $bubble.BackColor = $C_BG
    $bubble.Tag = $bubbleColor
    $bubble.Add_Paint({
        param($s, $e)
        $e.Graphics.SmoothingMode = "AntiAlias"
        $path = New-RoundPath $s.Width $s.Height 12
        $brush = New-Object System.Drawing.SolidBrush($s.Tag)
        $e.Graphics.FillPath($brush, $path)
        $brush.Dispose(); $path.Dispose()
    })

    $lbl = New-Object System.Windows.Forms.Label
    $lbl.Text = $text
    $lbl.Left = 12
    $lbl.Top = 9
    $lbl.Width = $bw - 24
    $lbl.Height = $bh - 18
    $lbl.BackColor = $bubbleColor
    $lbl.ForeColor = $textColor
    $lbl.Font = $f

    $bubble.Controls.Add($lbl)
    $row.Controls.Add($bubble)
    $flow.Controls.Add($row)
    $flow.ScrollControlIntoView($row)
}

function Set-Target([string]$name) {
    if ($script:target -eq $name) { return }
    $script:target = $name
    if ($name -eq "xunyu") {
        $tabXunyu.BackColor = $C_ME; $tabXunyu.ForeColor = [System.Drawing.Color]::White
        $tabDsh.BackColor = $C_HEADER; $tabDsh.ForeColor = $C_MUTED
        $title.Text = "鲟鱼"
    } else {
        $tabDsh.BackColor = $C_ME; $tabDsh.ForeColor = [System.Drawing.Color]::White
        $tabXunyu.BackColor = $C_HEADER; $tabXunyu.ForeColor = $C_MUTED
        $title.Text = "DSH"
    }
    # 换联系人就把窗口清空、游标对齐到当前末尾（各条线互不串）
    # after 给一个巨大的数 = 只要「当前游标」、不拉任何历史（2026-10-25：窗口不回放历史）
    $script:log.Clear()
    try {
        $h = Invoke-RestMethod -Uri "$script:relay/lines?after=999999999&target=$name&client=window" -TimeoutSec 5
        $script:cursor = [int]$h.cursor
    } catch { $script:cursor = 0 }
    try { @{ target = $name } | ConvertTo-Json -Compress | Set-Content -Path $stateFile -Encoding UTF8 } catch { }
    $who = if ($name -eq "xunyu") { "鲟鱼（QQ 侧）" } else { "DSH（我这边，不走 QQ）" }
    Add-Bubble "her" ("已切到 " + $who + "。")
    $script:txt.Focus()
}

function Send-Text {
    $text = ""
    if ($script:txt -ne $null) { $text = $script:txt.Text.Trim() }
    if ([string]::IsNullOrWhiteSpace($text)) { return }
    $script:txt.Text = ""
    Add-Bubble "me" $text
    try {
        $body = @{ text = $text; target = $script:target } | ConvertTo-Json -Compress
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
        $resp = Invoke-RestMethod -Uri "$script:relay/chat" -Method Post -ContentType "application/json; charset=utf-8" -Body $bytes -TimeoutSec 20
        if (-not $resp.ok) { Add-Bubble "her" ("没送出去：" + $resp.error) }
    } catch {
        Add-Bubble "her" ("发送失败：" + (Get-HttpError $_))
    }
}

$tabXunyu.Add_Click({ Set-Target "xunyu" })
$tabDsh.Add_Click({ Set-Target "dsh" })

function Get-HttpError($err) {
    # Invoke-RestMethod 抛 WebException 时只会显示 "500 Internal Server Error"，
    # 但真正的原因（桥接返回的 error 字段）在响应体里，这里挖出来。
    try {
        $resp = $err.Exception.Response
        if ($resp -ne $null) {
            $stream = $resp.GetResponseStream()
            if ($stream -ne $null) {
                $reader = New-Object System.IO.StreamReader($stream)
                $text = $reader.ReadToEnd()
                $reader.Close()
                if ($text) {
                    try { $j = $text | ConvertFrom-Json; if ($j.error) { return [string]$j.error } } catch { }
                    return $text
                }
            }
        }
    } catch { }
    return $err.Exception.Message
}

function Invoke-Approval([string]$decision) {
    try {
        $body = @{ decision = $decision; approvalId = [string]$script:pendId } | ConvertTo-Json -Compress
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
        $r = Invoke-RestMethod -Uri "$script:relay/approve" -Method Post -ContentType "application/json; charset=utf-8" -Body $bytes -TimeoutSec 10
        if ($r.ok) { Add-Bubble "her" ("已" + $(if ($decision -eq "approve") { "通过" } else { "拒绝" })) }
        else { Add-Bubble "her" ("操作失败：" + $r.error) }
    } catch { Add-Bubble "her" ("操作失败：" + (Get-HttpError $_)) }
    $approval.Visible = $false
}

function Open-DelegationWindow {
    try {
        $body = @{ minutes = 30 } | ConvertTo-Json -Compress
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
        $r = Invoke-RestMethod -Uri "$script:relay/window" -Method Post -ContentType "application/json; charset=utf-8" -Body $bytes -TimeoutSec 10
        if ($r.ok) { Add-Bubble "her" ("代批窗口已开 " + $r.minutes + " 分钟。") }
        else { Add-Bubble "her" ("开窗口失败：" + $r.error) }
    } catch { Add-Bubble "her" ("开窗口失败：" + (Get-HttpError $_)) }
}

$btnApprove.Add_Click({ Invoke-Approval "approve" })
$btnDeny.Add_Click({ Invoke-Approval "deny" })
$btnWindow.Add_Click({ Open-DelegationWindow })

$script:txt.Add_KeyDown({
    if ($_.KeyCode -eq "Enter" -and -not $_.Shift) {
        Send-Text
        $_.SuppressKeyPress = $true
    }
})
$script:btn.Add_Click({ Send-Text })

# ── 健康检查：中继 9334 / 身体服务 9335 ─────────────────────────────────
# 以前只靠 /lines 成功失败改变圆点颜色，且启动就喊「连上了」——中继死了也照喊。
# 现在给三态 + 文字，且 5 秒一次心跳，别把「我以为连上了」当成「连上了」。
# 2026-10-25 主人要求：身体是否在线以**身体服务 9335**为准，不再直连游戏 mod 9333。
$script:lastHealth = [DateTime]::MinValue
$script:healthState = "unknown"

function Update-Health([switch]$Force) {
    if (-not $Force -and ((Get-Date) - $script:lastHealth).TotalSeconds -lt 5) { return }
    $script:lastHealth = Get-Date
    $relayOk = $false
    try { $h = Invoke-RestMethod -Uri "$script:relay/health?client=window" -TimeoutSec 4; $relayOk = [bool]$h.ok } catch { $relayOk = $false }
    $modOk = $false
    if ($relayOk) {
        try {
            $b = Invoke-RestMethod -Uri "http://127.0.0.1:9335/health" -TimeoutSec 3
            $modOk = [bool]$b.ok
        } catch { $modOk = $false }
    }
    if (-not $relayOk) {
        $script:healthState = "relay"
        $script:dot.ForeColor = [System.Drawing.Color]::FromArgb(200, 60, 60)
        $script:status.Text = "中继离线 · 重连中"
        $script:status.ForeColor = [System.Drawing.Color]::FromArgb(200, 60, 60)
    } elseif (-not $modOk) {
        $script:healthState = "mod"
        $script:dot.ForeColor = [System.Drawing.Color]::FromArgb(220, 150, 60)
        $script:status.Text = "身体未连接"
        $script:status.ForeColor = [System.Drawing.Color]::FromArgb(190, 130, 50)
    } else {
        $script:healthState = "ok"
        $script:dot.ForeColor = [System.Drawing.Color]::FromArgb(80, 180, 110)
        $script:status.Text = "在线"
        $script:status.ForeColor = [System.Drawing.Color]::FromArgb(110, 150, 120)
    }
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = $PollMs
$timer.Add_Tick({
    if ($script:busy) { return }
    $script:busy = $true
    # 专用心跳：不管当前停在哪个页签，都让中继知道「窗口还活着」。
    # 以前只靠 /health（5 秒节流）和 /lines；UI 线程一被挡住心跳就断，
    # 桥接就以为人不在电脑前，把审批推去 QQ——「人坐在窗口前还收 QQ 待批」就是这么来的。
    try { $null = Invoke-RestMethod -Uri "$script:relay/window-presence?client=window" -TimeoutSec 3 } catch { }
    try {
        Update-Health
        try {
            $r = Invoke-RestMethod -Uri "$script:relay/lines?after=$script:cursor&target=$script:target&client=window" -TimeoutSec 5
            foreach ($line in $r.lines) {
                if ($line.from -eq "agent") { Add-Bubble "her" $line.text }
                $script:cursor = [Math]::Max($script:cursor, [int]$line.n)
            }
        } catch {
            Update-Health -Force
        }
        # 审批挂起项（窗口开着就不经过鲟鱼）
        try {
            $pd = Invoke-RestMethod -Uri "$script:relay/pending?client=window" -TimeoutSec 4
            if ($pd.ok -and $pd.pending -and $pd.pending.Count -gt 0) {
                # 多条排队：卡片永远显示**最老**那条，按钮按它的 approvalId 精确批，避免批错对象。
                $it = $pd.pending[0]
                $script:pendId = [string]$it.approvalId
                $kind = if ($it.kind -eq "question") { "提问" } else { "审批" }
                $danger = if ($it.dangerous) { " ⚠高危" } else { "" }
                $more = if ($pd.pending.Count -gt 1) { "（另有 " + ($pd.pending.Count - 1) + " 条排队）" } else { "" }
                $apTitle.Text = "$kind：$($it.tool)$danger$more"
                $apDetail.Text = ("" + $it.reason + "  （剩 " + [Math]::Round($it.expiresInMs / 1000) + " 秒）")
                $approval.Visible = $true
            } else {
                $script:pendId = ""
                $approval.Visible = $false
            }
        } catch { }
    } finally {
        # 关键：上面任何一步抛错都必须解锁。否则 $script:busy 永远是 true，
        # 之后每个 tick 第一行就 return —— 表现是「审批卡片冻住不动 + 心跳断掉」。
        $script:busy = $false
    }
})

$form.Add_Shown({
    $form.ApplyRoundCorners()
    Update-Health -Force
    if ($script:healthState -eq "ok") {
        Add-Bubble "her" "连上了。打字回车发给我，我回的话会出现在这里，也会在她嘴边弹出来。"
    } else {
        Add-Bubble "her" "中继还没响应，我在重连。你先打字也行，连上就会发出去。"
    }
    try {
        # 启动时只对齐游标，不回放历史（after 取巨大值 → 只要 cursor）
        $h = Invoke-RestMethod -Uri "$script:relay/lines?after=999999999&target=$script:target&client=window" -TimeoutSec 5
        $script:cursor = [int]$h.cursor
    } catch { }
    $timer.Start()
    $script:txt.Focus()
})

$form.Add_Resize({ $form.ApplyRoundCorners() })
$form.Add_FormClosing({ $timer.Stop() })

[void]$form.ShowDialog()
