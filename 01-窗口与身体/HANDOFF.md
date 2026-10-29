# 鲟鱼的身体 · 项目交接（2026-10-25）

> **最新一次交接（2026-10-25 22:21，工作组会话归档前写的）**：
> 见 `<工作区>\交接-2026-10-25-2221.md`（现状/落地清单/备份回退/8 条待办/踩坑），
> 全部留痕在 `<工作区>\工作日志.md`（按时间倒序）。
> 身份码 · 来源标注 · 中继自恢复的技术手册见 `docs\身份码与来源标注-留档.md`。

> 一句话：把 Steam《The NOexistenceN of Lilith》改成鲟鱼的桌面身体——她能在游戏里说话/做动作/设闹钟，外面有一个对话窗，可以分别找「鲟鱼」或「DSH」，审批也在窗口里处理。

---

## 1. 目标与架构

```
                ┌──────────────────────────────┐
   你在窗口打字 →│ chat-window.ps1 (WinForms)   │  E:\DeepFish\avatar\chat-window.ps1
                └──────────────┬───────────────┘
                               │ HTTP 127.0.0.1:9334
                ┌──────────────▼───────────────┐
                │ relay.mjs（中继，双目标）      │  E:\DeepFish\avatar\relay.mjs
                └───┬──────────────────────┬───┘
        target=xunyu│                     │target=dsh（silent，不进 QQ）
                    ▼                     ▼
        ┌───────────────────┐   ┌────────────────────────┐
        │ 桥接 bridge.js     │   │ 同一个桥接，但绑定带     │
        │ 127.0.0.1:3100     │   │ silent:true，不唤醒鲟鱼  │
        └───┬───────────┬───┘   └────────────────────────┘
            │           │
    QQ 侧鲟鱼│           │DSH 会话
            ▼           ▼
     ┌──────────┐  ┌──────────────┐
     │ SnowLuma │  │ 我们的会话    │
     │ :3001    │  └──────┬───────┘
     └──────────┘         │ HTTP 127.0.0.1:9333
                   ┌──────▼────────────┐
                   │ mod LilithAvatar  │  游戏内（MelonLoader）
                   │ 气泡/动作/闹钟     │
                   └───────────────────┘
```

---

## 2. 已完成（都实测过）

### 2.1 游戏内（mod，`E:\DeepFish\avatar\mod\`）

| 能力 | 端点 | 状态 |
|---|---|---|
| 用她的原生气泡说话 | `POST /say {text, action?}` | ✅ |
| 播动作 | `POST /anim {name}` | ✅ |
| 打开她的菜单 | `POST /chatpanel` | ✅ |
| 设闹钟/计时 | `POST /timer {minutes}` | ✅ 实测 `SetAlarm(14:21, +25min)` |
| 取消闹钟 | `POST /cancelalarm` | ✅ |
| 状态 | `GET /state`、`/ping`、`/events`、`/dump` | ✅ |

### 2.2 对话窗（`chat-window.ps1`）

- 浅色、无边框、圆角、**可拖边角缩放**（`WM_NCHITTEST`）、可拖动
- 两个联系人：**鲟鱼 / DSH**，切换清屏并各自对齐游标
- **记住上次选择**：`ui-state.json`
- **审批卡片**：有挂起时在输入框上方弹出，带「通过 / 拒绝 / 允许代批 30 分钟」
- **错误会说人话**：接口 4xx/5xx 时显示响应体里的 `error`（如「当前没有挂起的审批请求」），不再只显示 `500 Internal Server Error`

### 2.3 中继（`relay.mjs`）

- 双目标独立 sessionId + 游标（`xunyu` / `dsh`）
- `/chat`、`/lines`、`/health`、`/pending`、`/approve`、`/window`
- **会话失效自动重绑**：`/api/dsh/wait` 404 或「找不到会话」→ 清空 id/游标，等下条消息重新解析
- 鲟鱼会话按 `cwd = …\state\agents` + 最近活跃自动解析（不写死 id）

