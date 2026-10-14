// 小说工坊 · AI 头脑风暴创意题材规划（plain text module）
//
// 用途：当作者没有从 100 种题材里选定时，让 AI 根据标题/描述/基调，
// 自动推荐一个更容易出爆款、且能无限发展续集的题材，并给出可直接使用的
// 故事框架介绍、推荐视角、推荐角色规模与字数规模。
//
// 设计约束：
//   - LLM 是质量增强路径；provider=mock 时用确定性模板，保证离线可用。
//   - 全部输出中文，只做提案，不写数据库。

import { GENRES, genreById } from './data/genres.js';
import { POVS } from './data/dictionaries.js';
import { chatJSON, llmStatus } from './llm.js';
import { buildGenreCreativeBlueprint, buildGenreSkillPrompt } from './genre-frameworks.js';
import { scalePlanOf } from './novel-ai.js';

const TEXT = (v, max = 400) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function hash(text) {
  let value = 0;
  for (const ch of String(text || '')) value = (value * 31 + ch.charCodeAt(0)) >>> 0;
  return value;
}

const POV_OPTIONS = (Array.isArray(POVS) && POVS.length)
  ? POVS.map((p) => ({ id: p.id, name: p.name }))
  : [{ id: 'third-limited', name: '第三人称限知（跟随主角）' }];

function povName(id, fallback = '第三人称限知（跟随主角）') {
  const found = POV_OPTIONS.find((p) => p.id === id || p.name === id);
  return found?.name || fallback;
}

function frameworkIntroFromBlueprint(b, { title = '', tone = '', targetWords = 1000000 } = {}) {
  const scale = scalePlanOf({ targetWords });
  const name = title || `${b.genreName}·未命名`;
  const tag = '【AI 创意规划】';
  const lines = [
    `${tag}《${name}》${b.genreName} · ${tone || b.tone || '题材默认基调'} · ${scale.band}`,
    '',
    '## 模块 1｜世界观体系',
    `【世界风格】${b.worldStyle}`,
    `【基础背景与开放区域】以${b.category}世界为舞台，核心区域先行开放，同时预留大量未开放区域作为后续新地图。`,
    `【底层规则体系】${b.worldRules}`,
    `【势力分层】${b.factionLayers}`,
    `【持续循环危机】${b.coreLoopCrisis}`,
    `【终极世界谜团】${b.ultimateMystery}`,
    '',
    '## 模块 2｜人物矩阵',
    `【主角是谁】${b.protagonistFormula}`,
    `【主角特别之处】${b.protagonistSpecial}`,
    `【主角成长与代价】主角分阶段解锁能力，每阶段附带代价与短板，人物弧光围绕复仇/真相/守护/反抗宿命展开。`,
    `【主角固定小队】伙伴各有目标、秘密、专属支线、独有能力与性格缺陷，均可独立出番外。`,
    `【反派三层金字塔】单元反派、系列中层反派、终极幕后存在逐层升级，保留反转与灰色立场。`,
    `【中立摇摆角色】预留情报人、隐士、双面卧底等角色制造阵营反转。`,
    '',
    '## 模块 3｜主线分段规划',
    `【主线阶段目标】完成一个阶段目标就发现更大真相，原有认知被推翻。`,
    `【分季锁坑规划】按目标总字数规划约 ${scale.seasons} 季。${scale.rule}`,
    `【开局方向】${b.openingFormula}`,
    `【结局方向】${b.endingDirection}`,
    '',
    '## 模块 4｜支线储备库',
    `【四类支线弹药库】角色往事支线、遗迹秘闻支线、立场冲突支线、可独立观看的单元小故事。`,
    `【爆点清单】${b.hitHooks.slice(0, 5).join('；')}。`,
    '',
    '## 模块 5｜基调、主题与受众',
    `【核心主题】围绕“选择与代价”贯穿全系列。`,
    `【风格基调与受众】${tone || b.tone || '题材默认基调'}；按目标受众控制爽点、反转与情绪密度。`,
    `【内容约束规则】明确死亡权重、复活规则、血腥与情感尺度，防止写崩。`,
    '',
    '## 模块 6｜叙事节奏与反转',
    `【漫剧节奏与爽点反转】${b.payoffLoop}`,
    '',
    '## 模块 7｜伏笔管控',
    `【伏笔分级与回收规则】${b.sequelEngine.mysteryLayers}`,
  ];
  return lines.join('\n');
}

