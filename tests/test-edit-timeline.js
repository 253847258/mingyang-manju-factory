#!/usr/bin/env node
// 后期精修 · 时间线/版本/审片/审计 回归

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-timeline-'));
process.env.FACTORY_DB = path.join(TMP, 'edit.db');
process.env.FACTORY_DATA_DIR = path.join(TMP, 'data');
process.env.FACTORY_CONFIG = path.join(TMP, 'config.json');
fs.mkdirSync(process.env.FACTORY_DATA_DIR, { recursive: true });
fs.writeFileSync(process.env.FACTORY_CONFIG, JSON.stringify({ llm: { provider: 'mock' }, edit: { enabled: true } }));

const { migrate, run, get } = await import('../src/db.js');
const T = await import('../src/edit-timeline.js');
const { nowISO } = await import('../src/util.js');

migrate();
T.ensureEditSchema();
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  PASS ${name}${extra ? ` -> ${extra}` : ''}`); }
  else { fail += 1; console.error(`  FAIL ${name}${extra ? ` -> ${extra}` : ''}`); }
};
const throws = (fn, re, name) => {
  try { fn(); ok(name, false, '未抛错'); } catch (e) { ok(name, re.test(e.message), e.message.slice(0, 60)); }
};

const now = nowISO();
run(`INSERT INTO script_episodes(id,script_id,season,episode,code,title,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`,
  'EP-E1', 'SC-E1', 1, 1, 'S01E001', '测试集', 'storyboard', now, now);
for (let i = 1; i <= 3; i += 1) {
  run(`INSERT INTO shots(id,script_id,episode_id,idx,duration,dialogue,transition,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)`,
    `SH-E${i}`, 'SC-E1', 'EP-E1', i, 2, i === 1 ? '第一句台词' : '', 'cut', 'done', now);
  if (i <= 2) {
    run(`INSERT INTO shot_renders(id,script_id,episode_id,shot_id,kind,file_path,status,picked,created_at) VALUES(?,?,?,?,?,?,?,?,?)`,
      `RD-E${i}`, 'SC-E1', 'EP-E1', `SH-E${i}`, 'video', `data/videos/e${i}.mp4`, 'done', 1, now);
  }
}

console.log('\n=== 1. 建时间线（从分镜快照）===');
const doc = T.createTimelineFromShots({ scriptId: 'SC-E1', episodeId: 'EP-E1', code: 'S01E001', operator: '剪辑A' });
ok('4 条轨道（主/画中画/字幕/音频）', doc.tracks.length === 4, doc.tracks.map((t) => t.kind).join(','));
const main = doc.tracks.find((t) => t.kind === 'main');
ok('主轨 3 个片段', main.clips.length === 3, `clips=${main.clips.length}`);
ok('片段按顺序累计 start_ms', main.clips[0].start_ms === 0 && main.clips[1].start_ms === 2000 && main.clips[2].start_ms === 4000,
  main.clips.map((c) => c.start_ms).join(','));
const subClips = doc.tracks.find((t) => t.kind === 'subtitle').clips || [];
ok('对白自动生成字幕片段', subClips.length === 1 && /第一句台词/.test(subClips[0].subtitle_text || ''), subClips.map((c) => c.subtitle_text).join('|'));

console.log('\n=== 2. 乐观锁与保存 ===');
const bad = { tracks: doc.tracks.map((t) => ({ ...t, clips: t.clips })) };
throws(() => T.saveTimelineDoc(doc.timeline.id, bad, { docVersion: 999, operator: '剪辑A' }), /已被他人修改/, '旧 doc_version 被拒绝（409）');
const edited = { tracks: doc.tracks.map((t) => ({ ...t, clips: (t.clips || []).map((c) => ({ ...c })) })) };
const m2 = edited.tracks.find((t) => t.kind === 'main');
m2.clips[0].src_out_ms = 1500;
m2.clips[1].transition_in = 'dissolve';
m2.clips[1].transition_ms = 400;
const saved = T.saveTimelineDoc(doc.timeline.id, edited, { docVersion: doc.timeline.doc_version, operator: '剪辑A' });
ok('保存成功并递增 doc_version', saved.timeline.doc_version === doc.timeline.doc_version + 1, `v=${saved.timeline.doc_version}`);
ok('裁剪写入生效', saved.tracks.find((t) => t.kind === 'main').clips[0].src_out_ms === 1500, '');
ok('转场写入生效', saved.tracks.find((t) => t.kind === 'main').clips[1].transition_in === 'dissolve', '');

console.log('\n=== 3. 审计 ===');
const logs = T.listAudit(doc.timeline.id);
ok('创建与保存都有审计', logs.some((l) => l.action === 'create') && logs.some((l) => l.action === 'save'), `logs=${logs.length}`);
ok('审计记录了操作人', logs.every((l) => l.actor === '剪辑A'), logs[0]?.actor);

console.log('\n=== 4. 审片门禁 ===');
throws(() => T.setReviewStatus(doc.timeline.id, 'review', { operator: '导演B' }), /可播放的成片/, '没有成片不能送审');
run(`INSERT INTO episode_films(id,script_id,episode_id,code,file_path,duration,size,shot_count,backend,status,created_at,timeline_id,version_no,review_status,operator)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, 'FM-E1', 'SC-E1', 'EP-E1', 'S01E001', 'data/finish/e1.mp4', 6, 1000, 3, 'edit-ffmpeg', 'done', now, doc.timeline.id, 1, 'draft', '剪辑A');
ok('有成片后可送审', T.setReviewStatus(doc.timeline.id, 'review', { operator: '导演B' }).status === 'review', '');
T.addComment(doc.timeline.id, { timecode_ms: 1500, severity: 'blocker', body: '字幕压到画面外', author: '导演B' });
throws(() => T.setReviewStatus(doc.timeline.id, 'approved', { operator: '导演B' }), /阻断/, '有阻断意见不能通过');
const cm = T.listComments(doc.timeline.id)[0];
T.updateComment(cm.id, { status: 'fixed' }, { operator: '剪辑A' });
ok('处理后可通过', T.setReviewStatus(doc.timeline.id, 'approved', { operator: '导演B' }).status === 'approved', '');
ok('可锁定终版', T.setReviewStatus(doc.timeline.id, 'locked', { operator: '导演B' }).status === 'locked', '');
throws(() => T.saveTimelineDoc(doc.timeline.id, edited, { docVersion: 3, operator: '剪辑A' }), /已锁定/, '锁定后禁止修改');
throws(() => T.setReviewStatus(doc.timeline.id, 'draft', { operator: '导演B' }), /不能从/, '锁定后不能回退');

console.log('\n=== 5. 版本快照 ===');
const no = T.recordVersion(doc.timeline.id, { filmId: 'FM-E1', docVersion: 2, snapshot: saved, note: 'v1', operator: '剪辑A' });
ok('记录版本号', no === 1, `no=${no}`);
ok('版本列表可读', T.listVersions(doc.timeline.id).length === 1, '');

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(fail ? 1 : 0);
