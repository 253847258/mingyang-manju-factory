# D-01 UI 交互与状态规划书 · 画布「类型筛选 / 多选批处理」＋ 制作台「排产」面板

> 角色：UI 规划师｜波次：设计波（D 线）｜本卡只产出本文件与 `strategist/runs/D-01.json`，**不改任何源码、不改任何既有测试**
> 上游依据（全部只读核对过，行号即证据）：`strategist/reports/README.md`（收口报告）、`strategist/reports/L6-verify.md`（验收与残余风险）、`strategist/reports/T-101-schedules-spec.md`（排产契约 §9 API 形状 / §9.8 前端最小数据面 / §10）、`strategist/reports/T-103-canvas-select-spec.md`（画布筛选与批处理契约 §3.6 UI 契约 / §4 / §5 / §9 / §10）、`strategist/runs/T-101.json`、`T-103.json`
> 落地代码依据（只读核对）：`web/views/actors.js`、`web/views/render.js`、`web/lib/canvas-select.js`、`web/lib/ui.js`、`web/app.js`、`src/routes/schedules.js`、`src/schedules.js`、`src/mcp-server.js`、`server.js`、`scripts/verify-all.sh`

---

## 0. 本文件怎么用（给 W2 开发线）

1. **读法**：§2/§3 是画布线，§4 是排产线。每节末尾的 **「W2 待补齐清单」（D-C-xx / D-S-xx）** 就是可直接开工的开发项，每条都给了「文件:行号 → 改什么 → 字段/接口 → 对应验收点（UI-AC-xx）」。
2. **编号约定**：`ST-*` = 界面状态行（状态表主键）；`D-*` = 待补齐开发项；`UI-AC-*` = 验收点；`R-*` = 风险。
3. **口径铁律（本卡不放松任何一条）**：
   - 界面的**判定**只允许来自 `web/lib/canvas-select.js` 的纯函数（计划、文案、确认闸门、主画布保护），视图层只做「渲染 + 按 effects 发包」；
   - 付费动作（按类型重跑）**只出计划**，放行必须人工批准 + 终端确认码，**禁止** `/api/canvas/run`、`/api/canvas/run-node`（`web/lib/canvas-select.js:157`）；
   - 筛选是纯 UI 内存态，**不落库**（T-103 I1）；批量动作一律走增量接口，不用 `POST /api/canvas/restore`；
   - 改动**只加属性/文案/控件，不重构既有 DOM 结构**——`tests/ui-simulate.py`（verify-all 阶段 23）与 `tests/canvas-audit.py`（阶段 25）按选择器驱动真实 UI，结构重构会引入假回归。

### 0.1 冻结基线（W2 动手前先 `cp` 一份 `.bak`，改动后与本表比对）

| 文件 | 行数 | md5 |
|---|---|---|
| `web/views/actors.js` | 4958 | `69f1774847c67608d03b3a8c17f88809` |
| `web/views/render.js` | 2776 | `fb6eaedef783f26daa17889268caf085` |
| `web/lib/canvas-select.js` | 1175 | `8fad191e6608defd48ee9f62b91a08f6` |
| `src/routes/schedules.js` | 314 | `54986a31255df20e69154679d8a478c0` |
| `web/lib/ui.js` | 172 | `9df6e580e7c8c4bc737c346beb0d4d24` |
| `web/app.js` | 169 | `f70a1f39a2ee096f7dcb91257980606a` |

> 复现：`md5sum web/views/actors.js web/views/render.js web/lib/canvas-select.js src/routes/schedules.js web/lib/ui.js web/app.js`
> 注意：`strategist/reports/L6-verify.md:426` 已记录 T-106 里的 `actors.js` md5 基线**已过期**（那张表是改造前的值），后续验收**不要**再照抄旧 md5，以本表为准。
> 另：第 2 轮 P0 卡 `C-002`（改 `web/lib/canvas-select.js` + `tests/canvas-select.test.mjs`）落地后，上表第 3 行指纹会变，属**预期变化**；W2 在 C-002 之后开工时，请先重取 `canvas-select.js` 指纹并把本表第 3 行更新为 C-002 后的值（其余 5 个文件不受 C-002 影响）。

---

## 1. 已核对的现状：入口、接口、缺口

### 1.1 画布线（模块 1 `#/actors`）

| # | 事实 | 证据（文件:行号） |
|---|---|---|
| 1 | 筛选入口按钮 `🔎 类型筛选`（`id="ac-kind-filter"`），title 已声明「只筛选与选中，不删任何节点」 | `web/views/actors.js:200` |
| 2 | 批处理入口按钮 `⇄ 多选批处理`（`id="ac-batch-select"`） | `web/views/actors.js:201` |
| 3 | 计划入口按钮 `🧭 执行计划`（`id="ac-plan"`），`planDialog()` 内部走 `/api/canvas/plans` → approve → run | `web/views/actors.js:203`、`3437-3520` |
| 4 | 可见 layout items：`visibleItems()` 返回 `S._layout.items` | `web/views/actors.js:4683-4687` |
| 5 | 当前筛选规格：`nodeFilterSpec()` = `normalizeNodeFilter(S.kindFilter \|\| {})` | `web/views/actors.js:4690` |
| 6 | 五维筛选控件 `nodeFilterEditor()`：类型多选 chips + 有产物/失败/锁定三态 + 反选 | `web/views/actors.js:4693-4733` |
| 7 | 筛选对话框 `kindFilterDialog()`：实时预览命中数 + chips + 「✓ 应用并选中匹配项 / ⌀ 清除筛选 / 关闭」 | `web/views/actors.js:4749-4799` |
| 8 | 批处理对话框 `batchSelectDialog()`：范围选择（选区/筛选命中）＋动作选择（`SUPPORTED_ACTIONS` 7 项）＋参数＋计划预览＋护栏提示 | `web/views/actors.js:4825-4908` |
| 9 | 执行链 `runBatchPlan()`：计划复核 → 危险确认（`confirmStages` 逐段）→ `pushUndo()` → 自动快照 → 按 effects 顺序发包 → 刷新 → toast | `web/views/actors.js:4915-4956` |
| 10 | HUD chips 渲染 `updateHud()`：现有 8 类 chip（缩放/模式/人数/已选/组/便签/撤销/连线/LOD），**无筛选 chip** | `web/views/actors.js:623-645` |
| 11 | 纯逻辑导出面（**36 个 `export`**，19 个常量 + 17 个函数）：`DEFAULT_NODE_FILTER`/`TRIPLE_STATES`/`NODE_FILTER_DIMS`/`SUPPORTED_ACTIONS`/`BATCH_ACTIONS`/`BATCH_MESSAGES`/`BATCH_MAX_NODES=500`/`MAIN_CANVAS_ID='CV-MAIN'`/`planBatch`/`applyBatchPlan`/`describeBatchPlan`/`nodeFilterChips`/`describeNodeFilter`/`filterItems`/`normalizeNodeFilter`/`isMainCanvas`/`clampNodeSize` 等 | `web/lib/canvas-select.js:41-173`、`283-471`、`996-1174` |
| 12 | 计划错误码全集（**16 个**）：`UNSUPPORTED_ACTION` `EMPTY_SELECTION` `TOO_MANY_NODES` `BAD_PARAMS` `MATRIX_MODE` `ALL_LOCKED` `CANVAS_DELETE_FORBIDDEN` `MAIN_CANVAS_GUARD` `NOTHING_TO_DO` `NO_ACTOR` `NO_EXECUTABLE` `SERVER_BLOCKED` `NEED_CONFIRM` `NO_PLAN` `STALE_PLAN` `PLAN_NOT_OK`（另有成功码 `OK`）。**第 2 轮 P0 卡 `strategist/tasks/C-002-canvas-id-fail-closed.yaml` 会新增第 17 个码 `CANVAS_ID_REQUIRED`**（并在计划对象上新增 `canvasSource ∈ 'opts'\|'params'\|'items'\|'none'`） | `web/lib/canvas-select.js:617-1009`、`1066-1084`；`strategist/tasks/C-002-canvas-id-fail-closed.yaml` |
| 13 | 弹窗/确认基础件 `modal()`/`confirmDialog()`/`toast()`：均**无任何 `aria-*` 属性**；`modal()` 支持 Esc 关闭；两者都不做焦点管理 | `web/lib/ui.js:26-70`；全仓 `grep -c "aria-"` = 0（4 个前端文件） |
| 14 | 既有测试与自检：`tests/canvas-select.test.mjs`（486 行 / 222 断言 / A~D 四段）纳入 verify-all **阶段 28/30** | `scripts/verify-all.sh:70`、`tests/canvas-select.test.mjs:111/226/411/475` |

### 1.2 排产线（模块 4 `#/render`）

