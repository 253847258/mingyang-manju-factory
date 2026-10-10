# T-105 画布性能纯逻辑契约：视口裁剪 / LOD 分级 / 批量几何

| 项 | 值 |
|---|---|
| 任务卡 | `strategist/tasks/T-105.yaml`（receiver_role=architect，P2，W1） |
| 产出物 | 本文件（本卡唯一写入范围，只写契约、不写代码） |
| 下游 | `T-209`（实现 `web/lib/canvas-perf.js`）→ `T-210`（实现 `tests/canvas-perf.test.mjs`）→ `T-504`（独立验收） |
| 侦察基线（只读） | `web/views/actors.js`（4669 行）、`src/modules/actors.js`（后端排布与端口表）、`src/http.js`（静态挂载）、`tests/canvas-audit.py`（E 段 LOD/裁剪断言）、`tests/test-actors.js` |
| 约束 | 零依赖 Node ≥ 22 ESM；不引入 npm 包；不改既有公开函数签名；中文注释与中文报错；不动白名单外文件 |

---

## 0. 契约摘要

把无限画布中**已被行号锁定**的三类纯逻辑——视口裁剪、LOD 分级、批量几何——抽成**无 DOM、无全局读写**的单一实现 `web/lib/canvas-perf.js`，使：

1. `T-209` 只新建 1 个文件即可落地，`T-210` 用 `node tests/canvas-perf.test.mjs` 离线（无浏览器、无服务、无临时库）验证；
2. 抽取前后**渲染判定完全等价**（同输入 → 同 `drawn` / 同 `lod` / 同 `imgCache`），并由既有 `tests/canvas-audit.py` E 段断言原地守住；
3. 200 卡位场景下的收益与判定指标可量化（§3），且明确**本轮抽取本身不提升帧率**，它锁定收益、消除三处漂移、为后续接线提供可测落点。

核心导出（`T-209` acceptance_criteria 已点名，签名以本契约为准）：
`visibleItems` / `lodLevelFor` / `shouldDrawLinks` / `cullStats`，另有本契约要求的配套导出 `LOD_THRESHOLDS`、`ZOOM_MIN`、`ZOOM_MAX`、`viewportOf`、`viewClipKeep`、`zOf`、`sortByZ`。

---

## 1. 现状基线（逐行反推，实现必须与之一致）

### 1.1 视图状态与常量（现状）

| 常量/字段 | 现状值 | 位置 |
|---|---|---|
| 缩放下限/上限 | `ZOOM_MIN = 0.05`、`ZOOM_MAX = 8` | `web/views/actors.js:390-392` |
| `clampZoom(z)` | `Math.max(0.05, Math.min(8, z))` | `web/views/actors.js:392` |
| LOD 阈值 | `< 0.22 → 0`、`< 0.5 → 1`、否则 `2` | `web/views/actors.js:401-405` |
| 裁剪留白 | 50（**世界单位，恒定，不随 zoom 变化**） | `web/views/actors.js:559` |
| 网格 1-2-5 序列 | `niceStep(base)` | `web/views/actors.js:394-399` |
| 视口尺寸来源 | `canvas.clientWidth / clientHeight`（CSS px，**不是** `canvas.width/dpr`） | `web/views/actors.js:414-415, 557-558` |
| 世界坐标换算 | `wx = (clientX - rect.left) / zoom - panX` | `web/views/actors.js:420-424` |

### 1.2 裁剪现状（必须 1:1 复刻）

```js
// web/views/actors.js:556-577（现状）
const vw = canvasEl().clientWidth / S.zoom;
const vh = canvasEl().clientHeight / S.zoom;
const view = { x0: -S.panX - 50, y0: -S.panY - 50, x1: -S.panX + vw + 50, y1: -S.panY + vh + 50 };
const ordered = [...L.items].sort((a, b) => zOf(a) - zOf(b));   // z 越大越靠上
for (const it of ordered) {
  if (it.x + it.w < view.x0 || it.x > view.x1 || it.y + it.h < view.y0 || it.y > view.y1) continue;  // 裁剪口径
  ...绘制...
  drawn++;
}
S._drawn = drawn;
```

- **裁剪口径（跳过条件，四个 `continue`）**：`it.x + it.w < view.x0 || it.x > view.x1 || it.y + it.h < view.y0 || it.y > view.y1`。
  等价可见定义（本契约采用）：`it.x + it.w >= view.x0 && it.x <= view.x1 && it.y + it.h >= view.y0 && it.y <= view.y1`。**闭区间**：与视口边界恰好相切的卡位必须可见（`T-210` 硬性断言）。
- `zOf`（现状 `:561`）：`it.kind === 'note' ? (it.note?.z || 0) : (it.node?.z || it.z || 0)`；排序稳定（等 z 保持输入顺序），**仅排序、不裁剪**。
- 被裁剪的卡位同时也不参与「查找命中描边」（`isFindHit` 在裁剪循环内，`:569`）。

### 1.3 连线现状（本契约**不裁剪连线**）

```js
// web/views/actors.js:609 + 1216-1226（现状）
if (S.showLinks !== false) drawLinks(g, L);
// drawLinks 内：if (!links.length) return;  …  for (link of links) { if (!a || !b) continue; … }
```

