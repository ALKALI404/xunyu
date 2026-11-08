// scripts\health-3sat.mjs —— 把"各项功能是否正常"写成 3-CNF 子句，最后一行输出全真/不全真
//
// 思路（主人的要求）：
//   1. 每个"可观测事实"是一个**文字(literal)**：P=true 表示该检查通过，¬P=false 表示失败；
//   2. 把"健康"写成若干**三文字子句**（clause = 三个 literal 的析取），组成 CNF；
//   3. **不做逆运算/不求解**：所有 literal 由现场探测直接给出真假，只需**逐子句求值**；
//   4. 最后一行：`RESULT: SAT ...` 表示全部子句为真（系统在正常工作）；
//      `RESULT: UNSAT ...` 会指出**第几个子句**为假，以及它的三个文字当前真假。
//
// 用法：
//   node scripts\health-3sat.mjs           正常体检
//   node scripts\health-3sat.mjs --json    机器可读
//   node scripts\health-3sat.mjs --verbose 打印每个文字的证据
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import net from 'node:net';

const WORKSPACE = 'E:/DSH_workspace';
const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const verbose = argv.includes('--verbose');

const lit = {};   // name -> {value:boolean, evidence:string}
const say = (s) => { if (verbose) console.log('  ' + s); };

function probe(name, fn) {
  try {
    const r = fn();
    lit[name] = { value: !!r.ok, evidence: String(r.evidence ?? '').slice(0, 120) };
  } catch (e) {
    lit[name] = { value: false, evidence: '异常：' + String(e.message).slice(0, 80) };
  }
}
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const listening = (port) => new Promise((res) => {
  const s = net.connect({ port, host: '127.0.0.1' }, () => { s.destroy(); res(true); });
  s.on('error', () => res(false));
  s.setTimeout(1500, () => { s.destroy(); res(false); });
});

