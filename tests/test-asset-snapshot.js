#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-asset-snapshot-test-'));
process.env.FACTORY_DB = path.join(TMP, 'asset-snapshot.db');
process.env.FACTORY_DATA_DIR = path.join(TMP, 'data');
fs.mkdirSync(process.env.FACTORY_DATA_DIR, { recursive: true });

let snapshotApi = null;
let snapshotImportError = null;
try {
  snapshotApi = await import('../src/asset-snapshot.js');
} catch (error) {
  snapshotImportError = error;
}

const { all } = await import('../src/db.js');
const {
  ensureAssetSchema,
  createAsset,
  updateAsset,
  getVersion,
} = await import('../src/assets.js');

let pass = 0;
let fail = 0;

async function check(name, work) {
  try {
    const detail = await work();
    pass += 1;
    console.log(`  PASS ${name}${detail ? ` -> ${detail}` : ''}`);
  } catch (error) {
    fail += 1;
    console.error(`  FAIL ${name} -> ${error.message}`);
  }
}

function requireApi() {
  if (!snapshotApi) {
    const reason = snapshotImportError?.code === 'ERR_MODULE_NOT_FOUND'
      ? '资产快照模块尚未生成：src/asset-snapshot.js'
      : `资产快照模块加载失败：${snapshotImportError?.message || '未知错误'}`;
    throw new Error(reason);
  }
  return snapshotApi;
}

async function expectChineseReject(work, pattern) {
  let thrown = null;
  try {
    await work();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, '应当抛出错误');
  assert.match(String(thrown.message || ''), pattern);
}

function snapshotAssetVersions(snapshot) {
  assert.ok(Array.isArray(snapshot.asset_versions), 'asset_versions 必须是数组');
  return snapshot.asset_versions;
}

function versionOf(snapshot, assetId) {
  const version = snapshotAssetVersions(snapshot)
    .find((item) => String(item.asset_id ?? item.assetId ?? '') === assetId);
  assert.ok(version, `快照中缺少资产 ${assetId}`);
  return version;
}

ensureAssetSchema();
const role = createAsset({
  type: 'role',
  name: '快照测试角色',
  description: 'version 1 形象',
  projectId: 'P-SNAPSHOT',
  params: { identity: 'snapshot-role' },
  refImages: ['refs/role-v1.png'],
});
const scene = createAsset({
  type: 'scene',
  name: '快照测试场景',
  description: 'version 1 场景',
  projectId: 'P-SNAPSHOT',
  params: { location: 'rooftop' },
  refImages: ['refs/scene-v1.png'],
});

const inputA1 = {
  scriptId: 'SCRIPT-SNAPSHOT-A',
  code: 'EP-01',
  episodeId: 'EPISODE-A1',
  note: 'A 剧集首版冻结',
  takeIds: ['TAKE-A1'],
  assetIds: [role.id, scene.id],
};
const inputB1 = {
  episodeId: 'EPISODE-B1',
  note: 'B 剧集首版冻结',
  takeIds: ['TAKE-B1'],
  asset_ids: [role.id, scene.id],
};
const snapshots = {};

console.log('\n=== 1. 临时库隔离与表结构 ===');
await check('FACTORY_DB 确实指向系统临时目录', () => {
  assert.ok(process.env.FACTORY_DB.startsWith(os.tmpdir()));
  assert.ok(!process.env.FACTORY_DB.includes(path.join('data', 'factory.db')));
  return process.env.FACTORY_DB;
});

await check('ensureSnapshotSchema 幂等且六列齐全', () => {
  const api = requireApi();
  assert.equal(typeof api.ensureSnapshotSchema, 'function');
  api.ensureSnapshotSchema();
  api.ensureSnapshotSchema();
  const columns = all('PRAGMA table_info(asset_snapshots)').map((column) => column.name);
  for (const expected of ['id', 'episode_id', 'script_id', 'code', 'asset_versions', 'frozen_at']) {
    assert.ok(columns.includes(expected), `asset_snapshots 缺少列 ${expected}`);
  }
  return columns.join(', ');
});

console.log('\n=== 2. 真实资产版本与两种冻结调用 ===');
await check('测试夹具已生成真实资产 version 1', () => {
  assert.equal(role.current_version, 1);
  assert.equal(scene.current_version, 1);
  assert.equal(getVersion(role.id, 1).version_no, 1);
  assert.equal(getVersion(scene.id, 1).version_no, 1);
  return `${role.id} / ${scene.id}`;
});

await check('freezeSnapshot(inputObj) 可用并冻结真实资产版本', async () => {
  const api = requireApi();
  snapshots.a1 = await api.freezeSnapshot(inputA1);
  assert.ok(snapshots.a1 && typeof snapshots.a1 === 'object', '冻结结果必须是对象');
  versionOf(snapshots.a1, role.id);
  versionOf(snapshots.a1, scene.id);
  return `快照 ${snapshots.a1.id || '已生成'}`;
});

await check('freezeSnapshot(scriptId, code, inputObj) 可用', async () => {
  const api = requireApi();
  snapshots.b1 = await api.freezeSnapshot('SCRIPT-SNAPSHOT-B', 'EP-01', inputB1);
  versionOf(snapshots.b1, role.id);
  versionOf(snapshots.b1, scene.id);
  return `快照 ${snapshots.b1.id || '已生成'}`;
});

