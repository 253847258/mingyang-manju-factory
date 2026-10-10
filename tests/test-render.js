// 模块4 API 端到端测试：分镜 → 关键帧 → 视频 → 整集成片（临时库 + 临时端口）
// 用法：node tests/test-render.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const DB = path.join(os.tmpdir(), `factory-render-test-${Date.now()}.db`);
const DATA_TMP = path.join(os.tmpdir(), `factory-render-data-${Date.now()}`);
const CFG = path.join(os.tmpdir(), `factory-render-config-${Date.now()}.json`);
process.env.FACTORY_DB = DB;
process.env.FACTORY_DATA_DIR = DATA_TMP;
process.env.PORT = '8894';

// ---- 环境隔离（防误花钱 · RK-SPEND-02）----
// 原实现只隔离了 DB 与 DATA_DIR，**没有 FACTORY_CONFIG**，于是本测试第 4/5/9b 节对
// POST /api/render/keyframes（第 91/102/105/160 行）、第 6 节 /api/render/videos 的任务
// 会按真实 config/config.json 的 image.backend 出图（现为 generic-http = 百炼 wan2.7-image，
// ¥0.2/张）→ 跑一次阶段 5 就真花钱。这里把三个付费后端钉死为
// placeholder / placeholder / none（本地占位 SVG + 本地 ffmpeg 运镜，零网络零费用），
// 断言期望一字未改（第 141 行 video 探测本就要求 placeholder、第 250/296 行 tts 本就要求 none）。
// 写法参照 tests/test-publish.js:15，且必须排在 import '../src/*' 之前。
fs.mkdirSync(DATA_TMP, { recursive: true });
fs.writeFileSync(CFG, JSON.stringify({
  image: { backend: 'placeholder', retries: 0, retryBaseMs: 0 },
  video: { backend: 'placeholder', retries: 0, retryBaseMs: 0 },
  tts: { backend: 'none' },
}, null, 2));
process.env.FACTORY_CONFIG = CFG;

const { migrate, run, get, all } = await import('../src/db.js');
const { createApp, createServer } = await import('../src/http.js');
const { registerActorRoutes } = await import('../src/routes/actors.js');
const { registerMetaRoutes } = await import('../src/routes/meta.js');
const { registerRenderRoutes } = await import('../src/routes/render.js');
const { DATA_DIR, ROOT } = await import('../src/db.js');
const { resolveAsset } = await import('../src/db.js');

migrate();

const { app, handle } = createApp();
registerMetaRoutes(app);
registerActorRoutes(app);
registerRenderRoutes(app);

// ---- 造数据：1 部剧本 + 1 集 + 4 个镜头（含提示词）----
const now = new Date().toISOString();
run(`INSERT INTO scripts(id, novel_id, title, format, style_id, episode_seconds, episodes_per_season, seasons, status, created_at, updated_at)
     VALUES('SC-TEST','N-TEST','测试剧本','manju','cn-guofeng',12,1,1,'draft',?,?)`, now, now);
run(`INSERT INTO script_episodes(id, script_id, season, episode, code, title, duration, status, created_at, updated_at)
     VALUES('EP-TEST','SC-TEST',1,1,'S01E001','测试集',12,'planned',?,?)`, now, now);
const shotSpecs = [
  { idx: 1, size: '远景', move: '推镜', dur: 3, cost: 'H' },
  { idx: 2, size: '中景', move: '固定', dur: 3, cost: 'M' },
  { idx: 3, size: '近景', move: '摇镜', dur: 3, cost: 'L' },
  { idx: 4, size: '特写', move: '拉镜', dur: 3, cost: 'L' },
];
shotSpecs.forEach((s, i) => {
  run(`INSERT INTO shots(id, script_id, episode_id, idx, scene_no, shot_size, camera, move, transition, duration, action, dialogue, mood, prompt_pos, prompt_neg, refs, cost_level, status, created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?)`,
    `SH-TEST-${i + 1}`, 'SC-TEST', 'EP-TEST', s.idx, '1', s.size, '平视', s.move, '切', s.dur,
    `测试动作${s.idx}`, `台词${s.idx}`, '紧张',
    `cinematic photorealistic, test scene ${s.idx}, ${s.size} shot, ${s.move}`, 'blurry, low quality',
    JSON.stringify({ characters: ['C-TEST'], location: 'L-TEST' }), s.cost, now);
});

const server = createServer((req, res) => handle(req, res, { staticMounts: [{ prefix: '/data', dir: DATA_DIR, cache: 'no-cache' }] }));
const PORT = 8894;
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const B = `http://127.0.0.1:${PORT}`;
const get_ = async (p) => (await fetch(B + p)).json();
const post = async (p, body) => (await fetch(B + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })).json();
const put = async (p, body) => (await fetch(B + p, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })).json();
const del = async (p) => (await fetch(B + p, { method: 'DELETE' })).json();
const waitJob = async (id, tries = 200) => {
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const j = (await get_(`/api/jobs/${id}`)).job;
    if (j && ['done', 'error', 'canceled'].includes(j.status)) return j;
  }
  return null;
};

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.error(`  ✗ ${name}  ${extra}`); } };
const fileAbs = (rel) => path.resolve(ROOT, rel);
const ffprobe = (abs) => spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-show_entries', 'stream=index,codec_type,codec_name,width,height,channels,sample_rate', '-of', 'json', abs], { encoding: 'utf8' });

// ---- 取值口径（FLAKE-FIX）：只认「本次任务刚落的那一行」，不按 shot_id 猜最新 ----
// 旧写法 `WHERE shot_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1` 取的是「该镜最新一行」，
// 但同一镜会被**别的**任务在更晚的墙钟时刻落库（整季流水线/画布 DAG 的收尾步骤都会给同一镜写 video 行），
// 于是取到的是别人的行 —— 本文件曾 3 次里 1 次失败：读到的 meta 是流水线产物
// {"elapsedMs":13010,"raw":{"motion":"push in"},"keyframe":"...svg"}，断言随之假失败。
// 口径改为：shot_id + kind + **job_id（本次调用的任务 id）** 三者同为命中条件；
// 取不到就明确 FAIL（绝静默退回「最新一行」），并把该镜的全部候选行打出来便于诊断。
const shotRenderRows = (shotId, kind, extraSql = '') =>
  all(`SELECT rowid AS _rid, * FROM shot_renders
       WHERE shot_id = ? AND kind = ? ${extraSql} ORDER BY created_at DESC, rowid DESC`, shotId, kind);
const renderOfCall = (shotId, kind, jobId, label, extraSql = '') => {
  const cands = shotRenderRows(shotId, kind, extraSql);
  const row = jobId ? (cands.find((r) => r.job_id === jobId) || null) : null;
  if (!row) {
    console.error(`  ✗ [前置断言] ${label}：取到的行必须属于本次调用 —— 但本次任务 job=${jobId} 在 ${shotId}/${kind}${extraSql} 没有落库行`);
    console.error(`      候选 ${cands.length} 条：${cands.map((r) => `rowid=${r._rid} job=${r.job_id} status=${r.status} created=${r.created_at}`).join(' | ') || '(无)'}`);
    console.error(`      含义：本次调用没落库（真回归），或落库行的 job_id 对不上（取值跑到了别的任务/更早的行上）`);
  }
  let meta = {}; try { meta = JSON.parse(row?.meta || '{}'); } catch { meta = {}; }
  return { row, meta, bound: Boolean(row), candidates: cands, jobId };
};
/** 断言失败时的可诊断证据：绑定成功给 meta，失败给「本次任务取不到行 + 全部候选行」 */
const whyNot = (x) => x.bound
  ? JSON.stringify(x.meta).slice(0, 200)
  : `本次调用（job=${x.jobId}）取不到落库行；候选 ${x.candidates.length} 条：${x.candidates.map((r) => `rowid=${r._rid} job=${r.job_id}`).join(' | ') || '(无)'}`;

console.log('\n=== 模块4 制作台 API 测试 ===');

// 1. 概览
const ov = await get_('/api/render/overview');
ok('概览返回剧本与后端状态', ov.ok && Array.isArray(ov.scripts) && ov.backend.video && ov.counts);
const sc = ov.scripts.find((s) => s.id === 'SC-TEST');
ok('剧本含剧集与统计（镜头数=4）', sc && sc.episodes.length === 1 && sc.stats.shots === 4, JSON.stringify(sc?.stats));

// 2. 单集看板
const board = await get_('/api/render/episode?scriptId=SC-TEST&code=S01E001');
ok('单集看板返回 4 个镜头与目标时长 12s', board.ok && board.shots.length === 4 && board.stats.targetDuration === 12);
ok('镜头带提示词与成本级分布', board.shots.every((s) => s.prompt_pos && s.cost_level) && board.stats.costLevels.H === 1);

// 3. 参数校验
const bad = await post('/api/render/keyframes', { scriptId: 'SC-TEST' });
ok('缺少 code 时中文报错', bad.ok === false && /缺少/.test(bad.error));
const badEp = await get_('/api/render/episode?scriptId=SC-TEST&code=S99E999');
ok('不存在的剧集返回 404 中文错误', badEp.ok === false);