### 2.4 桥接改动（上游 `E:\DeepFish\qq-bridge-0.2.1-r1\…\src\bridge.js`）

1. **新增** `POST /api/dsh/delegation-window`（等价于 QQ 回「允许代批」）+ 加进 agent token 白名单
2. 喊话绑定支持 `silent:true`：DSH 回合结束**不唤醒鲟鱼**（回复只留在桥接里给窗口取，不进 QQ）
3. 修复审批闸门：`/api/dsh/approve` 内部调用 `handlePendingAnswer(..., isOwner)` 之前**硬编码 false**，导致永远回「审批仅管理员可操作」；已改为 `true`（授权由 `decideDelegation` 前置完成）
4. 修复失败冒充成功：审批回执失败时 `opts.rethrow` 抛回给调用方（窗口能显示真实原因，且不再往 QQ 发「请再回复一次」）

### 2.5 工程化

- 全部代码迁到 `E:\DeepFish\avatar\`（mod / 窗口 / 中继 / 工具链 / README）
- `build.ps1`：一条命令编译，`-Deploy` 自动部署并重启游戏（离线 Roslyn，不用装 .NET SDK）
- `<工作区>\启动鲟鱼.bat`：SnowLuma → 端口同步+桥接 → 中继 → 对话窗

---

## 3. 没做 / 已知问题

| # | 事项 | 现状 | 卡在哪 |
|---|---|---|---|
| 1 | **记事本**（`/memo`） | ❌ 不可用 | `MemoPanels` / `MemoQuickCapture` 是懒创建对象，`FindObjectsOfType` + `Resources.FindObjectsOfTypeAll` 都拿不到实例；你打开的「随手记」就是 `MemoQuickCapture` |
| 2 | **表情映射** | ❌ 不可用 | `LilithEmotionController` 同样找不到实例；`DriftEmotions`（合法情绪名表）读不到；探针枚举 Spine 动画名会**静默中断**（疑似原生异常） |
| 3 | **「聊聊心情」按钮接管** | ❌ 无效 | 菜单项不是 `UnityEngine.UI.Button`，补 `BoxCollider2D` 也没用（透明窗 raycast 判定不走 collider 层） |
| 4 | 真实审批端到端 | ⚠️ 未验证 | 两条 bug 已修，但只用假审批验证过闸门；**真实审批还没跑过一次** |
| 5 | 代批窗口无法主动关闭 | ⚠️ 设计缺失 | 桥接只有「开启」，没有关闭接口，只能等过期 |
| 6 | 点击角色 → 打开对话窗 | ⏳ 未做 | `/events` 已预留 |
| 7 | 开机自启 | ⏳ 未做 | 目前手动双击 bat |
| 8 | 游戏内 IMGUI 面板 | 默认隐藏 | 按 F8 可调出（调试用），不是删除 |
| 9 | 「鲟鱼」联系人 | 按工作区解析 | 发消息时才现查；她一条会话都没有时会回「还没找到鲟鱼的会话」 |

---

## 4. 接下来要做的（按优先级）

**P0 — 用真实审批验证窗口**
1. 让 DSH 侧（我这个会话）触发一次需要审批的操作（例如带 `danger-full-access` 的命令）
2. 审批挂起时，在窗口点「通过」→ 应真批下来；失败要显示真实原因
3. 注意：`/api/dsh/approve` 需要**代批窗口开着**（窗口上点「允许代批 30 分钟」）

**P1 — 记事本**
- 思路 A：直接调 `MemoQuickCapture.CaptureMemo(text)` / `CaptureScratch(text)`，不依赖面板实例（只要拿到实例）
- 思路 B：Harmony 挂一个**一定会跑**的方法（对象上没有 `Awake`/`Start`，试 `OnEnable` 或 `UpdateBlink` 之类），在进入时缓存 `__instance`
- 思路 C：从菜单项点击的委托链里反查处理器

**P2 — 表情**
- 拿到 `LilithEmotionController` 实例后，先读 `DriftEmotions` 拿白名单，再做「文本 → 情绪」映射
- 备选：直接给 `DialogueManager.Say(...)` 的 `emotion` 参数传 Spine 动画名（需先拿到动画名列表）

**P3/P4/P5** — 点击角色开窗、鲟鱼本体绑定策略、开机自启

---

## 5. 关键路径

| 用途 | 路径 |
|---|---|
| 项目根 | `E:\DeepFish\avatar\` |
| mod 源码 | `E:\DeepFish\avatar\mod\*.cs` |
| 编译 | `cd E:\DeepFish\avatar; .\build.ps1 [-Deploy]` |
| 对话窗 | `E:\DeepFish\avatar\chat-window.ps1` |
| 中继 | `E:\DeepFish\avatar\relay.mjs` |
| 窗口状态 | `E:\DeepFish\avatar\ui-state.json` |
| 依赖探针 | `E:\DeepFish\avatar\dump.txt` |
| 一键启动 | `<工作区>\启动鲟鱼.bat` |
| 游戏 Mods | `E:\SteamLibrary\steamapps\common\The NOexistenceN of Lilith\Mods\LilithAvatar.dll` |
| 桥接 | `E:\DeepFish\qq-bridge-0.2.1-r1\qq-bridge-0.2.1-r1` |
| 桥接日志 | `…\state\bridge.log` |

**端口**：mod 9333｜中继 9334｜桥接 3100｜SnowLuma WS 3001 / WebUI 5099｜DSH Web 每次重启都变

> ⚠️ 补充限制：窗口的审批（`/pending`）读的是**桥接内存里的挂起项**，只包含桥接 follow 的会话（QQ 绑定的那些）。
> 普通 DSH 会话里触发的审批只会弹在 DSH GUI，不会进对话窗。要让窗口也能批，得让桥接 follow 那个会话（或者改走 DSH 自己的审批通道）。

---

## 6. 踩坑清单（血泪版）

1. **Unity API 只能主线程**：线程池里调 `FindObjectsOfType` 会直接把游戏进程干掉。所有游戏调用走 `RunOnMain`。
2. **IL2CPP 代理要 TryCast**：`FindObjectsOfType` 返回基类代理，读不到游戏成员；用 `TryCast<T>`（运行时 `MakeGenericMethod`）。
3. **游戏窗口是穿透的**：透明置顶 + raycast 命中判定，游戏内 IMGUI 面板收不到鼠标 → 输入框必须搬到游戏外。
4. **PowerShell 5.1 要 BOM**：`.ps1` 必须 UTF-8 **with BOM**，否则中文乱码；改完记得补。
5. **`$input` 是自动变量**：不能当文本框变量名，否则点发送永远是空（踩过）。
6. **`System.DateTime` 传不进 IL2CPP**：要反射转成 `Il2CppSystem.DateTime`（见 `ToIl2CppDateTime`）。
7. **`Add-Type` 要显式引用**：编译 C# 片段时需要 `-ReferencedAssemblies System.Windows.Forms, System.Drawing`。
8. **端口占用**：新旧中继同时起会打架（新的直接退出，旧的继续服务，看起来像"改了没生效"）。
9. **桥接重启会清空内存状态**：`relayBindings`、代批窗口、`pending` 全没了，两边都要重新绑定。
10. **沙箱**：由 DSH 工具起的窗口进程写不了 `E:\DeepFish`（状态文件落不下来），要用完整权限起；用 bat 双击启动则没这问题。

---

## 7. 交接时会丢的东西（重要）

以下都是**本会话的后台作业**，归档/换会话后会终止：

- 中继（9334）
- 对话窗进程

**恢复方式**：双击 `<工作区>\启动鲟鱼.bat`（它会把 SnowLuma、桥接、中继、窗口一起拉起来）。
游戏 mod 不受影响（DLL 已在游戏目录，随游戏启动）。

---

## 8. 新会话第一件事

1. `cd E:\DeepFish\avatar`，读 `README.md` 和本文件
2. 起服务：双击启动 bat，或分别 `node relay.mjs` + `powershell -STA -File chat-window.ps1`
3. 自检：
   - `curl http://127.0.0.1:9333/ping` → `{"ok":true,...,"ver":"0.3.0"}`
   - `curl http://127.0.0.1:9334/health` → `targets` 里两个目标
   - 窗口里发一句"在吗"，看是否收到回复
