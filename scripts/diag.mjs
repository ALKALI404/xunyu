#!/usr/bin/env node
import { readJson as readJsonIo } from './json-io.mjs';
// scripts/diag.mjs —— 分层诊断器（UG-034）：先看接口层，再跑模块层，直接说坏在哪
//
// 用法：
//   node scripts\diag.mjs --feature <featureId> [--json] [--timeout 5000] [--projects <file>]
// 退出码：0 = 都通 ｜ 1 = 有坏层（看 layer/cause/fix）｜ 2 = 用法或数据错误
//
// 契约（改实现前先改这里）：
//   diagFeature(featureId) -> {
//     ok: boolean,
//     project, feature, name, contract,
//     interface: { ok: boolean, checks: [{name, ok, detail}] },
//     module:    { ran: boolean, ok: boolean|null, checks: [{name, ok, detail}] },
//     layer: 'ok' | 'interface' | 'module',
//     cause: '问题出在哪' 一句话,
//     fix:   '怎么解决' 一句话
//   }
//   规则：**接口层不过就不跑模块层**（module.ran=false），避免在错的基层上瞎调。
//
// 探针由项目栏声明（不声明就走保守兜底，并在输出里标明 fallback）：
//   feature.probe = { type:'http',   url, expectStatus? }        // 端点活着吗
//                 | { type:'file',   path, contains? }           // 文件在不在/含不含关键字
//                 | { type:'module', path, exports?: [..] }      // 模块能不能导入、导出齐不齐
//                 | { type:'command',cmd, expectExit? }          // 跑一条命令
//   feature.cases = [ { name, type:'http'|'file'|'module'|'command', ...同上 } ]
//
// 兜底（没声明 probe）：interface = contract 非空且形如 a.b.*；module = 该 feature 的票在台账里都查得到。

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, '..');

const argv = process.argv.slice(2);
const opt = (name, dflt = null) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
const json = argv.includes('--json');
const featureId = opt('feature', null);
const timeoutMs = Number(opt('timeout', 5000));
const projectsFile = opt('projects', null) || process.env.XUNYU_PROJECTS_FILE || path.join(WORKSPACE, 'state', 'projects.json');

if (!featureId) {
  process.stderr.write('用法：node scripts\\diag.mjs --feature <featureId> [--json] [--timeout 5000] [--projects <file>]\n');
  process.exit(2);
}

function readJson(file) {
  try { return readJsonIo(file); } catch { return null; }
}

/** 找 feature（跨项目按 id 找，重名取第一个） */
function findFeature(doc, id) {
  for (const p of doc?.projects ?? []) {
    for (const f of p.features ?? []) {
      if (String(f.id) === String(id)) return { project: p, feature: f };
    }
  }
  return null;
}