// 4. 关键帧渲染（占位后端）
const kf = await post('/api/render/keyframes', { scriptId: 'SC-TEST', code: 'S01E001' });
ok('提交关键帧任务（4 镜）', kf.ok && kf.total === 4);
const kfJob = await waitJob(kf.jobId);
ok('关键帧任务完成且无失败', kfJob.status === 'done' && kfJob.result.failed === 0, JSON.stringify(kfJob.error || kfJob.result));
const rows = all("SELECT * FROM shot_renders WHERE kind='keyframe'");
ok('关键帧记录落库（含尺寸与提示词）', rows.length === 4 && rows.every((r) => r.file_path && r.width && r.prompt_pos));
ok('关键帧文件真实存在于磁盘', rows.every((r) => fs.existsSync(fileAbs(r.file_path))));
// 4a. 出图结果的模板标记必须落进 meta（否则「参考图到底发出去了没有」在库里查不到 · 见 strategist/runs/USEDTPL-FIX.json）
const kfMetas = rows.map((r) => { try { return JSON.parse(r.meta || '{}'); } catch { return {}; } });
ok('关键帧 meta 含模板标记（placeholder 后端 → usedTemplate=t2i，另带 templateSource/refImageSent/refImagePresent）且既有键仍在',
   kfMetas.every((m) => m.usedTemplate === 't2i' && m.refImageSent === false && m.refImagePresent === false
     && 'templateSource' in m && 'placeholder' in m && 'elapsedMs' in m && 'canvasRef' in m && 'canvasScene' in m),
   JSON.stringify(kfMetas[0]));
const board2 = await get_('/api/render/episode?scriptId=SC-TEST&code=S01E001');
ok('看板反映关键帧进度 4/4', board2.stats.keyframes === 4 && board2.shots.every((s) => s.keyframe));

// 5. 增量与覆盖
const kf2 = await post('/api/render/keyframes', { scriptId: 'SC-TEST', code: 'S01E001' });
const kfJob2 = await waitJob(kf2.jobId);
ok('非覆盖模式自动跳过已有关键帧', kfJob2.result.skipped === 4, JSON.stringify(kfJob2.result));
const kf3 = await post('/api/render/keyframes', { scriptId: 'SC-TEST', code: 'S01E001', shotIds: ['SH-TEST-1'], overwrite: true });
const kfJob3 = await waitJob(kf3.jobId);
ok('指定镜头 + 覆盖模式可重做', kfJob3.status === 'done' && all("SELECT * FROM shot_renders WHERE kind='keyframe' AND shot_id='SH-TEST-1'").length === 2);

// 5b. meta 浅合并：更早写入方留下的既有键（motion/backend/model/seed）不被出图步骤抹掉，模板标记以本次为准
run(`INSERT INTO shot_renders(id, script_id, episode_id, shot_id, kind, file_path, status, meta, created_at)
     VALUES('RD-TEST-METAPREV','SC-TEST','EP-TEST','SH-TEST-2','keyframe','data/images/meta-prev.png','done',?,?)`,
  JSON.stringify({ motion: '推镜 中景', backend: 'earlier-writer', model: 'earlier-model', seed: 777, usedTemplate: 'stale' }), new Date().toISOString());
const kfMerge = await post('/api/render/keyframes', { scriptId: 'SC-TEST', code: 'S01E001', shotIds: ['SH-TEST-2'], overwrite: true });
const kfMergeJob = await waitJob(kfMerge.jobId);
// 本次覆盖渲染刚落的那一行（按 job_id 绑定；不按 shot_id 猜最新）
const mergedCell = renderOfCall('SH-TEST-2', 'keyframe', kfMerge.jobId, '5b. meta 浅合并');
const mergedMeta = mergedCell.meta;
ok('meta 浅合并：既有键保留 + 本次模板标记覆盖旧值',
   mergedCell.bound && kfMergeJob.status === 'done' && mergedMeta.motion === '推镜 中景' && mergedMeta.backend === 'earlier-writer'
     && mergedMeta.model === 'earlier-model' && mergedMeta.seed === 777
     && mergedMeta.usedTemplate === 't2i' && mergedMeta.placeholder === true && mergedMeta.metaMergedFrom === 'RD-TEST-METAPREV',
   whyNot(mergedCell));

// 6. 视频渲染（本地 ffmpeg 运镜）
const vd = await post('/api/render/videos', { scriptId: 'SC-TEST', code: 'S01E001', onlyCostLevels: ['L'] });
ok('按成本级筛选提交视频任务（2 镜 L）', vd.ok && vd.total === 2, JSON.stringify(vd));
const vJob = await waitJob(vd.jobId, 400);
ok('视频任务完成且无失败', vJob && vJob.status === 'done' && vJob.result.failed === 0, JSON.stringify(vJob?.error || vJob?.result));
const vids = all("SELECT * FROM shot_renders WHERE kind='video' AND status='done'");
ok('视频记录落库（mp4 + 时长）', vids.length === 2 && vids.every((v) => v.file_path.endsWith('.mp4') && v.duration > 0));
if (vids.length) {
  const abs = fileAbs(vids[0].file_path);
  ok('视频文件存在且是合法 mp4', fs.existsSync(abs) && fs.statSync(abs).size > 1000);
  const probe = JSON.parse(ffprobe(abs).stdout || '{}');
  ok('ffprobe 校验：h264 + 9:16 竖屏尺寸（720x1280）', probe.streams?.[0]?.codec_name === 'h264' && probe.streams[0].width === 720 && probe.streams[0].height === 1280, JSON.stringify(probe.streams?.[0]));
  ok('视频时长与镜头时长一致（3s ±0.3）', Math.abs(Number(probe.format?.duration) - 3) < 0.3, String(probe.format?.duration));
}

// 7. 整集合成
const asm = await post('/api/render/assemble', { scriptId: 'SC-TEST', code: 'S01E001' });
ok('提交整集合成任务', asm.ok && asm.shots === 2);
const aJob = await waitJob(asm.jobId, 400);
ok('合成任务完成', aJob && aJob.status === 'done', JSON.stringify(aJob?.error || aJob?.result));
const films = await get_('/api/render/films?scriptId=SC-TEST');
ok('成片记录落库（含镜头数与时长）', films.films.length === 1 && films.films[0].shot_count === 2);
if (films.films.length) {
  const abs = fileAbs(films.films[0].file_path);
  const probe = JSON.parse(ffprobe(abs).stdout || '{}');
  ok('成片是合法 mp4 且时长≈6s', fs.existsSync(abs) && Math.abs(Number(probe.format?.duration) - 6) < 0.6, String(probe.format?.duration));
}
const board3 = await get_('/api/render/episode?scriptId=SC-TEST&code=S01E001');
ok('看板显示成片与进度', board3.films.length === 1 && board3.stats.videos === 2);

// 8. 视频后端探测与试渲染
const probe = await post('/api/video-backend/probe', {});
ok('视频后端探测返回中文结论', probe.backend === 'placeholder' && typeof probe.detail === 'string' && probe.ok === true && probe.ready === true, probe.detail);
const anyKf = all("SELECT * FROM shot_renders WHERE kind='keyframe' AND status='done' LIMIT 1")[0];
const testVid = await post('/api/render/test-video', { duration: 1, move: '推镜', keyframe: anyKf?.file_path });
ok('试渲染接口可用（给定关键帧 → 1s mp4）', testVid.ok && testVid.filePath && fs.existsSync(fileAbs(testVid.filePath)), testVid.error || '');
const testVidNoKf = await post('/api/render/test-video', { duration: 1, move: '推镜' });
ok('本地运镜缺关键帧时给出中文提示', testVidNoKf.ok === false && /关键帧/.test(testVidNoKf.error));
const probeComfy = await post('/api/video-backend/probe', { backend: 'comfyui-h3' });
ok('未配置 ComfyUI 时给出中文未就绪原因', probeComfy.ready === false && /未配置/.test(probeComfy.detail));
ok('探测失败也走 HTTP 200（前端能读到完整中文 detail，不被 api 层拦成「请求失败」）', probeComfy.ok === true && probeComfy.ready === false, `ok=${probeComfy.ok} ready=${probeComfy.ready}`);

// 9. 删除渲染
const oneKf = all("SELECT * FROM shot_renders WHERE kind='keyframe' LIMIT 1")[0];
const delRes = await del('/api/render/renders/' + oneKf.id);
ok('删除渲染记录并同步删除文件', delRes.ok && !fs.existsSync(fileAbs(oneKf.file_path)) && !get('SELECT id FROM shot_renders WHERE id = ?', oneKf.id));

// 9b. 镜头版本管理：多版本对比 + 人工采用（整集拼接用采用版本）
const vShot = all("SELECT * FROM shots WHERE episode_id='EP-TEST' ORDER BY idx LIMIT 1")[0];
const kf1 = all("SELECT * FROM shot_renders WHERE shot_id=? AND kind='keyframe' AND status='done' ORDER BY created_at LIMIT 1", vShot.id)[0];
ok('准备：该镜已有 1 个关键帧版本', Boolean(kf1), kf1 ? kf1.id : '(无)');
const kfAgain = await post('/api/render/keyframes', { scriptId: 'SC-TEST', code: 'S01E001', shotIds: [vShot.id], overwrite: true });
const kfAgainJob = await waitJob(kfAgain.jobId);
ok('再生成一版关键帧成功', kfAgainJob.status === 'done' && kfAgainJob.result.failed === 0, JSON.stringify(kfAgainJob.result));
const vlist = await get_(`/api/render/shots/${vShot.id}/versions?kind=keyframe`);
ok('版本列表返回全部版本（新→旧，带版本号与 latest 标记）',
   vlist.ok && vlist.versions.length === 2 && vlist.versions[0].isLatest === true && vlist.versions[0].version === 2 && vlist.versions[1].version === 1,
   vlist.versions.map((v) => `v${v.version}${v.isLatest ? '*' : ''}`).join(' '));
