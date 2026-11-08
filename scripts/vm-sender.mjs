#!/usr/bin/env node
import { readJson } from './json-io.mjs';
// scripts/vm-sender.mjs —— 宿主侧发送器（WC-004，常驻 watcher 方案）
//
// 只做四件事：连通道（SSH 本地端口转发到 VM 的 127.0.0.1:8766）→ 发命令 → 等结果 → 写 outbox。
// VM 里有个常驻 watcher（scripts\vm\wecom-watch.ps1）长期持有企微 hwnd，窗口没了自己重找/拉起。
//
// 用法：
//   node scripts\vm-sender.mjs --conv "文件传输助手" --text "内容"
//   node scripts\vm-sender.mjs --conv "文件传输助手" --text "内容" --json
//   node scripts\vm-sender.mjs --conv "文件传输助手" --text "内容" --dry
//   node scripts\vm-sender.mjs --health              # 看 watcher 活着没、hwnd 是多少
//
// 退出码：0 发出去（前后 hash 不同）｜1 没发成（原因见 code）｜2 用法/通道错误

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, '..');
const OUTBOX = path.join(WORKSPACE, 'state', 'wecom-outbox.jsonl');
const CFG = path.join(WORKSPACE, 'state', 'wecom-vm.json');

const argv = process.argv.slice(2);
const opt = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const flag = (n) => argv.includes(`--${n}`);
const asJson = flag('json');
const dry = flag('dry');
const healthOnly = flag('health');
const conv = String(opt('conv', '') ?? '').trim();
const text = String(opt('text', '') ?? '');

const cfg = (() => {
  try { return readJson(CFG); } catch (e) {
    console.error(`✗ 读不到 ${CFG}：${e.message}`);
    process.exit(2);
  }
})();
const VM = String(cfg.vm.ssh);
const WATCH_PORT = Number(cfg.vm.watchPort ?? 8766);
const LOCAL_PORT = Number(cfg.vm.localPort ?? 18766);

function newId() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `wo-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${crypto.randomBytes(2).toString('hex')}`;
}
function appendOutbox(rec) {
  fs.mkdirSync(path.dirname(OUTBOX), { recursive: true });
  fs.appendFileSync(OUTBOX, `${JSON.stringify(rec)}\n`, 'utf8');
}

const waitPort = (port, ms = 8000) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const tick = () => {
    const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true); });
    s.on('error', () => {
      s.destroy();
      if (Date.now() - t0 > ms) reject(new Error(`本地转发端口 ${port} 没起来（SSH 隧道失败）`));
      else setTimeout(tick, 200);
    });
  };
  tick();
});

async function withTunnel(fn) {
  const args = ['-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=8',
    '-N', '-L', `${LOCAL_PORT}:127.0.0.1:${WATCH_PORT}`, VM];
  const child = spawn('ssh', args, { stdio: 'ignore' });
  let exited = false;
  child.on('exit', () => { exited = true; });
  try {
    await waitPort(LOCAL_PORT);
    return await fn();
  } finally {
    try { child.kill(); } catch { /* ignore */ }
    if (exited) { /* 已经退出 */ }
  }
}

async function call(pathname, body, ms = 90000) {
  const url = `http://127.0.0.1:${LOCAL_PORT}${pathname}`;
  const res = await fetch(url, {
    // 一定要有超时：VM 侧 handler 卡住时（例如逐像素数墨迹）前端不能陪它一起挂
    signal: AbortSignal.timeout(ms),
    ...(body
      ? { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(body) }
      : { method: 'GET' })
  });
  const txt = await res.text();
  try { return JSON.parse(txt); } catch { return { ok: false, code: 'bad-json', raw: txt.slice(0, 200) }; }
}

