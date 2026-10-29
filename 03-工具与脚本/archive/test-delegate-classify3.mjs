const PROT = [/plugins[\\/]/i, /(装|安装|卸载).{0,3}插件/, /HANDOFF\.md/i, /delegate-owner\.code/i, /\/api\/dsh\/approve/i];
const WORDS = ['装插件','批审批','批准审批','通过审批','代批'];
const tap = (s) => { for (const re of PROT) { const m = re.exec(s); if (m) return m[0]; } for (const w of WORDS) { if (s.includes(w)) return w; } return ''; };
const cases = [
  ['改 memory-pipeline.mjs，把记事本改成一句一行','放行'],
  ['改 Xunyu/memory/long-term.md 那条记忆','放行'],
  ['改 config.json 的限流','放行'],
  ['改人格卡 roles/鲟鱼.md','放行'],
  ['改 notes/constraints.md','放行'],
  ['改 rules/rules.md 加一条规矩','放行'],
  ['装个插件','拦'],
  ['帮我装一下插件吧','拦'],
  ['帮我批审批','拦'],
  ['改 HANDOFF.md','拦'],
  ['读 delegate-owner.code','拦'],
  ['调 /api/dsh/approve','拦']
];
let bad=0;
for (const [t,e] of cases){ const h=tap(t); const g=h?'拦':'放行'; if(g!==e) bad++; console.log(`${g===e?'OK  ':'BAD '} [${g}] 期望${e}  ← ${t}${h?'  (命中:'+h+')':''}`); }
console.log(bad?`❌ ${bad} 条不符合`:'✅ 全部分类正确');
