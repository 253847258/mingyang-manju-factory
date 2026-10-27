// 模块4 前端：制作台（分镜 → 关键帧 → 视频 → 整集成片）
// 约定：只使用 ctx.api / ctx.meta / ctx.toast / ctx.confirm / ctx.modal / ctx.watchJob / ctx.go
// 类名统一 rd- 前缀，样式自行注入（#rd-style，重复挂载不重复注入）

const STYLE_ID = 'rd-style';
const PAGE_SIZE = 120;          // 镜头卡片分批渲染阈值

let S = null;                   // 视图状态
let root = null;                // 挂载根节点
let ctxRef = null;              // ctx 引用
let stops = [];                 // ctx.watchJob 返回的停止函数
let timers = [];                // 定时器句柄
let liveTimer = 0;              // 任务进行中的节流刷新
let lastLive = 0;
let finishPanel = null;         // 成片包装弹窗 {modal, close}
let pipePanel = null;           // 整季流水线弹窗 {modal, close}

// ---------------- 小工具 ----------------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const attr = (s) => esc(s);
const num = (n) => (n === null || n === undefined ? 0 : Number(n) || 0);

function fmtSec(s) {
  const n = Number(s) || 0;
  if (n >= 3600) { const h = Math.floor(n / 3600); const m = Math.round((n % 3600) / 60); return `${h}h${m}m`; }
  if (n >= 60) { const m = Math.floor(n / 60); const sec = Math.round(n % 60); return sec ? `${m}分${sec}秒` : `${m}分`; }
  return `${Number(n.toFixed(1))}秒`;
}
function fmtSize(n) {
  const v = Number(n) || 0;
  if (!v) return '—';
  if (v >= 1073741824) return `${(v / 1073741824).toFixed(2)} GB`;
  if (v >= 1048576) return `${(v / 1048576).toFixed(1)} MB`;
  if (v >= 1024) return `${(v / 1024).toFixed(0)} KB`;
  return `${v} B`;
}
const fmtTime = (s) => (s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '—');
function fmtMs(ms) {
  const n = Number(ms) || 0;
  if (!n) return '—';
  if (n < 1000) return `${n} ms`;
  if (n < 60000) return `${(n / 1000).toFixed(1)} 秒`;
  const m = Math.floor(n / 60000);
  return `${m} 分 ${Math.round((n % 60000) / 1000)} 秒`;
}
/** episode_films.meta 可能是 JSON 字符串（旧成片也可能没有包装信息） */
function parseMeta(m) {
  if (!m) return {};
  if (typeof m === 'object') return m;
  try { return JSON.parse(m) || {}; } catch { return {}; }
}
const url = (p) => (p ? (ctxRef?.api?.fileUrl ? ctxRef.api.fileUrl(p) : `/${String(p).replace(/^\/+/, '')}`) : '');
const costKey = (c) => (String(c || 'L').trim()[0] || 'L').toUpperCase();
const COST_NAME = { L: 'L 静态+运镜', M: 'M 局部动效', H: 'H 全动态' };
const STATUS_NAME = { planned: '已规划', script: '有剧本', storyboard: '有分镜', rendered: '已出片', done: '完成' };
const SUB_MODE_NAME = { hard: '烧录进画面', soft: '软字幕轨', none: '不做字幕' };
// 响度口径（专业交付）：与后端 src/loudness.js 的 LOUDNESS_TARGETS 一一对应
const LOUDNESS_TARGETS = [
  ['off', '不处理'], ['ebu-r128', 'EBU R128（-23 LUFS）'], ['atsc-a85', 'ATSC A/85（-24 LKFS）'],
  ['streaming', '流媒体（-14 LUFS）'], ['podcast', '播客/有声（-16 LUFS）'],
];
const LOUDNESS_NAME = Object.fromEntries(LOUDNESS_TARGETS);
const AUDIO_NAME = { silent: '静音轨', tts: '配音（TTS）', bgm: '背景乐（BGM）', tts_bgm: '配音+背景乐', mix: '配音+背景乐（已避让）' };
const PIPE_STAGES = [['plan', '分集规划'], ['storyboard', '生成分镜'], ['keyframe', '渲染关键帧'], ['video', '生成视频'], ['assemble', '封装成片']];
const SRT_PREVIEW_LINES = 60;    // 字幕预览最多显示 SRT 前 N 行
const hasErr = (shot) => [...(shot.keyframes || []), ...(shot.videos || [])].some((r) => r.status === 'error');
const errRows = (shot) => [...(shot.keyframes || []), ...(shot.videos || [])].filter((r) => r.status === 'error');
const lastErrText = (shot) => {
  const rows = errRows(shot).slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const r = rows[0];
  if (!r) return '';
  return `${r.kind === 'video' ? '出片' : '出图'}失败：${r.error || '未知错误'}`;
};

function h(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children || [])) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

// ---------------- 样式 ----------------
const CSS = `
.rd-wrap { display:flex; gap:14px; height:100%; min-height:0; color:var(--text); }
.rd-side { width:318px; flex:0 0 318px; display:flex; flex-direction:column; gap:9px; background:var(--panel); border:1px solid var(--line); border-radius:var(--radius); padding:12px; min-height:0; }
.rd-side-h { display:flex; align-items:flex-start; justify-content:space-between; gap:8px; }
.rd-side-t { font-size:15px; font-weight:700; letter-spacing:.5px; }
.rd-side-s { font-size:11px; color:var(--muted); margin-top:2px; }
.rd-side-f { font-size:11px; color:var(--muted); border-top:1px solid var(--line); padding-top:7px; }
.rd-counts { display:grid; grid-template-columns:repeat(4,1fr); gap:6px; }
.rd-count { background:var(--panel-2); border:1px solid var(--line); border-radius:8px; padding:6px 2px; text-align:center; }
.rd-count b { display:block; font-size:14px; }
.rd-count span { font-size:10px; color:var(--muted); }
.rd-count.rd-bad b { color:var(--err); }
.rd-list { flex:1; overflow:auto; display:flex; flex-direction:column; gap:6px; }
.rd-script { border:1px solid var(--line); background:var(--panel-2); border-radius:8px; padding:8px 10px; cursor:pointer; transition:.15s; }
.rd-script:hover { border-color:var(--accent); }
.rd-script.rd-on { border-color:var(--accent); background:linear-gradient(90deg, rgba(109,140,255,.16), transparent); }
.rd-script-h { display:flex; align-items:center; gap:6px; font-size:13px; font-weight:600; }
.rd-script-h b { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.rd-caret { color:var(--muted); font-size:10px; width:9px; flex:0 0 9px; }
.rd-script-m { font-size:11px; color:var(--muted); margin-top:4px; display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
.rd-eps { margin-top:8px; display:flex; flex-direction:column; gap:5px; border-top:1px dashed var(--line); padding-top:7px; }
.rd-ep { border:1px solid var(--line); background:var(--panel); border-radius:7px; padding:6px 8px; cursor:pointer; transition:.15s; }
.rd-ep:hover { border-color:var(--accent-2); }
.rd-ep.rd-on { border-color:var(--accent); background:rgba(109,140,255,.12); }
.rd-ep.rd-dim { opacity:.5; }
.rd-ep-l { font-size:12px; display:flex; gap:6px; align-items:center; }
.rd-ep-l b { color:var(--accent); font-family:var(--mono); font-size:11.5px; }
.rd-ep-m { font-size:10.5px; color:var(--muted); margin-top:3px; display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
.rd-main { flex:1; min-width:0; display:flex; flex-direction:column; gap:12px; overflow:auto; padding-right:2px; }
.rd-card { background:var(--panel); border:1px solid var(--line); border-radius:var(--radius); padding:12px 14px; }
.rd-head { display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap; align-items:flex-start; }
.rd-title { font-size:15px; font-weight:700; display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.rd-sub { font-size:11.5px; color:var(--muted); margin-top:5px; display:flex; gap:10px; flex-wrap:wrap; }
.rd-row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
.rd-grow { flex:1; }
.rd-btn { background:var(--panel-2); border:1px solid var(--line); color:var(--text); border-radius:7px; padding:6px 11px; font-size:12.5px; cursor:pointer; transition:.15s; font-family:inherit; white-space:nowrap; }
.rd-btn:hover { border-color:var(--accent); color:var(--accent); }
.rd-btn:disabled { opacity:.45; cursor:not-allowed; }
.rd-btn.rd-primary { background:var(--accent); border-color:var(--accent); color:#fff; }
.rd-btn.rd-primary:hover { filter:brightness(1.12); color:#fff; }
.rd-btn.rd-sm { padding:3px 8px; font-size:11.5px; }
.rd-btn.rd-danger:hover { border-color:var(--err); color:var(--err); }
.rd-btn.rd-on { border-color:var(--accent); color:var(--accent); background:rgba(109,140,255,.14); }
a.rd-btn { text-decoration:none; display:inline-block; }
.rd-badges { display:flex; gap:6px; flex-wrap:wrap; }
.rd-badge { border:1px solid var(--line); border-radius:999px; padding:4px 10px; font-size:11.5px; background:var(--panel-2); cursor:pointer; display:flex; align-items:center; gap:5px; }
.rd-badge.rd-ready { border-color:var(--ok); color:var(--ok); }
.rd-badge.rd-notready { border-color:var(--warn); color:var(--warn); }
.rd-badge:hover { filter:brightness(1.15); }
.rd-tag { font-size:10.5px; padding:1px 7px; border-radius:999px; border:1px solid var(--line); color:var(--muted); white-space:nowrap; }
.rd-tag.rd-acc { color:var(--accent); border-color:var(--accent); }
.rd-tag.rd-ok { color:var(--ok); border-color:var(--ok); }
.rd-tag.rd-warn { color:var(--warn); border-color:var(--warn); }
.rd-tag.rd-cost-L { color:var(--ok); border-color:var(--ok); }
.rd-tag.rd-cost-M { color:var(--warn); border-color:var(--warn); }
.rd-tag.rd-cost-H { color:var(--err); border-color:var(--err); }
.rd-notice { border:1px solid var(--warn); background:rgba(245,181,68,.07); border-radius:9px; padding:9px 11px; font-size:12px; line-height:1.65; color:var(--text); display:flex; gap:10px; align-items:flex-start; flex-wrap:wrap; }
.rd-notice.rd-info { border-color:var(--line-2); background:rgba(109,140,255,.07); }
.rd-notice b { color:var(--warn); }
.rd-notice.rd-info b { color:var(--accent); }
.rd-notice-body { flex:1; min-width:220px; }
.rd-stats { display:flex; gap:18px; flex-wrap:wrap; align-items:center; }
.rd-stat { font-size:11.5px; color:var(--muted); }
.rd-stat b { display:block; font-size:15px; color:var(--text); font-weight:700; }
.rd-bars { display:flex; gap:16px; flex-wrap:wrap; flex:1; min-width:260px; }
.rd-bar-wrap { flex:1; min-width:150px; }
.rd-bar-h { display:flex; justify-content:space-between; font-size:11px; color:var(--muted); margin-bottom:4px; }
.rd-prog { height:5px; background:var(--panel-3); border-radius:999px; overflow:hidden; }
.rd-prog > i { display:block; height:100%; background:var(--accent); width:0; transition:width .3s; }
.rd-prog.rd-p-kf > i { background:linear-gradient(90deg, var(--accent), var(--accent-2)); }
.rd-prog.rd-p-vid > i { background:linear-gradient(90deg, var(--accent-3), var(--ok)); }
.rd-ep .rd-prog { margin-top:5px; height:4px; }
.rd-chips { display:flex; gap:6px; flex-wrap:wrap; align-items:center; }
.rd-chips .rd-lbl { font-size:11px; color:var(--muted); margin-right:2px; }
.rd-chip { border:1px solid var(--line); background:var(--panel-2); border-radius:999px; padding:3px 11px; font-size:11.5px; cursor:pointer; color:var(--text); transition:.15s; }
.rd-chip:hover { border-color:var(--accent); }
.rd-chip.rd-on { border-color:var(--accent); color:var(--accent); background:rgba(109,140,255,.14); }
.rd-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(252px,1fr)); gap:11px; }
.rd-shot { border:1px solid var(--line); background:var(--panel-2); border-radius:9px; padding:9px 10px; display:flex; flex-direction:column; gap:7px; position:relative; transition:.15s; }
.rd-shot:hover { border-color:var(--line-2); }
.rd-shot.rd-sel { border-color:var(--accent); box-shadow:0 0 0 1px rgba(109,140,255,.35); }
.rd-shot.rd-failed { border-color:var(--err); }
.rd-shot-h { display:flex; align-items:center; gap:5px; flex-wrap:wrap; font-size:11.5px; color:var(--muted); }
.rd-shot-h b { color:var(--text); font-size:12.5px; font-family:var(--mono); }
.rd-ck { accent-color:var(--accent); cursor:pointer; width:14px; height:14px; flex:0 0 14px; }
.rd-st { font-size:10.5px; padding:1px 7px; border-radius:999px; border:1px solid var(--line); white-space:nowrap; }
.rd-st.rd-st-run { color:var(--accent); border-color:var(--accent); animation:rd-pulse 1.2s infinite; }
.rd-st.rd-st-err { color:var(--err); border-color:var(--err); }
.rd-st.rd-st-ok { color:var(--ok); border-color:var(--ok); }
.rd-st.rd-st-warn { color:var(--warn); border-color:var(--warn); }
@keyframes rd-pulse { 0%,100% { opacity:1 } 50% { opacity:.45 } }
.rd-thumb { position:relative; width:100%; aspect-ratio:16/10; background:var(--panel-3); border:1px solid var(--line); border-radius:7px; overflow:hidden; display:flex; align-items:center; justify-content:center; }
.rd-thumb img { width:100%; height:100%; object-fit:contain; display:block; cursor:zoom-in; background:#0b1018; }
.rd-ph { display:flex; flex-direction:column; gap:6px; align-items:center; justify-content:center; color:var(--muted); font-size:11.5px; width:100%; height:100%; text-align:center; padding:6px; }
.rd-ph-v { aspect-ratio:auto; min-height:74px; }
.rd-vwrap video { width:100%; max-height:190px; border-radius:7px; background:#000; display:block; }
.rd-vmeta { display:flex; gap:8px; align-items:center; font-size:10.5px; color:var(--muted); margin-top:4px; flex-wrap:wrap; }
.rd-vempty { border:1px dashed var(--line); border-radius:7px; padding:8px; display:flex; gap:8px; align-items:center; justify-content:space-between; font-size:11.5px; color:var(--muted); }
.rd-prompt { font-size:10.5px; color:var(--muted); line-height:1.45; background:rgba(0,0,0,.22); border:1px solid var(--line); border-radius:6px; padding:5px 7px; cursor:copy; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; word-break:break-word; font-family:var(--mono); }
.rd-prompt:hover { border-color:var(--accent); color:var(--text); }
.rd-cast { display:flex; gap:5px; align-items:center; flex-wrap:wrap; font-size:10.5px; color:var(--muted); }
.rd-av { width:22px; height:22px; border-radius:50%; overflow:hidden; border:1px solid var(--line-2); display:inline-flex; align-items:center; justify-content:center; background:var(--panel-3); font-size:10px; color:var(--muted); }
.rd-av img { width:100%; height:100%; object-fit:cover; display:block; }
.rd-acts { display:flex; gap:5px; flex-wrap:wrap; }
.rd-errbox { font-size:10.5px; color:var(--err); border:1px solid var(--err); background:rgba(255,95,109,.07); border-radius:7px; padding:5px 7px; line-height:1.5; display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.rd-meta { font-size:10px; color:var(--muted-2); display:flex; gap:8px; flex-wrap:wrap; }
.rd-empty { color:var(--muted); font-size:12px; padding:16px; text-align:center; border:1px dashed var(--line); border-radius:9px; }
.rd-empty.rd-sm-empty { padding:8px; font-size:11px; border:none; }
.rd-muted { color:var(--muted); }
.rd-films { display:flex; flex-direction:column; gap:10px; }
.rd-film { border:1px solid var(--line); background:var(--panel-2); border-radius:9px; padding:9px 10px; }
.rd-film-h { display:flex; gap:9px; align-items:center; flex-wrap:wrap; font-size:11.5px; color:var(--muted); margin-bottom:7px; }
.rd-film-h b { color:var(--text); }
.rd-film video { max-width:100%; max-height:400px; width:auto; border-radius:8px; background:#000; display:block; }
.rd-jobs { position:fixed; right:18px; bottom:18px; width:322px; max-height:52vh; overflow:auto; display:flex; flex-direction:column; gap:8px; z-index:60; }
.rd-jobs.rd-hide { display:none; }
.rd-job { background:rgba(18,26,40,.97); border:1px solid var(--line-2); border-radius:10px; padding:9px 11px; box-shadow:var(--shadow); backdrop-filter:blur(6px); }
.rd-job.rd-job-done { border-color:var(--ok); }
.rd-job.rd-job-error { border-color:var(--err); }
.rd-job.rd-job-canceled { border-color:var(--muted); }
.rd-job-h { display:flex; justify-content:space-between; gap:8px; align-items:center; font-size:12px; font-weight:600; margin-bottom:6px; }
.rd-job-t { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.rd-job-m { display:flex; gap:9px; align-items:center; font-size:10.5px; color:var(--muted); margin-top:6px; flex-wrap:wrap; }
.rd-err-t { color:var(--err); }
.rd-steps { display:flex; gap:16px; flex-wrap:wrap; font-size:11.5px; color:var(--muted); }
.rd-steps b { color:var(--text); font-size:12.5px; }
.rd-kv { font-size:12px; line-height:1.8; }
.rd-kv code { font-family:var(--mono); font-size:11px; color:var(--accent-3); word-break:break-all; }
.rd-modal-video { width:100%; max-height:52vh; border-radius:8px; background:#000; }
/* ---- 包装 / 流水线面板 ---- */
.rd-panel { display:flex; flex-direction:column; gap:11px; }
.rd-sec { border:1px solid var(--line); background:var(--panel-2); border-radius:9px; padding:10px 11px; }
.rd-sec-t { font-size:12.5px; font-weight:700; display:flex; align-items:center; gap:7px; flex-wrap:wrap; margin-bottom:8px; }
.rd-sec-t .rd-tag { font-weight:400; }
.rd-frow { display:flex; gap:9px; align-items:center; flex-wrap:wrap; margin-top:7px; }
.rd-frow > label { font-size:11.5px; color:var(--muted); min-width:74px; }
.rd-inp { background:var(--panel); border:1px solid var(--line); color:var(--text); border-radius:7px; padding:5px 8px; font-size:12px; font-family:inherit; }
.rd-inp:focus { outline:none; border-color:var(--accent); }
input.rd-inp[type=number] { width:74px; }
input.rd-inp[type=text] { min-width:180px; }
input.rd-inp[type=range] { padding:0; }
.rd-ck2 { display:inline-flex; align-items:center; gap:5px; font-size:12px; cursor:pointer; color:var(--text); }
.rd-ck2 input { accent-color:var(--accent); width:14px; height:14px; cursor:pointer; }
.rd-hint { font-size:11px; color:var(--muted); line-height:1.6; }
.rd-srt { max-height:210px; overflow:auto; white-space:pre-wrap; word-break:break-word; font-family:var(--mono); font-size:11px; line-height:1.55; background:rgba(0,0,0,.28); border:1px solid var(--line); border-radius:7px; padding:8px; margin-top:8px; }
.rd-panel audio { height:32px; max-width:100%; vertical-align:middle; }
.rd-rep { width:100%; border-collapse:collapse; font-size:11.5px; }
.rd-rep th, .rd-rep td { border:1px solid var(--line); padding:5px 7px; text-align:left; vertical-align:top; }
.rd-rep th { background:var(--panel-3); color:var(--muted); font-weight:600; white-space:nowrap; }
.rd-rep td.rd-num { text-align:right; font-family:var(--mono); white-space:nowrap; }
.rd-rep tr.rd-rep-bad td { background:rgba(255,95,109,.08); }
.rd-rep-wrap { max-height:46vh; overflow:auto; border-radius:8px; }
.rd-films-list { display:flex; flex-direction:column; gap:7px; max-height:44vh; overflow:auto; }
.rd-fitem { border:1px solid var(--line); background:var(--panel-2); border-radius:8px; padding:8px 10px; display:flex; gap:9px; align-items:center; flex-wrap:wrap; font-size:12px; }
.rd-fitem code { font-family:var(--mono); font-size:10.5px; color:var(--accent-3); word-break:break-all; }
`;

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

// ---------------- 入口 ----------------
const SHELL = `
  <div class="rd-wrap">
    <aside class="rd-side" id="rd-side"><div class="rd-empty">加载中…</div></aside>
    <main class="rd-main" id="rd-main"></main>
  </div>
  <div class="rd-jobs rd-hide" id="rd-jobs"></div>`;

export function mount(el, ctx) {
  cleanup();
  root = el;
  ctxRef = ctx;
  injectStyle();
  S = {
    loading: true, scripts: [], counts: {}, backend: { image: {}, video: {} },
    scriptId: null, expanded: null, epCode: null, board: null,
    filter: 'all', costs: new Set(), selected: new Set(), limit: PAGE_SIZE,
    overwrite: false, motionScale: 1, jobs: [], pending: {},
    // 尾帧（首尾帧过渡）：{镜头id: 尾帧图路径}。**已落库**（shots.tail_image，一镜一尾帧）：
    // 从 /api/render/episode 的 tail_image 水合，用户在「⌛ 尾帧」面板改动即刻落库，刷新/换集/下次打开都还原。
    lastImages: {},
    // 派生只读：{镜头id: true} = 该镜已设尾帧但文件当前不存在（后台/关键帧删除后会出现在看板里）
    lastImageMissing: {},
    allFilms: null, showAllFilms: false,
    finish: defaultFinish(), finishDirty: false, detectedFont: '', tts: {}, finishLoaded: false,
    pipe: null, reviewAck: new Set(), reviewMap: {},
  };
  root.innerHTML = SHELL;
  root.addEventListener('click', onClick);
  root.addEventListener('change', onChange);
  loadFinishStatus();
  loadOverview(true).then(attachRunningJobs);
}

function defaultFinish() {
  return {
    subtitles: true, subtitleMode: 'hard', subtitleFont: '', subtitleSize: 22, subtitleMarginV: 40,
    loudness: 'off',
    subtitleIncludeAction: false, audio: 'silent', bgmPath: '', bgmVolume: 0.35,
    fadeIn: 0.4, fadeOut: 0.6,
  };
}

/** 读取后端包装默认值（字幕字体探测 / TTS 状态）；用户手改过的本地值不被覆盖 */
async function loadFinishStatus(force) {
  try {
    const r = await ctxRef.api.get('/api/render/finish-status');
    if (!S) return;
    S.detectedFont = r.detectedFont || '';
    S.tts = r.tts || (r.finish && r.finish.tts) || {};
    const f = { ...(r.finish || {}) };
    delete f.tts;
    if (force || !S.finishDirty) S.finish = { ...defaultFinish(), ...f };
    S.finishLoaded = true;
    if (isPanelOpen(finishPanel)) drawFinishPanel();
    if (S.board) renderMain();
  } catch (e) {
    if (S) S.finishLoaded = false;
  }
}

/** 提交给 assemble / pipeline 的 finish 参数（后端白名单字段） */
function finishPayload() {
  const f = { ...defaultFinish(), ...(S?.finish || {}) };
  return {
    subtitles: !!f.subtitles,
    subtitleMode: ['hard', 'soft', 'none'].includes(f.subtitleMode) ? f.subtitleMode : 'hard',
    subtitleFont: f.subtitleFont || '',
    subtitleSize: num(f.subtitleSize) || 22,
    subtitleMarginV: num(f.subtitleMarginV) || 40,
    loudness: f.loudness || 'off',
    subtitleIncludeAction: !!f.subtitleIncludeAction,
    audio: ['silent', 'tts', 'bgm', 'tts_bgm'].includes(f.audio) ? f.audio : 'silent',
    bgmPath: f.bgmPath || '',
    bgmVolume: num(f.bgmVolume) || 0.35,
    fadeIn: num(f.fadeIn),
    fadeOut: num(f.fadeOut),
  };
}

function finishSummary() {
  const f = finishPayload();
  const sub = f.subtitles && f.subtitleMode !== 'none'
    ? `字幕 ${SUB_MODE_NAME[f.subtitleMode] || f.subtitleMode}（${f.subtitleFont || S?.detectedFont || '自动字体'} ${f.subtitleSize}px）`
    : '字幕 关';
  const aud = ((f.audio === 'bgm' || f.audio === 'tts_bgm') && !f.bgmPath) ? `音轨 ${AUDIO_NAME[f.audio]}（未选 BGM 文件 → ${f.audio === 'tts_bgm' ? '仅配音' : '静音'}）` : `音轨 ${AUDIO_NAME[f.audio] || f.audio}`;
  const ldn = f.loudness && f.loudness !== 'off' ? ` · 响度 ${LOUDNESS_NAME[f.loudness] || f.loudness}` : '';
  return `${sub} · ${aud}${ldn} · 淡入 ${f.fadeIn}s / 淡出 ${f.fadeOut}s`;
}

const isPanelOpen = (p) => !!(p && p.overlay && p.overlay.isConnected);

