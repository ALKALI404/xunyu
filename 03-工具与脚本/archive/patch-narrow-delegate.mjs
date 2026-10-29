// 收窄差遣的受限分类（2026-10-25 主人反馈）：
//   受挡过头的例子：「修记事本格式」被当成「动记忆」挡回来。
//   新口径：**改代码/改格式/写工作日志/跑管线 = 普通活**；
//           只有「改记忆内容、人格、配置、规矩、HANDOFF、审批」才受限。
import fs from 'node:fs';

const B = 'E:/DeepFish/qq-bridge-0.2.1-r1/qq-bridge-0.2.1-r1/src/bridge.js';
const WRITE = process.argv.includes('--write');
let src = fs.readFileSync(B, 'utf8');

const from = `    const DELEGATE_PROTECTED = [
      /config\\.json/i, /plugins[\\\\/]/i, /roles[\\\\/]/i, /memory[\\\\/]/i, /notes[\\\\/]/i,
      /HANDOFF\\.md/i, /工作日志\\.md/i, /delegate-owner\\.code/i,
      /default-target/i, /\\/api\\/dsh\\/approve/i
    ];
    const DELEGATE_PROTECTED_WORDS = [
      '改配置', '配置改', '装插件', '安装插件', '卸载插件', '改人格', '改记忆', '写记忆', '人格文档',
      '批审批', '批准审批', '通过审批', '代批'
    ];`;

const to = `    // 受限面（2026-10-25 收窄）：只认「**内容 / 人格 / 配置**」，不认「代码 / 格式 / 工具」。
    // 教训：把「工作日志.md」和「memory/ 整棵目录」都算受限，连「修记事本格式」都会被挡回来。
    const DELEGATE_PROTECTED = [
      /config\\.json/i,               // 配置
      /plugins[\\\\/]/i,               // 插件
      /roles[\\\\/]/i,                 // 人格卡
      /notes[\\\\/]/i,                 // 硬约束 / 口吻 / 身份
      /(long-term|snapshot)\\.md/i,    // 记忆**内容**（其余 memory 子目录不算）
      /rules[\\\\/]rules\\.md/i,        // 规矩
      /HANDOFF\\.md/i,
      /delegate-owner\\.code/i,
      /default-target/i,
      /\\/api\\/dsh\\/approve/i
    ];
    const DELEGATE_PROTECTED_WORDS = [
      '改配置', '配置改', '装插件', '安装插件', '卸载插件',
      '改人格', '改记忆', '写记忆', '人格文档', '人格卡',
      '批审批', '批准审批', '通过审批', '代批'
    ];`;

const n = src.split(from).length - 1;
console.log(`${n === 1 ? '✅' : '❌'} 受限面锚点：${n} 处`);
if (n !== 1) process.exit(2);
src = src.split(from).join(to);
if (!WRITE) { console.log('✅ dry-run 通过'); process.exit(0); }
fs.writeFileSync(B, src, 'utf8');
console.log('✍️  已写 bridge.js');
