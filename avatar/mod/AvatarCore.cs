// LilithAvatar —— 把「不存在的莉莉丝」变成鲟鱼的身体（v0.3）
//
// 1. 本地 HTTP 口 127.0.0.1:9333：/ping /say /anim /emotion /dialogue /state /events /dump
// 2. 对话窗口（F8 开合，可拖动）：显示鲟鱼说的话，也能打字发出去
// 3. 说话优先走游戏**自己的** DialogueManager（自带气泡/表情/语音），失败才用我们画的层
//
// 不 hook 任何游戏方法，所以游戏更新最坏只是这个 mod 失效，不会把游戏改坏。
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading;
using MelonLoader;
using UnityEngine;

[assembly: MelonInfo(typeof(LilithAvatar.AvatarMain), "LilithAvatar", "0.3.0", "DSH")]
[assembly: MelonGame(null, null)]

namespace LilithAvatar
{
    public partial class AvatarMain : MelonMod
    {
        const int DefaultPort = 9333;
        static readonly string RelayUrl = Environment.GetEnvironmentVariable("LILITH_AVATAR_RELAY") ?? "http://127.0.0.1:9334";

        readonly ConcurrentQueue<string> _outbox = new ConcurrentQueue<string>();
        // Unity 的 API（FindObjectsOfType / 组件调用）只能在主线程碰。
        // HTTP 请求跑在线程池线程上，所以统一投递到这里，由 OnUpdate 执行。
        readonly ConcurrentQueue<Action> _mainQueue = new ConcurrentQueue<Action>();
        readonly List<Line> _history = new List<Line>();
        readonly object _lock = new object();

        HttpListener _http;
        static readonly HttpClient Client = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };

        bool _visible = false;  // 输入改用游戏外的独立窗口（B 方案），这里默认只显示气泡不显示面板
        string _input = "";
        Vector2 _winPos = new Vector2(80f, 120f);
        Vector2 _scroll;
        bool _dragging;
        Vector2 _dragOffset;
        Font _font;
        string _mood = "idle";
        string _bubble = "";
        float _bubbleUntil;
        int _port = DefaultPort;

        struct Line
        {
            public bool Mine;
            public string Text;
            public float At;
        }

        public override void OnInitializeMelon()
        {
            LoggerInstance.Msg("LilithAvatar v0.3 启动中…");
            StartServer();
            LoggerInstance.Msg($"控制口 http://127.0.0.1:{_port}/   中继 {RelayUrl}");

            new Thread(() =>
            {
                Thread.Sleep(6000);
                try { AvatarProbe.Dump(); } catch (Exception ex) { LoggerInstance.Warning($"探针失败：{ex.Message}"); }
            }) { IsBackground = true, Name = "LilithAvatar.Probe" }.Start();
        }

        // ── HTTP ─────────────────────────────────────────────────────────
        void StartServer()
        {
            for (int attempt = 0; attempt < 5; attempt++)
            {
                int port = DefaultPort + attempt;
                try
                {
                    var l = new HttpListener();
                    l.Prefixes.Add($"http://127.0.0.1:{port}/");
                    l.Start();
                    _http = l;
                    _port = port;
                    new Thread(Loop) { IsBackground = true, Name = "LilithAvatar.Http" }.Start();
                    return;
                }
                catch { /* 换下一个端口 */ }
            }
            LoggerInstance.Error("HTTP 口起不来，mod 仍可显示（外部控制不可用）");
        }

        void Loop()
        {
            while (_http != null && _http.IsListening)
            {
                HttpListenerContext ctx;
                try { ctx = _http.GetContext(); } catch { break; }
                try { Handle(ctx); } catch (Exception ex) { LoggerInstance.Warning($"请求失败：{ex.Message}"); }
            }
        }