| # | 事实 | 证据（文件:行号） |
|---|---|---|
| 1 | 入口按钮 `⏰ 排产`（`data-act="schedules"`） | `web/views/render.js:603`、`2662` |
| 2 | 面板 `openSchedulesPanel()`：列表区 + 调度器行 + 新建表单 + 底部「⟳ 刷新 / 关闭」 | `web/views/render.js:2355-2535` |
| 3 | 现实数据面：`GET /api/schedules`（**实测**返回 `ok/now/enabled/scheduler/queue/costNote/schedules[]/meta`，`scheduler={tickSeconds:60,tickMs:60000,leaseTtlSeconds:180,lease{owner,expires_at,now,held,raw},running}`，`queue={paused:false,reason:''}`，`meta.statusText`5 项、`meta.reasonText`15 项、`meta.defaults={defaultTz:'Asia/Shanghai',graceMin:5,catchup:false,maxCatchup:1,skipIfRunning:true}`，当前 `schedules: []`） | `curl -s 'http://127.0.0.1:8788/api/schedules?reconcile=0'`（只读，实测于本卡） |
| 4 | 面板**已用**的字段：`r.schedules[]` 的 `name/id/enabled/kind/mode/summary/next_run_text/fire_count/skip_count/miss_count/running/status_text/target.brief`；`r.scheduler.running/tickSeconds`；`r.enabled` | `web/views/render.js:2452-2483` |
| 5 | 面板**未用**的字段：`r.queue.paused/reason`、`r.costNote`、`r.meta.*`、`scheduler.lease.*`、`s.in_minutes/next_run_at/last_run_at/last_status/last_job_id/last_job_status/last_production_id/last_error`、`s.tz/miss_policy/catchup_max/grace_min/skip_if_running/budget_guard` | 对照 `src/routes/schedules.js:178-197`、`src/schedules.js:588-653` |
| 6 | 接口就绪性分支：列表读取失败 → `.rd-notice`「排产接口未就绪」并把「创建/试算」按钮 `disabled=true` | `web/views/render.js:2449-2498` |
| 7 | 启停：`PATCH /api/schedules/:id {enabled, by:'human'}`；试算：`POST /api/schedules/preview {schedule,count:3}`；创建：`POST /api/schedules`（请求体 snake_case，`schedulePayload()` 按 kind 拼） | `web/views/render.js:2332-2348`、`2501-2532` |
| 8 | **缺失**：`POST /api/schedules/:id/trigger`（立即跑一次）、`DELETE /api/schedules/:id`、编辑（PATCH 其它字段）在界面上**都没有入口**；触发历史只以「新标签打开 JSON 接口」呈现 | `web/views/render.js:2466-2468`；对照 T-101 §9.8 |
| 9 | 队列暂停横幅在**全局**（`web/app.js:113-124`，点击即 `POST /api/queue/resume`），排产面板内不解释「排产为什么不动」 | `web/app.js:112-124`；`src/routes/render.js:104-120` |
| 10 | 服务端中文映射即用即取：`meta.statusText`（fired/deduped/skipped/missed/failed）、`meta.reasonText`（due/not_due/pending/skipped_disabled/skipped_paused/skipped_budget/skipped_production_cap/skipped_storage/skipped_running/skipped_missed/skipped_no_target/skipped_deduped/error_trigger_failed/error_invalid_time/done_once） | `src/schedules.js:57-69`、`src/routes/schedules.js:191-195`（实测同上） |
| 11 | 排产创建校验与中文报错（12 条）已由服务端给出，界面**不做重复校验**（只做「名称为空」前置 toast） | T-101 §9.2 校验表；`src/routes/schedules.js:200-212` |
| 12 | 相关测试：`tests/test-schedules.js`（116 断言）纳入 verify-all **阶段 26/30** | `scripts/verify-all.sh:68` |

### 1.3 硬约束（两处面板都不许碰的行为）

| 不许碰 | 原因/证据 |
|---|---|
| `Ctrl+A` 的既有语义 | `tests/ui-simulate.py` 有既有断言（T-103 §3.4） |
| `filteredActors()`、折叠分组、`showAll`、四个既有批处理函数（`alignSelection`/`distributeSelection`/`bumpZ`/`uniformSize`）签名与行为 | T-103 §3.4 / `strategist/runs/T-103.json` |
| `removeCanvasNode` 的语义（只删一行、不清连线） | 界面必须**先**调 `DELETE /api/canvas/nodes/:id/links`（`web/lib/canvas-select.js:778-784`） |
| `GET /api/canvas` 入参（本卡不做服务端筛选） | T-103 §3.7；`src/routes/actors.js:159` |
| 8788 服务进程（本波禁止重启；界面改动随浏览器刷新生效，无构建步骤） | 任务书约束；`web/` 为原生 ESM 静态资源 |
| `config/config.json` | 用户数据文件（L6 RK-L6-06 已记录全量自检会重写它；本卡不跑全量自检） |

---

## 2. 画布「类型筛选」交互与状态表

### 2.1 交互模型

```
入口：#ac-kind-filter「🔎 类型筛选」→ kindFilterDialog()（模态，width:660）
状态：S.kindFilter = normalizeNodeFilter(...)  ← 纯内存，不落库（I1）
数据：items = visibleItems()（当前画布的可见 layout items，I4）
判定：filterItems(items, spec) → matchNodeFilter（五维 AND / 维度内 OR / negate 最外层）
落地：① S.selection = 命中项里「有 actor.id」的集合；② S.selectedOrder；③ fitItemsInView(命中项)
出口：✓ 应用并选中匹配项 / ⌀ 清除筛选 / 关闭（Esc 或点遮罩）
```

### 2.2 控件 ↔ 字段 ↔ 文案绑定表

| 控件 | 绑定字段（`DEFAULT_NODE_FILTER`） | 取值 | 文案来源 | 现状行号 |
|---|---|---|---|---|
| 类型 chips（多选，可点切换） | `kinds: string[]` | `NODE_KINDS` 全集（界面用的是**视图自己的**类型表，保证不漏项） | `KIND_LABELS[k]` | `actors.js:4698-4712` |
| 有产物 | `hasArtifact: 'any'\|'yes'\|'no'` | 三态下拉，`any=不限` | `TRIPLE_STATES` | `actors.js:4714-4720` |
| 失败 | `failed` 同上 | 同上 | 同上 | 同上 |
| 锁定 | `locked` 同上 | 同上 | 同上 | 同上 |
| 反选 | `negate: boolean` | 勾选框，title=「五维判定后整体取反（不是逐维取反）」 | 固定 title | `actors.js:4721-4725` |
| 分组 `groups: string[]` | **契约要求、界面缺控件**（`''`=未分组） | — | — | 见 D-C-01 |
| 实时预览 | — | `describeNodeFilter(spec,total,matched)`，如「筛选：视频片段/关键帧 · 有产物 · 未锁定（12/48）」 | `canvas-select.js:418-432` | `actors.js:4756-4758` |
| 命中 chips | — | `nodeFilterChips(spec,items)` → `[{dim,key,label,count,active}]`，每片 `label（count）` | `canvas-select.js:440-471` | `actors.js:4759-4764` |

### 2.3 组合语义速查（实现与验收共用，逐条来自 T-103 §3.3 / §10）

| 规则 | 内容 |
|---|---|
| 维度间 | **AND**（五个维度全部满足才命中） |
| 维度内 | `kinds` / `groups` 内部 **OR**（`includes` 精确匹配；`groups` 按 **组 id** 不按组名） |
| 空数组 | = 该维度**不限** |
| `''` 分组 | 是一条正常取值（未分组），不是「不限」 |
| 三态 | `any`=不限，`yes`/`no` 为严格判定；非法值回落 `any`（不抛错） |
| `negate` | 在**五维判定结果的最外层**取反（不是逐维取反） |
| 默认态 | `DEFAULT_NODE_FILTER` 必须与改造前行为**零差异** |
| 不改选中集 | 筛选本身不改 `S.selection`；只有「✓ 应用并选中匹配项」才改（I3） |

### 2.4 状态表（筛选面板）

| 状态 id | 触发条件 | 界面表现 | 控件可用性 | 文案（固定串，测试按此断言） |
|---|---|---|---|---|
| `ST-C-F1` 默认态 | `S.kindFilter` 为空/未设 | 预览「筛选：不限（n/n）」；chips 区显示「当前不限（画布全部节点都在范围内）」 | 全可用 | `describeNodeFilter` 输出 |
| `ST-C-F2` 部分筛选 | 任一维度非默认 | 预览含命中数与各维中文；chips 每片带该维命中数 | 全可用 | 同上 |
| `ST-C-F3` 反选态 | `negate=true` | 预览以「反选：」开头；额外一片「反选（m）」 | 全可用 | 同上 |
| `ST-C-F4` 无匹配 | `matched.length === 0` | 预览 `（0/n）`；「✓ 应用并选中匹配项」仍可点，但点后 toast 为 warn | 按钮**不置灰**（可点，给出明确反馈） | `当前筛选没有匹配的节点（试试「清除筛选」）`；契约固定串为 `当前筛选没有匹配的节点；点「⌀ 清除筛选」查看全部`（`canvas-select.js:170`）→ 见 D-C-02 |
| `ST-C-F5` 空画布 | `items.length === 0` | 预览「（0）」；chips 区空；应用无效果 | 按钮可点（幂等无副作用） | 同上 |
| `ST-C-F6` 幽灵卡位（未落库） | item.node === null | 参与筛选与计数（判定按 item 字段）；应用时只把有 `actor.id` 的加入选中集 | 全可用 | 无额外文案（信息性） |
| `ST-C-F7` 画布切换/重载 | `loadCanvas()` 后 | 筛选规格**保留**（内存态不落库）；命中数按新画布重算 | 全可用 | 预览计数自动刷新 |
| `ST-C-F8` 关闭未应用 | 点「关闭」/Esc/点遮罩 | 不改 `S.kindFilter`、不改选区 | — | 无 toast（静默） |

### 2.5 空态与错误态文案总表（画布线，唯一来源 `canvas-select.js`）

| 场景 | 固定文案 | 出处 |
|---|---|---|
| 筛选无匹配（契约串） | `当前筛选没有匹配的节点；点「⌀ 清除筛选」查看全部` | `canvas-select.js:170` |
| 选中筛选结果为空（契约串） | `当前筛选没有可选的节点` | `canvas-select.js:171` |
| 清除筛选 | `已清除节点筛选`（现实现为 `已清除节点筛选（全部节点回到范围内）`） | `canvas-select.js:172` / `actors.js:4792` |
| 移动空选区 | `请先在画布上选中要处理的节点` | `canvas-select.js:113` |
| 删除空选区 | `请先选中要删除的节点` | `canvas-select.js:123` |
| 成组空选区 | `先选中要成组的卡片` | `canvas-select.js:128` |
| 重跑空选区 | `请先在画布上选中要重跑的节点` | `canvas-select.js:133` |
| 宫格模式批量移动 | `宫格模式下拖动是「换序」不是移动；批量移动请先切到自由模式（✦）` | `canvas-select.js:161` |
| 全锁定 | `选中的 n 个卡位全部已锁定，无法移动（先解锁）` | `canvas-select.js:162` |
| 尺寸夹取 | `尺寸已限制在 90×90 ~ 900×1200 之间` | `canvas-select.js:87/163` |
| 连线不可撤销警告 | `⚠️ 该操作连带删除的连线无法用「撤销」恢复；需要回退请用「📸 快照」。` | `canvas-select.js:164` |
| purge 跨画布警告 | `⚠️ 该操作影响所有画布，快照只保护当前画布。` | `canvas-select.js:165` |
| 主画布保护 | `主画布不可删除（它是宫格预览全部演员的入口画布）：请先用筛选缩小选区后再批量删除，或改用「⊕ 放入全部」恢复` | `canvas-select.js:169` |

