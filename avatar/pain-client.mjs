#!/usr/bin/env node
// pain-client.mjs —— 「疼痛」上报器（谁疼谁喊，不等别人来查）。
//
// 为什么要单独一个文件：埋点要极小，且 relay / bridge / 演练脚本共用同一套格式。
// 规矩：
//   · 只往 127.0.0.1:9339 的 /pain 发一条 JSON，1.5s 超时；
//   · **永不抛异常、永不阻塞调用方**（fire-and-forget）；总线没起就当没发生（这是设计，不是错误）；
//   · 同一 (module,pain,code) 30s 内只报一次，避免故障风暴把总线打满。

const PAIN_BUS = String(process.env.PAIN_BUS_URL || 'http://127.0.0.1:9339').replace(/\/+$/, '');
const TIMEOUT_MS = 1500;
const DEDUPE_MS = 30000;

const lastSent = new Map(); // key -> 上次发送时刻

/**
 * 报一条疼痛。返回 true 表示这条真的送出去了（总线可达），否则 false。
 * 调用方**不需要** await，也不该因为返回 false 做任何事。
 * @param {{pain:string, module:string, by?:string, code?:string, detail?:string, at?:number}} event
 */
export async function reportPain(event) {
  try {
    const module = String(event?.module ?? '').trim();
    const pain = String(event?.pain ?? '').trim();
    if (!module || !pain) return false;
    const key = `${module}|${pain}|${event?.code ?? ''}`;
    const now = Date.now();
    const prev = lastSent.get(key);
    if (prev && now - prev < DEDUPE_MS) return false; // 去重：同一种疼 30s 内只喊一次
    lastSent.set(key, now);
    if (lastSent.size > 200) lastSent.clear();

    const response = await fetch(`${PAIN_BUS}/pain`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pain,
        module,
        by: String(event?.by ?? ''),
        code: String(event?.code ?? ''),
        detail: String(event?.detail ?? '').slice(0, 200),
        at: Number.isFinite(Number(event?.at)) ? Number(event.at) : now
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    return response.ok;
  } catch {
    return false; // 总线不在就是"没人听见"，不算错误
  }
}

export const PAIN_BUS_URL = PAIN_BUS;