        void Handle(HttpListenerContext ctx)
        {
            string pathName = ctx.Request.Url?.AbsolutePath ?? "/";
            string body = "";
            if (ctx.Request.HasEntityBody)
            {
                using var reader = new System.IO.StreamReader(ctx.Request.InputStream, Encoding.UTF8);
                body = reader.ReadToEnd();
            }

            string response;
            switch (pathName)
            {
                case "/ping":
                    response = $"{{\"ok\":true,\"mod\":\"lilith-avatar\",\"ver\":\"0.3.0\",\"port\":{_port},\"mood\":\"{_mood}\"}}";
                    break;

                case "/say":
                {
                    string text = Field(body, "text");
                    if (string.IsNullOrWhiteSpace(text)) { Reply(ctx, 400, "{\"ok\":false,\"error\":\"text 不能为空\"}"); return; }
                    string emotion = Field(body, "emotion");
                    string action = Field(body, "action");
                    // 只有从「聊聊心情」进来的对话才允许改表情/动作；其它交互下只说话
                    if (!_chatMode) { emotion = ""; action = ""; }
                    int ttl = 8000;
                    if (int.TryParse(Field(body, "ttlMs"), out int t)) ttl = Math.Max(1000, Math.Min(60000, t));

                    string how = RunOnMain(_mainQueue, () => NativeSay(text.Trim(), emotion, action, ttl / 1000f));
                    bool isNative = !how.StartsWith("!");
                    lock (_lock)
                    {
                        _history.Add(new Line { Mine = false, Text = text.Trim(), At = Time.realtimeSinceStartup });
                        if (_history.Count > 200) _history.RemoveRange(0, _history.Count - 200);
                    }
                    if (!isNative)
                    {
                        _bubble = text.Trim();
                        _bubbleUntil = Time.realtimeSinceStartup + ttl / 1000f;
                    }
                    response = $"{{\"ok\":true,\"native\":{(isNative ? "true" : "false")},\"how\":\"{Escape(how)}\"}}";
                    break;
                }

                case "/anim":
                {
                    // 只播动作：给空文本 + 动作类型（LilithActionType: Greet/LazyWave/HappyHop/Clap/...）
                    string name = Field(body, "name");
                    if (string.IsNullOrWhiteSpace(name)) { Reply(ctx, 400, "{\"ok\":false,\"error\":\"name 不能为空\"}"); return; }
                    string how = RunOnMain(_mainQueue, () => NativeSay("", "", name.Trim(), 2.5f));
                    response = $"{{\"ok\":{(!how.StartsWith("!") ? "true" : "false")},\"how\":\"{Escape(how)}\"}}";
                    break;
                }

                case "/emotion":
                {
                    string name = Field(body, "name");
                    if (string.IsNullOrWhiteSpace(name)) { Reply(ctx, 400, "{\"ok\":false,\"error\":\"name 不能为空\"}"); return; }
                    string how = RunOnMain(_mainQueue, () => SetEmotion(name.Trim()));
                    response = $"{{\"ok\":{(!how.StartsWith("!") ? "true" : "false")},\"how\":\"{Escape(how)}\"}}";
                    break;
                }

                case "/dialogue":
                {
                    string text = Field(body, "text");
                    if (string.IsNullOrWhiteSpace(text)) { Reply(ctx, 400, "{\"ok\":false,\"error\":\"text 不能为空\"}"); return; }
                    string how = RunOnMain(_mainQueue, () => NativeDialogue(text.Trim()));
                    response = $"{{\"ok\":{(!how.StartsWith("!") ? "true" : "false")},\"how\":\"{Escape(how)}\"}}";
                    break;
                }

                case "/chatpanel":
                {
                    // 打开游戏**自带**的聊天面板（不是我们画的那层窗口）
                    string how = RunOnMain(_mainQueue, () => OpenChatPanel());
                    response = $"{{\"ok\":{(!how.StartsWith("!") ? "true" : "false")},\"how\":\"{Escape(how)}\"}}";
                    break;
                }

                case "/clickentry":
                {
                    string r2 = RunOnMain(_mainQueue, () => ClickEntry());
                    response = $"{{\"ok\":{(r2 == "clicked" ? "true" : "false")},\"how\":\"{Escape(r2)}\"}}";
                    break;
                }

                case "/scanmenu":
                {
                    string dump = RunOnMain(_mainQueue, () => ScanMenuDump(), 8000);
                    response = "{\"ok\":true,\"dump\":\"" + Escape(dump) + "\"}";
                    break;
                }

                case "/emotions":
                {
                    string dump2 = RunOnMain(_mainQueue, () => EmotionsDump(), 6000);
                    response = "{\"ok\":true,\"dump\":\"" + Escape(dump2) + "\"}";
                    break;
                }

                case "/memo":
                {
                    string mode = Field(body, "mode");
                    string how = RunOnMain(_mainQueue, () => MemoOpen(mode));
                    response = $"{{\"ok\":{(!how.StartsWith("!") ? "true" : "false")},\"how\":\"{Escape(how)}\"}}";
                    break;
                }

                case "/timer":
                {
                    int minutes = 10;
                    if (int.TryParse(Field(body, "minutes"), out int mm)) minutes = Math.Max(1, Math.Min(720, mm));
                    string how = RunOnMain(_mainQueue, () => SetTimer(minutes));
                    response = $"{{\"ok\":{(!how.StartsWith("!") ? "true" : "false")},\"how\":\"{Escape(how)}\"}}";
                    break;
                }

                case "/cancelalarm":
                {
                    string how = RunOnMain(_mainQueue, () => CancelAlarm());
                    response = $"{{\"ok\":{(!how.StartsWith("!") ? "true" : "false")},\"how\":\"{Escape(how)}\"}}";
                    break;
                }

                case "/instances":
                {
                    // 缓存到哪些实例了（补丁抓到的）
                    string how = RunOnMain(_mainQueue, () => InstanceCache.Describe() + " | " + EmotionsDump());
                    response = "{\"ok\":true,\"dump\":\"" + Escape(how) + "\"}";
                    break;
                }

                case "/components":
                {
                    string dump3 = RunOnMain(_mainQueue, () => AvatarPatches.ListMemoish(), 8000);
                    response = "{\"ok\":true,\"dump\":\"" + Escape(dump3) + "\"}";
                    break;
                }

                case "/state":
                {
                    string mood = Field(body, "mood");
                    if (!string.IsNullOrWhiteSpace(mood)) _mood = mood.Trim();
                    response = $"{{\"ok\":true,\"mood\":\"{_mood}\"}}";
                    break;
                }

                case "/events":
                {
                    var items = new List<string>();
                    while (_outbox.TryDequeue(out var one)) items.Add(one);
                    var sb = new StringBuilder("[");
                    for (int i = 0; i < items.Count; i++)
                    {
                        if (i > 0) sb.Append(',');
                        sb.Append('"').Append(Escape(items[i])).Append('"');
                    }
                    sb.Append(']');
                    response = sb.ToString();
                    break;
                }

                case "/dump":
                    new Thread(() => { try { AvatarProbe.Dump(); } catch { } }) { IsBackground = true }.Start();
                    response = "{\"ok\":true,\"note\":\"探针重新运行，几秒后看 dump.txt\"}";
                    break;

                default:
                    Reply(ctx, 404, "{\"ok\":false,\"error\":\"unknown path\"}");
                    return;
            }

            Reply(ctx, 200, response);
        }

