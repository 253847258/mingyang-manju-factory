// 画布增强路由（plain text module）
//
// 九宫格：/api/canvas/sheets/plan|generate|compose|GET
// 描述改进：/api/describe/preview|apply|undo
// 一致性：/api/canvas/consistency、/api/canvas/consistency/rerun
// 提示词：/api/prompt/diagnose、/api/prompt/professionalize

import path from 'node:path';
import fs from 'node:fs';
import { badRequest } from '../http.js';
import { all, get, run, ROOT, DATA_DIR } from '../db.js';
import { nowISO, rid } from '../util.js';
import { generateImage } from '../image.js';
import { preflightBatch } from '../modules/render.js';
import { setPrimaryImage, updateAsset } from '../modules/actors.js';
import { planSheet, composeSheet, SHEET_COLS } from '../image-sheets.js';
import { promptDiagnose, promptRepair, professionalizePrompt } from '../prompt-quality.js';
import { preview, applyPreview, undoPreview } from '../describe.js';
import { scoreCanvas, CONSISTENCY_THRESHOLD } from '../canvas-consistency.js';

const SHEET_DIR = path.join(DATA_DIR, 'images', 'sheets');
const RASTER_RE = /\.(png|jpe?g|webp|bmp|gif|tiff?)$/i;

function toRel(abs) {
  if (!abs) return '';
  const p = String(abs);
  if (!path.isAbsolute(p)) return p.replace(/\\/g, '/');
  const r = path.relative(ROOT, p);
  return (r.startsWith('..') ? p : r).replace(/\\/g, '/');
}

function safeJson(value, fallback) {
  try {
    if (value === null || value === undefined || value === '') return fallback;
    if (typeof value === 'object') return value;
    return JSON.parse(value);
  } catch { return fallback; }
}

function resolveActor(actorId) {
  const actor = get('SELECT * FROM actors WHERE id = ?', actorId);
  if (!actor) throw new Error('演员不存在');
  return actor;
}

function resolveSceneNode(nodeId) {
  const node = get('SELECT * FROM canvas_nodes WHERE id = ?', nodeId);
  if (!node) throw new Error('节点不存在');
  if (!['scene', 'item', 'refimg'].includes(String(node.kind || ''))) throw new Error('该节点不是环境/物品节点');
  return node;
}

function actorRefImage(actor) {
  const ref = actor.ref_image || '';
  if (ref && RASTER_RE.test(ref)) return ref;
  const primary = all("SELECT * FROM actor_images WHERE actor_id = ? AND status = 'done' AND is_primary = 1 ORDER BY created_at DESC LIMIT 1", actor.id)[0];
  if (primary && RASTER_RE.test(primary.file_path || '')) return primary.file_path;
  return null;
}

function saveActorImage({ actorId, kind, variant, label, prompt, negative, seed, width, height, filePath, mime, backend, model, isPrimary = 0 }) {
  const id = rid('IMG');
  run(
    `INSERT INTO actor_images(id, actor_id, kind, variant, label, prompt_pos, prompt_neg, seed, width, height, backend, model, file_path, mime, is_primary, status, created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'done', ?)`,
    id, actorId, kind, variant, label || '', prompt || '', negative || '', seed ?? null,
    width || null, height || null, backend || '', model || '', filePath, mime || '', isPrimary ? 1 : 0, nowISO(),
  );
  return id;
}

function sheetMetaOf(meta) {
  const m = safeJson(meta, {}) || {};
  if (!Array.isArray(m.sheets)) m.sheets = [];
  return m;
}

