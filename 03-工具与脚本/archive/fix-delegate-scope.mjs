// 修：delegateGrant / sessionDelegateRole 被建在请求回调内部（每个请求都新建，状态根本存不住）
// 做法：从 dshShoutDenied 后面删掉，改放到模块层（dshShoutTimes 旁边，一次初始化）
import fs from 'node:fs';

const B = 'E:/DeepFish/qq-bridge-0.2.1-r1/qq-bridge-0.2.1-r1/src/bridge.js';
const WRITE = process.argv.includes('--write');
let src = fs.readFileSync(B, 'utf8');

// 1) 抠掉旧块（从注释起点到 delegateRoleOfSession 结束）
const startMark = '        // ── 差遣身份码（2026-10-25）────────────────────────────────────────────';
const endMark = `        const delegateRoleOfSession = (sessionId) => {
          const k = String(sessionId ?? '');
          const hit = sessionDelegateRole.get(k);
          if (!hit) return 'agent';
          if (Date.now() - hit.at > DELEGATE_ROLE_TTL_MS) { sessionDelegateRole.delete(k); return 'agent'; }
          return hit.role;
        };`;
const i1 = src.indexOf(startMark);
const i2 = src.indexOf(endMark);
if (i1 < 0 || i2 < 0 || i2 < i1) { console.log('❌ 找不到旧块'); process.exit(2); }
const removed = src.slice(i1, i2 + endMark.length);
src = src.slice(0, i1) + src.slice(i2 + endMark.length);
console.log(`✅ 已抠掉旧块（${removed.length} 字符）`);

// 2) 插到模块层（dshShoutTimes 旁边）
const anchor = `    const dshShoutTimes = [];`;
const block = `    const dshShoutTimes = [];

    // ── 差遣身份码（2026-10-25）────────────────────────────────────────────────
    // 注意：这些是**进程级状态**，必须放在模块层。放到请求回调里会每个请求重建，
    // grant 存不住（20:53 验收时踩到：开窗拿到了票据，下一次请求 grant 就没了）。
    const DELEGATE_CODE_FILE = path.join(STATE_DIR, 'delegate-owner.code');
    const DELEGATE_DENY = '需要管理员本人：这条属于受限操作（配置 / 插件 / 人格记忆 / HANDOFF / 审批），差遣指令（agent）不能动';
    const DELEGATE_PROTECTED = [
      /config\\.json/i, /plugins[\\\\/]/i, /roles[\\\\/]/i, /memory[\\\\/]/i, /notes[\\\\/]/i,
      /HANDOFF\\.md/i, /工作日志\\.md/i, /delegate-owner\\.code/i,
      /default-target/i, /\\/api\\/dsh\\/approve/i
    ];
    const DELEGATE_PROTECTED_WORDS = [
      '改配置', '配置改', '装插件', '安装插件', '卸载插件', '改人格', '改记忆', '写记忆', '人格文档',
      '批审批', '批准审批', '通过审批', '代批'
    ];
    function loadDelegateOwnerCode() {
      try {
        const v = String(fs.readFileSync(DELEGATE_CODE_FILE, 'utf8') || '').replace(/^\\uFEFF/, '').trim();
        if (/^[0-9a-f]{32,64}$/i.test(v)) return v;
        log('⚠️ owner 码文件格式不对，重新生成（旧码立即失效）');
      } catch {}
      const code = crypto.randomBytes(24).toString('hex');
      try {
        fs.mkdirSync(path.dirname(DELEGATE_CODE_FILE), { recursive: true });
        fs.writeFileSync(DELEGATE_CODE_FILE, code, { encoding: 'utf8', mode: 0o600 });
        log('owner 码已生成（state/delegate-owner.code；不外显、不进日志）');
      } catch (error) {
        log(\`⚠️ owner 码写入失败：\${error?.message ?? error}（本次进程内仍可用）\`);
      }
      return code;
    }
    const delegateOwnerCode = loadDelegateOwnerCode();
    const delegateRoleOf = (req, body) => {
      const code = String(req.headers['x-delegate-code'] ?? body?.code ?? '').trim();
      const wantsOwner = body?.origin === 'relay' || String(body?.role ?? '').toLowerCase() === 'owner';
      if (!wantsOwner) return 'agent';
      return code && code === delegateOwnerCode ? 'owner' : 'agent';
    };
    const delegateTap = (text) => {
      const s = String(text ?? '');
      for (const re of DELEGATE_PROTECTED) { const m = re.exec(s); if (m) return m[0]; }
      for (const w of DELEGATE_PROTECTED_WORDS) { if (s.includes(w)) return w; }
      return '';
    };
    // 代批双凭据：①owner 授权开窗 ②票据
    let delegateGrant = null; // { id, until, by }
    const newGrantId = () => crypto.randomBytes(6).toString('hex');
    const grantActive = () => !!(delegateGrant && delegateGrant.until > Date.now());
    const sessionDelegateRole = new Map(); // sessionId -> { role, at }
    const DELEGATE_ROLE_TTL_MS = 30 * 60 * 1000;
    const delegateRoleOfSession = (sessionId) => {
      const k = String(sessionId ?? '');
      const hit = sessionDelegateRole.get(k);
      if (!hit) return 'agent';
      if (Date.now() - hit.at > DELEGATE_ROLE_TTL_MS) { sessionDelegateRole.delete(k); return 'agent'; }
      return hit.role;
    };`;

const n = src.split(anchor).length - 1;
console.log(`${n === 1 ? '✅' : '❌'} 模块层锚点：${n} 处`);
if (n !== 1) process.exit(2);
src = src.split(anchor).join(block);

// 3) 旧的 G1 块（代批状态）也要删：它被插在会话角色 Map 前面
const g1Start = '        // ── 代批双凭据（2026-10-25）────────────────────────────────────────────';
const g1End = `        const grantActive = () => !!(delegateGrant && delegateGrant.until > Date.now());
        const sessionDelegateRole = new Map(); // sessionId -> { role, at }`;
const j1 = src.indexOf(g1Start);
const j2 = src.indexOf(g1End);
if (j1 >= 0 && j2 > j1) {
  src = src.slice(0, j1) + src.slice(j2 + g1End.length);
  console.log('✅ 已删掉请求作用域里的 G1 残留块');
} else {
  console.log('ℹ️ 没有 G1 残留块（可能同上一次一起被抠掉了）');
}

if (!WRITE) { console.log('✅ dry-run 通过'); process.exit(0); }
fs.writeFileSync(B, src, 'utf8');
console.log('✍️  已写 bridge.js');
