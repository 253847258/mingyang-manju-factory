#!/usr/bin/env node
// 跨模块 E2E 就绪测试：审核 → 资产快照/血缘 → 首尾帧 → 成片 → 审片 → 订单 → 成本。
// 全离线、临时库、临时数据目录，不调用外部模型。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'full-flow-'));
process.env.FACTORY_DB = path.join(TMP, 'flow.db');
process.env.FACTORY_DATA_DIR = path.join(TMP, 'data');
process.env.FACTORY_CONFIG = path.join(TMP, 'config.json');
fs.mkdirSync(path.join(process.env.FACTORY_DATA_DIR, 'images', 'flow'), { recursive: true });
fs.writeFileSync(process.env.FACTORY_CONFIG, JSON.stringify({
  llm: { provider: 'mock' }, image: { backend: 'placeholder' },
  video: { backend: 'placeholder' }, tts: { backend: 'none' }, edit: { enabled: true },
}));

const { migrate, run, get, ROOT } = await import('../src/db.js');
const { createActor } = await import('../src/modules/actors.js');
const { createAsset } = await import('../src/assets.js');
const { freezeSnapshot, compareSnapshot } = await import('../src/asset-snapshot.js');
const { recordLineage } = await import('../src/lineage.js');
const { recordCost, sumCost } = await import('../src/cost-ledger.js');
const { createOrder, upsertEpisode, orderSummary } = await import('../src/production-order.js');
const { ensureReviewSchema, setEpisodeReview, batchSetShotReview, reviewOverview } = await import('../src/script-review.js');
const { upsertAnchor, approveAnchor, anchorStatus } = await import('../src/anchor.js');
const { setShotTailImage, getEpisodeBoard } = await import('../src/modules/render.js');
const { ensureEditSchema, createTimelineFromShots, setReviewStatus, listFilms } = await import('../src/edit-timeline.js');
const { renderTimeline } = await import('../src/edit-render.js');
const { renderPlaceholderPng } = await import('../src/pngd.js');

migrate();
ensureReviewSchema();
ensureEditSchema();
const now = new Date().toISOString();
const scriptId = 'SC-FLOW-E2E';
const episodeId = 'EP-FLOW-E2E';
const code = 'S01E001';
const projectId = 'P-FLOW-E2E';

let pass = 0, fail = 0;
function check(name, fn) {
  try {
    const detail = fn();
    pass += 1;
    console.log(`  PASS ${name}${detail ? ` -> ${detail}` : ''}`);
  } catch (e) {
    fail += 1;
    console.error(`  FAIL ${name} -> ${e.message}`);
  }
}
async function checkAsync(name, fn) {
  try {
    const detail = await fn();
    pass += 1;
    console.log(`  PASS ${name}${detail ? ` -> ${detail}` : ''}`);
  } catch (e) {
    fail += 1;
    console.error(`  FAIL ${name} -> ${e.message}`);
  }
}

const actor = createActor({ name: '流程主演', gender: 'male', role_type: '男主', style_id: 'cinematic-real' });
const role = createAsset({ type: 'role', name: '流程主演', projectId, description: '冷峻、黑色风衣' });
const scene = createAsset({ type: 'scene', name: '测试码头', projectId, description: '雨夜旧码头，霓虹反光' });
const prop = createAsset({ type: 'prop', name: '旧怀表', projectId, description: '银色怀表，停在十点四十' });

run(`INSERT INTO scripts(id, novel_id, title, format, style_id, episode_seconds, episodes_per_season, seasons, status, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`, scriptId, 'N-FLOW-E2E', '全流程验收片', 'manju', 'cinematic-real', 3, 1, 1, 'draft', now, now);
run(`INSERT INTO script_episodes(id, script_id, season, episode, code, title, duration, status, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?)`, episodeId, scriptId, 1, 1, code, '雨夜码头', 3, 'planned', now, now);