4. 直接接着做 P0（真实审批验证）

---

## 9. 本体（M1，2026-10-25 16:15）

**本体是什么**：一个独立的 DSH 会话，cwd = `E:\DeepFish\avatar\body`，preset = `standard`（有文件/命令工具）。

| 项 | 值 |
|---|---|
| 会话 id | `<session-id>` |
| 登记文件 | `avatar\state\owner-session.json`（中继启动时读取，别删） |
| 人格 | `body\roles\鲟鱼.md` |
| 硬约束 / 口吻 | `body\notes\constraints.md` / `body\notes\style.md` |
| 记忆快照 | `body\memory\snapshot.md` |
| 启动流程 | `body\BOOT.md`（自检后写 `body\state\boot.json`） |
| 建会话脚本 | `<工作区>\create-body-session.mjs`（幂等，读 owner-session.json） |

**接线**
- 窗口「鲟鱼」页签 → 中继 9334 → 桥接 `/api/dsh/say` → 本体
- QQ 私聊 `<主人QQ>` → `state\sessions.json` 映射到本体会话（`sessionPolicies` 必须是 `["reserved2","standard",null]`，否则桥接会判「权限已变化」并归档该会话）
- 桥接 `config.json` → `socialV2.ownerPreset = "standard"`（原来是 qq-chat-owner，没有文件工具）

