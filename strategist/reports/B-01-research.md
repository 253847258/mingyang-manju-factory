# B-01 调研报告 · canvas-perf 正式接线可行面 + self-heal 阶段级熔断/降级比例告警触发点

| 项 | 值 |
|---|---|
| task_id | **B-01** |
| 角色 | 调研军师（W1 侦察／只读取证；不写源码、不改测试、不重启 8788） |
| 产出物 | 本文件（**本卡唯一写入范围**） |
| 上游依据 | `strategist/reports/README.md`（收口报告，第 54~79 行）、`strategist/reports/L6-verify.md`（验收与残余风险）、`T-101/T-102/T-103` 契约、`T-105-canvas-perf-spec.md`、`strategist/runs/*.json` |
| 下游 | W2 开发线（画布接线卡 + 自愈熔断卡）；W3 独立验收（红队按 §2.7/§3.7 的**反向断言**证伪） |
| 环境 | `/home/linsheng/Desktop/ai-video-factory`；Node **v24.18.0**；`package.json` `"type":"module"`；零 npm 依赖；8788 **未重启**（本轮只发 1 次只读 `GET`） |
| 取证方式 | 只读命令 + 离线复算（`node -e` 内联脚本，未落盘）；`/tmp/b01/*` 仅供「冲突语法实证」用 |

---

## 0. 结论速览

### 0.1 第一问：`canvas-perf.js` 正式接线（可行面与风险）

| 判定 | 结论（一句话） |
|---|---|
| **可行性** | **可行**，接线面只需改 **1 个文件、4 处**（`web/views/actors.js` 的 import / `lodLevel()` / `draw()` 的视口-裁剪-统计-排序 / `drawLinks` 开关），全部是「替换表达式、不替换决策」，无新表、无新路由、无需重启 8788（`GET /lib/canvas-perf.js` → **HTTP 200, 11852 bytes, text/javascript**） |
| **硬阻塞（先决条件）** | **必须用命名空间导入** —— `actors.js` 模块级已声明 `ZOOM_MIN(398)`、`ZOOM_MAX(399)`、`clampZoom(400)`、`visibleItems(4683)`；裸命名导入直接 `SyntaxError: Identifier 'clampZoom' has already been declared`（已实证，§2.2），**整个画布视图白屏** |
| **不可执行部分** | 契约 `T-105 §5` 表格**第 6 行**（`hitTestAt`/`marqueeHitIds`/`boundsOf`/`zoomAtPoint`/`fitViewport`… 共 17 个扩展批函数的接线）**当前不可执行**：这些函数在 `canvas-perf.js` 里**根本不存在**（导出面仅 14 个键，§2.1）。必须另开「扩展批实现卡」，先实现再接线 |
| **收益口径（不吹）** | 接线本身**不提升帧率**。真实收益 = ①视口/裁剪/LOD/z 序四处公式收敛为单一真源（消除 `actors.js` 与后端 `modules/actors.js` 的手抄漂移）②把原本只能靠 Playwright 审计发现的回归，前移到离线可跑（`node tests/canvas-perf.test.mjs`）③为扩展批提供唯一落点。200 卡位下低缩放区裁剪几乎无收益（`zoom=0.05` 时 200/200 可见），最大一笔仍是 **LOD0 免解码** |

### 0.2 第二问：self-heal 阶段级熔断 / 降级比例告警的触发点

| 判定 | 结论（一句话） |
|---|---|
| **有无触发点** | **没有**。`src/`、`web/`、`server.js` 里三个符号**零生产调用点**：`shouldTripStageDegrade`、`degradeSummary`、`degradedRatioAlert`（各自只有 1 处定义/默认值）；`tripThreshold` 只有 2 处（默认值 + `healPolicy()` 归一化），**没有任何读取者** → 策略旋钮空转 |
| **单测覆盖** | `shouldTripStageDegrade` 有 2 条断言、`degradeSummary` 有 4 条断言（`tests/test-selfheal.js:253-254`、`280-290`）；`degradedRatioAlert` **连测试都没有**（0 命中） |
| **当前唯一生效的降级护栏** | `MAX_SWITCHES_PER_SCOPE=1` + `healSwitchesOf()`（`src/studio.js:1390-1393`，按 `(scope_id, stage, from_backend, action='degrade')` 从账本计数）→ 只保证「同一阶段同一后端只换一次」，**不是**「连续失败熔断」，也**不**覆盖换到新后端后的下一跳 |
| **能力缺口** | 缺 4 件：**采样器**（没人累计"连续 N 个同类可自愈错误"）、**比较器**（阈值从未被读）、**动作**（从未 `pauseQueues`）、**暴露面**（`artifact.selfHeal` 写了但全仓库无读取点，`GET /api/render/selfheal` 与 `selfheal_events` 汇总读取**均未实现**） |
| **一个反直觉的事实** | **不能**靠 `selfheal_events` 数出连续失败数：`record` 回调**只在「已决定换后端」时触发**（`src/self-heal.js:868-878`），同后端重试失败、`hold-human`、预算拦截**都不落账** → 账本里只有 degrade 事件 |
| **可落地口径** | W2 只能先做**阶段级**熔断 + **阶段级**降级比例（用已有的 `production_stages.artifact` 与节点级重跑结果，零新增表）；**"同集降级镜占比"（episode 级）当前数据源不存在** —— `src/modules/render.js` 零自愈接线、`shot_renders.meta` 无任何 `degrade` 写入（`grep -c` = 0），必须另开卡 |

### 0.3 一句话给 W2

> 画布线：**1 个文件 4 处替换 + 命名空间导入**，用 §2.7 的 M1~M8 验收；自愈线：**新建 `src/self-heal-trip.js`（纯函数）+ `src/studio.js` 5 处落点**，用 §3.7 的 B1~B7 验收，禁止改 `tests/test-selfheal.js` 的任何既有断言。

---

## 1. 取证环境与基线（可复核）

### 1.1 指纹与规模基线（本轮只读取样，接线前后必须重算）

```bash
cd /home/linsheng/Desktop/ai-video-factory
md5sum web/views/actors.js web/lib/canvas-perf.js src/self-heal.js src/studio.js \
       tests/canvas-perf.test.mjs tests/test-selfheal.js
wc -l web/views/actors.js web/lib/canvas-perf.js src/self-heal.js src/studio.js
```

| 文件 | 行数 | md5（B-01 取证时） | 备注 |
|---|---|---|---|
| `web/views/actors.js` | **4958** | `69f1774847c67608d03b3a8c17f88809` | 与 `L6-verify.md` RK-L6-02 记录的验收值**逐字一致**（仍含 T-503 接线后的状态；契约写的 4669 行 / `a510a821…` **已过期**） |
| `web/lib/canvas-perf.js` | **221** | `385167759e328fe4866b459457c95102` | 与 `L6-verify.md` §5 记录值**逐字一致**（验收后零改动） |
| `src/self-heal.js` | **910** | `379a35c643776c3a97a2f9188a1c6f4e` | 同上 |
| `src/studio.js` | **1634** | `09866843fc3af6e2e0e0cbf56d4d990c` | 自愈接线所在文件 |
| `tests/canvas-perf.test.mjs` | 276 | `2d3bac0b967bb13606890f32c132f580` | 89 通过 / 0 失败（本轮真跑，exit=0） |
| `tests/test-selfheal.js` | 533 | `bf210565afa6266d8044e1e7f61373d3` | 101 通过 / 0 失败（`L6-verify.md` §1） |

> ⚠️ 接线卡**禁止**沿用 `T-106 §6.2` 的 `actors.js` md5 当"零改动"证据（RK-L6-02 已判该基线过期，照抄会得到**假 FAIL**）。

