// scripts\asar-list.mjs —— 只读列出 app.asar 里的条目（不装 asar 依赖，手工解析头部）
// 用法：node scripts\asar-list.mjs <filter-regex> [--sizes]
import fs from 'node:fs';

const file = 'E:\\DSH_Desktop\\resources\\app.asar';
const filter = new RegExp(process.argv[2] ?? '.', 'i');
const fd = fs.openSync(file, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const headerSize = head.readUInt32LE(12);
const headerBuf = Buffer.alloc(headerSize);
fs.readSync(fd, headerBuf, 0, headerSize, 16);
const header = JSON.parse(headerBuf.toString('utf8').replace(/\0+$/, ''));
const base = 16 + headerSize;

const out = [];
function walk(node, prefix) {
  for (const [name, meta] of Object.entries(node.files ?? {})) {
    const p = `${prefix}/${name}`;
    if (meta.files) walk(meta, p);
    else if (filter.test(p)) out.push({ path: p, size: meta.size ?? 0, offset: meta.offset });
  }
}
walk(header, '');
out.sort((a, b) => b.size - a.size);
for (const e of out.slice(0, 40)) process.stdout.write(`${String(e.size).padStart(10)}  ${e.path}\n`);
process.stdout.write(`\nmatched=${out.length} totalBytes=${out.reduce((a, b) => a + b.size, 0)}\n`);
fs.closeSync(fd);
