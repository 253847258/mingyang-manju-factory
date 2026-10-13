// 小说工坊 · 故事框架 AI 自动填写路由（plain text module）

import { badRequest } from '../http.js';
import { generateFrameworkProposal, commitCharacters } from '../novel-ai.js';
import {
  outlineAiStatus, loadSections, novelOf, fillSections, generateSection, planChapters, saveOutlineVersion,
} from '../novel-outline-ai.js';
import { writeLongChapter } from '../novel-writing.js';
import { buildNovelAssets } from '../novel-assets.js';
import { characterFreeMode, updateCharacterFreeMode, discoverPlotCharacters, autoArchivePlotCharacters } from '../novel-characters.js';

function param(ctx, name) {
  return ctx?.params && typeof ctx.params === 'object' ? ctx.params[name] : '';
}

export function registerNovelAiRoutes(app) {
  app.post('/api/novels/ai/framework', async (ctx) => {
    try {
      const body = (await ctx.body()) || {};
      const proposal = await generateFrameworkProposal(body);
      ctx.json(proposal);
    } catch (err) {
      throw badRequest(err.message || 'AI 生成故事框架失败');
    }
  });

  app.post('/api/novels/ai/commit-characters', async (ctx) => {
    try {
      const body = (await ctx.body()) || {};
      const result = await commitCharacters(body);
      ctx.json(result);
    } catch (err) {
      throw badRequest(err.message || '创建演员矩阵角色卡失败');
    }
  });

  // ---- 大纲「自动 AI 规划生成」：逐节生成 / 一键补齐 / 落库 ----
  app.get('/api/novels/:id/outline/ai/status', async (ctx) => {
    try { ctx.json(outlineAiStatus(param(ctx, 'id'))); }
    catch (err) { throw badRequest(err.message || '读取大纲 AI 状态失败'); }
  });

  app.get('/api/novels/:id/assets', async (ctx) => {
    try { ctx.json(buildNovelAssets(param(ctx, 'id'))); }
    catch (err) { throw badRequest(err.message || '读取小说资产失败'); }
  });

  app.get('/api/novels/:id/characters/free-mode', async (ctx) => {
    try { ctx.json(characterFreeMode(param(ctx, 'id'))); }
    catch (err) { throw badRequest(err.message || '读取角色自由模式失败'); }
  });

  app.put('/api/novels/:id/characters/free-mode', async (ctx) => {
    try {
      const body = (await ctx.body()) || {};
      ctx.json({ ok: true, mode: updateCharacterFreeMode(param(ctx, 'id'), body) });
    } catch (err) { throw badRequest(err.message || '保存角色自由模式失败'); }
  });

  app.post('/api/novels/:id/characters/free-mode/plan', async (ctx) => {
    try {
      const body = (await ctx.body()) || {};
      ctx.json(await discoverPlotCharacters(param(ctx, 'id'), { instruction: String(body.instruction || '') }));
    } catch (err) { throw badRequest(err.message || '角色剧情规划失败'); }
  });

  app.post('/api/novels/:id/characters/free-mode/auto', async (ctx) => {
    try {
      const body = (await ctx.body()) || {};
      ctx.json(await autoArchivePlotCharacters(param(ctx, 'id'), {
        apply: body.apply !== false,
        instruction: String(body.instruction || ''),
      }));
    } catch (err) { throw badRequest(err.message || '自动补齐角色失败'); }
  });

  app.post('/api/novels/:id/outline/ai/section', async (ctx) => {
    try {
      const body = (await ctx.body()) || {};
      const novelId = param(ctx, 'id');
      const novel = novelOf(novelId);
      const sections = loadSections(novelId);
      const r = await generateSection(novel, sections, String(body.key || ''), { instruction: String(body.instruction || '') });
      const saved = body.save
        ? saveOutlineVersion(novelId, { ...sections, [r.key]: r.value }, { source: `ai-section:${r.key}`, note: String(body.note || '') })
        : null;
      ctx.json({ ok: true, key: r.key, label: r.label, value: r.value, mocked: !!r.mocked, model: r.model || '', saved });
    } catch (err) { throw badRequest(err.message || 'AI 生成该分节失败'); }
  });

  app.post('/api/novels/:id/outline/ai/fill', async (ctx) => {
    try {
      const body = (await ctx.body()) || {};
      const novelId = param(ctx, 'id');
      const novel = novelOf(novelId);
      const sections = loadSections(novelId);
      const keys = Array.isArray(body.keys) && body.keys.length ? body.keys.map(String) : null;
      const r = await fillSections(novel, sections, {
        keys,
        instruction: String(body.instruction || ''),
        onlyEmpty: body.onlyEmpty !== false,
      });
      const saved = body.save
        ? saveOutlineVersion(novelId, r.sections, { source: 'ai-fill', note: String(body.note || '') })
        : null;
      ctx.json({
        ok: true,
        requested: r.requested,
        keys: r.results.map((x) => x.key),
        results: r.results,
        warnings: r.warnings,
        calls: r.calls,
        mocked: r.results.some((x) => x.mocked),
        saved,
      });
    } catch (err) { throw badRequest(err.message || 'AI 补齐大纲失败'); }
  });

  app.post('/api/novels/:id/outline/ai/chapters', async (ctx) => {
    try {
      const body = (await ctx.body()) || {};
      const novelId = param(ctx, 'id');
      const novel = novelOf(novelId);
      const sections = loadSections(novelId);
      const r = await planChapters(novel, sections, {
        from: body.from,
        to: body.to,
        onlyEmpty: body.onlyEmpty !== false,
        instruction: String(body.instruction || ''),
        maxCalls: body.maxCalls,
      });
      const saved = body.save
        ? saveOutlineVersion(novelId, r.sections, { source: 'ai-chapters', note: String(body.note || '') })
        : null;
      ctx.json({
        ok: true,
        from: r.from,
        to: r.to,
        requested: r.requested,
        skipped: r.skipped,
        results: r.results,
        warnings: r.warnings,
        calls: r.calls,
        mocked: r.results.some((x) => x.mocked),
        stats: r.stats,
        saved,
      });
    } catch (err) { throw badRequest(err.message || 'AI 规划指定章节失败'); }
  });

  app.post('/api/novels/:id/outline/ai/save', async (ctx) => {
    try {
      const body = (await ctx.body()) || {};
      const sections = body.sections && typeof body.sections === 'object' ? body.sections : null;
      if (!sections) throw new Error('缺少 sections');
      ctx.json({ ok: true, saved: saveOutlineVersion(param(ctx, 'id'), sections, { source: String(body.source || 'ai-save'), note: String(body.note || '') }) });
    } catch (err) { throw badRequest(err.message || '保存大纲失败'); }
  });

  app.post('/api/novels/:id/chapters/:idx/ai-write', async (ctx) => {
    try {
      const body = (await ctx.body()) || {};
      const idx = Number.parseInt(param(ctx, 'idx'), 10);
      if (!Number.isInteger(idx) || idx < 1) throw new Error('章节序号必须是正整数');
      ctx.json(await writeLongChapter(param(ctx, 'id'), idx, {
        save: body.save !== false,
        instruction: String(body.instruction || ''),
      }));
    } catch (err) { throw badRequest(err.message || '长章节写作失败'); }
  });
}
