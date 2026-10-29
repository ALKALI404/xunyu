# 工单 D11 · 交付自动认领 + 推给 01（派 04·代码，扩 workdesk）

> 派单 2026-10-28 17:12 本体｜依赖 D10 的 worklist
> 红线：全程本地文件与本地 RPC，**零 DSH token**；除 D10 已有的 dispatch/preempt，不许新增喊话。

## 一、要解决的问题

01 现在看不见「谁交了、交了哪一单」——只能靠人通知。要变成：**文件一落，进度自己动，01 下次打开就看到待验收。**

## 二、做三件事

### 1. 目录监听（workdesk 内部，10 秒一次）

- 扫 `<工作区>\records\交付\*.md`，记住每个文件的 `(size, mtime)`，变了或新增才算事件；
- 文件名解析：`<工号>-<日期YYYYMMDD>-<单号>.md`，例如 `04-20261028-D10.md` → `{agent:"04", date:"2026-10-28", ticket:"D10"}`；
- 解析失败 → 记 `unlinked`（附文件名），**不要猜**。

### 2. 认领到 worklist（状态推进）

- 找到 worklist 里 `ticket` 或标题包含该单号、且 `target` 等于该工号、状态为 `doing|queued` 的那条 → 改状态为 **`submitted`**，并写 `{src:"delivery:<文件名>", note:"交付文件已落"}`；
- 找不到对应任务 → 记 `unlinked`，页面标黄；
- 同文件只认领一次（按 `size+mtime+文件名` 去重）。

### 3. 推给 01（免费）

- 每次认领成功，往邮件池落一条给 01：
  `【待验收】04 交了 D10：records\交付\04-20261028-D10.md（状态 submitted）`
- 页面新增一栏 **「待验收（01）」**：列出 `submitted` 的任务 + 交付文件链接（`file:///` 可点开）+ 提交时间；
- 01 的 CLI：`node scripts\worklist.mjs accept W-012 --note "通过"` / `reject W-012 --note "缺自测"`；
  - `accept` → `done`；`reject` → 退回 `doing` 并把 note 落进邮件池给该工号。

## 三、状态机更新（在 D10 基础上加一个态）

```
inbox → proposed → queued → doing → submitted → done
                                     ↘ dropped
```

- `submitted` = 文件已交、等 01 验收；**不许**从 `queued` 直接跳到 `done`。

## 四、验收

1. 我放一个假文件 `records\交付\04-20261028-TEST.md` → 10 秒内 worklist 出现 `unlinked`（因为没有 TEST 这单），页面标黄；删掉后恢复正常；
2. 我把真实交付文件 touch 一下 → 对应任务变 `submitted`，并给 01 落一条邮件（贴 `mail.mjs list` 那行）；
3. `worklist.mjs accept` 把它推到 `done`，`reject` 能退回 `doing` 并在邮件池里出现给工号的说明；
4. **零 token 证据**：整个过程不产生任何 DSH 回合；
5. 交付 `records\交付\04-20261028-D11.md`，路径报 01。

## 五、边界

- 只读目录 + 写 worklist/邮件池；不回写 `records\交付\` 里的文件。
- 不做自动验收（验收是人：01 或本体）。
- 解析失败一律标 `unlinked`，不许猜。
