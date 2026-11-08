// scripts\docs-guard.mjs —— 文档落位守卫：新建的 md 必须落在 docs\<分类>\ 下
//
// 规矩（主人 2026-11-01 定）：
//   1. 根目录只允许：README.md、交接-*.md（handoff.mjs 依赖）、以及 docs\INDEX.md
//   2. docs\ 根层只允许 INDEX.md；其余必须进子目录（规则/规格与设计/升级/复盘/报告/环境/归档/项目分册）
//   3. 老文档不动（baseline 记着），只约束**新增**的
//
// 用法：
//   node scripts\docs-guard.mjs --init     把当前所有 md 记为基线（第一次或大整理后跑）
//   node scripts\docs-guard.mjs            检查（退出码 1 = 有落位违规）
//   node scripts\docs-guard.mjs --json     机器可读
import fs from 'node:fs';
import path from 'node:path';

const WORKSPACE = 'E:/DSH_workspace';
const DOCS = path.join(WORKSPACE, 'docs');
const BASE = path.join(WORKSPACE, 'state', 'docs-baseline.json');
const argv = process.argv.slice(2);
const init = argv.includes('--init');
const asJson = argv.includes('--json');

const CATS = [
  { id: '规则', match: /规则|契约|必读|流程|职能|口径|三值|3SAT/ },
  { id: '规格与设计', match: /规格|架构|设计|模块|UI|运行逻辑|插件清单/ },
  { id: '升级', match: /升级|程序化|程序地图|程序清单|盘点|自动化|执行程序/ },
  { id: '复盘', match: /复盘|错题|坑|教训|审计/ },
  { id: '报告', match: /报告|研读|可行性|调研/ },
  { id: '环境', match: /环境|运维|令牌|证书|上下文|省钱|VM/ },
  { id: '产品', match: /产品|企微|小红书|视频|客服|demo/ },
];

function scan() {
  const out = [];
  for (const e of fs.readdirSync(WORKSPACE, { withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith('.md')) out.push({ rel: e.name, scope: 'root' });
  }
  const walk = (dir, prefix) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = `${prefix}/${e.name}`;
      if (e.isDirectory()) { walk(path.join(dir, e.name), rel); continue; }
      if (e.name.endsWith('.md')) out.push({ rel, scope: prefix === 'docs' ? 'docs-root' : 'docs-sub' });
    }
  };
  walk(DOCS, 'docs');
  return out;
}

const now = scan();
const rels = now.map((x) => x.rel);

if (init) {
  fs.writeFileSync(BASE, JSON.stringify({ at: new Date().toISOString(), count: rels.length, files: rels }, null, 1), 'utf8');
  console.log(`基线已写：${rels.length} 份 md → state\\docs-baseline.json`);
  process.exit(0);
}

let baseline = new Set();
try { baseline = new Set(JSON.parse(fs.readFileSync(BASE, 'utf8')).files); } catch { }

const rootAllowed = (rel) => rel === 'README.md' || /^交接-.*\.md$/.test(rel);
const docsRootAllowed = (rel) => rel === 'docs/INDEX.md';

const violations = [];
for (const x of now) {
  if (baseline.has(x.rel)) continue;                        // 老文件不管
  if (x.scope === 'root' && !rootAllowed(x.rel)) violations.push({ ...x, why: '根目录只允许 README.md 与 交接-*.md' });
  if (x.scope === 'docs-root' && !docsRootAllowed(x.rel)) violations.push({ ...x, why: 'docs\\ 根层只允许 INDEX.md' });
}
// 建议落位
for (const v of violations) {
  const cat = (CATS.find((c) => c.match.test(v.rel)) ?? { id: '规则' }).id;
  v.suggest = `docs\\${cat}\\${path.basename(v.rel)}`;
}

if (asJson) {
  console.log(JSON.stringify({ ok: violations.length === 0, total: rels.length, baseline: baseline.size, violations }, null, 1));
} else {
  console.log(`文档 ${rels.length} 份（基线 ${baseline.size} 份；新增 ${rels.length - baseline.size}）`);
  if (!violations.length) console.log('✅ 落位合规：没有新增的散落文档');
  else {
    console.log(`❌ 落位违规 ${violations.length} 份：`);
    for (const v of violations) console.log(`  ${v.rel}  →  建议放 ${v.suggest}（${v.why}）`);
    console.log('\n修法：把文件移到建议位置，或先 `--init` 重新立基线（仅在大整理后）。');
  }
}
process.exit(violations.length ? 1 : 0);
