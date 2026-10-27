// 生产闸门中间件（plain text）
// 在请求进入混淆层路由之前拦截：未通过审核的剧集，直接拒绝开拍。
// 强制继续必须带 force:true，并写审计。

import { PassThrough } from 'node:stream';
import { all, get, run } from './db.js';
import { nowISO } from './util.js';
import { validateShots } from './shot-contract.js';

export const GATED_PATHS = Object.freeze([
  '/api/render/keyframes',
  '/api/render/videos',
  '/api/render/assemble',
  '/api/render/pipeline',
]);

export function isGatedPath(url) {
  const p = String(url || '').split('?')[0];
  return GATED_PATHS.includes(p);
}

export function checkScriptGate({ scriptId, code, force = false, operator = '未署名', reason = '' } = {}) {
  if (!scriptId || !code) return { ok: true, skipped: true, reason: 'missing-script-or-code' };
  const ep = get('SELECT * FROM script_episodes WHERE script_id=? AND code=?', scriptId, code);
  if (!ep) return { ok: true, skipped: true, reason: 'episode-not-found' };
  const status = String(ep.review_status || 'draft');
  const approved = status === 'approved' || status === 'locked';
  if (approved) return { ok: true, approved: true, status };
  if (!force) {
    return {
      ok: false,
      blocked: true,
      status,
      message: `剧本未通过审核（当前 ${status}），禁止开拍。请先到「剧本工厂 → 审核本集」走完 review → approved，或在请求里带 force:true 强制继续（会写审计）`,
    };
  }
  try {
    run('INSERT INTO audit_log(id,actor,action,entity,entity_id,detail,at) VALUES(?,?,?,?,?,?,?)',
      `AU-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
      String(operator || '未署名').slice(0, 40), 'gate:force', 'episode', ep.id,
      JSON.stringify({ scriptId, code, status, reason: String(reason || '').slice(0, 500) }), nowISO());
  } catch { /* 审计失败不阻断 */ }
  return { ok: true, forced: true, status };
}

// 镜头契约闸门：warn（默认放行）/ confirm（需 ackContract）/ strict（硬拦）
export function checkContractGate({ scriptId, code, mode = 'warn', ack = false } = {}) {
  if (!scriptId || !code) return { ok: true, skipped: true, reason: 'missing-script-or-code' };
  const ep = get('SELECT * FROM script_episodes WHERE script_id=? AND code=?', scriptId, code);
  if (!ep) return { ok: true, skipped: true, reason: 'episode-not-found' };
  const shots = requireShots(ep.id, scriptId);
  const result = validateShots(shots);
  if (result.ok) return { ok: true, contractOk: true, mode };
  const issues = result.issues;
  if (mode === 'strict') return { ok: false, blocked: true, code: 'shot-contract', mode, issues, summary: result.summary };
  if (mode === 'confirm' && !ack) return { ok: false, blocked: true, code: 'shot-contract', mode, issues, summary: result.summary, message: '镜头契约不达标，需带 ackContract:true 明确确认后才放行' };
  return { ok: true, contractOk: false, mode, issues, summary: result.summary, acknowledged: !!ack };
}

function requireShots(episodeId, scriptId) {
  try { return all('SELECT * FROM shots WHERE episode_id=? AND script_id=? ORDER BY idx', episodeId, scriptId); } catch { return []; }
}

// 把已读出的 body 重新包装成可读流，交给原 handler
export function replayRequest(req, bodyBuffer) {
  const stream = new PassThrough();
  stream.method = req.method;
  stream.url = req.url;
  stream.headers = req.headers;
  stream.httpVersion = req.httpVersion;
  stream.socket = req.socket;
  stream.connection = req.connection;
  stream.end(bodyBuffer && bodyBuffer.length ? bodyBuffer : Buffer.from(''));
  return stream;
}
