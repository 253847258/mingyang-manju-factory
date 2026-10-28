// 前三镜锚定（V2 闸门二）
// 作用：一集开拍前只出前 3 镜，人确认风格后锁定 anchor；
// 后续批量出帧/生影要求已有 approved anchor（可配置为 warn/confirm/strict）。

import { get, run } from './db.js';
import { nowISO } from './util.js';

let ready = false;
export function ensureAnchorSchema() {
  if (ready) return;
  run(`CREATE TABLE IF NOT EXISTS episode_anchors (
    id TEXT PRIMARY KEY,
    script_id TEXT NOT NULL,
    episode_id TEXT,
    code TEXT NOT NULL,
    shot_ids TEXT,
    model TEXT,
    seed TEXT,
    style TEXT,
    lut TEXT,
    prompt_template TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    operator TEXT,
    created_at TEXT,
    approved_at TEXT,
    approved_by TEXT
  )`);
  run('CREATE UNIQUE INDEX IF NOT EXISTS ux_anchor_code ON episode_anchors(script_id, code)');
  ready = true;
}

export function getAnchor(scriptId, code) {
  ensureAnchorSchema();
  return get('SELECT * FROM episode_anchors WHERE script_id=? AND code=?', scriptId, code) || null;
}

export function upsertAnchor({ scriptId, code, episodeId = '', shotIds = [], model = '', seed = '', style = '', lut = '', promptTemplate = '', operator = '未署名' }) {
  ensureAnchorSchema();
  const existing = getAnchor(scriptId, code);
  const now = nowISO();
  const payload = JSON.stringify(Array.isArray(shotIds) ? shotIds.slice(0, 3) : []);
  if (existing) {
    run('UPDATE episode_anchors SET shot_ids=?, model=?, seed=?, style=?, lut=?, prompt_template=?, operator=?, status=\'draft\', approved_at=NULL, approved_by=NULL WHERE id=?',
      payload, String(model || ''), String(seed || ''), String(style || ''), String(lut || ''), String(promptTemplate || ''), String(operator || '未署名').slice(0, 40), existing.id);
  } else {
    run('INSERT INTO episode_anchors(id,script_id,episode_id,code,shot_ids,model,seed,style,lut,prompt_template,status,operator,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,\'draft\',?,?)',
      `AN-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`, scriptId, String(episodeId || ''), code, payload,
      String(model || ''), String(seed || ''), String(style || ''), String(lut || ''), String(promptTemplate || ''),
      String(operator || '未署名').slice(0, 40), now);
  }
  return getAnchor(scriptId, code);
}

export function approveAnchor(scriptId, code, operator = '未署名') {
  ensureAnchorSchema();
  const a = getAnchor(scriptId, code);
  if (!a) throw new Error('还没有锚定记录：请先生成前 3 镜');
  run("UPDATE episode_anchors SET status='approved', approved_at=?, approved_by=? WHERE id=?", nowISO(), String(operator || '未署名').slice(0, 40), a.id);
  return getAnchor(scriptId, code);
}

export function anchorStatus(scriptId, code) {
  const a = getAnchor(scriptId, code);
  return {
    exists: !!a,
    approved: String(a?.status || '') === 'approved',
    anchor: a ? { ...a, shot_ids: (() => { try { return JSON.parse(a.shot_ids || '[]'); } catch { return []; } })() } : null,
  };
}
