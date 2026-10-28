#!/usr/bin/env node
// 成本台账验收：记录、按维度汇总、预算检查和非法输入。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-ledger-'));
process.env.FACTORY_DB = path.join(TMP, 'cost-ledger.db');
process.env.FACTORY_DATA_DIR = path.join(TMP, 'data');
process.env.FACTORY_CONFIG = path.join(TMP, 'config.json');
fs.mkdirSync(process.env.FACTORY_DATA_DIR, { recursive: true });
fs.writeFileSync(process.env.FACTORY_CONFIG, JSON.stringify({ llm: { provider: 'mock' } }));

const {
  ensureCostSchema,
  recordCost,
  sumCost,
  budgetCheck,
} = await import('../src/cost-ledger.js');
const { db } = await import('../src/db.js');

let pass = 0;
let fail = 0;

function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  PASS ${name}`);
  } catch (error) {
    fail += 1;
    console.error(`  FAIL ${name} -> ${error.message}`);
  }
}

console.log('\n=== 成本台账 ===');

check('ensureCostSchema 创建完整字段且可重复调用', () => {
  ensureCostSchema();
  ensureCostSchema();
  const columns = db.prepare('PRAGMA table_info(cost_ledger)').all().map((column) => column.name);
  assert.deepEqual(columns, [
    'id',
    'project_id',
    'episode_id',
    'stage',
    'amount',
    'currency',
    'meta',
    'created_at',
  ]);
});

const first = recordCost({
  projectId: 'P-1',
  episodeId: 'E-1',
  stage: 'keyframe',
  amount: 12.34,
  currency: 'CNY',
  meta: { model: 'image-a', attempt: 1 },
});
recordCost({ projectId: 'P-1', episodeId: 'E-1', stage: 'video', amount: 10, currency: 'CNY' });
recordCost({ projectId: 'P-1', episodeId: 'E-2', stage: 'keyframe', amount: 7.66, currency: 'CNY' });
recordCost({ projectId: 'P-2', episodeId: 'E-1', stage: 'keyframe', amount: 5, currency: 'USD' });

check('每笔记录生成唯一 ID 并写入时间', () => {
  assert.match(first.id, /^[0-9a-f-]{36}$/);
  assert.ok(!Number.isNaN(Date.parse(first.createdAt)));
});

check('meta 以 JSON 文本落库', () => {
  const saved = db.prepare('SELECT meta FROM cost_ledger WHERE id = ?').get(first.id);
  assert.deepEqual(JSON.parse(saved.meta), { model: 'image-a', attempt: 1 });
});

check('按项目汇总金额准确', () => {
  assert.equal(sumCost({ projectId: 'P-1' }), 30);
});

check('按集过滤汇总准确', () => {
  assert.equal(sumCost({ projectId: 'P-1', episodeId: 'E-1' }), 22.34);
});

check('按阶段过滤汇总准确', () => {
  assert.equal(sumCost({ projectId: 'P-1', stage: 'keyframe' }), 20);
});

check('预算未超限时返回 spent / remaining / over', () => {
  assert.deepEqual(budgetCheck({ projectId: 'P-1', limit: 50, currency: 'CNY' }), {
    spent: 30,
    remaining: 20,
    over: false,
  });
});

check('预算超限时 over=true 且剩余为负数', () => {
  assert.deepEqual(budgetCheck({ projectId: 'P-1', limit: 25, currency: 'CNY' }), {
    spent: 30,
    remaining: -5,
    over: true,
  });
});

check('预算只统计指定币种', () => {
  assert.deepEqual(budgetCheck({ projectId: 'P-2', limit: 4, currency: 'USD' }), {
    spent: 5,
    remaining: -1,
    over: true,
  });
});

check('非法金额均返回中文错误', () => {
  for (const amount of [-0.01, Number.NaN, Number.POSITIVE_INFINITY, '1.25', undefined]) {
    assert.throws(
      () => recordCost({ projectId: 'P-1', episodeId: 'E-1', stage: 'tts', amount, currency: 'CNY' }),
      (error) => /金额/.test(error.message),
    );
  }
});

check('非法预算上限返回中文错误', () => {
  assert.throws(
    () => budgetCheck({ projectId: 'P-1', limit: -1, currency: 'CNY' }),
    (error) => /预算上限/.test(error.message),
  );
});

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);

try {
  db.close();
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

process.exitCode = fail ? 1 : 0;
