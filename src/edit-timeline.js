// 后期精修 · 成片时间线（plain text module）
//
// 设计要点：
// 1) 不修改混淆层（timeline.js / finish.js / modules/render.js），新链路独立并存。
// 2) 一条时间线 = 主轨 + 画中画轨 + 字幕轨 + 音频轨；片段带 in/out、转场、音量、字幕覆盖。
// 3) 乐观锁：每次保存必须带 doc_version，不匹配返回 409（EditConflictError）。
// 4) 审片状态机：draft → review → approved → locked；locked 后只读，修改需 fork 新时间线。
// 5) 所有写操作落 audit_log；operator 只是本机署名，不是安全边界。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { all, get, run } from './db.js';
import { nowISO } from './util.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DB_FILE = process.env.FACTORY_DB || path.join(ROOT, 'data', 'factory.db');
const ARCHIVE_DIR = path.join(ROOT, '_archive');
const OPERATOR_KEY = 'edit.operator';

export const EDIT_STATUSES = ['draft', 'review', 'approved', 'locked'];
export const EDIT_STATUS_LABELS = { draft: '草稿', review: '待审', approved: '已通过', locked: '已锁定' };
export const TRACK_KINDS = ['main', 'overlay', 'subtitle', 'audio'];
export const TRANSITIONS = ['cut', 'dissolve', 'fade-to-black'];

export class EditConflictError extends Error {
  constructor(message) { super(message); this.name = 'EditConflictError'; this.status = 409; }
}
export class EditLockedError extends Error {
  constructor(message) { super(message); this.name = 'EditLockedError'; this.status = 409; }
}

const txt = (v, n = 500) => String(v ?? '').trim().slice(0, n);
const int = (v, d = 0) => { const n = Math.trunc(Number(v)); return Number.isFinite(n) ? n : d; };
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

export function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

