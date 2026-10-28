#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-routes-test-'));
process.env.FACTORY_DB = path.join(TMP, 'assets-routes.db');
process.env.FACTORY_DATA_DIR = path.join(TMP, 'data');
process.env.FACTORY_CONFIG = path.join(TMP, 'config.json');
fs.mkdirSync(process.env.FACTORY_DATA_DIR, { recursive: true });
fs.writeFileSync(process.env.FACTORY_CONFIG, JSON.stringify({ llm: { provider: 'mock' } }));

const { createApp, createServer } = await import('../src/http.js');
const { recordCost } = await import('../src/cost-ledger.js');
const { registerAssetRoutes } = await import('../src/routes/assets.js');

const snapshots = new Map();
let snapshotSchemaCalls = 0;
const snapshotApi = {
  ensureSnapshotSchema() {
    snapshotSchemaCalls += 1;
    return { ok: true };
  },
  freezeSnapshot(input) {
    const snapshot = {
      id: `SNAP-${snapshots.size + 1}`,
      scriptId: input.scriptId,
      code: input.code,
      note: input.note || '',
      assets: input.assets || [],
    };
    snapshots.set(`${snapshot.scriptId}:${snapshot.code}`, snapshot);
    return snapshot;
  },
  getSnapshot(input) {
    return snapshots.get(`${input.scriptId}:${input.code}`) || null;
  },
  listSnapshots() {
    return [...snapshots.values()];
  },
  compareSnapshot() {
    throw new Error('本测试不比较快照');
  },
};

const { app, handle } = createApp();
registerAssetRoutes(app, { snapshotApi });
const server = createServer((req, res) => handle(req, res, {}));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

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

