#!/usr/bin/env node
// Module 2: outline AI planning regression suite.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-outline-ai-test-'));
process.env.FACTORY_DB = path.join(TMP, 'novel-outline-ai.db');
process.env.FACTORY_DATA_DIR = path.join(TMP, 'data');
process.env.FACTORY_CONFIG = path.join(TMP, 'config.json');
fs.mkdirSync(process.env.FACTORY_DATA_DIR, { recursive: true });
fs.writeFileSync(process.env.FACTORY_CONFIG, JSON.stringify({
  llm: { provider: 'mock' },
  image: { backend: 'placeholder' },
  video: { backend: 'placeholder' },
  tts: { backend: 'none' },
}));

const { migrate, all, get, run } = await import('../src/db.js');
const { createActor } = await import('../src/modules/actors.js');
const OAI = await import('../src/novel-outline-ai.js');
const { createApp, createServer } = await import('../src/http.js');
const { registerNovelAiRoutes } = await import('../src/routes/novel-ai.js');
const { nowISO } = await import('../src/util.js');

migrate();

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass += 1;
    console.log(`  PASS ${name}${extra ? ` -> ${extra}` : ''}`);
  } else {
    fail += 1;
    console.error(`  FAIL ${name}${extra ? ` -> ${extra}` : ''}`);
  }
};
async function check(name, fn) {
  try {
    const extra = await fn();
    ok(name, true, extra || '');
  } catch (err) {
    ok(name, false, err.message);
  }
}