### 1.2 本轮唯一一次网络动作（只读）

```bash
curl -s -o /dev/null -w "HTTP %{http_code} bytes=%{size_download} type=%{content_type}\n" \
  http://127.0.0.1:8788/lib/canvas-perf.js
# 实测：HTTP 200  bytes=11852  type=text/javascript; charset=utf-8
```

结论：`web/` 静态挂载（`server.js:25,105`）+ `web/index.html:12` 的 `<script type="module" src="/app.js">` → **浏览器可直接取到 ESM 模块，无需构建步骤**，接线不存在"加载不到"的风险。

---

## 2. 调研①：`canvas-perf.js` 正式接线

### 2.1 现状核查（6 条硬证据）

| # | 结论 | 命令 | 原始结果 |
|---|---|---|---|
| 1 | **完全零接线**（死代码） | `grep -rn "canvas-perf" --include=*.js web src server.js tests` | 命中只在 `web/lib/canvas-perf.js` 自身注释/报错串、`tests/canvas-perf.test.mjs`、`scripts/verify-all.sh:72` → **无任何 `import` 引用** |
| 2 | 渲染仍用内联实现 | `sed -n '564,585p' web/views/actors.js` | `const view = { x0: -S.panX - 50, … }` + 四个 `<`/`>` 的 `continue` + `drawn++` 手数，逐字未变 |
| 3 | 导出面 = **14 个键** | `node -e "import('./web/lib/canvas-perf.js').then(m=>console.log(Object.keys(m).sort().join(',')))"` | `CULL_PAD,LOD_THRESHOLDS,ZOOM_MAX,ZOOM_MIN,clampZoom,cullStats,lodLevelFor,matrixLayout,shouldDrawLinks,sortByZ,viewClipKeep,viewportOf,visibleItems,zOf` |
| 4 | 契约 §5 的**核心 5 步全部具备实现** | 同上 | `lodLevelFor`/`viewportOf`/`viewClipKeep`/`cullStats`/`sortByZ`/`shouldDrawLinks` 全部存在 ✅ |
| 5 | 契约 §5 的**第 6 行（扩展批）不具备** | 同上 | `hitTestAt`/`marqueeHitIds`/`boundsOf`/`zoomAtPoint`/`fitViewport`/`zoomToRect`/`ensureVisiblePan`/`snapPosition`/`alignOffsets`/`distributeOffsets`/`resizeSize`/`freeSpot`/`niceStep`/`portPoint`/`portPointAt`/`edgeAnchor`/`resolvedLinks` → **17 个全部缺失** |
| 6 | 离线等价性成立（不是自评） | 见 §2.6 复算命令 | 5107 组随机输入，与原式**不一致点数 = 0**；唯一差异是 NaN 坐标（契约 `T-105 §2.4` 已显式声明） |

**200 卡位解析表复算（drawn 与两份文档逐行相等）**：

```bash
node -e '
const P = await import("./web/lib/canvas-perf.js");
const items = P.matrixLayout({count:200, cols:5, cell:210, gap:14});
for (const z of [0.05,0.1,0.12,0.22,0.35,0.5,1,2,4,8]) {
  const v = P.viewportOf({zoom:z, width:1320, height:860});
  const s = P.cullStats(items, v);
  console.log(z, "LOD="+P.lodLevelFor(z), s.drawn+"/200");
}'
# 200 LOD=0 200/200 | 0.1 195 | 0.12 165 | 0.22 LOD1 90 | 0.35 60 | 0.5 LOD2 40
# 1 20 | 2 12 | 4 4 | 8 1   ← 与 T-105 §3.2 表、canvas-perf.js 头注释表逐行相同
```

### 2.2 硬阻塞：4 个「模块级同名声明」会让裸命名导入直接语法报错

`actors.js` 模块级已存在（`grep -cE "(^|[^A-Za-z0-9_.])(function|const|let|var) +<name>\b"`）：

| 名字 | 声明处 | 与 `canvas-perf.js` 导出同名 → 裸 `import { … }` 的后果 |
|---|---|---|
| `ZOOM_MIN` | `actors.js:398` | **`SyntaxError: Identifier 'ZOOM_MIN' has already been declared`** |
| `ZOOM_MAX` | `actors.js:399` | 同上 |
| `clampZoom` | `actors.js:400` | 同上（**已实证**，见下） |
| `visibleItems` | `actors.js:4683`（多选批处理用，语义不同） | 同上（RK-L6-03 已警告「接了线却没效果」，实际后果更严重：**整页白屏**） |
| `zOf` | `actors.js:569`（**函数内** `const`） | 不报错（内层遮蔽模块级），但接线后该行会被删除，仍建议不要裸导入以免误读 |

实证命令与原始输出（ESM 静态检查，与运行期无关）：

```bash
mkdir -p /tmp/b01
printf "import { clampZoom } from '<repo>/web/lib/canvas-perf.js';\nconst clampZoom = (z) => z;\n" > /tmp/b01/dup.mjs
node --check /tmp/b01/dup.mjs ; echo "exit=$?"
# /tmp/b01/dup.mjs:2
# const clampZoom = (z) => z;
#       ^
# SyntaxError: Identifier 'clampZoom' has already been declared
# exit=1

printf "import * as perf from '<repo>/web/lib/canvas-perf.js';\nconst clampZoom = (z) => z;\nconsole.log(clampZoom(1), perf.clampZoom(2));\n" > /tmp/b01/ns.mjs
node /tmp/b01/ns.mjs ; echo "exit=$?"
# 1 2
# exit=0
```

**▶ 唯一安全写法（W2 必须照抄）**：

```js
import * as perf from '../lib/canvas-perf.js';
```

理由：①零改名churn、②不会被 4 处同名声明遮蔽、③`node --check` 与浏览器 ESM 均通过、④后续扩展批接线时命名空间天然避让 `edgeAnchor`/`portPoint` 等同名风险（`actors.js` 已有 `edgeAnchor`? 未声明，但 `portPoint` 系列存在）。

### 2.3 行号漂移表（接线必须按"现状行号"，不是契约行号）

契约与 `canvas-perf.js` 注释里的等价来源行号**全部基于 4669 行的旧版本**，现状为 4958 行；`:94` 的 `__acDebug` **未漂移** → 插入点位于 `:94` 之后、`:398` 之前（成因见 RK-L6-02：T-503 接线写入）。

| 语义 | 契约/注释写的行号 | **现状行号（W2 按此接线）** | 偏移 |
|---|---|---|---|
| `ZOOM_MIN` / `ZOOM_MAX` / `clampZoom` | `390-392` | **398 / 399 / 400** | +8 |
| `niceStep` | `394-399` | **402-407** | +8 |
| `lodLevel()` | `401-405` | **408-413** | +8 |
| 宫格布局公式 | `443-448` | **451-456** | +8 |
| 视口矩形 `view` | `556-559` | **565-567** | +9 |
| `drawn` 统计 / HUD | `560-577`、`613/626` | **568-585**、**634**（chip）与 **621**（调用） | +8 |
| z 序（`zOf` / `sort`） | `561` / `562` | **569 / 570** | +8 |
| 裁剪判定（四个 `continue`） | `564-565` | **573** | +8 |
| 连线整体开关 | `609` | **617** | +8 |
| `imageFor` LOD0 免解码 | `653-656` | **661-676**（`if (lodLevel() === 0) return null;` 在 **664**） | +8 |
| `drawCell` LOD0 早退 | `745` | **753** | +8 |
| `__acDebug()` | `94` | **94** | 0 |

### 2.4 可行接线面：4 步（逐字 before/after）

> 原则：**替换表达式、不替换决策**、每步跑一次 §2.7 的 M 系列；不顺手优化（契约 `§4.2` 的 9 条禁止项原样生效）。

