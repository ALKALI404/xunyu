# D8 v0.1 · 工作台 DEMO（最小可看，先上线再迭代）

> 2026-10-28 主人定，01 转达。**这是缩水版，不要按原 `D8-workdesk.md` 全量做。**
> **D10（worklist 状态机）、D11 一律冻结**，不许并行做。
> 红线：**禁止 `session/prompt`**；只读本地 RPC 与文件；页面不引任何外网资源。

## 一、服务端 `scripts\workdesk-server.mjs`

监听 `127.0.0.1:9340`，三个**只读**接口：

| 接口 | 返回 |
|---|---|
| `GET /api/agents` | 每个工号：忙/闲、正在做什么（`workingActivity.line`）、空闲时长 |
| `GET /api/tasks` | `state\tasks\*.md` 里**没有对应交付**的活（有没有 `records\交付\*` 对应） |
| `GET /api/mail` | 邮件池内容 + 各 agent 未读数 |

## 二、页面 `GET /`

- 单文件（HTML/CSS/JS 全内联，不引 CDN）；
- 三栏：**谁在干什么 / 未完成的活 / 邮件池**；
- 每 5 秒自动刷新（`setInterval` + fetch，别用 SSE）；
- 顶部标签：**工作组 / 鲟鱼 / DSH**，后两个先占位（点了不报错即可）；
- 底部一行「最近交付」：`records\交付\` 最新 5 个文件名，**只列文件名，不做状态认领**。

## 三、v0.1 明确不做

worklist 状态机、01 审核、dispatch、preempt、交付自动认领、配额、审计。等 demo 上线、主人看过再排。

## 四、验收（降到三条）

1. 浏览器打开 `http://127.0.0.1:9340/` 能出页面，三栏有内容；
2. 能看到「谁在干什么」（至少 00/01/03/04 中三个有名字与忙闲）；
3. 能看到未完成的活 + 邮件池；
4. 贴 `curl -s http://127.0.0.1:9340/api/agents` 的输出前 5 行，和 `Get-NetTCPConnection -LocalPort 9340` 的 pid。

## 五、交付

- 代码：`scripts\workdesk-server.mjs`（单文件，含内联页面）；
- 回执：`records\交付\04-20261028-D8v01.md`，含上面第 4 条的输出；
- 交给 01 汇总（工号不直接找本体）。
