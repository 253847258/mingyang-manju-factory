// 后期精修 · HTTP 路由（plain text module）
//
// 全量受 config.edit.enabled 控制：未启用时统一返回 404，旧链路完全不受影响。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { badRequest, notFound } from '../http.js';
import { enqueue } from '../jobs.js';
import { loadConfig } from '../config.js';
import {
  ensureEditSchema, getOrCreateTimeline, getTimelineDoc, saveTimelineDoc,
  resyncPreview, resyncApply, listVersions, restoreVersion,
  setReviewStatus, listComments, addComment, updateComment,
  listAudit, listEpisodes, getOperator, setOperator, listFilms,
  EditConflictError, EditLockedError,
} from '../edit-timeline.js';
import { renderTimeline } from '../edit-render.js';
import { buildEditPackage } from '../edit-package.js';
import { parseImport, diffTimeline, applyImport } from '../edit-import.js';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const CONFIG_FILE = process.env.FACTORY_CONFIG || path.join(ROOT, 'config', 'config.json');

function editEnabled() {
  try {
    return loadConfig()?.edit?.enabled === true;
  } catch {
    try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))?.edit?.enabled === true; } catch { return false; }
  }
}

function ensureEnabled() {
  if (!editEnabled()) throw notFound('后期精修未启用（config.edit.enabled = false）');
}

function handleErr(ctx, err) {
  if (err instanceof EditConflictError || err instanceof EditLockedError) {
    ctx.json({ ok: false, error: err.message, code: err.status }, err.status);
    return;
  }
  throw badRequest(err.message || '后期精修操作失败');
}

