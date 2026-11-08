#!/usr/bin/env node
// scripts\measure-mcp-tools.mjs —— 数每个 MCP server 的工具数 / schema 体积 / token 估算（UG-037）
//
// 口径：token ≈ 字符数 / 2.2（schema 里是英文+少量中文，DeepSeek 分词器英文约 4 字符/token，
// 但 JSON 结构符会碎，所以用 2.2 这个经验值；同一口径横比才有效）。
//
// 用法：
//   node scripts\measure-mcp-tools.mjs            # 表格
//   node scripts\measure-mcp-tools.mjs --json     # 机读（落 docs\环境\启动上下文账本.md 用）

import { spawn } from 'node:child_process';
import fs from 'node:fs';

const SERVERS = [
  { name: 'net-accel', command: 'C:\\Program Files\\nodejs\\node.exe', args: ['E:\\DeepFish\\qq-bridge-0.2.1-r1\\qq-bridge-0.2.1-r1\\src\\mcp-net-accel.js'] },
  {
    name: 'qq-extras', command: 'C:\\Program Files\\nodejs\\node.exe',
    args: ['E:\\DeepFish\\qq-bridge-0.2.1-r1\\qq-bridge-0.2.1-r1\\plugins\\dsh-qq-extras\\mcp.mjs'],
    env: { QQ_EXTRAS_DATA: 'E:\\DeepFish\\History\\qq-memory', QQ_BRIDGE_DIR: 'E:\\DeepFish\\qq-bridge-0.2.1-r1\\qq-bridge-0.2.1-r1' }
  },
  { name: 'bilibili', command: 'C:\\Program Files\\nodejs\\node.exe', args: ['E:\\DSH_workspace\\mcp\\bilibili-mcp-js\\node_modules\\bilibili-mcp-js\\dist\\index.js'] },
  { name: 'snowluma', command: 'C:\\Program Files\\nodejs\\node.exe', args: ['E:\\DeepFish\\qq-bridge-0.2.1-r1\\qq-bridge-0.2.1-r1\\src\\mcp-snowluma-safe.js'] },
  { name: 'snowluma-host', command: 'C:\\Program Files\\nodejs\\node.exe', args: ['E:\\DeepFish\\qq-bridge-0.2.1-r1\\qq-bridge-0.2.1-r1\\src\\mcp-host-server.js'] },
  { name: 'web-search-safe', command: 'C:\\Program Files\\nodejs\\node.exe', args: ['E:\\DeepFish\\qq-bridge-0.2.1-r1\\qq-bridge-0.2.1-r1\\src\\mcp-web-search-safe.js'] }
];

const asJson = process.argv.includes('--json');
const CHARS_PER_TOKEN = 2.2;

function talk(server, timeoutMs = 25000) {
  return new Promise((resolve) => {
    const child = spawn(server.command, server.args, {
      env: { ...process.env, ...(server.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    let buf = '';
    let phase = 0;
    let tools = null;
    const timer = setTimeout(() => { try { child.kill(); } catch { } resolve({ name: server.name, ok: false, error: 'timeout', tools: [] }); }, timeoutMs);

    const send = (obj) => { try { child.stdin.write(`${JSON.stringify(obj)}\n`); } catch { } };
    const done = (payload) => { clearTimeout(timer); try { child.kill(); } catch { } resolve(payload); };

    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('{')) continue;
        let msg = null;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1 && phase === 0) {
          phase = 1;
          send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        } else if (msg.id === 2) {
          tools = msg.result?.tools ?? [];
          const payload = JSON.stringify(tools);
          done({ name: server.name, ok: true, count: tools.length, chars: payload.length, names: tools.map((t) => t.name) });
          return;
        }
      }
    });
    child.on('error', (error) => done({ name: server.name, ok: false, error: String(error?.message ?? error), tools: [] }));
    child.on('exit', () => { if (tools === null) done({ name: server.name, ok: false, error: 'exited', tools: [] }); });

    send({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'ug037-measure', version: '1.0.0' } }
    });
  });
}

const rows = [];
for (const server of SERVERS) {
  const r = await talk(server);
  rows.push({
    name: r.name,
    ok: r.ok,
    tools: r.count ?? 0,
    chars: r.chars ?? 0,
    tokens: Math.round((r.chars ?? 0) / CHARS_PER_TOKEN),
    error: r.error ?? '',
    names: r.names ?? []
  });
  if (!asJson) process.stderr.write(`  ${r.name}: ${r.ok ? `${r.count} tools, ${r.chars} chars` : `FAILED ${r.error}`}\n`);
}

const total = {
  servers: rows.length,
  tools: rows.reduce((a, r) => a + r.tools, 0),
  chars: rows.reduce((a, r) => a + r.chars, 0),
  tokens: rows.reduce((a, r) => a + r.tokens, 0)
};

if (asJson) {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), charsPerToken: CHARS_PER_TOKEN, rows, total }, null, 2)}\n`);
} else {
  const pad = (s, w) => { const t = String(s ?? ''); return t.length >= w ? t : t + ' '.repeat(w - t.length); };
  process.stdout.write('\nMCP 服务器       工具数   schema字符   ≈token\n');
  process.stdout.write('─'.repeat(52) + '\n');
  for (const r of rows) process.stdout.write(`${pad(r.name, 16)}${pad(r.ok ? r.tools : 'ERR', 8)}${pad(r.chars, 11)}${r.tokens}\n`);
  process.stdout.write('─'.repeat(52) + '\n');
  process.stdout.write(`${pad('合计', 16)}${pad(total.tools, 8)}${pad(total.chars, 11)}${total.tokens}\n`);
}

try {
  fs.mkdirSync('state', { recursive: true });
  fs.writeFileSync('state/mcp-tool-measure.json', `${JSON.stringify({ at: new Date().toISOString(), rows, total }, null, 2)}\n`, 'utf8');
} catch { }
