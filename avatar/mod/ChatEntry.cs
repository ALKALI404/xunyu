// ChatEntry —— 把游戏菜单里的「聊聊心情」接管成我们自己的对话页。
//
// 做法：运行时扫描菜单里的按钮，读到标签是「聊聊心情」就把它的 onClick 换成打开对话页。
// 只动这一个按钮，其它选项（点心时间/记点东西/放点音乐…）完全不受影响。
//
// 坑（踩过两次）：
//   · IL2CPP 里 FindObjectsOfType 拿到的都是 UnityEngine.Object 基类代理，
//     必须 TryCast 到**运行时真实类型**（TextMeshProUGUI，而不是基类 TMP_Text）才能读到 text；
//   · 标签读不到时退化为按菜单位置绑定（第 3 项），保证入口一定能点开。
using System;
using System.Collections.Generic;
using System.Linq;
using MelonLoader;
using UnityEngine;

namespace LilithAvatar
{
    public partial class AvatarMain
    {
        const string ChatEntryLabel = "聊聊心情";

        bool _chatMode;
        bool _entryBound;
        bool _focusPending;
        int _scanTicks;
        UnityEngine.UI.Button _chatButton;

        public bool ChatMode => _chatMode;

        // ── 每帧调用（由 AvatarCore.OnUpdate 调）───────────────────────────
        void TickChatEntry()
        {
            if (_entryBound) return;
            _scanTicks++;
            if (_scanTicks % 90 != 0) return; // 约 1.5 秒扫一次
            try { ScanForChatEntry(); }
            catch (Exception ex) { LoggerInstance.Warning($"扫菜单失败：{ex.Message}"); }
        }

        static string TextOf(Component c)
        {
            try
            {
                foreach (var typeName in new[] { "TextMeshProUGUI", "TMP_Text", "Text" })
                {
                    var t = FindGameType(typeName);
                    if (t == null) continue;
                    var typed = AvatarProbe.TryCastTo(c, t);
                    if (typed == null) continue;
                    var text = AvatarProbe.GetProp(typed, "text");
                    if (text != null && !string.IsNullOrEmpty(text.ToString())) return text.ToString();
                    var field = AvatarProbe.GetField(typed, "m_text");
                    if (field != null && !string.IsNullOrEmpty(field.ToString())) return field.ToString();
                }
            }
            catch { }
            return "";
        }

        /// <summary>场景里所有按钮，按屏幕 Y 从上到下排好（菜单就是竖着排的）。</summary>
        static List<Component> OrderedButtons(Type btnType)
        {
            var list = new List<Component>();
            var all = AvatarProbe.FindAll(btnType);
            if (all == null) return list;
            foreach (var o in all)
            {
                if (!(o is Component comp)) continue;
                var typed = AvatarProbe.TryCastTo(comp, btnType) as Component;
                if (typed != null) list.Add(typed);
            }
            return list.OrderByDescending(c => c.transform.position.y).ToList();
        }

        void ScanForChatEntry()
        {
            var btnType = FindGameType("Button");
            if (btnType == null) return;
            var buttons = OrderedButtons(btnType);
            if (buttons.Count == 0) return;

            // ① 先按标签找（最准）
            foreach (var btn in buttons)
            {
                var go = btn.gameObject;
                string label = "";
                var textType = FindGameType("TextMeshProUGUI") ?? FindGameType("TMP_Text") ?? FindGameType("Text");
                if (textType != null && go != null)
                {
                    try
                    {
                        var comps = go.GetComponentsInChildren(Il2CppInterop.Runtime.Il2CppType.From(textType), true);
                        if (comps != null) label = string.Concat(comps.Select(c => TextOf(c as Component)));
                    }
                    catch { }
                }
                if (!string.IsNullOrEmpty(label) && label.Contains(ChatEntryLabel))
                {
                    if (Bind(btn)) { _entryBound = true; LoggerInstance.Msg($"按标签接管「{ChatEntryLabel}」"); }
                    return;
                }
            }

            // ② 标签读不出来 → 按菜单顺序：第 3 项就是「聊聊心情」（按钮数 ≥5 才启用，避免误伤）
            if (buttons.Count >= 5)
            {
                if (Bind(buttons[2]))
                {
                    _entryBound = true;
                    LoggerInstance.Msg($"按位置接管「{ChatEntryLabel}」（菜单第 3 项，共 {buttons.Count} 个按钮）");
                }
            }
        }

