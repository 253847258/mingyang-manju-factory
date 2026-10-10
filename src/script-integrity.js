// 剧本工厂 · 引用体检 / 提示词体检（plain text module）

import { all, get, run } from './db.js';
import { nowISO } from './util.js';
import { ensureScriptingSchema } from './scripting-schema.js';
import { promptRepair as proPromptRepair } from './prompt-quality.js';

const TIME_CANON = [
  [/深夜|夜晚|晚上|night|midnight/i, 'night'],
  [/白天|日间|daytime|day\b|morning|afternoon|noon/i, 'daytime'],
  [/黄昏|傍晚|dusk|sunset/i, 'dusk'],
  [/清晨|黎明|拂晓|dawn|sunrise/i, 'dawn'],
  [/正午|noon/i, 'noon'],
];

const PROP_LEXICON = [
  'wine cup', 'pocket watch', 'mist fog', 'smoke', 'cigarette', 'gun', 'knife', 'phone', 'letter',
  'map', 'key', 'ring', 'necklace', 'box', 'umbrella', 'glass', 'camera', 'computer', 'book',
  'photo', 'seal', 'document', 'contract', 'rope', 'backpack', 'flashlight',
];

const PROP_HINTS = {
  'wine cup': ['酒', '杯'],
  'pocket watch': ['怀表', '表'],
  'mist fog': ['雾'],
  smoke: ['烟'],
  cigarette: ['烟', '烟头'],
  gun: ['枪'],
  knife: ['刀'],
  phone: ['手机'],
  letter: ['信'],
  map: ['地图'],
  key: ['钥匙'],
  ring: ['戒指'],
  necklace: ['项链'],
  box: ['盒', '箱'],
  umbrella: ['伞'],
  glass: ['玻璃', '杯'],
  camera: ['相机'],
  computer: ['电脑'],
  book: ['书'],
  photo: ['照片'],
  seal: ['印章'],
  document: ['文件', '档案'],
  contract: ['合同'],
  rope: ['绳'],
  backpack: ['背包'],
  flashlight: ['手电'],
};

