#!/usr/bin/env node
// 真实 server.js 请求级闸门回归：直跑入口必须 403 且服务不能因处理函数返回值错误而崩溃。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'server-guards-'));
const CONFIG = path.join(TMP, 'config.json');
const DATA = path.join(TMP, 'data');
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(CONFIG, JSON.stringify({
  server: { host: '127.0.0.1', port: 0 },
  llm: { provider: 'mock' },
  image: { backend: 'placeholder' },
  video: { backend: 'placeholder' },
  tts: { backend: 'none' },
}));

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
let logs = '';
const child = spawn(process.execPath, ['server.js'], {
  cwd: path.resolve(import.meta.dirname, '..'),
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    FACTORY_DB: path.join(TMP, 'factory.db'),
    FACTORY_DATA_DIR: DATA,
    FACTORY_CONFIG: CONFIG,
    SKIP_REAL_LLM: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (chunk) => { logs += chunk; });
child.stderr.on('data', (chunk) => { logs += chunk; });

async function waitHealthy() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`服务提前退出：${logs.slice(-1200)}`);
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.status === 200) return;
    } catch { /* 启动中 */ }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`等待服务启动超时：${logs.slice(-1200)}`);
}

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    const detail = await fn();
    pass += 1;
    console.log(`  PASS ${name}${detail ? ` -> ${detail}` : ''}`);
  } catch (error) {
    fail += 1;
    console.error(`  FAIL ${name} -> ${error.message}`);
  }
}

try {
  await waitHealthy();
  await check('画布整图直跑入口返回 403 且服务存活', async () => {
    const res = await fetch(`${base}/api/canvas/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /已关闭/);
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    return '403 + alive';
  });
  await check('画布单节点直跑入口返回 403 且服务存活', async () => {
    const res = await fetch(`${base}/api/canvas/run-node`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /已关闭/);
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    return '403 + alive';
  });
  await check('旧计划执行入口返回 403 且服务存活（P0 崩溃回归）', async () => {
    const res = await fetch(`${base}/api/canvas/plans/PL-NOT-EXIST/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /\/api\/execute\/run/);
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    return '403 + alive';
  });
  await check('唯一 ExecuteGate 路由已挂载', async () => {
    const res = await fetch(`${base}/api/execute/plans`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.plans));
    return `plans=${body.plans.length}`;
  });
  await check('交付预检返回具体门禁原因，下载入口返回 409', async () => {
    const preview = await fetch(`${base}/api/render/delivery-gate?scriptId=SC-NONE&code=S01E999`);
    const gate = await preview.json();
    assert.equal(preview.status, 200);
    assert.equal(gate.ok, false);
    assert.equal(gate.gate, 'delivery-version');
    const download = await fetch(`${base}/api/render/deliver?scriptId=SC-NONE&code=S01E999`);
    assert.equal(download.status, 409);
    return gate.error;
  });
} finally {
  if (child.exitCode === null) child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 1500);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
if (fail) process.exitCode = 1;