#### 步骤 0 · 备份与基线（必须，本仓库**不是 git 工作树**）

```bash
cd /home/linsheng/Desktop/ai-video-factory
cp web/views/actors.js /tmp/actors.js.bak.$(date +%s)
md5sum web/views/actors.js     # 期望 69f1774847c67608d03b3a8c17f88809（接线前基线）
```

#### 步骤 1 · 新增命名空间导入（插在 `:9` 的 `canvas-select` import 块之后、`:11 let C = null;` 之前）

```js
// 画布性能纯逻辑（T-105 契约 / T-209 交付）：视口矩形、裁剪口径、LOD 分级、z 序、批量几何的唯一真源。
// 必须用命名空间导入：本文件模块级已声明 ZOOM_MIN(398)/ZOOM_MAX(399)/clampZoom(400)/visibleItems(4683)，
// 裸命名导入会触发「Identifier '…' has already been declared」SyntaxError（ESM 静态检查），整个画布视图白屏。
import * as perf from '../lib/canvas-perf.js';
```

#### 步骤 2 · `lodLevel()` 变薄封装（`408-413`）

```js
// 现状
/** 按缩放级别决定渲染细节（LOD）：块 → 缩略图 → 完整信息 */
function lodLevel() {
  if (S.zoom < 0.22) return 0;
  if (S.zoom < 0.5) return 1;
  return 2;
}

// 接线后（保留函数名与全部 8 个调用点：96/642/664/702/1013/1228/1419 → 零调用点改动）
/** 按缩放级别决定渲染细节（LOD）：块 → 缩略图 → 完整信息（阈值与判定取自 canvas-perf，单一真源） */
function lodLevel() {
  return perf.lodLevelFor(S.zoom);
}
```

#### 步骤 3 · `draw()` 内五处替换（`564-585` + `621`）

```js
// 现状（564-585 + 621）
  // 视口裁剪：只画可见卡片（大项目不卡）
  const vw = canvasEl().clientWidth / S.zoom;
  const vh = canvasEl().clientHeight / S.zoom;
  const view = { x0: -S.panX - 50, y0: -S.panY - 50, x1: -S.panX + vw + 50, y1: -S.panY + vh + 50 };
  let drawn = 0;
  const zOf = (it) => (it.kind === 'note' ? (it.note?.z || 0) : (it.node?.z || it.z || 0));
  const ordered = [...L.items].sort((a, b) => zOf(a) - zOf(b));   // z 越大越靠上
  L.drawOrder = ordered;
  for (const it of ordered) {
    if (it.x + it.w < view.x0 || it.x > view.x1 || it.y + it.h < view.y0 || it.y > view.y1) continue;
    /* …绘制（drawNoteNode / drawAssetNode / drawCell + isFindHit 描边）… */
    drawn++;
  }
  S._drawn = drawn;
  /* …guides / marquee / groupFrames … */
  updateHud(drawn, L.items.length);

// 接线后
  // 视口裁剪：只画可见卡片（大项目不卡）。视口矩形 / 裁剪口径 / 统计口径 / z 序全部取自 canvas-perf（单一真源）
  const cvEl = canvasEl();
  const view = perf.viewportOf({ zoom: S.zoom, panX: S.panX, panY: S.panY, width: cvEl.clientWidth, height: cvEl.clientHeight });
  const stats = perf.cullStats(L.items, view);     // 与 __acDebug().drawn、HUD「视野内 N」同源；空表 ratio=0（不得 NaN）
  const ordered = perf.sortByZ(L.items);           // z 升序、等 z 保持输入顺序（显式稳定，不依赖引擎稳定性）
  L.drawOrder = ordered;
  for (const it of ordered) {
    if (!perf.viewClipKeep(it, view)) continue;    // 闭区间：与视口边界相切必须可见
    /* …绘制（逐字不变）… */
  }
  S._drawn = stats.drawn;                          // 位置与旧赋值一致（仍在循环之后）
  /* …guides / marquee / groupFrames（逐字不变）… */
  updateHud(stats.drawn, stats.total);
```

> 五处细节，缺一处即判 FAIL：
> ① `const zOf`（`:569`）随 `:570` 一起删除（全文件仅 `:570` 使用它）；
> ② 删除 `let drawn = 0;` 与循环末尾的 `drawn++;`（避免双源计数）；
> ③ `S._drawn = stats.drawn;` 必须留在**循环之后**的旧位置（若某次 drawCell 抛错，旧行为是"不覆盖旧值"，位置挪前会改变这一行为）；
> ④ `canvasEl()` 仍需调用一次取 `clientWidth/clientHeight`（`perf.viewportOf` 不读 DOM，这是设计约束）；
> ⑤ 不要改 `isFindHit` 的位置（它在裁剪循环内，`:577`）。

#### 步骤 4 · 连线整体开关（`617`）

```js
// 现状
  if (S.showLinks !== false) drawLinks(g, L);
// 接线后
  if (perf.shouldDrawLinks({ showLinks: S.showLinks, links: S.links })) drawLinks(g, L);
```

等价性说明（**已验证，不是假设**）：`drawLinks`（`:1224-1226`）首两行就是 `const links = S.links || []; if (!links.length) return;` → 新增的 `Array.isArray/S.length` 条件只提前跳过一个"立刻返回"的空调用，**渲染结果与副作用完全一致**（`g.save()` 在其后）。

### 2.5 明确不可执行的部分（防止 W2 越界）

- 契约 `T-105 §5` **第 6 行**（`:1562/:1843/:475/:2310/:2344/:2327/:1615/:2358/:2382/:1866/:2894/:2197` 等扩展批接线）：**17 个函数未实现 → 本卡一行都不能接**。若强行接，只能自己再写一套判定 —— 直接违反契约 `§7`「端口表/公式不得复制第三份」。
- 需要另开卡的两组：**(a) 扩展批实现卡**（在 `web/lib/canvas-perf.js` 追加导出，含 §2.5 签名）；**(b) 扩展批接线卡**（依赖 a）。
- 模块级**死代码**风险已知：接线后若 `canvas-perf.js` 仍被 `verify-all` 阶段 30 覆盖，则不会退化为"无人调用"。

### 2.6 风险清单（含等级、事实、影响、处置）

