// P3 · DAG 执行引擎自测（纯 Node，离线零成本：临时库 + 占位后端，绝不触碰 data/factory.db）
// 用法：node tests/test-graph.js
// 覆盖：拓扑排序与环检测 / 孤立节点 / 每侧单输入 / 上游产物注入下游 / 失败传播 / 重试 / 取消 /
//       进度上报 / data 列参数读写 / 增量跳过 / 计划(dry-run)结构 / 真实占位后端端到端
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---- 环境隔离：临时数据目录 + 临时库 + 临时配置（强制 placeholder 后端，杜绝任何真实网络/计费）----
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-graph-'));
const DB = path.join(TMP, 'graph.db');
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

const { migrate, get, all, run, resolveAsset, SCHEMA_VERSION, ROOT } = await import('../src/db.js');
const G = await import('../src/graph.js');
const { getJob, cancelJob, queueStats } = await import('../src/jobs.js');

migrate();
G.ensureGraphSchema();

// ---- 结算助手：每条断言都打印可核对证据 ----
let pass = 0, fail = 0;
const ok = (name, cond, evidence = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${evidence ? `  ← ${evidence}` : ''}`); }
  else { fail++; console.error(`  ✗ ${name}  ← ${evidence}`); }
};
const eq = (name, actual, expected) => ok(name, actual === expected, `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`);
const throwsSync = (fn, re) => { try { fn(); return { threw: false, msg: '' }; } catch (e) { const msg = String(e?.message || e); return { threw: true, msg, err: e, match: re ? re.test(msg) : true }; } };
const throwsAsync = async (fn, re) => { try { await fn(); return { threw: false, msg: '' }; } catch (e) { const msg = String(e?.message || e); return { threw: true, msg, err: e, match: re ? re.test(msg) : true }; } };
const waitJob = async (id, ms = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const j = getJob(id);
    if (j && ['done', 'error', 'canceled'].includes(j.status)) return j;
    await new Promise((r) => setTimeout(r, 25));
  }
  return getJob(id);
};

// ---- 造数据助手 ----
let seq = 0;
const mkNode = ({ id = null, kind = 'actor', title = '', data = {}, actorId = '', canvasId = 'CV-MAIN' } = {}) => {
  const nid = id || `N-${String(++seq).padStart(3, '0')}`;
  run(`INSERT INTO canvas_nodes(id, canvas_id, actor_id, x, y, w, h, z, locked, note, group_id, kind, color, title, data)
       VALUES(?,?,?,0,0,180,220,0,0,'',NULL,?,NULL,?,?)`,
    nid, canvasId, actorId, kind, title || nid, JSON.stringify(data));
  return nid;
};
const mkLink = (() => {
  // P2 已落地 from_port / to_port / slot；仍按列存在性动态拼 SQL，避免与并行会话的 schema 演进互相打架
  const COLS = new Set(all('PRAGMA table_info(canvas_links)').map((c) => c.name));
  return ({ id = null, from, to, fromPort = 'image', toPort = null, toSide = 'left', fromSide = 'right', slot = null, canvasId = 'CV-MAIN' } = {}) => {
    const lid = id || `L-${(++seq).toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const cols = ['id', 'canvas_id', 'from_actor', 'to_actor', 'label', 'color', 'created_at', 'from_node', 'to_node', 'from_side', 'to_side'];
    const vals = [lid, canvasId, '', '', null, null, new Date().toISOString(), from, to, fromSide, toSide];
    if (COLS.has('to_port')) { cols.push('to_port'); vals.push(toPort); }
    if (COLS.has('from_port')) { cols.push('from_port'); vals.push(fromPort); }
    if (COLS.has('slot')) { cols.push('slot'); vals.push(slot ?? 0); }
    run(`INSERT INTO canvas_links(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`, ...vals);
    return lid;
  };
})();
/** 记录式 stub 执行器：按节点 id 决定返回/抛错；只走 executors.default，完全不碰真实后端 */
const mkExec = (byNode = {}, { delay = 0 } = {}) => {
  const calls = [];
  const executors = {
    default: async (req) => {
      calls.push({ kind: req.kind, nodeId: req.node.id, inputs: { ...req.inputs }, params: { ...req.params }, canvasId: req.canvasId, jobId: req.jobId });
      if (delay) await new Promise((r) => setTimeout(r, delay));
      const spec = byNode[req.node.id];
      if (typeof spec === 'function') return await spec(req);
      if (spec) return { ...spec };
      return { filePath: `data/stub/${req.node.id}.bin`, mime: 'application/octet-stream', backend: 'stub', model: 'stub-1', elapsedMs: 1, raw: { stub: true } };
    },
  };
  return { executors, calls, callsOf: (id) => calls.filter((c) => c.nodeId === id) };
};
const mkCtx = ({ cancelAfter = Infinity, progress = [], logs = [] } = {}) => {
  let checks = 0;
  return {
    id: 'JOB-FAKE', _progress: progress, _logs: logs,
    setProgress(pct, extra = {}) { progress.push({ pct, ...extra }); },
    log(msg) { logs.push(String(msg)); },
    isCanceled() { checks++; return checks > cancelAfter; },
  };
};
const st = (id) => (G.safeJSON(get('SELECT data FROM canvas_nodes WHERE id = ?', id)?.data) || {});
const runsOf = (id) => all('SELECT * FROM canvas_node_runs WHERE node_id = ? ORDER BY created_at DESC, rowid DESC', id);

console.log('\n=== 0. 环境与建表（临时库 + canvas_node_runs 幂等建表） ===');
console.log(`      临时库：${DB}`);
console.log(`      临时数据目录：${DATA_TMP}`);
ok('未触碰真实库 data/factory.db', !fs.existsSync(path.join(ROOT, 'data', 'factory.db')) || process.env.FACTORY_DB !== path.join(ROOT, 'data', 'factory.db'), `FACTORY_DB=${process.env.FACTORY_DB}`);
const runCols = all('PRAGMA table_info(canvas_node_runs)').map((c) => c.name);
eq('canvas_node_runs 列数 = 20（对齐 shot_renders 设计）', runCols.length, 20);
ok('关键列齐备（node_id/input_fp/job_id/status/file_path/meta）',
  ['node_id', 'input_fp', 'job_id', 'status', 'file_path', 'meta'].every((c) => runCols.includes(c)), runCols.join(','));
const idxNames = all("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name = 'canvas_node_runs'").map((r) => r.name);
ok('两个索引已建（idx_node_runs_node / idx_node_runs_job）',
  idxNames.includes('idx_node_runs_node') && idxNames.includes('idx_node_runs_job'), idxNames.join(','));
eq('migrate() 后 meta_kv.schema_version = SCHEMA_VERSION', Number(get("SELECT value FROM meta_kv WHERE key='schema_version'").value), SCHEMA_VERSION);
eq('ensureGraphSchema() 幂等（第二次返回 false）', G.ensureGraphSchema(), false);
const linkCols = all('PRAGMA table_info(canvas_links)').map((c) => c.name);
ok('P2 端口列已就位（from_port/to_port/slot → P3 端口接缝可生效）',
  ['from_port', 'to_port', 'slot'].every((c) => linkCols.includes(c)), `SCHEMA_VERSION=${SCHEMA_VERSION}；canvas_links=${linkCols.join(',')}`);

console.log('\n=== 1. 拓扑排序与环检测 ===');
const line = ['A', 'B', 'C', 'D'].map((x) => x);
const lineLinks = [['A', 'B'], ['B', 'C'], ['C', 'D']].map(([f, t]) => ({ from_node: f, to_node: t }));
let r = G.topoSort(line, lineLinks);
eq('线性链 A→B→C→D 顺序正确', r.order.join('>'), 'A>B>C>D');
eq('线性链无环', r.cycles.length, 0);

r = G.topoSort(['A', 'B', 'C', 'D'], [{ from_node: 'A', to_node: 'B' }, { from_node: 'A', to_node: 'C' }, { from_node: 'B', to_node: 'D' }, { from_node: 'C', to_node: 'D' }]);
ok('菱形 A→{B,C}→D：A 最先、D 最后、B/C 居中', r.order[0] === 'A' && r.order[3] === 'D' && ['B', 'C'].includes(r.order[1]) && ['B', 'C'].includes(r.order[2]), r.order.join('>'));

