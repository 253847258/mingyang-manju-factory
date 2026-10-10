// 自检脚本：不起服务，直接对数据层/提示词层/出图适配器/字典做断言
// 用法：node tests/selfcheck.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// 使用临时库，避免污染 data/factory.db
process.env.FACTORY_DB = path.join(os.tmpdir(), `factory-selfcheck-${Date.now()}.db`);

// ---- 环境隔离（防误花钱 · RK-SPEND-01）----
// 本文件第 5 节用 actorsMod.createGenerationJob 批量出图，而该任务**不显式传 backend**，
// 会回落到 config.image.backend：不隔离时读真实 config/config.json（现为 generic-http =
// 百炼 wan2.7-image，¥0.2/张），跑一次阶段 1 就真花钱。旧写法连 FACTORY_DATA_DIR 也没有，
// 占位图还会写进真实 data/images（污染「自检前后文件数零增长」证据）。
// 隔离点：
//   · FACTORY_DATA_DIR 必须落在仓库内：src/image.js:141 的 rel() 对仓库外路径返回绝对路径，
//     会让下方「占位出图产出真实文件」用例的 safeJoin(ROOT, filePath) 拼错路径而误判失败；
//   · 三个付费后端钉死为 placeholder / placeholder / none → 本测试永不产生真实付费调用。
// 写法参照 tests/test-publish.js:15（临时文件随进程结束即弃），且必须排在 import '../src/*' 之前。
const TMP_DIR = path.join(path.resolve(import.meta.dirname, '..'), `.tmp-selfcheck-${Date.now()}`);
process.env.FACTORY_DATA_DIR = TMP_DIR;
process.env.FACTORY_CONFIG = path.join(TMP_DIR, 'config.json');
fs.mkdirSync(TMP_DIR, { recursive: true });
fs.writeFileSync(process.env.FACTORY_CONFIG, JSON.stringify({
  image: { backend: 'placeholder', retries: 0, retryBaseMs: 0 },
  video: { backend: 'placeholder' },
  tts: { backend: 'none' },
}, null, 2));

const { migrate, get, run, all, nextId, db } = await import('../src/db.js');
const { STYLES, styleById } = await import('../src/data/styles.js');
const { GENRES, GENRE_CATEGORIES } = await import('../src/data/genres.js');
const { SHOT_KINDS, SHOT_KIND_LIST, POVS, RATIOS } = await import('../src/data/dictionaries.js');
const { buildPrompt, subjectFragment, expandVariants, randomParams, ratioToSize } = await import('../src/prompts.js');
const actorsMod = await import('../src/modules/actors.js');
const { getJob } = await import('../src/jobs.js');
const { generateImage, imageBackendStatus } = await import('../src/image.js');
const { loadConfig, publicConfig, resolveLlmKey } = await import('../src/config.js');
const { parseJSONLoose, countWords, safeJoin } = await import('../src/util.js');

migrate();

let passed = 0;
const check = (name, fn) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n     ${e.message}`); process.exitCode = 1; }
};
const checkAsync = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n     ${e.message}`); process.exitCode = 1; }
};

console.log('\n=== 1. 数据字典 ===');
check('画风风格包 = 10 种，且字段完整', () => {
  assert.equal(STYLES.length, 10);
  for (const s of STYLES) { assert.ok(s.id && s.name && s.head && s.tail && s.negative, `风格 ${s.id} 字段缺失`); }
});
check('题材库 = 100 种，且分类/关键词齐全', () => {
  assert.equal(GENRES.length, 100);
  assert.ok(GENRE_CATEGORIES.length >= 10);
  for (const g of GENRES) assert.ok(g.id && g.name && g.cat && g.desc, `题材 ${g.id} 字段缺失`);
  assert.equal(new Set(GENRES.map((g) => g.id)).size, 100, '题材 id 有重复');
});
check('镜头种类（右键清单）覆盖用户要求的 9 类', () => {
  const ids = Object.keys(SHOT_KINDS);
  for (const need of ['face', 'angle', 'expression', 'head', 'pose', 'gesture', 'costume', 'full']) {
    assert.ok(ids.includes(need), `缺少镜头种类 ${need}`);
  }
  const list = SHOT_KIND_LIST();
  assert.ok(list.every((k) => k.variants.length > 0));
});
check('表情/姿态/手势/服饰变体数量达到要求', () => {
  assert.ok(SHOT_KINDS.expression.variants.length >= 12);
  assert.ok(SHOT_KINDS.pose.variants.length >= 12);
  assert.ok(SHOT_KINDS.gesture.variants.length >= 12);
  assert.ok(SHOT_KINDS.costume.variants.length >= 8);
  assert.ok(SHOT_KINDS.head.variants.length >= 6);
  assert.ok(SHOT_KINDS.angle.variants.length >= 5);
});
check('比例尺寸表包含 9:16 / 16:9 / 21:9 等', () => {
  assert.equal(ratioToSize('9:16').join('x'), '864x1536');
  assert.equal(ratioToSize('16:9').join('x'), '1536x864');
  assert.ok(RATIOS.length >= 8);
});

