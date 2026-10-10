# P4 改动清单：Agent 接口 + 人类审核闸门

> ✅ **本清单已于 2026-09-27 实施**（`src/mcp-tools.js` / `src/mcp-server.js` / `scripts/mcp.js`；审批路由改由 `registerMcpRoutes(app)` 挂载；`canvas_plans` / `canvas_plan_audits` 已并入 `db.js` SCHEMA 11；`tests/test-mcp.js` 264 项断言）。实施记录见文末。

> 用途：`docs/画布节点图改造方案.md` 的 **P4 阶段**可施工清单。
> **本清单未应用任何改动**（源码零改动）。
> **零冲突设计**：全部新增文件（`src/mcp-tools.js`、`src/mcp-server.js`、`scripts/mcp.js`），仅 `server.js` 加一行。
> 复核时间 2026-09-26 17:37。**P4 依赖 P3 的 `planGraph`，建议 P3 先落地。**

---

## 一、为什么这块价值最高

调研结论（见 `~/Desktop/infinite-canvas-osint/视频无限画布开源项目调研.md`）：

> LibTV 的「**生成前提交节点计划供人类审核**」（手动生成模式）+ dry-run 预览，
> 在**所有开源同类项目里都缺失**——12 条最小功能集里第 10 条无人实现。

而你已经具备做这件事的全部材料：`src/jobs.js` 的持久化队列与取消、`shots.cost_level`（L/M/H 成本级）、
`src/modules/canvas-assets.js` 的画布↔分镜资产装配。补这个闸门的成本很低，却是「100 集批量生产」时真正防烧钱的东西。

---

## 二、可复用的既有构件（实测确认）

### 2.1 `src/modules/canvas-assets.js` —— 被低估的一块

| 导出 | 作用 | 对 P4 的价值 |
|------|------|-------------|
| `buildCanvasAssetPack(canvasId)` | 构建画布资产包 | Agent 的「读画布资产」工具 |
| `bindCanvasToScript(scriptId, canvasId)` / `unbindCanvasFromScript` / `getScriptCanvasBinding` | 画布↔剧本绑定 | Agent 的「绑定项目」工具 |
| `mergeCanvasLocations(locations, pack)` | 画布地点并入剧本地点 | 已被模块 3 使用 |
| **`matchItemsForShot(shot, pack, limit)`** | **按镜头匹配画布资产** | ★ 几乎就是「上游产物注入下游」 |
| **`canvasRefsForShot({shot, pack, locationId, locationName})`** | **为镜头生成画布引用** | ★ 图执行装配参考图的现成逻辑 |
| `exportCanvasAssets(canvasId, format)` | 导出资产（md 等） | Agent 交付物 |
| `lexiconEn(text)` | 中英词表 | 提示词处理 |

**结论：P4 不要重写"画布资产 → 分镜引用"的逻辑，直接暴露上述导出为 MCP 工具即可。**

### 2.2 其他

| 构件 | 位置 | 用途 |
|------|------|------|
| `planGraph` / `createGraphRunJob` / `runSingleNode` | P3 产出 | 计划与执行 |
| `enqueue` / `getJob` / `listJobs` / `cancelJob` / `jobEvents` | `src/jobs.js` | Agent 观察与取消任务 |
| `getCanvas(canvasId)` | `src/modules/actors.js` | 读画布（含 `nodes`（带 `kind`/`data`/`title`）/ `links`（带 `from_node`/`to_node`/`from_side`/`to_side`）/ `groups`） |
| `upsertCanvasNode` / `removeCanvasNode` / `createNote` / `createLink` / `deleteLink` | `src/modules/actors.js` | 节点与连线写入 |
| `restoreCanvas({canvas_id, nodes, groups})` | `src/modules/actors.js` | 批量落图（Agent 生成整图用） |
| `registerXxxRoutes(app)` + `server.js` 一行注册 | `server.js:10-13 / 33-36` | HTTP 侧挂载 |

### 2.3 现状中**没有**的东西

全仓检索 `mcp` / `agent` 关键词：**零命中**。MCP 与 Agent 接口是全新的。
> 注意：`src/routes/bridge.js` **不是** Agent 桥，而是「画布资产桥」（资产包查询/导出/绑定剧本）。

