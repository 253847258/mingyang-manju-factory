// 生产闸门 · HTTP 路由（plain text）
// 闸门一：剧本审核硬门禁（未 approved/locked 默认禁止开拍）
// 契约：镜头数/时长/台词校验
// 强制继续：写入审计（可追责）

import { badRequest, notFound } from '../http.js';
import { all, get, run } from '../db.js';
import { nowISO } from '../util.js';
import { validateShots } from '../shot-contract.js';

function episodeOf(scriptId, code) {
  const ep = get('SELECT * FROM script_episodes WHERE script_id=? AND code=?', scriptId, code);
  if (!ep) throw notFound(`找不到剧集 ${code}`);
  return ep;
}

function newAuditId() {
  return `AU-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export function registerGateRoutes(app) {
  // 剧本闸门状态
  app.get('/api/gates/episode', async (ctx) => {
    const scriptId = String(ctx.query.script_id || '');
    const code = String(ctx.query.code || '');
    if (!scriptId || !code) return ctx.json({ ok: false, error: '缺少 script_id 或 code' }, 400);
    try {
      const ep = episodeOf(scriptId, code);
      const status = String(ep.review_status || 'draft');
      const approved = status === 'approved' || status === 'locked';
      ctx.json({
        ok: true,
        gate: 'script-lock',
        episode: { id: ep.id, scriptId, code, title: ep.title, status, reviewer: ep.reviewer || '', reviewedAt: ep.reviewed_at || '', note: ep.review_note || '' },
        approved,
        blocked: !approved,
        message: approved ? '剧本已通过/锁定，可以开拍' : '剧本未通过审核，默认禁止开拍；如确需继续请走强制继续并写审计',
      });
    } catch (e) { ctx.json({ ok: false, error: e.message }, e.status || 404); }
  });

  // 镜头契约
  app.get('/api/gates/contract', async (ctx) => {
    const scriptId = String(ctx.query.script_id || '');
    const code = String(ctx.query.code || '');
    if (!scriptId || !code) return ctx.json({ ok: false, error: '缺少 script_id 或 code' }, 400);
    try {
      const ep = episodeOf(scriptId, code);
      const shots = all('SELECT * FROM shots WHERE episode_id=? AND script_id=? ORDER BY idx', ep.id, scriptId);
      const result = validateShots(shots);
      // 注意：不要直接展开 result —— result.ok=false 会覆盖外层 ok，前端会误判为接口失败
      ctx.json({
        ok: true,
        contractOk: result.ok,
        contract: result.contract,
        issues: result.issues,
        summary: result.summary,
        episode: { id: ep.id, code, title: ep.title },
      });
    } catch (e) { ctx.json({ ok: false, error: e.message }, e.status || 404); }
  });

  // 强制继续（写审计）
  app.post('/api/gates/override', async (ctx) => {
    try {
      const body = (await ctx.body()) || {};
      const scriptId = String(body.scriptId || body.script_id || '');
      const code = String(body.code || '');
      if (!scriptId || !code) throw badRequest('缺少 scriptId 或 code');
      const ep = episodeOf(scriptId, code);
      const operator = String(body.operator || '未署名').slice(0, 40);
      const gate = String(body.gate || 'script-lock').slice(0, 40);
      const reason = String(body.reason || '未填写理由').slice(0, 500);
      run('INSERT INTO audit_log(id,actor,action,entity,entity_id,detail,at) VALUES(?,?,?,?,?,?,?)',
        newAuditId(), operator, 'gate:override', 'episode', ep.id,
        JSON.stringify({ scriptId, code, gate, reason, reviewStatus: ep.review_status || 'draft' }), nowISO());
      ctx.json({ ok: true, audited: true, episodeId: ep.id, gate, reason });
    } catch (e) { ctx.json({ ok: false, error: e.message }, e.status || 400); }
  });
}