console.log('\n=== 2. 演员档案（ID 独立） ===');
const created = actorsMod.createActor({ name: '自检·苏晚晴', gender: 'female', age: 22, race: 'asian-east', height_cm: 168, body_type: 'slim', hair_style: 'long-straight', hair_color: 'black', eyes: 'amber', style_id: 'cn-guofeng', costume: 'white hanfu', personality: '外冷内热' });
check('自动分配独立 ID（C-0001 形式）', () => assert.match(created.id, /^C-\d{4}$/));
check('档案可读回并带英文锚点', () => {
  const a = actorsMod.getActor(created.id);
  assert.equal(a.name, '自检·苏晚晴');
  assert.ok(a.subject_en.includes('1girl') || a.subject_en.includes('female') || a.subject_en.includes('east asian'), a.subject_en);
  assert.ok(a.subject_zh.includes('女'));
});
check('第二位演员得到递增 ID', () => {
  const b = actorsMod.createActor({ name: '自检·沈砚', gender: 'male' });
  assert.notEqual(b.id, created.id);
});
check('更新档案写回数据库', () => {
  actorsMod.updateActor(created.id, { height_cm: 171, tags: '测试,自检' });
  assert.equal(get('SELECT height_cm FROM actors WHERE id=?', created.id).height_cm, 171);
});

console.log('\n=== 3. 提示词引擎（英文正/负向 + 风格包） ===');
check('拼装结果包含风格头、人物锚点、质量尾', () => {
  const a = actorsMod.getActor(created.id);
  const p = buildPrompt({ actor: a, kind: 'face', variant: 'front' });
  const style = styleById(a.style_id);
  assert.ok(p.positive.includes(style.head), '缺少风格头');
  assert.ok(p.positive.includes(style.tail), '缺少风格尾');
  assert.ok(p.positive.includes('1girl') || p.positive.includes('young woman'), '缺少人物锚点');
  assert.ok(p.negative.length > 20, '负向词过短');
  assert.ok(/[\u4e00-\u9fff]/.test(style.head) === false, '风格头不应含中文');
});
check('人物锚点在所有镜头种类中都保留', () => {
  const a = actorsMod.getActor(created.id);
  for (const kind of Object.keys(SHOT_KINDS)) {
    const p = buildPrompt({ actor: a, kind, variant: 'front' });
    assert.ok(p.positive.includes('east asian'), `${kind} 丢失人物锚点`);
  }
});
check('多角度/多表情展开为多条任务', () => {
  assert.equal(expandVariants('angle', []).length, SHOT_KINDS.angle.variants.length);
  assert.equal(expandVariants('expression', ['smile', 'angry']).length, 2);
});
check('随机参数在合法范围', () => {
  const r = randomParams();
  assert.ok(r.seed > 0 && r.seed < 4294967296);
  assert.ok(r.cfg >= 4 && r.cfg <= 8);
  assert.ok(r.steps >= 20);
});

console.log('\n=== 4. 出图适配器 ===');
check('出图后端状态可读', () => {
  const s = imageBackendStatus();
  assert.ok(['placeholder', 'openai-images', 'generic-http', 'comfyui'].includes(s.backend));
});
await checkAsync('占位出图产出真实文件（SVG）', async () => {
  const out = await generateImage({ actorId: created.id, kind: 'face', variant: 'front', prompt: 'test prompt', negative: 'bad', width: 512, height: 512, backend: 'placeholder' });
  assert.ok(out.ok && out.filePath, '未返回文件');
  const abs = safeJoin(path.resolve(import.meta.dirname, '..'), out.filePath);
  assert.ok(fs.existsSync(abs), '文件未落盘：' + abs);
  assert.ok(fs.readFileSync(abs, 'utf8').includes('<svg'), '不是 SVG');
});
await checkAsync('未知后端给出明确中文错误', async () => {
  await assert.rejects(() => generateImage({ prompt: 'x', backend: 'not-exist' }), /未知出图后端/);
});

