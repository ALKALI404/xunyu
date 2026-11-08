// scripts\docs-tidy.mjs —— 文档整理：先出索引，再"只搬没人引用的"
//
// 保守原则（主人的"保险做法"）：
//   1. **默认只出索引**，不动任何文件；
//   2. 只有 `--move` 且**全库引用数=0** 的文件才搬进 docs\归档\<年月>\；
//   3. 搬之前写 manifest（可逆），搬之后把清单落到 docs\INDEX.md。
//
// 用法：
//   node scripts\docs-tidy.mjs                 出索引（不改文件）
//   node scripts\docs-tidy.mjs --move          把"零引用"的归档类文件搬走
//   node scripts\docs-tidy.mjs --json          机器可读
import fs from 'node:fs';
import path from 'node:path';

const WORKSPACE = 'E:/DSH_workspace';
const DOCS = path.join(WORKSPACE, 'docs');
const argv = process.argv.slice(2);
const doMove = argv.includes('--move');
const asJson = argv.includes('--json');

const GREP_DIRS = ['scripts', 'docs', '.'];
function refCount(relPath) {
  const base = path.basename(relPath);
  let n = 0;
  const scan = (dir, depth = 0) => {
    if (depth > 3) return;
    let ents = [];
    try { ents = fs.readdirSync(path.join(WORKSPACE, dir), { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'backup') continue;
      const rel = dir === '.' ? e.name : path.join(dir, e.name);
      if (e.isDirectory()) { scan(rel, depth + 1); continue; }
      if (!/\.(mjs|js|cjs|json|md|ps1)$/.test(e.name)) continue;
      if (rel === relPath) continue;
      try {
        const t = fs.readFileSync(path.join(WORKSPACE, rel), 'utf8');
        if (t.includes(base)) n += 1;
      } catch { }
    }
  };
  for (const d of GREP_DIRS) scan(d);
  return n;
}

// 分类规则（按文件名关键词）
const CATS = [
  { id: '规则', match: /规则|契约|必读|流程|职能|口径/ },
  { id: '规格与设计', match: /规格|架构|设计|模块|UI|运行逻辑|插件清单/ },
  { id: '升级与程序化', match: /升级|程序化|程序地图|程序清单|盘点|自动化/ },
  { id: '复盘与错题', match: /复盘|错题|坑|教训/ },
  { id: '报告与调研', match: /报告|研读|可行性/ },
  { id: '环境与运维', match: /环境|运维|令牌|证书|上下文|省钱/ },
  { id: '交接稿', match: /^交接-/ },
  { id: '项目分册', match: /^projects\// },
  { id: '归档', match: /^归档|^archive/ },
];

function collect() {
  const out = [];
  const walk = (dir, prefix = '') => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const full = path.join(dir, e.name);
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(full, rel); continue; }
      if (!e.name.endsWith('.md')) continue;
      const st = fs.statSync(full);
      out.push({ rel: rel.startsWith('docs/') ? rel : rel, abs: full, kb: Number((st.size / 1024).toFixed(1)), mtime: st.mtimeMs });
    }
  };
  walk(DOCS, 'docs');
  // 根目录的 md 也收进来（不含 docs/）
  for (const e of fs.readdirSync(WORKSPACE, { withFileTypes: true })) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue;
    const st = fs.statSync(path.join(WORKSPACE, e.name));
    out.push({ rel: e.name, abs: path.join(WORKSPACE, e.name), kb: Number((st.size / 1024).toFixed(1)), mtime: st.mtimeMs });
  }
  return out;
}

const rows = collect().map((r) => {
  const core = r.rel.replace(/^docs\//, '');
  const cat = (CATS.find((c) => c.match.test(core)) ?? { id: '未分类' }).id;
  return { ...r, cat, refs: refCount(r.rel) };
});

const byCat = {};
for (const r of rows) (byCat[r.cat] ??= []).push(r);

if (asJson) { console.log(JSON.stringify({ total: rows.length, byCat }, null, 1)); process.exit(0); }

// ── 索引文档 ───────────────────────────────────────────────────────
const idx = [
  '# 文档索引（自动生成）',
  '',
  `> 生成于 ${new Date().toISOString()}｜共 ${rows.length} 份 md`,
  '',
  '**规则**：新文档必须落在 `docs\\<分类>\\` 下；根目录只留 `README.md`。',
  '**引用数**：全库（scripts/docs/根）提到该文件名的次数；**0 = 可安全归档**。',
  '',
];
for (const cat of Object.keys(byCat).sort()) {
  idx.push(`## ${cat}（${byCat[cat].length}）`, '', '| 文件 | 大小 | 引用 | 建议 |', '|---|---|---|---|');
  for (const r of byCat[cat].sort((a, b) => b.kb - a.kb)) {
    const suggest = r.refs === 0 && /交接稿|报告与调研|复盘与错题/.test(cat) ? '**可归档**' : r.refs === 0 ? '可归档（需人确认）' : '保留';
    idx.push(`| \`${r.rel}\` | ${r.kb}KB | ${r.refs} | ${suggest} |`);
  }
  idx.push('');
}
fs.writeFileSync(path.join(DOCS, 'INDEX.md'), idx.join('\n'), 'utf8');

// ── 归档（仅 --move）───────────────────────────────────────────────
let moved = [];
if (doMove) {
  const stamp = new Date().toISOString().slice(0, 7);      // 2026-11
  const destDir = path.join(DOCS, '归档', stamp);
  fs.mkdirSync(destDir, { recursive: true });
  const manifest = [];
  for (const r of rows) {
    if (r.refs !== 0) continue;
    // 2026-11-01：交接稿不搬——handoff.mjs 按文件名模式在根目录找"最新交接稿"，引用数会是 0 但它依赖这些文件
    if (r.cat !== '报告与调研') continue;
    const dest = path.join(destDir, path.basename(r.rel));
    if (fs.existsSync(dest)) continue;
    fs.renameSync(r.abs, dest);
    manifest.push({ from: r.rel, to: path.relative(WORKSPACE, dest).replace(/\\/g, '/'), kb: r.kb });
    moved.push(r.rel);
  }
  fs.writeFileSync(path.join(destDir, '_归档清单.json'), JSON.stringify({ at: new Date().toISOString(), moved: manifest }, null, 1), 'utf8');
}

console.log(`文档总数 ${rows.length}`);
for (const cat of Object.keys(byCat).sort()) console.log(`  ${cat}: ${byCat[cat].length}`);
const movable = rows.filter((r) => r.refs === 0 && /交接稿|报告与调研|复盘与错题/.test(r.cat));
console.log(`\n零引用且可归档：${movable.length} 份`);
for (const r of movable.slice(0, 10)) console.log(`  ${r.rel}`);
console.log(`\n索引 → docs\\INDEX.md${doMove ? `｜已归档 ${moved.length} 份 → docs\\归档\\${new Date().toISOString().slice(0, 7)}` : '（未移动任何文件；要归档加 --move）'}`);
