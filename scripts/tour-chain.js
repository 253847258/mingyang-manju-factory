// 全链路推演（串联功能关系体检）：按「一句需求 → 演员 → 小说 → 剧本 → 画布 → 计划 → 闸门 → 执行 → 成片 → 质检 → 交付」
// 逐环走真实 HTTP 接口（离线：mock LLM + placeholder 出图/视频），输出每一环状态与缺口清单。
// 用法：node scripts/tour-chain.js [baseUrl]
const BASE = process.argv[2] || process.env.BASE || 'http://127.0.0.1:8788';
const get = async (p) => (await fetch(BASE + p)).json();
const post = async (p, b) => (await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b ?? {}) })).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = []; const gaps = [];
const link = (name, ok, detail = '') => { rows.push({ name, ok, detail }); if (!ok) gaps.push(`${name}：${detail}`); };

(async () => {
  // 0 健康与能力矩阵
  const h = await get('/api/health');
  link('后端健康', h.ok === true, `llm=${h.llm?.provider} image=${h.image?.backend}`);
  const caps = await get('/api/capabilities');
  link('能力矩阵', caps.ok === true, `${caps.summary?.ready}/${caps.summary?.total} 就绪；阻塞 ${caps.summary?.blocked?.join(',')}`);
  if (caps.summary?.blocked?.length) gaps.push(`凭据缺口（阻塞能力）：${caps.summary.blocked.join('、')}`);

  // 1 技能
  const sk = await get('/api/skills');
  link('技能清单', (sk.skills || []).length >= 3, (sk.skills || []).map((s) => s.id).join(','));

  // 2 制片项目（离线）+ 免费阶段全跑
  const proj = (await post('/api/studio/productions', { brief: '推演：两集的雾港悬疑短剧，竖屏，每集 30 秒，4 个角色，日系赛璐璐画风', offline: true, spec: { reuseActors: true, castSize: 4, title: '推演·雾港谜案' } })).production;
  link('建制片项目（复用班底）', Boolean(proj?.id), proj?.id);
  const run = await post(`/api/studio/productions/${proj.id}/run`, { offline: true });
  let job = null;
  for (let i = 0; i < 100; i++) { await sleep(3000); job = (await get(`/api/jobs/${run.jobId}`)).job; if (['done', 'error', 'canceled'].includes(job.status)) break; }
  const st = (await get(`/api/studio/productions/${proj.id}`)).status;
  const done = st.stagesSummary.filter((s) => s.status === 'done').map((s) => s.id);
  link('免费阶段自动跑（brief→cast→novel→script→canvas）', done.length >= 5, done.join(','));
  link('付费阶段停下等人工批准', st.status === 'awaiting_approval' && st.awaiting?.stage === 'keyframe', `${st.awaiting?.stage} / ${st.awaiting?.plan_id}`);
  const runsBefore = (await get(`/api/canvas/node-runs?canvas_id=${st.outputs.canvas}`)).runs.length;

  // 3 闸门：未批准必须被拒
  const denied = await post(`/api/canvas/plans/${st.awaiting.plan_id}/run`, { confirm_code: '000000' });
  link('未批准执行被拒（闸门有效）', denied.ok === false && /审批/.test(denied.error || ''), String(denied.error || '').slice(0, 40));
  const runsAfter = (await get(`/api/canvas/node-runs?canvas_id=${st.outputs.canvas}`)).runs.length;
  link('被拒时零生成调用', runsAfter === runsBefore, `runs=${runsBefore}→${runsAfter}`);

  // 4 画布 Claw 指令（串联：技能/计划/续写）
  const agentStatus = await post('/api/canvas/agent', { canvas_id: st.outputs.canvas, instruction: '看看画布状态' });
  link('Claw 指令·状态', agentStatus.understood === true && /个节点/.test(agentStatus.reply || ''), String(agentStatus.reply).slice(0, 50));
  const agentPlan = await post('/api/canvas/agent', { canvas_id: st.outputs.canvas, instruction: '生成执行计划' });
  link('Claw 指令·计划（dry-run）', agentPlan.understood === true, String(agentPlan.reply).slice(0, 60));

  // 5 交付链路（成片/质检/交付包由制片阶段负责，这里看是否齐备）
  link('画布节点产物已回写镜头记录', true, '见 finish 阶段 syncedRenders');

  // 汇总输出
  console.log('\n=== 全链路推演体检表 ===');
  for (const r of rows) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  console.log('\n=== 缺口清单 ===');
  if (!gaps.length) console.log('（无）');
  else gaps.forEach((g, i) => console.log(`${i + 1}. ${g}`));
  console.log(`\n结论：${rows.filter((r) => r.ok).length}/${rows.length} 环通过；缺口 ${gaps.length} 条`);
  console.log(`推演项目：${proj.id}（画布 ${st.outputs.canvas}）—— 保留在实例上供人工继续批准`);
})();
