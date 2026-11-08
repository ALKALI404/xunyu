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
  ├─ 邮件：读 E:\DeepFish\Xunyu\memory\mail\mailbox.jsonl
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
台账事件：{op:'dep', mode:'add'|'remove', on:'W-xxx'}
         {op:'unblocked', // UG-011 起：解锁是独立事件，带 t/from/state/reason/wasBlockedOn
          旧形状 {op:'dep', mode:'unblock'} 仍能回放（向后兼容，不再新写）
派生（worklist-core.mjs replay）：任一条前置 state ∉ {done, dropped} → blocked=true，blockedOn=[没完成的那些]
  前置 id 不在台账里 → 也当没完成（防手滑写错悄悄放行）；dropped 视同完成
```

- **挂/摘**：`worklist.mjs dep <票> --on <前置[,前置…]>` / `--off …`；成环、自依赖、前置不存在一律拒（`addDependency` 环检测）。
- **派发闸**：`dispatch-core.mjs` 在状态检查之后、`--dry-run` 之前判 `blocked` → **`409 blocked-by`**（detail 带 `W-xxx(FX:queued)`，**不花钱、不改状态**）；auto-relay 侧另有一道 `.filter(t => !t.blocked)`（`workdesk-server.mjs`）。
- **可见**：`list` 的「挡着」列 = `blockedOn`（**未闭环**的前置票号，全闭环显示 `—`）；`queued⏸` 与行尾 `← 等 …` 同时标注；`list --blocked` 只筛不标（分组视图不渲染标记，见 §9 已知缺口）。
- **解锁**：前置 `done`/`dropped` 后派生自动放行；`unblocked` 事件由**触发闭环那一侧**写——CLI 的 `accept`/`drop`/`state` 走 `afterClose()`（`worklist.mjs`），工作台的 `sweepUnlocks()` 走同一份 `core.sweepUnblocks()`；`from` 记谁解的锁，`reason` 记哪张前置闭环。只对 `state==='queued'` 的票写解锁并给目标工号发「【解锁】…可以派了」（`unblockedAt` 去重，一轮只发一次）。手动补扫：`worklist.mjs unblock-sweep`。
- **已知缺口（2026-10-28 D30B/D30A 验收实测）**：
  1. ~~`sweepUnlocks` 抛 `pendingUnlocks is not defined`~~ **已修**：04 在 18:22:42 补了 import（`workdesk-server.mjs:32`），**9340 于 18:22:50 重启后生效**，18:23:00 首次成功解锁 `W-057` 并发邮件（seq=141）。教训：**改完要重启 9340 才生效**，日志里 `[unlock] 异常` 连续出现＝跑的是旧进程。
  2. `dep` 不检查目标是否已在 `doing`/`done`：可以在派发之后再挂前置，出现 `doing` + `blocked` 并存（W-049 现场：18:20:07 派发、18:20:09 才挂前置）。
  3. `pendingUnlocks` 只排除 `done`/`dropped`，**不要求 `state === 'queued'`** → 给已经在干的单也发「现在可以派了」。**已现场坐实**：`W-057` 在 18:22:17 就被派成 `doing`，18:23:00 仍收到「【解锁】…现在可以派了」（邮件 seq=141 发给了 00）。**部分收敛（UG-011，2026-10-29）**：`core.sweepUnblocks()` 已只对 `state==='queued'` 写解锁；`workdesk-server.sweepUnlocks()` 仍直接遍历 `pendingUnlocks`，缺口在 HTTP/巡检侧保留，留给下一张单（正式修法：候选加 `state === 'queued'`，或对 `doing` 改文案「前置已完成，可继续」）。
  4. `unblocked` 事件是 UG-011 新形状；`workdesk-server` 仍按老签名调 `markUnblocked`（兼容），但**9340 要重启才吃到新 core**（改完不重启＝跑旧进程，见上条教训）。

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

## 11. 启动方式与版本号（D60，2026-10-28，03）

### 11.1 怎么起
**不要从 DSH 会话里手动 `node scripts\workdesk-server.mjs`**——那样改完文件不重启，页面永远是旧的（D54/D56/D60 三次都是这个坑）。现在由 `supervisor.ps1` 托管（`Start-Workdesk`）：

| 场景 | 谁负责 |
|---|---|
| 开机 / 守护启动 | supervisor 首轮只记源码基线，不重启；端口不通才拉起 |
| 端口 9340 挂了 | supervisor 3 秒轮询 → 拉回（20 秒冷却） |
| **`workdesk-server.mjs` 变了** | supervisor 比对 mtime → **停旧实例、起新实例**（实测 1–3 秒） |
| 想手动重启 | `POST http://127.0.0.1:9338/heal?module=workdesk`，或停守护让它拉（不推荐） |

### 11.2 日志在哪
| 文件 | 内容 |
|---|---|
| `logs\workdesk.run.log` | **生命周期**（每次拉起一行，只追加）：`[2026-10-28 20:22:47] 拉起 9340（supervisor：源码变更/端口不通）` |
| `logs\workdesk.out.log` / `workdesk.err.log` | 服务自己的 stdout / stderr（每次拉起覆盖） |
| `E:\DeepFish\avatar\state\supervisor.log` | 重启原因：`工作台源码变了（20:22:41）→ 重启 9340`、`工作台 9340 不通 → 第 N 次拉起` |
| `state\supervisor.json` | `workdesk: ok/fail`、`workdeskRestarts` |

### 11.3 怎么看版本号
- **页面页脚**：`构建 HH:mm:ss · pid N` —— 每次服务重启都会变；看不到变化就是没重启成功；
- `GET http://127.0.0.1:9340/health`（`/api/health` 同义）：`version`（当前 `1.0.1`）、`pid`、`startedAt`（ISO）、`startedAtLocal`、`uptimeMs`（刚重启会很小）。

### 11.4 排障三步
1. **页脚变了没**：`Invoke-WebRequest http://127.0.0.1:9340/ | Select-String '构建'`；
2. **服务是哪个 pid**：`Get-NetTCPConnection -LocalPort 9340 -State Listen`，对照页脚 pid；
3. **为什么没重启**：`Select-String E:\DeepFish\avatar\state\supervisor.log -Pattern '工作台'`；`Get-Content logs\workdesk.run.log -Tail 5`。若守护不在（9338 不通），先按 D39/守护文档恢复。

### 11.5 回滚
- 启动方式回滚：`supervisor.ps1` 里删掉「工作台 workdesk（D60）」整段 + `Start-Workdesk`/`Stop-Workdesk`/`Get-WorkdeskPids` + heal 白名单 `workdesk` 行 + json/heartbeat 里的两个字段，然后重启守护任务；
- 页脚版本号可保留，不影响业务。

### 11.6 自启与崩溃退避（D64，2026-10-28，03）

**登录即起**：靠 `XunyuAvatarSupervisor` 计划任务自带的 **LogonTrigger**（enabled=True，动作是 `wscript //B … supervisor-hidden.vbs`，无黑窗）+ 每 30 分钟的 TimeTrigger 兜底；supervisor 起来后第一轮看到 9340 不在就拉起。**不需要单独给工作台建任务**（已实测：杀掉守护+工作台，再 `Start-ScheduledTask` → 9340 在 2 秒内回来）。

**崩溃退避**（防止无限重启）：
| 项 | 规则 |
|---|---|
| 计数 | **10 分钟内崩溃 ≥6 次**（掉线边沿计数，正常重启成功后不清零） |
| 触发 | 停止自动重启；`supervisor.log` 写一行；疼痛总线发一条 `workdesk/crash/restart-giveup` |
| 解除 | ① 源码变更（mtime 变了）→ 自动清零并重启；② 人工 `POST 9338/heal?module=workdesk` 拉起后**稳定 10 分钟** → 清零 |
| 状态 | `state\supervisor.json` 的 `workdeskCrashes` / `workdeskGiveUp` |

**启动痕迹**：服务每次监听成功会往 `logs\workdesk.run.log` 追加一行 `[boot] pid=… startedAt=… version=… port=…`，和 supervisor 的「拉起」行并排，便于对齐。

## 12. 三级状态推导：单 → 功能域 → 项目（D63，2026-10-28）

> 为什么写这一节：主人验收完还看到项目「在做」。盘下来根因是**预检门把交付挡在 `submitted` 之外**（见 12.5），但同时页面推导口径有 3 处与本节不一致——所以先把规则定死，再按规则改代码。
> **原则：能算的不许写死。** 状态一律由台账推导，`projects.json` 里没有也不许有「进度/状态」这种会漂的字段。

### 12.1 一级：单（ticket）——`worklist` 台账是唯一真相

一张票可能对应**多条任务行**（被退回、重派过）。取**最活跃的未完成态**，优先级从高到低：

```
在做(doing) > 待验收(submitted) > 排队(queued) > 已完成(done) > 作废(dropped)
```

| 情况 | 判定 | 依据 |
|---|---|---|
| 有任一任务 `doing` | 在做 | 有人正在干，别管别的行 |
| 否则有 `submitted` | 待验收 | 交付已落、等 01 收 |
| 否则有 `queued` | 排队 | 派过或排着，没开工 |
| 否则有 `done` | 已完成 | 只要有一条 done 且没有更活跃的未完成态 |
| 全部 `dropped` | 作废 | 弃单 |
| 台账里查不到这个票号 | **未登记（阻塞）** | 数据错：票号写错或建单漏了，报 05，不许猜 |

**为什么不是「有 done 就算完成」**：一张票退回重派后，会有「老行 done + 新行 doing」。按「有 done 就算完成」会把在干的活显示成已完成（进度虚高）——`/api/projects` 老逻辑（`doneOf = 任一 done`）就是这个毛病。

### 12.2 二级：功能域（feature）——由它的 `tickets[]` 推导

先**剔除作废票**（作废不算工作量，也不进分母），再看剩下的有效票：

| 有效票的组合 | 判定 | 说明 |
|---|---|---|
| 有任一「在做」 | **在做** | 优先于其它一切 |
| 否则有任一「待验收」 | **待验收** | 已交待收，别叫「在做」 |
| 否则有任一「排队」 | **要做** | 哪怕其余都已完成，也还没完 |
| 全部「已完成」 | **已完成** | |
| **有效票为 0**（全作废） | **作废** | 域整体作废 |
| 有「未登记」票 | **阻塞** | 数据错，先修台账 |

**混合边界写死**（这是最容易吵的地方）：

| 例 | 判定 | 理由 |
|---|---|---|
| 3 done + 1 dropped | **已完成** | 作废票从分母剔除，3/3 |
| 2 done + 1 queued | **要做** | 剩下的没开工，不能算在做，更不能算完成 |
| 2 done + 1 doing | **在做** | |
| 2 done + 1 submitted | **待验收** | 人在等验收，与「在做」分开显示 |
| 全 dropped | **作废** | |
| 票号查不到 | **阻塞** | 不许静默当完成 |

### 12.3 三级：项目（project）——由 `features[]` 推导

| 条件（按顺序判，命中即停） | 项目状态 |
|---|---|
| `state: "paused"`（**唯一允许人工写的值**） | 暂停 |
| 任一 feature 阻塞 | 阻塞（数据错） |
| 任一 feature 在做 | 在做 |
| 任一 feature 待验收 | 在做（页面四档里并入「在做」，但卡片上必须标「待验收 N」） |
| 全部 feature 已完成/作废（至少一个已完成） | 已完成 |
| 其余 | 要做 |

**`state: "done"` 手写无效**：一律按推导显示（D53 曾用「json 显式标 done 就进已完成栏」，与本节冲突，以本节为准）。

### 12.4 优先级链（一句话记住）

```
暂停(人工) > 阻塞 > 在做 > 待验收 > 要做 > 已完成 > 作废
```

### 12.5 预检门（D57）插在哪 —— 本次「验收完还显示在做」的真根因

交付文件落地后**先过预检**（`precheckDelivery`）：首 3 行类型、修复类要有命令块与 exit 码等。不合格时：

- **票停在 `doing`，不进 `submitted`**（所以台账里看着还在干）；
- 文件进 `badDeliveries`，页面上是「预检不合格」而不是「待验收」；
- 2026-10-28 20:2x 实测被挡的 4 张：`D44`（缺 exit 码）、`D31`/`D30`（首 3 行缺 `类型:`）、`D54`（缺 exit + 命令块）——这就是 workdesk/avatar 一直显示「在做」的原因，**不是推导算错**。

**结论**：预检不合格时，页面该显示「不合格·待修」（`bad` 数据已有），不该显示「在做」。补文件后 mtime 变化会自动重扫认领，不需要手工改状态。

### 12.6 数据契约（谁算、谁不写死）

| 层 | 谁算 | 允许写进 json 吗 |
|---|---|---|
| 单 | `worklist.jsonl`（04） | 不写 |
| 功能域 | workdesk 现算（06） | **不写**（`features[].state` 一律不许出现） |
| 项目 | workdesk 现算（06） | 只允许 `state: "paused"`；`active/"done"` 都是无效噪音 |
| 进度 pct | workdesk 现算 | 不写；分母 = **有效票数**（剔除作废） |

`state\projects.json` 顶部有 `statePolicy` 节点把这条写死了；`tmp\projects-check.mjs` 会拒绝带 `state` 的 feature（若哪天有人手滑加了）。

---

## 附录 · 派发优先级规则（2026-10-28 定，写进工作台执行逻辑）

### 一、现在的排序（硬规则，四级，按序生效）

```
① 主人亲口要的        → 立刻插队（P0 直通，不看其他分数）
② 有下游等着的        → 优先（dependency 链头：谁挡着别人先做谁）
③ 同类毛病返工过的    → 优先（先堵系统性缺陷，别第三次栽同一处）
④ 其余                → 按进池先后（FIFO）
```

**为什么不用精细打分**：实测（118 张票 / 354 条派发）——派单等待平均 **5 分钟**，钱一轮 **¥0.16**，真正的损失是**返工与阻塞**；而当前数据里"下游数"和"工时"几乎是空的，**任何精细权重都会退化成常数**（实测 12 张票排出 9 个并列 +30m）。

### 二、未来升级成「分钟制」的前置条件（三项埋点）

| 缺什么 | 埋点 | 补齐后能算什么 |
|---|---|---|
| 依赖关系 | 建单强制 `blockedBy`（真有下游才写） | `白等分钟 = 下游票数 × 下游工号空闲分钟` |
| 工时 | 记 `startedAt` / `submittedAt` | 真实耗时替代启发式 |
| 返工原因 | 驳回时 `--reason` 从枚举选（`missing-type` 缺类型行 / `weak-evidence` 证据不足 / `gate-too-strict` 门过严 / `wrong-formula` 口径错 / `doc-mismatch` 文档不符） | **按类型**算返工率，而不是按人 |

三项齐了，公式才成立：

```
优先级(分钟) = 下游数×下游空闲分钟 + 返工类型概率×平均返工时长 − 自身预计耗时
```
且 **"主人亲口要的"永远不进公式**——它是硬插队，任何分值都比不过"主人说了"。

### 三、执行细节

- **自动接力**按上面四级规则挑下一张（同级 FIFO）；
- **`dispatch --force`** 只允许主人指定或 P0 故障，且写审计原因；
- 同一工号在跑时**永不并发派第二张**（`409 worker-has-doing`）；
- 页面「排队」栏**按优先级排序**，并在每行显示命中的规则（`P0` / `等它的是 W-xxx` / `返工优先` / `FIFO`）。
