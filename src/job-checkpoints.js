// 长任务 checkpoint 账本（明文模块，不改混淆层 jobs.js）。
// 目标：记录每批/每步的完成状态，任务中断后可按 job_steps 判断已完成工作，避免整批重跑。

import { createHash, randomUUID } from 'node:crypto';
import { all, get, run } from './db.js';
import { nowISO } from './util.js';

const TABLE = 'job_steps';

function text(value, max = 4000) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function safeJson(value, fallback = null) {
  try {
    const out = JSON.parse(value || '');
    return out == null ? fallback : out;
  } catch { return fallback; }
}

function json(value) {
  try { return JSON.stringify(value ?? {}); } catch { return '{}'; }
}

export function stepKey(value) {
  const key = text(value, 200);
  if (!key) throw new Error('checkpoint 步骤键不能为空');
  return key;
}

export function ensureJobCheckpointSchema() {
  const existed = Boolean(get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", TABLE));
  run(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    step_key TEXT NOT NULL,
    status TEXT NOT NULL,
    input_hash TEXT,
    result TEXT,
    error TEXT,
    started_at TEXT,
    finished_at TEXT,
    updated_at TEXT NOT NULL
  )`);
  run(`CREATE UNIQUE INDEX IF NOT EXISTS ux_job_steps_job_key ON ${TABLE}(job_id, step_key)`);
  run(`CREATE INDEX IF NOT EXISTS ix_job_steps_status ON ${TABLE}(status, updated_at)`);
  return !existed;
}

export function inputHash(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value ?? {})).digest('hex').slice(0, 24);
}

export function upsertJobStep(jobId, key, status, { input = null, result = null, error = '' } = {}) {
  ensureJobCheckpointSchema();
  const jid = text(jobId, 120);
  const skey = stepKey(key);
  if (!jid) throw new Error('checkpoint 缺少 jobId');
  if (!['pending', 'running', 'done', 'error', 'skipped'].includes(status)) throw new Error(`未知 checkpoint 状态：${status}`);
  const now = nowISO();
  const previous = get(`SELECT * FROM ${TABLE} WHERE job_id=? AND step_key=?`, jid, skey);
  const id = previous?.id || `JSTEP-${randomUUID()}`;
  const startedAt = previous?.started_at || (status === 'running' ? now : null);
  const finishedAt = ['done', 'error', 'skipped'].includes(status) ? now : null;
  run(
    `INSERT INTO ${TABLE}(id, job_id, step_key, status, input_hash, result, error, started_at, finished_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(job_id, step_key) DO UPDATE SET
       status=excluded.status, input_hash=COALESCE(excluded.input_hash, ${TABLE}.input_hash),
       result=COALESCE(excluded.result, ${TABLE}.result), error=excluded.error,
       started_at=COALESCE(${TABLE}.started_at, excluded.started_at),
       finished_at=excluded.finished_at, updated_at=excluded.updated_at`,
    id, jid, skey, status, input === null ? previous?.input_hash || null : inputHash(input),
    result === null ? previous?.result || null : json(result), text(error, 1000),
    startedAt, finishedAt, now,
  );
  return get(`SELECT * FROM ${TABLE} WHERE job_id=? AND step_key=?`, jid, skey);
}

export function markJobStepRunning(jobId, key, input = null) {
  return upsertJobStep(jobId, key, 'running', { input });
}

export function markJobStepDone(jobId, key, { input = null, result = null } = {}) {
  return upsertJobStep(jobId, key, 'done', { input, result });
}

export function markJobStepError(jobId, key, error, { input = null } = {}) {
  return upsertJobStep(jobId, key, 'error', { input, error: error?.message || error });
}

export function listJobSteps(jobId) {
  ensureJobCheckpointSchema();
  const steps = all(`SELECT * FROM ${TABLE} WHERE job_id=? ORDER BY rowid ASC`, text(jobId, 120))
    .map((row) => ({ ...row, result: safeJson(row.result, row.result || null) }));
  const counts = steps.reduce((acc, step) => {
    acc[step.status] = (acc[step.status] || 0) + 1;
    return acc;
  }, {});
  return {
    ok: true,
    jobId: text(jobId, 120),
    count: steps.length,
    done: counts.done || 0,
    failed: counts.error || 0,
    running: counts.running || 0,
    skipped: counts.skipped || 0,
    complete: steps.length > 0 && (counts.done || 0) + (counts.skipped || 0) === steps.length,
    steps,
  };
}

export function isJobStepDone(jobId, key) {
  ensureJobCheckpointSchema();
  return Boolean(get(`SELECT 1 FROM ${TABLE} WHERE job_id=? AND step_key=? AND status='done'`, text(jobId, 120), stepKey(key)));
}

export function missingJobSteps(jobId, expectedKeys = []) {
  ensureJobCheckpointSchema();
  const done = new Set(all(`SELECT step_key FROM ${TABLE} WHERE job_id=? AND status IN ('done','skipped')`, text(jobId, 120)).map((x) => x.step_key));
  return (Array.isArray(expectedKeys) ? expectedKeys : []).map(stepKey).filter((key) => !done.has(key));
}

export function cleanupJobSteps({ olderThanDays = 30 } = {}) {
  ensureJobCheckpointSchema();
  const days = Math.max(1, Number(olderThanDays) || 30);
  const cutoff = new Date(Date.parse(nowISO()) - days * 86400000).toISOString();
  run(`DELETE FROM ${TABLE} WHERE status IN ('done','skipped') AND updated_at < ?`, cutoff);
  return { ok: true, olderThanDays: days, cutoff };
}

export default {
  ensureJobCheckpointSchema,
  upsertJobStep,
  markJobStepRunning,
  markJobStepDone,
  markJobStepError,
  listJobSteps,
  isJobStepDone,
  missingJobSteps,
  cleanupJobSteps,
};
