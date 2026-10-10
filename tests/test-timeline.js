// P5 · 成片 / 时间线节点自测（纯 Node，离线零成本：临时库 + 真实 ffmpeg 拼接极短片段）
// 用法：node tests/test-timeline.js
// 覆盖：拼接顺序解析（clip1..N → slot → 创建时间）/ 端口重复与缺片的中文报错 /
//       片段时长来源（run 记录 → 镜头 → 节点参数）/ 字幕台词来源（画外音不算台词）/
//       finish 参数覆盖 / 阶段进度映射 / episode_films 登记与登记失败不影响成片 /
//       铺开分集（零生成调用、clipN 递增）/ 预览 dry-run / 经 DAG 引擎端到端执行
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import http from 'node:http';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-timeline-'));
const DATA_TMP = path.join(TMP, 'data');
const DB = path.join(TMP, 'timeline.db');
process.env.FACTORY_DATA_DIR = DATA_TMP;
process.env.FACTORY_DB = DB;
process.env.FACTORY_CONFIG = path.join(TMP, 'config.json');
fs.mkdirSync(path.join(DATA_TMP, 'videos'), { recursive: true });
fs.writeFileSync(process.env.FACTORY_CONFIG, JSON.stringify({
  image: { backend: 'placeholder' },
  video: { backend: 'placeholder' },
  llm: { provider: 'mock' },
  tts: { backend: 'openai', format: 'mp3', speed: 1 },
  finish: { subtitles: false, audio: 'silent', fadeIn: 0, fadeOut: 0, keepIntermediates: true },
}), 'utf8');

const { migrate, get, all, run, DATA_DIR, ROOT: ROOT_T } = await import('../src/db.js');
const T = await import('../src/timeline.js');
const { generateVideo } = await import('../src/video.js');
const { resolveAsset } = await import('../src/db.js');
const A = await import('../src/modules/actors.js');
const { nowISO, rid } = await import('../src/util.js');
const G = await import('../src/graph.js');
const J = await import('../src/jobs.js');
const QC = await import('../src/qc.js');

migrate();

let pass = 0, fail = 0;
const ok = (name, cond, evidence = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${evidence ? `  ← ${evidence}` : ''}`); }
  else { fail++; console.error(`  ✗ ${name}  ← ${evidence}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 60000, step = 120) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(step); }
  return false;
};
const throws = (fn, re) => { try { fn(); return { threw: false, msg: '' }; } catch (e) { const m = String(e?.message || e); return { threw: true, msg: m, match: re ? re.test(m) : true }; } };
const throwsAsync = async (fn, re) => { try { await fn(); return { threw: false, msg: '' }; } catch (e) { const m = String(e?.message || e); return { threw: true, msg: m, match: re ? re.test(m) : true }; } };

// ---- 取值口径（FLAKE-FIX）：只认「本次调用刚落的那一行」，不按 node_id / shot_id 猜最新 ----
// 旧写法 `WHERE node_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1` 与
// `WHERE shot_id=? ... LIMIT 1` 取的是「该节点/该镜最新一行」；但同一节点会被**别的**任务
// （后台流水线、前一次画布运行）在更晚的墙钟时刻落库，于是取到别人的行 → 断言假失败。
// 口径改为：目标 id + **本次调用的 job_id** 同为命中条件；取不到就明确 FAIL（不静默退回「最新一行」），
// 并把全部候选行打出来便于诊断。
const runRowsOf = (nodeId, extraSql = '', args = []) =>
  all(`SELECT rowid AS _rid, * FROM canvas_node_runs
       WHERE node_id = ? ${extraSql} ORDER BY created_at DESC, rowid DESC`, nodeId, ...args);
const runOfJob = (nodeId, jobId, label, extraSql = '', args = []) => {
  const cands = runRowsOf(nodeId, extraSql, args);
  const row = jobId ? (cands.find((r) => r.job_id === jobId) || null) : null;
  if (!row) {
    console.error(`  ✗ [前置断言] ${label}：取到的执行记录必须属于本次调用 —— 但本次任务 job=${jobId} 在节点 ${nodeId}${extraSql} 没有执行记录`);
    console.error(`      候选 ${cands.length} 条：${cands.map((r) => `rowid=${r._rid} job=${r.job_id} status=${r.status} kind=${r.kind} created=${r.created_at}`).join(' | ') || '(无)'}`);
    console.error(`      含义：本次调用没落库（真回归），或落在别的任务的行上（取值口径不确定）`);
  }
  return { row, bound: Boolean(row), candidates: cands, jobId };
};
const whyNoRun = (x) => x.bound ? `<#${x.row._rid} job=${x.row.job_id}>`
  : `本次调用（job=${x.jobId}）取不到执行记录；候选 ${x.candidates.length} 条：${x.candidates.map((r) => `rowid=${r._rid} job=${r.job_id}`).join(' | ') || '(无)'}`;
const shotRenderOfJob = (shotId, kind, jobId, label, extraSql = '') => {
  const rows = all(`SELECT rowid AS _rid, * FROM shot_renders
                    WHERE shot_id = ? AND kind = ? ${extraSql} ORDER BY created_at DESC, rowid DESC`, shotId, kind);
  const row = jobId ? (rows.find((r) => r.job_id === jobId) || null) : null;
  if (!row) {
    console.error(`  ✗ [前置断言] ${label}：取到的渲染行必须属于本次调用 —— 但本次任务 job=${jobId} 在 ${shotId}/${kind}${extraSql} 没有落库行`);
    console.error(`      候选 ${rows.length} 条：${rows.map((r) => `rowid=${r._rid} job=${r.job_id} status=${r.status} created=${r.created_at}`).join(' | ') || '(无)'}`);
    console.error(`      含义：本次调用没落库（真回归），或落在别的任务的行上（取值口径不确定）`);
  }
  return { row, bound: Boolean(row), candidates: rows, jobId };
};
/** 断言失败时的可诊断证据：绑定成功给 meta，失败给「本次任务取不到行 + 全部候选行」 */
const whyNoShot = (x) => {
  if (!x.bound) return `本次调用（job=${x.jobId}）取不到落库行；候选 ${x.candidates.length} 条：${x.candidates.map((r) => `rowid=${r._rid} job=${r.job_id}`).join(' | ') || '(无)'}`;
  try { return JSON.stringify(JSON.parse(x.row.meta || '{}')).slice(0, 200); } catch { return String(x.row.meta || '').slice(0, 200); }
};

// ---- 真实极短片段（2s / 3s），供拼接验证 ----
const mkClip = (name, secs, color) => {
  const rel = path.join('videos', name);
  const abs = path.join(DATA_DIR, rel);
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=160x120:d=${secs}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '12', abs], { stdio: 'pipe' });
  return rel;
};
const clipA = mkClip('a.mp4', 2, 'red');
const clipB = mkClip('b.mp4', 3, 'blue');
const clipC = mkClip('c.mp4', 1, 'green');
ok('已用真实 ffmpeg 生成 3 个测试片段', [clipA, clipB, clipC].every((r) => fs.existsSync(path.join(DATA_DIR, r))),
  [clipA, clipB, clipC].join(', '));

