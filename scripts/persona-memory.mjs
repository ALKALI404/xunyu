// WS-032：人设与记忆源对接（给 steward 与工作台页面用）。
//
// 纯读：不写任何人设/记忆文件；不读 whale_girl 的 assets\personas\*.json。
// 口径（任务书写死）：chars = 去空白字数；chapters = 二级标题数；lines = 非空行数；
// sha8 = 文件内容 sha256 前 8 位（只回指纹、不回正文、不回令牌）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const PERSONA_DIR = 'E:\\DeepFish\\Xunyu\\roles';
export const MEMORY_DIR = 'E:\\DeepFish\\Xunyu\\memory';
export const PERSONA_NAMES = ['鲟鱼.md', '保单助理.md'];

const stripWs = (text) => String(text).replace(/\s+/g, '');
const sha8Of = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 8);
const titleOf = (text, fallback) => {
  const hit = String(text).match(/^#\s+(.+)$/m);
  return hit ? hit[1].trim() : fallback;
};

function statOf(file, label) {
  const buf = fs.readFileSync(file);
  const text = buf.toString('utf8');
  const st = fs.statSync(file);
  return {
    path: file,
    mtime: Math.round(st.mtimeMs),
    chars: stripWs(text).length,
    sha8: sha8Of(buf),
    title: titleOf(text, label ?? path.basename(file))
  };
}

/** 人设：返回 primary + all（只列真实存在的文件）。 */
export function readPersona({ rolesDir = PERSONA_DIR, names = PERSONA_NAMES } = {}) {
  const all = [];
  for (const name of names) {
    const file = path.join(rolesDir, name);
    try {
      if (fs.existsSync(file)) all.push(statOf(file, name.replace(/\.md$/, '')));
    } catch { /* 单个文件读不动就跳过，最后用 primary 判断整体 */ }
  }
  if (!all.length) {
    return {
      ok: false,
      reason: `人设读不到：${path.join(rolesDir, names[0])} 不存在或不可读（当前没有任何可用的 roles\\*.md）`,
      all: []
    };
  }
  const primary = all[0];
  return {
    ok: true,
    primary: { path: primary.path, mtime: primary.mtime, chars: primary.chars, sha8: primary.sha8, title: primary.title },
    all: all.map(({ path: p, mtime, chars, sha8, title }) => ({ path: p, mtime, chars, sha8, title }))
  };
}

function latestOf(dir, pattern) {
  let best = null;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!pattern.test(name)) continue;
      if (!best || name > best) best = name;
    }
  } catch { return null; }
  return best;
}

/** 长期记忆 + 蒸馏 + 两个记事本。 */
export function readMemory({
  memoryDir = MEMORY_DIR,
  inboxDir = path.join(MEMORY_DIR, 'inbox'),
  distillDir = path.join(MEMORY_DIR, 'distill')
} = {}) {
  const longTermPath = path.join(memoryDir, 'long-term.md');
  if (!fs.existsSync(longTermPath)) {
    return { ok: false, reason: `长期记忆读不到：${longTermPath} 不存在`, longTerm: null };
  }
  const text = fs.readFileSync(longTermPath, 'utf8');
  const st = fs.statSync(longTermPath);
  const longTerm = {
    path: longTermPath,
    chars: stripWs(text).length,
    mtime: Math.round(st.mtimeMs),
    chapters: (text.match(/^##\s+\S/gm) ?? []).length
  };

  const distillFiles = (() => {
    try { return fs.readdirSync(distillDir).filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort(); } catch { return []; }
  })();
  const distill = {
    latestDate: distillFiles.length ? distillFiles[distillFiles.length - 1].replace(/\.json$/, '') : null,
    count: distillFiles.length
  };

  const notebook = (pattern, missingWhenAbsent) => {
    const name = latestOf(inboxDir, pattern);
    if (!name) return { path: null, lines: 0, lastAt: null, missing: missingWhenAbsent };
    const file = path.join(inboxDir, name);
    const raw = fs.readFileSync(file, 'utf8');
    return {
      path: file,
      lines: raw.split(/\r?\n/).filter((l) => l.trim()).length,
      lastAt: Math.round(fs.statSync(file).mtimeMs)
    };
  };

  return {
    ok: true,
    longTerm,
    distill,
    notebooks: {
      qq: notebook(/^qq-\d{4}-\d{2}-\d{2}\.jsonl$/, 'QQ 记事本还没有文件（memory\\inbox\\qq-*.jsonl）'),
      window: notebook(/^win-\d{4}-\d{2}-\d{2}\.jsonl$/, '窗口记事本还没有源：memory\\inbox\\ 下没有 win-*.jsonl')
    }
  };
}

/** 一次拿全（页面要的一屏）。 */
export function buildSnapshot(env = {}) {
  const persona = readPersona(env);
  const memory = readMemory(env);
  return { ok: persona.ok && memory.ok, persona, memory };
}

/**
 * 交给宿主挂路由用：只认 /api/persona 与 /api/memory，别的一律返回 null（交给别人的路由）。
 * 形状照着 workdesk-server 里 handleWecomChat / handleSupervisor 的约定：{status, body}。
 * 规范 v1（2026-11-07）：错误分支不许用 200 + ok:false —— 源读不到一律 503。
 */
export async function handlePersonaMemory({ route, env } = {}) {
  if (route === '/api/persona') {
    const body = readPersona(env);
    return { status: body.ok ? 200 : 503, body };
  }
  if (route === '/api/memory') {
    const body = readMemory(env);
    return { status: body.ok ? 200 : 503, body };
  }
  return null;
}

// 命令行直跑：prints 一次快照（给排查和验收贴证据用）。
if (process.argv[1] && process.argv[1].endsWith('persona-memory.mjs')) {
  const out = buildSnapshot();
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}
