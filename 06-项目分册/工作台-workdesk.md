# 项目：工作台（workdesk）

> 状态：**独立功能**（2026-10-28 v1 上线）｜负责人：04·代码｜文档：05
> **演进**：v2 起并入 avatar 集成（见 §8）。

## 1. 定位
把「谁在干什么 / 有哪些活 / 派给谁 / 交了什么 / 等谁验收」收在一个本地页面里，**只读 + 两处花钱动作**，让主人不用翻会话窗口。

## 2. 边界
- **属于我**：`scripts\workdesk-server.mjs`（9340）、`scripts\worklist.mjs`、`scripts\worklist-core.mjs`、`scripts\dispatch-core.mjs`、`state\worklist.jsonl`、`state\workdesk.config.json`、`logs\dispatch.jsonl`、页面（`GET /`）。
- **不碰**：`bridge.js`（上游魔改）、`relay.mjs`、`body-service.mjs`、企微 `server.mjs`、任何计划任务。要改这些走工单给对应工号。

## 3. 架构
```
workdesk-server(9340)
  ├─ 采样：DSH sessions/list 投影（只读，零 token）
  ├─ 台账：worklist-core（读 state\worklist.jsonl 回放）
  ├─ 交付：每 10s 扫 records\交付\*.md
  ├─ 邮件：读 <Xunyu根>\memory\mail\mailbox.jsonl
  ├─ 派发：dispatch-core（唯一花钱：一次 session/prompt）
  └─ 页面：单文件 HTML，5s 轮询，不引外网资源
```

## 4. 数据流
```
DSH 投影 ─┐
台账 jsonl ─┼→ /api/agents,/api/tasks,/api/worklist,/api/mail → 页面
交付目录 ──┘
                     ↓ 点「派发」才花钱
              POST /api/dispatch → dispatch-core → session/prompt → 写审计
```

## 5. 接口

| 接口 | 方法 | 入参 | 返回 | 花钱 |
|---|---|---|---|---|
| `/api/agents` | GET | — | 每会话：忙闲 / 在干什么 / 空闲时长 / **queued 数 + nextTask** | 否 |
| `/api/tasks` | GET | — | `state\tasks\*.md` 里未交付的活 | 否 |
| `/api/worklist` | GET | — | 回放后的台账 + 待验收 + unlinked | 否 |
| `/api/mail` | GET | — | 邮件 + 各 agent 未读 | 否 |
| `/api/sessions-health` | GET | `?refresh=1` 重采样；`?reconcile=1` 顺带跑一次 token-report 对账 | 三边检测（checks / sessions / roster / brokenQueue / orphans）+ `attribution`：今日花费四桶（工作组/本体/QQ 通道/其他）+ 桶下工号或会话 + 当前在跑命中率 + 账本盲区 + 对账差值 | 否 |
| `/api/dispatch` | POST | `{id, confirm}` | 派发结果 | **是** |
| `/api/plan-approve` | POST | `{id, note}` | 方案通过：派生 `<id>-impl` 进 queued + 给提交工号发邮件 | 否 |
| `/api/plan-reject` | POST | `{id, note}` | 方案驳回：给提交工号 + 01 各发一封 + 进人工待审核箱 | 否 |
| `/api/accept`·`/api/reject` | POST | `{id, note}` | 状态变更 | 否 |
| `/` | GET | — | 页面 | 否 |

> 2026-10-28 W-033/D29（06）：`/api/worklist` 返回**新增** `plan` 块（`plans[]` / `summary` / `manual[]` / `openCount` / `manualCount`），向后兼容。方案态字段（`type` / `planState` / `reviewer` / `reviewedAt` / `planNote`）来自 04 的 D28 core 回放；人工箱就是 `state\plan-manual-queue.jsonl`（CLI `plan-manual` 与页面共用同一个箱）。页面两栏在主页下方整行：**方案审核**（每条带 类型 / planState / 审核人 / 已等多久 / 卡在谁 / 最近流转）+ **人工待审核箱**（标红，待人工条目带「通过 / 驳回」按钮；驳回是终态，不再给按钮，等提交方 `plan-submit` 重交）。

> 2026-10-28 W-028（06）：**新增** `/api/sessions-health`（只读，零 token），页面「会话检测」页签用；既有接口的入参/返回一字未动。契约变更（改字段、改语义）仍按 §9 之二：04 定、通知 05。
> 2026-10-28 W-030/D26b（06）：同一接口**新增** `attribution` 字段（向后兼容，老调用方不受影响）。归属口径两条来源，优先 `state\attribution.json`（00 的机读表，**未交付**），没有就用内建映射：`workspace.json` 的 path + 标题里的「工号 / QQ / 子实体 / 黑话 / 本体」，口径同 `records\会话归属表.md` 第一节。花费口径**复刻** `scripts\token-report.mjs`（按 sid×turn 收敛、cacheHit 取 max），面板上直接显示对账差值。

**配额**：默认 20 次/日，**当前配置 50**（`state\workdesk.config.json` → `dispatchPerDay`，2026-10-28 主人提到 50），超了 429 并记审计。

**另一处会花钱的：邮件「敲门」（D17 / W-017）**——只有 `level=活` 的未读邮件才发一次 prompt 去敲，普通通知永不唤醒；敲过的记 `state\mail-nudged.json` 防重放，失败退避 60s，开关与上限在 `workdesk.config.json` 的 `nudge`（`enabled` / `perDay` / `intervalMs`）。

## 6. 状态与存储
- **单一真相**：`state\worklist.jsonl`，append-only，回放得当前状态；**不许直接改文件**。
- 状态机：`inbox → proposed → queued → doing → submitted → done`，另有 `dropped`。
- **禁止** `queued → submitted`（必须先 dispatch 成 `doing`，防「没派就自己交」）。
- `submitted` 只能由「交付文件落地」或人工标记产生；`done` 只能由验收产生。