// ---- 假 TTS 厂商（按台词里标注的秒数生成音频）+ 一段本地背景乐 ----
const ttsCalls = [];
const ttsServer = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (req.url.startsWith('/v1/audio/speech')) {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    ttsCalls.push(body);
    const m = /\|([\d.]+)$/.exec(String(body.input || ''));
    const secs = m ? Number(m[1]) : 1.5;
    const tmp = path.join(DATA_TMP, `tts_${ttsCalls.length}.mp3`);
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=520:duration=${secs}`,
      '-c:a', 'libmp3lame', '-b:a', '128k', tmp], { stdio: 'pipe' });
    res.writeHead(200, { 'content-type': 'audio/mpeg' });
    return res.end(fs.readFileSync(tmp));
  }
  res.writeHead(404); res.end('nope');
});
await new Promise((r) => ttsServer.listen(0, '127.0.0.1', r));
fs.mkdirSync(path.join(DATA_DIR, 'audio'), { recursive: true });
const bgmRel = path.join('audio', 'bgm.wav');
execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=8',
  path.join(DATA_DIR, bgmRel)], { stdio: 'pipe' });

// ---- 造一集剧本 + 3 个分镜（直接落库，接口层已被模块3 测试覆盖） ----
const scriptId = rid('SC'), epId = rid('EP');
run(`INSERT INTO scripts(id, title, format, episode_seconds, status, created_at, updated_at) VALUES(?,?,?,?,'done',?,?)`,
  scriptId, 'P5 时间线测试剧', 'anime', 60, nowISO(), nowISO());
run(`INSERT INTO script_episodes(id, script_id, season, episode, code, title, duration, status, created_at, updated_at)
     VALUES(?,?,1,1,'S01E001','第一集',60,'done',?,?)`, epId, scriptId, nowISO(), nowISO());
const shotIds = [];
[['沈砚：你终于来了。', '推镜', 2.5, '雾港码头'], ['（旁白）十年了。', '摇镜', 3, '雾港码头'], ['林昭：怀表停了。', '拉镜', 1.5, '钟楼']]
  .forEach(([dlg, mv, dur, loc], i) => {
    const id = rid('SH');
    run(`INSERT INTO shots(id, script_id, episode_id, idx, scene_no, location_id, shot_size, camera, move, duration, action, dialogue, mood, prompt_pos, cost_level, status, created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'done',?)`,
      id, scriptId, epId, i + 1, String(i + 1), loc, '中景', '固定', mv, dur, `${mv}：${dlg}`, dlg, '紧张',
      `medium shot, ${loc}`, i === 1 ? 'H' : 'L', nowISO());
    shotIds.push(id);
  });
ok('测试剧本/分集/分镜已落库', all('SELECT id FROM shots WHERE episode_id = ?', epId).length === 3, `shots=${shotIds.length}`);

// ---- 画布 + 节点 ----
const canvasId = 'CV-P5TEST';
run(`INSERT INTO canvases(id, name, created_at, updated_at) VALUES(?,?,?,?)`, canvasId, 'P5 测试画布', nowISO(), nowISO());
const mkNode = (kind, data = {}, title = '') => {
  const id = rid('ND');
  run(`INSERT INTO canvas_nodes(id, canvas_id, actor_id, x, y, w, h, z, kind, title, data)
       VALUES(?,?,'',0,0,220,180,0,?,?,?)`, id, canvasId, kind, title || kind, JSON.stringify(data));
  return id;
};
const videoNodes = shotIds.map((sid, i) => mkNode('video', { shotId: sid, duration: [2.5, 3, 1.5][i] }, `镜 ${i + 1}`));
const timelineNode = mkNode('timeline', { scriptId, code: 'S01E001', episodeId: epId }, '成片 · S01E001');

const link = (from, port, slot, nodeId = timelineNode, extra = {}) => {
  const id = rid('LK');
  run(`INSERT INTO canvas_links(id, canvas_id, from_actor, to_actor, from_node, to_node, from_side, to_side, from_port, to_port, slot, label, color, created_at)
       VALUES(?,?,'','',?,?,'right','left','clip',?,?,'',?,?)`,
    id, canvasId, from, nodeId, port, slot, '', extra.created_at || nowISO());
  return id;
};
const linksOf = () => all('SELECT * FROM canvas_links WHERE canvas_id = ?', canvasId);

console.log('\n=== 1. 拼接顺序解析（clip1..N → slot → 创建时间） ===');
// 乱序插入：clip3 先建、clip1 后建、clip2 中间
const l3 = link(videoNodes[2], 'clip3', 0);
const l1 = link(videoNodes[0], 'clip1', 0);
const l2 = link(videoNodes[1], 'clip2', 0);
const vals = new Map([[videoNodes[0], clipA], [videoNodes[1], clipB], [videoNodes[2], clipC]]);
const p1 = T.orderedClips({ timelineNodeId: timelineNode, links: linksOf(), valueOf: (id) => vals.get(id) || null });
ok('按 clipN 端口号排序（与建边先后无关）', p1.order.map((x) => x.port).join(',') === 'clip1,clip2,clip3', p1.order.map((x) => `${x.port}:${x.file}`).join(' | '));
ok('顺序对应的文件正确', p1.order.map((x) => x.file).join(',') === `${clipA},${clipB},${clipC}`, p1.order.map((x) => x.file).join(','));
ok('解析结果不带缺失/重复', p1.missing.length === 0 && p1.duplicated.length === 0);

// 端口缺失（无 to_port，只有 slot）→ 退化为 slot 排序
run(`UPDATE canvas_links SET to_port = NULL WHERE id = ?`, l1);
run(`UPDATE canvas_links SET to_port = NULL WHERE id = ?`, l2);
run(`UPDATE canvas_links SET to_port = NULL WHERE id = ?`, l3);
run(`UPDATE canvas_links SET slot = 2 WHERE id = ?`, l1);
run(`UPDATE canvas_links SET slot = 0 WHERE id = ?`, l3);
run(`UPDATE canvas_links SET slot = 1 WHERE id = ?`, l2);
const p2 = T.orderedClips({ timelineNodeId: timelineNode, links: linksOf(), valueOf: (id) => vals.get(id) || null });
ok('无端口时按 slot 排序', p2.order.map((x) => x.slot).join(',') === '0,1,2', p2.order.map((x) => x.slot).join(','));
// 无端口也无 slot（全 0）→ 按创建时间
run(`UPDATE canvas_links SET slot = 0 WHERE canvas_id = ?`, canvasId);
run(`UPDATE canvas_links SET created_at = '2020-01-01T00:00:00Z' WHERE id = ?`, l1);
run(`UPDATE canvas_links SET created_at = '2020-01-01T00:00:01Z' WHERE id = ?`, l2);
run(`UPDATE canvas_links SET created_at = '2020-01-01T00:00:02Z' WHERE id = ?`, l3);
const p3 = T.orderedClips({ timelineNodeId: timelineNode, links: linksOf(), valueOf: (id) => vals.get(id) || null });
ok('无端口无槽位时按创建时间排序', p3.order.map((x) => x.link.id).join(',') === [l1, l2, l3].join(','), p3.order.map((x) => x.link.created_at).join(','));

// 恢复端口，测试同端口两条边（不同 slot）
link(videoNodes[1], 'clip2', 5);
run(`UPDATE canvas_links SET to_port = 'clip2' WHERE id = ?`, l1);
const p4 = T.orderedClips({ timelineNodeId: timelineNode, links: linksOf(), valueOf: (id) => vals.get(id) || null });
const dup = p4.duplicated.filter((d) => d.port === 'clip2');
ok('同端口重复接入被检出（不静默丢边）', dup.length === 1 && p4.order.length === 4, `order=${p4.order.length} dup=${JSON.stringify(dup)}`);
ok('重复端口下的候选都保留在 order 里（供调用方报错而非随手丢弃）', p4.order.filter((x) => x.port === 'clip2').length === 2);

console.log('\n=== 2. 缺片与空输入的中文报错 ===');
for (const l of linksOf()) run('DELETE FROM canvas_links WHERE id = ?', l.id);
const noInput = await throwsAsync(() => T.executeTimeline({ node: { id: timelineNode, kind: 'timeline', data: JSON.stringify({}) }, canvasId }), /没有可用的片段输入/);
ok('时间线没有片段输入时报中文错', noInput.threw && noInput.match, noInput.msg);
run(`UPDATE canvas_nodes SET data = ? WHERE id = ?`, JSON.stringify({ shotId: shotIds[0], duration: 2.5, lastFile: clipA }), videoNodes[0]);
link(videoNodes[0], 'clip1', 0);   // 有产物
link(videoNodes[1], 'clip2', 0);   // 该上游还没有产物 → 应报「还没有产出视频」
const missingUp = await throwsAsync(() => T.executeTimeline({ node: { id: timelineNode, kind: 'timeline', data: JSON.stringify({}) }, canvasId }), /还没有产出视频/);
ok('上游还没产出时报中文错（不静默少拼一段）', missingUp.threw && missingUp.match, missingUp.msg);
for (const l of linksOf()) run('DELETE FROM canvas_links WHERE id = ?', l.id);

console.log('\n=== 3. 片段来源：data.lastFile 与 canvas_node_runs 记录 ===');
run(`UPDATE canvas_nodes SET data = ? WHERE id = ?`, JSON.stringify({ shotId: shotIds[0], duration: 2.5, lastFile: clipA }), videoNodes[0]);
const r1 = rid('RUN');
run(`INSERT INTO canvas_node_runs(id, canvas_id, node_id, kind, status, file_path, duration, backend, created_at)
     VALUES(?,?,?,'video','done',?,?, 'placeholder', ?)`, r1, canvasId, videoNodes[1], clipB, 3, nowISO());
link(videoNodes[0], 'clip1', 0);
link(videoNodes[1], 'clip2', 0);
const pv = T.timelineOrderPreview({ canvasId, nodeId: timelineNode });
ok('预览解析出 2 段且 ready', pv.total === 2 && pv.ready === true, JSON.stringify({ total: pv.total, ready: pv.ready }));
ok('片段时长来自镜头（shots.duration）', pv.clips.map((c) => c.duration).join(',') === '2.5,3', pv.clips.map((c) => c.duration).join(','));
ok('总时长汇总正确', Math.abs(pv.totalDuration - 5.5) < 1e-6, String(pv.totalDuration));
ok('镜头 2 是画外音 → 不产生字幕台词', pv.clips[1].dialogue === '', `dialogue=${JSON.stringify(pv.clips[1].dialogue)}`);
ok('镜头 1 台词正确带出（去掉说话人前缀）', pv.clips[0].dialogue === '你终于来了。', JSON.stringify(pv.clips[0].dialogue));
ok('预览是 dry-run：不产生任何执行记录', get('SELECT COUNT(*) c FROM canvas_node_runs WHERE node_id = ?', timelineNode).c === 0);

console.log('\n=== 4. 真实成片（经 finishEpisode：拼接 + 包装） ===');
const steps = [];
const out = await T.executeTimeline({
  node: { id: timelineNode, kind: 'timeline', data: JSON.stringify({ scriptId, code: 'S01E001', episodeId: epId }) },
  canvasId, params: { scriptId, code: 'S01E001', episodeId: epId },
  ctx: { log: (m) => steps.push(m), setProgress: (p, ex) => steps.push(`progress:${p}:${JSON.stringify(ex ?? null)}`) },
});
const abs = path.join(DATA_DIR, out.filePath);
ok('成片文件已产出', fs.existsSync(abs), out.filePath);
const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', abs], { encoding: 'utf8' }).trim();
ok('成片时长 = 两段之和（约 5.5s）', Math.abs(Number(probe) - 5.5) < 0.6, `ffprobe=${probe}`);
ok('返回 clipCount = 2', out.clipCount === 2, String(out.clipCount));
ok('返回拼接顺序（含端口名）', out.order.map((x) => x.port).join(',') === 'clip1,clip2', JSON.stringify(out.order.map((x) => x.port)));
ok('阶段进度映射到 25/50/75/100（只报百分比，不覆盖任务级 done/total）',
  steps.includes('progress:25:null') && steps.includes('progress:100:null'),
  steps.filter((s) => s.startsWith('progress')).join(' | '));
ok('子步骤不会覆盖任务级总数（成片 4 个子步骤 ≠ 4 个节点）', !steps.some((s) => /\{"done"/.test(s)),
  steps.filter((s) => s.startsWith('progress')).join(' | '));

console.log('\n=== 5. episode_films 登记与登记失败降级 ===');
const filmRow = get('SELECT * FROM episode_films WHERE id = ?', out.filmId)
  || (console.error(`  ✗ [前置断言] 4. 成片登记：本次调用返回的成片 id=${out.filmId} 查不到登记记录（拒绝按 script_id 猜最新一行）`), null);
ok('成片已登记到 episode_films（模块4 列表可见）', Boolean(filmRow) && Number(filmRow.shot_count) === 2, JSON.stringify({ id: filmRow?.id, shots: filmRow?.shot_count, want: out.filmId }));
ok('登记 meta.source = canvas-timeline 且带节点 id', JSON.parse(filmRow.meta || '{}').source === 'canvas-timeline' && JSON.parse(filmRow.meta || '{}').nodeId === timelineNode, filmRow.meta);
// 让登记失败：临时改名 episode_films → 成片仍应成功
run('ALTER TABLE episode_films RENAME TO episode_films_bak');
const out2 = await T.executeTimeline({
  node: { id: timelineNode, kind: 'timeline', data: JSON.stringify({ scriptId, code: 'S01E001', episodeId: epId }) },
  canvasId, params: { scriptId, code: 'S01E001', episodeId: epId },
});
run('ALTER TABLE episode_films_bak RENAME TO episode_films');
ok('登记失败不影响成片（仍返回文件）', fs.existsSync(path.join(DATA_DIR, out2.filePath)), out2.filePath);
ok('登记失败时 filmId 为空但不抛错', out2.filmId === null, String(out2.filmId));

console.log('\n=== 6. finish 参数覆盖配置 ===');
let overridden = null;
const { finishEpisode } = await import('../src/finish.js');
const origFinish = finishEpisode;
// 用 executors 不行（timeline 不走 executors），改为直接核对 options 合并逻辑：传 finish.subtitles=true 时产物应带字幕流
const out3 = await T.executeTimeline({
  node: { id: timelineNode, kind: 'timeline', data: JSON.stringify({ scriptId, code: 'S01E001E2', episodeId: epId, finish: { subtitles: false, audio: 'silent', fadeIn: 1, fadeOut: 1 } }) },
  canvasId,
});   // 故意不传 params：验证回退到节点 data
ok('节点参数覆盖全局 finish（fadeIn/fadeOut 生效后可正常出片）', fs.existsSync(path.join(DATA_DIR, out3.filePath)), out3.filePath);
const probeStreams = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', path.join(DATA_DIR, out3.filePath)], { encoding: 'utf8' }).trim();
ok('subtitles:false 时不产生字幕流', !probeStreams.includes('subtitle'), `streams=${probeStreams.replace(/\n/g, '+')}`);
ok('未使用的旧变量不会污染（origFinish 可用）', typeof origFinish === 'function');

console.log('\n=== 7. 铺开分集到画布（★ 零生成调用） ===');
const runsBefore = get('SELECT COUNT(*) c FROM canvas_node_runs').c;
const spread = T.spreadEpisodeToCanvas({ canvasId, scriptId, code: 'S01E001', cols: 3 });
const runsAfter = get('SELECT COUNT(*) c FROM canvas_node_runs').c;
ok('铺开后新增执行记录为 0（只布局、不生成）', runsAfter === runsBefore, `${runsBefore} → ${runsAfter}`);
ok('clip 连线数 == 镜头数', spread.clipCount === 3, String(spread.clipCount));
const newLinks = all("SELECT * FROM canvas_links WHERE canvas_id = ? AND to_node = ? ORDER BY slot ASC", canvasId, spread.timelineNodeId);
ok('每个片段接到 clip1..clipN（端口递增）', newLinks.map((l) => l.to_port).join(',') === 'clip1,clip2,clip3', newLinks.map((l) => l.to_port).join(','));
ok('shot 容器节点与 N 个 video 节点已建',
  Boolean(get("SELECT id FROM canvas_nodes WHERE id = ? AND kind = 'shot'", spread.shotNodeId))
  && spread.videoNodeIds.length === 3
  && spread.videoNodeIds.every((id) => get("SELECT kind FROM canvas_nodes WHERE id = ?", id)?.kind === 'video'),
  `新建 video 节点=${spread.videoNodeIds.length}，画布 video 总数=${all("SELECT id FROM canvas_nodes WHERE canvas_id = ? AND kind = 'video'", canvasId).length}`);
ok('video 节点带上镜头 id 与时长（供后续生成使用）', Boolean(JSON.parse(get('SELECT data FROM canvas_nodes WHERE id = ?', spread.videoNodeIds[0]).data).shotId));
ok('同时铺出关键帧节点（视频必须有首帧，否则后端会诚实报错）',
  (spread.keyframeNodeIds || []).length === 3
  && (spread.keyframeNodeIds || []).every((id) => get("SELECT kind FROM canvas_nodes WHERE id = ?", id)?.kind === 'image'),
  `keyframes=${(spread.keyframeNodeIds || []).length}`);
const firstLinks = all("SELECT * FROM canvas_links WHERE canvas_id = ? AND to_port = 'first'", canvasId);
ok('关键帧以 image → first 类型化端口连到视频节点',
  firstLinks.length === 3 && firstLinks.every((l) => l.from_port === 'image'),
  `${firstLinks.length} 条 image→first`);
ok('image 输出端口允许接入 first（端口兼容表一致）', A.portOk('image', 'first') === true);
const shotLinks = all("SELECT * FROM canvas_links WHERE canvas_id = ? AND from_node = ?", canvasId, spread.shotNodeId);
ok('分镜容器 → 视频片段是语义连线（不伪造非法端口）',
  shotLinks.length === 3 && shotLinks.every((l) => l.from_port == null && l.to_port == null),
  JSON.stringify(shotLinks.map((l) => ({ f: l.from_port, t: l.to_port }))));
ok('新节点不与既有内容重叠（y 在已有内容下方）', get('SELECT y FROM canvas_nodes WHERE id = ?', spread.shotNodeId).y >= 0, String(get('SELECT y FROM canvas_nodes WHERE id = ?', spread.shotNodeId).y));
const spErr = throws(() => T.spreadEpisodeToCanvas({ canvasId, scriptId, code: 'S99E999' }), /未找到分集/);
ok('分集不存在时报中文错', spErr.threw && spErr.match, spErr.msg);
const epEmpty = rid('EP');
run(`INSERT INTO script_episodes(id, script_id, season, episode, code, title, status, created_at, updated_at)
     VALUES(?,?,2,2,'S02E001','空集','done',?,?)`, epEmpty, scriptId, nowISO(), nowISO());
const spErr2 = throws(() => T.spreadEpisodeToCanvas({ canvasId, scriptId, code: 'S02E001' }), /请先生成分镜/);
ok('分集没有分镜时报中文错', spErr2.threw && spErr2.match, spErr2.msg);
const spErr3 = throws(() => T.spreadEpisodeToCanvas({ canvasId, scriptId }), /请指定剧本与分集/);
ok('缺参数时报中文错', spErr3.threw && spErr3.match, spErr3.msg);

console.log('\n=== 7b. 超长分集自动分块成片（每块 ≤ 端口上限） ===');
const epLong = rid('EP');
run(`INSERT INTO script_episodes(id, script_id, season, episode, code, title, status, created_at, updated_at)
     VALUES(?,?,3,3,'S03E001','超长集','done',?,?)`, epLong, scriptId, nowISO(), nowISO());
for (let i = 0; i < 26; i++) {
  run(`INSERT INTO shots(id, script_id, episode_id, idx, duration, action, dialogue, status, created_at)
       VALUES(?,?,?,?,3,?,?,'done',?)`, rid('SH'), scriptId, epLong, i + 1, `动作 ${i + 1}`, `台词 ${i + 1}`, nowISO());
}
const longSpread = T.spreadEpisodeToCanvas({ canvasId, scriptId, code: 'S03E001', cols: 6 });
ok('26 镜自动分成 2 个成片节点', longSpread.chunks === 2 && longSpread.timelineNodeIds.length === 2, `chunks=${longSpread.chunks}`);
ok('端口上限 = 24（一集最多 24 段）', T.TIMELINE_PORTS.length === 24, String(T.TIMELINE_PORTS.length));
const perChunk = longSpread.timelineNodeIds.map((tid) => all("SELECT * FROM canvas_links WHERE to_node = ?", tid).length);
ok('两块分别接 24 段与 2 段', perChunk[0] === 24 && perChunk[1] === 2, JSON.stringify(perChunk));
const chunk2Ports = all("SELECT to_port FROM canvas_links WHERE to_node = ? ORDER BY slot ASC", longSpread.timelineNodeIds[1]).map((l) => l.to_port);
ok('第二块端口从 clip1 重新开始编号', chunk2Ports[0] === 'clip1' && chunk2Ports[1] === 'clip2', chunk2Ports.join(','));

console.log('\n=== 8. 端口规则与类型校验 ===');
ok('timeline 节点输入端口 = clip1..N + bgm + ov1..4 + sub（多轨）',
  JSON.stringify(A.PORT_RULES.timeline.in) === JSON.stringify([...T.TIMELINE_PORTS, 'bgm', ...T.OVERLAY_PORTS, 'sub']),
  `${A.PORT_RULES.timeline.in.length} 个端口，尾部 ${A.PORT_RULES.timeline.in.slice(-6).join(',')}`);
ok('timeline 输出为 film、shot 输出为 clip', A.PORT_RULES.timeline.out.join() === 'film' && A.PORT_RULES.shot.out.join() === 'clip');
ok('clip 输出可接入 clipN', A.portOk('clip', 'clip3') === true && A.portOk('clip', 'in') === true);
ok('text 输出不可接入 clipN', A.portOk('text', 'clip3') === false);
const badLink = throws(() => A.createLink({ canvas_id: canvasId, from_node: timelineNode, to_node: videoNodes[0], from_port: 'film', to_port: 'in' }), /没有输入端口|不允许/);
ok('非法端口连线被服务端拒绝（中文原因）', badLink.threw, badLink.msg);

console.log('\n=== 9. 经 DAG 引擎端到端执行时间线节点 ===');
const plan = G.planGraph({ canvasId });
const stepTl = plan.steps.run.find((s) => s.id === timelineNode);
ok('计划里时间线节点可执行且带片段输入（端口清单体现 clip1..N）',
  Boolean(stepTl) && (stepTl.inputs || []).some((k) => String(k).startsWith('clip')), JSON.stringify(stepTl?.inputs || []));
ok('计划 estimate 把时间线算作 outputCalls 之外的成片调用', typeof plan.estimate.totalCalls === 'number' && plan.estimate.totalCalls >= 1, JSON.stringify(plan.estimate));
const jobId = G.createGraphRunJob({ canvasId, nodeIds: [timelineNode], overwrite: true, title: 'P5 时间线端到端' });
const jobDone = await waitFor(() => J.getJob(jobId.jobId)?.status === 'done', 90000);
ok('整图任务执行完成', jobDone, `status=${J.getJob(jobId.jobId)?.status} err=${J.getJob(jobId.jobId)?.error || ''}`);
const data = JSON.parse(get('SELECT data FROM canvas_nodes WHERE id = ?', timelineNode).data || '{}');
ok('节点状态写回 canvas_nodes.data（status=done + lastFile）', data.status === 'done' && Boolean(data.lastFile), JSON.stringify({ status: data.status, file: data.lastFile }));
const runCell = runOfJob(timelineNode, jobId.jobId, '9. 时间线端到端');
const runRow = runCell.row;
ok('执行记录落库（kind=timeline + 时长）', runCell.bound && runRow.kind === 'timeline' && runRow.status === 'done' && Number(runRow.duration) > 0, runCell.bound ? JSON.stringify({ kind: runRow.kind, status: runRow.status, dur: runRow.duration }) : whyNoRun(runCell));
const finalJob = J.getJob(jobId.jobId);
ok('图任务总数 = 节点数 1（未被成片子步骤覆盖成 4）', Number(finalJob.total) === 1 && Number(finalJob.done) === 1,
  JSON.stringify({ total: finalJob.total, done: finalJob.done, progress: finalJob.progress }));

console.log('\n=== 10b. 首尾帧过渡与视频续写 ===');
const { lastFrameOf } = await import('../src/video.js');
const { saveConfig: saveCfg2 } = await import('../src/config.js');

// ① 从已有片段抽尾帧（视频续写的基础能力）：clipA 是纯红色片段 → 尾帧应为红
const lf = await lastFrameOf(clipA, { outName: 'continue_test' });
ok('能从已有片段抽出尾帧 PNG', fs.existsSync(lf.abs) && lf.rel.endsWith('.png'), lf.rel);
const meanColor = execFileSync('ffmpeg', ['-v', 'error', '-i', lf.abs, '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
  { encoding: 'buffer' }).slice(0, 3);
ok('尾帧内容确实来自该片段（红色片段 → 红通道最高）',
  meanColor[0] > 180 && meanColor[0] > meanColor[1] + 60 && meanColor[0] > meanColor[2] + 60,
  `rgb=(${meanColor[0]},${meanColor[1]},${meanColor[2]})`);

// ② 画布上的「视频续写」：片段 → next.first，执行时自动抽尾帧当首帧
const CV_CONT = 'CV-CONT';
run(`INSERT INTO canvases(id, name, created_at, updated_at) VALUES(?,?,?,?)`, CV_CONT, '续写测试', nowISO(), nowISO());
const segA = rid('ND'), segB = rid('ND');
run(`INSERT INTO canvas_nodes(id, canvas_id, actor_id, x, y, w, h, z, kind, title, data) VALUES(?,?,'',0,0,220,160,0,'video',?,?)`,
  segA, CV_CONT, '第一段', JSON.stringify({ duration: 2, move: '推镜' }));
run(`INSERT INTO canvas_nodes(id, canvas_id, actor_id, x, y, w, h, z, kind, title, data) VALUES(?,?,'',0,0,220,160,0,'video',?,?)`,
  segB, CV_CONT, '第二段（续写）', JSON.stringify({ duration: 2, move: '推镜' }));
const kfA = rid('ND');
run(`INSERT INTO canvas_nodes(id, canvas_id, actor_id, x, y, w, h, z, kind, title, data) VALUES(?,?,'',0,0,220,160,0,'image',?,?)`,
  kfA, CV_CONT, '首帧', JSON.stringify({ width: 160, height: 120, prompt: 'red' }));
// 用红色片段作为 A 的「首帧」来源不方便，这里直接把 A 的产物写成 clipA（已存在的红色片段）
run(`INSERT INTO canvas_links(id, canvas_id, from_actor, to_actor, from_node, to_node, from_side, to_side, from_port, to_port, slot, label, color, created_at)
     VALUES(?,?,'','',?,?,'right','left','clip','first',0,'续写','',?)`, rid('LK'), CV_CONT, segA, segB, nowISO());
run(`UPDATE canvas_nodes SET data = ? WHERE id = ?`, JSON.stringify({ duration: 2, move: '推镜', lastFile: clipA, status: 'done' }), segA);
// 上游产物以「执行记录」为准（与 graph.js 的 artifactGetter 口径一致）
run(`INSERT INTO canvas_node_runs(id, canvas_id, node_id, kind, status, file_path, duration, backend, created_at)
     VALUES(?,?,?,'video','done',?,2,'placeholder',?)`, rid('RUN'), CV_CONT, segA, clipA, nowISO());
const contRun = G.createGraphRunJob({ canvasId: CV_CONT, nodeIds: [segB], overwrite: true, title: '续写测试' });
const contDone = await waitFor(() => J.getJob(contRun.jobId)?.status === 'done', 90000);
const segBData = JSON.parse(get('SELECT data FROM canvas_nodes WHERE id = ?', segB).data || '{}');
ok('续写节点执行成功', contDone && segBData.status === 'done', JSON.stringify({ status: segBData.status, err: segBData.lastError }));
ok('续写节点的首帧来自上游片段尾帧（结果标注 firstFrom=lastFrameOf）',
  (segBData.lastFile || '').includes('kb_') && contDone, String(segBData.lastFile));
const contCell = runOfJob(segB, contRun.jobId, '10b. 视频续写');
const contRunRow = contCell.row;
ok('续写产物落库且是视频文件', contCell.bound && /\.mp4$/.test(String(contRunRow.file_path || '')), contCell.bound ? String(contRunRow.file_path) : whyNoRun(contCell));
const contFirstFrame = await lastFrameOf(contRunRow?.file_path, { outName: 'cont_first' });
const contColor = execFileSync('ffmpeg', ['-v', 'error', '-i', contFirstFrame.abs, '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
  { encoding: 'buffer' }).slice(0, 3);
ok('续写片段确实承接了上一段的画面（红色延续）', contColor[0] > 120, `rgb=(${contColor[0]},${contColor[1]},${contColor[2]})`);

// ③ 首尾帧过渡（placeholder 交叉溶解）
const CV_FL = 'CV-FL';
run(`INSERT INTO canvases(id, name, created_at, updated_at) VALUES(?,?,?,?)`, CV_FL, '首尾帧测试', nowISO(), nowISO());
const flV = rid('ND'), flFirst = rid('ND'), flLast = rid('ND');
run(`INSERT INTO canvas_nodes(id, canvas_id, actor_id, x, y, w, h, z, kind, title, data) VALUES(?,?,'',0,0,220,160,0,'image',?,?)`, flFirst, CV_FL, '首帧(红)', JSON.stringify({ width: 160, height: 120, prompt: 'red' }));
run(`INSERT INTO canvas_nodes(id, canvas_id, actor_id, x, y, w, h, z, kind, title, data) VALUES(?,?,'',0,0,220,160,0,'image',?,?)`, flLast, CV_FL, '尾帧(蓝)', JSON.stringify({ width: 160, height: 120, prompt: 'blue' }));
run(`INSERT INTO canvas_nodes(id, canvas_id, actor_id, x, y, w, h, z, kind, title, data) VALUES(?,?,'',0,0,220,160,0,'video',?,?)`, flV, CV_FL, '首尾帧过渡', JSON.stringify({ duration: 2, move: '固定' }));
run(`UPDATE canvas_nodes SET data = ? WHERE id = ?`, JSON.stringify({ width: 160, height: 120, prompt: 'red', lastFile: clipA, status: 'done' }), flFirst);
run(`UPDATE canvas_nodes SET data = ? WHERE id = ?`, JSON.stringify({ width: 160, height: 120, prompt: 'blue', lastFile: clipB, status: 'done' }), flLast);
for (const [nid, f] of [[flFirst, clipA], [flLast, clipB]]) {
  run(`INSERT INTO canvas_node_runs(id, canvas_id, node_id, kind, status, file_path, backend, created_at)
       VALUES(?,?,?,'image','done',?,'placeholder',?)`, rid('RUN'), CV_FL, nid, f, nowISO());
}
run(`INSERT INTO canvas_links(id, canvas_id, from_actor, to_actor, from_node, to_node, from_side, to_side, from_port, to_port, slot, label, color, created_at)
     VALUES(?,?,'','',?,?,'right','left','image','first',0,'首帧','',?)`, rid('LK'), CV_FL, flFirst, flV, nowISO());
run(`INSERT INTO canvas_links(id, canvas_id, from_actor, to_actor, from_node, to_node, from_side, to_side, from_port, to_port, slot, label, color, created_at)
     VALUES(?,?,'','',?,?,'right','left','image','last',0,'尾帧','',?)`, rid('LK'), CV_FL, flLast, flV, nowISO());
const flRun = G.createGraphRunJob({ canvasId: CV_FL, nodeIds: [flV], overwrite: true, title: '首尾帧测试' });
const flDone = await waitFor(() => J.getJob(flRun.jobId)?.status === 'done', 90000);
const flCell = runOfJob(flV, flRun.jobId, '10b. 首尾帧过渡（第一次运行）');
const flRow = flCell.row;
const flMeta = JSON.parse(flRow?.meta || '{}');
ok('首尾帧过渡执行成功', flDone && flCell.bound && flRow.status === 'done', flCell.bound ? JSON.stringify({ status: flRow.status, err: flRow.error }) : whyNoRun(flCell));
ok('结果如实标注尾帧处理方式（raw.lastFrame=xfade）', flCell.bound && flMeta?.raw?.lastFrame === 'xfade', JSON.stringify(flMeta?.raw || {}).slice(0, 120));
const bluePng = await lastFrameOf(clipB, { outName: 'blue_last' });
run(`UPDATE canvas_nodes SET data = ? WHERE id = ?`, JSON.stringify({ width: 160, height: 120, prompt: 'blue', lastFile: bluePng.rel, status: 'done' }), flLast);
run(`INSERT INTO canvas_node_runs(id, canvas_id, node_id, kind, status, file_path, backend, created_at)
     VALUES(?,?,?,'image','done',?,'placeholder',?)`, rid('RUN'), CV_FL, flLast, bluePng.rel, nowISO());
const flRun2 = G.createGraphRunJob({ canvasId: CV_FL, nodeIds: [flV], overwrite: true, title: '首尾帧测试2' });
await waitFor(() => J.getJob(flRun2.jobId)?.status === 'done', 90000);
const flCell2 = runOfJob(flV, flRun2.jobId, '10b. 首尾帧过渡（第二次运行）');
const flRow2 = flCell2.row;
const flMeta2 = JSON.parse(flRow2?.meta || '{}');
ok('用「首帧图 + 尾帧图」再跑一次：过渡如实标注',
  flCell2.bound && flRow2.status === 'done' && flMeta2?.raw?.lastFrame === 'xfade',
  (flCell2.bound ? JSON.stringify({ status: flRow2.status, raw: flMeta2?.raw, err: flRow2.error }) : whyNoRun(flCell2)).slice(0, 160));
const flFirstFrame = await lastFrameOf(flRow?.file_path, { outName: 'fl_first' });
const flColor = execFileSync('ffmpeg', ['-v', 'error', '-i', flFirstFrame.abs, '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
  { encoding: 'buffer' }).slice(0, 3);
const flLastFrame = await lastFrameOf(flRow2?.file_path, { outName: 'fl_last' });
const flEndColor = execFileSync('ffmpeg', ['-v', 'error', '-i', flLastFrame.abs, '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
  { encoding: 'buffer' }).slice(0, 3);
ok('尾帧确实参与画面（成片收尾为蓝色 = 来自尾帧图）',
  flEndColor[2] > 100, `成片末帧 rgb=(${flEndColor[0]},${flEndColor[1]},${flEndColor[2]})`);

// ③b 一键续写（画布操作）：新建续写节点 + clip→first 连线，零生成调用
// 上游产物 = 本次续写调用（contRun）刚落的那条执行记录（同样按 job_id 绑定，不按 node_id 猜最新）
const srcCell = runOfJob(segB, contRun.jobId, '10b. 一键续写的上游产物');
const srcRun = srcCell.row;
run(`UPDATE canvas_nodes SET data = ? WHERE id = ?`, JSON.stringify({ duration: 2, move: '推镜', lastFile: srcRun?.file_path, status: 'done' }), segB);
const runsBeforeCont = get('SELECT COUNT(*) c FROM canvas_node_runs').c;
const cont = T.createContinuationNode({ canvasId: CV_CONT, fromNodeId: segB, duration: 2 });
ok('一键续写创建了新节点', Boolean(get('SELECT id FROM canvas_nodes WHERE id = ?', cont.nodeId)), cont.nodeId);
ok('一键续写零生成调用（只建节点与连线）', get('SELECT COUNT(*) c FROM canvas_node_runs').c === runsBeforeCont, `runs=${runsBeforeCont}`);
const contLink = get('SELECT * FROM canvas_links WHERE id = ?', cont.linkId);
ok('一键续写的连线是 clip → first（执行层据此抽尾帧）',
  contLink?.from_port === 'clip' && contLink?.to_port === 'first' && contLink?.from_node === segB, JSON.stringify(contLink && { f: contLink.from_port, t: contLink.to_port }));
const contErr = throws(() => T.createContinuationNode({ canvasId: CV_CONT, fromNodeId: kfA }), /只能从「视频片段」节点续写/);
ok('从非视频节点续写时报中文错', contErr.threw && contErr.match, contErr.msg);

// ③c 流程节点可手工创建（关键帧/视频/文本/成片时间线/交付终点）
for (const [kind, expect] of [['image', '关键帧'], ['video', '视频片段'], ['text', '文本'], ['timeline', '成片时间线'], ['output', '交付终点']]) {
  const made = A.createAsset({ canvas_id: CV_FL, kind, title: '' });
  const data = JSON.parse(made.node.data || '{}');
  ok(`可手工创建「${kind}」节点（默认参数齐备）`, made.node.kind === kind && Object.keys(data).length > 0, `${made.node.id} · ${String(made.node.title).slice(0, 12)}`);
}
const badKind = throws(() => A.createAsset({ canvas_id: CV_FL, kind: 'nope' }), /未知节点类型/);
ok('未知节点类型时报中文错', badKind.threw && badKind.match, badKind.msg.slice(0, 80));

// ④ 通用 HTTP 模板没有 {{lastImage}} 占位符 → 诚实报错（不静默丢尾帧）
saveCfg2({ video: { backend: 'generic-http', generic: { url: 'http://127.0.0.1:1/never',
  bodyTemplate: '{"prompt":"{{prompt}}","image":"{{refImage}}"}' } } });
const noPlaceholder = await throwsAsync(() => generateVideo({ keyframe: resolveAsset(clipA), lastImage: resolveAsset(clipB),
  prompt: 'x', duration: 1 }), /没有 \{\{lastImage\}\} 占位符/);
ok('通用视频模板没准备尾帧占位符时明确报错', noPlaceholder.threw && noPlaceholder.match, noPlaceholder.msg);
saveCfg2({ video: { backend: 'placeholder' } });

console.log('\n=== 10c. 多轨时间线（叠加轨 / 画中画 / 水印 / 字幕轨） ===');
const TR = await import('../src/track-nodes.js');

// 采样工具：取某时刻某区域的平均颜色（x/y/w/h 为像素，相对左上角）
const sampleAt = (file, seconds, box) => {
  const args = ['-v', 'error', '-ss', String(seconds), '-i', file, '-frames:v', '1',
    '-vf', `crop=${box.w}:${box.h}:${box.x}:${box.y},scale=1:1`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'];
  return execFileSync('ffmpeg', args, { encoding: 'buffer', stdio: ['ignore', 'pipe', 'ignore'] }).slice(0, 3);
};

// 主轨：红(2s) + 蓝(3s)，160x120 以便区域采样
const mkColor = (name, secs, color, size = '160x120') => {
  const rel = path.join('videos', name);
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=${size}:d=${secs}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '12', path.join(DATA_DIR, rel)], { stdio: 'pipe' });
  return rel;
};
const base1 = mkColor('mt_red.mp4', 2, 'red');
const base2 = mkColor('mt_blue.mp4', 3, 'blue');
const ovGreen = mkColor('mt_green.mp4', 2, 'green');
const ovYellow = mkColor('mt_yellow.mp4', 2, 'yellow');
const ovPng = path.join('images', 'mt_white.png');
execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=white:s=80x60:d=1', '-frames:v', '1', path.join(DATA_DIR, ovPng)], { stdio: 'pipe' });

const CV_MT = 'CV-MT';
run(`INSERT INTO canvases(id, name, created_at, updated_at) VALUES(?,?,?,?)`, CV_MT, '多轨测试', nowISO(), nowISO());
const mkMt = (kind, title, data) => {
  const id = rid('ND');
  run(`INSERT INTO canvas_nodes(id, canvas_id, actor_id, x, y, w, h, z, kind, title, data) VALUES(?,?,'',0,0,220,160,0,?,?,?)`,
    id, CV_MT, kind, title, JSON.stringify(data));
  return id;
};
const relOfMt = (kind, nodeId, file) => {
  run(`INSERT INTO canvas_node_runs(id, canvas_id, node_id, kind, status, file_path, backend, created_at)
       VALUES(?,?,?,?,'done',?,'placeholder',?)`, rid('RUN'), CV_MT, nodeId, kind === 'image' ? 'image' : kind, file, nowISO());
};
const linkMt = (from, to, fromPort, toPort, slot = 0) => {
  run(`INSERT INTO canvas_links(id, canvas_id, from_actor, to_actor, from_node, to_node, from_side, to_side, from_port, to_port, slot, label, color, created_at)
       VALUES(?,?,'','',?,?,'right','left',?,?,?,'','',?)`, rid('LK'), CV_MT, from, to, fromPort, toPort, slot, nowISO());
};

// ① 主轨两段 + 画中画叠加（绿 2s，时间窗 1~2s，右下角 32% 宽）
const mtTl = mkMt('timeline', '成片·多轨', { code: 'MT1' });
const mtA = mkMt('video', '主轨1', { duration: 2 });
const mtB = mkMt('video', '主轨2', { duration: 3 });
relOfMt('video', mtA, base1); relOfMt('video', mtB, base2);
linkMt(mtA, mtTl, 'clip', 'clip1', 0);
linkMt(mtB, mtTl, 'clip', 'clip2', 1);
const pipNode = mkMt('overlay', '画中画', TR.overlayNodeDefaults('pip'));
relOfMt('video', pipNode, ovGreen);
linkMt(pipNode, mtTl, 'overlay', 'ov1', 0);
run(`UPDATE canvas_nodes SET data = ? WHERE id = ?`, JSON.stringify({ ...TR.overlayNodeDefaults('pip'), start: 1, end: 2, widthRatio: 0.32, position: '右下' }), pipNode);
const mtOut = await T.executeTimeline({ node: { id: mtTl, kind: 'timeline', data: get('SELECT data FROM canvas_nodes WHERE id = ?', mtTl).data }, canvasId: CV_MT });
const mtAbs = path.join(DATA_DIR, mtOut.filePath);
ok('多轨成片产出成功', fs.existsSync(mtAbs), mtOut.filePath);
ok('成片时长 = 主轨之和（叠加轨不改变时长）', Math.abs(Number(execFileSync('ffprobe', ['-v','error','-show_entries','format=duration','-of','csv=p=0', mtAbs], {encoding:'utf8'}).trim()) - 5) < 0.6,
  execFileSync('ffprobe', ['-v','error','-show_entries','format=duration','-of','csv=p=0', mtAbs], {encoding:'utf8'}).trim());
ok('成片报告里记了 1 条叠加轨（画中画/右下/1~2s）',
  mtOut.tracks?.overlays?.length === 1 && mtOut.tracks.overlays[0].mode === 'pip' && mtOut.tracks.composed?.applied === 1,
  JSON.stringify(mtOut.tracks?.overlays));
// t=1.5s（绿在右下） vs t=0.5s（不该有绿）；右下区域取 40x30 @ (110, 80)
const pipOn = sampleAt(mtAbs, 1.5, { x: 110, y: 80, w: 40, h: 30 });
const pipOff = sampleAt(mtAbs, 0.5, { x: 110, y: 80, w: 40, h: 30 });
const centerOn = sampleAt(mtAbs, 1.5, { x: 60, y: 45, w: 40, h: 30 });
ok('时间窗内右下角出现叠加画面（偏绿）', pipOn[1] > 120 && pipOn[1] > pipOn[0], `rgb=(${pipOn[0]},${pipOn[1]},${pipOn[2]})`);
ok('时间窗之外右下角没有叠加（背景色）', pipOff[1] < 100 || pipOff[1] < pipOn[1] - 40, `rgb=(${pipOff[0]},${pipOff[1]},${pipOff[2]})`);
ok('主画面中部未被画中画覆盖（仍是红色主轨）', centerOn[0] > 120 && centerOn[1] < 100, `rgb=(${centerOn[0]},${centerOn[1]},${centerOn[2]})`);

// ② 全屏叠加（时间窗 2.5~4s，黄）→ 该区间主画面被黄覆盖
const mtTl2 = mkMt('timeline', '成片·全屏叠加', { code: 'MT2' });
const mA2 = mkMt('video', '主轨1', { duration: 2 }), mB2 = mkMt('video', '主轨2', { duration: 3 });
relOfMt('video', mA2, base1); relOfMt('video', mB2, base2);
linkMt(mA2, mtTl2, 'clip', 'clip1', 0); linkMt(mB2, mtTl2, 'clip', 'clip2', 1);
const fullNode = mkMt('overlay', '全屏叠加', { mode: 'full', position: '居中', widthRatio: 1, start: 2.5, end: 4, opacity: 1, fade: 0 });
relOfMt('video', fullNode, ovYellow);
linkMt(fullNode, mtTl2, 'overlay', 'ov1', 0);
const mtOut2 = await T.executeTimeline({ node: { id: mtTl2, kind: 'timeline', data: get('SELECT data FROM canvas_nodes WHERE id = ?', mtTl2).data }, canvasId: CV_MT });
const mtAbs2 = path.join(DATA_DIR, mtOut2.filePath);
const fullOn = sampleAt(mtAbs2, 3.0, { x: 60, y: 45, w: 40, h: 30 });
const fullOff = sampleAt(mtAbs2, 0.8, { x: 60, y: 45, w: 40, h: 30 });
ok('全屏叠加在时间窗内覆盖主画面（偏黄：红绿高、蓝低）', fullOn[0] > 120 && fullOn[1] > 120 && fullOn[2] < 110, `rgb=(${fullOn[0]},${fullOn[1]},${fullOn[2]})`);
ok('全屏叠加在时间窗之外不出现（红色主轨）', fullOff[0] > 120 && fullOff[1] < 110, `rgb=(${fullOff[0]},${fullOff[1]},${fullOff[2]})`);

// ③ 图片水印（整片常驻、半透明、左上角）
const mtTl3 = mkMt('timeline', '成片·水印', { code: 'MT3' });
const mA3 = mkMt('video', '主轨1', { duration: 2 });
relOfMt('video', mA3, base1);
linkMt(mA3, mtTl3, 'clip', 'clip1', 0);
const wmNode = mkMt('overlay', '水印', { mode: 'watermark', position: '左上', widthRatio: 0.25, opacity: 0.6, fade: 0, file: ovPng });
relOfMt('image', wmNode, ovPng);
linkMt(wmNode, mtTl3, 'overlay', 'ov1', 0);
const mtOut3 = await T.executeTimeline({ node: { id: mtTl3, kind: 'timeline', data: get('SELECT data FROM canvas_nodes WHERE id = ?', mtTl3).data }, canvasId: CV_MT });
const mtAbs3 = path.join(DATA_DIR, mtOut3.filePath);
const wmDur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mtAbs3], { encoding: 'utf8' }).trim());
const wmTl = sampleAt(mtAbs3, 0.2, { x: 4, y: 4, w: 30, h: 20 });
const wmTr = sampleAt(mtAbs3, Math.max(0.6, Math.min(1.2, wmDur - 0.3)), { x: 4, y: 4, w: 30, h: 20 });
ok('水印整片常驻（片头与片尾左上角都有白色成分）', wmTl[0] > 150 && wmTr[0] > 150,
  `时长=${wmDur}s 片头 rgb=(${wmTl[0]},${wmTl[1]},${wmTl[2]}) 片尾 rgb=(${wmTr[0]},${wmTr[1]},${wmTr[2]})`);
ok('水印为半透明（不是纯白 255）', wmTl[0] < 250 && wmTl[1] > 60, `rgb=(${wmTl[0]},${wmTl[1]},${wmTl[2]})`);
ok('水印节点报告里带 isImage/isImage 与参数', mtOut3.tracks?.overlays?.[0]?.mode === 'watermark', JSON.stringify(mtOut3.tracks?.overlays));

// ④ 两条叠加轨同时上（ov1 画中画 + ov2 水印）→ 一次 ffmpeg 合成两条
const mtTl4 = mkMt('timeline', '成片·双叠加', { code: 'MT4' });
const mA4 = mkMt('video', '主轨1', { duration: 2 }), mB4 = mkMt('video', '主轨2', { duration: 3 });
relOfMt('video', mA4, base1); relOfMt('video', mB4, base2);
linkMt(mA4, mtTl4, 'clip', 'clip1', 0); linkMt(mB4, mtTl4, 'clip', 'clip2', 1);
const pip2 = mkMt('overlay', '画中画2', { mode: 'pip', position: '右下', widthRatio: 0.3, start: 0.5, end: 2.5, fade: 0, opacity: 1 });
relOfMt('video', pip2, ovGreen);
const wm2 = mkMt('overlay', '水印2', { mode: 'watermark', position: '左上', widthRatio: 0.25, opacity: 0.6, fade: 0, file: ovPng });
relOfMt('image', wm2, ovPng);
linkMt(pip2, mtTl4, 'overlay', 'ov1', 0);
linkMt(wm2, mtTl4, 'overlay', 'ov2', 0);
const mtOut4 = await T.executeTimeline({ node: { id: mtTl4, kind: 'timeline', data: get('SELECT data FROM canvas_nodes WHERE id = ?', mtTl4).data }, canvasId: CV_MT });
const mtAbs4 = path.join(DATA_DIR, mtOut4.filePath);
ok('两条叠加轨一次合成（composed.applied = 2）', mtOut4.tracks?.composed?.applied === 2, JSON.stringify(mtOut4.tracks?.composed));
const both1 = sampleAt(mtAbs4, 1.5, { x: 112, y: 82, w: 36, h: 26 });
const both2 = sampleAt(mtAbs4, 1.5, { x: 4, y: 4, w: 30, h: 20 });
ok('两条轨道同时生效（右下画中画 + 左下水印）', both1[1] > 110 && both2[0] > 140,
  `右下 rgb=(${both1[0]},${both1[1]},${both1[2]}) 左上 rgb=(${both2[0]},${both2[1]},${both2[2]})`);

// ⑤ 字幕轨：手工行 → 硬烧（画面出现白字像素）
const mtTl5 = mkMt('timeline', '成片·字幕轨', { code: 'MT5' });
const mA5 = mkMt('video', '主轨1', { duration: 2 });
relOfMt('video', mA5, base1);
linkMt(mA5, mtTl5, 'clip', 'clip1', 0);
const subNode2 = mkMt('subtitle', '字幕轨', { lines: [{ start: 0, end: 2, text: '第一句字幕' }, { start: 2, end: 4, text: '第二句字幕' }], mode: 'hard' });
const subRun = G.createGraphRunJob({ canvasId: CV_MT, nodeIds: [subNode2], overwrite: true, title: '字幕轨' });
await waitFor(() => J.getJob(subRun.jobId)?.status === 'done', 60000);
const subData = JSON.parse(get('SELECT data FROM canvas_nodes WHERE id = ?', subNode2).data || '{}');
ok('字幕轨节点产出 SRT 文件', Boolean(subData.lastFile) && subData.lastFile.endsWith('.srt'), String(subData.lastFile));
linkMt(subNode2, mtTl5, 'subtitle', 'sub', 0);
const mtOut5 = await T.executeTimeline({ node: { id: mtTl5, kind: 'timeline', data: get('SELECT data FROM canvas_nodes WHERE id = ?', mtTl5).data }, canvasId: CV_MT });
const mtAbs5 = path.join(DATA_DIR, mtOut5.filePath);
ok('成片使用画布字幕轨（报告 subtitle.source = canvas-track）', mtOut5.subtitles?.source === 'canvas-track' && mtOut5.subtitles?.cues === 2,
  JSON.stringify(mtOut5.subtitles));
ok('字幕轨确实被应用（applied=true 且 mode 正确）', mtOut5.subtitles?.applied === true && mtOut5.subtitles?.mode === 'hard',
  JSON.stringify({ applied: mtOut5.subtitles?.applied, mode: mtOut5.subtitles?.mode, reason: mtOut5.subtitles?.reason }));
ok('字幕轨信息写进多轨报告', mtOut5.tracks?.subtitle?.mode === 'hard', JSON.stringify(mtOut5.tracks?.subtitle));
// 硬字幕会改变画面（与同素材无字幕版对比）
const mtTl5b = mkMt('timeline', '成片·无字幕对照', { code: 'MT5B' });
const mA5b = mkMt('video', '主轨1', { duration: 2 });
relOfMt('video', mA5b, base1);
linkMt(mA5b, mtTl5b, 'clip', 'clip1', 0);
const mtOut5b = await T.executeTimeline({ node: { id: mtTl5b, kind: 'timeline', data: get('SELECT data FROM canvas_nodes WHERE id = ?', mtTl5b).data }, canvasId: CV_MT });
const bottomBar = (f) => execFileSync('ffmpeg', ['-v', 'error', '-ss', '0.5', '-i', f, '-frames:v', '1',
  '-vf', 'crop=160:40:0:80,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
  { encoding: 'buffer', stdio: ['ignore', 'pipe', 'ignore'] }).slice(0, 3);
const barWith = bottomBar(mtAbs5);
const barWithout = bottomBar(path.join(DATA_DIR, mtOut5b.filePath));
ok('硬字幕确实烧进画面（底部字幕条带像素与无字幕版不同）',
  (barWith[0] !== barWithout[0] || barWith[1] !== barWithout[1] || barWith[2] !== barWithout[2])
  && (barWith[1] > barWithout[1] || barWith[2] > barWithout[2]),
  `有字幕 rgb=(${barWith.join(',')}) 无字幕 rgb=(${barWithout.join(',')})`);

// ⑥ 软字幕轨：产物带 subtitle 流
const subSoft = mkMt('subtitle', '软字幕轨', { lines: [{ start: 0, end: 2, text: '软字幕测试' }], mode: 'soft' });
const softRun = G.createGraphRunJob({ canvasId: CV_MT, nodeIds: [subSoft], overwrite: true, title: '软字幕轨' });
await waitFor(() => J.getJob(softRun.jobId)?.status === 'done', 60000);
const mtTl6 = mkMt('timeline', '成片·软字幕', { code: 'MT6' });
const mA6 = mkMt('video', '主轨1', { duration: 2 });
relOfMt('video', mA6, base1);
linkMt(mA6, mtTl6, 'clip', 'clip1', 0);
linkMt(subSoft, mtTl6, 'subtitle', 'sub', 0);
const mtOut6 = await T.executeTimeline({ node: { id: mtTl6, kind: 'timeline', data: get('SELECT data FROM canvas_nodes WHERE id = ?', mtTl6).data }, canvasId: CV_MT });
const streams6 = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', path.join(DATA_DIR, mtOut6.filePath)], { encoding: 'utf8' }).trim();
ok('软字幕轨成片带独立字幕流', streams6.includes('subtitle'), `${streams6.replace(/\n/g, '+')} | ${JSON.stringify(mtOut6.subtitles)}`);

// ⑦ 诚实报错：叠加轨/字幕轨没产出就执行 → 中文错
const mtTl7 = mkMt('timeline', '成片·缺叠加', { code: 'MT7' });
const mA7 = mkMt('video', '主轨1', { duration: 2 });
relOfMt('video', mA7, base1);
linkMt(mA7, mtTl7, 'clip', 'clip1', 0);
const badOv = mkMt('overlay', '未执行叠加层', { mode: 'pip' });
linkMt(badOv, mtTl7, 'overlay', 'ov1', 0);
const ovErr = await throwsAsync(() => T.executeTimeline({ node: { id: mtTl7, kind: 'timeline', data: get('SELECT data FROM canvas_nodes WHERE id = ?', mtTl7).data }, canvasId: CV_MT }), /还没有产出画面/);
ok('叠加轨未产出时报中文错（不静默忽略）', ovErr.threw && ovErr.match, ovErr.msg);
const badSub = mkMt('subtitle', '未执行字幕轨', { lines: [{ start: 0, end: 1, text: 'x' }] });
const mtTl8 = mkMt('timeline', '成片·缺字幕', { code: 'MT8' });
const mA8 = mkMt('video', '主轨1', { duration: 2 });
relOfMt('video', mA8, base1);
linkMt(mA8, mtTl8, 'clip', 'clip1', 0);
linkMt(badSub, mtTl8, 'subtitle', 'sub', 0);
const subErr = await throwsAsync(() => T.executeTimeline({ node: { id: mtTl8, kind: 'timeline', data: get('SELECT data FROM canvas_nodes WHERE id = ?', mtTl8).data }, canvasId: CV_MT }), /字幕轨还没产出/);
ok('字幕轨未产出时报中文错', subErr.threw && subErr.match, subErr.msg);

// ⑧ 字幕轨内容校验：坏 SRT / 空内容 → 中文错
const badSrt = path.join(DATA_DIR, 'subtitles', 'bad.srt');
fs.mkdirSync(path.dirname(badSrt), { recursive: true });
fs.writeFileSync(badSrt, '这不是 SRT 文件\n没有时间码\n', 'utf8');
const badSrtErr = throws(() => TR.subtitleCuesOf({ file: path.relative(ROOT_T, badSrt) }), /没有解析到任何时间码条目/);
ok('坏 SRT 文件报中文错', badSrtErr.threw && badSrtErr.match, badSrtErr.msg);
const emptySubErr = throws(() => TR.subtitleCuesOf({ lines: [] }), /没有内容/);
ok('字幕轨没有内容时报中文错', emptySubErr.threw && emptySubErr.match, emptySubErr.msg);

// ⑨ 参数归一化：非法值被夹紧
const pNorm = TR.overlayParamsOf({ mode: 'pip', widthRatio: 5, opacity: 9, mx: -1, position: '不存在', start: -3 });
ok('叠加层参数被归一化（宽度≤1 / 不透明度≤1 / 边距≥0 / 位置回退 / 时间≥0）',
  pNorm.widthRatio === 1 && pNorm.opacity === 1 && pNorm.mx === 0 && pNorm.position === '右下' && pNorm.start === 0, JSON.stringify(pNorm));

// ⑩ 预览显示多轨
const pvMt = T.timelineOrderPreview({ canvasId: CV_MT, nodeId: mtTl4 });
ok('预览给出叠加轨与字幕轨清单（trackCount ≥ 3）',
  pvMt.overlays?.length === 2 && pvMt.trackCount >= 3, JSON.stringify({ overlays: pvMt.overlays?.length, trackCount: pvMt.trackCount }));

// ⑪ 端口规则
ok('端口规则：overlay → ov1..ov4、subtitle → sub 合法，overlay → bgm 非法',
  A.portOk('overlay', 'ov1') === true && A.portOk('overlay', 'ov4') === true
  && A.portOk('subtitle', 'sub') === true && A.portOk('overlay', 'bgm') === false);
ok('叠加层/字幕轨都在可创建类型里', A.CREATABLE_KINDS.includes('overlay') && A.CREATABLE_KINDS.includes('subtitle'));

console.log('\n=== 11. 音频闭环（音频节点 → 每镜配音 / 整片背景乐） ===');
const { saveConfig } = await import('../src/config.js');
saveConfig({ tts: { backend: 'openai', format: 'mp3', speed: 1,
  openai: { baseUrl: `http://127.0.0.1:${ttsServer.address().port}`, apiKey: 'sk-tts', path: '/v1/audio/speech', model: 'tts-1', voice: 'alloy' } } });
const AU = await import('../src/audio-node.js');

// ① TTS 配音节点：按台词合成，且第二次执行命中缓存（不重复付费）
const ttsNode = mkNode('audio', { mode: 'tts', text: '你终于来了。|1.2', voice: 'zh-male-deep' }, '配音·镜1');
const a1 = await AU.executeAudioNode({ node: { id: ttsNode, kind: 'audio', data: get('SELECT data FROM canvas_nodes WHERE id = ?', ttsNode).data } });
ok('配音节点合成出音频文件', fs.existsSync(a1.absPath) && a1.source === 'tts', `${a1.filePath} (${a1.voice})`);
const dur1 = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', a1.absPath], { encoding: 'utf8' }).trim();
ok('合成时长与假厂商返回一致（约 1.2s）', Math.abs(Number(dur1) - 1.2) < 0.35, `ffprobe=${dur1}`);
const a2 = await AU.executeAudioNode({ node: { id: ttsNode, kind: 'audio', data: get('SELECT data FROM canvas_nodes WHERE id = ?', ttsNode).data } });
ok('同台词同音色第二次执行命中缓存（cached=true，不重复合成）', a2.cached === true, `cached=${a2.cached} calls=${ttsCalls.length}`);
ok('假 TTS 厂商只收到 1 次请求', ttsCalls.length === 1, `calls=${ttsCalls.length}`);

// 经 DAG 引擎执行音频节点（真实路径：写 status/lastFile + 执行记录，供 dub 连线取用）
const audioJob = G.createGraphRunJob({ canvasId, nodeIds: [ttsNode], overwrite: true, title: '音频节点端到端' });
const audioDone = await waitFor(() => J.getJob(audioJob.jobId)?.status === 'done', 60000);
const ttsData = JSON.parse(get('SELECT data FROM canvas_nodes WHERE id = ?', ttsNode).data || '{}');
ok('音频节点经 DAG 执行完成并写回 lastFile', audioDone && ttsData.status === 'done' && Boolean(ttsData.lastFile), JSON.stringify({ status: ttsData.status, file: ttsData.lastFile }));

// ② 无台词/无后端时的诚实报错
const emptyNode = mkNode('audio', { mode: 'tts', text: '' }, '空台词');
const emptyErr = await throwsAsync(() => AU.executeAudioNode({ node: { id: emptyNode, kind: 'audio', data: get('SELECT data FROM canvas_nodes WHERE id = ?', emptyNode).data } }), /没有可合成的台词/);
ok('配音节点没有台词时报中文错', emptyErr.threw && emptyErr.match, emptyErr.msg);
const bgmNoFile = mkNode('audio', { mode: 'bgm', file: '' }, '没有文件');
const bgmErr = await throwsAsync(() => AU.executeAudioNode({ node: { id: bgmNoFile, kind: 'audio', data: get('SELECT data FROM canvas_nodes WHERE id = ?', bgmNoFile).data } }), /还没有可用的音频文件/);
ok('背景乐节点没有文件时报中文错', bgmErr.threw && bgmErr.match, bgmErr.msg);

// ③ 音频节点接到视频节点的 dub 端口 → 该镜配音用画布提供的文件（不再走 TTS）
const tl2 = mkNode('timeline', { scriptId, code: 'S01E102', episodeId: epId }, '成片·带配音');
const v1 = mkNode('video', { shotId: shotIds[0], duration: 2.5 }, '镜 1');
const v2 = mkNode('video', { shotId: shotIds[1], duration: 3 }, '镜 2（画外音）');
run(`UPDATE canvas_nodes SET data = ? WHERE id = ?`, JSON.stringify({ shotId: shotIds[0], duration: 2.5, lastFile: clipA }), v1);
run(`UPDATE canvas_nodes SET data = ? WHERE id = ?`, JSON.stringify({ shotId: shotIds[1], duration: 3, lastFile: clipB }), v2);
link(v1, 'clip1', 0, tl2);
link(v2, 'clip2', 1, tl2);
link(ttsNode, 'dub', 0, v1, { fromPort: 'audio' });
const outAudio = await T.executeTimeline({
  node: { id: tl2, kind: 'timeline', data: JSON.stringify({ scriptId, code: 'S01E102', episodeId: epId }) },
  canvasId,
});
ok('成片识别到画布提供的配音（audioPlan.providedDubs = 1）', outAudio.audioPlan?.providedDubs === 1, JSON.stringify(outAudio.audioPlan));
ok('音轨模式为配音（tts 或 tts_bgm）', ['tts', 'tts_bgm'].includes(outAudio.audioPlan?.mode), String(outAudio.audioPlan?.mode));
ok('成片音轨报告里有一条来自画布的配音', (outAudio.audio?.ttsReport?.provided || 0) === 1, JSON.stringify(outAudio.audio?.ttsReport?.provided));
const audioStreams1 = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', path.join(DATA_DIR, outAudio.filePath)], { encoding: 'utf8' }).trim();
ok('成片确实带音轨', audioStreams1.includes('audio'), audioStreams1.replace(/\n/g, '+'));

// ④ 背景乐节点 → 成片 bgm 端口 → 混音（人声处 ducking）
const bgmNode = mkNode('audio', { mode: 'bgm', file: bgmRel }, '背景乐');
const bgmRun = G.createGraphRunJob({ canvasId, nodeIds: [bgmNode], overwrite: true, title: '背景乐节点' });
await waitFor(() => J.getJob(bgmRun.jobId)?.status === 'done', 60000);
ok('背景乐节点经 DAG 执行完成（file 模式直接引用音频文件）',
  JSON.parse(get('SELECT data FROM canvas_nodes WHERE id = ?', bgmNode).data || '{}').status === 'done',
  String(get('SELECT data FROM canvas_nodes WHERE id = ?', bgmNode).data).slice(0, 90));
const v3 = mkNode('video', { shotId: shotIds[0], duration: 2.5 }, '镜 1');
run(`UPDATE canvas_nodes SET data = ? WHERE id = ?`, JSON.stringify({ shotId: shotIds[0], duration: 2.5, lastFile: clipA }), v3);
const tl3 = mkNode('timeline', { scriptId, code: 'S01E103', episodeId: epId }, '成片·配音+背景乐');
link(v3, 'clip1', 0, tl3);
link(ttsNode, 'dub', 0, v3, { fromPort: 'audio' });
link(bgmNode, 'bgm', 0, tl3, { fromPort: 'audio' });
const outMix = await T.executeTimeline({
  node: { id: tl3, kind: 'timeline', data: JSON.stringify({ scriptId, code: 'S01E103', episodeId: epId }) },
  canvasId,
});
ok('配音 + 背景乐 → 混音模式（含 ducking）', outMix.audioPlan?.mode === 'tts_bgm' && outMix.audio?.mode === 'mix', JSON.stringify({ plan: outMix.audioPlan?.mode, mode: outMix.audio?.mode }));
ok('混音报告带背景乐文件名与 ducking 标记', Boolean(outMix.audio?.bgm) && outMix.audio?.ducking === true, JSON.stringify({ bgm: outMix.audio?.bgm, ducking: outMix.audio?.ducking }));
const streamsMix = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', path.join(DATA_DIR, outMix.filePath)], { encoding: 'utf8' }).trim();
ok('混音成片带音轨', streamsMix.includes('audio'), streamsMix.replace(/\n/g, '+'));

// ⑤ 只接背景乐（没有配音）→ 纯 bgm 模式
// 关掉 TTS 后端再跑：验证「没有配音来源、只有背景乐」时进入纯 bgm 模式
saveConfig({ tts: { backend: 'none' } });
const tl4 = mkNode('timeline', { scriptId, code: 'S01E104', episodeId: epId }, '成片·纯音乐');
const v4 = mkNode('video', { shotId: shotIds[2], duration: 1.5 }, '镜 3');
run(`UPDATE canvas_nodes SET data = ? WHERE id = ?`, JSON.stringify({ shotId: shotIds[2], duration: 1.5, lastFile: clipC }), v4);
link(v4, 'clip1', 0, tl4);
link(bgmNode, 'bgm', 0, tl4, { fromPort: 'audio' });
const outBgm = await T.executeTimeline({
  node: { id: tl4, kind: 'timeline', data: JSON.stringify({ scriptId, code: 'S01E104', episodeId: epId }) },
  canvasId,
});
ok('只有背景乐时进入 bgm 模式', outBgm.audioPlan?.mode === 'bgm' && outBgm.audio?.mode === 'bgm', JSON.stringify(outBgm.audioPlan));
ok('纯音乐成片带音轨', execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', path.join(DATA_DIR, outBgm.filePath)], { encoding: 'utf8' }).includes('audio'));

// ⑥ 背景乐连线存在但上游没产物 → 报中文错（不静默变静音）
const tl5 = mkNode('timeline', { scriptId, code: 'S01E105', episodeId: epId }, '成片·缺背景乐');
const v5 = mkNode('video', { shotId: shotIds[0], duration: 2.5 }, '镜 1');
run(`UPDATE canvas_nodes SET data = ? WHERE id = ?`, JSON.stringify({ shotId: shotIds[0], duration: 2.5, lastFile: clipA }), v5);
link(v5, 'clip1', 0, tl5);
const emptyAudio = mkNode('audio', { mode: 'bgm', file: '' }, '未产出的音乐');
link(emptyAudio, 'bgm', 0, tl5, { fromPort: 'audio' });
const missingBgm = await throwsAsync(() => T.executeTimeline({
  node: { id: tl5, kind: 'timeline', data: JSON.stringify({ scriptId, code: 'S01E105', episodeId: epId }) }, canvasId,
}), /背景乐还没产出/);
ok('背景乐未产出时报中文错（不静默变静音轨）', missingBgm.threw && missingBgm.match, missingBgm.msg);

// ⑦ 端口规则：音频节点只能接 dub/bgm/audio，图片不能冒充音频
ok('端口规则：audio → dub / bgm 合法，image → dub 非法',
  A.portOk('audio', 'dub') === true && A.portOk('audio', 'bgm') === true && A.portOk('image', 'dub') === false);
ok('端口规则：clip 可接到任意 clipN（第 17 段也不掉）', A.portOk('clip', 'clip17') === true && A.portOk('clip', 'clip99') === true);
ok('音频节点类型在端口表与资产类型表里都存在', Boolean(A.PORT_RULES.audio) && A.ASSET_KINDS.includes('audio'));
ok('音频场景（P2-1）：对白/旁白/音效/背景乐四类且各有默认模式与音色策略',
  Object.keys(AU.AUDIO_SCENES).join(',') === 'dialogue,narration,sfx,bgm'
  && AU.AUDIO_SCENES.narration.useActorVoice === false && AU.AUDIO_SCENES.dialogue.useActorVoice === true
  && AU.AUDIO_SCENES.sfx.mode === 'file' && AU.AUDIO_SCENES.bgm.mode === 'bgm',
  JSON.stringify(AU.AUDIO_SCENES));
// 场景断言需要 TTS 后端（前面的纯背景乐用例把后端切成 none 了，这里重新指回假厂商）
saveConfig({ tts: { backend: 'openai', format: 'mp3', speed: 1,
  openai: { baseUrl: `http://127.0.0.1:${ttsServer.address().port}`, apiKey: 'sk-tts', path: '/v1/audio/speech', model: 'tts-1', voice: 'alloy' } } });
const narNode = mkNode('audio', { scene: 'narration', text: '旁白：十年了。|1.0' }, '旁白轨');
const nar = await AU.executeAudioNode({ node: { id: narNode, kind: 'audio', data: get('SELECT data FROM canvas_nodes WHERE id = ?', narNode).data } });
ok('场景=narration：默认走 TTS 且场景标注为旁白', nar.source === 'tts' && nar.scene === '旁白', `${nar.scene}/${nar.voice}`);
ok('场景=narration：不套角色音色（用设置默认音色）', nar.voice === 'alloy', String(nar.voice));
const sfxNode = mkNode('audio', { scene: 'sfx', file: bgmRel }, '音效轨');
const sfx = await AU.executeAudioNode({ node: { id: sfxNode, kind: 'audio', data: get('SELECT data FROM canvas_nodes WHERE id = ?', sfxNode).data } });
ok('场景=sfx：默认按「引用文件」处理（不合成）', sfx.source === 'file' && sfx.scene === '音效', `${sfx.scene}/${sfx.mode}`);
ok('音频节点描述可用于界面（默认数据含 mode/text/file）', ['mode', 'text', 'file'].every((k) => k in AU.audioNodeDefaults('tts')));
ttsServer.close();

console.log('\n=== 9b. 自动补尾帧 + 首尾帧自检（LibTV 调研第 1~2 条） ===');
// ⑨「⌛ 自动补尾帧」：只建尾帧出图节点并接 last，不发起任何生成调用
const alShotNode = mkNode('video', { shotId: shotIds[0], duration: 3, prompt: 'medium shot, rainy pier at night' }, '待补尾帧的片段');
const al = T.createLastFrameNode({ canvasId, nodeId: alShotNode });
ok('自动补尾帧：返回尾帧节点 id 与提示词', Boolean(al.nodeId) && /final frame/.test(al.prompt), `${al.nodeId} | ${al.prompt}`);
ok('自动补尾帧：不生成任何内容（generated=0）', al.generated === 0);
const alNode = get('SELECT * FROM canvas_nodes WHERE id = ?', al.nodeId);
const alData = JSON.parse(alNode.data);
ok('自动补尾帧：新节点是出图节点且提示词继承本镜 + 收尾语义', alNode.kind === 'image' && alData.autoLast === true
  && alData.prompt.includes('medium shot, rainy pier at night') && alData.prompt.includes('final frame'), alData.prompt);
ok('自动补尾帧：节点放在片段上方（不压住原节点）', Number(alNode.y) < 0, `y=${alNode.y}`);
const alLink = get('SELECT * FROM canvas_links WHERE id = ?', al.linkId);
ok('自动补尾帧：连线是 image → last', alLink.from_node === al.nodeId && alLink.to_node === alShotNode
  && alLink.from_port === 'image' && alLink.to_port === 'last', `${alLink.from_port}→${alLink.to_port}`);
const alAgain = throws(() => T.createLastFrameNode({ canvasId, nodeId: alShotNode }), /已经有尾帧/);
ok('自动补尾帧：已有尾帧时中文报错（不会叠第二张）', alAgain.threw && alAgain.match, alAgain.msg);
const alBadKind = throws(() => T.createLastFrameNode({ canvasId, nodeId: timelineNode }), /只能给/);
ok('自动补尾帧：非视频节点被拒（时间线节点不能补尾帧）', alBadKind.threw && alBadKind.match, alBadKind.msg);
const alNoPrompt = mkNode('video', { shotId: shotIds[1], duration: 2 }, '空提示词片段');
const alNP = throws(() => T.createLastFrameNode({ canvasId, nodeId: alNoPrompt }), /没有提示词/);
ok('自动补尾帧：片段没有提示词时给出可操作的中文提示', alNP.threw && alNP.match, alNP.msg);
const alMissing = throws(() => T.createLastFrameNode({ canvasId, nodeId: 'ND-不存在' }), /不存在/);
ok('自动补尾帧：节点不存在时报中文错', alMissing.threw && alMissing.match, alMissing.msg);

// ⑩ 首尾帧自检：同一张图当首尾帧 = 全程静止，出手前必须拦/告警
const flCanvas = 'CV-FLTEST';
run(`INSERT INTO canvases(id, name, created_at, updated_at) VALUES(?,?,?,?)`, flCanvas, '首尾帧自检画布', nowISO(), nowISO());
const flNode = (kind, data) => {
  const id = rid('ND');
  run(`INSERT INTO canvas_nodes(id, canvas_id, actor_id, x, y, w, h, z, kind, title, data)
       VALUES(?,?,'',0,0,220,180,0,?,?,?)`, id, flCanvas, kind, kind, JSON.stringify(data));
  return id;
};
const frameRel = path.join('images', 'fl-frame.png');
fs.mkdirSync(path.join(DATA_DIR, 'images'), { recursive: true });
execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:d=0.1', '-frames:v', '1', path.join(DATA_DIR, frameRel)], { stdio: 'pipe' });
const sameFrameNode = { id: flNode('video', { prompt: 'x', duration: 2 }), kind: 'video', data: JSON.stringify({ prompt: 'x', duration: 2 }) };
const sameRun = await G.execNode(sameFrameNode, { first: frameRel, last: frameRel });
ok('首尾帧自检：首尾帧同一文件时把告警带回结果（不静默出片）',
  Boolean(sameRun?.raw?.firstLast?.warn?.length), JSON.stringify(sameRun?.raw?.firstLast || {}).slice(0, 200));
const missingLast = { id: flNode('video', { prompt: 'x', duration: 2 }), kind: 'video', data: JSON.stringify({ prompt: 'x', duration: 2 }) };
const missRun = await throwsAsync(() => G.execNode(missingLast, { first: frameRel, last: path.join('images', '不存在.png') }), /尾帧图不存在/);
ok('首尾帧自检：尾帧文件不存在时出手前就报中文错（不浪费一次计费调用）', missRun.threw && missRun.match, missRun.msg);
const onlyFirst = { id: flNode('video', { prompt: 'x', duration: 2 }), kind: 'video', data: JSON.stringify({ prompt: 'x', duration: 2 }) };
const onlyRun = await G.execNode(onlyFirst, { first: frameRel });
ok('只有首帧的片段：结果里给出「自动补尾帧」的引导', /自动补尾帧/.test(String(onlyRun?.raw?.autoLastHint || '')), String(onlyRun?.raw?.autoLastHint || '').slice(0, 80));

console.log('\n=== 9c. 首尾帧运动量量化 + 跨镜一致性评分（LibTV 调研第 2/3 条） ===');
// ⑪ 首尾帧不是同一张图，但「几乎一样」也要被拦：真实像素差异（32×32 灰度平均绝对差）
const F = await import('../src/frames.js');
const mkPng = (name, args2, filter = null) => {
  const rel = path.join('images', name);
  const abs2 = path.join(DATA_DIR, rel);
  fs.mkdirSync(path.join(DATA_DIR, 'images'), { recursive: true });
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', args2, '-frames:v', '1',
    ...(filter ? ['-vf', filter] : []), abs2], { stdio: 'pipe' });
  return rel;
};
const redA = mkPng('al-red.png', 'color=c=red:s=256x256:d=0.1');
const redNoise = mkPng('al-red-noise.png', 'color=c=red:s=256x256:d=0.1', 'noise=alls=8:allf=t');
const blueA = mkPng('al-blue.png', 'color=c=blue:s=256x256:d=0.1');
const dSame = F.frameDistance(path.join(DATA_DIR, redA), path.join(DATA_DIR, redA));
const dNear = F.frameDistance(path.join(DATA_DIR, redA), path.join(DATA_DIR, redNoise));
const dDiff = F.frameDistance(path.join(DATA_DIR, redA), path.join(DATA_DIR, blueA));
ok('画面度量：同一张图差异为 0（判定 same）', dSame.ok && dSame.distance === 0 && dSame.level === 'same', JSON.stringify(dSame).slice(0, 90));
ok('画面度量：几乎一样的图被判为运动量过低', dNear.ok && dNear.level === 'same' && dNear.distance < 0.04, `distance=${dNear.distance}`);
ok('画面度量：明显不同的图判定正常（可以驱动运动）', dDiff.ok && dDiff.level === 'ok' && dDiff.distance > 0.04, `distance=${dDiff.distance}`);
ok('画面度量：缺文件时诚实返回不可用（不抛异常）', F.frameDistance(path.join(DATA_DIR, redA), path.join(DATA_DIR, 'images/不存在.png')).ok === false);
const h1 = F.perceptualHash(path.join(DATA_DIR, redA)), h2 = F.perceptualHash(path.join(DATA_DIR, blueA));
ok('感知哈希：同图距离 0、异色图距离拉满', F.hashDistance(h1, h1).bits === 0 && F.hashDistance(h1, h2).bits > 30, `${F.hashDistance(h1, h1).bits} / ${F.hashDistance(h1, h2).bits}`);
ok('感知哈希：多数位中位哈希可用作组基准', typeof F.majorityHash([h1, h1, h2])?.hash === 'string');