ok('未采用时看板默认用最近一次成功版本',
   (await get_('/api/render/episode?scriptId=SC-TEST&code=S01E001')).shots.find((x) => x.id === vShot.id).keyframe.id === vlist.versions[0].id);

const picked = await post(`/api/render/renders/${vlist.versions[1].id}/pick`, {});
ok('采用旧版本成功（返回互斥后的版本列表）', picked.ok === true && picked.pickedId === vlist.versions[1].id, JSON.stringify(picked).slice(0, 120));
const vlist2 = await get_(`/api/render/shots/${vShot.id}/versions?kind=keyframe`);
ok('同一镜同类型互斥：只有一条 picked',
   vlist2.versions.filter((v) => v.picked).length === 1 && vlist2.versions.find((v) => v.id === vlist.versions[1].id).picked === true,
   vlist2.versions.map((v) => `${v.id.slice(-6)}:${v.picked ? '★' : '-'}`).join(' '));
const boardPicked = (await get_('/api/render/episode?scriptId=SC-TEST&code=S01E001')).shots.find((x) => x.id === vShot.id);
ok('看板关键帧槽位切到采用版本', boardPicked.keyframe.id === vlist.versions[1].id && boardPicked.keyframe.picked === true);
ok('关键帧采用不影响视频记录', (boardPicked.videos || []).every((v) => v.picked === false));

