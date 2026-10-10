#!/usr/bin/env node
// 模块2 · 故事框架 AI 自动填写自测（临时库 + mock LLM + 临时数据目录）
// 用法：node tests/test-novel-ai.js

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-ai-test-'));
process.env.FACTORY_DB = path.join(TMP, 'novel-ai.db');
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
const { generateFrameworkProposal, commitCharacters, readReferenceText } = await import('../src/novel-ai.js');
const { createApp, createServer } = await import('../src/http.js');
const { registerNovelAiRoutes } = await import('../src/routes/novel-ai.js');

migrate();

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}${extra ? `  ← ${extra}` : ''}`);
  } else {
    fail += 1;
    console.error(`  ✗ ${name}  ${extra}`);
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

console.log('\n=== 1. mock 故事框架生成 ===');
let proposal;
await check('mock 返回结构化框架、1 主标题 + 2 备选、0 个角色', async () => {
  proposal = await generateFrameworkProposal({
    title: '', genre: 'classical-xianxia', tone: '热血燃向', pov: 'third-limited',
    castSize: 20, targetWords: 100000, chapterWords: 2000, seasons: 1,
    actorIds: [], customActors: [], refDocPath: '',
  });
  assert.equal(proposal.ok, true);
  assert.equal(proposal.mocked, true);
  assert.ok(String(proposal.title).includes('离线占位'));
  assert.equal(proposal.titleAlternatives.length, 2);
  assert.equal(Object.keys(proposal.framework).length, 9);
  assert.equal(proposal.characters.length, 0);
  return `${proposal.title} / ${proposal.warnings.length} 条提示`;
});

console.log('\n=== 2. 参考范本读取 ===');
await check('参考范本可读取并截断到 12000 字以内', async () => {
  const dir = path.join(process.env.FACTORY_DATA_DIR, 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'ref.txt');
  fs.writeFileSync(file, '参考范本内容'.repeat(5000), 'utf8');
  const warnings = [];
  const textOf = readReferenceText('data/uploads/ref.txt', warnings);
  assert.equal(warnings.length, 0);
  assert.ok(textOf.length <= 12000 && textOf.length > 0);
  return `${textOf.length} 字`;
});

console.log('\n=== 3. 角色卡创建与复用 ===');
await check('已有角色复用，新角色创建 C-xxxx，不产生定妆图', async () => {
  const existing = createActor({ name: '沈砚', gender: 'male', style_id: 'cinematic-real' });
  const result = await commitCharacters({
    characters: [
      { name: '沈砚', role: '主角', gender: '男', age: '28', reason: '已有角色测试复用' },
      { name: '赵天豪', role: '反派', gender: '男', age: '35', appearance: '白色西装', personality: '傲慢', reason: '制造第一轮冲突' },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.created.length, 2);
  const reused = result.created.find((x) => x.name === '沈砚');
  const created = result.created.find((x) => x.name === '赵天豪');
  assert.equal(reused.reused, true);
  assert.equal(reused.actorId, existing.id);
  assert.equal(created.reused, false);
  assert.match(created.actorId, /^C-\d+$/);
  const row = get('SELECT * FROM actors WHERE name = ?', '赵天豪');
  assert.ok(row && row.id === created.actorId);
  assert.equal(get('SELECT COUNT(*) AS c FROM actor_images WHERE actor_id = ?', created.actorId).c, 0);
  return `${reused.actorId} 复用 / ${created.actorId} 新建`;
});

console.log('\n=== 4. 角色上限校验 ===');
await check('超过小说 cast_size 时中文拒绝', async () => {
  const now = new Date().toISOString();
  run(`INSERT INTO novels(id, title, genre, tone, cast_size, target_words, chapter_words, pov, framework_intro, actor_ids, custom_actors, seasons, status, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  'N-AI-CAP', '上限测试', 'classical-xianxia', '热血燃向', 2, 100000, 2000, 'third-limited', '', '[]', '[]', 1, 'draft', now, now);
  await assert.rejects(
    () => commitCharacters({ novelId: 'N-AI-CAP', characters: [{ name: '甲' }, { name: '乙' }, { name: '丙' }] }),
    /超过当前角色规模/,
  );
  return '3 个新角色 > cast_size 2，被拒绝';
});

console.log('\n=== 5. HTTP 接口 ===');
const { app, handle } = createApp();
registerNovelAiRoutes(app);
const server = createServer((req, res) => handle(req, res, {}));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
await check('POST /api/novels/ai/framework 返回 mock 提案', async () => {
  const res = await fetch(`${base}/api/novels/ai/framework`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '接口测试', genre: 'urban-revenge', tone: '爽文快节奏', castSize: 20 }),
  });
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.mocked, true);
  return `status=${res.status} title=${json.title}`;
});
await check('POST /api/novels/ai/commit-characters 创建角色卡', async () => {
  const res = await fetch(`${base}/api/novels/ai/commit-characters`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ characters: [{ name: '接口新角色', role: '配角', gender: '女', reason: '接口测试' }] }),
  });
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.created.length, 1);
  return `${json.created[0].actorId}`;
});
server.close();

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(fail ? 1 : 0);