/** 切走再切回时，重新接管服务端仍在跑的制作任务 */
async function attachRunningJobs() {
  try {
    const r = await ctxRef.api.get('/api/jobs?limit=20');
    if (!S) return;
    for (const job of r.jobs || []) {
      if (!['keyframe', 'video', 'assemble', 'pipeline'].includes(job.type)) continue;
      if (job.status !== 'running' && job.status !== 'queued') continue;
      if (S.jobs.some((x) => x.jobId === job.id)) continue;
      trackJob(job.id, `↻ ${job.title || job.type}`);
    }
  } catch { /* 无法读取任务列表时忽略 */ }
}

export function unmount() {
  cleanup();
  S = null; root = null; ctxRef = null;
}

function cleanup() {
  stops.forEach((f) => { try { f(); } catch { /* ignore */ } });
  stops = [];
  timers.forEach((t) => clearTimeout(t));
  timers = [];
  liveTimer = 0; lastLive = 0;
  closePanel(finishPanel); finishPanel = null;
  closePanel(pipePanel); pipePanel = null;
  if (root) {
    root.removeEventListener('click', onClick);
    root.removeEventListener('change', onChange);
  }
}

function closePanel(p) {
  if (!p) return;
  try { p.close(); } catch { /* ignore */ }
}

// ---------------- 数据 ----------------
const cur = () => ({ scriptId: S?.scriptId || '', code: S?.epCode || '' });
const q = (sel) => (root ? root.querySelector(sel) : null);
const toast = (m, t) => ctxRef?.toast?.(m, t);

const REVIEW_TEXT = { draft: '草稿', review: '待审', approved: '已通过', locked: '已锁定' };
const REVIEW_CLS = { draft: '', review: 'rd-warn', approved: 'rd-ok', locked: 'rd-acc' };
function reviewOf(sid, code) { return (S.reviewMap || {})[`${sid}:${code}`] || null; }

// 审核状态（计划：review 状态可视化到制作台看板）——审核接口不可用时静默降级
async function loadReviews(sid) {
  const target = sid || S?.expanded || S?.scriptId;
  if (!target || !S) return;
  try {
    const r = await ctxRef.api.get(`/api/scripts/${encodeURIComponent(target)}/review`);
    const map = S.reviewMap || (S.reviewMap = {});
    for (const e of (r.episodes || [])) map[`${target}:${e.code}`] = e;
  } catch { /* 忽略：不影响制作台主流程 */ }
}

async function loadOverview(first) {
  try {
    const r = await ctxRef.api.get('/api/render/overview');
    if (!S) return;
    S.scripts = r.scripts || [];
    S.counts = r.counts || {};
    S.backend = r.backend || { image: {}, video: {} };
    if (!S.scriptId || !S.scripts.some((s) => s.id === S.scriptId)) {
      const f = S.scripts[0];
      S.scriptId = f ? f.id : null;
      S.expanded = f ? f.id : null;
    }
    await loadReviews();
    renderSide();
    const keepCode = S.epCode;
    const script = S.scripts.find((s) => s.id === S.scriptId);
    const eps = script?.episodes || [];
    if (!eps.length) { S.board = null; S.epCode = null; renderMain(); renderJobs(); return; }
    if (keepCode && eps.some((e) => e.code === keepCode)) {
      if (S.board) await loadBoard(keepCode, true); else renderMain();
    } else {
      const pick = eps.find((e) => (e.shot_count || 0) > 0) || eps[0];
      await loadBoard(pick.code, true);
    }
    renderJobs();
  } catch (e) {
    renderSide();
    renderMain();
    toast(`制作台数据加载失败：${e.message}`, 'err');
  }
}

async function loadBoard(code, silent) {
  const sid = S?.scriptId;
  if (!sid || !code) return;
  const changed = S.epCode !== code;
  try {
    const r = await ctxRef.api.get(`/api/render/episode?scriptId=${encodeURIComponent(sid)}&code=${encodeURIComponent(code)}`);
    if (!S) return;
    S.board = r;
    S.epCode = code;
    // 尾帧以服务端为准水合（I-101）：换集/刷新都是「换成这一集已存的尾帧」，不再是空对象
    hydrateLastImages(r);
    if (changed) { S.selected = new Set(); S.limit = PAGE_SIZE; S.allFilms = null; S.showAllFilms = false; }
    renderSide();
    renderMain();
  } catch (e) {
    if (!S) return;
    S.board = null; S.epCode = code;
    renderSide();
    renderMain();
    if (!silent) toast(`剧集看板加载失败：${e.message}`, 'err');
  }
}

// ---------------- 左栏 ----------------
/** 后端 counts 统计的是渲染行数（重做会新增行），这里按镜头数收敛，界面更直观 */
function progressCounts(scripts) {
  let kf = 0, vd = 0, shots = 0, films = 0;
  for (const s of scripts || []) {
    const st = s.stats || {};
    const n = num(st.shots);
    shots += n;
    kf += Math.min(num(st.keyframes), n);
    vd += Math.min(num(st.videos), n);
    films += num(st.films);
  }
  return { kf, vd, shots, films, errors: num(S.counts?.errors) };
}

function renderSide() {
  const box = q('#rd-side');
  if (!box || !S) return;
  const pc = progressCounts(S.scripts);
  const scripts = S.scripts || [];
  box.innerHTML = `
    <div class="rd-side-h">
      <div>
        <div class="rd-side-t">🎞 制作台</div>
        <div class="rd-side-s">分镜 → 关键帧 → 视频 → 整集成片</div>
      </div>
      <button class="rd-btn rd-sm" data-act="refresh" title="重新读取剧本/统计">⟳</button>
    </div>
    <div class="rd-counts">
      <div class="rd-count" title="已有可用关键帧的镜头数 / 全部镜头数"><b>${pc.kf}</b><span>关键帧</span></div>
      <div class="rd-count" title="已生成镜头视频的镜头数 / 全部镜头数"><b>${pc.vd}</b><span>视频</span></div>
      <div class="rd-count" title="已合成的整集成片数"><b>${pc.films}</b><span>成片</span></div>
      <div class="rd-count${pc.errors ? ' rd-bad' : ''}" title="渲染失败记录行数（可在卡片上重试或删除）"><b>${pc.errors}</b><span>失败</span></div>
    </div>
    <div class="rd-list">
      ${scripts.length ? scripts.map(scriptItem).join('') : `<div class="rd-empty">还没有剧本项目<br/>请先到「剧本工厂」生成剧本与分镜</div>`}
    </div>
    <div class="rd-side-f">共 ${scripts.length} 个剧本项目 · ${pc.shots} 个镜头 · 模块4 制作台</div>`;
}

function scriptItem(s) {
  const st = s.stats || {};
  const open = S.expanded === s.id;
  const on = S.scriptId === s.id;
  const eps = s.episodes || [];
  const shots = num(st.shots);
  const kf = Math.min(num(st.keyframes), shots);
  const vd = Math.min(num(st.videos), shots);
  return `<div class="rd-script${on ? ' rd-on' : ''}" data-act="script" data-id="${attr(s.id)}">
    <div class="rd-script-h">
      <span class="rd-caret" data-act="toggle-script" data-id="${attr(s.id)}" title="${open ? '收起剧集列表' : '展开剧集列表'}">${open ? '▾' : '▸'}</span>
      <b title="${attr(s.title || s.id)}">${esc(s.title || s.id)}</b>
      <span class="rd-tag rd-acc">${esc(s.id)}</span>
    </div>
    <div class="rd-script-m">
      <span>${esc(s.style_name || s.style_id || '')}</span>
      <span>${num(st.episodes)}集 · ${shots}镜</span>
      <span title="已出关键帧镜头数">🖼 ${kf}</span>
      <span title="已出片镜头数">🎬 ${vd}</span>
      ${st.films ? `<span class="rd-tag rd-ok">成片 ${num(st.films)}</span>` : ''}
    </div>
    ${open ? `<div class="rd-eps">${eps.length ? eps.map((e) => epItem(e, s.id)).join('') : '<div class="rd-empty rd-sm-empty">该剧本还没有剧集分镜（先到模块3 生成分镜）</div>'}</div>` : ''}
    ${open && eps.length ? `<div class="rd-row" style="margin-top:6px"><button class="rd-btn" data-act="go-script" title="去剧本工厂：审核本剧 / 改提示词 / 重新配平">✍ 去剧本工厂审核本剧</button></div>` : ''}
  </div>`;
}

function epItem(e, sid) {
  const shots = num(e.shot_count);
  const kf = Math.min(num(e.keyframe_count), shots);
  const vids = Math.min(num(e.video_count), shots);
  const on = S.scriptId === sid && S.epCode === e.code;
  const pct = shots ? Math.round((kf / shots) * 100) : 0;
  const rev = reviewOf(sid, e.code);
  const revTag = rev
    ? `<span class="rd-tag ${REVIEW_CLS[rev.status] || ''}" title="${attr(rev.reviewNote || '')}">${esc(REVIEW_TEXT[rev.status] || rev.status)}</span>`
    : '';
  const revWarn = rev && !rev.approved
    ? '<span class="rd-tag rd-warn" title="该集还没审核通过；进制作台会先弹中文告警（只告警不阻断）">⚠ 未审核</span>'
    : '';
  return `<div class="rd-ep${on ? ' rd-on' : ''}${shots ? '' : ' rd-dim'}" data-act="ep" data-id="${attr(sid)}" data-code="${attr(e.code)}">
    <div class="rd-ep-l"><b>${esc(e.code)}</b><span>${esc(e.title || '')}</span></div>
    <div class="rd-ep-m">
      <span>${shots}镜</span>
      <span>🖼${kf}/${shots}</span>
      <span>🎬${vids}/${shots}</span>
      ${revTag}${revWarn}
      ${e.film_id ? '<span class="rd-tag rd-ok">成片</span>' : ''}
      ${e.status && e.status !== 'storyboard' ? `<span class="rd-tag">${esc(STATUS_NAME[e.status] || e.status)}</span>` : ''}
    </div>
    <div class="rd-prog rd-p-kf"><i style="width:${pct}%"></i></div>
  </div>`;
}

// ---------------- 主区 ----------------
function renderMain() {
  const box = q('#rd-main');
  if (!box || !S) return;
  if (!S.board) { box.innerHTML = welcome(); return; }
  box.innerHTML = [
    headCard(), toolbarCard(), noticeCard(), statsCard(), filterCard(), gridCard(), filmsCard(),
  ].join('');
}

function welcome() {
  const s = S.scripts.find((x) => x.id === S.scriptId);
  const eps = s?.episodes || [];
  return `<div class="rd-card">
    <div class="rd-title">🎞 制作台 <span class="rd-tag">模块4</span></div>
    <div class="rd-sub" style="margin-bottom:10px">把「剧本工厂」产出的分镜，逐镜变成关键帧 → 镜头视频 → 整集成片。</div>
    ${s ? `<div class="rd-sub">当前剧本：<b>${esc(s.title || s.id)}</b> · ${num(s.stats?.episodes)}集 · ${num(s.stats?.shots)}镜</div>` : ''}
    ${eps.length ? `<div class="rd-empty" style="margin-top:10px">左侧点开剧本，选择一集开始制作。</div>`
      : `<div class="rd-empty" style="margin-top:10px">该剧本还没有分镜数据，请先到「剧本工厂」生成分集分镜。</div>`}
    <div class="rd-kv" style="margin-top:12px">
      <div class="rd-steps">
        <div><b>1</b> 选一集（左侧列表）</div>
        <div><b>2</b> 🖼 渲染关键帧（本地占位出图 / 云端出图后端）</div>
        <div><b>3</b> 🎬 生成镜头视频（本地运镜 / 云端视频 API）</div>
        <div><b>4</b> 🎞 合成整集成片（mp4）</div>
      </div>
    </div>
  </div>`;
}

function headCard() {
  const b = S.board;
  const sc = b.script || {}, ep = b.episode || {}, st = b.stats || {};
  return `<div class="rd-card">
    <div class="rd-head">
      <div>
        <div class="rd-title">${esc(ep.code || '')} · ${esc(ep.title || '未命名')}
          <span class="rd-tag rd-acc">${esc(sc.id || '')}</span>
          <span class="rd-tag">${esc(sc.style_name || sc.style_id || '')}</span>
          <span class="rd-tag">${esc(sc.ratio || '')}</span>
          <span class="rd-tag">目标 ${fmtSec(st.targetDuration)}</span>
        </div>
        <div class="rd-sub">
          <span>剧本：${esc(sc.title || '')}</span>
          <span>格式：${esc(sc.format || '')}</span>
          <span>镜头 ${num(st.shots)}</span>
          <span>分镜时长 ${fmtSec(st.shotDuration)}</span>
        </div>
      </div>
      <div class="rd-row">
        <button class="rd-btn" data-act="go-script" title="回到剧本工厂：审核本集 / 改提示词 / 重新配平时长">✍ 去剧本工厂</button>
        <button class="rd-btn" data-act="go-actors" title="去画布：精修角色/环境资产、跑九宫格与一致性体检">🎭 去画布精修</button>
        ${badge('image', '🖼 出图')}
        ${badge('video', '🎬 视频')}
      </div>
    </div>
  </div>`;
}

function badge(kind, label) {
  const be = (S.board?.backend?.[kind]) || S.backend?.[kind] || {};
  const ready = !!be.ready;
  const name = be.backend || '未配置';
  const tip = be.note ? `${name}：${be.note}` : name;
  return `<span class="rd-badge ${ready ? 'rd-ready' : 'rd-notready'}" data-act="backend-info" data-kind="${kind}" title="${attr(tip)}">
    ${label}：${esc(name)} ${ready ? '✓' : '未就绪'}
  </span>`;
}

function toolbarCard() {
  const st = S.board?.stats || {};
  const c = cur();
  const f = finishPayload();
  return `<div class="rd-card">
    <div class="rd-row">
      <button class="rd-btn rd-primary" data-act="kf-all" title="为整集（或选中镜头）渲染关键帧">🖼 渲染本集关键帧</button>
      <button class="rd-btn rd-primary" data-act="vid-all" title="为整集（或选中镜头）生成镜头视频">🎬 生成本集视频</button>
      <button class="rd-btn" data-act="assemble" title="按当前包装设置（字幕/音轨/淡入淡出）把本集镜头视频拼成整集 mp4">🎞 合成整集成片（按包装）</button>
      <button class="rd-btn${f.subtitles || f.audio !== 'silent' || f.fadeIn || f.fadeOut ? ' rd-on' : ''}" data-act="finish-panel" title="字幕 / 音轨 / 淡入淡出设置与预览">🎁 成片包装</button>
      <button class="rd-btn" data-act="pipeline-panel" title="整季批量：规划 → 分镜 → 关键帧 → 视频 → 成片">🚀 整季流水线</button>
      <button class="rd-btn" data-act="schedules" title="定时排产：到点自动推进制片（新建项目或推进已有项目）；可列出 / 新建 / 启停，并可零成本试算下次触发时刻">⏰ 排产</button>
      <button class="rd-btn${S.overwrite ? ' rd-on' : ''}" data-act="toggle-overwrite" title="开启后，已存在的关键帧/视频会被重新生成（默认跳过已存在的）">⟳ 重做（覆盖）${S.overwrite ? '：开' : '：关'}</button>
      <span class="rd-grow"></span>
      <button class="rd-btn" data-act="export-csv" title="导出本集分镜表 CSV（新标签页下载）">⬇ 导出本集 CSV</button>
      <button class="rd-btn" data-act="export-json" title="导出本集分镜表 JSON">⬇ 导出本集 JSON</button>
      <button class="rd-btn" data-act="cleanup" title="清理封装中间产物（临时 mp4 与 concat 清单），最终成片保留">🧹 清理中间产物</button>
      <button class="rd-btn" data-act="publish" title="出海物料：发布元数据（标题/简介/话题/钩子）+ 封面帧 + 多语言字幕">🌐 出海物料</button>
      <button class="rd-btn" data-act="qc" title="成片质检：黑帧 / 静音 / 响度 / 流缺失 / 时长口径（ffmpeg 实测）">🔍 成片质检</button>
      <button class="rd-btn" data-act="variants" title="多平台版本：一次成片 → 抖音/视频号竖屏、小红书 3:4、B站/YouTube 横屏、方屏 1:1；先算清裁切损失与字幕安全区，再本地 ffmpeg 出片（零成本）">📱 多平台版本</button>
      <button class="rd-btn" data-act="export-timeline" title="导出时间线（专业后期）：EDL(CMX3600) / FCP7 XML(xmeml) / OTIO(OpenTimelineIO) —— 与成片拼接顺序同源同一份数据，Premiere / DaVinci / FCP / 流程工具都能导入">⤓ 时间线 XML/OTIO</button>
      <button class="rd-btn" data-act="import-timeline" title="导入时间线（专业后期回灌）：把 Premiere / DaVinci / FCP 导出的 FCP7 XML 或 OTIO JSON 读回来，先看「接入计划」（dry-run，不写库），确认后再接到画布上的成片时间线节点。零付费：只解析文本 + 写画布连线">⤓ 导入时间线</button>
      <button class="rd-btn" data-act="export-subs" title="导出字幕：SRT / WebVTT / TTML，并给出排版规范检查（单行字数/行数/语速 CPS/停留时长/重叠/安全区）">⤓ 字幕 VTT/TTML</button>
      <button class="rd-btn" data-act="backend-fit" title="工作流能力匹配：把实例真正具备的能力（分辨率/比例/单条时长/首尾帧/LoRA/配音）与这一集的需求对一遍，提前给出降级建议与替代方案（只判断，不发请求、不花钱）">🧩 能力匹配</button>
      <button class="rd-btn" data-act="consistency" title=""跨镜角色一致性：按角色给关键帧做整体观感离群检测，列出「画风飘了」的镜头与该重跑哪几镜（代理指标，不做人脸识别）">🧬 跨镜一致性</button>
      <button class="rd-btn" data-act="stats" title="生产看板：任务耗时与失败率、渲染成功率、失败原因 Top、产出趋势与剩余时间估算">📊 生产看板</button>
      <button class="rd-btn" data-act="deliver" title="把成片 + 字幕 + 分镜表 + 素材 + 生产报告 + EDL 时间线打成一个 zip 交付">📦 导出交付包</button>
      <button class="rd-btn" data-act="retry-failed" title="只重跑失败的镜头：限流/5xx/网络会自动重试，鉴权/额度/审核类会列出让你先处理">♻ 重试失败镜头${S.board?.stats?.errors ? `（${S.board.stats.errors}）` : ''}</button>
      <button class="rd-btn" data-act="guard-status" title="本月用量/预估金额/预算上限/磁盘占用">💰 预算与磁盘</button>
      <button class="rd-btn" data-act="probe" title="探测当前视频后端是否在线">🔍 探测视频后端</button>
      <button class="rd-btn" data-act="refresh" title="重新读取本集看板">⟳ 刷新</button>
    </div>
    <div class="rd-sub" style="margin-top:8px">
      <span>共 ${num(st.shots)} 镜 · 关键帧 ${num(st.keyframes)} · 视频 ${num(st.videos)}</span>
      <span>${c.scriptId} / ${c.code}</span>
      <span title="点击「🎁 成片包装」可修改">🎁 当前包装：${esc(finishSummary())}</span>
    </div>
  </div>`;
}

function noticeCard() {
  const vb = S.board?.backend?.video || S.backend?.video || {};
  const ib = S.board?.backend?.image || S.backend?.image || {};
  const out = [];
  if (!vb.ready) {
    out.push(`<div class="rd-notice">
      <div class="rd-notice-body">
        <b>⚠️ 视频后端「${esc(vb.backend || '未配置')}」未就绪。</b>
        ${vb.note ? `<div style="color:var(--muted);margin-top:3px">${esc(vb.note)}</div>` : ''}
        <div style="margin-top:4px">出片会失败；请到「设置 → 视频后端」填写 ComfyUI（MiniMax H3 图生视频）或任意视频 API 的地址与工作流后再试。</div>
      </div>
      <button class="rd-btn rd-sm" data-act="probe">🔍 探测</button>
      <button class="rd-btn rd-sm" data-act="go-settings">⚙️ 去设置</button>
    </div>`);
  } else if (vb.backend === 'placeholder') {
    out.push(`<div class="rd-notice">
      <div class="rd-notice-body">
        <b>ℹ️ 当前用本地 ffmpeg 运镜占位成片</b>（把该镜的<b>关键帧</b>做推/拉/摇/移/跟拍等镜头运动生成 mp4）。
        <div style="margin-top:3px;color:var(--muted)">所以<b style="color:var(--warn)">必须先有该镜的关键帧</b>才能出片；若还没出图，点「生成本集视频」会提示自动先渲染关键帧。
          配置 ComfyUI / 任意视频 API 后，同样的按钮即产出真实 AI 视频（图生视频）。</div>
      </div>
      <button class="rd-btn rd-sm" data-act="probe">🔍 探测</button>
      <button class="rd-btn rd-sm" data-act="test-video" title="用当前关键帧试渲染一个 3 秒短片，不落库">🧪 单镜试渲染</button>
      <button class="rd-btn rd-sm" data-act="go-settings">⚙️ 配置视频后端</button>
    </div>`);
  }
  if (!ib.ready) {
    out.push(`<div class="rd-notice">
      <div class="rd-notice-body"><b>⚠️ 出图后端「${esc(ib.backend || '未配置')}」未就绪。</b>${ib.note ? `<div style="color:var(--muted);margin-top:3px">${esc(ib.note)}</div>` : ''}</div>
      <button class="rd-btn rd-sm" data-act="go-settings">⚙️ 去设置</button>
    </div>`);
  }
  return out.join('');
}

function statsCard() {
  const st = S.board?.stats || {};
  const shots = num(st.shots) || 1;
  const kfPct = Math.round((num(st.keyframes) / shots) * 100);
  const vPct = Math.round((num(st.videos) / shots) * 100);
  const cl = st.costLevels || {};
  return `<div class="rd-card">
    <div class="rd-stats">
      <div class="rd-stat"><b>${num(st.shots)}</b>镜头数</div>
      <div class="rd-stat"><b>${fmtSec(st.targetDuration)}</b>目标时长</div>
      <div class="rd-stat"><b>${fmtSec(st.videoDuration)}</b>已生成视频时长</div>
      <div class="rd-stat"><b>${num(st.keyframes)}/${num(st.shots)}</b>关键帧</div>
      <div class="rd-stat"><b>${num(st.videos)}/${num(st.shots)}</b>视频</div>
      <div class="rd-bars">
        <div class="rd-bar-wrap">
          <div class="rd-bar-h"><span>关键帧进度</span><span>${kfPct}%</span></div>
          <div class="rd-prog rd-p-kf"><i style="width:${kfPct}%"></i></div>
        </div>
        <div class="rd-bar-wrap">
          <div class="rd-bar-h"><span>视频进度</span><span>${vPct}%</span></div>
          <div class="rd-prog rd-p-vid"><i style="width:${vPct}%"></i></div>
        </div>
      </div>
      <div class="rd-stat" title="成本级：L 静态+运镜 / M 局部动效 / H 全动态">成本级
        <b><span style="color:var(--ok)">L ${num(cl.L)}</span> · <span style="color:var(--warn)">M ${num(cl.M)}</span> · <span style="color:var(--err)">H ${num(cl.H)}</span></b>
      </div>
    </div>
  </div>`;
}

function filterCard() {
  const all = S.board?.shots || [];
  const cl = S.board?.stats?.costLevels || {};
  const shown = filteredShots();
  const fchips = [['all', '全部'], ['nokf', '缺关键帧'], ['novid', '缺视频'], ['err', '失败']];
  const hasSel = S.selected.size > 0;
  return `<div class="rd-card">
    <div class="rd-chips" style="margin-bottom:8px">
      <span class="rd-lbl">状态</span>
      ${fchips.map(([k, t]) => `<span class="rd-chip${S.filter === k ? ' rd-on' : ''}" data-act="filter" data-f="${k}">${t}${k === 'all' ? `（${all.length}）` : `（${filterCount(k)}）`}</span>`).join('')}
      <span class="rd-lbl" style="margin-left:8px">成本级</span>
      ${['L', 'M', 'H'].map((c) => `<span class="rd-chip${S.costs.has(c) ? ' rd-on' : ''}" data-act="cost" data-c="${c}" title="${COST_NAME[c]}">${c}（${num(cl[c])}）</span>`).join('')}
      <span class="rd-lbl" style="margin-left:8px">运镜倍率</span>
      ${[1, 1.5, 2].map((m) => `<span class="rd-chip${S.motionScale === m ? ' rd-on' : ''}" data-act="scale" data-m="${m}" title="视频时长 = 分镜时长 × 倍率（单镜上限 12 秒）">${m}×</span>`).join('')}
    </div>
    <div class="rd-chips">
      <button class="rd-btn rd-sm" data-act="sel-all">全选</button>
      <button class="rd-btn rd-sm" data-act="sel-inv">反选</button>
      <button class="rd-btn rd-sm" data-act="sel-none">清空</button>
      <span class="rd-muted" style="font-size:11.5px">已选 <b id="rd-selcount">${S.selected.size}</b> 镜${hasSel ? '' : '（未选中时批量操作处理筛选出的全部镜头）'}</span>
      <span class="rd-grow"></span>
      <button class="rd-btn rd-sm" data-act="kf-sel">🖼 渲染选中关键帧</button>
      <button class="rd-btn rd-sm" data-act="vid-sel">🎬 生成选中视频</button>
      <button class="rd-btn rd-sm${lastImageCount() ? ' rd-primary' : ''}" data-act="last-panel" title="为选中镜头/整集设置「尾帧」：出片时把首帧+尾帧一起交给视频后端做首尾帧过渡（批量链路也支持，不必走画布 DAG）。未设置尾帧 = 只做首帧驱动。选择会立即写入项目库（一镜一张），刷新/换集/下次打开都会还原${lastImageMissingCount() ? `；注意有 ${lastImageMissingCount()} 镜的尾帧文件已不存在` : ''}">⌛ 设置尾帧${lastImageCount() ? `（${lastImageCount()}${lastImageMissingCount() ? ` · ⚠${lastImageMissingCount()}` : ''}）` : ''}</button>
    </div>
    <div class="rd-sub" style="margin-top:8px"><span>当前显示 ${shown.length} 张卡片 / 共 ${all.length} 镜</span></div>
  </div>`;
}

