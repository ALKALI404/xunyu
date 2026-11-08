// scripts\cleanup-archive.mjs —— 归档目录定期清理（30 天过期）
// 2026-11-07 主人：「挂30天清理」
// 规则：
//   ① 只扫 E:\DSH_workspace\归档\
//   ② 删除「最后修改时间」早于 30 天的条目（整目录或单文件）
//   ③ **先 dry 打印**（--dry），真删要 --yes
//   ④ 每轮写日志 logs\archive-cleanup.jsonl，记删了什么、多大
import fs from 'node:fs';
import path from 'node:path';

const ARCH = 'E:/DSH_workspace/归档';
const LOG = 'E:/DSH_workspace/logs/archive-cleanup.jsonl';
const DAYS = Number(process.env.ARCHIVE_KEEP_DAYS || 30);
const dry = !process.argv.includes('--yes');

function sizeOf(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isDirectory()) return st.size;
    let s = 0;
    for (const e of fs.readdirSync(p, { withFileTypes: true })) s += sizeOf(path.join(p, e.name));
    return s;
  } catch { return 0; }
}

if (!fs.existsSync(ARCH)) { console.log('没有归档目录，跳过'); process.exit(0); }

const cutoff = Date.now() - DAYS * 24 * 60 * 60 * 1000;
const dead = [];
for (const e of fs.readdirSync(ARCH, { withFileTypes: true })) {
  const full = path.join(ARCH, e.name);
  let mtime = Date.now();
  try { mtime = fs.statSync(full).mtimeMs; } catch { continue; }
  if (mtime < cutoff) dead.push({ full, name: e.name, size: sizeOf(full), mtime });
}

const totalMB = (dead.reduce((a, x) => a + x.size, 0) / 1024 / 1024).toFixed(1);
console.log(`归档里过期（>${DAYS} 天）${dead.length} 项，共 ${totalMB} MB${dry ? '【dry，未删】' : ''}`);
for (const d of dead.slice(0, 20)) {
  console.log(`  ${new Date(d.mtime).toISOString().slice(0, 10)}  ${d.name}  ${(d.size / 1024 / 1024).toFixed(1)} MB`);
}

if (dry || !dead.length) process.exit(0);

let removed = 0;
let freed = 0;
for (const d of dead) {
  try {
    fs.rmSync(d.full, { recursive: true, force: true });
    removed++;
    freed += d.size;
  } catch (e) {
    console.log(`  ⚠ 删不掉 ${d.name}：${String(e.message).slice(0, 80)}`);
  }
}
fs.mkdirSync(path.dirname(LOG), { recursive: true });
fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), keepDays: DAYS, removed, freedMB: Math.round(freed / 1024 / 1024), items: dead.map((d) => d.name) }) + '\n', 'utf8');
console.log(`  已删 ${removed} 项，释放 ${(freed / 1024 / 1024).toFixed(1)} MB`);