        static void Reply(HttpListenerContext ctx, int status, string json)
        {
            try
            {
                byte[] buf = Encoding.UTF8.GetBytes(json);
                ctx.Response.StatusCode = status;
                ctx.Response.ContentType = "application/json; charset=utf-8";
                ctx.Response.ContentLength64 = buf.Length;
                ctx.Response.OutputStream.Write(buf, 0, buf.Length);
                ctx.Response.OutputStream.Close();
            }
            catch { }
        }

        // ── 主线程投递 ───────────────────────────────────────────────────
        public override void OnUpdate()
        {
            while (_mainQueue.TryDequeue(out var job))
            {
                try { job(); } catch (Exception ex) { LoggerInstance.Warning($"主线程任务失败：{ex.Message}"); }
            }
            TickChatEntry();
            AvatarPatches.Tick();
        }

        /// <summary>把一个 Unity 调用丢到主线程执行，等它最多 timeoutMs 毫秒。</summary>
        static string RunOnMain(ConcurrentQueue<Action> queue, Func<string> work, int timeoutMs = 6000)
        {
            string result = null;
            var done = new System.Threading.ManualResetEventSlim(false);
            queue.Enqueue(() =>
            {
                try { result = work(); }
                catch (Exception ex) { result = "!" + (ex.InnerException?.Message ?? ex.Message); }
                finally { done.Set(); }
            });
            return done.Wait(timeoutMs) ? (result ?? "!空结果") : "!主线程超时";
        }

