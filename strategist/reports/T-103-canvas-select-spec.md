# T-103 画布类型筛选与多选批处理契约

| 项 | 值 |
|---|---|
| 任务卡 | `strategist/tasks/T-103.yaml` |
| 角色 | 架构/运维/文档军师（只读侦察，产出契约） |
| 优先级 | P1 |
| 依赖 | 无（本卡不依赖任何上游任务） |
| 产出物 | 本文件（`strategist/reports/T-103-canvas-select-spec.md`），**不写任何代码** |
| 交付形态 | 可直接指导实现的契约：函数签名 / 表结构 / 字段名 / 中文报错文案 / 前置校验 / 与撤销·快照·主画布保护的交互 |

> **本文件的性质**：所有「既有事实」均来自对当前仓库源码的只读核对，逐条标注 `文件:行号`。
> 凡标注「**新增**」的，是本契约要求实现方新增的内容；凡标注「**既有**」的，是当前代码已经存在、必须复用且**不得改签名**的内容。
> 本卡不做任何实现、不改既有文件、不跑测试。

---

## 0. 阅读顺序

| 你要做什么 | 读哪节 |
|---|---|
| 快速理解边界与红线 | §1 术语与不变量 |
| 写筛选逻辑 | §3 筛选项契约（AC-1） |
| 写批处理动作 | §4 批处理动作契约（AC-2） |
| 决定什么时候该确认/该拦 | §4.8 危险动作清单 + §5 与撤销·快照·主画布保护的交互（AC-3） |
| 动手改代码 | §6 实现点清单 |
| 写测试 | §7 测试契约 |
| 评估风险 | §8 风险与既有缺口 |

---

## 1. 术语与不变量

### 1.1 三种「节点」，一次说清

画布上的「节点」在三个层面用同一批 id，但结构不同，**混用是这次改造最大的坑**。

| 层 | 名字 | 结构 | 来源 |
|---|---|---|---|
| 持久层 | **节点行** | `canvas_nodes` 表的一行 | `src/db.js:101-107` + `src/db.js:345` 补列 |
| 视图层 | **layout item** | `computeLayout()` 产出的对象数组 `S._layout.items` | `web/views/actors.js:427-483` |
| 交互层 | **选中 id** | `S.selection`（`Set<actorId>`）+ 四个单选句柄 | `web/views/actors.js:64-77` |

layout item 的字段全集（**契约以此为准**，`web/views/actors.js:449-473`）：

```js
// 演员卡（第 449-454 行）
{ id, actorId, actor, index, x, y, w, h, node, locked, groupId, kind: 'actor' }
// 便签（第 459-463 行）—— 另有 note
{ id, actorId: null, actor, x, y, w, h, node, locked, groupId, z, kind: 'note', note }
// 资产/流程节点（第 468-473 行）—— 另有 asset、z
{ id, actorId: null, actor, asset, x, y, w, h, node, locked, groupId, z, kind }
```

- `item.id` = **画布节点 id**（`node.id`）；`item.actorId` = 演员 id。二者不同。
- `item.node` = 原始 DB 行；**可能为 `null`**（见不变量 I2）。
- `item.locked` 是 `Boolean(node?.locked)`。
- `item.groupId` 是 `node.group_id || null`。

> ⚠️ 三处历史命名不一致，实现时必须转换，不得「顺手统一」：
> - `S.selection` 存的是 **actorId**（演员）或 **node id**（便签/资产/流程），`web/views/actors.js:1600-1612`。
> - `S.selectedOrder` 是 `Array`，只为多选顺序角标与「批量生成」排序服务（`web/views/actors.js:777-786`）。
> - 非演员节点**当前只有单选**句柄：`S.selectedExtra`（资产/流程）、`S.selectedNote`（便签）、`S.selectedGroup`（分组框）、`S.selectedLink`（连线），`web/views/actors.js:71-72`。

### 1.2 五条不变量（实现必须成立，验收按此检查）

| 编号 | 不变量 | 依据 / 理由 |
|---|---|---|
| **I1** | **筛选是纯 UI 内存态**：不落库、不写 `canvases.layout`、不跨刷新持久化 | 与既有 `S.filter` / `S.styleFilter` 一致（`web/views/actors.js:67`，只影响 `renderList()`） |
| **I2** | **幽灵卡位**：`showAll !== false` 时（主画布默认），演员表里的演员即使没有 `canvas_nodes` 行也会出现在画布上，此时 `item.node === null`、`item.id === 'actor:' + actorId` | `web/views/actors.js:308`、`430`、`443`、`451` |
| **I3** | **筛选与选中集解耦**：改变筛选条件**不得**修改 `S.selection` / `S.selectedOrder` | 避免「筛一下选中集就没了」的隐性数据丢失 |
| **I4** | **批处理只作用于「可见且被选中」的项**：不可见项（被筛掉 / 在折叠分组内）永不被批处理命中 | `computeLayout()` 已把折叠分组隐藏（`web/views/actors.js:432-436`）；筛选沿用同一机制 |
| **I5** | **撤销快照必须覆盖全部卡位**（含被筛选/被折叠隐藏的） | 既有实现已如此并要求保持：`web/views/actors.js:2596` 注释原文「必须记录『该画布上的全部卡位』（含被筛选/折叠隐藏的），否则撤销恢复会丢卡片」 |

---

## 2. 数据基线（真实表结构与字段名）

> 本节只列本次改造需要读写的字段。**所有字段名以本表为准，不得自创。**

### 2.1 `canvas_nodes`（节点/卡位）

`src/db.js:101-107`（建表）+ `src/db.js:345`（后续补列）：

```sql
CREATE TABLE IF NOT EXISTS canvas_nodes (
  id TEXT PRIMARY KEY,
  canvas_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,        -- 演员卡=演员 id；便签/资产/流程节点=''
  x REAL DEFAULT 0, y REAL DEFAULT 0, w REAL DEFAULT 180, h REAL DEFAULT 220,
  z INTEGER DEFAULT 0, locked INTEGER DEFAULT 0, note TEXT
);
CREATE INDEX IF NOT EXISTS idx_canvas_nodes ON canvas_nodes(canvas_id);
-- 第 345 行补列：
--   group_id TEXT, kind TEXT DEFAULT 'actor', color TEXT, title TEXT, data TEXT
```

| 字段 | 类型 | 本次用途 |
|---|---|---|
| `id` | TEXT PK | 节点 id，`ND-*` 前缀 |
| `canvas_id` | TEXT | 所属画布 |
| `actor_id` | TEXT | 演员卡=演员 id；**其他类型恒为 `''`**（`createAsset` 第 686 行、`createNote` 第 749 行） |
| `x`,`y`,`w`,`h` | REAL | 几何（移动/缩放） |
| `z` | INTEGER | 层级；置顶用 `100000 + index`（`web/views/actors.js:3820`） |
| `locked` | INTEGER 0/1 | **锁定维度唯一依据** |
| `note` | TEXT | 便签内容 `JSON.stringify({text,color})`；演员卡另作他用 |
| `group_id` | TEXT | 所属分组框 id；`NULL`/`''` = 未分组 |
| `kind` | TEXT DEFAULT `'actor'` | **类型维度唯一依据**；读取时兜底为 `'actor'`（`src/modules/actors.js:269`） |
| `color` | TEXT | 便签底色 / 节点色 |
| `title` | TEXT | 资产/流程节点标题 |
| `data` | TEXT(JSON) | **有产物/失败维度唯一依据**（`status` / `lastFile` / `lastError` / `lastAt` / `lastRunId`），便签为 asset 参数 |

### 2.2 `canvas_groups`（分组框）

`src/db.js:219-228`：

```sql
CREATE TABLE IF NOT EXISTS canvas_groups (
  id TEXT PRIMARY KEY, canvas_id TEXT NOT NULL, name TEXT, color TEXT,
  x REAL DEFAULT 0, y REAL DEFAULT 0, w REAL DEFAULT 240, h REAL DEFAULT 240,
  collapsed INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_canvas_groups ON canvas_groups(canvas_id);
```

- 「分组维度」= `canvas_nodes.group_id` → `canvas_groups.id`。
- `collapsed = 1` 时组内节点不绘制、不命中（`web/views/actors.js:432-436`），因此按 I4 不参与批处理。

### 2.3 `canvas_links`（连线）

`src/db.js:245-258` + `src/db.js:346-352` 补列：

```sql
id, canvas_id, from_actor, to_actor, from_node, to_node,
from_side, to_side, from_port, to_port, slot, label, color, created_at
```

- **删除节点的连带清理只认 `from_node` / `to_node`**（`src/modules/actors.js:868`、`85-87`）。
- ⚠️ 既有缺口见 §8 R2。

### 2.4 `canvas_node_runs`（执行流水）

`src/db.js:261-275`，权威列定义在 `src/graph.js:41-55`（20 列）：

```sql
id, canvas_id, node_id, job_id, kind, status, file_path, mime, width, height,
duration, prompt, negative, seed, backend, model, input_fp, error, meta, created_at
-- 索引：idx_node_runs_node(node_id, created_at)、idx_node_runs_job(job_id)
```

`status` 取值（**仅三个**，见 `src/graph.js:696`、`725`、`750`、`772`）：`done | skipped | error`。
**没有 `failed`**。

### 2.5 `canvas_snapshots`（服务端命名快照）

`src/db.js:230-243`：

```sql
CREATE TABLE IF NOT EXISTS canvas_snapshots (
  id TEXT PRIMARY KEY, canvas_id TEXT NOT NULL, name TEXT, note TEXT,
  kind TEXT DEFAULT 'manual',   -- manual | auto
  payload TEXT NOT NULL,        -- { nodes, groups, links, view, cols, cell, layout, stats }
  node_count INTEGER DEFAULT 0, group_count INTEGER DEFAULT 0, link_count INTEGER DEFAULT 0,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_canvas_snapshots ON canvas_snapshots(canvas_id, created_at);
```

- 单画布上限 `MAX_PER_CANVAS = 40`（`src/snapshots.js:13`），`pruneSnapshots` **优先淘汰最旧的 `auto`**（`src/snapshots.js:72-73`）。
- **无 scope / 无发起方字段**（`grep -c scope src/snapshots.js` = 0）。

### 2.6 `kind` 全集（前后端各一份，必须同步）

**前端权威**：`NODE_KINDS`（`web/views/actors.js:1338-1353`，14 个键）

```
actor, note, scene, item, refimg, text, image, video, shot, timeline, audio, overlay, subtitle, output
```

**后端权威**：`src/modules/actors.js:640-642`

```js
export const ASSET_KINDS = ['scene', 'item', 'refimg', 'audio'];
export const FLOW_KINDS  = ['image', 'video', 'text', 'shot', 'timeline', 'output', 'overlay', 'subtitle'];
export const CREATABLE_KINDS = [...ASSET_KINDS, ...FLOW_KINDS];   // 12 个
```

**归类表（契约直接使用）**：

