# 鲸鲸（whale_girl 4.0.7）魔改方案（2026-11-07）

> ⏸ **状态：暂停（2026-11-07 14:05）** —— 主人：「鲟鱼本身暂时先不做微信的部分」。本方案与 6 张票（WS-021~026）全部留档、不派单；重启时先看 §〇 的三处事实纠正与 §六 的风险（尤其 AGPL 分发那条）。

> ⚠️ **重启前必须先跟 `IN-044` 对齐**：IN-044（微信适配 shim）明写「**不要试图把它的工作台改成我们的工作台**」，而本方案第 2/3/5/6 项正是改它的工作台（人设页 / 表情页 / 提醒页 / 诊断页）。**两者二选一，别同时做**：
> **A. 只接 shim、不改它的 UI**（IN-044 路线：轻，界面还是鲸鲸自己的）；**B. 魔改 fork**（本方案：重，≈7 人日，但界面统一成我们的）。
> 另按《开发规范 v1》：这六张票**都不属于 P1**（改的是外部程序）→ 暂停期一张都不碰，P1 也不勾。

> **一句话结论：能安全魔改，但别把它当"改六个按钮"——真正花时间的是"跟上游脱钩"和"台前是 C# WPF 不是网页"。** 后端 ≈ **5 人日**、台前 ≈ **2.5 人日**，04/06 并行 **4~5 天**；串行约 1.5 周。
> 对象：`whale_girl 4.0.7`｜许可 **AGPL-3.0-only**｜上游 `github.com/Banan1cee/whale_girl`
> fork 已落：`E:\DeepFish\WhaleGirl-fork`（2026-11-07 13:31，**2,870 文件 / 462 MB**；安装目录 2,871 文件，差 1 个日志）
> 任务书：`state\tasks\WS-018.md`｜本稿只出方案，**没写业务代码**

---

## 〇、先纠三处任务书与事实不符（照旧写会返工）

