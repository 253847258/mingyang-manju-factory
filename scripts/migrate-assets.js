#!/usr/bin/env node
// 存量资产迁移：actors + canvas_nodes -> V2 assets
// 默认 dry-run；只有显式传 --apply 才会 ensure schema 并写库。

import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TYPE_LABELS = {
  character: '角色',
  scene: '场景',
  prop: '道具',
  costume: '服装',
};

const DIRECT_KIND_TYPES = new Map([
  ['actor', 'actor'],
  ['character', 'actor'],
  ['scene', 'scene'],
  ['scenery', 'scene'],
  ['environment', 'scene'],
  ['background', 'scene'],
  ['场景', 'scene'],
  ['环境', 'scene'],
  ['地点', 'scene'],
  ['背景', 'scene'],
  ['prop', 'prop'],
  ['item', 'prop'],
  ['object', 'prop'],
  ['道具', 'prop'],
  ['物品', 'prop'],
  ['costume', 'costume'],
  ['wardrobe', 'costume'],
  ['outfit', 'costume'],
  ['clothing', 'costume'],
  ['服装', 'costume'],
  ['服饰', 'costume'],
  ['戏服', 'costume'],
  ['造型', 'costume'],
]);

const KEYWORD_RULES = [
  { type: 'prop', terms: ['prop', 'item', 'object', '道具', '物品'] },
  { type: 'costume', terms: ['costume', 'wardrobe', 'outfit', 'clothing', '服装', '服饰', '戏服', '造型'] },
  { type: 'scene', terms: ['scene', 'scenery', 'environment', 'background', '场景', '环境', '地点', '背景'] },
];