| 归类 | 成员 | 说明 |
|---|---|---|
| 演员卡 | `actor` | `actor_id` 非空；唯一可被 `POST /api/canvas/nodes` 批量改几何的类型 |
| 便签 | `note` | 无产物概念 |
| 素材源 | `scene` `item` `refimg` | 有「参考图」即视为有产物 |
| 可执行节点 | `image` `video` `text` `audio` `overlay` `subtitle` `output` `timeline` | **= `EXECUTABLE`**（`src/graph.js:24`），是按类型重跑的唯一有效集合 |
| 容器 | `shot` | 分镜容器，**不在 `EXECUTABLE` 内**，会被计划列入 skip 清单（`src/graph.js:377-378`） |

> ⚠️ **既有不一致（照抄现状，本卡不修）**：`audio` 在前端 `FLOW_KINDS`（`web/views/actors.js:912`）里，在后端归 `ASSET_KINDS`。
> 筛选实现必须按 **`NODE_KINDS` 的 14 键** 给用户看，按 **`CREATABLE_KINDS`** 判断「可编辑素材/流程节点」（`updateAsset` 的准入，`src/modules/actors.js:694`），按 **`EXECUTABLE`** 判断「可执行」。三者不可互相替代。

### 2.7 「有产物 / 失败 / 锁定 / 分组」的权威字段

| 维度 | 字段 | 取值 | 依据 |
|---|---|---|---|
| **锁定** | `canvas_nodes.locked` | `0` / `1` | `src/db.js:106`；写入口 `setNodeLocked`（`src/modules/actors.js:974-977`）+ `POST /api/canvas/node/:id/lock`（`src/routes/actors.js:194-196`） |
| **分组** | `canvas_nodes.group_id` | 分组 id / `NULL` | `src/db.js:345` |
| **失败** | `JSON.parse(canvas_nodes.data).status === 'error'` | 仅 `error` 判失败 | 写入口 `writeNodeStatus`（`src/graph.js:289-301`），失败写入见 `src/graph.js:769` |
| **有产物** | 见下表（分类型） | — | — |
| **运行态** | `JSON.parse(canvas_nodes.data).status` | `done \| running \| error \| skipped`；缺省 = 未执行 | `web/views/actors.js:1041-1042` 渲染徽标用的就是这四个值 |
| **产物文件** | `JSON.parse(canvas_nodes.data).lastFile` | 文件相对路径 / 缺省 | `web/views/actors.js:1134`；写回见 `src/graph.js:750-761` |
| **失败原因** | `JSON.parse(canvas_nodes.data).lastError` | 中文原因 | `web/views/actors.js:1135` |

**「有产物」判定表（契约，按 `kind` 分流）**：

| kind | 判定 | 依据 |
|---|---|---|
| `actor` | `Boolean(actor.cover_image)` —— 该演员有定妆主图 | `getCanvas` 的 JOIN 已带出 `cover_image`（`src/modules/actors.js:266-267`）；`primaryImageOf`（`src/modules/actors.js:40-44`） |
| `note` | **恒 false**（便签没有产物概念） | `createNote` 写的 `data` 是 `{text,color}`，无 `lastFile` |
| `scene` `item` `refimg` | `asset.refImages.length > 0` | `getCanvas` 对资产类型解析出 `asset`（`src/modules/actors.js:275`）；`parseAsset`/`setAssetRefImages`（`src/modules/actors.js:666-674`、`705-716`） |
| 其余流程型（`image` `video` `text` `audio` `overlay` `subtitle` `output` `timeline` `shot`） | `Boolean(data.lastFile)` | `writeNodeStatus` 写的 `lastFile`（`src/graph.js:761`）；后端等价判据 `last.status === 'done' && last.file_path`（`src/graph.js:307-309`） |

> **演员卡的「失败」= 不适用（恒 false）**。理由：演员卡的出图失败记在 `actor_images.status`（`web/views/actors.js:4427`：`im.status === 'done' && im.file_path`），而 `computeLayout()` 出的 item 里**没有**演员的出图历史，硬判会引入一次额外请求。
> **扩展位（不在本卡范围）**：若后续要把演员出图失败纳入筛选，应在 `loadCanvas()` 里给 `S.nodes` 的每行挂一个只读派生字段（例如 `_lastImageStatus`），而不是在筛选谓词里发请求。字段名沿用 `actor_images.status` / `actor_images.error`。

---

## 3. 筛选项契约（AC-1）

### 3.1 筛选规格对象（新增）

**新增文件 `web/lib/canvas-select.js`** —— 浏览器 ESM、零依赖、**不得引用 DOM 或 `window`**，以便 Node 测试直接 `import`。
（先例：`tests/test-novel.js:542` 直接 `await import('../web/lib/api.js')`、`:535` `import('../web/views/novel.js')`。）

```js
/**
 * 画布节点筛选规格。所有维度都可缺省；缺省 = 该维度不限。
 * 放在前端内存里（S.nodeFilter），不落库、不持久化（不变量 I1）。
 */
export const DEFAULT_NODE_FILTER = Object.freeze({
  kinds: [],           // string[]  —— 空数组 = 不限；否则「kind ∈ kinds」（维度内 OR）
  groups: [],          // string[]  —— 空数组 = 不限；特殊值 '' = 未分组；否则「groupId ∈ groups」
  hasArtifact: 'any',  // 'any' | 'yes' | 'no'
  failed: 'any',       // 'any' | 'yes' | 'no'
  locked: 'any',       // 'any' | 'yes' | 'no'
  negate: false,       // true = 对上列五维的 AND 结果整体取反（「反选」）
});
```

**前端状态挂点**（`web/views/actors.js` 的 `S`，第 64-77 行同一处）：

```js
S.nodeFilter = { ...DEFAULT_NODE_FILTER };   // 新增
S.kindTab    = 'all';                        // 既已存在（第 67 行）但全仓库只出现在声明处，
                                             // 契约要求启用它作为 kinds 维度的 UI 简写（单选快捷标签）
```

> `S.kindTab` 目前是**死字段**（`grep -c kindTab web/views/actors.js` = 1，仅声明）。契约要求复用而非另造，避免再留死字段。

### 3.2 筛选项清单与判定谓词

> `item` = §1.1 的 layout item。**以下五个维度与任务卡 acceptance_criteria 一一对应。**

```js
// ---- 取值归一（全部在 canvas-select.js 内实现）----
export function nodeKindOf(item)  { return item?.kind || 'actor'; }                 // 兜底同 src/modules/actors.js:269
export function nodeGroupOf(item) { return item?.groupId || ''; }                   // '' = 未分组
export function isNodeLocked(item){ return Boolean(item?.locked); }                 // 等价 item.node?.locked
function dataOf(item) { try { return item?.node?.data ? JSON.parse(item.node.data) : {}; } catch { return {}; } }
```

| # | 维度 | 规格字段 | 判定谓词 | 真实取值来源 |
|---|---|---|---|---|
| 1 | **类型（kind）** | `kinds: string[]` | `kinds.length === 0 ? true : kinds.includes(nodeKindOf(item))` | `canvas_nodes.kind || 'actor'` |
| 2 | **分组** | `groups: string[]` | `groups.length === 0 ? true : groups.includes(nodeGroupOf(item))` | `canvas_nodes.group_id`；`''` 表示「未分组」 |
| 3 | **有产物** | `hasArtifact: 'any'\|'yes'\|'no'` | `'any' → true`；否则 `(hasArtifactOf(item) === (hasArtifact === 'yes'))` | 见 §2.7 判定表 |
| 4 | **失败** | `failed: 'any'\|'yes'\|'no'` | `'any' → true`；否则 `((dataOf(item).status === 'error') === (failed === 'yes'))` | `canvas_nodes.data.status`，**只认 `'error'`** |
| 5 | **锁定** | `locked: 'any'\|'yes'\|'no'` | `'any' → true`；否则 `(isNodeLocked(item) === (locked === 'yes'))` | `canvas_nodes.locked` |

```js
/** 有产物（§2.7 判定表的可执行版本）——唯一实现，筛选与 UI 徽标共用 */
export function hasArtifactOf(item) {
  const kind = nodeKindOf(item);
  if (kind === 'actor')  return Boolean(item?.actor?.cover_image);
  if (kind === 'note')   return false;
  if (kind === 'scene' || kind === 'item' || kind === 'refimg') {
    return Array.isArray(item?.asset?.refImages) && item.asset.refImages.length > 0;
  }
  return Boolean(dataOf(item).lastFile);
}
```

### 3.3 组合语义（**这是 AC-1 的核心，逐条实现**）

| 规则 | 语义 | 说明 |
|---|---|---|
| **C1 维度间 AND** | 五个维度全部为真才命中 | `match = d1 && d2 && d3 && d4 && d5` |
| **C2 维度内 OR** | `kinds` / `groups` 是**多选**，命中任意一个即可 | 空数组是「不限」，**不是**「全不选」 |
| **C3 三态不混用** | `hasArtifact` / `failed` / `locked` 是三态枚举，不是布尔、也不是数组 | `'any'` / `'yes'` / `'no'`；非法值回落 `'any'` |
| **C4 反选在最外层** | `negate === true` 时对 C1 的结果整体取反 | `match = negate ? !and(...) : and(...)`；**不是**逐维取反 |
| **C5 「未分组」是一条正常取值** | `groups: ['']` = 只看未分组项；`groups: []` = 全部 | `''` 参与 `includes` 判定即可 |
| **C6 组合可保存为预设** | 不需要。预设属于本节范围外 | 明确不做，见 §3.7 |
| **C7 筛选不改变归属** | 筛选后**不得**隐式改 `group_id`、`locked`、`z` | 与 I3 同源 |

**语义示例（写测试时直接照抄）**：

| `S.nodeFilter` | 中文含义 |
|---|---|
| `{kinds: [], groups: [], hasArtifact: 'any', failed: 'any', locked: 'any', negate: false}` | 不限（**默认态，必须与现状零差异**） |
| `{kinds: ['video','image'], hasArtifact: 'no'}` | 看还没出过图的关键帧与视频节点 |
| `{failed: 'yes'}` | 只看执行失败的节点（`data.status==='error'`） |
| `{kinds: ['actor'], locked: 'yes'}` | 只看已锁定的演员卡 |
| `{groups: ['']}` | 只看未分组项 |
| `{kinds: ['note'], negate: true}` | 反选：排除所有便签 |
| `{failed: 'no', hasArtifact: 'yes'}` | 已出图且本次没失败的（= 可复用的产物） |

### 3.4 与既有筛选 / 折叠 / `showAll` 的交互（**必读，避免打坏既有行为**）

