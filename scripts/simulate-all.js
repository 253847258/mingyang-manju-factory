#!/usr/bin/env node
/**
 * 全模块功能模拟（端到端 · 离线零成本）
 *
 * 覆盖：引擎/基础设施 → 模块1 演员矩阵+无限画布 → 模块2 小说工坊 → 模块3 剧本工厂
 *       → 模块4 制作台（关键帧/视频/整集/包装/流水线）→ 画布资产桥 → 导出备份
 *
 * 特点：
 *   · 全程离线：LLM = mock（可选 SIM_REAL_LLM=1 走真实模型 2 次）、出图 = placeholder、视频 = 本地 ffmpeg 运镜
 *   · 临时库 + 临时数据目录，不碰 data/ 里的正式数据
 *   · 每一步都做真实断言（落库 / 落盘 / ffprobe / 返回结构），失败即中文原因
 *   · 结束后自动写出报告：docs/全模块功能模拟测试报告.md
 *
 * 用法：
 *   node scripts/simulate-all.js                # 默认端口 8898
 *   SIM_PORT=8899 node scripts/simulate-all.js
 *   SIM_REAL_LLM=1 node scripts/simulate-all.js # 额外验证真实 LLM 通路（会产生少量模型调用）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const STARTED = new Date();
const TAG = STARTED.toISOString().replace(/[-:T]/g, '').slice(0, 14);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-all-'));
const PORT = Number(process.env.SIM_PORT || 8898);
const REAL_LLM = process.env.SIM_REAL_LLM === '1';
const IMAGE_BACKEND = process.env.SIM_IMAGE_BACKEND || 'placeholder';
const IMAGE_URL = process.env.SIM_IMAGE_URL || 'http://127.0.0.1:8790/generate';
let BASE = `http://127.0.0.1:${PORT}`;

process.env.FACTORY_DB = path.join(TMP, 'sim.db');
process.env.FACTORY_DATA_DIR = path.join(TMP, 'data');
process.env.FACTORY_CONFIG = path.join(TMP, 'config.json');
const DATA_DIR = process.env.FACTORY_DATA_DIR;
fs.mkdirSync(DATA_DIR, { recursive: true });
const imageConfig = IMAGE_BACKEND === 'generic-http'
  ? {
      backend: 'generic-http',
      useCanvasRefs: true,
      generic: {
        url: IMAGE_URL,
        method: 'POST',
        headers: '{"Content-Type":"application/json"}',
        bodyTemplate: '{"prompt":"{{prompt}}","negative":"{{negative}}","width":{{width}},"height":{{height}},"model":"{{model}}","apiKey":"{{apiKey}}"}',
        refBodyTemplate: '{"prompt":"{{prompt}}","negative":"{{negative}}","width":{{width}},"height":{{height}},"model":"{{model}}","apiKey":"{{apiKey}}","image":"{{refImage}}"}',
        responseImagePath: 'image',
        apiKey: '',
        authHeader: '',
        authPrefix: '',
      },
    }
  : { backend: 'placeholder', useCanvasRefs: true };
fs.writeFileSync(process.env.FACTORY_CONFIG, JSON.stringify({
  llm: { provider: REAL_LLM ? 'deepseek' : 'mock', temperature: 0.8, timeoutMs: 300000 },
  image: imageConfig,
  video: { backend: 'placeholder' },
  tts: { backend: 'none' },
  server: { port: PORT },
}, null, 2));

// ---------------- 迷你断言/记录框架 ----------------
const RESULTS = [];
const ARTIFACTS = [];
let pass = 0, fail = 0;
let CURRENT_MOD = '基础';
const MODULES = [];

function need(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
function mod(name) { CURRENT_MOD = name; MODULES.push(name); console.log(`\n${'═'.repeat(4)} ${name} ${'═'.repeat(4)}`); }
async function step(feature, fn) {
  const t0 = Date.now();
  try {
    const ev = await fn();
    pass++;
    RESULTS.push({ mod: CURRENT_MOD, feature, ok: true, ev: ev === undefined ? '' : String(ev), ms: Date.now() - t0 });
    console.log(`  ✅ ${feature}${ev ? ` — ${ev}` : ''}`);
  } catch (e) {
    fail++;
    RESULTS.push({ mod: CURRENT_MOD, feature, ok: false, ev: String(e?.message || e), ms: Date.now() - t0 });
    console.log(`  ❌ ${feature} — ${e?.message || e}`);
  }
}
function art(kind, rel, note = '') { ARTIFACTS.push({ kind, rel, note }); }

// ---------------- HTTP 工具 ----------------
async function api(method, url, body, raw = false) {
  const res = await fetch(BASE + url, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (raw) return { status: res.status, text, headers: res.headers };
  let json = null;
  try { json = JSON.parse(text); } catch { /* 附件下载等非 JSON */ }
  return { status: res.status, json, text, headers: res.headers };
}
const GET = (u, raw) => api('GET', u, undefined, raw);
const POST = (u, b) => api('POST', u, b);
const PUT = (u, b) => api('PUT', u, b);
const DEL = (u) => api('DELETE', u);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fileAbs = (rel) => (path.isAbsolute(rel) ? rel : path.join(ROOT, rel));
const exists = (rel) => fs.existsSync(fileAbs(rel));
const size = (rel) => (exists(rel) ? fs.statSync(fileAbs(rel)).size : 0);

async function waitJob(jobId, timeoutMs = 300000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const j = (await GET(`/api/jobs/${jobId}`)).json?.job;
    if (j && ['done', 'error', 'canceled'].includes(j.status)) return j;
    await sleep(250);
  }
  throw new Error(`任务 ${jobId} 超时（${timeoutMs}ms）`);
}
function ffprobe(rel) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', fileAbs(rel)], { encoding: 'utf8' });
  try { return JSON.parse(r.stdout || '{}'); } catch { return {}; }
}
const uploadFile = async (field, filename, content, mime = 'text/plain') => {
  const fd = new FormData();
  fd.append(field, new Blob([content], { type: mime }), filename);
  const res = await fetch(`${BASE}/api/upload`, { method: 'POST', body: fd });
  return { status: res.status, json: await res.json().catch(() => null) };
};

// ---------------- 启动应用（全模块路由，临时库） ----------------
const { migrate, closeDb } = await import('../src/db.js');
const { createApp, createServer } = await import('../src/http.js');
const { registerMetaRoutes } = await import('../src/routes/meta.js');
const { registerActorRoutes } = await import('../src/routes/actors.js');
const { registerNovelRoutes } = await import('../src/routes/novel.js');
const { registerScriptRoutes } = await import('../src/routes/script.js');
const { registerRenderRoutes } = await import('../src/routes/render.js');
const { registerBridgeRoutes } = await import('../src/routes/bridge.js');
const { recoverStaleJobs } = await import('../src/jobs.js');
const db = await import('../src/db.js');

migrate();
const { app, handle } = createApp();
registerMetaRoutes(app);
registerActorRoutes(app);
registerNovelRoutes(app);
registerScriptRoutes(app);
registerRenderRoutes(app);
registerBridgeRoutes(app);
const server = createServer((req, res) => handle(req, res, { staticMounts: [] }));
// 端口被占用时自动改用临时端口，避免上一次残留进程把模拟卡死
await new Promise((resolve, reject) => {
  const onErr = (e) => {
    if (e.code === 'EADDRINUSE') {
      console.warn(`[sim] 端口 ${PORT} 被占用，改用系统分配的临时端口`);
      server.listen(0, '127.0.0.1', resolve);
    } else reject(e);
  };
  server.once('error', onErr);
  server.listen(PORT, '127.0.0.1', resolve);
});
BASE = `http://127.0.0.1:${server.address().port}`;

console.log(`\n▶ 全模块功能模拟启动：${BASE}`);
console.log(`  临时库：${process.env.FACTORY_DB}`);
console.log(`  临时数据目录：${DATA_DIR}`);
console.log(`  LLM：${REAL_LLM ? 'deepseek（真实调用 2 次）' : 'mock（离线，零成本）'}｜出图：${IMAGE_BACKEND}${IMAGE_BACKEND === 'generic-http' ? `（${IMAGE_URL}）` : ''}｜视频：本地 ffmpeg 运镜`);

// 共享上下文
const C = { actors: [], canvas: 'CV-MAIN', novel: null, script: null, episode: 'S01E001', filmDeleted: null, refDoc: null };