---

## 三、两个必须先定的设计决策

### 决策 1：**自己实现极简 MCP，不引入 `@modelcontextprotocol/sdk`**

理由：项目自述「**零外部依赖（只需 Node ≥ 22）**」。MCP 的 stdio 传输就是**换行分隔的 JSON-RPC 2.0**，
只需实现 `initialize` / `tools/list` / `tools/call` 三个方法即可被 Claude Code、Codex、DSH 等客户端正常加载。
手写约 150 行，换取零依赖与完全可控的错误语义。

### 决策 2：**节点引用沿用现有 `ND-xxx`，不要新造 `N-0001`**

实测节点 id 生成方式为 `` `ND-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}` ``
（`src/modules/actors.js` 三处）。它是**稳定主键**（一旦创建不变），足以让 Agent 精确定位。

> ⚠️ 修正：方案的早期版本提议「新增 `N-0001` 自增编号」。**不必做**——重编号会打断所有既有引用（`canvas_links.from_node`、`canvas_node_runs.node_id`）。
> Agent 需要的是「可发现」而非「可排序」：提供 `canvas_list_nodes` 返回 `{id, kind, title, status}`，Agent 按 `title` 找到 `id` 即可。

---

## 四、步骤 1 · `src/db.js`：计划表（审核闸门的存储）

**定位锚点**：`CREATE TABLE IF NOT EXISTS canvas_node_runs (`（P3 新增）之后。

```sql
-- 画布执行计划（Agent 干跑 → 人类审核 → 确认码放行）
CREATE TABLE IF NOT EXISTS canvas_plans (
  id TEXT PRIMARY KEY,
  canvas_id TEXT NOT NULL,
  plan TEXT NOT NULL,                -- planGraph 的 JSON 快照
  status TEXT DEFAULT 'pending',     -- pending | approved | rejected | expired | consumed
  confirm_code TEXT,                 -- 6 位确认码（仅人类可见：服务端日志 / UI 展示）
  created_by TEXT DEFAULT 'agent',   -- agent | human
  approved_at TEXT, consumed_at TEXT, expires_at TEXT,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_canvas_plans ON canvas_plans(canvas_id, status);
```

**同时** `SCHEMA_VERSION` 单调递增（P2/P3 之后顺延，如 `10`）。
**兼容性**：纯新增空表。

---

## 五、步骤 2 · 新建 `src/mcp-tools.js`：工具定义（薄封装，不写业务逻辑）

**设计原则**：每个工具 = 一行调用既有模块函数。**本文件不含任何生成逻辑**，避免与 `graph-api.js` 重复。