| 既有机制 | 位置 | 新筛选怎么与它相处 |
|---|---|---|
| 演员表文本筛选 `S.filter` | `web/views/actors.js:67`、`344-351` | `computeLayout()` 第 428 行先用 `filteredActors()`，**新筛选在其之后叠加**，不修改 `filteredActors()` |
| 演员表画风筛选 `S.styleFilter` | 同上 | 同上，叠加不替换 |
| `showAll`（主画布常驻显示全部演员） | `web/views/actors.js:430` | **不改语义**；筛选作用于 item 层，幽灵卡位（I2）与真实卡位一视同仁地被筛 |
| 折叠分组隐藏成员 | `web/views/actors.js:432-436` | **折叠优先于筛选**：折叠组内的项根本不进 `items`，因此既不显示也不可被批处理（I4） |
| `Ctrl+A` 全选 | `web/views/actors.js:1611` `selectAllVisible()` | **保持既有实现不动**。`tests/ui-simulate.py:518-520` 断言 `Ctrl+A` 选中数 == 演员总数，改动会打破它 |
| 宫格 / 自由模式 `S.mode` | `web/views/actors.js:66` | 筛选与模式无关；但**批处理移动在宫格模式下必须拒绝**（§4.2） |

**筛选结果的「全选」入口（新增，独立于 `Ctrl+A`）**：
工具栏新增按钮 `✓ 选中筛选结果`，行为 = `S.selection = new Set(可见 items 的 actor.id)` + `S.selectedOrder = [...]`。
选它而不改 `Ctrl+A` 的理由：既有 Python 审计脚本（`tests/ui-simulate.py`）与画布审计（`tests/canvas-audit.py`，134 项）都依赖 `Ctrl+A` 的现状语义；**最小改动原则优先于「快捷键更直觉」**。

### 3.5 纯函数签名（可直接实现，全部 `export function`）

```js
// ---------- web/lib/canvas-select.js ----------

/** 归一化：去重、剔非法值、补默认值；永不抛错（UI 直接喂用户输入） */
export function normalizeNodeFilter(spec = {}) → NodeFilter

/** 单条判定：五个维度 AND，最后按 negate 取反 */
export function matchNodeFilter(item, spec = DEFAULT_NODE_FILTER) → boolean

/** 批量筛选：保持入参顺序，不修改入参 */
export function filterItems(items = [], spec = DEFAULT_NODE_FILTER) → object[]

/** 是否有产物（§2.7 判定表的唯一实现） */
export function hasArtifactOf(item) → boolean

/** 中文摘要，用于 HUD：如「筛选：视频/关键帧 · 有产物 · 未锁定（12/48）」 */
export function describeNodeFilter(spec, total = 0, matched = 0) → string

/** 工具栏 chips：每个维度一片，含命中数；供渲染与「一键清除」 */
export function nodeFilterChips(spec, items = []) → Array<{ dim, key, label, count, active }>

/** 维度中文名与取值中文名（UI 文案唯一来源，避免各处硬编码中文） */
export const NODE_FILTER_DIMS = Object.freeze({
  kinds: '类型', groups: '分组', hasArtifact: '有产物', failed: '失败', locked: '锁定',
});
export const KIND_LABELS = Object.freeze({
  actor: '演员卡', note: '便签', scene: '环境', item: '物品', refimg: '参考图',
  text: '文本', image: '关键帧（出图）', video: '视频片段', shot: '分镜容器',
  timeline: '成片时间线', audio: '音频', overlay: '叠加层', subtitle: '字幕轨', output: '交付终点',
});
```

**要求**：
- 以上函数**必须无副作用**、不读 `S`、不发请求、不 `toast`（可测性是硬要求）。
- `KIND_LABELS` 的图标/中文名与 `web/views/actors.js:896-910` 的 `ASSET_STYLE` **保持一致**（允许复用其文案，但**不得**在 `canvas-select.js` 里复制颜色以外的渲染逻辑）。

**视图侧接线点（新增，最小改动）**：

```js
// web/views/actors.js —— computeLayout() 内，第 437 行 items 构造完成之后追加一行：
//   const visible = filterItems(items, S.nodeFilter || DEFAULT_NODE_FILTER);
//   return { items: visible, groups, bounds, hiddenByFilter: items.length - visible.length };
// 注意：折叠分组的隐藏已在第 432-436 行完成，这里是第二个隐藏来源，两者独立计数。
```

### 3.6 UI 契约

| 位置 | 元素 | 行为 |
|---|---|---|
| 工具栏 | 「🔎 筛选节点」按钮 → 下拉面板 | 五个维度分组；`kinds`/`groups` 为多选 chips，`hasArtifact`/`failed`/`locked` 为三态单选（不限/是/否）；面板底部有「反选」开关与「⌀ 清除筛选」 |
| HUD | 新增 chip | `describeNodeFilter()` 的中文摘要；筛选态非默认时 chip 加 `.on` 类（复用 `web/views/actors.js:623-636` 的 `ac-hud-chip`） |
| HUD | 新增 chip | `👁 筛选中 12/48`（匹配数/总数），让「消失的卡片」可解释 |
| 工具栏 | 「✓ 选中筛选结果」 | §3.4 的全选入口 |
| 空结果 | 画布中心提示 | 匹配 0 项时显示：`当前筛选没有匹配的节点；点「⌀ 清除筛选」查看全部` |

**中文报错/提示文案（固定字符串，测试按此断言）**：

| 场景 | 文案 |
|---|---|
| 筛选无匹配 | `当前筛选没有匹配的节点；点「⌀ 清除筛选」查看全部` |
| 选中筛选结果但为空 | `当前筛选没有可选的节点` |
| 清除筛选 | `已清除节点筛选` |

### 3.7 明确不做的事（防止范围蔓延）

1. **不做筛选预设的保存/命名/分享**（无表、无接口）。
2. **不做服务端筛选查询参数**（不新增 `/api/canvas?kind=...`；`GET /api/canvas` 的入参保持只有 `id`，`src/routes/actors.js:159`）。
3. **不改 `Ctrl+A` 语义**（§3.4）。
4. **不持久化筛选态**（I1）。
5. **不做正则/模糊/标签筛选**（`kinds`/`groups` 只做精确 `includes`；`groups` 不按组名匹配，只按组 id）。

---

## 4. 批处理动作契约（AC-2）

### 4.0 统一入参 / 出参 / 通用前置校验（**新增**）

所有批处理动作走同一个入口函数，**每个动作只实现自己的差异部分**：

```js
// web/views/actors.js —— 新增
/**
 * 批处理统一入口。
 * @param {'move'|'resize'|'delete'|'group'|'rerun-kinds'|'lock'|'unlock'} action
 * @param {object} params  动作特有参数（见各节）
 * @param {{includeLocked?:boolean, dryRun?:boolean}} opts
 * @returns {Promise<{ok:boolean, affected:number, skipped:number, reason?:string, details:object[]}>}
 */
async function runBatchAction(action, params = {}, opts = {}) { /* ... */ }
```

**通用前置校验（按顺序，任一条不通过即中止并给中文原因）**：

| 序 | 校验 | 不通过时的中文提示 | 依据 |
|---|---|---|---|
| G1 | 选区非空 | `请先在画布上选中要处理的节点` | 与既有 `bumpZ`（`web/views/actors.js:3815`）、`uniformSize`（`:3829`）一致 |
| G2 | 选区项的 `kind` 都在允许集合内 | 见各动作 | `NODE_KINDS`（`web/views/actors.js:1338-1353`） |
| G3 | 选区面积/节点数上限（**新增**防误伤） | `一次最多处理 500 个节点（当前 N 个）：请先用筛选缩小范围` | 新引入的护栏，上限常量 `BATCH_MAX_NODES = 500` |
| G4 | 分组框不在批处理选择集内 | 分组框请用分组自身的移动/缩放入口（选中分组后拖标题栏/边框） | `S.selectedGroup` 与 `S.selection` 本就是两套（`web/views/actors.js:71-72`、`1783`） |
| G5 | 连线不在批处理选择集内 | 连线请单选后按 Delete | `S.selectedLink` 独立（`web/views/actors.js:1750`、键盘删连线 `:2228`、右键删连线 `:2083`） |
| G6 | 队列/预算（**仅付费动作**：`rerun-kinds`） | 透传后端中文 `reason` | `preflightBatch`（`src/modules/render.js:476-498`） |

**通用落库原则（**关键**）**：

| 节点类型 | 几何落库接口 | 说明 |
|---|---|---|
| `actor`（含**幽灵卡位**） | `POST /api/canvas/nodes` body `{nodes:[{canvas_id, actor_id, x, y, w, h, z?, locked?}]}` | `bulkUpsertNodes`，**按 `actor_id` 匹配，`actor_id` 为空的行会被静默丢弃**（`src/modules/actors.js:964-972`，第 967 行 `if (!node || !node.actor_id) continue;`），且返回的 `updated` 不含被丢弃项 |
| `note` | `PUT /api/canvas/notes/:id` body `{x, y, w, h, z?, text?, color?}` | `updateNote`（`src/modules/actors.js:755-766`） |
| 资产/流程（`CREATABLE_KINDS`，12 类） | `PUT /api/canvas/assets/:id` body `{x, y, w, h, z?, title?, color?, data?}` | `updateAsset`（`src/modules/actors.js:691-702`）；非 `CREATABLE_KINDS` 会抛 `该节点不是可编辑的素材/流程节点` |

> ⚠️ **三条硬约束，实现时不得违反**：
> 1. **不得**用 `POST /api/canvas/nodes` 去改便签/资产/流程节点的坐标 —— `actor_id=''` 会被静默丢弃，且**不报错**，表现为「改了但没生效」。
> 2. **幽灵卡位（I2）必须先物化**：`item.node === null` 时，用 `POST /api/canvas/node` body `{canvas_id, actor_id, x, y, w, h}`（`upsertCanvasNode`，`src/modules/actors.js:283-297`）；也可直接用 `POST /api/canvas/nodes`，因为它按 `actor_id` 匹配，会自动 INSERT（`src/modules/actors.js:288-296`）。**两条路径都可，但必须以 `actor_id` 为键**，绝不能用 `item.id`（那是 `actor:xxx` 合成串，不是主键）。
> 3. **不得**用 `POST /api/canvas/restore` 做局部修改 —— 它是「整画布整体替换」（先 `DELETE` 再逐行 `INSERT`，`src/modules/actors.js:889-904`），会把没参与批处理的项也重写一遍。

### 4.1 动作总表

| 动作 | 入口 | 付费 | 危险等级 | 需要二次确认 | 需要撤销入栈 | 主要前置校验 |
|---|---|---|---|---|---|---|
| **移动** | `batchMove(dx, dy)` | 否 | 低 | 否 | 是 | 非宫格模式；非全锁定 |
| **缩放** | `batchResize({w, h, scale})` | 否 | 低 | 否 | 是 | 尺寸夹紧；锁定项跳过 |
| **删除** | `batchDelete({mode})` | 否 | **★ 高** | **是**（演员档案模式两段确认） | 是 | 模式选择；锁定项默认跳过；连带清连线 |
| **分组** | `batchGroup({name, color})` | 否 | 中 | 否 | 是 | 至少 1 项；**仅演员卡可入组** |
| **按类型重跑** | `batchRerunByKind({kinds, overwrite})` | **是** | **★★ 最高** | **是** + 计划审批 + 确认码 | 否（不属画布状态） | `EXECUTABLE` 过滤、`preflightBatch`、`planGraph` 环形依赖、审批闸门 |
| 锁定/解锁（既有能力批量化） | `batchSetLocked(locked)` | 否 | 中 | 否 | 是 | 与既有 `toggleNodeLock`（`web/views/actors.js:4188-4198`）同源 |
| 对齐 / 分布 / 层级 / 统一尺寸（既有） | `alignSelection` / `distributeSelection` / `bumpZ` / `uniformSize` | 否 | 低 | 否 | 是 | **保持既有签名与行为不变**（`web/views/actors.js:2358`、`:2382`、`:3814`、`:3828`） |

