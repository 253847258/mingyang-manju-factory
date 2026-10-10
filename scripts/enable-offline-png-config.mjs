#!/usr/bin/env node
/**
 * 把当前配置切到「本地 PNG 占位出图」离线链路。
 *
 * 做三件事：
 *   1. 备份 config/config.json -> config/config.json.before-offline-png（只备份一次）
 *   2. image.backend 切到 generic-http，指向 scripts/local-image-service.js
 *   3. --mock-llm 时把 llm.provider 切成 mock，整条链路零外部接口零费用
 *
 * 用法：
 *   node scripts/enable-offline-png-config.mjs --mock-llm
 *   LOCAL_IMAGE_PORT=8790 node scripts/enable-offline-png-config.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CONFIG = process.env.FACTORY_CONFIG || path.join(ROOT, 'config', 'config.json');
const MOCK_LLM = process.argv.includes('--mock-llm') || process.env.OFFLINE_MOCK_LLM === '1';
const IMAGE_HOST = process.env.LOCAL_IMAGE_HOST || '127.0.0.1';
const IMAGE_PORT = Number(process.env.LOCAL_IMAGE_PORT || 8790);
const IMAGE_URL = process.env.LOCAL_IMAGE_URL || `http://${IMAGE_HOST}:${IMAGE_PORT}/generate`;

if (!fs.existsSync(CONFIG)) {
  console.error(`[offline-config] 找不到配置文件：${CONFIG}`);
  process.exit(1);
}

const raw = fs.readFileSync(CONFIG, 'utf8');
let cfg;
try {
  cfg = JSON.parse(raw);
} catch (err) {
  console.error(`[offline-config] 配置不是合法 JSON，未修改：${err.message}`);
  process.exit(1);
}

const backup = `${CONFIG}.before-offline-png`;
if (!fs.existsSync(backup)) {
  fs.copyFileSync(CONFIG, backup);
  console.log(`[offline-config] 已备份原配置：${backup}`);
}

cfg.llm ||= {};
if (MOCK_LLM) cfg.llm.provider = 'mock';

cfg.image ||= {};
cfg.image.backend = 'generic-http';
cfg.image.generic ||= {};
Object.assign(cfg.image.generic, {
  url: IMAGE_URL,
  method: 'POST',
  headers: '{"Content-Type":"application/json"}',
  bodyTemplate: '{"prompt":"{{prompt}}","negative":"{{negative}}","width":{{width}},"height":{{height}},"model":"{{model}}","apiKey":"{{apiKey}}"}',
  refBodyTemplate: '{"prompt":"{{prompt}}","negative":"{{negative}}","width":{{width}},"height":{{height}},"model":"{{model}}","apiKey":"{{apiKey}}","image":"{{refImage}}"}',
  responseImagePath: 'image',
  apiKey: '',
  model: 'local-png-placeholder',
  authHeader: '',
  authPrefix: '',
});

cfg.video ||= {};
if (!cfg.video.backend || cfg.video.backend === 'placeholder') cfg.video.backend = 'placeholder';

fs.writeFileSync(CONFIG, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
console.log(`[offline-config] 已切换：${CONFIG}`);
console.log(`[offline-config] 出图：generic-http -> ${IMAGE_URL}`);
console.log(`[offline-config] LLM：${cfg.llm.provider}${MOCK_LLM ? '（离线零调用）' : ''}`);
console.log(`[offline-config] 视频：${cfg.video.backend}`);
