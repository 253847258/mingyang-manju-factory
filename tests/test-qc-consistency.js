#!/usr/bin/env node
// 成片一致性 QC CLI 回归：临时库 + 三张程序生成的渐变图。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-consistency-'));
const DB = path.join(TMP, 'qc.db');
const DATA_DIR = path.join(TMP, 'data');
const CONFIG = path.join(TMP, 'config.json');
const CLI = path.join(ROOT, 'scripts', 'qc-consistency.js');

process.env.FACTORY_DB = DB;
process.env.FACTORY_DATA_DIR = DATA_DIR;
process.env.FACTORY_CONFIG = CONFIG;
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(CONFIG, JSON.stringify({ edit: { enabled: true } }));

const { migrate, run } = await import('../src/db.js');
const { ensureEditSchema } = await import('../src/edit-timeline.js');

let pass = 0;
let fail = 0;
const ok = (name, condition, extra = '') => {
  if (condition) {
    pass += 1;
    console.log(`  PASS ${name}${extra ? ` -> ${extra}` : ''}`);
  } else {
    fail += 1;
    console.error(`  FAIL ${name}${extra ? ` -> ${extra}` : ''}`);
  }
};

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return chunk;
}

function writeGradientPng(file, from, to) {
  const width = 96;
  const height = 64;
  const stride = width + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0;
    for (let x = 0; x < width; x += 1) {
      raw[y * stride + x + 1] = Math.round(from + ((to - from) * x) / (width - 1));
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(file, png);
}

function insertTimeline(id, code, withClips) {
  const now = new Date().toISOString();
  run(`INSERT INTO edit_timelines(id,script_id,episode_id,code,title,doc_version,status,source,operator,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
  id, null, null, code, 'QC 测试集', 1, 'draft', 'canvas', '自动测试', now, now);
  const trackId = `TR-${id}`;
  run('INSERT INTO edit_tracks(id,timeline_id,kind,idx,name,enabled,muted,gain_db) VALUES(?,?,?,?,?,?,?,?)',
    trackId, id, 'main', 1, '主轨', 1, 0, 0);
  if (!withClips) return;

  const images = ['similar-a.png', 'similar-b.png', 'outlier-c.png'].map((name) => path.join(TMP, name));
  images.forEach((file, index) => {
    run(`INSERT INTO edit_clips(id,track_id,order_index,shot_id,render_id,file_path,src_in_ms,src_out_ms,start_ms,transition_in,transition_ms,gain_db,speed,title,subtitle_text,extra)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    `CL-QC-${index + 1}`, trackId, index, `SHOT-QC-${index + 1}`, null, '', 0, 1000, index * 1000,
    'cut', 0, 0, 1, `第${index + 1}镜`, '', JSON.stringify({ poster_path: file }));
  });
}

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    env: { ...process.env, FACTORY_DB: DB, FACTORY_DATA_DIR: DATA_DIR, FACTORY_CONFIG: CONFIG },
    encoding: 'utf8',
    timeout: 30000,
  });
}

try {
  writeGradientPng(path.join(TMP, 'similar-a.png'), 8, 232);
  writeGradientPng(path.join(TMP, 'similar-b.png'), 20, 244);
  writeGradientPng(path.join(TMP, 'outlier-c.png'), 232, 8);

  migrate();
  ensureEditSchema();
  insertTimeline('TL-QC-CONSISTENCY', 'S01E777', true);
  insertTimeline('TL-QC-EMPTY', 'S01E778', false);

  console.log('\n=== 1. JSON 抽检 ===');
  const jsonRun = runCli(['--timeline', 'TL-QC-CONSISTENCY', '--json']);
  let jsonReport = null;
  try { jsonReport = JSON.parse(jsonRun.stdout); } catch { /* 下方断言给出可读失败 */ }
  ok('CLI 正常退出', jsonRun.status === 0, `status=${jsonRun.status} stderr=${jsonRun.stderr.trim()}`);
  ok('JSON 可解析且抽检 3 镜', jsonReport?.checked === 3 && jsonReport?.skipped === 0,
    JSON.stringify(jsonReport?.summary || null));
  const outlier = jsonReport?.outliers?.find((item) => item.clip_id === 'CL-QC-3');
  ok('找出反向渐变离群镜', Boolean(outlier), JSON.stringify(jsonReport?.outliers || []));
  ok('离群距离大于阈值 20', Number(outlier?.distance) > 20, `distance=${outlier?.distance}`);

  console.log('\n=== 2. 中文报告 ===');
  const textRun = runCli(['--timeline', 'TL-QC-CONSISTENCY']);
  ok('中文报告包含抽检数/跳过数/离群镜头/建议',
    textRun.status === 0
    && textRun.stdout.includes('抽检数：3')
    && textRun.stdout.includes('跳过数：0')
    && textRun.stdout.includes('离群镜头')
    && textRun.stdout.includes('建议'));

  console.log('\n=== 3. 写入文件 ===');
  const outFile = path.join(TMP, 'qc-report.md');
  const outRun = runCli(['--timeline', 'TL-QC-CONSISTENCY', '--out', outFile]);
  ok('--out 写出报告', outRun.status === 0 && fs.existsSync(outFile) && fs.readFileSync(outFile, 'utf8').includes('# 成片一致性 QC 报告'));

  console.log('\n=== 4. 中文错误与退出码 ===');
  const missingRun = runCli(['--timeline', 'TL-NOT-FOUND']);
  ok('时间线不存在时中文报错且非 0', missingRun.status !== 0 && missingRun.stderr.includes('时间线不存在'),
    `status=${missingRun.status} stderr=${missingRun.stderr.trim()}`);
  const emptyRun = runCli(['--timeline', 'TL-QC-EMPTY']);
  ok('没有镜头时中文报错且非 0', emptyRun.status !== 0 && emptyRun.stderr.includes('没有镜头'),
    `status=${emptyRun.status} stderr=${emptyRun.stderr.trim()}`);

  console.log('\n=== 5. 测试隔离 ===');
  const realDb = path.resolve(ROOT, 'data', 'factory.db');
  ok('只使用临时库', path.resolve(process.env.FACTORY_DB) !== realDb && fs.existsSync(DB), process.env.FACTORY_DB);
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
if (fail) process.exitCode = 1;
