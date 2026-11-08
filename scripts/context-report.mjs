#!/usr/bin/env node
/**
 * context-report —— 启动上下文「占比分解」度量器（UG-046 立）
 *
 * 干什么：从真实会话日志里把**第一次真正发给模型的请求**拆开，分成
 *         MCP 工具 / 其余工具 schema / 系统提示 / 记忆注入 四块，并给出
 *         提供方口径的 pressureTokens（真实 prompt 规模）。
 * 为什么：UG-037 只量了 MCP（17.4k）就下结论；实测显示工具面 183 个里
 *         CUA 一家占 54% 的字符，不分解就没法定砍谁。
 *
 * 数据来源（全部只读，不改任何配置）：
 *   会话日志 `%USERPROFILE%\.dsh\sessions\<ws>\<session>\session.v4.jsonl.zstd`
 *     - `request/header`    → 该次请求的 tools 全量 schema（真身，不是估算）
 *     - `system/message`    → 系统提示正文
 *     - `user/message`      → 其中 `<engram_profile>` / `<engram_memory_context>` 段 = 记忆注入
 *     - `assistant/message` → 提供方回报的 usage（= 真实 prompt 规模，含聊天模板开销）
 *
 * 口径（换算式写死在这里，免得下一个人用别的系数得出另一套数字）：
 *   - `pressureTokens`       = **首步**成功 assistant 消息的 input+cacheRead+cacheWrite（启动成本）
 *   - `latestPressureTokens` = 末步同口径（会话现在多贵）
 *   - 工具块 token = 工具 JSON 字符 / 4 × kTools，kTools 由 --k-tools 指定，
 *     默认 1.12（实测标定：见 docs\环境\启动上下文账本-v2.md §三）
 *   - 系统提示 / 记忆注入 token = 字符 / 4（与 DSH 自带 token-meter 同一启发式）
 *   - `messageHistory` = pressureTokens 减去上面四块的**残差**（历史消息 + 聊天模板 + 估算误差）
 *
 * 用法：
 *   node scripts\context-report.mjs --session d14d50e3 [--json]
 *   node scripts\context-report.mjs --latest
 *   node scripts\context-report.mjs --session <id> --live          # 附 DSH 自己的 contextBreakdown 交叉核对
 *   node scripts\context-report.mjs --session <id> --tier minimal  # 按档位剪裁工具面，给推算值
 *   node scripts\context-report.mjs --scan 10                      # 最近 N 个会话的对照表
 * 退出码：0 成功｜1 找不到/读不出｜2 参数错误
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const DSH_HOME = process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh');
const SESSIONS = path.join(DSH_HOME, 'sessions');

const argv = process.argv.slice(2);
const val = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const has = (n) => argv.includes(`--${n}`);
const JSON_OUT = has('json');
const LIVE = has('live');
const TIER = val('tier');
const K_TOOLS = Number(val('k-tools', '1.12'));
const PROSE_CHARS_PER_TOKEN = 4;

// ── 读多帧 zstd 日志（DSH 每追加一批写一个独立帧；一次性解压只解第一帧）────────
function readSessionLog(file) {
  const buf = fs.readFileSync(file);
  const starts = [];
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) starts.push(i);
  }
  let text = '';
  let frames = 0;
  for (let k = 0; k < starts.length; k++) {
    const slice = buf.subarray(starts[k], k + 1 < starts.length ? starts[k + 1] : buf.length);
    try { text += zlib.zstdDecompressSync(slice).toString('utf8'); frames++; } catch { /* 残帧跳过 */ }
  }
  const events = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* 坏行跳过 */ }
  }
  return { events, frames, bytes: buf.length };
}