### 4.2 移动 —— `batchMove(dx, dy)`

```js
async function batchMove(dx, dy) {
  // dx, dy：世界坐标增量（不是屏幕像素）；方向键微调入口传 dx=±STEP
}
```

**前置校验**：

| 序 | 校验 | 中文提示 | 依据 |
|---|---|---|---|
| M1 | `S.mode === 'free'` | `宫格模式下拖动是「换序」不是移动；批量移动请先切到自由模式（✦）` | 宫格/自由语义差异见 `web/views/actors.js:1917-1921`（拖动=换序）、`:443-448`（宫格坐标由公式算出，改 x/y 无意义） |
| M2 | 选区中至少一项未锁定（或 `opts.includeLocked === true`） | `选中的 N 个卡位全部已锁定，无法移动（先解锁）` | 锁定拦截既有逻辑：`web/views/actors.js:1813` `if (!hit.locked)` |
| M3 | 便签/资产/流程节点若在选区中，走各自接口（**不是**拒绝） | — | §4.0 落库原则 |

**行为**：
- 逐项 `x += dx; y += dy`；**不做吸附**（吸附是拖动交互的体验优化，见 `snapPosition` `web/views/actors.js:1615`，批量移动用精确增量，保证 `dx` 可预期）。
- 已被锁定且未开 `includeLocked` 的项：**跳过并计入 `skipped`**，不阻断其余项（用户看得到「已移动 8 项，跳过 2 项（已锁定）」）。
- 落库后 `await loadCanvas(); draw();`，与既有 `alignSelection` 的收尾一致（`web/views/actors.js:2377-2378`）。
- 提示文案：`已移动 N 个节点${skipped ? `，跳过 ${skipped} 个已锁定` : ''}`。

### 4.3 缩放 —— `batchResize({ w, h, scale })`

```js
async function batchResize({ w = null, h = null, scale = null } = {}) {
  // w/h：绝对尺寸；scale：相对缩放系数。二者择一，同时给以 w/h 优先。
}
```

**前置校验与夹紧（**照抄既有单卡缩放的边界，不得另立标准**）**：

| 项 | 规则 | 依据 |
|---|---|---|
| 宽度 | `clamp(w, 90, 900)` | `web/views/actors.js:1869`：`Math.max(90, Math.min(900, d.ow + (world.x - d.sx)))` |
| 高度 | `clamp(h, 90, 1200)` | `web/views/actors.js:1870` |
| 越界 | **夹紧并提示**，不报错中止 | 提示：`尺寸已限制在 90×90 ~ 900×1200 之间` |
| `scale` 换算 | `newW = round(cur.w * scale)` 后同样夹紧 | — |
| 锁定项 | 跳过并计数 | 同 M2 口径 |
| 分组框 | 不参与（G4） | — |
| 演员卡「统一尺寸」 | 仍走既有 `uniformSize()`（= `S.cell × S.cell`） | `web/views/actors.js:3828-3835`，**不改** |

**提示文案**：`已缩放 N 个节点${skipped ? `，跳过 ${skipped} 个已锁定` : ''}`。

### 4.4 删除 —— `batchDelete({ mode })` ★ 危险

**两种模式，必须显式选择，不得合并**（把「从画布移除」和「删档案」混成一个按钮是本功能最容易造成事故的地方）：

| `mode` | 语义 | 接口 | 影响面 |
|---|---|---|---|
| `'detach'`（**默认，安全**） | 把卡位从本画布移除；演员档案、定妆图、素材、小说、剧本**全不受影响** | `DELETE /api/canvas/node/:id`（`src/routes/actors.js:174`） | 仅本画布 |
| `'purge'`（**危险**） | 删除演员档案本身（连带其定妆图记录） | `DELETE /api/actors/:id`（`src/routes/actors.js:55`） | 全局 |

**前置校验**：

| 序 | 校验 | 中文提示 | 依据 |
|---|---|---|---|
| D1 | 必须有选中项 | `请先选中要删除的节点` | — |
| D2 | `mode === 'detach'` 二次确认 | `把选中的 N 个卡位从「{画布名}」移除？演员档案与定妆图不受影响。` | 参照 `clearCurrentCanvas` 的措辞（`web/views/actors.js:2448`） |
| D3 | `mode === 'purge'` **两段确认** | ① `确认删除 N 位演员（{姓名列表}）？其定妆图记录也会一并删除。` ② `再次确认：这将永久删除演员档案，不可通过「撤销」恢复。` | 既有 `deleteActors` 只做了一段（`web/views/actors.js:4220-4221`），本契约要求补第二段 |
| D4 | `mode === 'purge'` 且选区含**非演员节点** | purge 只对演员卡生效；其余 N 项将按「移出画布」处理 | 非演员节点没有演员档案 |
| D5 | 锁定项：默认跳过 | `已锁定 N 项：勾选「包含已锁定」后才会删除`（附 `opts.includeLocked`） | 与 M2 一致 |
| D6 | 删除**画布**禁止 | 主画布：`主画布不可删除（它是宫格预览全部演员的入口画布）`；其他画布走画布栏入口 | `web/views/actors.js:3875`、`:3931`；后端硬闸门 `src/modules/actors.js:1013` `if (id === 'CV-MAIN') throw new Error('主画布不可删除');` |

**连带清理（**必须做，否则留脏数据**）**：

- `DELETE /api/canvas/node/:id` 走 `removeCanvasNode`，**只删一行，不清理 `canvas_links`**（`src/modules/actors.js:299`）。
  因此 `mode === 'detach'` 必须对每个节点**先**调 `DELETE /api/canvas/nodes/:id/links`（`deleteNodeLinks`，`src/modules/actors.js:867-870`，路由 `src/routes/actors.js:403`），**再**删节点。
- `DELETE /api/actors/:id` 走 `deleteActor`，**已经**清理连线（`src/modules/actors.js:85-87`），无需额外调用。
- 现存 UI 文案与实现不一致：`web/views/actors.js:2233`（另见 `:2975`）的 toast 写「节点已删除（连线一并清理）」，但后端并未清理。见 §8 R2。

**提示文案**：`已移除 N 个卡位${skipped ? `，跳过 ${skipped} 个已锁定` : ''}` / `已删除 N 位演员档案（不可撤销恢复）`。

### 4.5 分组 —— `batchGroup({ name, color })`

```js
async function batchGroup({ name = '', color = '' } = {}) {
  // 语义等价于既有 groupSelected()，但作用于完整选区（含非演员节点的分流校验）
}
```

**前置校验**：

| 序 | 校验 | 中文提示 | 依据 |
|---|---|---|---|
| P1 | 至少 1 项 | `先选中要成组的卡片` | 既有 `groupSelected`（`web/views/actors.js:2661`） |
| P2 | **仅演员卡可直接入组**；选区含便签/资产/流程节点时**明确提示并跳过** | `便签/资产/流程节点暂不支持批量成组（已跳过 N 项）` | **后端硬限制**：设置 `group_id` 的两个入口都按 `actor_id IN (...)` 匹配（`src/modules/actors.js:557`、`592-593`），非演员节点 `actor_id=''`，**静默不匹配** |
| P3 | 幽灵卡位必须先物化 | 见 §4.0 硬约束 2 | `createGroup` 按 `canvas_nodes` 行计算包围盒（`src/modules/actors.js:546-548`），无行则无包围盒 |
| P4 | 已在其他分组的项：移入新组 | 提示：`N 项已在其他分组，将移入新分组` | `UPDATE canvas_nodes SET group_id = ?` 是覆盖写（`src/modules/actors.js:557`） |

**实现路径（复用既有接口，不新增后端）**：
1. `POST /api/canvas/groups` body `{canvas_id, name, color, actorIds: [...演员id]}`（`src/routes/actors.js:285-289` → `createGroup`，`src/modules/actors.js:542-561`）——**一次调用同时完成建框 + 入组**（第 556-559 行）。
2. 若需要把项**追加**到已存在的分组：`POST /api/canvas/groups/:id/members` body `{actorIds, remove?}`（`setGroupMembers`，`src/modules/actors.js:586-601`），它会自动重新贴合包围盒（第 594-599 行）。
3. `name` 缺省时后端自动命名 `分组 N`（`src/modules/actors.js:554`）。

**提示文案**：`已把 N 张卡片组成「{name}」`（与既有 `groupSelected` 文案一致，`web/views/actors.js:2669`）。

**明确不做（本卡范围外）**：为便签/资产/流程节点新增 `nodeIds` 入参以支持成组——那需要改 `createGroup` / `setGroupMembers` 的入参语义（**属于新增能力，且动到公开函数**），列为 §8 R3 的后续项。

### 4.6 按类型重跑 —— `batchRerunByKind({ kinds, overwrite })` ★★ 最高危险

> **本动作是五个动作里唯一会产生真实费用的。它必须走既有的 P4 人工闸门，不得有任何捷径。**

```js
async function batchRerunByKind({ kinds = [], overwrite = false } = {}) {
  // kinds：用户选择的类型集合（会被 EXECUTABLE 过滤）
  // overwrite：false = 用输入指纹跳过没变的节点；true = 强制重算（真花钱）
}
```

#### 4.6.1 前置校验（**按顺序全部通过才允许提交计划**）

| 序 | 校验 | 中文提示 | 依据 |
|---|---|---|---|
| **R1** | 选区中至少 1 项属于 `EXECUTABLE` | `选中的节点都是素材源/容器，没有可执行的节点（可执行的类型：关键帧、视频、文本、音频、叠加层、字幕轨、成片时间线、交付终点）` | `EXECUTABLE = new Set(['image','video','text','audio','overlay','subtitle','output','timeline'])`（`src/graph.js:24`） |
| **R2** | 素材源/容器项被**显式列出并跳过**，不得静默 | `N 个节点是素材源（演员/环境/物品/参考图/便签）或容器（分镜），不参与执行，已跳过` | 非可执行节点进 skip 清单：`src/graph.js:377-378` |
| **R3** | 队列未暂停 | 透传后端中文 `reason` | `preflightBatch`（`src/modules/render.js:476-498`）→ `pauseState()`（`src/jobs.js:19-24`）。暂停语义 = **不丢任务**：已在跑的跑完，排队的留在队列（`src/jobs.js:150-155`） |
| **R4** | 磁盘未超额 | 透传后端中文 `reason` | `checkStorage`（`src/guard.js:164-168`） |
| **R5** | 未超月度预算 | 透传后端中文 `reason`，如 `本月预算上限 X CNY：已用 …，本次预估 …，合计 … 超限。…` | `checkBudget`（`src/guard.js:82-107`） |
| **R6** | 单次花费 ≥ 确认阈值时要求显式确认 | `${reason}（请勾选确认后继续）` | `checkBudget` 的 `needConfirm`（`src/guard.js:99-105`） |
| **R7** | 无环形依赖 | 透传 `planGraph` 抛出的中文错误：`画布存在环形依赖，无法执行：…` | `planGraph`（`src/graph.js:356`）；`findCycleNodes`（`src/graph.js:133-178`） |
| **R8** | 有可执行的节点（计划非空） | `没有需要执行的节点（可能都已生成，可勾选「强制重跑」）` | `createGraphRunJob` 的同名错误（`src/graph.js:835`） |

