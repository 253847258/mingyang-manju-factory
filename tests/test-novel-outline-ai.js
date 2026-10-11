#!/usr/bin/env node
// Module 2: outline AI planning regression suite.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-outline-ai-test-'));
process.env.FACTORY_DB = path.join(TMP, 'novel-outline-ai.db');
process.env.FACTORY_DATA_DIR = path.join(TMP, 'data');
process.env.FACTORY_CONFIG = path.join(TMP, 'config.json');
fs.mkdirSync(process.env.FACTORY_DATA_DIR, { recursive: true });
fs.writeFileSync(process.env.FACTORY_CONFIG, JSON.stringify({
  llm: { provider: 'mock' },
  image: { backend: 'placeholder' },
  video: { backend: 'placeholder' },
  tts: { backend: 'none' },
}));

const { migrate, all, get, run } = await import('../src/db.js');
const { createActor } = await import('../src/modules/actors.js');
const OAI = await import('../src/novel-outline-ai.js');
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
const actor = createActor({ name: '沈砚', gender: 'male', role_type: '男主', style_id: 'cinematic-real' });
run(`INSERT INTO novels(id, title, genre, tone, cast_size, target_words, chapter_words, pov, framework_intro, actor_ids, custom_actors, seasons, status, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
'N-OAI', '大纲自动规划测试', 'urban-revenge', '热血燃向', 10, 24000, 2000, 'third-limited', '主角复仇',
JSON.stringify([actor.id]), JSON.stringify([{ id: 'CX-0001', name: '赵天豪', role: '反派' }]), 1, 'draft', now, now);

const chapterSkeletons = Array.from({ length: 12 }, (_, i) => ({
  idx: i + 1,
  volume: 1,
  title: `第${i + 1}章`,
  summary: '',
  events: [],
  cliffhanger: '',
  characters: [],
  locations: [],
  pov: '',
  _placeholder: true,
}));
run(`INSERT INTO novel_outlines(id, novel_id, version, status, payload, raw, model, tokens, elapsed_ms, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
'O-OAI', 'N-OAI', 1, 'ready', JSON.stringify({
  logline: '',
  framework: {},
  worldview: {},
  volumes: [],
  chapters: chapterSkeletons,
  timeline: [],
  locations: [],
  characters: [],
  foreshadow: [],
  reversals: [],
  beats: [],
  hooks: [],
  loops: [],
  logic: [],
}), '', 'mock-template', 0, 0, now, now);

console.log('\n=== 1. 状态：14 个分节与可补齐范围 ===');
let status;
await check('状态返回 14 个分节，13 个可 AI 补齐，chapters 单独规划', async () => {
  status = OAI.outlineAiStatus('N-OAI');
  assert.equal(status.hasOutline, true);
  assert.equal(status.sections.length, 14);
  assert.equal(status.missing.length, 14);
  assert.equal(status.fillable.length, 13);
  assert.equal(status.fillable.includes('chapters'), false);
  assert.equal(status.sections.find((x) => x.key === 'chapters')?.empty, true);
  return `missing=${status.missing.length}, fillable=${status.fillable.length}`;
});

console.log('\n=== 2. 逐节补齐与规范化 ===');
let filled;
await check('mock 逐节补齐 13 节，全部非空且明确标记离线', async () => {
  const novel = OAI.novelOf('N-OAI');
  const sections = OAI.loadSections('N-OAI');
  filled = await OAI.fillSections(novel, sections, {});
  assert.equal(filled.requested, 13);
  assert.equal(filled.results.length, 13);
  assert.equal(filled.calls, 0);
  assert.equal(filled.warnings.length, 13);
  assert.equal(OAI.missingSectionKeys(filled.sections).length, 0);
  assert.ok(String(filled.sections.logline).includes('【离线占位】'));
  return `results=${filled.results.length}, warnings=${filled.warnings.length}`;
});
await check('地点 ID 冲突自动编号，伏笔回收章晚于埋设章，强度限制 1..10', async () => {
  const ctx = { existingIds: ['L-0001'], nextLocationSeq: 2, castByName: new Map(), chapterMax: 100 };
  const loc = OAI.normalizeSection('locations', [{ id: 'L-0001', name: '同 ID 地点' }], ctx);
  assert.equal(loc[0].id, 'L-0002');
  const fs = OAI.normalizeSection('foreshadow', [{ content: '钥匙', setup_chapter: 30, payoff_chapter: 10 }], ctx);
  assert.equal(fs[0].payoff_chapter, 31);
  const beats = OAI.normalizeSection('beats', [{ chapter: 3, intensity: 99 }], ctx);
  assert.equal(beats[0].intensity, 10);
  return `${loc[0].id}, payoff=${fs[0].payoff_chapter}, intensity=${beats[0].intensity}`;
});

console.log('\n=== 3. 落库与章节骨架同步 ===');
await check('保存后新增版本，并同步 chapters 骨架行', async () => {
  const saved = OAI.saveOutlineVersion('N-OAI', filled.sections, { source: 'test-fill' });
  assert.equal(saved.version, 2);
  assert.equal(saved.chapters, 12);
  assert.equal(saved.synced.created, 12);
  const versions = all('SELECT version FROM novel_outlines WHERE novel_id = ? ORDER BY version', 'N-OAI').map((x) => x.version);
  assert.deepEqual(versions, [1, 2]);
  assert.equal(get('SELECT COUNT(*) AS c FROM novel_chapters WHERE novel_id = ?', 'N-OAI').c, 12);
  return `v${saved.version}, chapters=${saved.synced.created}`;
});

console.log('\n=== 4. HTTP 接口 ===');
const { app, handle } = createApp();
registerNovelAiRoutes(app);
const server = createServer((req, res) => handle(req, res, {}));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

await check('GET /outline/ai/status 路由参数可用且返回 14 节', async () => {
  const res = await fetch(`${base}/api/novels/N-OAI/outline/ai/status`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.sections.length, 14);
  return `v${json.version}, sections=${json.sections.length}`;
});
await check('POST /outline/ai/section save=true 只覆盖指定节并新增版本', async () => {
  const res = await fetch(`${base}/api/novels/N-OAI/outline/ai/section`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: 'hooks', save: true }),
  });
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.key, 'hooks');
  assert.equal(json.mocked, true);
  assert.equal(json.saved.version, 3);
  const sections = OAI.loadSections('N-OAI');
  assert.ok(Array.isArray(sections.hooks) && sections.hooks.length > 0);
  assert.ok(Array.isArray(sections.locations) && sections.locations.length > 0);
  return `v${json.saved.version}, hooks=${json.value.length}`;
});
await check('POST /outline/ai/fill save=false 不写库', async () => {
  const before = OAI.loadSections('N-OAI');
  const res = await fetch(`${base}/api/novels/N-OAI/outline/ai/fill`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ keys: ['reversals'], save: false, onlyEmpty: false }),
  });
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.requested, 1);
  const after = OAI.loadSections('N-OAI');
  assert.deepEqual(after, before);
  return `requested=${json.requested}, saved=${json.saved}`;
});

if (server.closeAllConnections) server.closeAllConnections();
await new Promise((resolve) => server.close(resolve));
console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
process.exitCode = fail ? 1 : 0;
