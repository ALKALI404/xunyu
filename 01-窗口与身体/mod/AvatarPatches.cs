// AvatarPatches —— 用 Harmony 在对象创建的那一刻把实例"抓"下来。
//
// 为什么需要：MemoPanels（记事本面板）和 LilithEmotionController（表情控制器）都是懒创建的，
// 场景里搜不到（连 Resources.FindObjectsOfTypeAll 也不行），但它们的 Awake/Start 一定会跑。
// 挂一个 prefix 把 __instance 存下来，之后就能正常调用。
//
// 注意：IL2CPP 下 Harmony 的补丁方法用 object __instance 接实例是标准做法；
// 类型判断靠 GetType().Name，避免在编译期依赖游戏类型。
using System;
using System.Reflection;
using HarmonyLib;
using MelonLoader;
using UnityEngine;

namespace LilithAvatar
{
    public static class InstanceCache
    {
        public static object MemoPanels;
        public static object QuickCapture;
        public static object MemoView;
        public static object Emotion;
        public static int Hits;

        public static string Describe()
        {
            return $"memo={(MemoPanels != null ? "ok" : "null")} emotion={(Emotion != null ? "ok" : "null")} hits={Hits}";
        }
    }

    public static class AvatarPatches
    {
        static int _tick;
        static bool _loggedMemo;

        /// <summary>
        /// 轮询监视：这两个对象都是"用的时候才创建"，创建之后就一直存在。
        /// 每 60 帧找一次，找到就缓存；比 Harmony 稳（它们的 Awake 不在代理类型上暴露）。
        /// </summary>
        public static void Tick()
        {
            try
            {
                _tick++;
                if (_tick % 60 != 0) return;
                Watch("MemoPanels", v => InstanceCache.MemoPanels = v);
                Watch("MemoQuickCapture", v => InstanceCache.QuickCapture = v);
                Watch("MemoView", v => InstanceCache.MemoView = v);
                Watch("LilithEmotionController", v => InstanceCache.Emotion = v);
            }
            catch { }
        }

        static void Watch(string typeName, Action<object> store)
        {
            var t = FindType(typeName);
            if (t == null) return;
            var inst = FindTyped(t);
            if (inst == null) return;
            store(inst);
            MelonLogger.Msg($"[watch] 捕获到 {typeName}");
        }

        /// <summary>诊断：列出场景里所有类名含 Memo/Emotion 的组件（含所在物体名）。</summary>
        public static string ListMemoish()
        {
            var sb = new System.Text.StringBuilder();
            try
            {
                var all = UnityEngine.Object.FindObjectsOfType(Il2CppInterop.Runtime.Il2CppType.From(FindType("Component")));
                if (all == null) all = UnityEngine.Resources.FindObjectsOfTypeAll(Il2CppInterop.Runtime.Il2CppType.From(FindType("Component")));
                var seen = new System.Collections.Generic.Dictionary<string, int>();
                foreach (var o in all ?? Array.Empty<UnityEngine.Object>())
                {
                    var c = o as Component;
                    var n = c?.GetType().Name ?? "?";
                    if (n.IndexOf("Memo", StringComparison.OrdinalIgnoreCase) < 0
                        && n.IndexOf("Emotion", StringComparison.OrdinalIgnoreCase) < 0) continue;
                    var key = n + " @ " + (c?.gameObject?.name ?? "?");
                    seen[key] = seen.TryGetValue(key, out var v) ? v + 1 : 1;
                }
                sb.AppendLine($"匹配组件 {seen.Count} 种：");
                foreach (var kv in seen) sb.AppendLine($"  {kv.Key} ×{kv.Value}");
            }
            catch (Exception ex) { sb.AppendLine("失败: " + ex.Message); }
            return sb.ToString();
        }

        static object FindTyped(Type t)
        {
            try
            {
                var any = UnityEngine.Object.FindObjectsOfType(Il2CppInterop.Runtime.Il2CppType.From(t));
                if (any != null && any.Length > 0) return any[0];
                var all = UnityEngine.Resources.FindObjectsOfTypeAll(Il2CppInterop.Runtime.Il2CppType.From(t));
                if (all != null && all.Length > 0) return all[0];
            }
            catch { }
            return null;
        }

        static int PatchLifecycle(HarmonyLib.Harmony harmony, string typeName)
        {
            var t = FindType(typeName);
            if (t == null) { MelonLogger.Warning($"[patches] 找不到类型 {typeName}"); return 0; }
            var prefix = new HarmonyMethod(typeof(AvatarPatches).GetMethod(nameof(Capture), BindingFlags.Public | BindingFlags.Static));
            int n = 0;
            foreach (var name in new[] { "Awake", "Start", "OnEnable" })
            {
                var m = t.GetMethod(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance, null, Type.EmptyTypes, null);
                if (m == null) continue;
                try { harmony.Patch(m, prefix); n++; }
                catch (Exception ex) { MelonLogger.Warning($"[patches] {typeName}.{name} 挂载失败：{ex.Message}"); }
            }
            return n > 0 ? 1 : 0;
        }

        /// <summary>Harmony 注入的 prefix：拿到实例就按类型名存起来。</summary>
        public static void Capture(object __instance)
        {
            try
            {
                if (__instance == null) return;
                var name = __instance.GetType().Name;
                if (name.Contains("MemoPanels")) { InstanceCache.MemoPanels = __instance; InstanceCache.Hits++; }
                else if (name.Contains("EmotionController")) { InstanceCache.Emotion = __instance; InstanceCache.Hits++; }
            }
            catch { }
        }

        static Type FindType(string name)
        {
            foreach (var a in AppDomain.CurrentDomain.GetAssemblies())
            {
                Type[] ts;
                try { ts = a.GetTypes(); }
                catch (ReflectionTypeLoadException ex) { ts = ex.Types; }
                catch { continue; }
                foreach (var t in ts)
                    if (t != null && t.Name == name) return t;
            }
            return null;
        }
    }
}
