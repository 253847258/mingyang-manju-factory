// 小说工坊 · AI 配置与角色归档（稳定数据层）
// 所有 AI 自动化配置使用独立表原子读写；novels.meta 仅保留旧数据兼容。

import { all, get, run } from './db.js';
import { nowISO } from './util.js';

let schemaReady = false;

const TEXT = (v, max = 500) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const nameKeyOf = (name) => TEXT(name, 80).toLowerCase().replace(/\s+/g, '');
const safeJson = (v, fallback) => {
  try {
    const out = JSON.parse(v || '');
    return out == null ? fallback : out;
  } catch { return fallback; }
};

export function ensureNovelSettingsSchema() {
  if (schemaReady) return;
  run(`CREATE TABLE IF NOT EXISTS novel_ai_settings (
    novel_id TEXT PRIMARY KEY,
    title_description TEXT NOT NULL DEFAULT '',
    auto_pov INTEGER NOT NULL DEFAULT 0,
    auto_cast INTEGER NOT NULL DEFAULT 0,
    unlimited_characters INTEGER NOT NULL DEFAULT 0,
    character_free_enabled INTEGER NOT NULL DEFAULT 1,
    max_characters INTEGER NOT NULL DEFAULT 20,
    style_policy TEXT NOT NULL DEFAULT 'plot-driven',
    auto_create INTEGER NOT NULL DEFAULT 1,
    genre_mode TEXT NOT NULL DEFAULT 'system',
    custom_genre TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  )`);
  ensureColumn('novel_ai_settings', 'genre_mode', "genre_mode TEXT NOT NULL DEFAULT 'system'");
  ensureColumn('novel_ai_settings', 'custom_genre', "custom_genre TEXT NOT NULL DEFAULT ''");
  run(`CREATE TABLE IF NOT EXISTS novel_character_links (
    novel_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    name_key TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    first_appearance TEXT NOT NULL DEFAULT '',
    storyline_role TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (novel_id, actor_id),
    UNIQUE (novel_id, name_key)
  )`);
  run('CREATE INDEX IF NOT EXISTS idx_novel_character_links_novel ON novel_character_links(novel_id, name_key)');
  schemaReady = true;
}

