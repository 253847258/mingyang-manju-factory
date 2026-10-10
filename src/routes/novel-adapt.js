// 小说改编工作台路由（plain text module）
//
// POST /api/adapt/projects              新建项目（sourcePath 指向已上传的 txt/md/json，或直接传 text）
// POST /api/adapt/projects/:id/run      执行改编：剧本 / 角色 / 场景 / 道具 / 提示词 / 资产清单
// GET  /api/adapt/projects              项目列表
// GET  /api/adapt/projects/:id          项目详情
// GET  /api/adapt/projects/:id/export   导出 json / md / csv
// DELETE /api/adapt/projects/:id        删除项目

import { badRequest, notFound } from '../http.js';
import {
  ensureAdaptSchema,
  listAdaptProjects,
  createAdaptProject,
  getAdaptProject,
  runAdaptation,
  importAdaptation,
  exportAdaptation,
  deleteAdaptProject,
} from '../novel-adapt.js';

function param(ctx, name) {
  if (ctx?.params && typeof ctx.params === 'object') return ctx.params[name];
  const url = String(ctx?.url || ctx?.path || '');
  const parts = url.split('?')[0].split('/').filter(Boolean);
  if (name === 'id') return parts[2] || '';
  return '';
}

export function registerNovelAdaptRoutes(app) {
  ensureAdaptSchema();

  app.get('/api/adapt/meta', async (ctx) => ctx.json({
    ok: true,
    supported: ['txt', 'md', 'json'],
    outputs: ['剧本', '角色', '场景', '道具', '文生图提示词', '资产清单'],
    exports: ['json', 'md', 'csv'],
  }));

  app.get('/api/adapt/projects', async (ctx) => ctx.json({
    ok: true,
    projects: listAdaptProjects(),
  }));

  app.post('/api/adapt/projects', async (ctx) => {
    try {
      const body = (await ctx.body()) || {};
      const project = createAdaptProject(body);
      ctx.json({ ok: true, project });
    } catch (err) {
      throw badRequest(err.message || '创建改编项目失败');
    }
  });

  app.get('/api/adapt/projects/:id', async (ctx) => {
    const id = param(ctx, 'id');
    const bundle = getAdaptProject(id);
    if (!bundle) throw notFound('改编项目不存在');
    ctx.json({ ok: true, ...bundle });
  });

  app.post('/api/adapt/projects/:id/run', async (ctx) => {
    const id = param(ctx, 'id');
    try {
      const body = (await ctx.body()) || {};
      const bundle = await runAdaptation(id, body);
      ctx.json({ ok: true, ...bundle });
    } catch (err) {
      throw badRequest(err.message || '小说改编失败');
    }
  });

  app.post('/api/adapt/projects/:id/import', async (ctx) => {
    const id = param(ctx, 'id');
    try {
      const body = (await ctx.body()) || {};
      const result = await importAdaptation(id, body);
      ctx.json({ ok: true, ...result });
    } catch (err) {
      throw badRequest(err.message || '导入演员/画布/剧本失败');
    }
  });

  app.get('/api/adapt/projects/:id/export', async (ctx) => {
    const id = param(ctx, 'id');
    const format = String(ctx.query?.format || 'json').toLowerCase();
    try {
      const result = exportAdaptation(id, format);
      if (result.format === 'json') return ctx.json({ ok: true, ...result });
      const body = Buffer.from(result.text, 'utf8');
      ctx.res.writeHead(200, {
        'content-type': result.format === 'csv' ? 'text/csv; charset=utf-8' : 'text/markdown; charset=utf-8',
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`,
        'content-length': body.length,
      });
      ctx.res.end(body);
    } catch (err) {
      throw badRequest(err.message || '导出失败');
    }
  });

  app.delete('/api/adapt/projects/:id', async (ctx) => {
    const id = param(ctx, 'id');
    deleteAdaptProject(id);
    ctx.json({ ok: true, deleted: id });
  });
}
