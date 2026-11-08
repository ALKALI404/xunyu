#!/usr/bin/env node
import { readJson } from './json-io.mjs';
// scripts\health-components.mjs —— 组件健康（WS-011 / W-256，07·窗口壳 2026-10-30）
//
// 一句话：**谁活着、谁挂了，一屏能看出来。**
// 为什么要它：工作台之前只能看「谁在干活」，看不出「谁挂了」——桥接/relay/隧道挂了页面照样一片绿。
//
// 设计要点（都被工单 §1 钉死）：
//   1. 每个组件探针 **800ms 超时**，全部并行；一个卡住不拖垮整个接口；
//   2. 结果缓存 **10 秒**（`?refresh=1` 绕过）；同一秒多次请求不打爆探针；
//   3. 状态**变化**时追加一行 `state\health-history.jsonl`（append-only，能看"什么时候挂的"）；
//   4. 组件清单在 `state\health-components.json`，**加组件只改 json、不改代码**。
//
// 不自己写探针的两处：
//   · DSH 端口不写死 —— 走 `scripts\dsh-base.mjs` 的 resolveDshBase()（env → handoff-config → 桥接 config）；
//   · VM 企微 —— **不在这里 SSH**（一次 15s，跟 800ms 的预算差两个数量级）。
//     直接消费 03 的 `wecom-vm-health.mjs` 产出的 `state\wecom-vm-health.json`（5 分钟一刷，看年龄判是否过期）。
//
// 用法：
//   node scripts\health-components.mjs            # 人类可读
//   node scripts\health-components.mjs --json     # 机读（工作台 /api/health/components 就是它）
//   node scripts\health-components.mjs --refresh  # 绕过 10s 缓存
//
// 退出码：0 = 全部 ok ｜ 1 = 有组件挂了 ｜ 2 = 用法/读配置失败
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveDshBase } from './dsh-base.mjs';
import { hasBom } from './json-io.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, '..');
const CONFIG_FILE = path.join(WORKSPACE, 'state', 'health-components.json');
const HISTORY_FILE = path.join(WORKSPACE, 'state', 'health-history.jsonl');
const CACHE_MS = 10000;
const TIMEOUT_MS = 800;
const TABLE_TTL_MS = 30000;   // 端口表/进程表另缓存 30s：uptime 掉 10 秒精度无所谓，省 600ms/次
// WS-012：status 暂时读不到时，别立刻退回"文件口径"（那会和 status 自相矛盾）。留一份上次结论兜底。
let lastVmStatus = { at: 0, vm: null, sourceTs: 0 };

const now = () => Date.now();

// ── 缓存：{at, payload, configMtime} ──────────────────────────────────────────
let lastPayload = null;
let lastAt = 0;
let lastConfigMtime = 0;
const tableCache = { at: 0, value: null };

function readConfig() {
  const raw = fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, '');
  const cfg = JSON.parse(raw);
  const timeoutMs = Number(cfg.timeoutMs ?? TIMEOUT_MS) || TIMEOUT_MS;
  const components = Array.isArray(cfg.components) ? cfg.components : [];
  const st = fs.statSync(CONFIG_FILE);
  return { cfg, timeoutMs, components, mtime: st.mtimeMs };
}

// ── 探针：三种原子能力（端口 / HTTP / 进程表）──────────────────────────────────
function tcpProbe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const sock = net.connect({ host, port });
    const finish = (ok, error) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve({ ok, error: error ?? null });
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false, `TCP 超时（${timeoutMs}ms 没回应）`));
    sock.once('error', (e) => finish(false, `${e.code ?? 'ERR'}${e.message ? ' ' + e.message : ''}`.trim()));
  });
}

