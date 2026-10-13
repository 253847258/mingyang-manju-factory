#!/usr/bin/env node
// Module 2: creative options, 100 tones and title-based genre planning.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-options-test-'));
process.env.FACTORY_DB = path.join(TMP, 'options.db');
process.env.FACTORY_DATA_DIR = path.join(TMP, 'data');
process.env.FACTORY_CONFIG = path.join(TMP, 'config.json');
fs.mkdirSync(process.env.FACTORY_DATA_DIR, { recursive: true });
fs.writeFileSync(process.env.FACTORY_CONFIG, JSON.stringify({ llm: { provider: 'mock' } }));

const { migrate, run } = await import('../src/db.js');
const { nowISO } = await import('../src/util.js');
const { CREATIVE_TONES, listCreativeOptions, planGenreFromTitle, getNovelCreativeOptions, updateNovelCreativeOptions } = await import('../src/novel-creative-options.js');
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

console.log('\n=== 1. 100 种基调与创作选项 ===');
await check('基调正好 100 种且不重复', async () => {
  assert.equal(CREATIVE_TONES.length, 100);
  assert.equal(new Set(CREATIVE_TONES).size, 100);
  assert.equal(listCreativeOptions().tones.length, 100);
  return CREATIVE_TONES.slice(0, 3).join('、');
});
await check('标题自动规划题材可从 100 种中选择', async () => {
  const r = await planGenreFromTitle({ title: '第七次死在同一个路口', titleDescription: '时间循环，每次死亡都会重启' });
  assert.equal(r.genreId, 'time-loop');
  assert.equal(r.mocked, true);
  assert.ok(r.confidence > 0);
  return `${r.genreName} ${Math.round(r.confidence * 100)}%`;
});

console.log('\n=== 2. 小说创作选项元数据 ===');
const now = nowISO();
run(`INSERT INTO novels(id, title, genre, cast_size, target_words, chapter_words, pov, actor_ids, custom_actors, seasons, status, meta, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
'N-OPT', '选项测试', 'time-loop', 200, 100000, 3000, 'third-limited', '[]', '[]', 1, 'draft', '{}', now, now);
await check('保存标题描述、AI视角、AI规模和无限角色开关', async () => {
  const r = updateNovelCreativeOptions('N-OPT', {
    titleDescription: '循环侦探故事', autoPov: true, autoCast: true, unlimitedCharacters: true,
  });
  assert.equal(r.titleDescription, '循环侦探故事');
  assert.equal(r.autoPov, true);
  assert.equal(r.autoCast, true);
  assert.equal(r.unlimitedCharacters, true);
  return JSON.stringify(r);
});

console.log('\n=== 3. HTTP 接口 ===');
const { app, handle } = createApp();
registerNovelAiRoutes(app);
const server = createServer((req, res) => handle(req, res, {}));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
await check('GET 创作选项返回 100 种基调', async () => {
  const res = await fetch(`${base}/api/novels/ai/creative-options`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.tones.length, 100);
  return `${json.tones.length}`;
});
await check('POST 题材自动规划返回命中的题材 ID', async () => {
  const res = await fetch(`${base}/api/novels/ai/plan-genre`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '循环监狱', titleDescription: '每次醒来都回到同一间牢房' }),
  });
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.genreId, 'time-loop');
  return `${json.genreName}`;
});
await check('GET/PUT 小说创作选项接口可用', async () => {
  const put = await fetch(`${base}/api/novels/N-OPT/creative-options`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ titleDescription: '更新描述', autoPov: true, autoCast: false, unlimitedCharacters: false }),
  });
  const pj = await put.json();
  assert.equal(put.status, 200);
  assert.equal(pj.options.titleDescription, '更新描述');
  const get = await fetch(`${base}/api/novels/N-OPT/creative-options`);
  const gj = await get.json();
  assert.equal(gj.autoPov, true);
  return gj.titleDescription;
});

if (server.closeAllConnections) server.closeAllConnections();
await new Promise((resolve) => server.close(resolve));
console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
process.exitCode = fail ? 1 : 0;
