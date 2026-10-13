// 小说工坊 · 故事框架 AI 自动填写（plain text module）
//
// 两个职责：
//   1. generateFrameworkProposal：根据表单参数 + 已选角色 + 参考范本，生成
//      结构化故事框架、1 个主标题 + 2 个备选标题、按剧情推荐的新角色。只生成，不写库。
//   2. commitCharacters：把用户确认的新角色创建/复用为演员矩阵正式角色卡（C-xxxx）。
//      只建卡，不自动出定妆图、不产生出图费用。

import fs from 'node:fs';
import { chatJSON } from './llm.js';
import { all, get, run, resolveAsset } from './db.js';
import { genreById } from './data/genres.js';
import { POVS } from './data/dictionaries.js';
import { nowISO } from './util.js';
import { buildGenreCreativeBlueprint } from './genre-frameworks.js';
import { archiveCharacterLink, findArchivedActorByNovelName } from './novel-settings.js';

export const AI_MAX_NEW_CHARACTERS = 8;
export const AI_MAX_CAST = 200;
export const AI_MAX_REF_CHARS = 12000;

const FRAMEWORK_FIELDS = [
  ['logline', '一句话故事'],
  ['recommendedPov', '推荐叙事视角'],
  ['recommendedCastSize', '推荐角色规模'],
  ['worldStyle', '世界风格'],
  ['worldBackground', '基础背景与开放区域'],
  ['worldRules', '底层规则体系'],
  ['factionLayers', '势力分层'],
  ['coreLoopCrisis', '持续循环危机'],
  ['ultimateMystery', '终极世界谜团'],
  ['protagonist', '主角是谁'],
  ['protagonistSpecial', '主角特别之处'],
  ['protagonistGrowth', '主角成长与代价'],
  ['allyTeam', '主角固定小队'],
  ['villainPyramid', '反派三层金字塔'],
  ['neutralCharacters', '中立摇摆角色'],
  ['mainPlot', '主线分段规划'],
  ['seasonPlan', '分季锁坑规划'],
  ['sidequests', '支线储备库'],
  ['theme', '核心主题'],
  ['toneStyle', '风格基调与受众'],
  ['contentRules', '内容约束规则'],
  ['rhythm', '叙事节奏与爽点反转'],
  ['foreshadowRules', '伏笔管控规则'],
  ['openingDirection', '开局方向'],
  ['endingDirection', '结局方向'],
  ['highlights', '爆点'],
];

const ROLE_VALUES = new Set(['主角', '反派', '配角']);
const GENDER_VALUES = new Set(['男', '女', '未知']);

function text(value, max = 400) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function multilineText(value, max = 400) {
  return String(value ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max);
}

function normalizeRole(value) {
  const raw = text(value, 10);
  if (ROLE_VALUES.has(raw)) return raw;
  if (/反派|敌人|对手|幕后|凶手/.test(raw)) return '反派';
  if (/主角|男主|女主|主人公/.test(raw)) return '主角';
  return '配角';
}

function normalizeGender(value) {
  const raw = text(value, 10);
  if (GENDER_VALUES.has(raw)) return raw;
  if (/女|female|f$/i.test(raw)) return '女';
  if (/男|male|m$/i.test(raw)) return '男';
  return '未知';
}