结论：连线只在「整体开关关闭」或「数组为空」时不画；**端点被裁剪到视口外时连线照画**（现状）。本契约的 `shouldDrawLinks` 只表达这个整体开关，禁止顺手改成视口裁剪（那会改变渲染行为）。

### 1.4 LOD 现状

| LOD | 触发 | 现状行为 | 位置 |
|---|---|---|---|
| 0 | `zoom < 0.22` | 只画色块 + 名字；**不新建 `Image()`**（`imageFor` 直接 return null）→ 图片零解码 | `:656`、`:745`、`:1411`（`drawPorts` 直接 return）、`:1259`/`:1276`（连线标签与槽位角标不画） |
| 1 | `0.22 ≤ zoom < 0.5` | 画图 + 名字；不画 ID 行；画连线标签 | `:696-744` |
| 2 | `zoom ≥ 0.5` | 全量：图 + 名字 + ID/角色/身高行 + 徽章 | `:740-744` |

`imgCache` 计数与 `imgLoaded`（`ok` 记录数）由 `:653-668` 维护，`__acDebug().imgCache/imgLoaded` 暴露给审计（`tests/canvas-audit.py:319-333` 的 E 段断言）。

### 1.5 批量几何现状：同一公式散落多处（抽取目标）

| 站点 | 文件:行号 | 现有公式（必须逐字等价） | 抽取目标 |
|---|---|---|---|
| 视图矩形（带 pad 50） | `actors.js:556-559` | 见 §1.2 | `viewportOf` |
| 裁剪判定 | `actors.js:564-565` | 见 §1.2 | `viewClipKeep` / `visibleItems` |
| 绘制统计 | `actors.js:560-577`、`:94`、`:613-626` | `drawn` 累加、HUD `（视野内 N）` | `cullStats` |
| z 排序 | `actors.js:561-563` | `zOf` + 稳定排序 | `zOf` / `sortByZ` |
| 命中测试 | `actors.js:1562-1570` | 从 `drawOrder` 末尾向前，`x>=it.x && x<=it.x+it.w && y>=it.y && y<=it.y+it.h`（闭区间） | `hitTestAt` |
| 框选命中 | `actors.js:1843-1854` | `it.x+it.w > x0 && it.x < x1 && it.y+it.h > y0 && it.y < y1`（**半开，与裁剪口径不同**） | `marqueeHitIds` |
| 内容包围盒 | `actors.js:475-482` | 卡片 + 分组框并集；空输入为 `±Infinity` | `boundsOf` |
| 宫格布局 | `actors.js:443-448`；后端 `src/modules/actors.js:944-948` | `x = 20 + col*(cell+gap)`、`y = 20 + row*(cell+gap)`、`col = i % cols`、`row = floor(i/cols)` | `matrixLayout` |
| 光标锚定缩放 | `actors.js:2197-2203` | `before = mx/zoom - panX` → `zoom2 = clamp(zoom*factor)` → `panX2 = mx/zoom2 - before.x` | `zoomAtPoint` |
| 适应窗口 | `actors.js:2310-2320` | `w = maxX-minX+2*40`；`zoom = clamp(min(cw/w, ch/h))`；`panX = -minX*zoom + (cw - (maxX-minX)*zoom)/2 - 40*zoom` | `fitViewport` |
| 缩放到选区 | `actors.js:2344-2355` | `zoom = clamp(min((cw-120)/(x2-x1), (ch-120)/(y2-y1)))`；`panX = -(x1 - 60/zoom)` | `zoomToRect` |
| 平移入视野 | `actors.js:2327-2341` | 四边比较 `pad/zoom`，仅在越界时改 pan | `ensureVisiblePan` |
| 吸附 + 参考线 | `actors.js:1615-1657` | 9 组候选对齐 + 6px 阈值 + 无参考线时半格吸附 + 有参考线时 `Math.round` + `guides.slice(0,4)` | `snapPosition` |
| 对齐 | `actors.js:2358-2375` | 基于**选区**包围盒；6 种模式；**不取整** | `alignOffsets` |
| 等距分布 | `actors.js:2382-2401` | 排序后 `gap = (span - Σsize)/(n-1)`、`cursor += size + gap`；**不取整** | `distributeOffsets` |
| 尺寸拖拽 | `actors.js:1866-1869` | `w = max(90, min(900, ow + dx))`、`h = max(90, min(1200, oh + dy))`（dx 未除 zoom，现状如此） | `resizeSize` |
| 找空位 | `actors.js:2894-2908` | 12 列 × 30 行步进 `(w+40, h+40)`，重叠阈值 ±20 | `freeSpot` |
| 端口坐标 | `actors.js:1323-1395` | `r = max(4, 6/zoom) + inset`；`f = count<=1 ? 0.5 : (index+1)/(count+1)` | `portPoint` / `portPointAt` / `edgeAnchor` |

> **漂移风险已存在**：宫格公式在前后端各写一遍（`actors.js:446-447` 与 `src/modules/actors.js:947`），端口表在前端 `NODE_KINDS`（`actors.js:1338-1353`）、后端 `PORT_RULES`（`src/modules/actors.js:779-793`）各一份。本契约只统一**几何**，不搬迁端口表（见 §2.7）。

---

## 2. 模块契约：`web/lib/canvas-perf.js`

### 2.1 运行环境与导入

