#!/usr/bin/env node
// 鲟鱼项目 · 交接自动化
//
// 一条命令干完「交接」这条链：
//   自检 → 生成交接稿骨架 → 新建接手会话并投递首条消息 → 提醒你归档旧会话
//
// 用法（在 E:\DSH_workspace 下）：
//   node handoff.mjs status                     看状态：五项健康 + 最新交接稿 + 未归档的旧会话
//   node handoff.mjs prepare [--dry] [--who <工号>]
//                                               自检 + 生成 交接-YYYY-MM-DD-HHMM.md
//                                               按 交接簿.md §4.1 六字段出骨架；
//                                               --dry 只把全文打到 stdout，不写文件、不动 state
//   node handoff.mjs new [--handoff <路径>] [--old <旧会话id>] [--dry]
//                                               用最新交接稿建新会话、投递首条消息、写提醒
//   node handoff.mjs archive <sessionId> [--yes] 归档旧会话（默认只演练，--yes 才真归档）
//   node handoff.mjs archive --pending [--yes]   归档所有待归档会话
//   node handoff.mjs unarchive <sessionId> [--yes]
//   node handoff.mjs remind                     只打印「该归档旧会话了」的提醒
//
// 归档 = DSH 的 workspace/archiveSession（只隐藏，可在界面里恢复：unarchiveSession）。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
// 2026-10-27：本体从根目录搬进 scripts\，同目录引用跟着改（04 那条批 3 待办）
import { resolveDshBase, readJson } from './dsh-base.mjs';

// ── 路径：交接家目录（交接稿 / state / 日志放哪）────────────────────
// 2026-10-26 23:5x（04）：原来 WS 一个变量既当「记录放哪」又当「新会话建哪」，
// 本体换代时把会话建到了 E:\DSH_workspace（错位会话 session-5f0277fd，23:47 归档）。
// 现在拆两层：HANDOFF_HOME = 记录放哪；resolveSessionWs(who) = 新会话建在哪（按「谁在交接」取值）。
const HANDOFF_HOME = process.env.XUNYU_WS ?? 'E:\\DSH_workspace';
const WS = HANDOFF_HOME; // 旧引用别名：交接稿、state、日志都在这
const STATE_DIR = path.join(HANDOFF_HOME, 'state');
const STATE_FILE = path.join(STATE_DIR, 'handoff.json');
const CONFIG_FILE = path.join(STATE_DIR, 'handoff-config.json');
const CONFIG = readJson(CONFIG_FILE) ?? {};

// ── UG-074：归档审计（logs\archive.jsonl）──────────────────────────────────
// 为什么要有：2026-10-31~11-01 两次追查「归档集合为什么 95→138→256」，**每次都查不出是谁归的**
// （archive 只往 stdout 打一行、不落盘；heal/pain 里没有 archive 记录）。本单只加一个追加日志，
// 不改归档行为。写日志失败**不得影响归档**（try/catch + warn）。
const ARCHIVE_LOG = path.join(WS, 'logs', 'archive.jsonl');
const DSH_WORKSPACE_JSON = path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'storages', 'workspace.json');

/** 读 DSH 的归档集合（`global.archivedSessionIds`）。读不到返回 null（调用方当"未知"处理，不瞎写 0）。 */
function readArchivedIds() {
  try {
    const j = JSON.parse(fs.readFileSync(DSH_WORKSPACE_JSON, 'utf8').replace(/^\uFEFF/, ''));
    const arr = j?.global?.archivedSessionIds;
    return Array.isArray(arr) ? arr.map(String) : null;
  } catch { return null; }
}

/** 追加一行归档审计。**永不抛**：日志坏了不能挡住归档。 */
function appendArchiveLog(rec) {
  try {
    fs.mkdirSync(path.dirname(ARCHIVE_LOG), { recursive: true });
    fs.appendFileSync(ARCHIVE_LOG, `${JSON.stringify(rec)}\n`, 'utf8');
    return true;
  } catch (error) {
    console.warn(`⚠ 归档审计写失败（不影响归档）：${String(error?.message ?? error).slice(0, 120)}`);
    return false;
  }
}
// 23:0x 目录重构：日志搬进了 records\；两处都找，别静默报「无节」
const LOG_FILE = [
  path.join(HANDOFF_HOME, 'records', '工作日志.md'),
  path.join(HANDOFF_HOME, '工作日志.md'),
].find((p) => fs.existsSync(p)) ?? path.join(HANDOFF_HOME, 'records', '工作日志.md');
const SUPERVISOR = 'E:\\DeepFish\\avatar\\state\\supervisor.json';
// 9334/9335 是中继与身体服务自己的端口，不属于「DSH 宿主地址」——DSH 一律解析，绝不写死。
const RELAY = 'http://127.0.0.1:9334';
const BODY = 'http://127.0.0.1:9335';
function dshBase() { return resolveDshBase({ config: CONFIG }).url; }
const CLIENT = 'file:///E:/DeepFish/qq-bridge-0.2.1-r1/qq-bridge-0.2.1-r1/src/dsh-client.js';

/**
 * 新会话的 cwd：按「谁在交接」取值。
 * 顺序：--session-ws → XUNYU_SESSION_WS → handoff-config.json 的 sessionWorkspace[who]
 *       → sessionWorkspace.default → 交接家目录。
 * 本体换代必须落在本体工作区（E:\DeepFish\Xunyu），工作组工号落在工作组驻地（E:\DSH_workspace）——
 * 以前一律用 WS，本体换代就建错地方（23:47 那次错位会话的根因）。
 */
function resolveSessionWs(who, argv = []) {
  const flag = argOf(argv, '--session-ws');
  if (flag) return { dir: flag, source: '--session-ws' };
  const env = String(process.env.XUNYU_SESSION_WS ?? '').trim();
  if (env) return { dir: env, source: 'env XUNYU_SESSION_WS' };
  const map = CONFIG.sessionWorkspace ?? {};
  const key = String(who ?? '').replace(/（推断）$/, '');
  if (map[key]) return { dir: map[key], source: `handoff-config.json sessionWorkspace.${key}` };
  if (map.default) return { dir: map.default, source: 'handoff-config.json sessionWorkspace.default' };
  return { dir: HANDOFF_HOME, source: '交接家目录（兜底，建议在配置里写死）' };
}

// ───────────────────────────── 小工具 ─────────────────────────────