### 2.6 无障碍要点（筛选面板）

| 编号 | 要求 | 具体做法（只加属性，不改结构） |
|---|---|---|
| A-C-01 | 对话框语义 | `modal()` 增加 `role="dialog"` + `aria-modal="true"` + `aria-labelledby`→ header 文本节点（`ui.js:53-70`） |
| A-C-02 | 焦点进入与返回 | 打开时焦点移到第一个可交互控件（类型 chips 容器或「关闭」），关闭后焦点返回 `#ac-kind-filter` |
| A-C-03 | 键盘可达 | 类型 chips 现为 `span.pill`（**不可 Tab 聚焦**）→ 改为 `<button type="button" class="pill">` 并加 `aria-pressed`；保留原 class 与文本，避免打坏既有选择器 |
| A-C-04 | 三态下拉 | 每个 `<select>` 用 `labeled()` 关联（`<label class="f"><span>…</span><select>` 已有关联；补 `aria-label` 兜底） |
| A-C-05 | 实时播报 | 预览行加 `role="status" aria-live="polite"`（只播报计数，不播报每次点击） |
| A-C-06 | 反选开关 | checkbox 加 `aria-describedby` 指向解释串「五维判定后整体取反」 |
| A-C-07 | Esc/遮罩 | 既有行为保留；加 `aria-hidden` 不需要（用 `role="dialog"` 即可），但 Esc 必须**不修改**筛选态（`ST-C-F8`） |
| A-C-08 | 颜色非唯一载体 | chips 选中态除 `.on` 边框色外，必须有 `aria-pressed="true"`（屏读可见） |
| A-C-09 | 触达尺寸 | chips 最小高度 24px→保持 26px 以上，点击热区 ≥ 24×24（现 `.pill` 内边距 3px 9px，需实测 ≥24px 高） |
| A-C-10 | 动效 | 若为筛选结果加高亮过渡，须 `@media (prefers-reduced-motion: reduce)` 降级为无动画 |

### 2.7 W2 待补齐清单（筛选）

| 编号 | 开发项 | 位置（文件:行号） | 具体改法（字段/接口/步骤） | 验收点 |
|---|---|---|---|---|
| **D-C-01** | 补 `groups` 维度控件 | `web/views/actors.js:4693-4733` | 在类型 chips 下加「分组（可多选）」chips：候选来自当前画布 `S.groupFrames`（`id`+`name`）+ 固定项 `''`（显示「未分组」）；写回 `draft.groups = string[]`；用 `''` 而非 `null` 表示未分组 | UI-AC-05 |
| **D-C-02** | 统一无匹配文案到契约固定串 | `web/views/actors.js:4786`、`4790-4792` | 把 toast 文案替换为 `BATCH_MESSAGES.noMatchingNodes` / `filterCleared`（`canvas-select.js:170-172`），不再另写字面量 | UI-AC-06 |
| **D-C-03** | HUD 增筛选 chip（契约 §3.6 要求） | `web/views/actors.js:623-645` | 在 chips 数组里追加两片：① `describeNodeFilter(spec, items.length, matched.length)`；② `👁 筛选中 m/n`（m=命中、n=总数），筛选非默认时加 `.on` 类 | UI-AC-07 |
| **D-C-04** | 初始化 `S.kindFilter` 声明 | `web/views/actors.js:69-73` | 在 `S = { ... }` 里显式声明 `kindFilter: normalizeNodeFilter({})`（当前靠 `undefined \|\| {}` 兜底，可读性差且易被误认为死字段） | UI-AC-08 |
| **D-C-05** | 筛选面板 a11y 属性 | `web/lib/ui.js:53-70`、`web/views/actors.js:4698-4731` | 按 A-C-01…A-C-10 只加属性与标签语义 | UI-AC-20/21 |
| **D-C-06** | 应用后给出可核对回执 | `web/views/actors.js:4780-4788` | 应用时 toast 必须写「已按筛选选中 N 个节点」，N = 实际写入 `S.selection` 的数量（现实现用 `matched.length`，含非演员项，会与选中数不一致） | UI-AC-09 |

---

## 3. 画布「多选批处理」交互与状态表

### 3.1 交互模型与作用域语义

```
入口：#ac-batch-select「⇄ 多选批处理」→ batchSelectDialog()（模态，width:700）
作用域 ui.scope：'selection'（画布选区，默认当选区非空）| 'filtered'（筛选命中项）
   selected = filtered.filter(it => S.selection.has(it.actor?.id) || S.selection.has(it.actorId))
   base     = scope === 'filtered' ? filtered : selected          ← I4：只作用于可见项
动作 ui.action ∈ SUPPORTED_ACTIONS = move/resize/delete/group/rerun-kinds/lock/unlock
参数：move→{dx,dy}｜resize→{scale}｜group→{name}｜其余→{}
计划：planBatch(action, base, params, {canvasId, canvasName, mode, includeLocked, canvasTotal: items.length})
      → plan.ok / code / reason / entries / skippedEntries / effects / messages / notices /
        confirmStages / confirmText / confirmMode('single'|'double') / affected / skipped /
        mainCanvas / autoSnapshot / snapshotLabel / undoable / requiresConfirm / requiresApproval
执行：runBatchPlan() 在点击那一刻**重新生成计划**（防 STALE_PLAN）→ confirmStages 逐段确认 →
      pushUndo()（undoable 时）→ autoSnapshotBefore()（autoSnapshot 时）→ replayEffects() → loadCanvas() → toast
```

### 3.2 动作 ↔ 参数 ↔ 计划元数据表（`BATCH_ACTIONS` 实测值）

| 动作 id | 中文 label | danger | 付费 | 需确认 | 需审批 | 自动快照 | 空选区专属文案 | 关键前置校验（计划层） |
|---|---|---|---|---|---|---|---|---|
| `move` | 批量移动 | low | 否 | 否 | 否 | 否 | 请先在画布上选中要处理的节点 | `BAD_PARAMS`（dx/dy 非有限、同时为 0）、`MATRIX_MODE`、`ALL_LOCKED` |
| `resize` | 批量缩放 | low | 否 | 否 | 否 | 否 | 同上 | `BAD_PARAMS`（w/h/scale）、`ALL_LOCKED`；`clampNodeSize` 夹 90×90~900×1200 |
| `delete` | 批量删除 | **high** | 否 | **是**（主画布/整画布 → 双段） | 否 | **是** | 请先选中要删除的节点 | `BAD_PARAMS`（mode∉detach/purge、scope∉selection/all）、`CANVAS_DELETE_FORBIDDEN`、`MAIN_CANVAS_GUARD`、`ALL_LOCKED`、`NOTHING_TO_DO`（全幽灵） |
| `group` | 批量成组 | mid | 否 | 否 | 否 | **是** | 先选中要成组的卡片 | `NO_ACTOR`（无演员卡）；非演员项跳过并提示 |
| `rerun-kinds` | 按类型重跑 | **max** | **是** | **是** | **是** | 否 | 请先在画布上选中要重跑的节点 | `NO_EXECUTABLE`（无可执行类型）、`SERVER_BLOCKED`（preflight：磁盘/暂停/预算中文原因）、`NOTHING_TO_DO`（全幽灵） |
| `lock` | 批量锁定 | mid | 否 | 否 | 否 | 否 | 请先在画布上选中要处理的节点 | `NOTHING_TO_DO`（状态无需变更） |
| `unlock` | 批量解锁 | mid | 否 | 否 | 否 | 否 | 同上 | 同上 |

> 出处：`canvas-select.js:109-145`（元数据）、`617-1009`（校验）、`999-1022`（入口）；契约侧 T-103 §4.1/§4.2–§4.6 为 5 动作版，实现扩展出 `lock`/`unlock`（T-103 未定义，属实现增量，界面已暴露）。

### 3.3 界面状态表（批处理面板）

| 状态 id | 条件 | 面板表现 | 主按钮 | 必须出现的文案 |
|---|---|---|---|---|
| `ST-C-B1` 无任何可处理项 | `selected.length === 0 && filtered.length === 0` | 范围下拉显示「画布选区（0）/筛选命中项（0）」 | **disabled** | 护栏区：`没有可处理的节点：先在画布上框选，或到「🔎 类型筛选」缩小范围。` |
| `ST-C-B2` 选区为空但有筛选命中 | `selected=0, filtered>0` | `ui.scope` 自动切到 `filtered` | 可用 | 头部显示「处理范围：选区 0 项 · 筛选命中 N 项（筛选摘要）」 |
| `ST-C-B3` 计划被前置校验拒绝 | `plan.ok === false` | 预览行变 warn 色，显示 `plan.reason` | **disabled** | 例：`MATRIX_MODE` → 宫格提示；`ALL_LOCKED` → 全锁定提示；`MAIN_CANVAS_GUARD` → 主画布保护提示 |
| `ST-C-B4` 超上限 | `base.length > 500` | `TOO_MANY_NODES`：`一次最多处理 500 个节点（当前 N 个）：请先用筛选缩小范围` | **disabled** | 同上 |
| `ST-C-B5` 危险动作待确认 | `plan.requiresConfirm` | 护栏区提示「⚠️ 危险动作（危险等级 high）：执行前会再确认一次/两次」 | 可用（点击后走确认） | `plan.confirmMode === 'double'` 时文案写「两次」 |
| `ST-C-B6` 付费动作 | `plan.requiresApproval` | 护栏区「⏳ 付费动作：本面板只生成执行计划，放行必须人工批准 + 终端确认码（程序不会自动开跑）」 | 可用（仅出计划） | 执行后弹「⏳ 按类型重跑：已生成执行计划，等待人工批准」+ 5 步审批链 |
| `ST-C-B7` 主画布 | `isMainCanvas(S.canvasId)` | 护栏区「当前画布：主画布（CV-MAIN）——保护闸门生效」 | 视计划而定 | 删除整画布时叠加 `MAIN_CANVAS_GUARD` |
| `ST-C-B8` 含锁定项 | `includeLocked` 勾选 | 参数区「包含已锁定」+ 计划 notices 提示「其中 n 项已锁定：确认要一并删除吗？」 | 可用 | 锁定的重跑必须提示「锁定只防误拖，不阻止执行」 |
| `ST-C-B9` 计划过期 | 面板打开期间画布被刷新/筛选变化 | 执行瞬间重新生成计划；若 `itemCount` 不匹配 → `STALE_PLAN` | — | `计划与当前节点列表不匹配（计划基于 X 项，当前 Y 项）：请重新生成计划` |
| `ST-C-B10` 执行部分失败 | `replayEffects().failed.length > 0` | toast err | — | `部分步骤失败：<前 2 条>`（`actors.js:4935`） |
| `ST-C-B11` 执行成功 | `out.affected > 0` | 关面板 + toast ok + 画布刷新 + HUD 更新 | — | `out.messages[0]`（如「已移除 N 个卡位，跳过 M 个已锁定」） |
| `ST-C-B12` 无几何/内容变更 | `out.changed === false`（如 group 由服务端生成 id） | 面板关闭、toast info | — | `out.messages[0]`（如「已把 N 张卡片组成「X」」） |