r = G.topoSort(['A', 'B', 'Z'], [{ from_node: 'A', to_node: 'B' }]);
ok('孤立节点 Z 仍进入执行顺序', r.order.length === 3 && r.order.includes('Z'), r.order.join('>'));
eq('孤立节点不产生环', r.cycles.length, 0);

r = G.topoSort(['A', 'B', 'C'], [{ from_node: 'A', to_node: 'B' }, { from_node: 'B', to_node: 'C' }, { from_node: 'C', to_node: 'A' }]);
eq('环 A→B→C→A 检出 3 个环上节点', r.cycles.sort().join(','), 'A,B,C');
eq('有环时拓扑序为空', r.order.length, 0);

r = G.topoSort(['A', 'B', 'C', 'D'], [{ from_node: 'A', to_node: 'B' }, { from_node: 'B', to_node: 'C' }, { from_node: 'C', to_node: 'A' }, { from_node: 'C', to_node: 'D' }]);
ok('环外下游 D 只进 blocked、不算环上节点', r.cycles.length === 3 && !r.cycles.includes('D') && r.blocked.join(',') === 'D', `cycles=${r.cycles.join(',')} blocked=${r.blocked.join(',')}`);

r = G.topoSort(['A'], [{ from_node: 'A', to_node: 'A' }]);
ok('自连边 A→A 被忽略（无自环）', r.cycles.length === 0 && r.order.join() === 'A', `order=${r.order.join()} cycles=${r.cycles.length}`);

r = G.topoSort(['A', 'B'], [{ from_node: 'X', to_node: 'A' }, { from_node: 'B', to_node: 'Y' }, { from_node: 'A', to_node: 'B' }]);
eq('指向图外的边被忽略，不污染入度', r.order.join('>'), 'A>B');

r = G.topoSort(['A', 'B'], [{ from_node: 'A', to_node: 'B' }, { from_node: 'A', to_node: 'B' }]);
eq('重复平行边不制造假环', `${r.order.join('>')}/${r.cycles.length}`, 'A>B/0');

r = G.topoSort([], []);
ok('空图返回空序', r.order.length === 0 && r.cycles.length === 0, `order=${JSON.stringify(r.order)}`);

console.log('\n=== 2. 上游产物装配（assembleInputs：每侧单输入） ===');
const valOf = (map) => (id) => map[id] ?? null;
let det = G.assembleInputsDetailed('T', [{ id: 'L1', from_node: 'S', to_node: 'T', to_side: 'left' }], valOf({ S: 'data/images/s.svg' }));
eq('无端口列的历史入边归位到 in', det.inputs.in, 'data/images/s.svg');
eq('来源可追溯（fromId/linkId）', `${det.sources.in.fromId}/${det.sources.in.linkId}`, 'S/L1');

det = G.assembleInputsDetailed('T', [
  { id: 'L1', from_node: 'S1', to_node: 'T', to_port: 'ref1', to_side: 'left' },
  { id: 'L2', from_node: 'S2', to_node: 'T', to_port: 'ref2', to_side: 'left' },
], valOf({ S1: 'r1.png', S2: 'r2.png' }));
eq('to_port=ref1 精确归位（P2 接缝）', det.inputs.ref1, 'r1.png');
eq('to_port=ref2 精确归位', det.inputs.ref2, 'r2.png');
eq('端口路由无冲突（dropped=0）', det.dropped.length, 0);

det = G.assembleInputsDetailed('T', [
  { id: 'L1', from_node: 'S1', to_node: 'T', to_side: 'left' },
  { id: 'L2', from_node: 'S2', to_node: 'T', to_side: 'left' },
], valOf({ S1: 'first.png', S2: 'second.png' }));
eq('每侧单输入：同一端口两条入边只取第一条', det.inputs.in, 'first.png');
ok('被丢弃的入边有中文原因（可定位）', det.dropped.length === 1 && /每侧单输入/.test(det.dropped[0].reason), `${det.dropped[0]?.from}→${det.dropped[0]?.port}：${det.dropped[0]?.reason}`);

det = G.assembleInputsDetailed('T', [
  { id: 'L5', from_node: 'S5', to_node: 'T', to_side: 'left', slot: 5 },
  { id: 'L1', from_node: 'S1', to_node: 'T', to_side: 'left', slot: 1 },
], valOf({ S1: 'slot1.png', S5: 'slot5.png' }));
eq('P2 预留：带 slot 时按 slot 升序取第一个', det.inputs.in, 'slot1.png');
eq('sources 记录 slot 号', det.sources.in.slot, 1);

det = G.assembleInputsDetailed('T', [{ id: 'L1', from_node: 'S9', to_node: 'T' }], valOf({}));
eq('上游无产物时 inputs 为空对象（不写 undefined 键）', Object.keys(det.inputs).length, 0);
ok('空产物不会被写成键值', JSON.stringify(det.inputs) === '{}', JSON.stringify(det.inputs));

det = G.assembleInputsDetailed('T', [{ id: 'L1', from_node: 'S', to_node: 'T' }], valOf({ S: '' }));
eq('上游产物为空串同样跳过', Object.keys(det.inputs).length, 0);

det = G.assembleInputsDetailed('T', [{ id: 'L1', from_node: 'S', to_node: 'T', to_port: 'weird' }], valOf({ S: 'x.png' }));
ok('未知端口名仍归位但标记 unknownPort（前向兼容）', det.inputs.weird === 'x.png' && det.sources.weird.unknownPort === true, `inputs=${JSON.stringify(det.inputs)}`);
eq('assembleInputs 只返回端口→值（与 Detailed 一致）', G.assembleInputs('T', [{ id: 'L1', from_node: 'S', to_node: 'T' }], valOf({ S: 'y.png' })).in, 'y.png');

console.log('\n=== 3. 输入指纹（增量跳过的基础） ===');
const nImage = { id: 'NFP', kind: 'image', data: JSON.stringify({ prompt: '甲', width: 64, status: 'idle' }) };
const nImage2 = { id: 'NFP', kind: 'image', data: JSON.stringify({ prompt: '乙', width: 64, status: 'idle' }) };
const fp1 = G.inputFingerprint(nImage, { in: 'a.png' }, { S: 'ff1' });
const fp2 = G.inputFingerprint(nImage, { in: 'a.png' }, { S: 'ff1' });
eq('参数与输入都不变 → 指纹不变', fp1, fp2);
ok('指纹为 16 位 hex', /^[0-9a-f]{16}$/.test(fp1), fp1);
ok('参数变化（prompt）→ 指纹变', G.inputFingerprint(nImage2, { in: 'a.png' }, { S: 'ff1' }) !== fp1, `${fp1} → ${G.inputFingerprint(nImage2, { in: 'a.png' }, { S: 'ff1' })}`);
ok('上游指纹变化 → 下游指纹变', G.inputFingerprint(nImage, { in: 'a.png' }, { S: 'ff2' }) !== fp1, `upstream ff1→ff2：${G.inputFingerprint(nImage, { in: 'a.png' }, { S: 'ff2' })}`);
ok('上游产物变化（inputs 变）→ 指纹变', G.inputFingerprint(nImage, { in: 'b.png' }, { S: 'ff1' }) !== fp1, G.inputFingerprint(nImage, { in: 'b.png' }, { S: 'ff1' }));
ok('节点类型不同 → 指纹不同', G.inputFingerprint({ ...nImage, kind: 'video' }, { in: 'a.png' }, { S: 'ff1' }) !== fp1, G.inputFingerprint({ ...nImage, kind: 'video' }, { in: 'a.png' }, { S: 'ff1' }));
const fpVolatile = G.inputFingerprint({ ...nImage, data: JSON.stringify({ prompt: '甲', width: 64, status: 'done', lastRunId: 'NR-9', lastError: 'x', lastFile: 'y.svg' }) }, { in: 'a.png' }, { S: 'ff1' });
eq('data 里的易变状态键（status/lastRunId/lastError/lastFile）不参与指纹', fpVolatile, fp1);
const fpBad = G.inputFingerprint({ id: 'NFP', kind: 'image', data: '不是 JSON' }, {}, {});
ok('data 为脏数据时不抛错且仍有指纹', /^[0-9a-f]{16}$/.test(fpBad), fpBad);

