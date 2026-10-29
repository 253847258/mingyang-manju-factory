// 小说工坊四步生产线组件
// 只通过 ctx.api 读取真实数据与提交写操作；本组件不生成任何占位业务数据。
// 类名统一 nvp- 前缀；mount 可重复调用，unmount 会清理轮询、任务监听和事件监听。

const STYLE_ID = 'nvp-style';
const STEP_META = Object.freeze([
  { key: 'outline', label: '生成章节大纲', order: 1 },
  { key: 'cards', label: '生成章节内容卡', order: 2 },
  { key: 'assets', label: '布置资产与画布参考', order: 3 },
  { key: 'prose', label: '续写正文', order: 4 },
]);
const TERMINAL_JOB_STATES = new Set(['done', 'error', 'canceled', 'cancelled', 'failed']);
const RUNNING_JOB_STATES = new Set(['queued', 'pending', 'running', 'processing', 'active']);
const KIND_META = Object.freeze({
  character: { label: '人物', icon: '👤' },
  environment: { label: '环境', icon: '🏞' },
  prop: { label: '物品', icon: '📦' },
});

const CSS = `
.nvp-shell{--nvp-gap:var(--gap,12px);height:100%;min-height:0;overflow:auto;padding:12px;color:var(--text,#e8e8ef);font-size:13px;background:var(--bg,#0f0f14)}
.nvp-shell *{box-sizing:border-box}
.nvp-head{display:flex;align-items:flex-start;gap:14px;flex-wrap:wrap;margin-bottom:12px}
.nvp-head-main{min-width:240px;flex:1}
.nvp-title{margin:0;font-size:19px;line-height:1.3;font-weight:760;letter-spacing:.01em}
.nvp-sub{margin-top:5px;color:var(--muted,#8b8b9c);font-size:12px;line-height:1.65}
.nvp-head-tools{display:flex;align-items:flex-end;gap:8px;flex-wrap:wrap;margin-left:auto}
.nvp-field{display:flex;flex-direction:column;gap:5px;min-width:0}
.nvp-label{font-size:11.5px;font-weight:680;color:var(--text,#e8e8ef)}
.nvp-hint{font-size:11px;line-height:1.55;color:var(--muted,#8b8b9c)}
.nvp-muted{color:var(--muted,#8b8b9c)}
.nvp-input,.nvp-select,.nvp-area{width:100%;min-width:0;border:1px solid var(--line,#2a2a36);border-radius:8px;background:var(--bg,#0f0f14);color:var(--text,#e8e8ef);padding:7px 9px;font:inherit;font-size:12.5px;outline:none;transition:border-color .16s,box-shadow .16s}
.nvp-input:focus,.nvp-select:focus,.nvp-area:focus{border-color:var(--accent,#6c8cff);box-shadow:0 0 0 2px rgba(108,140,255,.14)}
.nvp-area{line-height:1.65;resize:vertical;min-height:84px}
.nvp-input-sm{width:88px}
.nvp-btn{appearance:none;border:1px solid var(--line,#2a2a36);border-radius:8px;background:var(--panel-2,#1e1e28);color:var(--text,#e8e8ef);padding:6px 11px;font:inherit;font-size:12px;line-height:1.45;display:inline-flex;align-items:center;justify-content:center;gap:5px;cursor:pointer;white-space:nowrap;text-decoration:none}
.nvp-btn:hover:not(:disabled){border-color:var(--accent,#6c8cff);background:rgba(108,140,255,.08)}
.nvp-btn:focus-visible{outline:2px solid var(--accent,#6c8cff);outline-offset:2px}
.nvp-btn:disabled{opacity:.42;cursor:not-allowed}
.nvp-btn-primary{background:var(--accent,#6c8cff);border-color:var(--accent,#6c8cff);color:#0b0b12;font-weight:740}
.nvp-btn-primary:hover:not(:disabled){background:#809aff;border-color:#809aff}
.nvp-btn-ok{background:var(--accent-2,#48d1a0);border-color:var(--accent-2,#48d1a0);color:#08120e;font-weight:740}
.nvp-btn-danger{border-color:rgba(240,96,96,.55);color:#ffaaaa}
.nvp-btn-ghost{background:transparent}
.nvp-btn-sm{padding:3px 8px;font-size:11.5px}
.nvp-chip{display:inline-flex;align-items:center;gap:5px;padding:4px 8px;border:1px solid var(--line,#2a2a36);border-radius:999px;background:rgba(255,255,255,.025);font-size:11.5px;color:var(--muted,#8b8b9c)}
.nvp-chip b{color:var(--text,#e8e8ef);font-size:12px}
.nvp-chip-ok{border-color:rgba(72,209,160,.45);color:#8ae7c3}
.nvp-chip-warn{border-color:rgba(240,176,96,.48);color:#ffd090}
.nvp-chip-err{border-color:rgba(240,96,96,.5);color:#ffadad}
.nvp-alert{padding:9px 11px;border:1px solid var(--line,#2a2a36);border-radius:9px;background:rgba(255,255,255,.025);font-size:11.5px;line-height:1.6;color:var(--muted,#8b8b9c)}
.nvp-alert-warn{border-color:rgba(240,176,96,.38);background:rgba(240,176,96,.07);color:#f4d1a2}
.nvp-alert-err{border-color:rgba(240,96,96,.42);background:rgba(240,96,96,.07);color:#ffb6b6}
.nvp-alert-ok{border-color:rgba(72,209,160,.38);background:rgba(72,209,160,.06);color:#99e8ca}
.nvp-alert b{color:inherit}
.nvp-steps{display:grid;grid-template-columns:repeat(4,minmax(150px,1fr));gap:9px;margin-bottom:12px}
.nvp-step{position:relative;text-align:left;border:1px solid var(--line,#2a2a36);border-radius:11px;background:var(--panel,#16161d);color:var(--text,#e8e8ef);padding:11px 12px;cursor:pointer;min-width:0;font:inherit}
.nvp-step:hover{border-color:var(--accent,#6c8cff)}
.nvp-step.nvp-on{border-color:var(--accent,#6c8cff);box-shadow:inset 0 0 0 1px rgba(108,140,255,.3);background:rgba(108,140,255,.07)}
.nvp-step.nvp-complete:not(.nvp-on){border-color:rgba(72,209,160,.35)}
.nvp-step-top{display:flex;align-items:center;gap:7px}
.nvp-step-no{width:24px;height:24px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--line,#2a2a36);background:var(--bg,#0f0f14);font-size:11.5px;font-weight:760;flex:0 0 24px}
.nvp-step.nvp-complete .nvp-step-no{background:var(--accent-2,#48d1a0);border-color:var(--accent-2,#48d1a0);color:#07110d}
.nvp-step-label{font-size:12.5px;font-weight:720;line-height:1.35;min-width:0}
.nvp-step-meta{margin-top:7px;font-size:11px;color:var(--muted,#8b8b9c);display:flex;gap:6px;justify-content:space-between;align-items:center}
.nvp-step-block{margin-top:5px;font-size:10.5px;line-height:1.45;color:#ffd18e;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nvp-sequence{display:flex;align-items:flex-start;gap:8px;margin-bottom:12px;padding:9px 11px;border-radius:9px;border:1px solid rgba(108,140,255,.28);background:rgba(108,140,255,.055);font-size:11.5px;line-height:1.6;color:#bdc8ff}
.nvp-sequence b{color:#dce3ff}
.nvp-task{display:flex;gap:11px;align-items:flex-start;padding:10px 12px;border:1px solid rgba(108,140,255,.38);background:rgba(108,140,255,.065);border-radius:10px;margin-bottom:12px}
.nvp-task-main{flex:1;min-width:0}
.nvp-task-head{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12px;font-weight:700}
.nvp-task-status{font-size:11px;color:#b9c5ff}
.nvp-task-error{margin-top:5px;color:#ffb0b0;font-size:11px;line-height:1.55;overflow-wrap:anywhere}
.nvp-task-log{margin-top:5px;color:var(--muted,#8b8b9c);font-size:10.5px;line-height:1.5;word-break:break-word}
.nvp-progress{height:6px;background:var(--bg,#0f0f14);border-radius:999px;overflow:hidden;margin-top:8px}
.nvp-progress>i{display:block;height:100%;background:linear-gradient(90deg,var(--accent,#6c8cff),var(--accent-2,#48d1a0));transition:width .25s}
.nvp-panel{border:1px solid var(--line,#2a2a36);border-radius:12px;background:var(--panel,#16161d);padding:13px;margin-bottom:12px;min-width:0}
.nvp-panel-head{display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap;margin-bottom:11px}
.nvp-panel-title{margin:0;font-size:14px;font-weight:760}
.nvp-panel-sub{margin-top:4px;color:var(--muted,#8b8b9c);font-size:11.5px;line-height:1.55}
.nvp-panel-actions{display:flex;gap:7px;flex-wrap:wrap;align-items:center;margin-left:auto}
.nvp-grid{display:grid;gap:9px}
.nvp-grid-4{grid-template-columns:repeat(4,minmax(120px,1fr))}
.nvp-grid-3{grid-template-columns:repeat(3,minmax(160px,1fr))}
.nvp-grid-2{grid-template-columns:repeat(2,minmax(200px,1fr))}
.nvp-inline{display:flex;gap:7px;align-items:center;flex-wrap:wrap}
.nvp-grow{flex:1;min-width:0}
.nvp-check{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:var(--muted,#8b8b9c);cursor:pointer}
.nvp-check input{accent-color:var(--accent,#6c8cff)}
.nvp-divider{height:1px;background:var(--line,#2a2a36);margin:11px 0}
.nvp-list{display:flex;flex-direction:column;gap:8px;min-height:0}
.nvp-card{border:1px solid var(--line,#2a2a36);border-radius:9px;background:var(--panel-2,#1e1e28);padding:10px;min-width:0}
.nvp-card-head{display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap}
.nvp-card-title{font-size:12.5px;font-weight:720;line-height:1.45;min-width:0;overflow-wrap:anywhere}
.nvp-card-actions{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-left:auto}
.nvp-card-body{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px 14px;margin-top:8px}
.nvp-kv{min-width:0}
.nvp-kv b{display:block;color:var(--muted,#8b8b9c);font-size:10.5px;font-weight:650;margin-bottom:2px}
.nvp-kv span{display:block;font-size:11.5px;line-height:1.58;overflow-wrap:anywhere}
.nvp-clamp-2{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.nvp-badge{display:inline-flex;align-items:center;gap:3px;padding:2px 6px;border-radius:6px;border:1px solid var(--line,#2a2a36);font-size:10.5px;color:var(--muted,#8b8b9c);white-space:nowrap}
.nvp-badge-ok{border-color:rgba(72,209,160,.48);color:#8ae7c3}
.nvp-badge-warn{border-color:rgba(240,176,96,.5);color:#ffd18e}
.nvp-badge-err{border-color:rgba(240,96,96,.52);color:#ffaaaa}
.nvp-badge-acc{border-color:rgba(108,140,255,.52);color:#b8c5ff}
.nvp-empty{padding:28px 14px;text-align:center;color:var(--muted,#8b8b9c);font-size:12px;line-height:1.8;border:1px dashed var(--line,#2a2a36);border-radius:9px;background:rgba(255,255,255,.012)}
.nvp-empty b{display:block;color:var(--text,#e8e8ef);font-size:13px;margin-bottom:4px}
.nvp-asset-groups{display:grid;grid-template-columns:repeat(3,minmax(240px,1fr));gap:10px}
.nvp-asset-group{border:1px solid var(--line,#2a2a36);border-radius:10px;background:rgba(255,255,255,.012);padding:9px;min-width:0}
.nvp-asset-group-head{display:flex;align-items:center;gap:7px;margin-bottom:8px;font-size:12px;font-weight:720}
.nvp-asset-group-count{margin-left:auto;color:var(--muted,#8b8b9c);font-size:10.5px;font-weight:500}
.nvp-asset-list{display:flex;flex-direction:column;gap:7px}
.nvp-asset{padding:8px;border:1px solid var(--line,#2a2a36);border-radius:8px;background:var(--panel,#16161d);min-width:0}
.nvp-asset-top{display:flex;gap:6px;align-items:flex-start;flex-wrap:wrap}
.nvp-asset-name{font-size:11.5px;font-weight:720;word-break:break-word;min-width:0;flex:1}
.nvp-prompt{margin-top:6px;padding:7px;border:1px solid rgba(255,255,255,.055);border-radius:6px;background:var(--bg,#0f0f14);font-size:10.5px;line-height:1.55;color:var(--muted,#8b8b9c);overflow-wrap:anywhere;white-space:pre-wrap}
.nvp-prompt-clamp{display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
.nvp-asset-foot{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:7px}
.nvp-blocker-list{margin:6px 0 0;padding-left:18px;color:#ffd18e;font-size:11px;line-height:1.65;overflow-wrap:anywhere}
.nvp-table{width:100%;border-collapse:collapse;font-size:11.5px}
.nvp-table th{text-align:left;color:var(--muted,#8b8b9c);font-size:10.5px;font-weight:650;padding:6px 8px;border-bottom:1px solid var(--line,#2a2a36)}
.nvp-table td{padding:7px 8px;border-bottom:1px solid rgba(255,255,255,.045);vertical-align:top}
.nvp-table tr:last-child td{border-bottom:0}
.nvp-table-actions{display:flex;gap:5px;justify-content:flex-end;flex-wrap:wrap}
.nvp-pagebar{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-top:9px}
.nvp-spinner{width:14px;height:14px;border-radius:50%;border:2px solid rgba(255,255,255,.22);border-top-color:var(--accent,#6c8cff);display:inline-block;animation:nvp-spin .8s linear infinite;flex:0 0 14px}
@keyframes nvp-spin{to{transform:rotate(360deg)}}
.nvp-skeleton{padding:22px;border:1px solid var(--line,#2a2a36);border-radius:12px;background:var(--panel,#16161d)}
.nvp-sk-line{height:11px;border-radius:999px;background:linear-gradient(90deg,rgba(255,255,255,.045),rgba(255,255,255,.09),rgba(255,255,255,.045));background-size:220% 100%;animation:nvp-shimmer 1.2s linear infinite;margin-bottom:10px}
@keyframes nvp-shimmer{to{background-position:-220% 0}}
.nvp-overlay{position:fixed;inset:0;z-index:1200;background:rgba(4,5,10,.72);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;padding:16px}
.nvp-modal{width:min(760px,96vw);max-height:92vh;display:flex;flex-direction:column;background:var(--panel,#16161d);border:1px solid var(--line,#2a2a36);border-radius:13px;box-shadow:0 24px 90px rgba(0,0,0,.55);overflow:hidden}
.nvp-modal-wide{width:min(920px,96vw)}
.nvp-modal-head{display:flex;gap:12px;align-items:flex-start;padding:13px 15px;border-bottom:1px solid var(--line,#2a2a36)}
.nvp-modal-title{font-size:14px;font-weight:750;margin:0;line-height:1.4;flex:1;min-width:0;overflow-wrap:anywhere}
.nvp-modal-body{padding:14px 15px;overflow:auto;min-height:0}
.nvp-modal-foot{display:flex;gap:8px;align-items:center;justify-content:flex-end;padding:11px 15px;border-top:1px solid var(--line,#2a2a36);flex-wrap:wrap}
.nvp-modal-error{padding:8px 10px;border-radius:8px;border:1px solid rgba(240,96,96,.45);background:rgba(240,96,96,.08);color:#ffb3b3;font-size:11.5px;line-height:1.55;margin-bottom:10px;overflow-wrap:anywhere}
.nvp-modal-note{font-size:11px;color:var(--muted,#8b8b9c);line-height:1.6;margin:0 0 12px}
.nvp-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}
.nvp-required{color:var(--err,#f06060)}
.nvp-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@media(max-width:1050px){.nvp-steps{grid-template-columns:repeat(2,minmax(150px,1fr))}.nvp-asset-groups{grid-template-columns:1fr}.nvp-grid-4{grid-template-columns:repeat(2,minmax(140px,1fr))}}
@media(max-width:720px){.nvp-shell{padding:9px}.nvp-head-tools{margin-left:0;width:100%}.nvp-head-tools .nvp-field{flex:1;min-width:160px}.nvp-steps{grid-template-columns:1fr}.nvp-grid-4,.nvp-grid-3,.nvp-grid-2,.nvp-card-body{grid-template-columns:1fr}.nvp-panel-actions{margin-left:0;width:100%}.nvp-panel-actions .nvp-btn{flex:1}.nvp-card-actions{width:100%;margin-left:0;justify-content:flex-end}.nvp-table{display:block;overflow-x:auto;white-space:nowrap}.nvp-modal{max-height:96vh}.nvp-modal-foot .nvp-btn{flex:1}.nvp-input-sm{width:100%}}
`;

