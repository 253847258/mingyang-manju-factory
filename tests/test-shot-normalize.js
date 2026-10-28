#!/usr/bin/env node
const { normalizeShotCount } = await import('../src/shot-normalize.js');
let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`  PASS ${n}${e ? ` -> ${e}` : ''}`); } else { fail++; console.error(`  FAIL ${n}${e ? ` -> ${e}` : ''}`); } };
const shot = (i, over = {}) => ({ id: `S${i}`, idx: i, duration: 4, dialogue: '', prompt_pos: `shot ${i}`, prompt_neg: 'anime', ...over });

let r = normalizeShotCount(Array.from({ length: 8 }, (_, i) => shot(i + 1)));
ok('8 镜不处理', r.after === 8 && r.changes.length === 0, '');

r = normalizeShotCount(Array.from({ length: 33 }, (_, i) => shot(i + 1, { duration: i % 3 === 0 ? 6 : 4 })));
ok('33 镜压到 12', r.after === 12 && r.inRange, `after=${r.after} changes=${r.changes.length}`);
ok('合并保留第一个 id', r.changes.every((c) => c.type !== 'merge' || c.to === c.from[0]), '');
ok('合并后总时长不丢', Math.abs(r.shots.reduce((a, s) => a + Number(s.duration), 0) - Array.from({ length: 33 }, (_, i) => (i % 3 === 0 ? 6 : 4)).reduce((a, b) => a + b, 0)) < 0.5, '');

r = normalizeShotCount(Array.from({ length: 5 }, (_, i) => shot(i + 1, { duration: 8 })));
ok('5 镜拆到默认 10', r.after === 10 && r.changes.some((c) => c.type === 'split'), `after=${r.after}`);

r = normalizeShotCount(Array.from({ length: 5 }, (_, i) => shot(i + 1, { duration: 8 })), { min: 8 });
ok('min 可配置为 8', r.after === 8, `after=${r.after}`);
ok('拆分后 idx 连续', r.shots.every((s, i) => s.idx === i + 1), '');

r = normalizeShotCount(Array.from({ length: 6 }, (_, i) => shot(i + 1, { duration: 4 })));
ok('短镜头不足时无法拆分（不硬凑）', r.after === 6 && r.changes.length === 0, `after=${r.after}`);

r = normalizeShotCount(Array.from({ length: 33 }, (_, i) => shot(i + 1, { duration: 4 })), { clampDuration: true, minSec: 5, maxSec: 6 });
ok('钳时长后全部落在 5–6 秒', r.shots.every((x) => x.duration >= 5 && x.duration <= 6), JSON.stringify([...new Set(r.shots.map((x) => x.duration))]));
ok('总时长按钳后重算', r.totalDuration >= 50 && r.totalDuration <= 72, `total=${r.totalDuration} clamped=${r.clamped}`);

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);
