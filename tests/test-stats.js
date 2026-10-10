// 生产看板测试：任务耗时/失败率、渲染成功率与延迟、失败原因 Top、产出趋势、吞吐与剩余时间估算
// 全部离线：直接写入带已知时间戳的任务/渲染记录，断言聚合结果。
// 用法：node tests/test-stats.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_TMP = path.join(os.tmpdir(), `factory-stats-data-${Date.now()}`);
const DB = path.join(os.tmpdir(), `factory-stats-${Date.now()}.db`);
const CFG = path.join(os.tmpdir(), `factory-stats-config-${Date.now()}.json`);
process.env.FACTORY_DATA_DIR = DATA_TMP;
process.env.FACTORY_DB = DB;
process.env.FACTORY_CONFIG = CFG;
fs.mkdirSync(DATA_TMP, { recursive: true });
fs.writeFileSync(CFG, JSON.stringify({ image: { backend: 'generic-http' }, video: { backend: 'comfyui-h3' }, tts: { backend: 'none' } }, null, 2));

const { migrate, run, get, all } = await import('../src/db.js');
const { productionStats, statsSummary, progressSummary } = await import('../src/stats.js');

migrate();

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? `  ${extra}` : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? `  ${extra}` : ''}`); }
};

// 时间基准只取一次：若每次调用都读 Date.now()，同一任务的 created/finished 可能跨毫秒 →
// 期望 60s 的耗时偶尔算成 60001ms（负载高时必现）。固定基准后差值才是精确的。
const NOW_BASE = Date.now();
const iso = (msAgo) => new Date(NOW_BASE - msAgo).toISOString();
// 趋势分桶的期望值**由种子时间戳独立算出**（与 src/stats.js 的实现无关），
// 避免「今天/前天」这类断言依赖运行时刻（凌晨跑时 now-3h 会落进前一天，导致偶发失败）。
const seeded = [];        // {kind, backend, status, at}
const dayKeyOf = (isoStr) => String(isoStr).slice(0, 10);      // 与统计口径一致：UTC 日期
const expectByDay = (dayIso) => {
  const rows = seeded.filter((r) => dayKeyOf(r.at) === dayIso);
  const done = rows.filter((r) => r.status === 'done');
  return {
    videos: done.filter((r) => r.kind === 'video').length,
    keyframes: done.filter((r) => r.kind === 'keyframe').length,
    failed: rows.length - done.length,
    paid: done.filter((r) => r.backend && r.backend !== 'placeholder').length,
  };
};
const dayAgoKey = (n) => dayKeyOf(new Date(NOW_BASE - n * DAY).toISOString());
const DAY = 86400000;

console.log('\n【1】空数据不崩');
const empty = productionStats({ days: 7 });
ok('空库返回零值结构（不抛错）', empty.progress.shots === 0 && empty.tasks.total === 0 && empty.renders.video.total === 0, JSON.stringify(empty.progress));
ok('空库摘要仍可读', /进度：0 集/.test(statsSummary(empty)), statsSummary(empty).split('\n')[0]);

// ---------------- 造数据 ----------------
const now = iso(0);
run(`INSERT INTO scripts(id,novel_id,title,format,style_id,episode_seconds,episodes_per_season,seasons,status,created_at,updated_at)
     VALUES('SC-ST','N-ST','看板测试剧本','manju','cinematic-real',9,2,1,'storyboard',?,?)`, now, now);
for (let e = 1; e <= 2; e++) {
  run(`INSERT INTO script_episodes(id,script_id,season,episode,code,title,duration,status,created_at,updated_at)
       VALUES(?,?,1,?,?,?,9,'storyboard',?,?)`, `EP-ST-${e}`, 'SC-ST', e, `S01E00${e}`, `第${e}集`, now, now);
  for (let s = 1; s <= 5; s++) {
    const sid = `SH-ST-${e}-${s}`;
    run(`INSERT INTO shots(id,script_id,episode_id,idx,scene_no,shot_size,camera,move,transition,duration,action,dialogue,prompt_pos,prompt_neg,refs,cost_level,status,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?)`,
      sid, 'SC-ST', `EP-ST-${e}`, s, '1', '中景', '平视', '固定', '切', 3, '动作', s === 1 ? '台词' : '', 'p', 'n', '{}', 'M', now);
    // 视频成功（ep1 全部、ep2 前 2 镜）→ 用于进度与吞吐
    if (e === 1 || s <= 2) {
      const at = iso(e === 1 ? 10 * 60 * 1000 : 3 * 3600 * 1000);   // ep1 在 1 小时内（吞吐），ep2 更早
      seeded.push({ kind: 'video', backend: 'comfyui-h3', status: 'done', at });
      run(`INSERT INTO shot_renders(id,script_id,episode_id,shot_id,kind,file_path,mime,duration,backend,status,meta,created_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, `RD-ST-V-${e}-${s}`, 'SC-ST', `EP-ST-${e}`, sid, 'video',
        `data/videos/v_${e}_${s}.mp4`, 'video/mp4', 3, 'comfyui-h3', 'done', JSON.stringify({ elapsedMs: 48000 }), at);
    }
  }
}
// 关键帧：全部成功（前 2 天，用于趋势分桶）
for (let e = 1; e <= 2; e++) {
  for (let s = 1; s <= 5; s++) {
    run(`INSERT INTO shot_renders(id,script_id,episode_id,shot_id,kind,file_path,mime,backend,status,meta,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`, `RD-ST-K-${e}-${s}`, 'SC-ST', `EP-ST-${e}`, `SH-ST-${e}-${s}`, 'keyframe',
      `data/images/k_${e}_${s}.svg`, 'image/svg+xml', 'generic-http', 'done', JSON.stringify({ elapsedMs: 1200 }), iso(2 * DAY + 1000 * s));
    seeded.push({ kind: 'keyframe', backend: 'generic-http', status: 'done', at: iso(2 * DAY + 1000 * s) });
  }
}
// 失败：不同归类各一条（限流 / 鉴权 / 审核），验证错误 Top
const failures = [
  ['RD-ST-F1', 'rate', '[触发限流（429）] 出图接口 429: rate limit exceeded（已尝试 3 次）'],
  ['RD-ST-F2', 'rate', '[触发限流（429）] 出图接口 429: rate limit exceeded（已尝试 3 次）'],
  ['RD-ST-F3', 'auth', '[鉴权失败（Key 无效或未授权）] 出图接口 401: invalid api key'],
  ['RD-ST-F4', 'moderation', '[内容审核不通过] content policy violation'],
];
failures.forEach(([id, , msg], i) => {
  run(`INSERT INTO shot_renders(id,script_id,episode_id,shot_id,kind,backend,status,error,created_at)
       VALUES(?,?,?,?,?,?,?,?,?)`, id, 'SC-ST', 'EP-ST-2', `SH-ST-2-${(i % 5) + 1}`, 'keyframe', 'generic-http', 'error', msg, iso(3600 * 1000));
  seeded.push({ kind: 'keyframe', backend: 'generic-http', status: 'error', at: iso(3600 * 1000) });
});
// 成片 1 部
run(`INSERT INTO episode_films(id,script_id,episode_id,code,file_path,duration,size,shot_count,backend,status,created_at)
     VALUES('FILM-ST-1','SC-ST','EP-ST-1','S01E001','data/videos/final.mp4',15,1024,5,'ffmpeg','done',?)`, iso(60000));

