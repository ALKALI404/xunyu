#!/usr/bin/env node
import { readJson } from './json-io.mjs';
// scripts/build-exe.mjs —— Node SEA 打包器（UG-029 技术验证）
//
// 一条命令：esbuild 把脚本打成单文件 → node --experimental-sea-config 生成 blob →
//          复制当前 node.exe → postject 注入 → dist\<name>.exe + <name>.build.json
//
// ===== 接口契约（UG-034 接口优先；本文件是第一实现）=====
// 用法：
//   node scripts\build-exe.mjs --entry <js> --name <exe> [--out dist\]
//   node scripts\build-exe.mjs <name>                  # 兼容旧写法：读 build\sea-<name>.json
// 参数：
//   --entry <js>     入口脚本（相对工作区或绝对路径）。新的写法必填。
//   --name  <exe>    产物基名：dist\<name>.exe + dist\<name>.build.json。新的写法必填。
//   --out   <dir>    输出目录，默认 dist\
//   --format <cjs|esm>   bundle 格式，默认取配置、再默认 esm
//   --keep           保留中间产物（bundle / sea.json / blob）
//   -h, --help       打用法，退出码 0
// 输入约定（可选）：build\sea-<name>.json 存在时当"默认值"读，命令行参数优先。
// 产物：
//   <out>\<name>.exe            独立可执行文件（内嵌 node 运行时 + SEA blob）
//   <out>\<name>.build.json     构建清单 {entry, nodeVersion, sizeBytes, builtAt}
//                               entry = 相对工作区、正斜杠；builtAt = ISO 8601 UTC
// 退出码：
//   0 = 构建成功（exe + build.json 均已落盘）
//   1 = 构建失败（esbuild / sea-config / 复制 / postject 任一步出错；不留半成品清单）
//   2 = 用法或入参错误（缺参数、未知参数、entry 不存在、配置读不动）
//
// 为什么用 cjs shim：SEA 的 main 走 CommonJS 最稳；脚本里用 import.meta.url 算工作区的，
// 打包时用 esbuild --define 把它钉成"工作区路径"，否则 exe 里会算到一个不存在的位置。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { build as esbuild } from 'esbuild';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, '..');
const BUILD = path.join(WORKSPACE, 'build');
const DIST = path.join(WORKSPACE, 'dist');

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;

const USAGE = [
  '用法：',
  '  node scripts\\build-exe.mjs --entry <js> --name <exe> [--out dist\\] [--format cjs|esm] [--keep]',
  '  node scripts\\build-exe.mjs <name>        # 兼容旧写法：读 build\\sea-<name>.json',
  '',
  '退出码：0 成功 / 1 构建失败 / 2 用法或入参错误'
].join('\n');

class UsageError extends Error {}

