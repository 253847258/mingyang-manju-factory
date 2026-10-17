#!/usr/bin/env node
// Module 2: 全量分批规划回归（20 章之后必须能自动续跑到全书；进度按真实完成章数）
//
// 说明：mock LLM 产出的是「离线占位」大纲（chapterPlanComplete 按设计判为未完成），
// 因此这里用 planBatch 注入一个确定性规划器，专测"分批 / 进度 / 断点 / 卡死保护"。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-batch-plan-'));
process.env.FACTORY_DB = path.join(TMP, 'batch.db');
process.env.FACTORY_DATA_DIR = path.join(TMP, 'data');
process.env.FACTORY_CONFIG = path.join(TMP, 'config.json');
fs.mkdirSync(process.env.FACTORY_DATA_DIR, { recursive: true });
fs.writeFileSync(process.env.FACTORY_CONFIG, JSON.stringify({
  llm: { provider: 'mock' },
  image: { backend: 'placeholder' },
  video: { backend: 'placeholder' },
  tts: { backend: 'none' },
}));

const { migrate, run } = await import('../src/db.js');
const OAI = await import('../src/novel-outline-ai.js');
const { nowISO } = await import('../src/util.js');

migrate();
let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  PASS ${name}${extra ? ` -> ${extra}` : ''}`); }
  else { fail += 1; console.error(`  FAIL ${name}${extra ? ` -> ${extra}` : ''}`); }
};

const now = nowISO();
run(`INSERT INTO novels(id, title, genre, scale, cast_size, target_words, chapter_words, pov, seasons, status, actor_ids, custom_actors, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
'N-BATCH', '分批续跑测试', 'eastern-fantasy', 'medium', 10, 180000, 3000, 'third-limited', 1, 'writing', '[]', '[]', now, now);

const novel = OAI.novelOf('N-BATCH');
const empty = { chapters: [] };
const LONG = '测'.repeat(2600);

// 确定性规划器：把 [from,to] 每章写成"完整大纲"
const makePlanner = ({ completeRatio = 1, callsPerChapter = 1 } = {}) => async ({ sections, from, to }) => {
  const byIdx = new Map((sections.chapters || []).map((c) => [Number(c.idx), { ...c }]));
  let calls = 0;
  let acted = 0;
  for (let idx = from; idx <= to; idx += 1) {
    calls += callsPerChapter;
    if (acted / Math.max(1, to - from + 1) >= completeRatio) continue;
    acted += 1;
    byIdx.set(idx, {
      idx,
      volume: Math.min(10, Math.floor((idx - 1) / 300) + 1),
      title: `第${idx}章 测试章`,
      summary: LONG,
      start_state: `第${idx}章开始状态`,
      end_state: `第${idx}章结束状态`,
      events: [], hook: '', cliffhanger: '', characters: [], locations: [], pov: '', foreshadow: [],
    });
  }
  return {
    sections: { ...sections, chapters: [...byIdx.values()].sort((a, b) => a.idx - b.idx) },
    report: { calls, warnings: [] },
    consistency: { ok: true, issues: [] },
  };
};

console.log('\n=== 1. 全量分批（60 章 / 20 章一批）===');
const stats0 = OAI.chapterPlanStats(empty, novel);
ok('初始 60 章全部待规划', stats0.expected === 60 && stats0.missing.length === 60, `expected=${stats0.expected} missing=${stats0.missing.length}`);

const batches = [];
const r = await OAI.planAllChaptersBatched(novel, empty, {
  batchSize: 20,
  planBatch: makePlanner(),
  onBatch: (b) => batches.push({ from: b.from, to: b.to, complete: b.complete }),
});
ok('跑完后没有缺失章节', r.complete === true && r.stats.missing.length === 0, `complete=${r.stats.complete}/${r.expected}`);
ok('批次数 = ceil(60/20) = 3', r.batches === 3, `batches=${r.batches}`);
ok('进度真实且单调（20→40→60）', batches.length === 3 && batches[0].complete === 20 && batches[1].complete === 40 && batches[2].complete === 60, JSON.stringify(batches));
ok('不再出现「待规划」标题', r.sections.chapters.every((c) => !String(c.title || '').includes('待规划')), '');
ok('每章都有章首/章末', r.sections.chapters.every((c) => String(c.start_state || '').trim() && String(c.end_state || '').trim()), '');
ok('章节总数仍为 60（不擅自扩张）', r.sections.chapters.length === 60, `chapters=${r.sections.chapters.length}`);

console.log('\n=== 2. 断点续跑 ===');
const again = await OAI.planAllChaptersBatched(novel, r.sections, { batchSize: 20, planBatch: makePlanner() });
ok('已完成的库再跑：0 批、不重复消耗', again.batches === 0 && again.complete === true, `batches=${again.batches}`);

const partial = await OAI.planAllChaptersBatched(novel, empty, { batchSize: 20, maxBatches: 1, planBatch: makePlanner() });
ok('maxBatches=1 能中途停止并保留 20 章进度', partial.complete === false && partial.stats.complete === 20, `complete=${partial.stats.complete} remaining=${partial.remaining}`);
const resumed = await OAI.planAllChaptersBatched(novel, partial.sections, { batchSize: 20, planBatch: makePlanner() });
ok('从落盘进度继续能跑完', resumed.complete === true && resumed.batches === 2, `batches=${resumed.batches}`);

console.log('\n=== 3. 卡死保护 ===');
const stuckBatches = [];
const stuck = await OAI.planAllChaptersBatched(novel, empty, {
  batchSize: 20,
  maxBatches: 10,
  planBatch: makePlanner({ completeRatio: 0 }),
  onBatch: (b) => stuckBatches.push(b.complete),
});
ok('模型持续失败时两批后停止（不死循环）', stuck.complete === false && stuck.batches === 2, `batches=${stuck.batches}`);
ok('卡死时给出中文警告', stuck.warnings.some((w) => /没有新增规划/.test(w)), stuck.warnings.join(' | ').slice(0, 80));
ok('卡死时进度保持 0，不虚报', stuck.stats.complete === 0 && stuckBatches.every((x) => x === 0), JSON.stringify(stuckBatches));

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(fail ? 1 : 0);