function httpProbe(url, timeoutMs, acceptStatus = null) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok, status, error, note = null) => {
      if (done) return;
      done = true;
      resolve({ ok, status: status ?? null, error: error ?? null, note });
    };
    let req;
    try {
      const u = new URL(url);
      req = http.request(
        { host: u.hostname, port: u.port || 80, path: `${u.pathname}${u.search}`, method: 'GET', timeout: timeoutMs },
        (res) => {
          res.resume();
          const code = res.statusCode;
          const ok = Array.isArray(acceptStatus) && acceptStatus.includes(code)
            ? true
            : (code >= 200 && code < 400);
          const note = ok && code >= 400 ? `HTTP ${code}（要鉴权=在答，不算挂）` : null;
          finish(ok, code, ok ? null : `HTTP ${code}`, note);
        }
      );
    } catch (e) {
      finish(false, null, `URL 解析失败：${e.message}`);
      return;
    }
    req.on('timeout', () => { try { req.destroy(); } catch { /* ignore */ } finish(false, null, `HTTP 超时（${timeoutMs}ms）`); });
    req.on('error', (e) => finish(false, null, `${e.code ?? 'ERR'}${e.message ? ' ' + e.message : ''}`.trim()));
    req.end();
  });
}

function httpJson(url, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok, status, json, error) => {
      if (done) return;
      done = true;
      resolve({ ok, status: status ?? null, json: json ?? null, error: error ?? null });
    };
    let req;
    try {
      const u = new URL(url);
      req = http.request(
        { host: u.hostname, port: u.port || 80, path: `${u.pathname}${u.search}`, method: 'GET', timeout: timeoutMs, headers: { accept: 'application/json' } },
        (res) => {
          let raw = '';
          res.setEncoding('utf8');
          res.on('data', (c) => { raw += c; });
          res.on('end', () => {
            let json = null;
            try { json = JSON.parse(raw); } catch { /* 非 JSON */ }
            const bad = res.statusCode >= 400;
            finish(!bad && json != null, res.statusCode, json, bad ? `HTTP ${res.statusCode}` : (json == null ? '返回不是 JSON' : null));
          });
        }
      );
    } catch (e) {
      finish(false, null, null, `URL 解析失败：${e.message}`);
      return;
    }
    req.on('timeout', () => { try { req.destroy(); } catch { /* ignore */ } finish(false, null, null, `请求超时（${timeoutMs}ms）`); });
    req.on('error', (e) => finish(false, null, null, `${e.code ?? 'ERR'}${e.message ? ' ' + e.message : ''}`.trim()));
    req.end();
  });
}

function runCapture(file, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve({ ok: !err, stdout: String(stdout ?? ''), error: err ? String(err.message ?? err) : null });
    });
  });
}

/**
 * 端口 → pid 映射（一次 netstat，所有组件共用）。
 * 失败不当成"组件挂了"——只让 pid 变成 null，别把探针自己的问题算到被探对象头上。
 */
async function portPidMap(timeoutMs) {
  const map = new Map();
  const r = await runCapture('netstat', ['-ano'], Math.max(timeoutMs, 1500));
  if (!r.ok) return { map, error: r.error };
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = /^\s*TCP\s+\S*:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);
    if (!m) continue;
    const port = Number(m[1]);
    const pid = Number(m[2]);
    if (port && pid && !map.has(port)) map.set(port, pid);
  }
  return { map, error: null };
}

/**
 * 进程表（一次 PowerShell，拿 pid/启动时间/主窗口标题）。
 * 只查我们关心的几个映像名，别把 300 个进程都序列化一遍。
 */
async function processTable(images, timeoutMs, pids = []) {
  const list = images.map((x) => `'${String(x).replace(/'/g, "''")}'`).join(',');
  const idList = pids.filter((x) => Number(x) > 0).join(',');
  // 两类都要：①按映像名（窗口壳要拿主窗口标题）②按端口反查到的 pid（DSH 这种不叫 node 的也要 uptime）
  const script =
    `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ` +
    `$n=@(${list}); ` +
    `$p=@(); ` +
    (idList ? `$p+=Get-Process -Id @(${idList}) -ErrorAction SilentlyContinue; ` : '') +
    `$p+=Get-Process -ErrorAction SilentlyContinue | Where-Object { $n -contains $_.ProcessName }; ` +
    `$p | Sort-Object Id -Unique | Select-Object Id,ProcessName,@{n='startMs';e={ try { [long]([DateTimeOffset]$_.StartTime).ToUnixTimeMilliseconds() } catch { 0 } }},MainWindowTitle | ConvertTo-Json -Compress`;
  const r = await runCapture(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    Math.max(timeoutMs, 2500)
  );
  const table = new Map();
  if (!r.ok) return { table, error: r.error };
  const text = r.stdout.trim();
  if (!text) return { table, error: null };
  let rows;
  try { rows = JSON.parse(text); } catch { return { table, error: '进程表 JSON 解析失败' }; }
  for (const row of Array.isArray(rows) ? rows : [rows]) {
    // startMs 由 PowerShell 直接给 epoch 毫秒——别拿 StartTime 的 7 位小数做 Date.parse（会 Invalid Date）
    const startedMs = Number(row?.startMs ?? 0) || null;
    table.set(Number(row.Id), {
      pid: Number(row.Id),
      name: String(row.ProcessName ?? ''),
      startedAt: startedMs,
      title: String(row.MainWindowTitle ?? '')
    });
  }
  return { table, error: null };
}

