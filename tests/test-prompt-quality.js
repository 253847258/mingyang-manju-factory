#!/usr/bin/env node
// 专业级提示词自测：体检 / 修复 / 画风专业尾 / LLM 专业化（mock 回退）

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pq-'));
process.env.FACTORY_DB = path.join(TMP, 'pq.db');
process.env.FACTORY_DATA_DIR = path.join(TMP, 'data');
process.env.FACTORY_CONFIG = path.join(TMP, 'config.json');
fs.mkdirSync(process.env.FACTORY_DATA_DIR, { recursive: true });
fs.writeFileSync(process.env.FACTORY_CONFIG, JSON.stringify({ llm: { provider: 'mock' }, image: { backend: 'placeholder' } }));

const {
  promptDiagnose, promptRepair, professionalizePrompt, PRO_STYLE_TAILS, PRO_NEGATIVES, proStyleTail, proNegative,
} = await import('../src/prompt-quality.js');

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}${extra ? `  ← ${extra}` : ''}`); }
  else { fail += 1; console.error(`  ✗ ${name}  ${extra}`); }
};
async function check(name, fn) {
  try { const extra = await fn(); ok(name, true, extra || ''); }
  catch (err) { ok(name, false, err.message); }
}

console.log('\n=== 1. 体检 promptDiagnose ===');
const dirty = 'night, night, best quality, 人物立绘, 1girl, close-up';
await check('抓到重复 / 中英混排 / 缺焦段 / 缺光影 / 缺负向 / 缺画风尾', async () => {
  const r = promptDiagnose(dirty, { negative: '', styleId: 'cinematic-real' });
  assert.ok(r.duplicates.includes('night'), 'duplicates');
  assert.ok(r.cjk.length >= 1, 'cjk');
  assert.ok(r.issues.some((x) => x.includes('焦段')), 'lens');
  assert.ok(r.issues.some((x) => x.includes('光影')), 'light');
  assert.ok(r.issues.some((x) => x.includes('负面')), 'negative');
  assert.ok(r.issues.some((x) => x.includes('画风专业尾')), 'tail');
  return r.issues.length + ' 条问题';
});
await check('干净的专业提示词体检通过', async () => {
  const clean = [
    'cinematic photorealistic', '1girl, young woman', 'close-up portrait, 85mm lens, f/1.8, shallow depth of field',
    'key light with rim light', 'calm mood', 'best quality, ultra detailed, high resolution',
  ].join(', ');
  const r = promptDiagnose(clean, { negative: 'blurry, bad anatomy', styleId: 'cinematic-real' });
  assert.equal(r.clean, true, JSON.stringify(r.issues));
  return 'clean';
});

console.log('\n=== 2. 修复 promptRepair ===');
await check('去重 / 踢中文 / 补焦段光影质量尾与负向', async () => {
  const r = promptRepair(dirty, { styleId: 'cinematic-real', negative: '' });
  const lower = r.positive.toLowerCase();
  assert.ok(!/[\u4e00-\u9fff]/.test(r.positive), 'no cjk');
  assert.equal(lower.split(',').map((s) => s.trim()).filter((s) => s === 'night').length, 1, 'dedupe');
  assert.match(r.positive, /mm|depth of field/i, 'lens added');
  assert.match(r.positive, /light/i, 'light added');
  assert.match(r.positive, /best quality/i, 'quality tail');
  assert.ok(r.negative.length > 0, 'negative filled');
  const after = promptDiagnose(r.positive, { negative: r.negative, styleId: 'cinematic-real' });
  assert.equal(after.clean, true, JSON.stringify(after.issues));
  return `${r.notes.length} 处修复`;
});
await check('修复幂等：二次修复不再变化', async () => {
  const once = promptRepair(dirty, { styleId: 'jp-anime', negative: '' });
  const twice = promptRepair(once.positive, { styleId: 'jp-anime', negative: once.negative });
  assert.equal(twice.positive, once.positive);
  return 'idempotent';
});

console.log('\n=== 3. 画风专业库 ===');
await check('每个画风都有镜头/光影专业尾与负向库', async () => {
  const ids = ['jp-anime', 'cn-guofeng', 'kr-webtoon', 'us-comic', 'pixar-3d', 'cinematic-real', 'cyberpunk', 'ink-wash', 'retro-cel', 'dark-gothic'];
  for (const id of ids) {
    assert.ok(proStyleTail(id), 'tail ' + id);
    assert.ok(proNegative(id), 'neg ' + id);
  }
  assert.ok(Object.keys(PRO_STYLE_TAILS).length >= 10);
  assert.ok(Object.keys(PRO_NEGATIVES).length >= 10);
  return ids.length + ' 个画风';
});

console.log('\n=== 4. LLM 专业化（mock） ===');
await check('professionalizePrompt 返回正向/负向（llm 或 rule 回退）', async () => {
  const r = await professionalizePrompt({ scope: 'actor', base: '1girl, close-up, 中文残留', negative: '', styleId: 'cinematic-real' });
  assert.equal(r.ok, true);
  assert.ok(r.positive && r.positive.length > 0);
  assert.ok(r.negative && r.negative.length > 0);
  assert.ok(['llm', 'rule'].includes(r.source));
  return `source=${r.source}`;
});

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
process.exitCode = fail ? 1 : 0;