// ── 探针执行器 ────────────────────────────────────────────────────────────
async function runCheck(spec, label) {
  const name = spec?.name ? `${label}「${spec.name}」` : label;
  const type = String(spec?.type ?? '').toLowerCase();
  try {
    if (type === 'http') {
      const url = String(spec.url ?? '');
      if (!url) return { name, ok: false, detail: 'http 探针没给 url' };
      const expect = Number(spec.expectStatus ?? 200);
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      const ok = res.status === expect;
      return { name, ok, detail: `GET ${url} → ${res.status}（期望 ${expect}）` };
    }
    if (type === 'file') {
      const p = path.resolve(WORKSPACE, String(spec.path ?? ''));
      if (!fs.existsSync(p)) return { name, ok: false, detail: `文件不存在：${path.relative(WORKSPACE, p)}` };
      const text = fs.readFileSync(p, 'utf8');
      if (spec.contains) {
        const needle = String(spec.contains);
        const ok = new RegExp(needle).test(text) || text.includes(needle);
        return { name, ok, detail: `${path.relative(WORKSPACE, p)} ${ok ? '含' : '不含'} ${needle}` };
      }
      return { name, ok: true, detail: `文件存在：${path.relative(WORKSPACE, p)}` };
    }
    if (type === 'module') {
      const p = path.resolve(WORKSPACE, String(spec.path ?? ''));
      if (!fs.existsSync(p)) return { name, ok: false, detail: `模块不存在：${path.relative(WORKSPACE, p)}` };
      const mod = await import(pathToFileURL(p).href);
      const want = Array.isArray(spec.exports) ? spec.exports.map(String) : [];
      const missing = want.filter((k) => !(k in mod));
      const ok = missing.length === 0;
      return { name, ok, detail: `${path.relative(WORKSPACE, p)} 可导入；导出 ${want.length ? (ok ? '齐' : `缺 ${missing.join(',')}`) : '未指定'}` };
    }
    if (type === 'command') {
      const cmd = String(spec.cmd ?? '');
      if (!cmd) return { name, ok: false, detail: 'command 探针没给 cmd' };
      const expect = Number(spec.expectExit ?? 0);
      let exit = 0;
      let out = '';
      try {
        out = execSync(cmd, { cwd: WORKSPACE, stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, encoding: 'utf8' });
      } catch (e) {
        exit = typeof e.status === 'number' ? e.status : 1;
        out = String(e.stdout ?? '') || String(e.message ?? '');
      }
      const ok = exit === expect;
      const tail = String(out).trim().split(/\r?\n/).slice(-1)[0] ?? '';
      return { name, ok, detail: `${cmd} → exit=${exit}（期望 ${expect}）${tail ? `｜${tail.slice(0, 80)}` : ''}` };
    }
    return { name, ok: false, detail: `不认识的探针类型：${type || '(空)'}` };
  } catch (e) {
    return { name, ok: false, detail: `${type} 探针异常：${e?.message ?? e}` };
  }
}

const CONTRACT_RE = /^[a-z0-9-]+(\.[a-z0-9-*]+)+$/i;