```js
import { getCanvas, upsertCanvasNode, removeCanvasNode, createNote, createLink, deleteLink, restoreCanvas } from './modules/actors.js';
import { buildCanvasAssetPack, exportCanvasAssets, bindCanvasToScript, canvasRefsForShot } from './modules/canvas-assets.js';
import { planGraph } from './graph.js';
import { getJob, listJobs, cancelJob } from './jobs.js';
import { all, get, run, rid } from './db.js';
import { nowISO } from './util.js';

/** 工具清单：name / description / inputSchema / handler */
export const TOOLS = [
  // ---------- 只读：安全，Agent 可随意调用 ----------
  { name: 'canvas_list_nodes', description: '列出画布全部节点（id/kind/title/状态），Agent 用它把标题解析为节点 id',
    inputSchema: { type: 'object', properties: { canvas_id: { type: 'string' } } },
    handler: ({ canvas_id = 'CV-MAIN' }) => {
      const c = getCanvas(canvas_id);
      return c.nodes.map((n) => ({ id: n.id, kind: n.kind || 'actor', title: n.title || n.name || n.id,
        actor_id: n.actor_id || null, status: safeStatus(n.data), x: n.x, y: n.y }));
    } },

  { name: 'canvas_get_graph', description: '读取画布的节点与连线（DAG 结构）',
    inputSchema: { type: 'object', properties: { canvas_id: { type: 'string' } } },
    handler: ({ canvas_id = 'CV-MAIN' }) => {
      const c = getCanvas(canvas_id);
      return { nodes: c.nodes.map((n) => ({ id: n.id, kind: n.kind || 'actor', title: n.title || n.name })),
               links: c.links.map((l) => ({ id: l.id, from_node: l.from_node, to_node: l.to_node,
                 from_port: l.from_port || null, to_port: l.to_port || null, slot: l.slot ?? 0, label: l.label || '' })),
               groups: (c.groups || []).map((g) => ({ id: g.id, name: g.name })) };
    } },

  { name: 'canvas_asset_pack', description: '读取画布资产包（角色/场景/道具/地点）',
    inputSchema: { type: 'object', properties: { canvas_id: { type: 'string' } } },
    handler: ({ canvas_id = 'CV-MAIN' }) => buildCanvasAssetPack(canvas_id) },

  { name: 'canvas_refs_for_shot', description: '为某个分镜镜头推导应引用的画布资产（复用模块3装配逻辑）',
    inputSchema: { type: 'object', properties: { canvas_id: { type: 'string' }, shot: { type: 'object' } }, required: ['shot'] },
    handler: ({ canvas_id = 'CV-MAIN', shot }) => canvasRefsForShot({ shot, pack: buildCanvasAssetPack(canvas_id) }) },

  { name: 'canvas_node_runs', description: '查询节点执行历史（含失败原因与产物路径）',
    inputSchema: { type: 'object', properties: { node_id: { type: 'string' }, limit: { type: 'number' } } },
    handler: ({ node_id, limit = 30 }) => (node_id
      ? all('SELECT * FROM canvas_node_runs WHERE node_id = ? ORDER BY created_at DESC LIMIT ?', node_id, limit)
      : all('SELECT * FROM canvas_node_runs ORDER BY created_at DESC LIMIT ?', limit)) },

  { name: 'job_status', description: '查询任务状态（Agent 轮询用）',
    inputSchema: { type: 'object', properties: { job_id: { type: 'string' }, limit: { type: 'number' } } },
    handler: ({ job_id, limit = 20 }) => (job_id ? getJob(job_id) : listJobs({ limit })) },

  // ---------- 计划：★ 不花钱，Agent 应反复调用 ----------
  { name: 'canvas_plan', description: '干跑：生成执行计划与调用次数预估，【不发起任何生成调用】。返回 plan_id 与 confirm_code（确认码只给人类看）',
    inputSchema: { type: 'object', properties: { canvas_id: { type: 'string' }, node_ids: { type: 'array', items: { type: 'string' } }, overwrite: { type: 'boolean' } } },
    handler: ({ canvas_id = 'CV-MAIN', node_ids = null, overwrite = false }) => {
      const plan = planGraph({ canvasId: canvas_id, nodeIds: node_ids, overwrite });   // 抛中文错误：环形依赖等
      const id = rid('PL');
      const code = String(Math.floor(100000 + Math.random() * 900000));
      run(`INSERT INTO canvas_plans(id, canvas_id, plan, status, confirm_code, created_by, expires_at, created_at)
           VALUES(?,?,?,'pending',?,'agent',?,?)`,
        id, canvas_id, JSON.stringify(plan), code, new Date(Date.now() + 30 * 60 * 1000).toISOString(), nowISO());
      // 确认码只写服务端日志，不经 MCP 返回——这是闸门的关键
      console.log(`[gate] 计划 ${id}（画布 ${canvas_id}）待人工确认，确认码：${code}｜含 ${plan.steps.run.length} 个待执行节点`);
      return { plan_id: id, canvas_id, steps: plan.steps, estimate: plan.estimate,
               note: '计划已生成，需人工在服务端日志/界面中取得确认码后，才能调用 canvas_run 执行' };
    } },

  // ---------- 执行：★ 必须有确认码 ----------
  { name: 'canvas_run', description: '执行已批准的计划。【必须提供 plan_id 与人类确认码，否则拒绝】',
    inputSchema: { type: 'object', properties: { plan_id: { type: 'string' }, confirm_code: { type: 'string' } }, required: ['plan_id', 'confirm_code'] },
    handler: ({ plan_id, confirm_code }) => {
      const p = get('SELECT * FROM canvas_plans WHERE id = ?', plan_id);
      if (!p) throw new Error(`计划不存在：${plan_id}`);
      if (p.status === 'consumed') throw new Error('该计划已执行过，请重新 plan');
      if (p.status === 'rejected') throw new Error('该计划已被人工拒绝');
      if (p.expires_at && p.expires_at < nowISO()) { run("UPDATE canvas_plans SET status='expired' WHERE id=?", plan_id); throw new Error('计划已过期，请重新 plan'); }
      if (String(confirm_code) !== String(p.confirm_code)) throw new Error('确认码不正确（确认码只发给人类，Agent 不得自行确认）');
      const plan = JSON.parse(p.plan);
      // 执行前二次干跑，确保画布自计划生成后未被改动
      const fresh = planGraph({ canvasId: p.canvas_id });
      if (JSON.stringify(fresh.steps) !== JSON.stringify(plan.steps)) throw new Error('画布自计划生成后已变更，请重新 plan 并再次确认');
      run("UPDATE canvas_plans SET status='consumed', consumed_at=? WHERE id=?", nowISO(), plan_id);
      return createGraphRunJob({ canvasId: p.canvas_id });     // P3 产出
    } },

  { name: 'canvas_run_node', description: '单节点重跑（只重生成没打中的那一个节点）',
    inputSchema: { type: 'object', properties: { canvas_id: { type: 'string' }, node_id: { type: 'string' } }, required: ['node_id'] },
    handler: ({ canvas_id = 'CV-MAIN', node_id }) => runSingleNode({ canvasId: canvas_id, nodeId: node_id }) },

  { name: 'job_cancel', description: '取消任务',
    inputSchema: { type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'] },
    handler: ({ job_id }) => ({ canceled: cancelJob(job_id) }) },

  // ---------- 写入画布：不花钱，但会改数据 ----------
  { name: 'canvas_node_create', description: '新建节点（kind: text|image|video|note|shot|output）',
    inputSchema: { type: 'object', properties: { canvas_id: { type: 'string' }, kind: { type: 'string' }, title: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, data: { type: 'object' } }, required: ['kind'] },
    handler: ({ canvas_id = 'CV-MAIN', kind, title, x = 0, y = 0, data = {} }) => {
      if (kind === 'note') return createNote({ canvas_id, x, y, text: title || '', color: data.color || 'amber' });
      const id = rid('ND');
      run(`INSERT INTO canvas_nodes(id, canvas_id, actor_id, x, y, w, h, z, locked, note, kind, title, data)
           VALUES(?,?,'',?,?,?,?,0,0,'',?,?,?)`,
        id, canvas_id, x, y, data.w || 220, data.h || 180, kind, title || kind, JSON.stringify(data || {}));
      return { ok: true, node: get('SELECT * FROM canvas_nodes WHERE id = ?', id) };
    } },

  { name: 'canvas_node_update', description: '更新节点位置/尺寸/标题/参数',
    inputSchema: { type: 'object', properties: { node_id: { type: 'string' }, patch: { type: 'object' } }, required: ['node_id', 'patch'] },
    handler: ({ node_id, patch = {} }) => {
      const n = get('SELECT * FROM canvas_nodes WHERE id = ?', node_id);
      if (!n) throw new Error(`节点不存在：${node_id}`);
      const data = patch.data ? JSON.stringify({ ...(safeJSON(n.data) || {}), ...patch.data }) : n.data;
      run('UPDATE canvas_nodes SET x=?, y=?, w=?, h=?, title=?, data=? WHERE id=?',
        patch.x ?? n.x, patch.y ?? n.y, patch.w ?? n.w, patch.h ?? n.h, patch.title ?? n.title, data, node_id);
      return { ok: true, node: get('SELECT * FROM canvas_nodes WHERE id = ?', node_id) };
    } },

  { name: 'canvas_node_delete', description: '删除节点（同时清理其连线）',
    inputSchema: { type: 'object', properties: { node_id: { type: 'string' } }, required: ['node_id'] },
    handler: ({ node_id }) => { run('DELETE FROM canvas_links WHERE from_node = ? OR to_node = ?', node_id, node_id);
      removeCanvasNode(node_id); return { ok: true }; } },

  { name: 'canvas_link_create', description: '建立节点连线（可选 from_port/to_port 类型化端口）',
    inputSchema: { type: 'object', properties: { canvas_id: { type: 'string' }, from_node: { type: 'string' }, to_node: { type: 'string' }, label: { type: 'string' }, from_port: { type: 'string' }, to_port: { type: 'string' } }, required: ['from_node', 'to_node'] },
    handler: (args) => createLink(args) },

  { name: 'canvas_link_delete', description: '删除连线',
    inputSchema: { type: 'object', properties: { link_id: { type: 'string' } }, required: ['link_id'] },
    handler: ({ link_id }) => deleteLink(link_id) },

  { name: 'canvas_restore', description: '原子替换画布节点与分组（Agent 一次性落整张图）',
    inputSchema: { type: 'object', properties: { canvas_id: { type: 'string' }, nodes: { type: 'array' }, groups: { type: 'array' } }, required: ['nodes'] },
    handler: ({ canvas_id = 'CV-MAIN', nodes, groups = [] }) => restoreCanvas({ canvas_id, nodes, groups }) },

  { name: 'canvas_export_assets', description: '导出画布资产（md/json）',
    inputSchema: { type: 'object', properties: { canvas_id: { type: 'string' }, format: { type: 'string' } } },
    handler: ({ canvas_id = 'CV-MAIN', format = 'md' }) => exportCanvasAssets(canvas_id, format) },

  { name: 'canvas_bind_script', description: '把画布绑定到某个剧本（供模块3装配分镜引用）',
    inputSchema: { type: 'object', properties: { script_id: { type: 'string' }, canvas_id: { type: 'string' } }, required: ['script_id'] },
    handler: ({ script_id, canvas_id = 'CV-MAIN' }) => bindCanvasToScript(script_id, canvas_id) },
];

function safeJSON(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }
function safeStatus(s) { return (safeJSON(s) || {}).status || 'idle'; }
```