        // ── 游戏原生 API（反射，按实例自己的类型调）────────────────────────
        static Type FindGameType(string name)
        {
            foreach (var a in AppDomain.CurrentDomain.GetAssemblies())
            {
                Type[] ts;
                try { ts = a.GetTypes(); }
                catch (System.Reflection.ReflectionTypeLoadException ex) { ts = ex.Types; }
                catch { continue; }
                foreach (var t in ts)
                    if (t != null && t.Name == name) return t;
            }
            return null;
        }

        static object FindInstance(Type t)
        {
            var all = AvatarProbe.FindAll(t);
            return all != null && all.Length > 0 ? all[0] : null;
        }

        static object CoerceEnum(Type enumType, string value)
        {
            if (!enumType.IsEnum) return value;
            try
            {
                if (!string.IsNullOrWhiteSpace(value)) return Enum.Parse(enumType, value, true);
                return Enum.ToObject(enumType, 0);
            }
            catch { return null; }
        }

        /// <summary>DialogueManager.Say(text, actionType, emotion, duration, lineId, textIsFinal)</summary>
        static string NativeSay(string text, string emotion, string action, float duration)
        {
            var inst = AvatarProbe.FindTyped(FindGameType("DialogueManager"));
            if (inst == null) return "!场景里没有 DialogueManager";
            var useType = inst.GetType();
            string last = "没有可用的 Say/ForceSay 重载";
            foreach (var m in useType.GetMethods())
            {
                if (m.Name != "Say") continue;
                var ps = m.GetParameters();
                if (ps.Length != 6) continue;
                try
                {
                    var args = new object[6];
                    args[0] = text;
                    args[1] = CoerceEnum(ps[1].ParameterType, action);
                    args[2] = emotion ?? "";
                    args[3] = duration;
                    args[4] = 0;
                    args[5] = true;
                    m.Invoke(inst, args);
                    return $"Say(action={args[1]}, emotion='{emotion}', {duration}s)";
                }
                catch (Exception ex) { last = ex.InnerException?.Message ?? ex.Message; }
            }
            foreach (var m in useType.GetMethods())
            {
                if (m.Name != "ForceSay") continue;
                var ps = m.GetParameters();
                if (ps.Length != 3) continue;
                try
                {
                    m.Invoke(inst, new object[] { text, emotion ?? "", duration });
                    return $"ForceSay('{emotion}', {duration}s)";
                }
                catch (Exception ex) { last = ex.InnerException?.Message ?? ex.Message; }
            }
            int sayCount = 0;
            foreach (var m in useType.GetMethods()) if (m.Name == "Say") sayCount++;
            return "!" + last + " [type=" + useType.FullName + ", sayOverloads=" + sayCount + "]";
        }

        static object FindEmotionController()
        {
            var t = FindGameType("LilithEmotionController");
            if (t == null) return null;
            var inst = FindInstance(t);
            if (inst != null) return inst;
            // 1) 从角色身上 GetComponent（最常见：就在 Lilith 这个物体上）
            try
            {
                var skel = AvatarProbe.FindTyped(FindGameType("SkeletonAnimation")) as Component;
                if (skel != null)
                {
                    var c = skel.gameObject.GetComponent(Il2CppInterop.Runtime.Il2CppType.From(t));
                    if (c != null) return AvatarProbe.TryCastTo(c, t) ?? c;
                    // 2) 子物体里找
                    var kids = skel.gameObject.GetComponentsInChildren(Il2CppInterop.Runtime.Il2CppType.From(t), true);
                    if (kids != null && kids.Length > 0) return AvatarProbe.TryCastTo(kids[0], t) ?? kids[0];
                    // 3) 父物体里找
                    var cur = skel.transform.parent;
                    for (int i = 0; i < 4 && cur != null; i++)
                    {
                        var pc = cur.gameObject.GetComponent(Il2CppInterop.Runtime.Il2CppType.From(t));
                        if (pc != null) return AvatarProbe.TryCastTo(pc, t) ?? pc;
                        cur = cur.parent;
                    }
                }
            }
            catch { }
            // 4) 连未激活的对象一起找
            try
            {
                var any = UnityEngine.Resources.FindObjectsOfTypeAll(Il2CppInterop.Runtime.Il2CppType.From(t));
                if (any != null && any.Length > 0) return AvatarProbe.TryCastTo(any[0], t) ?? any[0];
            }
            catch { }
            return null;
        }