function listSessionFiles() {
  const out = [];
  if (!fs.existsSync(SESSIONS)) return out;
  for (const ws of fs.readdirSync(SESSIONS)) {
    const dir = path.join(SESSIONS, ws);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith('session-')) continue;
      const file = path.join(dir, name, 'session.v4.jsonl.zstd');
      if (fs.existsSync(file)) {
        const st = fs.statSync(file);
        out.push({ sessionId: name, file, mtime: st.mtimeMs, size: st.size, workspace: ws });
      }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

function locateLog(idOrShort) {
  const want = String(idOrShort).replace(/^session-/, '');
  return listSessionFiles().find((s) => s.sessionId.replace(/^session-/, '').startsWith(want)) ?? null;
}

// ── 工具面分族 ────────────────────────────────────────────────────────────────
function familyOf(name) {
  if (typeof name !== 'string') return 'builtin';
  if (name.startsWith('mcp__')) {
    const parts = name.split('__');
    return parts.length >= 3 && parts[1] ? `mcp__${parts[1]}__` : 'builtin';
  }
  if (name.startsWith('cua_driver_native__') || name.startsWith('cua_')) return 'cua_*';
  if (name.startsWith('engram_')) return 'engram_*';
  return 'builtin';
}
const toolNameOf = (t) => (typeof t?.name === 'string' ? t.name : (t?.function?.name ?? ''));

const ENGRAM_BLOCK_RES = [
  /<engram_profile>[\s\S]*?<\/engram_profile>/g,
  /<engram_memory_context[^>]*>[\s\S]*?<\/engram_memory_context>/g,
];
function engramCharsOf(text) {
  let n = 0;
  for (const re of ENGRAM_BLOCK_RES) {
    for (const m of String(text).matchAll(re)) n += m[0].length;
  }
  return n;
}
const textOfMessage = (m) => (m?.content ?? []).filter((c) => typeof c.text === 'string').map((c) => c.text).join('\n');

/** 档位定义：每档砍掉哪些工具族 */
const TIERS = {
  full: { drop: [], note: '现状：6 个 MCP（69 个工具）+ CUA（56）+ engram（23）+ 内置工具' },
  lean: {
    drop: ['cua_*'],
    note: '去掉 CUA driver 的 56 个电脑操作工具。损失：不能截图/点击/打字/看窗口 —— 界面类验收、vm-sender 之外的电脑操作全没了',
  },
  minimal: {
    drop: ['cua_*', 'engram_*', 'mcp__snowluma__', 'mcp__bilibili__', 'mcp__net-accel__', 'mcp__qq-extras__'],
    note: '只留 web-search-safe + snowluma-host + 内置工具。损失：不能画图/发语音/发网图（qq-extras）、不能查 B 站、不能修 GitHub 连通性（net-accel）、不能长期记忆（engram）、不能直发 QQ（snowluma，但 qq_dsh_* 中继也没了）',
  },
};

// ── 单会话分析 ────────────────────────────────────────────────────────────────
function analyze(target) {
  const { events, frames } = readSessionLog(target.file);
  const headers = events.filter((e) => e.type === 'request/header');
  const assistants = events.filter((e) => e.type === 'assistant/message' && e.data?.usage);
  if (!headers.length || !assistants.length) return { ok: false, reason: `还没有完整请求（header=${headers.length}, assistant=${assistants.length}）` };

  const firstAssistant = assistants[0];
  const lastAssistant = assistants[assistants.length - 1];
  const promptOf = (u) => Number(u.inputTokens ?? 0) + Number(u.cacheReadTokens ?? 0) + Number(u.cacheWriteTokens ?? 0);
  const pressureTokens = promptOf(firstAssistant.data.usage);
  const latestPressureTokens = promptOf(lastAssistant.data.usage);

  // 首步请求的工具面：取首个 request/header（与末个通常一致，脚本给出 fallback）
  const header = headers[0].data.header ?? {};
  const tools = Array.isArray(header.tools) ? header.tools : [];

  // 首步系统提示：第一个非空 system/message
  const sysMsg = events.find((e) => e.type === 'system/message' && textOfMessage(e.data?.message).trim());
  const sysText = textOfMessage(sysMsg?.data?.message);

  // 记忆注入：首步之前（seq < 首个 assistant 之前）的 user/message 里的 engram 段
  const firstAssistantSeq = Number(firstAssistant.seq ?? Number.MAX_SAFE_INTEGER);
  let memChars = 0;
  let memCopies = 0;
  let memTotalChars = 0;
  for (const e of events) {
    if (e.type !== 'user/message') continue;
    const c = engramCharsOf(textOfMessage(e.data));
    if (!c) continue;
    memTotalChars += c;
    memCopies += 1;
    if (Number(e.seq ?? 0) < firstAssistantSeq) memChars += c;
  }
  // 兜底：万一注入写在系统提示里
  const memInSystem = engramCharsOf(sysText);
  const systemChars = sysText.length - memInSystem;
  memChars += memInSystem;

  // 工具分族
  const fam = new Map();
  for (const t of tools) {
    const f = familyOf(toolNameOf(t));
    const chars = JSON.stringify(t).length;
    const g = fam.get(f) ?? { count: 0, chars: 0 };
    g.count += 1; g.chars += chars;
    fam.set(f, g);
  }
  const allToolChars = [...fam.values()].reduce((s, g) => s + g.chars, 0);
  const mcpChars = [...fam.entries()].filter(([f]) => f.startsWith('mcp__')).reduce((s, [, g]) => s + g.chars, 0);

  const toolTokens = (chars) => Math.round((chars / 4) * K_TOOLS);
  const proseTokens = (chars) => Math.round(chars / PROSE_CHARS_PER_TOKEN);

  const breakdown = {
    mcp: toolTokens(mcpChars),
    toolSchema: toolTokens(allToolChars - mcpChars),
    systemPrompt: proseTokens(systemChars),
    memoryInjection: proseTokens(memChars),
  };
  const partsSum = Object.values(breakdown).reduce((a, b) => a + b, 0);
  breakdown.messageHistory = Math.max(0, pressureTokens - partsSum);

  const toolCharsOf = (drop) => [...fam.entries()].filter(([f]) => !drop.includes(f)).reduce((s, [, g]) => s + g.chars, 0);
  const tiers = {};
  for (const [name, def] of Object.entries(TIERS)) {
    const keptChars = toolCharsOf(def.drop);
    const droppedChars = allToolChars - keptChars;
    const predicted = pressureTokens - toolTokens(droppedChars);
    tiers[name] = {
      drop: def.drop,
      note: def.note,
      toolsCount: tools.filter((t) => !def.drop.includes(familyOf(toolNameOf(t)))).length,
      toolChars: keptChars,
      predictedPressureTokens: Math.round(predicted),
    };
  }

  return {
    ok: true,
    sessionId: target.sessionId,
    workspace: target.workspace,
    logFile: target.file,
    frames,
    events: events.length,
    at: new Date().toISOString(),
    pressureTokens,
    latestPressureTokens,
    breakdown,
    breakdownSum: Object.values(breakdown).reduce((a, b) => a + b, 0),
    toolsCount: tools.length,
    toolChars: allToolChars,
    toolNames: tools.map(toolNameOf),
    systemChars,
    memoryChars: memChars,
    memoryCopiesBeforeFirstStep: memCopies,
    memoryCharsAllTurns: memTotalChars,
    mcpServers: [...fam.entries()].filter(([f]) => f.startsWith('mcp__'))
      .map(([f, g]) => ({ name: f.replace(/^mcp__|__$/g, ''), tools: g.count, chars: g.chars, tokens: toolTokens(g.chars) }))
      .sort((a, b) => b.tokens - a.tokens),
    families: [...fam.entries()].map(([f, g]) => ({ family: f, tools: g.count, chars: g.chars, tokens: toolTokens(g.chars) }))
      .sort((a, b) => b.tokens - a.tokens),
    tiers,
    calibration: { kTools: K_TOOLS, proseCharsPerToken: PROSE_CHARS_PER_TOKEN },
    usage: { first: firstAssistant.data.usage, last: lastAssistant.data.usage },
  };
}

// ── 入口 ──────────────────────────────────────────────────────────────────────
if (has('scan')) {
  const limit = Number(val('scan', '8'));
  const rows = [];
  for (const cand of listSessionFiles()) {
    if (rows.length >= limit) break;
    try {
      const r = analyze(cand);
      if (!r.ok) continue;
      rows.push({
        sessionId: r.sessionId, workspace: r.workspace, pressureTokens: r.pressureTokens,
        latestPressureTokens: r.latestPressureTokens, toolsCount: r.toolsCount, toolChars: r.toolChars,
        families: Object.fromEntries(r.families.filter((f) => f.family !== 'builtin').map((f) => [f.family.replace(/^mcp__|__$/g, ''), f.tools])),
      });
    } catch { /* 下一份 */ }
  }
  if (JSON_OUT) console.log(JSON.stringify({ rows }, null, 2));
  else {
    const fm = (n) => Number(n).toLocaleString('en-US');
    for (const r of rows) {
      console.log(`\n${r.sessionId}  ws=${r.workspace}`);
      console.log(`  启动 ${fm(r.pressureTokens)} → 现在 ${fm(r.latestPressureTokens)} ｜ 工具 ${r.toolsCount} 个 / ${fm(r.toolChars)} 字符 ｜ ${Object.entries(r.families).map(([f, n]) => `${f}×${n}`).join(' ') || '(仅内置)'}`);
    }
  }
  process.exit(0);
}

const target = val('session') ? locateLog(val('session')) : (has('latest') ? listSessionFiles().find((s) => { try { return analyze(s).ok; } catch { return false; } }) : null);
if (!target) {
  console.error(val('session') ? `找不到会话日志：${val('session')}` : '用法：--session <id> | --latest | --scan N');
  process.exitCode = 2;
  process.exit(2);
}

const report = analyze(target);
if (!report.ok) {
  console.error(`会话 ${target.sessionId} ${report.reason}`);
  process.exitCode = 1;
  process.exit(1);
}

if (LIVE) {
  try {
    const { NodeApiClient, unwrap } = await import('file:///E:/DeepFish/qq-bridge-0.2.1-r1/qq-bridge-0.2.1-r1/src/dsh-client.js');
    const { resolveDshBase } = await import('./dsh-base.mjs');
    const api = new NodeApiClient(resolveDshBase().url, undefined, { token: '', tokenExplicit: false, header: 'authorization', prefix: 'Bearer', allowRemote: false });
    const items = unwrap(await api.sessions.list({}), 'session.list').items ?? [];
    const hit = items.find((s) => String(s.sessionId) === report.sessionId);
    report.live = hit ? { contextPressure: hit.projections?.values?.contextPressure ?? null, contextBreakdown: hit.projections?.values?.contextBreakdown ?? null } : { error: '不在 DSH 会话列表（已归档？）' };
  } catch (e) {
    report.live = { error: String(e?.message ?? e) };
  }
}

const OUT = val('out');
if (OUT) {
  fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
  fs.writeFileSync(path.resolve(OUT), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.error(`已写 ${path.resolve(OUT)}`);
}

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const fm = (n) => Number(n).toLocaleString('en-US');
  const pct = (n) => `${(n / report.pressureTokens * 100).toFixed(1)}%`;
  console.log(`上下文占比分解 · ${report.sessionId}`);
  console.log(`日志 ${report.logFile}（${report.frames} 帧 / ${report.events} 事件）`);
  console.log(`\n启动 pressureTokens = ${fm(report.pressureTokens)}   现在 = ${fm(report.latestPressureTokens)}`);
  console.log(`工具 ${report.toolsCount} 个 / ${fm(report.toolChars)} 字符 ｜ 系统提示 ${fm(report.systemChars)} 字符 ｜ 记忆注入 ${fm(report.memoryChars)} 字符（首步前 ${report.memoryCopiesBeforeFirstStep} 份；全会话累计 ${fm(report.memoryCharsAllTurns)} 字符）`);
  console.log(`\n四块分解（kTools=${report.calibration.kTools}，散文 ${report.calibration.proseCharsPerToken} 字符/token）：`);
  for (const [k, v] of Object.entries(report.breakdown)) {
    console.log(`  ${k.padEnd(18)} ${String(fm(v)).padStart(7)}  (${pct(v)})`);
  }
  console.log(`  ${'合计'.padEnd(18)} ${String(fm(report.breakdownSum)).padStart(7)}`);
  console.log(`\n工具按族：`);
  for (const f of report.families) console.log(`  ${f.family.padEnd(24)} 个=${String(f.tools).padStart(3)}  ≈${String(fm(f.tokens)).padStart(6)} token`);
  if (report.mcpServers.length) {
    console.log(`\nMCP 明细：`);
    for (const m of report.mcpServers) console.log(`  ${m.name.padEnd(16)} 个=${String(m.tools).padStart(3)}  ${String(fm(m.chars)).padStart(7)} 字符  ≈${fm(m.tokens)} token`);
  }
  console.log(`\n三档（full 为实测，lean/minimal 为按同一口径剪裁后的推算）：`);
  for (const [name, t] of Object.entries(report.tiers)) {
    console.log(`  ${name.padEnd(8)} ≈${String(fm(t.predictedPressureTokens)).padStart(7)} token  工具 ${String(t.toolsCount).padStart(3)} 个  ${t.drop.length ? '砍掉 ' + t.drop.join('+') : '不砍'}`);
  }
  if (TIER && report.tiers[TIER]) console.log(`\n档位 ${TIER}：${report.tiers[TIER].note}`);
  if (report.live) console.log(`\nDSH 自己的投影核对：${JSON.stringify(report.live)}`);
}

