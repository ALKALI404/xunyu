#!/usr/bin/env node
// scripts\collect-repo.mjs —— 把「鲟鱼项目」按白名单收集到一个干净的仓库目录
// 用法: node scripts\collect-repo.mjs [目标目录]
// 默认目标: <工作区>\repo-xunyu
import fs from 'node:fs';
import path from 'node:path';

const TARGET = process.argv[2] || 'E:/DSH_workspace/repo-xunyu';

// ── 白名单：{ 源目录, 目标子路径, 包含规则 } ───────────────────────────────
const SOURCES = [
  { from: 'E:/DSH_workspace/docs',            to: 'docs',            include: [/\.md$/] },
  { from: 'E:/DSH_workspace/scripts',         to: 'scripts',         include: [/\.mjs$/, /\.ps1$/] },
  { from: 'E:/DSH_workspace/state/tasks',     to: 'tasks',           include: [/\.md$/] },
  { from: 'E:/DSH_workspace/assets',          to: 'assets',          include: [/\.(png|jpg|jpeg|webp|ico|svg)$/, /仓库登记\.md$/] },
  { from: 'E:/DeepFish/avatar',               to: 'avatar',          include: [/\.(mjs|ps1|cmd|cs|csproj|html|css|js|json|md)$|\.vbs$/] },
  { from: 'E:/DeepFish/Xunyu/roles',          to: 'roles',           include: [/\.md$/] },
  { from: 'E:/DeepFish/Xunyu/assets',         to: 'xunyu-assets',    include: [/\.(png|jpg|jpeg|webp|ico|svg|md)$/] },
];

// ── 黑名单（任何层级命中就跳过）：凭据 / 聊天 / 账本 / 二进制 / 依赖 ──────────
const DENY_DIRS = new Set(['toolchain', 'node_modules', '.git', 'backup', 'tmp', 'logs', 'History', 'memory', 'state', 'mail', 'chats', '__pycache__']);
const DENY_FILES = [
  /^config\.json$/, /token/i, /secret/i, /credential/i, /\.env$/,
  /\.(exe|dll|zip|7z|rar|nupkg|log|jsonl|zst|zstd|pdb|cache)$/,
  /^mailbox\.jsonl$/, /^long-term\.md$/, /^owner-session\.json$/,
];

function skipDir(name) { return DENY_DIRS.has(name) || name.startsWith('.'); }
function skipFile(name) { return DENY_FILES.some((re) => re.test(name)); }

let copied = 0, bytes = 0, skipped = 0;
const byDir = new Map();

function walk(from, to, include) {
  let entries;
  try { entries = fs.readdirSync(from, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const src = path.join(from, e.name);
    if (e.isDirectory()) { if (!skipDir(e.name)) walk(src, path.join(to, e.name), include); continue; }
    if (!e.isFile()) continue;
    if (skipFile(e.name)) { skipped++; continue; }
    if (!include.some((re) => re.test(e.name))) { skipped++; continue; }
    fs.mkdirSync(to, { recursive: true });
    fs.copyFileSync(src, path.join(to, e.name));
    const size = fs.statSync(path.join(to, e.name)).size;
    copied++; bytes += size;
    const top = path.relative(TARGET, to).split(path.sep)[0] || '.';
    byDir.set(top, (byDir.get(top) || 0) + 1);
  }
}

fs.rmSync(TARGET, { recursive: true, force: true });
fs.mkdirSync(TARGET, { recursive: true });

for (const s of SOURCES) {
  if (!fs.existsSync(s.from)) { console.log('跳过（不存在）:', s.from); continue; }
  walk(s.from, path.join(TARGET, s.to), s.include);
}

// ── 生成 .gitignore 与 README ─────────────────────────────────────────────
const gitignore = `# 凭据与私密（永不入库）
config.json
*secret*
*token*
.env
*.pem
*.key
state/
logs/
History/
memory/
mail/
chats/
backup/
tmp/
node_modules/

# 二进制与产物
*.exe
*.dll
*.zip
*.7z
*.nupkg
*.log
*.jsonl
*.zst
*.pdb
`;
fs.writeFileSync(path.join(TARGET, '.gitignore'), gitignore);

const readme = `# 鲟鱼（Xunyu）

一条住在主人电脑里的鱼。本仓库是**资产管理**用的快照：代码、文档、素材。

## 目录
- \`avatar/\` —— 窗口壳、relay、body、pain-bus 等运行件（**不含** exe/日志/配置）
- \`scripts/\` —— 工作台、台账、派发、花费统计等本地脚本
- \`docs/\` —— 规则、UI 规格、项目分册、坑清单
- \`tasks/\` —— 工单任务书（每单一份，四要素）
- \`assets/\` —— 程序图标、数据样本、素材（见 assets/仓库登记.md）
- \`roles/\` —— 角色设定文档
- \`xunyu-assets/\` —— 本体形象素材

## 不含（.gitignore）
密钥/token/config、邮件池、聊天记录、token 账本、日志、exe 与压缩包。

## 收集方式
\`node scripts/collect-repo.mjs\` 按白名单复制到暂存目录，再提交。**不要**把工作目录直接当仓库。
`;
fs.writeFileSync(path.join(TARGET, 'README.md'), readme);

// ── 报告 ────────────────────────────────────────────────────────────────
const MB = (n) => (n / 1048576).toFixed(2) + ' MB';
console.log('目标目录:', TARGET);
console.log('收集文件:', copied, '| 跳过:', skipped, '| 合计:', MB(bytes));
console.log('按目录:');
for (const [k, v] of [...byDir].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(14)} ${v} 个`);

