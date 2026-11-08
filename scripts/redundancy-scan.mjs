// scripts\redundancy-scan.mjs —— 找"功能重叠"的脚本（不自动删，只给证据与建议）
//
// 判据（三条，都能机器算）：
//   1. **名字相似**（编辑距离 ≤2 或一方的名字包含另一方）
//   2. **用途描述相似**（文件头注释的字符二元组相似度 ≥0.45）
//   3. **同目录同组且都没人 import**（孤立 + 同组 ⇒ 大概率重复）
//
// 用法：node scripts\redundancy-scan.mjs [--json]
import fs from 'node:fs';
import path from 'node:path';

const WORKSPACE = 'E:/DSH_workspace';
const SCRIPTS = path.join(WORKSPACE, 'scripts');
const files = fs.readdirSync(SCRIPTS).filter((f) => f.endsWith('.mjs'));

function head(file) {
  const txt = fs.readFileSync(path.join(SCRIPTS, file), 'utf8').slice(0, 800);
  const lines = txt.split(/\r?\n/).filter((l) => /^\s*\/\//.test(l)).map((l) => l.replace(/^\s*\/\/\s*/, '').trim());
  return lines.slice(0, 4).join(' ');
}
function grams(s) {
  const m = new Map();
  const c = s.replace(/\s+/g, '');
  for (let i = 0; i < c.length - 1; i += 1) { const k = c.slice(i, i + 2); m.set(k, (m.get(k) ?? 0) + 1); }
  return m;
}
function sim(a, b) {
  const ga = grams(a), gb = grams(b);
  let inter = 0, total = 0;
  for (const [k, v] of ga) { total += v; if (gb.has(k)) inter += Math.min(v, gb.get(k)); }
  for (const v of gb.values()) total += v;
  return total ? (2 * inter) / total : 0;
}
function lev(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j += 1) d[0][j] = j;
  for (let i = 1; i <= m; i += 1) for (let j = 1; j <= n; j += 1)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}

// 谁被 import
const imported = new Set();
for (const f of files) {
  const txt = fs.readFileSync(path.join(SCRIPTS, f), 'utf8');
  for (const m of txt.matchAll(/from\s+['"]\.\/([\w.-]+\.mjs)['"]/g)) imported.add(m[1]);
}

const meta = files.map((f) => ({ f, base: f.replace(/\.mjs$/, ''), head: head(f), imported: imported.has(f), kb: fs.statSync(path.join(SCRIPTS, f)).size / 1024 }));

const pairs = [];
for (let i = 0; i < meta.length; i += 1) {
  for (let j = i + 1; j < meta.length; j += 1) {
    const a = meta[i], b = meta[j];
    const nameSim = a.base.includes(b.base) || b.base.includes(a.base) || lev(a.base, b.base) <= 2;
    const purposeSim = sim(a.head, b.head);
    if (!nameSim && purposeSim < 0.45) continue;
    const bothOrphan = !a.imported && !b.imported;
    pairs.push({
      a: a.f, b: b.f, nameSim, purposeSim: Number(purposeSim.toFixed(2)), bothOrphan,
      aKB: Number(a.kb.toFixed(1)), bKB: Number(b.kb.toFixed(1)),
      reason: [nameSim ? '名字相近' : '', purposeSim >= 0.45 ? `用途相似 ${purposeSim.toFixed(2)}` : '', bothOrphan ? '两者都未被引用' : ''].filter(Boolean).join(' + '),
    });
  }
}
pairs.sort((x, y) => (y.purposeSim - x.purposeSim) || (Number(y.bothOrphan) - Number(x.bothOrphan)));

const out = { at: new Date().toISOString(), total: files.length, pairs: pairs.slice(0, 30) };
if (process.argv.includes('--json')) console.log(JSON.stringify(out, null, 1));
else {
  console.log(`脚本 ${files.length} 个｜疑似重复 ${pairs.length} 对（列出前 15）\n`);
  for (const p of pairs.slice(0, 15)) {
    console.log(`${p.a}  ⟷  ${p.b}`);
    console.log(`   理由：${p.reason}｜${p.aKB}KB / ${p.bKB}KB`);
  }
  if (!pairs.length) console.log('没有发现明显重复。');
}
