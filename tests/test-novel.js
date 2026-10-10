#!/usr/bin/env node
// 模块2 自测：小说工坊（零依赖，独立 DB，端口 8891）
// 运行：cd /home/linsheng/Desktop/ai-video-factory && node tests/test-novel.js
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.PORT || 8891);
const TMP_ROOT = path.join(os.tmpdir(), `test-novel-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`);
const DB_FILE = process.env.FACTORY_DB || path.join(TMP_ROOT, 'novel.db');
const DATA_TMP = path.join(TMP_ROOT, 'data');
process.env.FACTORY_DB = DB_FILE;
process.env.FACTORY_DATA_DIR = DATA_TMP;
fs.mkdirSync(DATA_TMP, { recursive: true });
process.env.FACTORY_CONFIG = path.join(TMP_ROOT, 'config.json');
fs.writeFileSync(process.env.FACTORY_CONFIG, JSON.stringify({
  llm: { provider: 'mock' },
  image: { backend: 'placeholder' },
  video: { backend: 'placeholder' },
  tts: { backend: 'none' },
}));
for (const f of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }

const BASE = `http://127.0.0.1:${PORT}`;

// ---------- 迷你断言框架 ----------
let passed = 0;
const failures = [];
const skips = [];
function ok(name, extra = '') { passed += 1; console.log(`  ✅ ${name}${extra ? ` — ${extra}` : ''}`); }
function bad(name, err) { failures.push({ name, err: String(err?.message || err) }); console.log(`  ❌ ${name} — ${err?.message || err}`); }
async function check(name, fn) {
  try { const extra = await fn(); ok(name, typeof extra === 'string' ? extra : ''); } catch (e) { bad(name, e); }
}
function skip(name, why) { skips.push(`${name}（${why}）`); console.log(`  ⏭  ${name} — 跳过：${why}`); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 附件下载等非 JSON 响应 */ }
  return { status: res.status, json, text, headers: res.headers };
}

// ---------- 启动服务（独立 DB） ----------
const { createApp } = await import('../src/http.js');
const db = await import('../src/db.js');
const { registerNovelRoutes } = await import('../src/routes/novel.js');
const { registerMetaRoutes } = await import('../src/routes/meta.js');
const { countWords } = await import('../src/util.js');
const { llmStatus } = await import('../src/llm.js');

db.migrate();
// 造 3 名演员（模块1 演员表），用于测试引用绑定
db.run("INSERT INTO actors(id,name,role_type,gender,age,personality,background,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
  'C-0001', '林清雪', '主角', '女', 19, '冷静果断，剑术天才', '青芜剑宗门内弟子，身负灭门之仇', new Date().toISOString(), new Date().toISOString());
db.run("INSERT INTO actors(id,name,role_type,gender,age,personality,background,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
  'C-0002', '萧无咎', '反派', '男', 34, '阴狠多疑', '天枢阁阁主，操纵朝局', new Date().toISOString(), new Date().toISOString());
db.run("INSERT INTO actors(id,name,role_type,gender,age,personality,background,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
  'C-0003', '阿砚', '搭档', '男', 22, '憨直忠诚', '药堂学徒', new Date().toISOString(), new Date().toISOString());

const { app, handle } = createApp();
registerNovelRoutes(app);
registerMetaRoutes(app);   // 任务轮询 /api/jobs/:id、上传 /api/upload（前端 ctx.watchJob 依赖）
const server = http.createServer((req, res) => handle(req, res, { staticMounts: [] }));
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(PORT, '127.0.0.1', resolve);
});

