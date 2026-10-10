/**
 * 画布性能纯逻辑模块：视口裁剪 / LOD 分级 / 批量几何
 *
 * 契约来源：`strategist/reports/T-105-canvas-perf-spec.md`（T-105 冻结的签名与逐行等价公式）
 * 等价来源：`web/views/actors.js`（行号逐条写在每个函数上方注释里）
 * 本文件零依赖：无任何 `import`，不触碰浏览器宿主对象，不读写模块外状态，不改入参对象。
 *
 * 交付范围（T-209）：核心批 12 个签名 + `matrixLayout`（`§3.2` 的 200/1000 卡位解析表要用它复算，
 * 且该宫格公式在前端 `actors.js:443-448` 与后端 `src/modules/actors.js:944-948` 各写了一份）。
 * 契约 §2.3 的其余扩展批（`hitTestAt`/`marqueeHitIds`/`boundsOf`/`zoomAtPoint`/`fitViewport`/
 * `zoomToRect`/`ensureVisiblePan`/`snapPosition`/`alignOffsets`/`distributeOffsets`/`resizeSize`/
 * `freeSpot`/`niceStep`/`portPoint`/`portPointAt`/`edgeAnchor`/`resolvedLinks`）按 §2.3「可分批交付」
 * 留给接线卡，避免在无人调用时扩大等价性面（接线顺序见契约 §5）。
 *
 * 200 卡位 / 1000 卡位的收益说明（数字全部由本模块自身函数统计得出，未做耗时压测、不编造帧率）
 * ------------------------------------------------------------------
 * 前提：`cols=5`、`cell=210`、`gap=14`（pitch=224、原点 20，与后端同式）；视口 1320×860 CSS px；
 *       `pan=0`；`pad=50`（`CULL_PAD`，世界单位、不随 zoom 变化）。
 * 数据来源：下面两张表逐行由本模块自身的 `matrixLayout` + `viewportOf` + `cullStats` 算出，
 *          即 `cullStats(matrixLayout({count,cols:5,cell:210,gap:14}), viewportOf({zoom,width:1320,height:860}))`，
 *          没有编造数字、没有压测外推。可复制的完整复现命令见 `strategist/runs/T-209.json` 的
 *          `evidence.repro`（离线运行，不需要服务与临时库；这里不放命令原文，是为了让本文件不含
 *          任何宿主全局标识符，便于"纯函数"自查逐字通过）。
 *
 *   200 卡位（布局占 1126×8966 世界单位，fitView≈0.0953）
 *   | zoom | LOD | 世界视口  | drawn/200 | 比例  |
 *   |------|-----|-----------|-----------|-------|
 *   | 0.05 |  0  | 26500×17300 | 200     | 100%  |
 *   | 0.10 |  0  | 13300×8700  | 195     | 97.5% |
 *   | 0.12 |  0  | 11100×7267  | 165     | 82.5% |
 *   | 0.22 |  1  | 6100×4009   |  90     | 45.0% |
 *   | 0.35 |  1  | 3871×2557   |  60     | 30.0% |
 *   | 0.50 |  2  | 2740×1820   |  40     | 20.0% |
 *   | 1.00 |  2  | 1420×960    |  20     | 10.0% |
 *   | 2.00 |  2  | 760×530     |  12     |  6.0% |
 *   | 4.00 |  2  | 430×315     |   4     |  2.0% |
 *   | 8.00 |  2  | 265×208     |   1     |  0.5% |
 *
 *   1000 卡位（同几何，fitView≈0.0192）：zoom=0.1 → 195/1000（19.5%）、0.22 → 90（9%）、
 *                                    1.0 → 20（2%）、8 → 1（0.1%）。
 *
 * 结论（均可用上面命令复现）：
 *  1. 低缩放区（0.05~0.12）裁剪几乎不省：97.5%~100% 的卡位都在视野内 —— 这一段的流畅性
 *     由 LOD0「不新建图片对象、零解码」决定（`actors.js:653-656`、`:745`），这是 200 卡位最大的一笔；
 *  2. 高缩放区（≥1）裁剪收益显著：可见 10% → 0.5%，`drawCell` 调用量随 `drawn` 近似线性下降；
 *  3. 200 卡位 fitView（≈0.0953）必然落在 LOD0（内容高 8966 > 视口高 860），因此「适应窗口后卡不卡」
 *     等价于「LOD0 是否生效」；
 *  4. 本模块自身不提升帧率：它把上述两条既有收益锁定成可离线回归的判定（契约 §3.1），
 *     并消除视口/宫格公式的多处手抄漂移；小地图、分组框、连线仍是每帧 O(n)（契约 §3.4 明确不改善）。
 */