// ── 历史：只在"变了"时追加（不是每 10 秒都写，否则一天 8600 行没人看）──────────
const lastState = new Map(); // name -> { ok, at }

/**
 * 启动时从历史尾部回填"上次已知状态"。
 * 不这么做的话，每次重启 9340 都会把 10 个组件各写一条 `from:null` 的基线行——
 * 历史会被重启次数污染，也就看不出"什么时候挂的"了。
 */
function seedLastState() {
  try {
    const raw = fs.readFileSync(HISTORY_FILE, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean).slice(-400);
    for (const line of lines) {
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (!row?.name) continue;
      lastState.set(row.name, { ok: row.ok === true, at: Number(row.t ?? 0) });
    }
  } catch { /* 没有历史文件就是第一次跑 */ }
}
seedLastState();

function appendHistory(rows) {
  const lines = [];
  for (const row of rows) {
    const prev = lastState.get(row.name);
    if (prev && prev.ok === row.ok) continue;
    lines.push(JSON.stringify({
      t: now(),
      at: new Date().toISOString(),
      name: row.name,
      ok: row.ok,
      from: prev ? prev.ok : null,
      to: row.ok,
      error: row.lastError ?? null,
      detail: row.detail ?? null,
      pid: row.pid ?? null,
      port: row.port ?? null
    }));
    lastState.set(row.name, { ok: row.ok, at: now() });
  }
  if (!lines.length) return 0;
  try {
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    fs.appendFileSync(HISTORY_FILE, `${lines.join('\n')}\n`, 'utf8');
  } catch { /* 历史写不进去不该让接口挂 */ }
  return lines.length;
}

