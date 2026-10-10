// 模块1 API 端到端测试（临时库 + 临时端口，不影响主数据）
// 用法：node tests/test-actors.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 配置/数据隔离（照 tests/test-publish.js:9-17 的写法）：三项 env 全部指向 mkdtemp 临时路径。
// 历史缺陷 R-W5-06：本文件 :383 的 PUT /api/settings 会经 src/routes/meta.js → src/config.js
// saveConfig 真写仓库里的 config/config.json（实测 mtime 变化）；此前只是因为临时值恰好与
// 真实值相同（image.concurrency 都是 3）才没造成语义偏差。隔离后单跑本测试对真实配置
// 的 md5 与 mtime 都必须零变化。
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-actors-'));
const DATA_TMP = path.join(TMP_ROOT, 'data');
const DB = path.join(TMP_ROOT, 'factory.db');
const CFG = path.join(TMP_ROOT, 'config.json');
process.env.FACTORY_DATA_DIR = DATA_TMP;
process.env.FACTORY_DB = DB;
process.env.FACTORY_CONFIG = CFG;
fs.mkdirSync(DATA_TMP, { recursive: true });
const PORT = 8893;
process.env.PORT = String(PORT);
process.env.HOST = '127.0.0.1';

const { migrate } = await import('../src/db.js');
const { createApp, createServer } = await import('../src/http.js');
const { registerActorRoutes } = await import('../src/routes/actors.js');
const { registerMetaRoutes } = await import('../src/routes/meta.js');
const { DATA_DIR, ROOT } = await import('../src/db.js');

