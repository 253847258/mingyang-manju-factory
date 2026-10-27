// 提示词清洗与体检（纯函数）
// 目标：去掉实体编号、压掉中英混排噪音、发现缺镜头语言/负向词等常见问题。

const ID_RE = /\((?:C|CX|L)-\d{4}\)/gi;
const ID_BARE_RE = /\b(?:C|CX|L)-\d{4}\b/gi;
const CJK_RE = /[\u4e00-\u9fff]/;

export function stripEntityIds(text) {
  return String(text || '')
    .replace(ID_RE, '')
    .replace(ID_BARE_RE, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+,/g, ',')
    .replace(/,\s*,/g, ',')
    .trim();
}

const SHOT_WORDS = /(wide shot|medium shot|close[- ]?up|extreme close|full shot|over[- ]?shoulder|pov|aerial|low angle|high angle|特写|近景|中景|远景|全景|过肩|俯拍|仰拍)/i;
const CAMERA_WORDS = /(camera|arri|red |sony|35mm|50mm|85mm|anamorphic|dolly|pan|tilt|tracking|handheld|镜头|运镜)/i;
const NEG_HINTS = /(anime|cartoon|illustration|cgi|plastic|watermark|text|logo|blurry|deformed)/i;

export function lintPrompt(text, { maxLen = 1200, requireShotWord = true, requireNegHints = false } = {}) {
  const raw = String(text || '').trim();
  const issues = [];
  if (!raw) issues.push({ type: 'empty', severity: 'blocker', message: '提示词为空' });
  const ids = raw.match(ID_RE) || raw.match(ID_BARE_RE) || [];
  if (ids.length) issues.push({ type: 'entity_id', severity: 'major', message: `含 ${ids.length} 个实体编号`, examples: ids.slice(0, 5) });
  const hasCjk = CJK_RE.test(raw);
  const hasLatin = /[A-Za-z]{3,}/.test(raw);
  if (hasCjk && hasLatin) issues.push({ type: 'mixed_language', severity: 'minor', message: '中英混排，英文模型理解可能不稳' });
  if (raw.length > maxLen) issues.push({ type: 'too_long', severity: 'minor', message: `长度 ${raw.length}，超过 ${maxLen}` });
  if (requireShotWord && !SHOT_WORDS.test(raw)) issues.push({ type: 'no_shot_word', severity: 'minor', message: '缺少景别词（特写/中景/远景等）' });
  if (!CAMERA_WORDS.test(raw)) issues.push({ type: 'no_camera', severity: 'info', message: '缺少镜头/相机语言' });
  if (requireNegHints && !NEG_HINTS.test(raw)) issues.push({ type: 'neg_hints', severity: 'info', message: '负向词缺少常见防护（anime/cartoon/watermark 等）' });
  return { ok: issues.every((i) => i.severity === 'info'), issues, hasCjk, hasLatin, length: raw.length };
}

export function cleanPrompt(text) {
  return stripEntityIds(text);
}

export function cleanNegative(text) {
  return stripEntityIds(text);
}