// 成片必须用「采用版本」：给同一镜造两个时长不同的视频版本，比较两次合成的成片时长
const vidShot = all("SELECT s.* FROM shots s JOIN shot_renders r ON r.shot_id = s.id AND r.kind='video' AND r.status='done' WHERE s.episode_id='EP-TEST' ORDER BY s.idx LIMIT 1")[0];
const baseVid = all("SELECT * FROM shot_renders WHERE shot_id=? AND kind='video' AND status='done' ORDER BY created_at LIMIT 1", vidShot.id)[0];
ok('准备：该镜已有视频版本', Boolean(baseVid), baseVid ? path.basename(baseVid.file_path) : '(无)');
const mkClip = (name, secs) => {
  const abs = path.join(DATA_TMP, name);
  spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=black:s=720x1280:d=${secs}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', abs]);
  return path.relative(ROOT, abs).split(path.sep).join('/');
};
const shortRel = mkClip('ver-short.mp4', 2);
const longRel = mkClip('ver-long.mp4', 6);
const mkVersion = (id, rel, secs, at) => run(
  `INSERT INTO shot_renders(id, script_id, episode_id, shot_id, kind, file_path, mime, width, height, duration, backend, model, status, created_at)
   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  id, 'SC-TEST', 'EP-TEST', vidShot.id, 'video', rel, 'video/mp4', 720, 1280, secs, 'ffmpeg-test', 'placeholder', 'done', at);
// 用「较远的未来时间戳」确保这两个测试版本排在最前且相邻：间隔 1 秒会被真实渲染插入（曾偶发失败）
mkVersion('RD-TEST-SHORT', shortRel, 2, new Date(Date.now() + 30 * 60 * 1000).toISOString());
mkVersion('RD-TEST-LONG', longRel, 6, new Date(Date.now() + 60 * 60 * 1000).toISOString());
const vlist3 = await get_(`/api/render/shots/${vidShot.id}/versions?kind=video`);
const ids3 = vlist3.versions.map((v) => v.id);
ok('视频版本按新→旧返回，且两个测试版本相邻（LONG 比 SHORT 新）',
   vlist3.versions.length >= 3 && ids3.indexOf('RD-TEST-LONG') === ids3.indexOf('RD-TEST-SHORT') - 1,
   vlist3.versions.map((v) => `${v.id}(v${v.version})`).join(' '));
// 不写死自己的那一版：未采用时「最新一条成功」生效即可（避免依赖前面用例的耗时/并发）
ok('未采用时看板用最新版本', (await get_('/api/render/episode?scriptId=SC-TEST&code=S01E001')).shots.find((x) => x.id === vidShot.id).video.id === vlist3.versions[0].id,
   `board=${(await get_('/api/render/episode?scriptId=SC-TEST&code=S01E001')).shots.find((x) => x.id === vidShot.id).video.id} latest=${vlist3.versions[0].id}`);

const filmDur = async () => {
  const asm = await post('/api/render/assemble', { scriptId: 'SC-TEST', code: 'S01E001' });
  const job = await waitJob(asm.jobId, 600);
  if (!job || job.status !== 'done') throw new Error(`合成失败：${JSON.stringify(job?.error || job?.result)}`);
  // 用任务返回的 filmId 精确定位本次产物（不依赖列表排序/时间戳，避免同秒创建时取错记录）
  const filmId = job.result?.filmId;
  const f = (await get_('/api/render/films?scriptId=SC-TEST')).films.find((x) => x.id === filmId);
  if (!f) throw new Error(`找不到刚生成的成片记录 ${filmId}`);
  const probe = JSON.parse(ffprobe(fileAbs(f.file_path)).stdout || '{}');
  return { id: f.id, seconds: Number(probe.format?.duration) || 0, file: f.file_path };
};
await post('/api/render/renders/RD-TEST-SHORT/pick', {});
const filmShort = await filmDur();
await post('/api/render/renders/RD-TEST-LONG/pick', {});
const filmLong = await filmDur();
ok('两次合成产出的是两条不同成片记录', filmShort.id !== filmLong.id, `${filmShort.id} / ${filmLong.id}`);
ok('采用 2 秒版本与 6 秒版本合出的成片时长相差约 4 秒（证明拼接用的是采用版本）',
   Math.abs((filmLong.seconds - filmShort.seconds) - 4) < 0.6,
   `采用 2s → 成片 ${filmShort.seconds.toFixed(1)}s（${filmShort.id}）；采用 6s → 成片 ${filmLong.seconds.toFixed(1)}s（${filmLong.id}）`);

const pickErr = await post('/api/render/renders/RD-NOT-EXIST/pick', {});
ok('采用不存在的渲染记录给中文错误', pickErr.ok === false && /不存在/.test(pickErr.error), pickErr.error);
const failRow = all("SELECT * FROM shot_renders WHERE status='error' LIMIT 1")[0];
if (failRow) {
  const pickFail = await post(`/api/render/renders/${failRow.id}/pick`, {});
  ok('失败版本不允许被采用（中文错误）', pickFail.ok === false && /只有生成成功/.test(pickFail.error), pickFail.error);
} else {
  ok('失败版本不允许被采用（本轮无失败记录，跳过）', true, '无失败记录');
}

// 10. 成片包装：字幕 + 音轨 + 淡入淡出
const { buildSRT, detectCjkFont, applySubtitles, applyAudio, finishEpisode } = await import('../src/finish.js');
const srtBuild = buildSRT([
  { idx: 1, duration: 2, dialogue: '第一句台词', action: '动作一', speaker: '甲' },
  { idx: 2, duration: 2, dialogue: '', action: '无台词镜', speaker: '' },
  { idx: 3, duration: 2, dialogue: '第二句台词', speaker: '乙' },
]);
ok('SRT 生成：跳过无台词镜、条数与时间轴正确', srtBuild.cues === 2 && srtBuild.duration === 6 && /00:00:04,000 --> /.test(srtBuild.srt), srtBuild.srt.slice(0, 80));
ok('SRT 带说话人前缀', srtBuild.srt.includes('甲：第一句台词'));
ok('中文字体可探测（libass 需要）', typeof detectCjkFont() === 'string');

const boardF = await get_('/api/render/episode?scriptId=SC-TEST&code=S01E001');
const finishStatus = await get_('/api/render/finish-status');
ok('成片包装默认值 + TTS 状态可读', finishStatus.ok && finishStatus.finish.subtitleMode && finishStatus.tts.backend === 'none');
const srtPreview = await post('/api/render/preview-srt', { scriptId: 'SC-TEST', code: 'S01E001' });
ok('字幕预览接口返回 SRT 与条数', srtPreview.ok && srtPreview.cues >= 1 && /-->/.test(srtPreview.srt), JSON.stringify(srtPreview).slice(0, 120));

const vidRow = all("SELECT * FROM shot_renders WHERE kind='video' AND status='done' LIMIT 1")[0];
const vidAbs = fileAbs(vidRow.file_path);
const workDir = path.join(DATA_TMP, 'finishtest');
fs.mkdirSync(workDir, { recursive: true });
const srtAbs = path.join(workDir, 'test.srt');
fs.writeFileSync(srtAbs, srtBuild.srt, 'utf8');
const hardOut = path.join(workDir, 'hard.mp4');
const subRes = await applySubtitles(vidAbs, hardOut, srtAbs, { mode: 'hard', font: detectCjkFont(), size: 22, marginV: 40 });
ok('硬字幕烧录成功', subRes.applied && fs.existsSync(hardOut) && fs.statSync(hardOut).size > 1000);
const softOut = path.join(workDir, 'soft.mp4');
const softRes = await applySubtitles(vidAbs, softOut, srtAbs, { mode: 'soft' });
const softProbe = JSON.parse(ffprobe(softOut).stdout || '{}');
ok('软字幕轨写入（mov_text 流）', softRes.applied && (softProbe.streams || []).some((st) => st.codec_type === 'subtitle'), JSON.stringify(softProbe.streams));

const audioOut = path.join(workDir, 'audio.mp4');
const audioRes = await applyAudio(vidAbs, audioOut, { mode: 'silent', duration: 3 });
const audioProbe = JSON.parse(ffprobe(audioOut).stdout || '{}');
ok('静音音轨写入（aac 48kHz）', audioRes.applied && (audioProbe.streams || []).some((st) => st.codec_type === 'audio' && st.codec_name === 'aac'), JSON.stringify(audioProbe.streams));

// finishEpisode 全链路（拼接→字幕→音轨→淡入淡出）
const clips = all("SELECT * FROM shot_renders WHERE kind='video' AND status='done'").map((v) => ({ file: v.file_path, duration: v.duration, dialogue: '测试台词', speaker: '甲', idx: 1 }));
const fin = await finishEpisode({
  scriptId: 'SC-TEST', code: 'S01E001', clips,
  options: { subtitles: true, subtitleMode: 'hard', audio: 'silent', fadeIn: 0.3, fadeOut: 0.3 },
});
ok('finishEpisode 产出最终 mp4（含字幕与音轨信息）', fin.filePath && fin.subtitles.applied && fin.audio.applied && fin.fades.applied, JSON.stringify(fin.subtitles) + JSON.stringify(fin.audio));
const finProbe = JSON.parse(ffprobe(fin.absPath).stdout || '{}');
ok('最终 mp4：视频 + 音频双流、时长≈合集时长', (finProbe.streams || []).length === 2 && Math.abs(Number(finProbe.format?.duration) - fin.duration) < 0.8, JSON.stringify(finProbe.format));

// 11. 整季流水线
const est = await get_('/api/render/estimate?scriptId=SC-TEST');
ok('工作量估算返回剧集与预估耗时', est.ok && est.totals.episodes === 1 && est.estimate.seconds >= 0 && est.episodes[0].shots === 4);
const pipe = await post('/api/render/pipeline', { scriptId: 'SC-TEST', codes: ['S01E001'], stages: ['keyframe', 'video', 'assemble'], finish: { subtitles: true, subtitleMode: 'soft', audio: 'silent' }, provider: 'mock' });
ok('流水线任务提交成功', pipe.ok && pipe.jobId);
const pJob = await waitJob(pipe.jobId, 800);
ok('流水线执行完成且无失败集', pJob && pJob.status === 'done' && pJob.result.summary.failed === 0, JSON.stringify(pJob?.error || pJob?.result?.summary || {}));
ok('流水线报告含逐集阶段明细', pJob?.result?.episodes?.[0]?.stages?.film?.filmId && pJob.result.summary.films >= 1, JSON.stringify(pJob?.result?.summary));
const filmsAfter = await get_('/api/render/films?scriptId=SC-TEST');
ok('流水线产出成片入库（≥2 部）', filmsAfter.films.length >= 2);

// 12. TTS 后端
const ttsStatus = await get_('/api/tts-backend');
ok('TTS 状态可读（默认未启用=静音轨）', ttsStatus.ok && ttsStatus.backend === 'none' && ttsStatus.ready === true);
const ttsProbe = await post('/api/tts-backend/probe', {});
ok('TTS 探测返回中文说明', ttsProbe.ok === true && /静音/.test(ttsProbe.detail));
const ttsTest = await post('/api/tts-backend/test', {});
ok('未启用 TTS 时试听给出中文错误', ttsTest.ok === false && /未启用/.test(ttsTest.error));

// 13. 任务自愈 / 成片删除 / 中间产物清理
const { recoverStaleJobs, createJob, updateJob } = await import('../src/jobs.js');
const zombie = createJob({ type: 'video', title: '模拟被杀的任务', payload: {}, total: 3 });
updateJob(zombie, { status: 'running', progress: 40 });
const rec = recoverStaleJobs();
const zombieAfter = (await get_(`/api/jobs/${zombie}`)).job;
ok('启动自愈：僵尸 running 任务被标记为中断', rec.recovered >= 1 && zombieAfter.status === 'error' && /中断/.test(zombieAfter.error || ''), JSON.stringify({ rec, st: zombieAfter.status }));

const { cleanupIntermediates } = await import('../src/modules/render.js');
const finDir = path.join(DATA_TMP, 'finish');
const probeDir = path.join(finDir, 'SC-TEST_S01E001');
fs.mkdirSync(probeDir, { recursive: true });
fs.writeFileSync(path.join(probeDir, 'concat_deadbeef.txt'), 'x');
fs.writeFileSync(path.join(probeDir, 'merged_deadbeef.mp4'), 'y');
fs.writeFileSync(path.join(probeDir, 'final_deadbeef.mp4'), 'z');
fs.writeFileSync(path.join(probeDir, 'S01E001_final.mp4'), 'keep');
const cleaned = cleanupIntermediates();
ok('清理中间产物：临时文件被删、最终成片保留', cleaned.removed >= 3 && !fs.existsSync(path.join(probeDir, 'merged_deadbeef.mp4')) && fs.existsSync(path.join(probeDir, 'S01E001_final.mp4')), JSON.stringify(cleaned));

const fin2 = await finishEpisode({ scriptId: 'SC-TEST', code: 'S01E001', clips, options: { subtitles: false, audio: 'silent' } });
ok('同一集多次封装不会互相覆盖（文件名唯一）', fin2.filePath !== fin.filePath && fs.existsSync(fin2.absPath) && fs.existsSync(fin.absPath), `${fin.filePath} vs ${fin2.filePath}`);

const filmToDelete = (await get_('/api/render/films?scriptId=SC-TEST')).films[0];
const filmAbs = fileAbs(filmToDelete.file_path);
const delFilm = await del('/api/render/films/' + filmToDelete.id);
const filmsLeft = (await get_('/api/render/films?scriptId=SC-TEST')).films;
ok('删除成片：记录与文件同时删除', delFilm.ok && !fs.existsSync(filmAbs) && !filmsLeft.some((f) => f.id === filmToDelete.id));
const delFilmBad = await del('/api/render/films/NOT-EXIST');
ok('删除不存在的成片返回 404 中文错误', delFilmBad.ok === false && /不存在/.test(delFilmBad.error));
const cleanupApi = await post('/api/render/cleanup', {});
ok('清理中间产物接口可用', cleanupApi.ok === true && typeof cleanupApi.removed === 'number');

// 14. 错误路径
const delBad = await del('/api/render/renders/NOT-EXIST');
ok('删除不存在的渲染返回 404', delBad.ok === false);
const asm2 = await post('/api/render/assemble', { scriptId: 'SC-TEST', code: 'S01E001' });
ok('仍有可用镜头时合成仍可重复执行', asm2.ok === true);

// ================== 15. 批量链路尾帧（首尾帧过渡）==================
// 零付费：不调任何真实视频厂商，用**假视频服务端**（本地 http）收请求，只看「批量链路到底把哪些字段发出去了」。
// 覆盖面：① 不传尾帧 → 出站请求与既有行为逐字段一致（防回归）② 传 lastImageByShot → 假服务端确实收到尾帧字段
//        ③ 尾帧文件不存在/越界/非图片 → 中文 400 且不发任何请求 ④ 单镜试渲染 /api/render/test-video 支持尾帧
console.log('\n=== 15. 批量链路尾帧（lastImage / lastImageByShot） ===');
const httpMod = await import('node:http');
const { saveConfig } = await import('../src/config.js');

// 尾帧图（纯蓝 png，落在临时 data 目录 → 相对路径 videos/last-blue.png 可被 resolveAsset 解析）
fs.mkdirSync(path.join(DATA_TMP, 'videos'), { recursive: true });
const lastPngRel = 'videos/last-blue.png';
const lastPngAbs = path.join(DATA_TMP, lastPngRel);
spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=720x1280', '-frames:v', '1', lastPngAbs]);
const lastPngB64 = fs.readFileSync(lastPngAbs).toString('base64');
ok('准备：尾帧图已生成（data 目录下的相对路径，可被 resolveAsset 解析）',
  fs.existsSync(lastPngAbs) && lastPngB64.length > 100 && path.resolve(ROOT, lastPngRel) !== lastPngAbs, `${lastPngRel}（${lastPngB64.length} 字符 base64）`);

// 假视频服务端：记录每个请求体（零付费、不出网），并按「通用视频模板」协议回一个本地 mp4
const fakeCalls = [];
const fakeMp4 = path.join(DATA_TMP, 'fake-out.mp4');
spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', fakeMp4]);
let fakePort = 0;
const fakeVideo = httpMod.createServer(async (req, res) => {
  if (req.method === 'POST') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    let fb = null; try { fb = JSON.parse(raw || '{}'); } catch { fb = null; }
    fakeCalls.push({ url: req.url, body: fb, raw });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: { video_url: `http://127.0.0.1:${fakePort}/out.mp4` } }));
    return;
  }
  res.writeHead(200, { 'content-type': 'video/mp4' });
  res.end(fs.readFileSync(fakeMp4));
});
await new Promise((r) => fakeVideo.listen(0, '127.0.0.1', r));
fakePort = fakeVideo.address().port;
saveConfig({ video: { backend: 'generic-http', generic: {
  url: `http://127.0.0.1:${fakePort}/video`, method: 'POST',
  bodyTemplate: '{"prompt":"{{prompt}}","image":"{{refImage}}","last_image":"{{lastImage}}","duration":{{duration}},"shot":"{{shotId}}"}',
  responseVideoPath: 'data.video_url', apiKey: '',
} } });
ok('准备：假视频服务端已就绪（本地端口，零付费）', fakePort > 0 && typeof saveConfig === 'function', `http://127.0.0.1:${fakePort}/video`);