| 任务书说法 | 实测 | 影响 |
|---|---|---|
| 「更新检查：launcher + **内核各有一份**」 | **只有 launcher**：`launcher\MainWindow.xaml.cs:59/177/188/210/298` + `UpdateManifest.cs:76-79`（4 个源）+ `UpdateService.cs`(26 KB) + `scripts\update.ps1`。内核里的 `manifest.json` 是**聊天记忆清单**（`src\memory\chatStore.js`），跟版本无关 | 第 1 项**内核零改动**，省半张票 |
| 「UI / 页面」 | 4.0.2 起**内核没有网页界面**（仓库 `AGENTS.md`；`src\http\` 只剩 JSON API）。台前是 WPF `launcher\`，产出 `WhaleLauncher.exe`；本机 **dotnet 8.0.427** 在，能重发 | 台前活是 **XAML/C#**，不是 HTML；**06 若只做网页，得 04 兼或另派** |
| `roles\保单助理.md` | **不存在**。`E:\DeepFish\Xunyu\roles\` 只有 `鲟鱼.md` | 人设改造按"目录协议"做，先接 鲟鱼；保险助理那份要么另写、要么改读保险项目配置 |

---

## 一、六项处置（结论表）

| # | 要什么 | 怎么改 | 动哪 | 工时 |
|---|---|---|---|---|
| **1** | 删掉检查更新 | 删 `UpdateManifest.cs` / `UpdateService.cs` / `scripts\update.ps1` / `release-manifest.json`；删 `MainWindow` 的 `BtnUpdate` 三处点击与启动时 `FetchAsync`；**自检加一条「启动后零 GitHub 请求」** | launcher（C#）+ scripts | 0.5d |
| **2** | 人设改成我们的 | 新增 `persona.source:"rolefile"`：读 `roles\<角色>.md`（带 YAML front-matter 参数）→ 拼进 `config.persona.customPrompt`；**关掉**它的梗表/怼人/顶嘴/抽象词块 | `src\persona\index.js`（只删分支不重写）、`src\services\persona.js`、launcher PersonaPage | 1d |
| **3** | 表情包 → 文件上传/下载 | 克隆 stickers 队列协议成 `files`：`pending/claim/ack/gate` + 上传 + 收件；发送复用 `sticker_transport.guarded_send`（把 `image_check` 换成 `file_check`） | `src\http\routes\`、`src\services\`、`bridge\engine.py`、`bridge\sticker_transport.py` | 1.5d |
| **4** | 不接群聊 | 新增 `chat.acceptGroups:false` 闸（消息入口直接丢弃群消息并记一条 debug）；**代码一行不删** | `src\pipeline\chat.js`（入口 1 处）+ `src\infra\configSchema.js` | 0.5d（并入 5 项） |
| **5** | 群聊那块 → 待办 + 定时提醒 + 诊断 | 复用现成 `reminderService`（队列+daily cap+quietAfter+nextDueAt+ack）：加 `todo` 状态与 `done`；`care`（主动搭话）**默认关**；诊断页收编到第 6 项 | `src\services\reminderService.js`、`src\http\routes\{reminders,todo}.js`、launcher ReminderPage | 1d |
| **6** | 鲟鱼守护 + 自检合并 | **后端不造第二套**：supervisor 在 9340（已上线）；客户端 `DiagPage` 上半加「鲟鱼服务」只读卡片读 9340，**自检只读 WS-019 的 `/api/console/selftest`**，鲸鲸侧不新增自检接口 | launcher DiagPage | 0.5d |

> 合计 **≈7 人日**（第 6 项从 1d 砍到 0.5d：自检不再造第二套）；其中 1/4/5 有重叠，实际排 6 张票。

---

## 二、删改留表（按目录，含理由）

**体量（源仓库实测）**：`src\` 933 KB/92 文件（adapters 121K·7 / core 56K·13 / http 54K·20 / infra 75K·11 / llm 46K·1 / memory 218K·18 / persona 102K·4 / pipeline 126K·2 / services 135K·16）；`bridge\` 373 KB/14；`assets\` 81 KB/12；`launcher\` 2,568 KB/48；`tests\` 1,220 KB/175；`vendor\` 1,571 KB/83；`installer\` 24 MB/51。

| 路径 | 处置 | 理由 |
|---|---|---|
| `src\persona\` (102K) | **改** | `index.js`(83K) 是提示词装配器，**保留装配顺序、只断内容源**：梗表/怼人/顶嘴/抽象词分支关掉；新增 `rolefile` 分支读 `roles\*.md` |
| `src\pipeline\chat.js` (120K) | **改** | 群聊分支约 10 处（402/440/555/585/609…）**不删**，只在入口加 `acceptGroups` 闸 |
| `src\services\` (135K) | **改** | `reminderService`(16.5K)/`care`(15.9K) 直接复用；`stickerService`→`fileService`（队列语义照搬）；`stickerLibraryLocal` 废 |
| `src\adapters\stickers.js` (48K) | **改→`files.js`** | 目录/白名单/校验/缩略图那套对文件同样成立；**图片校验换成文件校验**（大小/类型/哈希） |
| `src\http\routes\` (54K) | **改** | `stickers.js`→`files.js`；新增 `todo.js`、`selftest.js`；`reminders.js` 加 done |
| `src\core\` (56K) | **留** | `reminder.js`/`trigger.js`/`identity.js`/`env.js` 是基础设施 |
| `src\memory\` (218K) | **留·不动** | 它的长期记忆/压缩/检索；我们不用它的记忆，但它自己维持对话需要。**别碰，218K 里全是边界条件** |
| `src\llm\client.js` (46K) | **留** | 多厂商客户端；DSH 不接它，但删了它整条链就断 |
| `src\infra\` (75K) | **小改** | `configSchema.js`/`config.js` 加 `persona.source`、`chat.acceptGroups`、`files.*` 字段 |
| `assets\personas\*.json`（7 个） | **挪·不删** | 挪到 `data\_legacy-personas\`；我们的人设在 `roles\`，但保留它们便于回滚对照 |
| `assets\slang.txt` / `clapback*.txt` / `abbrev.txt` | **删（或关）** | 网络潮语/互怼语料，**和保险客户对话会出事**；删文件 + 删加载分支 |
| `bridge\engine.py` (234K) | **改** | 表情轮询三处（`:4113` pending、`:3306` claim、`:3331` ack）抄一份给 files；群消息入口加闸 |
| `bridge\sticker_transport.py` (26K) | **改·留主体** | `guarded_send(:391)`/`validate_path`/`confirm_delivery`/`watermark` 全留；只把 `_verify_image` 泛化成 `_verify_file` |
| `bridge\bg_sender.py` (57K) | **留·红线** | **零焦点**发送（UIA + 编码探测 + 命名互斥 + 写保护）。改它等于砸掉整个方案的地基 |
| `launcher\UpdateManifest.cs` / `UpdateService.cs` | **删** | 第 1 项；4 个源全是 GitHub 系（releases/raw/gh-proxy/jsdelivr） |
| `launcher\Views\PersonaPage.*` (40K) | **改** | 从"填一堆字段"改成"选 `roles\*.md` + 预览拼出来的提示词" |
| `launcher\Views\StickerPage.*` (48K) | **改→FilesPage** | 缩略图/分类/上传/发送确认的壳全部可留，换成文件列表 + 收件箱 |
| `launcher\Views\ReminderPage.*` (30K) | **改→TodoPage** | 加"待办清单"区（今天/本周/过期），提醒规则区保留 |
| `launcher\Views\DiagPage.*` (80K) | **改** | 上半加「鲟鱼服务」只读卡片（读 9340）；现有"自检/内核日志/路径占用/数据维护"全留 |
| `launcher\Views\StatusPage.*`、`BridgePage.*`、`SettingsPage.*` | **留** | 运行状态、桥接、设置都还要用 |
| `scripts\update.ps1` / `make-manifest.ps1` / `release-manifest.json` | **删** | 第 1 项；删了就不会再被上游清单牵着走 |
| `scripts\build-*.ps1` / `ensure-dotnet.ps1` / `fetch-*.ps1` | **留** | 我们自己也要重打包/装运行时 |
| `installer\` (24 MB) | **留·改名** | Inno Setup 脚本改产品名/URL；**给彭艳装时先看 §六.1** |
| `vendor\wechatauto\` (83 文件) | **留·锁版** | PyPI `wechatauto-replica 1.2.9` 原样副本，DB 读取的底层；`MANIFEST.sha256` 别动 |
| `tests\` (175 个) | **留** | 改到哪跑到哪；新增 5 个（见票）。**群聊用例会红——标注"预期红"，不算回归** |
| `docs\` / `examples\` / `CHANGELOG.md` / `BUGS.md` | **留** | 上游文档有价值；新增一份 `OUR-CHANGES.md` 记我们改了什么（AGPL 留档要求） |
| `WHALE_*` 环境变量、`data\` | **留·隔离** | fork 用自己的 `data\`；别指回安装目录，否则两边记忆串味 |

---

## 三、人设字段映射表

**它的三层**：① `assets\personas\*.json`（出厂预设，7 个）→ ② `data\persona.json`（聊出来的演化）→ ③ `config.persona.customPrompt`（手写长提示，最高优先）。参数在 `config.chat`，UI 在 `launcher\Views\PersonaPage.xaml`。

**我们的源** = `roles\<角色>.md`，前面加一段 front-matter 承载参数（**新约定**）：

```markdown
---
name: 鲟鱼
privateMaxChars: 120
historyTurns: 12
maxBubbles: 1
emojiChance: 0
---

