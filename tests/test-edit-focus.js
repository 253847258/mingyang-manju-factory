#!/usr/bin/env node
// 竖屏智能重构：主体对焦检测 + 9:16 裁切渲染（不是加黑边）

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-focus-'));
process.env.FACTORY_DB = path.join(TMP, 'focus.db');
process.env.FACTORY_DATA_DIR = path.join(TMP, 'data');
process.env.FACTORY_CONFIG = path.join(TMP, 'config.json');
fs.mkdirSync(process.env.FACTORY_DATA_DIR, { recursive: true });
fs.writeFileSync(process.env.FACTORY_CONFIG, JSON.stringify({ llm: { provider: 'mock' }, edit: { enabled: true } }));

const { migrate, run } = await import('../src/db.js');
const T = await import('../src/edit-timeline.js');
const AI = await import('../src/edit-ai.js');
const { renderTimeline } = await import('../src/edit-render.js');
const { nowISO } = await import('../src/util.js');

migrate(); T.ensureEditSchema();
let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`  PASS ${n}${e ? ` -> ${e}` : ''}`); } else { fail++; console.error(`  FAIL ${n}${e ? ` -> ${e}` : ''}`); } };

// 右侧白块 / 左侧白块
const mk = (name, x) => {
  const f = path.join(TMP, `${name}.png`);
  const r = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'color=c=black:s=320x180:d=1', '-vf', `drawbox=x=${x}:y=0:w=80:h=180:color=white:t=fill`, '-frames:v', '1', f], { encoding: 'utf8' });
  if (r.status !== 0) { console.error(r.stderr); process.exit(1); }
  return f;
};
const right = mk('right', 220);
const left = mk('left', 20);

console.log('\n=== 1. 主体焦点检测 ===');
const fr = await AI.detectFocusX(right);
const fl = await AI.detectFocusX(left);
ok('右侧主体 → 焦点偏右', fr.focusX > 0.6, `focusX=${fr.focusX} conf=${fr.confidence}`);
ok('左侧主体 → 焦点偏左', fl.focusX < 0.4, `focusX=${fl.focusX} conf=${fl.confidence}`);

console.log('\n=== 2. 9:16 智能裁切渲染 ===');
const now = nowISO();
run(`INSERT INTO script_episodes(id,script_id,season,episode,code,title,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`,
  'EP-F1', 'SC-F1', 1, 1, 'S01E001', '对焦测试', 'storyboard', now, now);
run(`INSERT INTO shots(id,script_id,episode_id,idx,duration,dialogue,transition,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)`,
  'SH-F1', 'SC-F1', 'EP-F1', 1, 2, '', 'cut', 'done', now);
run(`INSERT INTO shot_renders(id,script_id,episode_id,shot_id,kind,file_path,status,picked,created_at) VALUES(?,?,?,?,?,?,?,?,?)`,
  'RD-F1', 'SC-F1', 'EP-F1', 'SH-F1', 'keyframe', right, 'done', 1, now);

const doc = T.createTimelineFromShots({ scriptId: 'SC-F1', episodeId: 'EP-F1', code: 'S01E001', operator: '剪辑A' });
const focus = await AI.autoFocusClips(doc);
ok('自动对焦覆盖主轨', focus.ok && focus.applied.length === 1, JSON.stringify({ applied: focus.applied.length, skipped: focus.skipped }));
const main = doc.tracks.find((t) => t.kind === 'main');
main.clips[0].extra = { ...(main.clips[0].extra || {}), focus_x: focus.applied[0].focusX };
const saved = T.saveTimelineDoc(doc.timeline.id, { tracks: doc.tracks }, { docVersion: doc.timeline.doc_version, operator: '剪辑A' });

const out = await renderTimeline(doc.timeline.id, { operator: '剪辑A', aspect: '9:16' });
const probe = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', out.absFile], { encoding: 'utf8' }).stdout || '{}');
const st = probe.streams?.[0];
ok('输出 1080x1920', st?.width === 1080 && st?.height === 1920, `${st?.width}x${st?.height}`);

const frame = path.join(TMP, 'out.png');
spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-ss', '0.5', '-i', out.absFile, '-frames:v', '1', frame]);
const sharp = (await import('sharp')).default;
const { data, info } = await sharp(frame).greyscale().raw().toBuffer({ resolveWithObject: true });
const px = (x, y) => data[y * info.width + x];
const center = px(Math.floor(info.width / 2), Math.floor(info.height / 2));
let sum = 0; for (const v of data) sum += v;
const mean = sum / data.length;
ok('画面中心是主体（白块被裁到中间）', center > 180, `center=${center}`);
ok('整体亮度正常（不是黑边主导）', mean > 110, `mean=${mean.toFixed(1)}`);

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(fail ? 1 : 0);
