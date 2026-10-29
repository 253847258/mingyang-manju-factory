// 小说工坊四步生产线：章纲 → 章节内容卡 → 资产布置 → 正文续写。
// 本模块只写明文数据，不改混淆层；流程状态存于最新 novel_outlines.payload.pipeline。

import { createHash, randomUUID } from 'node:crypto';
import { all, get, run } from './db.js';
import { chat, chatJSON, llmStatus } from './llm.js';
import { nowISO } from './util.js';
import { loadSections, novelOf, saveOutlineVersion } from './novel-outline-ai.js';
import { buildNovelAssets } from './novel-assets.js';
import { countWords } from './modules/novel.js';
import { writeLongChapter } from './novel-writing.js';
import { cleanPrompt, lintPrompt } from './prompt-lint.js';

export const PIPELINE_VERSION = 1;
export const PIPELINE_STEPS = Object.freeze([
  { key: 'outline', label: '生成章节大纲' },
  { key: 'cards', label: '生成章节内容卡' },
  { key: 'assets', label: '布置资产与画布参考' },
  { key: 'prose', label: '续写正文' },
]);

const TEXT = (v, max = 500) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const MULTI = (v, max = 3000) => String(v ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max);
const INT = (v) => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const safeJson = (v, fallback) => {
  if (v && typeof v === 'object') return v;
  try {
    const out = JSON.parse(v || '');
    return out == null ? fallback : out;
  } catch { return fallback; }
};
const uniq = (items) => [...new Set(items.filter(Boolean))];
const norm = (v) => TEXT(v, 100).toLowerCase().replace(/[\s·・,，。；;：:（）()【】\[\]“”"']/g, '');
const makeId = (prefix) => `${prefix}-${randomUUID()}`;

function latestOutlineRow(novelId) {
  return get('SELECT * FROM novel_outlines WHERE novel_id = ? ORDER BY version DESC, rowid DESC LIMIT 1', novelId) || null;
}

function chapterPlanMap(sections) {
  return new Map((Array.isArray(sections?.chapters) ? sections.chapters : [])
    .map((x, i) => [INT(x?.idx) || i + 1, x]));
}

function chapterRows(novelId) {
  return all('SELECT * FROM novel_chapters WHERE novel_id = ? ORDER BY idx', novelId);
}

function emptyPipeline() {
  return {
    version: PIPELINE_VERSION,
    chapter_cards: {},
    asset_plan: { assets: [], by_chapter: {}, updated_at: '', blockers: [] },
    asset_confirmation: null,
    prose_history: {},
    prose_audit: [],
    updated_at: '',
  };
}

export function pipelineOf(sections = {}) {
  const raw = sections?.pipeline && typeof sections.pipeline === 'object' ? sections.pipeline : {};
  const pipeline = {
    ...emptyPipeline(),
    ...raw,
    chapter_cards: raw.chapter_cards && typeof raw.chapter_cards === 'object' ? raw.chapter_cards : {},
    asset_plan: {
      ...emptyPipeline().asset_plan,
      ...(raw.asset_plan && typeof raw.asset_plan === 'object' ? raw.asset_plan : {}),
      assets: Array.isArray(raw.asset_plan?.assets) ? raw.asset_plan.assets : [],
      by_chapter: raw.asset_plan?.by_chapter && typeof raw.asset_plan.by_chapter === 'object' ? raw.asset_plan.by_chapter : {},
    },
    prose_history: raw.prose_history && typeof raw.prose_history === 'object' ? raw.prose_history : {},
    prose_audit: Array.isArray(raw.prose_audit) ? raw.prose_audit : [],
  };
  return pipeline;
}

function savePipeline(novelId, sections, pipeline, source, note = '') {
  const next = {
    ...sections,
    pipeline: { ...pipeline, version: PIPELINE_VERSION, updated_at: nowISO() },
  };
  const saved = saveOutlineVersion(novelId, next, { source, note });
  return { sections: next, pipeline: next.pipeline, saved };
}

function cardComplete(card) {
  return Boolean(
    card
    && String(card.objective || '').trim()
    && String(card.conflict || '').trim()
    && String(card.result || '').trim()
    && Array.isArray(card.beats)
    && card.beats.length >= 3
    && String(card.key_frame || '').trim(),
  );
}

function chapterPlanComplete(chapter) {
  return Boolean(chapter && (String(chapter.title || '').trim() || String(chapter.summary || '').trim()));
}

export function pipelineSnapshot(novelId) {
  const novel = novelOf(novelId);
  const row = latestOutlineRow(novelId);
  const sections = row ? safeJson(row.payload, {}) : {};
  const pipeline = pipelineOf(sections);
  const plans = chapterPlanMap(sections);
  const rows = chapterRows(novelId);
  const expected = Math.max(
    plans.size,
    rows.length,
    Math.ceil((Number(novel.target_words) || 0) / Math.max(1, Number(novel.chapter_words) || 3000)),
  );
  const byIdx = new Map(rows.map((x) => [Number(x.idx), x]));
  const outlineComplete = [...plans.entries()].filter(([, c]) => chapterPlanComplete(c)).length;
  const cards = Object.values(pipeline.chapter_cards).filter(cardComplete);
  const assets = pipeline.asset_plan.assets || [];
  const confirmed = Boolean(pipeline.asset_confirmation?.confirmed);
  const proseDone = rows.filter((x) => x.status === 'done' && String(x.content || '').trim()).length;
  const blockers = [];
  if (!row || !plans.size) blockers.push('还没有章节大纲');
  if (outlineComplete < plans.size && plans.size) blockers.push(`还有 ${plans.size - outlineComplete} 章大纲不完整`);
  if (cards.length < plans.size && plans.size) blockers.push(`还有 ${Math.max(0, plans.size - cards.length)} 章内容卡未生成`);
  const assetBlockers = Array.isArray(pipeline.asset_plan.blockers) ? pipeline.asset_plan.blockers.filter(Boolean) : [];
  if (!assets.length) blockers.push('还没有章节资产计划');
  if (!confirmed) blockers.push('资产计划尚未人工确认');
  if (assetBlockers.length) blockers.push(...assetBlockers.slice(0, 20));
  const steps = [
    {
      key: 'outline', label: PIPELINE_STEPS[0].label,
      complete: Boolean(row && plans.size && outlineComplete === plans.size),
      done: outlineComplete, total: plans.size || expected,
      blockers: !row || !plans.size ? ['还没有章节大纲'] : (outlineComplete < plans.size ? [`${plans.size - outlineComplete} 章大纲不完整`] : []),
      action: 'outline',
    },
    {
      key: 'cards', label: PIPELINE_STEPS[1].label,
      complete: Boolean(plans.size && cards.length >= plans.size),
      done: cards.length, total: plans.size,
      blockers: !plans.size ? ['请先生成章节大纲'] : (cards.length < plans.size ? ['还有章节内容卡未生成'] : []),
      action: 'cards',
    },
    {
      key: 'assets', label: PIPELINE_STEPS[2].label,
      complete: Boolean(assets.length && confirmed),
      done: assets.length, total: assets.length,
      blockers: assets.length ? (confirmed ? [] : ['资产计划待确认']) : ['请先生成章节内容卡并布置资产'],
      action: 'assets',
    },
    {
      key: 'prose', label: PIPELINE_STEPS[3].label,
      complete: Boolean(expected && proseDone >= expected),
      done: proseDone, total: expected,
      blockers: confirmed ? [] : ['资产未确认，不能批量续写'],
      action: 'prose',
    },
  ];
  return {
    ok: true,
    novelId,
    novel,
    outlineId: row?.id || null,
    outlineVersion: Number(row?.version || 0),
    sections,
    pipeline,
    rows: rows.map((x) => ({ ...x, content: undefined })),
    summary: {
      expected, outlineComplete, cards: cards.length, assets: assets.length,
      confirmed, proseDone, blockers: uniq(blockers),
    },
    steps,
  };
}

function catalogFor(novel, sections) {
  const raw = buildNovelAssets(novel, sections);
  const allAssets = [
    ...(raw.characters || []).map((x) => ({ ...x, kind: 'character' })),
    ...(raw.environments || []).map((x) => ({ ...x, kind: 'environment' })),
    ...(raw.props || []).map((x) => ({ ...x, kind: 'prop' })),
  ];
  const byId = new Map(allAssets.map((x) => [String(x.id || '').toUpperCase(), x]));
  const byName = new Map(allAssets.map((x) => [norm(x.name), x]).filter(([k]) => k));
  return { raw, assets: allAssets, byId, byName };
}

function normalizeEntity(item, kind, catalog) {
  if (typeof item === 'string') {
    const value = TEXT(item, 100);
    const idMatch = value.match(/\b(?:CX|C|L|P)-\d{4,}\b/i);
    const id = idMatch ? idMatch[0].toUpperCase() : '';
    const name = id ? TEXT(value.replace(idMatch[0], ''), 100) : value;
    const match = (id && catalog.byId.get(id)) || (name && catalog.byName.get(norm(name))) || null;
    return {
      id: TEXT(match?.id || id, 30),
      name: TEXT(match?.name || name || id, 100),
      role: TEXT(match?.role || '', 100),
      desc: MULTI(match?.desc || '', 500),
      kind,
    };
  }
  const id = TEXT(item?.id ?? item?.asset_id ?? '', 30).toUpperCase();
  const name = TEXT(item?.name ?? item?.title ?? '', 100);
  const match = (id && catalog.byId.get(id)) || (name && catalog.byName.get(norm(name))) || null;
  return {
    id: TEXT(match?.id || id, 30),
    name: TEXT(match?.name || name || id, 100),
    role: TEXT(item?.role || item?.function || match?.role || '', 100),
    desc: MULTI(item?.desc || item?.description || match?.desc || '', 500),
    kind,
  };
}

function sentences(text) {
  return MULTI(text, 8000)
    .split(/(?<=[。！？!?])|\n+/)
    .map((x) => TEXT(x, 300))
    .filter((x) => x.length >= 8);
}

function findMentioned(text, list, max = 20) {
  const source = String(text || '');
  const n = norm(source);
  return list.filter((x) => {
    const id = String(x.id || '').toUpperCase();
    return (id && source.toUpperCase().includes(id)) || (x.name && n.includes(norm(x.name)));
  }).slice(0, max);
}

export function buildDeterministicChapterCard(novelId, idx, instruction = '') {
  const snapshot = pipelineSnapshot(novelId);
  const plan = chapterPlanMap(snapshot.sections).get(Number(idx)) || {};
  const catalog = catalogFor(snapshot.novel, snapshot.sections);
  const sourceText = [plan.summary, plan.start_state, plan.end_state, plan.handoff_in, plan.handoff_out, plan.cliffhanger, ...(plan.events || [])].join('\n');
  const eventList = (Array.isArray(plan.events) && plan.events.length ? plan.events : sentences(plan.summary)).slice(0, 8);
  while (eventList.length < 3) eventList.push(eventList.length === 0 ? '主角发现新的异常线索' : `冲突继续升级（${eventList.length + 1}）`);
  const mentionedChars = findMentioned(sourceText, catalog.raw.characters || []);
  const mentionedEnvs = findMentioned(sourceText, catalog.raw.environments || []);
  const mentionedProps = findMentioned(sourceText, catalog.raw.props || []);
  const declaredChars = (Array.isArray(plan.characters) ? plan.characters : []).map((x) => normalizeEntity(x, 'character', catalog));
  const declaredEnvs = (Array.isArray(plan.locations) ? plan.locations : []).map((x) => normalizeEntity(x, 'environment', catalog));
  const beats = eventList.map((event, i) => ({
    order: i + 1,
    time: TEXT(plan.time || (i === 0 ? '承接上一章' : `本章第 ${i + 1} 个阶段`), 80),
    location: TEXT(declaredEnvs[0]?.name || mentionedEnvs[0]?.name || '', 100),
    characters: uniq([...(declaredChars.length ? declaredChars : mentionedChars).map((x) => x.name)]).slice(0, 8),
    environments: uniq((declaredEnvs.length ? declaredEnvs : mentionedEnvs).map((x) => x.name)).slice(0, 5),
    props: uniq(mentionedProps.map((x) => x.name)).slice(0, 8),
    action: TEXT(event, 500),
    emotion: TEXT(i === eventList.length - 1 ? '紧迫、悬念' : '推进、对抗', 60),
    visual: `${i === 0 ? '中景' : i === eventList.length - 1 ? '近景' : '中近景'}，${declaredEnvs[0]?.name || mentionedEnvs[0]?.name || '主要场景'}，围绕“${TEXT(event, 100)}”组织画面焦点`,
  }));
  const keyFrame = `${beats[beats.length - 1]?.visual || '近景'}；关键动作：${beats[beats.length - 1]?.action || '主角做出决定性选择'}；章末钩子：${TEXT(plan.cliffhanger || plan.hook || plan.handoff_out || '新的危险逼近', 300)}`;
  return {
    idx: Number(idx),
    title: TEXT(plan.title || `第${idx}章`, 100),
    objective: TEXT(plan.summary || plan.handoff_out || `推进第 ${idx} 章主线`, 800),
    conflict: TEXT(plan.events?.[0] || plan.summary || '主角目标与阻力发生正面碰撞', 500),
    turning_point: TEXT(plan.events?.[Math.floor((eventList.length - 1) / 2)] || '关键线索改变局势', 500),
    result: TEXT(plan.end_state || plan.handoff_out || '本章目标达成，但出现更大代价', 500),
    start_state: MULTI(plan.start_state || plan.handoff_in || '', 1200),
    end_state: MULTI(plan.end_state || plan.handoff_out || '', 1200),
    beats,
    characters: uniq([...(declaredChars.length ? declaredChars : mentionedChars).map((x) => `${x.id || x.name} ${x.name}`)]),
    environments: uniq((declaredEnvs.length ? declaredEnvs : mentionedEnvs).map((x) => `${x.id || x.name} ${x.name}`)),
    props: uniq(mentionedProps.map((x) => `${x.id || x.name} ${x.name}`)),
    key_frame: keyFrame,
    instruction: TEXT(instruction, 500),
    source: 'deterministic',
    completed: true,
    updated_at: nowISO(),
  };
}

function normalizeCard(raw, fallback, catalog) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const chars = Array.isArray(o.characters) ? o.characters : [];
  const envs = Array.isArray(o.environments) ? o.environments : [];
  const props = Array.isArray(o.props) ? o.props : [];
  const beats = (Array.isArray(o.beats) ? o.beats : fallback.beats).map((b, i) => ({
    order: INT(b?.order) || i + 1,
    time: TEXT(b?.time, 80),
    location: TEXT(b?.location, 100),
    characters: Array.isArray(b?.characters) ? b.characters.map((x) => TEXT(x, 100)).filter(Boolean).slice(0, 12) : [],
    environments: Array.isArray(b?.environments) ? b.environments.map((x) => TEXT(x, 100)).filter(Boolean).slice(0, 8) : [],
    props: Array.isArray(b?.props) ? b.props.map((x) => TEXT(x, 100)).filter(Boolean).slice(0, 12) : [],
    action: TEXT(b?.action, 600),
    emotion: TEXT(b?.emotion, 100),
    visual: TEXT(b?.visual, 600),
  })).filter((b) => b.action || b.visual).slice(0, 8);
  const card = {
    ...fallback,
    title: TEXT(o.title || fallback.title, 100),
    objective: TEXT(o.objective || o.goal || fallback.objective, 1000),
    conflict: TEXT(o.conflict || fallback.conflict, 800),
    turning_point: TEXT(o.turning_point || fallback.turning_point, 800),
    result: TEXT(o.result || fallback.result, 800),
    start_state: MULTI(o.start_state || fallback.start_state, 1600),
    end_state: MULTI(o.end_state || fallback.end_state, 1600),
    beats: beats.length >= 3 ? beats : fallback.beats,
    characters: chars.length ? chars.map((x) => {
      const e = normalizeEntity(x, 'character', catalog);
      return `${e.id || e.name} ${e.name}`;
    }) : fallback.characters,
    environments: envs.length ? envs.map((x) => {
      const e = normalizeEntity(x, 'environment', catalog);
      return `${e.id || e.name} ${e.name}`;
    }) : fallback.environments,
    props: props.length ? props.map((x) => {
      const e = normalizeEntity(x, 'prop', catalog);
      return `${e.id || e.name} ${e.name}`;
    }) : fallback.props,
    key_frame: TEXT(o.key_frame || o.visual_key_frame || fallback.key_frame, 1000),
    source: o.source || 'ai',
    completed: true,
    updated_at: nowISO(),
  };
  if (!cardComplete(card)) throw new Error(`第 ${fallback.idx} 章内容卡结构不完整`);
  return card;
}

function cardPrompt(novel, plan, idx, instruction) {
  return [
    '你是电影化长篇小说制片编辑。请把章节大纲扩成可执行的“章节内容卡”，不写正文。',
    `小说：${novel.title || ''}｜题材：${novel.genre || ''}｜基调：${novel.tone || ''}`,
    `第 ${idx} 章大纲：`,
    JSON.stringify(plan, null, 2).slice(0, 12000),
    instruction ? `额外要求：${instruction}` : '',
    '只输出 JSON：{"title":"","objective":"","conflict":"","turning_point":"","result":"","start_state":"","end_state":"","beats":[{"order":1,"time":"","location":"","characters":[],"environments":[],"props":[],"action":"","emotion":"","visual":""}],"characters":[{"id":"","name":""}],"environments":[{"id":"","name":""}],"props":[{"id":"","name":""}],"key_frame":""}',
    '要求：3-8 个情节点；每个情节点必须可拍；人物/环境/物品沿用已有 ID；不要输出正文。',
  ].filter(Boolean).join('\n');
}

export async function generateChapterCards(novelId, { from = 1, to = null, onlyMissing = true, instruction = '', onProgress = null, isCanceled = null } = {}) {
  const snapshot = pipelineSnapshot(novelId);
  const plans = chapterPlanMap(snapshot.sections);
  if (!plans.size) throw new Error('请先生成章节大纲');
  const max = Math.max(...plans.keys());
  const start = Math.min(Math.max(1, Number(from) || 1), max);
  const end = Math.min(Math.max(start, Number(to) || start), max);
  if (end - start + 1 > 50) throw new Error('单次最多生成 50 章内容卡');
  const catalog = catalogFor(snapshot.novel, snapshot.sections);
  const cards = { ...snapshot.pipeline.chapter_cards };
  const warnings = [];
  let generated = 0;
  let skipped = 0;
  const status = llmStatus();
  for (let idx = start; idx <= end; idx += 1) {
    if (isCanceled?.()) throw new Error('任务已取消');
    if (onlyMissing && cardComplete(cards[idx])) { skipped += 1; continue; }
    const fallback = buildDeterministicChapterCard(novelId, idx, instruction);
    let card = fallback;
    if (status?.provider !== 'mock') {
      try {
        const out = await chatJSON({ system: '你是电影化小说制片编辑，只输出严格 JSON。', prompt: cardPrompt(snapshot.novel, plans.get(idx) || {}, idx, instruction), temperature: 0.55, maxTokens: 5000 });
        card = normalizeCard(out?.data, fallback, catalog);
        card.source = 'ai';
        card.model = out?.model || '';
      } catch (error) {
        warnings.push(`第 ${idx} 章 AI 内容卡失败，已使用可执行模板：${error.message}`);
        card = fallback;
      }
    } else {
      card.mocked = true;
    }
    cards[idx] = card;
    generated += 1;
    onProgress?.({ done: generated + skipped, total: end - start + 1, idx });
    if (generated % 5 === 0) {
      const p = { ...snapshot.pipeline, chapter_cards: cards };
      savePipeline(novelId, snapshot.sections, p, 'pipeline:chapter-cards-progress', `第${start}-${idx}章内容卡`);
    }
  }
  const pipeline = { ...snapshot.pipeline, chapter_cards: cards, asset_confirmation: null };
  const saved = savePipeline(novelId, snapshot.sections, pipeline, 'pipeline:chapter-cards', `第${start}-${end}章`);
  return { ok: true, from: start, to: end, generated, skipped, warnings, mocked: status?.provider === 'mock', saved, pipeline };
}

export function saveChapterCard(novelId, idx, patch = {}) {
  const snapshot = pipelineSnapshot(novelId);
  const existing = snapshot.pipeline.chapter_cards[idx] || buildDeterministicChapterCard(novelId, idx);
  const card = normalizeCard({ ...existing, ...patch }, existing, catalogFor(snapshot.novel, snapshot.sections));
  const cards = { ...snapshot.pipeline.chapter_cards, [idx]: card };
  const pipeline = { ...snapshot.pipeline, chapter_cards: cards, asset_confirmation: null };
  const saved = savePipeline(novelId, snapshot.sections, pipeline, 'pipeline:chapter-card-save', `第${idx}章内容卡`);
  return { ok: true, card, saved };
}

function nextSequence(list, prefix) {
  const max = list.reduce((m, x) => {
    const match = String(x.id || '').match(new RegExp(`^${prefix}-(\\d{4,})$`, 'i'));
    return match ? Math.max(m, Number(match[1])) : m;
  }, 0);
  return max + 1;
}

function makeImagePrompt(kind, name, desc, role = '') {
  const visual = cleanPrompt(desc || role || name);
  if (kind === 'character') {
    return `${name}，电影级写实人物设定，${visual || role || '五官清晰、服装完整'}，正面半身，中景，柔和侧逆光，真实皮肤纹理，35mm 镜头，电影调色，角色一致性参考图`;
  }
  if (kind === 'environment') {
    return `${name}，电影场景概念设计，${visual || role || '空间层次清晰'}，广角远景，环境光完整，材质细节丰富，35mm 镜头，真实电影质感`;
  }
  return `${name}，电影道具设定，${visual || role || '结构、材质和尺度清晰'}，主体居中，近景，棚拍柔光，真实材质，产品级细节`;
}

function promptIssue(prompt) {
  const result = lintPrompt(prompt, { maxLen: 1200, requireShotWord: true });
  return result.issues.find((x) => x.severity === 'blocker') || null;
}

export function buildAssetPlan(novelId, { chapterFrom = null, chapterTo = null } = {}) {
  const snapshot = pipelineSnapshot(novelId);
  const cards = snapshot.pipeline.chapter_cards;
  const cardList = Object.values(cards).filter(cardComplete).filter((card) => {
    if (chapterFrom && Number(card.idx) < Number(chapterFrom)) return false;
    if (chapterTo && Number(card.idx) > Number(chapterTo)) return false;
    return true;
  });
  if (!cardList.length) throw new Error('请先生成章节内容卡');
  const catalog = catalogFor(snapshot.novel, snapshot.sections);
  const entries = new Map();
  const byChapter = {};
  const previousAssets = Array.isArray(snapshot.pipeline.asset_plan?.assets) ? snapshot.pipeline.asset_plan.assets : [];
  const previousByName = new Map(previousAssets.map((asset) => [`${asset.kind}:${norm(asset.name)}`, asset]));
  let seqC = nextSequence([...(catalog.raw.characters || []), ...previousAssets.filter((a) => a.kind === 'character')], 'CX');
  let seqL = nextSequence([...(catalog.raw.environments || []), ...previousAssets.filter((a) => a.kind === 'environment')], 'L');
  let seqP = nextSequence([...(catalog.raw.props || []), ...previousAssets.filter((a) => a.kind === 'prop')], 'P');

  const upsert = (raw, kind, card, beat = null) => {
    const entity = normalizeEntity(raw, kind, catalog);
    const previous = previousByName.get(`${kind}:${norm(entity.name || entity.id)}`);
    let id = entity.id || previous?.id || '';
    if (!id) {
      if (kind === 'character') id = `CX-${String(seqC++).padStart(4, '0')}`;
      else if (kind === 'environment') id = `L-${String(seqL++).padStart(4, '0')}`;
      else id = `P-${String(seqP++).padStart(4, '0')}`;
    }
    const key = `${kind}:${id}`;
    const old = entries.get(key) || (previous ? structuredClone(previous) : {
      key, id, kind, name: entity.name || id, role: entity.role || '',
      description: entity.desc || '', chapters: [], beat_refs: [],
      existing: Boolean(entity.id && catalog.byId.has(entity.id.toUpperCase())),
      source: entity.id && catalog.byId.has(entity.id.toUpperCase()) ? 'existing_asset' : 'chapter_card',
      required: true, status: 'ready', canvas_node_id: '', reference_images: [],
    });
    old.key = key;
    old.id = id;
    old.kind = kind;
    old.name = old.name || entity.name || id;
    old.role = old.role || entity.role || '';
    old.description = old.description || entity.desc || '';
    old.chapters = uniq([...(old.chapters || []), Number(card.idx)]);
    old.beat_refs = Array.isArray(old.beat_refs) ? old.beat_refs : [];
    if (beat) old.beat_refs.push({ chapter: Number(card.idx), order: beat.order, action: beat.action, visual: beat.visual });
    entries.set(key, old);
    return key;
  };

  for (const card of cardList) {
    byChapter[card.idx] = new Set(byChapter[card.idx] || []);
    const declared = [
      ...(card.characters || []).map((x) => [x, 'character']),
      ...(card.environments || []).map((x) => [x, 'environment']),
      ...(card.props || []).map((x) => [x, 'prop']),
    ];
    for (const [value, kind] of declared) {
      byChapter[card.idx].add(upsert(value, kind, card));
    }
    for (const beat of card.beats || []) {
      for (const [kind, value] of [...(beat.characters || []).map((x) => ['character', x]), ...(beat.environments || []).map((x) => ['environment', x]), ...(beat.props || []).map((x) => ['prop', x])]) {
        byChapter[card.idx].add(upsert(value, kind, card, beat));
      }
    }
  }

  const catalogItems = catalog.assets || [];
  for (const card of cardList) {
    const source = JSON.stringify(card);
    for (const entity of catalogItems) {
      if ((entity.id && source.toUpperCase().includes(String(entity.id).toUpperCase())) || (entity.name && norm(source).includes(norm(entity.name)))) {
        byChapter[card.idx].add(upsert(entity, entity.kind, card));
      }
    }
  }

  const assets = [...entries.values()].map((asset) => {
    const boundActor = asset.kind !== 'character' || Boolean(get('SELECT id FROM actors WHERE id = ?', asset.id));
    const prompt = asset.prompt || makeImagePrompt(asset.kind, asset.name, asset.description, asset.role);
    const negative = asset.negative_prompt || (asset.kind === 'character'
      ? '卡通、动漫、插画、CG 塑料感、畸变、多手指、水印、文字、低清晰度'
      : '卡通、动漫、插画、CG 塑料感、畸变、水印、文字、低清晰度、错误透视');
    const issue = promptIssue(prompt);
    const blockers = [];
    if (!prompt || issue) blockers.push(`${asset.name}：生图提示词不可用`);
    if (asset.kind === 'character' && !boundActor) blockers.push(`${asset.name}：人物未绑定演员资产`);
    return {
      ...asset,
      existing: asset.kind === 'character' ? boundActor : asset.existing,
      prompt, negative_prompt: negative,
      ratio: asset.kind === 'character' ? '2:3' : asset.kind === 'environment' ? '16:9' : '1:1',
      prompt_issues: prompt ? lintPrompt(prompt, { maxLen: 1200 }).issues : [],
      blockers,
      status: blockers.length ? 'blocked' : 'ready',
      required: asset.required !== false,
      updated_at: nowISO(),
    };
  });
  const blockers = assets.flatMap((a) => a.required ? a.blockers : []);
  const plan = {
    assets,
    by_chapter: Object.fromEntries(Object.entries(byChapter).map(([k, v]) => [k, [...v]])),
    blockers,
    chapter_from: chapterFrom || null,
    chapter_to: chapterTo || null,
    updated_at: nowISO(),
    catalog: { characters: catalog.raw.characters?.length || 0, environments: catalog.raw.environments?.length || 0, props: catalog.raw.props?.length || 0 },
  };
  const pipeline = { ...snapshot.pipeline, asset_plan: plan, asset_confirmation: null };
  const saved = savePipeline(novelId, snapshot.sections, pipeline, 'pipeline:asset-plan', '按章节内容卡生成资产计划');
  return { ok: true, plan, saved, blockers };
}

export function getAssetPlan(novelId) {
  const snapshot = pipelineSnapshot(novelId);
  return { ok: true, plan: snapshot.pipeline.asset_plan, confirmation: snapshot.pipeline.asset_confirmation };
}

export function updatePipelineAsset(novelId, assetId, patch = {}) {
  const snapshot = pipelineSnapshot(novelId);
  const plan = structuredClone(snapshot.pipeline.asset_plan || { assets: [], by_chapter: {} });
  const key = String(assetId || '');
  const index = (plan.assets || []).findIndex((a) => a.id === key || a.key === key);
  if (index < 0) throw new Error(`资产计划不存在：${key}`);
  const current = plan.assets[index];
  const next = { ...current };
  if ('prompt' in patch) next.prompt = cleanPrompt(patch.prompt);
  if ('negative_prompt' in patch) next.negative_prompt = cleanPrompt(patch.negative_prompt);
  if ('required' in patch) next.required = patch.required !== false;
  if ('reference_images' in patch) next.reference_images = Array.isArray(patch.reference_images) ? patch.reference_images.map((x) => TEXT(x, 500)).filter(Boolean) : [];
  if ('ratio' in patch) next.ratio = TEXT(patch.ratio, 30) || next.ratio;
  if ('role' in patch) next.role = TEXT(patch.role, 100);
  next.prompt_issues = lintPrompt(next.prompt || '', { maxLen: 1200 }).issues;
  next.blockers = [];
  if (!next.prompt || next.prompt_issues.some((i) => i.severity === 'blocker')) next.blockers.push(`${next.name}：生图提示词不可用`);
  if (next.kind === 'character' && !next.existing) next.blockers.push(`${next.name}：人物未绑定演员资产`);
  next.status = next.blockers.length ? 'blocked' : 'ready';
  next.updated_at = nowISO();
  plan.assets[index] = next;
  plan.blockers = plan.assets.flatMap((a) => a.required ? a.blockers : []);
  plan.updated_at = nowISO();
  const pipeline = { ...snapshot.pipeline, asset_plan: plan, asset_confirmation: null };
  const saved = savePipeline(novelId, snapshot.sections, pipeline, 'pipeline:asset-update', `更新资产 ${next.id}`);
  return { ok: true, asset: next, plan, saved };
}

function snapshotHash(plan) {
  const stable = (plan.assets || []).map((a) => ({ id: a.id, kind: a.kind, prompt: a.prompt, required: a.required, refs: a.reference_images }));
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

export function confirmAssetPlan(novelId, { forced = false, note = '', operator = '本机操作人' } = {}) {
  const snapshot = pipelineSnapshot(novelId);
  const plan = snapshot.pipeline.asset_plan;
  if (!Array.isArray(plan?.assets) || !plan.assets.length) throw new Error('资产计划为空，无法确认');
  const blockers = plan.assets.flatMap((a) => a.required ? (a.blockers || []) : []);
  if (blockers.length && !forced) throw new Error(`资产计划有 ${blockers.length} 个阻塞项：${blockers.slice(0, 5).join('；')}`);
  const confirmation = {
    confirmed: true,
    forced: Boolean(forced && blockers.length),
    note: TEXT(note, 500),
    operator: TEXT(operator, 100),
    confirmed_at: nowISO(),
    snapshot_hash: snapshotHash(plan),
    blockers,
    asset_count: plan.assets.length,
    required_count: plan.assets.filter((a) => a.required).length,
  };
  const pipeline = { ...snapshot.pipeline, asset_confirmation: confirmation };
  const saved = savePipeline(novelId, snapshot.sections, pipeline, forced ? 'pipeline:asset-confirm-forced' : 'pipeline:asset-confirm', note);
  return { ok: true, confirmation, saved };
}

function findNodeByNovelAsset(canvasId, assetId) {
  return get(
    `SELECT * FROM canvas_nodes
     WHERE canvas_id = ? AND json_valid(data) AND json_extract(data, '$.novel_asset_id') = ?
     ORDER BY rowid DESC LIMIT 1`,
    canvasId, assetId,
  ) || null;
}

export async function syncAssetPlanToCanvas(novelId, { canvasId = 'CV-MAIN' } = {}) {
  const snapshot = pipelineSnapshot(novelId);
  const plan = structuredClone(snapshot.pipeline.asset_plan || { assets: [] });
  if (!Array.isArray(plan.assets) || !plan.assets.length) throw new Error('资产计划为空，无法同步画布');
  const canvas = String(canvasId || 'CV-MAIN').trim() || 'CV-MAIN';
  const actorsMod = await import('./modules/actors.js');
  const result = { created: 0, updated: 0, skipped: 0, linked: 0, missing: [], nodes: {} };
  let x = 120;
  let y = 120;
  for (const asset of plan.assets) {
    if (asset.kind === 'character') {
      const actor = get('SELECT * FROM actors WHERE id = ?', asset.id);
      if (!actor) { result.skipped += 1; result.missing.push(`${asset.id} ${asset.name}`); continue; }
      let node = get('SELECT * FROM canvas_nodes WHERE canvas_id = ? AND actor_id = ? ORDER BY rowid LIMIT 1', canvas, actor.id);
      if (!node) node = actorsMod.upsertCanvasNode({ canvas_id: canvas, actor_id: actor.id, x, y, w: 220, h: 300 });
      asset.canvas_node_id = node.id;
      result.nodes[asset.id] = node.id;
      continue;
    }
    let node = findNodeByNovelAsset(canvas, asset.id);
    const data = {
      desc: asset.description || asset.prompt,
      prompt: asset.prompt,
      negative_prompt: asset.negative_prompt,
      novel_id: novelId,
      novel_asset_id: asset.id,
      chapter_ids: asset.chapters,
      ratio: asset.ratio,
      source: 'novel-pipeline',
    };
    if (!node) {
      const made = actorsMod.createAsset({ canvas_id: canvas, kind: asset.kind === 'environment' ? 'scene' : 'item', title: asset.name, x, y, w: asset.kind === 'environment' ? 360 : 240, h: asset.kind === 'environment' ? 240 : 220, data });
      node = made?.node;
      if (node) result.created += 1;
    } else {
      const made = actorsMod.updateAsset(node.id, { title: asset.name, data });
      node = made?.node || node;
      result.updated += 1;
    }
    if (!node?.id) { result.skipped += 1; continue; }
    asset.canvas_node_id = node.id;
    result.nodes[asset.id] = node.id;
    if ((asset.reference_images || []).length) {
      try { actorsMod.setAssetRefImages(node.id, { add: asset.reference_images, primary: asset.reference_images[0] }); }
      catch { /* 参考图失败不阻断节点同步 */ }
    }
    x += 430;
    if (x > 1800) { x = 120; y += 360; }
  }

  for (const card of Object.values(snapshot.pipeline.chapter_cards || {})) {
    const keys = plan.by_chapter?.[card.idx] || [];
    const nodes = keys.map((key) => {
      const asset = plan.assets.find((a) => a.key === key);
      return asset?.canvas_node_id || '';
    }).filter(Boolean);
    if (nodes.length < 2) continue;
    for (let i = 1; i < nodes.length; i += 1) {
      try {
        actorsMod.createLink({ canvas_id: canvas, from_node: nodes[0], to_node: nodes[i], label: `第${card.idx}章同场资产`, from_side: 'right', to_side: 'left' });
        result.linked += 1;
      } catch { /* 连线的幂等由底层处理；失败不阻断 */ }
    }
  }
  plan.synced_canvas_id = canvas;
  plan.synced_at = nowISO();
  plan.canvas_summary = { created: result.created, updated: result.updated, skipped: result.skipped, linked: result.linked, missing: result.missing };
  const pipeline = { ...snapshot.pipeline, asset_plan: plan, asset_confirmation: null };
  const saved = savePipeline(novelId, snapshot.sections, pipeline, 'pipeline:asset-sync-canvas', `画布 ${canvas}`);
  return { ok: true, canvasId: canvas, ...result, plan, saved };
}

function chapterAssetBlock(snapshot, idx) {
  const keys = snapshot.pipeline.asset_plan?.by_chapter?.[idx] || [];
  const assets = (snapshot.pipeline.asset_plan?.assets || []).filter((a) => keys.includes(a.key));
  return assets.map((a) => `${a.id} ${a.name}（${a.kind}）：${a.prompt}`).join('\n') || '（本章资产计划为空）';
}

function previousContext(novelId, idx) {
  return all('SELECT idx,title,content FROM novel_chapters WHERE novel_id = ? AND idx < ? ORDER BY idx DESC LIMIT 3', novelId, idx)
    .reverse()
    .map((x) => `第${x.idx}章《${x.title || ''}》结尾：${MULTI(x.content, 6000).slice(-600)}`)
    .join('\n\n');
}

function buildContinuePrompt(novelId, idx, instruction = '') {
  const snapshot = pipelineSnapshot(novelId);
  const card = snapshot.pipeline.chapter_cards[idx];
  const row = get('SELECT * FROM novel_chapters WHERE novel_id = ? AND idx = ?', novelId, idx);
  if (!row) throw new Error(`第 ${idx} 章不存在`);
  return [
    '你是中文长篇网文作者。请承接已有正文继续写，不重复前文，不解释创作过程，只输出新增正文。',
    `小说：${snapshot.novel.title || ''}｜题材：${snapshot.novel.genre || ''}｜基调：${snapshot.novel.tone || ''}`,
    `本章内容卡：${JSON.stringify(card || {}, null, 2).slice(0, 12000)}`,
    `本章资产快照：\n${chapterAssetBlock(snapshot, idx)}`,
    `前情承接：\n${previousContext(novelId, idx)}`,
    `本章已有正文（从末尾继续）：\n${MULTI(row.content, 14000)}`,
    instruction ? `额外要求：${instruction}` : '',
    '续写要求：新增 1200-1800 个中文字符；推进内容卡中的下一个未完成情节点；保持人物、环境、物品 ID 对应；结尾留下下一章钩子。',
  ].filter(Boolean).join('\n\n');
}

function mockContinuation(card, existing) {
  const beat = card?.beats?.[0] || {};
  const tail = MULTI(existing, 300).slice(-60);
  const parts = [
    `${tail ? '话音落下，' : ''}${beat.action || '局势没有给任何人喘息的时间，新的冲突立刻压了上来。'}`,
    `现场的气氛变得凝滞。主角没有立刻回应，而是把刚才出现的细节重新在脑中排了一遍：时间、位置、人物反应，以及那个被所有人忽略的物件。越接近答案，阻力就越明显。`,
    `他向前一步，把问题直接摆到桌面上。对方短暂沉默，随后给出的答案却与前面的说法互相矛盾。周围人的反应证明，这不是一句口误，而是一条被刻意藏起来的线索。`,
    `冲突很快从试探变成正面对抗。主角必须在眼前利益和长远目标之间做出选择，而每一次选择都意味着新的代价。章末钩子已经显露：${card?.key_frame || '新的危险正在逼近'}。`,
  ];
  let out = '';
  for (let i = 0; out.replace(/\s/g, '').length < 1300; i += 1) out += `${parts[i % parts.length]}\n\n`;
  return out.trim();
}

export async function continueChapter(novelId, idx, { instruction = '', mode = 'continue', force = false, operator = '本机操作人' } = {}) {
  const snapshot = pipelineSnapshot(novelId);
  const n = Number(idx);
  const row = get('SELECT * FROM novel_chapters WHERE novel_id = ? AND idx = ?', novelId, n);
  if (!row) throw new Error(`第 ${n} 章不存在`);
  if (!snapshot.pipeline.asset_confirmation?.confirmed && !force) throw new Error('资产计划尚未确认，不能续写正文');
  const card = snapshot.pipeline.chapter_cards[n];
  if (!cardComplete(card)) throw new Error(`第 ${n} 章内容卡未完成，不能续写`);
  const oldContent = String(row.content || '');
  const status = llmStatus();
  let content = '';
  let mocked = false;
  let model = '';
  if (mode === 'rewrite' || mode === 'start') {
    const result = await writeLongChapter(novelId, n, { save: false, instruction });
    content = result.content || '';
    mocked = Boolean(result.mocked);
    model = result.model || '';
    if (!content) throw new Error('正文生成结果为空');
  } else {
    if (status?.provider === 'mock') {
      content = mockContinuation(card, oldContent);
      mocked = true;
    } else {
      const out = await chat({ system: '你是中文长篇网文作者。只输出承接后的新增正文。', prompt: buildContinuePrompt(novelId, n, instruction), temperature: 0.84, maxTokens: 5000 });
      content = MULTI(out?.text, 12000).replace(/^```(?:text|markdown)?\s*/i, '').replace(/\s*```$/i, '');
      model = out?.model || '';
    }
    content = `${oldContent.trim()}\n\n${content.trim()}`.trim();
  }
  const words = Number(countWords(content)) || 0;
  const now = nowISO();
  const history = { ...(snapshot.pipeline.prose_history || {}) };
  const versions = Array.isArray(history[n]) ? history[n] : [];
  versions.push({ content: oldContent, words: Number(countWords(oldContent)) || 0, replaced_at: now, operator, mode });
  history[n] = versions.slice(-3);
  const audit = [...(snapshot.pipeline.prose_audit || []), { at: now, actor: operator, action: `prose:${mode}`, chapter: n, forced: Boolean(force && !snapshot.pipeline.asset_confirmation?.confirmed) }].slice(-200);
  run('UPDATE novel_chapters SET content = ?, words = ?, status = ?, model = ?, error = NULL, updated_at = ? WHERE novel_id = ? AND idx = ?', content, words, 'done', model || 'pipeline', now, novelId, n);
  const pipeline = { ...snapshot.pipeline, prose_history: history, prose_audit: audit };
  const saved = savePipeline(novelId, snapshot.sections, pipeline, `pipeline:prose-${mode}`, `第${n}章正文`);
  return { ok: true, idx: n, mode, words, addedWords: Math.max(0, words - (Number(countWords(oldContent)) || 0)), mocked, model, saved, content };
}

export function resetPipeline(novelId, { steps = [] } = {}) {
  const snapshot = pipelineSnapshot(novelId);
  if (!steps.length) throw new Error('请指定要重置的步骤');
  const pipeline = structuredClone(snapshot.pipeline);
  if (steps.includes('cards')) { pipeline.chapter_cards = {}; pipeline.asset_plan = emptyPipeline().asset_plan; pipeline.asset_confirmation = null; }
  if (steps.includes('assets')) { pipeline.asset_plan = emptyPipeline().asset_plan; pipeline.asset_confirmation = null; }
  if (steps.includes('prose')) { pipeline.prose_history = {}; pipeline.prose_audit = []; }
  const saved = savePipeline(novelId, snapshot.sections, pipeline, 'pipeline:reset', steps.join(','));
  return { ok: true, saved };
}

export default {
  PIPELINE_VERSION,
  PIPELINE_STEPS,
  pipelineOf,
  pipelineSnapshot,
  buildDeterministicChapterCard,
  generateChapterCards,
  saveChapterCard,
  buildAssetPlan,
  getAssetPlan,
  updatePipelineAsset,
  confirmAssetPlan,
  syncAssetPlanToCanvas,
  continueChapter,
  resetPipeline,
};