| 项 | 要求 |
|---|---|
| 文件 | `web/lib/canvas-perf.js`（`T-209` 唯一写入范围，新建） |
| 依赖 | **零 import**：不 import `./api.js`、不 import DOM、不 require 任何包 |
| 全局 | 禁止出现 `window` / `document` / `navigator` / `localStorage` / `console` / `Date` / `performance` / `Math.random` |
| 副作用 | 无：不写文件、不发请求、不改入参对象、不改模块级可变状态（模块级只允许 `const` 常量表） |
| 浏览器侧 | 由 `web/views/actors.js` 以 `import { … } from '../lib/canvas-perf.js'` 引入（`/` 静态挂载到 `web/`，见 `server.js:24,103`，无需构建步骤） |
| Node 侧 | 测试用相对路径 `import('../web/lib/canvas-perf.js')`（与 `tests/test-novel.js:535` 同一手法），**不需要**临时库 / 临时端口 / 假实例 |
| 导出风格 | 与既有代码一致：`export function xxx(...)` / `export const xxx = …`；每个函数上方中文注释写明「语义 + 等价来源 `actors.js:行号`」 |

### 2.2 数据结构与字段名（唯一口径）

模块内只认下列字段名，**不得改名、不得新增同义字段**：

**Item（画布节点/卡位的渲染条目，由 `computeLayout()` 产出）**

| 字段 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `id` | string | 画布节点 id（`canvas_nodes.id`；无节点时 `actor:${actorId}`） | `actors.js:451` |
| `actorId` | string \| null | 演员 id（便签/资产节点为 null） | `actors.js:451,460,469` |
| `kind` | string | `actor` / `note` / `scene` / `item` / `refimg` / `shot` / `video` / `timeline` / `output` / `image` / `text` / `audio` / `overlay` / `subtitle` | `actors.js:453,460,468`、`ASSET_STYLE:896-912` |
| `x`,`y`,`w`,`h` | number | 世界坐标（左上角 + 宽高） | `canvas_nodes.x/y/w/h` |
| `actor` | object | 至少含 `{ id, name, style_id }` | `actors.js:462,471` |
| `node` | object \| undefined | 演员/资产/流程节点行（含 `z`、`locked`、`group_id`） | `canvas_nodes` |
| `note` | object \| undefined | 便签行（含 `z`） | `actors.js:460` |
| `locked` | boolean | 锁定 | `canvas_nodes.locked` |
| `groupId` | string \| null | 分组框 id | `canvas_nodes.group_id` |
| `z` | number \| undefined | 顶部层级（便签/资产用） | `canvas_nodes.z` |
| `index` | number | 宫格序号（仅演员卡） | `actors.js:452` |

**View（视口矩形，世界坐标）**：`{ x0, y0, x1, y1 }`，满足 `x0 ≤ x1`、`y0 ≤ y1`（由调用方保证；`pan` 为负时 `x0` 可为负）。
**Rect**：`{ x, y, w, h }`。
**Group（分组框）**：`{ id, name, color, x, y, w, h, collapsed }`（`canvas_groups`）。
**Link（连线）**：`{ id, from_node, to_node, from_actor, to_actor, from_side, to_side, from_port, to_port, slot, label, color }`（`canvas_links`）。

**表结构**：本卡**不新增、不修改任何表**（无 migration）。几何结构只**镜像**既有三张表的字段口径：`canvas_nodes(id, canvas_id, actor_id, kind, x, y, w, h, z, locked, group_id, note)`、`canvas_groups(id, canvas_id, name, color, x, y, w, h, collapsed)`、`canvas_links(id, canvas_id, from_node, to_node, from_actor, to_actor, from_side, to_side, from_port, to_port, slot, label, color)`。

### 2.3 导出清单

**核心批（`T-209` 必须完成，`T-210` 必须覆盖）**

| 导出 | 类型 | 一句话 |
|---|---|---|
| `ZOOM_MIN` / `ZOOM_MAX` | const number | `0.05` / `8` |
| `LOD_THRESHOLDS` | const object | `{ mid: 0.22, full: 0.5 }`（单一真源，`lodLevelFor` 与测试共用） |
| `CULL_PAD` | const number | `50`（裁剪留白，世界单位） |
| `clampZoom(zoom, min?, max?)` | function | 缩放夹取 |
| `lodLevelFor(zoom, thresholds?)` | function | `0 | 1 | 2` |
| `viewportOf(view)` | function | `{zoom,panX,panY,width,height,pad?}` → `View` |
| `viewClipKeep(item, view)` | function | boolean（裁剪口径） |
| `visibleItems(items, view)` | function | `Item[]`（保序、不排序、不复制元素） |
| `cullStats(items, view)` | function | `{ total, drawn, hidden, ratio }` |
| `zOf(item)` | function | number |
| `sortByZ(items)` | function | `Item[]`（新数组，稳定） |
| `shouldDrawLinks(input)` | function | boolean |

**扩展批（同文件允许导出，`T-209` 可分批交付；若导出必须满足 §2.5 的等价语义）**：
`hitTestAt` / `marqueeHitIds` / `boundsOf` / `matrixLayout` / `zoomAtPoint` / `fitViewport` / `zoomToRect` / `ensureVisiblePan` / `snapPosition` / `alignOffsets` / `distributeOffsets` / `resizeSize` / `freeSpot` / `niceStep` / `portPoint` / `portPointAt` / `edgeAnchor` / `resolvedLinks`。

