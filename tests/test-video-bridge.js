#!/usr/bin/env node
// 视频适配桥：时长钳制 / 空首帧剔除 / 合法首帧保留
import assert from 'node:assert/strict';
process.env.FACTORY_CONFIG = process.env.FACTORY_CONFIG || '/tmp/nonexistent-config.json';
const { normalizeVideoBody } = await import('../scripts/video-bridge.js');
let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`  PASS ${n}${e ? ` -> ${e}` : ''}`); } else { fail++; console.error(`  FAIL ${n}${e ? ` -> ${e}` : ''}`); } };
const text = { type: 'text', text: '雨夜码头' };
const img = (url) => ({ type: 'image_url', image_url: { url }, role: 'first_frame' });

let r = normalizeVideoBody({ duration: 3, content: [text, img('')] });
ok('3 秒钳制到 4 秒', r.duration === 4, `duration=${r.duration}`);
ok('空首帧被剔除（退化为文生视频）', r.content.length === 1 && r.content[0].type === 'text', `content=${r.content.length}`);

r = normalizeVideoBody({ duration: 40, content: [text] });
ok('40 秒钳制到 30 秒', r.duration === 30, `duration=${r.duration}`);

r = normalizeVideoBody({ duration: 7, content: [text, img('data:image/jpeg;base64,abc')] });
ok('正常时长保留（7 秒）', r.duration === 7, `duration=${r.duration}`);
ok('合法首帧保留', r.content.length === 2 && r.content[1].image_url.url.startsWith('data:image/'), '');

r = normalizeVideoBody({ duration: 'abc', content: [text] });
ok('非法时长回退 5 秒', r.duration === 5, `duration=${r.duration}`);

r = normalizeVideoBody({ duration: 5, content: [text, { type: 'first_frame', url: 'data:image/jpeg;base64,abc' }, { type: 'last_frame', url: '' }] });
ok('空尾帧被剔除（Kling 风格）', r.content.length === 2 && r.content.some((x) => x.type === 'first_frame') && !r.content.some((x) => x.type === 'last_frame'), `content=${r.content.map((x) => x.type).join(',')}`);

r = normalizeVideoBody({ duration: 5, content: [{ type: 'text', text: '镜头(C-0001)缓慢推进' }] });
ok('提示词实体编号被清洗', !/C-0001/.test(r.content[0].text), r.content[0].text);

r = normalizeVideoBody({ duration: 5, content: [text], keyframes: { frame0: { url: 'data:image/jpeg;base64,abc' }, frame1: { url: '' } } });
ok('Luma 空尾帧被剔除', !!r.keyframes && !!r.keyframes.frame0 && !r.keyframes.frame1, JSON.stringify(r.keyframes));

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);
