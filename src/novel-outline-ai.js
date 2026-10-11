// 小说工坊 · 大纲「自动 AI 规划生成」（plain text module）
//
// 背景：`src/modules/novel.js` 的 generateOutline 在离线/mock 或模型漏字段时，
// 14 个分节里常常只有 chapters 有内容（实测：13 节为空）。而它整体重生成代价高、还会覆盖已有内容。
//
// 本模块补齐"逐节 AI 生成"：
//   · generateSection      只生成某一节（带全篇上下文：参数/框架/既有章节走向/ID 约束）
//   · fillSections         把空缺的节逐节补齐（默认 13 节，chapters 交给既有的分集大纲流程）
//   · saveOutlineVersion   把合并后的大纲写成新版本（并同步章节骨架行）
//
// 离线（mock / 无 Key）时用带【离线占位】标记的确定性内容，保证结构完整可先跑通。

import fs from 'node:fs';
import { all, get, run, resolveAsset } from './db.js';
import { nowISO, rid } from './util.js';
import { chatJSON, llmStatus } from './llm.js';
import { syncChapterSkeletons } from './modules/novel.js';
import { buildNovelAssets, assetPromptBlock } from './novel-assets.js';

export const OUTLINE_AI_MAX_REF_CHARS = 12000;
export const OUTLINE_AI_MAX_ITEMS = 120;
export const OUTLINE_AI_MAX_CHAPTERS_PER_CALL = 20;
export const OUTLINE_AI_CHAPTER_MIN_CHARS = 2500;
export const OUTLINE_AI_CHAPTER_MAX_CHARS = 3500;

const TEXT = (v, max = 400) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const MULTI = (v, max = 1200) => String(v ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max);
const INT = (v) => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const STR_LIST = (v, max = 12) => (Array.isArray(v) ? v.map((x) => TEXT(x, 60)).filter(Boolean).slice(0, max) : []);

