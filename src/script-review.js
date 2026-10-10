// 剧本工厂 · 审核流程（plain text module）
//
// 状态机：draft → review → approved → locked
//   draft     草稿：刚生成，尚未送审
//   review    待审：已提交审核，等待处理
//   approved  通过：审核通过，可进入制作台
//   locked    锁定：已定稿，禁止再改（与镜头锁定 shot.locked 相互独立）
//
// - ensureReviewSchema：为 script_episodes / shots 补齐审核字段
// - setEpisodeReview / setShotReview：单集或单镜流转
// - batchSetShotReview：整集批量流转镜头
// - reviewOverview：按集汇总审核进度
// - reviewGate：给制作台用的前置校验（只告警，不硬阻断）

import { all, get, run } from './db.js';
import { nowISO } from './util.js';
import { ensureScriptingSchema } from './scripting-schema.js';

export const REVIEW_STATUSES = ['draft', 'review', 'approved', 'locked'];

export const REVIEW_LABELS = {
  draft: '草稿',
  review: '待审',
  approved: '已通过',
  locked: '已锁定',
};

const EPISODE_COLUMNS = ['review_status', 'reviewer', 'reviewed_at', 'review_note'];
const SHOT_COLUMNS = ['review_status', 'reviewer', 'reviewed_at', 'review_note'];

function hasColumn(table, column) {
  return all(`PRAGMA table_info(${table})`).some((row) => row.name === column);
}

