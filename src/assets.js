import { createHash, randomUUID } from 'node:crypto';
import { all, get, run } from './db.js';
import { nowISO } from './util.js';

// 角色、场景、道具、服装四类资产。character 作为 role 的兼容别名接收。
export const ASSET_TYPES = Object.freeze(['role', 'scene', 'prop', 'costume']);
const TYPE_ALIASES = new Map([
  ['role', 'role'],
  ['character', 'character'],
  ['scene', 'scene'],
  ['prop', 'prop'],
  ['costume', 'costume'],
  ['角色', 'role'],
  ['人物', 'character'],
  ['场景', 'scene'],
  ['道具', 'prop'],
  ['服装', 'costume'],
]);

const ASSET_COLUMNS = [
  'id',
  'project_id',
  'type',
  'name',
  'description',
  'current_version',
  'params',
  'created_at',
  'updated_at',
];
const VERSION_COLUMNS = [
  'id',
  'asset_id',
  'version_no',
  'ref_images',
  'fingerprint',
  'params',
  'created_at',
];

function normalizeType(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  const type = TYPE_ALIASES.get(raw);
  if (!type) {
    throw new Error('非法资产类型：仅支持 role（character）、scene、prop、costume');
  }
  return type;
}

function normalizeName(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('资产名称不能为空');
  }
  return value.trim();
}

function normalizeProjectId(value) {
  if (value === undefined || value === null) return null;
  const projectId = String(value).trim();
  return projectId || null;
}

function normalizeDescription(value) {
  if (value === undefined || value === null) return '';
  return String(value);
}

function serializeJson(value, label, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'string') {
    try {
      JSON.parse(value);
      return value;
    } catch {
      throw new Error(`${label}必须是合法 JSON`);
    }
  }
  try {
    const text = JSON.stringify(value);
    if (text === undefined) throw new Error('undefined');
    return text;
  } catch {
    throw new Error(`${label}无法序列化为 JSON`);
  }
}

function normalizeRefImages(value) {
  if (value === undefined || value === null || value === '') return '[]';
  if (typeof value === 'string') {
    let parsed;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error('参考图必须是合法 JSON 数组');
    }
    if (!Array.isArray(parsed)) throw new Error('参考图必须是 JSON 数组');
    return JSON.stringify(parsed);
  }
  if (!Array.isArray(value)) throw new Error('参考图必须是数组');
  return JSON.stringify(value);
}

function normalizeFingerprint(value) {
  if (value === undefined || value === null || value === '') return null;
  return String(value);
}

function fingerprintFor({ name, description, params, refImages }) {
  return createHash('sha256')
    .update(JSON.stringify({ name, description, params, ref_images: refImages }))
    .digest('hex');
}

function makeId(prefix) {
  return `${prefix}-${randomUUID()}`;
}

function transaction(work) {
  run('BEGIN IMMEDIATE');
  try {
    const result = work();
    run('COMMIT');
    return result;
  } catch (error) {
    try {
      run('ROLLBACK');
    } catch {
      // 保留原始错误，避免回滚失败覆盖根因。
    }
    throw error;
  }
}

function findAsset(id) {
  const assetId = String(id ?? '').trim();
  if (!assetId) return null;
  return get('SELECT * FROM assets WHERE id = ?', assetId) || null;
}

function requireAsset(id) {
  const asset = findAsset(id);
  if (!asset) throw new Error(`资产不存在：${String(id ?? '').trim() || '空 ID'}`);
  return asset;
}

function findVersion(assetId, versionNo) {
  const no = Number(versionNo);
  if (!Number.isInteger(no) || no < 1) return null;
  return get(
    'SELECT * FROM asset_versions WHERE asset_id = ? AND version_no = ?',
    String(assetId ?? '').trim(),
    no,
  ) || null;
}

function assertTableColumns(table, expected) {
  const actual = all(`PRAGMA table_info(${table})`).map((column) => column.name);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`资产表结构不符合契约：${table}`);
  }
}

export function ensureAssetSchema() {
  run(`CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    type TEXT,
    name TEXT,
    description TEXT,
    current_version INTEGER DEFAULT 1,
    params TEXT,
    created_at TEXT,
    updated_at TEXT
  )`);
  run(`CREATE TABLE IF NOT EXISTS asset_versions (
    id TEXT PRIMARY KEY,
    asset_id TEXT,
    version_no INTEGER,
    ref_images TEXT,
    fingerprint TEXT,
    params TEXT,
    created_at TEXT
  )`);
  run('CREATE UNIQUE INDEX IF NOT EXISTS ux_asset_versions_asset_version ON asset_versions(asset_id, version_no)');
  run(`CREATE TRIGGER IF NOT EXISTS asset_versions_no_update
    BEFORE UPDATE ON asset_versions
    BEGIN
      SELECT RAISE(ABORT, '资产版本只允许新增，不允许修改');
    END`);
  assertTableColumns('assets', ASSET_COLUMNS);
  assertTableColumns('asset_versions', VERSION_COLUMNS);
}

export function listAssets(options = {}) {
  ensureAssetSchema();
  const { type, projectId } = options || {};
  const where = [];
  const args = [];

  if (type !== undefined && type !== null && String(type).trim() !== '') {
    where.push('type = ?');
    args.push(normalizeType(type));
  }
  if (projectId !== undefined && projectId !== null && String(projectId).trim() !== '') {
    where.push('project_id = ?');
    args.push(String(projectId).trim());
  }

  const sql = `SELECT * FROM assets${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY rowid ASC`;
  return all(sql, ...args);
}