// 每一节：结构说明（喂给模型）+ 归一化函数（落库前清洗）
export const OUTLINE_AI_SECTIONS = [
  {
    key: 'logline',
    label: '一句话故事',
    shape: '字符串（40-80 字，一句话讲清主角+目标+阻碍+看点）',
    normalize: (v) => TEXT(v, 200),
  },
  {
    key: 'framework',
    label: '故事框架与核心冲突',
    shape: '对象 {"core_conflict":"","protagonist_goal":"","antagonist_force":"","three_acts":"","theme":"","opening_image":"","ending":""}（每项 20-60 字）',
    normalize: (v) => {
      const o = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
      const out = {};
      for (const k of ['core_conflict', 'protagonist_goal', 'antagonist_force', 'three_acts', 'theme', 'opening_image', 'ending']) {
        const s = TEXT(o[k], 300);
        if (s) out[k] = s;
      }
      return out;
    },
  },
  {
    key: 'storyline',
    label: '头尾逻辑与故事线',
    shape: '对象 {"opening_logic":"开篇如何立住主角/冲突/钩子","story_chain":["按顺序的关键因果"],"turning_points":["重大转折"],"ending_logic":"结局如何回收主线","head_tail_closure":"开头元素如何在结尾闭环","final_image":"最终画面"}',
    normalize: (v) => {
      const o = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
      const out = {};
      for (const k of ['opening_logic', 'ending_logic', 'head_tail_closure', 'final_image']) {
        const s = MULTI(o[k], 800);
        if (s) out[k] = s;
      }
      for (const k of ['story_chain', 'turning_points']) {
        const list = (Array.isArray(o[k]) ? o[k] : []).map((x) => TEXT(x, 240)).filter(Boolean).slice(0, 30);
        if (list.length) out[k] = list;
      }
      return out;
    },
  },
  {
    key: 'worldview',
    label: '世界观设定',
    shape: '对象 {"era":"时代背景","rules":"世界规则","power_system":"力量体系","taboos":"禁忌","text":"补充说明"}（每项 30-80 字）',
    normalize: (v) => {
      const o = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
      const out = {};
      for (const k of ['era', 'rules', 'power_system', 'taboos', 'text']) {
        const s = MULTI(o[k], 500);
        if (s) out[k] = s;
      }
      return out;
    },
  },
  {
    key: 'volumes',
    label: '卷/季结构规划',
    shape: '数组 [{"volume":1,"title":"","from_chapter":1,"to_chapter":30,"goal":"","climax":"","hook":""}]（卷数=小说的季数）',
    normalize: (v) => (Array.isArray(v) ? v : []).map((x, i) => ({
      volume: INT(x?.volume) || i + 1,
      title: TEXT(x?.title, 60),
      from_chapter: INT(x?.from_chapter),
      to_chapter: INT(x?.to_chapter),
      goal: TEXT(x?.goal, 200),
      climax: TEXT(x?.climax, 200),
      hook: TEXT(x?.hook, 200),
    })).filter((x) => x.title || x.goal).slice(0, 24),
  },
  {
    key: 'timeline',
    label: '宏大时间线',
    shape: '数组 [{"time":"故事内时间","event":"发生了什么","chapter":12,"impact":"对主线影响"}]（按章节递增，章号必须在 1..N 内）',
    normalize: (v) => (Array.isArray(v) ? v : []).map((x) => ({
      time: TEXT(x?.time, 60),
      event: TEXT(x?.event, 240),
      chapter: INT(x?.chapter),
      impact: TEXT(x?.impact, 200),
    })).filter((x) => x.event).slice(0, OUTLINE_AI_MAX_ITEMS),
  },
  {
    key: 'locations',
    label: '地点档案（ID）',
    shape: '数组 [{"id":"L-0001","name":"","type":"","desc":"","first_chapter":1}]（id 必须 L-0001 起递增，不得与已有重复）',
    normalize: (v, ctx) => {
      const used = new Set(ctx?.existingIds || []);
      let seq = ctx?.nextLocationSeq || 1;
      return (Array.isArray(v) ? v : []).map((x) => {
        let id = TEXT(x?.id, 20).toUpperCase();
        if (!/^L-\d{4}$/.test(id) || used.has(id)) { id = `L-${String(seq).padStart(4, '0')}`; }
        while (used.has(id)) { seq += 1; id = `L-${String(seq).padStart(4, '0')}`; }
        used.add(id); seq = Math.max(seq, Number(id.slice(2)) || 0) + 1;
        return {
          id,
          name: TEXT(x?.name, 60),
          type: TEXT(x?.type, 40),
          desc: TEXT(x?.desc, 240),
          first_chapter: INT(x?.first_chapter),
        };
      }).filter((x) => x.name).slice(0, 80);
    },
  },
  {
    key: 'characters',
    label: '人物 ID 与出场规划',
    shape: '数组 [{"id":"C-0001","name":"","role":"主角/反派/配角","arc":"","function":"","relationships":""}]（id 用给定的演员/自定义角色编号，不得新增编号）',
    normalize: (v, ctx) => (Array.isArray(v) ? v : []).map((x) => {
      const name = TEXT(x?.name, 40);
      let id = TEXT(x?.id, 20).toUpperCase();
      const known = ctx?.castByName?.get(name);
      if (known) id = known.id;
      return {
        id: /^C(X)?-\d{4}$/.test(id) ? id : '',
        name,
        role: TEXT(x?.role, 20),
        arc: TEXT(x?.arc, 240),
        function: TEXT(x?.function, 200),
        relationships: TEXT(x?.relationships, 240),
      };
    }).filter((x) => x.name).slice(0, 120),
  },
  {
    key: 'foreshadow',
    label: '伏笔与回收表',
    shape: '数组 [{"id":"FS-01","content":"","setup_chapter":3,"payoff_chapter":28,"status":"待回收","payoff_way":""}]（回收章必须 > 埋设章，且都在 1..N 内）',
    normalize: (v) => (Array.isArray(v) ? v : []).map((x, i) => {
      const setup = INT(x?.setup_chapter);
      const payoff = INT(x?.payoff_chapter);
      return {
        id: TEXT(x?.id, 20) || `FS-${String(i + 1).padStart(2, '0')}`,
        content: TEXT(x?.content, 240),
        setup_chapter: setup,
        payoff_chapter: payoff && payoff > setup ? payoff : (setup ? setup + 1 : 0),
        status: TEXT(x?.status, 20) || '待回收',
        payoff_way: TEXT(x?.payoff_way, 200),
      };
    }).filter((x) => x.content).slice(0, 80),
  },
  {
    key: 'reversals',
    label: '反转清单',
    shape: '数组 [{"chapter":25,"content":"反转内容","impact":"对后续影响","foreshadow":"关联伏笔"}]',
    normalize: (v) => (Array.isArray(v) ? v : []).map((x) => ({
      chapter: INT(x?.chapter),
      content: TEXT(x?.content, 240),
      impact: TEXT(x?.impact, 200),
      foreshadow: TEXT(x?.foreshadow, 160),
    })).filter((x) => x.content).slice(0, 60),
  },
  {
    key: 'beats',
    label: '节奏卡点与爽点曲线',
    shape: '数组 [{"chapter":10,"type":"爽点/压抑/悬念","intensity":8,"note":""}]（intensity 1-10）',
    normalize: (v) => (Array.isArray(v) ? v : []).map((x) => ({
      chapter: INT(x?.chapter),
      type: TEXT(x?.type, 20) || '爽点',
      intensity: Math.min(10, Math.max(1, INT(x?.intensity) || 5)),
      note: TEXT(x?.note, 160),
    })).filter((x) => x.chapter).slice(0, 200),
  },
  {
    key: 'hooks',
    label: '钩子银行（章末钩子）',
    shape: '数组 [{"chapter":12,"content":"章末钩子原文","note":""}]（可只给关键章节）',
    normalize: (v) => (Array.isArray(v) ? v : []).map((x) => ({
      chapter: INT(x?.chapter),
      content: TEXT(x?.content, 200),
      note: TEXT(x?.note, 120),
    })).filter((x) => x.content).slice(0, 200),
  },
  {
    key: 'loops',
    label: '跨季章节时间回路',
    shape: '数组 [{"from":1,"to":60,"relation":"呼应/回环","cause":"说明"}]',
    normalize: (v) => (Array.isArray(v) ? v : []).map((x) => ({
      from: INT(x?.from),
      to: INT(x?.to),
      relation: TEXT(x?.relation, 40),
      cause: TEXT(x?.cause, 200),
    })).filter((x) => x.from && x.to).slice(0, 40),
  },
  {
    key: 'logic',
    label: '全篇逻辑关系与因果链',
    shape: '数组 [{"from":"起点事件","to":"结果","relation":"导致/阻止","cause":"因果说明"}]',
    normalize: (v) => (Array.isArray(v) ? v : []).map((x) => ({
      from: TEXT(x?.from, 120),
      to: TEXT(x?.to, 120),
      relation: TEXT(x?.relation, 40),
      cause: TEXT(x?.cause, 200),
    })).filter((x) => x.from && x.to).slice(0, 80),
  },
];

const SPEC_BY_KEY = new Map(OUTLINE_AI_SECTIONS.map((s) => [s.key, s]));

