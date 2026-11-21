// 模块：🎬 制片 Agent —— 自动化制片流水线控制台
//
// 职责：一句话需求 → 阶段清单 → 估算 → 免费阶段执行 → 付费阶段人工审核闸门 → 成片/质检/交付包
// 约定：
//   1. 只使用 ctx 提供的成员（ctx.api / ctx.toast / ctx.confirm / ctx.modal / ctx.watchJob / ctx.meta / ctx.go）。
//   2. 页面**绝不**自行发起出图/视频调用：所有执行都走后端 /api/studio/*，
//      付费阶段（keyframe / video）由后端生成执行计划并停下等待「人工批准 + 确认码」。
//   3. 样式只使用全局 class（btn / card / row / col / small / muted / tag / bar / overlay / modal 等）
//      与必要的内联 style，不引入新的 CSS 文件。
import { el, toast as uiToast, confirmDialog, modal, fmtNum } from '../lib/ui.js';

// ---------------- 静态常量 ----------------
// 阶段字典兜底：/api/studio/stages 不可用时也能把界面画出来（顺序与后端 src/studio.js 一致）
const FALLBACK_STAGES = [
  { id: 'brief', name: '需求解析', paid: false, deps: [], desc: '把一句话需求解析成可执行的制片参数' },
  { id: 'cast', name: '建演员', paid: false, deps: ['brief'], desc: '按参数生成演员档案（姓名/外形/人设/音色）' },
  { id: 'novel', name: '小说与大纲', paid: false, deps: ['cast'], desc: '建小说 + 生成故事框架与分章大纲' },
  { id: 'script', name: '剧本与分镜', paid: false, deps: ['novel'], desc: '建剧本 → 分集规划 → 逐集分镜（纯英文提示词）' },
  { id: 'canvas', name: '画布铺开', paid: false, deps: ['script'], desc: '把每集铺成 关键帧→视频→成片 的节点图（只布局不生成）' },
  { id: 'keyframe', name: '关键帧出图', paid: true, deps: ['canvas'], desc: '渲染全部关键帧（真实出图后端会计费 → 需人工批准）' },
  { id: 'video', name: '视频生成', paid: true, deps: ['keyframe'], desc: '按关键帧生成视频片段（真实视频后端会计费 → 需人工批准）' },
  { id: 'finish', name: '整集成片', paid: false, deps: ['video'], desc: '按 clip1..N 拼接 + 字幕/音轨/叠加轨（本地 ffmpeg）' },
  { id: 'qc', name: '成片质检', paid: false, deps: ['finish'], desc: 'ffmpeg 实测黑帧/静音/响度/流/时长' },
  { id: 'deliver', name: '交付包', paid: false, deps: ['finish'], desc: '打包 zip（成片/字幕/分镜表/EDL/报告/质检）' },
];

const PROD_STATUS = {
  draft: { text: '草稿', tag: '' },
  running: { text: '执行中', tag: 'accent' },
  awaiting_approval: { text: '等待人工批准', tag: 'warn' },
  error: { text: '出错', tag: 'err' },
  done: { text: '已完成', tag: 'ok' },
};

const STAGE_STATUS = {
  pending: { text: '待执行', tag: '' },
  running: { text: '执行中', tag: 'accent' },
  awaiting_approval: { text: '等待人工批准', tag: 'warn' },
  done: { text: '已完成', tag: 'ok' },
  skipped: { text: '已跳过', tag: '' },
  error: { text: '失败', tag: 'err' },
};

const JOB_STATUS = { queued: '排队中', running: '执行中', done: '已完成', error: '失败', canceled: '已取消' };
const COST_NAME = { L: 'L（低）', M: 'M（中）', H: 'H（高）' };
const RATIOS = ['9:16', '16:9', '21:9'];
const EXAMPLE_BRIEF = '拍一部两集的雾港悬疑短剧，竖屏，每集 30 秒，4 个角色，日系赛璐璐画风';

// ---------------- 内联样式池 ----------------
const ST = {
  wrap: { display: 'flex', gap: '12px', height: '100%', minHeight: 0, padding: '10px 12px', boxSizing: 'border-box' },
  side: { width: '274px', flex: '0 0 274px', display: 'flex', flexDirection: 'column', gap: '8px', background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 'var(--radius-lg)', padding: '10px', minHeight: 0 },
  main: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '10px', overflow: 'auto', paddingRight: '2px' },
  dyn: { display: 'flex', flexDirection: 'column', gap: '10px' },
  card: { background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 'var(--radius)', padding: '12px 14px' },
  cardWarn: { background: 'rgba(245,181,68,.08)', border: '1px solid var(--warn)', borderRadius: 'var(--radius)', padding: '12px 14px' },
  cardErr: { background: 'rgba(255,95,109,.08)', border: '1px solid var(--err)', borderRadius: 'var(--radius)', padding: '12px 14px' },
  h: { fontSize: '14px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(132px, 1fr))', gap: '8px' },
  item: { background: 'var(--panel-2)', border: '1px solid var(--line)', borderRadius: '9px', padding: '8px 9px', cursor: 'pointer', transition: '.15s' },
  itemOn: { borderColor: 'var(--accent)', background: 'linear-gradient(90deg, rgba(109,140,255,.16), transparent)' },
  stageRow: { display: 'flex', alignItems: 'center', gap: '8px', padding: '7px 8px', borderRadius: '8px', background: 'var(--panel-2)', border: '1px solid var(--line)', flexWrap: 'wrap' },
  stageRowWait: { borderColor: 'var(--warn)', background: 'rgba(245,181,68,.12)' },
  stageRowErr: { borderColor: 'var(--err)', background: 'rgba(255,95,109,.1)' },
  stageDetail: { margin: '4px 0 8px 12px', padding: '8px 10px', borderLeft: '2px solid var(--line-2)', background: 'var(--bg-2)', borderRadius: '0 8px 8px 0' },
  log: { fontFamily: 'var(--mono)', fontSize: '11.5px', lineHeight: 1.7, background: '#070b12', border: '1px solid var(--line)', borderRadius: '8px', padding: '8px 10px', maxHeight: '170px', overflow: 'auto', color: '#c8d6ee', whiteSpace: 'pre-wrap' },
  pre: { fontFamily: 'var(--mono)', fontSize: '11px', background: '#070b12', border: '1px solid var(--line)', borderRadius: '8px', padding: '8px', maxHeight: '220px', overflow: 'auto', color: '#c8d6ee', margin: '6px 0 0' },
  kv: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 10px', fontSize: '12.5px' },
  code: { fontFamily: 'var(--mono)', background: '#070b12', border: '1px solid var(--line)', borderRadius: '6px', padding: '2px 7px', fontSize: '12px', cursor: 'pointer', color: '#b8c6ff' },
  num: { width: '100%' },
};

// ---------------- 视图状态 ----------------
let C = null;              // ctx
let rootEl = null;         // 挂载根节点
let S = null;              // 视图状态
let stops = [];            // watchJob 停止函数
let timers = [];           // 定时器
let sseStop = null;        // 任务日志 SSE
let finished = new Set();  // 已结算的任务 id（watchJob 回调与 onDone 可能同时触发）

const q = (sel) => (rootEl ? rootEl.querySelector(sel) : null);
const say = (m, t) => { try { (C?.toast || uiToast)(String(m), t || 'info'); } catch { /* ignore */ } };
const s = (v, d = '—') => (v === null || v === undefined || v === '' ? d : String(v));
const nOf = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const pct = (v) => Math.max(0, Math.min(100, Number(v) || 0));

export function unmount() {
  stops.forEach((f) => { try { f(); } catch { /* ignore */ } });
  stops = [];
  timers.forEach((t) => clearTimeout(t));
  timers = [];
  try { sseStop?.(); } catch { /* ignore */ }
  sseStop = null;
  finished = new Set();
  C = null; rootEl = null; S = null;
}

export async function mount(root, ctx) {
  unmount();
  C = ctx || {};
  rootEl = root;
  finished = new Set();
  S = {
    list: [], catalog: FALLBACK_STAGES, catalogLoaded: false, meta: C.meta || null,
    reconcile: null, reconcileSummary: '', reconcileCompare: null, backendFit: null, timeline: null,
    skills: [], skillsLoaded: false,
    pid: null, detail: null, status: null, estimate: null, parseResult: null,
    planDetail: null, planLoading: false, confirmCode: '', gateMsg: '',
    expanded: {}, job: { id: null, title: '', status: null, progress: 0, done: 0, total: 0, error: '', result: null },
    logs: [], logShown: 0, error: '', listError: '', busy: false, loading: true, deferRender: false, detailTimer: 0, _justCreated: null,
  };
  root.innerHTML = '';
  const wrap = el('div', { class: 'st-wrap', style: ST.wrap });
  wrap.append(
    el('aside', { class: 'st-side', id: 'st-side', style: ST.side }),
    el('main', { class: 'st-main', id: 'st-main', style: ST.main }, [
      el('div', { id: 'st-form-box' }),
      el('div', { class: 'st-dyn', id: 'st-dyn', style: ST.dyn }),
    ]),
  );
  root.append(wrap);
  await boot();
}

async function boot() {
  renderAll();
  // 题材/画风字典：优先用外壳注入的 ctx.meta，缺失时自己拉一次 /api/meta（用于填下拉选项）
  if (!S.meta || !Array.isArray(S.meta.styles) || !Array.isArray(S.meta.genres)) {
    try { S.meta = await C.api.get('/api/meta'); } catch { S.meta = S.meta || null; }
  }
  // 技能（Skill）与契约：技能自己声明「现在能不能跑、缺什么、会产出什么、哪些错误可自动重试」
  if (!S.skillsLoaded) {
    try {
      const r = await C.api.get('/api/skills');
      S.skills = Array.isArray(r?.skills) ? r.skills : [];
      S.skillsLoaded = true;
    } catch { S.skills = S.skills || []; }
  }
  q('#st-form-box')?.append(formCard());
  renderContract();   // 技能下拉建好后立刻把契约画出来（缺前置能力时「生成生产计划」直接禁用）
  await Promise.all([loadCatalog(), loadList()]);
  if (S.list.length) await selectProd(S.list[0].id);
  else renderAll();
  attachLogStream();
}

