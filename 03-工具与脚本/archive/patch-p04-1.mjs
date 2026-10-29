// P0-4 第一步：身体服务（9335）令牌闸门 + 角色矩阵
//
// 改前：9335 零鉴权，`source` 是请求方自己填的字符串，任何本机进程都能让身体说话/做动作/设闹钟。
// 改后：
//   · 启动时生成/复用 state/body-tokens.json，三个角色令牌：owner（本体）/ window（对话窗）/ dev（工作组）
//   · 每个动作请求必须带 x-body-token（或 ?token=），认不出角色 → 403 并记日志
//   · 权限矩阵：owner=全动作 window=全动作 dev=只读+say，其它一律 403
//   · /health 与 /capabilities 保持开放（守护进程要探活，不能卡）
//   · /state 含历史原文，需要有效令牌
//   · 中继按「谁的话」选角色：鲟鱼 tab 的回复=owner，DSH tab 的=dev；403 时**绝不**回落直连 mod
//
// 配额（仲裁 B：1句/3s、4句/10s、15句/60s、1动作/2s、超额合并排队）留作第二步。

import fs from 'node:fs';
import path from 'node:path';

const BODY = 'E:/DeepFish/avatar/body-service.mjs';
const RELAY = 'E:/DeepFish/avatar/relay.mjs';
const BACKUP = 'E:/DSH_workspace/backup';
const WRITE = process.argv.includes('--write');

const bodyPatches = [
  {
    name: 'P1 引入 fs/path/crypto/url',
    count: 1,
    from: `import http from 'node:http';`,
    to: `import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';`
  },
  {
    name: 'P2 令牌库 + 角色矩阵',
    count: 1,
    from: `const bootAt = Date.now();
const log = (...a) => console.log(\`[body] \${new Date().toISOString()}\`, ...a);`,
    to: `const bootAt = Date.now();
const log = (...a) => console.log(\`[body] \${new Date().toISOString()}\`, ...a);

// ── 令牌与角色（P0-4）──────────────────────────────────────────────────────
// 三个角色各一个 48 位十六进制令牌，落在 state/body-tokens.json（只写一次，重启复用——
// 客户端不用跟着重启；想换就直接删文件重启，旧令牌立刻失效）。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(HERE, 'state', 'body-tokens.json');
const ROLES = ['owner', 'window', 'dev'];

function loadTokens() {
  try {
    const raw = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8').replace(/^\\uFEFF/, ''));
    const roles = raw?.roles ?? {};
    if (ROLES.every((r) => /^[0-9a-f]{32,64}$/i.test(String(roles[r] ?? '')))) return roles;
    log('⚠️ 令牌文件不完整，重新生成（旧令牌立即失效）');
  } catch {}
  const roles = {};
  for (const r of ROLES) roles[r] = crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({ ver: 1, issuedAt: new Date().toISOString(), roles }, null, 2), 'utf8');
  try { fs.chmodSync(TOKEN_FILE, 0o600); } catch {}
  log(\`已生成身体令牌：\${TOKEN_FILE}（角色 \${ROLES.join('/')}）\`);
  return roles;
}

const TOKENS = loadTokens();
const ROLE_BY_TOKEN = new Map(Object.entries(TOKENS).map(([r, t]) => [String(t), r]));

// 权限矩阵：角色 → 允许的动作。读接口另算（/health /capabilities 开放，/state 需令牌）。
const ROLE_ACTIONS = {
  owner: new Set(['say', 'anim', 'emotion', 'dialogue', 'chatpanel', 'timer', 'cancelalarm', 'memo']),
  window: new Set(['say', 'anim', 'emotion', 'dialogue', 'chatpanel', 'timer', 'cancelalarm', 'memo']),
  dev: new Set(['say'])
};

const tokenOf = (req, url) => String(req.headers['x-body-token'] ?? url.searchParams.get('token') ?? '').trim();
const roleOf = (req, url) => {
  const t = tokenOf(req, url);
  return t ? (ROLE_BY_TOKEN.get(t) ?? null) : null;
};`
  },
  {
    name: 'P3 /state 需要令牌（历史里有原文）',
    count: 1,
    from: `  if (req.method === 'GET' && path === '/state') {`,
    to: `  // /state 里历史含对话原文：只有三个已知角色能看；/health 与 /capabilities 保持开放。
  if (req.method === 'GET' && path === '/state' && !roleOf(req, url)) {
    log(\`[403] 无有效令牌读取 /state\`);
    return send(403, { ok: false, error: '读取 /state 需要有效令牌（x-body-token）' });
  }

  if (req.method === 'GET' && path === '/state') {`
  },
  {
    name: 'P4 POST 动作：认角色 + 查矩阵 + 审计一行',
    count: 1,
    from: `  const body = await readBody(req);
  const source = String(body.source ?? url.searchParams.get('source') ?? 'unknown');
  const caps = adapter.capabilities;`,
    to: `  const body = await readBody(req);
  const source = String(body.source ?? url.searchParams.get('source') ?? 'unknown');
  const caps = adapter.capabilities;

  // ── 鉴权（P0-4）：没有有效令牌就一个动作都别想动 ──────────────────────
  const role = roleOf(req, url);
  if (!role) {
    log(\`[403] 无有效令牌：\${path}（\${tokenOf(req, url) ? '令牌无效' : '缺令牌'}）\`);
    return send(403, {
      ok: false,
      error: '缺少或无效的身体令牌：请求头带 x-body-token（角色令牌见 avatar/state/body-tokens.json）'
    });
  }
  const actionName = String(path).replace(/^\\//, '');
  const allowedActions = ROLE_ACTIONS[role] ?? new Set();
  if (!allowedActions.has(actionName)) {
    log(\`[403] 角色 \${role} 无权 \${actionName}（来源 \${source}）\`);
    return send(403, {
      ok: false,
      role,
      error: \`角色 \${role} 无权执行 \${actionName}（可做：\${[...allowedActions].join(', ') || '无'}）\`
    });
  }
  log(\`动作 \${actionName} ← \${role}（\${source}）\`);`
  }
];

