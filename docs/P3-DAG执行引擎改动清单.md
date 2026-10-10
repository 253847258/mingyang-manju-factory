# P3 改动清单：DAG 执行引擎（`src/graph.js`）

> ✅ **本清单已于 2026-09-27 实施**（`src/graph.js` 落地，执行层合并进同一文件；`canvas_node_runs` 已并入 `src/db.js` SCHEMA；`server.js` 已挂 5 个路由；`tests/test-graph.js` 182 项断言）。实施记录见文末。

> 用途：`docs/画布节点图改造方案.md` 的 **P3 阶段**可施工清单。
> **本清单未应用任何改动**（源码零改动）。
> **设计取向：零冲突** —— 全部新增文件，只在 `server.js` 加两行；**不修改** `web/views/actors.js`（并行会话主战场）。
> 复核时间 2026-09-26 16:28。

---

## 一、为什么 P3 可以现在就做（不用等 P2）

实测发现并行会话已把边泛化为**节点级**（`canvas_links` 新增 `from_node` / `to_node` / `from_side` / `to_side`），
且 `canvas_nodes` 已有 **`data TEXT`** 列。这意味着 DAG 所需的两个前提**已经就绪**：

| DAG 前提 | 现状 | 结论 |
|---------|------|------|
| 边的两端是节点 | `canvas_links.from_node` / `to_node` | ✅ 可直接做拓扑排序 |
| 节点可挂参数与状态 | `canvas_nodes.data TEXT`（JSON） | ✅ 无需迁移 |
| 边的方向语义 | 由 `from_node → to_node` 隐含 | ✅ 可直接用 |
| **端口类型 / 槽位顺序** | 尚无（P2 才补） | ⚠️ P3 先按"**每侧单输入**"语义落地，P2 落地后自动升级为多输入槽位 |

**这就是 P3 相对 P2 的最大优势**：它不依赖任何尚未存在的列，也不碰前端热文件。

---

## 二、可复用的既有构件（实测确认存在）

| 构件 | 位置 | 用法 |
|------|------|------|
| `enqueue({type,title,total,limit,payload,handler})` | `src/jobs.js` | 一次图执行 = 一个 job |
| `ctx.setProgress(pct, {done,total})` / `ctx.isCanceled()` / `ctx.log(msg)` | `src/jobs.js` `pump()` | 节点级进度与取消 |
| `recoverStaleJobs()` | `src/jobs.js` | 启动自愈，中断任务标记可重提 |
| `generateImage(req)` | `src/image.js` | 返回 `{filePath, mime, backend, model, elapsedMs, width, height, placeholder}` |
| `generateVideo(req)` | `src/video.js` | 返回 `{filePath, mime, width, height, duration, backend, model, elapsedMs, raw}` |
| `assembleVideos({scriptId, code, files, duration, transition})` | `src/video.js` | 多片拼接（时间线/输出节点用） |
| `resolveAsset(rel)` | `src/db.js` | 相对路径 → 绝对路径（供 keyframe 传参） |
| `get/all/run`、`rid`、`nowISO` | `src/db.js` / `src/util.js` | 数据访问 |
| `registerXxxRoutes(app)` + `server.js` 一行注册 | `server.js` | 新路由挂载方式 |
| 临时库测试范式 | `tests/selfcheck.js` | `process.env.FACTORY_DB = tmp` 后 `await import(...)` |

---

## 三、诚实的能力边界（必须先明确，避免做成"看起来能跑"）

| 能力 | 现状 | 处理 |
|------|------|------|
| 文生图 / 参考生图 | ✅ `generateImage` 支持 | 直接落地 |
| 图生视频（**首帧**驱动） | ✅ `generateVideo({keyframe})` 支持 | 直接落地 |
| 文生视频 | ✅ `generateVideo` 无 keyframe 时走 t2v | 直接落地 |
| **首尾帧过渡（frames2video）** | ❌ **`src/video.js` / `src/comfy.js` 全文检索无 `last` / 尾帧 支持**；内置工作流仅 `h3-image-to-video` / `h3-text-to-video` | **`last` 端口只做数据模型预留，执行层明确抛"当前后端不支持尾帧"**，不让用户误以为可用 |
| 演员节点作为生成主体 | 演员节点应作为**素材源**（其 `cover_image` / `ref_image` 即 `image` 输出） | 不在图里重复实现"生成定妆图"，仍走现有右键生成流程（已有独立 job 类型） |
| 多模态混合参考（图+视频+音频） | ❌ 无 | 归入后续（需 provider 层扩展） |

