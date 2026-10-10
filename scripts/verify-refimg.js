#!/usr/bin/env node
// 万相（百炼 wan2.7-image）「参考图 / 图生图」真机验证脚本
//
// 背景：generic-http 以前只有一套 bodyTemplate，模板里若没有 {{refImage}}，
//       画布参考图（shot.refs.canvas.refImages[0]）会被解析成 canvasRef 但**不会发出**，
//       图生图能力形同虚设。现在 src/image.js 的 pickImageBodyTemplate 会按「本次有没有参考图」
//       在 bodyTemplate（t2i）与 refBodyTemplate（i2i）之间自动切换，本脚本验证这条链路。
//
// 本脚本**会真花钱**（每张按 budget.imageUnit 计价，当前配置 ¥0.2/张），因此：
//   · 不带 --yes 时只打印「将要做什么 + 预估费用」，然后退出，**不调用任何付费接口**；
//   · 只跑 --only 指定的用例（默认 i2i + t2i 各 1 张，合计 2 张）；
//   · 提交前过一遍与 HTTP 接口同源的闸门 preflightBatch（含预算上限 / 磁盘 / 队列暂停）；
//   · 走的是应用自身的真实链路：src/modules/render.js 的 createKeyframeJob → runKeyframes
//     → resolveShotCanvasRef（画布参考图）→ src/image.js 的 generateImage（真厂商请求）。
//
// 用法：
//   node scripts/verify-refimg.js                  # 只看计划（零请求）
//   node scripts/verify-refimg.js --dry            # 假 fetch 跑通全链路（零费用；临时 DB + 临时数据目录）
//   node scripts/verify-refimg.js --yes            # 真出 2 张（1 带参考图 + 1 纯文生图）
//   node scripts/verify-refimg.js --yes --only=i2i # 只出带参考图的那 1 张
//   node scripts/verify-refimg.js --yes --i2i=SH-0035 --t2i=SH-0204   # 指定镜头
//
// 输出：一行 JSON（含脱敏后的请求体关键字段、文件/字节/尺寸/耗时/费用、模板切换结论）。
// 脱敏口径：apiKey / Authorization 一律掩码；base64 只留前 20 字符与总长度，绝不打印完整图片数据。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const argv = process.argv.slice(2);
const YES = argv.includes('--yes');
const DRY = argv.includes('--dry');
const argVal = (k) => (argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=')[1] || '';
const ONLY = String(argVal('only') || '').trim();

const t0 = Number(process.hrtime.bigint() / 1000000n);   // 单调时钟（系统时间被调整也不会出现负数）
const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── dry 模式：临时 DB（真库副本，只读用）+ 临时数据目录，保证零费用、零真实写盘 ──
let tmpDir = null;
if (DRY) {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'refimg-dry-'));
  const dbSrc = path.join(process.cwd(), 'data', 'factory.db');
  fs.copyFileSync(dbSrc, path.join(tmpDir, 'factory.db'));
  for (const ext of ['-wal', '-shm']) {
    if (fs.existsSync(dbSrc + ext)) fs.copyFileSync(dbSrc + ext, path.join(tmpDir, 'factory.db' + ext));
  }
  process.env.FACTORY_DB = path.join(tmpDir, 'factory.db');
  process.env.FACTORY_DATA_DIR = path.join(tmpDir, 'data');
  fs.mkdirSync(path.join(tmpDir, 'data', 'images'), { recursive: true });
}

// ★ 动态 import：必须在设置 FACTORY_DB / FACTORY_DATA_DIR 之后
const { loadConfig } = await import('../src/config.js');
const { all, get, ROOT } = await import('../src/db.js');
const { getUsage, readUsageLedger, monthKey } = await import('../src/guard.js');
const { createKeyframeJob, preflightBatch } = await import('../src/modules/render.js');
const { pickImageBodyTemplate } = await import('../src/image.js');

const cfg = loadConfig();
const g = cfg.image.generic || {};
const unit = Number(cfg.budget?.imageUnit ?? 0);

