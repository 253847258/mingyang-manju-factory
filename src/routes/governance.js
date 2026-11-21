// 自动治理回写接口。
import { badRequest } from '../http.js';
import { listGovernanceEvents, writebackProductionStage } from '../governance-writer.js';

export function registerGovernanceRoutes(app) {
  app.post('/api/studio/productions/:id/governance/writeback', async (ctx) => {
    try {
      const body = (await ctx.body()) || {};
      const stages = Array.isArray(body.stages) && body.stages.length ? body.stages : [body.stage].filter(Boolean);
      if (!stages.length) throw new Error('缺少 stage 或 stages');
      const results = [];
      for (const stage of stages) {
        results.push(await writebackProductionStage({
          productionId: ctx.params.id,
          stage: String(stage),
          jobId: body.jobId || body.job_id || null,
          actor: body.operator || body.actor || 'system',
        }));
      }
      ctx.json({ ok: true, count: results.length, results });
    } catch (error) { throw badRequest(error.message || '治理回写失败'); }
  });

  app.get('/api/studio/productions/:id/governance/events', async (ctx) => {
    try {
      const events = listGovernanceEvents({ productionId: ctx.params.id, limit: ctx.query?.limit });
      ctx.json({ ok: true, count: events.length, events });
    } catch (error) { throw badRequest(error.message || '读取治理事件失败'); }
  });
}

export default registerGovernanceRoutes;
