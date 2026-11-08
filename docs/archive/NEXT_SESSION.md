# 新会话启动包（生成于 2026-10-24 15:54）

## 怎么用
1. 在 DSH 里新建会话，工作目录选 `E:\DSH_workspace`。
2. 把下面「开场白」整段粘进去。
3. 旧的会话在会话列表里**归档**（归档=隐藏，可回溯，不物理删除）。

## 开场白

```
接手上一个会话的工作。先读 E:\DSH_workspace\HANDOFF.md（尤其第 6 节「踩过的坑」和第 8 节「快速自检」），再读 E:\DSH_workspace\NEXT_SESSION.md 里「进行中」清单；按「进行中」的顺序继续，不要重做已完成项。改代码前先确认是不是上游已有能力（先查 npm/GitHub）；一条完成回一句；涉及重启 DSH 用 WMI 起独立进程那套。
```

## 进行中

- 1. 工作/闲聊模式切换（半成品：桥接已有 mode 切换 + /reset 斜杠命令；缺"一条命令同时切模式+清上下文"，约 40 行）
- 7. net_status 的 verdict（现在只看 127.0.0.1:443 可连就报"可达"，其实是 Watt 的监听端口，应改成真拉一次）

## 已完成

- 2. 花费阈值提醒（✅ 2026-10-24 完成：src/token-alert.js + /api/tokens/alert{,/tes）
- 3. 聊天记录检索（✅ 2026-10-24 完成（桥接内实现，不装插件）：src/history-search.js + /搜 命令 + ）
- 4. 鲟鱼代批审批（✅ 2026-10-24 完成：qq_dsh_pending / qq_dsh_approve + src/approv）
- 5. 账本"未归属"标签（✅ 2026-10-24 修：取 session- 之后的 8 位；原先两条会话都被压成 未归属:session- 合并）
- 6. DSH 端口自动同步（✅ 2026-10-24 完成：scripts/sync-dsh-port.mjs（见 7.5））

## 现状摘要（摘自 HANDOFF 第 0 节）

QQ（SnowLuma/OneBot）↔ DeepSeek Harness 的桥接已完整可用：聊天记录落盘、错题集、QQ→DSH 喊话、
DSH→QQ 回流转述、**审批代批（30 分钟窗口 + 高危黑名单）**、**花费提醒（¥5 一档）**、
**聊天检索（桥接自带 `/搜` + dsh-qq-extras 记忆工具）**、**会话交接（`/交接`）**。
聊天归档已喂进 `dsh-qq-extras`（`E:\DeepFish\History\qq-memory`，60 秒增量）。
当前 DSH 是 **DSH NEXT 2.0.19-next**（`E:\DSH_Desktop`）；**端口每次重启都会变**（最近一次 54902），
桥接的 `baseUrl` 靠 `scripts/sync-dsh-port.mjs` 自动对齐，别手改。
已接入的群：978660847（正常参与）。**还欠**：① 工作/闲聊模式一键切换（搁置）；⑦ net_status 把关机/代理端口误判成 GitHub 可达。
其余待办（2/3/4/5/6）均已完成，见第 7 节。

---

## 关键路径（摘自第 1 节）

| 项 | 值 |
|---|---|
| 桥接仓库 | `E:\DeepFish\qq-bridge-0.2.1-r1\qq-bridge-0.2.1-r1`（v0.2.1-r1） |
| DSH 客户端 | `E:\DSH_Desktop\DSH NEXT.exe`（社区版 DSH Desktop，内置 DSH 0.2.1-rc.2） |
| DSH Home | `C:\Users\Xuchi\.dsh`（profile 名 `desktop`，与旧官方版共用） |
| DSH Web | `http://127.0.0.1:62958`（**端口每次重启会变**） |
| 桥接控制台 | `http://127.0.0.1:3100/?token=<见 state/console-token>` |
| SnowLuma | `E:\DeepFish\SnowLuma-v2.1.1-win-x64`，OneBot HTTP 3000 / WS 3001，账号 2623489215「鲟鱼」 |
| 数据目录 | `E:\DeepFish\History\`（chats / roles / errors） |
| Watt Toolkit | `C:\Program Files\Steam++\Steam++.exe` |

启动方式：`start.bat`（守护循环，进程崩溃 5 秒后自动重启）；日志 `state/bridge.log`。

---

## 启动自检

```powershell
# 桥接状态
$t = Get-Content 'E:\DeepFish\qq-bridge-0.2.1-r1\qq-bridge-0.2.1-r1\state\console-token' -Raw
Invoke-WebRequest "http://127.0.0.1:3100/api/status?token=$t" | Select-Object -Expand Content

# preset 是否加载
Invoke-WebRequest "http://127.0.0.1:3100/api/presets?token=$t" | Select-Object -Expand Content

# 错题集报告
cd 'E:\DeepFish\qq-bridge-0.2.1-r1\qq-bridge-0.2.1-r1'; node scripts/error-book.mjs --report

# 花费提醒（状态 + 概览文本）
Invoke-WebRequest "http://127.0.0.1:3100/api/tokens/alert?token=$t" | Select-Object -Expand Content

# 喊话默认会话（看它指向谁、还在不在）
Invoke-WebRequest "http://127.0.0.1:3100/api/dsh/default-target?token=$t" | Select-Object -Expand Content

# 聊天记录检索（家底 + 试搜）
Invoke-WebRequest "http://127.0.0.1:3100/api/history/stats?token=$t" | Select-Object -Expand Content
Invoke-WebRequest "http://127.0.0.1:3100/api/history/search?q=5090&limit=3&token=$t" | Select-Object -Expand Content
```

每次排查先看：`state/bridge.log` 尾部、`/api/status` 的 `dshReady`、`/api/presets` 是否含 `qq-chat-v2`。

---
```
