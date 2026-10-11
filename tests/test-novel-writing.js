#!/usr/bin/env node
// Module 2: long-form chapter writing regression suite.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-writing-test-'));
process.env.FACTORY_DB = path.join(TMP, 'novel-writing.db');
process.env.FACTORY_DATA_DIR = path.join(TMP, 'data');
process.env.FACTORY_CONFIG = path.join(TMP, 'config.json');
fs.mkdirSync(process.env.FACTORY_DATA_DIR, { recursive: true });
fs.writeFileSync(process.env.FACTORY_CONFIG, JSON.stringify({
  llm: { provider: 'mock' },
  image: { backend: 'placeholder' },
  video: { backend: 'placeholder' },
  tts: { backend: 'none' },
}));

const { migrate, get, run } = await import('../src/db.js');
const { countWords } = await import('../src/modules/novel.js');
const {
  writeLongChapter, chapterWords, buildMockChapterText,
  CHAPTER_WRITE_MIN_WORDS, CHAPTER_WRITE_MAX_WORDS,
} = await import('../src/novel-writing.js');
const { createApp, createServer } = await import('../src/http.js');
const { registerNovelAiRoutes } = await import('../src/routes/novel-ai.js');
const { nowISO } = await import('../src/util.js');

migrate();

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass += 1;
    console.log(`  PASS ${name}${extra ? ` -> ${extra}` : ''}`);
  } else {
    fail += 1;
    console.error(`  FAIL ${name}${extra ? ` -> ${extra}` : ''}`);
  }
};
async function check(name, fn) {
  try {
    const extra = await fn();
    ok(name, true, extra || '');
  } catch (err) {
    ok(name, false, err.message);
  }
}

const now = nowISO();
run(`INSERT INTO novels(id, title, genre, tone, cast_size, target_words, chapter_words, pov, framework_intro, actor_ids, custom_actors, seasons, status, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
'N-LW', '长章写作测试', 'urban-revenge', '热血燃向', 5, 15000, 3000, 'third-limited', '主角追查父亲死亡真相',
'[]', '[]', 1, 'outline_ready', now, now);
run(`INSERT INTO novel_outlines(id, novel_id, version, status, payload, raw, model, tokens, elapsed_ms, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
'O-LW', 'N-LW', 1, 'ready', JSON.stringify({
  logline: '主角追查真相',
  chapters: [
    { idx: 1, volume: 1, title: '雨夜归来', summary: '主角回到旧城，在雨夜发现父亲留下的钥匙。', events: ['回到旧城', '发现钥匙'], hook: '钥匙上刻着陌生地址', cliffhanger: '门外有人跟踪' },
    { idx: 2, volume: 1, title: '旧宅线索', summary: '主角进入旧宅寻找线索。', events: ['进入旧宅'], hook: '墙后有暗格', cliffhanger: '暗格里没有文件' },
  ],
}), '', 'mock-template', 0, 0, now, now);
for (const idx of [1, 2]) {
  run(`INSERT INTO novel_chapters(id, novel_id, outline_id, idx, volume, title, summary, content, words, hook, cliffhanger, characters, locations, status, model, tokens, error, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  `CH-LW-${idx}`, 'N-LW', 'O-LW', idx, 1, `第${idx}章`, '', '', 0, '', '', '[]', '[]', 'outline', null, 0, null, now, now);
}

console.log('\n=== 1. 长章正文生成 ===');
let written;
await check('mock 单章正文落在 2500-3500 字范围并落库', async () => {
  written = await writeLongChapter('N-LW', 1, { save: true });
  assert.equal(written.ok, true);
  assert.equal(written.mocked, true);
  assert.ok(written.words >= CHAPTER_WRITE_MIN_WORDS && written.words <= CHAPTER_WRITE_MAX_WORDS, `words=${written.words}`);
  assert.equal(written.words, chapterWords(written.content));
  assert.equal(countWords(written.content), written.words);
  const row = get('SELECT status, words, content, model FROM novel_chapters WHERE novel_id = ? AND idx = 1', 'N-LW');
  assert.equal(row.status, 'done');
  assert.equal(row.words, written.words);
  assert.equal(row.content, written.content);
  assert.equal(row.model, 'mock-long-chapter');
  return `${written.words} 字`;
});
await check('save=false 只返回预览，不修改章节', async () => {
  const before = get('SELECT content, words, status FROM novel_chapters WHERE novel_id = ? AND idx = 2', 'N-LW');
  const preview = await writeLongChapter('N-LW', 2, { save: false });
  const after = get('SELECT content, words, status FROM novel_chapters WHERE novel_id = ? AND idx = 2', 'N-LW');
  assert.ok(preview.words >= CHAPTER_WRITE_MIN_WORDS && preview.words <= CHAPTER_WRITE_MAX_WORDS);
  assert.deepEqual(after, before);
  assert.match(preview.content, /旧宅线索|离线占位/);
  return `预览 ${preview.words} 字，库中仍为 ${after.words} 字`;
});
await check('mock 内容包含本章大纲信息，不是空模板', async () => {
  const ctx = { plan: { title: '雨夜归来', summary: '主角发现钥匙', events: ['发现钥匙'], cliffhanger: '有人跟踪' }, cast: [], locations: [], foreshadow: [], previous: [], next: null, sections: {} };
  const text = buildMockChapterText({ title: '测试' }, 1, ctx);
  assert.ok(chapterWords(text) >= CHAPTER_WRITE_MIN_WORDS);
  assert.match(text, /雨夜归来|主角发现钥匙|离线占位/);
  return `${chapterWords(text)} 字`;
});

console.log('\n=== 2. HTTP 接口 ===');
const { app, handle } = createApp();
registerNovelAiRoutes(app);
const server = createServer((req, res) => handle(req, res, {}));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
await check('POST /chapters/:idx/ai-write 返回长章节并支持 save=false', async () => {
  const res = await fetch(`${base}/api/novels/N-LW/chapters/2/ai-write`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ save: false }),
  });
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.saved, false);
  assert.ok(json.words >= CHAPTER_WRITE_MIN_WORDS && json.words <= CHAPTER_WRITE_MAX_WORDS);
  return `${json.words} 字`;
});
await check('非法章节号返回 400', async () => {
  const res = await fetch(`${base}/api/novels/N-LW/chapters/abc/ai-write`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  const json = await res.json();
  assert.equal(res.status, 400);
  assert.match(json.error, /章节序号/);
  return json.error;
});

if (server.closeAllConnections) server.closeAllConnections();
await new Promise((resolve) => server.close(resolve));
console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
process.exitCode = fail ? 1 : 0;
