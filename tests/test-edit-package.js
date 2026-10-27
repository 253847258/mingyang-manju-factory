#!/usr/bin/env node
// 后期精修 P1：工程包（代理 + EDL/FCP7/OTIO）与回灌差异

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-package-'));
process.env.FACTORY_DB = path.join(TMP, 'pkg.db');
process.env.FACTORY_DATA_DIR = path.join(TMP, 'data');
process.env.FACTORY_CONFIG = path.join(TMP, 'config.json');
fs.mkdirSync(process.env.FACTORY_DATA_DIR, { recursive: true });
fs.writeFileSync(process.env.FACTORY_CONFIG, JSON.stringify({ llm: { provider: 'mock' }, edit: { enabled: true } }));

const { migrate, run } = await import('../src/db.js');
const T = await import('../src/edit-timeline.js');
const P = await import('../src/edit-package.js');
const I = await import('../src/edit-import.js');
const { nowISO } = await import('../src/util.js');

migrate(); T.ensureEditSchema();
let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`  PASS ${n}${e ? ` -> ${e}` : ''}`); } else { fail++; console.error(`  FAIL ${n}${e ? ` -> ${e}` : ''}`); } };

const srcDir = path.join(TMP, 'src'); fs.mkdirSync(srcDir);
for (const i of [1, 2]) {
  const f = path.join(srcDir, `s${i}.mp4`);
  const r = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30:duration=2',
    '-f', 'lavfi', '-i', `sine=frequency=${300 + i * 100}:duration=2`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f], { encoding: 'utf8' });
  if (r.status !== 0) { console.error(r.stderr); process.exit(1); }
}

const now = nowISO();
run(`INSERT INTO script_episodes(id,script_id,season,episode,code,title,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`,
  'EP-P1', 'SC-P1', 1, 1, 'S01E001', '工程包测试', 'storyboard', now, now);
for (const i of [1, 2]) {
  run(`INSERT INTO shots(id,script_id,episode_id,idx,duration,dialogue,transition,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)`,
    `SH-P${i}`, 'SC-P1', 'EP-P1', i, 2, i === 1 ? '第一句' : '第二句', 'cut', 'done', now);
  run(`INSERT INTO shot_renders(id,script_id,episode_id,shot_id,kind,file_path,status,picked,backend,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
    `RD-P${i}`, 'SC-P1', 'EP-P1', `SH-P${i}`, 'video', path.join(srcDir, `s${i}.mp4`), 'done', 1, 'placeholder', now);
}

const doc = T.createTimelineFromShots({ scriptId: 'SC-P1', episodeId: 'EP-P1', code: 'S01E001', operator: '剪辑A' });
const main = doc.tracks.find((t) => t.kind === 'main');
const edit = { tracks: doc.tracks.map((t) => ({ ...t, clips: (t.clips || []).map((c) => ({ ...c })) })) };
const em = edit.tracks.find((t) => t.kind === 'main');
em.clips[0].src_in_ms = 200; em.clips[0].src_out_ms = 800; // 裁剪 0.2-0.8s
const saved = T.saveTimelineDoc(doc.timeline.id, edit, { docVersion: doc.timeline.doc_version, operator: '剪辑A' });
ok('准备：主轨 2 镜，首镜裁剪 0.6s', saved.tracks.find((t) => t.kind === 'main').clips[0].src_out_ms === 800, '');

console.log('\n=== 1. 导出工程包 ===');
const pkg = P.buildEditPackage(doc.timeline.id, { operator: '剪辑A', withProxy: true, height: 540 });
ok('生成 zip', fs.existsSync(pkg.absFile) && pkg.size > 1000, `${Math.round(pkg.size / 1024)} KB`);
ok('工程包标注占位素材', pkg.manifest.placeholder === true && pkg.manifest.placeholder_clips === 2, JSON.stringify({ p: pkg.manifest.placeholder, n: pkg.manifest.placeholder_clips }));
const list = spawnSync('unzip', ['-l', pkg.absFile], { encoding: 'utf8' }).stdout;
for (const name of ['timeline.edl', 'timeline.xml', 'timeline.otio', 'manifest.json', 'manifest.csv', 'README.txt']) {
  ok(`包含 ${name}`, list.includes(name), '');
}
ok('包含 2 个代理素材', (list.match(/proxies\//g) || []).length >= 2 && pkg.proxyCount === 2, `proxy=${pkg.proxyCount}`);

console.log('\n=== 2. FCP7 往返（保留裁剪入点）===');
const xml = spawnSync('unzip', ['-p', pkg.absFile, 'timeline.xml'], { encoding: 'utf8' }).stdout;
const parsed = I.parseImport(xml);
ok('能解析回 2 个片段', parsed.ok && parsed.clips.length === 2, parsed.error || '');
ok('首镜 sourceIn = 0.2s（裁剪点已保留）', Math.abs(parsed.clips[0].sourceIn - 0.2) < 0.02, String(parsed.clips[0].sourceIn));
const diff = I.diffTimeline(saved, parsed);
ok('原样回灌：无差异', diff.changed === false && diff.added.length === 0 && diff.reordered.length === 0 && diff.trimmed.length === 0,
  JSON.stringify({ a: diff.added.length, r: diff.removed.length, o: diff.reordered.length, t: diff.trimmed.length }));

console.log('\n=== 3. 回灌差异（交换顺序）===');
const otio = JSON.parse(spawnSync('unzip', ['-p', pkg.absFile, 'timeline.otio'], { encoding: 'utf8' }).stdout);
const track = otio.tracks.children[0];
track.children = [track.children[1], track.children[0]];
const swapped = JSON.stringify(otio);
const d2 = I.diffTimeline(saved, I.parseImport(swapped));
ok('识别出重排（两段都换位 → 2 条）', d2.changed === true && d2.reordered.length === 2, JSON.stringify({ o: d2.reordered.length }));
const applied = I.applyImport(doc.timeline.id, { content: swapped, docVersion: saved.timeline.doc_version, operator: '剪辑A' });
const newMain = applied.doc.tracks.find((t) => t.kind === 'main');
ok('应用后顺序真的交换了', newMain.clips[0].file_path.includes('s2.mp4') && newMain.clips[1].file_path.includes('s1.mp4'),
  newMain.clips.map((c) => path.basename(c.file_path)).join(','));
ok('应用后 doc_version 递增', applied.doc.timeline.doc_version === saved.timeline.doc_version + 1, `v=${applied.doc.timeline.doc_version}`);

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(fail ? 1 : 0);