> 交付时以 `node -e "import('./web/lib/canvas-perf.js').then(m=>console.log(Object.keys(m).sort().join(',')))"` 的原始输出作为导出清单证据（`T-209` evidence_required）。

### 2.4 核心函数签名与语义（逐字对齐现状）

```js
/** 缩放夹取：与 web/views/actors.js:392 等价 */
export function clampZoom(zoom, min = ZOOM_MIN, max = ZOOM_MAX) // → number

/** LOD 分级：与 actors.js:401-405 等价；zh: <0.22→0；<0.5→1；否则 2
 *  - 阈值取 LOD_THRESHOLDS（可传覆盖值）
 *  - 非有限数（NaN/Infinity）：两个 < 比较均 false → 返回 2（保持现状 JS 语义，不做兜底）
 *  - zoom 已是 0.05~8 的夹具（由 clampZoom 保证），函数本身不夹取、不报错
 */
export function lodLevelFor(zoom, thresholds = LOD_THRESHOLDS) // → 0|1|2

/** 视口矩形：与 actors.js:556-559 等价
 *  vw = width / zoom; vh = height / zoom
 *  x0 = -panX - pad; y0 = -panY - pad; x1 = -panX + vw + pad; y1 = -panY + vh + pad
 *  - pad 默认 CULL_PAD(50)，是世界单位，**不除以 zoom**（现状如此，禁止"修正"为 pad/zoom）
 *  - width/height 允许为 0（画布隐藏）：返回退化矩形（x1 = x0 + 2*pad），保持现状，禁止兜底扩边
 *  - 非有限输入原样传播（NaN 参与比较 → 结果与现状一致），不做归一化
 */
export function viewportOf({ zoom, panX = 0, panY = 0, width = 0, height = 0, pad = CULL_PAD })

/** 单卡裁剪判定（裁剪口径）：与 actors.js:564-565 的 continue 条件取反等价
 *  keep = item.x + item.w >= view.x0 && item.x <= view.x1
 *      && item.y + item.h >= view.y0 && item.y <= view.y1
 *  - 闭区间：恰好与边界相切（x + w === x0）→ true（必须可见，T-210 硬性断言）
 *  - 不含 pad：pad 已并入 view（由 viewportOf 负责）
 */
export function viewClipKeep(item, view) // → boolean

/** 批量裁剪：等价于 actors.js:564-565 的循环筛出
 *  - 返回新数组，**保持输入顺序**（不排序、不按 z 重排、不去重）
 *  - 元素为入参同一引用（不做浅/深拷贝，保持与现状同一对象身份：S._itemsById 依赖 identity）
 *  - 不读取任何全局状态
 */
export function visibleItems(items, view) // → Item[]

/** 绘制统计：与 actors.js:560-577 的 drawn 累加 + HUD 口径（:613,626）等价
 *  total = items.length
 *  drawn = visibleItems(items, view).length
 *  hidden = total - drawn
 *  ratio = total === 0 ? 0 : drawn / total   （空数组必须得 0，不得 NaN）
 *  - drawn 必须与 window.__acDebug().drawn 完全一致（迁移后），不得四舍五入
 */
export function cullStats(items, view) // → { total, drawn, hidden, ratio }

/** 层级：与 actors.js:561 等价 */
export function zOf(item)
// item.kind === 'note' ? (item.note?.z || 0) : (item.node?.z || item.z || 0)

/** z 升序稳定排序（z 大者后画=压在上面）：与 actors.js:562 等价
 *  - 返回新数组，不改入参
 *  - 稳定性显式保证：比较器为 (zOf(a) - zOf(b)) || (idxA - idxB)，禁止依赖引擎稳定性
 */
export function sortByZ(items) // → Item[]

/** 连线整体开关：与 actors.js:609 + 1218 等价
 *  return input.showLinks !== false && Array.isArray(input.links) && input.links.length > 0
 *  - **只表达整体开关**；不做端点解析、不做视口裁剪（见 §2.7）
 */
export function shouldDrawLinks({ showLinks, links }) // → boolean
```

### 2.5 扩展批签名与语义（同文件，允许不接线）