        /// <summary>把 DriftEmotions 里的合法情绪名列出来（表情映射的白名单）。</summary>
        static string EmotionsDump()
        {
            var inst = FindEmotionController() ?? InstanceCache.Emotion;
            if (inst == null) { var sk = AvatarProbe.FindTyped(FindGameType("SkeletonAnimation")) as Component; return "!找不到 LilithEmotionController 实例（骨架物体=" + (sk != null ? sk.gameObject.name : "?") + "）"; }
            var arr = AvatarProbe.GetProp(inst, "DriftEmotions");
            var names = new List<string>();
            if (arr is System.Collections.IEnumerable en)
                foreach (var x in en) names.Add(x?.ToString() ?? "");
            var active = AvatarProbe.GetProp(inst, "IsEmotionActive");
            return $"drift({names.Count})={string.Join(",", names)} active={active}";
        }

        /// <summary>打开她自己的记事本面板（MemoPanels.Open）。mode 为空则用默认页。</summary>
        /// <summary>
        /// System.DateTime → Il2CppSystem.DateTime。
        /// 直接用 System.DateTime 会报 "cannot be converted to Il2CppSystem.DateTime"，
        /// 这里按运行时反射找 FromDateTime / op_Implicit / (long ticks) 构造。
        /// </summary>
        static object ToIl2CppDateTime(DateTime dt)
        {
            try
            {
                Type t = null;
                foreach (var a in AppDomain.CurrentDomain.GetAssemblies())
                {
                    try { t = a.GetType("Il2CppSystem.DateTime", false); } catch { }
                    if (t != null) break;
                }
                if (t == null) return dt;
                foreach (var m in t.GetMethods(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static))
                {
                    if (m.Name != "FromDateTime" && m.Name != "op_Implicit") continue;
                    var ps = m.GetParameters();
                    if (ps.Length != 1 || ps[0].ParameterType != typeof(DateTime)) continue;
                    try { return m.Invoke(null, new object[] { dt }); } catch { }
                }
                foreach (var c in t.GetConstructors())
                {
                    var ps = c.GetParameters();
                    if (ps.Length == 1 && ps[0].ParameterType == typeof(long))
                    {
                        try { return c.Invoke(new object[] { dt.Ticks }); } catch { }
                    }
                }
            }
            catch { }
            return dt;
        }

        /// <summary>FindTyped 不够深时，连未激活对象一起找。</summary>
        static object FindTypedDeep(Type t)
        {
            if (t == null) return null;
            var inst = AvatarProbe.FindTyped(t) ?? FindInstance(t);
            if (inst != null) return inst;
            try
            {
                var any = UnityEngine.Resources.FindObjectsOfTypeAll(Il2CppInterop.Runtime.Il2CppType.From(t));
                if (any != null && any.Length > 0) return AvatarProbe.TryCastTo(any[0], t) ?? any[0];
            }
            catch { }
            return null;
        }

        static string MemoOpen(string mode)
        {
            var t = FindGameType("MemoPanels");
            if (t == null) return "!找不到 MemoPanels";
            var inst = FindTypedDeep(t) ?? InstanceCache.MemoPanels;
            if (inst == null)
            {
                // 面板是懒创建的：先叫出她的菜单，再找一次
                try { OpenChatPanel(); } catch { }
                inst = FindTypedDeep(t);
            }
            if (inst == null) return "!场景里没有 MemoPanels";
            foreach (var m in inst.GetType().GetMethods())
            {
                if (m.Name != "Open") continue;
                var ps = m.GetParameters();
                if (ps.Length != 2) continue;
                try
                {
                    m.Invoke(inst, new object[] { CoerceEnum(ps[0].ParameterType, mode), 0 });
                    return $"MemoPanels.Open({mode})";
                }
                catch (Exception ex) { return "!" + (ex.InnerException?.Message ?? ex.Message); }
            }
            return "!没找到 Open(mode, focusId)";
        }

