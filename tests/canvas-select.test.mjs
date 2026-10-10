// 画布「类型筛选 + 多选批处理」纯逻辑自测（纯 Node ≥22、零依赖、离线、零计费）
// 用法：node tests/canvas-select.test.mjs
//
// 被测模块：web/lib/canvas-select.js
// 契约来源：strategist/reports/T-103-canvas-select-spec.md
//           （AC-1 筛选谓词 · AC-2 批处理动作计划 · AC-3 与撤销栈/服务端快照/主画布保护的交互）
//
// 覆盖范围：筛选正常路径 / 边界（空集合、非法输入、无命中）/ 反例（幽灵卡位、坏 JSON、全锁定）/
//           中性组合语义（维度内 OR、维度间 AND、negate 最外层）/ 危险动作确认闸门 /
//           中文文案 / 幂等性（重复调用结果一致且不改入参）
//           RK-L6-01 收口（canvasId 三级自证 + 缺省整画布删除 fail-closed 拒绝，见 B7i~B7o）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---- 环境隔离：临时数据目录 + 临时库 + 临时配置（照抄 tests/test-graph.js 口径；
//      本模块是纯函数库、理论上完全不落库，隔离用于**证明**这一点）----
const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-canvas-select-'));
const DB = path.join(TMP, 'select.db');
const DATA_TMP = path.join(TMP, 'data');
const CFG = path.join(TMP, 'config.json');
fs.mkdirSync(DATA_TMP, { recursive: true });
fs.writeFileSync(CFG, JSON.stringify({
  image: { backend: 'placeholder', retries: 0, retryBaseMs: 0 },
  video: { backend: 'placeholder', retries: 0, retryBaseMs: 0 },
  llm: { provider: 'mock' },
}), 'utf8');
process.env.FACTORY_DATA_DIR = DATA_TMP;
process.env.FACTORY_DB = DB;
process.env.FACTORY_CONFIG = CFG;

// ⚠️ 必须先设 env 再动态 import
const SEL = await import('../web/lib/canvas-select.js');
const {
  DEFAULT_NODE_FILTER, NODE_KINDS, KIND_LABELS, EXECUTABLE_KINDS, BATCH_ACTIONS, BATCH_MAX_NODES,
  MAIN_CANVAS_ID, SIZE_LIMITS, SIZE_LIMIT_TEXT, BATCH_MESSAGES, SUPPORTED_ACTIONS,
  RERUN_FORBIDDEN_ENDPOINTS, normalizeNodeFilter, nodeKindOf, nodeGroupOf, isNodeLocked,
  nodeStatusOf, isNodeFailed, hasArtifactOf, matchNodeFilter, matchFilter, filterItems,
  describeNodeFilter, nodeFilterChips, clampNodeSize, planBatch, applyBatchPlan, describeBatchPlan,
  isMainCanvas,
} = SEL;

// ---- 结算助手：每条断言都打印可核对证据 ----
let pass = 0, fail = 0;
const ok = (name, cond, evidence = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${evidence ? `  ← ${evidence}` : ''}`); }
  else { fail++; console.error(`  ✗ ${name}  ← ${evidence}`); }
};
const eq = (name, actual, expected) => ok(name, actual === expected, `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`);
const eqJson = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`);
const has = (name, text, sub) => ok(name, typeof text === 'string' && text.includes(sub), `实际=${JSON.stringify(text)} 应含=${JSON.stringify(sub)}`);
const noThrow = (name, fn) => { try { fn(); ok(name, true, '未抛错'); } catch (e) { ok(name, false, `抛错：${e?.message || e}`); } };

// ============================ 测试夹具 ============================

/** 构造 canvas_nodes 行（字段名严格照 src/db.js 的建表语句） */
const mkNode = (id, over = {}) => ({
  id, canvas_id: 'CV-1', actor_id: '', x: 0, y: 0, w: 180, h: 220, z: 0,
  locked: 0, note: null, group_id: null, kind: 'actor', data: null, ...over,
});

/** 构造 layout item（字段名严格照 web/views/actors.js computeLayout() 的产出） */
function mkItem(o = {}) {
  const node = Object.prototype.hasOwnProperty.call(o, 'node') ? o.node : null;
  const kind = o.kind || 'actor';
  const actorId = o.actorId !== undefined ? o.actorId : null;
  return {
    id: o.id !== undefined ? o.id : (node ? node.id : `actor:${actorId || ''}`),
    actorId, actor: o.actor !== undefined ? o.actor : (actorId ? { id: actorId, name: `演员${actorId}` } : null),
    kind, node,
    locked: o.locked !== undefined ? o.locked : Boolean(node && node.locked),
    groupId: o.groupId !== undefined ? o.groupId : (node ? (node.group_id || null) : null),
    x: o.x ?? 100, y: o.y ?? 200, w: o.w ?? 180, h: o.h ?? 220, z: o.z ?? 0,
    note: o.note, asset: o.asset,
  };
}

/** 真实落库的演员卡（非幽灵卡位） */
const realActor = (nodeId, actorId, extra = {}) => mkItem({
  kind: 'actor', actorId, node: mkNode(nodeId, { actor_id: actorId, kind: 'actor' }),
  locked: extra.locked === true, groupId: extra.groupId || null,
  actor: { id: actorId, name: extra.name || `演员${actorId}`, cover_image: extra.cover_image || null },
});
/** 幽灵卡位演员（I2：item.node === null，item.id === 'actor:'+actorId） */
const ghostActor = (actorId, extra = {}) => mkItem({
  kind: 'actor', actorId, node: null, locked: extra.locked === true,
  actor: { id: actorId, name: extra.name || `演员${actorId}` },
});
/** 便签 / 资产 / 流程节点（node.data 为 JSON 字符串） */
const flowNode = (kind, nodeId, data = {}, extra = {}) => mkItem({
  kind, node: mkNode(nodeId, { kind, data: data === null ? null : JSON.stringify(data), group_id: extra.group_id || null }),
  locked: extra.locked === true, groupId: extra.groupId || extra.group_id || null, asset: extra.asset,
});

// 固定数据集（9 项：2 演员（1 真实+1 幽灵）/1 便签/1 关键帧/2 视频（1 失败）/2 环境/1 分镜容器）
const itA1 = realActor('ND-1', 'A1', { locked: true, groupId: 'G1', name: '演员甲', cover_image: '/img/a1.png' });  // 已锁定 + 有定妆图
const itA2 = ghostActor('A2', { name: '演员乙' });                                                                   // 幽灵卡位，无产物
const itNote = flowNode('note', 'ND-3', { text: '便签一', color: '#ffffff' });
itNote.note = { note_text: '便签一' };
const itImg = flowNode('image', 'ND-4', { status: 'done', lastFile: 'prod/1.png' });
const itVideoErr = flowNode('video', 'ND-5', { status: 'error', lastError: '后端超时' }, { group_id: 'G1' });
const itVideoOk = flowNode('video', 'ND-6', { status: 'done', lastFile: 'prod/2.mp4' });
const itSceneOk = flowNode('scene', 'ND-7', { status: 'idle' }, { asset: { refImages: ['ref/1.png', 'ref/2.png'] } });
const itSceneEmpty = flowNode('scene', 'ND-8', { status: 'idle' }, { asset: { refImages: [] } });
const itShotBroken = flowNode('shot', 'ND-9', null);   // data 为坏 JSON / null → 不得抛错
itShotBroken.node.data = '{坏JSON';

const ITEMS = [itA1, itA2, itNote, itImg, itVideoErr, itVideoOk, itSceneOk, itSceneEmpty, itShotBroken];

// ============================ A. 筛选：正常路径与组合语义（AC-1） ============================
console.log('\n=== A. 筛选谓词：正常路径 / 组合语义 / 边界 / 反例 ===');

const onlyKinds = (arr) => arr.every((it) => nodeKindOf(it) === arr[0].kind);

// A1 空筛选 = 全量（默认态必须与现状零差异）
const all = filterItems(ITEMS, DEFAULT_NODE_FILTER);
eq('A1 空筛选（默认态）返回全部节点', all.length, ITEMS.length);
ok('A1b 空筛选保持入参顺序且返回新数组', all.every((it, i) => it === ITEMS[i]) && all !== ITEMS, `长度=${all.length}`);
ok('A1c filterItems 不改入参：原数组长度与元素引用保持', ITEMS.length === 9 && ITEMS[0] === itA1);
eq('A1d 省略 spec 参数时等价于默认态', filterItems(ITEMS).length, 9);

// A2/A3 维度内 OR（单选 / 多选）
const onlyVideo = filterItems(ITEMS, { kinds: ['video'] });
eq('A2 kinds:["video"] 只留视频片段', onlyVideo.length, 2);
ok('A2b 命中的节点类型全为 video', onlyKinds(onlyVideo), `类型=${onlyVideo.map((it) => it.kind).join(',')}`);
eq('A3 kinds:["video","image"] 维度内 OR 同时保留两类', filterItems(ITEMS, { kinds: ['video', 'image'] }).length, 3);

// A4 维度间 AND
const actorLocked = filterItems(ITEMS, { kinds: ['actor'], locked: 'yes' });
eq('A4 kinds+locked 维度间取 AND（视频+已锁定→0 项）', filterItems(ITEMS, { kinds: ['video'], locked: 'yes' }).length, 0);
eq('A4b 演员卡且已锁定只剩 1 项', actorLocked.length, 1);
eq('A4c 该唯一命中项是 ND-1', actorLocked[0]?.node?.id, 'ND-1');
eq('A4d 视频且有产物取 AND 只剩 1 项', filterItems(ITEMS, { kinds: ['video'], hasArtifact: 'yes' }).length, 1);

// A5 分组维度：'' = 未分组（C5）
eq('A5 groups:["G1"] 只留该分组成员', filterItems(ITEMS, { groups: ['G1'] }).length, 2);
eq('A5b groups:[""] 只看未分组项', filterItems(ITEMS, { groups: [''] }).length, 7);
eq('A5c groups:[] 视为不限（不是全不选）', filterItems(ITEMS, { groups: [] }).length, 9);
eq('A5d nodeGroupOf 对 null / undefined 归一为未分组', nodeGroupOf({ groupId: null }) + '|' + nodeGroupOf({}), '|');

