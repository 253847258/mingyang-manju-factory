#!/usr/bin/env node
// 把 config.json 中的明文 API Key 迁移到 config/local.env（0600、git 忽略）。
// 只输出字段名与迁移状态，绝不输出密钥值。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = path.join(ROOT, 'config', 'config.json');
const ENV_FILE = path.join(ROOT, 'config', 'local.env');
const BACKUP_DIR = path.join(ROOT, '_archive', `backup-secrets-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}`);

function shellValue(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function setPath(obj, keys, value) {
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i += 1) {
    if (!cur[keys[i]] || typeof cur[keys[i]] !== 'object') return false;
    cur = cur[keys[i]];
  }
  if (!Object.prototype.hasOwnProperty.call(cur, keys.at(-1))) return false;
  cur[keys.at(-1)] = value;
  return true;
}

if (!fs.existsSync(CONFIG)) {
  console.error('[secrets-migrate] config/config.json 不存在');
  process.exit(1);
}

const raw = fs.readFileSync(CONFIG, 'utf8');
const config = JSON.parse(raw);
const mappings = [
  { label: 'llm.apiKey', keys: ['llm', 'apiKey'], env: 'OPENAI_API_KEY' },
  { label: 'image.generic.apiKey', keys: ['image', 'generic', 'apiKey'], env: 'IMAGE_API_KEY' },
  { label: 'video.generic.apiKey', keys: ['video', 'generic', 'apiKey'], env: 'ARK_API_KEY' },
];

const values = new Map();
const migrated = [];
for (const item of mappings) {
  let cur = config;
  for (const key of item.keys) cur = cur && typeof cur === 'object' ? cur[key] : undefined;
  const value = typeof cur === 'string' ? cur.trim() : '';
  if (!value) continue;
  values.set(item.env, value);
  migrated.push(item.label);
}

if (!migrated.length) {
  console.log('[secrets-migrate] 没有发现可迁移的明文 Key；配置未改动');
  process.exit(0);
}

fs.mkdirSync(BACKUP_DIR, { recursive: true });
fs.copyFileSync(CONFIG, path.join(BACKUP_DIR, 'config.json'));
fs.writeFileSync(path.join(BACKUP_DIR, 'README.txt'), `迁移前备份\n字段：${migrated.join(', ')}\n`, 'utf8');

const existing = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/) : [];
const prior = new Map();
for (const line of existing) {
  const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
  if (m) prior.set(m[1], m[2]);
}
for (const [key, value] of values) prior.set(key, shellValue(value));
const envText = [
  '# 本机敏感配置：仅由 start.sh 加载，已加入 .gitignore；不要提交或截图。',
  ...['OPENAI_API_KEY', 'IMAGE_API_KEY', 'ARK_API_KEY'].filter((key) => prior.has(key)).map((key) => `${key}=${prior.get(key)}`),
  '',
].join('\n');
fs.writeFileSync(ENV_FILE, envText, { encoding: 'utf8', mode: 0o600 });
fs.chmodSync(ENV_FILE, 0o600);

for (const item of mappings) setPath(config, item.keys, '');
fs.writeFileSync(CONFIG, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
console.log(`[secrets-migrate] 已迁移：${migrated.join(', ')}`);
console.log(`[secrets-migrate] 环境文件：${path.relative(ROOT, ENV_FILE)}（0600，已忽略 Git）`);
console.log(`[secrets-migrate] 配置备份：${path.relative(ROOT, BACKUP_DIR)}`);
