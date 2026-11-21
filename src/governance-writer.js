// 生产治理自动回写：成本、血缘、订单、资产快照。
// 幂等键：production_id + stage + job_id；同一次任务不会重复记账。

import { all, get, run } from './db.js';
import { nowISO } from './util.js';
import { recordCost } from './cost-ledger.js';
import { recordLineage } from './lineage.js';
import { freezeSnapshot } from './asset-snapshot.js';
import { createOrder, ensureOrderSchema, upsertEpisode } from './production-order.js';

const TABLE = 'governance_events';
let ready = false;

function text(value, max = 500) { return String(value ?? '').trim().slice(0, max); }
function json(value) { try { return JSON.stringify(value ?? {}); } catch { return '{}'; } }
function safeJson(value, fallback = {}) {
  try { const out = JSON.parse(value || ''); return out && typeof out === 'object' ? out : fallback; }
  catch { return fallback; }
}

export function ensureGovernanceSchema() {
  if (ready) return false;
  const existed = Boolean(get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", TABLE));
  run(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    id TEXT PRIMARY KEY,
    production_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    job_id TEXT,
    status TEXT NOT NULL,
    result TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  run(`CREATE UNIQUE INDEX IF NOT EXISTS ux_governance_event ON ${TABLE}(production_id, stage, COALESCE(job_id, ''))`);
  ready = true;
  return !existed;
}

function eventOf(productionId, stage, jobId) {
  return get(`SELECT * FROM ${TABLE} WHERE production_id=? AND stage=? AND COALESCE(job_id,'')=COALESCE(?,'')`, productionId, stage, jobId || null);
}

function saveEvent({ productionId, stage, jobId, status, result = null, error = '' }) {
  ensureGovernanceSchema();
  const now = nowISO();
  const previous = eventOf(productionId, stage, jobId);
  const id = previous?.id || `GOV-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (previous) {
    run(`UPDATE ${TABLE} SET status=?, result=?, error=?, updated_at=? WHERE id=?`,
      status, result ? json(result) : null, text(error, 1000), now, previous.id);
  } else {
    run(`INSERT INTO ${TABLE}(id,production_id,stage,job_id,status,result,error,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?)`,
    id, productionId, stage, jobId || null, status, result ? json(result) : null, text(error, 1000), now, now);
  }
  return eventOf(productionId, stage, jobId);
}

function ensureOrder(production) {
  ensureOrderSchema();
  let order = get('SELECT * FROM production_orders WHERE project_id=? ORDER BY rowid DESC LIMIT 1', production.id);
  if (!order) order = createOrder({ projectId: production.id, title: production.title || production.brief || production.id, budgetLimit: 0 });
  upsertEpisode({ orderId: order.id, code: 'PRODUCTION', status: production.status || 'writing', shotTotal: 0, shotDone: 0 });
  return order;
}

function assetSnapshotFor(production, artifact, stage) {
  const scriptId = text(artifact.scriptId || artifact.script_id || production.script_id, 120);
  const code = text(artifact.code || artifact.episodeCode || 'PRODUCTION', 80);
  if (!scriptId) return { skipped: true, reason: '阶段产物没有 scriptId' };
  const projectAssets = all('SELECT id FROM assets WHERE project_id=? ORDER BY rowid LIMIT 200', production.id);
  if (!projectAssets.length) return { skipped: true, reason: '项目没有已归属的 V2 资产' };
  try {
    const snapshot = freezeSnapshot({
      scriptId,
      code,
      episodeId: artifact.episodeId || code,
      note: `自动治理快照：${stage}`,
      assets: projectAssets.map((x) => x.id),
    });
    return { snapshotId: snapshot.id, code, assetCount: snapshot.asset_versions.length };
  } catch (error) {
    if (/已冻结|不允许覆盖/.test(error.message)) {
      const existing = get('SELECT * FROM asset_snapshots WHERE script_id=? AND code=? ORDER BY rowid DESC LIMIT 1', scriptId, code);
      return { snapshotId: existing?.id || null, reused: true, reason: error.message };
    }
    throw error;
  }
}

export async function writebackProductionStage({ productionId, stage, jobId = null, actor = 'system' } = {}) {
  ensureGovernanceSchema();
  const id = text(productionId, 120);
  const stageId = text(stage, 60);
  if (!id || !stageId) throw new Error('回写缺少 productionId 或 stage');
  const previous = eventOf(id, stageId, jobId);
  if (previous?.status === 'done') return { ok: true, skipped: true, event: { ...previous, result: safeJson(previous.result, {}) } };

  const { getProduction } = await import('./studio.js');
  const production = getProduction(id);
  if (!production) throw new Error(`制片项目不存在：${id}`);
  const stageRow = (production.stages || []).find((x) => x.stage === stageId || x.id === stageId) || {};
  const stageStatus = String(stageRow.status || '').toLowerCase();
  if (stageStatus !== 'done') {
    return {
      ok: true,
      skipped: true,
      reason: `阶段「${stageId}」当前状态为 ${stageStatus || 'unknown'}，只有已完成阶段才允许治理回写`,
      stage: stageId,
      status: stageStatus || null,
    };
  }
  const artifact = stageRow.artifact || {};
  const estimate = artifact.estimate || artifact.plan?.estimate || {};
  const amount = Number(artifact.actualAmount ?? estimate.amount ?? 0) || 0;
  const episodeId = text(artifact.episodeId || artifact.code || 'PRODUCTION', 120);
  const order = ensureOrder(production);
  const cost = recordCost({
    projectId: id,
    episodeId,
    stage: stageId,
    amount,
    currency: estimate.currency || 'CNY',
    meta: { automatic: true, jobId, unpriced: amount === 0, actor },
  });
  const lineage = recordLineage({
    takeId: `PROD:${id}:${stageId}:${jobId || 'manual'}`,
    model: text(artifact.model || artifact.provider || 'studio', 120),
    modelVersion: text(artifact.modelVersion || artifact.model_version || '', 80),
    seed: text(artifact.seed || '', 80),
    prompt: text(artifact.prompt || production.brief || `制片阶段 ${stageId}`, 4000),
    refHash: text(artifact.refHash || artifact.assetSnapshotId || '', 120),
    params: { stage: stageId, jobId, artifactSummary: { scriptId: artifact.scriptId || null, novelId: artifact.novelId || null, canvasId: artifact.canvasId || null } },
  });
  const snapshot = assetSnapshotFor(production, artifact, stageId);
  const result = { orderId: order.id, costId: cost.id, lineageId: lineage.id, snapshot };
  return { ok: true, event: saveEvent({ productionId: id, stage: stageId, jobId, status: 'done', result }), result };
}

export function listGovernanceEvents({ productionId = null, limit = 100 } = {}) {
  ensureGovernanceSchema();
  const rows = productionId
    ? all(`SELECT * FROM ${TABLE} WHERE production_id=? ORDER BY rowid DESC LIMIT ?`, productionId, Math.max(1, Math.min(500, Number(limit) || 100)))
    : all(`SELECT * FROM ${TABLE} ORDER BY rowid DESC LIMIT ?`, Math.max(1, Math.min(500, Number(limit) || 100)));
  return rows.map((row) => ({ ...row, result: safeJson(row.result, {}) }));
}