### 3.4 危险确认矩阵（界面必须逐条实现，文案取自 `plan.confirmStages`）

| 动作 | danger | 确认段数 | 确认文案来源 | 自动快照 | 撤销入栈 | 确认码/审批 |
|---|---|---|---|---|---|---|
| `move` / `resize` | low | 0 | — | 否 | 是（一次动作 = 一步） | 无 |
| `lock` / `unlock` | mid | 0 | — | 否 | 是 | 无 |
| `group` | mid | 0 | — | **是**（`批处理前 · 批量成组`） | 是 | 无 |
| `delete`（detach，子集） | high | 1 | `把选中的 N 个卡位从「画布名」移除？演员档案与定妆图不受影响。` | **是** | 是 | 无 |
| `delete`（detach，主画布或整画布） | high | **2** | 第 2 段：主画布「再次确认：主画布是「宫格预览全部演员」的入口画布；需要恢复请用「⊕ 放入全部」。」/ 非主画布「再次确认：清空画布的全部卡位与关系线？」 | **是** | 是 | 无 |
| `delete`（purge 演员档案） | high | **2** | `确认删除 N 位演员（名…）？其定妆图记录也会一并删除。` + `再次确认：这将永久删除演员档案，不可通过「撤销」恢复。` | **是** | 是 | 无（跨画布生效，见 R-03） |
| `rerun-kinds` | **max** | 1 | `plan.confirmText`（重跑闸门串） | 否 | **否**（U4 不入撤销栈） | **必须**：`/api/canvas/plan` → `/api/canvas/plans` → `approve` → 终端 6 位确认码 → `plans/:id/run` |
| 删除整画布（scope=all / 覆盖全部项） | max | — | — | — | — | **硬拒绝**：`MAIN_CANVAS_GUARD`（主画布）/ `CANVAS_DELETE_FORBIDDEN`（批处理永不删画布） |

> 确认交互硬要求：① 每一段都是**独立弹窗**，第二段必须重新点「确定」（`confirmDialog` 逐段 await，`actors.js:4920-4927`）；② 取消任一段 → toast「已取消：没有改动任何节点」且**零请求**；③ 确认弹窗必须写明**实际处理数**（H9：筛选态下误判选区范围）。

### 3.5 执行时序（编号步骤 = 实现步骤，也可当手测脚本）

| 步 | 动作 | 接口/调用 | 失败分支 |
|---|---|---|---|
| 1 | 用户点「▶ 执行批处理」 | `runBatchPlan(makePlan, m)` | — |
| 2 | **重新生成计划**（点击那一刻） | `planBatch(...)`（同源复核） | `!plan.ok` → toast `plan.reason`，**零请求** |
| 3 | 危险动作逐段确认 | `confirmDialog(stages[i])` | 任一取消 → 终止 |
| 4 | 应用计划（纯内存投影） | `applyBatchPlan(plan, {items: base, confirm, confirmAgain, includeLocked})` | `STALE_PLAN`/`NEED_CONFIRM`/`PLAN_NOT_OK` → toast，零请求 |
| 5 | 撤销留档 | `pushUndo()`（`out.before.undo` 为真时） | — |
| 6 | 自动快照 | `POST /api/canvas/snapshots {canvas_id, name:'批处理前 · <label>', note:'多选批处理自动留档（可回滚）'}` | 失败 → warn toast，**不阻断** |
| 7 | 按 `effects` 顺序发包 | `DELETE /api/canvas/nodes/:id/links` → `DELETE /api/canvas/node/:id`；`POST /api/canvas/groups {canvas_id,name,color,actorIds}`；`POST /api/canvas/nodes`（幽灵物化）；`POST /api/canvas/node/:id/lock` | 单包失败进 `failed[]`，继续后续 |
| 8 | 付费重跑特判 | 见 `ST-C-B6`：**只出计划**，弹审批链说明 | 禁止调 `/api/canvas/run` |
| 9 | 刷新与回执 | `loadCanvas()` → `updateCount()` → `renderList()` → `draw()`；toast `messages[0]` + `warning` | — |

### 3.6 计划错误码 → 界面处置表（W2 必须逐条覆盖）

| code | 用户可见文案（来源） | 界面处置 |
|---|---|---|
| `EMPTY_SELECTION` | `BATCH_ACTIONS[action].emptyReason` | 主按钮 disabled + 护栏提示；文案随动作变化（不是一句通用话） |
| `TOO_MANY_NODES` | `一次最多处理 500 个节点（当前 N 个）：请先用筛选缩小范围` | 主按钮 disabled + 建议「去筛选」 |
| `MATRIX_MODE` | `BATCH_MESSAGES.matrixMove` | 主按钮 disabled + 提示「切到自由模式（✦）」 |
| `ALL_LOCKED` | `选中的 n 个卡位全部已锁定，无法<动作>（先解锁）` | 主按钮 disabled + 提供「包含已锁定」勾选建议 |
| `MAIN_CANVAS_GUARD` | `BATCH_MESSAGES.mainCanvasGuard` | 主按钮 disabled + 明示「先用筛选缩小选区」或「⊕ 放入全部」恢复 |
| `CANVAS_DELETE_FORBIDDEN` | `批处理不允许删除画布：主画布由后端硬闸门保护，其他画布请走画布栏入口` | 主按钮 disabled |
| `CANVAS_ID_REQUIRED`（**C-002 新增**） | `未提供画布 ID，无法确认是否为主画布，已拒绝整画布批量删除：请传 canvasId（或 canvasTotal）后重试。`（固定串，界面必须逐字展示，不得改写） | 主按钮 disabled；提示「界面已自动传 `canvasId`，若出现本提示说明调用链缺参数」 |
| `BAD_PARAMS` | 逐参数中文原因（如 `移动增量不能为 0（dx / dy 至少一个非 0）`） | 参数框标红/提示，主按钮 disabled |
| `NO_ACTOR` | `选中的项都不是演员卡，无法成组（仅演员卡可入组）` | 主按钮 disabled + 提示改用其它动作 |
| `NO_EXECUTABLE` | 勾选类型里无可执行节点 / `BATCH_MESSAGES.rerunNoExecutable` | 主按钮 disabled + 列可执行 8 类 |
| `SERVER_BLOCKED` | preflight 中文原因（磁盘满/队列暂停/预算超） | 主按钮 disabled + 指向「⏸ 队列横幅」或「设置」 |
| `NOTHING_TO_DO` | 全幽灵 / 锁定状态无需变更 | 主按钮 disabled |
| `NEED_CONFIRM` | 计划阶段被闸门拦下（直接调库/测试路径才会遇到） | 走确认流程重取 |
| `STALE_PLAN` | `计划与当前节点列表不匹配（计划基于 X 项，当前 Y 项）：请重新生成计划` | toast warn + 自动 `refresh()` |
| `PLAN_NOT_OK` / `NO_PLAN` | 兜底中文 | toast warn |
| `UNSUPPORTED_ACTION` | `不支持的批处理动作：x（可用：…）` | 下拉不出现该动作（界面已按 `SUPPORTED_ACTIONS` 生成） |

### 3.7 无障碍要点（批处理面板）

| 编号 | 要求 | 具体做法 |
|---|---|---|
| A-C-11 | 主按钮禁用原因可读 | `runBtn.disabled = !plan.ok` 时补 `aria-disabled="true"` + `aria-describedby` 指向 `guardBox`（原因文本节点需有 id） |
| A-C-12 | 预览与护栏为信息区 | `previewBox` 加 `role="status" aria-live="polite"`；`guardBox` 加 `role="alert"`（危险提示需立即播报） |
| A-C-13 | 危险确认弹窗语义 | `confirmDialog()` 增加 `role="alertdialog"` + `aria-modal="true"`；焦点默认落在「取消」按钮（防回车误确认） |
| A-C-14 | 参数控件标签 | dx/dy/scale/name 用既有 `labeled()` 包裹；number 输入补 `min/max/step`（现 scale 有 min/max，dx/dy 无） |
| A-C-15 | 范围与动作下拉 | 选项文案已含数量与「（付费）」「（危险：需确认）」；确保 `select` 有 `aria-label="取哪些节点"`/`"动作"` |
| A-C-16 | 结果播报 | toast 容器 `.toasts` 加 `role="status" aria-live="polite"`（`ui.js:26-33`） |
| A-C-17 | 键盘全链路 | 不依赖拖拽即可完成：入口按钮 → 面板 Tab 顺序 → 回车执行；确认可用 Esc 取消 |
| A-C-18 | 不可用控件仍可聚焦说明 | 危险动作下拉项不置灰（保持可读），改用文案标注付费/危险 |
| A-C-19 | 动效与对比 | 预览行 warn 色需满足 4.5:1（现用 `var(--warn)`，需实测）；加 `prefers-reduced-motion` 降级 |

### 3.8 W2 待补齐清单（批处理）