function templateProposal(input, chosenGenre, reason, alternatives) {
  const b = buildGenreCreativeBlueprint(chosenGenre);
  const targetWords = Math.max(10000, Number(input.targetWords) || 1000000);
  const chapterWords = Math.max(1000, Number(input.chapterWords) || 2000);
  const scale = scalePlanOf({ targetWords });
  const title = TEXT(input.title, 24) || `${chosenGenre.name}·未命名`;
  const tone = TEXT(input.tone, 30) || chosenGenre.tone || '';
  const castSize = Math.min(200, Math.max(8, 12 + Math.floor(targetWords / 200000) * 4));
  return {
    ok: true,
    mocked: true,
    genreId: chosenGenre.id,
    genreName: chosenGenre.name,
    category: chosenGenre.cat,
    tone,
    title,
    titleDescription: TEXT(input.titleDescription, 200) || `${chosenGenre.name}题材，${tone}基调，围绕${(chosenGenre.tags || []).slice(0, 3).join('、') || '核心冲突'}展开，可长期发展续集。`,
    pov: povName('third-limited'),
    castSize,
    targetWords,
    chapterWords,
    seasons: scale.seasons,
    frameworkIntro: frameworkIntroFromBlueprint(b, { title, tone, targetWords }),
    skillPrompt: buildGenreSkillPrompt(chosenGenre).skillPrompt,
    reason,
    alternatives,
    warnings: ['当前 LLM 为 mock，题材与框架为离线模板，配置真实 API Key 后可获得更强的创意方案。'],
  };
}

export function pickGenreHeuristic(input = {}) {
  const hay = `${TEXT(input.title, 80)} ${TEXT(input.titleDescription, 200)} ${TEXT(input.tone, 30)}`.toLowerCase();
  let best = GENRES[0];
  let bestScore = -1;
  for (const genre of GENRES) {
    let score = 0;
    for (const tag of (genre.tags || [])) {
      if (tag && hay.includes(String(tag).toLowerCase())) score += 6;
    }
    if (input.tone && genre.tone === input.tone) score += 4;
    if (String(genre.name).toLowerCase() && hay.includes(String(genre.name).toLowerCase())) score += 10;
    score += (hash(`${genre.id}|${hay}`) % 3) * 0.01;
    if (score > bestScore) { bestScore = score; best = genre; }
  }
  return best;
}

export function buildBrainstormPrompt(input = {}) {
  const genreList = GENRES.map((g) => `${g.id}=${g.name}（${g.cat}｜${(g.tags || []).join('、')}）`).join('\n');
  const targetWords = Math.max(10000, Number(input.targetWords) || 1000000);
  const chapterWords = Math.max(1000, Number(input.chapterWords) || 2000);
  const scale = scalePlanOf({ targetWords });
  const system = [
    '你是顶尖网文/竖屏漫剧选题策划与故事框架设计师。',
    '你要帮作者从给定的 100 种题材中挑出最容易出爆款、且能无限发展续集的题材，并补齐参数与故事框架。',
    '只输出 JSON，不要输出解释、Markdown 围栏或多余文字。',
  ].join('\n');
  const prompt = [
    '【作者提供的信息（可能为空）】',
    `标题：${TEXT(input.title, 60) || '（未提供，请你生成一个爆款标题）'}`,
    `标题描述：${TEXT(input.titleDescription, 200) || '（未提供）'}`,
    `偏好基调：${TEXT(input.tone, 30) || '（未提供，请自动选择）'}`,
    `目标总字数：${targetWords}（${scale.band}，建议 ${scale.seasons} 季）`,
    `单章字数：${chapterWords}`,
    '',
    '【可选题材（必须从这个列表里选，输出其 id）】',
    genreList,
    '',
    '【输出 JSON 格式】',
    JSON.stringify({
      genreId: '',
      genreName: '',
      reason: '为什么这个题材最适合、最容易出爆款',
      title: '主标题（≤20 字）',
      titleDescription: '标题描述一句话',
      tone: '推荐基调（中文）',
      pov: '推荐叙事视角（中文，如 第三人称限知）',
      castSize: 20,
      seasons: 3,
      frameworkIntro: '完整故事框架介绍（600-1200 字，必须按 7 模块：①世界观体系 ②人物矩阵 ③主线分段规划 ④支线储备库 ⑤基调主题与受众 ⑥叙事节奏与反转 ⑦伏笔管控）',
      warnings: [],
    }, null, 2),
    '',
    '【硬性要求】',
    '1. 全部中文；genreId 必须是列表中的 id。',
    '2. 必须体现该题材专属的世界规则、循环危机、终极谜团、主角特别之处与续集发动机，不得写成通用套话。',
    '3. 故事框架必须支持无限续集：终极谜团前期只释放碎片，主线终极目标不得在前 3 季完成。',
    '4. castSize 为推荐角色规模（1~200，含主角、伙伴、反派与中立角色）。',
    '5. 只输出 JSON。',
  ].join('\n');
  return { system, prompt };
}

