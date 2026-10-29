#!/usr/bin/env node
// 小说工坊四步生产线独立回归：章纲 → 内容卡 → 资产布置 → 正文续写。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-novel-pipeline-test-'));
process.env.FACTORY_DB = path.join(TMP, 'novel-pipeline.db');
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
const { saveOutlineVersion } = await import('../src/novel-outline-ai.js');
const { countWords } = await import('../src/modules/novel.js');
const { nowISO } = await import('../src/util.js');
const pipeline = await import('../src/novel-pipeline.js');

let pass = 0;
let fail = 0;
async function check(name, work) {
  try {
    const detail = await work();
    pass += 1;
    console.log(`  PASS ${name}${detail ? ` -> ${detail}` : ''}`);
  } catch (error) {
    fail += 1;
    console.error(`  FAIL ${name} -> ${error.message}`);
  }
}

migrate();

const NOVEL_ID = 'N-PIPELINE-TEST';
const now = nowISO();
let actor;
let initialSnapshot;
let deterministicCard;
let firstCards;
let firstPlan;
let savedCard;
let editableAsset;
let confirmResult;
let oldContent;

const chapters = [
  {
    idx: 1,
    volume: 1,
    title: '第一章 夜雨货栈',
    summary: '沈砚在旧码头仓库追查失踪货单，却发现青铜钥匙被反派抢先夺走。',
    start_state: '沈砚带着半张货单来到旧码头仓库。',
    end_state: '青铜钥匙落入反派手中，仓库突然断电。',
    handoff_in: '上一章留下的货单指向旧码头。',
    handoff_out: '断电后的仓库里出现第二个人影。',
    cliffhanger: '黑暗中有枪栓被拉响。',
    events: [
      '沈砚进入旧码头仓库核对失踪货单。',
      '他在值班室发现沾血的青铜钥匙。',
      '反派伏击并夺走青铜钥匙。',
      '仓库断电，门外传来第二辆车的声音。',
    ],
    characters: [{ id: 'PLACEHOLDER_ACTOR', name: '沈砚', role: '男主' }],
    locations: [{ id: 'L-0001', name: '旧码头仓库', type: '仓库' }],
    props: [{ id: 'P-0001', name: '青铜钥匙', type: '关键道具' }],
    pov: '沈砚',
  },
  {
    idx: 2,
    volume: 1,
    title: '第二章 断电之后',
    summary: '沈砚在旧码头仓库的断电中反击，并追到一辆黑色货车。',
    start_state: '仓库陷入黑暗，枪栓声逼近。',
    end_state: '沈砚救出证人，但黑色货车留下新的城市坐标。',
    handoff_in: '反派持有青铜钥匙。',
    handoff_out: '货车驶向废弃钟楼。',
    cliffhanger: '钟楼在午夜提前敲响。',
    events: ['沈砚利用货架掩护反击。', '他救下藏在冷库里的证人。', '证人交出第二把钥匙的拓片。', '黑色货车驶向废弃钟楼。'],
    characters: [{ id: 'PLACEHOLDER_ACTOR', name: '沈砚', role: '男主' }],
    locations: [{ id: 'L-0001', name: '旧码头仓库', type: '仓库' }],
    props: [{ id: 'P-0001', name: '青铜钥匙', type: '关键道具' }],
    pov: '沈砚',
  },
  {
    idx: 3,
    volume: 1,
    title: '第三章 午夜钟楼',
    summary: '沈砚潜入钟楼，发现青铜钥匙关系到整座城市的秘密广播系统。',
    start_state: '沈砚跟随坐标抵达废弃钟楼。',
    end_state: '广播系统被启动，全城听见同一个陌生声音。',
    handoff_in: '黑色货车驶向废弃钟楼。',
    handoff_out: '陌生声音点名沈砚。',
    cliffhanger: '广播念出了沈砚早已死去的真名。',
    events: ['沈砚从地下管廊潜入钟楼。', '他用拓片打开控制室。', '反派启动秘密广播系统。', '全城广播喊出沈砚的真名。'],
    characters: [{ id: 'PLACEHOLDER_ACTOR', name: '沈砚', role: '男主' }],
    locations: [{ id: 'L-0001', name: '旧码头仓库', type: '仓库' }],
    props: [{ id: 'P-0001', name: '青铜钥匙', type: '关键道具' }],
    pov: '沈砚',
  },
];

