// 规模压测：按产品文档承诺的上限造数据（角色 ≤200 / 单集 ≤200 镜 / 100 集 / 200 章），
// 验证各模块接口在满配规模下的**响应时间与正确性**，顺便抓 N+1 查询与漏索引。
// 用法：node tests/test-scale.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_TMP = path.join(os.tmpdir(), `factory-scale-data-${Date.now()}`);
const DB = path.join(os.tmpdir(), `factory-scale-${Date.now()}.db`);
const CFG = path.join(os.tmpdir(), `factory-scale-config-${Date.now()}.json`);
process.env.FACTORY_DATA_DIR = DATA_TMP;
process.env.FACTORY_DB = DB;
process.env.FACTORY_CONFIG = CFG;
fs.mkdirSync(DATA_TMP, { recursive: true });
fs.writeFileSync(CFG, JSON.stringify({ image: { backend: 'placeholder' }, video: { backend: 'placeholder' }, llm: { provider: 'mock' } }, null, 2));

const { migrate, run, get, all } = await import('../src/db.js');
const { createApp, createServer } = await import('../src/http.js');
const { registerMetaRoutes } = await import('../src/routes/meta.js');
const { registerActorRoutes } = await import('../src/routes/actors.js');
const { registerNovelRoutes } = await import('../src/routes/novel.js');
const { registerScriptRoutes } = await import('../src/routes/script.js');
const { registerRenderRoutes } = await import('../src/routes/render.js');
const { registerBridgeRoutes } = await import('../src/routes/bridge.js');

