#!/usr/bin/env node
// 角色圣经生成器测试：本地 stub HTTP，全程不访问外网。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'character-sheet.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'character-sheet-test-'));
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const VALID_KEYS = ['height', 'prompt', 'seed', 'style', 'width'];

let mode = 'success';
let requests = [];

const server = http.createServer(async (req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };

  if (req.method !== 'POST' || req.url !== '/generate') return send(404, { ok: false, error: 'not found' });
  let raw = '';
  for await (const chunk of req) raw += chunk;
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return send(400, { ok: false, error: 'bad json' });
  }
  requests.push(body);

  if (mode === 'fail-one' && body.prompt.includes('背面全身视角')) {
    return send(502, { ok: false, error: 'stub 模拟单张失败' });
  }

  return send(200, {
    ok: true,
    image: `data:image/png;base64,${PNG}`,
    width: body.width,
    height: body.height,
    seed: body.seed,
    style: body.style,
  });
});

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      cwd: ROOT,
      env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  PASS ${name}`);
  } catch (error) {
    fail += 1;
    console.error(`  FAIL ${name} -> ${error.message}`);
  }
}

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const bridge = `http://127.0.0.1:${port}/generate`;

try {
  const dryOut = path.join(TMP, 'dry-run-output');
  const dry = await runCli([
    '--name', '陆行舟', '--desc', '35岁中国男演员，黑色风衣',
    '--out', dryOut, '--bridge', bridge, '--dry-run',
  ]);
  const dryPlan = JSON.parse(dry.stdout);
  check('dry-run 正常结束', () => assert.equal(dry.code, 0));
  check('dry-run 打印 7 张计划', () => {
    assert.equal(dryPlan.dryRun, true);
    assert.equal(dryPlan.items.length, 7);
  });
  check('dry-run 不请求桥接', () => assert.equal(requests.length, 0));
  check('dry-run 不创建输出目录', () => assert.equal(fs.existsSync(dryOut), false));

  mode = 'success';
  requests = [];
  const successOut = path.join(TMP, 'success');
  const all = await runCli([
    '--name', '陆行舟', '--desc', '35岁中国男演员，黑色风衣', '--out', successOut,
    '--bridge', bridge,
  ]);
  const sheetDir = path.join(successOut, '陆行舟');
  const manifestPath = path.join(sheetDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  check('正常模式退出码为 0', () => assert.equal(all.code, 0));
  check('向桥接发出 7 次请求', () => assert.equal(requests.length, 7));
  check('请求严格使用协议 5 字段', () => {
    for (const request of requests) assert.deepEqual(Object.keys(request).sort(), VALID_KEYS);
  });
  check('manifest 记录 7 张全部成功', () => {
    assert.equal(manifest.items.length, 7);
    assert.deepEqual(manifest.counts, { total: 7, succeeded: 7, failed: 0 });
  });
  check('4 个角度 + 3 个表情', () => {
    assert.equal(manifest.items.filter((item) => item.kind === 'angle').length, 4);
    assert.equal(manifest.items.filter((item) => item.kind === 'expression').length, 3);
    assert.deepEqual(
      manifest.items.filter((item) => item.kind === 'expression').map((item) => item.expression),
      ['平静', '愤怒', '悲伤'],
    );
  });
  check('每张都有 prompt、角度和可读文件路径', () => {
    for (const item of manifest.items) {
      assert.equal(typeof item.prompt, 'string');
      assert.ok(item.prompt.length > 0);
      assert.equal(typeof item.angle, 'string');
      assert.ok(item.angle.length > 0);
      assert.equal(typeof item.file, 'string');
      assert.equal(fs.existsSync(path.join(sheetDir, item.file)), true);
    }
  });
  check('落盘图片数量为 7', () => {
    const images = fs.readdirSync(sheetDir).filter((name) => name !== 'manifest.json');
    assert.equal(images.length, 7);
  });

  mode = 'fail-one';
  requests = [];
  const partialOut = path.join(TMP, 'partial');
  const partial = await runCli([
    '--name', '沈砚', '--desc', '沉默的年轻剑客，灰色长衫', '--out', partialOut,
    '--bridge', bridge,
  ]);
  const partialDir = path.join(partialOut, '沈砚');
  const partialManifest = JSON.parse(fs.readFileSync(path.join(partialDir, 'manifest.json'), 'utf8'));
  const failedItems = partialManifest.items.filter((item) => item.ok === false);

  check('单张失败后仍尝试全部 7 张', () => assert.equal(requests.length, 7));
  check('单张失败不中断 manifest 落盘', () => assert.equal(partialManifest.items.length, 7));
  check('manifest 准确记录唯一失败及中文错误', () => {
    assert.equal(failedItems.length, 1);
    assert.equal(failedItems[0].angle, '背面');
    assert.match(failedItems[0].error, /stub 模拟单张失败/);
  });
  check('其余 6 张仍成功落盘', () => {
    assert.deepEqual(partialManifest.counts, { total: 7, succeeded: 6, failed: 1 });
    const images = fs.readdirSync(partialDir).filter((name) => name !== 'manifest.json');
    assert.equal(images.length, 6);
    assert.equal(partial.code, 1);
  });
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);
