# 工单 D34 · 花费日报 / 周报 / 月报（派 04）

## 1. 做什么

新增 `scripts\cost-report.mjs`（纯新增），产出三档报表，**全部本地计算、零 token**：

```powershell
node scripts\cost-report.mjs --daily            # 今天（默认）
node scripts\cost-report.mjs --weekly           # 本周（周一起）
node scripts\cost-report.mjs --monthly          # 本月
node scripts\cost-report.mjs --daily --write    # 落盘到 state\reports\
```

**报表内容（Markdown 表格 + 一行结论）**：

- 区间（起止时间，北京时间）、轮数、命中/未命中/输出、命中率、¥；
- **按归属分桶**（本体 / 工作组 / QQ 通道 / 其他）——归属读 `state\attribution.json`（00 维护），读不到就显示「未登记」；
- **按会话 Top 5**：label、区间内起止时间、¥、占总额百分比；
- **对比**：日报对比昨天、周报对比上周、月报对比上月（涨跌百分比）。

落盘路径：`state\reports\cost-daily-YYYY-MM-DD.md`、`cost-weekly-YYYY-Www.md`、`cost-monthly-YYYY-MM.md`。

## 2. 什么算过

- 三种档位各跑一次，贴输出；
- `--write` 后文件存在且含区间、分桶、Top5、对比四段；
- 与 `token-report.mjs` 同区间数字**误差 < 2%**；
- 不新增依赖、不调用任何 DSH 会话/模型（零 token 证明：跑一次前后 `token-usage.jsonl` 不新增行）。

## 3. 能碰哪些文件

- 新增 `scripts\cost-report.mjs`；可复用 `token-report.mjs` 的读取与计价逻辑（抽公共函数放 `scripts\cost-core.mjs`）；
- **不碰** bridge、状态机、workdesk 的既有路由。

## 4. 怎么回滚

纯新增文件，删掉即可；若抽了 `cost-core.mjs`，token-report 里保留原实现作为兜底（或改前备份）。

## 5. 交付

`records\交付\04-20261028-D34.md`，第一行 `类型: 实现`，五段式。