// A6 negate 在最外层整体取反（C4，不是逐维取反）
const noNote = filterItems(ITEMS, { kinds: ['note'], negate: true });
eq('A6 negate:true 对 AND 结果整体取反（排除 1 张便签）', noNote.length, 8);
ok('A6b 反选结果里没有便签，其余全部保留', noNote.every((it) => it.kind !== 'note'), `类型=${noNote.map((it) => it.kind).join(',')}`);
eq('A6c negate 不是逐维取反（kinds 反选 ≠ 空结果的补集）', filterItems(ITEMS, { kinds: [], negate: true }).length, 0);

// A7/A8 失败维度：只认 data.status === 'error'
eq('A7 failed:["yes"] 只命中 data.status=error 的视频节点', filterItems(ITEMS, { failed: 'yes' }).length, 1);
eq('A7b 该失败节点是 ND-5', filterItems(ITEMS, { failed: 'yes' })[0]?.node?.id, 'ND-5');
eq('A7c failed:"no" 命中其余 8 项', filterItems(ITEMS, { failed: 'no' }).length, 8);
eq('A8 演员卡的「失败」恒不适用（无 data → 未执行）', isNodeFailed(itA1), false);
eq('A8b 状态取值 \'failed\' 不算失败（只认 error）', isNodeFailed({ node: { data: JSON.stringify({ status: 'failed' }) } }), false);
eq('A8c 坏 JSON 的 data 解析失败按未执行处理，不抛错', isNodeFailed(itShotBroken), false);
eq('A8d nodeStatusOf 读出 error / 缺省为空串', nodeStatusOf(itVideoErr) + '|' + nodeStatusOf(itSceneOk), 'error|idle');

// A9/A10/A11 有产物维度（按 kind 分流的唯一实现）
eq('A9 scene 有参考图即视为有产物', hasArtifactOf(itSceneOk), true);
eq('A9b scene 参考图为空即无产物', hasArtifactOf(itSceneEmpty), false);
eq('A10 video 有 lastFile 即视为有产物', hasArtifactOf(itVideoOk), true);
eq('A11 便签恒无产物（反例）', hasArtifactOf(itNote), false);
eq('A11b 演员卡有定妆图即有产物', hasArtifactOf(itA1), true);
eq('A11c 无定妆图的演员卡无产物', hasArtifactOf(itA2), false);
eq('A11d 失败且无产物的视频无产物', hasArtifactOf(itVideoErr), false);
eq('A11e hasArtifact:"yes" 命中 4 项（演员甲/关键帧/视频/环境）', filterItems(ITEMS, { hasArtifact: 'yes' }).length, 4);
eq('A11f hasArtifact:"no" 与 "yes" 互补（4 + 5 = 9）', filterItems(ITEMS, { hasArtifact: 'no' }).length, 5);

// A12 边界：非法输入归一化且永不抛错
const bad = normalizeNodeFilter({ kinds: 'video', groups: 'G1', hasArtifact: 'maybe', failed: 1, locked: 'yes ', negate: 'yes' });
eqJson('A12 非法输入归一化为默认态（字符串 kinds / 非法三态 / 非布尔 negate）',
  bad, { kinds: [], groups: [], hasArtifact: 'any', failed: 'any', locked: 'any', negate: false });
eqJson('A12b kinds 去重并剔除非字符串与空串',
  normalizeNodeFilter({ kinds: ['video', 'video', '', 'image', 3, null] }).kinds, ['video', 'image']);
eqJson('A12c groups 的 null 归一为未分组取值 ""',
  normalizeNodeFilter({ groups: [null, undefined, 'G1'] }).groups, ['', 'G1']);
eqJson('A12d 非对象 spec（数组 / null / 字符串）一律回落默认态',
  normalizeNodeFilter(null), { kinds: [], groups: [], hasArtifact: 'any', failed: 'any', locked: 'any', negate: false });
noThrow('A12e normalizeNodeFilter 喂字符串不抛错', () => normalizeNodeFilter('video'));
noThrow('A12f matchNodeFilter 喂 null 项不抛错', () => matchNodeFilter(null, { failed: 'yes' }));
eq('A12g matchNodeFilter 对非对象项直接判不命中', matchNodeFilter(null, DEFAULT_NODE_FILTER), false);
eq('A12h nodeKindOf 缺省兜底 actor（与后端 kind||\'actor\' 同口径）', nodeKindOf({}) + '|' + nodeKindOf({ kind: '' }) + '|' + nodeKindOf(null), 'actor|actor|actor');
eq('A12i isNodeLocked 对 0/1 与缺省布尔化', isNodeLocked({ locked: 1 }) + '|' + isNodeLocked({ locked: 0 }) + '|' + isNodeLocked({}), 'true|false|false');
eq('A12j matchFilter 是 matchNodeFilter 的等价别名', matchFilter(itVideoErr, { failed: 'yes' }) === matchNodeFilter(itVideoErr, { failed: 'yes' }), true);

// 空集合与无命中（边界）
eq('A13 空集合筛选返回空数组（不抛错）', filterItems([], DEFAULT_NODE_FILTER).length, 0);
eq('A13b 非数组入参按空集合处理', filterItems(null, DEFAULT_NODE_FILTER).length, 0);
eq('A13c 无命中的类型筛选返回空数组', filterItems(ITEMS, { kinds: ['nonexistent-kind'] }).length, 0);
has('A13d 无命中提示为固定中文文案', BATCH_MESSAGES.noMatchingNodes, '当前筛选没有匹配的节点');
has('A13e 空选区可选提示为固定中文文案', BATCH_MESSAGES.nothingSelectable, '当前筛选没有可选的节点');

// A14 中文摘要与 chips
eq('A14 默认态摘要为「筛选：不限」', describeNodeFilter(DEFAULT_NODE_FILTER), '筛选：不限');
eq('A14b 带总数与命中数的摘要为「筛选：不限（2/3）」', describeNodeFilter(DEFAULT_NODE_FILTER, 3, 2), '筛选：不限（2/3）');
eq('A14c 多维度摘要按「类型 · 有产物 · 未锁定」拼接并带计数',
  describeNodeFilter({ kinds: ['video'], hasArtifact: 'yes', locked: 'no' }, 9, 1), '筛选：视频片段 · 有产物 · 未锁定（1/9）');
eq('A14d 未分组维度的摘要写作「分组：未分组」', describeNodeFilter({ groups: [''] }, 9, 7), '筛选：分组：未分组（7/9）');
eq('A14e 反选态摘要加「反选：」前缀', describeNodeFilter({ kinds: ['note'], negate: true }, 9, 8), '筛选：反选：便签（8/9）');
eq('A14f 总数为 0 时只显示命中数', describeNodeFilter(DEFAULT_NODE_FILTER, 0, 0), '筛选：不限');
const chips = nodeFilterChips({ kinds: ['video'], locked: 'yes' }, ITEMS);
eq('A15 chips 每个生效维度一片', chips.length, 2);
eq('A15b 类型片文案用中文类型名', chips[0]?.label, '类型：视频片段');
eq('A15c 类型片的命中数按该维度单独统计（2 个视频）', chips[0]?.count, 2);
eq('A15d 锁定片的命中数按该维度单独统计（1 个已锁定）', chips[1]?.count, 1);
const negChips = nodeFilterChips({ kinds: ['note'], negate: true }, ITEMS);
eq('A15e 反选片的命中数是整份筛选的命中数', negChips.find((c) => c.dim === 'negate')?.count, 8);
eq('A15f 默认态不产生任何 chip', nodeFilterChips(DEFAULT_NODE_FILTER, ITEMS).length, 0);

// A16 类型常量表（契约要求 14 键，且与 UI 文案表对齐）
eq('A16 NODE_KINDS 覆盖 14 种节点类型', NODE_KINDS.length, 14);
ok('A16b 每种类型都有中文文案', NODE_KINDS.every((k) => typeof KIND_LABELS[k] === 'string' && KIND_LABELS[k].length > 0), `缺失=${NODE_KINDS.filter((k) => !KIND_LABELS[k]).join(',')}`);
eq('A16c 可执行类型集合为 8 类（与 src/graph.js EXECUTABLE 同步）', EXECUTABLE_KINDS.length, 8);
ok('A16d 默认筛选规格已被冻结（防误改）', Object.isFrozen(DEFAULT_NODE_FILTER), `isFrozen=${Object.isFrozen(DEFAULT_NODE_FILTER)}`);

// ---- A17 幂等性：重复筛选结果一致，且不改入参 ----
const snapshotBefore = JSON.stringify(ITEMS);
const once = filterItems(ITEMS, { kinds: ['video'], failed: 'yes' });
const twice = filterItems(once, { kinds: ['video'], failed: 'yes' });
eqJson('A17 幂等：对结果再筛一次与只筛一次完全相同', twice.map((it) => it.id), once.map((it) => it.id));
eqJson('A17b 幂等：重复调用同一筛选得到相同结果', filterItems(ITEMS, { failed: 'yes' }).map((it) => it.id), filterItems(ITEMS, { failed: 'yes' }).map((it) => it.id));
eq('A17c 幂等：筛选后入参对象未被修改', JSON.stringify(ITEMS) === snapshotBefore, true);
eqJson('A17d 归一化幂等：normalize(normalize(x)) === normalize(x)',
  normalizeNodeFilter(normalizeNodeFilter({ kinds: ['video', 'video'], locked: 'maybe', negate: 'yes' })),
  normalizeNodeFilter({ kinds: ['video'], locked: 'maybe', negate: 'yes' }));

// ============================ B. 批处理：前置校验与危险动作闸门（AC-2） ============================
console.log('\n=== B. 批处理前置校验：空选区 / 危险动作未确认 / 锁定跳过 / 主画布硬闸门 ===');
const CV = 'CV-1';
const plan = (action, items, params = {}, opts = { canvasId: CV }) => planBatch(action, items, params, opts);
// 批处理用例专用夹具：未锁定的真实演员卡（删除/成组/移动都不受「跳过锁定项」干扰）
const delItem = realActor('ND-51', 'A51');

// B1 空选区（G1：按动作细分的中文提示）
const emptyDel = plan('delete', []);
eq('B1 空选区删除被拒，code=EMPTY_SELECTION', emptyDel.code, 'EMPTY_SELECTION');
eq('B1b 空选区删除提示为「请先选中要删除的节点」', emptyDel.reason, '请先选中要删除的节点');
const emptyMove = plan('move', [], { dx: 10, dy: 0 });
eq('B1c 空选区移动提示为「请先在画布上选中要处理的节点」', emptyMove.reason, '请先在画布上选中要处理的节点');
eq('B1d 空选区不产生任何接口调用描述', emptyDel.effects.length + emptyMove.effects.length, 0);