// 默认"补齐"的分节：chapters 由既有的「生成章节大纲 / 续规划章节」负责，避免一次调用塞几百章
export const OUTLINE_AI_DEFAULT_KEYS = OUTLINE_AI_SECTIONS.map((s) => s.key).filter((k) => k !== 'chapters');

// 状态视图包含 chapters，方便前端把它和其余"按节 AI 生成"一起展示；
// 一键补齐仍由默认 keys 排除 chapters，交给既有章节大纲流程。
export const OUTLINE_AI_STATUS_SECTIONS = [
  'logline',
  'framework',
  'storyline',
  'worldview',
  'volumes',
  'chapters',
  'timeline',
  'locations',
  'characters',
  'foreshadow',
  'reversals',
  'beats',
  'hooks',
  'loops',
  'logic',
].map((key) => key === 'chapters'
  ? { key, label: '章节大纲与走向' }
  : { key, label: SPEC_BY_KEY.get(key)?.label || key });

export function outlineAiSectionList() {
  return OUTLINE_AI_SECTIONS.map((s) => ({ key: s.key, label: s.label }));
}

export function sectionsOf(outline) {
  const raw = outline?.data ?? outline?.payload ?? {};
  const obj = raw && typeof raw === 'object' ? raw : {};
  return { ...obj };
}

// 空判定：字符串空 / 数组空 / 对象无键；chapters 忽略 _placeholder 占位行
export function isEmptySection(key, val) {
  if (key === 'chapters') {
    const real = (Array.isArray(val) ? val : []).filter((c) => c && !c._placeholder && (c.summary || c.title));
    return real.length === 0;
  }
  if (val == null) return true;
  if (Array.isArray(val)) return val.length === 0;
  if (typeof val === 'object') return Object.keys(val).length === 0;
  return !String(val).trim();
}

export function missingSectionKeys(sections = {}, keys = OUTLINE_AI_SECTIONS.map((s) => s.key)) {
  return keys.filter((k) => isEmptySection(k, sections[k]));
}

function safeJson(v) {
  if (v && typeof v === 'object') return v;
  try { return JSON.parse(v || '{}'); } catch { return {}; }
}

function chapterBudget(novel = {}, sections = {}) {
  const planned = Array.isArray(sections.chapters) ? sections.chapters.length : 0;
  const byWords = Number(novel.target_words) > 0 && Number(novel.chapter_words) > 0
    ? Math.ceil(Number(novel.target_words) / Number(novel.chapter_words))
    : 0;
  return Math.max(planned, byWords, 1);
}

// 组装"全篇上下文"，让逐节生成彼此自洽
function contextOf(novel, sections) {
  const cast = [];
  const actorIds = safeJson(novel.actor_ids) || [];
  const customActors = safeJson(novel.custom_actors) || [];
  if (Array.isArray(actorIds) && actorIds.length) {
    const rows = all(`SELECT id, name, role_type FROM actors WHERE id IN (${actorIds.map(() => '?').join(',')})`, ...actorIds.slice(0, 300));
    rows.forEach((r) => cast.push({ id: r.id, name: r.name, role: r.role_type || '' }));
  }
  if (Array.isArray(customActors)) {
    customActors.slice(0, 200).forEach((c) => {
      if (c?.name) cast.push({ id: TEXT(c.id, 20), name: TEXT(c.name, 40), role: TEXT(c.role || c.roleType || '自定义', 20) });
    });
  }
  const existingIds = [
    ...(Array.isArray(sections.locations) ? sections.locations.map((x) => TEXT(x?.id, 20)) : []),
    ...cast.map((c) => c.id),
  ].filter(Boolean);
  const locSeqs = existingIds.filter((id) => /^L-\d{4}$/.test(id)).map((id) => Number(id.slice(2)));
  return {
    cast,
    castByName: new Map(cast.map((c) => [c.name, c])),
    assets: buildNovelAssets(novel, sections),
    existingIds,
    nextLocationSeq: locSeqs.length ? Math.max(...locSeqs) + 1 : 1,
    chapterMax: chapterBudget(novel, sections),
  };
}

export function chapterPlanComplete(chapter) {
  const summary = TEXT(chapter?.summary, OUTLINE_AI_CHAPTER_MAX_CHARS + 1);
  return Boolean(
    chapter
    && !chapter._placeholder
    && TEXT(chapter.title, 120)
    && summary.length >= OUTLINE_AI_CHAPTER_MIN_CHARS
    && summary.length <= OUTLINE_AI_CHAPTER_MAX_CHARS,
  );
}

export function chapterPlanStats(sections = {}, novel = {}) {
  const expected = chapterBudget(novel, sections);
  const byIdx = new Map(
    (Array.isArray(sections.chapters) ? sections.chapters : [])
      .map((c) => [INT(c?.idx), c])
      .filter(([idx]) => idx > 0),
  );
  const missing = [];
  for (let idx = 1; idx <= expected; idx += 1) {
    if (!chapterPlanComplete(byIdx.get(idx))) missing.push(idx);
  }
  return {
    expected,
    actual: Array.isArray(sections.chapters) ? sections.chapters.length : 0,
    complete: expected - missing.length,
    missing,
  };
}

function ensureChapterSlots(sections = {}, novel = {}, ctx = null) {
  const c = ctx || contextOf(novel, sections);
  const rows = new Map(
    (Array.isArray(sections.chapters) ? sections.chapters : [])
      .map((x) => [INT(x?.idx), { ...x }])
      .filter(([idx]) => idx > 0),
  );
  const seasons = Math.max(1, Number(novel.seasons) || 1);
  const perVolume = Math.max(1, Math.ceil(c.chapterMax / seasons));
  for (let idx = 1; idx <= c.chapterMax; idx += 1) {
    if (rows.has(idx)) continue;
    rows.set(idx, {
      idx,
      volume: Math.min(seasons, Math.floor((idx - 1) / perVolume) + 1),
      title: `第${idx}章（待规划）`,
      summary: '',
      events: [],
      hook: '',
      cliffhanger: '',
      characters: [],
      locations: [],
      pov: '',
      foreshadow: [],
      _placeholder: true,
    });
  }
  return [...rows.values()].sort((a, b) => INT(a.idx) - INT(b.idx));
}

