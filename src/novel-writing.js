// 小说工坊 · 长章节正文写作（plain text module）
//
// 目标：单章正文按 2500-3500 字生成。核心小说的 writeChapter 在混淆层，
// 这里提供独立的单章长文通路，不改现有批量任务，也不修改已写正文之外的章节。

import { all, get, run } from './db.js';
import { chat, llmStatus } from './llm.js';
import { countWords } from './modules/novel.js';
import { nowISO } from './util.js';

export const CHAPTER_WRITE_MIN_WORDS = 2500;
export const CHAPTER_WRITE_MAX_WORDS = 3500;
export const CHAPTER_WRITE_TARGET_WORDS = 3000;

const clean = (v) => String(v ?? '').replace(/\r\n?/g, '\n').trim();
const safeJson = (v, fallback) => {
  try {
    const out = JSON.parse(v || '');
    return out == null ? fallback : out;
  } catch { return fallback; }
};

export function chapterWords(content) {
  return Number(countWords(clean(content))) || 0;
}

function latestOutline(novelId) {
  const row = get('SELECT * FROM novel_outlines WHERE novel_id = ? ORDER BY version DESC LIMIT 1', novelId);
  return row ? safeJson(row.payload, {}) : {};
}

function planOf(sections, idx) {
  return (Array.isArray(sections?.chapters) ? sections.chapters : []).find((x) => Number(x?.idx) === Number(idx)) || {};
}

