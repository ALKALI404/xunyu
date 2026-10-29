#!/usr/bin/env node
/**
 * 换代残留绑定扫描器（2026-10-27 立）
 *
 * 为什么要有它：2026-10-26 换代时，前代 df6c9f3e 被归档后，仍有三处**活绑定**指着他，
 * 直接导致「QQ 能收不能发」——桥接把回复交给一个已归档的会话去转述，对方再也不会跑回合。
 * 结论：**归档一个还在链路上的会话 = 拆一段活线。** 归档前必须跑这个脚本。
 *
 * 用法：
 *   node scripts/scan-stale-bindings.mjs                 # 用 workspace.json 里最近归档的 3 个 id
 *   node scripts/scan-stale-bindings.mjs <sid> [<sid>]   # 指定要查的旧会话 id
 *
 * 退出码：0 = 只命中历史记录（安全）；1 = 仍有活绑定指向旧会话；2 = 脚本自身出错。
 */

import fs from 'node:fs';
import path from 'node:path';

const HOME = process.env.USERPROFILE || process.env.HOME || '';
const BRIDGE = 'E:\\DeepFish\\qq-bridge-0.2.1-r1\\qq-bridge-0.2.1-r1';
const AVATAR = 'E:\\DeepFish\\avatar';
const WORKSPACE = '<工作区>';
const RELAY = 'http://127.0.0.1:9334';
const SCHEDULE = path.join(HOME, '.dsh', 'storages', 'schedule.json');
const WS_STORE = path.join(HOME, '.dsh', 'storages', 'workspace.json');

const readJson = (p) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
};
const short = (id) => String(id ?? '').replace(/^session-/, '').slice(0, 8);

/** 默认要查的 id：workspace.json 里最后归档的 3 个 */
function archivedIds() {
  const ws = readJson(WS_STORE);
  const list = ws?.global?.archivedSessionIds ?? ws?.archivedSessionIds ?? [];
  return list.slice(-3);
}

const targets = process.argv.slice(2).filter((a) => /^session-/.test(a));
const ids = targets.length ? targets : archivedIds();
if (!ids.length) {
  console.log('没给旧会话 id，也没在 workspace.json 里找到归档记录。用法：node scripts/scan-stale-bindings.mjs <sessionId>');
  process.exit(2);
}
const archivedSet = new Set(ids);

const live = [];   // 活绑定：会影响运行
const hist = [];   // 历史引用：只做记录，不影响运行

// ── 1. 桥接的 QQ 会话映射（出站就靠它，2026-10-26 就死在这里） ──
{
  const p = path.join(BRIDGE, 'state', 'sessions.json');
  const j = readJson(p);
  for (const [key, sid] of Object.entries(j?.sessions ?? {})) {
    if (archivehit(sid)) live.push({ where: `${p} → sessions["${key}"]`, id: sid, fix: '改成当前本体会话；或让桥接退役重建' });
  }
}

// ── 2. body/owner 会话登记 ──
{
  const p = path.join(AVATAR, 'state', 'owner-session.json');
  const j = readJson(p);
  if (j?.sessionId && archivehit(j.sessionId)) live.push({ where: `${p} → sessionId`, id: j.sessionId, fix: '改指当前本体' });
}

// ── 3. 桥接配置里的默认目标 / 关注列表 ──
{
  const p = path.join(BRIDGE, 'config.json');
  const j = readJson(p);
  const dt = j?.dshShout?.defaultTarget;
  if (dt && archivehit(dt)) live.push({ where: `${p} → dshShout.defaultTarget`, id: dt, fix: '清空或改指当前会话（建议留空走 auto）' });
  // 2026-10-27 补：QQ 私聊入站目标。当天归档 0e5b15ad 时它仍指着旧本体，
  // 而这里没查 → 扫描器放行、归档照做，等于把 10-26「能收不能发」原地复现一次。
  const opt = j?.dshShout?.ownerPrivateTarget;
  if (opt && archivehit(opt)) live.push({ where: `${p} → dshShout.ownerPrivateTarget`, id: opt, fix: '改指当前本体会话（QQ 私聊入站目标）' });
  for (const sid of j?.dshShout?.watchSessions ?? []) {
    if (archivehit(sid)) live.push({ where: `${p} → dshShout.watchSessions[]`, id: sid, fix: '从关注列表移除' });
  }
}

// ── 4. 中继 targets（运行时，重启会从默认值回弹，最容易漏） ──
async function checkRelay() {
  try {
    const r = await fetch(`${RELAY}/health`, { signal: AbortSignal.timeout(3000) });
    const h = await r.json();
    for (const [name, v] of Object.entries(h?.targets ?? {})) {
      if (archivehit(v?.sessionId)) live.push({ where: `${RELAY} targets.${name}（运行时）`, id: v.sessionId, fix: `POST /rebind {target:"${name}", sessionId:"<当前本体>"}` });
    }
  } catch {
    hist.push({ where: `${RELAY} targets`, id: '（中继没起，跳过）', note: '中继不可达，无法检查运行时绑定' });
  }
}

// ── 5. DSH 定时任务（归档前必须先迁或删，否则 session-active (schedule) 直接拦住归档） ──
{
  const j = readJson(SCHEDULE);
  const tasks = j?.tables?.tasks ?? {};
  for (const [id, v] of Object.entries(tasks)) {
    const sid = v?.sessionId;
    const title = v?.record?.title ?? '';
    if (sid && archivehit(sid)) live.push({ where: `${SCHEDULE} → ${title}（${id.slice(9, 17)}）`, id: sid, fix: '先迁到当前会话再删旧的；不迁就归档不了' });
    else if (typeof v?.record?.prompt === 'string' && ids.some((x) => v.record.prompt.includes(x))) {
      hist.push({ where: `${SCHEDULE} → ${title} 的 prompt 正文`, id: '（文本提及）', note: '只是提示词里提到，不是绑定' });
    }
  }
}

// ── 6. 台账类：只统计，不报错（历史原文不追改） ──
{
  for (const p of [path.join(WORKSPACE, 'state', 'roster.json'), path.join(WORKSPACE, 'state', 'handoff.json')]) {
    const t = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    if (!t) continue;
    const n = ids.reduce((acc, id) => acc + (t.split(id).length - 1), 0);
    if (n) hist.push({ where: path.relative(WORKSPACE, p), id: `${n} 次`, note: '历史/审计字段（previousSessionId、history），不算活绑定' });
  }
}

function archivehit(sid) {
  return typeof sid === 'string' && archivedSet.has(sid);
}

await checkRelay();

const line = (c) => console.log(c);
line('');
line(`== 换代残留绑定扫描 ==  查的旧会话：${ids.map(short).join(', ')}`);
line('');
if (live.length) {
  line(`✗ 活绑定 ${live.length} 处（必须先修，否则换代后必坏一处）：`);
  for (const x of live) line(`  · ${x.where}\n      ↳ 指向 ${short(x.id)}　修法：${x.fix}`);
} else {
  line('✓ 活绑定 0 处：没有仍在链路上的旧会话引用。');
}
if (hist.length) {
  line('');
  line(`· 历史引用 ${hist.length} 处（不需要改，只作记录）：`);
  for (const x of hist) line(`  · ${x.where} → ${x.id}　${x.note ?? ''}`);
}
line('');
process.exit(live.length ? 1 : 0);