const jobResultOf = async (r, tries = 400) => {
  const j = await waitJob(r.jobId, tries);
  if (!j || j.status !== 'done') throw new Error(`任务未完成：${JSON.stringify(j?.error || j?.result || j)}`);
  return j.result || {};
};
/** 本次批量渲染给某镜落的那一行（按 job_id 精确绑定；不按 shot_id 猜最新一行） */
const videoMetaOf = (shotId, jobId, label) => renderOfCall(shotId, 'video', jobId, label);

// ① 不传尾帧：出站请求 + 响应 + 落库 meta 都与既有行为逐字段一致（防回归）
const baseCallsBefore = fakeCalls.length;
const vdBase = await post('/api/render/videos', { scriptId: 'SC-TEST', code: 'S01E001', shotIds: ['SH-TEST-1'], overwrite: true, backend: 'generic-http' });
ok('① 不传尾帧：提交响应与历史逐字段一致（只有 ok/jobId/total，没有 withLastImage 之类的多余键）',
  vdBase.ok === true && Object.keys(vdBase).sort().join(',') === 'jobId,ok,total', JSON.stringify(vdBase));
const baseResult = await jobResultOf(vdBase);
const baseCall = fakeCalls[baseCallsBefore];
ok('① 不传尾帧：假服务端收到 1 个请求，且请求体里**没有**尾帧字段（通用模板的空值字段会被删键）',
  fakeCalls.length === baseCallsBefore + 1 && baseCall?.body && !('last_image' in baseCall.body), JSON.stringify(baseCall?.body || {}).slice(0, 200));
ok('① 不传尾帧：首帧（关键帧）照常发出（image = 该镜关键帧的 base64）',
  typeof baseCall?.body?.image === 'string' && baseCall.body.image.length > 100, `image 长度 ${baseCall?.body?.image?.length || 0}`);
ok('① 不传尾帧：任务结果字段与历史一致（无 withLastImage，results 每条只有 shotId/ok/file）',
  !('withLastImage' in baseResult) && baseResult.failed === 0
  && Object.keys(baseResult.results[0]).sort().join(',') === 'file,ok,shotId', JSON.stringify(baseResult.results[0]).slice(0, 160));
const baseMeta = videoMetaOf('SH-TEST-1', vdBase.jobId, '① 不传尾帧');
ok('① 不传尾帧：落库 meta 里没有 lastImage/lastFrom 之类的键（未传 = 行为完全不变）',
  baseMeta.bound && !('lastImage' in baseMeta.meta) && !('lastFrom' in baseMeta.meta), whyNot(baseMeta));

// ② 传 lastImageByShot：假服务端收到的请求里确实带尾帧字段，且除尾帧外与①逐字段一致
const tailCallsBefore = fakeCalls.length;
const vdTail = await post('/api/render/videos', {
  scriptId: 'SC-TEST', code: 'S01E001', shotIds: ['SH-TEST-1', 'SH-TEST-2'], overwrite: true, backend: 'generic-http',
  lastImageByShot: { 'SH-TEST-1': lastPngRel },
});
ok('② 提交响应体现「本批有多少镜带了尾帧」（withLastImage=1 + 中文说明）',
  vdTail.ok === true && vdTail.withLastImage === 1 && typeof vdTail.lastImageNote === 'string' && /带尾帧/.test(vdTail.lastImageNote),
  JSON.stringify({ withLastImage: vdTail.withLastImage, note: vdTail.lastImageNote }));
const tailResult = await jobResultOf(vdTail);
const tailCalls = fakeCalls.slice(tailCallsBefore);
const callOf = (shotId) => tailCalls.find((c) => c.body?.shot === shotId);
const call1 = callOf('SH-TEST-1');
const call2 = callOf('SH-TEST-2');
ok('② 假服务端收到 2 个请求（每镜一个，未受尾帧影响）', tailCalls.length === 2 && Boolean(call1) && Boolean(call2), tailCalls.map((c) => c.body?.shot || '?').join(','));
ok('② 设了尾帧的那一镜：请求体里确实带尾帧字段 last_image = 尾帧图的 base64（★核心证据）',
  call1?.body?.last_image === lastPngB64 && lastPngB64.length > 100,
  `last_image 长度 ${call1?.body?.last_image?.length || 0}（期望 ${lastPngB64.length}）`);
ok('② 未设尾帧的那一镜：请求体里没有尾帧字段（不会被误加，仍是纯首帧驱动）',
  call2?.body && !('last_image' in call2.body), JSON.stringify(Object.keys(call2?.body || {})).slice(0, 140));
const keysOf = (b) => Object.keys(b || {}).sort();
const sameExceptLast = keysOf(call1?.body).filter((k) => k !== 'last_image').join(',') === keysOf(baseCall?.body).join(',')
  && keysOf(baseCall?.body).every((k) => call1.body[k] === baseCall.body[k]);
ok('② 除尾帧字段外，出站请求与①（不传尾帧）逐字段一致（首帧/prompt/时长/镜头号一字不差）',
  sameExceptLast, `${JSON.stringify(call1?.body?.prompt)} | ${JSON.stringify(baseCall?.body?.prompt)}`);
ok('② 任务结果如实标注尾帧（withLastImage=1，results 带 lastFrom=last / lastImage / lastImageSource）',
  tailResult.withLastImage === 1 && tailResult.lastImageFailed === 0
  && (() => { const r = tailResult.results.find((x) => x.shotId === 'SH-TEST-1'); return r?.lastFrom === 'last' && r.lastImage === lastPngRel && r.lastImageSource === 'lastImageByShot'; })(),
  JSON.stringify(tailResult.results.find((x) => x.shotId === 'SH-TEST-1') || {}).slice(0, 220));
const tailMeta = videoMetaOf('SH-TEST-1', vdTail.jobId, '② 带尾帧（SH-TEST-1）');
const tailMeta2 = videoMetaOf('SH-TEST-2', vdTail.jobId, '② 带尾帧（SH-TEST-2）');
ok('② 落库 meta 可追溯尾帧（lastImage / lastFrom=last / lastImageSource=lastImageByShot）',
  tailMeta.bound && tailMeta.meta.lastImage === lastPngRel && tailMeta.meta.lastFrom === 'last' && tailMeta.meta.lastImageSource === 'lastImageByShot',
  whyNot(tailMeta));
ok('② 未设尾帧的镜头落库 meta 依旧没有尾帧键',
  tailMeta2.bound && !('lastImage' in tailMeta2.meta), whyNot(tailMeta2));
ok('② 带尾帧的视频文件真实落盘（mp4，来自假服务端）',
  tailMeta.bound && tailMeta.row.status === 'done' && fs.existsSync(fileAbs(tailMeta.row.file_path)) && fs.statSync(fileAbs(tailMeta.row.file_path)).size > 1000,
  tailMeta.row?.file_path || whyNot(tailMeta));

// ③ 非法 / 缺失尾帧 → 中文 400，且一个请求都不发（不静默忽略，也不半途出手）
const callsBeforeBad = fakeCalls.length;
const outsideAbs = path.join(os.tmpdir(), `factory-outside-${Date.now()}.png`);
fs.writeFileSync(outsideAbs, fs.readFileSync(lastPngAbs));
const anyVidAbs = all("SELECT file_path FROM shot_renders WHERE kind='video' AND status='done' AND file_path LIKE '%.mp4' LIMIT 1")[0]?.file_path;
const badLast = [
  ['③ 尾帧文件不存在 → 中文 400（不静默忽略）', { lastImageByShot: { 'SH-TEST-1': 'videos/不存在的尾帧.png' } }, /尾帧图不存在/],
  ['③ 尾帧路径越界（项目目录之外）→ 中文 400', { lastImageByShot: { 'SH-TEST-1': outsideAbs } }, /拒绝越界路径/],
  ['③ 尾帧不是图片（给了 mp4）→ 中文 400 并指路画布续写', { lastImage: anyVidAbs }, /必须是图片文件/],
  ['③ lastImage 用在本批多镜上 → 中文 400（避免每镜共用一张尾帧）', { lastImage: lastPngRel }, /只用于单镜视频/],
  ['③ lastImageByShot 里混入不属于本集的镜头 id → 中文 400', { lastImageByShot: { 'SH-NOT-EXIST': lastPngRel } }, /不属于本集/],
  ['③ lastImageByShot 类型不对（数组）→ 中文 400', { lastImageByShot: [lastPngRel] }, /必须是「镜头 id → 尾帧图片路径」的对象/],
];
for (const [name, extra, re] of badLast) {
  const r = await post('/api/render/videos', { scriptId: 'SC-TEST', code: 'S01E001', shotIds: ['SH-TEST-1', 'SH-TEST-2'], overwrite: true, backend: 'generic-http', ...extra });
  ok(name, r.ok === false && re.test(String(r.error || '')), r.error || JSON.stringify(r));
}
ok('③ 非法尾帧被拒时没有发出任何视频请求（不会先花钱再报错）', fakeCalls.length === callsBeforeBad, `calls=${fakeCalls.length - callsBeforeBad}`);