function filterCount(k) {
  const shots = S.board?.shots || [];
  if (k === 'nokf') return shots.filter((s) => !s.keyframe).length;
  if (k === 'novid') return shots.filter((s) => !s.video).length;
  if (k === 'err') return shots.filter(hasErr).length;
  return shots.length;
}

// ---------------- 尾帧（首尾帧过渡）----------------
// 批量链路也能做首尾帧过渡：为镜头选一张尾帧图，出片时把「首帧（该镜关键帧）+ 尾帧」一起交给视频后端。
// 未设置尾帧 = 只做首帧驱动（与历史行为完全一致）。
// **选择已落库**（I-101）：每镜一张尾帧，写在 shots.tail_image 上，面板里改一次就 PUT 一次；
// 刷新页面 / 切换剧集 / 下次打开这一集都会从看板数据（/api/render/episode 的 tail_image）还原。

/** 从看板数据水合尾帧设置（服务端为准）：{镜头id: 尾帧图路径} + 「文件已不存在」标记 */
function hydrateLastImages(board) {
  if (!S || !board || !Array.isArray(board.shots)) return;
  const files = {};
  const missing = {};
  for (const s of board?.shots || []) {
    const rel = s?.tail_image ? String(s.tail_image) : '';
    if (!rel) continue;
    files[s.id] = rel;
    if (s.tail_image_missing === true) missing[s.id] = true;
  }
  S.lastImages = files;
  S.lastImageMissing = missing;
}

/** 本集已设尾帧的镜头数 */
function lastImageCount() {
  const shots = S?.board?.shots || [];
  return shots.filter((s) => S?.lastImages?.[s.id]).length;
}

/** 本集「已设尾帧、但尾帧文件当前已不存在」的镜头数（界面如实标出，绝不静默清掉用户的设置） */
function lastImageMissingCount() {
  return Object.keys(S?.lastImageMissing || {}).filter((id) => S?.lastImages?.[id]).length;
}

/**
 * 落库某镜的尾帧（file = null → 清除）：先乐观更新界面，再 PUT /api/render/shots/:id/tail-image。
 * 失败 → **回滚 UI 到改动前** + 中文错误（绝不出现「显示成功但实际没存」）。
 * 成功 → 以服务端返回为准（服务端会校验文件存在/不越界/是图片，不合格根本不会写库）。
 * @returns {Promise<boolean>} 是否真的写进了库
 */
async function applyTailImage(shotId, file) {
  if (!S) return false;
  const prev = S.lastImages[shotId] || null;
  const prevMissing = Boolean(S.lastImageMissing[shotId]);
  const rollback = () => {
    if (!S) return;
    if (prev) { S.lastImages[shotId] = prev; if (prevMissing) S.lastImageMissing[shotId] = true; else delete S.lastImageMissing[shotId]; }
    else { delete S.lastImages[shotId]; delete S.lastImageMissing[shotId]; }
    renderMain();
  };
  if (file) { S.lastImages[shotId] = file; delete S.lastImageMissing[shotId]; }
  else { delete S.lastImages[shotId]; delete S.lastImageMissing[shotId]; }
  renderMain();
  try {
    const r = await ctxRef.api.put(`/api/render/shots/${encodeURIComponent(shotId)}/tail-image`, { file: file || null });
    if (!S) return true;
    if (r.tail_image) {
      S.lastImages[shotId] = String(r.tail_image);
      if (r.exists === false) S.lastImageMissing[shotId] = true; else delete S.lastImageMissing[shotId];
    } else { delete S.lastImages[shotId]; delete S.lastImageMissing[shotId]; }
    renderMain();
    toast(r.cleared ? '已清除尾帧（该镜恢复为只做首帧驱动）' : `已保存尾帧：下次打开这一集仍在（${r.tail_image}）`, 'ok');
    return true;
  } catch (e) {
    rollback();
    toast(`尾帧没能保存（界面已回滚，库里未改动）：${e.message}`, 'err');
    return false;
  }
}

/**
 * 可作为尾帧的候选图：本集其他镜头的关键帧版本。
 * 刻意排除该镜自己的关键帧 —— 首尾帧同一张图 = 全片不动（画布 DAG 的首尾帧自检也是这个结论）。
 */
function lastFrameCandidates(shot) {
  const out = [];
  for (const s of (S.board?.shots || [])) {
    if (s.id === shot.id) continue;
    for (const r of (s.keyframes || [])) {
      if (r.status !== 'done' || !r.file_path) continue;
      out.push({ file: r.file_path, label: `#${num(s.idx)} 镜关键帧 · ${String(r.created_at || '').slice(5, 16).replace('T', ' ')} · ${r.backend || ''}`.trim() });
    }
  }
  return out;
}

/** 「⌛ 尾帧」面板：为选中的镜头（或整集）逐镜选尾帧图；可顺手试渲染一镜（不落库） */
function openLastFramePanel(ids = []) {
  const list = targetShots(ids);
  if (!list.length) { toast('没有可设置尾帧的镜头', 'err'); return; }
  const wrap = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } });
  const m = ctxRef.modal({
    title: `⌛ 尾帧（首尾帧过渡）· ${list.length} 镜`, body: wrap, width: 780,
    footer: [h('button', { class: 'rd-btn rd-primary', onclick: () => m.close() }, ['完成'])],
  });

  const draw = () => {
    wrap.innerHTML = '';
    wrap.append(h('div', { class: 'rd-muted', style: { fontSize: '12px', lineHeight: '1.6' } }, [
      h('div', { text: '未设置尾帧 = 只做首帧驱动（与原来完全一致）；设置后出片会把「该镜关键帧（首帧）+ 你选的尾帧」一起交给视频后端做过渡。' }),
      h('div', { text: '可选的尾帧图来自本集其他镜头的关键帧（同镜自己的关键帧当尾帧 = 画面不动，已排除）。' }),
      h('div', { text: '★ 这里的每一次选择/清空都会**立即写入项目库**（一镜一张尾帧）：刷新页面、切换剧集、下次打开这一集都会自动还原；此处显示的就是库里存的值。' }),
      h('div', { text: '若某镜的尾帧文件后来被删掉/重渲染换了名，界面会如实标出「文件已不存在」：此时提交出片会被后端**中文拒绝**并指出是哪个文件（绝不静默丢掉尾帧，也不会偷偷清掉你的设置）——重选一张或点「清空」即可恢复。' }),
    ]));
    for (const shot of list) {
      const cands = lastFrameCandidates(shot);
      const cur = S.lastImages[shot.id] || '';
      const missing = Boolean(cur && S.lastImageMissing[shot.id]);
      const opts = [...cands];
      if (cur && !opts.some((c) => c.file === cur)) opts.unshift({ file: cur, label: `已选尾帧：${cur}${missing ? '（文件已不存在）' : ''}` });
      const sel = h('select', { class: 'rd-input', style: { minWidth: '260px', maxWidth: '380px' } }, [
        h('option', { value: '', text: '未设置尾帧（只做首帧驱动）' }),
        ...opts.map((c) => h('option', { value: c.file, text: c.label })),
      ]);
      sel.value = cur;
      sel.addEventListener('change', async () => {
        // 改动即刻落库：失败由 applyTailImage 回滚 + 中文错误，这里按落库后的真实状态重画
        sel.disabled = true;
        await applyTailImage(shot.id, sel.value || null);
        draw();
      });
      const row = h('div', { class: 'rd-card', style: { padding: '8px 10px' } }, [
        h('div', { class: 'rd-row', style: { gap: '8px', alignItems: 'center' } }, [
          h('b', { text: `#${num(shot.idx)}` }),
          shot.shot_size ? h('span', { class: 'rd-tag', text: shot.shot_size }) : null,
          shot.move ? h('span', { class: 'rd-tag', text: shot.move }) : null,
          sel,
          cur ? h('button', { class: 'rd-btn rd-sm', onclick: async () => { await applyTailImage(shot.id, null); draw(); } }, ['清空'])
            : null,
        ]),
        h('div', { class: 'rd-muted', style: { fontSize: '11.5px', marginTop: '4px' } }, [
          cur ? (missing
            ? `尾帧：${cur}（文件已不存在：提交出片会被中文拒绝并指出是哪个文件；可重选一张或点「清空」）`
            : `尾帧：${cur}（已存入项目库）`)
            : (cands.length ? '当前：无尾帧（只做首帧驱动）' : '本集还没有别的镜头关键帧可当尾帧：请先渲染其他镜的关键帧，或到画布用「⌛ 自动补尾帧」'),
        ]),
        cur ? h('div', { class: 'rd-row', style: { marginTop: '6px' } }, [
          h('button', {
            class: 'rd-btn rd-sm',
            title: '用当前后端把「该镜关键帧 + 这张尾帧」试渲染一个短片（不落库、不写记录）',
            onclick: async () => {
              const { scriptId, code } = currentEp();
              if (!scriptId || !code) return;
              const vb = S.board?.backend?.video || {};
              toast('正在试渲染首尾帧（约数秒）…', 'info');
              const r = await ctxRef.api.post('/api/render/test-video', {
                backend: vb.backend, duration: 3, move: shot.move || '推镜',
                ratio: S.board?.script?.ratio || '16:9',
                keyframe: shot.keyframe?.file_path || null, lastImage: cur,
                prompt: shot.prompt_pos || '',
              });
              if (r.raw?.lastFrame || r.lastFrom === 'last') {
                toast(`试渲染成功：${r.backend || ''} · 尾帧处理 ${r.raw?.lastFrame || r.lastFrom}${r.note ? ` · ${r.note}` : ''}`, 'ok');
                previewMedia(r.fileUrl || url(r.filePath), 'video', '首尾帧过渡试渲染（未落库）');
              } else {
                toast(`试渲染失败：${r.error || '后端没有返回尾帧处理方式'}`, 'err');
              }
            },
          }, ['🧪 试渲染首尾帧（不落库）']),
        ]) : null,
      ]);
      wrap.append(row);
    }
    wrap.append(h('div', { class: 'rd-muted', style: { fontSize: '11.5px' } }, [
      '提示：这里的每次设置/清空都会立即写入项目库（一镜一张尾帧），不需要额外点「保存」；云端后端需要在「设置 → 视频后端」的请求体模板里带尾帧字段（如 {{lastImage}}），否则会明确报错而不会静默丢尾帧。',
    ]));
  };
  const currentEp = () => cur();   // 循环内的局部变量 cur 是尾帧路径字符串，这里另起名字避免遮蔽
  draw();
}

function gridCard() {
  const all = filteredShots();
  const shown = all.slice(0, S.limit);
  if (!all.length) return `<div class="rd-card"><div class="rd-empty">当前筛选条件下没有镜头。</div></div>`;
  const more = all.length - shown.length;
  return `<div class="rd-card">
    <div class="rd-grid">${shown.map(shotCard).join('')}</div>
    ${more > 0 ? `<div style="text-align:center;margin-top:12px">
      <button class="rd-btn" data-act="more">加载更多（还有 ${more} 张，每次 ${PAGE_SIZE} 张）</button></div>` : ''}
  </div>`;
}

function shotCard(shot) {
  const kf = shot.keyframe;
  const vid = shot.video;
  const pend = S.pending[shot.id];
  const bad = hasErr(shot);
  const cost = costKey(shot.cost_level);
  const sel = S.selected.has(shot.id);
  const casts = shot.cast || [];
  const cls = ['rd-shot'];
  if (sel) cls.push('rd-sel');
  if (bad) cls.push('rd-failed');
  return `<div class="${cls.join(' ')}" data-shot="${attr(shot.id)}">
    <div class="rd-shot-h">
      <input type="checkbox" class="rd-ck" data-shot="${attr(shot.id)}" ${sel ? 'checked' : ''} title="勾选后批量操作只处理选中的镜头"/>
      <b>#${num(shot.idx)}</b>
      ${shot.shot_size ? `<span class="rd-tag">${esc(shot.shot_size)}</span>` : ''}
      ${shot.move ? `<span class="rd-tag">${esc(shot.move)}</span>` : ''}
      <span class="rd-tag">${fmtSec(shot.duration)}</span>
      <span class="rd-tag rd-cost-${cost}" title="${attr(COST_NAME[cost] || '')}">${cost}</span>
      <span class="rd-grow"></span>
      ${pend ? '<span class="rd-st rd-st-run">生成中…</span>'
        : bad ? '<span class="rd-st rd-st-err">失败</span>'
          : (vid ? '<span class="rd-st rd-st-ok">已出片</span>' : (kf ? '<span class="rd-st rd-st-warn">待出片</span>' : ''))}
    </div>
    <div class="rd-thumb">
      ${kf ? `<img src="${attr(url(kf.file_path))}" alt="关键帧" loading="lazy" data-act="preview" data-kind="image" data-shot="${attr(shot.id)}" data-src="${attr(url(kf.file_path))}" title="点击放大查看关键帧"/>`
        : `<div class="rd-ph"><span>🖼 未出关键帧</span>
            <button class="rd-btn rd-sm" data-act="kf-one" data-shot="${attr(shot.id)}">渲染</button>
            ${S.board?.backend?.video?.backend === 'placeholder' ? '<span style="font-size:10px">本地运镜出片需要先有图</span>' : ''}
          </div>`}
    </div>
    ${vid ? `<div class="rd-vwrap">
        <video controls muted preload="metadata" src="${attr(url(vid.file_path))}"></video>
        <div class="rd-vmeta">
          <span title="分镜时长 → 实际视频时长">🕒 ${fmtSec(shot.duration)} → ${fmtSec(vid.duration)}</span>
          <span title="该镜运镜方式">🎥 ${esc(vid.motion || shot.move || '固定')}</span>
          <span>${esc(vid.backend || '')}</span>
          <span>${esc(vid.model || '')}</span>
          <span class="rd-grow"></span>
          <a class="rd-btn rd-sm" href="${attr(url(vid.file_path))}" download title="下载该镜视频">⬇ 下载</a>
        </div>
      </div>`
      : `<div class="rd-vempty">
          <span>🎬 未出片${kf ? '' : '（缺关键帧）'}</span>
          <button class="rd-btn rd-sm" data-act="vid-one" data-shot="${attr(shot.id)}">出片</button>
        </div>`}
    <div class="rd-prompt" data-act="copy-prompt" data-shot="${attr(shot.id)}" title="点击复制完整英文提示词">${esc(shot.prompt_pos || shot.action || '')}</div>
    <div class="rd-cast">${castHtml(casts)}</div>
    <div class="rd-acts">
      <button class="rd-btn rd-sm" data-act="kf-one" data-shot="${attr(shot.id)}" title="重新渲染该镜关键帧（覆盖）">🖼 出图</button>
      <button class="rd-btn rd-sm" data-act="vid-one" data-shot="${attr(shot.id)}" title="生成该镜视频（覆盖）">🎬 出片</button>
      <button class="rd-btn rd-sm${S.lastImages[shot.id] ? ' rd-primary' : ''}" data-act="last-one" data-shot="${attr(shot.id)}" title="${attr(S.lastImages[shot.id]
        ? `已设尾帧：${S.lastImages[shot.id]}${S.lastImageMissing[shot.id] ? '（文件已不存在：提交出片会被中文拒绝并指出这个文件）' : '（出片时做首尾帧过渡；已存入项目库，刷新/下次打开仍在）'}`
        : '未设置尾帧 = 只做首帧驱动；点此为该镜选一张尾帧图做首尾帧过渡（选择会立即存入项目库）')}">⌛ 尾帧${S.lastImages[shot.id] ? (S.lastImageMissing[shot.id] ? ' ⚠' : ' ★') : ''}</button>
      <button class="rd-btn rd-sm" data-act="copy-prompt" data-shot="${attr(shot.id)}" title="复制英文正向提示词">📄 复制提示词</button>
      <button class="rd-btn rd-sm${(shot.keyframes || []).length > 1 || (shot.videos || []).length > 1 ? ' rd-primary' : ''}" data-act="versions" data-shot="${attr(shot.id)}" title="对比该镜的多个关键帧/视频版本，并指定「采用版本」（整集拼接会用它）">🎞 版本 ${(shot.keyframes || []).length}/${(shot.videos || []).length}${(shot.keyframe?.picked || shot.video?.picked) ? ' ★' : ''}</button>
      <button class="rd-btn rd-sm rd-danger" data-act="del-renders" data-shot="${attr(shot.id)}" title="删除该镜的渲染记录与文件">🗑 删除渲染</button>
    </div>
    <div class="rd-meta">
      ${shot.scene_no ? `<span>${esc(shot.scene_no)}</span>` : ''}
      ${shot.time_of_day ? `<span>${esc(shot.time_of_day)}</span>` : ''}
      ${shot.camera ? `<span>${esc(shot.camera)}</span>` : ''}
      ${shot.transition ? `<span>${esc(shot.transition)}</span>` : ''}
      ${kf ? `<span>🖼 ${esc(kf.backend || '')} ${esc((kf.created_at || '').slice(5, 16).replace('T', ' '))}</span>` : ''}
    </div>
    ${bad ? `<div class="rd-errbox">
      <span>⚠️ ${esc(lastErrText(shot))}</span>
      <span class="rd-grow"></span>
      <button class="rd-btn rd-sm" data-act="retry" data-shot="${attr(shot.id)}">重试</button>
      <button class="rd-btn rd-sm rd-danger" data-act="del-renders" data-shot="${attr(shot.id)}">清除失败记录</button>
    </div>` : ''}
  </div>`;
}

function castHtml(casts) {
  if (!casts.length) return '<span>无指定角色</span>';
  const avs = casts.map((c) => (c.cover
    ? `<span class="rd-av" title="${attr(c.name)}"><img src="${attr(url(c.cover))}" alt="${attr(c.name)}" loading="lazy"/></span>`
    : `<span class="rd-av" title="${attr(c.name)}">${esc(String(c.name || '?').slice(0, 1))}</span>`)).join('');
  return `${avs}<span>${esc(casts.map((c) => c.name).join(' / '))}</span>`;
}

function filmsCard() {
  const showAll = S.showAllFilms && S.allFilms;
  const films = showAll ? S.allFilms : (S.board?.films || []);
  const title = showAll ? '本剧本全部成片' : `整集成片（${S.epCode || ''}）`;
  return `<div class="rd-card">
    <div class="rd-head">
      <div class="rd-title">🎞 ${esc(title)} <span class="rd-tag">${films.length}</span></div>
      <div class="rd-row">
        <button class="rd-btn rd-sm" data-act="films-toggle">${S.showAllFilms ? '只看本集' : '查看本剧本全部成片'}</button>
        <button class="rd-btn rd-sm" data-act="finish-panel" title="字幕 / 音轨 / 淡入淡出">🎁 成片包装</button>
        <button class="rd-btn rd-sm rd-primary" data-act="assemble" title="按当前包装设置合成">🎞 合成整集成片</button>
      </div>
    </div>
    <div class="rd-films" style="margin-top:10px">
      ${films.length ? films.map(filmItem).join('') : `<div class="rd-empty">还没有整集成片。先「生成本集视频」，再点「合成整集成片」（按镜头顺序拼接已生成的视频）。</div>`}
    </div>
  </div>`;
}

function filmItem(f) {
  const ok = f.status === 'done' && f.file_path;
  const meta = parseMeta(f.meta);
  const sub = meta.subtitles || {};
  const aud = meta.audio || {};
  const missing = num(meta.missingShots);
  return `<div class="rd-film">
    <div class="rd-film-h">
      <b>${esc(f.id)}</b>
      <span>${esc(f.code || '')}</span>
      <span class="rd-tag ${ok ? 'rd-ok' : 'rd-warn'}">${ok ? '已完成' : esc(f.status || '')}</span>
      ${f.duration ? `<span>时长 ${fmtSec(f.duration)}</span>` : ''}
      ${f.shot_count ? `<span>${num(f.shot_count)} 镜</span>` : ''}
      ${f.size ? `<span>${fmtSize(f.size)}</span>` : ''}
      ${f.backend ? `<span>${esc(f.backend)}</span>` : ''}
      ${ok ? `<span class="rd-tag" title="字幕轨信息来自 episode_films.meta">💬 ${sub.applied ? `字幕 ${num(sub.cues)} 条 · ${esc(SUB_MODE_NAME[sub.mode] || sub.mode || '')}` : `无字幕${sub.reason ? '（' + esc(sub.reason) + '）' : ''}`}</span>` : ''}
      ${ok ? `<span class="rd-tag" title="音轨模式来自 episode_films.meta">🔊 ${esc(AUDIO_NAME[aud.mode] || aud.mode || '未知')}${aud.mode === 'tts' && aud.clips ? ` · ${num(aud.clips)} 段` : ''}</span>` : ''}
      ${ok && missing ? `<span class="rd-tag rd-warn" title="合成时缺少的镜头视频数">缺 ${missing} 镜</span>` : ''}
      ${meta.pipeline ? '<span class="rd-tag rd-acc">流水线</span>' : ''}
      <span>${fmtTime(f.created_at)}</span>
      <span class="rd-grow"></span>
      ${ok ? `<a class="rd-btn rd-sm" href="${attr(url(f.file_path))}" target="_blank" title="在新标签页播放">▶</a>` : ''}
      ${ok ? `<a class="rd-btn rd-sm" href="${attr(url(f.file_path))}" download>⬇ 下载</a>` : ''}
      <button class="rd-btn rd-sm rd-danger" data-act="del-film" data-film="${attr(f.id)}" title="删除这部成片（记录 + 文件）">🗑</button>
    </div>
    ${ok ? `<video controls preload="metadata" src="${attr(url(f.file_path))}"></video>`
      : `<div class="rd-errbox">⚠️ 合成失败：${esc(f.error || '未知错误')}</div>`}
  </div>`;
}

// ---------------- 任务浮层 ----------------
function renderJobs() {
  const box = q('#rd-jobs');
  if (!box || !S) return;
  const jobs = S.jobs || [];
  box.classList.toggle('rd-hide', !jobs.length);
  if (!jobs.length) { box.innerHTML = ''; return; }
  box.innerHTML = jobs.map((rec) => {
    const job = rec.job || {};
    const st = job.status || 'queued';
    const pct = Math.max(0, Math.min(100, Number(job.progress) || 0));
    const label = { queued: '排队中', running: '进行中', done: '已完成', error: '失败', canceled: '已取消' }[st] || st;
    const stCls = st === 'done' ? 'rd-st-ok' : st === 'error' ? 'rd-st-err' : st === 'canceled' ? '' : 'rd-st-run';
    return `<div class="rd-job rd-job-${st}">
      <div class="rd-job-h">
        <span class="rd-job-t" title="${attr(rec.title)}">${esc(rec.title)}</span>
        <span class="rd-st ${stCls}">${label}</span>
      </div>
      <div class="rd-prog"><i style="width:${pct}%"></i></div>
      <div class="rd-job-m">
        <span>进度 ${num(job.done)}/${num(job.total)}</span>
        <span>${Math.round(pct)}%</span>
        ${job.error ? `<span class="rd-err-t" title="${attr(job.error)}">${esc(String(job.error).slice(0, 60))}</span>` : ''}
        <span class="rd-grow"></span>
        ${(st === 'queued' || st === 'running') ? `<button class="rd-btn rd-sm" data-act="cancel-job" data-job="${attr(rec.jobId)}">取消</button>` : ''}
        ${(st === 'done' || st === 'error' || st === 'canceled') ? `<button class="rd-btn rd-sm" data-act="close-job" data-job="${attr(rec.jobId)}">关闭</button>` : ''}
      </div>
    </div>`;
  }).join('');
}

