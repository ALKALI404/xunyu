# Node SEA 打包踩坑（2026-10-30 · UG-029 验证记录）

> 一句话：Node 24 的 SEA 能打出**独立 exe**（91.9 MB / 构建 ~14 秒），但有两个坎：
> **① SEA 的 `main` 必须是 CommonJS**（ESM 脚本要先包一层）；**② 注入后 Authenticode 签名作废**（`NotSigned`）。

## 一、怎么打（本仓已落地）

```powershell
cd E:\DSH_workspace
npm i -D esbuild postject         # 一次就够（node_modules 不入库）
node scripts\build-exe.mjs --entry scripts\worklist.mjs --name xunyu-worklist   # 标准写法
node scripts\build-exe.mjs worklist        # 旧写法（读 build\sea-<name>.json），向后兼容
node scripts\build-exe.mjs worklist --keep # 保留中间产物（排障用）
```

### 接口契约（UG-034 接口优先；`scripts\build-exe.mjs` 是第一个按此实现的工具）

```
node scripts\build-exe.mjs --entry <js> --name <exe> [--out dist\] [--format cjs|esm] [--keep]
```

| 项 | 约定 |
|---|---|
| `--entry` | 入口脚本，必填（新写法）；相对工作区或绝对路径 |
| `--name` | 产物基名，必填（新写法）；给了 `--entry` 就必须给，**不许悄悄拼出个默认名** |
| `--out` | 输出目录，默认 `dist\` |
| 产物 | `<out>\<name>.exe` + `<out>\<name>.build.json` |
| `build.json` | `{entry, nodeVersion, sizeBytes, builtAt}`；entry=相对工作区正斜杠，builtAt=ISO 8601 UTC |
| 退出码 | `0` 成功 ／ `1` 构建失败（esbuild/sea-config/复制/postject） ／ `2` 用法或入参错（缺参、未知参、entry 不存在） |

两个实现细节（值得抄）：
- **原子落盘**：先写 `<out>\.<name>.exe.tmp`，注入成功才 `rename` 成正式名 —— 注入失败时**上一次的好 exe 不受牵连**，也不会留半成品；
- **清单只在成功时写**：失败路径绝不产出 `build.json`，避免"看着有清单以为打成功了"。

配置：`build\sea-<name>.json`（可选，当默认值读，命令行优先）

```json
{ "name": "xunyu-worklist", "entry": "scripts/worklist.mjs",
  "output": "dist/xunyu-worklist.exe", "format": "esm", "workspace": "E:/DSH_workspace" }
```

`scripts\build-exe.mjs` 干的四件事：esbuild 打成单文件 → `node --experimental-sea-config` 生成 blob → 复制**当前运行的 node.exe** → `postject` 注入 `NODE_SEA_BLOB`。

## 二、坑 1：SEA 的 main 只能是 CommonJS

- 直接 `main: bundle.mjs` → exe 起来报
  `Warning: Failed to load the ES module: …bundle.mjs. Make sure to set "type": "module" …`
  即 SEA 把 main 当 CJS `require()` 了，`.mjs` 进不去。
- 本仓 `worklist.mjs` 里有**顶层 await**（`await dispatchTask(...)`），esbuild 打 `--format=cjs` 直接报
  `Top-level await is currently not supported with the "cjs" output format`。
- **解法（本仓采用）**：
  1. esbuild 输出 **ESM** bundle（放得下顶层 await）；
  2. 写一个 4 行 **CJS 壳子**当 SEA 的 `main`：从 SEA asset 里取 ESM 源码 → `import('data:text/javascript;base64,…')`；
  3. SEA 配置里把 bundle 挂成 `assets`，壳子用 `sea.getAsset()` 读。
  这样"main 是 CJS"和"脚本是 ESM"两件事都满足，且**全部嵌进 exe**，不依赖磁盘上还留着 bundle。

## 三、坑 2：脚本里 `import.meta.url` 算不出工作区

- 脚本普遍用 `path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')` 找仓库根。
- exe 里没有"脚本文件路径"，这么算会落空（`worklist.jsonl` 找不到）。
- **解法**：打包时 `esbuild --define:import.meta.url="file:///<workspace>/scripts/<entry>"`，把工作区钉死（本仓 `E:/DSH_workspace`）。
  - 代价：exe **认路径**，换机器要重打包或改成读 `XUNYU_WORKSPACE` 环境变量（这是 UG-028 方案该定的）。

