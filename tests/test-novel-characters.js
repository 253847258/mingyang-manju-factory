#!/usr/bin/env node
// Module 2: plot-driven character free mode regression suite.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-characters-test-'));
process.env.FACTORY_DB = path.join(TMP, 'novel-characters.db');
process.env.FACTORY_DATA_DIR = path.join(TMP, 'data');
process.env.FACTORY_CONFIG = path.join(TMP, 'config.json');
fs.mkdirSync(process.env.FACTORY_DATA_DIR, { recursive: true });
fs.writeFileSync(process.env.FACTORY_CONFIG, JSON.stringify({ llm: { provider: 'mock' } }));

const { migrate, get, run } = await import('../src/db.js');
const { nowISO } = await import('../src/util.js');
const { commitCharacters } = await import('../src/novel-ai.js');
const { characterFreeMode, updateCharacterFreeMode, discoverPlotCharacters } = await import('../src/novel-characters.js');
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

const now = nowISO();
run(`INSERT INTO novels(id, title, genre, tone, cast_size, target_words, chapter_words, pov, framework_intro, actor_ids, custom_actors, seasons, status, meta, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
'N-CHAR', '角色自由模式测试', 'urban-revenge', '热血燃向', 6, 12000, 3000, 'third-limited', '主角追查真相',
'[]', '[]', 1, 'draft', '{}', now, now);
run(`INSERT INTO novel_outlines(id, novel_id, version, status, payload, raw, model, tokens, elapsed_ms, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
'O-CHAR', 'N-CHAR', 1, 'ready', JSON.stringify({
  logline: '主角追查真相',
  storyline: { opening_logic: '葬礼重生', ending_logic: '揭穿真相', head_tail_closure: '玉佩闭环' },
  chapters: [{
    idx: 1, title: '葬礼', start_state: '主角醒来', end_state: '主角决定调查',
    summary: '主角在葬礼上重生并发现疑点。', events: ['发现玉佩'], hook: '有人跟踪',
  }],
}), '', 'mock', 0, 0, now, now);

console.log('\n=== 1. 模式设置 ===');
await check('默认开启，读取小说级角色容量', async () => {
  const mode = characterFreeMode('N-CHAR');
  assert.equal(mode.enabled, true);
  assert.equal(mode.maxCharacters, 6);
  assert.equal(mode.availableCharacters, 6);
  return `${mode.currentCharacters}/${mode.castSize}`;
});
await check('开启自由模式并保存数量/风格策略', async () => {
  const mode = updateCharacterFreeMode('N-CHAR', { enabled: true, maxCharacters: 3, stylePolicy: 'guoman-real', autoCreate: true });
  assert.equal(mode.enabled, true);
  assert.equal(mode.maxCharacters, 3);
  assert.equal(mode.stylePolicy, 'guoman-real');
  return JSON.stringify({ enabled: mode.enabled, max: mode.maxCharacters, style: mode.stylePolicy });
});
await check('mock 模式只规划不创建角色卡', async () => {
  const before = get('SELECT COUNT(*) AS c FROM actors').c;
  const r = await discoverPlotCharacters('N-CHAR');
  assert.equal(r.mocked, true);
  assert.equal(r.characters.length, 0);
  assert.equal(get('SELECT COUNT(*) AS c FROM actors').c, before);
  return r.warnings[0];
});

console.log('\n=== 2. 小说专属 ID 归档 ===');
await check('角色卡创建后绑定 actor_ids，并写入 novel 标签', async () => {
  const r = await commitCharacters({
    novelId: 'N-CHAR',
    bindToNovel: true,
    tags: ['角色自由模式'],
    characters: [{
      name: '陈默', role: '主角', gender: '男', age: '28',
      appearance: '清瘦，深眼窝，左手有旧伤', personality: '克制、记仇、行动果断',
      costume: '黑色长外套，银色打火机', background: '被陷害后重生的商人',
      reason: '承担主线复仇与证据链推进', firstAppearance: '第1章葬礼',
      storylineRole: '串联开篇逻辑与结局真相', styleHint: '冷峻写实',
    }],
  });
  assert.equal(r.created.length, 1);
  const actor = get('SELECT * FROM actors WHERE id = ?', r.created[0].actorId);
  assert.match(actor.tags, /novel:N-CHAR/);
  assert.match(actor.tags, /角色自由模式/);
  assert.match(actor.background, /第1章葬礼/);
  const novel = get('SELECT actor_ids FROM novels WHERE id = ?', 'N-CHAR');
  assert.ok(JSON.parse(novel.actor_ids).includes(actor.id));
  return `${actor.id} archived`;
});

console.log('\n=== 3. HTTP 接口 ===');
const { app, handle } = createApp();
registerNovelAiRoutes(app);
const server = createServer((req, res) => handle(req, res, {}));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
await check('GET /characters/free-mode 返回模式和当前容量', async () => {
  const res = await fetch(`${base}/api/novels/N-CHAR/characters/free-mode`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.enabled, true);
  assert.equal(json.currentCharacters, 1);
  return `${json.currentCharacters}/${json.castSize}`;
});
await check('PUT /characters/free-mode 更新数量', async () => {
  const res = await fetch(`${base}/api/novels/N-CHAR/characters/free-mode`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true, maxCharacters: 5, stylePolicy: 'plot-driven' }),
  });
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.mode.maxCharacters, 5);
  return `max=${json.mode.maxCharacters}`;
});
await check('POST /characters/free-mode/plan 在 mock 下给中文说明', async () => {
  const res = await fetch(`${base}/api/novels/N-CHAR/characters/free-mode/plan`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.mocked, true);
  assert.ok(json.warnings.length > 0);
  return json.warnings[0];
});

if (server.closeAllConnections) server.closeAllConnections();
await new Promise((resolve) => server.close(resolve));
console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
process.exitCode = fail ? 1 : 0;