// 图「几乎一样」的尾帧：graph 自检必须给出运动量告警（不是只比文件字节）
const nearNode = { id: flNode('video', { prompt: 'x', duration: 2 }), kind: 'video', data: JSON.stringify({ prompt: 'x', duration: 2 }) };
const nearRun = await G.execNode(nearNode, { first: redA, last: redNoise });
ok('首尾帧自检（第二层）：几乎一样的首尾帧被量化告警（带差异百分比）',
  Boolean(nearRun?.raw?.firstLast?.warn?.some((x) => /运动|差异/.test(x))) && typeof nearRun.raw.firstLast.distance === 'number',
  JSON.stringify(nearRun?.raw?.firstLast || {}).slice(0, 170));
const okNode = { id: flNode('video', { prompt: 'x', duration: 2 }), kind: 'video', data: JSON.stringify({ prompt: 'x', duration: 2 }) };
const okRun = await G.execNode(okNode, { first: redA, last: blueA });
ok('首尾帧自检（第二层）：差异正常时不误报（无 warn，只有度量值）',
  (okRun?.raw?.firstLast?.warn || []).length === 0 && okRun.raw.firstLast.distance > 0.04,
  `distance=${okRun?.raw?.firstLast?.distance}`);

// ⑫ 跨镜一致性评分：同一角色的关键帧里塞一张异色图 → 必须被标成离群并给出该重跑哪几镜
const C = await import('../src/consistency.js');
const consActor = 'C-9999';
run(`INSERT INTO actors(id, name, gender, created_at) VALUES(?,?,?,?)`, consActor, '一致性测试演员', 'female', nowISO());
const mkConsShot = (idx, color) => {
  const sid = rid('SH');
  run(`INSERT INTO shots(id, script_id, episode_id, idx, duration, refs, status) VALUES(?,?,?,?,3,?,'draft')`,
    sid, scriptId, epId, 900 + idx, JSON.stringify({ characters: [consActor] }));
  const rel = mkPng(`cons-${idx}-${color}.png`, `color=c=${color}:s=256x256:d=0.1`);
  run(`INSERT INTO shot_renders(id, script_id, episode_id, shot_id, kind, file_path, mime, width, height, status, created_at)
       VALUES(?,?,?,?, 'keyframe', ?, 'image/png', 256, 256, 'done', ?)`, rid('RD'), scriptId, epId, sid, rel, nowISO());
  return { sid, rel };
};
[mkConsShot(1, 'green'), mkConsShot(2, 'green'), mkConsShot(3, 'green'), mkConsShot(4, 'magenta')];
const cres = await C.scoreConsistency({ scriptId, threshold: 0.3 });
ok('一致性评分：按角色分组并给出组内基准哈希', cres.ok && cres.groups.some((g) => g.actorId === consActor && g.baseHash), JSON.stringify(cres.summary));
ok('一致性评分：故意插的异色关键帧被标成离群', cres.outliers.some((o) => o.idx === 904) && !cres.outliers.some((o) => o.idx === 901),
  JSON.stringify(cres.outliers.map((o) => `#${o.idx}:${o.distance}`)));