// 任务：keyframe 3 成功 1 失败（耗时已知）、video 2 成功、pipeline 1 成功
const mkJob = (id, type, status, createdAgo, finishedAgo, error = null) => run(
  `INSERT INTO jobs(id,type,title,status,progress,total,done,payload,result,error,created_at,updated_at,finished_at)
   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  id, type, `任务 ${id}`, status, status === 'done' ? 100 : 50, 10, 5, '{}', '{}', error,
  iso(createdAgo), iso(finishedAgo), status === 'running' ? null : iso(finishedAgo));
mkJob('J-ST-1', 'keyframe', 'done', 600000, 540000);   // 60s
mkJob('J-ST-2', 'keyframe', 'done', 300000, 240000);   // 60s
mkJob('J-ST-3', 'keyframe', 'done', 200000, 170000);   // 30s
mkJob('J-ST-4', 'keyframe', 'error', 120000, 100000, '[额度/余额不足] 出图接口 500: 额度不足');
mkJob('J-ST-5', 'video', 'done', 900000, 300000);      // 600s
mkJob('J-ST-6', 'video', 'done', 800000, 200000);      // 600s
mkJob('J-ST-7', 'pipeline', 'done', 3600000, 3000000); // 600s
mkJob('J-ST-8', 'video', 'running', 60000, 60000);
mkJob('J-ST-9', 'keyframe', 'queued', 30000, 30000);

console.log('\n【2】进度聚合');
const st = productionStats({ days: 7, scriptId: 'SC-ST' });
const p = st.progress;
ok('镜头/关键帧/视频/成片计数正确', p.episodes === 2 && p.shots === 10 && p.keyframes === 10 && p.videos === 7 && p.films === 1, JSON.stringify(p));
ok('百分比按镜头数计算（关键帧 100% / 视频 70%）', p.keyframesPct === 100 && p.videosPct === 70 && p.filmsPct === 50, `${p.keyframesPct}/${p.videosPct}/${p.filmsPct}`);
ok('progressSummary 可单独调用（不传 scriptId 统计全库）', progressSummary().shots === 10, JSON.stringify(progressSummary().shots));

console.log('\n【3】任务耗时与失败率');
const kf = st.tasks.byType.find((t) => t.type === 'keyframe');
ok('任务按类型聚合（keyframe 5 条 / video 3 条 / pipeline 1 条）',
   kf.total === 5 && st.tasks.byType.find((t) => t.type === 'video').total === 3 && st.tasks.byType.find((t) => t.type === 'pipeline').total === 1,
   st.tasks.byType.map((t) => `${t.type}:${t.total}`).join(' '));
ok('成功/失败计数与成功率正确（keyframe 3 成功 1 失败 → 75%）', kf.done === 3 && kf.error === 1 && kf.successRate === 75, JSON.stringify({ done: kf.done, error: kf.error, rate: kf.successRate }));
ok('平均耗时只统计已结束任务（60/60/30/20 → 42.5s，排队任务不计入）', Math.abs(kf.avgMs - 42500) <= 1, `${kf.avgMs}ms`);
ok('P95 与最长耗时可用', kf.p95Ms === 60000 && kf.maxMs === 60000, `p95=${kf.p95Ms} max=${kf.maxMs}`);
ok('运行中/排队任务单独计数', st.tasks.running === 1 && st.tasks.queued === 1, `running=${st.tasks.running} queued=${st.tasks.queued}`);
ok('记住每类任务的最近一条错误', /额度/.test(kf.lastError || ''), String(kf.lastError).slice(0, 50));
ok('pipeline 长任务耗时统计正确（600s ±1ms）', Math.abs(st.tasks.byType.find((t) => t.type === 'pipeline').avgMs - 600000) <= 1, `${st.tasks.byType.find((t) => t.type === 'pipeline').avgMs}ms`);

console.log('\n【4】渲染成功率、延迟与后端分布');
const vs = st.renders.video;
ok('视频：成功 7 / 失败 0（成功率 100%）', vs.done === 7 && vs.error === 0 && vs.successRate === 100, JSON.stringify({ done: vs.done, error: vs.error }));
ok('视频：平均延迟取自 meta.elapsedMs（48s）', vs.avgMs === 48000, `${vs.avgMs}ms`);
const ks = st.renders.keyframe;
ok('关键帧：成功 10 / 失败 4（成功率 71.4%）', ks.done === 10 && ks.error === 4 && ks.successRate === 71.4, JSON.stringify({ done: ks.done, error: ks.error, rate: ks.successRate }));
ok('关键帧：按后端拆分（generic-http 10/14）', ks.byBackend.length === 1 && ks.byBackend[0].backend === 'generic-http' && ks.byBackend[0].done === 10 && ks.byBackend[0].error === 4, JSON.stringify(ks.byBackend));
ok('视频后端分布可见（comfyui-h3 7/7）', vs.byBackend[0].backend === 'comfyui-h3' && vs.byBackend[0].done === 7, JSON.stringify(vs.byBackend));

console.log('\n【5】失败原因 Top');
ok('错误按归类聚合（限流 2 / 鉴权 1 / 审核 1）', st.errors.length === 3 && st.errors[0].kind === 'rate' && st.errors[0].count === 2, st.errors.map((e) => `${e.kind}:${e.count}`).join(' '));
ok('每条错误带中文标签与样例', st.errors.every((e) => e.label && e.sample) && /限流/.test(st.errors[0].label), st.errors[0].label);
ok('错误统计去重到镜头数（限流影响 2 个镜头）', st.errors[0].shots === 2, `shots=${st.errors[0].shots}`);

console.log('\n【6】产出趋势与吞吐');
const expToday = expectByDay(dayAgoKey(0));
const expTwoAgo = expectByDay(dayAgoKey(2));
ok('近 7 天趋势按天分桶，且只统计成功产出（与种子时间戳独立算出的期望一致）',
   st.trend.length === 7
   && st.trend.at(-1).videos === expToday.videos && st.trend.at(-1).keyframes === expToday.keyframes
   && st.trend.at(-3).keyframes === expTwoAgo.keyframes,
   `今天期望 ${JSON.stringify(expToday)} 实际 ${JSON.stringify(st.trend.at(-1))} | 前天期望 keyframes=${expTwoAgo.keyframes} 实际 ${st.trend.at(-3).keyframes}`);
ok('趋势里前天有 10 个关键帧', st.trend.at(-3).keyframes === expTwoAgo.keyframes && st.trend.at(-3).keyframes === 10, JSON.stringify(st.trend.at(-3)));
ok('计费渲染数只算成功且非占位后端（与期望一致）',
   st.trend.at(-1).paidRenders === expToday.paid && st.trend.at(-3).paidRenders === expTwoAgo.paid,
   `今天 ${st.trend.at(-1).paidRenders}/${expToday.paid} · 前天 ${st.trend.at(-3).paidRenders}/${expTwoAgo.paid}`);
ok('失败单独计数（与期望一致，且不计入产出）', st.trend.at(-1).failed === expToday.failed, `failed=${st.trend.at(-1).failed} 期望=${expToday.failed}`);
ok('4 条失败记录全部出现在对应日期的分桶里（一条不丢）',
   st.trend.reduce((n, t) => n + t.failed, 0) === seeded.filter((r) => r.status === 'error').length,
   `趋势内失败合计=${st.trend.reduce((n, t) => n + t.failed, 0)} 种子失败=${seeded.filter((r) => r.status === 'error').length}`);
ok('吞吐：近 1 小时出片数正确（ep1 的 5 镜）', st.throughput.videosLast1h === 5, `${st.throughput.videosLast1h}`);
ok('剩余镜头数与 ETA 估算可用', st.throughput.remainingShots === 3 && st.throughput.etaHours > 0 && st.throughput.etaHours < 5, `剩余 ${st.throughput.remainingShots} 镜 / ETA ${st.throughput.etaHours}h`);
ok('后端配置反映在看板里', st.backend.image === 'generic-http' && st.backend.video === 'comfyui-h3' && st.backend.tts === 'none', JSON.stringify(st.backend));

console.log('\n【7】摘要文本');
const sum = statsSummary(st);
ok('摘要含进度/任务/渲染/失败原因/吞吐/用量六段', /进度：/.test(sum) && /任务（近 7 天）/.test(sum) && /关键帧：成功/.test(sum) && /失败原因 Top/.test(sum) && /吞吐：/.test(sum) && /本月用量/.test(sum), sum.split('\n').length + ' 行');
ok('摘要里能直接看到失败归类与次数', /限流/.test(sum) && /2 次/.test(sum), sum.split('\n').filter((l) => /限流/.test(l))[0]?.slice(0, 70));

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
try {
  for (const f of [DB, DB + '-wal', DB + '-shm', CFG]) fs.rmSync(f, { force: true });
  fs.rmSync(DATA_TMP, { recursive: true, force: true });
} catch { /* ignore */ }
process.exit(fail ? 1 : 0);