// ── 单组件：把 probes 跑完，全部通过才算 ok ────────────────────────────────
async function checkComponent(comp, ctx) {
  const compT0 = now();
  const timeoutMs = ctx.timeoutMs;
  const probes = Array.isArray(comp.probes) && comp.probes.length ? comp.probes : [{ type: 'port' }];
  const starts = [];

  for (const probe of probes) {
    const type = String(probe.type ?? 'port');
    if (type === 'port') {
      const port = Number(probe.port ?? comp.port);
      const host = String(probe.host ?? comp.host ?? '127.0.0.1');
      starts.push(tcpProbe(host, port, timeoutMs).then((r) => ({ probe, ...r })));
    } else if (type === 'http') {
      let base = null;
      let port = Number(probe.port ?? comp.port);
      if (probe.urlFrom === 'dsh') {
        base = ctx.dshBase;
        if (base) {
          try { port = Number(new URL(base).port); } catch { /* ignore */ }
        }
      }
      const target = base
        ? `${base.replace(/\/+$/, '')}${probe.path ?? '/'}`
        : `http://127.0.0.1:${port}${probe.path ?? '/'}`;
      starts.push(httpProbe(target, timeoutMs, probe.acceptStatus ?? null).then((r) => ({ probe, ...r, target })));
    } else if (type === 'process') {
      const image = String(probe.image ?? comp.image ?? '');
      const { procs } = await ctx.ready;
      const hit = [...procs.values()].filter((p) => p.name.toLowerCase() === image.toLowerCase());
      const requireWindow = probe.requireWindow === true;
      const withWindow = hit.filter((p) => p.title);
      const ok = hit.length > 0 && (!requireWindow || withWindow.length > 0);
      const error = hit.length
        ? (requireWindow && !withWindow.length ? `${image} 在跑但主窗口标题为空（最小化到托盘？）` : null)
        : `进程 ${image} 不存在`;
      starts.push(Promise.resolve({ probe, ok, error, hit: withWindow.length ? withWindow : hit }));
    } else if (type === 'vmfile') {
      // WS-012：**两个来源不许各自判断**。能用 /api/wecom/status 就以它为准（它是 WC-007 的权威口，
      // 背后是 VM 上常驻 watcher 的 hwnd/visible/session）；status 调不到才退回读 json 文件（带年龄上限）。
      const file = path.join(WORKSPACE, String(probe.file ?? 'state/wecom-vm-health.json'));
      const maxAge = Number(probe.maxAgeMs ?? 180000);
      const statusUrl = probe.statusUrl === false ? null
        : String(probe.statusUrl ?? comp.statusUrl ?? 'http://127.0.0.1:9340/api/wecom/status');
      let viaStatus = false;
      let vmStatus = null;
      let statusError = null;
      if (statusUrl) {
        const r = await httpJson(statusUrl, Number(probe.statusTimeoutMs ?? 3000));
        if (r.ok && r.json && typeof r.json === 'object' && r.json.vm) {
          vmStatus = r.json.vm;
          viaStatus = true;
          const tsMs = Number.isFinite(Date.parse(String(vmStatus.checkedAt ?? ''))) ? Date.parse(String(vmStatus.checkedAt)) : now();
          lastVmStatus = { at: now(), vm: vmStatus, sourceTs: tsMs };
        } else statusError = r.error ?? `status 返回异常（HTTP ${r.status ?? '—'}）`;
      }

      if (!viaStatus && lastVmStatus.vm && now() - lastVmStatus.at < 120000) {
        // 不超过 2 分钟的旧结论，比"文件年龄"更接近 status 的真实口径；明确标成 status-memo
        vmStatus = lastVmStatus.vm;
        viaStatus = 'memo';
      }

      if (viaStatus) {
        const checkedAtMs = Number.isFinite(Date.parse(String(vmStatus.checkedAt ?? ''))) ? Date.parse(String(vmStatus.checkedAt)) : now();
        const ageSec = Math.max(0, Math.round((now() - checkedAtMs) / 1000));
        const okv = vmStatus.ok === true;
        let error = null;
        if (!okv) {
          const bits = [`vm.ok=false`];
          if (vmStatus.code) bits.push(`code=${vmStatus.code}`);
          if (vmStatus.hwnd != null) bits.push(`hwnd=${vmStatus.hwnd}`);
          if (vmStatus.detail) bits.push(String(vmStatus.detail));
          error = `以 /api/wecom/status 为准：${bits.join('，')}`;
        }
        starts.push(Promise.resolve({
          probe, ok: okv, error,
          viaStatus, sourceTs: checkedAtMs, ageSec,
          statusCheckedAt: new Date(checkedAtMs).toISOString(),
          detailStatus: viaStatus === 'memo'
            ? `上次 status 结论（本次 status 不可达：${statusError ?? '未知'}）：vm.ok=${okv} hwnd=${vmStatus.hwnd ?? '—'} age=${ageSec}s`
            : `以 /api/wecom/status 为准：vm.ok=${okv} hwnd=${vmStatus.hwnd ?? '—'} session=${vmStatus.session ?? '—'} age=${ageSec}s`
        }));
      } else {
        // status 没拿到（超时/挂）→ 退回文件；**顺手在后台把 status 的缓存预热一下**，
        // 下一次（≥10s 后）就能回到"以 status 为准"，不至于长期落在文件口径上。
        if (statusUrl) {
          Promise.resolve().then(() => httpJson(statusUrl, 8000)).catch(() => { /* ignore */ });
        }
        let data = null;
        let ageMs = null;
        let sourceTs = null;
        let error = null;
        let staleNote = statusError ? `status 不可用（${statusError}），退回读 ${path.basename(file)}；` : '';
        try {
          const st = fs.statSync(file);
          ageMs = now() - st.mtimeMs;
          sourceTs = st.mtimeMs;
          data = readJson(file);
          const sshOk = data?.ssh?.ok === true;
          const wpids = Array.isArray(data?.wxwork?.pids) ? data.wxwork.pids : [];
          const pidOk = Number(data?.wxwork?.pid ?? 0) > 0 || wpids.length > 0;
          const hwndOk = Number(data?.window?.hwnd ?? 0) > 0;
          const fresh = ageMs <= maxAge;
          const ageSec = Math.round(ageMs / 1000);
          if (!fresh) error = `${staleNote}VM 探针数据 ${ageSec}s 没更新（上限 ${Math.round(maxAge / 1000)}s）`;
          else if (!sshOk) error = `${staleNote}SSH 不通：${data?.ssh?.tcpError ?? data?.ssh?.error ?? '未成功'}`;
          else if (!pidOk) error = `${staleNote}SSH 通但 WXWork.exe 不在（企微被关了？）`;
          else if (!hwndOk) error = `${staleNote}WXWork.exe 在跑但没有主窗口（最小化到托盘 / 未登录）`;
          starts.push(Promise.resolve({
            probe, ok: !error, error, data, ageMs, ageSec, sourceTs, viaStatus: false,
            detailStatus: `${staleNote}vm 文件 age=${ageSec}s（上限 ${Math.round(maxAge / 1000)}s）`
          }));
        } catch (e) {
          starts.push(Promise.resolve({
            probe, ok: false, error: `${staleNote}读不到 VM 探针数据：${e.message}`,
            data: null, ageMs: null, ageSec: null, sourceTs: null, viaStatus: false, detailStatus: 'VM 数据不可读'
          }));
        }
      }
    } else if (type === 'bom') {
      // UG-040：扫 state\ 与 config\ 下的 json，只要有一个带 BOM 就算这条挂（BOM 会让 JSON.parse 静默失败）
      const dirs = (probe.dirs ?? ['state', 'config']).map((d) => path.join(WORKSPACE, d));
      const hits = [];
      let scanned = 0;
      const walkJson = (dir) => {
        let ents = [];
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const ent of ents) {
          const full = path.join(dir, ent.name);
          if (ent.isDirectory()) { walkJson(full); continue; }
          if (!ent.isFile() || !/\.json$/i.test(ent.name)) continue;
          scanned += 1;
          if (hasBom(full)) hits.push(path.relative(WORKSPACE, full).replace(/\\/g, '/'));
        }
      };
      for (const d of dirs) walkJson(d);
      const ok = hits.length === 0;
      starts.push(Promise.resolve({
        probe, ok,
        error: ok ? null : `${hits.length} 个 json 带 BOM：${hits.slice(0, 3).join('、')}${hits.length > 3 ? '…' : ''}（修：node scripts\\check-json-bom.mjs --fix）`,
        bomFiles: hits,
        detailStatus: `扫了 ${scanned} 个 json｜带 BOM ${hits.length}`
      }));
    } else if (type === 'self') {
      starts.push(Promise.resolve({ probe, ok: true, error: null, self: ctx.self }));
    } else {
      starts.push(Promise.resolve({ probe, ok: false, error: `未知探针类型 ${type}` }));
    }
  }

  const results = await Promise.all(starts);
  for (const r of results) r.ms = Math.max(0, now() - compT0);
  const failed = results.filter((r) => !r.ok);
  const ok = failed.length === 0;

  // pid / uptime / 端口：从端口映射或进程表里补
  let { portPid, procs } = await ctx.ready;
  let pid = null;
  let port = /^\d+$/.test(String(comp.port ?? '')) ? Number(comp.port) : null;
  if (!port && String(comp.port ?? '') === 'dsh' && ctx.dshBase) {
    try { port = Number(new URL(ctx.dshBase).port) || null; } catch { port = null; }
  }
  // 端口在听、但 30s 缓存表里还没有它（刚被守护拉起来）→ 这一个组件强制刷一次表，pid 立刻能补上
  if (ok && port && !portPid.has(port)) {
    const fresh = await ctx.refreshTables();
    portPid = fresh.portPid;
    procs = fresh.procs;
  }
  if (ok && port) pid = portPid.get(port) ?? null;
  for (const r of results) {
    if (r.hit?.length) { pid = r.hit[0].pid; break; }
  }
  // 自身组件：优先信"谁在听这个端口"，CLI 跑的时候那个才是工作台；退化才用自己的 pid
  if (comp.self === true || results.some((r) => r.self)) {
    pid = (port && portPid.get(port)) ?? ctx.self.pid;
  }

  let uptimeSec = null;
  if (pid != null) {
    const proc = procs.get(pid);
    if (proc?.startedAt) uptimeSec = Math.max(0, Math.round((now() - proc.startedAt) / 1000));
    else if (results.some((r) => r.self) && ctx.self.startedAt) uptimeSec = Math.max(0, Math.round((now() - ctx.self.startedAt) / 1000));
  }

  const detailParts = results.map((r) => {
    const t = String(r.probe.type ?? 'port');
    if (t === 'http' && r.target) return `${r.target} → ${r.status ?? '—'}`;
    // WS-012：vmfile 现在优先走 /api/wecom/status，detail 里必须写清"以谁为准 + 数据多老"
    if (t === 'vmfile') return r.detailStatus ?? (r.data
      ? `ssh=${r.data?.ssh?.ok} pid=${r.data?.wxwork?.pid} hwnd=${r.data?.window?.hwnd} age=${r.ageSec ?? 0}s`
      : 'vm 数据不可读');
    if (t === 'bom') return r.detailStatus ?? (ok ? 'ok' : (r.error ?? 'failed'));
    if (t === 'process' && r.hit?.length) return `${r.hit[0].name} pid=${r.hit[0].pid}${r.hit[0].title ? ` 窗口="${r.hit[0].title}"` : ''}`;
    return ok ? 'ok' : (r.error ?? 'failed');
  });

  // WS-012：把"这个判断基于哪一刻的数据"提到组件层——前端不用再去翻 probes
  const vmProbe = results.find((r) => String(r.probe.type) === 'vmfile');
  const sourceTs = vmProbe?.sourceTs ?? null;
  const ageSec = vmProbe?.ageSec ?? null;

  return {
    name: String(comp.name ?? comp.id ?? '未命名'),
    kind: String(comp.kind ?? 'service'),
    ok,
    pid: pid ?? null,
    uptimeSec,
    port: port ?? null,
    lastError: ok ? null : (failed.map((f) => f.error).filter(Boolean).join('；') || '失败（无细节）'),
    detail: detailParts.join(' ｜ '),
    sourceTs: sourceTs == null ? null : new Date(sourceTs).toISOString(),
    ageSec,
    via: vmProbe ? (vmProbe.viaStatus === true ? 'status' : (vmProbe.viaStatus === 'memo' ? 'status-memo' : 'file')) : null,
    probes: results.map((r) => ({
      type: String(r.probe.type ?? 'port'), ok: r.ok, ms: r.ms ?? null,
      error: r.error ?? null, note: r.note ?? null,
      ...(r.sourceTs != null ? { sourceTs: new Date(r.sourceTs).toISOString(), ageSec: r.ageSec ?? null, via: r.viaStatus === true ? 'status' : (r.viaStatus === 'memo' ? 'status-memo' : 'file') } : {})
    })),
    critical: comp.critical !== false
  };
}