```js
export function hitTestAt(items, x, y)            // 末尾→头部扫，闭区间；无命中→null（actors.js:1562-1570）
export function marqueeHitIds(items, rect)        // 半开口径：it.x+it.w > rect.x && it.x < rect.x+rect.w && …（:1843-1854）
export function boundsOf(items, groups = [])      // → {minX,minY,maxX,maxY}；items 为空且无分组 → 四个 ±Infinity（:475-482）
export function matrixLayout({ count, cols, cell, gap, originX = 20, originY = 20 })
                                                  // → [{x,y,w,h}]；与 :443-448 及 src/modules/actors.js:944-948 同式
export function zoomAtPoint({ zoom, panX, panY, x, y, factor, min = ZOOM_MIN, max = ZOOM_MAX })
                                                  // → {zoom,panX,panY}（:2197-2203，含 clamp）
export function fitViewport({ bounds, width, height, padding = 40, min = ZOOM_MIN, max = ZOOM_MAX })
                                                  // → {zoom,panX,panY}（:2310-2320；空内容短路仍由调用方负责）
export function zoomToRect({ rect, width, height, padding = 60, min = ZOOM_MIN, max = ZOOM_MAX })
                                                  // → {zoom,panX,panY}（:2344-2355）
export function ensureVisiblePan({ panX, panY, rect, zoom, width, height, pad = 40 })
                                                  // → {panX,panY,changed}（:2327-2341）
export function snapPosition({ item, x, y, others, snap, cell, threshold = 6 })
                                                  // → {x,y,guides}；guides 截断为 4 条；snap 时半格吸附或 Math.round（:1615-1657）
export function alignOffsets(items, mode)         // mode ∈ left|right|center-x|top|bottom|center-y；**不取整**（:2358-2375）
export function distributeOffsets(items, axis)    // axis ∈ x|y；gap 为浮点、cursor 累加；**不取整**（:2382-2401）
export function resizeSize({ w, h }, dx, dy)      // → {w: max(90,min(900,w+dx)), h: max(90,min(1200,h+dy))}（:1866-1869）
export function freeSpot({ items, baseX, baseY, w = 260, h = 220, step = 40, cols = 12, rows = 30 })
                                                  // → {x,y}；重叠判定用 ±20 外扩（:2894-2908）
export function niceStep(base)                    // 1-2-5 序列（:394-399）
export function portPoint(item, side, { zoom, inset = 0 })
export function portPointAt(item, side, index, count, { zoom, inset = 0 })
export function edgeAnchor(item, portName, side, { zoom, out = [], in = [] })
                                                  // r = max(4, 6/zoom) + inset；f = count<=1 ? 0.5 : (index+1)/(count+1)（:1323-1395）
export function resolvedLinks(links, items)       // 端点可解析的连线（对应 drawLinks 的 `if (!a||!b) continue`），保序
```

### 2.6 入参校验与中文报错

- 参数类型错误 → `throw new TypeError('canvas-perf.visibleItems：items 必须是数组，收到 ' + typeof items)`（全中文，含函数名与实参类型）。
- `view` 必须是含 4 个有限数键 `x0/y0/x1/y1` 的对象 → 否则 `throw new TypeError('canvas-perf.visibleItems：view 必须是 {x0,y0,x1,y1}，收到 ' + JSON.stringify(view))`。
- **不校验数值业务合法性**（`panX` 任意、`zoom` 任意）：现状不校验，加了校验会改变行为（例如隐藏画布 `width=0`、极限缩放 `zoom=0.05`）。
- 不抛业务错误的函数不得用 `return undefined` 表示失败：`visibleItems` 恒返回数组，`cullStats` 恒返回四键对象，`hitTestAt` 以 `null` 表示未命中。

### 2.7 明确不做（防止越界改行为）

1. **不裁剪连线**：`shouldDrawLinks` 只做整体开关；连线端点被裁掉仍要画（现状）。
2. **不搬迁端口表**：`NODE_KINDS`（`actors.js:1338-1353`）与后端 `PORT_RULES`（`src/modules/actors.js:779-793`）保持原位；`edgeAnchor`/`portPointAt` 通过 `out`/`in` 参数接收端口列表，**禁止在本模块复制第三份端口表**。
3. **不做布局缓存 / 不做 memo**：`computeLayout()` 的调用时机与缓存策略不属于本卡（缓存失效条件未定义，属行为变更）。
4. **不改裁剪留白与 LOD 阈值**：`50`、`0.22`、`0.5` 逐字保留（`T-210` 会锁死）。
5. **不引入 rAF / 节流 / 离屏 canvas**：那是绘制策略，不是纯逻辑。
6. **不合并裁剪口径与框选口径**：一个闭区间语义、一个半开语义，必须两个函数、两个名字。

---

## 3. 200 卡位下的预期收益与判定指标

### 3.1 收益来自哪里（先讲清"本轮抽取代价 = 0 收益"）

| 类别 | 说明 |
|---|---|
| **已生效、本契约负责锁定的收益** | ①视口裁剪：只绘制视野内卡位（`actors.js:564-577`）；②LOD0：`zoom < 0.22` 时**完全不新建 `Image()`**，避免一次性解码上百张定妆图（`actors.js:653-656`）。两者现状已存在，抽取后由离线测试 + 既有审计双重锁定，防回归 |
| **抽取新增的收益** | ①单一实现：宫格公式/视口公式不再在多处手抄（`actors.js:556-565` 与 `:2310-2355` 各写一遍），消除漂移；②可在**无浏览器、无服务**下回归（`node tests/canvas-perf.test.mjs`），把原先只能靠 Playwright 审计发现的问题前移到单元层；③为后续接线（拖动/缩放每帧重复的 O(n) 布局与 z 排序）提供唯一落点 |
| **本轮不承诺** | 帧率/FPS、单帧 ms、内存占用数字——未做压测，不做编造（§3.4） |

### 3.2 解析计算（口径与前提，可离线复算）

前提：`cols=5`、`cell=210`、`gap=14` → **pitch=224**、原点 `20`（宫格公式与 `src/modules/actors.js:947` 一致）；视口 **1320×860 CSS px**（审计浏览器 1720×1020 减去左侧演员栏与工具栏后的量级）；`pan=0`（视口在内容左上）；`pad=50`；裁剪口径 = §1.2 闭区间。

