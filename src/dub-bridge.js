// 剧本工厂 · 配音表演桥（plain text module）
//
// 目的：把剧本工厂里新加的「说话人 / 表演情绪 / 音色」元数据，
//       接到 Module 4 的配音链路上，而不是让配音只能靠台词里猜说话人。
//
// Module 4 的配音（dub.js）按 `clip.speakerId` → 演员档案音色 选声音，
// 而 `speakerId` 来自「镜头出场角色 refs + 台词/动作里出现的角色名」的匹配。
// 因此本模块做两件事：
//   1. 把 shots.speaker（说话人名）补全，并在必要时把该角色的 C-xxxx 补进 refs.characters，
//      这样 Module 4 就能稳定解析到正确的说话人 → 用对演员音色。
//   2. 提供 情绪 → 语速 的换算，供配音 / 单镜编辑复用。
//
// 不修改 obfuscated 的 dub.js / modules/render.js，纯数据层面的桥接。

import { all, get, run } from './db.js';

export const EMOTION_SPEED = {
  平静: 1, 冷静: 1, 中性: 1, 温柔: 0.98, 温情: 0.98, 低沉: 0.95,
  紧张: 1.06, 焦虑: 1.08, 慌乱: 1.12, 恐惧: 1.1, 惊: 1.12, 惊恐: 1.12,
  愤怒: 1.08, 暴怒: 1.12, 激动: 1.08, 热血: 1.06, 兴奋: 1.08,
  悲伤: 0.94, 哭泣: 0.92, 无奈: 0.97, 疲惫: 0.94, 释然: 0.98,
};

const DIALOGUE_PREFIX = /^([\u4e00-\u9fffA-Za-z·]{2,8})[：:]/;

function safeJson(value, fallback) {
  try {
    if (value === null || value === undefined || value === '') return fallback;
    if (typeof value === 'object') return value;
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function actorMaps() {
  const actors = all('SELECT id, name, role_type, gender FROM actors');
  return {
    actors,
    byId: new Map(actors.map((a) => [a.id, a])),
    byName: new Map(actors.map((a) => [String(a.name || '').trim(), a])),
  };
}

// 从台词前缀 / 明确说话人 / 动作里出现的角色名，推断这一镜的说话人。
export function inferSpeakerName(shot, { byId, byName } = { byId: new Map(), byName: new Map() }) {
  const explicit = String(shot?.speaker || '').trim();
  if (explicit) {
    // 允许直接填 C-xxxx
    const asId = byId.get(explicit);
    if (asId) return asId.name;
    // 允许填角色名
    const asName = byName.get(explicit);
    if (asName) return asName.name;
    return explicit;
  }
  const dialogue = String(shot?.dialogue || '').trim();
  const m = dialogue.match(DIALOGUE_PREFIX);
  if (m) return m[1];
  const refs = safeJson(shot?.refs, {}) || {};
  const chars = Array.isArray(refs.characters) ? refs.characters : [];
  const names = chars.map((id) => byId.get(id)?.name).filter(Boolean);
  const hay = `${shot?.action || ''}\n${dialogue}`;
  const inAction = names.find((n) => hay.includes(n));
  if (inAction) return inAction;
  return '';
}

export function speedForEmotion(emotion) {
  const key = String(emotion || '').trim();
  if (!key) return 1;
  return EMOTION_SPEED[key] || 1;
}

// 解析单镜的表演元数据（供配音 / 单镜编辑复用）
export function resolveShotPerformance(shot, maps = actorMaps()) {
  const speaker = inferSpeakerName(shot, maps);
  const actor = speaker ? maps.byName.get(speaker) || null : null;
  return {
    speaker: speaker || '',
    speakerId: actor?.id || null,
    voiceId: String(shot?.voice_id || '').trim() || null,
    emotion: String(shot?.emotion || '').trim() || '',
    speed: speedForEmotion(shot?.emotion),
  };
}

// 把一集镜头的表演元数据落库，并保证 refs.characters 含说话人角色，
// 让 Module 4 能稳定解析到正确音色。
export function syncEpisodePerformances(scriptId, code) {
  const maps = actorMaps();
  const episode = get('SELECT * FROM script_episodes WHERE script_id = ? AND code = ?', scriptId, code);
  if (!episode) throw new Error('剧集不存在');
  const shots = all('SELECT * FROM shots WHERE episode_id = ? ORDER BY idx ASC', episode.id);
  const changes = [];
  for (const shot of shots) {
    const perf = resolveShotPerformance(shot, maps);
    const refs = safeJson(shot.refs, {}) || {};
    const chars = Array.isArray(refs.characters) ? refs.characters.slice() : [];
    let touched = false;
    if (!String(shot.speaker || '').trim() && perf.speaker) {
      run('UPDATE shots SET speaker = ? WHERE id = ?', perf.speaker, shot.id);
      touched = true;
    }
    if (perf.speakerId && !chars.includes(perf.speakerId)) {
      chars.push(perf.speakerId);
      refs.characters = chars;
      run('UPDATE shots SET refs = ? WHERE id = ?', JSON.stringify(refs), shot.id);
      touched = true;
    }
    if (touched) {
      changes.push({ shotId: shot.id, idx: shot.idx, speaker: perf.speaker, speakerId: perf.speakerId });
    }
  }
  return {
    ok: true,
    scriptId,
    episodeCode: code,
    shots: shots.length,
    updated: changes.length,
    changes,
    note: changes.length
      ? '已补全说话人并同步出场角色；Module 4 配音会据此选择演员音色。'
      : '所有镜头已有说话人元数据，无需改动。',
  };
}
