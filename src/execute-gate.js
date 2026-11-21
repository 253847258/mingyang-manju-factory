// 唯一执行门面：所有付费图执行必须经过“计划 → 人工批准 → 确认码 → 一次性消费”。
// 本模块是明文包装层，复用 mcp-tools 的计划与审计内核，不改混淆实现。

import { approvePlan, createPlan, getPlan, listPlans, planAudits, planView, runPlan } from './mcp-tools.js';

const text = (value, max = 300) => String(value ?? '').trim().slice(0, max);

export const EXECUTE_GATE_DIRECT_PATHS = Object.freeze(['/api/canvas/run', '/api/canvas/run-node']);

export function isDirectCanvasExecution(url) {
  const pathname = String(url || '').split('?')[0];
  return EXECUTE_GATE_DIRECT_PATHS.includes(pathname);
}

export function isLegacyPlanExecution(url) {
  const pathname = String(url || '').split('?')[0];
  return /^\/api\/canvas\/plans\/[^/]+\/run$/.test(pathname);
}

export function createExecutionPlan(options = {}) {
  const plan = createPlan({
    canvasId: text(options.canvasId || options.canvas_id || 'CV-MAIN', 120) || 'CV-MAIN',
    nodeIds: Array.isArray(options.nodeIds || options.node_ids) ? (options.nodeIds || options.node_ids) : null,
    overwrite: options.overwrite === true,
    title: text(options.title, 160) || null,
    createdBy: text(options.operator || options.createdBy || 'gate', 80) || 'gate',
    tool: 'execute_gate',
  });
  const view = planView ? planView(plan) : plan;
  const id = plan?.id || plan?.plan_id || view?.id || view?.plan_id || view?.planId || null;
  return { ok: true, plan: { ...(view || {}), id, plan_id: id, planId: id } };
}

export function approveExecutionPlan(planId, { operator = 'human', confirm = true } = {}) {
  if (confirm !== true) throw new Error('批准执行计划必须明确 confirm:true');
  const result = approvePlan(text(planId, 120), { by: text(operator, 80) || 'human', confirm: true });
  return { ok: true, approval: result, plan: getPlan(text(planId, 120)) };
}

export function rejectExecutionPlan(planId, { operator = 'human', reason = '' } = {}) {
  const result = approvePlan(text(planId, 120), {
    by: text(operator, 80) || 'human',
    confirm: true,
    reject: true,
    reason: text(reason, 300),
  });
  return { ok: true, rejection: result, plan: getPlan(text(planId, 120)) };
}

export function executeApprovedPlan({ planId, confirmCode, ctx = {} }) {
  const id = text(planId, 120);
  const code = text(confirmCode, 20);
  if (!id) throw new Error('缺少 planId');
  if (!code) throw new Error('缺少人工确认码');
  const result = runPlan({ plan_id: id, confirm_code: code, ctx, requireApproval: true });
  return { ok: true, ...result, plan: getPlan(id) };
}

export function executionPlan(planId) {
  const row = getPlan(text(planId, 120));
  if (!row) return null;
  const view = planView ? planView(row) : row;
  return { ...view, audits: planAudits(row.id) };
}

export function executionPlans(options = {}) {
  const rows = listPlans(options) || [];
  return rows.map((row) => (planView ? planView(row) : row));
}
