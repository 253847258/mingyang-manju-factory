// 墙钟非单调回归测试（E-101 · 源码加固线）
// 用法：node tests/test-clock-skew.js
//
// 背景（已确证的环境缺陷，不是猜测）：本机**墙钟非单调** —— 用 process.hrtime.bigint()（单调钟）
// 对照 Date.now()（墙钟）采样，实测每 ~20 秒出现一次 ±12.4s 的回拨/前拨
// （证据：strategist/runs/FLAKE-FIX.json；自检产物里甚至记下过 "ms": -12349）。
// 由此产生两类错误，本套件逐条守死：
//   ① 取值错行：凡「取该镜/该节点最新一行」按 `created_at DESC` 判序 → 墙钟回拨时取到**别人的旧行**；
//      正确口径是 `ORDER BY rowid DESC`（无 AUTOINCREMENT 时 rowid = max+1，插入序与墙钟无关）。
//   ② 负耗时：`Date.now() - t0` 当耗时 → 负数污染看板/报告/对账；同进程耗时必须用单调钟并钳 0。
//
// 零付费硬红线：全部用临时库 + 临时数据目录 + 临时配置（占位后端 placeholder / TTS none / LLM mock），
// 绝不触碰 data/factory.db，也绝不发出任何真实网络请求。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-clockskew-'));
const DATA_TMP = path.join(TMP, 'data');
const CFG = path.join(TMP, 'config.json');
fs.mkdirSync(DATA_TMP, { recursive: true });
fs.writeFileSync(CFG, JSON.stringify({
  image: { backend: 'placeholder', retries: 0, retryBaseMs: 0 },
  video: { backend: 'placeholder', retries: 0, retryBaseMs: 0 },
  tts: { backend: 'none' },
  llm: { provider: 'mock' },
}), 'utf8');
process.env.FACTORY_DATA_DIR = DATA_TMP;
process.env.FACTORY_DB = path.join(TMP, 'clockskew.db');
process.env.FACTORY_CONFIG = CFG;

const { migrate, run, get, all } = await import('../src/db.js');
const R = await import('../src/modules/render.js');
const G = await import('../src/graph.js');
const ST = await import('../src/stats.js');
const { generateImage } = await import('../src/image.js');
const { elapsedMsSince, monoNow, clampMs } = await import('../src/util.js');

migrate();
G.ensureGraphSchema();

