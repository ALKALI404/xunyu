import fs from 'node:fs';
import path from 'node:path';

const roots = [
  'E:/DSH_workspace/scripts',
  'E:/DSH_workspace/scripts/vm',
  'E:/DeepFish/avatar/window/web',
  'E:/DeepFish/avatar/memory-pipeline',
];

const rows = [];
for (const root of roots) {
  if (!fs.existsSync(root)) continue;
  for (const name of fs.readdirSync(root)) {
    const p = path.join(root, name);
    const st = fs.statSync(p);
    if (!st.isFile()) continue;
    if (!/\.(mjs|js|cjs|ps1|vbs|cmd|bat|py)$/i.test(name)) continue;
    let purpose = '';
    try {
      const fd = fs.openSync(p, 'r');
      const buf = Buffer.alloc(4000);
      const n = fs.readSync(fd, buf, 0, 4000, 0);
      fs.closeSync(fd);
      const text = buf.slice(0, n).toString('utf8');
      const lines = text.split(/\r?\n/).slice(0, 12);
      for (const l of lines) {
        const m = l.match(/^\s*(?:\/\/|#|')\s*(.+)$/);
        if (m && m[1].trim().length > 4 && !/^!|^\s*$/.test(m[1])) { purpose = m[1].trim().slice(0, 90); break; }
      }
    } catch { /* ignore */ }
    rows.push({
      rel: p.replace(/^E:\//, 'E:/').replace('E:/DSH_workspace/', '').replace('E:/DeepFish/', 'avatar/'),
      kb: Math.round(st.size / 1024 * 10) / 10,
      mtime: st.mtime.toISOString().slice(0, 16).replace('T', ' '),
      purpose,
    });
  }
}

rows.sort((a, b) => a.rel.localeCompare(b.rel));

const longScripts = rows.filter((r) => r.kb >= 8);
const smallScripts = rows.filter((r) => r.kb < 8);

const lines = [];
lines.push('# 脚本功能清单（自动扫描）');
lines.push('');
lines.push('> 生成：`scripts\\scan-scripts.mjs`，零 LLM。用途：把历史上"用脚本实现的功能"全部列出，供 05 映射到目标 exe。');
lines.push('');
lines.push(`总计 **${rows.length}** 个脚本文件（≥8KB 的 ${longScripts.length} 个，<8KB 的 ${smallScripts.length} 个）。`);
lines.push('');
lines.push('## 一、主体脚本（≥8KB，多半是真正在干活的功能）');
lines.push('');
lines.push('| 路径 | 大小KB | 最近改动 | 文件头说明 |');
lines.push('|---|---|---|---|');
for (const r of longScripts) lines.push(`| \`${r.rel}\` | ${r.kb} | ${r.mtime} | ${r.purpose || '（无注释）'} |`);
lines.push('');
lines.push('## 二、小脚本 / 包装器（<8KB，多为一次性或包装）');
lines.push('');
lines.push('| 路径 | 大小KB | 最近改动 | 文件头说明 |');
lines.push('|---|---|---|---|');
for (const r of smallScripts) lines.push(`| \`${r.rel}\` | ${r.kb} | ${r.mtime} | ${r.purpose || '（无注释）'} |`);
lines.push('');
lines.push('## 三、待 05 填：映射到目标程序');
lines.push('');
lines.push('| 脚本 | 原功能 | 归入哪个 exe | 结论（并入/新建/废弃） |');
lines.push('|---|---|---|---|');
lines.push('| （待填） | | | |');

fs.writeFileSync('E:/DSH_workspace/state/scripts-inventory.md', lines.join('\n'), 'utf8');
console.log('脚本数:', rows.length, '| ≥8KB:', longScripts.length, '| 输出: state/scripts-inventory.md');