> **首尾帧的补法**（后续工作，非本阶段）：给 `comfy.js` 增加第三个内置工作流
> `config/workflows/h3-frames-to-video.workflow.json`，并在 `BUILTIN_WORKFLOWS`（`src/comfy.js:18`）加 `f2v` 键；
> `generic-http` 后端则加 `${lastImage}` 模板变量。**这属于 P5 范畴，不要塞进 P3。**

---

## 四、步骤 1 · `src/db.js`：节点执行记录表

**定位锚点**：`CREATE TABLE IF NOT EXISTS canvas_links (` 这一段之后（与 `canvas_groups` 相邻）。

```sql
-- 画布节点执行记录（每次节点运行一行，保留历史；对齐 shot_renders 的设计）
CREATE TABLE IF NOT EXISTS canvas_node_runs (
  id TEXT PRIMARY KEY,
  canvas_id TEXT,
  node_id TEXT NOT NULL,
  job_id TEXT,
  kind TEXT,                       -- image | video | assemble
  status TEXT DEFAULT 'done',      -- done | error | skipped
  file_path TEXT, mime TEXT, width INTEGER, height INTEGER, duration REAL,
  prompt TEXT, negative TEXT, seed INTEGER, backend TEXT, model TEXT,
  input_fp TEXT,                   -- ★ 输入指纹：增量跳过用
  error TEXT, meta TEXT,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_node_runs_node ON canvas_node_runs(node_id, created_at);
CREATE INDEX IF NOT EXISTS idx_node_runs_job ON canvas_node_runs(job_id);
```

**同时**：`SCHEMA_VERSION` 顺延（锚点 `export const SCHEMA_VERSION = 8;` → `9`；若 P2 先落地则顺延到 `10`）。
**兼容性**：纯新增空表，零风险。⚠️ 若与并行会话/P2 撞版本号，以最新为准单调递增即可。

---

## 五、步骤 2 · 新建 `src/graph.js`（核心）

### 5.1 拓扑排序与环检测

```js
/** Kahn 拓扑排序；存在环时返回环上节点，供中文报错定位 */
export function topoSort(nodeIds = [], links = []) {
  const ids = new Set(nodeIds);
  const indeg = new Map([...ids].map((id) => [id, 0]));
  const adj = new Map([...ids].map((id) => [id, []]));
  for (const l of links) {
    // 只认数据流边：两端都在图内、且不同节点
    if (!ids.has(l.from_node) || !ids.has(l.to_node) || l.from_node === l.to_node) continue;
    adj.get(l.from_node).push(l.to_node);
    indeg.set(l.to_node, (indeg.get(l.to_node) || 0) + 1);
  }
  const q = [...ids].filter((id) => (indeg.get(id) || 0) === 0);
  const order = [];
  while (q.length) {
    const id = q.shift();
    order.push(id);
    for (const nx of adj.get(id)) {
      indeg.set(nx, indeg.get(nx) - 1);
      if (indeg.get(nx) === 0) q.push(nx);
    }
  }
  if (order.length !== ids.size) {
    const cycles = [...ids].filter((id) => !order.includes(id));
    return { order, cycles };
  }
  return { order, cycles: [] };
}
```

### 5.2 上游产物装配（**唯一需要为 P2 预留的接缝**）