// ---------------- schema ----------------
function tableExists(name) {
  return all("SELECT name FROM sqlite_master WHERE type='table' AND name=?", name).length > 0;
}
function hasColumn(table, column) {
  return all(`PRAGMA table_info(${table})`).some((r) => r.name === column);
}
function addColumn(table, column, type = 'TEXT') {
  if (!hasColumn(table, column)) {
    try { run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`); } catch { /* 并发或已存在 */ }
  }
}

// 迁移前备份：db + wal + shm + config.json（只做一次，且只在首次建表时）
function backupOnce() {
  if (tableExists('edit_timelines')) return null;
  if (process.env.FACTORY_DB) return null; // 测试/隔离实例不占用正式 _archive
  try {
    const stamp = nowISO().replace(/[-:T]/g, '').slice(0, 14);
    const dir = path.join(ARCHIVE_DIR, `backup-${stamp}`);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) {
      if (fs.existsSync(f)) fs.copyFileSync(f, path.join(dir, path.basename(f)));
    }
    const cfg = process.env.FACTORY_CONFIG || path.join(ROOT, 'config', 'config.json');
    if (fs.existsSync(cfg)) fs.copyFileSync(cfg, path.join(dir, 'config.json'));
    return dir;
  } catch (e) {
    console.warn('[edit] 迁移前备份失败（继续建表）：', e.message);
    return null;
  }
}

let schemaReady = false;
export function ensureEditSchema() {
  if (schemaReady) return;
  backupOnce();
  run(`CREATE TABLE IF NOT EXISTS edit_timelines (
    id TEXT PRIMARY KEY, script_id TEXT, episode_id TEXT, code TEXT NOT NULL,
    title TEXT, doc_version INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'draft', source TEXT NOT NULL DEFAULT 'canvas',
    operator TEXT, note TEXT, render_id TEXT, created_at TEXT, updated_at TEXT)`);
  run('CREATE UNIQUE INDEX IF NOT EXISTS ux_edit_timelines_code ON edit_timelines(code)');
  run(`CREATE TABLE IF NOT EXISTS edit_tracks (
    id TEXT PRIMARY KEY, timeline_id TEXT NOT NULL, kind TEXT NOT NULL,
    idx INTEGER NOT NULL DEFAULT 1, name TEXT, enabled INTEGER DEFAULT 1,
    muted INTEGER DEFAULT 0, gain_db REAL DEFAULT 0, extra TEXT)`);
  run('CREATE INDEX IF NOT EXISTS ix_edit_tracks_timeline ON edit_tracks(timeline_id)');
  run(`CREATE TABLE IF NOT EXISTS edit_clips (
    id TEXT PRIMARY KEY, track_id TEXT NOT NULL, order_index INTEGER NOT NULL,
    shot_id TEXT, render_id TEXT, file_path TEXT,
    src_in_ms INTEGER NOT NULL DEFAULT 0, src_out_ms INTEGER NOT NULL DEFAULT 0,
    start_ms INTEGER NOT NULL DEFAULT 0,
    transition_in TEXT DEFAULT 'cut', transition_ms INTEGER DEFAULT 0,
    gain_db REAL DEFAULT 0, speed REAL DEFAULT 1,
    title TEXT, subtitle_text TEXT, extra TEXT)`);
  run('CREATE INDEX IF NOT EXISTS ix_edit_clips_track ON edit_clips(track_id)');
  run(`CREATE TABLE IF NOT EXISTS edit_versions (
    id TEXT PRIMARY KEY, timeline_id TEXT, version_no INTEGER, film_id TEXT,
    doc_version INTEGER, snapshot TEXT, note TEXT, operator TEXT, created_at TEXT)`);
  run(`CREATE TABLE IF NOT EXISTS review_comments (
    id TEXT PRIMARY KEY, timeline_id TEXT NOT NULL, version_id TEXT,
    timecode_ms INTEGER NOT NULL DEFAULT 0,
    x REAL, y REAL, w REAL, h REAL,
    category TEXT, severity TEXT, body TEXT,
    status TEXT DEFAULT 'open', author TEXT, created_at TEXT, resolved_at TEXT, resolved_by TEXT)`);
  run('CREATE INDEX IF NOT EXISTS ix_review_comments_timeline ON review_comments(timeline_id)');
  run(`CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY, actor TEXT, action TEXT, entity TEXT, entity_id TEXT,
    detail TEXT, at TEXT)`);
  run('CREATE INDEX IF NOT EXISTS ix_audit_log_entity ON audit_log(entity, entity_id)');
  if (tableExists('episode_films')) {
    addColumn('episode_films', 'timeline_id');
    addColumn('episode_films', 'version_no', 'INTEGER');
    addColumn('episode_films', 'parent_film_id');
    addColumn('episode_films', 'review_status', 'TEXT');
    addColumn('episode_films', 'operator');
  }
  schemaReady = true;
}

// ---------------- 操作人 / 审计 ----------------
export function getOperator() {
  const row = get('SELECT value FROM meta_kv WHERE key = ?', OPERATOR_KEY);
  return row?.value || '未署名';
}
export function setOperator(name) {
  const who = txt(name, 40) || '未署名';
  run('INSERT INTO meta_kv(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at', OPERATOR_KEY, who, nowISO());
  return who;
}
export function audit(actor, action, entity, entityId, detail = {}) {
  run('INSERT INTO audit_log(id,actor,action,entity,entity_id,detail,at) VALUES(?,?,?,?,?,?,?)',
    newId('AU'), txt(actor, 40) || '未署名', txt(action, 60), txt(entity, 40), txt(entityId, 80), JSON.stringify(detail).slice(0, 4000), nowISO());
}

// ---------------- 快照：从镜头/素材生成长度默认时间线 ----------------
export function listEpisodes() {
  // 注意：shots 表没有 code 列，编码在 script_episodes.code
  const rows = all(`SELECT s.script_id, s.episode_id, COALESCE(e.code, s.episode_id) code,
      MIN(s.idx) a, MAX(s.idx) b, COUNT(*) n,
      SUM(CASE WHEN s.status='done' THEN 1 ELSE 0 END) done
    FROM shots s LEFT JOIN script_episodes e ON e.id = s.episode_id
    GROUP BY s.script_id, s.episode_id ORDER BY s.script_id, code`);
  return rows;
}

function pickVideo(scriptId, episodeId, shotId) {
  return get(`SELECT * FROM shot_renders WHERE script_id=? AND shot_id=? AND kind='video' AND status='done'
    ORDER BY picked DESC, rowid DESC LIMIT 1`, scriptId, shotId)
    || get(`SELECT * FROM shot_renders WHERE script_id=? AND episode_id=? AND shot_id=? AND kind='video' AND status='done'
    ORDER BY rowid DESC LIMIT 1`, scriptId, episodeId, shotId);
}
function pickKeyframe(scriptId, shotId) {
  return get(`SELECT * FROM shot_renders WHERE script_id=? AND shot_id=? AND kind='keyframe' AND status='done'
    ORDER BY picked DESC, rowid DESC LIMIT 1`, scriptId, shotId);
}

function resolveMedia(p) {
  const s = txt(p, 500);
  if (!s) return '';
  return path.isAbsolute(s) ? s : path.join(ROOT, s);
}

export function snapshotFromShots({ scriptId, episodeId, code }) {
  const shots = all(`SELECT * FROM shots WHERE script_id=? AND episode_id=? ORDER BY idx`, scriptId, episodeId);
  if (!shots.length) throw new Error(`没有找到 ${code || episodeId} 的分镜`);
  const mainClips = [];
  let cursor = 0;
  for (const s of shots) {
    const video = pickVideo(scriptId, episodeId, s.id);
    const kf = pickKeyframe(scriptId, s.id);
    const durMs = Math.max(100, Math.round(num(s.duration, 3) * 1000));
    mainClips.push({
      id: newId('CL'),
      shot_id: s.id,
      render_id: video?.id || null,
      file_path: video?.file_path || '',
      poster_path: kf?.file_path || '',
      src_in_ms: 0,
      src_out_ms: durMs,
      start_ms: cursor,
      transition_in: cursor === 0 ? 'cut' : (TRANSITIONS.includes(s.transition) ? s.transition : 'cut'),
      transition_ms: 0,
      gain_db: 0,
      speed: 1,
      title: `第${s.idx}镜`,
      subtitle_text: txt(s.dialogue, 500),
      extra: { shot_idx: s.idx, duration: num(s.duration, 3), needs_video: !video, poster_path: kf?.file_path || '' },
    });
    cursor += durMs;
  }
  // 对白自动生成字幕片段（与主轨时间对齐），渲染时按需烧录
  const subtitles = mainClips.filter((c) => c.subtitle_text).map((c) => ({
    id: newId('CL'),
    shot_id: c.shot_id,
    render_id: null,
    file_path: '',
    poster_path: '',
    src_in_ms: 0,
    src_out_ms: Math.max(300, c.src_out_ms - c.src_in_ms),
    start_ms: c.start_ms,
    transition_in: 'cut',
    transition_ms: 0,
    gain_db: 0,
    speed: 1,
    title: c.title,
    subtitle_text: c.subtitle_text,
    extra: { from_dialogue: true },
  }));
  return {
    timeline: { script_id: scriptId, episode_id: episodeId, code, title: code, source: 'canvas' },
    tracks: [
      { id: newId('TR'), kind: 'main', idx: 1, name: '主轨', enabled: 1, muted: 0, gain_db: 0 },
      { id: newId('TR'), kind: 'overlay', idx: 1, name: '画中画 1', enabled: 1, muted: 0, gain_db: 0 },
      { id: newId('TR'), kind: 'subtitle', idx: 1, name: '字幕', enabled: 1, muted: 0, gain_db: 0 },
      { id: newId('TR'), kind: 'audio', idx: 1, name: '配乐/音效', enabled: 1, muted: 0, gain_db: -6 },
    ],
    clips: mainClips,
    subtitles,
    _mainTrackId: null,
  };
}

// ---------------- 读取 / 创建 ----------------
export function findTimelineByCode(code, scriptId = null) {
  const row = scriptId
    ? get('SELECT * FROM edit_timelines WHERE code=? AND script_id=?', code, scriptId)
    : get('SELECT * FROM edit_timelines WHERE code=?', code);
  return row || null;
}

export function getTimelineDoc(id) {
  const tl = get('SELECT * FROM edit_timelines WHERE id=?', id);
  if (!tl) return null;
  const tracks = all('SELECT * FROM edit_tracks WHERE timeline_id=? ORDER BY idx, id', id);
  const clips = all('SELECT * FROM edit_clips WHERE track_id IN (SELECT id FROM edit_tracks WHERE timeline_id=?) ORDER BY order_index, id', id);
  const byTrack = new Map(tracks.map((t) => [t.id, []]));
  for (const c of clips) {
    if (!byTrack.has(c.track_id)) continue;
    let extra = {};
    try { extra = JSON.parse(c.extra || '{}'); } catch { /* ignore */ }
    byTrack.get(c.track_id).push({ ...c, extra });
  }
  return {
    timeline: tl,
    tracks: tracks.map((t) => ({ ...t, clips: byTrack.get(t.id) || [] })),
  };
}

export function createTimelineFromShots({ scriptId, episodeId, code, operator = getOperator() }) {
  const snap = snapshotFromShots({ scriptId, episodeId, code });
  const id = newId('TL');
  const now = nowISO();
  run('INSERT INTO edit_timelines(id,script_id,episode_id,code,title,doc_version,status,source,operator,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    id, scriptId, episodeId, code, snap.timeline.title, 1, 'draft', 'canvas', operator, now, now);
  for (const t of snap.tracks) {
    run('INSERT INTO edit_tracks(id,timeline_id,kind,idx,name,enabled,muted,gain_db) VALUES(?,?,?,?,?,?,?,?)',
      t.id, id, t.kind, t.idx, t.name, t.enabled, t.muted, t.gain_db);
  }
  const mainTrack = snap.tracks.find((t) => t.kind === 'main');
  const subtitleTrack = snap.tracks.find((t) => t.kind === 'subtitle');
  for (const c of snap.subtitles || []) {
    run(`INSERT INTO edit_clips(id,track_id,order_index,shot_id,render_id,file_path,src_in_ms,src_out_ms,start_ms,transition_in,transition_ms,gain_db,speed,title,subtitle_text,extra)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      c.id, subtitleTrack.id, (snap.subtitles || []).indexOf(c), c.shot_id, null, '', c.src_in_ms, c.src_out_ms,
      c.start_ms, 'cut', 0, 0, 1, c.title, c.subtitle_text, JSON.stringify(c.extra || {}));
  }
  for (const c of snap.clips) {
    run(`INSERT INTO edit_clips(id,track_id,order_index,shot_id,render_id,file_path,src_in_ms,src_out_ms,start_ms,transition_in,transition_ms,gain_db,speed,title,subtitle_text,extra)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      c.id, mainTrack.id, mainClipsIndex(snap.clips, c), c.shot_id, c.render_id, c.file_path,
      c.src_in_ms, c.src_out_ms, c.start_ms, c.transition_in, c.transition_ms, c.gain_db, c.speed,
      c.title, c.subtitle_text, JSON.stringify(c.extra || {}));
  }
  audit(operator, 'create', 'timeline', id, { code, clips: snap.clips.length });
  return getTimelineDoc(id);
}

function mainClipsIndex(list, clip) { return list.indexOf(clip); }

export function getOrCreateTimeline(code, { scriptId = null, operator = getOperator() } = {}) {
  const found = findTimelineByCode(code, scriptId);
  if (found) return getTimelineDoc(found.id);
  const ep = scriptId
    ? get(`SELECT s.script_id, s.episode_id, COALESCE(e.code, s.episode_id) code FROM shots s
        LEFT JOIN script_episodes e ON e.id = s.episode_id
        WHERE s.script_id=? AND COALESCE(e.code, s.episode_id)=? LIMIT 1`, scriptId, code)
    : get(`SELECT s.script_id, s.episode_id, COALESCE(e.code, s.episode_id) code FROM shots s
        LEFT JOIN script_episodes e ON e.id = s.episode_id
        WHERE COALESCE(e.code, s.episode_id)=? LIMIT 1`, code);
  if (!ep) throw new Error(`没有找到剧集 ${code} 的分镜，无法创建时间线`);
  return createTimelineFromShots({ scriptId: ep.script_id, episodeId: ep.episode_id, code: ep.code, operator });
}

// ---------------- 保存（乐观锁 + 只读门禁） ----------------
function normalizeClip(raw, index) {
  const inMs = Math.max(0, int(raw.src_in_ms, 0));
  let outMs = Math.max(0, int(raw.src_out_ms, 0));
  if (outMs <= inMs) outMs = inMs + 100;
  const t = TRANSITIONS.includes(raw.transition_in) ? raw.transition_in : 'cut';
  return {
    id: txt(raw.id, 60) || newId('CL'),
    order_index: index,
    shot_id: txt(raw.shot_id, 60) || null,
    render_id: txt(raw.render_id, 60) || null,
    file_path: txt(raw.file_path, 500) || null,
    src_in_ms: inMs,
    src_out_ms: outMs,
    start_ms: Math.max(0, int(raw.start_ms, 0)),
    transition_in: t,
    transition_ms: Math.max(0, Math.min(2000, int(raw.transition_ms, 0))),
    gain_db: Math.max(-60, Math.min(12, num(raw.gain_db, 0))),
    speed: Math.max(0.25, Math.min(4, num(raw.speed, 1) || 1)),
    title: txt(raw.title, 120) || null,
    subtitle_text: txt(raw.subtitle_text, 2000) || null,
    extra: JSON.stringify(raw.extra && typeof raw.extra === 'object' ? raw.extra : {}),
  };
}

export function saveTimelineDoc(id, doc, { docVersion, operator = getOperator() } = {}) {
  const tl = get('SELECT * FROM edit_timelines WHERE id=?', id);
  if (!tl) throw new Error('时间线不存在');
  if (tl.status === 'locked') throw new EditLockedError('时间线已锁定，不能修改；请先复制为新版本');
  if (docVersion !== undefined && Number(docVersion) !== Number(tl.doc_version)) {
    throw new EditConflictError(`时间线已被他人修改（当前版本 ${tl.doc_version}，你提交的是 ${docVersion}）；请刷新后重试`);
  }
  const tracks = Array.isArray(doc?.tracks) ? doc.tracks : [];
  const kinds = new Set(tracks.map((t) => t.kind));
  if (!kinds.has('main')) throw new Error('缺少主轨');
  for (const t of tracks) if (!TRACK_KINDS.includes(t.kind)) throw new Error(`未知轨道类型：${t.kind}`);

  // 删除旧轨与片段，按提交内容重建（片段 id 保留）
  run('DELETE FROM edit_clips WHERE track_id IN (SELECT id FROM edit_tracks WHERE timeline_id=?)', id);
  run('DELETE FROM edit_tracks WHERE timeline_id=?', id);
  for (const [ti, t] of tracks.entries()) {
    const trackId = txt(t.id, 60) || newId('TR');
    run('INSERT INTO edit_tracks(id,timeline_id,kind,idx,name,enabled,muted,gain_db) VALUES(?,?,?,?,?,?,?,?)',
      trackId, id, t.kind, int(t.idx, ti + 1), txt(t.name, 60) || t.kind, t.enabled === 0 ? 0 : 1, t.muted ? 1 : 0, num(t.gain_db, 0));
    const clips = Array.isArray(t.clips) ? t.clips : [];
    clips.forEach((c, ci) => {
      const n = normalizeClip(c, ci);
      run(`INSERT INTO edit_clips(id,track_id,order_index,shot_id,render_id,file_path,src_in_ms,src_out_ms,start_ms,transition_in,transition_ms,gain_db,speed,title,subtitle_text,extra)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        n.id, trackId, n.order_index, n.shot_id, n.render_id, n.file_path, n.src_in_ms, n.src_out_ms,
        n.start_ms, n.transition_in, n.transition_ms, n.gain_db, n.speed, n.title, n.subtitle_text, n.extra);
    });
  }
  const next = Number(tl.doc_version) + 1;
  run('UPDATE edit_timelines SET doc_version=?, updated_at=?, operator=? WHERE id=?', next, nowISO(), operator, id);
  audit(operator, 'save', 'timeline', id, { doc_version: next, tracks: tracks.length, clips: tracks.reduce((a, t) => a + (t.clips?.length || 0), 0) });
  return getTimelineDoc(id);
}

