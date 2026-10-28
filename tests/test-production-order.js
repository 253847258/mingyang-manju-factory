#!/usr/bin/env node
// 生产订单聚合层：建表、CRUD、幂等 UPSERT、摘要与中文错误。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'production-order-'));
process.env.FACTORY_DB = path.join(TMP, 'factory.db');
process.env.FACTORY_DATA_DIR = path.join(TMP, 'data');
process.env.FACTORY_CONFIG = path.join(TMP, 'config.json');
fs.mkdirSync(process.env.FACTORY_DATA_DIR, { recursive: true });
fs.writeFileSync(process.env.FACTORY_CONFIG, '{}');

const { all } = await import('../src/db.js');
const {
  ensureOrderSchema,
  createOrder,
  listOrders,
  getOrder,
  upsertEpisode,
  orderSummary,
} = await import('../src/production-order.js');

let pass = 0;
let fail = 0;
const test = (name, fn) => {
  try {
    fn();
    pass++;
    console.log(`  PASS ${name}`);
  } catch (error) {
    fail++;
    console.error(`  FAIL ${name} -> ${error.message}`);
  }
};
const throwsChinese = (fn, pattern) => {
  assert.throws(fn, (error) => {
    assert.match(error.message, pattern);
    assert.match(error.message, /[\u4e00-\u9fff]/);
    return true;
  });
};

console.log('\n=== 1. 建表与创建查询 ===');
test('ensureOrderSchema 可重复调用并建出两张表', () => {
  ensureOrderSchema();
  ensureOrderSchema();
  const tables = all("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('production_orders','production_order_episodes') ORDER BY name");
  assert.deepEqual(tables.map((row) => row.name), ['production_order_episodes', 'production_orders']);
});

const order = createOrder({ projectId: 'PRJ-001', title: '都市悬疑短剧', budgetLimit: 120000 });
test('createOrder 落库并返回完整字段', () => {
  assert.match(order.id, /^PO-/);
  assert.equal(order.project_id, 'PRJ-001');
  assert.equal(order.projectId, 'PRJ-001');
  assert.equal(order.title, '都市悬疑短剧');
  assert.equal(order.status, 'draft');
  assert.equal(order.budget_limit, 120000);
  assert.ok(order.created_at && order.updated_at);
});

test('getOrder 按 ID 查询，listOrders 返回订单列表', () => {
  assert.equal(getOrder(order.id).id, order.id);
  const rows = listOrders();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, order.id);
});

console.log('\n=== 2. 集级 UPSERT 与幂等 ===');
let episode = upsertEpisode({ orderId: order.id, code: 'S01E001', status: 'in_progress', shotTotal: 10, shotDone: 4 });
test('首次写入集状态与镜头进度', () => {
  assert.equal(episode.code, 'S01E001');
  assert.equal(episode.status, 'in_progress');
  assert.equal(episode.shot_total, 10);
  assert.equal(episode.shot_done, 4);
});

test('同 orderId/code 重复 UPSERT 不新增行且更新同一条记录', () => {
  const before = all('SELECT COUNT(*) AS n FROM production_order_episodes WHERE order_id = ?', order.id)[0].n;
  const again = upsertEpisode({ orderId: order.id, code: 'S01E001', status: 'done', shotTotal: 10, shotDone: 10 });
  const after = all('SELECT COUNT(*) AS n FROM production_order_episodes WHERE order_id = ?', order.id)[0].n;
  assert.equal(after, before);
  assert.equal(again.id, episode.id);
  assert.equal(again.status, 'done');
  assert.equal(again.shot_done, 10);
  episode = again;
});

upsertEpisode({ orderId: order.id, code: 'S01E002', status: 'blocked', shotTotal: 8, shotDone: 2 });
upsertEpisode({ orderId: order.id, code: 'S01E003', status: 'in_progress', shotTotal: 6, shotDone: 3 });
const duplicate = upsertEpisode({ orderId: order.id, code: 'S01E003', status: 'in_progress', shotTotal: 6, shotDone: 3 });
test('相同数据重复 UPSERT 结果保持一致', () => {
  assert.equal(duplicate.code, 'S01E003');
  assert.equal(duplicate.shot_total, 6);
  assert.equal(duplicate.shot_done, 3);
  assert.equal(all('SELECT COUNT(*) AS n FROM production_order_episodes WHERE order_id = ?', order.id)[0].n, 3);
});

console.log('\n=== 3. 宏观摘要 ===');
test('摘要正确聚合集数、完成数与镜头完成率', () => {
  const summary = orderSummary(order.id);
  assert.equal(summary.episodeCount, 3);
  assert.equal(summary.completedCount, 1);
  assert.equal(summary.shotTotal, 24);
  assert.equal(summary.shotDone, 15);
  assert.equal(summary.shotCompletionRate, 0.625);
  assert.equal(summary.shotDonePct, 62.5);
});

test('摘要正确返回阻塞集数量与集编号', () => {
  const summary = orderSummary(order.id);
  assert.equal(summary.blockedEpisodes, 1);
  assert.equal(summary.blockedCount, 1);
  assert.deepEqual(summary.blockedCodes, ['S01E002']);
});

console.log('\n=== 4. 中文错误与参数校验 ===');
test('查询不存在订单时抛出中文错误', () => {
  throwsChinese(() => getOrder('PO-NOT-FOUND'), /订单不存在/);
});

test('给不存在订单写集时抛出中文错误', () => {
  throwsChinese(() => upsertEpisode({ orderId: 'PO-NOT-FOUND', code: 'S01E001', shotTotal: 1, shotDone: 0 }), /订单不存在/);
});

test('聚合不存在订单时抛出中文错误', () => {
  throwsChinese(() => orderSummary('PO-NOT-FOUND'), /订单不存在/);
});

test('已完成镜头数大于总数时拒绝并返回中文错误', () => {
  throwsChinese(() => upsertEpisode({ orderId: order.id, code: 'S01E099', shotTotal: 3, shotDone: 4 }), /不能大于/);
});

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(fail ? 1 : 0);
