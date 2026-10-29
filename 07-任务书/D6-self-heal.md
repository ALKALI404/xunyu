# 工单 D6-v2 · 疼痛链路 + 缩回 + 自愈 + 复验（派 04·代码）

> 2026-10-28 17:00 改口径（主人定）：**不长期监测**，改成事件驱动的「疼痛」链路。
> 原 D6（定时轮询版）作废，以本单为准。

## 一、什么叫「疼痛」

模块出问题时不等人来查，而是**主动把疼报出来**。三个来源，缺一不可：

| # | 来源 | 谁产生 | 数据 |
|---|---|---|---|
| 1 | **监护者报丧** | supervisor 观察到进程退出/启动失败 | `{pain:"crash", module, code:"exit-1", at}` |
| 2 | **调用方疼痛** | 任何模块调用对端失败（ECONNREFUSED / timeout / 契约不符） | `{pain:"unreachable"\|"timeout"\|"contract", module:对端, by:自己, at}` |
| 3 | **慢兜底** | 控制器每 5 分钟**只查 last-seen 超 5 分钟的模块**（不轮询全部） | 同上，`pain:"silent"` |

上报通道：`POST http://127.0.0.1:9339/pain`（本机、JSON、无鉴权但只监听 127.0.0.1），落地 `logs\pain.jsonl`，一行一条。

## 二、闭环（四步，顺序不许变）

```
疼痛(pain) → 缩回(retract) → 自愈(heal) → 复验(verify) → 摘牌(restore)
```

1. **缩回**：把模块标 `degraded`；`/capabilities` 里摘掉它的能力；写一行 `retract` 到 `logs\heal.jsonl`。
   —— 目的是**先止血**：调用方立刻知道"这条腿暂时别用"，而不是继续撞墙等超时。
2. **自愈**：只允许 B 档——`transport/crash` 且模块在 supervisor 监护表里 → 请求 supervisor 重启；`contract`/`module` **只报不动**。
3. **复验**：重启后每 3s 探一次、最多 30s，必须回采 `ok` 才继续。
4. **摘牌**：复验通过 → 标回 `ok`，能力表恢复，写 `restore`；复验失败 → `escalated`（升级给人），**保持 degraded**，不许自动再试第二轮。

## 三、要交付什么

1. `E:\DeepFish\avatar\pain-bus.mjs`（新）：监听 **9339**，收 `/pain`、写 `logs\pain.jsonl`、内存里维护每模块最近状态与 last-seen；提供 `GET /pain/status`（给看板读）。
2. `<工作区>\scripts\self-heal.mjs`（新）：
   - 默认 `--watch`（常驻，监听 pain 事件）；`--once` 手动跑一次；`--json`；`--dry-run` 只看不动。
   - 执行 §二 四步；退出码：`0` 无需动作 ｜ `1` healed ｜ `2` escalated ｜ `3` 执行错误。
   - 审计 `logs\heal.jsonl`：`{t, module, pain, act, verify:{ok,verifyAt,recoveredInMs}, result}`。
3. **调用方埋点（最小集）**：`relay.mjs` 调 `body` 失败时、`bridge` 调 DSH 失败时，各发一条 pain（这两处最容易真出事）。
4. `steady-board.mjs` 增加一行：读 `GET /pain/status`，显示「最近疼痛 / degraded 模块」，没有就 `无`。

## 四、验收

1. **真崩溃**：`kill` 9337 探针 → supervisor 报丧 → heal 收到 → 缩回 → 重启 → **复验通过** → 摘牌；`logs\pain.jsonl` 与 `logs\heal.jsonl` 各有对应行，且 `recoveredInMs` 有值；
2. **调用方疼痛**：把 relay 指向一个关掉的 body 端口跑一次调用 → 产生 `unreachable` pain（不必真崩）；
3. **复验失败**：让某模块启动即退（或用 `--dry-run` 模拟）→ `escalated`、保持 degraded、**只动作 1 次**；
4. **慢兜底**：让某模块 6 分钟不发任何事件（可临时屏蔽）→ 5 分钟兜底产出 `silent` pain；
5. `steady-board` 能显示疼痛/降级状态；
6. 交付 `records\交付\04-20261028-D6.md`（覆盖旧同名文件），路径报 01。

## 五、边界

- 纯新增三个文件（pain-bus / self-heal / 埋点处的最小改动）；**不碰 bridge.js 主干逻辑**（D6-v1 里的"埋点"只加两处 try/catch 上报）。
- 不做 C 档动作（不改配置、不换代）。
- pain 总线只监听 127.0.0.1，不对外暴露任何数据。