**本轮补的补丁（都很关键）**
1. 桥接 `/api/dsh/say`：`origin=relay` 时跳过「先复述再确认」的 QQ 喊话协议（窗口是正常对话）。
2. 桥接事件循环：即使会话绑定了 QQ，也把回合文字收集给中继（否则本体一接 QQ，窗口就收不到回复）。
3. 中继：令牌失效自动重读（桥接重启会换 token，原来只在启动读一次 → 502）。
4. 中继：`404 没有活跃的中继绑定` 不再清 sessionId（否则登记好的本体被立刻忘掉）。
5. 中继：解析本体会话时优先 `avatar\body` 的 cwd。

**已知未完成**
- 窗口不回放历史：切换页签/启动时游标从「现在」开始，旧消息不显示（要改 `chat-window.ps1` 的 cursor 初始化）。
- 子实体、每日归档、身体服务（9335）都还没做，见 `<工作区>\鲟鱼工作组方案.md`。

---

## 10. 进程守护 + 窗口状态 + 审批验证（2026-10-25 16:32）

### 守护（P0-1，已完成）

| 文件 | 作用 |
|---|---|
| `avatar\supervisor.ps1` | 单实例守护：relay 死了拉起、窗口没了拉起、bridge 连续 3 次不通试 `start.bat`、mod 只监测 |
| `avatar\supervisor-guard.ps1` | 看门狗：`supervisor.json` 心跳超 120 秒没更新 → 杀掉卡死进程 → 重启计划任务 |
| `avatar\ports.json` | 端口登记表 |
| `avatar\state\supervisor.log` / `.json` | 守护日志 / 最近一次检查结果 |
| `avatar\state\supervisor-guard.log` | 看门狗日志 |

计划任务：
- `XunyuAvatarSupervisor`：登录启动 + 每 5 分钟自愈
- `XunyuAvatarSupervisorGuard`：每 2 分钟检查一次心跳

