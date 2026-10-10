// 小说改编 → 正式生产小说/剧本/分集/分镜（plain text module）
//
// 目标：让“小说改编”项目不再只是一个 novel_id=null 的空剧本，而是物化成
// 正式 novels + novel_chapters + novel_outlines + scripts + script_episodes，
// 之后剧本工厂可以继续用原有 LLM/离线分镜链路生成 shots。

import { randomUUID } from 'node:crypto';
import { all, get, run } from './db.js';
import { splitChapters } from './novel-adapt.js';
import { commitCharacters } from './novel-ai.js';
import { nowISO, countWords } from './util.js';

function rid(prefix) {
  return `${prefix}-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function safeJson(value, fallback) {
  try {
    if (value === null || value === undefined || value === '') return fallback;
    if (typeof value === 'object') return value;
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function lastSentence(text) {
  const parts = String(text || '').split(/[。！？!?]/).map((x) => x.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1].slice(0, 120) : '';
}

function itemsOf(projectId, category) {
  return all(
    'SELECT * FROM adapt_items WHERE project_id = ? AND category = ? ORDER BY importance DESC, rowid ASC',
    projectId, category,
  ).map((item) => ({ ...item, details: safeJson(item.details, {}) }));
}

function groupBeatsIntoScenes(beats = []) {
  const scenes = [];
  let current = null;
  for (const beat of beats) {
    const location = cleanText(beat.location || '未知场景');
    const time = cleanText(beat.time || '白天');
    if (!current || current.location !== location || current.time !== time) {
      current = {
        no: scenes.length + 1,
        slug: `场${scenes.length + 1}`,
        location,
        location_id: '',
        time,
        characters: [],
        summary: '',
        beats: [],
      };
      scenes.push(current);
    }
    for (const name of (beat.characters || [])) {
      if (name && !current.characters.includes(name)) current.characters.push(name);
    }
    if (beat.action) current.beats.push({ type: 'action', text: String(beat.action).slice(0, 500) });
    if (beat.dialogue) current.beats.push({
      type: 'dialogue',
      text: String(beat.dialogue).slice(0, 300),
      character: (beat.characters || [])[0] || '',
    });
    current.summary = [current.summary, beat.action || beat.dialogue || ''].filter(Boolean).join(' ').slice(0, 180);
  }
  return scenes;
}

function buildOutlinePayload({ project, chapters, characterItems, sceneItems, scriptData, actorByName }) {
  const characters = characterItems.map((item) => ({
    id: actorByName.get(item.name.toLowerCase()) || `CX-ADP-${String(characterItems.indexOf(item) + 1).padStart(3, '0')}`,
    name: item.name,
    role_type: item.subtitle || item.details?.role || '配角',
    gender: item.details?.gender || '',
    age: '',
    appearance: item.prompt || '',
    personality: item.summary || '',
    background: item.summary || '',
    first_chapter: 1,
    arc: '',
    function: item.details?.role || '',
    relations: '',
  }));
  const locations = sceneItems.map((item, i) => ({
    id: `L-ADP-${String(i + 1).padStart(3, '0')}`,
    name: item.name,
    type: '场景',
    desc: item.summary || '',
    first_chapter: 1,
    en: item.details?.en || item.details?.prompt || '',
  }));
  const episode = scriptData?.episodes?.[0] || {};
  return {
    logline: episode.hook || `《${project.title}》改编自上传小说。`,
    framework: {
      core_conflict: episode.hook || '（由改编项目生成，待模型细化）',
      protagonist_goal: characters[0]?.function || '（待补充）',
      antagonist_force: characters.find((c) => /反派/.test(c.role_type))?.name || '（待补充）',
      three_acts: '（待补充）',
      theme: '（待补充）',
      opening_image: episode.hook || '',
      ending: '（待补充）',
    },
    worldview: { era: '', rules: '', power_system: '', taboos: '' },
    volumes: [],
    chapters: chapters.map((c) => ({
      idx: c.idx,
      title: c.title,
      summary: cleanText(c.text).slice(0, 180),
      hook: lastSentence(c.text),
      cliffhanger: lastSentence(c.text),
      characters: [],
      locations: [],
    })),
    timeline: [],
    locations,
    characters,
    foreshadow: [],
    reversals: [],
    beats: [],
    hooks: [],
    loops: [],
    logic: [],
    adaptProjectId: project.id,
  };
}

export async function adaptToProduction(projectId, {
  sync = false,
  title = '',
  styleId = 'cinematic-real',
  episodeSeconds = 60,
} = {}) {
  const project = get('SELECT * FROM adapt_projects WHERE id = ?', projectId);
  if (!project) throw new Error('改编项目不存在');
  const summary = safeJson(project.summary, {});
  if (summary.materializedNovelId && summary.productionScriptId) {
    const novel = get('SELECT * FROM novels WHERE id = ?', summary.materializedNovelId);
    const script = get('SELECT * FROM scripts WHERE id = ?', summary.productionScriptId);
    if (novel && script) {
      let episodes = all('SELECT * FROM script_episodes WHERE script_id = ?', script.id);
      let shots = all('SELECT * FROM shots WHERE script_id = ?', script.id);
      const warnings = [];
      if (sync && shots.length === 0 && episodes.length) {
        try {
          const { storyboard } = await import('./modules/script.js');
          await storyboard(script.id, { all: true, sync: true });
          shots = all('SELECT * FROM shots WHERE script_id = ?', script.id);
        } catch (err) {
          warnings.push(`自动分镜未完成：${err.message}；请在剧本工厂点「生成分镜」继续。`);
        }
      }
      return {
        ok: true,
        reused: true,
        novelId: novel.id,
        scriptId: script.id,
        actorIds: safeJson(novel.actor_ids, []),
        episodeCount: episodes.length,
        shotCount: shots.length,
        warnings,
      };
    }
  }

  const source = get('SELECT * FROM adapt_sources WHERE project_id = ?', projectId);
  if (!source?.text) throw new Error('改编项目没有正文');
  const chapters = splitChapters(source.text);
  const characterItems = itemsOf(projectId, 'character');
  const sceneItems = itemsOf(projectId, 'scene');
  const propItems = itemsOf(projectId, 'prop');
  const scriptItem = itemsOf(projectId, 'script')[0] || null;
  const scriptData = scriptItem?.details || null;
  const warnings = [];

  // 1) 角色卡：创建或复用演员矩阵 C-xxxx
  let actorResult = { created: [], failed: [], warnings: [] };
  try {
    actorResult = await commitCharacters({
      characters: characterItems.slice(0, 200).map((item) => ({
        name: item.name,
        role: item.subtitle || item.details?.role || '配角',
        gender: item.details?.gender === 'female' ? '女' : item.details?.gender === 'male' ? '男' : '未知',
        age: '',
        appearance: item.prompt || '',
        personality: item.summary || '',
        costume: '',
        background: item.summary || '',
        reason: item.details?.role || '',
      })),
    });
  } catch (err) {
    warnings.push(`角色卡创建失败，已继续物化小说/剧本：${err.message}`);
  }
  warnings.push(...(actorResult.warnings || []));
  if (actorResult.failed?.length) warnings.push(`部分角色卡创建失败：${actorResult.failed.map((x) => x.name).join('、')}`);
  const actorByName = new Map((actorResult.created || []).map((x) => [String(x.name || '').toLowerCase(), x.actorId]));
  const actorIds = [...new Set((actorResult.created || []).map((x) => x.actorId).filter(Boolean))];

  // 2) 正式小说
  const novelId = rid('N-ADP');
  const now = nowISO();
  const castSize = Math.min(200, Math.max(20, actorIds.length + 5));
  const frameworkIntro = [
    `【改编来源】${project.source_name || project.source_path || project.id}`,
    `【主要角色】${characterItems.map((c) => c.name).join('、') || '待补充'}`,
    `【首集钩子】${scriptData?.episodes?.[0]?.hook || lastSentence(source.text.slice(0, 800))}`,
  ].join('\n');
  run(
    `INSERT INTO novels(id, title, genre, sub_genre, tone, scale, cast_size, target_words, chapter_words, pov, framework_intro,
      actor_ids, custom_actors, ref_doc_path, ref_doc_name, style_id, seasons, status, meta, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    novelId,
    title || project.title || '改编小说',
    'urban-revenge',
    '',
    '热血燃向',
    'long',
    castSize,
    Math.max(10000, source.text.length),
    2000,
    'third-limited',
    frameworkIntro,
    JSON.stringify(actorIds),
    '[]',
    project.source_path || '',
    project.source_name || '',
    styleId,
    1,
    'outline_ready',
    JSON.stringify({ source: 'adapt', adaptProjectId: projectId }),
    now,
    now,
  );

  // 3) 合成大纲（先建 outline，再挂章节）
  const outlineId = rid('NO-ADP');
  const outlinePayload = buildOutlinePayload({ project, chapters, characterItems, sceneItems, scriptData, actorByName });
  run(
    `INSERT INTO novel_outlines(id, novel_id, version, status, payload, raw, model, tokens, elapsed_ms, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    outlineId, novelId, 1, 'done', JSON.stringify(outlinePayload), '', 'novel-adapt', 0, 0, now, now,
  );

  // 4) 章节正文
  for (const chapter of chapters) {
    const chapterId = rid('CH-ADP');
    const text = cleanText(chapter.text);
    const chapterCharacters = characterItems
      .filter((c) => text.includes(c.name))
      .map((c) => c.name);
    const chapterLocations = sceneItems
      .filter((s) => text.includes(s.name))
      .map((s) => s.name);
    run(
      `INSERT INTO novel_chapters(id, novel_id, outline_id, idx, volume, title, summary, content, words, hook, cliffhanger,
        characters, locations, status, model, tokens, error, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      chapterId, novelId, outlineId, chapter.idx, 1, chapter.title || `第${chapter.idx}章`,
      text.slice(0, 180), text, countWords(text), lastSentence(text), lastSentence(text),
      JSON.stringify(chapterCharacters), JSON.stringify(chapterLocations), 'done', 'novel-adapt', 0, null, now, now,
    );
  }

  // 5) 正式剧本 + 分集（把改编 beats 转成剧本工厂的 scenes.scenes 结构）
  const scriptId = rid('SC-ADP');
  const episodes = Array.isArray(scriptData?.episodes) && scriptData.episodes.length
    ? scriptData.episodes
    : chapters.map((c, i) => ({ episode: `S01E${String(i + 1).padStart(3, '0')}`, title: c.title, hook: lastSentence(c.text), beats: [], totalDuration: episodeSeconds }));
  run(
    `INSERT INTO scripts(id, novel_id, title, format, style_id, episode_seconds, episodes_per_season, seasons,
      skill_doc_path, skill_doc_name, options, plan, status, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    scriptId, novelId, `${title || project.title}·改编剧本`, 'manju', styleId, episodeSeconds,
    episodes.length, 1, null, null,
    JSON.stringify({ adaptProjectId: projectId, materializedNovelId: novelId, sourceType: 'adapt' }),
    JSON.stringify({ version: 1, mode: 'adapt', totalEpisodes: episodes.length, episodes }),
    'draft', now, now,
  );
  for (let i = 0; i < episodes.length; i += 1) {
    const ep = episodes[i];
    const scenes = groupBeatsIntoScenes(ep.beats || []);
    const episodeId = rid('EP-ADP');
    run(
      `INSERT INTO script_episodes(id, script_id, season, episode, code, title, logline, hook, cliffhanger,
        duration, source_chapters, scenes, status, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      episodeId, scriptId, 1, i + 1, ep.episode || `S01E${String(i + 1).padStart(3, '0')}`,
      ep.title || `第${i + 1}集`, ep.hook || '', ep.hook || '', ep.hook || '',
      Number(ep.totalDuration) || episodeSeconds, JSON.stringify([ep.sourceChapter].filter(Boolean)),
      JSON.stringify({ mode: 'adapt', scenes }), 'planned', now, now,
    );
  }

  // 6) 更新改编项目留痕
  const nextSummary = {
    ...summary,
    materializedNovelId: novelId,
    productionScriptId: scriptId,
    materializedAt: now,
    actorIds,
    episodeCount: episodes.length,
  };
  run('UPDATE adapt_projects SET summary = ?, updated_at = ? WHERE id = ?', JSON.stringify(nextSummary), now, projectId);

  // 7) 可选：直接触发分镜
  let shotCount = 0;
  let storyboardJobId = null;
  if (sync) {
    try {
      const { storyboard } = await import('./modules/script.js');
      const result = await storyboard(scriptId, { all: true, sync: true });
      shotCount = Number(result?.shots || result?.total || 0);
      storyboardJobId = result?.jobId || null;
    } catch (err) {
      warnings.push(`自动分镜未完成：${err.message}；请在剧本工厂点「生成分镜」继续。`);
    }
  }

  return {
    ok: true,
    reused: false,
    novelId,
    scriptId,
    actorIds,
    episodeCount: episodes.length,
    shotCount,
    storyboardJobId,
    warnings,
  };
}