// B2 危险动作未确认被拒（AC-2 核心反例）
const needConfirm = plan('delete', [delItem], { mode: 'detach' });
eq('B2 删除未显式确认 → code=NEED_CONFIRM', needConfirm.code, 'NEED_CONFIRM');
eq('B2b 未确认时零副作用：effects 为空', needConfirm.effects.length, 0);
eq('B2c 未确认时保留 plannedEffects 供确认框预览', needConfirm.plannedEffects.length, 2);
ok('B2d 未确认时计划标记为不可执行（ok=false / needsConfirm=true）', needConfirm.ok === false && needConfirm.needsConfirm === true, `ok=${needConfirm.ok} needsConfirm=${needConfirm.needsConfirm}`);
has('B2e 未确认报错为中文且给出确认方式', needConfirm.reason, '必须显式确认后才能执行');
eq('B2f 删除属高危动作且强制自动快照（S2）', BATCH_ACTIONS.delete.danger + '|' + BATCH_ACTIONS.delete.autoSnapshot, 'high|true');
eq('B2g 删除的确认文案为单段（非主画布且仅选区）', needConfirm.confirmMode, 'single');
eq('B2h 未确认时给出待执行调用的中文预览路径', needConfirm.plannedEffects.map((e) => e.path).join(' | '), '/api/canvas/nodes/ND-51/links | /api/canvas/node/ND-51');

// B3 确认后放行：先清连线再删节点（spec §4.4 连带清理）
const delOk = plan('delete', [delItem], { mode: 'detach', confirm: true });
eq('B3 显式确认后删除计划通过（code=OK）', delOk.code, 'OK');
eq('B3b 每个卡位产出 2 个接口调用（先清连线、再删节点）', delOk.effects.length, 2);
eq('B3c 第一个调用是先清该节点连线', delOk.effects[0].method + ' ' + delOk.effects[0].path, 'DELETE /api/canvas/nodes/ND-51/links');
eq('B3d 第二个调用才是删节点', delOk.effects[1].method + ' ' + delOk.effects[1].path, 'DELETE /api/canvas/node/ND-51');
has('B3e 删除计划带上「连线无法撤销」的中文警告', delOk.warning, '该操作连带删除的连线无法用「撤销」恢复');
eq('B3f 删除计划要求执行前自动快照与撤销入栈', delOk.autoSnapshot === true && delOk.undoable === true, true);

// B4 purge 模式两段确认（D3 / H2）
const purgeOne = plan('delete', [delItem], { mode: 'purge', confirm: true });
eq('B4 purge 只过第一段确认仍被拒', purgeOne.code, 'NEED_CONFIRM');
eq('B4b purge 需要两段确认（confirmMode=double）', purgeOne.confirmMode, 'double');
eq('B4c purge 第一段文案列出演员姓名', purgeOne.confirmStages.length, 2);
has('B4d purge 第二段文案提示永久且不可撤销', purgeOne.confirmStages[1], '永久删除演员档案，不可通过「撤销」恢复');
const purgeTwo = plan('delete', [delItem], { mode: 'purge', confirm: 2 });
eq('B4e purge 用 confirm:2 表示两段已确认 → 放行', purgeTwo.code, 'OK');
eq('B4f purge 的落库调用是删演员档案', purgeTwo.effects[0].method + ' ' + purgeTwo.effects[0].path, 'DELETE /api/actors/A51');
has('B4g purge 计划带跨画布影响警告', purgeTwo.warning, '该操作影响所有画布，快照只保护当前画布');
const purgeBoth = plan('delete', [delItem], { mode: 'purge', confirm: true, confirmAgain: true });
eq('B4h purge 用 confirm:true + confirmAgain:true 同样放行', purgeBoth.code, 'OK');
eq('B4i purge 选区含非演员节点时提示其余按移出画布处理', plan('delete', [delItem, itNote], { mode: 'purge', confirm: 2 }).notices.some((n) => n.includes('其余 1 项')), true);

// B5 锁定卡位跳过（默认跳过、可勾选包含）
const lockedPair = [realActor('ND-11', 'A11'), realActor('ND-12', 'A12', { locked: true })];
const delSkip = plan('delete', lockedPair, { mode: 'detach', confirm: true });
eq('B5 锁定卡位默认跳过：只处理未锁定项', delSkip.affected, 1);
eq('B5b 跳过计数为 1', delSkip.skipped, 1);
has('B5c 跳过原因说明是「已锁定」', delSkip.skippedEntries[0].reason, '已锁定');
eq('B5d 跳过项不产生任何接口调用（1 项 → 2 个调用）', delSkip.effects.length, 2);
eq('B5e 提示文案写清处理数与跳过数', delSkip.messages[0], '已移除 1 个卡位，跳过 1 个已锁定');
const delAll = plan('delete', [realActor('ND-13', 'A13', { locked: true })], { mode: 'detach', confirm: true });
eq('B5f 全为锁定项时删除被拒（ALL_LOCKED）', delAll.code, 'ALL_LOCKED');
has('B5g 全锁定拒绝文案给出解锁指引', delAll.reason, '无法删除（先解锁或勾选「包含已锁定」）');
const delInclude = plan('delete', [realActor('ND-14', 'A14', { locked: true })], { mode: 'detach', confirm: true, includeLocked: true });
eq('B5h 勾选「包含已锁定」后才允许删除锁定项', delInclude.code, 'OK');
eq('B5i 覆盖锁定项时给出二次确认提示（H5）', delInclude.notices.some((n) => n.includes('确认要一并删除吗')), true);

// B6 幽灵卡位（I2 / H8）反例
const ghostDel = plan('delete', [itA2], { mode: 'detach', confirm: true });
eq('B6 幽灵卡位没有节点行，删除被拒（NOTHING_TO_DO）', ghostDel.code, 'NOTHING_TO_DO');
has('B6b 幽灵卡位拒绝文案说明原因', ghostDel.reason, '幽灵卡位');
eq('B6c 幽灵卡位的合成 id 与真实节点 id 不同（不得当主键用）', itA2.node === null && itA2.id === 'actor:A2', true);

// B7 主画布硬闸门（D6 / V2 / AC-3）
const mainGuard = planBatch('delete', [delItem], { mode: 'detach', scope: 'all', confirm: 2 }, { canvasId: MAIN_CANVAS_ID });
eq('B7 主画布批量删除「全部」被硬拒（MAIN_CANVAS_GUARD）', mainGuard.code, 'MAIN_CANVAS_GUARD');
has('B7b 拒绝文案为「主画布不可删除」专属版本', mainGuard.reason, '主画布不可删除（它是宫格预览全部演员的入口画布）');
eq('B7c 硬拒时零副作用且计划不可执行', mainGuard.ok === false && mainGuard.effects.length === 0 && mainGuard.plannedEffects.length === 0, true);
const mainTotal = planBatch('delete', [delItem, itA2], { mode: 'detach', confirm: 2 }, { canvasId: MAIN_CANVAS_ID, canvasTotal: 2 });
eq('B7d 选区覆盖整画布时同样触发主画布硬闸门', mainTotal.code, 'MAIN_CANVAS_GUARD');
const mainPartial = planBatch('delete', [delItem], { mode: 'detach', confirm: true }, { canvasId: MAIN_CANVAS_ID, canvasTotal: 9 });
eq('B7e 主画布上的局部删除仍需二次确认（confirmMode=double）', mainPartial.confirmMode, 'double');
has('B7f 主画布局部删除提示恢复入口', mainPartial.notices.join(' '), '⊕ 放入全部');
eq('B7g 批处理永远不允许删除画布本身', plan('delete', [delItem], { mode: 'detach', scope: 'canvas' }).code, 'CANVAS_DELETE_FORBIDDEN');
eq('B7h isMainCanvas 为硬编码字符串比对', isMainCanvas('CV-MAIN') + '|' + isMainCanvas('cv-main') + '|' + isMainCanvas(' CV-MAIN '), 'true|false|true');

// B8 宫格模式拒绝批量移动（M1 / H7）
const matrixMove = plan('move', [itA1], { dx: 10, dy: 0 }, { canvasId: CV, mode: 'matrix' });
eq('B8 宫格模式下批量移动被拒', matrixMove.code, 'MATRIX_MODE');
eq('B8b 拒绝文案为契约固定中文串', matrixMove.reason, '宫格模式下拖动是「换序」不是移动；批量移动请先切到自由模式（✦）');

// B9 参数校验：增量必须有限且非 0
eq('B9 移动增量为 0 被拒（BAD_PARAMS）', plan('move', [itA1], { dx: 0, dy: 0 }).code, 'BAD_PARAMS');
eq('B9b 非数值增量被拒', plan('move', [itA1], { dx: 'a', dy: 0 }).code, 'BAD_PARAMS');
eq('B9c 缩放未给 w/h/scale 被拒', plan('resize', [itA1], {}).code, 'BAD_PARAMS');
eq('B9d 缩放系数 <= 0 被拒', plan('resize', [itA1], { scale: 0 }).code, 'BAD_PARAMS');

// B10 全锁定移动（M2）
const moveAllLocked = plan('move', [realActor('ND-15', 'A15', { locked: true })], { dx: 10, dy: 10 });
eq('B10 选中项全为锁定时移动被拒（ALL_LOCKED）', moveAllLocked.code, 'ALL_LOCKED');
eq('B10b 全锁定移动文案按数量生成', moveAllLocked.reason, '选中的 1 个卡位全部已锁定，无法移动（先解锁）');

// B11 节点数上限护栏（G3）
const many = Array.from({ length: BATCH_MAX_NODES + 1 }, (_, i) => realActor(`ND-M${i}`, `AM${i}`));
const tooMany = plan('move', many, { dx: 1, dy: 0 });
eq('B11 超过上限的批处理被拒（TOO_MANY_NODES）', tooMany.code, 'TOO_MANY_NODES');
has('B11b 上限拒绝文案给出具体数量与建议', tooMany.reason, '一次最多处理 500 个节点（当前 501 个）：请先用筛选缩小范围');