console.log('\n=== 3. 返回字段与 camelCase 兼容 ===');
await check('冻结结果字段完整且 snake_case / camelCase 兼容', () => {
  const snapshot = snapshots.a1;
  assert.equal(snapshot.script_id, 'SCRIPT-SNAPSHOT-A');
  assert.equal(snapshot.scriptId, 'SCRIPT-SNAPSHOT-A');
  assert.equal(snapshot.code, 'EP-01');
  assert.equal(snapshot.episode_id, 'EPISODE-A1');
  assert.equal(snapshot.episodeId, 'EPISODE-A1');
  assert.equal(snapshot.note, inputA1.note);
  assert.ok(snapshot.frozen_at || snapshot.frozenAt);
  assert.ok(snapshot.frozenAt || snapshot.frozen_at);
  const snakeTakeIds = Array.isArray(snapshot.take_ids) ? snapshot.take_ids : JSON.parse(snapshot.take_ids || '[]');
  const camelTakeIds = Array.isArray(snapshot.takeIds) ? snapshot.takeIds : JSON.parse(snapshot.takeIds || '[]');
  assert.deepEqual(snakeTakeIds, inputA1.takeIds);
  assert.deepEqual(camelTakeIds, inputA1.takeIds);
  const roleVersion = versionOf(snapshot, role.id);
  assert.equal(roleVersion.version_no, 1);
  assert.equal(roleVersion.asset_id, role.id);
  return '字段与别名一致';
});

console.log('\n=== 4. 读取、排序与 limit ===');
await check('getSnapshot(inputObj) 与 getSnapshot(scriptId, code) 均可读取', async () => {
  const api = requireApi();
  const byObject = await api.getSnapshot({ scriptId: 'SCRIPT-SNAPSHOT-A', code: 'EP-01' });
  const byArgs = await api.getSnapshot('SCRIPT-SNAPSHOT-A', 'EP-01');
  assert.equal(byObject.id, snapshots.a1.id);
  assert.equal(byArgs.id, snapshots.a1.id);
  assert.deepEqual(
    snapshotAssetVersions(byObject).map((item) => item.asset_id).sort(),
    [role.id, scene.id].sort(),
  );
  return '两种读取方式命中同一快照';
});

await check('不存在快照返回 null', async () => {
  const api = requireApi();
  assert.equal(await api.getSnapshot('SCRIPT-SNAPSHOT-A', 'EP-NOT-FOUND'), null);
  return '空态返回 null';
});

await check('同一剧本多集快照按冻结时间倒序', async () => {
  const api = requireApi();
  await sleep(20);
  snapshots.a2 = await api.freezeSnapshot({
    scriptId: 'SCRIPT-SNAPSHOT-A',
    code: 'EP-02',
    episodeId: 'EPISODE-A2',
    note: 'A 剧集第二版冻结',
    takeIds: ['TAKE-A2'],
    assetIds: [role.id, scene.id],
  });
  const list = await api.listSnapshots({ scriptId: 'SCRIPT-SNAPSHOT-A' });
  assert.ok(Array.isArray(list));
  assert.deepEqual(list.map((item) => item.code), ['EP-02', 'EP-01']);
  return list.map((item) => item.code).join(' > ');
});

await check('listSnapshots 的 limit 生效', async () => {
  const api = requireApi();
  const list = await api.listSnapshots({ scriptId: 'SCRIPT-SNAPSHOT-A', limit: 1 });
  assert.equal(list.length, 1);
  assert.equal(list[0].code, 'EP-02');
  return 'limit=1 仅返回最新快照';
});

console.log('\n=== 5. 重复冻结、漂移与参数校验 ===');
await check('同一 script_id + code 重复冻结抛出中文错误', async () => {
  const api = requireApi();
  await expectChineseReject(
    () => api.freezeSnapshot({
      scriptId: 'SCRIPT-SNAPSHOT-A',
      code: 'EP-01',
      episodeId: 'EPISODE-A1-DUP',
      assetIds: [role.id],
    }),
    /已存在|重复|唯一|冻结/,
  );
  return '重复冻结被拒绝';
});

await check('资产未变化时 compareSnapshot 返回无漂移', async () => {
  const api = requireApi();
  const comparison = await api.compareSnapshot('SCRIPT-SNAPSHOT-A', 'EP-01');
  assert.equal(comparison.drifted, false);
  return 'drifted=false';
});

await check('资产升版后能识别漂移并定位 asset_id', async () => {
  const api = requireApi();
  const updated = updateAsset(role.id, {
    description: 'version 2 形象',
    params: { identity: 'snapshot-role', revision: 2 },
    refImages: ['refs/role-v2.png'],
    fingerprint: 'fp-role-v2',
  });
  assert.equal(updated.current_version, 2);
  assert.equal(getVersion(role.id, 2).version_no, 2);

  const comparison = await api.compareSnapshot('SCRIPT-SNAPSHOT-A', 'EP-01');
  assert.equal(comparison.drifted, true);
  assert.ok(
    JSON.stringify(comparison).includes(role.id),
    `漂移结果必须在 changes/items 等字段中定位 ${role.id}`,
  );
  return `识别到 ${role.id} 从 v1 漂移到 v2`;
});

await check('空 script/code 与非法参数均抛出中文错误', async () => {
  const api = requireApi();
  await expectChineseReject(() => api.freezeSnapshot({ code: 'EP-01' }), /script|剧本|编号|参数|必填|不能为空/i);
  await expectChineseReject(() => api.freezeSnapshot('SCRIPT-INVALID', '', {}), /code|剧集|编号|参数|必填|不能为空/i);
  await expectChineseReject(() => api.getSnapshot('', 'EP-01'), /script|剧本|编号|参数|必填|不能为空/i);
  return '空参数均被可读中文错误拦截';
});

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
fs.rmSync(TMP, { recursive: true, force: true });
if (fail) process.exitCode = 1;