const now = nowISO();
const actor = createActor({ name: '沈砚', gender: 'male', role_type: '男主', style_id: 'cinematic-real' });
run(`INSERT INTO novels(id, title, genre, tone, cast_size, target_words, chapter_words, pov, framework_intro, actor_ids, custom_actors, seasons, status, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
'N-OAI', '大纲自动规划测试', 'urban-revenge', '热血燃向', 10, 24000, 2000, 'third-limited', '主角复仇',
JSON.stringify([actor.id]), JSON.stringify([{ id: 'CX-0001', name: '赵天豪', role: '反派' }]), 1, 'draft', now, now);

const chapterSkeletons = Array.from({ length: 12 }, (_, i) => ({
  idx: i + 1,
  volume: 1,
  title: `第${i + 1}章`,
  summary: '',
  events: [],
  cliffhanger: '',
  characters: [],
  locations: [],
  pov: '',
  _placeholder: true,
}));
run(`INSERT INTO novel_outlines(id, novel_id, version, status, payload, raw, model, tokens, elapsed_ms, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
'O-OAI', 'N-OAI', 1, 'ready', JSON.stringify({
  logline: '',
  framework: {},
  worldview: {},
  volumes: [],
  chapters: chapterSkeletons,
  timeline: [],
  locations: [],
  characters: [],
  foreshadow: [],
  reversals: [],
  beats: [],
  hooks: [],
  loops: [],
  logic: [],
}), '', 'mock-template', 0, 0, now, now);

console.log('\n=== 1. 状态：15 个分节与可补齐范围 ===');
let status;
await check('状态返回 15 个分节，14 个可 AI 补齐，chapters 单独规划', async () => {
  status = OAI.outlineAiStatus('N-OAI');
  assert.equal(status.hasOutline, true);
  assert.equal(status.sections.length, 15);
  assert.equal(status.missing.length, 15);
  assert.equal(status.fillable.length, 14);
  assert.equal(status.fillable.includes('chapters'), false);
  assert.equal(status.sections.find((x) => x.key === 'chapters')?.empty, true);
  assert.equal(status.chapterStats.expected, 12);
  assert.equal(status.chapterStats.missing.length, 12);
  return `missing=${status.missing.length}, chapters=${status.chapterStats.complete}/${status.chapterStats.expected}`;
});

console.log('\n=== 2. 逐节补齐与规范化 ===');
let filled;
await check('mock 逐节补齐 14 节，全部非空且明确标记离线', async () => {
  const novel = OAI.novelOf('N-OAI');
  const sections = OAI.loadSections('N-OAI');
  filled = await OAI.fillSections(novel, sections, {});
  assert.equal(filled.requested, 14);
  assert.equal(filled.results.length, 14);
  assert.equal(filled.calls, 0);
  assert.equal(filled.warnings.length, 14);
  assert.equal(OAI.missingSectionKeys(filled.sections).length, 0);
  assert.ok(String(filled.sections.logline).includes('【离线占位】'));
  return `results=${filled.results.length}, warnings=${filled.warnings.length}`;
});
await check('地点 ID 冲突自动编号，伏笔回收章晚于埋设章，强度限制 1..10', async () => {
  const ctx = { existingIds: ['L-0001'], nextLocationSeq: 2, castByName: new Map(), chapterMax: 100 };
  const loc = OAI.normalizeSection('locations', [{ id: 'L-0001', name: '同 ID 地点' }], ctx);
  assert.equal(loc[0].id, 'L-0002');
  const fs = OAI.normalizeSection('foreshadow', [{ content: '钥匙', setup_chapter: 30, payoff_chapter: 10 }], ctx);
  assert.equal(fs[0].payoff_chapter, 31);
  const beats = OAI.normalizeSection('beats', [{ chapter: 3, intensity: 99 }], ctx);
  assert.equal(beats[0].intensity, 10);
  return `${loc[0].id}, payoff=${fs[0].payoff_chapter}, intensity=${beats[0].intensity}`;
});
await check('指定章节范围逐章规划，只改目标章并保留其余章节槽位', async () => {
  const novel = OAI.novelOf('N-OAI');
  const planned = await OAI.planChapters(novel, filled.sections, { from: 2, to: 3 });
  assert.equal(planned.requested, 2);
  assert.equal(planned.calls, 0);
  assert.equal(planned.sections.chapters.length, 12);
  assert.match(planned.sections.chapters[1].title, /离线占位/);
  assert.match(planned.sections.chapters[2].summary, /离线占位/);
  assert.equal(planned.sections.chapters[0]._placeholder, true);
  filled = { ...filled, sections: planned.sections };
  return `range=${planned.from}-${planned.to}, results=${planned.results.length}`;
});
await check('章节规划规范化会夹紧章号并保留章节字段', async () => {
  const value = OAI.normalizeChapterPlan({
    chapter: {
      idx: 99,
      title: '规范化章节',
      start_state: '主角从上一章拿到线索后进入本章。',
      end_state: '主角找到证据但被对手发现。',
      handoff_in: '承接上一章章末的线索。',
      handoff_out: '把被发现的危机交给下一章。',
      storyline_anchor: '主线调查推进，触发中盘转折。',
      summary: '字'.repeat(4000),
      events: ['事件一', '事件二'],
      characters: ['C-0001'],
      locations: ['L-0001'],
      foreshadow: ['FS-01'],
    },
  }, { chapterMax: 12 }, 12);
  assert.equal(value.idx, 12);
  assert.equal(value.title, '规范化章节');
  assert.equal(value.events.length, 2);
  assert.equal(value.characters[0], 'C-0001');
  assert.match(value.start_state, /上一章/);
  assert.match(value.end_state, /对手/);
  assert.equal(value.summary.length, OAI.OUTLINE_AI_CHAPTER_MAX_CHARS);
  assert.equal(OAI.chapterPlanComplete(value), true);
  assert.equal(OAI.chapterPlanComplete({ ...value, summary: '短大纲' }), false);
  return `idx=${value.idx}, summary=${value.summary.length}, events=${value.events.length}`;
});

console.log('\n=== 3. 落库与章节骨架同步 ===');
await check('保存后新增版本，并同步 chapters 骨架行', async () => {
  const saved = OAI.saveOutlineVersion('N-OAI', filled.sections, { source: 'test-fill' });
  assert.equal(saved.version, 2);
  assert.equal(saved.chapters, 12);
  assert.equal(saved.synced.created, 12);
  const versions = all('SELECT version FROM novel_outlines WHERE novel_id = ? ORDER BY version', 'N-OAI').map((x) => x.version);
  assert.deepEqual(versions, [1, 2]);
  assert.equal(get('SELECT COUNT(*) AS c FROM novel_chapters WHERE novel_id = ?', 'N-OAI').c, 12);
  return `v${saved.version}, chapters=${saved.synced.created}`;
});

console.log('\n=== 4. HTTP 接口 ===');
const { app, handle } = createApp();
registerNovelAiRoutes(app);
const server = createServer((req, res) => handle(req, res, {}));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

await check('GET /outline/ai/status 路由参数可用且返回 15 节', async () => {
  const res = await fetch(`${base}/api/novels/N-OAI/outline/ai/status`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.sections.length, 15);
  return `v${json.version}, sections=${json.sections.length}`;
});
await check('POST /outline/ai/section save=true 只覆盖指定节并新增版本', async () => {
  const res = await fetch(`${base}/api/novels/N-OAI/outline/ai/section`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: 'hooks', save: true }),
  });
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.key, 'hooks');
  assert.equal(json.mocked, true);
  assert.equal(json.saved.version, 3);
  const sections = OAI.loadSections('N-OAI');
  assert.ok(Array.isArray(sections.hooks) && sections.hooks.length > 0);
  assert.ok(Array.isArray(sections.locations) && sections.locations.length > 0);
  return `v${json.saved.version}, hooks=${json.value.length}`;
});
await check('POST /outline/ai/fill save=false 不写库', async () => {
  const before = OAI.loadSections('N-OAI');
  const res = await fetch(`${base}/api/novels/N-OAI/outline/ai/fill`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ keys: ['reversals'], save: false, onlyEmpty: false }),
  });
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.requested, 1);
  const after = OAI.loadSections('N-OAI');
  assert.deepEqual(after, before);
  return `requested=${json.requested}, saved=${json.saved}`;
});
await check('POST /outline/ai/chapters save=true 只规划指定章并新增版本', async () => {
  const res = await fetch(`${base}/api/novels/N-OAI/outline/ai/chapters`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from: 4, to: 5, onlyEmpty: true, save: true }),
  });
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.from, 4);
  assert.equal(json.to, 5);
  assert.equal(json.requested, 2);
  assert.equal(json.mocked, true);
  assert.equal(json.saved.version, 4);
  assert.equal(json.stats.expected, 12);
  assert.match(json.results[0].title, /离线占位/);
  const sections = OAI.loadSections('N-OAI');
  assert.equal(sections.chapters.length, 12);
  assert.match(sections.chapters[3].title, /离线占位/);
  assert.equal(sections.chapters[0].title, '第1章');
  return `v${json.saved.version}, range=${json.from}-${json.to}`;
});