**调用顺序（契约固定）**：

```
① POST /api/canvas/plan        {canvasId, nodeIds: 过滤后的 id 数组, overwrite}
        └─ 零付费（planGraph，src/graph.js:356）
        └─ 拿到 plan：要执行的节点、可跳过的节点（含中文跳过原因）、
                      预估调用次数（estimate.imageCalls / videoCalls）、成本级 cost_level
② 人工审批页（复用既有「🧭 执行计划」UI）：
        POST /api/canvas/plans                     {canvas_id, created_by: 'human'}
        POST /api/canvas/plans/:id/approve         {confirm: true, by: 'human'}
        （拒绝：POST /api/canvas/plans/:id/reject  {reason, by: 'human'}）
③ 终端打印 6 位确认码（只写服务端日志，接口只返回掩码）
④ POST /api/canvas/plans/:id/run               {confirm_code}
```

**闸门与审计（既有，必须复用）**：
- 闸门链在 `authorizeRun`（`src/mcp-tools.js:355-416`）：有效期 → 人工审批 → 确认码 → 范围一致性 → **画布未改动** → 预算闸门。第 3 关会在执行前**再跑一次 `planGraph` 比对**，期间画布被改过就拒绝（`src/mcp-tools.js:400`）。
- 审批留痕表 `canvas_plan_audits`（`src/db.js:294-301`），`action` 九值：`created | approved | rejected | expired | consumed | approve_denied | run_denied | canvas_changed | run_failed`（`src/mcp-tools.js:40-43`），写入函数 `audit()`（`src/mcp-tools.js:135-147`）。
- 决策时间线会自动带上这些事件（`src/decisions.js:95-108`，`actor` 三值 `human | agent | system`，`decide` 位表示「算不算人类决定」，`src/decisions.js:162-164`）。

**⛔ 硬性禁止（写进实现注释）**：批处理重跑**不得**调用
`POST /api/canvas/run`（`server.js:52`）、`POST /api/canvas/run-node`（`server.js:55`）、
或直接调 `createGraphRunJob` / `runSingleNode`。这三个入口**绕过审批闸门**（它们在 `server.js` 里直接挂载，不经 `mcp-tools.js` 的 `authorizeRun`）。见 §8 R1。

#### 4.6.2 `overwrite` 语义（增量与幂等）

| `overwrite` | 行为 | 依据 |
|---|---|---|
| `false`（默认） | 输入指纹（`inputFp`）未变 → 跳过，复用已有产物 | `shouldSkip`（`src/graph.js:307-312`）；跳过原因中文见 `skipReason`（`src/graph.js:315-320`），如 `已有产物且输入未变；可用 overwrite=true 强制重算` |
| `true`（**用户显式勾选**） | 强制重算，**真花钱** | `shouldSkip` 首行 `if (overwrite) return false;` |

**幂等承诺**：
- 同一批节点重复提交 → 第二次因 `input_fp` 相同而被跳过（`src/graph.js:307-311`），**不重复扣费**。
- 计划 6 位确认码一次性消费（`canvas_plans.status` 由 `approved` → `consumed`，`src/db.js:282`）。
- 执行并发强制为 1（`src/graph.js:829-836`：注释原文「limit 必须为 1：下游依赖上游产物，并发执行会读到未完成的产物，造成隐性重复调用与费用失控」）。**批处理重跑不得试图提高并发。**

#### 4.6.3 重跑结果的可追溯入口（只读，供 UI 展示）

| 需求 | 接口 | 返回 |
|---|---|---|
| 画布整体状态徽标 | `GET /api/graph/status?canvas_id=`（`server.js:60`） | `{canvasId, counts:{total,executable,done,error,running,skipped,idle,source}, nodes:[{id,kind,title,status,file,error,lastAt,lastRunId}]}`（`src/graph.js:857-869`） |
| 单节点执行历史 | `GET /api/canvas/node-runs?node_id=&limit=`（`server.js:57`） | 20 列流水（§2.4） |
| 计划审批审计 | `GET /api/canvas/plans/:id/audits`（`src/mcp-server.js:151`） | 谁在何时批/拒了什么 |

**提示文案**：`已提交重跑计划（N 个节点 / 预估 图 X 张 · 视频 Y 个）；请人工批准并在终端取确认码后执行`。

---

### 4.7 既有动作纳入批处理时的对齐要求

下列函数**已存在且签名不得改动**（任务卡约束：`不得改既有公开函数签名`）。批处理只允许**复用**它们：

| 既有函数 | 位置 | 批处理中的角色 |
|---|---|---|
| `alignSelection(mode)` | `web/views/actors.js:2358` | 对齐条（`#ac-align-bar`，第 250-260 行）已有入口；**不改** |
| `distributeSelection(axis)` | `web/views/actors.js:2382` | 同上 |
| `bumpZ(delta)` | `web/views/actors.js:3814` | 层级；**不改** |
| `uniformSize()` | `web/views/actors.js:3828` | 「统一尺寸」；**不改** |
| `toggleNodeLock(actorId)` | `web/views/actors.js:4188` | 新增 `batchSetLocked(locked)` 时**必须复用其接口**（`POST /api/canvas/node/:id/lock`），不得新造第二个锁定写入口 |
| `currentSelectionNodeIds()` | `web/views/actors.js:3640` | 多类型选区的「取节点 id」既有聚合函数；批处理应**优先复用它**，但注意它把「非演员节点」判定为 `S.selectedExtra === it.id`（单选），若本卡引入非演员节点多选，需与之保持一致（见 §8 R4） |

> 注意 `alignSelection` / `distributeSelection` / `uniformSize` / `bumpZ` 都只用 `S.selection`（演员 id）且发 `POST /api/canvas/nodes`。**若批处理引入非演员节点的多选**，这些既有函数的行为边界需要一并明确——本契约的建议是：**v1 让 `S.selection` 继续只装演员 id，非演员节点的多选通过新增的 `S.selectionExtra: Set<nodeId>` 承载**，这样既有四个函数零改动。
> 理由：`computeLayout()` 用 `it.actor.id` 作为「选中判定键」（`web/views/actors.js:1415`、`2345`、`2359`、`2383`），对便签/资产节点而言 `it.actor.id` **恰好等于 node id**（第 462、471 行），所以把 node id 塞进 `S.selection` 在渲染上能工作，但会让 `deleteActors([...S.selection])`（第 4224 行）这类**语义为「删演员档案」**的既有路径被误触（它会对 node id 发 `/api/actors/:id`）。`S.selectionExtra` 是更安全的隔离方式。

### 4.8 ⚠️ 批处理危险动作清单（AC-2 要求的证据）

**按危险度从高到低排列。每一项都必须有对应的拦截与确认。**

| # | 危险动作 | 后果 | 必须的拦截 |
|---|---|---|---|
| **H1** | **按类型重跑 + `overwrite: true`** | **真实扣费**；后端 `addUsage` 记入月度台账（`src/guard.js:32-44`） | ① 计划页显式展示预估调用数与成本级 ② 人工批准（`confirm: true`）③ 终端 6 位确认码 ④ 画布改动则拒绝（`src/mcp-tools.js:400`）⑤ **禁止**走 `/api/canvas/run` 等无闸门入口 |
| **H2** | **批量删除演员档案（`mode: 'purge'`）** | 演员档案 + 定妆图记录**永久消失**；`DELETE /api/actors/:id` 同时清掉该演员在所有画布上的卡位与连线（`src/modules/actors.js:83-91`），影响**超出当前画布** | ① 两段确认（D3）② 列出姓名 ③ 提示「跨画布生效」 |
| **H3** | **批量删除卡位（`mode: 'detach'`）在非主画布上** | 仅本画布；但若该画布是某制片项目的工作现场（`productions.canvas_id`，`src/db.js:309`），会打断续跑 | ① 一次确认 ② 自动快照（见 §5.2） |
| **H4** | **在主画布 `CV-MAIN` 上批量删除/清空** | 主画布是「宫格预览全部演员」的入口（`docs/使用手册.md:144`）；误清空后需「⊕ 放入全部」恢复 | ① 主画布专属文案 ② 清空类操作**两段确认**（照抄 `web/views/actors.js:2448-2449`）③ 自动快照 |
| **H5** | **批量删除已锁定节点（勾选「包含已锁定」）** | 锁定是用户「别动我」的显式意图，覆盖它是**绕过用户意图** | ① 默认跳过 ② 覆盖时二次确认：`其中 N 项已锁定：确认要一并删除吗？` |
| **H6** | **批量移动跨越分组边界** | 拖拽落点会自动归组（`web/views/actors.js:2007-2019`）；批量移动若也用同样规则，会把整批塞进一个组 | **批量移动不触发自动归组**（差异点必须写进实现注释）；若用户想归组，走 `batchGroup` |
| **H7** | **批量移动/缩放在宫格模式下** | 宫格坐标由公式算出，改 `x/y` 无视觉效果 → 用户以为「没生效」后又反复操作 | 直接拒绝（M1） |
| **H8** | **对幽灵卡位（未落库）做几何操作** | 若错用 `item.id`（`actor:xxx`）当主键，会产生**孤儿节点行**或静默失败 | 强制以 `actor_id` 为键（§4.0 硬约束 2） |
| **H9** | **筛选态下误以为「全都是我的选区」** | 用户看到 12 个节点，实际选区里还有 36 个被筛掉的 → 批量删除时多删 | ① 批处理只作用于**可见且被选中**的项（I4）② 执行确认弹窗必须写**实际将处理的节点数**，且与用户可见数一致 ③ HUD 常驻显示 `筛选中 12/48` |
| **H10** | **删除分组框时连带删卡位** | `DELETE /api/canvas/groups/:id?keepNodes=0` 会删组内卡位（`src/modules/actors.js:576-583`） | 默认 `keepNodes=true`；「解散并删除」需二次确认（既有 `dissolveGroup`，`web/views/actors.js:3747`） |
| **H11** | **对锁定/失败节点批处理重跑的语义混淆** | 「锁定」在 `graph.js` 里**完全不被读取**（`grep locked src/graph.js` 排除 `blocked` 后为 0 处），所以锁定**不阻止**重跑 | 计划页必须提示：`其中 N 个节点已锁定：锁定只防误拖，不阻止执行` |