function trackJob(jobId, title, { reload = true, onUpdate, onFinish } = {}) {
  const rec = { jobId, title, job: { status: 'queued', progress: 0, done: 0, total: 0 } };
  S.jobs.push(rec);
  renderJobs();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (job) => {
      if (settled) return;
      settled = true;
      if (!S) { resolve(job); return; }
      if (job) rec.job = job;
      renderJobs();
      const st = rec.job?.status;
      if (st === 'done') {
        toast(`${title} 完成`, 'ok');
        const rr = rec.job.result || {};
        if (rr.failed) toast(`其中 ${rr.failed} 镜失败，可在卡片上查看原因并重试`, 'err');
        if (rr.skipped) toast(`${rr.skipped} 镜已存在渲染，已跳过（勾「⟳ 重做（覆盖）」可强制重渲）`, 'info');
        if (rr.missingShots) toast(`合成时缺少 ${rr.missingShots} 镜视频（这些镜头还没出片）`, 'info');
      } else if (st === 'error') {
        toast(`${title} 失败：${rec.job?.error || '未知错误'}`, 'err');
      } else {
        toast(`${title} 已取消`, 'info');
      }
      resolve(rec.job);
      try { onFinish?.(rec.job); } catch { /* ignore */ }
      afterJobDone();
      scheduleClose(rec, 4000);
    };
    const stop = ctxRef.watchJob(jobId, (job) => {
      if (!S || !job) return;
      rec.job = job;
      renderJobs();
      try { onUpdate?.(job); } catch { /* ignore */ }
      if (job.status === 'done' || job.status === 'error' || job.status === 'canceled') finish(job);
      else if (reload) liveRefresh(job);
    }, { onDone: finish });
    rec.stop = stop;
    stops.push(stop);
  });
}

function scheduleClose(rec, ms) {
  const t = setTimeout(() => {
    if (!S) return;
    S.jobs = S.jobs.filter((x) => x !== rec);
    renderJobs();
  }, ms);
  timers.push(t);
}

function afterJobDone() {
  const t = setTimeout(async () => {
    if (!S) return;
    S.pending = {};
    await loadOverview();
    renderMain();
    renderJobs();
  }, 500);
  timers.push(t);
}

function liveRefresh(job) {
  if (!S || job.status !== 'running') return;
  if (Date.now() - lastLive < 5000) return;
  const vids = root ? [...root.querySelectorAll('video')] : [];
  if (vids.some((v) => !v.paused)) return;      // 有视频在播时不做整块重绘
  lastLive = Date.now();
  clearTimeout(liveTimer);
  liveTimer = setTimeout(async () => {
    if (!S || !S.epCode) return;
    await loadBoard(S.epCode, true);
  }, 800);
  timers.push(liveTimer);
}

// ---------------- 业务动作 ----------------
function filteredShots() {
  const shots = S.board?.shots || [];
  return shots.filter((s) => {
    if (S.costs.size && !S.costs.has(costKey(s.cost_level))) return false;
    if (S.filter === 'nokf') return !s.keyframe;
    if (S.filter === 'novid') return !s.video;
    if (S.filter === 'err') return hasErr(s);
    return true;
  });
}

function targetShots(ids) {
  const shots = S.board?.shots || [];
  if (ids && ids.length) return shots.filter((s) => ids.includes(s.id));
  if (S.selected.size) return shots.filter((s) => S.selected.has(s.id));
  return filteredShots();
}

// 审核前置：未审核通过的集只中文告警，允许人工确认后继续（不硬阻断）。
async function reviewPreflight(scriptId, code) {
  if (!scriptId || !code) return true;
  const ack = `review-ack:${scriptId}:${code}`;
  if (S?.reviewAck?.has(ack)) return true;
  try {
    // 闸门一：剧本审核（未通过默认禁止开拍）
    const g = await ctxRef.api.get(`/api/gates/episode?script_id=${encodeURIComponent(scriptId)}&code=${encodeURIComponent(code)}`);
    // 契约：镜头数 / 时长 / 台词
    let c = null;
    try {
      c = await ctxRef.api.get(`/api/gates/contract?script_id=${encodeURIComponent(scriptId)}&code=${encodeURIComponent(code)}`);
    } catch { /* 契约接口不可用时不阻断 */ }

    const problems = [];
    if (g && g.blocked) problems.push(`⛔ 剧本未通过审核（当前：${g.episode?.status || 'draft'}）`);
    if (c && c.contractOk === false) problems.push(`⚠️ 镜头契约不达标：${(c.issues || []).map((i) => i.message).join('；')}`);
    if (!problems.length) return true;

    const yes = await ctxRef.confirm(`${problems.join('\n')}\n\n按 V2 闸门规则，默认应先修复再开拍。\n\n点「确定」= 强制继续（会写入审计，责任自负）；点「取消」= 回去处理。`);
    if (!yes) return false;
    try {
      await ctxRef.api.post('/api/gates/override', {
        scriptId, code,
        gate: g?.blocked ? 'script-lock' : 'shot-contract',
        reason: problems.join('；'),
        operator: '制作台用户',
      });
    } catch { /* 审计失败不阻断制作 */ }
    if (S?.reviewAck) S.reviewAck.add(ack);
    return true;
  } catch { return true; }
}

async function runKeyframes(ids, { single = false } = {}) {
  const { scriptId, code } = cur();
  if (!scriptId || !code) return null;
  const list = targetShots(ids);
  if (!list.length) { toast('没有可渲染的镜头', 'err'); return null; }
  if (!(await reviewPreflight(scriptId, code))) { toast('已取消（该集未审核通过）', 'info'); return null; }
  const ib = S.board?.backend?.image || {};
  if (!ib.ready) {
    const yes = await ctxRef.confirm(`出图后端「${ib.backend || '未配置'}」未就绪：${ib.note || '请到设置页配置出图后端'}\n\n仍要尝试渲染吗？`);
    if (!yes) return null;
  }
  try {
    const payload = {
      scriptId, code, shotIds: list.map((s) => s.id),
      overwrite: single ? true : !!S.overwrite,
    };
    let r = await ctxRef.api.post('/api/render/keyframes', payload);
    if (r.needConfirm) {
      const yes = await ctxRef.confirm(`${r.reason}\n\n确认继续渲染这 ${list.length} 个镜头？`);
      if (!yes) { toast('已取消（预算确认）', 'info'); return null; }
      r = await ctxRef.api.post('/api/render/keyframes', { ...payload, confirm: true });
    }
    toast(`已提交关键帧任务：${list.length} 镜${single ? '（覆盖重渲）' : (S.overwrite ? '（覆盖重渲）' : '')}`, 'ok');
    list.forEach((s) => { S.pending[s.id] = 'kf'; });
    renderMain();
    return await trackJob(r.jobId, `🖼 关键帧 · ${code} · ${list.length} 镜`);
  } catch (e) {
    toast(`关键帧任务提交失败：${e.message}`, 'err');
    return null;
  }
}

async function runVideos(ids, { single = false, chained = false } = {}) {
  const { scriptId, code } = cur();
  if (!scriptId || !code) return null;
  const list = targetShots(ids);
  if (!list.length) { toast('没有可出片的镜头', 'err'); return null; }
  if (!(await reviewPreflight(scriptId, code))) { toast('已取消（该集未审核通过）', 'info'); return null; }
  const vb = S.board?.backend?.video || S.backend?.video || {};
  const noKf = list.filter((s) => !s.keyframe);
  if (noKf.length && !chained) {
    const localMotion = vb.backend === 'placeholder' || !vb.ready;
    const all = noKf.length === list.length;
    let msg;
    if (localMotion && all) {
      msg = `当前视频后端是本地运镜（${vb.backend || 'placeholder'}），它需要先有该镜的「关键帧」才能出片，而这些镜头（${list.length} 镜）都还没有关键帧。\n\n是否先自动渲染这 ${noKf.length} 个关键帧，完成后再生成视频？\n（取消则不执行）`;
    } else if (localMotion) {
      msg = `当前视频后端是本地运镜（${vb.backend || 'placeholder'}），没有关键帧的镜头无法出片。\n\n所选 ${list.length} 镜中有 ${noKf.length} 镜还没有关键帧。\n是否先自动渲染这些关键帧，完成后再生成视频？\n（取消则只对已有关键帧的 ${list.length - noKf.length} 镜出片）`;
    } else {
      msg = `所选 ${list.length} 镜中有 ${noKf.length} 镜还没有关键帧，部分云端图生视频工作流需要首帧图。\n\n是否先自动渲染这些关键帧再出片？\n（取消则直接出片，失败原因会显示在对应卡片上）`;
    }
    const yes = await ctxRef.confirm(msg);
    if (yes) {
      const kfJob = await runKeyframes(noKf.map((s) => s.id));
      if (kfJob && kfJob.status === 'done') {
        await loadOverview();
        await loadBoard(code, true);
      }
    } else if (localMotion && all) {
      return null;                                  // 本地运镜：没有关键帧就无法出片，取消即中止
    }
  }
  // 尾帧文件已不存在的镜头：后端在**提交时**就会中文拒绝整批（这是既有口径，防「以为做了首尾帧过渡」），
  // 所以先如实说明再问一次 —— 不静默把这些镜头的尾帧丢掉。
  const missTails = list.filter((s) => S.lastImages[s.id] && S.lastImageMissing[s.id]);
  if (missTails.length && !chained) {
    const yes = await ctxRef.confirm(`有 ${missTails.length} 镜的尾帧文件已不存在（例如 #${num(missTails[0].idx)}：${S.lastImages[missTails[0].id]}）。\n\n提交出片会被后端中文拒绝并指出是哪个文件（不会静默丢掉尾帧）。\n建议先到「⌛ 尾帧」重选或清空这几镜。\n\n确定 = 仍然提交（失败原因会如实显示）；取消 = 先回去处理`);
    if (!yes) return null;
  }
  try {
    const body = { scriptId, code, shotIds: list.map((s) => s.id), overwrite: single ? true : !!S.overwrite };
    if (S.costs.size) body.onlyCostLevels = [...S.costs];
    if (S.motionScale !== 1) body.motionScale = S.motionScale;
    // 尾帧（首尾帧过渡）：只带本批镜头已设的尾帧。单镜 → lastImage；多镜 → lastImageByShot{镜头id: 路径}
    // 一镜都没设 → 两个字段都不传，请求与历史逐字段一致（只做首帧驱动）
    const lastSel = {};
    for (const s of list) if (S.lastImages[s.id]) lastSel[s.id] = S.lastImages[s.id];
    const lastCount = Object.keys(lastSel).length;
    if (lastCount) {
      body.lastImageByShot = lastSel;                                  // 批量：按镜头指定尾帧
      if (list.length === 1) body.lastImage = lastSel[list[0].id];     // 单镜：同时给 lastImage（单镜语义）
    }
    let r = await ctxRef.api.post('/api/render/videos', body);
    if (r.needConfirm) {
      const okGo = await ctxRef.confirm(`${r.reason}\n\n确认继续生成这 ${list.length} 个镜头视频？`);
      if (!okGo) { toast('已取消（预算确认）', 'info'); return null; }
      r = await ctxRef.api.post('/api/render/videos', { ...body, confirm: true });
    }
    const nLast = num(r.withLastImage);
    toast(`已提交视频任务：${list.length} 镜${S.motionScale !== 1 ? `（时长 ×${S.motionScale}）` : ''}${nLast ? ` · ${nLast} 镜带尾帧（首尾帧过渡）` : ''}`, 'ok');
    list.forEach((s) => { S.pending[s.id] = 'vid'; });
    renderMain();
    return await trackJob(r.jobId, `🎬 视频 · ${code} · ${list.length} 镜`);
  } catch (e) {
    toast(`视频任务提交失败：${e.message}`, 'err');
    return null;
  }
}

async function runAssemble(chained = false) {
  const { scriptId, code } = cur();
  if (!scriptId || !code) return;
  const st = S.board?.stats || {};
  if (!num(st.shots)) { toast(`该集还没有分镜，请先到「剧本工厂」生成 ${code} 的分镜`, 'err'); return; }
  if (!num(st.videos)) {
    if (chained) { toast('该集仍没有已生成的镜头视频，无法合成', 'err'); return; }
    const yes = await ctxRef.confirm(`该集还没有已生成的镜头视频，无法合成整集成片。\n\n是否先生成本集 ${num(st.shots)} 镜视频（本地运镜每镜需数秒），完成后再自动合成？`);
    if (!yes) return;
    const v = await runVideos([], { chained: true });
    if (!v || v.status !== 'done') return;
    await loadOverview();
    await loadBoard(code, true);
    await runAssemble(true);
    return;
  }
  try {
    const finish = finishPayload();
    const r = await ctxRef.api.post('/api/render/assemble', { scriptId, code, finish });
    toast(`已提交整集合成任务：${r.shots ?? num(st.videos)} 镜 → mp4（${finishSummary()}）`, 'ok');
    await trackJob(r.jobId, `🎞 整集合成 · ${code}`);
  } catch (e) {
    toast(`合成任务提交失败：${e.message}`, 'err');
  }
}

/** 镜头版本对比：同一镜可以生成多次，这里人工挑选「采用版本」（整集拼接与看板都用它） */
async function openVersions(shot) {
  const { scriptId, code } = cur();
  const wrap = h('div', { class: 'col', style: { gap: '10px' } });
  const m = ctxRef.modal({ title: `🎞 镜 #${shot.idx} · 版本对比`, width: 860, body: wrap });

  const render = async () => {
    wrap.innerHTML = '';
    let kfVersions = [], vidVersions = [];
    try {
      kfVersions = (await ctxRef.api.get(`/api/render/shots/${encodeURIComponent(shot.id)}/versions?kind=keyframe`)).versions || [];
      vidVersions = (await ctxRef.api.get(`/api/render/shots/${encodeURIComponent(shot.id)}/versions?kind=video`)).versions || [];
    } catch (e) { wrap.append(h('div', { class: 'rd-errbox' }, [`读取版本失败：${e.message}`])); return; }

    const section = (title, kind, list) => {
      const box = h('div', {});
      box.append(h('div', { class: 'rd-muted', style: { margin: '6px 0' } }, [`${title}（${list.length} 个版本${list.some((x) => x.picked) ? '，当前已采用 ★' : ''}）`]));
      if (!list.length) { box.append(h('div', { class: 'rd-muted' }, ['暂无版本'])); return box; }
      const grid = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '8px' } });
      for (const v of list) {
        const cell = h('div', { class: 'rd-vercell', style: { border: v.picked ? '2px solid var(--ok, #3fb950)' : '1px solid var(--line, #30363d)', borderRadius: '8px', padding: '6px', display: 'flex', flexDirection: 'column', gap: '4px' } });
        if (v.status === 'done' && kind === 'keyframe') {
          cell.append(h('img', { src: url(v.file_path), loading: 'lazy', style: { width: '100%', height: '110px', objectFit: 'cover', borderRadius: '4px', cursor: 'zoom-in' }, onclick: () => previewMedia(v.file_path, 'image', `镜 #${shot.idx} 关键帧 v${v.version}`) }));
        } else if (v.status === 'done' && kind === 'video') {
          cell.append(h('video', { src: url(v.file_path), controls: 'true', muted: 'true', preload: 'metadata', style: { width: '100%', height: '110px', borderRadius: '4px', background: '#000' } }));
        } else {
          cell.append(h('div', { class: 'rd-errbox', style: { fontSize: '11px', maxHeight: '110px', overflow: 'auto' } }, [String(v.error || '生成失败').slice(0, 160)]));
        }
        cell.append(h('div', { class: 'rd-muted', style: { fontSize: '11px' } }, [`v${v.version}${v.isLatest ? '（最新）' : ''}${v.picked ? ' ★ 已采用' : ''} · ${v.backend || ''} ${v.seed != null ? `seed ${v.seed}` : ''}`]));
        cell.append(h('div', { class: 'rd-muted', style: { fontSize: '11px' } }, [`${String(v.created_at || '').slice(5, 16).replace('T', ' ')} · ${v.status === 'done' ? `${Math.round((v.duration || 0) * 10) / 10}s` : '失败'}`]));
        const acts = h('div', { class: 'row', style: { gap: '4px', marginTop: '2px' } });
        if (v.status === 'done' && !v.picked) {
          acts.append(h('button', {
            class: 'rd-btn rd-sm rd-primary', onclick: async () => {
              try { await ctxRef.api.post(`/api/render/renders/${encodeURIComponent(v.id)}/pick`, {}); toast(`已采用 v${v.version}（整集拼接会用这一版）`, 'ok'); await render(); await loadBoard(code, true); }
              catch (e) { toast(`采用失败：${e.message}`, 'err'); }
            },
          }, ['★ 设为采用']));
        }
        if (v.picked) {
          acts.append(h('button', {
            class: 'rd-btn rd-sm', onclick: async () => {
              try { await ctxRef.api.post(`/api/render/shots/${encodeURIComponent(shot.id)}/unpick`, { kind }); toast('已取消采用（回到最近一次成功）', 'ok'); await render(); await loadBoard(code, true); }
              catch (e) { toast(`取消失败：${e.message}`, 'err'); }
            },
          }, ['取消采用']));
        }
        acts.append(h('button', {
          class: 'rd-btn rd-sm rd-danger', onclick: async () => {
            if (!(await ctxRef.confirm(`删除 v${v.version} 的渲染记录与文件？`))) return;
            try { await ctxRef.api.del(`/api/render/renders/${encodeURIComponent(v.id)}`); toast('已删除该版本', 'ok'); await render(); await loadBoard(code, true); }
            catch (e) { toast(`删除失败：${e.message}`, 'err'); }
          },
        }, ['删除']));
        cell.append(acts);
        grid.append(cell);
      }
      box.append(grid);
      return box;
    };

    wrap.append(h('div', { class: 'rd-muted' }, ['同一镜多次生成时会累积版本：点「★ 设为采用」后，整集成片与看板都会用该版本；未指定则用最近一次成功。']));
    wrap.append(section('关键帧版本', 'keyframe', kfVersions));
    wrap.append(section('视频版本', 'video', vidVersions));
    wrap.append(h('div', { class: 'row' }, [
      h('button', { class: 'rd-btn rd-sm', onclick: () => { m.close(); runKeyframes([shot.id], { single: true }); } }, ['🖼 再生成一版关键帧']),
      h('button', { class: 'rd-btn rd-sm', onclick: () => { m.close(); runVideos([shot.id], { single: true }); } }, ['🎬 再生成一版视频']),
    ]));
  };
  await render();
}

async function deleteRenders(shot) {
  const kfRows = shot.keyframes || [];
  const vRows = shot.videos || [];
  const rows = [...kfRows, ...vRows];
  if (!rows.length) { toast(`镜 #${shot.idx} 没有渲染记录`, 'info'); return; }
  const yes = await ctxRef.confirm(`将删除镜 #${shot.idx} 的渲染记录（关键帧 ${kfRows.length} 条 / 视频 ${vRows.length} 条）及对应文件，不可恢复。\n\n确定删除？`);
  if (!yes) return;
  let ok = 0, fail = 0;
  for (const r of rows) {
    try { await ctxRef.api.del(`/api/render/renders/${encodeURIComponent(r.id)}`); ok++; }
    catch { fail++; }
  }
  toast(`已删除 ${ok} 条渲染记录${fail ? `，${fail} 条失败` : ''}`, fail ? 'err' : 'ok');
  await loadOverview();
  if (S.epCode) await loadBoard(S.epCode, true);
}

/** 失败镜头一键重试：按错误归类只重跑可重试的，不可重试的列出原因 */
async function retryFailedShots() {
  const { scriptId, code } = cur();
  if (!scriptId || !code) return;
  try {
    const r = await ctxRef.api.post('/api/render/retry-failed', { scriptId, code });
    if (!r.ok) { toast(`重试失败：${r.error}`, 'err'); return; }
    const lines = [];
    lines.push(r.retryable ? `♻ 已重新提交 ${r.retryable} 个可重试镜头（限流/5xx/网络/超时类）` : '没有可自动重试的失败镜头');
    if (r.blocked?.length) {
      lines.push('');
      lines.push(`⚠ 有 ${r.blocked.length} 个镜头不会因为重试而成功，请先处理：`);
      for (const b of r.blocked.slice(0, 8)) {
        lines.push(`· 镜 ${b.shotId}（${b.kind === 'keyframe' ? '关键帧' : '视频'}）[${b.errorLabel}] ${String(b.error).slice(0, 90)}`);
      }
      if (r.blocked.length > 8) lines.push(`… 其余 ${r.blocked.length - 8} 个同类问题`);
    }
    for (const [key, jobId] of Object.entries(r.jobIds || {})) {
      const [kind, epCode] = key.split(':');
      trackJob(jobId, `${kind === 'keyframe' ? '🖼 重试关键帧' : '🎬 重试视频'} · ${epCode}`);
    }
    ctxRef.modal({ title: '♻ 失败镜头重试', width: 620, body: h('div', { class: 'rd-kv' }, [h('pre', { class: 'rd-code', text: lines.join('\n') })]) });
    await loadBoard(code, true);
  } catch (e) { toast(`重试失败：${e.message}`, 'err'); }
}

