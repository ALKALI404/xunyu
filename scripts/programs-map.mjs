// scripts\programs-map.mjs —— 把 .mjs 按"角色"分组，并画出"谁调谁 / 谁在跑 / 占哪个端口"
//
// 产出三样：
//   docs\程序地图.md              人类看的：分组表 + 依赖 + 端口
//   state\processes-snapshot.json  机器看的：当前 node 进程 → 脚本 → 端口
//   docs\重启清单.md              停用后按顺序拉起的命令（含期望结果）
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const WORKSPACE = 'E:/DSH_workspace';
const SCRIPTS = path.join(WORKSPACE, 'scripts');
const files = fs.readdirSync(SCRIPTS).filter((f) => f.endsWith('.mjs'));

// ── 分组规则（按名字前缀/职责，写死在代码里）────────────────────────
const GROUPS = [
  { id: 'A-状态机核心', match: /^(worklist-core|worklist|dispatch-core|lane-runner|check-delivery|pr-reconcile|projects-sync|mistakes-sync|rotate|handoff)/, desc: '工单状态、派发、验收、交接的唯一真相' },
  { id: 'B-常驻服务', match: /^(workdesk-server|workdesk|acceptance-watch|wecom-supervisor|wecom-ingest-tess|wecom-dispatch|wecom-chat-bridge|wecom-tunnel|relay)/, desc: '长期跑着的进程（带端口/定时）' },
  { id: 'C-企微链路', match: /^(wecom-|vm-sender)/, desc: '企微采集/发送/接口（项目已暂停）' },
  { id: 'D-体检与探针', match: /^(health|steady-board|self-heal|module-doctor|programs-status|programs-map|blame|cert-watch|untracked-watch|tmp-guard|context-report|check-context)/, desc: '观察系统、不改变业务状态' },
  { id: 'E-计费与额度', match: /^(cost|budget)/, desc: '花钱与配额' },
  { id: 'F-工具库', match: /^(json-io|now|mail|scheduler|delivery-check|prompt-lint|diag|scan-)/, desc: '被到处引用的小工具' },
  { id: 'G-一次性/演练', match: /^(relay04|test-|tmp-|fix-|_|probe-|drill|migrate-schedules)/, desc: '用完即弃，应归档' },
  { id: 'H-会话与名册', match: /^(create-xunyu-session|create-body-session|new-workgroup-session|roster-lock|read-session-log)/, desc: '建会话/改名册（会动状态，慎用）' },
  { id: 'I-环境守卫', match: /^(encoding-scan|read-text|check-json-bom|check-hardcoded-ports|dsh-base)/, desc: '编码/BOM/端口这类"卫生检查"' },
  { id: 'J-打包与内省', match: /^(build-exe|asar-extract|asar-list|collect-repo)/, desc: 'Node SEA 打包、asar 读取、仓库收集' },
  { id: 'K-体检小件', match: /^(state-check|orphan-check|measure-mcp-tools|token-report)/, desc: '单项观察，不改变状态' },
  { id: 'M-检索与杂项', match: /^(find|peek|findings-sync|build-wg-tier-presets)/, desc: '检索/落库/预设生成' },
];

const groupOf = (f) => (GROUPS.find((g) => g.match.test(f)) ?? { id: 'Z-未分类', desc: '未归类' });

