// 画布「类型筛选 + 多选批处理」纯逻辑库（零依赖 / 无 DOM / 无副作用 / 可被 Node 直接 import 做单测）
//
// 契约来源：strategist/reports/T-103-canvas-select-spec.md（AC-1 筛选谓词、AC-2 批处理动作计划、
//           AC-3 与撤销栈 / 服务端快照 / 主画布保护的交互）。本文件是该契约的**可执行版本**。
//
// ---------------- 职责边界（改动前务必守住，越界会破坏可测性与最小改动原则）----------------
//   1. 纯计算：不发 HTTP、不读 window / document / S、不 toast、不写全局状态；不修改入参对象。
//   2. 批处理只产出两样东西：
//        · planBatch(...)      → 「动作计划」（可展示、可审批、可测的纯数据）
//        · applyBatchPlan(...) → 「内存投影（新 items）+ 接口调用描述 effects」
//      真正的 HTTP 调用、toast、pushUndo()、自动快照由视图层（web/views/actors.js）按计划执行。
//   3. 危险动作（删除 / 按类型重跑）必须显式 `confirm` 字段；未确认时**不产出任何 effects**
//      （spec AC-2）。purge 模式与主画布删除要求**两段确认**（spec D3 / H4）。
//   4. 主画布 CV-MAIN 硬闸门：禁止批量删除「全部」卡位（等同清空），批处理也永远不允许删除画布本身
//      （spec AC-3 / V1 / D6，后端另有一道硬闸门 src/modules/actors.js「主画布不可删除」）。
//      ⚠️ RK-L6-01 收口（fail-closed）：画布 id 走三级自证（opts → params → items[*].node.canvas_id，见
//      deriveCanvasId），三级都取不到且是「整画布删除」语义时返回 CANVAS_ID_REQUIRED **拒绝执行**——
//      缺省一律按最严处理，绝不因为拿不到 canvasId 就把主画布判定弃用（原缺陷 = 缺省即放行）。
//   5. 三条落库硬约束（spec §4.0）已编码进 effects：actor 一律以 actor_id 为键走 POST /api/canvas/nodes；
//      便签走 PUT /api/canvas/notes/:id；资产/流程节点走 PUT /api/canvas/assets/:id；
//      删除节点前必须先 DELETE /api/canvas/nodes/:id/links（removeCanvasNode 不清连线）。
//   6. 付费重跑只允许生成「计划链路」（/api/canvas/plan → 人工审批 → 终端确认码 → /plans/:id/run），
//      **禁止**调用 /api/canvas/run、/api/canvas/run-node（它们绕过 authorizeRun 闸门，spec R1 硬性禁止）。
//
// ---------------- 用法速览（给集成线 T-402 的接线示例）----------------
//   import { filterItems, DEFAULT_NODE_FILTER, planBatch, applyBatchPlan } from '../lib/canvas-select.js';
//   const visible = filterItems(items, S.nodeFilter || DEFAULT_NODE_FILTER);        // ① 筛选
//   const plan = planBatch('delete', [...selectedItems], { mode: 'detach' }, { canvasId: S.canvasId, canvasTotal: items.length, canvasName: S.canvasName });
//   if (!plan.ok && plan.code === 'NEED_CONFIRM') { const yes = await modal('确认', plan.confirmText); if (!yes) return; }
//   const again = planBatch('delete', [...selectedItems], { mode: 'detach', confirm: true }, { canvasId: S.canvasId, canvasTotal: items.length });
//   const res = applyBatchPlan(again, { items });
//   if (!res.ok) return toast(res.reason, 'warn');
//   pushUndo();                                  // U1：动作开始前入栈一次
//   if (res.before.autoSnapshot) await api.post('/api/snapshots/auto', ...);   // 复用 autoSnapshotBefore
//   for (const ef of res.effects) await api.raw(ef.method, ef.path, ef.body);
//   await loadCanvas(); draw();

// ============================ 1. 常量表 ============================

/**
 * 画布节点类型全集（14 键）。
 * ⚠️ 必须与 `web/views/actors.js` 的 `NODE_KINDS`、`src/modules/actors.js` 的 `PORT_RULES` 保持同步。
 */
export const NODE_KINDS = Object.freeze([
  'actor', 'note', 'scene', 'item', 'refimg', 'text', 'image', 'video',
  'shot', 'timeline', 'audio', 'overlay', 'subtitle', 'output',
]);

/**
 * 类型中文名（HUD / chips / 确认框的唯一文案来源，避免各处硬编码中文）。
 * 注：`audio` / `overlay` 采用 T-103 §3.5 的短文案；`web/views/actors.js` 的 `ASSET_STYLE` 里写作
 * 「音频节点」「叠加层（画中画）」。二者语义一致，若要完全统一，只改本表一处即可。
 */
export const KIND_LABELS = Object.freeze({
  actor: '演员卡', note: '便签', scene: '环境', item: '物品', refimg: '参考图',
  text: '文本', image: '关键帧（出图）', video: '视频片段', shot: '分镜容器',
  timeline: '成片时间线', audio: '音频', overlay: '叠加层', subtitle: '字幕轨', output: '交付终点',
});

/** 可执行节点类型（与 `src/graph.js` 的 `EXECUTABLE` 逐字同步；按类型重跑的唯一有效集合） */
export const EXECUTABLE_KINDS = Object.freeze([
  'image', 'video', 'text', 'audio', 'overlay', 'subtitle', 'output', 'timeline',
]);

/** 素材源类型（不参与执行；按类型重跑时必须显式列入 skip 清单，不得静默） */
export const SOURCE_KINDS = Object.freeze(['actor', 'scene', 'item', 'refimg', 'note']);

/** 容器类型（分镜容器；不参与执行） */
export const CONTAINER_KINDS = Object.freeze(['shot']);

/** 资产类型（与 `src/modules/actors.js` 的 `ASSET_KINDS` 同步） */
export const ASSET_KINDS = Object.freeze(['scene', 'item', 'refimg', 'audio']);

/**
 * 可编辑的素材 / 流程节点（12 类，与 `src/modules/actors.js` 的 `CREATABLE_KINDS` 同步）。
 * 只有这些类型能走 `PUT /api/canvas/assets/:id`；`actor` 走 `/api/canvas/nodes`，`note` 走 `/api/canvas/notes/:id`。
 */
export const CREATABLE_KINDS = Object.freeze([
  ...ASSET_KINDS, 'shot', 'video', 'timeline', 'output', 'image', 'text', 'overlay', 'subtitle',
]);

/** 主画布 id（保护是硬编码字符串比对，不是数据字段 —— spec §5.3） */
export const MAIN_CANVAS_ID = 'CV-MAIN';

/** 单次批处理的节点数上限（G3 护栏：先筛选再批处理的硬约束） */
export const BATCH_MAX_NODES = 500;

/** 节点尺寸夹紧边界（照抄既有单卡缩放：web/views/actors.js `Math.max(90, Math.min(900, ...))`） */
export const SIZE_LIMITS = Object.freeze({ minW: 90, maxW: 900, minH: 90, maxH: 1200 });
export const SIZE_LIMIT_TEXT = '尺寸已限制在 90×90 ~ 900×1200 之间';

/** 三态枚举（hasArtifact / failed / locked）：非法值一律回落到 'any'（spec C3） */
export const TRIPLE_STATES = Object.freeze(['any', 'yes', 'no']);

/** 五维中文名（UI 文案唯一来源） */
export const NODE_FILTER_DIMS = Object.freeze({
  kinds: '类型', groups: '分组', hasArtifact: '有产物', failed: '失败', locked: '锁定',
});

/** 默认（不限）筛选态：默认态必须与现状零差异（spec §3.3 语义示例第 1 行） */
export const DEFAULT_NODE_FILTER = Object.freeze({
  kinds: [], groups: [], hasArtifact: 'any', failed: 'any', locked: 'any', negate: false,
});

/** 支持的批处理动作（顺序 = 工具栏/计划面板的展示顺序） */
export const SUPPORTED_ACTIONS = Object.freeze(['move', 'resize', 'delete', 'group', 'rerun-kinds', 'lock', 'unlock']);

/**
 * 动作元数据表：危险等级 / 是否需确认 / 是否付费 / 是否需审批 / 是否自动快照。
 * `danger`：low < mid < high < max；`emptyReason` = 选区为空时的专属中文提示（G1，按动作细分）。
 */
export const BATCH_ACTIONS = Object.freeze({
  move: {
    id: 'move', label: '批量移动', danger: 'low', paid: false,
    requiresConfirm: false, requiresApproval: false, autoSnapshot: false,
    emptyReason: '请先在画布上选中要处理的节点',
  },
  resize: {
    id: 'resize', label: '批量缩放', danger: 'low', paid: false,
    requiresConfirm: false, requiresApproval: false, autoSnapshot: false,
    emptyReason: '请先在画布上选中要处理的节点',
  },
  delete: {
    id: 'delete', label: '批量删除', danger: 'high', paid: false,
    requiresConfirm: true, requiresApproval: false, autoSnapshot: true,   // S2：会大改内容，强制自动快照
    emptyReason: '请先选中要删除的节点',
  },
  group: {
    id: 'group', label: '批量成组', danger: 'mid', paid: false,
    requiresConfirm: false, requiresApproval: false, autoSnapshot: true,   // S2：会大改包围盒与归属
    emptyReason: '先选中要成组的卡片',
  },
  'rerun-kinds': {
    id: 'rerun-kinds', label: '按类型重跑', danger: 'max', paid: true,
    requiresConfirm: true, requiresApproval: true, autoSnapshot: false,
    emptyReason: '请先在画布上选中要重跑的节点',
  },
  lock: {
    id: 'lock', label: '批量锁定', danger: 'mid', paid: false,
    requiresConfirm: false, requiresApproval: false, autoSnapshot: false,   // S2：锁定切换不打快照
    emptyReason: '请先在画布上选中要处理的节点',
  },
  unlock: {
    id: 'unlock', label: '批量解锁', danger: 'mid', paid: false,
    requiresConfirm: false, requiresApproval: false, autoSnapshot: false,
    emptyReason: '请先在画布上选中要处理的节点',
  },
});

