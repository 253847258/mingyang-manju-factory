// 专业级提示词（plain text module）
//
// - PRO_STYLE_TAILS / PRO_NEGATIVES：按画风补「镜头/光位/色彩/胶片」质量尾与负向库
// - promptDiagnose：体检（中英混排、重复、缺焦段/光位/质量尾/负向、顺序、超长）
// - promptRepair：确定性修复（去重、踢中文、补镜头与质量尾、截断）
// - professionalizePrompt：LLM 出 POS/NEG 预览（不写库；写库由路由层决定）
//
// 规划口径：英文 tag 为主；「风格头 → 人物锚点 → 镜头/构图 → 光影 → 情绪 → 质量尾」。

import { styleById, BASE_QUALITY, BASE_NEGATIVE } from './data/styles.js';
import { chatJSON } from './llm.js';

export const PRO_STYLE_TAILS = {
  'jp-anime': 'medium shot, 50mm lens, soft key light with rim light, cel shading color grading, clean lineart',
  'cn-guofeng': 'cinematic wide shot, 35mm lens, warm golden key light, rich ink-and-paint color grading, textured brush detail',
  'kr-webtoon': 'portrait shot, 85mm lens, soft diffused studio light, pastel color grading, glossy romantic highlights',
  'us-comic': 'dynamic low angle, 24mm lens, hard directional light, high contrast ink color grading, bold shadows',
  'pixar-3d': 'three-quarter shot, 35mm virtual lens, area light with soft shadows, filmic color grading, subsurface scattering',
  'cinematic-real': 'cinematic shot, 35mm anamorphic lens, key light with practical rim light, teal-and-orange film color grading, shallow depth of field, film grain',
  cyberpunk: 'wide angle 24mm lens, neon rim light, magenta-and-cyan color grading, wet reflective surfaces, volumetric haze',
  'ink-wash': 'wide shot, long lens compression, soft ambient light, monochrome ink color grading, negative space composition',
  'retro-cel': 'medium shot, 35mm lens, warm tungsten key light, faded film color grading, halation and grain',
  'dark-gothic': 'low key shot, 50mm lens, single hard key light, desaturated cold color grading, deep shadow contrast',
};

export const PRO_NEGATIVES = {
  'jp-anime': '3d render, photorealistic, western cartoon, messy lines, rough sketch, off-model, extra fingers',
  'cn-guofeng': 'japanese anime, 3d render, western style, modern city, flat cell shading, plastic texture',
  'kr-webtoon': 'rough sketch, messy lineart, harsh shadows, low saturation, 3d render, photorealistic',
  'us-comic': 'soft pastel, cute chibi, anime style, flat lighting, washed out, blurry lines',
  'pixar-3d': '2d flat, hand drawn, sketch, noisy texture, low poly, doll-like eyes',
  'cinematic-real': 'anime, cartoon, cgi, plastic skin, over-smoothed face, extra limbs, warped hands, oversaturated',
  cyberpunk: 'medieval, rustic, daylight pastel, low contrast, blurry, flat lighting',
  'ink-wash': 'saturated colors, glossy 3d render, messy splashes, heavy outlines, noisy texture',
  'retro-cel': 'modern digital look, 3d render, oversaturated, glossy, clean vector lines',
  'dark-gothic': 'bright cheerful colors, pastel, comedy, flat lighting, cartoonish',
};

const CJK_RE = /[\u4e00-\u9fff]/;
const LENS_RE = /(\d{2,3}\s?mm|f\/\d|depth of field|bokeh|anamorphic|telephoto|wide angle|macro)/i;
const LIGHT_RE = /(\blight\b|\blighting\b|\blit\b|key light|rim light|backlight|softbox|shadow|golden hour|volumetric|neon)/i;
const SHOT_RE = /(close[- ]?up|portrait|full body|wide shot|medium shot|establishing|low angle|high angle|over the shoulder|three-quarter|turnaround|headshot|extreme close)/i;
const ANCHOR_RE = /(1boy|1girl|1person|2boys|2girls|\bman\b|\bwoman\b|\bboy\b|\bgirl\b|character|crowd|people)/i;
const QUALITY_RE = /(best quality|masterpiece|ultra detailed|high resolution|8k|4k|sharp focus|highly detailed|award winning)/i;

const tailTokensOf = (styleId) => String(PRO_STYLE_TAILS[styleId] || '').split(',').map((s) => s.trim()).filter(Boolean);

export function splitTokens(text) {
  return String(text || '').split(',').map((s) => s.trim()).filter(Boolean);
}

export function stripCjkTokens(text) {
  return splitTokens(text).filter((t) => !CJK_RE.test(t));
}