| # | 等级 | 风险 | 事实/证据 | 影响 | 处置（W2 必做） |
|---|---|---|---|---|---|
| **R1** | **高** | 裸命名导入 → **SyntaxError，画布白屏** | 4 个同名声明（`398/399/400/4683`）；实证输出见 §2.2 | 整个明星矩阵页打不开（`app.js` 模块图加载失败） | 只允许 `import * as perf`；M1 用 `node --check` + 浏览器冒烟双锁 |
| **R2** | 中 | 断言进入**渲染热路径**：`viewportOf/viewClipKeep/cullStats` 会 `TypeError` 校验入参 | `canvas-perf.js:73-87`；`Number.isFinite` 要求 `x0..y1` 有限，`visibleItems/cullStats` 要求 `items` 是数组 | 现状是"静默不画/全裁"，接线后若出现 `S.zoom = 0/NaN` 或 `clientWidth` 非有限，**从退化变成抛异常**（用户看到白屏而非少画） | 接线前自查：`S.zoom` 的 7 个赋值点全部经 `clampZoom`（`:327/:2208/:2313/:2325/:2359/:4742`）→ 不变式 `0.05 ≤ zoom ≤ 8` 成立；M2 在浏览器里断言 `__acDebug().zoom` 恒在 `[0.05,8]`；**不得**为此在热路径加 try/catch 吞异常（会掩盖真错） |
| **R3** | 中 | 双源计数：`cullStats` 与循环内 `drawn++` 若并存，HUD 与 `__acDebug().drawn` 可能分叉 | `S._drawn` 被 `:100`（`__acDebug`）与 `:621`（HUD）两处消费 | 审计 E 段（`drawn === items`）可能偶发不符 | 按步骤 3 删掉 `drawn++`，只留 `stats.drawn` |
| **R4** | 中 | **md5 基线过期**：契约/测试计划写 4669 行 + `a510a821…` | RK-L6-02 实测 `69f17748…`（4958 行） | 照抄旧基线会得到**假 FAIL**，诱发"改期望凑绿" | 基线一律用 §1.1 表内现值；接线后重算并写入卡证据 |
| **R5** | 低 | 文档数字口径分歧：契约 `§3.2` 写"200 卡位占 **1106×8946**"，模块头注释写"**1126×8966**" | 实测 `matrixLayout(200)` 的 `maxX/maxY = 1126/8966`，`maxX-minX/maxY-minY = 1106/8946` | 只是"绝对坐标 vs 跨度"两种写法，`fitView` 两者都算得 **0.0953**（`w=1186, h=9026`），**不影响 drawn 表与任何判定** | 文档行文统一为"跨度 1106×8946（绝对坐标 1126×8966）"；不得据此改动几何 |
| **R6** | 低 | NaN 坐标语义差异（唯一已知差异） | 契约 `§2.4`/`canvas-perf.js:135-136` 已声明；实测：原式判 **可见**、新实现判**不可见** | 卡位坐标来自 SQLite 数值列，不产生 NaN；接线后如需防御应另开卡 | W2 不得"顺手修"（改了就变行为）；R6 只做记录 |
| **R7** | 低 | `sortByZ` 的索引 Map 对**同一对象重复出现**时退化为同索引 | `canvas-perf.js:187-188` `new Map(items.map((it,i)=>[it,i]))` | 重复引用时两者并列 → 比较器返回 0 → 仍保持输入顺序（与现状 `Array#sort` 稳定语义一致） | 无动作；W3 可用 `sortByZ([a,a,b])` 反向验证顺序不变 |
| **R8** | 低 | 多一次 O(n) 扫描（`cullStats` 与绘制循环各扫一遍） | 实测预算：200 卡位 `visibleItems+cullStats` 合计 **0.0197 ms/次**（100 次均值，本轮真跑输出） | 相对一帧绘制可忽略 | 保留（换来的是"真值同源"）；禁止为此改成"手数 drawn" |

### 2.7 验收点（W2 交付必须逐条给原始输出）

| # | 验收点 | 命令 | 期望（判 FAIL 的反例在括号内） |
|---|---|---|---|
| **M1** | 语法/加载 | `node --check web/views/actors.js && curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8788/lib/canvas-perf.js` | `exit=0` + `200`（出现 `SyntaxError: Identifier … has already been declared` 即 FAIL） |
| **M2** | **行为等价（端到端）** | `python3 tests/canvas-audit.py http://127.0.0.1:8788`（= `verify-all` 阶段 25） | E 段 6 条断言原样通过：`lod==0 && "LOD 简" in HUD`、`imgCache==0 && imgLoaded==0`（`zoom=0.12`）、`lod==1`（0.35）、`lod==2 && imgLoaded>0`（1.0）、`drawn===items`（1.0）、`drawn<items`（4.0）（`tests/canvas-audit.py:312-338`） |
| **M3** | 模块1 回归 | `node tests/test-actors.js` | 105 通过 / 0 失败，exit=0（阶段 2 计数不得下降） |
| **M4** | 纯模块回归 | `node tests/canvas-perf.test.mjs` | **89 通过 / 0 失败**，exit=0（该文件本轮 md5 `2d3bac0b…` 必须**逐字未改**） |
| **M5** | 裁剪/统计等价（离线） | 见 §2.6 复算命令 + 边界 6 点 | 5107 组随机输入不一致 = 0；相切 4 点 `viewClipKeep===true`、越界 1px = `false` |
| **M6** | 全量回归 | `bash scripts/verify-all.sh` | `exit=0`、末行 `✅ 全部自检通过`、**30/30 阶段 / 2693 断言**（前 25 阶段 2098 不变） |
| **M7** | 指纹与文件范围 | `md5sum web/views/actors.js web/lib/canvas-perf.js tests/canvas-perf.test.mjs` + `find . -newermt '-30 minutes' -type f` | 只有 `actors.js` 变化（`canvas-perf.js`/测试文件指纹不变）；`find` 不得列出测试文件（证明没改测试凑绿） |
| **M8** | 反向断言（红队可证伪） | 浏览器控制台：`__acDebug().drawn` 与 `document.querySelectorAll('.ac-hud-chip').length` 无关；对照 `zoom` 0.12/0.35/1/4 四档记录 `drawn/items/lod/imgLoaded/imgCache` | 与**接线前**同档数值逐位一致（建议 W2 先跑一次留基线，接线后再跑一次对比） |

### 2.8 回滚方案

```bash
# 本仓库非 git 工作树，无 git checkout 可回退
cp /tmp/actors.js.bak.<时间戳> web/views/actors.js
md5sum web/views/actors.js      # 必须回到 69f1774847c67608d03b3a8c17f88809
# canvas-perf.js 是新增文件：恢复后无人 import 即为死代码，node --check 仍通过，无需删除
```

---

## 3. 调研②：self-heal 阶段级熔断 / 降级比例告警

### 3.1 结论

**有实现、有单测、没有触发点。** 三个符号在 `src/`、`web/`、`server.js` 里各只有 1 处定义/默认值，**零调用**；`tripThreshold` 有 2 处但从无人读；`degradedRatioAlert` 连测试都没有。**"阶段级熔断"与"降级比例告警"当前是纯函数层面的承诺，运行期不存在任何采样、比较与动作。**

### 3.2 证据表（一条命令一条结论）

```bash
cd /home/linsheng/Desktop/ai-video-factory
for k in shouldTripStageDegrade degradeSummary degradedRatioAlert tripThreshold; do
  printf "%-22s src|web|server=%s  tests=%s  非 self-heal.js 命中的生产调用=%s\n" "$k" \
    "$(grep -rn "$k" --include=*.js src web server.js | wc -l)" \
    "$(grep -rn "$k" --include=*.js --include=*.mjs tests | wc -l)" \
    "$(grep -rn "$k" --include=*.js src web server.js | grep -v '^src/self-heal.js' | wc -l)"
done
```

| 符号 | 定义处 | `src|web|server` 命中 | 测试命中 | **非 `self-heal.js` 的生产调用** |
|---|---|---|---|
| `shouldTripStageDegrade` | `src/self-heal.js:623-625` | 1 | 2（`tests/test-selfheal.js:253-254`） | **0** |
| `degradeSummary` | `src/self-heal.js:628-645` | 1 | 4（`tests/test-selfheal.js:280-290`） | **0** |
| `degradedRatioAlert` | `src/self-heal.js:85`（默认策略里的一行注释键） | 1 | **0** | **0** |
| `tripThreshold` | `src/self-heal.js:80`、`:98`（`healPolicy` 归一化） | 2 | 0 | **0（`decideHeal`/`runWithHeal` 从不读取）** |

旁证（能力缺口）：

```bash
grep -rn "selfheal_events" --include=*.js src web        # 只有 CREATE(studio.js:91) / INSERT(studio.js:1380) / COUNT(studio.js:1391)
grep -rn "selfHeal" --include=*.js src/routes src/modules web   # 无（web 命中项是无关的 backend-fit.degraded）
grep -c "selfHeal\|degrade" src/modules/render.js         # 0 → 镜头级自愈（T-102 §8.2）完全未接线
grep -rn "pauseQueues(" --include=*.js src                # studio.js:1000(预算闸门) / routes/render.js:114(人工) / schedules.js:1274(排产预算闸门)
```