// ---------------- 提示与错误 ----------------
/** 后端接口未挂载时（缺路由的 404 / SPA 回退返回 HTML）给出可读中文原因 */
function errText(e, what) {
  const raw = String(e?.message || e || '未知错误');
  const head = what ? `${what}：` : '';
  if (e?.status === 404 || /^404\b/.test(raw) || /not found/i.test(raw)) {
    return `${head}后端接口未就绪（HTTP 404）—— /api/studio 路由可能尚未挂载`;
  }
  return head + raw;
}

function fail(msg) {
  S.error = String(msg);
  say(S.error, 'err');
  renderDynamic();
}

function logLine(msg, kind) {
  if (!S) return;
  S.logs.push({ at: new Date().toLocaleTimeString('zh-CN', { hour12: false }), msg: String(msg ?? ''), kind: kind || 'info' });
  if (S.logs.length > 500) S.logs.splice(0, S.logs.length - 500);
  appendLogs();
}

// ---------------- 数据 ----------------
async function loadCatalog() {
  try {
    const r = await C.api.get('/api/studio/stages');
    if (Array.isArray(r?.stages) && r.stages.length) { S.catalog = r.stages; S.catalogLoaded = true; }
  } catch { /* 用兜底字典，界面照常渲染 */ }
}

async function loadList() {
  try {
    const r = await C.api.get('/api/studio/productions?limit=50');
    S.list = Array.isArray(r?.productions) ? r.productions : [];
    S.listError = '';
  } catch (e) {
    S.list = [];
    S.listError = errText(e, '制片项目列表加载失败');
    S.error = S.listError;      // 页面内错误条 + toast 同时给出中文原因
    say(S.listError, 'err');
  }
  renderSide();
}

async function selectProd(id) {
  if (S.pid !== id && S._justCreated !== id) S.parseResult = null;
  S._justCreated = null;
  S.pid = id;
  S.planDetail = null;
  S.gateMsg = '';
  S.error = '';
  renderAll();
  await refreshDetail(true);
}

async function refreshDetail(silent) {
  if (!S?.pid) return;
  try {
    const r = await C.api.get(`/api/studio/productions/${encodeURIComponent(S.pid)}`);
    S.detail = r?.production || null;
    S.status = r?.status || null;
    if (S.detail?.estimate) S.estimate = S.detail.estimate;
    S.listError = '';
    loadReconcile();   // 选中项目即拉一次对账（预计 vs 实际），不阻塞主渲染
    loadBackendFit();  // 顺带问一句「这台机器跑得动这一集吗」，把降级建议摆到台面上
    loadTimeline();    // 决策时间线：谁在什么时候做了什么决定
    const awaiting = (S.detail?.stagesSummary || []).find((x) => stageWaiting(x));
    const planId = S.detail?.pending_plan_id || awaiting?.plan_id || null;
    if (planId) await loadPlanDetail(planId);
  } catch (e) {
    if (!silent) fail(errText(e, '制片项目加载失败'));
    else S.error = errText(e, '制片项目加载失败');
  }
  renderAll();
}

async function loadPlanDetail(planId) {
  if (!planId) return;
  S.planLoading = true;
  try {
    const r = await C.api.get(`/api/execute/plans/${encodeURIComponent(planId)}`);
    S.planDetail = r?.plan || null;
    if (Array.isArray(r?.audits)) S.planDetail = { ...S.planDetail, audits: r.audits };
  } catch (e) {
    S.planDetail = null;
    S.gateMsg = errText(e, '执行计划详情读取失败');
  }
  S.planLoading = false;
}

function stageDef(id) {
  return (S?.catalog || FALLBACK_STAGES).find((x) => x.id === id) || null;
}
const stageName = (id) => (id ? (stageDef(id)?.name || id) : '—');
const paidStageIds = () => (S?.catalog || FALLBACK_STAGES).filter((x) => x.paid).map((x) => x.id);

function stageRows() {
  const summary = S?.detail?.stagesSummary;
  if (Array.isArray(summary) && summary.length) return summary;
  return (S?.catalog || FALLBACK_STAGES).map((d) => ({ ...d, status: 'pending', artifact: null, error: null, plan_id: null, job_id: null }));
}

/** 是否处于「等待人工批准」：awaiting_approval，或放行失败后后端把状态改成了 running 但并没有任务在跑 */
function stageWaiting(st) {
  if (!st) return false;
  if (st.status === 'awaiting_approval') return true;
  return !!st.paid && st.status === 'running' && !st.job_id;
}

/** 待人工批准的计划 id（优先项目字段，其次阶段行，最后计划详情） */
function pendingPlan() {
  const rows = stageRows();
  const awaiting = rows.find((x) => stageWaiting(x));
  const planId = S?.detail?.pending_plan_id || awaiting?.plan_id || null;
  return { stage: awaiting?.stage || awaiting?.id || null, planId, stageRow: awaiting || null };
}

// ---------------- 需求表单（只构建一次，避免重渲染打断输入） ----------------
function opt(value, text) { return el('option', { value, text }); }

function selectBox(id, options, extra = {}) {
  return el('select', { id, style: ST.num, ...extra }, [opt('', '自动（从需求推断）'), ...options]);
}

function formCard() {
  const meta = C?.meta || {};
  const styles = Array.isArray(meta.styles) ? meta.styles : [];
  const genres = Array.isArray(meta.genres) ? meta.genres : [];
  const numInput = (id, ph, min, max) => el('input', { id, type: 'number', min: String(min), max: String(max), placeholder: ph, style: ST.num });
  const field = (label, control) => el('label', { class: 'col', style: { gap: '4px', fontSize: '12px', color: 'var(--muted)' } }, [el('span', { text: label }), control]);

  return el('div', { class: 'card', style: ST.card, id: 'st-form' }, [
    el('div', { class: 'row', style: { gap: '10px', flexWrap: 'wrap' } }, [
      el('div', {}, [
        el('div', { style: { fontSize: '16px', fontWeight: 700 } }, ['🎬 制片 Agent']),
        el('div', { class: 'small muted' }, ['一句话需求 → 演员 → 小说 → 剧本 → 画布 → 关键帧 → 视频 → 成片 → 质检 → 交付包']),
      ]),
      el('div', { class: 'grow' }),
      el('span', { class: 'tag warn' }, ['付费阶段：关键帧出图 / 视频生成 需人工批准 + 确认码']),
    ]),
    el('div', { style: { marginTop: '10px' } }, [
      field('一句话需求（必填）', el('textarea', { id: 'st-brief', rows: '3', placeholder: `例如：${EXAMPLE_BRIEF}` })),
    ]),
    el('div', { style: { ...ST.grid, marginTop: '10px' } }, [
      field('题材（可留空）', selectBox('st-genre', genres.map((g) => opt(g.id, g.name || g.id)))),
      field('画风（可留空）', selectBox('st-style', styles.map((x) => opt(x.id, x.name || x.id)))),
      field('比例', el('select', { id: 'st-ratio', style: ST.num }, [opt('', '自动'), ...RATIOS.map((r) => opt(r, r))])),
      field('集数', numInput('st-episodes', '3', 1, 200)),
      field('每集秒数', numInput('st-epsec', '60', 10, 3600)),
      field('角色数', numInput('st-cast', '6', 1, 200)),
      field('要写的章节数', numInput('st-chapters', '0', 0, 20)),
    ]),
    el('div', { style: { ...ST.grid, marginTop: '10px' } }, [
      field('技能 / 流程（Skill，含契约）', el('select', { id: 'st-skill', style: ST.num, onchange: () => { renderContract(); } },
        [opt('', '默认（十阶段）'), ...(S.skills || []).map((k) => opt(k.id, `${k.name || k.id}${k.contract?.ready ? '' : '（前置能力缺失）'}`))])),
    ]),
    el('div', { id: 'st-contract', style: { marginTop: '8px' } }),
    el('div', { class: 'row', style: { marginTop: '10px', gap: '10px', flexWrap: 'wrap' } }, [
      el('label', { class: 'row', style: { gap: '6px', fontSize: '12.5px', cursor: 'pointer' } }, [
        el('input', { id: 'st-offline', type: 'checkbox', checked: true, style: { width: 'auto' } }),
        el('span', { text: '离线试跑（不花模型钱/不连外部服务）' }),
      ]),
      el('div', { class: 'grow' }),
      el('button', { class: 'btn sm', onclick: fillExample }, ['填入示例']),
      el('button', { class: 'btn sm', onclick: clearForm }, ['清空']),
      el('button', { class: 'btn primary', id: 'st-create', onclick: createProduction }, ['🧭 生成生产计划']),
    ]),
    el('div', { class: 'hint small muted', style: { marginTop: '8px' } }, [
      '生成生产计划只会解析需求并建立阶段清单，不会调用任何出图/视频接口；执行时付费阶段会停下等待人工批准。',
    ]),
  ]);
}

// 技能契约面板：就绪/缺口（中文原因）/付费阶段/产出物/可自动重试的错误类别
function currentContract() {
  const id = q('#st-skill')?.value || '';
  if (!id) return null;
  return (S.skills || []).find((k) => k.id === id)?.contract || null;
}

function renderContract() {
  const box = q('#st-contract');
  if (!box) return;
  while (box.firstChild) box.removeChild(box.firstChild);
  const id = q('#st-skill')?.value || '';
  const create = q('#st-create');
  if (!id) {
    if (create) { create.disabled = !!S.busy; create.textContent = '🧭 生成生产计划'; }
    box.appendChild(el('div', { class: 'hint small muted' }, ['未选技能 = 默认十阶段流程（需求→演员→小说→剧本→画布→关键帧→视频→成片→质检→交付包）。']));
    return;
  }
  const sk = (S.skills || []).find((k) => k.id === id);
  const c = sk?.contract;
  if (!c) { box.appendChild(el('div', { class: 'hint small muted' }, ['该技能未提供契约信息（可用 GET /api/skills 查看）。'])); return; }
  const rows = [];
  rows.push(el('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap', alignItems: 'center' } }, [
    el('span', { class: `tag ${c.ready ? 'ok' : 'err'}`, text: c.ready ? '前置能力齐备' : '前置能力缺失' }),
    el('span', { class: 'tag', text: `阶段 ${c.stages.length}` }),
    el('span', { class: `tag ${c.paid.length ? 'warn' : ''}`.trim(), text: c.paid.length ? `付费阶段：${c.paid.join(' / ')}` : '全程免费（本地阶段）' }),
    el('span', { class: 'tag', text: `可自动重试：${(c.retryKinds || []).join(' / ')}` }),
    el('span', { class: 'small muted', text: c.paidHint || '' }),
  ]));
  if (!c.ready) rows.push(el('div', { class: 'small', style: { color: 'var(--err)', marginTop: '6px' } }, [`不可用原因：${c.blockedReason}`]));
  rows.push(el('div', { class: 'small muted', style: { marginTop: '6px' } }, [`产出物（${c.outputs.length}）：${c.outputs.join('；')}`]));
  for (const r of rows) box.appendChild(r);
  if (create) {
    create.disabled = !!S.busy || !c.ready;
    create.textContent = c.ready ? '🧭 生成生产计划' : '前置能力缺失，无法生成';
  }
}

