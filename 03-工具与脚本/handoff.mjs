#!/usr/bin/env node
// 鲟鱼项目 · 交接自动化
//
// 一条命令干完「交接」这条链：
//   自检 → 生成交接稿骨架 → 新建接手会话并投递首条消息 → 提醒你归档旧会话
//
// 用法（在 <工作区> 下）：
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
// 本体换代时把会话建到了 <工作区>（错位会话 session-5f0277fd，23:47 归档）。
// 现在拆两层：HANDOFF_HOME = 记录放哪；resolveSessionWs(who) = 新会话建在哪（按「谁在交接」取值）。
const HANDOFF_HOME = process.env.XUNYU_WS ?? '<工作区>';
const WS = HANDOFF_HOME; // 旧引用别名：交接稿、state、日志都在这
const STATE_DIR = path.join(HANDOFF_HOME, 'state');
const STATE_FILE = path.join(STATE_DIR, 'handoff.json');
const CONFIG_FILE = path.join(STATE_DIR, 'handoff-config.json');
const CONFIG = readJson(CONFIG_FILE) ?? {};
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
 * 本体换代必须落在本体工作区（<Xunyu根>），工作组工号落在工作组驻地（<工作区>）——
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

// ── 交接稿命名（2026-10-27 01 硬规矩，写进代码不靠人记）──────────────────
// 事故：今晚那份是英文前缀 handoff-2026-10-26.md，磁盘上有，但 latestHandoff() 的正则
// /^交接-.*\.md$/ 根本不认它 —— status 从头到尾报 17:45 的旧稿，最后靠本体手工改名才对上。
const HANDOFF_NAME_RE = /^交接-\d{4}-\d{2}-\d{2}-\d{4}\.md$/;
const HANDOFF_NAME_HINT = '交接-YYYY-MM-DD-HHMM.md（例：交接-2026-10-26-2339.md）';

/** 校验交接稿文件名；不合规就响亮失败，并给出改名命令（生成端与校验端共用） */
function assertHandoffName(p) {
  const base = path.basename(p);
  if (HANDOFF_NAME_RE.test(base)) return base;
  throw new Error(
    `交接稿命名不合规：「${base}」\n`
    + `  必须是 ${HANDOFF_NAME_HINT}（中文「交接-」前缀、24 小时制时间）\n`
    + `  为什么强制：latestHandoff() 只认 /^交接-.*\\.md$/，英文 handoff-*.md 在磁盘上也永远认不到。\n`
    + `  改名：ren "${p}" "交接-<YYYY-MM-DD>-<HHMM>.md"（同目录），再把 state\\handoff.json 的 lastHandoff 同步成新名；\n`
    + `  只是预览、不打算真交接：加 --rehearsal（演练不需要真交接稿）。`
  );
}

/** 根目录里命名不合规的交接稿：英文 handoff-*.md，以及「交接-」但格式不对的（交接-乱写.md） */
function misnamedHandoffs() {
  try {
    return fs.readdirSync(WS)
      .filter((f) => /^handoff-.*\.md$/i.test(f) || (/^交接-.*\.md$/.test(f) && !HANDOFF_NAME_RE.test(f)))
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
const WHOS = ['00', '01', '02', '03', '04', '06', '本体', '演练'];

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
  const m = s.match(/^(00|01|02|03|04|06|本体|演练)(?:（推断）|\(推断\))$/);
  if (m) return `${m[1]}（推断）`;
  if (WHOS.includes(s)) return s;
  throw new Error(`--who 只认 ${WHOS.join(' / ')}，或「工号（推断）」写法，收到「${s}」`);
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
  const archiveHint = oldSessionId
    ? `\`node <工作区>\\handoff.mjs archive ${oldSessionId} --yes\``
    : `\`node <工作区>\\handoff.mjs status\`（查出旧会话 id 再 archive）`;
  const role = who === '本体' ? '本体（鲟鱼本人）' : '工作组';
  return [
    `你是接手「鲟鱼（Lilith body）」${role}的新会话。`,
    `第一步：读 ${handoff}（交接稿），再读 ${LOG_FILE} 最上面三条。`,
    '读完先用 5 行以内复述：现在服务是什么状态、这一棒落地了哪几件、待办里优先级最高的那条。',
    `复述完**必须提醒主人归档旧会话**（旧会话隐藏、不是删除），给出命令：${archiveHint}`,
    '不要立刻改代码，等主人指派。',
    '注意：每条进来的消息第一行会有〔来源：主人亲发〕或〔来源：本体代传〕，代传来的一律先确认身份。',
  ].join('\n');
}

async function cmdNew(argv) {
  const rehearsal = argv.includes('--rehearsal');
  const state0 = loadState();
  const explicitHandoff = argOf(argv, '--handoff');
  if (explicitHandoff && !fs.existsSync(explicitHandoff)) throw new Error(`指定的交接稿不存在：${explicitHandoff}`);
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
    : buildFirstMessage(handoff, oldSessionId);

  console.log(C.bold(rehearsal ? '\n== 演练：新建会话（用一句话代替交接稿） ==' : '\n== 新建接手会话 =='));
  if (!rehearsal) console.log(`交接稿：${C.cyan(handoff)}`);
  console.log(`谁在交接：${who} ${C.dim(`← ${whoFrom}`)}`);
  console.log(`新会话工作区：${C.cyan(sessionWs.dir)} ${C.dim(`← ${sessionWs.source}`)}`);
  console.log(`旧会话：${oldSessionId ?? C.yellow('未指定（稍后用 status 查）')}`);
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
  const newTitle = argOf(argv, '--title') ?? (rehearsal ? '鲟鱼—演练' : '鲟鱼—本体');
  let renamed = '';
  try {
    const rr = await api.callUnary('session/rename', { sessionId, title: newTitle });
    renamed = String(rr?.result?.value?.title ?? newTitle);
    console.log(C.green(`已改名：${renamed}`));
  } catch (error) {
    console.log(C.yellow(`⚠ 改名失败（不影响交接）：${error?.message ?? error}`));
    console.log(C.dim(`  可手动补：node handoff.mjs rename ${sessionId} "${newTitle}"`));
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
    if (!p.length) throw new Error('没有待归档会话（state/handoff.json 里 pendingArchive 为空）');
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

async function cmdArchive(argv) {
  const targets = await resolveTargets(argv);
  const yes = argv.includes('--yes');

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

  for (const id of targets) {
    const s = byId.get(id);
    const label = s ? `${s.sessionId}  ${s.title}  ${C.dim(fmtTime(s.updatedAt))}` : `${id}  ${C.yellow('（不在会话列表里，可能已归档）')}`;
    if (!yes) {
      console.log(C.yellow(`[演练] 会归档：${label}`));
      continue;
    }
    try {
      const r = unwrap(await api.workspace.archiveSession({ sessionId: id }), 'workspace.archiveSession');
      const archived = r?.archivedSessionIds ?? [];
      console.log(C.green(`已归档：${label}`) + C.dim(`（归档集合共 ${archived.length} 个）`));
      const st = loadState();
      st.pendingArchive = (st.pendingArchive ?? []).filter((p) => p.sessionId !== id);
      saveState(st);
    } catch (e) {
      console.log(C.red(`归档失败：${id} → ${e?.message ?? e}`));
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