→ **`selfheal_events` 只写不汇总**：账本可写、可按 `(scope,scope_id,stage,from)` 计数（I5），但**没有**任何汇总/读取/展示；`artifact.selfHeal`（`studio.js:1601-1613`）**写了但全仓库无人读**（无路由、无界面消费）→ 降级事实目前只存在于 DB 与日志里。

### 3.3 现有唯一生效的降级护栏（不要误认为熔断）

| 护栏 | 实现 | 覆盖范围 | 与"熔断"的差别 |
|---|---|---|---|
| `MAX_SWITCHES_PER_SCOPE = 1` + `healSwitchesOf()`（`src/studio.js:1390-1393`） | `SELECT COUNT(*) … WHERE scope_id=? AND stage=? AND from_backend=? AND action='degrade'` | 同一 `(productionId, stage, from)` 只换一次，**跨重启有效** | 是"次数上限"，不是"连续失败熔断"；换到新后端后计数从 0 重新开始（`comfyui-h3→generic-http→placeholder` 可达 2 跳） |
| `MAX_GENERATE_CALLS_PER_SHOT = 3` | `src/self-heal.js:70,728` | 单镜/单次的调用上限 | 与阶段级连续失败无关 |
| `autoPauseGate`（`src/studio.js:988-1003`） | `shouldAutoPause` + `pauseQueues(by:'system')` | **预算**闸门 | 与"降级比例"无关；是唯一已生效的自动暂停路径 |

**▶ 因此：`pauseQueues` 的自动触发当前只有"预算"一种原因，降级比例告警从未触发过任何动作。**

### 3.4 关键约束（决定 W2 不能被"从账本数连续失败"误导）

`runWithHeal` 的 `record` 回调**只在已决定换后端的分支里触发**：

```js
// src/self-heal.js:840-878（摘）
  // I1：先落账（拿 eventId）再执行生成 —— 写不进去就放弃切换，且零生成调用
  if (typeof record === 'function') { … rec = await record(event); … }
```

而"同后端重试一次"分支（`:784-803`）、`hold-human`/`stop` 分支（`:832-838`）、策略硬停分支（`:775-781`）**都不落账**。
**结论**：`selfheal_events` 里只有 `action='degrade'` 的事件，**数不出"同阶段连续 3 个同类可自愈错误"**（第 1、2 次失败没有记录）。采样器必须另找落点（§3.5 步骤 2）。

### 3.5 W2 接线方案（接口 / 字段 / 步骤 / 验收点）

#### 3.5.1 现状缺口清单（4 件，逐一有归属）

| # | 缺什么 | 现状 | 归属卡 |
|---|---|---|---|
| 1 | **采样器**：累计"同阶段连续 N 个同类可自愈错误" | 无任何累计点（`consecutive` 只在纯函数入参里出现） | 本卡（W2-B） |
| 2 | **比较器**：读 `policy.tripThreshold` / `policy.degradedRatioAlert` | 两个键都无人读 | 本卡 |
| 3 | **动作**：熔断→停自动重跑/换后端；比例告警→`pauseQueues(by:'system')` + 中文告知 | 无 | 本卡 |
| 4 | **暴露面**：`artifact`/`GET /api/render/selfheal`/`decisions` 时间线 | artifact 写了没人读；路由与时间线未做 | 路由与时间线**另开卡**（`src/routes/render.js`、`src/decisions.js` 不在本卡 write_scope） |

#### 3.5.2 新增文件 `src/self-heal-trip.js`（纯函数、零依赖、零 IO）

> 为什么新建而不是改 `src/self-heal.js`：①矩阵铁律「新模块优先」；②`src/self-heal.js` 的 md5 已被 `L6-verify.md §5` 当作验收基线（`379a35c6…`），新逻辑独立成文件可让"冻结面"继续冻结；③新模块可离线单测（临时库/临时 config），不碰 8788。

```js
// 阶段级熔断与降级比例告警的纯判定（T-102 §3.4 的代码化落地）
// 零依赖、零 IO：不读写数据库、不写配置、不发请求、不 import self-heal.js
// 采样状态的持久化由调用方（studio.js）用既有 app_config 键值表完成（同 jobs.js 的 jobs:paused 手法）

/** app_config 键前缀（与 jobs.js 的 jobs:paused / jobs:pause-log 同库不同键，互不干扰） */
export const TRIP_KEY_PREFIX = 'selfheal:trip:';

/** 键规则：selfheal:trip:<productionId>:<stage>（跨重启、跨进程唯一的采样位） */
export function tripKeyOf({ productionId, stage }) { … }

/**
 * 连续失败采样（纯函数：入参给全，无副作用）
 * @param {object|null} prev 上一次采样（来自 app_config，缺失传 null）
 * @param {string|null} errorKind 本次错误类别（self-heal 的 rate/server/network/timeout/…）
 * @param {boolean} healable 是否属于可自愈类别（false 时原样返回：审核/配额/鉴权只交人，I4 红线）
 * @param {boolean} ok 本次自愈是否成功（true → consecutive 归零）
 * @param {boolean} degraded 本次是否发生了换后端
 * @param {number} threshold 熔断阈值（来自 policy.tripThreshold，默认 3）
 * @returns {{consecutive:number,errorKind:string|null,threshold:number,tripped:boolean,trips:number,firstAt:string|null,lastAt:string|null}}
 * 语义（逐条可断言）：
 *  1) ok===true            → { consecutive:0, errorKind:null, tripped:false }（保留 trips 累计）
 *  2) healable!==true      → 原样返回 prev（不计入熔断）
 *  3) 同 errorKind         → consecutive = prev.consecutive + 1
 *  4) 不同 errorKind       → consecutive = 1（换类别即重新计数）
 *  5) tripped = consecutive >= Number(threshold || 3)
 *  6) trips 只在「本次跨过阈值且上次未跨」时 +1（重复调用不得重复计数）
 */
export function nextTripState({ prev = null, errorKind = null, healable = true, ok = false, degraded = false, threshold = 3, at = null } = {}) { … }

/**
 * 降级比例告警判定（纯函数）
 * @returns {{degraded:number,total:number,ratio:number,threshold:number,minCount:number,alert:boolean,reason:string}}
 * 语义：
 *  1) total<=0 → { ratio:0, alert:false }（**不得 NaN**，与 cullStats 的 ratio 口径一致）
 *  2) alert = degraded>0 && (ratio >= threshold || degraded >= minCount)   // 契约：≥30% 或 ≥5 镜
 *  3) reason 为中文，含「降级 N/M（xx%）」「阈值 xx%」「建议人工复看后再交付」
 */
export function degradeRatioState({ degraded = 0, total = 0, threshold = 0.3, minCount = 5 } = {}) { … }

/** 中文告知模板（熔断 / 比例告警两种），供阶段 artifact 与 onLog 共用，禁止在别处再写一份文案 */
export function tripNotice({ kind = 'trip', stage = '', consecutive = 0, threshold = 3, errorKind = null, errorLabel = '',
                              ratioState = null, from = null, to = null } = {}) { … }
```

#### 3.5.3 `src/studio.js` 的 5 处落点（唯一集成者）

