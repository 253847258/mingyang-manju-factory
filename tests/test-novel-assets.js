#!/usr/bin/env node
// Module 2: novel asset ID registry regression suite.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-assets-test-'));
process.env.FACTORY_DB = path.join(TMP, 'novel-assets.db');
process.env.FACTORY_DATA_DIR = path.join(TMP, 'data');
process.env.FACTORY_CONFIG = path.join(TMP, 'config.json');
fs.mkdirSync(process.env.FACTORY_DATA_DIR, { recursive: true });
fs.writeFileSync(process.env.FACTORY_CONFIG, JSON.stringify({ llm: { provider: 'mock' } }));

const { migrate, run } = await import('../src/db.js');
const { createActor } = await import('../src/modules/actors.js');
const { buildNovelAssets, assetPromptBlock } = await import('../src/novel-assets.js');
const { ensureAdaptSchema } = await import('../src/novel-adapt.js');
const { createApp, createServer } = await import('../src/http.js');
const { registerNovelAiRoutes } = await import('../src/routes/novel-ai.js');
const { nowISO } = await import('../src/util.js');

migrate();
ensureAdaptSchema();
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
const actor = createActor({ name: '林越', gender: 'male', role_type: '主角', style_id: 'cinematic-real' });
run(`INSERT INTO novels(id, title, genre, cast_size, target_words, chapter_words, pov, actor_ids, custom_actors, seasons, status, meta, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
'N-ASSET', '资产测试', 'urban-revenge', 10, 10000, 3000, 'third-limited', JSON.stringify([actor.id]), '[]', 1, 'draft', JSON.stringify({ adaptProjectId: 'ADP-ASSET' }), now, now);
run(`INSERT INTO novel_outlines(id, novel_id, version, status, payload, raw, model, tokens, elapsed_ms, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
'O-ASSET', 'N-ASSET', 1, 'ready', JSON.stringify({
  locations: [{ id: 'L-0001', name: '医院走廊', type: '场景', desc: '雨夜走廊' }],
  characters: [{ id: actor.id, name: '林越', role: '主角' }],
  props: [{ id: 'P-0001', name: '玉佩', type: '信物', desc: '半枚玉佩' }],
}), '', 'mock', 0, 0, now, now);
for (const [id, category, name, subtitle, summary, importance] of [
  ['ADI-A1', 'asset', '医院走廊', '场景资产', 'L-ADP-001 · 画布场景节点', 5],
  ['ADI-A2', 'scene', '医院走廊', '场景', '雨夜走廊', 5],
  ['ADI-A3', 'asset', '合同', '道具资产', 'P-ADP-001 · 画布物品节点', 5],
  ['ADI-A4', 'prop', '合同', '道具', '关键合同', 5],
]) {
  run(`INSERT INTO adapt_items(id, project_id, category, name, subtitle, summary, details, prompt, negative, tags, importance, source_refs, asset_path, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  id, 'ADP-ASSET', category, name, subtitle, summary, '', '', '', '[]', importance, '[]', null, now, now);
}

console.log('\n=== 1. 资产 ID 索引 ===');
let assets;
await check('人物 / 环境 / 物品全部带稳定 ID', async () => {
  assets = buildNovelAssets('N-ASSET');
  assert.deepEqual(assets.summary, { characters: 1, environments: 1, props: 2, total: 4 });
  assert.equal(assets.characters[0].id, actor.id);
  assert.equal(assets.environments[0].id, 'L-0001');
  assert.ok(assets.props.some((x) => x.id === 'P-0001'));
  assert.ok(assets.props.some((x) => x.id === 'P-ADP-001'));
  return JSON.stringify(assets.summary);
});
await check('提示词块包含全部 ID 和最高优先级规则', async () => {
  const block = assetPromptBlock(assets);
  assert.match(block, new RegExp(actor.id));
  assert.match(block, /L-0001/);
  assert.match(block, /P-0001/);
  assert.match(block, /故事大纲 > 正文内容承接 > 头尾逻辑与故事线闭环/);
  return `${block.length} 字`;
});

console.log('\n=== 2. HTTP 接口 ===');
const { app, handle } = createApp();
registerNovelAiRoutes(app);
const server = createServer((req, res) => handle(req, res, {}));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
await check('GET /api/novels/:id/assets 返回三组资产', async () => {
  const res = await fetch(`${base}/api/novels/N-ASSET/assets`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.characters.length, 1);
  assert.equal(json.environments.length, 1);
  assert.equal(json.props.length, 2);
  return `${json.summary.total} 项`;
});

if (server.closeAllConnections) server.closeAllConnections();
await new Promise((resolve) => server.close(resolve));
console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
process.exitCode = fail ? 1 : 0;