const shotIds = [];
for (let i = 1; i <= 3; i += 1) {
  const id = `SH-FLOW-${i}`;
  shotIds.push(id);
  run(`INSERT INTO shots(id, script_id, episode_id, idx, scene_no, shot_size, camera, move, transition, duration, action, dialogue, mood, prompt_pos, prompt_neg, refs, cost_level, status, created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, scriptId, episodeId, i, '1', i === 1 ? '中景' : '近景', '平视', '推镜', '切', 1,
    i === 1 ? '主角走入雨夜码头' : i === 2 ? '主角发现旧怀表' : '主角抬头看向远处',
    i === 2 ? '表为什么停了？' : '', '紧张', 'cinematic close shot, rainy dock', 'cartoon, blurry', JSON.stringify({ characters: [actor.id] }), 'M', 'draft', now);
}

console.log('\n=== 1. 剧本审核与前三镜锚定 ===');
check('单集与三镜可流转到 approved', () => {
  setEpisodeReview(scriptId, code, { status: 'review', reviewer: '流程测试' });
  setEpisodeReview(scriptId, code, { status: 'approved', reviewer: '流程测试', note: 'E2E 审核通过' });
  batchSetShotReview(scriptId, code, { status: 'approved', reviewer: '流程测试' });
  const ov = reviewOverview(scriptId);
  assert.equal(ov.summary.approved, 1);
  assert.ok(ov.episodes[0].shotCounts.approved === 3);
  return `${ov.episodes[0].status}/${ov.episodes[0].shotCounts.approved} 镜`;
});
check('前三镜锚定可确认', () => {
  upsertAnchor({ scriptId, code, episodeId, shotIds, model: 'placeholder', seed: '42', style: 'cinematic-real', operator: '流程测试' });
  approveAnchor(scriptId, code, '流程测试');
  const a = anchorStatus(scriptId, code);
  assert.equal(a.approved, true);
  return a.status || 'approved';
});

console.log('\n=== 2. 资产快照 / 血缘 / 尾帧 ===');
check('冻结集级资产快照并校验无漂移', () => {
  const snap = freezeSnapshot({ scriptId, code, episodeId, note: 'E2E 开拍基线', assets: [role.id, scene.id, prop.id] });
  assert.equal(snap.asset_versions.length, 3);
  const cmp = compareSnapshot(scriptId, code);
  assert.equal(cmp.drifted, false);
  return snap.id;
});
check('生成血缘可追溯', () => {
  const row = recordLineage({ takeId: 'TAKE-FLOW-1', model: 'placeholder', modelVersion: '1', seed: '42', prompt: '雨夜码头主角中景', refHash: 'flow-ref', params: { duration: 1 } });
  assert.equal(row.take_id, 'TAKE-FLOW-1');
  return row.id;
});
check('尾帧写入镜头并可回读', () => {
  const rel = path.join('data', 'images', 'flow', 'tail.png');
  const abs = path.join(process.env.FACTORY_DATA_DIR, 'images', 'flow', 'tail.png');
  fs.writeFileSync(abs, renderPlaceholderPng({ width: 320, height: 180, label: 'TAIL', actorId: actor.id, kind: 'tail' }));
  setShotTailImage(shotIds[1], abs);
  const shot = getEpisodeBoard(scriptId, code).shots.find((x) => x.id === shotIds[1]);
  assert.equal(shot.tail_image, abs);
  assert.equal(shot.tail_image_missing, false);
  return shotIds[1];
});

console.log('\n=== 3. 关键帧 / 视频 / 成片 ===');
for (let i = 0; i < shotIds.length; i += 1) {
  const id = shotIds[i];
  const keyAbs = path.join(process.env.FACTORY_DATA_DIR, 'images', 'flow', `kf-${i + 1}.png`);
  const videoAbs = path.join(process.env.FACTORY_DATA_DIR, 'videos', 'flow', `clip-${i + 1}.mp4`);
  fs.mkdirSync(path.dirname(videoAbs), { recursive: true });
  fs.writeFileSync(keyAbs, renderPlaceholderPng({ width: 320, height: 180, label: `KF${i + 1}`, actorId: actor.id, kind: 'keyframe' }));
  const ff = spawnSync('ffmpeg', ['-y', '-v', 'error', '-loop', '1', '-i', keyAbs, '-t', '1', '-r', '24', '-pix_fmt', 'yuv420p', '-vf', 'scale=320:180', videoAbs], { encoding: 'utf8' });
  assert.equal(ff.status, 0, ff.stderr);
  run(`INSERT INTO shot_renders(id, script_id, episode_id, shot_id, kind, file_path, mime, width, height, backend, status, created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, `RD-FLOW-KF-${i + 1}`, scriptId, episodeId, id, 'keyframe', keyAbs, 'image/png', 320, 180, 'placeholder', 'done', now);
  run(`INSERT INTO shot_renders(id, script_id, episode_id, shot_id, kind, file_path, mime, duration, backend, status, created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`, `RD-FLOW-VID-${i + 1}`, scriptId, episodeId, id, 'video', videoAbs, 'video/mp4', 1, 'placeholder', 'done', now);
}
let timelineId = null;
await checkAsync('多轨成片可生成并登记版本', async () => {
  const doc = createTimelineFromShots({ scriptId, episodeId, code, operator: '流程测试' });
  timelineId = doc.timeline.id;
  const out = await renderTimeline(timelineId, { operator: '流程测试' });
  const filmAbs = out.absFile || (out.file && (path.isAbsolute(out.file) ? out.file : path.resolve(ROOT, out.file)));
  assert.ok(filmAbs && fs.existsSync(filmAbs), `成片不存在：${out.absFile || out.file}`);
  const films = listFilms(timelineId);
  assert.ok(films.length >= 1);
  return `${filmAbs} · ${films.length} 版`;
});

console.log('\n=== 4. 成片审片 / 生产订单 / 成本 ===');
check('成片可送审、通过并锁定', () => {
  setReviewStatus(timelineId, 'review', { operator: '流程测试' });
  setReviewStatus(timelineId, 'approved', { operator: '流程测试', note: 'E2E 通过' });
  const locked = setReviewStatus(timelineId, 'locked', { operator: '流程测试' });
  assert.equal(locked.status, 'locked');
  return locked.status;
});
check('生产订单登记集进度并汇总', () => {
  const order = createOrder({ projectId, title: '全流程 E2E 订单', budgetLimit: 100 });
  upsertEpisode({ orderId: order.id, code, status: 'done', shotTotal: 3, shotDone: 3 });
  const sum = orderSummary(order.id);
  assert.equal(sum.episodes, 1);
  assert.equal(sum.shotDone, 3);
  return order.id;
});
check('成本台账按项目/集汇总', () => {
  recordCost({ projectId, episodeId, stage: 'e2e', amount: 0.01, currency: 'CNY', meta: { source: 'offline-e2e' } });
  const total = sumCost({ projectId, episodeId, currency: 'CNY' });
  assert.equal(total, 0.01);
  return `${total} CNY`;
});

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
if (!fail) {
  console.log(`E2E 证据：脚本 ${scriptId} / 集 ${code} / 时间线 ${timelineId} / 订单 ${projectId}`);
}
fs.rmSync(TMP, { recursive: true, force: true });
if (fail) process.exitCode = 1;
