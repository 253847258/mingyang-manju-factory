// 唯一执行门面 HTTP 路由。
import { badRequest, notFound } from '../http.js';
import {
  approveExecutionPlan,
  createExecutionPlan,
  executeApprovedPlan,
  executionPlan,
  executionPlans,
  rejectExecutionPlan,
} from '../execute-gate.js';

const route = (label, handler) => async (ctx) => {
  try { await handler(ctx); }
  catch (error) { throw badRequest(`${label}：${error.message || error}`); }
};

export function registerExecuteGateRoutes(app) {
  app.get('/api/execute/plans', route('读取执行计划失败', async (ctx) => {
    const plans = executionPlans({ status: ctx.query?.status || null, limit: Number(ctx.query?.limit) || 50 });
    ctx.json({ ok: true, count: plans.length, plans });
  }));

  app.get('/api/execute/plans/:id', route('读取执行计划失败', async (ctx) => {
    const plan = executionPlan(ctx.params.id);
    if (!plan) throw notFound(`执行计划不存在：${ctx.params.id}`);
    ctx.json({ ok: true, plan });
  }));

  app.post('/api/execute/plans', route('创建执行计划失败', async (ctx) => {
    ctx.json(createExecutionPlan((await ctx.body()) || {}));
  }));

  app.post('/api/execute/plans/:id/approve', route('批准执行计划失败', async (ctx) => {
    const body = (await ctx.body()) || {};
    ctx.json(approveExecutionPlan(ctx.params.id, { operator: body.operator || body.by, confirm: body.confirm !== false }));
  }));

  app.post('/api/execute/plans/:id/reject', route('拒绝执行计划失败', async (ctx) => {
    const body = (await ctx.body()) || {};
    ctx.json(rejectExecutionPlan(ctx.params.id, { operator: body.operator || body.by, reason: body.reason }));
  }));

  app.post('/api/execute/run', route('执行计划失败', async (ctx) => {
    const body = (await ctx.body()) || {};
    ctx.json(executeApprovedPlan({ planId: body.planId || body.plan_id, confirmCode: body.confirmCode || body.confirm_code, ctx: body.ctx || {} }));
  }));
}

export default registerExecuteGateRoutes;
