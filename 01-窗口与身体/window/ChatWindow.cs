// 鲟鱼的独立聊天窗（C# WinForms 版，替代 chat-window.ps1）
//
// 为什么换：ps1 每次拉起都要 Add-Type 现场编译 C# + 起 PowerShell 宿主，启动 2-4 秒、
// 有可见 CPU 毛刺，而且控制台窗口会闪。这里是零依赖单文件 exe（用系统自带 .NET Framework
// 4.8 的 csc 编译，/target:winexe → 天生没有控制台），启动只做 WinForms 初始化。
//
// 行为与原 ps1 对齐（缺一不可）：
//   · 无边框 + 圆角（CreateRoundRectRgn + SetWindowRgn）
//   · WM_NCHITTEST 四边四角拖动缩放
//   · TopMost、鲟鱼/DSH 双 tab、1.2s 轮询 9334、发送框、健康点、审批卡片
//   · ui-state.json 记住 tab；启动/切 tab 只对齐游标、不回放历史
//
// 新增：同名 Mutex 单实例、启动打点写 state\window-boot.log。
//
// 注意：csc（4.0.30319）只支持 C# 5 —— 不能用字符串插值、?.、nameof、表达式体成员。

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace XunyuChat
{
    static class Native
    {
        [DllImport("gdi32.dll")]
        public static extern IntPtr CreateRoundRectRgn(int l, int t, int r, int b, int w, int h);
        [DllImport("user32.dll")]
        public static extern int SetWindowRgn(IntPtr hWnd, IntPtr hRgn, bool redraw);
        [DllImport("user32.dll")]
        public static extern bool ReleaseCapture();
        [DllImport("user32.dll")]
        public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
    }

    // 无边框窗体：自己处理 WM_NCHITTEST，四边四角都能拖动缩放。
    class DshForm : Form
    {
        const int WM_NCHITTEST = 0x84;
        public int CornerRadius = 20;
        public int ResizeBorder = 6;

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_NCHITTEST)
            {
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

        public void ApplyRoundCorners()
        {
            IntPtr rgn = Native.CreateRoundRectRgn(0, 0, Width + 1, Height + 1, CornerRadius, CornerRadius);
            Native.SetWindowRgn(Handle, rgn, true);
        }
    }

    // ── JSON 模型（字段名跟 relay 的返回对齐）──────────────────────────────
    // 这些字段只由反序列化赋值，编译器看不到写入点（CS0649），故整段关掉该告警。
#pragma warning disable 0649
    class LineItem { public int n; public string from; public string text; public string t; }
    class LinesResp { public bool ok; public int cursor; public List<LineItem> lines; }
    class PendingItem
    {
        public string approvalId; public string kind; public string tool;
        public string reason; public long expiresInMs; public bool dangerous;
    }
    class PendingResp { public bool ok; public List<PendingItem> pending; }
    class HealthResp { public bool ok; }
    class ChatResp { public bool ok; public string error; }
#pragma warning restore 0649

    static class Program
    {
        const string Relay = "http://127.0.0.1:9334";
        const int PollMs = 1200;
        // 2026-10-28（W-031 / 06）：工作台页签直连 9340（只读三接口），不新增端口、不经 relay 中转。
        const string DeskBase = "http://127.0.0.1:9340";
        const int DeskPollMs = 5000;
        const string MutexName = "XunyuChatWindow.SingleInstance";

        static readonly Color C_BG = Color.FromArgb(250, 247, 242);
        static readonly Color C_HEADER = Color.FromArgb(255, 255, 255);
        static readonly Color C_TEXT = Color.FromArgb(43, 43, 43);
        static readonly Color C_MUTED = Color.FromArgb(150, 145, 138);
        static readonly Color C_HER = Color.FromArgb(232, 238, 247);
        static readonly Color C_ME = Color.FromArgb(91, 124, 250);
        static readonly Color C_INPUT = Color.FromArgb(241, 237, 230);

        const int W = 420, H = 620, HEADER_H = 46, FOOTER_H = 66;

        static readonly HttpClient Http = new HttpClient { Timeout = TimeSpan.FromSeconds(6) };
        static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

        static DshForm form;
        static Panel header, footer, txtBack, approval;
        static Label title, dot, status, closeBtn, pinBtn, tabXunyu, tabDsh, btnSend, apTitle, apDetail;
        static Button btnApprove, btnDeny, btnWindow;
        static FlowLayoutPanel flow;
        static TextBox txt;
        static System.Windows.Forms.Timer timer;
        // W-031：工作台页签（第三个页签）
        static Label tabDesk, deskHeadA, deskHeadB, deskHeadC, deskFoot;
        static Panel desk;
        static RichTextBox deskAgents, deskTasks, deskMail;
        static System.Windows.Forms.Timer deskTimer;
        static DateTime deskLastOk = DateTime.MinValue;
        static bool deskFetching = false;
        static Font uiFont, titleFont, smallFont, bigFont, btnFont, deskFont, deskHeadFont, deskBoldFont;

        static int cursor = 0;
        static bool busy = false;
        static bool topMost = false;              // 2026-10-26：默认不置顶，可从右键菜单改，存 ui-state.json
        static ToolStripMenuItem menuTopMost;
        static string target = "xunyu";
        static string pendId = "";
        static DateTime lastHealth = DateTime.MinValue;
        static string healthState = "unknown";
        static string stateFile;
        static string avatarDir;

        [STAThread]
        static void Main()
        {
            Stopwatch sw = Stopwatch.StartNew();
            bool createdNew;
            using (Mutex mutex = new Mutex(true, MutexName, out createdNew))
            {
                if (!createdNew)
                {
                    LogBoot("second instance -> exit", sw);
                    return; // 已经有一个在跑，直接退
                }
                try
                {
                    Application.EnableVisualStyles();
                    // 2026-10-26：把「为什么死」写进 window-boot.log。
                    // 之前窗口偶尔消失（守护日志只有「窗口不在 → 拉起」），没人知道是崩了、
                    // 被杀了、还是自己关了。现在关窗/UI 异常/未捕获异常都会留一行。
                    Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
                    Application.ThreadException += delegate (object s, ThreadExceptionEventArgs e)
                    {
                        LogBoot("ui-exception: " + e.Exception.GetType().Name + " " + e.Exception.Message, sw);
                    };
                    AppDomain.CurrentDomain.UnhandledException += delegate (object s, UnhandledExceptionEventArgs e)
                    {
                        Exception ex = e.ExceptionObject as Exception;
                        LogBoot("fatal-unhandled: " + (ex != null ? ex.GetType().Name + " " + ex.Message : "?"), sw);
                    };
                    avatarDir = AvatarDir();
                    // 2026-10-26（关窗策略 C）：正常启动就清掉"人关过"的标记——
                    // 手动双击 exe / 脚本拉起 都算"我要它回来"。
                    try
                    {
                        string marker = Path.Combine(avatarDir, "state", "window-user-closed");
                        if (File.Exists(marker)) File.Delete(marker);
                    }
                    catch { }
                    stateFile = Path.Combine(avatarDir, "ui-state.json");
                    LoadState();
                    BuildUi();

                    form.Shown += async (s, e) =>
                    {
                        form.ApplyRoundCorners();
                        // 启动阶段用同步请求：UI 线程上 .Wait() 异步方法会死锁（经典坑）
                        UpdateHealthSync();
                        Greet();
                        AlignCursor();
                        timer.Start();
                        txt.Focus();
                        LogBoot("shown", sw);
                        await Task.Yield();
                    };
                    form.Resize += delegate { form.ApplyRoundCorners(); LayoutChildren(); };
                    form.FormClosing += delegate (object s, FormClosingEventArgs e)
                    {
                        timer.Stop();
                        LogBoot("closing (reason=" + e.CloseReason + ")", sw);
                        // 关窗策略 C：用户主动关 → 落标记，守护看到就不拉起；
                        // 崩溃（进程被杀，根本走不到这里）、Windows 关机、Application.Exit 不落标记。
                        // 说明：点自定义的 × 时 CloseReason 可能是 None（我们调的是 form.Close()），
                        // 任务管理器"结束任务"/CloseMainWindow 是 TaskManagerClosing —— 都算人关。
                        bool userClosed = e.CloseReason == CloseReason.UserClosing
                            || e.CloseReason == CloseReason.TaskManagerClosing
                            || e.CloseReason == CloseReason.None;
                        if (userClosed)
                        {
                            try
                            {
                                string dir = Path.Combine(avatarDir, "state");
                                Directory.CreateDirectory(dir);
                                File.WriteAllText(Path.Combine(dir, "window-user-closed"),
                                    DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "\r\n", Encoding.UTF8);
                                LogBoot("user-closed -> 守护不会再拉起（手动启动会清标记）", sw);
                            }
                            catch (Exception ex) { LogBoot("marker 写入失败: " + ex.Message, sw); }
                        }
                    };

                    Application.Run(form);
                }
                catch (Exception ex)
                {
                    LogBoot("fatal: " + ex.Message, sw);
                    throw;
                }
            }
        }

        static string AvatarDir()
        {
            // exe 在 avatar\window\，状态文件仍放 avatar\（与原 ps1 一致）
            return Path.GetFullPath(Path.Combine(Application.StartupPath, ".."));
        }

        static void LogBoot(string stage, Stopwatch sw)
        {
            try
            {
                string dir = Path.Combine(avatarDir != null ? avatarDir : AvatarDir(), "state");
                Directory.CreateDirectory(dir);
                string line = string.Format("{0:yyyy-MM-dd HH:mm:ss.fff} pid={1} {2} elapsed={3}ms\r\n",
                    DateTime.Now, Process.GetCurrentProcess().Id, stage, sw.ElapsedMilliseconds);
                File.AppendAllText(Path.Combine(dir, "window-boot.log"), line, Encoding.UTF8);
            }
            catch { /* 打点失败不能影响启动 */ }
        }

        static void LoadState()
        {
            try
            {
                if (!File.Exists(stateFile)) return;
                string raw = File.ReadAllText(stateFile, Encoding.UTF8);
                object o = Json.DeserializeObject(raw);
                Dictionary<string, object> d = o as Dictionary<string, object>;
                if (d != null && d.ContainsKey("target"))
                {
                    string t = Convert.ToString(d["target"]);
                    if (t == "dsh" || t == "xunyu") target = t;
                }
                // 2026-10-26：置顶状态也记住（默认不置顶）
                if (d != null && d.ContainsKey("topmost"))
                {
                    object tv = d["topmost"];
                    topMost = (tv is bool) ? (bool)tv : (Convert.ToString(tv) == "true" || Convert.ToString(tv) == "True");
                }
            }
            catch { }
        }

        static void SaveState()
        {
            try
            {
                Dictionary<string, object> d = new Dictionary<string, object>();
                d["target"] = target;
                d["topmost"] = topMost;
                File.WriteAllText(stateFile, Json.Serialize(d), new UTF8Encoding(false));
            }
            catch { }
        }

        /// <summary>切换「始终置顶」：立即生效 + 立即落盘（右键菜单 / 📌 按钮共用）。</summary>
        static void SetTopMost(bool on)
        {
            topMost = on;
            try { if (form != null) form.TopMost = on; } catch { }
            try { if (menuTopMost != null) menuTopMost.Checked = on; } catch { }
            UpdatePinLook();
            SaveState();
        }

        /// <summary>📌 按钮的颜色跟着状态走：置顶=蓝，不置顶=灰。</summary>
        static void UpdatePinLook()
        {
            try
            {
                if (pinBtn == null) return;
                pinBtn.ForeColor = topMost ? C_ME : C_MUTED;
            }
            catch { }
        }

        // ── 圆角路径 ────────────────────────────────────────────────────────
        static GraphicsPath RoundPath(int w, int h, int r)
        {
            GraphicsPath p = new GraphicsPath();
            int d = r * 2;
            if (d > w) d = w;
            if (d > h) d = h;
            if (d < 2) d = 2;
            p.AddArc(0, 0, d, d, 180, 90);
            p.AddArc(w - d, 0, d, d, 270, 90);
            p.AddArc(w - d, h - d, d, d, 0, 90);
            p.AddArc(0, h - d, d, d, 90, 90);
            p.CloseFigure();
            return p;
        }

        static void PaintRoundFill(object sender, PaintEventArgs e, Control c, Color color, int radius)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (GraphicsPath path = RoundPath(c.Width, c.Height, radius))
            using (SolidBrush brush = new SolidBrush(color))
            {
                e.Graphics.FillPath(brush, path);
            }
        }

        // ── 界面 ────────────────────────────────────────────────────────────
        static void BuildUi()
        {
            uiFont = new Font("Microsoft YaHei UI", 9.5f);
            titleFont = new Font("Microsoft YaHei UI", 10.5f, FontStyle.Bold);
            smallFont = new Font("Microsoft YaHei UI", 8.5f);
            bigFont = new Font("Segoe UI", 13f);
            btnFont = new Font("Microsoft YaHei UI", 9.5f);

            form = new DshForm();
            form.Text = "鲟鱼";
            form.Width = W;
            form.Height = H;
            form.MinimumSize = new Size(320, 380);
            form.StartPosition = FormStartPosition.Manual;
            form.Location = new Point(80, 120);
            // 2026-10-26（主人要的方案①）：默认**不置顶**，免得逛网页时永远压在最前面。
            // 置顶状态从 ui-state.json 的 topmost 读，默认 false；右键菜单可随时切回来。
            form.TopMost = topMost;
            form.ShowInTaskbar = true;   // 不置顶之后要能从任务栏找回来
            form.FormBorderStyle = FormBorderStyle.None;
            form.BackColor = C_BG;
            form.Font = uiFont;

            // header
            header = new Panel();
            header.Dock = DockStyle.Top;
            header.Height = HEADER_H;
            header.BackColor = C_HEADER;

            title = new Label();
            title.Text = target == "dsh" ? "DSH" : "鲟鱼";
            title.Left = 16; title.Top = 11; title.Width = 120; title.Height = 24;
            title.Font = titleFont;
            title.ForeColor = C_TEXT;
            title.BackColor = C_HEADER;

            dot = new Label();
            dot.Text = "●";
            dot.AutoSize = true;
            dot.Left = 60; dot.Top = 13;
            dot.ForeColor = Color.FromArgb(200, 60, 60);
            dot.BackColor = C_HEADER;

            status = new Label();
            status.Text = "连接中…";
            status.AutoSize = true;
            status.Left = 76; status.Top = 15;
            status.Font = smallFont;
            status.ForeColor = C_MUTED;
            status.BackColor = C_HEADER;

            closeBtn = new Label();
            closeBtn.Text = "×";
            closeBtn.Width = 34; closeBtn.Height = 30;
            closeBtn.Top = 8; closeBtn.Left = W - 48;
            closeBtn.TextAlign = ContentAlignment.MiddleCenter;
            closeBtn.Font = bigFont;
            closeBtn.ForeColor = C_MUTED;
            closeBtn.BackColor = C_HEADER;
            closeBtn.Cursor = Cursors.Hand;
            closeBtn.Click += delegate { form.Close(); };

            // 置顶开关按钮（2026-10-26 方案①）：常驻右上角，跟右键菜单同一个开关。
            // 灰色 📌 = 不置顶（默认），蓝色 = 始终置顶。点一下就切，立即落盘。
            pinBtn = new Label();
            pinBtn.Text = "顶";   // 用汉字而不是 📌：8.5pt 的雅黑渲染 emoji 会变成豆腐块
            pinBtn.Width = 26; pinBtn.Height = 26;
            pinBtn.Top = 10; pinBtn.Left = W - 112;
            pinBtn.TextAlign = ContentAlignment.MiddleCenter;
            pinBtn.Font = smallFont;
            pinBtn.BackColor = C_HEADER;
            pinBtn.Cursor = Cursors.Hand;
            pinBtn.ForeColor = C_MUTED;
            pinBtn.Click += delegate { SetTopMost(!topMost); };
            UpdatePinLook();

            header.Controls.Add(title);
            header.Controls.Add(dot);
            header.Controls.Add(status);
            header.Controls.Add(pinBtn);
            header.Controls.Add(closeBtn);

            // tabs
            tabXunyu = new Label();
            tabXunyu.Text = "鲟鱼";
            tabXunyu.AutoSize = false;
            tabXunyu.Width = 56; tabXunyu.Height = 26;
            tabXunyu.Left = 150; tabXunyu.Top = 10;
            tabXunyu.TextAlign = ContentAlignment.MiddleCenter;
            tabXunyu.Cursor = Cursors.Hand;
            tabXunyu.Click += delegate { SetTarget("xunyu"); };

            tabDsh = new Label();
            tabDsh.Text = "DSH";
            tabDsh.AutoSize = false;
            tabDsh.Width = 56; tabDsh.Height = 26;
            tabDsh.Left = 210; tabDsh.Top = 10;
            tabDsh.TextAlign = ContentAlignment.MiddleCenter;
            tabDsh.Cursor = Cursors.Hand;
            tabDsh.Click += delegate { SetTarget("dsh"); };

            tabDesk = new Label();
            tabDesk.Text = "工作台";
            tabDesk.AutoSize = false;
            tabDesk.Width = 72; tabDesk.Height = 26;
            tabDesk.Left = 270; tabDesk.Top = 10;
            tabDesk.TextAlign = ContentAlignment.MiddleCenter;
            tabDesk.Cursor = Cursors.Hand;
            tabDesk.Click += delegate { SetTarget("desk"); };

            header.Controls.Add(tabXunyu);
            header.Controls.Add(tabDsh);
            header.Controls.Add(tabDesk);
            ApplyTabColors();

            // 拖动
            MouseEventHandler drag = delegate (object s, MouseEventArgs e)
            {
                Native.ReleaseCapture();
                Native.SendMessage(form.Handle, 0xA1, (IntPtr)2, IntPtr.Zero);
            };
            header.MouseDown += drag;
            title.MouseDown += drag;

            // 消息区
            flow = new FlowLayoutPanel();
            flow.Dock = DockStyle.Fill;
            flow.FlowDirection = FlowDirection.TopDown;
            flow.WrapContents = false;
            flow.AutoScroll = true;
            flow.BackColor = C_BG;
            flow.Padding = new Padding(10, 8, 10, 8);

            // footer
            footer = new Panel();
            footer.Dock = DockStyle.Bottom;
            footer.Height = FOOTER_H;
            footer.BackColor = C_BG;

            txtBack = new Panel();
            txtBack.Left = 12; txtBack.Top = 10;
            txtBack.Width = W - 108; txtBack.Height = 44;
            txtBack.BackColor = C_BG;
            txtBack.Paint += delegate (object s, PaintEventArgs e) { PaintRoundFill(s, e, txtBack, C_INPUT, 12); };

            txt = new TextBox();
            txt.Multiline = true;
            txt.BorderStyle = BorderStyle.None;
            txt.BackColor = C_INPUT;
            txt.ForeColor = C_TEXT;
            txt.Font = new Font("Microsoft YaHei UI", 10f);
            txt.Left = 12; txt.Top = 8;
            txt.Width = txtBack.Width - 24;
            txt.Height = 30;
            txt.KeyDown += delegate (object s, KeyEventArgs e)
            {
                if (e.KeyCode == Keys.Enter && !e.Shift)
                {
                    SendText();
                    e.SuppressKeyPress = true;
                    e.Handled = true;
                }
            };
            txtBack.Controls.Add(txt);

            btnSend = new Label();
            btnSend.Text = "发送";
            btnSend.Width = 72; btnSend.Height = 34;
            btnSend.Top = 15; btnSend.Left = W - 88;
            btnSend.TextAlign = ContentAlignment.MiddleCenter;
            btnSend.BackColor = C_BG;
            btnSend.ForeColor = Color.White;
            btnSend.Font = btnFont;
            btnSend.Cursor = Cursors.Hand;
            btnSend.Paint += delegate (object s, PaintEventArgs e)
            {
                e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                using (GraphicsPath path = RoundPath(btnSend.Width, btnSend.Height, 12))
                using (SolidBrush brush = new SolidBrush(C_ME))
                {
                    e.Graphics.FillPath(brush, path);
                }
                using (StringFormat fmt = new StringFormat())
                {
                    fmt.Alignment = StringAlignment.Center;
                    fmt.LineAlignment = StringAlignment.Center;
                    e.Graphics.DrawString(btnSend.Text, btnSend.Font, Brushes.White,
                        new RectangleF(0, 0, btnSend.Width, btnSend.Height), fmt);
                }
            };
            btnSend.Click += delegate { SendText(); };

            footer.Controls.Add(txtBack);
            footer.Controls.Add(btnSend);

            // 审批卡片
            approval = new Panel();
            approval.Dock = DockStyle.Bottom;
            approval.Height = 104;
            approval.Visible = false;
            approval.BackColor = Color.FromArgb(255, 248, 235);

            apTitle = new Label();
            apTitle.Left = 12; apTitle.Top = 6;
            apTitle.Width = W - 30; apTitle.Height = 20;
            apTitle.Font = new Font("Microsoft YaHei UI", 9.5f, FontStyle.Bold);
            apTitle.ForeColor = Color.FromArgb(160, 90, 20);
            apTitle.BackColor = approval.BackColor;

            apDetail = new Label();
            apDetail.Left = 12; apDetail.Top = 28;
            apDetail.Width = W - 30; apDetail.Height = 34;
            apDetail.Font = smallFont;
            apDetail.ForeColor = C_TEXT;
            apDetail.BackColor = approval.BackColor;

            btnApprove = MakeApButton("通过", 12, 76, Color.FromArgb(60, 150, 95));
            btnDeny = MakeApButton("拒绝", 96, 76, Color.FromArgb(190, 80, 80));
            btnWindow = MakeApButton("允许代批 30 分钟", 180, 150, Color.FromArgb(91, 124, 250));
            btnApprove.Click += delegate { InvokeApproval("approve"); };
            btnDeny.Click += delegate { InvokeApproval("deny"); };
            btnWindow.Click += delegate { OpenDelegationWindow(); };

            approval.Controls.Add(apTitle);
            approval.Controls.Add(apDetail);
            approval.Controls.Add(btnApprove);
            approval.Controls.Add(btnDeny);
            approval.Controls.Add(btnWindow);

            form.Controls.Add(flow);
            form.Controls.Add(approval);
            form.Controls.Add(footer);
            form.Controls.Add(header);

            // ── W-031：工作台页签（纵向三段：谁在干什么 / 任务与待验收 / 邮件）──
            // 窗口只有 420 宽，硬塞三列会挤成一团；按 D14 设计稿的压缩思路纵向排。
            deskFont = new Font("Consolas", 8.25f);
            deskBoldFont = new Font("Consolas", 8.25f, FontStyle.Bold);
            deskHeadFont = new Font("Microsoft YaHei UI", 8.5f, FontStyle.Bold);

            desk = new Panel();
            desk.Dock = DockStyle.Fill;
            desk.Visible = false;
            desk.BackColor = C_BG;

            deskHeadA = MakeDeskHead("谁在干什么");
            deskAgents = MakeDeskBox();
            deskHeadB = MakeDeskHead("任务 / 待验收");
            deskTasks = MakeDeskBox();
            deskHeadC = MakeDeskHead("邮件");
            deskMail = MakeDeskBox();
            deskFoot = new Label();
            deskFoot.Font = smallFont;
            deskFoot.ForeColor = C_MUTED;
            deskFoot.Text = "每 5 秒刷新 · 数据来自 9340（零 token）";

            desk.Controls.Add(deskHeadA);
            desk.Controls.Add(deskAgents);
            desk.Controls.Add(deskHeadB);
            desk.Controls.Add(deskTasks);
            desk.Controls.Add(deskHeadC);
            desk.Controls.Add(deskMail);
            desk.Controls.Add(deskFoot);
            form.Controls.Add(desk);
            desk.BringToFront();

            timer = new System.Windows.Forms.Timer();
            timer.Interval = PollMs;
            timer.Tick += OnTick;

            // W-031：工作台刷新计时器，**默认不启动**（只有停在工作台页签时才跑）
            deskTimer = new System.Windows.Forms.Timer();
            deskTimer.Interval = DeskPollMs;
            deskTimer.Tick += delegate { RefreshDesk(); };

            // 右键菜单（2026-10-26 方案①）：不占界面，只放「始终置顶」这一项。
            // 勾选即生效、即落盘；取消勾选就回到普通窗口层级。
            ContextMenuStrip menu = new ContextMenuStrip();
            menuTopMost = new ToolStripMenuItem("📌 始终置顶");
            menuTopMost.CheckOnClick = true;
            menuTopMost.Checked = topMost;
            menuTopMost.Click += delegate { SetTopMost(menuTopMost.Checked); };
            menu.Items.Add(menuTopMost);
            form.ContextMenuStrip = menu;
            header.ContextMenuStrip = menu;
            flow.ContextMenuStrip = menu;

            LayoutChildren();
        }

        // 2026-10-26：不要用 Anchor 做右对齐。这些控件的父容器在 Add 之前还没 Dock 好，
        // Anchor 会拿错误的父宽度算边距（实测把「×」挤出屏幕、让输入框盖住「发送」按钮）。
        // 统一在 Resize 时显式计算位置。
        static void LayoutChildren()
        {
            int w = form.ClientSize.Width;
            if (w < 240) w = 240;
            closeBtn.Left = w - 48;
            pinBtn.Left = w - 112;   // 2026-10-26：置顶开关，放在 × 左边
            txtBack.Width = Math.Max(140, w - 108);
            txt.Width = Math.Max(80, txtBack.Width - 24);
            btnSend.Left = w - 88;
            apTitle.Width = w - 30;
            apDetail.Width = w - 30;
            btnSend.BringToFront();
            LayoutDesk();
        }

        static Button MakeApButton(string text, int left, int width, Color color)
        {
            Button b = new Button();
            b.Text = text;
            b.Left = left; b.Top = 68; b.Width = width; b.Height = 26;
            b.FlatStyle = FlatStyle.Flat;
            b.BackColor = color;
            b.ForeColor = Color.White;
            b.Font = new Font("Microsoft YaHei UI", 9f);
            return b;
        }

        // ── W-031：工作台页签的控件工厂与排版 ───────────────────────────────
        static Label MakeDeskHead(string text)
        {
            Label l = new Label();
            l.Text = text;
            l.AutoSize = false;
            l.Height = 18;
            l.Font = deskHeadFont;
            l.ForeColor = C_MUTED;
            l.BackColor = C_BG;
            return l;
        }

        static RichTextBox MakeDeskBox()
        {
            RichTextBox r = new RichTextBox();
            r.ReadOnly = true;
            r.BorderStyle = BorderStyle.None;
            r.BackColor = Color.FromArgb(255, 253, 250);
            r.ForeColor = C_TEXT;
            r.Font = deskFont;
            r.ScrollBars = RichTextBoxScrollBars.Vertical;
            r.WordWrap = true;
            r.DetectUrls = false;
            r.HideSelection = true;
            return r;
        }

        /// <summary>工作台页签的三段纵向排版（窗口很窄，三列塞不下）。</summary>
        static void LayoutDesk()
        {
            if (desk == null || deskAgents == null) return;
            int w = desk.ClientSize.Width;
            int h = desk.ClientSize.Height;
            if (w <= 0 || h <= 0) return;
            int pad = 10;
            int inner = Math.Max(40, w - pad * 2);
            int footH = 16;
            int headH = 18;
            int gap = 5;
            int total = Math.Max(60, h - footH - 8);
            int h1 = (int)(total * 0.46);
            int h2 = (int)(total * 0.31);
            int h3 = total - h1 - h2;
            if (h3 < 44) { h3 = 44; h1 = total - h2 - h3; }

            int y = 2;
            deskHeadA.Left = pad; deskHeadA.Top = y; deskHeadA.Width = inner; y += headH;
            deskAgents.Left = pad; deskAgents.Top = y; deskAgents.Width = inner; deskAgents.Height = Math.Max(40, h1 - headH); y += deskAgents.Height + gap;
            deskHeadB.Left = pad; deskHeadB.Top = y; deskHeadB.Width = inner; y += headH;
            deskTasks.Left = pad; deskTasks.Top = y; deskTasks.Width = inner; deskTasks.Height = Math.Max(36, h2 - headH); y += deskTasks.Height + gap;
            deskHeadC.Left = pad; deskHeadC.Top = y; deskHeadC.Width = inner; y += headH;
            deskMail.Left = pad; deskMail.Top = y; deskMail.Width = inner; deskMail.Height = Math.Max(36, h3 - headH);
            deskFoot.Left = pad; deskFoot.Top = h - footH - 2; deskFoot.Width = inner; deskFoot.Height = footH;
        }

        static void ApplyTabColors()
        {
            tabXunyu.BackColor = target == "xunyu" ? C_ME : C_HEADER;
            tabXunyu.ForeColor = target == "xunyu" ? Color.White : C_MUTED;
            tabDsh.BackColor = target == "dsh" ? C_ME : C_HEADER;
            tabDsh.ForeColor = target == "dsh" ? Color.White : C_MUTED;
            if (tabDesk != null)
            {
                tabDesk.BackColor = target == "desk" ? C_ME : C_HEADER;
                tabDesk.ForeColor = target == "desk" ? Color.White : C_MUTED;
            }
            title.Text = target == "xunyu" ? "鲟鱼" : (target == "dsh" ? "DSH" : "工作台");
        }

        // ── 气泡 ────────────────────────────────────────────────────────────
        static void AddBubble(string who, string text)
        {
            if (text == null) text = "";
            int maxW = Math.Max(120, flow.ClientSize.Width - 60);
            Font f = new Font("Microsoft YaHei UI", 9.5f);
            Size measure = TextRenderer.MeasureText(text, f, new Size(maxW, 4000), TextFormatFlags.WordBreak);
            int bw = maxW + 24;
            int bh = measure.Height + 26;

            bool mine = who == "me";
            Color bubbleColor = mine ? C_ME : C_HER;
            Color textColor = mine ? Color.White : C_TEXT;

            Panel row = new Panel();
            row.Width = maxW + 44;
            row.Height = bh + 8;
            row.BackColor = C_BG;

            Panel bubble = new Panel();
            bubble.Width = bw;
            bubble.Height = bh;
            bubble.Top = 4;
            bubble.Left = mine ? Math.Max(0, row.Width - bw) : 0;
            bubble.BackColor = C_BG;
            Color bc = bubbleColor;
            bubble.Paint += delegate (object s, PaintEventArgs e) { PaintRoundFill(s, e, bubble, bc, 12); };

            Label lbl = new Label();
            lbl.Text = text;
            lbl.Left = 12; lbl.Top = 9;
            lbl.Width = bw - 24;
            lbl.Height = bh - 18;
            lbl.BackColor = bubbleColor;
            lbl.ForeColor = textColor;
            lbl.Font = f;

            bubble.Controls.Add(lbl);
            row.Controls.Add(bubble);
            flow.Controls.Add(row);
            flow.ScrollControlIntoView(row);
        }

        static void SetTarget(string name)
        {
            if (target == name) return;
            target = name;
            ApplyTabColors();

            bool isDesk = name == "desk";
            if (isDesk)
            {
                // W-031：工作台是只读看板——不落盘（否则下次启动落在空面板）、不发气泡、不清聊天区。
                flow.Visible = false;
                footer.Visible = false;
                approval.Visible = false;
                desk.Visible = true;
                desk.BringToFront();
                LayoutDesk();
                RefreshDesk();
                if (deskTimer != null) deskTimer.Start();
                return;
            }

            desk.Visible = false;
            flow.Visible = true;
            footer.Visible = true;
            if (deskTimer != null) deskTimer.Stop();
            flow.Controls.Clear();
            SaveState();
            string who = name == "xunyu" ? "鲟鱼（QQ 侧）" : "DSH（我这边，不走 QQ）";
            AddBubble("her", "已切到 " + who + "。");
            AlignCursor();
            txt.Focus();
        }

        static void AlignCursor()
        {
            // after 给巨大值 = 只取当前游标、不拉历史
            try
            {
                string url = string.Format("{0}/lines?after=999999999&target={1}&client=window", Relay, target);
                string s = GetStringSync(url, 4000);
                LinesResp r = Json.Deserialize<LinesResp>(s);
                if (r != null) cursor = r.cursor;
            }
            catch { cursor = 0; }
        }

        // 同步 GET（只在启动阶段用：UI 线程上等异步方法会死锁）
        static string GetStringSync(string url, int timeoutMs)
        {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
            req.Timeout = timeoutMs;
            req.ReadWriteTimeout = timeoutMs;
            req.Proxy = null;
            using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
            using (StreamReader sr = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
            {
                return sr.ReadToEnd();
            }
        }

        static void UpdateHealthSync()
        {
            lastHealth = DateTime.Now;
            bool relayOk = false;
            try
            {
                HealthResp r = Json.Deserialize<HealthResp>(GetStringSync(Relay + "/health?client=window", 3000));
                relayOk = r != null && r.ok;
            }
            catch { relayOk = false; }

            bool bodyOk = false;
            if (relayOk)
            {
                try
                {
                    HealthResp r = Json.Deserialize<HealthResp>(GetStringSync("http://127.0.0.1:9335/health", 2000));
                    bodyOk = r != null && r.ok;
                }
                catch { bodyOk = false; }
            }
            ApplyHealth(relayOk, bodyOk);
        }

        static void ApplyHealth(bool relayOk, bool bodyOk)
        {
            if (!relayOk)
            {
                healthState = "relay";
                dot.ForeColor = Color.FromArgb(200, 60, 60);
                status.Text = "中继离线 · 重连中";
                status.ForeColor = Color.FromArgb(200, 60, 60);
            }
            else if (!bodyOk)
            {
                healthState = "mod";
                dot.ForeColor = Color.FromArgb(220, 150, 60);
                status.Text = "身体未连接";
                status.ForeColor = Color.FromArgb(190, 130, 50);
            }
            else
            {
                healthState = "ok";
                dot.ForeColor = Color.FromArgb(80, 180, 110);
                status.Text = "在线";
                status.ForeColor = Color.FromArgb(110, 150, 120);
            }
        }

        // ── 发送 ────────────────────────────────────────────────────────────
        static async void SendText()
        {
            string text = txt.Text == null ? "" : txt.Text.Trim();
            if (text.Length == 0) return;
            txt.Text = "";
            AddBubble("me", text);
            try
            {
                Dictionary<string, object> payload = new Dictionary<string, object>();
                payload["text"] = text;
                payload["target"] = target;
                string resp = await PostJson(Relay + "/chat", payload);
                ChatResp r = Json.Deserialize<ChatResp>(resp);
                if (r != null && !r.ok) AddBubble("her", "没送出去：" + (r.error == null ? "" : r.error));
            }
            catch (Exception ex)
            {
                AddBubble("her", "发送失败：" + HttpError(ex));
            }
        }

        static async Task<string> PostJson(string url, object payload)
        {
            string body = Json.Serialize(payload);
            using (StringContent content = new StringContent(body, Encoding.UTF8, "application/json"))
            {
                HttpResponseMessage resp = await Http.PostAsync(url, content);
                string text = await resp.Content.ReadAsStringAsync();
                if (!resp.IsSuccessStatusCode)
                {
                    string err = ExtractError(text);
                    throw new Exception(string.Format("HTTP {0} {1}", (int)resp.StatusCode, err));
                }
                return text;
            }
        }

        static string ExtractError(string text)
        {
            try
            {
                Dictionary<string, object> d = Json.DeserializeObject(text) as Dictionary<string, object>;
                if (d != null && d.ContainsKey("error")) return Convert.ToString(d["error"]);
            }
            catch { }
            return text == null ? "" : text;
        }

        static string HttpError(Exception ex)
        {
            AggregateException agg = ex as AggregateException;
            Exception e = agg != null && agg.InnerExceptions.Count > 0 ? agg.InnerExceptions[0] : ex;
            return e.Message;
        }

        // ── 审批 ────────────────────────────────────────────────────────────
        static async void InvokeApproval(string decision)
        {
            try
            {
                Dictionary<string, object> payload = new Dictionary<string, object>();
                payload["decision"] = decision;
                payload["approvalId"] = pendId;
                string resp = await PostJson(Relay + "/approve", payload);
                ChatResp r = Json.Deserialize<ChatResp>(resp);
                if (r != null && r.ok) AddBubble("her", "已" + (decision == "approve" ? "通过" : "拒绝"));
                else AddBubble("her", "操作失败：" + (r == null ? "" : r.error));
            }
            catch (Exception ex) { AddBubble("her", "操作失败：" + HttpError(ex)); }
            approval.Visible = false;
        }

        static async void OpenDelegationWindow()
        {
            try
            {
                Dictionary<string, object> payload = new Dictionary<string, object>();
                payload["minutes"] = 30;
                string resp = await PostJson(Relay + "/window", payload);
                Dictionary<string, object> d = Json.DeserializeObject(resp) as Dictionary<string, object>;
                if (d != null && Convert.ToBoolean(d["ok"]))
                    AddBubble("her", "代批窗口已开 " + Convert.ToString(d["minutes"]) + " 分钟。");
                else AddBubble("her", "开窗口失败：" + (d != null && d.ContainsKey("error") ? Convert.ToString(d["error"]) : ""));
            }
            catch (Exception ex) { AddBubble("her", "开窗口失败：" + HttpError(ex)); }
        }

        // ── 轮询 ────────────────────────────────────────────────────────────
        static async void OnTick(object sender, EventArgs e)
        {
            if (busy) return;
            busy = true;
            try
            {
                // 专用心跳：不管停在哪个页签都告诉中继「窗口还活着」
                try { await Http.GetStringAsync(Relay + "/window-presence?client=window"); } catch { }

                await UpdateHealthAsync(false);

                bool linesFailed = false;
                try
                {
                    string url = string.Format("{0}/lines?after={1}&target={2}&client=window", Relay, cursor, target);
                    string s = await Http.GetStringAsync(url);
                    LinesResp r = Json.Deserialize<LinesResp>(s);
                    if (r != null && r.ok && r.lines != null)
                    {
                        foreach (LineItem ln in r.lines)
                        {
                            if (ln.from == "agent") AddBubble("her", ln.text);
                            if (ln.n > cursor) cursor = ln.n;
                        }
                    }
                }
                catch { linesFailed = true; }
                if (linesFailed) await UpdateHealthAsync(true);

                await UpdatePendingAsync();
            }
            finally
            {
                // 任何一步抛错都要解锁，否则之后就再也不会轮询了
                busy = false;
            }
        }

        static async Task UpdatePendingAsync()
        {
            try
            {
                string s = await Http.GetStringAsync(Relay + "/pending?client=window");
                PendingResp r = Json.Deserialize<PendingResp>(s);
                if (r != null && r.ok && r.pending != null && r.pending.Count > 0)
                {
                    PendingItem it = r.pending[0];
                    pendId = it.approvalId == null ? "" : it.approvalId;
                    string kind = it.kind == "question" ? "提问" : "审批";
                    string danger = it.dangerous ? " ⚠高危" : "";
                    string more = r.pending.Count > 1 ? "（另有 " + (r.pending.Count - 1) + " 条排队）" : "";
                    apTitle.Text = kind + "：" + it.tool + danger + more;
                    apDetail.Text = "" + it.reason + "  （剩 " + Math.Round(it.expiresInMs / 1000.0) + " 秒）";
                    approval.Visible = true;
                }
                else
                {
                    pendId = "";
                    approval.Visible = false;
                }
            }
            catch { }
        }

        static async Task UpdateHealthAsync(bool force)
        {
            if (!force && (DateTime.Now - lastHealth).TotalSeconds < 5) return;
            lastHealth = DateTime.Now;

            bool relayOk = false;
            try
            {
                string s = await Http.GetStringAsync(Relay + "/health?client=window");
                HealthResp r = Json.Deserialize<HealthResp>(s);
                relayOk = r != null && r.ok;
            }
            catch { relayOk = false; }

            bool bodyOk = false;
            if (relayOk)
            {
                try
                {
                    using (HttpClient quick = new HttpClient { Timeout = TimeSpan.FromSeconds(3) })
                    {
                        string s = await quick.GetStringAsync("http://127.0.0.1:9335/health");
                        HealthResp r = Json.Deserialize<HealthResp>(s);
                        bodyOk = r != null && r.ok;
                    }
                }
                catch { bodyOk = false; }
            }

            ApplyHealth(relayOk, bodyOk);
        }

        static void Greet()
        {
            if (healthState == "ok")
                AddBubble("her", "连上了。打字回车发给我，我回的话会出现在这里，也会在她嘴边弹出来。");
            else
                AddBubble("her", "中继还没响应，我在重连。你先打字也行，连上就会发出去。");
        }

        // ── W-031：工作台页签（只读，直连 9340；9340 挂了只影响这一页签）────
        static async void RefreshDesk()
        {
            if (deskFetching) return;
            deskFetching = true;
            try
            {
                Task<string> ta = Http.GetStringAsync(DeskBase + "/api/agents");
                Task<string> tw = Http.GetStringAsync(DeskBase + "/api/worklist");
                Task<string> tm = Http.GetStringAsync(DeskBase + "/api/mail");
                await Task.WhenAll(ta, tw, tm);
                deskLastOk = DateTime.Now;
                FillDesk(ta.Result, tw.Result, tm.Result);
                deskFoot.Text = "每 5 秒刷新 · 数据来自 9340 · 上次成功 " + deskLastOk.ToString("HH:mm:ss");
                deskFoot.ForeColor = C_MUTED;
            }
            catch (Exception ex)
            {
                string last = deskLastOk == DateTime.MinValue ? "从未成功" : deskLastOk.ToString("HH:mm:ss");
                deskAgents.Clear();
                deskTasks.Clear();
                deskMail.Clear();
                Append(deskAgents, "工作台不可达（9340）\n", Color.FromArgb(190, 80, 80), true);
                Append(deskAgents, HttpError(ex) + "\n上次成功：" + last + "\n", C_MUTED, false);
                deskFoot.Text = "9340 不可达 · 上次成功 " + last;
                deskFoot.ForeColor = Color.FromArgb(190, 80, 80);
            }
            finally { deskFetching = false; }
        }

        static void FillDesk(string agentsJson, string worklistJson, string mailJson)
        {
            deskAgents.SuspendLayout();
            deskTasks.SuspendLayout();
            deskMail.SuspendLayout();
            try
            {
                FillDeskAgents(agentsJson);
                FillDeskTasks(worklistJson);
                FillDeskMail(mailJson);
            }
            finally
            {
                deskAgents.ResumeLayout();
                deskTasks.ResumeLayout();
                deskMail.ResumeLayout();
            }
        }

        static void FillDeskAgents(string json)
        {
            RichTextBox r = deskAgents;
            r.Clear();
            DeskAgentsResp a = Json.Deserialize<DeskAgentsResp>(json);
            if (a == null || !a.ok)
            {
                Append(r, "会话投影读不到\n", Color.FromArgb(190, 80, 80), true);
                if (a != null && a.error != null) Append(r, a.error + "\n", C_MUTED, false);
                return;
            }
            int shown = 0;
            if (a.agents != null)
            {
                for (int i = 0; i < a.agents.Count; i++)
                {
                    DeskAgent x = a.agents[i];
                    if (x == null) continue;
                    bool hasNo = x.no != null && x.no.Length > 0;
                    if (!x.live && !x.running && !hasNo && !Has(x.title, "鲟鱼")) continue;
                    shown++;
                    string who = hasNo ? ("工号" + x.no) : ShortTitle(x.title);
                    string state = x.live ? "在忙" : (x.running ? "在跑" : "空闲");
                    Color c = x.live ? Color.FromArgb(80, 180, 110) : (x.running ? C_ME : C_MUTED);
                    Append(r, "● ", c, true);
                    Append(r, who, C_TEXT, true);
                    Append(r, "  " + state, c, false);
                    if (x.idleText != null && x.idleText.Length > 0) Append(r, "  " + x.idleText, C_MUTED, false);
                    Append(r, "\n", C_TEXT, false);
                    if (x.doing != null && x.doing.Length > 0) Append(r, "   " + x.doing + "\n", C_TEXT, false);
                    if (x.queued > 0)
                    {
                        string nt = x.nextTask == null ? "" : (" · 下一条 " + Nz(x.nextTask.ticket) + " " + Nz(x.nextTask.title));
                        Append(r, "   排队 " + x.queued.ToString() + nt + "\n", Color.FromArgb(190, 130, 50), false);
                    }
                }
            }
            if (shown == 0) Append(r, "没有活跃会话\n", C_MUTED, false);
        }

        static void FillDeskTasks(string json)
        {
            RichTextBox r = deskTasks;
            r.Clear();
            DeskWorklistResp w = Json.Deserialize<DeskWorklistResp>(json);
            if (w == null || !w.ok)
            {
                Append(r, "任务台账读不到\n", Color.FromArgb(190, 80, 80), true);
                return;
            }
            Append(r, "排队 " + SumOf(w, "queued") + " · 在干 " + SumOf(w, "doing") + " · 待验收 " + SumOf(w, "submitted") + "\n", C_MUTED, false);
            if (w.groups != null)
            {
                for (int i = 0; i < w.groups.Count; i++)
                {
                    DeskGroup g = w.groups[i];
                    if (g == null) continue;
                    int n = Size(g.queue) + Size(g.doing) + Size(g.pending);
                    if (n == 0) continue;
                    Append(r, "\n工号" + Nz(g.target) + "\n", C_TEXT, true);
                    if (g.doing != null) for (int j = 0; j < g.doing.Count; j++) if (g.doing[j] != null) Append(r, "  ▸ " + Ticket(g.doing[j]) + " " + Nz(g.doing[j].title) + "\n", C_ME, false);
                    if (g.queue != null) for (int j = 0; j < g.queue.Count; j++) if (g.queue[j] != null) Append(r, "  · " + Ticket(g.queue[j]) + " " + Nz(g.queue[j].title) + "\n", C_MUTED, false);
                }
            }
            if (w.submitted != null && w.submitted.Count > 0)
            {
                Append(r, "\n待验收\n", C_TEXT, true);
                for (int i = 0; i < w.submitted.Count; i++)
                    if (w.submitted[i] != null) Append(r, "  ✓ " + Ticket(w.submitted[i]) + " " + Nz(w.submitted[i].title) + "\n", Color.FromArgb(60, 150, 95), false);
            }
        }

        static void FillDeskMail(string json)
        {
            RichTextBox r = deskMail;
            r.Clear();
            DeskMailResp m = Json.Deserialize<DeskMailResp>(json);
            if (m == null || !m.ok) { Append(r, "邮件池读不到\n", Color.FromArgb(190, 80, 80), true); return; }
            int un = 0;
            if (m.unread != null) for (int i = 0; i < m.unread.Count; i++) if (m.unread[i] != null) un += m.unread[i].unread;
            Append(r, "共 " + m.total.ToString() + " 封 · 未读 " + un.ToString() + "\n", C_MUTED, false);
            if (m.recent != null)
            {
                for (int i = 0; i < m.recent.Count; i++)
                {
                    DeskMailItem it = m.recent[i];
                    if (it == null) continue;
                    Append(r, "#" + it.seq.ToString() + " " + Nz(it.from) + "→" + Nz(it.to) + " ", C_TEXT, false);
                    Append(r, "[" + Nz(it.level) + "]\n", C_MUTED, false);
                    Append(r, "   " + Cut(Nz(it.excerpt), 60) + "\n", Color.FromArgb(120, 115, 110), false);
                }
            }
        }

        static void Append(RichTextBox r, string text, Color color, bool bold)
        {
            if (r == null || text == null || text.Length == 0) return;
            int start = r.TextLength;
            r.AppendText(text);
            r.SelectionStart = start;
            r.SelectionLength = text.Length;
            r.SelectionColor = color;
            r.SelectionFont = bold ? deskBoldFont : deskFont;
            r.SelectionStart = r.TextLength;
            r.SelectionLength = 0;
        }

        static string Nz(string s) { return s == null ? "" : s; }

        static bool Has(string s, string sub)
        {
            return s != null && s.IndexOf(sub, StringComparison.Ordinal) >= 0;
        }

        static string ShortTitle(string t)
        {
            if (t == null) return "?";
            string s = t.Replace("鲟鱼工作组", "").Replace("鲟鱼—", "").Replace("鲟鱼-", "").Trim();
            return s.Length == 0 ? t : s;
        }

        static string Cut(string s, int n)
        {
            if (s == null) return "";
            return s.Length <= n ? s : s.Substring(0, n - 1) + "…";
        }

        static int Size(List<DeskTask> l) { return l == null ? 0 : l.Count; }

        static string Ticket(DeskTask t)
        {
            if (t == null) return "";
            return t.ticket != null && t.ticket.Length > 0 ? t.ticket : Nz(t.id);
        }

        static string SumOf(DeskWorklistResp w, string key)
        {
            if (w == null || w.summary == null || !w.summary.ContainsKey(key)) return "0";
            object v = w.summary[key];
            return v == null ? "0" : Convert.ToString(v);
        }
    }

    // ── W-031：工作台 DTO（只反序列化窗口用到的字段）──────────────────────
    #pragma warning disable 0649
    class DeskNextTask { public string id; public string ticket; public string title; }
    class DeskAgent
    {
        public string id; public string title; public string no;
        public string phase; public string doing; public string idleText;
        public bool running; public bool live;
        public int toolCount; public int queued; public int tokens;
        public DeskNextTask nextTask;
    }
    class DeskAgentsResp { public bool ok; public string error; public int count; public int live; public List<DeskAgent> agents; }
    class DeskTask
    {
        public string id; public string ticket; public string title;
        public string target; public string state; public string file;
    }
    class DeskGroup
    {
        public string target; public DeskAgent agent;
        public List<DeskTask> doing; public List<DeskTask> queue;
        public List<DeskTask> pending; public List<DeskTask> submitted;
    }
    class DeskWorklistResp
    {
        public bool ok; public Dictionary<string, object> summary;
        public List<DeskGroup> groups; public List<DeskTask> submitted;
    }
    class DeskMailItem { public int seq; public string from; public string to; public string level; public string excerpt; }
    class DeskUnread { public string agent; public int total; public int unread; }
    class DeskMailResp { public bool ok; public int total; public List<DeskMailItem> recent; public List<DeskUnread> unread; }
    #pragma warning restore 0649
}