```js
const INPUT_PORT_ORDER = ['in', 'first', 'last', 'clip', 'ref1', 'ref2', 'ref3'];

/**
 * 收集某节点的上游输入。
 * P3 语义：每侧按 INPUT_PORT_ORDER 取第一个有产物的入边；
 * 若边带 to_port（P2 落地后），则严格按端口名归位；到 P2 落地前 to_port 为 null，
 * 此时按"入边顺序 + 边侧"退化处理，行为可预期。
 */
export function assembleInputs(nodeId, links, valueOf) {
  const inputs = {};
  const ins = links.filter((l) => l.to_node === nodeId);
  for (const l of ins) {
    const val = valueOf(l.from_node);            // 上游产物（文件路径或文本）
    if (val == null) continue;
    const port = l.to_port || (l.to_side === 'left' ? 'in' : null) || 'in';
    if (inputs[port] === undefined) inputs[port] = val;
  }
  // 无端口的历史边：全部归到 'in'（P2 落地后自然分流）
  return inputs;
}
```

### 5.3 输入指纹（增量跳过）

```js
import { createHash } from 'node:crypto';

/** 指纹 = 节点参数 + 上游产物指纹；上游变了则下游必然重算 */
export function inputFingerprint(node, inputs, upstreamFps = {}) {
  const params = safeJSON(node.data) || {};
  const payload = {
    kind: node.kind || 'actor',
    params: { ...params, status: undefined, lastRunId: undefined, lastError: undefined },
    inputs,
    upstream: upstreamFps,
  };
  return createHash('sha1').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
}

function safeJSON(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }
```

### 5.4 计划（dry-run）——**对应 P4 的审核闸门，P3 先把能力做出来**

```js
/**
 * 生成执行计划（不产生任何付费调用）
 * @returns {{order, steps, cycles, estimate}}
 */
export function planGraph({ canvasId = 'CV-MAIN', nodeIds = null, overwrite = false } = {}) {
  const nodes = all('SELECT * FROM canvas_nodes WHERE canvas_id = ?', canvasId);
  const links = all('SELECT * FROM canvas_links WHERE canvas_id = ?', canvasId);
  const pick = nodeIds ? nodes.filter((n) => nodeIds.includes(n.id)) : nodes;
  const { order, cycles } = topoSort(pick.map((n) => n.id), links);
  if (cycles.length) {
    const names = cycles.map((id) => pick.find((n) => n.id === id)?.title || id).join('、');
    throw new Error(`画布存在环形依赖，无法执行：${names}`);
  }
  const willRun = [], willSkip = [];
  for (const id of order) {
    const n = pick.find((x) => x.id === id);
    const kind = n.kind || 'actor';
    if (!EXECUTABLE.has(kind)) { willSkip.push({ id, kind, reason: '该类型不参与执行（仅作为素材源）' }); continue; }
    // 已有的成功记录 + 指纹一致 → 跳过
    const last = lastRun(id);
    const fp = null;   // 计划的指纹需在装配阶段才能算，这里只做"有无可用产物"判断
    if (!overwrite && last && last.status === 'done' && last.file_path) willSkip.push({ id, kind, reason: '已有产物（可用 overwrite 强制重算）' });
    else willRun.push({ id, kind, title: n.title || id });
  }
  const estimate = {
    imageCalls: willRun.filter((s) => s.kind === 'image').length,
    videoCalls: willRun.filter((s) => s.kind === 'video').length,
    textCalls:  willRun.filter((s) => s.kind === 'text').length,
    note: '按节点数估算调用次数；实际费用以平台计费为准',
  };
  return { order, steps: { run: willRun, skip: willSkip }, cycles: [], estimate };
}
```

### 5.5 单节点执行器（`src/modules/graph-api.js`，复用 5.8 的 `EXECUTABLE`）