        /// <summary>设一个闹钟/计时（AlarmSystem.SetAlarm）。</summary>
        static string SetTimer(int minutes)
        {
            var t = FindGameType("AlarmSystem");
            if (t == null) return "!找不到 AlarmSystem";
            var inst = AvatarProbe.FindTyped(t) ?? FindInstance(t);
            if (inst == null) return "!场景里没有 AlarmSystem";
            var when = DateTime.Now.AddMinutes(minutes);
            foreach (var m in inst.GetType().GetMethods())
            {
                if (m.Name != "SetAlarm") continue;
                if (m.GetParameters().Length != 1) continue;
                try
                {
                    m.Invoke(inst, new object[] { ToIl2CppDateTime(when) });
                    return $"SetAlarm({when:HH:mm}, +{minutes}min)";
                }
                catch (Exception ex) { return "!" + (ex.InnerException?.Message ?? ex.Message); }
            }
            return "!没找到 SetAlarm(DateTime)";
        }

        static string CancelAlarm()
        {
            var t = FindGameType("AlarmSystem");
            var inst = t != null ? (AvatarProbe.FindTyped(t) ?? FindInstance(t)) : null;
            if (inst == null) return "!场景里没有 AlarmSystem";
            foreach (var m in inst.GetType().GetMethods())
            {
                if (m.Name != "CancelAlarm" || m.GetParameters().Length != 0) continue;
                try { m.Invoke(inst, null); return "CancelAlarm()"; }
                catch (Exception ex) { return "!" + (ex.InnerException?.Message ?? ex.Message); }
            }
            return "!没找到 CancelAlarm()";
        }

        static string SetEmotion(string name)
        {
            var inst = FindEmotionController();
            if (inst == null) return "!场景里没有 LilithEmotionController";
            foreach (var m in inst.GetType().GetMethods())
            {
                if (m.Name != "Play") continue;
                if (m.GetParameters().Length != 4) continue;
                try
                {
                    m.Invoke(inst, new object[] { name, true, true, false });
                    return $"Play({name})";
                }
                catch (Exception ex) { return "!" + (ex.InnerException?.Message ?? ex.Message); }
            }
            return "!Play(emotion, loop, markActive, instant) 没找到";
        }

        /// <summary>打开游戏自带聊天面板（CharacterInteractionHandler.OpenChatPanel）。</summary>
        static string OpenChatPanel()
        {
            var inst = AvatarProbe.FindTyped(FindGameType("CharacterInteractionHandler"));
            if (inst == null) return "!场景里没有 CharacterInteractionHandler";
            var useType = inst.GetType();
            foreach (var m in useType.GetMethods())
            {
                if (m.Name != "OpenChatPanel") continue;
                if (m.GetParameters().Length != 0) continue;
                try { m.Invoke(inst, null); return "OpenChatPanel()"; }
                catch (Exception ex) { return "!" + (ex.InnerException?.Message ?? ex.Message); }
            }
            // 退一步：只是进入键盘输入模式
            var win = AvatarProbe.FindTyped(FindGameType("TransparentWindowNew"));
            if (win != null)
            {
                foreach (var m in win.GetType().GetMethods())
                {
                    if (m.Name != "BeginKeyboardInput" || m.GetParameters().Length != 0) continue;
                    try { m.Invoke(win, null); return "BeginKeyboardInput()"; } catch { }
                }
            }
            return "!没有找到打开聊天面板的方法";
        }

        static string NativeDialogue(string text)
        {
            var inst = FindInstance(FindGameType("DialogueManager"));
            if (inst == null) return "!场景里没有 DialogueManager";
            var useType = inst.GetType();
            foreach (var name in new[] { "StartDialogueNodeByInput", "StartDialogueOneShot", "StartDialogue", "HandleHookChatRequest" })
                foreach (var m in useType.GetMethods())
                {
                    if (m.Name != name) continue;
                    var ps = m.GetParameters();
                    if (ps.Length != 1 || ps[0].ParameterType != typeof(string)) continue;
                    try { m.Invoke(inst, new object[] { text }); return $"{name}(text)"; }
                    catch { }
                }
            return "!没有匹配的对话入口";
        }

