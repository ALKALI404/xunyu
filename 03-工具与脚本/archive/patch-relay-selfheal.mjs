// 中继「重启后自恢复」三件套：
//   ① 中继自己写日志文件（不再依赖守护的 stdout 重定向 → 重启后不会瞎）
//   ② 桥接加 POST /api/dsh/bind（只重建中继绑定，不投递消息）
//   ③ 中继启动时把已知目标会话重新绑一次（否则 /api/dsh/wait 404「没有活跃的中继绑定」）
import fs from 'node:fs';

const RELAY = 'E:/DeepFish/avatar/relay.mjs';
const BRIDGE = 'E:/DeepFish/qq-bridge-0.2.1-r1/qq-bridge-0.2.1-r1/src/bridge.js';
const WRITE = process.argv.includes('--write');

const patchRelay = (src) => {
  const patches = [
    {
      name: 'R1 中继自己落盘日志（句柄失效会自愈）',
      from: `const log = (...a) => console.log(new Date().toLocaleTimeString('zh-CN', { hour12: false }), ...a);`,
      to: `const RELAY_LOG = path.join('E:\\\\DeepFish\\\\avatar', 'state', 'relay.log');
let relayLogFd = null;
function writeRelayLog(line) {
  try {
    if (relayLogFd == null) {
      fs.mkdirSync(path.dirname(RELAY_LOG), { recursive: true });
      relayLogFd = fs.openSync(RELAY_LOG, 'a');
    }
    fs.writeSync(relayLogFd, line + '\\n');
  } catch {
    try { if (relayLogFd != null) fs.closeSync(relayLogFd); } catch {}
    relayLogFd = null; // 下次写自动重新打开（文件被删 / 句柄失效时自愈）
  }
}
// 重启后自恢复①：不再依赖「守护启动时的 stdout 重定向」，自己写文件。
const log = (...a) => {
  const line = '[' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '] ' +
    a.map((x) => (typeof x === 'string' ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })())).join(' ');
  try { console.log(line); } catch {}
  writeRelayLog(line);
};`
    },
    {
      name: 'R3 启动时重新绑定已知目标',
      from: `  log(\`中继已启动 http://127.0.0.1:\${PORT}  会话=\${key}  令牌=\${!!token}  桌宠=\${MOD}\`);`,
      to: `  log(\`中继已启动 http://127.0.0.1:\${PORT}  会话=\${key}  令牌=\${!!token}  桌宠=\${MOD}\`);
  // 重启后自恢复③：把已知目标的会话重新绑到桥接（只绑定、不投递），
  // 否则 /api/dsh/wait 会 404「没有活跃的中继绑定」，窗口/QQ 看起来就是「发了没回」。
  try {
    const pins = readPins();
    for (const [name, t] of Object.entries(targets)) {
      const sid = String(t.sessionId ?? pins[name] ?? '').trim();
      if (!sid) { log('重启自恢复：' + name + ' 还没有已知会话，等第一条消息'); continue; }
      bridge('/api/dsh/bind', { method: 'POST', body: { key, sessionId: sid, title: name } })
        .then((r) => log('重启自恢复：已重新绑定 ' + name + ' → ' + sid + '（ok=' + String(r.data?.ok) + '）'))
        .catch((e) => log('重启自恢复：绑定 ' + name + ' 失败（' + String(e?.message ?? e) + '）'));
    }
  } catch (e) {
    log('重启自恢复：绑定流程异常（' + String(e?.message ?? e) + '）');
  }`
    }
  ];
  let ok = true;
  for (const p of patches) {
    const n = src.split(p.from).length - 1;
    console.log(`${n === 1 ? '✅' : '❌'} ${p.name}：${n} 处`);
    if (n !== 1) { ok = false; continue; }
    src = src.split(p.from).join(p.to);
  }
  return ok ? src : null;
};

const patchBridge = (src) => {
  const patches = [
    {
      name: 'B1 新增 POST /api/dsh/bind（只重建绑定）',
      from: `        if (req.method === 'POST' && url.pathname === '/api/dsh/say') {`,
      to: `        // 中继重启后自恢复用：只重建 relayBindings，不投递任何消息（不会打扰鲟鱼）。
        if (req.method === 'POST' && url.pathname === '/api/dsh/bind') {
          const body = await readBody();
          const denied = dshShoutDenied(body.key, req.headers['x-agent-token']);
          if (denied) { sendJson({ ok: false, error: denied }, 403); return; }
          const bindSession = String(body.sessionId ?? '').trim();
          if (!bindSession) { sendJson({ ok: false, error: 'sessionId 不能为空' }, 400); return; }
          const bindQQ = (/^private:(\\d+)$/.exec(String(body.key ?? '')) ?? [])[1] ?? '';
          relayBindings.set(bindSession, {
            key: \`private:\${bindQQ}\`,
            title: String(body.title ?? ''),
            at: Date.now(),
            silent: true
          });
          try { api.events.follow(bindSession); } catch {}
          log(\`[中继] 重新绑定会话 \${bindSession}（只绑定，不投递）\`);
          sendJson({ ok: true, sessionId: bindSession });
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/dsh/say') {`
    },
    {
      name: 'B2 代理令牌白名单加 /api/dsh/bind',
      from: `            || url.pathname === '/api/dsh/approve'`,
      to: `            || url.pathname === '/api/dsh/approve'
            || url.pathname === '/api/dsh/bind'`
    }
  ];
  let ok = true;
  for (const p of patches) {
    const n = src.split(p.from).length - 1;
    console.log(`${n === 1 ? '✅' : '❌'} ${p.name}：${n} 处`);
    if (n !== 1) { ok = false; continue; }
    src = src.split(p.from).join(p.to);
  }
  return ok ? src : null;
};

let relaySrc = fs.readFileSync(RELAY, 'utf8');
let bridgeSrc = fs.readFileSync(BRIDGE, 'utf8');
const r2 = patchRelay(relaySrc);
const b2 = patchBridge(bridgeSrc);
if (!r2 || !b2) { console.log('🛑 有锚点对不上，一个文件都不写'); process.exit(2); }
if (!WRITE) { console.log('✅ dry-run 通过'); process.exit(0); }
fs.writeFileSync(RELAY, r2, 'utf8');
fs.writeFileSync(BRIDGE, b2, 'utf8');
console.log('✍️  已写 relay.mjs + bridge.js');
