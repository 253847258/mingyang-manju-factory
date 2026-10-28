#!/usr/bin/env node
// 资产一致性 QC：核对某集资产快照中的版本与当前资产版本，并检查 take 生成血缘。
// 只读业务数据，不创建表、不修改资产或血缘。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { all, get } from '../src/db.js';
import { getAsset, getVersion } from '../src/assets.js';
import { getLineage } from '../src/lineage.js';

const SELF_FILE = fileURLToPath(import.meta.url);
const ASSET_SNAPSHOT_FILE = fileURLToPath(new URL('../src/asset-snapshot.js', import.meta.url));
const USAGE = `用法：
  node scripts/qc-assets.js --script SC-xxx --episode S01E001 [--json] [--out docs/qc-assets-xxx.md]

参数：
  --script    剧本 ID
  --episode   剧集编码，例如 S01E001
  --json      在标准输出打印机器可读 JSON
  --out       将中文 Markdown 报告写入指定文件
  --help      显示帮助`;

class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

function readOptionValue(argv, index, name) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new CliError(`${name} 缺少参数值`, 2);
  return value;
}

export function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };

  const options = { script: '', episode: '', json: false, out: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--script') {
      options.script = readOptionValue(argv, i, '--script').trim();
      i += 1;
    } else if (arg.startsWith('--script=')) {
      options.script = arg.slice('--script='.length).trim();
    } else if (arg === '--episode') {
      options.episode = readOptionValue(argv, i, '--episode').trim();
      i += 1;
    } else if (arg.startsWith('--episode=')) {
      options.episode = arg.slice('--episode='.length).trim();
    } else if (arg === '--out') {
      options.out = readOptionValue(argv, i, '--out');
      i += 1;
    } else if (arg.startsWith('--out=')) {
      options.out = arg.slice('--out='.length).trim();
    } else if (arg === '--json') {
      options.json = true;
    } else {
      throw new CliError(`未知参数：${arg}`, 2);
    }
  }

  if (!options.script) throw new CliError('必须指定 --script', 2);
  if (!options.episode) throw new CliError('必须指定 --episode', 2);
  if (!options.out && argv.some((arg) => arg === '--out=')) {
    throw new CliError('--out 缺少参数值', 2);
  }
  return options;
}