| 编号 | 开发项 | 位置 | 具体改法 | 验收点 |
|---|---|---|---|---|
| **D-C-07** | **主画布保护 fail-open 收口（RK-L6-01，中危）—— 由 P0 卡 `C-002` 拥有，界面侧只做消费** | 逻辑：`web/lib/canvas-select.js:243-265 / 486 / 502 / 690-806`（**属 C-002 write_scope，本线不改**）；界面：`web/views/actors.js:4862-4866` | ① **不重复实现**：C-002 已定契约 —— `canvasId` 三级自证（`opts.canvasId` → `params.canvasId` → 首个非空 `items[*].node.canvas_id`），新增计划字段 `canvasSource ∈ 'opts'\|'params'\|'items'\|'none'`，缺省且整画布删除语义 → 新码 `CANVAS_ID_REQUIRED`（判定顺序：`CANVAS_DELETE_FORBIDDEN` → `CANVAS_ID_REQUIRED` → `MAIN_CANVAS_GUARD` → `NEED_CONFIRM`）。② **界面侧义务**：保持 `canvasId: S.canvasId` 与 `canvasTotal: items.length` 显式传参不变（改这两行会让 `coversAll` 判定失效）；③ 在 §3.6 表中按新码给出中文处置（主按钮 disabled + 逐字展示 reason）；④ 断言本面板请求链路上**永远**有 `canvasSource === 'opts'` | UI-AC-10 |
| **D-C-08** | 按类型重跑补 `kinds` 参数控件 | `web/views/actors.js:4856-4859`、`4888-4891` | 当 `ui.action === 'rerun-kinds'` 时渲染可执行类型多选（取自 `EXECUTABLE_KINDS`，`canvas-select.js:58`），写 `params.kinds`；不勾 = `[]` = 全部可执行类型。同时在预览里写清「本次勾选：X/Y」 | UI-AC-11 |
| **D-C-09** | 锁定项参与重跑的显式提示 | `web/views/actors.js:4896-4905` | 把 `BATCH_MESSAGES.rerunLockedNotice(n)`（`canvas-select.js:168`）固定展示在护栏区（graph 不读 `locked`，见 T-103 H11/R10） | UI-AC-12 |
| **D-C-10** | `delete` 的 `mode`/`scope` 控件（默认保持 detach+selection） | `web/views/actors.js:4856-4859` | 若 W2 要开放，必须：① `purge` 选项文案显式标「永久删除演员档案（跨画布生效）」；② 双段确认由 `plan.confirmStages` 提供，不得自写；③ 未开放则**保持现状**并在面板写明「本面板只做移出画布」 | UI-AC-13 |
| **D-C-11** | 幽灵卡位与跳过项可见化 | `web/views/actors.js:4896-4905` | 渲染 `plan.skippedEntries`（最多前 5 条，含 `title`/`kindLabel`/`reason`），让「为什么这项没被处理」可解释 | UI-AC-14 |
| **D-C-12** | HUD 常驻「筛选中 n/m」（H9 要求） | `web/views/actors.js:623-645` | 与 D-C-03 合并；确认弹窗文案已含实际处理数（`plan.confirmStages` 已满足，需回归锁定） | UI-AC-07/15 |
| **D-C-13** | 批处理 a11y 属性 | `web/lib/ui.js:35-70`、`web/views/actors.js:4825-4908` | 按 A-C-11…A-C-19 只加属性 | UI-AC-20/21 |
| **D-C-14** | 面板内「一键去筛选」 | `web/views/actors.js:4904` | 空态提示里的「去筛选」做成可点链接（打开 `kindFilterDialog()`），减少「不知道去哪缩小范围」 | UI-AC-16 |

---

## 4. 制作台「排产」面板交互与状态表

### 4.1 面板结构（区域编号，W2 按编号定位）

| 区 | 位置 | 内容 | 现状行号 |
|---|---|---|---|
| **A** | 面板顶部 | 说明段：「定时排产：到点自动推进制片流水线…界面不绕过任何闸门。」 | `render.js:2435` |
| **B** | 面板中部 | `📋 现有排产` 列表（每行：名称 + 启用标签 + 类型标签 + 模式标签 + 停用/启用 + 试算 + 触发历史 + 摘要 + 下次/统计/上次 + 目标需求） | `render.js:2436-2479` |
| **C** | 列表尾部 | 调度器行（运行中/未运行 · tick 秒数 · 排产总开关） | `render.js:2480-2483` |
| **D** | 面板下部 | `＋ 新建排产` 表单（名称/类型/类型参数行/模式/模式参数行/时区 + 创建/试算/重置 + noteBox） | `render.js:2418-2432` |
| **E** | 面板底部 | `⟳ 刷新` / `关闭` | `render.js:2441` |
| **F（缺）** | 建议插在 A-B 之间 | 闸门横幅区：队列暂停 / 调度器未运行 / 总开关关闭 / 租约异常（见 D-S-02） | — |

### 4.2 字段映射表（接口字段 → 区域 → 空值兜底）

| 接口字段 | 区域/用途 | 空值兜底（必须） |
|---|---|---|
`ok` / `now` | 就绪判定、时间基准 | 缺 `ok` → 按未就绪处理 |
`enabled`（总开关） | C 行「排产总开关 已开启/已关闭」 | 缺省视为开启 |
`scheduler.running` | C 行「运行中/未运行」 | 缺省 `false` → 显示「未运行」+ 解释 |
`scheduler.tickSeconds` | C 行「每 N 秒一轮」 | 非法 → `-` |
`scheduler.leaseTtlSeconds` / `lease.{owner,expires_at,held}` | **F 区新增**：租约持有者与到期时刻（防「两个进程共库 → 双份排产」） | 无租约 → 「本进程未持有租约（可能由另一实例持有）」 |
`queue.paused` / `queue.reason` | **F 区新增**：硬闸门提示（`enabled` 是软开关，暂停才是硬闸门）+ 既有恢复入口 | `paused=true` 且 `reason` 空 → 「队列已暂停（原因未记录）」 |
`costNote` | **A 区固定展示**：月度上限不覆盖排产免费阶段的 LLM 花费 | 缺省隐藏（不编造） |
`meta.statusText` | 每行「上次：<中文>」 | 未知状态 → 原样显示英文码 |
`meta.reasonText` | 触发历史「原因」列 | 未知 → 原样显示 `reason_code` |
`meta.runStatuses` | 历史筛选下拉 | — |
`meta.missPolicies` | 表单「错过窗口策略」下拉 | — |
`meta.defaults.{defaultTz,graceMin,catchup,maxCatchup,skipIfRunning}` | 表单占位提示（如「默认 Asia/Shanghai」） | 缺省不显示提示 |
`schedules[].{id,name,enabled,kind,mode}` | B 行主字段 | `name` → `(未命名排产)`（`src/schedules.js:595`） |
`schedules[].summary` | B 行摘要 | `（无摘要）`（现状） |
`schedules[].next_run_text` / `in_minutes` | B 行「下次：…」 | `无未来窗口` |
`schedules[].running` | B 行「· 正在执行」 | 缺省 false |
`schedules[].status_text` + `last_status` | B 行「· 上次：<中文>」 | 从未跑过 → 不显示 |
`schedules[].fire_count/skip_count/miss_count` | B 行统计 | 缺失 → `0` |
`schedules[].last_error` | **B 行新增**：上次失败原因（红色小字） | 空 → 不显示 |
`schedules[].last_job_id/last_job_status/last_production_id` | **B 行新增**：可跳转的「上次任务/上次项目」 | 空 → 不显示 |
`schedules[].tz/miss_policy/catchup_max/grace_min/skip_if_running/budget_guard` | **B 行次要行**（本次 W2 可选） | 未展示 |
`schedules[].target.brief` / `target.productionId` | B 行「目标需求：…」/ 模式标签 | 二者皆空 → 显示「目标未设置」（服务端本会 400，属防御） |

### 4.3 状态表（排产面板）

| 状态 id | 触发条件 | 界面表现 | 控件可用性 | 文案（固定串） |
|---|---|---|---|---|
| `ST-S-01` 加载中 | 面板打开 / 点刷新 | 列表区显示加载行 | 创建/试算 **disabled** | `正在读取排产…` |
| `ST-S-02` 就绪·空列表 | `schedules.length === 0`（**当前实测就是这个状态**） | 空态卡片 | 全可用 | `还没有排产：在下面「＋ 新建排产」里填名称与触发规则即可（例如每天 09:00）。` |
| `ST-S-03` 就绪·有列表 | `length > 0` | 每行卡片 + C 行调度器 + 成本提示（D-S-03） | 全可用 | — |
| `ST-S-04` 接口未就绪 | `GET` 抛错/返回非列表 | `.rd-notice` + 禁用创建/试算 | 创建/试算 disabled | `⏰ 排产接口未就绪：<原因>` + 「…请在服务端重启一次服务（本页不代劳、也不绕过任何闸门），随后点「⟳ 刷新」即可用。」 |
| `ST-S-05` 单条停用 | `enabled === 0` | 行内标签 `已停用`；按钮变 `▶ 启用` | 可点 | toast：`<名称> 已停用<note>` |
| `ST-S-06` 单条运行中 | `s.running === true` | 行内 `· 正在执行`（建议加脉冲点/`aria-live`） | 停用按钮可点（服务端 `skip_if_running` 决定跳过） | — |
| `ST-S-07` 队列暂停（硬闸门） | `queue.paused === true` | **F 区横幅**（现状缺）+ 每行补「本刻不会触发：队列暂停中」 | 全部可用（创建允许，触发会被拦） | `skipped_paused` 中文「队列暂停中」（`meta.reasonText`）；横幅提供「恢复队列」入口（复用 `web/app.js:113-124` 的既有行为，不新造接口） |
| `ST-S-08` 调度器未运行 | `scheduler.running === false` | C 行「未运行」+ F 区解释「配置/环境变量关闭了定时器，界面不会代跑」 | 创建/试算/启停均可用 | 建议文案：`定时器未运行：排产不会自动触发（config schedules.enabled / FACTORY_SCHEDULER=off）。手动「▷ 立即跑一次」仍可用。`（D-S-02） |
| `ST-S-09` 排产总开关关闭 | `enabled === false` | C 行「排产总开关 已关闭」 | 同上 | 同上（属配置态，不是错误） |
| `ST-S-10` 租约被他人持有 | `lease.held === true && lease.owner !== 本进程` | F 区信息行 | 全可用 | `调度器租约由 <owner> 持有（到期 <expires_at>）：本实例不会重复触发` |
| `ST-S-11` 无未来窗口 | `next_run_text === null` | 行内「下次：无未来窗口」 | 全可用 | 试算失败时另给 `按当前规则算不出未来触发时刻：请检查时刻/cron 写法` |
| `ST-S-12` 上次失败 | `last_status === 'failed'` | 状态标签红色 + `last_error` 小字 | 全可用 | `meta.statusText.failed = 失败`；建议补「上次失败：<last_error>」 |
| `ST-S-13` 试算无结果 | `runs.length === 0` | noteBox 显示服务端 `note` | — | `按当前草稿算不出未来触发时刻（请检查 at_time / cron / once_at）`（服务端 `src/routes/schedules.js:145`） |
| `ST-S-14` 创建成功 | 200 | toast + 清空名称/需求字段 + 重载列表 | — | `排产「X」已创建，下次触发 <next_run_text>`（无 `next_run_text` 时省略该段） |
| `ST-S-15` 创建/启停/试算失败 | 400/404/403 | toast err（**逐字显示服务端中文原因**）；试算失败另落 noteBox | — | 服务端 12 条校验文案之一（T-101 §9.2） |
| `ST-S-16` 手动触发（**W2 新增**） | 点「▷ 立即跑一次」 | 二次确认 → 请求 → 结果回执 | 见 4.5 | 成功：`已触发：<productionId>（job <jobId>）`；去重：`该窗口已处理过（幂等去重），未重复触发`；被拦：`<reason 中文>` |
| `ST-S-17` 删除排产（**W2 新增**） | 点「🗑 删除」 | 危险确认（默认保留触发历史） | 见 4.5 | 默认：`已删除排产定义；触发历史保留（加 ?purge=1 可一并清理）`；purge 时：`已删除排产定义，并清理了触发历史` |

