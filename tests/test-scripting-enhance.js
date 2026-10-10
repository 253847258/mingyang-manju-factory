#!/usr/bin/env node
// 剧本工厂增强自测：schema / 快照 / 锁定 / 引用修复 / 提示词修复 / 预估 / 改编物化 / FDX+HTML

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'script-enhance-'));
process.env.FACTORY_DB = path.join(TMP, 'enhance.db');
process.env.FACTORY_DATA_DIR = path.join(TMP, 'data');
process.env.FACTORY_CONFIG = path.join(TMP, 'config.json');
fs.mkdirSync(process.env.FACTORY_DATA_DIR, { recursive: true });
fs.writeFileSync(process.env.FACTORY_CONFIG, JSON.stringify({
  llm: { provider: 'mock' },
  image: { backend: 'placeholder' },
  video: { backend: 'placeholder' },
  tts: { backend: 'none' },
  budget: { enabled: false, currency: 'CNY', imageUnit: 1, videoUnit: 1, ttsPerKChars: 0.1, productionCap: 0, monthlyCap: 0, confirmOver: 0 },
}));

const { migrate, all, get, run } = await import('../src/db.js');
const { createActor } = await import('../src/modules/actors.js');
const {
  ensureScriptingSchema, snapshotEpisode, restoreSnapshot, setShotLocked,
  updateShotPerformance, estimateEpisode,
} = await import('../src/scripting-schema.js');
const { refIntegrity, refRepair, promptAudit, promptRepair } = await import('../src/script-integrity.js');
const { adaptToProduction } = await import('../src/production-bridge.js');
const { ensureAdaptSchema } = await import('../src/novel-adapt.js');
const { createApp, createServer } = await import('../src/http.js');
const { registerScriptingRoutes } = await import('../src/routes/scripting.js');
const {
  ensureReviewSchema, setEpisodeReview, setShotReview, batchSetShotReview, reviewOverview, reviewGate,
} = await import('../src/script-review.js');
const { getBudget, setBudget, budgetCheck } = await import('../src/script-budget.js');
const { syncEpisodePerformances, resolveShotPerformance, speedForEmotion } = await import('../src/dub-bridge.js');

migrate();
ensureScriptingSchema();
ensureAdaptSchema();

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

const now = new Date().toISOString();
const shen = createActor({ name: '沈砚', gender: 'male', role_type: '男主', style_id: 'cinematic-real' });
createActor({ name: '林知夏', gender: 'female', role_type: '女主', style_id: 'jp-anime' });