## 四、坑 3：`file:///…` 的绝对路径 import 会让 esbuild 报错

- 例如 `dispatch-core.mjs` 里 `import('file:///E:/DeepFish/qq-bridge…/dsh-client.js')`。
- esbuild 试图解析它 → `Could not resolve`。
- **解法**：在 esbuild 配置里加插件，把 `^file://` 的 import 全部标成 `external`（运行时才解析）：

```js
plugins: [{ name: 'external-file-url',
  setup(b) { b.onResolve({ filter: /^file:\/\// }, (a) => ({ path: a.path, external: true })); } }]
```

（注意：`external: ['file:///*']` 这种通配写法**不生效**，必须用 onResolve 插件。）

## 五、坑 4：注入后签名作废 → SmartScreen/杀软

- `postject` 注入时会打印 `warning: The signature seems corrupted!`——这是**预期**：node.exe 原本有 Authenticode 签名，改了字节就废了。
- 实测（本机）：
  - `Get-AuthenticodeSignature dist\xunyu-worklist.exe` → **NotSigned**
  - 对照 `node.exe` → **Valid**
  - 产物在**本机构建**，没有 `Zone.Identifier` 备用数据流 → **不会触发 SmartScreen 的"下载未知应用"提示**（从这台机器直接运行没被拦）。
  - Defender 无检测记录（`Get-MpThreatDetection` 为空）。
- **但如果把 exe 发给别人**（微信/邮件/网盘）：
  - 对方机器会有 `Zone.Identifier` → SmartScreen 大概率拦「未知发布者」；
  - 企业 EDR/Defender ASR 可能因为"无签名 + 自解压式大二进制"报可疑。
  - 想干净：买代码签名证书（EV 证书才立刻有信誉），或每次随版本发布 SHA256 + 让用户手动放行。
- 顺带：exe 体积 ≈ node.exe（87.4 MB）+ blob（~100 KB）→ **87.7 MB**。想小只能换 `node --experimental-strip-types`/nexe/单文件 C# 之类，或接受"带 node 运行时"。

## 六、实测数字（本机，2026-10-30 01:0x）

| 项 | 值 |
|---|---|
| Node | v24.15.0 |
| bundle（esbuild ESM） | 103,261 B（01:0x 首轮）／111 KB（01:17 新接口轮，随脚本内容变） |
| SEA blob | 103,803 B（首轮）／112 KB（新接口轮） |
| exe | 91,924,992 B（首轮）／91,935,744 B（新接口轮）—— 都是 **87.7 MB** |
| 构建耗时 | **14.0 s**（首轮，旧写法）／**16.8 s**（新接口轮，多写一步 build.json + 原子改名） |
| 启动到出结果 | ~220 ms |
| 输出一致性 | `dist\xunyu-worklist.exe list` 与 `node scripts\worklist.mjs list` **sha256 完全相同**（50 行，零差异） |
| 无 node 环境 | PATH 收成 `C:\Windows\System32;C:\Windows`（`where node` 找不到）后仍 exit=0、**同 50 行同 sha256** |

## 七、下次要打包别的脚本，注意这几条

1. 先问"这脚本有没有顶层 await / 动态 import 本地文件 / `file://` 绝对路径"——三条都踩过；
2. 有外部原生模块（`better-sqlite3` 之类）SEA 不支持，得换方案；
3. 脚本如果 `process.execPath` 当"node 路径"用（比如拉子进程），在 exe 里会变成 exe 自己 → 要显式传 `node` 或改走 SEA 的 `execArgv`；
4. 每个 exe 都要重复带一份 node 运行时（87 MB），**打包多个脚本时建议做成"一个 exe + 子命令"**，而不是 N 个 87 MB 的 exe。
