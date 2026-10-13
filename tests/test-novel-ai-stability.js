#!/usr/bin/env node
// Module 2: AI settings persistence, character archive and async task stability.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-stability-test-'));
process.env.FACTORY_DB = path.join(TMP, 'stability.db');
process.env.FACTORY_DATA_DIR = path.join(TMP, 'data');
process.env.FACTORY_CONFIG = path.join(TMP, 'config.json');
fs.mkdirSync(process.env.FACTORY_DATA_DIR, { recursive: true });
fs.writeFileSync(process.env.FACTORY_CONFIG, JSON.stringify({ llm: { provider: 'mock' }, image: { backend: 'placeholder' } }));

const { migrate, run, get, all } = await import('../src/db.js');
const { nowISO } = await import('../src/util.js');
const { getNovelAiSettings, updateNovelAiSettings, archiveCharacterLink, listNovelCharacterArchive } = await import('../src/novel-settings.js');
const { createActor } = await import('../src/modules/actors.js');
const { createApp, createServer } = await import('../src/http.js');
const { registerNovelAiRoutes } = await import('../src/routes/novel-ai.js');
const { getJob } = await import('../src/jobs.js');

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

const now = nowISO();
run(`INSERT INTO novels(id, title, genre, cast_size, target_words, chapter_words, pov, actor_ids, custom_actors, seasons, status, meta, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
'N-STABLE', '稳定性测试', 'time-loop', 200, 12000, 3000, 'third-limited', '[]', '[]', 1, 'draft', '{}', now, now);
run(`INSERT INTO novel_outlines(id, novel_id, version, status, payload, raw, model, tokens, elapsed_ms, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
'O-STABLE', 'N-STABLE', 1, 'ready', JSON.stringify({
  logline: '循环测试',
  storyline: { opening_logic: '醒来', ending_logic: '破局' },
  chapters: Array.from({ length: 4 }, (_, i) => ({ idx: i + 1, title: `第${i + 1}章`, summary: '测试剧情' })),
}), '', 'mock', 0, 0, now, now);

console.log('\n=== 1. AI 设置原子读写 ===');
await check('默认设置自动迁移并保存', async () => {
  let s = getNovelAiSettings('N-STABLE');
  assert.equal(s.characterFreeEnabled, true);
  s = updateNovelAiSettings('N-STABLE', { titleDescription: '循环侦探故事', autoPov: true, autoCast: true, unlimitedCharacters: true });
  assert.equal(s.titleDescription, '循环侦探故事');
  assert.equal(s.autoPov, true);
  s = updateNovelAiSettings('N-STABLE', { maxCharacters: 88, stylePolicy: '冷峻电影感' });
  assert.equal(s.maxCharacters, 88);
  assert.equal(s.titleDescription, '循环侦探故事', 'partial update must preserve titleDescription');
  return `${s.maxCharacters} / ${s.stylePolicy}`;
});

console.log('\n=== 2. 小说角色归档 ===');
await check('角色链接唯一，重复归档只保留一条', async () => {
  const actor = createActor({ name: '秦岚', role_type: '配角', style_id: 'cinematic-real' });
  archiveCharacterLink('N-STABLE', actor, { source: '测试', reason: '关键线索', firstAppearance: '第2章', storylineRole: '揭开循环规则' });
  archiveCharacterLink('N-STABLE', actor, { source: '测试更新', reason: '关键线索2', firstAppearance: '第2章', storylineRole: '主线反转' });
  assert.equal(all('SELECT COUNT(*) AS c FROM novel_character_links WHERE novel_id = ?', 'N-STABLE')[0].c, 1);
  const archive = listNovelCharacterArchive('N-STABLE');
  assert.equal(archive.characters.length, 1);
  assert.equal(archive.characters[0].actor_id, actor.id);
  return `${actor.id} archived`;
});

console.log('\n=== 3. 路由和异步任务 ===');
const { app, handle } = createApp();
registerNovelAiRoutes(app);
const server = createServer((req, res) => handle(req, res, {}));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
await check('AI 设置和角色归档接口', async () => {
  const put = await fetch(`${base}/api/novels/N-STABLE/ai-settings`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ titleDescription: '路由更新' }),
  });
  assert.equal(put.status, 200);
  const settings = await (await fetch(`${base}/api/novels/N-STABLE/ai-settings`)).json();
  assert.equal(settings.titleDescription, '路由更新');
  const archive = await (await fetch(`${base}/api/novels/N-STABLE/characters/archive`)).json();
  assert.equal(archive.characters.length, 1);
  return archive.characters[0].name;
});
await check('费用预估接口返回调用次数', async () => {
  const json = await (await fetch(`${base}/api/novels/N-STABLE/estimate?action=outline`)).json();
  assert.ok(json.estimate.llmCalls > 0);
  return `${json.estimate.llmCalls} calls`;
});
await check('一键重写创建异步任务并完成', async () => {
  const started = await (await fetch(`${base}/api/novels/N-STABLE/outline/ai/rewrite-all`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ instruction: '测试' }),
  })).json();
  assert.match(started.jobId, /^JOB-/);
  let job = null;
  for (let i = 0; i < 80; i += 1) {
    job = getJob(started.jobId);
    if (['done', 'error', 'canceled'].includes(job.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(job.status, 'done');
  assert.equal(job.result.saved, true);
  return `${started.jobId} ${job.progress}%`;
});

if (server.closeAllConnections) server.closeAllConnections();
await new Promise((resolve) => server.close(resolve));
console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
process.exitCode = fail ? 1 : 0;