// 付费闸门：
// - 存储/预算类阻断 → 硬拒绝
// - 队列暂停（jobs:paused，本意是「防恢复主库后自动续跑历史任务」）：
//     * 后台任务：仍然拦住（不能往暂停的队列里塞任务）
//     * 同步的用户动作（sync=true，或本身就同步的一致性重跑）：确认后可执行，不进队列
// - 预算「需确认」→ 返回 needConfirm，由前端二次确认
function paidGate(body = {}, images = 0, { sync = Boolean(body?.sync) } = {}) {
  const pre = preflightBatch({ images, videos: 0, confirm: Boolean(body.confirm) });
  if (pre.paused) {
    if (!sync) return { ok: false, res: { blocked: true, paused: true, needConfirm: false, reason: pre.reason }, pre };
    if (!body.confirm) {
      return { ok: false, res: { needConfirm: true, paused: true, reason: `${pre.reason}（这是同步动作：确认后立即生成，不会写回队列）` }, pre };
    }
    return { ok: true, pre };
  }
  if (pre.blocked) return { ok: false, res: { blocked: true, needConfirm: false, reason: pre.reason || '被安全闸门拒绝' }, pre };
  if (pre.needConfirm && !body.confirm) return { ok: false, res: { needConfirm: true, reason: pre.reason }, pre };
  return { ok: true, pre };
}

async function generateSheet(jobCtx, { sheetKind, targetId, styleId, ratio, cell, gap, cols, setPrimary = true, useRef = true }) {
  fs.mkdirSync(SHEET_DIR, { recursive: true });
  const isChar = sheetKind !== 'environment';
  let planned;
  let actor = null;
  let node = null;
  if (isChar) {
    actor = resolveActor(targetId);
    planned = planSheet({ sheetKind: 'character', actor, styleId, ratio });
  } else {
    node = resolveSceneNode(targetId);
    const data = safeJson(node.data, {}) || {};
    planned = planSheet({ sheetKind: 'environment', scene: { ...data, title: node.title || data.title || '', styleId: styleId || data.styleId }, styleId });
  }
  const refImage = useRef && actor ? actorRefImage(actor) : null;
  const files = [];
  const cells = [];
  let done = 0;
  const total = planned.cells.length + 1;
  for (const c of planned.cells) {
    if (jobCtx?.isCanceled?.()) throw new Error('任务已取消');
    const r = await generateImage({
      actorId: isChar ? actor.id : `ASSET_${node.id}`,
      kind: isChar ? `sheet-${c.key}` : `${node.kind}_sheet`,
      variant: c.key,
      prompt: c.prompt,
      negative: c.negative,
      width: c.width,
      height: c.height,
      seed: undefined,
      refImage: refImage || undefined,
    });
    const relPath = toRel(r.absPath || r.filePath);
    const abs = r.absPath || r.filePath;
    if (!RASTER_RE.test(String(abs))) throw new Error(`该镜头不是栅格图，无法拼图：${abs}`);
    files.push(abs);
    cells.push({ key: c.key, label: c.label, file: relPath, width: r.width, height: r.height });
    if (isChar) {
      saveActorImage({
        actorId: actor.id, kind: `sheet-${c.key}`, variant: c.key, label: c.label,
        prompt: c.prompt, negative: c.negative, seed: r.seed, width: r.width, height: r.height,
        filePath: relPath, mime: r.mime, backend: r.backend, model: r.model,
      });
    }
    done += 1;
    jobCtx?.progress?.(Math.round((done / total) * 100), { done, total });
    jobCtx?.log?.(`已生成 ${c.label}（${done}/${planned.cells.length}）`);
  }
  const ts = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const outAbs = path.join(SHEET_DIR, `${isChar ? actor.id : node.id}_3x3_${ts}.png`);
  const composed = composeSheet({ files, cols: cols || SHEET_COLS, cell: cell || 512, gap: gap ?? 12, outPath: outAbs });
  const sheetRel = toRel(outAbs);
  let sheetId = null;
  if (isChar) {
    sheetId = saveActorImage({
      actorId: actor.id, kind: 'sheet', variant: '3x3', label: `${actor.name || actor.id} 九宫格`,
      prompt: planned.cells.map((c) => c.prompt).join(' | ').slice(0, 4000), negative: planned.cells[0]?.negative || '',
      width: null, height: null, filePath: sheetRel, mime: 'image/png', backend: composed.engine, model: 'sheet',
    });
    if (setPrimary) setPrimaryImage(actor.id, sheetId);
    const meta = sheetMetaOf(actor.meta);
    meta.sheets.unshift({ id: sheetId, kind: 'character', variant: '3x3', file: sheetRel, cells, styleId: planned.styleId, createdAt: nowISO() });
    meta.sheets = meta.sheets.slice(0, 10);
    run('UPDATE actors SET meta = ?, updated_at = ? WHERE id = ?', JSON.stringify(meta), nowISO(), actor.id);
  } else {
    const data = safeJson(node.data, {}) || {};
    data.refImages = [sheetRel, ...(Array.isArray(data.refImages) ? data.refImages : [])].slice(0, 12);
    data.sheets = [{ kind: 'environment', variant: '3x3', file: sheetRel, cells, styleId: planned.styleId, createdAt: nowISO() }, ...(Array.isArray(data.sheets) ? data.sheets : [])].slice(0, 10);
    updateAsset(node.id, { data });
  }
  jobCtx?.progress?.(100, { done: total, total });
  return {
    ok: true,
    sheetKind: isChar ? 'character' : 'environment',
    targetId: isChar ? actor.id : node.id,
    file: sheetRel,
    absPath: outAbs,
    engine: composed.engine,
    cells,
    sheetId,
    primarySet: Boolean(isChar && setPrimary),
  };
}