/** 出海物料：选语言 → 生成元数据/封面/多语言字幕，并给出下载入口 */
async function openPublishKit() {
  const { scriptId, code } = cur();
  if (!scriptId || !code) return;
  let langs = [];
  try { langs = (await ctxRef.api.get('/api/render/publish/options')).languages || []; } catch { langs = []; }
  const picked = new Set((S.publishLangs || ['en']).filter((x) => langs.some((l) => l.id === x)));
  const out = h('pre', { class: 'rd-code', style: { maxHeight: '50vh', overflow: 'auto' }, text: '选择目标语言后点「生成物料」（翻译走 LLM，可用设置里的 mock 离线试跑）' });
  const chips = h('div', { class: 'row wrap' }, langs.map((l) => h('span', {
    class: `rd-chip${picked.has(l.id) ? ' rd-on' : ''}`,
    onclick: (ev) => {
      if (picked.has(l.id)) picked.delete(l.id); else picked.add(l.id);
      ev.currentTarget.classList.toggle('rd-on');
    },
  }, [`${l.name}（${l.id}）`])));
  const m = ctxRef.modal({
    title: `🌐 出海物料 · ${code}`,
    width: 820,
    body: h('div', {}, [
      h('div', { class: 'rd-muted' }, ['目标语言（可多选；不选则只出中文物料）']),
      chips,
      h('div', { class: 'row', style: { margin: '8px 0' } }, [
        h('button', {
          class: 'rd-btn rd-primary',
          onclick: async () => {
            S.publishLangs = [...picked];
            out.textContent = '生成中（翻译 + 封面截帧）…';
            try {
              const r = await ctxRef.api.post('/api/render/publish', { scriptId, code, languages: [...picked], metadata: true });
              if (!r.ok) { out.textContent = `✗ ${r.error}`; return; }
              const lines = [];
              lines.push(`元数据来源：${r.metadata.source === 'llm' ? '模型生成' : '规则兜底'}`);
              lines.push('标题备选：');
              for (const t of r.metadata.titles || []) lines.push(`  · ${t}`);
              lines.push(`简介：${String(r.metadata.description || '').slice(0, 120)}`);
              lines.push(`话题：${(r.metadata.tags || []).map((t) => `#${t}`).join(' ')}`);
              lines.push(`钩子：${r.metadata.hook || '—'}`);
              lines.push(`字幕：${(r.subtitles || []).map((x) => `${x.langName}(${x.cues} 条${x.cached ? '·缓存' : ''})`).join('、') || '仅中文'}`);
              if (r.cover) lines.push(`封面：${r.cover.width}x${r.cover.height}${r.cover.atSeconds != null ? `（取自 ${r.cover.atSeconds}s）` : ''}`);
              for (const f of r.files || []) lines.push(`文件：${f.kind} → ${f.url}`);
              if (r.warnings?.length) lines.push('', `⚠ ${r.warnings.length} 条告警：${r.warnings.slice(0, 3).join('；')}`);
              out.textContent = lines.join('\n');
              if (r.cover) {
                const box = h('div', { style: { marginTop: '8px' } }, [h('img', { src: r.cover.url, style: { maxHeight: '220px', borderRadius: '6px' } })]);
                m.body.append(box);
              }
              toast('出海物料已生成（也在「📦 导出交付包」里）', 'ok');
            } catch (e) { out.textContent = `✗ ${e.message}`; }
          },
        }, ['生成物料']),
        h('div', { class: 'rd-muted' }, ['生成结果会落盘到 data/publish/，并随交付包一起交付']),
      ]),
      out,
    ]),
  });
}

/** 成片质检：ffmpeg 实测黑帧/静音/响度/流缺失/时长，给出可读结论与 md 下载 */
async function runEpisodeQc() {
  const { scriptId, code } = cur();
  if (!scriptId || !code) return;
  toast('质检中（黑帧/静音/响度检测，约数秒）…', 'info', 2500);
  try {
    const r = await ctxRef.api.get(`/api/render/qc?scriptId=${encodeURIComponent(scriptId)}&code=${encodeURIComponent(code)}`);
    if (!r.ok) { toast(`质检失败：${r.error}`, 'err'); return; }
    const rep = r.report;
    const rows = [];
    for (const it of rep.items) {
      rows.push(`【${it.name || it.label}】${it.info ? `${it.info.duration?.toFixed(2)}s${it.info.video ? ` · ${it.info.video.width}x${it.info.video.height} ${it.info.video.codec}` : ''}${it.info.audio ? ` · ${it.info.audio.codec}` : ' · 无音轨'}` : ''}`);
      for (const c of it.checks) {
        const icon = c.level === 'error' ? '❌' : c.level === 'warn' ? '⚠️' : c.level === 'info' ? 'ℹ️' : '✅';
        rows.push(`  ${icon} ${c.message}${c.detail ? `（${c.detail}）` : ''}`);
      }
      rows.push('');
    }
    ctxRef.modal({
      title: `🔍 成片质检 · ${code}（${rep.verdict === 'pass' ? '通过' : rep.verdict === 'warn' ? '有告警' : '有错误'}）`,
      width: 860,
      body: h('div', { class: 'rd-kv' }, [
        h('pre', { class: 'rd-code', style: { maxHeight: '60vh', overflow: 'auto' }, text: rows.join('\n') }),
        h('div', { class: 'row', style: { marginTop: '10px' } }, [
          h('button', {
            class: 'rd-btn',
            onclick: () => window.open(`/api/render/qc?scriptId=${encodeURIComponent(scriptId)}&code=${encodeURIComponent(code)}&format=md`, '_blank'),
          }, ['⬇ 下载质检报告（Markdown）']),
          h('div', { class: 'rd-muted' }, ['报告也会随「📦 导出交付包」一起交付']),
        ]),
      ]),
    });
    toast(`质检完成：错误 ${rep.summary.error} · 告警 ${rep.summary.warn} · 通过 ${rep.summary.ok}`, rep.summary.error ? 'err' : rep.summary.warn ? 'warn' : 'ok');
  } catch (e) { toast(`质检失败：${e.message}`, 'err'); }
}

/** 多平台版本：先规划（裁切损失/安全区/响度口径），再按需本地生成 */
async function showVariants() {
  const { scriptId, code } = cur();
  if (!scriptId || !code) { toast('先选一部剧本与一集', 'warn'); return; }
  const fitName = { crop: '铺满裁切', 'blur-pad': '模糊补边', 'black-pad': '黑边补' };
  let fit = S.variantFit || 'crop';
  const rowsBox = h('div', {});
  const draw = async () => {
    rowsBox.innerHTML = '';
    rowsBox.appendChild(h('pre', { class: 'rd-code', style: { maxHeight: '46vh', overflow: 'auto' }, text: '规划中…' }));
    try {
      const r = await ctxRef.api.get(`/api/render/variants?scriptId=${encodeURIComponent(scriptId)}&code=${encodeURIComponent(code)}&fit=${encodeURIComponent(fit)}`);
      if (!r.ok) { rowsBox.innerHTML = ''; rowsBox.appendChild(h('div', { class: 'rd-error' }, [`规划失败：${r.error}`])); return; }
      const lines = [`源画面：${r.source.width}x${r.source.height}（${r.source.aspect}）｜成片时长 ${Math.round(r.duration || 0)}s`, `补边方式：${fitName[fit]}`, ''];
      for (const pl of r.plans) {
        if (!pl.ok) { lines.push(`✗ ${pl.error}`); continue; }
        const safe = pl.safeArea.ok === null ? '未指定字幕边距' : pl.safeArea.ok ? `安全区 OK（≥${pl.safeArea.safeBottomPx}px）` : `⚠️ 安全区不足（${pl.safeArea.subtitleMarginPx}px < ${pl.safeArea.safeBottomPx}px）`;
        lines.push(`${pl.preset.name.padEnd(14, ' ')} ${String(pl.target.width)}x${pl.target.height}（${pl.target.aspect}）｜${pl.note}｜响度 ${pl.loudness.name}｜${safe}`);
        for (const w of pl.warnings) lines.push(`    ⚠️ ${w}`);
      }
      rowsBox.innerHTML = '';
      rowsBox.appendChild(h('pre', { class: 'rd-code', style: { maxHeight: '46vh', overflow: 'auto' }, text: lines.join('\n') }));
    } catch (e) { rowsBox.innerHTML = ''; rowsBox.appendChild(h('div', { class: 'rd-error' }, [`规划失败：${e.message}`])); }
  };
  const fitChips = h('div', { class: 'row', style: { gap: '6px', marginBottom: '8px', flexWrap: 'wrap' } },
    Object.entries(fitName).map(([k, name]) => h('span', {
      class: `rd-chip${fit === k ? ' rd-on' : ''}`, style: { cursor: 'pointer' },
      onclick: () => { fit = k; S.variantFit = k; draw(); modalRef.close(); showVariants(); },
    }, [name])));
  const gen = h('button', {
    class: 'rd-btn rd-primary',
    onclick: async () => {
      try {
        const r = await ctxRef.api.post('/api/render/variants', { scriptId, code, fit });
        if (!r.ok) { toast(`生成失败：${r.error}`, 'err'); return; }
        toast(`已提交多平台版本生成（${r.targets.length} 个，本地 ffmpeg 零成本）`, 'ok', 3600);
        S.variantJob = r.jobId;
        ctxRef.watchJob(r.jobId, (job) => {
          if (['done', 'error', 'canceled'].includes(job.status)) {
            if (job.status === 'done') toast('多平台版本已生成（在成片同目录，文件名带平台与分辨率）', 'ok', 4200);
            else if (job.status === 'error') toast(`生成失败：${job.error}`, 'err', 4200);
          }
        });
      } catch (e) { toast(`生成失败：${e.message}`, 'err'); }
    },
  }, ['📱 生成这些版本（本地零成本）']);
  const modalRef = ctxRef.modal({
    title: `📱 多平台版本 · ${code}`,
    width: 880,
    body: h('div', { class: 'rd-kv' }, [
      h('div', { class: 'rd-hint', style: { marginBottom: '6px' } }, ['同一集成片按各平台规格出片：竖屏转横屏建议用「模糊补边」保留完整构图；字幕底边距不足时按平台单独封装并调大 MarginV。']),
      fitChips, rowsBox,
      h('div', { class: 'row', style: { marginTop: '10px', gap: '8px', flexWrap: 'wrap' } }, [
        gen,
        h('span', { class: 'rd-hint' }, ['目标平台可在设置里用 variants.targets 固化；配置后交付包也会自动带上 variants/']),
      ]),
    ]),
  });
  draw();
}

/** 专业后期导出：时间线（EDL/FCP7 XML/OTIO）与字幕（SRT/VTT/TTML），每条都给出「与成片顺序同源」的说明 */
async function exportInterchange(kind) {
  const { scriptId, code } = cur();
  if (!scriptId || !code) { toast('先选一部剧本与一集', 'warn'); return; }
  const isTl = kind === 'timeline';
  const formats = isTl ? [['edl', 'EDL（CMX3600）'], ['fcp7', 'FCP7 XML（xmeml）'], ['otio', 'OTIO（OpenTimelineIO）']]
    : [['srt', 'SRT'], ['vtt', 'WebVTT'], ['ttml', 'TTML']];
  const rows = [];
  let check = null;
  for (const [fmt] of formats) {
    try {
      const r = await ctxRef.api.get(`/api/render/${isTl ? 'timeline' : 'subtitles'}?scriptId=${encodeURIComponent(scriptId)}&code=${encodeURIComponent(code)}&format=${fmt}`);
      if (!r.ok) { rows.push(`✗ ${fmt}：${r.error}`); continue; }
      if (isTl) rows.push(`✅ ${fmt}：${r.clipCount} 段 · 帧率 ${r.fps} · ${String(r.content || '').length} 字符`);
      else { rows.push(`✅ ${fmt}：${r.cues} 条 · ${String(r.content || '').length} 字符`); check = r.validation || check; }
    } catch (e) { rows.push(`✗ ${fmt}：${e.message}`); }
  }
  if (check) { rows.push('', `字幕规范：${check.summary}`); for (const c of (check.checks || []).filter((c) => c.level !== 'ok').slice(0, 5)) rows.push(`  ${c.level === 'warn' ? '⚠️' : 'ℹ️'} ${c.message}`); }
  if (isTl) rows.push('', '三种格式与「成片拼接顺序」同源同一份数据（界面顺序 = 成片顺序 = 导出顺序）。');
  ctxRef.modal({
    title: isTl ? `⤓ 时间线导出 · ${code}` : `⤓ 字幕导出 · ${code}`,
    width: 780,
    body: h('div', { class: 'rd-kv' }, [
      h('pre', { class: 'rd-code', style: { maxHeight: '50vh', overflow: 'auto' }, text: rows.join('\n') }),
      h('div', { class: 'row', style: { marginTop: '10px', gap: '8px', flexWrap: 'wrap' } },
        formats.map(([fmt, name]) => h('button', {
          class: 'rd-btn',
          onclick: () => window.open(`/api/render/${isTl ? 'timeline' : 'subtitles'}?scriptId=${encodeURIComponent(scriptId)}&code=${encodeURIComponent(code)}&format=${fmt}&download=1`, '_blank'),
        }, [`⬇ ${name}`]))),
    ]),
  });
}

/**
 * 时间线导入（把「⤓ 时间线 XML/OTIO」的导出链路接回来）：FCP7 XML / OTIO → 接入计划 → 显式「应用」才写画布连线。
 * ★ 零付费：只解析粘贴/选择的文本，再（可选）写画布连线；不调用任何出图 / 视频 / 配音后端。
 * ★ 默认 dry-run：先「预览计划」看清 clip1..N ← 哪段素材 · 哪条告警；确认后再点「应用」。
 */
async function openTimelineImport() {
  const selStyle = { background: 'var(--panel-2)', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: '7px', padding: '5px 7px', maxWidth: '260px' };
  const taStyle = { width: '100%', height: '150px', marginTop: '4px', background: 'var(--panel-2)', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: '8px', padding: '8px', fontFamily: 'var(--mono)', fontSize: '11px' };
  const baseText = '选择画布与成片节点 → 粘贴 XML/JSON 或选择文件 → 点「🔍 预览计划」\n\n'
    + '预览是 dry-run：不写库、不发起任何生成请求；确认 clip1..N 的对应关系无误后再点「⤓ 应用」。';

  const fmtSel = h('select', { style: selStyle, title: '默认按内容自动嗅探；内容与所选格式不符会给出中文提示' },
    [['auto', '自动识别（按内容）'], ['fcp7', 'FCP7 XML（xmeml v4）'], ['otio', 'OTIO（Timeline.1）']]
      .map(([v, t]) => h('option', { value: v }, [t])));
  const cvSel = h('select', { style: selStyle });
  const nodeSel = h('select', { style: selStyle });
  const ta = h('textarea', { style: taStyle, placeholder: '把 Premiere / Final Cut / DaVinci 导出的 FCP7 XML 或 OTIO JSON 粘贴到这里…' });
  const fileIn = h('input', { type: 'file', accept: '.xml,.otio,.json,text/xml,application/xml,application/json', style: { fontSize: '11.5px', color: 'var(--muted)' } });
  const out = h('pre', { class: 'rd-code', style: { maxHeight: '38vh', overflow: 'auto', marginTop: '8px' }, text: baseText });
  const previewBtn = h('button', { class: 'rd-btn', onclick: () => doPreview() }, ['🔍 预览计划']);
  const applyBtn = h('button', {
    class: 'rd-btn rd-primary', disabled: true,
    title: '按 clip1..N 端口 + slot 把片段接到所选成片节点（只写连线：不新建节点、不发起任何生成请求）',
    onclick: () => doApply(),
  }, ['⤓ 应用（写画布连线）']);
  let modal = null;
  let last = null;                                   // 最近一次成功的 dry-run 结果
  const show = (t) => { out.textContent = t; };
  const setApply = (on) => { applyBtn.disabled = !on; };
  const payload = (apply) => ({
    canvasId: cvSel.value, timelineNodeId: nodeSel.value, format: fmtSel.value,
    content: ta.value || '', apply, scriptId: cur().scriptId || null, code: cur().code || null,
  });
  const baseName = (p) => String(p || '').split(/[\\/]/).pop();
  const canApply = (r) => !!(r && r.plan && r.plan.ok && (r.plan.ports || []).length
    && (r.plan.chunks || []).length === 1 && !(r.match?.missing || []).length);

  /** 把后端的中文 detail（告警 / 缺失片段 / 提示）拼成弹窗里的多行文本 */
  function detailText(e) {
    const d = e?.detail || {};
    const lines = [];
    if (Array.isArray(d.warnings) && d.warnings.length) {
      lines.push('', `解析告警 ${d.warnings.length} 条：`);
      for (const w of d.warnings.slice(0, 12)) lines.push(`  ⚠️ ${w}`);
    }
    if (Array.isArray(d.missing) && d.missing.length) {
      lines.push('', `画布上没有对应视频节点的片段 ${d.missing.length} 段：`);
      for (const m of d.missing.slice(0, 8)) lines.push(`  · 第 ${m.index} 段「${m.name}」${m.file ? `（${m.file}）` : ''}：${m.reason}`);
      if (d.missing.length > 8) lines.push(`  · …其余 ${d.missing.length - 8} 段同理`);
    }
    if (d.hint) lines.push('', `提示：${d.hint}`);
    return lines.length ? `\n${lines.join('\n')}` : '';
  }

  function renderPlan(r, applied) {
    const m = r.match || {};
    const lines = [];
    lines.push(`格式 ${r.format} · 帧率 ${r.fps} fps · 序列「${r.sequenceName || '未命名'}」· 片段 ${num(r.clipCount)} 段 · 计划总时长 ${fmtSec(r.plan?.totalSeconds)}`);
    lines.push(`目标：画布 ${r.canvasId} → 成片节点 ${r.timelineNodeId}${r.timelineTitle ? `（${r.timelineTitle}）` : ''}`);
    lines.push(`画布视频节点 ${num(m.videoNodes)} 个 · 可匹配 ${num(m.matched)}/${num(r.clipCount)} 段${(m.missing || []).length ? ` · ⛔ 缺 ${m.missing.length} 段` : ' · ✅ 全部能对上'}`);
    if ((r.plan?.chunks || []).length > 1) {
      lines.push(`⚠️ ${(r.plan.warnings || []).find((w) => /分块/.test(w)) || '片段数超过单个成片节点的端口上限，需要分块'}`);
    }
    lines.push('');
    const byPort = new Map((r.plan?.links || []).map((l) => [l.to_port, l]));
    for (const p of (r.plan?.ports || [])) {
      const l = byPort.get(p.port) || {};
      const src = p.file ? baseName(p.file) : '（无素材文件）';
      lines.push(`${p.port}（slot ${p.slot}）← ${l.matched ? `${src} · 节点 ${l.from_node}${l.from_title ? `「${l.from_title}」` : ''}${l.matchBy === 'basename' ? '（按文件名匹配）' : ''}` : `⛔ 画布上没有对应视频节点 · ${src}`} · ${fmtSec(p.duration)} · recordIn ${p.recordIn ?? '-'}`);
    }
    if (applied) {
      lines.push('', `✅ 已写入 ${num(r.createCount)} 条连线（复用已有 ${num(r.reusedCount)} 条）`);
      for (const c of (r.created || [])) lines.push(`  · ${c.port}（slot ${c.slot}）← ${c.from_node}${c.from_title ? `「${c.from_title}」` : ''}`);
      if (r.error) lines.push(`  ⛔ ${r.error}`);
      if (r.order) lines.push('', `拼接顺序预览（dry-run）：${num(r.order.total)} 段${r.order.ready ? '，已就绪' : '，有缺失或端口重复'}`);
    }
    if ((r.warnings || []).length) {
      lines.push('', `告警 ${r.warnings.length} 条（中文）：`);
      for (const w of r.warnings) lines.push(`  ⚠️ ${w}`);
    }
    lines.push('', r.note || '');
    if (!applied) lines.push(canApply(r) ? '→ 计划可用：点「⤓ 应用」即可把 clip1..N 接到该成片节点。' : '→ 计划暂不可应用：请按上面的告警/缺失项先处理（不会伪造节点、不会部分写入）。');
    show(lines.join('\n'));
  }

  async function loadCanvases() {
    cvSel.disabled = true;
    try {
      const r = await ctxRef.api.get('/api/canvas/list');
      const list = r.canvases || [];
      cvSel.innerHTML = '';
      if (!list.length) cvSel.append(h('option', { value: '' }, ['（还没有画布）']));
      for (const c of list) cvSel.append(h('option', { value: c.id }, [`${c.name || c.id}（${num(c.node_count)} 节点）`]));
      const prefer = list.find((c) => c.id === 'CV-MAIN') || list[0];
      if (prefer) cvSel.value = prefer.id;
    } catch (e) { show(`画布列表加载失败：${e.message}`); }
    cvSel.disabled = false;
    await loadNodes();
  }

  async function loadNodes() {
    setApply(false); last = null;
    nodeSel.innerHTML = '';
    if (!cvSel.value) { nodeSel.append(h('option', { value: '' }, ['（无可用画布）'])); return; }
    try {
      const r = await ctxRef.api.get('/api/canvas?id=' + encodeURIComponent(cvSel.value));
      const tls = (r.canvas?.nodes || []).filter((x) => x.kind === 'timeline');
      if (!tls.length) nodeSel.append(h('option', { value: '' }, ['（该画布没有成片时间线节点）']));
      for (const x of tls) nodeSel.append(h('option', { value: x.id }, [`${x.title || '成片'}（${x.id}）`]));
      if (!tls.length) show(`${baseText}\n\n⚠️ 画布「${cvSel.value}」上还没有「成片时间线」节点：请先到画布放一个（或用「铺开分集」生成），再回来导入。`);
    } catch (e) {
      nodeSel.append(h('option', { value: '' }, ['（节点读取失败）']));
      show(`画布节点读取失败：${e.message}`);
    }
  }

  async function doPreview() {
    setApply(false); last = null;
    if (!String(ta.value || '').trim()) { show('请先粘贴 FCP7 XML / OTIO JSON 内容，或选择一个 .xml / .otio 文件'); return; }
    if (!nodeSel.value) { show('请先选一个成片（时间线）节点：导入必须落到画布上已存在的成片节点上'); return; }
    show('解析中…（dry-run：只解析文本，不写库、不发起任何生成请求）');
    try {
      const r = await ctxRef.api.post('/api/render/timeline-import', payload(false));
      last = r;
      renderPlan(r, false);
      setApply(canApply(r));
    } catch (e) {
      show(`❌ 解析/校验失败：${e.message}${detailText(e)}`);
      toast(`时间线导入失败：${e.message}`, 'err');
    }
  }

  async function doApply() {
    if (!canApply(last)) { show('请先「🔍 预览计划」，且计划可用（≤24 段、每段都能对上画布视频节点）后再应用'); return; }
    setApply(false);
    show('应用中…（只写画布连线：不新建节点、不发起任何生成请求）');
    try {
      const r = await ctxRef.api.post('/api/render/timeline-import', payload(true));
      last = r;
      renderPlan(r, true);
      toast(`已接入 ${num(r.createCount)} 条连线（复用 ${num(r.reusedCount)} 条）：clip1..N 顺序已写入成片节点`, 'ok');
      if (r.error) toast(r.error, 'err');
    } catch (e) {
      show(`❌ 应用失败：${e.message}${detailText(e)}\n\n本次没有写入任何连线（要么整批写入，要么一段不写）。修正后请重新「🔍 预览计划」。`);
      toast(`导入应用失败：${e.message}`, 'err');
    }
  }

  fileIn.addEventListener('change', async () => {
    const f = fileIn.files?.[0];
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) { show(`文件太大（${(f.size / 1048576).toFixed(1)}MB，上限 5MB）：请只导入单条序列/时间线的导出文件`); return; }
    try {
      ta.value = typeof f.text === 'function' ? await f.text() : '';
      last = null; setApply(false);
      show(`已读入 ${f.name}（${f.size} 字节）\n\n文件只在浏览器里读取、不会上传；点「🔍 预览计划」看接入计划（dry-run）。`);
    } catch (e) { show(`读取文件失败：${e.message}（可以改用手动粘贴文本）`); }
  });
  cvSel.addEventListener('change', () => { loadNodes(); });
  fmtSel.addEventListener('change', () => { last = null; setApply(false); });

  modal = ctxRef.modal({
    title: '⤓ 导入时间线（FCP7 XML / OTIO → 接入成片节点）',
    width: 900,
    body: h('div', { class: 'col', style: { gap: '8px' } }, [
      h('div', { class: 'rd-muted' }, ['把 Premiere / Final Cut / DaVinci 导出的 FCP7 XML（xmeml v4）或 OTIO（Timeline.1）读回来，接到画布上的「成片时间线」节点上。全程零付费：只解析文本 + 写画布连线，不调用任何出图 / 视频 / 配音后端。']),
      h('div', { class: 'rd-row', style: { gap: '8px', flexWrap: 'wrap', alignItems: 'center' } }, [
        h('span', { class: 'rd-lbl' }, ['画布']), cvSel,
        h('span', { class: 'rd-lbl' }, ['成片节点']), nodeSel,
        h('span', { class: 'rd-lbl' }, ['格式']), fmtSel,
      ]),
      h('div', { class: 'rd-row', style: { gap: '8px', flexWrap: 'wrap', alignItems: 'center' } }, [
        h('span', { class: 'rd-lbl' }, ['选择文件']), fileIn,
        h('span', { class: 'rd-muted', style: { fontSize: '11px' } }, ['（.xml / .otio / .json；也可以直接粘贴文本）']),
      ]),
      ta, out,
    ]),
    footer: [previewBtn, applyBtn, h('button', { class: 'rd-btn', onclick: () => modal?.close() }, ['关闭'])],
  });
  loadCanvases();
}

/** 工作流能力匹配（LibTV 调研第 6 条）：实例能力 ↔ 本集需求，先给降级建议，别等跑到一半才报错 */
async function showBackendFit() {
  const { scriptId, code } = cur();
  try {
    const r = await ctxRef.api.get(`/api/render/backend-fit?scriptId=${encodeURIComponent(scriptId || '')}&code=${encodeURIComponent(code || '')}`);
    if (!r.ok) { toast(`能力匹配失败：${r.error}`, 'err'); return; }
    const fit = r.fit || {};
    const rows = [r.summary, ''];
    rows.push(`后端：${fit.backend}（${fit.facts?.kind || ''}）｜${fit.facts?.note || ''}`);
    rows.push(`本集需求：${fit.needs?.shots || 0} 镜 · 最长 ${fit.needs?.maxDuration ?? '-'}s · 共 ${fit.needs?.totalSeconds ?? '-'}s · 比例 ${fit.needs?.ratio || '未指定'}${fit.needs?.hasDialogue ? ' · 有台词' : ''}${fit.needs?.needLastFrame ? ' · 用了尾帧' : ''}`);
    rows.push('');
    for (const c of fit.checks || []) {
      const icon = c.level === 'block' ? '⛔' : c.level === 'warn' ? '⚠️' : c.level === 'info' ? 'ℹ️' : '✅';
      rows.push(`${icon} ${c.message}`);
      if (c.suggestion) rows.push(`     → ${c.suggestion}`);
    }
    rows.push('');
    rows.push(fit.rule || '');
    ctxRef.modal({
      title: `🧩 能力匹配 · ${code || '(未选集)'}${fit.degraded ? '（有需要降级处理的地方）' : ''}`,
      width: 900,
      body: h('div', { class: 'rd-kv' }, [
        h('pre', { class: 'rd-code', style: { maxHeight: '60vh', overflow: 'auto' }, text: rows.join('\n') }),
      ]),
    });
    toast(r.summary, fit.ready === false ? 'err' : fit.degraded ? 'warn' : 'ok', 4600);
  } catch (e) { toast(`能力匹配失败：${e.message}`, 'err'); }
}

/** 跨镜角色一致性评分：把「画风飘了的镜头」列出来，并告诉用户只重跑哪几镜就够 */
async function showConsistency() {
  const { scriptId, code } = cur();
  if (!scriptId || !code) { toast('先选一部剧本与一集', 'warn'); return; }
  toast('一致性评分中（读取关键帧画面，首次约数秒，结果会缓存）…', 'info', 2600);
  try {
    const r = await ctxRef.api.get(`/api/render/consistency?scriptId=${encodeURIComponent(scriptId)}&code=${encodeURIComponent(code)}`);
    if (!r.ok) { toast(`一致性评分失败：${r.error}`, 'err'); return; }
    const rep = r.report;
    const rows = [r.summary, ''];
    rows.push(`方法：${rep.method}`);
    rows.push(`可比较的关键帧 ${rep.summary.shotsScored} 张 · 角色组 ${rep.summary.actors} 个（可比较 ${rep.summary.groupsCompared}）· 离群 ${rep.summary.outliers} 镜`
      + (rep.summary.unreadable ? ` · ${rep.summary.unreadable} 张无法解码（未纳入）` : ''));
    rows.push('');
    for (const g of rep.groups) {
      rows.push(`【${g.actorName || g.actorId}】${g.n} 张关键帧 · 基准哈希 ${g.baseHash} · 组内均值 ${g.meanDistance ?? 0} · 判定线 ${g.cut ?? 0}${g.outliers ? ` · ⚠️ 离群 ${g.outliers} 镜` : ''}${g.note ? ` · ${g.note}` : ''}`);
      for (const sh of g.shots) rows.push(`   ${sh.outlier ? '⚠️' : '✅'} 镜 #${sh.idx} 距离 ${sh.distance}（${sh.bits} 位不同）`);
      rows.push('');
    }
    if (rep.retryHint) rows.push(rep.retryHint);
    ctxRef.modal({
      title: `🧬 跨镜一致性 · ${code}${rep.summary.outliers ? `（${rep.summary.outliers} 镜需复核）` : '（未发现离群）'}`,
      width: 880,
      body: h('div', { class: 'rd-kv' }, [
        h('pre', { class: 'rd-code', style: { maxHeight: '60vh', overflow: 'auto' }, text: rows.join('\n') }),
        h('div', { class: 'row', style: { marginTop: '10px' } }, [
          h('div', { class: 'rd-muted' }, ['把飘掉的镜头在画布/制作台单点重跑即可，评分会自动复算（不必整集重出）']),
        ]),
      ]),
    });
    toast(r.summary, rep.summary.outliers ? 'warn' : 'ok', 4200);
  } catch (e) { toast(`一致性评分失败：${e.message}`, 'err'); }
}

