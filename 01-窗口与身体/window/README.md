# 鲟鱼对话窗（C# exe）

`XunyuChatWindow.exe` —— 替代原来的 `chat-window.ps1`。

## 为什么换

`chat-window.ps1` 每次被拉起都要：起 PowerShell 宿主 → `Add-Type` 两个程序集 → **现场编译** C#（`DshForm`）
→ 建 WinForms 窗口。结果是启动 2–4 秒、CPU 明显毛刺、控制台窗口闪一下（前台玩游戏时能感觉到卡顿）。

换成 exe 之后：单文件 31 KB、**没有控制台**（`/target:winexe`）、启动只做 WinForms 初始化。

## 怎么重新编译

用 **Windows 自带的 .NET Framework 4.8 编译器**，不需要安装任何 SDK：

```bat
cd /d E:\DeepFish\avatar\window
build.cmd
```

等价的手工命令：

```bat
"%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:winexe /optimize+ ^
  /r:System.dll /r:System.Core.dll /r:System.Windows.Forms.dll /r:System.Drawing.dll ^
  /r:System.Net.Http.dll /r:System.Web.Extensions.dll ^
  /out:XunyuChatWindow.exe ChatWindow.cs
```

> ⚠️ `csc` 4.0.30319 只支持 **C# 5**：不能用字符串插值（`$"..."`）、`?.`、`nameof`、
> 表达式体成员，也不能在 `catch`/`finally` 里 `await`。改代码时注意。

## 行为（和原 ps1 对齐，别改坏）

- 无边框 + 圆角（`CreateRoundRectRgn` + `SetWindowRgn`，Resize 时重算）
- `WM_NCHITTEST` 四边四角拖动缩放；标题区拖动移动（`WM_NCLBUTTONDOWN`）
- `TopMost`、初始 420×620、位置 (80,120)、最小 320×380
- 鲟鱼 / DSH 双 tab；切 tab 清屏、只对齐游标**不回放历史**
- 1.2 s 轮询 `9334`：`/window-presence`（心跳）→ `/lines` → `/pending`；健康检查 5 s 节流
- 健康三态：中继离线（红）/ 身体未连接（黄）/ 在线（绿）
- 输入框回车发送（Shift+回车换行）、发送按钮、审批卡片（通过/拒绝/允许代批 30 分钟）
- `ui-state.json` 记住 tab（在 `avatar\` 下，与原脚本一致）

## 新增

- **单实例**：命名互斥量 `XunyuChatWindow.SingleInstance`，第二个实例 1 ms 内退出。
- **启动打点**：`avatar\state\window-boot.log`
  ```
  2026-10-26 18:07:20.850 pid=26952 shown elapsed=234ms
  2026-10-26 18:05:19.684 pid=1516  second instance -> exit elapsed=1ms
  ```

## 文件

| 文件 | 说明 |
|---|---|
| `ChatWindow.cs` | 全部源码（单文件，约 700 行） |
| `build.cmd` | 用系统 csc 编译 |
| `XunyuChatWindow.exe` | 产物（守护按这个进程名判活） |

## 与守护的关系

`supervisor.ps1`：

- `Get-WindowProc` 优先按进程名 `XunyuChatWindow` 判活，旧 ps1 窗口标题只作兜底；
- `Start-Window` 优先起 exe（**不要**给它加 `-WindowStyle Hidden`，那会把窗体本身隐藏）；
- exe 存在时会先把还在跑的旧 ps1 窗口关掉，避免两个窗口同时连 9334。