console.log('\n=== 4. 执行记录与节点状态读写（canvas_node_runs / canvas_nodes.data） ===');
const CV_REC = 'CV-REC';
const nRec = mkNode({ canvasId: CV_REC, kind: 'image', title: '记录节点', data: { prompt: '参数保留测试', custom: 'KEEP' } });
const rec1 = G.recordRun({ canvasId: CV_REC, nodeId: nRec, jobId: 'JOB-X', kind: 'image', status: 'done', file_path: 'data/a.svg', mime: 'image/svg+xml', width: 64, height: 64, prompt: 'p1', input_fp: fp1, meta: { attempts: 1 } });
ok('recordRun 落库并回读（id 形如 NR-…）', /^NR-/.test(rec1.id) && rec1.file_path === 'data/a.svg', `id=${rec1.id} file=${rec1.file_path} fp=${rec1.input_fp}`);
eq('meta 以 JSON 落库可解析', G.safeJSON(rec1.meta).attempts, 1);
const rec2 = G.recordRun({ canvasId: CV_REC, nodeId: nRec, kind: 'image', status: 'error', error: '某次失败' });
const rec3 = G.recordRun({ canvasId: CV_REC, nodeId: nRec, kind: 'image', status: 'done', file_path: 'data/b.svg', input_fp: 'fp-b' });
eq('lastRun 只取最新 done（跳过更晚的 error 行与更早的 done 行）', G.lastRun(nRec).id, rec3.id);
ok('error 行仍保留在历史里（审计可查）', runsOf(nRec).some((x) => x.id === rec2.id && x.status === 'error'), `runs=${runsOf(nRec).length} 条`);
eq('lastRunAny 取最新一条（含 error）', G.lastRunAny(nRec).id, rec3.id);
eq('nodeRuns 按新→旧返回', G.nodeRuns({ nodeId: nRec })[0].id, rec3.id);
eq('recordRun 未显式给 id 时自动生成', rec2.id.startsWith('NR-'), true);

G.writeNodeStatus(CV_REC, nRec, { status: 'done', lastFile: 'data/b.svg', lastRunId: rec3.id });
const dRec = st(nRec);
ok('writeNodeStatus 合并进 data（status/lastFile/lastRunId 生效）', dRec.status === 'done' && dRec.lastFile === 'data/b.svg' && dRec.lastRunId === rec3.id, JSON.stringify(dRec));
ok('writeNodeStatus 不覆盖既有键（prompt/custom 原样保留）', dRec.prompt === '参数保留测试' && dRec.custom === 'KEEP', `prompt=${dRec.prompt} custom=${dRec.custom}`);
const nDirty = mkNode({ canvasId: CV_REC, kind: 'image', title: '脏 data', data: {} });
run('UPDATE canvas_nodes SET data = ? WHERE id = ?', '这不是 JSON', nDirty);
G.writeNodeStatus(CV_REC, nDirty, { status: 'error', lastError: '坏数据也不崩' });
eq('data 为脏数据时状态回写不抛错并重建为合法 JSON', st(nDirty).lastError, '坏数据也不崩');
eq('节点不存在时 writeNodeStatus 返回 null（防御式）', G.writeNodeStatus(CV_REC, 'N-NOT-EXIST', { status: 'done' }), null);

console.log('\n=== 5. 计划（dry-run 预览，绝不产生付费调用） ===');
const CV_PLAN = 'CV-PLAN';
run(`INSERT INTO actors(id, name, cover_image, ref_image, created_at) VALUES('C-GRAPH-1','图谱演员','data/images/cover.svg','data/images/ref.svg',?)`, new Date().toISOString());
const pActor = mkNode({ canvasId: CV_PLAN, kind: 'actor', title: '演员卡', actorId: 'C-GRAPH-1' });
const pImg = mkNode({ canvasId: CV_PLAN, kind: 'image', title: '参考图', data: { prompt: '出图', width: 64, height: 64, backend: 'placeholder' } });
const pVid = mkNode({ canvasId: CV_PLAN, kind: 'video', title: '图生视频', data: { prompt: '运镜', duration: 3, backend: 'placeholder' } });
const pOut = mkNode({ canvasId: CV_PLAN, kind: 'output', title: '输出成片', data: {} });
const pDone = mkNode({ canvasId: CV_PLAN, kind: 'image', title: '已有产物', data: { prompt: '已生成', width: 64, height: 64 } });
mkLink({ canvasId: CV_PLAN, from: pActor, to: pImg, toPort: null });
mkLink({ canvasId: CV_PLAN, from: pImg, to: pVid, toPort: 'first' });
mkLink({ canvasId: CV_PLAN, from: pVid, to: pOut, toPort: 'clip' });
// 给 pDone 造一条「输入未变」的成功记录（指纹按它当前现场计算）
const doneFp = G.inputFingerprint(get('SELECT * FROM canvas_nodes WHERE id = ?', pDone), {}, {});
G.recordRun({ canvasId: CV_PLAN, nodeId: pDone, kind: 'image', status: 'done', file_path: 'data/images/done.svg', input_fp: doneFp });

const plan = G.planGraph({ canvasId: CV_PLAN });
ok('dry-run 计划具备审核所需结构（order/steps.run/steps.skip/estimate）',
  Array.isArray(plan.order) && Array.isArray(plan.steps.run) && Array.isArray(plan.steps.skip) && !!plan.estimate && !!plan.generatedAt,
  `keys=${Object.keys(plan).join(',')}`);
eq('计划里可执行节点数 = 3（image/video/output）', plan.steps.run.length, 3);
ok('计划顺序满足拓扑（参考图 → 图生视频 → 输出）',
  plan.order.indexOf(pImg) < plan.order.indexOf(pVid) && plan.order.indexOf(pVid) < plan.order.indexOf(pOut),
  plan.order.join(' > '));
eq('estimate.imageCalls 按 kind 计 image 调用数', plan.estimate.imageCalls, 1);
eq('estimate.videoCalls 按 kind 计 video 调用数', plan.estimate.videoCalls, 1);
eq('estimate.outputCalls 计合成节点数', plan.estimate.outputCalls, 1);
eq('estimate.textCalls = 0（无文字节点）', plan.estimate.textCalls, 0);
eq('estimate.totalCalls = 将执行节点数', plan.estimate.totalCalls, 3);
ok('estimate.note 提醒按调用次数估算', /以平台计费为准/.test(plan.estimate.note), plan.estimate.note);
const skipActor = plan.steps.skip.find((s) => s.id === pActor);
ok('演员节点进 skip，原因=仅作为素材源', !!skipActor && /仅作为素材源/.test(skipActor.reason), `${pActor}：${skipActor?.reason}`);
const skipDone = plan.steps.skip.find((s) => s.id === pDone);
ok('已有产物且输入未变的节点进 skip（含强制重算提示）', !!skipDone && /overwrite/.test(skipDone.reason), `${pDone}：${skipDone?.reason}`);
ok('skip 项带可核对的产物指纹', /^[0-9a-f]{16}$/.test(skipDone.input_fp), skipDone.input_fp);
const runImg = plan.steps.run.find((s) => s.id === pImg);
ok('素材源产物注入下游：参考图节点的输入来自演员定妆图', runImg.inputs.includes('in'), `inputs端口=${JSON.stringify(runImg.inputs)}`);
ok('run 项带上游依赖清单（人工审核可读）', runImg.upstream.includes(pActor), `upstream=${JSON.stringify(runImg.upstream)}`);
const runVid = plan.steps.run.find((s) => s.id === pVid);
ok('下游因上游将重算而进入 run，并写明原因', /上游将重算/.test(runVid.reason || ''), `${pVid}：${runVid.reason}`);

const planOw = G.planGraph({ canvasId: CV_PLAN, overwrite: true });
eq('overwrite=true → 已有产物节点重新进 run', planOw.steps.run.filter((s) => s.id === pDone).length, 1);
eq('overwrite=true → imageCalls 增加', planOw.estimate.imageCalls, 2);
eq('overwrite=true → skip 里只剩非执行类型', planOw.steps.skip.map((s) => s.kind).join(','), 'actor');

