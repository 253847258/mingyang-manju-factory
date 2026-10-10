#!/usr/bin/env node
// 画布一致性闸门自测：离群标红 / 一键重跑跳过锁定

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cons-'));
process.env.FACTORY_DB = path.join(TMP, 't.db');
process.env.FACTORY_DATA_DIR = path.join(TMP, 'data');
process.env.FACTORY_CONFIG = path.join(TMP, 'config.json');
fs.mkdirSync(process.env.FACTORY_DATA_DIR, { recursive: true });
fs.writeFileSync(process.env.FACTORY_CONFIG, JSON.stringify({ llm: { provider: 'mock' }, image: { backend: 'placeholder' } }));

const { migrate, all, get, run } = await import('../src/db.js');
const { createActor, ensureDefaultCanvas, upsertCanvasNode, setNodeLocked } = await import('../src/modules/actors.js');
const { renderPlaceholderPng, encodePng } = await import('../src/pngd.js');
const { scoreActor, scoreCanvas } = await import('../src/canvas-consistency.js');
const { createApp, createServer } = await import('../src/http.js');
const { registerCanvasEnhanceRoutes } = await import('../src/routes/canvas-enhance.js');
const { nowISO, rid } = await import('../src/util.js');

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

const IMG_DIR = path.join(process.env.FACTORY_DATA_DIR, 'images');
fs.mkdirSync(IMG_DIR, { recursive: true });

const actor = createActor({ name: '林知夏', gender: 'female', age: 19, role_type: '女主', style_id: 'jp-anime' });
const dir = path.join(IMG_DIR, actor.id);
fs.mkdirSync(dir, { recursive: true });

function addImage(name, buf, isPrimary = 0, mime = 'image/png') {
  const abs = path.join(dir, name);
  fs.writeFileSync(abs, buf);
  run(
    `INSERT INTO actor_images(id, actor_id, kind, variant, label, file_path, mime, is_primary, status, created_at)
     VALUES(?,?,?,?,?,?,?,?, 'done', ?)`,
    rid('IMG'), actor.id, 'sheet-keyart', name.replace(/\.(png|jpg)$/, ''), name, abs, mime, isPrimary, nowISO(),
  );
  return abs;
}

const same = renderPlaceholderPng({ width: 128, height: 128, label: 'SAME', actorId: actor.id, kind: 'face' });
for (let i = 0; i < 7; i += 1) addImage(`same${i}.png`, same, i === 0 ? 1 : 0);

// 真实离群图：一张纯白（aHash 全 1），一张 8×8 黑白棋盘（aHash 交替）
function solidPng(w, h, v) {
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i += 1) { rgba[i * 4] = v; rgba[i * 4 + 1] = v; rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = 255; }
  return encodePng({ width: w, height: h, rgba });
}
function checkerPng(size, block) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const on = (Math.floor(x / block) + Math.floor(y / block)) % 2 === 0;
      const v = on ? 255 : 0;
      const o = (y * size + x) * 4;
      rgba[o] = v; rgba[o + 1] = v; rgba[o + 2] = v; rgba[o + 3] = 255;
    }
  }
  return encodePng({ width: size, height: size, rgba });
}
addImage('out1.png', solidPng(160, 160, 255));
addImage('out2.png', checkerPng(160, 20));

let nodeId = '';
const existing = all('SELECT * FROM canvas_nodes WHERE canvas_id = ? AND actor_id = ?', 'CV-MAIN', actor.id);
if (existing.length) nodeId = existing[0].id;
else nodeId = upsertCanvasNode({ canvas_id: 'CV-MAIN', actor_id: actor.id, x: 0, y: 0 }).id;