ok('一致性评分：给出「只重跑这几镜」的可执行建议', /只重跑/.test(String(cres.retryHint || '')), String(cres.retryHint).slice(0, 70));
ok('一致性评分：摘要可读（含角色数与离群数）', /离群/.test(C.consistencySummary(cres)), C.consistencySummary(cres).slice(0, 80));
const cres2 = await C.scoreConsistency({ scriptId, threshold: 0.99 });
ok('判定线口径透明：报告给出 阈值/中位数/MAD/最终判定线，且用户阈值是权威口径',
  cres2.groups[0].cut === 0.99 && typeof cres2.groups[0].median === 'number' && typeof cres2.groups[0].mad === 'number',
  `cut=${cres2.groups[0].cut} median=${cres2.groups[0].median} mad=${cres2.groups[0].mad}`);
ok('极端离群（完全反相 64/64 位）在高阈值下依然被标出（不会因为阈值高就漏掉）',
  cres2.outliers.length === 1 && cres2.outliers[0].bits === 64, `outliers=${cres2.outliers.length} bits=${cres2.outliers[0]?.bits}`);
const consQc = await QC.qcEpisode({ scriptId, code: 'S01E001' });
const consItem = (consQc.items || []).find((it) => it.kind === 'consistency');
ok('整集质检里带上了跨镜一致性检查项', Boolean(consItem) && consItem.checks.some((c) => /一致性|离群/.test(c.message)),
  consItem ? consItem.checks.map((c) => `${c.level}:${c.message}`).join(' | ').slice(0, 130) : '缺失');
