// 演练桩：假装是 supervisor 的 9338 受控重启入口。
// 只用于 D6-v2 验收③（复验失败路径）——它永远回「没救回来」，好让 self-heal 走到 escalated。
import http from 'node:http';

const PORT = Number(process.env.STUB_PORT || 9440);
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  const send = (code, obj) => {
    const text = JSON.stringify(obj);
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  };
  if (url.pathname === '/heal') {
    const module = url.searchParams.get('module') ?? '';
    send(200, { ok: true, healed: false, module, ms: 0, pidBefore: 0, pidAfter: 0, note: 'stub: 收下了，但没救回来（演练用）' });
    return;
  }
  if (url.pathname === '/status') { send(200, { ok: true, stub: true, port: PORT }); return; }
  send(404, { ok: false, error: 'stub only /heal /status' });
});
server.listen(PORT, '127.0.0.1', () => process.stdout.write(`stub-supervisor 监听 ${PORT}\n`));
