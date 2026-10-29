// window\WebShell.cs —— 鲟鱼窗口 · WebView2 壳（D38 / W-075，06）
//
// 为什么是壳：UI 全在 `window\web\index.html`（HTML/CSS/JS），C# 只负责
//   ① 开一个 1200×800 的窗体、记住位置与大小、高 DPI 不糊；
//   ② 把 WebView2 铺满窗体、加载本地 HTML；
//   ③ 失败的可见反馈（Runtime 缺失不白屏）。
// 通道：HTML 侧直接 fetch relay 9334（/lines /chat /pending /health）与工作台 9340（只读），
//   本壳不代理、不改 relay。
//
// D51（2026-10-28，07·窗口壳）：①头像图标（/win32icon 编进 exe + 窗体/任务栏同一张，读不到降级不崩）；
//   ②单实例（同一 exe 再启动 → 激活已有窗口，不再开第二份）。编译改用同目录 build-web.cmd。
//
// 编译（系统 csc 4.x，C# 5）：
//   cd E:\DeepFish\avatar\window
//   C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /target:winexe /platform:x64 `
//     /out:XunyuWebWindow.exe /r:System.Windows.Forms.dll /r:System.Drawing.dll `
//     /r:System.Web.Extensions.dll /r:vendor\Microsoft.Web.WebView2.Core.dll `
//     /r:vendor\Microsoft.Web.WebView2.WinForms.dll WebShell.cs
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

static class WebShell
{
    const string WebDir = @"E:\DeepFish\avatar\window\web";
    const string StateFile = @"E:\DeepFish\avatar\state\web-shell.json";
    const string UserDataDir = @"E:\DeepFish\avatar\state\window-webview";
    // D40：本地历史。格式与 03 的 D9 完全一致（History\window\<鲟鱼|dsh>\YYYY-MM-DD.jsonl，
    // 一行 {t, from, target, text}），**只读不写**——写入由 relay 的 persistWindowLine 负责，
    // 壳再写一份就是双写，会互相打架。
    const string HistoryRoot = @"E:\DeepFish\History\window";