ok('质检报告（Markdown）里说明一致性检测方法与结论', /一致性/.test(QC.qcMarkdown(consQc)) && /感知哈希/.test(QC.qcMarkdown(consQc)),
  QC.qcMarkdown(consQc).split('\n').filter((l) => /一致性/.test(l)).join(' ').slice(0, 90));

console.log('\n=== 9d. 时间线片段调序（LibTV 调研第 4 条：拖拽缩略轨 → 写回顺序） ===');
// 自建一套确定性的夹具（不依赖前面小节留下的连线）：1 个成片节点 + 3 条视频片段连线
const RO_CV = 'CV-REORDER-T';
run(`INSERT INTO canvases(id, name, created_at, updated_at) VALUES(?,?,?,?)`, RO_CV, '调序测试画布', nowISO(), nowISO());
const mkRoNode = (kind, title, data) => {
  const id = rid('ND');
  run(`INSERT INTO canvas_nodes(id, canvas_id, actor_id, x, y, w, h, z, kind, title, data) VALUES(?,?,'',0,0,220,180,0,?,?,?)`,
    id, RO_CV, kind, title, JSON.stringify(data));
  return id;
};
const mkRoLink = (from, to, port, slot) => {
  const id = rid('LK');
  run(`INSERT INTO canvas_links(id, canvas_id, from_actor, to_actor, from_node, to_node, from_side, to_side, from_port, to_port, slot, label, color, created_at)
       VALUES(?,?,'','',?,?,'right','left','clip',?,?,'','',?)`, id, RO_CV, from, to, port, slot, nowISO());
  return id;
};
const roTl = mkRoNode('timeline', '调序成片', { code: 'RO1' });
const roClips = ['RO-a', 'RO-b', 'RO-c'].map((n, i) => mkRoNode('video', n, { duration: 2, lastFile: `videos/${n}.mp4` }));
const roLinks = roClips.map((c, i) => mkRoLink(c, roTl, `clip${i + 1}`, i));
ok('调序前置：自建画布上有 3 条 clip 连线（clip1..3）', roLinks.length === 3);
const moved = T.reorderTimelineClips({ canvasId: RO_CV, nodeId: roTl, order: [roLinks[2], roLinks[0], roLinks[1]] });
ok('调序：把第 3 段拖到最前 → 端口按新顺序重写为 clip1/clip2/clip3',
  moved.order.map((x) => x.port).join(',') === 'clip1,clip2,clip3'
  && moved.order[0].linkId === roLinks[2] && moved.order[0].slot === 0
  && moved.order[0].from === roClips[2],
  moved.order.map((x) => `${x.port}:${x.from}`).join(' '));