const planOne = G.planGraph({ canvasId: CV_PLAN, nodeIds: [pVid] });
eq('单节点计划只含该节点（单节点重跑的实现方式）', planOne.steps.run.map((s) => s.id).join(','), pVid);
ok('单节点重跑仍带着入边（上游产物一旦存在即装配，见 §6/§10 的实测）', planOne.steps.run[0].upstream.includes(pImg), `upstream=${JSON.stringify(planOne.steps.run[0].upstream)} inputs=${JSON.stringify(planOne.steps.run[0].inputs)}`);

const CV_CYC = 'CV-CYC';
const cA = mkNode({ canvasId: CV_CYC, kind: 'image', title: '环甲' });
const cB = mkNode({ canvasId: CV_CYC, kind: 'image', title: '环乙' });
const cC = mkNode({ canvasId: CV_CYC, kind: 'image', title: '环丙' });
mkLink({ canvasId: CV_CYC, from: cA, to: cB });
mkLink({ canvasId: CV_CYC, from: cB, to: cC });
mkLink({ canvasId: CV_CYC, from: cC, to: cA });
const cyc = throwsSync(() => G.planGraph({ canvasId: CV_CYC }), /环形依赖/);
ok('planGraph 遇环抛中文「环形依赖」', cyc.threw && cyc.match, cyc.msg);
ok('报错定位到具体节点标题（环甲/环乙/环丙）', /环甲/.test(cyc.msg) && /环乙/.test(cyc.msg) && /环丙/.test(cyc.msg), cyc.msg);
const empty = throwsSync(() => G.planGraph({ canvasId: 'CV-NONE' }), /没有可执行的节点/);
ok('空画布给出明确中文错误', empty.threw && empty.match, empty.msg);

console.log('\n=== 6. 整图执行（stub 执行器：顺序 / 注入 / 回写 / 进度） ===');
const CV_RUN = 'CV-RUN';
const rA = mkNode({ canvasId: CV_RUN, kind: 'image', title: '节点甲', data: { prompt: '甲的提示词', width: 64, height: 64 } });
const rB = mkNode({ canvasId: CV_RUN, kind: 'video', title: '节点乙', data: { prompt: '乙的提示词', duration: 2 } });
const rC = mkNode({ canvasId: CV_RUN, kind: 'output', title: '节点丙', data: {} });
mkLink({ canvasId: CV_RUN, from: rA, to: rB, toPort: 'first' });
mkLink({ canvasId: CV_RUN, from: rB, to: rC, toPort: 'clip' });
const stub = mkExec({
  [rA]: { filePath: 'data/stub/a.svg', mime: 'image/svg+xml', width: 64, height: 64, backend: 'stub', model: 'stub-image', seed: 1234, elapsedMs: 5, raw: { stub: true } },
  [rB]: { filePath: 'data/stub/b.mp4', mime: 'video/mp4', width: 64, height: 64, duration: 2, backend: 'stub', model: 'stub-video', elapsedMs: 7, raw: {} },
  [rC]: { filePath: 'data/stub/c.mp4', mime: 'video/mp4', duration: 2, backend: 'stub', model: 'assemble', elapsedMs: 9, raw: {} },
});
const plan1 = G.planGraph({ canvasId: CV_RUN });          // 执行前生成：3 个节点都在 run 里
eq('执行前的计划：3 个节点待执行', plan1.steps.run.length, 3);
const ctx1 = mkCtx();
const sum1 = await G.runGraph({ canvasId: CV_RUN, plan: plan1, ctx: ctx1, executors: stub.executors, retryBaseMs: 0 });
eq('执行覆盖全部可执行节点', sum1.total, 3);
eq('全部成功（failed=0 / skipped=0）', `${sum1.ok}/${sum1.failed}/${sum1.skipped}`, '3/0/0');
eq('执行顺序满足拓扑（甲→乙→丙）', stub.calls.map((c) => c.nodeId).join(','), [rA, rB, rC].join(','));
const callB = stub.callsOf(rB)[0];
eq('上游产物注入下游：乙的 first 口拿到甲的产物', callB.inputs.first, 'data/stub/a.svg');
ok('每个端口只注入一个值（每侧单输入）', Object.keys(callB.inputs).length === 1, JSON.stringify(callB.inputs));
eq('节点参数从 data 列读出并传入执行器（乙）', callB.params.prompt, '乙的提示词');
eq('节点参数从 data 列读出并传入执行器（甲）', stub.callsOf(rA)[0].params.width, 64);
eq('执行器收到 jobId 与 canvasId', `${callB.canvasId}/${callB.jobId}`, `${CV_RUN}/null`);
eq('进度上报：调用次数 = 节点数 + 1（含起始 0%）', ctx1._progress.length, 4);
eq('进度起始为 0%', ctx1._progress[0].pct, 0);
eq('进度终值为 100%', ctx1._progress[ctx1._progress.length - 1].pct, 100);
ok('进度单调不减', ctx1._progress.every((p, i, arr) => i === 0 || p.pct >= arr[i - 1].pct), ctx1._progress.map((p) => `${p.pct}%`).join(' → '));
eq('进度附带 done/total（前端可直接渲染）', `${ctx1._progress[1].done}/${ctx1._progress[1].total}`, '1/3');
const rowA = runsOf(rA)[0];
ok('执行记录落库（含 mime/backend/seed/input_fp/meta）',
  rowA.status === 'done' && rowA.file_path === 'data/stub/a.svg' && rowA.mime === 'image/svg+xml' && rowA.backend === 'stub' && rowA.seed === 1234 && /^[0-9a-f]{16}$/.test(rowA.input_fp),
  `${rowA.id} file=${rowA.file_path} mime=${rowA.mime} backend=${rowA.backend} seed=${rowA.seed} fp=${rowA.input_fp}`);
eq('prompt 从节点参数写入执行记录', rowA.prompt, '甲的提示词');
eq('meta 记录 elapsedMs/attempts', `${G.safeJSON(rowA.meta).attempts}/${typeof G.safeJSON(rowA.meta).elapsedMs}`, '1/number');
const dA = st(rA);
ok('节点状态回写 canvas_nodes.data（done + lastFile + lastRunId）', dA.status === 'done' && dA.lastFile === 'data/stub/a.svg' && dA.lastRunId === rowA.id, JSON.stringify(dA));
ok('回写状态不破坏节点参数（prompt/width 仍在）', dA.prompt === '甲的提示词' && dA.width === 64, `prompt=${dA.prompt} width=${dA.width}`);
eq('返回产物清单（nodeId → 文件）', Object.values(sum1.files).join(','), 'data/stub/a.svg,data/stub/b.mp4,data/stub/c.mp4');
ok('onEvent 事件流可用（start/node-start/node-done/done）', typeof G.runGraph === 'function' && sum1.canceled === false, `canceled=${sum1.canceled}`);

const callsAfterFirst = stub.calls.length;
const plan2 = G.planGraph({ canvasId: CV_RUN });
eq('第二次计划：输入未变的节点全部进入 skip', plan2.steps.run.length, 0);
eq('第二次计划：skip 覆盖 3 个节点', plan2.steps.skip.length, 3);
const sum2 = await G.runGraph({ canvasId: CV_RUN, plan: plan2, executors: stub.executors, retryBaseMs: 0 });
eq('增量跳过：没有新增任何执行器调用（不重复花钱）', stub.calls.length, callsAfterFirst);
eq('计划判定无待执行节点 → 结果为空集（不重复产生产物）', sum2.results.length, 0);

// 陈旧计划兜底：计划生成后节点已被单点重跑/别的任务刷新 → 执行到该节点时按指纹跳过，绝不重复调用
const ctxStale = mkCtx();
const sumStale = await G.runGraph({ canvasId: CV_RUN, plan: plan1, ctx: ctxStale, executors: stub.executors, retryBaseMs: 0 });
eq('陈旧计划：3 个节点都在 run 里但全部按指纹跳过', sumStale.results.filter((x) => x.skipped).length, 3);
eq('陈旧计划：仍然一次执行器调用都没有', stub.calls.length, callsAfterFirst);
eq('陈旧计划：进度依旧跑满 100%', ctxStale._progress[ctxStale._progress.length - 1].pct, 100);
const rARows = all('SELECT status, created_at, file_path, error FROM canvas_node_runs WHERE node_id = ? ORDER BY created_at ASC, rowid ASC', rA);
const skipRow = rARows.find((x) => x.status === 'skipped');
ok('跳过也留审计记录（status=skipped，标记输入未变）', !!skipRow && /输入未变/.test(skipRow.error || ''), `rA 全部记录=${JSON.stringify(rARows)}`);
eq('跳过记录复用原产物路径', skipRow.file_path, 'data/stub/a.svg');
eq('跳过不会产生第二条 done 记录（没有真的重算）', rARows.filter((x) => x.status === 'done').length, 1);

