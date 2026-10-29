#!/usr/bin/env node
// probe-bridge.mjs —— bridge(3100) 的**外挂探针**：让它也符合 docs\模块契约-v0.md。
//
// 为什么外挂：3100 的 /api/status 要 console-token，而 bridge.js 是上游魔改模块（排最后改）。
// 所以另起一个小进程去问它，再把回答**翻译**成契约形状。
//
// 契约要点：
//   GET /health        → { ok, module, version, port, uptimeMs, ts, checks }，失败带 error{layer,code,detail}
//   GET /capabilities  → { ok, module, capabilities:[{cap,kind,note}] }
//
// 三条自我约束（工单硬要求）：
//   ① 只读：只 GET 3100/api/status，不向 bridge 发任何写请求；
//   ② 缓存 5s：同一个 5 秒窗口复用上游结果，别把 3100 打爆；
//   ③ **绝不回显 console-token、任何配置值、任何消息正文** —— 响应里只有 ok / 时序 / 字段个数。
//
// 用法：
//   node avatar\probe-bridge.mjs                       # 默认：听 9337，问 http://127.0.0.1:3100
//   node avatar\probe-bridge.mjs --upstream http://127.0.0.1:3999   # 负向测试：指到空端口
//   node avatar\probe-bridge.mjs --port 9337 --token-file <path>

import fs from 'node:fs';
import http from 'node:http';

// ── 常量：全部写死在顶部，方便审 ──────────────────────────────────────────────
const VERSION = 'probe-2026-10-28';
const MODULE = 'bridge';
const DEFAULT_PORT = 9337;
const DEFAULT_UPSTREAM = 'http://127.0.0.1:3100';
const DEFAULT_TOKEN_FILE = 'E:\\DeepFish\\qq-bridge-0.2.1-r1\\qq-bridge-0.2.1-r1\\state\\console-token';
const UPSTREAM_TIMEOUT_MS = 2000; // 契约要求 /health ≤2s
const CACHE_MS = 5000;            // 工单：同窗口复用
const STARTED_AT = Date.now();

// ── 参数 ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = { port: DEFAULT_PORT, upstream: DEFAULT_UPSTREAM, tokenFile: DEFAULT_TOKEN_FILE, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} 缺少值`);
      i += 1;
      return value;
    };
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--port') opts.port = Number(next());
    else if (arg === '--upstream') opts.upstream = next().replace(/\/+$/, '');
    else if (arg === '--token-file') opts.tokenFile = next();
    else throw new Error(`未知参数：${arg}`);
  }
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) throw new Error(`--port 非法：${opts.port}`);
  if (!/^https?:\/\//.test(opts.upstream)) throw new Error(`--upstream 必须是 http(s)://…：${opts.upstream}`);
  return opts;
}

// ── 上游探测（带 5s 缓存）────────────────────────────────────────────────────
let cache = { at: 0, value: null };

/** 读 console-token：只用于请求头，**永不写进日志或响应**。 */
function readToken(file) {
  try {
    const token = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
    return token ? token : null;
  } catch {
    return null;
  }
}

/** 错误响应体：契约 §一「ok 为假时必须带 error{layer,code,detail}」。 */
function failure(layer, code, detail, checks) {
  return {
    ok: false,
    module: MODULE,
    version: VERSION,
    port: cache.port ?? DEFAULT_PORT,
    uptimeMs: Date.now() - STARTED_AT,
    ts: Date.now(),
    checks: checks ?? {},
    error: { layer, code, detail }
  };
}

/**
 * 问一次 3100/api/status，翻译成契约 /health。
 * 注意：**任何分支都不把上游响应体原样吐出去** —— 只留字段个数与时序。
 */
async function probeUpstream(opts) {
  const token = readToken(opts.tokenFile);
  if (!token) {
    return failure('module', 'token-unavailable', '读不到 console-token：探针无法鉴权（不对外说明路径）', {
      token: { ok: false }
    });
  }
  const started = Date.now();
  let response;
  try {
    response = await fetch(`${opts.upstream}/api/status`, {
      method: 'GET',
      headers: { accept: 'application/json', 'x-console-token': token },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    });
  } catch (error) {
    const ms = Date.now() - started;
    const cause = error?.name === 'TimeoutError' ? 'timeout' : String(error?.cause?.code ?? error?.code ?? error?.name ?? 'fetch-failed');
    // 上游连不上 = transport 层（契约 §四：端口没开/进程死了 → 03·维护）
    const detail = cause === 'timeout' ? `${UPSTREAM_TIMEOUT_MS}ms 内无响应` : '上游无响应';
    return failure('transport', 'upstream-down', `3100 ${detail}（${cause}）`, {
      upstream: { ok: false, ms, detail: cause },
      token: { ok: true }
    });
  }

  const ms = Date.now() - started;
  if (response.status === 401 || response.status === 403) {
    return failure('module', 'upstream-unauthorized', `上游拒绝令牌（HTTP ${response.status}）：console-token 可能已轮换`, {
      upstream: { ok: false, ms, detail: `HTTP ${response.status}` },
      token: { ok: true }
    });
  }
  if (!response.ok) {
    return failure('module', 'upstream-bad-response', `上游返回 HTTP ${response.status}`, {
      upstream: { ok: false, ms, detail: `HTTP ${response.status}` },
      token: { ok: true }
    });
  }
  let json = null;
  try {
    json = await response.json();
  } catch {
    return failure('module', 'upstream-bad-response', '上游返回的不是 JSON', {
      upstream: { ok: false, ms, detail: 'bad-json' },
      token: { ok: true }
    });
  }
  const fields = json && typeof json === 'object' ? Object.keys(json) : [];
  // 只保留「字段名」这一层信息：字段名本身是接口契约的一部分，不含任何值。
  return {
    ok: true,
    module: MODULE,
    version: VERSION,
    port: cache.port ?? DEFAULT_PORT,
    uptimeMs: Date.now() - STARTED_AT,
    ts: Date.now(),
    checks: {
      upstream: { ok: true, ms },
      token: { ok: true },
      payload: { ok: true, detail: `${fields.length} 个字段` }
    },
    // 字段名清单（只有名字，没有值）——让排障时能看出上游形状对不对
    fields,
    cacheMs: CACHE_MS
  };
}

