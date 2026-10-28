#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-assets-test-'));
process.env.FACTORY_DB = path.join(TMP, 'assets.db');
process.env.FACTORY_DATA_DIR = path.join(TMP, 'data');
fs.mkdirSync(process.env.FACTORY_DATA_DIR, { recursive: true });

const { all, run } = await import('../src/db.js');
const {
  ASSET_TYPES,
  ensureAssetSchema,
  listAssets,
  getAsset,
  createAsset,
  updateAsset,
  listVersions,
  getVersion,
  setCurrentVersion,
} = await import('../src/assets.js');

let pass = 0;
let fail = 0;
function check(name, work) {
  try {
    const detail = work();
    pass += 1;
    console.log(`  PASS ${name}${detail ? ` -> ${detail}` : ''}`);
  } catch (error) {
    fail += 1;
    console.error(`  FAIL ${name} -> ${error.message}`);
  }
}

console.log('\n=== 1. 表结构与四类实体 ===');
ensureAssetSchema();
check('表结构严格符合资产与版本契约', () => {
  assert.deepEqual(
    all('PRAGMA table_info(assets)').map((column) => column.name),
    ['id', 'project_id', 'type', 'name', 'description', 'current_version', 'params', 'created_at', 'updated_at'],
  );
  assert.deepEqual(
    all('PRAGMA table_info(asset_versions)').map((column) => column.name),
    ['id', 'asset_id', 'version_no', 'ref_images', 'fingerprint', 'params', 'created_at'],
  );
  return '2 张表字段一致';
});

const created = {};
check('角色 / 场景 / 道具 / 服装四类资产均可创建', () => {
  for (const type of ASSET_TYPES) {
    created[type] = createAsset({
      type,
      name: `${type}-资产`,
      description: `${type} 描述`,
      projectId: 'P-ASSET',
      params: { category: type, tone: 'cinematic' },
    });
    assert.equal(created[type].type, type);
    assert.equal(created[type].current_version, 1);
  }
  return ASSET_TYPES.join(' / ');
});

check('列表支持 type 与 projectId 组合过滤', () => {
  const rows = listAssets({ type: 'scene', projectId: 'P-ASSET' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, created.scene.id);
  assert.equal(listAssets({ projectId: 'P-ASSET' }).length, 4);
  return '场景 1 条 / 项目 4 条';
});

check('详情返回已落库的原始字段', () => {
  const asset = getAsset(created.role.id);
  assert.equal(asset.name, 'role-资产');
  assert.equal(asset.params, JSON.stringify({ category: 'role', tone: 'cinematic' }));
  assert.match(asset.created_at, /^\d{4}-\d{2}-\d{2}T/);
  return asset.id;
});

console.log('\n=== 2. 版本只增不改 ===');
const roleAssetId = created.role.id;
const originalVersion = getVersion(roleAssetId, 1);
check('创建资产时同步生成 version1', () => {
  const versions = listVersions(roleAssetId);
  assert.equal(versions.length, 1);
  assert.equal(versions[0].version_no, 1);
  assert.deepEqual(JSON.parse(versions[0].ref_images), []);
  return versions[0].id;
});

check('更新生成 version2 并推进 current_version', () => {
  const updated = updateAsset(roleAssetId, {
    name: '林越定版',
    description: '主角定版形象',
    params: { category: 'role', expression: 'calm' },
    refImages: ['refs/lin-v2.png'],
    fingerprint: 'fp-role-v2',
  });
  assert.equal(updated.name, '林越定版');
  assert.equal(updated.current_version, 2);
  assert.equal(updated.params, JSON.stringify({ category: 'role', expression: 'calm' }));
  return `current_version=${updated.current_version}`;
});

check('version2 完整保留新参数与参考图血缘', () => {
  const version = getVersion(roleAssetId, 2);
  assert.equal(version.version_no, 2);
  assert.equal(version.fingerprint, 'fp-role-v2');
  assert.equal(version.params, JSON.stringify({ category: 'role', expression: 'calm' }));
  assert.deepEqual(JSON.parse(version.ref_images), ['refs/lin-v2.png']);
  return version.fingerprint;
});

check('version1 内容未被覆盖', () => {
  const version = getVersion(roleAssetId, 1);
  assert.equal(version.id, originalVersion.id);
  assert.equal(version.fingerprint, originalVersion.fingerprint);
  assert.equal(version.params, originalVersion.params);
  assert.equal(version.ref_images, originalVersion.ref_images);
  return '旧版本仍可读取';
});

check('asset_versions 的 UPDATE 被数据库触发器拒绝', () => {
  assert.throws(
    () => run('UPDATE asset_versions SET params = ? WHERE id = ?', '{}', originalVersion.id),
    /资产版本只允许新增，不允许修改/,
  );
  return '只增不改已强制';
});

console.log('\n=== 3. 回退与错误处理 ===');
check('setCurrentVersion 可回退到 version1 且不删新版本', () => {
  const rolledBack = setCurrentVersion(roleAssetId, 1);
  assert.equal(rolledBack.current_version, 1);
  assert.equal(listVersions(roleAssetId).length, 2);
  assert.ok(getVersion(roleAssetId, 2));
  return 'current_version=1，version2 保留';
});

check('回退后更新从历史最大版本递增，不从回退指针覆盖 version2', () => {
  const updated = updateAsset(roleAssetId, { description: '回退后另开版本' });
  assert.equal(updated.current_version, 3);
  const versions = listVersions(roleAssetId);
  assert.deepEqual(versions.map((version) => version.version_no), [1, 2, 3]);
  assert.equal(getVersion(roleAssetId, 3).params, originalVersion.params);
  return 'version3 基于 version1 参数生成';
});

check('非法 type 返回中文错误', () => {
  assert.throws(
    () => createAsset({ type: 'vehicle', name: '飞船', projectId: 'P-ASSET' }),
    /非法资产类型/,
  );
  return '非法资产类型';
});

check('缺少资产或版本时返回中文错误', () => {
  assert.throws(() => updateAsset('AST-NOT-FOUND', { name: '不存在' }), /资产不存在/);
  assert.throws(() => setCurrentVersion(roleAssetId, 99), /资产版本不存在/);
  return '中文错误可读';
});

check('查询不存在的数据返回 null / 空数组', () => {
  assert.equal(getAsset('AST-NOT-FOUND'), null);
  assert.equal(getVersion(roleAssetId, 99), null);
  assert.deepEqual(listVersions('AST-NOT-FOUND'), []);
  return '空态稳定';
});

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
fs.rmSync(TMP, { recursive: true, force: true });
if (fail) process.exitCode = 1;