export function registerCanvasEnhanceRoutes(app) {
  app.post('/api/canvas/sheets/plan', async (ctx) => {
    try {
      const body = (await ctx.body()) || {};
      const sheetKind = body.kind === 'environment' ? 'environment' : 'character';
      const targetId = sheetKind === 'environment' ? body.nodeId : body.actorId;
      if (!targetId) throw new Error(sheetKind === 'environment' ? '缺少 nodeId' : '缺少 actorId');
      const planned = sheetKind === 'environment'
        ? planSheet({ sheetKind, scene: { ...(safeJson(resolveSceneNode(targetId).data, {}) || {}), title: resolveSceneNode(targetId).title }, styleId: body.styleId })
        : planSheet({ sheetKind, actor: resolveActor(targetId), styleId: body.styleId, ratio: body.ratio });
      const pre = preflightBatch({ images: planned.cells.length, videos: 0, confirm: Boolean(body.confirm) });
      ctx.json({
        ok: true,
        sheetKind,
        targetId,
        count: planned.count,
        cols: planned.cols,
        styleId: planned.styleId,
        ratio: planned.ratio,
        cells: planned.cells,
        estimate: { images: planned.cells.length, cost: pre.budget?.estimated || null },
        needConfirm: Boolean(pre.needConfirm),
        blocked: Boolean(pre.blocked),
        reason: pre.reason,
      });
    } catch (err) { throw badRequest(err.message || '九宫格规划失败'); }
  });

  app.post('/api/canvas/sheets/generate', async (ctx) => {
    try {
      const body = (await ctx.body()) || {};
      const sheetKind = body.kind === 'environment' ? 'environment' : 'character';
      const targetId = sheetKind === 'environment' ? body.nodeId : body.actorId;
      if (!targetId) throw new Error(sheetKind === 'environment' ? '缺少 nodeId' : '缺少 actorId');
      const opts = {
        sheetKind, targetId, styleId: body.styleId, ratio: body.ratio,
        cell: Number(body.cell) || 512, gap: body.gap === undefined ? 12 : Number(body.gap),
        cols: Number(body.cols) || SHEET_COLS, setPrimary: body.setPrimary !== false, useRef: body.useRef !== false,
      };
      const gate = paidGate(body, 9);
      if (!gate.ok) {
        ctx.json({ ok: true, ...gate.res, estimate: gate.pre?.budget?.estimated || null });
        return;
      }
      if (body.sync) {
        const result = await generateSheet({ progress: () => {}, log: () => {}, isCanceled: () => false }, opts);
        ctx.json(result);
        return;
      }
      const { enqueue } = await import('../jobs.js');
      const label = sheetKind === 'environment' ? '环境九宫格' : '人物九宫格';
      const jobId = enqueue({
        type: 'sheet',
        title: `${label} · ${targetId}`,
        total: 10,
        limit: 1,
        payload: opts,
        handler: (job) => generateSheet(job, opts),
      });
      ctx.json({ ok: true, jobId, total: 10, sheetKind, targetId });
    } catch (err) { throw badRequest(err.message || '九宫格生成失败'); }
  });

  app.post('/api/canvas/sheets/compose', async (ctx) => {
    try {
      const body = (await ctx.body()) || {};
      const files = (Array.isArray(body.files) ? body.files : []).map((f) => (path.isAbsolute(f) ? f : path.join(ROOT, f)));
      if (!files.length) throw new Error('缺少 files');
      fs.mkdirSync(SHEET_DIR, { recursive: true });
      const outAbs = path.join(SHEET_DIR, `manual_3x3_${Date.now()}.png`);
      const r = composeSheet({ files, cols: Number(body.cols) || SHEET_COLS, cell: Number(body.cell) || 512, gap: body.gap ?? 12, outPath: outAbs, preferFfmpeg: body.preferFfmpeg !== false });
      ctx.json({ ok: true, file: toRel(outAbs), engine: r.engine, count: r.count });
    } catch (err) { throw badRequest(err.message || '拼图失败'); }
  });

  app.get('/api/canvas/sheets', async (ctx) => {
    try {
      const actorId = String(ctx.query?.actorId || '');
      const nodeId = String(ctx.query?.nodeId || '');
      if (actorId) {
        const actor = resolveActor(actorId);
        ctx.json({ ok: true, scope: 'actor', id: actorId, sheets: sheetMetaOf(actor.meta).sheets });
        return;
      }
      if (nodeId) {
        const node = resolveSceneNode(nodeId);
        const data = safeJson(node.data, {}) || {};
        ctx.json({ ok: true, scope: 'node', id: nodeId, sheets: Array.isArray(data.sheets) ? data.sheets : [] });
        return;
      }
      throw new Error('请提供 actorId 或 nodeId');
    } catch (err) { throw badRequest(err.message || '读取九宫格失败'); }
  });

  // ---- 描述自动改进 ----
  app.post('/api/describe/preview', async (ctx) => {
    try {
      const body = (await ctx.body()) || {};
      const scope = body.scope === 'asset' ? 'asset' : 'actor';
      if (!body.id) throw new Error('缺少 id');
      ctx.json(await preview(scope, body.id));
    } catch (err) { throw badRequest(err.message || '描述预览失败'); }
  });

  app.post('/api/describe/apply', async (ctx) => {
    try {
      const body = (await ctx.body()) || {};
      if (!body.token) throw new Error('缺少 token');
      ctx.json(applyPreview(body.token, { includePrompt: Boolean(body.includePrompt), promptSuggestion: body.promptSuggestion || null }));
    } catch (err) { throw badRequest(err.message || '应用描述失败'); }
  });

  app.post('/api/describe/undo', async (ctx) => {
    try {
      const body = (await ctx.body()) || {};
      if (!body.token) throw new Error('缺少 token');
      ctx.json(undoPreview(body.token));
    } catch (err) { throw badRequest(err.message || '撤销失败'); }
  });

  // ---- 一致性闸门 ----
  app.get('/api/canvas/consistency', async (ctx) => {
    try {
      const canvasId = String(ctx.query?.canvasId || 'CV-MAIN');
      const threshold = ctx.query?.threshold ? Number(ctx.query.threshold) : CONSISTENCY_THRESHOLD;
      ctx.json(await scoreCanvas(canvasId, { threshold }));
    } catch (err) { throw badRequest(err.message || '一致性评分失败'); }
  });

  app.post('/api/canvas/consistency/rerun', async (ctx) => {
    try {
      const body = (await ctx.body()) || {};
      const report = await scoreCanvas(String(body.canvasId || 'CV-MAIN'), { threshold: body.threshold ? Number(body.threshold) : CONSISTENCY_THRESHOLD });
      const targets = report.low.filter((n) => !n.locked);
      if (!targets.length) { ctx.json({ ok: true, rerun: 0, reason: '没有需要重跑的低分节点（锁定节点会跳过）' }); return; }
      const gate = paidGate(body, targets.reduce((n, x) => n + Math.max(1, x.outliers.length), 0), { sync: true });
      if (!gate.ok) { ctx.json({ ok: true, ...gate.res, targets: targets.map((t) => t.id) }); return; }
      const regenerated = [];
      for (const t of targets) {
        if (t.kind === 'actor' && t.actorId) {
          const actor = resolveActor(t.actorId);
          const ref = actorRefImage(actor);
          const r = await generateImage({
            actorId: actor.id, kind: 'full', variant: 'keyart',
            prompt: actor.prompt_pos || '', negative: actor.prompt_neg || '',
            width: actor.width || 1024, height: actor.height || 1536, refImage: ref || undefined,
          });
          saveActorImage({
            actorId: actor.id, kind: 'full', variant: 'rerun', label: '一致性重跑',
            prompt: actor.prompt_pos || '', negative: actor.prompt_neg || '', seed: r.seed,
            width: r.width, height: r.height, filePath: toRel(r.absPath || r.filePath), mime: r.mime, backend: r.backend, model: r.model,
          });
          regenerated.push({ nodeId: t.id, actorId: actor.id, file: toRel(r.absPath || r.filePath) });
        }
      }
      ctx.json({ ok: true, rerun: regenerated.length, skippedLocked: report.low.length - targets.length, regenerated, reason: '已对低分节点重跑主图（未改审核/锁定状态）' });
    } catch (err) { throw badRequest(err.message || '一键重跑失败'); }
  });

  // ---- 提示词体检 / 专业化 ----
  app.post('/api/prompt/diagnose', async (ctx) => {
    try {
      const body = (await ctx.body()) || {};
      const { base, negative, styleId } = resolvePromptTarget(body);
      ctx.json({ ok: true, ...promptDiagnose(base, { negative, styleId }), repaired: promptRepair(base, { styleId, negative }) });
    } catch (err) { throw badRequest(err.message || '提示词体检失败'); }
  });

  app.post('/api/prompt/professionalize', async (ctx) => {
    try {
      const body = (await ctx.body()) || {};
      const target = resolvePromptTarget(body);
      const out = await professionalizePrompt({ scope: body.scope, base: target.base, negative: target.negative, styleId: target.styleId, instruction: body.instruction || '' });
      if (body.apply && body.confirm) {
        writePromptTarget(target, out);
        ctx.json({ ...out, applied: true });
        return;
      }
      ctx.json({ ...out, applied: false, preview: true });
    } catch (err) { throw badRequest(err.message || '提示词专业化失败'); }
  });
}