// ════════════════════════════════════════════════════════════════
mod('0 · 引擎与基础设施');
// ════════════════════════════════════════════════════════════════
await step('健康检查：服务/LLM/出图/任务队列/计数结构完整', async () => {
  const r = await GET('/api/health');
  need(r.status === 200 && r.json.ok, `状态码 ${r.status}`);
  const h = r.json;
  need(h.llm && typeof h.llm.ready === 'boolean', '缺 llm 状态块');
  need(h.image && h.image.backend, '缺 image 状态块');
  need(h.jobs && typeof h.jobs === 'object', '缺 jobs 队列状态块');
  need(h.counts && 'actors' in h.counts, '缺 counts');
  return `LLM=${h.llm.provider}/${h.llm.ready ? '就绪' : '未就绪'} 出图=${h.image.backend} 队列=${JSON.stringify(h.jobs)}`;
});
await step('元数据：题材 100 / 画风 10 / 字典齐备', async () => {
  const m = (await GET('/api/meta')).json;
  need(m.ok && m.genres.length === 100, `题材 ${m.genres?.length}`);
  need(m.styles.length === 10, `画风 ${m.styles?.length}`);
  need(m.outlineSections.length >= 13, `大纲分节 ${m.outlineSections?.length}`);
  need(m.genders?.length && m.races?.length && m.bodyTypes?.length && m.ratios?.length, '人物字典缺项');
  need(m.shotSizes?.length >= 10 && m.cameraMoves?.length >= 10, '镜头语法字典缺项');
  return `题材 ${m.genres.length} / 画风 ${m.styles.length} / 大纲分节 ${m.outlineSections.length} / 镜头语法 ${m.shotSizes.length}×${m.cameraMoves.length}`;
});
await step('出图分类清单：9 类镜头（脸部特写/多角度/表情/头部/姿态/手势/服饰…）', async () => {
  const k = (await GET('/api/kinds')).json;
  need(k.ok && k.kinds.length >= 9, `分类 ${k.kinds?.length}`);
  const labels = k.kinds.map((x) => x.label).join('|');
  for (const want of ['脸部大图特写', '多角度', '多表情', '头部多角度', '姿态', '服饰']) {
    need(labels.includes(want), `缺少分类「${want}」（现有：${labels}）`);
  }
  need(k.kinds.every((x) => x.variants.length >= 1), '存在无变体的分类');
  const all = k.kinds.reduce((n, x) => n + x.variants.length, 0);
  return `${k.kinds.length} 类 / ${all} 个变体`;
});
await step('随机生成参数：seed/风格/比例/光线等可取', async () => {
  const r = (await GET('/api/prompt/random-params')).json;
  need(r.ok, '接口未返回 ok');
  const keys = Object.keys(r.params || r.random || {});
  need(keys.length >= 2, `随机参数过少：${keys.join(',')}`);
  return `${keys.length} 项：${keys.slice(0, 6).join(', ')}`;
});
await step('设置读写：掩码回显 + 白名单更新 + 非法键被忽略', async () => {
  const before = (await GET('/api/settings')).json;
  need(before.ok && before.settings.llm && before.image, '设置结构异常');
  const upd = await PUT('/api/settings', { video: { concurrency: 2 }, 不存在的键: 1 });
  need(upd.json.ok && upd.json.settings.video.concurrency === 2, '更新未生效');
  need(upd.json.settings['不存在的键'] === undefined, '非法键被写入');
  await PUT('/api/settings', { video: { concurrency: 1 } });
  return `视频并发 ${upd.json.settings.video.concurrency}（已还原 1），非法键被白名单忽略`;
});
await step('出图后端自检（placeholder 就绪）', async () => {
  const r = await POST('/api/settings/test-image', { backend: 'placeholder' });
  need(r.json.ok === true && r.json.ready !== false, JSON.stringify(r.json).slice(0, 120));
  return r.json.detail || r.json.note || 'placeholder 可用';
});
await step('上传参考文档 + 回读文本（模块2/3 参考文献通路）', async () => {
  const content = '【模拟参考范本】\n第一章：主角在雨夜失去一切。\n节奏：前三章每章一个钩子，反派第 3 章登场。\n';
  const up = await uploadFile('file', 'sim-ref.txt', content);
  need(up.status === 200 && up.json.ok, `上传失败 ${up.status}`);
  const rel = up.json.files?.[0]?.path || up.json.path || up.json.file_path;
  need(rel && exists(rel), `返回路径不可用：${JSON.stringify(up.json).slice(0, 120)}`);
  const read = (await GET(`/api/upload/text?path=${encodeURIComponent(rel)}`)).json;
  need(read.ok && String(read.text || '').includes('模拟参考范本'), `回读内容不符：${JSON.stringify(read).slice(0, 140)}`);
  C.refDoc = rel;
  return `${rel}（${size(rel)} 字节）`;
});
await step('全量 JSON 备份导出：包含各模块表', async () => {
  const r = await GET('/api/export');
  need(r.json?.ok && r.json.data, '导出结构异常');
  const keys = Object.keys(r.json.data);
  need(keys.length >= 4, `备份表过少：${keys.join(',')}`);
  return `${keys.length} 张表：${keys.slice(0, 8).join(', ')}`;
});
await step('非法输入保护：未知路由 404 JSON / 非法 JSON body 400', async () => {
  const nf = await GET('/api/不存在的接口');
  need(nf.status === 404 && nf.json && nf.json.ok === false, `未知路由返回 ${nf.status}`);
  const res = await fetch(`${BASE}/api/actors`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{坏 JSON' });
  need(res.status >= 400, `坏 body 返回 ${res.status}`);
  return `未知路由 ${nf.status} / 坏 JSON ${res.status}`;
});
await step('任务自愈：僵尸 running 任务在重启后被标记中断', async () => {
  const now = new Date().toISOString();
  db.run(`INSERT INTO jobs(id,type,title,status,progress,total,done,payload,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?)`, 'JOB-zombie-sim', 'image', '卡住的占位任务（模拟）', 'running', 42, 1, 0, '{}', now, now);
  const r = recoverStaleJobs();
  const row = db.get('SELECT status,error,finished_at FROM jobs WHERE id=?', 'JOB-zombie-sim');
  need(r.recovered >= 1 && (r.ids || []).includes('JOB-zombie-sim'), JSON.stringify(r));
  need(row.status === 'error' && /中断/.test(row.error || '') && row.finished_at, JSON.stringify(row));
  return `回收 ${r.recovered} 个僵尸任务 → ${row.status}「${row.error}」`;
});

// ════════════════════════════════════════════════════════════════
mod('1 · 模块1 演员矩阵（档案 / 提示词 / 定妆图 / 矩阵画布）');
// ════════════════════════════════════════════════════════════════
await step('创建 3 位演员（性别/种族/身高/体型/风格/角色类型全字段）', async () => {
  const specs = [
    { name: '沈砚', gender: 'male', age: 29, race: 'asian-east', height_cm: 186, body_type: 'athletic', hair_style: 'undercut', hair_color: 'black', eyes: 'grey', style_id: 'cinematic-real', role_type: '男主', personality: '沉默寡言，外冷内热', background: '雾港警局前探员' },
    { name: '林昭', gender: 'female', age: 24, race: 'asian-east', height_cm: 168, body_type: 'slim', hair_style: 'long-straight', hair_color: 'dark-brown', eyes: 'amber', style_id: 'cn-guofeng', role_type: '女主', personality: '机敏果决', background: '钟表匠之女，擅长机械' },
    { name: '顾岑', gender: 'male', age: 52, race: 'asian-east', height_cm: 174, body_type: 'heavy', hair_style: 'bald', hair_color: 'grey', eyes: 'brown', style_id: 'noir-crime', role_type: '反派', personality: '阴鸷多疑', background: '走私集团幕后主使' },
  ];
  for (const s of specs) {
    const r = await POST('/api/actors', s);
    need(r.status === 200 && r.json.ok, `创建失败：${r.text.slice(0, 160)}`);
    need(/^C-\d{4}$/.test(r.json.actor.id), `编号异常 ${r.json.actor.id}`);
    need(r.json.actor.subject_en && r.json.actor.subject_en.length > 10, '缺少英文人物锚点');
    C.actors.push(r.json.actor);
  }
  const ids = C.actors.map((a) => a.id);
  need(new Set(ids).size === 3, 'ID 重复');
  need(C.actors[0].height_cm === 186 && C.actors[1].body_type === 'slim', '字段未落库');
  return `${ids.join(' / ')}（含英文锚点与中文描述）`;
});
await step('演员详情：英文锚点 + 中文描述 + 参数齐备', async () => {
  const d = (await GET(`/api/actors/${C.actors[0].id}`)).json;
  need(d.ok && d.actor.subject_en.length > 5 && d.actor.subject_zh.includes('男'), JSON.stringify(d.actor).slice(0, 120));
  return `${d.actor.id} ${d.actor.name}｜${d.actor.subject_en.slice(0, 60)}…`;
});
await step('更新演员参数（身高/标签）并回读', async () => {
  const r = await PUT(`/api/actors/${C.actors[1].id}`, { height_cm: 170, tags: '模拟测试' });
  need(r.json.ok && r.json.actor.height_cm === 170 && r.json.actor.tags === '模拟测试', JSON.stringify(r.json).slice(0, 120));
  return `height 168 → 170，tags=模拟测试`;
});
await step('9 类镜头的正/负向提示词均可生成（英文 + 负向）', async () => {
  const kinds = (await GET('/api/kinds')).json.kinds;
  let n = 0, bad = [];
  for (const k of kinds) {
    for (const v of k.variants.slice(0, 2)) {
      const r = await POST(`/api/actors/${C.actors[0].id}/prompt`, { kind: k.id, variant: v.id });
      if (r.json.ok && r.json.positive && r.json.negative) n++;
      else bad.push(`${k.id}/${v.id}`);
    }
  }
  need(bad.length === 0, `失败：${bad.join(', ')}`);
  const sample = await POST(`/api/actors/${C.actors[0].id}/prompt`, { kind: 'face', variant: 'closeup' });
  need(!/[\u4e00-\u9fa5]/.test(sample.json.positive), '正向提示词混入中文');
  need(sample.json.negative.length > 10, '负向提示词过短');
  // 逐变体复核语言纯净度（含中文服饰/性格的自由文本字段也不得漏进英文正向）
  await PUT(`/api/actors/${C.actors[0].id}`, { costume: '黑色风衣', personality: '沉默寡言' });
  const dirty = [];
  let zhCount = 0, all = 0, cjkNote = null;
  for (const k of kinds) {
    for (const v of k.variants) {
      all++;
      const r = await POST(`/api/actors/${C.actors[0].id}/prompt`, { kind: k.id, variant: v.id });
      if (/[\u4e00-\u9fa5]/.test(r.json.positive || '')) dirty.push(`${k.id}/${v.id}`);
      if (r.json.positive_zh) zhCount++;
      if (Array.isArray(r.json.cjkDropped) && r.json.cjkDropped.length) cjkNote = cjkNote || r.json.cjkDropped;
    }
  }
  await PUT(`/api/actors/${C.actors[0].id}`, { costume: '', personality: '' });
  need(dirty.length === 0, `英文正向残留中文：${dirty.join(', ')}`);
  need(zhCount === all, `中文版提示词缺失：${zhCount}/${all}`);
  need(Boolean(cjkNote), '中文自由文本（服饰）未记录到 cjkDropped');
  return `${kinds.length} 类共 ${all} 条变体：英文正向零中文残留，中文版齐备，剔除记录 ${JSON.stringify(cjkNote)}`;
});
await step(REAL_LLM ? '一键优化提示词（真实 LLM）' : '一键优化提示词（mock 通路，设 SIM_REAL_LLM=1 可走真实模型）', async () => {
  const r = await POST(`/api/actors/${C.actors[0].id}/optimize`, { kind: 'face', variant: 'closeup', instruction: '更强调冷峻气质与电影级布光', save: true });
  need(r.json?.ok !== false, JSON.stringify(r.json).slice(0, 160));
  const txt = r.json.optimized || r.json.positive || r.json.prompt || '';
  need(txt.length > 10, `返回内容过短：${JSON.stringify(r.json).slice(0, 160)}`);
  return `${String(txt).slice(0, 70)}…`;
});
await step('生成单人定妆图（文生图）→ 落盘 + 落库 + 绑定主图', async () => {
  const g = await POST(`/api/actors/${C.actors[0].id}/generate`, { kind: 'full', variant: 'front' });
  const job = await waitJob(g.json.jobId);
  need(job.status === 'done' && job.result.failed === 0, JSON.stringify(job.error || job.result));
  const imgs = (await GET(`/api/actors/${C.actors[0].id}/images`)).json.images;
  need(imgs.length >= 1 && imgs.every((i) => i.file_path && i.prompt_pos), '图片记录不完整');
  need(imgs.every((i) => exists(i.file_path)), '图片文件不在磁盘上');
  const prim = await POST(`/api/actors/${C.actors[0].id}/primary-image`, { imageId: imgs[0].id });
  need(prim.json.ok, '设主图失败');
  art('定妆图', imgs[0].file_path, `${C.actors[0].name} 主图`);
  return `${imgs[0].file_path}（${(size(imgs[0].file_path) / 1024).toFixed(1)}KB）已设为主图`;
});
await step('批量生成：2 演员 × 2 变体（表情）', async () => {
  const g = await POST('/api/generate/batch', { actorIds: [C.actors[0].id, C.actors[1].id], kind: 'expression', variants: ['smile', 'angry'], perVariant: 1 });
  need(g.json.ok && g.json.total === 4, JSON.stringify(g.json).slice(0, 140));
  const job = await waitJob(g.json.jobId);
  need(job.status === 'done' && job.result.failed === 0, JSON.stringify(job.error || job.result));
  const c = db.get('SELECT COUNT(*) n FROM actor_images').n;
  return `4 张表情图完成，素材库共 ${c} 张`;
});
await step('参考生图（useRef=true）：以上一张为主图参考继续出图', async () => {
  const before = db.get('SELECT COUNT(*) n FROM actor_images').n;
  const g = await POST(`/api/actors/${C.actors[0].id}/generate`, { kind: 'costume', variants: ['fabric'], useRef: true });
  const job = await waitJob(g.json.jobId);
  need(job.status === 'done' && job.result.failed === 0, JSON.stringify(job.error || job.result));
  const after = db.get('SELECT COUNT(*) n FROM actor_images').n;
  need(after === before + 1, `图片数 ${before} → ${after}`);
  return `服饰细节图入库（参考生图通路），素材库 ${after} 张`;
});
await step('上传演员参考图（multipart）并写回档案', async () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001', 'hex');
  const fd = new FormData();
  fd.append('image', new Blob([png], { type: 'image/png' }), 'sim-ref.png');
  const res = await fetch(`${BASE}/api/actors/${C.actors[0].id}/ref-image`, { method: 'POST', body: fd });
  const j = await res.json();
  need(res.status === 200 && j.ok && exists(j.ref_image), JSON.stringify(j).slice(0, 140));
  return `${j.ref_image} 已写入档案`;
});
await step('演员排序 / 复制（画布唯一提示）', async () => {
  const ids = db.all('SELECT id FROM actors ORDER BY rowid').map((r) => r.id);
  const rev = await POST('/api/actors/reorder', { ids: [...ids].reverse() });
  need(rev.json.ok, '排序失败');
  const dup = await POST(`/api/actors/${C.actors[0].id}/duplicate`, {});
  need(dup.json.ok && dup.json.actor.id !== C.actors[0].id, '复制失败');
  await DEL(`/api/actors/${dup.json.actor.id}`);
  const back = await POST('/api/actors/reorder', { ids });
  need(back.json.ok, '还原排序失败');
  return `排序可逆（${ids.length} 人），复制出新 ID 后已清理`;
});
await step('矩阵画布：自动排布（矩阵模式）+ 位置落库', async () => {
  const r = await POST('/api/canvas/auto-arrange', { cols: 4, cell: 180 });
  need(r.json.ok, JSON.stringify(r.json).slice(0, 120));
  const nodes = (await GET('/api/canvas?id=CV-MAIN')).json.canvas.nodes;
  need(nodes.length >= 3 && nodes.every((n) => typeof n.x === 'number' && typeof n.y === 'number'), '节点坐标缺失');
  return `${nodes.length} 个卡位已排布`;
});
await step('拖动单个卡位 / 批量 upsert 坐标', async () => {
  const nodes = (await GET('/api/canvas?id=CV-MAIN')).json.canvas.nodes;
  const one = await POST('/api/canvas/node', { canvas_id: 'CV-MAIN', actor_id: nodes[0].actor_id, x: 333, y: 222 });
  need(one.json.ok, '单点移动失败');
  const bulk = await POST('/api/canvas/nodes', { nodes: nodes.slice(0, 2).map((n, i) => ({ canvas_id: 'CV-MAIN', actor_id: n.actor_id, x: 100 + i * 220, y: 90 })) });
  need(bulk.json.ok, '批量 upsert 失败');
  const after = (await GET('/api/canvas?id=CV-MAIN')).json.canvas.nodes.find((n) => n.actor_id === nodes[0].actor_id);
  need(after.x === 100, `坐标未落库：${after.x}`);
  return `单点 (333,222) + 批量 2 点，回读 x=${after.x}`;
});
await step('按角色类型分组排布 + 一键成组（分组框生成）', async () => {
  const arr = await POST('/api/canvas/arrange', { id: 'CV-MAIN', mode: 'group', groupBy: 'role_type', cols: 4, cell: 180 });
  need(arr.json.ok, JSON.stringify(arr.json).slice(0, 120));
  const g = await POST('/api/canvas/auto-group', { id: 'CV-MAIN', groupBy: 'role_type', cols: 4, cell: 180 });
  need(g.json.ok, '自动成组失败');
  const groups = (await GET('/api/canvas/groups?canvas_id=CV-MAIN')).json.groups;
  need(groups.length >= 1 && groups.every((x) => x.id && x.name), '分组未落库');
  return `${groups.length} 个分组：${groups.map((x) => x.name).join(' / ')}`;
});
await step('视图持久化：缩放/平移/背景/网格/小地图存回画布', async () => {
  const vp = await PUT('/api/canvas/viewport', { id: 'CV-MAIN', zoom: 0.42, panX: -30, panY: 12, bg: 'lines', gridSize: 80, snap: false, showMinimap: true, showLinks: true });
  need(vp.json.ok, '保存失败');
  const cv = (await GET('/api/canvas?id=CV-MAIN')).json.canvas;
  const view = cv.layout?.view || {};
  need(Math.abs(view.zoom - 0.42) < 1e-6 && view.bg === 'lines' && view.gridSize === 80, JSON.stringify(view));
  // 后端只存状态、不钳制（前端限制 5%~800%）；这里验证「原样存回」与非法画布 404
  const low = await PUT('/api/canvas/viewport', { id: 'CV-MAIN', zoom: 0.001 });
  const lowView = low.json.view || (await GET('/api/canvas?id=CV-MAIN')).json.canvas.layout?.view || {};
  need(low.json.ok && Number(lowView.zoom) === 0.001, `视图未原样存回：${JSON.stringify(lowView)}`);
  await PUT('/api/canvas/viewport', { id: 'CV-MAIN', zoom: 0.42 });
  const bad = await PUT('/api/canvas/viewport', { id: 'CV-NOT-EXIST', zoom: 1 });
  need(bad.status === 404, `不存在的画布返回 ${bad.status}`);
  return `zoom ${view.zoom} / bg ${view.bg} / grid ${view.gridSize} / 原样存回 ${lowView.zoom}（前端钳制 5%~800%）/ 非法画布 ${bad.status}`;
});
await step('环境/物品节点：创建 + 编辑（含标签与描述）', async () => {
  const scene = await POST('/api/canvas/assets', { canvas_id: 'CV-MAIN', kind: 'scene', title: '雾港码头', x: 900, y: 60, data: { timeOfDay: '深夜', weather: '浓雾', desc: '栈桥灯柱昏黄，海雾漫过铁轨', tags: ['主场景'] } });
  need(scene.json.ok && scene.json.node.id, JSON.stringify(scene.json).slice(0, 120));
  const item = await POST('/api/canvas/assets', { canvas_id: 'CV-MAIN', kind: 'item', title: '停摆怀表', x: 900, y: 380, data: { category: '关键道具', desc: '指针停在十点四十' } });
  need(item.json.ok, '物品节点创建失败');
  const badKind = await POST('/api/canvas/assets', { canvas_id: 'CV-MAIN', kind: '不存在' });
  need(badKind.status >= 400, `非法类型未拦截（${badKind.status}）`);
  const upd = await PUT(`/api/canvas/assets/${scene.json.node.id}`, { title: '雾港码头（夜）', data: { weather: '暴雨' } });
  need(upd.json.ok && upd.json.node.title === '雾港码头（夜）', '编辑失败');
  C.scene = scene.json.node; C.item = item.json.node;
  return `场景 ${scene.json.node.id} / 物品 ${item.json.node.id}，非法类型已拦截`;
});
await step('参考图矩阵：批量上传参考图生成矩阵节点并自动成组', async () => {
  const r = await POST('/api/canvas/ref-matrix', {
    canvas_id: 'CV-MAIN', x: 1300, y: 60, cols: 3, cell: 200, groupName: '参考图矩阵',
    files: [{ name: 'ref-1.png', path: 'data/uploads/ref-1.png' }, { name: 'ref-2.png', path: 'data/uploads/ref-2.png' }, { name: 'ref-3.png', path: 'data/uploads/ref-3.png' }],
  });
  need(r.json.ok, JSON.stringify(r.json).slice(0, 160));
  const ids = r.json.nodeIds || [];
  need(r.json.created >= 3 && ids.length >= 3, JSON.stringify(r.json).slice(0, 140));
  const rows = db.all(`SELECT * FROM canvas_nodes WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids);
  need(rows.every((n) => n.kind === 'refimg'), '矩阵节点类型异常');
  need(Boolean(r.json.groupId), '矩阵未自动成组');
  C.refNodes = rows;
  return `${rows.length} 个参考图节点（自动成组 ${r.json.groupId}）`;
});
await step('节点参考图增删与主参考图（供关键帧参考生图）', async () => {
  const add = await POST(`/api/canvas/assets/${C.scene.id}/ref-images`, { add: ['data/uploads/a.png', 'data/uploads/b.png'] });
  need(add.json.ok, '添加参考图失败');
  const prim = await POST(`/api/canvas/assets/${C.scene.id}/ref-images`, { add: ['data/uploads/c.png'], primary: 'data/uploads/c.png' });
  need(prim.json.ok, '设置主参考图失败');
  const rm = await POST(`/api/canvas/assets/${C.scene.id}/ref-images`, { remove: ['data/uploads/a.png'] });
  need(rm.json.ok, '移除参考图失败');
  const node = db.get('SELECT data FROM canvas_nodes WHERE id=?', C.scene.id);
  const data = JSON.parse(node.data || '{}');
  need((data.refImages || []).length === 2 && data.refImages[0] === 'data/uploads/c.png', JSON.stringify(data).slice(0, 160));
  return `参考图 2 张，主参考图（数组首位）${data.refImages[0]}`;
});
await step('关系线：演员→场景 / 物品→演员 / 场景→物品（带左右端口）', async () => {
  const actorNode = db.get('SELECT id FROM canvas_nodes WHERE actor_id=? AND canvas_id=?', C.actors[0].id, 'CV-MAIN');
  const l1 = await POST('/api/canvas/links', { canvas_id: 'CV-MAIN', from_node: actorNode.id, to_node: C.scene.id, label: '出现在', from_side: 'right', to_side: 'left' });
  const l2 = await POST('/api/canvas/links', { canvas_id: 'CV-MAIN', from_node: C.item.id, to_node: actorNode.id, label: '持有' });
  const l3 = await POST('/api/canvas/links', { canvas_id: 'CV-MAIN', from_node: C.scene.id, to_node: C.item.id, label: '场景道具' });
  need(l1.json.ok && l2.json.ok && l3.json.ok, '建线失败');
  C.actorNodeId = actorNode.id;
  return `3 条关系线（出现在/持有/场景道具）`;
});
await step('关系线幂等与非法拦截：重复不新增、自连拒绝、缺参拒绝', async () => {
  const first = (await GET('/api/canvas/links?canvas_id=CV-MAIN')).json.links.find((l) => l.from_node === C.actorNodeId && l.to_node === C.scene.id);
  const dup = await POST('/api/canvas/links', { canvas_id: 'CV-MAIN', from_node: C.actorNodeId, to_node: C.scene.id, label: '出现在', from_side: 'right', to_side: 'left' });
  const total = (await GET('/api/canvas/links?canvas_id=CV-MAIN')).json.links.length;
  need(dup.json.ok && dup.json.link.id === first.id && total === 3, `重复建线未幂等：${JSON.stringify(dup.json.link?.id)} / 总数 ${total}`);
  const self = await POST('/api/canvas/links', { canvas_id: 'CV-MAIN', from_node: C.scene.id, to_node: C.scene.id });
  need(self.status >= 400, `自连未拦截（${self.status}）`);
  const miss = await POST('/api/canvas/links', { canvas_id: 'CV-MAIN', from_node: 'ND-NOT-EXIST', to_node: C.scene.id });
  need(miss.status >= 400, `缺参未拦截（${miss.status}）`);
  return `重复→返回同一条 ${dup.json.link.id}（总数仍 3），自连 ${self.status}，缺参 ${miss.status}`;
});
await step('关系线数量不限：连续新建 20 条并逐条清理', async () => {
  const ids = db.all('SELECT id FROM canvas_nodes WHERE canvas_id=? LIMIT 6', 'CV-MAIN').map((r) => r.id);
  const made = [];
  for (let i = 0; i < 20; i++) {
    const a = ids[i % ids.length], b = ids[(i + 3) % ids.length];
    if (a === b) continue;
    const r = await POST('/api/canvas/links', { canvas_id: 'CV-MAIN', from_node: a, to_node: b, label: `批量${i + 1}` });
    if (r.json.ok) made.push(r.json.link.id);
  }
  const total = (await GET('/api/canvas/links?canvas_id=CV-MAIN')).json.links.length;
  need(made.length >= 15 && total >= 18, `建线 ${made.length} 条，总数 ${total}`);
  for (const id of made) await DEL(`/api/canvas/links/${id}`);
  const after = (await GET('/api/canvas/links?canvas_id=CV-MAIN')).json.links.length;
  need(after === total - made.length, `清理后应为 ${total - made.length}，实为 ${after}`);
  return `连建 ${made.length} 条（画布共 ${total} 条）→ 全部删除后回到 ${after} 条`;
});
await step('关系线改标签 / 反转方向 / 删除', async () => {
  const links = (await GET('/api/canvas/links?canvas_id=CV-MAIN')).json.links;
  const target = links.find((l) => l.label === '持有') || links[0];
  // 改标签/反转 = 删旧建新（前端右键菜单同样走这条路径：删除 + 新建反向连线）
  const delOld = await DEL(`/api/canvas/links/${target.id}`);
  need(delOld.json.ok, '删除旧连线失败');
  const made = await POST('/api/canvas/links', { canvas_id: 'CV-MAIN', from_node: target.to_node, to_node: target.from_node, label: '随身携带', from_side: 'right', to_side: 'left' });
  need(made.json.ok && made.json.link.label === '随身携带' && made.json.link.from_node === target.to_node, JSON.stringify(made.json).slice(0, 140));
  const back = await DEL(`/api/canvas/links/${made.json.link.id}`);
  const restore = await POST('/api/canvas/links', { canvas_id: 'CV-MAIN', from_node: target.from_node, to_node: target.to_node, label: target.label, from_side: target.from_side, to_side: target.to_side });
  need(back.json.ok && restore.json.ok, '还原失败');
  return `改标签+反转 = 删旧建新（${target.label} → 随身携带 → 还原），与前端右键一致`;
});
await step('节点分组：手动成组 / 改名 / 改色 / 收起展开 / 整体移动', async () => {
  const nodes = db.all('SELECT id FROM canvas_nodes WHERE actor_id IS NOT NULL AND canvas_id=? LIMIT 2', 'CV-MAIN').map((r) => r.id);
  const g = await POST('/api/canvas/groups', { canvas_id: 'CV-MAIN', name: '主演组', node_ids: nodes, actorIds: [C.actors[0].id, C.actors[1].id] });
  need(g.json.ok && g.json.group.id, JSON.stringify(g.json).slice(0, 140));
  const id = g.json.group.id;
  const up = await PUT(`/api/canvas/groups/${id}`, { name: '主演组（改）', color: '#ff7ab0' });
  need(up.json.ok && up.json.group.name.includes('改'), '改名失败');
  const col = await PUT(`/api/canvas/groups/${id}`, { collapsed: 1 });
  need(col.json.ok && Number(col.json.group.collapsed) === 1, '收起失败');
  await PUT(`/api/canvas/groups/${id}`, { collapsed: 0 });
  const mv = await POST(`/api/canvas/groups/${id}/move`, { dx: 120, dy: 60 });
  need(mv.json.ok, '整体移动失败');
  const delKeep = await DEL(`/api/canvas/groups/${id}?keepNodes=1`);
  need(delKeep.json.ok && db.get('SELECT COUNT(*) n FROM canvas_nodes WHERE id=?', nodes[0]).n === 1, '解散分组时误删节点');
  return `成组/改名/改色/收起/移动/解散（保留节点）全部通过`;
});
await step('便签节点：新建 / 改文字与颜色 / 拖动 / 删除', async () => {
  const n = await POST('/api/canvas/notes', { canvas_id: 'CV-MAIN', x: 1500, y: 600, text: '第一季主线：怀表与灭门案', color: 'purple' });
  need(n.json.ok && n.json.node.id, JSON.stringify(n.json).slice(0, 120));
  const up = await PUT(`/api/canvas/notes/${n.json.node.id}`, { text: '改过的便签', color: 'blue', w: 300, x: 1560, y: 640 });
  need(up.json.ok, '更新失败');
  const row = db.get('SELECT x, y, w, note FROM canvas_nodes WHERE id=?', n.json.node.id);
  need(row.x === 1560 && row.w === 300 && JSON.parse(row.note).text === '改过的便签', JSON.stringify(row).slice(0, 140));
  await DEL(`/api/canvas/node/${n.json.node.id}`);
  need(db.get('SELECT COUNT(*) n FROM canvas_nodes WHERE id=?', n.json.node.id).n === 0, '删除失败');
  return `便签 ${n.json.node.id} 建→改→拖动→删`;
});
await step('节点锁定：锁定后标记落库（前端禁止拖动）', async () => {
  const r = await POST(`/api/canvas/node/${C.scene.id}/lock`, { locked: true });
  need(r.json.ok, '锁定失败');
  const row = db.get('SELECT locked FROM canvas_nodes WHERE id=?', C.scene.id);
  need(Number(row.locked) === 1, `locked=${row.locked}`);
  await POST(`/api/canvas/node/${C.scene.id}/lock`, { locked: false });
  return `locked 1 → 0`;
});
await step('组合出图预览（dryRun）：提示词含人物锚点 + 环境描述 + 参考图', async () => {
  const prev = await POST('/api/canvas/compose/preview', { canvasId: 'CV-MAIN', nodeIds: [C.actorNodeId], kind: 'full', variant: 'keyart' });
  need(prev.json.ok, JSON.stringify(prev.json).slice(0, 160));
  const prompt = prev.json.positive || '';
  need(prev.json.jobId === null, '预览不应真的建任务');
  need(/雾港码头/.test(prompt), `预览提示词未包含环境：${prompt.slice(0, 160)}`);
  need(Array.isArray(prev.json.nodes) && prev.json.nodes.length >= 2, `参与节点来源缺失：${JSON.stringify(prev.json.nodes || []).slice(0, 120)}`);
  need(prev.json.assetCount >= 1, '未统计参与的环境/物品节点');
  const noLink = await POST('/api/canvas/compose/preview', { canvasId: 'CV-MAIN', nodeIds: [C.actorNodeId], kind: 'full', useLinked: false });
  const prompt2 = noLink.json.positive || '';
  need(prompt2.length < prompt.length, '关闭「连线即约束」后提示词未变短');
  return `连线即约束生效（${prompt.length} 字）→ 关闭后 ${prompt2.length} 字`;
});
await step('组合出图（真跑）：结果入演员素材库并挂到参与节点', async () => {
  const before = db.get('SELECT COUNT(*) n FROM actor_images').n;
  const r = await POST('/api/canvas/compose', { canvasId: 'CV-MAIN', nodeIds: [C.actorNodeId], kind: 'full', variant: 'keyart' });
  need(r.json.ok && r.json.jobId, JSON.stringify(r.json).slice(0, 160));
  const job = await waitJob(r.json.jobId);
  need(job.status === 'done' && (job.result?.failed ?? 0) === 0, JSON.stringify(job.error || job.result));
  const after = db.get('SELECT COUNT(*) n FROM actor_images').n;
  need(after > before, `素材库未新增：${before} → ${after}`);
  const sceneData = JSON.parse(db.get('SELECT data FROM canvas_nodes WHERE id=?', C.scene.id).data || '{}');
  need((sceneData.generated || []).length >= 1, '组合结果未挂到环境节点');
  art('组合出图', (sceneData.generated || [])[0]?.path || '', '演员×环境 组合出图');
  return `新增 ${after - before} 张，环境节点挂图 ${(sceneData.generated || []).length} 张`;
});
await step('环境节点单独生成概念图', async () => {
  const r = await POST(`/api/canvas/assets/${C.scene.id}/generate`, {});
  need(r.json.ok && r.json.jobId, JSON.stringify(r.json).slice(0, 140));
  const job = await waitJob(r.json.jobId);
  need(job.status === 'done', JSON.stringify(job.error || job.result));
  const data = JSON.parse(db.get('SELECT data FROM canvas_nodes WHERE id=?', C.scene.id).data || '{}');
  need((data.generated || []).length >= 2, `概念图未累加：${(data.generated || []).length}`);
  return `环境概念图累计 ${(data.generated || []).length} 张`;
});
await step('多画布：新建空画布 / 放入全部 / 清空 / 主画布删除保护', async () => {
  const nv = await POST('/api/canvas/create', { name: '模拟临时画布', cols: 3, cell: 160 });
  need(nv.json.ok && nv.json.canvas.id, JSON.stringify(nv.json).slice(0, 120));
  const cid = nv.json.canvas.id;
  const empty = (await GET(`/api/canvas?id=${cid}`)).json.canvas.nodes.length;
  need(empty === 0, `新画布非空：${empty}`);
  const fill = await POST('/api/canvas/arrange', { id: cid, mode: 'matrix', cols: 3, cell: 160 });
  need(fill.json.ok && (await GET(`/api/canvas?id=${cid}`)).json.canvas.nodes.length > 0, '放入全部失败');
  const cl = await POST('/api/canvas/clear', { id: cid });
  need(cl.json.ok && (await GET(`/api/canvas?id=${cid}`)).json.canvas.nodes.length === 0, '清空失败');
  const protect = await DEL('/api/canvas/CV-MAIN');
  need(protect.status >= 400, `主画布被删除（${protect.status}）`);
  const del = await DEL(`/api/canvas/${cid}`);
  need(del.json.ok, '删除临时画布失败');
  return `临时画布空→满→空→删；主画布删除返回 ${protect.status}`;
});
await step('安全网：空快照不得清空非空画布，allowEmpty 才允许', async () => {
  const before = db.get('SELECT COUNT(*) n FROM canvas_nodes WHERE canvas_id=?', 'CV-MAIN').n;
  need(before > 0, '主画布为空，无法验证');
  const guard = await POST('/api/canvas/restore', { canvas_id: 'CV-MAIN', nodes: [], groups: [] });
  const after = db.get('SELECT COUNT(*) n FROM canvas_nodes WHERE canvas_id=?', 'CV-MAIN').n;
  need(guard.json.ok === false && after === before, `未保护：ok=${guard.json.ok} ${before}→${after}`);
  return `拒绝空快照覆盖 ${before} 个卡位`;
});

// ════════════════════════════════════════════════════════════════
mod('2 · 模块2 小说工坊（100 题材 / 13 分节大纲 / 章节写作）');
// ════════════════════════════════════════════════════════════════
await step('题材与参数选项：100 题材 + 叙事视角 + 三重上限', async () => {
  const o = (await GET('/api/novels/options')).json;
  need(o.ok && o.genres.length === 100, `题材 ${o.genres?.length}`);
  need(o.povs.length >= 5 && o.limits, '视角或上限缺失');
  need(o.limits.castSize.max === 200 && o.limits.chapterWords.max === 3000 && o.limits.targetWords.max === 10000000, JSON.stringify(o.limits));
  return `题材 100 / 视角 ${o.povs.length} / 上限 角色≤200、章节 ${o.limits.chapterWords.min}-${o.limits.chapterWords.max} 字、总字数≤1000万`;
});
await step('创建小说（引用模块1 演员 + 自定义角色 + 参考范本）', async () => {
  const o = (await GET('/api/novels/options')).json;
  const genre = o.genres[0].id;
  const r = await POST('/api/novels', {
    title: '雾港谜案', genre, tone: '悬疑烧脑', scale: 'long',
    cast_size: 30, target_words: 60000, chapter_words: 2000, pov: o.povs[0].id, seasons: 2,
    framework_intro: '怀表停在十点四十，警局旧案重启；真相指向二十年前的走私集团。',
    actor_ids: [C.actors[0].id, C.actors[1].id],
    custom_actors: [{ name: '老周', role: '线人', gender: '男', age: 58, desc: '码头看门人，知道当年的事' }],
    ref_doc_path: C.refDoc, ref_doc_name: '参考范本.txt',
  });
  need(r.status === 200 && r.json.ok, r.text.slice(0, 200));
  C.novel = r.json.novel;
  need(/^N-\d{4}$/.test(C.novel.id), `编号异常 ${C.novel.id}`);
  need(C.novel.cast_total === 3, `角色总数 ${C.novel.cast_total}`);
  return `${C.novel.id}《${C.novel.title}》题材=${C.novel.genre_name} 计划 ${C.novel.planned_chapters} 章 / 角色 ${C.novel.cast_total}（引用 2 + 自定义 1）`;
});
await step('参数校验：角色规模超 200 / 章节字数越界 / 总字数超 1000 万 / 未知视角 / 引用不存在演员', async () => {
  const cases = [
    [{ title: '越界1', cast_size: 300 }, /角色规模/],
    [{ title: '越界2', chapter_words: 500 }, /章节字数/],
    [{ title: '越界3', target_words: 20000000 }, /总字数/],
    [{ title: '越界4', pov: '不存在的视角' }, /视角/],
    [{ title: '越界5', actor_ids: ['C-9999'] }, /演员/],
  ];
  const bad = [];
  for (const [body, re] of cases) {
    const r = await POST('/api/novels', body);
    if (!(r.status >= 400 && re.test(r.json?.error || ''))) bad.push(`${body.title}:${r.status}/${r.json?.error}`);
  }
  need(bad.length === 0, `未正确拦截：${bad.join(' | ')}`);
  return `5 类越界输入全部中文报错拦截`;
});
await step('生成章节大纲（13+ 分节：时间线/伏笔/地点ID/人物出场/反转/节奏/钩子/跨季回路/逻辑链）', async () => {
  const r = await POST(`/api/novels/${C.novel.id}/outline`, { provider: 'mock', chapterCount: 6, instruction: '反派第 3 章登场，钩子密度加大' });
  need(r.json.ok, JSON.stringify(r.json).slice(0, 180));
  const o = (await GET(`/api/novels/${C.novel.id}/outline`)).json;
  need(o.ok && o.outline && o.outline.sections, '大纲未落库');
  const payload = o.outline.sections || {};
  const sections = Object.keys(payload).filter((k) => payload[k] && !['meta'].includes(k));
  const need_keys = ['timeline', 'foreshadow', 'locations', 'characters', 'reversals', 'beats', 'hooks', 'loops', 'logic'];
  const missing = need_keys.filter((k) => !sections.includes(k));
  need(missing.length === 0, `缺少分节：${missing.join(',')}（现有 ${sections.join(',')}）`);
  const chapters = (await GET(`/api/novels/${C.novel.id}`)).json.chapters;
  need(chapters.length === 6, `章节骨架 ${chapters.length}`);
  return `${sections.length} 个分节 + ${chapters.length} 章骨架`;
});
await step('续规划：保留前 N 章，从第 N+1 章继续', async () => {
  const before = (await GET(`/api/novels/${C.novel.id}`)).json.chapters.length;
  const r = await POST(`/api/novels/${C.novel.id}/outline`, { provider: 'mock', chapterFrom: before + 1, chapterCount: 3, batchSize: 5 });
  need(r.json.ok, JSON.stringify(r.json).slice(0, 160));
  const after = (await GET(`/api/novels/${C.novel.id}`)).json.chapters.length;
  need(after === before + 3, `${before} → ${after}`);
  return `章节 ${before} → ${after}（续规划 3 章）`;
});
await step('一键优化大纲：产出新版本且不丢章节', async () => {
  const noIns = await POST(`/api/novels/${C.novel.id}/outline/optimize`, {});
  need(noIns.status >= 400, `缺指令未拦截（${noIns.status}）`);
  const r = await POST(`/api/novels/${C.novel.id}/outline/optimize`, { instruction: '前三章节奏加快，把伏笔提前到第 3 章回收', provider: 'mock' });
  need(r.json.ok, JSON.stringify(r.json).slice(0, 160));
  const versions = (await GET(`/api/novels/${C.novel.id}/outline`)).json.versions || [];
  need(versions.length >= 2, `版本数 ${versions.length}`);
  const chapters = (await GET(`/api/novels/${C.novel.id}`)).json.chapters.length;
  need(chapters >= 9, `优化后章节丢失：${chapters}`);
  return `版本 ${versions.length} 个，章节仍为 ${chapters}`;
});
await step('批量写作章节（异步任务 + 词数统计）', async () => {
  const r = await POST(`/api/novels/${C.novel.id}/chapters/generate`, { mode: 'range', from: 1, to: 2, provider: 'mock' });
  need(r.json.ok && /^JOB-/.test(r.json.jobId) && r.json.total === 2, JSON.stringify(r.json).slice(0, 160));
  const job = await waitJob(r.json.jobId);
  need(job.status === 'done', JSON.stringify(job.error || job.result));
  const ch = (await GET(`/api/novels/${C.novel.id}/chapters/1`)).json.chapter;
  need(ch.content && ch.content.length > 200 && ch.words > 100, `第 1 章 ${ch.words} 字`);
  return `第 1 章 ${ch.words} 字（任务 ${job.result?.done ?? '?'}/${job.result?.total ?? '?'}）`;
});
await step('单章重写 / 手动保存（字数按 countWords 统计）/ 删除章节', async () => {
  const rw = await POST(`/api/novels/${C.novel.id}/chapters/3/generate`, { provider: 'mock' });
  const job = await waitJob(rw.json.jobId);
  need(job.status === 'done', JSON.stringify(job.error || job.result));
  const chapterText = [
    '「你来得太晚了。」沈砚把怀表放在桌上，指针停在十点四十。',
    '林昭盯着那只表，低声说：「这是我父亲的表。」',
    '窗外的雨砸在铁皮棚上，浓雾顺着门缝挤进来，灯管忽明忽暗。',
    '顾岑在暗处笑了一声，说道：「二十年前的东西，你最好别碰。」',
  ].join('\n').repeat(3);
  const manual = await PUT(`/api/novels/${C.novel.id}/chapters/1`, { content: chapterText, title: '断剑（手改）' });
  need(manual.json.ok && manual.json.chapter.words > 100, JSON.stringify(manual.json).slice(0, 140));
  const empty = await PUT(`/api/novels/${C.novel.id}/chapters/1`, {});
  need(empty.status >= 400, `空 body 未拦截（${empty.status}）`);
  const del = await DEL(`/api/novels/${C.novel.id}/chapters/6`);
  need(del.json.ok, '删除章节失败');
  const left = (await GET(`/api/novels/${C.novel.id}`)).json.chapters.length;
  return `重写第 3 章 / 手改第 1 章 ${manual.json.chapter.words} 字 / 删第 6 章 → 剩 ${left} 章`;
});
await step('演员绑定更新（引用 + 自定义，超上限拒绝）', async () => {
  const r = await POST(`/api/novels/${C.novel.id}/actors`, { actorIds: [C.actors[0].id, C.actors[1].id, C.actors[2].id], customActors: [{ name: '阿砚', role: '学徒' }] });
  need(r.json.ok && r.json.novel.cast_total === 4, JSON.stringify(r.json).slice(0, 160));
  const over = await POST(`/api/novels/${C.novel.id}/actors`, { actorIds: Array.from({ length: 201 }, (_, i) => `C-${1000 + i}`) });
  need(over.status >= 400, `超上限未拦截（${over.status}）`);
  return `绑定 4 名（3 演员 + 1 自定义），超 200 被拒`;
});
await step('导出小说（txt / md / json）', async () => {
  const out = [];
  for (const fmt of ['txt', 'md', 'json']) {
    const r = await GET(`/api/novels/${C.novel.id}/export?format=${fmt}`);
    need(r.json?.ok === true && r.json.content.length > 100, `${fmt} 导出异常`);
    out.push(`${fmt} ${r.json.bytes || r.json.content.length}B`);
  }
  const dl = await GET(`/api/novels/${C.novel.id}/export?format=txt&download=1`, true);
  need(dl.status === 200 && dl.headers.get('content-disposition'), '下载模式未返回附件');
  return out.join(' / ');
});

// ════════════════════════════════════════════════════════════════
mod('3 · 模块3 剧本工厂（分集规划 / 单集剧本 / 分镜 / 提示词 / 导出）');
// ════════════════════════════════════════════════════════════════
await step('创建剧本（漫剧格式，60 秒/集，单季 3 集）', async () => {
  const r = await POST('/api/scripts', { novelId: C.novel.id, title: '雾港谜案·漫剧版', format: 'manju', styleId: 'noir-crime', episodeSeconds: 60, episodesPerSeason: 3, seasons: 1, options: { note: '全模块模拟' } });
  need(r.status === 200 && r.json.ok, r.text.slice(0, 200));
  C.script = r.json.script;
  need(/^SC-\d{4}$/.test(C.script.id), `编号异常 ${C.script.id}`);
  need(C.script.episode_seconds === 60 && C.script.format === 'manju', '配置未落库');
  return `${C.script.id}《${C.script.title}》${C.script.episode_seconds}s/集 × ${C.script.episodes_per_season} 集`;
});
await step('剧本参数校验：集数超上限 / 格式非法 / 小说不存在', async () => {
  const a = await POST('/api/scripts', { novelId: C.novel.id, title: '越界剧本', episodeSeconds: 60, episodesPerSeason: 9999, seasons: 1 });
  need(a.status === 200 && a.json.script.episodes_per_season === 500, `集数超限未夹取：${JSON.stringify(a.json.script || a.json).slice(0, 140)}`);
  need((a.json.warnings || []).some((w) => /每季集数/.test(w)), `未给中文告警：${JSON.stringify(a.json.warnings || [])}`);
  const a2 = await POST('/api/scripts', { novelId: C.novel.id, title: '越界剧本2', episodeSeconds: 5 });
  need(a2.json.script.episode_seconds === 15 && (a2.json.warnings || []).some((w) => /单集时长/.test(w)), JSON.stringify(a2.json.warnings || []));
  const b = await POST('/api/scripts', { novelId: C.novel.id, title: '形态回退', format: '不存在的形态' });
  need(b.json.script.format === 'manju' && (b.json.warnings || []).some((w) => /未知剧本形态/.test(w)), JSON.stringify(b.json.warnings || []));
  const c = await POST('/api/scripts', { novelId: 'N-9999', title: 'x' });
  need(c.status >= 400 && /不存在/.test(c.json?.error || ''), `小说不存在未拦截（${c.status}）`);
  for (const x of [a, a2, b]) await DEL(`/api/scripts/${x.json.script.id}`);
  const list = (await GET('/api/scripts')).json.scripts;
  need(list.length === 1 && list[0].id === C.script.id, `残留脏数据：${list.map((x) => x.id).join(',')}`);
  return `越界值夹取 + 中文告警（集数→500、时长→15s、形态→manju），小说不存在 400，临时剧本已清理`;
});
await step('上传自定义转换技能文档并绑定剧本', async () => {
  const up = await uploadFile('file', 'sim-skill.md', '# 漫剧转换技能（模拟）\n- 每集 3 幕：钩子 / 冲突 / 悬念收尾\n- 台词 ≤ 14 字\n', 'text/markdown');
  const rel = up.json.files?.[0]?.path || up.json.path;
  need(rel && exists(rel), `上传返回异常：${JSON.stringify(up.json).slice(0, 120)}`);
  const r = await PUT(`/api/scripts/${C.script.id}`, { skill_doc_path: rel, skill_doc_name: 'sim-skill.md' });
  need(r.json.ok, '绑定技能文档失败');
  const doc = (await GET(`/api/scripts/${C.script.id}/skill-doc`)).json;
  need(doc.ok && doc.text.includes('漫剧转换技能') && doc.source === 'upload', JSON.stringify({ src: doc.source, name: doc.name }));
  need(doc.vocab, '缺少词汇表');
  return `${doc.name}（${doc.text.length} 字，来源 ${doc.source}）`;
});
await step('分集规划（离线规则）：每集含标题 / logline / 钩子 / 悬念收尾 / 覆盖章节', async () => {
  const r = await POST(`/api/scripts/${C.script.id}/plan`, { overwrite: true, offline: true, sync: true });
  need(r.json.ok && r.json.episodes.length === 3, JSON.stringify(r.json).slice(0, 160));
  const ep = r.json.episodes[0];
  need(ep.title && ep.logline && ep.hook && ep.cliffhanger && ep.source_chapters?.length, JSON.stringify(ep).slice(0, 200));
  need(r.json.episodes.every((e) => e.duration === 60), '每集时长与设定不一致');
  return `${r.json.episodes.length} 集，首集《${ep.title}》← 第 ${ep.source_chapters.join(',')} 章，钩子「${String(ep.hook).slice(0, 24)}…」`;
});
await step('生成单集剧本（场次 + 台词 + 动作 beat）', async () => {
  const r = await POST(`/api/scripts/${C.script.id}/episodes/${C.episode}/generate`, { offline: true, sync: true });
  need(r.json.ok, JSON.stringify(r.json).slice(0, 160));
  const scenes = r.json.episode.scenes?.scenes || [];
  const beats = scenes.flatMap((s) => s.beats || []);
  const hist = beats.reduce((m, b) => { m[b.type || '缺类型'] = (m[b.type || '缺类型'] || 0) + 1; return m; }, {});
  need(scenes.length >= 1 && beats.length >= 3, `场次 ${scenes.length} / beat ${beats.length}`);
  need(beats.every((b) => b.type && b.text), '存在缺类型/缺文本的 beat');
  need(Object.keys(hist).length >= 2, `beat 类型单一：${JSON.stringify(hist)}`);
  need(scenes.every((s) => s.location !== undefined && s.time), '场次缺地点/时间');
  return `${scenes.length} 场 / ${beats.length} 个 beat（类型分布 ${Object.entries(hist).map(([k, v]) => `${k}×${v}`).join(' ')}）`;
});
await step('绑定画布资产 + 生成分镜（异步任务）', async () => {
  const bind = await POST(`/api/scripts/${C.script.id}/canvas-binding`, { canvasId: 'CV-MAIN' });
  need(bind.json.ok, JSON.stringify(bind.json).slice(0, 160));
  const sb = await POST(`/api/scripts/${C.script.id}/storyboard`, { episode: C.episode, offline: true });
  need(sb.json.ok && sb.json.jobId, JSON.stringify(sb.json).slice(0, 160));
  const job = await waitJob(sb.json.jobId);
  need(job.status === 'done', JSON.stringify(job.error || job.result));
  const board = (await GET(`/api/render/episode?scriptId=${C.script.id}&code=${C.episode}`)).json;
  need(board.shots.length >= 5, `镜头数 ${board.shots?.length}`);
  C.shots = board.shots;
  return `${board.shots.length} 个镜头（总时长 ${board.stats?.duration ?? board.shots.reduce((n, s) => n + (s.duration || 0), 0)}s）`;
});
await step('分镜表质量：景别/运镜/时长/成本级/台词齐备，提示词为纯英文', async () => {
  const shots = C.shots;
  need(shots.every((s) => s.shot_size && s.camera && s.move && s.duration > 0 && s.cost_level), `字段缺失：${JSON.stringify(shots[0] || {}).slice(0, 160)}`);
  const cjk = shots.filter((s) => /[\u4e00-\u9fa5]/.test(s.prompt_pos || ''));
  need(cjk.length === 0, `${cjk.length} 个镜头的提示词混入中文：${cjk[0]?.prompt_pos?.slice(0, 60)}`);
  need(shots.every((s) => (s.prompt_neg || '').length > 5), '负向提示词缺失');
  need(shots.every((s) => s.action), '镜头缺动作描述');
  const withAudio = shots.filter((s) => s.dialogue);
  return `${shots.length} 镜全英文正/负向词；景别 ${new Set(shots.map((s) => s.shot_size)).size} 种、运镜 ${new Set(shots.map((s) => s.move)).size} 种；${withAudio.length} 镜带台词`;
});
await step('画布资产令牌注入分镜（canvas set: 环境/物品）', async () => {
  const shots = (await GET(`/api/render/episode?scriptId=${C.script.id}&code=${C.episode}`)).json.shots;
  const withToken = shots.filter((s) => /canvas set:/.test(s.prompt_pos || ''));
  need(withToken.length > 0, `没有任何镜头带 canvas set 令牌`);
  const sample = withToken[0].prompt_pos;
  need(/fog|harbor|wharf|pier|watch|scene|item/i.test(sample), `令牌未含可映射英文：${sample.slice(0, 160)}`);
  return `${withToken.length}/${shots.length} 个镜头带上画布设定，示例：${sample.slice(0, 110)}…`;
});
await step('单镜编辑 / 新增 / 删除 / 时长再平衡', async () => {
  const target = C.shots[0];
  const ed = await PUT(`/api/scripts/${C.script.id}/shots/${target.id}`, { action: '改写的动作描述：雨水砸在铁皮棚上', duration: 4, move: '推镜' });
  need(ed.json.ok && ed.json.shot.action.includes('改写的动作描述'), JSON.stringify(ed.json).slice(0, 140));
  const add = await POST(`/api/scripts/${C.script.id}/shots`, { episode: C.episode, action: '新增镜头：怀表在掌心特写', shot_size: '大特写', cost_level: 'L', duration: 3, characters: [C.actors[0].id], move: '推镜' });
  need(add.json.ok && add.json.shot.id, JSON.stringify(add.json).slice(0, 140));
  const reb = await POST(`/api/scripts/${C.script.id}/rebalance`, { episode: C.episode });
  need(reb.json.ok, JSON.stringify(reb.json).slice(0, 140));
  const bad = await PUT(`/api/scripts/${C.script.id}/shots/SH-9999`, { action: 'x' });
  need(bad.status === 404, `不存在镜头返回 ${bad.status}`);
  const del = await DEL(`/api/scripts/${C.script.id}/shots/${add.json.shot.id}`);
  need(del.json.ok, '删除镜头失败');
  return `编辑首镜 / 新增 1 镜 / 再平衡至 ${reb.json.total || reb.json.shots?.length || '?'} 镜 / 删除新增镜`;
});
await step('剧本导出 4 格式 + 单集筛选 + 非法格式拒绝', async () => {
  const out = [];
  for (const fmt of ['md', 'csv', 'json', 'txt', 'srt']) {
    const r = await GET(`/api/scripts/${C.script.id}/export?format=${fmt}`);
    if (r.json?.ok !== true) continue;
    out.push(`${fmt}`);
    need(r.json.content && r.json.content.length > 50, `${fmt} 内容过短`);
  }
  need(out.length >= 3, `可用格式仅 ${out.join(',')}`);
  const epCsv = await GET(`/api/scripts/${C.script.id}/export?format=csv&episode=${C.episode}`);
  need(epCsv.json?.ok, '按集导出失败');
  const badFmt = await GET(`/api/scripts/${C.script.id}/export?format=xlsx`);
  need(badFmt.status >= 400, `非法格式未拦截（${badFmt.status}）`);
  return `${out.join(' / ')} 均可用（按集导出正常，非法格式 ${badFmt.status}）`;
});

// ════════════════════════════════════════════════════════════════
mod('4 · 模块4 制作台（关键帧 → 视频 → 整集 → 包装 → 流水线）');
// ════════════════════════════════════════════════════════════════
await step('看板总览：剧本/剧集/镜头/关键帧/视频计数一致', async () => {
  const o = (await GET('/api/render/overview')).json;
  need(o.ok && Array.isArray(o.scripts) && o.counts && o.backend, JSON.stringify(o).slice(0, 200));
  const list = (await GET('/api/render/scripts')).json.scripts;
  need(list.some((s) => s.id === C.script.id), `剧本列表缺 ${C.script.id}：${list.map((s) => s.id).join(',')}`);
  const board = (await GET(`/api/render/episode?scriptId=${C.script.id}&code=${C.episode}`)).json;
  need(board.stats.shots === board.shots.length, `镜头计数不一致`);
  need(board.backend?.image && board.backend?.video, '缺少后端状态块');
  return `${board.stats.shots} 镜 / 关键帧 ${board.stats.keyframes} / 视频 ${board.stats.videos}｜后端 出图=${board.backend.image.backend} 视频=${board.backend.video.backend}`;
});
await step('工作量与耗时预估', async () => {
  const r = (await GET(`/api/render/estimate?scriptId=${C.script.id}&codes=${C.episode}`)).json;
  need(r.ok, JSON.stringify(r).slice(0, 160));
  const e = r.totals || r.estimate?.totals || r.estimate || {};
  const secs = e.seconds ?? e.estimatedSeconds ?? r.estimateSeconds;
  need(e.keyframes !== undefined || e.videos !== undefined || secs !== undefined, JSON.stringify(r).slice(0, 200));
  return `预估 关键帧 ${e.keyframes ?? '?'} / 视频 ${e.videos ?? '?'} / 约 ${secs ?? '?'}s（字段：${Object.keys(e).slice(0, 6).join(',')}）`;
});
await step('渲染关键帧（placeholder 出图）→ 文件落盘并绑定到镜头', async () => {
  const r = await POST('/api/render/keyframes', { scriptId: C.script.id, code: C.episode });
  need(r.json.ok && r.json.jobId, JSON.stringify(r.json).slice(0, 140));
  const job = await waitJob(r.json.jobId);
  need(job.status === 'done' && job.result.failed === 0, JSON.stringify(job.error || job.result));
  const board = (await GET(`/api/render/episode?scriptId=${C.script.id}&code=${C.episode}`)).json;
  const withKf = board.shots.filter((s) => s.keyframe?.file_path);
  need(withKf.length === board.shots.length, `${withKf.length}/${board.shots.length} 镜有关键帧`);
  need(withKf.every((s) => exists(s.keyframe.file_path)), '关键帧文件缺失');
  art('关键帧', withKf[0].keyframe.file_path, withKf[0].id);
  return `${withKf.length} 张关键帧（示例 ${withKf[0].keyframe.file_path}）`;
});
await step('增量与覆盖：已有跳过 / 指定镜头覆盖重做', async () => {
  const skip = await waitJob((await POST('/api/render/keyframes', { scriptId: C.script.id, code: C.episode })).json.jobId);
  const board = (await GET(`/api/render/episode?scriptId=${C.script.id}&code=${C.episode}`)).json;
  need(skip.status === 'done' && skip.result.skipped === board.shots.length, JSON.stringify(skip.result));
  const one = await POST('/api/render/keyframes', { scriptId: C.script.id, code: C.episode, shotIds: [board.shots[0].id], overwrite: true });
  const job = await waitJob(one.json.jobId);
  need(job.status === 'done', JSON.stringify(job.error || job.result));
  const n = db.get("SELECT COUNT(*) n FROM shot_renders WHERE kind='keyframe' AND shot_id=?", board.shots[0].id).n;
  need(n === 2, `覆盖后记录数 ${n}`);
  return `跳过 ${skip.result.skipped} 镜；单镜覆盖重做后有 ${n} 条记录`;
});
await step('生成镜头视频（本地 ffmpeg 运镜）→ 落盘 + ffprobe 校验', async () => {
  const r = await POST('/api/render/videos', { scriptId: C.script.id, code: C.episode });
  need(r.json.ok && r.json.total > 0, JSON.stringify(r.json).slice(0, 140));
  const job = await waitJob(r.json.jobId, 600000);
  need(job.status === 'done' && job.result.failed === 0, JSON.stringify(job.error || job.result));
  const vids = db.all("SELECT * FROM shot_renders WHERE kind='video' AND status='done'");
  need(vids.length === r.json.total, `视频记录 ${vids.length} / 预期 ${r.json.total}`);
  const abs = vids[0].file_path;
  need(exists(abs) && size(abs) > 1000, '视频文件不存在或过小');
  const probe = ffprobe(abs);
  const st = probe.streams?.[0] || {};
  need(st.codec_name === 'h264' && st.width === 720 && st.height === 1280, JSON.stringify(st).slice(0, 140));
  art('镜头视频', abs, '首镜');
  return `${vids.length} 段 mp4｜示例 ${st.codec_name} ${st.width}x${st.height} ${Number(probe.format?.duration).toFixed(2)}s ${(size(abs) / 1024).toFixed(0)}KB`;
});
await step('按成本级筛选提交视频（省算力通道）', async () => {
  const levels = db.all("SELECT DISTINCT cost_level FROM shots WHERE episode_id=(SELECT id FROM script_episodes WHERE script_id=? AND code=?)", C.script.id, C.episode).map((r) => r.cost_level).filter(Boolean);
  const pick = levels[0] || 'L 静态+运镜';
  const r = await POST('/api/render/videos', { scriptId: C.script.id, code: C.episode, onlyCostLevels: [pick], overwrite: true });
  need(r.json.ok, JSON.stringify(r.json).slice(0, 140));
  const job = await waitJob(r.json.jobId, 600000);
  need(job.status === 'done', JSON.stringify(job.error || job.result));
  return `成本级「${pick}」共 ${r.json.total} 镜已重跑（全部成本级：${levels.join(' / ')}）`;
});
await step('字幕预览（SRT）+ 整集合成（按包装：软字幕 + 静音轨 + 淡入淡出）', async () => {
  const srt = await POST('/api/render/preview-srt', { scriptId: C.script.id, code: C.episode });
  need(srt.json.ok, JSON.stringify(srt.json).slice(0, 140));
  const srtText = srt.json.srt || '';
  const cueCount = Number(srt.json.cues ?? 0);   // buildSRT 返回的是字幕条数（数字）
  const dialogueShots = db.get("SELECT COUNT(*) n FROM shots WHERE episode_id=(SELECT id FROM script_episodes WHERE script_id=? AND code=?) AND IFNULL(dialogue,'') <> ''", C.script.id, C.episode).n;
  need(!/NaN|undefined/.test(srtText), `SRT 结构异常：${srtText.slice(0, 160)}`);
  need(cueCount === dialogueShots, `字幕条数 ${cueCount} 与带台词镜头数 ${dialogueShots} 不一致`);
  need(cueCount === 0 || /-->/.test(srtText), '有字幕条但时间轴缺 --> 标记');
  const asm = await POST('/api/render/assemble', {
    scriptId: C.script.id, code: C.episode,
    finish: { subtitles: true, subtitleMode: 'soft', audio: 'silent', fadeIn: 0.4, fadeOut: 0.6 },
  });
  need(asm.json.ok && asm.json.jobId, JSON.stringify(asm.json).slice(0, 140));
  const job = await waitJob(asm.json.jobId, 600000);
  need(job.status === 'done', JSON.stringify(job.error || job.result));
  const films = (await GET(`/api/render/films?scriptId=${C.script.id}`)).json.films;
  need(films.length >= 1, '成片记录未生成');
  const f = films[0];
  need(exists(f.file_path) && size(f.file_path) > 10000, `成片文件 ${f.file_path} 异常`);
  const probe = ffprobe(f.file_path);
  art('整集成片', f.file_path, `${f.shot_count} 镜`);
  return `成片 ${f.file_path}｜${f.shot_count} 镜 / ${Number(probe.format?.duration).toFixed(1)}s / ${(size(f.file_path) / 1024).toFixed(0)}KB，字幕 ${cueCount} 条`;
});
await step('同一集重复封装互不覆盖（文件名唯一）', async () => {
  const before = (await GET(`/api/render/films?scriptId=${C.script.id}`)).json.films.length;
  const asm = await POST('/api/render/assemble', { scriptId: C.script.id, code: C.episode });
  const job = await waitJob(asm.json.jobId, 600000);
  need(job.status === 'done', JSON.stringify(job.error || job.result));
  const films = (await GET(`/api/render/films?scriptId=${C.script.id}`)).json.films;
  need(films.length === before + 1, `${before} → ${films.length}`);
  const paths = new Set(films.map((f) => f.file_path));
  need(paths.size === films.length, '成片路径重复');
  need(films.every((f) => exists(f.file_path)), '存在成片文件缺失');
  return `${films.length} 个成片，路径互不覆盖`;
});
await step('删除成片（记录 + 文件一起清）与删除单个渲染', async () => {
  if ((await GET(`/api/render/films?scriptId=${C.script.id}`)).json.films.length < 2) {
    const extra = await POST('/api/render/assemble', { scriptId: C.script.id, code: C.episode });
    await waitJob(extra.json.jobId, 600000);
  }
  const films = (await GET(`/api/render/films?scriptId=${C.script.id}`)).json.films;
  need(films.length >= 2, `成片数不足：${films.length}`);
  const victim = films[films.length - 1];
  const del = await DEL(`/api/render/films/${victim.id}`);
  need(del.json.ok && !exists(victim.file_path), `删除成片失败：ok=${del.json.ok} exists=${exists(victim.file_path)}`);
  const left = (await GET(`/api/render/films?scriptId=${C.script.id}`)).json.films;
  need(left.length === films.length - 1 && left.every((f) => exists(f.file_path)), '误删了其它成片文件');
  const other = films[0];
  need(exists(other.file_path), '另一个成片文件被误删');
  const anyKf = db.get("SELECT * FROM shot_renders WHERE kind='keyframe' LIMIT 1");
  const delR = await DEL(`/api/render/renders/${anyKf.id}`);
  need(delR.json.ok, '删除渲染失败');
  return `成片 ${films.length} → ${left.length}（其它成片文件完好）；渲染记录可单独删除`;
});
await step('整季流水线：分镜 → 关键帧 → 视频 → 成片（另一集全程自动）', async () => {
  const codes = db.all('SELECT code FROM script_episodes WHERE script_id=? ORDER BY episode', C.script.id).map((r) => r.code);
  const target = codes[1] || codes[0];
  const r = await POST('/api/render/pipeline', {
    scriptId: C.script.id, codes: [target], stages: ['storyboard', 'keyframe', 'video', 'assemble'],
    finish: { subtitles: true, subtitleMode: 'soft', audio: 'silent' }, provider: 'mock', offline: true,
  });
  need(r.json.ok && r.json.jobId, JSON.stringify(r.json).slice(0, 160));
  const job = await waitJob(r.json.jobId, 900000);
  need(job.status === 'done', JSON.stringify(job.error || job.result).slice(0, 200));
  const films = (await GET(`/api/render/films?scriptId=${C.script.id}`)).json.films;
  const board = (await GET(`/api/render/episode?scriptId=${C.script.id}&code=${target}`)).json;
  need(board.stats.videos === board.stats.shots && board.stats.keyframes === board.stats.shots, JSON.stringify(board.stats));
  art('流水线成片', films[0].file_path, `${target}`);
  return `${target}：${board.stats.shots} 镜全部出图出片，成片共 ${films.length} 个`;
});
await step('视频后端探测：placeholder 就绪 / H3 未配置给中文引导', async () => {
  const ph = await POST('/api/video-backend/probe', { backend: 'placeholder' });
  need(ph.json.ready === true && /ffmpeg/.test(ph.json.detail), JSON.stringify(ph.json).slice(0, 140));
  const h3 = await POST('/api/video-backend/probe', { backend: 'comfyui-h3' });
  need(h3.json.ok === true && h3.json.ready === false && /未配置/.test(h3.json.detail), JSON.stringify(h3.json).slice(0, 160));
  return `placeholder：${ph.json.detail}｜H3：${h3.json.detail}`;
});
await step('单镜试渲染：有图成功 / 无图给中文提示', async () => {
  const anyKf = db.get("SELECT * FROM shot_renders WHERE kind='keyframe' AND status='done' LIMIT 1");
  const ok = await POST('/api/render/test-video', { duration: 1, move: '推镜', keyframe: anyKf.file_path });
  need(ok.json.ok && exists(ok.json.filePath), JSON.stringify(ok.json).slice(0, 140));
  const noKf = await POST('/api/render/test-video', { duration: 1, move: '推镜' });
  need(noKf.json.ok === false && /关键帧/.test(noKf.json.error), JSON.stringify(noKf.json).slice(0, 140));
  return `试渲染 ${ok.json.filePath}；缺关键帧提示「${noKf.json.error.slice(0, 40)}…」`;
});
await step('配音后端探测（未启用 → 中文原因，合成回退静音轨）', async () => {
  const r = await POST('/api/tts-backend/probe', {});
  need(r.json.ok !== undefined && r.json.detail, JSON.stringify(r.json).slice(0, 140));
  const t = await POST('/api/tts-backend/test', {});
  need(t.json.ok === false || typeof t.json.detail === 'string' || t.json.ready === false, JSON.stringify(t.json).slice(0, 140));
  return `${r.json.detail.slice(0, 60)}（试听：${t.json.error || t.json.detail || '已按未启用处理'}）`;
});
await step('清理中间产物：回收临时文件且不动成片', async () => {
  const films = (await GET(`/api/render/films?scriptId=${C.script.id}`)).json.films;
  const before = films.map((f) => f.file_path);
  const r = await POST('/api/render/cleanup', {});
  need(r.json.ok, JSON.stringify(r.json).slice(0, 140));
  need(before.every((p) => exists(p)), '清理误删了成片文件');
  return `释放 ${r.json.freed ?? r.json.removed ?? 0} 个中间文件，${before.length} 个成片完好`;
});

// ════════════════════════════════════════════════════════════════
mod('5 · 画布资产桥（资产包 / 绑定 / 分镜增强 / 参考图 / 导出）');
// ════════════════════════════════════════════════════════════════
await step('画布资产包：环境/物品/参考图分类索引 + 汇总', async () => {
  const r = (await GET('/api/canvas/CV-MAIN/asset-pack')).json;
  need(r.ok && r.pack, JSON.stringify(r).slice(0, 160));
  need(r.pack.scenes?.length >= 1 && r.pack.items?.length >= 1 && r.pack.refs?.length >= 1, `环境 ${r.pack.scenes?.length} / 物品 ${r.pack.items?.length} / 参考图 ${r.pack.refs?.length}`);
  need(r.pack.scenes[0].en && /fog|harbor|pier|wharf|rain|night/i.test(r.pack.scenes[0].en), `环境缺英文令牌：${r.pack.scenes[0].en}`);
  need(r.summary && r.summary.scenes >= 1 && r.summary.items >= 1, JSON.stringify(r.summary));
  return `环境 ${r.summary.scenes} · 物品 ${r.summary.items} · 参考图 ${r.summary.refs} · 演员 ${r.summary.actors} · 连线 ${r.summary.links}｜环境英文令牌「${String(r.pack.scenes[0].en).slice(0, 60)}」`;
});
await step('画布资产导出 md / csv / json', async () => {
  const out = [];
  for (const fmt of ['md', 'csv', 'json']) {
    const r = await GET(`/api/canvas/CV-MAIN/export-assets?format=${fmt}`);
    need(r.status === 200 && r.text.length > 20, `${fmt} 导出失败`);
    out.push(`${fmt} ${r.text.length}B`);
  }
  return out.join(' / ');
});
await step('剧本绑定画布：查询显示绑定成功 / 不存在的画布与剧本被拒', async () => {
  const q = (await GET(`/api/scripts/${C.script.id}/canvas-binding`)).json;
  need(q.ok && q.binding?.canvasId === 'CV-MAIN' && q.binding.scenes.length >= 1, JSON.stringify(q).slice(0, 160));
  const badCanvas = await POST(`/api/scripts/${C.script.id}/canvas-binding`, { canvasId: 'CV-NOT-EXIST' });
  need(badCanvas.status >= 400, `不存在的画布未拦截（${badCanvas.status}）`);
  const badScript = await POST('/api/scripts/NOT-EXIST/canvas-binding', { canvasId: 'CV-MAIN' });
  need(badScript.status >= 400, `不存在的剧本未拦截（${badScript.status}）`);
  return `绑定 ${q.binding.canvasId}「${q.binding.canvasName}」：环境 ${q.binding.scenes.length} · 物品 ${q.binding.items.length} · 参考图 ${q.binding.refs.length}`;
});
await step('关键帧使用画布参考图（useCanvasRefs 开 / 关对比）', async () => {
  const board = (await GET(`/api/render/episode?scriptId=${C.script.id}&code=${C.episode}`)).json;
  const shot = board.shots[0];
  await PUT('/api/settings', { image: { useCanvasRefs: true } });
  const on = await POST('/api/render/keyframes', { scriptId: C.script.id, code: C.episode, shotIds: [shot.id], overwrite: true });
  const jobOn = await waitJob(on.json.jobId);
  need(jobOn.status === 'done', JSON.stringify(jobOn.error || jobOn.result));
  const recOn = db.get("SELECT meta FROM shot_renders WHERE shot_id=? AND kind='keyframe' ORDER BY created_at DESC LIMIT 1", shot.id);
  await PUT('/api/settings', { image: { useCanvasRefs: false } });
  const off = await POST('/api/render/keyframes', { scriptId: C.script.id, code: C.episode, shotIds: [shot.id], overwrite: true });
  const jobOff = await waitJob(off.json.jobId);
  need(jobOff.status === 'done', JSON.stringify(jobOff.error || jobOff.result));
  const recOff = db.get("SELECT meta FROM shot_renders WHERE shot_id=? AND kind='keyframe' ORDER BY created_at DESC LIMIT 1", shot.id);
  await PUT('/api/settings', { image: { useCanvasRefs: true } });
  const mOn = JSON.parse(recOn?.meta || '{}'), mOff = JSON.parse(recOff?.meta || '{}');
  need(Boolean(mOn.canvasRef), `开启后未记录画布参考图：${JSON.stringify(mOn).slice(0, 160)}`);
  need(!mOff.canvasRef, `关闭后仍带参考图：${JSON.stringify(mOff).slice(0, 160)}`);
  return `开启时记录画布参考图 ${mOn.canvasRef}，关闭后无（useCanvasRefs 开关生效）`;
});
await step('解绑画布后新分镜不再带 canvas set 令牌', async () => {
  const before = db.get("SELECT COUNT(*) n FROM shots WHERE episode_id=(SELECT id FROM script_episodes WHERE script_id=? AND code=?)", C.script.id, C.episode).n;
  const un = await DEL(`/api/scripts/${C.script.id}/canvas-binding`);
  need(un.json.ok, '解绑失败');
  const q = (await GET(`/api/scripts/${C.script.id}/canvas-binding`)).json;
  need(q.binding === null, '绑定记录未清空');
  const codes = db.all('SELECT code FROM script_episodes WHERE script_id=? ORDER BY episode', C.script.id).map((r) => r.code);
  const third = codes[2] || codes[0];
  const sb = await POST(`/api/scripts/${C.script.id}/storyboard`, { episode: third, offline: true, sync: true, append: true, overwrite: true });
  need(sb.json.ok !== false, JSON.stringify(sb.json).slice(0, 160));
  const newShots = db.all("SELECT prompt_pos FROM shots WHERE episode_id=(SELECT id FROM script_episodes WHERE script_id=? AND code=?)", C.script.id, third);
  const withToken = newShots.filter((s) => /canvas set:/.test(s.prompt_pos || '')).length;
  need(newShots.length > 0 && withToken === 0, `解绑后仍有 ${withToken} 个镜头带令牌`);
  await POST(`/api/scripts/${C.script.id}/canvas-binding`, { canvasId: 'CV-MAIN' });
  return `${third} 重新生成 ${newShots.length} 镜，带令牌 0 个（已重新绑定）`;
});
await step('全链路收尾：最终统计与产物盘点', async () => {
  const h = (await GET('/api/health')).json;
  const films = (await GET(`/api/render/films?scriptId=${C.script.id}`)).json.films;
  const images = db.get('SELECT COUNT(*) n FROM actor_images').n;
  const nodes = db.get('SELECT COUNT(*) n FROM canvas_nodes WHERE canvas_id=?', 'CV-MAIN').n;
  const links = db.get('SELECT COUNT(*) n FROM canvas_links WHERE canvas_id=?', 'CV-MAIN').n;
  const shots = db.get('SELECT COUNT(*) n FROM shots').n;
  need(films.length >= 2 && images > 0 && nodes > 5 && links >= 3 && shots > 10, JSON.stringify({ films: films.length, images, nodes, links, shots }));
  return `演员 ${h.counts.actors}｜素材图 ${images}｜画布 ${nodes} 节点/${links} 连线｜小说 ${h.counts.novels}（${h.counts.chapters} 章）｜剧本 ${h.counts.scripts}（${shots} 镜）｜成片 ${films.length}`;
});

// ════════════════════════════════════════════════════════════════
mod('6 · 任务队列 / 备份导入 / 流式进度（基础设施）');
// ════════════════════════════════════════════════════════════════
await step('任务取消：批量生成中途取消，任务收口且不留 running 僵尸', async () => {
  const g = await POST('/api/generate/batch', { actorIds: C.actors.map((a) => a.id), kind: 'expression', variants: ['smile', 'angry', 'sad', 'calm'], perVariant: 3 });
  need(g.json.ok && g.json.total >= 12, JSON.stringify(g.json).slice(0, 140));
  const cancel = await POST(`/api/jobs/${g.json.jobId}/cancel`, {});
  need(cancel.json.ok === true, JSON.stringify(cancel.json).slice(0, 120));
  await sleep(600);
  const job = (await GET(`/api/jobs/${g.json.jobId}`)).json.job;
  need(['canceled', 'done'].includes(job.status), `状态 ${job.status}`);
  const running = (await GET('/api/jobs?status=running')).json.jobs || [];
  need(!running.some((j) => j.id === g.json.jobId), '取消后仍是 running');
  if (job.status === 'canceled') {
    need(Number(job.done || 0) <= Number(job.total || 0), `done ${job.done}/${job.total}`);
    return `取消生效：${job.done}/${job.total} 后停止，状态 ${job.status}（${job.error || ''}）`;
  }
  return `批次在取消前已跑完（${job.done}/${job.total}），取消接口幂等返回 ok，无僵尸任务`;
});
await step('任务进度 SSE：/api/jobs-stream 能推事件', async () => {
  const ac = new AbortController();
  const res = await fetch(`${BASE}/api/jobs-stream`, { signal: ac.signal });
  need(res.ok && /text\/event-stream/.test(res.headers.get('content-type') || ''), `content-type=${res.headers.get('content-type')}`);
  const reader = res.body.getReader();
  const g = await POST('/api/generate/batch', { actorIds: [C.actors[0].id], kind: 'face', variants: ['front'], perVariant: 1 });
  let buf = '';
  const t0 = Date.now();
  while (Date.now() - t0 < 10000) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += Buffer.from(value).toString('utf8');
    if (/data:/.test(buf)) break;
  }
  ac.abort();
  await waitJob(g.json.jobId);
  need(/data:/.test(buf), `10s 内未收到任何 SSE 数据：${buf.slice(0, 120)}`);
  const frames = buf.split('\n').filter((l) => l.startsWith('data:')).length;
  return `收到 ${frames} 帧（首帧 ${buf.split('\n').find((l) => l.startsWith('data:')).slice(0, 70)}）`;
});
await step('全量备份导入往返：导出 → 删除 → 导入还原', async () => {
  const mk = await POST('/api/actors', { name: '导入往返测试', gender: 'female', age: 26, style_id: 'jp-anime' });
  const id = mk.json.actor.id;
  const backup = (await GET('/api/export')).json.data;
  need(Array.isArray(backup.actors) && backup.actors.some((a) => a.id === id), '备份里没有刚建的演员');
  await DEL(`/api/actors/${id}`);
  need(db.get('SELECT COUNT(*) n FROM actors WHERE id=?', id).n === 0, '删除失败');
  const imp = await POST('/api/import', { data: backup });
  need(imp.json.ok && imp.json.stats.actors >= 1, JSON.stringify(imp.json).slice(0, 140));
  const row = db.get('SELECT name, gender FROM actors WHERE id=?', id);
  need(row && row.name === '导入往返测试' && row.gender === 'female', JSON.stringify(row));
  await DEL(`/api/actors/${id}`);
  return `备份 ${Object.keys(backup).length} 张表 → 导入回填 ${imp.json.stats.actors} 行，字段一致（已清理测试行）`;
});
await step('LLM 连通性自检（mock 通路；真实 Key 走 SIM_REAL_LLM=1）', async () => {
  const r = await POST('/api/settings/test-llm', {});
  need(r.json.ok === true, JSON.stringify(r.json).slice(0, 160));
  need(typeof r.json.reply === 'string' || typeof r.json.detail === 'string', JSON.stringify(r.json).slice(0, 160));
  return `${r.json.model || 'mock'}｜${String(r.json.reply || r.json.detail).slice(0, 60)}｜${r.json.elapsedMs ?? '?'}ms`;
});

// ════════════════════════════════════════════════════════════════
// 报告
// ════════════════════════════════════════════════════════════════
const finished = new Date();
const secs = ((finished - STARTED) / 1000).toFixed(1);
const mods = [...new Set(RESULTS.map((r) => r.mod))];
const line = (r) => `| ${r.mod} | ${r.feature} | ${r.ok ? '✅' : '❌'} | ${String(r.ev).replace(/\|/g, '\\|').slice(0, 220)} |`;

const report = `# 全模块功能模拟测试报告

> 自动生成：\`node scripts/simulate-all.js\`｜生成时间：${finished.toISOString()}｜耗时 ${secs}s
> 环境：Node ${process.version}｜LLM = ${REAL_LLM ? 'deepseek（真实调用）' : 'mock（离线）'}｜出图 = ${IMAGE_BACKEND}${IMAGE_BACKEND === 'generic-http' ? '（本地 PNG 占位服务）' : '（本地 SVG）'}｜视频 = 本地 ffmpeg 运镜｜临时库 \`${process.env.FACTORY_DB}\`

## 一、总览

| 模块 | 通过 | 失败 |
|---|---|---|
${mods.map((m) => `| ${m} | ${RESULTS.filter((r) => r.mod === m && r.ok).length} | ${RESULTS.filter((r) => r.mod === m && !r.ok).length} |`).join('\n')}
| **合计** | **${pass}** | **${fail}** |

${fail === 0 ? '✅ 所有模块功能模拟全部通过。' : `❌ 有 ${fail} 项失败，详见下表。`}

## 二、逐项结果

| 模块 | 功能点 | 结果 | 证据（落库/落盘/ffprobe/返回结构） |
|---|---|---|---|
${RESULTS.map(line).join('\n')}

## 三、产物清单（真实文件）

| 类型 | 路径 | 说明 |
|---|---|---|
${ARTIFACTS.map((a) => `| ${a.kind} | \`${a.rel}\` | ${a.note} |`).join('\n') || '| — | — | 本次未产出 |'}

## 四、覆盖说明

- **离线可复现**：全程不依赖外部服务（LLM/出图/视频都用本地或 mock），因此可在任何机器上重复运行、零成本。
- **真实文件校验**：关键帧（SVG/PNG）、镜头视频（h264 mp4）、整集成片（含字幕/音轨/淡入淡出）都做了落盘存在性 + \`ffprobe\` 校验。
- **数据隔离**：使用临时 SQLite 与临时数据目录，不触碰 \`data/\` 下的正式数据。
- **未覆盖**：真实厂商出图 API、云端 ComfyUI H3 视频（需要可用实例，另有 \`tests/test-comfy.js\` 52 项离线假实例测试覆盖适配层）、真实 LLM 的文学质量评估（设 \`SIM_REAL_LLM=1\` 可跑真实模型通路，但只验证通路不评估文笔）。
`;
const reportPath = path.join(ROOT, 'docs', '全模块功能模拟测试报告.md');
fs.writeFileSync(reportPath, report, 'utf8');
const jsonPath = path.join(ROOT, 'docs', '全模块功能模拟测试报告.json');
fs.writeFileSync(jsonPath, JSON.stringify({ generatedAt: finished.toISOString(), seconds: Number(secs), pass, fail, env: { node: process.version, realLlm: REAL_LLM, image: IMAGE_BACKEND, imageUrl: IMAGE_BACKEND === 'generic-http' ? IMAGE_URL : null, video: 'ffmpeg' }, results: RESULTS, artifacts: ARTIFACTS }, null, 2), 'utf8');

console.log(`\n${'═'.repeat(60)}`);
for (const m of mods) {
  const p = RESULTS.filter((r) => r.mod === m && r.ok).length;
  const f = RESULTS.filter((r) => r.mod === m && !r.ok).length;
  console.log(`${f === 0 ? '✅' : '❌'} ${m} — ${p} 通过${f ? ` / ${f} 失败` : ''}`);
}
console.log(`${'═'.repeat(60)}`);
console.log(`=== 模拟结果：${pass} 通过 / ${fail} 失败 ===（耗时 ${secs}s）`);
console.log(`报告：${path.relative(ROOT, reportPath)}`);
if (fail) {
  console.log('\n失败项：');
  for (const r of RESULTS.filter((x) => !x.ok)) console.log(`  · [${r.mod}] ${r.feature} — ${r.ev}`);
}

server.close();
try { closeDb?.(); } catch { /* ignore */ }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(fail ? 1 : 0);