migrate();
const { app, handle } = createApp();
registerMetaRoutes(app);
registerActorRoutes(app);
const server = createServer((req, res) => handle(req, res, { staticMounts: [{ prefix: '/data', dir: DATA_DIR, cache: 'no-cache' }] }));
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const B = `http://127.0.0.1:${PORT}`;
const j = async (p, opts) => {
  const res = await fetch(B + p, opts);
  return res.json();
};
const post = (p, body) => j(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
const put = (p, body) => j(p, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
const del = (p) => j(p, { method: 'DELETE' });
const get = (p) => j(p);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name} ${extra}`); }
};

console.log('\n=== 模块1 API 测试 ===');

// 1. meta
const meta = await get('/api/meta');
ok('meta 返回 10 画风 / 100 题材 / 镜头清单', meta.styles.length === 10 && meta.genres.length === 100 && meta.kinds.length >= 8);

// 2. 创建演员
const a1 = (await post('/api/actors', { name: '测试甲', gender: 'female', age: 20, style_id: 'jp-anime', ratio: '2:3', role_type: '女主' })).actor;
const a2 = (await post('/api/actors', { name: '测试乙', gender: 'male', age: 30, style_id: 'cyberpunk' })).actor;
ok('创建演员并分配独立 ID', /^C-\d{4}$/.test(a1.id) && a1.id !== a2.id, `${a1.id}/${a2.id}`);

// 3. 列表 + 搜索 + 详情
const list = await get('/api/actors?q=测试');
ok('列表检索可用', list.actors.length === 2);
const detail = await get('/api/actors/' + a1.id);
ok('详情含英文锚点与中文描述', detail.actor.subject_en.length > 5 && detail.actor.subject_zh.includes('女'));

// 4. 更新
const upd = await put('/api/actors/' + a1.id, { height_cm: 165, tags: '测试' });
ok('更新字段生效', upd.actor.height_cm === 165 && upd.actor.tags === '测试');

// 5. 提示词预览（9 类镜头全覆盖）
let promptOk = true;
for (const k of meta.kinds) {
  const r = await post(`/api/actors/${a1.id}/prompt`, { kind: k.id, variant: k.variants[0].id });
  if (!r.ok || !r.positive || !r.negative) { promptOk = false; console.error('    缺少提示词：', k.id); }
}
ok('9 类镜头的提示词均可生成（含正/负向）', promptOk);

// 5b. 提示词语言纯净度：英文正向不得混入中文（含全部变体），中文补充位另存 positive_zh
const cjkVariants = [];
let zhMissing = 0;
let droppedSeen = null;
const actorWithCn = await put('/api/actors/' + a1.id, { costume: '黑色风衣', personality: '沉默寡言' });
ok('可写入中文服饰/性格（自由文本字段）', actorWithCn.actor.costume === '黑色风衣');
for (const k of meta.kinds) {
  for (const v of k.variants) {
    const r = await post(`/api/actors/${a1.id}/prompt`, { kind: k.id, variant: v.id });
    if (/[\u4e00-\u9fa5]/.test(r.positive || '')) cjkVariants.push(`${k.id}/${v.id}`);
    if (!r.positive_zh) zhMissing++;
    if (Array.isArray(r.cjkDropped) && r.cjkDropped.length) droppedSeen = droppedSeen || r.cjkDropped;
  }
}
ok('全部变体的英文正向提示词零中文残留', cjkVariants.length === 0, cjkVariants.slice(0, 6).join(', '));
ok('每类镜头都同时提供中文版提示词 positive_zh', zhMissing === 0, `缺失 ${zhMissing} 条`);
ok('中文自由文本（服饰）被剔出英文正向并记录在 cjkDropped', Boolean(droppedSeen) && droppedSeen.some((x) => /黑色风衣/.test(x)), JSON.stringify(droppedSeen));
await put('/api/actors/' + a1.id, { costume: '', personality: '' });

// 6. 生成任务（多演员 × 多变体）
const g = await post('/api/generate/batch', { actorIds: [a1.id, a2.id], kind: 'expression', variants: ['smile', 'angry'], perVariant: 1 });
ok('批量生成任务提交成功', g.ok && g.total === 4, JSON.stringify(g));
let job = null;
for (let i = 0; i < 80; i++) {
  await new Promise((r) => setTimeout(r, 100));
  job = (await get('/api/jobs/' + g.jobId)).job;
  if (['done', 'error'].includes(job.status)) break;
}
ok('任务执行完成且无失败', job.status === 'done' && job.result.failed === 0, JSON.stringify(job.error || job.result));
const imgs1 = await get(`/api/actors/${a1.id}/images`);
ok('图片记录落库（含文件路径与提示词）', imgs1.images.length === 2 && imgs1.images.every((i) => i.file_path && i.prompt_pos));
ok('图片文件真实存在于磁盘', imgs1.images.every((i) => fs.existsSync(path.resolve(import.meta.dirname, '..', i.file_path))));

// 7. 主图设置
const prim = await post(`/api/actors/${a1.id}/primary-image`, { imageId: imgs1.images[0].id });
const after = await get('/api/actors/' + a1.id);
ok('设为主图后封面同步', prim.ok && after.actor.cover_image === imgs1.images[0].file_path);

// 8. 参考生图（useRef 路径）
const g2 = await post(`/api/actors/${a1.id}/generate`, { kind: 'costume', variants: ['fabric'], useRef: true });
let job2 = null;
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 100));
  job2 = (await get('/api/jobs/' + g2.jobId)).job;
  if (['done', 'error'].includes(job2.status)) break;
}
ok('参考生图任务可执行（refImage 路径解析正常）', job2.status === 'done', job2.error || '');

// 8b. 定妆图落库要能追溯「参考图有没有用上 / 用的哪套模板」（2026-09-30 实测故障的回归：
//     占位后端的 SVG 定妆图被当参考图、却硬编码声明成 image/png，百炼回 400 Cannot determine file type；
//     当时代码只写 elapsedMs/placeholder，库里查不到任何可追溯字段，只能翻服务端日志）
const imgsRef = await get(`/api/actors/${a1.id}/images`);
const refRow = (imgsRef.images || []).find((r) => r.variant === 'fabric') || {};
const refMeta = (() => { try { return JSON.parse(refRow.meta || '{}'); } catch { return {}; } })();
ok('参考生图落库 meta 记下用了参考图（refImageUsed / refImagePresent）',
  refMeta.refImageUsed === true && refMeta.refImagePresent === true,
  JSON.stringify({ used: refMeta.refImageUsed, present: refMeta.refImagePresent, ref: refMeta.refImage }));
ok('参考生图落库 meta 记下模板口径（usedTemplate ∈ {t2i,i2i}，便于判断参考图有没有真的走图生图）',
  ['t2i', 'i2i'].includes(refMeta.usedTemplate), JSON.stringify({ usedTemplate: refMeta.usedTemplate, source: refMeta.templateSource }));
ok('参考生图落库 meta 保留既有键（elapsedMs / placeholder 不丢）',
  'elapsedMs' in refMeta && 'placeholder' in refMeta, JSON.stringify(refMeta).slice(0, 140));

// 8c. 「勾了带参考图、但没有可用参考图」必须如实标注（不许让用户以为参考图生效了 —— 实测踩过）
//     找一个既没有 ref_image 也没有 cover_image 的演员，勾 useRef 出图 → 结果与 meta 都要说清「按文生图生成」
const noRefActor = (await get('/api/actors')).actors.find((x) => !x.ref_image && !x.cover_image);
if (noRefActor) {
  const g3 = await post(`/api/actors/${noRefActor.id}/generate`, { kind: 'head', variants: ['tilt-up'], useRef: true });
  let job3 = null;
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 100));
    job3 = (await get('/api/jobs/' + g3.jobId)).job;
    if (['done', 'error'].includes(job3.status)) break;
  }
  const r3 = (job3?.result?.results || [])[0] || {};
  ok('勾了带参考图但无参考图可用：结果里给出中文说明（refNote）',
    r3.ok === true && r3.refImageRequested === true && /文生图/.test(String(r3.refNote || '')), String(r3.refNote || '(无)'));
  const imgs3 = await get(`/api/actors/${noRefActor.id}/images`);
  const row3 = (imgs3.images || [])[0] || {};
  const m3 = (() => { try { return JSON.parse(row3.meta || '{}'); } catch { return {}; } })();
  ok('勾了带参考图但无参考图可用：落库 meta 同样如实标注（refImageRequested + 说明 + refImageUsed=false）',
    m3.refImageRequested === true && m3.refImageUsed === false && /文生图/.test(String(m3.refImageNote || '')),
    JSON.stringify({ req: m3.refImageRequested, used: m3.refImageUsed, note: String(m3.refImageNote || '').slice(0, 50) }));
} else {
  ok('勾了带参考图但无参考图可用：跳过（当前没有「既无 ref_image 也无 cover_image」的演员）', true);
  ok('勾了带参考图但无参考图可用：跳过（同上）', true);
}

// 9. 任务取消接口存在
ok('任务列表可读', (await get('/api/jobs')).jobs.length >= 1);

// 10. 画布
const arr = await post('/api/canvas/auto-arrange', { cols: 4, cell: 180 });
ok('宫格自动排布生成 2 个节点', arr.canvas.nodes.length === 2);
const node = arr.canvas.nodes[0];
const moved = await post('/api/canvas/node', { canvas_id: 'CV-MAIN', actor_id: node.actor_id, x: 333, y: 222 });
ok('节点坐标可持久化', moved.node.x === 333 && moved.node.y === 222);
const c2 = await get('/api/canvas');
ok('画布读回坐标一致', c2.canvas.nodes.find((n) => n.actor_id === node.actor_id).x === 333);
ok('画布节点带演员信息（姓名/封面）', Boolean(c2.canvas.nodes[0].name));

// 11. 画布增强：批量排序 / 批量坐标 / 分组排布 / 多画布 / 复制 / 锁定
const ids = (await get('/api/actors')).actors.map((a) => a.id);
const reordered = await post('/api/actors/reorder', { ids: [...ids].reverse() });
const afterReorder = (await get('/api/actors')).actors.map((a) => a.id);
ok('批量排序接口生效（一次请求改顺序）', reordered.ok && afterReorder[0] === ids[ids.length - 1], JSON.stringify(afterReorder));

const bulk = await post('/api/canvas/nodes', { nodes: [
  { canvas_id: 'CV-MAIN', actor_id: ids[0], x: 111, y: 99, w: 200, h: 200 },
  { canvas_id: 'CV-MAIN', actor_id: ids[1], x: 333, y: 99, w: 200, h: 200 },
] });
const canvasBulk = await get('/api/canvas');
ok('批量写入卡位坐标', bulk.ok && bulk.updated === 2 && canvasBulk.canvas.nodes.find((n) => n.actor_id === ids[0]).x === 111);

const grp = await post('/api/canvas/arrange', { id: 'CV-MAIN', mode: 'group', groupBy: 'role_type', cols: 4, cell: 180 });
ok('分组排布返回分组信息（区块流式，不再单列）', grp.ok && grp.groups.length >= 1 && grp.canvas.nodes.length >= 2, JSON.stringify(grp.groups));
const groupWidths = grp.groups.map((x) => x.width).filter(Boolean);
ok('分组区块有宽度（可横向并排）', groupWidths.length > 0 && Math.max(...groupWidths) >= 180, JSON.stringify(groupWidths));
const matrixAgain = await post('/api/canvas/arrange', { id: 'CV-MAIN', mode: 'matrix', cols: 5, cell: 210 });
ok('宫格排布重置分组', matrixAgain.ok && matrixAgain.groups.length === 0);

const newCv = await post('/api/canvas/create', { name: '测试画布', cols: 3, cell: 160 });
ok('多画布：可新建画布', newCv.ok && newCv.canvas.id.startsWith('CV-'));
ok('新画布默认独立空间（showAll=false，不自动铺满）', newCv.canvas.layout.showAll === false && newCv.canvas.nodes.length === 0,
   JSON.stringify(newCv.canvas.layout));
const fillAll = await post('/api/canvas/arrange', { id: newCv.canvas.id, mode: 'matrix', cols: 3, cell: 160 });
ok('「放入全部演员」= 宫格排布到该画布', fillAll.ok && fillAll.canvas.nodes.length >= 2, String(fillAll.canvas.nodes.length));
const showAll = await put('/api/canvas/show-all', { id: newCv.canvas.id, showAll: true });
ok('可切回「常驻显示全部演员」', showAll.ok && showAll.showAll === true);
const cleared = await post('/api/canvas/clear', { id: newCv.canvas.id });
const afterClear = await get('/api/canvas?id=' + newCv.canvas.id);
const beforeClearActors = (await get('/api/actors')).actors.length;
ok('清空画布只删卡位、不动演员', cleared.ok && cleared.removed >= 2 && afterClear.canvas.nodes.length === 0
   && (await get('/api/actors')).actors.length === beforeClearActors, JSON.stringify(cleared));
ok('清空画布同时清理该画布连线', (await get('/api/canvas/links?id=' + newCv.canvas.id)).links.length === 0);
const cvList = await get('/api/canvas/list');
ok('画布列表含节点数', cvList.canvases.length >= 2 && cvList.canvases.every((c) => c.node_count !== undefined));
const delMain = await del('/api/canvas/CV-MAIN');
ok('主画布受保护不可删除', delMain.ok === false && /主画布/.test(delMain.error));
const delCv = await del('/api/canvas/' + newCv.canvas.id);
ok('可删除自建画布', delCv.ok === true);

const dup = await post(`/api/actors/${ids[0]}/duplicate`, {});
ok('复制演员生成新 ID 与「副本」名', dup.ok && dup.actor.id !== ids[0] && /副本/.test(dup.actor.name));

const nodeRow = (await get('/api/canvas')).canvas.nodes[0];
const locked = await post(`/api/canvas/node/${nodeRow.id}/lock`, { locked: true });
const afterLock = (await get('/api/canvas')).canvas.nodes.find((n) => n.id === nodeRow.id);
ok('卡位可锁定/解锁', locked.ok && afterLock.locked === 1);

// 12. 无限画布：视图持久化 + 关系连线
const vp = await put('/api/canvas/viewport', { id: 'CV-MAIN', zoom: 0.37, panX: -120, panY: 88, bg: 'lines', gridSize: 80, snap: false, showMinimap: true, showLinks: true });
const cvAfterView = (await get('/api/canvas')).canvas;
ok('视图状态可持久化（缩放/平移/背景/网格/吸附）', vp.ok && cvAfterView.layout.view.zoom === 0.37 && cvAfterView.layout.view.bg === 'lines' && cvAfterView.layout.view.gridSize === 80);
const vpLow = await put('/api/canvas/viewport', { id: 'CV-MAIN', zoom: 0.001 });
ok('后端接受极小缩放（前端限制 5%~800%，后端只存状态）', vpLow.ok === true);
const vpBad = await put('/api/canvas/viewport', { id: 'NOT-EXIST', zoom: 1 });
ok('不存在的画布保存视图返回 404', vpBad.ok === false);
// 回归：排布 / 自动分组不得覆盖该画布的视图与 showAll（此前会整体覆盖 layout）
await put('/api/canvas/viewport', { id: 'CV-MAIN', zoom: 0.42, panX: -30, panY: 12, bg: 'lines', gridSize: 80 });
await post('/api/canvas/arrange', { id: 'CV-MAIN', mode: 'matrix', cols: 3, cell: 180 });
const vpAfterArrange = (await get('/api/canvas')).canvas.layout.view;
ok('宫格排布后视图状态保留（zoom/pan/bg）',
   Math.abs(vpAfterArrange.zoom - 0.42) < 1e-6 && vpAfterArrange.panX === -30 && vpAfterArrange.bg === 'lines',
   JSON.stringify(vpAfterArrange));
await post('/api/canvas/auto-group', { id: 'CV-MAIN', groupBy: 'role_type', cols: 3, cell: 180 });
const vpAfterGroup = (await get('/api/canvas')).canvas.layout;
ok('自动分组后视图状态与 showAll 保留',
   Math.abs(vpAfterGroup.view.zoom - 0.42) < 1e-6 && vpAfterGroup.showAll === true,
   JSON.stringify({ view: vpAfterGroup.view, showAll: vpAfterGroup.showAll }));

const lk = await post('/api/canvas/links', { canvas_id: 'CV-MAIN', from_actor: ids[0], to_actor: ids[1], label: '宿敌' });
ok('建立关系连线', lk.ok && lk.link.from_actor === ids[0] && lk.link.label === '宿敌');
const lkDup = await post('/api/canvas/links', { canvas_id: 'CV-MAIN', from_actor: ids[0], to_actor: ids[1], label: '宿敌' });
ok('重复连线不重复创建（幂等）', lkDup.link.id === lk.link.id);
const lkSelf = await post('/api/canvas/links', { canvas_id: 'CV-MAIN', from_actor: ids[0], to_actor: ids[0] });
ok('禁止自连并给出中文错误', lkSelf.ok === false && /同一个节点|同一位/.test(lkSelf.error), lkSelf.error);
const lkMissing = await post('/api/canvas/links', { canvas_id: 'CV-MAIN', from_actor: ids[0] });
ok('缺少一端时给出中文错误', lkMissing.ok === false && /两端/.test(lkMissing.error));
const linksList = await get('/api/canvas/links?id=CV-MAIN');
ok('连线可查询', linksList.links.length === 1 && linksList.links[0].label === '宿敌');
const cvWithLinks = (await get('/api/canvas')).canvas;
ok('画布详情内联返回连线', Array.isArray(cvWithLinks.links) && cvWithLinks.links.length === 1);
const lkDel = await del('/api/canvas/links/' + lk.link.id);
ok('连线可删除', lkDel.ok && (await get('/api/canvas/links?id=CV-MAIN')).links.length === 0);

// 13. 分组框 / 便签节点 / 快照恢复（本轮新增）
const g1 = await post('/api/canvas/groups', { canvas_id: 'CV-MAIN', name: '主角组', actorIds: [ids[0], ids[1]] });
ok('创建分组框（自动贴合组内卡片包围盒）', g1.ok && g1.group.w > 200 && g1.group.h > 200,
   JSON.stringify({ x: g1.group.x, y: g1.group.y, w: g1.group.w, h: g1.group.h }));
const cvG = await get('/api/canvas');
ok('分组框写入卡位 group_id', cvG.canvas.nodes.filter((n) => n.group_id === g1.group.id).length === 2);
const upG = await put('/api/canvas/groups/' + g1.group.id, { name: '改名组', color: '#ff7ab0' });
ok('分组可重命名与改色', upG.group.name === '改名组' && upG.group.color === '#ff7ab0');
const colG = await put('/api/canvas/groups/' + g1.group.id, { collapsed: 1 });
ok('分组可收起/展开', colG.group.collapsed === 1);
const mvG = await post(`/api/canvas/groups/${g1.group.id}/move`, { dx: 120, dy: 60 });
ok('整体移动分组（返回移动的卡位数）', mvG.ok && mvG.moved === 2);
// 先让所有演员都有卡位，再取一个「在画布上、且不在该组」的卡位测试加入/移出
await post('/api/canvas/arrange', { id: 'CV-MAIN', mode: 'matrix', cols: 3, cell: 180 });
const outsider = (await get('/api/canvas')).canvas.nodes.find((n) => n.actor_id && n.group_id !== g1.group.id);
ok('画布上存在可用于测试的第三张卡片', Boolean(outsider), JSON.stringify((await get('/api/canvas')).canvas.nodes.map((n) => n.actor_id)));
const addMem = await post(`/api/canvas/groups/${g1.group.id}/members`, { actorIds: [outsider.actor_id] });
ok('可把卡片加入分组', addMem.ok && (await get('/api/canvas')).canvas.nodes.filter((n) => n.group_id === g1.group.id).length === 3);
const rmMem = await post(`/api/canvas/groups/${g1.group.id}/members`, { actorIds: [outsider.actor_id], remove: true });
ok('可把卡片移出分组', rmMem.ok && (await get('/api/canvas')).canvas.nodes.filter((n) => n.group_id === g1.group.id).length === 2);
const autoG = await post('/api/canvas/auto-group', { id: 'CV-MAIN', groupBy: 'role_type', cols: 4, cell: 180 });
ok('按角色类型自动生成分组框', autoG.ok && autoG.groups.length >= 1, `groups=${autoG.groups.length}`);
const notePost = await post('/api/canvas/notes', { canvas_id: 'CV-MAIN', x: 900, y: 60, text: '第一季主线', color: 'purple' });
ok('创建便签节点', notePost.ok && notePost.node.kind === 'note');
const noteId = notePost.node.id;
const noteUpd = await put('/api/canvas/notes/' + noteId, { text: '改过的便签', color: 'blue', w: 300 });
ok('便签可编辑内容/颜色/尺寸', noteUpd.node.w === 300);
const cvNotes = await get('/api/canvas');
const noteRow = cvNotes.canvas.nodes.find((n) => n.id === noteId);
ok('画布详情返回便签文本与颜色（与演员卡区分）', noteRow.kind === 'note' && noteRow.note_text === '改过的便签' && noteRow.note_color === 'blue');
const snap = { canvas_id: 'CV-MAIN', nodes: cvNotes.canvas.nodes.map((n) => ({ ...n, note: n.kind === 'note' ? JSON.stringify({ text: n.note_text, color: n.note_color }) : n.note })), groups: cvNotes.canvas.groups };
await post('/api/canvas/clear', { id: 'CV-MAIN' });
ok('清空后画布为空（用于验证恢复）', (await get('/api/canvas')).canvas.nodes.length === 0);
const restored = await post('/api/canvas/restore', snap);
const cvRestored = await get('/api/canvas');
ok('快照恢复：卡位/分组/便签全部回滚（撤销重做的基础）',
   restored.ok && cvRestored.canvas.nodes.length === snap.nodes.length && cvRestored.canvas.groups.length === snap.groups.length
   && cvRestored.canvas.nodes.some((n) => n.kind === 'note'),
   JSON.stringify({ nodes: cvRestored.canvas.nodes.length, groups: cvRestored.canvas.groups.length }));
// 连线在「还原/复制为新画布」时的口径：**悬空连线会被有意清掉**，且回报 linksPruned
// （2026-09-30 审计阶段 25 把「清悬空」误判成「连线丢了」，故在此钉死语义）
{
  const cvTmp = (await post('/api/canvas/create', { name: '临时·还原连线口径' })).canvas;
  const tnodes = [
    { id: 'TT-1', actor_id: '', x: 0, y: 0, kind: 'actor', title: 't1' },
    { id: 'TT-2', actor_id: '', x: 200, y: 0, kind: 'actor', title: 't2' },
  ];
  const tlinks = [
    { id: 'TL-A', from_node: 'TT-1', to_node: 'TT-2', label: '有效线' },
    { id: 'TL-B', from_node: 'TT-1', to_node: 'TT-NOT-EXIST', label: '悬空线' },
  ];
  const rRestore = await post('/api/canvas/restore', { canvas_id: cvTmp.id, nodes: tnodes, groups: [], links: tlinks, allowEmpty: true });
  const cvT = (await get('/api/canvas?id=' + cvTmp.id)).canvas;
  ok('还原时悬空连线被有意清掉，并如实回报 linksPruned（调用方不必猜）',
    rRestore.ok && rRestore.linksPruned === 1 && rRestore.links === 1 && cvT.links.length === 1 && cvT.links[0].id === 'TL-A',
    JSON.stringify({ pruned: rRestore.linksPruned, kept: rRestore.links, ids: cvT.links.map((l) => l.id) }));
  ok('还原回报的 linksRequested 是「送进来几条」（与 kept/pruned 三个数自洽）',
    rRestore.linksRequested === 2 && rRestore.links + rRestore.linksPruned === rRestore.linksRequested,
    JSON.stringify({ requested: rRestore.linksRequested, kept: rRestore.links, pruned: rRestore.linksPruned }));
  const allValid = await post('/api/canvas/restore', { canvas_id: cvTmp.id, nodes: tnodes, groups: [], links: [tlinks[0]], allowEmpty: true });
  ok('端点都在的连线一条不少（valid 情况下 linksPruned=0）', allValid.links === 1 && allValid.linksPruned === 0, JSON.stringify({ kept: allValid.links, pruned: allValid.linksPruned }));
  await del('/api/canvas/' + cvTmp.id);
}

// 自动分组会重建分组，所以这里解散「快照中实际存在」的那一个
const liveGroup = (await get('/api/canvas')).canvas.groups[0];
ok('快照恢复后分组框仍在', Boolean(liveGroup), JSON.stringify((await get('/api/canvas')).canvas.groups.map((g) => g.id)));
const delGroupKeep = await del(`/api/canvas/groups/${liveGroup.id}?keepNodes=1`);
const afterDissolve = await get('/api/canvas');
ok('解散分组保留卡片（group_id 清空）',
   delGroupKeep.ok && !afterDissolve.canvas.nodes.some((n) => n.group_id === liveGroup.id)
   && afterDissolve.canvas.nodes.length === snap.nodes.length,
   JSON.stringify({ ok: delGroupKeep.ok, nodes: afterDissolve.canvas.nodes.length }));
const delGroupBad = await del('/api/canvas/groups/NOT-EXIST');
ok('删除不存在的分组返回 404', delGroupBad.ok === false && /不存在/.test(delGroupBad.error));
await del('/api/canvas/node/' + noteId);

// 14. 环境 / 物品 / 参考图节点 + 端口级连线（本轮新增）
const sceneN = await post('/api/canvas/assets', { canvas_id: 'CV-MAIN', kind: 'scene', title: '雾港码头', x: 1500, y: 200, data: { timeOfDay: '深夜', weather: '浓雾', desc: '栈桥灯柱昏黄' } });
ok('创建环境节点（结构化 data）', sceneN.ok && sceneN.node.kind === 'scene' && sceneN.node.asset.timeOfDay === '深夜',
   JSON.stringify(sceneN.node?.asset));
const itemN = await post('/api/canvas/assets', { canvas_id: 'CV-MAIN', kind: 'item', title: '停摆怀表', x: 1500, y: 520, data: { category: '道具' } });
ok('创建物品节点', itemN.ok && itemN.node.kind === 'item' && itemN.node.asset.category === '道具');
const badAsset = await post('/api/canvas/assets', { canvas_id: 'CV-MAIN', kind: 'unknown-kind' });
ok('未知节点类型被拒绝（中文错误）', badAsset.ok === false && /未知节点类型/.test(badAsset.error));
const updAsset = await put('/api/canvas/assets/' + sceneN.node.id, { title: '雾港码头（夜）', data: { weather: '暴雨' } });
ok('资产节点可更新（标题 + 增量 data）', updAsset.node.title === '雾港码头（夜）' && updAsset.node.asset.weather === '暴雨' && updAsset.node.asset.timeOfDay === '深夜',
   JSON.stringify(updAsset.node.asset));
const refAdd = await post(`/api/canvas/assets/${sceneN.node.id}/ref-images`, { add: ['data/uploads/a.png', 'data/uploads/b.png'] });
ok('资产节点可挂参考图', refAdd.ok && refAdd.count === 2, JSON.stringify(refAdd));
const refPrimary = await post(`/api/canvas/assets/${sceneN.node.id}/ref-images`, { add: ['data/uploads/c.png'], primary: 'data/uploads/c.png' });
ok('可设置主参考图（置顶）', refPrimary.refImages[0] === 'data/uploads/c.png' && refPrimary.count === 3);
const refRemove = await post(`/api/canvas/assets/${sceneN.node.id}/ref-images`, { remove: ['data/uploads/a.png'] });
ok('可移除参考图', refRemove.count === 2 && !refRemove.refImages.includes('data/uploads/a.png'));
const matrix = await post('/api/canvas/ref-matrix', { canvas_id: 'CV-MAIN', x: 1500, y: 800, cols: 3, cell: 200, groupName: '参考图矩阵测试',
  files: [{ name: 'r1.png', path: 'data/uploads/r1.png' }, { name: 'r2.png', path: 'data/uploads/r2.png' }, { name: 'r3.png', path: 'data/uploads/r3.png' }] });
ok('参考图矩阵：批量生成节点并自动成组', matrix.ok && matrix.created === 3 && Boolean(matrix.groupId), JSON.stringify({ created: matrix.created, groupId: matrix.groupId }));
const matrixNodes = (await get('/api/canvas')).canvas.nodes.filter((n) => n.kind === 'refimg');
ok('参考图节点带分组归属与参考图', matrixNodes.length === 3 && matrixNodes.every((n) => n.group_id === matrix.groupId && (n.asset.refImages || []).length === 1));

// 端口级连线：任意节点之间，数量不限
const cvForLinks = (await get('/api/canvas')).canvas;
const actorNodeA = cvForLinks.nodes.find((n) => n.actor_id === ids[0]);
const l1 = await post('/api/canvas/links', { canvas_id: 'CV-MAIN', from_node: actorNodeA.id, to_node: sceneN.node.id, label: '出现在', from_side: 'right', to_side: 'left' });
ok('演员 → 环境 建立关系线（记录左右端口）', l1.ok && l1.link.from_node === actorNodeA.id && l1.link.to_node === sceneN.node.id && l1.link.from_side === 'right' && l1.link.to_side === 'left',
   JSON.stringify({ from: l1.link?.from_name, to: l1.link?.to_name }));
const l2 = await post('/api/canvas/links', { canvas_id: 'CV-MAIN', from_node: itemN.node.id, to_node: actorNodeA.id, label: '持有' });
ok('物品 → 演员 建立关系线（任意类型互连）', l2.ok && l2.link.from_kind === 'item' && l2.link.to_kind === 'actor');
const l3 = await post('/api/canvas/links', { canvas_id: 'CV-MAIN', from_node: sceneN.node.id, to_node: itemN.node.id, label: '场景道具' });
ok('环境 → 物品 建立关系线', l3.ok);
const dupLink = await post('/api/canvas/links', { canvas_id: 'CV-MAIN', from_node: actorNodeA.id, to_node: sceneN.node.id, label: '出现在', from_side: 'right', to_side: 'left' });
ok('相同连线幂等（不重复创建）', dupLink.link.id === l1.link.id);
const selfLink = await post('/api/canvas/links', { canvas_id: 'CV-MAIN', from_node: sceneN.node.id, to_node: sceneN.node.id });
ok('禁止自连（中文错误）', selfLink.ok === false && /同一个节点/.test(selfLink.error));
const missingNode = await post('/api/canvas/links', { canvas_id: 'CV-MAIN', from_node: 'ND-NOT-EXIST', to_node: sceneN.node.id });
ok('端点不存在时报错', missingNode.ok === false && /不存在/.test(missingNode.error));
// 无限数量：一次建 30 条
let madeLinks = 0;
const linkIds = cvForLinks.nodes.map((n) => n.id).slice(0, 6);
for (let i = 0; i < linkIds.length; i++) {
  for (let j = 0; j < linkIds.length; j++) {
    if (i === j) continue;
    const r = await post('/api/canvas/links', { canvas_id: 'CV-MAIN', from_node: linkIds[i], to_node: linkIds[j], label: `批量${madeLinks + 1}` });
    if (r.ok) madeLinks++;
  }
}
const allLinks = (await get('/api/canvas/links?id=CV-MAIN')).links;
ok(`关系线数量不受限（本次新建 ${madeLinks} 条，画布共 ${allLinks.length} 条）`, allLinks.length >= madeLinks && madeLinks >= 20, `links=${allLinks.length}`);
const nodeLinks = await del(`/api/canvas/nodes/${sceneN.node.id}/links`);
const afterNodeLinks = (await get('/api/canvas/links?id=CV-MAIN')).links;
ok('可按节点清理其全部连线', nodeLinks.ok && nodeLinks.removed >= 2 && !afterNodeLinks.some((l) => l.from_node === sceneN.node.id || l.to_node === sceneN.node.id),
   JSON.stringify(nodeLinks));
const delScene = await del('/api/canvas/node/' + sceneN.node.id);
ok('删除节点生效（连线级联清理）', delScene.ok && !(await get('/api/canvas/links?id=CV-MAIN')).links.some((l) => l.to_node === sceneN.node.id));

// 15. 画布组合出图（演员 × 环境 × 物品 × 参考图）
const cvC = (await get('/api/canvas')).canvas;
const heroNode = cvC.nodes.find((n) => n.actor_id === ids[0]);
const sceneN2 = await post('/api/canvas/assets', { canvas_id: 'CV-MAIN', kind: 'scene', title: '雾港码头', x: 1700, y: 120,
  data: { timeOfDay: '深夜', weather: '浓雾', desc: '栈桥灯柱昏黄', tags: ['主场景'] } });
const itemN2 = await post('/api/canvas/assets', { canvas_id: 'CV-MAIN', kind: 'item', title: '停摆怀表', x: 1700, y: 460,
  data: { category: '关键道具', desc: '指针停在十点四十' } });
await post('/api/canvas/links', { canvas_id: 'CV-MAIN', from_node: heroNode.id, to_node: sceneN2.node.id, label: '出现在' });
const prev = await post('/api/canvas/compose/preview', { canvasId: 'CV-MAIN', nodeIds: [heroNode.id], kind: 'full', variant: 'keyart' });
ok('组合预览：连线自动带入环境节点（连线即约束）', prev.ok && prev.assetCount >= 1 && prev.nodes.length >= 2,
   JSON.stringify({ nodes: prev.nodes.map((n) => n.kind + ':' + n.title), assets: prev.assetCount }));
ok('组合预览：提示词包含人物锚点 + 环境描述', /1girl|1boy|1person|young (wo)?man|woman/.test(prev.positive) && /雾港码头/.test(prev.positive) && /深夜/.test(prev.positive),
   prev.positive.slice(0, 200));
ok('组合预览：负向词与尺寸齐全', prev.negative.length > 20 && prev.width > 0 && prev.height > 0,
   JSON.stringify({ w: prev.width, h: prev.height, ratio: prev.ratio }));
const prevNoLink = await post('/api/canvas/compose/preview', { canvasId: 'CV-MAIN', nodeIds: [heroNode.id], kind: 'full', useLinked: false });
ok('可关闭「带上连线关联节点」', prevNoLink.ok && prevNoLink.assetCount === 0, JSON.stringify({ assets: prevNoLink.assetCount }));
// 纯资产出图需关闭「带上连线关联节点」，否则会把相连的演员一并纳入（这是预期行为）
const prevItemOnly = await post('/api/canvas/compose/preview', { canvasId: 'CV-MAIN', nodeIds: [itemN2.node.id, sceneN2.node.id], kind: 'custom', useLinked: false });
ok('纯资产节点也可组合出图（场景/道具概念）', prevItemOnly.ok && prevItemOnly.actorCount === 0 && /停摆怀表/.test(prevItemOnly.positive),
   prevItemOnly.positive.slice(0, 160));
const prevEmpty = await post('/api/canvas/compose/preview', { canvasId: 'CV-MAIN', nodeIds: [] });
ok('未选中节点时给出中文错误', prevEmpty.ok === false && /请先选中/.test(prevEmpty.error));
const prevBadCanvas = await post('/api/canvas/compose/preview', { canvasId: 'CV-NOT-EXIST', nodeIds: [heroNode.id] });
ok('画布不存在时报错', prevBadCanvas.ok === false && /画布不存在/.test(prevBadCanvas.error));

const composeJob = await post('/api/canvas/compose', { canvasId: 'CV-MAIN', nodeIds: [heroNode.id], kind: 'full', variant: 'keyart' });
ok('提交组合出图任务', composeJob.ok && composeJob.jobId && composeJob.total >= 1, JSON.stringify({ total: composeJob.total, ref: composeJob.usedRef }));
let cj = null;
for (let i = 0; i < 100; i++) {
  await new Promise((r) => setTimeout(r, 200));
  cj = (await get('/api/jobs/' + composeJob.jobId)).job;
  if (['done', 'error'].includes(cj.status)) break;
}
ok('组合出图任务执行完成', cj.status === 'done' && cj.result.failed === 0, JSON.stringify(cj.error || cj.result?.total));
const composedImgs = (await get(`/api/actors/${ids[0]}/images`)).images.filter((im) => im.kind === 'compose');
ok('组合结果写入演员素材库（kind=compose）', composedImgs.length >= 1 && composedImgs[0].prompt_pos.includes('雾港码头'),
   JSON.stringify(composedImgs.map((im) => im.kind + ':' + im.variant)));
const sceneAfterCompose = (await get('/api/canvas')).canvas.nodes.find((n) => n.id === sceneN2.node.id);
ok('组合结果同时挂到参与的环境节点（节点内可查看）', ((sceneAfterCompose.asset.generated) || []).length >= 1,
   JSON.stringify((sceneAfterCompose.asset.generated || []).length));
const assetGen = await post(`/api/canvas/assets/${sceneN2.node.id}/generate`, {});
ok('环境节点可单独生成概念图', assetGen.ok && assetGen.jobId);
const badAssetGen = await post(`/api/canvas/assets/${heroNode.id}/generate`, {});
ok('演员卡不支持「资产概念图」接口（中文错误）', badAssetGen.ok === false && /只支持环境/.test(badAssetGen.error));
await del('/api/canvas/node/' + sceneN2.node.id);
await del('/api/canvas/node/' + itemN2.node.id);

// 16. 导出 / 导入
const exp = await get('/api/export');
ok('导出包含演员与图片表', exp.data.actors.length >= 2 && exp.data.actor_images.length >= 3, `actors=${exp.data.actors.length}`);

// 17. 设置读写 + 出图测试
const s1 = await put('/api/settings', { image: { concurrency: 3, backend: 'placeholder' } });
ok('设置写回成功', s1.settings.image.concurrency === 3);
const t = await post('/api/settings/test-image', { backend: 'placeholder' });
ok('出图连通性测试成功', t.ok && t.filePath);

// 18. 校验与错误处理
const bad = await j('/api/actors/NOT-EXIST', {});
ok('不存在的演员返回明确错误', bad.ok === false && /不存在/.test(bad.error));
const badPrompt = await post('/api/actors/NOT-EXIST/prompt', {});
ok('对不存在演员生成提示词被拒绝', badPrompt.ok === false);

// 19. 删除
const beforeDel = (await get('/api/actors')).actors.length;
await del('/api/actors/' + a2.id);
const afterDel = await get('/api/actors');
ok('删除演员生效（含宫格节点）', afterDel.actors.length === beforeDel - 1, `${beforeDel} → ${afterDel.actors.length}`);
const canvasAfter = await get('/api/canvas');
ok('删除后宫格节点同步清理', !canvasAfter.canvas.nodes.some((n) => n.actor_id === a2.id));

// 20. 静态资源（/data 挂载点指向数据目录）
const imgAbs = path.isAbsolute(imgs1.images[0].file_path) ? imgs1.images[0].file_path : path.resolve(ROOT, imgs1.images[0].file_path);
const relToData = path.relative(DATA_DIR, imgAbs).split(path.sep).join('/');
const cssRes = await fetch(`${B}/data/${relToData}`);
ok('生成图片可通过 /data 静态访问（占位已改 PNG）', cssRes.ok && Buffer.from(await cssRes.arrayBuffer()).subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])));

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
server.close();
// 清理整棵临时目录（含临时 config.json、临时库与临时数据目录），真实 config/config.json 全程未被触碰
try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(fail ? 1 : 0);