function buildChapterPrompt(novel = {}, sections = {}, idx, { instruction = '', ctx = null, refText = '' } = {}) {
  const c = ctx || contextOf(novel, sections);
  const n = Math.min(Math.max(INT(idx) || 1, 1), c.chapterMax);
  const rows = ensureChapterSlots(sections, novel, c);
  const row = rows.find((x) => INT(x.idx) === n) || {};
  const prev = rows.find((x) => INT(x.idx) === n - 1);
  const next = rows.find((x) => INT(x.idx) === n + 1);
  const castLines = c.cast.slice(0, 60).map((x) => `${x.id} ${x.name}${x.role ? `（${x.role}）` : ''}`).join('\n') || '（未绑定角色）';
  const locations = (Array.isArray(sections.locations) ? sections.locations : [])
    .slice(0, 60)
    .map((x) => `${TEXT(x?.id, 20)} ${TEXT(x?.name, 60)}`)
    .filter(Boolean)
    .join('\n') || '（地点待规划）';
  const foreshadows = (Array.isArray(sections.foreshadow) ? sections.foreshadow : [])
    .slice(0, 80)
    .map((x) => `${TEXT(x?.id, 20)} ${TEXT(x?.content, 100)}`)
    .filter(Boolean)
    .join('\n') || '（暂无伏笔表）';
  const framework = sections.framework && typeof sections.framework === 'object' ? JSON.stringify(sections.framework) : '（无）';
  return [
    '【小说参数】',
    `书名：${TEXT(novel.title, 60) || '（未命名）'}`,
    `题材：${TEXT(novel.genre, 40)}${novel.sub_genre ? `/ ${TEXT(novel.sub_genre, 40)}` : ''}`,
    `基调：${TEXT(novel.tone, 40)}　视角：${TEXT(novel.pov, 40)}`,
    `总章数：${c.chapterMax}　目标：${Number(novel.target_words) || 0} 字 / 单章 ${Number(novel.chapter_words) || 0} 字`,
    '',
    assetPromptBlock(c.assets),
    '',
    '【本次指定章节】',
    `第 ${n} 章（必须只规划这一章，idx 必须等于 ${n}）`,
    `当前内容：${JSON.stringify(row).slice(0, 1600)}`,
    `前一章：${prev ? `第${prev.idx}章 ${TEXT(prev.title, 60)}：${TEXT(prev.summary, 240)}` : '（无）'}`,
    `后一章：${next ? `第${next.idx}章 ${TEXT(next.title, 60)}：${TEXT(next.summary, 240)}` : '（无）'}`,
    '',
    '【既有故事框架】',
    framework,
    `一句话故事：${TEXT(sections.logline, 160) || '（无）'}`,
    '',
    '【可用角色（只能用这些编号或姓名）】',
    castLines,
    '',
    '【地点档案（优先使用这些 ID/名称）】',
    locations,
    '',
    '【伏笔表（优先复用这些编号）】',
    foreshadows,
    refText ? `\n【参考范本（只参考风格与节奏，不要照抄）】\n${refText.slice(0, 6000)}` : '',
    instruction ? `\n【额外要求】\n${TEXT(instruction, 500)}` : '',
    '',
    '只输出 JSON，形如：',
    '{"chapter":{"idx":1,"volume":1,"title":"","summary":"","events":[""],"hook":"","cliffhanger":"","characters":["C-0001"],"locations":["L-0001"],"pov":"","foreshadow":["FS-01"]}}',
    `硬约束：summary 必须是 ${OUTLINE_AI_CHAPTER_MIN_CHARS}-${OUTLINE_AI_CHAPTER_MAX_CHARS} 个中文字符，优先服务故事大纲、正文承接和头尾逻辑故事线；人物/环境/物品必须带资产索引 ID；events 4-8 条；章末必须给钩子；不要输出解释。`,
  ].filter(Boolean).join('\n');
}

function buildChapterExpandPrompt(novel = {}, sections = {}, idx, current = '', instruction = '') {
  return [
    `请把第 ${idx} 章的章节大纲扩写到 ${OUTLINE_AI_CHAPTER_MIN_CHARS}-${OUTLINE_AI_CHAPTER_MAX_CHARS} 个中文字符。`,
    `小说：${TEXT(novel.title, 60)}　题材：${TEXT(novel.genre, 40)}　基调：${TEXT(novel.tone, 40)}`,
    `一句话故事：${TEXT(sections.logline, 160)}`,
    `当前章节大纲：\n${TEXT(current, OUTLINE_AI_CHAPTER_MAX_CHARS)}`,
    instruction ? `额外要求：${TEXT(instruction, 500)}` : '',
    '扩写要求：保留原剧情事实，不另起炉灶；按场景顺序展开，补充冲突动作、人物选择、信息差、因果推进、情绪变化和章末钩子。',
    `只输出 JSON：{"summary":"${OUTLINE_AI_CHAPTER_MIN_CHARS}-${OUTLINE_AI_CHAPTER_MAX_CHARS} 个中文字符的完整大纲"}`,
  ].filter(Boolean).join('\n');
}