/** 解析参数；不认识的一律 UsageError（不静默忽略拼错的参数） */
function parseArgs(argv) {
  const out = { keep: false, format: null, entry: null, name: null, outDir: null, positional: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const need = () => {
      const v = argv[++i];
      if (v == null || v.startsWith('--')) throw new UsageError(`参数 ${a} 缺少取值`);
      return v;
    };
    if (a === '-h' || a === '--help') { out.help = true; continue; }
    if (a === '--keep') { out.keep = true; continue; }
    if (a === '--entry') { out.entry = need(); continue; }
    if (a === '--name') { out.name = need(); continue; }
    if (a === '--out') { out.outDir = need(); continue; }
    if (a === '--format') {
      const v = need();
      if (v !== 'cjs' && v !== 'esm') throw new UsageError(`--format 只认 cjs / esm，收到 ${v}`);
      out.format = v;
      continue;
    }
    if (a.startsWith('-')) throw new UsageError(`未知参数 ${a}`);
    if (out.positional != null) throw new UsageError(`多余的参数 ${a}（只接受一个位置参数 <name>）`);
    out.positional = a;
  }
  return out;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    if (e instanceof UsageError) { console.error(`✗ ${e.message}\n\n${USAGE}`); return EXIT_USAGE; }
    throw e;
  }
  if (args.help) { console.log(USAGE); return EXIT_OK; }

  // 新写法至少要有 --entry；只有位置参数时按旧写法当配置键
  if (!args.entry && !args.positional) {
    console.error(`✗ 缺少 --entry（或旧写法的 <name> 位置参数）\n\n${USAGE}`);
    return EXIT_USAGE;
  }
  // 新写法里 --entry 与 --name 必须成对；缺 name 不许悄悄拼出个 xunyu-null
  if (args.entry && !args.name) {
    console.error(`✗ 给了 --entry 就必须给 --name（产物基名）\n\n${USAGE}`);
    return EXIT_USAGE;
  }

  // 配置：build\sea-<name>.json 当作默认值，命令行优先（旧写法完全靠它）
  const cfgKey = args.name ?? args.positional;
  let cfg = {};
  if (cfgKey) {
    const cfgPath = path.join(BUILD, `sea-${cfgKey}.json`);
    if (fs.existsSync(cfgPath)) {
      try {
        cfg = readJson(cfgPath);
      } catch (e) {
        console.error(`✗ 读不动配置 ${cfgPath}：${e.message}`);
        return EXIT_USAGE;
      }
    } else if (!args.entry) {
      console.error(`✗ 读不到配置 ${cfgPath}（旧写法需要它；新写法请改用 --entry/--name）`);
      return EXIT_USAGE;
    }
  }

  // 解析最终入参
  if (!args.entry) {
    // 旧写法：entry 必须由配置给
    if (!cfg.entry) { console.error(`✗ 配置 ${cfgKey} 里没有 entry，且命令行也没给 --entry`); return EXIT_USAGE; }
    args.entry = cfg.entry;
  }
  const entry = path.resolve(WORKSPACE, args.entry);
  if (!fs.existsSync(entry)) { console.error(`✗ entry 不存在：${entry}`); return EXIT_USAGE; }

  const exeName = args.name ?? cfg.name ?? `xunyu-${cfgKey}`;
  if (!exeName || /[\\/:*?"<>|]/.test(exeName)) {
    console.error(`✗ --name 不是合法文件名基名：${exeName}`);
    return EXIT_USAGE;
  }
  // 输出目录：--out 优先，其次配置里的 output 目录，最后 dist\
  const outDir = args.outDir
    ? path.resolve(WORKSPACE, args.outDir)
    : cfg.output ? path.resolve(WORKSPACE, path.dirname(cfg.output)) : DIST;
  const outExe = path.join(outDir, `${exeName}.exe`);
  const manifestPath = path.join(outDir, `${exeName}.build.json`);
  const format = args.format ?? cfg.format ?? 'esm';
  const workspace = String(cfg.workspace ?? WORKSPACE).replace(/\\/g, '/');

  fs.mkdirSync(BUILD, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  const t0 = Date.now();
  const step = (msg) => console.log(`[build] ${msg}`);

  // ① 打成单文件（脚本之间的相对 import 全并进来）
  const bundlePath = path.join(BUILD, `${exeName}.bundle.${format === 'esm' ? 'mjs' : 'cjs'}`);
  const shimPath = path.join(BUILD, `${exeName}.shim.cjs`);
  const seaCfgPath = path.join(BUILD, `${exeName}.sea.json`);
  const blobPath = path.join(BUILD, `${exeName}.blob`);
  const assetKey = `${exeName}.bundle.mjs`;
  const define = {
    // SEA 里没有"脚本文件路径"，把工作区钉死，脚本里的 resolve(dirname(import.meta.url), '..') 才能落对
    'import.meta.url': JSON.stringify(`file:///${workspace}/scripts/${path.basename(entry)}`),
    '__SEA_BUILD__': 'true'
  };
  await esbuild({
    entryPoints: [entry],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format,
    target: 'node20',
    define,
    // file:/// 绝对路径的 import()（dsh-client / dsh-base）是**运行时**才解析的，打包时按外部处理
    external: cfg.external ?? [],
    plugins: [{
      name: 'external-file-url',
      setup(b) { b.onResolve({ filter: /^file:\/\// }, (a) => ({ path: a.path, external: true })); }
    }],
    logLevel: 'warning',
    banner: format === 'esm' ? undefined : { js: '/* bundled for Node SEA by scripts/build-exe.mjs */' }
  });
  const bundleBytes = fs.statSync(bundlePath).size;
  step(`bundle ${path.relative(WORKSPACE, bundlePath)}  ${(bundleBytes / 1024).toFixed(0)} KB`);

  // ② SEA 配置 + 生成 blob
  //   为什么这么绕：SEA 的 main 目前必须是 CommonJS，而脚本里有顶层 await（只能 ESM）。
  //   做法 = CJS 小壳子（读 SEA asset 里的 ESM bundle → 用 data: URL 动态 import），两条都满足。
  fs.writeFileSync(shimPath, [
    "'use strict';",
    "const sea = require('node:sea');",
    "const fs = require('node:fs');",
    "let code = null;",
    "try { code = sea.getAsset('" + assetKey + "', 'utf8'); } catch (e) { /* 非 SEA 环境 */ }",
    "if (code == null) { console.error('这个 shim 只在 SEA 里跑'); process.exit(1); }",
    "const url = 'data:text/javascript;base64,' + Buffer.from(code, 'utf8').toString('base64');",
    "import(url).catch((e) => { console.error(e); process.exit(1); });",
    ""
  ].join('\n'), 'utf8');

  const seaJson = {
    main: shimPath,
    output: blobPath,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    assets: {}
  };
  seaJson.assets[assetKey] = bundlePath;
  fs.writeFileSync(seaCfgPath, JSON.stringify(seaJson, null, 2), 'utf8');
  execFileSync(process.execPath, ['--experimental-sea-config', seaCfgPath], { stdio: 'inherit', cwd: WORKSPACE });
  const blobBytes = fs.statSync(blobPath).size;
  step(`blob ${path.relative(WORKSPACE, blobPath)}  ${(blobBytes / 1024).toFixed(0)} KB（main=CJS shim，ESM bundle 走 asset）`);

  // ③ 复制 node.exe（先写到临时文件：注入失败时旧 exe 不受牵连，也不留半成品）
  const tmpExe = path.join(outDir, `.${exeName}.exe.tmp`);
  fs.copyFileSync(process.execPath, tmpExe);
  step(`copy ${path.relative(WORKSPACE, tmpExe)}  ${(fs.statSync(tmpExe).size / 1024 / 1024).toFixed(1)} MB（来自 ${process.execPath}）`);

  // ④ postject 注入（fuse 名称是 Node 官方固定值）
  const postject = path.join(WORKSPACE, 'node_modules', 'postject', 'dist', 'cli.js');
  if (!fs.existsSync(postject)) {
    console.error(`✗ 找不到 postject：${postject}（先在仓库根 npm i -D postject esbuild）`);
    try { fs.unlinkSync(tmpExe); } catch { /* ignore */ }
    return EXIT_FAIL;
  }
  try {
    execFileSync(process.execPath, [postject, tmpExe, 'NODE_SEA_BLOB', blobPath,
      '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'], { stdio: 'inherit', cwd: WORKSPACE });
  } catch (e) {
    console.error(`✗ postject 注入失败：${e.message}`);
    console.error('  常见原因：node.exe 带 Authenticode 签名（需要 signtool remove /s），或产物正被占用。');
    try { fs.unlinkSync(tmpExe); } catch { /* ignore */ }
    return EXIT_FAIL;
  }
  // 注入成功才落到正式路径（覆盖上一次的 exe）
  fs.renameSync(tmpExe, outExe);

  if (!args.keep) {
    for (const f of [bundlePath, shimPath, seaCfgPath, blobPath]) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  }

  // ⑤ 构建清单（产物约定的一部分：exe 旁边必须有 <name>.build.json）
  const finalBytes = fs.statSync(outExe).size;
  const manifest = {
    entry: path.relative(WORKSPACE, entry).replace(/\\/g, '/'),
    nodeVersion: process.version,
    sizeBytes: finalBytes,
    builtAt: new Date().toISOString()
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  const ms = Date.now() - t0;
  console.log(`[build] ✓ ${path.relative(WORKSPACE, outExe)}  ${(finalBytes / 1024 / 1024).toFixed(1)} MB  用时 ${(ms / 1000).toFixed(1)}s`);
  console.log(`[build] manifest ${path.relative(WORKSPACE, manifestPath)}`);
  console.log(JSON.stringify({ ok: true, exe: path.relative(WORKSPACE, outExe), manifest: path.relative(WORKSPACE, manifestPath), bytes: finalBytes, ms, bundleBytes, blobBytes, node: process.version }, null, 2));
  return EXIT_OK;
}

try {
  process.exitCode = await main();
} catch (e) {
  // 任何未预期异常都算"构建失败"，绝不以 0 退出
  console.error(`✗ 构建失败：${e && e.message ? e.message : e}`);
  process.exitCode = EXIT_FAIL;
}