### 6.1 依赖链（D30 / W-047）

```
台账事件：{op:'dep', mode:'add'|'remove'|'unblock', on:'W-xxx'}
派生（worklist-core.mjs:122-130）：
  任一条前置 state ∉ {done, dropped} → blocked=true，blockedOn=[没完成的那些]
  前置 id 不在台账里 → 也当没完成（防手滑写错悄悄放行）；dropped 视同完成
```

- **派发闸**：`dispatch-core.mjs:131-134` 在状态检查之后、`--dry-run` 之前判 `blocked` → `409 blocked`，**不花钱、不改状态**；auto-relay 侧另有一道 `.filter(t => !t.blocked)`（`workdesk-server.mjs:110`）。
- **可见**：`worklist.mjs list --state queued` 显示 `queued⏸ … ← 等 W-050`；`list --blocked` 只筛不标（分组视图不渲染标记，见 §9 已知缺口）。
- **解锁**：前置 `done`/`dropped` 后派生自动放行；`sweepUnlocks`（`workdesk-server.mjs:242-258`）记一次 `unblock` 并给目标工号发邮件，一轮只发一次（`unblockedAt` 去重）。
- **已知缺口（2026-10-28 D30B/D30A 验收实测）**：
  1. ~~`sweepUnlocks` 抛 `pendingUnlocks is not defined`~~ **已修**：04 在 18:22:42 补了 import（`workdesk-server.mjs:32`），**9340 于 18:22:50 重启后生效**，18:23:00 首次成功解锁 `W-057` 并发邮件（seq=141）。教训：**改完要重启 9340 才生效**，日志里 `[unlock] 异常` 连续出现＝跑的是旧进程。
  2. `dep` 不检查目标是否已在 `doing`/`done`：可以在派发之后再挂前置，出现 `doing` + `blocked` 并存（W-049 现场：18:20:07 派发、18:20:09 才挂前置）。
  3. `pendingUnlocks` 只排除 `done`/`dropped`，**不要求 `state === 'queued'`** → 给已经在干的单也发「现在可以派了」。**已现场坐实**：`W-057` 在 18:22:17 就被派成 `doing`，18:23:00 仍收到「【解锁】…现在可以派了」（邮件 seq=141 发给了 00）。建议修：候选加 `state === 'queued'`，或对 `doing` 改文案（「前置已完成，可继续」）。

## 7. 依赖
- 依赖 DSH 的 `sessions/list`（读不到 → 页面显示错误，不崩）；
- 依赖 `records\交付\` 命名规范 `<工号>-<YYYYMMDD>-<单号>.md`（不合规 → `unlinked`，不猜）；
- 被依赖：01 收作业、本体验收、00 日结引用。

## 8. 演进（写清归属，别让它漂着）
- **v1（现在）**：独立本地服务 9340，浏览器直接开。
- **v2（已上线，2026-10-28 D14i / W-031）**：**对话窗第三个页签「工作台」**——窗口里纵向三段（谁在干什么 / 任务与待验收 / 邮件），只在该页签可见时每 5s 拉 9340 的三个只读接口，**直连、不经 relay**（relay 仍只跑聊天线，没加代理路由）。9340 继续在跑，网页与 CLI 都是主入口，窗口页签是只读看板。实现：`avatar\window\ChatWindow.cs`（`DeskBase`/`RefreshDesk`/`FillDesk*`/`SetTarget("desk")`），旧 exe 备份 `XunyuChatWindow.exe.bak-20261028`。
- **v3（已上线，2026-10-28 D22）**：自动接力——空闲 + 有 `queued` 就派下一件，一次一件、失败退避 60s、10s 一轮，开关在 `state\workdesk.config.json` 的 `autoRelay`（默认开），状态看 `GET /api/relay`。实现：`workdesk-server.mjs:82-136 autoRelayTick`。
- **没做的（当时设计里提过、实际没走）**：`relay.mjs` 挂 `/desk` 代理、`workdesk-server.mjs` 拆成库 + 可选服务。现在不需要——窗口直连 9340 更省事，9340 挂了只影响这一个页签。
- 窗口页签的验收口径：数字要与 `curl 9340/api/agents|worklist|mail` 对得上（5s 内可接受时间差）；退出工作台页签时 `deskTimer` 停（无额外轮询）；`desk` **不写** `ui-state.json`（重启不会落在空面板）。

## 9. 排障
| 症状 | 先看 | 命令 |
|---|---|---|
| 页面白屏 | 9340 在不在 | `curl http://127.0.0.1:9340/api/agents` |
| 显示排队却不干 | 有没有人派 / 自动接力开没开 | `worklist.mjs list`；`logs\dispatch.jsonl` |
| 派发被拒 409 | 先看码：`not-queued`＝状态不对；`blocked`＝前置没完成（正常）；`target-busy`＝目标在跑 | `worklist.mjs list --state queued` 看 `⏸` 与 `← 等 W-xxx` |
| 单明明没人占却派不出去 | 是不是被前置挡着 | `worklist.mjs show W-xxx`；`list --blocked` |
| 前置做完了没收到解锁邮件 | 解锁巡检是否在报错（已知缺口见 §6.1） | `Select-String logs\workdesk.run.log -Pattern '\[unlock\]'` |
| 交付没认领 | 文件名/票号是否对得上 | `logs\workdesk.run.log` 里 `[scan]` |

## 10. 维护
实现：04·代码。文档：05·文档与架构（每单交付后补 §3/§5/§9）。改架构必须同步 §8。
