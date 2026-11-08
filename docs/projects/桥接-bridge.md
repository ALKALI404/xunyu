# 项目：桥接（qq-bridge）

> 状态：**独立件 · 上游魔改**｜负责人：本体（改）/ 05（文档）｜最后动
> 基线：`state\bridge-魔改清单.md`（改之前必读，没登记在案的改动算隐患）
> 本文只写桥接自己那套；端口总表看 `docs\开发文档-运行逻辑.md` §一，别在这儿抄。

## 1. 定位

QQ ↔ DSH 的**唯一进出口**：收 OneBot 事件、判要不要唤醒、投一次 DSH 回合、把回复发回 QQ。
它**不是**鲟鱼的脑子（人格在 `Xunyu\roles\`、记忆在 `Xunyu\memory\`），也不是身体（那是 avatar）。

## 2. 边界

- **属于我**：`E:\DeepFish\qq-bridge-0.2.1-r1\qq-bridge-0.2.1-r1\`（`src\`、`config.json`、`state\`）、端口 3100、MCP 服务（`mcp-*.js`）。
- **不碰**：`avatar\*`（03）、`scripts\self-heal.mjs`（04）、工作台（04）；桥接的**守护拉起**已划给疼痛子项目（见 `疼痛检测-pain.md` §8）。

## 3. 架构

`src\bridge.js` 是**单文件主程序（约 1.46 万行）**，同目录另外 37 个模块是纯函数库/适配器，靠 import 挂上去。分四层：

| 层 | 模块（挑要紧的） | 一句话 |
|---|---|---|
| 入口/主干 | `bridge.js` | 事件循环、HTTP 路由、唤醒与投递编排 |
| 通道 | `snowluma-conn.js`（连 3001 自发现）· `owner-outbound.js`（OneBot 私聊直发）· `md-to-plain.js` | QQ 进、QQ 出 |
| DSH 侧 | `dsh-client.js`（DSH Web API 客户端）· `pending-prompts.js`（投递待确认队列）· `handoff.js`（会话交接）· `watch-sessions.js` | 起回合、接管审批/提问 |
| 旁路 | `history-log.js` · `memory-feed.js` · `token-ledger.js` · `token-alert.js` · `media-normalize.js` · `sensitive.js` · `error-book.js` | 落盘、喂记忆、记账、脱敏、错题集 |
| MCP | `mcp-snowluma-safe.js` · `mcp-web-search-safe.js` · `mcp-net-accel.js` · `mcp-host-server.js` | 由 DSH 的 MCP 客户端 spawn |

## 4. 数据流

```
QQ → SnowLuma(3001 WS) → snowluma-conn → bridge.js
   → history-log 追加 E:\DeepFish\History\chats\<private|group>_<id>.jsonl
   → 唤醒判定 pickWakeTriggersV2（bridge.js:10050）
   → deliverPromptNow（bridge.js:10903）→ dsh-client → DSH sessions.prompt   ★ 唯一花钱点
   → 回合事件 → owner-outbound / api/send/* → QQ
   → memory-feed 每分钟喂 History\qq-memory；token-ledger 落 state\token-usage.jsonl
```

## 5. 接口

`/api/*` 有 100+ 条（穷举用 `Select-String bridge.js -Pattern "pathname === '/api/`），按族记：

| 族 | 代表 | 干什么 | 花钱 |
|---|---|---|---|
| `dsh/*` | `say` `sessions` `wait` `pending` `approve` `bind` `model` `effort` | 喊话、取回复、审批、绑会话 | **是**（say/唤醒类） |
| `send/*` | `private` `group` `reply` `voice` | 出站 | 否 |
| `socialV2/*` | `state` `wake-config` `wait` `send-message` `memory` `sticker-*` | 二代仿真全套（MCP 工具的 HTTP 后端） | 否 |
| `tokens/*` | `summary` `series` `turns` `alert` | 账本与告警 | 否 |
| `roles/*` · `preset/*` · `slang/*` · `history/*` · `stickers/*` | — | 人格卡、预设词、黑话、历史检索、表情库 | 否 |
| `restart` · `console/*` · `workspace/reset` | — | 控制台运维 | 否 |

**`/api/dsh/wait` 是给 QQ 侧转述用的长轮询**：`after` = 单调序号（`relayReplySeq`，bridge.js:1760-1773），缓冲 `RELAY_MAX_REPLIES=50` 会 `shift()` 丢头——用下标会「同一批回执循环」，别改回去。

## 6. 状态与存储

| 位置 | 内容 | 可重建吗 |
|---|---|---|
| `config.json` | dsh 地址/模型、snowluma 地址、白名单（私聊 1 人 + 3 群）、socialV2 全部参数、storage 路径、tokenAlert 阈值 | 否，手改要留底 |
| `state\token-usage.jsonl` | 每回合用量（记账原始数据，已 3.8 MB） | 否 |
| `state\pending-prompts.jsonl` | 投递待确认队列，重启装载 | 是 |
| `state\approval-audit.jsonl` · `file-audit.jsonl` | 审批与文件审计 | 否 |
| `History\chats\*.jsonl` | 聊天原文（32 MB 轮转，留 5 份） | 否 |
| `History\qq-memory\` | memory-feed 喂给记忆的归档 + `feed-state.json` 水位 | 水位可重算 |

**不可逆**：`/api/workspace/reset`、`/api/session/reset`、`/api/socialV2/reset` —— 会清会话/状态，动手前问主人。

## 7. 依赖

- 依赖 SnowLuma 3001（断了：QQ 全哑，日志报连接失败，不崩）；依赖 DSH 60540（断了：能收不能起回合，`error-book` 记一笔）；DSH 端口每次重启可能变，`scripts\sync-dsh-port.mjs`（在桥接仓内）先对齐 `config.json` 的 `dsh.baseUrl`。
- 被依赖：`relay.mjs`（走 `/api/dsh/pending`、`/api/send/*`）、工作台（不读桥接）、MCP 工具（`socialV2/*`）、记忆管线（读 `History\chats`）。
- 降级原则：**桥接挂 = 群聊全断**（真故障）；皮肤/表情/语音等旁路失败只记日志。

## 8. 演进（归属要说清）

- **现在**：独立服务 + 上游魔改，**保持独立（适配器）**。
- **D20 / W-020（排队中）**：`bridge.js` 拆分——单文件 1.46 万行是最大可读性债，拆成「路由 / 唤醒 / 投递 / 仿真」几块，**拆分不改变外部行为**，拆完本文 §3 要重画。
- **守护拉起 → 划给疼痛检测子项目**：bridge 进程被 supervisor 拉起、退出即报丧、拉起失败升级，这件事按主人定归 `疼痛检测-pain.md`，桥接侧只提供「进程能不能起」的判定，不再自己维护守护逻辑。
- 迁移时要动：`supervisor.ps1` 的 bridge 分支、`pain-bus` 的 module 白名单、本文 §3/§8。

## 9. 排障

| 症状 | 先看 | 命令 |
|---|---|---|
| 群里不回 | 三步：连接 → 唤醒 → 投递 | `state\bridge.out.log` grep `[投递]`；`curl 3100/api/socialV2/state` |
| 明明有新消息没反应 | `socialV2.paused` 是否 true | `curl 3100/api/status`；`config.json` 的 `socialV2.paused` |
| 同一批回复反复出现 | `after` 是不是 seq | 见 §5 末段 |
| 起不了回合 | DSH 端口对不对 | `curl 60540` 同 `config.json` 的 `dsh.baseUrl` |
| 报错没头绪 | 错题集 | `state\errors\`、`error-book.js` 归类规则 |

## 10. 维护

实现：本体（临时）+ 03（守护/端口）+ 04（改代码）。文档：05。
**改 `bridge.js` 必同步**：`state\bridge-魔改清单.md` + 本文 §3/§5 + 总览的端口表（若端口变了）。
