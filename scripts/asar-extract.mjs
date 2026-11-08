// scripts\asar-extract.mjs —— 从 app.asar 里按路径取出一个文件（只读）
// 用法：node scripts\asar-extract.mjs <asar-internal-path> <out-file>
import fs from 'node:fs';

const file = 'E:\\DSH_Desktop\\resources\\app.asar';
const target = (process.argv[2] ?? '').replace(/\\/g, '/').replace(/^\/*/, '/');
const outFile = process.argv[3];
if (!target || !outFile) { console.error('用法: node scripts\\asar-extract.mjs <internal-path> <out-file>'); process.exit(2); }

const fd = fs.openSync(file, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const headerSize = head.readUInt32LE(12);
const headerBuf = Buffer.alloc(headerSize);
fs.readSync(fd, headerBuf, 0, headerSize, 16);
const header = JSON.parse(headerBuf.toString('utf8').replace(/\0+$/, ''));
const base = 16 + headerSize;

let node = header;
for (const part of target.split('/').filter(Boolean)) {
  node = node.files?.[part];
  if (!node) { console.error(`not found: ${target}`); process.exit(1); }
}
if (node.files || node.unpacked) { console.error('是目录或未打包（unpacked）'); process.exit(1); }
const buf = Buffer.alloc(node.size);
fs.readSync(fd, buf, 0, node.size, base + Number(node.offset));
fs.writeFileSync(outFile, buf);
fs.closeSync(fd);
process.stdout.write(`extracted ${node.size} bytes -> ${outFile}\n`);
