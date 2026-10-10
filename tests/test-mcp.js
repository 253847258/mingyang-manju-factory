// P4 · Agent 接口 + 人类审核闸门自测（纯 Node，离线零成本）
// 用法：node tests/test-mcp.js
// 覆盖：工具清单与参数校验 / MCP 协议层（initialize·tools/list·tools/call·ping·通知·未知方法）/
//       只读工具与真实数据一致 / dry-run 计划与 planGraph 一致 / cost_level 与调用数预估 /
//       ★ 未审批不得执行（执行器零调用反证）/ 审批后执行成功 / 拒绝后失效 /
//       过期与重复审批的幂等与报错 / 画布变更后拒绝执行 / 单节点重跑 / 状态汇总 /
//       并发·超时·取消边界 / HTTP 审批路由（随机端口）
//
// ★ 环境隔离：临时数据目录 + 临时库 + 临时配置（placeholder 出图/视频 + mock LLM），
//   绝不触碰真实库 data/factory.db，不发任何真实网络请求，不花一分钱。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-mcp-'));
const DB = path.join(TMP, 'mcp.db');
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

const { migrate, get, all, run, ROOT, SCHEMA_VERSION } = await import('../src/db.js');
const G = await import('../src/graph.js');
const J = await import('../src/jobs.js');
const T = await import('../src/mcp-tools.js');
const S = await import('../src/mcp-server.js');
const { createApp, createServer } = await import('../src/http.js');

migrate();
const firstSchema = T.ensureMcpSchema();

// ---- 结算助手（与其它测试同格式） ----
let pass = 0, fail = 0;
const ok = (name, cond, evidence = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${evidence ? `  ← ${evidence}` : ''}`); }
  else { fail++; console.error(`  ✗ ${name}  ← ${evidence}`); }
};
const eq = (name, actual, expected) => ok(name, actual === expected, `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`);
const contains = (name, actual, needle) => ok(name, String(actual ?? '').includes(needle), `实际=${JSON.stringify(String(actual ?? '').slice(0, 160))} 需含=${JSON.stringify(needle)}`);
const notContains = (name, actual, needle) => ok(name, !String(actual ?? '').includes(needle), `不应包含 ${JSON.stringify(needle)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 15000, step = 25) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(step); }
  return false;
};
/** 调用工具并捕获中文错误：{ok, out, msg} */
const call = async (name, args = {}, ctx = {}) => {
  try { return { ok: true, out: await T.callTool(name, args, ctx) }; }
  catch (e) { return { ok: false, msg: String(e?.message || e), out: null }; }
};
/** 走完整的 JSON-RPC 层调用工具（与真实 MCP 客户端同路径） */
const rpc = async (method, params, id = 1) => S.handleMessage({ jsonrpc: '2.0', id, method, params });
const rpcText = (res) => res?.result?.content?.[0]?.text ?? '';
const rpcJson = (res) => { try { return JSON.parse(rpcText(res)); } catch { return null; } };

