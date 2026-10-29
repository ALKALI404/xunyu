#!/usr/bin/env node
// 鲟鱼 · 记忆归档管线（2026-10-25）
//
// 阶段：
//   ingest  —— 把 QQ / 窗口两条来源按天搬进 inbox（只追加、带水位，幂等）
//   daily   —— distill（带原文指针）→ diff（只输出增/删，不写摘要）→ 日记（≤10 行）
//   weekly  —— 周蒸馏（≤50 行）→ 合并进 long-term.md（≤200 行），超限删最不影响判断的并归档
//   catchup —— 「每天第一次唤醒补跑」：今天没跑过就补跑 daily，并记 by='catchup'
//
// 三档标记：你说的（逐字）/ 我说的（判断）/ 规矩（只进 rules/，永不进记忆）
// 预算：v1 为纯规则抽取（0 成本）；LLM 版单次上限见 DISTILL_BUDGET_CNY（¥0.5）。
// **保真优先，省钱的代价是失真**——只有超过 0.5 才降级成规则抽取。
//
// 用法：node memory-pipeline.mjs --stage=daily [--date=2026-10-25] [--dbg]

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DRY = process.argv.includes('--dbg-dry');
const arg = (name, dflt = '') => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const STAGE = arg('stage', 'daily');
const TODAY = arg('date', new Date().toLocaleDateString('sv-SE'));
// 单次蒸馏的预算上限（元）。**保真优先，省钱的代价是失真**：所以给到 0.5 而不是 0.05；
// 只有超过这个数才降级成纯规则抽取（不调用模型）。
const DISTILL_BUDGET_CNY = 0.5;

const ROOT = 'E:\\DeepFish';
const HIST = path.join(ROOT, 'History', 'chats');
const XUN = path.join(ROOT, 'Xunyu');
const MEM = path.join(XUN, 'memory');
const DAILY = path.join(XUN, 'daily');
const DIRS = {
  inbox: path.join(MEM, 'inbox'),
  distill: path.join(MEM, 'distill'),
  diff: path.join(MEM, 'diff'),
  weekly: path.join(MEM, 'weekly'),
  topics: path.join(MEM, 'topics'),
  archive: path.join(MEM, 'archive'),
  rules: path.join(MEM, 'rules'),
  state: path.join(MEM, 'state')
};
for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });
const STATE_FILE = path.join(DIRS.state, 'pipeline.json');
const LOG_FILE = path.join(DIRS.state, 'pipeline.log');

const log = (msg) => {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
};
const readJson = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { return dflt; } };
// 已报清单只存哈希（2026-10-25 主人要求）：state 里不再留原文前 40 字，
// 16 位十六进制足够避撞，也让人一眼看出「这里不该存正文」。
const HASH_RE = /^[0-9a-f]{16}$/;
const hashKey = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);
const writeJson = (f, v) => { if (!DRY) fs.writeFileSync(f, JSON.stringify(v, null, 2), 'utf8'); };
const readLines = (f) => {
  try { return fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()); } catch { return []; }
};
const state = readJson(STATE_FILE, { ingest: {}, daily: {} });

// ── 配置：owner QQ ────────────────────────────────────────────────────────
const CONFIG = readJson('E:\\DeepFish\\qq-bridge-0.2.1-r1\\qq-bridge-0.2.1-r1\\config.json', {});
const OWNER_QQ = String(CONFIG.ownerQQ ?? '');

// ── 规则：什么算「规矩」────────────────────────────────────────────────────
const RULE_RE = /(不许|不准|不允许|必须|永远|一律|禁止|只能|规矩|红线|原则上是)/;