const relayPatches = [
  {
    name: 'R1 中继读身体令牌',
    count: 1,
    from: `let { token, consoleToken } = readTokens();`,
    to: `let { token, consoleToken } = readTokens();

// 身体服务的角色令牌（P0-4）：按「谁的话」选角色，每次现读，删文件换令牌后立即跟上。
function readBodyTokens() {
  try {
    const raw = JSON.parse(fs.readFileSync(new URL('./state/body-tokens.json', import.meta.url), 'utf8').replace(/^\\uFEFF/, ''));
    return raw?.roles ?? {};
  } catch { return {}; }
}`
  },
  {
    name: 'R2 pushToBody 带角色令牌；403 不回落直连 mod',
    count: 1,
    from: `async function pushToBody(text) {
  try {
    const r = await fetch(\`\${BODY_SERVICE}/say\`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, source: 'relay' }),
      signal: AbortSignal.timeout(8000)
    });
    if (r.ok) return true;
    log(\`身体服务拒绝说话（HTTP \${r.status}），转直连 mod\`);`,
    to: `async function pushToBody(text, role = 'owner') {
  // P0-4：身体服务要令牌。角色按「谁的话」选：鲟鱼 tab 的回复=owner，DSH tab 的=dev。
  const bodyToken = String(readBodyTokens()[role] ?? '');
  try {
    const r = await fetch(\`\${BODY_SERVICE}/say\`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(bodyToken ? { 'x-body-token': bodyToken } : {}) },
      body: JSON.stringify({ text, source: 'relay', role }),
      signal: AbortSignal.timeout(8000)
    });
    if (r.ok) return true;
    // 401/403 是鉴权问题：**绝不能**回落直连 mod —— 那等于把刚装上的闸门绕过去。
    if (r.status === 401 || r.status === 403) {
      log(\`身体服务拒绝（HTTP \${r.status}，角色 \${role}）：查 state/body-tokens.json 与角色权限，不回落直连\`);
      return false;
    }
    log(\`身体服务拒绝说话（HTTP \${r.status}），转直连 mod\`);`
  },
  {
    name: 'R3 调用点带上目标对应的角色',
    count: 1,
    from: `        await pushToBody(text);`,
    to: `        await pushToBody(text, name === 'xunyu' ? 'owner' : 'dev');`
  }
];

function stage(file, patches) {
  const raw = fs.readFileSync(file);
  const hasBom = raw.length > 2 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
  let src = raw.toString('utf8');
  if (hasBom) src = src.slice(1);
  const report = [];
  for (const p of patches) {
    const n = src.split(p.from).length - 1;
    if (n !== p.count) { report.push(`  ❌ ${p.name}：期望 ${p.count} 处，实际 ${n} 处`); return { ok: false, report, file }; }
    src = src.split(p.from).join(p.to);
    report.push(`  ✅ ${p.name}：${n} 处`);
  }
  return { ok: true, report, file, src, hasBom };
}

const staged = [];
let allOk = true;
for (const [file, patches] of [[BODY, bodyPatches], [RELAY, relayPatches]]) {
  const r = stage(file, patches);
  console.log(`\n=== ${path.basename(file)} ${r.ok ? '（全部命中）' : '（有对不上的锚点）'}`);
  console.log(r.report.join('\n'));
  if (!r.ok) allOk = false; else staged.push(r);
}
if (!allOk) { console.log('\n🛑 有锚点对不上，一个字节都不写。'); process.exit(2); }
if (!WRITE) { console.log('\n✅ dry-run 通过，加 --write 才写盘。'); process.exit(0); }

fs.mkdirSync(BACKUP, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
for (const r of staged) {
  const bak = path.join(BACKUP, `${path.basename(r.file)}.${stamp}.p04`);
  fs.copyFileSync(r.file, bak);
  fs.writeFileSync(r.file, (r.hasBom ? '\uFEFF' : '') + r.src, 'utf8');
  console.log(`✍️  已写 ${r.file}（备份 ${bak}）`);
}
console.log('\n🎉 写完了。');