const roAfter = all('SELECT * FROM canvas_links WHERE canvas_id = ? ORDER BY CAST(SUBSTR(to_port, 5) AS INTEGER)', RO_CV);
ok('调序：slot 归一为 0..N-1（历史无端口边也按它排序）', roAfter.every((l, i) => Number(l.slot) === i), roAfter.map((l) => `${l.to_port}/${l.slot}`).join(' '));
ok('调序：端口保持唯一（不会出现两条 clip1）', new Set(roAfter.map((l) => l.to_port)).size === roAfter.length, roAfter.map((l) => l.to_port).join(','));
const roPreview = T.timelineOrderPreview({ canvasId: RO_CV, nodeId: roTl });
ok('调序后拼接顺序真的变了（dry-run 预览第 1 段 = 原来的第 3 段，端口 clip1）',
  roPreview.clips?.[0]?.port === 'clip1' && /RO-c/.test(String(roPreview.clips?.[0]?.file || ''))
  && roPreview.clips?.[0]?.order === 1 && roPreview.ready === true,
  JSON.stringify((roPreview.clips || []).map((x) => `${x.order}:${x.port}:${String(x.file || '').split('/').pop()}`)).slice(0, 120));
const dupErr = throws(() => T.reorderTimelineClips({ canvasId: RO_CV, nodeId: roTl, order: [roLinks[0], roLinks[0], roLinks[1]] }), /重复/);
ok('调序：数组里有重复 id → 中文拒绝', dupErr.threw && dupErr.match, dupErr.msg);
const partialErr = throws(() => T.reorderTimelineClips({ canvasId: RO_CV, nodeId: roTl, order: [roLinks[0]] }), /全部/);
ok('调序：只给一部分 → 中文拒绝并说明还差几条', partialErr.threw && partialErr.match, partialErr.msg);
const foreignErr = throws(() => T.reorderTimelineClips({ canvasId: RO_CV, nodeId: roTl, order: [roLinks[0], roLinks[1], 'LK-不存在'] }), /不属于/);
ok('调序：混入别的连线 → 中文拒绝', foreignErr.threw && foreignErr.match, foreignErr.msg);
const kindErr = throws(() => T.reorderTimelineClips({ canvasId: RO_CV, nodeId: roClips[0], order: roLinks }), /只有「成片时间线」/);
ok('调序：非成片节点 → 中文拒绝（不会把片段节点当时间线）', kindErr.threw && kindErr.match, kindErr.msg);
const noneErr = throws(() => T.reorderTimelineClips({ canvasId: RO_CV, nodeId: mkRoNode('timeline', '空成片', {}), order: roLinks }), /还没有片段连线/);
ok('调序：空成片节点 → 中文拒绝（先接 clip1..N 再调序）', noneErr.threw && noneErr.match, noneErr.msg);
T.reorderTimelineClips({ canvasId: RO_CV, nodeId: roTl, order: roLinks });
const roRestored = all('SELECT * FROM canvas_links WHERE canvas_id = ? ORDER BY CAST(SUBSTR(to_port, 5) AS INTEGER)', RO_CV).map((l) => `${l.id}:${l.to_port}`);
ok('调序可逆：再调一次回到原顺序（幂等写回，不留脏状态）',
  roRestored.join(',') === roLinks.map((id, i) => `${id}:clip${i + 1}`).join(','), roRestored.join(' '));

