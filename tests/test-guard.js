// 生产守护测试：用量台账 / 成本预估 / 预算闸门 / 磁盘保护 / 失败镜头归类与一键重试
// 全部离线：用假厂商服务端制造「先失败后成功」与不同错误类别，验证闸门与重试策略。
// 用法：node tests/test-guard.js
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const DATA_TMP = path.join(os.tmpdir(), `factory-guard-data-${Date.now()}`);
const DB = path.join(os.tmpdir(), `factory-guard-${Date.now()}.db`);
const CFG = path.join(os.tmpdir(), `factory-guard-config-${Date.now()}.json`);
process.env.FACTORY_DATA_DIR = DATA_TMP;
process.env.FACTORY_DB = DB;
process.env.FACTORY_CONFIG = CFG;
process.env.PORT = '8897';
fs.mkdirSync(DATA_TMP, { recursive: true });

const { migrate, run, get, all } = await import('../src/db.js');
const { saveConfig, loadConfig } = await import('../src/config.js');
const { createApp, createServer } = await import('../src/http.js');
const { registerMetaRoutes } = await import('../src/routes/meta.js');
const { registerActorRoutes } = await import('../src/routes/actors.js');
const { registerRenderRoutes } = await import('../src/routes/render.js');
const { registerScriptRoutes } = await import('../src/routes/script.js');
const guard = await import('../src/guard.js');
const { estimateRender } = await import('../src/modules/render.js');

migrate();

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? `  ${extra}` : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? `  ${extra}` : ''}`); }
};
const need = (c, m) => { if (!c) throw new Error(m || '断言失败'); };
const setCfg = (obj) => { fs.writeFileSync(CFG, JSON.stringify(obj, null, 2)); loadConfig({ reload: true }); };

// ---------------- 假厂商：按脚本制造不同错误 ----------------
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const vendor = { mode: 'ok', hits: 0, failTimes: 0, failStatus: 500, seen: [] };
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString('utf8');
  vendor.seen.push({ path: req.url, body });
  const send = (code, obj) => { const b = Buffer.from(JSON.stringify(obj)); res.writeHead(code, { 'content-type': 'application/json' }); res.end(b); };
  if (req.url.startsWith('/img')) {
    vendor.hits++;
    if (vendor.failTimes > 0) { vendor.failTimes--; return send(vendor.failStatus, { msg: vendor.failStatus === 401 ? 'invalid api key' : 'upstream error' }); }
    if (vendor.mode === 'auth') return send(401, { msg: 'invalid api key' });
    if (vendor.mode === 'quota') return send(500, { msg: '额度不足' });
    if (vendor.mode === 'moderation') return send(400, { msg: 'content policy violation' });
    return send(200, { data: [{ b64_json: PNG_B64 }] });
  }
  send(404, { error: 'nope' });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const VENDOR = `http://127.0.0.1:${server.address().port}`;

const { app, handle } = createApp();
registerMetaRoutes(app);
registerActorRoutes(app);
registerScriptRoutes(app);
registerRenderRoutes(app);
const httpServer = createServer((req, res) => handle(req, res, { staticMounts: [] }));
await new Promise((r) => httpServer.listen(Number(process.env.PORT), '127.0.0.1', r));
const BASE = `http://127.0.0.1:${process.env.PORT}`;
const api = async (method, url, body) => {
  const res = await fetch(BASE + url, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: res.status, json, text };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitJob = async (id, timeoutMs = 120000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const j = (await api('GET', `/api/jobs/${id}`)).json?.job;
    if (j && ['done', 'error', 'canceled'].includes(j.status)) return j;
    await sleep(200);
  }
  throw new Error(`任务 ${id} 超时`);
};