**为什么要看门狗**：守护是单实例（命名互斥量）。它一旦卡死，进程还在、互斥量还占着，每 5 分钟拉起的新实例会直接退出 → 「守护看着在，其实没人管」。16:29 真的发生过一次（重新注册计划任务时旧实例卡住），所以补了这层。

**实测记录**
1. 手动 kill relay(28964) + 窗口(4688)：16:27:01 relay 拉起、16:27:04 窗口拉起
2. 伪造心跳过期 600 秒：16:31:38 看门狗杀掉 pid 35832、16:31:41 计划任务拉起新守护 pid 34712

### 窗口健康状态（P0-2，已完成）

`chat-window.ps1` 头部改成三态（文字 + 圆点颜色）：
- `在线`（绿）= 中继 9334 + 身体 9333 都通
- `身体未连接`（橙）= 中继通、游戏没开
- `中继离线 · 重连中`（红）= 中继不通

启动时先探测再说话，不再无条件喊「连上了」。每 5 秒心跳。
**坑**：这个文件必须带 UTF-8 BOM，`edit` 工具会弄丢，改完要补（见下）。

补 BOM 的方法：
```powershell
$p='E:\DeepFish\avatar\chat-window.ps1'
$c=[System.IO.File]::ReadAllText($p,[System.Text.Encoding]::UTF8)
[System.IO.File]::WriteAllText($p,$c,(New-Object System.Text.UTF8Encoding($true)))
```

### 代批修复：直放 + 排队 + approvalId（2026-10-25 20:10，已实测）

**问题**：主人报「代批功能没有真正生效」。根因两层：

1. `pending` 是 `Map<key, entry>`——**只有一个挂起位**。新请求进来会把旧请求 `cancelPendingEntry()` 判成**拒绝**（日志：`新挂起请求覆盖旧请求` → `已取消挂起审批（拒绝回执）`）。18:23:37 本体的 `write` 就是被工作组 28 秒后的那条 `edit` 顶掉并判拒的。
2. 窗口卡片 `Invoke-Approval` 只发 `{decision}`、不带 id，桥接取「当前那一条」——期间换请求就会**批错对象**。

