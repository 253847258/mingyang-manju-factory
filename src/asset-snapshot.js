// 集级资产快照：冻结某一集开拍时使用的资产版本，供回放、QC 与追责。
// 保持不变式：快照只增不改；同一剧本同一集只能冻结一次；读取与比较不修改业务数据。

import { randomUUID } from 'node:crypto';
import { all, get, run } from './db.js';
import { ensureAssetSchema, getAsset, getVersion, listAssets } from './assets.js';

const TABLE = 'asset_snapshots';
const REQUIRED_COLUMNS = [
  'id',
  'episode_id',
  'script_id',
  'code',
  'asset_versions',
  'frozen_at',
];

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const textOf = (value) => (value === null || value === undefined ? '' : String(value).trim());

function makeId() {
  return `ASNAP-${randomUUID()}`;
}

function nowISO() {
  return new Date().toISOString();
}

function parseJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function serializeJson(value, label) {
  try {
    const text = JSON.stringify(value);
    if (text === undefined) throw new Error(label);
    return text;
  } catch {
    throw new Error(`${label}无法序列化为 JSON`);
  }
}

function normalizeInput(first, second, third) {
  if (first && typeof first === 'object' && !Array.isArray(first)) {
    return { ...first };
  }
  const scriptId = textOf(first);
  const code = textOf(second);
  const input = third && typeof third === 'object' && !Array.isArray(third) ? { ...third } : {};
  return { ...input, scriptId, code };
}

function normalizeScriptId(input) {
  const scriptId = textOf(input.scriptId ?? input.script_id);
  if (!scriptId) throw new Error('缺少必填字段：script_id（剧本 ID）');
  return scriptId;
}

function normalizeCode(input) {
  const code = textOf(
    input.code
      ?? input.episodeCode
      ?? input.episode_code
      ?? input.episode
      ?? input.episodeId
      ?? input.episode_id,
  );
  if (!code) throw new Error('缺少必填字段：code（剧集编号）');
  return code;
}

function normalizeTakeIds(input) {
  const raw = input.takeIds ?? input.take_ids ?? [];
  const values = Array.isArray(raw) ? raw : [raw];
  const ids = [];
  const seen = new Set();
  for (const item of values) {
    const id = textOf(
      typeof item === 'object' && item !== null
        ? item.takeId ?? item.take_id ?? item.id
        : item,
    );
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function normalizeAssetRefs(input) {
  const raw = input.assetVersions
    ?? input.asset_versions
    ?? input.assets
    ?? input.assetIds
    ?? input.asset_ids;
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) throw new Error('assets/asset_versions 必须是数组');
  return raw;
}

function normalizeAssetRef(item) {
  if (typeof item === 'string' || typeof item === 'number') {
    return { assetId: textOf(item), versionNo: null };
  }
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new Error('资产快照条目必须是资产 ID 或对象');
  }
  const assetId = textOf(item.assetId ?? item.asset_id ?? item.id);
  if (!assetId) throw new Error('资产快照条目缺少 asset_id');
  const rawVersion = item.versionNo ?? item.version_no ?? item.version;
  const versionNo = rawVersion === undefined || rawVersion === null || rawVersion === ''
    ? null
    : Number(rawVersion);
  if (versionNo !== null && (!Number.isInteger(versionNo) || versionNo < 1)) {
    throw new Error(`资产快照版本号非法：${assetId}`);
  }
  return { assetId, versionNo };
}

function freezeItems(input) {
  const refs = normalizeAssetRefs(input);
  const source = refs === null
    ? listAssets().map((asset) => ({ assetId: asset.id, versionNo: null }))
    : refs.map(normalizeAssetRef);

  if (!source.length) return { items: [], assets: [] };

  const deduped = new Map();
  for (const ref of source) {
    if (deduped.has(ref.assetId) && deduped.get(ref.assetId).versionNo !== ref.versionNo) {
      throw new Error(`同一资产不能冻结成多个版本：${ref.assetId}`);
    }
    deduped.set(ref.assetId, ref);
  }

  const items = [];
  for (const ref of deduped.values()) {
    const asset = getAsset(ref.assetId);
    if (!asset) throw new Error(`资产不存在：${ref.assetId}`);
    const versionNo = ref.versionNo ?? Number(asset.current_version);
    const version = getVersion(ref.assetId, versionNo);
    if (!version) throw new Error(`资产版本不存在：${ref.assetId} / v${versionNo}`);
    items.push({
      asset_id: asset.id,
      asset_type: asset.type,
      name: asset.name,
      version_no: version.version_no,
      fingerprint: version.fingerprint ?? null,
      ref_images: parseJson(version.ref_images, []),
      params: parseJson(version.params, {}),
      project_id: asset.project_id ?? null,
      pinned_at: nowISO(),
    });
  }
  return { items, assets: items.map((item) => item.asset_id) };
}

function formatRow(row) {
  if (!row) return null;
  const payload = parseJson(row.asset_versions, null);
  const assetVersions = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.asset_versions)
      ? payload.asset_versions
      : [];
  const assets = Array.isArray(payload?.assets)
    ? payload.assets
    : assetVersions.map((item) => textOf(item?.asset_id ?? item?.assetId)).filter(Boolean);
  const takeIds = Array.isArray(payload?.take_ids)
    ? payload.take_ids
    : Array.isArray(payload?.takeIds)
      ? payload.takeIds
      : [];
  return {
    id: row.id,
    episode_id: row.episode_id,
    episodeId: row.episode_id,
    script_id: row.script_id,
    scriptId: row.script_id,
    code: row.code,
    asset_versions: assetVersions,
    assetVersions,
    assets,
    frozen_at: row.frozen_at,
    frozenAt: row.frozen_at,
    note: textOf(payload?.note),
    take_ids: takeIds,
    takeIds,
    status: 'frozen',
  };
}