**工具分级（写进 description，也建议在文档里明确）**：

| 级别 | 工具 | 是否花钱 |
|------|------|---------|
| 只读 | `canvas_list_nodes` `canvas_get_graph` `canvas_asset_pack` `canvas_refs_for_shot` `canvas_node_runs` `job_status` | 否 |
| 计划 | `canvas_plan` | 否（**绝不**发起调用） |
| 改画布 | `canvas_node_create/update/delete` `canvas_link_create/delete` `canvas_restore` `canvas_export_assets` `canvas_bind_script` | 否 |
| **执行** | `canvas_run`（**需确认码**）、`canvas_run_node`、`job_cancel` | **是** |

---

## 六、步骤 3 · 新建 `src/mcp-server.js`：零依赖 stdio JSON-RPC

```js
import { TOOLS } from './mcp-tools.js';

const PROTOCOL_VERSION = '2024-11-05';   // 客户端会协商；不匹配时按客户端版本回显

/** 纯函数：处理一条 JSON-RPC 消息，返回响应对象（null 表示通知，无需响应） */
export async function handleMessage(msg) {
  const { id, method, params = {} } = msg || {};
  // 通知：无 id，不响应
  if (id === undefined || id === null) return null;
  try {
    if (method === 'initialize') {
      return ok(id, { protocolVersion: params.protocolVersion || PROTOCOL_VERSION,
        capabilities: { tools: {} }, serverInfo: { name: 'ai-video-factory-canvas', version: '1.0.0' } });
    }
    if (method === 'tools/list') {
      return ok(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    }
    if (method === 'tools/call') {
      const t = TOOLS.find((x) => x.name === params.name);
      if (!t) return err(id, -32602, `未知工具：${params.name}`);
      const out = await t.handler(params.arguments || {});
      return ok(id, { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] });
    }
    if (method === 'ping') return ok(id, {});
    return err(id, -32601, `不支持的方法：${method}`);
  } catch (e) {
    // 业务错误作为工具结果返回，便于 Agent 读懂中文原因（而非协议层报错）
    if (method === 'tools/call') return ok(id, { isError: true, content: [{ type: 'text', text: String(e?.message || e) }] });
    return err(id, -32603, String(e?.message || e));
  }
}

const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const err = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

/** stdio 主循环：换行分隔 JSON（MCP stdio 传输） */
export function startStdioServer() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }     // 忽略非法行，不崩
      const res = await handleMessage(msg);
      if (res) process.stdout.write(JSON.stringify(res) + '\n');       // ★ 只写 stdout，日志一律走 stderr
    }
  });
  process.stdin.on('end', () => process.exit(0));
  process.stderr.write('[mcp] canvas server ready (stdio)\n');
}
```