// ---- 造数据助手 ----
let seq = 0;
const mkCanvas = (id, name = id) => {
  run(`INSERT OR REPLACE INTO canvases(id, name, cols, rows, cell_size, layout, created_at, updated_at) VALUES(?,?,5,4,200,'{}',?,?)`,
    id, name, new Date().toISOString(), new Date().toISOString());
  return id;
};
const nodeCols = new Set(all('PRAGMA table_info(canvas_nodes)').map((c) => c.name));
const mkNode = ({ id = null, kind = 'text', title = '', data = {}, canvasId = 'CV-MAIN' } = {}) => {
  const nid = id || `ND-${String(++seq).padStart(3, '0')}`;
  run(`INSERT INTO canvas_nodes(id, canvas_id, actor_id, x, y, w, h, z, locked, note, group_id, kind, color, title, data)
       VALUES(?,?,'',0,0,180,220,0,0,'',NULL,?,NULL,?,?)`,
    nid, canvasId, kind, title || nid, JSON.stringify(data));
  return nid;
};
const linkCols = new Set(all('PRAGMA table_info(canvas_links)').map((c) => c.name));
const mkLink = ({ from, to, fromPort = 'image', toPort = null, slot = null, canvasId = 'CV-MAIN', label = '' } = {}) => {
  const lid = `LK-${(++seq).toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const cols = ['id', 'canvas_id', 'from_actor', 'to_actor', 'label', 'color', 'created_at', 'from_node', 'to_node', 'from_side', 'to_side'];
  const vals = [lid, canvasId, '', '', label, null, new Date().toISOString(), from, to, 'right', 'left'];
  if (linkCols.has('from_port')) { cols.push('from_port'); vals.push(fromPort); }
  if (linkCols.has('to_port')) { cols.push('to_port'); vals.push(toPort); }
  if (linkCols.has('slot')) { cols.push('slot'); vals.push(slot ?? 0); }
  run(`INSERT INTO canvas_links(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`, ...vals);
  return lid;
};
/** 记录式 stub 执行器：完全离线，绝不触真实后端（只走 executors.default） */
const mkExec = ({ byNode = {}, delay = 0 } = {}) => {
  const calls = [];
  const executors = {
    default: async (req) => {
      calls.push({ kind: req.kind, nodeId: req.node.id, jobId: req.jobId, canvasId: req.canvasId });
      if (delay) await sleep(delay);
      const spec = byNode[req.node.id];
      if (typeof spec === 'function') return await spec(req, calls.length);
      if (spec) return { ...spec };
      return { filePath: `data/stub/${req.node.id}.bin`, mime: 'application/octet-stream', backend: 'stub', model: 'stub-1', elapsedMs: 1, placeholder: true, raw: { stub: true } };
    },
  };
  return { executors, calls, count: () => calls.length };
};
const runsAll = () => all('SELECT * FROM canvas_node_runs ORDER BY created_at ASC, rowid ASC');
const planRow = (id) => get('SELECT * FROM canvas_plans WHERE id = ?', id);
const auditsOf = (id) => all('SELECT * FROM canvas_plan_audits WHERE plan_id = ? ORDER BY created_at ASC, rowid ASC', id);
const jobOf = (id) => J.getJob(id);

// ============================ 画布夹具 ============================
// CV-MAIN：text → image(L) → video(H) → output，另有 1 个 note（不参与执行）与 1 个 scene（资产）
console.log(`\n=== 0. 环境与幂等建表（临时库 + canvas_plans/canvas_plan_audits） ===`);
console.log(`      临时库：${DB}`);
console.log(`      临时数据目录：${DATA_TMP}`);
ok('未触碰真实库 data/factory.db', path.resolve(String(process.env.FACTORY_DB)) !== path.resolve(ROOT, 'data', 'factory.db'), `FACTORY_DB=${process.env.FACTORY_DB}`);
mkCanvas('CV-MAIN', 'P4 测试主画布');
const N_TEXT = mkNode({ id: 'ND-TEXT', kind: 'text', title: '提示词便签', data: { prompt: '深夜码头，雾气弥漫', cost_level: 'L' } });
const N_IMG = mkNode({ id: 'ND-IMG', kind: 'image', title: '关键帧', data: { prompt: '关键帧：黑猫', cost_level: 'L', backend: 'placeholder' } });
const N_VID = mkNode({ id: 'ND-VID', kind: 'video', title: '镜头A', data: { prompt: '黑猫走过栈桥', cost_level: 'H', backend: 'placeholder' } });
const N_OUT = mkNode({ id: 'ND-OUT', kind: 'output', title: '成片输出', data: {} });
const N_NOTE = mkNode({ id: 'ND-NOTE', kind: 'note', title: '备注便签', data: {} });
const N_SCENE = mkNode({ id: 'ND-SCENE', kind: 'scene', title: '深夜码头', data: { timeOfDay: '深夜', weather: '浓雾', desc: '栈桥与仓库' } });
const L1 = mkLink({ from: N_TEXT, to: N_IMG, fromPort: 'text', toPort: 'in' });
const L2 = mkLink({ from: N_IMG, to: N_VID, fromPort: 'image', toPort: 'first' });
const L3 = mkLink({ from: N_VID, to: N_OUT, fromPort: 'clip', toPort: 'in' });
ok('夹具画布就绪（6 节点 / 3 连线）', all('SELECT id FROM canvas_nodes WHERE canvas_id = ?', 'CV-MAIN').length === 6 && all('SELECT id FROM canvas_links WHERE canvas_id = ?', 'CV-MAIN').length === 3);
ok('ensureMcpSchema() 首次返回 true', firstSchema === true);
eq('ensureMcpSchema() 幂等（第二次返回 false）', T.ensureMcpSchema(), false);
const planCols = all('PRAGMA table_info(canvas_plans)').map((c) => c.name);
ok('canvas_plans 规格书列齐备（含 confirm_code / approved_at / consumed_at / expires_at）', ['id', 'canvas_id', 'plan', 'status', 'confirm_code', 'created_by', 'approved_at', 'consumed_at', 'expires_at', 'created_at'].every((c) => planCols.includes(c)), planCols.join(','));
ok('canvas_plans 増补列齐备（成本级/预估/审批人/任务号）', ['cost_level', 'estimate', 'payload', 'approved_by', 'reject_reason', 'job_id', 'node_count'].every((c) => planCols.includes(c)));
const idxNames = all("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='canvas_plans'").map((r) => r.name);
ok('idx_canvas_plans 索引已建', idxNames.includes('idx_canvas_plans'), idxNames.join(','));
const auditCols = all('PRAGMA table_info(canvas_plan_audits)').map((c) => c.name);
ok('canvas_plan_audits 表结构齐备（审批记录可落库可查）', ['id', 'plan_id', 'action', 'actor', 'detail', 'created_at'].every((c) => auditCols.includes(c)), auditCols.join(','));
eq('migrate() 后 schema_version = SCHEMA_VERSION（本次未改 db.js）', Number(get("SELECT value FROM meta_kv WHERE key='schema_version'").value), SCHEMA_VERSION);

// ============================ 1. 工具清单与参数校验 ============================
console.log('\n=== 1. 工具清单与参数校验（中文报错） ===');
const cat = T.toolCatalog();
ok(`工具数 ≥ 20（实际 ${cat.length}）`, cat.length >= 20);
eq('工具名唯一', new Set(T.TOOLS.map((t) => t.name)).size, T.TOOLS.length);
ok('工具命名空间统一（canvas_* / job_* / studio_* / skills_* / render_*）',
  T.TOOLS.every((t) => /^(canvas|job|studio|skills|skill|render)_/.test(t.name)),
  T.TOOLS.map((t) => t.name).filter((n) => !/^(canvas|job|studio|skills|skill|render)_/.test(n)).join(',') || '全部合规');
ok('每个工具都有中文 description', T.TOOLS.every((t) => typeof t.description === 'string' && t.description.length > 8 && /[\u4e00-\u9fff]/.test(t.description)));
ok('tools/list 目录不含 handler 字段', cat.every((t) => !('handler' in t)), cat.some((t) => 'handler' in t) ? '存在泄漏' : '无泄漏');
ok('每个工具 inputSchema.type === "object"', cat.every((t) => t.inputSchema?.type === 'object'));
ok('花钱工具恰好是 canvas_run / canvas_run_node / studio_resume（制片放行仍要确认码）',
  T.toolsSummary().paying.sort().join(',') === 'canvas_run,canvas_run_node,studio_resume', T.toolsSummary().paying.join(','));
ok('技能工具在目录里（skills_list / skill_run）',
  ['skills_list', 'skill_run'].every((n) => T.TOOLS.some((x) => x.name === n)),
  T.TOOLS.filter((x) => /^skills?_/.test(x.name)).map((x) => x.name).join(','));
ok('制片 Agent 的 5 个工具都在目录里',
  ['studio_create', 'studio_status', 'studio_run', 'studio_run_stage', 'studio_resume'].every((n) => T.TOOLS.some((t) => t.name === n)),
  T.TOOLS.filter((t) => t.name.startsWith('studio_')).map((t) => t.name).join(','));
ok('studio_resume 标注为会花钱并需要确认码（Agent 不能自行放行）',
  T.TOOLS.find((t) => t.name === 'studio_resume')?.cost === true
  && T.TOOLS.find((t) => t.name === 'studio_resume')?.inputSchema?.required?.includes('confirm_code'), 'ok');
ok('闸门工具清单包含 canvas_run 与 canvas_run_node', T.toolsSummary().gated.includes('canvas_run') && T.toolsSummary().gated.includes('canvas_run_node'));
ok('只读工具不花钱（level=read ⇒ cost=false）', T.TOOLS.filter((t) => t.level === 'read').every((t) => t.cost === false));
const unknown = await call('canvas_not_exist', {});
ok('未知工具 → 中文报错', unknown.ok === false && unknown.msg.includes('未知工具'), unknown.msg);
const missPlan = await call('canvas_run', { confirm_code: '123456' });
contains('canvas_run 缺 plan_id → 缺少必填参数', missPlan.msg, '缺少必填参数 plan_id');
const missCode = await call('canvas_run', { plan_id: 'PL-X' });
contains('canvas_run 缺 confirm_code → 缺少必填参数', missCode.msg, '缺少必填参数 confirm_code');
const missNode = await call('canvas_run_node', { plan_id: 'PL-X', confirm_code: '1' });
contains('canvas_run_node 缺 node_id → 缺少必填参数', missNode.msg, '缺少必填参数 node_id');
const missShot = await call('canvas_refs_for_shot', {});
contains('canvas_refs_for_shot 缺 shot → 中文报错', missShot.msg, '缺少必填参数 shot');
const missScript = await call('canvas_bind_script', {});
contains('canvas_bind_script 缺 script_id → 中文报错', missScript.msg, '缺少必填参数 script_id');
const badType = await call('canvas_node_runs', { limit: 'abc' });
contains('类型不符 → 中文类型报错', badType.msg, '类型应为 数字');
const badKind = await call('canvas_node_create', { kind: '不存在类型' });
contains('未知节点类型 → 中文报错并列出可用类型', badKind.msg, '未知节点类型');
const extraArg = await call('canvas_list_nodes', { canvas_id: 'CV-MAIN', 无关参数: 1 });
ok('未声明的多余参数被忽略（不报错）', extraArg.ok === true && extraArg.out.count === 6, `count=${extraArg.out?.count}`);
const arrayArgs = await T.callTool('canvas_list_nodes', [1, 2]).catch((e) => e.message);
contains('参数传数组 → 中文报错', arrayArgs, '必须是对象');
const notFoundNode = await call('canvas_node_delete', { node_id: 'ND-没有这个' });
contains('删除不存在的节点 → 中文报错', notFoundNode.msg, '节点不存在');
const notFoundLink = await call('canvas_link_delete', { link_id: 'LK-没有这个' });
contains('删除不存在的连线 → 中文报错', notFoundLink.msg, '连线不存在');

// ============================ 2. MCP 协议层 ============================
console.log('\n=== 2. MCP 协议层（零依赖 stdio JSON-RPC） ===');
const init = await rpc('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '0' } });
eq('initialize.protocolVersion 回显客户端版本', init.result?.protocolVersion, '2024-11-05');
ok('initialize.capabilities.tools 已声明', !!init.result?.capabilities?.tools, JSON.stringify(init.result?.capabilities));
eq('initialize.serverInfo.name 正确', init.result?.serverInfo?.name, 'ai-video-factory-canvas');
ok('capabilities 不承诺 resources/prompts/sampling', !init.result.capabilities.resources && !init.result.capabilities.prompts && !init.result.capabilities.sampling, JSON.stringify(Object.keys(init.result.capabilities)));
const init2 = await rpc('initialize', { protocolVersion: '2025-06-18' });
eq('新协议版本协商成功（按客户端版本回显）', init2.result?.protocolVersion, '2025-06-18');
const init3 = await rpc('initialize', { protocolVersion: '1999-01-01' });
eq('未列入白名单的版本回落到默认版本', init3.result?.protocolVersion, S.PROTOCOL_VERSION);
eq('通知（无 id）不产生响应', await S.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
eq('notifications/cancelled 同样不响应', await S.handleMessage({ jsonrpc: '2.0', method: 'notifications/cancelled', params: {} }), null);
const pong = await rpc('ping', {});
eq('ping 返回空结果对象', JSON.stringify(pong.result), '{}');
const unknownMethod = await rpc('canvas/不存在的发方法', {});
eq('未知方法 → -32601', unknownMethod.error?.code, -32601);
contains('未知方法报错含方法名（中文可读）', unknownMethod.error?.message, '不支持的方法');
const resList = await rpc('resources/list', {});
eq('未声明能力的方法（resources/list）→ -32601', resList.error?.code, -32601);
const noMethod = await S.handleMessage({ jsonrpc: '2.0', id: 7 });
eq('缺少 method → -32600', noMethod.error?.code, -32600);
const batch = await S.handleMessage([{ jsonrpc: '2.0', id: 1, method: 'ping' }]);
eq('批量请求 → -32600（明确不支持）', batch.error?.code, -32600);
const toolsList = await rpc('tools/list', {});
eq('tools/list 工具数与目录一致', toolsList.result?.tools?.length, cat.length);
ok('tools/list 不含 handler（内部函数不外泄）', toolsList.result.tools.every((t) => !('handler' in t)));
ok('tools/list 每个 inputSchema.type=object', toolsList.result.tools.every((t) => t.inputSchema?.type === 'object'));
ok('tools/list 带 MCP annotations（readOnlyHint 等）', toolsList.result.tools.every((t) => t.annotations && typeof t.annotations.readOnlyHint === 'boolean'));
const callNoName = await rpc('tools/call', {});
eq('tools/call 缺 name → -32602', callNoName.error?.code, -32602);
const callUnknown = await rpc('tools/call', { name: 'canvas_不存在' });
eq('tools/call 未知工具 → -32602', callUnknown.error?.code, -32602);
contains('未知工具协议错误含中文原因', callUnknown.error?.message, '未知工具');
const callBadArgs = await rpc('tools/call', { name: 'canvas_run', arguments: { plan_id: 'PL-X' } });
eq('工具内部抛错 → 作为工具结果返回 isError', callBadArgs.result?.isError, true);
contains('isError 文本是中文可读原因（非协议层错误）', rpcText(callBadArgs), '缺少必填参数');
ok('isError 响应仍是合法 JSON-RPC 结果', callBadArgs.jsonrpc === '2.0' && callBadArgs.id === 1 && !callBadArgs.error);
const callOk = await rpc('tools/call', { name: 'canvas_list_nodes', arguments: { canvas_id: 'CV-MAIN' } }, 42);
eq('正常 tools/call 回显 id', callOk.id, 42);
eq('正常 tools/call content[0].type = text', callOk.result?.content?.[0]?.type, 'text');
ok('正常 tools/call 文本是合法 JSON', rpcJson(callOk)?.count === 6, rpcText(callOk).slice(0, 80));
const lineBad = await S.handleLine('这不是 JSON');
eq('stdio 非法行 → parseError（不崩、不写 stdout）', lineBad?.parseError, true);
eq('stdio 空行 → null', await S.handleLine('   '), null);
const lineGood = await S.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping' }));
eq('stdio 合法行 → 应答帧', lineGood?.res?.id, 9);

// ============================ 3. 只读工具与真实数据一致 ============================
console.log('\n=== 3. 只读工具：返回结构与真实数据一致 ===');
const listNodes = (await call('canvas_list_nodes', {})).out;
eq('canvas_list_nodes 节点数与库一致', listNodes.count, 6);
eq('canvas_list_nodes 能按 title 找到节点 id', listNodes.nodes.find((n) => n.title === '关键帧')?.id, N_IMG);
ok('canvas_list_nodes 含 kind/status 字段', listNodes.nodes.every((n) => typeof n.kind === 'string' && typeof n.status === 'string'));
const graph = (await call('canvas_get_graph', {})).out;
eq('canvas_get_graph 连线数与库一致', graph.links.length, 3);
const l2 = graph.links.find((l) => l.id === L2);
ok('canvas_get_graph 带 P2 类型化端口', l2.from_port === 'image' && l2.to_port === 'first' && l2.slot === 0, JSON.stringify(l2));
const sc = await call('canvas_status', {});
eq('canvas_status counts.total 与库一致', sc.out.counts.total, 6);
eq('canvas_status 可执行节点数（text/image/video/output）', sc.out.counts.executable, 4);
ok('canvas_status 每个节点带 status/file/error 字段', sc.out.nodes.every((n) => 'status' in n && 'file' in n && 'error' in n));
eq('canvas_status 未知画布 → total 0', (await call('canvas_status', { canvas_id: 'CV-没有这个' })).out.counts.total, 0);
const pack = (await call('canvas_asset_pack', {})).out;
eq('canvas_asset_pack canvasId 一致', pack.canvasId, 'CV-MAIN');
eq('canvas_asset_pack 读到画布上的环境节点（复用模块3）', pack.scenes.length, 1);
eq('canvas_asset_pack 环境标题正确', pack.scenes[0].title, '深夜码头');
const refs = (await call('canvas_refs_for_shot', { shot: { action: '黑猫走过栈桥，浓雾', dialogue: '' }, location_id: N_SCENE, canvas_id: 'CV-MAIN' })).out;
eq('canvas_refs_for_shot 命中画布环境节点', refs.sceneNodeId, N_SCENE);
ok('canvas_refs_for_shot 返回结构完整（含 refImages 数组）', Array.isArray(refs.refImages) && Array.isArray(refs.itemNodeIds));
const exportMd = (await call('canvas_export_assets', { format: 'md' })).out;
ok('canvas_export_assets 返回 md 文件与正文', /\.md$/.test(exportMd.filename) && exportMd.content.includes('# 画布资产清单'), exportMd.filename);
// 跨镜一致性（LibTV 调研第 3 条）：新工具是只读、不花钱，且在空库上诚实返回「没有可比关键帧」
const consMissing = await call('render_consistency_score', {});
ok('consistency_score 缺参数 → 中文报错（至少要给集号）', consMissing.ok === false && /缺少 script_id 或 code/.test(consMissing.msg), consMissing.msg);
const consOut = (await call('render_consistency_score', { code: 'S01E404' })).out;
ok('consistency_score 可调用且不花钱（只读级，人读结论在 summary_text）',
  Boolean(consOut) && /一致性评分/.test(String(consOut.summary_text || '')), String(consOut?.summary_text || '').slice(0, 80));
ok('consistency_score 返回口径透明（方法/阈值/分组/数值统计）',
  typeof consOut.method === 'string' && typeof consOut.threshold === 'number' && Array.isArray(consOut.groups) && Boolean(consOut.summary),
  JSON.stringify(consOut.summary));
eq('consistency_score 没有关键帧时不编造离群（outliers=0）', consOut.outliers.length, 0);
// 专业后期导出（时间线/字幕多格式）：新工具只读、不花钱，且对「没有镜头视频」给中文原因
const icBad = await call('render_interchange', { script_id: 'SC-没有这个', code: 'S01E001' });
ok('render_interchange 对不存在的剧本给中文原因（不抛未处理异常）',
  icBad.ok === false && icBad.msg.length > 4, icBad.msg.slice(0, 80));
ok('render_interchange 在工具目录里是只读、不花钱',
  T.TOOLS.find((x) => x.name === 'render_interchange')?.level === 'read'
  && T.TOOLS.find((x) => x.name === 'render_interchange')?.cost === false);
// 响度测量（专业交付）：只读、不花钱，没有成片时给中文原因
const loudBad = await call('render_loudness', { script_id: 'SC-没有这个', code: 'S01E001' });
ok('render_loudness 对没有成片的剧集给中文原因',
  loudBad.ok === false && /还没有成片|不存在/.test(loudBad.msg), loudBad.msg.slice(0, 70));
ok('render_loudness 是只读、不花钱的工具',
  T.TOOLS.find((x) => x.name === 'render_loudness')?.level === 'read'
  && T.TOOLS.find((x) => x.name === 'render_loudness')?.cost === false);
// 多平台版本规划（只读）：平台规格表 + 无成片时的中文原因
const varBad = await call('render_variants', { script_id: 'SC-没有这个', code: 'S01E001' });
ok('render_variants 对没有成片的剧集给中文原因', varBad.ok === false && /还没有成片/.test(varBad.msg), varBad.msg.slice(0, 60));
ok('render_variants 是只读工具且带平台规格表',
  T.TOOLS.find((x) => x.name === 'render_variants')?.level === 'read'
  && T.TOOLS.find((x) => x.name === 'render_variants')?.cost === false);
// 画布快照（版本化工作现场）：三个工具都在，且保存/回滚都不花钱
ok('画布快照三件套存在（canvas_snapshot_save / canvas_snapshots / canvas_snapshot_restore）',
  ['canvas_snapshot_save', 'canvas_snapshots', 'canvas_snapshot_restore'].every((n) => T.TOOLS.some((x) => x.name === n)));
mkCanvas('CV-SNAPMCP', 'MCP 快照画布');
run(`INSERT INTO canvas_nodes(id, canvas_id, actor_id, x, y, w, h, z, kind, title, data) VALUES('ND-SNAPMCP','CV-SNAPMCP','',0,0,220,180,0,'video','片段',?)`, JSON.stringify({ prompt: 'x', duration: 2 }));
const snapSave = await call('canvas_snapshot_save', { canvas_id: 'CV-SNAPMCP', name: 'MCP 快照' });
ok('canvas_snapshot_save 能保存快照（返回计数）', snapSave.ok === true && snapSave.out.snapshot?.nodes >= 1,
  JSON.stringify(snapSave.out?.snapshot || snapSave.msg).slice(0, 110));
const snapListMcp = await call('canvas_snapshots', { canvas_id: 'CV-SNAPMCP' });
ok('canvas_snapshots 能列出并带差异（diff_id 可选）',
  snapListMcp.ok === true && snapListMcp.out.count >= 1
  && (await call('canvas_snapshots', { canvas_id: 'CV-SNAPMCP', diff_id: snapSave.out.snapshot.id })).out.diff?.same !== undefined,
  `count=${snapListMcp.out?.count}`);
const snapBad = await call('canvas_snapshot_restore', { snapshot_id: 'SN-不存在' });
ok('canvas_snapshot_restore 对不存在的快照给中文原因', snapBad.ok === false && /快照不存在/.test(snapBad.msg), snapBad.msg);
// Agent 决策时间线（只读）
const tlBad = await call('studio_timeline', {});
ok('studio_timeline 无参数 → 中文报错（不知道该摊开谁）', tlBad.ok === false && /缺少 production_id 或 canvas_id/.test(tlBad.msg), tlBad.msg);
ok('studio_timeline 是只读、不花钱的工具',
  T.TOOLS.find((x) => x.name === 'studio_timeline')?.level === 'read'
  && T.TOOLS.find((x) => x.name === 'studio_timeline')?.cost === false);
const tlMissing = await call('studio_timeline', { production_id: 'PR-没有这个' });
ok('studio_timeline 对不存在的项目给中文原因', tlMissing.ok === false && /不存在/.test(tlMissing.msg), tlMissing.msg);
eq('canvas_script_list 空库返回空数组', (await call('canvas_script_list', {})).out.length, 0);
const shots = (await call('canvas_script_shots', { script_id: 'SC-没有这个' })).out;
ok('canvas_script_shots 无剧本返回空 + 成本级全 0', shots.count === 0 && shots.cost_levels.L === 0 && shots.cost_levels.H === 0, JSON.stringify(shots.cost_levels));
ok('job_status 无 job_id 时返回任务数组', Array.isArray((await call('job_status', {})).out));
ok('canvas_node_runs 返回数组（初始为空）', Array.isArray((await call('canvas_node_runs', {})).out) && (await call('canvas_node_runs', {})).out.length === 0);

// ============================ 4. dry-run 计划 ============================
console.log('\n=== 4. dry-run 计划：与 planGraph 一致、含成本级、绝不花钱 ===');
const spy0 = mkExec();
const planCall = await call('canvas_plan', { canvas_id: 'CV-MAIN' }, { executors: spy0.executors });
const P1 = planCall.out;
ok('canvas_plan 返回 plan_id（PL-xxx）', /^PL-/.test(P1.plan_id || ''), P1.plan_id);
ok('canvas_plan 返回 estimate 调用数预估', P1.estimate && typeof P1.estimate.totalCalls === 'number', JSON.stringify(P1.estimate));
eq('estimate.videoCalls = 1（1 个视频节点）', P1.estimate.videoCalls, 1);
eq('estimate.imageCalls = 1', P1.estimate.imageCalls, 1);
eq('estimate.totalCalls = 4（text+image+video+output）', P1.estimate.totalCalls, 4);
eq('cost_level = H（视频节点标了 H 级）', P1.cost_level, 'H');
ok('cost 视图含分档计数与理由', P1.cost.by_level.H === 1 && /H 级/.test(P1.cost.cost_level_reason), P1.cost.cost_level_reason);
ok('cost 视图含预算闸门信息（复用 guard.js）', P1.cost.budget && typeof P1.cost.budget.reason === 'string');
const realCode1 = String(planRow(P1.plan_id).confirm_code);
ok('★ 计划响应不含 confirm_code 字段（闸门核心）', !('confirm_code' in P1), Object.keys(P1).join(','));
notContains('★ 计划响应中不含真实确认码', JSON.stringify(P1), realCode1);
ok('★ 计划响应只给掩码确认码', /^[0-9]\*+[0-9]$/.test(String(P1.confirm_code_masked || '')), P1.confirm_code_masked);
const planGraphDirect = G.planGraph({ canvasId: 'CV-MAIN', nodeIds: null, overwrite: false });
eq('★ 计划 steps 与 planGraph 逐字一致', JSON.stringify(T.safeJSON(planRow(P1.plan_id).plan).steps), JSON.stringify(planGraphDirect.steps));
eq('计划落库 status = pending', planRow(P1.plan_id).status, 'pending');
ok('确认码已落库（仅进程内可见，日志可见）', /^\d{6}$/.test(String(planRow(P1.plan_id).confirm_code)), '掩码=' + T.maskCode(planRow(P1.plan_id).confirm_code));
eq('计划落库 cost_level = H', planRow(P1.plan_id).cost_level, 'H');
eq('计划落库 node_count = 4', planRow(P1.plan_id).node_count, 4);
eq('★ 干跑不产生任何执行器调用', spy0.count(), 0);
eq('★ 干跑不产生 canvas_node_runs 记录', runsAll().length, 0);
eq('干跑后任务队列里没有 graph 任务', J.listJobs({ type: 'graph' }).length, 0);
ok('审计已记录 created', auditsOf(P1.plan_id).some((a) => a.action === 'created'));
const planStatus = (await call('canvas_plan_status', { plan_id: P1.plan_id })).out;
eq('canvas_plan_status 反映 pending 状态', planStatus.status, 'pending');
ok('canvas_plan_status 只给掩码确认码', /^[0-9]\*+[0-9]$/.test(planStatus.confirm_code_masked) && !('confirm_code' in planStatus), planStatus.confirm_code_masked);
const planList = (await call('canvas_plan_list', {})).out;
ok('canvas_plan_list 列出待审批计划且不含完整确认码', planList.some((p) => p.plan_id === P1.plan_id) && !JSON.stringify(planList).includes(planRow(P1.plan_id).confirm_code));
const noPlanStatus = await call('canvas_plan_status', { plan_id: 'PL-没有这个' });
contains('查询不存在的计划 → 中文报错', noPlanStatus.msg, '计划不存在');
// 成本级口径（纯函数，覆盖 L/M/H 三档）
const costL = T.aggregateCostLevel({ steps: [{ id: 'a', kind: 'text' }], estimate: { videoCalls: 0, totalCalls: 1 } });
const costM = T.aggregateCostLevel({ steps: [{ id: 'a', kind: 'video' }], estimate: { videoCalls: 1, totalCalls: 1 } });
const costM6 = T.aggregateCostLevel({ steps: Array.from({ length: 6 }, (_, i) => ({ id: `n${i}`, kind: 'image' })), estimate: { videoCalls: 0, totalCalls: 6 } });
const costH8 = T.aggregateCostLevel({ steps: Array.from({ length: 8 }, (_, i) => ({ id: `v${i}`, kind: 'video' })), estimate: { videoCalls: 8, totalCalls: 8 } });
eq('成本级口径：纯文本 → L', costL.level, 'L');
eq('成本级口径：含视频 → M', costM.level, 'M');
eq('成本级口径：6 个待执行节点 → M', costM6.level, 'M');
eq('成本级口径：8 次视频调用 → H', costH8.level, 'H');
eq('节点成本级优先读 data.cost_level', T.costLevelOfNode({ kind: 'video', data: JSON.stringify({ cost_level: 'h' }) }).level, 'H');
eq('无 cost_level 时按类型兜底（video → M）', T.costLevelOfNode({ kind: 'video', data: '{}' }).level, 'M');
// 环检测与空画布
mkCanvas('CV-CYCLE');
const C1 = mkNode({ kind: 'image', title: '环1', canvasId: 'CV-CYCLE', data: {} });
const C2 = mkNode({ kind: 'video', title: '环2', canvasId: 'CV-CYCLE', data: {} });
mkLink({ from: C1, to: C2, canvasId: 'CV-CYCLE' });
mkLink({ from: C2, to: C1, canvasId: 'CV-CYCLE' });
const cycle = await call('canvas_plan', { canvas_id: 'CV-CYCLE' });
ok('有环画布 → 中文报错「环形依赖」', cycle.ok === false && cycle.msg.includes('环形依赖'), cycle.msg);
mkCanvas('CV-EMPTY');
const empty = await call('canvas_plan', { canvas_id: 'CV-EMPTY' });
ok('空画布 → 中文报错', empty.ok === false && empty.msg.includes('没有可执行的节点'), empty.msg);
const planOne = (await call('canvas_plan', { canvas_id: 'CV-MAIN', node_ids: [N_VID] })).out;
eq('canvas_plan 指定 node_ids 只计划该节点', planOne.plan.steps.run.length, 1);
eq('单节点计划 estimate.videoCalls = 1', planOne.estimate.videoCalls, 1);
eq('单节点计划 cost_level = H（该节点 H 级）', planOne.cost_level, 'H');
const realCodeOne = String(planRow(planOne.plan_id).confirm_code);
ok('单节点计划响应同样不含 confirm_code 字段', !('confirm_code' in planOne));
notContains('单节点计划响应不含真实确认码', JSON.stringify(planOne), realCodeOne);
// ============================ 5. ★ 未审批不得执行 ============================
console.log('\n=== 5. ★ 闸门：未审批不得执行（执行器零调用反证） ===');
const spy1 = mkExec();
const code1 = planRow(P1.plan_id).confirm_code;
const runUnapproved = await call('canvas_run', { plan_id: P1.plan_id, confirm_code: code1 }, { executors: spy1.executors });
ok('未审批 + 正确确认码 → 拒绝执行', runUnapproved.ok === false, runUnapproved.msg);
contains('拒绝原因中文可读（提示需人工审批）', runUnapproved.msg, '尚未经人工审批');
eq('★ 未审批执行器零调用', spy1.count(), 0);
eq('★ 未审批不产生 canvas_node_runs', runsAll().length, 0);
eq('★ 未审批不产生任何 graph 任务', J.listJobs({ type: 'graph' }).length, 0);
eq('未审批时计划仍是 pending（未被消费）', planRow(P1.plan_id).status, 'pending');
ok('审计记录了被拒绝的执行尝试（run_denied）', auditsOf(P1.plan_id).some((a) => a.action === 'run_denied'), auditsOf(P1.plan_id).map((a) => a.action).join(','));
const runUnapprovedWrongCode = await call('canvas_run', { plan_id: P1.plan_id, confirm_code: '000000' }, { executors: spy1.executors });
contains('未审批 + 错码 → 仍先报「未审批」（审批关优先于确认码关）', runUnapprovedWrongCode.msg, '尚未经人工审批');
eq('★ 依然零调用', spy1.count(), 0);
const nodeUnapproved = await call('canvas_run_node', { node_id: N_VID, plan_id: planOne.plan_id, confirm_code: planRow(planOne.plan_id).confirm_code }, { executors: spy1.executors });
contains('单节点重跑未审批 → 同样被拦住', nodeUnapproved.msg, '尚未经人工审批');
eq('★ 单节点重跑未审批零调用', spy1.count(), 0);

// ============================ 6. 审批 → 执行成功 ============================
console.log('\n=== 6. 人工审批 → 执行成功（审批记录落库可查） ===');
const approveNoConfirm = await call('canvas_run', { plan_id: P1.plan_id, confirm_code: code1 });
ok('（前置）未审批仍拒绝', approveNoConfirm.ok === false);
const apDenied = (() => { try { T.approvePlan(P1.plan_id, { by: '测试人', confirm: false }); return null; } catch (e) { return String(e.message); } })();
contains('审批未显式 confirm=true → 中文报错', apDenied, '需显式 confirm=true');
eq('拒绝误点后计划仍为 pending', planRow(P1.plan_id).status, 'pending');
const ap = T.approvePlan(P1.plan_id, { by: '测试人', confirm: true });
eq('审批成功 → status=approved', ap.status, 'approved');
eq('审批人落库', planRow(P1.plan_id).approved_by, '测试人');
ok('approved_at 落库', !!planRow(P1.plan_id).approved_at, planRow(P1.plan_id).approved_at);
ok('审批记录可查询（audits 含 approved）', auditsOf(P1.plan_id).some((a) => a.action === 'approved' && a.actor === '测试人'));
ok('审批审计含被拒绝的尝试（approve_denied）', auditsOf(P1.plan_id).some((a) => a.action === 'approve_denied'));
const spy2 = mkExec();
const runOk = await call('canvas_run', { plan_id: P1.plan_id, confirm_code: code1 }, { executors: spy2.executors });
ok('审批 + 正确确认码 → 执行成功', runOk.ok === true, JSON.stringify(runOk.out || runOk.msg));
ok('返回 job_id 与节点总数', /^JOB-/.test(runOk.out?.job_id || '') && runOk.out.total === 4, `job=${runOk.out?.job_id} total=${runOk.out?.total}`);
eq('执行后计划状态 = consumed', planRow(P1.plan_id).status, 'consumed');
eq('计划回写 job_id', planRow(P1.plan_id).job_id, runOk.out.job_id);
ok('执行器被真实调用（4 个可执行节点）', await waitFor(() => spy2.count() >= 4), `调用 ${spy2.count()} 次`);
ok('任务执行完成（status=done）', await waitFor(() => jobOf(runOk.out.job_id)?.status === 'done'), `status=${jobOf(runOk.out.job_id)?.status}`);
eq('任务 done 计数 = 4', jobOf(runOk.out.job_id)?.done, 4);
ok('canvas_node_runs 落 4 条 done 记录', await waitFor(() => runsAll().filter((r) => r.status === 'done').length >= 4), `done=${runsAll().filter((r) => r.status === 'done').length}`);
eq('执行记录 backend 全为注入的 stub（证明零真实调用）', new Set(runsAll().map((r) => r.backend)).size, 1);
eq('执行记录 backend = stub', runsAll().filter((r) => r.status === 'done')[0].backend, 'stub');
const statusAfter = (await call('canvas_status', {})).out;
eq('状态汇总：done 节点数 = 4', statusAfter.counts.done, 4);
ok('状态汇总：节点带产物路径', statusAfter.nodes.filter((n) => n.file).length === 4);
ok('审计记录 consumed（含任务号）', auditsOf(P1.plan_id).some((a) => a.action === 'consumed' && String(a.detail).includes(runOk.out.job_id)));
const runAgain = await call('canvas_run', { plan_id: P1.plan_id, confirm_code: code1 }, { executors: spy2.executors });
contains('同一计划二次执行 → 「已执行过」', runAgain.msg, '已执行过');
eq('二次执行不增加执行器调用', spy2.count(), 4);
const auditHttp = (await call('canvas_node_runs', { node_id: N_VID })).out;
eq('canvas_node_runs 可按节点过滤到执行记录', auditHttp.length, 1);

// ============================ 7. 拒绝后计划失效 ============================
console.log('\n=== 7. 人工拒绝 → 计划失效 ===');
const P2 = (await call('canvas_plan', { canvas_id: 'CV-MAIN', overwrite: true })).out;
const rej = T.approvePlan(P2.plan_id, { by: '测试人', reject: true, reason: '成本级太高，先不跑' });
eq('拒绝成功 → status=rejected', rej.status, 'rejected');
eq('拒绝原因落库', planRow(P2.plan_id).reject_reason, '成本级太高，先不跑');
ok('拒绝审计已记录', auditsOf(P2.plan_id).some((a) => a.action === 'rejected'));
const spy3 = mkExec();
const runRejected = await call('canvas_run', { plan_id: P2.plan_id, confirm_code: planRow(P2.plan_id).confirm_code }, { executors: spy3.executors });
contains('被拒绝的计划执行 → 中文报错「已被人工拒绝」', runRejected.msg, '已被人工拒绝');
contains('报错含拒绝原因', runRejected.msg, '成本级太高');
eq('★ 拒绝的计划零调用', spy3.count(), 0);
eq('拒绝后状态保持 rejected', planRow(P2.plan_id).status, 'rejected');
const rejAgain = (() => { try { T.approvePlan(P2.plan_id, { by: '测试人', reject: true }); return null; } catch (e) { return String(e.message); } })();
contains('重复拒绝 → 中文报错「不可再次审批」', rejAgain, '不可再次审批');

// ============================ 8. 过期 / 重复审批的幂等与报错 ============================
console.log('\n=== 8. 过期与重复审批：幂等与报错 ===');
const P3 = (await call('canvas_plan', { canvas_id: 'CV-MAIN', overwrite: true })).out;
run('UPDATE canvas_plans SET expires_at = ? WHERE id = ?', '2000-01-01T00:00:00.000Z', P3.plan_id);
const expiredApprove = (() => { try { T.approvePlan(P3.plan_id, { by: '测试人', confirm: true }); return null; } catch (e) { return String(e.message); } })();
contains('过期计划审批 → 报错「已过期」', expiredApprove, '已过期');
eq('过期计划状态被翻转为 expired', planRow(P3.plan_id).status, 'expired');
ok('过期审计已记录', auditsOf(P3.plan_id).some((a) => a.action === 'expired'));
const spy4 = mkExec();
const runExpired = await call('canvas_run', { plan_id: P3.plan_id, confirm_code: planRow(P3.plan_id).confirm_code }, { executors: spy4.executors });
contains('过期计划执行 → 报错「已过期」', runExpired.msg, '已过期');
eq('★ 过期计划零调用', spy4.count(), 0);
const expiredApproveAgain = (() => { try { T.approvePlan(P3.plan_id, { by: '测试人', confirm: true }); return null; } catch (e) { return String(e.message); } })();
contains('对 expired 计划再次审批 → 报错（不会复活）', expiredApproveAgain, '不可再次审批');
const P4 = (await call('canvas_plan', { canvas_id: 'CV-MAIN', overwrite: true })).out;
T.approvePlan(P4.plan_id, { by: '测试人', confirm: true });
const firstApprovedAt = planRow(P4.plan_id).approved_at;
const dupApprove = (() => { try { T.approvePlan(P4.plan_id, { by: '另一个人', confirm: true }); return null; } catch (e) { return String(e.message); } })();
contains('重复审批同一计划 → 中文报错「不可再次审批」', dupApprove, '不可再次审批');
eq('重复审批不改状态（幂等：无第二次副作用）', planRow(P4.plan_id).status, 'approved');
eq('重复审批不改 approved_at', planRow(P4.plan_id).approved_at, firstApprovedAt);
eq('重复审批不改审批人', planRow(P4.plan_id).approved_by, '测试人');
ok('重复审批写入了被拒绝的审计（可追溯）', auditsOf(P4.plan_id).filter((a) => a.action === 'approve_denied').length >= 1, `denied=${auditsOf(P4.plan_id).filter((a) => a.action === 'approve_denied').length}`);
// ttl = 0 → 生成即过期
const P5 = (await call('canvas_plan', { canvas_id: 'CV-MAIN', overwrite: true })).out;
run('UPDATE canvas_plans SET expires_at = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), P5.plan_id);
const immediateExpire = await call('canvas_plan_status', { plan_id: P5.plan_id });
ok('刚过期即可被查询到（状态或有效期自洽）', immediateExpire.ok === true);
eq('expirePlans() 能把过期计划翻成 expired 并返回条数', T.expirePlans(), 1);
eq('过期后计划状态 = expired', planRow(P5.plan_id).status, 'expired');
eq('expirePlans() 再次调用返回 0（幂等）', T.expirePlans(), 0);
// 确认码错误（已审批）
const P6 = (await call('canvas_plan', { canvas_id: 'CV-MAIN', overwrite: true })).out;
T.approvePlan(P6.plan_id, { by: '测试人', confirm: true });
const spy5 = mkExec();
const wrongCode = await call('canvas_run', { plan_id: P6.plan_id, confirm_code: '999999' }, { executors: spy5.executors });
contains('确认码错误 → 报错「确认码不正确」', wrongCode.msg, '确认码不正确');
eq('★ 确认码错误零调用', spy5.count(), 0);
eq('确认码错误后计划仍为 approved（未消费，可重试）', planRow(P6.plan_id).status, 'approved');
ok('确认码错误写入 run_denied 审计', auditsOf(P6.plan_id).some((a) => a.action === 'run_denied'));
const emptyCode = await call('canvas_run', { plan_id: P6.plan_id, confirm_code: '   ' }, { executors: spy5.executors });
contains('空白确认码 → 中文报错（必填校验生效）', emptyCode.msg, 'confirm_code');
eq('★ 空白确认码零调用', spy5.count(), 0);

// ============================ 9. 计划期间画布被改动 ============================
console.log('\n=== 9. 计划生成后画布被改动 → 拒绝执行 ===');
const P7 = (await call('canvas_plan', { canvas_id: 'CV-MAIN' })).out;
T.approvePlan(P7.plan_id, { by: '测试人', confirm: true });
const spy6 = mkExec();
const tmpNode = mkNode({ kind: 'image', title: '偷偷加的节点', canvasId: 'CV-MAIN', data: { prompt: 'x' } });
const runChanged = await call('canvas_run', { plan_id: P7.plan_id, confirm_code: planRow(P7.plan_id).confirm_code }, { executors: spy6.executors });
contains('画布变更后执行 → 报错「画布自计划生成后已变更」', runChanged.msg, '已变更');
eq('★ 变更检测阶段仍是零调用', spy6.count(), 0);
eq('计划保持 approved（未消费，可重新 plan）', planRow(P7.plan_id).status, 'approved');
ok('审计记录 canvas_changed', auditsOf(P7.plan_id).some((a) => a.action === 'canvas_changed'));
run('DELETE FROM canvas_nodes WHERE id = ?', tmpNode);
const P7b = (await call('canvas_plan', { canvas_id: 'CV-MAIN', overwrite: true })).out;
T.approvePlan(P7b.plan_id, { by: '测试人', confirm: true });
const spy7 = mkExec();
const runAfterRestore = await call('canvas_run', { plan_id: P7b.plan_id, confirm_code: planRow(P7b.plan_id).confirm_code }, { executors: spy7.executors });
ok('恢复画布后重新 plan → 可正常执行', runAfterRestore.ok === true, runAfterRestore.msg || runAfterRestore.out?.job_id);
await waitFor(() => jobOf(runAfterRestore.out.job_id)?.status === 'done');
ok('复核只在执行前发生，执行本身不受影响', spy7.count() >= 4, `调用 ${spy7.count()} 次`);

// ============================ 10. 单节点重跑 ============================
console.log('\n=== 10. 单节点重跑（只重生成没打中的那一镜） ===');
const onePlan = (await call('canvas_plan', { canvas_id: 'CV-MAIN', node_ids: [N_IMG], overwrite: true })).out;
eq('单节点计划的待执行节点数 = 1', onePlan.plan.steps.run.length, 1);
T.approvePlan(onePlan.plan_id, { by: '测试人', confirm: true });
const spy8 = mkExec();
const rerun = await call('canvas_run_node', { node_id: N_IMG, plan_id: onePlan.plan_id, confirm_code: planRow(onePlan.plan_id).confirm_code }, { executors: spy8.executors });
ok('单节点重跑成功起任务', rerun.ok === true, rerun.msg || rerun.out?.job_id);
eq('单节点任务 total = 1', rerun.out.total, 1);
eq('单节点计划被消费', planRow(onePlan.plan_id).status, 'consumed');
ok('单节点重跑后执行器被调用一次', await waitFor(() => spy8.count() >= 1), `调用 ${spy8.count()} 次`);
ok('单节点任务完成', await waitFor(() => jobOf(rerun.out.job_id)?.status === 'done'), `status=${jobOf(rerun.out.job_id)?.status}`);
const spy9 = mkExec();
const multi = (await call('canvas_plan', { canvas_id: 'CV-MAIN', overwrite: true })).out;
T.approvePlan(multi.plan_id, { by: '测试人', confirm: true });
const wrongScope = await call('canvas_run_node', { node_id: N_IMG, plan_id: multi.plan_id, confirm_code: planRow(multi.plan_id).confirm_code }, { executors: spy9.executors });
contains('用整图计划做单节点重跑 → 报错（提示用单节点重跑计划）', wrongScope.msg, '单节点重跑');
eq('★ 范围校验阶段零调用', spy9.count(), 0);
const noNode = await call('canvas_run_node', { node_id: 'ND-没有这个', plan_id: multi.plan_id, confirm_code: '1' });
contains('重跑不存在的节点 → 中文报错', noNode.msg, '节点不存在');
const scopeMismatch = await call('canvas_run_node', { node_id: N_IMG, plan_id: multi.plan_id, confirm_code: '1', canvas_id: 'CV-别的画布' });
contains('节点与画布不符 → 中文报错', scopeMismatch.msg, '不是 CV-别的画布');

// ============================ 11. 并发 / 超时 / 取消 ============================
console.log('\n=== 11. 并发 / 超时 / 取消边界 ===');
// 11.1 同一计划并发执行：恰好一个赢家
const P8 = (await call('canvas_plan', { canvas_id: 'CV-MAIN', overwrite: true })).out;
T.approvePlan(P8.plan_id, { by: '测试人', confirm: true });
const code8 = planRow(P8.plan_id).confirm_code;
const spy10 = mkExec();
const both = await Promise.all([
  call('canvas_run', { plan_id: P8.plan_id, confirm_code: code8 }, { executors: spy10.executors }),
  call('canvas_run', { plan_id: P8.plan_id, confirm_code: code8 }, { executors: spy10.executors }),
]);
eq('★ 并发执行同一计划：恰好 1 个成功', both.filter((r) => r.ok).length, 1);
ok('失败的那个给出中文原因', /已执行过|状态已变化/.test(both.find((r) => !r.ok)?.msg || ''), both.find((r) => !r.ok)?.msg);
const winner = both.find((r) => r.ok).out;
await waitFor(() => jobOf(winner.job_id)?.status === 'done');
// 11.2 并发协议调用：20 条请求互不串号
const results = await Promise.all(Array.from({ length: 20 }, (_, i) => rpc('tools/call', { name: 'canvas_list_nodes', arguments: {} }, i + 100)));
eq('20 个并发 tools/call 全部有响应', results.filter(Boolean).length, 20);
eq('响应 id 互不重复', new Set(results.map((r) => r.id)).size, 20);
ok('并发响应全部合法（jsonrpc 2.0 且无 protocol error）', results.every((r) => r.jsonrpc === '2.0' && !r.error && rpcJson(r)?.count === 6));
// 11.3 超时类错误不重试（避免重复计费）
const P9 = (await call('canvas_plan', { canvas_id: 'CV-MAIN', node_ids: [N_IMG], overwrite: true })).out;
T.approvePlan(P9.plan_id, { by: '测试人', confirm: true });
const timeoutSpy = mkExec({ byNode: { [N_IMG]: () => Promise.reject(new Error('请求超时（模拟）')) } });
const timeoutRun = await call('canvas_run', { plan_id: P9.plan_id, confirm_code: planRow(P9.plan_id).confirm_code }, { executors: timeoutSpy.executors });
ok('超时场景任务仍能起（闸门不因执行失败回滚）', timeoutRun.ok === true, timeoutRun.msg);
await waitFor(() => ['done', 'error'].includes(jobOf(timeoutRun.out.job_id)?.status));
const timeoutJob = jobOf(timeoutRun.out.job_id);
ok('单节点失败不炸整图：任务正常收尾（done，result.failed=1）', timeoutJob.status === 'done' && timeoutJob.result?.failed === 1, `status=${timeoutJob.status} failed=${timeoutJob.result?.failed}`);
eq('★ 超时错误不重试（执行器只调用 1 次，避免重复计费）', timeoutSpy.count(), 1);
contains('失败原因含超时归类（中文）', timeoutJob.result?.results?.[0]?.error, '超时');
ok('节点状态写回 lastError（状态汇总可见）', (await call('canvas_status', {})).out.nodes.find((n) => n.id === N_IMG)?.error !== null, JSON.stringify((await call('canvas_status', {})).out.nodes.find((n) => n.id === N_IMG)));
ok('失败落进 canvas_node_runs（status=error）', runsAll().some((r) => r.status === 'error' && r.node_id === N_IMG));
eq('失败后计划仍是 consumed（不重复扣费）', planRow(P9.plan_id).status, 'consumed');
// 11.4 取消运行中的任务
const P10 = (await call('canvas_plan', { canvas_id: 'CV-MAIN', overwrite: true })).out;
T.approvePlan(P10.plan_id, { by: '测试人', confirm: true });
const slowSpy = mkExec({ delay: 120 });
const slowRun = await call('canvas_run', { plan_id: P10.plan_id, confirm_code: planRow(P10.plan_id).confirm_code }, { executors: slowSpy.executors });
ok('慢任务已入队', slowRun.ok === true && !!slowRun.out.job_id, slowRun.msg);
await waitFor(() => ['running'].includes(jobOf(slowRun.out.job_id)?.status), 3000);
const cancelRes = await call('job_cancel', { job_id: slowRun.out.job_id });
eq('job_cancel 返回已取消', cancelRes.out.canceled, true);
ok('任务最终状态 = canceled（不再翻回 done）', await waitFor(() => jobOf(slowRun.out.job_id)?.status === 'canceled'), `status=${jobOf(slowRun.out.job_id)?.status}`);
ok('取消后未跑完全部节点（执行器调用 < 4）', slowSpy.count() < 4, `调用 ${slowSpy.count()} 次`);
ok('取消后可见中文原因', /取消/.test(String(jobOf(slowRun.out.job_id)?.error || '')), jobOf(slowRun.out.job_id)?.error);
// 11.5 队列口径：graph 队列并发被强制为 1
const qs = J.queueStats();
ok('graph 队列并发上限 = 1（下游依赖上游产物）', !qs.graph || qs.graph.limit === 1, JSON.stringify(qs));
await waitFor(() => (J.queueStats().graph?.running || 0) === 0 && (J.queueStats().graph?.pending || 0) === 0, 15000);

// ============================ 12. HTTP 审批入口（随机端口） ============================
console.log('\n=== 12. HTTP 人类审批入口（随机端口 + 临时库） ===');
const { app, handle } = createApp();
S.registerMcpRoutes(app);
const server = createServer((req, res) => handle(req, res, { staticMounts: [] }));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
ok('HTTP 服务监听在随机端口（未占用 8788）', server.address().port !== 8788, `port=${server.address().port}`);
const jget = async (p) => (await fetch(BASE + p)).json();
const jpost = async (p, body) => { const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }); return { status: r.status, body: await r.json() }; };
const httpPlan = await jpost('/api/canvas/plans', { canvas_id: 'CV-MAIN', overwrite: true });
ok('POST /api/canvas/plans 生成计划成功（dry-run）', httpPlan.body.ok === true && /^PL-/.test(httpPlan.body.plan?.plan_id || ''), JSON.stringify(httpPlan.body).slice(0, 120));
const httpCode = String(planRow(httpPlan.body.plan.plan_id).confirm_code);
ok('★ HTTP 计划响应不含 confirm_code 字段', !('confirm_code' in (httpPlan.body.plan || {})));
notContains('★ HTTP 计划响应不含真实确认码', JSON.stringify(httpPlan.body), httpCode);
const httpList = await jget('/api/canvas/plans');
ok('GET /api/canvas/plans 列出待审批计划', httpList.plans.some((p) => p.plan_id === httpPlan.body.plan.plan_id));
notContains('★ 审批列表不返回完整确认码', JSON.stringify(httpList), httpCode);
ok('列表中的确认码是掩码', /^[0-9]\*+[0-9]$/.test(String(httpList.plans.find((p) => p.plan_id === httpPlan.body.plan.plan_id).confirm_code_masked)), httpList.plans[0]?.confirm_code_masked);
const httpPlanInList = httpList.plans.find((p) => p.plan_id === httpPlan.body.plan.plan_id);
ok('HTTP 列表含成本级与调用数预估（审批界面数据）', httpPlanInList?.cost_level === 'H' && httpPlanInList?.estimate.totalCalls === 4, JSON.stringify({ lv: httpPlanInList?.cost_level, est: httpPlanInList?.estimate, ownEst: httpPlan.body.plan?.estimate, pending: httpList.plans.map((p) => `${p.plan_id}:${p.estimate?.totalCalls}`) }));
const httpToolCallNoApproval = await jpost(`/api/canvas/plans/${httpPlan.body.plan.plan_id}/run`, { confirm_code: httpCode });
ok('HTTP 执行同样被闸门拦住（未审批）', httpToolCallNoApproval.body.ok === false && /尚未经人工审批/.test(httpToolCallNoApproval.body.error || ''), JSON.stringify(httpToolCallNoApproval.body).slice(0, 140));
const httpApproveNoConfirm = await jpost(`/api/canvas/plans/${httpPlan.body.plan.plan_id}/approve`, {});
ok('HTTP 审批需显式 confirm=true', httpApproveNoConfirm.body.ok === false && /confirm=true/.test(httpApproveNoConfirm.body.error || ''), JSON.stringify(httpApproveNoConfirm.body).slice(0, 140));
const httpApprove = await jpost(`/api/canvas/plans/${httpPlan.body.plan.plan_id}/approve`, { confirm: true, by: '界面用户' });
ok('HTTP 审批通过', httpApprove.body.ok === true && httpApprove.body.status === 'approved', JSON.stringify(httpApprove.body));
eq('HTTP 审批落库（审批人）', planRow(httpPlan.body.plan.plan_id).approved_by, '界面用户');
const httpAudits = await jget(`/api/canvas/plans/${httpPlan.body.plan.plan_id}/audits`);
ok('HTTP 审批记录可查询', httpAudits.audits.some((a) => a.action === 'approved'));
const httpDupApprove = await jpost(`/api/canvas/plans/${httpPlan.body.plan.plan_id}/approve`, { confirm: true });
ok('HTTP 重复审批报错（幂等）', httpDupApprove.body.ok === false && /不可再次审批/.test(httpDupApprove.body.error || ''), JSON.stringify(httpDupApprove.body).slice(0, 140));
const httpPlan2 = await jpost('/api/canvas/plans', { canvas_id: 'CV-MAIN', overwrite: true });
const httpReject = await jpost(`/api/canvas/plans/${httpPlan2.body.plan.plan_id}/reject`, { reason: 'HTTP 拒绝测试' });
ok('HTTP 拒绝接口生效', httpReject.body.ok === true && httpReject.body.status === 'rejected', JSON.stringify(httpReject.body));
const httpTools = await jget('/api/mcp/tools');
ok('GET /api/mcp/tools 返回工具目录（不含 handler）', httpTools.tools.length === cat.length && httpTools.tools.every((t) => !('handler' in t)));
const httpCall = await jpost('/api/mcp/call', { name: 'canvas_list_nodes', arguments: {} });
ok('POST /api/mcp/call 可调用只读工具', httpCall.body.ok === true && httpCall.body.result.count === 6, JSON.stringify(httpCall.body).slice(0, 120));
const httpCallBad = await jpost('/api/mcp/call', { name: 'canvas_不存在的工具' });
ok('POST /api/mcp/call 未知工具 → 400 + 中文错误', httpCallBad.status === 400 && /未知工具/.test(httpCallBad.body.error || ''), `status=${httpCallBad.status}`);
const httpCallRunGate = await jpost('/api/mcp/call', { name: 'canvas_run', arguments: { plan_id: httpPlan.body.plan.plan_id, confirm_code: '000000' } });
ok('HTTP 桥调用花钱工具同样过闸门（0 调用且中文拒绝）', httpCallRunGate.status === 400 && /已执行过|尚未经人工审批|确认码不正确/.test(httpCallRunGate.body.error || ''), httpCallRunGate.body.error);
await new Promise((r) => server.close(r));
ok('HTTP 服务已关闭（不留后台端口）', server.listening === false);

// ============================ 13. 总账：零真实生成调用 ============================
console.log('\n=== 13. 总账：MCP 层自身零付费副作用 ===');
const cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'));
eq('测试配置出图后端 = placeholder（不出网、不计费）', cfg.image.backend, 'placeholder');
eq('测试配置视频后端 = placeholder', cfg.video.backend, 'placeholder');
eq('测试配置 LLM = mock', cfg.llm.provider, 'mock');
const allRuns = runsAll();
const doneRuns = allRuns.filter((r) => r.status === 'done');
ok('所有 done 执行记录都来自注入的 stub 执行器（零真实调用）', doneRuns.length > 0 && doneRuns.every((r) => r.backend === 'stub'), `done=${doneRuns.length} backend=${[...new Set(doneRuns.map((r) => r.backend))].join(',')}`);
ok('全库从未出现真实后端标记（comfyui / openai-images / generic-http）', allRuns.every((r) => !['comfyui', 'openai-images', 'generic-http'].includes(String(r.backend))), `backend 集合=${[...new Set(allRuns.map((r) => r.backend))].join('|')}`);
ok('执行记录里既有 done 也有 error（失败路径同样留痕）', doneRuns.length > 0 && allRuns.some((r) => r.status === 'error'), `done=${doneRuns.length} error=${allRuns.filter((r) => r.status === 'error').length}`);
ok('所有执行记录都有 job_id（只在执行闸门放行后产生）', allRuns.every((r) => !!r.job_id));
const planStatuses = all('SELECT id, status FROM canvas_plans');
ok('每个计划都有完整审计链（created 至少一条）', planStatuses.every((p) => all('SELECT id FROM canvas_plan_audits WHERE plan_id = ? AND action = ?', p.id, 'created').length === 1));
ok('不存在「未审批却被执行」的计划（consumed 的计划必有 approved 记录）',
  planStatuses.filter((p) => p.status === 'consumed').every((p) => all('SELECT id FROM canvas_plan_audits WHERE plan_id = ? AND action = ?', p.id, 'approved').length === 1), `consumed=${planStatuses.filter((p) => p.status === 'consumed').length}`);
ok('临时库位于系统临时目录（真实库 data/factory.db 未被写入）', String(DB).startsWith(os.tmpdir()) && path.resolve(String(DB)) !== path.resolve(ROOT, 'data', 'factory.db'), `DB=${DB}`);

// ============================ 14. 画布写入工具（独立画布，避免污染 CV-MAIN 的计划快照） ============================
console.log('\n=== 14. 画布写入工具（不花钱，独立画布 CV-TOOLS） ===');
mkCanvas('CV-TOOLS', 'P4 工具测试画布');
const TOOL_OUT = mkNode({ id: 'ND-T-OUT', kind: 'output', title: '工具画布输出', canvasId: 'CV-TOOLS', data: {} });
const TOOL_NOTE = mkNode({ id: 'ND-T-NOTE', kind: 'note', title: '工具画布的便签', canvasId: 'CV-TOOLS', data: {} });
const createdNode = (await call('canvas_node_create', { canvas_id: 'CV-TOOLS', kind: 'text', title: 'Agent 新建文本', data: { prompt: 'x' } })).out;
ok('canvas_node_create 建节点成功（ND- 前缀）', createdNode.ok === true && /^ND-/.test(createdNode.node.id), createdNode.node?.id);
eq('canvas_node_create 落在指定画布', createdNode.node.canvas_id, 'CV-TOOLS');
const foundCreated = (await call('canvas_list_nodes', { canvas_id: 'CV-TOOLS' })).out.nodes.find((n) => n.title === 'Agent 新建文本');
eq('canvas_list_nodes 能按 title 找到新建节点', foundCreated?.id, createdNode.node.id);
const noteNode = (await call('canvas_node_create', { canvas_id: 'CV-TOOLS', kind: 'note', title: '便签内容' })).out;
eq('canvas_node_create kind=note 走便签接口（kind=note）', noteNode.node.kind, 'note');
const upd = (await call('canvas_node_update', { node_id: createdNode.node.id, patch: { x: 77, title: '改名后的文本' } })).out;
ok('canvas_node_update 改标题与坐标成功', upd.node.title === '改名后的文本' && upd.node.x === 77);
const dataUpd = (await call('canvas_node_update', { node_id: createdNode.node.id, patch: { data: { prompt: '新提示词' } } })).out;
ok('canvas_node_update 的 data 浅合并（未传键保留）', T.safeJSON(dataUpd.node.data).prompt === '新提示词' && T.safeJSON(dataUpd.node.data).x === undefined);
const linkTool = await call('canvas_link_create', { canvas_id: 'CV-TOOLS', from_node: createdNode.node.id, to_node: TOOL_OUT, from_port: 'text', to_port: 'in' });
ok('canvas_link_create 建连线成功（类型化端口）', linkTool.ok === true && linkTool.out.from_port === 'text' && linkTool.out.to_port === 'in', JSON.stringify(linkTool.out || linkTool.msg).slice(0, 160));
const badPort = await call('canvas_link_create', { canvas_id: 'CV-TOOLS', from_node: TOOL_NOTE, to_node: TOOL_OUT, from_port: 'clip', to_port: 'in' });
ok('端口规则被复用（note 无 clip 输出端口 → 中文报错）', badPort.ok === false && badPort.msg.includes('没有输出端口'), badPort.msg);
const textToImage = await call('canvas_link_create', { canvas_id: 'CV-TOOLS', from_node: TOOL_NOTE, to_node: TOOL_OUT, from_port: 'text', to_port: 'ref1' });
ok('P2 规则现状：output 无 ref1 入端口 → 中文报错（端口表同源生效）', textToImage.ok === false && /没有输入端口/.test(textToImage.msg), textToImage.msg);
const linkSame = await call('canvas_link_create', { canvas_id: 'CV-TOOLS', from_node: TOOL_OUT, to_node: TOOL_OUT, from_port: 'text', to_port: 'in' });
ok('自连边被拒绝（中文报错）', linkSame.ok === false && linkSame.msg.includes('不能连接同一个节点'), linkSame.msg);
eq('canvas_link_delete 删除连线成功', (await call('canvas_link_delete', { link_id: linkTool.out.id })).out.ok, true);
eq('删除连线后画布连线数归零', all('SELECT id FROM canvas_links WHERE canvas_id = ?', 'CV-TOOLS').length, 0);
const linkTool2 = (await call('canvas_link_create', { canvas_id: 'CV-TOOLS', from_node: createdNode.node.id, to_node: TOOL_OUT, from_port: 'text', to_port: 'in' })).out;
const delRes = (await call('canvas_node_delete', { node_id: createdNode.node.id })).out;
eq('canvas_node_delete 一并清理连线', delRes.links_removed, 1);
eq('删除后连线表无该节点残留', all('SELECT id FROM canvas_links WHERE from_node = ? OR to_node = ?', createdNode.node.id, createdNode.node.id).length, 0);
eq('删除后节点表无残留', get('SELECT id FROM canvas_nodes WHERE id = ?', createdNode.node.id), undefined);
const restoreRes = (await call('canvas_restore', { canvas_id: 'CV-TOOLS', nodes: [{ id: 'ND-T-1', kind: 'image', title: '还原后的图', x: 5, y: 6 }], groups: [] })).out;
ok('canvas_restore 原子替换画布节点', restoreRes.ok === true && restoreRes.nodes === 1, JSON.stringify(restoreRes).slice(0, 120));
eq('还原后画布只剩 1 个节点', all('SELECT id FROM canvas_nodes WHERE canvas_id = ?', 'CV-TOOLS').length, 1);
const restoreEmpty = await call('canvas_restore', { canvas_id: 'CV-TOOLS', nodes: [] });
ok('空快照不会清空非空画布（安全网生效）', restoreEmpty.ok === false && restoreEmpty.msg.includes('拒绝用空快照覆盖非空画布'), restoreEmpty.msg);
const bindNone = await call('canvas_bind_script', { script_id: 'SC-没有这个' });
contains('绑定不存在的剧本 → 中文报错', bindNone.msg, '剧本不存在');
ok('CV-MAIN 计划快照未被工具测试污染（CV-TOOLS 独立）', G.planGraph({ canvasId: 'CV-MAIN' }).nodeCount === 6, `nodeCount=${G.planGraph({ canvasId: 'CV-MAIN' }).nodeCount}`);

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
if (fail) process.exitCode = 1;