migrate();

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? `  ${extra}` : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? `  ${extra}` : ''}`); }
};
const need = (c, m) => { if (!c) throw new Error(m || '断言失败'); };

const SCALE = {
  actors: 200,          // 产品上限：角色规模 ≤200
  imagesPerActor: 1,    // 每人 1 张素材（真实场景会更多，这里控体量）
  episodes: 100,        // 产品上限：单季 100 集
  shotsPerEpisode: 200, // 产品上限：单集 ≤200 镜
  chapters: 200,        // 单次大纲规划上限 200 章
  canvasLinks: 200,     // 画布连线（不限量，取一个较大值）
  groups: 20,
  jobs: 300,
};

console.log(`\n▶ 规模压测：演员 ${SCALE.actors} / 集数 ${SCALE.episodes} / 单集镜头 ${SCALE.shotsPerEpisode} / 章节 ${SCALE.chapters}`);

// ---------------- 造数据（复用 scripts/seed-scale.js，避免两处维护） ----------------
const { seedScale } = await import('../scripts/seed-scale.js');
const seeded = seedScale({
  actors: SCALE.actors, imagesPerActor: SCALE.imagesPerActor, episodes: SCALE.episodes,
  shotsPerEpisode: SCALE.shotsPerEpisode, chapters: SCALE.chapters,
  canvasLinks: SCALE.canvasLinks, groups: SCALE.groups, jobs: SCALE.jobs,
}, { run, all, get });
const seedMs = seeded.ms;
const shotRows = seeded.shotRows, kfRows = seeded.kfRows, vidRows = seeded.videoRows;
const dbMB = (() => { try { return Math.round((fs.statSync(DB).size / 1048576) * 10) / 10; } catch { return 0; } })();
console.log(`  种子数据：镜头 ${shotRows} / 关键帧 ${kfRows} / 视频 ${vidRows}｜耗时 ${seedMs}ms｜库 ${dbMB}MB`);

// ---------------- 起服务（动态端口，避免与其它测试抢端口） ----------------
const { app, handle } = createApp();
registerMetaRoutes(app);
registerActorRoutes(app);
registerNovelRoutes(app);
registerScriptRoutes(app);
registerRenderRoutes(app);
registerBridgeRoutes(app);
const server = createServer((req, res) => handle(req, res, { staticMounts: [] }));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const tick = () => performance.now();
const timed = async (label, url, budgetMs) => {
  const t = tick();
  const res = await fetch(BASE + url);
  const json = await res.json().catch(() => null);
  const ms = Math.max(0, Math.round(tick() - t));   // 单调时钟，避免系统时钟跳变把耗时算成负数
  return { label, ms, budgetMs, json, ok: res.ok, within: ms <= budgetMs };
};
const line = (r, extra = '') => `${r.ms}ms / 预算 ${r.budgetMs}ms${extra ? ` · ${extra}` : ''}`;

console.log('\n【1】模块1：200 演员 + 200 卡位画布');
let r1 = await timed('GET /api/actors', '/api/actors', 1500);
ok('演员列表（200 人）在预算内返回', r1.within && r1.json.actors.length === SCALE.actors, line(r1, `${r1.json?.actors?.length} 人`));
let r2 = await timed('GET /api/canvas', '/api/canvas', 2000);
const cNodes = r2.json?.canvas?.nodes?.length || 0;
ok('画布（200 卡位 + 200 连线 + 20 分组）在预算内返回', r2.within && cNodes === SCALE.actors, line(r2, `${cNodes} 卡位 / ${r2.json?.canvas?.links?.length} 连线 / ${r2.json?.canvas?.groups?.length} 分组`));
let r2b = await timed('GET /api/canvas/groups', '/api/canvas/groups?canvas_id=CV-MAIN', 800);
ok('分组查询（20 组）在预算内', r2b.within && r2b.json.groups.length === SCALE.groups, line(r2b));
let r3 = await timed('GET /api/actors?q=演员1', '/api/actors?q=%E6%BC%94%E5%91%981', 1200);
ok('演员检索（模糊查询）在预算内且结果非空', r3.within && r3.json.actors.length > 0, line(r3, `${r3.json?.actors?.length} 条命中`));

console.log('\n【2】模块2：200 章小说');
let r4 = await timed('GET /api/novels/N-SCALE', '/api/novels/N-SCALE', 2500);
ok('小说详情（200 章骨架，不含正文）在预算内', r4.within && r4.json.chapters.length === SCALE.chapters, line(r4, `${r4.json?.chapters?.length} 章`));
let r5 = await timed('GET /api/novels/N-SCALE/chapters/199', '/api/novels/N-SCALE/chapters/199', 1200);
ok('单章正文读取在预算内', r5.within && r5.json.chapter.words > 0, line(r5, `${r5.json?.chapter?.words} 字`));
let r6 = await timed('GET /api/novels/N-SCALE/outline', '/api/novels/N-SCALE/outline', 2500);
ok('大纲读取（含全部章节列表）在预算内', r6.within, line(r6));

console.log('\n【3】模块3：100 集剧本');
let r7 = await timed('GET /api/scripts', '/api/scripts', 2000);
ok('剧本列表（含集数/镜头数统计子查询）在预算内', r7.within, line(r7, `集数 ${r7.json?.scripts?.[0]?.episode_count} / 镜头 ${r7.json?.scripts?.[0]?.shot_count}`));
let r8 = await timed('GET /api/scripts/SC-SCALE', '/api/scripts/SC-SCALE', 3000);
const epList = r8.json?.script?.episodes || r8.json?.episodes || r8.json?.script?.episode_list || [];
ok('剧本详情（100 集）在预算内', r8.within && epList.length === SCALE.episodes, line(r8, `${epList.length} 集`));

console.log('\n【4】模块4：200 镜/集 + 2000+ 渲染记录');
let r8b = await timed('GET /api/render/scripts', '/api/render/scripts', 1500);
ok('制作台剧本列表（100 集 + 2 万镜统计）在预算内', r8b.within, line(r8b));
let r9 = await timed('GET /api/render/episode', '/api/render/episode?scriptId=SC-SCALE&code=S01E001', 3000);
const bShots = r9.json?.shots?.length || 0;
ok('单集看板（200 镜 + 该集 300 条渲染记录）在预算内', r9.within && bShots === SCALE.shotsPerEpisode, line(r9, `${bShots} 镜 / 关键帧 ${r9.json?.stats?.keyframes} / 视频 ${r9.json?.stats?.videos}`));
ok('看板统计与库内一致', r9.json.stats.keyframes === SCALE.shotsPerEpisode && r9.json.stats.videos === SCALE.shotsPerEpisode / 2, JSON.stringify(r9.json.stats));
let r10 = await timed('GET /api/render/estimate', '/api/render/estimate?scriptId=SC-SCALE', 4000);
ok('整季工作量预估（100 集 × 200 镜）在预算内', r10.within && r10.json.totals.episodes === SCALE.episodes, line(r10, `待出关键帧 ${r10.json?.totals?.keyframes} / 待出视频 ${r10.json?.totals?.videos}`));
let r11 = await timed('GET /api/render/overview', '/api/render/overview', 2500);
ok('制作台总览（剧本统计 + 后端状态）在预算内', r11.within, line(r11));
let r12 = await timed('GET /api/render/shots/SH-SC-1-1/versions', '/api/render/shots/SH-SC-1-1/versions?kind=keyframe', 800);
ok('单镜版本列表在预算内', r12.within && r12.json.versions.length >= 1, line(r12));
let r13 = await timed('GET /api/render/films', '/api/render/films', 800);
ok('成片列表在预算内', r13.within, line(r13));

console.log('\n【5】画布资产桥 + 备份导出 + 任务列表');
let r14 = await timed('GET /api/canvas/CV-MAIN/asset-pack', '/api/canvas/CV-MAIN/asset-pack', 2500);
ok('资产包（200 演员 + 200 连线）在预算内', r14.within && r14.json.summary.actors === SCALE.actors, line(r14, `演员 ${r14.json?.summary?.actors} / 连线 ${r14.json?.summary?.links}`));
let r15 = await timed('GET /api/export', '/api/export', 6000);
const expShots = r15.json?.data?.shots?.length || 0;
ok('全量备份导出（3000 镜 + 200 演员 + 200 章）在预算内', r15.within && expShots > 0, line(r15, `${expShots} 镜 / ${r15.json?.data?.novel_chapters?.length} 章`));
let r16 = await timed('GET /api/jobs', '/api/jobs', 1200);
ok('任务列表在预算内且分页有上限（不会一次吐 300 条）',
   r16.within && (r16.json.jobs || []).length > 0 && (r16.json.jobs || []).length <= 200,
   line(r16, `返回 ${r16.json?.jobs?.length} 条 / 库内 ${SCALE.jobs} 条`));
let r17 = await timed('GET /api/guard/status', '/api/guard/status', 2500);
ok('守护状态（磁盘统计）在预算内', r17.within, line(r17, `${r17.json?.disk?.totalMB}MB`));

console.log('\n【6】聚合表现与正确性');
const times = [r1, r2, r2b, r3, r4, r5, r6, r7, r8, r8b, r9, r10, r11, r12, r13, r14, r15, r16, r17];
const slowest = times.reduce((a, b) => (b.ms > a.ms ? b : a));
const totalMs = times.reduce((n, x) => n + x.ms, 0);
ok('全部规模接口都在预算内', times.every((x) => x.within), `最慢 ${slowest.label} ${slowest.ms}ms`);
ok('没有出现 5xx（规模下无异常）', times.every((x) => x.ok), times.filter((x) => !x.ok).map((x) => x.label).join(',') || '全部 200');
ok('聚合耗时可控（18 个接口合计 < 20s）', totalMs < 20000, `合计 ${totalMs}ms`);
const idx = all("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name IN ('shots','shot_renders','canvas_nodes')").map((x) => x.name);
ok('关键表有索引（shots/shot_renders/canvas_nodes）', idx.length >= 3, idx.join(', '));

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
console.log(`（种子 ${seedMs}ms；18 个接口合计 ${totalMs}ms；最慢 ${slowest.label} ${slowest.ms}ms）`);
server.close();
try {
  fs.rmSync(DB, { force: true }); fs.rmSync(DB + '-wal', { force: true }); fs.rmSync(DB + '-shm', { force: true });
  fs.rmSync(DATA_TMP, { recursive: true, force: true }); fs.rmSync(CFG, { force: true });
} catch { /* ignore */ }
process.exit(fail ? 1 : 0);
