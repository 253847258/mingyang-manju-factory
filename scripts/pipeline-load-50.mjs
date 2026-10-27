#!/usr/bin/env node
// 可配置生产链路压测，默认 50 个独立 Node 进程。
// 每个 worker 依次执行：健康检查(读) → 新建演员(SQLite 写) → 占位出图 → 本地运镜(ffmpeg CPU)。
// 目的：观察高并发下的锁冲突、任务串行化和 API 响应，不发起真实外部模型调用。
//
// 用法：node scripts/pipeline-load-50.mjs
// 冒烟：LOAD_WORKERS=8 LOAD_ITER=1 node scripts/pipeline-load-50.mjs
// 输出：docs/生产链路-<WORKERS>进程评估-<日期>.md

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SELF = fileURLToPath(import.meta.url);
const PORT = positiveInt('LOAD_PORT', 8902);
const WORKERS = positiveInt('LOAD_WORKERS', 50);
const ITER = positiveInt('LOAD_ITER', 1);
const VIDEO_SEC = positiveInt('LOAD_VIDEO_SEC', 1);
const BASE = `http://127.0.0.1:${PORT}`;

function positiveInt(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} 必须是正整数`);
  return value;
}

const post = async (pathname, body) => {
  const response = await fetch(BASE + pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${text.slice(0, 160)}`);
  return text;
};

async function worker() {
  const wid = process.env.WID || '0';
  const out = [];
  const op = async (name, fn) => {
    const startedAt = Date.now();
    try {
      await fn();
      out.push({ op: name, ms: Date.now() - startedAt, ok: true });
    } catch (error) {
      out.push({ op: name, ms: Date.now() - startedAt, ok: false, error: String(error.message || error).slice(0, 200) });
    }
  };

  try {
    for (let i = 0; i < ITER; i += 1) {
      await op('health', async () => {
        const response = await fetch(BASE + '/api/health');
        if (!response.ok) throw new Error(`health ${response.status}`);
        await response.text();
      });
      await op('actor', () => post('/api/actors', { name: `负载-${wid}-${i}`, gender: 'male' }));
      await op('image', () => post('/api/settings/test-image', { backend: 'placeholder' }));
      await op('video', () => post('/api/render/test-video', { backend: 'placeholder', duration: VIDEO_SEC, move: '推镜' }));
    }
  } finally {
    if (!process.env.LOAD_TMP) throw new Error('缺少 LOAD_TMP');
    fs.writeFileSync(path.join(process.env.LOAD_TMP, `w${wid}.json`), JSON.stringify(out));
  }
}

async function waitHealth(ms = 60000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < ms) {
    try {
      const response = await fetch(BASE + '/api/health');
      if (response.ok) return true;
    } catch {
      // 临时实例仍在启动，继续重试。
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

function pct(values, percentile) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * percentile))];
}

function summarize(rows, expected, workerErrors) {
  const successes = rows.filter((row) => row.ok);
  const failures = rows.filter((row) => !row.ok);
  const errors = [...new Set([
    ...failures.map((row) => row.error),
    ...(rows.length < expected ? [`缺少 ${expected - rows.length} 条结果`] : []),
    ...workerErrors,
  ])];
  return {
    expected,
    observed: rows.length,
    ok: successes.length,
    fail: expected - successes.length,
    p50: pct(successes.map((row) => row.ms), 0.5),
    p95: pct(successes.map((row) => row.ms), 0.95),
    max: successes.length ? Math.max(...successes.map((row) => row.ms)) : 0,
    errors: errors.slice(0, 5),
  };
}

function stopServer(server) {
  if (!server || server.exitCode !== null || server.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 3000);
    server.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
    if (!server.kill('SIGKILL')) {
      clearTimeout(timer);
      resolve(server.exitCode !== null || server.signalCode !== null);
    }
  });
}

function localDate() {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
}

