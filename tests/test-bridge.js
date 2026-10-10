// 画布资产桥测试：资产包 / 绑定剧本 / 分镜提示词增强 / 关键帧参考图 / 导出
// 用法：node tests/test-bridge.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_TMP = path.join(os.tmpdir(), `factory-bridge-data-${Date.now()}`);
process.env.FACTORY_DATA_DIR = DATA_TMP;
const DB = path.join(os.tmpdir(), `factory-bridge-test-${Date.now()}.db`);
process.env.FACTORY_DB = DB;
process.env.PORT = '8895';
// 隔离真实配置（W4 验收 R-W4-05）：本测试后面会通过 PUT /api/settings 写回配置
// （下面 164/173 行把 image.useCanvasRefs 来回切，并写 concurrency:2），而 /api/settings 最终走
// src/config.js 的 saveConfig → fs.writeFileSync(CONFIG_FILE)。若不隔离 FACTORY_CONFIG，
// 单跑一次 `node tests/test-bridge.js` 就会把用户真实 config/config.json 的 image.concurrency
// 从 3 改成 2（且不还原）—— 此前只有全量自检的快照+还原在兜底，属补偿式治理。
// 写法照抄同目录 tests/test-publish.js:15（mkdtemp/临时文件，跑完即弃，绝不碰真实配置）。
const CFG = path.join(os.tmpdir(), `factory-bridge-config-${Date.now()}.json`);
process.env.FACTORY_CONFIG = CFG;

const { migrate, run, get, all } = await import('../src/db.js');
const { createApp, createServer } = await import('../src/http.js');
const { registerActorRoutes } = await import('../src/routes/actors.js');
const { registerMetaRoutes } = await import('../src/routes/meta.js');
const { registerBridgeRoutes } = await import('../src/routes/bridge.js');
const { registerRenderRoutes } = await import('../src/routes/render.js');
const { registerScriptRoutes } = await import('../src/routes/script.js');
const { DATA_DIR, ROOT } = await import('../src/db.js');
const bridge = await import('../src/modules/canvas-assets.js');

migrate();

// ---- 造数据：1 演员 + 环境 + 物品 + 参考图节点 + 1 剧本/集/镜头 ----
const now = new Date().toISOString();
const actor = (await import('../src/modules/actors.js')).createActor({
  name: '沈砚', gender: 'male', age: 28, race: 'asian-east', height_cm: 186,
  body_type: 'athletic', hair_style: 'undercut', hair_color: 'black', eyes: 'grey',
  style_id: 'cinematic-real', costume: 'black trench coat',
});
const A = await import('../src/modules/actors.js');
A.autoArrange('CV-MAIN', { cols: 3, cell: 200 });
const sceneN = A.createAsset({ canvas_id: 'CV-MAIN', kind: 'scene', title: '雾港码头', x: 800, y: 60,
  data: { timeOfDay: '深夜', weather: '浓雾', desc: '栈桥灯柱昏黄', tags: ['主场景'] } }).node;
const itemN = A.createAsset({ canvas_id: 'CV-MAIN', kind: 'item', title: '停摆怀表', x: 800, y: 400,
  data: { category: '关键道具', desc: '指针停在十点四十' } }).node;
const refFile = path.join(DATA_DIR, 'uploads', 'ref-test.png');
fs.mkdirSync(path.dirname(refFile), { recursive: true });
fs.writeFileSync(refFile, Buffer.from('89504e470d0a1a0a', 'hex'));
const refRel = path.relative(ROOT, refFile).split(path.sep).join('/');
A.setAssetRefImages(sceneN.id, { add: [refRel] });
const refMatrix = A.createRefImageMatrix({ canvas_id: 'CV-MAIN', x: 1200, y: 60, cols: 2, cell: 200,
  files: [{ name: '参考A.png', path: refRel }] });

run(`INSERT INTO scripts(id, novel_id, title, format, style_id, episode_seconds, episodes_per_season, seasons, options, status, created_at, updated_at)
     VALUES('SC-B','N-B','桥接测试剧本','manju','cinematic-real',12,1,1,'{}','draft',?,?)`, now, now);
run(`INSERT INTO script_episodes(id, script_id, season, episode, code, title, duration, status, created_at, updated_at)
     VALUES('EP-B','SC-B',1,1,'S01E001','测试集',6,'planned',?,?)`, now, now);
run(`INSERT INTO shots(id, script_id, episode_id, idx, scene_no, location_id, shot_size, camera, move, transition, duration, action, dialogue, mood, prompt_pos, prompt_neg, refs, cost_level, status, created_at)
     VALUES('SH-B1','SC-B','EP-B',1,'1','L-0001','中景','平视','固定','切',3,'沈砚掏出停摆怀表看了一眼','','紧张','','','{}','M',?,?)`, 'draft', now);