function castOf(novel) {
  const ids = safeJson(novel.actor_ids, []).filter(Boolean).slice(0, 80);
  const actors = ids.length
    ? all(`SELECT id, name, role_type, gender, age, personality, background, costume FROM actors WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids)
    : [];
  const custom = safeJson(novel.custom_actors, []);
  return [
    ...actors.map((x) => ({ id: x.id, name: x.name, role: x.role_type || '', desc: [x.personality, x.background, x.costume].filter(Boolean).join('；') })),
    ...(Array.isArray(custom) ? custom.map((x) => ({ id: x.id || '', name: x.name || '', role: x.role || '自定义', desc: x.desc || '' })) : []),
  ].filter((x) => x.name).slice(0, 80);
}

function contextOf(novel, idx) {
  const sections = latestOutline(novel.id);
  const plan = planOf(sections, idx);
  const previous = all(
    'SELECT idx, title, summary, content FROM novel_chapters WHERE novel_id = ? AND idx < ? ORDER BY idx DESC LIMIT 3',
    novel.id, idx,
  ).reverse();
  const next = get('SELECT idx, title, summary FROM novel_chapters WHERE novel_id = ? AND idx = ?', novel.id, idx + 1);
  return {
    sections,
    plan,
    previous,
    next,
    cast: castOf(novel),
    locations: Array.isArray(sections.locations) ? sections.locations.slice(0, 80) : [],
    foreshadow: Array.isArray(sections.foreshadow) ? sections.foreshadow.slice(0, 100) : [],
  };
}

function buildPrompt(novel, idx, ctx, instruction = '') {
  const p = ctx.plan || {};
  const prevText = ctx.previous.map((x) => {
    const tail = clean(x.content).slice(-360);
    return `第${x.idx}章《${x.title || ''}》\n摘要：${x.summary || ''}\n正文结尾：${tail || '（未写）'}`;
  }).join('\n\n') || '（这是第一章或前面没有正文）';
  const cast = ctx.cast.map((x) => `${x.id} ${x.name}（${x.role || '角色'}）${x.desc ? `：${x.desc}` : ''}`).join('\n') || '（暂无角色档案）';
  const locations = ctx.locations.map((x) => `${x.id || ''} ${x.name || ''}：${x.desc || ''}`).join('\n') || '（暂无地点档案）';
  const foreshadow = ctx.foreshadow.map((x) => `${x.id || ''} ${x.content || ''}（埋设第${x.setup_chapter || '?'}章，回收第${x.payoff_chapter || '?'}章）`).join('\n') || '（暂无伏笔表）';
  return [
    '【任务】',
    `写第 ${idx} 章正文，目标 ${CHAPTER_WRITE_MIN_WORDS}-${CHAPTER_WRITE_MAX_WORDS} 个中文字符，最佳目标约 ${CHAPTER_WRITE_TARGET_WORDS} 字。`,
    '',
    '【小说参数】',
    `书名：${novel.title || ''}`,
    `题材：${novel.genre || ''}　基调：${novel.tone || ''}　视角：${novel.pov || ''}`,
    `全书框架：${novel.framework_intro || '（无）'}`,
    '',
    '【本章大纲】',
    `标题：${p.title || ''}`,
    `剧情：${p.summary || '（无详细大纲，请按前后章节合理承接）'}`,
    `关键事件：${(p.events || []).join('；') || '（无）'}`,
    `章末钩子：${p.cliffhanger || p.hook || '（无）'}`,
    '',
    '【前一章与上下文】',
    prevText,
    ctx.next ? `【下一章已知信息】第${ctx.next.idx}章 ${ctx.next.title || ''}：${ctx.next.summary || ''}` : '',
    '',
    '【角色】',
    cast,
    '',
    '【地点】',
    locations,
    '',
    '【伏笔】',
    foreshadow,
    instruction ? `\n【额外写作要求】\n${String(instruction).slice(0, 800)}` : '',
    '',
    '【硬性要求】',
    `1. 只输出本章正文，不要解释、不要 Markdown、不要输出章节标题。`,
    `2. 正文必须 ${CHAPTER_WRITE_MIN_WORDS}-${CHAPTER_WRITE_MAX_WORDS} 字，不能只写梗概。`,
    '3. 必须按本章大纲推进，不提前写完后几章的关键剧情。',
    '4. 场景、动作、对话、心理和冲突要具体，避免空泛总结。',
    '5. 结尾必须落在本章钩子上。',
  ].filter(Boolean).join('\n');
}

function buildRepairPrompt(novel, idx, ctx, current, instruction = '') {
  const len = chapterWords(current);
  const direction = len < CHAPTER_WRITE_MIN_WORDS
    ? `扩写并补足细节，目标 ${CHAPTER_WRITE_TARGET_WORDS} 字左右`
    : `压缩冗余、保留完整剧情和结尾钩子，目标 ${CHAPTER_WRITE_TARGET_WORDS} 字左右`;
  return [
    `第 ${idx} 章当前正文约 ${len} 字，不在 ${CHAPTER_WRITE_MIN_WORDS}-${CHAPTER_WRITE_MAX_WORDS} 字范围内。`,
    `请${direction}，重写为一章完整正文。`,
    `小说：${novel.title || ''}，题材：${novel.genre || ''}，基调：${novel.tone || ''}`,
    `本章大纲：${ctx.plan?.summary || ''}`,
    instruction ? `额外要求：${String(instruction).slice(0, 500)}` : '',
    `当前正文：\n${current}`,
    `只输出重写后的完整正文，不要解释，不要标题。正文必须 ${CHAPTER_WRITE_MIN_WORDS}-${CHAPTER_WRITE_MAX_WORDS} 字。`,
  ].filter(Boolean).join('\n');
}

function cleanModelText(text) {
  let out = clean(text);
  out = out.replace(/^```(?:text|markdown|md)?\s*/i, '').replace(/\s*```$/i, '').trim();
  out = out.replace(/^第\s*\d+\s*章[^\n]*\n+/i, '').trim();
  return out;
}

export function buildMockChapterText(novel, idx, ctx) {
  const title = ctx.plan?.title || `第${idx}章`;
  const events = Array.isArray(ctx.plan?.events) && ctx.plan.events.length
    ? ctx.plan.events
    : ['主角发现异常线索', '对手施加压力', '关键人物做出选择', '章末出现新危机'];
  const castNames = ctx.cast.map((x) => x.name).filter(Boolean).slice(0, 4);
  const paragraphs = [
    `【离线占位】${title}`,
    `夜色压下来时，${castNames[0] || '主角'}站在风口，手里攥着刚刚得到的线索。${ctx.plan?.summary || '事情没有按预想发展，新的阻碍已经逼近。'}`,
  ];
  let i = 0;
  while (paragraphs.join('\n\n').replace(/\s/g, '').length < CHAPTER_WRITE_TARGET_WORDS) {
    const event = events[i % events.length];
    const person = castNames[(i + 1) % Math.max(1, castNames.length)] || '对方';
    paragraphs.push(
      `${person}没有立刻表态。周围的动静被压得很低，${castNames[0] || '主角'}却知道，真正的冲突已经从暗处露头。${event}不是孤立的意外，而是一条正在收紧的绳结。`
      + `他回想前情里的每一个细节，把人物关系、时间顺序和可能被忽略的证词重新拼在一起。越接近答案，阻力就越明显；每一次试探都带来新的代价，也让下一步选择变得更难。`
      + `这一章的推进不能只靠解释，必须落到行动上：一句质问、一次交换、一个被藏起来的物件，都要改变局势。${ctx.plan?.cliffhanger || '章末，新的线索指向更危险的方向。'}`,
    );
    i += 1;
  }
  return paragraphs.join('\n\n');
}

function fitMax(content) {
  if (chapterWords(content) <= CHAPTER_WRITE_MAX_WORDS) return content;
  const chars = [...clean(content)];
  let cut = '';
  for (const ch of chars) {
    if ([...cut, ch].length > CHAPTER_WRITE_MAX_WORDS) break;
    cut += ch;
  }
  const last = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'));
  return (last >= CHAPTER_WRITE_MIN_WORDS ? cut.slice(0, last + 1) : cut).trim();
}

export async function writeLongChapter(novelId, idx, { save = true, instruction = '' } = {}) {
  const novel = get('SELECT * FROM novels WHERE id = ?', novelId);
  if (!novel) throw new Error('小说不存在');
  const row = get('SELECT * FROM novel_chapters WHERE novel_id = ? AND idx = ?', novelId, idx);
  if (!row) throw new Error(`第 ${idx} 章不存在`);
  const ctx = contextOf(novel, idx);
  const warnings = [];
  const status = llmStatus();
  let content = '';
  let model = '';
  let calls = 0;
  let mocked = false;

  if (status?.provider === 'mock') {
    content = buildMockChapterText(novel, idx, ctx);
    mocked = true;
  } else {
    const first = await chat({
      system: '你是中文长篇网文作者。严格输出正文，不输出说明、标题或 Markdown。',
      prompt: buildPrompt(novel, idx, ctx, instruction),
      temperature: 0.84,
      maxTokens: 8000,
    });
    content = cleanModelText(first?.text);
    model = first?.model || '';
    calls = 1;
    if (chapterWords(content) < CHAPTER_WRITE_MIN_WORDS || chapterWords(content) > CHAPTER_WRITE_MAX_WORDS) {
      const repaired = await chat({
        system: '你是中文长篇网文作者。严格按字数范围重写正文，只输出正文。',
        prompt: buildRepairPrompt(novel, idx, ctx, content, instruction),
        temperature: 0.7,
        maxTokens: 8000,
      });
      content = cleanModelText(repaired?.text);
      model = repaired?.model || model;
      calls += 1;
    }
  }

  content = fitMax(content);
  const words = chapterWords(content);
  if (words < CHAPTER_WRITE_MIN_WORDS) warnings.push(`第 ${idx} 章正文目前 ${words} 字，低于目标 ${CHAPTER_WRITE_MIN_WORDS}-${CHAPTER_WRITE_MAX_WORDS} 字`);
  if (words > CHAPTER_WRITE_MAX_WORDS) warnings.push(`第 ${idx} 章正文目前 ${words} 字，高于目标 ${CHAPTER_WRITE_MIN_WORDS}-${CHAPTER_WRITE_MAX_WORDS} 字`);

  if (save) {
    const now = nowISO();
    const title = ctx.plan?.title || row.title || `第${idx}章`;
    run(
      `UPDATE novel_chapters SET title = ?, content = ?, words = ?, status = 'done', model = ?, tokens = ?, error = NULL, updated_at = ?
       WHERE novel_id = ? AND idx = ?`,
      title, content, words, model || (mocked ? 'mock-long-chapter' : ''), 0, now, novelId, idx,
    );
    run('UPDATE novels SET status = ?, updated_at = ? WHERE id = ?', 'writing', now, novelId);
  }

  return {
    ok: true,
    novelId,
    idx: Number(idx),
    title: ctx.plan?.title || row.title || `第${idx}章`,
    content,
    words,
    range: { min: CHAPTER_WRITE_MIN_WORDS, max: CHAPTER_WRITE_MAX_WORDS, target: CHAPTER_WRITE_TARGET_WORDS },
    calls,
    mocked,
    model,
    saved: Boolean(save),
    warnings,
  };
}