**200 卡位**（布局占用 1106×8946 世界单位；`fitView` 缩放 ≈ 0.0953 → **LOD 0**）

| zoom | LOD | 世界视口 | drawn/200 | 比例 |
|---|---|---|---|---|
| 0.05 | 0 | 26500×17300 | 200 | 100% |
| 0.10 | 0 | 13300×8700 | 195 | 97.5% |
| 0.12 | 0 | 11100×7267 | 165 | 82.5% |
| 0.22 | 1 | 6100×4009 | 90 | 45.0% |
| 0.35 | 1 | 3871×2557 | 60 | 30.0% |
| 0.50 | 2 | 2740×1820 | 40 | 20.0% |
| 1.00 | 2 | 1420×960 | 20 | 10.0% |
| 2.00 | 2 | 760×530 | 12 | 6.0% |
| 4.00 | 2 | 430×315 | 4 | 2.0% |
| 8.00 | 2 | 265×208 | 1 | 0.5% |

**1000 卡位**（同几何；`fitView` 缩放 ≈ 0.0192）：`zoom=0.1 → 195/1000 (19.5%)`、`0.22 → 90 (9%)`、`1.0 → 20 (2%)`、`8 → 1 (0.1%)`。

结论（用函数自身统计即可复现，不依赖压测）：
- **低缩放（0.05~0.12）裁剪几乎无收益**（97.5%~100% 可见）→ 该区间的流畅性由 **LOD0 免解码** 决定，这是 200 卡位场景的最大一笔；
- **高缩放（≥1）裁剪收益显著**（10% → 0.5%），`drawCell` 调用量随 `drawn` 近似线性下降；
- **200 卡位的 `fitView` 必然落在 LOD0**（内容高 8946 > 视口高 860），因此「适应窗口后是否卡」= 「LOD0 是否生效」。

### 3.3 判定指标（可执行，逐条给归属与命令）

| # | 指标 | 判定口径 | 归属 | 命令 |
|---|---|---|---|---|
| M1 | 裁剪正确性 | `visibleItems(items, viewportOf(v)).length === cullStats(items, viewportOf(v)).drawn`；与 `__acDebug().drawn` 同帧一致 | T-210 | `node tests/canvas-perf.test.mjs` |
| M2 | 边界不丢 | 卡位与视口四边**恰好相切**时 `viewClipKeep === true`（4 条，`x+w===x0`、`x===x1`、`y+h===y0`、`y===y1`）；越界 1px 时为 false | T-210 | 同上 |
| M3 | LOD 阈值 | `0.21999→0`、`0.22→1`、`0.49999→1`、`0.5→2`、`0.05→0`、`8→2`；`LOD_THRESHOLDS` 被 `lodLevelFor` 与测试共用（改阈值必须同时改一处） | T-210 | 同上 |
| M4 | LOD0 免解码（端到端锁死） | `zoom=0.12` 重载后 `imgCache === 0 && imgLoaded === 0`；`zoom=1` 时 `lod===2 && imgLoaded>0 && drawn===items`；`zoom=4` 时 `drawn < items` | 既有审计（不改期望） | `python3 tests/canvas-audit.py`（E 段，`tests/canvas-audit.py:312-338`；6 条断言在 `:317/:318/:327/:331/:333/:337`） |
| M5 | 200/1000 卡位统计 | 用 `matrixLayout({count:200,cols:5,cell:210,gap:14})` + `viewportOf` 复算 §3.2 表中全部 10 行 `drawn`，逐行相等（含 1000 卡的 4 个抽查点） | T-210 | `node tests/canvas-perf.test.mjs` |
| M6 | 纯函数预算（**预算，非实测承诺**） | 200 卡位单次 `visibleItems`+`cullStats` 合计 ≤ 1 ms；1000 卡位 ≤ 5 ms（`node` 单进程计时，取 100 次均值；实测值写入 evidence 原文，不写死进断言） | T-210 | 同上（输出尾部含实测 ms） |
| M7 | 行为不变 | 迁移后既有断言全绿：`node tests/test-actors.js` 与 `tests/canvas-audit.py` 全部既有 ✅ 不变；`__acDebug()` 字段名/口径零变化 | T-505 | `bash scripts/verify-all.sh`（由集成/验收卡执行） |
| M8 | 模块洁净 | 源码中不出现 `window`/`document`/`navigator`/`localStorage`/`console`/`performance`/`Date`/`Math.random`，且**无任何 `import` 语句**（可用 `grep -nE` 自查并保留原始输出） | T-504 | `node --check web/lib/canvas-perf.js` + `grep` |

### 3.4 不承诺的数字（禁止在实现说明/文档中编造）

1. 不承诺具体帧率/FPS 提升（未做压测）。
2. 不承诺 `drawn` 下降直接等于耗时下降 X%（`drawCell` 成本随 LOD/图片/文字而异）。
3. 不承诺最小化/小地图的绘制量下降：`drawMinimap`（`actors.js:1523-1526`）**按设计绘制全部卡片**、`drawGroupFrames`（`:819-820`）与 `drawLinks` 也仍是 O(n)/O(n×组) 每帧——本契约**不改变**这些现状，也不改善；要改善须另开任务卡（且属行为/性能策略变更）。

---