/** 生产看板：任务耗时/失败率、渲染成功率、失败原因 Top、产出趋势、剩余时间估算 */
async function showProductionStats() {
  const { scriptId } = cur();
  try {
    const r = await ctxRef.api.get(`/api/render/stats?days=7${scriptId ? `&scriptId=${encodeURIComponent(scriptId)}` : ''}`);
    if (!r.ok) { toast(`读取生产看板失败：${r.error}`, 'err'); return; }
    const s = r.stats;
    const bars = (n, max, width = 18) => {
      if (!max) return '';
      const k = Math.round((n / max) * width);
      return '█'.repeat(k) + '·'.repeat(Math.max(0, width - k));
    };
    const trendMax = Math.max(1, ...s.trend.map((t) => t.keyframes + t.videos));
    const trendLines = s.trend.map((t) => `  ${t.date.slice(5)}  图 ${String(t.keyframes).padStart(3)} 片 ${String(t.videos).padStart(3)}  ${bars(t.keyframes + t.videos, trendMax)}${t.paidRenders ? ` 计费 ${t.paidRenders}` : ''}`);
    const m = ctxRef.modal({
      title: '📊 生产看板（近 7 天）',
      width: 820,
      body: h('div', { class: 'rd-kv' }, [
        h('pre', { class: 'rd-code', style: { whiteSpace: 'pre-wrap' }, text: r.summary }),
        h('div', { class: 'rd-muted', style: { marginTop: '10px' } }, ['产出趋势（图 = 关键帧，片 = 视频）']),
        h('pre', { class: 'rd-code', text: trendLines.join('\n') }),
        h('div', { class: 'rd-muted', style: { marginTop: '10px' } }, ['后端：' + `出图 ${s.backend.image} · 视频 ${s.backend.video} · 配音 ${s.backend.tts}`]),
      ]),
    });
    return m;
  } catch (e) { toast(`读取生产看板失败：${e.message}`, 'err'); }
}

/** 交付包：先拉清单给用户过目（含缺失项与失败镜头），确认后再下载 zip */
async function deliverPackage() {
  const { scriptId, code } = cur();
  if (!scriptId || !code) return;
  let m = null;
  try {
    const r = await ctxRef.api.get(`/api/render/deliver/manifest?scriptId=${encodeURIComponent(scriptId)}&code=${encodeURIComponent(code)}`);
    if (!r.ok) { toast(`读取交付清单失败：${r.error}`, 'err'); return; }
    m = r.manifest;
  } catch (e) { toast(`读取交付清单失败：${e.message}`, 'err'); return; }

  const rows = [];
  rows.push(`剧本：${m.script.title}（${m.script.id}）`);
  rows.push(`集数：${m.episodes.length}｜镜头：${m.totals.shots}｜关键帧：${m.totals.keyframes}｜视频：${m.totals.videos}｜成片时长：${m.totals.filmSeconds.toFixed(1)}s`);
  rows.push(`打包：${m.files.length} 个清单文件 + 素材原文件｜合计约 ${(m.totalBytes / 1048576).toFixed(1)} MB`);
  rows.push('质检：打包时逐集跑质检（黑帧/静音/响度/流缺失/时长），报告随包交付');
  rows.push('');
  rows.push('包含：');
  for (const f of m.files) rows.push(`  · ${f.path}（${(f.bytes / 1024).toFixed(0)}KB）${f.note ? ' — ' + f.note : ''}`);
  if (m.missing.length) {
    rows.push('');
    rows.push(`⚠ 缺失 ${m.missing.length} 项：`);
    for (const x of m.missing.slice(0, 10)) rows.push(`  · ${x}`);
  }
  if (m.failed?.length) {
    rows.push('');
    rows.push(`⚠ 有 ${m.failed.length} 个失败镜头已写入报告（交付不受影响）：`);
    for (const f of m.failed.slice(0, 5)) rows.push(`  · 镜 ${f.shotId}（${f.kind}）[${f.errorLabel}]`);
  }

  const withAssets = h('input', { type: 'checkbox', checked: 'true' });
  const m2 = ctxRef.modal({
    title: '📦 导出交付包',
    width: 700,
    body: h('div', { class: 'rd-kv' }, [
      h('pre', { class: 'rd-code', text: rows.join('\n') }),
      h('label', { class: 'rd-muted', style: { display: 'block', marginTop: '8px' } }, [withAssets, ' 附带每镜关键帧与镜头视频原文件（体积更大，便于二次剪辑）']),
      h('div', { class: 'row', style: { marginTop: '10px' } }, [
        h('button', {
          class: 'rd-btn rd-primary',
          onclick: () => {
            const assets = withAssets.checked ? '1' : '0';
            window.open(`/api/render/deliver?scriptId=${encodeURIComponent(scriptId)}&code=${encodeURIComponent(code)}&assets=${assets}`, '_blank');
            m2.close();
            toast('交付包开始下载（含成片/字幕/分镜表/报告/EDL）', 'ok');
          },
        }, ['⬇ 生成并下载 ZIP']),
        h('div', { class: 'rd-muted' }, ['也可直接访问 /api/render/deliver 由脚本批量拉取']),
      ]),
    ]),
  });
}

/** 预算与磁盘：本月用量 / 预估金额 / 上限 / 数据目录占用 */
async function showGuardStatus() {
  try {
    const g = await ctxRef.api.get('/api/guard/status');
    const rows = [
      `本月用量：图 ${g.usage.images} · 视频 ${g.usage.videos} · 配音 ${g.usage.ttsChars} 字`,
      `本月金额：${g.cost.amount} ${g.cost.currency}${g.budget.monthlyCap ? `（上限 ${g.budget.monthlyCap}，剩余 ${g.remaining}）` : '（未设上限）'}`,
      `单价：图 ${g.cost.units.imageUnit} / 视频 ${g.cost.units.videoUnit} / 配音千字 ${g.cost.units.ttsPerKChars} ${g.cost.currency}`,
      `预算保护：${g.budget.enabled ? '开启' : '关闭'}${g.budget.confirmOver ? `（单次超 ${g.budget.confirmOver} 需确认）` : ''}`,
      `磁盘：${g.disk.totalMB}MB / 上限 ${g.disk.maxGB}GB${g.disk.over ? ' · 已超上限（新任务会被拒绝）' : g.disk.warn ? ' · 接近上限' : ''}`,
      `占用明细：${(g.disk.parts || []).map((p) => `${p.name} ${p.mb}MB`).join(' · ')}`,
    ];
    ctxRef.modal({
      title: '💰 预算与磁盘',
      width: 620,
      body: h('div', { class: 'rd-kv' }, [
        h('pre', { class: 'rd-code', text: rows.join('\n') }),
        h('div', { class: 'rd-muted', style: { marginTop: '8px' } }, ['在「设置 → 数据与备份 → 预算与存储保护」里调整单价、上限与确认阈值。']),
      ]),
    });
  } catch (e) { toast(`读取失败：${e.message}`, 'err'); }
}

async function probeBackend() {
  toast('正在探测视频后端…', 'info');
  try {
    const r = await ctxRef.api.post('/api/video-backend/probe', {});
    const vb = S.board?.backend?.video || S.backend?.video || {};
    const body = h('div', { class: 'rd-kv' }, [
      h('div', {}, [h('b', { text: r.ready ? '✅ ' : '⚠️ ' }), r.detail || '无详情']),
      h('div', { class: 'rd-muted', style: { marginTop: '8px' } }, [`后端：${r.backend || vb.backend || '-'}`]),
      h('div', { class: 'rd-muted' }, [`说明：${vb.note || '-'}`]),
      h('div', { class: 'rd-muted', style: { marginTop: '8px' } }, [
        '本地 placeholder 为 ffmpeg 运镜占位；配置 ComfyUI（MiniMax H3 图生视频）或任意视频 API 后即为真实 AI 视频。',
      ]),
      h('button', { class: 'rd-btn', style: { marginTop: '10px' }, onclick: () => { m.close(); doTestVideo(); } }, ['🧪 单镜试渲染（3 秒，不落库）']),
    ]);
    const m = ctxRef.modal({ title: r.ready ? '视频后端可用' : '视频后端不可用', body, width: 520 });
  } catch (e) {
    toast(`探测失败：${e.message}`, 'err');
  }
}

function backendInfo(kind) {
  const be = S.board?.backend?.[kind] || S.backend?.[kind] || {};
  const name = kind === 'video' ? '视频后端' : '出图后端';
  const body = h('div', { class: 'rd-kv' }, [
    h('div', {}, [h('b', { text: `${name}：${be.backend || '未配置'}` }), be.ready ? '（就绪）' : '（未就绪）']),
    h('div', { class: 'rd-muted', style: { marginTop: '6px' } }, [be.note || '无说明']),
    kind === 'video' ? h('div', { class: 'rd-muted', style: { marginTop: '8px' } }, [
      'placeholder：本地 ffmpeg 把关键帧做推/拉/摇/移等运镜生成 mp4（需要先有该镜关键帧）。',
    ]) : null,
    kind === 'video' ? h('div', { class: 'rd-row', style: { marginTop: '10px' } }, [
      h('button', { class: 'rd-btn', onclick: () => { m.close(); probeBackend(); } }, ['🔍 探测视频后端']),
      h('button', { class: 'rd-btn', onclick: () => { m.close(); doTestVideo(); } }, ['🧪 单镜试渲染']),
    ]) : null,
  ]);
  const m = ctxRef.modal({ title: name + '状态', body, width: 520 });
}

function previewMedia(src, kind, title) {
  const body = kind === 'video'
    ? h('video', { class: 'rd-modal-video', controls: true, autoplay: true, src })
    : h('img', { src, style: { width: '100%', borderRadius: '8px' } });
  const m = ctxRef.modal({
    title: title || '预览',
    body,
    width: 760,
    footer: [
      h('a', { class: 'rd-btn', href: src, target: '_blank' }, ['在新标签页打开']),
      h('a', { class: 'rd-btn', href: src, download: true }, ['⬇ 下载']),
      h('button', { class: 'rd-btn', onclick: () => m.close() }, ['关闭']),
    ],
  });
}

async function doTestVideo() {
  const vb = S.board?.backend?.video || S.backend?.video || {};
  const shots = S.board?.shots || [];
  // 已设尾帧的镜头优先（顺手验证「首尾帧过渡」这条路），否则退回任意有关键帧的镜头
  const withKf = shots.find((s) => s.keyframe && S.lastImages?.[s.id]) || shots.find((s) => s.keyframe);
  const lastRel = withKf ? (S.lastImages?.[withKf.id] || null) : null;
  toast('正在试渲染单镜视频（约数秒）…', 'info');
  try {
    const r = await ctxRef.api.post('/api/render/test-video', {
      backend: vb.backend, duration: 3,
      move: withKf?.move || '推镜',
      ratio: S.board?.script?.ratio || '16:9',
      keyframe: withKf?.keyframe?.file_path || null,
      prompt: withKf?.prompt_pos || '测试镜头：夜色中的雨巷，缓慢推近',
      ...(lastRel ? { lastImage: lastRel } : {}),
    });
    const src = r.fileUrl || url(r.filePath);
    ctxRef.toast(`试渲染成功：${r.backend || ''} ${fmtSec(r.duration)}${r.lastFrom === 'last' ? `（带尾帧：${r.note || '首尾帧过渡'}）` : ''}`, 'ok');
    previewMedia(src, 'video', lastRel ? '单镜试渲染（首尾帧过渡，未落库）' : '单镜试渲染（未落库）');
  } catch (e) {
    ctxRef.toast(`试渲染失败：${e.message}`, 'err');
  }
}

async function copyText(text, label) {
  const t = String(text || '');
  if (!t) { toast('没有可复制的内容', 'err'); return; }
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(t); toast(`${label}已复制到剪贴板`, 'ok'); return; }
    throw new Error('no clipboard');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = t;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    if (ok) { toast(`${label}已复制到剪贴板`, 'ok'); return; }
    const body = h('div', {}, [
      h('div', { class: 'rd-muted', text: '浏览器拒绝了剪贴板访问，请手动复制：' }),
      h('textarea', { style: { width: '100%', height: '180px', marginTop: '6px', background: 'var(--panel-2)', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: '8px', padding: '8px', fontFamily: 'var(--mono)', fontSize: '11px' } }, [t]),
    ]);
    ctxRef.modal({ title: label, body, width: 640 });
  }
}

function exportEpisode(format) {
  const { scriptId, code } = cur();
  if (!scriptId || !code) return;
  window.open(`/api/scripts/${encodeURIComponent(scriptId)}/export?format=${encodeURIComponent(format)}&episode=${encodeURIComponent(code)}`, '_blank');
  toast(`已在新标签页打开本集 ${String(format).toUpperCase()} 导出`, 'info');
}

async function loadAllFilms() {
  try {
    const r = await ctxRef.api.get(`/api/render/films?scriptId=${encodeURIComponent(S.scriptId)}`);
    S.allFilms = r.films || [];
    S.showAllFilms = true;
    renderMain();
  } catch (e) {
    toast(`成片列表加载失败：${e.message}`, 'err');
  }
}

async function cancelJob(jobId) {
  try {
    await ctxRef.api.post(`/api/jobs/${encodeURIComponent(jobId)}/cancel`);
    toast('已请求取消任务', 'info');
  } catch (e) {
    toast(`取消失败：${e.message}`, 'err');
  }
}

// ---------------- 成片包装面板 ----------------
function drawFinishPanel() {
  if (isPanelOpen(finishPanel) && finishPanel.draw) finishPanel.draw();
}

function openFinishPanel({ assembleAfter = false } = {}) {
  closePanel(finishPanel);
  if (!S.finishLoaded) loadFinishStatus();
  const v = {
    f: { ...defaultFinish(), ...(S.finish || {}) },
    srt: null, srtErr: '', busy: false, ttsTest: null, ttsErr: '', bgmErr: '', msg: '', loudnessMsg: '',
  };
  const box = h('div', { class: 'rd-panel' });
  const draw = () => { box.innerHTML = finishPanelHTML(v); };
  box.addEventListener('click', (e) => onFinishClick(e, v, draw));
  box.addEventListener('change', (e) => onFinishChange(e, v, draw));
  box.addEventListener('input', (e) => onFinishInput(e));

  const close = h('button', { class: 'rd-btn' }, ['关闭']);
  const save = h('button', { class: 'rd-btn' }, ['💾 保存为默认']);
  const apply = h('button', { class: 'rd-btn rd-primary' }, [assembleAfter ? '✅ 应用并封装本集' : '✅ 应用到本集封装']);
  const m = ctxRef.modal({
    title: '🎁 成片包装 · 字幕 / 音轨 / 画面',
    body: box, width: 760, footer: [close, save, apply],
    onClose: () => { if (finishPanel && finishPanel.overlay === m.overlay) finishPanel = null; },
  });
  close.addEventListener('click', () => m.close());
  save.addEventListener('click', () => saveFinishDefault(v, m));
  apply.addEventListener('click', () => {
    S.finish = { ...v.f };
    S.finishDirty = true;
    m.close();
    renderMain();
    drawPipePanel();
    toast(`已应用包装设置：${finishSummary()}`, 'ok');
    if (assembleAfter) runAssemble(true);
  });

  finishPanel = Object.assign(m, { view: v, draw });
  draw();
}

function finishPanelHTML(v) {
  const f = v.f;
  const det = S.detectedFont || '';
  const tts = S.tts || {};
  const subOn = !!f.subtitles;
  const audioRow = (k) => `<span class="rd-chip${f.audio === k ? ' rd-on' : ''}" data-fa="audio" data-v="${k}">${AUDIO_NAME[k]}</span>`;
  return `
  <div class="rd-sec">
    <div class="rd-sec-t">💬 字幕
      <label class="rd-ck2"><input type="checkbox" data-fkey="subtitles" data-redraw="1" ${subOn ? 'checked' : ''}/>启用字幕</label>
      <span class="rd-grow"></span>
      <span class="rd-tag ${det ? 'rd-ok' : 'rd-warn'}" title="后端用 fontconfig 探测到的中文字体（libass 燃烧字幕用）">探测字体：${esc(det || '未探测到')}</span>
    </div>
    <div class="rd-frow"><label>模式</label>
      ${['hard', 'soft', 'none'].map((k) => `<span class="rd-chip${f.subtitleMode === k ? ' rd-on' : ''}" data-fa="sub-mode" data-v="${k}">${SUB_MODE_NAME[k]}</span>`).join('')}
      <span class="rd-hint">${f.subtitleMode === 'hard' ? '硬字幕：烧进画面，需重编码视频（兼容性最好）' : f.subtitleMode === 'soft' ? '软字幕：内嵌字幕轨，播放器可开关，不重编码' : '不做字幕'}</span>
    </div>
    ${subOn && f.subtitleMode !== 'none' ? `
    <div class="rd-frow"><label>字体</label>
      <input class="rd-inp" type="text" data-fkey="subtitleFont" value="${attr(f.subtitleFont || det)}" placeholder="${attr(det || 'Auto')}"/>
      <button class="rd-btn rd-sm" data-fa="font-auto" title="填入后端探测到的中文字体">用探测字体</button>
      <span class="rd-hint">已预填后端探测到的中文字体（可手填）；清空则由后端自动选择</span>
    </div>
    <div class="rd-frow"><label>字幕样式</label>
      字号 <input class="rd-inp" type="number" min="10" max="72" step="1" data-fkey="subtitleSize" value="${num(f.subtitleSize) || 22}"/> px
      · 底部边距 <input class="rd-inp" type="number" min="0" max="400" step="2" data-fkey="subtitleMarginV" value="${num(f.subtitleMarginV)}"/> px
      <label class="rd-ck2" title="没有台词的镜头用动作描述当字幕"><input type="checkbox" data-fkey="subtitleIncludeAction" data-redraw="1" ${f.subtitleIncludeAction ? 'checked' : ''}/>包含动作描述</label>
    </div>
    <div class="rd-frow">
      <button class="rd-btn" data-fa="preview-srt" ${v.busy ? 'disabled' : ''}>👁 预览字幕</button>
      <span class="rd-hint">按当前剧集（${esc(S.epCode || '未选集')}）镜头顺序与台词生成 SRT 预览，含说话人推断；不写文件、不合成</span>
    </div>
    ${v.srtErr ? `<div class="rd-errbox" style="margin-top:8px">⚠️ 字幕预览失败：${esc(v.srtErr)}</div>` : ''}
    ${v.srt ? `<div class="rd-row" style="margin-top:8px">
        <span class="rd-tag rd-acc">共 ${num(v.srt.cues)} 条字幕</span>
        <span class="rd-tag">总时长 ${fmtSec(v.srt.duration)}</span>
        <span class="rd-tag">字体 ${esc(v.srt.font || det || '自动')}</span>
        <span class="rd-hint">下面显示 SRT 前 ${SRT_PREVIEW_LINES} 行${v.srt.more ? `（还有 ${v.srt.more} 行未显示）` : ''}</span>
      </div>
      <pre class="rd-srt">${esc(v.srt.text)}</pre>` : ''}
    ` : ''}
  </div>

  <div class="rd-sec">
    <div class="rd-sec-t">🔊 音轨 ${audioRow('silent')} ${audioRow('tts')} ${audioRow('bgm')} ${audioRow('tts_bgm')}
      <span class="rd-grow"></span>
      <span class="rd-tag ${tts.ready ? 'rd-ok' : 'rd-warn'}" title="${attr(tts.note || '')}">TTS：${esc(tts.backend || 'none')} ${tts.ready ? '就绪' : '未就绪'}</span>
    </div>
    ${f.audio === 'silent' ? '<div class="rd-hint">静音轨：成片带一条静音 AAC 音轨（保证时间轴与播放器行为正常），台词以字幕呈现。</div>' : ''}
    ${(f.audio === 'tts' || f.audio === 'tts_bgm') ? `
      <div class="rd-hint">配音（TTS）：<b>按角色音色</b>逐句合成（演员档案里的「音色」），超出镜头时长会先加速（上限 ${f.ttsMaxSpeed || 1.25}x）仍超长才截断；相同台词+音色会复用缓存不再重复合成。${f.audio === 'tts_bgm' ? '背景乐会循环铺满整集，并<b>在人声处自动压低（侧链避让）</b>。' : ''}需要先在「设置 → 配音（TTS）」配置后端。</div>
      <div class="rd-frow">
        <span>后端 <b>${esc(tts.backend || 'none')}</b> ${tts.ready ? '<span class="rd-tag rd-ok">就绪</span>' : '<span class="rd-tag rd-warn">未就绪</span>'} · 音色 ${esc(tts.voice || '-')}</span>
        <button class="rd-btn rd-sm" data-fa="tts-test" ${v.busy ? 'disabled' : ''} title="调 /api/tts-backend/test 合成一句示例台词">🔈 试听</button>
        <button class="rd-btn rd-sm" data-fa="tts-probe" ${v.busy ? 'disabled' : ''}>🔍 探测后端</button>
        <button class="rd-btn rd-sm" data-fa="tts-settings">⚙️ 去设置</button>
      </div>
      ${!tts.ready ? `<div class="rd-notice" style="margin-top:8px">
        <div class="rd-notice-body"><b>⚠️ 配音后端「${esc(tts.backend || 'none')}」未就绪。</b>
          <div style="color:var(--muted);margin-top:3px">${esc(tts.note || '未启用配音')}</div>
          <div style="margin-top:4px">此时合成会自动回退为<b style="color:var(--warn)">静音轨</b>，并在成片 meta 的 <code>audio.reason</code> 里写明原因。想真正配音请到设置页选择 TTS 后端（openai / generic-http）并填写地址与密钥。</div>
        </div>
        <button class="rd-btn rd-sm" data-fa="tts-settings">⚙️ 去设置</button>
      </div>` : ''}
      ${v.ttsErr ? `<div class="rd-errbox" style="margin-top:8px">⚠️ ${esc(v.ttsErr)}</div>` : ''}
      ${v.ttsTest ? `<div class="rd-frow" style="margin-top:8px">
          <span class="rd-tag rd-ok">试听成功 · ${fmtMs(v.ttsTest.elapsedMs)} · ${fmtSize(v.ttsTest.size)}</span>
          <audio controls autoplay src="${attr(url(v.ttsTest.filePath))}"></audio>
        </div>` : ''}
    ` : ''}
    ${(f.audio === 'bgm' || f.audio === 'tts_bgm') ? `
      <div class="rd-hint">背景乐（BGM）：把上传的音频循环铺满整集，按音量混入，结尾自动淡出${f.audio === 'tts_bgm' ? '；有人声时会自动压低 BGM 音量（侧链压缩）' : ''}。</div>
      <div class="rd-frow"><label>BGM 文件</label>
        <input class="rd-inp" type="file" accept="audio/*" data-fa="bgm-file" ${v.busy ? 'disabled' : ''}/>
        ${f.bgmPath ? '<span class="rd-tag rd-ok">已上传</span><button class="rd-btn rd-sm rd-danger" data-fa="bgm-clear">清除</button>' : '<span class="rd-hint">支持 mp3 / wav / m4a / flac</span>'}
      </div>
      ${f.bgmPath ? `<div class="rd-frow"><code style="font-family:var(--mono);font-size:10.5px;color:var(--accent-3);word-break:break-all">${esc(f.bgmPath)}</code>
        <audio controls preload="none" src="${attr(url(f.bgmPath))}"></audio></div>` : ''}
      <div class="rd-frow"><label>音量</label>
        <input class="rd-inp" type="range" min="0" max="1" step="0.05" data-fkey="bgmVolume" data-out="bgmVolume" value="${num(f.bgmVolume)}"/>
        <b data-outname="bgmVolume">${Math.round(num(f.bgmVolume) * 100)}%</b>
      </div>
      ${v.bgmErr ? `<div class="rd-errbox" style="margin-top:8px">⚠️ ${esc(v.bgmErr)}</div>` : ''}
    ` : ''}
  </div>

  <div class="rd-sec">
    <div class="rd-sec-t">🎬 画面</div>
    <div class="rd-frow"><label>淡入 / 淡出</label>
      <input class="rd-inp" type="number" min="0" max="5" step="0.1" data-fkey="fadeIn" value="${num(f.fadeIn)}"/> 秒 淡入
      <input class="rd-inp" type="number" min="0" max="5" step="0.1" data-fkey="fadeOut" value="${num(f.fadeOut)}"/> 秒 淡出
      <span class="rd-hint">0 = 不做；淡出以成片总时长为基准</span>
    </div>
    <div class="rd-frow"><label>响度归一</label>
      ${LOUDNESS_TARGETS.map(([k, name]) => `<span class="rd-chip${(f.loudness || 'off') === k ? ' rd-on' : ''}" data-fa="loudness" data-v="${k}">${name}</span>`).join('')}
    </div>
    <div class="rd-frow">
      <button class="rd-btn" data-fa="probe-loudness" ${v.busy ? 'disabled' : ''}>📈 测一下当前成片响度</button>
      <span class="rd-hint">两遍法 loudnorm：先测再线性归一，保动态不压平；EBU R128 用于欧洲广播、ATSC A/85 用于北美广播、流媒体口径对标 YouTube/抖音</span>
    </div>
    ${v.loudnessMsg ? `<div class="rd-errbox" style="margin-top:8px">${esc(v.loudnessMsg)}</div>` : ''}
    ${v.msg ? `<div class="rd-notice rd-info" style="margin-top:8px"><div class="rd-notice-body">${esc(v.msg)}</div></div>` : ''}
  </div>`;
}

