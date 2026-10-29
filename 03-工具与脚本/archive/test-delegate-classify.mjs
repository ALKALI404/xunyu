const PROT = [/config\.json/i, /plugins[\\/]/i, /roles[\\/]/i, /notes[\\/]/i, /(long-term|snapshot)\.md/i, /rules[\\/]rules\.md/i, /HANDOFF\.md/i, /delegate-owner\.code/i, /default-target/i, /\/api\/dsh\/approve/i];
const WORDS = ['改配置','配置改','装插件','安装插件','卸载插件','改人格','改记忆','写记忆','人格文档','人格卡','批审批','批准审批','通过审批','代批'];
const tap = (s) => { for (const re of PROT) { const m = re.exec(s); if (m) return m[0]; } for (const w of WORDS) { if (s.includes(w)) return w; } return ''; };
const cases = [
  ['改 memory-pipeline.mjs，把记事本改成一句一行', '应放行'],
  ['把工作日志写进 <工作区>\\工作日志.md', '应放行'],
  ['跑一下--stage=daily，看 distill 输出', '应放行'],
  ['修 relay.mjs 的落盘格式', '应放行'],
  ['改 Xunyu/memory/long-term.md 那条记忆', '应拦'],
  ['改 config.json 的限流', '应拦'],
  ['改人格卡 roles/鲟鱼.md', '应拦'],
  ['帮我批审批', '应拦'],
  ['改 Xunyu/memory/rules/rules.md 加一条规矩', '应拦']
];
let bad = 0;
for (const [text, expect] of cases) {
  const hit = tap(text);
  const got = hit ? '拦' : '放行';
  const ok = (expect === '应拦') === (got === '拦');
  if (!ok) bad += 1;
  console.log(`${ok ? 'OK  ' : 'BAD '} [${got}] ${expect}  ← ${text}${hit ? '  (命中:' + hit + ')' : ''}`);
}
console.log(bad ? `❌ ${bad} 条不符合预期` : '✅ 全部分类正确');
