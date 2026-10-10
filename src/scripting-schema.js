// 剧本工厂增强层（plain text module）
//
// - ensureScriptingSchema：补齐 shots 的锁定/声音字段，创建 script_snapshots
// - snapshotEpisode / listSnapshots / restoreSnapshot：分集剧本与分镜的版本快照
// - setShotLocked / updateShotPerformance：镜头锁定与 speaker/emotion/voice 元数据
// - estimateEpisode：生成前成本与工作量预估

import { all, get, run } from './db.js';
import { loadConfig } from './config.js';
import { nowISO, countWords } from './util.js';
import { randomUUID } from 'node:crypto';

export const SNAPSHOT_KEEP_PER_KIND = 20;

const SHOT_COLUMNS = [
  'id', 'script_id', 'episode_id', 'idx', 'scene_no', 'location_id', 'time_of_day',
  'shot_size', 'camera', 'move', 'transition', 'duration', 'action', 'dialogue', 'sfx', 'music',
  'mood', 'prompt_pos', 'prompt_neg', 'refs', 'cost_level', 'status', 'created_at', 'tail_image',
  'locked', 'speaker', 'emotion', 'voice_id',
];

function safeJson(value, fallback) {
  try {
    if (value === null || value === undefined || value === '') return fallback;
    if (typeof value === 'object') return value;
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function hasColumn(table, column) {
  return all(`PRAGMA table_info(${table})`).some((row) => row.name === column);
}

export function ensureScriptingSchema() {
  const add = (column, ddl) => {
    if (!hasColumn('shots', column)) {
      try { run(`ALTER TABLE shots ADD COLUMN ${column} ${ddl}`); } catch { /* 并发或已存在 */ }
    }
  };
  add('locked', 'INTEGER DEFAULT 0');
  add('speaker', 'TEXT');
  add('emotion', 'TEXT');
  add('voice_id', 'TEXT');
  run(`CREATE TABLE IF NOT EXISTS script_snapshots (
    id TEXT PRIMARY KEY,
    script_id TEXT NOT NULL,
    episode_code TEXT,
    kind TEXT NOT NULL,
    version INTEGER NOT NULL,
    payload TEXT NOT NULL,
    note TEXT,
    created_by TEXT,
    created_at TEXT
  )`);
  run('CREATE INDEX IF NOT EXISTS idx_script_snapshots_lookup ON script_snapshots(script_id, episode_code, kind, version)');
}

export function snapshotEpisode(scriptId, episodeCode, { kind = 'storyboard', note = '', createdBy = 'human' } = {}) {
  ensureScriptingSchema();
  const script = get('SELECT * FROM scripts WHERE id = ?', scriptId);
  if (!script) throw new Error('剧本不存在');
  const episode = get('SELECT * FROM script_episodes WHERE script_id = ? AND code = ?', scriptId, episodeCode);
  if (!episode) throw new Error('剧集不存在');
  const shots = all('SELECT * FROM shots WHERE episode_id = ? ORDER BY idx ASC', episode.id);
  const version = Number(get(
    'SELECT COALESCE(MAX(version), 0) AS v FROM script_snapshots WHERE script_id = ? AND episode_code = ? AND kind = ?',
    scriptId, episodeCode, kind,
  )?.v || 0) + 1;
  const id = `SNP-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const payload = JSON.stringify({ episode, shots, capturedAt: nowISO() });
  run(
    'INSERT INTO script_snapshots(id, script_id, episode_code, kind, version, payload, note, created_by, created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    id, scriptId, episodeCode, kind, version, payload, note || '', createdBy, nowISO(),
  );
  run(
    `DELETE FROM script_snapshots WHERE id IN (
       SELECT id FROM script_snapshots
       WHERE script_id = ? AND episode_code = ? AND kind = ?
       ORDER BY version DESC LIMIT -1 OFFSET ?
     )`,
    scriptId, episodeCode, kind, SNAPSHOT_KEEP_PER_KIND,
  );
  return { ok: true, id, scriptId, episodeCode, kind, version, shots: shots.length };
}

export function listSnapshots(scriptId, { episodeCode = '', kind = '' } = {}) {
  ensureScriptingSchema();
  const where = ['script_id = ?'];
  const params = [scriptId];
  if (episodeCode) { where.push('episode_code = ?'); params.push(episodeCode); }
  if (kind) { where.push('kind = ?'); params.push(kind); }
  return all(
    `SELECT id, script_id, episode_code, kind, version, note, created_by, created_at
     FROM script_snapshots WHERE ${where.join(' AND ')}
     ORDER BY version DESC LIMIT 200`,
    ...params,
  );
}

export function getSnapshot(snapshotId) {
  ensureScriptingSchema();
  const row = get('SELECT * FROM script_snapshots WHERE id = ?', snapshotId);
  if (!row) throw new Error('快照不存在');
  return { ...row, payload: safeJson(row.payload, {}) };
}

export function restoreSnapshot(snapshotId, { keepLocked = false } = {}) {
  ensureScriptingSchema();
  const snapshot = getSnapshot(snapshotId);
  const payload = snapshot.payload || {};
  const episode = payload.episode;
  if (!episode?.id) throw new Error('快照缺少剧集数据');
  const currentShots = all('SELECT * FROM shots WHERE episode_id = ?', episode.id);
  const lockedIds = new Set(currentShots.filter((s) => Number(s.locked) === 1).map((s) => s.id));
  const snapshotShots = payload.shots || [];
  const shots = keepLocked
    ? [
        ...snapshotShots.filter((s) => !lockedIds.has(s.id)),
        ...currentShots.filter((s) => lockedIds.has(s.id)),
      ]
    : snapshotShots;
  const transaction = () => {
    run(
      `UPDATE script_episodes SET title=?, logline=?, hook=?, cliffhanger=?, duration=?, source_chapters=?, scenes=?, status=?, updated_at=?
       WHERE id=?`,
      episode.title || '', episode.logline || '', episode.hook || '', episode.cliffhanger || '',
      episode.duration || 0, episode.source_chapters || '[]', episode.scenes || '{}',
      episode.status || 'planned', nowISO(), episode.id,
    );
    run('DELETE FROM shots WHERE episode_id = ?', episode.id);
    for (const shot of shots) {
      const values = SHOT_COLUMNS.map((col) => (shot[col] === undefined ? null : shot[col]));
      run(
        `INSERT OR REPLACE INTO shots(${SHOT_COLUMNS.join(', ')}) VALUES(${SHOT_COLUMNS.map(() => '?').join(',')})`,
        ...values,
      );
    }
  };
  try { run('BEGIN'); transaction(); run('COMMIT'); }
  catch (err) { try { run('ROLLBACK'); } catch { /* ignore */ } throw err; }
  return { ok: true, snapshotId, episodeId: episode.id, restoredShots: shots.length, skippedLocked: keepLocked ? lockedIds.size : 0 };
}

export function setShotLocked(scriptId, shotId, locked) {
  ensureScriptingSchema();
  const shot = get('SELECT * FROM shots WHERE id = ? AND script_id = ?', shotId, scriptId);
  if (!shot) throw new Error('镜头不存在');
  run('UPDATE shots SET locked = ? WHERE id = ?', locked ? 1 : 0, shotId);
  return { ok: true, shotId, locked: Boolean(locked) };
}

export function updateShotPerformance(scriptId, shotId, { speaker = null, emotion = null, voiceId = null } = {}) {
  ensureScriptingSchema();
  const shot = get('SELECT * FROM shots WHERE id = ? AND script_id = ?', shotId, scriptId);
  if (!shot) throw new Error('镜头不存在');
  run(
    'UPDATE shots SET speaker = ?, emotion = ?, voice_id = ? WHERE id = ?',
    speaker === null ? shot.speaker : String(speaker).slice(0, 60),
    emotion === null ? shot.emotion : String(emotion).slice(0, 60),
    voiceId === null ? shot.voice_id : String(voiceId).slice(0, 120),
    shotId,
  );
  return { ok: true, shot: get('SELECT * FROM shots WHERE id = ?', shotId) };
}

export function estimateEpisode(scriptId, episodeCode = '') {
  ensureScriptingSchema();
  const script = get('SELECT * FROM scripts WHERE id = ?', scriptId);
  if (!script) throw new Error('剧本不存在');
  const episodes = episodeCode
    ? all('SELECT * FROM script_episodes WHERE script_id = ? AND code = ?', scriptId, episodeCode)
    : all('SELECT * FROM script_episodes WHERE script_id = ? ORDER BY episode ASC', scriptId);
  if (!episodes.length) throw new Error('剧集不存在');
  const episodeIds = episodes.map((e) => e.id);
  const shots = episodeIds.length
    ? all(`SELECT * FROM shots WHERE episode_id IN (${episodeIds.map(() => '?').join(',')})`, ...episodeIds)
    : [];
  const keyframeDone = new Set(
    all('SELECT DISTINCT shot_id FROM shot_renders WHERE kind = ? AND status = ?', 'keyframe', 'done').map((r) => r.shot_id),
  );
  const cost = { L: 0, M: 0, H: 0 };
  for (const shot of shots) {
    const lv = String(shot.cost_level || 'L').trim().charAt(0).toUpperCase();
    if (cost[lv] !== undefined) cost[lv] += 1;
  }
  const duration = shots.reduce((sum, s) => sum + (Number(s.duration) || 0), 0);
  const estimatedLlmCalls = episodes.length
    + episodes.length
    + episodes.reduce((sum, ep) => {
        const n = shots.filter((s) => s.episode_id === ep.id).length;
        return sum + Math.max(1, Math.min(4, Math.ceil(n / 18)));
      }, 0);
  const config = loadConfig();
  const billing = config?.billing || null;
  const unit = billing?.videoPerSecond || billing?.video?.perSecond || null;
  const estimatedVideoCost = unit ? Number((duration * Number(unit)).toFixed(2)) : null;
  return {
    ok: true,
    scriptId,
    episodeCodes: episodes.map((e) => e.code),
    episodes: episodes.length,
    shots: shots.length,
    keyframes: shots.filter((s) => !keyframeDone.has(s.id)).length,
    videos: shots.filter((s) => ['M', 'H'].includes(String(s.cost_level || '').charAt(0).toUpperCase())).length,
    videosAll: shots.length,
    duration: Number(duration.toFixed(2)),
    costLevels: cost,
    estimatedLlmCalls,
    estimatedVideoCost,
    billingNote: unit
      ? `按视频单价 ${unit}/秒估算，仅供参考`
      : '未配置按秒视频单价，只给数量预估，金额以实际账单为准',
  };
}

export function episodeWordCount(episode) {
  const scenes = safeJson(episode?.scenes, {});
  const beats = Array.isArray(scenes?.scenes) ? scenes.scenes.flatMap((s) => s.beats || []) : [];
  return beats.reduce((sum, b) => sum + countWords(b?.text || b?.action || b?.dialogue || ''), 0);
}
