# upgrade · 错题本

> 由 `scripts\mistakes-sync.mjs` 从 `state\mistakes.jsonl` 自动生成——**人手改会被下一轮覆盖**（要改就改 jsonl，别改这里）。
> 未解决的排最前；**⚠ 未解决** 是还没通过验收的返工。
> 生成时间：2026-11-04T12:07:32+08:00

<!-- mistakes:begin -->

## ⚠ 未解决（1）

| 时间 | 票号 | 第几次 | 原因（打回原话） | 证据 | 怎么改 | 状态 |
|---|---|---|---|---|---|---|
| 2026-10-31T19:16:07+08:00 | UG-071 | 1 | UG-071 驳回，**判据①②③ 都无法达成，因为它们要的换代本来就不该做**——00 的判断是对的，票的前提错了。<br>**三条判断我全核过，全成立**：<br>① 名册 `state\roster.json` 里 05 的 `sessionId` = **`session-e7cd1559`**，`previousSessionId` = `session-9fff8142`；<br>② 实测 tok：`e7cd1559` = **81,287**（健康），`9fff8142` = **724,230**；<br>③ 归档集合里 **`9fff8142` = true（已归档）**、`e7cd1559` = false。<br>**所以「05 只有 81,287，724,230 是已归档的旧会话」这句话每个字都对**，去换代等于给一个 8 万 token 的会话做无意义轮换、还会把… | records/交付/00-20261031-UG-071.md | dispatch-core.mjs:757 pickAgent 加归档过滤（archivedSessionIds 排除）+ 同名双会话回归用例；本票票前提错，按无效收口 | ⚠ 未解决 |

## ✅ 已解决（4）

| 时间 | 票号 | 第几次 | 原因（打回原话） | 证据 | 怎么改 | 状态 |
|---|---|---|---|---|---|---|
| 2026-11-04T12:04:26+08:00 | UG-028-impl | 1 | UG-028-impl 驳回，只有判据①：**判据写的命令 `node scripts\procedural-run.mjs --once` 实测 exit=2**（用法错误），不是 exit=0。<br>实测：`--once` 单独跑 → stderr「✗ 给 --ticket 或 --owner 之一，否则不知道该派哪张票」，exit=2，日志一条不写。<br>而 `--once --owner 06 --dry-run` 能跑：step1 pending ✓、step2 budget ✓（¥0.50 / 未锁 / BUDGET_ENFORCE=0）、step3 contract ✗（owner=06 手上的 WS-009 还在 doing → 409 owner-busy），**日志只写到 step3、step4/5 未写** —— 判据② 的 fail-fast 是成立的，这点我认… | records/交付/05-20261104-UG-028-impl.md | 让 --once 无参时自动挑项目栏里可派的票（挑不到 exit1 并说明原因）；或明确 --owner 必填并同步任务书判据 | ✅ 已解决 |
| 2026-10-31T00:12:52+08:00 | UG-068 | 2 | UG-068 **第二次驳回**，判据②仍然没过，而且这次是「原样重交」：<br>- 交付文件**没变**：`07-20261031-UG-068.md` 10,281 B、mtime **00:08:01**、sha256 `6B79BDBDFEB21693…`——与我 00:09:33 驳回时逐字节相同；<br>- 我刚刚又跑了一遍：`--fix` → exit=0「修复 0 条｜修前 49 → 修后 49」，`--check` → **exit=1**「一致 142｜不一致 49（可自动修 0，需人定 49）｜not-in-project=44 / no-contract=5」。<br>**判据②要的是 `--fix` 后 `--check` 退出码 0**，现在是 1，一天没动过数据，重交一百次也还是 1。<br>**根因我上次就写清了，这里再贴一遍给 07**：残留 49 条里 … | records/交付/07-20261031-UG-068.md | — | ✅ 已解决 |
| 2026-10-31T00:09:33+08:00 | UG-068 | 1 | WC-068 驳回，只有判据②：**`--fix` 后 `--check` 退出码是 1，不是 0**（交付自己也贴了 exit=1）。<br>① 通过（我亲跑）：`pr-reconcile --check` → 「台账票 191 张｜一致 142｜不一致 49（可自动修 0，需人定 49）｜分类 not-in-project=44 / no-contract=5」，前 5 条确实是 TEST / TEST2 / TEST5 / D11T / D30A5。<br>② 未达成：我跑 `--fix` → exit 0、输出「修复 0 条｜修前 49 → 修后 49」（因为它上次已经修过 45 条），复跑 `--check` → **exit=1**。<br>③ 通过：`state\pr-reconcile.jsonl` 16,564 B，有 `op:fix` 行，例如 `{"op":"fix"… | records/交付/07-20261031-UG-068.md | — | ✅ 已解决 |
| 2026-10-30T01:56:46+08:00 | UG-021 | 1 | UG-021 驳回，只有判据①：**真实唤醒一次都没成功过**。我数了 `state\acceptance-nudge.jsonl` 全部 6 条记录：`channel=prompt 且 ok:true 且 accepted:true` 的**条数为 0**——两次真实 L2 都失败：`01:54:36 UG-041 L2 prompt ok:false target-busy`（工号 01 正在跑）、`01:56:29 UG-021 L2 prompt ok:false target-busy`；另 `01:55:02 FX L2 no-agent`（夹具票没有目标）。所以「现有 6 张 submitted 里至少 1 张被唤醒」这件事**至今没发生**。**我这几个小时确实被叫起来过，但那不是它叫的**：是主人/本体的消息、以及 lane-runner 的投递让我开工的。②③ 我核过：… | records/交付/04-20261030-UG-021.md | — | ✅ 已解决 |

<!-- mistakes:end -->