// ── 主入口 ────────────────────────────────────────────────────────────────
/**
 * 采集所有组件状态。
 * @param {{force?: boolean, self?: {pid?: number, startedAt?: number}}} opts
 * @returns {Promise<object>} {ok, at, iso, tookMs, cached, total, alive, dead, components[]}
 */
export async function collectComponents({ force = false, self = null } = {}) {
  const startedAt = now();
  let cfgPack;
  try {
    cfgPack = readConfig();
  } catch (e) {
    return {
      ok: false, at: startedAt, iso: new Date(startedAt).toISOString(), tookMs: now() - startedAt,
      cached: false, total: 0, alive: 0, dead: 0, components: [],
      error: `读不到 state\\health-components.json：${e.message}`
    };
  }
  const { cfg, timeoutMs, components, mtime } = cfgPack;

  if (!force && lastPayload && lastConfigMtime === mtime && now() - lastAt < Number(cfg.cacheMs ?? CACHE_MS)) {
    return { ...lastPayload, cached: true, ageMs: now() - lastAt };
  }

  // DSH 地址：能解析就解析，解析不了只影响 DSH 那一条（不让其他组件陪葬）
  let dshBase = null;
  let dshError = null;
  try { dshBase = resolveDshBase({}).url; } catch (e) { dshError = String(e?.message ?? e).split('\n')[0]; }

  const images = ['node', 'XunyuWebWindow'];
  for (const c of components) {
    for (const p of c.probes ?? []) if (p?.type === 'process' && p.image) images.push(String(p.image));
    if (c.image) images.push(String(c.image));
  }

  // 端口映射 → 进程表：串行（后者要用前者的 pid），但**和组件探针并行跑**——
  // 这样黑洞端口那种 800ms 的等待跟 600ms 的表查询重叠，不再相加。
  // 表本身另有一层 30s 缓存：uptime 不需要 10 秒级精度，但 netstat+PowerShell 每次 ~600ms 太贵。
  const ready = (async () => {
    if (tableCache.at && now() - tableCache.at < TABLE_TTL_MS) return tableCache.value;
    const pr = await portPidMap(timeoutMs);
    const wantPids = [...new Set([...pr.map.values()])];
    const procRes = await processTable([...new Set(images)], timeoutMs, wantPids);
    const value = { portPid: pr.map, procs: procRes.table };
    tableCache.at = now();
    tableCache.value = value;
    return value;
  })();
  // 缓存表过期判断只认 30s；刚被拉起的服务端口在听、表里却还没有它 → 允许单个组件强制刷一次
  const refreshTables = async () => {
    tableCache.at = 0;
    tableCache.value = null;
    const pr = await portPidMap(timeoutMs);
    const wantPids = [...new Set([...pr.map.values()])];
    const procRes = await processTable([...new Set(images)], timeoutMs, wantPids);
    tableCache.at = now();
    tableCache.value = { portPid: pr.map, procs: procRes.table };
    return tableCache.value;
  };

  const ctx = {
    timeoutMs,
    ready,
    refreshTables,
    dshBase,
    self: {
      pid: Number(self?.pid ?? cfg?.self?.pid ?? process.pid),
      startedAt: Number(self?.startedAt ?? cfg?.self?.startedAt ?? now())
    }
  };

  const rows = await Promise.all(components.map((c) => checkComponent(c, ctx)));

  if (dshError && components.some((c) => (c.probes ?? []).some((p) => p?.urlFrom === 'dsh'))) {
    const dshRow = rows.find((r) => r.name.includes('DSH'));
    if (dshRow && !dshRow.ok && !dshRow.lastError.includes('DSH')) {
      dshRow.lastError = `${dshRow.lastError}；另外 DSH 地址解析失败：${dshError}`;
    }
  }

  const changed = appendHistory(rows);
  const alive = rows.filter((r) => r.ok).length;
  const payload = {
    ok: true,
    tool: 'health-components',
    version: '1.0.0',
    at: startedAt,
    iso: new Date(startedAt).toISOString(),
    tookMs: now() - startedAt,
    cached: false,
    cacheMs: Number(cfg.cacheMs ?? CACHE_MS),
    timeoutMs,
    total: rows.length,
    alive,
    dead: rows.length - alive,
    historyAppended: changed,
    components: rows
  };
  lastPayload = payload;
  lastAt = startedAt;
  lastConfigMtime = mtime;
  return payload;
}

// ── CLI ──────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const argv = process.argv.slice(2);
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log('用法：node scripts\\health-components.mjs [--json] [--refresh]');
    process.exit(0);
  }
  const r = await collectComponents({ force: argv.includes('--refresh') });
  if (argv.includes('--json')) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log(`组件健康 ${r.iso}｜${r.alive}/${r.total} 活着｜耗时 ${r.tookMs}ms${r.cached ? '（缓存）' : ''}${r.error ? `｜${r.error}` : ''}`);
    for (const c of r.components) {
      const mark = c.ok ? '✓' : '✗';
      const extra = c.ok ? '' : `  ← ${c.lastError}`;
      console.log(`${mark} ${c.name.padEnd(16)}${String(c.kind).padEnd(10)}pid=${String(c.pid ?? '—').padEnd(7)}port=${String(c.port ?? '—').padEnd(5)}${c.ok ? '' : extra}`);
    }
  }
  process.exit(r.dead === 0 ? 0 : 1);
}

