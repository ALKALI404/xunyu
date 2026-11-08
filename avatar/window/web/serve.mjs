#!/usr/bin/env node
// serve.mjs —— AV-005：窗口页面的**独立静态服务**（壳关着也能用浏览器打开 http://127.0.0.1:9342/）
//
// 为什么需要它：
//   1) 页面要 fetch(`config.json`) 与 `scenes/*.json`；file:// 下浏览器不给读本地文件（壳是靠
//      --allow-file-access-from-files 才行的），所以独立运行必须有 http；
//   2) relay(9334) / 工作台(9340) 都没发 CORS 头，跨端口 fetch 会被浏览器拦。
//      这里把 /relay/* 反代到 9334、/desk/* 与 /api/* 反代到 9340，页面变成同源，浏览器里不用放宽任何安全设置。
//
// 用法：node scripts 之外单起：  node E:\DeepFish\avatar\window\web\serve.mjs [--port 9342]
// 退出码：0 正常 / 1 端口占用
//
// 边界：只读转发，不写任何东西；不改 relay / workdesk。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const iPort = argv.indexOf('--port');
const PORT = Number(iPort >= 0 ? argv[iPort + 1] : (process.env.XY_WEB_PORT || 9342));

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2'
};

// 反代表：前缀 → 本地端口；strip=true 时把前缀去掉再转发（/relay/health → /health）
const PROXY = [
  { prefix: '/relay', port: 9334, strip: true },
  { prefix: '/desk', port: 9340, strip: true },
  { prefix: '/api', port: 9340, strip: false }   // 工作台页面在 iframe 里用的是绝对 /api/...
];

function proxyTo(target, req, res, stripPrefix) {
  let rest = req.url.slice(stripPrefix.length);
  if (!rest || rest === '') rest = '/';
  if (rest[0] !== '/') rest = '/' + rest;
  const opt = { host: '127.0.0.1', port: target.port, method: req.method, path: rest, headers: { ...req.headers, host: `127.0.0.1:${target.port}` } };
  const up = http.request(opt, (r) => {
    res.writeHead(r.statusCode || 502, r.headers);
    r.pipe(res);
  });
  up.on('error', (e) => {
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`反代失败 ${req.url} → 127.0.0.1:${target.port}：${e.message}`);
  });
  req.pipe(up);
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  const full = path.join(WEB, path.normalize(rel).replace(/^([\\/]|\.\.[\\/])+/, ''));
  if (!full.startsWith(WEB)) { res.writeHead(403); res.end('403'); return; }
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('404 ' + rel); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream', 'content-length': st.size, 'cache-control': 'no-store' });
    fs.createReadStream(full).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const pathname = (req.url || '/').split('?')[0];
  for (const t of PROXY) {
    if (pathname === t.prefix || pathname.startsWith(t.prefix + '/')) return proxyTo(t, req, res, t.strip ? t.prefix : '');
  }
  return serveStatic(req, res, pathname);
});

server.on('error', (e) => {
  process.stderr.write(`serve: 监听失败 ${e?.code ?? e?.message ?? e}\n`);
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`窗口页面独立服务：http://127.0.0.1:${PORT}/  （/relay→9334，/desk、/api→9340）\n`);
});