export function buildMockChapterPlan(novel = {}, sections = {}, idx, ctx = null) {
  const c = ctx || contextOf(novel, sections);
  const n = Math.min(Math.max(INT(idx) || 1, 1), c.chapterMax);
  const tag = '【离线占位】';
  const cast = c.cast.filter((x) => /^C(X)?-\d{4}$/i.test(x.id)).slice(0, 3).map((x) => x.id);
  const locations = (Array.isArray(sections.locations) ? sections.locations : []).map((x) => TEXT(x?.id, 20)).filter(Boolean).slice(0, 2);
  const foreshadow = (Array.isArray(sections.foreshadow) ? sections.foreshadow : []).map((x) => TEXT(x?.id, 20)).filter(Boolean).slice(0, 2);
  return {
    idx: n,
    volume: 1,
    title: `${tag}第${n}章`,
    summary: `${tag}第${n}章：主角推进当前目标，遭遇新的阻碍并付出代价，本章结尾把冲突推向下一章。`,
    events: [`${tag}主角调查线索`, `${tag}对手升级施压`, `${tag}关键人物做出选择`, `${tag}章末留下新危机`],
    hook: `${tag}一个反常细节指向更大的秘密`,
    cliffhanger: `${tag}主角刚拿到线索，就发现线索本身是陷阱`,
    characters: cast,
    locations,
    pov: cast[0] || '',
    foreshadow,
    _placeholder: true,
  };
}

export function normalizeChapterPlan(raw, ctx, idx) {
  const o = raw && typeof raw === 'object' && raw.chapter && typeof raw.chapter === 'object'
    ? raw.chapter
    : raw && typeof raw === 'object' && raw.value && typeof raw.value === 'object'
      ? raw.value
      : raw && typeof raw === 'object' ? raw : {};
  const n = Math.min(Math.max(INT(idx) || INT(o.idx) || 1, 1), ctx?.chapterMax || INT(idx) || 1);
  return {
    idx: n,
    volume: INT(o.volume) || 1,
    title: TEXT(o.title, 120) || `第${n}章`,
    summary: MULTI(o.summary, OUTLINE_AI_CHAPTER_MAX_CHARS),
    events: (Array.isArray(o.events) ? o.events : []).map((x) => TEXT(x, 220)).filter(Boolean).slice(0, 12),
    hook: TEXT(o.hook, 240),
    cliffhanger: TEXT(o.cliffhanger || o.hook, 320),
    characters: STR_LIST(o.characters, 20),
    locations: STR_LIST(o.locations, 20),
    pov: TEXT(o.pov, 60),
    foreshadow: STR_LIST(o.foreshadow, 20),
    _placeholder: Boolean(o._placeholder),
  };
}

export async function generateChapterPlan(novel, sections, idx, { instruction = '', warnings = [], ctx = null } = {}) {
  const c = ctx || contextOf(novel, sections);
  const n = Math.min(Math.max(INT(idx) || 1, 1), c.chapterMax);
  const status = llmStatus();
  if (status?.provider === 'mock') {
    warnings.push(`第 ${n} 章使用离线占位内容（当前 LLM 为 mock）`);
    return { idx: n, value: buildMockChapterPlan(novel, sections, n, c), mocked: true, calls: 0 };
  }
  const prompt = buildChapterPrompt(novel, sections, n, { instruction, ctx: c, refText: referenceSnippet(novel) });
  try {
    let calls = 1;
    const out = await chatJSON({ system: AI_SYSTEM, prompt, temperature: 0.75, maxTokens: 8000 });
    let value = normalizeChapterPlan(out?.data, c, n);
    if (!value.title || !value.summary) throw new Error('模型返回的章节内容不完整');
    if (value.summary.length < OUTLINE_AI_CHAPTER_MIN_CHARS) {
      try {
        const expanded = await chatJSON({
          system: AI_SYSTEM,
          prompt: buildChapterExpandPrompt(novel, sections, n, value.summary, instruction),
          temperature: 0.55,
          maxTokens: 8000,
        });
        const longSummary = MULTI(expanded?.data?.summary, OUTLINE_AI_CHAPTER_MAX_CHARS);
        if (longSummary.length > value.summary.length) value = { ...value, summary: longSummary };
        calls += 1;
      } catch (err) {
        warnings.push(`第 ${n} 章自动扩写失败，保留首次生成内容：${err.message}`);
      }
    }
    const len = value.summary.length;
    if (len < OUTLINE_AI_CHAPTER_MIN_CHARS) {
      warnings.push(`第 ${n} 章大纲目前 ${len} 字，低于目标 ${OUTLINE_AI_CHAPTER_MIN_CHARS}-${OUTLINE_AI_CHAPTER_MAX_CHARS} 字；建议对该章再次执行 AI 规划`);
    }
    return { idx: n, value, mocked: false, model: out?.model || '', calls };
  } catch (err) {
    warnings.push(`第 ${n} 章 AI 规划失败，已用离线占位替代：${err.message}`);
    return { idx: n, value: buildMockChapterPlan(novel, sections, n, c), mocked: true, calls: 1, error: err.message };
  }
}