// 只在终端里上色；被重定向/管道接走时输出纯文本（方便 grep、写文件）
const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code) => (s) => (COLOR ? `\u001b[${code}m${s}\u001b[0m` : String(s));
const C = {
  dim: wrap(2), bold: wrap(1), red: wrap(31), green: wrap(32),
  yellow: wrap(33), cyan: wrap(36),
};

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return {
    date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    time: `${p(d.getHours())}:${p(d.getMinutes())}`,
    file: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`,
  };
}

function readText(p) {
  try { return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''); } catch { return null; }
}

function loadState() {
  const raw = readText(STATE_FILE);
  try { return raw ? JSON.parse(raw) : blankState(); } catch { return blankState(); }
}
function blankState() {
  return { updatedAt: null, lastHandoff: null, newSessionId: null, oldSessionId: null, pendingArchive: [] };
}
function saveState(s) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const d = new Date();
  s.updatedAt = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2) + '\n', 'utf8');
}

async function httpJson(url, ms = 4000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { signal: ac.signal });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    return await r.json();
  } catch (e) {
    return { error: e?.message ?? String(e) };
  } finally { clearTimeout(t); }
}

/** 让中继把「窗口目标」切到某个会话（不重启中继；换绑后它只推游标、不重投旧回复） */
async function relayRebind(sessionId) {
  try {
    const r = await fetch(`${RELAY}/rebind`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'dsh', sessionId }),
      signal: AbortSignal.timeout(8000),
    });
    const data = await r.json().catch(() => null);
    return { status: r.status, data };
  } catch (e) {
    return { status: 0, data: { ok: false, error: e?.message ?? String(e) } };
  }
}

/** 中继现在把窗口绑在哪个会话上 */
async function relayWindowTarget() {
  const h = await httpJson(`${RELAY}/health`);
  return h?.targets?.dsh?.sessionId ?? null;
}

// ───────────────────────────── 采集：服务现状 ─────────────────────────────

async function collectHealth() {
  const sup = JSON.parse(readText(SUPERVISOR) ?? '{}');
  const relay = await httpJson(`${RELAY}/health`);
  const body = await httpJson(`${BODY}/health`);
  const items = [
    { name: '桥接 bridge.js', port: 3100, state: sup.bridge, extra: sup.at ? `心跳 ${sup.at}` : '' },
    {
      name: '中继 relay.mjs', port: 9334, state: sup.relay,
      extra: relay.error ? `探活失败：${relay.error}` : `窗口 alive=${relay.window?.alive} 重启 ${sup.relayRestarts ?? '?'} 次`,
    },
    {
      name: '身体 body-service', port: 9335, state: sup.body,
      extra: body.error ? `探活失败：${body.error}` : `adapter=${body.adapter} ok=${body.adapterOk} 重启 ${sup.bodyRestarts ?? '?'} 次`,
    },
    { name: '游戏 mod', port: 9333, state: sup.mod, extra: '零鉴权（暂留）' },
    { name: '对话窗 chat-window', port: '—', state: sup.window, extra: `守护 pid ${sup.pid ?? '?'}，重启 ${sup.windowRestarts ?? '?'} 次` },
  ];
  const okAll = ['relay', 'body', 'mod', 'bridge', 'window'].every((k) => sup[k] === 'ok');
  return { sup, relay, body, items, okAll };
}

function healthTable(h) {
  const rows = h.items.map((i) => {
    const flag = i.state === 'ok' ? C.green('ok') : C.red(String(i.state ?? '未知'));
    return `| ${i.name} | ${i.port} | ${flag} | ${i.extra} |`;
  });
  return [
    '| 服务 | 端口 | 现状 | 备注 |',
    '|---|---|---|---|',
    ...rows,
  ].join('\n');
}

// ───────────────────────────── 采集：日志 / 交接稿 ─────────────────────────────

/**
 * 取 工作日志.md 里某一天的 `### HH:MM 标题` 列表。
 * 2026-10-26：顺带返回节头行号——§4.2 第 4 条要求证据只给指针（文件:行号），不再搬整段正文。
 */
function todayLogEntries(date) {
  const md = readText(LOG_FILE);
  if (!md) return { line: 0, entries: [] };
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `## ${date}`);
  if (start < 0) return { line: 0, entries: [] };
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) break;
    const m = lines[i].match(/^### (\d{1,2}:\d{2})\s+(.+)$/);
    if (m) out.push({ time: m[1], title: m[2].trim() });
  }
  return { line: start + 1, entries: out };
}

