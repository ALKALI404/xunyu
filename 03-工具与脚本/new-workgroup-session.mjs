// 用桥接自己的 DSH 客户端建一个新会话（不需要改桥接代码：直接复用它的 NodeApiClient）
// 流程：workspace.create(<工作区>) → sessions.create → prompt(交接稿)
//
// 用法（在 <工作区> 下）：
//   node new-workgroup-session.mjs                  用根目录最新一份 交接-*.md 建会话并投递
//   node new-workgroup-session.mjs --dry            只打印「用哪份稿、发什么」，不建会话
//   node new-workgroup-session.mjs --handoff <路径>  指定某一份稿
//
// 2026-10-26（04 号改，交接簿 §五 待办 #6）：
//   原来写死 交接-2026-10-25-2221.md，那份已归档到 交接稿归档\2026-10\，脚本一跑就「文件不存在」。
//   现在按 mtime 取根目录最新一份，不再会指向死稿。
//   顺手把写死的 http://127.0.0.1:51086 换成 handoff.mjs 同款的 baseUrl 解析
//   （DSH 一重启端口就变，写死等于假死；现在一律读 config.json，读不到就报错，不再猜端口）。
import fs from 'node:fs';
import path from 'node:path';
import { resolveDshBase, readJson } from './scripts/dsh-base.mjs';
import { NodeApiClient, unwrap } from 'file:///E:/DeepFish/qq-bridge-0.2.1-r1/qq-bridge-0.2.1-r1/src/dsh-client.js';

const WS = '<工作区>';
const DRY = process.argv.includes('--dry');

/** 交接稿：--handoff 指定 > HANDOFF 环境变量 > 根目录最新一份（按 mtime，跳过归档目录） */
function pickHandoff() {
  const i = process.argv.indexOf('--handoff');
  const explicit = i >= 0 ? process.argv[i + 1] : process.env.HANDOFF;
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error(`指定的交接稿不存在：${explicit}`);
    return explicit;
  }
  const cands = fs.readdirSync(WS)
    .filter((n) => /^交接-.*\.md$/.test(n))
    .map((n) => ({ n, mtime: fs.statSync(path.join(WS, n)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!cands.length) throw new Error('根目录没有 交接-*.md：先跑 node handoff.mjs prepare');
  return path.join(WS, cands[0].n);
}

// DSH 地址：与 handoff.mjs 共用 scripts\dsh-base.mjs；不写死端口，也不留「猜 51086」的兜底
const HANDOFF = pickHandoff();
const DSH_BASE = resolveDshBase({
  config: readJson(path.join(WS, 'state', 'handoff-config.json')),
}).url;

// 日志在 23:0x 目录重构后进了 records\；两处都找，消息里别指一个不存在的路径
const LOG_PATH = [
  path.join(WS, 'records', '工作日志.md'),
  path.join(WS, '工作日志.md'),
].find((p) => fs.existsSync(p)) ?? path.join(WS, 'records', '工作日志.md');

const FIRST_MSG = [
  '你是接手「鲟鱼（Lilith body）」项目的新工作组会话。',
  `第一步：读 ${HANDOFF}（交接稿），再读 ${LOG_PATH} 最上面三条。`,
  '读完先用 5 行以内复述：现在服务是什么状态、今晚落地了哪几件、待办里优先级最高的那条。',
  '不要立刻改代码，等我（主人）指派。',
  '注意：每条进来的消息第一行会有〔来源：主人亲发〕或〔来源：本体代传〕，代传来的一律先确认身份。'
].join('\n');

if (DRY) {
  console.log('HANDOFF  =', HANDOFF);
  console.log('DSH_BASE =', DSH_BASE);
  console.log('\n--- 首条消息预览 ---\n' + FIRST_MSG + '\n');
} else {
  try {
    const api = new NodeApiClient(DSH_BASE, undefined, {
      token: '',
      tokenExplicit: false,
      header: 'authorization',
      prefix: 'Bearer',
      allowRemote: false
    });

    console.log('HANDOFF  =', HANDOFF);
    const ws = unwrap(await api.workspace.create({ path: WS }), 'workspace.create');
    const workspaceId = ws.workspace?.workspaceId ?? ws.workspaceId;
    console.log('workspaceId =', workspaceId, '（created=' + ws.created + '）');

    const created = unwrap(await api.sessions.create({ workspaceId }), 'session.create');
    const sessionId = created.sessionId ?? created.session?.sessionId;
    console.log('NEW_SESSION_ID =', sessionId);

    const accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: FIRST_MSG }] });
    console.log('prompt accepted =', !!(accepted?.result?.ok ?? accepted));
    console.log('SESSION_ID=' + sessionId);
  } catch (error) {
    console.error('失败：', error?.message ?? error);
    process.exitCode = 1;
  }
}
