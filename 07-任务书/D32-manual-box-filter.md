# 工单 D32 · 待人工箱过滤已作废与夹具（派 06）

> 派单 2026-10-28 18:30 本体｜B 单：修 workdesk 的「方案审核 / 人工待审核箱」聚合

## 1. 做什么

`workdesk-server.mjs` 的 plan/manual 聚合与页面渲染加过滤，**三条**：

1. **排除 `state=dropped`** 的票——已作废的不许出现在「待人工 / 方案审核」；
2. **排除夹具票**：标题以 `【D28 验收】`/`【D29 验收】`/`【D30 验收】` 开头，或 ticket 形如 `D29V*`、`D30A*`、`D30B*`；
3. 方案审核栏只显示 `planState ∈ {待审, 01审中, 转05, 待人工, 驳回}` **且** `state ≠ dropped` 的票。

## 2. 什么算过

- 现在 API 返回的 `plan.manual` 有 **6 条**（W-034/035/038/039/040/041，全是夹具）→ 改后**必须 0 条**；
- 页面「待人工」栏同步变空，并显示「暂无待人工」；
- 造一条**真**待人工票（`plan-reject` 一张非夹具票）→ 必须显示出来；
- 贴改前/改后 `/api/worklist` 的 `plan.summary` 与 `manual` 长度对比。

## 3. 能碰哪些文件

- 只改 `<工作区>\scripts\workdesk-server.mjs`（聚合 + 页面渲染）；
- **不碰** `worklist-core.mjs`、`dispatch-core.mjs`、状态机语义、`bridge.js`。

## 4. 怎么回滚

- 改前 `copy workdesk-server.mjs backup\workdesk-server-<日期>.mjs`；
- 出问题 copy 回来并重启 9340（kill 后 supervisor 不监护它，需手动起：`node scripts\workdesk-server.mjs`）。

## 5. 交付

`records\交付\06-20261028-D32.md`，第一行 `类型: 实现`，五段式（含「效果与证据」）。
