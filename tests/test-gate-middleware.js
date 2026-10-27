#!/usr/bin/env node
// 后端请求级闸门：未过审拒绝、force 放行并审计、body 可重放
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-mw-'));
process.env.FACTORY_DB = path.join(TMP, 'm.db');
process.env.FACTORY_DATA_DIR = path.join(TMP, 'data');
process.env.FACTORY_CONFIG = path.join(TMP, 'config.json');
fs.mkdirSync(process.env.FACTORY_DATA_DIR, { recursive: true });
fs.writeFileSync(process.env.FACTORY_CONFIG, JSON.stringify({ llm: { provider: 'mock' }, image: { backend: 'placeholder' }, video: { backend: 'placeholder' } }));

const { migrate, run, get } = await import('../src/db.js');
const { ensureEditSchema } = await import('../src/edit-timeline.js');
const { ensureReviewSchema } = await import('../src/script-review.js');
const { isGatedPath, checkScriptGate, replayRequest } = await import('../src/gate-middleware.js');
const { nowISO } = await import('../src/util.js');

migrate(); ensureReviewSchema(); ensureEditSchema();
let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`  PASS ${n}${e ? ` -> ${e}` : ''}`); } else { fail++; console.error(`  FAIL ${n}${e ? ` -> ${e}` : ''}`); } };

const now = nowISO();
run(`INSERT INTO script_episodes(id,script_id,season,episode,code,title,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`,
  'EP-M1', 'SC-M', 1, 1, 'S01E001', '中间件测试', 'storyboard', now, now);

console.log('\n=== 1. 路径识别 ===');
ok('keyframes 被纳入闸门', isGatedPath('/api/render/keyframes'));
ok('videos 被纳入闸门', isGatedPath('/api/render/videos?x=1'));
ok('普通接口不拦', !isGatedPath('/api/health'));

console.log('\n=== 2. 剧本闸门 ===');
let r = checkScriptGate({ scriptId: 'SC-M', code: 'S01E001' });
ok('draft 被拒绝', r.ok === false && r.blocked === true, `${r.status}`);
ok('缺失参数不拦（交给原路由报错）', checkScriptGate({}).ok === true, '');

r = checkScriptGate({ scriptId: 'SC-M', code: 'S01E001', force: true, operator: '测试员', reason: '验收强制' });
ok('force 放行', r.ok === true && r.forced === true, '');
const row = get("SELECT * FROM audit_log WHERE action='gate:force' ORDER BY at DESC LIMIT 1");
ok('force 写入审计', !!row && row.actor === '测试员' && /验收强制/.test(row.detail || ''), row ? row.detail.slice(0, 60) : '无');

run("UPDATE script_episodes SET review_status='approved' WHERE id='EP-M1'");
r = checkScriptGate({ scriptId: 'SC-M', code: 'S01E001' });
ok('approved 放行', r.ok === true && r.approved === true, r.status);

console.log('\n=== 3. body 重放 ===');
const req = { method: 'POST', url: '/api/render/keyframes', headers: { 'content-type': 'application/json' }, httpVersion: '1.1', socket: {}, connection: {} };
const stream = replayRequest(req, Buffer.from('{"scriptId":"SC-M","code":"S01E001"}'));
let buf = '';
for await (const chunk of stream) buf += chunk;
ok('重放流保留方法与 URL', stream.method === 'POST' && stream.url === '/api/render/keyframes', '');
ok('重放流内容一致', buf === '{"scriptId":"SC-M","code":"S01E001"}', buf);

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(fail ? 1 : 0);