/** 付费重跑必须走完的审批链路（spec §4.6.1 调用顺序，逐步骤固定） */
export const RERUN_APPROVAL_CHAIN = Object.freeze([
  'POST /api/canvas/plan             {canvasId, nodeIds, overwrite} —— 零付费 dry-run 计划',
  'POST /api/execute/plans           {canvasId, operator}            —— 建人工审批单',
  'POST /api/execute/plans/:id/approve {confirm:true, operator}      —— 人工批准',
  '终端打印 6 位确认码（接口只返回掩码）',
  'POST /api/execute/run            {planId, confirmCode}           —— 一次性消费确认码后执行',
]);

/** 批处理**绝对禁止**调用的入口（它们绕过 authorizeRun 闸门，spec R1 硬性禁止） */
export const RERUN_FORBIDDEN_ENDPOINTS = Object.freeze(['/api/canvas/run', '/api/canvas/run-node']);

/** 主画布硬拒的固定文案（单一定义，planDelete 的两条判据共用同一句） */
const MAIN_CANVAS_GUARD_TEXT = '主画布不可删除（它是宫格预览全部演员的入口画布）：请先用筛选缩小选区后再批量删除，或改用「⊕ 放入全部」恢复';

/** 固定中文提示文案（测试按此断言，勿随手改字） */
export const BATCH_MESSAGES = Object.freeze({
  matrixMove: '宫格模式下拖动是「换序」不是移动；批量移动请先切到自由模式（✦）',
  allLockedMove: (n) => `选中的 ${n} 个卡位全部已锁定，无法移动（先解锁）`,
  sizeClamped: SIZE_LIMIT_TEXT,
  deleteLinksWarning: '⚠️ 该操作连带删除的连线无法用「撤销」恢复；需要回退请用「📸 快照」。',
  purgeCrossCanvasWarning: '⚠️ 该操作影响所有画布，快照只保护当前画布。',
  groupNonActor: (n) => `便签/资产/流程节点暂不支持批量成组（已跳过 ${n} 项）`,
  rerunNoExecutable: '选中的节点都是素材源/容器，没有可执行的节点（可执行的类型：关键帧、视频、文本、音频、叠加层、字幕轨、成片时间线、交付终点）',
  rerunLockedNotice: (n) => `其中 ${n} 个节点已锁定：锁定只防误拖，不阻止执行`,
  mainCanvasGuard: MAIN_CANVAS_GUARD_TEXT,
  // RK-L6-01 收口：canvasId 缺省（opts/params/items 三级都取不到）时不得 fail-open 放行整画布删除
  canvasIdRequired: '未提供画布 ID，无法确认是否为主画布，已拒绝整画布批量删除：请传 canvasId（或 canvasTotal）后重试。',
  // R-W3-01 收口：**部分选区**同样不允许「画布身份无法自证」——不传 canvasId / 不传 canvasTotal /
  // 节点 canvas_id 为空时，库层无从判断选区落在哪个画布，删除类动作一律 fail-closed 拒绝。
  canvasIdRequiredPartial: '未提供画布 ID，选区节点自身也没有 canvas_id（无法自证这些卡位属于哪个画布），已拒绝批量删除：请传 canvasId，或先让节点落库（拖动/缩放一次即会写入 canvas_id）后重试。',
  // W7 收口（fail-open 洞②）：调用方**声明**了画布 ID，但选区内存在节点行却没有任何非空 canvas_id
  // 可以对质（例如批量接口只回传了 id/坐标，或节点行是历史脏数据）→ 该声明是孤证，
  // 库层无从排除「这些卡位其实在主画布上」。与 canvasIdRequiredPartial 的区别：那个是「三级都取不到」，
  // 这个是「有声明但无从核验」，故单列一条可审计的中文原因（拒绝码 CANVAS_ID_UNVERIFIED）。
  canvasIdUnverified: (declared) => `调用方声明的画布 ID「${declared || '(空)'}」得不到选区节点印证：选区内的节点都没有 canvas_id（无法核对这些卡位是否真在「${declared || '(空)'}」上，也无法排除它们在主画布上），已拒绝批量删除：请传 canvasTotal（证明本次只删该画布的一部分节点），或先让节点落库（拖动/缩放一次即会写入 canvas_id）后重试。`,
  // R-W3-02 收口：选区内既有主画布节点、又自证/声明了别的画布 → 画布身份不自洽，按主画布硬闸门拒
  // （主句沿用既有主画布硬拒文案，末尾追加可审计的判据说明，便于红队逐字复核）
  mainCanvasGuardMixed: (derived, ids) => `${MAIN_CANVAS_GUARD_TEXT}（本次判据：选区内出现主画布（${MAIN_CANVAS_ID}）节点，但自证/声明的画布是「${derived || '(空)'}」；选区内出现的画布：${ids.join('、')}）`,
  // R-W3-02 附带收口：选区内出现两个及以上不同画布 id（且不含主画布）时，画布身份同样不自洽（快照口径会错位）
  canvasIdConflict: (ids) => `选区里出现了多个不同画布的节点（${ids.join('、')}），无法确认本次删除属于哪个画布（快照只说保护其中之一），已拒绝批量删除：请只勾选同一画布的卡位后重试。`,
  noMatchingNodes: '当前筛选没有匹配的节点；点「⌀ 清除筛选」查看全部',
  nothingSelectable: '当前筛选没有可选的节点',
  filterCleared: '已清除节点筛选',
});

/** 空选区 / 通用提示里反复出现的固定串 */
const EMPTY_SELECTION_REASON = '请先在画布上选中要处理的节点';

// ============================ 2. 小工具（内部） ============================

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const isObj = (v) => Boolean(v) && typeof v === 'object';

