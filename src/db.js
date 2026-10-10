// DATA_DIR-aware path resolution layer.
//
// The original engine resolves stored relative asset paths against ROOT. That is
// correct for the default layout (DATA_DIR === ROOT/data), but breaks when a
// deployment or test run points FACTORY_DATA_DIR at an external directory:
// uploads, film deletion and skill-document reads then look in the wrong place.
// Keep every original export, but make resolveAsset try both locations.

import path from 'node:path';
import fs from 'node:fs';
import { ROOT, DATA_DIR } from './db.core.js';

// 测试隔离硬门槛：测试进程不能在没有 FACTORY_DB 的情况下使用正式库。
const argv = process.argv[1] || '';
const isTestProcess = /[\\/]tests[\\/]/.test(argv) || /\.tmp-/.test(argv);
if (isTestProcess && !process.env.FACTORY_DB) {
  throw new Error('测试进程必须设置 FACTORY_DB，拒绝使用正式库 data/factory.db');
}

export * from './db.core.js';

export function resolveAsset(rel) {
  if (rel === null || rel === undefined || rel === '') return '';
  const value = String(rel);
  if (path.isAbsolute(value)) return value;

  const rootCandidate = path.resolve(ROOT, value);
  if (fs.existsSync(rootCandidate)) return rootCandidate;

  const dataCandidate = path.resolve(DATA_DIR, value);
  if (fs.existsSync(dataCandidate)) return dataCandidate;

  const stripped = value.replace(/^[/\\]?data[/\\]/i, '');
  if (stripped !== value) {
    const dataStripped = path.resolve(DATA_DIR, stripped);
    if (fs.existsSync(dataStripped)) return dataStripped;
  }

  // Preserve the original fallback shape: callers still get a deterministic
  // ROOT-relative path so their own Chinese error messages remain meaningful.
  return rootCandidate;
}
