// 小说工坊 · 题材生成器（plain text module）
//
// 用途：不依赖 100 种系统题材，按用户选择的「世界背景 × 主角设定 × 核心冲突 ×
// 基调 × 节奏 × 受众 × 关键词」组合，生成一个自定义题材（含定位、关键词、世界规则、
// 主角公式、爆款钩子、持续循环危机、续集发动机），并产出可写入「故事框架介绍」的
// 7 模块框架与对应写作技能提示词。
//
// 设计约束：
//   - 确定性组合，不调用 LLM、不产生费用、离线可用（与「AI 头脑风暴」互补）。
//   - 生成结果只做提案，不写数据库；由前端确认后随表单保存。

import { buildGenreCreativeBlueprint, buildGenreSkillPrompt } from './genre-frameworks.js';
import { frameworkIntroFromBlueprint } from './novel-brainstorm.js';

const TEXT = (v, max = 200) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export const GENRE_GENERATOR_OPTIONS = Object.freeze({
  worlds: [
    { id: 'modern', label: '现代都市', tags: ['都市', '现实规则'] },
    { id: 'ancient', label: '古代王朝', tags: ['历史', '权谋'] },
    { id: 'future', label: '未来科幻', tags: ['科幻', '高科技'] },
    { id: 'wasteland', label: '末世废土', tags: ['末日', '生存'] },
    { id: 'xianxia', label: '玄幻修真', tags: ['玄幻', '境界'] },
    { id: 'magic', label: '剑与魔法', tags: ['奇幻', '魔法'] },
    { id: 'campus', label: '校园青春', tags: ['校园', '成长'] },
    { id: 'workplace', label: '职场商战', tags: ['职场', '权谋'] },
    { id: 'supernatural', label: '民俗灵异', tags: ['灵异', '禁忌'] },
    { id: 'virtual', label: '虚拟世界', tags: ['游戏', '系统'] },
  ],
  protagonists: [
    { id: 'reborn', label: '重生归来', tags: ['重生', '先知'] },
    { id: 'hidden', label: '隐世强者', tags: ['隐藏身份', '扮猪吃虎'] },
    { id: 'awaken', label: '觉醒者', tags: ['觉醒', '特殊能力'] },
    { id: 'ordinary', label: '普通人逆袭', tags: ['小人物', '逆袭'] },
    { id: 'female', label: '女性成长', tags: ['女性向', '成长'] },
    { id: 'genius', label: '天才/专家', tags: ['专业', '高智商'] },
    { id: 'group', label: '群像主角', tags: ['群像', '多主角'] },
    { id: 'creature', label: '非人视角', tags: ['异类', '另类设定'] },
  ],
  conflicts: [
    { id: 'revenge', label: '复仇逆袭', tags: ['复仇', '爽点'] },
    { id: 'mystery', label: '悬疑追凶', tags: ['悬疑', '推理'] },
    { id: 'romance', label: '甜宠虐恋', tags: ['言情', '情感'] },
    { id: 'rise', label: '经营崛起', tags: ['经营', '成长'] },
    { id: 'horror', label: '规则怪谈', tags: ['怪谈', '恐怖'] },
    { id: 'war', label: '战争热血', tags: ['热血', '战斗'] },
    { id: 'heal', label: '治愈日常', tags: ['治愈', '温情'] },
    { id: 'conspiracy', label: '阴谋博弈', tags: ['权谋', '反转'] },
  ],
  paces: [
    { id: 'fast', label: '快节奏爽文', tags: ['快节奏', '强爽点'] },
    { id: 'slow', label: '慢热沉浸', tags: ['慢热', '沉浸'] },
    { id: 'twist', label: '强反转', tags: ['反转', '烧脑'] },
    { id: 'epic', label: '史诗厚重', tags: ['史诗', '宏大'] },
  ],
  audiences: [
    { id: 'male', label: '男频', tags: ['男频'] },
    { id: 'female', label: '女频', tags: ['女频'] },
    { id: 'all', label: '全年龄', tags: ['全年龄'] },
  ],
});

