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
const { generateCustomGenre, GENRE_GENERATOR_OPTIONS } = await import('../src/novel-genre-generator.js');
const { saveGenreHistory, listGenreHistory, deleteGenreHistory, pruneGenreHistory, GENRE_HISTORY_MAX } = await import('../src/genre-history.js');
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

  await check('GET /genre-generator-options 返回选项集', async () => {
    const data = await (await fetch(`${base}/api/novels/ai/genre-generator-options`)).json();
    assert.ok(data.options.worlds.length >= 5);
    assert.ok(data.options.protagonists.length >= 5);
    assert.ok(data.options.conflicts.length >= 5);
    return `${data.options.worlds.length} 世界 / ${data.options.conflicts.length} 冲突`;
  });
  await check('POST /generate-genre 生成自定义题材', async () => {
    const res = await fetch(`${base}/api/novels/ai/generate-genre`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ world: 'future', protagonist: 'awaken', conflict: 'conspiracy', pace: 'twist', audience: 'all', tone: '悬疑烧脑', keyword: '深空 阴谋' }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.match(data.genreId, /^custom-/);
    assert.ok(data.frameworkIntro.includes('模块 7'));
    assert.ok(data.skillPrompt.includes('技能提示词'));
    return `${data.name}（${data.keywords.length} 关键词）`;
  });
  await check('题材生成器对未知选项回退到默认且不报错', async () => {
    const g = generateCustomGenre({ world: 'nope', protagonist: 'nope', conflict: 'nope' });
    assert.match(g.genreId, /^custom-/);
    assert.equal(g.name, `${GENRE_GENERATOR_OPTIONS.worlds[0].label}·${GENRE_GENERATOR_OPTIONS.protagonists[0].label}·${GENRE_GENERATOR_OPTIONS.conflicts[0].label}`);
    return g.name;
  });
  await check('creative-options 持久化 genreMode 与 customGenre', async () => {
    const g = generateCustomGenre({ world: 'ancient', protagonist: 'hidden', conflict: 'conspiracy', tone: '史诗厚重' });
    const put = await fetch(`${base}/api/novels/N-BRAIN/creative-options`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ genreMode: 'generator', customGenre: { genreId: g.genreId, name: g.name, keywords: g.keywords, skillPrompt: g.skillPrompt } }),
    });
    assert.equal(put.status, 200);
    const got = await (await fetch(`${base}/api/novels/N-BRAIN/creative-options`)).json();
    assert.equal(got.genreMode, 'generator');
    assert.equal(got.customGenre.name, g.name);
    assert.ok(got.customGenre.skillPrompt.includes('技能提示词'));
    return `${got.genreMode} / ${got.customGenre.name}`;
  });

  console.log('\n=== 4b. 题材生成历史 ===');
  await check('saveGenreHistory 同 genreId 覆盖更新（不堆重复）', async () => {
    const g = generateCustomGenre({ world: 'modern', protagonist: 'reborn', conflict: 'revenge' });
    const a = saveGenreHistory(g, { source: 'generator' });
    const b = saveGenreHistory({ ...g, name: `${g.name}·改` }, { source: 'generator' });
    assert.equal(a.id, b.id);
    assert.equal(b.name, `${g.name}·改`);
    assert.equal(listGenreHistory().items.filter((x) => x.genreId === g.genreId).length, 1);
    return `id=${b.id}`;
  });
  await check('listGenreHistory 新→旧（按 rowid）', async () => {
    const g1 = generateCustomGenre({ world: 'ancient', protagonist: 'hidden', conflict: 'mystery' });
    const g2 = generateCustomGenre({ world: 'future', protagonist: 'genius', conflict: 'war' });
    saveGenreHistory(g1);
    saveGenreHistory(g2);
    const items = listGenreHistory().items;
    assert.equal(items[0].genreId, g2.genreId);
    return items.slice(0, 2).map((x) => x.name).join(' / ');
  });
  await check('deleteGenreHistory 删除单条', async () => {
    const g = generateCustomGenre({ world: 'virtual', protagonist: 'group', conflict: 'rise' });
    const it = saveGenreHistory(g);
    assert.equal(deleteGenreHistory(it.id).removed, 1);
    assert.equal(listGenreHistory().items.some((x) => x.id === it.id), false);
    return 'deleted';
  });
  await check('题材历史接口：保存/列表/复用/删除', async () => {
    const headers = { 'content-type': 'application/json' };
    const g = generateCustomGenre({ world: 'xianxia', protagonist: 'awaken', conflict: 'horror' });
    const save = await (await fetch(`${base}/api/novels/ai/genre-history`, { method: 'POST', headers, body: JSON.stringify({ genre: g, source: 'generator' }) })).json();
    assert.ok(save.item?.id);
    const list = await (await fetch(`${base}/api/novels/ai/genre-history`)).json();
    assert.ok(list.items.some((x) => x.id === save.item.id));
    const use = await (await fetch(`${base}/api/novels/ai/genre-history/${save.item.id}/use`, { method: 'POST', headers, body: '{}' })).json();
    assert.equal(use.item.usedCount, 1);
    const del = await (await fetch(`${base}/api/novels/ai/genre-history/${save.item.id}`, { method: 'DELETE' })).json();
    assert.equal(del.removed, 1);
    return `${list.items.length} 条`;
  });
  await check('历史记录保存完整填写状态（标题/视角/规模/季数/字数）', async () => {
    const g = generateCustomGenre({ world: 'campus', protagonist: 'female', conflict: 'romance' });
    const it = saveGenreHistory({
      ...g, title: '雨停之后', titleDescription: '校园悬疑', pov: 'first',
      castSize: 18, seasons: 2, targetWords: 200000,
    });
    const back = listGenreHistory().items.find((x) => x.id === it.id);
    assert.equal(back.title, '雨停之后');
    assert.equal(back.titleDescription, '校园悬疑');
    assert.equal(back.pov, 'first');
    assert.equal(back.castSize, 18);
    assert.equal(back.seasons, 2);
    assert.equal(back.targetWords, 200000);
    return `${back.title} / ${back.pov} / cast ${back.castSize}`;
  });
  await check(`pruneGenreHistory 只保留最近 ${GENRE_HISTORY_MAX} 条（按 rowid）`, async () => {
    for (let i = 0; i < 6; i += 1) saveGenreHistory(generateCustomGenre({ world: 'modern', protagonist: 'ordinary', conflict: 'heal', keyword: `k${i}` }));
    const before = listGenreHistory({ limit: 200 }).items.length;
    const r = pruneGenreHistory(3);
    const after = listGenreHistory({ limit: 200 }).items;
    assert.equal(r.kept, 3);
    assert.equal(after.length, 3);
    assert.ok(before >= 3);
    return `before=${before} removed=${r.removed} kept=${after.length}`;
  });

  console.log('\n=== 5. 一键写作后台任务 ===');
  await check('POST /chapters/ai-write-job 写作未写章节并落库', async () => {
    const now = nowISO();
    run(`INSERT INTO novels(id, title, genre, cast_size, target_words, chapter_words, pov, actor_ids, custom_actors, seasons, status, meta, created_at, updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    'N-PIPE', '一键流程测试', targetGenre.id, 20, 9000, 3000, 'third-limited', '[]', '[]', 1, 'draft', '{}', now, now);
    const chapters = [{ idx: 1, title: '第1章 开场' }, { idx: 2, title: '第2章 升级' }, { idx: 3, title: '第3章 反转' }];
    run(`INSERT INTO novel_outlines(id, novel_id, version, status, payload, raw, model, tokens, elapsed_ms, created_at, updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    'O-PIPE', 'N-PIPE', 1, 'ready', JSON.stringify({ chapters: chapters.map((c) => ({ ...c, summary: `${c.title}的剧情走向`, start_state: '开局', end_state: '收束', cliffhanger: '钩子' })) }), '', 'mock', 0, 0, now, now);
    for (const c of chapters) {
      run(`INSERT INTO novel_chapters(id, novel_id, outline_id, idx, title, summary, content, words, status, created_at, updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      `NC-PIPE-${c.idx}`, 'N-PIPE', 'O-PIPE', c.idx, c.title, c.title, '', 0, 'outline', now, now);
    }

    const started = await (await fetch(`${base}/api/novels/N-PIPE/chapters/ai-write-job`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'all' }),
    })).json();
    assert.match(started.jobId, /^JOB-/);
    assert.equal(started.total, 3);
    const { getJob } = await import('../src/jobs.js');
    let job = null;
    for (let i = 0; i < 120; i += 1) {
      job = getJob(started.jobId);
      if (['done', 'error', 'canceled'].includes(job.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(job.status, 'done', job.error || '');
    const done = get("SELECT COUNT(*) AS c FROM novel_chapters WHERE novel_id = 'N-PIPE' AND status = 'done' AND words > 0").c;
    assert.equal(done, 3);
    return `${started.jobId} 完成 ${done} 章`;
  });
  await check('mode=all 二次执行时没有可写章节则报错', async () => {
    const res = await fetch(`${base}/api/novels/N-PIPE/chapters/ai-write-job`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'all' }),
    });
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