// ④ 单镜试渲染也支持尾帧（本地 placeholder：首帧 → 尾帧交叉溶解），未传时字段不变
//    首帧用该镜真实存在的关键帧（placeholder 出图后端产出的是 SVG，ffmpeg 能解码），尾帧用刚生成的蓝 png
const kfOk = all("SELECT * FROM shot_renders WHERE kind='keyframe' AND status='done' ORDER BY created_at DESC")
  .find((r) => { try { return r.file_path && fs.existsSync(fileAbs(r.file_path)); } catch { return false; } });
ok('准备：存在一张真实可用的关键帧图（可做首帧）', Boolean(kfOk), kfOk?.file_path || '(无)');
const tvTail = await post('/api/render/test-video', { duration: 1, move: '推镜', backend: 'placeholder', keyframe: kfOk?.file_path, lastImage: lastPngRel });
ok('④ 单镜试渲染带尾帧成功，且如实标注尾帧处理方式（raw.lastFrame=xfade / lastFrom=last / 中文 note）',
  tvTail.ok === true && tvTail.raw?.lastFrame === 'xfade' && tvTail.lastFrom === 'last' && /首尾帧过渡（xfade）/.test(String(tvTail.note || '')),
  JSON.stringify({ lastFrame: tvTail.raw?.lastFrame, note: tvTail.note, err: tvTail.error }));
ok('④ 带尾帧的试渲染产物真实落盘', Boolean(tvTail.filePath) && fs.existsSync(fileAbs(tvTail.filePath)), tvTail.filePath || '');
const tvPlain = await post('/api/render/test-video', { duration: 1, move: '推镜', backend: 'placeholder', keyframe: kfOk?.file_path });
ok('④ 不传尾帧的试渲染响应字段与历史一致（没有 lastFrom/note，raw 里没有 lastFrame）',
  tvPlain.ok === true && !('lastFrom' in tvPlain) && !('lastImage' in tvPlain) && !('lastFrame' in (tvPlain.raw || {})),
  JSON.stringify(Object.keys(tvPlain)).slice(0, 160));
const tvBad = await post('/api/render/test-video', { duration: 1, keyframe: kfOk?.file_path, lastImage: 'videos/也没有这张尾帧.png' });
ok('④ 试渲染的尾帧不存在 → 中文错误', tvBad.ok === false && /尾帧图不存在/.test(String(tvBad.error || '')), tvBad.error || '');
const tvMany = await post('/api/render/test-video', { duration: 1, keyframe: kfOk?.file_path, lastImageByShot: { A: lastPngRel, B: lastPngRel } });
ok('④ 试渲染一次给多张尾帧 → 中文错误（单镜只带一张）', tvMany.ok === false && /一次只能带一张尾帧/.test(String(tvMany.error || '')), tvMany.error || '');
// 本地 placeholder 出图后端产出的是 SVG 定妆卡（src/image.js placeholderImage）→ 它也必须能当尾帧，否则占位链路自相矛盾
const kfSvg = all("SELECT * FROM shot_renders WHERE kind='keyframe' AND status='done' AND file_path LIKE '%.svg'")
  .find((r) => { try { return fs.existsSync(fileAbs(r.file_path)); } catch { return false; } });
if (kfSvg) {
  const tvSvg = await post('/api/render/test-video', { duration: 1, move: '推镜', backend: 'placeholder', keyframe: kfOk?.file_path, lastImage: kfSvg.file_path });
  ok('④ 本地 placeholder 的关键帧（SVG）也能当尾帧（ffmpeg 可解码，占位链路自洽）',
    tvSvg.ok === true && tvSvg.raw?.lastFrame === 'xfade', tvSvg.error || JSON.stringify(Object.keys(tvSvg.raw || {})).slice(0, 120));
} else {
  ok('④ 本轮没有 SVG 关键帧可试（跳过）', true, '无 svg 关键帧');
}

// ⑤ 零付费口径：本节的计费计数只落在临时库的用量台账上
const tmpUsage = JSON.parse(get("SELECT value FROM app_config WHERE key = 'usage:monthly'")?.value || '{}');
ok('⑤ 本节全程走临时库（真实库的用量台账不会被本节改动）', process.env.FACTORY_DB === DB && process.env.FACTORY_DATA_DIR === DATA_TMP, DB);
ok('⑤ 假服务端调用计入的是临时库台账（证明请求确实走的是「假后端」而不是真实付费后端）',
  Number(Object.values(tmpUsage)[0]?.videos || 0) >= 3, JSON.stringify(tmpUsage));
fakeVideo.close();

// ================== 16. 参考图栅格化缓存（REFIMG-FIX）的可见 / 可清 / 越界防护 ==================
// 零付费：全程只造本地假文件，不发任何厂商请求。
// 缓存目录 = DATA_DIR/cache/refs（src/util.js#rasterizeSvgToPng 的落盘处，<sha1前16位>.png，单张约 300KB）。
// 关注三件事：① 默认清理不许碰它（老语义）② 显式 {cache:true} 才清、且只清 refs 下的 png
//            ③ dryRun 只看不删；越界 / 软链 / 非 png / 目录不存在 都不能出错、也不能误删。
console.log('\n=== 16. 栅格化缓存 cache/refs：只看不删 / 真删只删 png / 越界防护 ===');
const cacheRoot = path.join(DATA_TMP, 'cache');
const cacheDir = path.join(cacheRoot, 'refs');
fs.mkdirSync(cacheDir, { recursive: true });
// 本节之前，前面几节的 placeholder SVG 关键帧/尾帧已经走过**真实** REFIMG-FIX 链路
// （src/video.js#generateVideo → util.readImageForVendor(abs,{cacheDir}) → ffmpeg 栅格化落盘），
// 所以 refs 里可能已经有真缓存。先记下基线，断言一律按「基线 + 本节造的 3 个」算，避免把真缓存当成噪声。
const preNames = fs.readdirSync(cacheDir).filter((n) => /\.png$/i.test(n));
const preBytes = preNames.reduce((n, f) => n + fs.statSync(path.join(cacheDir, f)).size, 0);
const pngA = path.join(cacheDir, 'aaaa000000000001.png');   // 2048B
const pngB = path.join(cacheDir, 'bbbb000000000002.png');   // 1024B
const pngC = path.join(cacheDir, 'cccc000000000003.png');   //  512B
fs.writeFileSync(pngA, Buffer.alloc(2048, 7));
fs.writeFileSync(pngB, Buffer.alloc(1024, 7));
fs.writeFileSync(pngC, Buffer.alloc(512, 7));
const expFiles = preNames.length + 3;
const expBytes = preBytes + 2048 + 1024 + 512;
console.log(`  · 基线：本节开始前 cache/refs 里已有**真实链路**写入的 ${preNames.length} 个 PNG（${preBytes}B）—— 前面几节的 placeholder SVG 参考图走 src/video.js → util.readImageForVendor 栅格化落盘而来`);
// refs 之内的非 png（不许被当成缓存删掉）
const refsTxt = path.join(cacheDir, 'notes.json');
fs.writeFileSync(refsTxt, '{"keep":true}');
// cache/ 下（refs 之外）的**同名文件**与普通非 png：都属于「目录外」，一个都不许删
const outsideSameName = path.join(cacheRoot, 'aaaa000000000001.png');
const outsideTxt = path.join(cacheRoot, 'keep-me.txt');
fs.writeFileSync(outsideSameName, Buffer.alloc(4096, 9));
fs.writeFileSync(outsideTxt, 'do-not-delete');
// 软链（在 refs 内、名字像 png，指向目录外的真文件）：不跟随、不删目标
const linkTarget = path.join(DATA_TMP, 'outside-link-target.png');
fs.writeFileSync(linkTarget, Buffer.alloc(4096, 5));
let linkOk = true;
try { fs.symlinkSync(linkTarget, path.join(cacheDir, 'dddd000000000004.png')); } catch { linkOk = false; }
ok('16. 准备：3 个假缓存 png + refs 内非 png + cache/ 下同名 png 与 txt + 软链',
  [pngA, pngB, pngC, refsTxt, outsideSameName, outsideTxt, linkTarget].every((p) => fs.existsSync(p)), `link=${linkOk} 基线真缓存=${preNames.length}个/${preBytes}B`);

// ① GET 只看不删：只统计 refs 下的**普通 png 文件**（软链不算），不动任何文件
const cacheGet = await get_('/api/render/cache');
ok('16. ① GET /api/render/cache 报出 dir/files/bytes/freedMB（只看不删）',
  cacheGet.ok === true && cacheGet.dryRun === true && path.resolve(cacheGet.dir) === path.resolve(cacheDir)
  && cacheGet.files === expFiles && cacheGet.bytes === expBytes && cacheGet.freedMB >= 0 && /只看不删/.test(String(cacheGet.note)),
  JSON.stringify({ dir: cacheGet.dir, files: cacheGet.files, bytes: cacheGet.bytes, note: cacheGet.note }));
ok('16. ① GET 之后一个文件都没少（含 refs 内非 png、软链、cache/ 下同名文件）',
  [pngA, pngB, pngC, refsTxt, outsideSameName, outsideTxt, linkTarget].every((p) => fs.existsSync(p)));

// ② POST {cache:true, dryRun:true} 同口径预览：removed=0，文件全在
const dry = await post('/api/render/cleanup', { cache: true, dryRun: true });
ok('16. ② dryRun 预览：cache.removed=0 且如实报可清的 files/bytes（与 GET 同数）',
  dry.ok === true && dry.cache && dry.cache.dryRun === true && dry.cache.removed === 0
  && dry.cache.files === expFiles && dry.cache.bytes === expBytes && dry.cache.skipped === 2 && dry.cache.failed === 0,
  JSON.stringify(dry.cache));