async function diagFeature(id) {
  const doc = readJson(projectsFile);
  if (!doc) return { ok: false, error: `读不到 ${projectsFile}`, layer: 'interface', cause: '项目栏读不到', fix: '确认 state\\projects.json 可读（05 维护）' };
  const hit = findFeature(doc, id);
  if (!hit) return { ok: false, error: `项目栏里没有 feature「${id}」`, layer: 'interface', cause: `feature ${id} 不存在`, fix: '先在项目栏登记这个功能域（或检查 --feature 拼写）' };

  const { project, feature } = hit;
  const contract = String(feature.contract ?? '').trim();
  const out = {
    ok: false, project: project.id, feature: feature.id, name: feature.name ?? '',
    contract: contract || null, projectsFile: path.relative(WORKSPACE, projectsFile),
    interface: { ok: false, checks: [] }, module: { ran: false, ok: null, checks: [] },
    layer: 'interface', cause: '', fix: '', fallback: { probe: !feature.probe, cases: !Array.isArray(feature.cases) || !feature.cases.length }
  };

  // ── ① 接口层 ──
  if (!contract) {
    out.interface.checks.push({ name: '项目栏 contract', ok: false, detail: 'feature.contract 是空的（没有接口定义）' });
  } else if (!CONTRACT_RE.test(contract)) {
    out.interface.checks.push({ name: '项目栏 contract', ok: false, detail: `contract「${contract}」不像接口命名（期望 a.b.* 这种）` });
  } else {
    out.interface.checks.push({ name: '项目栏 contract', ok: true, detail: contract });
  }
  if (feature.probe) {
    out.interface.checks.push(await runCheck(feature.probe, '接口探针'));
  } else {
    out.interface.checks.push({ name: '接口探针', ok: true, detail: '未声明 probe（兜底：只校验了 contract 本身）' });
  }
  out.interface.ok = out.interface.checks.every((c) => c.ok);

  // ── ② 模块层（接口不过就不跑）──
  if (!out.interface.ok) {
    out.module.ran = false;
    out.module.ok = null;
    out.layer = 'interface';
    const bad = out.interface.checks.filter((c) => !c.ok).map((c) => c.detail);
    out.cause = `接口层：${bad.join('；')}`;
    out.fix = !contract
      ? `给 ${project.id}/${feature.id} 补 contract（形如 auto.exe.*），再重跑 diag`
      : `先把上面接口层那条修好（端点/文件/导出/命令），接口层绿了才会继续跑模块层`;
    return out;
  }

  out.module.ran = true;
  if (Array.isArray(feature.cases) && feature.cases.length) {
    for (const c of feature.cases) out.module.checks.push(await runCheck(c, '模块用例'));
  } else {
    // 兜底：没有用例时，至少确认"这域的票在台账里都查得到"（不是功能验证，但能抓数据错误）
    let tasks = [];
    try { ({ replay: tasks } = await import('./worklist-core.mjs')); } catch { tasks = null; }
    const tickets = (feature.tickets ?? []).map((t) => String(t).trim()).filter(Boolean);
    if (!tasks) {
      out.module.checks.push({ name: '模块用例（兜底）', ok: true, detail: '台账读不到，跳过（不算通过证据）' });
    } else if (!tickets.length) {
      out.module.checks.push({ name: '模块用例（兜底）', ok: true, detail: '该域还没有票，无从验证' });
    } else {
      const all = tasks();
      const missing = tickets.filter((tk) => !all.some((t) => String(t.ticket ?? '').toUpperCase() === tk.toUpperCase()));
      out.module.checks.push({
        name: '模块用例（兜底）',
        ok: missing.length === 0,
        detail: missing.length ? `台账里查不到：${missing.join('、')}` : `${tickets.length} 张票在台账里都查得到（未声明 cases，只做了数据一致性检查）`
      });
    }
  }
  out.module.ok = out.module.checks.every((c) => c.ok);

  if (out.module.ok) { out.ok = true; out.layer = 'ok'; out.cause = '接口层与模块层都通'; out.fix = '不用动'; }
  else {
    out.ok = false; out.layer = 'module';
    const bad = out.module.checks.filter((c) => !c.ok).map((c) => c.detail);
    out.cause = `模块层：${bad.join('；')}`;
    out.fix = '接口层是好的，问题在实现：按失败的那条用例去改模块，改完重跑 diag（别去动接口）';
  }
  return out;
}

function render(r) {
  const lines = [];
  if (r.error) {
    lines.push(`diag ${featureId}：✗ ${r.error}`);
    lines.push(`  问题出在哪：${r.cause}`);
    lines.push(`  怎么解决：${r.fix}`);
    return lines.join('\n');
  }
  lines.push(`diag ${r.feature}（${r.project} / ${r.name}）｜contract: ${r.contract ?? '（空）'}`);
  lines.push(`  ① 接口层：${r.interface.ok ? 'PASS' : 'FAIL'}`);
  for (const c of r.interface.checks) lines.push(`      ${c.ok ? '✓' : '✗'} ${c.name}：${c.detail}`);
  if (!r.module.ran) {
    lines.push('  ② 模块层：未运行（接口层不过就停——不在错的基层上瞎调）');
  } else {
    lines.push(`  ② 模块层：${r.module.ok ? 'PASS' : 'FAIL'}`);
    for (const c of r.module.checks) lines.push(`      ${c.ok ? '✓' : '✗'} ${c.name}：${c.detail}`);
  }
  if (r.fallback?.probe || r.fallback?.cases) {
    lines.push(`  注：${[r.fallback.probe ? '没声明 probe' : '', r.fallback.cases ? '没声明 cases' : ''].filter(Boolean).join('、')}，模块层用的是兜底检查`);
  }
  lines.push(`  结论：layer=${r.layer}`);
  lines.push(`  问题出在哪：${r.cause}`);
  lines.push(`  怎么解决：${r.fix}`);
  return lines.join('\n');
}

const result = await diagFeature(featureId);
if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
else process.stdout.write(`${render(result)}\n`);
process.exitCode = result.ok ? 0 : (result.error ? 2 : 1);
