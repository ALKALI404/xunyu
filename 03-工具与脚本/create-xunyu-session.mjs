// 创建/复用「鲟鱼本体」会话——本体的家已经从 avatar\body 迁到 E:\DeepFish\鲟鱼。
// 本体按 BOOT.md 自检并写 state/boot.json 回报（不依赖事件流，脚本直接读文件验证）。
import fs from 'node:fs';
import path from 'node:path';
import { NodeApiClient, unwrap, discoverDshLaunchToken } from 'file:///E:/DeepFish/qq-bridge-0.2.1-r1/qq-bridge-0.2.1-r1/src/dsh-client.js';

const B = 'E:\\DeepFish\\qq-bridge-0.2.1-r1\\qq-bridge-0.2.1-r1';
const HOME = '<Xunyu根>';
const STATE = 'E:\\DeepFish\\avatar\\state';
const bootFile = path.join(HOME, 'state', 'boot.json');

const cfg = JSON.parse(fs.readFileSync(path.join(B, 'config.json'), 'utf8'));
const api = new NodeApiClient(cfg.dsh.baseUrl, undefined, {
  token: cfg.dsh.authToken || discoverDshLaunchToken(),
  tokenExplicit: cfg.dsh.authTokenExplicit === true,
  header: cfg.dsh.authHeader,
  prefix: cfg.dsh.authPrefix
});

fs.mkdirSync(path.join(HOME, 'state'), { recursive: true });
fs.mkdirSync(STATE, { recursive: true });
try { fs.unlinkSync(bootFile); } catch {}

// 1) workspace + session（幂等：workspace 复用；session 只在 cwd 已经是新家时复用）
const ws = unwrap(await api.workspace.create({ path: HOME }), 'workspace.create');
console.log(`[1] workspace=${ws.workspace.workspaceId} created=${ws.created}`);

let sessionId = null;
const ownerFile = path.join(STATE, 'owner-session.json');
const prev = (() => { try { return JSON.parse(fs.readFileSync(ownerFile, 'utf8')); } catch { return null; } })();
if (prev?.sessionId && String(prev.cwd ?? '') === HOME) {
  const list = unwrap(await api.sessions.list({}), 'sessions.list');
  const hit = (list.items ?? []).find((it) => String(it.sessionId) === String(prev.sessionId));
  if (hit) { sessionId = String(prev.sessionId); console.log(`[2] 复用已有本体会话 ${sessionId}`); }
}
if (!sessionId) {
  const v = unwrap(await api.sessions.create({ workspaceId: ws.workspace.workspaceId, agentPreset: 'standard' }), 'session.create');
  sessionId = String(v.sessionId);
  console.log(`[2] 新建本体会话 ${sessionId}（preset=standard，cwd=${HOME}）`);
  if (prev?.sessionId) console.log(`    旧会话 ${prev.sessionId}（cwd=${prev.cwd}）保留不删，需要时可回查`);
}

fs.writeFileSync(ownerFile, JSON.stringify({
  sessionId,
  cwd: HOME,
  preset: 'standard',
  workspaceId: ws.workspace.workspaceId,
  createdAt: Date.now()
}, null, 2), 'utf8');

// 2) 启动提示词
const prompt = [
  '【本体启动】你是鲟鱼的本体。你的家是 <Xunyu根>（人格与记忆都在这儿；avatar 是功能模块目录，不是你的东西）。',
  '按 BOOT.md 执行一次完整启动流程：',
  '1. 读 roles/鲟鱼.md、notes/constraints.md、notes/identity.md、notes/style.md、memory/long-term.md、memory/snapshot.md；',
  '2. 看 memory/inbox/ 有没有新东西：有就挑「轻的、值得长期留的」并进 memory/long-term.md，然后把 inbox 里的文件移到 memory/archive/；系统流水账不要写进记忆；',
  '3. 用 shell 自检：http://127.0.0.1:9333/ping、http://127.0.0.1:9334/health、http://127.0.0.1:9335/health、http://127.0.0.1:3100/api/health（401 也算活着）；',
  '4. 把结果写成 state/boot.json，字段：{"ok":true,"services":{"mod":"ok|fail","relay":"ok|fail","body":"ok|fail","bridge":"ok|fail"},"persona":"读到的人格一句话","memory":"并入记忆了什么（没有就说没有）","note":"你要对主人说的一句话","at":"ISO 时间"}；',
  '5. 写完后回复我一行：本体已上线 + 各项服务状态。',
  '注意：不要动游戏、不要发 QQ、除了记忆与 state/boot.json 之外不要改任何文件。'
].join('\n');

const accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: prompt }] });
console.log(`[3] prompt accepted: ${JSON.stringify(accepted?.result ?? {})}`);

// 3) 等本体写回执（最多 5 分钟）
const deadline = Date.now() + 300000;
let report = null;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 4000));
  if (fs.existsSync(bootFile)) {
    try {
      const raw = fs.readFileSync(bootFile, 'utf8');
      report = JSON.parse(raw);
      console.log('[4] boot.json 已出现：');
      console.log(raw);
      break;
    } catch { console.log('boot.json 还没写完…'); }
  }
}
if (!report) { console.log('[4] 超时：本体没有写 state/boot.json'); process.exitCode = 2; }

console.log(`SESSION_ID=${sessionId}`);