let rootEl = null;
let ctxRef = null;
let optionsRef = null;
let state = null;
let clickHandler = null;
let changeHandler = null;
let keyHandler = null;
let styleEl = null;
let session = 0;

function initialState(options) {
  return {
    novelId: String(options?.novelId || ''),
    operator: readOperator(options?.operator),
    loading: true,
    error: '',
    data: null,
    activeStep: 'outline',
    activeStepTouched: false,
    filtersReady: false,
    outline: { batchSize: 20, concurrency: 3, sectionsConcurrency: 4, instruction: '按整条故事线规划每章章首、章末与上下文衔接，确保前后逻辑一致；不写正文。' },
    cards: { from: 1, to: 20, onlyMissing: true, instruction: '' },
    assetFilter: { from: '', to: '' },
    canvasId: 'CV-MAIN',
    proseFilter: { from: 1, to: 20, status: 'all', page: 1 },
    task: null,
    stopJobWatch: null,
    pollTimer: null,
    busy: '',
    modal: null,
  };
}

function readOperator(preferred) {
  if (preferred !== undefined && preferred !== null && String(preferred).trim()) return String(preferred).trim().slice(0, 80);
  try {
    const value = window.localStorage.getItem('nvp.operator');
    if (value && value.trim()) return value.trim().slice(0, 80);
  } catch { /* localStorage 不可用时只保留本次会话内存值 */ }
  return '本机操作人';
}