        bool Bind(Component comp)
        {
            try
            {
                var btn = comp as UnityEngine.UI.Button
                          ?? AvatarProbe.TryCastTo(comp, FindGameType("Button")) as UnityEngine.UI.Button;
                if (btn == null) { LoggerInstance.Warning("拿不到 Button 代理"); return false; }
                btn.onClick.RemoveAllListeners();
                var callback = new Action(() =>
                {
                    try { EnterChat(); } catch (Exception ex) { LoggerInstance.Warning($"进入对话页失败：{ex.Message}"); }
                });
                var unityAction = Il2CppInterop.Runtime.DelegateSupport.ConvertDelegate<UnityEngine.Events.UnityAction>(callback);
                btn.onClick.AddListener(unityAction);
                _chatButton = btn;
                return true;
            }
            catch (Exception ex)
            {
                LoggerInstance.Warning($"接管按钮失败：{ex.Message}");
                return false;
            }
        }

        /// <summary>调试用：等价于点一下那个按钮。</summary>
        public string ClickEntry()
        {
            if (_chatButton == null) return "!还没有接管到按钮";
            try { _chatButton.onClick.Invoke(); return "clicked"; }
            catch (Exception ex) { return "!" + ex.Message; }
        }

        /// <summary>诊断：把菜单按钮的标签列出来。</summary>
        public static string ScanMenuDump()
        {
            var sb = new System.Text.StringBuilder();
            try
            {
                var btnType = FindGameType("Button");
                if (btnType == null) return "!找不到 Button";
                var buttons = OrderedButtons(btnType);
                sb.AppendLine($"Button 实例 {buttons.Count}");
                int i = 0;
                foreach (var b in buttons)
                {
                    var go = b.gameObject;
                    var label = "";
                    var tt = FindGameType("TextMeshProUGUI") ?? FindGameType("TMP_Text") ?? FindGameType("Text");
                    if (tt != null && go != null)
                    {
                        try
                        {
                            var comps = go.GetComponentsInChildren(Il2CppInterop.Runtime.Il2CppType.From(tt), true);
                            if (comps != null) label = string.Concat(comps.Select(c => TextOf(c as Component)));
                        }
                        catch { }
                    }
                    sb.AppendLine($"  [{i++}] y={b.transform.position.y:F0} go={go?.name} label=\"{label}\"");
                    if (i > 30) break;
                }
            }
            catch (Exception ex) { sb.AppendLine("失败: " + ex.Message); }
            return sb.ToString();
        }

        /// <summary>从「聊聊心情」进来：打开我们的对话页，并允许表情/动作映射。</summary>
        void EnterChat()
        {
            _chatMode = true;
            _visible = true;
            _focusPending = true;
            _bubble = "";
            LoggerInstance.Msg("进入对话模式（表情/动作由对话驱动）");
            try { NativeSay("嗯？我在。", "", "Greet", 3f); } catch { }
            try { EnsureWindow(); InvokeWindowMethod("BeginKeyboardInput"); } catch { }
        }

        /// <summary>关掉对话页就退出对话模式，之后不再用对话的情绪覆盖她的表情。</summary>
        void ExitChat()
        {
            if (!_chatMode) return;
            _chatMode = false;
            try { InvokeWindowMethod("EndKeyboardInput"); } catch { }
            RestoreClickThrough();
            LoggerInstance.Msg("退出对话模式");
        }

        // ── 点击穿透：给面板区域挂一个 collider，让游戏的 raycast 命中它 ──────
        // 游戏用 HitTestByRaycast 决定"这一点收不收鼠标"，没有 collider 就穿透。
        // 直接改 clickThrough 属性没用（实测被每帧重算覆盖），所以补一个碰撞体。
        GameObject _hitGo;

        void EnsureHitArea()
        {
            if (_hitGo != null) return;
            var colType = FindGameType("BoxCollider2D");
            if (colType == null) { LoggerInstance.Warning("找不到 BoxCollider2D"); return; }
            try
            {
                _hitGo = new GameObject("DSH_AvatarHit");
                UnityEngine.Object.DontDestroyOnLoad(_hitGo);
                var col = _hitGo.AddComponent(Il2CppInterop.Runtime.Il2CppType.From(colType));
                SetProp(col, "isTrigger", true);
                _hitGo.layer = PickHitLayer();
                LoggerInstance.Msg($"面板命中区已建立（layer={_hitGo.layer}）");
            }
            catch (Exception ex)
            {
                LoggerInstance.Warning($"建立命中区失败：{ex.Message}");
                _hitGo = null;
            }
        }