console.log('\n=== 1. 临时库与三章大纲 ===');
await check('初始化临时库、演员、小说、三章骨架和章纲', () => {
  actor = createActor({ name: '沈砚', gender: 'male', role_type: '男主', style_id: 'cinematic-real' });
  for (const chapter of chapters) chapter.characters[0].id = actor.id;
  run(
    `INSERT INTO novels(id, title, genre, scale, cast_size, target_words, chapter_words, pov, framework_intro, actor_ids, custom_actors, seasons, status, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    NOVEL_ID, '四步生产线测试', 'urban-suspense', 'short', 2, 9000, 3000, 'third-limited',
    '围绕青铜钥匙追查城市秘密广播。', JSON.stringify([actor.id]), '[]', 1, 'writing', now, now,
  );
  const saved = saveOutlineVersion(NOVEL_ID, {
    logline: '一个小人物追查青铜钥匙，撕开城市秘密广播。',
    chapters,
    characters: [{ id: actor.id, name: '沈砚', role: '男主', arc: '从追查者变成被追捕者。' }],
    locations: [{ id: 'L-0001', name: '旧码头仓库', type: '仓库', desc: '潮湿、断电、堆满旧货箱。' }],
    props: [{ id: 'P-0001', name: '青铜钥匙', type: '关键道具', desc: '表面有齿轮纹路的旧钥匙。' }],
    foreshadow: [],
  }, { source: 'test-fixture', note: '三章生产线夹具' });
  assert.equal(saved.chapters, 3);
  assert.equal(get('SELECT COUNT(*) AS n FROM novel_chapters WHERE novel_id = ?', NOVEL_ID).n, 3);
  assert.equal(get('SELECT COUNT(*) AS n FROM novel_outlines WHERE novel_id = ?', NOVEL_ID).n, 1);
  return `actor=${actor.id}, chapters=3, outline=v${saved.version}`;
});

console.log('\n=== 2. 四步流程门禁 ===');
await check('pipelineSnapshot 返回四步，且内容卡/资产/确认未完成时后续步骤阻塞', () => {
  initialSnapshot = pipeline.pipelineSnapshot(NOVEL_ID);
  assert.deepEqual(initialSnapshot.steps.map((step) => step.key), ['outline', 'cards', 'assets', 'prose']);
  assert.equal(initialSnapshot.steps[0].complete, true);
  assert.equal(initialSnapshot.steps[1].complete, false);
  assert.equal(initialSnapshot.steps[2].complete, false);
  assert.equal(initialSnapshot.steps[3].complete, false);
  assert.ok(initialSnapshot.summary.blockers.some((item) => item.includes('内容卡')));
  assert.ok(initialSnapshot.summary.blockers.some((item) => item.includes('资产')));
  return initialSnapshot.summary.blockers.slice(0, 3).join(' | ');
});

console.log('\n=== 3. 确定性内容卡 ===');
await check('buildDeterministicChapterCard 生成 3-8 个 beats、关键帧和人物/环境/物品引用', () => {
  deterministicCard = pipeline.buildDeterministicChapterCard(NOVEL_ID, 1);
  assert.ok(deterministicCard.beats.length >= 3 && deterministicCard.beats.length <= 8);
  assert.ok(String(deterministicCard.key_frame || '').trim().length > 10);
  assert.ok(deterministicCard.characters.some((item) => String(item).includes(actor.id)));
  assert.ok(deterministicCard.environments.some((item) => String(item).includes('L-0001')));
  assert.ok(deterministicCard.props.some((item) => String(item).includes('P-0001')));
  assert.ok(deterministicCard.beats.every((beat) => beat.action && beat.visual));
  return `beats=${deterministicCard.beats.length}`;
});

console.log('\n=== 4. 批量内容卡与断点补缺 ===');
await check('generateChapterCards 在 mock 下生成三章并落库，重复只补缺失', async () => {
  firstCards = await pipeline.generateChapterCards(NOVEL_ID, { from: 1, to: 3, onlyMissing: true });
  assert.equal(firstCards.generated, 3);
  assert.equal(firstCards.skipped, 0);
  assert.equal(firstCards.mocked, true);
  const saved = pipeline.pipelineSnapshot(NOVEL_ID);
  assert.deepEqual(Object.keys(saved.pipeline.chapter_cards).map(Number).sort(), [1, 2, 3]);
  const again = await pipeline.generateChapterCards(NOVEL_ID, { from: 1, to: 2, onlyMissing: true });
  assert.equal(again.generated, 0);
  assert.equal(again.skipped, 2);
  return `首次生成=${firstCards.generated}，重复跳过=${again.skipped}`;
});

console.log('\n=== 5. 内容卡人工编辑 ===');
await check('saveChapterCard 可编辑并持久化内容卡', () => {
  savedCard = pipeline.saveChapterCard(NOVEL_ID, 1, {
    title: '第一章 雨夜断货',
    objective: '找到失踪货单并确认青铜钥匙的持有人。',
    conflict: '沈砚必须在反派毁掉证据前夺回货单。',
  });
  assert.equal(savedCard.card.title, '第一章 雨夜断货');
  const reloaded = pipeline.pipelineSnapshot(NOVEL_ID).pipeline.chapter_cards[1];
  assert.equal(reloaded.objective, '找到失踪货单并确认青铜钥匙的持有人。');
  assert.ok(reloaded.beats.length >= 3);
  return reloaded.title;
});

console.log('\n=== 6. 资产计划 ===');
await check('buildAssetPlan 生成人物/环境/物品资产、提示词和 by_chapter 映射', () => {
  const result = pipeline.buildAssetPlan(NOVEL_ID);
  firstPlan = result.plan;
  const kinds = new Set(firstPlan.assets.map((asset) => asset.kind));
  assert.ok(kinds.has('character'));
  assert.ok(kinds.has('environment'));
  assert.ok(kinds.has('prop'));
  assert.ok(firstPlan.assets.every((asset) => String(asset.prompt || '').trim()));
  assert.ok(firstPlan.assets.every((asset) => String(asset.negative_prompt || '').trim()));
  assert.ok(Object.keys(firstPlan.by_chapter).length >= 3);
  return `assets=${firstPlan.assets.length}, chapters=${Object.keys(firstPlan.by_chapter).length}`;
});

await check('buildAssetPlan 重复执行不重复资产', () => {
  const second = pipeline.buildAssetPlan(NOVEL_ID).plan;
  const signature = (plan) => plan.assets
    .map((asset) => `${asset.key}|${asset.name}|${asset.prompt}`)
    .sort();
  assert.deepEqual(signature(second), signature(firstPlan));
  assert.equal(second.assets.length, firstPlan.assets.length);
  return `两次均为 ${second.assets.length} 条`;
});

console.log('\n=== 7. 资产编辑与阻塞 ===');
await check('updatePipelineAsset 可修改 prompt/reference_images，空 prompt 产生 blocker', () => {
  editableAsset = firstPlan.assets.find((asset) => asset.kind === 'environment');
  assert.ok(editableAsset);
  const updated = pipeline.updatePipelineAsset(NOVEL_ID, editableAsset.key, {
    prompt: '旧码头仓库电影场景，广角远景，潮湿地面，冷蓝月光，真实电影质感，35mm 镜头',
    reference_images: ['refs/dock-a.png', 'refs/dock-b.png'],
  });
  assert.deepEqual(updated.asset.reference_images, ['refs/dock-a.png', 'refs/dock-b.png']);
  assert.equal(updated.asset.blockers.length, 0);
  const blocked = pipeline.updatePipelineAsset(NOVEL_ID, editableAsset.key, { prompt: '' });
  assert.equal(blocked.asset.status, 'blocked');
  assert.ok(blocked.asset.blockers.some((item) => item.includes('提示词')));
  return blocked.asset.blockers[0];
});

await check('资产有 blocker 时未强制确认返回中文错误，未确认正文续写被拦截', async () => {
  assert.throws(
    () => pipeline.confirmAssetPlan(NOVEL_ID),
    /资产计划有 \d+ 个阻塞项/,
  );
  let message = '';
  try {
    await pipeline.continueChapter(NOVEL_ID, 1, { mode: 'continue' });
  } catch (error) {
    message = error.message;
  }
  assert.match(message, /资产计划尚未确认/);
  return message;
});

console.log('\n=== 8. 画布同步 ===');
await check('syncAssetPlanToCanvas 首次同步资产节点，第二次不重复创建', async () => {
  const actors = await import('../src/modules/actors.js');
  const canvasId = 'CV-PIPELINE-TEST';
  if (typeof actors.createCanvas === 'function' && !get('SELECT id FROM canvases WHERE id = ?', canvasId)) {
    try { actors.createCanvas({ id: canvasId, name: '生产线测试画布' }); } catch { /* 兼容不同建画布入参 */ }
  }
  if (!get('SELECT id FROM canvases WHERE id = ?', canvasId)) {
    run('INSERT INTO canvases(id, name, created_at, updated_at) VALUES(?,?,?,?)', canvasId, '生产线测试画布', now, now);
  }
  const beforeNodes = get('SELECT COUNT(*) AS n FROM canvas_nodes WHERE canvas_id = ?', canvasId).n;
  const first = await pipeline.syncAssetPlanToCanvas(NOVEL_ID, { canvasId });
  assert.ok(first.plan?.canvas_summary);
  assert.ok(first.plan.canvas_summary.created >= 1);
  const afterFirst = get('SELECT COUNT(*) AS n FROM canvas_nodes WHERE canvas_id = ?', canvasId).n;
  const second = await pipeline.syncAssetPlanToCanvas(NOVEL_ID, { canvasId });
  const afterSecond = get('SELECT COUNT(*) AS n FROM canvas_nodes WHERE canvas_id = ?', canvasId).n;
  assert.equal(afterSecond, afterFirst);
  assert.equal(second.created, 0);
  assert.deepEqual(first.nodes, second.nodes);
  return `节点 ${beforeNodes}→${afterFirst}，二次创建 ${second.created}`;
});

console.log('\n=== 9. 强制确认与正文续写 ===');
await check('forced=true 可确认资产计划并记录 forced/blockers', () => {
  confirmResult = pipeline.confirmAssetPlan(NOVEL_ID, { forced: true, note: '测试环境验证强制确认', operator: '自动化测试' });
  assert.equal(confirmResult.confirmation.confirmed, true);
  assert.equal(confirmResult.confirmation.forced, true);
  assert.ok(confirmResult.confirmation.blockers.length >= 1);
  assert.equal(confirmResult.confirmation.operator, '自动化测试');
  return `blockers=${confirmResult.confirmation.blockers.length}`;
});

await check('确认后 mock 续写成功，正文与 words 增加，旧正文进入 prose_history', async () => {
  const initialContent = '沈砚推开仓库铁门，雨水顺着货箱滴落。他听见远处传来一声短促的枪响。\n\n他握紧半张货单，朝值班室走去。';
  oldContent = initialContent;
  const oldWords = Number(countWords(initialContent));
  run('UPDATE novel_chapters SET content = ?, words = ?, status = ?, updated_at = ? WHERE novel_id = ? AND idx = 1', initialContent, oldWords, 'done', now, NOVEL_ID);
  const result = await pipeline.continueChapter(NOVEL_ID, 1, { mode: 'continue', operator: '自动化测试' });
  assert.equal(result.ok, true);
  assert.equal(result.mocked, true);
  assert.ok(result.words > oldWords);
  assert.ok(result.addedWords > 0);
  const row = get('SELECT content, words FROM novel_chapters WHERE novel_id = ? AND idx = 1', NOVEL_ID);
  assert.equal(row.content, result.content);
  assert.equal(row.words, result.words);
  const snapshot = pipeline.pipelineSnapshot(NOVEL_ID);
  assert.equal(snapshot.pipeline.prose_history[1][0].content, oldContent);
  assert.ok(snapshot.pipeline.prose_audit.some((item) => item.action === 'prose:continue' && item.actor === '自动化测试'));
  return `${oldWords}→${result.words} 字`;
});

console.log('\n=== 10. 重置资产不伤正文 ===');
await check('resetPipeline([assets]) 清空资产与确认，但不删除章节正文', () => {
  const before = get('SELECT content FROM novel_chapters WHERE novel_id = ? AND idx = 1', NOVEL_ID).content;
  pipeline.resetPipeline(NOVEL_ID, { steps: ['assets'] });
  const snapshot = pipeline.pipelineSnapshot(NOVEL_ID);
  assert.equal(snapshot.pipeline.asset_plan.assets.length, 0);
  assert.equal(snapshot.pipeline.asset_confirmation, null);
  assert.ok(Object.keys(snapshot.pipeline.chapter_cards).length >= 3);
  assert.equal(get('SELECT content FROM novel_chapters WHERE novel_id = ? AND idx = 1', NOVEL_ID).content, before);
  assert.ok(before.length > oldContent.length);
  return `正文保留 ${before.length} 字符`;
});

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(fail ? 1 : 0);
