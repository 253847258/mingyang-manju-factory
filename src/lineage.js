// 生成血缘（take lineage）：把每次生成的可复现信息完整落库。
// 数据只依赖项目现有的 node:sqlite 封装，不引入第三方依赖。

import { createHash, randomUUID } from 'node:crypto';
import { all, get, run } from './db.js';
import { nowISO } from './util.js';

const TABLE = 'asset_lineage';
const INDEX = 'idx_asset_lineage_take_id';
let schemaReady = false;

const textOf = (value) => (value === null || value === undefined ? '' : String(value));
const optionalText = (value) => (value === null || value === undefined ? null : String(value));

function requiredText(value, field, label) {
  const text = textOf(value);
  if (!text.trim()) throw new Error(`缺少必填字段：${field}（${label}）`);
  return text;
}

function canonicalize(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'bigint') return String(value);
    return value;
  }
  if (typeof value.toJSON === 'function') return canonicalize(value.toJSON(), seen);
  if (seen.has(value)) throw new Error('参数包含循环引用，无法记录生成血缘');
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map((item) => canonicalize(item, seen));
  } else {
    result = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = canonicalize(value[key], seen);
    }
  }
  seen.delete(value);
  return result;
}

function stableJson(value) {
  const json = JSON.stringify(canonicalize(value));
  return json === undefined ? '{}' : json;
}

function paramsText(params) {
  if (params === null || params === undefined) return '{}';
  // 已是 JSON 文本时原样保留；对象按键排序，避免同参因键顺序不同而无法比较。
  return typeof params === 'string' ? params : stableJson(params);
}

/**
 * 幂等创建生成血缘表及 take_id 索引。
 * @returns {boolean} 本次是否新建了表
 */
export function ensureLineageSchema() {
  if (schemaReady) return false;
  const existed = Boolean(get(
    "SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name=?",
    TABLE,
  ));
  run(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    id TEXT PRIMARY KEY,
    take_id TEXT,
    model TEXT,
    model_version TEXT,
    seed TEXT,
    prompt TEXT,
    ref_hash TEXT,
    params TEXT,
    created_at TEXT
  )`);
  run(`CREATE INDEX IF NOT EXISTS ${INDEX} ON ${TABLE}(take_id)`);
  schemaReady = true;
  return !existed;
}

/**
 * 记录一次生成。model 与 prompt 必填；其余字段允许为空，但会按原值保存。
 * @returns {object} 刚写入的血缘记录
 */
export function recordLineage({
  takeId,
  model,
  modelVersion,
  seed,
  prompt,
  refHash,
  params,
} = {}) {
  ensureLineageSchema();
  const normalizedTakeId = requiredText(takeId, 'takeId', '生成片段编号');
  const normalizedModel = requiredText(model, 'model', '生成模型');
  const normalizedPrompt = requiredText(prompt, 'prompt', '完整提示词');
  const id = `LIN-${randomUUID()}`;
  const createdAt = nowISO();

  run(
    `INSERT INTO ${TABLE}
      (id, take_id, model, model_version, seed, prompt, ref_hash, params, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    normalizedTakeId,
    normalizedModel,
    optionalText(modelVersion),
    optionalText(seed),
    normalizedPrompt,
    optionalText(refHash),
    paramsText(params),
    createdAt,
  );

  return get(`SELECT * FROM ${TABLE} WHERE id=?`, id);
}

/** 读取某个 take 最新一次生成血缘；不存在时返回 null。 */
export function getLineage(takeId) {
  ensureLineageSchema();
  const normalizedTakeId = requiredText(takeId, 'takeId', '生成片段编号');
  return get(
    `SELECT * FROM ${TABLE}
     WHERE take_id=?
     ORDER BY created_at DESC, rowid DESC
     LIMIT 1`,
    normalizedTakeId,
  ) || null;
}

/** 按模型筛选生成血缘，默认按时间倒序返回最近 50 条。 */
export function listLineage({ model, limit } = {}) {
  ensureLineageSchema();
  const parsedLimit = Number.parseInt(limit, 10);
  const safeLimit = Number.isFinite(parsedLimit) && parsedLimit > 0
    ? Math.min(parsedLimit, 500)
    : 50;
  const normalizedModel = textOf(model).trim();
  if (normalizedModel) {
    return all(
      `SELECT * FROM ${TABLE}
       WHERE model=?
       ORDER BY created_at DESC, rowid DESC
       LIMIT ?`,
      normalizedModel,
      safeLimit,
    );
  }
  return all(
    `SELECT * FROM ${TABLE}
     ORDER BY created_at DESC, rowid DESC
     LIMIT ?`,
    safeLimit,
  );
}

/**
 * 计算参考图哈希：SHA-256 前 16 位小写十六进制。
 * 字符串按 UTF-8；Buffer/TypedArray/ArrayBuffer 按原始字节；对象按键稳定序列化。
 */
export function hashRef(input) {
  let bytes;
  if (Buffer.isBuffer(input)) {
    bytes = input;
  } else if (ArrayBuffer.isView(input)) {
    bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  } else if (input instanceof ArrayBuffer) {
    bytes = Buffer.from(input);
  } else if (typeof input === 'string') {
    bytes = Buffer.from(input, 'utf8');
  } else {
    bytes = Buffer.from(stableJson(input ?? null), 'utf8');
  }
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}