// ---------------- 重新同步（预览 + 应用） ----------------
export function resyncPreview(id) {
  const tl = get('SELECT * FROM edit_timelines WHERE id=?', id);
  if (!tl) throw new Error('时间线不存在');
  const fresh = snapshotFromShots({ scriptId: tl.script_id, episodeId: tl.episode_id, code: tl.code });
  const current = getTimelineDoc(id);
  const main = current.tracks.find((t) => t.kind === 'main');
  const curSig = (main?.clips || []).map((c) => c.shot_id).join(',');
  const newSig = fresh.clips.map((c) => c.shot_id).join(',');
  const added = fresh.clips.filter((c) => !(main?.clips || []).some((x) => x.shot_id === c.shot_id));
  const removed = (main?.clips || []).filter((c) => !fresh.clips.some((x) => x.shot_id === c.shot_id));
  return {
    changed: curSig !== newSig,
    added: added.map((c) => ({ shot_id: c.shot_id, title: c.title })),
    removed: removed.map((c) => ({ shot_id: c.shot_id, title: c.title })),
    current_count: main?.clips?.length || 0,
    next_count: fresh.clips.length,
  };
}

export function resyncApply(id, { operator = getOperator() } = {}) {
  const tl = get('SELECT * FROM edit_timelines WHERE id=?', id);
  if (!tl) throw new Error('时间线不存在');
  if (tl.status === 'locked') throw new EditLockedError('时间线已锁定，不能同步');
  const fresh = snapshotFromShots({ scriptId: tl.script_id, episodeId: tl.episode_id, code: tl.code });
  const tracks = [];
  for (const t of fresh.tracks) {
    const clips = t.kind === 'main' ? fresh.clips : (t.kind === 'subtitle' ? fresh.subtitles : []);
    tracks.push({ ...t, clips });
  }
  const saved = saveTimelineDoc(id, { tracks }, { docVersion: tl.doc_version, operator });
  audit(operator, 'resync', 'timeline', id, {});
  return saved;
}