    [DllImport("user32.dll")]
    static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);

    // D51（07）：单实例——把已有窗口叫到前面来
    [DllImport("user32.dll")]
    static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
    const int SW_RESTORE = 9;

    // D51（07）：单实例互斥体。Local\ = 当前登录会话内唯一。
    const string MutexName = @"Local\XunyuWindow_SingleInstance_v1";
    static Mutex instanceMutex;
    const string IconFileName = "xunyu.ico";

    static Form form;
    static WebView2 view;
    static JavaScriptSerializer json = new JavaScriptSerializer();

    [STAThread]
    static void Main()
    {
        // D51（07）：单实例闸门——抢不到互斥体就说明已有一份在跑，激活它然后自己退出。
        bool createdNew;
        instanceMutex = new Mutex(true, MutexName, out createdNew);
        if (!createdNew)
        {
            bool activated = TryActivateExisting(3000);
            BridgeLog("second instance: 已有实例，激活" + (activated ? "成功" : "失败（没找到窗口句柄，可能还在初始化）"));
            return;
        }

        // 高 DPI：PER_MONITOR_AWARE_V2（-4）。老系统不支持就退回由 WinForms 自己处理。
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        form = new Form();
        form.Text = "鲟鱼";
        form.MinimumSize = new Size(900, 600);
        form.StartPosition = FormStartPosition.Manual;
        form.ShowInTaskbar = true;
        form.BackColor = Color.FromArgb(250, 247, 242);   // 暖白底，与 HTML 主题一致（主人 2026-10-28 定的配色）
        // D51（07）：标题栏 / 任务栏 / Alt-Tab 用同一张头像；载入失败返回 null 就保持默认图标，不崩。
        Icon appIcon = LoadAppIcon();
        if (appIcon != null) form.Icon = appIcon;
        LoadState();

        view = new WebView2();
        view.Dock = DockStyle.Fill;
        view.DefaultBackgroundColor = Color.FromArgb(250, 247, 242);
        form.Controls.Add(view);

        form.FormClosing += delegate { SaveState(); };

        form.Shown += async (s, e) =>
        {
            try
            {
                // 用户数据目录放到 state 下，别在 window\ 里长出一堆缓存
                Directory.CreateDirectory(UserDataDir);
                // 本地 file:// 页面要 fetch relay 9334 与工作台 9340——两者都没发 CORS 头（relay 归 03，我们不改它）。
                // 这是纯本地自用壳，没有远程内容，所以关掉 web security 让 file:// 能直连 loopback。
                // 调试端口只绑 127.0.0.1（WebView2 默认只监听本地），给排障/自动化留口子。
                CoreWebView2EnvironmentOptions opts = new CoreWebView2EnvironmentOptions(
                    "--disable-web-security --allow-file-access-from-files --remote-debugging-port=9223");
                CoreWebView2Environment env = await CoreWebView2Environment.CreateAsync(null, UserDataDir, opts);
                await view.EnsureCoreWebView2Async(env);
                // D40：本地历史桥——页面 postMessage 要历史，壳读 D9 的 jsonl 回给它（断网也能翻）
                view.CoreWebView2.WebMessageReceived += OnWebMessage;
                view.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
                view.CoreWebView2.Settings.IsStatusBarEnabled = false;
                string file = "file:///" + WebDir.Replace("\\", "/") + "/index.html";
                view.CoreWebView2.Navigate(file);
                form.Text = "鲟鱼 · " + view.CoreWebView2.Environment.BrowserVersionString;
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    "WebView2 起不来：" + ex.Message + "\r\n\r\n" +
                    "需要 Microsoft Edge WebView2 Runtime（本机一般随 Edge 装好）。\r\n" +
                    "回滚：直接跑 XunyuChatWindow.exe（旧的 WinForms 窗口）。",
                    "鲟鱼", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                Application.Exit();
            }
        };

        Application.Run(form);
    }

    // ── 记住位置与大小（state\web-shell.json，向后兼容：坏文件当没有）──
    static void LoadState()
    {
        int w = 1200, h = 800, x = 120, y = 90;
        try
        {
            if (File.Exists(StateFile))
            {
                string raw = File.ReadAllText(StateFile, Encoding.UTF8);
                object o = json.DeserializeObject(raw);
                System.Collections.Generic.Dictionary<string, object> d =
                    o as System.Collections.Generic.Dictionary<string, object>;
                if (d != null)
                {
                    if (d.ContainsKey("w")) w = Convert.ToInt32(d["w"]);
                    if (d.ContainsKey("h")) h = Convert.ToInt32(d["h"]);
                    if (d.ContainsKey("x")) x = Convert.ToInt32(d["x"]);
                    if (d.ContainsKey("y")) y = Convert.ToInt32(d["y"]);
                }
            }
        }
        catch { }
        if (w < 900) w = 900;
        if (h < 600) h = 600;
        form.Size = new Size(w, h);
        form.Location = new Point(x, y);
    }

    static void SaveState()
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(StateFile));
            System.Collections.Generic.Dictionary<string, object> d =
                new System.Collections.Generic.Dictionary<string, object>();
            d["w"] = form.Width;
            d["h"] = form.Height;
            d["x"] = form.Location.X;
            d["y"] = form.Location.Y;
            File.WriteAllText(StateFile, json.Serialize(d), new UTF8Encoding(false));
        }
        catch { }
    }

    // ── D51（07）：单实例——找同名的另一个实例，把它的窗口提到前面 ──────────
    /// <summary>
    /// 激活已有的同名实例。等 waitMs 毫秒再放弃（首个实例可能还在建窗口，句柄暂时是 0）。
    /// 只动自己这一份：ShowWindowAsync + SetForegroundWindow，不去抢别人的焦点。
    /// </summary>
    static bool TryActivateExisting(int waitMs)
    {
        int selfPid = Process.GetCurrentProcess().Id;
        string selfName = Process.GetCurrentProcess().ProcessName;
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(waitMs);
        while (true)
        {
            Process[] ps = null;
            try { ps = Process.GetProcessesByName(selfName); }
            catch { ps = null; }
            if (ps != null)
            {
                for (int i = 0; i < ps.Length; i++)
                {
                    try
                    {
                        if (ps[i].Id == selfPid) continue;
                        IntPtr h = ps[i].MainWindowHandle;
                        if (h == IntPtr.Zero) continue;      // 还在初始化，下一轮再看
                        ShowWindowAsync(h, SW_RESTORE);      // 最小化过的也恢复出来
                        SetForegroundWindow(h);
                        BridgeLog("second instance: 激活已有窗口 pid=" + ps[i].Id + " hwnd=" + h.ToInt64());
                        return true;
                    }
                    catch { }
                    finally { ps[i].Dispose(); }
                }
            }
            if (DateTime.UtcNow >= deadline) return false;
            Thread.Sleep(120);
        }
    }

    // ── D51（07）：头像图标。① exe 同级 xunyu.ico → ② exe 内嵌图标 → ③ 系统默认 ──
    /// <summary>载入窗口图标。任何一步失败都降级并写日志，绝不抛给上层。</summary>
    static Icon LoadAppIcon()
    {
        string p = null;
        try
        {
            // 相对路径：相对 exe 自己所在的目录，不写死绝对路径
            p = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, IconFileName);
            if (File.Exists(p))
            {
                Icon ic = new Icon(p);
                BridgeLog("icon: 载入同级 " + p + "（" + ic.Width + "×" + ic.Height + "）");
                return ic;
            }
            BridgeLog("icon: 同级没有 " + IconFileName + "，降级用 exe 内嵌图标 → " + Application.ExecutablePath);
        }
        catch (Exception ex) { BridgeLog("icon: 读 " + (p == null ? IconFileName : p) + " 失败，降级用内嵌图标: " + ex.Message); }

        try
        {
            Icon ic = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            if (ic != null) { BridgeLog("icon: 用 exe 内嵌图标（/win32icon 编进去的那张）"); return ic; }
            BridgeLog("icon: exe 内嵌图标也取不到");
        }
        catch (Exception ex) { BridgeLog("icon: 取内嵌图标失败: " + ex.Message); }

        BridgeLog("icon: 用 WinForms 默认图标（降级完成，不影响使用）");
        return null;
    }

    // ── D40：本地历史桥（只读 D9 的 jsonl，格式与 03 一致）────────────────
    static void BridgeLog(string msg)
    {
        try
        {
            File.AppendAllText(@"E:\DeepFish\avatar\state\webshell-bridge.log",
                DateTime.Now.ToString("HH:mm:ss.fff") + " " + msg + "\r\n", new UTF8Encoding(false));
        }
        catch { }
    }

    // ── D49：exe 工具白名单 + 进程查询 ──────────────────────────────────
    static readonly string[] ALLOW_EXE = new string[] { @"C:\Program Files\Steam++\Steam++.exe" };

    static string[] ToStrArray(object v)
    {
        List<string> list = new List<string>();
        string sv = v as string;
        if (sv != null) { list.Add(sv); return list.ToArray(); }
        System.Collections.IEnumerable en = v as System.Collections.IEnumerable;
        if (en != null) { foreach (object o in en) if (o != null) list.Add(Convert.ToString(o)); }
        return list.ToArray();
    }

    static Dictionary<string, object> QueryProcs(string[] names)
    {
        List<Dictionary<string, object>> procs = new List<Dictionary<string, object>>();
        for (int i = 0; i < names.Length; i++)
        {
            try
            {
                Process[] ps = Process.GetProcessesByName(names[i]);
                for (int k = 0; k < ps.Length; k++)
                {
                    try
                    {
                        Dictionary<string, object> o = new Dictionary<string, object>();
                        o["name"] = names[i];
                        o["pid"] = ps[k].Id;
                        procs.Add(o);
                    }
                    catch { }
                    finally { ps[k].Dispose(); }
                }
            }
            catch { }
        }
        Dictionary<string, object> r = new Dictionary<string, object>();
        r["ok"] = true;
        r["running"] = procs.Count > 0;
        r["procs"] = procs;
        return r;
    }

    static void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            string raw = e.WebMessageAsJson;
            Dictionary<string, object> msg = json.Deserialize<Dictionary<string, object>>(raw);
            if (msg == null || !msg.ContainsKey("type")) { BridgeLog("收到无 type 消息"); return; }
            string type = Convert.ToString(msg["type"]);
            if (type == "history:load")
            {
                // D46：分页——target 决定看哪条会话，offset 是「已经加载了多少条（从最新往前数）」
                string target = msg.ContainsKey("target") ? Convert.ToString(msg["target"]) : "xunyu";
                int limit = msg.ContainsKey("limit") ? Convert.ToInt32(msg["limit"]) : 200;
                int offset = msg.ContainsKey("offset") ? Convert.ToInt32(msg["offset"]) : 0;
                if (limit <= 0) limit = 200;
                if (limit > 500) limit = 500;
                if (offset < 0) offset = 0;
                Dictionary<string, object> page = LoadHistoryPage(target, limit, offset);
                page["type"] = "history:data";
                view.CoreWebView2.PostWebMessageAsJson(json.Serialize(page));
                BridgeLog("history:load target=" + target + " limit=" + limit + " offset=" + offset
                    + " → 回传 " + page["loaded"] + " / 共 " + page["total"]);
            }
            else if (type == "launch")
            {
                // D49：工作区 kind:'exe' 的启动口。白名单硬编码在壳里；args 不参与执行。
                string exe = msg.ContainsKey("exe") ? Convert.ToString(msg["exe"]) : "";
                string[] watch = ToStrArray(msg.ContainsKey("watch") ? msg["watch"] : null);
                string toolId = msg.ContainsKey("toolId") ? Convert.ToString(msg["toolId"]) : null;
                Dictionary<string, object> resp = new Dictionary<string, object>();
                resp["type"] = "launch:result";
                resp["toolId"] = toolId;
                try
                {
                    string full = Path.GetFullPath(exe ?? "");
                    bool ok = false;
                    for (int i = 0; i < ALLOW_EXE.Length; i++)
                        if (String.Equals(Path.GetFullPath(ALLOW_EXE[i]), full, StringComparison.OrdinalIgnoreCase)) ok = true;
                    if (!ok)
                    {
                        resp["ok"] = false; resp["error"] = "不在启动白名单里：" + full;
                        BridgeLog("launch 拒绝（不在白名单）" + full);
                    }
                    else if (!File.Exists(full))
                    {
                        resp["ok"] = false; resp["error"] = "程序不存在：" + full + "（被移走或改名了？）";
                        BridgeLog("launch 失败（文件不存在）" + full);
                    }
                    else
                    {
                        ProcessStartInfo psi = new ProcessStartInfo(full);
                        psi.UseShellExecute = true;   // 该弹 UAC 就由系统弹，不静默提权
                        Process.Start(psi);
                        BridgeLog("launch 已发起 " + full + "（等进程出现，最多 2s）");
                        bool running = false;
                        for (int i = 0; i < 10; i++)
                        {
                            System.Threading.Thread.Sleep(200);
                            if (watch.Length > 0 && Convert.ToBoolean(QueryProcs(watch)["running"])) { running = true; break; }
                        }
                        resp["ok"] = running || watch.Length == 0;
                        resp["procs"] = QueryProcs(watch)["procs"];
                        if (!Convert.ToBoolean(resp["ok"])) resp["error"] = "已发出启动，但 2 秒内没看到进程（UAC 还没点？）";
                        BridgeLog("launch 结果 " + (Convert.ToBoolean(resp["ok"]) ? "成功" : "未确认") + " " + full);
                    }
                }
                catch (Exception ex) { resp["ok"] = false; resp["error"] = "启动失败：" + ex.Message; BridgeLog("launch 异常 " + ex.Message); }
                view.CoreWebView2.PostWebMessageAsJson(json.Serialize(resp));
            }
            else if (type == "proc:query")
            {
                // D49：查进程在不在跑（子菜单判断「已在运行」）
                string[] names = ToStrArray(msg.ContainsKey("names") ? msg["names"] : null);
                Dictionary<string, object> pr = QueryProcs(names);
                pr["type"] = "proc:data";
                pr["toolId"] = msg.ContainsKey("toolId") ? Convert.ToString(msg["toolId"]) : null;
                view.CoreWebView2.PostWebMessageAsJson(json.Serialize(pr));
            }
            else if (type == "open")
            {
                // D43：工作台项目卡里的「项目文档」链接，用默认编辑器打开。
                // 只允许 workspace 下的 docs\ 与 records\，其它路径一律拒绝。
                string path = msg.ContainsKey("path") ? Convert.ToString(msg["path"]) : "";
                try
                {
                    string full = Path.GetFullPath(path);
                    string docs = Path.GetFullPath(@"E:\DSH_workspace\docs");
                    string recs = Path.GetFullPath(@"E:\DSH_workspace\records");
                    bool ok = full.StartsWith(docs, StringComparison.OrdinalIgnoreCase)
                           || full.StartsWith(recs, StringComparison.OrdinalIgnoreCase);
                    BridgeLog("open 请求 " + full + " → " + (ok ? (File.Exists(full) ? "允许" : "文件不存在") : "拒绝（不在 docs/records 下）"));
                    if (ok && File.Exists(full))
                    {
                        ProcessStartInfo psi = new ProcessStartInfo(full);
                        psi.UseShellExecute = true;
                        Process.Start(psi);
                    }
                }
                catch (Exception ex) { BridgeLog("open 异常: " + ex.Message); }
            }
        }
        catch (Exception ex) { BridgeLog("OnWebMessage 异常: " + ex.Message); }
    }

    static bool TargetMatches(string want, string got)
    {
        if (want == "xunyu") return got == "鲟鱼" || got == "xunyu";
        if (want == "dsh") return got == "dsh";
        return got == want;
    }

    /// <summary>
    /// D46：分页读历史。读 `History\window\` 下**所有子目录、所有日期**的 jsonl（不硬编码中文目录名，
    /// 所以跨天自然成立），按行里的 target 字段过滤，按 t 升序，
    /// 从**尾部**往前取 [total-offset-limit, total-offset) 这一段。
    /// 返回 {target,total,offset,limit,loaded,lines}。
    /// </summary>
    static Dictionary<string, object> LoadHistoryPage(string target, int limit, int offset)
    {
        List<Dictionary<string, object>> all = new List<Dictionary<string, object>>();
        if (Directory.Exists(HistoryRoot))
        {
            string[] dirs = Directory.GetDirectories(HistoryRoot);
            for (int k = 0; k < dirs.Length; k++)
            {
                string[] files = Directory.GetFiles(dirs[k], "*.jsonl");
                Array.Sort(files);
                for (int i = 0; i < files.Length; i++)
                {
                    try
                    {
                        // relay 的 persistWindowLine 长期持有写句柄——必须 FileShare.ReadWrite 才读得到
                        using (FileStream fs = new FileStream(files[i], FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                        using (StreamReader sr = new StreamReader(fs, Encoding.UTF8))
                        {
                            string line;
                            while ((line = sr.ReadLine()) != null)
                            {
                                if (String.IsNullOrWhiteSpace(line)) continue;
                                try
                                {
                                    Dictionary<string, object> o = json.Deserialize<Dictionary<string, object>>(line);
                                    if (o == null) continue;
                                    string tg = o.ContainsKey("target") ? Convert.ToString(o["target"]) : "";
                                    if (TargetMatches(target, tg)) all.Add(o);
                                }
                                catch { }
                            }
                        }
                    }
                    catch (Exception ex) { BridgeLog("  读文件失败 " + Path.GetFileName(files[i]) + ": " + ex.Message); }
                }
            }
        }
        all.Sort(delegate (Dictionary<string, object> a, Dictionary<string, object> b)
        {
            long ta = a.ContainsKey("t") ? Convert.ToInt64(a["t"]) : 0;
            long tb = b.ContainsKey("t") ? Convert.ToInt64(b["t"]) : 0;
            return ta.CompareTo(tb);
        });
        int total = all.Count;
        int end = Math.Max(0, total - offset);
        int start = Math.Max(0, end - limit);
        List<Dictionary<string, object>> slice = end > start
            ? all.GetRange(start, end - start)
            : new List<Dictionary<string, object>>();
        Dictionary<string, object> resp = new Dictionary<string, object>();
        resp["target"] = target;
        resp["offset"] = offset;
        resp["limit"] = limit;
        resp["total"] = total;
        resp["loaded"] = start == 0 ? total : (offset + slice.Count);
        resp["lines"] = slice;
        return resp;
    }
}
