// 小说工坊 · 通用创作选项
// 100 种基调、标题自动选题材、AI 自动视角/角色规模设置。

import { GENRES, genreById } from './data/genres.js';
import { chatJSON, llmStatus } from './llm.js';
import { get, run } from './db.js';
import { nowISO } from './util.js';

const TEXT = (v, max = 300) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const STYLE_WORDS = ['热血', '爽文', '悬疑', '暗黑', '温情', '史诗', '冷峻', '浪漫', '轻松', '烧脑'];
const RHYTHM_WORDS = ['快节奏', '慢热', '强反转', '高燃', '压抑', '治愈', '群像', '权谋', '宿命感', '电影感'];

export const CREATIVE_TONES = Object.freeze(
  STYLE_WORDS.flatMap((style) => RHYTHM_WORDS.map((rhythm) => `${style}${rhythm}`)).slice(0, 100),
);

export function listCreativeOptions() {
  return {
    ok: true,
    tones: [...CREATIVE_TONES],
    genreCount: GENRES.length,
    autoOptions: {
      pov: true,
      castSize: true,
      unlimitedCharacters: true,
    },
  };
}

function safeJson(v, fallback) {
  try {
    const out = JSON.parse(v || '');
    return out == null ? fallback : out;
  } catch { return fallback; }
}

export function getNovelCreativeOptions(novelId) {
  const novel = get('SELECT * FROM novels WHERE id = ?', novelId);
  if (!novel) throw new Error('小说不存在');
  const meta = safeJson(novel.meta, {});
  return {
    ok: true,
    novelId,
    titleDescription: TEXT(meta.titleDescription, 500),
    autoPov: Boolean(meta.autoPov),
    autoCast: Boolean(meta.autoCast),
    unlimitedCharacters: Boolean(meta.unlimitedCharacters),
  };
}

export function updateNovelCreativeOptions(novelId, patch = {}) {
  const novel = get('SELECT * FROM novels WHERE id = ?', novelId);
  if (!novel) throw new Error('小说不存在');
  const meta = safeJson(novel.meta, {});
  meta.titleDescription = TEXT(patch.titleDescription, 500);
  meta.autoPov = Boolean(patch.autoPov);
  meta.autoCast = Boolean(patch.autoCast);
  meta.unlimitedCharacters = Boolean(patch.unlimitedCharacters);
  meta.creativeOptionsUpdatedAt = nowISO();
  run('UPDATE novels SET meta = ?, updated_at = ? WHERE id = ?', JSON.stringify(meta), nowISO(), novelId);
  return getNovelCreativeOptions(novelId);
}

function scoreGenre(genre, title, description, tone) {
  const hay = `${title} ${description}`.toLowerCase();
  let score = 0;
  const name = String(genre.name || '').toLowerCase();
  if (title && name.includes(title.toLowerCase())) score += 20;
  if (title && title.toLowerCase().includes(name)) score += 16;
  for (const tag of genre.tags || []) {
    if (tag && hay.includes(String(tag).toLowerCase())) score += 8;
  }
  for (const word of String(genre.keywords || '').split(/\s+/)) {
    if (word && hay.includes(word.toLowerCase())) score += 3;
  }
  const hook = String(genre.hook || '').toLowerCase();
  for (const part of hook.split(/[，。！？、；：\s]+/).filter((x) => x.length >= 2)) {
    if (hay.includes(part)) score += 5;
  }
  if (tone && genre.tone === tone) score += 4;
  return score;
}

export async function planGenreFromTitle({ title = '', titleDescription = '', tone = '' } = {}) {
  const cleanTitle = TEXT(title, 80);
  const desc = TEXT(titleDescription, 300);
  const ranked = GENRES
    .map((genre) => ({ genre, score: scoreGenre(genre, cleanTitle, desc, tone) }))
    .sort((a, b) => b.score - a.score || a.genre.name.localeCompare(b.genre.name, 'zh-CN'));
  const best = ranked[0]?.genre || GENRES[0];
  const status = llmStatus();
  let mocked = true;
  let reason = ranked[0]?.score
    ? `标题和描述命中「${(best.tags || []).join('、')}」等题材关键词。`
    : '标题信息不足，按基调和默认题材优先级选择。';
  let selected = best;

  if (status?.provider !== 'mock' && (cleanTitle || desc)) {
    try {
      const candidates = ranked.slice(0, 20).map((x) => `${x.genre.id}=${x.genre.name}（${(x.genre.tags || []).join('、')}）`).join('\n');
      const out = await chatJSON({
        system: '你是网文和漫剧选题策划，只能从给定题材列表中选择最适合的题材。只输出 JSON。',
        prompt: [
          `标题：${cleanTitle || '未命名'}`,
          `标题描述：${desc || '无'}`,
          `基调：${tone || '未定'}`,
          '候选题材：',
          candidates,
          '输出：{"genreId":"", "confidence":0-1, "reason":"中文原因"}',
        ].join('\n'),
        temperature: 0.2,
        maxTokens: 800,
      });
      const chosen = genreById(TEXT(out?.data?.genreId, 80));
      if (chosen) {
        selected = chosen;
        reason = TEXT(out?.data?.reason, 200) || reason;
        mocked = false;
      }
    } catch { /* 保留本地评分结果 */ }
  }

  return {
    ok: true,
    mocked,
    genreId: selected.id,
    genreName: selected.name,
    category: selected.cat,
    confidence: selected.id === best.id && ranked[0]?.score ? 0.9 : (selected.id === best.id ? 0.62 : 0.75),
    reason,
    alternatives: ranked.slice(0, 3).map((x) => ({ genreId: x.genre.id, genreName: x.genre.name, score: x.score })),
  };
}