| # | 位置（现状行号） | 改动 | 为什么必须在这里 |
|---|---|---|---|
| 1 | `:26` import 行 | `import { nextTripState, degradeRatioState, tripNotice, tripKeyOf } from './self-heal-trip.js';` 并在 `:13` 的 `db.js` 导入里追加 `getConfigValue, setConfigValue` | `db.js:427/432` 的 KV 读写已有既成用法（`src/schedules.js:17` 同款） |
| 2 | `healVideoStage` `:1541` | `const { canvasId, nodes, failed, all: nodesTotal } = videoNodesToHeal(p, art);` | `videoNodesToHeal` 已返回 `all`（`:1406/1409`），当前被丢弃 → 比例告警的分母白拿 |
| 3 | `healVideoStage` `:1546` 之后、`:1571` `runWithHeal` 之前 | **熔断前置闸门**（见下方代码） | 熔断必须在"动手重跑/换后端之前"生效，否则熔断本身也会产生付费调用 |
| 4 | `healVideoStage` `:1585` 之后（`ok/degraded` 取好之后） | 采样回写（成功清零）+ 比例告警动作（见下方代码） | 需要 `res.ok/res.degraded/res.errorKind` 才能更新采样 |
| 5 | `healVideoStage` `:1595-1614` 的 `artifact.selfHeal` | 追加字段：`tripped`、`consecutive`、`errorKindSeq`、`nodesTotal`、`nodesDegraded`、`ratio`、`alert`、`tripNotice` | 让"熔断/告警"这件事**可被只读消费**（后续路由卡与 decisions 时间线卡直接读它） |

**落点 3 逐字代码（熔断前置闸门）**：

```js
  // ── 阶段级熔断（T-102 §3.4）：同阶段连续 N 个同类可自愈错误 → 停止自动重跑/换后端，交人处理。
  //    采样位存 app_config（跨重启、跨进程；同 jobs.js 的 jobs:paused 手法），不新增表、不改既有列。
  const tripKey = tripKeyOf({ productionId, stage });
  const prevTrip = getConfigValue(tripKey, null);
  const tripGate = nextTripState({
    prev: prevTrip, errorKind: profile.errorKind, healable: true, ok: false, degraded: false,
    threshold: env.policy.tripThreshold, at: nowISO(),
  });
  if (tripGate.tripped) {
    setConfigValue(tripKey, tripGate);
    const notice = tripNotice({ kind: 'trip', stage, consecutive: tripGate.consecutive, threshold: tripGate.threshold,
      errorKind: profile.errorKind, errorLabel: profile.errorLabel, from: env.from });
    setStage(productionId, stage, {
      status: 'error', finished_at: nowISO(),
      artifact: { ...art, selfHeal: { ...(art.selfHeal || {}), tripped: true, ...tripGate, notice, at: nowISO() } },
    });
    onLog(String(notice).replace(/\n+/g, ' '));
    return {
      ok: false, skipped: true, tripped: true, action: 'hold-human', stage,
      from: env.from, to: null, errorKind: profile.errorKind, errorLabel: profile.errorLabel,
      reason: `阶段级熔断：${profile.errorLabel} 在本阶段连续 ${tripGate.consecutive} 次（阈值 ${tripGate.threshold}）`,
      advice: '已停止自动重跑与换后端：请人工排查后端/参数后重跑该阶段（避免把整阶段做成降级产物）',
      notice, trip: tripGate, calls: 0,
    };
  }
```

**落点 4 逐字代码（采样回写 + 比例告警）**：

```js
  const ok = res?.ok === true;
  const degraded = res?.degraded === true;

  // 采样回写：成功即清零；失败则累加（换类别重新计数）。写不进去不影响主流程（KV 失败不等于自愈失败）。
  try {
    setConfigValue(tripKey, nextTripState({
      prev: tripGate, errorKind: res?.errorKind || profile.errorKind, healable: true,
      ok, degraded, threshold: env.policy.tripThreshold, at: nowISO(),
    }));
  } catch (e) { onLog(`（熔断采样写入失败，本次跳过：${e?.message || e}）`); }

  // ── 降级比例告警（T-102 §3.4）：本阶段降级节点占比 ≥ degradedRatioAlert(0.3) 或 ≥5 个 → 暂停队列 + 中文告知。
  const ratioState = degradeRatioState({
    degraded: degraded ? nodes.length : 0,
    total: Number(nodesTotal) || nodes.length || 0,
    threshold: env.policy.degradedRatioAlert, minCount: 5,
  });
  let pauseInfo = null;
  if (ratioState.alert) {
    const J = await import('./jobs.js');                 // 与 autoPauseGate(:989) 同款动态导入，避免顶层循环依赖
    const reason = `${tripNotice({ kind: 'ratio', stage, ratioState, from: usedFrom, to: usedTo })}`.replace(/\n+/g, ' ');
    pauseInfo = J.pauseQueues({ reason, by: 'system' });  // 只暂停队列（不杀在跑任务）；重复调用不会重复写历史
    onLog(`⏸ 已自动暂停队列：${reason}`);
  }
```

> **`artifact.selfHeal` 需新增的字段（落点 5）**：`tripped`(boolean)、`consecutive`(number)、`threshold`(number)、`nodesTotal`(number)、`nodesDegraded`(number)、`ratio`(number)、`alert`(boolean)、`pauseReason`(string|null)。字段名一次性定死，后续路由/UI 卡只能读不能改语义。

#### 3.5.4 与既有不变量的相容性（逐条）

| 不变量 | 是否受影响 | 说明 |
|---|---|---|
| **I1 先落账后换后端** | 不受影响 | 熔断闸门在 `runWithHeal` **之前**返回（零生成调用），根本不进入落账分支 |
| **I3 付费不自动** | 不受影响 | 未触碰 `requiresApproval`/`approved` 逻辑 |
| **I4 审核/配额只交人** | **增强** | `healable !== true` 时采样器原样返回 → 审核类错误永远不会把阶段"熔断"成自动降级 |
| **I5 一阶段一后端只换一次** | 不受影响 | `healSwitchesOf` 与 `action='degrade'` 计数语义不变（熔断走的是 `hold-human`，不写账本） |
| **既有 2693 断言 / 30 阶段** | 不受影响（按 §5 选项 1） | 新模块 + 新套件不接入 `verify-all.sh` 之前，阶段数与计数不变 |

#### 3.5.5 计划行为对照表（W3 直接照着证伪）

| 场景 | 现状行为 | 接线后行为 |
|---|---|---|
| 同阶段连续 3 次 `server` 类失败 | 每次都做「同后端重跑 1 次 + 换后端 1 次（受 I5 限制）」 | 第 3 次起 **`hold-human`、零生成调用、状态 error**，中文熔断告知 |
| 第 4 次再触发 | 照旧重跑 | 仍 `hold-human`（`tripped` 持续为真，`trips` 不再 +1） |
| 一次成功自愈 | — | `consecutive` 归零（下次失败从 1 重新计） |
| 错误类别从 `server` 变 `network` 且仍失败 | — | `consecutive` 重置为 1（不同类不合并计数） |
| 阶段 10 个视频节点、3 个降级后重跑成功 | 只写 artifact，无任何动作 | `ratio=0.3 ≥ 0.3` → `pauseQueues(by:'system')` + 中文 reason；`jobs:pause-log` **恰好 1 条**（`jobs.js:52` `if (!cur.paused) logPause(...)` 保证幂等） |
| 审核类错误（`moderation`） | `hold-human`，不换后端 | 同左（采样器不计数，**不会**触发熔断） |
| 队列恢复 | — | 必须由人 `POST /api/queue/resume`（见 R9） |

### 3.6 验收点（B 系列）

