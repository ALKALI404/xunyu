# UG-028-impl · 程序化实施方案（实现）：按方案 v1.1 落第一批可执行动作

> 建单 2026-10-30 由 01（派生自 UG-028 方案票，方案已一审通过）｜目标工号 05｜项目/功能域 upgrade/ug-gate
> **五要素**：做什么 / 预期结果 / 可验方式 / 边界 / 回滚

## 接口契约

**接口未变**（本单只落地文档里已定义的脚本开关，不新增路由）：

沿用方案 v1.1 已定的三个入口，签名不动：
```
node scripts\worklist.mjs <list|pending|dispatch|accept|reject>   # 已有
node scripts\budget-gate.mjs                                       # 已有
node scripts\rotate.mjs --worker <NN> --auto                       # 已有
```
**新增的只是「调用顺序与前置校验」**（方案 §5 的 5 步）：
1. dispatch 前先跑 `worklist.mjs pending` 与 `budget-gate`
2. dispatch 前校验任务书接口契约非空（已有 `no-contract` 闸）
3. accept 前强制 `check-delivery`
4. 每步失败写 `logs\procedural.jsonl`（一行一步）
5. 任一步失败即停，不继续后续步

## 0.5 预期结果

`scripts\procedural-run.mjs --once` 一条命令跑完「查 pending → 查预算 → 校验契约 → 派单 → 记日志」，失败即停并说清停在哪步。

## 1. 做什么

按方案 v1.1 §5 落一个 `scripts\procedural-run.mjs`：串起「pending 审核 → 预算闸 → 接口契约闸 → 派单 → 审计日志」五步，每步结果写 `logs\procedural.jsonl`，失败立即停并打印步号与原因。

## 2. 预期结果

- 一条命令能跑完一轮派单准备，且**每步都有日志行**；
- 任一步失败时，**后面几步不执行**（fail-fast，不是尽力而为）；
- 不改变现有 CLI 的任何行为（只是组合调用）。

## 3. 验收与判据

- ① **全绿一轮**：`node scripts\procedural-run.mjs --once` → exit 0，`logs\procedural.jsonl` 新增 5 行（step1..step5，每行含 `{t,step,ok,detail}`），贴行；
- ② **fail-fast（反例，必须做）**：把预算闸设成锁（或把某一票的任务书契约清空），再跑一次 → **exit≠0**，日志**只到失败那步为止**（后面步不写），贴日志行数与 stderr；
- ③ **不改变现有行为**：跑完后 `node scripts\worklist.mjs list` 的输出形状与跑前一致（贴摘要一行）。

## 4. 边界

- **只新增** `scripts\procedural-run.mjs` + `logs\procedural.jsonl`；
- **不改** `worklist.mjs`/`dispatch-core.mjs`/`budget-gate.mjs` 的现有逻辑（只调用）；
- 不改台账结构、不改闸门阈值、不动名册；
- 要协调找 01。

## 5. 回滚

新增文件，删掉 `scripts\procedural-run.mjs` 即回滚；`logs\procedural.jsonl` 可直接删。无不可逆动作。

## 6. 交付

`records\交付\05-<YYYYMMDD>-UG-028-impl.md`，五段式。

## 7. 已知背景

方案 v1.1 已一审通过（`docs\升级\程序化实施方案-2026-10-30.md`：§8 回滚 5 命令、§9 四步中止、§10 十二进程核对表）。这单只做 §5 的串联脚本，不做新机制——**别再设计一遍方案**。
