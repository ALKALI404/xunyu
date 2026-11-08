#!/usr/bin/env node
// scripts/rotate.mjs —— 换代自动化（十步 check list 状态机，UG-032）
//
// 主人：「换代也要程序化 00 检查，换代全自动，按照一项项 check list 的形式，上一条完成审核完自动下一条」
// 撞车教训：2026-10-30 凌晨「换代与补单同时下发」→ 新旧 05 并行改同一批文件。所以**单实例锁**是硬约束。
//
// ═══ 接口契约（改实现前先改这里）═══════════════════════════════════════════
// node scripts\rotate.mjs --worker <工号> [--old <旧会话id>] [--handoff <交接稿>]
//                        [--dry-run] [--resume] [--yes] [--echo-timeout <秒>] [--inject-fail <步号>]
//   退出码：0 = 十步全绿 ｜ 1 = 第 N 步失败（打印步号+缺什么+怎么退）｜ 2 = 锁占用（别人正在换）
//   锁：state\rotate.lock  {pid, at, worker}（单实例；pid 已死则自动接管并记审计）
//   状态：state\rotate-state.json {worker, startedAt, updatedAt, steps:{N:{ok,detail,at}}, handoff, oldId, newId}
//         --resume 从第一个未 ok 的步骤继续；**失败不回滚已完成步骤**
//   审计：logs\rotate.jsonl（每步一行）
//
// 十步（每步 = 执行 + 校验，校验不过立即停）：
//   1 触发判定   上下文 ≥ 阈值 且 该工号没有 doing 票
//   2 写交接稿   handoff.mjs prepare → 交接稿 >500B + 六字段 + 四块
//   3 建新会话   handoff.mjs new --who → 拿到 sessionId
//   4 改名       会话标题与「工号 NN」一致
//   5 投接班包   向新会话投一条 accepted=true 的 prompt（附"复述回写"契约）
//   6 校验复述   新会话把复述写进 state\rotate-echo-<工号>.md，且含 records\交付\ 引证
//   7 名册三处   tmp\check-roster-consistency.mjs 输出 0 处不一致
//   8 截图证据   capture-window.ps1 出图且 >50KB
//   9 归档旧会话 scan-stale-bindings exit=0 → handoff.mjs archive --yes → 归档数 +1
//  10 报告       新 id / 旧 id / 归档数 / 耗时（写审计）
//
// 契约增强（相对手工十步）：第 5 步除了投接班包，还会让新会话**把复述原文回写到
//   state\rotate-echo-<工号>.md**——第 6 步才能"零 LLM 地机器校验引证"，不用去刮界面。
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { replay } from './worklist-core.mjs';
import { evaluateLoadGate, dshApi } from './dispatch-core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WS = path.resolve(HERE, '..');
const LOCK = path.join(WS, 'state', 'rotate.lock');
const STATE = path.join(WS, 'state', 'rotate-state.json');
const AUDIT = path.join(WS, 'logs', 'rotate.jsonl');
const AUDIT2 = path.join(WS, 'state', 'rotate-audit.jsonl');   // BG-002 接口契约要求的观测路径（一行一步）
const FAILED = path.join(WS, 'state', 'rotate-failed.json');
const SHOT_DIR = path.join(WS, 'logs', 'rotate');
const CTX_MIN = Number(process.env.ROTATE_CTX_MIN ?? 630000);   // 负载闸 63 万（硬线 65 万 - 2 万）
const ECHO_TIMEOUT_S = 600;

const argv = process.argv.slice(2);
const opt = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const flag = (n) => argv.includes(`--${n}`);
const dryRun = flag('dry-run');
const resume = flag('resume');
const worker = String(opt('worker', '') ?? '').trim();
const oldIdArg = opt('old', null);
const handoffArg = opt('handoff', null);
const echoTimeoutS = Number(opt('echo-timeout', ECHO_TIMEOUT_S));
const injectFail = Number(opt('inject-fail', 0));
const yes = flag('yes');
// BG-002：--auto = 十步全自动、不再要人确认；只有第 6 步"复述校验"不过才停（停时写 state\rotate-failed.json）
const autoMode = flag('auto') || process.env.ROTATE_AUTO_MODE === '1';