run(`INSERT INTO novels(id, title, genre, tone, cast_size, target_words, chapter_words, pov, framework_intro, actor_ids, custom_actors, seasons, status, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
'N-T', '增强测试', 'urban-revenge', '热血燃向', 20, 100000, 2000, 'third-limited', '', '[]', '[]', 1, 'outline_ready', now, now);
run(`INSERT INTO scripts(id, novel_id, title, format, style_id, episode_seconds, episodes_per_season, seasons, options, plan, status, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
'SC-T', 'N-T', '增强测试剧本', 'manju', 'cinematic-real', 60, 1, 1,
JSON.stringify({ canvasBinding: { actors: [{ actorId: 'C-9999', name: '沈砚' }] } }),
JSON.stringify({ cast: [{ id: 'C-9999', name: '沈砚' }] }), 'draft', now, now);
run(`INSERT INTO script_episodes(id, script_id, season, episode, code, title, logline, hook, cliffhanger, duration, source_chapters, scenes, status, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
'EP-T', 'SC-T', 1, 1, 'S01E001', '第一集', '', '钩子', '钩子', 60, '[1]', JSON.stringify({ mode: 'test', scenes: [] }), 'planned', now, now);
const badRefs = JSON.stringify({ characters: ['C-9999'], location: 'L-9999' });
const badPrompt = 'night, mist fog, night, wine cup, daytime, 1boy, static camera';
run(`INSERT INTO shots(id, script_id, episode_id, idx, scene_no, time_of_day, shot_size, camera, move, transition, duration, action, dialogue, mood, prompt_pos, prompt_neg, refs, cost_level, status, created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
'SH-T-1', 'SC-T', 'EP-T', 1, '1', '夜晚', '中景', '平视', '固定', '硬切', 3,
'C-0002 沈砚站在码头，手里握着怀表。', '', '紧张', badPrompt, '', badRefs, 'M', 'draft', now);
run(`INSERT INTO shots(id, script_id, episode_id, idx, scene_no, time_of_day, shot_size, camera, move, transition, duration, action, dialogue, mood, prompt_pos, prompt_neg, refs, cost_level, status, created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
'SH-T-2', 'SC-T', 'EP-T', 2, '1', '夜晚', '近景', '平视', '固定', '硬切', 3,
'锁定镜头不应被改动', '', '平静', badPrompt, '', badRefs, 'L', 'draft', now);
setShotLocked('SC-T', 'SH-T-2', true);

console.log('\n=== 1. Schema / 快照 / 锁定 ===');
await check('schema 增加锁定和声音字段、script_snapshots 表', async () => {
  const cols = new Set(all('PRAGMA table_info(shots)').map((r) => r.name));
  assert.ok(cols.has('locked') && cols.has('speaker') && cols.has('emotion') && cols.has('voice_id'));
  assert.ok(get("SELECT name FROM sqlite_master WHERE type='table' AND name='script_snapshots'"));
  return 'locked/speaker/emotion/voice_id + script_snapshots';
});
await check('快照可保存、可回滚，且保留锁定镜头', async () => {
  const snap = snapshotEpisode('SC-T', 'S01E001', { kind: 'storyboard', note: '测试快照' });
  assert.equal(snap.version, 1);
  run('UPDATE shots SET action = ? WHERE id = ?', '被改坏的内容', 'SH-T-1');
  const restored = restoreSnapshot(snap.id, { keepLocked: true });
  assert.ok(restored.restoredShots >= 1);
  assert.match(get('SELECT action FROM shots WHERE id = ?', 'SH-T-1').action, /沈砚站在码头/);
  assert.equal(get('SELECT locked FROM shots WHERE id = ?', 'SH-T-2').locked, 1);
  return `v${snap.version} / 恢复 ${restored.restoredShots} 镜`;
});
await check('声音元数据可保存', async () => {
  const r = await updateShotPerformance('SC-T', 'SH-T-1', { speaker: '沈砚', emotion: '紧张', voiceId: 'voice-shen' });
  assert.equal(r.shot.speaker, '沈砚');
  assert.equal(r.shot.emotion, '紧张');
  assert.equal(r.shot.voice_id, 'voice-shen');
  return 'speaker/emotion/voice_id 已落库';
});

console.log('\n=== 2. 引用体检与修复 ===');
await check('引用体检发现失效 C-9999、plan 和画布引用', async () => {
  const r = refIntegrity('SC-T');
  assert.ok(r.summary.invalidRefs >= 1);
  assert.ok(r.summary.planIssues >= 1);
  assert.ok(r.summary.canvasIssues >= 1);
  return JSON.stringify(r.summary);
});
await check('引用修复按名字重映射，锁定镜头跳过', async () => {
  const r = refRepair('SC-T');
  assert.ok(r.repairedShots >= 1);
  const shot = get('SELECT * FROM shots WHERE id = ?', 'SH-T-1');
  const refs = JSON.parse(shot.refs);
  assert.ok(refs.characters.includes(shen.id));
  const locked = get('SELECT * FROM shots WHERE id = ?', 'SH-T-2');
  const lockedRefs = JSON.parse(locked.refs);
  assert.ok(lockedRefs.characters.includes('C-9999'));
  assert.equal(r.skippedLocked, 1);
  return `修复 ${r.repairedShots} 镜 / 跳过锁定 ${r.skippedLocked} / 角色 ${shen.id}`;
});

console.log('\n=== 3. 提示词体检与修复 ===');
await check('提示词体检抓到重复、时间矛盾、无关道具', async () => {
  const r = promptAudit('SC-T', 'S01E001');
  assert.ok(r.summary.duplicateTokens >= 1);
  assert.ok(r.summary.timeConflicts >= 1);
  assert.ok(r.summary.irrelevantProps >= 1);
  return JSON.stringify(r.summary);
});
await check('提示词修复去重、解决时间矛盾、去掉无关道具，锁定镜头跳过', async () => {
  const r = promptRepair('SC-T', 'S01E001');
  assert.ok(r.repairedShots >= 1);
  const shot = get('SELECT * FROM shots WHERE id = ?', 'SH-T-1');
  const tokens = shot.prompt_pos.split(',').map((x) => x.trim().toLowerCase());
  assert.ok(!tokens.includes('daytime'));
  assert.ok(!tokens.includes('wine cup'));
  assert.equal(tokens.filter((x) => x === 'night').length, 1);
  const locked = get('SELECT * FROM shots WHERE id = ?', 'SH-T-2');
  assert.match(locked.prompt_pos, /daytime/);
  return `修复 ${r.repairedShots} 镜 / 跳过锁定 ${r.skippedLocked}`;
});
await check('成本预估返回镜头、关键帧、视频和 LLM 调用数', async () => {
  const r = estimateEpisode('SC-T', 'S01E001');
  assert.equal(r.shots, 2);
  assert.ok(r.estimatedLlmCalls >= 3);
  assert.ok(r.keyframes >= 1);
  return JSON.stringify({ shots: r.shots, keyframes: r.keyframes, videos: r.videos, llm: r.estimatedLlmCalls });
});

console.log('\n=== 4. 改编项目 → 生产小说/剧本 ===');
run(`INSERT INTO adapt_projects(id, title, source_name, source_path, char_count, chapter_count, status, summary, warnings, error, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
'ADP-T', '改编物化测试', 'test.txt', 'data/uploads/test.txt', 400, 2, 'done', '{}', '[]', null, now, now);
run('INSERT INTO adapt_sources(project_id, text, chapters, created_at) VALUES(?,?,?,?)',
'ADP-T', '第1章 雨夜\n林越站在码头。\n第2章 办公室\n赵天豪拿出合同。', '[]', now);
run(`INSERT INTO adapt_items(id, project_id, category, name, subtitle, summary, details, prompt, negative, tags, importance, source_refs, asset_path, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
'ADI-C', 'ADP-T', 'character', '赵天豪', '反派', '傲慢富少', JSON.stringify({ role: 'antagonist', gender: 'male' }), '', '', '[]', 10, '[]', null, now, now);
run(`INSERT INTO adapt_items(id, project_id, category, name, subtitle, summary, details, prompt, negative, tags, importance, source_refs, asset_path, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
'ADI-S', 'ADP-T', 'scene', '码头', '场景', '雨夜码头', '{}', '', '', '[]', 8, '[]', null, now, now);
run(`INSERT INTO adapt_items(id, project_id, category, name, subtitle, summary, details, prompt, negative, tags, importance, source_refs, asset_path, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
'ADI-P', 'ADP-T', 'prop', '合同', '道具', '关键合同', '{}', '', '', '[]', 6, '[]', null, now, now);
run(`INSERT INTO adapt_items(id, project_id, category, name, subtitle, summary, details, prompt, negative, tags, importance, source_refs, asset_path, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
'ADI-SC', 'ADP-T', 'script', '剧本转换结果', '1集', '测试', JSON.stringify({ episodes: [{ episode: 'S01E001', title: '雨夜', hook: '钩子', totalDuration: 60, beats: [{ location: '码头', time: '夜晚', characters: ['赵天豪'], action: '赵天豪站在码头', dialogue: '你来了。', duration: 4 }] }] }), '', '', '[]', 100, '[]', null, now, now);
await check('物化生成 novel/chapters/outline/script/episodes', async () => {
  const r = await adaptToProduction('ADP-T', { sync: false });
  assert.equal(r.ok, true);
  assert.ok(r.novelId && r.scriptId);
  assert.ok(get('SELECT * FROM novels WHERE id = ?', r.novelId));
  assert.ok(all('SELECT * FROM novel_chapters WHERE novel_id = ?', r.novelId).length >= 2);
  assert.ok(get('SELECT * FROM novel_outlines WHERE novel_id = ?', r.novelId));
  assert.ok(all('SELECT * FROM script_episodes WHERE script_id = ?', r.scriptId).length === 1);
  return `${r.novelId} / ${r.scriptId} / ${r.episodeCount} 集`;
});
await check('重复调用幂等复用', async () => {
  const r = await adaptToProduction('ADP-T', { sync: false });
  assert.equal(r.reused, true);
  return `${r.novelId} / ${r.scriptId}`;
});

console.log('\n=== 5. HTTP 路由 ===');
const { app, handle } = createApp();
registerScriptingRoutes(app);
const server = createServer((req, res) => handle(req, res, {}));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
await check('ref-integrity / prompt-audit / estimate 返回 200', async () => {
  for (const url of ['/api/scripts/SC-T/ref-integrity', '/api/scripts/SC-T/prompt-audit?episode=S01E001', '/api/scripts/SC-T/estimate?episode=S01E001']) {
    const res = await fetch(base + url);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
  }
  return '3 个接口 200';
});
await check('FDX / 打印 HTML 导出正常', async () => {
  const fdx = await (await fetch(base + '/api/scripts/SC-T/export-ext?format=fdx')).text();
  const html = await (await fetch(base + '/api/scripts/SC-T/export-ext?format=html')).text();
  assert.ok(fdx.startsWith('<?xml') && fdx.includes('FinalDraft'));
  assert.ok(html.includes('<!doctype html>') && html.includes('打印此页'));
  return `FDX ${fdx.length} 字节 / HTML ${html.length} 字节`;
});
if (server.closeAllConnections) server.closeAllConnections();
await new Promise((resolve) => server.close(resolve));

console.log('\n=== 6. 审核流程 / 预算 / 配音表演 / 剪辑导出 ===');
await check('审核 schema 落库，单集与单镜状态可流转', async () => {
  const cols = new Set(all('PRAGMA table_info(script_episodes)').map((r) => r.name));
  const shotCols = new Set(all('PRAGMA table_info(shots)').map((r) => r.name));
  assert.ok(cols.has('review_status') && cols.has('reviewer') && cols.has('review_note'));
  assert.ok(shotCols.has('review_status'));
  const ep = setEpisodeReview('SC-T', 'S01E001', { status: 'review', reviewer: '张三', note: '台词再收一点' });
  assert.equal(ep.status, 'review');
  const shot = setShotReview('SC-T', 'SH-T-1', { status: 'approved', reviewer: '张三' });
  assert.equal(shot.status, 'approved');
  return `ep=${ep.status} shot=${shot.status}`;
});
await check('批量审核镜头跳过锁定镜头', async () => {
  const r = batchSetShotReview('SC-T', 'S01E001', { status: 'approved', reviewer: '张三', onlyDraft: false });
  assert.ok(r.changed >= 1);
  assert.equal(r.skippedLocked, 1);   // SH-T-2 是锁定镜头
  assert.notEqual(get('SELECT review_status FROM shots WHERE id = ?', 'SH-T-2').review_status, 'approved');
  return `改动 ${r.changed} / 跳过锁定 ${r.skippedLocked}`;
});
await check('审核汇总与制作台 gate 只告警不硬阻断', async () => {
  setEpisodeReview('SC-T', 'S01E001', { status: 'approved', reviewer: '张三' });
  const ov = reviewOverview('SC-T');
  assert.equal(ov.summary.episodes, 1);
  assert.equal(ov.summary.approved, 1);
  const gate = reviewGate('SC-T', ['S01E001']);
  assert.equal(gate.ok, true);
  assert.equal(gate.pending.length, 0);
  setEpisodeReview('SC-T', 'S01E001', { status: 'draft' });
  const gate2 = reviewGate('SC-T', ['S01E001']);
  assert.ok(gate2.pending.length === 1);
  assert.match(gate2.warning, /尚未审核通过/);
  return `pending=${gate2.pending.length}`;
});
await check('项目预算可读写，硬上限超额拒绝', async () => {
  setBudget('SC-T', { enabled: true, limit: 999999, hard: true, currency: 'CNY' });
  const b = getBudget('SC-T');
  assert.equal(b.enabled, true);
  const okRes = budgetCheck('SC-T', { codes: ['S01E001'], stages: ['keyframe', 'video'], confirm: true });
  assert.equal(okRes.blocked, false);
  setBudget('SC-T', { limit: 0.0001, hard: true });
  const blocked = budgetCheck('SC-T', { codes: ['S01E001'], stages: ['keyframe', 'video'], confirm: true });
  assert.equal(blocked.blocked, true);
  assert.match(blocked.reason, /硬上限|超过项目上限/);
  setBudget('SC-T', { limit: 0.0001, hard: false });
  const need = budgetCheck('SC-T', { codes: ['S01E001'], stages: ['keyframe', 'video'], confirm: false });
  assert.equal(need.needConfirm, true);
  return `amount=${blocked.amount}`;
});
await check('配音表演同步补全说话人并同步出场角色', async () => {
  run('UPDATE shots SET refs = ? WHERE id = ?', JSON.stringify({ characters: [] }), 'SH-T-1');
  run('UPDATE shots SET dialogue = ?, speaker = ? WHERE id = ?', '沈砚：你终于来了。', '', 'SH-T-1');
  const r = syncEpisodePerformances('SC-T', 'S01E001');
  assert.ok(r.updated >= 1);
  const shot = get('SELECT * FROM shots WHERE id = ?', 'SH-T-1');
  assert.equal(shot.speaker, '沈砚');
  assert.ok(JSON.parse(shot.refs).characters.includes(shen.id));
  const perf = resolveShotPerformance(shot, { byId: new Map([[shen.id, shen]]), byName: new Map([['沈砚', shen]]) });
  assert.equal(perf.speakerId, shen.id);
  assert.ok(speedForEmotion('紧张') > 1);
  return `speaker=${shot.speaker} / speakerId=${perf.speakerId}`;
});
await check('空镜/环境镜不再误报「角色引用为空」', async () => {
  run(`INSERT INTO shots(id, script_id, episode_id, idx, scene_no, time_of_day, shot_size, camera, move, transition, duration, action, dialogue, mood, prompt_pos, prompt_neg, refs, cost_level, status, created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  'SH-T-3', 'SC-T', 'EP-T', 3, '1', '夜晚', '中景', '平视', '固定', '硬切', 3,
  '空荡的码头，雾气弥漫。', '', '平静', 'night, empty dock, mist', 'people, character', JSON.stringify({ characters: [] }), 'L', 'draft', new Date().toISOString());
  const r = promptAudit('SC-T', 'S01E001');
  const row = (r.shots || []).find((x) => x.shotId === 'SH-T-3');
  assert.ok(!row || !row.issues.includes('角色引用为空'));
  return `emptyCharacterRefs=${r.summary.emptyCharacterRefs}`;
});
await check('OTIO / EDL / FCPXML 导出结构合法', async () => {
  const { app: app2, handle: handle2 } = createApp();
  registerScriptingRoutes(app2);
  const srv = createServer((req, res) => handle2(req, res, {}));
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const base2 = `http://127.0.0.1:${srv.address().port}`;
  const otio = await (await fetch(`${base2}/api/scripts/SC-T/export-ext?format=otio`)).json();
  const edl = await (await fetch(`${base2}/api/scripts/SC-T/export-ext?format=edl`)).text();
  const fcpxml = await (await fetch(`${base2}/api/scripts/SC-T/export-ext?format=fcpxml`)).text();
  assert.equal(otio.OTIO_SCHEMA, 'Timeline.1');
  assert.ok(Array.isArray(otio.tracks.children[0].children) && otio.tracks.children[0].children.length >= 1);
  assert.match(edl, /FCM: NON-DROP FRAME/);
  assert.ok(fcpxml.startsWith('<?xml') && fcpxml.includes('<fcpxml'));
  if (srv.closeAllConnections) srv.closeAllConnections();
  await new Promise((resolve) => srv.close(resolve));
  return `OTIO ${otio.tracks.children[0].children.length} 剪辑 / EDL ${edl.length} 字节 / FCPXML ${fcpxml.length} 字节`;
});
await check('审核 / 预算 / 表演同步 HTTP 路由可用', async () => {
  const { app: app3, handle: handle3 } = createApp();
  registerScriptingRoutes(app3);
  const srv = createServer((req, res) => handle3(req, res, {}));
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const base3 = `http://127.0.0.1:${srv.address().port}`;
  const review = await (await fetch(`${base3}/api/scripts/SC-T/review`)).json();
  const gate = await (await fetch(`${base3}/api/scripts/SC-T/review-gate?episode=S01E001`)).json();
  const budget = await (await fetch(`${base3}/api/scripts/SC-T/budget`)).json();
  const setEp = await (await fetch(`${base3}/api/scripts/SC-T/episodes/S01E001/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'approved', reviewer: '接口' }) })).json();
  const sync = await (await fetch(`${base3}/api/scripts/SC-T/performance/sync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ episode: 'S01E001' }) })).json();
  assert.equal(review.ok, true);
  assert.equal(gate.ok, true);
  assert.equal(budget.ok, true);
  assert.equal(setEp.status, 'approved');
  assert.equal(sync.ok, true);
  if (srv.closeAllConnections) srv.closeAllConnections();
  await new Promise((resolve) => srv.close(resolve));
  return 'review/gate/budget/review-post/performance-sync 全部 200';
});

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
process.exitCode = fail ? 1 : 0;