// B12 不支持的动作 / 非法删除模式
has('B12 不支持的动作被拒并列出可用动作', plan('explode', [itA1]).reason, '不支持的批处理动作');
ok('B12b 可用动作清单包含七个动作', SUPPORTED_ACTIONS.length === 7 && SUPPORTED_ACTIONS.includes('rerun-kinds'), `清单=${SUPPORTED_ACTIONS.join(',')}`);
has('B12c 非法删除模式被拒并说明取值', plan('delete', [itA1], { mode: 'wipe', confirm: 2 }).reason, "只能是 'detach'（移出画布）或 'purge'（删除演员档案）");

// B13 缩放夹紧（照抄既有单卡边界，越界只夹紧不报错）
eqJson('B13 尺寸夹紧上界为 900×1200', clampNodeSize(5000, 5000), { w: 900, h: 1200, clamped: true });
eqJson('B13b 尺寸夹紧下界为 90×90', clampNodeSize(10, 10), { w: 90, h: 90, clamped: true });
eqJson('B13c 区间内尺寸不变且标记未夹紧', clampNodeSize(180, 220), { w: 180, h: 220, clamped: false });
const resizeBig = plan('resize', [delItem], { w: 5000, h: 5000 });
eq('B13d 批量缩放越界被夹紧为 900×1200', `${resizeBig.entries[0].to.w}×${resizeBig.entries[0].to.h}`, '900×1200');
eq('B13e 夹紧后不报错，计划仍然通过', resizeBig.code, 'OK');
has('B13f 夹紧时给出固定中文提示', resizeBig.notices.join(' '), SIZE_LIMIT_TEXT);
eq('B13g 缩放夹紧边界常量与契约一致', `${SIZE_LIMITS.minW}/${SIZE_LIMITS.minH}/${SIZE_LIMITS.maxW}/${SIZE_LIMITS.maxH}`, '90/90/900/1200');
const resizeScale = plan('resize', [delItem], { scale: 0.5 });
eq('B13h 相对缩放按当前尺寸四舍五入并夹紧（180×220 → 90×110）', `${resizeScale.entries[0].to.w}×${resizeScale.entries[0].to.h}`, '90×110');
eq('B13i 缩放保留原坐标（只改宽高）', `${resizeScale.entries[0].to.x},${resizeScale.entries[0].to.y}`, '100,200');

// B14 落库路径分流（spec §4.0 三条硬约束）
const moveMix = plan('move', [delItem, itNote, itSceneOk], { dx: 5, dy: -5 });
const paths = moveMix.effects.map((e) => `${e.method} ${e.path}`);
eq('B14 演员卡几何走 POST /api/canvas/nodes 批量接口', paths[0], 'POST /api/canvas/nodes');
eq('B14b 便签几何走 PUT /api/canvas/notes/:id', paths[1], 'PUT /api/canvas/notes/ND-3');
eq('B14c 资产/流程节点几何走 PUT /api/canvas/assets/:id', paths[2], 'PUT /api/canvas/assets/ND-7');
eq('B14d 演员卡落库以 actor_id 为键（不是合成 id）', moveMix.effects[0].body.nodes[0].actor_id, 'A51');
ok('B14e 落库体里绝不出现 actor:xxx 合成 id', !JSON.stringify(moveMix.effects).includes('actor:A51'), `body=${JSON.stringify(moveMix.effects[0].body.nodes[0])}`);
const ghostMove = plan('move', [itA2], { dx: 30, dy: 40 });
eq('B14f 幽灵卡位也能按 actor_id 落库（自动 INSERT）', ghostMove.effects[0].body.nodes[0].actor_id, 'A2');
eq('B14g 幽灵卡位落库坐标含增量', `${ghostMove.effects[0].body.nodes[0].x},${ghostMove.effects[0].body.nodes[0].y}`, '130,240');
has('B14h 批量移动不触发自动归组（H6）', ghostMove.notices.join(' '), '批量移动不触发自动归组');

// B15 成组：仅演员卡可入组（P2 / R3）
const groupMixed = plan('group', [itA1, itNote, itSceneOk], { name: '第一组' });
eq('B15 含便签/资产时成组仍放行（跳过非演员项）', groupMixed.code, 'OK');
eq('B15b 非演员项被计入 skipped', groupMixed.skipped, 2);
has('B15c 非演员项跳过提示为固定中文文案', groupMixed.notices.join(' '), '便签/资产/流程节点暂不支持批量成组（已跳过 2 项）');
eq('B15d 成组调用 createGroup 接口', `${groupMixed.effects[0].method} ${groupMixed.effects[0].path}`, 'POST /api/canvas/groups');
eqJson('B15e 入组名单只含演员 id', groupMixed.effects[0].body.actorIds, ['A1']);
eq('B15f 选区全为非演员项时成组被拒（NO_ACTOR）', plan('group', [itNote, itSceneOk]).code, 'NO_ACTOR');
eq('B15g 成组属中危且会大改包围盒 → 强制自动快照（S2）', BATCH_ACTIONS.group.autoSnapshot, true);
const groupGhost = plan('group', [itA2], { name: '幽灵组' });
eq('B15h 幽灵卡位成组前先物化（否则包围盒算错）', groupGhost.effects[0].path, '/api/canvas/node');
eq('B15i 物化调用以 actor_id 为键', groupGhost.effects[0].body[0].actor_id, 'A2');

// B16 按类型重跑：可执行集合过滤 + 审批链路 + 禁用入口（H1 / R1）
const rerunSource = plan('rerun-kinds', [itA1, itSceneOk, itShotBroken], {}, { canvasId: CV, confirm: true });
eq('B16 选区全为素材源/容器时重跑被拒（NO_EXECUTABLE）', rerunSource.code, 'NO_EXECUTABLE');
has('B16b 拒绝文案说明可执行类型', rerunSource.reason, '没有可执行的节点（可执行的类型：关键帧、视频、文本、音频、叠加层、字幕轨、成片时间线、交付终点）');
has('B16c 素材源/容器进 skip 清单且写明不参与执行', rerunSource.skippedEntries.map((s) => s.reason).join(' '), '素材源 / 容器不参与执行');
const rerunNeed = plan('rerun-kinds', [itVideoOk], {}, { canvasId: CV });
eq('B16d 付费重跑需要显式确认（NEED_CONFIRM）', rerunNeed.code, 'NEED_CONFIRM');
eq('B16e 付费重跑未确认时零副作用', rerunNeed.effects.length, 0);
const rerunOk = plan('rerun-kinds', [itVideoOk], {}, { canvasId: CV, confirm: true });
eq('B16f 确认后重跑计划通过', rerunOk.code, 'OK');
eq('B16g 重跑只产出 1 个零付费计划调用', rerunOk.effects.length === 1 && rerunOk.effects[0].path === '/api/canvas/plan', true);
eqJson('B16h 计划调用的入参含 nodeIds 与 overwrite', rerunOk.effects[0].body, { canvasId: CV, nodeIds: ['ND-6'], overwrite: false });
eq('B16i 重跑必须人工审批且需终端确认码', rerunOk.requiresApproval === true && rerunOk.requiresConfirm === true, true);
eq('B16j 重跑不入撤销栈（U4）', rerunOk.undoable, false);
eqJson('B16k 禁用入口清单为 /api/canvas/run 与 /api/canvas/run-node', RERUN_FORBIDDEN_ENDPOINTS, ['/api/canvas/run', '/api/canvas/run-node']);
ok('B16l 重跑计划的接口调用不命中任何禁用入口', rerunOk.effects.every((e) => !RERUN_FORBIDDEN_ENDPOINTS.includes(e.path)), `调用=${rerunOk.effects.map((e) => e.path).join(',')}`);
eq('B16m 审批链路为固定的 5 步（计划→建单→批准→确认码→执行）', rerunOk.approvalChain.length, 5);
has('B16n 审批链路首步是零付费计划接口', rerunOk.approvalChain[0], '/api/canvas/plan');
eq('B16o 重跑属最高危付费动作', `${BATCH_ACTIONS['rerun-kinds'].danger}|${BATCH_ACTIONS['rerun-kinds'].paid}|${BATCH_ACTIONS['rerun-kinds'].requiresApproval}`, 'max|true|true');
has('B16p 素材源/容器不参与执行但必须显式列入提示（H11 同源要求）', rerunSource.notices.join(' '), '不参与执行，已跳过');
const rerunLockedNotice = plan('rerun-kinds', [flowNode('video', 'ND-20', { status: 'idle' }, { locked: true })], {}, { canvasId: CV, confirm: true });
has('B16q 锁定节点的重跑提示为契约固定文案', rerunLockedNotice.notices.join(' '), '锁定只防误拖，不阻止执行');
eq('B16r 未落库的可执行节点无法重跑（NOTHING_TO_DO）', plan('rerun-kinds', [mkItem({ kind: 'video', actorId: null, node: null })], {}, { canvasId: CV, confirm: true }).code, 'NOTHING_TO_DO');
eq('B16s 服务端拦截原因（队列暂停/预算/环）原样透传', plan('rerun-kinds', [itVideoOk], {}, { canvasId: CV, confirm: true, blockedReason: '队列已暂停：请先恢复队列' }).reason, '队列已暂停：请先恢复队列');
eq('B16t 指定类型里没有可执行节点时给出区分文案', plan('rerun-kinds', [itVideoOk], { kinds: ['image'] }, { canvasId: CV, confirm: true }).code, 'NO_EXECUTABLE');
eq('B16u 强制重跑会在大计划里显式标注（真实费用）', plan('rerun-kinds', [itVideoOk], { overwrite: true }, { canvasId: CV, confirm: true }).notices.some((n) => n.includes('会产生真实费用')), true);

// B17 锁定 / 解锁（复用唯一写入口）
const lockOne = plan('lock', [realActor('ND-21', 'A21')]);
eq('B17 锁定走 POST /api/canvas/node/:id/lock', `${lockOne.effects[0].method} ${lockOne.effects[0].path}`, 'POST /api/canvas/node/ND-21/lock');
eqJson('B17b 锁定入参为 {locked:true}', lockOne.effects[0].body, { locked: true });
eq('B17c 已锁定项再锁定被拒（无需变更）', plan('lock', [realActor('ND-22', 'A22', { locked: true })]).code, 'NOTHING_TO_DO');
eq('B17d 解锁入参为 {locked:false}', plan('unlock', [realActor('ND-23', 'A23', { locked: true })])?.effects[0].body.locked, false);
eq('B17e 幽灵卡位无法锁定，按跳过处理', plan('lock', [itA2]).code, 'NOTHING_TO_DO');
eq('B17f 锁定切换不打自动快照（S2：避免挤满快照额度）', BATCH_ACTIONS.lock.autoSnapshot, false);