export async function brainstormGenre(input = {}) {
  const status = llmStatus();
  const heuristic = pickGenreHeuristic(input);
  const alternatives = GENRES
    .map((g) => ({ genreId: g.id, genreName: g.name, score: hash(`${g.id}|${TEXT(input.title, 40)}`) % 100 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  if (status?.provider === 'mock' || !status?.ready) {
    return templateProposal(input, heuristic, '离线模板：根据标题/描述/基调关键词匹配题材；配置真实 LLM 后可获得更强的创意方案。', alternatives);
  }

  try {
    const { system, prompt } = buildBrainstormPrompt(input);
    const out = await chatJSON({ system, prompt, temperature: 0.9, maxTokens: 4000 });
    const raw = out?.data || out?.json;
    if (!raw || typeof raw !== 'object') throw new Error('模型没有返回可解析的 JSON');
    const chosen = genreById(TEXT(raw.genreId, 80)) || heuristic;
    const b = buildGenreCreativeBlueprint(chosen);
    const targetWords = Math.max(10000, Number(input.targetWords) || 1000000);
    const chapterWords = Math.max(1000, Number(input.chapterWords) || 2000);
    const scale = scalePlanOf({ targetWords });
    const castSize = Math.min(200, Math.max(1, Number(raw.castSize) || 20));
    const frameworkIntro = String(raw.frameworkIntro || '').trim() || frameworkIntroFromBlueprint(b, {
      title: TEXT(raw.title, 24) || TEXT(input.title, 24),
      tone: TEXT(raw.tone, 30) || chosen.tone,
      targetWords,
    });
    return {
      ok: true,
      mocked: false,
      genreId: chosen.id,
      genreName: chosen.name,
      category: chosen.cat,
      tone: TEXT(raw.tone, 30) || chosen.tone || '',
      title: TEXT(raw.title, 24) || TEXT(input.title, 24) || `${chosen.name}·未命名`,
      titleDescription: TEXT(raw.titleDescription, 200),
      pov: TEXT(raw.pov, 60) || povName('third-limited'),
      castSize,
      targetWords,
      chapterWords,
      seasons: Math.min(99, Math.max(1, Number(raw.seasons) || scale.seasons)),
      frameworkIntro,
      skillPrompt: buildGenreSkillPrompt(chosen).skillPrompt,
      reason: TEXT(raw.reason, 300),
      alternatives,
      warnings: Array.isArray(raw.warnings) ? raw.warnings.map((w) => TEXT(w, 200)).filter(Boolean) : [],
    };
  } catch (err) {
    const fallback = templateProposal(input, heuristic, `AI 头脑风暴失败，已回退为离线模板：${err.message}`, alternatives);
    fallback.warnings = [String(err.message || err), ...fallback.warnings];
    return fallback;
  }
}
