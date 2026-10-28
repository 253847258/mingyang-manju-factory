// 存量资产迁移测试：真实资产接口 + 临时库，验证 dry-run 零写入与 apply 幂等。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  classifyCanvasNode,
  mapActorToAsset,
  migrateAssets,
  parseArgs,
} from '../scripts/migrate-assets.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-migrate-assets-'));
const DB_FILE = path.join(TMP, 'factory.db');
process.env.FACTORY_DB = DB_FILE;
process.env.FACTORY_DATA_DIR = path.join(TMP, 'data');
fs.mkdirSync(process.env.FACTORY_DATA_DIR, { recursive: true });

const { db } = await import('../src/db.js');
const assets = await import('../src/assets.js');

let pass = 0;
let fail = 0;

function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    fail += 1;
    console.error(`  ✗ ${name}：${error.message}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    fail += 1;
    console.error(`  ✗ ${name}：${error.message}`);
  }
}

db.exec(`
  CREATE TABLE actors (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    desc TEXT,
    gender TEXT,
    role_type TEXT
  );
  CREATE TABLE canvas_nodes (
    id TEXT PRIMARY KEY,
    canvas_id TEXT NOT NULL,
    kind TEXT,
    title TEXT,
    note TEXT,
    data TEXT,
    x REAL,
    y REAL,
    w REAL,
    h REAL,
    z INTEGER,
    locked INTEGER
  );
`);

const insertActor = db.prepare('INSERT INTO actors (id, name, desc, gender, role_type) VALUES (?, ?, ?, ?, ?)');
insertActor.run('C-0001', '林知夏', '海滨城市长大的摄影社少女', 'female', '女主');
insertActor.run('C-0002', '苏晚晴', '外冷内热的江南女官', 'female', '女主');
insertActor.run('C-0003', '沈砚', '沉默寡言的办案人', 'male', '男主');

const insertNode = db.prepare(`
  INSERT INTO canvas_nodes (id, canvas_id, kind, title, note, data, x, y, w, h, z, locked)
  VALUES (?, 'CV-TEST', ?, ?, ?, ?, 0, 0, 180, 220, 1, 0)
`);
insertNode.run('N-001', 'scene', '雨夜码头', '外景主场景', '{"weather":"雨","desc":"潮湿的旧码头"}');
insertNode.run('N-002', 'custom', '旧仓库', '需要一间废弃仓库作为场景', '{"desc":"木梁与铁门"}');
insertNode.run('N-003', 'item', '停摆怀表', '男主随身道具', '{"desc":"银壳，停在十一点"}');
insertNode.run('N-004', 'video', '片段A', '普通视频片段', '{"duration":3}');

function tableExists(name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function assetCount() {
  return tableExists('assets') ? Number(db.prepare('SELECT COUNT(*) AS n FROM assets').get().n) : 0;
}

console.log('\n=== 存量资产迁移 ===');

await checkAsync('映射与识别：演员为 character，场景/道具按 kind/title/note 识别', async () => {
  const mapped = mapActorToAsset({ id: 'C-1', name: '甲', desc: '说明' });
  assert.equal(mapped.type, 'character');
  assert.equal(mapped.params.source_id, 'C-1');
  assert.equal(classifyCanvasNode({ kind: 'scene', title: '码头' }), 'scene');
  assert.equal(classifyCanvasNode({ kind: 'custom', title: '旧仓库', note: '主要场景' }), 'scene');
  assert.equal(classifyCanvasNode({ kind: 'item', title: '怀表' }), 'prop');
  assert.equal(classifyCanvasNode({ kind: 'video', title: '片段' }), null);
});

await checkAsync('参数：默认 dry-run，--apply 才写入', async () => {
  assert.deepEqual(parseArgs([]), { apply: false, help: false });
  assert.deepEqual(parseArgs(['--apply']), { apply: true, help: false });
  assert.throws(() => parseArgs(['--dry-run', '--apply']), /不能同时使用/);
  assert.throws(() => parseArgs(['--unknown']), /未知参数/);
});

const dry = await migrateAssets({ db, assets, apply: false });

await checkAsync('dry-run 报告 6 条待创建、1 条无法识别，且不建表、不写数据', async () => {
  assert.equal(dry.mode, 'dry-run');
  assert.equal(dry.actorsRead, 3);
  assert.equal(dry.canvasNodesRead, 4);
  assert.equal(dry.toCreate, 6);
  assert.equal(dry.created, 0);
  assert.equal(dry.skippedUnrecognized, 1);
  assert.equal(dry.skipped, 1);
  assert.equal(dry.byType.character.toCreate, 3);
  assert.equal(dry.byType.scene.toCreate, 2);
  assert.equal(dry.byType.prop.toCreate, 1);
  assert.equal(tableExists('assets'), false);
  assert.equal(assetCount(), 0);
});

const applied = await migrateAssets({ db, assets, apply: true });

await checkAsync('apply 经真实资产接口写入 6 条，类型、名称、描述与来源可查', async () => {
  assert.equal(applied.mode, 'apply');
  assert.equal(applied.created, 6);
  assert.equal(assetCount(), 6);
  assert.deepEqual(
    db.prepare("SELECT type, name FROM assets WHERE type = 'character' ORDER BY name").all().map((row) => [row.type, row.name]),
    [['character', '林知夏'], ['character', '沈砚'], ['character', '苏晚晴']],
  );
  assert.deepEqual(
    db.prepare("SELECT type, name FROM assets WHERE type = 'scene' ORDER BY name").all().map((row) => [row.type, row.name]),
    [['scene', '旧仓库'], ['scene', '雨夜码头']],
  );
  assert.deepEqual(
    db.prepare("SELECT type, name FROM assets WHERE type = 'prop'").all().map((row) => [row.type, row.name]),
    [['prop', '停摆怀表']],
  );

  const actorAsset = db.prepare("SELECT description, params FROM assets WHERE type = 'character' AND name = '林知夏'").get();
  assert.equal(actorAsset.description, '海滨城市长大的摄影社少女');
  const actorParams = JSON.parse(actorAsset.params);
  assert.equal(actorParams.source_table, 'actors');
  assert.equal(actorParams.source_id, 'C-0001');
  assert.equal(actorParams.actor.desc, '海滨城市长大的摄影社少女');

  const sceneAsset = db.prepare("SELECT params FROM assets WHERE type = 'scene' AND name = '雨夜码头'").get();
  const sceneParams = JSON.parse(sceneAsset.params);
  assert.equal(sceneParams.source_table, 'canvas_nodes');
  assert.equal(sceneParams.source_id, 'N-001');
  assert.equal(sceneParams.data.weather, '雨');
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM asset_versions').get().n), 6);
});

const repeated = await migrateAssets({ db, assets, apply: true });

await checkAsync('重复 apply 按 type+name 幂等：不新增资产和版本，全部跳过已存在', async () => {
  assert.equal(repeated.toCreate, 0);
  assert.equal(repeated.created, 0);
  assert.equal(repeated.skippedExisting, 6);
  assert.equal(repeated.skippedUnrecognized, 1);
  assert.equal(assetCount(), 6);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM asset_versions').get().n), 6);
});

try { db.close(); } catch { /* 忽略关闭失败 */ }
fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n通过 ${pass} 项 / 失败 ${fail} 项`);
process.exitCode = fail ? 1 : 0;
