// 实测：名册锁能不能扛住「多进程同时读-改-写」。
// 跑法：node scripts\test-roster-lock.mjs
//
// 两组：
//   A 加锁（withRosterLock + atomicWriteFile）——必须 WORKERS*PER 条一条不少；
//   B 对照组不加锁——预期丢记录，用来证明这个测试不是摆设。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { withRosterLock, atomicWriteFile, readJsonSafe } from './roster-lock.mjs';

const WORKERS = 4;
const PER = 250;
const TMP = '<工作区>\\tmp\\roster-lock-test';

// ── worker 模式 ──
if (process.argv[2] === '--worker') {
  const [, file, lockPath, tag, count, mode] = process.argv.slice(2);
  for (let i = 0; i < Number(count); i++) {
    const write = () => {
      const j = readJsonSafe(file) ?? { items: [] };
      j.items.push(`${tag}#${i}`);
      atomicWriteFile(file, JSON.stringify(j));
    };
    if (mode === 'lock') await withRosterLock(write, { lockPath, timeoutMs: 30000 });
    else write();
  }
  process.exit(0);
}

// ── 主控 ──
const file = path.join(TMP, 'roster.json');
const lockPath = path.join(TMP, 'roster.lock');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

function run(mode) {
  atomicWriteFile(file, JSON.stringify({ items: [] }));
  const t0 = Date.now();
  return Promise.all(Array.from({ length: WORKERS }, (_, k) => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [process.argv[1], '--worker', file, lockPath, `w${k}`, String(PER), mode], { stdio: 'inherit' });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`worker ${k} exit ${code}`))));
    p.on('error', reject);
  }))).then(() => {
    const got = readJsonSafe(file)?.items?.length ?? 0;
    const uniq = new Set(readJsonSafe(file)?.items ?? []).size;
    return { got, uniq, ms: Date.now() - t0 };
  });
}

const expect = WORKERS * PER;
const locked = await run('lock');
const unlocked = await run('plain');

const ok = locked.got === expect && locked.uniq === expect;
console.log(`\n[加锁]   ${locked.got}/${expect} 条，去重 ${locked.uniq}，${locked.ms}ms`);
console.log(`[对照]   ${unlocked.got}/${expect} 条，去重 ${unlocked.uniq}，${unlocked.ms}ms（不加锁，丢 ${expect - unlocked.got} 条）`);
console.log(ok ? 'PASS 加锁后一条不丢' : `FAIL 加锁后应为 ${expect}，实得 ${locked.got}（去重 ${locked.uniq}）`);
process.exitCode = ok ? 0 : 1;