function resolvePromptTarget(body = {}) {
  const scope = body.scope || 'actor';
  if (body.text !== undefined) return { scope: 'text', base: String(body.text || ''), negative: String(body.negative || ''), styleId: body.styleId || '', id: null };
  if (scope === 'asset') {
    const node = resolveSceneNode(body.id);
    const data = safeJson(node.data, {}) || {};
    return { scope, base: String(data.prompt || ''), negative: String(data.negative || ''), styleId: body.styleId || data.styleId || '', id: node.id, kind: node.kind };
  }
  if (scope === 'shot') {
    const shot = get('SELECT * FROM shots WHERE id = ?', body.id);
    if (!shot) throw new Error('镜头不存在');
    const script = get('SELECT * FROM scripts WHERE id = ?', shot.script_id);
    return { scope, base: String(shot.prompt_pos || ''), negative: String(shot.prompt_neg || ''), styleId: body.styleId || script?.style_id || '', id: shot.id };
  }
  const actor = resolveActor(body.id);
  return { scope: 'actor', base: String(actor.prompt_pos || ''), negative: String(actor.prompt_neg || ''), styleId: body.styleId || actor.style_id || '', id: actor.id };
}

function writePromptTarget(target, out) {
  if (!target.id) throw new Error('缺少可写入的目标 id');
  if (target.scope === 'asset') {
    const node = get('SELECT * FROM canvas_nodes WHERE id = ?', target.id);
    const data = safeJson(node.data, {}) || {};
    data.prompt = out.positive;
    data.negative = out.negative;
    updateAsset(target.id, { data });
    return;
  }
  if (target.scope === 'shot') {
    run('UPDATE shots SET prompt_pos = ?, prompt_neg = ? WHERE id = ?', out.positive, out.negative, target.id);
    return;
  }
  run('UPDATE actors SET prompt_pos = ?, prompt_neg = ?, updated_at = ? WHERE id = ?', out.positive, out.negative, nowISO(), target.id);
}
