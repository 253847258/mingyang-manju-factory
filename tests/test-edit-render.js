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
const readRgbFrame = (file, at) => {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(at), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: null, maxBuffer: 1920 * 1080 * 3 + 1024 * 1024 });
  return r.status === 0 ? r.stdout : Buffer.alloc(0);
};

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
  run(`INSERT INTO shot_renders(id,script_id,episode_id,shot_id,kind,file_path,status,picked,backend,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
    `RD-R${i}`, 'SC-R1', 'EP-R1', `SH-R${i}`, 'video', path.join(srcDir, `c${i}.mp4`), 'done', 1, 'placeholder', now);
}

const doc = T.createTimelineFromShots({ scriptId: 'SC-R1', episodeId: 'EP-R1', code: 'S01E001', operator: '剪辑A' });
const main = doc.tracks.find((t) => t.kind === 'main');

console.log('\n=== 1. 纯剪切：2 秒 ===');
let out = await renderTimeline(doc.timeline.id, { operator: '剪辑A' });
ok('产出文件存在且有体积', fs.existsSync(out.absFile) && out.size > 1000, `${out.size} 字节`);
ok('时长约 2 秒', Math.abs(out.duration - 2) < 0.2, `duration=${out.duration}`);
ok('写入 episode_films', !!get('SELECT * FROM episode_films WHERE id=?', out.filmId), out.filmId);
ok('占位素材被标记为不可交付', out.placeholder === true && out.placeholderClips === 2, JSON.stringify({ placeholder: out.placeholder, n: out.placeholderClips }));
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

console.log('\n=== 3. 竖屏 9:16 + 降噪 ===');
out = await renderTimeline(doc.timeline.id, { operator: '剪辑A', aspect: '9:16', denoise: true });
const vp = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', out.absFile], { encoding: 'utf8' });
const st = JSON.parse(vp.stdout || '{}').streams?.[0];
ok('输出 1080x1920', st && st.width === 1080 && st.height === 1920, `${st?.width}x${st?.height}`);
ok('竖屏版本已落库', T.listVersions(doc.timeline.id).length === 3, '');

console.log('\n=== 4. 电影感（24fps + 颗粒 + 调色）===');
out = await renderTimeline(doc.timeline.id, { operator: '剪辑A', aspect: '16:9', profile: 'cinematic' });
const fp = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate', '-of', 'json', out.absFile], { encoding: 'utf8' }).stdout || '{}');
const st2 = fp.streams?.[0];
ok('输出 24fps', st2?.r_frame_rate === '24/1', st2?.r_frame_rate);
ok('结果标记 cinematic', out.profile === 'cinematic', out.profile);
ok('电影感版本已落库', T.listVersions(doc.timeline.id).length === 4, '');

console.log('\n=== 5. 2.39:1 遮幅 + LUT ===');
const lbSrc = path.join(srcDir, 'letterbox.mp4');
const lbSource = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
  '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=30:d=1',
  '-f', 'lavfi', '-i', 'sine=frequency=300:duration=1',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', lbSrc], { encoding: 'utf8' });
if (lbSource.status !== 0) { console.error('造遮幅素材失败', lbSource.stderr); process.exit(1); }
run(`INSERT INTO shots(id,script_id,episode_id,idx,duration,dialogue,transition,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)`,
  'SH-LB3', 'SC-R1', 'EP-R1', 3, 1, '遮幅字幕仍可见', 'cut', 'done', now);
run(`INSERT INTO shot_renders(id,script_id,episode_id,shot_id,kind,file_path,status,picked,backend,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
  'RD-LB3', 'SC-R1', 'EP-R1', 'SH-LB3', 'video', lbSrc, 'done', 1, 'test', now);
const lbDoc = T.createTimelineFromShots({ scriptId: 'SC-R1', episodeId: 'EP-R1', code: 'S01E001-LB', operator: '剪辑A' });
const identityLut = path.join(TMP, 'identity.cube');
fs.writeFileSync(identityLut, [
  'TITLE "Identity"', 'LUT_3D_SIZE 2', 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 1 1',
  '0 0 0', '1 0 0', '0 1 0', '1 1 0', '0 0 1', '1 0 1', '0 1 1', '1 1 1', '',
].join('\n'));
out = await renderTimeline(lbDoc.timeline.id, { operator: '剪辑A', letterbox: true, lut: identityLut });
const lbProbe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', out.absFile], { encoding: 'utf8' });
const lbStream = JSON.parse(lbProbe.stdout || '{}').streams?.[0];
const firstFrame = readRgbFrame(out.absFile, 0.4);
const subtitleFrame = readRgbFrame(out.absFile, 2.4);
const pixelAt = (buf, x, y) => {
  const i = (y * 1920 + x) * 3;
  return [buf[i] ?? -1, buf[i + 1] ?? -1, buf[i + 2] ?? -1];
};
let barsBlack = firstFrame.length >= 1920 * 1080 * 3;
let contentPixels = 0;
for (let x = 0; x < 1920; x += 16) {
  if (pixelAt(firstFrame, x, 10).some((v) => v > 8) || pixelAt(firstFrame, x, 1070).some((v) => v > 8)) barsBlack = false;
}
for (let y = 200; y < 900; y += 20) {
  for (let x = 100; x < 1820; x += 20) {
    if (pixelAt(firstFrame, x, y).some((v) => v > 30)) contentPixels += 1;
  }
}
let subtitlePixels = 0;
for (let y = 138; y < 942; y += 1) {
  for (let x = 240; x < 1680; x += 1) {
    if (pixelAt(subtitleFrame, x, y).every((v) => v > 180)) subtitlePixels += 1;
  }
}
ok('遮幅输出 1920×1080，黑边存在且字幕在画面内', lbStream?.width === 1920 && lbStream?.height === 1080 && out.letterbox === true && out.lut === identityLut && barsBlack && contentPixels > 10 && subtitlePixels > 20, `${lbStream?.width}x${lbStream?.height} bars=${barsBlack} content=${contentPixels} subtitlePixels=${subtitlePixels}`);

let lutError = '';
try {
  await renderTimeline(lbDoc.timeline.id, { operator: '剪辑A', lut: path.join(TMP, 'missing.cube') });
} catch (e) { lutError = e.message; }
ok('不存在的 LUT 返回明确中文错误', /LUT 文件不存在/.test(lutError) && /[\u4e00-\u9fff]/.test(lutError), lutError);

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(fail ? 1 : 0);
