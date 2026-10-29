# 工单 D10 · 任务状态机 + 01 审核 + 中断改派（派 04·代码，扩 workdesk）

> 派单 2026-10-28 17:05 本体｜在 D8（workdesk 9340）之上扩展
> 红线照旧：**展示、审核、改列表全部零 token**；只有「派活」和「中断改派」两次动作才允许碰 DSH。

## 一、单一真相：`state\worklist.jsonl`（新增，一行一条变更，可回放）

```json
{"t":1793...,"id":"W-012","op":"add|state|reorder|drop","from":"04|01|本体|主人",
 "state":"inbox|proposed|queued|doing|done|dropped","target":"03","title":"…","note":"…","src":"mail#7|task:D8|manual"}
```

- 当前状态 = 回放最后一条同 id 的 `state`；
- `state\tasks\*.md` 保留为**附件**（详细要求），worklist 只存索引与状态；
- 邮件转任务：`src=mail#<seq>`，**必须经 01 审核**才从 `inbox` → `proposed` → `queued`。

## 二、01 的审核入口（CLI，免费）

```
node scripts\worklist.mjs pending                 # 看待审
node scripts\worklist.mjs approve W-012 [--target 03]   # 通过并指定工号 → queued
node scripts\worklist.mjs reject  W-012 --note "重复/不需要"
node scripts\worklist.mjs add --title "…" --target 04 --note "…"    # 00/01/本体都能加
node scripts\worklist.mjs move  W-012 --to top|bottom
node scripts\worklist.mjs drop  W-012 --note "做错了/不做了"
node scripts\worklist.mjs list [--by 04]
```

## 三、workdesk 页面要显示的（扩 D8）

每个工号一行：
**工号 | 忙/闲 | 正在做什么（workingActivity.line） | 排队 N 条（列前 2 条标题） | 卡点**

右侧邮件池保留，但加一列「审」：`待审` 的邮件旁边一个按钮（调 `approve/reject`，把邮件 → 任务）。

## 四、中断与改派（唯一花钱的两条，必须显式确认）

1. **派活**：`POST /api/dispatch {id}` —— 仅当目标 `running=false` 且该任务 `queued`；调用一次 `session/prompt`（内容 = 任务票号 + 一句话），写 audit；
2. **中断改派**：`POST /api/preempt {id, cancelFirst:true}` ——
   - 先 `session/cancel`（本地 RPC，免费）；
   - 再 `session/prompt` 说明「别做 X 了，改做 Y（票号）」；
   - **必须带 `confirm:"<id>"`**，否则 400；
   - 写 `logs\heal.jsonl` 或新的 `logs\dispatch.jsonl`：谁触发、哪条任务、目标工号、时间。
3. **配额**：每天最多 `dispatch 20 / preempt 5`，超了返回 429 并记一行；配额值写在 `state\workdesk.config.json`。

## 五、验收

1. `worklist.mjs pending/approve/reject/list` 各跑一次，贴输出；伪造一个 `W-xxx` 走完 `inbox→queued→doing→done`；
2. 页面能显示「忙/闲 + 正在做什么 + 排队前 2 条」，贴截图或 HTML 片段；
3. `dispatch` 一次（挑一个空闲工号）→ 该会话真起一轮；`preempt` 一次（对正在跑的 03/04）→ 先 cancel 再改派，贴两段日志；
4. **零 token 证据**：只浏览页面、只审核、只改列表，10 分钟内不产生任何 DSH 回合；
5. 交付 `records\交付\04-20261028-D10.md`，路径报 01。

## 六、边界

- `preempt` 一旦做错就是打断别人干活——**默认关闭**，必须 `confirm` 参数精确匹配任务 id。
- 不实现「自动批准」；审核永远是人（01）。
- 配额、审计缺一不可。