        static void SetProp(object o, string name, object value)
        {
            try { o?.GetType().GetProperty(name)?.SetValue(o, value); } catch { }
        }

        /// <summary>挑一个 hitTestLayerMask 里有的层，没有就用 Default(0)。</summary>
        int PickHitLayer()
        {
            EnsureWindow();
            int mask = 0;
            try
            {
                var v = _win?.GetType().GetProperty("hitTestLayerMask")?.GetValue(_win);
                if (v != null) mask = Convert.ToInt32(v);
            }
            catch { }
            if (mask == 0) return 0;
            for (int i = 0; i < 32; i++)
                if ((mask & (1 << i)) != 0) return i;
            return 0;
        }

        /// <summary>每帧把命中区对齐到面板矩形（GUI 坐标 → 世界坐标）。</summary>
        public void TickHitArea(Rect guiRect)
        {
            if (!_visible) { if (_hitGo != null && _hitGo.activeSelf) _hitGo.SetActive(false); return; }
            EnsureHitArea();
            if (_hitGo == null) return;
            if (!_hitGo.activeSelf) _hitGo.SetActive(true);

            var cam = Camera.main;
            if (cam == null) return;
            try
            {
                var screenPoint = new Vector3(guiRect.center.x, Screen.height - guiRect.center.y, 10f);
                var world = cam.ScreenToWorldPoint(screenPoint);
                _hitGo.transform.position = new Vector3(world.x, world.y, 0f);

                float worldHeight = cam.orthographic
                    ? cam.orthographicSize * 2f
                    : 2f * Mathf.Tan(cam.fieldOfView * 0.5f * Mathf.Deg2Rad) * Mathf.Abs(world.z - cam.transform.position.z);
                float perPx = worldHeight / Mathf.Max(1, Screen.height);
                var col = _hitGo.GetComponent(Il2CppInterop.Runtime.Il2CppType.From(FindGameType("BoxCollider2D")));
                SetProp(col, "size", new Vector2(guiRect.width * perPx, guiRect.height * perPx));
            }
            catch { }
        }

        // ── 点击穿透（旧方案，保留作为退出时的兜底）──────────────────────────
        object _win;
        bool _overPanel;
        bool _clickThroughOverridden;

        void EnsureWindow()
        {
            if (_win != null) return;
            _win = AvatarProbe.FindTyped(FindGameType("TransparentWindowNew"));
        }

        void InvokeWindowMethod(string name)
        {
            EnsureWindow();
            if (_win == null) return;
            foreach (var m in _win.GetType().GetMethods())
            {
                if (m.Name != name || m.GetParameters().Length != 0) continue;
                try { m.Invoke(_win, null); } catch { }
                return;
            }
        }

        /// <summary>
        /// 游戏用 HitTestByRaycast + clickThrough 决定"这一点收不收鼠标"，
        /// 面板没有 collider 就会被穿透。这里在**面板矩形内**把它关掉，
        /// 离开矩形立刻恢复，桌面其它地方照常点得到。
        /// </summary>
        public void TickClickThrough(Rect guiRect)
        {
            if (!_visible) return;   // 只要面板可见就收鼠标（不依赖对话模式，避免被按钮绑定卡住）
            EnsureWindow();
            if (_win == null) return;
            var mp = Input.mousePosition;
            var gui = new Vector2(mp.x, Screen.height - mp.y);
            bool over = guiRect.Contains(gui);
            // 游戏每帧都会按 raycast 重算 clickThrough，所以这里必须每帧覆盖，
            // 只在"离开面板"时补写一次即可（避免每帧都调 setter）。
            if (!over && _overPanel && _clickThroughOverridden) { _overPanel = false; RestoreClickThrough(); return; }
            _overPanel = over;
            if (!over) return;
            try
            {
                var prop = _win.GetType().GetProperty("clickThrough");
                if (prop != null && prop.CanWrite)
                {
                    prop.SetValue(_win, !over);
                    _clickThroughOverridden = true;
                }
            }
            catch { }
        }

        void RestoreClickThrough()
        {
            if (!_clickThroughOverridden) return;
            try
            {
                EnsureWindow();
                _win?.GetType().GetProperty("clickThrough")?.SetValue(_win, true);
            }
            catch { }
            _clickThroughOverridden = false;
            _overPanel = false;
        }
    }
}