function fillExample() {
  const t = q('#st-brief');
  if (t) t.value = EXAMPLE_BRIEF;
}
function clearForm() {
  const t = q('#st-brief');
  if (t) t.value = '';
}
const offlineOn = () => !!q('#st-offline')?.checked;

function collectSpec() {
  const spec = {};
  const put = (k, v) => { if (v !== null && v !== undefined && v !== '') spec[k] = v; };
  put('genre', q('#st-genre')?.value);
  put('styleId', q('#st-style')?.value);
  put('ratio', q('#st-ratio')?.value);
  put('episodes', nOf(q('#st-episodes')?.value));
  put('episodeSeconds', nOf(q('#st-epsec')?.value));
  put('castSize', nOf(q('#st-cast')?.value));
  put('chaptersToWrite', nOf(q('#st-chapters')?.value));
  return spec;
}

function setBusy(on, label) {
  S.busy = !!on;
  const b = q('#st-create');
  if (b) { b.disabled = !!on; b.textContent = on ? (label || '处理中…') : '🧭 生成生产计划'; }
  if (!on) renderContract();   // 忙完按契约恢复可用态（前置能力缺失时保持禁用）
}

// ---------------- 动作 ----------------
async function createProduction() {
  const brief = String(q('#st-brief')?.value || '').trim();
  const spec = collectSpec();
  if (!brief && !Object.keys(spec).length) { fail('请先写一句话需求（或至少填写一项高级参数）'); return; }
  S.error = '';
  setBusy(true, '解析中…');
  try {
    const r = await C.api.post('/api/studio/productions', { brief, spec, offline: offlineOn(), skill: q('#st-skill')?.value || null });
    const p = r?.production || null;
    if (!p?.id) throw new Error('后端未返回制片项目');
    S.parseResult = { hits: p.parseHits || [], mode: p.parseMode || '', note: p.parseNote || '' };
    S.estimate = r?.estimate || p.estimate || null;
    S._justCreated = p.id;
    logLine(`已生成生产计划 ${p.id}：${p.spec?.title || p.title || '未命名'}`);
    say('生产计划已生成', 'ok');
    await loadList();
    await selectProd(p.id);
  } catch (e) {
    fail(errText(e, '生成生产计划失败'));
  } finally {
    setBusy(false);
    renderDynamic();
  }
}

// Agent 决策时间线：把「人类批准 / Agent 发起 / 系统自动」三类事实摊开（只读，读已落库的审计与阶段记录）
async function loadTimeline() {
  if (!S.pid) { S.timeline = null; return; }
  try {
    const r = await C.api.get(`/api/studio/timeline?productionId=${encodeURIComponent(S.pid)}&limit=40`);
    S.timeline = r?.ok === false ? { error: r.error } : r;
  } catch (e) { S.timeline = { error: e.message }; }
  renderDynamic();
}

const ACTOR_BADGE = { human: ['人类决定', 'warn'], agent: ['Agent', 'accent'], system: ['系统', ''] };