ok('16. ② dryRun 一个文件都没删（含软链目标与 cache/ 下同名文件）',
  [pngA, pngB, pngC, refsTxt, outsideSameName, outsideTxt, linkTarget].every((p) => fs.existsSync(p)));

// ③ 真删：只删 refs 下的 png（含上面真实链路写进来的真缓存），其余一概不动
const filmsNow = (await get_('/api/render/films?scriptId=SC-TEST')).films.filter((f) => f.file_path && fs.existsSync(fileAbs(f.file_path)));
const real = await post('/api/render/cleanup', { cache: true });
ok('16. ③ 真删：cache.removed=全部 refs 内 png、bytes 如实，总计字段相加如实（removedTotal/bytesTotal/freedMBTotal）',
  real.ok === true && real.cache && real.cache.removed === expFiles && real.cache.bytes === expBytes
  // 占位出图改为 PNG 后，参考图不再需要 ffmpeg 栅格化，refs 缓存可能为空 → freedMB 按字节如实换算即可
  && real.cache.freedMB === Math.round((real.cache.bytes / 1048576) * 10) / 10
  && real.removedTotal === real.removed + real.cache.removed
  && real.bytesTotal === real.bytes + real.cache.bytes
  && real.freedMBTotal === Math.round((real.bytesTotal / 1048576) * 10) / 10,
  JSON.stringify({ removed: real.removed, cache: real.cache, removedTotal: real.removedTotal, bytesTotal: real.bytesTotal }));
ok('16. ③ refs 下 3 个假 png 全部删除', ![pngA, pngB, pngC].some((p) => fs.existsSync(p)));
ok('16. ③ refs 内已无任何 png（真缓存也一起回收了；GET 报 files=0）', (await get_('/api/render/cache')).files === 0);
ok('16. ③ refs 内的非 png（notes.json）未被删（只删 *.png）',
  fs.existsSync(refsTxt) && fs.readFileSync(refsTxt, 'utf8') === '{"keep":true}');
ok('16. ③ cache/ 下（refs 之外）的同名 png 与 txt 仍在 —— 目录越界防护生效（resolve 后必须落在 refs 内）',
  fs.existsSync(outsideSameName) && fs.existsSync(outsideTxt) && fs.statSync(outsideSameName).size === 4096);
ok('16. ③ 软链本身没被删、其指向的目录外文件也没被删 —— 不跟随符号链接去删外部文件',
  fs.existsSync(path.join(cacheDir, 'dddd000000000004.png')) && fs.existsSync(linkTarget) && fs.statSync(linkTarget).size === 4096);
ok('16. ③ 清缓存不波及已入档成片（finish 白名单逻辑未动）',
  filmsNow.length >= 1 && filmsNow.every((f) => fs.existsSync(fileAbs(f.file_path))), `${filmsNow.length} 部成片完好`);

// ④ 重复清理：第二次 removed=0，不报错
const again = await post('/api/render/cleanup', { cache: true });
ok('16. ④ 重复清理第二次 cache.removed=0、files=0、ok=true（不报错、不 500）',
  again.ok === true && again.cache.removed === 0 && again.cache.files === 0 && again.cache.failed === 0,
  JSON.stringify(again.cache));

// ⑤ 默认语义未变：POST /api/render/cleanup **不带** cache → finish 中间产物照清，缓存 png 一个不删
//    （web/views/render.js 与 scripts/simulate-all.js 都是 POST {}，这条就是它们的防回归）
fs.writeFileSync(pngA, Buffer.alloc(2048, 7));
fs.writeFileSync(pngB, Buffer.alloc(1024, 7));
const defDir = path.join(DATA_TMP, 'finish', 'SC-TEST_S01E001');
fs.mkdirSync(defDir, { recursive: true });
const defTmp = path.join(defDir, 'concat_default16.txt');
const defKept = path.join(defDir, 'S01E001_final.mp4');
fs.writeFileSync(defTmp, 'x');
fs.writeFileSync(defKept, 'keep');
const defRun = await post('/api/render/cleanup', {});
ok('16. ⑤ 不带 cache 的清理：finish 中间产物照清、入档名文件保留、返回体与改造前一致（没有 cache 字段）',
  defRun.ok === true && defRun.removed >= 1 && !fs.existsSync(defTmp) && fs.existsSync(defKept) && !('cache' in defRun) && !('removedTotal' in defRun),
  JSON.stringify(defRun).slice(0, 160));
ok('16. ⑤ 不带 cache 时栅格化缓存**不**被清（默认行为未突变），GET 仍报 files=2',
  fs.existsSync(pngA) && fs.existsSync(pngB) && (await get_('/api/render/cache')).files === 2);

// ④b 单个文件删不掉时：接口不许 500，要继续清、并如实计数 failed（安全红线④）
const pngD = path.join(cacheDir, 'eeee000000000005.png');
fs.writeFileSync(pngD, Buffer.alloc(256, 7));
const canLock = (() => { try { fs.chmodSync(cacheDir, 0o555); return true; } catch { return false; } })();
if (canLock && typeof process.getuid === 'function' && process.getuid() !== 0) {
  const locked = await post('/api/render/cleanup', { cache: true });
  ok('16. ④b refs 目录不可写（unlink 必失败）时：接口仍 ok=true 不 500，failed 计数、文件原样保留',
    locked.ok === true && locked.cache.failed >= 1 && locked.cache.removed === 0
    && locked.cache.errors.length >= 1 && [pngA, pngB, pngD].every((p) => fs.existsSync(p)),
    JSON.stringify(locked.cache).slice(0, 200));
  fs.chmodSync(cacheDir, 0o755);
} else {
  try { fs.chmodSync(cacheDir, 0o755); } catch { /* ignore */ }
  ok('16. ④b 当前环境无法制造「删不掉」（root 或 chmod 不可用），跳过不可写用例', true, `uid=${typeof process.getuid === 'function' ? process.getuid() : 'n/a'}`);
}
fs.rmSync(pngD, { force: true });

// ⑥ 缓存目录不存在：报 0、不报错（老库里本来就没有 cache/refs）
const savedDir = cacheDir + '-moved';
fs.renameSync(cacheDir, savedDir);
const noDirGet = await get_('/api/render/cache');
const noDirPost = await post('/api/render/cleanup', { cache: true });
ok('16. ⑥ 缓存目录不存在：GET/POST 均 ok=true、removed=0、不抛错',
  noDirGet.ok === true && noDirGet.files === 0 && noDirGet.bytes === 0 && noDirGet.exists === false
  && noDirPost.ok === true && noDirPost.cache.ok === true && noDirPost.cache.removed === 0 && noDirPost.cache.bytes === 0,
  JSON.stringify({ get: noDirGet, post: noDirPost.cache }).slice(0, 200));
fs.renameSync(savedDir, cacheDir);

// ⑦ refs 本身被换成软链：拒绝清理（跟随它 unlink 就等于删目录外的文件）
const outsideRefs = path.join(DATA_TMP, 'outside-refs');
fs.mkdirSync(outsideRefs, { recursive: true });
const victim = path.join(outsideRefs, 'victim.png');
fs.writeFileSync(victim, Buffer.alloc(1024, 3));
fs.rmSync(cacheDir, { recursive: true, force: true });
let symDirOk = true;
try { fs.symlinkSync(outsideRefs, cacheDir); } catch { symDirOk = false; }
if (symDirOk) {
  const symGet = await get_('/api/render/cache');
  const symPost = await post('/api/render/cleanup', { cache: true });
  ok('16. ⑦ refs 目录本身是软链 → 拒绝清理（ok=false + 中文说明），软链目标下的 png 原样保留',
    symGet.ok === false && /符号链接/.test(String(symGet.note)) && symPost.cache.ok === false && symPost.cache.removed === 0 && fs.existsSync(victim),
    JSON.stringify(symPost.cache).slice(0, 180));
} else {
  ok('16. ⑦ 本机不允许建目录软链，跳过软链拒绝用例', true, 'symlink 不可用');
}

// ================== 17. 尾帧落库（I-101：原先「只存会话、一刷新就没」）==================
// 覆盖面：① PUT 设置 → 直接查库断言字段写了 → 看板（新一次读取 = 刷新/新会话）带回 ② 清除 → 字段清空
//        ③ 非法（不存在/越界/非图片/缺 file 键）→ 中文 400 且**库里一个字节都不变**（口径与 /api/render/videos 同一函数）
//        ④ 尾帧文件被删后：看板仍返回用户设置（绝不静默清空）+ tail_image_missing=true，
//           而提交链路给出既有中文拒绝（HTTP 层整批拒；模块层 runVideos 该镜失败并落中文错误记录）
// 零付费：全程只读写临时库 + 本机 ffmpeg 造图；「④」的失败在文件存在性检查处就 return，一次后端请求都不会发。
console.log('\n=== 17. 尾帧落库（shots.tail_image）：设置 / 清除 / 非法不写 / 文件失效仍保留 ===');
const { createVideoJob } = await import('../src/modules/render.js');
const persistRel = 'videos/tail-persist.png';
const persistAbs = path.join(DATA_TMP, persistRel);
spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=360x240', '-frames:v', '1', persistAbs]);
const tailCols = all('PRAGMA table_info(shots)').map((c) => c.name);
ok('17. 准备：shots 表有 tail_image 列（migrate 的 addMissingColumns 已加，老库平滑升级）',
  tailCols.includes('tail_image'), tailCols.join(','));
