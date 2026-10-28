// 成本台账：按项目 / 集 / 阶段记录调用金额，并提供项目预算检查。

import { randomUUID } from 'node:crypto';
import { db } from './db.js';

const DEFAULT_CURRENCY = 'CNY';
const AMOUNT_SCALE = 1_000_000;

let schemaReady = false;

function textOrNull(value, fieldName, required = false) {
  if (value === null || value === undefined || value === '') {
    if (required) throw new Error(`${fieldName}不能为空`);
    return null;
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error(`${fieldName}格式不正确`);
  }
  const text = String(value).trim();
  if (!text && required) throw new Error(`${fieldName}不能为空`);
  return text || null;
}

function normalizeCurrency(value, required = false) {
  if (value === null || value === undefined || value === '') {
    if (required) throw new Error('币种不能为空');
    return DEFAULT_CURRENCY;
  }
  if (typeof value !== 'string') throw new Error('币种格式不正确');
  const currency = value.trim().toUpperCase();
  if (!currency) throw new Error('币种不能为空');
  return currency;
}

function validMoney(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * AMOUNT_SCALE) / AMOUNT_SCALE;
}

function encodeMeta(meta) {
  if (meta === null || meta === undefined) return null;
  if (typeof meta === 'string') return meta;
  try {
    const encoded = JSON.stringify(meta);
    return encoded === undefined ? null : encoded;
  } catch {
    throw new Error('调用元数据无法序列化');
  }
}

export function ensureCostSchema() {
  if (schemaReady) return { ok: true };

  db.exec(`
    CREATE TABLE IF NOT EXISTS cost_ledger (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      episode_id TEXT,
      stage TEXT NOT NULL,
      amount REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'CNY',
      meta TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cost_ledger_scope
      ON cost_ledger(project_id, episode_id, stage, currency);
  `);

  schemaReady = true;
  return { ok: true };
}

export function recordCost({ projectId, episodeId, stage, amount, currency, meta } = {}) {
  const normalizedProjectId = textOrNull(projectId, '项目 ID', true);
  const normalizedEpisodeId = textOrNull(episodeId, '集 ID');
  const normalizedStage = textOrNull(stage, '阶段', true);
  const normalizedCurrency = normalizeCurrency(currency);
  if (!validMoney(amount)) {
    throw new Error('金额必须是大于等于 0 的有限数字');
  }

  ensureCostSchema();

  const row = {
    id: randomUUID(),
    projectId: normalizedProjectId,
    episodeId: normalizedEpisodeId,
    stage: normalizedStage,
    amount,
    currency: normalizedCurrency,
    meta: encodeMeta(meta),
    createdAt: new Date().toISOString(),
  };

  db.prepare(`
    INSERT INTO cost_ledger
      (id, project_id, episode_id, stage, amount, currency, meta, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id,
    row.projectId,
    row.episodeId,
    row.stage,
    row.amount,
    row.currency,
    row.meta,
    row.createdAt,
  );

  return row;
}

export function sumCost({ projectId, episodeId, stage, currency } = {}) {
  ensureCostSchema();

  const filters = [];
  const params = [];
  const normalizedProjectId = textOrNull(projectId, '项目 ID');
  const normalizedEpisodeId = textOrNull(episodeId, '集 ID');
  const normalizedStage = textOrNull(stage, '阶段');

  if (normalizedProjectId) {
    filters.push('project_id = ?');
    params.push(normalizedProjectId);
  }
  if (normalizedEpisodeId) {
    filters.push('episode_id = ?');
    params.push(normalizedEpisodeId);
  }
  if (normalizedStage) {
    filters.push('stage = ?');
    params.push(normalizedStage);
  }
  if (currency !== null && currency !== undefined && currency !== '') {
    filters.push('currency = ?');
    params.push(normalizeCurrency(currency));
  }

  const where = filters.length ? ` WHERE ${filters.join(' AND ')}` : '';
  const result = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM cost_ledger${where}`).get(...params);
  return roundMoney(Number(result?.total) || 0);
}

export function budgetCheck({ projectId, limit, currency } = {}) {
  const normalizedProjectId = textOrNull(projectId, '项目 ID', true);
  const normalizedCurrency = normalizeCurrency(currency);
  if (!validMoney(limit)) {
    throw new Error('预算上限必须是大于等于 0 的有限数字');
  }

  const spent = sumCost({ projectId: normalizedProjectId, currency: normalizedCurrency });
  const remaining = roundMoney(limit - spent);
  return {
    spent,
    remaining,
    over: spent > limit,
  };
}