function timelineCard() {
  const tl = S.timeline;
  if (!tl) return null;
  if (tl.error) return el('div', { class: 'card', style: ST.card }, [el('div', { style: ST.h }, ['🧭 决策时间线']), el('div', { class: 'small', style: { color: 'var(--err)', marginTop: '6px' } }, [tl.error])]);
  const s2 = tl.summary || {};
  return el('div', { class: 'card', style: ST.card }, [
    el('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap', alignItems: 'center' } }, [
      el('div', { style: ST.h }, ['🧭 决策时间线']),
      el('span', { class: 'tag', text: `共 ${s2.total || 0} 条` }),
      el('span', { class: 'tag warn', text: `人类决定 ${s2.humanDecisions || 0}` }),
      el('span', { class: 'tag accent', text: `Agent 发起 ${s2.byActor?.agent || 0}` }),
      el('span', { class: 'tag', text: `系统自动 ${s2.byActor?.system || 0}` }),
      el('div', { class: 'grow' }),
      el('button', { class: 'btn xs', onclick: loadTimeline }, ['↻ 刷新']),
    ]),
    el('div', { class: 'small muted', style: { marginTop: '6px' } }, [s(tl.summaryText || '')]),
    el('div', { style: { marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '320px', overflow: 'auto' } },
      (tl.events || []).map((e) => {
        const bd = ACTOR_BADGE[e.actor] || ['系统', ''];
        return el('div', { class: 'row', style: { gap: '8px', alignItems: 'baseline', fontSize: '12.5px' } }, [
          el('span', { class: 'mono small muted', style: { flex: '0 0 108px' }, text: String(e.at || '').slice(5, 16).replace('T', ' ') }),
          el('span', { style: { flex: '0 0 16px' }, text: e.icon || '•' }),
          el('span', { class: `tag ${bd[1]}`.trim(), style: { flex: '0 0 60px', textAlign: 'center' }, text: bd[0] }),
          el('span', { style: { flex: '1', minWidth: '0' }, text: e.title || '' }),
          e.detail ? el('span', { class: 'small muted', style: { flex: '0 0 42%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, text: String(e.detail).slice(0, 90) }) : null,
        ]);
      })),
    el('div', { class: 'small muted', style: { marginTop: '6px' } }, [s(tl.rule || '')]),
  ]);
}

// 工作流能力匹配（LibTV 调研第 6 条）：把实例能力与本集需求对一遍，有降级建议就摆在计划页上（绝不静默）
async function loadBackendFit() {
  const scriptId = S.detail?.script_id || S.detail?.spec?.scriptId || null;
  if (!scriptId) { S.backendFit = null; return; }
  try {
    const r = await C.api.get(`/api/render/backend-fit?scriptId=${encodeURIComponent(scriptId)}`);
    S.backendFit = r?.fit || null;
  } catch { S.backendFit = null; }
  renderDynamic();
}

// 计费口径与对账（LibTV 调研第 7 条）：选中项目时拉一次，把「预计 → 实际 → 差额」和换口径对比画出来
async function loadReconcile() {
  if (!S.pid) return;
  try {
    const r = await C.api.get(`/api/studio/productions/${encodeURIComponent(S.pid)}/reconcile`);
    S.reconcile = r?.reconcile || null;
    S.reconcileSummary = r?.summary || '';
    S.reconcileCompare = r?.compare || null;
  } catch { S.reconcile = null; }
  renderDynamic();
}

async function loadEstimate() {
  if (!S.pid) return;
  try {
    const r = await C.api.post(`/api/studio/productions/${encodeURIComponent(S.pid)}/estimate`, {});
    S.estimate = r?.estimate || S.estimate;
    renderDynamic();
    say('估算已刷新', 'ok');
  } catch (e) {
    fail(errText(e, '估算失败'));
  }
}

function watch(jobId, title) {
  if (!jobId) { fail('后端未返回任务 id'); return; }
  S.job = { id: jobId, title: title || '制片流水线', status: 'queued', progress: 0, done: 0, total: 0, error: '', result: null };
  logLine(`▶ 已提交任务 ${jobId}：${title || ''}`);
  renderDynamic();
  const stop = C.watchJob(jobId, (job) => {
    if (!S || !job) return;
    S.job = { ...S.job, ...job, id: jobId };
    patchJob();
    if (['done', 'error', 'canceled'].includes(job.status)) finishJob(job);
  }, { onDone: (job) => finishJob(job) });
  stops.push(stop);
  if (S.detailTimer) { clearInterval(S.detailTimer); S.detailTimer = 0; }
  S.detailTimer = setInterval(() => { refreshDetail(true); }, 3500);
  timers.push(S.detailTimer);
}

async function finishJob(job) {
  if (!S) return;
  const id = job?.id || S.job.id;
  if (finished.has(id)) return;
  finished.add(id);
  if (S.detailTimer) { clearInterval(S.detailTimer); S.detailTimer = 0; }
  const st = job?.status || 'done';
  const res = job?.result || {};
  if (st === 'error') {
    S.error = `任务失败：${s(job?.error, '未知错误')}`;
    logLine(`✗ 任务失败：${s(job?.error, '未知错误')}`, 'err');
    say(S.error, 'err');
  } else if (st === 'canceled') {
    logLine('任务已取消', 'warn');
  } else {
    const reason = res.reason || res.awaiting?.reason || '';
    if (reason === 'awaiting_approval' || res.awaiting) {
      const stg = res.awaiting?.stage || res.stoppedAt || '';
      logLine(`⏸ 已暂停：等待人工批准（阶段「${stageName(stg)}」）—— 请在下方「人工审核闸门」批准并填入确认码`, 'warn');
      say('已暂停：等待人工批准', 'info');
    } else {
      logLine('✓ 任务完成', 'ok');
      say('任务完成', 'ok');
    }
    if (Array.isArray(res.executed) && res.executed.length) logLine(`本次执行阶段：${res.executed.map(stageName).join(' → ')}`);
  }
  S.job = { ...S.job, ...(job || {}), id };
  const awaitingStage = res.awaiting?.stage || (res.reason === 'awaiting_approval' ? res.stoppedAt : null);
  const governedStages = [...new Set((Array.isArray(res.executed) && res.executed.length
    ? res.executed
    : [res.stage || S.job?.stage]).filter((stage) => stage && stage !== awaitingStage))];
  if (st === 'done' && governedStages.length) {
    try {
      const wb = await C.api.post(`/api/studio/productions/${encodeURIComponent(S.pid)}/governance/writeback`, {
        stages: governedStages, jobId: id, operator: '制片 Agent 自动回写',
      });
      logLine(`🧾 治理回写完成：${governedStages.map(stageName).join(' → ')}（成本/血缘/订单/快照）`, 'ok');
      const skipped = (wb?.results || []).filter((x) => x?.skipped);
      if (skipped.length) logLine(`治理回写跳过 ${skipped.length} 个未完成阶段：${skipped.map((x) => `${stageName(x.stage)}（${x.reason || x.status || '未完成'}）`).join('；')}`, 'warn');
      if (wb?.results?.some((x) => x?.result?.snapshot?.skipped)) logLine('部分阶段没有可冻结的正式资产，已跳过资产快照', 'warn');
    } catch (e) {
      logLine(`治理回写失败（不阻断生产）：${errText(e)}`, 'warn');
    }
  }
  await refreshDetail(true);
  const awaitingAgain = res.reason === 'awaiting_approval' || Boolean(res.awaiting);
  const projectDone = ['done', 'completed', 'delivered'].includes(String(S.detail?.status || '').toLowerCase());
  if (st === 'done' && !awaitingAgain && !projectDone && !S.autoContinueInFlight && S.pid) {
    S.autoContinueInFlight = true;
    logLine('⚙ 审批已放行，任务完成，自动继续到下一闸门…', 'ok');
    const timer = setTimeout(async () => {
      try { await startRun(); }
      catch (e) { fail(errText(e, '自动续跑失败')); }
      finally { S.autoContinueInFlight = false; }
    }, 900);
    timers.push(timer);
  }
}

async function startRun() {
  if (!S.pid) return;
  S.error = '';
  try {
    const r = await C.api.post(`/api/studio/productions/${encodeURIComponent(S.pid)}/run`, { offline: offlineOn() });
    logLine('▶ 开始执行（免费阶段）');
    if (Array.isArray(r?.executed) && r.executed.length) logLine(`后端返回已执行：${r.executed.map(stageName).join(' → ')}`);
    if (r?.reason === 'awaiting_approval' || r?.awaiting) logLine(`⏸ 后端提示需人工批准：${stageName(r.awaiting?.stage || r.stoppedAt)}`, 'warn');
    watch(r?.jobId, `制片流水线 · ${S.detail?.spec?.title || S.detail?.title || S.pid}`);
  } catch (e) {
    fail(errText(e, '开始执行失败'));
  }
}

async function runOneStage(stageId) {
  if (!S.pid) return;
  S.error = '';
  try {
    const r = await C.api.post(`/api/studio/productions/${encodeURIComponent(S.pid)}/stage/${encodeURIComponent(stageId)}`, { force: true, offline: offlineOn() });
    logLine(`↻ 重跑阶段「${stageName(stageId)}」→ 任务 ${s(r?.jobId)}`);
    watch(r?.jobId, `制片阶段 · ${stageName(stageId)}`);
  } catch (e) {
    fail(errText(e, `重跑阶段「${stageName(stageId)}」失败`));
  }
}

async function approvePlan() {
  const { planId } = pendingPlan();
  if (!planId) { fail('当前没有待批准的执行计划'); return; }
  S.gateMsg = '';
  try {
    await C.api.post(`/api/execute/plans/${encodeURIComponent(planId)}/approve`, { confirm: true, operator: 'human' });
    S.gateMsg = '';
    logLine(`✅ 计划 ${planId} 已批准（人工）`);
    say('计划已批准，请填入服务端终端打印的 6 位确认码后点「▶ 继续执行」', 'ok');
    await loadPlanDetail(planId);
    renderDynamic();
  } catch (e) {
    S.gateMsg = errText(e, '批准计划失败');
    S.error = S.gateMsg;
    say(S.gateMsg, 'err');
    renderDynamic();
  }
}

async function rejectPlan() {
  const { planId } = pendingPlan();
  if (!planId) { fail('当前没有待批准的执行计划'); return; }
  const ok = await (C?.confirm || confirmDialog)(`确定拒绝执行计划 ${planId} 吗？拒绝后该付费阶段不会执行。`, { title: '拒绝计划', okText: '拒绝', cancelText: '取消' });
  if (!ok) return;
  S.gateMsg = '';
  try {
    await C.api.post(`/api/execute/plans/${encodeURIComponent(planId)}/reject`, { operator: 'human', reason: '人工拒绝（制片 Agent 控制台）' });
    logLine(`⛔ 计划 ${planId} 已被人工拒绝`, 'warn');
    say('计划已拒绝', 'info');
    await loadPlanDetail(planId);
    await refreshDetail(true);
  } catch (e) {
    S.gateMsg = errText(e, '拒绝计划失败');
    S.error = S.gateMsg;
    say(S.gateMsg, 'err');
    renderDynamic();
  }
}

async function resumeStage() {
  if (!S.pid) return;
  const { planId } = pendingPlan();
  const code = String(S.confirmCode || q('#st-code')?.value || '').trim();
  if (!planId) { fail('当前没有待放行的执行计划'); return; }
  if (!code) { S.gateMsg = '请先填入服务端终端打印的 6 位确认码'; say(S.gateMsg, 'err'); renderDynamic(); return; }
  S.gateMsg = '';
  try {
    const r = await C.api.post(`/api/studio/productions/${encodeURIComponent(S.pid)}/resume`, { plan_id: planId, confirm_code: code });
    logLine(`▶ 已放行计划 ${planId}（共 ${s(r?.total)} 个节点）→ 任务 ${s(r?.jobId)}`);
    say('放行成功，付费阶段开始执行', 'ok');
    S.confirmCode = '';
    const inp = q('#st-code');
    if (inp) inp.value = '';
    watch(r?.jobId, `付费阶段 · ${stageName(r?.stage)}`);
  } catch (e) {
    S.gateMsg = errText(e, '继续执行失败');
    S.error = S.gateMsg;
    say(S.gateMsg, 'err');
    renderDynamic();
  }
}

async function delProduction(p) {
  const ok = await (C?.confirm || confirmDialog)(`确定删除制片项目「${p.title || p.id}」吗？\n只删除制片记录，演员/小说/剧本/画布/成片等产物全部保留。`, { title: '删除制片项目', okText: '删除', cancelText: '取消' });
  if (!ok) return;
  try {
    await C.api.del(`/api/studio/productions/${encodeURIComponent(p.id)}`);
    logLine(`🗑 已删除制片项目 ${p.id}`);
    say('已删除制片记录', 'ok');
    if (S.pid === p.id) { S.pid = null; S.detail = null; S.planDetail = null; }
    await loadList();
    if (!S.pid && S.list.length) await selectProd(S.list[0].id);
    else renderAll();
  } catch (e) {
    fail(errText(e, '删除失败'));
  }
}

async function copyText(text, label) {
  const v = String(text ?? '');
  if (!v) return;
  try {
    await navigator.clipboard.writeText(v);
    say(`已复制${label ? ' ' + label : ''}：${v}`, 'ok');
  } catch {
    try {
      const ta = el('textarea', { value: v, style: { position: 'fixed', left: '-9999px' } });
      document.body.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      say(`已复制${label ? ' ' + label : ''}：${v}`, 'ok');
    } catch { say(`复制失败，请手动复制：${v}`, 'err'); }
  }
}

async function openDelivery() {
  if (!S.pid) return;
  try {
    const gate = await C.api.get(`/api/studio/productions/${encodeURIComponent(S.pid)}/delivery-gate`);
    logLine(`🔒 交付门禁通过：${gate.episodes?.length || 0} 集均已锁版并完成 QC`, 'ok');
    const url = `/api/studio/productions/${encodeURIComponent(S.pid)}/delivery`;
    window.open(url, '_blank');
  } catch (e) {
    const gate = e?.data || e?.detail || {};
    const msg = `交付被拦截${gate.gate ? `（${gate.gate}）` : ''}：${gate.error || e.message || '未知原因'}`;
    S.gateMsg = msg;
    logLine(`⛔ ${msg}`, 'err');
    say(msg, 'err');
    renderDynamic();
  }
}

function itemMenu(ev, p) {
  const menu = el('div', { class: 'ctx-menu', style: { position: 'fixed', left: `${ev.clientX}px`, top: `${ev.clientY}px`, zIndex: 200, background: 'var(--panel)', border: '1px solid var(--line-2)', borderRadius: '9px', padding: '5px', boxShadow: 'var(--shadow)', minWidth: '170px' } });
  const mi = (label, fn) => el('div', { class: 'mi', style: { padding: '6px 9px', borderRadius: '6px', cursor: 'pointer', fontSize: '12.5px' }, onclick: () => { menu.remove(); fn(); } }, [label]);
  menu.append(
    mi('📂 打开该项目', () => selectProd(p.id)),
    mi('📦 下载交付包', () => { S.pid = p.id; openDelivery(); }),
    el('div', { style: { height: '1px', background: 'var(--line)', margin: '4px 2px' } }),
    mi('🗑 删除制片记录', () => delProduction(p)),
  );
  document.body.append(menu);
  const close = (e) => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', close); } };
  setTimeout(() => document.addEventListener('click', close), 0);
}

function showPlanModal() {
  const { planId } = pendingPlan();
  const plan = S.planDetail;
  const steps = plan?.plan?.steps || {};
  const run = Array.isArray(steps.run) ? steps.run : [];
  const skip = Array.isArray(steps.skip) ? steps.skip : [];
  const audits = Array.isArray(plan?.audits) ? plan.audits : [];
  const body = el('div', { class: 'col', style: { gap: '8px' } }, [
    el('div', { class: 'small' }, [`计划 id：${s(planId)}　状态：${s(plan?.status)}　成本级：${COST_NAME[String(plan?.cost_level || '').toUpperCase()] || s(plan?.cost_level)}`]),
    el('div', { class: 'small muted' }, [`掩码确认码：${s(plan?.confirm_code_masked)}（确认码只打印在服务端终端日志）`]),
    el('div', { class: 'small' }, [`待执行 ${run.length} 个节点，可跳过 ${skip.length} 个`]),
    el('div', { style: { maxHeight: '220px', overflow: 'auto', border: '1px solid var(--line)', borderRadius: '8px', padding: '6px 8px' } },
      run.length ? run.map((x, i) => el('div', { class: 'small', style: { fontFamily: 'var(--mono)' } }, [`${i + 1}. ${s(x.title || x.id, '（未命名节点）')}`])) : [el('div', { class: 'small muted' }, ['没有待执行节点'])]),
    audits.length ? el('div', { class: 'small muted' }, [`审批记录：${audits.map((a) => `${s(a.action || a.status)}@${s(a.by)}`).join('、')}`]) : null,
    el('pre', { class: 'code', style: ST.pre, text: JSON.stringify({ steps: { run: run.length, skip: skip.length }, plan: plan?.plan_id || planId }, null, 2) }),
  ]);
  (C?.modal || modal)({ title: `📋 执行计划 ${s(planId)}`, body, width: 620 });
}

// ---------------- 渲染 ----------------
function renderAll() {
  renderSide();
  renderDynamic();
}

function renderSide() {
  const box = q('#st-side');
  if (!box || !S) return;
  box.innerHTML = '';
  const items = (S.list || []).map(sideItem);
  box.append(
    el('div', { class: 'row', style: { gap: '8px' } }, [
      el('div', { style: { flex: 1, minWidth: 0 } }, [
        el('div', { style: { fontSize: '14px', fontWeight: 700 } }, ['🎬 制片 Agent']),
        el('div', { class: 'small muted' }, [`${(S.list || []).length} 个制片项目${S.catalogLoaded ? '' : '（阶段字典离线兜底）'}`]),
      ]),
      el('button', { class: 'btn xs', title: '刷新列表', onclick: () => loadList() }, ['↻']),
    ]),
    el('button', { class: 'btn sm', onclick: () => { S.pid = null; S.detail = null; S.planDetail = null; S.error = ''; renderAll(); } }, ['＋ 新建制片项目']),
    el('div', { class: 'scroll', id: 'st-list', style: { flex: 1, display: 'flex', flexDirection: 'column', gap: '6px' } },
      items.length ? items : [el('div', { class: 'small muted', style: { padding: '8px 4px', lineHeight: 1.7 } }, [
        S.listError ? S.listError : '还没有制片项目。在右侧写一句话需求，点「🧭 生成生产计划」即可创建第一条流水线。',
      ])]),
  );
}

function sideItem(p) {
  const on = p.id === S.pid;
  const st = PROD_STATUS[p.status] || { text: s(p.status, '—'), tag: '' };
  return el('div', {
    class: 'st-item' + (on ? ' st-on' : ''),
    style: { ...ST.item, ...(on ? ST.itemOn : {}) },
    title: `${s(p.title, '未命名制片')}\n${s(p.brief, '')}\n左键切换 · 右键更多操作`,
    onclick: () => selectProd(p.id),
    oncontextmenu: (e) => { e.preventDefault(); itemMenu(e, p); },
  }, [
    el('div', { class: 'row', style: { gap: '6px' } }, [
      el('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600, fontSize: '12.5px' }, text: s(p.title, '未命名制片') }),
      el('span', { class: `tag ${st.tag}`.trim(), text: st.text }),
    ]),
    el('div', { class: 'bar', style: { marginTop: '6px' } }, [el('i', { style: { width: `${pct(p.progress)}%` } })]),
    el('div', { class: 'small muted', style: { marginTop: '4px', display: 'flex', gap: '8px', flexWrap: 'wrap' } }, [
      el('span', { text: `${pct(p.progress)}%` }),
      el('span', { text: `阶段：${(p.status === 'draft' && !pct(p.progress)) ? '未开始' : stageName(p.current_stage)}` }),
      el('span', { text: `${(Array.isArray(p.actor_ids) ? p.actor_ids.length : 0)} 演员` }),
    ]),
  ]);
}

function renderDynamic() { if (S?.deferRender) return; renderMain(); }

function renderMain() {
  const box = q('#st-dyn');
  if (!box || !S) return;
  box.innerHTML = '';
  const nodes = [errorBar()];
  if (!S.pid || !S.detail) {
    nodes.push(emptyCard());
    if (S.estimate && !S.pid) nodes.push(estimateCard());
    nodes.push(stagesCard());     // 没有选中项目时也展示阶段清单（便于先了解流水线）
  } else {
    nodes.push(headerCard(), estimateCard(), backendFitCard(), timelineCard());
    if (S.parseResult?.hits?.length) nodes.push(parseCard());
    nodes.push(runCard());
    const gate = gateCard();
    if (gate) nodes.push(gate);
    nodes.push(stagesCard(), outputsCard());
  }
  nodes.filter(Boolean).forEach((x) => box.append(x));
}

function errorBar() {
  if (!S.error) return null;
  return el('div', { class: 'card', style: ST.cardErr }, [
    el('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } }, [
      el('span', { style: { fontWeight: 700, color: 'var(--err)' } }, ['⚠ 出错']),
      el('span', { class: 'small', style: { flex: 1, minWidth: '200px' } }, [S.error]),
      el('button', { class: 'btn xs', onclick: () => { S.error = ''; renderDynamic(); } }, ['关闭']),
    ]),
  ]);
}

function emptyCard() {
  return el('div', { class: 'card', style: ST.card }, [
    el('div', { style: ST.h }, ['🫙 还没有选中制片项目']),
    el('div', { class: 'small muted', style: { marginTop: '8px', lineHeight: 1.8 } }, [
      '1) 在上方填写一句话需求（可加题材/画风/集数等高级参数）；',
      el('br'),
      '2) 点「🧭 生成生产计划」→ 后端解析需求并建立 10 个阶段的清单；',
      el('br'),
      '3) 点「🚀 一键开始生产」自动跑免费阶段；遇到付费阶段会停下等待人工批准；',
      el('br'),
      '4) 在「人工审核闸门」点「✅ 批准计划」，再看服务端终端打印的 6 位确认码，填入后点「▶ 继续执行」；',
      el('br'),
      '5) 每次批准并输入确认码后，系统会自动继续到下一闸门，最终完成成片 → 质检 → 交付包。',
    ]),
    S.listError ? el('div', { class: 'small', style: { marginTop: '8px', color: 'var(--err)' } }, [S.listError]) : null,
  ]);
}

function headerCard() {
  const p = S.detail;
  const st = PROD_STATUS[p.status] || { text: s(p.status, '—'), tag: '' };
  const spec = p.spec || {};
  // 新建但还没跑过的项目，后端 current_stage 会落在最后一个阶段，这里显示「未开始」更直观
  const curLabel = (p.status === 'draft' && !pct(p.progress)) ? '未开始' : stageName(p.current_stage);
  const kv = [
    ['剧名', s(spec.title, p.title)],
    ['题材', s(spec.genreName || spec.genre, '（未指定）')],
    ['画风', s(spec.styleName)],
    ['比例', s(spec.ratio)],
    ['集数 × 每集', `${s(spec.episodes)} 集 × ${s(spec.episodeSeconds)} 秒`],
    ['角色数', s(spec.castSize)],
    ['目标字数', fmtNum(spec.targetWords)],
    ['要写章节', `${s(spec.chaptersToWrite, 0)} 章`],
    ['当前阶段', curLabel],
    ['创建时间', s(p.created_at)],
  ];
  return el('div', { class: 'card', style: ST.card }, [
    el('div', { class: 'row', style: { gap: '10px', flexWrap: 'wrap' } }, [
      el('div', { style: { flex: 1, minWidth: '200px' } }, [
        el('div', { style: { fontSize: '15px', fontWeight: 700 } }, [`${s(p.title, '未命名制片')}　`, el('span', { class: 'small muted', style: { fontFamily: 'var(--mono)' } }, [s(p.id)])]),
        el('div', { class: 'small muted', style: { marginTop: '4px', lineHeight: 1.6 } }, [s(p.brief, '（无需求描述）')]),
      ]),
      el('span', { class: `tag ${st.tag}`.trim(), text: st.text }),
      el('button', { class: 'btn sm', onclick: () => refreshDetail(false) }, ['↻ 刷新状态']),
      el('button', { class: 'btn sm danger', onclick: () => delProduction(p) }, ['🗑 删除']),
    ]),
    el('div', { class: 'bar', style: { marginTop: '10px' } }, [el('i', { style: { width: `${pct(p.progress)}%` } })]),
    el('div', { class: 'small muted', style: { marginTop: '4px' } }, [`进度 ${pct(p.progress)}%　·　当前阶段 ${curLabel}　·　状态 ${st.text}`]),
    el('div', { style: { ...ST.kv, marginTop: '10px', gridTemplateColumns: 'auto auto auto auto' } },
      kv.map(([k, v]) => el('div', { class: 'small muted' }, [`${k}：`, el('b', { style: { color: 'var(--text)', fontWeight: 600 } }, [v])]))),
    Array.isArray(p.warnings) && p.warnings.length
      ? el('div', { class: 'small', style: { marginTop: '8px', color: 'var(--warn)' } }, [`提示：${p.warnings.join('；')}`])
      : null,
  ]);
}

// 后端能力匹配卡片：只在「有需要降级/跑不通」时出现，避免刷屏
function backendFitCard() {
  const fit = S.backendFit;
  if (!fit || (!fit.degraded && fit.ready)) return null;
  const tone = fit.ready ? ST.cardWarn : ST.cardErr;
  return el('div', { class: 'card', style: tone }, [
    el('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap', alignItems: 'center' } }, [
      el('div', { style: ST.h }, [fit.ready ? '🧩 后端能力匹配：有需要降级处理的地方' : '🧩 后端能力匹配：当前后端跑不通']),
      el('span', { class: `tag ${fit.ready ? 'warn' : 'err'}`, text: `后端 ${fit.backend}` }),
      el('div', { class: 'grow' }),
      S.detail?.script_id ? el('button', { class: 'btn xs', onclick: loadBackendFit }, ['↻ 重新匹配']) : null,
    ]),
    el('div', { class: 'small', style: { marginTop: '6px' } }, [s(fit.summary)]),
    el('div', { style: { marginTop: '6px' } }, (fit.checks || []).filter((c) => c.level !== 'ok').map((c) => el('div', { class: 'small', style: { marginTop: '3px' } }, [
      el('span', { text: `${c.level === 'block' ? '⛔' : c.level === 'warn' ? '⚠️' : 'ℹ️'} ${c.message}` }),
      c.suggestion ? el('div', { class: 'small muted', style: { marginLeft: '14px' } }, [`→ ${c.suggestion}`]) : null,
    ]))),
  ]);
}