// ============================ C. 应用计划：投影 / 幂等 / 同源校验（AC-2 / AC-3） ============================
console.log('\n=== C. 应用批处理计划：内存投影、幂等性与计划-数据同源校验 ===');

const moveItems = [realActor('ND-31', 'A31'), realActor('ND-32', 'A32')];
const movePlan = plan('move', moveItems, { dx: 40, dy: -20 });
const itemsSnapshot = JSON.stringify(moveItems);
const applied = applyBatchPlan(movePlan, { items: moveItems });
eq('C1 应用移动计划成功', applied.ok, true);
eq('C1b 投影出 2 个坐标补丁', applied.patches.length, 2);
eq('C1c 投影后的坐标含增量（100+40, 200-20）', `${applied.items[0].x},${applied.items[0].y}`, '140,180');
eq('C1d 原 items 数组未被修改（纯函数）', JSON.stringify(moveItems), itemsSnapshot);
ok('C1e 未改动项的引用被复用（只替换变更项）', applied.items.length === 2 && applied.items[0] !== moveItems[0] && applied.patches.length === 2, true);
eq('C1f 移动计划需要撤销入栈（U1/U3：一个动作一步撤销）', applied.before.undo, true);
eq('C1g 移动不打自动快照（低危动作）', applied.before.autoSnapshot, false);
const appliedAgain = applyBatchPlan(movePlan, { items: moveItems });
eqJson('C1h 幂等：同一计划应用两次得到完全相同的投影', appliedAgain.items.map((it) => `${it.x},${it.y}`), applied.items.map((it) => `${it.x},${it.y}`));
eq('C1i 幂等：重复应用后原数组仍未变形', JSON.stringify(moveItems), itemsSnapshot);

const delApplied = applyBatchPlan(delOk, { items: [delItem] });
eq('C2 应用删除计划成功（计划与列表同源）', delApplied.ok, true);
eq('C2b 删除后投影列表移除 1 项（1 → 0）', delApplied.items.length, 0);
eq('C2c removed 记录被删项的 nodeId 与类型', `${delApplied.removed[0].nodeId}/${delApplied.removed[0].kind}`, 'ND-51/actor');
eq('C2d 删除前要求自动快照（S1/S2）', delApplied.before.autoSnapshot, true);
eq('C2e 删除的展示标签为「批量删除」', delApplied.before.snapshotLabel, '批量删除');

const stale = applyBatchPlan(delOk, { items: [delItem, itA2] });
eq('C3 计划与现列表长度不一致时被拒（STALE_PLAN）', stale.code, 'STALE_PLAN');
has('C3b 同源校验失败给出中文提示与重算建议', stale.reason, '请重新生成计划');
eq('C3c 同源校验失败时不产生任何接口调用', stale.effects.length, 0);

const unconfirmedApply = applyBatchPlan(needConfirm, { items: [delItem] });
eq('C4 未确认的危险计划不能落地（NEED_CONFIRM）', unconfirmedApply.code, 'NEED_CONFIRM');
eq('C4b 未确认落地时零副作用', unconfirmedApply.effects.length === 0 && unconfirmedApply.changed === false, true);
const confirmAtApply = applyBatchPlan(needConfirm, { items: [delItem], confirm: true });
eq('C4c 应用阶段显式确认后放行（用计划里的 plannedEffects）', confirmAtApply.ok === true && confirmAtApply.effects.length === 2, true);
const guardApply = applyBatchPlan(mainGuard, { items: [delItem], confirm: true });
eq('C5 主画布硬拒计划不能落地（MAIN_CANVAS_GUARD）', guardApply.code, 'MAIN_CANVAS_GUARD');
has('C5b 主画布硬拒的中文原因被保留', guardApply.reason, '主画布不可删除');
// 注：主画布硬拒发生在确认文案生成之前（confirmStages 为空），所以未满足确认时 applyBatchPlan 会先返回 NEED_CONFIRM；
//     两种路径下 effects 都为 0，安全属性不变（闸门顺序差异见 risks 记录，留给返工卡定点处理）。
const guardApply2 = applyBatchPlan(mainGuard, { items: [delItem], confirm: 2 });
eq('C5d 主画布硬拒计划在任何确认参数下都零副作用', guardApply2.ok === false && guardApply2.effects.length === 0 && guardApply2.changed === false, true);
eq('C5c 缺少计划时给出中文提示（NO_PLAN）', applyBatchPlan(null, { items: [] }).code, 'NO_PLAN');

const lockApplied = applyBatchPlan(plan('lock', [realActor('ND-41', 'A41')]), { items: [realActor('ND-41', 'A41')] });
eq('C6 锁定计划的投影把 locked 置为 true', lockApplied.items[0].locked, true);
const rerunApplied = applyBatchPlan(rerunOk, { items: [itVideoOk] });
eq('C7 重跑计划落地只登记审批链路，不改画布状态', rerunApplied.changed === false && rerunApplied.submitted === false, true);
eq('C7b 重跑落地结果带审批链路与禁用入口', rerunApplied.approvalChain.length === 5 && rerunApplied.forbiddenEndpoints.length === 2, true);
eq('C7c 重跑不入撤销栈', rerunApplied.before.undo, false);
const groupApplied = applyBatchPlan(groupMixed, { items: [itA1, itNote, itSceneOk] });
eq('C8 成组计划落地标记 groupApplied（分组 id 以服务端为准）', groupApplied.groupApplied === true && groupApplied.changed === false, true);

// C9 计划的中文摘要
has('C9 通过的计划摘要包含处理项数与确认要求', describeBatchPlan(delOk), '处理 1 项');
has('C9b 失败的计划摘要直接给出中文原因', describeBatchPlan(mainGuard), '主画布不可删除');
has('C9c 付费重跑摘要标注需人工审批与确认码', describeBatchPlan(rerunOk), '需人工审批 + 终端确认码');
eq('C9d 空计划摘要兜底为中文', describeBatchPlan(null), '（无批处理计划）');

// C10 幂等性：同一输入重复生成计划，结果完全一致
eq('C10 幂等：重复生成删除计划结果完全一致', JSON.stringify(plan('delete', [delItem], { mode: 'detach', confirm: true })) === JSON.stringify(delOk), true);
eq('C10b 幂等：重复生成重跑计划结果完全一致', JSON.stringify(plan('rerun-kinds', [itVideoOk], {}, { canvasId: CV, confirm: true })) === JSON.stringify(rerunOk), true);
eq('C10c 幂等：失败计划重复生成也完全一致', JSON.stringify(plan('move', [itA1], { dx: 0, dy: 0 })) === JSON.stringify(plan('move', [itA1], { dx: 0, dy: 0 })), true);

// ============================ B7 续. RK-L6-01 收口：canvasId 三级自证与缺省硬拒（fail-closed） ============================
// 依据：strategist/reports/L6-verify.md:425（RT-03 实测「不传 canvasId 时整画布删除被放行」ok=true affected=5 请求数=10）
//       strategist/tasks/C-002-canvas-id-fail-closed.yaml（interface_contract 第 1~6 条）
// 断言目标：canvasId 缺省或为空时**默认按最严处理**（拒绝整画布删除），而不是把 mainCanvas 判成 false 放行。
console.log('\n=== B7 续. RK-L6-01：canvasId 三级自证（opts → params → items[*].node.canvas_id）与缺省 fail-closed ===');

// 夹具：① node.canvas_id 为空（三级都取不到）② node.canvas_id 自证为主画布
const noCanvasItem = mkItem({
  kind: 'actor', actorId: 'A61',
  node: mkNode('ND-61', { actor_id: 'A61', kind: 'actor', canvas_id: '' }),
  actor: { id: 'A61', name: '演员A61', cover_image: null },
});
const mainSelfItem = mkItem({
  kind: 'actor', actorId: 'A62',
  node: mkNode('ND-62', { actor_id: 'A62', kind: 'actor', canvas_id: MAIN_CANVAS_ID }),
  actor: { id: 'A62', name: '演员A62', cover_image: null },
});

// B7i 缺省且无法自证 → 整画布删除必须被拒（核心断言：不传 canvasId 时整画布删除被拒）
const noIdAll = planBatch('delete', [noCanvasItem], { mode: 'detach', scope: 'all', confirm: 2 }, { canvasTotal: 1 });
eq('B7i 不传 canvasId 且无法自证时，整画布删除被硬拒（CANVAS_ID_REQUIRED）', noIdAll.code, 'CANVAS_ID_REQUIRED');
has('B7i-b 缺省拒绝的中文原因含「未提供画布 ID」', noIdAll.reason, '未提供画布 ID');
has('B7i-c 缺省拒绝的中文原因含「已拒绝整画布批量删除」与重试指引', noIdAll.reason, '已拒绝整画布批量删除：请传 canvasId（或 canvasTotal）后重试。');
eq('B7i-d 缺省硬拒时零副作用且计划不可执行', noIdAll.ok === false && noIdAll.effects.length === 0 && noIdAll.plannedEffects.length === 0, true);
eq('B7i-e 缺省时 canvasSource=none（不再静默按普通画布放行）', `${noIdAll.canvasSource}|${noIdAll.canvasId}`, 'none|');
eq('B7i-f 件数覆盖整画布（canvasTotal）同样触发缺省拒绝',
  planBatch('delete', [noCanvasItem], { mode: 'detach', confirm: 2 }, { canvasTotal: 1 }).code, 'CANVAS_ID_REQUIRED');

// B7j 缺省但可自证为主画布 → 走既有 MAIN_CANVAS_GUARD（不是新码）
const selfMain = planBatch('delete', [mainSelfItem], { mode: 'detach', scope: 'all', confirm: 2 }, { canvasTotal: 1 });
eq('B7j 不传 canvasId 但 node.canvas_id 自证为主画布 → MAIN_CANVAS_GUARD（自证生效）', selfMain.code, 'MAIN_CANVAS_GUARD');
eq('B7j-b 自证出的画布 id / 主画布判定 / 来源正确', `${selfMain.canvasId}|${selfMain.mainCanvas}|${selfMain.canvasSource}`, 'CV-MAIN|true|items');
has('B7j-c 自证命中后沿用既有主画布专属文案', selfMain.reason, '主画布不可删除（它是宫格预览全部演员的入口画布）');