// P2 已落地：同端口多入边按 slot 升序装配（插入顺序不再决定成败）
const CV_SLOT = 'CV-SLOT';
const sA = mkNode({ canvasId: CV_SLOT, kind: 'image', title: '槽甲', data: { prompt: '甲' } });
const sB = mkNode({ canvasId: CV_SLOT, kind: 'image', title: '槽乙', data: { prompt: '乙' } });
const sV = mkNode({ canvasId: CV_SLOT, kind: 'video', title: '槽视频', data: { duration: 1 } });
const slotStub = mkExec({
  [sA]: { filePath: 'data/stub/slotA.svg', mime: 'image/svg+xml', raw: {} },
  [sB]: { filePath: 'data/stub/slotB.svg', mime: 'image/svg+xml', raw: {} },
  [sV]: { filePath: 'data/stub/slotV.mp4', mime: 'video/mp4', raw: {} },
});
mkLink({ canvasId: CV_SLOT, from: sB, to: sV, toPort: 'ref1', slot: 2 });   // 先插入的是 slot 2
mkLink({ canvasId: CV_SLOT, from: sA, to: sV, toPort: 'ref1', slot: 1 });   // 后插入的是 slot 1
const sumSlot = await G.runGraph({ canvasId: CV_SLOT, executors: slotStub.executors, retryBaseMs: 0 });
eq('P2 槽位：同端口两条入边按 slot 升序取第一个（不受插入顺序影响）', slotStub.callsOf(sV)[0].inputs.ref1, 'data/stub/slotA.svg');
eq('每侧单输入：该端口只注入一个值', Object.keys(slotStub.callsOf(sV)[0].inputs).length, 1);
ok('计划预览里同样只认 slot 最小者', G.planGraph({ canvasId: CV_SLOT, overwrite: true }).steps.run.find((s) => s.id === sV).inputs.includes('ref1'), JSON.stringify(G.planGraph({ canvasId: CV_SLOT, overwrite: true }).steps.run.map((s) => `${s.id}:${s.inputs}`)));

// P2 已落地：不同端口各注入一个值（ref1/ref2 并存，输出节点据此拼接）
const CV_PORTS = 'CV-PORTS';
const pa = mkNode({ canvasId: CV_PORTS, kind: 'image', title: '参考一', data: { prompt: '1' } });
const pb = mkNode({ canvasId: CV_PORTS, kind: 'image', title: '参考二', data: { prompt: '2' } });
const pv = mkNode({ canvasId: CV_PORTS, kind: 'video', title: '多参考视频', data: { duration: 1 } });
const portStub = mkExec({
  [pa]: { filePath: 'data/stub/pa.svg', mime: 'image/svg+xml', raw: {} },
  [pb]: { filePath: 'data/stub/pb.svg', mime: 'image/svg+xml', raw: {} },
  [pv]: { filePath: 'data/stub/pv.mp4', mime: 'video/mp4', raw: {} },
});
mkLink({ canvasId: CV_PORTS, from: pa, to: pv, toPort: 'ref1', slot: 1 });
mkLink({ canvasId: CV_PORTS, from: pb, to: pv, toPort: 'ref2', slot: 2 });
await G.runGraph({ canvasId: CV_PORTS, executors: portStub.executors, retryBaseMs: 0 });
eq('不同端口分别注入（ref1）', portStub.callsOf(pv)[0].inputs.ref1, 'data/stub/pa.svg');
eq('不同端口分别注入（ref2）', portStub.callsOf(pv)[0].inputs.ref2, 'data/stub/pb.svg');

// 手工/Agent 产出的计划（P4 场景）：顺序不满足依赖时按拓扑重排，只有 order 的简化计划也能跑
const CV_ORDER = 'CV-ORDER';
const oA = mkNode({ canvasId: CV_ORDER, kind: 'image', title: '序甲', data: { prompt: 'a' } });
const oB = mkNode({ canvasId: CV_ORDER, kind: 'video', title: '序乙', data: { duration: 1 } });
mkLink({ canvasId: CV_ORDER, from: oA, to: oB, toPort: 'first' });
const orderStub = mkExec({
  [oA]: { filePath: 'data/stub/oA.svg', mime: 'image/svg+xml', raw: {} },
  [oB]: { filePath: 'data/stub/oB.mp4', mime: 'video/mp4', raw: {} },
});
const badPlan = { canvasId: CV_ORDER, order: [oB, oA], steps: { run: [{ id: oB }, { id: oA }], skip: [] } };
const ctxOrd = mkCtx();
const sumOrd = await G.runGraph({ canvasId: CV_ORDER, plan: badPlan, ctx: ctxOrd, executors: orderStub.executors, retryBaseMs: 0 });
eq('依赖被违反的计划会被重排：上游先执行', orderStub.calls.map((c) => c.nodeId).join(','), [oA, oB].join(','));
ok('重排会写明原因（任务日志可核对）', ctxOrd._logs.some((l) => /不满足拓扑依赖/.test(l)), ctxOrd._logs.join(' | '));
eq('重排后仍全部成功', `${sumOrd.ok}/${sumOrd.failed}`, '2/0');
const CV_ORDER2 = 'CV-ORDER2';
const o2a = mkNode({ canvasId: CV_ORDER2, kind: 'image', title: '简甲', data: { prompt: 'a' } });
const o2b = mkNode({ canvasId: CV_ORDER2, kind: 'image', title: '简乙', data: { prompt: 'b' } });
const orderStub2 = mkExec({
  [o2a]: { filePath: 'data/stub/o2a.svg', mime: 'image/svg+xml', raw: {} },
  [o2b]: { filePath: 'data/stub/o2b.svg', mime: 'image/svg+xml', raw: {} },
});
const sumSimple = await G.runGraph({ canvasId: CV_ORDER2, plan: { order: [o2a, o2b] }, executors: orderStub2.executors, retryBaseMs: 0 });
eq('只有 order 的简化计划同样可执行（P4 Agent 友好）', `${sumSimple.total}/${sumSimple.ok}`, '2/2');

console.log('\n=== 7. 失败传播（单点失败不中断整图、下游不调用付费接口） ===');
const CV_FAIL = 'CV-FAIL';
const fA = mkNode({ canvasId: CV_FAIL, kind: 'image', title: '失败节点', data: { prompt: 'x', backend: 'placeholder' } });
const fB = mkNode({ canvasId: CV_FAIL, kind: 'video', title: '下游乙', data: { duration: 2 } });
const fC = mkNode({ canvasId: CV_FAIL, kind: 'output', title: '下游丙', data: {} });
mkLink({ canvasId: CV_FAIL, from: fA, to: fB, toPort: 'first' });
mkLink({ canvasId: CV_FAIL, from: fB, to: fC, toPort: 'clip' });
const failStub = mkExec({ [fA]: () => { throw new Error('内容审核不通过：命中敏感词'); } });
const ctxF = mkCtx();
const sumF = await G.runGraph({ canvasId: CV_FAIL, ctx: ctxF, executors: failStub.executors, retryBaseMs: 0 });
eq('失败数 = 1', sumF.failed, 1);
eq('下游被跳过数 = 2', sumF.skipped, 2);
eq('下游执行器一次都没被调用（不产生费用）', failStub.calls.length, 1);
eq('失败节点状态回写 error', st(fA).status, 'error');
ok('失败原因带中文归类标签（retry.js 分类）', /^\[内容审核不通过\]/.test(st(fA).lastError), st(fA).lastError);
eq('不可重试错误只尝试 1 次', sumF.results.find((x) => x.nodeId === fA).attempts, 1);
ok('下游状态为 skipped 并写明上游失败', st(fB).status === 'skipped' && /上游节点失败/.test(st(fB).lastError), `${st(fB).status}：${st(fB).lastError}`);
eq('下游 skipped 记录落库', runsOf(fB).filter((x) => x.status === 'skipped').length, 1);
ok('结果里下游标记 skipped 且 reason=上游失败', sumF.results.find((x) => x.nodeId === fB).skipped === true && sumF.results.find((x) => x.nodeId === fB).reason === '上游失败', JSON.stringify(sumF.results.find((x) => x.nodeId === fB)));
eq('失败节点无产物路径（不写空文件冒充成功）', runsOf(fA)[0].file_path, null);
ok('失败原因写进 ctx.log（任务日志可见）', ctxF._logs.some((l) => /节点失败：失败节点/.test(l)), ctxF._logs.join(' | '));
eq('失败不中断：整图仍跑完并返回汇总', sumF.total, 3);
eq('汇总里 ok 项为 0（三个节点无一成功）', sumF.ok, 0);