function estimateCard() {
  const e = S.estimate;
  if (!e) {
    return el('div', { class: 'card', style: ST.card }, [
      el('div', { style: ST.h }, ['💰 成本估算']),
      el('div', { class: 'small muted', style: { marginTop: '6px' } }, ['暂无估算数据（生成生产计划后会自动估算）。']),
      S.pid ? el('div', { style: { marginTop: '8px' } }, [el('button', { class: 'btn sm', onclick: loadEstimate }, ['↻ 重新估算'])]) : null,
    ]);
  }
  const lvl = String(e.costLevel || '').toUpperCase();
  const tag = lvl === 'H' ? 'err' : lvl === 'M' ? 'warn' : 'ok';
  return el('div', { class: 'card', style: ST.card }, [
    el('div', { class: 'row', style: { gap: '10px', flexWrap: 'wrap' } }, [
      el('div', { style: ST.h }, ['💰 成本估算']),
      el('span', { class: `tag ${tag}`.trim(), text: `成本级 ${COST_NAME[lvl] || s(e.costLevel)}` }),
      el('div', { class: 'grow' }),
      S.pid ? el('button', { class: 'btn xs', onclick: loadEstimate }, ['↻ 刷新估算']) : null,
    ]),
    el('div', { style: { marginTop: '8px', fontSize: '14px', fontWeight: 600 } }, [
      `关键帧 ${fmtNum(e.keyframeCalls)} 次 + 视频 ${fmtNum(e.videoCalls)} 次 = ${fmtNum(e.totalCalls)} 次调用`,
    ]),
    el('div', { class: 'small muted', style: { marginTop: '6px', display: 'flex', gap: '12px', flexWrap: 'wrap' } }, [
      el('span', { text: `预计金额：${s(e.currency, 'CNY')} ${fmtNum(e.amount)}` }),
      el('span', { text: `共 ${s(e.episodes)} 集 · 每集约 ${s(e.shotsPerEpisode)} 镜 · 共 ${s(e.shots)} 镜` }),
      el('span', { text: `付费阶段：${(e.paidStages || paidStageIds()).map(stageName).join(' / ') || '—'}` }),
    ]),
    e.note ? el('div', { class: 'small muted', style: { marginTop: '6px' } }, [s(e.note)]) : null,
    // 口径 + 对账（LibTV 调研第 7 条）：预计 vs 实际（实际按真实产出统计）+ 换口径对比
    el('div', { class: 'row', style: { marginTop: '8px', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } }, [
      el('span', { class: `tag ${e.mode === 'perSecond' ? 'warn' : 'accent'}`.trim(), text: e.mode === 'perSecond' ? '口径：按秒（含分辨率阶梯）' : '口径：按次' }),
      S.reconcileCompare ? el('span', { class: 'small muted', text: `换口径对比：按次 ${fmtNum(S.reconcileCompare.perCall?.amount)} / 按秒 ${fmtNum(S.reconcileCompare.perSecond?.amount)} ${s(S.reconcileCompare.currency, 'CNY')}` }) : null,
      S.pid ? el('button', { class: 'btn xs', onclick: loadReconcile }, ['🧾 对账']) : null,
    ]),
    S.reconcile
      ? el('div', { style: { marginTop: '6px' } }, [
        el('div', { class: 'small', style: { fontWeight: 600 } }, [s(S.reconcileSummary)]),
        el('div', { class: 'small muted', style: { marginTop: '4px' } }, [s(S.reconcile.note)]),
        el('div', { class: 'row', style: { marginTop: '6px', gap: '6px', flexWrap: 'wrap' } }, (S.reconcile.lines || []).map((l) => el('span', {
          class: `tag ${l.actual > l.estimate ? 'err' : l.actual < l.estimate ? '' : 'ok'}`.trim(),
          text: `${l.item} ${l.estimate}→${l.actual}${l.unit}`,
        }))),
      ])
      : null,
  ]);
}

