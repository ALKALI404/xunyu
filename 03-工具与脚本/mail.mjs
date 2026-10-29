// 邮件池：agent 之间的日常通信，不占 DSH 会话、不唤醒、不烧 token
//
// 2026-10-28 主人定：邮件池放进 DeepFish 记忆模块（鲟鱼 memory 下），不再放 DSH_workspace\state。
//
// 用法：
//   node scripts\mail.mjs post --to 01 --from 本体 --body "..."  [--level 通知|活]
//   node scripts\mail.mjs read --as 01            # 读自己的未读（读完标记水位）
//   node scripts\mail.mjs read --as 01 --peek     # 只读不标记
//   node scripts\mail.mjs list [--all]            # 看最近 20 条
//   node scripts\mail.mjs tail --as 01            # 只看未读数
//
// 存储：<Xunyu根>\memory\mail\mailbox.jsonl（追加写，一行一条）
// 水位：<Xunyu根>\memory\mail\<agent>.read（存已读 seq）
import fs from 'node:fs';
import path from 'node:path';

const BOX = 'E:/DeepFish/Xunyu/memory/mail';
const FILE = path.join(BOX, 'mailbox.jsonl');
fs.mkdirSync(BOX, { recursive: true });

const argv = process.argv.slice(2);
const cmd = argv[0] || 'list';
const opt = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const flag = (name) => argv.includes('--' + name);

const readAll = () => fs.existsSync(FILE)
  ? fs.readFileSync(FILE, 'utf8').split(/\r?\n/).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
  : [];
const seqFile = (agent) => path.join(BOX, `${agent}.read`);
const readSeq = (agent) => {
  try { return Number(fs.readFileSync(seqFile(agent), 'utf8').trim()) || 0; } catch { return 0; }
};

if (cmd === 'post') {
  const to = String(opt('to', '')).trim();
  const from = String(opt('from', '本体')).trim();
  const body = String(opt('body', '')).trim();
  const level = String(opt('level', '通知')).trim();
  if (!to || !body) { console.error('用法：post --to <agent> --body <文本> [--from x] [--level 通知|活]'); process.exit(2); }
  const all = readAll();
  const seq = (all.length ? all[all.length - 1].seq : 0) + 1;
  const rec = { seq, t: Date.now(), from, to, level, body };
  fs.appendFileSync(FILE, JSON.stringify(rec) + '\n');
  console.log(`已投 seq=${seq} → ${to}（${level}）`);
  process.exit(0);
}

if (cmd === 'read') {
  const me = String(opt('as', '')).trim();
  if (!me) { console.error('用法：read --as <agent> [--peek]'); process.exit(2); }
  const since = readSeq(me);
  const mine = readAll().filter((r) => r.to === me && r.seq > since);
  if (!mine.length) { console.log(`（${me} 没有未读）`); process.exit(0); }
  for (const r of mine) {
    const when = new Date(r.t).toLocaleString('zh-CN', { hour12: false });
    console.log(`#${r.seq} ${when} from ${r.from} [${r.level}]\n${r.body}\n`);
  }
  if (!flag('peek')) fs.writeFileSync(seqFile(me), String(mine[mine.length - 1].seq));
  process.exit(0);
}

if (cmd === 'tail') {
  const me = String(opt('as', '')).trim();
  const n = readAll().filter((r) => r.to === me && r.seq > readSeq(me)).length;
  console.log(`${me || '?'} 未读 ${n} 条`);
  process.exit(0);
}

const all = readAll();
const show = flag('all') ? all : all.slice(-20);
for (const r of show) {
  const when = new Date(r.t).toLocaleString('zh-CN', { hour12: false });
  console.log(`#${r.seq} ${when} ${r.from} → ${r.to} [${r.level}] ${String(r.body).slice(0, 60).replace(/\n/g, ' ')}`);
}
console.log(`共 ${all.length} 条，目录 ${BOX}`);
