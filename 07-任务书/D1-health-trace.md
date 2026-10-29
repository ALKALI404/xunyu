# 工单 D1 · 观测层第一步：relay / body / 企微 加 health + capabilities + trace（派 03·维护）

> 派单：2026-10-28 16:00 本体·b6eb5c94｜交单：`session-c6bfe011`（03·维护）
> **顺序：先把 C1（定时弹窗）交掉，再做这张**——两张都要重启服务，不许交叉。
> 契约（唯一口径）：`docs\模块契约-v0.md`

## 一、目标

三个模块能被问三件事：**活着吗 / 会什么 / 刚才那次卡在哪**。

| 模块 | 端口 | 文件 |
|---|---|---|
| relay（窗口中继） | 9334 | `E:\DeepFish\avatar\relay.mjs` |
| body（身体服务） | 9335 | `E:\DeepFish\avatar\body-service.mjs` |
| 企微回调桥 | 8788 | `E:\DSH-WeCom\bridge\src\server.mjs` |

## 二、每个模块要加的三样

1. **`/health` 补齐契约字段**：`ok / module / version / port / uptimeMs / ts / checks{}`。
   - **老字段一个都不许删**（relay 的 `targets`、body 的 `adapter`、企微的 `corpId/target` 都保留）。
   - `ok=false` 时必须带 `error:{layer,code,detail}`，`layer ∈ contract|module|transport`。
2. **`/capabilities`**：列出本模块能力（`cap` 用 `<模块>.<动词>`，如 `relay.push`、`body.say`、`wecom.inbound`），带 `kind: action|query`。
3. **trace 落地**：`<工作区>\logs\trace.jsonl`，一次调用一行：
   `{"t":..,"trace":"tr-xxxx","module":"relay","cap":"relay.push","ms":12,"ok":true}`
   - 至少覆盖：relay 的每次推窗、body 的 `/say` 与 `/anim`、企微的 `/wecom` 入站。
   - 出错行带 `layer/code/detail`。

## 三、验收（缺一条都算没交）

1. `curl http://127.0.0.1:9334/health`、`9335/health`、`9335/capabilities`、`8788/health`、`8788/capabilities` —— 全部 200 且含契约字段；
2. `trace.jsonl` 里能捞出三个模块各自至少 1 行（贴 grep 结果）；
3. 原来的调用**一个都不影响**：窗口能正常推、`body /say` 能说话、企微 `/health` 与 `/stats` 照旧；
4. 每个模块重启一次，**必须由 supervisor/看门狗拉回**并记 pid 与时间；
5. 交付写 `records\交付\03-20261028-D1.md`（四段式），路径报 01。

## 四、边界

- **只加不改**：不动既有分支逻辑、不改返回结构、不删字段。
- 不碰 `bridge.js`（那是上游模块，本体管）。
- 改完先 `node --check`，再重启；起不来立刻回滚到改前文件（自己留一份 `.bak`）。
