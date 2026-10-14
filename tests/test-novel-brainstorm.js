#!/usr/bin/env node
// Module 2: 题材写作技能提示词、AI 头脑风暴创意题材规划、角色生图提示词。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-brainstorm-test-'));
process.env.FACTORY_DB = path.join(TMP, 'brainstorm.db');
process.env.FACTORY_DATA_DIR = path.join(TMP, 'data');
process.env.FACTORY_CONFIG = path.join(TMP, 'config.json');
fs.mkdirSync(process.env.FACTORY_DATA_DIR, { recursive: true });
fs.writeFileSync(process.env.FACTORY_CONFIG, JSON.stringify({ llm: { provider: 'mock' } }));

const { migrate, run, get } = await import('../src/db.js');
const { nowISO } = await import('../src/util.js');
const { GENRES, genreById } = await import('../src/data/genres.js');
const { buildGenreSkillPrompt } = await import('../src/genre-frameworks.js');
const { brainstormGenre, buildBrainstormPrompt } = await import('../src/novel-brainstorm.js');
const { buildFrameworkPrompt, commitCharacters } = await import('../src/novel-ai.js');
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

const targetGenre = genreById('time-loop') || GENRES[0];

console.log('\n=== 1. 题材写作技能提示词 ===');
await check('每个题材有专属 7 模块写作技能提示词', async () => {
  const r = buildGenreSkillPrompt(targetGenre.id);
  assert.equal(r.genreId, targetGenre.id);
  assert.ok(r.skillPrompt.length > 300, 'skillPrompt 应有实际内容');
  assert.ok(r.skillPrompt.includes(targetGenre.name), '应包含题材名');
  for (const m of ['模块 1', '模块 2', '模块 3', '模块 4', '模块 5', '模块 6', '模块 7']) {
    assert.ok(r.skillPrompt.includes(m), `缺少 ${m}`);
  }
  return `${r.genreName} ${r.skillPrompt.length} 字`;
});

console.log('\n=== 2. AI 头脑风暴创意题材规划（mock） ===');
await check('mock 下返回合法题材与 7 模块框架', async () => {
  const r = await brainstormGenre({ title: '第七次死在同一个路口', titleDescription: '时间循环，每次死亡都会重启', tone: '悬疑烧脑' });
  assert.equal(r.mocked, true);
  assert.ok(genreById(r.genreId), 'genreId 必须来自 100 种题材');
  assert.ok(r.frameworkIntro.includes('模块 1') && r.frameworkIntro.includes('模块 7'));
  assert.ok(r.castSize >= 1 && r.castSize <= 200);
  assert.ok(r.seasons >= 1);
  assert.ok(r.skillPrompt && r.skillPrompt.includes('技能提示词'));
  return `${r.genreName} / cast ${r.castSize} / seasons ${r.seasons}`;
});
await check('头脑风暴提示词包含 100 题材清单与硬性要求', async () => {
  const p = buildBrainstormPrompt({ title: '测试' });
  assert.ok(p.prompt.includes('可选题材'));
  assert.ok(p.prompt.includes('无限续集') || p.prompt.includes('续集'));
  assert.ok(p.prompt.includes('genreId'));
  return `${p.prompt.length} 字提示词`;
});

console.log('\n=== 3. 新角色生图提示词 ===');
await check('框架提示词要求产出 promptPos/promptNeg', async () => {
  const p = buildFrameworkPrompt({ title: '测试', genre: targetGenre.id });
  assert.ok(p.user.includes('promptPos'));
  assert.ok(p.user.includes('promptNeg'));
  return 'ok';
});
await check('commitCharacters 写入 prompt_pos/prompt_neg', async () => {
  const now = nowISO();
  run(`INSERT INTO novels(id, title, genre, cast_size, target_words, chapter_words, pov, actor_ids, custom_actors, seasons, status, meta, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  'N-BRAIN', '创意测试', targetGenre.id, 200, 200000, 3000, 'third-limited', '[]', '[]', 2, 'draft', '{}', now, now);
  const r = await commitCharacters({
    novelId: 'N-BRAIN',
    characters: [{
      name: '陆沉', role: '主角', gender: '男', age: '27',
      appearance: '面部清瘦、眼神冷峻', personality: '沉默但重情',
      costume: '黑色风衣', background: '旧案调查者', reason: '推动主线',
      promptPos: '1boy, young man, sharp eyes, black trench coat, cinematic lighting, film grain',
      promptNeg: 'extra fingers, deformed, lowres, watermark',
    }],
  });
  assert.equal(r.created.length, 1);
  const actor = get('SELECT * FROM actors WHERE id = ?', r.created[0].actorId);
  assert.ok(actor.prompt_pos && actor.prompt_pos.includes('black trench coat'), 'prompt_pos 应写入');
  assert.ok(actor.prompt_neg && actor.prompt_neg.includes('watermark'), 'prompt_neg 应写入');
  return `${actor.id} prompt_pos 已写入`;
});

console.log('\n=== 4. 路由 ===');
const { app, handle } = createApp();
registerNovelAiRoutes(app);
const server = createServer((req, res) => handle(req, res, {}));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
try {
  await check('GET /api/novels/ai/genre-skill-prompt', async () => {
    const res = await fetch(`${base}/api/novels/ai/genre-skill-prompt?genre=${encodeURIComponent(targetGenre.id)}`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.skillPrompt && data.skillPrompt.includes('模块 1'));
    return `${data.genreName}`;
  });
  await check('POST /api/novels/ai/brainstorm-genre', async () => {
    const res = await fetch(`${base}/api/novels/ai/brainstorm-genre`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '第九次重启', tone: '悬疑烧脑' }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(genreById(data.genreId));
    assert.ok(data.frameworkIntro.includes('模块 7'));
    return `${data.genreName}`;
  });
  await check('GET genre-skill-prompt 缺参数返回 400', async () => {
    const res = await fetch(`${base}/api/novels/ai/genre-skill-prompt`);
    assert.equal(res.status, 400);
    return '400';
  });
} finally {
  if (server.closeAllConnections) server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

console.log(`\n=== 汇总：${pass} 通过 / ${fail} 失败 ===`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
process.exitCode = fail ? 1 : 0;