let uploadedRel = null;
const cleanup = () => {
  try { server.close(); } catch { /* ignore */ }
  if (uploadedRel) { try { fs.rmSync(path.join(db.ROOT, uploadedRel), { force: true }); } catch { /* ignore */ } }
  for (const f of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
};
process.on('SIGINT', () => { cleanup(); process.exit(1); });

console.log('==========================================================');
console.log(`模块2 自测 · DB=${DB_FILE} · PORT=${PORT}`);
console.log(`LLM: ${JSON.stringify(llmStatus())}`);
console.log('==========================================================');

let novelId = null;
let outlineId = null;
let realLlmUsed = 0;

// ---------- 1. 元信息 / 列表 ----------
console.log('\n[1] 元信息与列表');
await check('GET /api/novels/options 返回 100 题材 + 视角 + 上限', async () => {
  const r = await api('GET', '/api/novels/options');
  assert(r.status === 200 && r.json.ok, `状态码 ${r.status}`);
  assert(r.json.genres.length === 100, `题材数 ${r.json.genres.length} ≠ 100`);
  assert(r.json.genreCategories.length >= 8, `分类数 ${r.json.genreCategories.length}`);
  assert(r.json.povs.length >= 5, '视角字典缺失');
  assert(r.json.limits.castSize.max === 200, 'castSize 上限不是 200');
  assert(r.json.limits.targetWords.max === 10000000, 'targetWords 上限不是 1000 万');
  assert(r.json.limits.chapterWords.min === 1000 && r.json.limits.chapterWords.max === 3000, '章节字数区间不对');
  return `题材 ${r.json.genres.length} 种 / 分类 ${r.json.genreCategories.length} 个`;
});
await check('GET /api/novels 空列表', async () => {
  const r = await api('GET', '/api/novels');
  assert(r.status === 200 && r.json.ok && Array.isArray(r.json.novels), '返回结构不对');
  assert(r.json.novels.length === 0, '初始应为空');
});

// ---------- 2. 创建小说 + 校验 ----------
console.log('\n[2] 创建小说与参数校验（越界必须被拒）');
await check('POST /api/novels 创建（引用演员 + 自定义角色 + 参考范本字段）', async () => {
  const r = await api('POST', '/api/novels', {
    title: '剑落青芜',
    genre: 'classic-xianxia',
    tone: '史诗厚重',
    scale: 'long',
    cast_size: 60,
    target_words: 120000,
    chapter_words: 2000,
    pov: 'third-limited',
    seasons: 2,
    framework_intro: '青芜剑宗一夜灭门，唯一活下来的小师妹带着半截断剑下山。她要查清灭门真相，却发现仇人正是当年救她的人。故事跨越两季，围绕「复仇是否值得」展开，中间穿插十年后的闪回。',
    actor_ids: ['C-0001', 'C-0002'],
    custom_actors: [{ name: '沈砚舟', role: '导师', gender: '男', age: 41, desc: '隐居剑冢的旧日军师，知道灭门真相的一半' }],
    ref_doc_path: 'data/uploads/demo-ref.txt',
    ref_doc_name: '参考范本.txt',
  });
  assert(r.status === 200 && r.json.ok, `状态码 ${r.status}：${r.text.slice(0, 200)}`);
  const n = r.json.novel;
  assert(/^N-\d{4}$/.test(n.id), `编号格式异常 ${n.id}`);
  assert(n.cast_total === 3, `角色总数 ${n.cast_total}`);
  assert(n.genre_name === '古典仙侠', `题材名 ${n.genre_name}`);
  assert(n.planned_chapters === 60, `推导章节数 ${n.planned_chapters}`);
  novelId = n.id;
  return `${n.id}《${n.title}》题材=${n.genre_name} 推导章节=${n.planned_chapters} 角色=${n.cast_total}`;
});
await check('POST /api/novels cast_size=300 被拒（中文错误）', async () => {
  const r = await api('POST', '/api/novels', { title: '越界测试', cast_size: 300 });
  assert(r.status === 400, `期望 400，实际 ${r.status}`);
  assert(/角色规模/.test(r.json.error) && r.json.ok === false, `错误信息：${r.json.error}`);
  return r.json.error;
});
await check('POST /api/novels chapter_words=500 被拒', async () => {
  const r = await api('POST', '/api/novels', { title: '越界测试2', chapter_words: 500 });
  assert(r.status === 400, `期望 400，实际 ${r.status}`);
  assert(/章节字数/.test(r.json.error), `错误信息：${r.json.error}`);
  return r.json.error;
});
await check('POST /api/novels target_words=20000000 被拒（超 1000 万）', async () => {
  const r = await api('POST', '/api/novels', { title: '越界测试3', target_words: 20000000 });
  assert(r.status === 400, `期望 400，实际 ${r.status}`);
  assert(/总字数/.test(r.json.error), `错误信息：${r.json.error}`);
  return r.json.error;
});
await check('角色数超过 cast_size 被拒', async () => {
  const r = await api('POST', '/api/novels', { title: '越界测试4', cast_size: 2, actor_ids: ['C-0001', 'C-0002'], custom_actors: [{ name: '甲' }, { name: '乙' }] });
  assert(r.status === 400 && /角色总数/.test(r.json.error), `状态 ${r.status} 错误 ${r.json?.error}`);
  return r.json.error;
});
await check('引用不存在的演员被拒', async () => {
  const r = await api('POST', '/api/novels', { title: '越界测试5', actor_ids: ['C-9999'] });
  assert(r.status === 400 && /找不到/.test(r.json.error), `状态 ${r.status} 错误 ${r.json?.error}`);
  return r.json.error;
});
await check('未知叙事视角被拒', async () => {
  const r = await api('POST', '/api/novels', { title: '越界测试6', pov: '不存在的视角' });
  assert(r.status === 400 && /视角/.test(r.json.error), `状态 ${r.status} 错误 ${r.json?.error}`);
});
await check('未生成大纲时批量写作被拒', async () => {
  const r = await api('POST', `/api/novels/${novelId}/chapters/generate`, { mode: 'all' });
  assert(r.status === 400 && /大纲/.test(r.json.error), `状态 ${r.status} 错误 ${r.json?.error}`);
  return r.json.error;
});

// ---------- 3. 大纲：先跑非 LLM 分支（mock 模板），再验真实 chatJSON 通路 ----------
console.log('\n[3] 生成大纲');
await check('POST /outline（provider=mock 离线模板，验证全链路但不联网）', async () => {
  const r = await api('POST', `/api/novels/${novelId}/outline`, { provider: 'mock', chapterCount: 6 });
  assert(r.status === 200 && r.json.ok, `状态码 ${r.status}：${r.text.slice(0, 300)}`);
  const o = r.json.outline;
  assert(/^O-\d{4}$/.test(o.id), `大纲编号异常 ${o.id}`);
  assert(o.version === 1, `版本 ${o.version}`);
  const s = o.sections || {};
  for (const k of ['logline', 'framework', 'volumes', 'chapters', 'timeline', 'locations', 'characters', 'foreshadow', 'reversals', 'beats', 'hooks', 'loops', 'logic']) {
    assert(s[k] !== undefined, `缺少大纲分节 ${k}`);
  }
  assert(s.chapters.length === 6, `章节骨架 ${s.chapters.length} ≠ 6`);
  assert(s.meta.planned === 6, `meta.planned=${s.meta.planned}`);
  outlineId = o.id;
  return `版本${o.version} 章节${s.chapters.length} 分节${Object.keys(s).length} 模型=${o.model}`;
});
await check('POST /outline 支持 instruction 额外要求（写入 meta 并注入提示词）', async () => {
  const r = await api('POST', `/api/novels/${novelId}/outline`, { provider: 'mock', chapterCount: 4, instruction: '前三章节奏加快；反派在第 3 章登场；伏笔在第 8 章回收' });
  assert(r.status === 200 && r.json.ok, `状态码 ${r.status}：${r.json?.error}`);
  assert(/反派在第 3 章登场/.test(r.json.outline.sections.meta.instruction || ''), '额外的生成要求未记录到 meta');
  const prompts = await import('../src/modules/novel.js');
  const text = prompts.buildOutlinePrompt({ title: 'T', target_words: 4000, chapter_words: 1000, seasons: 1 }, { cast: [], from: 1, to: 2, planned: 4, instruction: '反派在第 3 章登场' });
  assert(text.includes('作者额外要求') && text.includes('反派在第 3 章登场'), 'instruction 未注入提示词');
  return 'extra instruction → 提示词 + meta.instruction';
});
await check('POST /outline 非法 chapterCount 被下限保护为 1 章（不崩溃）', async () => {
  const r = await api('POST', `/api/novels/${novelId}/outline`, { chapterCount: 0, provider: 'mock' });
  assert(r.status === 200 && r.json.ok, `状态码 ${r.status}：${r.json?.error}`);
  assert(r.json.outline.sections.chapters.length === 1, `章节数 ${r.json.outline.sections.chapters.length}`);
  const n = (await api('GET', `/api/novels/${novelId}`)).json.chapters.length;
  assert(n === 1, `章节骨架未同步，仍有 ${n} 章`);
  return 'chapterCount=0 → 规划 1 章，骨架同步为 1 行';
});
await check('POST /outline chapterCount=999 被 200 章上限保护', async () => {
  const r = await api('POST', `/api/novels/${novelId}/outline`, { chapterCount: 999, provider: 'mock', batchSize: 40 });
  assert(r.status === 200 && r.json.ok, `状态码 ${r.status}`);
  assert(r.json.outline.sections.chapters.length === 200, `章节数 ${r.json.outline.sections.chapters.length} 应为 200`);
  assert(r.json.summary.planned === 200, `summary.planned=${r.json.summary.planned}`);
  assert(r.json.outline.sections.meta.byWords === 60, `byWords=${r.json.outline.sections.meta.byWords}`);
  assert(r.json.summary.calls >= 2, `分批调用次数 ${r.json.summary.calls}（200 章应分批）`);
  return `规划 ${r.json.outline.sections.chapters.length} 章（byWords=60，分批 ${r.json.summary.calls} 次调用）`;
});
await check('「续规划」模式：保留前 N 章大纲，从第 N 章往后继续规划（分卷/分批继续）', async () => {
  const c = await api('POST', '/api/novels', { title: '续规划测试', genre: 'eastern-fantasy', cast_size: 8, target_words: 10000, chapter_words: 1000 });
  assert(c.status === 200, `创建失败 ${c.status}`);
  const id = c.json.novel.id;
  const base = await api('POST', `/api/novels/${id}/outline`, { provider: 'mock', chapterCount: 4 });
  assert(base.status === 200 && base.json.outline.sections.chapters.length === 4, `首批规划失败：${base.status}`);
  const firstSummary = base.json.outline.sections.chapters[0].summary;
  const ap = await api('POST', `/api/novels/${id}/outline`, { provider: 'mock', chapterFrom: 5, chapterCount: 3, batchSize: 5 });
  assert(ap.status === 200 && ap.json.ok, `续规划失败 ${ap.status}：${(ap.json?.error || ap.text).slice(0, 200)}`);
  const chs = ap.json.outline.sections.chapters;
  assert(chs.length === 7, `续规划后章节数 ${chs.length} ≠ 7`);
  assert(chs.map((x) => x.idx).join(',') === '1,2,3,4,5,6,7', `章节 idx 不连续：${chs.map((x) => x.idx).join(',')}`);
  assert(chs[0].summary === firstSummary, '第 1 章既有大纲被改动（应保留）');
  assert(ap.json.outline.version === base.json.outline.version + 1, '续规划未产生新版本');
  assert(ap.json.summary.warnings.some((w) => /续规划模式/.test(w)), '缺少续规划提示');
  const noOutline = await api('POST', '/api/novels/N-9999/outline', { provider: 'mock', chapterFrom: 5, chapterCount: 2 });
  assert(noOutline.status === 404, `不存在的小说应 404，实际 ${noOutline.status}`);
  await api('DELETE', `/api/novels/${id}`);
  return `4 章 → 续规划 5~7 章 → 共 ${chs.length} 章，第 1 章摘要未被改动，版本 v${base.json.outline.version}→v${ap.json.outline.version}`;
});
await check('1000 万字超长篇：byWords 超上限时给出分卷/分批提示', async () => {
  const c = await api('POST', '/api/novels', { title: '万古长河', genre: 'myriad-races', target_words: 10000000, chapter_words: 1000, cast_size: 200 });
  assert(c.status === 200, `创建失败 ${c.status}`);
  const bigId = c.json.novel.id;
  const r = await api('POST', `/api/novels/${bigId}/outline`, { provider: 'mock', batchSize: 40 });
  assert(r.status === 200 && r.json.ok, `状态码 ${r.status}`);
  assert(r.json.outline.sections.meta.byWords === 10000, `byWords=${r.json.outline.sections.meta.byWords}`);
  assert(r.json.outline.sections.chapters.length === 200, `章节数 ${r.json.outline.sections.chapters.length}`);
  const warn = (r.json.summary.warnings || []).find((w) => /上限/.test(w));
  assert(warn, `缺少上限提示：${JSON.stringify(r.json.summary.warnings)}`);
  await api('DELETE', `/api/novels/${bigId}`);
  return `1000 万字 → 推导 10000 章，单次规划 200 章；提示：${warn.slice(0, 40)}…`;
});
await check('GET /outline 读取最新大纲（含 13 个分节 + 版本列表）', async () => {
  const r = await api('GET', `/api/novels/${novelId}/outline`);
  assert(r.status === 200 && r.json.ok && r.json.outline, '未返回大纲');
  const s = r.json.outline.sections;
  const sections = ['framework', 'volumes', 'chapters', 'timeline', 'locations', 'characters', 'foreshadow', 'reversals', 'beats', 'hooks', 'loops', 'logic'];
  for (const k of sections) assert(s[k] !== undefined, `分节缺失 ${k}`);
  assert(r.json.versions.length >= 2, `版本数 ${r.json.versions.length}`);
  assert(r.json.chapters.length === r.json.outline.sections.chapters.length, '章节骨架行数与大纲不一致');
  return `版本 ${r.json.versions.map((v) => v.version).join(',')} / 骨架 ${r.json.chapters.length} 章`;
});
await check('GET /:id 详情（大纲 + 章节列表不含正文 + 统计 + 演员）', async () => {
  const r = await api('GET', `/api/novels/${novelId}`);
  assert(r.status === 200 && r.json.ok, `状态码 ${r.status}`);
  assert(r.json.chapters.every((c) => c.content === undefined), '章节列表泄露了正文');
  assert(r.json.stats.total === r.json.chapters.length, '统计不一致');
  assert(r.json.actors.length === 2 && r.json.cast.length === 3, `演员/角色数 ${r.json.actors.length}/${r.json.cast.length}`);
  assert(r.json.ref_doc.path === 'data/uploads/demo-ref.txt', '参考范本字段未保存');
  assert(r.json.llm && typeof r.json.llm.ready === 'boolean', 'llm 状态缺失');
  return `章节 ${r.json.chapters.length} / 角色 ${r.json.cast.length} / 参考范本 ${r.json.ref_doc.name}`;
});
await check('POST /outline/optimize 缺少指令被拒', async () => {
  const r = await api('POST', `/api/novels/${novelId}/outline/optimize`, {});
  assert(r.status === 400 && /优化指令/.test(r.json.error), `状态 ${r.status} 错误 ${r.json?.error}`);
  return r.json.error;
});
await check('POST /outline/optimize（provider=mock）产出新版本且保留全部章节', async () => {
  const before = (await api('GET', `/api/novels/${novelId}/outline`)).json.outline;
  const r = await api('POST', `/api/novels/${novelId}/outline/optimize`, { instruction: '前三章节奏加快，把伏笔 F-01 提前到第 3 章回收', provider: 'mock' });
  assert(r.status === 200 && r.json.ok, `状态码 ${r.status}：${r.text.slice(0, 200)}`);
  assert(r.json.outline.version === before.version + 1, `版本未递增：${r.json.outline.version} vs ${before.version}`);
  assert(r.json.outline.sections.chapters.length === before.sections.chapters.length, '章节数被改变（应为只改内容不删章）');
  assert(r.json.outline.sections.meta.instruction, '未记录优化指令');
  return `v${before.version} → v${r.json.outline.version}，章节仍为 ${r.json.outline.sections.chapters.length} 章`;
});

// ---------- 4. 真实 LLM 小调用（验证 chatJSON 通路） ----------
// 花费闸门（G-101 测试花费审计线登记）：本节会**真实付费**调用 1 次 LLM（chatJSON 通路），
// 前提是当前配置有可用 API Key（llmStatus().ready）。此前它没有任何开关、也无任何账目记录
// （LLM token 不进 app_config['usage:monthly'] —— 该台账只统计 images/videos/ttsChars），
// 即：默认口径下每跑一次本套件就真花 1 次模型调用的钱。
// 现补上与 tests/test-script.js 同名同语义的开关 SKIP_REAL_LLM=1（默认行为不变，去掉即恢复本节覆盖）。
const REAL_LLM = process.env.SKIP_REAL_LLM !== '1';
console.log(`\n[4] 真实 LLM 调用（chatJSON 通路，1 次，仅总纲+首批章节）｜${REAL_LLM ? '开启（会真实计费）' : '已跳过（SKIP_REAL_LLM=1）'}`);
if (!REAL_LLM) {
  skip('真实 LLM 大纲生成', '已按 SKIP_REAL_LLM=1 跳过（避免付费调用；去掉该环境变量即可恢复本节覆盖）');
} else if (!llmStatus().ready) {
  skip('真实 LLM 大纲生成', 'LLM 未配置（无 API Key）');
} else {
  try {
    const created = await api('POST', '/api/novels', {
      title: '青芜剑雨（真实 LLM 小样）', genre: 'classic-xianxia', cast_size: 10,
      target_words: 10000, chapter_words: 1000, pov: 'third-limited', seasons: 1,
      framework_intro: '灭门之夜，少女握断剑逃离。十年后她以另一种身份回到故乡，只想问一句为什么。',
      actor_ids: ['C-0001', 'C-0002'],
    });
    assert(created.status === 200, `创建失败 ${created.status}`);
    const smallId = created.json.novel.id;
    const t0 = Date.now();
    const r = await api('POST', `/api/novels/${smallId}/outline`, { chapterCount: 3 });
    realLlmUsed += 1;
    assert(r.status === 200 && r.json.ok, `状态码 ${r.status}：${(r.json?.error || r.text).slice(0, 300)}`);
    const s = r.json.outline.sections;
    assert(s.chapters.length === 3, `章节数 ${s.chapters.length}`);
    assert(s.chapters[0].summary && s.chapters[0].summary.length > 10, '第 1 章摘要为空');
    assert(s.foreshadow.length > 0 || s.timeline.length > 0, '伏笔/时间线为空');
    assert(r.json.summary.calls >= 1, '调用次数异常');
    ok('真实 LLM 生成大纲（chatJSON 通路）', `模型=${r.json.outline.model} 调用=${r.json.summary.calls} 次 章节=${s.chapters.length} 耗时=${Date.now() - t0}ms tokens=${r.json.outline.tokens}`);
    console.log(`     · 一句话故事：${(s.logline || '').slice(0, 60)}`);
    console.log(`     · 地点档案 ${s.locations.length} 条｜人物 ${s.characters.length} 名｜伏笔 ${s.foreshadow.length} 条｜时间线 ${s.timeline.length} 条｜回路 ${s.loops.length} 条`);
    if (s.warnings?.length) console.log(`     · 警告：${s.meta.warnings.slice(0, 3).join(' | ')}`);
    await api('DELETE', `/api/novels/${smallId}`);
  } catch (e) {
    bad('真实 LLM 生成大纲（chatJSON 通路）', e);
  }
}
console.log(`  （真实 LLM 调用次数：${realLlmUsed}，契约上限 1~2 次）`);

// ---------- 5. 章节写作（job）+ CRUD ----------
console.log('\n[5] 章节写作任务与章节 CRUD');
let jobId = null;
await check('POST /chapters/generate 建任务（provider=mock，range 1~2）', async () => {
  const r = await api('POST', `/api/novels/${novelId}/chapters/generate`, { mode: 'range', from: 1, to: 2, provider: 'mock' });
  assert(r.status === 200 && r.json.ok, `状态码 ${r.status}：${r.text.slice(0, 200)}`);
  assert(r.json.total === 2 && /^JOB-/.test(r.json.jobId), `返回 ${JSON.stringify(r.json).slice(0, 200)}`);
  jobId = r.json.jobId;
  return `jobId=${jobId} total=${r.json.total}`;
});
await check('轮询任务直到完成，章节正文落库（含词数统计）', async () => {
  assert(jobId, '没有 jobId');
  let job = null;
  for (let i = 0; i < 80; i++) {
    const r = await api('GET', `/api/jobs/${jobId}`);
    job = r.json?.job;
    if (job && ['done', 'error', 'canceled'].includes(job.status)) break;
    await new Promise((res) => setTimeout(res, 200));
  }
  assert(job, '任务不存在');
  assert(job.status === 'done', `任务状态 ${job.status}：${job.error || ''}`);
  assert(job.result.ok === 2, `成功数 ${job.result.ok}`);
  const c1 = await api('GET', `/api/novels/${novelId}/chapters/1`);
  assert(c1.json.chapter.status === 'done' && c1.json.chapter.words > 0, `第 1 章状态 ${c1.json.chapter.status} 字数 ${c1.json.chapter.words}`);
  assert(c1.json.chapter.content.length > 20, '正文过短');
  assert(c1.json.chapter.words === countWords(c1.json.chapter.content), 'words 与 countWords 不一致');
  return `job ${job.done}/${job.total}，第 1 章 ${c1.json.chapter.words} 字，第 2 章同批完成`;
});
await check('GET 章节返回正文，进度统计更新', async () => {
  const r = await api('GET', `/api/novels/${novelId}/chapters/2`);
  assert(r.status === 200 && r.json.chapter.idx === 2, '章节读取失败');
  const d = await api('GET', `/api/novels/${novelId}`);
  assert(d.json.stats.written === 2, `已写章数 ${d.json.stats.written}`);
  assert(d.json.stats.words > 0, '总字数为 0');
  return `已写 ${d.json.stats.written}/${d.json.stats.total} 章，共 ${d.json.stats.words} 字`;
});
await check('PUT /chapters/1 手动保存正文并按 countWords 统计', async () => {
  const content = '第 1 章 断剑\n\n青芜山上的第一场雪落在剑冢的石碑上，林清雪跪在碑前，指尖按着那半截断剑的缺口。\n\n“师父，我会回来的。”她说。';
  const r = await api('PUT', `/api/novels/${novelId}/chapters/1`, { content, title: '断剑（手改）' });
  assert(r.status === 200 && r.json.ok, `状态码 ${r.status}`);
  assert(r.json.chapter.title === '断剑（手改）', '标题未更新');
  const expected = countWords(content);
  assert(r.json.words === expected, `字数 ${r.json.words} ≠ ${expected}`);
  const back = await api('GET', `/api/novels/${novelId}/chapters/1`);
  assert(back.json.chapter.content === content, '正文未落库');
  return `${expected} 字（countWords 一致）`;
});
await check('PUT /chapters/1 空 body 被拒 / 非法 idx 被拒', async () => {
  const a = await api('PUT', `/api/novels/${novelId}/chapters/1`, {});
  assert(a.status === 400 && /至少一项/.test(a.json.error), `状态 ${a.status} 错误 ${a.json?.error}`);
  const b = await api('GET', `/api/novels/${novelId}/chapters/abc`);
  assert(b.status === 400 && /章节序号/.test(b.json.error), `状态 ${b.status} 错误 ${b.json?.error}`);
  const c = await api('GET', `/api/novels/${novelId}/chapters/9999`);
  assert(c.status === 404, `期望 404，实际 ${c.status}`);
  return '空 body 400 / abc 400 / 9999 404';
});
await check('POST /chapters/3/generate 单章重写（job）', async () => {
  const r = await api('POST', `/api/novels/${novelId}/chapters/3/generate`, { provider: 'mock' });
  assert(r.status === 200 && r.json.total === 1 && r.json.idxs[0] === 3, `返回 ${r.text.slice(0, 200)}`);
  let job = null;
  for (let i = 0; i < 80; i++) {
    const g = await api('GET', `/api/jobs/${r.json.jobId}`);
    job = g.json?.job;
    if (job && ['done', 'error', 'canceled'].includes(job.status)) break;
    await new Promise((res) => setTimeout(res, 200));
  }
  assert(job?.status === 'done', `任务状态 ${job?.status}：${job?.error || ''}`);
  const c3 = await api('GET', `/api/novels/${novelId}/chapters/3`);
  assert(c3.json.chapter.status === 'done' && c3.json.chapter.words > 0, `第 3 章未写入（${c3.json.chapter.status}）`);
  return `第 3 章重写完成，${c3.json.chapter.words} 字`;
});
await check('GET /chapters/generate（GET 不支持）被参数校验挡下，不误判为章节号', async () => {
  const r = await api('GET', `/api/novels/${novelId}/chapters/generate`);
  assert(r.status === 400 && /章节序号/.test(r.json.error), `状态码 ${r.status} 错误 ${r.json?.error}`);
  return r.json.error;
});
await check('DELETE /chapters/6 删除章节并更新统计', async () => {
  const before = (await api('GET', `/api/novels/${novelId}`)).json.stats.total;
  const r = await api('DELETE', `/api/novels/${novelId}/chapters/6`);
  assert(r.status === 200 && r.json.ok, `状态码 ${r.status}`);
  assert(r.json.stats.total === before - 1, `统计未更新 ${r.json.stats.total} vs ${before}`);
  const gone = await api('GET', `/api/novels/${novelId}/chapters/6`);
  assert(gone.status === 404, `删除后仍可读取：${gone.status}`);
  return `章节数 ${before} → ${r.json.stats.total}`;
});

// ---------- 6. 演员绑定 / 更新 / 导出 ----------
console.log('\n[6] 参考范本上传 · 演员绑定 · 更新 · 导出');
await check('上传参考范本（/api/upload）→ 绑定 ref_doc_path → 正文可回读并注入大纲', async () => {
  const text = '【范本】第一章以雨夜开场，用三句话立住主角的执念；每章末尾留一个反问式钩子。';
  const fd = new FormData();
  fd.append('file', new Blob([text], { type: 'text/plain' }), 'ref-fanben.txt');
  const up = await fetch(`${BASE}/api/upload`, { method: 'POST', body: fd });
  const uj = await up.json();
  assert(up.status === 200 && uj.ok && uj.files?.[0]?.path, `上传失败：${up.status} ${JSON.stringify(uj).slice(0, 200)}`);
  const rel = uj.files[0].path;
  uploadedRel = rel;
  const read = await api('GET', `/api/upload/text?path=${encodeURIComponent(rel)}`);
  assert(read.json.text.includes('反问式钩子'), '上传的正文读取失败');
  const upd = await api('PUT', `/api/novels/${novelId}`, { ref_doc_path: rel, ref_doc_name: 'ref-fanben.txt' });
  assert(upd.status === 200 && upd.json.novel.ref_doc_path === rel, `绑定失败：${upd.json?.error}`);
  const detail = await api('GET', `/api/novels/${novelId}`);
  assert(detail.json.ref_doc.preview.includes('反问式钩子'), '详情未回读范本正文');
  const mod = await import('../src/modules/novel.js');
  const injected = mod.readRefDoc(mod.getNovel(novelId));
  assert(injected.text.includes('反问式钩子'), 'readRefDoc 未取到范本正文（大纲注入依赖它）');
  return `${rel}（${read.json.text.length} 字，已注入大纲提示词上下文）`;
});
await check('POST /:id/actors 更新绑定（引用 + 自定义，合计受限）', async () => {
  const r = await api('POST', `/api/novels/${novelId}/actors`, {
    actorIds: ['C-0001', 'C-0002', 'C-0003'],
    customActors: [{ name: '沈砚舟', role: '导师', gender: '男', age: 41, desc: '旧日军师' }, { name: '苏九娘', role: '女配', gender: '女', age: 26, desc: '酒楼说书人' }],
  });
  assert(r.status === 200 && r.json.ok, `状态码 ${r.status}：${r.text.slice(0, 200)}`);
  assert(r.json.cast.length === 5, `角色数 ${r.json.cast.length}`);
  assert(r.json.novel.actor_ids.length === 3, 'actor_ids 未更新');
  const bad = await api('POST', `/api/novels/${novelId}/actors`, { actorIds: ['C-0001'], customActors: Array.from({ length: 200 }, (_, i) => ({ name: `角色${i}` })) });
  assert(bad.status === 400 && /200/.test(bad.json.error), `超过 200 上限未被拒：${bad.status} ${bad.json?.error}`);
  return `绑定 ${r.json.cast.length} 名（3 演员 + 2 自定义），超 200 上限请求已拒绝`;
});
await check('PUT /:id 更新参数，越界仍被拒', async () => {
  const r = await api('PUT', `/api/novels/${novelId}`, { chapter_words: 3000, target_words: 900000 });
  assert(r.status === 200 && r.json.novel.chapter_words === 3000, `状态码 ${r.status}`);
  const bad = await api('PUT', `/api/novels/${novelId}`, { chapter_words: 900 });
  assert(bad.status === 400 && /章节字数/.test(bad.json.error), `越界未被拒：${bad.status}`);
  assert((await api('GET', `/api/novels/${novelId}`)).json.novel.chapter_words === 3000, '越界请求竟然写入了');
  return '章节字数 2000 → 3000；900 被拒且未写入';
});
await check('GET /export?format=txt（JSON 模式返回 {ok,content}）', async () => {
  const r = await api('GET', `/api/novels/${novelId}/export?format=txt`);
  assert(r.status === 200 && r.json.ok, `状态码 ${r.status}`);
  assert(r.json.content.includes('《剑落青芜》'), '缺少标题');
  assert(/第 1 章/.test(r.json.content), '缺少章节');
  assert(r.json.content.includes('断剑（手改）'), '缺少手改后的章节标题');
  assert(r.json.content.includes('青芜山上的第一场雪'), '缺少正文');
  return `${r.json.filename} / ${r.json.bytes} 字节`;
});
await check('GET /export?format=md 与 format=json', async () => {
  const md = await api('GET', `/api/novels/${novelId}/export?format=md`);
  assert(md.status === 200 && /#\s*剑落青芜/.test(md.json.content), 'md 缺少一级标题');
  const js = await api('GET', `/api/novels/${novelId}/export?format=json`);
  const data = JSON.parse(js.json.content);
  assert(data.novel.id === novelId && Array.isArray(data.chapters), 'json 结构不对');
  assert(data.outline && data.outline.data.chapters, 'json 缺少大纲');
  const bad = await api('GET', `/api/novels/${novelId}/export?format=pdf`);
  assert(bad.status === 400 && /不支持的导出格式/.test(bad.json.error), `非法格式未被拒：${bad.status}`);
  return `md ${md.json.bytes} 字节 / json ${js.json.bytes} 字节；pdf 被拒`;
});
await check('GET /export?download=1 直接输出附件（Content-Disposition）', async () => {
  const res = await fetch(`${BASE}/api/novels/${novelId}/export?format=txt&download=1`);
  assert(res.status === 200, `状态码 ${res.status}`);
  const cd = res.headers.get('content-disposition') || '';
  assert(/attachment/.test(cd), `缺少 attachment：${cd}`);
  assert(/filename\*=UTF-8''/.test(cd), '缺少 UTF-8 文件名');
  const body = await res.text();
  assert(body.includes('《剑落青芜》'), '附件内容不对');
  return cd.slice(0, 80);
});

// ---------- 7. 前端视图渲染冒烟（DOM 桩，无需浏览器） ----------
console.log('\n[7] 前端视图渲染冒烟 test web/views/novel.js');
const toasts = [];
const modals = [];
const goCalls = [];
let uiRoot = null;
let uiHandlers = null;
let uiView = null;
function installDomStub() {
  const mkEl = (tag = 'div') => {
    const el = {
      tagName: tag, style: {}, dataset: {}, children: [], innerHTML: '', textContent: '', value: '', type: '', checked: false,
      id: '', files: [],
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      appendChild(c) { this.children.push(c); return c; },
      insertAdjacentHTML() {}, replaceWith() {}, remove() {},
      addEventListener() {}, removeEventListener() {},
      querySelector: (sel) => queryFor(sel),
      querySelectorAll: () => [],
      closest: () => null, contains: () => false, focus() {}, setSelectionRange() {}, click() {},
    };
    return el;
  };
  const defaults = {
    title: '烟雨楼纪事', tone: '史诗厚重', pov: 'third-limited', cast_size: '20', seasons: '1',
    target_words: '100000', chapter_words: '2000', framework_intro: '框架介绍', genreQ: '', actorQ: '', q: '',
    content: '正文内容', mode: 'next', from: '1', to: '1', count: '1', cname: '', crole: '', cdesc: '', cage: '', cgender: '',
  };
  function queryFor(sel) {
    const m = /data-role="([^"]+)"/.exec(String(sel));
    if (m) {
      const el = mkEl('input');
      el.dataset.role = m[1];
      el.value = defaults[m[1]] ?? '';
      if (m[1] === 'force') { el.type = 'checkbox'; el.checked = false; }
      else if (/size|words|seasons|age|from|to|count/.test(m[1])) el.type = 'number';
      return el;
    }
    return mkEl('div');
  }
  globalThis.document = {
    activeElement: null,
    head: mkEl('head'),
    body: mkEl('body'),
    getElementById: () => null,
    createElement: (t) => mkEl(t),
    querySelector: () => null,
    addEventListener() {}, removeEventListener() {},
  };
  if (!globalThis.navigator) globalThis.navigator = { clipboard: { writeText: async () => {} } };
  const root = mkEl('div');
  const handlers = {};
  root.addEventListener = (t, fn) => { handlers[t] = fn; };
  root.removeEventListener = () => {};
  root.contains = () => true;
  root.querySelector = (sel) => queryFor(sel);
  root.querySelectorAll = () => [];
  return { root, handlers };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let realApiRestore = null;

await check('mount() → 项目列表 + 工作区参数页渲染', async () => {
  const { root, handlers } = installDomStub();
  const view = await import('../web/views/novel.js');
  assert(typeof view.mount === 'function' && typeof view.unmount === 'function', '未导出 mount/unmount');
  uiRoot = root;
  uiHandlers = handlers;
  uiView = view;
  const options = (await api('GET', '/api/novels/options')).json;
  // 用真实前端 API 层（web/lib/api.js）+ fetch 基址垫片，验证外壳与视图的契约一致
  const realApi = await import('../web/lib/api.js');
  const origFetch = globalThis.fetch;
  globalThis.fetch = (p, init) => origFetch(typeof p === 'string' && p.startsWith('/') ? BASE + p : p, init);
  realApiRestore = () => { globalThis.fetch = origFetch; };
  const ctxStub = {
    meta: options,
    api: realApi.api,
    toast: (m, t) => toasts.push(`${t || 'info'}:${m}`),
    confirm: async () => false,
    modal: (opts) => { modals.push(opts); return { close() { /* noop */ } }; },
    watchJob: () => () => {},
    go: (m) => goCalls.push(m),
  };
  view.mount(root, ctxStub);
  for (let i = 0; i < 40 && !String(root.innerHTML).includes('生成章节大纲'); i++) await sleep(100);
  const html = String(root.innerHTML);
  assert(html.includes('小说工坊'), '侧栏标题缺失');
  assert(html.includes('生成章节大纲'), '两步生成按钮 ① 缺失');
  assert(html.includes('写作下一章'), '两步生成按钮 ② 缺失');
  assert(html.includes('题材（100 种'), '题材筛选区缺失');
  assert(html.includes('载入演员表') || html.includes('刷新演员表'), '演员选择区缺失');
  assert(html.includes('参考范本'), '参考范本上传区缺失');
  assert(html.includes('章节字数'), '章节字数控件缺失');
  if (!llmStatus().ready) assert(html.includes('LLM 未就绪'), '未配置 LLM 时缺少中文提示');
  return `${html.length} 字符，含列表/参数/演员/范本/两步生成按钮${llmStatus().ready ? '' : ' + LLM 未就绪提示'}`;
});

const clickUi = async (act, extra = {}) => {
  uiHandlers.click({ target: { closest: () => ({ dataset: { act, ...extra } }) } });
  await sleep(200);
};

await check('大纲面板：13 个分节全部可视化（含伏笔/时间线/回路/地点/人物ID）', async () => {
  await clickUi('tab', { tab: 'outline' });
  const html = String(uiRoot.innerHTML);
  for (const label of ['结构化大纲', '故事框架与核心冲突', '卷/季结构规划', '章节大纲与走向', '宏大时间线', '地点档案（ID）', '人物 ID 与出场规划', '伏笔与回收表', '反转清单', '节奏卡点与爽点曲线', '钩子银行', '跨季章节时间回路', '全篇逻辑关系与因果链']) {
    assert(html.includes(label), `大纲分节缺失：${label}`);
  }
  assert(html.includes('按指令优化'), '缺少「按指令优化」按钮');
  assert(html.includes('续规划章节'), '缺少「续规划章节」按钮');
  const before = modals.length;
  await clickUi('outline-optimize');
  assert(modals.length === before + 1, '「按指令优化」弹窗未打开');
  await clickUi('outline-append');
  assert(modals.length === before + 2, '「续规划章节」弹窗未打开');
  return `渲染 ${html.length} 字符，13 个分节 + 优化/续规划弹窗正常`;
});

await check('章节面板 + 阅读器 + 手动编辑', async () => {
  await clickUi('tab', { tab: 'chapters' });
  let html = String(uiRoot.innerHTML);
  assert(html.includes('写作范围'), '缺少写作范围控件');
  assert(html.includes('nv-chlist'), '缺少章节列表');
  await clickUi('read', { idx: '1' });
  html = String(uiRoot.innerHTML);
  assert(html.includes('青芜山上的第一场雪'), '阅读器未显示第 1 章正文');
  await clickUi('edit-chapter');
  html = String(uiRoot.innerHTML);
  assert(html.includes('data-role="content"'), '缺少手动编辑文本框');
  await clickUi('cancel-edit');
  return '章节列表 + 阅读器正文 + 编辑器切换正常';
});

await check('导出面板：txt / md / json 下载链接', async () => {
  await clickUi('tab', { tab: 'export' });
  const html = String(uiRoot.innerHTML);
  assert(html.includes('format=txt&download=1'), '缺少 TXT 下载');
  assert(html.includes('format=md&download=1'), '缺少 Markdown 下载');
  assert(html.includes('format=json&download=1'), '缺少 JSON 下载');
  await clickUi('preview-export');
  assert(String(uiRoot.innerHTML).includes('nv-preview'), '缺少导出预览');
  return '三种格式下载 + 预览';
});

await check('创建向导：题材分类筛选 / 选择 / 大纲优化弹窗', async () => {
  await clickUi('new-novel');
  let html = String(uiRoot.innerHTML);
  assert(html.includes('新建小说项目'), '创建向导未打开');
  assert(html.includes('100 种'), '题材区缺少数量提示');
  await clickUi('cat', { cat: '玄幻' });
  html = String(uiRoot.innerHTML);
  assert(html.includes('nv-gitem'), '分类筛选后题材网格为空');
  await clickUi('genre', { id: 'classic-xianxia' });
  html = String(uiRoot.innerHTML);
  assert(html.includes('已选：'), '选择题材后未显示已选状态');
  assert(html.includes('推荐基调'), '缺少题材推荐基调提示');
  await clickUi('add-custom');
  html = String(uiRoot.innerHTML);
  assert(html.includes('data-role="cname"'), '自定义角色行未添加');
  await clickUi('tab', { tab: 'outline' });
  return '向导/筛选/选题材/自定义角色/返回工作区均正常';
});

await check('LLM 说明弹窗 + unmount() 幂等清理', async () => {
  const before = modals.length;
  await clickUi('llm-help');
  assert(modals.length > before, '「怎么做？」未打开 LLM 说明弹窗');
  const body = modals[modals.length - 1].body;
  assert(String(body?.innerHTML || '').includes('mock'), '弹窗内缺少「切换离线模板（mock）」说明');
  uiView.unmount();
  uiView.unmount();
  assert(modals.length >= before + 1, 'unmount 不应产生副作用');
  delete globalThis.document;
  return '离线模板指引弹窗正常；unmount 可重复调用（已停止轮询、移除监听）';
});

await check('真实前端 API 层：upload / readText / watchJob（ctx.watchJob 契约）', async () => {
  const realApi = await import('../web/lib/api.js');
  const file = new File([new Blob(['范本正文：雨夜开场，三句话立住执念。'], { type: 'text/plain' })], 'ui-ref.txt', { type: 'text/plain' });
  const up = await realApi.api.upload(file);
  assert(up && up.path && up.name === 'ui-ref.txt', `upload 返回 ${JSON.stringify(up)}`);
  const txt = await realApi.api.readText(up.path);
  assert(String(txt.text).includes('雨夜开场'), 'readText 未取到正文');
  const r = await api('POST', `/api/novels/${novelId}/chapters/generate`, { mode: 'range', from: 4, to: 4, provider: 'mock' });
  assert(r.status === 200 && r.json.jobId, `建任务失败：${r.text.slice(0, 120)}`);
  const job = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('watchJob 轮询超时')), 40000);
    realApi.api.watchJob(r.json.jobId, (j) => {
      if (j && ['done', 'error', 'canceled'].includes(j.status)) { clearTimeout(timer); resolve(j); }
    }, { interval: 300 });
  });
  assert(job.status === 'done' && job.result?.ok === 1, `任务结果 ${JSON.stringify(job.result || job.error)}`);
  fs.rmSync(path.join(db.ROOT, up.path), { force: true });
  return `upload/readText/watchJob 通过；第 4 章 ${job.result.results?.[0]?.words || 0} 字`;
});
if (realApiRestore) realApiRestore();