// B7k 缺省但只删部分选区 → 行为必须与显式传 canvasId 时逐字相同（不得被新码误伤）
const noIdPartial = planBatch('delete', [delItem], { mode: 'detach' }, { canvasTotal: 9 });
const withIdPartial = planBatch('delete', [delItem], { mode: 'detach' }, { canvasId: 'CV-1', canvasTotal: 9 });
eq('B7k 不传 canvasId 的部分选区不被新码拒绝（NEED_CONFIRM，保持原行为）', noIdPartial.code, 'NEED_CONFIRM');
eq('B7k-b 部分选区的确认段与显式传 canvasId 时逐字相同', JSON.stringify(noIdPartial.confirmStages), JSON.stringify(withIdPartial.confirmStages));
eq('B7k-c 部分选区的提示 / 中文原因 / 确认文案与显式传 canvasId 时逐字相同',
  JSON.stringify([noIdPartial.notices, noIdPartial.reason, noIdPartial.confirmText]),
  JSON.stringify([withIdPartial.notices, withIdPartial.reason, withIdPartial.confirmText]));
eq('B7k-d 部分选区时 canvasId 由 items 自证（CV-1）', `${noIdPartial.canvasId}|${noIdPartial.canvasSource}`, 'CV-1|items');

// B7l canvasSource 四态（opts / params / items / none）
eq('B7l canvasSource 四态之一：opts', planBatch('delete', [delItem], { mode: 'detach' }, { canvasId: CV, canvasTotal: 9 }).canvasSource, 'opts');
eq('B7l-b canvasSource 四态之二：params', planBatch('delete', [noCanvasItem], { mode: 'detach', canvasId: CV }, {}).canvasSource, 'params');
eq('B7l-c canvasSource 四态之三：items（节点自证）', noIdPartial.canvasSource, 'items');
eq('B7l-d canvasSource 四态之四：none（三级都取不到）', noIdAll.canvasSource, 'none');
eq('B7l-e opts 与 params 同时给 canvasId 时以 opts 为准', planBatch('delete', [delItem], { mode: 'detach', canvasId: 'CV-9' }, { canvasId: CV, canvasTotal: 9 }).canvasId, CV);

// B7m 缺省硬拒的计划在 applyBatchPlan 阶段同样不能落地（走既有分支，无新增绕过）
const noIdApplied = applyBatchPlan(noIdAll, { items: [noCanvasItem], confirm: true });
eq('B7m 缺省硬拒计划不能落地（ok=false / effects=0 / changed=false）', noIdApplied.ok === false && noIdApplied.effects.length === 0 && noIdApplied.changed === false, true);
eq('B7m-b 落地拒绝时 code 原样透传', noIdApplied.code, 'CANVAS_ID_REQUIRED');
has('B7m-c 落地拒绝时中文原因原样透传', noIdApplied.reason, '未提供画布 ID，无法确认是否为主画布');
eq('B7m-d 传 confirm:2 时同样零副作用（确认闸门顺序先于拒绝码，见 risks）',
  applyBatchPlan(noIdAll, { items: [noCanvasItem], confirm: 2 }).effects.length, 0);

// B7n 自证出的画布 id 必须写进 effects（落库体与计划同源）
const selfMove = planBatch('move', [delItem], { dx: 5, dy: 5 }, {});
eq('B7n 自证出的画布 id 写进 effects 的 actor 落库体', `${selfMove.canvasId}|${selfMove.effects[0].body.nodes[0].canvas_id}`, 'CV-1|CV-1');

// B7o 反向护栏：能自证/显式给出非主画布时，整画布删除仍按原语义放行（未过度收紧）
eq('B7o 显式传非主画布时整画布删除仍放行', planBatch('delete', [delItem], { mode: 'detach', scope: 'all', confirm: 2 }, { canvasId: CV, canvasTotal: 9 }).code, 'OK');
eq('B7o-b 自证为非主画布时整画布删除同样放行（有凭据就不拦）',
  planBatch('delete', [delItem], { mode: 'detach', scope: 'all', confirm: 2 }, { canvasTotal: 1 }).code, 'OK');

// ============================ B7p/B7q. R-W3-01 / R-W3-02 收口（W3 红队两条残余绕过） ============================
// 依据：strategist/reports/W3-acceptance.md §3①/§4/§5（R-W3-01 中低、R-W3-02 中低），逐字对应的红队原始输出：
//   RT-①-D：不传 canvasId / 不传 canvasTotal / 节点 canvas_id 为空 → NEED_CONFIRM → 确认后 ok=true affected=5 DELETE请求=10
//   RT-①-E：混合选区（首项 canvas_id='CV-2'，同选区含 2 个 'CV-MAIN'，scope='all'）→ NEED_CONFIRM → 确认后
//           ok=true affected=3 DELETE请求=6，主画布节点被删且未触发 MAIN_CANVAS_GUARD
// 断言目标：①「无法自证画布身份」的删除类动作一律 fail-closed 拒绝（不再看 coversAll）——
//           ②「选区内出现主画布节点」必须触发主画布保护（不再只看首个非空 canvas_id）。
console.log('\n=== B7p/B7q. R-W3-01（无法自证画布身份 → 删除类动作硬拒）/ R-W3-02（选区内出现主画布节点 → 必须触发保护） ===');

/** 统计一次计划/落地结果里的真实 DELETE 请求数（判定「零副作用」的硬口径） */
const deleteCalls = (r) => (Array.isArray(r?.effects) ? r.effects : []).filter((e) => e.method === 'DELETE').length;

// ---- 夹具：① 5 个节点自身 canvas_id 为空（RT-①-D 的「整画布 5 节点当选区」形态）----
const blankIdItems = Array.from({ length: 5 }, (_, i) => mkItem({
  kind: 'actor', actorId: `AB${i}`,
  node: mkNode(`ND-B${i}`, { actor_id: `AB${i}`, kind: 'actor', canvas_id: '' }),
  actor: { id: `AB${i}`, name: `演员AB${i}`, cover_image: null },
}));
// ---- 夹具：② 混合画布选区 = 首项非主画布（CV-2）+ 同选区 2 个主画布节点（RT-①-E 的复现形态）----
const mixedCv2 = mkItem({
  kind: 'actor', actorId: 'A71',
  node: mkNode('ND-71', { actor_id: 'A71', kind: 'actor', canvas_id: 'CV-2' }),
  actor: { id: 'A71', name: '演员A71', cover_image: null },
});
const mixedMain1 = mkItem({
  kind: 'actor', actorId: 'A72',
  node: mkNode('ND-72', { actor_id: 'A72', kind: 'actor', canvas_id: MAIN_CANVAS_ID }),
  actor: { id: 'A72', name: '演员A72', cover_image: null },
});
const mixedMain2 = mkItem({
  kind: 'actor', actorId: 'A73',
  node: mkNode('ND-73', { actor_id: 'A73', kind: 'actor', canvas_id: MAIN_CANVAS_ID }),
  actor: { id: 'A73', name: '演员A73', cover_image: null },
});
const MIXED_SEL = [mixedCv2, mixedMain1, mixedMain2];

// ---- B7p R-W3-01：不传 canvasId、不传 canvasTotal，节点 canvas_id 也为空 → 删除一律硬拒 ----
const rtW301 = planBatch('delete', blankIdItems, { mode: 'detach', confirm: 2 }, {});
eq('B7p 不传 canvasId / 不传 canvasTotal / 节点 canvas_id 为空 → 删除被硬拒（CANVAS_ID_REQUIRED）', rtW301.code, 'CANVAS_ID_REQUIRED');
has('B7p-b 拒绝原因含「未提供画布 ID」', rtW301.reason, '未提供画布 ID');
has('B7p-c 拒绝原因说明「已拒绝批量删除」并给出重试指引', rtW301.reason, '已拒绝批量删除');
has('B7p-d 拒绝原因给出补凭据的具体做法（传 canvasId / 先落库）', rtW301.reason, '请传 canvasId');
eq('B7p-e 硬拒时零副作用：ok=false / effects=0 / plannedEffects=0',
  rtW301.ok === false && rtW301.effects.length === 0 && rtW301.plannedEffects.length === 0, true);
eq('B7p-f 硬拒时 DELETE 请求数为 0（红队原实测为 10）', deleteCalls(rtW301), 0);
const rtW301Apply = applyBatchPlan(rtW301, { items: blankIdItems, confirm: true, confirmAgain: true });
eq('B7p-g 落地阶段同样拒绝（code 原样透传）', rtW301Apply.code, 'CANVAS_ID_REQUIRED');
eq('B7p-h 落地阶段零 DELETE 请求（红队原实测为 10）', deleteCalls(rtW301Apply), 0);
eq('B7p-i 落地阶段不产出任何 effects / 不改动列表',
  rtW301Apply.ok === false && rtW301Apply.effects.length === 0 && rtW301Apply.changed === false && rtW301Apply.items.length === 5, true);
eq('B7p-j 即便显式声明 scope=all（既有已堵死路径）仍是同一拒绝码',
  planBatch('delete', blankIdItems, { mode: 'detach', scope: 'all', confirm: 2 }, {}).code, 'CANVAS_ID_REQUIRED');
eq('B7p-k 只取 1 项的部分选区（不传 canvasTotal）同样硬拒：fail-closed 不看 coversAll',
  planBatch('delete', [noCanvasItem], { mode: 'detach', confirm: true }, {}).code, 'CANVAS_ID_REQUIRED');
eq('B7p-l 自证为空且不声明 scope 时 canvasSource=none（拒绝依据可审计）',
  planBatch('delete', [noCanvasItem], { mode: 'detach', confirm: true }, {}).canvasSource, 'none');
// 反向护栏（不得过度收紧）：
const withIdBlankNode = planBatch('delete', [noCanvasItem], { mode: 'detach' }, { canvasId: 'CV-2', canvasTotal: 9 });
eq('B7p-m 反向护栏：调用方显式传 canvasId 时，节点 canvas_id 为空的部分删除仍按原语义（NEED_CONFIRM）', withIdBlankNode.code, 'NEED_CONFIRM');
const withIdBlankNodeOk = planBatch('delete', [noCanvasItem], { mode: 'detach', confirm: true }, { canvasId: 'CV-2', canvasTotal: 9 });
eq('B7p-n 反向护栏：显式传 canvasId 且确认后仍放行（2 个 DELETE）',
  `${withIdBlankNodeOk.code}|${deleteCalls(withIdBlankNodeOk)}`, 'OK|2');