| # | 验收点 | 命令 | 期望 |
|---|---|---|---|
| **B1** | 既有自愈套件零回归 | `node tests/test-selfheal.js` | **101 通过 / 0 失败**，exit=0；`md5sum tests/test-selfheal.js` = `bf210565afa6266d8044e1e7f61373d3`（**逐字未改**） |
| **B2** | 新增纯函数套件 | `node tests/test-self-heal-trip.js`（W2 新建） | ≥15 条断言全绿，且必须覆盖：`ok=true` 清零 / 换 kind 重置为 1 / `healable=false` 不计数 / `threshold=2` 边界（`consecutive=2 → true`，`1 → false`）/ `trips` 不重复计数 / `total=0 → ratio=0 且非 NaN` / `ratio` 边界 `0.299…→false` 与 `0.3→true` / `degraded=5,total=50 → true`（minCount 分支）/ app_config 往返（`setConfigValue→getConfigValue` 深等）/ 中文 `reason` 含「降级」与百分号 |
| **B3** | 熔断端到端（离线假执行器） | 新套件内：同一 `productionId` 连续 3 次 `server` 失败 | 第 1、2 次正常走自愈；**第 3 次** 返回 `tripped:true, action:'hold-human'`，且**该次生成调用次数 = 0**；`production_stages.artifact.selfHeal.tripped === true`；`app_config['selfheal:trip:<id>:video'].consecutive === 3` |
| **B4** | 跨进程/跨重启可读 | 另起 `node` 进程读同一临时库的同名 key | 读到 `consecutive===3`（证明不依赖内存） |
| **B5** | 比例告警端到端 | 新套件内：10 节点、3 个降级 | `pauseState().paused === true`；`reason` 含「降级」「30%」；`pauseHistory()` **恰好 1 条** `by='system'`；再次触发后 history **仍为 1 条**（幂等） |
| **B6** | I1/I4/I5 未回归 | `node tests/test-selfheal.js`（B1）+ 新套件内 3 条反向断言 | 账本写不进仍抛中文错且新后端生成 0 次；`moderation` 不换后端；同一 `(scope,stage,from)` 只换一次 |
| **B7** | 全量回归 | `bash scripts/verify-all.sh` | `exit=0`、`✅ 全部自检通过`、**30/30 / 2693**（按 §5 选项 1，新套件暂不接入阶段） |

### 3.7 风险清单

| # | 等级 | 风险 | 事实/证据 | 处置 |
|---|---|---|---|---|
| **R9** | **高** | `pauseQueues` 会把暂停**持久化**（`app_config['jobs:paused']`），**重启后仍暂停**，必须人工恢复 | `src/jobs.js:13-15`（注释 + `PAUSE_KEY`）与 `src/jobs.js:46-56` 实现；`T-108-ops-plan.md:190`（R1）已列为运维坑 | ①比例告警的 `reason` 必须中文写明触发依据与恢复方式；②验收 B5 必须断言 `reason` 内容；③文档/文案不得暗示"重启即恢复"；④**禁止**用 `pauseQueues` 做停机 drain（T-108 §3.4 坑 1） |
| **R10** | 中 | `pauseQueues` 的 `scope` 字段**只是记录**，`pump` 只读全局 `paused` | `T-108-ops-plan.md:516`（R8） | 熔断/告警只能声明"全局暂停"，**不得**对外宣称"按集/按阶段暂停" |
| **R11** | 中 | 采样位放 `app_config` 属新增内部键 | 该表是**内部 KV**（`jobs:paused`、`jobs:pause-log`、排产租约键）——`grep app_config src/routes/meta.js src/config.js` **0 命中**，设置页不枚举它 | 无需动作；但**不得**把采样位写进 `config/config.json`（会污染用户配置且触发 RK-L6-06 同类问题） |
| **R12** | 中 | 熔断计数与"失败态"判定重叠：`healVideoStage` 只在阶段处于失败态时被调用 | `src/studio.js:1531-1540`（`videoStageFailed`） | 采样语义必须写成"**相邻两次自愈调用之间未成功且同类**"，不得声称"每个失败镜头计数一次"（那是 episode 级口径，见 R13） |
| **R13** | 中 | **episode 级"同集降级镜占比"数据源不存在** | `grep -c "selfHeal\|degrade" src/modules/render.js` = **0**；`shot_renders` 有 `meta` 列但无 `degrade` 写入（`src/db.js:204-212`） | 本卡只做 **stage 级**并在文案/字段名上如实标注（`nodesDegraded/nodesTotal`）；episode 级必须另开卡（T-102 §8.2 的 `render.js` 三处改动），**禁止**用 stage 数据冒充"同集" |
| **R14** | 中 | 改既有套件期望的风险 | 铁律禁止改既有测试期望凑绿 | 新逻辑一律进**新文件** `tests/test-self-heal-trip.js`；`tests/test-selfheal.js` 的 101 条断言与文件 md5 必须原样不变（B1 断言） |
| **R15** | 低 | 新套件未进 `verify-all.sh` → 不在 30 阶段门禁内 | 见 §5 裁决项 | 由集成卡统一接入（阶段 31 + `README.md:11` 计数重算），**不在** W2-B 的 write_scope 内 |

---

## 4. 给 W2 的两张任务卡草案（可直接派发）

### 4.1 卡 W2-A：canvas-perf 正式接线

```yaml
task_id: W2-A
receiver_role: development
priority: P1
task: 把 web/lib/canvas-perf.js 接入 web/views/actors.js 的渲染主路径（4 处表达式替换，不改任何决策）
context:
  upstream: strategist/reports/B-01-research.md（§2 全部）+ T-105-canvas-perf-spec.md §4.2/§5
  constraints: 零依赖 Node≥22 ESM；禁止 npm；禁止重启 8788；禁止改既有测试期望；中文注释与中文报错
dependencies: [B-01]
write_scope:
  - web/views/actors.js
acceptance_criteria:
  - 用命名空间导入 `import * as perf from '../lib/canvas-perf.js'`（禁止裸命名导入；clampZoom/ZOOM_MIN/ZOOM_MAX/visibleItems 同名冲突见 B-01 §2.2）
  - lodLevel() 改为 perf.lodLevelFor(S.zoom) 的薄封装，8 个调用点零改动
  - draw() 内视口矩形/裁剪判定/统计口径/z 序四处替换为 perf.viewportOf/viewClipKeep/cullStats/sortByZ，并删除手数 drawn 与局部 zOf
  - drawLinks 开关改为 perf.shouldDrawLinks({showLinks:S.showLinks, links:S.links})
  - 不接扩展批（17 个函数未实现）；不改 CULL_PAD/LOD_THRESHOLDS/阈值/padding/取整规则
quality_checks:
  - node --check web/views/actors.js
  - node tests/test-actors.js
  - node tests/canvas-perf.test.mjs
  - python3 tests/canvas-audit.py http://127.0.0.1:8788
  - bash scripts/verify-all.sh
evidence_required:
  - 逐条 §2.7 M1~M8 的原始输出（含 exit code）
  - 接线前后 md5sum web/views/actors.js；t-1 基线 69f1774847c67608d03b3a8c17f88809
  - find . -newermt '-30 minutes' -type f 输出（证明只改了 actors.js）
constraints:
  must: [最小改动、保留既有函数名与调用点、备份先行]
  forbidden: [改测试、改 canvas-perf.js、接扩展批、加 rAF/缓存、把 pad 改成 pad/zoom]
requires_backup: true
rollback_plan: cp /tmp/actors.js.bak.<ts> web/views/actors.js 并用 md5sum 核对回 69f1774847c67608d03b3a8c17f88809
max_rework: 2
```

### 4.2 卡 W2-B：self-heal 阶段级熔断 + 降级比例告警接线