console.log('\n=== 1. 一致性评分 ===');
await check('scoreActor 找到离群图', async () => {
  const r = await scoreActor(actor.id, { threshold: 0.34 });
  assert.equal(r.ok, true);
  assert.ok(r.images >= 3, 'images');
  assert.ok(r.low, 'low');
  assert.ok(r.outliers.length >= 1, 'outliers');
  return `images=${r.images} outliers=${r.outliers.length}`;
});
await check('scoreCanvas 标红该演员节点', async () => {
  const r = await scoreCanvas('CV-MAIN', { threshold: 0.34 });
  assert.equal(r.ok, true);
  const node = r.nodes.find((n) => n.id === nodeId);
  assert.ok(node, 'node present');
  assert.ok(node.low, 'node low');
  assert.ok(r.summary.low >= 1);
  return `checked=${r.summary.checked} low=${r.summary.low}`;
});

console.log('\n=== 2. 一键重跑（HTTP） ===');
const { app, handle } = createApp();
registerCanvasEnhanceRoutes(app);
const server = createServer((req, res) => handle(req, res, {}));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;
const post = (u, b) => fetch(BASE + u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) }).then((r) => r.json());

await check('GET /api/canvas/consistency 返回标红清单', async () => {
  const r = await (await fetch(`${BASE}/api/canvas/consistency?canvasId=CV-MAIN`)).json();
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.low));
  return `low=${r.low.length}`;
});
await check('rerun 对低分演员重跑一张新主图', async () => {
  const before = all('SELECT * FROM actor_images WHERE actor_id = ?', actor.id).length;
  const r = await post('/api/canvas/consistency/rerun', { canvasId: 'CV-MAIN', confirm: true });
  assert.equal(r.ok, true);
  const after = all('SELECT * FROM actor_images WHERE actor_id = ?', actor.id).length;
  assert.ok(after >= before, 'no image loss');
  assert.ok(Array.isArray(r.regenerated));
  return `rerun=${r.rerun}`;
});
await check('锁定节点在重跑中被跳过', async () => {
  setNodeLocked(nodeId, true);
  const r = await post('/api/canvas/consistency/rerun', { canvasId: 'CV-MAIN', confirm: true });
  assert.equal(r.ok, true);
  assert.equal(r.rerun, 0);
  assert.ok(/锁定|跳过|没有需要/.test(r.reason || ''), r.reason);
  setNodeLocked(nodeId, false);
  return r.reason;
});

console.log('\n=== 3. 可选：JPEG 支持（装了 sharp 才生效） ===');
await check('JPEG 图片也能参与打分（无 sharp 时跳过）', async () => {
  let sharp = null;
  try { sharp = (await import('sharp')).default; } catch { /* 未安装 */ }
  if (!sharp) return 'skipped（未安装 sharp，退回纯 JS 只支持 PNG）';
  const actor2 = createActor({ name: 'JPEG 角色', gender: 'female', style_id: 'jp-anime' });
  const dir2 = path.join(IMG_DIR, actor2.id);
  fs.mkdirSync(dir2, { recursive: true });
  const write = async (name, buf, primary) => {
    const f = path.join(dir2, name);
    await sharp(buf).jpeg({ quality: 78 }).toFile(f);
    run(
      `INSERT INTO actor_images(id, actor_id, kind, variant, label, file_path, mime, is_primary, status, created_at)
       VALUES(?,?,?,?,?,?,?,?, 'done', ?)`,
      rid('IMG'), actor2.id, 'sheet-keyart', name.replace(/\.jpg$/, ''), name, f, 'image/jpeg', primary, nowISO(),
    );
  };
  for (let i = 0; i < 7; i += 1) await write(`j${i}.jpg`, same, i === 0 ? 1 : 0);
  await write('jout1.jpg', solidPng(160, 160, 255), 0);
  await write('jout2.jpg', checkerPng(160, 20), 0);
  const r = await scoreActor(actor2.id, { threshold: 0.34 });
  assert.equal(r.ok, true);
  assert.equal(r.scored, 9, `scored=${r.scored} unreadable=${r.unreadable}`);
  assert.ok(r.low, 'low');
  return `scored=${r.scored} outliers=${r.outliers.length}`;
});

if (server.closeAllConnections) server.closeAllConnections();
await new Promise((resolve) => server.close(resolve));

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
process.exitCode = fail ? 1 : 0;
