// 修名冲突：鉴权那边的 roleOf(req,url) 和队列里的 roleOf(job) 撞名 → 队列里的改成 jobRoleOf
import fs from 'node:fs';

const BODY = 'E:/DeepFish/avatar/body-service.mjs';
const WRITE = process.argv.includes('--write');
let src = fs.readFileSync(BODY, 'utf8');
const before = src;

const declCount = (src.match(/const roleOf = \(job\)/g) ?? []).length;
src = src.replace(/const roleOf = \(job\)/g, 'const jobRoleOf = (job)');

const calls = (src.match(/roleOf\((?!\s*req)/g) ?? []).length;
src = src.replace(/roleOf\((?!\s*req)/g, 'jobRoleOf(');

console.log(`声明改名：${declCount} 处；调用点改名：${calls} 处`);
if (declCount !== 1) { console.log('🛑 声明的锚点不对，未写盘'); process.exit(2); }
if (src === before) { console.log('🛑 没有任何改动'); process.exit(2); }
if (!WRITE) { console.log('✅ dry-run 通过，加 --write 才写盘'); process.exit(0); }
fs.writeFileSync(BODY, src, 'utf8');
console.log('✍️  已修名');