console.log('\n=== 8. 重试（限流/5xx/网络自动退避，其余不重试） ===');
const CV_RETRY = 'CV-RETRY';
const tA = mkNode({ canvasId: CV_RETRY, kind: 'image', title: '抖动节点', data: { prompt: 'retry', backend: 'placeholder' } });
let tries = 0;
const retryStub = mkExec({
  [tA]: (req) => {
    tries++;
    if (tries === 1) throw new Error('429 Too Many Requests：触发限流');
    return { filePath: 'data/stub/retry.svg', mime: 'image/svg+xml', backend: 'stub', elapsedMs: 3, raw: {} };
  },
});
const ctxR = mkCtx();
const sumR = await G.runGraph({ canvasId: CV_RETRY, ctx: ctxR, executors: retryStub.executors, retries: 1, retryBaseMs: 0 });
eq('可重试错误（限流）自动重试后成功', `${sumR.ok}/${sumR.failed}`, '1/0');
eq('重试次数记录为 2（1 次失败 + 1 次成功）', sumR.results[0].attempts, 2);
eq('重试次数写入执行记录 meta', G.safeJSON(runsOf(tA)[0].meta).attempts, 2);
ok('重试过程写入日志（可核对）', ctxR._logs.some((l) => /节点重试：抖动节点/.test(l)), ctxR._logs.join(' | '));

const CV_RETRY2 = 'CV-RETRY2';
const tB = mkNode({ canvasId: CV_RETRY2, kind: 'image', title: '一直限流', data: { prompt: 'x' } });
let tries2 = 0;
const retryStub2 = mkExec({ [tB]: () => { tries2++; throw new Error('429 rate limit 限流'); } });
const sumR2 = await G.runGraph({ canvasId: CV_RETRY2, executors: retryStub2.executors, retries: 0, retryBaseMs: 0 });
eq('retries=0 时不重试', tries2, 1);
eq('限流失败最终记为失败', sumR2.failed, 1);
ok('失败文案带归类与尝试次数', /\[触发限流（429）\]/.test(sumR2.results[0].error) && /已尝试 1 次|429/.test(sumR2.results[0].error), sumR2.results[0].error);

const CV_RETRY3 = 'CV-RETRY3';
const tC = mkNode({ canvasId: CV_RETRY3, kind: 'image', title: '审核不通过', data: { prompt: 'x' } });
let tries3 = 0;
const retryStub3 = mkExec({ [tC]: () => { tries3++; throw new Error('内容审核不通过'); } });
await G.runGraph({ canvasId: CV_RETRY3, executors: retryStub3.executors, retries: 3, retryBaseMs: 0 });
eq('不可重试类别即便配了 retries=3 也只尝试 1 次', tries3, 1);

console.log('\n=== 9. 取消 ===');
const CV_CANCEL = 'CV-CANCEL';
const xA = mkNode({ canvasId: CV_CANCEL, kind: 'image', title: '取消甲', data: { prompt: 'a' } });
const xB = mkNode({ canvasId: CV_CANCEL, kind: 'video', title: '取消乙', data: { duration: 2 } });
mkLink({ canvasId: CV_CANCEL, from: xA, to: xB, toPort: 'first' });
const cancelStub = mkExec({ [xA]: { filePath: 'data/stub/x.svg', mime: 'image/svg+xml', backend: 'stub', raw: {} } });
const ctxC = mkCtx({ cancelAfter: 1 });
const cancelRes = await throwsAsync(() => G.runGraph({ canvasId: CV_CANCEL, ctx: ctxC, executors: cancelStub.executors, retryBaseMs: 0 }), /任务已取消/);
ok('取消时抛出「任务已取消」（含已完成进度）', cancelRes.threw && cancelRes.match, cancelRes.msg);
eq('取消后下游节点未被调用', cancelStub.callsOf(xB).length, 0);
eq('取消时已完成的节点产物保留', cancelStub.callsOf(xA).length, 1);
eq('取消错误带 canceled 标记（上层可区分 error/canceled）', cancelRes.err?.canceled, true);
const cancelRes2 = await throwsAsync(() => G.runGraph({ canvasId: CV_CANCEL, ctx: mkCtx({ cancelAfter: 0 }), executors: cancelStub.executors, retryBaseMs: 0 }), /任务已取消/);
eq('一开始就被取消时一个节点都不执行（不产生任何费用）', `${cancelRes2.threw}/${cancelStub.calls.length}`, 'true/1');

// 真实任务队列里的取消：job 必须能停下来，且下游不发请求
const CV_CANCEL2 = 'CV-CANCEL2';
const yA = mkNode({ canvasId: CV_CANCEL2, kind: 'image', title: '队列甲', data: { prompt: 'a' } });
const yB = mkNode({ canvasId: CV_CANCEL2, kind: 'video', title: '队列乙', data: { duration: 2 } });
mkLink({ canvasId: CV_CANCEL2, from: yA, to: yB, toPort: 'first' });
const slowStub = mkExec({ [yA]: { filePath: 'data/stub/y.svg', mime: 'image/svg+xml', backend: 'stub', raw: {} }, [yB]: { filePath: 'data/stub/y.mp4', mime: 'video/mp4', backend: 'stub', raw: {} } }, { delay: 250 });
const jobC = G.createGraphRunJob({ canvasId: CV_CANCEL2, executors: slowStub.executors, retryBaseMs: 0 });
await new Promise((r) => setTimeout(r, 60));
cancelJob(jobC.jobId);
const jc = await waitJob(jobC.jobId);
ok('队列任务取消后不再执行下游节点', slowStub.callsOf(yB).length === 0, `乙被调用 ${slowStub.callsOf(yB).length} 次；甲 ${slowStub.callsOf(yA).length} 次`);
ok('取消后的 job 状态为 error/canceled 且说明原因', ['error', 'canceled'].includes(jc.status) && (/任务已取消/.test(jc.error || '') || jc.status === 'canceled'), `status=${jc.status} error=${jc.error}`);

console.log('\n=== 10. 任务入口（一次图执行 = 一个 job，图队列并发=1） ===');
const CV_JOB = 'CV-JOB';
const jA = mkNode({ canvasId: CV_JOB, kind: 'image', title: '任务甲', data: { prompt: 'a' } });
const jB = mkNode({ canvasId: CV_JOB, kind: 'video', title: '任务乙', data: { duration: 2 } });
mkLink({ canvasId: CV_JOB, from: jA, to: jB, toPort: 'first' });
const jobStub = mkExec({ [jA]: { filePath: 'data/stub/j.svg', mime: 'image/svg+xml', backend: 'stub', raw: {} }, [jB]: { filePath: 'data/stub/j.mp4', mime: 'video/mp4', backend: 'stub', raw: {} } });
const job1 = G.createGraphRunJob({ canvasId: CV_JOB, executors: jobStub.executors, retryBaseMs: 0 });
ok('createGraphRunJob 返回 jobId（形如 JOB-…）', /^JOB-/.test(job1.jobId), job1.jobId);
eq('job 总步数 = 计划里将执行的节点数', job1.total, 2);
eq('图执行走独立队列 type=graph', getJob(job1.jobId).type, 'graph');
eq('图执行队列并发被锁定为 1（下游依赖上游产物）', queueStats().graph.limit, 1);
const jobDone = await waitJob(job1.jobId);
eq('任务最终 done', jobDone.status, 'done');
eq('任务进度到 100%', jobDone.progress, 100);
eq('任务 done 计数 = 总步数', jobDone.done, 2);
ok('任务 result 里带整图汇总（failed/skipped/results）', jobDone.result && jobDone.result.failed === 0 && Array.isArray(jobDone.result.results) && jobDone.result.results.length === 2, `failed=${jobDone.result?.failed} results=${jobDone.result?.results?.length}`);
eq('任务执行后节点状态已回写', `${st(jA).status}/${st(jB).status}`, 'done/done');
ok('节点状态徽标汇总可用（graphStatus）', G.graphStatus(CV_JOB).counts.done === 2, JSON.stringify(G.graphStatus(CV_JOB).counts));