### 4.4 表单校验矩阵（kind → 字段 → 界面行为 → 服务端中文报错）

| kind | 需要填写的字段（`schedulePayload` 已按此裁剪） | 界面即时行为 | 服务端报错（逐字回显，界面不重写） |
|---|---|---|---|
| `once` | `once_at`（`YYYY-MM-DD HH:MM`） | 必填提示；格式提示 | `once_at 必须是 'YYYY-MM-DD HH:MM'（按 tz 解释）且晚于当前时刻` |
| `interval` | `interval_minutes`（1~10080） | 数字框，越界提示 | `interval 间隔必须是 1~10080 的整数分钟` |
| `daily` | `at_time`（`HH:MM`） | 必填 + 格式 | `at_time 必须是 'HH:MM'（24 小时制），例如 '09:30'` |
| `weekly` | `at_time` + `weekdays`（`0~6`，0=周日） | 必填 + 格式 | `weekdays 必须是 0~6（0=周日）的列表，例如 '1,3,5'` |
| `monthly` | `at_time` + `day_of_month`（1~31） | 必填 + 范围 | `day_of_month 必须是 1~31（该月没有这一天时跳过该月）` |
| `cron` | `cron`（`分 时 日 月 周`；支持 `*` `/` `N` `A-B` `A,B` `*/N`；不支持秒级/`MON`/`@daily`） | 必填 + 语法示例 | `cron 表达式非法：…（支持 * / N / A-B / A,B / */N；不支持秒级与 MON/@daily）` |
| 通用 | `name` 非空且 ≤60 字；`tz` IANA 名 | 名称空 → 本地 toast `请先填排产名称（≤60 字）`（现状）；时区留空=服务端默认 | 名称：`排产名称必填（≤60 字）`；时区：`无效时区：Bad/Zone（请用 IANA 名称，如 Asia/Shanghai / UTC）` |
| 通用 | `kind` 合法性 | 下拉只有 6 项 | `kind 非法：xx（可选 once/interval/daily/weekly/monthly/cron）` |
| `new_production` | `target.brief` 或 `target.spec` 至少一个 | 需求输入框 | `请给 target.brief（一句话需求）或 target.spec（制片参数）` |
| `existing_production` | `target.productionId` 必填且项目存在 | 项目 ID 输入框 | `mode=existing_production 时必须给 target.productionId，且该制片项目必须存在` |
| 创建可算出窗口 | — | — | `按当前表达式算不出未来的触发时刻（请检查 cron / once_at）`（不落库半成品） |

### 4.5 危险确认与禁用矩阵（排产）

| 操作 | 接口 | 危险度 | 确认要求 | 禁用条件 | 备注 |
|---|---|---|---|---|---|
| 创建排产 | `POST /api/schedules` | 中（会**持续产生费用**） | **建议 1 次确认**（尤其 `mode=new_production` + `interval`）：`确认创建排产「X」？到点会自动推进制片流水线（真实计费）。` | 接口未就绪；名称为空 | 现状无确认（D-S-05） |
| 启用/停用 | `PATCH /api/schedules/:id {enabled}` | 低 | 启用 → 建议 1 次轻确认（同上一行文案） | 接口未就绪 | 现状为直接切换（D-S-05） |
| 立即跑一次（W2 新增） | `POST /api/schedules/:id/trigger {dryRun:false}` | **高**（付费 + 建项目/推进项目） | **1 次确认**，文案含目标与「真实计费」；`force:true` 必须**双段确认**且明确写「绕过暂停/预算闸门」 | 接口未就绪；`s.running`（服务端 `skip_if_running` 会跳过，界面应提示而非禁用） | 现状无入口（D-S-01）。**禁止**在界面暴露 `occurrence_at`（服务端 S-04 忽略并回显 `ignoredOccurrence`，界面如收到该回显必须显示说明） |
| 试算 | `POST /api/schedules/preview` | 无（dry-run） | 无需 | 接口未就绪 | 现状可用 |
| 删除排产（W2 新增） | `DELETE /api/schedules/:id[?purge=1]` | 高（`purge=1` 连触发历史一起删） | 默认删：**1 次确认**；`purge=1`：**双段确认** | 接口未就绪 | 默认保留历史（审计证据，T-101 §9.5） |
| 手动 tick（可选，不建议做界面按钮） | `POST /api/schedules/tick` | 低-中 | 若做，需说明「会立即消费所有到期窗口」 | `allowManualTick=false` → 403 | 界面默认不暴露（T-101 §9.7） |

### 4.6 无障碍要点（排产面板）

| 编号 | 要求 | 具体做法 |
|---|---|---|
| A-S-01 | 面板对话框语义 | `ctxRef.modal` 底层同样是 `ui.js:53-70`：加 `role="dialog"`/`aria-modal`/`aria-labelledby`（与 A-C-01 同源一次改） |
| A-S-02 | 表单标签关联 | 每个 `mk(label, input)` 目前是 `<label class="rd-row"><span>…</span><input></label>`（**隐式关联**，可用）；补 `for/id` 更稳（尤其同一输入框在多个 kind 行间搬移，见 `render.js:2386-2396` 注释） |
| A-S-03 | 动态行切换播报 | `drawKind()`/`drawMode()` 切换后，用 `aria-live="polite"` 播报「已切换为「每周」，需要填写：每周时刻、星期几」 |
| A-S-04 | 状态与错误播报 | `.rd-notice`（未就绪）加 `role="alert"`；`noteBox`（试算/创建结果）加 `role="status" aria-live="polite"` |
| A-S-05 | 启停按钮可读 | 按钮文案已含动作（`⏸ 停用`/`▶ 启用`）；补 `aria-pressed` 表达当前 `enabled` 状态 |
| A-S-06 | 列表语义 | 每行卡片用 `role="list"`/`role="listitem"` 或 `<h3>` 层级；避免纯 div 堆叠导致屏读失去结构（**只加 role，不改结构**） |
| A-S-07 | 颜色非唯一信息载体 | 「已启用/已停用」「失败」必须同时有文字（现状已有文字标签，需回归锁定） |
| A-S-08 | 复用全局暂停横幅 | 恢复队列回执用 `alert()`（`web/app.js:121-122`）→ W2 应替换为 `toast()`（改善屏读与误触） |
| A-S-09 | 键盘全链路 | 面板内表单可纯键盘完成：Tab 顺序 = 名称→类型→类型参数→模式→模式参数→时区→创建→试算→重置 |
| A-S-10 | 触达与字号 | `.rd-btn.rd-sm` 用于行内操作，确保 ≥28px 高、目标间距 ≥8px |

### 4.7 W2 待补齐清单（排产）

| 编号 | 开发项 | 位置 | 具体改法（接口/字段/步骤） | 验收点 |
|---|---|---|---|---|
| **D-S-01** | 「▷ 立即跑一次」入口 | `web/views/render.js:2466-2468` 行内按钮组 | ① `confirmDialog` 确认（含目标、真实计费）；② `POST /api/schedules/:id/trigger {dryRun:false}`；③ 回执分支：`deduped` → 「该窗口已处理过（幂等去重）」，`skipped` → 显示 `reason` 中文，成功 → 显示 `productionId` + `jobId`；④ `ignoredOccurrence` 非空 → 追加提示「请求体 occurrence_at 已被服务端忽略（窗口键由服务端生成）」；⑤ 400/403 直接 toast 服务端中文原因 | UI-AC-25 |
| **D-S-02** | F 区「闸门横幅」 | 新增在 `render.js:2434-2439` 的 body 顶部 | 依据 4.3 的 `ST-S-07/08/09/10` 组合渲染：队列暂停（含恢复按钮，复用 `POST /api/queue/resume`）、调度器未运行、总开关关闭、租约持有者/到期 | UI-AC-26 |
| **D-S-03** | 成本提示常驻 | A 区 | 显示 `r.costNote`（逐字）；不要自写文案（服务端是唯一真值，`src/routes/schedules.js:36`） | UI-AC-27 |
| **D-S-04** | 行内补 `last_error`/上次任务/上次项目 | `render.js:2471-2477` | `last_status === 'failed'` 时红字显示 `last_error`；`last_job_id`/`last_production_id` 做成可点文本（指向 `#/studio` 相应入口，若无深链则只读展示） | UI-AC-28 |
| **D-S-05** | 创建/启用的费用确认 | `render.js:2523-2532`、`2501-2508` | 包一层 `ctxRef.confirm`（文案见 4.5 表）；确认文案必须含「到点会自动推进制片流水线（真实计费）」 | UI-AC-29 |
| **D-S-06** | 删除排产入口 | 行内按钮组 | 默认删（保留历史）：1 次确认；做 `purge` 选项须双段确认并显示服务端 `note` | UI-AC-30 |
| **D-S-07** | 30s 轮询状态刷新 | 面板打开期间 | `setInterval(load, 30000)`，**关闭面板时必须清理**（防泄漏）；不新增 SSE（T-101 §9.8 明令） | UI-AC-31 |
| **D-S-08** | 触发历史内联化 | `render.js:2468` 的 `a[target=_blank]` | 改为面板内展开：`GET /api/schedules/runs?scheduleId=` 渲染列「时间 / 状态（`status_text`）/ 原因（`reason_text`）/ 任务 / 项目 / 预估」；保留原链接作为「在新标签打开」次入口 | UI-AC-32 |
| **D-S-09** | 试算结果表格化 | `render.js:2510-2521` | 把 `r.runs[]`（`at/text/inMinutes/weekdayText`）渲染为小表或编号列表 + 「距现在 X 分钟」；无结果时显示服务端 `note` | UI-AC-33 |
| **D-S-10** | 表单字段补齐（可选，按需） | `render.js:2374-2414` | 若 W2 要暴露：`miss_policy`（`meta.missPolicies`）、`grace_min`、`catchup_max`、`skip_if_running`、`budget_guard`、`retry_failed_max`（`PATCHABLE` 全集见 `src/schedules.js:657-661`），并保证「改时间字段会重算 `next_run_at`」的 `note` 回显 | UI-AC-34 |
| **D-S-11** | 排产面板 a11y | `web/views/render.js:2355-2535`、`web/lib/ui.js:53-70` | 按 A-S-01…A-S-10 | UI-AC-20/35 |
| **D-S-12** | 全局恢复队列改 toast | `web/app.js:121-122` | `alert()` → `toast()`（`web/lib/ui.js:26`） | UI-AC-36 |

