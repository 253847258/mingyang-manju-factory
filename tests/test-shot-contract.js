#!/usr/bin/env node
import assert from 'node:assert/strict';
const { validateShots, DEFAULT_CONTRACT } = await import('../src/shot-contract.js');
let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`  PASS ${n}${e ? ` -> ${e}` : ''}`); } else { fail++; console.error(`  FAIL ${n}${e ? ` -> ${e}` : ''}`); } };

const shot = (i, over = {}) => ({ id: `S${i}`, idx: i, duration: 4, dialogue: '', prompt_pos: 'cinematic wide shot', ...over });
const good = Array.from({ length: 10 }, (_, i) => shot(i + 1));
let r = validateShots(good);
ok('合规分镜通过', r.ok && r.issues.length === 0, JSON.stringify(r.summary));
ok('默认契约 8–12 镜 / 3–6s / 台词≤30', DEFAULT_CONTRACT.minShots === 8 && DEFAULT_CONTRACT.maxShots === 12 && DEFAULT_CONTRACT.maxSec === 6 && DEFAULT_CONTRACT.maxDialogue === 30, '');

const many = Array.from({ length: 33 }, (_, i) => shot(i + 1, { duration: i < 6 ? 8 : 4 }));
r = validateShots(many);
ok('镜头数超标被识别', r.issues.some((x) => x.type === 'shot_count'), r.issues.map((x) => x.type).join(','));
ok('超长镜头被识别', r.issues.some((x) => x.type === 'duration_long' && x.shotIds.length === 6), '');

const longTalk = [shot(1, { dialogue: '这是一段非常非常长的台词，长到一镜根本读不完，需要拆成好几个镜头才行，否则字幕会飞起来。' })];
r = validateShots(longTalk);
ok('超长台词被识别', r.issues.some((x) => x.type === 'dialogue_long'), '');

const emptyPrompt = [shot(1, { prompt_pos: '   ' })];
r = validateShots(emptyPrompt);
ok('空提示词是 blocker', r.issues.some((x) => x.type === 'prompt_empty' && x.severity === 'blocker'), '');

r = validateShots(Array.from({ length: 5 }, (_, i) => shot(i + 1, { duration: 2 })));
ok('镜头过少/过短被识别', r.issues.some((x) => x.type === 'shot_count') && r.issues.some((x) => x.type === 'duration_short'), '');

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);