function parseCard() {
  const pr = S.parseResult || {};
  return el('div', { class: 'card', style: ST.card }, [
    el('div', { style: ST.h }, ['🧭 需求解析结果']),
    el('div', { class: 'small muted', style: { marginTop: '6px' } }, [`解析模式：${pr.mode === 'offline' ? '离线规则（不花模型钱）' : '大模型解析'}`]),
    pr.hits?.length
      ? el('div', { class: 'row', style: { marginTop: '8px', gap: '6px', flexWrap: 'wrap' } }, pr.hits.map((h) => el('span', { class: 'tag accent', text: s(h) })))
      : el('div', { class: 'small muted', style: { marginTop: '8px' } }, ['没有命中显式参数，已按默认值解析（可在高级参数里覆盖）']),
    pr.note ? el('div', { class: 'small muted', style: { marginTop: '6px' } }, [s(pr.note)]) : null,
  ]);
}

function runCard() {
  const job = S.job || {};
  const running = ['queued', 'running'].includes(job.status);
  const paused = stageRows().find((x) => stageWaiting(x));
  const p = S.detail || {};
  return el('div', { class: 'card', style: ST.card }, [
    el('div', { class: 'row', style: { gap: '10px', flexWrap: 'wrap' } }, [
      el('div', { style: ST.h }, ['▶ 执行']),
      job.status ? el('span', { class: 'tag ' + (job.status === 'error' ? 'err' : job.status === 'done' ? 'ok' : 'accent'), text: `${s(job.title, '任务')}：${JOB_STATUS[job.status] || s(job.status)}` }) : null,
      el('div', { class: 'grow' }),
      el('button', { class: 'btn primary sm', disabled: running, onclick: startRun }, [running ? '执行中…' : '🚀 一键开始生产']),
      el('button', { class: 'btn sm', onclick: () => window.open(`/api/jobs/${encodeURIComponent(job.id)}`, '_blank'), disabled: !job.id }, ['查看任务 JSON']),
    ]),
    running || job.status ? el('div', { style: { marginTop: '10px' } }, [
      el('div', { class: 'bar' }, [el('i', { class: 'st-prog-i', style: { width: `${pct(job.progress)}%` } })]),
      el('div', { class: 'small muted st-prog-text', style: { marginTop: '4px' } }, [`进度 ${Number(job.done) || 0}/${Number(job.total) || 0}　·　${pct(job.progress)}%　·　${JOB_STATUS[job.status] || s(job.status, '未开始')}`]),
    ]) : el('div', { class: 'small muted', style: { marginTop: '8px' } }, ['尚未执行。点上方按钮从「需求解析」开始顺序跑免费阶段。']),
    paused ? el('div', { style: { ...ST.cardWarn, marginTop: '10px' } }, [
      el('div', { style: { fontWeight: 700, color: 'var(--warn)' } }, [`⏸ 已暂停：等待人工批准（阶段「${stageName(paused.stage || paused.id)}」）`]),
      el('div', { class: 'small', style: { marginTop: '4px' } }, ['该阶段会产生真实调用与费用，后端已生成执行计划并停下。请在下方「人工审核闸门」批准并填入确认码。']),
    ]) : null,
    p.status === 'awaiting_approval' && !paused ? el('div', { class: 'small', style: { marginTop: '8px', color: 'var(--warn)' } }, ['项目状态为「等待人工批准」，请在下方闸门面板处理。']) : null,
    (() => {
      const stale = stageRows().filter((x) => x.paid && x.status === 'running' && x.job_id && S.job?.id === x.job_id && ['done', 'error', 'canceled'].includes(S.job.status));
      if (!stale.length) return null;
      return el('div', { class: 'small', style: { marginTop: '8px', color: 'var(--warn)', lineHeight: 1.7 } }, [
        `付费阶段「${stale.map((x) => stageName(x.id)).join('、')}」的任务已结束（${JOB_STATUS[S.job.status] || s(S.job.status)}），但后端阶段状态仍为「执行中」、未回写「已完成」。`,
        el('br'),
        '系统会自动继续到下一闸门；只有新的付费阶段需要再次人工批准。',
      ]);
    })(),
    el('div', { class: 'label small muted', style: { marginTop: '10px' } }, ['执行日志']),
    (() => { S.logShown = (S.logs || []).length; return el('div', { class: 'st-log', id: 'st-log', style: ST.log }, (S.logs || []).map((l) => logNode(l))); })(),
  ]);
}

function logNode(l) {
  const color = l.kind === 'err' ? 'var(--err)' : l.kind === 'warn' ? 'var(--warn)' : l.kind === 'ok' ? 'var(--ok)' : '#c8d6ee';
  return el('div', { style: { color } }, [`[${l.at}] ${l.msg}`]);
}

function appendLogs() {
  const box = q('#st-log');
  if (!box || !S) return;
  for (let i = S.logShown; i < S.logs.length; i++) box.append(logNode(S.logs[i]));
  S.logShown = S.logs.length;
  box.scrollTop = box.scrollHeight;
}

function patchJob() {
  const job = S.job || {};
  const bar = q('.st-prog-i');
  if (bar) bar.style.width = `${pct(job.progress)}%`;
  const txt = q('.st-prog-text');
  if (txt) txt.textContent = `进度 ${Number(job.done) || 0}/${Number(job.total) || 0}　·　${pct(job.progress)}%　·　${JOB_STATUS[job.status] || s(job.status, '未开始')}`;
  appendLogs();
}