---

## 5. 验收点清单（可直接执行的验收剧本）

> 说明：`V1` = 静态核对（grep/node），`V2` = 纯函数单测（离线 Node，零依赖），`V3` = 接口核对（只读 curl），`V4` = DOM/无障碍核对（浏览器或 Playwright 手测脚本），`V5` = 回归（既有阶段）。
> **允许跑的**：V1/V2/V3 只读命令；V4 手测/只读交互。**禁止**：重启 8788、跑 `scripts/verify-all.sh`（会重写 `config/config.json`，见 L6 RK-L6-06）。

### 5.1 画布线

| 编号 | 验收点 | 前置 | 步骤 | 期望可观测结果 | 方式 |
|---|---|---|---|---|---|
| **UI-AC-01** | 筛选面板五维齐备（含分组） | 画布有 ≥2 种类型的节点 | 打开 `#ac-kind-filter` | 类型 chips + 分组 chips + 有产物/失败/锁定三态 + 反选 均在；缺任一维判 FAIL | V4 |
| **UI-AC-02** | 组合语义：维度间 AND、维度内 OR | 打开面板 | 选 2 个类型 → 再选「有产物=是」 | 预览计数 = 同时满足的条数，且等于 `filterItems` 在控制台回算的值 | V2/V4 |
| **UI-AC-03** | 默认态零差异 | 清空筛选 | 打印 `describeNodeFilter(DEFAULT_NODE_FILTER,n,n)` | 输出 `筛选：不限（n/n）`，且 `S.selection` 不变 | V2 |
| **UI-AC-04** | `''` = 未分组 | 画布存在未分组卡片 | 选分组维度里的「未分组」 | 未分组卡片命中（不是「不限」） | V2 |
| **UI-AC-05** | D-C-01 分组控件 | — | 切分组 chips | `draft.groups` 变化并影响预览计数 | V2/V4 |
| **UI-AC-06** | D-C-02 文案同源 | — | 制造 0 命中后点应用 | toast 文案 === `BATCH_MESSAGES.noMatchingNodes`（逐字比对，禁止另写字面量） | V1/V4 |
| **UI-AC-07** | D-C-03/D-C-12 HUD 常驻筛选 chip | 筛选非默认 | 看 HUD | 出现「筛选中 m/n」与摘要 chip；清空后消失 | V4 |
| **UI-AC-08** | D-C-04 状态声明 | — | 打开面板前读 `S.kindFilter` | 是对象（`DEFAULT_NODE_FILTER` 形状），不是 `undefined` | V1/V4 |
| **UI-AC-09** | D-C-06 应用回执数量一致 | 筛选命中含非演员项 | 点应用 | toast 数字 === `S.selection.size` | V4 |
| **UI-AC-10** | **主画布 fail-open 已收口（对齐 C-002）** | 离线 Node（临时库） | ① `planBatch('delete', items, {mode:'detach',scope:'all'})` **不传** `canvasId` 且 `items[*].node.canvas_id` 为空 → ② 同上但 items 带 `node.canvas_id='CV-MAIN'` → ③ 不传 `canvasId` 且只覆盖部分选区 | ① `ok:false` 且 `code === 'CANVAS_ID_REQUIRED'`、`reason` 含「未提供画布 ID」与「已拒绝」；② `code === 'MAIN_CANVAS_GUARD'`（自证生效，不是新码）；③ 与改造前逐字节相同（`NEED_CONFIRM`，确认段数与文案一致）；另：`canvasSource` 四态可断言、`applyBatchPlan` 对 `CANVAS_ID_REQUIRED` 返回 `ok:false` 且 `effects=[]` | V2 |
| **UI-AC-11** | D-C-08 重跑按勾选类型过滤 | — | 勾 1 个可执行类型 | 计划 `skippedEntries` 含其它可执行类型且原因为「未勾选该类型」 | V2 |
| **UI-AC-12** | D-C-09 锁定不阻止执行提示 | 选区含锁定可执行节点 | 选 rerun | 护栏区含 `rerunLockedNotice(n)` 文案 | V1/V4 |
| **UI-AC-13** | D-C-10 delete 模式语义 | — | 若开放 purge | 双段确认文案 === `plan.confirmStages` 两段；未开放则面板写明「只做移出画布」 | V2/V4 |
| **UI-AC-14** | D-C-11 跳过项可见 | 选区含非演员卡 | 选 group | 面板列出被跳过项与原因 | V4 |
| **UI-AC-15** | 危险确认写明实际处理数 | 筛选命中 N、选区 M | 触发 delete | 确认文案里的数字 === `plan.affected`（不是 `filtered.length`） | V2/V4 |
| **UI-AC-16** | D-C-14 空态可操作 | 空选区 | 看空态 | 提示含「先去筛选」且可点击打开筛选面板 | V4 |
| **UI-AC-17** | 取消零副作用 | 选区非空 | 触发 delete → 取消 | 无任何网络请求（Network 面板）/ 无快照产生 / 画布不变 | V4 |
| **UI-AC-18** | 付费路径不越闸门 | — | 选 rerun | 请求序列只有 `POST /api/canvas/plan`（+ 之后由「🧭 执行计划」走 plans/approve/run）；**绝不能**出现 `/api/canvas/run`、`/api/canvas/run-node` | V1/V4 |
| **UI-AC-19** | 计划同源复核 | 面板打开后改动画布 | 执行 | 出现 `STALE_PLAN` 提示而非落地 | V2 |
| **UI-AC-20** | 对话框语义 | — | 打开筛选/批处理/排产面板 | 三个面板根节点有 `role="dialog"` + `aria-modal="true"` + 可读标题 | V1/V4 |
| **UI-AC-21** | 焦点管理 | — | 打开→Esc 关闭 | 焦点进入面板；Esc 关闭后焦点回到触发按钮 | V4 |

### 5.2 排产线

| 编号 | 验收点 | 前置 | 步骤 | 期望可观测结果 | 方式 |
|---|---|---|---|---|---|
| **UI-AC-22** | 接口未就绪态 | 服务未注册排产路由（或改错端口模拟） | 打开 `⏰ 排产` | 出现 `.rd-notice` 中文说明，且「创建/试算」`disabled=true`（**不得**假装空列表） | V4 |
| **UI-AC-23** | 空列表态 | `schedules: []`（**当前实测即此**） | 打开面板 | 逐字显示「还没有排产：在下面「＋ 新建排产」里填名称与触发规则即可（例如每天 09:00）。」 | V3/V4 |
| **UI-AC-24** | 字段零硬编码 | — | `grep -c "0 9 \* \* \*" web/views/render.js` | 表单默认值只在 `scheduleDraft()` 出现，不在渲染逻辑里散落 | V1 |
| **UI-AC-25** | D-S-01 立即跑一次 | 存在 1 条排产（可在临时库造） | 点「▷ 立即跑一次」→ 确认 | 请求 `POST /api/schedules/:id/trigger`；回执按 `deduped`/`skipped`/成功 三态分别给出中文；被拦时显示 `reason` 中文 | V4 |
| **UI-AC-26** | D-S-02 闸门横幅 | 暂停队列或关闭调度器 | 打开面板 | 依次命中 `ST-S-07/08/09/10` 对应文案；暂停时提供恢复入口 | V4 |
| **UI-AC-27** | D-S-03 成本提示 | — | 打开面板 | 文案与 `GET /api/schedules` 的 `costNote` **逐字一致** | V3/V4 |
| **UI-AC-28** | D-S-04 失败可解释 | `last_status='failed'` | 看行内 | 红色状态 + `last_error` 原文 | V4 |
| **UI-AC-29** | D-S-05 创建费用确认 | — | 填表 → 创建 | 先出现确认文案（含「真实计费」），取消则不产生请求 | V4 |
| **UI-AC-30** | D-S-06 删除确认 | 存在 1 条排产 | 删除 | 默认 1 段确认；`purge` 2 段；结束后 toast 服务端 `note` | V4 |
| **UI-AC-31** | D-S-07 轮询与清理 | — | 打开面板 60s 后关闭 | 面板打开期间每 30s 一次 `GET /api/schedules`；关闭后**不再**有请求 | V4 |
| **UI-AC-32** | D-S-08 历史内联 | 有 runs | 展开历史 | 显示列「时间/状态/原因/任务/项目/预估」；状态与原因用 `status_text`/`reason_text` 中文 | V4 |
| **UI-AC-33** | D-S-09 试算可读 | — | 点「🔎 试算」 | 未来 3 次触发按编号或表格呈现；无结果时显示服务端 `note` | V4 |
| **UI-AC-34** | D-S-10 时间字段语义 | — | 改 `at_time` 后保存 | 响应 `note`（「已按新表达式重算下次触发」）必须回显给用户 | V3/V4 |
| **UI-AC-35** | 表单校验文案逐字回显 | — | 提交 `at_time=25:00` | toast 显示服务端原文 `at_time 必须是 'HH:MM'（24 小时制），例如 '09:30'`（界面不得改写/翻译） | V3/V4 |
| **UI-AC-36** | D-S-12 恢复队列回执 | 队列暂停 | 点横幅恢复 | 用 toast（非 `alert()`）给出中文回执 | V1/V4 |