// ---------------- 造数据：1 剧本 / 1 集 / 3 镜 ----------------
const IMG_BACKEND = {
  image: {
    backend: 'generic-http', defaultRatio: '3:4', retries: 0,
    generic: {
      url: `${VENDOR}/img`, method: 'POST', headers: '{"Content-Type":"application/json"}',
      bodyTemplate: '{"prompt":"{{prompt}}","width":{{width}},"height":{{height}}}',
      responseImagePath: 'data.0.b64_json', refImageField: 'image', refImageFormat: 'base64',
      pollUrl: '', pollStatusPath: '',
    },
  },
};
setCfg({ ...IMG_BACKEND, video: { backend: 'placeholder' }, budget: { enabled: true, currency: 'CNY', imageUnit: 0.2, videoUnit: 2, ttsPerKChars: 0.1, monthlyCap: 100, confirmOver: 0 }, storage: { warnGB: 1, maxGB: 2 } });

const now = new Date().toISOString();
run(`INSERT INTO scripts(id,novel_id,title,format,style_id,episode_seconds,episodes_per_season,seasons,status,created_at,updated_at)
     VALUES('SC-G','N-G','守护测试剧本','manju','cinematic-real',12,1,1,'draft',?,?)`, now, now);
run(`INSERT INTO script_episodes(id,script_id,season,episode,code,title,duration,status,created_at,updated_at)
     VALUES('EP-G','SC-G',1,1,'S01E001','守护测试集',12,'planned',?,?)`, now, now);