/** 归一化 kind 列表：只接受数组；去重、剔非字符串与空串；字符串等非法输入一律当「不限」（spec A12，不抛错） */
function normalizeKindList(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const k of v) {
    if (typeof k !== 'string') continue;
    const t = k.trim();
    if (!t) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

/** 归一化分组列表：'' 是一条正常取值（未分组，spec C5）；null / undefined 等价于 '' */
function normalizeGroupList(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const g of v) {
    const t = (g === null || g === undefined) ? '' : String(g).trim();
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

/** 三态归一：非法值回落 'any'（spec C3） */
function triOf(v) { return (v === 'yes' || v === 'no') ? v : 'any'; }

/** 节点 data（JSON 列）的安全解析：解析失败 / 缺失一律返回 {}，绝不抛错 */
function dataOf(item) {
  if (!isObj(item)) return {};
  const raw = (isObj(item.node) && item.node.data !== undefined && item.node.data !== null)
    ? item.node.data
    : item.data;
  if (isObj(raw)) return raw;
  if (typeof raw === 'string' && raw) {
    try {
      const o = JSON.parse(raw);
      return isObj(o) ? o : {};
    } catch { return {}; }
  }
  return {};
}

/** 数字兜底：非有限数 → fallback */
function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** 标题兜底链：演员名 → 便签首行 → 节点 title → 类型中文名 */
function titleOf(item, kind) {
  const a = isObj(item) ? item.actor : null;
  if (isObj(a) && a.name) return String(a.name);
  const note = isObj(item) ? item.note : null;
  if (isObj(note) && note.note_text) return String(note.note_text).split('\n')[0].slice(0, 20);
  if (isObj(item) && isObj(item.node) && item.node.title) return String(item.node.title);
  return KIND_LABELS[kind] || kind || '节点';
}

/** 把 layout item 归一成批处理内部条目（只读快照，不改原对象） */
function entryOf(item, index) {
  const node = isObj(item) && isObj(item.node) ? item.node : null;
  const kind = nodeKindOf(item);
  const actorId = (isObj(item) && item.actorId) ? String(item.actorId) : '';
  return {
    index,
    kind,
    kindLabel: KIND_LABELS[kind] || kind,
    nodeId: (node && node.id) ? String(node.id) : null,
    // RK-L6-01：只读自证字段（取自 node.canvas_id；幽灵卡位为 ''）。不修改入参 item / node 对象。
    canvasId: node ? String(node.canvas_id || '') : '',
    actorId,
    title: titleOf(item, kind),
    ghost: !(node && node.id),                                  // I2：幽灵卡位（尚未落库）
    locked: isNodeLocked(item),
    groupId: node ? String(node.group_id || '') : nodeGroupOf(item),
    x: num(item?.x, 0),
    y: num(item?.y, 0),
    w: num(item?.w, 0),
    h: num(item?.h, 0),
    z: Math.round(num(node?.z ?? item?.z, 0)),
  };
}

/** 跳过项（供 UI 展示「为什么这项没被处理」） */
function skipOf(e, reason) {
  return {
    index: e.index, kind: e.kind, kindLabel: e.kindLabel, nodeId: e.nodeId,
    actorId: e.actorId, title: e.title, locked: e.locked, ghost: e.ghost, reason,
  };
}

/** 失败计划：保留已算出的上下文，只标 ok=false + code/reason */
function fail(plan, code, reason) {
  plan.ok = false;
  plan.code = code;
  plan.reason = reason;
  if (!plan.summary) plan.summary = describeBatchPlan(plan);
  return plan;
}

/** 是否主画布（硬编码字符串比对，与 src/modules/actors.js 的闸门口径一致） */
export function isMainCanvas(canvasId) {
  return String(canvasId ?? '').trim() === MAIN_CANVAS_ID;
}

/** 非空判定：null / undefined / ''（含纯空白）都算「没给」 */
function isBlankId(v) {
  return v === null || v === undefined || String(v).trim() === '';
}

/**
 * 画布 id **三级自证**（RK-L6-01 收口的核心）：
 *   ① opts.canvasId → ② params.canvasId → ③ 首个非空 items[*].node.canvas_id → ④ 都取不到（'none'）
 * 缺陷背景：原实现只认 ①②，调用方忘传时 canvasId 为 '' → mainCanvas=false →
 * 整画布删除被放行（fail-open，见 strategist/reports/L6-verify.md:425 RT-03 第⑤/⑨b 步）。
 * 因此 ③ 用节点自身的 canvas_id 自证，④ 交给 planDelete 按「缺省必须拒绝而不是放行」硬拒。
 * 纯读取：不修改入参 items / opts / params。
 * @returns {{canvasId:string, canvasSource:'opts'|'params'|'items'|'none'}}
 */
function deriveCanvasId(list, p, o) {
  // R-W3-02 注意：本函数只取「首个非空 canvas_id」作为**默认身份**，因此它单独不足以判定安全性——
  // 混合画布选区（首项非主画布 + 同选区含主画布节点）会掩盖主画布，故另由 canvasIdsOf() 收集全部取值，
  // 由 planDelete 按「选区内出现主画布节点即触发保护 / 身份不自洽即拒绝」收口（见 W3-acceptance.md RT-①-E）。
  if (!isBlankId(o.canvasId)) return { canvasId: String(o.canvasId), canvasSource: 'opts' };
  if (!isBlankId(p.canvasId)) return { canvasId: String(p.canvasId), canvasSource: 'params' };
  const arr = Array.isArray(list) ? list : [];
  for (const it of arr) {
    const n = isObj(it) && isObj(it.node) ? it.node : null;
    if (n && !isBlankId(n.canvas_id)) return { canvasId: String(n.canvas_id), canvasSource: 'items' };
  }
  return { canvasId: '', canvasSource: 'none' };
}

/**
 * 选区画布身份清单（RK-L6-01 补丁 · R-W3-02 收口）：收集 items[*].node.canvas_id 里**全部**非空取值，
 * 去重后按首次出现顺序返回（跳过幽灵卡位的 node===null；纯空白视为「没给」，与 isBlankId 同口径）。
 * 存在的理由：deriveCanvasId 只取首个非空值，混合画布选区能用「首项非主画布」把主画布节点藏起来，
 * 从而绕过 MAIN_CANVAS_GUARD（W3-acceptance.md RT-①-E：DELETE 请求=6 且主画布节点被删）。
 * 纯读取：不修改入参 items。
 * @returns {string[]}
 */
function canvasIdsOf(list) {
  const arr = Array.isArray(list) ? list : [];
  const out = [];
  for (const it of arr) {
    const n = isObj(it) && isObj(it.node) ? it.node : null;
    if (!n || isBlankId(n.canvas_id)) continue;
    const cid = String(n.canvas_id).trim();
    if (cid && !out.includes(cid)) out.push(cid);
  }
  return out;
}

/** 画布节点总数（判定「是否等于删除全部」的依据）：显式入参优先，其次 allItems.length */
function canvasTotalOf(o, p, list) {
  const candidates = [o.canvasTotal, p.canvasTotal, Array.isArray(o.allItems) ? o.allItems.length : null];
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c) && c >= 0) return c;
  }
  return null;
}

/** 确认是否已满足（两段确认要求 confirm:2 或 confirm:true + confirmAgain:true） */
function isConfirmSatisfied(plan, confirm, confirmAgain) {
  if (!plan || !plan.requiresConfirm) return true;
  const stages = Array.isArray(plan.confirmStages) ? plan.confirmStages : [];
  if (stages.length >= 2) {
    if (confirm === 2 || confirm === '2') return true;
    return confirm === true && confirmAgain === true;
  }
  return confirm === true;
}

// ============================ 3. 筛选谓词（AC-1） ============================

/** 节点类型：`canvas_nodes.kind || 'actor'`（兜底口径与 src/modules/actors.js:269 一致） */
export function nodeKindOf(item) {
  const k = isObj(item) ? item.kind : '';
  return (typeof k === 'string' && k) ? k : 'actor';
}

/** 节点分组 id：'' = 未分组（`group_id` 为 NULL/'' 都归一为 ''） */
export function nodeGroupOf(item) {
  const g = isObj(item) ? item.groupId : '';
  return (g === null || g === undefined) ? '' : String(g);
}

/** 是否锁定：`canvas_nodes.locked` 的 0/1（Boolean 化） */
export function isNodeLocked(item) {
  return Boolean(isObj(item) ? item.locked : false);
}

/** 运行态：`data.status`（done | running | error | skipped；缺省 = 未执行） */
export function nodeStatusOf(item) {
  const s = dataOf(item).status;
  return (typeof s === 'string') ? s : '';
}

/** 是否执行失败：**只认 'error'**（'failed' 取值不存在，勿臆造） */
export function isNodeFailed(item) {
  return nodeStatusOf(item) === 'error';
}

/**
 * 是否有产物（spec §2.7 判定表的唯一实现）—— 按 kind 分流：
 *   actor → Boolean(actor.cover_image)；note → 恒 false；
 *   scene/item/refimg → asset.refImages 非空；其余流程型 → data.lastFile 非空。
 */
export function hasArtifactOf(item) {
  const kind = nodeKindOf(item);
  if (kind === 'actor') return Boolean(item?.actor?.cover_image);
  if (kind === 'note') return false;
  if (kind === 'scene' || kind === 'item' || kind === 'refimg') {
    return Array.isArray(item?.asset?.refImages) && item.asset.refImages.length > 0;
  }
  return Boolean(dataOf(item).lastFile);
}

/**
 * 归一化筛选规格：去重、剔非法值、补默认值；**永不抛错**（UI 直接喂用户输入）。
 * 未知的 kind 字符串会被保留（前后端 kind 全集可能短暂不同步），只剔除非字符串与空串。
 * @returns {{kinds:string[], groups:string[], hasArtifact:'any'|'yes'|'no', failed:'any'|'yes'|'no', locked:'any'|'yes'|'no', negate:boolean}}
 */
export function normalizeNodeFilter(spec = {}) {
  const src = isObj(spec) && !Array.isArray(spec) ? spec : {};
  return {
    kinds: normalizeKindList(src.kinds),
    groups: normalizeGroupList(src.groups),
    hasArtifact: triOf(src.hasArtifact),
    failed: triOf(src.failed),
    locked: triOf(src.locked),
    negate: src.negate === true,
  };
}

/** 单维度判定（维度内 OR、空数组=不限、'any'=不限） */
function dimensionMatch(item, dim, s) {
  switch (dim) {
    case 'kinds': return s.kinds.length === 0 ? true : s.kinds.includes(nodeKindOf(item));
    case 'groups': return s.groups.length === 0 ? true : s.groups.includes(nodeGroupOf(item));
    case 'hasArtifact': return s.hasArtifact === 'any' ? true : (hasArtifactOf(item) === (s.hasArtifact === 'yes'));
    case 'failed': return s.failed === 'any' ? true : (isNodeFailed(item) === (s.failed === 'yes'));
    case 'locked': return s.locked === 'any' ? true : (isNodeLocked(item) === (s.locked === 'yes'));
    default: return true;
  }
}

/**
 * 单条判定：五维 AND（C1）→ 最后按 negate 整体取反（C4，**不是**逐维取反）。
 * 非法 spec 会被 normalizeNodeFilter 归一到默认态，因此本函数永不抛错。
 */
export function matchNodeFilter(item, spec = DEFAULT_NODE_FILTER) {
  const s = normalizeNodeFilter(spec);
  if (!isObj(item)) return false;
  const hit = dimensionMatch(item, 'kinds', s)
    && dimensionMatch(item, 'groups', s)
    && dimensionMatch(item, 'hasArtifact', s)
    && dimensionMatch(item, 'failed', s)
    && dimensionMatch(item, 'locked', s);
  return s.negate ? !hit : hit;
}

/**
 * `matchNodeFilter` 的别名函数（任务卡 T-205 要求的导出名）。
 * 与 `matchNodeFilter` 完全等价，保留两个名字是为了同时满足任务卡与 T-103 契约的导出清单。
 */
export function matchFilter(item, spec = DEFAULT_NODE_FILTER) {
  return matchNodeFilter(item, spec);
}

/**
 * 批量筛选：保持入参顺序、不改入参、返回新数组。
 * 默认态（不限）下必须与现状零差异（spec B1）。
 */