```js
async function execNode(node, inputs, ctx, opts) {
  const params = safeJSON(node.data) || {};
  const kind = node.kind;
  if (kind === 'image') {
    const refRel = inputs.in || inputs.ref1 || null;
    const refAbs = refRel ? resolveAsset(refRel) : null;
    return generateImage({
      actorId: params.actorId || null,
      kind: 'custom', variant: params.variant || 'canvas',
      prompt: params.prompt || '', negative: params.negative || '',
      width: Number(params.width) || 1024, height: Number(params.height) || 1024,
      seed: params.seed ?? null, backend: params.backend, model: params.model,
      refImage: refAbs, label: node.title || '画布节点',
    });
  }
  if (kind === 'video') {
    if (inputs.last) {
      // 诚实失败：现有后端无尾帧能力，不要静默忽略
      throw new Error('当前视频后端不支持尾帧（首尾帧过渡需新的 ComfyUI 工作流或支持 lastImage 的 HTTP 模板）');
    }
    const kfRel = inputs.first || inputs.in || null;
    return generateVideo({
      scriptId: params.scriptId || null, code: params.code || null,
      shotId: params.shotId || null,
      keyframe: kfRel ? resolveAsset(kfRel) : null,
      prompt: params.prompt || '', negative: params.negative || '',
      motion: params.motion || '', move: params.move || '',
      duration: Number(params.duration) || 3,
      width: Number(params.width) || null, height: Number(params.height) || null,
      backend: params.backend,
    });
  }
  if (kind === 'output') {
    const files = Object.values(inputs).filter(Boolean).map((p) => resolveAsset(p)).filter(Boolean);
    if (files.length <= 1) return { filePath: files[0] || null, single: true };
    return assembleVideos({ scriptId: params.scriptId || null, code: params.code || 'canvas', files,
      duration: Number(params.duration) || 0, transition: Number(params.transition) || 0 });
  }
  throw new Error(`节点类型「${kind}」暂不支持执行`);
}
```

### 5.6 整图执行任务（一次执行 = 一个 job）

```js
export function createGraphRunJob({ canvasId = 'CV-MAIN', nodeIds = null, overwrite = false, title } = {}) {
  const plan = planGraph({ canvasId, nodeIds, overwrite });
  const total = plan.steps.run.length;
  if (!total) throw new Error('没有需要执行的节点（可能都已生成，可用 overwrite=true 强制重算）');
  const jobId = enqueue({
    type: 'graph',                       // 独立队列，避免与 image/video 队列互抢并发额度
    title: title || `画布执行 · ${total} 节点`,
    total,
    limit: 1,                            // ★ 图执行必须串行：下游依赖上游产物
    payload: { canvasId, nodeIds, overwrite },
    handler: async (ctx) => runGraph({ canvasId, plan, overwrite, jobId: ctx.id, ctx }),
  });
  return { jobId, total, plan };
}
```

### 5.7 执行主循环（**核心：失败不中断、下游被跳过、状态回写**）

