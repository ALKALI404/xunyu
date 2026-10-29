// 小补丁：history 里记下 say 的原文（截断 80 字），验收要核对合并结果，留痕也有用
import fs from 'node:fs';
const BODY = 'E:/DeepFish/avatar/body-service.mjs';
const WRITE = process.argv.includes('--write');
let src = fs.readFileSync(BODY, 'utf8');
const from = `  const base = {
    id: job.id, action: job.action, role: jobRoleOf(job), source: job.source,
    priority: PRIORITY[jobRoleOf(job)] ?? 1, manual: !!job.manual,
    mergedCount: job.mergedCount, droppedChars: job.droppedChars,
    waitedMs: startedAt - job.queuedAt, at: new Date().toISOString()
  };`;
const to = `  const base = {
    id: job.id, action: job.action, role: jobRoleOf(job), source: job.source,
    priority: PRIORITY[jobRoleOf(job)] ?? 1, manual: !!job.manual,
    mergedCount: job.mergedCount, droppedChars: job.droppedChars,
    text: typeof job.payload?.text === 'string' ? job.payload.text.slice(0, 80) : undefined,
    waitedMs: startedAt - job.queuedAt, at: new Date().toISOString()
  };`;
const n = src.split(from).length - 1;
console.log(`${n === 1 ? '✅' : '❌'} history 记原文锚点：${n} 处`);
if (n !== 1) process.exit(2);
src = src.split(from).join(to);
if (!WRITE) { console.log('✅ dry-run 通过，加 --write 写盘'); process.exit(0); }
fs.writeFileSync(BODY, src, 'utf8');
console.log('✍️  已写');
