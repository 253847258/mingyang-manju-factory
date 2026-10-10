// 描述自动改进（plain text module）
//
// 「预览后确认」：preview 只算不写库，返回 token；apply 才落库；undo 可回滚。
// - 角色：复用 prompts.js 的 optimizePrompt(mode='describe')（LLM 只出 JSON，不写库）
// - 环境/物品：LLM 补 desc/时段/天气/氛围/配色/镜头提示
// 落库统一走 modules/actors.js 的 updateActor / updateAsset，保持校验口径一致。

import { randomUUID } from 'node:crypto';
import { get } from './db.js';
import { nowISO } from './util.js';
import { optimizePrompt } from './prompts.js';
import { chatJSON } from './llm.js';
import { styleById } from './data/styles.js';
import { updateActor, updateAsset } from './modules/actors.js';

const TTL_MS = 30 * 60 * 1000;
const store = new Map();

function sweep() {
  const now = Date.now();
  for (const [k, v] of store) if (now - v.at > TTL_MS) store.delete(k);
}

function put(entry) {
  sweep();
  const token = `DSC-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  store.set(token, { ...entry, at: Date.now() });
  return token;
}

function take(token) {
  sweep();
  const v = store.get(token);
  if (!v) throw new Error('预览已过期或不存在，请重新生成');
  return v;
}

function safeJson(value, fallback) {
  try {
    if (value === null || value === undefined || value === '') return fallback;
    if (typeof value === 'object') return value;
    return JSON.parse(value);
  } catch { return fallback; }
}

const ACTOR_DESC_FIELDS = ['personality', 'background', 'costume', 'hair', 'face', 'voice', 'tags'];

const STYLE_EN = {
  'jp-anime': { costume: 'sailor uniform, neat school outfit', face: 'large expressive anime eyes, clean lineart face' },
  'cn-guofeng': { costume: 'layered hanfu robe with silver embroidery, jade pendant', face: 'delicate classical features, almond eyes' },
  'kr-webtoon': { costume: 'modern stylish outfit, soft fabric, pastel tones', face: 'glowing fair skin, glossy lips, gentle eyes' },
  'us-comic': { costume: 'hard edge tactical outfit, bold color blocks', face: 'strong jaw, angular features, defined brows' },
  'pixar-3d': { costume: 'stylized 3d costume with soft materials', face: 'rounded appealing proportions, big friendly eyes' },
  'cinematic-real': { costume: 'realistic streetwear coat with texture detail', face: 'natural skin texture, photoreal facial features' },
  cyberpunk: { costume: 'neon-trimmed techwear jacket, chrome accents', face: 'sharp features, glowing implant details' },
  'ink-wash': { costume: 'flowing traditional robe, ink brush texture', face: 'minimal ink-brush facial features' },
  'retro-cel': { costume: 'retro 90s outfit, faded fabric', face: 'nostalgic cel-shaded features' },
  'dark-gothic': { costume: 'dark gothic armor with gold trim', face: 'pale skin, cold sharp gaze' },
};

const ROLE_PERSONALITY = {
  男主: '外冷内热，遇事果决，对身边人暗中保护',
  女主: '表面柔软、内心坚韧，关键时刻敢下决断',
  反派: '城府极深，笑里藏刀，为达目的不择手段',
  配角: '性格鲜明，戏份不多但每次出场都推动剧情',
  路人: '普通人设定，用于衬托主要角色与环境',
};

function ruleActorDescribe(actor = {}) {
  const style = styleById(actor.style_id) || styleById('cinematic-real');
  const s = STYLE_EN[actor.style_id] || STYLE_EN['cinematic-real'];
  const role = String(actor.role_type || '').trim();
  const age = Number(actor.age) || null;
  const genderCn = /female|女/i.test(String(actor.gender || '')) ? '女' : (/male|男/i.test(String(actor.gender || '')) ? '男' : '');
  return {
    personality: actor.personality || ROLE_PERSONALITY[role] || '性格待补充，建议给出一句能立刻区分于其他角色的记忆点',
    background: actor.background || `${actor.name || '该角色'}，${age ? `${age} 岁，` : ''}${role || '主要角色'}。出身与动机建议围绕主线冲突补充 2-3 句，让出场即有目的。`,
    costume: actor.costume || s.costume,
    hair: actor.hair || actor.hair_style || 'natural dark hair, consistent style across shots',
    face: actor.face || s.face,
    voice: actor.voice || `${genderCn || ''}${age && age < 22 ? '少年/少女感' : age && age > 40 ? '沉稳定型' : '青年'}音色，情绪层次清晰`,
    tags: actor.tags || [role || '角色', style?.name || '写实电影感'].join(','),
  };
}

const STYLE_PALETTE = {
  'jp-anime': 'vivid flat colors, high saturation, clean highlights',
  'cn-guofeng': 'warm gold and ink tones, rich contrast',
  'kr-webtoon': 'soft pastel palette, glossy highlights',
  'us-comic': 'bold primary colors, hard shadows',
  'pixar-3d': 'filmic warm palette, soft global illumination',
  'cinematic-real': 'teal-and-orange film palette, natural skin tones',
  cyberpunk: 'magenta and cyan neon palette, deep blue shadows',
  'ink-wash': 'monochrome ink palette, subtle wash gradients',
  'retro-cel': 'faded retro palette, warm halation',
  'dark-gothic': 'desaturated cold palette, deep shadow contrast',
};

function ruleAssetDescribe(node = {}, data = {}) {
  const styleId = data.styleId || 'cinematic-real';
  const style = styleById(styleId) || styleById('cinematic-real');
  const title = node.title || data.title || '场景';
  const timeCn = data.timeOfDay || '不限';
  const weatherCn = data.weather || '';
  return {
    desc: data.desc || `${title}。${timeCn}${weatherCn ? '，' + weatherCn : ''}。建议补充空间结构（前中后景）、光源位置与一处标志性细节，便于跨镜复用。`,
    timeOfDay: data.timeOfDay || '',
    weather: data.weather || '',
    mood: data.mood || (data.weather ? `${data.weather}带来的压抑与不安` : '与剧情情绪一致的氛围'),
    palette: data.palette || STYLE_PALETTE[styleId] || STYLE_PALETTE['cinematic-real'],
    cameraNotes: data.cameraNotes || 'wide establishing shot then medium shot, 35mm lens, consistent light direction',
    tags: Array.isArray(data.tags) ? data.tags.join(',') : (data.tags || title),
  };
}

function pickActorFields(src = {}) {
  const out = {};
  for (const f of ACTOR_DESC_FIELDS) {
    if (src[f] === undefined || src[f] === null || src[f] === '') continue;
    out[f] = Array.isArray(src[f]) ? src[f].join(',') : String(src[f]);
  }
  return out;
}

// 快照必须保留空值，否则 undo 无法把「本来是空的」字段清回去
function snapshotActorFields(actor = {}) {
  const out = {};
  for (const f of ACTOR_DESC_FIELDS) {
    const v = actor[f];
    out[f] = v === undefined || v === null ? '' : (Array.isArray(v) ? v.join(',') : String(v));
  }
  return out;
}

export async function previewActorDescribe(actorId) {
  const actor = get('SELECT * FROM actors WHERE id = ?', actorId);
  if (!actor) throw new Error('演员不存在');
  const before = snapshotActorFields(actor);
  let after = {};
  let source = 'llm';
  try {
    const r = await optimizePrompt({ actor, mode: 'describe' });
    after = pickActorFields(r?.data || {});
    source = 'llm';
  } catch { after = {}; }
  if (!Object.keys(after).length) {
    after = ruleActorDescribe(actor);
    source = 'rule';
  }
  const token = put({ scope: 'actor', id: actorId, before, after });
  return { ok: true, token, scope: 'actor', id: actorId, source, before, after };
}

const ASSET_SYSTEM = [
  '你是美术指导，为「AI 漫剧/电影」补全环境或道具设定。只输出 JSON，不要解释。',
  '输出字段：desc(中文场景/道具描述 60-120 字)、timeOfDay(中文时段，可空)、weather(中文天气，可空)、',
  'mood(中文氛围 8-20 字)、palette(英文配色标签，逗号分隔)、cameraNotes(英文镜头/构图建议，逗号分隔)、tags(中文标签数组)。',
].join('\n');

export async function previewAssetDescribe(nodeId) {
  const node = get('SELECT * FROM canvas_nodes WHERE id = ?', nodeId);
  if (!node) throw new Error('节点不存在');
  if (!['scene', 'item', 'refimg'].includes(String(node.kind || ''))) throw new Error('该节点不是环境/物品/参考图节点');
  const data = safeJson(node.data, {}) || {};
  const before = {
    desc: data.desc || '', timeOfDay: data.timeOfDay || '', weather: data.weather || '',
    mood: data.mood || '', palette: data.palette || '', cameraNotes: data.cameraNotes || '',
    tags: Array.isArray(data.tags) ? data.tags.join(',') : (data.tags || ''),
  };
  const style = styleById(data.styleId || 'cinematic-real');
  let out = null;
  let source = 'llm';
  try {
    out = await chatJSON({
      system: ASSET_SYSTEM,
      prompt: `节点类型：${node.kind}\n名称：${node.title || ''}\n现有描述：${data.desc || '（空）'}\n现有标签：${(data.tags || []).join?.('、') || data.tags || '（空）'}\n画风：${style?.name || ''}`,
      temperature: 0.9,
    });
  } catch { out = null; }
  const d = out?.data || {};
  const hasLlm = Boolean(d.desc || d.mood || d.palette || d.cameraNotes);
  const after = hasLlm
    ? {
      desc: String(d.desc || data.desc || ''),
      timeOfDay: String(d.timeOfDay || data.timeOfDay || ''),
      weather: String(d.weather || data.weather || ''),
      mood: String(d.mood || data.mood || ''),
      palette: String(d.palette || data.palette || ''),
      cameraNotes: String(d.cameraNotes || data.cameraNotes || ''),
      tags: Array.isArray(d.tags) ? d.tags.join(',') : String(d.tags || before.tags || ''),
    }
    : (() => { source = 'rule'; return ruleAssetDescribe(node, data); })();
  const token = put({ scope: 'asset', id: nodeId, before, after });
  return { ok: true, token, scope: 'asset', id: nodeId, source, before, after };
}

export function preview(scope, id) {
  if (scope === 'asset') return previewAssetDescribe(id);
  return previewActorDescribe(id);
}

export function applyPreview(token, { includePrompt = false, promptSuggestion = null } = {}) {
  const v = take(token);
  if (v.scope === 'actor') {
    const patch = { ...v.after };
    if (includePrompt && promptSuggestion) {
      if (promptSuggestion.positive) patch.prompt_pos = promptSuggestion.positive;
      if (promptSuggestion.negative) patch.prompt_neg = promptSuggestion.negative;
    }
    const actor = updateActor(v.id, patch);
    const undo = put({ scope: 'actor', id: v.id, before: v.after, after: v.before });
    store.delete(token);
    return { ok: true, scope: 'actor', id: v.id, patch, actor, undoToken: undo, appliedAt: nowISO() };
  }
  const node = get('SELECT * FROM canvas_nodes WHERE id = ?', v.id);
  if (!node) throw new Error('节点不存在');
  const data = safeJson(node.data, {}) || {};
  const merged = { ...data };
  for (const [k, val] of Object.entries(v.after)) {
    merged[k] = k === 'tags' ? String(val || '').split(/[,，\s]+/).filter(Boolean) : val;
  }
  updateAsset(v.id, { data: merged });
  const undo = put({ scope: 'asset', id: v.id, before: v.after, after: v.before });
  store.delete(token);
  return { ok: true, scope: 'asset', id: v.id, patch: v.after, undoToken: undo, appliedAt: nowISO() };
}

export function undoPreview(token) {
  const v = take(token);
  if (v.scope === 'actor') {
    updateActor(v.id, v.after);
    store.delete(token);
    return { ok: true, scope: 'actor', id: v.id, restored: v.after };
  }
  const node = get('SELECT * FROM canvas_nodes WHERE id = ?', v.id);
  if (!node) throw new Error('节点不存在');
  const data = safeJson(node.data, {}) || {};
  const merged = { ...data };
  for (const [k, val] of Object.entries(v.after)) {
    merged[k] = k === 'tags' ? String(val || '').split(/[,，\s]+/).filter(Boolean) : val;
  }
  updateAsset(v.id, { data: merged });
  store.delete(token);
  return { ok: true, scope: 'asset', id: v.id, restored: v.after };
}

export function previewCount() {
  sweep();
  return store.size;
}