```js
async function runGraph({ canvasId, plan, overwrite, jobId, ctx }) {
  const nodes = new Map(all('SELECT * FROM canvas_nodes WHERE canvas_id = ?', canvasId).map((n) => [n.id, n]));
  const links = all('SELECT * FROM canvas_links WHERE canvas_id = ?', canvasId);
  const results = [];
  const fpOf = {};                       // nodeId -> 产物指纹（供下游算输入指纹）
  const failed = new Set();
  let done = 0;

  for (const step of plan.order) {
    if (ctx.isCanceled()) throw new Error('任务已取消');
    const node = nodes.get(step);
    if (!node || !EXECUTABLE.has(node.kind || 'actor')) continue;

    // ① 上游失败 → 本节点跳过（不调用付费接口）
    const upIds = links.filter((l) => l.to_node === step).map((l) => l.from_node);
    const badUp = upIds.filter((id) => failed.has(id));
    if (badUp.length) {
      failed.add(step);
      writeNodeStatus(canvasId, step, { status: 'skipped', lastError: `上游节点失败：${badUp.join('、')}` });
      recordRun({ canvasId, nodeId: step, jobId, status: 'skipped', error: '上游节点失败' });
      results.push({ nodeId: step, ok: false, skipped: true, reason: '上游失败' });
      continue;
    }

    // ② 装配输入 + 指纹
    const valueOf = (id) => lastRun(id)?.file_path || sourceValueOf(nodes.get(id));
    const inputs = assembleInputs(step, links, valueOf);
    const inputFp = inputFingerprint(node, inputs, Object.fromEntries(upIds.map((id) => [id, fpOf[id] || null])));

    // ③ 增量跳过：输入未变且已有成功产物
    const last = lastRun(step);
    if (!overwrite && last && last.status === 'done' && last.file_path && last.input_fp === inputFp) {
      fpOf[step] = inputFp;
      recordRun({ canvasId, nodeId: step, jobId, status: 'skipped', file_path: last.file_path, input_fp: inputFp });
      results.push({ nodeId: step, ok: true, skipped: true, file: last.file_path });
      done++; ctx.setProgress(Math.round((done / plan.steps.run.length) * 100), { done, total: plan.steps.run.length });
      continue;
    }

    // ④ 执行（逐节点 try/catch：单点失败不中断整图，对齐现有 keyframe/video 任务的容错风格）
    writeNodeStatus(canvasId, step, { status: 'running' });
    try {
      const out = await execNode(node, inputs, ctx, { overwrite });
      const rec = recordRun({
        canvasId, nodeId: step, jobId, kind: node.kind, status: 'done',
        file_path: out.filePath || null, mime: out.mime, width: out.width, height: out.height,
        duration: out.duration, backend: out.backend, model: out.model,
        prompt: inputs.__prompt || null, input_fp: inputFp,
        meta: { elapsedMs: out.elapsedMs, placeholder: !!out.placeholder, raw: out.raw },
      });
      fpOf[step] = inputFp;
      writeNodeStatus(canvasId, step, { status: 'done', lastRunId: rec.id, lastFile: out.filePath || null });
      results.push({ nodeId: step, ok: true, file: out.filePath });
    } catch (err) {
      const msg = String(err?.message || err);
      failed.add(step);
      recordRun({ canvasId, nodeId: step, jobId, kind: node.kind, status: 'error', error: msg, input_fp: inputFp });
      writeNodeStatus(canvasId, step, { status: 'error', lastError: msg });
      results.push({ nodeId: step, ok: false, error: msg });
      ctx.log(`节点失败：${node.title || step} — ${msg}`);
    }
    done++;
    ctx.setProgress(Math.round((done / plan.steps.run.length) * 100), { done, total: plan.steps.run.length });
  }
  return { total: plan.steps.run.length, failed: results.filter((r) => r.ok === false && !r.skipped).length,
           skipped: results.filter((r) => r.skipped).length, results };
}
```

### 5.8 配套小函数

> **归属划分**（决定文件边界，见红线 2）：
> - 放 **`src/graph.js`**：`EXECUTABLE`、`safeJSON`、`lastRun`、`sourceValueOf`
> - 放 **`src/modules/graph-api.js`**：`writeNodeStatus`、`recordRun`、`execNode`、`runGraph`、`createGraphRunJob`、`runSingleNode`

```js
/** 可执行节点类型（放在 graph.js，planGraph 与执行层共用） */
const EXECUTABLE = new Set(['image', 'video', 'text', 'output']);

function safeJSON(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }

/** 最近一次成功执行记录（放在 graph.js：planGraph 的跳过判断需要） */
export function lastRun(nodeId) {
  return get("SELECT * FROM canvas_node_runs WHERE node_id = ? AND status = 'done' ORDER BY created_at DESC LIMIT 1", nodeId);
}

/** 素材源节点的"产物"：演员节点用其定妆主图/参考图（放在 graph.js） */
export function sourceValueOf(node) {
  if (!node) return null;
  if ((node.kind || 'actor') === 'actor' && node.actor_id) {
    const a = get('SELECT cover_image, ref_image FROM actors WHERE id = ?', node.actor_id);
    return a?.cover_image || a?.ref_image || null;
  }
  return null;
}
```

以下是 **`src/modules/graph-api.js`** 的内容：