export function promptDiagnose(text, { negative = '', styleId = '' } = {}) {
  const raw = String(text || '');
  const tokens = splitTokens(raw);
  const lower = tokens.map((t) => t.toLowerCase());
  const seen = new Set();
  const duplicates = [];
  for (const t of lower) {
    if (seen.has(t)) duplicates.push(t);
    else seen.add(t);
  }
  const issues = [];
  if (duplicates.length) issues.push(`重复 token：${[...new Set(duplicates)].join('、')}`);
  const cjk = tokens.filter((t) => CJK_RE.test(t));
  if (cjk.length) issues.push(`中英混排（英文提示词里混入中文）：${cjk.slice(0, 3).join('、')}`);
  if (!ANCHOR_RE.test(raw)) issues.push('缺少人物/主体锚点（1girl/1boy/character 等）');
  if (!SHOT_RE.test(raw)) issues.push('缺少镜头/构图（close-up / full body / medium shot 等）');
  if (!LENS_RE.test(raw)) issues.push('缺少镜头参数（焦段 mm / f 值 / depth of field）');
  if (!LIGHT_RE.test(raw)) issues.push('缺少光影描述（key light / rim light / golden hour 等）');
  if (!QUALITY_RE.test(raw)) issues.push('缺少质量尾（best quality / ultra detailed / 8k 等）');
  if (!String(negative || '').trim()) issues.push('缺少负面提示词');
  if (raw.length > 1200) issues.push(`提示词过长（${raw.length} 字，建议 ≤ 1200）`);
  const tail = tailTokensOf(styleId);
  const tailHit = tail.some((t) => lower.includes(t.toLowerCase()));
  if (tail.length && !tailHit) issues.push(`缺少画风专业尾（如 ${tail.slice(0, 2).join('、')}）`);
  return {
    ok: true,
    styleId: styleId || null,
    tokens: tokens.length,
    duplicates: [...new Set(duplicates)],
    cjk,
    issues,
    clean: issues.length === 0,
  };
}

// 确定性修复：去重 → 踢中文 → 补镜头/光影/质量尾 → 截断
export function promptRepair(text, { styleId = '', negative = '', addTail = true } = {}) {
  const notes = [];
  let tokens = stripCjkTokens(text);
  if (tokens.length !== splitTokens(text).length) notes.push('已移除中文 token（英文提示词）');
  const seen = new Set();
  const before = tokens.length;
  tokens = tokens.filter((t) => {
    const k = t.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (tokens.length !== before) notes.push('已去重');

  const raw = tokens.join(', ');
  const additions = [];
  const seenAll = new Set(tokens.map((t) => t.toLowerCase()));
  const add = (t) => {
    const s = String(t || '').trim();
    const k = s.toLowerCase();
    if (!s || seenAll.has(k)) return;
    seenAll.add(k);
    additions.push(s);
  };
  const tailBits = (PRO_STYLE_TAILS[styleId] || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!LIGHT_RE.test(raw)) add(tailBits.find((t) => LIGHT_RE.test(t)) || 'key light with rim light');
  if (!LENS_RE.test(raw)) add(tailBits.find((t) => LENS_RE.test(t)) || '35mm lens, shallow depth of field');
  if (addTail) {
    for (const t of tailBits) add(t);
    for (const t of splitTokens(BASE_QUALITY)) add(t);
  }
  if (additions.length) notes.push(`已补镜头/光影/质量尾 ${additions.length} 项`);
  let positive = [...tokens, ...additions].join(', ');
  if (positive.length > 1200) { positive = positive.slice(0, 1200).replace(/,\s*[^,]*$/, ''); notes.push('已截断到 1200 字'); }

  let neg = String(negative || '').trim();
  if (!neg) { neg = BASE_NEGATIVE; notes.push('已补基础负面词'); }
  const styleNeg = PRO_NEGATIVES[styleId];
  if (styleNeg && !neg.toLowerCase().includes(styleNeg.split(',')[0].trim().toLowerCase())) {
    neg = `${neg}, ${styleNeg}`;
    notes.push('已并入画风负向词');
  }
  return { ok: true, positive, negative: neg, notes, issues: promptDiagnose(positive, { negative: neg, styleId }).issues };
}

const PRO_SYSTEM = [
  '你是资深 AI 绘画提示词工程师，为「AI 漫剧/电影」撰写 Stable Diffusion / Midjourney / Flux 提示词。',
  '规则：',
  '1. 只输出英文提示词（逗号分隔标签），不要中文解释、不要 markdown 围栏；',
  '2. 人物锚点（性别/年龄/种族/身高/体型/肤色/发型/瞳色/服饰）必须原样保留，不得删改；',
  '3. 严格按「风格头 + 人物锚点 + 镜头/构图 + 光影 + 情绪 + 质量尾」顺序组织；',
  '4. 必须包含镜头参数（如 35mm / 85mm、f/1.8、depth of field）与光位（key light / rim light）；',
  '5. 只输出 JSON：{"positive":"英文正向提示词","negative":"英文负面提示词"}。',
].join('\n');

// LLM 专业化预览（不写库）。mock/无 Key 时回退到确定性 promptRepair。
export async function professionalizePrompt({ scope = 'actor', base = '', negative = '', styleId = '', instruction = '' } = {}) {
  const style = styleById(styleId);
  try {
    const out = await chatJSON({
      system: PRO_SYSTEM,
      prompt: `【画风风格包】
头部：${style?.head || ''}
质量尾：${style?.tail || ''}
负向：${style?.negative || ''}

【现有提示词】
${base || '（空，请按画风补全）'}

【现有负向词】
${negative || '（空）'}

${instruction ? `【额外要求】${instruction}\n` : ''}
范围：${scope}。请按规则输出 JSON。`,
    });
    const data = out?.data || {};
    if (data.positive) {
      return { ok: true, source: 'llm', positive: String(data.positive), negative: String(data.negative || negative || ''), model: out.model || '' };
    }
    throw new Error('LLM 未返回 positive');
  } catch (err) {
    const fixed = promptRepair(base, { styleId, negative });
    return { ok: true, source: 'rule', positive: fixed.positive, negative: fixed.negative, notes: fixed.notes, fallbackReason: err.message };
  }
}

export function proStyleTail(styleId) {
  return PRO_STYLE_TAILS[styleId] || PRO_STYLE_TAILS['cinematic-real'];
}

export function proNegative(styleId) {
  return PRO_NEGATIVES[styleId] || PRO_NEGATIVES['cinematic-real'];
}