export function filterItems(items = [], spec = DEFAULT_NODE_FILTER) {
  const list = Array.isArray(items) ? items : [];
  const s = normalizeNodeFilter(spec);
  return list.filter((it) => matchNodeFilter(it, s));
}

/**
 * 中文摘要（HUD 用）：如「筛选：视频片段/关键帧（出图） · 有产物 · 未锁定（12/48）」。
 * 默认态返回「筛选：不限（12/48）」。
 */
export function describeNodeFilter(spec, total = 0, matched = 0) {
  const s = normalizeNodeFilter(spec);
  const parts = [];
  if (s.kinds.length) parts.push(s.kinds.map((k) => KIND_LABELS[k] || k).join('/'));
  if (s.groups.length) parts.push(`分组：${s.groups.map((g) => (g === '' ? '未分组' : g)).join('/')}`);
  if (s.hasArtifact !== 'any') parts.push(s.hasArtifact === 'yes' ? '有产物' : '无产物');
  if (s.failed !== 'any') parts.push(s.failed === 'yes' ? '已失败' : '无失败');
  if (s.locked !== 'any') parts.push(s.locked === 'yes' ? '已锁定' : '未锁定');
  const body = parts.length ? parts.join(' · ') : '不限';
  const head = s.negate ? `反选：${body}` : body;
  const t = Math.max(0, Math.round(num(total, 0)));
  const m = Math.max(0, Math.round(num(matched, 0)));
  const tail = t > 0 ? `（${m}/${t}）` : (m > 0 ? `（${m}）` : '');
  return `筛选：${head}${tail}`;
}

/**
 * 工具栏 chips：每个生效维度一片（含命中数），供渲染与「一键清除」。
 * count = **仅按该维度**在 items 上的命中数（负向维度显示的是「命中该维度」的条数）；
 * 反选片（dim:'negate'）的 count 才是**整份筛选**的命中数。
 * @returns {Array<{dim:string, key:string, label:string, count:number, active:boolean}>}
 */
export function nodeFilterChips(spec, items = []) {
  const s = normalizeNodeFilter(spec);
  const list = Array.isArray(items) ? items : [];
  const countBy = (fn) => list.reduce((n, it) => n + (fn(it) ? 1 : 0), 0);
  const chips = [];
  if (s.kinds.length) {
    chips.push({
      dim: 'kinds', key: 'kinds',
      label: `类型：${s.kinds.map((k) => KIND_LABELS[k] || k).join('/')}`,
      count: countBy((it) => s.kinds.includes(nodeKindOf(it))), active: true,
    });
  }
  if (s.groups.length) {
    chips.push({
      dim: 'groups', key: 'groups',
      label: `分组：${s.groups.map((g) => (g === '' ? '未分组' : g)).join('/')}`,
      count: countBy((it) => s.groups.includes(nodeGroupOf(it))), active: true,
    });
  }
  const triDims = [['hasArtifact', '有产物', '无产物'], ['failed', '已失败', '无失败'], ['locked', '已锁定', '未锁定']];
  for (const [dim, yesLabel, noLabel] of triDims) {
    if (s[dim] === 'any') continue;
    chips.push({
      dim, key: s[dim], label: s[dim] === 'yes' ? yesLabel : noLabel,
      count: countBy((it) => dimensionMatch(it, dim, s)), active: true,
    });
  }
  if (s.negate) {
    chips.push({ dim: 'negate', key: 'negate', label: '反选', count: filterItems(list, s).length, active: true });
  }
  return chips;
}

// ============================ 4. 批处理：动作计划（AC-2） ============================

/** 尺寸夹紧（照抄既有单卡的 90×90 ~ 900×1200 口径，不另立标准） */
export function clampNodeSize(w, h) {
  const rw = Math.round(num(w, 0));
  const rh = Math.round(num(h, 0));
  const cw = clamp(rw, SIZE_LIMITS.minW, SIZE_LIMITS.maxW);
  const ch = clamp(rh, SIZE_LIMITS.minH, SIZE_LIMITS.maxH);
  return { w: cw, h: ch, clamped: cw !== rw || ch !== rh };
}

/** 建计划骨架 */
function makePlanBase(id, meta, list, p, o) {
  // RK-L6-01：canvasId 三级自证（opts → params → 首个非空 items[*].node.canvas_id），并记录来源 canvasSource
  const { canvasId, canvasSource } = deriveCanvasId(list, p, o);
  // R-W3-02：选区内**全部**非空 canvas_id（去重），用于识别「混合画布选区」与「选区内含主画布节点」
  const selectionCanvasIds = canvasIdsOf(list);
  const requiresConfirm = Boolean(meta?.requiresConfirm);
  return {
    ok: false,
    code: 'OK',
    action: id,
    label: meta?.label || id,
    danger: meta?.danger || 'low',
    paid: Boolean(meta?.paid),
    requiresConfirm,
    requiresApproval: Boolean(meta?.requiresApproval),
    autoSnapshot: Boolean(meta?.autoSnapshot),
    snapshotLabel: meta?.label || id,
    undoable: id !== 'rerun-kinds',                 // U4：rerun-kinds 不入撤销栈
    canvasId,
    canvasName: String(o.canvasName || p.canvasName || ''),
    mainCanvas: isMainCanvas(canvasId),
    canvasSource,                                   // RK-L6-01：canvasId 的来源（'opts' | 'params' | 'items' | 'none'）
    // ---- R-W3-02 收口用的三条判据（均由选区节点自身自证，不受「首个非空」偏序影响）----
    selectionCanvasIds,                             // 选区里出现的全部非空画布 id（去重、保序）
    selectionHasMainCanvas: selectionCanvasIds.some((c) => isMainCanvas(c)),   // 选区内是否出现主画布节点
    mixedCanvasSelection: selectionCanvasIds.length > 1,                       // 选区是否跨画布（身份不自洽）
    viewMode: String(o.mode || p.mode || ''),        // 视图模式（matrix | free）；只有批量移动会校验
    itemCount: list.length,                          // applyBatchPlan 的一致性凭据
    entries: [],
    skippedEntries: [],
    effects: [],
    plannedEffects: [],
    notices: [],
    messages: [],
    confirmStages: [],
    confirmText: '',
    confirmMode: 'single',
    needsConfirm: requiresConfirm,
    confirmed: !requiresConfirm,
    affected: 0,
    skipped: 0,
    summary: '',
    warning: '',
    includeLocked: false,
  };
}

/** 按类型把几何变更翻译成接口调用（三条硬约束在此落地，spec §4.0） */
function pushGeometryEffects(plan, entries) {
  const actors = entries.filter((e) => e.kind === 'actor');
  const notes = entries.filter((e) => e.kind === 'note');
  const assets = entries.filter((e) => e.kind !== 'actor' && e.kind !== 'note');
  if (actors.length) {
    plan.effects.push({
      method: 'POST',
      path: '/api/canvas/nodes',
      target: 'actor',
      count: actors.length,
      body: {
        nodes: actors.map((e) => ({
          canvas_id: plan.canvasId || MAIN_CANVAS_ID,
          actor_id: e.actorId,                       // 必须用 actor_id，不能用 item.id（'actor:xxx' 不是主键）
          x: e.to.x, y: e.to.y, w: e.to.w, h: e.to.h, z: e.z, locked: e.locked ? 1 : 0,
        })),
      },
      note: '按 actor_id 匹配（幽灵卡位会自动 INSERT）；actor_id 为空的行会被后端静默丢弃',
    });
  }
  for (const e of notes) {
    plan.effects.push({
      method: 'PUT',
      path: `/api/canvas/notes/${e.nodeId}`,
      target: 'note',
      count: 1,
      body: { x: e.to.x, y: e.to.y, w: e.to.w, h: e.to.h, z: e.z },
      note: '便签几何走 updateNote；不得走 POST /api/canvas/nodes（actor_id 为空会被静默丢弃）',
    });
  }
  for (const e of assets) {
    plan.effects.push({
      method: 'PUT',
      path: `/api/canvas/assets/${e.nodeId}`,
      target: 'asset',
      count: 1,
      body: { x: e.to.x, y: e.to.y, w: e.to.w, h: e.to.h, z: e.z },
      note: '资产/流程节点几何走 updateAsset（非 CREATABLE_KINDS 会被后端拒绝）',
    });
  }
}

/** 幽灵卡位物化（仅在需要真实节点行时使用，例如成组的包围盒计算） */
function pushGhostMaterializeEffect(plan, ghosts) {
  if (!ghosts.length) return;
  plan.effects.push({
    method: 'POST',
    path: '/api/canvas/node',
    target: 'actor',
    count: ghosts.length,
    body: ghosts.map((e) => ({
      canvas_id: plan.canvasId || MAIN_CANVAS_ID,
      actor_id: e.actorId, x: e.to.x, y: e.to.y, w: e.to.w, h: e.to.h,
    })),
    note: '先物化幽灵卡位（I2）：createGroup 按 canvas_nodes 行算包围盒，无行则包围盒算错',
  });
}

/** 几何动作的通用可用性过滤：actor 必须有 actor_id，非 actor 必须是 CREATABLE_KINDS */
function splitWritable(plan, entries) {
  const writable = [];
  for (const e of entries) {
    if (e.kind === 'actor') {
      if (!e.actorId) { plan.skippedEntries.push(skipOf(e, '缺少 actor_id，无法落库（幽灵卡位必须以 actor_id 为键）')); continue; }
      writable.push(e);
      continue;
    }
    if (e.kind === 'note') { writable.push(e); continue; }
    if (!CREATABLE_KINDS.includes(e.kind)) {
      plan.skippedEntries.push(skipOf(e, `类型「${e.kindLabel}」不是可编辑的素材/流程节点，后端会拒绝（已跳过）`));
      continue;
    }
    writable.push(e);
  }
  return writable;
}

