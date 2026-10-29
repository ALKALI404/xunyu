# 工单 D33 · 花费统计加「起止时间 + 区间」（派 04）

## 1. 做什么

在 `scripts\token-report.mjs` 与 workdesk 的 `/api/cost`（新增，供 06 用）里，把花费统计变成**有时间边界**的：

1. **统计区间**：返回 `{from, to, label}`（默认当日 00:00 → 现在，北京时间），页面顶部显示「统计区间 10-28 00:00 → 18:40」；
2. **每个会话的起止**：`firstAt` / `lastAt`（该会话今天第一条/最后一条账目时间）、`spanText`（例 "17:35–18:40"）；
3. **token-report.mjs** 支持 `--from/--to`（ISO 或 YYYY-MM-DD HH:mm），默认今天；
4. 口径不变：按 `(sessionId, turn)` 分组，`cacheHit` 取 max，其余累加。

## 2. 什么算过

- `node scripts\token-report.mjs --from "2026-10-28 17:00" --to "2026-10-28 18:00"` 能出结果；
- `curl 9340/api/cost` 返回含 `range` 与每会话 `firstAt/lastAt`；
- 与既有 `--day` 结果**在相同区间内误差 < 2%**（贴两组数）。

## 3. 能碰哪些文件

- `scripts\token-report.mjs`、`scripts\workdesk-server.mjs` 里新增 `/api/cost` 路由；
- **不碰** `state\token-usage.jsonl` 的写入（那是 bridge 的事）、不碰状态机。

## 4. 怎么回滚

改前 `copy` 到 `backup\`；`/api/cost` 是新增路由，出问题把路由摘掉即可，不影响既有接口。

## 5. 交付

`records\交付\04-20261028-D33.md`，第一行 `类型: 实现`，五段式。