function text(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function normalizeKind(value) {
  return text(value).toLowerCase().replace(/[\s_-]+/g, '');
}

function firstText(...values) {
  for (const value of values) {
    const found = text(value);
    if (found) return found;
  }
  return '';
}

function parseJsonObject(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function containsTerm(haystack, term) {
  const source = text(haystack).toLowerCase();
  const needle = text(term).toLowerCase();
  if (!source || !needle) return false;
  if (/^[a-z0-9]+$/i.test(needle)) {
    return new RegExp(`(^|[^a-z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i').test(source);
  }
  return source.includes(needle);
}

export function classifyCanvasNode(node = {}) {
  const kind = normalizeKind(node.kind);
  if (kind && DIRECT_KIND_TYPES.has(kind)) {
    const direct = DIRECT_KIND_TYPES.get(kind);
    return direct === 'actor' ? null : direct;
  }

  let bestType = null;
  let bestScore = 0;
  for (const rule of KEYWORD_RULES) {
    let score = 0;
    for (const term of rule.terms) {
      if (containsTerm(node.kind, term)) score += 8;
      if (containsTerm(node.title, term)) score += 4;
      if (containsTerm(node.note, term)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      bestType = rule.type;
    }
  }
  return bestType;
}

export function mapActorToAsset(actor = {}) {
  const name = text(actor.name);
  if (!name) return null;
  const description = firstText(
    actor.desc,
    actor.description,
    actor.summary,
    [actor.personality, actor.background].map(text).filter(Boolean).join('；'),
  );
  return {
    type: 'character',
    name,
    description,
    params: {
      source_table: 'actors',
      source_id: text(actor.id),
      legacy_id: text(actor.id),
      actor: { ...actor },
    },
  };
}

export function mapCanvasNodeToAsset(node = {}, type = classifyCanvasNode(node)) {
  if (!type) return null;
  const data = parseJsonObject(node.data);
  const noteName = text(node.note).split(/\r?\n/, 1)[0].slice(0, 80);
  const name = firstText(
    node.title,
    data?.title,
    data?.name,
    noteName,
    node.id ? `${TYPE_LABELS[type]}-${node.id}` : '',
  );
  if (!name) return null;
  const description = firstText(node.note, data?.desc, data?.description, data?.prompt);
  const params = {
    source_table: 'canvas_nodes',
    source_id: text(node.id),
    canvas_id: text(node.canvas_id),
    node_kind: text(node.kind),
    title: text(node.title),
    note: text(node.note),
    geometry: {
      x: node.x ?? null,
      y: node.y ?? null,
      w: node.w ?? null,
      h: node.h ?? null,
      z: node.z ?? null,
      locked: node.locked ?? null,
    },
    data,
  };
  if (data === null && text(node.data)) params.raw_data = text(node.data);
  return {
    type,
    name,
    description,
    params,
  };
}

export function parseArgs(argv = process.argv.slice(2)) {
  let apply = false;
  let explicitDryRun = false;
  let help = false;
  for (const arg of argv) {
    if (arg === '--apply') apply = true;
    else if (arg === '--dry-run') explicitDryRun = true;
    else if (arg === '--help' || arg === '-h') help = true;
    else throw new Error(`未知参数：${arg}。仅支持 --dry-run 或 --apply。`);
  }
  if (apply && explicitDryRun) throw new Error('--dry-run 与 --apply 不能同时使用。');
  return { apply, help };
}

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function dbAll(db, sql, ...params) {
  if (!db?.prepare) throw new Error('数据库对象不可用，请通过工厂数据库运行迁移。');
  return Array.from(db.prepare(sql).all(...params));
}

function dbGet(db, sql, ...params) {
  if (!db?.prepare) throw new Error('数据库对象不可用，请通过工厂数据库运行迁移。');
  return db.prepare(sql).get(...params);
}

function dbExec(db, sql) {
  if (typeof db?.exec !== 'function') throw new Error('数据库对象不支持执行建表语句。');
  db.exec(sql);
}

function tableExists(db, table) {
  return Boolean(dbGet(db, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", table));
}

function tableColumns(db, table) {
  return dbAll(db, `PRAGMA table_info(${quoteIdent(table)})`).map((row) => text(row.name));
}

function readSourceRows(db, table) {
  try {
    if (!tableExists(db, table)) throw new Error(`数据表 ${table} 不存在`);
    return dbAll(db, `SELECT * FROM ${quoteIdent(table)} ORDER BY rowid ASC`);
  } catch (error) {
    throw new Error(`读取 ${table} 失败：${error.message}`);
  }
}

function existingAssetRows(db) {
  if (!tableExists(db, 'assets')) return [];
  const columns = tableColumns(db, 'assets');
  const typeColumn = columns.includes('type') ? 'type' : (columns.includes('asset_type') ? 'asset_type' : '');
  const nameColumn = columns.includes('name') ? 'name' : '';
  if (!typeColumn || !nameColumn) {
    throw new Error('assets 表缺少 type/name 字段，无法按 type+name 幂等迁移。');
  }
  return dbAll(db, 'SELECT * FROM assets').map((row) => ({
    id: row.id,
    type: text(row[typeColumn]),
    name: text(row[nameColumn]),
  }));
}

function assetKey(type, name) {
  return `${text(type).toLowerCase()}\u0000${text(name).toLowerCase()}`;
}

function makeCandidate(asset, source) {
  const type = text(asset?.type).toLowerCase();
  const name = text(asset?.name);
  if (!TYPE_LABELS[type] || !name) return null;
  return { ...asset, type, name, source };
}

function emptyTypeReport() {
  return Object.fromEntries(Object.keys(TYPE_LABELS).map((type) => [type, {
    toCreate: 0,
    created: 0,
    skippedExisting: 0,
    skippedDuplicate: 0,
  }]));
}

export async function migrateAssets({ db, assets = null, apply = false } = {}) {
  if (!db) throw new Error('缺少数据库对象，无法执行资产迁移。');
  if (apply && !assets) throw new Error('缺少资产接口，无法执行资产迁移。');
  if (apply) {
    for (const name of ['ensureAssetSchema', 'createAsset', 'updateAsset']) {
      if (typeof assets[name] !== 'function') {
        throw new Error(`资产接口缺少 ${name}()，请先提供 src/assets.js。`);
      }
    }
    try {
      await assets.ensureAssetSchema(db);
    } catch (error) {
      throw new Error(`初始化资产表失败：${error.message}`);
    }
    if (!tableExists(db, 'assets')) throw new Error('资产表初始化后仍不存在，已停止迁移。');
  }

  let existingRows;
  try {
    existingRows = existingAssetRows(db);
  } catch (error) {
    throw new Error(`读取存量资产失败：${error.message}`);
  }

  const actors = readSourceRows(db, 'actors');
  const nodes = readSourceRows(db, 'canvas_nodes');
  const report = {
    mode: apply ? 'apply' : 'dry-run',
    actorsRead: actors.length,
    canvasNodesRead: nodes.length,
    toCreate: 0,
    created: 0,
    skipped: 0,
    skippedExisting: 0,
    skippedDuplicate: 0,
    skippedUnrecognized: 0,
    skippedInvalid: 0,
    byType: emptyTypeReport(),
  };

  const existing = new Set(existingRows.map((row) => assetKey(row.type, row.name)));
  const seenInSource = new Set();
  const candidates = [];
  const addCandidate = (asset, source) => {
    const candidate = makeCandidate(asset, source);
    if (!candidate) {
      report.skippedInvalid += 1;
      return;
    }
    const key = assetKey(candidate.type, candidate.name);
    if (existing.has(key)) {
      report.skippedExisting += 1;
      report.byType[candidate.type].skippedExisting += 1;
      return;
    }
    if (seenInSource.has(key)) {
      report.skippedDuplicate += 1;
      report.byType[candidate.type].skippedDuplicate += 1;
      return;
    }
    seenInSource.add(key);
    candidates.push(candidate);
    report.byType[candidate.type].toCreate += 1;
  };

  for (const actor of actors) addCandidate(mapActorToAsset(actor), { table: 'actors', id: text(actor.id) });
  for (const node of nodes) {
    const type = classifyCanvasNode(node);
    if (!type) {
      report.skippedUnrecognized += 1;
      continue;
    }
    addCandidate(mapCanvasNodeToAsset(node, type), { table: 'canvas_nodes', id: text(node.id) });
  }

  report.toCreate = candidates.length;

  if (apply) {
    for (const candidate of candidates) {
      const payload = {
        type: candidate.type,
        name: candidate.name,
        description: candidate.description,
        params: candidate.params,
      };
      try {
        await assets.createAsset(payload);
        report.created += 1;
        report.byType[candidate.type].created += 1;
      } catch (error) {
        throw new Error(`创建资产失败（${candidate.type}/${candidate.name}）：${error.message}`);
      }
    }
  }

  report.skipped = report.skippedExisting
    + report.skippedDuplicate
    + report.skippedUnrecognized
    + report.skippedInvalid;
  return report;
}

function printReport(report) {
  console.log(`[资产迁移] 模式：${report.mode}${report.mode === 'dry-run' ? '（不写库）' : ''}`);
  console.log(`[资产迁移] 读取：演员 ${report.actorsRead} 条｜画布节点 ${report.canvasNodesRead} 条`);
  const createCount = report.mode === 'apply' ? report.created : report.toCreate;
  console.log(`[资产迁移] ${report.mode === 'apply' ? '已创建' : '将创建'}：${createCount}｜跳过：${report.skipped}`);
  console.log(`[资产迁移] 跳过明细：已存在 ${report.skippedExisting}｜同批重复 ${report.skippedDuplicate}｜无法识别 ${report.skippedUnrecognized}｜缺少名称 ${report.skippedInvalid}`);
  for (const [type, item] of Object.entries(report.byType)) {
    const count = report.mode === 'apply' ? item.created : item.toCreate;
    console.log(`[资产迁移] ${TYPE_LABELS[type]}（${type}）：${count}`);
  }
  if (report.mode === 'apply') {
    console.log('[资产迁移] apply 完成：结果已写入 assets 表。');
  } else {
    console.log('[资产迁移] dry-run 完成：未写入数据库；确认后请加 --apply。');
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log('用法：node scripts/migrate-assets.js [--dry-run|--apply]');
    console.log('默认 dry-run；只有 --apply 会写入 assets 表。');
    return null;
  }

  let db;
  let assets = null;
  try {
    db = (await import('../src/db.js')).db;
    if (options.apply) assets = await import('../src/assets.js');
  } catch (error) {
    throw new Error(`加载${options.apply ? '数据库或资产' : '数据库'}模块失败：${error.message}`);
  }

  const report = await migrateAssets({ db, assets, apply: options.apply });
  printReport(report);
  return report;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath && import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(`[资产迁移] 失败：${error.message}`);
    process.exitCode = 1;
  });
}
