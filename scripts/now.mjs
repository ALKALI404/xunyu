// scripts\now.mjs —— 唯一时间来源（程序读系统时钟，禁止手写/推算时间）
// 用法：node scripts\now.mjs            输出 ISO 时间
//       node scripts\now.mjs --json     输出 {iso, unix, tz, source}
import os from 'node:os';

const d = new Date();
const pad = (n) => String(n).padStart(2, '0');
const off = -d.getTimezoneOffset();
const sign = off >= 0 ? '+' : '-';
const abs = Math.abs(off);
const local = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ iso: local, unix: Math.floor(d.getTime() / 1000), tz: Intl.DateTimeFormat().resolvedOptions().timeZone, host: os.hostname(), source: 'system-clock' }, null, 2));
} else {
  console.log(local);
}