# 鲟鱼

## 我是谁
…（原样）
```

| 它的字段 | 现在取值 | 我们的映射 | 规则 |
|---|---|---|---|
| `persona.name` | 鲸鲸 | `roles\*` 的 H1 或 front-matter `name` | 直接取 |
| `persona.age/job/appearance/background` | 出厂 JSON | **不填**（鲟鱼没有这些） | 留空即不注入对应句子 |
| `persona.personality` | 出厂 JSON | H2「我是谁」+「喜欢什么」全文 | 整段注入，不改写 |
| `persona.text`（一句话指令） | 出厂 JSON | 从 `## 怎么说话` 抽 1~2 条 | 超过 2 条就截，宁短勿长 |
| `persona.customPrompt` | 手写长提示 | **`roles\*.md` 全文（去掉 front-matter）** | 走高优先级分支（`index.js:812/991`），这是我们唯一要的路径 |
| `persona.aliases` | 鲸鲸/小鲸娘… | 角色卡的别名行 | 用于"被叫到才回" |
| `persona.ownerName` | 彭艳 | 主人称呼（默认「主人」） | 保险场景用「彭姐」由角色卡决定 |
| `persona.master.names/wxids` | 空 | 照旧填 wxid | **认主人只认 wxid**，不认昵称 |
| `persona.masterRoast` | false | **强制 false** | 鲟鱼不顶嘴；关掉 `ROAST_MODE` 分支 |
| `preset.privateMaxChars` | 140 | front-matter `privateMaxChars` | 保险答复要短 → 120 |
| `preset.groupMaxChars` | 70 | 不用（不接群聊） | 字段保留 |
| `preset.historyTurns` / `groupHistoryTurns` | 100/60 | front-matter `historyTurns`（群聊不用） | 12 轮够日常，省钱 |
| `config.chat.maxBubbles` | 2 | front-matter `maxBubbles` | **1**：别连发 |
| `config.chat.emojiChance` | 0.3 | front-matter `emojiChance` | **0**：鲟鱼不用颜文字 |
| `config.persona.stylePreset` | 正常 | **不设** | 那是它的口癖预设 |
| `data\persona.json`（演化） | 有 | **不启用**（`persona.evolve:false`） | 人设不许自己长歪；要改就改 md |

