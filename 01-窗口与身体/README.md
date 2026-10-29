# 鲟鱼的身体（LilithAvatar）

把 Steam 上的《The NOexistenceN of Lilith》改造成鲟鱼的桌面身体。所有相关代码都在这里，改完用 `build.ps1` 编译、`启动鲟鱼.bat` 一键起。

## 目录

| 路径 | 作用 |
|---|---|
| `mod/` | MelonLoader 插件源码（C#，Unity IL2CPP 侧） |
| `mod/AvatarCore.cs` | HTTP 控制口 + 对话窗 UI + 原生说话/动作/计时 |
| `mod/AvatarProbe.cs` | 反射探针：dump 游戏 API 到 `dump.txt` |
| `mod/ChatEntry.cs` | 「聊聊心情」入口接管 + 命中区（实验性，未生效） |
| `mod/AvatarPatches.cs` | 实例监视：懒创建的 UI 组件一出现就缓存 |
| `chat-window.ps1` | 游戏外对话窗（WinForms，浅色、无边框、可缩放、双联系人） |
| `relay.mjs` | 中继（127.0.0.1:9334）：窗口 ↔ 桥接 ↔ DSH，双目标各自游标 |
| `bin/LilithAvatar.dll` | 编译产物 |
| `toolchain/` | 离线编译工具链（Roslyn csc + net6 引用程序集） |
| `dump.txt` | 探针输出（游戏内 API 清单） |

## 编译 & 部署

```powershell
cd E:\DeepFish\avatar
.\build.ps1          # 编译到 bin\LilithAvatar.dll
.\build.ps1 -Deploy  # 编译后自动复制到游戏 Mods 并重启游戏
```

## 运行

- `<工作区>\启动鲟鱼.bat`：SnowLuma + 桥接 + 中继 + 对话窗
- 单独开对话窗：`powershell.exe -STA -File E:\DeepFish\avatar\chat-window.ps1`
- 游戏内控制口：`http://127.0.0.1:9333/`（`/ping` `/say` `/anim` `/timer` `/chatpanel` `/emotions` `/components` `/instances`）

## 已知坑（别再踩）

1. **Unity API 只能主线程**：在线程池调 `FindObjectsOfType` 会直接把游戏进程干掉。所有游戏调用走 `RunOnMain`。
2. **IL2CPP 代理要 TryCast**：`FindObjectsOfType` 返回基类代理，读不到游戏成员；用 `Il2CppObjectBase.TryCast<T>()`（运行时 `MakeGenericMethod`）。
3. **弹窗是穿透的**：莉莉丝是透明置顶窗口 + raycast 命中判定，游戏内 IMGUI 面板收不到鼠标 → 输入框搬到游戏外（WinForms）。
4. **PowerShell 5.1 要 BOM**：`chat-window.ps1` 必须 UTF-8 with BOM，否则中文乱码。
5. **`$input` 是自动变量**：不能当文本框变量名，否则点发送永远是空。
6. **`Il2CppSystem.DateTime`**：`System.DateTime` 传不进去，要反射转（见 `ToIl2CppDateTime`）。

## 已知限制

- 记事本 / 表情：`MemoPanels`、`LilithEmotionController` 是懒创建对象，目前监视不到实例（记录见 HANDOFF）。
- 「聊聊心情」按钮接管未生效：菜单项不是 `UnityEngine.UI.Button`。

## 调试开关

- 中继：`AVATAR_FAKE_PENDING=1 node relay.mjs` → `/pending` 在没有真实挂起时返回一条假的（看审批卡片布局用）
- 桥接：`POST /api/dsh/approve?fake=1` → 没有挂起时塞一条假审批再批（验证代批闸门用）