function onFinishInput(e) {
  const t = e.target;
  const v = finishPanel?.view;
  if (!v || !t || !t.dataset) return;
  const key = t.dataset.fkey;
  if (!key) return;
  v.f[key] = t.type === 'number' || t.type === 'range' ? Number(t.value) : t.value;
  if (t.dataset.out) {
    const out = t.parentElement?.querySelector(`[data-outname="${t.dataset.out}"]`);
    if (out) out.textContent = `${Math.round(Number(t.value) * 100)}%`;
  }
}

/** 测量当前成片响度（只测量，不改文件），并按当前口径给出是否达标 */
async function probeLoudness(v, draw) {
  const { scriptId, code } = cur();
  if (!scriptId || !code) { v.loudnessMsg = '先选一部剧本与一集'; draw(); return; }
  v.busy = true; v.loudnessMsg = '测量中（ffmpeg ebur128）…'; draw();
  try {
    const r = await ctxRef.api.get(`/api/render/loudness?scriptId=${encodeURIComponent(scriptId)}&code=${encodeURIComponent(code)}&target=${encodeURIComponent(v.f.loudness || 'off')}`);
    if (!r.ok) { v.loudnessMsg = `响度测量失败：${r.error}`; return; }
    const m = r.measured || {};
    v.loudnessMsg = `实测 I=${m.integrated} LUFS · LRA=${m.lra} · Peak=${m.peak} dBTP ｜ ${r.verdict?.level === 'ok' ? '✅' : '⚠️'} ${r.verdict?.message || ''}`;
  } catch (e) { v.loudnessMsg = `响度测量失败：${e.message}`; }
  finally { v.busy = false; draw(); }
}

function onFinishChange(e, v, draw) {
  const t = e.target;
  v = v || finishPanel?.view;
  if (!v || !t || !t.dataset) return;
  if (t.dataset.fa === 'bgm-file') { uploadBgm(v, t.files?.[0], draw); return; }
  const key = t.dataset.fkey;
  if (!key) return;
  v.f[key] = t.type === 'checkbox' ? !!t.checked : t.value;
  if (t.dataset.redraw) drawFinishPanel();
}

function onFinishClick(e, v, draw) {
  const hit = e.target.closest('[data-fa]');
  if (!hit) return;
  const f = v.f;
  const fa = hit.dataset.fa;
  if (fa === 'sub-mode') { f.subtitleMode = hit.dataset.v; draw(); return; }
  if (fa === 'audio') { f.audio = hit.dataset.v; draw(); return; }
  if (fa === 'loudness') { f.loudness = hit.dataset.v; v.loudnessMsg = ''; draw(); return; }
  if (fa === 'probe-loudness') { probeLoudness(v, draw); return; }
  if (fa === 'font-auto') { f.subtitleFont = S.detectedFont || ''; draw(); return; }
  if (fa === 'preview-srt') { doPreviewSrt(v, draw); return; }
  if (fa === 'tts-test') { doTtsTest(v, draw); return; }
  if (fa === 'tts-probe') { doTtsProbe(v, draw); return; }
  if (fa === 'tts-settings') { toast('请到「设置 → 配音（TTS）」配置配音后端', 'info'); ctxRef.go('settings'); return; }
  if (fa === 'bgm-clear') { f.bgmPath = ''; v.bgmErr = ''; draw(); return; }
}

async function doPreviewSrt(v, draw) {
  const { scriptId, code } = cur();
  if (!scriptId || !code) { v.srtErr = '请先在左栏选择一集'; v.srt = null; draw(); return; }
  v.busy = true; v.srtErr = ''; draw();
  try {
    const r = await ctxRef.api.post('/api/render/preview-srt', { scriptId, code, includeAction: !!v.f.subtitleIncludeAction });
    const lines = String(r.srt || '').split('\n');
    v.srt = {
      cues: r.cues, duration: r.duration, font: r.font,
      text: lines.slice(0, SRT_PREVIEW_LINES).join('\n'),
      more: Math.max(0, lines.length - SRT_PREVIEW_LINES),
    };
    if (!r.cues) v.srtErr = '该集没有可做字幕的台词（可打开「包含动作描述」用动作文字当字幕）';
  } catch (e) { v.srtErr = e.message; v.srt = null; }
  v.busy = false; draw();
}

async function doTtsTest(v, draw) {
  v.busy = true; v.ttsErr = ''; draw();
  try {
    const r = await ctxRef.api.post('/api/tts-backend/test', { voice: (S.tts || {}).voice });
    v.ttsTest = r;
    toast(`试听合成成功（${fmtMs(r.elapsedMs)}）`, 'ok');
  } catch (e) { v.ttsTest = null; v.ttsErr = `试听失败：${e.message}`; }
  v.busy = false; draw();
}

async function doTtsProbe(v, draw) {
  v.busy = true; v.ttsErr = ''; draw();
  try {
    const r = await ctxRef.api.post('/api/tts-backend/probe', {});
    v.msg = `TTS 后端 ${r.backend || (S.tts || {}).backend || '-'}：${r.detail || '可用'}`;
    toast('TTS 后端可用', 'ok');
    await loadFinishStatus(false);
  } catch (e) {
    v.ttsErr = `探测失败：${e.data?.detail || e.message}`;
  }
  v.busy = false; draw();
}

async function uploadBgm(v, file, draw) {
  if (!file) return;
  v.busy = true; v.bgmErr = ''; draw();
  try {
    const r = await ctxRef.api.upload(file);
    if (!r?.path) throw new Error('上传未返回文件路径');
    v.f.bgmPath = r.path;
    v.msg = `已上传 BGM：${r.name || ''}（${fmtSize(r.size)}）`;
    toast('BGM 上传成功', 'ok');
  } catch (e) { v.bgmErr = `上传失败：${e.message}`; }
  v.busy = false; draw();
}

async function saveFinishDefault(v, m) {
  const payload = { ...v.f };
  try {
    await ctxRef.api.put('/api/settings', { finish: payload });
    S.finish = { ...v.f };
    S.finishDirty = false;
    toast('已保存为默认包装设置（下次合成/流水线自动使用）', 'ok');
    renderMain();
  } catch (e) {
    toast(`保存失败：${e.message}`, 'err');
  }
}

// ---------------- 整季流水线面板 ----------------
function openPipelinePanel() {
  closePanel(pipePanel);
  if (!S.scripts.length) { toast('还没有剧本项目，请先到「剧本工厂」生成剧本', 'err'); return; }
  const script = S.scripts.find((x) => x.id === S.scriptId) || S.scripts[0];
  const eps = script?.episodes || [];
  if (!eps.length) { toast('该剧本还没有分集规划，请先到「剧本工厂」做分集规划', 'err'); return; }
  const v = {
    scriptId: script.id,
    codes: new Set(eps.map((e) => e.code)),
    stages: new Set(PIPE_STAGES.map(([k]) => k)),
    costs: new Set(),
    overwrite: false,
    offline: true,
    est: null, estErr: '', busy: false, jobId: null, job: null, err: '', seq: 0,
  };
  const box = h('div', { class: 'rd-panel', id: 'rd-pipe-box' });
  const draw = () => {
    box.innerHTML = pipelinePanelHTML(v);
    updatePipeProgress(v);
  };
  box.addEventListener('click', (e) => onPipeClick(e, v, draw));
  box.addEventListener('change', (e) => onPipeChange(e, v, draw));

  const close = h('button', { class: 'rd-btn' }, ['关闭']);
  const cancel = h('button', { class: 'rd-btn rd-danger' }, ['⏹ 取消任务']);
  const run = h('button', { class: 'rd-btn rd-primary' }, ['▶ 开始整季生产']);
  const m = ctxRef.modal({
    title: '🚀 整季流水线 · 规划 → 分镜 → 关键帧 → 视频 → 成片',
    body: box, width: 920, footer: [close, cancel, run],
    onClose: () => { if (pipePanel && pipePanel.overlay === m.overlay) pipePanel = null; },
  });
  close.addEventListener('click', () => m.close());
  const syncCancel = () => {
    const st = v.job?.status;
    cancel.disabled = !v.jobId || !(st === 'running' || st === 'queued' || !st);
  };
  cancel.addEventListener('click', () => { if (v.jobId) cancelJob(v.jobId); });
  run.addEventListener('click', () => startPipeline(v, draw));

  pipePanel = Object.assign(m, { view: v, draw, box, syncCancel });
  draw();
  syncCancel();
  loadEstimate(v, draw);
  return v;
}

function pipelinePanelHTML(v) {
  const script = S.scripts.find((x) => x.id === v.scriptId) || {};
  const eps = script.episodes || [];
  const est = v.est;
  const running = v.busy && v.jobId;
  const chip = (on, attrs, text, title) => `<span class="rd-chip${on ? ' rd-on' : ''}" ${attrs} title="${attr(title || '')}">${text}</span>`;
  return `
  <div class="rd-sec">
    <div class="rd-sec-t">🎯 目标剧集
      <span class="rd-tag rd-acc">已选 ${v.codes.size} / ${eps.length} 集</span>
      <span class="rd-hint">剧本 ${esc(script.title || script.id || '')}（${esc(script.id || '')}）</span>
      <span class="rd-grow"></span>
      <button class="rd-btn rd-sm" data-pa="ep-all">全选</button>
      <button class="rd-btn rd-sm" data-pa="ep-inv">反选</button>
      <button class="rd-btn rd-sm" data-pa="ep-none">清空</button>
    </div>
    <div class="rd-chips">
      ${eps.map((e) => chip(v.codes.has(e.code), `data-pa="ep" data-code="${attr(e.code)}"`,
        `${esc(e.code)} · ${esc(e.title || '')} <span class="rd-hint">${num(e.shot_count)}镜${e.film_id ? ' · 有片' : ''}</span>`,
        `${e.code} ${e.title || ''}｜${num(e.shot_count)} 镜，关键帧 ${num(e.keyframe_count)}，视频 ${num(e.video_count)}`)).join('')}
    </div>
  </div>

  <div class="rd-sec">
    <div class="rd-sec-t">🧩 生产阶段 <span class="rd-hint">按集串行执行；没有分镜的集会先走「分集规划 → 生成分镜」</span></div>
    <div class="rd-chips">
      ${PIPE_STAGES.map(([k, name]) => chip(v.stages.has(k), `data-pa="stage" data-v="${k}"`, name, `阶段 ${k}`)).join('')}
    </div>
    <div class="rd-chips" style="margin-top:8px">
      <span class="rd-lbl">目标成本级（只给这些镜头出片）</span>
      ${['L', 'M', 'H'].map((c) => chip(v.costs.has(c), `data-pa="cost" data-v="${c}"`, `${c}`, COST_NAME[c])).join('')}
      <span class="rd-hint">不选 = 全部镜头（含 L）</span>
    </div>
    <div class="rd-frow">
      <label class="rd-ck2" title="已存在的分镜/关键帧/视频会重新生成"><input type="checkbox" data-pk="overwrite" data-redraw="1" ${v.overwrite ? 'checked' : ''}/>⟳ 覆盖重做（重新生成已存在的素材）</label>
      <label class="rd-ck2" title="分镜走离线规则（provider=mock），不调用任何模型、不花钱"><input type="checkbox" data-pk="offline" data-redraw="1" ${v.offline ? 'checked' : ''}/>🧪 离线试跑（分镜走离线规则，不调用模型）</label>
    </div>
    <div class="rd-hint" style="margin-top:4px">${v.offline ? '当前为离线试跑：分集规划/分镜由离线规则生成（适合先跑通链路）；关键帧与视频仍按当前出图/视频后端执行。' : '当前为在线生产：分镜会调用当前 LLM（可能产生费用）。'}</div>
  </div>

  <div class="rd-sec">
    <div class="rd-sec-t">📊 工作量与预估
      <span class="rd-tag">/api/render/estimate</span>
      <span class="rd-grow"></span>
      <button class="rd-btn rd-sm" data-pa="est" ${v.busy ? 'disabled' : ''}>⟳ 重新估算</button>
    </div>
    ${v.estErr ? `<div class="rd-errbox">⚠️ 估算失败：${esc(v.estErr)}</div>` : ''}
    ${est ? `
      <div class="rd-stats" style="margin-bottom:8px">
        <div class="rd-stat"><b>${num(est.totals?.episodes)}</b>剧集</div>
        <div class="rd-stat"><b>${num(est.totals?.shots)}</b>总镜头</div>
        <div class="rd-stat"><b>${num(est.totals?.keyframes)}</b>需出图</div>
        <div class="rd-stat"><b>${num(est.totals?.videos)}</b>需出片</div>
        <div class="rd-stat"><b>${fmtSec(est.totals?.seconds)}</b>成片总时长</div>
        <div class="rd-stat" title="按当前视频后端 ${esc(est.videoBackend || '')}（约 ${num(est.videoSecondsPerShot)} 秒/镜）估算">
          <b>${num(est.estimate?.minutes)} 分</b>预估耗时${est.estimate?.hours ? `（约 ${num(est.estimate.hours)} 小时）` : ''}</div>
        <div class="rd-stat"><b>${num(est.estimate?.storyboardCalls)}</b>待生成分镜的集</div>
      </div>
      <div class="rd-rep-wrap"><table class="rd-rep">
        <thead><tr><th>剧集</th><th>镜头</th><th>出片目标</th><th>缺关键帧</th><th>缺视频</th><th>时长</th></tr></thead>
        <tbody>${(est.episodes || []).map((e) => `<tr>
          <td><b>${esc(e.code)}</b> <span class="rd-hint">${esc(e.title || '')}</span>${e.needsStoryboard ? ' <span class="rd-tag rd-warn">待生成分镜</span>' : ''}</td>
          <td class="rd-num">${num(e.shots)}</td>
          <td class="rd-num">${num(e.videoTargets)}</td>
          <td class="rd-num">${num(e.needKeyframes)}</td>
          <td class="rd-num">${num(e.needVideos)}</td>
          <td class="rd-num">${fmtSec(e.duration)}</td>
        </tr>`).join('')}</tbody>
      </table></div>
      <div class="rd-hint" style="margin-top:6px">预估值仅供参考：关键帧约 0.25 秒/张，视频按后端 ${esc(est.videoBackend || '')} 约 ${num(est.videoSecondsPerShot)} 秒/镜，分镜规划约 25 秒/集。</div>
    ` : `<div class="rd-empty rd-sm-empty">${v.busy ? '正在估算…' : '暂无估算数据'}</div>`}
  </div>

  <div class="rd-sec">
    <div class="rd-sec-t">🎁 包装设置（复用成片包装）
      <span class="rd-grow"></span>
      <button class="rd-btn rd-sm" data-pa="finish">🎁 调整包装设置</button>
    </div>
    <div class="rd-hint">${esc(finishSummary())}</div>
  </div>

  <div class="rd-sec" id="rd-pipe-prog"></div>`;
}

function updatePipeProgress(v) {
  const box = pipePanel?.box?.querySelector('#rd-pipe-prog');
  if (!box) return;
  const job = v.job;
  if (!job && !v.err) { box.innerHTML = '<div class="rd-hint">尚未开始：确认目标剧集 / 阶段 / 成本级后点右下角「▶ 开始整季生产」。</div>'; return; }
  if (v.err) { box.innerHTML = `<div class="rd-errbox">⚠️ ${esc(v.err)}</div>`; return; }
  const st = job.status || 'queued';
  const pct = Math.max(0, Math.min(100, Number(job.progress) || 0));
  const label = { queued: '排队中', running: '生产中', done: '已完成', error: '失败', canceled: '已取消' }[st] || st;
  box.innerHTML = `<div class="rd-sec-t">📡 生产进度
      <span class="rd-st ${st === 'done' ? 'rd-st-ok' : st === 'error' ? 'rd-st-err' : st === 'canceled' ? '' : 'rd-st-run'}">${label}</span>
      <span class="rd-grow"></span><span class="rd-hint">${esc(job.title || v.jobId || '')}</span>
    </div>
    <div class="rd-prog"><i style="width:${pct}%"></i></div>
    <div class="rd-job-m"><span>进度 ${num(job.done)}/${num(job.total)}</span><span>${Math.round(pct)}%</span>
      ${job.error ? `<span class="rd-err-t">${esc(String(job.error).slice(0, 80))}</span>` : ''}</div>
    ${st === 'done' ? '<div class="rd-hint" style="margin-top:6px">生产报告已弹出；若已关闭可在成片列表查看结果。</div>' : ''}`;
}

async function loadEstimate(v, draw) {
  const seq = ++v.seq;
  v.busy = true; v.estErr = '';
  draw();
  try {
    const qs = new URLSearchParams({
      scriptId: v.scriptId,
      codes: [...v.codes].join(','),
      levels: [...v.costs].join(','),
      stages: PIPE_STAGES.map(([k]) => k).filter((k) => v.stages.has(k)).join(','),
    });
    const r = await ctxRef.api.get(`/api/render/estimate?${qs.toString()}`);
    if (seq !== v.seq) return;
    v.est = r;
  } catch (e) {
    if (seq !== v.seq) return;
    v.est = null; v.estErr = e.message;
  }
  v.busy = false;
  draw();
}

function onPipeChange(e) {
  const t = e.target;
  const v = pipePanel?.view;
  if (!v || !t || !t.dataset) return;
  const key = t.dataset.pk;
  if (!key) return;
  v[key] = !!t.checked;
  if (key === 'offline' || key === 'overwrite') drawPipePanel();
}

function drawPipePanel() { if (isPanelOpen(pipePanel) && pipePanel.draw) pipePanel.draw(); }

function onPipeClick(e, v, draw) {
  const hit = e.target.closest('[data-pa]');
  if (!hit) return;
  const pa = hit.dataset.pa;
  if (pa === 'ep') {
    const c = hit.dataset.code;
    if (v.codes.has(c)) v.codes.delete(c); else v.codes.add(c);
    loadEstimate(v, draw);
    return;
  }
  if (pa === 'ep-all') { (S.scripts.find((x) => x.id === v.scriptId)?.episodes || []).forEach((e2) => v.codes.add(e2.code)); loadEstimate(v, draw); return; }
  if (pa === 'ep-none') { v.codes.clear(); loadEstimate(v, draw); return; }
  if (pa === 'ep-inv') {
    const eps = S.scripts.find((x) => x.id === v.scriptId)?.episodes || [];
    eps.forEach((e2) => { if (v.codes.has(e2.code)) v.codes.delete(e2.code); else v.codes.add(e2.code); });
    loadEstimate(v, draw);
    return;
  }
  if (pa === 'stage') {
    const k = hit.dataset.v;
    if (v.stages.has(k)) v.stages.delete(k); else v.stages.add(k);
    draw(); loadEstimate(v, draw);
    return;
  }
  if (pa === 'cost') {
    const c = hit.dataset.v;
    if (v.costs.has(c)) v.costs.delete(c); else v.costs.add(c);
    draw(); loadEstimate(v, draw);
    return;
  }
  if (pa === 'est') { loadEstimate(v, draw); return; }
  if (pa === 'finish') { openFinishPanel({}); return; }
}

async function startPipeline(v, draw) {
  if (v.busy) { toast('已有生产任务在跑，请先等待完成或取消', 'info'); return; }
  if (!v.codes.size) { toast('请至少选择一集', 'err'); return; }
  if (!v.stages.size) { toast('请至少勾选一个生产阶段', 'err'); return; }
  if (!v.stages.has('assemble') && !v.stages.has('video') && !v.stages.has('keyframe') && !v.stages.has('storyboard')) {
    toast('当前阶段组合不会产生任何结果', 'err'); return;
  }
  for (const c of v.codes) {
    if (!(await reviewPreflight(v.scriptId, c))) { toast(`已取消（${c} 未审核通过）`, 'info'); return; }
  }
  const stageNames = PIPE_STAGES.filter(([k]) => v.stages.has(k)).map(([, n]) => n).join(' → ');
  const est = v.est;
  const estText = est ? `预估：需出图 ${num(est.totals?.keyframes)} 张、需出片 ${num(est.totals?.videos)} 镜、成片总时长 ${fmtSec(est.totals?.seconds)}，约 ${num(est.estimate?.minutes)} 分钟。` : '';
  const yes = await ctxRef.confirm(
    `即将开始整季生产：\n\n剧本 ${v.scriptId}，目标 ${v.codes.size} 集（${[...v.codes].join('、')}）\n阶段：${stageNames}\n`
    + `成本级：${v.costs.size ? [...v.costs].join('/') : '全部镜头'}${v.overwrite ? '（覆盖重做）' : ''}${v.offline ? '\n分镜：离线试跑（不调用模型）' : '\n分镜：调用 LLM（可能产生费用）'}\n`
    + `包装：${finishSummary()}\n${estText}\n\n任务在后台串行执行，可随时在浮层或面板里取消。确定开始？`,
  );
  if (!yes) return;

  const body = {
    scriptId: v.scriptId,
    codes: [...v.codes],
    stages: PIPE_STAGES.map(([k]) => k).filter((k) => v.stages.has(k)),
    overwrite: !!v.overwrite,
    onlyCostLevels: [...v.costs],
    finish: finishPayload(),
  };
  if (v.offline) body.provider = 'mock';
  try {
    const r = await ctxRef.api.post('/api/render/pipeline', body);
    v.jobId = r.jobId; v.job = { status: 'queued', progress: 0, total: 0, done: 0 };
    v.busy = true; v.err = '';
    draw();
    pipePanel?.syncCancel?.();
    toast(`已提交整季生产任务：${r.episodes ?? v.codes.size} 集`, 'ok');
    trackJob(r.jobId, `🚀 整季流水线 · ${v.scriptId} · ${r.episodes ?? v.codes.size} 集`, {
      onUpdate: (job) => { v.job = job; updatePipeProgress(v); pipePanel?.syncCancel?.(); },
      onFinish: (job) => {
        v.busy = false; v.job = job; updatePipeProgress(v); pipePanel?.syncCancel?.();
        if (job?.status === 'done') showPipelineReport(job);
        else if (job?.status === 'error') toast(`整季流水线失败：${job.error || '未知错误'}`, 'err');
      },
    });
  } catch (e) {
    v.busy = false;
    v.err = `提交失败：${e.message}`;
    draw();
    toast(`整季生产提交失败：${e.message}`, 'err');
  }
}

/** 生产报告：逐集一行 + 汇总 + 成片目录 */
function showPipelineReport(job) {
  const rep = job?.result || {};
  const eps = rep.episodes || [];
  const sum = rep.summary || {};
  const films = [];
  const rows = eps.map((e) => {
    const st = e.stages || {};
    const sb = st.storyboard || {}, kf = st.keyframes || {}, vd = st.videos || {}, film = st.film || {};
    if (film.file) films.push({ code: e.code, ...film });
    const kfTxt = kf.total === undefined ? '—' : `${num(kf.total) - num(kf.failed)}/${num(kf.total)}${num(kf.skipped) ? ` · 跳过 ${num(kf.skipped)}` : ''}`;
    const vdTxt = vd.total === undefined ? '—' : `${num(vd.total) - num(vd.failed)}/${num(vd.total)}${num(vd.skipped) ? ` · 跳过 ${num(vd.skipped)}` : ''}`;
    const warn = e.error ? `<span class="rd-err-t">${esc(e.error)}</span>` : ((e.warnings || []).length ? esc(e.warnings.join('；')) : '—');
    return `<tr class="${e.error ? 'rd-rep-bad' : ''}">
      <td><b>${esc(e.code)}</b><div class="rd-hint">${esc(e.title || '')}</div></td>
      <td class="rd-num">${sb.shots === undefined ? '—' : `${num(sb.shots)} 镜${sb.skipped ? '（已存在）' : ''}`}</td>
      <td class="rd-num">${kfTxt}</td>
      <td class="rd-num">${vdTxt}</td>
      <td>${film.filmId
        ? `${fmtSec(film.duration)} · ${fmtSize(film.size)}<div class="rd-hint">${esc(SUB_MODE_NAME[film.subtitles?.mode] || '无字幕')} / ${esc(AUDIO_NAME[film.audio?.mode] || '未知音轨')}</div>`
        : '—'}</td>
      <td class="rd-num">${fmtMs(e.elapsedMs)}</td>
      <td>${warn}</td>
    </tr>`;
  }).join('');

  const body = h('div', { class: 'rd-panel' }, []);
  const began = rep.startedAt ? new Date(rep.startedAt).getTime() : 0;
  const ended = rep.finishedAt ? new Date(rep.finishedAt).getTime() : 0;
  const scriptId = job?.payload?.scriptId || S.scriptId || '';
  body.innerHTML = `
    <div class="rd-notice rd-info"><div class="rd-notice-body">
      <b>✅ 整季生产完成</b>
      <div>剧本 ${esc(scriptId)} · 目标剧集 ${num(rep.targetEpisodes?.length)} 集 · 用时 ${fmtMs(began && ended ? ended - began : sum.elapsedMs)}</div>
      <div style="margin-top:3px">集数 ${num(sum.episodes)} · 成片 ${num(sum.films)} · 失败 ${num(sum.failed)} · 新出分镜镜头 ${num(sum.shots)} · 警告 ${num(sum.warnings)}</div>
    </div></div>
    ${rep.plan ? `<div class="rd-hint">分集规划：生成 ${num(rep.plan.episodes)} 集${(rep.plan.warnings || []).length ? `（警告 ${rep.plan.warnings.length} 条）` : ''}</div>` : ''}
    <div class="rd-rep-wrap"><table class="rd-rep">
      <thead><tr><th>剧集</th><th>分镜</th><th>关键帧</th><th>视频</th><th>成片</th><th>耗时</th><th>警告 / 错误</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7">没有剧集结果（任务可能被取消）</td></tr>'}</tbody>
    </table></div>
    ${(rep.warnings || []).length ? `<div class="rd-notice" style="margin-top:8px"><div class="rd-notice-body"><b>⚠️ 汇总警告（${rep.warnings.length}）</b>
      <div style="margin-top:3px">${rep.warnings.slice(0, 12).map((w) => esc(w)).join('<br/>')}</div></div></div>` : ''}`;

  const btnClose = h('button', { class: 'rd-btn' }, ['关闭']);
  const btnDir = h('button', { class: 'rd-btn' }, ['📂 成片目录']);
  const btnRefresh = h('button', { class: 'rd-btn rd-primary' }, ['⟳ 刷新看板']);
  const m = ctxRef.modal({ title: '📋 整季生产报告', body, width: 980, footer: [btnClose, btnDir, btnRefresh] });
  btnClose.addEventListener('click', () => m.close());
  btnDir.addEventListener('click', () => openFilmFiles(films));
  btnRefresh.addEventListener('click', async () => {
    m.close();
    await loadOverview();
    if (S.epCode) await loadBoard(S.epCode, true);
    renderMain();
    toast('看板已刷新', 'ok');
  });
}