if (!worker) {
  process.stderr.write('用法：node scripts\\rotate.mjs --worker <工号> [--old <旧会话id>] [--handoff <稿>] [--dry-run] [--resume] [--echo-timeout 600] [--inject-fail N]\n');
  process.exit(2);
}

const pad = (s, n) => String(s ?? '').padEnd(n);
const now = () => Date.now();
const stamp = () => new Date().toISOString();

function logStep(step, rec) {
  const line = `${JSON.stringify({ at: now(), worker, step, dryRun, ...rec })}\n`;
  try {
    fs.mkdirSync(path.dirname(AUDIT), { recursive: true });
    fs.appendFileSync(AUDIT, line, 'utf8');
  } catch { /* 审计写不了不阻塞 */ }
  // BG-002：契约要求观测在 state\rotate-audit.jsonl——两份都写，谁也别丢
  try {
    fs.mkdirSync(path.dirname(AUDIT2), { recursive: true });
    fs.appendFileSync(AUDIT2, line, 'utf8');
  } catch { /* ignore */ }
}

/** 失败落盘：state\rotate-failed.json（BG-002 接口契约）。--auto 下必须写，人跑也写一份方便排错。 */
function writeFailed(state, failedAt, stepName, why, cost) {
  const rec = {
    worker, at: stamp(), step: failedAt, stepName: stepName ?? null, reason: why ?? '',
    cost, auto: Boolean(autoMode),
    state: { handoff: state?.handoff ?? null, oldId: state?.oldId ?? null, newId: state?.newId ?? null, tokens: state?.tokens ?? null },
    steps: Object.fromEntries(Object.entries(state?.steps ?? {}).map(([k, v]) => [k, { ok: Boolean(v?.ok), detail: v?.detail ?? '' }])),
    next: `修掉上面那句缺的东西，然后 node scripts\\rotate.mjs --worker ${worker} --resume`
  };
  try {
    fs.mkdirSync(path.dirname(FAILED), { recursive: true });
    fs.writeFileSync(FAILED, `${JSON.stringify(rec, null, 2)}\n`, 'utf8');
  } catch { /* ignore */ }
  return rec;
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}
function saveState(s) {
  try { fs.writeFileSync(STATE, `${JSON.stringify(s, null, 2)}\n`, 'utf8'); } catch { /* ignore */ }
}