## 4. 明确不改变现有渲染行为

### 4.1 等价性条款（抽取的验收底线）

对任意输入，迁移前后必须满足**逐位相同**：

| 输出 | 等价要求 |
|---|---|
| `drawn`（`__acDebug().drawn`、HUD「视野内 N」） | 整数完全相等 |
| `lod`（`__acDebug().lod`、HUD「LOD 简/中/全」） | 完全相等 |
| 绘制顺序（`drawOrder`、悬停/点击后的命中目标） | 完全相等（同 z 的相对顺序不变） |
| `imgCache` / `imgLoaded` 计数 | 完全相等（LOD 阈值不变则解码时机不变） |
| 命中判定（`hitTest` / 框选 / 端口命中） | 完全相等（闭区间 vs 半开区间分别保留） |
| 写回库的坐标 | 完全相等（`alignOffsets`/`distributeOffsets` 保持原浮点、不取整；`snapPosition` 保持原取整规则） |

### 4.2 禁止的"顺手优化"清单（任一出现即视为行为变更，判 FAIL）

1. 把裁剪留白 50 改成 `50 / zoom`；
2. 把裁剪闭区间改成半开（或反之），或"统一"裁剪口径与框选口径；
3. 在 LOD0 下仍然预建 `Image()` 或预热缓存；
4. 给 `width=0`（画布隐藏）加"兜底全可见"；
5. 对 `align/distribute` 结果做 `Math.round`（现状写浮点）；
6. 对 `snapPosition` 去掉「有参考线时 `Math.round`」的那步（该步是既有回归修复，见 `actors.js:1649-1654` 注释）；
7. 为"性能"给 `draw()` 加 rAF 节流/跳帧；给 `computeLayout()` 加缓存；
8. 改 `zoomToSelection` / `fitView` 的 padding（60 / 40）或公式顺序；
9. 改 `resizeSize` 的上限（900/1200）或补上缺失的 `/ zoom`（现状 dx 未除 zoom，保持原样）。

### 4.3 回归证据（既有测试期望一字不改）

- `tests/canvas-audit.py` E 段（`:312-338`，断言在 `:317/:318/:327/:331/:333/:337`）已对「LOD 简/中/全 + LOD0 零解码 + 高缩放裁剪生效」做出 6 条断言 → 抽取后必须**原样**全部通过，不得修改该文件（它在 `T-504`/`T-505` 的只读验收范围内）。
- `tests/test-actors.js`（411 行，含画布/连线/分组/视图持久化）与 `tests/selfcheck.js`「6. 宫格画布」段必须全绿。
- `T-209` 只新建 `web/lib/canvas-perf.js`、`T-210` 只新建 `tests/canvas-perf.test.mjs`：**接线（改 `actors.js`）不在两卡写入范围**，因此两卡交付时 `actors.js` 必须零改动。证据方式：交付前记录 `md5sum web/views/actors.js`（侦察时基线 `4669` 行），交付后再次 `md5sum` 应一致（该仓库**不是 git 工作树**，`git status` 不可用，勿在证据里引用 git 命令）。

---

## 5. 接线方案（供后续集成卡使用，不在 `T-209` 写入范围）

接线原则：**替换表达式、不替换决策**；每处替换后跑一次 §3.3 的 M7。

| 顺序 | 位置 | 现状 | 接线后 | 风险 |
|---|---|---|---|---|
| 1 | `actors.js:401-405` | `lodLevel()` 内联阈值 | `lodLevelFor(S.zoom)`（保留 `lodLevel()` 作为薄封装，避免改调用点） | 低 |
| 2 | `actors.js:556-565` | 内联 view + 4 条件 `continue` | `viewportOf(...)` + `viewClipKeep` | **中**（边界语义，M2 覆盖） |
| 3 | `actors.js:562` | `[...L.items].sort(...)` | `sortByZ(L.items)` | 低（稳定性显式化） |
| 4 | `actors.js:560-577` | `drawn++` 手数 | 循环内改 `cullStats` 统计（`S._drawn = stats.drawn`） | 低 |
| 5 | `actors.js:609` | `if (S.showLinks !== false) drawLinks(g, L)` | `if (shouldDrawLinks({ showLinks: S.showLinks, links: S.links })) …` | 低 |
| 6 | 扩展批各处 | `:1562`、`:1843`、`:475`、`:2310`、`:2344`、`:2327`、`:1615`、`:2358`、`:2382`、`:1866`、`:2894`、`:2197` | 对应扩展函数 | 中（浮点/取整语义，逐处跑 `test-actors.js` + 审计） |

回滚：接线卡在动 `web/views/actors.js` 前先备份 `cp web/views/actors.js /tmp/actors.js.bak.$(date +%s)`（本仓库非 git 工作树，无 `git checkout` 可回退），出问题 `cp` 回原位并用 `md5sum` 核对；`canvas-perf.js` 为新增文件，保留不影响运行（无人 import 即死代码，`node --check` 仍可通过）。

---

## 6. 测试要求（`T-210`：`tests/canvas-perf.test.mjs`）

镜像既有测试风格（`tests/test-actors.js:39-43` 的 `ok(name, cond, extra)` + 末尾总计数）或 `node:test`；**不需要**临时库/临时端口/假后端（纯函数无 IO）。≥10 条断言，至少覆盖：