/** 锁定项分流：返回 [可处理, 被锁定跳过的] */
function splitLocked(entries, includeLocked) {
  if (includeLocked) return [entries.slice(), []];
  const keep = [];
  const lockedOut = [];
  for (const e of entries) (e.locked ? lockedOut : keep).push(e);
  return [keep, lockedOut];
}

/** 动作：批量移动 */
function planMove(ctx) {
  const { plan, all, p, o } = ctx;
  const dx = Number(p.dx);
  const dy = Number(p.dy);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
    return fail(plan, 'BAD_PARAMS', `移动增量必须是有限数值（dx=${p.dx}，dy=${p.dy}）`);
  }
  if (dx === 0 && dy === 0) return fail(plan, 'BAD_PARAMS', '移动增量不能为 0（dx / dy 至少一个非 0）');
  if (String(o.mode || p.mode || '') === 'matrix') return fail(plan, 'MATRIX_MODE', BATCH_MESSAGES.matrixMove);

  const includeLocked = o.includeLocked === true || p.includeLocked === true;
  plan.includeLocked = includeLocked;
  const lockedCount = all.filter((e) => e.locked).length;
  const [movable, lockedOut] = splitLocked(all, includeLocked);
  if (!movable.length) return fail(plan, 'ALL_LOCKED', BATCH_MESSAGES.allLockedMove(all.length));

  for (const e of movable) e.to = { x: e.x + dx, y: e.y + dy, w: e.w, h: e.h };
  const writable = splitWritable(plan, movable);
  for (const e of lockedOut) plan.skippedEntries.push(skipOf(e, '已锁定（未勾选「包含已锁定」）'));
  if (includeLocked && lockedCount) plan.notices.push(`已勾选「包含已锁定」：其中 ${lockedCount} 项已锁定也会一起移动`);
  // H6：批量移动与「拖拽落点自动归组」刻意不同 —— 不触发任何 group_id 变更
  plan.notices.push('批量移动不触发自动归组（与拖拽落点自动归组不同）；需要归组请用「批量成组」');

  plan.entries = writable;
  plan.dx = dx;
  plan.dy = dy;
  plan.affected = writable.length;
  pushGeometryEffects(plan, writable);
  plan.messages.push(`已移动 ${writable.length} 个节点${lockedOut.length ? `，跳过 ${lockedOut.length} 个已锁定` : ''}`);
  plan.ok = true;
  return plan;
}

/** 动作：批量缩放 */
function planResize(ctx) {
  const { plan, all, p, o } = ctx;
  const hasW = p.w !== undefined && p.w !== null;
  const hasH = p.h !== undefined && p.h !== null;
  const hasScale = p.scale !== undefined && p.scale !== null;
  if (!hasW && !hasH && !hasScale) {
    return fail(plan, 'BAD_PARAMS', '缩放必须给出 w / h（绝对尺寸）或 scale（相对系数）');
  }
  if (hasW && !Number.isFinite(Number(p.w))) return fail(plan, 'BAD_PARAMS', `宽度必须是有限数值（w=${p.w}）`);
  if (hasH && !Number.isFinite(Number(p.h))) return fail(plan, 'BAD_PARAMS', `高度必须是有限数值（h=${p.h}）`);
  const scale = hasScale ? Number(p.scale) : null;
  if (hasScale && (!Number.isFinite(scale) || scale <= 0)) {
    return fail(plan, 'BAD_PARAMS', `缩放系数必须是大于 0 的有限数值（scale=${p.scale}）`);
  }

  const includeLocked = o.includeLocked === true || p.includeLocked === true;
  plan.includeLocked = includeLocked;
  const [resizable, lockedOut] = splitLocked(all, includeLocked);
  if (!resizable.length) {
    return fail(plan, 'ALL_LOCKED', `选中的 ${all.length} 个卡位全部已锁定，无法缩放（先解锁）`);
  }

  let clampedAny = false;
  for (const e of resizable) {
    const w0 = hasW ? Number(p.w) : (hasScale ? Math.round(e.w * scale) : e.w);
    const h0 = hasH ? Number(p.h) : (hasScale ? Math.round(e.h * scale) : e.h);
    const c = clampNodeSize(w0, h0);
    if (c.clamped) clampedAny = true;
    e.to = { x: e.x, y: e.y, w: c.w, h: c.h };
  }
  const writable = splitWritable(plan, resizable);
  for (const e of lockedOut) plan.skippedEntries.push(skipOf(e, '已锁定（未勾选「包含已锁定」）'));
  if (clampedAny) plan.notices.push(BATCH_MESSAGES.sizeClamped);   // 越界夹紧并提示，不报错中止
  if (hasScale) plan.notices.push('相对缩放按「当前尺寸 × scale」四舍五入后再夹紧；批量统一尺寸请用既有的「统一尺寸」入口');

  plan.entries = writable;
  plan.affected = writable.length;
  pushGeometryEffects(plan, writable);
  plan.messages.push(`已缩放 ${writable.length} 个节点${lockedOut.length ? `，跳过 ${lockedOut.length} 个已锁定` : ''}`);
  plan.ok = true;
  return plan;
}

