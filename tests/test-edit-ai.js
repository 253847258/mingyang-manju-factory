#!/usr/bin/env node
// 后期精修 P2：卡点 / 字幕 CPS / 粗剪 / 跨镜一致性

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-ai-'));
process.env.FACTORY_DB = path.join(TMP, 'ai.db');
process.env.FACTORY_CONFIG = path.join(TMP, 'config.json');
const AI = await import('../src/edit-ai.js');

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`  PASS ${n}${e ? ` -> ${e}` : ''}`); } else { fail++; console.error(`  FAIL ${n}${e ? ` -> ${e}` : ''}`); } };

console.log('\n=== 1. BGM 卡点 ===');
const wav = path.join(TMP, 'click.wav');
const r = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
  '-f', 'lavfi', '-i', "aevalsrc='if(lt(mod(t,0.5),0.03),0.9*sin(2*PI*1200*t),0)':d=4:s=22050", wav], { encoding: 'utf8' });
if (r.status !== 0) { console.error(r.stderr); process.exit(1); }
const beats = AI.detectBeats(wav);
ok('检出卡点数量合理（4 秒 / 0.5 秒一次）', beats.ok && beats.count >= 6 && beats.count <= 10, `count=${beats.count}`);
const near = beats.beats.filter((t) => Math.abs((t * 2) - Math.round(t * 2)) < 0.12).length;
ok('卡点落在 0.5 秒网格上', near >= Math.max(5, Math.floor(beats.count * 0.7)), `grid=${near}/${beats.count} bpm=${beats.bpm}`);
ok('返回时长', Math.abs(beats.duration - 4) < 0.2, String(beats.duration));

console.log('\n=== 2. 字幕 CPS ===');
const doc = {
  tracks: [
    { kind: 'main', clips: Array.from({ length: 5 }, (_, i) => ({ id: `C${i}`, order_index: i, title: `镜${i + 1}`, src_in_ms: 0, src_out_ms: 5000, start_ms: i * 5000, file_path: '', subtitle_text: '' })) },
    { kind: 'subtitle', clips: [
      { id: 'S1', start_ms: 0, src_in_ms: 0, src_out_ms: 1000, subtitle_text: '这一句话有二十多个汉字必须在一秒内读完' },
      { id: 'S2', start_ms: 5000, src_in_ms: 0, src_out_ms: 2000, subtitle_text: '正常语速' },
    ] },
  ],
};
const an = AI.analyzeSubtitles(doc, { maxCps: 9, maxCharsPerLine: 12 });
ok('识别语速过快', an.issues.some((i) => i.type === 'cps' && i.clip_id === 'S1'), JSON.stringify(an.summary));
ok('识别行过长', an.issues.some((i) => i.type === 'line' && i.clip_id === 'S1'), '');
const fix = AI.autoFixSubtitles(doc, { maxCps: 9, maxCharsPerLine: 14 });
ok('自动修复有改动', fix.changed && fix.fixes.length >= 1, JSON.stringify(fix.fixes));
ok('修复后语速达标（≤9）', (() => {
  const s1 = doc.tracks[1].clips.find((c) => c.id === 'S1');
  const chars = [...s1.subtitle_text.replace(/\s/g, '')].length;
  return chars / ((s1.src_out_ms - s1.src_in_ms) / 1000) <= 9.01;
})());
ok('长行被拆成多行', String(doc.tracks[1].clips.find((c) => c.id === 'S1').subtitle_text).includes('\n'), '');

console.log('\n=== 3. 粗剪方案 ===');
const before = JSON.stringify(doc.tracks[0]);
const plan = AI.proposeRoughCut(doc, { targetSeconds: 15, maxShotMs: 4000 });
ok('给出删/缩方案', plan.changed && (plan.drops.length + plan.trims.length) > 0, JSON.stringify({ drops: plan.drops.length, trims: plan.trims.length, after: plan.after }));
ok('方案不修改原时间线（可审阅）', JSON.stringify(doc.tracks[0]) === before, '');
ok('预计时长收敛到目标附近', plan.after <= plan.target + 0.01, `${plan.before}s → ${plan.after}s (target ${plan.target})`);
const applied = AI.applyRoughCut(doc, plan);
ok('应用后主轨变短且顺序重排', applied.tracks[0].clips.length === 5 - plan.drops.length
  && applied.tracks[0].clips.every((c, i) => c.order_index === i), `kept=${applied.kept}`);

console.log('\n=== 4. 跨镜一致性 ===');
const imgs = [];
for (const [name, src] of [['a', 'testsrc=size=320x240:rate=1:duration=1'], ['b', 'testsrc=size=320x240:rate=1:duration=1'], ['c', 'smptebars=size=320x240:rate=1:duration=1']]) {
  const f = path.join(TMP, `kf_${name}.png`);
  const rr = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', src, '-frames:v', '1', f], { encoding: 'utf8' });
  if (rr.status === 0) imgs.push(f);
}
const cdoc = { tracks: [{ kind: 'main', clips: imgs.map((f, i) => ({ id: `K${i}`, title: `镜${i}`, order_index: i, src_in_ms: 0, src_out_ms: 3000, file_path: '', extra: { poster_path: f } })) }] };
const con = await AI.analyzeConsistency(cdoc);
ok('执行了抽检', con.ok && con.checked === imgs.length, JSON.stringify(con.summary));
ok('找出离群镜（测试图 vs 彩条图）', con.outliers.length >= 1, JSON.stringify(con.outliers.map((x) => x.distance)));

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(fail ? 1 : 0);
