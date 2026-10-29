# 工单 W1b · B 路线可行性验证（WebView2 内嵌，派 03）

> 派单 2026-10-28 18:45 本体｜主人拍板：窗口先试 B（WebView2 内嵌网页），不行回报
> 类型：方案（可行性结论）

## 1. 做什么

四项实测，按顺序做，任何一项失败就停并回报：

1. WebView2 Runtime 在不在：查注册表 HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients 与 %ProgramFiles(x86)%\Microsoft\EdgeWebView\Application\，给出版本与路径；
2. Microsoft.Web.WebView2.WinForms.dll 能否离线拿到：NuGet 缓存、已装 SDK、VS 目录、Edge 目录，任一处拿到即可；
3. 能编译最小壳：用 csc 编 WinForms + WebView2 窗体加载本地 HTML，贴命令与运行结果；
4. 结论：能/不能；不能就说清卡在哪步，并给 A 路线作退路。

## 2. 什么算过

- 第 1、2 项各贴一条命令 + 输出（版本号或文件路径）；
- 第 3 项贴 csc 全量命令 + 退出码 + 窗口显示 HTML 的证据（截图或窗口标题）；
- 第 4 项一句话结论 + 卡点定位。

## 3. 边界

- 只在 <工作区>\tmp\w1b\ 或 E:\DeepFish\avatar\window\probe\ 放试验文件；
- 不改 ChatWindow.cs、relay.mjs、bridge.js、计划任务。

## 4. 回滚

- 试验产物全在临时目录，删掉即回滚；本单不允许改任何生产文件。

## 5. 交付

records\交付\03-20261028-W1b.md，第一行 类型: 方案，五段式 + 结论一句话。