function uniqueNames(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const name = text(item, 30);
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

function genreNameOf(input) {
  const genre = genreById(input.genre);
  return genre?.name || text(input.genreName || input.genre || '未定题材', 40);
}

function genreProfileOf(input) {
  const genre = genreById(input.genre);
  const name = genre?.name || genreNameOf(input);
  const tags = Array.isArray(genre?.tags) ? genre.tags.slice(0, 10) : [];
  const blueprint = genre?.id
    ? buildGenreCreativeBlueprint(genre.id)
    : buildGenreCreativeBlueprint({
      id: text(input.genre || 'custom-genre', 60),
      name,
      cat: '自定义',
      tone: input.tone || '',
      tags,
      hook: '',
      desc: '',
    });
  return {
    name,
    category: genre?.cat || '',
    tone: genre?.tone || input.tone || '',
    tags,
    hook: genre?.hook || '',
    desc: genre?.desc || '',
    blueprint,
  };
}

export function scalePlanOf(input = {}) {
  const target = Number(input.targetWords) || Number(input.target_words) || 1000000;
  if (target < 100000) {
    return { seasons: 1, band: '短篇', rule: '1 季完成阶段闭环；保留 1 个顶级谜团碎片，不强行展开无限续集。' };
  }
  if (target < 300000) {
    return { seasons: 2, band: '中短篇', rule: '2 季：第 1 季入场与区域危机，第 2 季拓展真相；终极谜团不完整揭晓。' };
  }
  if (target < 600000) {
    return { seasons: 3, band: '中长篇', rule: '3 季：每季解锁新区域与新势力，第 3 季只揭开终极谜团的一层。' };
  }
  if (target < 1200000) {
    return { seasons: 5, band: '长篇', rule: '5 季：采用阶段目标递进，每季推翻一次旧认知，终极目标不得在前 3 季完成。' };
  }
  return {
    seasons: Math.min(12, Math.max(6, Math.ceil(target / 300000))),
    band: '超长篇',
    rule: '6-12 季滚动扩展：持续开放新地图、新势力、新危机，伏笔分批释放和回收，为核心续作长期保留终极谜团。',
  };
}

function povNameOf(input) {
  if (input.autoPov) return 'AI 自动选择最适合本故事和漫剧拍摄的视角';
  const pov = POVS.find((p) => p.id === input.pov || p.name === input.pov);
  return pov?.name || text(input.pov || '第三人称限知', 40);
}

function actorSummary(actorList) {
  if (!actorList.length) return '（没有引用演员矩阵里的演员）';
  return actorList.map((a) => {
    const bits = [a.name, a.role_type || '未定位', a.gender || '', a.age ? `${a.age}岁` : '', a.personality || '', a.background || '']
      .map((x) => text(x, 80)).filter(Boolean);
    return `- ${bits.join('｜')}`;
  }).join('\n');
}

function customActorSummary(customActors) {
  if (!customActors.length) return '（没有自定义角色）';
  return customActors.map((a) => {
    const bits = [a.name, a.role || '未定位', a.gender || '', a.age || '', a.desc || a.description || '']
      .map((x) => text(x, 100)).filter(Boolean);
    return `- ${bits.join('｜')}`;
  }).join('\n');
}

export function readReferenceText(refDocPath, warnings = []) {
  const rel = text(refDocPath, 400);
  if (!rel) return '';
  try {
    const abs = resolveAsset(rel);
    if (!abs || !fs.existsSync(abs)) {
      warnings.push(`参考范本不存在或不可读：${rel}`);
      return '';
    }
    const raw = fs.readFileSync(abs, 'utf8');
    return raw.replace(/^\uFEFF/, '').slice(0, AI_MAX_REF_CHARS);
  } catch (err) {
    warnings.push(`参考范本读取失败，已跳过：${err.message}`);
    return '';
  }
}

export function buildFrameworkPrompt(input = {}, refText = '') {
  const genre = genreProfileOf(input);
  const genreName = genre.name;
  const blueprint = genre.blueprint;
  const scale = scalePlanOf(input);
  const povName = povNameOf(input);
  const actorList = Array.isArray(input.actorList) ? input.actorList : [];
  const customActors = Array.isArray(input.customActors) ? input.customActors : [];
  const existingNames = uniqueNames([
    ...actorList.map((a) => a.name),
    ...customActors.map((a) => a.name),
  ]);
  const system = [
    '你是资深竖屏漫剧策划、网文大纲作者和角色设计师。',
    '你的任务是给一部尚未动笔的小说补全可直接使用的中文故事框架。',
    '只输出 JSON，不要输出解释、Markdown 围栏或多余文字。',
  ].join('\n');
  const user = [
    '【当前项目参数】',
    `标题：${text(input.title, 40) || '（用户还没定标题，请你生成）'}`,
    `题材：${genreName}`,
    `题材分类：${genre.category || '未定'}`,
    `题材关键词：${genre.tags.join('、') || '无'}`,
    `题材常用钩子：${text(genre.hook, 120) || '无'}`,
    `题材说明：${text(genre.desc, 200) || '无'}`,
    `基调：${text(input.tone || genre.tone, 30) || '未定'}`,
    `叙事视角：${povName}`,
    `AI自动规划视角：${input.autoPov ? '开启' : '关闭'}`,
    `AI自动规划角色规模：${input.autoCast ? '开启' : '关闭'}`,
    `无固定角色上限：${input.unlimitedCharacters ? '是（按剧情需要，系统保留 200 安全硬上限）' : '否'}`,
    `目标总字数：${Number(input.targetWords) || 1000000}（${scale.band}）`,
    `单章字数：${Number(input.chapterWords) || 2000}`,
    `用户季数：${Number(input.seasons) || 1}`,
    `建议季数：${scale.seasons}`,
    `字数规模规则：${scale.rule}`,
    `角色规模上限：${Number(input.castSize) || 20}`,
    '',
    '【题材创意引擎（必须遵循，不得写成通用套话）】',
    JSON.stringify(genre.blueprint, null, 2),
    '',
    '【已选演员矩阵角色】',
    actorSummary(actorList),
    '',
    '【已有自定义角色】',
    customActorSummary(customActors),
    '',
    '【参考范本（如为空则忽略）】',
    refText || '（无参考范本）',
    '',
    '【输出 JSON 格式】',
    JSON.stringify({
      title: '',
      titleAlternatives: ['', ''],
      framework: {
        logline: '',
        recommendedPov: '第三人称限知/第一人称/多视角等',
        recommendedCastSize: 20,
        worldStyle: '',
        worldBackground: '',
        worldRules: '',
        factionLayers: '',
        coreLoopCrisis: '',
        ultimateMystery: '',
        protagonist: '',
        protagonistSpecial: '',
        protagonistGrowth: '',
        allyTeam: '',
        villainPyramid: '',
        neutralCharacters: '',
        mainPlot: '',
        seasonPlan: '',
        sidequests: '',
        theme: '',
        toneStyle: '',
        contentRules: '',
        rhythm: '',
        foreshadowRules: '',
        openingDirection: '',
        endingDirection: '',
        highlights: '',
      },
      characters: [{
        name: '',
        role: '主角|反派|配角',
        gender: '男|女|未知',
        age: '',
        appearance: '',
        personality: '',
        costume: '',
        background: '',
        reason: '',
      }],
      warnings: [],
    }, null, 2),
    '',
    '【硬性要求】',
    '1. 全部用中文；标题 1 个主标题 + 2 个备选，单个不超过 20 字，匹配题材和基调。',
    '2. 必须严格按固定 7 模块写作：① 世界观体系 ② 人物矩阵 ③ 主线分段规划 ④ 支线储备库 ⑤ 故事基调、核心主题与受众规则 ⑥ 叙事节奏与爽点/反转设计 ⑦ 伏笔管控规则。',
    '2.1 必须使用「题材创意引擎」中的世界规则、循环危机、终极谜团、主角公式、爆款钩子和续集发动机，成为该题材的专属方案，不得套用通用模板。',
    '3. 世界观必须包含：基础背景、大量未开放区域、底层规则、表层/中层/深层势力、持续循环危机、终极世界谜团。',
    '4. 人物矩阵必须包含：主角身份/执念/特别之处/成长代价、固定小队、三层反派金字塔、中立摇摆角色。',
    '5. 必须根据目标总字数自动规划季数和阶段目标；长篇及以上不得在前 3 季完成终极目标。',
    '6. 结局方向必须与开局方向形成闭环；终极谜团只释放碎片线索，不得一次揭晓。',
    '7. 伏笔必须分微型、中型、顶级核心三类，并写明分批释放、分批回收规则。',
    input.autoPov ? '7.1 recommendedPov 必须给出最适合故事的视角名称或 ID，并说明理由。' : '',
    input.autoCast ? '7.2 recommendedCastSize 必须根据剧情规模给出建议角色数量，且不超过 200。' : '',
    `8. 新角色最多 ${AI_MAX_NEW_CHARACTERS} 个；已有角色够用就返回空数组。`,
    `9. 新角色不得与已有角色重名。已有角色名单：${existingNames.length ? existingNames.join('、') : '无'}。`,
    '10. 每个新角色必须写清剧情作用；没有剧情作用的角色不要推荐。',
    '11. 不要编造原文/参数里完全没有的重要设定；可以合理补全，但要服务于题材、字数规模和基调。',
  ].join('\n');
  return { system, user, existingNames };
}

export function buildMockProposal(input = {}, warnings = []) {
  const genre = genreProfileOf(input);
  const genreName = genre.name;
  const blueprint = genre.blueprint;
  const scale = scalePlanOf(input);
  const title = text(input.title, 20) || `【离线占位】${genreName}小说`;
  const tag = '【离线占位】';
  const framework = {
    logline: `${tag}${title}讲述主角在${genreName}世界里被卷入一场无法回避的冲突，并在一次次选择中完成成长。`,
    recommendedPov: input.autoPov ? '第三人称限知（跟随主角）' : (input.pov || 'third-limited'),
    recommendedCastSize: input.autoCast ? Math.min(30, Number(input.castSize) || 20) : (Number(input.castSize) || 20),
    worldStyle: `${tag}${blueprint.worldStyle}`,
    worldBackground: `${tag}基础背景包含时代、世界形态、地理分区；核心区域已开放，同时预留大量未开放区域作为后续新地图。`,
    worldRules: `${tag}${blueprint.worldRules}`,
    factionLayers: `${tag}${blueprint.factionLayers}`,
    coreLoopCrisis: `${tag}${blueprint.coreLoopCrisis}`,
    ultimateMystery: `${tag}${blueprint.ultimateMystery}`,
    protagonist: `${tag}${blueprint.protagonistFormula}`,
    protagonistSpecial: `${tag}${blueprint.protagonistSpecial}`,
    protagonistGrowth: `${tag}主角分阶段成长：能力提升同时暴露弱点，避免后期无敌，人物弧光围绕复仇、真相、守护或反抗宿命展开。`,
    allyTeam: `${tag}固定小队成员各有目标、秘密、专属支线、独有能力与性格缺陷，均可独立拉出番外。`,
    villainPyramid: `${tag}反派分三层：单元反派、系列中层反派、终极幕后存在，逐层升级并保留反转空间。`,
    neutralCharacters: `${tag}预留情报人、隐士、双面卧底等中立摇摆角色，用于制造阵营反转。`,
    mainPlot: `${tag}主线采用阶段目标递进：完成一个目标就发现更大真相，原有认知被推翻。`,
    seasonPlan: `${tag}按目标总字数规划约 ${scale.seasons} 季。${scale.rule}`,
    sidequests: `${tag}支线储备包括角色往事、遗迹秘闻、立场冲突和可独立观看的单元小故事。`,
    theme: `${tag}核心主题围绕“选择与代价”贯穿全系列。`,
    toneStyle: `${tag}风格基调为${text(input.tone || genre.tone, 30) || '题材默认基调'}，并按受众偏好控制爽点、反转和情绪密度。`,
    contentRules: `${tag}明确死亡权重、复活规则、血腥与情感尺度，防止后续创作失控。`,
    rhythm: `${tag}单元节奏采用：小钩子开篇 → 危机升级 → 小反转 → 阶段高潮 → 结尾留悬念。`,
    foreshadowRules: `${tag}伏笔分微型、中型、顶级核心三级；每卷新增新伏笔，顶级伏笔只释放碎片，严禁一次填坑。`,
    openingDirection: `${tag}${blueprint.openingFormula}`,
    endingDirection: `${tag}${blueprint.endingDirection}`,
    highlights: `${tag}${blueprint.hitHooks.join('；')}。`,
  };
  return {
    ok: true,
    mocked: true,
    title,
    titleAlternatives: [`${title}·备选一`, `${title}·备选二`],
    framework,
    genreBlueprint: blueprint,
    characters: [],
    warnings: [
      '当前 LLM 为 mock，只生成离线占位内容。',
      'mock 模式下不会创建演员矩阵角色卡，也不会产生出图费用。',
      ...warnings,
    ],
  };
}

export function normalizeFrameworkProposal(raw = {}, input = {}, baseWarnings = []) {
  const warnings = [...baseWarnings];
  const existingNames = new Set((input.existingNames || []).map((n) => text(n, 30).toLowerCase()));
  const title = text(raw.title, 24) || text(input.title, 24) || '未命名小说';
  let alternatives = Array.isArray(raw.titleAlternatives) ? raw.titleAlternatives.map((x) => text(x, 24)).filter(Boolean) : [];
  alternatives = [...new Set(alternatives.filter((x) => x !== title))].slice(0, 2);
  while (alternatives.length < 2) alternatives.push(`${title}·备选${alternatives.length + 1}`);

  const framework = {};
  let frameworkChars = 0;
  for (const [key] of FRAMEWORK_FIELDS) {
    const value = multilineText(raw.framework?.[key], 500);
    framework[key] = value;
    frameworkChars += value.length;
    if (!value) warnings.push(`AI 没有返回「${FRAMEWORK_FIELDS.find(([k]) => k === key)?.[1] || key}」，已留空，建议重新生成。`);
  }
  if (frameworkChars < 200) warnings.push('AI 返回的故事框架偏短，建议点「重新生成」再试一次。');

  const characters = [];
  const seen = new Set();
  for (const item of (Array.isArray(raw.characters) ? raw.characters : [])) {
    const name = text(item?.name, 20);
    if (!name) continue;
    const key = name.toLowerCase();
    if (existingNames.has(key) || seen.has(key)) {
      if (existingNames.has(key)) warnings.push(`AI 推荐的角色「${name}」与已有角色重名，已跳过。`);
      continue;
    }
    seen.add(key);
    characters.push({
      name,
      role: normalizeRole(item.role),
      gender: normalizeGender(item.gender),
      age: text(item.age, 20),
      appearance: multilineText(item.appearance, 300),
      personality: multilineText(item.personality, 300),
      costume: multilineText(item.costume, 300),
      background: multilineText(item.background, 300),
      reason: multilineText(item.reason, 300),
    });
    if (characters.length >= AI_MAX_NEW_CHARACTERS) break;
  }
  if ((raw.characters || []).length > AI_MAX_NEW_CHARACTERS) {
    warnings.push(`AI 推荐角色超过 ${AI_MAX_NEW_CHARACTERS} 个，已只保留前 ${AI_MAX_NEW_CHARACTERS} 个。`);
  }

  return {
    ok: true,
    mocked: false,
    title,
    titleAlternatives: alternatives,
    framework,
    characters,
    warnings,
  };
}

export async function generateFrameworkProposal(input = {}) {
  const warnings = [];
  const refText = readReferenceText(input.refDocPath, warnings);
  const actorIds = Array.isArray(input.actorIds) ? input.actorIds.map((x) => text(x, 40)).filter(Boolean).slice(0, 300) : [];
  const actorList = actorIds.length
    ? all(`SELECT id, name, role_type, gender, age, personality, background FROM actors WHERE id IN (${actorIds.map(() => '?').join(',')})`, ...actorIds)
    : [];
  const customActors = Array.isArray(input.customActors) ? input.customActors.slice(0, 200) : [];
  const context = {
    ...input,
    actorList,
    customActors,
  };
  const prompt = buildFrameworkPrompt(context, refText);
  context.existingNames = prompt.existingNames;
  let result;
  try {
    result = await chatJSON({ system: prompt.system, user: prompt.user });
  } catch (err) {
    throw new Error(`AI 生成故事框架失败：${err.message}`);
  }
  if (result?.mocked) return buildMockProposal(context, warnings);
  const raw = result?.data || result?.json;
  if (!raw || typeof raw !== 'object') {
    throw new Error('LLM 没有返回可解析的 JSON，请重试或检查模型配置');
  }
  const normalized = normalizeFrameworkProposal(raw, context, warnings);
  return {
    ...normalized,
    genreBlueprint: genreProfileOf(context).blueprint,
  };
}

export async function commitCharacters({
  novelId = null,
  characters = [],
  bindToNovel = false,
  tags = [],
  styleId = '',
} = {}) {
  const actorsMod = await import('./modules/actors.js');
  const list = (Array.isArray(characters) ? characters : [])
    .map((c) => ({
      name: text(c?.name, 30),
      role: normalizeRole(c?.role),
      gender: normalizeGender(c?.gender),
      age: text(c?.age, 20),
      appearance: multilineText(c?.appearance, 300),
      personality: multilineText(c?.personality, 300),
      costume: multilineText(c?.costume, 300),
      background: multilineText(c?.background, 300),
      reason: multilineText(c?.reason, 300),
      firstAppearance: multilineText(c?.firstAppearance, 120),
      storylineRole: multilineText(c?.storylineRole, 300),
      styleHint: text(c?.styleHint || c?.style, 120),
      styleId: text(c?.styleId, 60) || text(styleId, 60),
    }))
    .filter((c) => c.name)
    .slice(0, AI_MAX_NEW_CHARACTERS);
  if (!list.length) throw new Error('没有可提交的新角色');

  const novel = novelId ? get('SELECT * FROM novels WHERE id = ?', novelId) : null;
  const actorIds = novel ? safeJson(novel.actor_ids, []) : [];
  const customActors = novel ? safeJson(novel.custom_actors, []) : [];
  const castSize = Math.min(AI_MAX_CAST, Number(novel?.cast_size) || AI_MAX_CAST);
  const existingActors = all('SELECT id, name FROM actors');
  const byName = new Map(existingActors.map((a) => [text(a.name, 30).toLowerCase(), a.id]));
  const castNames = new Set([
    ...actorIds.map((id) => {
      const found = existingActors.find((a) => a.id === id);
      return text(found?.name, 30).toLowerCase();
    }),
    ...customActors.map((c) => text(c?.name, 30).toLowerCase()),
  ]);

  const uniqueList = [];
  const seen = new Set();
  for (const item of list) {
    const key = item.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueList.push(item);
  }

  const newCount = uniqueList.filter((c) => !byName.has(c.name.toLowerCase())).length;
  const incomingNames = new Set(uniqueList.map((c) => c.name.toLowerCase()));
  const keptCustomCount = customActors.filter((c) => !incomingNames.has(text(c?.name, 30).toLowerCase())).length;
  const projected = actorIds.length + keptCustomCount + newCount;
  if (projected > castSize) {
    throw new Error(`角色总数将达 ${projected}，超过当前角色规模 ${castSize}。请先调大角色规模或减少推荐角色。`);
  }
  if (projected > AI_MAX_CAST) {
    throw new Error(`角色总数将达 ${projected}，超过硬上限 ${AI_MAX_CAST}。请先删减角色。`);
  }

  const created = [];
  const failed = [];
  const warnings = [];
  if (newCount > 0) actorsMod.bumpActorSeq();
  for (const item of uniqueList) {
    const key = item.name.toLowerCase();
    const archived = novelId ? findArchivedActorByNovelName(novelId, item.name) : null;
    const existingId = archived?.actor_id || byName.get(key);
    if (existingId) {
      created.push({ name: item.name, actorId: existingId, reused: true });
      if (novelId) archiveCharacterLink(novelId, { id: existingId, name: item.name }, {
        source: '故事框架/角色提案',
        reason: item.reason,
        firstAppearance: item.firstAppearance,
        storylineRole: item.storylineRole,
      });
      continue;
    }
    try {
      const actor = actorsMod.createActor({
        name: item.name,
        alias: '',
        gender: item.gender === '男' ? 'male' : item.gender === '女' ? 'female' : '',
        age: /^\d+$/.test(item.age) ? Number(item.age) : null,
        role_type: item.role,
        face: item.appearance,
        personality: item.personality,
        costume: item.costume,
        background: [
          item.background,
          item.reason ? `剧情作用：${item.reason}` : '',
          item.storylineRole ? `故事线作用：${item.storylineRole}` : '',
          item.firstAppearance ? `首次出场：${item.firstAppearance}` : '',
        ].filter(Boolean).join('\n'),
        style_id: item.styleId || 'cinematic-real',
        ratio: '3:4',
        tags: JSON.stringify([...new Set(['AI推荐', '小说工坊', ...(novelId ? [`novel:${novelId}`] : []), ...(Array.isArray(tags) ? tags : [])])]),
      });
      byName.set(key, actor.id);
      created.push({ name: item.name, actorId: actor.id, reused: false });
      if (novelId) archiveCharacterLink(novelId, { id: actor.id, name: item.name }, {
        source: '故事框架/角色提案',
        reason: item.reason,
        firstAppearance: item.firstAppearance,
        storylineRole: item.storylineRole,
      });
      if (castNames.has(key)) warnings.push(`小说已有同名自定义角色「${item.name}」，已改为引用演员矩阵角色卡，请在表单中移除旧的自定义角色。`);
    } catch (err) {
      failed.push({ name: item.name, error: err.message || '创建角色卡失败' });
    }
  }
  if (bindToNovel && novel) {
    const nextActorIds = [...new Set([
      ...actorIds,
      ...created.map((x) => x.actorId).filter(Boolean),
    ])];
    const createdNames = new Set(created.map((x) => text(x.name, 30).toLowerCase()));
    const nextCustom = customActors.filter((c) => !createdNames.has(text(c?.name, 30).toLowerCase()));
    run('UPDATE novels SET actor_ids = ?, custom_actors = ?, updated_at = ? WHERE id = ?',
      JSON.stringify(nextActorIds), JSON.stringify(nextCustom), nowISO(), novelId);
  }
  return { ok: true, created, failed, warnings, boundToNovel: Boolean(bindToNovel && novel) };
}

function safeJson(value, fallback) {
  try {
    if (value === null || value === undefined || value === '') return fallback;
    if (Array.isArray(value)) return value;
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}