async function callBinary(pathname, outFile) {
  const res = await fetch(`http://127.0.0.1:${LOCAL_PORT}${pathname}`);
  const ct = String(res.headers.get('content-type') ?? '');
  const buf = Buffer.from(await res.arrayBuffer());
  if (!ct.startsWith('image/')) {
    const txt = buf.toString('utf8').slice(0, 300);
    throw new Error(`不是图片响应（${ct}）：${txt}`);
  }
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  fs.writeFileSync(path.resolve(outFile), buf);
  return { bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex'), path: path.resolve(outFile) };
}

const shotOut = opt('shot', null);
const bootstrapConv = opt('bootstrap', null);
const clearRefConv = opt('clear-ref', null);
const openConv = opt('open', null);
const searchConv = opt('search', null);
const clickAt = opt('clickat', null);
const keyVk = opt('key', null);
const confirmed = flag('confirm');
const geoOnly = flag('geometry');
const refsOnly = flag('refs');
const normOnly = flag('normalize');

async function main() {
  if (healthOnly) {
    const h = await withTunnel(() => call('/health'));
    out(h, `watcher: ${h.ok ? '在' : '不在'} hwnd=${h.hwnd ?? '—'} session=${h.session ?? '—'}`);
    return h.ok ? 0 : 1;
  }
  if (geoOnly) {
    const g = await withTunnel(() => call('/geometry'));
    out(g, `rect=${JSON.stringify(g.rect)} client=${JSON.stringify(g.client)} screen=${JSON.stringify(g.screen)} hwnd=${g.hwnd}`);
    return g.ok ? 0 : 1;
  }
  if (normOnly) {
    const n = await withTunnel(() => call('/normalize', {}));
    out(n, `窗口归位：ok=${n.ok} client=${JSON.stringify(n.client)} zoomed=${n.zoomed}`);
    return n.ok ? 0 : 1;
  }
  if (flag('windows')) {
    const w = await withTunnel(() => call('/windows'));
    if (asJson) out(w, '');
    else {
      console.log(`可见大窗口 ${w.count} 个：`);
      for (const x of w.windows ?? []) console.log(`  hwnd=${x.hwnd} class=${x.class} title=「${x.title}」 rect=${JSON.stringify(x.rect)}`);
    }
    return w.ok ? 0 : 1;
  }
  if (flag('clear-draft')) {
    const c = await withTunnel(() => call('/cleardraft', {}));
    if (shotOut) await withTunnel(() => callBinary('/shot.png', shotOut));
    out({ ...c, shotPath: shotOut ? path.resolve(shotOut) : null }, c.ok
      ? `✓ 输入框草稿已清空（没发送）${shotOut ? `｜截图 ${path.resolve(shotOut)}` : ''}`
      : `✗ 清草稿失败 [${c.code}]`);
    return c.ok ? 0 : 1;
  }
  if (flag('panel')) {
    const p = await withTunnel(() => call('/panel'));
    out(p, `类 ${p.class}：${p.count} 个句柄\n` + (p.windows ?? []).map((x) => `  hwnd=${x.hwnd} vis=${x.visible} cloak=${x.cloaked} really=${x.reallyVisible} rect=${JSON.stringify(x.rect)}`).join('\n'));
    return 0;
  }
  if (clickAt) {
    const [cx, cy] = String(clickAt).split(',').map((v) => Number(v));
    const c = await withTunnel(() => call('/clickat', { x: cx, y: cy }));
    if (shotOut) await withTunnel(() => callBinary('/shot.png', shotOut));
    out({ ...c, shotPath: shotOut ? path.resolve(shotOut) : null }, `点了 client(${cx},${cy}) → 屏幕(${c.clicked?.x},${c.clicked?.y})${shotOut ? `，截图 ${path.resolve(shotOut)}` : ''}`);
    return c.ok ? 0 : 1;
  }
  if (keyVk) {
    const k = await withTunnel(() => call('/key', { vk: Number(keyVk) }));
    out(k, `已发送按键 vk=${keyVk}`);
    return k.ok ? 0 : 1;
  }
  if (searchConv) {
    const s = await withTunnel(() => call('/search', { conv: searchConv }));
    if (shotOut) await withTunnel(() => callBinary('/shot.png', shotOut));
    const payload = { ...s, shotPath: shotOut ? path.resolve(shotOut) : null };
    out(payload, `搜索「${searchConv}」：框内粘贴=${s.searchBoxChanged ? '✓生效' : '✗没进去'} 下拉裁剪=${s.dropdownBytes} B`);
    return s.searchBoxChanged ? 0 : 1;
  }
  if (openConv) {
    // 只定位会话，不发消息。--shot 一起用就是"开完立刻看图"的那一步。
    const o = await withTunnel(() => call('/open', { conv: openConv }));
    if (shotOut) await withTunnel(() => callBinary('/shot.png', shotOut));
    const payload = { ...o, shotPath: shotOut ? path.resolve(shotOut) : null };
    out(payload, o.ok
      ? `✓ 已确认当前会话是「${openConv}」（标题条指纹一致）`
      : `✗ 没能确认会话 [${o.code}] ${o.why ?? ''}${shotOut ? `｜截图：${path.resolve(shotOut)}` : ''}`);
    return o.ok ? 0 : 1;
  }
  if (refsOnly) {
    const r = await withTunnel(() => call('/refs'));
    if (asJson) out(r, '');
    else {
      const list = r?.refs ?? [];
      console.log(`已存指纹 ${list.length} 条：`);
      for (const x of list) console.log(`  「${x.conv}」 bytes=${x.bytes} at=${x.at} sha=${String(x.sha256).slice(0, 16)}…`);
      if (!list.length) console.log('  （空）');
    }
    return r.ok ? 0 : 1;
  }
  if (shotOut) {
    const s = await withTunnel(() => callBinary('/shot.png', shotOut));
    out({ ok: true, ...s }, `✓ 截图已存 ${s.path}（${s.bytes} B, sha256=${s.sha256.slice(0, 16)}…）`);
    return 0;
  }
  if (bootstrapConv) {
    // 指纹只能由人看着截图确认后落：没有 --confirm 一律拒绝（这就是"人看一眼"的闸）
    if (!confirmed) {
      console.error('✗ bootstrap 必须先人眼确认：先 `--shot <文件>` 看一眼当前会话，确实是「' + bootstrapConv + '」再加 --confirm');
      return 2;
    }
    const b = await withTunnel(() => call('/bootstrap', { conv: bootstrapConv }));
    const rec = { id: newId(), conv: bootstrapConv, state: b?.ok ? 'bootstrap' : 'failed', ref: b?.ref ?? null, reason: b?.ok ? null : (b?.code ?? 'unknown'), ts: Date.now(), by: 'vm-sender', via: 'watcher' };
    appendOutbox(rec);
    out({ ...b, id: rec.id }, b?.ok
      ? `✓ 已为「${bootstrapConv}」存标题条指纹 ref=${String(b.ref).slice(0, 16)}…`
      : `✗ 存指纹失败 [${b?.code}]（空白裁剪会被拒，说明窗口没露出来或区域量错）`);
    return b?.ok ? 0 : 1;
  }
  if (clearRefConv) {
    const c = await withTunnel(() => call('/clearref', { conv: clearRefConv }));
    out(c, c?.removed ? `✓ 已删除「${clearRefConv}」的指纹` : `（「${clearRefConv}」本来就没有指纹）`);
    return 0;
  }
  if (!conv || !text) {
    console.error('用法：node scripts\\vm-sender.mjs --conv "会话名" --text "内容" [--json] [--dry]');
    console.error('      node scripts\\vm-sender.mjs --health | --geometry | --refs | --normalize');
    console.error('      node scripts\\vm-sender.mjs --shot <出图路径>');
    console.error('      node scripts\\vm-sender.mjs --open "会话名" [--shot <出图路径>]   （只定位会话，不发）');
    console.error('      node scripts\\vm-sender.mjs --bootstrap "会话名" --confirm   （人看过截图之后才能存指纹）');
    console.error('      node scripts\\vm-sender.mjs --clear-ref "会话名"');
    return 2;
  }

  // --id 可以复用一个已经试过的 id：VM 侧按 id 幂等，响应丢了再重试不会重复发
  const id = opt('id', null) || newId();
  const t0 = Date.now();
  const rec = { id, conv, text, state: 'pending', attempts: 1, evidence: null, ts: t0, by: 'vm-sender', via: 'watcher' };

  if (dry) {
    rec.state = 'sent'; rec.dry = true; rec.reason = 'dry-run：只查参数，没碰 VM'; rec.ms = Date.now() - t0;
    appendOutbox(rec);
    out({ ok: true, dry: true, id, conv, text }, `（dry）会发到「${conv}」：${text}`);
    return 0;
  }

  let r = null;
  try {
    r = await withTunnel(() => call('/send', { conv, text, id }));
  } catch (e) {
    rec.state = 'failed'; rec.reason = String(e.message).slice(0, 200); rec.ms = Date.now() - t0;
    appendOutbox(rec);
    out({ ok: false, id, conv, code: 'tunnel-failed', detail: rec.reason },
      `✗ 通道不通：${rec.reason}\n  ⚠ 响应丢了 ≠ 没发（21:51 现网就是消息已发出、宿主以为失败）。先用 --shot 看一眼：真没发就带 --id ${id} 重试，同 id 不会重复发。`);
    return 1;
  }

  const dup = r?.code === 'duplicate-suppressed';
  const ok = dup ? true : (Boolean(r?.ok) && Boolean(r?.beforeHash) && Boolean(r?.afterHash) && r.afterHash !== r.beforeHash);
  rec.state = dup ? 'sent' : (ok ? 'sent' : 'failed');
  rec.evidence = r?.afterHash ?? null;
  rec.beforeHash = r?.beforeHash ?? null;
  rec.ms = Date.now() - t0;
  if (dup) rec.reason = 'duplicate-suppressed';
  else if (!ok) rec.reason = r?.code ?? 'unknown';
  appendOutbox(rec);

  const payload = {
    ok, code: r?.code, id, conv,
    evidence: r?.afterHash ?? null,
    beforeHash: r?.beforeHash ?? null,
    hashDiffers: Boolean(r?.beforeHash && r?.afterHash && r.beforeHash !== r.afterHash),
    hwnd: r?.hwnd ?? null, ms: rec.ms, detail: r?.detail ?? null
  };
  out(payload, dup
    ? `• 这条 id 之前已经发过了（${id}），本次没有重复发`
    : ok
      ? `✓ 已发到「${conv}」｜before=${String(r.beforeHash).slice(0, 16)}… after=${String(r.afterHash).slice(0, 16)}…（不同）`
      : `✗ 没发成 [${r?.code}] ${r?.detail ?? ''}`);
  return ok ? 0 : 1;
}

function out(obj, human) {
  if (asJson) console.log(JSON.stringify(obj, null, 2));
  else console.log(human);
}

main().then((c) => { process.exitCode = c; }).catch((e) => {
  console.error(`✗ 异常：${e?.message ?? e}`);
  process.exitCode = 1;
});