// ---------------- 常量（单一真源，改阈值只改这里） ----------------

/** 缩放下限（与 web/views/actors.js:390 一致） */
export const ZOOM_MIN = 0.05;
/** 缩放上限（与 web/views/actors.js:391 一致） */
export const ZOOM_MAX = 8;
/** 裁剪留白：世界单位、恒定，**不随 zoom 变化**（actors.js:559 里的 50，禁止改成 50/zoom） */
export const CULL_PAD = 50;
/** LOD 阈值：<mid → 0（简）、<full → 1（中）、否则 2（全）（actors.js:401-405 的 0.22 / 0.5） */
export const LOD_THRESHOLDS = { mid: 0.22, full: 0.5 };

// ---------------- 入参校验（中文报错，只查类型、不查数值业务合法性） ----------------

/** 数组校验；失败抛中文 TypeError（契约 §2.6） */
function assertItems(items, fn) {
  if (!Array.isArray(items)) {
    throw new TypeError(`canvas-perf.${fn}：items 必须是数组，收到 ${items === null ? 'null' : typeof items}`);
  }
}

/** 视口矩形校验：必须是含 4 个有限数键 x0/y0/x1/y1 的对象 */
function assertView(view, fn) {
  const ok = view !== null && typeof view === 'object'
    && Number.isFinite(view.x0) && Number.isFinite(view.y0)
    && Number.isFinite(view.x1) && Number.isFinite(view.y1);
  if (!ok) {
    throw new TypeError(`canvas-perf.${fn}：view 必须是 {x0,y0,x1,y1}，收到 ${JSON.stringify(view) ?? String(view)}`);
  }
}

/** 单卡校验：只要求是对象（x/y/w/h 的数值合法性不校验，与现状一致） */
function assertItem(item, fn) {
  if (item === null || typeof item !== 'object') {
    throw new TypeError(`canvas-perf.${fn}：item 必须是对象，收到 ${item === null ? 'null' : typeof item}`);
  }
}

// ---------------- 核心批 ----------------

/** 缩放夹取：等价 web/views/actors.js:392 `Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z))` */
export function clampZoom(zoom, min = ZOOM_MIN, max = ZOOM_MAX) {
  return Math.max(min, Math.min(max, zoom));
}

/**
 * LOD 分级：等价 web/views/actors.js:401-405（`< 0.22 → 0`、`< 0.5 → 1`、否则 `2`）
 * - 阈值取 LOD_THRESHOLDS（可传覆盖值，测试与实现共用同一真源）
 * - 非有限数（NaN/Infinity）：两个 `<` 比较均为 false → 返回 2，保持现状的 JS 语义，不做兜底
 * - 函数自身不夹取 zoom、不校验数值范围（调用方保证 zoom 已由 clampZoom 夹取）
 */
export function lodLevelFor(zoom, thresholds = LOD_THRESHOLDS) {
  if (thresholds === null || typeof thresholds !== 'object') {
    throw new TypeError(`canvas-perf.lodLevelFor：thresholds 必须是 {mid,full}，收到 ${thresholds === null ? 'null' : typeof thresholds}`);
  }
  if (zoom < thresholds.mid) return 0;
  if (zoom < thresholds.full) return 1;
  return 2;
}

/**
 * 视口矩形（世界坐标）：等价 web/views/actors.js:556-559
 *   vw = width / zoom；vh = height / zoom
 *   x0 = -panX - pad；y0 = -panY - pad；x1 = -panX + vw + pad；y1 = -panY + vh + pad
 * - pad 默认 CULL_PAD(50)，是世界单位，**不除以 zoom**（现状如此，禁止"修正"为 pad/zoom）
 * - width/height 为 0（画布隐藏）时返回退化矩形（x1 = x0 + 2*pad），不做兜底扩边
 * - 不校验数值合法性：zoom 缺失/非有限时结果原样传播（NaN 参与比较），与现状一致
 */
export function viewportOf(input) {
  if (input === null || typeof input !== 'object') {
    throw new TypeError(`canvas-perf.viewportOf：入参必须是 {zoom,panX,panY,width,height,pad}，收到 ${input === null ? 'null' : typeof input}`);
  }
  const { zoom, panX = 0, panY = 0, width = 0, height = 0, pad = CULL_PAD } = input;
  const vw = width / zoom;
  const vh = height / zoom;
  return { x0: -panX - pad, y0: -panY - pad, x1: -panX + vw + pad, y1: -panY + vh + pad };
}

