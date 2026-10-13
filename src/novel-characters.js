// 小说工坊 · 角色自由模式
// 根据剧情自动发现、补全并归档角色，角色卡仍使用演员矩阵 C-xxxx，同时绑定到当前小说。

import { get } from './db.js';
import { chatJSON, llmStatus } from './llm.js';
import { commitCharacters, AI_MAX_CAST } from './novel-ai.js';
import { buildNovelAssets } from './novel-assets.js';
import { getNovelAiSettings, updateNovelAiSettings, archiveCharacterLink } from './novel-settings.js';

const TEXT = (v, max = 300) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const safeJson = (v, fallback) => {
  try {
    const out = JSON.parse(v || '');
    return out == null ? fallback : out;
  } catch { return fallback; }
};

export const CHARACTER_FREE_DEFAULTS = Object.freeze({
  enabled: true,
  maxCharacters: 20,
  stylePolicy: 'plot-driven',
  autoCreate: true,
});

function novelOf(novelId) {
  const novel = get('SELECT * FROM novels WHERE id = ?', novelId);
  if (!novel) throw new Error('小说不存在');
  return novel;
}

function currentCharacterCount(novel) {
  const actorIds = safeJson(novel.actor_ids, []).filter(Boolean);
  const custom = safeJson(novel.custom_actors, []).filter((x) => x?.name);
  return actorIds.length + custom.length;
}

export function characterFreeMode(novelId) {
  const novel = novelOf(novelId);
  const settings = getNovelAiSettings(novelId);
  const mode = {
    enabled: settings.characterFreeEnabled,
    maxCharacters: settings.maxCharacters,
    stylePolicy: settings.stylePolicy,
    autoCreate: settings.autoCreate,
  };
  const current = currentCharacterCount(novel);
  const castSize = Math.max(1, Math.min(AI_MAX_CAST, Number(novel.cast_size) || CHARACTER_FREE_DEFAULTS.maxCharacters));
  return {
    ok: true,
    novelId,
    ...mode,
    maxCharacters: Math.max(1, Math.min(castSize, Number(mode.maxCharacters) || castSize)),
    castSize,
    currentCharacters: current,
    availableCharacters: Math.max(0, castSize - current),
  };
}

export function updateCharacterFreeMode(novelId, patch = {}) {
  const novel = novelOf(novelId);
  const previous = characterFreeMode(novelId);
  const castSize = Math.max(1, Math.min(AI_MAX_CAST, Number(novel.cast_size) || 20));
  const maxCharacters = Math.max(1, Math.min(castSize, Number(patch.maxCharacters) || previous.maxCharacters || castSize));
  const stylePolicy = ['plot-driven', 'cinematic-real', 'guoman-real', 'anime', 'ink'].includes(String(patch.stylePolicy))
    ? String(patch.stylePolicy)
    : previous.stylePolicy;
  updateNovelAiSettings(novelId, {
    characterFreeEnabled: patch.enabled === undefined ? previous.enabled : Boolean(patch.enabled),
    maxCharacters,
    stylePolicy,
    autoCreate: patch.autoCreate === undefined ? previous.autoCreate : Boolean(patch.autoCreate),
  });
  return characterFreeMode(novelId);
}

function outlineOf(novelId) {
  const row = get('SELECT payload FROM novel_outlines WHERE novel_id = ? ORDER BY version DESC LIMIT 1', novelId);
  return row ? safeJson(row.payload, {}) : {};
}

function buildPrompt(novel, sections, assets, mode, instruction = '') {
  const existing = [
    ...assets.characters.map((x) => `${x.id} ${x.name}（${x.role || '角色'}）`),
  ].join('\n') || '无';
  const chapterDigest = (Array.isArray(sections.chapters) ? sections.chapters : [])
    .filter((x) => !x?._placeholder)
    .slice(0, 80)
    .map((x) => `第${x.idx}章《${x.title}》：${TEXT(x.summary, 180)}｜章首：${TEXT(x.start_state, 100)}｜章末：${TEXT(x.end_state, 100)}`)
    .join('\n') || '（暂无章节大纲）';
  return [
    '【任务】',
    `根据剧情需要发现当前小说还缺少的角色，最多新增 ${mode.maxCharacters} 个；宁缺毋滥，已有角色能承担的功能不要重复建卡。`,
    `角色规模上限：${mode.castSize}；当前已有 ${mode.currentCharacters} 个；最多还能添加 ${mode.availableCharacters} 个。`,
    `风格策略：${mode.stylePolicy}。角色外观、服装、年龄和气质必须服务于剧情身份、时代、题材和基调。`,
    '',
    '【小说参数】',
    `书名：${novel.title || ''}`,
    `题材：${novel.genre || ''}　基调：${novel.tone || ''}　视角：${novel.pov || ''}`,
    `框架：${novel.framework_intro || ''}`,
    `故事线：${JSON.stringify(sections.storyline || {})}`,
    '',
    '【已有角色 ID（不得重名、不得重复建卡）】',
    existing,
    '',
    '【章节剧情与章首章末】',
    chapterDigest,
    instruction ? `\n【额外要求】\n${TEXT(instruction, 600)}` : '',
    '',
    '只输出 JSON：',
    '{"characters":[{"name":"","role":"主角/反派/配角/导师/对手/关键NPC","gender":"男/女/未知","age":"","appearance":"详细外观","personality":"性格与行为逻辑","costume":"服装与标志物","background":"背景经历","reason":"为什么剧情必须新增此角色","firstAppearance":"首次出场章节/事件","storylineRole":"对主线和头尾逻辑的作用","styleHint":"绘画风格建议"}],"warnings":[]}',
    '硬约束：只推荐真正推进剧情、制造冲突、补全关系或承担关键信息的角色；描述必须具体；不要输出解释。',
  ].filter(Boolean).join('\n');
}