console.log('\n=== 5. 章首/章末补全（单次整份大纲的短板） ===');
await check('enrichChapterHandoff 用相邻摘要推导章首/章末并成环、不覆盖已有内容', async () => {
  const sections = {
    chapters: [
      { idx: 1, title: '第1章', summary: '主角接到匿名线索' },
      { idx: 2, title: '第2章', summary: '主角追查旧案' },
      { idx: 3, title: '第3章', summary: '真相逼近但代价沉重', cliffhanger: '新危机出现' },
    ],
  };
  const r = OAI.enrichChapterHandoff({}, sections);
  assert.equal(r.filled, 6);
  assert.match(r.chapters[0].start_state, /开篇承接/);
  const prevEnd = r.chapters[0].end_state.replace('推进到下一章：', '');
  assert.match(r.chapters[1].start_state, /承接上一章/);
  assert.ok(r.chapters[1].start_state.includes(prevEnd));
  assert.match(r.chapters[2].end_state, /本章收束/);
  assert.ok(r.chapters[1].handoff_in && r.chapters[1].handoff_out);
  // 前缀不叠加（曾出现「承接上一章：推进到下一章：…」）
  assert.ok(r.chapters.every((c) => !/承接上一章[:：]\s*推进到下一章/.test(c.start_state)));
  assert.ok(r.chapters.every((c) => !/承接上一章[:：]\s*承接上一章/.test(c.start_state)));
  const again = OAI.enrichChapterHandoff({}, { chapters: r.chapters });
  assert.equal(again.filled, 0);
  return `filled=${r.filled}, 二次=${again.filled}`;
});
await check('POST /outline/ai/enrich-handoff 补全并落库为新版本', async () => {
  const cur = OAI.loadSections('N-OAI');
  const stripped = (cur.chapters || []).map((c, i) => ({
    idx: i + 1, title: c.title || `第${i + 1}章`, summary: c.summary || `第${i + 1}章剧情`, _placeholder: false,
  }));
  const saved = await fetch(`${base}/api/novels/N-OAI/outline/ai/save`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sections: { ...cur, chapters: stripped }, source: 'test-strip-handoff' }),
  });
  assert.equal(saved.status, 200);
  const res = await fetch(`${base}/api/novels/N-OAI/outline/ai/enrich-handoff`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ save: true }),
  });
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.ok(json.filled > 0);
  assert.ok(json.saved && json.saved.version > 0);
  const after = OAI.loadSections('N-OAI');
  assert.ok(after.chapters.every((c) => String(c.start_state || '').trim() && String(c.end_state || '').trim()));
  return `filled=${json.filled} v${json.saved.version}`;
});