function findSnapshot(scriptId, code) {
  return get(
    `SELECT * FROM ${TABLE} WHERE script_id = ? AND code = ? ORDER BY frozen_at DESC, rowid DESC LIMIT 1`,
    scriptId,
    code,
  ) || null;
}

export function ensureSnapshotSchema() {
  ensureAssetSchema();
  const existed = Boolean(get(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    TABLE,
  ));
  run(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    id TEXT PRIMARY KEY,
    episode_id TEXT,
    script_id TEXT NOT NULL,
    code TEXT NOT NULL,
    asset_versions TEXT NOT NULL,
    frozen_at TEXT NOT NULL
  )`);
  run(`CREATE UNIQUE INDEX IF NOT EXISTS ux_asset_snapshots_script_code
    ON ${TABLE}(script_id, code)`);
  const columns = all(`PRAGMA table_info(${TABLE})`).map((column) => column.name);
  const missing = REQUIRED_COLUMNS.filter((column) => !columns.includes(column));
  if (missing.length) throw new Error(`资产快照表结构缺少字段：${missing.join(', ')}`);
  return !existed;
}

export function freezeSnapshot(first, second, third) {
  ensureSnapshotSchema();
  const input = normalizeInput(first, second, third);
  const scriptId = normalizeScriptId(input);
  const code = normalizeCode(input);
  const episodeId = textOf(input.episodeId ?? input.episode_id) || code;
  const note = textOf(input.note ?? input.description);
  const takeIds = normalizeTakeIds(input);
  const { items, assets } = freezeItems(input);

  if (findSnapshot(scriptId, code)) {
    throw new Error(`该集资产快照已冻结，不允许覆盖：${scriptId} / ${code}`);
  }

  const id = makeId();
  const frozenAt = nowISO();
  const payload = { asset_versions: items, assets, note, take_ids: takeIds };
  try {
    run(
      `INSERT INTO ${TABLE} (id, episode_id, script_id, code, asset_versions, frozen_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      episodeId,
      scriptId,
      code,
      serializeJson(payload, '资产快照'),
      frozenAt,
    );
  } catch (error) {
    if (/UNIQUE constraint failed/i.test(String(error?.message))) {
      throw new Error(`该集资产快照已冻结，不允许覆盖：${scriptId} / ${code}`);
    }
    throw error;
  }
  return formatRow(findSnapshot(scriptId, code));
}

export function getSnapshot(first, second) {
  ensureSnapshotSchema();
  const input = normalizeInput(first, second, {});
  const scriptId = normalizeScriptId(input);
  const code = normalizeCode(input);
  return formatRow(findSnapshot(scriptId, code));
}

export function listSnapshots(options = {}) {
  ensureSnapshotSchema();
  const input = options && typeof options === 'object' ? options : {};
  const where = [];
  const args = [];
  const scriptId = textOf(input.scriptId ?? input.script_id);
  const code = textOf(input.code ?? input.episodeCode ?? input.episode_code ?? input.episode);
  const episodeId = textOf(input.episodeId ?? input.episode_id);
  if (scriptId) { where.push('script_id = ?'); args.push(scriptId); }
  if (code) { where.push('code = ?'); args.push(code); }
  if (episodeId) { where.push('episode_id = ?'); args.push(episodeId); }
  const rawLimit = input.limit === undefined ? 50 : Number(input.limit);
  if (!Number.isFinite(rawLimit) || rawLimit < 1) throw new Error('快照列表 limit 必须是正整数');
  const limit = Math.min(500, Math.floor(rawLimit));
  const rows = all(
    `SELECT * FROM ${TABLE}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
     ORDER BY frozen_at DESC, rowid DESC LIMIT ?`,
    ...args,
    limit,
  );
  return rows.map(formatRow);
}

export function compareSnapshot(first, second) {
  const snapshot = getSnapshot(first, second);
  if (!snapshot) throw new Error('资产快照不存在，无法比较');
  const assets = snapshot.asset_versions.map((item) => {
    const assetId = textOf(item.asset_id ?? item.assetId);
    const snapshotVersion = Number(item.version_no ?? item.versionNo);
    const asset = assetId ? getAsset(assetId) : null;
    const currentVersion = Number(asset?.current_version) || null;
    const pinnedVersion = assetId && snapshotVersion
      ? getVersion(assetId, snapshotVersion)
      : null;
    let reason = '';
    if (!assetId) reason = '快照缺少资产 ID';
    else if (!asset) reason = '资产不存在';
    else if (!Number.isInteger(snapshotVersion) || snapshotVersion < 1) reason = '快照版本号非法';
    else if (!pinnedVersion) reason = '快照版本不存在';
    else if (currentVersion !== snapshotVersion) reason = '当前版本已更新';
    return {
      asset_id: assetId || null,
      asset_name: asset?.name || null,
      snapshot_version: Number.isInteger(snapshotVersion) ? snapshotVersion : null,
      current_version: currentVersion,
      drifted: Boolean(reason),
      reason: reason || '一致',
    };
  });
  const drifts = assets.filter((item) => item.drifted);
  return {
    snapshot_id: snapshot.id,
    script_id: snapshot.script_id,
    code: snapshot.code,
    frozen_at: snapshot.frozen_at,
    drifted: drifts.length > 0,
    drift_count: drifts.length,
    assets,
    drifts,
  };
}

export default {
  ensureSnapshotSchema,
  freezeSnapshot,
  getSnapshot,
  listSnapshots,
  compareSnapshot,
};
