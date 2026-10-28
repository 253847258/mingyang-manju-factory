// 生产订单：project -> episode -> shot 的宏观状态聚合。
// 集级 shot_total / shot_done 由上游回写，本模块只负责订单落库与摘要聚合。
import { randomUUID } from 'node:crypto';
import { all, get, run } from './db.js';
import { nowISO } from './util.js';

const COMPLETED_STATUSES = new Set(['done', 'completed', 'complete', 'finished', 'delivered', '已完成']);
const BLOCKED_STATUSES = new Set(['blocked', '阻塞', '已阻塞']);

let schemaReady = false;

function orderId() {
  return `PO-${randomUUID()}`;
}

function episodeId() {
  return `EP-${randomUUID()}`;
}

function hydrateOrder(row) {
  if (!row) return null;
  return {
    ...row,
    projectId: row.project_id,
    budgetLimit: Number(row.budget_limit),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function hydrateEpisode(row) {
  if (!row) return null;
  return {
    ...row,
    orderId: row.order_id,
    shotTotal: Number(row.shot_total),
    shotDone: Number(row.shot_done),
    updatedAt: row.updated_at,
  };
}

function requireText(value, message) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new Error(message);
  return text;
}

function normalizeBudget(value) {
  if (value === undefined || value === null || value === '') return 0;
  const budget = Number(value);
  if (!Number.isFinite(budget) || budget < 0) {
    throw new Error('订单预算必须是大于或等于 0 的数字');
  }
  return budget;
}

function normalizeShotCount(value, fieldName) {
  if (value === undefined || value === null || value === '') return 0;
  const count = Number(value);
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`${fieldName}必须是非负整数`);
  }
  return count;
}

function normalizedStatus(value, fallback) {
  const status = typeof value === 'string' ? value.trim() : '';
  return status || fallback;
}

export function ensureOrderSchema() {
  if (schemaReady) return;
  run(`CREATE TABLE IF NOT EXISTS production_orders (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    budget_limit REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  run(`CREATE TABLE IF NOT EXISTS production_order_episodes (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    code TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    shot_total INTEGER NOT NULL DEFAULT 0,
    shot_done INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (order_id) REFERENCES production_orders(id) ON DELETE CASCADE
  )`);
  run('CREATE INDEX IF NOT EXISTS ix_production_orders_project ON production_orders(project_id)');
  run('CREATE INDEX IF NOT EXISTS ix_production_orders_updated ON production_orders(updated_at DESC)');
  run('CREATE INDEX IF NOT EXISTS ix_production_order_episodes_order ON production_order_episodes(order_id)');
  run('CREATE UNIQUE INDEX IF NOT EXISTS ux_production_order_episode_code ON production_order_episodes(order_id, code)');
  schemaReady = true;
}

export function createOrder({ projectId, title, budgetLimit } = {}) {
  ensureOrderSchema();
  const normalizedProjectId = requireText(projectId, '项目 ID 不能为空');
  const normalizedTitle = requireText(title, '订单标题不能为空');
  const budget = normalizeBudget(budgetLimit);
  const id = orderId();
  const now = nowISO();
  run(
    `INSERT INTO production_orders(id, project_id, title, status, budget_limit, created_at, updated_at)
     VALUES(?, ?, ?, 'draft', ?, ?, ?)`,
    id,
    normalizedProjectId,
    normalizedTitle,
    budget,
    now,
    now,
  );
  return getOrder(id);
}

export function listOrders() {
  ensureOrderSchema();
  return all(
    `SELECT * FROM production_orders
     ORDER BY updated_at DESC, created_at DESC, id DESC`,
  ).map(hydrateOrder);
}

export function getOrder(id) {
  ensureOrderSchema();
  const normalizedId = requireText(id, '订单 ID 不能为空');
  const row = get('SELECT * FROM production_orders WHERE id = ?', normalizedId);
  if (!row) throw new Error(`订单不存在：${normalizedId}`);
  return hydrateOrder(row);
}

export function upsertEpisode({ orderId: targetOrderId, code, status, shotTotal, shotDone } = {}) {
  ensureOrderSchema();
  const order = getOrder(targetOrderId);
  const normalizedCode = requireText(code, '集编号不能为空');
  const normalizedShotTotal = normalizeShotCount(shotTotal, '镜头总数');
  const normalizedShotDone = normalizeShotCount(shotDone, '已完成镜头数');
  if (normalizedShotDone > normalizedShotTotal) {
    throw new Error('已完成镜头数不能大于镜头总数');
  }

  const now = nowISO();
  run(
    `INSERT INTO production_order_episodes(id, order_id, code, status, shot_total, shot_done, updated_at)
     VALUES(?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(order_id, code) DO UPDATE SET
       status = excluded.status,
       shot_total = excluded.shot_total,
       shot_done = excluded.shot_done,
       updated_at = excluded.updated_at`,
    episodeId(),
    order.id,
    normalizedCode,
    normalizedStatus(status, 'pending'),
    normalizedShotTotal,
    normalizedShotDone,
    now,
  );
  run('UPDATE production_orders SET updated_at = ? WHERE id = ?', now, order.id);
  return hydrateEpisode(
    get('SELECT * FROM production_order_episodes WHERE order_id = ? AND code = ?', order.id, normalizedCode),
  );
}

export function orderSummary(id) {
  ensureOrderSchema();
  const order = getOrder(id);
  const episodes = all(
    `SELECT * FROM production_order_episodes
     WHERE order_id = ?
     ORDER BY code ASC`,
    order.id,
  ).map(hydrateEpisode);

  const shotTotal = episodes.reduce((sum, episode) => sum + episode.shotTotal, 0);
  const shotDone = episodes.reduce((sum, episode) => sum + episode.shotDone, 0);
  const completedCount = episodes.filter((episode) => COMPLETED_STATUSES.has(String(episode.status).toLowerCase())).length;
  const blockedRows = episodes.filter((episode) => BLOCKED_STATUSES.has(String(episode.status).toLowerCase()));
  const rate = shotTotal > 0 ? shotDone / shotTotal : 0;

  return {
    orderId: order.id,
    projectId: order.project_id,
    title: order.title,
    status: order.status,
    episodes: episodes.length,
    episodeCount: episodes.length,
    completed: completedCount,
    completedCount,
    completedEpisodes: completedCount,
    shotTotal,
    shotDone,
    shotCompletionRate: rate,
    shotDonePct: Number((rate * 100).toFixed(1)),
    blocked: blockedRows.length,
    blockedCount: blockedRows.length,
    blockedEpisodes: blockedRows.length,
    blockedCodes: blockedRows.map((episode) => episode.code),
    blockedEpisodeCodes: blockedRows.map((episode) => episode.code),
  };
}