function rememberOperator(value) {
  const operator = String(value || '').trim().slice(0, 80) || '本机操作人';
  try { window.localStorage.setItem('nvp.operator', operator); } catch { /* ignore */ }
  return operator;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

function numberValue(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function intValue(value, fallback = 0) {
  const number = Math.trunc(numberValue(value, fallback));
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function textValue(value) {
  return String(value ?? '').trim();
}

function errorText(error) {
  return String(error?.message || error || '未知错误').replace(/^Error:\s*/, '');
}

function toast(message, type = 'info') {
  try { ctxRef?.toast?.(String(message), type); } catch { /* ignore */ }
}

function data() {
  return state?.data || null;
}

function steps() {
  const source = new Map(asArray(data()?.steps).map((step) => [String(step?.key || ''), asObject(step)]));
  return STEP_META.map((meta) => ({
    ...meta,
    ...(source.get(meta.key) || {}),
    key: meta.key,
    label: textValue(source.get(meta.key)?.label) || meta.label,
    done: Math.max(0, numberValue(source.get(meta.key)?.done, 0)),
    total: Math.max(0, numberValue(source.get(meta.key)?.total, 0)),
    blockers: asArray(source.get(meta.key)?.blockers).map((item) => String(item)).filter(Boolean),
    complete: Boolean(source.get(meta.key)?.complete),
  }));
}

function stepByKey(key) {
  return steps().find((step) => step.key === key) || { key, complete: false, done: 0, total: 0, blockers: ['服务未返回该步骤状态'] };
}

function previousStepsComplete(key) {
  const index = STEP_META.findIndex((step) => step.key === key);
  if (index <= 0) return true;
  return steps().slice(0, index).every((step) => step.complete);
}

function firstIncompleteStep() {
  return steps().find((step) => !step.complete)?.key || 'prose';
}

function taskRunning() {
  if (!state?.task) return false;
  const status = String(state.task.status || 'queued').toLowerCase();
  return !TERMINAL_JOB_STATES.has(status);
}

function anyBusy() {
  return Boolean(state?.busy) || taskRunning();
}

function jobTerminal(job) {
  return TERMINAL_JOB_STATES.has(String(job?.status || '').toLowerCase());
}

function progressOf(job) {
  const direct = numberValue(job?.percent ?? job?.percentage ?? job?.progress_percent, NaN);
  if (Number.isFinite(direct)) return clamp(direct <= 1 ? direct * 100 : direct, 0, 100);
  const current = numberValue(job?.done ?? job?.current ?? job?.step?.done ?? job?.progress?.done ?? job?.completed, 0);
  const total = numberValue(job?.total ?? job?.step?.total ?? job?.progress?.total, 0);
  return total > 0 ? clamp((current / total) * 100, 0, 100) : 0;
}

function lastJobLog(job) {
  const logs = asArray(job?.logs || job?.log);
  if (!logs.length) return '';
  const last = logs[logs.length - 1];
  return String(last?.message || last?.text || last || '').slice(0, 240);
}

function taskStatusLabel(status) {
  return ({
    queued: '排队中', pending: '等待中', running: '执行中', processing: '执行中', active: '执行中',
    done: '已完成', error: '失败', failed: '失败', canceled: '已取消', cancelled: '已取消',
  })[String(status || '').toLowerCase()] || String(status || '执行中');
}

function badge(label, kind = '') {
  return `<span class="nvp-badge${kind ? ` nvp-badge-${kind}` : ''}">${esc(label)}</span>`;
}

function cardComplete(card) {
  return Boolean(
    card
    && textValue(card.objective)
    && textValue(card.conflict)
    && textValue(card.result)
    && asArray(card.beats).length >= 3
    && textValue(card.key_frame),
  );
}

function planComplete(plan) {
  return Boolean(plan && (textValue(plan.title) || textValue(plan.summary)));
}

function sections() {
  return asObject(data()?.sections);
}

function chapterPlans() {
  return asArray(sections().chapters).map((plan, index) => ({
    ...asObject(plan),
    idx: intValue(plan?.idx, index + 1),
  })).filter((plan) => plan.idx > 0);
}

function chapterPlanMap() {
  return new Map(chapterPlans().map((plan) => [Number(plan.idx), plan]));
}

function chapterCardMap() {
  const raw = asObject(data()?.pipeline?.chapter_cards);
  return new Map(Object.entries(raw).map(([idx, card]) => [Number(idx), asObject(card)]).filter(([idx]) => idx > 0));
}

function chapterRowMap() {
  return new Map(asArray(data()?.rows).map((row) => [Number(row?.idx), asObject(row)]).filter(([idx]) => idx > 0));
}

function knownChapterIndexes() {
  const indexes = new Set();
  for (const plan of chapterPlans()) indexes.add(Number(plan.idx));
  for (const idx of chapterCardMap().keys()) indexes.add(Number(idx));
  for (const idx of chapterRowMap().keys()) indexes.add(Number(idx));
  return [...indexes].filter((idx) => Number.isFinite(idx) && idx > 0).sort((a, b) => a - b);
}

function chapterTitle(idx) {
  const row = chapterRowMap().get(Number(idx)) || {};
  const card = chapterCardMap().get(Number(idx)) || {};
  const plan = chapterPlanMap().get(Number(idx)) || {};
  return textValue(row.title) || textValue(card.title) || textValue(plan.title) || `第 ${idx} 章`;
}

function chapterRowStatus(row) {
  const status = String(row?.status || '').toLowerCase();
  if (!row) return { key: 'missing', label: '未建章节', kind: '' };
  if (status === 'done' && numberValue(row.words, 0) > 0) return { key: 'done', label: '正文完成', kind: 'ok' };
  if (status === 'writing' || status === 'running') return { key: 'writing', label: '写作中', kind: 'warn' };
  if (status === 'error' || status === 'failed') return { key: 'error', label: '写作失败', kind: 'err' };
  if (textValue(row.content) || numberValue(row.words, 0) > 0) return { key: 'draft', label: '已有草稿', kind: 'acc' };
  return { key: 'pending', label: status === 'outline' ? '待写' : (status || '待写'), kind: '' };
}

function assetPlan() {
  return asObject(data()?.pipeline?.asset_plan);
}

function assets() {
  return asArray(assetPlan().assets).map(asObject);
}

function assetKey(asset) {
  return textValue(asset?.key) || textValue(asset?.id);
}

function assetMatchesFilter(asset, filter) {
  const chapters = asArray(asset?.chapters).map(Number).filter(Number.isFinite);
  const from = intValue(filter?.from, 0);
  const to = intValue(filter?.to, 0);
  if (from && chapters.length && Math.max(...chapters) < from) return false;
  if (to && chapters.length && Math.min(...chapters) > to) return false;
  return true;
}

function filteredAssets() {
  return assets().filter((asset) => assetMatchesFilter(asset, state.assetFilter));
}

function ensureFilters() {
  if (state.filtersReady || !data()) return;
  const planCount = chapterPlans().length;
  const expected = Math.max(1, intValue(data()?.summary?.expected, planCount || 1));
  const end = Math.min(expected, 20);
  state.cards.from = 1;
  state.cards.to = end;
  state.proseFilter.from = 1;
  state.proseFilter.to = end;
  state.filtersReady = true;
}

function ensureStyle() {
  if (typeof document === 'undefined') return;
  const existing = document.getElementById(STYLE_ID);
  if (existing) {
    styleEl = existing;
    return;
  }
  styleEl = document.createElement('style');
  styleEl.id = STYLE_ID;
  styleEl.textContent = CSS;
  document.head.append(styleEl);
}

function fieldValue(selector) {
  const node = rootEl?.querySelector(selector);
  return node ? String(node.value ?? '') : '';
}

function checkedValue(selector) {
  const node = rootEl?.querySelector(selector);
  return Boolean(node?.checked);
}

function collectModalForm() {
  if (!state?.modal) return;
  const form = rootEl?.querySelector('[data-nvp-modal-form]');
  if (!form) return;
  const values = {};
  for (const node of form.querySelectorAll('[data-nvp-field]')) {
    values[node.dataset.nvpField] = node.type === 'checkbox' ? Boolean(node.checked) : String(node.value ?? '');
  }
  state.modal.values = { ...(state.modal.values || {}), ...values };
}

function render() {
  if (!rootEl || !state || !ctxRef) return;
  let body = '';
  if (state.loading) {
    body = `<div class="nvp-skeleton" aria-live="polite" aria-busy="true">
      <div class="nvp-sk-line" style="width:34%"></div>
      <div class="nvp-sk-line" style="width:68%"></div>
      <div class="nvp-sk-line" style="width:52%"></div>
    </div>`;
  } else if (state.error) {
    body = `<div class="nvp-empty" role="alert"><b>生产线加载失败</b>${esc(state.error)}<div style="margin-top:12px"><button class="nvp-btn nvp-btn-primary" data-nvp-action="retry">重新加载</button></div></div>`;
  } else if (!data()) {
    body = `<div class="nvp-empty"><b>生产线暂无数据</b>请刷新或检查小说项目。</div>`;
  } else {
    body = `${headerHtml()}${taskHtml()}${stepperHtml()}${sequenceHtml()}${activePanelHtml()}`;
  }
  rootEl.innerHTML = `<div class="nvp-shell">${body}</div>${modalHtml()}`;
}

function headerHtml() {
  const novel = asObject(data()?.novel);
  const summary = asObject(data()?.summary);
  const title = textValue(novel.title) || `小说 ${state.novelId}`;
  const blockerCount = asArray(summary.blockers).filter(Boolean).length;
  return `<header class="nvp-head">
    <div class="nvp-head-main">
      <h2 class="nvp-title">${esc(title)} · 四步生产线</h2>
      <div class="nvp-sub">章纲 → 内容卡 → 资产与画布 → 正文。严格按顺序推进，所有内容均来自当前小说项目。</div>
      <div class="nvp-inline" style="margin-top:9px">
        <span class="nvp-chip">预计 <b>${esc(numberValue(summary.expected, 0))}</b> 章</span>
        <span class="nvp-chip">章纲 <b>${esc(numberValue(summary.outlineComplete, 0))}</b></span>
        <span class="nvp-chip">内容卡 <b>${esc(numberValue(summary.cards, 0))}</b></span>
        <span class="nvp-chip">资产 <b>${esc(numberValue(summary.assets, 0))}</b></span>
        <span class="nvp-chip ${summary.confirmed ? 'nvp-chip-ok' : 'nvp-chip-warn'}">资产确认 <b>${summary.confirmed ? '已确认' : '未确认'}</b></span>
        <span class="nvp-chip">正文 <b>${esc(numberValue(summary.proseDone, 0))}</b></span>
        ${blockerCount ? `<span class="nvp-chip nvp-chip-warn">阻塞 <b>${esc(blockerCount)}</b></span>` : '<span class="nvp-chip nvp-chip-ok">无阻塞</span>'}
      </div>
    </div>
    <div class="nvp-head-tools">
      <label class="nvp-field"><span class="nvp-label">操作人</span><input class="nvp-input" data-nvp-field="operator" maxlength="80" value="${esc(state.operator)}" aria-label="操作人"></label>
      <button class="nvp-btn" data-nvp-action="refresh" ${anyBusy() ? 'disabled' : ''}>↻ 刷新状态</button>
      <button class="nvp-btn nvp-btn-ghost" data-nvp-action="legacy">高级旧流程</button>
    </div>
  </header>`;
}

function taskHtml() {
  if (!state.task) return '';
  const task = state.task;
  const percentage = clamp(numberValue(task.percentage, progressOf(task)), 0, 100);
  const status = String(task.status || 'queued').toLowerCase();
  const terminal = TERMINAL_JOB_STATES.has(status);
  const error = status === 'error' || status === 'failed' ? textValue(task.error) : '';
  const log = lastJobLog(task);
  return `<section class="nvp-task" aria-live="polite">
    <span class="${terminal ? '' : 'nvp-spinner'}" aria-hidden="true"></span>
    <div class="nvp-task-main">
      <div class="nvp-task-head"><span>${esc(task.label || '后台任务')}</span><span class="nvp-task-status">${esc(taskStatusLabel(status))}${task.jobId ? ` · ${esc(task.jobId)}` : ''}</span><span class="nvp-muted">${esc(Math.round(percentage))}%</span></div>
      <div class="nvp-progress"><i style="width:${percentage.toFixed(1)}%"></i></div>
      ${error ? `<div class="nvp-task-error" role="alert">${esc(error)}</div>` : ''}
      ${log ? `<div class="nvp-task-log">${esc(log)}</div>` : ''}
    </div>
  </section>`;
}

function stepperHtml() {
  const list = steps();
  return `<nav class="nvp-steps" aria-label="四步生产线">
    ${list.map((step) => {
      const active = step.key === state.activeStep;
      const meta = step.total > 0 ? `${step.done}/${step.total}` : '未开始';
      return `<button class="nvp-step${active ? ' nvp-on' : ''}${step.complete ? ' nvp-complete' : ''}" data-nvp-action="step" data-step="${esc(step.key)}" aria-current="${active ? 'step' : 'false'}">
        <span class="nvp-step-top"><span class="nvp-step-no">${step.complete ? '✓' : esc(step.order)}</span><span class="nvp-step-label">${esc(step.label)}</span></span>
        <span class="nvp-step-meta"><span>${esc(meta)}</span><span>${step.blockers.length ? `${step.blockers.length} 项阻塞` : (step.complete ? '已完成' : '待推进')}</span></span>
        ${step.blockers.length ? `<span class="nvp-step-block" title="${esc(step.blockers.join('；'))}">${esc(step.blockers[0])}</span>` : ''}
      </button>`;
    }).join('')}
  </nav>`;
}

function sequenceHtml() {
  const pending = firstIncompleteStep();
  const step = STEP_META.find((item) => item.key === pending) || STEP_META[3];
  if (steps().every((item) => item.complete)) {
    return `<div class="nvp-sequence"><span>✅</span><div><b>四步均已完成。</b>正文仍可逐章重写，任何修改都会以当前真实状态重新校验。</div></div>`;
  }
  return `<div class="nvp-sequence"><span>🔒</span><div><b>当前应推进第 ${step.order} 步：${esc(step.label)}。</b>后续步骤可预览，但涉及生成的按钮会在前置步骤未完成时锁定。</div></div>`;
}

function activePanelHtml() {
  switch (state.activeStep) {
    case 'cards': return cardsPanelHtml();
    case 'assets': return assetsPanelHtml();
    case 'prose': return prosePanelHtml();
    case 'outline':
    default: return outlinePanelHtml();
  }
}

function outlinePanelHtml() {
  const step = stepByKey('outline');
  const expected = numberValue(data()?.summary?.expected, 0);
  const outlineVersion = numberValue(data()?.outlineVersion, 0);
  const disabled = anyBusy();
  return `<section class="nvp-panel">
    <div class="nvp-panel-head">
      <div><h3 class="nvp-panel-title">第 1 步 · 生成章节大纲</h3><div class="nvp-panel-sub">先确定全篇章纲、章首章末和上下文衔接，不写正文。${outlineVersion ? `当前大纲 v${esc(outlineVersion)}。` : '当前还没有可读取的章节大纲。'}</div></div>
      <div class="nvp-panel-actions">${badge(step.complete ? '章纲完整' : `${step.done}/${step.total || expected} 章`, step.complete ? 'ok' : 'warn')}</div>
    </div>
    <div class="nvp-grid nvp-grid-4">
      <label class="nvp-field"><span class="nvp-label">每批章数</span><input class="nvp-input" id="nvp-outline-batch" type="number" min="1" max="50" step="1" value="${esc(state.outline.batchSize)}"></label>
      <label class="nvp-field"><span class="nvp-label">批次并发</span><input class="nvp-input" id="nvp-outline-concurrency" type="number" min="1" max="8" step="1" value="${esc(state.outline.concurrency)}"></label>
      <label class="nvp-field"><span class="nvp-label">分节并发</span><input class="nvp-input" id="nvp-outline-sections-concurrency" type="number" min="1" max="8" step="1" value="${esc(state.outline.sectionsConcurrency)}"></label>
      <div class="nvp-field"><span class="nvp-label">当前状态</span><div class="nvp-alert">${step.blockers.length ? esc(step.blockers.join('；')) : '章纲结构已完整，可按需刷新。'}</div></div>
    </div>
    <div class="nvp-field" style="margin-top:10px"><label class="nvp-label" for="nvp-outline-instruction">规划要求</label><textarea class="nvp-area" id="nvp-outline-instruction" rows="4">${esc(state.outline.instruction)}</textarea><span class="nvp-hint">刷新会按当前要求重新规划章纲；已有正文不会被删除。</span></div>
    <div class="nvp-inline" style="margin-top:11px">
      <button class="nvp-btn nvp-btn-primary" data-nvp-action="outline-run" ${disabled ? 'disabled' : ''}>${outlineVersion ? '↻ 刷新章节大纲' : '生成章节大纲'}</button>
      ${step.blockers.length ? `<span class="nvp-hint">${esc(step.blockers.join('；'))}</span>` : ''}
      ${taskRunning() && state.task?.kind === 'outline' ? '<span class="nvp-hint">后台任务进行中</span>' : ''}
    </div>
    ${blockerListHtml(step.blockers)}
  </section>`;
}

function cardsPanelHtml() {
  const step = stepByKey('cards');
  const outline = stepByKey('outline');
  const plans = chapterPlans();
  const cards = chapterCardMap();
  const maxIdx = Math.max(1, plans.length ? Math.max(...plans.map((plan) => Number(plan.idx))) : intValue(data()?.summary?.expected, 1));
  const from = clamp(intValue(state.cards.from, 1), 1, maxIdx);
  const to = clamp(intValue(state.cards.to, from), from, maxIdx);
  const indexes = [];
  for (let idx = from; idx <= to; idx += 1) indexes.push(idx);
  const disabled = anyBusy() || !outline.complete;
  return `<section class="nvp-panel">
    <div class="nvp-panel-head">
      <div><h3 class="nvp-panel-title">第 2 步 · 生成章节内容卡</h3><div class="nvp-panel-sub">把章纲拆成可执行的情节点、冲突、结果和关键帧，不直接写最终正文。</div></div>
      <div class="nvp-panel-actions">${badge(`${step.done}/${step.total} 张`, step.complete ? 'ok' : 'warn')}</div>
    </div>
    ${!outline.complete ? '<div class="nvp-alert nvp-alert-warn" style="margin-bottom:10px">第 1 步章纲尚未完整，内容卡生成已锁定。</div>' : ''}
    <div class="nvp-grid nvp-grid-4">
      <label class="nvp-field"><span class="nvp-label">起始章</span><input class="nvp-input" id="nvp-cards-from" type="number" min="1" max="${maxIdx}" step="1" value="${esc(from)}"></label>
      <label class="nvp-field"><span class="nvp-label">结束章</span><input class="nvp-input" id="nvp-cards-to" type="number" min="1" max="${maxIdx}" step="1" value="${esc(to)}"></label>
      <label class="nvp-field"><span class="nvp-label">生成策略</span><select class="nvp-select" id="nvp-cards-only-missing"><option value="true" ${state.cards.onlyMissing ? 'selected' : ''}>只补缺失</option><option value="false" ${!state.cards.onlyMissing ? 'selected' : ''}>重新生成所选范围</option></select></label>
      <div class="nvp-field"><span class="nvp-label">快捷操作</span><button class="nvp-btn" data-nvp-action="cards-filter" ${anyBusy() ? 'disabled' : ''}>应用范围</button></div>
    </div>
    <div class="nvp-field" style="margin-top:10px"><label class="nvp-label" for="nvp-cards-instruction">额外要求</label><textarea class="nvp-area" id="nvp-cards-instruction" rows="3" placeholder="例如：每章 5 个情节点，强化前三章的钩子">${esc(state.cards.instruction)}</textarea></div>
    <div class="nvp-inline" style="margin-top:11px"><button class="nvp-btn nvp-btn-primary" data-nvp-action="cards-run" ${disabled ? 'disabled' : ''}>生成第 ${esc(from)}–${esc(to)} 章内容卡</button><span class="nvp-hint">单次最多 50 章；后台任务完成后自动刷新。</span></div>
    ${blockerListHtml(step.blockers)}
    <div class="nvp-divider"></div>
    ${indexes.every((idx) => !cards.has(idx)) ? `<div class="nvp-empty"><b>所选范围还没有内容卡</b>先生成所选章节，或调整范围后再查看。</div>` : `<div class="nvp-list">
      ${indexes.map((idx) => {
        const card = cards.get(idx);
        const plan = chapterPlanMap().get(idx) || {};
        if (!card) return `<article class="nvp-card"><div class="nvp-card-head"><div class="nvp-card-title">第 ${esc(idx)} 章 · ${esc(textValue(plan.title) || '未命名')}</div><div class="nvp-card-actions">${badge('未生成', 'warn')}</div></div><div class="nvp-hint" style="margin-top:7px">${planComplete(plan) ? '章纲已就绪，等待生成内容卡。' : '章纲中缺少本章规划。'}</div></article>`;
        return cardHtml(idx, card);
      }).join('')}
    </div>`}
  </section>`;
}

function cardHtml(idx, card) {
  const complete = cardComplete(card);
  const beats = asArray(card.beats);
  return `<article class="nvp-card">
    <div class="nvp-card-head">
      <div class="nvp-card-title">第 ${esc(idx)} 章 · ${esc(textValue(card.title) || `第 ${idx} 章`)}</div>
      <div class="nvp-card-actions">${badge(complete ? '结构完整' : '待补全', complete ? 'ok' : 'warn')}<button class="nvp-btn nvp-btn-sm" data-nvp-action="card-edit" data-idx="${esc(idx)}">编辑内容卡</button></div>
    </div>
    <div class="nvp-card-body">
      ${kvHtml('目标', card.objective)}
      ${kvHtml('冲突', card.conflict)}
      ${kvHtml('结果', card.result)}
      ${kvHtml('情节点', `${beats.length} 个`)}
      <div class="nvp-kv" style="grid-column:1/-1"><b>关键帧</b><span class="nvp-clamp-2">${esc(card.key_frame || '—')}</span></div>
    </div>
  </article>`;
}

function kvHtml(label, value) {
  return `<div class="nvp-kv"><b>${esc(label)}</b><span class="nvp-clamp-2">${esc(textValue(value) || '—')}</span></div>`;
}

function assetsPanelHtml() {
  const step = stepByKey('assets');
  const cardsStep = stepByKey('cards');
  const list = filteredAssets();
  const plan = assetPlan();
  const blockers = assetBlockers();
  const confirmed = Boolean(data()?.pipeline?.asset_confirmation?.confirmed);
  const disabled = anyBusy();
  const canBuild = cardsStep.complete && !disabled;
  return `<section class="nvp-panel">
    <div class="nvp-panel-head">
      <div><h3 class="nvp-panel-title">第 3 步 · 布置资产与画布参考</h3><div class="nvp-panel-sub">按章节内容提取人物、环境、物品，生成生图提示词并同步到画布；人工确认后才能进入正文续写。</div></div>
      <div class="nvp-panel-actions">${badge(confirmed ? '资产已确认' : `${assets().length} 项资产`, confirmed ? 'ok' : (assets().length ? 'warn' : ''))}</div>
    </div>
    <div class="nvp-grid nvp-grid-4">
      <label class="nvp-field"><span class="nvp-label">起始章</span><input class="nvp-input" id="nvp-assets-from" type="number" min="1" step="1" value="${esc(state.assetFilter.from)}"></label>
      <label class="nvp-field"><span class="nvp-label">结束章</span><input class="nvp-input" id="nvp-assets-to" type="number" min="1" step="1" value="${esc(state.assetFilter.to)}"></label>
      <label class="nvp-field"><span class="nvp-label">画布 ID</span><input class="nvp-input" id="nvp-canvas-id" value="${esc(state.canvasId)}" placeholder="CV-MAIN"></label>
      <div class="nvp-field"><span class="nvp-label">筛选</span><button class="nvp-btn" data-nvp-action="asset-filter" ${disabled ? 'disabled' : ''}>应用章节筛选</button></div>
    </div>
    <div class="nvp-inline" style="margin-top:11px">
      <button class="nvp-btn nvp-btn-primary" data-nvp-action="asset-build" ${canBuild ? '' : 'disabled'}>按内容卡生成资产计划</button>
      <button class="nvp-btn" data-nvp-action="assets-sync" ${!assets().length || disabled ? 'disabled' : ''}>同步到画布</button>
      <button class="nvp-btn nvp-btn-ok" data-nvp-action="assets-confirm" ${!assets().length || disabled ? 'disabled' : ''}>${confirmed ? '重新确认资产' : '确认资产计划'}</button>
      ${!cardsStep.complete ? '<span class="nvp-hint">第 2 步内容卡未完整，资产生成已锁定。</span>' : ''}
    </div>
    ${plan.synced_canvas_id ? `<div class="nvp-hint" style="margin-top:8px">最近同步：${esc(plan.synced_canvas_id)} · 新建 ${esc(numberValue(plan.canvas_summary?.created, 0))} / 更新 ${esc(numberValue(plan.canvas_summary?.updated, 0))} / 跳过 ${esc(numberValue(plan.canvas_summary?.skipped, 0))} / 连线 ${esc(numberValue(plan.canvas_summary?.linked, 0))}</div>` : ''}
    ${blockers.length ? `<div class="nvp-alert nvp-alert-warn" style="margin-top:10px"><b>确认前仍需处理 ${esc(blockers.length)} 项阻塞。</b><ul class="nvp-blocker-list">${blockers.slice(0, 8).map((item) => `<li>${esc(item)}</li>`).join('')}</ul>${blockers.length > 8 ? `<div class="nvp-hint" style="margin-top:4px">另有 ${esc(blockers.length - 8)} 项，可在确认清单中查看。</div>` : ''}</div>` : (assets().length ? '<div class="nvp-alert nvp-alert-ok" style="margin-top:10px">当前资产计划没有阻塞项，可进入确认。</div>' : '')}
    ${blockerListHtml(step.blockers)}
    <div class="nvp-divider"></div>
    ${!assets().length ? `<div class="nvp-empty"><b>还没有资产计划</b>完成内容卡后，点击“按内容卡生成资产计划”。</div>` : `<div class="nvp-asset-groups">${assetGroupsHtml(list)}</div>`}
  </section>`;
}

function assetBlockers() {
  return assets().flatMap((asset) => {
    if (asset.required === false) return [];
    return asArray(asset.blockers).map((item) => String(item)).filter(Boolean);
  });
}

function assetGroupsHtml(list) {
  return Object.entries(KIND_META).map(([kind, meta]) => {
    const group = list.filter((asset) => String(asset.kind || '') === kind);
    return `<section class="nvp-asset-group" aria-label="${esc(meta.label)}资产">
      <div class="nvp-asset-group-head"><span>${meta.icon}</span><span>${esc(meta.label)}</span><span class="nvp-asset-group-count">${esc(group.length)} 项</span></div>
      ${group.length ? `<div class="nvp-asset-list">${group.map(assetHtml).join('')}</div>` : '<div class="nvp-hint">当前筛选范围没有此类资产。</div>'}
    </section>`;
  }).join('');
}

function assetHtml(asset) {
  const refs = asArray(asset.reference_images);
  const blockerCount = asArray(asset.blockers).filter(Boolean).length;
  const kind = String(asset.status || '') === 'blocked' ? 'err' : 'ok';
  return `<article class="nvp-asset">
    <div class="nvp-asset-top"><div class="nvp-asset-name">${esc(textValue(asset.name) || textValue(asset.id) || '未命名资产')}</div>${badge(textValue(asset.id) || '无 ID', 'acc')}</div>
    <div class="nvp-inline" style="margin-top:5px">${badge(asset.status === 'blocked' ? '阻塞' : '就绪', kind)}${asset.required === false ? badge('非必需') : badge('必需', 'warn')}<span class="nvp-hint">${esc(refs.length)} 张参考图</span></div>
    <div class="nvp-prompt nvp-prompt-clamp" title="${esc(asset.prompt || '')}">${esc(textValue(asset.prompt) || '尚未填写提示词')}</div>
    <div class="nvp-asset-foot"><span class="nvp-hint">章节：${esc(asArray(asset.chapters).join('、') || '—')}</span><span class="nvp-grow"></span><button class="nvp-btn nvp-btn-sm" data-nvp-action="asset-edit" data-asset-id="${esc(assetKey(asset))}">编辑资产</button></div>
    ${blockerCount ? `<div class="nvp-hint" style="margin-top:6px;color:#ffd18e">${esc(blockerCount)} 项阻塞</div>` : ''}
  </article>`;
}

function prosePanelHtml() {
  const step = stepByKey('prose');
  const confirmed = Boolean(data()?.pipeline?.asset_confirmation?.confirmed);
  const all = filteredProseIndexes();
  const pageSize = 20;
  const pages = Math.max(1, Math.ceil(all.length / pageSize));
  const page = clamp(intValue(state.proseFilter.page, 1), 1, pages);
  state.proseFilter.page = page;
  const pageItems = all.slice((page - 1) * pageSize, page * pageSize);
  const expected = numberValue(data()?.summary?.expected, 0);
  return `<section class="nvp-panel">
    <div class="nvp-panel-head">
      <div><h3 class="nvp-panel-title">第 4 步 · 续写正文</h3><div class="nvp-panel-sub">正文将以章纲、内容卡、资产计划和前文为上下文。资产未确认时必须显式勾选强制继续。</div></div>
      <div class="nvp-panel-actions">${badge(`${step.done}/${step.total || expected} 章`, step.complete ? 'ok' : 'warn')}</div>
    </div>
    ${!confirmed ? '<div class="nvp-alert nvp-alert-warn" style="margin-bottom:10px"><b>资产计划尚未确认。</b>续写弹窗默认锁定提交；如确需跳过，请勾选“强制继续”，系统会按接口规则处理。</div>' : '<div class="nvp-alert nvp-alert-ok" style="margin-bottom:10px">资产计划已确认，可按章节续写或重写正文。</div>'}
    <div class="nvp-grid nvp-grid-4">
      <label class="nvp-field"><span class="nvp-label">起始章</span><input class="nvp-input" id="nvp-prose-from" type="number" min="1" step="1" value="${esc(state.proseFilter.from)}"></label>
      <label class="nvp-field"><span class="nvp-label">结束章</span><input class="nvp-input" id="nvp-prose-to" type="number" min="1" step="1" value="${esc(state.proseFilter.to)}"></label>
      <label class="nvp-field"><span class="nvp-label">正文状态</span><select class="nvp-select" id="nvp-prose-status"><option value="all" ${state.proseFilter.status === 'all' ? 'selected' : ''}>全部</option><option value="done" ${state.proseFilter.status === 'done' ? 'selected' : ''}>已完成</option><option value="pending" ${state.proseFilter.status === 'pending' ? 'selected' : ''}>待写 / 草稿</option><option value="error" ${state.proseFilter.status === 'error' ? 'selected' : ''}>失败</option></select></label>
      <div class="nvp-field"><span class="nvp-label">筛选</span><button class="nvp-btn" data-nvp-action="prose-filter" ${anyBusy() ? 'disabled' : ''}>应用筛选</button></div>
    </div>
    ${blockerListHtml(step.blockers)}
    <div class="nvp-divider"></div>
    ${!all.length ? `<div class="nvp-empty"><b>没有可操作的章节</b>请先生成章纲和内容卡，或调整章节范围/状态筛选。</div>` : `<div class="nvp-table-wrap">
      <table class="nvp-table">
        <thead><tr><th>章节</th><th>章纲</th><th>内容卡</th><th>正文状态</th><th>字数</th><th style="text-align:right">操作</th></tr></thead>
        <tbody>${pageItems.map(proseRowHtml).join('')}</tbody>
      </table>
    </div>
    <div class="nvp-pagebar"><span class="nvp-hint">共 ${esc(all.length)} 章 · 第 ${esc(page)}/${esc(pages)} 页</span><span class="nvp-inline"><button class="nvp-btn nvp-btn-sm" data-nvp-action="prose-page" data-page="${esc(page - 1)}" ${page <= 1 ? 'disabled' : ''}>上一页</button><button class="nvp-btn nvp-btn-sm" data-nvp-action="prose-page" data-page="${esc(page + 1)}" ${page >= pages ? 'disabled' : ''}>下一页</button></span></div>`}
  </section>`;
}

function filteredProseIndexes() {
  const status = state.proseFilter.status;
  const from = intValue(state.proseFilter.from, 1);
  const to = intValue(state.proseFilter.to, 0);
  return knownChapterIndexes().filter((idx) => idx >= from && (!to || idx <= to)).filter((idx) => {
    if (status === 'all') return true;
    const current = chapterRowStatus(chapterRowMap().get(idx));
    if (status === 'done') return current.key === 'done';
    if (status === 'pending') return ['pending', 'draft', 'writing', 'missing'].includes(current.key);
    if (status === 'error') return current.key === 'error';
    return true;
  });
}

function proseRowHtml(idx) {
  const row = chapterRowMap().get(idx);
  const card = chapterCardMap().get(idx);
  const plan = chapterPlanMap().get(idx);
  const current = chapterRowStatus(row);
  const hasRow = Boolean(row);
  const cardReady = cardComplete(card);
  return `<tr>
    <td><b>第 ${esc(idx)} 章</b><div class="nvp-hint">${esc(chapterTitle(idx))}</div></td>
    <td>${planComplete(plan) ? badge('已规划', 'ok') : badge('缺失', 'warn')}</td>
    <td>${cardReady ? badge('完整', 'ok') : badge(card ? '待补全' : '未生成', 'warn')}</td>
    <td>${badge(current.label, current.kind)}</td>
    <td>${esc(numberValue(row?.words, 0))}</td>
    <td><div class="nvp-table-actions">
      <button class="nvp-btn nvp-btn-sm" data-nvp-action="prose-open" data-idx="${esc(idx)}" data-mode="continue" ${!hasRow || !cardReady || anyBusy() ? 'disabled' : ''}>续写</button>
      <button class="nvp-btn nvp-btn-sm" data-nvp-action="prose-open" data-idx="${esc(idx)}" data-mode="rewrite" ${!hasRow || !cardReady || anyBusy() ? 'disabled' : ''}>重写</button>
    </div></td>
  </tr>`;
}

function blockerListHtml(blockers) {
  const list = asArray(blockers).map(String).filter(Boolean);
  if (!list.length) return '';
  return `<ul class="nvp-blocker-list">${list.slice(0, 8).map((item) => `<li>${esc(item)}</li>`).join('')}</ul>${list.length > 8 ? `<div class="nvp-hint">另有 ${esc(list.length - 8)} 项阻塞。</div>` : ''}`;
}

function modalHtml() {
  if (!state?.modal) return '';
  const modal = state.modal;
  if (modal.type === 'card') return cardModalHtml(modal);
  if (modal.type === 'asset') return assetModalHtml(modal);
  if (modal.type === 'confirm') return confirmModalHtml(modal);
  if (modal.type === 'prose') return proseModalHtml(modal);
  return '';
}

function modalFrame(title, body, footer, extraClass = '') {
  return `<div class="nvp-overlay" data-nvp-action="modal-backdrop">
    <section class="nvp-modal ${extraClass}" role="dialog" aria-modal="true" aria-labelledby="nvp-modal-title">
      <header class="nvp-modal-head"><h3 class="nvp-modal-title" id="nvp-modal-title">${esc(title)}</h3><button class="nvp-btn nvp-btn-sm nvp-btn-ghost" data-nvp-action="modal-close" aria-label="关闭">✕</button></header>
      <div class="nvp-modal-body" data-nvp-modal-form>${body}</div>
      <footer class="nvp-modal-foot">${footer}</footer>
    </section>
  </div>`;
}

function modalError(modal) {
  return modal?.error ? `<div class="nvp-modal-error" role="alert">${esc(modal.error)}</div>` : '';
}

function cardModalHtml(modal) {
  const values = asObject(modal.values);
  const beats = typeof values.beats === 'string' ? values.beats : JSON.stringify(asArray(values.beats), null, 2);
  const body = `${modalError(modal)}
    <div class="nvp-grid nvp-grid-2">
      <label class="nvp-field"><span class="nvp-label">章节标题</span><input class="nvp-input" data-nvp-field="title" value="${esc(values.title || '')}"></label>
      <label class="nvp-field"><span class="nvp-label">关键帧</span><input class="nvp-input" data-nvp-field="key_frame" value="${esc(values.key_frame || '')}"></label>
    </div>
    <label class="nvp-field" style="margin-top:9px"><span class="nvp-label">章节目标 <span class="nvp-required">*</span></span><textarea class="nvp-area" data-nvp-field="objective" rows="3">${esc(values.objective || '')}</textarea></label>
    <div class="nvp-grid nvp-grid-2" style="margin-top:9px">
      <label class="nvp-field"><span class="nvp-label">核心冲突 <span class="nvp-required">*</span></span><textarea class="nvp-area" data-nvp-field="conflict" rows="3">${esc(values.conflict || '')}</textarea></label>
      <label class="nvp-field"><span class="nvp-label">章节结果 <span class="nvp-required">*</span></span><textarea class="nvp-area" data-nvp-field="result" rows="3">${esc(values.result || '')}</textarea></label>
    </div>
    <label class="nvp-field" style="margin-top:9px"><span class="nvp-label">转折点</span><textarea class="nvp-area" data-nvp-field="turning_point" rows="2">${esc(values.turning_point || '')}</textarea></label>
    <div class="nvp-grid nvp-grid-2" style="margin-top:9px">
      <label class="nvp-field"><span class="nvp-label">章首状态</span><textarea class="nvp-area" data-nvp-field="start_state" rows="2">${esc(values.start_state || '')}</textarea></label>
      <label class="nvp-field"><span class="nvp-label">章末状态</span><textarea class="nvp-area" data-nvp-field="end_state" rows="2">${esc(values.end_state || '')}</textarea></label>
    </div>
    <label class="nvp-field" style="margin-top:9px"><span class="nvp-label">情节点 JSON <span class="nvp-required">*</span></span><textarea class="nvp-area nvp-code" data-nvp-field="beats" rows="12">${esc(beats)}</textarea><span class="nvp-hint">必须是 JSON 数组，至少 3 个情节点；保留 order、action、visual 等字段。</span></label>`;
  return modalFrame(`编辑第 ${modal.idx} 章内容卡`, body, `<button class="nvp-btn" data-nvp-action="modal-close">取消</button><button class="nvp-btn nvp-btn-primary" data-nvp-action="card-save" ${state.busy === 'card-save' ? 'disabled' : ''}>${state.busy === 'card-save' ? '保存中…' : '保存内容卡'}</button>`, 'nvp-modal-wide');
}

function assetModalHtml(modal) {
  const values = asObject(modal.values);
  const body = `${modalError(modal)}
    <div class="nvp-grid nvp-grid-3">
      <label class="nvp-field"><span class="nvp-label">资产名称</span><input class="nvp-input" value="${esc(modal.name || '')}" readonly></label>
      <label class="nvp-field"><span class="nvp-label">资产 ID</span><input class="nvp-input" value="${esc(modal.assetId || '')}" readonly></label>
      <label class="nvp-field"><span class="nvp-label">角色 / 用途</span><input class="nvp-input" data-nvp-field="role" value="${esc(values.role || '')}"></label>
    </div>
    <label class="nvp-field" style="margin-top:9px"><span class="nvp-label">生图提示词 <span class="nvp-required">*</span></span><textarea class="nvp-area" data-nvp-field="prompt" rows="6">${esc(values.prompt || '')}</textarea></label>
    <label class="nvp-field" style="margin-top:9px"><span class="nvp-label">负面提示词</span><textarea class="nvp-area" data-nvp-field="negative_prompt" rows="3">${esc(values.negative_prompt || '')}</textarea></label>
    <label class="nvp-field" style="margin-top:9px"><span class="nvp-label">参考图地址</span><textarea class="nvp-area nvp-code" data-nvp-field="reference_images" rows="4" placeholder="每行一个地址；没有参考图可留空">${esc(Array.isArray(values.reference_images_list) ? values.reference_images_list.join('\n') : String(values.reference_images_list || ''))}</textarea><span class="nvp-hint">提交时会按行拆分为 reference_images 数组。</span></label>
    <div class="nvp-grid nvp-grid-2" style="margin-top:9px">
      <label class="nvp-field"><span class="nvp-label">画面比例</span><input class="nvp-input" data-nvp-field="ratio" value="${esc(values.ratio || '')}" placeholder="2:3 / 16:9 / 1:1"></label>
      <label class="nvp-check" style="align-self:end;padding-bottom:8px"><input type="checkbox" data-nvp-field="required" ${values.required !== false ? 'checked' : ''}>必需资产（阻塞会阻止确认）</label>
    </div>`;
  return modalFrame(`编辑资产 · ${modal.name || modal.assetId}`, body, `<button class="nvp-btn" data-nvp-action="modal-close">取消</button><button class="nvp-btn nvp-btn-primary" data-nvp-action="asset-save" ${state.busy === 'asset-save' ? 'disabled' : ''}>${state.busy === 'asset-save' ? '保存中…' : '保存资产'}</button>`, 'nvp-modal-wide');
}

function confirmModalHtml(modal) {
  const list = asArray(modal.blockers).map(String).filter(Boolean);
  const body = `${modalError(modal)}
    <p class="nvp-modal-note">确认后，正文续写会以当前资产计划作为上下文。${list.length ? '当前存在阻塞项；如继续，请显式勾选强制确认并填写原因。' : '当前没有阻塞项。'}</p>
    ${list.length ? `<div class="nvp-alert nvp-alert-warn"><b>阻塞清单（${esc(list.length)}）</b><ul class="nvp-blocker-list">${list.map((item) => `<li>${esc(item)}</li>`).join('')}</ul></div>` : '<div class="nvp-alert nvp-alert-ok">资产计划无阻塞项。</div>'}
    <label class="nvp-field" style="margin-top:10px"><span class="nvp-label">确认备注</span><textarea class="nvp-area" data-nvp-field="note" rows="3" placeholder="记录本次确认依据或强制确认原因">${esc(modal.values?.note || '')}</textarea></label>
    <label class="nvp-field" style="margin-top:9px"><span class="nvp-label">操作人</span><input class="nvp-input" data-nvp-field="operator" value="${esc(modal.values?.operator || state.operator)}"></label>
    ${list.length ? `<label class="nvp-check" style="margin-top:10px"><input type="checkbox" data-nvp-field="forced" ${modal.values?.forced ? 'checked' : ''}>我已知晓阻塞项，强制确认资产计划</label>` : ''}`;
  return modalFrame('确认资产计划', body, `<button class="nvp-btn" data-nvp-action="modal-close">取消</button><button class="nvp-btn ${list.length ? 'nvp-btn-danger' : 'nvp-btn-ok'}" data-nvp-action="confirm-submit" ${state.busy === 'confirm' || (list.length && !modal.values?.forced) ? 'disabled' : ''}>${state.busy === 'confirm' ? '确认中…' : (list.length ? '强制确认' : '确认资产')}</button>`, 'nvp-modal-wide');
}

function proseModalHtml(modal) {
  const values = asObject(modal.values);
  const confirmed = Boolean(data()?.pipeline?.asset_confirmation?.confirmed);
  const needsForce = !confirmed;
  const body = `${modalError(modal)}
    <div class="nvp-alert ${needsForce ? 'nvp-alert-warn' : 'nvp-alert-ok'}"><b>${esc(chapterTitle(modal.idx))}</b><br>${needsForce ? '资产计划尚未确认。提交按钮默认锁定，勾选强制继续后才能操作。' : '资产计划已确认，可执行续写或重写。'}</div>
    <div class="nvp-grid nvp-grid-2" style="margin-top:10px">
      <label class="nvp-field"><span class="nvp-label">写作模式</span><select class="nvp-select" data-nvp-field="mode"><option value="continue" ${values.mode !== 'rewrite' ? 'selected' : ''}>承接现有正文续写</option><option value="rewrite" ${values.mode === 'rewrite' ? 'selected' : ''}>重写整章</option></select></label>
      <label class="nvp-field"><span class="nvp-label">操作人</span><input class="nvp-input" data-nvp-field="operator" value="${esc(values.operator || state.operator)}"></label>
    </div>
    <label class="nvp-field" style="margin-top:9px"><span class="nvp-label">本次写作要求</span><textarea class="nvp-area" data-nvp-field="instruction" rows="5" placeholder="例如：强化对手压迫感，结尾留下反转钩子">${esc(values.instruction || '')}</textarea></label>
    ${needsForce ? `<label class="nvp-check" style="margin-top:10px"><input type="checkbox" data-nvp-field="force" ${values.force ? 'checked' : ''}>资产未确认，我仍要强制继续</label>` : ''}`;
  return modalFrame(`${values.mode === 'rewrite' ? '重写' : '续写'}第 ${modal.idx} 章`, body, `<button class="nvp-btn" data-nvp-action="modal-close">取消</button><button class="nvp-btn nvp-btn-primary" data-nvp-action="prose-submit" ${state.busy === 'prose' || (needsForce && !values.force) ? 'disabled' : ''}>${state.busy === 'prose' ? '生成中…' : (values.mode === 'rewrite' ? '确认重写' : '开始续写')}</button>`, 'nvp-modal-wide');
}

function notifyChange() {
  try {
    const result = optionsRef?.onChange?.();
    if (result && typeof result.catch === 'function') result.catch(() => { /* 父页面刷新失败不覆盖组件当前结果 */ });
  } catch { /* ignore */ }
}

async function loadPipeline({ initial = false } = {}) {
  const runId = session;
  if (initial) {
    state.loading = true;
    state.error = '';
    render();
  }
  try {
    const result = await ctxRef.api.get(`/api/novels/${encodeURIComponent(state.novelId)}/pipeline`);
    if (runId !== session || !rootEl) return null;
    if (!result || result.ok === false) throw new Error(result?.error || '生产线接口返回异常');
    state.data = result;
    state.loading = false;
    state.error = '';
    ensureFilters();
    if (initial && !state.activeStepTouched) {
      state.activeStep = firstIncompleteStep();
    }
    render();
    return result;
  } catch (error) {
    if (runId !== session || !rootEl) return null;
    state.loading = false;
    if (initial || !state.data) state.error = errorText(error);
    else toast(`状态刷新失败：${errorText(error)}`, 'err');
    render();
    return null;
  }
}

function setJobState(job, fallbackLabel, fallbackKind) {
  const previous = state.task || {};
  const status = String(job?.status || previous.status || 'queued').toLowerCase();
  state.task = {
    ...previous,
    ...asObject(job),
    label: textValue(job?.title) || previous.label || fallbackLabel,
    kind: previous.kind || fallbackKind,
    status,
    percentage: progressOf(job),
    error: ['error', 'failed'].includes(status) ? String(job?.error || job?.message || previous.error || '任务执行失败') : (job?.error ? String(job.error) : previous.error),
    updatedAt: Date.now(),
  };
}

function clearJobTimers() {
  if (state?.stopJobWatch) {
    try { state.stopJobWatch(); } catch { /* ignore */ }
  }
  if (state?.pollTimer) {
    try { clearTimeout(state.pollTimer); } catch { /* ignore */ }
  }
  if (state) {
    state.stopJobWatch = null;
    state.pollTimer = null;
  }
}

function finishWatchedJob(job, label, onDone) {
  if (!state?.task || state.task.finished) return;
  state.task.finished = true;
  state.task.status = String(job?.status || 'done').toLowerCase();
  state.task.percentage = jobTerminal(job) ? progressOf(job) : state.task.percentage;
  clearJobTimers();
  render();
  if (state.task.status === 'done') {
    toast(`${label}已完成`, 'ok');
    void loadPipeline().then(() => {
      onDone?.(job);
      notifyChange();
    });
  } else if (state.task.status !== 'canceled' && state.task.status !== 'cancelled') {
    toast(`${label}失败：${state.task.error || '请查看任务日志'}`, 'err');
  }
}

function watchJob(jobId, kind, label, onDone) {
  clearJobTimers();
  state.task = { jobId, kind, label, status: 'queued', percentage: 0, error: '', finished: false };
  render();
  const runId = session;
  let stopped = false;

  const apply = (job) => {
    if (stopped || runId !== session || !rootEl) return;
    setJobState(job, label, kind);
    const status = String(state.task.status || '').toLowerCase();
    if (TERMINAL_JOB_STATES.has(status)) {
      finishWatchedJob(job, label, onDone);
    } else {
      render();
    }
  };

  const stop = () => {
    stopped = true;
    if (state?.pollTimer) clearTimeout(state.pollTimer);
    if (state) {
      state.stopJobWatch = null;
      state.pollTimer = null;
    }
  };

  if (typeof ctxRef?.watchJob === 'function') {
    state.stopJobWatch = ctxRef.watchJob(jobId, apply, { onDone: (job) => apply(job) });
    return;
  }

  const tick = async () => {
    if (stopped || runId !== session) return;
    try {
      const result = await ctxRef.api.get(`/api/jobs/${encodeURIComponent(jobId)}`);
      const job = result?.job || result;
      apply(job);
      if (!TERMINAL_JOB_STATES.has(String(job?.status || '').toLowerCase()) && !stopped) {
        state.pollTimer = setTimeout(tick, 1200);
      }
    } catch (error) {
      apply({ status: 'error', error: errorText(error), percentage: 0 });
    }
  };
  state.stopJobWatch = stop;
  void tick();
}

async function startJobRequest(path, body, kind, label, onDone) {
  if (anyBusy()) return;
  state.busy = `${kind}-request`;
  state.task = { jobId: '', kind, label: `${label} · 提交中`, status: 'queued', percentage: 0, error: '', finished: false };
  render();
  try {
    const result = await ctxRef.api.post(path, body);
    if (!result?.jobId) {
      state.busy = '';
      state.task = null;
      if (result?.alreadyReady) {
        toast('章节大纲已存在，已刷新状态', 'ok');
        await loadPipeline();
      } else {
        toast(`${label}已提交`, 'ok');
        await loadPipeline();
        notifyChange();
      }
      return;
    }
    state.busy = '';
    watchJob(result.jobId, kind, label, onDone);
  } catch (error) {
    state.busy = '';
    state.task = { jobId: '', kind, label, status: 'error', error: errorText(error), percentage: 0, finished: true };
    render();
    toast(`${label}失败：${errorText(error)}`, 'err');
  }
}

function outlineRun() {
  const batchSize = clamp(intValue(fieldValue('#nvp-outline-batch'), state.outline.batchSize), 1, 50);
  const concurrency = clamp(intValue(fieldValue('#nvp-outline-concurrency'), state.outline.concurrency), 1, 8);
  const sectionsConcurrency = clamp(intValue(fieldValue('#nvp-outline-sections-concurrency'), state.outline.sectionsConcurrency), 1, 8);
  const instruction = fieldValue('#nvp-outline-instruction').trim();
  state.outline = { batchSize, concurrency, sectionsConcurrency, instruction };
  const refresh = Boolean(data()?.outlineVersion || chapterPlans().length);
  void startJobRequest(
    `/api/novels/${encodeURIComponent(state.novelId)}/pipeline/outline`,
    { batchSize, concurrency, sectionsConcurrency, instruction, refresh, onlyEmptySections: !refresh },
    'outline',
    refresh ? '刷新章节大纲' : '生成章节大纲',
  );
}

function cardsRun() {
  const plans = chapterPlans();
  const maxIdx = Math.max(1, plans.length ? Math.max(...plans.map((plan) => Number(plan.idx))) : intValue(data()?.summary?.expected, 1));
  const from = clamp(intValue(fieldValue('#nvp-cards-from'), state.cards.from || 1), 1, maxIdx);
  const to = clamp(intValue(fieldValue('#nvp-cards-to'), state.cards.to || from), from, maxIdx);
  const onlyMissing = fieldValue('#nvp-cards-only-missing') !== 'false';
  const instruction = fieldValue('#nvp-cards-instruction').trim();
  state.cards = { ...state.cards, from, to, onlyMissing, instruction };
  if (to - from + 1 > 50) {
    toast('单次最多生成 50 章内容卡', 'err');
    return;
  }
  void startJobRequest(
    `/api/novels/${encodeURIComponent(state.novelId)}/pipeline/chapter-cards`,
    { from, to, onlyMissing, instruction },
    'cards',
    `生成第 ${from}–${to} 章内容卡`,
  );
}

function cardsFilter() {
  const plans = chapterPlans();
  const maxIdx = Math.max(1, plans.length ? Math.max(...plans.map((plan) => Number(plan.idx))) : intValue(data()?.summary?.expected, 1));
  const from = clamp(intValue(fieldValue('#nvp-cards-from'), state.cards.from || 1), 1, maxIdx);
  const to = clamp(intValue(fieldValue('#nvp-cards-to'), state.cards.to || from), from, maxIdx);
  state.cards.from = from;
  state.cards.to = to;
  state.cards.onlyMissing = fieldValue('#nvp-cards-only-missing') !== 'false';
  state.cards.instruction = fieldValue('#nvp-cards-instruction');
  render();
}

function openCardEdit(idx) {
  const card = chapterCardMap().get(Number(idx)) || {};
  state.modal = {
    type: 'card',
    idx: Number(idx),
    values: {
      title: card.title || '',
      objective: card.objective || '',
      conflict: card.conflict || '',
      turning_point: card.turning_point || '',
      result: card.result || '',
      start_state: card.start_state || '',
      end_state: card.end_state || '',
      key_frame: card.key_frame || '',
      beats: asArray(card.beats),
    },
    error: '',
  };
  render();
}

async function saveCard() {
  if (!state.modal || state.busy) return;
  collectModalForm();
  const values = asObject(state.modal.values);
  let beats;
  try {
    beats = JSON.parse(String(values.beats || ''));
    if (!Array.isArray(beats) || beats.length < 3) throw new Error('情节点必须是至少 3 项的 JSON 数组');
  } catch (error) {
    state.modal.error = `情节点 JSON 无效：${errorText(error)}`;
    render();
    return;
  }
  state.busy = 'card-save';
  state.modal.error = '';
  render();
  try {
    await ctxRef.api.put(`/api/novels/${encodeURIComponent(state.novelId)}/pipeline/chapter-cards/${encodeURIComponent(state.modal.idx)}`, {
      title: values.title,
      objective: values.objective,
      conflict: values.conflict,
      turning_point: values.turning_point,
      result: values.result,
      start_state: values.start_state,
      end_state: values.end_state,
      key_frame: values.key_frame,
      beats,
    });
    state.busy = '';
    state.modal = null;
    await loadPipeline();
    toast('内容卡已保存', 'ok');
    notifyChange();
  } catch (error) {
    state.busy = '';
    state.modal.error = errorText(error);
    render();
  }
}

function assetBuild() {
  const from = intValue(fieldValue('#nvp-assets-from'), 0);
  const to = intValue(fieldValue('#nvp-assets-to'), 0);
  state.assetFilter = { from: from || '', to: to || '' };
  state.canvasId = fieldValue('#nvp-canvas-id').trim() || 'CV-MAIN';
  state.busy = 'asset-build';
  render();
  ctxRef.api.post(`/api/novels/${encodeURIComponent(state.novelId)}/pipeline/assets/build`, { chapterFrom: from || 0, chapterTo: to || 0 })
    .then(async () => {
      state.busy = '';
      await loadPipeline();
      toast('资产计划已生成', 'ok');
      notifyChange();
    })
    .catch((error) => {
      state.busy = '';
      toast(`资产计划生成失败：${errorText(error)}`, 'err');
      render();
    });
}

function assetFilterApply() {
  state.assetFilter = {
    from: intValue(fieldValue('#nvp-assets-from'), 0) || '',
    to: intValue(fieldValue('#nvp-assets-to'), 0) || '',
  };
  state.canvasId = fieldValue('#nvp-canvas-id').trim() || 'CV-MAIN';
  render();
}

function openAssetEdit(assetId) {
  const asset = assets().find((item) => assetKey(item) === assetId) || null;
  if (!asset) {
    toast('资产计划中找不到该资产', 'err');
    return;
  }
  const refs = asArray(asset.reference_images);
  state.modal = {
    type: 'asset',
    assetId,
    name: textValue(asset.name) || assetId,
    values: {
      prompt: asset.prompt || '',
      negative_prompt: asset.negative_prompt || '',
      required: asset.required !== false,
      reference_images_list: refs,
      ratio: asset.ratio || '',
      role: asset.role || '',
    },
    error: '',
  };
  render();
}

async function saveAsset() {
  if (!state.modal || state.busy) return;
  collectModalForm();
  const values = asObject(state.modal.values);
  const references = String(values.reference_images_list || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  state.busy = 'asset-save';
  state.modal.error = '';
  render();
  try {
    await ctxRef.api.put(`/api/novels/${encodeURIComponent(state.novelId)}/pipeline/assets/${encodeURIComponent(state.modal.assetId)}`, {
      prompt: values.prompt,
      negative_prompt: values.negative_prompt,
      required: values.required !== false,
      reference_images: references,
      ratio: values.ratio,
      role: values.role,
    });
    state.busy = '';
    state.modal = null;
    await loadPipeline();
    toast('资产已保存', 'ok');
    notifyChange();
  } catch (error) {
    state.busy = '';
    state.modal.error = errorText(error);
    render();
  }
}

async function syncCanvas() {
  if (anyBusy()) return;
  const canvasId = fieldValue('#nvp-canvas-id').trim() || 'CV-MAIN';
  state.canvasId = canvasId;
  state.busy = 'asset-sync';
  render();
  try {
    const result = await ctxRef.api.post(`/api/novels/${encodeURIComponent(state.novelId)}/pipeline/assets/sync-canvas`, { canvasId });
    state.busy = '';
    await loadPipeline();
    toast(`画布同步完成：新建 ${numberValue(result.created, 0)}，更新 ${numberValue(result.updated, 0)}`, 'ok');
    notifyChange();
  } catch (error) {
    state.busy = '';
    toast(`画布同步失败：${errorText(error)}`, 'err');
    render();
  }
}

function openAssetConfirm() {
  const blockers = assetBlockers();
  state.modal = {
    type: 'confirm',
    blockers,
    values: { note: '', operator: state.operator, forced: false },
    error: '',
  };
  render();
}

async function confirmAssets() {
  if (!state.modal || state.busy) return;
  collectModalForm();
  const values = asObject(state.modal.values);
  if (state.modal.blockers.length && !values.forced) {
    state.modal.error = '存在阻塞项，必须勾选强制确认';
    render();
    return;
  }
  state.busy = 'confirm';
  state.modal.error = '';
  render();
  try {
    state.operator = rememberOperator(values.operator || state.operator);
    await ctxRef.api.post(`/api/novels/${encodeURIComponent(state.novelId)}/pipeline/assets/confirm`, {
      forced: Boolean(values.forced),
      note: String(values.note || ''),
      operator: state.operator,
    });
    state.busy = '';
    state.modal = null;
    await loadPipeline();
    toast('资产计划已确认', 'ok');
    notifyChange();
  } catch (error) {
    state.busy = '';
    state.modal.error = errorText(error);
    render();
  }
}

function proseFilterApply() {
  const from = Math.max(1, intValue(fieldValue('#nvp-prose-from'), 1));
  const to = Math.max(0, intValue(fieldValue('#nvp-prose-to'), 0));
  state.proseFilter.from = from;
  state.proseFilter.to = to || '';
  state.proseFilter.status = fieldValue('#nvp-prose-status') || 'all';
  state.proseFilter.page = 1;
  render();
}

function openProse(idx, mode) {
  const confirmed = Boolean(data()?.pipeline?.asset_confirmation?.confirmed);
  state.modal = {
    type: 'prose',
    idx: Number(idx),
    values: {
      mode: mode === 'rewrite' ? 'rewrite' : 'continue',
      instruction: '',
      operator: state.operator,
      force: false,
    },
    error: '',
  };
  if (!confirmed) {
    // 未确认资产时默认锁定提交，必须由用户显式勾选强制继续。
    state.modal.values.force = false;
  }
  render();
}

async function submitProse() {
  if (!state.modal || state.busy) return;
  collectModalForm();
  const values = asObject(state.modal.values);
  const confirmed = Boolean(data()?.pipeline?.asset_confirmation?.confirmed);
  if (!confirmed && !values.force) {
    state.modal.error = '资产未确认，请勾选强制继续或先完成第 3 步';
    render();
    return;
  }
  state.busy = 'prose';
  state.modal.error = '';
  render();
  try {
    state.operator = rememberOperator(values.operator || state.operator);
    const result = await ctxRef.api.post(`/api/novels/${encodeURIComponent(state.novelId)}/pipeline/chapters/${encodeURIComponent(state.modal.idx)}/continue`, {
      mode: values.mode === 'rewrite' ? 'rewrite' : 'continue',
      instruction: String(values.instruction || ''),
      force: !confirmed && Boolean(values.force),
      operator: state.operator,
    });
    state.busy = '';
    const words = numberValue(result?.words ?? result?.chapter?.words, 0);
    state.modal = null;
    await loadPipeline();
    toast(words ? `第 ${result?.idx || ''} 章已保存，共 ${words} 字` : '正文已生成并保存', 'ok');
    notifyChange();
  } catch (error) {
    state.busy = '';
    state.modal.error = errorText(error);
    render();
  }
}

async function handleClick(event) {
  const target = event.target?.closest?.('[data-nvp-action]');
  if (!target || !rootEl?.contains(target)) return;
  const action = target.dataset.nvpAction;
  if (action === 'modal-backdrop' && event.target !== target) return;
  if (action === 'modal-backdrop' || action === 'modal-close') {
    if (state.busy) return;
    state.modal = null;
    render();
    return;
  }
  if (action === 'retry') { void loadPipeline({ initial: true }); return; }
  if (action === 'refresh') { void loadPipeline(); return; }
  if (action === 'legacy') { try { optionsRef?.openLegacy?.('outline'); } catch (error) { toast(errorText(error), 'err'); } return; }
  if (action === 'step') {
    const key = String(target.dataset.step || '');
    if (!STEP_META.some((step) => step.key === key)) return;
    state.activeStep = key;
    state.activeStepTouched = true;
    render();
    return;
  }
  if (action === 'outline-run') { outlineRun(); return; }
  if (action === 'cards-run') { cardsRun(); return; }
  if (action === 'cards-filter') { cardsFilter(); return; }
  if (action === 'card-edit') { openCardEdit(target.dataset.idx); return; }
  if (action === 'card-save') { void saveCard(); return; }
  if (action === 'asset-build') { assetBuild(); return; }
  if (action === 'asset-filter') { assetFilterApply(); return; }
  if (action === 'asset-edit') { openAssetEdit(String(target.dataset.assetId || '')); return; }
  if (action === 'asset-save') { void saveAsset(); return; }
  if (action === 'assets-sync') { void syncCanvas(); return; }
  if (action === 'assets-confirm') { openAssetConfirm(); return; }
  if (action === 'confirm-submit') { void confirmAssets(); return; }
  if (action === 'prose-filter') { proseFilterApply(); return; }
  if (action === 'prose-page') {
    const page = Math.max(1, intValue(target.dataset.page, 1));
    state.proseFilter.page = page;
    render();
    return;
  }
  if (action === 'prose-open') { openProse(target.dataset.idx, target.dataset.mode); return; }
  if (action === 'prose-submit') { void submitProse(); return; }
}

function handleChange(event) {
  const target = event.target;
  if (!target || !rootEl?.contains(target)) return;
  if (target.dataset?.nvpField === 'operator') {
    state.operator = rememberOperator(target.value);
    return;
  }
  if (target.dataset?.nvpField === 'mode' && state.modal?.type === 'prose') {
    collectModalForm();
    state.modal.values.mode = target.value === 'rewrite' ? 'rewrite' : 'continue';
    render();
    return;
  }
  if (target.dataset?.nvpField === 'force' && state.modal?.type === 'prose') {
    collectModalForm();
    state.modal.values.force = Boolean(target.checked);
    render();
    return;
  }
  if (target.dataset?.nvpField === 'required' && state.modal) {
    collectModalForm();
    return;
  }
  if (target.dataset?.nvpField === 'forced' && state.modal?.type === 'confirm') {
    collectModalForm();
    state.modal.values.forced = Boolean(target.checked);
    render();
  }
}

function handleKey(event) {
  if (event.key !== 'Escape' || !state?.modal || state.busy) return;
  state.modal = null;
  render();
}

export function mount(host, options = {}) {
  if (!host || typeof host.appendChild !== 'function') throw new Error('小说四步生产线缺少挂载节点');
  if (!options || !options.novelId) throw new Error('小说四步生产线缺少 novelId');
  if (!options.ctx?.api) throw new Error('小说四步生产线缺少 ctx.api');
  if (rootEl) unmount();

  session += 1;
  rootEl = host;
  ctxRef = options.ctx;
  optionsRef = options;
  state = initialState(options);
  ensureStyle();

  clickHandler = (event) => { void handleClick(event); };
  changeHandler = handleChange;
  keyHandler = handleKey;
  rootEl.addEventListener('click', clickHandler);
  rootEl.addEventListener('change', changeHandler);
  document.addEventListener('keydown', keyHandler);
  render();
  void loadPipeline({ initial: true });
  return { unmount };
}

export function unmount() {
  session += 1;
  clearJobTimers();
  if (rootEl && clickHandler) {
    try { rootEl.removeEventListener('click', clickHandler); } catch { /* ignore */ }
  }
  if (rootEl && changeHandler) {
    try { rootEl.removeEventListener('change', changeHandler); } catch { /* ignore */ }
  }
  if (typeof document !== 'undefined' && keyHandler) {
    try { document.removeEventListener('keydown', keyHandler); } catch { /* ignore */ }
  }
  if (styleEl?.parentNode) {
    try { styleEl.remove(); } catch { /* ignore */ }
  }
  clickHandler = null;
  changeHandler = null;
  keyHandler = null;
  styleEl = null;
  rootEl = null;
  ctxRef = null;
  optionsRef = null;
  state = null;
}

export default { mount, unmount };