function listHandoffs() {
  return fs.readdirSync(WS)
    .filter((f) => HANDOFF_NAME_RE.test(f))
    .map((f) => ({ file: f, full: path.join(WS, f), mtime: fs.statSync(path.join(WS, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
}

function latestHandoff() {
  return listHandoffs()[0] ?? null;
}

// ── 交接稿命名（2026-10-27 01 硬规矩，写进代码不靠人记；2026-10-29 D86 放宽输入）────
// 事故：今晚那份是英文前缀 handoff-2026-10-26.md，磁盘上有，但 latestHandoff() 的正则
// /^交接-.*\.md$/ 根本不认它 —— status 从头到尾报 17:45 的旧稿，最后靠本体手工改名才对上。
//
// D86：任务书常写「交接-20261029-0935.md」（紧凑日期），工具原来只认「交接-2026-10-29-0935.md」，
// 于是每次都要改名返工。现在**两种输入都收**，统一规范化成带横线的那种（唯一规范格式）。
const HANDOFF_CANON_RE = /^交接-(\d{4})-(\d{2})-(\d{2})-(\d{4})\.md$/;
const HANDOFF_LOOSE_RE = /^交接-(\d{4})-?(\d{2})-?(\d{2})-(\d{4})\.md$/;
const HANDOFF_NAME_RE = HANDOFF_LOOSE_RE;   // 宽松：兼容紧凑与带横线两种写法
const HANDOFF_NAME_HINT = '交接-YYYY-MM-DD-HHMM.md（例：交接-2026-10-29-0935.md；紧凑写法 交接-20261029-0935.md 也认，会自动规范化）';

/** 把两种写法统一成规范名；认不出返回 null。 */
function canonHandoffName(base) {
  const m = HANDOFF_LOOSE_RE.exec(String(base ?? ''));
  if (!m) return null;
  return `交接-${m[1]}-${m[2]}-${m[3]}-${m[4]}.md`;
}

/** 校验交接稿文件名；不合规就响亮失败。合规但写法紧凑的，就地改名成规范名。 */
function assertHandoffName(p) {
  const base = path.basename(p);
  const canon = canonHandoffName(base);
  if (!canon) {
    throw new Error(
      `交接稿命名不合规：「${base}」\n`
      + `  必须是 ${HANDOFF_NAME_HINT}（中文「交接-」前缀、24 小时制时间）\n`
      + `  为什么强制：latestHandoff() 只认 /^交接-.*\.md$/，英文 handoff-*.md 在磁盘上也永远认不到。\n`
      + `  改名：ren "${p}" "交接-<YYYY-MM-DD>-<HHMM>.md"（同目录），再把 state\\handoff.json 的 lastHandoff 同步成新名；\n`
      + `  只是预览、不打算真交接：加 --rehearsal（演练不需要真交接稿）。`
    );
  }
  if (HANDOFF_CANON_RE.test(base)) return base;
  // 紧凑写法 → 就地规范化为唯一格式（内容不动），并把实际路径打出来
  const dir = path.dirname(p);
  const target = path.join(dir, canon);
  try {
    if (!fs.existsSync(target)) fs.renameSync(p, target);
    console.log(`✓ 文件名已规范化：${base} → ${canon}`);
    console.log(`  实际路径：${target}`);
    return canon;
  } catch (e) {
    throw new Error(`交接稿「${base}」需要规范化为「${canon}」，但改名失败：${e?.message ?? e}`);
  }
}

/** 根目录里命名不合规的交接稿：英文 handoff-*.md，以及「交接-」但格式不对的（交接-乱写.md） */
function misnamedHandoffs() {
  try {
    return fs.readdirSync(WS)
      .filter((f) => /^handoff-.*\.md$/i.test(f) || (/^交接-.*\.md$/.test(f) && !HANDOFF_CANON_RE.test(f)))
      .map((f) => path.join(WS, f));
  } catch { return []; }
}

/** 把一份交接稿按 `## ` 切成 { 标题: 正文 } */
function parseSections(md) {
  const sections = {};
  let key = null;
  for (const line of md.split(/\r?\n/)) {
    const m = line.match(/^##\s+(.+)$/);
    if (m) { key = m[1].trim(); sections[key] = []; continue; }
    if (key) sections[key].push(line);
  }
  for (const k of Object.keys(sections)) sections[k] = sections[k].join('\n').trim();
  return sections;
}

/**
 * 找交接稿里某一节（`## 标题`）的标题与行号。
 * 2026-10-26：只取指针、不搬正文——§4.2 第 4 条「证据只给指针」，整段待办原样搬会把稿越搬越长。
 * 返回 { key, line, body } 或 null。
 */
function sectionOf(md, re) {
  if (!md) return null;
  const lines = md.split(/\r?\n/);
  const idx = lines.findIndex((l) => l.startsWith('## ') && re.test(l.slice(3)));
  if (idx < 0) return null;
  const body = [];
  for (let i = idx + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) break;
    body.push(lines[i]);
  }
  return { key: lines[idx].slice(3).trim(), line: idx + 1, body: body.join('\n').trim() };
}

// ───────────────────────────── DSH 客户端 ─────────────────────────────

let unwrap; // 由 client() 注入（dsh-client 的 unwrap）

async function client() {
  const mod = await import(CLIENT);
  const { NodeApiClient } = mod;
  unwrap = mod.unwrap;
  const api = new NodeApiClient(dshBase(), undefined, {
    token: '', tokenExplicit: false, header: 'authorization', prefix: 'Bearer', allowRemote: false,
  });
  return { api, unwrap };
}

async function listSessions(api) {
  const r = unwrap(await api.sessions.list({}), 'session.list');
  const items = r?.items ?? [];
  return items.map((it) => ({
    sessionId: it.sessionId,
    title: it.projections?.values?.title ?? '(无标题)',
    cwd: it.cwd,
    running: Boolean(it.running),
    updatedAt: it.updatedAt,
  }));
}

function fmtTime(ms) {
  try {
    return new Date(ms).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  } catch { return String(ms); }
}

// ───────────────────────────── 命令：status ─────────────────────────────

async function cmdStatus() {
  warnPrefixCollisions();
  warnDuplicateTitles();
  const h = await collectHealth();
  const st = loadState();
  const last = latestHandoff();

  console.log(C.bold('\n== 交接状态 =='));
  console.log(`五项健康：${h.okAll ? C.green('全 ok') : C.red('有异常')}  ${C.dim(`(${h.sup.at ?? '无心跳'})`)}`);
  console.log(healthTable(h));
  console.log('');
  console.log(`最新交接稿：${last ? C.cyan(last.file) + C.dim(`  ${fmtTime(last.mtime)}`) : C.yellow('（还没有）')}`);
  const misnamed = misnamedHandoffs();
  if (misnamed.length) {
    console.log(C.red(`⚠ 根目录有 ${misnamed.length} 份交接稿命名不合规（latestHandoff/status 都认不到）：`));
    for (const f of misnamed) console.log(`   ${C.red(path.basename(f))} → 应改成 交接-YYYY-MM-DD-HHMM.md`);
    console.log(C.dim('   改完记得同步 state\\handoff.json 的 lastHandoff。'));
  }
  console.log(`上次新建会话：${st.newSessionId ?? '—'}   旧会话：${st.oldSessionId ?? '—'}`);

  const pend = st.pendingArchive ?? [];
  if (pend.length) {
    console.log(C.yellow(`\n⚠ 还有 ${pend.length} 个旧会话没归档：`));
    for (const p of pend) console.log(`   ${p.sessionId}  ${C.dim(p.title ?? '')}  ${C.dim(p.at ?? '')}`);
    console.log(C.dim(`   归档：node handoff.mjs archive --pending --yes`));
  } else {
    console.log(C.green('\n没有登记的待归档旧会话。'));
  }

  // 顺手把本工作区最近的会话列出来，方便挑「旧会话」去归档
  try {
    const { api } = await client();
    const list = (await listSessions(api))
      .filter((s) => s.cwd?.toLowerCase() === WS.toLowerCase() && s.sessionId !== st.newSessionId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 5);
    if (list.length) {
      console.log(C.dim('\n本工作区最近的会话（要归档哪个就把它登记进去）：'));
      for (const s of list) {
        const self = s.running ? C.yellow(' 跑着') : '';
        console.log(`   ${s.sessionId}  ${fmtTime(s.updatedAt)}  ${s.title}${self}`);
      }
    }
  } catch (e) {
    console.log(C.dim(`\n（会话列表取不到：${e?.message ?? e}）`));
  }
  console.log('');
}

// ───────────────────────────── 命令：prepare ─────────────────────────────

// ── 记录格式：交接簿.md §4.1 六字段（字段名逐字一致、顺序不许变） ──
const FIELDS = ['谁', '什么', '状态', '证据指针', '下一步', '卡点'];
const STATUSES = ['done', 'doing', 'blocked', '无变化'];
// 工号表：新增工号只改这一行（2026-10-30：补 05 文档与架构、07 巡检——之前漏加，--who 05 直接报错）
const WHOS = ['00', '01', '02', '03', '04', '05', '06', '07', '本体', '演练'];

/**
 * 名册里该工号的规范标题（读不到就 null）。
 * 为什么以名册为准：名册（`state\roster.json` 的 active[].title）是"工号叫什么"的唯一权威，
 * 换代标题跟它对不上，列表里就会出现两个名字不同、其实是同一个人接班的情况。
 */
function rosterTitleOf(who) {
  try {
    const rj = readJson(path.join(STATE_DIR, 'roster.json')) ?? {};
    const key = String(who ?? '').replace(/（推断）$/, '');
    const row = (rj.active ?? []).find((x) => String(x.id) === key);
    return row?.title ? String(row.title) : null;
  } catch { return null; }
}

/** 标题闸（纯函数，便于自检）：不一致返回 {ok:false, want}；缺任一侧视为无需校验。 */
function titleGate(renamed, want) {
  if (!renamed || !want) return { ok: true, skipped: true };
  return renamed === want ? { ok: true } : { ok: false, want };
}

/**
 * 换代时新会话的标题（UG-082，2026-11-05）。
 *
 * 以前是 `rehearsal ? '鲟鱼—演练' : '鲟鱼—本体'`——**只分演练/非演练，跟 --who 无关**，
 * 于是给 01 换代也把新会话叫「鲟鱼—本体」，名册里就多出一个"冒充本体"的会话
 * （和 10-26 那次错位会话同一种坑：标题骗人，比没标题更糟）。
 *
 * 现在的规则：名册有该工号就用名册标题 → 没有则「鲟鱼工作组工号XX」；本体固定「鲟鱼—本体」；
 * 演练一律加「（演练）」后缀，绝不和真会话同名。显式 `--title` 仍然最高优先级（在调用处判断）。
 */
function titleForWho(who, rehearsal = false) {
  const key = String(who ?? '').replace(/（推断）$/, '');
  if (key === '演练') return '鲟鱼—演练';
  const base = key === '本体' ? '鲟鱼—本体' : (rosterTitleOf(key) ?? `鲟鱼工作组工号${key}`);
  return rehearsal ? `${base}（演练）` : base;
}

/**
 * 「预期红」：服务红了但属正常。按 交接簿.md 三.5 的裁定——**只有非预期红才拦交接**，
 * 预期红照常交接、不标 blocked，但要在证据里写清「为什么预期」。
 * 现在只有一条：9333 游戏 mod（游戏没开；主人要求莉莉丝先别启动）。
 * 场景会变，这张表要跟着改——别把「预期」当永久豁免。
 */
const EXPECTED_RED = { 9333: '游戏没开，主人要求先别启动' };

/** 表格单元格：换行压空格、空值写「无」、`|` 转义（别让一行被拆成两行） */
function tcell(v) {
  const s = String(v ?? '').replace(/\s*\r?\n\s*/g, ' ').trim();
  return (s || '无').replace(/\|/g, '\\|');
}

/** 一行六字段；字段数或状态值不对就当场报错，别静静生成一份格式错的稿 */
function trow(cells) {
  if (cells.length !== FIELDS.length) throw new Error(`记录行有 ${cells.length} 个字段，§4.1 要求 ${FIELDS.length} 个`);
  if (!STATUSES.includes(cells[2])) throw new Error(`状态「${cells[2]}」不在 §4.1 四值里：${STATUSES.join(' / ')}`);
  return `| ${cells.map(tcell).join(' | ')} |`;
}

/**
 * 校验并规范化「谁」：§4.1 允许在工号后加「（推断）」表示归属不确定。
 * 例如 `--who "00（推断）"` → 生成 `00（推断）`。不认识的一律响亮失败，不静静生成一份格式错的稿。
 */
function normalizeWho(raw) {
  const s = String(raw ?? '').trim();
  const tag = s.match(/^(.+?)(?:（推断）|\(推断\))$/);
  const base = tag ? tag[1] : s;
  if (!WHOS.includes(base)) throw new Error(`--who 只认 ${WHOS.join(' / ')}，或「工号（推断）」写法，收到「${s}」`);
  return tag ? `${base}（推断）` : base;
}

async function cmdPrepare(argv) {
  const dry = argv.includes('--dry');
  const who = normalizeWho(argOf(argv, '--who') ?? '00');

  const h = await collectHealth();
  const now = stamp();
  const log = todayLogEntries(now.date);
  const last = latestHandoff();
  const prevTodo = last ? sectionOf(readText(last.full) ?? '', /待办|下一步|还没做|没做完|遗留/) : null;

  const bad = h.items.filter((i) => i.state !== 'ok');
  // 交接簿.md 三.5：预期红不拦交接、不标 blocked；只有非预期红才拦。
  // 以前不分预期/非预期，mod 一红 prepare 就出 blocked —— 每棒都卡，最后大家学会无视这条告警。
  const expected = bad.filter((i) => EXPECTED_RED[i.port]);
  const unexpected = bad.filter((i) => !EXPECTED_RED[i.port]);
  const rows = [];

  // 1) 自检本身（证据指到 supervisor.json，不贴服务表——六字段里装不下，也没地方放）
  // state 读不到 / 字段缺失时印「未知」，别让交接稿里出现 =undefined（那等于没写）
  const stateOf = (i) => String(i.state ?? '未知');
  const healthEv = `avatar\\state\\supervisor.json → 五项 ${h.items.length - bad.length}/${h.items.length} ok`
    + (bad.length
      ? `（${[
        ...expected.map((i) => `预期红：${i.name}=${stateOf(i)}（${EXPECTED_RED[i.port]}）`),
        ...unexpected.map((i) => `非预期红：${i.name}=${stateOf(i)}`),
      ].join('；')}）`
      : '');
  rows.push(unexpected.length
    ? [who, '跑交接自检', 'blocked', healthEv,
      `复核 ${unexpected.map((i) => i.name).join('/')} 是否真红`,
      `${unexpected.map((i) => i.name).join('/')} 非 ok（非预期）`]
    : [who, '跑交接自检', 'done', healthEv, '无', '无']);

  // 2) 今日日志（只给节头行号 + 条数，不搬正文）
  rows.push(log.entries.length
    ? [who, `汇总今日日志 ${log.entries.length} 条`, 'doing',
      `工作日志.md:${log.line} → ${log.entries.length} 条 ### HH:MM`,
      '按 §4.1 逐条拆成六字段行', '无']
    : [who, '补今日日志节', 'doing', `工作日志.md → 无 ## ${now.date} 节`, `在 工作日志.md 补 ## ${now.date} 节`, '无']);

  // 3) 上一棒的待办：给指针，不原样搬（§4.2 第 4 条）
  if (prevTodo) {
    rows.push([who, '承接上一棒待办', 'doing',
      `${last.file}:${prevTodo.line} → 「${prevTodo.key}」`,
      '按「本棒必做/挂账/已死」分栏搬过来', '无']);
  }

  // 4) 留一行给人补（§4.2 第 6 条：缺证据写「证据缺失」，不写结论）
  rows.push([who, '补本轮实际动作', 'doing', '证据缺失', '补一条「文件:行号」或「命令 → 返回」', '无']);

  const md = [
    `# 交接稿 · ${now.date} ${now.time}`,
    '',
    `| ${FIELDS.join(' | ')} |`,
    `|${FIELDS.map(() => '---').join('|')}|`,
    ...rows.map(trow),
    '',
    `> 归属说明一句：自动行按 \`--who ${who}\` 归属；人工补的行只改「谁」和内容，六字段不增、不删、不换序。`,
    '',
  ].join('\n');

  const out = path.join(WS, `交接-${now.file}.md`);
  // 命名自检：生成端自己先过一遍命名规则（改坏了立刻炸，别写进磁盘再靠人发现）
  assertHandoffName(out);

  // --dry：只把全文打到 stdout，不写文件、不动 state（给验收 / 对齐 §4.3 用）
  if (dry) {
    process.stdout.write(md);
    return null;
  }

  if (fs.existsSync(out)) throw new Error(`已存在同名交接稿：${out}`);
  fs.writeFileSync(out, md, 'utf8');

  const st = loadState();
  st.lastHandoff = out;
  st.lastWho = who; // 记下「谁在交接」，new 没传 --who 时沿用，免得靠人记（本体会话建错工作区的根因）
  saveState(st);

  console.log(C.green(`\n已生成交接稿：${out}`));
  console.log(C.dim('骨架按 交接簿.md §4.1 六字段出；自动行之外的人补行标着「证据缺失」。'));
  console.log(C.dim('补完就跑：node handoff.mjs new'));
  if (unexpected.length) console.log(C.red(`⚠ 有 ${unexpected.length} 项非预期红：${unexpected.map((i) => i.name).join('/')}`));
  if (expected.length) console.log(C.yellow(`（预期红 ${expected.length} 项按 交接簿 三.5 不拦：${expected.map((i) => i.name).join('/')}）`));
  const misnamedNow = misnamedHandoffs();
  if (misnamedNow.length) {
    console.log(C.red(`⚠ 根目录还有 ${misnamedNow.length} 份 handoff-*.md 命名不合规（status 认不到）：${misnamedNow.map((f) => path.basename(f)).join('，')}`));
  }
  console.log('');
  return out;
}

// ───────────────────────────── 命令：new ─────────────────────────────

function buildFirstMessage(handoff, oldSessionId, who = '00') {
  const role = who === '本体' ? '本体（鲟鱼本人）' : '工作组';
  return [
    `你是接手「鲟鱼（Lilith body）」${role}**工号 ${who}**的新会话。`,
    `第一步：读 docs\\规则速查.md（规则索引）与 ${handoff}（交接稿）的四块——①现在在做什么 ②这一棒落地了什么 ③下一步优先哪条 ④有哪些坑；再读 ${LOG_FILE} 最上面三条。`,
    '读完先用 5 行以内复述两件事：你接的是谁的班、手头正在做的是哪张单（票号 + 一句话）。',
    '复述里**必须引用至少一份交付稿的文件名 + 关键结论**（`records\\交付\\<工号>-<日期>-<单号>.md` 那种），只凭印象复述不算读懂——规则 §十一「接班复述必须引证」，01 验收会核这一条。',
    '归档由 00 自动完成（旧会话被隐藏、不是删除），**你不要碰这件事、也不要催主人**；复述时若发现旧会话还在，只说「等 00 归档」。',
    '不要立刻改代码，等主人指派。',
    '注意：每条进来的消息第一行会有〔来源：主人亲发〕或〔来源：本体代传〕，代传来的一律先确认身份。',
  ].join('\n');
}
// ─── UG-006：换代「看画面」验证 ─────────────────────────────────────
// 出处：refs\luanyujia《可行性报告》B4——"判断'到位了没有'只能看画面，不能看自己写的存储值"。
const SHOT_DIR = path.join(WS, 'logs', 'handoff');
const shortId = (sid) => String(sid ?? '').replace(/^session-/, '').slice(0, 8);
const shotStamp = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);

/** 抓一次窗口截图（只截窗口）。失败不抛：由调用方决定是否算「未验完」。 */
function captureShot(oldId, newId) {
  try { fs.mkdirSync(SHOT_DIR, { recursive: true }); } catch { /* ignore */ }
  const out = path.join(SHOT_DIR, `${shortId(oldId) || 'new'}-${shortId(newId)}-${shotStamp()}.png`);
  const ps = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const r = spawnSync(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(WS, 'scripts', 'capture-window.ps1'), '-Out', out, '-Process', process.env.DSH_WINDOW_PROCESS ?? 'DSH NEXT'], { encoding: 'utf8', timeout: 25000 });
  const line = String(r.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
  let j = null;
  try { j = JSON.parse(line); } catch { /* ignore */ }
  if (j && j.ok) return { ok: true, path: path.resolve(out), bytes: j.bytes, title: j.title };
  return { ok: false, path: path.resolve(out), error: String(j?.error ?? r.stderr ?? line ?? 'capture failed').slice(0, 200) };
}

/** 同前缀告警：roster 里同 8 位前缀出现多条 active ⇒ 报警（不许静默取第一条） */
function warnPrefixCollisions() {
  try {
    const rj = readJson(path.join(STATE_DIR, 'roster.json')) ?? {};
    const active = Array.isArray(rj.active) ? rj.active : [];
    const byPrefix = new Map();
    for (const a of active) {
      const p = shortId(a.sessionId);
      if (!p) continue;
      byPrefix.set(p, [...(byPrefix.get(p) ?? []), a]);
    }
    const dup = [...byPrefix.entries()].filter(([, list]) => list.length > 1);
    if (dup.length) {
      console.log(C.red(`\n⚠ 同前缀告警：roster 里有 ${dup.length} 组会话 id 前缀相同（不许静默取第一条）`));
      for (const [p, list] of dup) console.log(C.red(`   ${p}…：${list.map((x) => `${x.id}(${x.sessionId})`).join(' / ')}`));
      console.log(C.dim('   处理：一律用完整 sessionId；旧会话应在 history 并标 archived。'));
    }
    return dup.length;
  } catch { return 0; }
}

/** 同名多条告警：名册里标题完全相同、id 不同、且**都还没归档** ⇒ 真危险（认错人）；一条已归档 = 新旧交替，不报 */
function warnDuplicateTitles() {
  try {
    const rj = readJson(path.join(STATE_DIR, 'roster.json')) ?? {};
    const active = Array.isArray(rj.active) ? rj.active : [];
    const wsj = readJson(path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh', 'storages', 'workspace.json')) ?? {};
    const archived = new Set(wsj?.global?.archivedSessionIds ?? []);
    const byTitle = new Map();
    for (const a of active) {
      const t = String(a.title ?? '').trim();
      if (!t) continue;
      byTitle.set(t, [...(byTitle.get(t) ?? []), a]);
    }
    let dupCount = 0;
    for (const [title, list] of byTitle) {
      const ids = [...new Set(list.map((x) => x.sessionId).filter(Boolean))];
      if (ids.length < 2) continue;
      const live = ids.filter((id) => !archived.has(id));
      const retired = ids.length - live.length;
      if (live.length > 1) {
        dupCount++;
        console.log(C.red(`\n⚠ 同名多条告警：「${title}」有 ${live.length} 条**都还活着**（标题相同、id 不同，容易认错人）`));
        for (const id of ids) console.log(C.red(`   ${archived.has(id) ? '已归档' : '活跃  '} ${id}`));
        console.log(C.dim('   处理：先确认哪条在役；归档前停手问本体（交接流程第 4.6 步）。'));
      } else if (retired > 0) {
        console.log(C.dim(`· 同名新旧交替：「${title}」活跃 ${live.length} 条 / 已归档 ${retired} 条（正常，不报警）`));
      }
    }
    return dupCount;
  } catch { return 0; }
}

async function cmdNew(argv) {
  warnPrefixCollisions();
  warnDuplicateTitles();
  const rehearsal = argv.includes('--rehearsal');
  const state0 = loadState();
  // D86：--handoff 允许写「交接-20261029-0935.md」（紧凑）——统一规范化成带横线的唯一格式
  let explicitHandoff = argOf(argv, '--handoff');
  if (explicitHandoff) {
    const rawBase = path.basename(explicitHandoff);
    const canon = canonHandoffName(rawBase);
    if (!canon) {
      throw new Error(`--handoff 文件名不合规：「${rawBase}」\n  必须是 ${HANDOFF_NAME_HINT}`);
    }
    const canonPath = path.join(path.dirname(path.resolve(explicitHandoff)), canon);
    if (fs.existsSync(canonPath)) {
      if (rawBase !== canon) console.log(`· 规范名 ${canon} 已存在，按规范名走（紧凑写法不保留）`);
    } else if (fs.existsSync(explicitHandoff)) {
      fs.renameSync(explicitHandoff, canonPath);
      console.log(`✓ 文件名已规范化：${rawBase} → ${canon}`);
      console.log(`  实际路径：${canonPath}`);
      explicitHandoff = canonPath;
    } else {
      throw new Error(`指定的交接稿不存在：${explicitHandoff}（规范名 ${canonPath} 也不存在）`);
    }
  }
  let handoff = explicitHandoff ?? null;
  // state 里记的那份可能已被改名/归档（今晚就是这么对不上的）：不存在就退到最新稿，别硬停
  if (!handoff && state0.lastHandoff) {
    if (fs.existsSync(state0.lastHandoff)) handoff = state0.lastHandoff;
    else console.log(C.yellow(`⚠ state 里记的交接稿不存在：${state0.lastHandoff}（退到根目录最新一份）`));
  }
  handoff = handoff ?? latestHandoff()?.full ?? null;
  if (!rehearsal && (!handoff || !fs.existsSync(handoff))) throw new Error('找不到交接稿：先跑 node handoff.mjs prepare');
  // 命名强制：手工 --handoff 传进来的、state 里存着的旧名字，都要过这一关（演练不需要真稿）
  if (!rehearsal) assertHandoffName(handoff);
  const oldSessionId = argOf(argv, '--old') ?? state0.oldSessionId ?? null;
  const dry = argv.includes('--dry');
  const whoArg = argOf(argv, '--who');
  const whoState = state0.lastWho;
  const who = normalizeWho(whoArg ?? whoState ?? '00');
  const whoFrom = whoArg ? '--who' : (whoState ? 'state\\handoff.json lastWho（prepare 记的）' : '默认 00');
  const sessionWs = resolveSessionWs(who, argv);
  const firstMsg = rehearsal
    ? ['【交接演练】这是 handoff.mjs 的自检回合，不是真交接。', '只回一行「演练收到」，不要读文件、不要改代码、不要调任何工具。'].join('\n')
    : buildFirstMessage(handoff, oldSessionId, who);

  console.log(C.bold(rehearsal ? '\n== 演练：新建会话（用一句话代替交接稿） ==' : '\n== 新建接手会话 =='));
  if (!rehearsal) console.log(`交接稿：${C.cyan(handoff)}`);
  console.log(`谁在交接：${who} ${C.dim(`← ${whoFrom}`)}`);
  console.log(`新会话工作区：${C.cyan(sessionWs.dir)} ${C.dim(`← ${sessionWs.source}`)}`);
  console.log(`旧会话：${oldSessionId ?? C.yellow('未指定（稍后用 status 查）')}`);
  // UG-082：标题按 --who 推导（显式 --title 仍然赢），dry 也要看得见
  const newTitle = argOf(argv, '--title') ?? titleForWho(who, rehearsal);
  console.log(`新会话标题：${C.cyan(newTitle)}${argOf(argv, '--title') ? C.dim('（--title 显式指定）') : ''}`);
  if (dry) {
    console.log(C.yellow('\n[dry] 首条消息预览：\n') + firstMsg + '\n');
    return;
  }

  const { api, unwrap } = await client();
  const ws = unwrap(await api.workspace.create({ path: sessionWs.dir }), 'workspace.create');
  const workspaceId = ws.workspace?.workspaceId ?? ws.workspaceId;
  const created = unwrap(await api.sessions.create({ workspaceId }), 'session.create');
  const sessionId = created.sessionId ?? created.session?.sessionId;
  console.log(C.green(`新会话：${sessionId}`));

  // 2026-10-26（主人定的交接流程 3.5 步）：新会话立刻改名，别让列表全是「无标题」。
  // RPC 是 session/rename（host 描述：Rename one Session after explicitly resuming it）。
  // 注意 sessions.list 的**顶层 title 恒为 null**，真名在 projections.values.title——
  // 验证必须读那一层，否则会以为没改成（实测踩过）。
  // 演练不许叫「鲟鱼—本体」：那会把一个自检回合伪装成本体，跟错位会话同一种坑。
  // （UG-082 起标题在 dry 之前就按 --who 算好了，这里直接用 newTitle）
  let renamed = '';
  try {
    const rr = await api.callUnary('session/rename', { sessionId, title: newTitle });
    renamed = String(rr?.result?.value?.title ?? newTitle);
    console.log(C.green(`已改名：${renamed}`));
  } catch (error) {
    console.log(C.yellow(`⚠ 改名失败（不影响交接）：${error?.message ?? error}`));
    console.log(C.dim(`  可手动补：node handoff.mjs rename ${sessionId} "${newTitle}"`));
  }

  // UG-082 判据③：换代后**核一次**标题与名册是否一致。不一致不许静默——
  // 静默的后果是「列表里两个名字不同、其实是同一个人」，下一次换代就会认错会话。
  if (!rehearsal && renamed) {
    const want = rosterTitleOf(who);
    const gate = titleGate(renamed, want);
    if (gate.skipped) {
      console.log(C.dim(`名册里没有 ${who} 的标题可核（新标题 ${renamed}）`));
    } else if (!gate.ok) {
      console.log(C.red(`✗ 标题与名册不一致：新会话「${renamed}」≠ 名册「${gate.want}」`));
      console.log(C.yellow(`  修：node handoff.mjs rename ${sessionId} "${gate.want}"，然后核对 state\\roster.json`));
      process.exitCode = 3;
    } else {
      console.log(C.dim(`标题已与名册对齐：${want}`));
    }
  }

  // 换绑要在投递**之前**：桥接只给「此刻已绑定的会话」收集回复，
  // 晚一步绑会漏掉新会话的第一句（22:54 演练实测漏了一条）。
  // **演练绝不换绑**：演练是自检，不是交接，换绑会把窗口从真会话上摘走（23:52 01 派单第 1 件）。
  if (rehearsal) {
    console.log(C.yellow('演练：跳过换绑（窗口目标保持不动）'));
  } else {
    const rb = await relayRebind(sessionId);
    if (rb.data?.ok) {
      console.log(C.green('窗口目标已切到新会话（targets.json 已写，重启也不会丢）'));
    } else {
      console.log(C.yellow(`⚠ 窗口目标没切成功：${rb.data?.error ?? `HTTP ${rb.status}`}`));
      console.log(C.dim('  新会话已经建好，稍后可手动重试：node handoff.mjs rebind ' + sessionId));
    }
  }

  const accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: firstMsg }] });
  const okPrompt = Boolean(accepted?.result?.ok ?? accepted);
  console.log(okPrompt ? C.green('首条消息已投递（新会话会自己复述，回复会进对话窗）') : C.red('首条消息投递可能失败，去界面看一眼'));

  // UG-006：换代必须「看画面」——截该会话所在窗口，回执里贴路径；没图算未验完
  const shot = captureShot(oldSessionId, sessionId);
  if (shot.ok) {
    console.log(C.green(`截图已存：${shot.path}（${Math.round(shot.bytes / 1024)} KB）`));
  } else {
    console.log(C.yellow(`⚠ 截图失败：${shot.error}`));
    console.log(C.yellow('  ⇒ 这次换代算「未验完」：回执里必须贴图路径，没图打回（docs\\交接流程.md）'));
  }

  const st = loadState();
  if (!rehearsal) {
    st.lastHandoff = handoff;
    st.newSessionId = sessionId;
    if (oldSessionId) {
      st.oldSessionId = oldSessionId;
      if (!(st.pendingArchive ?? []).some((p) => p.sessionId === oldSessionId)) {
        st.pendingArchive = [...(st.pendingArchive ?? []), { sessionId: oldSessionId, title: '', at: new Date().toISOString() }];
      }
    }
    saveState(st);
  }

  printArchiveReminder(st);
  console.log(C.dim('新会话起来后：确认它复述无误，然后按上面第一条命令归档旧会话。'));
  console.log('');
  return sessionId;
}

function printArchiveReminder(st) {
  const pend = st.pendingArchive ?? [];
  console.log(C.yellow('\n┌──────────────────────────────────────────────┐'));
  console.log(C.yellow('│  ⚠ 交接最后一步：归档旧会话（隐藏，不删除）  │'));
  console.log(C.yellow('└──────────────────────────────────────────────┘'));
  if (!pend.length) {
    console.log('  还没有登记旧会话。先跑 ' + C.cyan('node handoff.mjs status') + ' 看列表，再：');
    console.log('  ' + C.cyan('node handoff.mjs archive <sessionId> --yes'));
    return;
  }
  for (const p of pend) console.log(`  · ${p.sessionId}  ${C.dim(p.title ?? '')}`);
  console.log('  ' + C.cyan('node handoff.mjs archive --pending --yes') + C.dim('  ← 一条命令全归档'));
  console.log(C.dim('  归档只是从工作区列表隐藏；恢复：node handoff.mjs unarchive <sessionId> --yes'));
}

// ───────────────────────────── 命令：archive / unarchive ─────────────────────────────

async function resolveTargets(argv) {
  const st = loadState();
  if (argv.includes('--pending')) {
    const p = st.pendingArchive ?? [];
    // UG-075 判据③：pending 为空（或已全部清理）**不是错误**——幂等跑第二遍不该报红。
    if (!p.length) return [];
    return p.map((x) => x.sessionId);
  }
  const id = argv.find((a) => /^session-/.test(a));
  if (!id) throw new Error('用法：node handoff.mjs archive <sessionId> [--yes]  |  archive --pending [--yes]');
  return [id];
}

/**
 * 跑一遍残留绑定扫描（`scripts\scan-stale-bindings.mjs <id>`）。
 * 退出码：0 = 安全；1 = 还有活绑定；2 = 脚本自身出错。
 * **非 0 一律当不安全**——宁可拦错一次，不可放过一次（今晚的 4 次事故都是放过导致的）。
 */
function scanStaleBindings(sessionId) {
  const script = path.join(WS, 'scripts', 'scan-stale-bindings.mjs');
  if (!fs.existsSync(script)) {
    return { ok: false, code: 2, out: `找不到扫描器：${script}（闸门不能跳过：把脚本放回去再归档）` };
  }
  const r = spawnSync(process.execPath, [script, sessionId], { cwd: WS, encoding: 'utf8', timeout: 30000 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  return { ok: r.status === 0, code: r.status ?? -1, out };
}

/**
 * UG-023：归档前查孤儿票——`doing` 票的持有者如果没有活跃会话，先回收再归档。
 * 只读检测（交给 `orphan-check.mjs --check`）：0 = 无孤儿；1 = 有孤儿；2 = 脚本自身出错。
 * **任何非 0 都拒绝归档**——同残留绑定扫描的道理：宁可拦错一次，不可放过一次。
 */
function orphanGate() {
  const script = path.join(WS, 'scripts', 'orphan-check.mjs');
  if (!fs.existsSync(script)) {
    return { ok: false, code: 2, out: `找不到孤儿检查器：${script}（闸门不能跳过：把脚本放回去再归档）` };
  }
  const r = spawnSync(process.execPath, [script, '--check'], { cwd: WS, encoding: 'utf8', timeout: 30000 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  return { ok: r.status === 0, code: r.status ?? -1, out };
}

async function cmdArchive(argv) {
  const targets = await resolveTargets(argv);
  const yes = argv.includes('--yes');
  // UG-075 判据③：pending 为空时友好退出（幂等第二跑不该报红、也不该去扫/连会话）
  if (!targets.length) {
    console.log(C.dim('· 没有待归档会话（state\\handoff.json 的 pendingArchive 为空或已全部清理）'));
    console.log('');
    return;
  }

  // ── 归档前硬闸门（2026-10-27 01 硬规矩 / 主人点名）─────────────────────
  // 为什么写进代码：今晚 10 处旧会话残留、4 处炸成事故（定时拦归档 / 中继指空 /
  // 重启回弹 / QQ 出站全断），全是「人忘了查」。扫描器退出码非 0 就不许归档，
  // 并且把扫描器打印的修法**原样**带出来——不二次转述，免得丢掉行号与具体字段。
  if (yes) {
    for (const id of targets) {
      const gate = scanStaleBindings(id);
      if (!gate.ok) {
        console.log(C.red(`\n✗ 拒绝归档 ${id}：还有活绑定指向它（扫描器 exit=${gate.code}）`));
        if (gate.out) console.log(gate.out);
        console.log(C.yellow('\n先按上面的修法清干净，再重跑这条命令。没归档，什么都没改。'));
        process.exitCode = 1;
        return;
      }
      console.log(C.green(`✓ 残留绑定扫描通过 ${id}（活绑定 0 处）`));
    }

    // ── 孤儿票闸门（UG-023：有 `doing` 票挂在死会话上就不许归档）─────────────────
    // 为什么挡在这里：归档是"这个会话彻底退场"，可它手上要还有 doing 票，
    // 那张票就变成没人会来交的孤儿（W-238 躺了三天）。先回收（doing → queued）再归档。
    const orph = orphanGate();
    if (!orph.ok) {
      console.log(C.red(`\n✗ 拒绝归档：还有孤儿票没处理（orphan-check --check exit=${orph.code}）`));
      if (orph.out) console.log(orph.out);
      console.log(C.yellow('\n先跑 node scripts\\orphan-check.mjs 回收（doing → queued + 记 orphan-recovered），再重跑这条命令。没归档，什么都没改。'));
      process.exitCode = 1;
      return;
    }
    console.log(C.green('✓ 孤儿票检查通过（doing 票的持有者都在活跃名册上）'));
  }

  const { api, unwrap } = await client();
  const sessions = await listSessions(api);
  const byId = new Map(sessions.map((s) => [s.sessionId, s]));

  // 保护：别归档窗口当前连着的会话——归档后中继会立刻「会话失效」，窗口就哑了。
  const currentWindow = await relayWindowTarget();
  for (const id of targets) {
    if (currentWindow && id === currentWindow) {
      throw new Error(`不能归档 ${id}：它正是窗口当前连着的会话。先 node handoff.mjs new（会顺带换绑），或 handoff.mjs rebind <会话id>`);
    }
  }

  // UG-074：入口标签（op）与「谁归的」（by）——审计靠这两个字段追责
  const isPending = argv.includes('--pending');
  const opLabel = isPending ? 'pending-archive' : (argv.includes('--force') ? 'force' : 'archive');
  const byLabel = String(argOf(argv, '--by') ?? process.env.XUNYU_ARCHIVE_BY
    ?? (isPending ? 'pending' : 'manual:cli'));

  for (const id of targets) {
    const s = byId.get(id);
    const title = String(s?.title ?? '');
    const label = s ? `${s.sessionId}  ${s.title}` : `${id}  ${C.yellow('（不在会话列表里，可能已归档）')}`;
    if (!yes) {
      console.log(C.yellow(`[演练] 会归档：${label}`));
      continue;
    }
    // UG-074 判据②：已经在归档集合里 → **不再调 API**，记 skipped-already-archived（幂等，不重复归）
    // UG-075：跳过时**还要把它从 pendingArchive 摘掉**，否则 pending 会越攒越脏（2ece2a18 就是这么冒出来的）
    const preIds = readArchivedIds();
    if (Array.isArray(preIds) && preIds.includes(String(id))) {
      console.log(C.yellow(`· 已在归档集合里，跳过：${id}`) + C.dim(`（集合 ${preIds.length} 个，未变）`));
      appendArchiveLog({
        t: Date.now(), op: 'skipped-already-archived', by: byLabel, sessionId: String(id),
        title, before: preIds.length, after: preIds.length, ok: true
      });
      const st = loadState();
      const had = (st.pendingArchive ?? []).length;
      st.pendingArchive = (st.pendingArchive ?? []).filter((p) => p.sessionId !== id);
      const left = (st.pendingArchive ?? []).length;
      if (left !== had) {
        saveState(st);
        console.log(C.dim(`  已从 pendingArchive 摘掉（${had} → ${left}）`));
      }
      continue;
    }
    try {
      const r = unwrap(await api.workspace.archiveSession({ sessionId: id }), 'workspace.archiveSession');
      const archived = r?.archivedSessionIds ?? [];
      const after = archived.length;
      const before = Math.max(0, after - 1); // archive 只加 1，用 API 返回的集合长度反推
      console.log(C.green(`已归档：${label}`) + C.dim(`（归档集合共 ${archived.length} 个）`));
      console.log(C.dim(`  最后写盘时间：${s ? fmtTime(s.updatedAt) : '未知'}（会话文件时间，不是归档时刻）`));
      console.log(C.cyan(`  归档时刻：${fmtTime(new Date())}`));
      appendArchiveLog({
        t: Date.now(), op: opLabel, by: byLabel, sessionId: String(id),
        title, before, after, ok: true
      });
      const st = loadState();
      st.pendingArchive = (st.pendingArchive ?? []).filter((p) => p.sessionId !== id);
      saveState(st);
    } catch (e) {
      console.log(C.red(`归档失败：${id} → ${e?.message ?? e}`));
      const ids = readArchivedIds();
      appendArchiveLog({
        t: Date.now(), op: opLabel, by: byLabel, sessionId: String(id), title,
        before: ids ? ids.length : -1, // -1 = 读不到归档集合（未知），不要瞎写 0
        after: ids ? ids.length : -1,
        ok: false, error: String(e?.message ?? e).slice(0, 300)
      });
    }
  }
  if (!yes) console.log(C.dim('\n演练模式：确认无误后加 --yes 真归档。'));
  console.log('');
}

async function cmdRebind(argv) {
  const id = argv.find((a) => /^session-/.test(a));
  if (!id) throw new Error('用法：node handoff.mjs rebind <sessionId>');
  const r = await relayRebind(id);
  if (!r.data?.ok) throw new Error(`换绑失败：${r.data?.error ?? `HTTP ${r.status}`}`);
  console.log(C.green(`窗口目标已切到 ${id}`) + C.dim('（中继只推游标、不重投旧回复；targets.json 已写，重启也不丢）'));
  console.log('');
}

async function cmdUnarchive(argv) {
  const id = argv.find((a) => /^session-/.test(a));
  if (!id) throw new Error('用法：node handoff.mjs unarchive <sessionId> [--yes]');
  const yes = argv.includes('--yes');
  if (!yes) { console.log(C.yellow(`[演练] 会恢复：${id}`)); return; }
  const { api } = await client();
  try {
    // 这个端点不在客户端的包装表里，参数要自己套一层 request
    const r = await api.callUnary('workspace/unarchiveSession', { request: { sessionId: id } });
    if (r?.result?.ok === false) throw new Error(JSON.stringify(r.result.error));
    console.log(C.green(`已恢复：${id}`) + C.dim(`（仍在归档集合里=${(r?.result?.value?.archivedSessionIds ?? []).includes(id)}）`));
  } catch (e) {
    console.log(C.red(`恢复失败：${e?.message ?? e}`) + C.dim('（也可在 DSH 界面「已归档」里点恢复）'));
  }
  console.log('');
}

// ───────────────────────────── 入口 ─────────────────────────────

/**
 * 给一个会话改名（2026-10-26 主人定：交接时两个会话都要有名字）。
 * 用法：node handoff.mjs rename <sessionId|当前> "标题"
 * 底层：RPC session/rename（`{ sessionId, title }`）；`callUnary` 会自动套 {args:{request:…}}。
 * 验证读 projections.values.title —— 顶层 title 恒为 null。
 */
async function cmdRename(argv) {
  const sidArg = argv[1] && !argv[1].startsWith('--') ? argv[1] : (loadState().newSessionId ?? null);
  const title = argv[2] ?? argOf(argv, '--title');
  if (!sidArg) throw new Error('用法：node handoff.mjs rename <sessionId> "标题"（或先跑 new 记录新会话 id）');
  if (!title) throw new Error('缺标题：node handoff.mjs rename <sessionId> "标题"');
  const { api, unwrap } = await client();
  const titleOfSession = (it) => String(it?.title ?? it?.projections?.values?.title ?? '').trim();
  const before = unwrap(await api.sessions.list({}), 'session.list');
  const item = (before.items ?? []).find((x) => x.sessionId === sidArg);
  const oldTitle = titleOfSession(item) || '(无标题)';
  const res = await api.callUnary('session/rename', { sessionId: sidArg, title });
  const newTitle = String(res?.result?.value?.title ?? title);
  console.log(`${C.dim(oldTitle)} → ${C.green(newTitle)}  (${sidArg})`);
  return newTitle;
}

/**
 * UG-082 自检：标题推导 + 「标题与名册不一致」这条闸**真的会红**。
 *
 * 为什么要有它：判据③那种校验最容易写成"永远打绿"的假证。这里同时跑正例与反例——
 * 反例是故意喂一个错的标题名，断言闸必须报不一致；只要有一项不符就 exit 1。
 */
function cmdSelftestTitles() {
  const rows = [];
  const check = (name, got, want) => rows.push({ name, got, want, ok: got === want });

  check('工号 01 → 名册标题', titleForWho('01'), rosterTitleOf('01') ?? '鲟鱼工作组工号01');
  check('工号 03 → 名册标题', titleForWho('03'), rosterTitleOf('03') ?? '鲟鱼工作组工号03');
  check('本体 → 鲟鱼—本体', titleForWho('本体'), '鲟鱼—本体');
  check('演练 → 鲟鱼—演练', titleForWho('演练'), '鲟鱼—演练');
  check('工号 01 演练 → 加（演练）', titleForWho('01', true), `${rosterTitleOf('01') ?? '鲟鱼工作组工号01'}（演练）`);
  check('未知工号兜底（99）', titleForWho('99'), '鲟鱼工作组工号99');
  check('不再写死「鲟鱼—本体」', titleForWho('01') === '鲟鱼—本体' ? '鲟鱼—本体' : 'ok', 'ok');

  // 反例：标题闸必须把"人肉改错的名字"判成不一致
  const want = rosterTitleOf('01');
  const mismatched = `${want}·写错了`;
  const flagged = !titleGate(mismatched, want).ok;
  rows.push({ name: '反例：错标题必须被判不一致', got: flagged ? 'flagged' : 'silently-passed', want: 'flagged', ok: flagged });
  check('正例：同名标题判一致', titleGate(want, want).ok ? 'ok' : 'no', 'ok');
  check('缺名册标题时跳过校验', titleGate('任意标题', null).skipped ? 'skipped' : 'no', 'skipped');

  for (const r of rows) {
    console.log(`${r.ok ? C.green('✓') : C.red('✗')} ${r.name}  got=${r.got}${r.ok ? '' : `  want=${r.want}`}`);
  }
  const bad = rows.filter((r) => !r.ok).length;
  console.log(bad ? C.red(`\n${bad}/${rows.length} 项不符`) : C.green(`\n${rows.length}/${rows.length} 项通过`));
  process.exitCode = bad ? 1 : 0;
}

function argOf(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? 'status';
  switch (cmd) {
    case 'status': await cmdStatus(); break;
    case 'prepare': await cmdPrepare(argv); break;
    case 'new': await cmdNew(argv); break;
    case 'archive': await cmdArchive(argv); break;
    case 'rebind': await cmdRebind(argv); break;
    case 'unarchive': await cmdUnarchive(argv); break;
    case 'rename': await cmdRename(argv); break;
    case 'selftest-titles': cmdSelftestTitles(); break;
    case 'remind': printArchiveReminder(loadState()); console.log(''); break;
    case '-h': case '--help': case 'help':
      console.log(`
交接自动化（鲟鱼项目）

  node handoff.mjs status                    五项健康 + 最新交接稿 + 待归档旧会话
  node handoff.mjs prepare                   自检并生成 交接-YYYY-MM-DD-HHMM.md（§4.1 六字段骨架）
        --dry             只把全文打到 stdout，不写文件、不动 state
        --who <工号>      骨架里的「谁」（00/01/02/03/04/06/本体/演练，默认 00）
  node handoff.mjs new                       建新会话、投递交接稿、写归档提醒
        --handoff <路径>  指定交接稿（默认用 state 里记的最新一份）
        --old <sessionId> 登记要归档的旧会话
        --who <工号>      谁在交接（决定新会话工作区；默认 00 = 工作组驻地，本体换代传 本体）
        --session-ws <目录> 直接指定新会话 cwd（优先级最高）
        --rehearsal       演练：建会话但**不换绑**、不写 state、不改名成「本体」
        --dry             只预览首条消息，不真的建会话
  node handoff.mjs archive <id> [--yes]      归档旧会话（默认演练）
  node handoff.mjs archive --pending [--yes] 归档所有登记的待归档会话
  node handoff.mjs rebind <id>               把窗口目标切到别的会话（不重启中继）
  node handoff.mjs unarchive <id> [--yes]    恢复归档
  node handoff.mjs remind                    再打一遍归档提醒
`);
      break;
    default:
      console.error(`未知命令：${cmd}（试试 --help）`);
      process.exitCode = 1;
  }
}

// 不用 process.exit：fetch 的 keep-alive 连接还没关，硬退会在 Windows 上触发 libuv 断言
main().catch((e) => {
  console.error(C.red('失败：' + (e?.message ?? e)));
  process.exitCode = 1;
});
