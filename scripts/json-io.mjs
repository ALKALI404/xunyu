#!/usr/bin/env node
// scripts\json-io.mjs —— JSON 读写的唯一入口（UG-040，2026-10-30 07）
//
// 病根：`state\priority-list.json` 被 PowerShell `Out-File -Encoding UTF8` 写成**带 BOM**，
// 而 `workdesk-server.mjs` 里 `JSON.parse(fs.readFileSync(...))` 遇到 BOM 直接抛，
// 又被自己的 catch 吞成 `active=false` —— 优先队列形同不存在，接力照派名单外的票。
//
// 规矩（从此不许再手写 JSON.parse(fs.readFileSync(...))）：
//   · 读：**一律**走 readJson()，内部无条件剥 BOM；解析失败要报出**文件路径 + 首 40 字**，
//     不许静默当成"没有这个文件"。
//   · 写：一律走 writeJson()，UTF-8 **无 BOM**、2 空格缩进、结尾换行。
//
// 用法：
//   import { readJson, readJsonOr, writeJson } from './json-io.mjs';
//   const cfg = readJson(path.join(WORKSPACE,'state','x.json'));       // 失败抛错（带路径）
//   const cfg = readJsonOr(p, {});                                     // 失败返回兜底，但 BOM 照样剥
//
// 为什么不用 JSON.parse(readFileSync().replace(/^\uFEFF/,''))：61 处各写一遍，总有人忘；
// 忘一次就是今晚这种"优先队列静默失效"。集中在一个函数里，改一处全对。
import fs from 'node:fs';
import path from 'node:path';

/** 去掉开头的 BOM（只去一个；内容中间的 \uFEFF 不动，那是数据）。 */
export function stripBom(text) {
  const s = String(text ?? '');
  return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
}

/**
 * 读 JSON：去 BOM → parse。
 * @param {string} file 绝对或相对路径
 * @returns {any}
 * @throws 读不到 / 解析失败都会抛错，错误信息里带路径与首 40 字
 */
export function readJson(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    const err = new Error(`读不到 JSON ${file}：${error?.code ?? error?.message ?? error}`);
    err.path = file;
    err.code = error?.code ?? 'read-failed';
    throw err;
  }
  const text = stripBom(raw);
  try {
    return JSON.parse(text);
  } catch (error) {
    const head = text.replace(/\s+/g, ' ').trim().slice(0, 40);
    const err = new Error(`JSON 解析失败 ${file}：${error?.message ?? error}｜首 40 字：${JSON.stringify(head)}`);
    err.path = file;
    err.head = head;
    throw err;
  }
}

/** 读 JSON，失败时返回兜底值（**不吞 BOM**：BOM 照样被剥掉）。 */
export function readJsonOr(file, fallback = null) {
  try { return readJson(file); } catch { return fallback; }
}

/**
 * 写 JSON：`JSON.stringify(obj, null, 2)` + UTF-8 **无 BOM**。
 * @param {string} file
 * @param {any} obj
 * @returns {{bytes:number, path:string}}
 */
export function writeJson(file, obj) {
  const text = `${JSON.stringify(obj, null, 2)}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { encoding: 'utf8' });   // Node 的 utf8 写入永远不加 BOM
  return { bytes: Buffer.byteLength(text, 'utf8'), path: file };
}

/** 这个文件是不是带 BOM（只看前 3 字节）。 */
export function hasBom(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(3);
    const n = fs.readSync(fd, buf, 0, 3, 0);
    return n === 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
  } catch {
    return false;
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

/** 去掉磁盘上文件的 BOM（就地重写，保留其余字节）。返回是否改动。 */
export function stripBomFile(file) {
  if (!hasBom(file)) return false;
  const raw = fs.readFileSync(file);
  fs.writeFileSync(file, raw.subarray(3));
  return true;
}