**关键约束**：**stdout 只能输出 JSON-RPC**，所有日志必须走 `stderr`。
本项目已有大量 `console.log`（如 `[gate] 计划 …`），在 MCP 进程里必须改成 `console.error`，否则会污染协议流。
→ **建议**：入口脚本里把 `console.log` 重定向到 stderr（见步骤 4），这样无需改动既有模块。

---

## 七、步骤 4 · 新建 `scripts/mcp.js`：可执行入口

```js
#!/usr/bin/env node
// MCP stdio 入口：零依赖，被 Claude Code / Codex / DSH 作为 stdio server 拉起
import path from 'node:path';
import os from 'node:os';

// ① 隔离数据库（可选）：默认复用项目 data/，需要隔离时设 FACTORY_DATA_DIR
// ② 关键：把 console.log 重定向到 stderr，避免污染 MCP 的 stdout 协议流
console.log = (...a) => console.error(...a);

const { migrate } = await import('../src/db.js');
migrate();
const { startStdioServer } = await import('../src/mcp-server.js');
startStdioServer();
```

**客户端配置示例**（Claude Code / Codex 的 MCP 配置片段）：

```json
{
  "mcpServers": {
    "ai-video-factory": {
      "command": "node",
      "args": ["/home/linsheng/Desktop/ai-video-factory/scripts/mcp.js"],
      "env": { "FACTORY_DATA_DIR": "/home/linsheng/Desktop/ai-video-factory/data" }
    }
  }
}
```

