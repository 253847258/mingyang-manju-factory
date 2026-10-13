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

export const AI_MAX_NEW_CHARACTERS = 8;
export const AI_MAX_CAST = 200;
export const AI_MAX_REF_CHARS = 12000;

const FRAMEWORK_FIELDS = [
  ['logline', '一句话故事'],
  ['protagonist', '主角'],
  ['goal', '主角目标'],
  ['obstacle', '核心阻碍'],
  ['worldview', '世界观'],
  ['mainPlot', '主线'],
  ['subplots', '支线'],
  ['highlights', '爆点'],
  ['ending', '结局方向'],
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

function povNameOf(input) {
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
  const genreName = genreNameOf(input);
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
    `基调：${text(input.tone, 30) || '未定'}`,
    `叙事视角：${povName}`,
    `目标总字数：${Number(input.targetWords) || 1000000}`,
    `单章字数：${Number(input.chapterWords) || 2000}`,
    `季数：${Number(input.seasons) || 1}`,
    `角色规模上限：${Number(input.castSize) || 20}`,
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
        protagonist: '',
        goal: '',
        obstacle: '',
        worldview: '',
        mainPlot: '',
        subplots: '',
        highlights: '',
        ending: '',
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
    `1. 全部用中文；标题 1 个主标题 + 2 个备选，单个不超过 20 字，匹配题材和基调。`,
    '2. 故事框架必须包含：一句话故事、主角、主角目标、核心阻碍、世界观、主线、支线、爆点、结局方向；总长度约 600~1200 中文字符。',
    `3. 新角色最多 ${AI_MAX_NEW_CHARACTERS} 个；已有角色够用就返回空数组。`,
    `4. 新角色不得与已有角色重名。已有角色名单：${existingNames.length ? existingNames.join('、') : '无'}。`,
    '5. 每个新角色必须写清剧情作用；没有剧情作用的角色不要推荐。',
    '6. 不要编造原文/参数里完全没有的重要设定；可以合理补全，但要服务于题材和基调。',
  ].join('\n');
  return { system, user, existingNames };
}

export function buildMockProposal(input = {}, warnings = []) {
  const genreName = genreNameOf(input);
  const title = text(input.title, 20) || `【离线占位】${genreName}小说`;
  const tag = '【离线占位】';
  const framework = {
    logline: `${tag}${title}讲述主角在${genreName}世界里被卷入一场无法回避的冲突，并在一次次选择中完成成长。`,
    protagonist: `${tag}主角暂定为：出身普通或遭逢变故的年轻人，性格有明确缺陷，也有不能被触碰的底线。`,
    goal: `${tag}主角最初只想活下去或查明真相，随后目标升级为保护重要的人、打破幕后势力。`,
    obstacle: `${tag}核心阻碍来自一个比主角更强的对立力量：可能是权贵、宗门、组织或规则本身。`,
    worldview: `${tag}世界观围绕${genreName}题材展开，先确定力量规则、社会秩序和不能越过的禁忌。`,
    mainPlot: `${tag}主线按“平静被打破 → 被迫入局 → 第一次反击 → 付出代价 → 决战”推进。`,
    subplots: `${tag}支线用于补充人物关系、资源争夺、旧日恩怨和感情线，每条支线都要能回到主线。`,
    highlights: `${tag}爆点包括身份反转、当众打脸、关键道具揭示、盟友背叛和最终决战。`,
    ending: `${tag}结局方向为：主角解决核心冲突，但付出一定代价，并留下下一季或下一案的接口。`,
  };
  return {
    ok: true,
    mocked: true,
    title,
    titleAlternatives: [`${title}·备选一`, `${title}·备选二`],
    framework,
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
  return normalizeFrameworkProposal(raw, context, warnings);
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
    const existingId = byName.get(key);
    if (existingId) {
      created.push({ name: item.name, actorId: existingId, reused: true });
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
