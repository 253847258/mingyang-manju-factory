#!/usr/bin/env node
// 10 进程生产链路压测
// 10 个 worker 并发执行：健康检查(读) → 新建演员(SQLite 写) → 出图(任务) → 出视频(ffmpeg CPU)
// 目的：找并发瓶颈、锁冲突、任务串行化，而不是做性能跑分。
//
// 用法：node scripts/pipeline-load-10.mjs
// 输出：docs/生产链路-10进程评估-<日期>.md

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SELF = fileURLToPath(import.meta.url);
const PORT = Number(process.env.LOAD_PORT || 8901);
const BASE = `http://127.0.0.1:${PORT}`;
const WORKERS = Number(process.env.LOAD_WORKERS || 10);
const ITER = Number(process.env.LOAD_ITER || 2);
const VIDEO_SEC = Number(process.env.LOAD_VIDEO_SEC || 1);

const post = async (p, body) => {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${t.slice(0, 160)}`);
  return t;
};

async function worker() {
  const wid = process.env.WID || '0';
  const out = [];
  const op = async (name, fn) => {
    const t = Date.now();
    try { await fn(); out.push({ op: name, ms: Date.now() - t, ok: true }); }
    catch (e) { out.push({ op: name, ms: Date.now() - t, ok: false, error: String(e.message || e).slice(0, 200) }); }
  };
  for (let i = 0; i < ITER; i += 1) {
    await op('health', async () => { const r = await fetch(BASE + '/api/health'); if (!r.ok) throw new Error('health ' + r.status); await r.text(); });
    await op('actor', () => post('/api/actors', { name: `负载-${wid}-${i}`, gender: 'male' }));
    await op('image', () => post('/api/settings/test-image', { backend: 'placeholder' }));
    await op('video', () => post('/api/render/test-video', { backend: 'placeholder', duration: VIDEO_SEC, move: '推镜' }));
  }
  fs.writeFileSync(path.join(process.env.LOAD_TMP, `w${wid}.json`), JSON.stringify(out));
}

async function waitHealth(ms = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return true; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function pct(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

async function main() {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'load10-'));
  const CFG = path.join(TMP, 'config.json');
  fs.writeFileSync(CFG, JSON.stringify({
    server: { host: '127.0.0.1', port: PORT },
    llm: { provider: 'mock', baseUrl: '', model: 'mock', apiKey: '', temperature: 0.7, maxTokens: 2000, timeoutMs: 60000 },
    image: { backend: 'placeholder' },
    video: { backend: 'placeholder', concurrency: 1 },
    tts: { backend: 'none' },
    budget: { enabled: false },
    edit: { enabled: true },
  }, null, 2));
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), FACTORY_DB: path.join(TMP, 'load.db'), FACTORY_DATA_DIR: path.join(TMP, 'data'), FACTORY_CONFIG: CFG },
    stdio: 'ignore',
  });
  const ok = await waitHealth();
  if (!ok) { console.error('临时实例启动失败'); srv.kill('SIGKILL'); process.exit(1); }

  const t0 = Date.now();
  const kids = Array.from({ length: WORKERS }, (_, i) => spawn(process.execPath, [SELF, '--worker'], {
    env: { ...process.env, WID: String(i), BASE, LOAD_TMP: TMP },
    stdio: 'ignore',
  }));
  await Promise.all(kids.map((k) => new Promise((res) => k.on('close', res))));
  const elapsed = Date.now() - t0;

  const all = [];
  for (let i = 0; i < WORKERS; i += 1) {
    const f = path.join(TMP, `w${i}.json`);
    if (fs.existsSync(f)) all.push(...JSON.parse(fs.readFileSync(f, 'utf8')));
  }
  const ops = ['health', 'actor', 'image', 'video'];
  const stats = {};
  for (const op of ops) {
    const rows = all.filter((x) => x.op === op);
    const okRows = rows.filter((x) => x.ok);
    stats[op] = {
      n: rows.length,
      ok: okRows.length,
      fail: rows.length - okRows.length,
      p50: pct(okRows.map((x) => x.ms), 0.5),
      p95: pct(okRows.map((x) => x.ms), 0.95),
      max: okRows.length ? Math.max(...okRows.map((x) => x.ms)) : 0,
      errors: [...new Set(rows.filter((x) => !x.ok).map((x) => x.error))].slice(0, 5),
    };
  }

  const date = new Date().toISOString().slice(0, 10);
  const lines = [
    `# 生产链路 · ${WORKERS} 进程压测报告（${date}）`,
    '',
    `> 并发：${WORKERS} 个独立 Node 进程 × ${ITER} 轮；临时实例 + 临时库；占位出图/本地运镜，零外部费用。`,
    `> 总耗时：${(elapsed / 1000).toFixed(1)}s`,
    '',
    '## 结果',
    '',
    '| 操作 | 成功/总数 | p50 | p95 | 最大 | 主要错误 |',
    '|---|---|---|---|---|---|',
    ...ops.map((op) => `| ${op} | ${stats[op].ok}/${stats[op].n} | ${stats[op].p50}ms | ${stats[op].p95}ms | ${stats[op].max}ms | ${stats[op].errors.join('；') || '—'} |`),
    '',
    '## 判读',
    '',
    stats.video.p95 > stats.image.p95 * 2 ? '- **视频任务明显串行/吃 CPU**：p95 远高于出图，说明单并发 + ffmpeg 编码是瓶颈。' : '- 视频与出图耗时接近，未观察到明显串行放大。',
    stats.actor.fail > 0 ? '- **SQLite 写冲突**：并发建演员出现失败，需要写队列/重试或 WAL 调优。' : '- 建演员无失败，SQLite 写入在当前并发下可接受。',
    stats.health.p95 > 1000 ? '- **健康检查被任务拖慢**：读接口 p95 超过 1s，说明任务与 API 共用事件循环需要隔离。' : '- 健康检查未被明显拖慢。',
    '',
    '## 原始汇总',
    '',
    '```json',
    JSON.stringify({ workers: WORKERS, iter: ITER, elapsed_ms: elapsed, stats }, null, 2),
    '```',
  ];
  const out = path.join(ROOT, 'docs', `生产链路-${WORKERS}进程评估-${date.replace(/-/g, '')}.md`);
  fs.writeFileSync(out, lines.join('\n'), 'utf8');
  console.log(lines.join('\n'));
  console.log('\n报告：', out);

  srv.kill('SIGKILL');
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
}

if (process.argv.includes('--worker')) await worker();
else await main();