**改法**（三个文件；补丁脚本 `<工作区>\patch-approval-2026-10-25.mjs`、`patch-approval-2.mjs`，锚点不命中就整体中止、原文件备份在 `<工作区>\backup\`）：

- `pending` 改成**每键多条排队**：`pendAdd / pendRemove / pendOldest / pendDropAll / pendFind`，单键上限 8（超出丢最老），每条各自计时、按 `rpcId` 精确超时与兜底。
- `/api/dsh/pending` 返回**全部**挂起，每条带 `approvalId`；`/api/dsh/approve` 接受 `approvalId`（不传退回最老，兼容旧调用）。
- 窗口卡片显示最老那条 + `（另有 N 条排队）`，按钮带该条的 `approvalId`。
- **③ 代批直放**：非本体会话（relay 绑定，如工作组/子实体）+ 不危险 + 代批窗开着 → 桥接直接 `allowed-once`，**不注册挂起、不占主人槽位、不推 QQ**，审计记 `by:"bridge(代批直放)"`；回执失败则回落成正常挂起（不静默卡死）。
- **无绑定的提问/审批回落到 `private:<ownerQQ>`**：桥接重启会清空内存里的 relay 绑定，旧代码此时 `if (!key) continue;` 会把请求**静默丢弃**（窗口没卡片、QQ 没消息、DSH 那边永远悬着）。

**判定表**：① 本体会话（`reverse.get(sessionId) === 'private:<ownerQQ>'`，不分危不危险）→ 只落窗口/QQ，**绝不直放**；② 非本体 + 危险 → 必须主人点，代批窗开着也挡；③ 非本体 + 不危险 + 窗开着 → 直放；④ 非本体 + 不危险 + 窗关着 → 正常挂起。

**实测**：`20:08:50 [bridge] [代批] 窗开着且不危险，直接放行 pwsh（session-b8901502…）；不占主人挂起位` ＋ 审计 `by:"bridge(代批直放)"`；同一条命令在改动前会弹卡片要人点。

**还没验**：两个不同会话的请求真正同时在队（排队逻辑按构造正确：只追加、精确移除、各自计时，等自然撞上再确认）；本体下一次要审批时确认卡片照常出现（而不是被直放）。

**一个误判风险**：危险判定扫的是**工具参数文本**，所以文档里出现那几个英文关键词（关机/断网/删盘类命令名）也可能被判高危。以后可以收窄成只扫命令行动词。

### ⚠️ 审批去哪了：答话者瀑布流（2026-10-25 18:25）

审批请求会走一条「答话者瀑布流」，**排在前面的答话者认领了，后面的（窗口/QQ）就什么都看不到**。
按我们这套环境，优先级大致是：

1. **Agents Anywhere 远程连接器**（`anywhere-cli.exe rpc --config %USERPROFILE%\.agents-anywhere\dsh-bridge-next\connector\connector.json`，
   两个 python 进程）→ 审批被转成「AA 交互通知」发到云端 `web.agents-anywhere.com` 作答。
   **它连着时审批会在 1~12 秒内被 `allowed-once` 静默放行，窗口和 QQ 都不会弹**（踩过，本体一次越权写就是这么没的）。
   由 DSH 应用的「远程访问」功能拉起，**应用重启后会自己回来**。
2. 桥接（`bridge.js` 的 `notifyOwnerOrWindow`）→ 按下面「审批只落窗口」的规则走窗口。

**排查手法**（下次「审批不见了」照这个来）：
- `cmd /c netstat -ano | findstr "51092"` → 有 ESTABLISHED 就说明远程通道连着
- `Get-CimInstance Win32_Process -Filter "Name='python.exe'" | ? { $_.CommandLine -like '*anywhere-cli*' }` → 有就是它在抢
- 会话日志（多帧 zstd）：`node <工作区>\read-session-log.mjs <session.v4.jsonl.zstd> approval` →
  能看到 `approval/asked` / `approval/decided → allowed-once` 的时间差；**差 1~12 秒且窗口没弹 = 远程通道抢答**
- 桥接日志 `state\bridge.log` 里搜 `[代批]`：有新格式那行才算走了窗口这条路

**2026-10-25 18:22 实测**：停掉连接器后重新触发越权写，中继 `/pending` 立刻出现挂起项，
桥接打出 `[代批] 窗口开着（守护确认进程在），审批只落窗口（审批 write）；10 分钟没人动才推 QQ` —— 窗口这条路是通的。

### 审批只落窗口，不推 QQ（2026-10-25 18:05，修正 16:40 那版）

16:40 那版是「窗口在线先不推 QQ，**20 秒没人处理再补推**」。20 秒太短，主人坐在窗口前看鲟鱼那边、
没点卡片，QQ 就收到「🔐 agent 请求审批」——他明确要求：**窗口开着就别去 QQ 敲门**。

现在的判定（`bridge.js` 的 `windowPresent()` + `notifyOwnerOrWindow()`）：

| 信号 | 来源 | 判定 |
|---|---|---|
| 强 | 守护每 10 秒写的 `state\supervisor.json` 里 `window=ok` | 窗口进程活着 → **审批只落窗口，不推 QQ** |
| 弱 | 中继 `/window-presence`（窗口心跳，60 秒内算在线） | 先不推，压 60 秒没人动再补推 QQ |
| 无 | 两个都没有 | 直接推 QQ |

要点：
- 强信号**必须剥 BOM**再 `JSON.parse`——那份文件是 PowerShell `Set-Content -Encoding UTF8` 写的，带 BOM，不剥会抛错并让强信号静默失效（踩过）
- 每次判定把依据写进日志，形如 `[代批] 窗口开着（守护确认进程在），审批只落窗口，不推 QQ（审批 edit）`
- 窗口侧：tick 用 `try/finally` 保证 `$script:busy` 解锁（之前中间抛错会让 timer 永久空转，
  表现是「审批卡片冻住 + 心跳断掉」）；另有专用心跳 `/window-presence?client=window`，与页签无关
- 中继侧：`WINDOW_ALIVE_MS` = 60000
- ⚠️ 待定：人离开但没关窗口时，审批只会在窗口等超时失败，QQ 不提醒。要不要加「N 分钟没人动 → 推 QQ」兜底，等主人定
  - **已定**：10 分钟没人动就推一条 QQ。强信号分支挂 10 分钟定时器；配套把 `config.json` 的
    `questionTimeoutMs` 从 300000（5 分钟）调到 **720000（12 分钟）**，否则挂起项先超时作废、提醒永远发不出来

### 真实审批链路（原 P0，已验证通过）

16:28:10 用户在窗口点「允许代批 30 分钟」→「通过」，日志：

```
16:28:11 [bridge] 已处理审批 (private:<主人QQ>): allowed-once {"rpcId":"658f3403-...","result":{"ok":true}}
16:28:12 [bridge] [代批] 鲟鱼批准了 pwsh（session-b8901502-...）
```

被审批的是工作组会话（本会话）的 `pwsh` 调用——「挂起 → 窗口代批 → 工具真正放行」整条链通了。
之前的两个 bug（`isOwner` 硬编码 false、失败冒充成功）由这次真实点击验证修复有效。

工作留痕：`<工作区>\工作日志.md`

### 人格与记忆搬出 avatar（2026-10-25 16:57）

**规矩**：`E:\DeepFish\avatar\` 从此只放**功能模块**（mod / 窗口 / 中继 / 身体服务 / 守护）；
本体的人格与记忆在 **`<Xunyu根>\`**，换身体、重写窗口都不影响它。

- 桥接 `config.json` 的 `storage.rolesDir` → `E:/DeepFish/Xunyu/roles`（注入的人格卡来自这里）
- 长期记忆从 `History\roles\鲟鱼记忆.md` 移到 `Xunyu\memory\long-term.md`
  （它原来混在人格目录里，会被人格列表当成一张卡；搬走后 `/api/roles` 只剩「鲟鱼」）
- 本体会话：`<session-id>`（cwd = `<Xunyu根>`）
- `avatar\body\` 与 `History\roles\` 只剩指路牌；原文归档在 `History\archive-roles\`
- 记忆同步机制：工作组往 `鲟鱼\memory\inbox\` 投摘要 → 本体启动时并入 `memory/long-term.md` → 文件移进 `archive\`

### 身体服务（9335，2026-10-25 16:57）

- `avatar\body-service.mjs`：适配器 `lilith`（转发 mod 9333）/ `noop`（哑身体）+ 能力表 + 单飞队列
- 中继 `pushToBody()` 走 9335；mod 直连只在服务不通时兜底
- 守护 `supervisor.ps1` 增加 9335 看护（`state\supervisor.json` 里的 `body` 字段）
- 换身体：只写一个新适配器（`AVATAR_BODY=名字`），上层一行不改；缺能力时 `/capabilities` 会列进 `unsupported`

### 审批优先落窗口（2026-10-25 16:40）

- 中继新增窗口心跳：窗口轮询带 `client=window` → `windowSeenAt`（15 秒内算在线）→ `GET /window-presence`
- 桥接新增 `windowPresent()` + `notifyOwnerOrWindow()`：窗口在线时不推 QQ，20 秒没人处理再补推
- 提问与审批同一套逻辑；先 `registerPending` 再通知，保证窗口马上拿到卡片
- **改 `chat-window.ps1` / `supervisor*.ps1` 之后必须补 UTF-8 BOM**（`edit` 工具会丢），否则 PowerShell 5.1 解析中文失败，表现为「窗口起来就退」