**要关掉的装配块**（`src\persona\index.js`，按行）：`selectSlang()`(17)、`clapback*`(185-255)、`FIGHT_STYLE`/`ROAST_MODE`(781/1014-1021)、`abbrev*`(130-163)、`moodFor/activityFor/nowPhrase`(90-118 —— **时间块要留**，环境块要留)。**留**：身份/场景/长度/环境/联网/语音后缀。

> 一句话：**装配器不动结构，只把"内容从哪来"和"哪几块注入"改成开关。**

---

## 四、文件通道设计（替代表情包）

### 4.1 复用什么（别重写）

| 复用件 | 位置 | 借什么 |
|---|---|---|
| 队列握手 | `src\http\routes\stickers.js:21,233-249` | `pending / claim / ack / gate` 四件套 + `BRIDGE_ONLY` 校验 bridge token + 仅本机 + `generation` 开关代际（关功能时即时 404） |
| 队列服务 | `src\services\stickerService.js` | 状态机 `queued→reserved→sending→confirmed/unconfirmed/failed`、租约超时、5 分钟后重试一次、过期不补发 |
| 发送 | `bridge\sticker_transport.py:391 guarded_send()` | 剪贴板放路径 → 微信后台 `Ctrl+V` → 出水消息比对确认；`validate_path` 白名单、`confirm_delivery` 证据链、`watermark` 去重 |
| 收件 | `bridge\msg_pipeline.py` + `vendor\wechatauto` | 新消息里识别文件类消息 → 落盘 |
| 零焦点 | `bridge\bg_sender.py` | UIA 后台发送、编码探测、命名互斥（**红线，不许改坏**） |

### 4.2 数据模型（`data\files\queue.jsonl`，一行一个 job）

```json
{ "id":"f-1700000000-3", "dir":"out", "chatId":"wxid_xxx", "chatName":"彭姐",
  "path":"data\\files\\outbox\\报价单-2026-11.pdf", "name":"报价单-2026-11.pdf",
  "bytes":183422, "sha256":"…", "mime":"application/pdf",
  "status":"queued", "attempts":0, "createdAt":"…", "error":"" }
```

- `dir`：`out`（我们要发出去）/ `in`（收到的）；
- `status`：`queued / reserved / sending / confirmed / unconfirmed / failed / cancelled`（**照抄表情那套，连词都不换**，测试可以搬）。

### 4.3 接口（对主人可见的两个 + 桥接内部四个）

```http
# 公开（本机 + 启动器用）
POST /api/files/send    { chatId, path }            → { ok, jobId, bytes, sha256 }     # 校验后入队，不阻塞
POST /api/files/receive { chatId, kind:"file" }     → { ok, savedAs, bytes, sha256 }   # 从收件箱取一条已收到的
GET  /api/files/status  ?jobId=                     → { ok, job, queue:{queued,sending,unconfirmed} }
POST /api/files/cancel  { jobId }                   → { ok }

# 桥接专用（BRIDGE_ONLY，必须带 gateway token）
GET  /api/files/pending            → { ok, items:[…] }
POST /api/files/claim   { id }     → { ok, item }      # 加租约，超时自动回 queued
POST /api/files/ack     { id, status, error }  → { ok, item }
POST /api/files/incoming { chatId, savedAs, bytes, sha256 } → { ok, id }   # 桥接收完文件回报
```