/** 动作：批量删除（★ 危险；detach 移出画布 / purge 删演员档案） */
function planDelete(ctx) {
  const { plan, all, p, o, list } = ctx;
  const rawMode = String(p.mode || o.deleteMode || '').trim();
  let mode = rawMode;
  if (!mode) {
    mode = 'detach';                                             // 默认走最安全的一种
    plan.modeAssumed = true;
    plan.notices.push('未指定删除模式，已按最安全的「移出画布」处理（演员档案与定妆图不受影响）');
  }
  if (mode !== 'detach' && mode !== 'purge') {
    return fail(plan, 'BAD_PARAMS', `删除模式只能是 'detach'（移出画布）或 'purge'（删除演员档案）：收到 ${rawMode}`);
  }
  // scope 是「对选区的声明」，不是另一个数据源：'all' = 调用方已确认「本次选区就是该画布的全部节点」
  // （数据仍来自 items，便于预览与计数），用于两段确认与主画布硬闸门；'selection' = 只处理选区（默认）。
  const scope = String(p.scope || o.scope || 'selection').trim() || 'selection';
  if (scope === 'canvas') {
    // V1：批处理永远不允许删除画布本身（后端另有硬闸门）
    return fail(plan, 'CANVAS_DELETE_FORBIDDEN', '批处理不允许删除画布：主画布由后端硬闸门保护，其他画布请走画布栏入口');
  }
  if (scope !== 'selection' && scope !== 'all') {
    return fail(plan, 'BAD_PARAMS', `删除范围只能是 'selection'（当前选区）或 'all'（整画布清空）：收到 ${scope}`);
  }

  const total = canvasTotalOf(o, p, list);
  const coversAll = scope === 'all' || (total !== null && total > 0 && list.length >= total);
  // W7 收口 · fail-open 洞②（任务书 :319 附近）：调用方声明的 canvasId 只是**孤证**时不得放行。
  // 判据：选区里存在节点行（非幽灵卡位），却没有任何非空 canvas_id 可以对质（selectionCanvasIds 为空），
  // 同时又拿不到「选区只是子集」的证明（subsetProven=false）。此时库层无从排除「这其实是主画布的整批
  // 删除」——调用方谎报 canvasId='CV-2' 即可把主画布上的全部卡位当成普通画布选区删掉
  // （W7 实测：ok=true affected=5 DELETE 请求=10）。纯幽灵卡位（没有节点行）不算孤证，交给 NOTHING_TO_DO。
  const subsetProven = total !== null && total > list.length;   // 「canvasTotal > 选区长度」= 选区是严格子集
  // RK-L6-01：canvasId 三级都取不到（canvasSource==='none'）时，整画布删除必须 fail-closed **拒绝**，
  // 不得因为「拿不到画布 id」就把 mainCanvas 判成 false 而放行（原缺陷见 strategist/reports/L6-verify.md:425）。
  // R-W3-01（W3 红队 RT-①-D，本卡修复）：原判据挂在 coversAll 上，于是「不传 canvasId + 不传 canvasTotal +
  // 节点 canvas_id 为空」时 total===null → coversAll=false → 整画布删除被当成普通选区放行
  // （实测 ok=true affected=5 DELETE 请求=10）。删除类动作一旦**无法自证画布身份**，
  // 库层就无从区分「选区」与「整画布」，故此处不看 coversAll，一律硬拒（中文码 + 中文原因）。
  if (plan.canvasSource === 'none') {
    return fail(plan, 'CANVAS_ID_REQUIRED',
      coversAll ? BATCH_MESSAGES.canvasIdRequired : BATCH_MESSAGES.canvasIdRequiredPartial);
  }
  // AC-3：主画布禁止批量删除「全部」（等同清空）—— 硬拒，连确认都不给
  // W7 收口 · fail-open 洞①（任务书 :787 附近）：「选区是不是整画布」原先只认 coversAll，而 coversAll 的
  // 两个证据（scope / canvasTotal）都来自调用方 → 「选区恰好就是主画布的全部节点，但不传 canvasTotal、
  // 也不声明 scope='all'」时 coversAll=false，主画布硬闸门被绕过（W7 实测：ok=true affected=5
  // DELETE 请求=10，确认后主画布 5 个卡位被整批删除）。故主画布上改为只认**反向证明**：
  // 只有拿到「canvasTotal > 选区长度」（选区确实是严格子集）才放行；证明不了就一律按整画布等价处理。
  if (plan.mainCanvas && (coversAll || !subsetProven)) return fail(plan, 'MAIN_CANVAS_GUARD', BATCH_MESSAGES.mainCanvasGuard);
  // R-W3-02（W3 红队 RT-①-E，本卡修复）：判据从「自证 id 是主画布」扩到「**选区内出现主画布节点**」。
  // 原实现只取首个非空 canvas_id，混合画布选区（首项 'CV-2' + 同选区 2 个 'CV-MAIN'）自证出 mainCanvas=false，
  // 于是 scope='all' 的整画布删除绕过了 MAIN_CANVAS_GUARD（实测 affected=3 DELETE 请求=6）。
  // 只要选区内出现主画布节点、而声明/自证的画布却不是主画布 → 画布身份不自洽 → 按主画布硬闸门拒绝。
  if (plan.selectionHasMainCanvas && !plan.mainCanvas) {
    return fail(plan, 'MAIN_CANVAS_GUARD',
      BATCH_MESSAGES.mainCanvasGuardMixed(plan.canvasId, plan.selectionCanvasIds));
  }
  // R-W3-02 附带：选区跨了多个**非主画布**时身份同样不自洽（快照只保护其中一张画布，删另一张画布的节点无法回退）→ 同样硬拒
  if (plan.mixedCanvasSelection) {
    return fail(plan, 'CANVAS_ID_CONFLICT', BATCH_MESSAGES.canvasIdConflict(plan.selectionCanvasIds));
  }
  // W7 收口 · fail-open 洞②（任务书 :319 附近）：调用方声明的 canvasId 得不到选区节点印证 → 孤证不可采信。
  // 位置刻意排在主画布硬闸门与混合画布判定**之后**（那两条的拒绝码语义更强、更可读）：
  // 走到这里说明声明的画布不是主画布、选区内也没有主画布节点（无对质材料），且拿不到「选区是严格子集」
  // 的证明（subsetProven=false）→ 无法排除「谎报成非主画布后整批删除主画布卡位」这种绕过。
  // 反向护栏：纯幽灵卡位（没有节点行）不触发本判据；给了 canvasTotal > 选区长度 的部分删除不触发本判据。
  if (plan.selectionCanvasIds.length === 0 && all.some((e) => e.ghost !== true) && !subsetProven) {
    return fail(plan, 'CANVAS_ID_UNVERIFIED', BATCH_MESSAGES.canvasIdUnverified(plan.canvasId));
  }

  const includeLocked = o.includeLocked === true || p.includeLocked === true;
  plan.includeLocked = includeLocked;
  const lockedCount = all.filter((e) => e.locked).length;
  const [candidates, lockedOut] = splitLocked(all, includeLocked);
  for (const e of lockedOut) plan.skippedEntries.push(skipOf(e, '已锁定（未勾选「包含已锁定」）'));
  if (!candidates.length) {
    return fail(plan, 'ALL_LOCKED', `选中的 ${all.length} 个卡位全部已锁定，无法删除（先解锁或勾选「包含已锁定」）`);
  }

  const deletable = [];
  for (const e of candidates) {
    if (e.ghost && mode === 'detach') {
      plan.skippedEntries.push(skipOf(e, '该卡位尚未落库（幽灵卡位），没有可删除的节点行'));
      continue;
    }
    deletable.push(e);
  }
  if (!deletable.length) {
    return fail(plan, 'NOTHING_TO_DO', '选中的卡位都尚未落库（幽灵卡位），没有可删除的节点行');
  }

  const actorEntries = deletable.filter((e) => e.kind === 'actor' && e.actorId);
  const others = deletable.filter((e) => !(e.kind === 'actor' && e.actorId));
  plan.deleteMode = mode;
  plan.scope = scope;
  plan.affected = deletable.length;

  if (mode === 'purge') {
    if (others.length) {
      plan.notices.push(`purge 只对演员卡生效；其余 ${others.length} 项（便签/资产/流程节点）将按「移出画布」处理`);
    }
    for (const e of actorEntries) {
      plan.effects.push({
        method: 'DELETE',
        path: `/api/actors/${e.actorId}`,
        target: 'actor',
        count: 1,
        note: 'deleteActor 已连带清理所有画布上的连线；影响面超出当前画布，无法用快照保护',
      });
    }
    for (const e of others) {
      plan.effects.push({
        method: 'DELETE', path: `/api/canvas/nodes/${e.nodeId}/links`, target: e.kind, count: 1,
        note: '先清连线（removeCanvasNode 不清连线）',
      });
      plan.effects.push({
        method: 'DELETE', path: `/api/canvas/node/${e.nodeId}`, target: e.kind, count: 1,
        note: '再删节点（非演员节点按「移出画布」处理）',
      });
    }
    plan.messages.push(`已删除 ${actorEntries.length} 位演员档案（不可撤销恢复）${others.length ? `，另有 ${others.length} 项已移出画布` : ''}`);
    plan.warning = BATCH_MESSAGES.purgeCrossCanvasWarning;
    const names = actorEntries.slice(0, 5).map((e) => e.title).join('、');
    plan.confirmStages = [
      `确认删除 ${actorEntries.length} 位演员${names ? `（${names}${actorEntries.length > 5 ? ' 等' : ''}）` : ''}？其定妆图记录也会一并删除。`,
      '再次确认：这将永久删除演员档案，不可通过「撤销」恢复。',
    ];
  } else {
    for (const e of deletable) {
      plan.effects.push({
        method: 'DELETE', path: `/api/canvas/nodes/${e.nodeId}/links`, target: e.kind, count: 1,
        note: '先清连线：removeCanvasNode 只删一行，不清理 canvas_links',
      });
      plan.effects.push({
        method: 'DELETE', path: `/api/canvas/node/${e.nodeId}`, target: e.kind, count: 1,
        note: '再删节点（仅本画布；演员档案与定妆图不受影响）',
      });
    }
    plan.messages.push(`已移除 ${deletable.length} 个卡位${lockedOut.length ? `，跳过 ${lockedOut.length} 个已锁定` : ''}`);
    const where = plan.canvasName ? `「${plan.canvasName}」` : '本画布';
    plan.confirmStages = [`把选中的 ${deletable.length} 个卡位从${where}移除？演员档案与定妆图不受影响。`];
    if (plan.mainCanvas || scope === 'all') {
      plan.confirmStages.push(plan.mainCanvas
        ? '再次确认：主画布是「宫格预览全部演员」的入口画布；需要恢复请用「⊕ 放入全部」。'
        : '再次确认：清空画布的全部卡位与关系线？');
    }
  }

  plan.entries = deletable;
  if (includeLocked && lockedCount) plan.notices.push(`其中 ${lockedCount} 项已锁定：确认要一并删除吗？`);
  if (plan.mainCanvas && mode === 'detach') plan.notices.push('主画布上移除卡位后，可用「⊕ 放入全部」恢复');
  plan.warning = plan.warning
    ? `${plan.warning}\n${BATCH_MESSAGES.deleteLinksWarning}`
    : BATCH_MESSAGES.deleteLinksWarning;
  plan.ok = true;
  return plan;
}

/** 动作：批量成组（仅演员卡可直接入组；后端 group_id 写入口只按 actor_id 匹配） */
function planGroup(ctx) {
  const { plan, all, p } = ctx;
  const name = p.name === undefined || p.name === null ? '' : String(p.name).trim();
  const color = p.color === undefined || p.color === null ? '' : String(p.color).trim();

  const actors = all.filter((e) => e.kind === 'actor' && e.actorId);
  const rejected = all.filter((e) => !(e.kind === 'actor' && e.actorId));
  if (!actors.length) return fail(plan, 'NO_ACTOR', '选中的项都不是演员卡，无法成组（仅演员卡可入组）');

  for (const e of rejected) plan.skippedEntries.push(skipOf(e, '便签/资产/流程节点暂不支持批量成组'));
  if (rejected.length) plan.notices.push(BATCH_MESSAGES.groupNonActor(rejected.length));
  const regroup = actors.filter((e) => e.groupId);
  if (regroup.length) plan.notices.push(`${regroup.length} 项已在其他分组，将移入新分组`);

  const ghosts = actors.filter((e) => e.ghost);
  if (ghosts.length) {
    plan.notices.push(`其中 ${ghosts.length} 项尚未落库（幽灵卡位）：将先物化再成组，否则包围盒算错`);
    for (const e of ghosts) e.to = { x: e.x, y: e.y, w: e.w, h: e.h };
  }
  pushGhostMaterializeEffect(plan, ghosts);
  plan.effects.push({
    method: 'POST',
    path: '/api/canvas/groups',
    target: 'group',
    count: actors.length,
    body: { canvas_id: plan.canvasId || MAIN_CANVAS_ID, name, color, actorIds: actors.map((e) => e.actorId) },
    note: 'createGroup 一次调用同时完成建框 + 入组，并自动重新贴合包围盒；name 缺省时后端自动命名「分组 N」',
  });

  plan.entries = actors;
  plan.affected = actors.length;
  plan.groupName = name || '新分组';
  const shown = plan.groupName;
  plan.messages.push(`已把 ${actors.length} 张卡片组成「${shown}」`);
  plan.ok = true;
  return plan;
}