/** 成片目录（静态挂载不支持目录列表，这里列出文件并提供播放/下载与目录路径） */
function openFilmFiles(films) {
  const body = h('div', { class: 'rd-panel' }, []);
  const dirs = [...new Set(films.map((f) => String(f.file || '').split('/').slice(0, -1).join('/')).filter(Boolean))];
  body.innerHTML = `
    <div class="rd-hint">共 ${films.length} 个成片文件。静态挂载不支持目录浏览，这里直接列出文件（可播放 / 下载）；目录路径可复制后在文件管理器中打开。</div>
    <div class="rd-films-list">
      ${films.length ? films.map((f) => `<div class="rd-fitem">
        <b>${esc(f.code)}</b>
        <span class="rd-tag rd-ok">${fmtSec(f.duration)} · ${fmtSize(f.size)}</span>
        <code>${esc(f.file)}</code>
        <span class="rd-grow"></span>
        <a class="rd-btn rd-sm" href="${attr(url(f.file))}" target="_blank">▶ 播放</a>
        <a class="rd-btn rd-sm" href="${attr(url(f.file))}" download>⬇ 下载</a>
      </div>`).join('') : '<div class="rd-empty">本次运行没有产出成片文件</div>'}
    </div>
    ${dirs.length ? `<div class="rd-sec"><div class="rd-sec-t">📁 目录路径</div>
      ${dirs.map((d) => `<div class="rd-frow"><code style="font-family:var(--mono);font-size:11px;color:var(--accent-3);word-break:break-all">${esc(d)}</code>
        <button class="rd-btn rd-sm" data-copy="${attr(d)}">复制路径</button></div>`).join('')}</div>` : ''}`;
  body.addEventListener('click', (e) => {
    const hit = e.target.closest('[data-copy]');
    if (hit) copyText(hit.dataset.copy, '目录路径');
  });
  ctxRef.modal({ title: '📂 成片目录', body, width: 820 });
}

// ---------------- 定时排产（T-402 ③：/api/schedules*） ----------------
/** 排产类型中文名（与后端 src/schedules.js 的 SCHEDULE_KINDS 一一对应） */
const SCHEDULE_KIND_NAME = { once: '仅一次', interval: '按间隔', daily: '每天', weekly: '每周', monthly: '每月', cron: 'cron 表达式' };
const SCHEDULE_MODE_NAME = { new_production: '新建制片项目', existing_production: '已有制片项目' };

/** 排产表单默认值（时区留空 = 用服务端默认时区） */
function scheduleDraft() {
  return {
    name: '', kind: 'daily', at_time: '09:00', weekdays: '1', day_of_month: 1,
    once_at: '', cron: '0 9 * * *', interval_minutes: 60, tz: '',
    mode: 'new_production', brief: '', productionId: '',
  };
}

/** 按类型拼请求体（字段名与后端 schedules 表一致，snake_case） */
function schedulePayload(f) {
  const out = {
    name: String(f.name || '').trim(), kind: f.kind, mode: f.mode,
    target: f.mode === 'existing_production'
      ? { productionId: String(f.productionId || '').trim() }
      : { brief: String(f.brief || '').trim() },
  };
  if (f.tz) out.tz = String(f.tz).trim();
  if (f.kind === 'once') out.once_at = String(f.once_at || '').trim();
  if (f.kind === 'interval') out.interval_minutes = Number(f.interval_minutes) || 0;
  if (f.kind === 'daily' || f.kind === 'weekly' || f.kind === 'monthly') out.at_time = String(f.at_time || '').trim();
  if (f.kind === 'weekly') out.weekdays = String(f.weekdays || '').trim();
  if (f.kind === 'monthly') out.day_of_month = Number(f.day_of_month) || 0;
  if (f.kind === 'cron') out.cron = String(f.cron || '').trim();
  return out;
}

/**
 * 「⏰ 排产」面板：列出 / 新建 / 启停（全部走 /api/schedules*）。
 * 只读列表与启停是零成本操作；「试算下次触发」走 /api/schedules/preview（dry-run，不落库不入队）。
 * 真正的触发仍由服务端定时器 + 暂停/预算/磁盘闸门决定，界面不做任何绕过。
 */
function openSchedulesPanel() {
  const f = scheduleDraft();
  const listBox = h('div', {});
  const noteBox = h('div', { class: 'rd-sub', style: { marginTop: '6px' } });
  // 接口可用性：服务若启动早于「定时排产」上线，/api/schedules* 还没注册（静态兜底会返回首页 HTML），
  // 必须明说「接口未就绪 + 下一步」，不能让界面假装「还没有排产」。
  const ready = { ok: null };
  const mk = (label, input) => h('label', { class: 'rd-row', style: { gap: '6px', marginBottom: '6px', alignItems: 'center' } }, [
    h('span', { class: 'rd-sub', style: { minWidth: '96px' } }, [label]), input,
  ]);
  const inp = (ph, width = 150) => h('input', { type: 'text', placeholder: ph, style: { width: `${width}px`, background: 'var(--panel-2)', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: '7px', padding: '5px 7px' } });
  const sel = (opts, value) => {
    const s = h('select', { style: { background: 'var(--panel-2)', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: '7px', padding: '5px 7px' } });
    for (const [v, t] of opts) s.append(h('option', { value: v, selected: v === value }, [t]));
    s.addEventListener('change', () => { s.dataset.value = s.value; });
    s.dataset.value = value;
    return s;
  };
  // ---- 新建表单 ----
  const nameIn = inp('例如：每日 09:00 自动出片', 220);
  const kindSel = sel(Object.entries(SCHEDULE_KIND_NAME), f.kind);
  const tzIn = inp('留空=服务端默认时区', 150);
  const modeSel = sel(Object.entries(SCHEDULE_MODE_NAME), f.mode);
  const briefIn = inp('一句话需求（mode=新建制片项目时必填）', 300);
  const pidIn = inp('制片项目 ID，如 PR-xxxx', 200);
  const atIn = inp('HH:MM，如 09:00', 110);
  const weekIn = inp('0~6，0=周日，如 1,3,5', 130);
  const domIn = inp('1~31', 80);
  const onceIn = inp('YYYY-MM-DD HH:MM', 160);
  const cronIn = inp('分 时 日 月 周，如 0 9 * * *', 170);
  const intervalIn = inp('1~10080 分钟', 120);
  // 每个类型一行写成「工厂函数」：同一个输入框会在多个类型里复用（每天/每周/每月共用 atIn），
  // 若预先建好整行再分别塞进多行，DOM 里同一节点只会留在**最后一个**位置（前面的行会变成空 label）。
  // 因此每次渲染都新建外层 label，把输入框搬到当前这一行。
  const kindRows = {
    daily: () => h('div', {}, [mk('每天时刻', atIn)]),
    weekly: () => h('div', {}, [mk('每周时刻', atIn), mk('星期几', weekIn)]),
    monthly: () => h('div', {}, [mk('每月时刻', atIn), mk('每月几号', domIn)]),
    once: () => h('div', {}, [mk('触发时刻', onceIn)]),
    cron: () => h('div', {}, [mk('cron 表达式', cronIn)]),
    interval: () => h('div', {}, [mk('间隔（分钟）', intervalIn)]),
  };
  const kindSlot = h('div', {});
  const modeSlot = h('div', {});
  const drawKind = () => {
    kindSlot.innerHTML = '';
    kindSlot.append((kindRows[kindSel.value] || kindRows.daily)());
    modeSlot.innerHTML = '';
    modeSlot.append(modeSel.value === 'existing_production' ? mk('制片项目', pidIn) : mk('一句话需求', briefIn));
  };
  kindSel.addEventListener('change', drawKind);
  modeSel.addEventListener('change', drawKind);
  drawKind();

  const collect = () => ({
    ...f,
    name: nameIn.value, kind: kindSel.value, tz: tzIn.value, mode: modeSel.value,
    brief: briefIn.value, productionId: pidIn.value, at_time: atIn.value, weekdays: weekIn.value,
    day_of_month: domIn.value, once_at: onceIn.value, cron: cronIn.value, interval_minutes: intervalIn.value,
  });

  const createBtn = h('button', { class: 'rd-btn rd-primary', onclick: () => saveSchedule() }, ['✓ 创建排产']);
  const previewBtn = h('button', { class: 'rd-btn', onclick: () => previewSchedule() }, ['🔎 试算下次触发（不落库）']);
  const form = h('div', { class: 'rd-card', style: { marginTop: '10px' } }, [
    h('div', { class: 'rd-sec-t' }, ['＋ 新建排产（中文必填校验由服务端给出）']),
    mk('名称', nameIn),
    mk('类型', kindSel),
    kindSlot,
    mk('模式', modeSel),
    modeSlot,
    mk('时区', tzIn),
    h('div', { class: 'rd-row', style: { marginTop: '8px' } }, [
      createBtn,
      previewBtn,
      h('button', { class: 'rd-btn', onclick: () => { const d = scheduleDraft(); nameIn.value = d.name; tzIn.value = d.tz; briefIn.value = ''; pidIn.value = ''; noteBox.textContent = '已重置表单'; } }, ['⟲ 重置']),
    ]),
    noteBox,
  ]);

  const body = h('div', { style: { maxHeight: '70vh', overflow: 'auto' } }, [
    h('div', { class: 'rd-sub' }, ['定时排产：到点自动推进制片流水线（新建项目或推进已有项目）。停用/启用、暂停队列、月度预算与磁盘闸门都由服务端把关，界面不绕过任何闸门。']),
    h('div', { class: 'rd-sec-t', style: { marginTop: '10px' } }, ['📋 现有排产']),
    listBox,
    form,
  ]);

  const modalRef = ctxRef.modal({ title: '⏰ 定时排产', body, width: 900, footer: [h('button', { class: 'rd-btn', onclick: () => { load(); } }, ['⟳ 刷新']), h('button', { class: 'rd-btn', onclick: () => modalRef.close() }, ['关闭'])] });

  async function load() {
    listBox.innerHTML = '';
    listBox.append(h('div', { class: 'rd-sub' }, ['正在读取排产…']));
    try {
      const r = await ctxRef.api.get('/api/schedules');
      if (!Array.isArray(r.schedules)) throw new Error('接口返回的不是排产列表（服务端可能还没注册 /api/schedules）');
      ready.ok = true;
      createBtn.disabled = false;
      previewBtn.disabled = false;
      const rows = r.schedules;
      listBox.innerHTML = '';
      if (!rows.length) {
        listBox.append(h('div', { class: 'rd-empty' }, ['还没有排产：在下面「＋ 新建排产」里填名称与触发规则即可（例如每天 09:00）。']));
      }
      for (const s of rows) {
        const on = Number(s.enabled) !== 0;
        listBox.append(h('div', { class: 'rd-card', style: { marginTop: '6px', padding: '10px' } }, [
          h('div', { class: 'rd-row', style: { alignItems: 'baseline' } }, [
            h('b', {}, [s.name || s.id]),
            h('span', { class: `rd-tag ${on ? 'rd-ok' : ''}` }, [on ? '已启用' : '已停用']),
            h('span', { class: 'rd-tag' }, [SCHEDULE_KIND_NAME[s.kind] || s.kind]),
            h('span', { class: 'rd-tag' }, [SCHEDULE_MODE_NAME[s.mode] || s.mode]),
            h('span', { class: 'rd-grow' }),
            h('button', { class: 'rd-btn rd-sm', onclick: () => toggleSchedule(s, !on) }, [on ? '⏸ 停用' : '▶ 启用']),
            h('button', { class: 'rd-btn rd-sm', onclick: () => { previewSchedule(s); } }, ['🔎 试算']),
            h('a', { class: 'rd-btn rd-sm', href: `/api/schedules/runs?scheduleId=${encodeURIComponent(s.id)}`, target: '_blank' }, ['触发历史']),
          ]),
          h('div', { class: 'rd-sub', style: { marginTop: '4px' } }, [s.summary || '（无摘要）']),
          h('div', { class: 'rd-sub' }, [
            `下次：${s.next_run_text || '无未来窗口'}`
            + ` · 已触发 ${num(s.fire_count)} 次 · 跳过 ${num(s.skip_count)} · 漏跑 ${num(s.miss_count)}`
            + (s.running ? ' · 正在执行' : '')
            + (s.status_text ? ` · 上次：${s.status_text}` : ''),
          ]),
          (s.target?.brief ? h('div', { class: 'rd-sub' }, [`目标需求：${s.target.brief}`]) : null),
        ]));
      }
      const sc = r.scheduler || {};
      listBox.append(h('div', { class: 'rd-sub', style: { marginTop: '8px' } }, [
        `调度器：${sc.running ? '运行中' : '未运行'} · 每 ${num(sc.tickSeconds) || '-'} 秒一轮 · 排产总开关 ${r.enabled === false ? '已关闭' : '已开启'}`,
      ]));
    } catch (e) {
      ready.ok = false;
      createBtn.disabled = true;
      previewBtn.disabled = true;
      listBox.innerHTML = '';
      listBox.append(h('div', { class: 'rd-notice' }, [
        h('div', { class: 'rd-notice-body' }, [
          h('b', {}, [`⏰ 排产接口未就绪：${e.message}`]),
          h('div', { class: 'rd-sub' }, [
            '排产接口（/api/schedules*）是服务启动时注册的：如果当前服务进程启动早于这次上线，这里就会读不到。',
            '请在服务端重启一次服务（本页不代劳、也不绕过任何闸门），随后点「⟳ 刷新」即可用。',
          ]),
        ]),
      ]));
    }
  }

  async function toggleSchedule(s, wantEnabled) {
    try {
      const r = await ctxRef.api.raw('PATCH', '/api/schedules/' + encodeURIComponent(s.id), { enabled: wantEnabled, by: 'human' });
      toast(`${s.name || s.id} 已${wantEnabled ? '启用' : '停用'}${r?.note ? `：${r.note}` : ''}`, 'ok', 3200);
      load();
      if (S.scriptId && S.epCode) loadBoard(S.epCode, true); else loadOverview();
    } catch (e) { toast(`启停失败：${e.message}`, 'err'); }
  }

  async function previewSchedule(s) {
    const draft = s ? {
      kind: s.kind, tz: s.tz, at_time: s.at_time, weekdays: s.weekdays,
      day_of_month: s.day_of_month, once_at: s.once_at, cron: s.cron, interval_minutes: s.interval_minutes,
    } : schedulePayload(collect());
    try {
      const r = await ctxRef.api.post('/api/schedules/preview', { schedule: draft, count: 3 });
      const lines = (r.runs || []).map((x, i) => `${i + 1}. ${x.text || x.at || x}`).join('\n');
      noteBox.textContent = r.runs?.length ? `未来 ${r.runs.length} 次触发：\n${lines}` : (r.note || '按当前规则算不出未来触发时刻：请检查时刻/cron 写法');
      toast(r.runs?.length ? `试算成功：未来 ${r.runs.length} 次触发已列出（未落库）` : '试算无结果：请检查触发表达式', r.runs?.length ? 'ok' : 'warn', 3600);
    } catch (e) { noteBox.textContent = `试算失败：${e.message}`; toast(`试算失败：${e.message}`, 'err'); }
  }

  async function saveSchedule() {
    const payload = schedulePayload(collect());
    if (!payload.name) { toast('请先填排产名称（≤60 字）', 'warn'); return; }
    try {
      const r = await ctxRef.api.post('/api/schedules', payload);
      toast(`排产「${r.schedule?.name || payload.name}」已创建${r.next_run_text ? `，下次触发 ${r.next_run_text}` : ''}`, 'ok', 4200);
      nameIn.value = ''; briefIn.value = '';
      load();
    } catch (e) { toast(`创建失败：${e.message}`, 'err', 5200); }
  }

  load();
}

// ---------------- 事件 ----------------
function onClick(e) {
  if (!S || !root) return;
  const hit = e.target.closest('[data-act]');
  if (!hit || !root.contains(hit)) return;
  const act = hit.dataset.act;
  const shotId = hit.dataset.shot;
  const board = () => S.board || { shots: [] };
  const shotById = (id) => board().shots.find((s) => s.id === id);

  switch (act) {
    case 'refresh':
      loadOverview();
      toast('已刷新', 'ok');
      break;
    case 'del-film': {
      const id = hit.dataset.film;
      (async () => {
        if (!(await ctxRef.confirm(`删除这部成片？记录与 mp4 文件都会被删除，已生成的关键帧/镜头视频不受影响。\n\n${id}`))) return;
        try {
          await ctxRef.api.del('/api/render/films/' + encodeURIComponent(id));
          toast('成片已删除', 'ok');
          if (S.scriptId && S.epCode) loadBoard(S.epCode, true); else loadOverview();
        } catch (err) { toast('删除失败：' + err.message, 'err'); }
      })();
      break;
    }
    case 'cleanup': {
      (async () => {
        if (!(await ctxRef.confirm('清理封装中间产物（合并/字幕/淡入淡出的临时 mp4 与 concat 清单）？最终成片会保留。'))) return;
        try {
          const r = await ctxRef.api.post('/api/render/cleanup', {});
          toast(`已清理 ${r.removed} 个中间文件，释放 ${r.freedMB} MB`, 'ok');
        } catch (err) { toast('清理失败：' + err.message, 'err'); }
      })();
      break;
    }
    case 'toggle-script': {
      const id = hit.dataset.id;
      S.expanded = S.expanded === id ? null : id;
      renderSide();
      loadReviews(id).then(() => { if (S) renderSide(); });
      break;
    }
    case 'go-script': {
      // 两条成片线收敛：制作台负责批量出片，剧本工厂负责审核/改词/配平
      ctxRef.go('script');
      break;
    }
    case 'go-actors': {
      // 画布负责资产精修：角色/环境、九宫格、一致性体检
      ctxRef.go('actors');
      break;
    }
    case 'script': {
      const id = hit.dataset.id;
      if (S.scriptId === id) {                 // 已选中的项目：只保证展开，不收起（收起请点左侧箭头）
        if (S.expanded !== id) { S.expanded = id; renderSide(); }
        return;
      }
      S.scriptId = id; S.expanded = id; S.epCode = null; S.board = null;
      const sc = S.scripts.find((x) => x.id === id);
      const eps = sc?.episodes || [];
      const pick = eps.find((x) => (x.shot_count || 0) > 0) || eps[0];
      if (pick) loadBoard(pick.code, true); else { renderSide(); renderMain(); }
      break;
    }
    case 'ep':
      S.scriptId = hit.dataset.id;
      S.expanded = hit.dataset.id;
      loadBoard(hit.dataset.code, false);
      break;
    case 'filter':
      S.filter = hit.dataset.f;
      S.limit = PAGE_SIZE;
      renderMain();
      break;
    case 'cost': {
      const c = hit.dataset.c;
      if (S.costs.has(c)) S.costs.delete(c); else S.costs.add(c);
      S.limit = PAGE_SIZE;
      renderMain();
      break;
    }
    case 'scale':
      S.motionScale = Number(hit.dataset.m) || 1;
      renderMain();
      break;
    case 'sel-all':
      filteredShots().forEach((s) => S.selected.add(s.id));
      renderMain();
      break;
    case 'sel-inv': {
      const next = new Set(S.selected);
      filteredShots().forEach((s) => { if (next.has(s.id)) next.delete(s.id); else next.add(s.id); });
      S.selected = next;
      renderMain();
      break;
    }
    case 'sel-none':
      S.selected = new Set();
      renderMain();
      break;
    case 'more':
      S.limit += PAGE_SIZE;
      renderMain();
      break;
    case 'kf-all':
      runKeyframes([]);
      break;
    case 'kf-sel':
      if (!S.selected.size) { toast('请先勾选镜头（或直接点「渲染本集关键帧」处理整集）', 'info'); return; }
      runKeyframes([...S.selected]);
      break;
    case 'kf-one':
      runKeyframes([shotId], { single: true });
      break;
    case 'vid-all':
      runVideos([]);
      break;
    case 'vid-sel':
      if (!S.selected.size) { toast('请先勾选镜头（或直接点「生成本集视频」处理整集）', 'info'); return; }
      runVideos([...S.selected]);
      break;
    case 'vid-one':
      runVideos([shotId], { single: true });
      break;
    case 'last-panel':
      openLastFramePanel([...S.selected]);
      break;
    case 'last-one':
      openLastFramePanel([shotId]);
      break;
    case 'assemble':
      runAssemble();
      break;
    case 'finish-panel':
      openFinishPanel({});
      break;
    case 'pipeline-panel':
      openPipelinePanel();
      break;
    case 'schedules':
      openSchedulesPanel();
      break;
    case 'toggle-overwrite':
      S.overwrite = !S.overwrite;
      renderMain();
      toast(S.overwrite ? '已开启「重做（覆盖）」：已存在的关键帧/视频会重新生成' : '已关闭「重做（覆盖）」：已存在的将被跳过', 'info');
      break;
    case 'export-csv':
      exportEpisode('csv');
      break;
    case 'export-json':
      exportEpisode('json');
      break;
    case 'publish':
      openPublishKit();
      break;
    case 'variants':
      showVariants();
      break;
    case 'export-timeline':
      exportInterchange('timeline');
      break;
    case 'import-timeline':
      openTimelineImport();
      break;
    case 'export-subs':
      exportInterchange('subtitle');
      break;
    case 'backend-fit':
      showBackendFit();
      break;
    case 'consistency':
      showConsistency();
      break;
    case 'qc':
      runEpisodeQc();
      break;
    case 'stats':
      showProductionStats();
      break;
    case 'deliver':
      deliverPackage();
      break;
    case 'retry-failed':
      retryFailedShots();
      break;
    case 'guard-status':
      showGuardStatus();
      break;
    case 'probe':
      probeBackend();
      break;
    case 'test-video':
      doTestVideo();
      break;
    case 'backend-info':
      backendInfo(hit.dataset.kind);
      break;
    case 'go-settings':
      ctxRef.go('settings');
      break;
    case 'copy-prompt': {
      const s = shotById(shotId);
      if (s) copyText(s.prompt_pos, `镜 #${s.idx} 英文提示词`);
      break;
    }
    case 'preview': {
      const s = shotById(shotId);
      previewMedia(hit.dataset.src, 'image', s ? `镜 #${s.idx} 关键帧` : '关键帧');
      break;
    }
    case 'versions': {
      const s = shotById(shotId);
      if (s) openVersions(s);
      break;
    }
    case 'del-renders': {
      const s = shotById(shotId);
      if (s) deleteRenders(s);
      break;
    }
    case 'retry': {
      const s = shotById(shotId);
      if (!s) break;
      const failedVideo = (s.videos || []).some((r) => r.status === 'error');
      if (failedVideo) runVideos([s.id], { single: true });
      else runKeyframes([s.id], { single: true });
      break;
    }
    case 'films-toggle':
      if (S.showAllFilms) { S.showAllFilms = false; renderMain(); }
      else loadAllFilms();
      break;
    case 'cancel-job':
      cancelJob(hit.dataset.job);
      break;
    case 'close-job':
      S.jobs = S.jobs.filter((x) => x.jobId !== hit.dataset.job);
      renderJobs();
      break;
    default:
      break;
  }
}

function onChange(e) {
  if (!S) return;
  const t = e.target;
  if (t && t.classList && t.classList.contains('rd-ck')) {
    const id = t.dataset.shot;
    if (t.checked) S.selected.add(id); else S.selected.delete(id);
    const card = t.closest('.rd-shot');
    if (card) card.classList.toggle('rd-sel', t.checked);
    const cnt = q('#rd-selcount');
    if (cnt) cnt.textContent = String(S.selected.size);
  }
}