ok('17. 准备：schema_version 已升到 14 并写进 meta_kv',
  Number(get("SELECT value FROM meta_kv WHERE key='schema_version'")?.value) >= 14,
  get("SELECT value FROM meta_kv WHERE key='schema_version'")?.value);
ok('17. 准备：尾帧图已生成（data 目录内，可被 resolveAsset 解析）', fs.existsSync(persistAbs), persistRel);
const dbTail = () => get("SELECT tail_image FROM shots WHERE id = 'SH-TEST-3'")?.tail_image ?? null;

// ① 设置 → 落库 → 看板带回（前端 S.lastImages 就是从这里水合的）
const putSet = await put('/api/render/shots/SH-TEST-3/tail-image', { file: persistRel });
ok('17. ① PUT 设置尾帧：ok + 返回存下的路径 + 中文说明（已保存：下次打开这一集仍在）',
  putSet.ok === true && putSet.tail_image === persistRel && putSet.cleared === false && putSet.exists === true
  && /已保存尾帧/.test(String(putSet.note || '')), JSON.stringify(putSet));
ok('17. ① 字段**真的写进了库**（直接查 shots.tail_image，不是只在内存/响应里）',
  dbTail() === persistRel, `db=${dbTail()}`);
const boardAfterSet = await get_('/api/render/episode?scriptId=SC-TEST&code=S01E001');
const shotSet = boardAfterSet.shots.find((s) => s.id === 'SH-TEST-3');
const shotOther = boardAfterSet.shots.find((s) => s.id === 'SH-TEST-4');
ok('17. ① 看板（新一次读取 = 刷新页面 / 新会话）带回该镜尾帧，前端据此还原 S.lastImages',
  shotSet?.tail_image === persistRel && shotSet?.tail_image_missing === false,
  JSON.stringify({ tail: shotSet?.tail_image, missing: shotSet?.tail_image_missing }));
ok('17. ① 未设尾帧的镜头：看板字段是 null 且不误报「文件不存在」',
  shotOther?.tail_image === null && shotOther?.tail_image_missing === false,
  JSON.stringify({ tail: shotOther?.tail_image, missing: shotOther?.tail_image_missing }));
const putAgain = await put('/api/render/shots/SH-TEST-3/tail-image', { file: persistRel });
ok('17. ① 重复设置同一个值是幂等的（不报错、库不变）',
  putAgain.ok === true && dbTail() === persistRel, JSON.stringify(putAgain));

// ② 非法输入：中文 400，且**库里一个字节都不变**（校验不过就不许写）
const outsidePng = path.join(os.tmpdir(), `factory-i101-outside-${Date.now()}.png`);
fs.writeFileSync(outsidePng, fs.readFileSync(persistAbs));
const mp4Rel = all("SELECT file_path FROM shot_renders WHERE kind='video' AND status='done' AND file_path LIKE '%.mp4'")
  .map((r) => r.file_path).find((p) => { const a = resolveAsset(p); return a && fs.existsSync(a) && /\.mp4$/i.test(a); });
ok('17. ② 准备：存在一个真实的视频文件（用于「非图片」用例，与 /api/render/videos 的③同款造法）', Boolean(mp4Rel), mp4Rel || '(无)');
const badTailCases = [
  ['17. ② 尾帧文件不存在 → 中文 400（与 /api/render/videos 同一函数、同一文案）', { file: 'videos/不存在-i101.png' }, /尾帧图不存在/],
  ['17. ② 越界路径（项目目录之外）→ 中文 400', { file: outsidePng }, /拒绝越界路径/],
  ['17. ② 不是图片（给了 mp4）→ 中文 400 并指路画布续写', { file: mp4Rel }, /必须是图片文件/],
  ['17. ② 连 file 键都不给 → 中文 400（防手滑把已设尾帧清空）', {}, /缺少 file/],
];
for (const [name, body, re] of badTailCases) {
  const r = await put('/api/render/shots/SH-TEST-3/tail-image', body);
  ok(name, r.ok === false && re.test(String(r.error || '')), r.error || JSON.stringify(r));
  ok(`${name} —— 且库里原值未被改动（非法输入不写入任何东西）`, dbTail() === persistRel, `db=${dbTail()}`);
}
const putUnknownShot = await put('/api/render/shots/SH-I101-NOT-EXIST/tail-image', { file: persistRel });
ok('17. ② 镜头不存在 → 中文 404（不会凭空造出一条设置）',
  putUnknownShot.ok === false && /镜头不存在/.test(String(putUnknownShot.error || '')), String(putUnknownShot.error || ''));

// ③ 清除 → 字段清空（含「空串按清除处理」：与 /api/render/videos 里「空值 = 这一镜不设尾帧」同口径）
const putClear = await put('/api/render/shots/SH-TEST-3/tail-image', { file: null });
ok('17. ③ PUT { file: null } 清除：ok + cleared=true + 中文说明（已清除尾帧）',
  putClear.ok === true && putClear.cleared === true && putClear.tail_image === null && /已清除尾帧/.test(String(putClear.note || '')),
  JSON.stringify(putClear));
ok('17. ③ 库里字段真的清空了（NULL），不是只在响应里说清除', dbTail() === null, `db=${dbTail()}`);
ok('17. ③ 看板随之返回 null（刷新后不会「复活」）',
  (await get_('/api/render/episode?scriptId=SC-TEST&code=S01E001')).shots.find((s) => s.id === 'SH-TEST-3')?.tail_image === null);
await put('/api/render/shots/SH-TEST-3/tail-image', { file: persistRel });
const putEmpty = await put('/api/render/shots/SH-TEST-3/tail-image', { file: '' });
ok('17. ③ 空串与 null 同义（按清除处理，口径同 /api/render/videos 的「空值 = 不设尾帧」）',
  putEmpty.ok === true && putEmpty.cleared === true && dbTail() === null, JSON.stringify({ r: putEmpty, db: dbTail() }));

// ④ 尾帧文件被删（关键帧被删/重渲染换名）：设置**保留**、如实标出、提交链路给既有中文拒绝
await put('/api/render/shots/SH-TEST-3/tail-image', { file: persistRel });
fs.rmSync(persistAbs, { force: true });
const boardGone = await get_('/api/render/episode?scriptId=SC-TEST&code=S01E001');
const shotGone = boardGone.shots.find((s) => s.id === 'SH-TEST-3');
ok('17. ④ 尾帧文件被删后：看板仍返回用户设置的值（绝不静默清掉设置）',
  shotGone?.tail_image === persistRel, JSON.stringify({ tail: shotGone?.tail_image }));
ok('17. ④ 并如实标出 tail_image_missing=true（前端据此显示「文件已不存在」，不假装还在）',
  shotGone?.tail_image_missing === true, JSON.stringify({ missing: shotGone?.tail_image_missing }));
ok('17. ④ 库里也仍是原值（设置没被偷偷抹掉，用户回来还能看到自己设过什么）',
  dbTail() === persistRel, `db=${dbTail()}`);
const vdGone = await post('/api/render/videos', {
  scriptId: 'SC-TEST', code: 'S01E001', shotIds: ['SH-TEST-3'], overwrite: true, backend: 'placeholder',
  lastImageByShot: { 'SH-TEST-3': persistRel },
});
ok('17. ④ 拿着这个已失效的尾帧提交 → 既有中文拒绝（HTTP 层在提交时就拒，绝不静默丢掉尾帧）',
  vdGone.ok === false && /尾帧图不存在/.test(String(vdGone.error || '')), String(vdGone.error || JSON.stringify(vdGone)));
// 模块层（route 校验通过后真正干活的那一段）：确认「该镜失败并落中文错误」的既有语义仍然成立
const modJob = createVideoJob({ scriptId: 'SC-TEST', code: 'S01E001', shotIds: ['SH-TEST-3'], overwrite: true,
  lastImageByShot: { 'SH-TEST-3': persistRel } });
const modDone = await waitJob(modJob.jobId, 300);
const modShot = ((modDone?.result || {}).results || [])[0] || {};
ok('17. ④ 模块层 runVideos：该镜确实失败且给既有中文原因（lastImageFailed 如实计数）',
  modDone?.status === 'done' && modShot.ok === false && /尾帧图不存在/.test(String(modShot.error || ''))
  && (modDone.result || {}).lastImageFailed === 1,
  JSON.stringify({ status: modDone?.status, shot: modShot, failed: (modDone?.result || {}).lastImageFailed }).slice(0, 240));
const goneCell = renderOfCall('SH-TEST-3', 'video', modJob.jobId, '17. ④ 尾帧失效的失败落库', "AND status='error'");
ok('17. ④ 这次失败也落了库（失败记录里查得到中文原因，不是只在内存里）',
  goneCell.bound && /尾帧图不存在/.test(String(goneCell.row.error || '')), goneCell.bound ? String(goneCell.row.error).slice(0, 140) : whyNot(goneCell));

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
server.close();
try { fs.rmSync(DB, { force: true }); fs.rmSync(DB + '-wal', { force: true }); fs.rmSync(DB + '-shm', { force: true }); } catch { /* ignore */ }
try { fs.rmSync(DATA_TMP, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(fail ? 1 : 0);