async function request(method, url, body) {
  const response = await fetch(base + url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

let assetId;
let versionTwoId;

console.log('\n=== 1. 资产创建、筛选、更新与版本回退 ===');
await check('POST /api/assets 创建角色资产', async () => {
  const result = await request('POST', '/api/assets', {
    type: 'role',
    name: '林越',
    description: '主角',
    project_id: 'P-V2',
    params: { tone: 'cinematic' },
    ref_images: ['refs/lin-v1.png'],
  });
  assert.equal(result.status, 200);
  assert.equal(result.json.ok, true);
  assert.equal(result.json.asset.type, 'role');
  assert.equal(result.json.asset.current_version, 1);
  assetId = result.json.asset.id;
  return assetId;
});

await check('GET /api/assets 支持 type 与 project_id 组合筛选', async () => {
  const result = await request('GET', '/api/assets?type=role&project_id=P-V2');
  assert.equal(result.status, 200);
  assert.equal(result.json.ok, true);
  assert.equal(result.json.count, 1);
  assert.equal(result.json.assets[0].id, assetId);
  return `count=${result.json.count}`;
});

await check('PUT /api/assets/:id 更新资产并生成版本 2', async () => {
  const result = await request('PUT', `/api/assets/${assetId}`, {
    name: '林越定版',
    params: { tone: 'cinematic', expression: 'calm' },
    ref_images: ['refs/lin-v2.png'],
  });
  assert.equal(result.status, 200);
  assert.equal(result.json.ok, true);
  assert.equal(result.json.asset.current_version, 2);
  assert.equal(result.json.asset.name, '林越定版');
  return `current_version=${result.json.asset.current_version}`;
});

await check('GET /api/assets/:id/versions 返回 v1 与 v2 且内容保留', async () => {
  const result = await request('GET', `/api/assets/${assetId}/versions`);
  assert.equal(result.status, 200);
  assert.equal(result.json.count, 2);
  assert.deepEqual(result.json.versions.map((item) => item.version_no), [1, 2]);
  versionTwoId = result.json.versions[1].id;
  assert.ok(versionTwoId);
  return result.json.versions.map((item) => item.version_no).join(', ');
});

await check('POST /api/assets/:id/current-version 回退到 v1 且不删除 v2', async () => {
  const result = await request('POST', `/api/assets/${assetId}/current-version`, { version_no: 1 });
  assert.equal(result.status, 200);
  assert.equal(result.json.asset.current_version, 1);
  const versions = await request('GET', `/api/assets/${assetId}/versions`);
  assert.equal(versions.json.count, 2);
  assert.ok(versions.json.versions.some((item) => item.id === versionTwoId));
  return 'current_version=1，v2 保留';
});

await check('错误响应使用中文并给出 400', async () => {
  const result = await request('POST', '/api/assets', { type: 'role' });
  assert.equal(result.status, 400);
  assert.equal(result.json.ok, false);
  assert.match(result.json.error, /[\u4e00-\u9fff]/);
  assert.match(result.json.error, /资产名称不能为空/);
  return result.json.error;
});

console.log('\n=== 2. 资产快照（按缺失模块的约定接口注入桩） ===');
await check('POST /api/assets/snapshot 写入快照', async () => {
  const result = await request('POST', '/api/assets/snapshot', {
    script_id: 'SC-V2',
    code: 'S01E001',
    note: '第 1 集资产基线',
    assets: [assetId],
  });
  assert.equal(result.status, 200);
  assert.equal(result.json.ok, true);
  assert.equal(result.json.snapshot.scriptId, 'SC-V2');
  assert.equal(result.json.snapshot.code, 'S01E001');
  assert.ok(snapshotSchemaCalls >= 1);
  return result.json.snapshot.id;
});

await check('GET /api/assets/snapshot 读取快照', async () => {
  const result = await request('GET', '/api/assets/snapshot?script_id=SC-V2&code=S01E001');
  assert.equal(result.status, 200);
  assert.equal(result.json.ok, true);
  assert.equal(result.json.snapshot.note, '第 1 集资产基线');
  assert.deepEqual(result.json.snapshot.assets, [assetId]);
  return result.json.snapshot.id;
});

await check('GET /api/assets/snapshot 无参数返回快照历史列表', async () => {
  const result = await request('GET', '/api/assets/snapshot');
  assert.equal(result.status, 200);
  assert.equal(result.json.ok, true);
  assert.equal(result.json.count, 1);
  assert.equal(result.json.snapshots[0].scriptId, 'SC-V2');
  return `count=${result.json.count}`;
});

console.log('\n=== 3. 生成血缘 ===');
await check('POST /api/assets/lineage 写入血缘并自动计算参考哈希', async () => {
  const result = await request('POST', '/api/assets/lineage', {
    take_id: 'TAKE-V2-1',
    model: 'seedance',
    model_version: 'v2',
    seed: '42',
    prompt: '雨夜中的林越，电影感侧光',
    ref: 'refs/lin-v1.png',
    params: { ratio: '9:16' },
  });
  assert.equal(result.status, 200);
  assert.equal(result.json.ok, true);
  assert.equal(result.json.lineage.take_id, 'TAKE-V2-1');
  assert.match(result.json.lineage.ref_hash, /^[a-f0-9]{16}$/);
  return result.json.lineage.id;
});

await check('GET /api/assets/lineage?take_id= 读取最新血缘', async () => {
  const result = await request('GET', '/api/assets/lineage?take_id=TAKE-V2-1');
  assert.equal(result.status, 200);
  assert.equal(result.json.ok, true);
  assert.equal(result.json.lineage.take_id, 'TAKE-V2-1');
  assert.equal(result.json.lineage.model, 'seedance');
  return result.json.lineage.id;
});

console.log('\n=== 4. 成本台账读写 ===');
await check('recordCost 写入后，GET /api/assets/cost 按项目与集汇总', async () => {
  recordCost({
    projectId: 'P-V2',
    episodeId: 'E01',
    stage: 'video',
    amount: 12.3456,
    currency: 'CNY',
  });
  recordCost({
    projectId: 'P-V2',
    episodeId: 'E01',
    stage: 'image',
    amount: 2.6544,
    currency: 'CNY',
  });
  const result = await request('GET', '/api/assets/cost?project_id=P-V2&episode_id=E01');
  assert.equal(result.status, 200);
  assert.equal(result.json.ok, true);
  assert.equal(result.json.total, 15);
  return `total=${result.json.total}`;
});

console.log('\n=== 5. 生产订单 ===');
let orderId;
await check('POST /api/production/orders 创建订单并可带集进度', async () => {
  const result = await request('POST', '/api/production/orders', {
    project_id: 'P-V2',
    title: 'V2 资产层验收订单',
    budget_limit: 100,
    episodes: [
      { code: 'S01E001', status: 'done', shot_total: 10, shot_done: 8 },
    ],
  });
  assert.equal(result.status, 200);
  assert.equal(result.json.ok, true);
  assert.equal(result.json.order.project_id, 'P-V2');
  assert.equal(result.json.summary.episodes, 1);
  assert.equal(result.json.summary.shotDone, 8);
  orderId = result.json.order.id;
  return orderId;
});

await check('GET /api/production/orders 返回订单列表', async () => {
  const result = await request('GET', '/api/production/orders');
  assert.equal(result.status, 200);
  assert.equal(result.json.ok, true);
  assert.ok(result.json.orders.some((order) => order.id === orderId));
  return `count=${result.json.count}`;
});

await check('GET /api/production/orders/:id 返回详情与汇总', async () => {
  const result = await request('GET', `/api/production/orders/${orderId}`);
  assert.equal(result.status, 200);
  assert.equal(result.json.ok, true);
  assert.equal(result.json.order.id, orderId);
  assert.equal(result.json.summary.shotCompletionRate, 0.8);
  assert.equal(result.json.summary.completed, 1);
  return `shotDone=${result.json.summary.shotDone}/${result.json.summary.shotTotal}`;
});

await check('订单校验错误使用中文并给出 400', async () => {
  const result = await request('POST', '/api/production/orders', { projectId: 'P-V2' });
  assert.equal(result.status, 400);
  assert.equal(result.json.ok, false);
  assert.match(result.json.error, /[\u4e00-\u9fff]/);
  assert.match(result.json.error, /订单标题不能为空/);
  return result.json.error;
});

server.closeAllConnections?.();
await new Promise((resolve) => server.close(resolve));
console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(fail ? 1 : 0);