---

## 八、步骤 5 · HTTP 侧补两条（人类确认入口）

放在 P3 的 `src/routes/graph.js`（同一个新文件，仍不碰既有路由文件）：

```js
// 列出待确认计划（人类界面用；★ 不返回 confirm_code 的完整值）
app.get('/api/canvas/plans', async (ctx) => {
  const rows = all("SELECT id, canvas_id, plan, status, created_by, expires_at, created_at FROM canvas_plans WHERE status = 'pending' ORDER BY created_at DESC LIMIT 20");
  ctx.json({ ok: true, plans: rows.map((r) => ({ ...r, plan: JSON.parse(r.plan) })) });
});

// 人类确认 / 拒绝（需显式 confirm=true；确认码由服务端日志给出）
app.post('/api/canvas/plans/:id/approve', async (ctx) => {
  const body = (await ctx.body()) || {};
  const p = get('SELECT * FROM canvas_plans WHERE id = ?', ctx.params.id);
  if (!p) throw badRequest('计划不存在');
  if (p.status !== 'pending') throw badRequest(`计划状态为 ${p.status}，不可再次审批`);
  if (body.reject) { run("UPDATE canvas_plans SET status='rejected' WHERE id=?", p.id); ctx.json({ ok: true, status: 'rejected' }); return; }
  if (body.confirm !== true) throw badRequest('需显式 confirm=true 才能批准');
  run("UPDATE canvas_plans SET status='approved', approved_at=? WHERE id=?", nowISO(), p.id);
  ctx.json({ ok: true, status: 'approved' });
});
```

> **注意**：批准后 `canvas_run` 仍校验确认码。这样双保险：
> **HTTP 侧批准**（人点按钮）与 **MCP 侧确认码**（人抄日志）都需要过。
> 若嫌繁琐，可只保留确认码一条（把 `approved_at` 校验换成 `status IN ('pending','approved')`）。

---

## 九、闸门的强度：诚实说明

这是**防误操作的护栏，不是安全边界**。三道关卡：