function safeJson(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function hasAssetVersions(value) {
  return Array.isArray(value?.asset_versions) || Array.isArray(value?.assetVersions);
}

function snapshotFromDb(scriptId, episodeCode) {
  const table = get(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'script_snapshots'",
  );
  if (!table) return null;

  const rows = all(
    `SELECT * FROM script_snapshots
     WHERE script_id = ? AND episode_code = ?
     ORDER BY version DESC, created_at DESC, rowid DESC
     LIMIT 50`,
    scriptId,
    episodeCode,
  );

  for (const row of rows) {
    const payload = safeJson(row.payload);
    const candidates = [payload, payload?.snapshot, payload?.payload];
    for (const candidate of candidates) {
      if (!hasAssetVersions(candidate)) continue;
      return {
        ...candidate,
        snapshot_meta: {
          id: row.id || null,
          kind: row.kind || null,
          version: row.version ?? null,
          created_at: row.created_at || null,
          source: 'script_snapshots',
        },
      };
    }
  }
  return null;
}

export async function loadSnapshot(scriptId, episodeCode) {
  if (fs.existsSync(ASSET_SNAPSHOT_FILE)) {
    let module;
    try {
      module = await import(pathToFileURL(ASSET_SNAPSHOT_FILE).href);
    } catch (error) {
      throw new CliError(`资产快照模块加载失败：${error.message}`, 1);
    }
    const getSnapshot = module.getSnapshot || module.default?.getSnapshot;
    if (typeof getSnapshot !== 'function') {
      throw new CliError('资产快照模块未导出 getSnapshot 函数', 1);
    }
    let result;
    try {
      result = await getSnapshot(scriptId, episodeCode);
    } catch (error) {
      throw new CliError(`读取资产快照失败：${error.message || error}`, 1);
    }
    if (result?.snapshot && hasAssetVersions(result.snapshot)) {
      return {
        ...result.snapshot,
        snapshot_meta: {
          id: result.id || result.snapshot.id || null,
          kind: result.kind || result.snapshot.kind || null,
          version: result.version ?? result.snapshot.version ?? null,
          source: 'asset-snapshot',
        },
      };
    }
    if (hasAssetVersions(result)) {
      return {
        ...result,
        snapshot_meta: {
          id: result.id || result.snapshot_id || null,
          kind: result.kind || 'asset',
          version: result.version ?? null,
          created_at: result.frozen_at ?? result.frozenAt ?? null,
          source: 'asset-snapshot',
        },
      };
    }
    // 新资产快照没有命中时，继续兼容旧 script_snapshots 中的资产基线，
    // 避免升级后历史项目突然失去 QC 能力。
    return snapshotFromDb(scriptId, episodeCode);
  }

  // 资产快照模块尚未生成时，兼容已有分集快照表中
  // payload 带 asset_versions 的资产快照记录；不依赖真实业务库。
  return snapshotFromDb(scriptId, episodeCode);
}

function versionNo(value) {
  const no = Number(value);
  return Number.isInteger(no) && no > 0 ? no : null;
}

function addTakeId(target, value) {
  if (value === null || value === undefined) return;
  if (typeof value === 'string' || typeof value === 'number') {
    const id = String(value).trim();
    if (id) target.add(id);
    return;
  }
  if (typeof value !== 'object') return;
  addTakeId(target, value.take_id ?? value.takeId ?? value.id);
}

function takeIdsFromSnapshot(snapshot) {
  const ids = new Set();
  const keys = [
    'take_ids',
    'takeIds',
    'generation_take_ids',
    'generationTakeIds',
    'takes',
    'generation_takes',
    'generationTakes',
  ];
  for (const key of keys) {
    const value = snapshot?.[key];
    if (Array.isArray(value)) {
      for (const item of value) addTakeId(ids, item);
    } else {
      addTakeId(ids, value);
    }
  }
  return [...ids];
}

function inspectAssetVersion(item) {
  const assetId = String(item?.asset_id ?? item?.assetId ?? '').trim();
  const snapshotVersion = versionNo(item?.version_no ?? item?.versionNo);
  const asset = assetId ? getAsset(assetId) : null;
  const currentVersion = versionNo(asset?.current_version);
  const pinnedVersion = asset && snapshotVersion
    ? getVersion(assetId, snapshotVersion)
    : null;

  let reason = '';
  if (!assetId) reason = '快照缺少资产 ID';
  else if (!asset) reason = '资产不存在';
  else if (!snapshotVersion) reason = '快照版本号非法';
  else if (!pinnedVersion) reason = '快照版本不存在';
  else if (currentVersion !== snapshotVersion) reason = '当前版本已更新';

  return {
    asset_id: assetId || null,
    asset_name: asset?.name || null,
    snapshot_version: snapshotVersion,
    current_version: currentVersion,
    snapshot_version_exists: Boolean(pinnedVersion),
    drifted: Boolean(reason),
    reason: reason || '一致',
  };
}

function buildSuggestions({ drifts, missingLineage, takeCount }) {
  const suggestions = [];
  if (drifts.length) {
    const labels = [...new Set(drifts.map((item) => item.asset_name || item.asset_id || '未知资产'))];
    suggestions.push(`建议核对 ${labels.join('、')} 的快照版本与当前版本，确认是正常升级还是误用旧版本；修复后重新生成资产快照。`);
  }
  if (missingLineage.length) {
    suggestions.push(`建议补齐 ${missingLineage.join('、')} 的模型、模型版本、种子和提示词等生成血缘，再重新执行 QC。`);
  }
  if (!takeCount) {
    suggestions.push('快照未包含 take 清单，无法核验生成血缘；建议生成快照时一并记录 take_ids。');
  }
  if (!drifts.length && !missingLineage.length && takeCount > 0) {
    suggestions.push('快照资产版本与当前版本一致，take 生成血缘完整，无需处理。');
  }
  return suggestions;
}

export async function createReport({ script, episode }) {
  const snapshot = await loadSnapshot(script, episode);
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new CliError(`未找到剧本 ${script} 第 ${episode} 集的资产快照`, 2);
  }

  const assetVersions = snapshot.asset_versions ?? snapshot.assetVersions;
  if (!Array.isArray(assetVersions)) {
    throw new CliError(`资产快照格式错误：缺少 asset_versions 数组（${script} / ${episode}）`, 2);
  }
  if (!assetVersions.length) {
    throw new CliError(`资产快照中没有资产，无法执行一致性 QC（${script} / ${episode}）`, 2);
  }

  const assets = assetVersions.map(inspectAssetVersion);
  const drifts = assets.filter((item) => item.drifted);
  const takeIds = takeIdsFromSnapshot(snapshot);
  const takes = takeIds.map((takeId) => ({
    take_id: takeId,
    has_lineage: Boolean(getLineage(takeId)),
  }));
  const missingLineage = takes.filter((item) => !item.has_lineage).map((item) => item.take_id);
  const snapshotMeta = snapshot.snapshot_meta || {
    id: snapshot.id ?? snapshot.snapshot_id ?? null,
    kind: snapshot.kind ?? null,
    version: snapshot.version ?? null,
    source: 'asset-snapshot',
  };

  return {
    ok: true,
    healthy: drifts.length === 0 && missingLineage.length === 0 && takes.length > 0,
    generated_at: new Date().toISOString(),
    script_id: script,
    episode_code: episode,
    snapshot: snapshotMeta,
    summary: {
      snapshot_count: assets.length,
      snapshot_record_count: snapshotMeta.id ? 1 : 0,
      drift_count: drifts.length,
      missing_lineage_count: missingLineage.length,
      take_count: takes.length,
    },
    assets,
    drifts,
    takes,
    missing_lineage: missingLineage,
    suggestions: buildSuggestions({ drifts, missingLineage, takeCount: takes.length }),
  };
}