async function main() {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'load50-'));
  const CFG = path.join(TMP, 'config.json');
  let server;
  let workers = [];
  let cleaned = false;

  fs.writeFileSync(CFG, JSON.stringify({
    server: { host: '127.0.0.1', port: PORT },
    llm: { provider: 'mock', baseUrl: '', model: 'mock', apiKey: '', temperature: 0.7, maxTokens: 2000, timeoutMs: 60000 },
    image: { backend: 'placeholder' },
    video: { backend: 'placeholder', concurrency: 1 },
    tts: { backend: 'none' },
    budget: { enabled: false },
    edit: { enabled: true },
  }, null, 2));

  const cleanup = async () => {
    workers.forEach((workerProcess) => {
      if (workerProcess.exitCode === null && workerProcess.signalCode === null) workerProcess.kill('SIGKILL');
    });
    const serverStopped = await stopServer(server);
    let tmpRemoved = true;
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
    } catch {
      tmpRemoved = false;
    }
    cleaned = true;
    return { serverStopped, tmpRemoved };
  };

  const onSignal = (signal) => {
    if (cleaned) return;
    void cleanup().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
  };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));

  try {
    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(PORT),
        FACTORY_DB: path.join(TMP, 'load.db'),
        FACTORY_DATA_DIR: path.join(TMP, 'data'),
        FACTORY_CONFIG: CFG,
      },
      stdio: 'ignore',
    });

    if (!await waitHealth()) {
      console.error('临时实例启动失败');
      process.exitCode = 1;
      return;
    }

    const startedAt = Date.now();
    workers = Array.from({ length: WORKERS }, (_, index) => spawn(process.execPath, [SELF, '--worker'], {
      env: { ...process.env, WID: String(index), BASE, LOAD_TMP: TMP },
      stdio: 'ignore',
    }));
    const exits = await Promise.all(workers.map((workerProcess) => new Promise((resolve) => {
      workerProcess.once('close', (code, signal) => resolve({ code, signal }));
    })));
    const elapsed = Date.now() - startedAt;

    const all = [];
    const workerErrors = [];
    for (let index = 0; index < WORKERS; index += 1) {
      const resultFile = path.join(TMP, `w${index}.json`);
      if (exits[index].code !== 0) {
        workerErrors.push(`worker ${index} 退出 ${exits[index].code ?? exits[index].signal}`);
      }
      try {
        all.push(...JSON.parse(fs.readFileSync(resultFile, 'utf8')));
      } catch {
        workerErrors.push(`worker ${index} 结果不可读`);
      }
    }

    const ops = ['health', 'actor', 'image', 'video'];
    const expected = WORKERS * ITER;
    const stats = Object.fromEntries(ops.map((op) => [
      op,
      summarize(all.filter((row) => row.op === op), expected, workerErrors),
    ]));

    const cleanupResult = await cleanup();
    const date = localDate();
    const reportPath = path.join(ROOT, 'docs', `生产链路-${WORKERS}进程评估-${date.replaceAll('-', '')}.md`);
    const allOk = ops.every((op) => stats[op].ok === expected && stats[op].fail === 0)
      && workerErrors.length === 0
      && cleanupResult.serverStopped
      && cleanupResult.tmpRemoved;
    const lines = [
      `# 生产链路 · ${WORKERS} 进程压测报告（${date}）`,
      '',
      `> 并发：${WORKERS} 个独立 Node 进程 × ${ITER} 轮；临时实例 + 临时库；占位出图/本地运镜，零外部模型调用。`,
      `> 总耗时：${(elapsed / 1000).toFixed(1)}s`,
      `> 总体结果：${allOk ? '全部成功' : '存在失败，详见下表'}`,
      '',
      '## 结果',
      '',
      '| 操作 | 成功数/总数 | p50 | p95 | 最大 | 错误 |',
      '|---|---|---|---|---|---|',
      ...ops.map((op) => `| ${op} | ${stats[op].ok}/${stats[op].expected} | ${stats[op].p50}ms | ${stats[op].p95}ms | ${stats[op].max}ms | ${stats[op].errors.join('；') || '—'} |`),
      '',
      '## 判读',
      '',
      stats.video.p95 > stats.image.p95 * 2 ? '- **视频任务明显串行/吃 CPU**：p95 远高于出图，说明单并发 + ffmpeg 编码是瓶颈。' : '- 视频与出图耗时接近，未观察到明显串行放大。',
      stats.actor.fail > 0 ? '- **SQLite 写冲突或请求失败**：并发建演员出现失败，需要写队列/重试或 WAL 调优。' : '- 建演员无失败，SQLite 写入在当前并发下可接受。',
      stats.health.p95 > 1000 ? '- **健康检查被任务拖慢**：读接口 p95 超过 1s，说明任务与 API 共用事件循环需要隔离。' : '- 健康检查未被明显拖慢。',
      '',
      '## 清理',
      '',
      `- 临时实例：${cleanupResult.serverStopped ? '已停止' : '停止失败'}`,
      `- 临时目录：${cleanupResult.tmpRemoved ? '已清理' : '清理失败'}`,
      '',
      '## 原始汇总',
      '',
      '```json',
      JSON.stringify({ workers: WORKERS, iter: ITER, video_sec: VIDEO_SEC, elapsed_ms: elapsed, stats, worker_errors: workerErrors }, null, 2),
      '```',
    ];
    fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');
    console.log(lines.join('\n'));
    console.log('\n报告：', reportPath);

    if (!cleanupResult.serverStopped || !cleanupResult.tmpRemoved) process.exitCode = 1;
  } finally {
    if (!cleaned) await cleanup();
  }
}

if (process.argv.includes('--worker')) await worker();
else await main();
