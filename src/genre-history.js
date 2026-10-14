// 小说工坊 · 题材生成器历史（plain text module）
// 存储题材生成器 / AI 头脑风暴产出的题材方案，支持列表、复用、删除。
// 约定：同一 genreId 只保留一条（再次生成则覆盖更新）；列表按 rowid 排序（不依赖 created_at）。
import { all, get, run } from './db.js';
import { nowISO, rid } from './util.js';

let schemaReady = false;

const TEXT = (v, max = 500) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const MULTI = (v, max = 20000) => String(v ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max);
const safeJson = (v, fallback) => {
  try { const out = JSON.parse(v || ''); return out == null ? fallback : out; } catch { return fallback; }
};

export function ensureGenreHistorySchema() {
  if (schemaReady) return;
  run(`CREATE TABLE IF NOT EXISTS genre_generator_history (
    id TEXT PRIMARY KEY,
    genre_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '',
    tone TEXT NOT NULL DEFAULT '',
    keywords TEXT NOT NULL DEFAULT '[]',
    positioning TEXT NOT NULL DEFAULT '',
    hook TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    framework_intro TEXT NOT NULL DEFAULT '',
    skill_prompt TEXT NOT NULL DEFAULT '',
    options TEXT NOT NULL DEFAULT '{}',
    source TEXT NOT NULL DEFAULT 'generator',
    used_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  run('CREATE INDEX IF NOT EXISTS idx_genre_history_genre ON genre_generator_history(genre_id)');
  schemaReady = true;
}

function rowToItem(row) {
  if (!row) return null;
  return {
    id: row.id,
    genreId: row.genre_id,
    name: row.name,
    category: row.category || '',
    tone: row.tone || '',
    keywords: safeJson(row.keywords, []),
    positioning: row.positioning || '',
    hook: row.hook || '',
    description: row.description || '',
    frameworkIntro: row.framework_intro || '',
    skillPrompt: row.skill_prompt || '',
    options: safeJson(row.options, {}),
    source: row.source || 'generator',
    usedCount: Number(row.used_count) || 0,
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || '',
  };
}

export function getGenreHistory(id) {
  ensureGenreHistorySchema();
  return rowToItem(get('SELECT * FROM genre_generator_history WHERE id = ?', id));
}

export function listGenreHistory({ limit = 50 } = {}) {
  ensureGenreHistorySchema();
  const rows = all('SELECT * FROM genre_generator_history ORDER BY rowid DESC LIMIT ?', Math.max(1, Math.min(200, Number(limit) || 50)));
  return { ok: true, total: rows.length, items: rows.map(rowToItem) };
}

// 同一 genreId 只保留一条（再次生成覆盖更新），避免历史里堆重复项。
export function saveGenreHistory(genre = {}, { source = 'generator' } = {}) {
  ensureGenreHistorySchema();
  const genreId = TEXT(genre.genreId || genre.genre_id, 80);
  const name = TEXT(genre.name, 120);
  if (!genreId) throw new Error('缺少 genreId');
  if (!name) throw new Error('缺少题材名');
  const existing = get('SELECT id FROM genre_generator_history WHERE genre_id = ?', genreId);
  const id = existing?.id || rid('GH');
  const now = nowISO();
  run(
    `INSERT INTO genre_generator_history(
      id, genre_id, name, category, tone, keywords, positioning, hook, description,
      framework_intro, skill_prompt, options, source, used_count, created_at, updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)
    ON CONFLICT(genre_id) DO UPDATE SET
      name=excluded.name, category=excluded.category, tone=excluded.tone, keywords=excluded.keywords,
      positioning=excluded.positioning, hook=excluded.hook, description=excluded.description,
      framework_intro=excluded.framework_intro, skill_prompt=excluded.skill_prompt,
      options=excluded.options, source=excluded.source, updated_at=excluded.updated_at`,
    id, genreId, name,
    TEXT(genre.category, 40), TEXT(genre.tone, 60),
    JSON.stringify(Array.isArray(genre.keywords) ? genre.keywords.slice(0, 30) : []),
    MULTI(genre.positioning, 2000), TEXT(genre.hook, 500), MULTI(genre.description, 1000),
    MULTI(genre.frameworkIntro, 20000), MULTI(genre.skillPrompt, 20000),
    JSON.stringify(genre.options && typeof genre.options === 'object' ? genre.options : {}),
    TEXT(source, 20) || 'generator', now, now,
  );
  return getGenreHistory(id);
}

export function markGenreHistoryUsed(id) {
  ensureGenreHistorySchema();
  const row = get('SELECT id FROM genre_generator_history WHERE id = ?', id);
  if (!row) return null;
  run('UPDATE genre_generator_history SET used_count = used_count + 1, updated_at = ? WHERE id = ?', nowISO(), id);
  return getGenreHistory(id);
}

export function deleteGenreHistory(id) {
  ensureGenreHistorySchema();
  const row = get('SELECT id FROM genre_generator_history WHERE id = ?', id);
  if (!row) return { ok: false, removed: 0 };
  run('DELETE FROM genre_generator_history WHERE id = ?', id);
  return { ok: true, removed: 1 };
}

export function clearGenreHistory() {
  ensureGenreHistorySchema();
  const count = get('SELECT COUNT(*) AS c FROM genre_generator_history').c || 0;
  run('DELETE FROM genre_generator_history');
  return { ok: true, removed: count };
}
