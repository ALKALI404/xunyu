# 工单 D3 · 给 bridge 加「外挂探针」（派 04·代码）

> 派单：2026-10-28 16:15 本体·b6eb5c94｜交单：`session-74c32a8f`（04·代码）
> 契约：`docs\模块契约-v0.md`（唯一口径）

## 一、为什么

`bridge 3100` 是**唯一没有公开探针**的模块——`/api/status` 要 `console-token`，`module-doctor` 只能写「无探针」。
**不改 `bridge.js`**（上游魔改模块，排最后），改成**外挂一个小进程**去问它、再翻译成契约形状。

## 二、要做什么（三件）

1. **新增** `E:\DeepFish\avatar\probe-bridge.mjs`（纯新增，约 120 行内）
   - 监听 `127.0.0.1:9337`
   - `GET /health`：内部用 `state\console-token` 请求 `127.0.0.1:3100/api/status`（超时 2s），翻译成契约：
     ```json
     { "ok": true, "module": "bridge", "version": "probe-2026-10-28", "port": 9337,
       "uptimeMs": 12345, "ts": 1793..., "checks": { "upstream": { "ok": true, "ms": 8 } } }
     ```
     上游不通时：`ok:false` + `error:{layer:"transport",code:"upstream-down",detail:"3100 无响应"}`
   - `GET /capabilities`：`[{cap:"bridge.status",kind:"query"}]`（只声明"能看状态"，别吹能发消息）
   - **缓存 5 秒**：同一个 5 秒窗口内复用上游结果，别把 3100 打爆
   - **不得回显 `console-token`、任何配置值、任何消息正文**——只回 `ok / 时序 / 字段名`
2. **新增** `E:\DeepFish\avatar\start-probe.vbs`（照 `E:\DSH-WeCom\bridge\start-watchdog.vbs` 抄，`wscript //B` 无窗口拉起 probe-bridge.mjs）
3. **改** `scripts\module-doctor.mjs` 的 `MODULES`：`bridge` 行改成 `probePort: 9337`、探 health + capabilities（这是你自己的文件，允许改）

## 三、验收（缺一条算没交）

1. 前台跑 `node avatar\probe-bridge.mjs`，另开窗口 `curl http://127.0.0.1:9337/health` → 契约字段齐全、`ok:true`；
2. **负向**：加一个启动参数（如 `--upstream http://127.0.0.1:3999`）把上游指到空端口 → `ok:false` 且 `error.layer="transport"`，贴输出；
3. `node scripts\module-doctor.mjs` 复跑：**bridge 行不再显示「无探针」**，显示 health ok + capabilities 项数；
4. 交付写 `records\交付\04-20261028-D3.md`（四段式），路径报 01。

## 四、边界

- **不许改** `bridge.js`、`relay.mjs`、`body-service.mjs`、企微 `server.mjs`、计划任务、supervisor。
- 探针只读：不向 3100 发任何写请求。
- 常驻启动由本体做（用你写的 `start-probe.vbs`）；**你只负责写对**，别自己去注册计划任务（会被拒）。