### 4.4 校验（红线，全在这里）

| 检查 | 规则 | 不通过 |
|---|---|---|
| 白名单根 | 只允许 `data\files\outbox\` 与 `data\files\inbox\`（可配置追加，默认无）；`path.resolve` 后必须在根内 | 400 `path-outside` |
| 类型 | **禁发可执行/脚本**：`.exe .bat .cmd .ps1 .js .vbs .lnk .scr .msi` | 400 `blocked-type` |
| 大小 | 单文件 ≤ 50 MB（微信文件上限内）；图片 ≤ 20 MB | 400 `too-large` |
| 哈希 | 入队即算 `sha256`；发送前后一致，不一致判 `unconfirmed` | 记 error，不重发 |
| 重名 | 同名同哈希 → 复用上次 `jobId`，不重复发 | — |

### 4.5 两条链路

```
发：启动器选文件 → POST /api/files/send（校验+入队）→ 桥接 2s 轮询 pending → claim
    → 剪贴板 CF_HDROP → 微信后台粘贴 → 比对出水消息（文件名的 marker）→ ack confirmed
    → 启动器 2s 拉 status 显示"已发送 / 发送未确认"

收：微信来文件消息 → 桥接识别 → 保存到 inbox（重名加 -1）→ 算 sha256
    → POST /api/files/incoming → 启动器「收件」列表 → 点开在本机打开
```

**失败语义**（照抄提醒的规矩）：发送失败 **5 分钟后重试一次**；`unconfirmed`（确认不到出水）**不重发**，等人工看；过期 24h 不补发。

---

## 五、守护 + 自检怎么"合"，合在哪

**事实**：`GET http://127.1.1.2:9340/api/supervisor` **已经上线**（WS-016 已做出后端，实测 200，返回 9 项：workdesk/window-proxy/insurance/qq-bridge/study/engine/placement/relay + 1 个自测项，字段 `id/name/port/host/log/up/restartsLastHour/lastAction`）。

**决定（D6）**：**一份数据、两个入口**，不重造：

| 层 | 在哪 | 干什么 |
|---|---|---|
| 后端（唯一真相） | 9340 `supervisor`（WS-016，03 在收尾） | 15s 巡检、退避拉起、事件落 `logs\supervisor.jsonl` |
| 全局台前 | 工作台「调度台」（WS-017，06 在做）→ 后续并进 WS-019 的「总控台」 | 8 个服务的红绿灯 + 重启 + 事件流 |
| 本机台前 | 鲸鲸 `DiagPage` | **只读**拉 9340：一屏红绿灯 + 最近 3 条动作；**不做第二个重启按钮**（两处都能重启 = 迟早互相打） |
| 自检 | **只有一处**：9340 `GET /api/console/selftest`（WS-019 出契约） | 鲸鲸诊断页只**展示**它，不新增 `/api/selftest`——两套自检 = 两份"谁对"的争吵 |

**"启动后零 GitHub 请求"怎么验**：它不是运行期自检项（自检在 9340，看不到客户端外联），而是**交付证据**——静态 grep 0 命中 + 运行 10 分钟后 DNS 缓存/连接表无 github 系域名（验法见 WS-021）。别把"证据"写成"自检通过"。

**为什么不全搬进客户端**：客户端只管鲸鲸自己；8 个服务里有 5 个跟鲸鲸无关（9343 保险、9350/9351 学习区、9352 考场、9334 relay），搬进去等于再造一个工作台。

**第 6 项真正的"合并"点**：诊断页里"自检"和"鲟鱼服务"用**同一张卡片样式 + 同一次刷新**，人一眼看出"鲸鲸自身"和"鲟鱼全局"是两层，而不是两套系统。

---

## 六、风险（必须写清的四条 + 三条附）

