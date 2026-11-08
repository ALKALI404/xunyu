// scripts\tidy-workspace.mjs —— 工作区分类收纳（2026-11-07 主人要求）
// 原则：**只移不删**（全部进 归档\，保留可回溯）；运行中目录一律不碰。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'E:/DSH_workspace';
const ARCH = path.join(ROOT, '归档');
const dry = process.argv.includes('--dry');

const MOVES = [
  // ① 根目录历史交接稿
  { kind: 'glob-root', pattern: /^交接-20\d\d-\d\d-\d\d-\d{4}\.md$/, to: '交接稿' },
  { kind: 'file', name: '启动对话窗.bat', to: '废弃\\初版对话窗' },
  // ② 明显废弃/过期的目录
  { kind: 'dir', name: 'backup', to: '旧备份' },
  { kind: 'dir', name: 'plugins-review', to: '旧评审' },
  { kind: 'dir', name: 'refs', to: '旧参考资料' },
  { kind: 'dir', name: 'dist', to: '旧构建产物' },
  // ③ tmp 里的大块临时（edge 截图目录 / npm 缓存 / 大 PDF）
  { kind: 'glob-dir', dir: 'tmp', pattern: /^edge-/, to: 'tmp-旧截图' },
  { kind: 'glob-dir', dir: 'tmp', pattern: /^npm-cache$/, to: 'tmp-缓存' },
  { kind: 'glob-file', dir: 'tmp', pattern: /\.pdf$/i, to: 'tmp-大文件' },
  // ④ logs 里的旧浏览器 profile 残留
  { kind: 'glob-dir', dir: 'logs', pattern: /^_/, to: 'logs-旧profile' },
];

function dirSize(p) {
  try {
    let s = 0;
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const f = path.join(p, e.name);
      if (e.isDirectory()) s += dirSize(f);
      else { try { s += fs.statSync(f).size; } catch { /* 跳过 */ } }
    }
    return s;
  } catch { return 0; }
}

function move(src, destDir) {
  const base = path.basename(src);
  let dest = path.join(destDir, base);
  if (fs.existsSync(dest)) dest = path.join(destDir, `${base}-${Date.now()}`);
  if (dry) { console.log(`  [dry] ${path.relative(ROOT, src)} → ${path.relative(ROOT, dest)}`); return { src, dest, size: 0 }; }
  fs.mkdirSync(destDir, { recursive: true });
  const size = fs.statSync(src).isDirectory() ? dirSize(src) : fs.statSync(src).size;
  fs.renameSync(src, dest);
  return { src, dest, size };
}

let moved = 0;
let freed = 0;

for (const m of MOVES) {
  const destDir = path.join(ARCH, m.to);
  if (m.kind === 'file') {
    const src = path.join(ROOT, m.name);
    if (fs.existsSync(src)) { const r = move(src, destDir); moved++; freed += r.size; }
    continue;
  }
  if (m.kind === 'dir') {
    const src = path.join(ROOT, m.name);
    if (fs.existsSync(src)) { const r = move(src, destDir); moved++; freed += r.size; console.log(`  ✅ ${m.name} → 归档\\${m.to}`); }
    continue;
  }
  if (m.kind === 'glob-root') {
    for (const n of fs.readdirSync(ROOT)) {
      if (m.pattern.test(n)) { const r = move(path.join(ROOT, n), destDir); moved++; freed += r.size; }
    }
    continue;
  }
  if (m.kind === 'glob-dir' || m.kind === 'glob-file') {
    const base = path.join(ROOT, m.dir);
    if (!fs.existsSync(base)) continue;
    for (const e of fs.readdirSync(base, { withFileTypes: true })) {
      const isDir = e.isDirectory();
      if (m.kind === 'glob-dir' && !isDir) continue;
      if (m.kind === 'glob-file' && isDir) continue;
      if (!m.pattern.test(e.name)) continue;
      const r = move(path.join(base, e.name), destDir);
      moved++; freed += r.size;
    }
    console.log(`  ✅ ${m.dir}\\ 匹配 ${m.pattern} → 归档\\${m.to}`);
  }
}

const gb = (freed / 1024 / 1024 / 1024).toFixed(2);
console.log(`\n本轮移动 ${moved} 项，约 ${gb} GB（${dry ? '空跑，未动' : '已归档'}）`);