console.log('\n=== 6. 多线程统筹规划 ===');
await check('mapLimit 并发不超过上限且顺序稳定', async () => {
  let active = 0; let peak = 0;
  const out = await OAI.mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    active += 1; peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 15));
    active -= 1;
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14]);
  assert.ok(peak <= 3 && peak >= 2, `peak=${peak}`);
  return `peak=${peak}`;
});
await check('fillSectionsParallel 并发补齐全部分节（mock）', async () => {
  const novel = OAI.novelOf('N-OAI');
  const r = await OAI.fillSectionsParallel(novel, { chapters: [] }, { concurrency: 4 });
  assert.ok(r.results.length >= 13, `results=${r.results.length}`);
  assert.equal(OAI.missingSectionKeys(r.sections, OAI.OUTLINE_AI_DEFAULT_KEYS).length, 0);
  assert.ok(r.concurrency >= 2);
  // 定调分节（locations/characters/framework/logline/worldview）先出，其余再并发引用
  const canon = ['locations', 'characters', 'framework', 'logline', 'worldview'];
  assert.ok(r.results.slice(0, 5).every((x) => canon.includes(x.key)), r.results.slice(0, 5).map((x) => x.key).join(','));
  assert.equal(r.results[0].key, 'locations');
  return `sections=${r.results.length} concurrency=${r.concurrency}`;
});
await check('planChaptersParallel 并发规划章节并按 idx 归位（mock）', async () => {
  const novel = OAI.novelOf('N-OAI');
  const secs = OAI.loadSections('N-OAI');
  const r = await OAI.planChaptersParallel(novel, secs, { from: 1, to: 3, onlyEmpty: false, concurrency: 3 });
  assert.equal(r.results.length, 3);
  assert.deepEqual(r.results.map((x) => x.idx), [1, 2, 3]);
  assert.equal(r.sections.chapters.length, 12);
  assert.equal(r.concurrency, 3);
  return `concurrency=${r.concurrency}`;
});
await check('orchestrateOutline 产出统筹报告且章节成环', async () => {
  const novel = OAI.novelOf('N-OAI');
  const r = await OAI.orchestrateOutline(novel, { chapters: [] }, { concurrency: 3, sectionsConcurrency: 4 });
  const names = r.report.steps.map((s) => s.name);
  assert.ok(names.includes('sections') && names.includes('chapters') && names.includes('merge'), names.join(','));
  assert.ok(r.sections.chapters.length > 0);
  assert.ok(r.sections.chapters.every((c) => String(c.start_state || '').trim() && String(c.end_state || '').trim()));
  return `steps=${names.join('→')} chapters=${r.sections.chapters.length}`;
});
await check('auditOutlineConsistency 抓出悬空人物 ID / 反派未进框架 / 未引用地点', async () => {
  const r = OAI.auditOutlineConsistency({
    characters: [{ id: 'C-0001', name: '沈砚', role: '主角' }, { id: 'C-0002', name: '陆行舟', role: '反派' }],
    logline: '沈砚追查真相',
    framework: { antagonist_force: '幕后集团' },
    storyline: {},
    locations: [{ id: 'L-0001' }, { id: 'L-0002' }],
    chapters: [{ start_state: 'C-0009 出现', summary: 'L-0001' }],
  });
  assert.equal(r.ok, false);
  const types = r.issues.map((x) => x.type);
  for (const t of ['unknownCharacterId', 'characterUnused', 'villainNotInFramework', 'unusedLocations']) {
    assert.ok(types.includes(t), `缺少 ${t}（实际：${types.join(',')}）`);
  }
  return types.join(',');
});
await check('orchestrateOutline 返回一致性校对结果', async () => {
  const novel = OAI.novelOf('N-OAI');
  const r = await OAI.orchestrateOutline(novel, { chapters: [] }, { concurrency: 3, sectionsConcurrency: 4 });
  assert.ok(r.consistency && typeof r.consistency.ok === 'boolean');
  assert.equal(r.report.consistency, r.consistency);
  return `ok=${r.consistency.ok} issues=${r.consistency.issues.length}`;
});
await check('POST /outline/ai/orchestrate-job 后台完成并落库', async () => {
  const started = await (await fetch(`${base}/api/novels/N-OAI/outline/ai/orchestrate-job`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ concurrency: 3, sectionsConcurrency: 4 }),
  })).json();
  assert.match(started.jobId, /^JOB-/);
  assert.equal(started.concurrency, 3);
  const { getJob } = await import('../src/jobs.js');
  let job = null;
  for (let i = 0; i < 150; i += 1) {
    job = getJob(started.jobId);
    if (['done', 'error', 'canceled'].includes(job.status)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(job.status, 'done', job.error || '');
  assert.ok(job.result.saved?.version > 0);
  const sec = OAI.loadSections('N-OAI');
  assert.ok(sec.chapters.length > 0);
  assert.ok(sec.chapters.every((c) => String(c.start_state || '').trim() && String(c.end_state || '').trim()));
  return `v${job.result.saved.version} calls=${job.result.calls}`;
});

if (server.closeAllConnections) server.closeAllConnections();
await new Promise((resolve) => server.close(resolve));
console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
process.exitCode = fail ? 1 : 0;
