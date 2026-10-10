#!/usr/bin/env node
// 描述自动改进自测：preview 不写库 / apply 写库 / undo 还原（角色 + 环境）

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'desc-'));
process.env.FACTORY_DB = path.join(TMP, 't.db');
process.env.FACTORY_DATA_DIR = path.join(TMP, 'data');
process.env.FACTORY_CONFIG = path.join(TMP, 'config.json');
fs.mkdirSync(process.env.FACTORY_DATA_DIR, { recursive: true });
fs.writeFileSync(process.env.FACTORY_CONFIG, JSON.stringify({ llm: { provider: 'mock' }, image: { backend: 'placeholder' } }));

const { migrate, get } = await import('../src/db.js');
const { createActor, ensureDefaultCanvas, createAsset } = await import('../src/modules/actors.js');
const { preview, applyPreview, undoPreview } = await import('../src/describe.js');
const { createApp, createServer } = await import('../src/http.js');
const { registerCanvasEnhanceRoutes } = await import('../src/routes/canvas-enhance.js');

migrate();
ensureDefaultCanvas();

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}${extra ? `  ← ${extra}` : ''}`); }
  else { fail += 1; console.error(`  ✗ ${name}  ${extra}`); }
};
async function check(name, fn) {
  try { const extra = await fn(); ok(name, true, extra || ''); }
  catch (err) { ok(name, false, err.message); }
}

const shen = createActor({ name: '沈砚', gender: 'male', age: 28, race: 'east-asian', role_type: '男主', style_id: 'cinematic-real' });
const scene = createAsset({ canvas_id: 'CV-MAIN', kind: 'scene', title: '雾港码头', data: { desc: '深夜栈桥', tags: ['场景'] } });

console.log('\n=== 1. 角色描述改进 ===');
let actorToken = '';
await check('preview 返回 before/after 且不写库', async () => {
  const before = get('SELECT * FROM actors WHERE id = ?', shen.id);
  const r = await preview('actor', shen.id);
  assert.equal(r.ok, true);
  assert.ok(r.token);
  assert.ok(r.after.personality && r.after.costume && r.after.face && r.after.voice);
  const after = get('SELECT * FROM actors WHERE id = ?', shen.id);
  assert.equal(after.personality || '', before.personality || '');
  actorToken = r.token;
  return `source=${r.source} / ${r.after.personality.slice(0, 16)}…`;
});
await check('apply 写库并返回 undoToken', async () => {
  const r = applyPreview(actorToken, {});
  assert.equal(r.ok, true);
  assert.ok(r.undoToken);
  const a = get('SELECT * FROM actors WHERE id = ?', shen.id);
  assert.ok(a.personality && a.costume && a.face && a.voice, 'fields written');
  actorToken = r.undoToken;
  return `costume=${a.costume.slice(0, 24)}…`;
});
await check('undo 还原到改动前', async () => {
  const before = get('SELECT * FROM actors WHERE id = ?', shen.id).personality;
  const r = undoPreview(actorToken);
  assert.equal(r.ok, true);
  const after = get('SELECT * FROM actors WHERE id = ?', shen.id).personality;
  assert.notEqual(after, before);
  return 'restored';
});
await check('过期/伪造 token 被拒绝', async () => {
  assert.throws(() => applyPreview('DSC-not-exist', {}), /过期|不存在/);
  return 'rejected';
});

console.log('\n=== 2. 环境/物品描述改进 ===');
let assetToken = '';
await check('preview 补 desc/mood/palette/cameraNotes', async () => {
  const r = await preview('asset', scene.node.id);
  assert.equal(r.ok, true);
  assert.ok(r.after.desc && r.after.palette && r.after.cameraNotes);
  assetToken = r.token;
  return `source=${r.source} / palette=${String(r.after.palette).slice(0, 28)}`;
});
await check('apply 写入节点 data，undo 还原', async () => {
  const nodeBefore = JSON.parse(get('SELECT * FROM canvas_nodes WHERE id = ?', scene.node.id).data || '{}');
  const applied = applyPreview(assetToken, {});
  assert.equal(applied.ok, true);
  const nodeMid = JSON.parse(get('SELECT * FROM canvas_nodes WHERE id = ?', scene.node.id).data || '{}');
  assert.ok(nodeMid.palette && nodeMid.cameraNotes);
  const back = undoPreview(applied.undoToken);
  assert.equal(back.ok, true);
  const nodeAfter = JSON.parse(get('SELECT * FROM canvas_nodes WHERE id = ?', scene.node.id).data || '{}');
  assert.equal(nodeAfter.palette || '', nodeBefore.palette || '');
  return 'applied+undone';
});

console.log('\n=== 3. HTTP 路由 ===');
const { app, handle } = createApp();
registerCanvasEnhanceRoutes(app);
const server = createServer((req, res) => handle(req, res, {}));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;
const post = (u, b) => fetch(BASE + u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) }).then((r) => r.json());
await check('POST /api/describe/preview|apply|undo 全链路 200', async () => {
  const p = await post('/api/describe/preview', { scope: 'actor', id: shen.id });
  assert.equal(p.ok, true);
  const a = await post('/api/describe/apply', { token: p.token });
  assert.equal(a.ok, true);
  const u = await post('/api/describe/undo', { token: a.undoToken });
  assert.equal(u.ok, true);
  return 'preview→apply→undo';
});

if (server.closeAllConnections) server.closeAllConnections();
await new Promise((resolve) => server.close(resolve));

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
process.exitCode = fail ? 1 : 0;