// ── 反向依赖 ───────────────────────────────────────────────────────
const importers = new Map();
for (const f of files) {
  const txt = fs.readFileSync(path.join(SCRIPTS, f), 'utf8');
  for (const m of txt.matchAll(/from\s+['"]\.\/([\w.-]+\.mjs)['"]/g)) {
    if (!importers.has(m[1])) importers.set(m[1], new Set());
    importers.get(m[1]).add(f);
  }
}

// ── 进程与端口 ─────────────────────────────────────────────────────
let procs = [];
try {
  const out = execFileSync('powershell', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object { $_.ProcessId.ToString() + '|' + $_.CommandLine }"],
    { encoding: 'utf8', timeout: 30000 });
  procs = out.split(/\r?\n/).filter(Boolean).map((l) => { const i = l.indexOf('|'); return { pid: l.slice(0, i), cmd: l.slice(i + 1) }; });
} catch { procs = []; }

let ports = [];
try {
  const out = execFileSync('powershell', ['-NoProfile', '-Command',
    "Get-NetTCPConnection -State Listen | ForEach-Object { $_.LocalPort.ToString() + '|' + $_.OwningProcess }"],
    { encoding: 'utf8', timeout: 30000 });
  ports = out.split(/\r?\n/).filter(Boolean).map((l) => { const [p, pid] = l.split('|'); return { port: Number(p), pid }; });
} catch { }

const procFor = (f) => procs.filter((p) => p.cmd.includes(f));
const portsFor = (f) => {
  const ps = procFor(f).map((p) => p.pid);
  return ports.filter((x) => ps.includes(String(x.pid))).map((x) => x.port);
};

function purpose(file) {
  const txt = fs.readFileSync(path.join(SCRIPTS, file), 'utf8').slice(0, 1200);
  for (const ln of txt.split(/\r?\n/)) {
    const m = ln.match(/^\s*\/\/\s*(?:scripts[\\/])?[\w.-]*\.mjs\s*[—-]+\s*(.+)$/);
    if (m) return m[1].trim();
  }
  const first = txt.split(/\r?\n/).find((l) => /^\s*\/\//.test(l) && l.replace(/^\s*\/\/\s*/, '').length > 6);
  return first ? first.replace(/^\s*\/\/\s*/, '').trim().slice(0, 70) : '(无说明)';
}

// ── 组装 ───────────────────────────────────────────────────────────
const rows = files.map((f) => ({
  file: f,
  group: groupOf(f).id,
  purpose: purpose(f),
  importers: [...(importers.get(f) ?? [])],
  pids: procFor(f).map((p) => p.pid),
  ports: portsFor(f),
  sizeKB: Number((fs.statSync(path.join(SCRIPTS, f)).size / 1024).toFixed(1)),
}));

// ── 输出 1：程序地图 ───────────────────────────────────────────────
const gs = [...new Set(rows.map((r) => r.group))].sort();
const md = ['# 程序地图 · 分组与依赖', '', `> 生成于 ${new Date().toISOString()}｜${rows.length} 个 .mjs｜node 进程 ${procs.length} 个｜监听端口 ${ports.length} 个`, ''];
for (const g of gs) {
  const list = rows.filter((r) => r.group === g);
  const meta = GROUPS.find((x) => x.id === g) ?? { desc: '' };
  md.push(`## ${g}（${list.length} 个）`, '', `> ${meta.desc}`, '', '| 程序 | 负责什么 | 被谁调用 | 进程 | 端口 |', '|---|---|---|---|---|');
  for (const r of list.sort((a, b) => b.sizeKB - a.sizeKB)) {
    md.push(`| \`${r.file}\` | ${r.purpose.replace(/\|/g, '/')} | ${r.importers.length ? r.importers.slice(0, 2).map((x) => '`' + x + '`').join('、') : '—'} | ${r.pids.join(',') || '—'} | ${r.ports.join(',') || '—'} |`);
  }
  md.push('');
}
fs.writeFileSync(path.join(WORKSPACE, 'docs/程序地图.md'), md.join('\n'), 'utf8');

// ── 输出 2：进程快照 ───────────────────────────────────────────────
fs.writeFileSync(path.join(WORKSPACE, 'state/processes-snapshot.json'), JSON.stringify({
  at: new Date().toISOString(),
  nodeProcs: procs.map((p) => ({ pid: p.pid, cmd: p.cmd.slice(0, 200) })),
  listening: ports,
  scripts: rows.map((r) => ({ file: r.file, group: r.group, pids: r.pids, ports: r.ports })),
}, null, 1), 'utf8');

// ── 输出 3：重启清单（停用后按这个顺序拉）─────────────────────────
const live = rows.filter((r) => r.pids.length);
const order = ['workdesk-server.mjs', 'relay.mjs', 'acceptance-watch.mjs', 'bridge.js（在 qq-bridge 目录：node src\\bridge.js）'];
const rs = ['# 重启清单（停用后按顺序拉起）', '', `> 快照 ${new Date().toISOString()}`, '', '| 序 | 命令 | 期望 |', '|---|---|---|',
  '| 1 | `cd E:\\DSH_workspace; node scripts\\workdesk-server.mjs` | 9340 在听，窗口/看板可用 |',
  '| 2 | `cd E:\\DSH_workspace; node scripts\\relay.mjs` | 日志出现「优先队列 active=true」 |',
  '| 3 | `cd E:\\DSH_workspace; node scripts\\acceptance-watch.mjs` | 每 10 分钟扫一次待验收 |',
  '| 4 | `cd E:\\DeepFish\\qq-bridge-0.2.1-r1\\qq-bridge-0.2.1-r1; node src\\bridge.js` | 3100 在听，SnowLuma 自愈 |',
  '| 5 | `cd E:\\DSH_workspace; node scripts\\health-3sat.mjs` | 最后一行 `RESULT: SAT` |',
  '',
  '## 当前在跑的（停用前请确认要不要保留）', ''];
for (const r of live) rs.push(`- ${r.pids.join(',')}  \`${r.file}\`${r.ports.length ? '（端口 ' + r.ports.join(',') + '）' : ''}`);
rs.push('', '## 不能停的', '', '- **DSH 本体**（53389，正在跟你对话的进程）', '- 若停工作台，窗口/看板会不可用；若停 QQ 桥，QQ 会断线。');
fs.writeFileSync(path.join(WORKSPACE, 'docs/重启清单.md'), rs.join('\n'), 'utf8');

// ── 控制台摘要 ─────────────────────────────────────────────────────
console.log(`分组：${gs.length} 组 / ${rows.length} 个 .mjs / 在跑 ${live.length} 个`);
for (const g of gs) console.log(`  ${g}: ${rows.filter((r) => r.group === g).length}`);
console.log('\n在跑：');
for (const r of live) console.log(`  pid ${r.pids.join(',')} ${r.file}${r.ports.length ? ' :' + r.ports.join(',') : ''}`);
console.log('\n产出：docs\\程序地图.md ｜ state\\processes-snapshot.json ｜ docs\\重启清单.md');