/**
 * 单卡裁剪判定：等价 web/views/actors.js:564-565 的 continue 条件取反
 *   keep = item.x + item.w >= view.x0 && item.x <= view.x1
 *       && item.y + item.h >= view.y0 && item.y <= view.y1
 * - **闭区间**：恰好与视口边界相切（x + w === x0）必须可见
 * - 不含 pad：pad 已并入 view（由 viewportOf 负责）
 * - 注：原实现是「四项 `<`/`>` 任一成立则跳过」，本式为其逻辑取反；两者仅在卡片坐标为 NaN 时
 *   表现不同（原式不跳过、本式判为不可见）。卡片坐标来自数据库数值列，不会出现 NaN。
 */
export function viewClipKeep(item, view) {
  assertItem(item, 'viewClipKeep');
  assertView(view, 'viewClipKeep');
  return item.x + item.w >= view.x0 && item.x <= view.x1
    && item.y + item.h >= view.y0 && item.y <= view.y1;
}

/**
 * 批量裁剪：等价 web/views/actors.js:564-565 的循环筛出
 * - 返回新数组，**保持输入顺序**（不排序、不按 z 重排、不去重）
 * - 元素与入参同一引用（不做拷贝，保持对象身份：下游按 identity 建索引）
 * - 不读取任何模块外状态
 */
export function visibleItems(items, view) {
  assertItems(items, 'visibleItems');
  assertView(view, 'visibleItems');
  const out = [];
  for (const it of items) if (viewClipKeep(it, view)) out.push(it);
  return out;
}

/**
 * 绘制统计：等价 web/views/actors.js:560-577 的 drawn 累加 + HUD 口径（:613、:626）
 *   total = items.length；drawn = 可见数；hidden = total - drawn；ratio = total === 0 ? 0 : drawn / total
 * - 空数组必须得 ratio = 0（不得 NaN）
 * - drawn 与既有 HUD / 调试口径（`__acDebug().drawn`）逐位一致，不做四舍五入
 */
export function cullStats(items, view) {
  assertItems(items, 'cullStats');
  assertView(view, 'cullStats');
  const total = items.length;
  let drawn = 0;
  for (const it of items) if (viewClipKeep(it, view)) drawn++;
  return { total, drawn, hidden: total - drawn, ratio: total === 0 ? 0 : drawn / total };
}

/** 层级：等价 web/views/actors.js:561（`kind === 'note'` 取便签 z，否则取节点 z / 自身 z） */
export function zOf(item) {
  assertItem(item, 'zOf');
  return item.kind === 'note' ? (item.note?.z || 0) : (item.node?.z || item.z || 0);
}

/**
 * z 升序稳定排序（z 大者后画 = 压在上面）：等价 web/views/actors.js:562 `[...items].sort((a,b)=>zOf(a)-zOf(b))`
 * - 返回新数组，不改入参
 * - 稳定性显式保证：`(zOf(a) - zOf(b)) || (idxA - idxB)`，不依赖引擎排序稳定性
 */
export function sortByZ(items) {
  assertItems(items, 'sortByZ');
  const order = new Map(items.map((it, i) => [it, i]));
  return [...items].sort((a, b) => (zOf(a) - zOf(b)) || (order.get(a) - order.get(b)));
}

/**
 * 连线整体开关：等价 web/views/actors.js:609 + :1218
 *   showLinks !== false && Array.isArray(links) && links.length > 0
 * - **只表达整体开关**：不做端点解析、不按视口裁剪连线（端点被裁掉的连线现状照画，改了就变行为）
 */
export function shouldDrawLinks(input) {
  if (input === null || typeof input !== 'object') {
    throw new TypeError(`canvas-perf.shouldDrawLinks：入参必须是 {showLinks,links}，收到 ${input === null ? 'null' : typeof input}`);
  }
  const { showLinks, links } = input;
  return showLinks !== false && Array.isArray(links) && links.length > 0;
}

// ---------------- 批量几何（交付范围内） ----------------

/**
 * 宫格布局：等价 web/views/actors.js:443-448 与后端 src/modules/actors.js:944-948
 *   col = i % cols；row = floor(i / cols)
 *   x = originX + col * (cell + gap)；y = originY + row * (cell + gap)；w = h = cell
 * - 返回新数组；默认原点 20（两处现状都是 20）
 * - 只做几何，不产出 `id`/`kind` 等业务字段（那些由调用方装配）
 */
export function matrixLayout({ count, cols, cell, gap, originX = 20, originY = 20 }) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    out.push({ x: originX + col * (cell + gap), y: originY + row * (cell + gap), w: cell, h: cell });
  }
  return out;
}