```yaml
task_id: W2-B
receiver_role: development
priority: P1
task: 给 self-heal 的阶段级熔断（连续 N 个同类可自愈错误）与降级比例告警（≥30% 或 ≥5 个节点）补上采样器、阈值比较与动作
context:
  upstream: strategist/reports/B-01-research.md（§3 全部）+ T-102-selfheal-spec.md §3.4/§7.2/§8.2
  constraints: 零依赖；不得改 src/self-heal.js（L6 冻结基线）；不得改 tests/test-selfheal.js 既有断言；中文文案
dependencies: [B-01]
write_scope:
  - src/self-heal-trip.js          # 新建（纯函数）
  - src/studio.js                  # 5 处落点
  - tests/test-self-heal-trip.js   # 新建（≥15 条断言）
acceptance_criteria:
  - 新模块导出 tripKeyOf / nextTripState / degradeRatioState / tripNotice，签名与语义逐条按 B-01 §3.5.2
  - studio.js 5 处落点按 B-01 §3.5.3，熔断在 runWithHeal 之前返回（该次生成调用 = 0）
  - 采样位写 app_config（getConfigValue/setConfigValue），成功即清零，换类别即重置为 1
  - 比例告警仅在 alert 为真时调 pauseQueues({reason, by:'system'})，reason 为中文且含占比与恢复方式
  - artifact.selfHeal 追加 tripped/consecutive/threshold/nodesTotal/nodesDegraded/ratio/alert/pauseReason
  - 不新增表、不改既有列、不接路由与 decisions 时间线（另开卡）
quality_checks:
  - node --check src/self-heal-trip.js
  - node tests/test-self-heal-trip.js
  - node tests/test-selfheal.js
  - bash scripts/verify-all.sh
evidence_required:
  - §3.6 B1~B7 原始输出（含 exit code 与临时库路径）
  - md5sum tests/test-selfheal.js = bf210565afa6266d8044e1e7f61373d3（未改证明）
  - 熔断第 3 次的「生成调用次数 = 0」计数原文；比例告警后 pauseState()/pauseHistory() 原文
constraints:
  must: [新模块优先、KV 走 app_config、失败不吞错]
  forbidden: [改 src/self-heal.js、改既有测试期望、用 pauseQueues 做 drain、宣称"按集暂停"、用 stage 数据冒充 episode]
requires_backup: true
rollback_plan: 删除 src/self-heal-trip.js 与 tests/test-self-heal-trip.js；cp src/studio.js 备份回原位并核对 md5 09866843fc3af6e2e0e0cbf56d4d990c；删除 app_config 的 selfheal:trip:* 键
max_rework: 2
```

---

## 5. 需总军师裁决 / 未解决项

| # | 事项 | 两个选项 | 调研军师建议 |
|---|---|---|---|
| **D-1** | 新套件 `tests/test-self-heal-trip.js` 是否接入 `scripts/verify-all.sh` | ①不接入（保持 30 阶段 / 2693 断言，新套件 W2 独立跑并在证据里给原始输出）；②加为阶段 31 并同步 `README.md:11` 计数（write_scope 扩到 `scripts/verify-all.sh` + `README.md`，且必须整跑一次取真值） | **选项 1**：W2 两张卡都不改既有计数，回归口径零扰动；"接入阶段 31 + 计数重算"另开集成卡（与 T-505 同族） |
| **D-2** | 熔断后是否**同时**暂停队列 | ①只 `hold-human`（不暂停，避免 R9 的持久化暂停把整条流水线冻住）；②熔断即 `pauseQueues(by:'system')` | **选项 1**：T-102 §3.4 只把 `pauseQueues` 绑在"降级比例告警"上；熔断绑暂停会让"某个阶段坏掉"升级为"全厂停摆"，且需人工恢复 |
| **D-3** | episode 级降级比例（T-102 原文口径） | ①本卡只做 stage 级并如实命名；②先补 `src/modules/render.js` 的镜头级 `meta.degrade` 再做 episode 级 | **选项 1 先落地、选项 2 另开卡**（`shot_renders.meta` 无 degrade 写入，episode 数据源不存在，硬做只能造假数据） |
| **D-4** | `web/views/actors.js` 的扩展批（17 个函数） | ①另开"扩展批实现卡"再接线；②长期不接 | **选项 1**（契约 §2.3 已立"可分批交付"，但必须"先实现再接线"，禁止在 actors.js 里手抄第三份公式） |
| **D-5** | 结论文件 `strategist/runs/<task_id>.json` | 本卡【写入范围】只给 `strategist/reports/B-01-research.md` | **本次未写 `strategist/runs/B-01.json`**（白名单优先；且总军师通常自己落盘 runs，见 `junshi-matrix §11`「每波结束后由总军师把结果落盘」）。如需落盘，请把该路径写进下张卡的 write_scope |

---

## 6. 证据汇总（一条命令一条结论）

```bash
cd /home/linsheng/Desktop/ai-video-factory

# ① 接线面：零接线 + 导出面 14 键 + 17 个扩展批函数缺失
grep -rn "canvas-perf" --include=*.js web src server.js tests
node -e "import('./web/lib/canvas-perf.js').then(m=>console.log(Object.keys(m).sort().join(',')))"

# ② 静态可服务性（只读，不重启）
curl -s -o /dev/null -w "HTTP %{http_code} bytes=%{size_download} type=%{content_type}\n" http://127.0.0.1:8788/lib/canvas-perf.js

# ③ 同名声明冲突（白屏风险）实证
node --check /tmp/b01/dup.mjs    # SyntaxError: Identifier 'clampZoom' has already been declared
node /tmp/b01/ns.mjs             # 1 2   ← 命名空间导入可行

# ④ 等价性 + 解析表复算（离线，不碰服务）
node -e 'const P=await import("./web/lib/canvas-perf.js"); /* 见 §2.6 脚本 */'

# ⑤ 熔断/告警零触发点
for k in shouldTripStageDegrade degradeSummary degradedRatioAlert tripThreshold; do
  grep -rn "$k" --include=*.js src web server.js | grep -v '^src/self-heal.js' | wc -l   # 全为 0
done
grep -rn "selfheal_events" --include=*.js src web                  # 只有 CREATE/INSERT/COUNT 三处
grep -rn "pauseQueues(" --include=*.js src                        # 无一处来自 self-heal
grep -c "selfHeal\|degrade" src/modules/render.js                  # 0（镜头级自愈未接线）

# ⑥ 回归基线（本轮只读真跑）
node tests/canvas-perf.test.mjs        # === 结果：89 通过 / 0 失败 ===  exit=0
md5sum web/views/actors.js web/lib/canvas-perf.js src/self-heal.js src/studio.js tests/test-selfheal.js
```

**红线自查（本卡）**：只写 1 个文件（本报告）；未改源码/测试；未重启 8788（仅 1 次只读 GET）；未引入 npm 依赖；未暴露思维链；`/tmp/b01/*` 只用于"同名导入报错"的实证。

---

## 7. 未解决风险与后续卡建议

1. **W2-A 之后**：扩展批实现卡（17 个函数，含 `edgeAnchor` 端口表**必须参数化**，禁止复制 `NODE_KINDS`/`PORT_RULES` 第三份）→ 扩展批接线卡。
2. **W2-B 之后**：只读暴露卡（`GET /api/render/selfheal` + `src/decisions.js` 的 `selfheal_events` 时间线，写法照抄 `decisions.js:143-156` 的队列暂停段）→ 让"熔断/降级"对人和 Agent 可见（当前 `artifact.selfHeal` 写了没人读）。
3. **episode 级降级比例卡**：需先补 `src/modules/render.js` 的 `insertShotRender` meta + `createAssembleJob` 汇总（T-102 §8.2 三处改动目前**全部未做**）。
4. **集成计数卡**：新套件接入 `scripts/verify-all.sh` 为阶段 31 + `README.md:11` 计数重算（D-1 选项 2），必须整跑取真值，禁止手写数字。