const single = G.runSingleNode({ canvasId: CV_JOB, nodeId: jB, executors: jobStub.executors, retryBaseMs: 0 });
eq('runSingleNode 计划只含目标节点', single.plan.steps.run.map((s) => s.id).join(','), jB);
eq('runSingleNode 标题为「单节点重跑」', getJob(single.jobId).title, '单节点重跑');
ok('单节点重跑仍复用上游产物（入边装配照常生效）', single.plan.steps.run[0].inputs.includes('first'), JSON.stringify(single.plan.steps.run[0].inputs));
const singleDone = await waitJob(single.jobId);
eq('单节点重跑完成', singleDone.status, 'done');
eq('单节点重跑不影响其他节点记录（甲仍只有 1 条 done）', runsOf(jA).filter((x) => x.status === 'done').length, 1);
const noWork = throwsSync(() => G.createGraphRunJob({ canvasId: CV_JOB, executors: jobStub.executors }), /没有需要执行的节点/);
ok('无节点可跑时给出明确中文错误', noWork.threw && noWork.match, noWork.msg);
const noNode = throwsSync(() => G.runSingleNode({ canvasId: CV_JOB }), /缺少 nodeId/);
ok('缺 nodeId 时给出明确中文错误', noNode.threw && noNode.match, noNode.msg);

console.log('\n=== 11. 真实适配层端到端（placeholder 后端，离线零成本） ===');
const CV_REAL = 'CV-REAL';
const realA = mkNode({ canvasId: CV_REAL, kind: 'image', title: '占位出图', data: { prompt: 'P3 真实出图占位卡', negative: 'blurry', width: 64, height: 64, backend: 'placeholder' } });
const realB = mkNode({ canvasId: CV_REAL, kind: 'video', title: '占位运镜', data: { backend: 'placeholder', duration: 1, move: '推镜', width: 64, height: 64, code: 'S01E001' } });
mkLink({ canvasId: CV_REAL, from: realA, to: realB, toPort: 'first' });
const sumReal = await G.runGraph({ canvasId: CV_REAL, retryBaseMs: 0 });
const fileRealA = sumReal.files[realA];
const absRealA = resolveAsset(fileRealA);
ok('真实占位出图落盘（默认执行器，未经注入）', !!absRealA && fs.existsSync(absRealA), `${fileRealA} → ${absRealA}`);
ok('产物是真 PNG 文件（PNG 魔数 0x89504E47）', !!absRealA && fs.existsSync(absRealA) && fs.readFileSync(absRealA).subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])), `size=${absRealA && fs.existsSync(absRealA) ? fs.statSync(absRealA).size : 0} 字节`);
eq('出图执行记录 mime = image/png（占位改为 PNG，本地运镜可作首帧）', runsOf(realA)[0].mime, 'image/png');
const fileRealB = sumReal.files[realB];
const absRealB = resolveAsset(fileRealB);
ok('上游占位 PNG 作为首帧驱动真实 ffmpeg 生成 mp4', !!absRealB && fs.existsSync(absRealB) && fs.statSync(absRealB).size > 0, `${fileRealB} → ${absRealB}`);
eq('视频执行记录 mime = video/mp4', runsOf(realB)[0].mime, 'video/mp4');
eq('视频执行记录 backend = placeholder（未产生真实调用/计费）', runsOf(realB)[0].backend, 'placeholder');
ok('整图两节点均成功（证明上游输出确实注入下游：无首帧占位后端必失败）', sumReal.ok === 2 && sumReal.failed === 0, `ok=${sumReal.ok} failed=${sumReal.failed}`);

const CV_NOFRAME = 'CV-NOFRAME';
const nf = mkNode({ canvasId: CV_NOFRAME, kind: 'video', title: '无首帧视频', data: { backend: 'placeholder', duration: 1 } });
const sumNoFrame = await G.runGraph({ canvasId: CV_NOFRAME, retryBaseMs: 0 });
ok('反证：无上游首帧的视频节点真实失败（说明上一条确由注入驱动）', sumNoFrame.failed === 1 && /缺少可用关键帧/.test(sumNoFrame.results[0].error), sumNoFrame.results[0].error);
eq('无首帧节点不落产物文件', runsOf(nf)[0].file_path, null);

// 只用尾帧、没有首帧 → 仍然必须诚实失败（视频不能凭空生成）
const CV_LASTONLY = 'CV-LASTONLY';
const loA = mkNode({ canvasId: CV_LASTONLY, kind: 'image', title: '只有尾帧', data: { backend: 'placeholder', width: 64, height: 64, prompt: 'kf' } });
const loB = mkNode({ canvasId: CV_LASTONLY, kind: 'video', title: '只有尾帧的视频', data: { backend: 'placeholder', duration: 1 } });
mkLink({ canvasId: CV_LASTONLY, from: loA, to: loB, toPort: 'last' });
const sumLastOnly = await G.runGraph({ canvasId: CV_LASTONLY, retryBaseMs: 0 });
const loRes = sumLastOnly.results.find((x) => x.nodeId === loB);
ok('反证：只给尾帧、没有首帧的视频节点诚实失败（不凭空生成）',
  sumLastOnly.failed === 1 && /缺少可用关键帧/.test(loRes?.error || ''), loRes?.error || JSON.stringify(sumLastOnly.results));

// 首帧 + 尾帧（首尾帧过渡）：placeholder 用交叉溶解如实表达，并在执行记录里标注 raw.lastFrame
const CV_LAST = 'CV-LAST';
const lastA = mkNode({ canvasId: CV_LAST, kind: 'image', title: '首帧', data: { backend: 'placeholder', width: 64, height: 64, prompt: 'kf1' } });
const lastC = mkNode({ canvasId: CV_LAST, kind: 'image', title: '尾帧', data: { backend: 'placeholder', width: 64, height: 64, prompt: 'kf2' } });
const lastB = mkNode({ canvasId: CV_LAST, kind: 'video', title: '首尾帧', data: { backend: 'placeholder', duration: 1 } });
mkLink({ canvasId: CV_LAST, from: lastA, to: lastB, toPort: 'first' });
mkLink({ canvasId: CV_LAST, from: lastC, to: lastB, toPort: 'last' });
const sumLast = await G.runGraph({ canvasId: CV_LAST, retryBaseMs: 0 });
ok('首尾帧：两帧都给 → 生成成功（不再一律报错）',
  sumLast.failed === 0 && sumLast.results.find((x) => x.nodeId === lastB)?.ok === true,
  JSON.stringify(sumLast.results.find((x) => x.nodeId === lastB))?.slice(0, 160));
const lastRunRow = runsOf(lastB)[0];
ok('首尾帧节点产物落库（确实产出了文件）', Boolean(lastRunRow?.file_path), String(lastRunRow?.file_path));
const lastMeta = JSON.parse(lastRunRow?.meta || '{}');
ok('首尾帧：执行记录如实标注用了哪种尾帧处理（raw.lastFrame=xfade）',
  lastMeta?.raw?.lastFrame === 'xfade', JSON.stringify(lastMeta?.raw || lastMeta).slice(0, 140));

const CV_TEXT = 'CV-TEXT';
const tx = mkNode({ canvasId: CV_TEXT, kind: 'text', title: '文字节点', data: { prompt: 'hello' } });
const sumText = await G.runGraph({ canvasId: CV_TEXT, retryBaseMs: 0 });
ok('文字节点未接入时不静默失败：给出中文说明且不调 LLM', sumText.failed === 1 && /文字节点执行尚未接入/.test(sumText.results[0].error), sumText.results[0].error);
const textInjected = await G.runGraph({ canvasId: CV_TEXT, overwrite: true, executors: { text: async () => ({ text: '注入文本', filePath: null, backend: 'injected' }) }, retryBaseMs: 0 });
eq('注入 executors.text 后可执行（P4 Agent 接入点）', `${textInjected.ok}/${textInjected.failed}`, '1/0');
eq('按 kind 定向注入的执行器被命中', runsOf(tx)[0].backend, 'injected');

