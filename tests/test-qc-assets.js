#!/usr/bin/env node
// 资产一致性 QC CLI 测试：临时库造资产版本、分集快照和 take 血缘。
// 不读取或写入真实业务库。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const CLI = path.join(ROOT, 'scripts', 'qc-assets.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-qc-assets-'));
const DB = path.join(TMP, 'qc-assets.db');
const DATA_DIR = path.join(TMP, 'data');
const CONFIG = path.join(TMP, 'config.json');

process.env.FACTORY_DB = DB;
process.env.FACTORY_DATA_DIR = DATA_DIR;
process.env.FACTORY_CONFIG = CONFIG;
fs.mkdirSync(DATA_DIR, { recursive: true });

let pass = 0;
let fail = 0;
let run;
function check(name, work) {
  try {
    const detail = work();
    pass += 1;
    console.log(`  PASS ${name}${detail ? ` -> ${detail}` : ''}`);
  } catch (error) {
    fail += 1;
    console.error(`  FAIL ${name} -> ${error.message}`);
  }
}

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      FACTORY_DB: DB,
      FACTORY_DATA_DIR: DATA_DIR,
      FACTORY_CONFIG: CONFIG,
    },
    encoding: 'utf8',
    timeout: 30000,
  });
}

function insertAssetSnapshot({ id, scriptId, episodeCode, assetVersions, takeIds, version = 1 }) {
  const payload = {
    asset_versions: assetVersions,
    take_ids: takeIds,
  };
  const now = new Date().toISOString();
  run(
    `INSERT INTO script_snapshots
      (id, script_id, episode_code, kind, version, payload, note, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    scriptId,
    episodeCode,
    'asset',
    version,
    JSON.stringify(payload),
    '资产一致性 QC 测试快照',
    'test',
    now,
  );
}

try {
  ({ run } = await import('../src/db.js'));
  const { createAsset, updateAsset } = await import('../src/assets.js');
  const { recordLineage } = await import('../src/lineage.js');

  run(`CREATE TABLE script_snapshots (
    id TEXT PRIMARY KEY,
    script_id TEXT NOT NULL,
    episode_code TEXT,
    kind TEXT NOT NULL,
    version INTEGER NOT NULL,
    payload TEXT NOT NULL,
    note TEXT,
    created_by TEXT,
    created_at TEXT
  )`);

  const stable = createAsset({
    type: 'role',
    name: '沈砚',
    description: '稳定角色资产',
    params: { tone: 'cinematic' },
  });
  const drifted = createAsset({
    type: 'scene',
    name: '雾港码头',
    description: '版本一',
    params: { weather: 'mist' },
  });
  updateAsset(drifted.id, {
    name: '雾港码头定版',
    description: '版本二',
    params: { weather: 'rain' },
  });

  recordLineage({
    takeId: 'TAKE-QC-001',
    model: 'flux-kontext',
    modelVersion: 'v1.2',
    seed: '7',
    prompt: '电影感夜景，雾港码头，沈砚中景',
    refHash: 'ref-qc-001',
  });

  insertAssetSnapshot({
    id: 'SN-QC-ASSET-001',
    scriptId: 'SC-QC-001',
    episodeCode: 'S01E001',
    assetVersions: [
      { asset_id: stable.id, version_no: 1 },
      { asset_id: drifted.id, version_no: 1 },
    ],
    takeIds: ['TAKE-QC-001', 'TAKE-QC-002'],
  });
  insertAssetSnapshot({
    id: 'SN-QC-ASSET-EMPTY',
    scriptId: 'SC-QC-EMPTY',
    episodeCode: 'S01E001',
    assetVersions: [],
    takeIds: [],
  });

  console.log('\n=== 1. 语法检查 ===');
  check('CLI 通过 node --check', () => {
    const result = spawnSync(process.execPath, ['--check', CLI], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return 'scripts/qc-assets.js';
  });

  console.log('\n=== 2. JSON 机器可读报告 ===');
  const jsonRun = runCli(['--script', 'SC-QC-001', '--episode', 'S01E001', '--json']);
  let report = null;
  try { report = JSON.parse(jsonRun.stdout); } catch { /* 下方断言给出可读失败 */ }
  check('CLI 正常退出并输出可解析 JSON', () => {
    assert.equal(jsonRun.status, 0, jsonRun.stderr);
    assert.ok(report && report.ok === true, jsonRun.stdout);
    return `status=${jsonRun.status}`;
  });
  check('快照资产数为 2、take 数为 2', () => {
    assert.equal(report.summary.snapshot_count, 2);
    assert.equal(report.summary.take_count, 2);
    return JSON.stringify(report.summary);
  });
  check('检出 1 个版本漂移且定位到漂移资产', () => {
    assert.equal(report.summary.drift_count, 1);
    assert.equal(report.drifts[0].asset_id, drifted.id);
    assert.equal(report.drifts[0].snapshot_version, 1);
    assert.equal(report.drifts[0].current_version, 2);
    return report.drifts[0].reason;
  });
  check('检出 1 个有 take 无血缘', () => {
    assert.equal(report.summary.missing_lineage_count, 1);
    assert.deepEqual(report.missing_lineage, ['TAKE-QC-002']);
    return report.missing_lineage.join(', ');
  });
  check('健康状态与建议同步反映问题', () => {
    assert.equal(report.healthy, false);
    assert.ok(report.suggestions.some((item) => item.includes('快照版本')));
    assert.ok(report.suggestions.some((item) => item.includes('生成血缘')));
    return `${report.suggestions.length} 条建议`;
  });

  console.log('\n=== 3. 中文报告与 Markdown 落盘 ===');
  const textRun = runCli(['--script', 'SC-QC-001', '--episode', 'S01E001']);
  check('中文报告包含快照数/版本漂移数/缺血缘数/建议', () => {
    assert.equal(textRun.status, 0, textRun.stderr);
    assert.match(textRun.stdout, /快照数：2/);
    assert.match(textRun.stdout, /版本漂移数：1/);
    assert.match(textRun.stdout, /缺血缘数：1/);
    assert.match(textRun.stdout, /## 建议/);
    assert.match(textRun.stdout, /雾港码头定版/);
    return '中文报告字段齐全';
  });

  const outFile = path.join(TMP, 'docs', 'qc-assets-SC-QC-001-S01E001.md');
  const outRun = runCli(['--script', 'SC-QC-001', '--episode', 'S01E001', '--out', outFile]);
  check('--out 自动建目录并写出 Markdown 报告', () => {
    assert.equal(outRun.status, 0, outRun.stderr);
    assert.ok(fs.existsSync(outFile));
    const content = fs.readFileSync(outFile, 'utf8');
    assert.match(content, /^# 资产一致性 QC 报告/m);
    assert.match(content, /版本漂移数：1/);
    assert.match(content, /缺血缘数：1/);
    return outFile;
  });

  console.log('\n=== 4. 中文错误与退出码 ===');
  const noSnapshotRun = runCli(['--script', 'SC-QC-MISSING', '--episode', 'S01E001']);
  check('无快照时中文报错且退出码非 0', () => {
    assert.notEqual(noSnapshotRun.status, 0);
    assert.match(noSnapshotRun.stderr, /未找到/);
    assert.match(noSnapshotRun.stderr, /资产快照/);
    return noSnapshotRun.stderr.trim();
  });

  const noAssetsRun = runCli(['--script', 'SC-QC-EMPTY', '--episode', 'S01E001']);
  check('无资产时中文报错且退出码非 0', () => {
    assert.notEqual(noAssetsRun.status, 0);
    assert.match(noAssetsRun.stderr, /没有资产/);
    return noAssetsRun.stderr.trim();
  });

  console.log('\n=== 5. 测试隔离 ===');
  check('只使用临时库', () => {
    const realDb = path.resolve(ROOT, 'data', 'factory.db');
    assert.notEqual(path.resolve(DB), realDb);
    assert.equal(path.resolve(process.env.FACTORY_DB), path.resolve(DB));
    assert.ok(fs.existsSync(DB));
    return DB;
  });
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
if (fail) process.exitCode = 1;