```js
/** 节点当前状态写回 canvas_nodes.data（列已存在，无需迁移） */
function writeNodeStatus(canvasId, nodeId, patch) {
  const n = get('SELECT data FROM canvas_nodes WHERE id = ?', nodeId);
  const cur = safeJSON(n?.data) || {};
  run('UPDATE canvas_nodes SET data = ? WHERE id = ?', JSON.stringify({ ...cur, ...patch }), nodeId);
}

function recordRun(rec) {
  const id = rid('NR');
  run(`INSERT INTO canvas_node_runs(id, canvas_id, node_id, job_id, kind, status, file_path, mime, width, height,
        duration, prompt, negative, seed, backend, model, input_fp, error, meta, created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, rec.canvasId, rec.nodeId, rec.jobId || null, rec.kind || null, rec.status || 'done',
    rec.file_path || null, rec.mime || null, rec.width ?? null, rec.height ?? null, rec.duration ?? null,
    rec.prompt || null, rec.negative || null, rec.seed ?? null, rec.backend || null, rec.model || null,
    rec.input_fp || null, rec.error || null, rec.meta ? JSON.stringify(rec.meta) : null, nowISO());
  return get('SELECT * FROM canvas_node_runs WHERE id = ?', id);
}

/** 单节点重跑（对应 LibTV 的 canvas_refresh_node：只重生成没打中的那一镜） */
export function runSingleNode({ canvasId = 'CV-MAIN', nodeId } = {}) {
  return createGraphRunJob({ canvasId, nodeIds: [nodeId], overwrite: true, title: '单节点重跑' });
}
```

**注意**：`runSingleNode` 用 `nodeIds:[nodeId]` 让 `planGraph` 只挑该节点，但**入边仍在**，故输入装配照常生效——这正是"只重跑这一镜、复用上游产物"的实现方式。

---

## 六、步骤 3 · 新建 `src/routes/graph.js` + `server.js` 挂两行

### 6.1 `src/routes/graph.js`（新文件）

```js
import { planGraph, createGraphRunJob, runSingleNode } from '../modules/graph-api.js';  // 见下方说明
import { all } from '../db.js';
import { badRequest } from '../http.js';

