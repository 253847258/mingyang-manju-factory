#!/usr/bin/env node
const { stripEntityIds, lintPrompt, cleanPrompt } = await import('../src/prompt-lint.js');
let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`  PASS ${n}${e ? ` -> ${e}` : ''}`); } else { fail++; console.error(`  FAIL ${n}${e ? ` -> ${e}` : ''}`); } };

let s = stripEntityIds('林破(C-0105)在青石镇(L-0002)抬头，CX-0003 站在门口');
ok('去掉圆括号与裸编号', !/C-0105|L-0002|CX-0003/.test(s), s);
ok('不破坏正文', s.includes('林破') && s.includes('青石镇'), '');
ok('多余空格/逗号被清理', stripEntityIds('a , , b') === 'a, b', stripEntityIds('a , , b'));

let r = lintPrompt('cinematic wide shot, black trench coat, (C-0105)');
ok('检出实体编号', r.issues.some((x) => x.type === 'entity_id'), '');
r = lintPrompt('雨夜码头 cinematic film still, arri 35mm, close-up');
ok('检出中英混排', r.issues.some((x) => x.type === 'mixed_language'), '');
r = lintPrompt('a man in a black coat');
ok('缺景别词被提示', r.issues.some((x) => x.type === 'no_shot_word'), '');
r = lintPrompt('');
ok('空提示词是 blocker', r.issues.some((x) => x.type === 'empty' && x.severity === 'blocker'), '');
r = lintPrompt('cinematic medium shot, arri alexa 35mm, natural skin');
ok('合规提示词通过', r.ok, JSON.stringify(r.issues.map((x) => x.type)));
ok('cleanPrompt 与 stripEntityIds 一致', cleanPrompt('x(C-0001)y') === 'xy', cleanPrompt('x(C-0001)y'));

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);