// ---------------- 版本 ----------------
export function listVersions(id) {
  return all('SELECT id,timeline_id,version_no,film_id,doc_version,note,operator,created_at FROM edit_versions WHERE timeline_id=? ORDER BY version_no DESC', id);
}
export function recordVersion(id, { filmId, docVersion, snapshot, note, operator }) {
  const row = get('SELECT MAX(version_no) n FROM edit_versions WHERE timeline_id=?', id);
  const no = Number(row?.n || 0) + 1;
  run('INSERT INTO edit_versions(id,timeline_id,version_no,film_id,doc_version,snapshot,note,operator,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    newId('EV'), id, no, filmId || null, docVersion, JSON.stringify(snapshot || {}), txt(note, 200), operator, nowISO());
  return no;
}
export function restoreVersion(id, versionNo, { operator = getOperator() } = {}) {
  const v = get('SELECT * FROM edit_versions WHERE timeline_id=? AND version_no=?', id, versionNo);
  if (!v) throw new Error('版本不存在');
  const snap = JSON.parse(v.snapshot || '{}');
  if (!snap.tracks) throw new Error('该版本没有可恢复的编辑快照');
  const tl = get('SELECT * FROM edit_timelines WHERE id=?', id);
  const saved = saveTimelineDoc(id, snap, { docVersion: tl.doc_version, operator });
  audit(operator, 'restore', 'timeline', id, { version_no: versionNo });
  return saved;
}

// ---------------- 审片 ----------------
export function listFilms(id) {
  return all('SELECT * FROM episode_films WHERE timeline_id=? ORDER BY version_no DESC, rowid DESC', id);
}

const VALID_FLOW = { draft: ['review'], review: ['approved', 'draft'], approved: ['locked', 'review'], locked: [] };

export function setReviewStatus(id, next, { note = '', operator = getOperator(), filmId = null } = {}) {
  const tl = get('SELECT * FROM edit_timelines WHERE id=?', id);
  if (!tl) throw new Error('时间线不存在');
  if (!EDIT_STATUSES.includes(next)) throw new Error(`未知审核状态：${next}`);
  const allowed = VALID_FLOW[tl.status] || [];
  if (!allowed.includes(next)) {
    throw new Error(`不能从「${EDIT_STATUS_LABELS[tl.status] || tl.status}」直接流转到「${EDIT_STATUS_LABELS[next] || next}」`);
  }
  const open = all("SELECT severity FROM review_comments WHERE timeline_id=? AND status='open'", id);
  const films = listFilms(id);
  const usableFilm = filmId ? films.find((f) => f.id === filmId) : films[0];
  if (next === 'review') {
    if (!usableFilm) throw new Error('还没有可播放的成片，不能送审');
    if (open.some((c) => c.severity === 'blocker')) throw new Error('还有未处理的阻断级意见，不能送审');
  }
  if (next === 'approved') {
    if (open.some((c) => c.severity === 'blocker' || c.severity === 'major')) {
      throw new Error('还有未处理的阻断/重要意见，不能通过审片');
    }
  }
  run('UPDATE edit_timelines SET status=?, updated_at=?, note=?, operator=? WHERE id=?', next, nowISO(), txt(note, 500), operator, id);
  if (usableFilm) {
    run('UPDATE episode_films SET review_status=?, operator=? WHERE id=?', next, operator, usableFilm.id);
  }
  audit(operator, `review:${next}`, 'timeline', id, { from: tl.status, note });
  return get('SELECT * FROM edit_timelines WHERE id=?', id);
}

// ---------------- 批注 ----------------
export function listComments(id) {
  return all('SELECT * FROM review_comments WHERE timeline_id=? ORDER BY rowid DESC', id);
}
export function addComment(id, { timecode_ms = 0, x = null, y = null, w = null, h = null, category = 'content', severity = 'minor', body = '', author = getOperator(), versionId = null } = {}) {
  if (!txt(body, 2000)) throw new Error('批注内容不能为空');
  if (!['blocker', 'major', 'minor'].includes(severity)) throw new Error('严重级必须是 blocker/major/minor');
  const cid = newId('RC');
  run(`INSERT INTO review_comments(id,timeline_id,version_id,timecode_ms,x,y,w,h,category,severity,body,status,author,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,'open',?,?)`,
    cid, id, versionId, Math.max(0, int(timecode_ms, 0)), x, y, w, h, txt(category, 30) || 'content', severity, txt(body, 2000), txt(author, 40), nowISO());
  audit(author, 'comment:add', 'timeline', id, { severity, timecode_ms });
  return get('SELECT * FROM review_comments WHERE id=?', cid);
}
export function updateComment(cid, { status, body, severity } = {}, { operator = getOperator() } = {}) {
  const c = get('SELECT * FROM review_comments WHERE id=?', cid);
  if (!c) throw new Error('批注不存在');
  const nextStatus = status === undefined ? c.status : status;
  if (!['open', 'fixed', 'wontfix', 'resolved'].includes(nextStatus)) throw new Error('未知批注状态');
  run('UPDATE review_comments SET status=?, body=?, severity=?, resolved_at=?, resolved_by=? WHERE id=?',
    nextStatus, body === undefined ? c.body : txt(body, 2000), severity === undefined ? c.severity : severity,
    nextStatus === 'open' ? null : nowISO(), nextStatus === 'open' ? null : operator, cid);
  audit(operator, 'comment:update', 'timeline', c.timeline_id, { id: cid, status: nextStatus });
  return get('SELECT * FROM review_comments WHERE id=?', cid);
}

export function listAudit(entityId, limit = 100) {
  return all('SELECT * FROM audit_log WHERE entity_id=? ORDER BY at DESC LIMIT ?', entityId, Math.min(500, Math.max(1, int(limit, 100))));
}

export function resolveMediaPath(p) { return resolveMedia(p); }
export { ROOT as EDIT_ROOT };