### 5.3 回归与总体验收

| 编号 | 验收点 | 命令/步骤 | 期望 |
|---|---|---|---|
| **UI-AC-37** | 纯逻辑零回归 | `node tests/canvas-select.test.mjs` | `222 通过 / 0 失败`，exit 0 |
| **UI-AC-38** | 排产逻辑零回归 | `node tests/test-schedules.js` | `116 通过 / 0 失败`，exit 0 |
| **UI-AC-39** | 既有 UI 交互零回归 | `python3 tests/ui-simulate.py http://127.0.0.1:8788`（**单独运行**，勿与 canvas-audit 并发） | 结束时「发现的产品问题」清单不含本次改动引入项；演员数/主画布节点数/分组/连线数与开始时一致 |
| **UI-AC-40** | 画布一致性零回归 | `python3 tests/canvas-audit.py http://127.0.0.1:8788` | 通过；且结束态与起始态一致 |
| **UI-AC-41** | 改动面白名单核对 | `git status --short` / `md5sum` 6 个基线文件 | 只有白名单文件变化；每个改动文件都有同日 `.bak` |
| **UI-AC-42** | 无新依赖 | `grep -rn "^import .* from '[^.]" web/lib/canvas-select.js web/views/actors.js web/views/render.js` | 无非相对路径导入（零依赖铁律） |
| **UI-AC-43** | 服务未被重启 | `ps -o pid,lstart,cmd -p $(pgrep -f "node server.js" \| head -1)` | 起始时间早于本次工作开始时间 |
| **UI-AC-44** | 全量阶段数守恒（**只在收口时跑，跑前留 md5 基线**） | `md5sum config/config.json` → `bash scripts/verify-all.sh` → 比对 | `30/30 阶段通过`、末行 `✅ 全部自检通过`；`config/config.json` 语义不变（L6 RK-L6-06 提醒） |

---

## 6. 本卡执行过的核对命令（证据）

| 目的 | 命令 | 结果摘要 |
|---|---|---|
| 基线指纹 | `md5sum web/views/actors.js web/views/render.js web/lib/canvas-select.js src/routes/schedules.js web/lib/ui.js web/app.js` | 见 §0.1 表（`actors.js` = `69f1774847c67608d03b3a8c17f88809`，与 L6-verify:426 实测值一致） |
| 行数 | `wc -l web/views/actors.js web/views/render.js web/lib/canvas-select.js src/routes/schedules.js web/lib/ui.js` | 4958 / 2776 / 1175 / 314 / 172 |
| a11y 现状 | `grep -c "aria-" web/views/actors.js web/views/render.js web/lib/ui.js web/app.js` | 全为 **0** → 无障碍属新增面，需在 `ui.js` 底层补齐 |
| 排产接口实测 | `curl -s 'http://127.0.0.1:8788/api/schedules?reconcile=0'` | `ok:true`；`scheduler.running:true`、`tickSeconds:60`、`leaseTtlSeconds:180`、`lease.held:true`；`queue.paused:false`；`schedules:[]`；`meta.statusText/reasonText/defaults` 实测值见 §1.2#3（`reconcile=0` 保证完全只读，不写库） |
| 计划错误码全集 | `grep -n "fail(plan, '\|return fail(" web/lib/canvas-select.js` | 17 个 code + `OK`，见 §1.1#12 |
| 计划返回面 | `sed -n '990,1175p' web/lib/canvas-select.js` | `planBatch`/`applyBatchPlan`/`describeBatchPlan` 字段清单，见 §3.1 |
| 元数据表 | `sed -n '86,175p' web/lib/canvas-select.js` | `SUPPORTED_ACTIONS`（7）、`BATCH_ACTIONS`（danger/paid/confirm/approval/snapshot/emptyReason）、`BATCH_MESSAGES`、`RERUN_APPROVAL_CHAIN` |
| 自助检查 | `node -e "require('node:fs').accessSync('strategist/reports/D-01-ui-plan.md')"` | exit 0 |

---

## 7. 风险与依赖（只记录，本卡不修）

| 编号 | 等级 | 内容 | 证据 | 影响 | 建议 |
|---|---|---|---|---|---|
| **R-01** | 中 | 主画布保护接口层 fail-open（RK-L6-01 未修） | `canvas-select.js:502`（缺省 `canvasId=''` → `mainCanvas=false`）；L6-verify §3 RT-03 实测不传时整画布删除放行 | 新调用点忘传参数即可整画布删卡位 | **已由第 2 轮 P0 卡 `strategist/tasks/C-002-canvas-id-fail-closed.yaml` 接手**（新码 `CANVAS_ID_REQUIRED` + `canvasSource` 四态）；本规划按 **D-C-07** 只做「界面侧消费新码 + 不破坏 `canvasId`/`canvasTotal` 传参」，验收按 UI-AC-10 |
| **R-02** | 中 | 本规划涉及的排产 UI 增量（立即跑一次/删除/费用确认）**会引入真实计费入口** | `POST /api/schedules/:id/trigger` 默认 `dryRun:false`，会建/推进制片项目 | 误点即花钱 | D-S-01/D-S-05 的确认文案必须含「真实计费」；建议先在临时库验证 |
| **R-03** | 中 | `purge` 删除演员档案**跨画布生效**且快照只保护当前画布 | `canvas-select.js:755/769`；`deleteActor` 连带清理所有画布连线与卡位 | 快照回不去 | 面板必须显示 `purgeCrossCanvasWarning`；默认不开放该模式 |
| **R-04** | 中 | 付费重跑闸门依赖 `plan.confirmStages` 与人工审批链；HTTP 层另有 `server.js:52/56` 的无闸门入口 | T-103 R1（`/api/canvas/run`、`/api/canvas/run-node` 直挂 `createGraphRunJob`/`runSingleNode`） | 界面不越闸门 ≠ 系统不可绕过 | 界面线只保证不出现在请求里；后端收口另开卡 |
| **R-05** | 低 | 「按类型重跑」当前**不传 `kinds`**，实际语义是「全部可执行节点重跑」 | `actors.js:4856-4859`（rerun 分支 params=`{}`） | 与动作名不符，误伤范围 | D-C-08 补 `kinds` 控件 |
| **R-06** | 低 | 界面 toast 文案与契约固定串存在分歧（无匹配提示、清除筛选） | `actors.js:4786/4792` vs `canvas-select.js:170-172` | 测试按契约串断言会 FAIL | D-C-02 统一为 `BATCH_MESSAGES` |
| **R-07** | 低 | 状态表里「排产总开关关闭 / 调度器未运行」两种配置态目前只用一行小字表达 | `render.js:2481-2483` | 用户可能误以为「排产坏了」 | D-S-02 提到 F 区并给下一步指引 |
| **R-08** | 低 | 排产列表字段 `last_error`/`last_job_*` 已由接口返回但界面未展示 | `src/schedules.js:592-612`（`...row` 展开）、`render.js:2471-2477` | 失败不可解释 | D-S-04 |
| **R-09** | 低 | 无障碍改造触及全局 `ui.js`（`modal`/`confirmDialog`/`toast`），影响所有视图 | `ui.js:26-70`；全仓 `aria-` = 0 | 结构性改动可能打坏 Playwright 选择器 | **只加属性/不改节点结构**；改动后必须跑 UI-AC-39/40 |
| **R-10** | 低 | 排产面板若做 30s 轮询，关闭面板未清理计时器会造成持续请求 | D-S-07 | 资源泄漏 + 干扰「无请求」验收 | 实现时在 `modalRef.close()`/`onClose` 清理 |
| **R-11** | 低 | V4 类验收依赖真实 8788 与 Playwright 环境（`PW_LIBS`/`CHROME` 默认路径写死在脚本内） | `tests/ui-simulate.py:42-44` | 环境缺失则 V4 无法执行 | 缺失时降级为手动核对清单并如实标注 |
| **R-12** | 流程 | 本卡写入了白名单外的 `strategist/runs/D-01.json` | 任务书要求「结论写入 runs/<task_id>.json」，与写入范围一句并列 | 口径冲突 | 按 T-103 R13 同例处理：`runs/D-01.json` 为**汇报通道**，不视为源码产出 |

---

## 8. 交付物与变更控制

| 项 | 内容 |
|---|---|
| 本卡产出 | `strategist/reports/D-01-ui-plan.md`（本文件）、`strategist/runs/D-01.json` |
| 未触碰 | 任何 `.js`/`.py`/`.sh`/`config.json`/既有测试/`README.md`；未重启 8788；未跑 `verify-all.sh`；未装依赖 |
| W2 动手前必做 | 对每个待改文件 `cp <file> <file>.bak`（项目既有惯例：`server.js.bak`、`web/views/actors.js.bak`、`web/views/render.js.bak`、`src/studio.js.bak`、`scripts/verify-all.sh.bak`） |
| W2 完成判据 | §5 的 UI-AC-01…UI-AC-44 全部通过（V4 类如环境缺失须逐条如实标注「未执行」而非留空） |
| 实现顺序建议 | ① D-C-07（安全收口，先做，有独立单测）→ ② D-C-02/D-C-06（文案同源与计数一致性）→ ③ D-C-03/D-C-12（HUD 可解释性）→ ④ D-C-01/D-C-08/D-C-11（维度与参数完整）→ ⑤ D-S-02/D-S-03/D-S-04（排产可解释性）→ ⑥ D-S-01/D-S-05/D-S-06（付费入口 + 确认）→ ⑦ a11y（D-C-05/D-C-13/D-S-11/D-S-12）→ ⑧ D-S-07/D-S-08/D-S-09/D-S-10（体验补齐） |
