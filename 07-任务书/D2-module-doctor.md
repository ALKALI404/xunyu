# 工单 D2 · `module-doctor`：一条命令看清全系统模块状（派 04·代码）

> 派单：2026-10-28 16:05 本体·b6eb5c94｜交单：`session-74c32a8f`（04·代码）
> 契约（唯一口径）：`docs\模块契约-v0.md`

## 一、要什么

新增 `<工作区>\scripts\module-doctor.mjs`（**纯新增，不许改任何现有文件**）：

```powershell
node scripts\module-doctor.mjs            # 表格 + 结论
node scripts\module-doctor.mjs --json     # 机读
```

输出一张表，每个模块一行：

| 模块 | 端口 | 端口 | health | capabilities | trace 最近一条 | 结论 |
|---|---|---|---|---|---|---|
| relay | 9334 | ok | ok | 3 项 | 12s 前 | **OK** |
| body | 9335 | ok | ok(adapter=lilith) | 12 项 | 3s 前 | **OK** |
| wecom | 8788 | ok | ok | 2 项 | 8m 前 | **OK** |
| bridge | 3100 | ok | **无探针**（要 console-token） | — | — | **待补** |
| dsh | 60540 | ok | — | — | — | 只看端口 |

## 二、判定规则（写死在代码里）

- 端口用 TCP 直连判（**别用 `Get-NetTCPConnection` 枚举全表**，慢且要权限）。
- `/health` 超时 2s；`ok:false` 时把 `error.layer` 打出来。
- `capabilities` 里 `cap` 撞车（两个模块声明同一个）→ 报 `⚠ 撞车`，并列出来。
- `trace.jsonl` 读最后 200 行，按模块算「最近一条距今多久」；超过 30 分钟标 `⚠ 静默`。
- 退出码：全 OK / 仅 ⚠ → **0**；有模块 `transport` 级失败（端口不通且无豁免）→ **1**。
- 豁免表写在文件顶部常量里：`9333`（游戏 mod，常态不开）不算失败。

## 三、验收（缺一条都算没交）

1. 正常运行：贴表格 + `exit code: 0`；
2. **负向**：临时把 8788 的探针端口改成 87899 跑一次 → 该行必须 `transport` 失败、整体 `exit code: 1`；再改回来贴第二次输出；
3. `--json` 输出能被 `node -e "JSON.parse(...)"` 解析；
4. 不新增依赖（只用 node 内置）；
5. 交付写 `records\交付\04-20261028-D2.md`（四段式），路径报 01。

## 四、边界

- **不得改**：`bridge.js`、`relay.mjs`、`body-service.mjs`、企微 `server.mjs`、任何计划任务。
- 只读探针，不做任何「自动修复」。
- 如果发现某模块 `/health` 还不合契约（03 的 D1 正在补），照实打 `不符合契约：缺 X`，**不要**替它改。
