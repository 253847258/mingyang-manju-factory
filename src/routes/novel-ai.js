// 小说工坊 · 故事框架 AI 自动填写路由（plain text module）

import { badRequest } from '../http.js';
import { generateFrameworkProposal, commitCharacters } from '../novel-ai.js';
import {
  outlineAiStatus, loadSections, novelOf, fillSections, generateSection, planChapters, saveOutlineVersion,
} from '../novel-outline-ai.js';
import { writeLongChapter } from '../novel-writing.js';
import { buildNovelAssets } from '../novel-assets.js';
import { characterFreeMode, updateCharacterFreeMode, discoverPlotCharacters, autoArchivePlotCharacters } from '../novel-characters.js';
import { buildGenreCreativeBlueprint, listGenreCreativeBlueprints } from '../genre-frameworks.js';
import { listCreativeOptions, planGenreFromTitle, getNovelCreativeOptions, updateNovelCreativeOptions } from '../novel-creative-options.js';
import { ensureNovelSettingsSchema, getNovelAiSettings, updateNovelAiSettings, listNovelCharacterArchive } from '../novel-settings.js';
import { enqueue } from '../jobs.js';

function param(ctx, name) {
  return ctx?.params && typeof ctx.params === 'object' ? ctx.params[name] : '';
}