// 指定章节范围逐章规划；默认只补不完整章节，避免覆盖已有可用内容。
export async function planChapters(novel, sections, {
  from = 1,
  to = null,
  onlyEmpty = true,
  instruction = '',
  maxCalls = OUTLINE_AI_MAX_CHAPTERS_PER_CALL,
} = {}) {
  const ctx = contextOf(novel, sections);
  const expected = ctx.chapterMax;
  const start = Math.max(1, INT(from) || 1);
  const end = Math.min(expected, INT(to) || expected);
  if (start > end || start > expected) throw new Error(`章节范围无效：${start}-${end}，当前总章数为 ${expected}`);
  const chapters = ensureChapterSlots(sections, novel, ctx);
  const range = [];
  for (let idx = start; idx <= end; idx += 1) range.push(idx);
  const targets = onlyEmpty
    ? range.filter((idx) => !chapterPlanComplete(chapters.find((x) => INT(x.idx) === idx)))
    : range;
  const limited = targets.slice(0, Math.max(1, Number(maxCalls) || OUTLINE_AI_MAX_CHAPTERS_PER_CALL));
  const warnings = [];
  const results = [];
  let calls = 0;
  if (targets.length > limited.length) {
    warnings.push(`本次只规划前 ${limited.length} 章，另有 ${targets.length - limited.length} 章未处理，请再次指定范围`);
  }
  for (const idx of limited) {
    const r = await generateChapterPlan(novel, { ...sections, chapters }, idx, { instruction, warnings, ctx });
    const at = chapters.findIndex((x) => INT(x.idx) === idx);
    if (at >= 0) chapters[at] = r.value;
    calls += r.calls;
    results.push({
      idx,
      title: r.value.title,
      length: r.value.summary.length,
      mocked: !!r.mocked,
      model: r.model || '',
      error: r.error || '',
    });
  }
  return {
    sections: { ...sections, chapters },
    results,
    warnings,
    calls,
    requested: limited.length,
    skipped: Math.max(0, targets.length - limited.length),
    from: start,
    to: end,
    stats: chapterPlanStats({ ...sections, chapters }, novel),
  };
}

export function buildSectionPrompt(novel = {}, sections = {}, key, { instruction = '', ctx = null, refText = '' } = {}) {
  const spec = SPEC_BY_KEY.get(key);
  if (!spec) throw new Error(`未知大纲分节：${key}`);
  const c = ctx || contextOf(novel, sections);
  const chapterN = c.chapterMax;
  const castLines = c.cast.slice(0, 60).map((x) => `${x.id} ${x.name}${x.role ? `（${x.role}）` : ''}`).join('\n') || '（未绑定角色，可用 L-/C- 编号留空或按占位编号）';
  const chapterDigest = (Array.isArray(sections.chapters) ? sections.chapters : [])
    .filter((x) => !x?._placeholder)
    .slice(0, 40)
    .map((x) => `第${INT(x?.idx)}章《${TEXT(x?.title, 30)}》：${TEXT(x?.summary, 80)}`)
    .join('\n') || '（章节大纲尚未生成，请按总章数假定节奏）';
  const framework = sections.framework && typeof sections.framework === 'object' ? JSON.stringify(sections.framework) : '（无）';
  return [
    '【小说参数】',
    `书名：${TEXT(novel.title, 60) || '（未命名）'}`,
    `题材：${TEXT(novel.genre, 40)}${novel.sub_genre ? `/ ${TEXT(novel.sub_genre, 40)}` : ''}`,
    `基调：${TEXT(novel.tone, 40)}　视角：${TEXT(novel.pov, 40)}`,
    `规模：目标 ${Number(novel.target_words) || 0} 字 / 单章 ${Number(novel.chapter_words) || 0} 字 / 共 ${chapterN} 章 / ${Number(novel.seasons) || 1} 季`,
    `角色规模：${Number(novel.cast_size) || 0} 人`,
    '',
    assetPromptBlock(c.assets),
    '',
    '【可用角色（只能用这些编号）】',
    castLines,
    '',
    '【既有故事框架】',
    framework,
    `一句话故事（若已有）：${TEXT(sections.logline, 120) || '（无）'}`,
    `世界观（若已有）：${sections.worldview && typeof sections.worldview === 'object' ? JSON.stringify(sections.worldview).slice(0, 400) : '（无）'}`,
    '',
    '【既有章节走向（节选）】',
    chapterDigest,
    '',
    `【本次只需生成这一节】${spec.label}`,
    `输出结构：${spec.shape}`,
    `硬约束：故事优先级=故事大纲 > 正文内容承接 > 头尾逻辑故事线闭环；章号必须在 1..${chapterN} 之间；人物/环境/物品必须使用资产索引 ID；不要输出解释文字。`,
    refText ? `参考范本（仅供风格与桥段参考，不要照抄）：${refText.slice(0, 6000)}` : '',
    instruction ? `额外要求：${TEXT(instruction, 500)}` : '',
    '',
    '只输出 JSON，形如 {"value": <本节结构>}。',
  ].filter(Boolean).join('\n');
}

const AI_SYSTEM = [
  '你是资深网文/漫剧编剧，负责把一部小说的"大纲"补完整。',
  '要求：',
  '1. 只输出 JSON，不要 markdown 围栏、不要解释；',
  '2. 必须与给定的题材、基调、视角、字数规模、章节数一致；',
  '3. 人物必须使用给定的 C-xxxx / CX-xxxx 编号，地点用 L-0001 递增；',
  '4. 所有章号必须落在给定范围内；伏笔的回收章必须晚于埋设章；',
  '5. 中文输出，内容具体可执行（不要"待补充""略"这类占位）。',
  '6. 最高优先级：先服从故事大纲，再保证正文内容承接，最后校验头尾逻辑与故事线闭环；人物、环境、物品必须使用资产索引中的 ID。',
].join('\n');