// ---------- 8. 删除与收尾 ----------
console.log('\n[8] 删除小说 / 404 / 收尾');
await check('GET 不存在的小说返回 404', async () => {
  const r = await api('GET', '/api/novels/N-9999');
  assert(r.status === 404 && r.json.ok === false, `状态码 ${r.status}`);
});
await check('DELETE /:id 连带删除大纲与章节', async () => {
  const r = await api('DELETE', `/api/novels/${novelId}`);
  assert(r.status === 200 && r.json.ok, `状态码 ${r.status}`);
  assert(db.get('SELECT COUNT(*) n FROM novel_chapters WHERE novel_id = ?', novelId).n === 0, '章节未清理');
  assert(db.get('SELECT COUNT(*) n FROM novel_outlines WHERE novel_id = ?', novelId).n === 0, '大纲未清理');
  assert(db.get('SELECT COUNT(*) n FROM novels WHERE id = ?', novelId).n === 0, '小说未删除');
  const list = await api('GET', '/api/novels');
  assert(!list.json.novels.some((n) => n.id === novelId), '列表仍含已删小说');
  return `章节 ${r.json.deleted.chapters} 行 / 大纲 ${r.json.deleted.outlines} 行已联动删除`;
});
await check('对已删除/不存在的小说操作 → 404', async () => {
  const a = await api('GET', `/api/novels/${novelId}/chapters/generate`);
  const b = await api('POST', '/api/novels/N-9999/chapters/generate', { mode: 'all' });
  const c = await api('GET', '/api/novels/N-9999/outline');
  assert(a.status === 404 && b.status === 404 && c.status === 404, `状态码 ${a.status}/${b.status}/${c.status}`);
  return '已删除小说：章节/写作/大纲接口均 404';
});

// ---------- 汇总 ----------
console.log('\n==========================================================');
console.log(`通过 ${passed} 项，失败 ${failures.length} 项，跳过 ${skips.length} 项`);
if (skips.length) console.log(`跳过：${skips.join('；')}`);
if (failures.length) {
  console.log('失败明细：');
  for (const f of failures) console.log(`  - ${f.name}: ${f.err}`);
}
console.log('==========================================================');

cleanup();
process.exit(failures.length ? 1 : 0);
