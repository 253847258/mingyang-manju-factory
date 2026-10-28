// AI漫剧-电影视频工厂 · 零依赖服务入口
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp, createServer } from './src/http.js';
import { migrate, DATA_DIR, ROOT } from './src/db.js';
import { recoverStaleJobs } from './src/jobs.js';
import { cleanupIntermediates } from './src/modules/render.js';
import { loadConfig } from './src/config.js';
import { registerMetaRoutes } from './src/routes/meta.js';
import { registerActorRoutes } from './src/routes/actors.js';
import { registerRenderRoutes } from './src/routes/render.js';
import { registerBridgeRoutes } from './src/routes/bridge.js';
import { planGraph, createGraphRunJob, runSingleNode, nodeRuns, graphStatus } from './src/graph.js';
import { badRequest } from './src/http.js';
import { llmStatus } from './src/llm.js';
import { imageBackendStatus } from './src/image.js';
import { registerMcpRoutes } from './src/mcp-server.js';
import { ensureMcpSchema } from './src/mcp-tools.js';
import { ensureStudioSchema } from './src/studio.js';
import { registerStudioRoutes } from './src/routes/studio.js';
import { registerSchedulesRoutes } from './src/routes/schedules.js';
import { registerNovelAdaptRoutes } from './src/routes/novel-adapt.js';
import { guardRestoredBackup } from './src/restore-guard.js';
import { registerDurationRoutes } from './src/routes/duration.js';
import { registerEditRoutes } from './src/routes/edit.js';
import { registerGateRoutes } from './src/routes/gates.js';
import { isGatedPath, checkScriptGate, checkContractGate, checkAnchorGate, replayRequest } from './src/gate-middleware.js';
import { ensureEditSchema } from './src/edit-timeline.js';
import { registerNovelAiRoutes } from './src/routes/novel-ai.js';
import { registerScriptingRoutes } from './src/routes/scripting.js';
import { registerCanvasEnhanceRoutes } from './src/routes/canvas-enhance.js';
import { registerAssetRoutes } from './src/routes/assets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, 'web');

