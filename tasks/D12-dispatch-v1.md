# 工单 D12 · 工作派发 + 交付上传（v1，派 04·代码；01 督办）

> 派单 2026-10-28 17:20 本体｜前提：workdesk v0.1 demo 已上线（主人看过、认可）
> 主人原话：「先完成一版工作派发和上传的事情」
> **v1 不做 preempt（中断改派）**，那是最容易出事故的一条，留到 v2。

## 一、单一真相：`state\worklist.jsonl`

一行一条变更（append-only，回放得当前状态）：

```json
{"t":1793...,"id":"W-012","op":"add|state","from":"01|本体|主人","target":"03",
 "ticket":"D13","title":"…","state":"queued|doing|submitted|done|dropped","note":"…","src":"manual|delivery:xxx.md"}
```

- 只有两条状态跃迁需要**花钱**：`queued → doing`（派发成功）；其余全免费。

## 二、CLI（免费，给 01 和本体用）

```
node scripts\worklist.mjs list [--by 03] [--state submitted]
node scripts\worklist.mjs add --title "…" --target 04 --ticket D13 --note "…"
node scripts\worklist.mjs dispatch W-012            # 见下（唯一花钱动作）
node scripts\worklist.mjs accept   W-012 --note "通过"
node scripts\worklist.mjs reject   W-012 --note "缺自测，退回"
node scripts\worklist.mjs drop     W-012 --note "不做了"
```

## 三、派发（唯一花钱的动作，必须上锁）

`dispatch W-012` 或 `POST /api/dispatch {id, confirm:"W-012"}`：

1. 校验：任务 `queued`、目标工号 `running=false`、今日配额未超（默认 **20/日**，写 `state\workdesk.config.json`）；
2. 发一次 `session/prompt`，内容固定三段：**票号 / 一句话目标 / 交付要求**（`records\交付\<工号>-<日期>-<票号>.md` 四段式 + 路径报 01）；
3. 成功 → 状态 `doing`，写 `logs\dispatch.jsonl`（谁、给谁、哪条、时间、prompt 长度）；
4. 失败/超时 → 状态不变，返回原因（别把任务做成"已派但其实没派"）。

## 四、上传（零 token，靠目录）

1. workdesk 每 **10 秒**扫 `records\交付\*.md`（按 size+mtime 判变化）；
2. 文件名解析 `<工号>-<日期YYYYMMDD>-<单号>.md`；命中 → 对应任务 `doing → submitted`，`src=delivery:<文件名>`；
3. 解析失败 → `unlinked`（页面标黄），**不猜**；
4. 每次认领给 01 落一条邮件：`【待验收】04 交了 D12：records\交付\04-20261028-D12.md`；
5. `accept` → `done`；`reject` → 退回 `doing` 并给该工号落一条邮件说明。

## 五、页面加三处（在 v0.1 三栏基础上）

- 「未完成」栏每行加一个 **派发** 按钮（目标空闲才可点；点了先弹确认，再调 `/api/dispatch`）；
- 新增 **「待验收（01）」** 栏：`submitted` 的任务 + 交付文件链接（`file:///`）+ 提交时间 + accept/reject 按钮；
- 「unlinked」单独一条黄色提示，列出文件名。

## 六、验收

1. `worklist.mjs add` 加一条 → `list` 能看到；
2. 对一个**空闲**工号 `dispatch` → 该会话真起一轮、状态变 `doing`、`logs\dispatch.jsonl` 有记录；对**在跑**的工号 dispatch → 必须拒绝并给原因；
3. 放一个真交付文件 `records\交付\04-20261028-TEST.md` → 10 秒内 `unlinked`（无 TEST 任务）；再放一个与某任务票号匹配的 → 变 `submitted` 且 01 收到邮件；
4. `accept` 推到 `done`；`reject` 退回 `doing` 且工号收到邮件；
5. **配额**：把配额临时改成 1，连派两次，第二次必须 429 并记日志；
6. **零 token 证据**：只浏览/只加任务/只验收，20 分钟内不产生任何 DSH 回合；
7. 交付 `records\交付\04-20261028-D12.md`，路径报 01。

## 七、边界

- **不做 preempt**、不做自动审批、不做自动验收。
- 派发只允许「目标空闲」，不许排队硬塞。
- 所有花钱动作必须写 `logs\dispatch.jsonl`，缺审计视为未完成。
