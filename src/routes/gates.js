// 生产闸门 · HTTP 路由（plain text）
// 闸门一：剧本审核硬门禁（未 approved/locked 默认禁止开拍）
// 契约：镜头数/时长/台词校验
// 强制继续：写入审计（可追责）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { badRequest, notFound } from '../http.js';
import { all, get, run } from '../db.js';
import { nowISO } from '../util.js';
import { validateShots } from '../shot-contract.js';
import { normalizeShotCount } from '../shot-normalize.js';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const DB_FILE = process.env.FACTORY_DB || path.join(ROOT, 'data', 'factory.db');

function backupDb() {
  if (process.env.FACTORY_DB) return ''; // 测试/隔离实例不占用正式 _archive
  try {
    const stamp = nowISO().replace(/[-:T]/g, '').slice(0, 14);
    const dir = path.join(ROOT, '_archive', `backup-${stamp}`);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) if (fs.existsSync(f)) fs.copyFileSync(f, path.join(dir, path.basename(f)));
    return dir;
  } catch { return ''; }
}

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

  // 镜头规范预览（只读，不写库）
  app.post('/api/scripts/:id/shots/normalize', async (ctx) => {
    try {
      const scriptId = String(ctx.params.id || '');
      const body = (await ctx.body()) || {};
      const code = String(body.episode || body.code || '');
      if (!code) throw badRequest('缺少 episode');
      const ep = episodeOf(scriptId, code);
      const shots = all('SELECT * FROM shots WHERE episode_id=? AND script_id=? ORDER BY idx', ep.id, scriptId);
      const r = normalizeShotCount(shots, {
        min: Number(body.minShots) || 10,
        max: Number(body.maxShots) || 12,
        clampDuration: body.clampDuration === true,
        minSec: Number(body.minSec) || 5,
        maxSec: Number(body.maxSec) || 6,
      });
      if (body.apply === true) {
        if (body.confirm !== true) throw badRequest('应用规范化需要 confirm:true（会合并/拆分镜头并写库）');
        const backupDir = backupDb();
        const byId = new Map(shots.map((x) => [x.id, x]));
        const keepIds = new Set(r.shots.map((x) => x.id));
        let deleted = 0;
        let updated = 0;
        let inserted = 0;
        for (const x of shots) {
          if (!keepIds.has(x.id)) { run('DELETE FROM shots WHERE id=?', x.id); deleted += 1; }
        }
        for (const x of r.shots) {
          const base = byId.get(x.id);
          if (base) {
            run('UPDATE shots SET idx=?, duration=?, dialogue=?, action=?, prompt_pos=?, prompt_neg=? WHERE id=?',
              x.idx, x.duration, x.dialogue || '', x.action || '', x.prompt_pos || '', x.prompt_neg || '', x.id);
            updated += 1;
          } else if (x._splitFrom && byId.get(x._splitFrom)) {
            const src = byId.get(x._splitFrom);
            const newId = `${src.id}-B${Date.now().toString(36).slice(-4)}`;
            run(`INSERT INTO shots(id,script_id,episode_id,idx,scene_no,location_id,time_of_day,shot_size,camera,move,transition,duration,action,dialogue,sfx,music,mood,prompt_pos,prompt_neg,refs,cost_level,status,created_at)
                 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
              newId, src.script_id, src.episode_id, x.idx, src.scene_no, src.location_id, src.time_of_day, src.shot_size, src.camera, src.move, src.transition,
              x.duration, x.action || '', '', src.sfx, src.music, src.mood, x.prompt_pos || '', x.prompt_neg || '', src.refs, src.cost_level, src.status, nowISO());
            inserted += 1;
          }
        }
        if (body.clampDuration === true && Number(r.totalDuration) > 0) {
          run('UPDATE script_episodes SET duration=? WHERE id=?', r.totalDuration, ep.id);
        }
        try {
          run('INSERT INTO audit_log(id,actor,action,entity,entity_id,detail,at) VALUES(?,?,?,?,?,?,?)',
            `AU-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
            String(body.operator || '未署名').slice(0, 40), 'shots:normalize', 'episode', ep.id,
            JSON.stringify({ scriptId, code, before: r.before, after: r.after, deleted, updated, inserted, clamped: r.clamped, totalDuration: r.totalDuration }), nowISO());
        } catch { /* 审计失败不阻断 */ }
        return ctx.json({ ok: true, applied: true, episode: { id: ep.id, code, title: ep.title }, before: r.before, after: r.after, inRange: r.inRange, clamped: r.clamped, totalDuration: r.totalDuration, deleted, updated, inserted, totalChanges: r.changes.length, backupDir });
      }
      ctx.json({
        ok: true,
        applied: false,
        episode: { id: ep.id, code, title: ep.title },
        before: r.before,
        after: r.after,
        inRange: r.inRange,
        clamped: r.clamped,
        totalDuration: r.totalDuration,
        totalChanges: r.changes.length,
        changes: r.changes,
      });
    } catch (e) { ctx.json({ ok: false, error: e.message }, e.status || 400); }
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
