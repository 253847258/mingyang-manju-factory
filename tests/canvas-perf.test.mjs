// 画布性能纯逻辑离线测试（视口裁剪 / LOD 分级 / 批量几何）
//
// 用法：node tests/canvas-perf.test.mjs
//
// 契约：strategist/reports/T-105-canvas-perf-spec.md（§2 签名与语义、§3.2 解析表、§3.3 M1/M2/M3/M5/M6、§6 用例表）
// 被测：web/lib/canvas-perf.js（纯函数，零依赖、无 DOM、无 IO）
//
// 特性：不需要临时库 / 临时端口 / 假后端；不读时钟（不使用 Date/Math.random），除 M6 预算打印外
//       全部断言与运行时刻无关；数据全部为固定夹具。
import * as perf from '../web/lib/canvas-perf.js';

const {
  ZOOM_MIN, ZOOM_MAX, CULL_PAD, LOD_THRESHOLDS,
  clampZoom, lodLevelFor, viewportOf, viewClipKeep, visibleItems, cullStats,
  zOf, sortByZ, shouldDrawLinks, matrixLayout,
} = perf;

// ---- 与既有测试同款的计数式断言（tests/test-actors.js:39-43 风格），断言名用中文描述行为 ----
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name} ${extra}`); }
};

console.log('\n=== 画布性能纯逻辑测试（canvas-perf）===');

// ---------------------------------------------------------------- 1. 常量（阈值/留白单一真源）
console.log('\n[1] 常量与单一真源');
ok('缩放下限为 0.05、上限为 8（与 actors.js:390-391 一致）', ZOOM_MIN === 0.05 && ZOOM_MAX === 8,
  `${ZOOM_MIN}/${ZOOM_MAX}`);
ok('裁剪留白恒为 50（世界单位，禁止改成 50/zoom）', CULL_PAD === 50, String(CULL_PAD));
ok('LOD 阈值真源为 {mid:0.22, full:0.5}（22% 简版 / 50% 全量）',
  LOD_THRESHOLDS && LOD_THRESHOLDS.mid === 0.22 && LOD_THRESHOLDS.full === 0.5,
  JSON.stringify(LOD_THRESHOLDS));

// ---------------------------------------------------------------- 2. clampZoom 正常路径 + 边界 + 反例
console.log('\n[2] clampZoom 缩放夹取');
ok('正常路径：区间内的缩放原样返回', clampZoom(3) === 3);
ok('边界：小于下限被抬到 0.05、大于上限被压到 8', clampZoom(0.001) === 0.05 && clampZoom(99) === 8);
ok('边界：恰好等于上下限时保持不动', clampZoom(0.05) === 0.05 && clampZoom(8) === 8);
ok('反例：自定义上下限时按传入值夹取', clampZoom(5, 1, 2) === 2 && clampZoom(0.5, 1, 2) === 1);

// ---------------------------------------------------------------- 3. LOD 阈值（契约 §3.3 M3）
console.log('\n[3] lodLevelFor LOD 分级阈值');
const LOD_CASES = [
  [0.05, 0, '缩放下限落在 LOD0（简版）'],
  [0.21999, 0, '阈值下方一点点仍为 LOD0'],
  [0.22, 1, '恰好 0.22 进入 LOD1（中版）'],
  [0.35, 1, '0.35 为 LOD1'],
  [0.49999, 1, '阈值下方一点点仍为 LOD1'],
  [0.5, 2, '恰好 0.5 进入 LOD2（全量）'],
  [8, 2, '缩放上限落在 LOD2'],
];
for (const [zoom, lod, desc] of LOD_CASES) {
  ok(`LOD 阈值：${desc}（zoom=${zoom} → ${lod}）`, lodLevelFor(zoom) === lod, `实得 ${lodLevelFor(zoom)}`);
}
ok('反例：非有限缩放（NaN）两个比较均 false，保持现状 JS 语义返回 2（不做兜底）',
  lodLevelFor(NaN) === 2 && lodLevelFor(Infinity) === 2);
ok('阈值可覆盖：lodLevelFor 与测试共用同一份 thresholds 入参',
  lodLevelFor(0.3, { mid: 0.4, full: 0.6 }) === 0 && lodLevelFor(0.5, { mid: 0.4, full: 0.6 }) === 1);
ok('反例：thresholds 非对象时抛中文 TypeError',
  (() => { try { lodLevelFor(0.3, null); return false; } catch (e) { return e instanceof TypeError && /thresholds 必须是/.test(e.message); } })());

// ---------------------------------------------------------------- 4. viewportOf 视口矩形
console.log('\n[4] viewportOf 视口矩形（pad 不随 zoom 变化）');
const V_PAN = viewportOf({ zoom: 1, panX: 100, panY: 40, width: 800, height: 600 });
ok('正常路径：视口矩形按 -pan±pad 与世界宽高换算（x1 = -panX + width/zoom + pad = 750）',
  V_PAN.x0 === -150 && V_PAN.y0 === -90 && V_PAN.x1 === 750 && V_PAN.y1 === 610,
  JSON.stringify(V_PAN));
const V_TINY = viewportOf({ zoom: 0.05, width: 1320, height: 860 });
const V_BIG = viewportOf({ zoom: 8, width: 1320, height: 860 });
ok('关键前提：最小缩放 0.05 时留白仍是 50（世界单位，不除以 zoom）',
  V_TINY.x0 === -50 && V_TINY.y0 === -50, JSON.stringify(V_TINY));
ok('关键前提：最大缩放 8 时留白同样是 50（不随 zoom 变化）',
  V_BIG.x0 === -50 && V_BIG.y0 === -50, JSON.stringify(V_BIG));
ok('边界：画布隐藏（width/height=0）返回退化矩形 x1=x0+2*pad，不做兜底扩边',
  (() => { const v = viewportOf({ zoom: 1, width: 0, height: 0 }); return v.x0 === -50 && v.x1 === 50 && v.y0 === -50 && v.y1 === 50; })(),
  JSON.stringify(viewportOf({ zoom: 1, width: 0, height: 0 })));
ok('边界：pad 可显式覆盖为 0（此时视口恰好等于世界可见区）',
  (() => { const v = viewportOf({ zoom: 1, panX: 0, panY: 0, width: 100, height: 100, pad: 0 }); return v.x0 === 0 && v.x1 === 100 && v.y0 === 0 && v.y1 === 100; })());

// ---------------------------------------------------------------- 5. 边界相切必须可见 / 越界 1px 必须隐藏（M2）
console.log('\n[5] viewClipKeep 边界口径（闭区间：相切必可见）');
const V = { x0: 0, y0: 0, x1: 100, y1: 100 };
ok('边界：左边缘相切（x+w === x0）的卡位必须可见',
  viewClipKeep({ x: -10, y: 40, w: 10, h: 20 }, V) === true);
ok('边界：右边缘相切（x === x1）的卡位必须可见',
  viewClipKeep({ x: 100, y: 40, w: 10, h: 20 }, V) === true);
ok('边界：上边缘相切（y+h === y0）的卡位必须可见',
  viewClipKeep({ x: 40, y: -20, w: 20, h: 20 }, V) === true);
ok('边界：下边缘相切（y === y1）的卡位必须可见',
  viewClipKeep({ x: 40, y: 100, w: 20, h: 20 }, V) === true);
ok('反例：四边各越界 1px 时一律判定不可见',
  viewClipKeep({ x: -11, y: 40, w: 10, h: 20 }, V) === false
  && viewClipKeep({ x: 101, y: 40, w: 10, h: 20 }, V) === false
  && viewClipKeep({ x: 40, y: -21, w: 20, h: 20 }, V) === false
  && viewClipKeep({ x: 40, y: 101, w: 20, h: 20 }, V) === false);
ok('边界：完全覆盖视口的大卡位可见，完全在视口内的小卡位可见',
  viewClipKeep({ x: -500, y: -500, w: 2000, h: 2000 }, V) === true
  && viewClipKeep({ x: 50, y: 50, w: 1, h: 1 }, V) === true);
ok('反例：完全在视口外的卡位不可见',
  viewClipKeep({ x: 200, y: 200, w: 10, h: 10 }, V) === false);

// ---------------------------------------------------------------- 6. visibleItems 保序 / identity / 幂等
console.log('\n[6] visibleItems 批量裁剪');
const ITEM_A = { id: 'a', x: 0, y: 0, w: 200, h: 200 };
const ITEM_B = { id: 'b', x: 5000, y: 5000, w: 10, h: 10 };
const ITEM_C = { id: 'c', x: 100, y: 100, w: 10, h: 10 };  // 与右/下边界相切，必须可见
const FIXED_ITEMS = [ITEM_B, ITEM_A, ITEM_C];
const VIS = visibleItems(FIXED_ITEMS, V);
ok('正常路径：仅筛出可见卡位（相切者计入，远处者剔除）',
  VIS.length === 2 && VIS[0].id === 'a' && VIS[1].id === 'c', VIS.map((i) => i.id).join(','));
ok('保序性：输出顺序与输入顺序一致（不按 z 重排、不去重）',
  VIS[0] === ITEM_A && VIS[1] === ITEM_C);
ok('元素为入参同一引用（不做拷贝，下游按 identity 建索引依赖此点）',
  VIS.every((it) => FIXED_ITEMS.includes(it)));
ok('反例：全部在视口外时返回空数组（而非 undefined）', visibleItems([ITEM_B], V).length === 0 && Array.isArray(visibleItems([ITEM_B], V)));
ok('边界：空数组输入返回空数组', Array.isArray(visibleItems([], V)) && visibleItems([], V).length === 0);
ok('幂等性：重复调用结果一致（长度与顺序）',
  (() => { const a = visibleItems(FIXED_ITEMS, V), b = visibleItems(FIXED_ITEMS, V); return a.length === b.length && a.every((it, i) => it === b[i]); })());
ok('幂等性：对结果再裁剪一次不再变化（筛选是幂等的）',
  (() => { const a = VIS, b = visibleItems(a, V); return b.length === a.length && b.every((it, i) => it === a[i]); })());

// ---------------------------------------------------------------- 7. cullStats 统计口径（M1）
console.log('\n[7] cullStats 绘制统计口径');
const S = cullStats(FIXED_ITEMS, V);
ok('正常路径：total/drawn/hidden 口径正确（drawn === 可见数）',
  S.total === 3 && S.drawn === 2 && S.hidden === 1, JSON.stringify(S));
ok('M1 口径：cullStats(...).drawn === visibleItems(...).length（与 __acDebug().drawn 同源）',
  S.drawn === visibleItems(FIXED_ITEMS, V).length);
ok('统计口径：hidden === total - drawn，ratio === drawn/total（浮点逐位相等，不四舍五入）',
  S.hidden === S.total - S.drawn && S.ratio === S.drawn / S.total, String(S.ratio));
ok('边界：空数组统计为 {total:0,drawn:0,hidden:0,ratio:0}，ratio 不得为 NaN',
  (() => { const e = cullStats([], V); return e.total === 0 && e.drawn === 0 && e.hidden === 0 && e.ratio === 0 && !Number.isNaN(e.ratio); })(),
  JSON.stringify(cullStats([], V)));
ok('反例：全部在视口外时 drawn=0、hidden=total、ratio=0',
  (() => { const e = cullStats([ITEM_B, ITEM_B], V); return e.total === 2 && e.drawn === 0 && e.hidden === 2 && e.ratio === 0; })());
ok('幂等性：重复统计结果完全一致',
  JSON.stringify(cullStats(FIXED_ITEMS, V)) === JSON.stringify(cullStats(FIXED_ITEMS, V)));

// ---------------------------------------------------------------- 8. zOf / sortByZ 层级与稳定排序
console.log('\n[8] zOf / sortByZ 层级与稳定排序');
ok('zOf：便签取 note.z', zOf({ kind: 'note', note: { z: 7 }, z: 3 }) === 7);
ok('zOf：便签无 note 行时取 0', zOf({ kind: 'note' }) === 0);
ok('zOf：演员卡取 node.z', zOf({ kind: 'actor', node: { z: 9 }, z: 2 }) === 9);
ok('zOf：演员卡无 node 行时回落到自身 z', zOf({ kind: 'actor', z: 4 }) === 4);
ok('反例：node.z 为 0（假值）时按现状回落到自身 z（|| 语义逐字保留）',
  zOf({ kind: 'actor', node: { z: 0 }, z: 5 }) === 5);
ok('zOf：两个层级字段都缺失时取 0', zOf({ kind: 'actor' }) === 0);
const Z_ITEMS = [
  { id: 'z2-1', node: { z: 2 } },
  { id: 'z0', node: { z: 0 } },
  { id: 'z2-2', node: { z: 2 } },
  { id: 'z1', node: { z: 1 } },
];
const SORTED = sortByZ(Z_ITEMS);
ok('正常路径：按 z 升序排列（z 大者后画=压在上面）',
  SORTED.map((i) => i.id).join(',') === 'z0,z1,z2-1,z2-2', SORTED.map((i) => i.id).join(','));
ok('稳定性：z 相等时保持输入顺序（不依赖引擎排序稳定性）',
  SORTED[2].id === 'z2-1' && SORTED[3].id === 'z2-2');
ok('反例：不改入参（返回新数组且原数组顺序不变）',
  SORTED !== Z_ITEMS && Z_ITEMS.map((i) => i.id).join(',') === 'z2-1,z0,z2-2,z1');
ok('边界：空数组排序返回空数组', sortByZ([]).length === 0);
ok('幂等性：二次排序顺序不变', sortByZ(SORTED).map((i) => i.id).join(',') === SORTED.map((i) => i.id).join(','));

// ---------------------------------------------------------------- 9. shouldDrawLinks 整体开关
console.log('\n[9] shouldDrawLinks 连线整体开关');
ok('正常路径：showLinks 未关闭且有连线时返回 true', shouldDrawLinks({ showLinks: true, links: [{ id: 1 }] }) === true);
ok('边界：showLinks 为 undefined（默认开）且有连线时返回 true',
  shouldDrawLinks({ showLinks: undefined, links: [{ id: 1 }] }) === true);
ok('反例：showLinks === false 时返回 false', shouldDrawLinks({ showLinks: false, links: [{ id: 1 }] }) === false);
ok('反例：连线数组为空时返回 false', shouldDrawLinks({ showLinks: true, links: [] }) === false);
ok('反例：links 不是数组时返回 false（不抛错）',
  shouldDrawLinks({ showLinks: true, links: null }) === false && shouldDrawLinks({ showLinks: true, links: 'x' }) === false);

// ---------------------------------------------------------------- 10. matrixLayout 宫格几何
console.log('\n[10] matrixLayout 宫格布局');
const GRID = matrixLayout({ count: 7, cols: 5, cell: 210, gap: 14 });
ok('正常路径：col = i%cols、row = floor(i/cols)，pitch = cell+gap = 224、原点 20',
  GRID[0].x === 20 && GRID[0].y === 20 && GRID[5].x === 20 && GRID[5].y === 244 && GRID[4].x === 20 + 4 * 224,
  JSON.stringify(GRID.slice(4, 6)));
ok('边界：格子宽高恒等于 cell', GRID.every((g) => g.w === 210 && g.h === 210));
ok('边界：count 为 0 返回空数组', matrixLayout({ count: 0, cols: 5, cell: 210, gap: 14 }).length === 0);
ok('边界：原点可覆盖', (() => { const g = matrixLayout({ count: 2, cols: 1, cell: 10, gap: 0, originX: 0, originY: 0 }); return g[0].x === 0 && g[0].y === 0 && g[1].y === 10; })());
ok('幂等性：同参数两次布局结果完全一致',
  JSON.stringify(matrixLayout({ count: 12, cols: 5, cell: 210, gap: 14 })) === JSON.stringify(matrixLayout({ count: 12, cols: 5, cell: 210, gap: 14 })));

// ---------------------------------------------------------------- 11. 中文报错
console.log('\n[11] 入参校验与中文报错');
const throwsZh = (fn, re) => { try { fn(); return false; } catch (e) { return e instanceof TypeError && re.test(e.message); } };
ok('反例：visibleItems 传非数组抛中文 TypeError（含「必须是数组」与函数名）',
  throwsZh(() => visibleItems('x', V), /canvas-perf\.visibleItems：items 必须是数组，收到 string/));
ok('反例：visibleItems 传 null 视口抛中文 TypeError（提示 {x0,y0,x1,y1}）',
  throwsZh(() => visibleItems([], null), /canvas-perf\.visibleItems：view 必须是 \{x0,y0,x1,y1\}，收到 null/));
ok('反例：视口缺键（非有限数）同样拒绝',
  throwsZh(() => visibleItems([], { x0: 0, y0: 0, x1: Infinity, y1: 0 }), /必须是 \{x0,y0,x1,y1\}/));
ok('反例：cullStats 与 viewClipKeep 各自报出带函数名的中文错误',
  throwsZh(() => cullStats(null, V), /canvas-perf\.cullStats：items 必须是数组，收到 null/)
  && throwsZh(() => viewClipKeep(null, V), /canvas-perf\.viewClipKeep：item 必须是对象，收到 null/));
ok('反例：viewportOf / shouldDrawLinks 传非对象抛中文 TypeError',
  throwsZh(() => viewportOf(1), /canvas-perf\.viewportOf：入参必须是/)
  && throwsZh(() => shouldDrawLinks(null), /canvas-perf\.shouldDrawLinks：入参必须是/));

// ---------------------------------------------------------------- 12. 入参不被修改（纯函数）
console.log('\n[12] 入参不被修改');
const MUT_ITEMS = [{ id: 'm1', x: 0, y: 0, w: 50, h: 50, node: { z: 1 } }, { id: 'm2', x: 9000, y: 0, w: 50, h: 50 }];
const MUT_BEFORE = JSON.stringify(MUT_ITEMS);
const MUT_VIEW = { x0: 0, y0: 0, x1: 100, y1: 100 };
const MUT_VIEW_BEFORE = JSON.stringify(MUT_VIEW);
visibleItems(MUT_ITEMS, MUT_VIEW);
cullStats(MUT_ITEMS, MUT_VIEW);
sortByZ(MUT_ITEMS);
ok('visibleItems / cullStats / sortByZ 均不修改入参 items 与 item',
  JSON.stringify(MUT_ITEMS) === MUT_BEFORE, JSON.stringify(MUT_ITEMS));
ok('visibleItems / cullStats 不修改入参 view',
  JSON.stringify(MUT_VIEW) === MUT_VIEW_BEFORE, JSON.stringify(MUT_VIEW));

// ---------------------------------------------------------------- 13. 200/1000 卡位解析表（M5，契约 §3.2）
console.log('\n[13] 200/1000 卡位解析表复算（cols=5 cell=210 gap=14，视口 1320×860，pan=0）');
const TABLE_200 = [
  { zoom: 0.05, lod: 0, drawn: 200 },
  { zoom: 0.1, lod: 0, drawn: 195 },
  { zoom: 0.12, lod: 0, drawn: 165 },
  { zoom: 0.22, lod: 1, drawn: 90 },
  { zoom: 0.35, lod: 1, drawn: 60 },
  { zoom: 0.5, lod: 2, drawn: 40 },
  { zoom: 1, lod: 2, drawn: 20 },
  { zoom: 2, lod: 2, drawn: 12 },
  { zoom: 4, lod: 2, drawn: 4 },
  { zoom: 8, lod: 2, drawn: 1 },
];
const ITEMS_200 = matrixLayout({ count: 200, cols: 5, cell: 210, gap: 14 });
for (const row of TABLE_200) {
  const v = viewportOf({ zoom: row.zoom, panX: 0, panY: 0, width: 1320, height: 860 });
  const st = cullStats(ITEMS_200, v);
  ok(`200 卡位 zoom=${row.zoom}：drawn=${row.drawn} / LOD=${row.lod}`,
    st.drawn === row.drawn && lodLevelFor(row.zoom) === row.lod,
    `实得 drawn=${st.drawn} lod=${lodLevelFor(row.zoom)}`);
}
ok('200 卡位最低缩放：全部 200 张卡位都在视野内（低缩放区裁剪几乎无收益）',
  cullStats(ITEMS_200, viewportOf({ zoom: 0.05, width: 1320, height: 860 })).drawn === 200);
const ITEMS_1000 = matrixLayout({ count: 1000, cols: 5, cell: 210, gap: 14 });
for (const row of [{ zoom: 0.1, drawn: 195 }, { zoom: 0.22, drawn: 90 }, { zoom: 1, drawn: 20 }, { zoom: 8, drawn: 1 }]) {
  const st = cullStats(ITEMS_1000, viewportOf({ zoom: row.zoom, width: 1320, height: 860 }));
  ok(`1000 卡位 zoom=${row.zoom}：drawn=${row.drawn}（高缩放区裁剪收益显著）`,
    st.drawn === row.drawn, `实得 ${st.drawn}`);
}
ok('解析表自洽：200 卡位任一缩放下 hidden + drawn === total',
  TABLE_200.every((row) => {
    const st = cullStats(ITEMS_200, viewportOf({ zoom: row.zoom, width: 1320, height: 860 }));
    return st.total === 200 && st.hidden + st.drawn === st.total && st.ratio === st.drawn / 200;
  }));
ok('收益口径：高缩放区可见数严格小于低缩放区（1x 时 20 < 0.05x 时 200）',
  cullStats(ITEMS_200, viewportOf({ zoom: 1, width: 1320, height: 860 })).drawn
  < cullStats(ITEMS_200, viewportOf({ zoom: 0.05, width: 1320, height: 860 })).drawn);

// ---------------------------------------------------------------- 14. M6 纯函数预算（只对预算上界断言，实测值仅作证据打印）
console.log('\n[14] M6 纯函数预算（实测值仅作证据，断言只对预算上界）');
const budget = (count) => {
  const items = matrixLayout({ count, cols: 5, cell: 210, gap: 14 });
  const v = viewportOf({ zoom: 1, panX: 0, panY: 0, width: 1320, height: 860 });
  for (let i = 0; i < 50; i++) { visibleItems(items, v); cullStats(items, v); }   // 预热
  const N = 100;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) { visibleItems(items, v); cullStats(items, v); }
  return Number(process.hrtime.bigint() - t0) / 1e6 / N;
};
const MS_200 = budget(200);
const MS_1000 = budget(1000);
console.log(`  · 实测：200 卡位 ${MS_200.toFixed(4)} ms/次，1000 卡位 ${MS_1000.toFixed(4)} ms/次（visibleItems + cullStats 合计均值，100 次）`);
ok('预算：200 卡位单次 visibleItems + cullStats 合计 ≤ 1 ms', MS_200 <= 1, `${MS_200.toFixed(4)} ms`);
ok('预算：1000 卡位单次 visibleItems + cullStats 合计 ≤ 5 ms', MS_1000 <= 5, `${MS_1000.toFixed(4)} ms`);

// ---------------------------------------------------------------- 汇总
console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);
