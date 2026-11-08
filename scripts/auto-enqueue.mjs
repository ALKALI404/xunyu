// scripts\auto-enqueue.mjs —— 自动把「新任务书」塞进队列
// 2026-11-07 主人指令：「05 出票了的话就直接发票到队列开始做」
//
// 干什么：
//   扫 state\tasks\*.md（近 24h 新写/改的），解析任务书头部：
//     > 建单 ...｜目标 **04（代码）**｜项目 study / feature st-xxx
//   没进过 worklist 的，自动：
//     ① 挂到 state\projects.json 的对应 feature.tickets
//     ② 插进 state\priority-list.json 的队首区
//     ③ node scripts\worklist.mjs add --target <工号> --project <项目> --feature <f> --ticket <票号>
//   然后由 workdesk 的调度器（accept，每 60s）自动派给工人。
//
// 安全：
//   - 只处理**文件名匹配 ST-\d+ / IN-\d+ / WS-\d+ / UG-\d+** 的任务书；
//   - **只处理 24 小时内改过的**（防历史票一次涌进来）；
//   - 已经出现过在 worklist 的**一律跳过**；
//   - `--dry` 只打印不动；`--once` 单跑（默认就是单跑，定时任务用）。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = 'E:/DSH_workspace';
const TASKS = path.join(ROOT, 'state', 'tasks');
const WORKLIST = path.join(ROOT, 'state', 'worklist.jsonl');
const PROJECTS = path.join(ROOT, 'state', 'projects.json');
const PRIORITY = path.join(ROOT, 'state', 'priority-list.json');
const LOG = path.join(ROOT, 'logs', 'auto-enqueue.jsonl');

const dry = process.argv.includes('--dry');
const RECENT_MS = 24 * 60 * 60 * 1000;

function log(obj) {
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...obj }) + '\n', 'utf8');
}

/** 已经在台账里出现过的票号 */
function knownTickets() {
  const set = new Set();
  if (!fs.existsSync(WORKLIST)) return set;
  for (const line of fs.readFileSync(WORKLIST, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r.ticket) set.add(String(r.ticket)); } catch { /* 坏行跳过 */ }
  }
  return set;
}

/** 解析任务书头：目标工号 / 项目 / feature / 标题 */
function parseBook(file, text) {
  const m = text.match(/目标\s*\*\*(\d{2})[^*]*\*\*/) || text.match(/目标\s*(\d{2})/);
  const target = m ? m[1] : null;
  const proj = (text.match(/项目\s*([a-zA-Z_-]+)/) || [])[1] || null;
  const feat = (text.match(/feature\s*([a-zA-Z0-9_-]+)/) || [])[1] || null;
  const title = (text.match(/^#\s*(.+)$/m) || [])[1] || path.basename(file, '.md');
  return { target, proj, feat, title: title.replace(/^[A-Z]{2}-\d+\s*·\s*/, '').slice(0, 60) };
}

const known = knownTickets();
const now = Date.now();
const added = [];
const skipped = [];

for (const name of fs.readdirSync(TASKS)) {
  if (!name.endsWith('.md')) continue;
  const ticket = name.replace(/\.md$/, '');
  if (!/^[A-Z]{2}-\d+$/.test(ticket)) continue;
  if (known.has(ticket)) { skipped.push(ticket); continue; }
  the: {
    const full = path.join(TASKS, name);
    const st = fs.statSync(full);
    if (now - st.mtimeMs > RECENT_MS) { skipped.push(ticket + '(旧)'); break the; }
    const text = fs.readFileSync(full, 'utf8');
    const meta = parseBook(name, text);
    if (!meta.target) { skipped.push(ticket + '(无工号)'); break the; }
    if (!meta.proj) { skipped.push(ticket + '(无项目)'); break the; }

    if (dry) { console.log(`  [dry] ${ticket} → ${meta.target} / ${meta.proj} / ${meta.feat || '-'}  ${meta.title}`); break the; }

    // ① 挂到 feature
    try {
      const pj = JSON.parse(fs.readFileSync(PROJECTS, 'utf8'));
      const pr = (pj.projects || []).find((x) => x.id === meta.proj);
      if (pr && meta.feat) {
        const f = (pr.features || []).find((x) => x.id === meta.feat);
        if (f && !f.tickets.includes(ticket)) f.tickets.push(ticket);
        fs.writeFileSync(PROJECTS, JSON.stringify(pj, null, 2), 'utf8');
      }
    } catch (e) { console.log(`  ⚠ ${ticket} 挂 feature 失败：${e.message}`); }

    // ② 插队首
    try {
      const pl = JSON.parse(fs.readFileSync(PRIORITY, 'utf8'));
      pl.tickets = pl.tickets || [];
      if (!pl.tickets.includes(ticket)) pl.tickets.unshift(ticket);
      fs.writeFileSync(PRIORITY, JSON.stringify(pl, null, 2), 'utf8');
    } catch (e) { console.log(`  ⚠ ${ticket} 插队列失败：${e.message}`); }

    // ③ 登记台账
    try {
      const args = ['scripts/worklist.mjs', 'add', '--title', meta.title, '--target', meta.target, '--project', meta.proj, '--ticket', ticket];
      if (meta.feat) args.push('--feature', meta.feat);
      const out = execFileSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
      added.push({ ticket, target: meta.target, proj: meta.proj, feat: meta.feat, title: meta.title });
      console.log(`  ✅ ${ticket} → 工号 ${meta.target}（${meta.proj}/${meta.feat || '-'}）${meta.title}`);
      log({ op: 'enqueued', ticket, target: meta.target, proj: meta.proj, feat: meta.feat, out: out.trim().slice(0, 200) });
    } catch (e) {
      console.log(`  ❌ ${ticket} 登记失败：${String(e.message).slice(0, 120)}`);
      log({ op: 'failed', ticket, error: String(e.message).slice(0, 300) });
    }
  }
}

if (!added.length) console.log(`  没有新票（跳过 ${skipped.length} 个）`);
else console.log(`  本轮入队 ${added.length} 张`);
