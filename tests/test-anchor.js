#!/usr/bin/env node
// 前三镜锚定：保存/通过/闸门三档
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-'));
process.env.FACTORY_DB = path.join(TMP, 'a.db');
process.env.FACTORY_DATA_DIR = path.join(TMP, 'data');
process.env.FACTORY_CONFIG = path.join(TMP, 'config.json');
fs.mkdirSync(process.env.FACTORY_DATA_DIR, { recursive: true });
fs.writeFileSync(process.env.FACTORY_CONFIG, JSON.stringify({ llm: { provider: 'mock' }, image: { backend: 'placeholder' }, video: { backend: 'placeholder' } }));

const { migrate, run } = await import('../src/db.js');
const A = await import('../src/anchor.js');
const { checkAnchorGate } = await import('../src/gate-middleware.js');
const { nowISO } = await import('../src/util.js');

migrate(); A.ensureAnchorSchema();
let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`  PASS ${n}${e ? ` -> ${e}` : ''}`); } else { fail++; console.error(`  FAIL ${n}${e ? ` -> ${e}` : ''}`); } };

const now = nowISO();
run(`INSERT INTO script_episodes(id,script_id,season,episode,code,title,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`,
  'EP-A1', 'SC-A', 1, 1, 'S01E001', '锚定测试', 'storyboard', now, now);

console.log('\n=== 1. 保存与通过 ===');
let st = A.anchorStatus('SC-A', 'S01E001');
ok('初始未锚定', st.exists === false && st.approved === false, '');
const a = A.upsertAnchor({ scriptId: 'SC-A', code: 'S01E001', episodeId: 'EP-A1', shotIds: ['SH-1', 'SH-2', 'SH-3'], model: 'm1', seed: '42', operator: '导演' });
ok('保存为草稿', a.status === 'draft', a.status);
ok('只保留前 3 镜', JSON.parse(a.shot_ids).length === 3, a.shot_ids);
const ap = A.approveAnchor('SC-A', 'S01E001', '导演');
ok('通过后状态 approved', ap.status === 'approved' && ap.approved_by === '导演', ap.status);

console.log('\n=== 2. 锚定闸门 ===');
let g = checkAnchorGate({ scriptId: 'SC-A', code: 'S01E001', shotIds: ['1', '2', '3', '4'], path: '/api/render/keyframes', mode: 'strict' });
ok('已锚定时 batch 放行', g.ok === true && g.anchored === true, '');
g = checkAnchorGate({ scriptId: 'SC-A', code: 'S01E001', shotIds: ['1'], path: '/api/render/keyframes', mode: 'strict' });
ok('单镜请求不受锚定限制', g.ok === true && g.skipped === true, g.reason || '');

A.upsertAnchor({ scriptId: 'SC-A', code: 'S01E001', episodeId: 'EP-A1', shotIds: ['SH-1', 'SH-2', 'SH-3'] });
g = checkAnchorGate({ scriptId: 'SC-A', code: 'S01E001', shotIds: ['1', '2', '3', '4'], path: '/api/render/videos', mode: 'warn' });
ok('warn：未锚定放行并告警', g.ok === true && g.anchored === false && /warn/.test(g.warning || ''), g.warning || '');
g = checkAnchorGate({ scriptId: 'SC-A', code: 'S01E001', shotIds: ['1', '2', '3', '4'], path: '/api/render/videos', mode: 'confirm' });
ok('confirm：未锚定阻断', g.ok === false && g.gate === 'anchor', '');
g = checkAnchorGate({ scriptId: 'SC-A', code: 'S01E001', shotIds: ['1', '2', '3', '4'], path: '/api/render/videos', mode: 'strict' });
ok('strict：未锚定阻断', g.ok === false && g.gate === 'anchor', '');
g = checkAnchorGate({ scriptId: 'SC-A', code: 'S01E001', shotIds: null, path: '/api/render/assemble', mode: 'strict' });
ok('整集合成视为 batch', g.ok === false && g.gate === 'anchor', '');

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(fail ? 1 : 0);