// ── 脱敏工具 ──
const SECRET_KEY = /^(api_?key|authorization|token|secret|xi-api-key)$/i;
function redactValue(v) {
  const s = String(v);
  if (/^data:image\/[\w.+-]+;base64,/i.test(s)) {
    const head = s.slice(0, s.indexOf(',') + 1);
    const b64 = s.slice(s.indexOf(',') + 1);
    return `${head}${b64.slice(0, 20)}…（base64 共 ${b64.length} 字符 ≈ ${Math.round((b64.length * 3 / 4) / 1024)}KB）`;
  }
  if (s.length > 20) return `${s.slice(0, 20)}…（共 ${s.length} 字符）`;
  return s;
}
/** 保留键名结构、值做脱敏（base64 只留前 20 字符 + 长度） */
function redactBody(node, depth = 0) {
  if (Array.isArray(node)) return node.map((x) => redactBody(x, depth + 1));
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      out[k] = SECRET_KEY.test(k) && typeof v === 'string' ? '***已脱敏***' : redactBody(v, depth + 1);
    }
    return out;
  }
  if (typeof node === 'string') return redactValue(node);
  return node;
}
/** 参考图字段在请求体里的点号路径（用于报告里说明「image 字段真的发出去了」） */
function findRefPaths(node, refField, hits = [], trail = '') {
  if (Array.isArray(node)) { node.forEach((v, i) => findRefPaths(v, refField, hits, `${trail}.${i}`)); return hits; }
  if (!node || typeof node !== 'object') return hits;
  for (const [k, v] of Object.entries(node)) {
    const p = trail ? `${trail}.${k}` : k;
    if (k.toLowerCase() === String(refField || 'image').toLowerCase()) hits.push({ path: p, kind: typeof v, value: typeof v === 'string' ? redactValue(v) : v });
    findRefPaths(v, refField, hits, p);
  }
  return hits;
}
function hasKey(node, key) {
  if (Array.isArray(node)) return node.some((v) => hasKey(v, key));
  if (!node || typeof node !== 'object') return false;
  return Object.entries(node).some(([k, v]) => k.toLowerCase() === String(key).toLowerCase() || hasKey(v, key));
}

// ── 候选镜头：i2i = 有画布参考图的镜头；t2i = 无画布参考图的镜头（都排除已有成功关键帧的） ──
function pickShot(wantRef) {
  const eps = all('SELECT id, script_id, code FROM script_episodes ORDER BY id');
  for (const ep of eps) {
    for (const s of all('SELECT id, idx, refs FROM shots WHERE episode_id = ? ORDER BY idx', ep.id)) {
      let refs = {}; try { refs = JSON.parse(s.refs || '{}'); } catch { /* ignore */ }
      const rel = ((refs.canvas || {}).refImages || [])[0] || null;
      if (wantRef && !rel) continue;
      if (!wantRef && rel) continue;
      if (wantRef && !fs.existsSync(path.resolve(ROOT, rel))) continue;
      const done = get("SELECT COUNT(*) n FROM shot_renders WHERE shot_id = ? AND kind = 'keyframe' AND status = 'done'", s.id).n;
      if (done > 0) continue;   // 已有成功关键帧：会被跳过（不出图也不花钱），不适合做验证
      return { scriptId: ep.script_id, code: ep.code, episodeId: ep.id, shotId: s.id, idx: s.idx, canvasRef: rel };
    }
  }
  return null;
}
const forcedI2i = argVal('i2i');
const forcedT2i = argVal('t2i');
function describeShot(wantRef) {
  const forced = wantRef ? forcedI2i : forcedT2i;
  if (forced) {
    const s = get('SELECT * FROM shots WHERE id = ?', forced);
    if (!s) return null;
    const ep = get('SELECT * FROM script_episodes WHERE id = ?', s.episode_id);
    let refs = {}; try { refs = JSON.parse(s.refs || '{}'); } catch { /* ignore */ }
    return { scriptId: ep.script_id, code: ep.code, episodeId: ep.id, shotId: s.id, idx: s.idx, canvasRef: ((refs.canvas || {}).refImages || [])[0] || null };
  }
  return pickShot(wantRef);
}

const cases = [];
if (ONLY !== 't2i') cases.push({ kind: 'i2i', wantRef: true, shot: describeShot(true) });
if (ONLY !== 'i2i') cases.push({ kind: 't2i', wantRef: false, shot: describeShot(false) });