### 6.1 AGPL：**给彭艳装 = 分发**
`LICENSE` 首行：`GNU Affero General Public License v3.0 only`。例外登记（`docs\规则\例外-whale_girl-AGPL-2026-11-07.md`）写的是"内部自用（彭艳的助理小号 + 本机）"，但**法律上把改过的客户端交给彭艳，就是向第三方分发** → AGPL 要求提供完整对应源码（含我们的改动）。
- **要么**：只在本机跑，彭艳那边维持"进程隔离 + 走 relay"（例外登记 §四 的原设计），**不给她装客户端**；
- **要么**：给源码包（fork 全量 + `OUR-CHANGES.md`），并在安装包里附 AGPL 文本；
- **不许**：把它的代码贴进我们自己的业务代码（传染）；改名发布；打包卖。这条我照登记原文执行，**要不要给彭艳装请你定**，我不替你决定。

### 6.2 fork 已落，但**还不是 git 仓库**
`E:\DeepFish\WhaleGirl-fork` 是 13:31 的整目录复制（2,870 文件）。**没有版本控制 = 以后没法 diff 上游、也没法回滚**。第一张票的第一步就是 `git init` + 提交基线（含 `OUR-CHANGES.md`），否则改到第三天就说不清哪行是我们的。

### 6.3 零焦点是红线
`bg_sender.py`（57 KB）靠 UIA + 隐藏窗口 + 命名互斥 + 编码探测，在**别的窗口占前台时**也能发。魔改里**禁止**：`SetForegroundWindow`、弹模态框抢焦点、把发送改成"先激活窗口"。验收必须有"前台有别的窗口时照样发出"的用例。

### 6.4 删更新 = 永不收上游补丁
删掉 4 个源之后，上游修 bug 我们拿不到。**必须有手动合流流程**：每季度（或遇到明显 bug 时）拉上游 tag → `git diff` → 人工合。写进 `OUR-CHANGES.md`，不然半年后没人记得为什么 fork 落后 3 个版本。

### 附三条
5. **EXE 要重发**：改 launcher 必须 `dotnet publish` + 覆盖根目录 `WhaleLauncher.exe`；没 SDK 的机器只交源码并**明说"EXE 待发布"**，不许假装。
6. **人设是别人的 voice**：鲸鲸的梗/怼人/颜文字对保险客户是灾难，第 2 项本质是"换嗓子"，不是"加个字段"。
7. **群聊测试会红**：`tests\` 175 个里有一批群聊用例，关群聊后它们会失败——**允许红，但要在测试清单里标"预期红"**，别让人以为改坏了。

---

## 七、票（拆好了，交 01 登记派单）

| 票 | 给谁 | 一句话 | 依赖 |
|---|---|---|---|
| **WS-021** | 04 | fork 基线（git + `OUR-CHANGES.md`）+ **去更新化**（删 4 源/删 UI 入口/交付"零外联"证据） | — |
| **WS-022** | 04 | **文件通道**：队列 + 白名单/类型/哈希校验 + 桥接发送与收件 | WS-021 |
| **WS-023** | 04 | **人设源改造**：`roles\*.md` + front-matter，关掉梗/怼人/演化 | WS-021 |
| **WS-024** | 04 | **群聊闸 + 待办模型**：`acceptGroups:false`、todo 状态、care 默认关 | WS-023 |
| **WS-025** | 06 | 台前两页：**文件页**（替表情）、**待办页**（替提醒） | WS-022/024 |
| **WS-026** | 06 | 台前：**诊断/调度页**（只读 9340，自检只展示 WS-019 的） | WS-019 契约、WS-021 |

**票号说明**：`WS-019`（诊断面集成 / 总控台）与 `WS-020`（打包方案）在 13:50、14:00 已被本体占用，**也是派给 05 的**，所以本方案从 **WS-021** 起编。两件事是同一条线的两半：**WS-019 管"全局总控台"（工作台），本方案管"客户端那半页"**——数据同源（9340），页面各管一半，别各造一套自检。

每张票都有：接口契约 / 预期结果 / 可验方式（含反例）/ 边界 / 回滚。任务书在 `state\tasks\WS-021.md` ~ `WS-026.md`。

> **台前是 WPF（XAML + C#）**：06 若只做网页，WS-024/025 要 04 兼或另派会 C# 的人——**这条请在派单前确认**，别派出去才发现做不了。

---

已读规则 v2026-10-29 ｜ 05 · 文档与架构 ｜ 2026-11-07 13:5x（基于 13:31 的 fork 与 4.0.7 源码实测）