| 关卡 | 机制 | 能挡住什么 |
|------|------|-----------|
| 1 | `canvas_plan` 干跑，返回不含确认码 | 挡住 Agent「顺手」直接执行 |
| 2 | 确认码只写服务端日志，不经 MCP 返回 | 挡住 Agent 自行确认（它拿不到码） |
| 3 | 执行前二次 `planGraph` 比对 | 挡住「计划期间画布被改动」导致的错执行 |

**挡不住的**：Agent 若同时具备 shell 访问权限，可以读服务端日志拿到确认码，或直接 `curl /api/canvas/run`。
真正的隔离需要**进程权限分离**（MCP 进程只读日志、执行走独立带鉴权的服务）。
**在单机自用场景下，上述三道关卡已足够避免"Agent 一口气烧掉几百块"这类事故**——这正是本闸门的目标。

---

## 十、步骤 6 · 新建 `tests/test-mcp.js`（纯 Node，无浏览器）

照 `tests/selfcheck.js` 范式（临时库 + 直接 import，不起服务）：

```js
process.env.FACTORY_DB = path.join(os.tmpdir(), `factory-mcp-${Date.now()}.db`);
const { migrate, run, get } = await import('../src/db.js');
const { handleMessage } = await import('../src/mcp-server.js');
const { TOOLS } = await import('../src/mcp-tools.js');
migrate();
```

建议断言（18–22 条）：

| # | 断言 |
|---|------|
| 1 | `initialize` 返回 `protocolVersion` / `capabilities.tools` / `serverInfo` |
| 2 | 无 `id` 的通知返回 `null`（不产生响应） |
| 3 | 未知方法返回 `-32601` |
| 4 | `tools/list` 不含 `handler` 字段（不得把内部函数暴露给客户端） |
| 5 | `tools/list` 每个工具的 `inputSchema.type === 'object'` |
| 6 | 工具名唯一、且全部为 `canvas_*` / `job_*` 命名空间 |
| 7 | `tools/call` 未知工具 → `-32602` |
| 8 | 工具内部抛错 → 返回 `isError:true` 且文本含中文原因（而非协议层错误） |
| 9–11 | `canvas_plan`：返回 `plan_id` + `estimate`；**响应中不含 `confirm_code`**；`canvas_plans` 落库 `status='pending'` |
| 12 | `canvas_run` 缺 `confirm_code` → 报错（参数校验） |
| 13 | `canvas_run` 确认码错误 → 报错「确认码不正确」 |
| 14 | `canvas_run` 正确确认码 → 起任务，且 `canvas_plans.status` 变 `consumed` |
| 15 | 同一 `plan_id` 二次 `canvas_run` → 报错「已执行过」 |
| 16 | 计划过期（手改 `expires_at` 为过去）→ 报错「已过期」且状态变 `expired` |
| 17 | 画布在 plan 后被改动（加一个节点）→ `canvas_run` 报错「画布已变更」 |
| 18 | `canvas_node_create` 建 `text` 节点 → `canvas_list_nodes` 能按 title 找到对应 id |
| 19 | `canvas_node_delete` 删节点 → 其连线一并清理（`canvas_links` 无残留） |
| 20 | `canvas_asset_pack` / `canvas_refs_for_shot` 复用既有模块且返回结构正确 |
| 21 | `canvas_run_node` 只对单节点起计划（`plan.steps.run.length === 1`） |
| 22 | **全流程零生成调用**：断言测试期间 `canvas_node_runs` 无新增 `done` 记录（用 placeholder 或直接不执行） |

**特别注意断言 22**：它保证 MCP 层自身不产生任何付费副作用——所有花钱路径都必须经过 `canvas_run` 闸门。

---

## 十一、兼容性红线

1. **不修改** `web/views/actors.js`、`src/modules/actors.js`、`src/routes/actors.js`（并行会话主战场）。P4 全部为新增文件。
2. **`console.log` 在 MCP 进程里必须重定向到 stderr**——否则污染 JSON-RPC 的 stdout，客户端会直接解析失败。
3. `canvas_plan` **绝不**发起生成调用；`planGraph`（P3）已保证这一点，勿在工具层再加"顺手执行"。
4. **确认码不经 MCP 返回**；只写 `console.error`。这是闸门的核心，不得为了方便调试而返回。
5. 工具名与 HTTP 路由**不得重名冲突**：HTTP 用 `/api/canvas/*`，MCP 工具用 `canvas_*`。
6. `src/mcp-tools.js` **只做薄封装**，不得复制 `canvas-assets.js` / `graph-api.js` 的业务逻辑（否则两处逻辑必然漂移）。
7. 节点引用**沿用 `ND-xxx`**，不重编号（会打断 `canvas_links.from_node` / `canvas_node_runs.node_id`）。
8. MCP 协议只实现 `initialize` / `tools/list` / `tools/call` / `ping` 即可；**不要**承诺 `resources` / `prompts` / `sampling` 能力（`capabilities` 里不声明，客户端就不会调用）。

