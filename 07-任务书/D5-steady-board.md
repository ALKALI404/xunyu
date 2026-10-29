# 工单 D5 · 稳态看板 v0（派 04）

> 派单 2026-10-28 16:32 本体｜依据 `docs\内稳态清单-2026-10-28.md`

## 一、要什么

新增 `<工作区>\scripts\steady-board.mjs`（**纯新增**）：把七个回路里**现在就能取到数**的三个采下来，输出一张小表 + 一行结论，供 00 在 22:30 日结里引用。

```powershell
node scripts\steady-board.mjs          # 表格 + 一行结论
node scripts\steady-board.mjs --json   # 机读
```

| 回路 | 指标怎么取 | 阈值 | 越界结论 |
|---|---|---|---|
| 1 存活 | 复用 `module-doctor` 的采集（import 它的 collect，或调它的 --json） | 任一模块 transport 红 | FAIL |
| 2 投递 | `bridge.out.log` 里最近 1 小时 `[投递]` 行的「已确认 / 未确认 / 重投」计数 | 未确认率 >5% | WARN |
| 7 一致性 | `state\trace.jsonl` 各模块最近一条的时间差 | 静默 >30 分钟 | WARN |

**回路 4/5/6 先留桩**（打印 `未接入`），别去实现。

## 二、输出样式（一行结论最重要）

```
A=0  B=0  C=0 ｜ 存活 OK ｜ 投递 未确认 0/12 ｜ trace relay 58s / body 58s / wecom 9m
结论: STEADY（今日无需干预）
```

## 三、验收

1. 正常运行 + `--json` 可解析，各贴输出；
2. **负向**：把 trace 文件临时改名 → 一致性必须 WARN 而不是崩；
3. 交付 `records\交付\04-20261028-D5.md`，路径报 01。

## 四、边界

- 纯新增；不改 `module-doctor` 以外的任何脚本（可以 import 它）。
- 不写日志文件、不起服务、不发消息——**看板只读**。
