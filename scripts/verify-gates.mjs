#!/usr/bin/env node
// 5 条闸门验收：剧本阻断 / 镜头契约 / 强制继续审计 / 提示词清洗 / 视频双模板
// 用法：node scripts/verify-gates.mjs [scriptId] [code]
import { normalizeVideoBody } from './video-bridge.js';

const BASE = process.env.BASE || 'http://127.0.0.1:8788';
const IMG = process.env.IMG_BRIDGE || 'http://127.0.0.1:8791';
const SCRIPT = process.argv[2] || 'SC-0001';
const CODE = process.argv[3] || 'S01E001';
let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`  PASS ${n}${e ? ` -> ${e}` : ''}`); } else { fail++; console.error(`  FAIL ${n}${e ? ` -> ${e}` : ''}`); } };
const getj = async (u) => { const r = await fetch(u); return r.json(); };
const postj = async (u, b) => { const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); return r.json(); };

console.log(`\n=== 1. 剧本闸门（${SCRIPT} / ${CODE}）===`);
const gate = await getj(`${BASE}/api/gates/episode?script_id=${encodeURIComponent(SCRIPT)}&code=${encodeURIComponent(CODE)}`);
ok('接口返回', gate.ok === true, gate.message || '');
ok('草稿集被阻断', gate.blocked === true && gate.approved === false, `status=${gate.episode?.status}`);

console.log('\n=== 2. 镜头契约 ===');
const contract = await getj(`${BASE}/api/gates/contract?script_id=${encodeURIComponent(SCRIPT)}&code=${encodeURIComponent(CODE)}`);
ok('接口返回', contract.ok === true, '');
ok('超标被识别', contract.contractOk === false && (contract.issues || []).length > 0, JSON.stringify(contract.summary));
ok('问题含镜头数/时长/台词', (contract.issues || []).some((i) => ['shot_count', 'duration_long', 'duration_short', 'dialogue_long'].includes(i.type)), (contract.issues || []).map((i) => i.type).join(','));

console.log('\n=== 3. 强制继续 + 审计 ===');
const ov = await postj(`${BASE}/api/gates/override`, { scriptId: SCRIPT, code: CODE, gate: 'script-lock', reason: '验收测试：5 条闸门自检', operator: '验收脚本' });
ok('强制继续返回审计成功', ov.ok === true && ov.audited === true, JSON.stringify({ episodeId: ov.episodeId, gate: ov.gate }));

console.log('\n=== 4. 提示词清洗（出图桥 dryRun）===');
const img = await postj(`${IMG}/generate`, { prompt: '镜头(C-0105)缓慢推进，青石镇(L-0002)雨夜', width: 1024, height: 1024, style: 'cinematic', dryRun: true });
ok('dryRun 返回清洗后提示词', img.ok === true && typeof img.promptUsed === 'string', String(img.promptUsed || '').slice(0, 80));
ok('实体编号被去掉', !/C-0105|L-0002/.test(img.promptUsed || ''), img.promptUsed || '');
ok('cinematic 质感已追加', /cinematic/i.test(img.promptUsed || ''), '');

console.log('\n=== 5. 视频双模板（有图/无图）===');
const v1 = normalizeVideoBody({ duration: 3, content: [{ type: 'text', text: '镜头(C-0001)推进' }, { type: 'first_frame', url: 'data:image/jpeg;base64,abc' }, { type: 'last_frame', url: '' }] });
ok('3 秒钳到 4 秒', v1.duration === 4, `duration=${v1.duration}`);
ok('首帧保留、空尾帧剔除', v1.content.some((x) => x.type === 'first_frame') && !v1.content.some((x) => x.type === 'last_frame'), v1.content.map((x) => x.type).join(','));
ok('视频提示词也去 ID', !/C-0001/.test(v1.content.find((x) => x.type === 'text')?.text || ''), '');

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);