// ---- 结算助手 ----
let pass = 0, fail = 0;
const ok = (name, cond, evidence = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${evidence ? `  ← ${evidence}` : ''}`); }
  else { fail++; console.error(`  ✗ ${name}  ← ${evidence}`); }
};
const eq = (name, actual, expected) => ok(name, actual === expected, `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`);

/** 回拨/前拨幅度：与实机实测的 ~12.4s 一致 */
const SKEW = 12400;
const isoAt = (deltaMs) => new Date(Date.now() + deltaMs).toISOString();
const rowsOf = (shotId, kind) => all(
  `SELECT rowid AS _rid, id, job_id, status, created_at FROM shot_renders WHERE shot_id = ? AND kind = ? ORDER BY rowid DESC`, shotId, kind);
const dumpRows = (shotId, kind) => rowsOf(shotId, kind).map((r) => `#${r._rid} ${r.id} created=${r.created_at}`).join(' | ') || '(无)';

// ---- 造数据：1 部剧本 + 1 集 + 6 个镜头（只为 shot_renders 提供外键上下文）----
const now = isoAt(0);
run(`INSERT INTO scripts(id, novel_id, title, format, style_id, episode_seconds, episodes_per_season, seasons, status, created_at, updated_at)
     VALUES('SC-CS','N-CS','墙钟回拨测试剧本','manju','cn-guofeng',12,1,1,'draft',?,?)`, now, now);
run(`INSERT INTO script_episodes(id, script_id, season, episode, code, title, duration, status, created_at, updated_at)
     VALUES('EP-CS','SC-CS',1,1,'S01E001','测试集',12,'planned',?,?)`, now, now);
for (let i = 1; i <= 6; i++) {
  run(`INSERT INTO shots(id, script_id, episode_id, idx, scene_no, shot_size, camera, move, transition, duration, action, dialogue, mood, prompt_pos, prompt_neg, refs, cost_level, status, created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?)`,
    `SH-CS-${i}`, 'SC-CS', 'EP-CS', i, '1', '中景', '平视', '固定', '切', 2, `动作${i}`, `台词${i}`, '平静',
    `test scene ${i}`, 'blurry', JSON.stringify({ characters: [] }), 'L', now);
}

// ============================================================================================
console.log('=== 1. 「最新一行」口径：后插入的行即使 created_at 更早也必须胜出（keyframe / video） ===');
// ============================================================================================
const case1 = {};
for (const kind of ['keyframe', 'video']) {
  const shotId = kind === 'keyframe' ? 'SH-CS-1' : 'SH-CS-2';
  const mime = kind === 'keyframe' ? 'image/svg+xml' : 'video/mp4';
  // 真实的回拨方向：**先插入的 A 拿到较晚的墙钟，后插入的 B 拿到回拨后更早的墙钟**
  const A = R.insertShotRender({
    script_id: 'SC-CS', episode_id: 'EP-CS', shot_id: shotId, kind,
    file_path: `data/images/${kind}_A.svg`, mime, backend: 'placeholder', status: 'done', job_id: 'JOB-OLD',
    meta: { onlyA: 1 },
  });
  run('UPDATE shot_renders SET created_at = ? WHERE id = ?', isoAt(0), A);
  const B = R.insertShotRender({
    script_id: 'SC-CS', episode_id: 'EP-CS', shot_id: shotId, kind,
    file_path: `data/images/${kind}_B.svg`, mime, backend: 'placeholder', status: 'done', job_id: 'JOB-NEW',
    meta: { onlyB: 2 },
  });
  run('UPDATE shot_renders SET created_at = ?, meta = ? WHERE id = ?', isoAt(-SKEW), JSON.stringify({ onlyB: 2 }), B);

  const best = R.bestRender(shotId, kind);
  ok(`① [${kind}] bestRender 取到「后插入」的那条（不看 created_at）`, best?.id === B,
    `取到 ${best?.id}（期望新行 ${B}）；行序：${dumpRows(shotId, kind)}`);

  const versions = R.listShotVersions(shotId, kind);
  ok(`① [${kind}] listShotVersions 新→旧按插入序，versions[0].isLatest 只给后插入那条`,
    versions[0]?.id === B && versions[0]?.isLatest === true && versions.filter((v) => v.isLatest).length === 1,
    versions.map((v) => `${v.id}(v${v.version}${v.isLatest ? ',latest' : ''})`).join(' '));

  // 对照：改动前的口径（created_at DESC）会取到哪一行 —— 用来证明本段断言「改动前必失败」
  const legacy = get(
    "SELECT id FROM shot_renders WHERE shot_id = ? AND kind = ? AND status = 'done' ORDER BY created_at DESC LIMIT 1", shotId, kind);
  ok(`① [${kind}]（对照）旧的 created_at 口径确实取到「旧行」→ 本段断言在改动前必失败`,
    legacy?.id === A, `created_at 口径取到 ${legacy?.id}（= 先插入的 A=${A}），rowid 口径取到 ${best?.id}（= 后插入的 B=${B}）`);

  // meta 浅合并的「底」也必须是后插入那条（src/modules/render.js latestShotMeta）：
  // A 的 meta 里有一个只属于它的键 onlyA，B 的 meta 里只有 onlyB —— 合并结果里出现哪个键就说明「底」是谁
  const C = R.insertShotRender({
    script_id: 'SC-CS', episode_id: 'EP-CS', shot_id: shotId, kind,
    file_path: `data/images/${kind}_C.svg`, backend: 'placeholder', status: 'done', job_id: 'JOB-NEWEST',
    meta: { onlyC: 3 },
  });
  const metaC = JSON.parse(get('SELECT meta FROM shot_renders WHERE id = ?', C).meta || '{}');
  ok(`① [${kind}] meta 浅合并的「底」= 后插入那条（A 独有的旧键 onlyA 不得出现）`,
    metaC.onlyB === 2 && metaC.onlyA === undefined && metaC.metaMergedFrom === B,
    `meta=${JSON.stringify(metaC)}（期望 onlyB=2 / 无 onlyA / metaMergedFrom=${B}）`);

  case1[kind] = { A, B, C, best: best?.id, legacy: legacy?.id };
}

// ============================================================================================
console.log('\n=== 2. 旧行的 created_at 被人为写到「未来」→ 新插入行仍必须胜出 ===');
// ============================================================================================
const oldFuture = R.insertShotRender({
  script_id: 'SC-CS', episode_id: 'EP-CS', shot_id: 'SH-CS-3', kind: 'video',
  file_path: 'data/videos/future_old.mp4', backend: 'placeholder', status: 'done', job_id: 'JOB-OLD-FUTURE',
  meta: { tag: 'OLD-FUTURE' },
});
run('UPDATE shot_renders SET created_at = ? WHERE id = ?', isoAt(3600 * 1000), oldFuture);   // 未来的墙钟
const newNormal = R.insertShotRender({
  script_id: 'SC-CS', episode_id: 'EP-CS', shot_id: 'SH-CS-3', kind: 'video',
  file_path: 'data/videos/new_normal.mp4', backend: 'placeholder', status: 'done', job_id: 'JOB-NEW-NORMAL',
  meta: { tag: 'NEW' },
});
const best3 = R.bestRender('SH-CS-3', 'video');
ok('② 旧行 created_at = 未来 +1h 时，bestRender 仍取新插入行', best3?.id === newNormal,
  `取到 ${best3?.id}（期望 ${newNormal}）；行序：${dumpRows('SH-CS-3', 'video')}`);
const legacy3 = get("SELECT id FROM shot_renders WHERE shot_id = ? AND kind = 'video' AND status='done' ORDER BY created_at DESC LIMIT 1", 'SH-CS-3');
ok('②（对照）旧的 created_at 口径被「未来时间戳」骗到旧行', legacy3?.id === oldFuture,
  `created_at 口径取到 ${legacy3?.id}（= 旧行 ${oldFuture}）`);
const meta3 = JSON.parse(get('SELECT meta FROM shot_renders WHERE id = ?',
  R.insertShotRender({ script_id: 'SC-CS', episode_id: 'EP-CS', shot_id: 'SH-CS-3', kind: 'video', file_path: 'data/videos/third.mp4', backend: 'placeholder', meta: { third: true } })).meta || '{}');
ok('② meta 浅合并的「底」也不被未来时间戳的旧行劫持', meta3.tag === 'NEW' && meta3.metaMergedFrom === newNormal,
  `tag=${meta3.tag} from=${meta3.metaMergedFrom}`);

// ============================================================================================
console.log('\n=== 3. 删除最新行后再插入：rowid 复用不影响「插入序倒序」 ===');
// ============================================================================================
const X = R.insertShotRender({ script_id: 'SC-CS', episode_id: 'EP-CS', shot_id: 'SH-CS-4', kind: 'keyframe', file_path: 'data/images/x.svg', backend: 'placeholder', status: 'done', job_id: 'JOB-X', meta: { tag: 'X' } });
const Y = R.insertShotRender({ script_id: 'SC-CS', episode_id: 'EP-CS', shot_id: 'SH-CS-4', kind: 'keyframe', file_path: 'data/images/y.svg', backend: 'placeholder', status: 'done', job_id: 'JOB-Y', meta: { tag: 'Y' } });
const Z = R.insertShotRender({ script_id: 'SC-CS', episode_id: 'EP-CS', shot_id: 'SH-CS-4', kind: 'keyframe', file_path: 'data/images/z.svg', backend: 'placeholder', status: 'done', job_id: 'JOB-Z', meta: { tag: 'Z' } });
const ridOf = (id) => get('SELECT rowid AS r FROM shot_renders WHERE id = ?', id)?.r;
const ridZ = ridOf(Z);
run('DELETE FROM shot_renders WHERE id = ?', Z);                                  // 删掉 rowid 最大的那行
const W = R.insertShotRender({ script_id: 'SC-CS', episode_id: 'EP-CS', shot_id: 'SH-CS-4', kind: 'keyframe', file_path: 'data/images/w.svg', backend: 'placeholder', status: 'done', job_id: 'JOB-W', meta: { tag: 'W' } });
run('UPDATE shot_renders SET created_at = ? WHERE id = ?', isoAt(-SKEW * 3), W);  // 新行带更早的墙钟
const ridW = ridOf(W);
const best4 = R.bestRender('SH-CS-4', 'keyframe');
ok('③ 删掉最新行后再插入 → 「最新一行」仍是这条新行', best4?.id === W,
  `取到 ${best4?.id}（期望 ${W}）；行序：${dumpRows('SH-CS-4', 'keyframe')}`);
ok('③ 新插入行的 rowid 严格大于现存所有行（即使复用了被删行的 rowid）',
  ridW > ridOf(Y) && ridW > ridOf(X) && ridW === ridZ,
  `rowid: X=${ridOf(X)} Y=${ridOf(Y)} Z(已删)=${ridZ} W=${ridW}（W 复用了 Z 的位置，但仍 > 现存最大值 Y）`);
const metaW = JSON.parse(get('SELECT meta FROM shot_renders WHERE id = ?',
  R.insertShotRender({ script_id: 'SC-CS', episode_id: 'EP-CS', shot_id: 'SH-CS-4', kind: 'keyframe', file_path: 'data/images/w2.svg', backend: 'placeholder', meta: { w2: true } })).meta || '{}');
ok('③ meta 浅合并的「底」= 这条新行（不会是 X/Y）', metaW.tag === 'W' && metaW.metaMergedFrom === W,
  `tag=${metaW.tag} from=${metaW.metaMergedFrom}`);

// ============================================================================================
console.log('\n=== 4. 负耗时：墙钟回拨下记录的耗时必须 ≥ 0 ===');
// ============================================================================================
// 4a 纯函数层：注入一个「回拨 12.4s」的时钟
// 改动前 src/util.js 没有这三个助手（本段必失败）；这里显式判存在，让「改动前」表现为断言失败而不是脚本崩掉。
const hasMono = typeof monoNow === 'function' && typeof elapsedMsSince === 'function' && typeof clampMs === 'function';
ok('④ src/util.js 导出了单调钟助手 monoNow / elapsedMsSince / clampMs（改动前不存在 → 本段必失败）', hasMono,
  hasMono ? 'monoNow / elapsedMsSince / clampMs 三个都在' : `monoNow=${typeof monoNow} elapsedMsSince=${typeof elapsedMsSince} clampMs=${typeof clampMs}`);
if (hasMono) {
  const t0pure = monoNow();
  const rollback = () => t0pure - SKEW;
  eq('④ 纯函数：注入回拨 12.4s 的时钟后 elapsedMsSince 仍为 0（钳 0）', elapsedMsSince(t0pure, rollback), 0);
  eq('④（对照）同样的回拨下 Date.now() 差值 = -12400（就是污染看板的那个负数）', rollback() - t0pure, -SKEW);
  ok('④ 单调钟自身单调不减（连续两次采样差值 ≥ 0）', (() => { const a = monoNow(); const b = monoNow(); return b - a >= 0; })(),
    `monoNow 差值 = ${(monoNow() - t0pure).toFixed(3)}ms`);
  ok('④ clampMs：负数/NaN/Infinity → 0，正常值四舍五入', clampMs(-12349) === 0 && clampMs(NaN) === 0 && clampMs(-Infinity) === 0 && clampMs(12.6) === 13,
    `${clampMs(-12349)} / ${clampMs(NaN)} / ${clampMs(-Infinity)} / ${clampMs(12.6)}`);
}

// 4b 端到端：把 Date.now() 换成「每次读都回拨 12.4s」的假墙钟，走真实出图路径（占位后端，零费用）
const realDateNow = Date.now;
let fakeWall = realDateNow();
Date.now = () => { fakeWall -= SKEW; return fakeWall; };
let imgOut = null;
try {
  imgOut = await generateImage({ backend: 'placeholder', prompt: '墙钟回拨下的出图耗时', kind: 'custom', variant: 'skew', width: 64, height: 64 });
} finally {
  Date.now = realDateNow;
}
ok('④ 端到端：Date.now() 持续回拨时，出图返回的 elapsedMs 不是负数',
  Number.isFinite(imgOut?.elapsedMs) && imgOut.elapsedMs >= 0,
  `elapsedMs=${imgOut?.elapsedMs}（旧实现会是 ${-SKEW} 量级的负数）`);
ok('④ 端到端：出图仍然成功（钳 0 不影响功能）', imgOut?.ok !== false && !!imgOut?.filePath, `filePath=${imgOut?.filePath}`);

// 4c 端到端：整图执行（stub 执行器）在回拨下写库的耗时不得为负
let graphRows = null;
Date.now = () => { fakeWall -= SKEW; return fakeWall; };
try {
  const CV = 'CV-SKEW';
  run(`INSERT INTO canvas_nodes(id, canvas_id, actor_id, x, y, w, h, z, locked, note, group_id, kind, color, title, data)
       VALUES('N-SKEW-1',?, '',0,0,180,220,0,0,'',NULL,'image',NULL,'回拨测试节点',?)`,
    CV, JSON.stringify({ prompt: 'skew node' }));
  // stub 执行器**故意不返回 elapsedMs** → 走 src/graph.js 里的兜底计时（就是历史上会变负的那一处）
  const executors = { default: async (req) => ({ filePath: `data/stub/${req.node.id}.bin`, mime: 'application/octet-stream', backend: 'stub', model: 'stub-1', raw: {} }) };
  await G.runGraph({ canvasId: CV, overwrite: true, executors, retries: 0, retryBaseMs: 0 });
  const row = get('SELECT * FROM canvas_node_runs WHERE node_id = ? ORDER BY rowid DESC LIMIT 1', 'N-SKEW-1');
  graphRows = { meta: G.safeJSON(row?.meta), nodeData: G.safeJSON(get('SELECT data FROM canvas_nodes WHERE id = ?', 'N-SKEW-1')?.data) };
} finally {
  Date.now = realDateNow;
}
ok('④ 端到端：节点执行记录 meta.elapsedMs ≥ 0（Date.now 回拨下）',
  Number.isFinite(graphRows?.meta?.elapsedMs) && graphRows.meta.elapsedMs >= 0,
  `meta=${JSON.stringify(graphRows?.meta)}`);
ok('④ 端到端：节点状态回写的 lastDurationMs ≥ 0',
  Number.isFinite(graphRows?.nodeData?.lastDurationMs) && graphRows.nodeData.lastDurationMs >= 0,
  `lastDurationMs=${graphRows?.nodeData?.lastDurationMs}`);

// ============================================================================================
console.log('\n=== 5. 画布 DAG lastRun 指纹：回拨场景下不得取到旧 run ===');
// ============================================================================================
const fpOld = 'aaaaaaaaaaaaaaaa';
const fpNew = 'bbbbbbbbbbbbbbbb';
const runOld = G.recordRun({ canvasId: 'CV-FP', nodeId: 'N-FP-1', kind: 'image', status: 'done', file_path: 'data/stub/old.svg', input_fp: fpOld });
run('UPDATE canvas_node_runs SET created_at = ? WHERE id = ?', isoAt(0), runOld.id);   // 先执行的 run 拿到较晚的墙钟
const runNew = G.recordRun({ canvasId: 'CV-FP', nodeId: 'N-FP-1', kind: 'image', status: 'done', file_path: 'data/stub/new.svg', input_fp: fpNew });
run('UPDATE canvas_node_runs SET created_at = ? WHERE id = ?', isoAt(-SKEW), runNew.id);
const last = G.lastRun('N-FP-1');
ok('⑤ lastRun 取到「后插入」的那条 run（不是 created_at 更大的旧 run）', last?.id === runNew.id,
  `取到 ${last?.id}（期望 ${runNew.id}）；旧 run=${runOld.id} fp=${fpOld} / 新 run=${runNew.id} fp=${fpNew}`);
eq('⑤ lastRunAny 同口径', G.lastRunAny('N-FP-1')?.id, runNew.id);
eq('⑤ nodeRuns 历史按插入序新→旧', G.nodeRuns({ nodeId: 'N-FP-1' }).map((r) => r.id).join(','), [runNew.id, runOld.id].join(','));
// 指纹判定：取错 run 会「错误跳过」或「错误重跑」
eq('⑤ 输入未变（指纹=新 run 的）→ 跳过，不重复花钱', G.shouldSkip(last, fpNew), true);
eq('⑤ 输入已变（指纹=旧 run 的）→ 必须重跑', G.shouldSkip(last, fpOld), false);
eq('⑤（对照）旧的 created_at 口径会取到旧 run，于是指纹判定反过来 → 该跳的不跳 / 该跑的不跑',
  get('SELECT id FROM canvas_node_runs WHERE node_id = ? ORDER BY created_at DESC LIMIT 1', 'N-FP-1')?.id, runOld.id);
// 未来时间戳的旧 run 也骗不到
const runFuture = G.recordRun({ canvasId: 'CV-FP', nodeId: 'N-FP-2', kind: 'image', status: 'done', file_path: 'data/stub/future.svg', input_fp: fpOld });
run('UPDATE canvas_node_runs SET created_at = ? WHERE id = ?', isoAt(3600 * 1000), runFuture.id);
const runNewer = G.recordRun({ canvasId: 'CV-FP', nodeId: 'N-FP-2', kind: 'image', status: 'done', file_path: 'data/stub/newer.svg', input_fp: fpNew });
eq('⑤ 旧 run 带未来时间戳时，lastRun 仍取新插入的 run', G.lastRun('N-FP-2')?.id, runNewer.id);

// ============================================================================================
console.log('\n=== 6. 看板/报告里的数字永不为负（跨进程墙钟差值只能钳 0） ===');
// ============================================================================================
// 任务：一条正常（5s），一条 finished_at 比 created_at 早 12.4s（墙钟回拨造成的负数）
const mkJob = (id, createdAt, finishedAt) => run(
  `INSERT INTO jobs(id, type, title, status, progress, total, done, result, error, created_at, updated_at, finished_at)
   VALUES(?, 'skew-test', ?, 'done', 100, 1, 1, NULL, NULL, ?, ?, ?)`, id, id, createdAt, finishedAt, finishedAt);
mkJob('JOB-SKEW-OK', isoAt(-60 * 1000), isoAt(-55 * 1000));
mkJob('JOB-SKEW-NEG', isoAt(-60 * 1000), isoAt(-60 * 1000 - SKEW));
run(`INSERT INTO shot_renders(id, script_id, episode_id, shot_id, kind, file_path, mime, backend, status, meta, created_at)
     VALUES('RD-SKEW-OK','SC-CS','EP-CS','SH-CS-5','keyframe','data/images/ok.svg','image/svg+xml','placeholder','done',?,?)`,
  JSON.stringify({ elapsedMs: 1200 }), isoAt(-1000));
run(`INSERT INTO shot_renders(id, script_id, episode_id, shot_id, kind, file_path, mime, backend, status, meta, created_at)
     VALUES('RD-SKEW-NEG','SC-CS','EP-CS','SH-CS-6','keyframe','data/images/neg.svg','image/svg+xml','placeholder','done',?,?)`,
  JSON.stringify({ elapsedMs: -12349 }), isoAt(-2000));

const stats = ST.productionStats({ days: 7 });
const skewTask = stats.tasks.byType.find((t) => t.type === 'skew-test');
eq('⑥ 任务平均耗时只算非负样本（负数那条被剔除，5s 保留）', skewTask?.avgMs, 5000);
ok('⑥ 任务的 avg/p95/max 都不为负', skewTask && skewTask.avgMs >= 0 && skewTask.p95Ms >= 0 && skewTask.maxMs >= 0,
  `avg=${skewTask?.avgMs} p95=${skewTask?.p95Ms} max=${skewTask?.maxMs}`);
const kfRows = all("SELECT meta, created_at FROM shot_renders WHERE kind = 'keyframe' AND status = 'done' AND created_at >= ?", new Date(Date.now() - 7 * 86400000).toISOString());
const samples = kfRows.map((r) => { try { return Number(JSON.parse(r.meta || '{}').elapsedMs); } catch { return NaN; } }).filter((v) => Number.isFinite(v));
const nonNeg = samples.filter((v) => v >= 0);
const meanNonNeg = Math.round(nonNeg.reduce((a, b) => a + b, 0) / nonNeg.length);
const meanAll = Math.round(samples.reduce((a, b) => a + b, 0) / samples.length);
eq('⑥ 渲染延迟只按非负样本取均值（-12349 那条被剔除）', stats.renders.keyframe.avgMs, meanNonNeg);
ok('⑥ 若不剔除负数，均值会被拉到更低 → 证明剔除确实生效', meanAll < meanNonNeg,
  `非负样本均值=${meanNonNeg}ms，混入负数后=${meanAll}ms（样本 ${nonNeg.length} 正 + ${samples.length - nonNeg.length} 负）`);
ok('⑥ 渲染延迟统计永不为负', stats.renders.keyframe.avgMs >= 0 && stats.renders.keyframe.p95Ms >= 0,
  `avg=${stats.renders.keyframe.avgMs} p95=${stats.renders.keyframe.p95Ms}`);
const summaryText = ST.statsSummary(stats);
ok('⑥ 看板中文摘要里不出现负数耗时/负数吞吐',
  !/-\d+(\.\d+)?s/.test(summaryText) && !/-\d+(\.\d+)?\s*小时/.test(summaryText) && stats.throughput.remainingShots >= 0,
  summaryText.split('\n').filter((l) => /平均|吞吐/.test(l)).join(' ／ '));

// ============================================================================================
console.log('\n=== 7. 静态护栏：src 里不得再出现「按 created_at 判序」或「Date.now() 相减当耗时」 ===');
// ============================================================================================
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  if (e.isDirectory()) return walk(p);
  return e.name.endsWith('.js') && !e.name.includes('.bak') ? [p] : [];
});
const orderViolations = [];
const diffViolations = [];
const ALLOW_DIFF = [/Date\.now\(\) - days \* DAY/, /Date\.now\(\) - i \* DAY/];   // 日期窗口算术（真墙钟语义），不是耗时
for (const file of walk(SRC)) {
  const rel = path.relative(path.join(SRC, '..'), file);
  fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    const oi = line.lastIndexOf('ORDER BY');            // 只看 ORDER BY 子句本身（SELECT 列名里的 created_at 不算）
    if (oi >= 0 && /created_at/.test(line.slice(oi))) orderViolations.push(`${rel}:${i + 1} ${line.trim()}`);
    if (/Date\.now\(\)\s*-/.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line) && !ALLOW_DIFF.some((re) => re.test(line))) {
      diffViolations.push(`${rel}:${i + 1} ${line.trim()}`);
    }
  });
}
ok('⑦ src/** 里没有任何 SQL 再按 created_at 判序（取值点已全部改成 rowid）', orderViolations.length === 0,
  orderViolations.length ? orderViolations.slice(0, 6).join(' ｜ ') : '扫描 0 处违规');
ok('⑦ src/** 里没有任何「Date.now() 相减当耗时」（同进程耗时已全部改单调钟）', diffViolations.length === 0,
  diffViolations.length ? diffViolations.slice(0, 6).join(' ｜ ') : '扫描 0 处违规（仅 src/stats.js 的日期窗口算术白名单）');

// ============================================================================================
console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ }
process.exit(fail ? 1 : 0);
