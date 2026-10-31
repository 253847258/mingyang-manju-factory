#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'job-checkpoints-'));
process.env.FACTORY_DB = path.join(TMP, 'checkpoint.db');
process.env.FACTORY_DATA_DIR = path.join(TMP, 'data');
process.env.FACTORY_CONFIG = path.join(TMP, 'config.json');
fs.mkdirSync(process.env.FACTORY_DATA_DIR, { recursive: true });
fs.writeFileSync(process.env.FACTORY_CONFIG, JSON.stringify({ llm: { provider: 'mock' }, image: { backend: 'placeholder' }, video: { backend: 'placeholder' }, tts: { backend: 'none' } }));

const J = await import('../src/job-checkpoints.js');
const { all } = await import('../src/db.js');
let pass = 0, fail = 0;
function check(name, fn) {
  try { const detail = fn(); pass += 1; console.log(`  PASS ${name}${detail ? ` -> ${detail}` : ''}`); }
  catch (e) { fail += 1; console.error(`  FAIL ${name} -> ${e.message}`); }
}

console.log('\n=== 任务 checkpoint 账本 ===');
check('建表幂等且字段完整', () => {
  assert.equal(J.ensureJobCheckpointSchema(), true);
  assert.equal(J.ensureJobCheckpointSchema(), false);
  const cols = all('PRAGMA table_info(job_steps)').map((x) => x.name);
  assert.deepEqual(cols, ['id','job_id','step_key','status','input_hash','result','error','started_at','finished_at','updated_at']);
  return cols.length;
});
check('running → done 写入批次结果', () => {
  J.markJobStepRunning('JOB-1', 'outline:1-20', { from: 1, to: 20 });
  const r = J.markJobStepDone('JOB-1', 'outline:1-20', { from: 1, to: 20, result: { complete: 20 } });
  assert.equal(r.status, 'done');
  assert.ok(r.started_at && r.finished_at);
  return r.step_key;
});
check('重复写入同一步不新增行', () => {
  J.markJobStepDone('JOB-1', 'outline:1-20', { result: { complete: 20, again: true } });
  const s = J.listJobSteps('JOB-1');
  assert.equal(s.count, 1);
  assert.equal(s.steps[0].result.again, true);
  return 'upsert 正常';
});
check('错误步骤可记录中文错误', () => {
  const r = J.markJobStepError('JOB-1', 'card:21', new Error('模型限额'));
  assert.equal(r.status, 'error');
  assert.match(r.error, /模型限额/);
  return r.error;
});
check('缺失步骤能准确计算', () => {
  const missing = J.missingJobSteps('JOB-1', ['outline:1-20', 'card:21', 'card:22']);
  assert.deepEqual(missing, ['card:21', 'card:22']);
  return missing.join(',');
});
check('job 汇总显示完成/失败/未完成', () => {
  const s = J.listJobSteps('JOB-1');
  assert.equal(s.done, 1);
  assert.equal(s.failed, 1);
  assert.equal(s.complete, false);
  return JSON.stringify({ done: s.done, failed: s.failed, complete: s.complete });
});
check('不同 job 的步骤互不污染', () => {
  J.markJobStepDone('JOB-2', 'card:1', { result: { ok: true } });
  assert.equal(J.listJobSteps('JOB-1').count, 2);
  assert.equal(J.listJobSteps('JOB-2').count, 1);
  return '隔离正常';
});

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
fs.rmSync(TMP, { recursive: true, force: true });
if (fail) process.exitCode = 1;