// ── 计划（不带 --yes 时到此为止，绝不发请求） ──
const plan = {
  mode: DRY ? 'dry（假 fetch，零费用）' : YES ? 'real（真出图，会花钱）' : 'plan-only（零请求）',
  backend: cfg.image.backend,
  model: g.model || '(未配)',
  url: g.url || '(未配)',
  refImageFormat: g.refImageFormat || 'base64',
  refImageField: g.refImageField || 'image',
  hasRefBodyTemplate: Boolean(String(g.refBodyTemplate || '').trim()),
  unitPriceCNY: unit,
  monthlyCapCNY: Number(cfg.budget?.monthlyCap ?? 0),
  usageBefore: { month: monthKey(), ...getUsage() },
  cases: cases.map((c) => ({
    kind: c.kind,
    expectTemplate: c.kind === 'i2i' ? 'refBodyTemplate（含 image 键）' : 'bodyTemplate（不含 image 键）',
    shot: c.shot,
    expect: c.kind === 'i2i' ? 'usedTemplate=i2i 且请求体含 image 字段（data:image/png;base64,…）' : "usedTemplate=t2i 且请求体不含 image 键",
    pickerWillUse: pickImageBodyTemplate(g, c.kind === 'i2i').source,
  })),
  estimatedImages: cases.length,
  estimatedCostCNY: Math.round(cases.length * unit * 10000) / 10000,
};

if (!cases.length || cases.some((c) => !c.shot)) {
  console.log(JSON.stringify({ ok: false, error: '找不到合适的候选镜头（i2i 需要「有画布参考图且尚无成功关键帧」的镜头）', plan }, null, 2));
  process.exit(1);
}
if (!YES && !DRY) {
  console.log(JSON.stringify({
    ok: true, action: 'plan-only（未带 --yes，未调用任何付费接口）',
    note: `即将真出 ${cases.length} 张：${cases.map((c) => `${c.kind}(${c.shot.shotId})`).join(' + ')}；预估费用 ¥${plan.estimatedCostCNY}（单价 ¥${unit}/张，本月上限 ¥${plan.monthlyCapCNY}）`,
    plan,
  }, null, 2));
  process.exit(0);
}

// ── 闸门（与 HTTP 接口同源：预算上限 / 磁盘 / 队列暂停） ──
const gate = preflightBatch({ images: cases.length, confirm: true });
if (gate.blocked) {
  console.log(JSON.stringify({ ok: false, error: `闸门拒绝本次出图：${gate.reason}`, gate, plan }, null, 2));
  process.exit(1);
}

