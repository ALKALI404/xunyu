// XunyuLauncher.cs —— 鲟鱼启动器（极薄托盘壳，WS-030）
// 职责只有四件：① 按 tools\services.json 起服务 ② 打开工作台 ③ 托盘三色灯 + 菜单 ④ 托盘退出时全停。
// 用 .NET Framework 自带的 csc 编译（见 build.cmd），不引任何第三方库。
// 单实例：Mutex；再次双击只把工作台打开，不再起一份。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace XunyuLauncher
{
    internal sealed class Svc
    {
        public string Id;
        public string Name;
        public string Host;
        public int Port;
        public string[] Cmd;
        public string Cwd;
        public Process Proc;
    }

    internal sealed class Status
    {
        public int Up;
        public int Down;
        public int Total;
        public string Text = "还没连上工作台";
        public Color Color = Color.Gray;
        public string Glyph = "?";
    }

    internal static class Program
    {
        private const string MutexName = "Global\\XunyuLauncher.SingleInstance";
        private const string Workspace = @"E:\DSH_workspace";
        private const string ServicesJson = @"E:\DSH_workspace\tools\services.json";
        private const string DeskUrl = "http://127.1.1.2:9340/";

        [STAThread]
        private static void Main(string[] args)
        {
            // --quit：通知已经在跑的那个"停全部并退出"（用于脚本/验收，也方便以后做快捷方式）
            if (args != null && args.Length > 0 && string.Equals(args[0], "--quit", StringComparison.OrdinalIgnoreCase))
            {
                try
                {
                    using (var ev = new EventWaitHandle(false, EventResetMode.AutoReset, "Global\\XunyuLauncher.Quit"))
                        ev.Set();
                }
                catch { }
                return;
            }
            bool created;
            using (var mutex = new Mutex(true, MutexName, out created))
            {
                if (!created)
                {
                    // 已经在跑：只把工作台打开，不再起第二份
                    try { Process.Start(DeskUrl); } catch { }
                    return;
                }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                using (var app = new TrayApp())
                {
                    app.Start();
                    Application.Run(app);
                }
                GC.KeepAlive(mutex);
            }
        }
    }

    internal sealed class TrayApp : ApplicationContext
    {
        private readonly NotifyIcon _tray;
        private readonly System.Windows.Forms.Timer _timer;
        private readonly List<Svc> _services = new List<Svc>();
        private readonly Status _status = new Status();
        private readonly ToolStripMenuItem _statusItem;
        private bool _stopping;

        public TrayApp()
        {
            _statusItem = new ToolStripMenuItem("状态：启动中…") { Enabled = false };
            var menu = new ContextMenuStrip();
            menu.Items.Add(_statusItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(new ToolStripMenuItem("打开工作台", null, delegate { OpenDesk(); }));
            menu.Items.Add(new ToolStripMenuItem("自检", null, delegate { ShowSelftest(); }));
            menu.Items.Add(new ToolStripMenuItem("看日志", null, delegate { OpenDiag(); }));
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(new ToolStripMenuItem("停止全部服务", null, delegate { StopAll(true); }));
            menu.Items.Add(new ToolStripMenuItem("退出（停掉全部服务）", null, delegate { ExitAll(); }));

            _tray = new NotifyIcon
            {
                Icon = MakeIcon(Color.Gray, "?"),
                Text = "鲟鱼启动器",
                ContextMenuStrip = menu,
                Visible = true
            };
            _tray.DoubleClick += delegate { OpenDesk(); };
            _timer = new System.Windows.Forms.Timer { Interval = 500 };
            _timer.Tick += delegate
            {
                if (_quitRequested) { _quitRequested = false; ExitAll(); return; }
                if ((++_tick % 10) == 0) RefreshStatus();      // 状态 5 秒一刷
            };
        }

        private volatile bool _quitRequested;
        private int _tick;

        public void Start()
        {
            // --quit 的接收端：别的进程 Set 了这个事件就退出
            var th = new Thread(delegate ()
            {
                try
                {
                    using (var ev = new EventWaitHandle(false, EventResetMode.AutoReset, "Global\\XunyuLauncher.Quit"))
                    {
                        while (true) { ev.WaitOne(); _quitRequested = true; }
                    }
                }
                catch { }
            });
            th.IsBackground = true;
            th.Start();
            StartServices();
            OpenDesk();
            RefreshStatus();
            _timer.Start();
        }

        // ── 起服务：只起没在听的；顺序按 services.json ──────────────────
        private void StartServices()
        {
            try
            {
                string json = File.ReadAllText(@"E:\DSH_workspace\tools\services.json", Encoding.UTF8).TrimStart('\uFEFF');
                var ser = new JavaScriptSerializer { MaxJsonLength = 1 << 24 };
                var root = ser.Deserialize<Dictionary<string, object>>(json) as Dictionary<string, object>;
                if (root == null || !root.ContainsKey("services")) return;
                var list = root["services"] as System.Collections.IEnumerable;
                if (list == null) return;
                foreach (var item in list)
                {
                    var d = item as Dictionary<string, object>;
                    if (d == null) continue;
                    string id = Str(d, "id");
                    if (id == "selftest-badcmd") continue;          // 03 的自测坏服务，别起
                    var svc = new Svc
                    {
                        Id = id,
                        Name = Str(d, "name"),
                        Host = Str(d, "host"),
                        Cwd = Str(d, "cwd"),
                    };
                    svc.Port = ToInt(d, "port");
                    var cmd = d.ContainsKey("cmd") ? d["cmd"] as System.Collections.IEnumerable : null;
                    var parts = new List<string>();
                    if (cmd != null) foreach (var c in cmd) parts.Add(Convert.ToString(c));
                    svc.Cmd = parts.ToArray();
                    _services.Add(svc);
                    if (svc.Port > 0 && IsListening(svc.Port)) continue;   // 已经活着，不动它
                    Launch(svc);
                }
            }
            catch (Exception ex)
            {
                try { _tray.ShowBalloonTip(4000, "启动器", "读服务清单失败：" + ex.Message, ToolTipIcon.Warning); } catch { }
            }
        }

        private static string Str(Dictionary<string, object> d, string k)
        {
            if (d == null || !d.ContainsKey(k) || d[k] == null) return "";
            return Convert.ToString(d[k]);
        }

        private static int ToInt(Dictionary<string, object> d, string k)
        {
            if (d == null || !d.ContainsKey(k) || d[k] == null) return 0;
            int v;
            return int.TryParse(Convert.ToString(d[k]), out v) ? v : 0;
        }

        private void Launch(Svc svc)
        {
            try
            {
                if (svc.Cmd == null || svc.Cmd.Length == 0) return;
                string exe = svc.Cmd[0];
                if (exe == "node") exe = "node.exe";
                var sb = new StringBuilder();
                for (int i = 1; i < svc.Cmd.Length; i++) { if (sb.Length > 0) sb.Append(' '); sb.Append(svc.Cmd[i]); }
                var psi = new ProcessStartInfo(exe, sb.ToString())
                {
                    WorkingDirectory = string.IsNullOrEmpty(svc.Cwd) ? @"E:\DSH_workspace" : svc.Cwd,
                    UseShellExecute = false,
                    CreateNoWindow = true
                };
                svc.Proc = Process.Start(psi);
            }
            catch { }
        }

        // ── 状态：supervisor 的 up/down → 三色 ──────────────────────────
        private void RefreshStatus()
        {
            var st = new Status { Text = "读不到 supervisor", Color = Color.Gray, Glyph = "?" };
            try
            {
                string body = HttpGet("http://127.0.0.1:9340/api/supervisor", 2500);
                var ser = new JavaScriptSerializer { MaxJsonLength = 1 << 24 };
                var root = ser.Deserialize<Dictionary<string, object>>(body) as Dictionary<string, object>;
                var arr = root != null && root.ContainsKey("services") ? root["services"] as System.Collections.IEnumerable : null;
                int up = 0, down = 0, total = 0;
                if (arr != null)
                {
                    foreach (var it in arr)
                    {
                        var d = it as Dictionary<string, object>;
                        if (d == null) continue;
                        total++;
                        bool isUp = d.ContainsKey("up") && d["up"] != null && Convert.ToBoolean(d["up"]);
                        if (isUp) up++; else down++;
                    }
                }
                st.Up = up; st.Down = down; st.Total = total;
                if (total == 0) { st.Text = "没有服务"; st.Color = Color.Gray; st.Glyph = "?"; }
                else if (down == 0) { st.Text = "全好 " + up + "/" + total; st.Color = Color.FromArgb(62, 156, 122); st.Glyph = "✓"; }
                else if (up == 0) { st.Text = "全挂 0/" + total; st.Color = Color.FromArgb(194, 91, 82); st.Glyph = "×"; }
                else { st.Text = "部分异常 " + up + "/" + total; st.Color = Color.FromArgb(201, 138, 46); st.Glyph = "!"; }
            }
            catch
            {
                st.Text = "工作台没起（9340 不通）";
                st.Color = Color.FromArgb(194, 91, 82);
                st.Glyph = "×";
            }
            _status.Text = st.Text; _status.Color = st.Color; _status.Glyph = st.Glyph; _status.Up = st.Up; _status.Down = st.Down; _status.Total = st.Total;
            _tray.Icon = MakeIcon(st.Color, st.Glyph);
            _tray.Text = Clip("鲟鱼 · " + st.Text, 63);
            _statusItem.Text = "状态：" + st.Text;
        }

        private static string Clip(string s, int n) { return s.Length <= n ? s : s.Substring(0, n); }

        private void OpenDesk() { try { Process.Start("http://127.1.1.2:9340/"); } catch { } }

        private void OpenDiag()
        {
            try { Process.Start("http://127.1.1.2:9340/#diag"); } catch { }
        }

        private void ShowSelftest()
        {
            try
            {
                string body = HttpGet("http://127.0.0.1:9340/api/console/selftest", 10000);
                var ser = new JavaScriptSerializer { MaxJsonLength = 1 << 24 };
                var root = ser.Deserialize<Dictionary<string, object>>(body) as Dictionary<string, object>;
                var arr = root != null && root.ContainsKey("checks") ? root["checks"] as System.Collections.IEnumerable : null;
                var sb = new StringBuilder();
                int bad = 0;
                if (arr != null)
                {
                    foreach (var it in arr)
                    {
                        var d = it as Dictionary<string, object>;
                        if (d == null) continue;
                        bool ok = d.ContainsKey("ok") && d["ok"] != null && Convert.ToBoolean(d["ok"]);
                        if (!ok) bad++;
                        sb.Append(ok ? "✓ " : "✗ ").Append(Str(d, "name"));
                        string detail = Str(d, "detail");
                        if (detail.Length > 0) sb.Append(" — ").Append(detail);
                        sb.AppendLine();
                    }
                }
                MessageBox.Show(sb.Length == 0 ? "没有自检数据" : sb.ToString(), bad == 0 ? "自检：全过" : ("自检：" + bad + " 项不过"), MessageBoxButtons.OK, bad == 0 ? MessageBoxIcon.Information : MessageBoxIcon.Warning);
            }
            catch (Exception ex)
            {
                MessageBox.Show("自检失败：" + ex.Message, "自检", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        // ── 停止：先杀我们起的那几个，再按端口兜底 ─────────────────────
        private void StopAll(bool notify)
        {
            _stopping = true;
            foreach (var s in _services)
            {
                try { if (s.Proc != null && !s.Proc.HasExited) s.Proc.Kill(); } catch { }
            }
            foreach (var s in _services)
            {
                if (s.Port <= 0) continue;
                try { KillByPort(s.Port); } catch { }
            }
            _stopping = false;
            if (notify) RefreshStatus();
        }

        private static void KillByPort(int port)
        {
            var psi = new ProcessStartInfo("netstat", "-ano") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true };
            using (var p = Process.Start(psi))
            {
                string outp = p.StandardOutput.ReadToEnd();
                p.WaitForExit(4000);
                var pids = new HashSet<int>();
                foreach (var line in outp.Split('\n'))
                {
                    if (line.IndexOf(":" + port + " ", StringComparison.Ordinal) < 0) continue;
                    if (line.IndexOf("LISTENING", StringComparison.OrdinalIgnoreCase) < 0) continue;
                    var parts = line.Trim().Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
                    if (parts.Length < 5) continue;
                    int pid;
                    if (int.TryParse(parts[parts.Length - 1], out pid) && pid > 0) pids.Add(pid);
                }
                foreach (var pid in pids)
                {
                    try { Process.GetProcessById(pid).Kill(); } catch { }
                }
            }
        }

        private void ExitAll()
        {
            try { _timer.Stop(); } catch { }
            StopAll(false);
            _tray.Visible = false;
            _tray.Dispose();
            ExitThread();
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                try { _timer.Dispose(); } catch { }
                try { _tray.Visible = false; _tray.Dispose(); } catch { }
            }
            base.Dispose(disposing);
        }

        // ── 小工具 ─────────────────────────────────────────────────────
        private static string HttpGet(string url, int timeoutMs)
        {
            var req = (HttpWebRequest)WebRequest.Create(url);
            req.Timeout = timeoutMs;
            req.ReadWriteTimeout = timeoutMs;
            req.KeepAlive = false;
            using (var resp = (HttpWebResponse)req.GetResponse())
            using (var sr = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                return sr.ReadToEnd();
        }

        private static bool IsListening(int port)
        {
            try
            {
                var psi = new ProcessStartInfo("netstat", "-ano") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true };
                using (var p = Process.Start(psi))
                {
                    string outp = p.StandardOutput.ReadToEnd();
                    p.WaitForExit(3000);
                    foreach (var line in outp.Split('\n'))
                        if (line.IndexOf(":" + port + " ", StringComparison.Ordinal) >= 0 && line.IndexOf("LISTENING", StringComparison.OrdinalIgnoreCase) >= 0)
                            return true;
                }
            }
            catch { }
            return false;
        }

        // 运行时画 16×16 图标：颜色 + 字形（✓ ! × ?），色盲也能靠字形分辨
        internal static Icon MakeIcon(Color color, string glyph)
        {
            using (var bmp = new Bitmap(16, 16))
            using (var g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                g.Clear(Color.Transparent);
                using (var b = new SolidBrush(color)) g.FillEllipse(b, 0, 0, 15, 15);
                using (var pen = new Pen(Color.White, 1.4f)) g.DrawEllipse(pen, 0.7f, 0.7f, 13.6f, 13.6f);
                using (var f = new Font("Segoe UI", 8f, FontStyle.Bold, GraphicsUnit.Pixel))
                using (var w = new SolidBrush(Color.White))
                {
                    var sz = g.MeasureString(glyph, f);
                    g.DrawString(glyph, f, w, (16 - sz.Width) / 2f, (16 - sz.Height) / 2f - 0.5f);
                }
                IntPtr h = bmp.GetHicon();
                return Icon.FromHandle(h);
            }
        }
    }
}