// 自带工具优先：把 bin/ffmpeg 放进当前进程的 PATH（不改系统环境变量）。
// 目标是「解压即用」：即使系统没有安装 ffmpeg，本地占位视频、整集成片和质检也能跑。
const BUNDLED_FFMPEG_DIR = path.join(__dirname, 'bin', 'ffmpeg');
const BUNDLED_FFMPEG_BIN = path.join(BUNDLED_FFMPEG_DIR, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const BUNDLED_FFPROBE_BIN = path.join(BUNDLED_FFMPEG_DIR, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
let bundledFfmpegEnabled = false;
if (fs.existsSync(BUNDLED_FFMPEG_BIN)) {
  const currentPath = process.env.PATH || '';
  const pathParts = currentPath.split(path.delimiter);
  if (!pathParts.includes(BUNDLED_FFMPEG_DIR)) {
    process.env.PATH = `${BUNDLED_FFMPEG_DIR}${path.delimiter}${currentPath}`;
  }
  bundledFfmpegEnabled = true;
  console.log(`[boot] 已启用自带 ffmpeg：${BUNDLED_FFMPEG_DIR}`);
}

migrate();
const restoreGuard = guardRestoredBackup();
if (restoreGuard.triggered) {
  console.warn(`[boot] 恢复启动闸门：已取消 ${restoreGuard.productions} 个历史制片、${restoreGuard.stages} 个未完成阶段，并暂停任务队列；确认无误后在顶栏点“恢复队列”`);
}
ensureMcpSchema();      // P4：画布计划 / 审批审计表（幂等）
ensureStudioSchema();   // 自动化制片：制片项目与阶段流水线表（幂等）

// 启动自愈：上次进程被杀留下的 running/queued 任务标记为中断；顺带清理封装中间产物
const recovered = recoverStaleJobs();
if (recovered.recovered) console.log(`[boot] 已清理 ${recovered.recovered} 个中断任务`);
try {
  const cleaned = cleanupIntermediates();
  if (cleaned.removed) console.log(`[boot] 已清理封装中间产物 ${cleaned.removed} 个（释放 ${cleaned.freedMB} MB）`);
} catch (e) { console.warn('[boot] 中间产物清理跳过：', e.message); }

const cfg = loadConfig();
const { app, handle } = createApp();

registerMetaRoutes(app);
registerActorRoutes(app);
registerRenderRoutes(app);
registerBridgeRoutes(app);

// 模块5 画布 DAG 执行引擎（P3）：dry-run 计划 / 整图执行 / 单节点重跑 / 执行历史 / 状态汇总
app.post('/api/canvas/plan', async (ctx) => {
  try { ctx.json({ ok: true, plan: planGraph((await ctx.body()) || {}) }); }
  catch (e) { throw badRequest(e.message); }
});
app.post('/api/canvas/run', async (ctx) => {
  try { ctx.json({ ok: true, ...createGraphRunJob((await ctx.body()) || {}) }); }
  catch (e) { throw badRequest(e.message); }
});
app.post('/api/canvas/run-node', async (ctx) => {
  try { ctx.json({ ok: true, ...runSingleNode((await ctx.body()) || {}) }); }
  catch (e) { throw badRequest(e.message); }
});
app.get('/api/canvas/node-runs', async (ctx) => ctx.json({ ok: true, runs: nodeRuns({ nodeId: ctx.query.node_id || null, canvasId: ctx.query.canvas_id || null, limit: Number(ctx.query.limit) || 50 }) }));
app.get('/api/graph/status', async (ctx) => ctx.json({ ok: true, ...graphStatus(ctx.query.canvas_id || 'CV-MAIN') }));

registerMcpRoutes(app);   // P4：人类审批入口 + Agent HTTP 桥（/api/canvas/plans*、/api/mcp/*）
registerStudioRoutes(app);   // 自动化制片 Agent：/api/studio/productions*
registerNovelAdaptRoutes(app);   // 小说改编工作台：上传小说 → 剧本/角色/场景/道具/提示词/资产清单
registerNovelAiRoutes(app);      // 小说工坊：故事框架 AI 自动填写 + 角色卡提交
registerScriptingRoutes(app);    // 剧本工厂增强：物化/引用体检/提示词体检/快照/预估/FDX+HTML
registerCanvasEnhanceRoutes(app); // 画布增强：九宫格 / 描述自动改进 / 一致性闸门 / 专业提示词
registerAssetRoutes(app);         // V2 资产层：资产/版本/快照/血缘/成本 + 生产订单
registerDurationRoutes(app);     // 成片时长对账：目标时长 vs ffprobe 实际时长
try { ensureEditSchema(); registerEditRoutes(app); } catch (e) { console.warn('[boot] 后期精修模块未就绪：', e.message); }  // 后期精修：多轨轻剪 / 审片打点 / 版本溯源
registerGateRoutes(app);  // 生产闸门：剧本硬门禁 / 镜头契约 / 强制继续审计
// 定时排产（§10.1）：注册的同时托管 tick 定时器（.unref() 不阻塞退出）。
// 必须排在 recoverStaleJobs()（第 31 行）之后：否则重启瞬间会把上一次被标记为中断的任务当成「上一轮还在跑」（S-07）。
registerSchedulesRoutes(app);

// 模块2 / 模块3 路由（缺失时降级为 501，保证服务可启动）
async function tryRegister(relPath, exportName, label) {
  const abs = path.join(__dirname, relPath);
  if (!fs.existsSync(abs)) {
    console.warn(`[boot] ${label} 未就绪（缺少 ${relPath}）`);
    return false;
  }
  try {
    const mod = await import(new URL(relPath, import.meta.url).href);
    if (typeof mod[exportName] !== 'function') {
      console.warn(`[boot] ${label} 未导出 ${exportName}`);
      return false;
    }
    mod[exportName](app);
    console.log(`[boot] ${label} 已挂载`);
    return true;
  } catch (err) {
    console.error(`[boot] ${label} 挂载失败：`, err.message);
    return false;
  }
}

const mod2 = await tryRegister('./src/routes/novel.js', 'registerNovelRoutes', '模块2 小说工坊');
const mod3 = await tryRegister('./src/routes/script.js', 'registerScriptRoutes', '模块3 剧本工厂');

for (const [p, label, exportName] of [['./src/routes/novel.js', '模块2', 'registerNovelRoutes'], ['./src/routes/script.js', '模块3', 'registerScriptRoutes']]) {
  if (p.includes('novel') && !mod2) stubModule(app, '/api/novels', label);
  if (p.includes('script') && !mod3) stubModule(app, '/api/scripts', label);
}

function stubModule(app, prefix, label) {
  const handler = async (ctx) => ctx.json({ ok: false, error: `${label} 尚未安装（缺少 ${prefix} 路由实现）` }, 501);
  app.get(prefix, handler); app.post(prefix, handler); app.get(`${prefix}/:id`, handler);
}

const staticOpts = {
  staticMounts: [
    { prefix: '/data', dir: DATA_DIR, cache: 'public, max-age=30' },
    { prefix: '/', dir: WEB_DIR, index: '/index.html', spa: true, cache: 'no-cache' },
  ],
};

// 后端请求级闸门：渲染类 POST 在进入混淆层路由前先查剧本审核。
// 未通过 → 409（带中文说明）；带 force:true → 放行并写审计。
const server = createServer((req, res) => {
  if (req.method === 'POST' && isGatedPath(req.url)) {
    // createServer 要求 handler 返回 Promise（内部会 .catch），这里必须显式包装
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('error', reject);
      req.on('end', () => {
        const buf = Buffer.concat(chunks);
        let body = {};
        try { body = JSON.parse(buf.toString('utf8') || '{}'); } catch { /* 交给原路由报参数错 */ }
        const gate = checkScriptGate({
          scriptId: body.scriptId || body.script_id,
          code: body.code,
          force: body.force === true,
          operator: body.operator || '未署名',
          reason: body.reason || '',
        });
        if (!gate.ok) {
          res.writeHead(409, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, gate: 'script-lock', status: gate.status, error: gate.message }));
          resolve();
          return;
        }
        const contractMode = String(cfg.gates?.contractMode || 'warn');
        const cgate = checkContractGate({
          scriptId: body.scriptId || body.script_id,
          code: body.code,
          mode: contractMode,
          ack: body.ackContract === true || body.force === true,
        });
        if (!cgate.ok) {
          res.writeHead(409, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, gate: 'shot-contract', mode: cgate.mode, error: cgate.message || '镜头契约不达标', issues: cgate.issues, summary: cgate.summary }));
          resolve();
          return;
        }
        const anchorMode = String(cfg.gates?.anchorMode || 'warn');
        const agate = checkAnchorGate({
          scriptId: body.scriptId || body.script_id,
          code: body.code,
          shotIds: body.shotIds || null,
          path: req.url,
          mode: anchorMode,
        });
        if (!agate.ok) {
          res.writeHead(409, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, gate: 'anchor', mode: agate.mode, error: agate.message }));
          resolve();
          return;
        }
        Promise.resolve(handle(replayRequest(req, buf), res, staticOpts)).then(resolve, reject);
      });
    });
  }
  return handle(req, res, staticOpts);
});

