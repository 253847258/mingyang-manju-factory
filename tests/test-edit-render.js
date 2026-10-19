#!/usr/bin/env node
// 后期精修 · 真实 ffmpeg 渲染回归（含裁剪 / dissolve / 音频轨 / 版本落库）

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-render-'));
process.env.FACTORY_DB = path.join(TMP, 'edit.db');
process.env.FACTORY_DATA_DIR = path.join(TMP, 'data');
process.env.FACTORY_CONFIG = path.join(TMP, 'config.json');
fs.mkdirSync(process.env.FACTORY_DATA_DIR, { recursive: true });
fs.writeFileSync(process.env.FACTORY_CONFIG, JSON.stringify({ llm: { provider: 'mock' }, edit: { enabled: true } }));

const { migrate, run, get } = await import('../src/db.js');
const T = await import('../src/edit-timeline.js');
const { renderTimeline } = await import('../src/edit-render.js');
const { nowISO } = await import('../src/util.js');

migrate(); T.ensureEditSchema();
let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`  PASS ${n}${e ? ` -> ${e}` : ''}`); } else { fail++; console.error(`  FAIL ${n}${e ? ` -> ${e}` : ''}`); } };

// 造两段 1 秒素材（带音频）
const srcDir = path.join(TMP, 'src'); fs.mkdirSync(srcDir);
for (const i of [1, 2]) {
  const f = path.join(srcDir, `c${i}.mp4`);
  const r = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `testsrc=size=640x360:rate=30:duration=1`,
    '-f', 'lavfi', '-i', `sine=frequency=${400 + i * 100}:duration=1`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f], { encoding: 'utf8' });
  if (r.status !== 0) { console.error('造素材失败', r.stderr); process.exit(1); }
}

const now = nowISO();
run(`INSERT INTO script_episodes(id,script_id,season,episode,code,title,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`,
  'EP-R1', 'SC-R1', 1, 1, 'S01E001', '渲染测试集', 'storyboard', now, now);
for (const i of [1, 2]) {
  run(`INSERT INTO shots(id,script_id,episode_id,idx,duration,dialogue,transition,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)`,
    `SH-R${i}`, 'SC-R1', 'EP-R1', i, 1, i === 1 ? '第一句台词' : '第二句台词', 'cut', 'done', now);
  run(`INSERT INTO shot_renders(id,script_id,episode_id,shot_id,kind,file_path,status,picked,created_at) VALUES(?,?,?,?,?,?,?,?,?)`,
    `RD-R${i}`, 'SC-R1', 'EP-R1', `SH-R${i}`, 'video', path.join(srcDir, `c${i}.mp4`), 'done', 1, now);
}

const doc = T.createTimelineFromShots({ scriptId: 'SC-R1', episodeId: 'EP-R1', code: 'S01E001', operator: '剪辑A' });
const main = doc.tracks.find((t) => t.kind === 'main');

console.log('\n=== 1. 纯剪切：2 秒 ===');
let out = await renderTimeline(doc.timeline.id, { operator: '剪辑A' });
ok('产出文件存在且有体积', fs.existsSync(out.absFile) && out.size > 1000, `${out.size} 字节`);
ok('时长约 2 秒', Math.abs(out.duration - 2) < 0.2, `duration=${out.duration}`);
ok('写入 episode_films', !!get('SELECT * FROM episode_films WHERE id=?', out.filmId), out.filmId);
ok('写入版本记录', T.listVersions(doc.timeline.id).length === 1, '');

console.log('\n=== 2. 裁剪 + dissolve ===');
const edit = { tracks: doc.tracks.map((t) => ({ ...t, clips: (t.clips || []).map((c) => ({ ...c })) })) };
const em = edit.tracks.find((t) => t.kind === 'main');
em.clips[0].src_out_ms = 800;
em.clips[1].transition_in = 'dissolve';
em.clips[1].transition_ms = 300;
const saved = T.saveTimelineDoc(doc.timeline.id, edit, { docVersion: doc.timeline.doc_version, operator: '剪辑A' });
out = await renderTimeline(doc.timeline.id, { operator: '剪辑A' });
const expect = 0.8 + 1 - 0.3;
ok('转场后时长符合预期（约 1.5 秒）', Math.abs(out.duration - expect) < 0.25, `duration=${out.duration} expect≈${expect}`);
ok('第二个版本已落库', T.listVersions(doc.timeline.id).length === 2, '');
ok('成片可被 ffprobe 读取', Number(out.duration) > 0, '');

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(fail ? 1 : 0);
