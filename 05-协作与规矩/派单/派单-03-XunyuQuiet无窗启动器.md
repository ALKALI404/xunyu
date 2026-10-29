# 派单 · 03 维护 · XunyuQuiet 无窗启动器（统一改造）

> 派单人：01（总务 / 调度）　收单人：03（维护）
> 立单：2026-10-26 23:5x（口径来自本体 23:22 转达、主人批）
> 状态：**已备单·挂起**——等 03 交完「3100 存活 + 父进程链」重验（本单 A 单）后立刻投递。
> **开工时间：明早**。今晚不许动手，不许熬。
> 先读诊断报告再动手：`<Xunyu根>\docs\cmd窗口-诊断报告-20261026.md`

---

## 一、六字段（一条一行）

| 谁 | 什么 | 状态 | 证据指针 | 下一步 | 卡点 |
|---|---|---|---|---|---|
| 01 | 备好 XunyuQuiet 无窗启动器派单，挂起等 03 交重验后投递 | doing | 本文件；`state\notes-from-01.md` 台账行 | 03 交重验 → 立即投递 | 等 03 重验结果 |

## 二、任务（本体 23:22 定，四件 + 一条顺手修）

1. **做 `E:\DeepFish\avatar\bin\XunyuQuiet.exe`**（C#，二十行足够）：参数是完整命令行，内部 `CreateProcess` 带 `CREATE_NO_WINDOW`（允许再加 `DETACHED_PROCESS` 或 `CREATE_BREAKAWAY_FROM_JOB`，见第四节），**从机制上不可能出现控制台窗口**。用现成的 `csc` 编译——窗口 exe（`ChatWindow.cs`）那次跑通过同一套流程，照它来。
2. **改用它启动**：supervisor、bridge（替换 `start-hidden.vbs` 那一层）、SnowLuma、记忆流水线（daily / catchup）、memory-backup。
3. **计划任务全部改成 `XunyuQuiet.exe <command>`**：目前 `XunyuAvatarSupervisor`、`XunyuAvatarSupervisorGuard`、`XunyuMemoryBackup` 三个还是 `powershell -WindowStyle Hidden`——**隐藏 ≠ 无控制台**，仍可能闪。三个都要换。
4. **顺手修 `start.bat` 的 `pause`** → 改成 `exit /b 2`：重复启动时它会在隐藏控制台里无限等待，看不见，但会挂一个进程不走。

## 三、验收（缺一条不算完）

1. **手动触发五个任务各一次，全程无可见窗口**——给窗口枚举证据（列举当时的可见窗口 / 截图比对），不能只说「没看到」；
2. **停掉 bridge / SnowLuma / supervisor 三件，用新启动器拉起**，贴三项证据：`3100` 监听、`3001` 监听、进程存活（pid + 进程名），**并附父进程链**证明父进程不在 DSH 进程树里；
3. **重启 DSH 后三件仍活**（这是它原本的验收，一起交）。
4. **【前置条件，不是附加项】启动器必须把子进程 pid 落盘**：写 `avatar\state\services.json`，至少含 **服务名 / pid / 启动时间 / 命令行** 四项。理由：`DETACHED_PROCESS` 拉起后没有父进程能收尸，不留 pid 就等于没人知道它活着、没人能精确杀掉它。
5. **【前置条件】必须能在不依赖父进程的情况下判断活没活**：端口探 + pid 探双保险（supervisor 现有 `Test-Http` 可复用），两条任一为假即判死并给出可读原因。

## 四、手段放开，验收不变

如果 03 判断 `DETACHED_PROCESS` 风险大，允许改用 **`CREATE_NO_WINDOW` + `CREATE_BREAKAWAY_FROM_JOB`**（不带 DETACHED）。只要同时满足这三条，用什么手段由 03 定：

- 无窗口；
- **DSH 重启后不被带走**；
- **pid 可查**。

**选 BREAKAWAY 的额外要求**：必须证明**不会随 Job 关闭被连带**（DSH 重启时 Windows 会关 Job）——给一条实测：**DSH 重启前后 pid 不变**。

## 五、交付与记录

- 交付三行固定顺序：**改了什么 / 怎么验的（命令或返回原文）/ 怎么回滚**，缺一行算没交付；
- 证据只认「文件:行号」或「命令输出原文」；
- 做完给 00 记档；
- `工作组职能划分.md`、`交接流程.md` 里要写「统一用 XunyuQuiet 启动」——**这两份归 00 落笔，03 只交文本**（写清改哪节、写什么）。

## 六、不属于本单（别顺手改）

- `dsh.baseUrl` 端口写死那件事：**另一件**，归 04，本单只碰启动方式，不碰端口解析。
- 主体代码 / 桥接业务逻辑：不碰。