run(`INSERT INTO shots(id, script_id, episode_id, idx, scene_no, location_id, shot_size, camera, move, transition, duration, action, dialogue, mood, prompt_pos, prompt_neg, refs, cost_level, status, created_at)
     VALUES('SH-B2','SC-B','EP-B',2,'1','L-0002','近景','平视','推镜','切',3,'沈砚抬头看向雾中','','警惕','','','{}','H',?,?)`, 'draft', now);

const { app, handle } = createApp();
registerMetaRoutes(app);
registerActorRoutes(app);
registerBridgeRoutes(app);
registerRenderRoutes(app);
registerScriptRoutes(app);   // 分镜（模块3）——桥接测试需要它来验证提示词增强
const server = createServer((req, res) => handle(req, res, { staticMounts: [{ prefix: '/data', dir: DATA_DIR, cache: 'no-cache' }] }));
await new Promise((r) => server.listen(8895, '127.0.0.1', r));
const B = 'http://127.0.0.1:8895';
const get_ = async (p) => (await fetch(B + p)).json();
const post = async (p, body) => (await fetch(B + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })).json();
const put = async (p, body) => (await fetch(B + p, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })).json();
const del = async (p) => (await fetch(B + p, { method: 'DELETE' })).json();
const waitJob = async (id, tries = 200) => {
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, 150));
    const j = (await get_(`/api/jobs/${id}`)).job;
    if (j && ['done', 'error', 'canceled'].includes(j.status)) return j;
  }
  return null;
};

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.error(`  ✗ ${name}  ${extra}`); } };

console.log('\n=== 画布资产桥测试 ===');

// 1. 资产包
const pack = await get_('/api/canvas/CV-MAIN/asset-pack');
ok('资产包：环境/物品/参考图/演员/连线统计正确',
   pack.ok && pack.summary.scenes === 1 && pack.summary.items === 1 && pack.summary.refs === 1 && pack.summary.actors === 1,
   JSON.stringify(pack.summary));
ok('资产包：环境含英文令牌（中文→英文）', /late night|dense fog|harbor pier/.test(pack.pack.scenes[0].en), pack.pack.scenes[0].en);
ok('资产包：物品含英文令牌', /pocket watch/.test(pack.pack.items[0].en), pack.pack.items[0].en);
ok('资产包：环境带参考图', (pack.pack.scenes[0].refImages || []).length === 1);
const badPack = await get_('/api/canvas/NOT-EXIST/asset-pack');
ok('不存在的画布返回 404', badPack.ok === false);

