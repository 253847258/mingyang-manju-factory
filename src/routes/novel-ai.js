// 小说工坊 · 故事框架 AI 自动填写路由（plain text module）

import { badRequest } from '../http.js';
import { generateFrameworkProposal, commitCharacters } from '../novel-ai.js';
import {
  outlineAiStatus, loadSections, novelOf, fillSections, generateSection, planChapters, saveOutlineVersion,
  enrichChapterHandoff,
} from '../novel-outline-ai.js';
import { writeLongChapter } from '../novel-writing.js';
import { buildNovelAssets } from '../novel-assets.js';
import { characterFreeMode, updateCharacterFreeMode, discoverPlotCharacters, autoArchivePlotCharacters } from '../novel-characters.js';
import { buildGenreCreativeBlueprint, listGenreCreativeBlueprints, buildGenreSkillPrompt } from '../genre-frameworks.js';
import { brainstormGenre } from '../novel-brainstorm.js';
import { GENRE_GENERATOR_OPTIONS, generateCustomGenre } from '../novel-genre-generator.js';
import { listCreativeOptions, planGenreFromTitle, getNovelCreativeOptions, updateNovelCreativeOptions } from '../novel-creative-options.js';
import { ensureNovelSettingsSchema, getNovelAiSettings, updateNovelAiSettings, listNovelCharacterArchive } from '../novel-settings.js';
import { enqueue } from '../jobs.js';
import { all } from '../db.js';

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

  app.get('/api/novels/ai/genre-skill-prompt', async (ctx) => {
    try {
      const genreId = String(ctx.query?.genre || ctx.query?.genreId || '').trim();
      if (!genreId) throw new Error('缺少 genre 参数');
      ctx.json(buildGenreSkillPrompt(genreId));
    } catch (err) {
      throw badRequest(err.message || '生成题材写作技能提示词失败');
    }
  });

  app.post('/api/novels/ai/brainstorm-genre', async (ctx) => {
    try {
      const body = (await ctx.body()) || {};
      ctx.json(await brainstormGenre(body));
    } catch (err) {
      throw badRequest(err.message || 'AI 头脑风暴创意题材规划失败');
    }
  });

  app.get('/api/novels/ai/genre-generator-options', async (ctx) => {
    try { ctx.json({ ok: true, options: GENRE_GENERATOR_OPTIONS }); }
    catch (err) { throw badRequest(err.message || '读取题材生成器选项失败'); }
  });

  app.post('/api/novels/ai/generate-genre', async (ctx) => {
    try {
      const body = (await ctx.body()) || {};
      ctx.json(generateCustomGenre(body));
    } catch (err) {
      throw badRequest(err.message || '题材生成器生成失败');
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

  // 单次整份大纲只产出短摘要；这里为零成本的确定性补全「章首/章末」，让头尾能衔接。
  app.post('/api/novels/:id/outline/ai/enrich-handoff', async (ctx) => {
    try {
      const body = (await ctx.body()) || {};
      const novelId = param(ctx, 'id');
      const novel = novelOf(novelId);
      const sections = loadSections(novelId);
      const r = enrichChapterHandoff(novel, sections);
      const saved = (body.save !== false && r.filled > 0)
        ? saveOutlineVersion(novelId, { ...sections, chapters: r.chapters }, { source: 'ai-enrich-handoff', note: '补全章首/章末' })
        : null;
      ctx.json({ ok: true, filled: r.filled, total: r.total, saved });
    } catch (err) { throw badRequest(err.message || '补全章首/章末失败'); }
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

  app.post('/api/novels/:id/chapters/ai-write-job', async (ctx) => {
    try {
      const body = (await ctx.body()) || {};
      const novelId = param(ctx, 'id');
      novelOf(novelId);
      const rows = all('SELECT idx, status FROM novel_chapters WHERE novel_id = ? ORDER BY idx', novelId);
      const mode = String(body.mode || 'next');
      let targets = [];
      if (mode === 'range') {
        const from = Math.max(1, Number(body.from) || 1);
        const to = Math.max(from, Number(body.to) || from);
        targets = rows.filter((x) => x.idx >= from && x.idx <= to).map((x) => x.idx);
      } else if (mode === 'all') {
        targets = rows.filter((x) => x.status !== 'done' || body.force).map((x) => x.idx);
      } else {
        targets = rows.filter((x) => x.status !== 'done').slice(0, Math.max(1, Number(body.count) || 1)).map((x) => x.idx);
      }
      if (!targets.length) throw new Error('没有可写作的章节');
      const jobId = enqueue({
        type: 'novel_ai',
        title: `长章正文写作（${targets.length} 章）`,
        total: targets.length,
        payload: { action: 'chapter-write', novelId, targets },
        handler: async (job) => {
          const results = [];
          let done = 0;
          for (const idx of targets) {
            if (job.isCanceled()) throw new Error('任务已取消');
            const r = await writeLongChapter(novelId, idx, { save: true, instruction: String(body.instruction || '') });
            results.push({ idx, words: r.words, mocked: r.mocked, warnings: r.warnings });
            done += 1;
            job.step(done, targets.length);
            job.log(`第 ${idx} 章完成：${r.words} 字`);
          }
          return { ok: results.length, total: targets.length, results };
        },
      });
      ctx.json({ ok: true, jobId, total: targets.length, idxs: targets });
    } catch (err) { throw badRequest(err.message || '创建长章写作任务失败'); }
  });
}
