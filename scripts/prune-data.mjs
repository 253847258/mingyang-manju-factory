#!/usr/bin/env node
// 运行态数据保留策略（开发评估 P0-4）
//
// 默认**只预览不删除**；确认后再加 --apply 真正执行。
//
//   node scripts/prune-data.mjs                     # 预览（默认）
//   node scripts/prune-data.mjs --apply             # 按默认阈值执行
//   node scripts/prune-data.mjs --deliveries-keep 10 --deliveries-cap-mb 2048
//   node scripts/prune-data.mjs --json              # 机器可读输出
//
// 策略：
//   data/deliveries  交付包 zip —— 保留最近 N 个 且 总量 ≤ cap；超出部分按 mtime 由旧到新删
//   data/finish      整集成片   —— 保留最近 N 个
//   data/thumbs      缩略图缓存 —— 可再生，保留最近 D 天
//   data/images / data/videos / data/uploads / data/subtitles / data/publish
//                    —— **只统计不删除**（可能被数据库引用，自动删有丢作品风险）

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const DATA = path.resolve(ROOT, 'data');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const num = (flag, dflt) => {
  const i = argv.indexOf(flag);
  if (i < 0 || i + 1 >= argv.length) return dflt;
  const v = Number(argv[i + 1]);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
};

const APPLY = has('--apply');
const JSON_OUT = has('--json');
const KEEP_DELIVERIES = num('--deliveries-keep', 20);
const CAP_DELIVERIES_MB = num('--deliveries-cap-mb', 5120);
const KEEP_FINISH = num('--finish-keep', 10);
const THUMBS_DAYS = num('--thumbs-days', 30);

const mb = (b) => Math.round((b / 1024 / 1024) * 10) / 10;

// 递归收集文件（data/images、data/finish 等内部还有一层子目录）
function listFiles(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { listFiles(p, acc); continue; }
    const st = fs.statSync(p);
    acc.push({ path: p, name: e.name, size: st.size, mtime: st.mtimeMs });
  }
  return acc.sort((a, b) => b.mtime - a.mtime);    // 新 → 旧
}

function assertInsideData(p) {
  const r = path.resolve(p);
  if (!r.startsWith(DATA + path.sep)) throw new Error(`拒绝操作 data/ 之外的路径：${r}`);
  return r;
}

const report = { mode: APPLY ? 'apply' : 'dry-run', generatedAt: new Date().toISOString(), categories: {}, reclaimableBytes: 0, deletedBytes: 0 };

function planCategory(name, files, keepPredicate, note) {
  // 注意：必须把 index 传给 keepPredicate，否则「保留最近 N 个」会被判成「一个都不留」
  const remove = files.filter((f, i) => !keepPredicate(f, i));
  const bytes = remove.reduce((n, f) => n + f.size, 0);
  report.categories[name] = { files: files.length, bytes: files.reduce((n, f) => n + f.size, 0), remove: remove.length, removeBytes: bytes, note };
  report.reclaimableBytes += bytes;
  return remove;
}

// 1) deliveries：保最近 N 个 + 总量封顶
const deliveries = listFiles(path.join(DATA, 'deliveries'));
let acc = 0;
const keepDelivery = new Set();
deliveries.forEach((f, i) => {
  const withinCount = i < KEEP_DELIVERIES;
  const withinCap = acc + f.size <= CAP_DELIVERIES_MB * 1024 * 1024;
  if (withinCount && withinCap) { keepDelivery.add(f.path); acc += f.size; }
});
const removeDeliveries = planCategory('deliveries', deliveries, (f) => keepDelivery.has(f.path),
  `保留最近 ${KEEP_DELIVERIES} 个且总量 ≤ ${CAP_DELIVERIES_MB} MB`);

// 2) finish：保最近 N 个
const finish = listFiles(path.join(DATA, 'finish'));
const removeFinish = planCategory('finish', finish, (_f, i) => i < KEEP_FINISH, `保留最近 ${KEEP_FINISH} 个`);

// 3) thumbs：可再生缓存，保最近 D 天
const thumbs = listFiles(path.join(DATA, 'thumbs'));
const cutoff = Date.now() - THUMBS_DAYS * 86400 * 1000;
const removeThumbs = planCategory('thumbs', thumbs, (f) => f.mtime >= cutoff, `保留最近 ${THUMBS_DAYS} 天`);

// 4) 只统计不删除的保护目录
for (const name of ['images', 'videos', 'uploads', 'subtitles', 'publish']) {
  const files = listFiles(path.join(DATA, name));
  report.categories[name] = {
    files: files.length,
    bytes: files.reduce((n, f) => n + f.size, 0),
    remove: 0,
    removeBytes: 0,
    note: '只统计不删除（可能被数据库引用；如需清理请先核对引用）',
  };
}

const toRemove = [...removeDeliveries, ...removeFinish, ...removeThumbs];
if (APPLY) {
  for (const f of toRemove) {
    const p = assertInsideData(f.path);
    try { fs.unlinkSync(p); report.deletedBytes += f.size; } catch (e) { report.categories._errors = [...(report.categories._errors || []), `${path.relative(ROOT, p)}: ${e.message}`]; }
  }
}

report.reclaimableMB = mb(report.reclaimableBytes);
report.deletedMB = mb(report.deletedBytes);

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`数据保留策略（${APPLY ? '已执行' : '预览模式，未删除任何文件'}）`);
  console.log(`data 根目录：${DATA}\n`);
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`${pad('目录', 12)}${pad('文件', 8)}${pad('体积MB', 10)}${pad('待清理', 8)}${pad('可回收MB', 10)}说明`);
  for (const [name, c] of Object.entries(report.categories)) {
    if (name.startsWith('_')) continue;
    console.log(`${pad(name, 12)}${pad(c.files, 8)}${pad(mb(c.bytes), 10)}${pad(c.remove, 8)}${pad(mb(c.removeBytes), 10)}${c.note}`);
  }
  console.log(`\n合计可回收：${report.reclaimableMB} MB${APPLY ? `（实际已删 ${report.deletedMB} MB）` : ''}`);
  if (report.categories._errors) console.log('删除失败：\n  ' + report.categories._errors.join('\n  '));
  if (!APPLY) console.log('\n确认无误后加 --apply 执行；只读预览不会改动任何文件。');
}