export function getAsset(id) {
  ensureAssetSchema();
  return findAsset(id);
}

export function createAsset({
  type,
  name,
  description = '',
  projectId = null,
  params = {},
  refImages = [],
  fingerprint,
} = {}) {
  ensureAssetSchema();
  const normalizedType = normalizeType(type);
  const assetName = normalizeName(name);
  const assetDescription = normalizeDescription(description);
  const project = normalizeProjectId(projectId);
  const paramsText = serializeJson(params, '资产参数', '{}');
  const refImagesText = normalizeRefImages(refImages);
  const fingerprintText = normalizeFingerprint(fingerprint)
    || fingerprintFor({
      name: assetName,
      description: assetDescription,
      params: paramsText,
      refImages: refImagesText,
    });
  const id = makeId('AST');
  const versionId = makeId('AV');
  const now = nowISO();

  return transaction(() => {
    run(
      `INSERT INTO assets
       (id, project_id, type, name, description, current_version, params, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      project,
      normalizedType,
      assetName,
      assetDescription,
      1,
      paramsText,
      now,
      now,
    );
    run(
      `INSERT INTO asset_versions
       (id, asset_id, version_no, ref_images, fingerprint, params, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      versionId,
      id,
      1,
      refImagesText,
      fingerprintText,
      paramsText,
      now,
    );
    return findAsset(id);
  });
}

export function updateAsset(id, patch = {}) {
  ensureAssetSchema();
  const assetId = String(id ?? '').trim();
  if (!assetId) throw new Error('资产 ID 不能为空');
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('资产更新内容必须是对象');
  }

  const allowedFields = new Set([
    'name',
    'description',
    'params',
    'refImages',
    'ref_images',
    'fingerprint',
    'projectId',
    'project_id',
  ]);
  const unknownFields = Object.keys(patch).filter((key) => !allowedFields.has(key));
  if (unknownFields.length) {
    throw new Error(`不支持的资产更新字段：${unknownFields.join('、')}`);
  }

  return transaction(() => {
    const asset = requireAsset(assetId);
    const currentVersion = findVersion(assetId, asset.current_version);
    const latestVersion = get(
      'SELECT MAX(version_no) AS max_version FROM asset_versions WHERE asset_id = ?',
      assetId,
    );
    const nextVersionNo = Number(latestVersion?.max_version || asset.current_version || 0) + 1;
    const nextName = Object.hasOwn(patch, 'name')
      ? normalizeName(patch.name)
      : asset.name;
    const nextDescription = Object.hasOwn(patch, 'description')
      ? normalizeDescription(patch.description)
      : (asset.description || '');
    const nextProjectId = Object.hasOwn(patch, 'projectId') || Object.hasOwn(patch, 'project_id')
      ? normalizeProjectId(Object.hasOwn(patch, 'projectId') ? patch.projectId : patch.project_id)
      : asset.project_id;
    const nextParams = Object.hasOwn(patch, 'params')
      ? serializeJson(patch.params, '资产参数', '{}')
      : (currentVersion?.params || asset.params || '{}');
    const nextRefImages = Object.hasOwn(patch, 'refImages') || Object.hasOwn(patch, 'ref_images')
      ? normalizeRefImages(Object.hasOwn(patch, 'refImages') ? patch.refImages : patch.ref_images)
      : (currentVersion?.ref_images || '[]');
    const nextFingerprint = normalizeFingerprint(patch.fingerprint)
      || fingerprintFor({
        name: nextName,
        description: nextDescription,
        params: nextParams,
        refImages: nextRefImages,
      });
    const now = nowISO();

    run(
      `INSERT INTO asset_versions
       (id, asset_id, version_no, ref_images, fingerprint, params, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      makeId('AV'),
      assetId,
      nextVersionNo,
      nextRefImages,
      nextFingerprint,
      nextParams,
      now,
    );
    run(
      `UPDATE assets
       SET name = ?, description = ?, project_id = ?, params = ?, current_version = ?, updated_at = ?
       WHERE id = ?`,
      nextName,
      nextDescription,
      nextProjectId,
      nextParams,
      nextVersionNo,
      now,
      assetId,
    );
    return findAsset(assetId);
  });
}

export function listVersions(assetId) {
  ensureAssetSchema();
  const id = String(assetId ?? '').trim();
  if (!id) return [];
  return all(
    'SELECT * FROM asset_versions WHERE asset_id = ? ORDER BY version_no ASC',
    id,
  );
}

export function getVersion(assetId, versionNo) {
  ensureAssetSchema();
  const id = String(assetId ?? '').trim();
  if (!id) return null;
  return findVersion(id, versionNo);
}

export function setCurrentVersion(assetId, versionNo) {
  ensureAssetSchema();
  const id = String(assetId ?? '').trim();
  if (!id) throw new Error('资产 ID 不能为空');
  const no = Number(versionNo);
  if (!Number.isInteger(no) || no < 1) throw new Error('资产版本号必须是正整数');

  return transaction(() => {
    requireAsset(id);
    const version = findVersion(id, no);
    if (!version) throw new Error(`资产版本不存在：${no}`);
    run(
      'UPDATE assets SET current_version = ?, updated_at = ? WHERE id = ?',
      no,
      nowISO(),
      id,
    );
    return findAsset(id);
  });
}