export async function discoverPlotCharacters(novelId, { instruction = '' } = {}) {
  const novel = novelOf(novelId);
  const mode = characterFreeMode(novelId);
  if (mode.availableCharacters <= 0) {
    return { ok: true, mocked: false, characters: [], warnings: ['当前角色数已达到角色规模上限，未新增角色。'] };
  }
  const sections = outlineOf(novelId);
  const assets = buildNovelAssets(novel, sections);
  const status = llmStatus();
  if (status?.provider === 'mock') {
    return {
      ok: true,
      mocked: true,
      characters: [],
      warnings: ['当前 LLM 为 mock，角色自由模式只做规划预览，不自动创建角色卡。'],
    };
  }
  const out = await chatJSON({
    system: '你是网文和漫剧的角色统筹，负责按剧情缺口新增角色并避免重复建卡。只输出 JSON。',
    prompt: buildPrompt(novel, sections, assets, mode, instruction),
    temperature: 0.72,
    maxTokens: 6000,
  });
  const raw = out?.data && typeof out.data === 'object' ? out.data : {};
  const existingNames = new Set(assets.characters.map((x) => TEXT(x.name, 40).toLowerCase()));
  const characters = [];
  for (const item of (Array.isArray(raw.characters) ? raw.characters : [])) {
    const name = TEXT(item?.name, 40);
    const key = name.toLowerCase();
    if (!name || existingNames.has(key)) continue;
    existingNames.add(key);
    characters.push({
      name,
      role: TEXT(item.role, 40),
      gender: TEXT(item.gender, 10),
      age: TEXT(item.age, 20),
      appearance: TEXT(item.appearance, 500),
      personality: TEXT(item.personality, 500),
      costume: TEXT(item.costume, 500),
      background: TEXT(item.background, 600),
      reason: TEXT(item.reason, 500),
      firstAppearance: TEXT(item.firstAppearance, 120),
      storylineRole: TEXT(item.storylineRole, 500),
      styleHint: TEXT(item.styleHint, 120),
    });
    if (characters.length >= mode.maxCharacters || characters.length >= mode.availableCharacters) break;
  }
  return {
    ok: true,
    mocked: false,
    characters,
    warnings: Array.isArray(raw.warnings) ? raw.warnings.map((x) => TEXT(x, 200)).filter(Boolean) : [],
    mode,
  };
}

export async function autoArchivePlotCharacters(novelId, { apply = true, instruction = '' } = {}) {
  const proposal = await discoverPlotCharacters(novelId, { instruction });
  if (!apply || !proposal.characters.length) {
    return { ...proposal, created: [], failed: [], archived: [] };
  }
  const created = [];
  const failed = [];
  const warnings = [...(proposal.warnings || [])];
  for (let i = 0; i < proposal.characters.length; i += 8) {
    const chunk = proposal.characters.slice(i, i + 8);
    const result = await commitCharacters({
      novelId,
      characters: chunk,
      bindToNovel: true,
      tags: ['角色自由模式', `novel:${novelId}`],
      styleId: 'cinematic-real',
    });
    created.push(...(result.created || []));
    failed.push(...(result.failed || []));
    warnings.push(...(result.warnings || []));
  }
  const byName = new Map(proposal.characters.map((x) => [x.name.toLowerCase(), x]));
  for (const item of created) {
    const detail = byName.get(String(item.name || '').toLowerCase()) || {};
    archiveCharacterLink(novelId, { id: item.actorId, name: item.name }, {
      source: '角色自由模式',
      reason: detail.reason,
      firstAppearance: detail.firstAppearance,
      storylineRole: detail.storylineRole,
    });
  }
  const mode = characterFreeMode(novelId);
  return {
    ...proposal,
    created,
    failed,
    warnings: [...new Set(warnings)],
    archived: created.filter((x) => x.actorId).map((x) => ({ name: x.name, actorId: x.actorId, novelId })),
    mode,
  };
}