---

## 5. 与撤销 / 快照 / 主画布保护的交互（AC-3）

> **AC-3 要求「明确与撤销、快照、主画布保护的交互」。本节逐项给出规则表与冲突裁决。**

### 5.1 与撤销栈（前端内存，40 步）

**机制基线（既有，必须复用）**：
- `S.undoStack` / `S.redoStack`，纯前端内存；`pushUndo()` 上限 **40**，用 `JSON.stringify` 去重，入栈即清空 redo（`web/views/actors.js:2613-2621`）。
- `snapshot()` 记录 `{nodes, notes, extras, groups}`，**不含 `links`**（`web/views/actors.js:2595-2611`）。
- 落地走 `POST /api/canvas/restore`（`applySnapshot`，`web/views/actors.js:2623-2638`），恢复后**清空选择集**（第 2636 行）。
- 键盘：`Ctrl+Z` / `Ctrl+Y` / `Ctrl+Shift+Z`（`web/views/actors.js:2253-2254`）。

**批处理规则**：

| 规则 | 内容 | 理由 |
|---|---|---|
| U1 | **每个批处理动作恰好入栈一次**，在**动作开始前**调用 `pushUndo()` | 与既有 25 个调用点的口径一致（如 `alignSelection` 第 2361 行：先 `pushUndo()` 再改数据） |
| U2 | 动作**失败并中止**时不得留下一笔「无变化的撤销步」 | `pushUndo()` 已有 `JSON.stringify` 去重（第 2617 行），无需额外处理 |
| U3 | 一个批处理动作 = **一步撤销**（不是 N 步） | 用户心理模型：批处理是一个操作 |
| U4 | **`rerun-kinds` 不入撤销栈** | 它不改变画布状态，只产生执行流水与产物；「撤销」一个已完成的付费调用是伪概念。反思入口是 `canvas_node_runs` 与审批审计，不是 `Ctrl+Z` |
| U5 | 撤销/重做后**必须清空筛选态吗？不清空** | `applySnapshot` 已清空选择集（第 2636 行）；筛选保持（I1/I3），用户在筛选后的视图里继续操作 |
| U6 | 撤销**不恢复连线**（既有约束） | `snapshot()` 不含 `links`；因此**批量删除卡位连带删掉的连线，`Ctrl+Z` 也回不来**。这条必须写进实现注释与用户提示 |
| U7 | 40 步上限到达后，最旧的撤销步被丢弃 | 既有行为（第 2619 行 `shift()`）；批量删除大范围内容后靠**服务端快照**（§5.2）兜底，不靠撤销栈 |

**与 U6 相关的中文提示（新增）**：
删除确认框里必须加一句：`⚠️ 该操作连带删除的连线无法用「撤销」恢复；需要回退请用「📸 快照」。`

### 5.2 与服务端快照（`canvas_snapshots`，40 张/画布）

**机制基线（既有，必须复用）**：
- 人工命名快照：`saveSnapshot({canvasId, name, note, kind:'manual'})`（`src/snapshots.js:50-65`）。
- **破坏性操作前自动快照**：`autoSnapshotBefore(canvasId, actionLabel)`（`src/snapshots.js:184-191`）——已用于「铺开分集」（`src/routes/actors.js:234-235`）与清空画布（`src/routes/actors.js:461`）。
- 单画布上限 40，**优先淘汰最旧的 `auto`**（`src/snapshots.js:68-76`）。
- 回滚前先看差异：`diffSnapshot`（`src/snapshots.js:106-150`）；回滚默认**为当前状态再存一张 auto**（`restoreSnapshot` 的 `keepCurrentAsAuto`，`src/snapshots.js:156-167`），所以「回错还能回回来」。

**批处理规则**：

| 规则 | 内容 | 理由 |
|---|---|---|
| S1 | **危险级 ≥ ★ 的批处理动作，提交前必须调 `autoSnapshotBefore(canvasId, '批量删除前')`** | 与「铺开分集」「清空画布」同一护栏口径，复用既有函数，零新增基础设施 |
| S2 | 触发自动快照的批处理动作清单：`batchDelete(mode:'detach')`、`batchDelete(mode:'purge')`、`batchGroup`（会大改包围盒与归属） | 低危动作（移动/缩放/锁定切换）**不**打快照，避免 40 张额度被日常操作挤满 |
| S3 | 自动快照的命名与备注走既有格式 | `autoSnapshotBefore` 会自动生成 name = `自动 · {actionLabel}前`、note = `执行「{actionLabel}」前自动保存`、kind = `auto`（`src/snapshots.js:188`）。批处理动作名用中文：`批量删除`、`批量分组` |
| S4 | 自动快照**失败不阻断主操作**，但必须在提示里带回原因 | `autoSnapshotBefore` 的既有契约：返回 `{ok:false, error}` 而不抛错（`src/snapshots.js:190`）。UI 提示：`（自动快照未成功：{error}，本次操作已继续）` |
| S5 | 空画布不产生快照 | 既有行为（`src/snapshots.js:187` 返回 `skipped`） |
| S6 | **批量 `purge` 的跨画布影响不在快照保护范围内** | 快照只覆盖**单张画布**（`canvas_id` 字段）。`DELETE /api/actors/:id` 会清掉该演员在**所有**画布上的卡位（`src/modules/actors.js:83-91`）。必须提示：`⚠️ 该操作影响所有画布，快照只保护当前画布。` |
| S7 | 快照与撤销栈**不共用、不互相同步** | 既有事实：两者唯一共享的是底层 `restoreCanvas`（`src/snapshots.js` 注释第 5 行原文：「撤销栈只在当前页面会话里有效，跨刷新、跨人、跨天就没了」） |

### 5.3 与主画布 `CV-MAIN` 保护

**机制基线（既有）**：保护是**硬编码字符串比对**，不是数据字段。

| 保护点 | 位置 | 行为 |
|---|---|---|
| 后端唯一硬闸门 | `src/modules/actors.js:1013` | `if (id === 'CV-MAIN') throw new Error('主画布不可删除');` |
| 前端画布栏右键 | `web/views/actors.js:3874-3875` | 菜单项显示 `🔒 主画布不可删除`，点击只 toast |
| 前端工具栏删画布 | `web/views/actors.js:3931` | `toast('主画布不可删除（它是宫格预览全部演员的入口画布）', 'warn', 3200)` |
| 清空主画布 | `web/views/actors.js:2448-2449` | **两段确认**，第二段文案 `再次确认：清空主画布的全部卡位与关系线？` |
| 铺开分集改道 | `src/studio.js:1164-1171` | 目标是 `CV-MAIN` 时自动改铺到专用画布「制片·自动铺开」，并在 `actions` 里回一条 `guard` 说明 |

**事实澄清（避免实现方误解）**：
- 「**主流程图**」概念**不存在**（全仓库 0 命中）。
- `protected` / `is_system` / `readonly` **字段不存在**（`protected` 的命中都是「受保护的提示词片段」等无关语义）。
- **`restoreSnapshot` 与 `pruneSnapshots` 没有 `CV-MAIN` 保护** —— 回滚可以整体重写主画布。

**批处理规则**：

| 规则 | 内容 |
|---|---|
| V1 | 批处理**永远不允许删除画布**，因此主画布的「不可删除」后端闸门不受批处理影响；批处理只操作卡位与节点 |
| V2 | 在主画布上执行 ★ 级动作（批量删除）时，确认框文案必须是主画布专属版本，且**自动快照为强制项** |
| V3 | 主画布上 `batchDelete(mode:'detach')` 后，恢复路径是**既有**的「⊕ 放入全部」（`putAllActors`，`web/views/actors.js:2430-2442`）——提示里要写出这条路 |
| V4 | 批处理**不得**在主画布上创建流程节点（`image`/`video`/`shot`/`timeline`/`output`/`overlay`/`subtitle`） | 与 `studio.js:1164` 的既有护栏同源：流程节点会挤掉演员宫格预览。本卡只做筛选与批处理，**不新增节点**，此处仅作为不变量记录 |
| V5 | 筛选在 `CV-MAIN` 上要特别处理 `showAll` | 主画布默认 `showAll=true`（`src/modules/actors.js:258`），全部演员都是「可见项」——其中大部分是**幽灵卡位**（I2）。筛选面板必须在主画布上提示：`主画布常驻显示全部演员；其中 N 项尚未落库（拖动/缩放过一次后会自动落库）` |

### 5.4 三者优先级矩阵（冲突时的裁决顺序）

当同一次批处理同时触发多条规则时，按此顺序裁决：

| 序 | 裁决 | 例 |
|---|---|---|
| 1 | **硬拒绝**（前端校验 + 后端闸门） | 主画布删画布、宫格模式批量移动、`EXECUTABLE` 之外的重跑 |
| 2 | **自动护栏**（自动快照） | 批量删除前 `autoSnapshotBefore` |
| 3 | **显式确认**（用户主动勾选/点确认） | `overwrite: true`、`includeLocked: true`、`purge` 两段确认 |
| 4 | **审批闸门**（人 + 确认码） | 一切付费重跑 |
| 5 | **撤销入栈** | 所有几何/结构变更 |
| 6 | **信息提示**（不阻断） | `skipped` 计数、自动快照失败原因、连线不可撤销的提醒 |

---

## 6. 实现点清单（最小改动）

> 以下为建议实现范围。**本卡只产出契约，不实现。**

### 6.1 新增文件（1 个）

| 文件 | 内容 | 约束 |
|---|---|---|
| `web/lib/canvas-select.js` | §3.1 / §3.5 的规格对象与纯函数；零依赖、无 DOM、可被 Node 直接 import | 导出风格 `export function` / `export const`（与 `web/lib/api.js`、`src/*.js` 一致） |

### 6.2 修改文件（2 个，均为前端视图层）

| 文件 | 改动点 | 说明 |
|---|---|---|
| `web/views/actors.js` | ① `S` 增加 `nodeFilter`（第 64-77 行同处），启用 `S.kindTab` ② `computeLayout()` 第 437 行后叠加 `filterItems` ③ `deviceHud()` 加筛选 chip（第 616-641 行）④ 工具栏加「🔎 筛选节点」「✓ 选中筛选结果」⑤ 新增 `runBatchAction` 与五个动作函数 ⑥ `deleteCurrentCanvas` / `clearCurrentCanvas` 的文案不动 | **不改任何既有函数签名**；`pushUndo` / `snapshot` / `applySnapshot` / `alignSelection` / `distributeSelection` / `bumpZ` / `uniformSize` / `toggleNodeLock` / `groupSelected` 全部复用 |
| `web/lib/ui.js` | 若下拉面板需要新控件（三态单选组），在此补一个小组件 | 仅在确实需要时改；优先用既有 `el` / `select` / `modal` / `contextMenu` |

### 6.3 **不建议改**的文件（列出以明确边界）