const PORT = Number(process.env.PORT || cfg.server.port || 8788);
const HOST = process.env.HOST || cfg.server.host || '127.0.0.1';

server.listen(PORT, HOST, () => {
  const l = llmStatus();
  const i = imageBackendStatus();
  console.log('==========================================================');
  console.log('  AI漫剧-电影视频工厂 已启动');
  console.log(`  界面： http://${HOST}:${PORT}/`);
  console.log(`  数据： ${DATA_DIR}`);
  console.log(`  LLM ： ${l.provider} / ${l.model} ${l.hasKey ? '（Key 已配置）' : '（未配置 Key → 可在设置页填写或切 mock）'}`);
  console.log(`  出图： ${i.backend} ${i.ready ? '（就绪）' : '（未就绪，请到设置页配置）'}`);
  console.log(`  工具： ${bundledFfmpegEnabled ? `自带 ffmpeg ✅${fs.existsSync(BUNDLED_FFPROBE_BIN) ? ' / ffprobe ✅' : ' / ffprobe ⚠'}` : '系统 ffmpeg（未检测到自带版本）'}`);
  console.log(`  模块： 模块1 演员宫格 ✅ ｜ 模块2 小说 ${mod2 ? '✅' : '⏳'} ｜ 模块3 剧本 ${mod3 ? '✅' : '⏳'} ｜ 模块4 制作台 ✅`);
  console.log('==========================================================');
  // 付费闸门残留自检（2026-10-03 事故换来的检查）：
  // 自检/审计脚本会在跑之前把出图后端临时切成 placeholder、跑完切回，并把「跑之前的配置」另存成
  // config/config.json.before-paid-gate。若那个快照**还在**，说明上一次没正常收尾（被 SIGKILL、整机异常、
  // 或有人手改），服务端可能被永久留在 placeholder —— 用户出图会拿到占位 SVG 却毫不知情。
  // 这里只在启动横幅里**明确告警 + 给出恢复命令**，绝不自动改配置（避免在用户不知情时切到付费后端）。
  try {
    const gateSnap = path.join(ROOT, 'config', 'config.json.before-paid-gate');
    if (fs.existsSync(gateSnap) && i.backend === 'placeholder') {
      const st = fs.statSync(gateSnap);
      console.log('  ⚠  检测到「测试付费闸门」残留快照：config/config.json.before-paid-gate');
      console.log(`     （保存于 ${st.mtime.toISOString()}）当前出图后端是 placeholder —— 上一次自检/审计可能被强杀，`);
      console.log('     真实出图配置被留在占位状态。恢复：node scripts/restore-backends.js  或到设置页把出图后端切回。');
    }
  } catch { /* 自检失败不影响启动 */ }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[boot] 端口 ${PORT} 已被占用，请用 PORT=xxxx node server.js 换端口启动`);
  } else console.error('[boot] 服务启动失败：', err);
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { console.log(`\n[shutdown] 收到 ${sig}，正在关闭…`); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500); });
}
