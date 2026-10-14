// 小说工坊 · 题材生成器历史（plain text module）
// 存储题材生成器 / AI 头脑风暴产出的题材方案，支持列表、复用、删除。
// 约定：同一 genreId 只保留一条（再次生成则覆盖更新）；列表按 rowid 排序（不依赖 created_at）。
import { all, get, run } from './db.js';
import { nowISO, rid } from './util.js';

let schemaReady = false;

// 历史保留上限：超出后按 rowid 从旧到新清理（配合 save 自动执行）。
export const GENRE_HISTORY_MAX = 100;

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
  ensureColumn('genre_generator_history', 'title', "title TEXT NOT NULL DEFAULT ''");
  ensureColumn('genre_generator_history', 'title_description', "title_description TEXT NOT NULL DEFAULT ''");
  ensureColumn('genre_generator_history', 'pov', "pov TEXT NOT NULL DEFAULT ''");
  ensureColumn('genre_generator_history', 'cast_size', 'cast_size INTEGER');
  ensureColumn('genre_generator_history', 'seasons', 'seasons INTEGER');
  ensureColumn('genre_generator_history', 'target_words', 'target_words INTEGER');
  schemaReady = true;
}

function ensureColumn(table, column, ddl) {
  const cols = all(`PRAGMA table_info(${table})`);
  if (!cols.some((c) => c.name === column)) run(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
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
    title: row.title || '',
    titleDescription: row.title_description || '',
    pov: row.pov || '',
    castSize: row.cast_size == null ? null : Number(row.cast_size),
    seasons: row.seasons == null ? null : Number(row.seasons),
    targetWords: row.target_words == null ? null : Number(row.target_words),
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
      framework_intro, skill_prompt, options, source, used_count,
      title, title_description, pov, cast_size, seasons, target_words, created_at, updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,?)
    ON CONFLICT(genre_id) DO UPDATE SET
      name=excluded.name, category=excluded.category, tone=excluded.tone, keywords=excluded.keywords,
      positioning=excluded.positioning, hook=excluded.hook, description=excluded.description,
      framework_intro=excluded.framework_intro, skill_prompt=excluded.skill_prompt,
      options=excluded.options, source=excluded.source,
      title=excluded.title, title_description=excluded.title_description, pov=excluded.pov,
      cast_size=excluded.cast_size, seasons=excluded.seasons, target_words=excluded.target_words,
      updated_at=excluded.updated_at`,
    id, genreId, name,
    TEXT(genre.category, 40), TEXT(genre.tone, 60),
    JSON.stringify(Array.isArray(genre.keywords) ? genre.keywords.slice(0, 30) : []),
    MULTI(genre.positioning, 2000), TEXT(genre.hook, 500), MULTI(genre.description, 1000),
    MULTI(genre.frameworkIntro, 20000), MULTI(genre.skillPrompt, 20000),
    JSON.stringify(genre.options && typeof genre.options === 'object' ? genre.options : {}),
    TEXT(source, 20) || 'generator',
    TEXT(genre.title, 60), TEXT(genre.titleDescription, 300), TEXT(genre.pov, 60),
    Number.isFinite(Number(genre.castSize)) ? Number(genre.castSize) : null,
    Number.isFinite(Number(genre.seasons)) ? Number(genre.seasons) : null,
    Number.isFinite(Number(genre.targetWords)) ? Number(genre.targetWords) : null,
    now, now,
  );
  pruneGenreHistory();
  return getGenreHistory(id);
}

// 只保留最近 N 条（默认 100），按 rowid 从旧到新删除。
export function pruneGenreHistory(max = GENRE_HISTORY_MAX) {
  ensureGenreHistorySchema();
  const keep = Math.max(1, Number(max) || GENRE_HISTORY_MAX);
  const rows = all('SELECT id FROM genre_generator_history ORDER BY rowid DESC');
  const stale = rows.slice(keep);
  for (const row of stale) run('DELETE FROM genre_generator_history WHERE id = ?', row.id);
  return { ok: true, removed: stale.length, kept: Math.min(rows.length, keep) };
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