| 文件 | 原因 |
|---|---|
| `src/*.js`（含 `modules/actors.js`、`graph.js`、`snapshots.js`） | 本功能全部可由既有 HTTP 接口完成；改后端会触碰公开函数签名与既有测试 |
| `src/db.js` | **不需要新表、新列**。筛选与批处理所需字段全部已存在（§2） |
| `server.js` | 不需要新路由 |
| `tests/*` | 不得改既有测试期望 |

### 6.4 复用接口速查（**这就是「不写代码也能指导实现」的核心**）

| 用途 | 接口 | 位置 |
|---|---|---|
| 读画布全量（含 nodes/groups/links） | `GET /api/canvas?id=` | `src/routes/actors.js:159` → `getCanvas` `src/modules/actors.js:264-281` |
| 批量改演员卡几何 | `POST /api/canvas/nodes` `{nodes:[{canvas_id,actor_id,x,y,w,h,z?,locked?}]}` | `src/routes/actors.js:188-192` → `bulkUpsertNodes` `src/modules/actors.js:964-972` |
| 物化幽灵卡位 | `POST /api/canvas/node` `{canvas_id,actor_id,x,y,w,h}` | `src/routes/actors.js:168-172` → `upsertCanvasNode` `src/modules/actors.js:283-297` |
| 改便签几何 | `PUT /api/canvas/notes/:id` | `src/routes/actors.js:447-450` → `updateNote` `src/modules/actors.js:755-766` |
| 改资产/流程节点几何 | `PUT /api/canvas/assets/:id` | `src/routes/actors.js:361-365` → `updateAsset` `src/modules/actors.js:691-702` |
| 节点锁定 | `POST /api/canvas/node/:id/lock` `{locked}` | `src/routes/actors.js:194-196` → `setNodeLocked` `src/modules/actors.js:974-977` |
| 删节点 | `DELETE /api/canvas/node/:id` | `src/routes/actors.js:174` → `removeCanvasNode` `src/modules/actors.js:299`（**不清连线**） |
| 清节点连线 | `DELETE /api/canvas/nodes/:id/links` | `src/routes/actors.js:403` → `deleteNodeLinks` `src/modules/actors.js:867-870` |
| 删演员档案 | `DELETE /api/actors/:id` | `src/routes/actors.js:55` → `deleteActor` `src/modules/actors.js:83-91`（**清连线**） |
| 成组 | `POST /api/canvas/groups` `{canvas_id,name,color,actorIds}` | `src/routes/actors.js:285-289` → `createGroup` `src/modules/actors.js:542-561` |
| 追加组成员 | `POST /api/canvas/groups/:id/members` `{actorIds,remove?}` | `src/routes/actors.js:302-306` → `setGroupMembers` `src/modules/actors.js:586-601` |
| 撤销落地 | `POST /api/canvas/restore` `{canvas_id,nodes,groups}` | `src/routes/actors.js:317-320` → `restoreCanvas` `src/modules/actors.js:881-926` |
| 自动快照 | 服务端调用 `autoSnapshotBefore(canvasId, actionLabel)` | `src/snapshots.js:184-191`（既有两个调用点：`src/routes/actors.js:234`、`:461`） |
| 计划（零付费） | `POST /api/canvas/plan` | `server.js:51-53` → `planGraph` `src/graph.js:356` |
| 状态汇总 | `GET /api/graph/status?canvas_id=` | `server.js:60` → `graphStatus` `src/graph.js:857-869` |
| 执行历史 | `GET /api/canvas/node-runs?node_id=&canvas_id=&limit=` | `server.js:57` → `nodeRuns` `src/graph.js:263-269` |
| 审批闸门 | `POST /api/canvas/plans` / `:id/approve` / `:id/reject` / `:id/run` | `src/mcp-server.js:119-151` |
| 批处理前置（付费） | `preflightBatch({images,videos,ttsChars,confirm})` | `src/modules/render.js:476-498` |

---

## 7. 测试契约（离线、临时库）

> 要求：**照抄同目录既有测试**。禁止连真实网络、禁止真实计费、禁止动 `data/factory.db`。

### 7.1 环境隔离（照抄 `tests/test-graph.js:10-30`）

```js
// ---- 环境隔离：临时数据目录 + 临时库 + 临时配置（强制 placeholder 后端，杜绝任何真实网络/计费）----
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-canvas-select-'));
const DB = path.join(TMP, 'sel.db');
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
const { migrate, run, get, all, ROOT } = await import('../src/db.js');
const A = await import('../src/modules/actors.js');
const SEL = await import('../web/lib/canvas-select.js');   // 纯函数，Node 可直接 import
migrate();
```

**必加的「未触碰真实库」自检**（照抄 `tests/test-graph.js:104`）：
```js
ok('未触碰真实库 data/factory.db',
  process.env.FACTORY_DB !== path.join(ROOT, 'data', 'factory.db') && !fs.existsSync(path.join(ROOT, 'data', 'factory.db')),
  `FACTORY_DB=${process.env.FACTORY_DB}`);
```

### 7.2 断言风格（自研 `ok`/`eq`，**全项目不用 `node:test`**）