/** 动作：按类型重跑（★★ 最高危险：唯一产生真实费用的动作） */
function planRerunByKind(ctx) {
  const { plan, all, p, o } = ctx;
  const kinds = normalizeKindList(p.kinds);
  const overwrite = p.overwrite === true;

  const exec = [];
  const typeFiltered = [];
  const nonExec = [];
  for (const e of all) {
    if (!EXECUTABLE_KINDS.includes(e.kind)) { nonExec.push(e); continue; }
    if (kinds.length && !kinds.includes(e.kind)) { typeFiltered.push(e); continue; }
    exec.push(e);
  }
  for (const e of nonExec) plan.skippedEntries.push(skipOf(e, '素材源 / 容器不参与执行（可执行类型见提示）'));
  for (const e of typeFiltered) plan.skippedEntries.push(skipOf(e, '未勾选该类型（本次勾选：' + kinds.map((k) => KIND_LABELS[k] || k).join('/') + '）'));
  if (nonExec.length) {
    plan.notices.push(`${nonExec.length} 个节点是素材源（演员/环境/物品/参考图/便签）或容器（分镜），不参与执行，已跳过`);
  }
  if (!exec.length) {
    const reason = kinds.length
      ? `勾选的类型里没有可执行的节点（可执行的类型：关键帧、视频、文本、音频、叠加层、字幕轨、成片时间线、交付终点）`
      : BATCH_MESSAGES.rerunNoExecutable;
    return fail(plan, 'NO_EXECUTABLE', reason);
  }

  // R3–R7：队列暂停 / 磁盘配额 / 月度预算 / 环形依赖 / 计划非空 由服务端裁决，
  // 前端把后端返回的中文原因原样透传（本模块不发请求）。
  const blocked = o.blockedReason || p.blockedReason || '';
  if (blocked) return fail(plan, 'SERVER_BLOCKED', String(blocked));

  const runnable = [];
  for (const e of exec) {
    if (!e.nodeId) {
      plan.skippedEntries.push(skipOf(e, '尚未落库的卡位没有节点 id，无法执行（先拖动/缩放一次即会落库）'));
      continue;
    }
    runnable.push(e);
  }
  if (!runnable.length) return fail(plan, 'NOTHING_TO_DO', '选区里没有已落库的可执行节点（幽灵卡位先落库后再重跑）');

  if (!kinds.length) plan.notices.push('未指定类型：将处理选区里全部可执行节点');
  if (overwrite) plan.notices.push('已勾选「强制重跑」：输入未变的节点也会重新算，会产生真实费用');
  const lockedCount = runnable.filter((e) => e.locked).length;
  if (lockedCount) plan.notices.push(BATCH_MESSAGES.rerunLockedNotice(lockedCount));   // H11
  plan.notices.push('队列暂停 / 磁盘配额 / 月度预算 / 环形依赖由服务端在提交时复核（preflightBatch / planGraph），前端只透传中文原因');
  plan.notices.push('执行并发强制为 1（下游依赖上游产物），批处理重跑不得试图提高并发');

  const nodeIds = runnable.map((e) => e.nodeId);
  plan.entries = runnable;
  plan.affected = runnable.length;
  plan.nodeIds = nodeIds;
  plan.kinds = kinds.length ? kinds.slice() : EXECUTABLE_KINDS.slice();
  plan.overwrite = overwrite;
  plan.approvalChain = RERUN_APPROVAL_CHAIN.slice();
  plan.forbiddenEndpoints = RERUN_FORBIDDEN_ENDPOINTS.slice();
  plan.effects.push({
    method: 'POST',
    path: '/api/canvas/plan',
    target: 'graph',
    count: 1,
    body: { canvasId: plan.canvasId || MAIN_CANVAS_ID, nodeIds, overwrite },
    note: '零付费：只出计划（planGraph）。之后必须走人工审批 + 终端确认码；严禁调用 /api/canvas/run 与 /api/canvas/run-node',
    requiresApproval: true,
  });
  plan.confirmStages = [
    `提交重跑计划（${runnable.length} 个可执行节点${overwrite ? ' / 强制重跑' : ''}）？该动作会产生真实费用：需要人工批准并在终端取 6 位确认码后才会执行。`,
  ];
  plan.messages.push(`已生成重跑计划（${runnable.length} 个节点）；请人工批准并在终端取确认码后执行`);
  plan.ok = true;
  return plan;
}

/** 动作：批量锁定 / 解锁 */
function planSetLocked(ctx, want) {
  const { plan, all } = ctx;
  const toChange = [];
  const noChange = [];
  const ghosts = [];
  for (const e of all) {
    if (!e.nodeId) { ghosts.push(e); continue; }
    if (e.locked === want) noChange.push(e); else toChange.push(e);
  }
  for (const e of ghosts) plan.skippedEntries.push(skipOf(e, '尚未落库的卡位无法锁定（先拖动或缩放一次即会落库）'));
  for (const e of noChange) plan.skippedEntries.push(skipOf(e, want ? '已是锁定状态' : '已是未锁定状态'));
  if (!toChange.length) {
    return fail(plan, 'NOTHING_TO_DO', `选中的节点锁定状态无需变更${ghosts.length ? `（另有 ${ghosts.length} 项尚未落库）` : ''}`);
  }
  for (const e of toChange) e.toLocked = want;
  plan.entries = toChange;
  plan.affected = toChange.length;
  plan.lockedValue = want;
  for (const e of toChange) {
    plan.effects.push({
      method: 'POST',
      path: `/api/canvas/node/${e.nodeId}/lock`,
      target: e.kind,
      count: 1,
      body: { locked: want },
      note: '复用既有 setNodeLocked（POST /api/canvas/node/:id/lock），不得新造第二个锁定写入口',
    });
  }
  plan.messages.push(want
    ? `已锁定 ${toChange.length} 个节点`
    : `已解锁 ${toChange.length} 个节点`);
  plan.ok = true;
  return plan;
}

/** 危险动作的确认闸门：未显式 confirm → 撤下所有 effects / messages（保证「未确认零副作用」） */
function applyConfirmGate(plan, p, o) {
  plan.skipped = plan.skippedEntries.length;
  plan.confirmText = plan.confirmStages.join('\n');
  plan.confirmMode = plan.confirmStages.length >= 2 ? 'double' : 'single';
  if (!plan.summary) plan.summary = describeBatchPlan(plan);
  if (!plan.requiresConfirm) {
    plan.needsConfirm = false;
    plan.confirmed = true;
  } else {
    plan.needsConfirm = true;
    const confirm = p.confirm !== undefined ? p.confirm : o.confirm;
    const confirmAgain = p.confirmAgain !== undefined ? p.confirmAgain : o.confirmAgain;
    plan.confirmed = isConfirmSatisfied(plan, confirm, confirmAgain);
  }
  if (!plan.ok) return plan;                       // 前置校验已失败，不再谈确认
  if (plan.requiresConfirm && !plan.confirmed) {
    plan.plannedEffects = plan.effects;             // 供确认框预览
    plan.plannedMessages = plan.messages;
    plan.effects = [];
    plan.messages = [];
    const how = plan.confirmMode === 'double'
      ? '请传 confirm: 2（表示两段提示均已确认）或 confirm: true + confirmAgain: true'
      : '请传 confirm: true';
    return fail(plan, 'NEED_CONFIRM', `「${plan.label}」是危险动作，必须显式确认后才能执行：${how}。确认文案：${plan.confirmText}`);
  }
  return plan;
}

/**
 * 生成批处理「动作计划」——**纯函数，不发任何请求**。
 *
 * @param {'move'|'resize'|'delete'|'group'|'rerun-kinds'|'lock'|'unlock'} action
 * @param {object[]} items       被选中（且可见）的 layout item 数组（I4：调用方只传可见项）
 * @param {object}   params      动作特有参数：move{dx,dy} resize{w,h,scale} delete{mode,scope} group{name,color}
 *                               rerun-kinds{kinds,overwrite} 公共{includeLocked,confirm,confirmAgain}
 * @param {object}   opts        {canvasId, canvasName, mode:'matrix'|'free', includeLocked, canvasTotal, allItems,
 *                                confirm, confirmAgain, blockedReason}
 * @returns {object} plan  纯数据：ok / code / reason / entries / skippedEntries / effects / notices / messages /
 *                         confirmStages / confirmText / confirmMode / needsConfirm / confirmed / affected /
 *                         skipped / mainCanvas / canvasId / canvasSource('opts'|'params'|'items'|'none') /
 *                         selectionCanvasIds / selectionHasMainCanvas / mixedCanvasSelection /
 *                         autoSnapshot / snapshotLabel / undoable / summary / warning
 *                         失败码含 CANVAS_ID_REQUIRED（删除类动作无法自证画布身份，fail-closed 拒绝，
 *                         见 RK-L6-01 / R-W3-01）、MAIN_CANVAS_GUARD（自证为主画布或选区内出现主画布节点，
 *                         见 AC-3 / R-W3-02）、CANVAS_ID_CONFLICT（选区跨多个画布、身份不自洽，R-W3-02 附带）、
 *                         CANVAS_ID_UNVERIFIED（调用方声明的 canvasId 得不到选区节点印证且拿不到子集证明，
 *                         W7 收口新增，见 W7 洞②）
 */