async function healthOf(opts) {
  const now = Date.now();
  if (cache.value && now - cache.at < CACHE_MS) {
    const hit = { ...cache.value, cachedAgeMs: now - cache.at };
    return withManifestCheck(hit);
  }
  const fresh = await probeUpstream(opts);
  fresh.port = opts.port;
  cache = { at: now, value: fresh, port: opts.port };
  return withManifestCheck({ ...fresh, cachedAgeMs: 0 });
}

// ── D20：bridge 的 6 模块 manifest（P0 只登记，不改 bridge.js 一个字节）─────────
// 为什么挂在探针而不是 bridge 本体：本阶段要求「不改行为」，探针是我们自己的契约面，
// 重启它不碰到 QQ 主链路。等 P1 真拆时，这段原样搬进 bridge。
const MANIFEST_FILE = '<工作区>\\state\\bridge-manifest.json';
function readManifest() {
  try {
    const raw = fs.readFileSync(MANIFEST_FILE, 'utf8').replace(/^\uFEFF/, '');
    const json = JSON.parse(raw);
    return json && Array.isArray(json.modules) ? json : null;
  } catch { return null; }
}
function withManifestCheck(health) {
  const man = readManifest();
  const checks = { ...(health.checks ?? {}) };
  checks.modules = man
    ? { ok: true, detail: `${man.modules.length}/6 已登记（manifest v1，P0 未拆分）` }
    : { ok: false, layer: 'contract', code: 'manifest-missing', detail: `读不到 ${MANIFEST_FILE}` };
  return { ...health, checks };
}

// ── 静态 capabilities：只声明"能看状态"，不吹能发消息 ────────────────────────
function capabilitiesOf(opts) {
  return {
    ok: true,
    module: MODULE,
    version: VERSION,
    port: opts.port,
    ts: Date.now(),
    capabilities: [
      { cap: 'bridge.status', kind: 'query', note: '只读：桥接是否就绪/模式（经 3100/api/status 翻译，不含 token 与正文）' },
      { cap: 'bridge.health', kind: 'query', note: '只读：本探针自身的契约 /health' },
      { cap: 'bridge.manifest', kind: 'query', note: '只读：bridge 的 6 模块拆分登记（state\\bridge-manifest.json）' }
    ]
  };
}

// ── HTTP 服务 ───────────────────────────────────────────────────────────────
const SECURITY_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff'
};

function sendJson(res, code, body) {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(code, { ...SECURITY_HEADERS, 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write('用法: node probe-bridge.mjs [--port 9337] [--upstream http://127.0.0.1:3100] [--token-file <path>]\n');
    return;
  }
  const server = http.createServer(async (req, res) => {
    try {
      // Host 头只认回环（与 bridge 控制台同一套姿势）
      const host = String(req.headers.host ?? '');
      if (host && !/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host)) {
        sendJson(res, 403, { ok: false, module: MODULE, error: { layer: 'contract', code: 'host-not-allowed', detail: '只接受本机回环访问' } });
        return;
      }
      const pathname = new URL(req.url ?? '/', `http://127.0.0.1:${opts.port}`).pathname;
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, module: MODULE, error: { layer: 'contract', code: 'method-not-allowed', detail: '只读探针，只支持 GET' } });
        return;
      }
      if (pathname === '/health') {
        const health = await healthOf(opts);
        sendJson(res, health.ok ? 200 : 503, health);
        return;
      }
      if (pathname === '/capabilities') {
        sendJson(res, 200, capabilitiesOf(opts));
        return;
      }
      if (pathname === '/manifest') {
        const man = readManifest();
        if (!man) {
          sendJson(res, 503, { ok: false, module: MODULE, error: { layer: 'contract', code: 'manifest-missing', detail: `读不到 ${MANIFEST_FILE}` } });
          return;
        }
        sendJson(res, 200, { ok: true, module: MODULE, version: VERSION, port: opts.port, ts: Date.now(), ...man });
        return;
      }
      sendJson(res, 404, { ok: false, module: MODULE, error: { layer: 'contract', code: 'unknown-path', detail: '只提供 /health、/capabilities 与 /manifest' } });
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        module: MODULE,
        version: VERSION,
        ts: Date.now(),
        error: { layer: 'module', code: 'probe-internal', detail: String(error?.message ?? error).slice(0, 160) }
      });
    }
  });

  server.on('error', (error) => {
    if (error?.code === 'EADDRINUSE') {
      process.stderr.write(`probe-bridge: ${opts.port} 已被占用（可能已有探针在跑）\n`);
    } else {
      process.stderr.write(`probe-bridge: 监听失败 ${error?.code ?? error?.message ?? error}\n`);
    }
    process.exitCode = 1;
  });

  server.listen(opts.port, '127.0.0.1', () => {
    // 只打端口与上游地址，不打 token、不打任何配置值
    process.stdout.write(`probe-bridge ${VERSION} 监听 127.0.0.1:${opts.port} → ${opts.upstream}/api/status（缓存 ${CACHE_MS}ms，只读）\n`);
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