// 离线/mock 占位内容：保证结构完整、标注清楚，便于先跑通
export function buildMockSection(novel = {}, sections = {}, key, ctx = null) {
  const tag = '【离线占位】';
  const c = ctx || contextOf(novel, sections);
  const N = c.chapterMax;
  const mid = Math.max(2, Math.round(N / 2));
  const cast = c.cast.length ? c.cast : [{ id: 'C-0001', name: '主角', role: '主角' }];
  const title = TEXT(novel.title, 40) || '本书';
  const genre = TEXT(novel.genre, 30) || '本题材';
  switch (key) {
    case 'logline': return `${tag}${title}：主角在${genre}世界里被卷入一场无法回避的冲突，一边守住底线一边对抗更强的对手。`;
    case 'framework':
      return {
        core_conflict: `${tag}主角的生存/真相诉求与既有秩序正面冲突`,
        protagonist_goal: `${tag}先自保，再查明真相，最后打破幕后势力`,
        antagonist_force: `${tag}比主角更强的组织/权贵/规则本身`,
        three_acts: `${tag}入局 → 反击与代价 → 决战收束`,
        theme: `${tag}在极端处境下仍要守住的选择`,
        opening_image: `${tag}用一个反常画面把主角推进事件`,
        ending: `${tag}主角付出代价达成目标，留下余味`,
      };
    case 'storyline':
      return {
        opening_logic: `${tag}开篇用主角最迫切的目标和第一个强钩子抓住读者`,
        story_chain: [
          `${tag}开篇事件导致主角入局`,
          `${tag}主角反击导致对手升级`,
          `${tag}代价迫使主角做出最终选择`,
        ],
        turning_points: [`${tag}中盘反转`, `${tag}终局代价`],
        ending_logic: `${tag}结局回收主线目标，完成人物弧光`,
        head_tail_closure: `${tag}开篇出现的核心信物在结局再次出现并完成闭环`,
        final_image: `${tag}主角站在终局场景中，回望开篇画面`,
      };
    case 'worldview':
      return {
        era: `${tag}${genre}的时代背景`,
        rules: `${tag}世界运行的硬规则（越界就有代价）`,
        power_system: `${tag}力量/资源体系与升级路径`,
        taboos: `${tag}绝对不能碰的禁忌`,
        text: `${tag}补齐社会结构、日常细节与信息差`,
      };
    case 'volumes': {
      const seasons = Math.max(1, Number(novel.seasons) || 1);
      const per = Math.max(1, Math.ceil(N / seasons));
      return Array.from({ length: seasons }, (_, i) => ({
        volume: i + 1,
        title: `${tag}第 ${i + 1} 卷`,
        from_chapter: i * per + 1,
        to_chapter: Math.min(N, (i + 1) * per),
        goal: `${tag}本卷目标`,
        climax: `${tag}本卷高潮`,
        hook: `${tag}本卷收尾留钩`,
      }));
    }
    case 'timeline':
      return [
        { time: `${tag}开局`, event: '主线事件起点', chapter: 1, impact: '把主角推进主线' },
        { time: `${tag}中盘`, event: '第一次重大代价', chapter: mid, impact: '逼主角升级目标' },
        { time: `${tag}终局`, event: '决战与收束', chapter: N, impact: '主线闭环' },
      ];
    case 'locations':
      return [
        { id: 'L-0001', name: `${tag}主场景`, type: '场景', desc: '故事主要发生地', first_chapter: 1 },
        { id: 'L-0002', name: `${tag}对立面据点`, type: '场景', desc: '反派势力所在', first_chapter: mid },
      ];
    case 'characters':
      return cast.slice(0, 20).map((x) => ({
        id: x.id, name: x.name, role: x.role || '配角',
        arc: `${tag}角色弧光`, function: `${tag}在主线中的作用`, relationships: `${tag}与主角的关系`,
      }));
    case 'foreshadow':
      return [
        { id: 'FS-01', content: `${tag}开篇出现的关键物件`, setup_chapter: 1, payoff_chapter: N, status: '待回收', payoff_way: '决战时成为破局关键' },
        { id: 'FS-02', content: `${tag}某句被忽略的台词`, setup_chapter: Math.max(1, Math.round(N / 4)), payoff_chapter: mid, status: '待回收', payoff_way: '身份反转时被引用' },
      ];
    case 'reversals':
      return [{ chapter: mid, content: `${tag}身份/立场反转`, impact: '盟友变对手', foreshadow: 'FS-02' }];
    case 'beats':
      return [
        { chapter: 1, type: '爽点', intensity: 7, note: `${tag}开篇立住主角` },
        { chapter: mid, type: '压抑', intensity: 9, note: `${tag}最大低谷` },
        { chapter: N, type: '爽点', intensity: 10, note: `${tag}决战释放` },
      ];
    case 'hooks':
      return [
        { chapter: 1, content: `${tag}章末抛出反常信息`, note: '留住读者' },
        { chapter: mid, content: `${tag}章末亮出底牌`, note: '制造悬念' },
      ];
    case 'loops':
      return [{ from: 1, to: N, relation: '呼应', cause: `${tag}开篇画面在结尾重现` }];
    case 'logic':
      return [
        { from: `${tag}开局事件`, to: '主角入局', relation: '导致', cause: '事件把主角逼到必须选择' },
        { from: '主角反击', to: '对手升级手段', relation: '导致', cause: '双方资源不对等' },
      ];
    default: return null;
  }
}

export function normalizeSection(key, raw, ctx) {
  const spec = SPEC_BY_KEY.get(key);
  if (!spec) throw new Error(`未知大纲分节：${key}`);
  const value = raw && typeof raw === 'object' && 'value' in raw && Object.keys(raw).length === 1 ? raw.value : raw;
  return spec.normalize(value, ctx);
}