for (let i = 1; i <= 3; i++) {
  run(`INSERT INTO shots(id,script_id,episode_id,idx,scene_no,shot_size,camera,move,transition,duration,action,prompt_pos,prompt_neg,refs,cost_level,status,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    `SH-G${i}`, 'SC-G', 'EP-G', i, '1', '中景', '平视', '固定', '切', 3, `测试动作 ${i}`,
    `cinematic shot ${i}, harbor pier at night`, 'blurry, low quality', '{}', 'L', 'draft', now);
}

console.log('\n【1】用量台账与金额换算');
guard.resetUsage();
ok('初始台账为零且按当前单价换算金额', (() => { const u = guard.getUsage(); return u.images === 0 && u.amount === 0; })(), JSON.stringify(guard.getUsage().usage || {}));
guard.addUsage({ images: 3, videos: 1, ttsChars: 500 });
guard.addUsage({ images: 2 });
const u1 = guard.getUsage();
ok('累计用量正确（图 5 / 视频 1 / 配音 500 字）', u1.images === 5 && u1.videos === 1 && u1.ttsChars === 500, JSON.stringify({ i: u1.images, v: u1.videos, t: u1.ttsChars }));
ok('金额按单价换算（5×0.2 + 1×2 + 0.5×0.1 = 3.05）', u1.amount === 3.05, `${u1.amount} ${u1.currency}`);
ok('金额分项可解释（图/视频/配音三段）', u1.breakdown.image === 1 && u1.breakdown.video === 2 && u1.breakdown.tts === 0.05, JSON.stringify(u1.breakdown));
guard.resetUsage();
ok('清零本月用量后归零（不影响其它月份桶）', guard.getUsage().amount === 0, `amount=${guard.getUsage().amount}`);

console.log('\n【2】预算闸门');
const cfgBudget = (patch) => ({ ...loadConfig(), budget: { ...loadConfig().budget, ...patch } });
let g1 = guard.checkBudget({ images: 10 }, cfgBudget({ monthlyCap: 1000, confirmOver: 0, imageUnit: 0.2 }));
ok('远低于上限且未设确认阈值 → 直接放行', g1.ok && !g1.needConfirm && !g1.blocked, g1.reason);
let g2 = guard.checkBudget({ images: 100 }, cfgBudget({ monthlyCap: 1000, confirmOver: 5 }));
ok('单次预估超确认阈值 → needConfirm（先弹确认）', g2.ok && g2.needConfirm === true && g2.estimated.amount === 20, g2.reason);
let g3 = guard.checkBudget({ videos: 100 }, cfgBudget({ monthlyCap: 50, videoUnit: 2 }));
ok('超本月上限 → 直接拒绝并给中文原因（含已用/本次/合计）', g3.blocked === true && g3.ok === false && /超限/.test(g3.reason) && g3.projected === 200, g3.reason);
let g4 = guard.checkBudget({ images: 1000 }, cfgBudget({ enabled: false, monthlyCap: 1 }));
ok('关闭预算保护后不再拦截（只记用量）', g4.ok && !g4.blocked, g4.reason);
setCfg({ ...loadConfig(), budget: { ...loadConfig().budget, enabled: true, monthlyCap: 100, confirmOver: 0 } });

console.log('\n【3】磁盘保护');
fs.mkdirSync(path.join(DATA_TMP, 'videos', 'big'), { recursive: true });
fs.writeFileSync(path.join(DATA_TMP, 'videos', 'big', 'a.mp4'), Buffer.alloc(300 * 1024, 1));
fs.mkdirSync(path.join(DATA_TMP, 'images', 'x'), { recursive: true });
fs.writeFileSync(path.join(DATA_TMP, 'images', 'x', 'a.png'), Buffer.alloc(120 * 1024, 2));
const disk = guard.diskUsage();
ok('磁盘统计能分项列出 images / videos 占用', disk.parts.some((p) => p.name === 'videos' && p.bytes >= 300 * 1024) && disk.parts.some((p) => p.name === 'images' && p.bytes >= 120 * 1024), JSON.stringify(disk.parts.map((p) => `${p.name}:${p.mb}MB`)));
ok('总占用为分项之和（含数据库）', Math.abs(disk.totalBytes - disk.parts.reduce((n, p) => n + p.bytes, 0)) < 1024, `${disk.totalMB}MB`);

// 【3b】参考图栅格化缓存（DATA_DIR/cache/refs，REFIMG-FIX）必须**单独可见**且计入总量：
// 以前它既不在 parts 里（看不出是哪一块），也没被算进 totalBytes（磁盘闸门漏算）。这里先从「目录不存在」开始。
console.log('\n【3b】栅格化缓存分项（cache/refs）');
const cacheDirG = guard.refCacheDir();
const cacheBefore = guard.cacheUsage();
ok('缓存目录不存在时报 0、不抛错（exists=false/bytes=0/files=0）',
  cacheDirG === path.join(DATA_TMP, 'cache', 'refs') && cacheBefore.exists === false && cacheBefore.bytes === 0 && cacheBefore.files === 0 && cacheBefore.mb === 0,
  JSON.stringify(cacheBefore));
{
  const d0 = guard.diskUsage();
  ok('缓存目录不存在时 diskUsage 也不列 cache 分项、总量不受影响',
    d0.cache && d0.cache.bytes === 0 && !d0.parts.some((p) => p.name === 'cache')
    && Math.abs(d0.totalBytes - d0.parts.reduce((n, p) => n + p.bytes, 0)) < 1024,
    JSON.stringify({ cache: d0.cache.bytes, parts: d0.parts.map((p) => p.name) }));
}
fs.mkdirSync(cacheDirG, { recursive: true });
fs.writeFileSync(path.join(cacheDirG, 'aaaa000000000001.png'), Buffer.alloc(400 * 1024, 3));
fs.writeFileSync(path.join(cacheDirG, 'bbbb000000000002.png'), Buffer.alloc(300 * 1024, 3));
const cacheAfter = guard.cacheUsage();
ok('造文件后 cacheUsage 报出正数的 files/bytes/mb（2 个 PNG ≈ 700KB）',
  cacheAfter.exists === true && cacheAfter.files === 2 && cacheAfter.bytes === 700 * 1024 && cacheAfter.mb > 0,
  JSON.stringify(cacheAfter));
const diskC = guard.diskUsage();
ok('diskUsage 把 cache 列进 parts（同风格字段 bytes/files/mb）且 bytes/files 与 cacheUsage 一致',
  diskC.parts.some((p) => p.name === 'cache' && p.bytes === 700 * 1024 && p.files === 2 && p.mb === cacheAfter.mb)
  && diskC.cache.bytes === 700 * 1024 && diskC.cache.files === 2,
  JSON.stringify(diskC.parts.map((p) => `${p.name}:${p.mb}MB`)));
ok('缓存已计入 totalBytes（总量仍等于分项之和，磁盘闸门不再漏算这 700KB）',
  Math.abs(diskC.totalBytes - diskC.parts.reduce((n, p) => n + p.bytes, 0)) < 1024 && diskC.totalBytes >= 700 * 1024,
  `${diskC.totalMB}MB`);
const small = guard.checkStorage({ ...loadConfig(), storage: { warnGB: 1, maxGB: 2 } });
ok('未达阈值时存储闸门放行', small.ok && !small.warn && !small.blocked, small.reason);
const tiny = guard.checkStorage({ ...loadConfig(), storage: { warnGB: 0.0001, maxGB: 0.0002 } });
ok('超上限时存储闸门拦截并给中文原因', tiny.blocked === true && /上限/.test(tiny.reason), tiny.reason);
const warnOnly = guard.checkStorage({ ...loadConfig(), storage: { warnGB: 0.0001, maxGB: 5 } });
ok('仅告警时仍可继续（warn 与 blocked 分离）', warnOnly.warn === true && warnOnly.blocked === false, warnOnly.reason);

console.log('\n【4】失败镜头归类');
const classified = guard.classifyFailedRenders([
  { id: 'R1', shot_id: 'S1', kind: 'video', error: '[触发限流（429）] 出图接口 429: rate limit（已尝试 3 次）' },
  { id: 'R2', shot_id: 'S2', kind: 'keyframe', error: '[服务端错误（5xx）] 出图接口 500: upstream error' },
  { id: 'R3', shot_id: 'S3', kind: 'keyframe', error: '[鉴权失败（Key 无效或未授权）] 出图接口 401: invalid api key' },
  { id: 'R4', shot_id: 'S4', kind: 'video', error: '[额度/余额不足] 出图接口 500: 额度不足' },
  { id: 'R5', shot_id: 'S5', kind: 'keyframe', error: '[内容审核不通过] content policy violation' },
  { id: 'R6', shot_id: 'S6', kind: 'keyframe', error: 'fetch failed' },
]);
ok('可重试集合 = 限流 / 5xx / 网络', classified.retryable.length === 3 && classified.retryable.every((r) => ['rate', 'server', 'network'].includes(r.errorKind)), classified.retryable.map((r) => r.errorKind).join(','));
ok('不可重试集合 = 鉴权 / 额度 / 审核（附中文标签）', classified.blocked.length === 3 && classified.blocked.every((r) => ['auth', 'quota', 'moderation'].includes(r.errorKind)) && classified.blocked.every((r) => r.errorLabel), classified.blocked.map((r) => `${r.errorKind}:${r.errorLabel}`).join(' | '));

console.log('\n【5】API：闸门 + 失败重试端到端');
// 让出图全部失败（鉴权错误，不可重试）
vendor.mode = 'auth';
let kf = await api('POST', '/api/render/keyframes', { scriptId: 'SC-G', code: 'S01E001' });
ok('提交关键帧任务（预算未超，直接放行）', kf.json.ok === true && Boolean(kf.json.jobId), JSON.stringify(kf.json).slice(0, 120));
let job = await waitJob(kf.json.jobId);
ok('任务完成但全部失败（鉴权错误写入渲染记录）', job.status === 'done' && job.result.failed === 3, JSON.stringify(job.result));
const errRows = all("SELECT * FROM shot_renders WHERE status='error'");
ok('失败记录带中文归类文案', errRows.length === 3 && errRows.every((r) => /鉴权失败/.test(r.error)), String(errRows[0]?.error).slice(0, 80));

let retry = await api('POST', '/api/render/retry-failed', { scriptId: 'SC-G', code: 'S01E001' });
ok('重试接口识别出「鉴权类不可重试」并给出中文提示', retry.json.ok === true && retry.json.retryable === 0 && retry.json.blocked.length === 3 && /修配置|额度/.test(retry.json.message), retry.json.message);
ok('不可重试项带错误类别与原文（便于定位）', retry.json.blocked.every((b) => b.errorKind === 'auth' && b.errorLabel && b.error), JSON.stringify(retry.json.blocked[0]).slice(0, 120));

// 换成「先 500 两次再成功」：验证重试 + 预算确认 + 用量记账
vendor.mode = 'ok';
vendor.failTimes = 2; vendor.failStatus = 500;
const cfg2 = loadConfig();
setCfg({ ...cfg2, image: { ...cfg2.image, retries: 3, retryBaseMs: 5 } });
const kf2 = await api('POST', '/api/render/keyframes', { scriptId: 'SC-G', code: 'S01E001' });
const job2 = await waitJob(kf2.json.jobId);
ok('可重试类失败在重试后成功（3 镜全出）', job2.status === 'done' && job2.result.failed === 0, JSON.stringify(job2.result));
const okRows = all("SELECT * FROM shot_renders WHERE kind='keyframe' AND status='done'");
ok('成功记录落库且带真实后端与文件', okRows.length === 3 && okRows.every((r) => r.backend === 'generic-http' && r.file_path), `${okRows.length} 条`);

const usageAfter = guard.getUsage();
ok('真实后端出图自动记账（本月图数 ≥ 3）', usageAfter.images >= 3, `images=${usageAfter.images} amount=${usageAfter.amount}`);

// 预算上限：把上限压到已用量以下 → 提交被拒
setCfg({ ...loadConfig(), budget: { ...loadConfig().budget, enabled: true, monthlyCap: 0.0001, confirmOver: 0 } });
const blocked = await api('POST', '/api/render/keyframes', { scriptId: 'SC-G', code: 'S01E001', overwrite: true });
ok('超本月上限时提交被拒绝并给中文原因', blocked.json.ok === false && /预算上限|超限/.test(blocked.json.error || ''), String(blocked.json.error).slice(0, 110));

// 确认阈值：预估超阈值 → needConfirm；带 confirm 才真正提交
setCfg({ ...loadConfig(), budget: { ...loadConfig().budget, enabled: true, monthlyCap: 1000, confirmOver: 0.1, imageUnit: 0.2 } });
const needC = await api('POST', '/api/render/keyframes', { scriptId: 'SC-G', code: 'S01E001', overwrite: true });
ok('超确认阈值时返回 needConfirm（不直接开跑）', needC.json.ok === true && needC.json.needConfirm === true && /预估/.test(needC.json.reason), needC.json.reason);
ok('needConfirm 响应带预算明细（金额/已用/上限）', needC.json.budget && needC.json.budget.estimated.amount > 0 && needC.json.budget.cap === 1000, JSON.stringify(needC.json.budget?.estimated || {}).slice(0, 120));
const confirmed = await api('POST', '/api/render/keyframes', { scriptId: 'SC-G', code: 'S01E001', overwrite: true, confirm: true });
ok('带 confirm 提交后正常开跑', confirmed.json.ok === true && Boolean(confirmed.json.jobId), JSON.stringify(confirmed.json).slice(0, 110));
const job4 = await waitJob(confirmed.json.jobId);
ok('确认后的任务正常完成', job4.status === 'done' && job4.result.failed === 0, JSON.stringify(job4.result));

console.log('\n【6】API：预算与磁盘总览 / 用量清零');
const st = await api('GET', '/api/guard/status');
ok('总览接口返回用量/金额/预算/磁盘四项', st.json.ok && st.json.usage && st.json.cost && st.json.budget && st.json.disk, JSON.stringify({ u: st.json.usage, a: st.json.cost?.amount, cap: st.json.budget?.monthlyCap }));
ok('总览含剩余额度与磁盘分项', typeof st.json.remaining === 'number' && Array.isArray(st.json.disk.parts) && st.json.disk.parts.length >= 1, `remaining=${st.json.remaining} parts=${st.json.disk.parts.length}`);
const est = estimateRender({ scriptId: 'SC-G', codes: ['S01E001'], stages: ['keyframe', 'video'] });
ok('工作量预估同时给出金额估算与本月用量', est.cost && est.cost.amount >= 0 && est.cost.month && typeof est.cost.month.amount === 'number', JSON.stringify({ cost: est.cost?.amount, month: est.cost?.month?.amount }));
const rst = await api('POST', '/api/guard/reset-usage', {});
ok('清零本月用量接口生效', rst.json.ok && rst.json.usage.images === 0, JSON.stringify(rst.json.usage).slice(0, 90));

console.log('\n【7】队列自动暂停判定（预算软着陆）');
const GU = await import('../src/guard.js');
const GU_C = await import('../src/config.js');
saveConfig({ budget: { monthlyCap: 0, productionCap: 0, enabled: true, currency: 'CNY', imageUnit: 1, videoUnit: 10 } });
const pauseOff = GU.shouldAutoPause({ images: 10, videos: 10 });
ok('没设月度上限时永不自动暂停（默认不打扰）', pauseOff.pause === false && pauseOff.cap === 0, JSON.stringify(pauseOff).slice(0, 100));
saveConfig({ budget: { enabled: true, currency: 'CNY', imageUnit: 1, videoUnit: 10, monthlyCap: 5 } });
const pauseOn = GU.shouldAutoPause({ images: 1, videos: 1 });
ok('本批预估会突破月度上限 → 判定自动暂停，并在原因里写清金额与上限',
  pauseOn.pause === true && /超过月度上限/.test(pauseOn.reason) && pauseOn.projected > pauseOn.cap,
  pauseOn.reason);
ok('原因里给出可执行的下一步（提高上限或清零台账后恢复队列）', /恢复队列|提高上限/.test(pauseOn.reason), pauseOn.reason);
const pauseUnder = GU.shouldAutoPause({ images: 0, videos: 0 });
ok('本批不花钱（0 调用）时不会因为「已用超限」而暂停（避免空跑也被拦）',
  pauseUnder.pause === false && pauseUnder.projected === 0, JSON.stringify({ pause: pauseUnder.pause, projected: pauseUnder.projected }));
saveConfig({ budget: { monthlyCap: 0, productionCap: 0, imageUnit: 0.1, videoUnit: 0.5, currency: 'CNY' } });

// ════════════════ 追加（P0-ERR）：失败镜头归类里的 quota / model 两个新不可重试类别 ════════════════
console.log('\n【4b】失败镜头归类：额度/欠费 与 模型不可用（均不可自动重试）');
const classified2 = guard.classifyFailedRenders([
  { id: 'Q1', shot_id: 'S1', kind: 'keyframe', error: '出图接口 403: {"code":"AccountOverdueError","message":"Arrearage"}' },
  { id: 'Q2', shot_id: 'S2', kind: 'video', error: '[额度/欠费] 出图接口 500: 余额不足，请充值' },
  { id: 'M1', shot_id: 'S3', kind: 'video', error: '视频接口 503: model_not_found' },
  { id: 'M2', shot_id: 'S4', kind: 'keyframe', error: '404 ModelNotOpen' },
  { id: 'A1', shot_id: 'S5', kind: 'keyframe', error: '403 AccessDenied' },
  { id: 'R1', shot_id: 'S6', kind: 'keyframe', error: '出图接口 429: rate limit' },
]);
const 归类 = (id) => [...classified2.retryable, ...classified2.blocked].find((r) => r.id === id)?.errorKind;
ok('欠费 403 / 余额不足 → quota（不再是 auth），且落在「必须先处理」集合里',
 归类('Q1') === 'quota' && 归类('Q2') === 'quota'
  && classified2.blocked.filter((r) => r.errorKind === 'quota').length === 2, `${归类('Q1')},${归类('Q2')}`);
ok('model_not_found（503 包装）/ ModelNotOpen → model，且不可自动重试（细分前会白跑 2 次）',
 归类('M1') === 'model' && 归类('M2') === 'model'
  && classified2.retryable.every((r) => !['quota', 'model', 'auth'].includes(r.errorKind)), `${归类('M1')},${归类('M2')}`);
ok('可重试集合仍严格等于 限流 / 5xx / 网络（本次只有 429 一条）',
  classified2.retryable.length === 1 && classified2.retryable[0].errorKind === 'rate', classified2.retryable.map((r) => r.errorKind).join(','));
ok('不可重试项带「下一步」提示：额度类指向充值/提额，模型类指向模型名/开通状态，鉴权类指向 Key',
  /充值|提额/.test(classified2.blocked.find((r) => r.id === 'Q1')?.hint || '')
  && /模型名|开通/.test(classified2.blocked.find((r) => r.id === 'M1')?.hint || '')
  && /Key/.test(classified2.blocked.find((r) => r.id === 'A1')?.hint || '')
  && 归类('A1') === 'auth',
  `${classified2.blocked.find((r) => r.id === 'Q1')?.hint} ｜ ${classified2.blocked.find((r) => r.id === 'M1')?.hint}`);

// ════════════════ 追加（R-MODELWORDS）：模型不可用话术补全 —— 新关键词一律 model 且不可重试；裸 not found / invalid 不得误伤 ════════════════
console.log('\n【4c】模型不可用话术补全：厂商新话术 → model（不可自动重试），裸 not found / invalid 不得误伤');
const RTM = await import('../src/retry.js');
const 判 = (msg, status = null) => RTM.classifyError(status ? Object.assign(new Error(msg), { status }) : new Error(msg));
const 正例 = [
  ['视频接口 503: model_deactivated', 503],
  ['model_disabled：该模型已停用', 400],
  ['model_unavailable', 503],
  ['404 model_not_open', 404],
  ['404 endpoint_not_found', 404],
  ['EndpointNotFound', 404],
  ['{"code":20012,"message":"Model does not exist. Please check it carefully."}', 400],
  ['Your account 2101075817 has not activated the model doubao-seedance-1-0-pro', 400],
  ['出图接口 400: 模型已下线，请更换模型', 400],
  ['未开通该模型：doubao-seedream-5-0-lite', 400],
];
const 正例结果 = 正例.map(([m, s]) => 判(m, s));
ok('新增厂商话术（model_deactivated / model_disabled / model_unavailable / model_not_activated / not activated the model）一律归 model 且不可自动重试',
  正例结果.every((c) => c.kind === 'model' && c.retryable === false),
  正例结果.map((c) => `${c.kind}:${c.retryable}`).join(','));
ok('端点/模型不存在话术（model_not_open / endpoint_not_found / EndpointNotFound）也归 model（细分前会落进可重试的 server 或 client）',
  正例.filter(([m]) => /not[_ -]?open|endpoint/i.test(m)).every(([m, s]) => 判(m, s).kind === 'model'),
  正例.filter(([m]) => /not[_ -]?open|endpoint/i.test(m)).map(([m]) => `${m.slice(0, 24)}→${判(m).kind}`).join(' | '));
ok('厂商英文原文「Model does not exist.」（SiliconFlow 20012，HTTP 400）→ model 且不可重试（补词前落 client/unknown，看不到「模型不可用」中文告知）',
  判('{"code":20012,"message":"Model does not exist. Please check it carefully."}', 400).kind === 'model',
  `${判('{"code":20012,"message":"Model does not exist. Please check it carefully."}', 400).kind}/${判('{"code":20012,"message":"Model does not exist. Please check it carefully."}', 400).label}`);
ok('厂商英文原文「has not activated the model X」（账号未开通该模型）→ model 且带中文标签',
  判('Your account 2101075817 has not activated the model doubao-seedance-1-0-pro', 400).kind === 'model'
  && Boolean(判('Your account 2101075817 has not activated the model doubao-seedance-1-0-pro', 400).label));
ok('中文话术补全：模型已下线 / 模型不可用 / 未开通该模型 → model（既有 模型不存在 / 模型未开通 / 模型不可用 仍生效）',
  ['出图接口 400: 模型已下线，请更换模型', '模型不可用，请稍后重试', '未开通该模型：doubao-seedream', '模型不存在', '模型未开通']
    .every((m) => 判(m, 400).kind === 'model'));
ok('反例一：404 Not Found（资源不存在，无 model/endpoint 语义）不得判为 model，且不可自动重试',
  ['404 Not Found', '出图接口 404: Not Found', '拉取任务状态失败：404 Not Found']
    .every((m) => 判(m, 404).kind !== 'model' && 判(m, 404).retryable === false),
  ['404 Not Found', '出图接口 404: Not Found'].map((m) => `${m}→${判(m, 404).kind}`).join(' | '));
ok('反例二：invalid parameter / invalid endpoint parameter（参数校验失败）不得判为 model（未放宽带 invalid/endpoint 的宽泛匹配）',
  ['invalid parameter', '参数校验失败：invalid endpoint parameter', 'InvalidParameter.UnsupportedParameter']
    .every((m) => 判(m, 400).kind !== 'model'),
  ['invalid parameter', '参数校验失败：invalid endpoint parameter'].map((m) => `${m}→${判(m, 400).kind}`).join(' | '));
ok('model 类永不进可重试集合：RETRY_KINDS 仍严格等于 rate,server,network',
  RTM.RETRY_KINDS.join(',') === 'rate,server,network' && !RTM.RETRY_KINDS.includes('model'), JSON.stringify(RTM.RETRY_KINDS));
ok('既有判定未变：403 欠费（AccountOverdueError/Arrearage）与额度不足 → quota，401/403 AccessDenied → auth（原语料原样，均不可重试）',
  判('出图接口 403: {"code":"AccountOverdueError","message":"Arrearage"}', 403).kind === 'quota'
  && 判('出图接口 500: 额度不足', 500).kind === 'quota'
  && 判('出图接口 403: AccessDenied', 403).kind === 'auth'
  && 判('401 unauthorized: invalid api key', 401).kind === 'auth'
  && [判('出图接口 403: {"code":"AccountOverdueError","message":"Arrearage"}', 403), 判('出图接口 403: AccessDenied', 403)].every((c) => c.retryable === false),
  `quota=${判('出图接口 403: {"code":"AccountOverdueError","message":"Arrearage"}', 403).kind} auth=${判('出图接口 403: AccessDenied', 403).kind}`);
ok('防回归：429 / 5xx / network 仍可自动重试且在默认重试集合内；timeout 保持 retryable=true（默认集合外，语义不变）',
  [判('出图接口 429: rate limit', 429), 判('出图接口 500: internal server error', 500), 判('出图接口 503: upstream error', 503), 判('fetch failed')]
    .every((c) => c.retryable === true && RTM.RETRY_KINDS.includes(c.kind))
  && 判('请求超时').retryable === true && !RTM.RETRY_KINDS.includes('timeout'),
  `${[判('出图接口 429: rate limit', 429), 判('出图接口 500: internal server error', 500), 判('fetch failed')].map((c) => c.kind).join(',')} | timeout retryable=${判('请求超时').retryable}`);
const 归类3 = guard.classifyFailedRenders([
  { id: 'MW1', shot_id: 'S1', kind: 'video', error: '视频接口 503: model_deactivated' },
  { id: 'MW2', shot_id: 'S2', kind: 'keyframe', error: '出图接口 404: Not Found' },
  { id: 'MW3', shot_id: 'S3', kind: 'keyframe', error: '出图接口 429: rate limit' },
]);
ok('守护侧端到端：model_deactivated 落「必须先处理」并给「模型名/开通状态」提示；404 Not Found 不落 model；可重试仍只有 429 一条',
  归类3.blocked.some((r) => r.id === 'MW1' && r.errorKind === 'model' && /模型名|开通/.test(r.hint))
  && 归类3.blocked.some((r) => r.id === 'MW2' && r.errorKind !== 'model')
  && 归类3.retryable.length === 1 && 归类3.retryable[0].errorKind === 'rate',
  `${归类3.blocked.map((r) => `${r.id}:${r.errorKind}`).join(',')} ｜ retryable=${归类3.retryable.map((r) => r.errorKind).join(',')}`);

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
httpServer.close();
server.close();
try {
  fs.rmSync(DB, { force: true }); fs.rmSync(DB + '-wal', { force: true }); fs.rmSync(DB + '-shm', { force: true });
  fs.rmSync(DATA_TMP, { recursive: true, force: true }); fs.rmSync(CFG, { force: true });
} catch { /* ignore */ }
process.exit(fail ? 1 : 0);