// ── 抓请求体（脱敏后进报告）：包一层 fetch，只观测、不改写 ──
const captured = [];
const realFetch = globalThis.fetch;
const VENDOR = String(g.url || '');
function stubResponse() {
  // dry 模式用的假响应：一张 2×2 PNG，结构与万相同步接口一致
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQoAHgQCAf2uJ0YAAAAASUVORK5CYII=';
  return new Response(JSON.stringify({
    output: { choices: [{ message: { content: [{ image: `data:image/png;base64,${png}` }], role: 'assistant' } }], finished: true },
    usage: { image_count: 1, total_tokens: 100 },
    request_id: 'DRY-RUN-NO-VENDOR-CALL',
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const isVendor = Boolean(VENDOR) && u.startsWith(VENDOR.slice(0, Math.min(48, VENDOR.length)));
  const rec = { url: u, method: opts.method || 'GET', isVendor, at: Date.now() };
  if (opts.body) { try { rec.body = JSON.parse(String(opts.body)); } catch { rec.bodyRawLen = String(opts.body).length; } }
  try {
    const h = opts.headers;
    const pairs = h instanceof Map ? [...h.entries()] : Array.isArray(h) ? h : Object.entries(h || {});
    rec.headers = Object.fromEntries(pairs.map(([k, v]) => [k, SECRET_KEY.test(k) ? '***已脱敏***' : String(v)]));
  } catch { rec.headers = {}; }
  const res = (DRY && isVendor) ? stubResponse() : await realFetch(url, opts);
  rec.status = res.status;
  if (isVendor) {
    try {
      const txt = await res.clone().text();
      let j = null; try { j = JSON.parse(txt); } catch { /* 非 JSON */ }
      rec.response = j ? {
        request_id: j.request_id || null,
        code: j.code ?? null,
        message: j.message ? String(j.message).slice(0, 160) : null,
        usage: j.usage ? { image_count: j.usage.image_count ?? null, total_tokens: j.usage.total_tokens ?? null, size: j.usage.size ?? null } : null,
        imageFieldPath: j?.output?.choices?.[0]?.message?.content?.find?.((c) => c.image) ? 'output.choices.0.message.content.N.image' : null,
        imageValuePrefix: (() => { const it = (j?.output?.choices?.[0]?.message?.content || []).find((c) => c.image); return it ? redactValue(it.image) : null; })(),
      } : { rawPrefix: txt.slice(0, 240) };
    } catch (e) { rec.responseError = String(e.message || e); }
  }
  captured.push(rec);
  return res;
};

// ── 逐张跑（每张一次 createKeyframeJob，shotIds 只给 1 个镜头） ──
async function waitJob(jobId, timeoutMs = 300000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const j = get('SELECT * FROM jobs WHERE id = ?', jobId);
    if (!j) return { status: 'missing' };
    if (['done', 'error', 'canceled'].includes(j.status)) return j;
    await sleep(600);
  }
  return { status: 'timeout' };
}

const out = { ok: true, generatedAt: new Date().toISOString(), mode: plan.mode, plan, gate: { ok: gate.ok, reason: gate.reason }, cases: [] };

for (const c of cases) {
  const capBefore = captured.length;
  const usageBefore = getUsage();
  const job = createKeyframeJob({ scriptId: c.shot.scriptId, code: c.shot.code, shotIds: [c.shot.shotId], backend: 'generic-http' });
  const j = await waitJob(job.jobId);
  const row = get("SELECT * FROM shot_renders WHERE shot_id = ? AND kind = 'keyframe' ORDER BY created_at DESC LIMIT 1", c.shot.shotId);
  const usageAfter = getUsage();
  let meta = {}; try { meta = JSON.parse(row?.meta || '{}'); } catch { /* ignore */ }
  const abs = row?.file_path ? path.resolve(ROOT, row.file_path) : null;
  const bytes = abs && fs.existsSync(abs) ? fs.statSync(abs).size : 0;
  const bodyRec = [...captured.slice(capBefore)].reverse().find((r) => r.isVendor && r.body) || null;
  const body = bodyRec?.body || null;
  const refPaths = body ? findRefPaths(body, g.refImageField || 'image') : [];
  const imageKeyPresent = body ? hasKey(body, g.refImageField || 'image') : null;
  const expectRef = c.kind === 'i2i';
  const checks = {
    jobDone: j.status === 'done',
    renderDone: row?.status === 'done',
    usedTemplate: meta.usedTemplate || null,
    usedTemplateOk: expectRef ? meta.usedTemplate === 'i2i' : meta.usedTemplate === 't2i',
    refImageSent: meta.refImageSent === true,
    refImageSentOk: meta.refImageSent === expectRef,
    imageKeyPresent,
    imageKeyOk: imageKeyPresent === expectRef,
    refValueIsDataUrl: expectRef ? refPaths.some((p) => String(p.value).startsWith('data:image/png;base64,')) : true,
    fileExists: bytes > 0,
    ledgerPlus1: usageAfter.images === usageBefore.images + (j.status === 'done' ? 1 : 0),
  };
  const ok = Object.entries(checks).filter(([k]) => k.endsWith('Ok') || ['jobDone', 'renderDone', 'fileExists', 'ledgerPlus1'].includes(k)).every(([, v]) => v === true);
  out.ok = out.ok && ok;
  out.cases.push({
    kind: c.kind,
    expect: expectRef ? "带参考图 → refBodyTemplate（i2i）" : '不带参考图 → bodyTemplate（t2i）',
    shot: c.shot,
    canvasRef: meta.canvasRef || c.shot.canvasRef || null,
    job: { id: job.jobId, status: j.status, error: j.error || null },
    usedTemplate: meta.usedTemplate || null,
    // 观测口径：请求体里到底有没有参考图键（true → 用的是 refBodyTemplate 那套）
    templateSource: imageKeyPresent === null ? null : (imageKeyPresent ? 'refBodyTemplate' : 'bodyTemplate'),
    request: bodyRec ? {
      url: bodyRec.url,
      method: bodyRec.method,
      status: bodyRec.status,
      headers: bodyRec.headers,
      bodyRedacted: redactBody(body),
      refFieldPaths: refPaths,
      imageKeyPresent,
    } : null,
    response: bodyRec?.response || null,
    file: row?.file_path || null,
    bytes,
    width: row?.width ?? null,
    height: row?.height ?? null,
    elapsedMs: meta.elapsedMs ?? null,
    // dry 模式（假 fetch）没有真实厂商调用，费用记 0；真跑且渲染成功才计 1 张
    estimatedCostCNY: DRY ? 0 : (j.status === 'done' && row?.status === 'done' ? Math.round(unit * 10000) / 10000 : 0),
    usage: { before: usageBefore, after: usageAfter },
    checks,
    ok,
  });
}

out.usageAfter = { month: monthKey(), ...getUsage() };
out.ledger = readUsageLedger()[monthKey()] || null;
out.elapsedMsTotal = Number(process.hrtime.bigint() / 1000000n) - t0;
if (tmpDir) out.dryTmpDir = tmpDir;
console.log(JSON.stringify(out, null, 2));
process.exit(out.ok ? 0 : 1);