export async function generateSection(novel, sections, key, { instruction = '', warnings = [] } = {}) {
  const spec = SPEC_BY_KEY.get(key);
  if (!spec) throw new Error(`未知大纲分节：${key}`);
  const ctx = contextOf(novel, sections);
  const status = llmStatus();
  if (status?.provider === 'mock') {
    warnings.push(`大纲「${spec.label}」使用离线占位内容（当前 LLM 为 mock）`);
    return { key, label: spec.label, value: normalizeSection(key, buildMockSection(novel, sections, key, ctx), ctx), mocked: true, calls: 0 };
  }
  const prompt = buildSectionPrompt(novel, sections, key, { instruction, ctx, refText: referenceSnippet(novel) });
  try {
    const out = await chatJSON({ system: AI_SYSTEM, prompt, temperature: 0.8 });
    const value = normalizeSection(key, out?.data, ctx);
    if (isEmptySection(key, value)) throw new Error('模型返回内容为空');
    return { key, label: spec.label, value, mocked: false, model: out?.model || '', calls: 1 };
  } catch (err) {
    warnings.push(`大纲「${spec.label}」AI 生成失败，已用离线占位替代：${err.message}`);
    return { key, label: spec.label, value: normalizeSection(key, buildMockSection(novel, sections, key, ctx), ctx), mocked: true, calls: 1, error: err.message };
  }
}

// 逐节补齐（默认只补空缺；keys 可指定；chapters 默认跳过）
export async function fillSections(novel, sections, { keys = null, instruction = '', onlyEmpty = true, maxCalls = 14 } = {}) {
  const wanted = (Array.isArray(keys) && keys.length ? keys : OUTLINE_AI_DEFAULT_KEYS).filter((k) => SPEC_BY_KEY.has(k));
  const targets = onlyEmpty ? wanted.filter((k) => isEmptySection(k, sections[k])) : wanted;
  const warnings = [];
  const out = { ...sections };
  const results = [];
  let calls = 0;
  for (const key of targets) {
    if (calls >= maxCalls) { warnings.push(`已达到单次 ${maxCalls} 次模型调用上限，剩余分节未生成`); break; }
    const r = await generateSection(novel, out, key, { instruction, warnings });
    out[key] = r.value;
    calls += r.calls;
    results.push({ key, label: r.label, mocked: !!r.mocked, model: r.model || '', error: r.error || '' });
  }
  return { sections: out, results, warnings, calls, requested: targets.length };
}

// 写成一个新的大纲版本，并同步章节骨架
export function saveOutlineVersion(novelId, sections, { source = 'ai-section-fill', model = '', tokens = 0, note = '' } = {}) {
  const novel = get('SELECT * FROM novels WHERE id = ?', novelId);
  if (!novel) throw new Error('小说不存在');
  const latest = get('SELECT COALESCE(MAX(version), 0) AS v FROM novel_outlines WHERE novel_id = ?', novelId);
  const version = Number(latest?.v || 0) + 1;
  const id = rid('O');
  const now = nowISO();
  const payload = { ...sections, meta: { ...(sections.meta && typeof sections.meta === 'object' ? sections.meta : {}), source, note: TEXT(note, 200), generatedAt: now } };
  run(
    `INSERT INTO novel_outlines(id, novel_id, version, status, payload, raw, model, tokens, elapsed_ms, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    id, novelId, version, 'ready', JSON.stringify(payload), '', model || source, Number(tokens) || 0, 0, now, now,
  );
  const chapters = Array.isArray(payload.chapters) ? payload.chapters : [];
  let synced = null;
  try { synced = syncChapterSkeletons(novelId, id, { chapters }); } catch { /* 章节骨架同步失败不影响大纲落库 */ }
  return { id, version, chapters: chapters.length, synced, note: `已保存为大纲 v${version}（来源：${source}）` };
}

export function outlineAiStatus(novelId) {
  const novel = get('SELECT * FROM novels WHERE id = ?', novelId);
  if (!novel) throw new Error('小说不存在');
  const row = get('SELECT * FROM novel_outlines WHERE novel_id = ? ORDER BY version DESC LIMIT 1', novelId);
  const sections = sectionsOf(row ? { ...row, data: safeJsonSections(row.payload) } : null);
  const statusKeys = OUTLINE_AI_STATUS_SECTIONS.map((s) => s.key);
  const missing = missingSectionKeys(sections, statusKeys);
  return {
    ok: true,
    novelId,
    hasOutline: Boolean(row),
    outlineId: row?.id || null,
    version: Number(row?.version || 0),
    sections: OUTLINE_AI_STATUS_SECTIONS.map((s) => ({
      key: s.key,
      label: s.label,
      empty: isEmptySection(s.key, sections[s.key]),
      size: Array.isArray(sections[s.key]) ? sections[s.key].length : (sections[s.key] && typeof sections[s.key] === 'object' ? Object.keys(sections[s.key]).length : (sections[s.key] ? 1 : 0)),
    })),
    chapterStats: chapterPlanStats(sections, novel),
    missing,
    fillable: missing.filter((k) => k !== 'chapters'),
  };
}

function safeJsonSections(v) {
  try {
    const o = JSON.parse(v || '{}');
    return o && typeof o === 'object' ? o : {};
  } catch { return {}; }
}

export function loadSections(novelId) {
  const row = get('SELECT * FROM novel_outlines WHERE novel_id = ? ORDER BY version DESC LIMIT 1', novelId);
  return row ? safeJsonSections(row.payload) : {};
}

export function novelOf(novelId) {
  const novel = get('SELECT * FROM novels WHERE id = ?', novelId);
  if (!novel) throw new Error('小说不存在');
  return novel;
}

export function referenceSnippet(novel) {
  const rel = TEXT(novel?.ref_doc_path, 400);
  if (!rel) return '';
  try {
    const abs = resolveAsset(rel);
    if (!abs || !fs.existsSync(abs)) return '';
    return fs.readFileSync(abs, 'utf8').replace(/^\uFEFF/, '').slice(0, OUTLINE_AI_MAX_REF_CHARS);
  } catch { return ''; }
}