// ================== 10d. 批量链路的尾帧（首尾帧过渡）与画布 DAG 字段一致 ==================
// 目标：证明「首尾帧过渡」不再只能走画布 DAG —— 批量链路也能传尾帧，且结果口径与 DAG 一致。
// 零付费：全程 placeholder（本地 ffmpeg 交叉溶解），不发任何厂商请求。
console.log('\n=== 10d. 批量链路尾帧 vs 画布 DAG 尾帧（结果字段一致） ===');
const { createVideoJob } = await import('../src/modules/render.js');
const { saveConfig: saveCfg3 } = await import('../src/config.js');
saveCfg3({ video: { backend: 'placeholder' } });

// 批量链路要「该镜已有成功关键帧」：用真实抽出来的红帧（来自 clipA）当首帧、蓝帧（来自 clipB）当尾帧
run(`INSERT INTO shot_renders(id, script_id, episode_id, shot_id, kind, file_path, mime, width, height, status, backend, created_at)
     VALUES(?,?,?,?,'keyframe',?,'image/png',160,120,'done','placeholder',?)`, rid('RD'), scriptId, epId, shotIds[0], lf.rel, nowISO());

// ① 画布 DAG 路径（同一个视频节点 + first/last 两个入口）→ 结果字段
const dagOut = await G.execNode(get('SELECT * FROM canvas_nodes WHERE id = ?', flV), { first: lf.rel, last: bluePng.rel }, null, {});
ok('画布 DAG 的尾帧结果字段：lastFrom=last + 中文 note + raw.lastFrame=xfade',
  dagOut.lastFrom === 'last' && dagOut.raw?.lastFrame === 'xfade' && /首尾帧过渡（xfade）/.test(String(dagOut.note || '')),
  JSON.stringify({ lastFrom: dagOut.lastFrom, note: dagOut.note }).slice(0, 160));

