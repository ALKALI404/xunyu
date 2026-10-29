// AvatarProbe —— 把游戏自己的对话/情绪/动画 API 探出来（结果写到 avatar\dump.txt）。
//
// 为什么用反射而不是硬编码：IL2CPP 的方法签名只有运行时才准，猜一个错一个。
// 探针只读不写，跑一次就够，之后按 dump 里的真名去接 /anim、/emotion、/chat。
using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using MelonLoader;
using UnityEngine;

namespace LilithAvatar
{
    public static class AvatarProbe
    {
        public const string DumpPath = @"E:\DeepFish\avatar\dump.txt";

        static readonly string[] Interesting =
        {
            "DialogueManager", "DialogueBubbleUI", "DialogueLineDatabase", "DialogueDatabase",
            "LilithEmotionController", "LilithSkeletonFacePatch", "LilithMoodFlags",
            "ChatListWindow", "ChatListRow", "ChatMenuPreference",
            "LilithAnimName", "LilithDressUpAnimName", "LilithExpressionAccessoryState",
            "TransparentWindowNew", "CharacterInteractionHandler", "TypewriterEffect", "PlayerLineController"
        };

        static readonly StringBuilder Sb = new StringBuilder();

        static void W(string line = "") => Sb.AppendLine(line);

        public static void Dump()
        {
            try
            {
                W($"=== LilithAvatar 探针 {DateTime.Now:yyyy-MM-dd HH:mm:ss} ===");
                W($"Unity {Application.unityVersion}");
                W();

                var asms = AppDomain.CurrentDomain.GetAssemblies();
                W($"程序集数：{asms.Length}");
                foreach (var a in asms)
                    W($"  - {a.GetName().Name}");

                var game = asms.FirstOrDefault(a => a.GetName().Name == "Assembly-CSharp");
                if (game == null) { W("!! 找不到 Assembly-CSharp"); Flush(); return; }

                var types = SafeTypes(game);
                W();
                W($"Assembly-CSharp 类型数：{types.Length}");

                // 1) 关键类型的成员
                foreach (var name in Interesting)
                {
                    var t = types.FirstOrDefault(x => x.Name == name);
                    W();
                    if (t == null) { W($"---- {name}: 未找到"); continue; }
                    DumpType(t);
                }

                // 2) 所有跟对话/情绪/动画相关的类型清单（便于后续挑）
                W();
                W("---- 相关类型清单 ----");
                foreach (var t2 in types.Where(x => Cares(x.Name)).OrderBy(x => x.Name))
                    W($"  {t2.FullName}");

                // 2.5) 关键枚举的取值 —— /say 的 actionType、/emotion 的名字都从这里来
                W();
                W("---- 关键枚举 ----");
                foreach (var en in new[] { "LilithActionType", "LilithPoseState", "LilithClothingState", "LilithExpressionAccessoryState", "DialogueTriggerType" })
                {
                    var t3 = types.FirstOrDefault(x => x.Name == en);
                    if (t3 == null) { W($"  {en}: 未找到"); continue; }
                    try { W($"  {en}: {string.Join(", ", Enum.GetNames(t3))}"); }
                    catch (Exception ex) { W($"  {en}: 读取失败 {ex.Message}"); }
                }

                // 3) 场景里的实例
                W();
                W("---- 场景实例 ----");
                foreach (var name in Interesting)
                {
                    var t = types.FirstOrDefault(x => x.Name == name);
                    if (t == null) continue;
                    try
                    {
                        var arr = FindAll(t);
                        if (arr == null || arr.Length == 0) { W($"  {name}: 场景里没有实例"); continue; }
                        W($"  {name}: {arr.Length} 个 → {string.Join(", ", arr.Take(5).Select(o => ((UnityEngine.Object)o).name))}");
                    }
                    catch (Exception ex) { W($"  {name}: 找实例失败 {ex.GetType().Name} {ex.Message}"); }
                }

                // 4) Spine 动画名（这是动作系统的基础）
                W();
                W("---- Spine 动画 ----");
                var skelType = types.FirstOrDefault(x => x.Name == "SkeletonAnimation")
                               ?? asms.SelectMany(SafeTypes).FirstOrDefault(x => x.Name == "SkeletonAnimation");
                if (skelType == null) W("  !! 找不到 SkeletonAnimation 类型");
                else
                {
                    try
                    {
                        var objs = FindAll(skelType);
                        W($"  SkeletonAnimation 实例：{objs?.Length ?? 0}");
                        foreach (var o in objs ?? Array.Empty<object>())
                        {
                            // 必须 TryCast 到具体代理类型，否则读不到 skeleton
                            var typed = TryCastTo(o, skelType) ?? o;
                            var comp = typed as Component;
                            W($"  · 对象={comp?.gameObject?.name ?? "?"} type={typed.GetType().Name}");
                            var skel = GetProp(typed, "Skeleton") ?? GetProp(typed, "skeleton");
                            var data = skel != null ? (GetProp(skel, "Data") ?? GetProp(skel, "data")) : null;
                            var anims = data != null ? (GetProp(data, "Animations") ?? GetProp(data, "animations")) : null;
                            if (anims == null) { W("     (skeleton/data/animations 仍读不到)"); continue; }
                            if (anims is System.Collections.IEnumerable en)
                            {
                                var names = new System.Collections.Generic.List<string>();
                                foreach (var it in en)
                                {
                                    var n = GetProp(it, "Name") ?? GetProp(it, "name");
                                    if (n != null) names.Add(n.ToString());
                                }
                                W($"     动画 {names.Count} 个：");
                                foreach (var n in names) W($"       {n}");
                                // 顺带把像表情的那些单独列出来，方便做映射
                                var emo = names.Where(x => x.IndexOf("emo", StringComparison.OrdinalIgnoreCase) >= 0
                                                        || x.IndexOf("face", StringComparison.OrdinalIgnoreCase) >= 0
                                                        || x.IndexOf("expr", StringComparison.OrdinalIgnoreCase) >= 0).ToList();
                                W($"     ★ 疑似表情 {emo.Count} 个：{string.Join(", ", emo.Take(80))}");
                            }
                        }
                    }
                    catch (Exception ex) { W($"  Spine 探测失败：{ex.GetType().Name} {ex.Message}"); }
                }

                // 5) 输入相关：谁在接键盘、场景里有哪些输入框
                // 5) 菜单功能（记事本 / 计时器 / 音乐 / 设置）的入口方法
                W();
                W("---- 菜单功能相关类型 ----");
                var featKeys = new[] { "Memo", "Music", "Timer" };
                int featShown = 0;
                foreach (var t5 in types.Where(x => !x.IsEnum && x.Name.IndexOf("Purser", StringComparison.OrdinalIgnoreCase) < 0 && featKeys.Any(k => x.Name.IndexOf(k, StringComparison.OrdinalIgnoreCase) >= 0)).OrderBy(x => x.Name))
                {
                    W();
                    DumpType(t5);
                    if (++featShown >= 24) break;
                }

                W();
                W("---- 输入相关类型/方法 ----");
                var wanted = new[] { "OnInputEndEdit", "BeginKeyboardInput", "HandleAddInputEndEdit", "IsChatBlockedByOngoingDialogue", "SetIsTyping", "IsBubbleTyping" };
                foreach (var t4 in types)
                {
                    MethodInfo[] ms;
                    try { ms = t4.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly); }
                    catch { continue; }
                    foreach (var m in ms)
                    {
                        if (Array.IndexOf(wanted, m.Name) < 0) continue;
                        W($"  {t4.FullName}.{m.Name}({string.Join(", ", m.GetParameters().Select(p => $"{p.ParameterType.Name} {p.Name}"))})");
                    }
                }

                W();
                W("---- 场景里的输入框 ----");
                foreach (var asm in asms)
                {
                    foreach (var tn in new[] { "TMP_InputField", "InputField" })
                    {
                        var tt = SafeTypes(asm).FirstOrDefault(x => x.Name == tn);
                        if (tt == null) continue;
                        try
                        {
                            var list = FindAll(tt);
                            W($"  {tn}: {list?.Length ?? 0} 个");
                            foreach (var o in list ?? Array.Empty<object>())
                            {
                                var c = o as Component;
                                var text = GetProp(o, "text");
                                var go = c?.gameObject;
                                W($"    · {(go != null ? go.name : "?")} active={(go != null && go.activeInHierarchy)} text=\"{text}\"");
                            }
                        }
                        catch (Exception ex) { W($"  {tn}: 读取失败 {ex.Message}"); }
                    }
                }

                Flush();
            }
            catch (Exception ex)
            {
                W($"!! 探针整体失败：{ex}");
                Flush();
            }
        }