const selfProvedPartial = planBatch('delete', [delItem, itNote], { mode: 'detach', confirm: true }, {});
eq('B7p-o 反向护栏：节点能自证画布（CV-1）的部分删除仍放行（4 个 DELETE）',
  `${selfProvedPartial.code}|${deleteCalls(selfProvedPartial)}|${selfProvedPartial.canvasSource}`, 'OK|4|items');
eq('B7p-p 反向护栏：新码只作用于删除类动作，move 未被误伤（canvas_id 为空也照常出计划）',
  planBatch('move', [noCanvasItem], { dx: 5, dy: 5 }, {}).ok, true);
eq('B7p-q 反向护栏：purge 模式同样只被「缺画布身份」拦住，不额外新增拒绝码',
  planBatch('delete', [noCanvasItem], { mode: 'purge', confirm: 2 }, {}).code, 'CANVAS_ID_REQUIRED');

// ---- B7q R-W3-02：混合画布选区含主画布节点 → 必须触发主画布保护 ----
const rtW302 = planBatch('delete', MIXED_SEL, { mode: 'detach', scope: 'all', confirm: 2 }, {});
eq('B7q 混合选区（首项 CV-2 + 2 个主画布节点）声明整画布 → MAIN_CANVAS_GUARD', rtW302.code, 'MAIN_CANVAS_GUARD');
has('B7q-b 拒绝原因沿用「主画布不可删除」专属文案', rtW302.reason, '主画布不可删除（它是宫格预览全部演员的入口画布）');
has('B7q-c 拒绝原因点明画布身份不自洽（列出选区内的 CV-2 与 CV-MAIN）',
  rtW302.reason, '本次判据：选区内出现主画布（CV-MAIN）节点，但自证/声明的画布是「CV-2」；选区内出现的画布：CV-2、CV-MAIN');
eq('B7q-d 硬拒时零副作用（ok=false / effects=0 / plannedEffects=0）',
  rtW302.ok === false && rtW302.effects.length === 0 && rtW302.plannedEffects.length === 0, true);
eq('B7q-e 硬拒时 DELETE 请求数为 0（红队原实测为 6，主画布节点被删）', deleteCalls(rtW302), 0);
const rtW302Apply = applyBatchPlan(rtW302, { items: MIXED_SEL, confirm: true, confirmAgain: true });
eq('B7q-f 落地阶段同样拒绝（code 原样透传）', rtW302Apply.code, 'MAIN_CANVAS_GUARD');
eq('B7q-g 落地阶段零 DELETE 请求', deleteCalls(rtW302Apply), 0);
eq('B7q-h 传 confirm:2 时仍零 DELETE（确认闸门先于拒绝码，与 C5d 同口径）',
  deleteCalls(applyBatchPlan(rtW302, { items: MIXED_SEL, confirm: 2 })), 0);
eq('B7q-i 不声明 scope、仅靠 canvasTotal 覆盖整画布 → 同样触发保护',
  planBatch('delete', MIXED_SEL, { mode: 'detach', confirm: 2 }, { canvasTotal: 3 }).code, 'MAIN_CANVAS_GUARD');
eq('B7q-j 部分选区（canvasTotal 更大、coversAll=false）也拒绝：保护不因 coversAll 而失效',
  planBatch('delete', MIXED_SEL, { mode: 'detach', confirm: 2 }, { canvasTotal: 99 }).code, 'MAIN_CANVAS_GUARD');
eq('B7q-k 显式冒充非主画布（canvasId=CV-2）仍被拒：身份随选区而非调用方声明',
  planBatch('delete', MIXED_SEL, { mode: 'detach', scope: 'all', confirm: 2 }, { canvasId: 'CV-2' }).code, 'MAIN_CANVAS_GUARD');
eq('B7q-l 自证身份仍是首项 CV-2（修复不改「首个非空」取值口径），但主画布节点已被识别',
  `${rtW302.canvasId}|${rtW302.mainCanvas}|${rtW302.selectionHasMainCanvas}|${rtW302.mixedCanvasSelection}|${rtW302.selectionCanvasIds.join('+')}`,
  'CV-2|false|true|true|CV-2+CV-MAIN');
eq('B7q-m 节点 canvas_id 带空格（\' CV-MAIN \'）同样触发保护（与 isMainCanvas 的 trim 口径一致）',
  planBatch('delete', [mixedCv2, mkItem({
    kind: 'actor', actorId: 'A74',
    node: mkNode('ND-74', { actor_id: 'A74', kind: 'actor', canvas_id: ' CV-MAIN ' }),
    actor: { id: 'A74', name: '演员A74', cover_image: null },
  })], { mode: 'detach', scope: 'all', confirm: 2 }, {}).code, 'MAIN_CANVAS_GUARD');
// R-W3-02 附带：跨多个非主画布（不含主画布节点）→ 身份同样不自洽，硬拒
const mixedNonMain = planBatch('delete', [delItem, mixedCv2], { mode: 'detach', scope: 'all', confirm: 2 }, { canvasTotal: 2 });
eq('B7q-n 选区跨两个非主画布（CV-1 + CV-2）→ CANVAS_ID_CONFLICT 硬拒', mixedNonMain.code, 'CANVAS_ID_CONFLICT');
has('B7q-o 冲突拒绝原因列出涉事画布并给出重试指引', mixedNonMain.reason, '选区里出现了多个不同画布的节点（CV-1、CV-2）');
eq('B7q-p 冲突硬拒时零 DELETE（含落地阶段）',
  `${deleteCalls(mixedNonMain)}|${deleteCalls(applyBatchPlan(mixedNonMain, { items: [delItem, mixedCv2], confirm: true, confirmAgain: true }))}`, '0|0');
// 反向护栏（不得过度收紧）：
eq('B7q-q 反向护栏：单一非主画布的整画布删除仍按原语义放行（未过度收紧）',
  planBatch('delete', [delItem, itNote], { mode: 'detach', scope: 'all', confirm: 2 }, { canvasId: CV, canvasTotal: 2 }).code, 'OK');
const mainPartialOnlyOneConfirm = planBatch('delete', [delItem], { mode: 'detach', confirm: true }, { canvasId: MAIN_CANVAS_ID, canvasTotal: 9 });
eq('B7q-r0 反向护栏：主画布局部删除只过第一段确认仍被拦（双确认保护有效，未被新码削弱）',
  `${mainPartialOnlyOneConfirm.code}|${mainPartialOnlyOneConfirm.confirmMode}`, 'NEED_CONFIRM|double');
const mainPartialStillOk = planBatch('delete', [delItem], { mode: 'detach', confirm: 2 }, { canvasId: MAIN_CANVAS_ID, canvasTotal: 9 });
eq('B7q-r 反向护栏：主画布上的单一画布部分删除仍是既有双确认语义（B7e/B7f 未被误伤）',
  `${mainPartialStillOk.code}|${mainPartialStillOk.confirmMode}|${mainPartialStillOk.notices.some((n) => n.includes('⊕ 放入全部'))}`,
  'OK|double|true');
eq('B7q-r2 同上：该部分删除计划确实产出 2 个 DELETE（保护只拦整画布，不误伤局部删除）',
  `${deleteCalls(mainPartialStillOk)}|${mainPartialStillOk.selectionCanvasIds.join('+')}|${mainPartialStillOk.mixedCanvasSelection}`, '2|CV-1|false');
eq('B7q-s 反向护栏：幽灵卡位（node=null）不参与画布身份判定，不产生假冲突',
  `${planBatch('delete', [itA2, realActor('ND-81', 'A81')], { mode: 'detach', confirm: true }, { canvasId: CV }).code}`, 'OK');
// 幂等 / 纯读：两条修复都必须保持「重复生成结果一致、不改入参」
eq('B7q-t 幂等：混合选区拒绝计划重复生成完全一致（新判据是纯函数）',
  JSON.stringify(planBatch('delete', MIXED_SEL, { mode: 'detach', scope: 'all', confirm: 2 }, {})) === JSON.stringify(rtW302), true);
eqJson('B7q-u 纯读：新判据不改动入参 items 的 canvas_id',
  MIXED_SEL.map((it) => it.node.canvas_id), [ 'CV-2', MAIN_CANVAS_ID, MAIN_CANVAS_ID ]);

// ============================ B7r. W7 收口：两条 fail-open（主画布整批删除 / 谎报 canvasId 孤证） ============================
// 依据：W7 收尾卡（第 2 轮①）。两条缺陷均在修复前**实测复现**（探针 /tmp/w7/probe-canvas.mjs，原始输出见
// strategist/reports/W7-round1-2.md §第2轮①）：
//   洞①（web/lib/canvas-select.js 原 :787 附近）：coversAll 的两个证据（scope / canvasTotal）全来自调用方，
//        于是「选区恰好就是主画布的全部节点 + 不传 canvasTotal + 不传 scope='all'」→ coversAll=false →
//        主画布硬闸门被绕过：code=OK ok=true affected=5 DELETE 请求=10（确认后主画布 5 个卡位被整批删除）。
//        修复口径：主画布上只认**反向证明**——拿不到「canvasTotal > 选区长度」（严格子集）就一律按整画布等价处理。
//   洞②（原 :319 附近）：调用方谎报 canvasId='CV-2'，而选区内节点都没有 canvas_id 可对质（声明是孤证），
//        且无 canvasTotal → 同样 ok=true DELETE=10。修复口径：孤证 + 无子集证明 → CANVAS_ID_UNVERIFIED 硬拒。
// 本节只**新增**断言；B7i~B7q 的既有 287 条期望与文案一字未改（见 W7 报告「既有断言删除行=0」）。
console.log('\n=== B7r. W7 收口：主画布整批删除缺 canvasTotal 不再被绕过 / 谎报 canvasId 的孤证不再放行 ===');