export function registerGraphRoutes(app) {
  // dry-run：只出计划，不产生任何付费调用
  app.post('/api/canvas/plan', async (ctx) => {
    const body = (await ctx.body()) || {};
    try { ctx.json({ ok: true, plan: planGraph(body) }); }
    catch (e) { throw badRequest(e.message); }
  });

  // 执行整图
  app.post('/api/canvas/run', async (ctx) => {
    const body = (await ctx.body()) || {};
    try { ctx.json({ ok: true, ...createGraphRunJob(body) }); }
    catch (e) { throw badRequest(e.message); }
  });

  // 单节点重跑
  app.post('/api/canvas/run-node', async (ctx) => {
    const body = (await ctx.body()) || {};
    try { ctx.json({ ok: true, ...runSingleNode(body) }); }
    catch (e) { throw badRequest(e.message); }
  });

  // 节点执行历史
  app.get('/api/canvas/node-runs', async (ctx) => {
    const nodeId = ctx.query.node_id;
    const rows = nodeId
      ? all('SELECT * FROM canvas_node_runs WHERE node_id = ? ORDER BY created_at DESC LIMIT 50', nodeId)
      : all('SELECT * FROM canvas_node_runs ORDER BY created_at DESC LIMIT 50');
    ctx.json({ ok: true, runs: rows });
  });
}
```

> **关于 `modules/graph-api.js`**：建议把 `graph.js` 拆成两半，避免路由直接依赖 `image.js`/`video.js` 的重量级模块图：
> - `src/graph.js` —— 纯算法（`topoSort` / `assembleInputs` / `inputFingerprint` / `planGraph`），**无副作用、可纯函数测试**
> - `src/modules/graph-api.js` —— 执行层（`createGraphRunJob` / `runSingleNode` / `execNode`），依赖 `image.js`/`video.js`/`jobs.js`
>
> 这样 `tests/test-graph.js` 可以只测纯算法，不需要 mock 出图后端。

### 6.2 `server.js` 加两行（**唯一对既有文件的改动**）

- import 段（锚点 `import { registerBridgeRoutes } from './src/routes/bridge.js';`）之后加：
  ```js
  import { registerGraphRoutes } from './src/routes/graph.js';
  ```
- 注册段（锚点 `registerBridgeRoutes(app);`）之后加：
  ```js
  registerGraphRoutes(app);
  ```
> **修订**：本清单初稿称"`server.js` 未被并行会话触碰"——**该判断已失效**（`server.js` 在 17:37 前的某个时点被改过）。
> 不过挂载锚点仍然是文本可 grep 的：import 段锚点 `import { registerBridgeRoutes } from './src/routes/bridge.js';`，
> 注册段锚点 `registerBridgeRoutes(app);`（实测位于 `server.js:13` 与 `server.js:36`，import 在 10-13、注册在 33-36）。
> 若希望更稳，可改用文件里已有的 `tryRegister(relPath, exportName, label)` 降级机制挂载（见 `server.js:60-63`）。

---

## 七、步骤 4 · 新建 `tests/test-graph.js`（纯 Node，无浏览器）

照 `tests/selfcheck.js` 的范式（临时库 + 直接 import，**不起服务**）：

```js
process.env.FACTORY_DB = path.join(os.tmpdir(), `factory-graph-${Date.now()}.db`);
const { migrate, run, get, all } = await import('../src/db.js');
const { topoSort, assembleInputs, inputFingerprint } = await import('../src/graph.js');
```

建议断言（15–20 条）：

| # | 断言 |
|---|------|
| 1–3 | `topoSort` 线性链 / 菱形（多上游汇入） / 孤立节点，顺序正确 |
| 4 | 环检测：`A→B→C→A` 返回 `cycles` 含三节点，且 `planGraph` 抛中文"环形依赖" |
| 5 | 自连边（`from_node === to_node`）被忽略，不产生自环 |
| 6–7 | `assembleInputs`：单入边取到值；`to_port` 存在时按端口归位 |
| 8 | 上游无产物时 `inputs` 为空对象（不写 `undefined` 键） |
| 9–11 | `inputFingerprint`：参数变 → 指纹变；参数不变 → 指纹不变；上游指纹变 → 下游指纹变 |
| 12–13 | `planGraph`：`overwrite=false` 且有成功记录 → 进 `skip`；`overwrite=true` → 进 `run` |
| 14 | `planGraph` 的 `estimate` 按 kind 计数正确 |
| 15 | 演员节点进 `skip` 且 reason 为"仅作为素材源" |
| 16–18 | `canvas_node_runs` 落库与 `lastRun` 取最新成功记录；`writeNodeStatus` 合并进 `canvas_nodes.data` 且**不覆盖**既有键 |
| 19 | `runSingleNode` 传 `nodeIds:[id]` 时 `plan` 只含该节点 |
| 20 | 版本号：`migrate()` 后 `meta_kv.schema_version` 等于 `SCHEMA_VERSION` |

**注意**：执行层（`generateImage`/`generateVideo`）**不要**在单测里真跑，用 `placeholder` 后端或注入 stub；`selfcheck.js` 已有对 placeholder 出图后端的调用先例可参照。

---

## 八、步骤 5（可选）· 前端触发入口

若要在画布上点按钮执行，**最小侵入**做法是不改 `web/views/actors.js`，而是：
1. 用现有 `POST /api/canvas/plan` 在**设置页或新增独立视图**里展示"节点计划"供人确认；
2. 确认后调 `POST /api/canvas/run`，进度复用现有 `jobEvents` / SSE / 轮询（`src/jobs.js` 已支持）。

真正把"执行按钮 + 节点状态徽标"画进画布，属于与并行会话直接竞争同一文件的工作，**建议等 P2 落地、前端空出来后一并做**。

---

## 九、兼容性红线

1. **不改 `web/views/actors.js`**（并行会话主战场）——P3 全程不碰。
2. **模块依赖边界必须守住**：`src/graph.js` 允许 import `./db.js`（只读查询）与 `node:crypto`，但**禁止** import `image.js` / `video.js` / `jobs.js` / `comfy.js`——即"**能读库、不能花钱、不能入队**"。
   因此 `lastRun()`（5.8）**放在 `graph.js`**（`planGraph` 需要它），而 `writeNodeStatus` / `recordRun` / `execNode` / `runGraph` 放 `src/modules/graph-api.js`。
   这样 `tests/test-graph.js` 只测 `graph.js` 时不需要 mock 任何出图后端。
3. 图执行队列 `type: 'graph'` **并发必须为 1**（`limit: 1`），否则下游会读到未完成的上游产物，造成隐性重复调用与费用失控。
4. 单节点失败**不得中断整图**；下游标记 `skipped` 并写明原因，且**不得**调用任何付费接口。
5. 尾帧（`last`）**必须显式报错**，不得静默降级为首帧（否则用户以为做了首尾帧，实际不是）。
6. `canvas_node_runs` 与 `canvas_nodes.data` 只增不改既有语义；`data` 里除 `status/lastRunId/lastFile/lastError` 外的键**原样保留**。
7. `planGraph` **绝不**发起生成调用——它是 P4 审核闸门的基础，必须可安全地给 Agent/用户反复调用。
8. 新增 `/api/graph/*` 路由前缀避免与现有 `/api/canvas/*` 冲突（本清单选用了 `/api/canvas/plan|run|run-node|node-runs`，施工时若发现与并行会话新增路由撞名，改用 `/api/graph/*`）。

## 十、提交粒度

| 提交 | 文件 | 验证 |
|------|------|------|
| 1 | `db.js`（`canvas_node_runs` 表 + 版本号） | 启动无错、`PRAGMA table_info(canvas_node_runs)` 20 列 |
| 2 | `src/graph.js`（纯算法） | `tests/test-graph.js` 断言 1–15 全绿 |
| 3 | `src/modules/graph-api.js`（执行层） | 断言 16–20 + 手工跑一个 2 节点图（placeholder 后端） |
| 4 | `src/routes/graph.js` + `server.js` 两行 | `curl /api/canvas/plan` 返回计划；`curl /api/canvas/run` 起任务 |
| 5 | `tests/test-graph.js` 补执行层断言 | 全绿 |

提交 1–4 均**不触碰任何前端文件**，可与并行会话完全并行推进。

---

## 十一、与 P4 的衔接（预告，不在本阶段）

P3 把 `planGraph`（dry-run）做出来后，P4 的"人类审核闸门"只需在其上加：
1. `POST /api/graph/agent`：LLM 产出 `{nodes[], links[]}` → 先写画布**草稿**（不执行）
2. 展示 `planGraph` 结果供人确认
3. 确认后才调 `/api/canvas/run`

**成本预估可进一步接入既有 `shots.cost_level`（L/M/H）**，把 `estimate` 从"调用次数"升级为"分档成本"。

---

## 实施记录（2026-09-27）

- `src/graph.js` 769→799 行：`topoSort`/`findCycleNodes`/`assembleInputs(Detailed)`/`inputFingerprint`/`planGraph`/`execNode`/`runGraph`/`createGraphRunJob`/`runSingleNode`/`graphStatus` 等 27 个导出；执行层合并进同一文件（规格书原计划拆到 `src/modules/graph-api.js`），出图/视频适配器只在执行那一刻动态 `import`。
- `canvas_node_runs` 建表已并入 `src/db.js` 的 SCHEMA（版本 9 → 10），索引同上；`ensureGraphSchema()` 仍保留作为幂等兜底。
- `server.js` 已挂 5 个路由：`POST /api/canvas/plan`、`POST /api/canvas/run`、`POST /api/canvas/run-node`、`GET /api/canvas/node-runs`、`GET /api/graph/status`。
- `tests/test-graph.js`：182 项断言。
- **规格书之外的语义修正**：执行顺序与成环判定**只认数据流边**（`isFlowLink()`）——
  - 带 `from_port`/`to_port` 的连线一定是数据流边；
  - 不带端口的连线，仅当**目标节点可执行**时才算数据流边。
  真实主画布上有 5 条「对手戏 / 出现在 / 持有」语义关系线，早期实现把它们当作依赖，导致计划直接报「画布存在环形依赖，无法执行」——这是集成期发现的真实缺陷，已修并加了回归断言。
- `runGraph` 不再让节点内的子步骤覆盖任务级 `done/total`（详见 P5 实施记录）。