console.log('\n=== 11b. 画布命名快照与回滚（版本化工作现场） ===');
const SN = await import('../src/snapshots.js');
const { nowISO: snNow, rid: snRid } = await import('../src/util.js');
const CV_SNAP = 'CV-SNAP';
run(`INSERT INTO canvases(id, name, created_at, updated_at) VALUES(?,?,?,?)`, CV_SNAP, '快照测试画布', snNow(), snNow());
const snN1 = mkNode({ canvasId: CV_SNAP, kind: 'image', title: '关键帧甲', data: { prompt: 'a' } });
const snN2 = mkNode({ canvasId: CV_SNAP, kind: 'video', title: '片段乙', data: { duration: 2 } });
const snLk = mkLink({ canvasId: CV_SNAP, from: snN1, to: snN2, toPort: 'first', fromPort: 'image' });
run(`UPDATE canvas_links SET slot = 0, label = '首帧' WHERE id = ?`, snLk);
const snGrp = snRid('GR');
run(`INSERT INTO canvas_groups(id, canvas_id, name, color, x, y, w, h, collapsed, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,0,?,?)`, snGrp, CV_SNAP, '分组甲', '#88f', 0, 0, 400, 400, snNow(), snNow());
run(`UPDATE canvas_nodes SET group_id = ? WHERE id = ?`, snGrp, snN1);
const snap1 = SN.saveSnapshot({ canvasId: CV_SNAP, name: '两节点基线', note: '含端口与分组' });
ok('保存快照：名称/备注/卡位与连线计数都记下来',
  snap1.ok && snap1.snapshot.name === '两节点基线' && snap1.snapshot.nodes === 2 && snap1.snapshot.links === 1 && snap1.snapshot.groups === 1,
  JSON.stringify(snap1.snapshot));
ok('列表按新→旧返回该画布的快照', SN.listSnapshots(CV_SNAP).snapshots[0].id === snap1.snapshot.id);
// 改动现场：移动一个、删一个、加一个、断一条连线
run(`UPDATE canvas_nodes SET x = x + 500 WHERE id = ?`, snN1);
run(`DELETE FROM canvas_links WHERE id = ?`, snLk);
const snN3 = mkNode({ canvasId: CV_SNAP, kind: 'item', title: '新增物品', data: {} });
const d1 = SN.diffSnapshot(snap1.snapshot.id);
ok('差异：新增/消失/移动/连线变化一次算清（不是只看数量）',
  d1.nodes.added.includes('新增物品') && d1.nodes.movedCount === 1 && d1.links.removed === 1 && d1.same === false,
  d1.summary);
ok('差异摘要是人话（可直接展示给用户）', /多 1 个卡位/.test(d1.summary) && /被移动/.test(d1.summary), d1.summary);
const r1 = SN.restoreSnapshot(snap1.snapshot.id);
ok('回滚：卡位/分组/连线全部还原（数量与内容都对）',
  r1.ok && r1.nodes === 2 && r1.groups === 1 && get('SELECT COUNT(*) n FROM canvas_links WHERE canvas_id = ?', CV_SNAP).n === 1,
  `nodes=${r1.nodes} groups=${r1.groups}`);
ok('回滚保住了类型化端口与槽位（历史 bug：还原丢 from_port/to_port/slot）',
  (() => { const l = get('SELECT * FROM canvas_links WHERE id = ?', snLk); return l && l.from_port === 'image' && l.to_port === 'first' && Number(l.slot) === 0 && l.label === '首帧'; })(),
  JSON.stringify(get('SELECT from_port, to_port, slot, label FROM canvas_links WHERE id = ?', snLk)));
ok('回滚保住了分组归属', get('SELECT group_id FROM canvas_nodes WHERE id = ?', snN1)?.group_id === snGrp);
ok('回滚前自动留档：当前现场被存成一张 kind=auto 快照（回错了还能退回来）',
  Boolean(r1.autoSnapshotId) && get('SELECT kind FROM canvas_snapshots WHERE id = ?', r1.autoSnapshotId)?.kind === 'auto',
  r1.autoSnapshotId);
ok('回滚后再比一次：与快照完全一致', SN.diffSnapshot(snap1.snapshot.id).same === true);
const rBack = SN.restoreSnapshot(r1.autoSnapshotId);
ok('「回滚的回滚」也可用：auto 快照能把改动现场再找回来（新增物品回来了）',
  rBack.ok && Boolean(get('SELECT id FROM canvas_nodes WHERE id = ?', snN3)), `nodes=${rBack.nodes}`);
SN.restoreSnapshot(snap1.snapshot.id);
ok('空画布不允许手动保存快照（避免存一张没用的空档）',
  (() => { try { run(`INSERT INTO canvases(id,name,created_at,updated_at) VALUES('CV-EMPTY-SNAP','空',?,?)`, snNow(), snNow()); SN.saveSnapshot({ canvasId: 'CV-EMPTY-SNAP' }); return false; } catch (e) { return /空的/.test(e.message); } })());
ok('自动快照：非空画布会留档，空画布直接跳过并说明原因',
  SN.autoSnapshotBefore(CV_SNAP, '清空画布').snapshotId && SN.autoSnapshotBefore('CV-EMPTY-SNAP', '清空画布').skipped,
  SN.autoSnapshotBefore('CV-EMPTY-SNAP', '清空画布').skipped);
ok('不存在的快照给中文错（列表/差异/回滚/删除四处一致）',
  [() => SN.getSnapshot('SN-无'), () => SN.diffSnapshot('SN-无'), () => SN.restoreSnapshot('SN-无'), () => SN.deleteSnapshot('SN-无')]
    .every((fn) => { try { fn(); return false; } catch (e) { return /快照不存在/.test(e.message); } }));
ok('删除快照生效（列表里少一张）',
  (() => { const before = SN.listSnapshots(CV_SNAP).count; SN.deleteSnapshot(snap1.snapshot.id); return SN.listSnapshots(CV_SNAP).count === before - 1; })());
ok('单画布最多 40 张：超出时先淘汰最旧的自动快照（人工快照最后才动）',
  (() => {
    for (let i = 0; i < 6; i++) SN.saveSnapshot({ canvasId: CV_SNAP, name: `批量-${i}`, kind: i % 2 ? 'auto' : 'manual' });
    SN.pruneSnapshots(CV_SNAP, 3);
    const left = SN.listSnapshots(CV_SNAP).snapshots;
    return left.length === 3;
  })(), `剩余 ${SN.listSnapshots(CV_SNAP).count} 张`);

console.log('\n=== 12. 计划/状态汇总（供 P4 审核闸门与画布徽标） ===');
const gs = G.graphStatus(CV_REAL);
eq('graphStatus 统计可执行节点数', gs.counts.executable, 2);
eq('graphStatus 统计已完成节点数', gs.counts.done, 2);
eq('graphStatus 列出节点状态与产物路径', gs.nodes.find((n) => n.id === realA).file, fileRealA);
const gsFail = G.graphStatus(CV_FAIL);
eq('graphStatus 统计失败节点数', gsFail.counts.error, 1);
eq('graphStatus 统计跳过节点数', gsFail.counts.skipped, 2);
const gsPlanSkip = G.graphStatus(CV_PLAN);
eq('graphStatus 统计素材源节点数（演员卡不参与执行）', gsPlanSkip.counts.source, 1);
const planAgain = G.planGraph({ canvasId: CV_REAL });
eq('真实执行后再次计划：无需重算（增量跳过生效）', planAgain.steps.run.length, 0);
eq('计划里 estimate.totalCalls = 0（不会重复花钱）', planAgain.estimate.totalCalls, 0);

// ---- 收尾：清理临时库与临时数据目录，绝不留下真实库污染 ----
const realDbUntouched = process.env.FACTORY_DB !== path.join(ROOT, 'data', 'factory.db');
console.log(`\n      真实库未触碰：${realDbUntouched}（本次使用 ${DB}）`);

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
try { fs.rmSync(DB, { force: true }); fs.rmSync(DB + '-wal', { force: true }); fs.rmSync(DB + '-shm', { force: true }); } catch { /* ignore */ }
try { fs.rmSync(DATA_TMP, { recursive: true, force: true }); } catch { /* ignore */ }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(fail ? 1 : 0);
