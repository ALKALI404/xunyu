// scripts/session-lookup.mjs —— sessionId → 会话标题（WS-014 的 helper）
//
// 为什么要有它：capture-window.ps1 要「按会话定位窗口」，而窗口标题里写的是**会话标题**
// 不是 sessionId。PowerShell 侧不好直接调 DSH 客户端，所以把这一步单独做成一个小 CLI。
//
// 用法：
//   node scripts\session-lookup.mjs --id <sessionId 或 6 位以上短 id>
//       → stdout 一行 JSON：{"ok":true,"sessionId":"session-…","title":"…"}
//   node scripts\session-lookup.mjs --list
//       → stdout 每行一条：<sessionId>\t<title>
//
// 退出码：0 成功 / 1 用法或环境错（连不上 DSH 等）/ 2 找不到该会话
//
// 只读：只调 sessions.list，不建不改不删。
//
// 坑（2026-11-02 实测）：**别用 process.exit()**。DSH 客户端会留 keep-alive 连接，
// 在还有未排空句柄时 exit，Windows 上会直接 abort
// （Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c:76）。
// 所以这里只设 process.exitCode，让 node 自己把事件循环排空。
import { resolveDshBase, readJson } from './dsh-base.mjs';

const CLIENT = 'file:///E:/DeepFish/qq-bridge-0.2.1-r1/qq-bridge-0.2.1-r1/src/dsh-client.js';
const CFG_PATH = process.env.XUNYU_WS
  ? `${process.env.XUNYU_WS}\\state\\handoff-config.json`
  : 'E:\\DSH_workspace\\state\\handoff-config.json';

const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : null;
};

async function listSessions() {
  const mod = await import(CLIENT);
  const { NodeApiClient, unwrap } = mod;
  const base = resolveDshBase({ config: readJson(CFG_PATH) ?? {} }).url;
  const api = new NodeApiClient(base, undefined, {
    token: '', tokenExplicit: false, header: 'authorization', prefix: 'Bearer', allowRemote: false,
  });
  const r = unwrap(await api.sessions.list({}), 'session.list');
  return (r?.items ?? []).map((it) => ({
    sessionId: String(it.sessionId ?? ''),
    title: String(it.projections?.values?.title ?? '(无标题)'),
    updatedAt: it.updatedAt ?? 0,
  })).filter((s) => s.sessionId);
}

const short = (sid) => String(sid).replace(/^session-/, '').slice(0, 8);

/** 匹配：全等优先，其次「去 session- 前缀后以前缀开头」 */
function match(all, want) {
  const w = String(want).trim();
  if (!w) return { hit: null, why: 'empty' };
  const byFull = all.filter((s) => s.sessionId === w);
  if (byFull.length === 1) return { hit: byFull[0], why: 'full-id' };
  const bare = w.replace(/^session-/, '');
  if (bare.length < 6) return { hit: null, why: 'too-short' };
  const byPrefix = all.filter((s) => s.sessionId.replace(/^session-/, '').startsWith(bare));
  if (byPrefix.length === 1) return { hit: byPrefix[0], why: 'short-id' };
  if (byPrefix.length > 1) return { hit: null, why: 'ambiguous', cands: byPrefix };
  return { hit: null, why: 'not-found' };
}

(async () => {
  let all;
  try {
    all = await listSessions();
  } catch (e) {
    process.stderr.write(`连不上 DSH 或取不到会话列表：${e?.message ?? e}\n`);
    process.exitCode = 1;
    return;
  }

  if (argv.includes('--list')) {
    all.sort((a, b) => b.updatedAt - a.updatedAt);
    process.stdout.write(all.map((s) => `${s.sessionId}\t${s.title}\n`).join(''));
    process.exitCode = 0;
    return;
  }

  const want = argOf('id');
  if (!want) {
    process.stderr.write('用法：node scripts\\session-lookup.mjs --id <sessionId|短id>  或  --list\n');
    process.exitCode = 1;
    return;
  }

  const { hit, why, cands } = match(all, want);
  if (hit) {
    process.stdout.write(`${JSON.stringify({ ok: true, sessionId: hit.sessionId, title: hit.title })}\n`);
    process.exitCode = 0;
    return;
  }

  const pool = cands ?? all.slice(0, 400);
  process.stderr.write(`找不到会话「${want}」（${why}）。候选 ${pool.length} 条：\n`);
  for (const s of pool.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 40)) {
    process.stderr.write(`${s.sessionId}\t${short(s.sessionId)}\t${s.title}\n`);
  }
  process.exitCode = 2;
})();