function hash(text) {
  let value = 0;
  for (const ch of String(text || '')) value = (value * 31 + ch.charCodeAt(0)) >>> 0;
  return value;
}

function findOption(list, id) {
  return list.find((x) => x.id === id) || null;
}

function slug(text) {
  const raw = String(text || '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return raw || 'concept';
}

/**
 * 生成一个自定义题材提案。
 * input: { name, world, protagonist, conflict, pace, audience, tone, keyword, category, targetWords }
 */
export function generateCustomGenre(input = {}) {
  const worlds = GENRE_GENERATOR_OPTIONS.worlds;
  const protagonists = GENRE_GENERATOR_OPTIONS.protagonists;
  const conflicts = GENRE_GENERATOR_OPTIONS.conflicts;
  const paces = GENRE_GENERATOR_OPTIONS.paces;
  const audiences = GENRE_GENERATOR_OPTIONS.audiences;

  const world = findOption(worlds, input.world) || worlds[0];
  const protagonist = findOption(protagonists, input.protagonist) || protagonists[0];
  const conflict = findOption(conflicts, input.conflict) || conflicts[0];
  const pace = findOption(paces, input.pace) || paces[0];
  const audience = findOption(audiences, input.audience) || audiences[2];
  const keyword = TEXT(input.keyword, 60);

  const generatedName = TEXT(input.name, 24) || `${world.label}·${protagonist.label}·${conflict.label}`;
  const tags = [...new Set([
    world.label, protagonist.label, conflict.label, pace.label, audience.label,
    ...world.tags, ...protagonist.tags, ...conflict.tags, ...pace.tags,
    ...(keyword ? keyword.split(/[\s,，、]+/).filter(Boolean) : []),
  ])].slice(0, 12);

  const genreId = `custom-${slug(input.category || world.id)}-${hash(generatedName + tags.join(',')) % 100000}`;
  const tone = TEXT(input.tone, 30) || pace.label;
  const pseudoGenre = {
    id: genreId,
    name: generatedName,
    cat: TEXT(input.category, 20) || world.label,
    tone,
    tags,
    hook: `${protagonist.label}在${world.label}中遭遇${conflict.label}，开局即抛强钩子`,
    desc: `${world.label} × ${protagonist.label} × ${conflict.label}（${pace.label}，面向${audience.label}）`,
  };

  const blueprint = buildGenreCreativeBlueprint(pseudoGenre);
  const targetWords = Math.max(10000, Number(input.targetWords) || 1000000);
  const frameworkIntro = frameworkIntroFromBlueprint(blueprint, {
    title: TEXT(input.title, 24) || `${generatedName}·未命名`,
    tone,
    targetWords,
  });
  const skillPrompt = buildGenreSkillPrompt(pseudoGenre).skillPrompt;

  return {
    ok: true,
    generated: true,
    genreId,
    name: generatedName,
    category: pseudoGenre.cat,
    positioning: blueprint.creativePositioning,
    keywords: tags,
    tone,
    description: pseudoGenre.desc,
    hook: pseudoGenre.hook,
    worldStyle: blueprint.worldStyle,
    worldRules: blueprint.worldRules,
    coreLoopCrisis: blueprint.coreLoopCrisis,
    ultimateMystery: blueprint.ultimateMystery,
    protagonistFormula: blueprint.protagonistFormula,
    protagonistSpecial: blueprint.protagonistSpecial,
    openingFormula: blueprint.openingFormula,
    endingDirection: blueprint.endingDirection,
    hitHooks: blueprint.hitHooks,
    sequelEngine: blueprint.sequelEngine,
    frameworkIntro,
    skillPrompt,
    blueprint,
    options: {
      world: world.id, protagonist: protagonist.id, conflict: conflict.id,
      pace: pace.id, audience: audience.id, keyword,
    },
    warnings: ['题材生成器为规则组合生成：不联网、不消耗额度。需要更强的创意可改用「AI 头脑风暴创意题材规划」。'],
  };
}
