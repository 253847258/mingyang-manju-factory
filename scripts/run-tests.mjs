#!/usr/bin/env node
// 统一测试入口（开发评估 P1-2）
//
// 解决的问题：suite 之间环境依赖散落——有的要 FACTORY_DB，有的要 bin/ffmpeg 进 PATH，
// 有的默认写 /tmp（Windows 下直接失败）。这里统一注入，一条命令跑完。
//
// 用法：
//   node scripts/run-tests.mjs              # 默认 --fast（秒级纯逻辑 + 快套件）
//   node scripts/run-tests.mjs --full       # 全量（含 simulate-all / 制作台 / 排产 / 自愈）
//   node scripts/run-tests.mjs --only a,b   # 只跑指定套件（文件名可省略扩展名）
//   node scripts/run-tests.mjs --list       # 只列出套件分组
//   node scripts/run-tests.mjs --keep       # 保留临时数据目录
//   node scripts/run-tests.mjs --json       # 机器可读输出
//
// 安全约定（防误花钱 / 防污染正式库）：
//   · 每个 suite 用独立 FACTORY_DB / FACTORY_DATA_DIR（临时目录）
//   · 统一 FACTORY_CONFIG 指向"离线配置"（placeholder 出图 / mock LLM / 占位视频 / 无 TTS）
//   · 默认 SKIP_REAL_LLM=1
//   · bin/ffmpeg 前置进 PATH

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const TESTS = path.join(ROOT, 'tests');
const FFMPEG_DIR = path.join(ROOT, 'bin', 'ffmpeg');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

const FULL = has('--full');
const LIST = has('--list');
const KEEP = has('--keep');
const JSON_OUT = has('--json');
const ONLY = (val('--only') || '').split(',').map((s) => s.trim()).filter(Boolean);
const TIMEOUT_MS = Number(val('--timeout') || 420) * 1000;

// fast：纯逻辑 / 秒级套件（实测合计约 16s）；full 会在其后追加其余套件
const FAST = [
  'canvas-perf.test.mjs',
  'canvas-select.test.mjs',
  'test-prompt-quality.js',
  'test-describe.js',
  'test-canvas-consistency.js',
  'test-interchange-import.js',
  'test-subtitle-ttml.js',
  'test-subtitle-wrap.js',
  'test-model-registry.js',
  'test-clock-skew.js',
  'test-novel-ai.js',
  'test-novel-outline-ai.js',
  'test-novel-writing.js',
  'test-novel-assets.js',
  'test-novel-characters.js',
  'test-genre-frameworks.js',
  'test-novel-creative-options.js',
  'test-novel-ai-stability.js',
  'test-novel-brainstorm.js',
  'test-scripting-enhance.js',
];

// 其余 Node 套件（含需要 ffmpeg / 大批量出图 / 全模块模拟的）
const SLOW = [
  'test-guard.js',
  'test-scale.js',
  'test-role-wiring.js',
  'test-bridge.js',
  'test-dub.js',
  'test-canvas-sheets.js',
  'selfcheck.js',
  'test-actors.js',
  'test-comfy.js',
  'test-jobs.js',
  'test-stats.js',
  'test-publish.js',
  'test-deliver.js',
  'test-qc.js',
  'test-vision-qc.js',
  'test-mcp.js',
  'test-studio.js',
  'test-schedules.js',
  'test-selfheal.js',
  'test-adapters.js',
  'test-timeline.js',
  'test-graph.js',
  'test-render.js',
  'test-script.js',
  'test-novel.js',
  'scripts/simulate-all.js',
];

const all = [...FAST, ...SLOW];

// Python UI 套件（需要 Playwright，本机通常没有）——只登记，不自动跑
const PYTHON = ['ui-smoke.py', 'ui-simulate.py', 'ui-scale.py', 'canvas-audit.py', 'make-audit-refs.py'];

function suitePath(name) {
  if (name.startsWith('scripts/')) return path.join(ROOT, name);
  return path.join(TESTS, name);
}

function selected() {
  if (ONLY.length) {
    return all.filter((n) => ONLY.some((o) => n === o || n.replace(/\.(js|mjs)$/, '') === o));
  }
  return FULL ? all : FAST;
}

if (LIST) {
  console.log('--fast（默认）:');
  FAST.forEach((s) => console.log('  ' + s));
  console.log('--full 追加:');
  SLOW.forEach((s) => console.log('  ' + s));
  console.log('仅登记（需 Python + Playwright，不自动跑）:');
  PYTHON.forEach((s) => console.log('  tests/' + s));
  process.exit(0);
}

const missing = selected().filter((n) => !fs.existsSync(suitePath(n)));
if (missing.length) {
  console.error('找不到套件：' + missing.join(', '));
  process.exit(2);
}

