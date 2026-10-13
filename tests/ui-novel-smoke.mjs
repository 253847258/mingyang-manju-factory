#!/usr/bin/env node
// Module 2 permanent browser smoke test. Starts an isolated mock server.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = process.cwd();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-ui-test-'));
const PORT = 8798;
const CONFIG = path.join(TMP, 'config.json');
fs.mkdirSync(path.join(TMP, 'data'), { recursive: true });
fs.writeFileSync(CONFIG, JSON.stringify({
  server: { host: '127.0.0.1', port: PORT },
  llm: { provider: 'mock' },
  image: { backend: 'placeholder' },
  video: { backend: 'placeholder' },
  tts: { backend: 'none' },
}), 'utf8');

const child = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    FACTORY_DB: path.join(TMP, 'ui.db'),
    FACTORY_DATA_DIR: path.join(TMP, 'data'),
    FACTORY_CONFIG: CONFIG,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverOutput = '';
child.stdout.on('data', (d) => { serverOutput += d.toString(); });
child.stderr.on('data', (d) => { serverOutput += d.toString(); });

async function waitServer() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/novels`);
      if (r.ok) return;
    } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`测试服务启动失败\n${serverOutput}`);
}

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  PASS ${name}${extra ? ` -> ${extra}` : ''}`); }
  else { fail += 1; console.error(`  FAIL ${name}${extra ? ` -> ${extra}` : ''}`); }
};

try {
  await waitServer();
  const { chromium } = await import('playwright-core');
  const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  const browser = await chromium.launch({
    headless: true,
    ...(fs.existsSync(edge) ? { executablePath: edge } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror:${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console:${m.text()}`); });

  await page.goto(`http://127.0.0.1:${PORT}/#/novel`, { waitUntil: 'domcontentloaded' });
  await page.locator('.nv-wrap').waitFor();
  await page.locator('[data-act="new-novel"]').first().click();

  ok('标题描述输入', await page.locator('[data-role="title_description"]').count() === 1);
  ok('100 种基调', await page.locator('[data-role="tone"] option').count() === 100);
  ok('AI 自动规划题材', await page.locator('[data-act="plan-genre"]').count() === 1);
  ok('AI 自动视角', await page.locator('[data-role="auto_pov"]').count() === 1);
  ok('AI 自动角色规模', await page.locator('[data-role="auto_cast"]').count() === 1);
  ok('无创意限制', await page.locator('[data-act="unlimited-cast"]').count() === 1);
  ok('角色自由模式默认开启', await page.locator('[data-role="free_mode"]').isChecked());
  ok('故事框架 AI 自动填写入口', await page.locator('[data-act="ai-framework"]').count() === 1);

  await page.locator('[data-act="unlimited-cast"]').click();
  ok('无创意限制使用系统安全上限', await page.locator('[data-role="cast_size"]').inputValue() === '200');
  ok('无浏览器错误', errors.length === 0, errors.join(' | '));

  await browser.close();
} finally {
  child.kill();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n=== UI 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exitCode = fail ? 1 : 0;