/** 人工审核闸门面板：批准 → 确认码 → 继续执行 */
function gateCard() {
  const rows = stageRows();
  const paidRows = rows.filter((x) => x.paid);
  const awaiting = paidRows.find((x) => stageWaiting(x));
  const { planId } = pendingPlan();
  const runningPaid = paidRows.find((x) => x.status === 'running');
  if (!planId && !awaiting && !runningPaid) {
    return el('div', { class: 'card', style: ST.card }, [
      el('div', { style: ST.h }, ['🔐 人工审核闸门']),
      el('div', { class: 'small muted', style: { marginTop: '6px', lineHeight: 1.7 } }, [
        `免费阶段可以直接执行；付费阶段（${paidStageIds().map(stageName).join(' / ')}）执行前会停下等待人工批准。`,
        el('br'),
        '当前没有待批准的付费阶段。',
      ]),
    ]);
  }
  if (!planId && !awaiting) {
    // 已放行执行（计划已消费）——不再展示空的计划信息与已失效的按钮
    const done = S.job?.id === runningPaid.job_id && ['done', 'error', 'canceled'].includes(S.job?.status);
    return el('div', { class: 'card', style: ST.card }, [
      el('div', { class: 'row', style: { gap: '10px', flexWrap: 'wrap' } }, [
        el('div', { style: ST.h }, ['🔐 人工审核闸门']),
        el('span', { class: 'tag warn', text: `阶段「${stageName(runningPaid.stage || runningPaid.id)}」已人工放行` }),
        el('div', { class: 'grow' }),
        runningPaid.job_id ? el('button', { class: 'btn xs', onclick: () => window.open(`/api/jobs/${encodeURIComponent(runningPaid.job_id)}`, '_blank') }, ['查看任务 JSON']) : null,
      ]),
      el('div', { class: 'small', style: { marginTop: '8px', lineHeight: 1.7 } }, [
        `该付费阶段的执行计划已被消费（当前没有待批准的计划，因此不再显示计划 id / 确认码）。`,
        el('br'),
        runningPaid.job_id ? `执行任务：${s(runningPaid.job_id)}（${done ? (JOB_STATUS[S.job.status] || s(S.job.status)) : '执行中/待后端刷新状态'}）` : '后端未返回执行任务 id。',
        el('br'),
        '付费阶段完成后会自动继续到下一闸门，最终自动完成成片、质检和交付准备。',
      ]),
    ]);
  }
  const art = awaiting?.artifact || null;
  const plan = S.planDetail;
  const steps = plan?.plan?.steps || {};
  const runNodes = Array.isArray(steps.run) ? steps.run : [];
  const skipNodes = Array.isArray(steps.skip) ? steps.skip : [];
  const runCount = runNodes.length || nOf(art?.runNodes) || 0;
  const skipCount = skipNodes.length || 0;
  const costLevel = String(plan?.cost_level || art?.costLevel || '').toUpperCase();
  const masked = plan?.confirm_code_masked || art?.confirmCodeMasked || '';
  const approved = String(plan?.status || '').toLowerCase();

  const body = [
    el('div', { class: 'row', style: { gap: '10px', flexWrap: 'wrap' } }, [
      el('div', { style: ST.h }, ['🔐 人工审核闸门']),
      el('span', { class: 'tag warn', text: `阶段「${stageName(awaiting?.stage || awaiting?.id || runningPaid?.stage || runningPaid?.id)}」` }),
      approved && approved !== 'pending' ? el('span', { class: 'tag ' + (approved === 'approved' ? 'ok' : ''), text: `计划状态 ${approved}` }) : null,
      el('div', { class: 'grow' }),
      el('button', { class: 'btn xs', onclick: showPlanModal, disabled: !planId }, ['📋 查看计划详情']),
      el('button', { class: 'btn xs', onclick: () => loadPlanDetail(planId).then(renderDynamic), disabled: !planId }, ['↻ 刷新计划']),
    ]),
    el('div', { style: { ...ST.kv, marginTop: '10px' } }, [
      el('span', { class: 'small muted' }, ['计划 id']), planId
        ? el('span', { class: 'code', style: { cursor: 'pointer' }, onclick: () => copyText(planId, '计划 id'), text: s(planId) })
        : el('span', { class: 'small muted', text: '—（该阶段已放行执行，计划已消费；如需重新批准请先「↻ 重跑该阶段」）' }),
      el('span', { class: 'small muted' }, ['成本级']), el('span', { class: 'small', text: COST_NAME[costLevel] || s(plan?.cost_level || art?.costLevel) }),
      el('span', { class: 'small muted' }, ['待执行节点数']), el('span', { class: 'small', text: S.planLoading ? '读取中…' : `${runCount}` }),
      el('span', { class: 'small muted' }, ['可跳过节点数']), el('span', { class: 'small', text: S.planLoading ? '读取中…' : `${skipCount}` }),
      el('span', { class: 'small muted' }, ['掩码确认码']), el('span', { class: 'small', style: { fontFamily: 'var(--mono)' }, text: s(masked, '（待批准后由服务端终端打印）') }),
    ]),
    el('div', { class: 'small muted', style: { marginTop: '8px' } }, ['前若干待执行节点：']),
    runCount === 0 && !S.planLoading
      ? el('div', { class: 'small', style: { marginTop: '6px', color: 'var(--warn)' } }, ['⚠ 该计划待执行节点为 0（节点产物已存在，执行时会被跳过）—— 批准并继续执行不会产生新的出图/视频调用。'])
      : null,
    el('div', { style: { marginTop: '4px', maxHeight: '140px', overflow: 'auto', border: '1px solid var(--line)', borderRadius: '8px', padding: '6px 8px', background: 'var(--bg-2)' } },
      runNodes.length
        ? runNodes.slice(0, 12).map((x, i) => el('div', { class: 'small', style: { fontFamily: 'var(--mono)', lineHeight: 1.7 } }, [`${i + 1}. ${s(x.title || x.id, '（未命名节点）')}`]))
        : [el('div', { class: 'small muted' }, [
          art?.nodeIds?.length ? `待执行节点 ${art.nodeIds.length} 个（标题需展开计划详情查看）` : '还没有计划节点信息（点「↻ 刷新计划」重试）',
        ])]),
    el('div', { class: 'row', style: { marginTop: '10px', gap: '8px', flexWrap: 'wrap' } }, [
      el('button', { class: 'btn primary sm', onclick: approvePlan, disabled: !planId }, ['✅ 批准计划']),
      el('button', { class: 'btn sm danger', onclick: rejectPlan, disabled: !planId }, ['⛔ 拒绝']),
      el('input', {
        id: 'st-code', type: 'text', maxlength: '6', placeholder: '服务端终端打印的 6 位确认码',
        value: S.confirmCode || '', style: { width: '230px' },
        oninput: (e) => { S.confirmCode = e.target.value; },
        onblur: () => { if (S.deferRender) { S.deferRender = false; renderDynamic(); } },
      }),
      el('button', { class: 'btn accent sm', onclick: resumeStage, disabled: !planId }, ['▶ 继续执行']),
    ]),
    el('div', { class: 'small muted', style: { marginTop: '8px', lineHeight: 1.7 } }, [
      '流程：1) 点「✅ 批准计划」→ 2) 在运行后端服务的终端里找到形如 ',
      el('code', {}, ['[gate] 计划 PL-xxxx 待人工确认，确认码：123456']),
      ' 的行 → 3) 把 6 位确认码填进输入框 → 4) 点「▶ 继续执行」。',
      el('br'),
      '确认码只打印在服务端终端，页面与 Agent 都无法读取它——这是防止自动烧钱的人工闸门。',
    ]),
    S.gateMsg ? el('div', { class: 'small', style: { marginTop: '8px', color: 'var(--err)' } }, [S.gateMsg]) : null,
    runningPaid ? el('div', { class: 'small', style: { marginTop: '8px', color: 'var(--accent)' } }, [`阶段「${stageName(runningPaid.stage || runningPaid.id)}」正在执行中…`]) : null,
  ];
  return el('div', { class: 'card', style: awaiting ? ST.cardWarn : ST.card }, body);
}

