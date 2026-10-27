#!/usr/bin/env node
// 生产闸门：剧本硬门禁 + 镜头契约 + 强制继续审计
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gates-'));
process.env.FACTORY_DB = path.join(TMP, 'g.db');
process.env.FACTORY_DATA_DIR = path.join(TMP, 'data');
process.env.FACTORY_CONFIG = path.join(TMP, 'config.json');
fs.mkdirSync(process.env.FACTORY_DATA_DIR, { recursive: true });
fs.writeFileSync(process.env.FACTORY_CONFIG, JSON.stringify({ llm: { provider: 'mock' }, image: { backend: 'placeholder' }, video: { backend: 'placeholder' } }));

const { migrate, run, get } = await import('../src/db.js');
const { ensureEditSchema } = await import('../src/edit-timeline.js');
const { ensureReviewSchema } = await import('../src/script-review.js');
const { createApp, createServer } = await import('../src/http.js');
const { registerGateRoutes } = await import('../src/routes/gates.js');
const { nowISO } = await import('../src/util.js');

migrate(); ensureReviewSchema(); ensureEditSchema();
let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`  PASS ${n}${e ? ` -> ${e}` : ''}`); } else { fail++; console.error(`  FAIL ${n}${e ? ` -> ${e}` : ''}`); } };

const now = nowISO();
run(`INSERT INTO script_episodes(id,script_id,season,episode,code,title,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`,
  'EP-G1', 'SC-G', 1, 1, 'S01E001', '闸门测试集', 'storyboard', now, now);
for (let i = 1; i <= 33; i += 1) {
  run(`INSERT INTO shots(id,script_id,episode_id,idx,duration,dialogue,prompt_pos,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)`,
    `SH-G${i}`, 'SC-G', 'EP-G1', i, i <= 6 ? 8 : 4, i === 1 ? '这是一段超过三十个字的超长台词，用来触发镜头契约里的台词长度检查。' : '', 'cinematic wide shot', 'draft', now);
}

const { app, handle } = createApp();
registerGateRoutes(app);
const server = createServer((req, res) => handle(req, res, {}));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const getj = async (u) => { const r = await fetch(base + u); return { status: r.status, json: await r.json() }; };

console.log('\n=== 1. 剧本闸门 ===');
let r = await getj('/api/gates/episode?script_id=SC-G&code=S01E001');
ok('draft 集被硬阻断', r.json.ok && r.json.blocked === true && r.json.approved === false, JSON.stringify(r.json.episode));
run("UPDATE script_episodes SET review_status='approved' WHERE id='EP-G1'");
r = await getj('/api/gates/episode?script_id=SC-G&code=S01E001');
ok('approved 集放行', r.json.blocked === false && r.json.approved === true, r.json.episode.status);

console.log('\n=== 2. 镜头契约 ===');
r = await getj('/api/gates/contract?script_id=SC-G&code=S01E001');
ok('33 镜被识别为超标', r.json.ok === true && r.json.contractOk === false && r.json.summary.shots === 33, JSON.stringify(r.json.summary));
ok('识别镜头数/超长镜/超长台词', ['shot_count', 'duration_long', 'dialogue_long'].every((t) => r.json.issues.some((i) => i.type === t)), r.json.issues.map((i) => i.type).join(','));

console.log('\n=== 3. 强制继续审计 ===');
r = await fetch(base + '/api/gates/override', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scriptId: 'SC-G', code: 'S01E001', gate: 'shot-contract', reason: '测试强制继续', operator: '测试员' }) });
const j = await r.json();
ok('override 返回成功', r.status === 200 && j.ok && j.audited === true, JSON.stringify(j));
const row = get("SELECT * FROM audit_log WHERE action='gate:override' ORDER BY at DESC LIMIT 1");
ok('审计已落库', !!row && row.actor === '测试员' && /测试强制继续/.test(row.detail || ''), row ? row.detail.slice(0, 80) : '无');

server.closeAllConnections?.();
await new Promise((res) => server.close(res));
console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(fail ? 1 : 0);