export function registerNovelAiRoutes(app) {
  ensureNovelSettingsSchema();
  app.post('/api/novels/ai/framework', async (ctx) => {
    try {
      const body = (await ctx.body()) || {};
      const proposal = await generateFrameworkProposal(body);
      ctx.json(proposal);
    } catch (err) {
      throw badRequest(err.message || 'AI 生成故事框架失败');
    }
  });

  app.get('/api/novels/ai/genre-blueprints', async (ctx) => {
    try {
      const genreId = String(ctx.query?.genre || ctx.query?.genreId || '').trim();
      if (genreId) {
        ctx.json({ ok: true, blueprint: buildGenreCreativeBlueprint(genreId) });
        return;
      }
      const blueprints = listGenreCreativeBlueprints();
      ctx.json({ ok: true, count: blueprints.length, blueprints });
    } catch (err) {
      throw badRequest(err.message || '读取题材创意引擎失败');
    }
  });

  app.get('/api/novels/ai/creative-options', async (ctx) => {
    try { ctx.json(listCreativeOptions()); }
    catch (err) { throw badRequest(err.message || '读取创作选项失败'); }
  });

  app.post('/api/novels/ai/plan-genre', async (ctx) => {
    try {
      const body = (await ctx.body()) || {};
      ctx.json(await planGenreFromTitle(body));
    } catch (err) { throw badRequest(err.message || '题材自动规划失败'); }
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

  app.get('/api/novels/:id/creative-options', async (ctx) => {
    try { ctx.json(getNovelCreativeOptions(param(ctx, 'id'))); }
    catch (err) { throw badRequest(err.message || '读取小说创作选项失败'); }
  });

  app.get('/api/novels/:id/ai-settings', async (ctx) => {
    try { ctx.json(getNovelAiSettings(param(ctx, 'id'))); }
    catch (err) { throw badRequest(err.message || '读取小说 AI 设置失败'); }
  });

  app.put('/api/novels/:id/ai-settings', async (ctx) => {
    try {
      const body = (await ctx.body()) || {};
      ctx.json({ ok: true, settings: updateNovelAiSettings(param(ctx, 'id'), body) });
    } catch (err) { throw badRequest(err.message || '保存小说 AI 设置失败'); }
  });

  app.get('/api/novels/:id/characters/archive', async (ctx) => {
    try { ctx.json(listNovelCharacterArchive(param(ctx, 'id'))); }
    catch (err) { throw badRequest(err.message || '读取小说角色归档失败'); }
  });

  app.put('/api/novels/:id/creative-options', async (ctx) => {
    try {
      const body = (await ctx.body()) || {};
      ctx.json({ ok: true, options: updateNovelCreativeOptions(param(ctx, 'id'), body) });
    } catch (err) { throw badRequest(err.message || '保存小说创作选项失败'); }
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

  app.get('/api/novels/:id/estimate', async (ctx) => {
    try {
      const novel = novelOf(param(ctx, 'id'));
      const action = String(ctx.query?.action || 'outline');
      const words = Math.max(1, Number(novel.target_words) || 1000000);
      const chapterWords = Math.max(1, Number(novel.chapter_words) || 3000);
      const chapters = Math.max(1, Math.ceil(words / chapterWords));
      const estimates = {
        outline: { chapters, llmCalls: Math.ceil(chapters / 20) + 1, risk: chapters > 200 ? '超长项目需要分批执行' : '' },
        characters: { characters: getNovelAiSettings(novel.id).maxCharacters, llmCalls: 1, risk: '' },
        'chapter-write': { chapters, llmCalls: chapters * 2, risk: chapters > 50 ? '章节较多，建议夜间分批执行' : '' },
      };
      ctx.json({ ok: true, action, estimate: estimates[action] || estimates.outline });
    } catch (err) { throw badRequest(err.message || '费用预估失败'); }
  });

  app.post('/api/novels/:id/outline/ai/rewrite-all', async (ctx) => {
    try {
      const body = (await ctx.body()) || {};
      const novelId = param(ctx, 'id');
      const novel = novelOf(novelId);
      const expected = Math.max(1, Math.ceil((Number(novel.target_words) || 1000000) / Math.max(1, Number(novel.chapter_words) || 3000)));
      const jobId = enqueue({
        type: 'novel_ai',
        title: `一键重写全部章节大纲（${expected} 章）`,
        total: expected,
        payload: { action: 'rewrite-all', novelId, instruction: String(body.instruction || '') },
        handler: async (job) => {
          let done = 0;
          let last = null;
          const allResults = [];
          const warnings = [];
          for (let from = 1; from <= expected; from += 20) {
            if (job.isCanceled()) throw new Error('任务已取消');
            const to = Math.min(expected, from + 19);
            const r = await planChapters(novel, loadSections(novelId), {
              from,
              to,
              onlyEmpty: false,
              maxCalls: 20,
              instruction: String(body.instruction || ''),
            });
            last = r;
            warnings.push(...(r.warnings || []));
            allResults.push(...(r.results || []));
            saveOutlineVersion(novelId, r.sections, { source: 'job:rewrite-all', note: `第${from}-${to}章` });
            done += r.requested;
            job.step(done, expected);
            job.log(`已完成第 ${from}-${to} 章`);
          }
          return { requested: done, results: allResults, warnings, saved: true, lastVersion: last?.stats || null };
        },
      });
      ctx.json({ ok: true, jobId, total: expected });
    } catch (err) { throw badRequest(err.message || '创建一键重写任务失败'); }
  });

  app.post('/api/novels/:id/outline/ai/robust-job', async (ctx) => {
    try {
      const body = (await ctx.body()) || {};
      const novelId = param(ctx, 'id');
      const novel = novelOf(novelId);
      const expected = Math.max(1, Math.ceil((Number(novel.target_words) || 1000000) / Math.max(1, Number(novel.chapter_words) || 3000)));
      const jobId = enqueue({
        type: 'novel_ai',
        title: `稳健生成完整大纲（${expected} 章）`,
        total: expected + 1,
        payload: { action: 'robust-outline', novelId },
        handler: async (job) => {
          let done = 0;
          let last = null;
          for (let from = 1; from <= expected; from += 20) {
            if (job.isCanceled()) throw new Error('任务已取消');
            const to = Math.min(expected, from + 19);
            const r = await planChapters(novel, loadSections(novelId), {
              from, to, onlyEmpty: false, maxCalls: 20,
              instruction: String(body.instruction || ''),
            });
            last = r;
            saveOutlineVersion(novelId, r.sections, { source: 'job:robust-outline', note: `第${from}-${to}章` });
            done += r.requested;
            job.step(done, expected + 1);
          }
          const fill = await fillSections(novel, loadSections(novelId), {
            save: false,
            onlyEmpty: true,
            instruction: String(body.instruction || ''),
          });
          saveOutlineVersion(novelId, fill.sections, { source: 'job:robust-outline:fill', note: '非章节分节补齐' });
          job.step(expected + 1, expected + 1);
          return { chapterPlan: last, fill, warnings: fill.warnings || [] };
        },
      });
      ctx.json({ ok: true, jobId, total: expected + 1 });
    } catch (err) { throw badRequest(err.message || '创建稳健大纲任务失败'); }
  });

  app.post('/api/novels/:id/characters/free-mode/auto-job', async (ctx) => {
    try {
      const body = (await ctx.body()) || {};
      const novelId = param(ctx, 'id');
      const mode = characterFreeMode(novelId);
      const jobId = enqueue({
        type: 'novel_ai',
        title: `按剧情补齐角色（最多 ${mode.maxCharacters} 个）`,
        total: mode.maxCharacters,
        payload: { action: 'characters-auto', novelId },
        handler: async (job) => {
          if (job.isCanceled()) throw new Error('任务已取消');
          job.step(1, mode.maxCharacters);
          const result = await autoArchivePlotCharacters(novelId, { apply: body.apply !== false, instruction: String(body.instruction || '') });
          job.step(result.created?.length || 0, Math.max(1, result.characters?.length || 1));
          return result;
        },
      });
      ctx.json({ ok: true, jobId, total: mode.maxCharacters });
    } catch (err) { throw badRequest(err.message || '创建角色自动补齐任务失败'); }
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
