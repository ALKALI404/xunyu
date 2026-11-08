// 读 DSH 的会话日志：session.v4.jsonl.zstd 是「每追加一批就写一个 zstd 帧」的多帧文件，
// zstdDecompressSync 只解第一帧，所以这里按魔数切帧、逐帧解压。
//
// 用法：node read-session-log.mjs <session.v4.jsonl.zstd> [过滤关键字] [打印条数]
import fs from 'node:fs';
import zlib from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const file = process.argv[2];
const filter = process.argv[3] ?? 'approval|permission|sandbox';
const limit = Number(process.argv[4] ?? 10);

const buf = fs.readFileSync(file);
const starts = [];
for (let i = 0; i + 4 <= buf.length; i++) {
  if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) starts.push(i);
}
let text = '';
let frames = 0;
for (let k = 0; k < starts.length; k++) {
  const slice = buf.subarray(starts[k], k + 1 < starts.length ? starts[k + 1] : buf.length);
  try {
    text += zlib.zstdDecompressSync(slice).toString('utf8');
    frames++;
  } catch { /* 残缺帧跳过 */ }
}
const lines = text.split('\n').filter(Boolean);
const re = new RegExp(filter, 'i');
const hits = [];
for (const l of lines) {
  let j; try { j = JSON.parse(l); } catch { continue; }
  if (re.test(j.type ?? '')) hits.push(j);
}
console.log(`帧=${frames} 行=${lines.length} 命中=${hits.length}`);
for (const j of hits.slice(-limit)) {
  const t = new Date(Number(j.time)).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' });
  console.log(`--- ${t}  ${j.type}  seq=${j.seq}`);
  console.log('   ' + JSON.stringify(j.data ?? {}).slice(0, 700));
}