## 十二、提交粒度

| 提交 | 文件 | 验证 |
|------|------|------|
| 1 | `db.js`（`canvas_plans` 表 + 版本号） | `PRAGMA table_info(canvas_plans)` |
| 2 | `src/mcp-tools.js` | `tests/test-mcp.js` 断言 4–8、18–21 |
| 3 | `src/mcp-server.js` | 断言 1–3、协议层正确 |
| 4 | `scripts/mcp.js` | 手工：`echo '{"jsonrpc":"2.0","id":1,"method":"initialize"}' \| node scripts/mcp.js` |
| 5 | `src/routes/graph.js` 补两条审批路由 | `curl /api/canvas/plans` |
| 6 | `tests/test-mcp.js` 补闸门断言 | 断言 9–17、22 全绿 |

提交 1–4 **完全不依赖 P2/P3 的前端部分**，可与并行会话并行推进；仅 `canvas_run` 依赖 P3 已落地。

---

## 十三、与 LibTV 的对齐度（做完 P4 后）

| LibTV 的 Agent 能力 | 本项目 P4 后 |
|--------------------|-------------|
| 官方 CLI | ⚠️ 无（但 MCP + HTTP 已够 Agent 用；如需 CLI 可在 `scripts/` 加薄命令） |
| 官方 Remote MCP（OAuth） | ✅ 本地 stdio MCP（**无 OAuth**：本机自用场景不需要，暴露公网时再加） |
| Skill 分发包 | ⚠️ 未做（可把 `docs/使用手册.md` 改写成 Skill 描述文件，成本低） |
| Agent 与人类共享同一项目数据 | ✅ 同一 SQLite + 同一 HTTP 服务 |
| **生成前节点计划供人审核 + dry-run** | ✅ **三道关卡，比 LibTV 更严** |
| 稳定节点编号供 Agent 定位 | ✅ `ND-xxx` + `title` + `canvas_list_nodes` 发现接口 |

---

## 实施记录（2026-09-27）

| 交付 | 行数 | 说明 |
|------|------|------|
| `src/mcp-tools.js` | 830 | 23 个工具 + 四道关闸门（人工 approve → 人类确认码 → 执行前二次 `planGraph` 逐字比对 → `guard.js` 预算闸门）+ 成本级 L/M/H |
| `src/mcp-server.js` | 227 | 零依赖 stdio JSON-RPC 2.0 + `registerMcpRoutes(app)`（审批路由）+ 可选独立 HTTP 服务 |
| `scripts/mcp.js` | 117 | CLI（`--http` / `--catalog` / `--selftest`） |
| `tests/test-mcp.js` | 629 | 264 项断言（含「未审批 = 执行器 0 调用」反证） |

- `canvas_plans` / `canvas_plan_audits` 已并入 `src/db.js` SCHEMA（版本 10 → **11**），`server.js` 里 `migrate()` 之后仍有 `ensureMcpSchema()` 幂等兜底。
- 审批路由挂在 `src/mcp-server.js` 的 `registerMcpRoutes(app)`，`server.js` 一行挂载（未新建 `src/routes/graph.js`）。
- **未审批绝不放行**已由闸门强制；`POST /api/canvas/run`（P3 原始路由）仍存在，界面已统一改走 P4 的 `/api/canvas/plans*` 流程（画布工具栏「🧭 执行计划」：dry-run → 批准 → 输入终端确认码 → 执行）。
- 单节点重跑（`canvas_run_node`）同样要求「单节点计划 + 已审批 + 确认码」——否则它就是绕过闸门的后门。