// 噪声：纯媒体占位、CQ 码、桥接自己的状态播报（不是主人的话，也不是判断）
const JUNK_RE = /^(\[图片\]|\[动画表情\]|\[表情\]|\[视频\]|\[语音\]|\[CQ:[^\]]*\]|✅|⏹|⏸|⏰|⌛|💤|⚠️|🔐|❌|🔥【花费提醒】|💰)/u;
const isJunk = (text) => {
  const t = String(text ?? '').trim();
  if (!t) return true;
  if (JUNK_RE.test(t)) return true;
  if (/^(已通过审批|已停止|等待回答超时|已取消该请求|本条回复因疑似|【花费提醒】)/.test(t)) return true;
  return false;
};

// ── 阶段 1：ingest ───────────────────────────────────────────────────────
function ingest() {
  // 真实字段（2026-10-25 核实）：{ts, direction:'in'|'out', sender, senderName, text, media}
  //   direction=out → 鲟鱼自己说的（我说的）
  //   direction=in 且 sender=ownerQQ → 主人说的（你说的，逐字）
  //   其它 → 群友/上下文（进 inbox 但不进 fact）
  const sources = [
    {
      kind: 'qq',
      classify: (r) => {
        if (r.direction === 'out' || r.isSelf === true) return 'agent';
        if (String(r.sender ?? r.userId ?? '') === OWNER_QQ) return 'owner';
        return 'other';
      }
    }
  ];
  let total = 0;
  for (const src of sources) {
    const files = fs.readdirSync(HIST).filter((f) => f.endsWith('.jsonl') && (
      src.kind === 'qq' ? (f.startsWith('private_') || f.startsWith('group_')) : f.startsWith('window_')
    ));
    for (const file of files) {
      const full = path.join(HIST, file);
      const lines = readLines(full);
      const key = `${src.kind}:${file}`;
      const done = Number(state.ingest[key] ?? 0);
      if (lines.length <= done) continue;
      const fresh = lines.slice(done);
      const buckets = new Map();
      for (let i = 0; i < fresh.length; i += 1) {
        let rec;
        try { rec = JSON.parse(fresh[i]); } catch { continue; }
        const ts = Number(rec.time ?? rec.ts ?? 0);
        if (!ts) continue;
        const day = new Date(ts).toLocaleDateString('sv-SE');
        if (!buckets.has(day)) buckets.set(day, []);
        buckets.get(day).push({
          ts,
          day,
          kind: src.kind,
          from: src.classify(rec),
          sender: String(rec.sender ?? rec.userId ?? rec.t ?? ''),
          text: String(rec.text ?? rec.plain ?? '').trim(),
          ptr: `${file}#${done + i + 1}`
        });
      }
      for (const [day, recs] of buckets) {
        const out = path.join(DIRS.inbox, `${src.kind}-${day}.jsonl`);
        if (!DRY) fs.appendFileSync(out, recs.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
        total += recs.length;
      }
      state.ingest[key] = lines.length;
    }
  }
  // 窗口来源 = 聊天记事本（relay 写）：History/chats/window_YYYY-MM-DD.md
  // 一句一行，格式：`[HH:MM:SS] 主人：……` / `[HH:MM:SS] 鲟鱼：……`
  const winFiles = fs.readdirSync(HIST).filter((f) => /^window_\d{4}-\d{2}-\d{2}\.md$/.test(f));
  for (const file of winFiles) {
    const day = file.slice(7, 17);
    const lines = readLines(path.join(HIST, file));
    const key = `window:${file}`;
    const done = Number(state.ingest[key] ?? 0);
    if (lines.length <= done) continue;
    const recs = [];
    for (let i = done; i < lines.length; i += 1) {
      const m = /^\[(\d{2}):(\d{2}):(\d{2})\]\s*(主人|鲟鱼)：(.*)$/.exec(lines[i]);
      if (!m) continue;
      const ts = new Date(`${day}T${m[1]}:${m[2]}:${m[3]}`).getTime();
      recs.push({
        ts, day, kind: 'window',
        from: m[4] === '主人' ? 'owner' : 'agent',
        sender: m[4],
        text: String(m[5] ?? '').trim(),
        ptr: `${file}#${i + 1}`
      });
    }
    if (recs.length && !DRY) {
      fs.appendFileSync(path.join(DIRS.inbox, `window-${day}.jsonl`), recs.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    }
    total += recs.length;
    state.ingest[key] = lines.length;
  }

  writeJson(STATE_FILE, state);
  log(`ingest 完成：搬入 ${total} 条（水位：${Object.keys(state.ingest).length} 个文件）`);
  return total;
}

// ── 阶段 2：distill（带指针）──────────────────────────────────────────────
function distill(day) {
  const facts = [];
  const ruleLines = [];
  const seen = new Set(); // 同一条原文只收一次（ingest 重跑不会造成重复）
  for (const kind of ['qq', 'window']) {
    const recs = readLines(path.join(DIRS.inbox, `${kind}-${day}.jsonl`)).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    for (const r of recs) {
      if (!r.text || isJunk(r.text)) continue;
      if (r.from === 'other') continue;
      if (seen.has(r.ptr)) continue;
      seen.add(r.ptr);
      const tier = RULE_RE.test(r.text) ? '规矩' : (r.from === 'owner' ? '你说的' : '我说的');
      const ptr = `〔源: ${day} · ${r.ptr}〕`;
      if (tier === '规矩') { ruleLines.push(`- 〔规矩·${day}〕${r.text} ${ptr}`); continue; }
      facts.push({
        key: `${tier}|${hashKey(r.text)}`,
        tier,
        from: r.from,
        text: r.text,
        day,
        ts: Number(r.ts ?? 0),
        ptr
      });
    }
  }
  const out = { day, generatedAt: new Date().toISOString(), facts, rules: ruleLines.length };
  writeJson(path.join(DIRS.distill, `${day}.json`), out);
  if (ruleLines.length && !DRY) {
    fs.appendFileSync(path.join(DIRS.rules, 'rules.md'), `\n## ${day}\n${ruleLines.join('\n')}\n`, 'utf8');
  }
  log(`distill ${day}：${facts.length} 条 fact（你说的 ${facts.filter((f) => f.tier === '你说的').length} / 我说的 ${facts.filter((f) => f.tier === '我说的').length}），规矩分流 ${ruleLines.length} 条`);
  return out;
}

// ── 阶段 3：diff（只输出差异，不写摘要）──────────────────────────────────
function diff(day) {
  // 增量口径（2026-10-25 主人验收要求）：只报「上次跑完之后新增/消失的」，
  // **不是**「今天 vs 昨天」。所以同一天跑第二次、期间没有新消息 → 差异必须为空。
  const cur = readJson(path.join(DIRS.distill, `${day}.json`), null);
  if (!cur) { log(`diff ${day}：没有当天蒸馏，跳过`); return []; }
  // 兼容旧格式（`tier|原文前40字`）：读出来先转成哈希再比，避免升级当天全量「+/-」风暴
  const toHashKey = (k) => {
    const s = String(k);
    const i = s.indexOf('|');
    const tier = i > 0 ? s.slice(0, i) : '';
    const rest = i > 0 ? s.slice(i + 1) : s;
    return HASH_RE.test(rest) ? s : `${tier}|${hashKey(rest)}`;
  };
  const reported = new Set((state.reported?.[day] ?? []).map(toHashKey));
  // 旧格式（`tier|原文前40字`）无法反推全文，升级当天必然对不上——这种情况不输出增删，
  // 只静默重建基线，否则会炸出一份几百行的假「+/-」报告（2026-10-25 升级当天踩到）。
  const rawReported = state.reported?.[day] ?? [];
  const legacyBaseline = rawReported.some((k) => {
    const s = String(k); const i = s.indexOf('|');
    return i > 0 && !HASH_RE.test(s.slice(i + 1));
  });
  const curKeys = new Map(cur.facts.map((f) => [f.key, f]));
  const rows = [];
  for (const f of cur.facts) {
    if (!reported.has(f.key)) rows.push(`+ 〔${f.tier}〕${oneLine(f.text)} ${f.ptr}`);
  }
  for (const k of reported) {
    if (!curKeys.has(k)) rows.push(`- 消失：${oneLine(String(k))}（本次蒸馏里不再出现；原文见当天 inbox）`);
  }
  if (!state.reported) state.reported = {};
  state.reported[day] = [...curKeys.keys()];
  writeJson(STATE_FILE, state);
  if (legacyBaseline) {
    rows.length = 0;
    log(`diff ${day}：旧格式基线（存了原文），本次只重建哈希基线，不输出增删`);
  }
  const head = `# ${day} 差异（只列增删，不写摘要；口径＝增量）\n\n${legacyBaseline ? '基线已升级为哈希（本次不报增删）' : reported.size ? '基线：本日已报过 ' + reported.size + ' 条' : '本日首次运行（全部算新增）'}\n`;
  const body = rows.length ? rows.join('\n') : '（无变化）';
  if (!DRY) fs.writeFileSync(path.join(DIRS.diff, `${day}.md`), `${head}\n${body}\n`, 'utf8');
  log(`diff ${day}：新增 ${rows.filter((r) => r.startsWith('+')).length} / 消失 ${rows.filter((r) => r.startsWith('-')).length}（增量口径）`);
  return rows;
}
const oneLine = (s) => String(s).replace(/\s+/g, ' ').slice(0, 80);

// ── 阶段 4：日记（≤10 行）────────────────────────────────────────────────
// 纯应答（不算「今天有什么不一样」）：整句就是这些词、且不含决定词时丢掉
const PURE_REPLY_RE = /^(如何实现|也就是还没做|嗯+|哦+|啊+|好|好的|行|对|是|没有|不要紧|然后呢|怎么办|那我应该怎么做|啥|在吗|可以|知道了?|收到)[。…、,.?？!！~～\s]*$/u;
// 决定词（2026-10-25 收窄）：以前是 /(就|改成|上线|同意|定|别|要)/，
// 「就/要/定/别」单独出现几乎人人命中（"就是""要求""别人"都会中），等于没过滤。
const DECIDE_RE = /(改成|改为|换成|切成|上线|同意|决定|定了|就按|就这(个|样)|按这个|照这个|批准|不要|别用|别看|别做|别碰|别再|必须|动手|执行|归档|删掉|删除|换掉|定下来|就这么|以后都|从现在起)/u;
// 系统状态行（2026-10-25 主人要求）：这些是**流程播报**，不是「今天有什么不一样」。
// ① 以图标开头的（🗂 交接完成…／🧾 已让它把当前工作蒸馏成…／💸 花费提醒…）；
// ② 「我说的」里的过程播报（跳过历史／唤醒频率超限／已重新绑定…）——
//    只在 tier=我说的 时过滤，免得把主人真说过的「把这个归档掉」误杀。
const STATUS_PREFIX_RE = /^\s*(🗂|🧾|💸|✅|⚠|⏵|❌|🔐|📦|📝|🔁|🛠|❓|📊|🧠|💤)/u;
const STATUS_PROC_RE = /(交接完成|跳过历史|唤醒频率超限|计划唤醒|会话失效|已重新绑定|工具已发送消息|AI 内部输出|归档集合|重连后恢复|蒸馏成交接稿)/u;

function diary(day) {
  const cur = readJson(path.join(DIRS.distill, `${day}.json`), null) ?? { facts: [] };
  const facts = (cur.facts ?? []).slice().sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  // ① 按「回合」聚合：相邻消息间隔 > **90 秒**算新回合（5 分钟太粗，会把整晚并成一条）
  const GAP_MS = 90 * 1000;
  const rounds = [];
  for (const f of facts) {
    const ts = Number(f.ts ?? 0);
    const last = rounds[rounds.length - 1];
    if (!last || ts - last.end > GAP_MS) rounds.push({ start: ts, end: ts, items: [f] });
    else { last.end = ts; last.items.push(f); }
  }
  // ② 回合压成一条：取该回合里**最长的 1~3 句主人话**（不是把几十句拼一起）；指针取回合第一条原文
  const unwrapPtr = (p) => String(p ?? '').replace(/^〔源:\s*\d{4}-\d{2}-\d{2}\s*·\s*/, '').replace(/〕\s*$/, '');
  const cand = rounds.map((r) => {
    const owners = r.items.filter((x) => x.tier === '你说的');
    // 回合内也先滤掉纯应答（「也就是还没做」「好」这类），免得混进句子中间
    const clean = (arr) => arr.filter((x) => !PURE_REPLY_RE.test(String(x.text ?? '').trim()));
    const poolOwners = clean(owners);
    const pool = (poolOwners.length ? poolOwners : clean(r.items)).slice();
    const poolFinal = pool.length ? pool : (owners.length ? owners : r.items).slice();
    const picked = poolFinal.slice()
      .sort((a, b) => String(b.text ?? '').length - String(a.text ?? '').length)
      .slice(0, 3);
    const ordered = poolFinal.filter((x) => picked.includes(x));
    const text = ordered.map((x) => String(x.text ?? '').trim()).join(' ／ ').replace(/\s+/g, ' ').slice(0, 120);
    const first = r.items[0];
    return { text, tier: (owners[0] ?? first).tier, ptr: unwrapPtr(first.ptr), ts: r.start, len: text.length };
  }).filter((x) => {
    if (!x.text) return false;
    if (PURE_REPLY_RE.test(x.text)) return false;
    if (STATUS_PREFIX_RE.test(x.text)) return false;
    if (x.tier === '我说的' && STATUS_PROC_RE.test(x.text)) return false;
    if (x.len < 6 && !DECIDE_RE.test(x.text)) return false;
    return true;
  });
  // ③ 分流（2026-10-25 主人要求）：日记**只收含决定词的回合**；
  //    其余成段的深谈（哲学长段那种）不再挤占日记行数，单独存 topics/<day>.md。
  const decideRounds = cand.filter((x) => DECIDE_RE.test(x.text));
  const deepRounds = cand.filter((x) => !DECIDE_RE.test(x.text) && x.len >= 30);
  const top = decideRounds.slice()
    .sort((a, b) => (b.len - a.len) || (b.ts - a.ts))
    .slice(0, 9)
    .sort((a, b) => a.ts - b.ts);

  const lines = [`# ${day}　今天有什么不一样`];
  if (!top.length) lines.push('- 今天没有值得记下来的决定。');
  else lines.push(...top.map((x) => `- 〔${x.tier}〕${x.text} 〔源: ${day} · ${x.ptr}〕`));
  if (lines.length > 10) lines.length = 10;
  if (!DRY) fs.writeFileSync(path.join(DAILY, `${day}.md`), lines.join('\n') + '\n', 'utf8');

  // 深谈另存：不进日记，但也不丢；带指针、按时间排、最多 20 条
  const topics = deepRounds.slice().sort((a, b) => a.ts - b.ts).slice(-20);
  if (topics.length) {
    const tlines = [
      `# ${day} 深谈留档（不进日记）`,
      ...topics.map((x) => `- 〔${x.tier}〕${x.text} 〔源: ${day} · ${x.ptr}〕`)
    ];
    if (!DRY) fs.writeFileSync(path.join(DIRS.topics, `${day}.md`), tlines.join('\n') + '\n', 'utf8');
  }

  log(`日记 ${day}：${lines.length - 1} 行（${facts.length} 条原文 → ${rounds.length} 个回合 → 决定 ${decideRounds.length} / 深谈 ${deepRounds.length} → 入选 ${top.length}；深谈另存 ${topics.length}）`);
  return lines;
}

// ── 阶段 5：周蒸馏 + 长期记忆上限 ────────────────────────────────────────
function weekly(day) {
  const d = new Date(`${day}T12:00:00`);
  const monday = new Date(d.getTime() - ((d.getDay() + 6) % 7) * 86400000);
  const weekId = `${monday.toLocaleDateString('sv-SE')}`;
  const files = fs.readdirSync(DAILY).filter((f) => f.endsWith('.md')).sort();
  const picked = [];
  for (const f of files) {
    const dayStr = f.replace('.md', '');
    const t = new Date(`${dayStr}T12:00:00`).getTime();
    if (t < monday.getTime()) continue;
    for (const line of readLines(path.join(DAILY, f))) {
      if (line.startsWith('- ')) picked.push(`${line} 〔${dayStr}〕`);
    }
  }
  const capped = picked.slice(-50);
  if (!DRY) fs.writeFileSync(path.join(DIRS.weekly, `${weekId}.md`), `# ${weekId} 起这一周\n${capped.join('\n')}\n`, 'utf8');
  // 长期记忆：只收「转折点」（diff 里的行），超 200 行删最旧的非主人原话
  const lt = path.join(MEM, 'long-term.md');
  const existing = readLines(lt);
  const keep = existing.filter((l) => /〔你说的〕|〔规矩〕/.test(l));
  const others = existing.filter((l) => !keep.includes(l));
  const budget = Math.max(0, 200 - keep.length - 10);
  const merged = [...keep.slice(0, 60), ...others.slice(-budget)];
  const dropped = existing.length - merged.length;
  if (dropped > 0 && !DRY) {
    fs.writeFileSync(path.join(DIRS.archive, `long-term-trim-${day}.md`), existing.join('\n'), 'utf8');
  }
  if (!DRY) fs.writeFileSync(lt, merged.join('\n') + (merged.length ? '\n' : ''), 'utf8');
  log(`weekly ${weekId}：日记行 ${picked.length} 条（保留 ${capped.length}）；long-term ${existing.length} → ${merged.length} 行（删 ${dropped}，已归档）`);
}

// ── 主流程 ───────────────────────────────────────────────────────────────
const runDaily = (by) => {
  const d = distill(TODAY);
  const rows = diff(TODAY);
  // 日记按「当天累计」重写：diff 是增量（只为判断「这次有没有新东西」），
  // 但日记要反映**一整天**，所以把历次增量累起来再写，避免同一天多跑几次越跑越短。
  if (!state.diaryRows) state.diaryRows = {};
  const prevRows = Array.isArray(state.diaryRows[TODAY]) ? state.diaryRows[TODAY] : [];
  const merged = [...new Set([...prevRows, ...rows])];
  state.diaryRows[TODAY] = merged;
  if (merged.length) diary(TODAY);
  else log(`日记 ${TODAY}：今天还没有任何变化，先不写`);
  state.daily[TODAY] = { at: new Date().toISOString(), by, facts: d.facts.length, rules: d.rules };
  writeJson(STATE_FILE, state);
  return { facts: d.facts.length, diffRows: rows.length, diaryRows: merged.length };
};

if (STAGE === 'ingest') ingest();
else if (STAGE === 'daily') { ingest(); runDaily('timer'); }
else if (STAGE === 'weekly') weekly(TODAY);
else if (STAGE === 'catchup') {
  const done = state.daily[TODAY];
  if (done) log(`catchup：${TODAY} 已经跑过（by=${done.by} @ ${done.at}），跳过`);
  else {
    const hour = new Date().getHours();
    if (hour < 4) log(`catchup：还没到 04:00（现在 ${hour} 点），不补跑`);
    else { ingest(); const r = runDaily('catchup'); log(`catchup：补跑完成 ${JSON.stringify(r)}`); }
  }
}
else { log(`未知阶段：${STAGE}（可用 ingest / daily / weekly / catchup）`); process.exit(2); }