function ensureColumn(table, column, ddl) {
  const cols = all(`PRAGMA table_info(${table})`);
  if (!cols.some((c) => c.name === column)) run(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

function novelOf(novelId) {
  const novel = get('SELECT * FROM novels WHERE id = ?', novelId);
  if (!novel) throw new Error('小说不存在');
  return novel;
}

function defaultsFromMeta(novel) {
  const meta = safeJson(novel.meta, {});
  const free = meta.characterFreeMode || {};
  return {
    novelId: novel.id,
    titleDescription: TEXT(meta.titleDescription, 500),
    autoPov: Boolean(meta.autoPov),
    autoCast: Boolean(meta.autoCast),
    unlimitedCharacters: Boolean(meta.unlimitedCharacters),
    characterFreeEnabled: free.enabled !== false,
    maxCharacters: Math.max(1, Math.min(200, Number(free.maxCharacters) || Number(novel.cast_size) || 20)),
    stylePolicy: TEXT(free.stylePolicy, 40) || 'plot-driven',
    autoCreate: free.autoCreate !== false,
    genreMode: normalizeGenreMode(meta.genreMode),
    customGenre: meta.customGenre && typeof meta.customGenre === 'object' ? meta.customGenre : null,
  };
}

export function normalizeGenreMode(value) {
  const mode = TEXT(value, 20).toLowerCase();
  return ['system', 'generator', 'brainstorm', 'off'].includes(mode) ? mode : 'system';
}

export function getNovelAiSettings(novelId) {
  ensureNovelSettingsSchema();
  const novel = novelOf(novelId);
  let row = get('SELECT * FROM novel_ai_settings WHERE novel_id = ?', novelId);
  if (!row) {
    const d = defaultsFromMeta(novel);
    const now = nowISO();
    run(
      `INSERT OR IGNORE INTO novel_ai_settings(
        novel_id, title_description, auto_pov, auto_cast, unlimited_characters,
        character_free_enabled, max_characters, style_policy, auto_create, genre_mode, custom_genre, updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      d.novelId, d.titleDescription, d.autoPov ? 1 : 0, d.autoCast ? 1 : 0,
      d.unlimitedCharacters ? 1 : 0, d.characterFreeEnabled ? 1 : 0,
      d.maxCharacters, d.stylePolicy, d.autoCreate ? 1 : 0,
      d.genreMode, d.customGenre ? JSON.stringify(d.customGenre) : '', now,
    );
    row = get('SELECT * FROM novel_ai_settings WHERE novel_id = ?', novelId);
  }
  return {
    ok: true,
    novelId,
    titleDescription: row.title_description || '',
    autoPov: Boolean(row.auto_pov),
    autoCast: Boolean(row.auto_cast),
    unlimitedCharacters: Boolean(row.unlimited_characters),
    characterFreeEnabled: Boolean(row.character_free_enabled),
    maxCharacters: Number(row.max_characters) || 20,
    stylePolicy: row.style_policy || 'plot-driven',
    autoCreate: Boolean(row.auto_create),
    genreMode: normalizeGenreMode(row.genre_mode),
    customGenre: safeJson(row.custom_genre, null),
    updatedAt: row.updated_at || '',
  };
}

export function updateNovelAiSettings(novelId, patch = {}) {
  ensureNovelSettingsSchema();
  novelOf(novelId);
  getNovelAiSettings(novelId);
  const map = {
    titleDescription: 'title_description',
    autoPov: 'auto_pov',
    autoCast: 'auto_cast',
    unlimitedCharacters: 'unlimited_characters',
    characterFreeEnabled: 'character_free_enabled',
    maxCharacters: 'max_characters',
    stylePolicy: 'style_policy',
    autoCreate: 'auto_create',
    genreMode: 'genre_mode',
    customGenre: 'custom_genre',
  };
  const sets = [];
  const args = [];
  for (const [key, column] of Object.entries(map)) {
    if (!(key in patch)) continue;
    let value = patch[key];
    if (typeof value === 'boolean') value = value ? 1 : 0;
    if (key === 'maxCharacters') value = Math.max(1, Math.min(200, Number(value) || 20));
    if (key === 'titleDescription') value = TEXT(value, 500);
    if (key === 'stylePolicy') value = TEXT(value, 40) || 'plot-driven';
    if (key === 'genreMode') value = normalizeGenreMode(value);
    if (key === 'customGenre') value = value && typeof value === 'object' ? JSON.stringify(value) : '';
    sets.push(`${column} = ?`);
    args.push(value);
  }
  if (!sets.length) return getNovelAiSettings(novelId);
  sets.push('updated_at = ?');
  args.push(nowISO(), novelId);
  run(`UPDATE novel_ai_settings SET ${sets.join(', ')} WHERE novel_id = ?`, ...args);
  return getNovelAiSettings(novelId);
}

export function archiveCharacterLink(novelId, actor, details = {}) {
  ensureNovelSettingsSchema();
  if (!novelId || !actor?.id || !actor?.name) return null;
  const now = nowISO();
  const key = nameKeyOf(actor.name);
  const existing = get('SELECT actor_id FROM novel_character_links WHERE novel_id = ? AND name_key = ?', novelId, key);
  const actorId = existing?.actor_id || actor.id;
  run(
    `INSERT INTO novel_character_links(
      novel_id, actor_id, name_key, source, reason, first_appearance, storyline_role, created_at, updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(novel_id, actor_id) DO UPDATE SET
      source=excluded.source,
      reason=excluded.reason,
      first_appearance=excluded.first_appearance,
      storyline_role=excluded.storyline_role,
      updated_at=excluded.updated_at`,
    novelId, actorId, key, TEXT(details.source, 100), TEXT(details.reason, 500),
    TEXT(details.firstAppearance, 120), TEXT(details.storylineRole, 500), now, now,
  );
  return get('SELECT * FROM novel_character_links WHERE novel_id = ? AND actor_id = ?', novelId, actorId);
}

export function listNovelCharacterArchive(novelId) {
  ensureNovelSettingsSchema();
  novelOf(novelId);
  const characters = all(`SELECT l.*, a.name, a.role_type, a.cover_image
    FROM novel_character_links l
    LEFT JOIN actors a ON a.id = l.actor_id
    WHERE l.novel_id = ?
    ORDER BY l.rowid`, novelId);
  return {
    ok: true,
    novelId,
    characters,
  };
}

export function findArchivedActorByNovelName(novelId, name) {
  ensureNovelSettingsSchema();
  return get(
    'SELECT actor_id FROM novel_character_links WHERE novel_id = ? AND name_key = ?',
    novelId, nameKeyOf(name),
  );
}

export function listCharacterLinks(novelId) {
  ensureNovelSettingsSchema();
  return {
    ok: true,
    novelId,
    links: all('SELECT * FROM novel_character_links WHERE novel_id = ? ORDER BY rowid', novelId),
  };
}
