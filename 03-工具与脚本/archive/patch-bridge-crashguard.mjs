// 桥接崩溃兜底 + 修「error {}」这种没法读的日志
// 主人已批：uncaughtException / unhandledRejection 落盘到 state\bridge-crash.log
import fs from 'node:fs';

const B = 'E:/DeepFish/qq-bridge-0.2.1-r1/qq-bridge-0.2.1-r1/src/bridge.js';
const WRITE = process.argv.includes('--write');
let src = fs.readFileSync(B, 'utf8');

const anchor = `const BRIDGE_LOG = path.join(STATE_DIR, 'bridge.log');`;

const injection = `const BRIDGE_LOG = path.join(STATE_DIR, 'bridge.log');
const CRASH_LOG = path.join(STATE_DIR, 'bridge-crash.log');

// ── 崩溃兜底（2026-10-25）──────────────────────────────────────────────────
// 之前进程莫名退出时，栈只打到隐藏控制台（start.bat 起的窗口），日志里什么都看不到 ——
// 所以「没有任何错误输出」并不代表没崩。从这里开始，崩溃/未处理拒绝/退出码一律落盘。
const describeErr = (e) => {
  if (e == null) return '(无详情)';
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.stack || e.message || e.name || '(空 Error)';
  try {
    const s = JSON.stringify(e);
    return s && s !== '{}' ? s : '(空对象，无错误信息)';
  } catch {
    return String(e);
  }
};
function crashLog(kind, extra = '') {
  try {
    fs.appendFileSync(CRASH_LOG, \`\\n=== \${new Date().toISOString()} [\${kind}] pid=\${process.pid} \${extra} ===\\n\`, 'utf8');
  } catch {}
}
process.on('uncaughtException', (err) => {
  crashLog('uncaughtException', describeErr(err));
  try { console.error(err); } catch {}
  process.exit(1);
});
// 未处理拒绝：**不退出**，只落盘 —— Node 默认会因此结束进程，那正是「重启循环」的典型成因。
process.on('unhandledRejection', (reason, promise) => {
  crashLog('unhandledRejection', describeErr(reason));
  try { console.error('[unhandledRejection]', reason); } catch {}
});
process.on('exit', (code) => {
  crashLog('exit', \`退出码=\${code}\`);
});
// 明显属于「有人主动关了它」的信号，也留痕，便于区分自杀/他杀。
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  try { process.on(sig, () => { crashLog('signal', sig); }); } catch {}
}`;

const patches = [
  { name: 'C1 崩溃兜底 + 错误描述工具', from: anchor, to: injection },
  {
    name: 'C2 自愈日志不再打 {}',
    from: 'log(`   自愈完成：账号 ${r.self?.user_id ?? \'?\'}（${reason}）`);',
    to: 'log(`   自愈完成：账号 ${r.self?.user_id ?? \'?\'}（${describeErr(reason)}）`);'
  },
  {
    name: 'C3 SnowLuma 错误日志用 describeErr',
    from: 'log(`SnowLuma 错误：${detail || \'(无详情)\'}`);',
    to: 'log(`SnowLuma 错误：${describeErr(detail)}`);'
  }
];

let ok = true;
for (const p of patches) {
  const n = src.split(p.from).length - 1;
  console.log(`${n === 1 ? '✅' : '❌'} ${p.name}：${n} 处`);
  if (n !== 1) { ok = false; continue; }
  src = src.split(p.from).join(p.to);
}
if (!ok) { console.log('🛑 锚点不对，未写盘'); process.exit(2); }
if (!WRITE) { console.log('✅ dry-run 通过'); process.exit(0); }
fs.writeFileSync(B, src, 'utf8');
console.log('✍️  已写 bridge.js');