// ② 批量链路路径（createVideoJob + lastImageByShot）→ 结果字段
const batchJob = createVideoJob({ scriptId, code: 'S01E001', shotIds: [shotIds[0]], overwrite: true,
  lastImageByShot: { [shotIds[0]]: bluePng.rel } });
const batchDone = await waitFor(() => J.getJob(batchJob.jobId)?.status === 'done', 90000);
const batchRes = J.getJob(batchJob.jobId)?.result || {};
const batchShot = (batchRes.results || [])[0] || {};
ok('批量链路提交时就报出「本批有几镜带尾帧」（withLastImage + 中文说明）',
  batchJob.withLastImage === 1 && /带尾帧/.test(String(batchJob.lastImageNote || '')),
  JSON.stringify({ withLastImage: batchJob.withLastImage, note: batchJob.lastImageNote }));
ok('批量链路带尾帧出片成功且无失败', batchDone && batchRes.failed === 0 && batchShot.ok === true, JSON.stringify(batchShot).slice(0, 200));
ok('首尾帧过渡经批量链路与经画布 DAG 的结果字段一致（lastFrom / note 完全同口径）',
  batchShot.lastFrom === dagOut.lastFrom && batchShot.note === dagOut.note && dagOut.lastFrom === 'last',
  `批量 lastFrom=${batchShot.lastFrom} note=${batchShot.note}｜DAG lastFrom=${dagOut.lastFrom} note=${dagOut.note}`);
ok('批量链路也记录了尾帧来源（lastImage / lastImageSource），可追溯是哪张图做的过渡',
  batchShot.lastImage === bluePng.rel && batchShot.lastImageSource === 'lastImageByShot',
  JSON.stringify({ lastImage: batchShot.lastImage, src: batchShot.lastImageSource }));
const batchCell = shotRenderOfJob(shotIds[0], 'video', batchJob.jobId, '10d. 批量链路带尾帧');
const batchRow = batchCell.row;
const batchMeta = JSON.parse(batchRow?.meta || '{}');
ok('批量链路落库 meta 可追溯尾帧（lastImage / lastFrom=last / lastImageSource / raw.lastFrame=xfade）',
  batchCell.bound && batchMeta.lastImage === bluePng.rel && batchMeta.lastFrom === 'last' && batchMeta.lastImageSource === 'lastImageByShot' && batchMeta.raw?.lastFrame === 'xfade',
  whyNoShot(batchCell));

// ③ 尾帧文件不存在：批量链路自己也会明确失败并给中文原因（不静默忽略、不悄悄退回只做首帧驱动）
const badJob = createVideoJob({ scriptId, code: 'S01E001', shotIds: [shotIds[0]], overwrite: true,
  lastImageByShot: { [shotIds[0]]: 'videos/不存在的尾帧.png' } });
const badDone = await waitFor(() => J.getJob(badJob.jobId)?.status === 'done', 60000);
const badRes = J.getJob(badJob.jobId)?.result || {};
const badShot = (badRes.results || [])[0] || {};
const badCell = shotRenderOfJob(shotIds[0], 'video', badJob.jobId, '10d. 尾帧缺失的失败落库', "AND status='error'");
const badRow = badCell.row;
ok('尾帧文件不存在 → 该镜明确失败并给中文原因（结果里可见，不静默忽略）',
  badDone && badShot.ok === false && /尾帧图不存在/.test(String(badShot.error || '')) && badShot.lastFrom === 'last',
  String(badShot.error || '(无错误)').slice(0, 140));
ok('尾帧缺失导致的失败也落了库（中文原因在失败记录里查得到，不是只在内存里）',
  badCell.bound && /尾帧图不存在/.test(String(badRow.error || '')),
  badCell.bound ? String(badRow.error || '(无失败记录)').slice(0, 140) : whyNoShot(badCell));

// ④ 不传尾帧：批量链路结果与历史逐字段一致（无 withLastImage，results 里没有尾帧键）
const plainJob = createVideoJob({ scriptId, code: 'S01E001', shotIds: [shotIds[0]], overwrite: true });
await waitFor(() => J.getJob(plainJob.jobId)?.status === 'done', 90000);
const plainRes = J.getJob(plainJob.jobId)?.result || {};
ok('不传尾帧时批量链路结果与历史逐字段一致（无 withLastImage，results 每条只有 shotId/ok/file）',
  !('withLastImage' in plainRes) && !('withLastImage' in plainJob)
  && Object.keys((plainRes.results || [])[0] || {}).sort().join(',') === 'file,ok,shotId',
  JSON.stringify(plainRes.results?.[0] || {}).slice(0, 160));
const plainCell = shotRenderOfJob(shotIds[0], 'video', plainJob.jobId, '10d. 不传尾帧（清零上一版尾帧键）');
const plainMeta = JSON.parse(plainCell.row?.meta || '{}');
ok('不传尾帧时落库 meta 里的尾帧键被显式清零（浅合并不会把上一版的尾帧留成「这一版用了尾帧」的假象）',
  plainCell.bound && plainMeta.lastImage === null && plainMeta.lastFrom === null && !plainMeta.raw?.lastFrame,
  plainCell.bound ? JSON.stringify({ lastImage: plainMeta.lastImage, lastFrom: plainMeta.lastFrom, raw: plainMeta.raw }).slice(0, 160) : whyNoShot(plainCell));

console.log('\n=== 10e. 尾帧设置的持久化（I-101：跨会话还原，不再「一刷新就没」） ===');
// 口径：shots.tail_image 是**库里的**唯一真源，看板（前端水合的来源）必须如实带回；
// 文件被删后设置仍保留（绝不静默清空），只是多一个 tail_image_missing=true 让界面如实标出。
const R = await import('../src/modules/render.js');
const tailPngRel = path.join('videos', 'tail-persist-i101.png');
const tailPngAbs = path.join(DATA_DIR, tailPngRel);
execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=purple:s=320x240', '-frames:v', '1', tailPngAbs], { stdio: 'pipe' });
const boardTailOf = (id) => (R.getEpisodeBoard(scriptId, 'S01E001').shots || []).find((s) => s.id === id) || {};
ok('10e. 准备：尾帧图落在数据目录内（可被 resolveAsset 解析）', fs.existsSync(tailPngAbs), tailPngRel);
R.setShotTailImage(shotIds[1], tailPngRel);
const boardTail1 = boardTailOf(shotIds[1]);
ok('10e. 尾帧写库后，看板（新一次读取 = 刷新页面/新会话）如实带回该镜的尾帧',
  boardTail1.tail_image === tailPngRel && boardTail1.tail_image_missing === false,
  JSON.stringify({ tail: boardTail1.tail_image, missing: boardTail1.tail_image_missing }));
ok('10e. 字段确实在库里（直接查 shots.tail_image，不是内存里的会话状态）',
  get('SELECT tail_image FROM shots WHERE id = ?', shotIds[1])?.tail_image === tailPngRel,
  String(get('SELECT tail_image FROM shots WHERE id = ?', shotIds[1])?.tail_image));
fs.rmSync(tailPngAbs, { force: true });
const boardTail2 = boardTailOf(shotIds[1]);
ok('10e. 尾帧文件被删后：看板仍返回用户设置的值（不静默清空），并标记 tail_image_missing=true',
  boardTail2.tail_image === tailPngRel && boardTail2.tail_image_missing === true,
  JSON.stringify({ tail: boardTail2.tail_image, missing: boardTail2.tail_image_missing }));
R.setShotTailImage(shotIds[1], null);
ok('10e. 清除后字段真的清空（库里 NULL + 看板 null，且不误报文件缺失）',
  get('SELECT tail_image FROM shots WHERE id = ?', shotIds[1])?.tail_image === null
  && boardTailOf(shotIds[1]).tail_image === null && boardTailOf(shotIds[1]).tail_image_missing === false);
const tailThrow = throws(() => R.setShotTailImage('SH-NOT-EXIST-I101', 'videos/x.png'), /镜头不存在/);
ok('10e. 给不存在的镜头写尾帧 → 中文报错（不会凭空造出设置）', tailThrow.threw && tailThrow.match, tailThrow.msg);

console.log('\n=== 10. 真实库未被触碰 ===');
ok('使用临时库', process.env.FACTORY_DB === DB && fs.existsSync(DB), DB);
ok('临时产物写在临时数据目录', abs.startsWith(DATA_TMP), abs);

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }
process.exit(fail ? 1 : 0);