        // ── UI ───────────────────────────────────────────────────────────
        public override void OnGUI()
        {
            EnsureFont();

            if (!string.IsNullOrEmpty(_bubble) && Time.realtimeSinceStartup < _bubbleUntil)
            {
                var style = new GUIStyle(GUI.skin.label)
                {
                    alignment = TextAnchor.MiddleCenter,
                    fontSize = 16,
                    wordWrap = true,
                    normal = { textColor = Color.white }
                };
                float w = Mathf.Min(Screen.width * 0.6f, 620f);
                var rect = new Rect((Screen.width - w) / 2f, 24f, w, 64f);
                GUI.color = new Color(0f, 0f, 0f, 0.55f);
                GUI.DrawTexture(rect, Texture2D.whiteTexture);
                GUI.color = Color.white;
                GUI.Label(new Rect(rect.x + 12, rect.y + 8, rect.width - 24, rect.height - 16), _bubble, style);
            }

            var e = Event.current;
            if (e != null && e.type == EventType.KeyDown && e.keyCode == KeyCode.F8) { _visible = !_visible; if (!_visible) { ExitChat(); RestoreClickThrough(); } e.Use(); }
            if (!_visible) return;

            DrawChatWindow();
        }

        void EnsureFont()
        {
            if (_font != null) return;
            try
            {
                _font = Font.CreateDynamicFontFromOSFont(new[] { "Microsoft YaHei", "微软雅黑", "SimHei", "Arial" }, 14);
                if (_font != null) GUI.skin.font = _font;
            }
            catch { }
        }

        void DrawChatWindow()
        {
            var rect = new Rect(_winPos.x, _winPos.y, 400f, 340f);
            TickClickThrough(rect);   // 旧方案：改 clickThrough（保留兜底）
            TickHitArea(rect);        // 新方案：给面板挂 collider，让 raycast 命中
            GUI.color = new Color(0.06f, 0.07f, 0.09f, 0.92f);
            GUI.DrawTexture(rect, Texture2D.whiteTexture);
            GUI.color = Color.white;

            var bar = new Rect(rect.x, rect.y, rect.width, 26f);
            GUI.color = new Color(0.12f, 0.14f, 0.18f, 1f);
            GUI.DrawTexture(bar, Texture2D.whiteTexture);
            GUI.color = Color.white;
            GUI.Label(new Rect(bar.x + 8, bar.y + 4, 260, 20), $"鲟鱼 · 对话（{_mood}）  F8 隐藏");
            GUI.Label(new Rect(rect.xMax - 26, bar.y + 4, 20, 20), "×");

            if (Event.current.type == EventType.MouseDown && bar.Contains(Event.current.mousePosition))
            {
                if (Event.current.mousePosition.x > rect.xMax - 26) { _visible = false; ExitChat(); RestoreClickThrough(); }
                else { _dragging = true; _dragOffset = Event.current.mousePosition - _winPos; }
                Event.current.Use();
            }
            if (_dragging)
            {
                if (Event.current.type == EventType.MouseDrag) { _winPos = Event.current.mousePosition - _dragOffset; Event.current.Use(); }
                if (Event.current.type == EventType.MouseUp) _dragging = false;
            }

            var bodyRect = new Rect(rect.x + 8, bar.yMax + 6, rect.width - 16, rect.height - 26 - 6 - 34);
            GUI.BeginGroup(bodyRect);
            _scroll = GUI.BeginScrollView(new Rect(0, 0, bodyRect.width, bodyRect.height), _scroll,
                new Rect(0, 0, bodyRect.width - 18, Mathf.Max(bodyRect.height, HistoryHeight(bodyRect.width - 18))));
            float y = 2f;
            lock (_lock)
            {
                foreach (var line in _history)
                {
                    var style = new GUIStyle(GUI.skin.label) { wordWrap = true, fontSize = 13 };
                    style.normal.textColor = line.Mine ? new Color(0.75f, 0.88f, 1f) : new Color(1f, 1f, 1f, 0.92f);
                    float h = style.CalcHeight(new GUIContent(line.Text), bodyRect.width - 24);
                    GUI.Label(new Rect(line.Mine ? 26 : 6, y, bodyRect.width - 30, h), line.Text, style);
                    y += h + 6f;
                }
            }
            GUI.EndScrollView();
            GUI.EndGroup();

            // 点面板任意处就把焦点交给输入框，省得再点一次
            if (Event.current.type == EventType.MouseDown && rect.Contains(Event.current.mousePosition)) GUI.FocusControl("avatar_input");
            var inputRect = new Rect(rect.x + 8, rect.yMax - 32, rect.width - 76, 24);
            GUI.SetNextControlName("avatar_input");
            if (_focusPending) { GUI.FocusControl("avatar_input"); _focusPending = false; }
            _input = GUI.TextField(inputRect, _input ?? "");
            bool send = GUI.Button(new Rect(rect.xMax - 64, rect.yMax - 32, 56, 24), "发送");

            var ev = Event.current;
            bool enter = ev.type == EventType.KeyDown && (ev.keyCode == KeyCode.Return || ev.keyCode == KeyCode.KeypadEnter)
                         && GUI.GetNameOfFocusedControl() == "avatar_input";
            if (enter) { ev.Use(); send = true; }
            if (send && !string.IsNullOrWhiteSpace(_input)) SendToRelay(_input.Trim());
        }