console.log('\n=== 5. 生成任务（异步队列 + 落库） ===');
await checkAsync('批量生成任务把图片写入素材库', async () => {
  const { jobId, total } = actorsMod.createGenerationJob({ actorIds: [created.id], kind: 'expression', variants: ['smile', 'angry'], perVariant: 1 });
  assert.equal(total, 2);
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const j = getJob(jobId);
    if (j && ['done', 'error'].includes(j.status)) {
      assert.equal(j.status, 'done', j.error);
      break;
    }
  }
  const imgs = all('SELECT * FROM actor_images WHERE actor_id=?', created.id);
  assert.ok(imgs.length >= 2, `素材库应有 ≥2 张，实际 ${imgs.length}`);
  assert.ok(imgs.every((i) => i.file_path), '存在没有文件路径的记录');
});
await checkAsync('全身定妆主图会写回 cover_image（宫格封面）', async () => {
  const { jobId } = actorsMod.createGenerationJob({ actorIds: [created.id], kind: 'full', variants: ['keyart'] });
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const j = getJob(jobId);
    if (j && ['done', 'error'].includes(j.status)) { assert.equal(j.status, 'done', j.error); break; }
  }
  const row = get('SELECT cover_image FROM actors WHERE id=?', created.id);
  assert.ok(row.cover_image, 'cover_image 未写入');
  assert.equal(get('SELECT COUNT(*) n FROM actor_images WHERE actor_id=? AND is_primary=1', created.id).n, 1, '主图应唯一');
});

console.log('\n=== 6. 宫格画布 ===');
check('自动排布生成宫格节点', () => {
  const r = actorsMod.autoArrange('CV-MAIN', { cols: 5, cell: 200 });
  const c = actorsMod.getCanvas('CV-MAIN');
  assert.ok(c.nodes.length >= 2, '画布节点不足');
  assert.ok(c.nodes.every((n) => n.actor_id), '节点缺少 actor_id');
});

console.log('\n=== 7. LLM 配置与解析 ===');
check('配置可读且能解析 DSH 中的 DeepSeek Key', () => {
  const c = loadConfig();
  assert.ok(c.llm.model);
  const pub = publicConfig();
  assert.equal(pub.llm.apiKey.includes('sk-') && !pub.llm.apiKey.includes('****') ? false : true, true, '脱敏失败');
  const key = resolveLlmKey(c);
  assert.ok(typeof key === 'string');
  console.log(`      LLM provider=${c.llm.provider} model=${c.llm.model} key=${key ? '已配置' : '未配置（可用 mock）'}`);
});
check('宽松 JSON 解析能吃掉围栏与尾逗号', () => {
  assert.deepEqual(parseJSONLoose('```json\n{"a":1,}\n```'), { a: 1 });
  assert.deepEqual(parseJSONLoose('前言 {"b":[1,2]} 后记'), { b: [1, 2] });
});
check('中英混排字数统计正确', () => {
  assert.equal(countWords('你好世界'), 4);
  assert.equal(countWords('hello world'), 2);
  assert.ok(countWords('你好 world') === 3);
});
check('路径穿越被拦截', () => {
  assert.throws(() => safeJoin('/tmp/base', '../../etc/passwd'), /越界/);
});

console.log(`\n=== 结果：${passed} 项通过 ${process.exitCode ? '，存在失败项' : '，全部通过'} ===`);
try { db.close(); } catch { /* ignore */ }
try { fs.rmSync(process.env.FACTORY_DB, { force: true }); fs.rmSync(process.env.FACTORY_DB + '-wal', { force: true }); fs.rmSync(process.env.FACTORY_DB + '-shm', { force: true }); } catch { /* ignore */ }
// 隔离目录（临时数据 + 临时配置）随进程结束清理，真实 data/ 与 config/ 一字未动
try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(process.exitCode || 0);