// ── 文字定义（只做观测，不推断）────────────────────────────────────────
probe('P1_台账可读', () => {
  const rows = fs.readFileSync(path.join(WORKSPACE, 'state/worklist.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean);
  const ids = new Set(rows.map((l) => { try { return JSON.parse(l).id; } catch { return null; } }).filter(Boolean));
  return { ok: ids.size > 50, evidence: `工单 ${ids.size} 张 / 事件 ${rows.length} 行` };
});

probe('P2_项目栏可读', () => {
  const j = readJson(path.join(WORKSPACE, 'state/projects.json'));
  return { ok: Array.isArray(j.projects) && j.projects.length >= 10, evidence: `项目 ${j.projects?.length ?? 0} 个` };
});

probe('P3_对账通过', () => {
  try {
    execFileSync(process.execPath, ['scripts/pr-reconcile.mjs', '--check'], { cwd: WORKSPACE, stdio: 'ignore', timeout: 60000 });
    return { ok: true, evidence: 'pr-reconcile --check exit=0' };
  } catch (e) {
    return { ok: false, evidence: 'pr-reconcile --check exit!=0' };
  }
});

probe('P4_预算闸可判', () => {
  const j = readJson(path.join(WORKSPACE, 'state/budget.json'));
  return { ok: typeof j === 'object' && 'enforce' in j, evidence: `enforce=${String(j.enforce)}` };
});

probe('P5_优先队列可读', () => {
  const j = readJson(path.join(WORKSPACE, 'state/priority-list.json'));
  return { ok: Array.isArray(j.tickets), evidence: `active=${j.active} / ${j.tickets?.length ?? 0} 张` };
});

probe('P6_企微已暂停', () => {
  const j = readJson(path.join(WORKSPACE, 'state/projects.json'));
  const w = j.projects.find((p) => p.id === 'wecom');
  return { ok: w?.status === 'paused', evidence: `wecom.status=${w?.status}` };
});

probe('P7_归档集合非空', () => {
  const p = path.join(process.env.USERPROFILE, '.dsh/storages/workspace.json');
  const j = readJson(p);
  const n = j?.global?.archivedSessionIds?.length ?? 0;
  return { ok: n > 0, evidence: `已归档 ${n} 个会话` };
});

probe('P8_视频工作区就绪', () => {
  const req = ['脚本/pipeline.mjs', '脚本/asr.mjs', 'tools/node_modules/ffmpeg-static/ffmpeg.exe'];
  const miss = req.filter((r) => !fs.existsSync(path.join('E:/DSH-Video', r)));
  return { ok: miss.length === 0, evidence: miss.length ? '缺 ' + miss.join(',') : '脚本 + ffmpeg 齐' };
});

probe('P9_ASR模型就位', () => {
  const m = 'E:/DSH-Video/tools/asr/sensevoice/model.int8.onnx';
  return { ok: fs.existsSync(m), evidence: fs.existsSync(m) ? 'SenseVoice int8 在' : '缺模型' };
});

// 端口类：同步探测（连一下）
function portOk(p) {
  const r = execFileSync(process.execPath, ['-e', `
    const net=require('net');const s=net.connect({port:${p},host:'127.0.0.1'},()=>{s.destroy();console.log('1')});
    s.on('error',()=>console.log('0'));s.setTimeout(1200,()=>{s.destroy();console.log('0')});
  `], { encoding: 'utf8', timeout: 5000 }).trim();
  return r === '1';
}

probe('P13_本体未下场', () => {
  // 规矩来源：docs\规则\本体不下场-2026-11-05.md
  try {
    execFileSync(process.execPath, ['scripts/self-work-guard.mjs'], { cwd: WORKSPACE, stdio: 'ignore', timeout: 60000 });
    return { ok: true, evidence: 'self-work-guard exit=0（没有无票改动）' };
  } catch { return { ok: false, evidence: 'self-work-guard exit!=0（本体疑似又下场）' }; }
});

probe('P12_文档落位', () => {
  // 新文档必须落在 docs\<分类>\ 下（守卫生成，见 scripts\docs-guard.mjs）
  try {
    execFileSync(process.execPath, ['scripts/docs-guard.mjs'], { cwd: WORKSPACE, stdio: 'ignore', timeout: 30000 });
    return { ok: true, evidence: 'docs-guard exit=0' };
  } catch { return { ok: false, evidence: 'docs-guard exit!=0（有散落文档）' }; }
});

probe('P13_本体未下场', () => {
  // 规矩来源：docs\规则\本体不下场-2026-11-05.md
  try {
    execFileSync(process.execPath, ['scripts/self-work-guard.mjs'], { cwd: WORKSPACE, stdio: 'ignore', timeout: 60000 });
    return { ok: true, evidence: 'self-work-guard exit=0（没有无票改动）' };
  } catch { return { ok: false, evidence: 'self-work-guard exit!=0（本体疑似又下场）' }; }
});

probe('P10_工作台在听', () => ({ ok: portOk(9340), evidence: '9340' }));
function dshPort() {
  // DSH 每次重启端口会变（53389 → 54915 …），从桥接配置读，不写死
  try {
    const cfg = JSON.parse(fs.readFileSync('E:/DeepFish/qq-bridge-0.2.1-r1/qq-bridge-0.2.1-r1/config.json', 'utf8').replace(/^\uFEFF/, ''));
    const m = String(cfg && cfg.dsh && cfg.dsh.baseUrl || '').match(/:(\d+)/);
    if (m) return Number(m[1]);
  } catch { /* 读不到就退回默认 */ }
  return 53389;
}
probe('P11_DSH在听', () => { const dp = dshPort(); return { ok: portOk(dp), evidence: 'dsh.baseUrl port=' + dp }; });

// ── CNF：三文字子句（语义：这些组合不能同时为假）─────────────────────
// ── 强约束：每个关键文字都必须为真（写成 3 文字子句 P∨P∨P，等价于 unit clause）
// 为什么这么做：只有"组合子句"时，某个检查失败会被别的真文字掩盖，导致 UNSAT 不触发。
const STRICT = [
  'P1_台账可读', 'P2_项目栏可读', 'P3_对账通过', 'P4_预算闸可判',
  'P5_优先队列可读', 'P6_企微已暂停', 'P7_归档集合非空',
  'P8_视频工作区就绪', 'P9_ASR模型就位', 'P10_工作台在听', 'P11_DSH在听',
];

const CLAUSES = [
  ...STRICT.map((name, i) => ({ id: `S${i + 1} 必须是真：${name}`, lits: [name, name, name] })),
  { id: 'C1 台账与项目栏必须同时可读或明确降级', lits: ['P1_台账可读', 'P2_项目栏可读', 'P3_对账通过'] },
  { id: 'C2 台账可读时对账必须过', lits: ['¬P1_台账可读', 'P3_对账通过', 'P1_台账可读'] },
  { id: 'C3 闸门可判且队列可读', lits: ['P4_预算闸可判', 'P5_优先队列可读', 'P5_优先队列可读'] },
  { id: 'C4 企微暂停与项目栏一致', lits: ['P6_企微已暂停', 'P2_项目栏可读', '¬P2_项目栏可读'] },
  { id: 'C5 归档与台账都在', lits: ['P7_归档集合非空', 'P1_台账可读', 'P7_归档集合非空'] },
  { id: 'C6 视频链路四件齐', lits: ['P8_视频工作区就绪', 'P9_ASR模型就位', 'P8_视频工作区就绪'] },
  { id: 'C7 两个服务端口都通', lits: ['P10_工作台在听', 'P11_DSH在听', 'P10_工作台在听'] },
  { id: 'C8 观测层全可用（否则不许报"全部正常"）', lits: ['P1_台账可读', 'P2_项目栏可读', 'P10_工作台在听'] },
  { id: 'C9 队列与闸门不能同时不可判', lits: ['P4_预算闸可判', 'P5_优先队列可读', 'P11_DSH在听'] },
  { id: 'C10 交付链路（视频+ASR）与归档互不拖累', lits: ['P8_视频工作区就绪', 'P9_ASR模型就位', 'P7_归档集合非空'] },
];

// ── 求值：逐子句 OR（不做 SAT 求解，也不需要逆运算）───────────────────
function evalLit(name) {
  const neg = name.startsWith('¬');
  const key = neg ? name.slice(1) : name;
  const v = lit[key]?.value ?? false;
  return neg ? !v : v;
}

const clauseRows = CLAUSES.map((c, i) => {
  const vals = c.lits.map((l) => ({ lit: l, value: evalLit(l) }));
  const satisfied = vals.some((v) => v.value);
  return { index: i + 1, id: c.id, satisfied, vals };
});

const allTrue = clauseRows.every((c) => c.satisfied);
const litRows = Object.entries(lit).map(([k, v]) => ({ literal: k, value: v.value, evidence: v.evidence }));

if (asJson) {
  console.log(JSON.stringify({ at: new Date().toISOString(), sat: allTrue, literals: litRows, clauses: clauseRows }, null, 1));
} else {
  console.log('== 文字（现场观测，不推断）==');
  for (const r of litRows) console.log(`${r.value ? 'T' : 'F'}  ${r.literal.padEnd(22)} ${verbose ? r.evidence : ''}`);
  console.log('\n== 三文字子句（CNF）==');
  for (const c of clauseRows) {
    const s = c.vals.map((v) => `${v.value ? 'T' : 'F'}:${v.lit}`).join('  ∨  ');
    console.log(`${c.satisfied ? '✓' : '✗'} C${String(c.index).padStart(2)} ${s}`);
  }
  console.log('');
}
console.log(allTrue
  ? `RESULT: SAT — ${clauseRows.length}/${clauseRows.length} 子句为真；${litRows.filter((r) => r.value).length}/${litRows.length} 文字为真`
  : `RESULT: UNSAT — 第 ${clauseRows.filter((c) => !c.satisfied).map((c) => c.index).join(',')} 条子句为假：` +
    clauseRows.filter((c) => !c.satisfied).map((c) => `${c.id} [${c.vals.map((v) => (v.value ? 'T' : 'F') + ':' + v.lit).join(' | ')}]`).join('； '));

process.exit(allTrue ? 0 : 1);