        static bool Cares(string n) =>
            n != null && (n.Contains("Dialogue") || n.Contains("Emotion") || n.Contains("Anim")
                          || n.Contains("Chat") || n.Contains("Bubble") || n.Contains("Spine")
                          || n.Contains("Mood") || n.Contains("Expression") || n.Contains("Face"));

        static Type[] SafeTypes(Assembly a)
        {
            try { return a.GetTypes(); } catch (ReflectionTypeLoadException ex) { return ex.Types.Where(t => t != null).ToArray(); }
            catch { return Array.Empty<Type>(); }
        }

        static void DumpType(Type t)
        {
            W($"---- {t.FullName} ----");
            try
            {
                if (t.IsEnum)
                {
                    W("  枚举值：" + string.Join(", ", Enum.GetNames(t)));
                    return;
                }
                foreach (var m in t.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly)
                                   .Where(m => !m.IsSpecialName).OrderBy(m => m.Name))
                    W($"  m {m.ReturnType.Name} {m.Name}({string.Join(", ", m.GetParameters().Select(p => $"{p.ParameterType.Name} {p.Name}"))})");
                foreach (var p in t.GetProperties(BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly))
                    W($"  p {p.PropertyType.Name} {p.Name}{(p.CanWrite ? " {get;set;}" : " {get;}")}");
                foreach (var f in t.GetFields(BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly))
                    W($"  f {f.FieldType.Name} {f.Name}");
            }
            catch (Exception ex) { W($"  （成员读取失败：{ex.GetType().Name}）"); }
        }

        // ── 场景查找 / 反射取值 ────────────────────────────────────────────
        public static UnityEngine.Object[] FindAll(Type t)
        {
            try
            {
                var il2 = Il2CppInterop.Runtime.Il2CppType.From(t);
                return UnityEngine.Object.FindObjectsOfType(il2);
            }
            catch { return null; }
        }

        public static object FindOne(Type t)
        {
            var all = FindAll(t);
            return all != null && all.Length > 0 ? all[0] : null;
        }

        /// <summary>
        /// 拿到**类型正确**的组件实例。FindObjectsOfType 返回的是 UnityEngine.Object 代理，
        /// 直接反射调用会报 "Object does not match target type"；用 GetComponent(IL2CPP 类型)
        /// 才能拿到真正是 Il2Cpp.DialogueManager 的那个包装。
        /// </summary>
        public static object FindTyped(Type t)
        {
            try
            {
                var il2 = Il2CppInterop.Runtime.Il2CppType.From(t);
                var all = UnityEngine.Object.FindObjectsOfType(il2);
                if (all == null || all.Length == 0) return null;
                foreach (var o in all)
                {
                    var typed = TryCastTo(o, t);
                    if (typed != null) return typed;
                }
                return all[0];
            }
            catch { }
            return null;
        }

        /// <summary>
        /// Il2CppInterop 的 TryCast&lt;T&gt; 是泛型的：运行时用 MakeGenericMethod 把基类代理
        /// （UnityEngine.Object）转成真正的 Il2Cpp.Xxx 包装，否则反射调方法会报 Object mismatch。
        /// </summary>
        public static object TryCastTo(object o, Type t)
        {
            if (o == null) return null;
            try
            {
                var baseType = typeof(Il2CppInterop.Runtime.InteropTypes.Il2CppObjectBase);
                foreach (var m in baseType.GetMethods())
                {
                    if (m.Name != "TryCast" || !m.IsGenericMethodDefinition) continue;
                    if (m.GetParameters().Length != 0) continue;
                    var g = m.MakeGenericMethod(t);
                    return g.Invoke(o, null);
                }
            }
            catch { }
            return null;
        }

        public static object GetProp(object o, string name)
        {
            if (o == null) return null;
            try { return o.GetType().GetProperty(name)?.GetValue(o); } catch { return null; }
        }

        public static object GetField(object o, string name)
        {
            if (o == null) return null;
            try { return o.GetType().GetField(name)?.GetValue(o); } catch { return null; }
        }

        static void Flush()
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(DumpPath) ?? ".");
                File.WriteAllText(DumpPath, Sb.ToString(), new UTF8Encoding(false));
                MelonLogger.Msg($"探针结果已写入 {DumpPath}");
            }
            catch (Exception ex) { MelonLogger.Warning($"探针写盘失败：{ex.Message}"); }
        }

        /// <summary>按类型名调静态/实例方法，参数用字符串尽力转换。返回是否成功。</summary>
        public static bool TryInvoke(Type t, object instance, string method, params object[] args)
        {
            if (t == null) return false;
            foreach (var m in t.GetMethods(BindingFlags.Public | BindingFlags.Static | BindingFlags.Instance))
            {
                if (m.Name != method) continue;
                var ps = m.GetParameters();
                if (ps.Length != args.Length) continue;
                try
                {
                    var conv = new object[ps.Length];
                    for (int i = 0; i < ps.Length; i++) conv[i] = Coerce(args[i], ps[i].ParameterType);
                    m.Invoke(instance, conv);
                    return true;
                }
                catch { /* 试下一个重载 */ }
            }
            return false;
        }

        static object Coerce(object v, Type target)
        {
            if (v == null) return null;
            if (target.IsInstanceOfType(v)) return v;
            if (target.IsEnum) return Enum.Parse(target, v.ToString(), true);
            if (target == typeof(string)) return v.ToString();
            if (target == typeof(int)) return Convert.ToInt32(v);
            if (target == typeof(float)) return Convert.ToSingle(v);
            if (target == typeof(bool)) return Convert.ToBoolean(v);
            return Convert.ChangeType(v, target);
        }
    }
}