// 2. 导出
const md = await get_('/api/canvas/CV-MAIN/export-assets?format=md');
ok('导出 Markdown（含环境/物品/关系线章节）',
   md.ok && /# 画布资产清单/.test(md.content) && /## 环境/.test(md.content) && /## 物品/.test(md.content) && /## 关系线/.test(md.content));
const csv = await get_('/api/canvas/CV-MAIN/export-assets?format=csv');
ok('导出 CSV（BOM + 表头）', csv.content.startsWith('\ufeff') && csv.content.includes('类型') && csv.content.includes('雾港码头'));
const json = await get_('/api/canvas/CV-MAIN/export-assets?format=json');
ok('导出 JSON 可解析', JSON.parse(json.content).scenes.length === 1);

// 3. 绑定 / 解绑
const bind = await post('/api/scripts/SC-B/canvas-binding', { canvasId: 'CV-MAIN' });
ok('绑定画布资产到剧本', bind.ok && bind.summary.scenes === 1 && bind.summary.items === 1 && bind.summary.refs === 1, JSON.stringify(bind.summary));
const q = await get_('/api/scripts/SC-B/canvas-binding');
ok('可查询绑定摘要', q.ok && q.binding.canvasId === 'CV-MAIN' && q.summary.scenes === 1);
const bindBad = await post('/api/scripts/NOT-EXIST/canvas-binding', { canvasId: 'CV-MAIN' });
ok('绑定到不存在的剧本报错', bindBad.ok === false && /剧本不存在/.test(bindBad.error));
const bindNoCanvas = await post('/api/scripts/SC-B/canvas-binding', { canvasId: 'CV-NOT-EXIST' });
ok('绑定不存在的画布报错', bindNoCanvas.ok === false && /画布不存在/.test(bindNoCanvas.error));

// 4. 纯函数：合并地点 / 命中道具 / 参考图
const merged = bridge.mergeCanvasLocations([{ id: 'L-0001', name: '雾港码头', desc: '旧设定' }], bridge.getScriptCanvasBinding(get('SELECT * FROM scripts WHERE id = ?', 'SC-B')));
ok('同名地点被画布设定覆盖（保留原地点 ID）',
   merged.length === 1 && merged[0].id === 'L-0001' && /late night|dense fog/.test(merged[0].en || ''), JSON.stringify(merged.map((m) => m.id + ':' + m.en)));
const refsByName = bridge.canvasRefsForShot({ shot: {}, pack: pack.pack, locationId: 'L-0001', locationName: '雾港码头' });
ok('按地点名匹配到画布环境', refsByName.sceneNodeId === sceneN.id && refsByName.sceneEn.length > 5, JSON.stringify(refsByName.sceneTitle));
const refsById = bridge.canvasRefsForShot({ shot: {}, pack: pack.pack, locationId: sceneN.id });
ok('按画布节点 ID 匹配（大小写不敏感）', refsById.sceneNodeId === sceneN.id);
const refsItem = bridge.canvasRefsForShot({ shot: { action: '沈砚掏出停摆怀表看了一眼' }, pack: pack.pack, locationId: 'L-0001', locationName: '雾港码头' });
ok('按台词/动作命中画布道具', refsItem.itemTitles.includes('停摆怀表') && refsItem.itemEn.join(' ').includes('pocket watch'), JSON.stringify(refsItem.itemTitles));
ok('镜头参考图来自画布节点（含参考图节点）', refsItem.refImages.length >= 1, JSON.stringify(refsItem.refImages));

// 5. 分镜提示词增强（离线分支，确定性）
const sb = await post('/api/scripts/SC-B/storyboard', { episode: 'S01E001', offline: true, provider: 'mock', sync: true });
ok('离线生成分镜成功', sb.ok && sb.shots >= 2, JSON.stringify({ shots: sb.shots, err: sb.error }));
const shots = all('SELECT * FROM shots WHERE episode_id = ? ORDER BY idx', 'EP-B');
const withCanvasSet = shots.filter((s) => /canvas set:/.test(s.prompt_pos || ''));
ok('分镜提示词包含画布场景令牌（canvas set）', withCanvasSet.length >= 1, `含 canvas set 的镜头 ${withCanvasSet.length}/${shots.length}`);
const refsRows = shots.map((s) => { try { return JSON.parse(s.refs || '{}'); } catch { return {}; } });
ok('镜头 refs 写入 canvas（场景/道具/参考图）', refsRows.some((r) => r.canvas && (r.canvas.sceneNodeId || r.canvas.refImages?.length)),
   JSON.stringify(refsRows[0]?.canvas || {}).slice(0, 120));
const dup = (withCanvasSet[0]?.prompt_pos || '').split(', ').length;
const uniq = new Set((withCanvasSet[0]?.prompt_pos || '').split(', ')).size;
ok('提示词令牌已去重（无重复片段）', dup === uniq, `tokens=${dup} uniq=${uniq}`);

// 5b. 回归：剧本正文早于画布绑定生成（场次没有地点归属）时，绑定后分镜仍要吃到画布设定
run('UPDATE script_episodes SET scenes=? WHERE id=?', JSON.stringify({
  title: '测试集',
  scenes: [{ no: '1', slug: '码头·夜', location: null, time: '夜晚', beats: [
    { type: 'action', character: '', text: '沈砚走上栈桥，浓雾漫过铁轨，远处灯光忽明忽暗' },
    { type: 'dialogue', character: '', text: '怀表停在十点四十。' },
  ] }],
}), 'EP-B');
const maxRowBeforeLoc = get("SELECT COALESCE(MAX(rowid),0) m FROM shots WHERE episode_id='EP-B'").m;
const sbNoLoc = await post('/api/scripts/SC-B/storyboard', { episode: 'S01E001', offline: true, provider: 'mock', sync: true, append: true, overwrite: true });
const reShots = all("SELECT * FROM shots WHERE episode_id='EP-B' AND rowid > ?", maxRowBeforeLoc);
ok('场次无地点归属时按地点表重推分镜（画布设定仍进入提示词）',
   sbNoLoc.ok === true && reShots.length > 0 && reShots.some((s) => /canvas set:/.test(s.prompt_pos || '')),
   `新镜头 ${reShots.length} 个，含 canvas set ${reShots.filter((s) => /canvas set:/.test(s.prompt_pos || '')).length} 个`);
ok('重推后镜头带上画布地点 ID（location_id = 画布节点）',
   reShots.some((s) => /^ND-/.test(String(s.location_id || ''))), `location_id 示例 ${reShots[0]?.location_id || '(空)'}`);

// 6. 关键帧渲染使用画布参考图
const kf = await post('/api/render/keyframes', { scriptId: 'SC-B', code: 'S01E001', overwrite: true });
const kfJob = await waitJob(kf.jobId);
ok('关键帧任务完成', kfJob.status === 'done' && kfJob.result.failed === 0, JSON.stringify(kfJob.error || kfJob.result));
const kr = all("SELECT * FROM shot_renders WHERE kind='keyframe' AND status='done'");
const withMeta = kr.map((r) => { try { return JSON.parse(r.meta || '{}'); } catch { return {}; } }).filter((m) => m.canvasRef);
ok('关键帧记录了使用的画布参考图（meta.canvasRef）', withMeta.length >= 1, `共 ${kr.length} 张，带 canvasRef ${withMeta.length} 张`);
const cfg = (await import('../src/config.js')).loadConfig();
ok('配置项 useCanvasRefs 默认开启', cfg.image.useCanvasRefs === true);
await put('/api/settings', { image: { useCanvasRefs: false, backend: 'placeholder', concurrency: 2, defaultRatio: '3:4', defaultWidth: 1024, defaultHeight: 1536 } });
const anyShotId = all("SELECT id FROM shots WHERE episode_id='EP-B' ORDER BY idx LIMIT 1")[0].id;
const kf2 = await post('/api/render/keyframes', { scriptId: 'SC-B', code: 'S01E001', shotIds: [anyShotId], overwrite: true });
ok('可指定单镜重渲关键帧（提交成功）', kf2.ok === true && Boolean(kf2.jobId), JSON.stringify(kf2).slice(0, 120));
const kf2Job = await waitJob(kf2.jobId, 500);
const row2 = all("SELECT * FROM shot_renders WHERE shot_id=? AND kind='keyframe' ORDER BY created_at DESC LIMIT 1", anyShotId)[0];
const lastMeta = row2 ? JSON.parse(row2.meta || '{}') : {};
ok('关闭 useCanvasRefs 后不再使用画布参考图', Boolean(kf2Job) && kf2Job.status === 'done' && Boolean(row2) && !lastMeta.canvasRef,
   JSON.stringify({ status: kf2Job?.status || 'null', err: kf2Job?.error || '', meta: lastMeta }).slice(0, 120));
await put('/api/settings', { image: { useCanvasRefs: true, backend: 'placeholder', concurrency: 2, defaultRatio: '3:4', defaultWidth: 1024, defaultHeight: 1536 } });

// 7. 解绑
const unbind = await del('/api/scripts/SC-B/canvas-binding');
const afterUnbind = await get_('/api/scripts/SC-B/canvas-binding');
ok('可解绑画布资产', unbind.ok && afterUnbind.binding === null);
const maxRowBefore = get("SELECT COALESCE(MAX(rowid),0) m FROM shots WHERE episode_id='EP-B'").m;
const sb2 = await post('/api/scripts/SC-B/storyboard', { episode: 'S01E001', offline: true, provider: 'mock', sync: true, append: true });
ok('解绑后可再次生成分镜', sb2.ok === true, JSON.stringify(sb2).slice(0, 120));
const newShots = all("SELECT * FROM shots WHERE episode_id='EP-B' AND rowid > ?", maxRowBefore);
ok('解绑后新生成的分镜不再带 canvas 设定', newShots.length > 0 && !newShots.some((s) => /canvas set:/.test(s.prompt_pos || '')),
   `新镜头 ${newShots.length} 个，含 canvas set ${newShots.filter((s) => /canvas set:/.test(s.prompt_pos || '')).length} 个`);

// 8. 安全网：空快照不得清空非空画布
const guard = await post('/api/canvas/restore', { canvas_id: 'CV-MAIN', nodes: [], groups: [] });
const stillThere = get('SELECT COUNT(*) n FROM canvas_nodes WHERE canvas_id = ?', 'CV-MAIN').n;
ok('空快照不会清空非空画布（安全网生效）', guard.ok === false && stillThere > 0, `nodes=${stillThere}`);
const allowEmpty = await post('/api/canvas/restore', { canvas_id: 'CV-MAIN', nodes: [], groups: [], allowEmpty: true });
ok('显式 allowEmpty 时才允许清空', allowEmpty.ok === true && get('SELECT COUNT(*) n FROM canvas_nodes WHERE canvas_id = ?', 'CV-MAIN').n === 0);

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
server.close();
// 收尾清理：临时库 / 临时数据目录 / 上面隔离出来的临时配置文件（真实 config/config.json 全程零触碰）
try { fs.rmSync(DB, { force: true }); fs.rmSync(DB + '-wal', { force: true }); fs.rmSync(DB + '-shm', { force: true }); fs.rmSync(DATA_TMP, { recursive: true, force: true }); fs.rmSync(CFG, { force: true }); } catch { /* ignore */ }
process.exit(fail ? 1 : 0);