const STAMP = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), `factory-tests-${STAMP}-`));

// 统一离线配置：绝不触网、绝不付费
const OFFLINE_CONFIG = path.join(TMP, 'offline-config.json');
fs.writeFileSync(OFFLINE_CONFIG, JSON.stringify({
  server: { host: '127.0.0.1', port: 0 },
  llm: { provider: 'mock' },
  image: { backend: 'placeholder', defaultRatio: '2:3' },
  video: { backend: 'placeholder' },
  tts: { backend: 'none' },
}, null, 2));

const envBase = {
  ...process.env,
  PATH: `${FFMPEG_DIR}${path.delimiter}${process.env.PATH || ''}`,
  FACTORY_CONFIG: OFFLINE_CONFIG,
  SKIP_REAL_LLM: '1',
};

const parseSummary = (text) => {
  const patterns = [
    /(\d+)\s*通过\s*\/\s*(\d+)\s*失败(?:\s*\/\s*跳过\s*(\d+))?/,            // 「N 通过 / M 失败 [/ 跳过 K]」
    /通过\s*(\d+)\s*项[，,]\s*失败\s*(\d+)\s*项(?:[，,]\s*跳过\s*(\d+)\s*项)?/,
    /(\d+)\s*项通过\s*[，,]\s*(全部通过|存在失败项)/,                        // selfcheck 口径
  ];
  for (const [i, re] of patterns.entries()) {
    const m = text.match(re);
    if (!m) continue;
    if (i === 2) return { pass: Number(m[1]), fail: m[2] === '全部通过' ? 0 : 1, skip: 0 };
    return { pass: Number(m[1]), fail: Number(m[2]), skip: Number(m[3] || 0) };
  }
  return null;
};

const results = [];
const startedAll = Date.now();

for (const name of selected()) {
  const file = suitePath(name);
  const slug = name.replace(/[^\w.-]/g, '_');
  const env = {
    ...envBase,
    FACTORY_DB: path.join(TMP, `${slug}.db`),
    FACTORY_DATA_DIR: path.join(TMP, `${slug}-data`),
  };
  fs.mkdirSync(env.FACTORY_DATA_DIR, { recursive: true });
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [file], { cwd: ROOT, env, encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 });
  const ms = Date.now() - t0;
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  const summary = parseSummary(out);
  const timedOut = r.error && String(r.error.code) === 'ETIMEDOUT';
  const okRun = r.status === 0 && !timedOut && (!summary || summary.fail === 0);
  results.push({ name, ms, status: r.status, timedOut, ok: okRun, summary });
  if (!JSON_OUT) {
    const tag = timedOut ? 'TIMEOUT' : (okRun ? 'PASS' : 'FAIL');
    const sm = summary ? `${summary.pass}/${summary.fail}${summary.skip ? ` (跳过 ${summary.skip})` : ''}` : `exit=${r.status}`;
    console.log(`[${tag}] ${name.padEnd(30)} ${String((ms / 1000).toFixed(1)).padStart(6)}s  ${sm}`);
    if (!okRun && !timedOut) {
      const tail = out.trim().split('\n').filter((l) => /✗|✘|Error|失败/.test(l)).slice(0, 3);
      tail.forEach((l) => console.log('        ' + l.trim().slice(0, 180)));
    }
  }
}

const totalMs = Date.now() - startedAll;
const failed = results.filter((r) => !r.ok);
const sums = results.reduce((a, r) => ({
  pass: a.pass + (r.summary?.pass || 0),
  fail: a.fail + (r.summary?.fail || 0),
  skip: a.skip + (r.summary?.skip || 0),
}), { pass: 0, fail: 0, skip: 0 });

if (JSON_OUT) {
  console.log(JSON.stringify({ mode: FULL ? 'full' : 'fast', totalMs, passedSuites: results.length - failed.length, failedSuites: failed.length, assertions: sums, results }, null, 2));
} else {
  console.log('');
  console.log(`套件：${results.length - failed.length}/${results.length} 通过 · 断言：${sums.pass} 通过 / ${sums.fail} 失败${sums.skip ? ` / 跳过 ${sums.skip}` : ''} · 耗时 ${(totalMs / 1000).toFixed(1)}s`);
  console.log(`临时数据：${TMP}${KEEP ? '（已保留）' : ''}`);
  if (failed.length) console.log('失败套件：' + failed.map((f) => f.name).join(', '));
  console.log('Python UI 套件（需 Playwright，未跑）：' + PYTHON.join(', '));
}

if (!KEEP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ } }
process.exitCode = failed.length ? 1 : 0;