function stagesCard() {
  const rows = stageRows();
  const doneCount = rows.filter((x) => x.status === 'done' || x.status === 'skipped').length;
  const list = [];
  rows.forEach((st, i) => {
    list.push(stageRow(st, i));
    if (S.expanded[st.id]) list.push(stageDetail(st));
  });
  return el('div', { class: 'card', style: ST.card }, [
    el('div', { class: 'row', style: { gap: '10px', flexWrap: 'wrap' } }, [
      el('div', { style: ST.h }, ['🧱 阶段清单']),
      el('span', { class: 'small muted', text: `${doneCount}/${rows.length} 已完成` }),
      el('div', { class: 'grow' }),
      el('button', { class: 'btn xs', onclick: () => { S.expanded = {}; renderDynamic(); } }, ['全部收起']),
    ]),
    el('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '10px' } }, list),
  ]);
}

function stageRow(st, i) {
  const meta = STAGE_STATUS[st.status] || { text: s(st.status, '待执行'), tag: '' };
  const waiting = stageWaiting(st);
  // 付费阶段任务已结束、但后端阶段记录仍停在 running（未回写 done）时给出明确提示，而不是永远转圈
  const staleJob = !!st.paid && st.status === 'running' && !!st.job_id && S.job?.id === st.job_id && ['done', 'error', 'canceled'].includes(S.job.status);
  const style = { ...ST.stageRow, ...(waiting ? ST.stageRowWait : st.status === 'error' ? ST.stageRowErr : {}) };
  return el('div', { class: 'st-stage', style }, [
    el('span', { class: 'small muted', style: { width: '18px', textAlign: 'right' }, text: `${i + 1}` }),
    el('div', { style: { flex: 1, minWidth: '150px' } }, [
      el('div', { style: { fontWeight: 600, fontSize: '12.5px' } }, [
        s(st.name || stageName(st.id)),
        st.paid ? el('span', { class: 'tag warn', style: { marginLeft: '6px' }, text: '付费' }) : el('span', { class: 'tag', style: { marginLeft: '6px' }, text: '免费' }),
      ]),
      el('div', { class: 'small muted', style: { marginTop: '2px' } }, [s(st.desc, '')]),
    ]),
    st.job_id ? el('span', { class: 'small muted', style: { fontFamily: 'var(--mono)' }, text: s(st.job_id) }) : null,
    el('span', { class: `tag ${waiting || staleJob ? 'warn' : meta.tag}`.trim(), text: waiting ? '⏸ 已暂停：等待人工批准' : staleJob ? '任务已结束（后端阶段状态未更新）' : meta.text }),
    el('button', { class: 'btn xs', onclick: (e) => { e.stopPropagation(); S.expanded[st.id] = !S.expanded[st.id]; renderDynamic(); } }, [S.expanded[st.id] ? '收起详情' : '展开详情']),
    el('button', { class: 'btn xs', onclick: (e) => { e.stopPropagation(); runOneStage(st.id); } }, ['↻ 重跑该阶段']),
  ]);
}

function stageDetail(st) {
  const art = st.artifact;
  const lines = artifactLines(st.id, art);
  return el('div', { class: 'st-detail', style: ST.stageDetail }, [
    el('div', { class: 'small', style: { fontWeight: 600 } }, [`阶段「${s(st.name || stageName(st.id))}」产物摘要`]),
    el('div', { class: 'small', style: { marginTop: '4px', lineHeight: 1.8 } }, lines.map((t) => el('div', {}, [`· ${t}`]))),
    st.error ? el('div', { class: 'small', style: { marginTop: '6px', color: 'var(--err)' } }, [`错误：${s(st.error)}`]) : null,
    st.plan_id ? el('div', { class: 'small muted', style: { marginTop: '6px' } }, ['执行计划 id：', el('span', { class: 'code', onclick: () => copyText(st.plan_id, '计划 id'), text: s(st.plan_id) }), st.job_id ? `　任务 id：${s(st.job_id)}` : '']) : null,
    art ? el('details', { style: { marginTop: '6px' } }, [
      el('summary', { class: 'small muted', style: { cursor: 'pointer' } }, ['查看原始 artifact JSON']),
      el('pre', { class: 'code', style: ST.pre, text: safeJSON(art) }),
    ]) : null,
  ]);
}

function safeJSON(v) {
  try { return JSON.stringify(v, null, 2); } catch { return '（无法序列化）'; }
}

/** 每个阶段的产物摘要（全部走 s()/fmtNum()，页面不会出现 undefined） */
function artifactLines(id, art) {
  if (!art) return ['暂无产物（该阶段还没执行）'];
  const L = [];
  const spec = art.spec || {};
  switch (id) {
    case 'brief':
      L.push(`解析模式：${art.mode === 'offline' ? '离线规则' : '大模型'}`);
      L.push(`剧名：${s(spec.title)}　题材：${s(spec.genreName || spec.genre)}　画风：${s(spec.styleName)}　比例：${s(spec.ratio)}`);
      L.push(`${s(spec.episodes)} 集 × ${s(spec.episodeSeconds)} 秒　角色 ${s(spec.castSize)} 位　目标 ${fmtNum(spec.targetWords)} 字　要写 ${s(spec.chaptersToWrite, 0)} 章`);
      if (Array.isArray(art.hits) && art.hits.length) L.push(`命中项：${art.hits.join('、')}`);
      if (art.note) L.push(`说明：${s(art.note)}`);
      break;
    case 'cast':
      L.push(`创建 ${s(art.created, 0)} 位演员：${(art.names || []).map((x) => s(x)).join('、') || '—'}`);
      L.push(`来源：${art.source === 'llm' ? '大模型生成' : '离线规则模板'}`);
      break;
    case 'novel':
      L.push(`小说 id：${s(art.novelId)}　标题：${s(art.title)}`);
      L.push(`大纲 ${s(art.outlineChapters, 0)} 章　已写正文 ${s(art.chaptersWritten, 0)} 章　模型：${s(art.provider)}`);
      break;
    case 'script':
      L.push(`剧本 id：${s(art.scriptId)}　共 ${s(art.episodes, 0)} 集 / ${fmtNum(art.shots)} 镜　模型：${s(art.provider)}`);
      if (Array.isArray(art.perEpisode) && art.perEpisode.length) L.push(`分集：${art.perEpisode.map((x) => `${s(x.code)}（${s(x.shots, 0)} 镜）`).join('　')}`);
      break;
    case 'canvas':
      L.push(`画布 id：${s(art.canvasId)}　名称：${s(art.canvasName)}`);
      L.push(`铺开 ${s(art.episodes, 0)} 集　关键帧节点 ${s(art.keyframeNodes, 0)} 个　视频节点 ${s(art.videoNodes, 0)} 个`);
      if (Array.isArray(art.nodes) && art.nodes.length) L.push(`节点统计：${art.nodes.map((x) => `${s(x.kind)}×${s(x.n, 0)}`).join('　')}`);
      break;
    case 'keyframe':
    case 'video':
      if (art.plan_id) L.push(`执行计划 id：${s(art.plan_id)}${art.costLevel ? `　成本级：${COST_NAME[String(art.costLevel).toUpperCase()] || s(art.costLevel)}` : ''}`);
      if (art.runNodes !== undefined) L.push(`待执行节点 ${s(art.runNodes, 0)} 个　覆盖集：${(art.episodes || []).map((x) => s(x)).join('、') || '—'}`);
      if (Array.isArray(art.nodeIds)) L.push(`节点 id 共 ${art.nodeIds.length} 个`);
      if (art.job_id) L.push(`已放行执行：任务 ${s(art.job_id)}　节点总数 ${s(art.total, 0)}`);
      if (art.plan?.steps) L.push(`计划步骤：待执行 ${(art.plan.steps.run || []).length} 个 / 可跳过 ${(art.plan.steps.skip || []).length} 个`);
      break;
    case 'finish':
      L.push(`时间线节点 ${s(art.timelines, 0)} 条　成片 ${s(art.filmCount, 0)} 个`);
      if (Array.isArray(art.submitted) && art.submitted.length) L.push(`提交：${art.submitted.map((x) => `${s(x.title, x.nodeId)}${x.error ? '（失败：' + s(x.error) + '）' : ''}`).join('　')}`);
      if (Array.isArray(art.films) && art.films.length) L.push(`成片文件：${art.films.map((f) => s(f.file)).join('　')}`);
      break;
    case 'qc':
      if (Array.isArray(art.verdicts) && art.verdicts.length) L.push(`每集结论：${art.verdicts.map((v) => `${s(v.code)} → ${s(v.verdict)}`).join('　')}`);
      L.push(`汇总：${art.summary ? s(typeof art.summary === 'string' ? art.summary : safeJSON(art.summary)) : '—'}`);
      break;
    case 'deliver':
      L.push(`交付包：${s(art.file)}`);
      L.push(`体积 ${fmtBytes(art.bytes)}　文件 ${s(art.files, 0)} 个　缺失 ${s(art.missing, 0)} 个`);
      break;
    default:
      L.push(safeJSON(art).slice(0, 400));
  }
  return L.length ? L : ['暂无产物'];
}

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (!v) return '—';
  if (v >= 1073741824) return `${(v / 1073741824).toFixed(2)} GB`;
  if (v >= 1048576) return `${(v / 1048576).toFixed(2)} MB`;
  if (v >= 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${v} B`;
}

const fileUrl = (rel) => (rel ? (C?.api?.fileUrl ? C.api.fileUrl(rel) : `/${String(rel).replace(/^\/+/, '')}`) : '');

/** 产物区：演员 / 小说 / 剧本 / 画布 / 成片 / 质检 / 交付包 */
function outputsCard() {
  const p = S.detail || {};
  const finishRow = stageRows().find((x) => x.id === 'finish');
  const films = Array.isArray(finishRow?.artifact?.films) ? finishRow.artifact.films : [];
  const castRow = stageRows().find((x) => x.id === 'cast');
  const castNames = Array.isArray(castRow?.artifact?.names) ? castRow.artifact.names : [];
  const actorCount = Array.isArray(p.actor_ids) ? p.actor_ids.length : 0;
  const delivery = p.delivery || null;
  const qc = p.qc || null;

  const idChip = (label, value) => (value
    ? el('span', { class: 'row', style: { gap: '6px' } }, [
      el('span', { class: 'small muted' }, [`${label}：`]),
      el('span', { class: 'code', title: '点击复制', onclick: () => copyText(value, label), text: s(value) }),
    ])
    : el('span', { class: 'small muted' }, [`${label}：—`]));

  return el('div', { class: 'card', style: ST.card }, [
    el('div', { class: 'row', style: { gap: '10px', flexWrap: 'wrap' } }, [
      el('div', { style: ST.h }, ['📦 产物']),
      el('div', { class: 'grow' }),
      delivery
        ? el('button', { class: 'btn primary sm', onclick: openDelivery }, ['📦 下载交付包'])
        : el('span', { class: 'small muted' }, ['交付包：尚未生成（先跑「交付包」阶段）']),
    ]),
    el('div', { class: 'row', style: { gap: '14px', flexWrap: 'wrap', marginTop: '10px' } }, [
      el('span', { class: 'small' }, [`演员：${actorCount} 位`, castNames.length ? `（${castNames.slice(0, 6).map((x) => s(x)).join('、')}${castNames.length > 6 ? ' 等' : ''}）` : '']),
      idChip('小说 id', p.novel_id),
      idChip('剧本 id', p.script_id),
      idChip('画布 id', p.canvas_id),
    ]),
    el('div', { class: 'small muted', style: { marginTop: '6px' } }, [`成片：${Array.isArray(p.film_ids) ? p.film_ids.length : 0} 个${delivery ? `　交付包：${s(delivery.file)}（${fmtBytes(delivery.bytes)}，${s(delivery.files, 0)} 文件，缺失 ${s(delivery.missing, 0)}）` : ''}`]),
    films.length
      ? el('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: '10px' } }, films.map((f) => el('div', { style: { border: '1px solid var(--line)', borderRadius: '9px', padding: '8px', background: 'var(--panel-2)' } }, [
        el('video', { controls: true, preload: 'metadata', src: fileUrl(f.file), style: { width: '200px', height: 'auto', borderRadius: '6px', background: '#000', display: 'block' } }),
        el('div', { class: 'small muted', style: { marginTop: '5px', maxWidth: '200px', wordBreak: 'break-all' } }, [s(f.file)]),
        el('div', { class: 'row', style: { gap: '6px', marginTop: '4px' } }, [
          el('span', { class: 'small muted' }, [`${s(f.duration, '—')} 秒`]),
          el('a', { class: 'btn xs', href: fileUrl(f.file), download: '', target: '_blank' }, ['下载']),
        ]),
      ])))
      : el('div', { class: 'small muted', style: { marginTop: '8px' } }, ['成片预览：暂无（跑完「整集成片」阶段后这里会出现 <video> 预览）']),
    qc
      ? el('div', { style: { marginTop: '10px' } }, [
        el('div', { class: 'small', style: { fontWeight: 600 } }, ['质检结论']),
        el('div', { class: 'small muted', style: { marginTop: '4px' } }, [`汇总：${qc.summary ? s(typeof qc.summary === 'string' ? qc.summary : safeJSON(qc.summary)) : '—'}`]),
        el('div', { class: 'small muted', style: { marginTop: '2px', lineHeight: 1.8 } }, (qc.reports || []).map((r) => el('div', {}, [`· ${s(r.code)} → ${s(r.verdict)}　错误 ${s(r.errors, 0)} / 警告 ${s(r.warns, 0)}`]))),
      ])
      : el('div', { class: 'small muted', style: { marginTop: '10px' } }, ['质检结论：暂无（跑完「成片质检」阶段后显示）']),
  ]);
}

// ---------------- 任务日志 SSE（日志只走 SSE，不入库；轮询只拿进度） ----------------
function attachLogStream() {
  try {
    sseStop = C.api.subscribeJobs((msg) => {
      if (!S || !msg) return;
      if (msg.type === 'log' && msg.id && msg.id === S.job.id && msg.msg) logLine(String(msg.msg));
    });
  } catch { sseStop = null; }
}
