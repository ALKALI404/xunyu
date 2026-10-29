// DSH 宿主基址：唯一解析实现（handoff.mjs / new-workgroup-session.mjs 共用）
//
// 顺序：DSH_BASE 环境变量 → 本仓库 state\handoff-config.json 的 dshBaseUrl
//       → 桥接 config.json 的 dsh.baseUrl → 报错。
//
// **不设「猜一个端口」的兜底**（原来兜 51086）。DSH 一重启端口就变，
// 猜错的表现是 fetch failed，比直接报「读不到配置」难查十倍。
import fs from 'node:fs';

export const BRIDGE_DIR = 'E:\\DeepFish\\qq-bridge-0.2.1-r1\\qq-bridge-0.2.1-r1';

/** 读 JSON，坏了就 null（调用方自己决定是否致命） */
export function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

const norm = (s) => String(s ?? '').trim().replace(/\/+$/, '');

/**
 * @param {{ env?: Record<string,string>, bridgeDir?: string, config?: any }} [opts]
 * @returns {{ url: string, source: string }}
 */
export function resolveDshBase({ env = process.env, bridgeDir = BRIDGE_DIR, config = null } = {}) {
  const fromEnv = norm(env.DSH_BASE);
  if (/^https?:\/\//.test(fromEnv)) return { url: fromEnv, source: 'env DSH_BASE' };

  const fromConfig = norm(config?.dshBaseUrl);
  if (/^https?:\/\//.test(fromConfig)) return { url: fromConfig, source: 'state\\handoff-config.json dshBaseUrl' };

  const cfgPath = `${bridgeDir}\\config.json`;
  const fromBridge = norm(readJson(cfgPath)?.dsh?.baseUrl);
  if (/^https?:\/\//.test(fromBridge)) return { url: fromBridge, source: `${cfgPath} dsh.baseUrl` };

  throw new Error(
    '取不到 DSH 地址：DSH_BASE 未设，handoff-config.json 的 dshBaseUrl 为 null，'
    + `桥接 ${cfgPath} 的 dsh.baseUrl 也读不到或不是 http(s)。\n`
    + '  不猜端口。先确认桥接在跑、config.json 正常；临时可用 DSH_BASE=http://127.0.0.1:<当前端口> 覆盖。'
    + '当前端口可问窗口页签地址，或看 DSH 启动输出。',
  );
}
