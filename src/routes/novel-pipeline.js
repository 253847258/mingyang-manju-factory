// 小说工坊四步生产线 HTTP 接口（明文路由）。
import { badRequest } from '../http.js';
import { enqueue } from '../jobs.js';
import { ensureJobCheckpointSchema, markJobStepRunning, markJobStepDone, markJobStepError, listJobSteps } from '../job-checkpoints.js';
import {
  loadSections, novelOf, orchestrateOutline, planAllChaptersBatched, saveOutlineVersion,
} from '../novel-outline-ai.js';
import {
  pipelineSnapshot, generateChapterCards, saveChapterCard, buildAssetPlan, getAssetPlan,
  updatePipelineAsset, confirmAssetPlan, syncAssetPlanToCanvas, continueChapter, resetPipeline,
} from '../novel-pipeline.js';

function param(ctx, name) {
  return ctx?.params && typeof ctx.params === 'object' ? ctx.params[name] : '';
}

function intOf(value, fallback = 0) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function registerNovelPipelineRoutes(app) {
  ensureJobCheckpointSchema();

  app.get('/api/pipeline/jobs/:jobId/steps', async (ctx) => {
    try { ctx.json(listJobSteps(param(ctx, 'jobId'))); }
    catch (error) { throw badRequest(error.message || '读取任务断点失败'); }
  });

  app.get('/api/novels/:id/pipeline', async (ctx) => {
    try { ctx.json(pipelineSnapshot(param(ctx, 'id'))); }
    catch (error) { throw badRequest(error.message || '读取四步生产线状态失败'); }
  });

  app.post('/api/novels/:id/pipeline/outline', async (ctx) => {
    try {
      const body = (await ctx.body()) || {};
      const novelId = param(ctx, 'id');
      const novel = novelOf(novelId);
      const sections = loadSections(novelId);
      const chapters = Array.isArray(sections.chapters) ? sections.chapters.length : 0;
      const expected = Math.max(chapters, Math.ceil((Number(novel.target_words) || 1000000) / Math.max(1, Number(novel.chapter_words) || 3000)));
      if (chapters && body.refresh !== true && body.full !== true) {
        ctx.json({ ok: true, alreadyReady: true, chapters, expected, skipped: true });
        return;
      }
      const batchSize = Math.min(50, intOf(body.batchSize, 20));
      const concurrency = Math.min(8, intOf(body.concurrency, 3));
      const sectionsConcurrency = Math.min(8, intOf(body.sectionsConcurrency, 4));
      const instruction = String(body.instruction || '按整条故事线规划每章章首、章末与上下文衔接，确保前后逻辑一致；不写正文。');
      const jobId = enqueue({
        type: 'novel_ai',
        title: `四步生产线 · 章节大纲（${expected} 章）`,
        total: expected,
        payload: { action: 'pipeline-outline', novelId, batchSize, concurrency, sectionsConcurrency },
        handler: async (job) => {
          try {
            markJobStepRunning(job.id, 'outline:job', { novelId, expected, batchSize });
            let lastSaved = null;
            const result = await planAllChaptersBatched(novel, loadSections(novelId), {
              instruction,
              concurrency,
              sectionsConcurrency,
              batchSize,
              onlyEmptySections: body.onlyEmptySections !== false,
              isCanceled: () => job.isCanceled(),
              onProgress: (report) => {
                if (!report?.steps) return;
                const done = report.steps.reduce((sum, step) => sum + (Number(step.done) || 0) + (Number(step.planned) || 0), 0);
                if (done) job.step(Math.min(done, expected), expected);
              },
              onBatch: ({ from, to, complete, sections: batchSections }) => {
                lastSaved = saveOutlineVersion(novelId, batchSections, {
                  source: 'pipeline:outline-batch',
                  note: `四步生产线章纲：第${from}-${to}章`,
                });
                markJobStepDone(job.id, `outline:${from}-${to}`, {
                  input: { novelId, from, to },
                  result: { complete, saved: lastSaved },
                });
                job.step(Math.min(complete, expected), expected);
                job.log(`第 ${from}-${to} 章章纲已落盘（${complete}/${expected}）`);
              },
            });
            const output = {
              saved: lastSaved,
              expected,
              complete: result.complete,
              planned: result.stats?.complete || 0,
              remaining: result.remaining,
              batches: result.batches,
              warnings: result.warnings,
            };
            markJobStepDone(job.id, 'outline:job', { input: { novelId, expected }, result: output });
            return output;
          } catch (error) {
            markJobStepError(job.id, 'outline:job', error, { input: { novelId, expected } });
            throw error;
          }
        },
      });
      ctx.json({ ok: true, jobId, expected, batchSize, concurrency, sectionsConcurrency });
    } catch (error) { throw badRequest(error.message || '创建章节大纲任务失败'); }
  });

  app.post('/api/novels/:id/pipeline/chapter-cards', async (ctx) => {
    try {
      const body = (await ctx.body()) || {};
      const novelId = param(ctx, 'id');
      const snapshot = pipelineSnapshot(novelId);
      if (!snapshot.summary.outlineComplete) throw new Error('还没有完整的章节大纲，不能生成内容卡');
      const from = intOf(body.from, 1);
      const to = Math.min(intOf(body.to, from), snapshot.summary.expected || from);
      if (to - from + 1 > 50) throw new Error('单次最多生成 50 章内容卡');
      const onlyMissing = body.onlyMissing !== false;
      const instruction = String(body.instruction || '');
      const jobId = enqueue({
        type: 'novel_ai',
        title: `四步生产线 · 章节内容卡（第${from}-${to}章）`,
        total: to - from + 1,
        payload: { action: 'pipeline-chapter-cards', novelId, from, to },
        handler: async (job) => {
          try {
            markJobStepRunning(job.id, 'cards:job', { novelId, from, to });
            const output = await generateChapterCards(novelId, {
              from, to, onlyMissing, instruction,
              isCanceled: () => job.isCanceled(),
              onProgress: ({ done, total, idx }) => {
                markJobStepDone(job.id, `card:${idx}`, {
                  input: { novelId, idx },
                  result: { done, total },
                });
                job.step(done, total);
              },
            });
            markJobStepDone(job.id, 'cards:job', { input: { novelId, from, to }, result: { generated: output.generated, skipped: output.skipped } });
            return output;
          } catch (error) {
            markJobStepError(job.id, 'cards:job', error, { input: { novelId, from, to } });
            throw error;
          }
        },
      });
      ctx.json({ ok: true, jobId, from, to, total: to - from + 1 });
    } catch (error) { throw badRequest(error.message || '创建章节内容卡任务失败'); }
  });

  app.put('/api/novels/:id/pipeline/chapter-cards/:idx', async (ctx) => {
    try {
      const body = (await ctx.body()) || {};
      ctx.json(saveChapterCard(param(ctx, 'id'), intOf(param(ctx, 'idx'), 0), body));
    } catch (error) { throw badRequest(error.message || '保存章节内容卡失败'); }
  });

  app.get('/api/novels/:id/pipeline/assets', async (ctx) => {
    try { ctx.json(getAssetPlan(param(ctx, 'id'))); }
    catch (error) { throw badRequest(error.message || '读取资产计划失败'); }
  });

  app.post('/api/novels/:id/pipeline/assets/build', async (ctx) => {
    try {
      const body = (await ctx.body()) || {};
      ctx.json(buildAssetPlan(param(ctx, 'id'), {
        chapterFrom: intOf(body.chapterFrom ?? body.chapter_from, 0) || null,
        chapterTo: intOf(body.chapterTo ?? body.chapter_to, 0) || null,
      }));
    } catch (error) { throw badRequest(error.message || '生成资产计划失败'); }
  });

  app.put('/api/novels/:id/pipeline/assets/:assetId', async (ctx) => {
    try {
      const body = (await ctx.body()) || {};
      ctx.json(updatePipelineAsset(param(ctx, 'id'), decodeURIComponent(param(ctx, 'assetId')), body));
    } catch (error) { throw badRequest(error.message || '更新资产计划失败'); }
  });

  app.post('/api/novels/:id/pipeline/assets/sync-canvas', async (ctx) => {
    try {
      const body = (await ctx.body()) || {};
      ctx.json(await syncAssetPlanToCanvas(param(ctx, 'id'), {
        canvasId: String(body.canvasId || body.canvas_id || 'CV-MAIN'),
      }));
    } catch (error) { throw badRequest(error.message || '同步资产到画布失败'); }
  });

  app.post('/api/novels/:id/pipeline/assets/confirm', async (ctx) => {
    try {
      const body = (await ctx.body()) || {};
      ctx.json(confirmAssetPlan(param(ctx, 'id'), {
        forced: body.forced === true || body.force === true,
        note: String(body.note || ''),
        operator: String(body.operator || '本机操作人'),
      }));
    } catch (error) { throw badRequest(error.message || '确认资产计划失败'); }
  });

  app.post('/api/novels/:id/pipeline/chapters/:idx/continue', async (ctx) => {
    try {
      const body = (await ctx.body()) || {};
      ctx.json(await continueChapter(param(ctx, 'id'), intOf(param(ctx, 'idx'), 0), {
        instruction: String(body.instruction || ''),
        mode: String(body.mode || 'continue'),
        force: body.force === true || body.forced === true,
        operator: String(body.operator || '本机操作人'),
      }));
    } catch (error) { throw badRequest(error.message || '续写正文失败'); }
  });

  app.post('/api/novels/:id/pipeline/reset', async (ctx) => {
    try {
      const body = (await ctx.body()) || {};
      ctx.json(resetPipeline(param(ctx, 'id'), { steps: Array.isArray(body.steps) ? body.steps : [] }));
    } catch (error) { throw badRequest(error.message || '重置生产线失败'); }
  });
}

export default registerNovelPipelineRoutes;