export function registerEditRoutes(app) {
  app.get('/api/edit/status', async (ctx) => {
    ctx.json({ ok: true, enabled: editEnabled(), operator: (() => { try { ensureEditSchema(); return getOperator(); } catch { return '未署名'; } })() });
  });

  app.post('/api/edit/operator', async (ctx) => {
    ensureEnabled(); ensureEditSchema();
    const body = (await ctx.body()) || {};
    const who = setOperator(body.name);
    ctx.json({ ok: true, operator: who });
  });

  app.get('/api/edit/episodes', async (ctx) => {
    ensureEnabled(); ensureEditSchema();
    ctx.json({ ok: true, episodes: listEpisodes() });
  });

  // 按剧集代码取时间线（不存在则从分镜快照创建）
  app.get('/api/edit/timelines/:code', async (ctx) => {
    ensureEnabled(); ensureEditSchema();
    try {
      const doc = getOrCreateTimeline(ctx.params.code, { scriptId: ctx.query.script_id || null });
      ctx.json({ ok: true, ...doc });
    } catch (e) { handleErr(ctx, e); }
  });

  app.get('/api/edit/timelines-by-id/:id', async (ctx) => {
    ensureEnabled(); ensureEditSchema();
    const doc = getTimelineDoc(ctx.params.id);
    if (!doc) throw notFound('时间线不存在');
    ctx.json({ ok: true, ...doc });
  });

  app.put('/api/edit/timelines/:id', async (ctx) => {
    ensureEnabled(); ensureEditSchema();
    try {
      const body = (await ctx.body()) || {};
      const doc = saveTimelineDoc(ctx.params.id, body, {
        docVersion: body.doc_version,
        operator: body.operator || getOperator(),
      });
      ctx.json({ ok: true, ...doc });
    } catch (e) { handleErr(ctx, e); }
  });

  app.post('/api/edit/timelines/:id/resync', async (ctx) => {
    ensureEnabled(); ensureEditSchema();
    try {
      const body = (await ctx.body()) || {};
      if (body.apply === true) ctx.json({ ok: true, ...resyncApply(ctx.params.id, { operator: body.operator || getOperator() }) });
      else ctx.json({ ok: true, preview: resyncPreview(ctx.params.id) });
    } catch (e) { handleErr(ctx, e); }
  });

  // 渲染成片（异步任务）
  app.post('/api/edit/timelines/:id/render', async (ctx) => {
    ensureEnabled(); ensureEditSchema();
    try {
      const body = (await ctx.body()) || {};
      const doc = getTimelineDoc(ctx.params.id);
      if (!doc) throw notFound('时间线不存在');
      if (doc.timeline.status === 'locked') throw new Error('时间线已锁定，不能渲染新版本');
      const operator = body.operator || getOperator();
      const jobId = enqueue({
        type: 'assemble',
        title: `后期渲染 · ${doc.timeline.code}`,
        total: 4,
        payload: { action: 'edit-render', timelineId: ctx.params.id },
        handler: async (job) => {
          job.step(1, 4);
          job.log('读取时间线…');
          const r = await renderTimeline(ctx.params.id, {
            operator,
            onStep: (s) => { if (s.message) job.log(s.message); },
          });
          job.step(3, 4);
          job.log(`渲染完成：${r.duration} 秒 · ${Math.round(r.size / 1024)} KB`);
          job.step(4, 4);
          return r;
        },
      });
      ctx.json({ ok: true, jobId });
    } catch (e) { handleErr(ctx, e); }
  });

  app.get('/api/edit/timelines/:id/versions', async (ctx) => {
    ensureEnabled(); ensureEditSchema();
    ctx.json({ ok: true, versions: listVersions(ctx.params.id), films: listFilms(ctx.params.id) });
  });

  app.post('/api/edit/timelines/:id/versions/:no/restore', async (ctx) => {
    ensureEnabled(); ensureEditSchema();
    try {
      const body = (await ctx.body()) || {};
      ctx.json({ ok: true, ...restoreVersion(ctx.params.id, Number(ctx.params.no), { operator: body.operator || getOperator() }) });
    } catch (e) { handleErr(ctx, e); }
  });

  app.post('/api/edit/timelines/:id/review', async (ctx) => {
    ensureEnabled(); ensureEditSchema();
    try {
      const body = (await ctx.body()) || {};
      const tl = setReviewStatus(ctx.params.id, String(body.status || ''), {
        note: body.note || '',
        operator: body.operator || getOperator(),
        filmId: body.film_id || null,
      });
      ctx.json({ ok: true, timeline: tl });
    } catch (e) { handleErr(ctx, e); }
  });

  app.get('/api/edit/timelines/:id/comments', async (ctx) => {
    ensureEnabled(); ensureEditSchema();
    ctx.json({ ok: true, comments: listComments(ctx.params.id) });
  });

  app.post('/api/edit/timelines/:id/comments', async (ctx) => {
    ensureEnabled(); ensureEditSchema();
    try {
      const body = (await ctx.body()) || {};
      ctx.json({ ok: true, comment: addComment(ctx.params.id, { ...body, author: body.author || getOperator() }) });
    } catch (e) { handleErr(ctx, e); }
  });

  app.patch('/api/edit/comments/:cid', async (ctx) => {
    ensureEnabled(); ensureEditSchema();
    try {
      const body = (await ctx.body()) || {};
      ctx.json({ ok: true, comment: updateComment(ctx.params.cid, body, { operator: body.operator || getOperator() }) });
    } catch (e) { handleErr(ctx, e); }
  });

  app.get('/api/edit/timelines/:id/audit', async (ctx) => {
    ensureEnabled(); ensureEditSchema();
    ctx.json({ ok: true, logs: listAudit(ctx.params.id, Number(ctx.query.limit) || 100) });
  });

  // P1：导出工程包（代理素材 + EDL/FCP7/OTIO + 素材清单）
  app.post('/api/edit/timelines/:id/package', async (ctx) => {
    ensureEnabled(); ensureEditSchema();
    try {
      const body = (await ctx.body()) || {};
      const doc = getTimelineDoc(ctx.params.id);
      if (!doc) throw notFound('时间线不存在');
      const operator = body.operator || getOperator();
      const withProxy = body.withProxy !== false;
      const height = Number(body.height) || 540;
      const jobId = enqueue({
        type: 'assemble',
        title: `导出工程包 · ${doc.timeline.code}`,
        total: 5,
        payload: { action: 'edit-package', timelineId: ctx.params.id, withProxy, height },
        handler: async (job) => {
          job.step(1, 5);
          job.log(withProxy ? '正在转码代理素材…' : '跳过代理素材');
          const r = buildEditPackage(ctx.params.id, {
            operator,
            withProxy,
            height,
            onStep: (s) => { if (s.message) job.log(s.message); else if (s.phase === 'proxy') job.log(`代理 ${s.index}/${s.total}：${s.file}`); },
          });
          job.step(4, 5);
          job.log(`工程包已生成：${Math.round(r.size / 1024)} KB（${r.proxyCount} 个代理）`);
          job.step(5, 5);
          return r;
        },
      });
      ctx.json({ ok: true, jobId });
    } catch (e) { handleErr(ctx, e); }
  });

  // P1：回灌 FCP7 XML / OTIO（默认 dry-run，返回差异；apply=true 才写库）
  app.post('/api/edit/timelines/:id/import', async (ctx) => {
    ensureEnabled(); ensureEditSchema();
    try {
      const body = (await ctx.body()) || {};
      const content = String(body.content || '');
      if (!content.trim()) throw new Error('请提供 FCP7 XML 或 OTIO JSON 内容');
      const parsed = parseImport(content);
      if (!parsed.ok) throw new Error(parsed.error);
      const doc = getTimelineDoc(ctx.params.id);
      if (!doc) throw notFound('时间线不存在');
      const diff = diffTimeline(doc, parsed);
      if (body.apply === true) {
        const r = applyImport(ctx.params.id, {
          content,
          docVersion: body.doc_version,
          operator: body.operator || getOperator(),
        });
        ctx.json({ ok: true, applied: true, changed: r.changed, diff: r.diff, timeline: r.doc.timeline, tracks: r.doc.tracks });
        return;
      }
      ctx.json({ ok: true, applied: false, diff });
    } catch (e) { handleErr(ctx, e); }
  });
}
