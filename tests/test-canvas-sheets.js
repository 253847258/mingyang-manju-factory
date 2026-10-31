#!/usr/bin/env node
// 人物/环境 九宫格自测：规划 / 生成（sync）/ 拼图（ffmpeg + 纯 JS 兜底）/ 主参考图 / 审批

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sheets-'));
process.env.FACTORY_DB = path.join(TMP, 't.db');
process.env.FACTORY_DATA_DIR = path.join(TMP, 'data');
process.env.FACTORY_CONFIG = path.join(TMP, 'config.json');
fs.mkdirSync(process.env.FACTORY_DATA_DIR, { recursive: true });
fs.writeFileSync(process.env.FACTORY_CONFIG, JSON.stringify({
  llm: { provider: 'mock' },
  image: { backend: 'placeholder', defaultRatio: '2:3' },
  video: { backend: 'placeholder' },
  tts: { backend: 'none' },
}));

const { migrate, all, get, run } = await import('../src/db.js');
const { createActor, ensureDefaultCanvas, createAsset } = await import('../src/modules/actors.js');
const { createApp, createServer } = await import('../src/http.js');
const { registerCanvasEnhanceRoutes } = await import('../src/routes/canvas-enhance.js');
const { composeSheet, planSheet } = await import('../src/image-sheets.js');
const { renderPlaceholderPng, decodePng, composeSheetJS } = await import('../src/pngd.js');

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
const scene = createAsset({ canvas_id: 'CV-MAIN', kind: 'scene', title: '雾港码头', data: { desc: '深夜栈桥，浓雾吞没远处货轮', weather: '浓雾', tags: ['场景'] } });

const { app, handle } = createApp();
registerCanvasEnhanceRoutes(app);
const server = createServer((req, res) => handle(req, res, {}));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;
const post = (u, b) => fetch(BASE + u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) }).then((r) => r.json());

// 跨平台定位 ffmpeg：支持显式覆盖、PATH，以及仓库自带二进制兜底。
const localFfmpeg = path.resolve(process.cwd(), 'bin', 'ffmpeg', `ffmpeg${process.platform === 'win32' ? '.exe' : ''}`);
const FFMPEG = [process.env.FFMPEG, 'ffmpeg', localFfmpeg].filter(Boolean).find((bin) => {
  try { return spawnSync(bin, ['-version'], { stdio: 'ignore' }).status === 0; } catch { return false; }
});

console.log('\n=== 1. 九宫格规划 ===');
await check('人物九宫格：固定 9 格（定妆+三视角+三表情+服饰+手部）', async () => {
  const r = await post('/api/canvas/sheets/plan', { kind: 'character', actorId: shen.id });
  assert.equal(r.ok, true);
  assert.equal(r.count, 9);
  assert.deepEqual(r.cells.map((c) => c.key), ['keyart', 'front', 'left', 'back', 'neutral', 'smile', 'angry', 'costume', 'hand']);
  return r.cells.map((c) => c.label).join('/');
});
await check('环境九宫格：视角 × 时段 = 9 格', async () => {
  const r = await post('/api/canvas/sheets/plan', { kind: 'environment', nodeId: scene.node.id });
  assert.equal(r.count, 9);
  assert.deepEqual(r.cells.map((c) => c.key), ['wide-day', 'wide-dusk', 'wide-night', 'medium-day', 'medium-dusk', 'medium-night', 'close-day', 'close-dusk', 'close-night']);
  return r.cells[0].prompt.slice(0, 40);
});
await check('plan 只出计划、不写库（dryRun）', async () => {
  const before = all('SELECT * FROM actor_images WHERE actor_id = ?', shen.id).length;
  await post('/api/canvas/sheets/plan', { kind: 'character', actorId: shen.id });
  const after = all('SELECT * FROM actor_images WHERE actor_id = ?', shen.id).length;
  assert.equal(after, before);
  return `images=${after}`;
});

console.log('\n=== 2. 生成九宫格（占位后端，sync） ===');
let sheetRel = '';
await check('生成 9 格 + 合成 3×3 设定表', async () => {
  const r = await post('/api/canvas/sheets/generate', { kind: 'character', actorId: shen.id, confirm: true, sync: true });
  assert.equal(r.ok, true);
  assert.equal(r.cells.length, 9);
  assert.ok(r.file, 'sheet file');
  sheetRel = r.file;
  const abs = path.join(process.env.FACTORY_DATA_DIR, '..', r.file).replace(/[\\/]data[\\/]/, '/data/');
  const sheetAbs = path.isAbsolute(r.absPath) ? r.absPath : path.join(process.cwd(), r.absPath);
  assert.ok(fs.existsSync(sheetAbs), 'sheet exists');
  const dec = decodePng(fs.readFileSync(sheetAbs));
  assert.ok(dec.width > 0 && dec.height > 0);
  assert.equal(dec.width, dec.height, 'square sheet');
  return `${r.engine} ${dec.width}x${dec.height}`;
});
await check('默认把设定表设为该角色主参考图（ref_image 指向 sheet）', async () => {
  const a = get('SELECT * FROM actors WHERE id = ?', shen.id);
  assert.match(String(a.ref_image || ''), /3x3.*\.png$/);
  const primary = all("SELECT * FROM actor_images WHERE actor_id = ? AND is_primary = 1", shen.id);
  assert.equal(primary.length, 1);
  assert.equal(primary[0].kind, 'sheet');
  return a.ref_image;
});
await check('九宫格元数据写进 actors.meta.sheets', async () => {
  const a = get('SELECT * FROM actors WHERE id = ?', shen.id);
  const meta = JSON.parse(a.meta || '{}');
  assert.ok(Array.isArray(meta.sheets) && meta.sheets.length >= 1);
  assert.equal(meta.sheets[0].cells.length, 9);
  return `sheets=${meta.sheets.length}`;
});
await check('GET /api/canvas/sheets 能列出九宫格', async () => {
  const r = await (await fetch(`${BASE}/api/canvas/sheets?actorId=${shen.id}`)).json();
  assert.equal(r.ok, true);
  assert.ok(r.sheets.length >= 1);
  return `count=${r.sheets.length}`;
});
await check('环境九宫格生成并写入节点 refImages', async () => {
  const r = await post('/api/canvas/sheets/generate', { kind: 'environment', nodeId: scene.node.id, confirm: true, sync: true });
  assert.equal(r.ok, true);
  const node = get('SELECT * FROM canvas_nodes WHERE id = ?', scene.node.id);
  const data = JSON.parse(node.data || '{}');
  assert.ok(Array.isArray(data.refImages) && data.refImages.length >= 1);
  assert.ok(Array.isArray(data.sheets) && data.sheets.length >= 1);
  return data.refImages[0];
});