```js
let pass = 0, fail = 0;
const ok = (name, cond, evidence = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${evidence ? `  ← ${evidence}` : ''}`); }
  else { fail++; console.error(`  ✗ ${name}  ← ${evidence}`); }
};
const eq = (name, actual, expected) => ok(name, actual === expected, `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`);
```

### 7.3 用例矩阵（每维度 ≥6 条，含边界与反例）

#### A. 筛选谓词（纯函数，不需要服务）

| # | 用例 | 期望 |
|---|---|---|
| A1 | 空规格 → 全通过 | `filterItems(items, DEFAULT).length === items.length` |
| A2 | `kinds:['video']` → 只留 video | 全为 `kind==='video'` |
| A3 | `kinds:['video','image']` → 多选 OR | 两种都留（**维度内 OR**） |
| A4 | `kinds:['video'] + locked:'yes'` → **AND** | 只剩「video 且 locked」 |
| A5 | `groups:['']` → 只看未分组 | 全为 `groupId` 空 |
| A6 | `negate:true + kinds:['note']` → 排除便签 | 无 note，其余全在 |
| A7 | `failed:'yes'` 对便签/演员卡 | 恒 false（演员卡失败不适用） |
| A8 | `failed:'yes'` 对 `data.status==='error'` 的 video 节点 | 命中 |
| A9 | `hasArtifact:'yes'` 对 `scene`（`refImages` 非空） | 命中 |
| A10 | `hasArtifact:'yes'` 对 `data.lastFile` 非空的 video | 命中 |
| A11 | `hasArtifact:'yes'` 对便签 | **不**命中（反例） |
| A12 | 非法输入（`kinds:'video'` 字符串、`failed:'maybe'`） | 归一化为默认，**不抛错**（边界） |

#### B. 与既有机制的一致性（防回归）

| # | 用例 | 期望 |
|---|---|---|
| B1 | 默认筛选态下 `filterItems(computeLayout().items).length` == 现状 `items.length` | **零差异**（这是「最小改动」的硬证据） |
| B2 | 筛选不修改 `S.selection` | 改变筛选前后 `S.selection` 深比较相等 |
| B3 | 折叠分组内的项即使通过筛选也不出现在可见 items | 与 `web/views/actors.js:432-436` 同源 |
| B4 | `Ctrl+A` 选中数 == 演员总数 | 与 `tests/ui-simulate.py:518-520` 的既有断言一致（**不得回归**） |
| B5 | 幽灵卡位的 `item.node === null` 且 `id === 'actor:'+actorId` | 断言不变量 I2 |

#### C. 批处理前置校验（反例为主）

| # | 用例 | 期望 |
|---|---|---|
| C1 | `batchMove` 在 `S.mode==='matrix'` | 拒绝，提示含「宫格模式」 |
| C2 | `batchMove` 选区全为锁定项 | 拒绝，提示含「全部已锁定」 |
| C3 | `batchMove` 含部分锁定 | 处理未锁定项，`skipped` 计数正确 |
| C4 | `batchResize({w: 5000})` | 夹紧到 900，且不抛错 |
| C5 | `batchResize({w: 10})` | 夹紧到 90 |
| C6 | `batchDelete` 无选中 | 提示「请先选中要删除的节点」 |
| C7 | `batchDelete({mode:'purge'})` 未过第二段确认 | 不发出任何 `DELETE /api/actors/:id` |
| C8 | `batchGroup` 选区含便签 | 提示「暂不支持批量成组（已跳过 N 项）」，且便签的 `group_id` **未变** |
| C9 | `batchRerunByKind` 选区全为 `scene`/`actor`/`shot` | 拒绝，提示含「没有可执行的节点」 |
| C10 | `batchRerunByKind` 队列已暂停 | 拒绝，透传后端 `reason`（含「队列已暂停」） |
| C11 | `batchRerunByKind` 超月度预算 | 拒绝，透传 `checkBudget` 的中文 `reason` |
| C12 | `batchRerunByKind` 画布有环 | 拒绝，提示含「环形依赖」 |
| C13 | 节点数 > `BATCH_MAX_NODES` | 拒绝，提示含「一次最多处理 500 个节点」 |

#### D. 落库正确性（用临时库直接核对）

| # | 用例 | 期望 |
|---|---|---|
| D1 | `batchMove` 后查库，每个 `actor_id` 的 `x/y` 增量正确 | `all('SELECT ...')` 逐项核对 |
| D2 | `batchMove` 对**幽灵卡位**后，`canvas_nodes` 里**新增**了对应 `actor_id` 的行 | 行数 +1 |
| D3 | 用 `POST /api/canvas/nodes` 传 `actor_id:''`（便签） | **静默丢弃**：`updated === 0`（记录该既有行为，防止实现方走错路） |
| D4 | `batchDelete({mode:'detach'})` 后，`canvas_links` 中该节点的边**已被清除** | `all("SELECT * FROM canvas_links WHERE from_node=? OR to_node=?")` 为空 |
| D5 | `batchDelete({mode:'detach'})` 后，演员档案仍在 | `ACTORS.getActor(id)` 非空 |
| D6 | `batchDelete({mode:'purge'})` 后，演员档案不在，且**其他画布**上该演员的卡位也被清 | 断言跨画布影响面 |

#### E. 与撤销 / 快照 / 主画布保护的交互

| # | 用例 | 期望 |
|---|---|---|
| E1 | `batchDelete` 前调用过 `autoSnapshotBefore` | `listSnapshots(canvasId).count` +1，且最新一张 `kind === 'auto'` |
| E2 | 自动快照在空画布上 | 返回 `{ok:true, skipped:...}`，**不**产生快照 |
| E3 | 主画布 `CV-MAIN` 调 `deleteCanvas` | 抛 `主画布不可删除`（`src/modules/actors.js:1013`） |
| E4 | 40 步撤销上限 | 连续 45 次 `pushUndo` 后 `undoStack.length === 40` |
| E5 | 快照 40 张上限且优先淘汰 `auto` | `pruneSnapshots` 后，被淘汰的都是 `kind==='auto'`（`src/snapshots.js:72-73`） |
| E6 | 危险动作的确认文案 | 断言含「连线无法用『撤销』恢复」（若实现采纳 U6 提示） |

#### F. 重跑闸门（离线假实例）

| # | 用例 | 期望 |
|---|---|---|
| F1 | `planGraph` 于含 `image`→`video` 的图 | 返回 `steps.run` 与 `steps.skip`，**且不产生任何 `canvas_node_runs` 新行**（零付费证据） |
| F2 | 未批准的计划直接调 `:id/run` | 拒绝，中文提示含「尚未经人工审批」（`src/mcp-tools.js:381-384`） |
| F3 | 批准后画布被改动，再 `:id/run` | 拒绝（第 3 关二次 `planGraph` 比对，`src/mcp-tools.js:400`） |
| F4 | 确认码错误 | 拒绝，且写入 `canvas_plan_audits.action === 'run_denied'` |
| F5 | `overwrite:false` 且输入指纹未变 | 计划里该节点进 `skip`，中文跳过原因含「输入未变」 |
| F6 | 用 stub executor 跑 `runGraph`（照抄 `tests/test-graph.js:74-88` 的 `mkExec`） | 不触网、不扣费，`canvas_node_runs` 写入行数与执行节点数一致 |
| F7 | 断言批处理代码**未**调用 `/api/canvas/run` | 静态检索或埋桩断言（H1 的护栏证据） |

### 7.4 回归策略

| 套件 | 要求 |
|---|---|
| `tests/test-graph.js` | 必须全绿（`canvas_node_runs` 20 列、`ensureGraphSchema` 幂等、计划/执行语义） |
| `tests/test-actors.js` | 必须全绿（主画布保护断言 `:172`、画布 CRUD、分组） |
| `tests/test-mcp.js` | 必须全绿（审批闸门、`CV-MAIN` 主画布） |
| `tests/test-studio.js` | 必须全绿（快照与决策时间线断言 `:445-449`、`:492-493`） |
| `tests/canvas-audit.py`（134 项） | 必须全绿；**特别关注**「框选与顺序角标」「对齐与分布」「撤销重做不丢数据」「文档与实现是否一致」四项 |
| `tests/ui-simulate.py` | 必须全绿；**特别关注** `:518-520` 的 `Ctrl+A` 断言 |
| `tests/ui-smoke.py` / `ui-scale.py` | 必须全绿 |

> **本轮不跑 `./scripts/verify-all.sh`**（任务卡与铁律均禁止：太重且并发冲突）。上表供后续实现/验收波次使用。

---

## 8. 风险与既有缺口（**只记录，本卡不修**）

| # | 风险/缺口 | 事实与位置 | 影响 | 建议 |
|---|---|---|---|---|
| **R1** | **存在绕过审批闸门的执行入口** | `server.js:52` `POST /api/canvas/run`、`:55` `POST /api/canvas/run-node` 直接挂 `createGraphRunJob` / `runSingleNode`，**不经** `mcp-tools.js` 的 `authorizeRun`（闸门链在 `src/mcp-tools.js:355-416`） | 「Agent 拿不到确认码就无法自己花钱」这一安全承诺（`docs/使用手册.md` 明示）**在 HTTP 层可被绕过** | 本卡硬性要求批处理只走 `/api/canvas/plans*`；建议后续单独开卡：给 `/api/canvas/run` 加同一套闸门或移除 |
| **R2** | **删节点不连清连线，与 UI 文案矛盾** | `removeCanvasNode` 只 `DELETE FROM canvas_nodes WHERE id=?`（`src/modules/actors.js:299`），无连线清理；而 UI toast 写「节点已删除（连线一并清理）」（`web/views/actors.js:2233`、`:2975`） | 脏 `canvas_links` 行残留；渲染时会因端点缺失被跳过（`web/views/actors.js:1226`）所以「看起来没事」，但数据在涨 | 本契约要求批删**显式**调 `DELETE /api/canvas/nodes/:id/links`；建议后续统一 UI 文案或补后端清理 |
| **R3** | **非演员节点无法归组（无细粒度入口）** | `group_id` 的两个写入口都按 `actor_id IN (...)` 匹配（`src/modules/actors.js:557`、`592-593`），非演员节点 `actor_id=''` | 拖便签进分组框**静默无效**（`web/views/actors.js:2014` 的 `actorIds:[it.actor.id]` 对便签不匹配任何行） | 本契约 v1 明确「仅演员卡可批量成组」；后续卡可给 `createGroup`/`setGroupMembers` 加 `nodeIds` |
| **R4** | **非演员节点无多选** | 只有单选句柄 `S.selectedExtra` / `S.selectedNote`（`web/views/actors.js:71-72`）；`currentSelectionNodeIds()`（`:3640-3648`）只聚合 1 个 extra | 批处理若不引入 `S.selectionExtra: Set`，就永远只能对 1 个便签做批量 | §4.7 给出 `S.selectionExtra` 方案（保证既有四函数零改动）；需在本卡落地时确认 |
| **R5** | **快照回滚路径上「空快照安全网」失效** | `restoreCanvas` 本有保护（`src/modules/actors.js:884-888`），但 `restoreSnapshot` 传 `allowEmpty: allowEmpty \|\| true`（`src/snapshots.js:168`）——恒真 | 一张空快照可整体清空非空画布 | 本契约的批处理**不新增**任何空快照路径；建议后续单独修这一行 |
| **R6** | **`restoreCanvas` 非原子（无事务）** | 先 `DELETE FROM canvas_nodes` 再逐行 `INSERT`（`src/modules/actors.js:889-904`）；全库无 `BEGIN/COMMIT`（`src/db.js` 无 `transaction` 封装） | 中途失败留下半成品画布；而批处理的撤销**依赖**这条路径 | 已知风险，本卡不改；批量动作应尽量走**增量接口**（§4.0 落库原则）而非 `restore` |
| **R7** | **撤销不恢复连线** | `snapshot()` 只含 `nodes/notes/extras/groups`（`web/views/actors.js:2595-2611`） | 批删卡位连带删的连线，`Ctrl+Z` 回不来 | 契约 U6：确认框必须提示；靠 §5.2 的服务端快照兜底 |
| **R8** | **`kind` 定义前后端不一致（`audio`）** | 前端 `FLOW_KINDS` 含 `audio`（`web/views/actors.js:912`），后端把它归 `ASSET_KINDS`（`src/modules/actors.js:640`） | 筛选的类型分组与后端「可编辑性」判定可能对不上 | 契约 §2.6 明确「三套集合各司其职」；实现时按 `CREATABLE_KINDS` 判可编辑、按 `EXECUTABLE` 判可执行 |
| **R9** | **`kind` 类型表多处重复定义需手工同步** | 源码自带警示：`src/modules/actors.js:774` 注释原文「⚠️ 必须与 `web/views/actors.js` 的 `NODE_KINDS` 保持一致：改一处要同步另一处」；另有 `PORT_RULES`（`:779-794`）与 `mcp-tools.js:46` 派生 | 新增 kind 时漏改一处 → 筛选面板缺项 | 契约把 `canvas-select.js` 的 `KIND_LABELS` 定位为**纯展示层**，判定逻辑一律引用既有集合，不新增第四份「真值表」 |
| **R10** | **锁定不阻止执行** | `grep locked src/graph.js`（排除 `blocked`）为 **0 处** | 用户以为「锁定=安全」，实际上重跑照样会动它 | H11 要求计划页显式提示；不建议改 `graph.js`（会动核心执行语义） |
| **R11** | **`S.kindTab` 是死字段** | `web/views/actors.js:67` 声明后全仓库无读取 | 容易让实现方以为已有筛选 | 契约要求启用它作为 types 维度的 UI 简写（§3.1） |
| **R12** | **`GET /api/canvas` 无筛选入参** | `src/routes/actors.js:159` 只读 `id` | 大画布（200+ 节点）每次全量传输 | 本卡不做服务端筛选（§3.7）；如后续需要，作为独立性能卡（可参考 T-105 的画布性能契约） |

---

## 9. 验收标准对照表

| 卡片 `acceptance_criteria` | 本文件对应章节 | 交付内容 |
|---|---|---|
| ① 列出筛选项（kind/分组/有产物/失败/锁定）与组合语义 | §3.1–§3.3（+ §2.7 判定表、§3.5 函数签名） | 五维规格对象、逐维判定谓词（含真实字段名）、C1–C7 组合规则、7 条语义示例 |
| ② 列出批处理动作（移动/缩放/删除/分组/按类型重跑）与各自的前置校验 | §4.1–§4.6（+ §4.8 危险清单） | 动作总表（含危险等级/确认要求/撤销要求）、每个动作的编号化前置校验与固定中文提示、统一落库原则与三条硬约束 |
| ③ 明确与撤销、快照、主画布保护的交互 | §5.1–§5.4 | 撤销 U1–U7、快照 S1–S7、主画布 V1–V5、以及冲突裁决优先级矩阵（6 级） |
| `evidence_required`：契约摘要 | §2 + §3.5 + §4.1 + §6.4 | 数据基线表、函数签名清单、动作总表、复用接口速查表 |
| `evidence_required`：批处理危险动作清单 | **§4.8** | H1–H11 共 11 项，每项含后果与必须的拦截 |
| `quality_checks`：文件存在 | 本文件 | `node -e "require('node:fs').accessSync('strategist/reports/T-103-canvas-select-spec.md')"` |

---

## 10. 一页速览（给实现方）

```
筛选（纯前端，不落库）
  S.nodeFilter = { kinds:[], groups:[], hasArtifact:'any', failed:'any', locked:'any', negate:false }
  判定源：item.kind / item.groupId / (actor.cover_image | asset.refImages | data.lastFile) / data.status==='error' / item.locked
  组合：维度间 AND，kinds 与 groups 维度内 OR，'' = 未分组，negate 在最外层取反
  落点：web/lib/canvas-select.js（纯函数，可 Node 直测）+ computeLayout() 叠加一层
  不改：Ctrl+A、filteredActors()、折叠分组、showAll

批处理（统一入口 runBatchAction，每个动作 pushUndo 一次）
  move     → 拒绝宫格模式；跳过锁定项；批量移动不触发自动归组
  resize   → clamp 90..900 / 90..1200（照抄既有单卡边界）
  delete   → detach(默认，移出画布) / purge(删档案，两段确认)；先清连线再删节点
  group    → 仅演员卡可入组；非演员节点明确提示并跳过
  rerun    → 只认 EXECUTABLE 8 类；preflightBatch → planGraph → 人工批准 → 确认码 → run
             ⛔ 禁止 /api/canvas/run 与 /api/canvas/run-node（绕过闸门）

护栏优先级：硬拒绝 > 自动快照 > 显式确认 > 审批闸门 > 撤销入栈 > 信息提示
主画布 CV-MAIN：不可删画布；★级动作强制自动快照 + 专属文案 + 两段确认
```