function addColumn(table, column) {
  if (!hasColumn(table, column)) {
    try { run(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`); } catch { /* 并发或已存在 */ }
  }
}

export function ensureReviewSchema() {
  ensureScriptingSchema();
  for (const col of EPISODE_COLUMNS) addColumn('script_episodes', col);
  for (const col of SHOT_COLUMNS) addColumn('shots', col);
  // 老数据没有审核状态时，默认草稿
  try { run("UPDATE script_episodes SET review_status = 'draft' WHERE review_status IS NULL OR review_status = ''"); } catch { /* ignore */ }
  try { run("UPDATE shots SET review_status = 'draft' WHERE review_status IS NULL OR review_status = ''"); } catch { /* ignore */ }
}

function normalizeStatus(status, fallback = 'draft') {
  const s = String(status || '').trim().toLowerCase();
  if (REVIEW_STATUSES.includes(s)) return s;
  if (s === 'pending' || s === 'reviewing') return 'review';
  if (s === 'ok' || s === 'pass' || s === 'passed') return 'approved';
  if (s === 'reject' || s === 'rejected') return 'draft';
  return fallback;
}

function clipNote(note) {
  return String(note ?? '').trim().slice(0, 500);
}

export function setEpisodeReview(scriptId, code, { status = 'review', reviewer = '', note = '' } = {}) {
  ensureReviewSchema();
  const ep = get('SELECT * FROM script_episodes WHERE script_id = ? AND code = ?', scriptId, code);
  if (!ep) throw new Error('剧集不存在');
  const next = normalizeStatus(status, ep.review_status || 'draft');
  run(
    'UPDATE script_episodes SET review_status = ?, reviewer = ?, reviewed_at = ?, review_note = ?, updated_at = ? WHERE id = ?',
    next, String(reviewer || '').slice(0, 60), nowISO(), clipNote(note), nowISO(), ep.id,
  );
  return { ok: true, code, status: next, reviewer: String(reviewer || ''), reviewedAt: nowISO() };
}

export function setShotReview(scriptId, shotId, { status = 'review', reviewer = '', note = '' } = {}) {
  ensureReviewSchema();
  const shot = get('SELECT * FROM shots WHERE id = ? AND script_id = ?', shotId, scriptId);
  if (!shot) throw new Error('镜头不存在');
  const next = normalizeStatus(status, shot.review_status || 'draft');
  run(
    'UPDATE shots SET review_status = ?, reviewer = ?, reviewed_at = ?, review_note = ? WHERE id = ?',
    next, String(reviewer || '').slice(0, 60), nowISO(), clipNote(note), shotId,
  );
  return { ok: true, shotId, status: next };
}

export function batchSetShotReview(scriptId, code, { status = 'approved', reviewer = '', note = '', onlyDraft = true } = {}) {
  ensureReviewSchema();
  const ep = get('SELECT * FROM script_episodes WHERE script_id = ? AND code = ?', scriptId, code);
  if (!ep) throw new Error('剧集不存在');
  const next = normalizeStatus(status, 'approved');
  const shots = all('SELECT id, locked, review_status FROM shots WHERE episode_id = ?', ep.id);
  let changed = 0;
  let skippedLocked = 0;
  for (const shot of shots) {
    // 已锁定的镜头状态不允许被批量改写
    if (Number(shot.locked) === 1 && next !== 'locked') { skippedLocked += 1; continue; }
    if (onlyDraft && shot.review_status && shot.review_status !== 'draft') continue;
    run(
      'UPDATE shots SET review_status = ?, reviewer = ?, reviewed_at = ?, review_note = ? WHERE id = ?',
      next, String(reviewer || '').slice(0, 60), nowISO(), clipNote(note), shot.id,
    );
    changed += 1;
  }
  return { ok: true, code, status: next, changed, skippedLocked, total: shots.length };
}

export function reviewOverview(scriptId) {
  ensureReviewSchema();
  const script = get('SELECT * FROM scripts WHERE id = ?', scriptId);
  if (!script) throw new Error('剧本不存在');
  const episodes = all('SELECT * FROM script_episodes WHERE script_id = ? ORDER BY episode ASC', scriptId);
  const counts = { draft: 0, review: 0, approved: 0, locked: 0 };
  const rows = episodes.map((ep) => {
    const status = normalizeStatus(ep.review_status || 'draft', 'draft');
    counts[status] = (counts[status] || 0) + 1;
    const shots = all('SELECT id, locked, review_status FROM shots WHERE episode_id = ?', ep.id);
    const shotCounts = { draft: 0, review: 0, approved: 0, locked: 0 };
    for (const shot of shots) {
      const s = normalizeStatus(shot.review_status || 'draft', 'draft');
      shotCounts[s] = (shotCounts[s] || 0) + 1;
    }
    return {
      code: ep.code,
      title: ep.title || '',
      status,
      statusLabel: REVIEW_LABELS[status],
      reviewer: ep.reviewer || '',
      reviewedAt: ep.reviewed_at || '',
      reviewNote: ep.review_note || '',
      shots: shots.length,
      shotCounts,
      lockedShots: shots.filter((x) => Number(x.locked) === 1).length,
      approved: status === 'approved' || status === 'locked',
    };
  });
  const pending = rows.filter((r) => !r.approved);
  return {
    ok: true,
    scriptId,
    summary: {
      episodes: rows.length,
      ...counts,
      pending: pending.length,
      approved: counts.approved + counts.locked,
    },
    episodes: rows,
  };
}

// 制作台前置校验：未通过的集只给中文告警，允许人工确认后继续。
export function reviewGate(scriptId, codes = []) {
  ensureReviewSchema();
  const overview = reviewOverview(scriptId);
  const want = new Set((Array.isArray(codes) ? codes : [codes]).filter(Boolean));
  const targets = want.size ? overview.episodes.filter((e) => want.has(e.code)) : overview.episodes;
  const pending = targets.filter((e) => !e.approved);
  return {
    ok: true,
    scriptId,
    checked: targets.length,
    pending: pending.map((e) => ({ code: e.code, title: e.title, status: e.status, statusLabel: e.statusLabel })),
    approved: targets.length - pending.length,
    warning: pending.length
      ? `以下 ${pending.length} 集尚未审核通过：${pending.map((e) => `${e.code}（${e.statusLabel}）`).join('、')}。继续制作前建议先在剧本工厂完成审核。`
      : '',
  };
}