function safeJson(value, fallback) {
  try {
    if (value === null || value === undefined || value === '') return fallback;
    if (typeof value === 'object') return value;
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function actorMap() {
  const actors = all('SELECT id, name, role_type, gender, age, style_id FROM actors ORDER BY LENGTH(name) DESC');
  return {
    actors,
    byId: new Map(actors.map((a) => [a.id, a])),
    byName: new Map(actors.map((a) => [String(a.name || '').toLowerCase(), a])),
  };
}

function mentionedActors(shot, map) {
  const haystack = `${shot.action || ''}\n${shot.dialogue || ''}`;
  return map.actors.filter((a) => a.name && haystack.includes(a.name));
}

function staleActionIds(shot, map) {
  const ids = String(shot.action || '').match(/C-\d+/g) || [];
  return [...new Set(ids)].filter((id) => !map.byId.has(id));
}

function mapStaleIdByName(action, staleId, map) {
  const text = String(action || '');
  const index = text.indexOf(staleId);
  if (index < 0) return null;
  const after = text.slice(index + staleId.length, index + staleId.length + 16).replace(/^[\s:：,，、-]+/, '');
  return map.actors.find((actor) => actor.name && after.startsWith(actor.name)) || null;
}

export function refIntegrity(scriptId) {
  ensureScriptingSchema();
  const script = get('SELECT * FROM scripts WHERE id = ?', scriptId);
  if (!script) throw new Error('剧本不存在');
  const map = actorMap();
  const shots = all('SELECT * FROM shots WHERE script_id = ? ORDER BY episode_id, idx', scriptId);
  const plan = safeJson(script.plan, {}) || {};
  const options = safeJson(script.options, {}) || {};
  const planCast = Array.isArray(plan.cast) ? plan.cast : [];
  const canvasActors = Array.isArray(options.canvasBinding?.actors) ? options.canvasBinding.actors : [];

  const shotIssues = [];
  for (const shot of shots) {
    const refs = safeJson(shot.refs, {}) || {};
    const chars = Array.isArray(refs.characters) ? refs.characters : [];
    const invalid = chars.filter((id) => !map.byId.has(id));
    const mentioned = mentionedActors(shot, map);
    const missing = mentioned.map((a) => a.id).filter((id) => !chars.includes(id));
    const mismatched = chars.length && mentioned.length && !mentioned.some((a) => chars.includes(a.id));
    const stale = staleActionIds(shot, map);
    if (invalid.length || missing.length || mismatched || stale.length) {
      shotIssues.push({
        shotId: shot.id,
        idx: shot.idx,
        episodeId: shot.episode_id,
        locked: Number(shot.locked) === 1,
        invalid,
        missing,
        mismatched,
        staleActionIds: stale,
        action: String(shot.action || '').slice(0, 160),
      });
    }
  }

  const planIssues = planCast
    .filter((c) => c?.id && !map.byId.has(c.id))
    .map((c) => ({ id: c.id, name: c.name || '', kind: 'plan' }));
  const canvasIssues = canvasActors
    .filter((a) => a?.actorId && !map.byId.has(a.actorId))
    .map((a) => ({ id: a.actorId, name: a.name || '', kind: 'canvas' }));

  return {
    ok: true,
    scriptId,
    actors: map.actors.map((a) => ({ id: a.id, name: a.name, role: a.role_type || '' })),
    summary: {
      shots: shots.length,
      issueShots: shotIssues.length,
      invalidRefs: shotIssues.reduce((n, x) => n + x.invalid.length, 0),
      missingRefs: shotIssues.reduce((n, x) => n + x.missing.length, 0),
      mismatchedShots: shotIssues.filter((x) => x.mismatched).length,
      staleActionIds: shotIssues.reduce((n, x) => n + x.staleActionIds.length, 0),
      planIssues: planIssues.length,
      canvasIssues: canvasIssues.length,
    },
    shots: shotIssues,
    planIssues,
    canvasIssues,
  };
}

export function refRepair(scriptId) {
  ensureScriptingSchema();
  const script = get('SELECT * FROM scripts WHERE id = ?', scriptId);
  if (!script) throw new Error('剧本不存在');
  const map = actorMap();
  const shots = all('SELECT * FROM shots WHERE script_id = ? ORDER BY episode_id, idx', scriptId);
  const changes = [];
  const skippedLocked = [];
  for (const shot of shots) {
    if (Number(shot.locked) === 1) { skippedLocked.push(shot.id); continue; }
    const refs = safeJson(shot.refs, {}) || {};
    const original = Array.isArray(refs.characters) ? refs.characters.slice() : [];
    const validMentioned = mentionedActors(shot, map).map((a) => a.id);
    const repaired = [];
    for (const id of original) {
      if (map.byId.has(id)) repaired.push(id);
      else {
        const mapped = mapStaleIdByName(shot.action, id, map);
        if (mapped) repaired.push(mapped.id);
      }
    }
    for (const id of validMentioned) repaired.push(id);
    const unique = [...new Set(repaired)];
    const finalRefs = unique.length ? unique : original.filter((id) => map.byId.has(id));
    const changed = JSON.stringify(finalRefs) !== JSON.stringify(original);
    if (changed) {
      refs.characters = finalRefs;
      run('UPDATE shots SET refs = ? WHERE id = ?', JSON.stringify(refs), shot.id);
      changes.push({ shotId: shot.id, idx: shot.idx, before: original, after: finalRefs });
    }
  }

  const plan = safeJson(script.plan, {}) || {};
  let planChanged = 0;
  if (Array.isArray(plan.cast)) {
    for (const cast of plan.cast) {
      if (!cast?.id || map.byId.has(cast.id)) continue;
      const byName = map.byName.get(String(cast.name || '').toLowerCase());
      if (byName) { cast.id = byName.id; planChanged += 1; }
    }
  }
  const options = safeJson(script.options, {}) || {};
  let canvasChanged = 0;
  if (Array.isArray(options.canvasBinding?.actors)) {
    for (const actor of options.canvasBinding.actors) {
      if (!actor?.actorId || map.byId.has(actor.actorId)) continue;
      const byName = map.byName.get(String(actor.name || '').toLowerCase());
      if (byName) { actor.actorId = byName.id; canvasChanged += 1; }
    }
  }
  if (planChanged) run('UPDATE scripts SET plan = ?, updated_at = ? WHERE id = ?', JSON.stringify(plan), nowISO(), scriptId);
  if (canvasChanged) run('UPDATE scripts SET options = ?, updated_at = ? WHERE id = ?', JSON.stringify(options), nowISO(), scriptId);

  return {
    ok: true,
    scriptId,
    repairedShots: changes.length,
    repairedPlanCast: planChanged,
    repairedCanvasActors: canvasChanged,
    skippedLocked: skippedLocked.length,
    changes,
  };
}

export function splitPromptTokens(prompt) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of String(prompt || '')) {
    if (ch === '[') depth += 1;
    if (ch === ']') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function canonicalTime(value) {
  const raw = String(value || '');
  for (const [re, token] of TIME_CANON) if (re.test(raw)) return token;
  return '';
}

function tokenTime(token) {
  return canonicalTime(token);
}

function propMentioned(token, shot) {
  const text = `${shot.action || ''}\n${shot.dialogue || ''}`;
  const hints = PROP_HINTS[token] || [];
  if (hints.some((h) => text.includes(h))) return true;
  const refsProps = safeJson(shot.refs, {})?.props;
  if (Array.isArray(refsProps) && refsProps.some((p) => String(p).toLowerCase().includes(token))) return true;
  return false;
}

function isWideOrEmptyShot(shot) {
  const size = String(shot?.shot_size || '');
  if (/远|全|空镜|环境|establish|wide|aerial|vista/i.test(size)) return true;
  const refs = safeJson(shot?.refs, {}) || {};
  const chars = Array.isArray(refs.characters) ? refs.characters : [];
  const noDialogue = !String(shot?.dialogue || '').trim();
  const noPerson = !/(?:^|,\s*)(?:1boy|1girl|1person|2boys|2girls|man|woman|boy|girl|crowd|character|people)\b/i.test(String(shot?.prompt_pos || ''));
  // 没有台词、没有出场角色、提示词也没有人物锚点 → 视为空镜 / 环境镜，不算漏配角色
  return noDialogue && !chars.length && noPerson;
}

function auditShot(shot, mentionedNames = []) {
  const tokens = splitPromptTokens(shot.prompt_pos);
  const seen = new Map();
  const duplicates = [];
  for (const token of tokens) {
    const key = token.toLowerCase();
    if (seen.has(key)) duplicates.push(token);
    else seen.set(key, 1);
  }
  const canonical = canonicalTime(shot.time_of_day);
  const promptTimes = [...new Set(tokens.map(tokenTime).filter(Boolean))];
  const timeConflict = canonical && promptTimes.length > 0 && promptTimes.some((t) => t !== canonical);
  const irrelevantProps = [...seen.keys()].filter((token) => PROP_LEXICON.includes(token) && !propMentioned(token, shot));
  const refs = safeJson(shot.refs, {}) || {};
  const chars = Array.isArray(refs.characters) ? refs.characters : [];
  const anchor = /(?:^|,\s*)(?:1boy|1girl|1person|2boys|2girls|man|woman|boy|girl)\b/i.test(String(shot.prompt_pos || ''));
  const issues = [];
  if (duplicates.length) issues.push(`重复 token：${[...new Set(duplicates)].join('、')}`);
  if (timeConflict) issues.push(`时间矛盾：镜头是 ${canonical}，提示词含 ${promptTimes.filter((t) => t !== canonical).join('/')}`);
  if (irrelevantProps.length) issues.push(`可能无关道具：${irrelevantProps.join('、')}`);
  const wide = isWideOrEmptyShot(shot);
  if (!chars.length) {
    if (mentionedNames.length > 0) issues.push('角色引用为空');
    else if (anchor && !wide) issues.push('角色引用为空');
  } else if (!anchor) issues.push('缺少角色锚点');
  if (String(shot.prompt_pos || '').length > 1200) issues.push('提示词过长');
  if (!String(shot.prompt_neg || '').trim()) issues.push('缺少负面提示词');
  return {
    shotId: shot.id,
    idx: shot.idx,
    locked: Number(shot.locked) === 1,
    duplicates: [...new Set(duplicates)],
    timeConflict,
    canonicalTime: canonical,
    promptTimes,
    irrelevantProps,
    anchor,
    chars,
    issues,
  };
}

export function promptAudit(scriptId, episodeCode = '') {
  ensureScriptingSchema();
  const script = get('SELECT * FROM scripts WHERE id = ?', scriptId);
  if (!script) throw new Error('剧本不存在');
  const shots = episodeCode
    ? all(
      `SELECT s.* FROM shots s JOIN script_episodes e ON e.id = s.episode_id
       WHERE s.script_id = ? AND e.code = ? ORDER BY s.idx`,
      scriptId, episodeCode,
    )
    : all('SELECT * FROM shots WHERE script_id = ? ORDER BY episode_id, idx', scriptId);
  const map = actorMap();
  const audited = shots
    .map((shot) => auditShot(shot, mentionedActors(shot, map).map((a) => a.name)))
    .filter((x) => x.issues.length);
  return {
    ok: true,
    scriptId,
    episodeCode: episodeCode || null,
    summary: {
      shots: shots.length,
      issueShots: audited.length,
      duplicateTokens: audited.reduce((n, x) => n + x.duplicates.length, 0),
      timeConflicts: audited.filter((x) => x.timeConflict).length,
      irrelevantProps: audited.reduce((n, x) => n + x.irrelevantProps.length, 0),
      emptyCharacterRefs: audited.filter((x) => x.issues.includes('角色引用为空')).length,
      missingAnchor: audited.filter((x) => x.issues.includes('缺少角色锚点')).length,
      overlong: audited.filter((x) => x.issues.includes('提示词过长')).length,
      missingNegative: audited.filter((x) => x.issues.includes('缺少负面提示词')).length,
    },
    shots: audited,
  };
}

export function promptRepair(scriptId, episodeCode = '') {
  ensureScriptingSchema();
  const script = get('SELECT * FROM scripts WHERE id = ?', scriptId);
  if (!script) throw new Error('剧本不存在');
  const shots = episodeCode
    ? all(
      `SELECT s.* FROM shots s JOIN script_episodes e ON e.id = s.episode_id
       WHERE s.script_id = ? AND e.code = ? ORDER BY s.idx`,
      scriptId, episodeCode,
    )
    : all('SELECT * FROM shots WHERE script_id = ? ORDER BY episode_id, idx', scriptId);
  const changes = [];
  const skippedLocked = [];
  const map = actorMap();
  for (const shot of shots) {
    if (Number(shot.locked) === 1) { skippedLocked.push(shot.id); continue; }
    const audit = auditShot(shot, mentionedActors(shot, map).map((a) => a.name));
    const canonical = audit.canonicalTime;
    let tokens = splitPromptTokens(shot.prompt_pos);
    const seen = new Set();
    tokens = tokens.filter((token) => {
      const key = token.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      const tt = tokenTime(token);
      if (tt && canonical && tt !== canonical) return false;
      if (PROP_LEXICON.includes(key) && !propMentioned(key, shot)) return false;
      return true;
    });
    if (canonical && !tokens.some((t) => tokenTime(t) === canonical)) tokens.push(canonical);
    const nextPos = tokens.join(', ');
    const negTokens = splitPromptTokens(shot.prompt_neg);
    const negSeen = new Set();
    const nextNeg = negTokens.filter((token) => {
      const key = token.toLowerCase();
      if (negSeen.has(key)) return false;
      negSeen.add(key);
      return true;
    }).join(', ');
    if (nextPos !== shot.prompt_pos || nextNeg !== shot.prompt_neg) {
      run('UPDATE shots SET prompt_pos = ?, prompt_neg = ? WHERE id = ?', nextPos, nextNeg, shot.id);
      changes.push({ shotId: shot.id, idx: shot.idx, before: audit.issues, after: `${nextPos.length} 字` });
    }
  }
  return { ok: true, scriptId, episodeCode: episodeCode || null, repairedShots: changes.length, skippedLocked: skippedLocked.length, changes };
}

// 专业级提示词：按画风补镜头/光影/质量尾 + 去重 + 踢中文（确定性，不调 LLM、不花钱）
export function promptProfessionalize(scriptId, episodeCode = '') {
  ensureScriptingSchema();
  const script = get('SELECT * FROM scripts WHERE id = ?', scriptId);
  if (!script) throw new Error('剧本不存在');
  const styleId = script.style_id || 'cinematic-real';
  const shots = episodeCode
    ? all(
      `SELECT s.* FROM shots s JOIN script_episodes e ON e.id = s.episode_id
       WHERE s.script_id = ? AND e.code = ? ORDER BY s.idx`,
      scriptId, episodeCode,
    )
    : all('SELECT * FROM shots WHERE script_id = ? ORDER BY episode_id, idx', scriptId);
  const changes = [];
  const skippedLocked = [];
  for (const shot of shots) {
    if (Number(shot.locked) === 1) { skippedLocked.push(shot.id); continue; }
    const fixed = proPromptRepair(shot.prompt_pos || '', { styleId, negative: shot.prompt_neg || '' });
    if (fixed.positive !== (shot.prompt_pos || '') || fixed.negative !== (shot.prompt_neg || '')) {
      run('UPDATE shots SET prompt_pos = ?, prompt_neg = ? WHERE id = ?', fixed.positive, fixed.negative, shot.id);
      changes.push({ shotId: shot.id, idx: shot.idx, notes: fixed.notes, remaining: fixed.issues });
    }
  }
  return {
    ok: true,
    scriptId,
    episodeCode: episodeCode || null,
    styleId,
    professionalized: changes.length,
    skippedLocked: skippedLocked.length,
    changes,
  };
}