| # | 用例 | 期望 |
|---|---|---|
| 1 | 空数组 | `visibleItems([], v)` → `[]`；`cullStats([], v)` → `{total:0,drawn:0,hidden:0,ratio:0}`（`ratio` 不得为 NaN） |
| 2 | 全部在视口内（200 卡 `zoom=0.05`） | `drawn === 200` |
| 3 | 边界相切（4 条边） | 全部 `viewClipKeep === true`（M2） |
| 4 | 越界 1px（4 条边） | 全部 `false` |
| 5 | 保序性 | `visibleItems` 结果顺序与输入一致；`sortByZ` 在等 z 时保持输入顺序 |
| 6 | LOD 阈值（6 个采样点） | M3 表 |
| 7 | 裁剪前提：`pad=50` 不随 zoom 变化 | `viewportOf({zoom:0.05,…}).x0 === -panX-50` 且 `zoom:8` 同样 |
| 8 | `shouldDrawLinks` | `{showLinks:false, links:[1]}` → false；`{showLinks:undefined, links:[]}` → false；`{showLinks:true, links:[1]}` → true |
| 9 | 统计口径 | `hidden === total - drawn`；`ratio === drawn/total`（浮点相等） |
| 10 | 200/1000 卡解析表（M5） | §3.2 表逐行相等（≥14 个点） |
| 11 | 中文报错 | `visibleItems('x', v)` 抛 `TypeError` 且 `/必须是数组/`；`visibleItems([], null)` 抛且 `/x0/` |
| 12 | 入参不被修改 | 传入 `items`/`item` 前后 `JSON.stringify` 相等 |
| 13 | 预算（M6） | 打印 200/1000 卡实测 ms（作为 evidence，不断言绝对值小到会 flaky 的程度——建议断言 `≤ 预算` 并在输出尾部打印实测值） |

---

## 7. 风险与不适用场景

| 风险 | 影响 | 处置 |
|---|---|---|
| 抽取时"顺手统一"裁剪与框选口径（闭区间 vs 半开） | 边缘卡位在框选/命中上出现 ±1px 行为变化，`canvas-audit.py` 相关断言可能静默漂移 | §4.2 明列禁止项；两个名字两个函数（M2 覆盖） |
| 端口表被复制进 `canvas-perf.js` | 与 `NODE_KINDS`/`PORT_RULES` 三方漂移 | §2.7 禁止；端口列表作为参数传入 |
| 阈值/留白"顺手优化" | LOD 切换点变化会改变 200 卡位的解码量，属行为变更 | 阈值集中在 `LOD_THRESHOLDS` + `CULL_PAD`，M3/M4 锁死 |
| 只导出不接线 → 死代码 | 收益仅限"可测"，无运行时收益 | 预期管理见 §3.1；接线由后续集成卡（T-402 同族任务）承担 |
| 低缩放区裁剪几乎无效 | 误以为"抽了纯函数就快了" | §3.2 表给出 0.05~0.12 区间 97.5%~100% 可见的事实 |
| 小地图/分组框/连线仍是每帧 O(n) | 1000 卡位下每帧 1000 次 `fillRect` 等成本依旧 | §3.4 明确不承诺改善；如需优化另开卡（属行为/策略变更） |
| 测试断言写死"实测 ms" | 在慢机器上 flaky，进而诱发"改期望凑绿" | M6/M13 把 ms 当 evidence 打印，断言只对**预算上界** |
| 隐藏画布（`width=0`）时的极端裁剪 | 现状即"几乎全裁"，若加兜底会改变行为 | §2.4/§4.2 明确禁止兜底；测试保留该口径 |

**不适用场景**：本契约只覆盖**纯几何/分级判定**。不覆盖——WebGL 化、OffscreenCanvas、Worker 化、虚拟滚动 DOM 方案、布局缓存与增量失效、绘制节流策略、图片解码调度（`imgCache` 淘汰策略）。以上均需单独任务卡与行为评审。

---

## 8. 证据与命令（本卡自证 + 下游可复现）

本卡（W1，只写契约文件）：

```bash
cd /home/linsheng/Desktop/ai-video-factory
node -e "require('node:fs').accessSync('strategist/reports/T-105-canvas-perf-spec.md')"   # 任务卡 quality_checks
wc -l strategist/reports/T-105-canvas-perf-spec.md
grep -c '^export function\|^export const' strategist/reports/T-105-canvas-perf-spec.md     # 契约内签名数量
ls -l strategist/reports/                                                                   # 期望：本卡产出本报告（本仓库非 git 工作树，无 git status 可用）
md5sum web/views/actors.js                                                                  # W1 基线指纹：供 T-209/T-210 证明"零改动"
```

`T-209`（实现）与 `T-210`（测试）可复现命令：

```bash
node --check web/lib/canvas-perf.js
node -e "import('./web/lib/canvas-perf.js').then(m=>console.log(Object.keys(m).sort().join(',')))"
node tests/canvas-perf.test.mjs
```

契约级等价性回归（由验收卡在既有 8788 实例上只读执行，**不要重启服务、不要并发跑 verify-all.sh**）：

```bash
node tests/test-actors.js
python3 tests/canvas-audit.py http://127.0.0.1:8788      # E 段 5 条断言必须原样通过
```
