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
  ok('一键流程四个按钮', await page.locator('[data-act="pipe-params"], [data-act="pipe-outline"], [data-act="pipe-chapters"], [data-act="pipe-write"]').count() === 4);
  ok('题材 3 选 1 模式切换', await page.locator('[data-act="genre-mode"]').count() === 3);
  ok('系统题材可收起', await page.locator('[data-act="genre-collapse"]').count() === 1);
  ok('自由模式开启时隐藏「最多按剧情新增」', await page.locator('[data-role="free-max-wrap"]').isHidden());

  await page.locator('[data-act="unlimited-cast"]').click();
  ok('无创意限制使用系统安全上限', await page.locator('[data-role="cast_size"]').inputValue() === '200');

  // 选题材后出现「写作技能提示词」入口
  await page.locator('.nv-gitem').first().click();
  ok('选题材后出现写作技能提示词入口', await page.locator('[data-act="genre-skill"]').count() === 1);

  // 模式二：题材生成器
  await page.locator('[data-act="genre-mode"][data-mode="generator"]').click();
  ok('题材生成器入口', await page.locator('[data-act="open-genre-generator"]').count() === 1);
  await page.locator('[data-act="open-genre-generator"]').click();
  await page.locator('.overlay .modal').first().waitFor({ timeout: 8000 });
  ok('题材生成器弹窗含选项', await page.locator('#gg-world, #gg-pro, #gg-con, #gg-pace, #gg-aud').count() === 5);
  await page.locator('[data-a="go"]').click();
  await page.locator('[data-a="ok"]').waitFor({ timeout: 8000 });
  await page.locator('[data-a="ok"]').click();
  await page.waitForTimeout(300);
  ok('题材生成器写入自定义题材与框架', (await page.locator('[data-role="framework_intro"]').inputValue()).includes('模块 7'));

  // 模式三：AI 头脑风暴
  await page.locator('[data-act="genre-mode"][data-mode="brainstorm"]').click();
  ok('AI 头脑风暴入口（模式三）', await page.locator('[data-act="brainstorm-genre"]').count() >= 1);
  await page.locator('[data-act="genre-mode"][data-mode="system"]').click();

  // AI 自动填写（mock）必须把框架写入故事框架介绍填写区
  await page.locator('.nv-gitem').first().click();
  await page.locator('[data-act="ai-framework"]').click();
  await page.locator('[data-a="ok"]').waitFor({ timeout: 8000 });
  await page.locator('[data-a="ok"]').click();
  await page.waitForTimeout(400);
  const fwText = await page.locator('[data-role="framework_intro"]').inputValue();
  ok('AI 自动填写把框架写入故事框架介绍', fwText.includes('模块 1') && fwText.length > 200, `${fwText.length} 字`);

  ok('无浏览器错误', errors.length === 0, errors.join(' | '));

  await browser.close();
} finally {
  child.kill();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n=== UI 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exitCode = fail ? 1 : 0;