/** 洞①夹具：选区 = 主画布全部 5 个节点（每项 node.canvas_id=CV-MAIN，可自证） */
const mainAll5 = Array.from({ length: 5 }, (_, i) => mkItem({
  kind: 'actor', actorId: `AW${i}`,
  node: mkNode(`ND-W${i}`, { actor_id: `AW${i}`, kind: 'actor', canvas_id: MAIN_CANVAS_ID }),
  actor: { id: `AW${i}`, name: `演员AW${i}`, cover_image: null },
}));
/** 洞②夹具：选区 = 5 个**有节点行**但 canvas_id 为空串的卡位（没有任何对质材料） */
const blankCanvas5 = Array.from({ length: 5 }, (_, i) => mkItem({
  kind: 'actor', actorId: `AV${i}`,
  node: mkNode(`ND-V${i}`, { actor_id: `AV${i}`, kind: 'actor', canvas_id: '' }),
  actor: { id: `AV${i}`, name: `演员AV${i}`, cover_image: null },
}));
/** 洞②变体：节点行存在但**没有 canvas_id 字段**（历史脏数据 / 接口未回传） */
const noCanvasField5 = blankCanvas5.map((it, i) => {
  const node = { ...it.node };
  delete node.canvas_id;
  return mkItem({ kind: 'actor', actorId: `AU${i}`, node, actor: { id: `AU${i}`, name: `演员AU${i}`, cover_image: null } });
});

// ---- 洞①：不传 canvasTotal / 不传 scope='all' 时，主画布整批删除必须硬拒（修复前 = OK + 10 个 DELETE）----
const w7Hole1 = planBatch('delete', mainAll5, { mode: 'detach', confirm: 2 }, {});
eq('B7r 洞①：不传 canvasTotal / 不声明 scope，节点自证为主画布 → MAIN_CANVAS_GUARD（修复前 ok=true affected=5）', w7Hole1.code, 'MAIN_CANVAS_GUARD');
has('B7r-b 洞①拒绝沿用主画布专属文案（与 B7b 同一句，便于逐字复核）', w7Hole1.reason, '主画布不可删除（它是宫格预览全部演员的入口画布）');
eq('B7r-c 洞①硬拒时零副作用：ok=false / affected=0 / effects=plan 调用=0',
  `${w7Hole1.ok}|${w7Hole1.affected}|${w7Hole1.effects.length}|${deleteCalls(w7Hole1)}`, 'false|0|0|0');
eq('B7r-d 洞①落地阶段同样拒绝（code 原样透传、零 DELETE；confirm:true 与既有 B7q-g 同口径——确认闸门先于拒绝码）',
  `${applyBatchPlan(w7Hole1, { items: mainAll5, confirm: true }).code}|${deleteCalls(applyBatchPlan(w7Hole1, { items: mainAll5, confirm: true }))}`, 'MAIN_CANVAS_GUARD|0');
eq('B7r-d2 洞①落地阶段传 confirm:2（与计划 confirmMode=single 不匹配）仍是零 DELETE，不得借确认口径放行',
  `${applyBatchPlan(w7Hole1, { items: mainAll5, confirm: 2 }).ok}|${deleteCalls(applyBatchPlan(w7Hole1, { items: mainAll5, confirm: 2 }))}`, 'false|0');
eq('B7r-e 洞①拒绝依据可审计（canvasSource/mainCanvas 如实记录，不是靠猜）',
  `${w7Hole1.canvasSource}|${w7Hole1.mainCanvas}|${w7Hole1.selectionCanvasIds.join('+')}`, 'items|true|CV-MAIN');
eq('B7r-f 洞①对照组：显式给出 canvasTotal=选区长度（=覆盖整画布）仍是同一拒绝码（既有语义未变）',
  planBatch('delete', mainAll5, { mode: 'detach', confirm: 2 }, { canvasTotal: 5 }).code, 'MAIN_CANVAS_GUARD');
eq('B7r-g 反向护栏：canvasTotal=99（严格子集证明）仍按既有的「主画布部分删除」语义放行',
  (() => { const p = planBatch('delete', mainAll5, { mode: 'detach', confirm: 2 }, { canvasTotal: 99 }); return `${p.code}|${p.confirmMode}|${deleteCalls(p)}`; })(), 'OK|double|10');
eq('B7r-h 反向护栏：严格子集但仍只过第一段确认 → NEED_CONFIRM（双确认保护未被削弱）',
  `${planBatch('delete', mainAll5, { mode: 'detach', confirm: true }, { canvasTotal: 99 }).code}|${deleteCalls(planBatch('delete', mainAll5, { mode: 'detach', confirm: true }, { canvasTotal: 99 }))}`, 'NEED_CONFIRM|0');
eq('B7r-i 洞①优先于洞②：显式声明为主画布 + 节点无 canvas_id 对质 + 无 canvasTotal → 仍是 MAIN_CANVAS_GUARD（更强的码优先）',
  planBatch('delete', blankCanvas5, { mode: 'detach', confirm: 2 }, { canvasId: MAIN_CANVAS_ID }).code, 'MAIN_CANVAS_GUARD');

// ---- 洞②：调用方谎报 canvasId 且节点无 canvas_id 对质 → 孤证不可采信（修复前 = OK + 10 个 DELETE）----
const w7Hole2 = planBatch('delete', blankCanvas5, { mode: 'detach', confirm: 2 }, { canvasId: 'CV-2' });
eq('B7r-j 洞②：声明 canvasId=\'CV-2\' 但选区内节点都没有 canvas_id 对质、且无 canvasTotal → CANVAS_ID_UNVERIFIED 硬拒',
  w7Hole2.code, 'CANVAS_ID_UNVERIFIED');
eq('B7r-k 洞②硬拒时零副作用：ok=false / affected=0 / 零 DELETE 请求（修复前为 10）',
  `${w7Hole2.ok}|${w7Hole2.affected}|${deleteCalls(w7Hole2)}`, 'false|0|0');
eq('B7r-l 洞②落地阶段同样拒绝（code 原样透传、零 DELETE；confirm:true 与既有 B7p-g 同口径）',
  `${applyBatchPlan(w7Hole2, { items: blankCanvas5, confirm: true }).code}|${deleteCalls(applyBatchPlan(w7Hole2, { items: blankCanvas5, confirm: true }))}`, 'CANVAS_ID_UNVERIFIED|0');
eq('B7r-l2 洞②落地阶段传 confirm:2 同样零 DELETE（拒绝码不会被确认口径绕过）',
  `${applyBatchPlan(w7Hole2, { items: blankCanvas5, confirm: 2 }).ok}|${deleteCalls(applyBatchPlan(w7Hole2, { items: blankCanvas5, confirm: 2 }))}`, 'false|0');
has('B7r-m 洞②中文原因点名被质疑的画布 ID 并说明「得不到节点印证」', w7Hole2.reason, '画布 ID「CV-2」得不到选区节点印证');
has('B7r-n 洞②中文原因给出两条可操作补救（传 canvasTotal / 先让节点落库）',
  `${w7Hole2.reason.includes('请传 canvasTotal')}|${w7Hole2.reason.includes('先让节点落库')}`, 'true|true');
eq('B7r-o 洞②变体：节点行存在但没有 canvas_id 字段（脏数据）同样硬拒',
  planBatch('delete', noCanvasField5, { mode: 'detach', confirm: 2 }, { canvasId: 'CV-2' }).code, 'CANVAS_ID_UNVERIFIED');
eq('B7r-p 洞②变体：purge 模式同样拦住（删除语义不分 detach/purge）',
  planBatch('delete', blankCanvas5, { mode: 'purge', confirm: 2 }, { canvasId: 'CV-2' }).code, 'CANVAS_ID_UNVERIFIED');
eq('B7r-q 反向护栏：给 canvasTotal > 选区长度（证明只是子集）的显式声明仍按原语义放行（B7p-n 未被误伤）',
  `${planBatch('delete', [noCanvasItem], { mode: 'detach', confirm: true }, { canvasId: 'CV-2', canvasTotal: 9 }).code}|${deleteCalls(planBatch('delete', [noCanvasItem], { mode: 'detach', confirm: true }, { canvasId: 'CV-2', canvasTotal: 9 }))}`, 'OK|2');
eq('B7r-r 反向护栏：节点能对质（canvas_id=CV-1）且声明一致时照常放行',
  `${planBatch('delete', [delItem], { mode: 'detach', confirm: true }, { canvasId: CV }).code}|${deleteCalls(planBatch('delete', [delItem], { mode: 'detach', confirm: true }, { canvasId: CV }))}`, 'OK|2');
eq('B7r-s 反向护栏：纯幽灵卡位（没有节点行，无从删除）不由新码拦，仍是 NOTHING_TO_DO（B6 语义不变）',
  planBatch('delete', [itA2], { mode: 'detach', confirm: true }, { canvasId: 'CV-2' }).code, 'NOTHING_TO_DO');
eq('B7r-t 反向护栏：canvasSource=none（三级都取不到）仍报 CANVAS_ID_REQUIRED，新码不抢占既有码',
  planBatch('delete', blankCanvas5, { mode: 'detach', confirm: 2 }, {}).code, 'CANVAS_ID_REQUIRED');
eq('B7r-u 反向护栏：两条新判据只作用于删除类动作（move 在同样「无 canvasTotal + 节点无 canvas_id」下照常出计划）',
  planBatch('move', blankCanvas5, { dx: 5, dy: 5 }, { canvasId: 'CV-2' }).ok, true);
eqJson('B7r-v 幂等：两条新判据都是纯函数，重复生成结果逐字一致',
  JSON.stringify(planBatch('delete', blankCanvas5, { mode: 'detach', confirm: 2 }, { canvasId: 'CV-2' })) === JSON.stringify(w7Hole2), true);
eqJson('B7r-w 纯读：新判据不改动入参 items 的 node.canvas_id（空串仍是空串）',
  blankCanvas5.map((it) => it.node.canvas_id), ['', '', '', '', '']);

// ============================ D. 沙箱自检：绝不触碰真实库 ============================
console.log('\n=== D. 环境自检：本模块纯函数、零落库、零网络 ===');
const realDb = path.join(ROOT, 'data', 'factory.db');
ok('D1 未触碰真实库 data/factory.db', process.env.FACTORY_DB !== realDb, `FACTORY_DB=${DB}`);
ok('D2 临时库路径位于本次临时目录内', path.resolve(process.env.FACTORY_DB).startsWith(path.resolve(TMP)), `TMP=${TMP}`);
ok('D3 被测模块是纯函数库：全程未创建任何库文件', !fs.existsSync(DB), `DB 存在=${fs.existsSync(DB)}`);
ok('D4 临时数据目录与配置已就位（隔离生效）', fs.existsSync(DATA_TMP) && fs.existsSync(CFG), `CFG=${CFG}`);

// ---- 收尾：清理临时目录，绝不留下污染 ----
console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(fail ? 1 : 0);