        float HistoryHeight(float width)
        {
            float h = 4f;
            lock (_lock)
            {
                var style = new GUIStyle(GUI.skin.label) { wordWrap = true, fontSize = 13 };
                foreach (var line in _history) h += style.CalcHeight(new GUIContent(line.Text), width - 24) + 6f;
            }
            return h;
        }

        void SendToRelay(string text)
        {
            _input = "";
            lock (_lock)
            {
                _history.Add(new Line { Mine = true, Text = text, At = Time.realtimeSinceStartup });
                if (_history.Count > 200) _history.RemoveRange(0, _history.Count - 200);
            }
            _outbox.Enqueue(text);
            string payload = "{\"text\":\"" + Escape(text) + "\"}";
            _ = System.Threading.Tasks.Task.Run(async () =>
            {
                try
                {
                    var resp = await Client.PostAsync(RelayUrl.TrimEnd('/') + "/chat",
                        new StringContent(payload, Encoding.UTF8, "application/json"));
                    if (!resp.IsSuccessStatusCode)
                        lock (_lock) { _history.Add(new Line { Text = $"[中继 {resp.StatusCode}] 消息没送出去", At = Time.realtimeSinceStartup }); }
                }
                catch (Exception ex)
                {
                    lock (_lock) { _history.Add(new Line { Text = $"[中继不可用] {ex.GetType().Name}：先跑 relay.mjs", At = Time.realtimeSinceStartup }); }
                }
            });
        }

        // ── 极简 JSON ────────────────────────────────────────────────────
        static string Field(string json, string name)
        {
            if (string.IsNullOrEmpty(json)) return "";
            string key = "\"" + name + "\"";
            int i = json.IndexOf(key, StringComparison.Ordinal);
            if (i < 0) return "";
            i = json.IndexOf(':', i + key.Length);
            if (i < 0) return "";
            i++;
            while (i < json.Length && char.IsWhiteSpace(json[i])) i++;
            if (i >= json.Length) return "";
            if (json[i] != '"')
            {
                // 数字/布尔：读到分隔符为止（之前只认字符串，"minutes": 25 会被当成空）
                int st = i;
                while (i < json.Length && json[i] != ',' && json[i] != '}' && json[i] != ']') i++;
                return json.Substring(st, i - st).Trim();
            }
            i++;
            var sb = new StringBuilder();
            while (i < json.Length)
            {
                char c = json[i];
                if (c == '\\' && i + 1 < json.Length)
                {
                    char n = json[i + 1];
                    switch (n)
                    {
                        case 'n': sb.Append('\n'); break;
                        case 'r': sb.Append('\r'); break;
                        case 't': sb.Append('\t'); break;
                        case '"': sb.Append('"'); break;
                        case '\\': sb.Append('\\'); break;
                        case 'u':
                            if (i + 5 < json.Length && int.TryParse(json.Substring(i + 2, 4),
                                System.Globalization.NumberStyles.HexNumber, null, out int code))
                                sb.Append((char)code);
                            i += 4;
                            break;
                        default: sb.Append(n); break;
                    }
                    i += 2;
                    continue;
                }
                if (c == '"') break;
                sb.Append(c);
                i++;
            }
            return sb.ToString();
        }

        static string Escape(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            var sb = new StringBuilder(s.Length + 8);
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            return sb.ToString();
        }

        public override void OnApplicationQuit()
        {
            try { _http?.Stop(); } catch { }
        }
    }
}
