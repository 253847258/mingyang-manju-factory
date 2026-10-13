#!/usr/bin/env node
// Module 2: 100-genre creative engine regression suite.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'genre-frameworks-test-'));
process.env.FACTORY_DB = path.join(TMP, 'genre.db');
process.env.FACTORY_DATA_DIR = path.join(TMP, 'data');
process.env.FACTORY_CONFIG = path.join(TMP, 'config.json');
fs.mkdirSync(process.env.FACTORY_DATA_DIR, { recursive: true });
fs.writeFileSync(process.env.FACTORY_CONFIG, JSON.stringify({ llm: { provider: 'mock' } }));

const { migrate } = await import('../src/db.js');
const { GENRES } = await import('../src/data/genres.js');
const { buildGenreCreativeBlueprint, listGenreCreativeBlueprints } = await import('../src/genre-frameworks.js');
const { buildFrameworkPrompt } = await import('../src/novel-ai.js');
const { createApp, createServer } = await import('../src/http.js');
const { registerNovelAiRoutes } = await import('../src/routes/novel-ai.js');

migrate();
let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  PASS ${name}${extra ? ` -> ${extra}` : ''}`); }
  else { fail += 1; console.error(`  FAIL ${name}${extra ? ` -> ${extra}` : ''}`); }
};
async function check(name, fn) {
  try { ok(name, true, (await fn()) || ''); }
  catch (err) { ok(name, false, err.message); }
}

console.log('\n=== 1. 100 题材创意引擎 ===');
await check('100 种题材全部生成独立蓝图', async () => {
  const blueprints = listGenreCreativeBlueprints();
  assert.equal(blueprints.length, 100);
  assert.equal(new Set(blueprints.map((x) => x.genreId)).size, 100);
  return `${blueprints.length} 套`;
});
await check('每套蓝图包含爆款、世界、人物、开局结局和续集引擎', async () => {
  for (const genre of GENRES) {
    const b = buildGenreCreativeBlueprint(genre.id);
    assert.equal(b.genreId, genre.id);
    assert.ok(b.worldStyle && b.worldRules && b.coreLoopCrisis && b.ultimateMystery);
    assert.ok(b.protagonistFormula && b.protagonistSpecial && b.openingFormula && b.endingDirection);
    assert.ok(b.hitHooks.length >= 5);
    assert.ok(b.sequelEngine.newRegions && b.sequelEngine.newFactions && b.sequelEngine.newCrisis);
  }
  return '字段完整';
});
await check('同分类不同题材仍有差异化定位', async () => {
  const a = buildGenreCreativeBlueprint('urban-revenge');
  const b = buildGenreCreativeBlueprint('urban-awaken');
  assert.notEqual(a.creativePositioning, b.creativePositioning);
  assert.notEqual(a.sourceHook, b.sourceHook);
  return '开局钩子与定位不同';
});
await check('故事框架提示词注入题材蓝图和 7 模块要求', async () => {
  const prompt = buildFrameworkPrompt({ genre: 'time-loop', title: '循环测试', targetWords: 600000 });
  assert.match(prompt.user, /题材创意引擎/);
  assert.match(prompt.user, /time-loop/);
  assert.match(prompt.user, /hitHooks/);
  assert.match(prompt.user, /sequelEngine/);
  assert.match(prompt.user, /固定 7 模块/);
  return `${prompt.user.length} 字`;
});

console.log('\n=== 2. HTTP 接口 ===');
const { app, handle } = createApp();
registerNovelAiRoutes(app);
const server = createServer((req, res) => handle(req, res, {}));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
await check('GET 全量题材蓝图返回 100 套', async () => {
  const res = await fetch(`${base}/api/novels/ai/genre-blueprints`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.count, 100);
  assert.equal(json.blueprints.length, 100);
  return `${json.count}`;
});
await check('按题材 ID 查询单个创意引擎', async () => {
  const res = await fetch(`${base}/api/novels/ai/genre-blueprints?genre=time-loop`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.blueprint.genreId, 'time-loop');
  assert.ok(json.blueprint.hitHooks.length >= 5);
  return json.blueprint.genreName;
});

if (server.closeAllConnections) server.closeAllConnections();
await new Promise((resolve) => server.close(resolve));
console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
process.exitCode = fail ? 1 : 0;
