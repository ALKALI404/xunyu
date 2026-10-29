// 回归检查：维护脚本里不许出现「写死的 DSH 地址」。
// 跑：node scripts\check-hardcoded-ports.mjs   （exit 1 = 有硬编码）
//
// 允许表里只有中继/身体/mod 自己的服务端口（它们不是 DSH 宿主地址，且各有归属）：
//   9333 mod（游戏内，零鉴权，挂账中）、9334 中继、9335 身体服务。
// DSH 宿主端口一律经 scripts\dsh-base.mjs 解析，不写死、也不猜。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '<工作区>';
const ALLOW = new Set(['9333', '9334', '9335']);
const FILES = [
  path.join(ROOT, 'handoff.mjs'),
  path.join(ROOT, 'new-workgroup-session.mjs'),
  ...fs.readdirSync(path.join(ROOT, 'scripts'))
    .filter((n) => n.endsWith('.mjs'))
    .map((n) => path.join(ROOT, 'scripts', n)),
];

let bad = 0;
for (const f of FILES) {
  const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    const code = line.split('//')[0]; // 注释里提到旧端口不算违规
    for (const m of code.matchAll(/127\.0\.0\.1:(\d+)/g)) {
      if (ALLOW.has(m[1])) continue;
      bad++;
      console.log(`FAIL ${path.relative(ROOT, f)}:${i + 1}  写死 http://127.0.0.1:${m[1]}`);
    }
  });
}
if (!bad) {
  console.log(`PASS 扫描 ${FILES.length} 个维护脚本，无写死的 DSH 端口`);
  console.log(`     （允许的服务端口：${[...ALLOW].join(' / ')}，由各自服务负责，不是 DSH 地址）`);
}
process.exitCode = bad ? 1 : 0;
