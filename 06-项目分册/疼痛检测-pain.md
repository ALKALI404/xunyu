# 项目：疼痛检测 / 自纠正（pain-heal）

> 状态：**独立模块**（2026-10-28 v1：疼痛链路 + 自愈 + 复验）｜负责人：04（协议与执行器）/ 03（守护侧）
> **演进**：桥接的「守护拉起」以后算本项目的子项目（见 §8）。

## 1. 定位
让系统**自己发现自己坏了**：谁疼谁报，先缩回再自愈，**必须复验**才算好。不是监控大屏，是反射弧。

## 2. 边界
- **属于我**：`avatar\pain-bus.mjs`（9339）、`DSH_workspace\scripts\self-heal.mjs`、`logs\pain.jsonl`、`logs\heal.jsonl`、两处调用方埋点（relay 调 body、bridge 调 DSH）。
- **不碰**：`supervisor.ps1` 的判定逻辑（那是 03），`bridge.js` 主干（只许两处 try/catch 埋点）。

## 3. 架构
```
生产者(三源) ──POST /pain──▶ pain-bus(9339) ──▶ logs\pain.jsonl
                                  │
                                  ▼
                            self-heal --watch
                                  │
        缩回(标 degraded/摘能力) → 自愈(只B档:请求 supervisor 重启)
                                  → 复验(3s×最多30s) → 摘牌 / escalated
```

**三源**：①supervisor 报丧（进程退出/启动失败）②调用方疼痛（ECONNREFUSED/timeout/契约不符）③慢兜底（5 分钟只查 last-seen 超时，**不轮询全部**）。

## 4. 数据流
pain 事件（JSON 一行）→ 总线落盘 + 内存状态 → 执行器按模块取最新事件 → 动作 → 复验结果写 `logs\heal.jsonl`。
**花钱**：只在「自愈后需要重新起 DSH 回合」时才会，默认不碰。

## 5. 接口

| 接口 | 方法 | 说明 | 花钱 |
|---|---|---|---|
| `POST 9339/pain` | POST | `{pain, module, code, at, by}` | 否 |
| `GET 9339/pain/status` | GET | 各模块最近状态与 last-seen | 否 |
| `POST 9338/heal?module=` | POST | supervisor 受控重启（白名单 + 60s 冷却 + 审计） | 否 |

## 6. 状态与存储
- 模块状态：`ok | degraded | escalated`（内存 + pain 日志可回放）；
- 规则：`contract` 层只报不动；`module` 层只报；`transport/crash` 才重启；
- **复验失败 → 保持 degraded + escalated，不许第二轮**（防抖）。

## 7. 依赖
- 依赖 supervisor 的报丧与 9338 入口（03 提供）；
- 被依赖：workdesk 的「一致性」回路、稳态看板。

## 8. 演进（归属要说清）
- **v1（现在）**：疼痛 + 自愈 + 复验，三源齐。
- **v2**：接常驻（self-heal --watch 由 supervisor 托管）+ 真实演练（kill 9337 → healed + 复验时间）。
- **v3（主人指定）**：**把「桥接的守护拉起」并入本项目，作为子项目** —— bridge 进程由 supervisor 拉起、退出即报丧、拉起失败升级；也就是说「bridge 的守护」不再算 03 的维护杂项，而是疼痛检测的一个子场景。
- 迁移时要动：`supervisor.ps1` 的 bridge 分支、pain-bus 的 module 白名单、本文件 §3 的图。

## 9. 排障
| 症状 | 先看 | 命令 |
|---|---|---|
| 没人报丧 | supervisor 有没有发 /pain | `tail logs\pain.jsonl` |
| 报了但没动 | self-heal 在不在跑 | `ps` 看 self-heal；`logs\heal.jsonl` |
| 动了但没好 | 复验失败记录 | `logs\heal.jsonl` 里 `result=escalated` |
| 缩回了没摘牌 | 复验成功但没 restore | 查 heal 日志的 `restore` 行 |

## 10. 维护
实现：04（协议/执行器）、03（守护侧）。文档：05。改状态机或三源必须同步本文件。
