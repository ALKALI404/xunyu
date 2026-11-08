// 再放宽（2026-10-25 主人决定）：agent 也可以改「记忆内容 / 配置 / 人格卡 / notes / rules」。
// 保住不动的：**批审批（含代批）**、**装插件**、`delegate-owner.code`、`HANDOFF.md`（这条主人没点名，先留着）。
// 剩下的价值就在这四样上：不许自己批自己的审批、不许自己装插件、不许碰令牌、不许改交接稿。
import fs from 'node:fs';

const B = 'E:/DeepFish/qq-bridge-0.2.1-r1/qq-bridge-0.2.1-r1/src/bridge.js';
const WRITE = process.argv.includes('--write');
let src = fs.readFileSync(B, 'utf8');

const from = `    const DELEGATE_PROTECTED = [
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

const to = `    // 受限面（2026-10-25 第二次放宽，主人明批）：agent 也能改
    //   **记忆内容 / config.json / roles 人格卡 / notes 硬约束 / rules 规矩 / default-target**。
    // 保住不动的四项（这才是身份码剩余的价值）：
    //   ① 不能自己批自己的审批（含代批）② 不能装插件 ③ 不能碰 owner 令牌 ④ 不能改交接稿
    const DELEGATE_PROTECTED = [
      /plugins[\\\\/]/i,               // 装/卸插件
      /HANDOFF\\.md/i,                 // 交接稿（主人没点名放宽，先留）
      /delegate-owner\\.code/i,        // owner 令牌
      /\\/api\\/dsh\\/approve/i          // 自己批自己的审批
    ];
    const DELEGATE_PROTECTED_WORDS = [
      '装插件', '安装插件', '卸载插件',
      '批审批', '批准审批', '通过审批', '代批'
    ];`;

const n = src.split(from).length - 1;
console.log(`${n === 1 ? '✅' : '❌'} 锚点：${n} 处`);
if (n !== 1) process.exit(2);
src = src.split(from).join(to);
if (!WRITE) { console.log('✅ dry-run 通过'); process.exit(0); }
fs.writeFileSync(B, src, 'utf8');
console.log('✍️  已写 bridge.js');