export function renderMarkdown(report) {
  const snapshotLabel = report.snapshot.id
    ? `${report.snapshot.id}${report.snapshot.version !== null ? `（v${report.snapshot.version}）` : ''}`
    : '未标记快照 ID';
  const lines = [
    '# 资产一致性 QC 报告',
    '',
    `- 剧本：${report.script_id}`,
    `- 剧集：${report.episode_code}`,
    `- 快照：${snapshotLabel}`,
    `- 快照数：${report.summary.snapshot_count}（资产版本条目）`,
    `- 版本漂移数：${report.summary.drift_count}`,
    `- 缺血缘数：${report.summary.missing_lineage_count}`,
    `- 检查状态：${report.healthy ? '通过' : '发现问题'}`,
    '',
    '## 资产版本',
    '',
    '| 资产 | 快照版本 | 当前版本 | 结果 |',
    '| --- | ---: | ---: | --- |',
  ];

  for (const asset of report.assets) {
    const label = asset.asset_name || asset.asset_id || '未知资产';
    lines.push(`| ${label}（${asset.asset_id || '无 ID'}） | ${asset.snapshot_version ?? '-'} | ${asset.current_version ?? '-'} | ${asset.reason} |`);
  }

  lines.push('', '## 版本漂移', '');
  if (report.drifts.length) {
    for (const drift of report.drifts) {
      lines.push(`- ${drift.asset_name || drift.asset_id || '未知资产'}（${drift.asset_id || '无 ID'}）：${drift.reason}，快照 v${drift.snapshot_version ?? '-'} / 当前 v${drift.current_version ?? '-'}`);
    }
  } else {
    lines.push('- 无');
  }

  lines.push('', '## 缺血缘', '');
  if (report.missing_lineage.length) {
    for (const takeId of report.missing_lineage) lines.push(`- ${takeId}`);
  } else if (!report.summary.take_count) {
    lines.push('- 快照未包含 take 清单');
  } else {
    lines.push('- 无');
  }

  lines.push('', '## 建议', '');
  for (const suggestion of report.suggestions) lines.push(`- ${suggestion}`);
  return `${lines.join('\n')}\n`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const report = await createReport(options);
  const markdown = renderMarkdown(report);
  if (options.out) {
    const outFile = path.resolve(process.cwd(), options.out);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, markdown, 'utf8');
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(markdown);
    if (options.out) process.stdout.write(`\n报告已写入：${path.resolve(process.cwd(), options.out)}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF_FILE) {
  main().catch((error) => {
    const message = error instanceof CliError ? error.message : `执行失败：${error.message}`;
    if (process.argv.includes('--json')) {
      process.stderr.write(`${JSON.stringify({ ok: false, error: message })}\n`);
    } else {
      process.stderr.write(`错误：${message}\n`);
    }
    process.exitCode = error.exitCode || 1;
  });
}