export function planBatch(action, items = [], params = {}, opts = {}) {
  const id = typeof action === 'string' ? action.trim() : '';
  const list = Array.isArray(items) ? items : [];
  const p = isObj(params) ? params : {};
  const o = isObj(opts) ? opts : {};
  const meta = BATCH_ACTIONS[id] || null;
  const plan = makePlanBase(id, meta, list, p, o);

  if (!meta) {
    return fail(plan, 'UNSUPPORTED_ACTION', `不支持的批处理动作：${id || '(空)'}（可用：${SUPPORTED_ACTIONS.join(' / ')}）`);
  }
  if (!list.length) return fail(plan, 'EMPTY_SELECTION', meta.emptyReason || EMPTY_SELECTION_REASON);
  if (list.length > BATCH_MAX_NODES) {
    return fail(plan, 'TOO_MANY_NODES', `一次最多处理 ${BATCH_MAX_NODES} 个节点（当前 ${list.length} 个）：请先用筛选缩小范围`);
  }

  const ctx = { plan, all: list.map((it, i) => entryOf(it, i)), list, p, o, id };
  switch (id) {
    case 'move': return applyConfirmGate(planMove(ctx), p, o);
    case 'resize': return applyConfirmGate(planResize(ctx), p, o);
    case 'delete': return applyConfirmGate(planDelete(ctx), p, o);
    case 'group': return applyConfirmGate(planGroup(ctx), p, o);
    case 'rerun-kinds': return applyConfirmGate(planRerunByKind(ctx), p, o);
    case 'lock': return applyConfirmGate(planSetLocked(ctx, true), p, o);
    case 'unlock': return applyConfirmGate(planSetLocked(ctx, false), p, o);
    default: return fail(plan, 'UNSUPPORTED_ACTION', `不支持的批处理动作：${id}`);
  }
}

/** 计划的中文摘要（HUD / 日志用） */
export function describeBatchPlan(plan) {
  if (!isObj(plan)) return '（无批处理计划）';
  const label = plan.label || plan.action || '批处理';
  if (!plan.ok && plan.code && plan.code !== 'OK') {
    return `${label}：${plan.reason || '未通过前置校验'}`;
  }
  const parts = [`处理 ${plan.affected || 0} 项`];
  if (plan.skipped) parts.push(`跳过 ${plan.skipped} 项`);
  if (plan.requiresApproval) parts.push('需人工审批 + 终端确认码');
  else if (plan.requiresConfirm) parts.push('需显式确认');
  if (plan.autoSnapshot) parts.push('执行前自动快照');
  return `${label}：${parts.join('，')}`;
}

// ============================ 5. 批处理：应用计划（AC-2 / AC-3） ============================

/** 失败的应用结果（不改动任何东西） */
function applyFail(code, reason, list) {
  return {
    ok: false, code, reason,
    action: '', label: '', affected: 0, skipped: 0,
    changed: false, items: Array.isArray(list) ? list.slice() : [], removed: [], patches: [],
    effects: [], messages: [], notices: [], warning: '',
    before: { undo: false, autoSnapshot: false, snapshotLabel: '', confirm: false, approval: false },
  };
}

/**
 * 应用「动作计划」：返回**内存投影**（新 items 数组，绝不修改入参）与**接口调用描述**（effects）。
 * 本函数不发请求；调用方按 effects 顺序执行，并在执行前 pushUndo() / 危险动作前自动快照。
 *
 * @param {object} plan     planBatch 的返回值
 * @param {object} ctx2     {items, confirm, confirmAgain, includeLocked}
 * @returns {object} {ok, code, reason, action, label, affected, skipped, changed, items, removed, patches,
 *                    effects, messages, notices, warning, before:{undo, autoSnapshot, snapshotLabel, confirm, approval},
 *                    groupApplied?, approvalRequired?, requiresApproval, plan}
 */
export function applyBatchPlan(plan, { items = [], confirm, confirmAgain, includeLocked } = {}) {
  const p = isObj(plan) ? plan : null;
  const list = Array.isArray(items) ? items : [];
  if (!p) return applyFail('NO_PLAN', '缺少批处理计划：请先调用 planBatch 生成计划', list);

  // 计划与 items 必须同源（防止「筛选变了 / 画布重载了」却拿旧计划落地）
  if (p.itemCount !== list.length) {
    return applyFail('STALE_PLAN', `计划与当前节点列表不匹配（计划基于 ${p.itemCount} 项，当前 ${list.length} 项）：请重新生成计划`, list);
  }

  // 危险动作的确认：计划生成时已确认（plan.confirmed）**或**本次显式确认，二者满足其一即可；
  // 两者都不满足 → 拒绝，且不产出任何 effects（AC-2 / C7）。
  const confirmedNow = isConfirmSatisfied(p, confirm, confirmAgain);
  const alreadyConfirmed = p.confirmed === true;
  if (p.requiresConfirm && !confirmedNow && !alreadyConfirmed) {
    return applyFail('NEED_CONFIRM', p.confirmText || `「${p.label}」是危险动作，必须显式确认`, list);
  }

  // 未通过前置校验的计划（SUPPORTED/EMPTY/TOO_MANY/MAIN_CANVAS_GUARD/… ）一律不能执行
  if (p.code !== 'OK' && p.code !== 'NEED_CONFIRM') {
    return applyFail(p.code || 'PLAN_NOT_OK', p.reason || '批处理计划未通过前置校验，不能执行', list);
  }
  let effects = Array.isArray(p.effects) ? p.effects.slice() : [];
  if (p.code === 'NEED_CONFIRM') {
    // 计划阶段被确认闸门拦下：effects 当时未放行，改用 plannedEffects（确认校验已在上方通过）
    effects = Array.isArray(p.plannedEffects) ? p.plannedEffects.slice() : [];
  } else if (p.ok !== true) {
    return applyFail(p.code || 'PLAN_NOT_OK', p.reason || '批处理计划未通过前置校验，不能执行', list);
  }

  const out = {
    ok: true, code: 'OK', reason: '',
    action: p.action, label: p.label,
    affected: p.affected || 0, skipped: p.skipped || 0,
    changed: false, items: list.slice(), removed: [], patches: [],
    effects,
    messages: Array.isArray(p.messages) ? p.messages.slice() : [],
    notices: Array.isArray(p.notices) ? p.notices.slice() : [],
    warning: p.warning || '',
    requiresApproval: Boolean(p.requiresApproval),
    before: {
      undo: Boolean(p.undoable),                    // U1：调用方在执行 effects 前 pushUndo() 一次
      autoSnapshot: Boolean(p.autoSnapshot),        // S1/S2：调用方在破坏性动作前 autoSnapshotBefore()
      snapshotLabel: p.snapshotLabel || p.label || '',
      confirm: Boolean(p.needsConfirm),
      approval: Boolean(p.requiresApproval),
    },
    plan: p,
  };
  const entries = Array.isArray(p.entries) ? p.entries : [];

  switch (p.action) {
    case 'move':
    case 'resize': {
      const next = list.slice();
      for (const e of entries) {
        if (!e.to) continue;
        next[e.index] = { ...next[e.index], x: e.to.x, y: e.to.y, w: e.to.w, h: e.to.h };
        out.patches.push({
          index: e.index, nodeId: e.nodeId, actorId: e.actorId, kind: e.kind,
          x: e.to.x, y: e.to.y, w: e.to.w, h: e.to.h,
        });
      }
      out.items = next;
      out.changed = out.patches.length > 0;
      break;
    }
    case 'delete': {
      const gone = new Set(entries.map((e) => e.index));
      out.removed = entries.map((e) => ({
        index: e.index, nodeId: e.nodeId, actorId: e.actorId, kind: e.kind, title: e.title, ghost: e.ghost,
      }));
      out.items = list.filter((_, i) => !gone.has(i));
      out.changed = out.removed.length > 0;
      break;
    }
    case 'lock':
    case 'unlock': {
      const want = p.action === 'lock';
      const next = list.slice();
      for (const e of entries) {
        next[e.index] = { ...next[e.index], locked: want };
        out.patches.push({ index: e.index, nodeId: e.nodeId, actorId: e.actorId, kind: e.kind, locked: want });
      }
      out.items = next;
      out.changed = out.patches.length > 0;
      break;
    }
    case 'group': {
      // 分组 id 由服务端生成：本函数不臆造 groupId，视图层拿到响应后 await loadCanvas() 再刷新
      out.groupApplied = true;
      out.groupName = p.groupName || '新分组';
      out.changed = false;
      break;
    }
    case 'rerun-kinds': {
      // 不改变画布状态（U4：不入撤销栈）；只把「计划链路」交给调用方
      out.submitted = false;
      out.approvalRequired = true;
      out.approvalChain = Array.isArray(p.approvalChain) ? p.approvalChain.slice() : RERUN_APPROVAL_CHAIN.slice();
      out.forbiddenEndpoints = RERUN_FORBIDDEN_ENDPOINTS.slice();
      out.changed = false;
      break;
    }
    default:
      return applyFail('UNSUPPORTED_ACTION', `不支持的批处理动作：${p.action}`, list);
  }

  if (includeLocked === true && !p.includeLocked) {
    out.notices.push('调用方传了 includeLocked:true，但计划未包含已锁定项：请重新生成计划（计划与执行参数必须一致）');
  }
  return out;
}