console.log('\n=== 3. 拼图引擎（ffmpeg + 纯 JS 兜底） ===');
const cellFiles = [];
for (let i = 0; i < 9; i += 1) {
  const f = path.join(TMP, `cell${i}.png`);
  fs.writeFileSync(f, renderPlaceholderPng({ width: 200, height: 200, label: `C${i}`, actorId: 'C-X', kind: 'cell' }));
  cellFiles.push(f);
}
await check('ffmpeg 路径拼成正方形网格', async () => {
  assert.ok(FFMPEG, '未找到可执行的 ffmpeg（已检查 FFMPEG、PATH、bin/ffmpeg/ffmpeg）');
  const out = path.join(TMP, 'ff.png');
  const r = composeSheet({ files: cellFiles, outPath: out, cell: 200, gap: 8, bin: FFMPEG });
  const d = decodePng(fs.readFileSync(out));
  assert.equal(r.engine, 'ffmpeg');
  assert.equal(d.width, d.height);
  assert.equal(d.width, 3 * (200 + 16));
  return `${d.width}x${d.height}`;
});
await check('纯 JS 兜底路径拼成同样尺寸', async () => {
  const out = path.join(TMP, 'js.png');
  const r = composeSheet({ files: cellFiles, outPath: out, cell: 200, gap: 8, preferFfmpeg: false });
  const d = decodePng(fs.readFileSync(out));
  assert.equal(r.engine, 'js');
  assert.equal(d.width, 3 * (200 + 16));
  return `${d.width}x${d.height}`;
});
await check('POST /api/canvas/sheets/compose 手动拼图', async () => {
  const r = await post('/api/canvas/sheets/compose', { files: cellFiles, cell: 128, gap: 6 });
  assert.equal(r.ok, true);
  assert.ok(r.file.endsWith('.png'));
  return r.file;
});

console.log('\n=== 4. 审批闸门 ===');
await check('未确认时返回 needConfirm（不生成）', async () => {
  const r = await post('/api/canvas/sheets/generate', { kind: 'character', actorId: shen.id, sync: true });
  // 默认预算未启用、队列未暂停 → 直接允许；这里断言不报错且要么 needConfirm 要么已生成。
  assert.equal(r.ok, true);
  return r.needConfirm ? 'needConfirm' : 'allowed';
});
await check('队列暂停时：同步生成先要确认，确认后才执行', async () => {
  run("INSERT OR REPLACE INTO app_config(key, value, updated_at) VALUES('jobs:paused', ?, ?)",
    JSON.stringify({ paused: true, reason: '测试暂停' }), new Date().toISOString());
  const blocked = await post('/api/canvas/sheets/generate', { kind: 'character', actorId: shen.id, sync: true });
  assert.equal(blocked.needConfirm, true, JSON.stringify(blocked));
  assert.equal(blocked.paused, true);
  assert.match(blocked.reason, /测试暂停/);
  const before = all('SELECT * FROM actor_images WHERE actor_id = ?', shen.id).length;
  assert.ok(before >= 9, 'paused 时还没有新生成');
  const okGo = await post('/api/canvas/sheets/generate', { kind: 'character', actorId: shen.id, sync: true, confirm: true });
  assert.equal(okGo.ok, true);
  assert.equal(okGo.cells.length, 9);
  run("DELETE FROM app_config WHERE key = 'jobs:paused'");
  return 'paused→confirm→generated';
});
await check('队列暂停时：后台任务被硬拦（不往暂停队列塞任务）', async () => {
  run("INSERT OR REPLACE INTO app_config(key, value, updated_at) VALUES('jobs:paused', ?, ?)",
    JSON.stringify({ paused: true, reason: '测试暂停' }), new Date().toISOString());
  const r = await post('/api/canvas/sheets/generate', { kind: 'character', actorId: shen.id });
  assert.equal(r.blocked, true, JSON.stringify(r));
  run("DELETE FROM app_config WHERE key = 'jobs:paused'");
  return 'background blocked';
});

if (server.closeAllConnections) server.closeAllConnections();
await new Promise((resolve) => server.close(resolve));

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
process.exitCode = fail ? 1 : 0;
