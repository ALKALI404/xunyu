// 补一刀：插件类关键词太死（'装插件' 挡不住 '装个插件'）→ 换成正则
import fs from 'node:fs';
const B = 'E:/DeepFish/qq-bridge-0.2.1-r1/qq-bridge-0.2.1-r1/src/bridge.js';
const WRITE = process.argv.includes('--write');
let src = fs.readFileSync(B, 'utf8');
const from = `    const DELEGATE_PROTECTED = [
      /plugins[\\\\/]/i,               // 装/卸插件`;
const to = `    const DELEGATE_PROTECTED = [
      /plugins[\\\\/]/i,               // 装/卸插件
      /(装|安装|卸载).{0,3}插件/,      // 「装个插件」「装一下插件」这类说法`;`;
// 注意上面多打了一个分号，改正
const to2 = to.replace('`;', '');
const n = src.split(from).length - 1;
console.log(`${n === 1 ? '✅' : '❌'} 锚点：${n} 处`);
if (n !== 1) process.exit(2);
src = src.split(from).join(to2);
if (!WRITE) { console.log('✅ dry-run 通过'); process.exit(0); }
fs.writeFileSync(B, src, 'utf8');
console.log('✍️  已写');
