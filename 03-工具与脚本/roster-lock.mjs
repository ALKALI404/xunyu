// 名册互斥 + 原子写（最小可用版，2026-10-26 04）
//
// 为什么需要：ROSTER.md（人看）与 state\roster.json（脚本读）是同一份信息的两面。
// 两个写者「读-改-写」交错时，后写的直接盖掉先写的——A 的记录就这么没了，还没人报错。
//
// 做法：锁文件（O_CREAT|O_EXCL 原子创建）+ 过期抢占（持有者进程死了/锁太老）+ 原子写（tmp→rename）。
// 边界：这是**进程间**互斥，管不住人用编辑器手改；手改也不用担心——脚本写的是整份内容，不会撕行。
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_LOCK = '<工作区>\\state\\roster.lock';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pidAlive(pid) {
  if (!pid) return false;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}

/**
 * 取锁；返回 release()。调用方必须 finally 里 release。
 * @param {string} [lockPath]
 * @param {{ timeoutMs?: number, staleMs?: number }} [opts]
 */
export async function acquireLock(lockPath = DEFAULT_LOCK, { timeoutMs = 15000, staleMs = 30000 } = {}) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const started = Date.now();
  // Windows 上「别人正在建/删同一个文件」会抛 EPERM/EBUSY，不是致命错误，按忙处理重试。
  const RETRY = new Set(['EEXIST', 'EPERM', 'EBUSY', 'EACCES']);
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx'); // 原子：已存在就 EEXIST
      try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), host: process.env.COMPUTERNAME ?? '' })); } finally { fs.closeSync(fd); }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        for (let i = 0; i < 20; i++) {
          try { fs.unlinkSync(lockPath); return; } catch { sleepSync(5); }
        }
      };
    } catch (e) {
      if (!RETRY.has(e?.code)) throw e;
      // 只有「确定没主」才抢：锁文件年龄超过 staleMs，或内容能解析且持有进程已死。
      // 注意：**不能**因为内容读不出来（刚建、还没写完）就抢——那会让两个进程同时拿到锁。
      let stale = false;
      try { if (Date.now() - fs.statSync(lockPath).mtimeMs > staleMs) stale = true; } catch { stale = false; }
      if (!stale) {
        try {
          const info = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
          if (info?.pid && !pidAlive(info.pid)) stale = true;
        } catch { /* 空/半份内容：年龄没到就等，别抢 */ }
      }
      if (stale) {
        try { fs.unlinkSync(lockPath); } catch { /* 别人也抢到了就重来 */ }
        continue;
      }
      if (Date.now() - started > timeoutMs) {
        throw new Error(`等锁超时 ${timeoutMs}ms：${lockPath}（持有者还活着，说明它在写；等它，别硬闯）`);
      }
      await sleep(5 + Math.random() * 25);
    }
  }
}

/** 在锁里跑 fn（fn 里做读-改-写，写完用 atomicWriteFile 落盘） */
export async function withRosterLock(fn, { lockPath = DEFAULT_LOCK, timeoutMs = 15000, staleMs = 30000 } = {}) {
  const release = await acquireLock(lockPath, { timeoutMs, staleMs });
  try { return await fn(); } finally { release(); }
}

/** 同步小睡（锁里是同步流程，不能 await） */
const sleepSync = (ms) => {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* 极端环境不允许就空转 */ }
};

/**
 * 原子写：先写同目录临时文件，再 rename（同盘 rename 原子，读到的要么旧要么新，不会是半份）。
 * Windows 上 rename 可能撞 EPERM/EBUSY——目标正被别的进程读着就会这样（实测 4 进程写同一份时必现），
 * 所以退避重试；重试仍失败就清掉临时文件并原样抛出，绝不静默当成功。
 */
export function atomicWriteFile(file, data, { retries = 60 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
  fs.writeFileSync(tmp, data, 'utf8');
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try { fs.renameSync(tmp, file); return; }
    catch (e) {
      lastErr = e;
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e?.code)) break;
      sleepSync(5 + Math.random() * 20);
    }
  }
  try { fs.unlinkSync(tmp); } catch { /* 清不掉也无所谓，下面会抛 */ }
  throw lastErr;
}

/** 读 JSON（坏了返回 null），给锁里的读-改-写用 */
export function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

/**
 * 名册的读-改-写一体：mutate(json) 就地改，落盘用原子写。
 * 示例：await updateRosterJson(j => j.active.push({ id:'04', cwd:'<工作区>' }))
 */
export async function updateRosterJson(mutate, {
  file = '<工作区>\\state\\roster.json',
  lockPath = DEFAULT_LOCK,
  timeoutMs = 15000,
} = {}) {
  return withRosterLock(async () => {
    const j = readJsonSafe(file);
    if (!j) throw new Error(`读不出名册（坏 JSON 或不存在）：${file}`);
    mutate(j);
    j.updatedAt = new Date().toISOString();
    atomicWriteFile(file, JSON.stringify(j, null, 2) + '\n');
    return j;
  }, { lockPath, timeoutMs });
}
