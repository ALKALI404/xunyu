// scripts\self-work-guard.mjs —— 查"本体是不是又自己干活了"
//
// 规矩见 docs\规则\本体不下场-2026-11-05.md：
//   项目目录里的文件被改动，且同项目没有"活儿在跑"（票处于 doing/submitted）→ 记一次下场。
//
// 用法：
//   node scripts\self-work-guard.mjs                扫描一次（发现违规退出码 1）
//   node scripts\self-work-guard.mjs --json         机器可读
//   node scripts\self-work-guard.mjs --intent "修端口" --minutes 30   登记一次例外
//   node scripts\self-work-guard.mjs --watch 300    每 300 秒扫一次（常驻）
import fs from 'node:fs';
import path from 'node:path';

const WS = 'E:/DSH_workspace';
const LEDGER = path.join(WS, 'state/worklist.jsonl');
const VIOL = path.join(WS, 'state/self-work-violations.jsonl');
const ALLOW = path.join(WS, 'state/self-work-allowed.json');

// 受管项目：项目 id → 目录 + 受管子目录
const PROJECTS = {
  insurance: {
    root: 'E:/DSH-WeChat/PengYan_Assistant',
    dirs: ['窗口', '脚本', '档案', '索引'],
  },
};

const WINDOW_MS = 30 * 60 * 1000;
// 规矩生效时间：此前的改动算历史记录，不追责（2026-11-05 20:25 主人定下这条）
const RULE_SINCE = Date.parse('2026-11-05T20:25:00+08:00');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const asJson = argv.includes('--json');
const watchSec = Number(arg('watch', '0'));

// ── 例外登记 ─────────────────────────────────────────────
if (argv.includes('--intent')) {
  const what = String(arg('intent', '')).trim();
  if (!what) { console.error('要写清做什么：--intent "修 xxx"'); process.exit(2); }
  const minutes = Number(arg('minutes', '30'));
  let allow = [];
  try { allow = JSON.parse(fs.readFileSync(ALLOW, 'utf8')); } catch { allow = []; }
  const row = { at: Date.now(), until: Date.now() + minutes * 60000, what, by: '本体' };
  allow.push(row);
  fs.writeFileSync(ALLOW, JSON.stringify(allow.slice(-50), null, 2), 'utf8');
  console.log(`已登记例外：${what}（${minutes} 分钟内有效，到期 ${new Date(row.until).toLocaleString('zh-CN')}）`);
  console.log('记得事后在 state\\current-task.md 写一行“为什么下场”，由 01 复核。');
  process.exit(0);
}

// ── 读台账：每个项目最近的"活儿在跑"时间 ───────────────────
function lastActive() {
  const out = {};
  let rows = [];
  try {
    rows = fs.readFileSync(LEDGER, 'utf8').split(/\r?\n/).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return out; }
  for (const r of rows) {
    const prj = r.project;
    if (!prj || !PROJECTS[prj]) continue;
    const isActive = r.op === 'accepted'
      || (r.op === 'state' && ['doing', 'submitted', 'done'].includes(r.state));
    if (!isActive) continue;
    const t = Number(r.t || 0);
    if (!out[prj] || t > out[prj]) out[prj] = t;
  }
  return out;
}

function walk(dir) {
  const out = [];
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function scan() {
  const active = lastActive();
  const cutoff = Date.now() - 24 * 3600 * 1000;   // 只看最近 24 小时
  let allow = [];
  try { allow = JSON.parse(fs.readFileSync(ALLOW, 'utf8')); } catch { allow = []; }
  const allows = allow.filter((a) => a.until > Date.now());

  const violations = [];
  const summary = [];

  for (const [pid, cfg] of Object.entries(PROJECTS)) {
    const files = cfg.dirs.flatMap((d) => walk(path.join(cfg.root, d)));
    const recent = files.map((f) => {
      let st;
      try { st = fs.statSync(f); } catch { return null; }
      return { file: f.replace(/\\/g, '/'), at: st.mtimeMs };
    }).filter(Boolean).filter((x) => x.at > cutoff && x.at > RULE_SINCE);

    const activeAt = active[pid] || 0;
    for (const r of recent) {
      const coveredByTicket = Math.abs(r.at - activeAt) <= WINDOW_MS;
      const coveredByAllow = allows.some((a) => r.at <= a.until && r.at >= a.at - 60000);
      if (coveredByTicket || coveredByAllow) continue;
      // 排除本文件自己产生的日志
      if (/self-work-violations|\.log$/.test(r.file)) continue;
      violations.push({ project: pid, file: r.file, at: r.at, why: '文件被改，但没有活儿在跑（最近票活动 ' + (activeAt ? new Date(activeAt).toLocaleString('zh-CN') : '无') + '）' });
    }
    summary.push({ project: pid, files: recent.length, lastTicketAt: activeAt ? new Date(activeAt).toLocaleString('zh-CN') : '无' });
  }

  return { at: new Date().toISOString(), summary, violations, allows: allows.length };
}

function runOnce() {
  const r = scan();
  if (r.violations.length) {
    fs.appendFileSync(VIOL, JSON.stringify({ at: r.at, count: r.violations.length, items: r.violations }) + '\n', 'utf8');
  }
  if (asJson) {
    console.log(JSON.stringify(r, null, 1));
  } else {
    for (const s of r.summary) {
      console.log(`${s.project}: 近 24h 改动 ${s.files} 个文件；最近一次票活动：${s.lastTicketAt}；在效例外 ${r.allows} 条`);
    }
    if (!r.violations.length) console.log('✅ 本体没下场（没有"无票改动"）');
    else {
      console.log(`❌ 疑似下场 ${r.violations.length} 处：`);
      for (const v of r.violations.slice(0, 12)) {
        console.log(`   ${v.file}  ${new Date(v.at).toLocaleString('zh-CN')}`);
      }
      if (r.violations.length > 12) console.log(`   …共 ${r.violations.length} 处`);
      console.log('   处置：要么补票（谁干的谁开票），要么 --intent 报备；01 复核后写 current-task。');
    }
  }
  return r.violations.length ? 1 : 0;
}

if (watchSec > 0) {
  console.log(`常驻：每 ${watchSec} 秒扫一次`);
  for (;;) {
    runOnce();
    await new Promise((r) => setTimeout(r, watchSec * 1000));
  }
} else {
  process.exit(runOnce());
}
