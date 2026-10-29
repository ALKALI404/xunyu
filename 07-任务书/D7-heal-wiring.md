# 工单 D7-v2 · supervisor 报丧 + 受控重启入口（派 03·维护）

> 2026-10-28 17:02 改口径（主人定：疼痛链路，不长期监测）。原 D7 的「每 5 分钟跑一次」作废。

## 一、你要提供的两样

### 1. **报丧（监督者这一路 pain 来源）**

supervisor 现在是"发现死了就重启"，改成**同时把这件事报出去**：

- 进程退出 / 启动失败 / 重启成功，各发一条到疼痛总线：
  `POST http://127.0.0.1:9339/pain`
  ```json
  { "pain": "crash", "module": "relay", "code": "exit-1", "at": 1793..., "by": "supervisor" }
  ```
- 重启成功也报一条（`pain:"restart-ok"`），让控制器能对账；
- **不许**因为总线没起来就卡住或崩：发不出去就吞掉 + 写一行自己的日志。

### 2. **受控重启入口**

- `127.0.0.1:9338/heal?module=<name>`（POST），**只接受本机**；
- 白名单：`relay / body / bridge / probe / snowluma / window`；
- **幂等**：同一模块 60s 内重复请求只回「冷却中」，不叠加重启；
- 每次请求写一行审计（谁、何时、结果）。

## 二、常驻怎么起

`self-heal.mjs --watch` 由 **supervisor 托管**（跟探针同级），不再用 5 分钟计划任务；
若 supervisor 拉起它，也要在它退出时**报丧**（它是控制器，死了等于没人自愈）。

## 三、验收

1. `curl -X POST "http://127.0.0.1:9338/heal?module=relay"` → 返回结果；60s 内再来一次 → 「冷却中」；`module=xxxx` → 拒绝；
2. `kill` 9337 → `logs\pain.jsonl` 出现 `crash/exit` 一条（由 supervisor 发出），随后 heal 把它拉回并报 `restart-ok`；
3. 总线停掉时 supervisor 不崩（杀掉 9339 试一次，贴日志）；
4. 交付 `records\交付\03-20261028-D7.md`，路径报 01。

## 四、边界

- 只动 supervisor + 计划任务；不碰 bridge.js、不改 self-heal.mjs（04 的）。
- 若计划任务/守护改动被权限拒，照实报「需主人手动」，给可直接双击的 .vbs。