function runNode(script, args = [], timeout = 180000) {
  try {
    const out = execFileSync(process.execPath, [path.join(WS, 'scripts', script), ...args], { cwd: WS, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out: String(out) };
  } catch (e) {
    return { code: typeof e.status === 'number' ? e.status : 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}${e.message ?? ''}` };
  }
}

// ── 锁 ─────────────────────────────────────────────────────────────────────
function acquireLock() {
  const mk = () => fs.writeFileSync(LOCK, `${JSON.stringify({ pid: process.pid, at: now(), worker }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  try { mk(); return { ok: true }; } catch {
    let cur = null;
    try { cur = JSON.parse(fs.readFileSync(LOCK, 'utf8')); } catch { /* 坏锁当无锁 */ }
    if (!cur) { try { fs.writeFileSync(LOCK, `${JSON.stringify({ pid: process.pid, at: now(), worker }, null, 2)}\n`, 'utf8'); } catch { /* ignore */ } return { ok: true, stole: 'bad-lock' }; }
    let alive = false;
    try { process.kill(Number(cur.pid), 0); alive = true; } catch { alive = false; }
    if (alive) return { ok: false, holder: cur };
    // pid 已死：接管并留痕
    logStep(0, { ok: true, code: 'lock-stolen', detail: `接管死锁 pid=${cur.pid}（${cur.worker}）` });
    try { fs.writeFileSync(LOCK, `${JSON.stringify({ pid: process.pid, at: now(), worker }, null, 2)}\n`, 'utf8'); } catch { /* ignore */ }
    return { ok: true, stole: `dead-pid-${cur.pid}` };
  }
}
function releaseLock() { try { fs.rmSync(LOCK, { force: true }); } catch { /* ignore */ } }

// ── 交接稿校验（六字段 + 四块 + >500B）─────────────────────────────────────
function latestHandoff() {
  try {
    const hits = fs.readdirSync(WS).filter((f) => /^交接-\d{4}-\d{2}-\d{2}-\d{4}\.md$/.test(f))
      .map((f) => ({ f, at: fs.statSync(path.join(WS, f)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    return hits.length ? path.join(WS, hits[0].f) : null;
  } catch { return null; }
}
function checkHandoff(file) {
  if (!file || !fs.existsSync(file)) return { ok: false, why: '找不到交接稿' };
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const bytes = Buffer.byteLength(text, 'utf8');
  const missing = [];
  if (bytes <= 500) missing.push(`体积 ${bytes}B ≤ 500B`);
  // 四块认「实际写法」，不认死标题：真交接稿常写「一句话现状 / 这一棒落地了什么 / 未完成 / 坑」
  const BLOCKS = [
    ['在做什么', /在做什么|一句话现状|现在在做什么|当前状态/],
    ['落地', /落地|这一棒/],
    ['下一步', /下一步|未完成|待办|还没做|遗留/],
    ['坑', /坑/]
  ];
  for (const [name, re] of BLOCKS) if (!re.test(text)) missing.push(`缺「${name}」块`);
  for (const k of ['谁', '什么', '状态', '证据', '下一步', '卡点']) if (!text.includes(k)) missing.push(`六字段缺「${k}」`);
  return { ok: missing.length === 0, bytes, missing, file };
}

// ── DSH API ────────────────────────────────────────────────────────────────
async function listSessionsSafe() {
  try {
    const { api, unwrap } = await dshApi();
    const r = await api.sessions.list({});
    return { ok: true, items: unwrap(r, 'session.list').items ?? [] };
  } catch (e) { return { ok: false, error: String(e?.message ?? e), items: [] }; }
}
const titleOf = (s) => String(s?.projections?.values?.title ?? '');
function pickWorkerSession(items, w) {
  const re = new RegExp(`工号\\s*0*${w}\\b`);
  return items.filter((s) => !s.blank && re.test(titleOf(s)))
    .sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0))[0] ?? null;
}

// ── 十步 ───────────────────────────────────────────────────────────────────
const STEPS = [
  {
    n: 1, name: '触发判定',
    plan: () => `看工号 ${worker} 的上下文（≥${CTX_MIN}）+ 有没有 doing 票`,
    async run() {
      const doing = replay().filter((t) => t.state === 'doing' && String(t.target) === String(worker));
      const gate = await evaluateLoadGate(worker, { force: false }).catch((e) => ({ ok: false, code: 'gate-error', detail: String(e?.message ?? e) }));
      const tokens = Number(gate?.tokens ?? 0);
      const noSession = gate?.code === 'load-unknown' || !gate?.sessionId;
      const ok = doing.length === 0 && (noSession || tokens >= CTX_MIN);
      return {
        ok,
        detail: `上下文 ${tokens || '未知'}｜doing ${doing.length} 张${doing.length ? `（${doing.map((t) => t.ticket ?? t.id).join('、')}）` : ''}${noSession ? '｜未找到该工号会话（演练/新工号可忽略上下文）' : ''}`,
        tokens, doing: doing.map((t) => t.ticket ?? t.id)
      };
    }
  },
  {
    n: 2, name: '写交接稿',
    plan: () => '跑 handoff.mjs prepare 生成交接稿，校验六字段 + 四块 + >500B',
    async run() {
      // resume 时复用上一轮已认定的稿子，别因为目录里多了一份草稿就改口径
      const prev = loadState() ?? {};
      if (!handoffArg && prev.handoff && fs.existsSync(prev.handoff)) {
        const chk0 = checkHandoff(prev.handoff);
        if (chk0.ok) return { ok: true, detail: `${path.basename(prev.handoff)}（${chk0.bytes}B，沿用上一轮）`, handoff: prev.handoff };
      }
      if (!handoffArg) {
        const r = runNode('handoff.mjs', ['prepare', '--who', worker]);
        if (r.code !== 0 && !handoffArg) return { ok: false, detail: `prepare 失败：${r.out.slice(-300)}` };
      }
      const file = handoffArg ? path.resolve(WS, handoffArg) : latestHandoff();
      const chk = checkHandoff(file);
      return { ok: chk.ok, detail: chk.ok ? `${path.basename(file)}（${chk.bytes}B，六字段/四块齐）` : `交接稿不合格：${chk.missing.join('、')}`, handoff: file };
    }
  },
  {
    n: 3, name: '建新会话',
    plan: () => `handoff.mjs new --who ${worker}`,
    async run() {
      const st = loadState() ?? {};
      // 【BG-002 返工·真换代踩到的坑】state\handoff.json 是**全局单份**交接状态。
      // 如果它还记着**别的工号**、而且那场换代没归档完，说明另一场换代正在跑（或卡住了）。
      // 这时候再调 handoff new 会把对方的状态覆盖掉，而且拿回来的 newSessionId 可能是别人家的
      // （2026-11-04 实测：给 03 建会话，拿回来的是已归档的 06 会话 8117d892，第 4 步才发现）。
      // 所以先看一眼占用，占着就直接失败——**并发换代比慢一拍危险得多**。
      let hs0 = null;
      try {
        hs0 = JSON.parse(fs.readFileSync(path.join(WS, 'state', 'handoff.json'), 'utf8').replace(/^\uFEFF/, ''));
      } catch { /* 没有就当没占用 */ }
      if (hs0?.lastWho && String(hs0.lastWho) !== String(worker)) {
        // "那场换代还在跑吗"的正确判据不是"旧会话归档了没"（归档在最后一步，跑在前面时旧会话当然还在），
        // 而是**名册有没有换绑**：roster.active[lastWho].sessionId 已经等于 handoff.newSessionId = 跑完了。
        const other = String(hs0.lastWho);
        let rebound = false;
        try {
          const r0 = JSON.parse(fs.readFileSync(path.join(WS, 'state', 'roster.json'), 'utf8').replace(/^\uFEFF/, ''));
          const act = (Array.isArray(r0.active) ? r0.active : Object.values(r0.active ?? {}))
            .find((x) => String(x?.id ?? '') === other);
          rebound = Boolean(act?.sessionId) && String(act.sessionId) === String(hs0.newSessionId ?? '');
        } catch { /* 读不到名册就当没换绑 = 还在跑 */ }
        if (!rebound) {
          return {
            ok: false,
            detail: `交接状态被工号 ${other} 占着（state\\handoff.json: newSessionId=${String(hs0.newSessionId ?? '—').slice(0, 20)}… 还没换绑到名册）——`
              + `那场换代还在跑或卡住了，先让它收口再来；并发换代会互相覆盖 handoff 状态，也拿不到对的 newSessionId`
          };
        }
      }
      const args = ['new', '--who', worker];
      if (st.handoff) args.push('--handoff', st.handoff);
      const r = runNode('handoff.mjs', args);
      // 权威来源是 handoff 状态里的 newSessionId——别从 stdout 里正则抓（会抓到"待归档的旧会话"）。
      // 抓错的那一下 2026-11-04 真踩过：正则抓到 8117d892（已归档的 06 会话），第 4 步才炸。
      // 现在**不再兜底猜**：lastWho 对不上就当场失败，让人来看，而不是绑一个错会话上去。
      let newId = null;
      try {
        const hs = JSON.parse(fs.readFileSync(path.join(WS, 'state', 'handoff.json'), 'utf8').replace(/^\uFEFF/, ''));
        if (String(hs.lastWho) === String(worker)) newId = String(hs.newSessionId ?? '') || null;
      } catch { /* ignore */ }
      if (r.code !== 0) return { ok: false, detail: `建会话失败（exit ${r.code}）：${String(r.out).slice(-300)}` };
      if (!newId) {
        return {
          ok: false,
          detail: `handoff new 跑完了但 state\\handoff.json 的 lastWho≠${worker} 或没有 newSessionId——`
            + `不从 stdout 猜 id（会猜成"待归档的旧会话"），请人工确认 handoff 状态后 --resume`
        };
      }
      return { ok: true, detail: `新会话 ${newId}（取自 state\\handoff.json，lastWho 已核对）`, newId };
    }
  },
  {
    n: 4, name: '改名',
    plan: () => '校验新会话标题带「工号 NN」（handoff new 已改名，这里只核）',
    async run() {
      const st = loadState() ?? {};
      const { ok, items, error } = await listSessionsSafe();
      if (!ok) return { ok: false, detail: `列会话失败：${error}` };
      const s = items.find((x) => String(x.sessionId) === String(st.newId));
      if (!s) return { ok: false, detail: `没找到新会话 ${st.newId}` };
      const title = titleOf(s);
      const want = worker === '演练' ? /演练|本体/ : new RegExp(`工号\\s*0*${worker}\\b`);
      return { ok: want.test(title), detail: `标题「${title}」${want.test(title) ? '一致' : '与命名不符'}` };
    }
  },
  {
    n: 5, name: '投接班包',
    plan: () => '向新会话投「复述回写」契约 prompt，要求 accepted=true',
    async run() {
      const st = loadState() ?? {};
      if (!st.newId) return { ok: false, detail: '没有新会话 id（第 3 步没成）' };
      const echo = path.relative(WS, path.join(WS, 'state', `rotate-echo-${worker}.md`)).replace(/\\/g, '\\');
      const text = [
        `【换代自动校验】工号 ${worker} 的接班包已投。`,
        `请把你刚才那份复述（含引用的交付稿文件名）**原文**写进 ${echo}（用 write 工具，别省略）。`,
        '这一步是自动校验用的：没有这个文件，换代流程会停在第 6 步。',
        '其余照原任务书做，不用问我。'
      ].join('\n');
      try {
        const { api } = await dshApi();
        const res = await api.sessions.prompt({ sessionId: String(st.newId), mode: 'queue', content: [{ type: 'text', text }] });
        const accepted = Boolean(res?.result?.value?.accepted ?? res?.result?.accepted ?? res?.result?.ok ?? false);
        return { ok: accepted, detail: accepted ? `accepted=true（${text.length} 字，含复述回写契约）` : `投递未被接受：${JSON.stringify(res).slice(0, 200)}` };
      } catch (e) { return { ok: false, detail: `投递失败：${String(e?.message ?? e)}` }; }
    }
  },
  {
    n: 6, name: '校验复述',
    plan: () => `等新会话写 state\\rotate-echo-${worker}.md（含 records\\交付\\ 引证），最多 ${echoTimeoutS}s`,
    async run() {
      const file = path.join(WS, 'state', `rotate-echo-${worker}.md`);
      try { fs.rmSync(file, { force: true }); } catch { /* 旧文件先清，免得拿上一轮的过 */ }
      const t0 = now();
      while (now() - t0 < echoTimeoutS * 1000) {
        if (fs.existsSync(file)) {
          const text = fs.readFileSync(file, 'utf8');
          if (/records[\\/]交付[\\/][^\s]*\.md/.test(text)) return { ok: true, detail: `复述已回写并引用交付稿（${text.length} 字）`, file };
          return { ok: false, detail: `复述文件写到了，但**没有引用交付稿文件名**（要 records\\交付\\<…>.md 那种）`, file };
        }
        await new Promise((r) => setTimeout(r, 5000));
      }
      return { ok: false, detail: `等了 ${echoTimeoutS}s 没等到 state\\rotate-echo-${worker}.md——新会话可能没跑起来/没照做`, file };
    }
  },
  {
    n: 7, name: '名册三处',
    plan: () => '跑 tmp\\check-roster-consistency.mjs，要求「0 处不一致」',
    async run() {
      let out = '';
      let code = 0;
      try { out = execFileSync(process.execPath, [path.join(WS, 'tmp', 'check-roster-consistency.mjs')], { cwd: WS, encoding: 'utf8', timeout: 120000 }); }
      catch (e) { code = typeof e.status === 'number' ? e.status : 1; out = `${e.stdout ?? ''}${e.stderr ?? ''}${e.message ?? ''}`; }
      const zero = /0\s*处不一致/.test(String(out));
      return { ok: zero, detail: zero ? '0 处不一致' : `名册不一致：${String(out).trim().split(/\r?\n/).slice(-3).join(' / ').slice(0, 240)}` };
    }
  },
  {
    n: 8, name: '截图证据',
    plan: () => 'capture-window.ps1 抓窗口图，要求 >50KB',
    async run() {
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      const out = path.join(SHOT_DIR, `rotate-${worker}-${Date.now()}.png`);
      const ps = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      try {
        const r = execFileSync(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(WS, 'scripts', 'capture-window.ps1'), '-Out', out, '-Process', process.env.DSH_WINDOW_PROCESS ?? 'DSH NEXT'], { cwd: WS, encoding: 'utf8', timeout: 60000 });
        const j = JSON.parse(String(r).trim().split(/\r?\n/).filter(Boolean).pop());
        const bytes = Number(j.bytes ?? 0);
        return { ok: j.ok === true && bytes > 50 * 1024, detail: `截图 ${path.relative(WS, out)}｜${bytes}B（要求 >51200）｜窗口「${j.title ?? '?'}」`, file: out };
      } catch (e) {
        return { ok: false, detail: `截图失败：${String(e?.message ?? e).slice(0, 200)}` };
      }
    }
  },
  {
    n: 9, name: '归档旧会话',
    plan: () => 'scan-stale-bindings exit=0 → handoff.mjs archive --yes → 归档数 +1',
    async run() {
      const st = loadState() ?? {};
      const oldId = oldIdArg ?? st.oldId;
      // BG-002 演练发现：新工号/演练会话**没有上一代**，第 9 步不该因此判失败——
      // 那不是"漏了归档"，是"没有可归档的东西"。显式放行并写清原因，别让十步假红。
      if (!oldId && autoMode) return { ok: true, detail: '无旧会话可归档（新工号/演练会话，本步跳过）', oldId: null };
      if (!oldId) return { ok: false, detail: '没指定旧会话（--old 或 state.oldId），不瞎归档' };
      const scan = runNode('scan-stale-bindings.mjs', [String(oldId)]);
      if (scan.code !== 0) return { ok: false, detail: `还有活绑定指向 ${oldId}，不许归档：${scan.out.trim().slice(-240)}` };
      const r = runNode('handoff.mjs', ['archive', String(oldId), '--yes']);
      // 归档集合大小只有 API 返回值里才有（handoff 打印「归档集合共 N 个」），照这个数记
      const m = String(r.out).match(/归档集合共\s*(\d+)\s*个/);
      const count = m ? Number(m[1]) : null;
      const archivedLine = /已归档/.test(String(r.out));
      const ok = r.code === 0 && archivedLine;
      return { ok, detail: `扫描 exit=0｜归档 exit=${r.code}｜归档集合共 ${count ?? '?'} 个${ok ? '' : `｜${String(r.out).trim().slice(-200)}`}`, oldId };
    }
  },
  {
    n: 10, name: '报告',
    plan: () => '输出新 id / 旧 id / 归档数 / 耗时，写 logs\\rotate.jsonl',
    async run() {
      const st = loadState() ?? {};
      const cost = Math.round((now() - Number(st.startedAt ?? now())) / 1000);
      return { ok: true, detail: `worker=${worker} 新=${st.newId ?? '—'} 旧=${st.oldId ?? '—'} 耗时 ${cost}s` };
    }
  }
];

// ── 主流程 ─────────────────────────────────────────────────────────────────
async function main() {
  if (dryRun) {
    console.log(`换代计划（工号 ${worker}）${resume ? '［--resume］' : ''}：`);
    for (const s of STEPS) console.log(`  ${s.n}. ${pad(s.name, 10)} ${s.plan()}`);
    console.log('\n（--dry-run：不建会话、不归档、不写任何文件）');
    process.exitCode = 0;
    return;
  }

  const lock = acquireLock();
  if (!lock.ok) {
    console.error(`✗ 锁占用：pid ${lock.holder?.pid}（工号 ${lock.holder?.worker}，${new Date(Number(lock.holder?.at ?? 0)).toLocaleString('zh-CN', { hour12: false })} 起）正在换代`);
    console.error('  同一时间只许一个换代。等它跑完；确认它死了就删 state\\rotate.lock');
    logStep(0, { ok: false, code: 'lock-busy', holder: lock.holder ?? null });
    process.exitCode = 2;
    return;
  }
  if (lock.stole) console.log(`· ${lock.stole === 'bad-lock' ? '锁文件坏了，已重写' : `接管死锁 ${lock.stole}`}`);

  const prev = resume ? loadState() : null;

  // BG-002：--auto 模式下自己把"旧会话"找出来，00 只敲一条命令（不用先查 roster/贴 --old）
  let autoOldId = oldIdArg ?? prev?.oldId ?? null;
  if (autoMode && !autoOldId) {
    try {
      const roster = JSON.parse(fs.readFileSync(path.join(WS, 'state', 'roster.json'), 'utf8').replace(/^\uFEFF/, ''));
      const act = (Array.isArray(roster.active) ? roster.active : Object.values(roster.active ?? {}))
        .find((x) => String(x?.id ?? '') === String(worker));
      if (act?.sessionId) autoOldId = String(act.sessionId);
    } catch { /* ignore */ }
    if (!autoOldId) {
      const items = (await listSessionsSafe()).items ?? [];
      autoOldId = pickWorkerSession(items, worker)?.sessionId ?? null;
    }
    if (autoOldId) console.log(`· --auto：旧会话自动认定为 ${autoOldId}（取自 roster/会话列表）`);
  }

  const state = {
    worker, startedAt: prev?.startedAt ?? now(), updatedAt: now(),
    handoff: prev?.handoff ?? (handoffArg ? path.resolve(WS, handoffArg) : null),
    oldId: autoOldId ?? prev?.oldId ?? null,
    newId: prev?.newId ?? null,
    steps: resume ? (prev?.steps ?? {}) : {}
  };
  saveState(state);

  const t0 = now();
  let failedAt = 0;
  try {
    for (const step of STEPS) {
      // 测试注入先于 resume 跳过：--inject-fail N 是"硬制造第 N 步失败"，哪怕它已经 ok
      if (injectFail === step.n) {
        console.log(`  ${step.n}. ${pad(step.name, 10)} ✗ 注入失败（--inject-fail ${step.n}）`);
        state.steps[step.n] = { ok: false, at: now(), detail: 'inject-fail（测试注入）' };
        saveState(state); logStep(step.n, { ok: false, code: 'inject-fail' }); failedAt = step.n;
        break;
      }
      const done = state.steps[step.n];
      if (resume && done?.ok) { console.log(`  ${step.n}. ${pad(step.name, 10)} · 已 ok（resume 跳过）`); continue; }
      let res;
      try { res = await step.run(); } catch (e) { res = { ok: false, detail: String(e?.message ?? e) }; }
      // 把子步骤的产出落到 state 里
      if (res.handoff) state.handoff = res.handoff;
      if (res.newId) state.newId = res.newId;
      if (res.oldId) state.oldId = res.oldId;
      if (res.tokens != null) state.tokens = res.tokens;
      state.steps[step.n] = { ok: Boolean(res.ok), at: now(), detail: res.detail ?? '' };
      state.updatedAt = now();
      saveState(state);
      logStep(step.n, { ok: Boolean(res.ok), detail: res.detail ?? '' });
      console.log(`  ${step.n}. ${pad(step.name, 10)} ${res.ok ? 'ok ' : '✗ '} ${res.detail ?? ''}`);
      if (!res.ok) { failedAt = step.n; break; }
    }
  } finally {
    releaseLock();
  }

  const cost = Math.round((now() - t0) / 1000);
  if (!failedAt) {
    console.log(`\n✓ 十步全绿（工号 ${worker}，${cost}s）：新=${state.newId ?? '—'} 旧=${state.oldId ?? '—'}`);
    logStep('done', { ok: true, cost, newId: state.newId, oldId: state.oldId });
    process.exitCode = 0;
  } else {
    const step = STEPS.find((s) => s.n === failedAt);
    const why = state.steps[failedAt]?.detail ?? '';
    console.error(`\n✗ 停在第 ${failedAt} 步「${step?.name ?? '?'}」：${why}`);
    console.error(`  已完成 ${Object.values(state.steps).filter((s) => s.ok).length} 步（不回滚）`);
    console.error(`  怎么退：修掉上面那句缺的东西，然后 node scripts\\rotate.mjs --worker ${worker} --resume 从这里继续`);
    if (failedAt === 9) console.error('  （第 9 步没成：确认没有活绑定指向旧会话，或换一个 --old）');
    logStep('failed', { ok: false, at: failedAt, step: step?.name ?? null, detail: why });
    // BG-002：失败落盘（--auto 的契约要求；人跑也写，方便下一个人不用翻日志）
    const rec = writeFailed(state, failedAt, step?.name, why, cost);
    console.error(`  失败已落盘：state\\rotate-failed.json（step=${rec.step}「${rec.stepName ?? '?'}」）`);
    process.exitCode = 1;
  }
}

await main();
