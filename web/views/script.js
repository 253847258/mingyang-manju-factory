// 模块3 前端：剧本 / 分镜工厂（小说 → 分集规划 → 单集剧本 → 分镜表 → 导出）
// 约定：只使用 ctx.api / ctx.meta / ctx.toast / ctx.confirm / ctx.modal / ctx.watchJob / ctx.go
// 类名统一 sc- 前缀，样式自行注入

const STYLE_ID = 'sc-style';
let S = null;              // 视图状态
let stops = [];            // watchJob 停止函数
let root = null;
let ctxRef = null;

// ---------------- 兜底字典（ctx.meta 可能为 null） ----------------
const FB_STYLES = [
  { id: 'jp-anime', name: '日系赛璐璐动漫' }, { id: 'cn-guofeng', name: '国漫古风厚涂' },
  { id: 'kr-webtoon', name: '韩漫唯美条漫' }, { id: 'us-comic', name: '美漫硬朗线稿' },
  { id: 'pixar-3d', name: '3D 动画电影' }, { id: 'cinematic-real', name: '写实电影感' },
  { id: 'cyberpunk', name: '赛博朋克霓虹' }, { id: 'ink-wash', name: '水墨国风' },
  { id: 'retro-cel', name: '复古赛璐璐' }, { id: 'dark-gothic', name: '暗黑哥特奇幻' },
];
const FB_FORMATS = [
  { id: 'manju', name: '竖屏漫剧（1-3 分钟/集）', defaultEpisodeSeconds: 120, defaultEpisodes: 100 },
  { id: 'movie', name: '电影长片（90-120 分钟）', defaultEpisodeSeconds: 5400, defaultEpisodes: 1 },
  { id: 'tv', name: '横屏电视剧/网剧（40-45 分钟/集）', defaultEpisodeSeconds: 2600, defaultEpisodes: 24 },
  { id: 'short', name: '短视频切片（30-60 秒）', defaultEpisodeSeconds: 45, defaultEpisodes: 200 },
];
const FB = {
  shotSizes: ['大远景', '远景', '全景', '中全景', '中景', '中近景', '近景', '特写', '大特写', '过肩', '主观视角', '航拍'],
  cameraAngles: ['平视', '俯拍', '仰拍', '鸟瞰', '蚁视', '过肩', '主观', '侧拍', '背拍', '斜角', '低机位', '高机位'],
  cameraMoves: ['固定', '推镜', '拉镜', '摇镜', '移镜', '跟拍', '升降', '环绕', '手持晃动', '变焦', '甩镜', '希区柯克变焦'],
  transitions: ['硬切', '淡入', '淡出', '叠化', '黑场', '白闪', '划像', '甩切', '闪回', '匹配剪辑', '跳切'],
  moodList: ['平静', '紧张', '压抑', '热血', '悲伤', '恐惧', '温情', '浪漫', '荒诞', '愤怒', '震惊', '释然'],
  timesOfDay: ['清晨', '白天', '正午', '黄昏', '夜晚', '深夜', '黎明', '不限'],
  costLevels: ['L 静态+运镜', 'M 局部动效', 'H 全动态'],
};
const DURATION_PRESETS = [
  { label: '30 秒', v: 30 }, { label: '60 秒', v: 60 }, { label: '120 秒', v: 120 }, { label: '180 秒', v: 180 },
  { label: '40 分钟', v: 2400 }, { label: '90 分钟', v: 5400 },
];

// ---------------- 小工具 ----------------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtSec = (s) => {
  const n = Number(s) || 0;
  if (n >= 3600) { const h = Math.floor(n / 3600); const m = Math.round((n % 3600) / 60); return `${h}h${m}m`; }
  if (n >= 60) { const m = Math.floor(n / 60); const sec = Math.round(n % 60); return sec ? `${m}m${sec}s` : `${m}m`; }
  return `${Number(n.toFixed(1))}s`;
};
const q = (sel) => root.querySelector(sel);
const qa = (sel) => Array.from(root.querySelectorAll(sel));
const attr = (s) => esc(s);
const vocab = () => (S.vocab || {});
const listOf = (key, fallbackKey) => vocab()[key] || FB[fallbackKey] || [];
const REVIEW_LABELS = { draft: '草稿', review: '待审', approved: '已通过', locked: '已锁定' };
const REVIEW_CLASS = { draft: 'sc-draft', review: 'sc-review', approved: 'sc-approved', locked: 'sc-locked' };
const reviewTag = (status) => {
  const s = REVIEW_LABELS[status] ? status : 'draft';
  return `<span class="sc-tag ${REVIEW_CLASS[s]}">${REVIEW_LABELS[s]}</span>`;
};

// ---------------- 样式 ----------------
const CSS = `
.sc-wrap { display:flex; gap:14px; height:100%; min-height:0; color:var(--text); }
.sc-side { width:290px; flex:0 0 290px; display:flex; flex-direction:column; gap:8px; background:var(--panel); border:1px solid var(--line); border-radius:var(--radius); padding:12px; min-height:0; }
.sc-side-head { display:flex; align-items:center; justify-content:space-between; gap:8px; }
.sc-side-title { font-size:15px; font-weight:700; letter-spacing:.5px; }
.sc-side-sub { font-size:11px; color:var(--muted); }
.sc-list { flex:1; overflow:auto; display:flex; flex-direction:column; gap:6px; margin-top:4px; }
.sc-item { border:1px solid var(--line); background:var(--panel-2); border-radius:8px; padding:8px 10px; cursor:pointer; transition:.15s; }
.sc-item:hover { border-color:var(--accent); }
.sc-item.sc-on { border-color:var(--accent); background:linear-gradient(90deg, rgba(80,140,255,.16), transparent); }
.sc-item-t { font-size:13px; font-weight:600; display:flex; justify-content:space-between; gap:6px; }
.sc-item-m { font-size:11px; color:var(--muted); margin-top:3px; display:flex; gap:8px; flex-wrap:wrap; }
.sc-main { flex:1; min-width:0; display:flex; flex-direction:column; gap:12px; overflow:auto; padding-right:2px; }
.sc-card { background:var(--panel); border:1px solid var(--line); border-radius:var(--radius); padding:12px 14px; }
.sc-stage-h { display:flex; align-items:center; gap:8px; margin-bottom:10px; }
.sc-step { width:22px; height:22px; border-radius:50%; background:var(--accent); color:#fff; font-size:12px; display:flex; align-items:center; justify-content:center; font-weight:700; }
.sc-stage-h h3 { font-size:14px; margin:0; font-weight:700; }
.sc-stage-h .sc-hint { font-size:11px; color:var(--muted); margin-left:auto; }
.sc-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(210px,1fr)); gap:10px; }
.sc-field { display:flex; flex-direction:column; gap:4px; }
.sc-field > label { font-size:11px; color:var(--muted); }
.sc-input, .sc-select, .sc-textarea { background:var(--panel-2); border:1px solid var(--line); color:var(--text); border-radius:7px; padding:6px 8px; font-size:12.5px; width:100%; box-sizing:border-box; font-family:inherit; }
.sc-input:focus, .sc-select:focus, .sc-textarea:focus { outline:none; border-color:var(--accent); }
.sc-textarea { min-height:64px; resize:vertical; }
.sc-btn { background:var(--panel-2); border:1px solid var(--line); color:var(--text); border-radius:7px; padding:6px 11px; font-size:12.5px; cursor:pointer; transition:.15s; font-family:inherit; }
.sc-btn:hover { border-color:var(--accent); color:var(--accent); }
.sc-btn:disabled { opacity:.5; cursor:not-allowed; }
.sc-btn.sc-primary { background:var(--accent); border-color:var(--accent); color:#fff; }
.sc-btn.sc-primary:hover { filter:brightness(1.1); color:#fff; }
.sc-btn.sc-danger:hover { border-color:var(--err); color:var(--err); }
.sc-btn.sc-sm { padding:3px 8px; font-size:11.5px; }
.sc-row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
.sc-chips { display:flex; gap:6px; flex-wrap:wrap; }
.sc-chip { border:1px solid var(--line); background:var(--panel-2); border-radius:999px; padding:3px 10px; font-size:11.5px; cursor:pointer; }
.sc-chip.sc-on { border-color:var(--accent); color:var(--accent); background:rgba(80,140,255,.12); }
.sc-tag { font-size:10.5px; padding:1px 7px; border-radius:999px; border:1px solid var(--line); color:var(--muted); white-space:nowrap; }
.sc-tag.sc-ok { color:var(--ok); border-color:var(--ok); }
.sc-tag.sc-warn { color:var(--warn); border-color:var(--warn); }
.sc-tag.sc-err { color:var(--err); border-color:var(--err); }
.sc-tag.sc-acc { color:var(--accent); border-color:var(--accent); }
.sc-tbl-wrap { overflow:auto; border:1px solid var(--line); border-radius:8px; max-height:62vh; }
table.sc-tbl { width:100%; border-collapse:collapse; font-size:12px; }
table.sc-tbl th { position:sticky; top:0; background:var(--panel-2); text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); font-weight:600; font-size:11.5px; color:var(--muted); white-space:nowrap; z-index:1; }
table.sc-tbl td { padding:5px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
table.sc-tbl tr:hover td { background:rgba(255,255,255,.02); }
table.sc-tbl tr.sc-over td { background:rgba(255,90,90,.07); }
.sc-prompt { max-width:320px; font-size:11px; color:var(--muted); line-height:1.35; word-break:break-word; }
.sc-shot-cards { display:grid; grid-template-columns:repeat(auto-fill,minmax(255px,1fr)); gap:10px; }
.sc-shot { border:1px solid var(--line); background:var(--panel-2); border-radius:9px; padding:9px 10px; display:flex; flex-direction:column; gap:6px; }
.sc-shot.sc-over { border-color:var(--err); }
.sc-shot-h { display:flex; align-items:center; gap:6px; font-size:11.5px; color:var(--muted); flex-wrap:wrap; }
.sc-shot-h b { color:var(--text); font-size:12.5px; }
.sc-shot-body { font-size:12px; line-height:1.5; }
.sc-shot-dlg { color:var(--accent-2); }
.sc-shot-p { font-size:10.5px; color:var(--muted); background:rgba(0,0,0,.18); border-radius:6px; padding:5px 6px; max-height:76px; overflow:auto; word-break:break-word; }
.sc-empty { color:var(--muted); font-size:12px; padding:14px; text-align:center; border:1px dashed var(--line); border-radius:8px; }
.sc-prog { height:5px; background:var(--panel-2); border-radius:999px; overflow:hidden; margin-top:6px; }
.sc-prog > i { display:block; height:100%; background:var(--accent); width:0; transition:width .3s; }
.sc-job { font-size:11.5px; color:var(--muted); display:flex; justify-content:space-between; gap:8px; }
.sc-mono { font-family:ui-monospace, Menlo, Consolas, monospace; font-size:11px; color:var(--muted); }
.sc-tabs { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.sc-stat { display:flex; gap:14px; flex-wrap:wrap; font-size:11.5px; color:var(--muted); }
.sc-stat b { color:var(--text); font-size:13px; }
.sc-split { height:1px; background:var(--line); margin:10px 0; }
.sc-md { font-size:12px; line-height:1.6; white-space:pre-wrap; max-height:60vh; overflow:auto; background:var(--panel-2); border:1px solid var(--line); border-radius:8px; padding:10px; }
.sc-drop { border:1px dashed var(--line); border-radius:8px; padding:8px 10px; font-size:11.5px; color:var(--muted); display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.sc-inline { display:flex; gap:6px; align-items:center; }
.sc-warnbox { font-size:11.5px; color:var(--warn); border:1px solid var(--warn); border-radius:8px; padding:6px 9px; margin-top:8px; background:rgba(255,190,60,.06); }
.sc-tag.sc-review { color:#f5a623; border-color:#f5a623; }
.sc-tag.sc-draft { color:var(--muted); }
.sc-tag.sc-approved { color:var(--ok); border-color:var(--ok); }
.sc-tag.sc-locked { color:var(--accent); border-color:var(--accent); }
.sc-pager { display:flex; gap:8px; align-items:center; justify-content:flex-end; margin-top:8px; font-size:11.5px; color:var(--muted); flex-wrap:wrap; }
.sc-pager .sc-page-info { margin-right:auto; }
`;

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

// ---------------- 入口 ----------------
export function mount(el, ctx) {
  root = el;
  ctxRef = ctx;
  stops.forEach((f) => { try { f(); } catch { /* ignore */ } });
  stops = [];
  injectStyle();
  S = {
    scripts: [], current: null, episodes: [], shots: [], episodeCode: '',
    view: 'table', loading: false, vocab: null, skills: null, novels: [], novelsOk: true,
    jobs: {}, form: null, warnings: [], shotPage: 0, shotPageSize: 50, review: null,
  };
  root.innerHTML = `<div class="sc-wrap"><div class="sc-side"><div class="sc-side-sub">加载中…</div></div><div class="sc-main"></div></div>`;
  render();
  root.addEventListener('click', onClick);
  root.addEventListener('change', onChange);
  loadVocabAndNovels();
  loadScripts();
}

export function unmount() {
  stops.forEach((f) => { try { f(); } catch { /* ignore */ } });
  stops = [];
  if (root) {
    root.removeEventListener('click', onClick);
    root.removeEventListener('change', onChange);
  }
  S = null; root = null; ctxRef = null;
}

// ---------------- 数据加载 ----------------
async function loadVocabAndNovels() {
  try {
    const r = await ctxRef.api.get('/api/script-skills');
    S.skills = r;
    S.vocab = {
      shot_sizes: r.vocab?.shot_sizes, camera_moves: r.vocab?.camera_moves, camera_angles: r.vocab?.camera_angles,
      transitions: r.vocab?.transitions, times_of_day: r.vocab?.times_of_day, moods: r.vocab?.moods, cost_levels: r.vocab?.cost_levels,
    };
  } catch (e) { /* 用兜底字典 */ }
  try {
    const r = await ctxRef.api.get('/api/novels');
    S.novels = r.novels || [];
    S.novelsOk = true;
  } catch (e) {
    S.novelsOk = false;
  }
  render();
}

async function loadScripts(keepId) {
  try {
    const r = await ctxRef.api.get('/api/scripts');
    S.scripts = r.scripts || [];
    const want = keepId || S.current?.id;
    if (want && S.scripts.some((s) => s.id === want)) await selectScript(want, true);
    else if (S.current?.id && !S.scripts.some((s) => s.id === S.current.id)) { S.current = null; S.episodes = []; S.shots = []; }
    render();
  } catch (e) {
    ctxRef.toast(`剧本列表加载失败：${e.message}`, 'err');
    render();
  }
}

async function selectScript(id, silent) {
  try {
    S.loading = true;
    const r = await ctxRef.api.get(`/api/scripts/${id}`);
    S.current = r.script;
    S.episodes = r.script.episodes || [];
    S.shotPage = 0;
    S.form = {
      novelId: r.script.novel_id || '', format: r.script.format || 'manju', styleId: r.script.style_id || 'jp-anime',
      episodeSeconds: r.script.episode_seconds || 120, episodesPerSeason: r.script.episodes_per_season || 100,
      seasons: r.script.seasons || 1, title: r.script.title || '',
      skillDocPath: r.script.skill_doc_path || '', skillDocName: r.script.skill_doc_name || '',
      instruction: '', overwrite: false,
    };
    S.warnings = [];
    const code = S.episodeCode && S.episodes.some((e) => e.code === S.episodeCode) ? S.episodeCode : (S.episodes[0]?.code || '');
    S.episodeCode = code;
    S.loading = false;
    await loadReview();
    if (code) await loadEpisodeShots(code, true);
    render();
  } catch (e) {
    S.loading = false;
    ctxRef.toast(`剧本详情加载失败：${e.message}`, 'err');
    render();
  }
}

async function loadEpisodeShots(code, silent) {
  if (!S.current || !code) { S.shots = []; render(); return; }
  try {
    const r = await ctxRef.api.get(`/api/scripts/${S.current.id}/episodes/${code}`);
    S.shots = r.shots || [];
    S.episodeDetail = r.episode;
    S.episodeCode = code;
    if (!silent) render();
  } catch (e) {
    ctxRef.toast(`单集分镜加载失败：${e.message}`, 'err');
  }
}

// ---------------- 渲染 ----------------
function render() {
  if (!root || !S) return;
  const side = `
    <div class="sc-side">
      <div class="sc-side-head">
        <div>
          <div class="sc-side-title">🎬 剧本 / 分镜工厂</div>
          <div class="sc-side-sub">小说 → 分集规划 → 分镜提示词</div>
        </div>
      </div>
      <button class="sc-btn sc-primary" data-act="new">＋ 新建剧本项目</button>
      <div class="sc-list">${S.scripts.length ? S.scripts.map(scriptItem).join('') : `<div class="sc-empty">还没有剧本项目<br/>点上方按钮，从一部已写完的小说开始</div>`}</div>
      <div class="sc-side-sub">共 ${S.scripts.length} 个项目 · 模块3</div>
    </div>`;

  const main = S.current ? renderWorkbench() : renderWelcome();
  root.innerHTML = `<div class="sc-wrap">${side}<div class="sc-main">${main}</div></div>`;
}

function scriptItem(s) {
  const on = S.current?.id === s.id ? ' sc-on' : '';
  const drift = s.shot_count ? ` · ${s.shot_count} 镜` : '';
  return `<div class="sc-item${on}" data-act="open" data-id="${attr(s.id)}">
    <div class="sc-item-t"><span>${esc(s.title || s.id)}</span><span class="sc-tag${s.storyboard_episodes ? ' sc-ok' : ''}">${s.storyboard_episodes || 0}/${s.episode_count || 0} 集</span></div>
    <div class="sc-item-m">
      <span class="sc-mono">${esc(s.id)}</span>
      <span>${esc(s.style_name || s.style_id || '')}</span>
      <span>${fmtSec(s.episode_seconds)}/集</span>
      <span>${esc(s.format || '')}</span>
      <span>${s.episode_count || 0} 集${drift}</span>
    </div>
    ${s.novel_title ? `<div class="sc-item-m"><span>来源：${esc(s.novel_title)}</span></div>` : ''}
  </div>`;
}

function renderWelcome() {
  return `
    <div class="sc-card">
      <div class="sc-stage-h"><div class="sc-step">3</div><h3>剧本 / 分镜工厂</h3>
        <span class="sc-hint">根据完整小说生成对应风格的漫剧 / 电影剧本与分镜提示词</span></div>
      <div class="sc-empty">左侧选择一个剧本项目，或新建一个。</div>
      <div class="sc-split"></div>
      <div class="sc-stat">
        <div><b>1</b> 选择已完成的小说</div>
        <div><b>2</b> 配置画风 / 单集时长 / 集数 / 季数</div>
        <div><b>3</b> 上传或载入「转换技能文档」</div>
        <div><b>4</b> 生成分集规划 → 逐集剧本 → 分镜表 → 导出</div>
      </div>
    </div>`;
}

function renderWorkbench() {
  const s = S.current;
  const st = s.stats || {};
  const head = `
    <div class="sc-card">
      <div class="sc-row" style="justify-content:space-between">
        <div>
          <div style="font-size:15px;font-weight:700">${esc(s.title || s.id)} <span class="sc-tag sc-acc">${esc(s.id)}</span></div>
          <div class="sc-stat" style="margin-top:6px">
            <div><b>${st.episode_count || 0}</b> 集规划</div>
            <div><b>${st.script_episodes || 0}</b> 集剧本</div>
            <div><b>${st.storyboard_episodes || 0}</b> 集分镜</div>
            <div><b>${st.shot_count || 0}</b> 镜头</div>
            <div>成片总时长 <b>${fmtSec(st.total_duration || 0)}</b></div>
            <div>目标 <b>${fmtSec(st.target_total_duration || 0)}</b></div>
            <div>成本 L/M/H <b>${st.cost?.L || 0}/${st.cost?.M || 0}/${st.cost?.H || 0}</b></div>
          </div>
        </div>
        <div class="sc-row">
          <span class="sc-tag">${esc(s.format_name || s.format)}</span>
          <span class="sc-tag sc-acc">${esc(s.style_name || s.style_id)}</span>
          <span class="sc-tag">${fmtSec(s.episode_seconds)}/集 × ${s.episodes_per_season} 集 × ${s.seasons} 季</span>
          <button class="sc-btn sc-sm sc-danger" data-act="del-script">删除项目</button>
        </div>
      </div>
      ${S.warnings.length ? `<div class="sc-warnbox">⚠️ ${S.warnings.map(esc).join('<br/>⚠️ ')}</div>` : ''}
    </div>`;
  return head + renderStage1() + renderStage2() + renderStage3();
}

function renderStage1() {
  const s = S.current;
  const f = S.form || {};
  const styles = ctxRef.meta?.styles || FB_STYLES;
  const formats = ctxRef.meta?.scriptFormats || FB_FORMATS;
  const novelOpts = S.novels.length
    ? S.novels.map((n) => `<option value="${attr(n.id)}"${f.novelId === n.id ? ' selected' : ''}>${esc(n.title || n.id)}（${esc(n.id)}${n.status ? ` · ${esc(n.status)}` : ''}）</option>`).join('')
    : `<option value="${attr(f.novelId || '')}">${f.novelId ? esc(f.novelId) : '（没有可选小说）'}</option>`;
  return `
  <div class="sc-card">
    <div class="sc-stage-h"><div class="sc-step">1</div><h3>配置</h3>
      <span class="sc-hint">选择小说与风格、单集时长、集数、季数、技能文档</span></div>
    <div class="sc-grid">
      <div class="sc-field"><label>剧本名称</label>
        <input class="sc-input" data-form="title" value="${attr(f.title || '')}" placeholder="留空自动生成"/></div>
      <div class="sc-field"><label>关联小说（已完成）</label>
        <select class="sc-select" data-form="novelId">${novelOpts}</select>
        ${S.novelsOk ? '' : `<span class="sc-side-sub">⚠️ 小说列表接口不可用（模块2 未就绪？），可直接填小说 ID</span>`}</div>
      <div class="sc-field"><label>剧本形态</label>
        <select class="sc-select" data-form="format">
          ${formats.map((x) => `<option value="${attr(x.id)}"${f.format === x.id ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}
        </select></div>
      <div class="sc-field"><label>画风（scripts.style_id）</label>
        <select class="sc-select" data-form="styleId">
          ${styles.map((x) => `<option value="${attr(x.id)}"${f.styleId === x.id ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}
        </select></div>
      <div class="sc-field"><label>每季集数（1~500）</label>
        <input class="sc-input" type="number" min="1" max="500" data-form="episodesPerSeason" value="${attr(f.episodesPerSeason)}"/></div>
      <div class="sc-field"><label>季数（1~50）</label>
        <input class="sc-input" type="number" min="1" max="50" data-form="seasons" value="${attr(f.seasons)}"/></div>
    </div>

    <div class="sc-split"></div>
    <div class="sc-field"><label>单集时长（秒，≥15；预设或自定义）</label>
      <div class="sc-chips">
        ${DURATION_PRESETS.map((p) => `<span class="sc-chip${Number(f.episodeSeconds) === p.v ? ' sc-on' : ''}" data-act="preset-dur" data-v="${p.v}">${esc(p.label)}</span>`).join('')}
        <input class="sc-input" style="width:110px" type="number" min="15" data-form="episodeSeconds" value="${attr(f.episodeSeconds)}"/>
      </div>
      <span class="sc-side-sub">当前：${fmtSec(f.episodeSeconds)}／集 ·（40 分钟 = 2400 秒，90 分钟 = 5400 秒）</span>
    </div>

    <div class="sc-split"></div>
    <div class="sc-field"><label>转换技能文档（可上传参考；上传优先于内置模板）</label>
      <div class="sc-drop">
        <input type="file" id="sc-skill-file" accept=".md,.txt,.markdown,.json"/>
        <span>${f.skillDocPath ? `已关联：<b>${esc(f.skillDocName || f.skillDocPath)}</b>` : '当前使用内置默认模板'}</span>
        <button class="sc-btn sc-sm" data-act="load-builtin">载入内置模板</button>
        <button class="sc-btn sc-sm" data-act="preview-skill">预览生成时使用的技能文档</button>
        <button class="sc-btn sc-sm" data-act="download-builtin">下载内置模板</button>
        ${f.skillDocPath ? `<button class="sc-btn sc-sm sc-danger" data-act="clear-skill">取消关联</button>` : ''}
      </div>
      <span class="sc-side-sub">技能文档会整篇注入 system prompt，作为「小说→剧本」的改编原则、桥段取舍、分集结构、台词与镜头语言规则。</span>
    </div>

    <div class="sc-split"></div>
    <div class="sc-row">
      <button class="sc-btn" data-act="save-config">保存配置</button>
      <button class="sc-btn sc-primary" data-act="save-and-plan">保存并生成分集规划 →</button>
      <span class="sc-side-sub">修改单集时长/集数后建议点「保存配置」，分镜会按最新单集时长配平。</span>
    </div>
  </div>`;
}

function renderStage2() {
  const eps = S.episodes || [];
  const revByCode = new Map((S.review?.episodes || []).map((r) => [r.code, r]));
  const rows = eps.map((e) => {
    const over = (e.status === 'storyboard' && (e.shot_duration || 0) > 0 && Math.abs((e.shot_duration || 0) - (e.duration || 0)) / (e.duration || 1) > 0.02);
    const st = { planned: '<span class="sc-tag">已规划</span>', script: '<span class="sc-tag sc-acc">有剧本</span>', storyboard: '<span class="sc-tag sc-ok">有分镜</span>' }[e.status] || `<span class="sc-tag">${esc(e.status || '')}</span>`;
    const rev = revByCode.get(e.code);
    const revStatus = rev?.status || e.review_status || 'draft';
    return `<tr class="${over ? 'sc-over' : ''}">
      <td class="sc-mono">${esc(e.code)}</td>
      <td>${esc(e.title || '')}</td>
      <td>${esc(e.logline || '')}</td>
      <td>${esc(e.hook || '')}</td>
      <td>${esc(e.cliffhanger || '')}</td>
      <td class="sc-mono">${(e.source_chapters || []).length ? esc((e.source_chapters || []).join(',')) : '—'}</td>
      <td>${esc(e.scene_count || 0)}</td>
      <td>${e.shot_count || 0}${over ? ' ⚠️' : ''}</td>
      <td>${fmtSec(e.duration)}</td>
      <td>${st}</td>
      <td>${reviewTag(revStatus)}</td>
      <td>
        <div class="sc-row">
          <button class="sc-btn sc-sm" data-act="gen-ep" data-code="${attr(e.code)}">生成剧本</button>
          <button class="sc-btn sc-sm" data-act="gen-sb" data-code="${attr(e.code)}">生成分镜</button>
          <button class="sc-btn sc-sm" data-act="view-ep" data-code="${attr(e.code)}">查看分镜</button>
          <button class="sc-btn sc-sm" data-act="review" data-code="${attr(e.code)}">审核</button>
        </div>
      </td>
    </tr>`;
  }).join('');

  return `
  <div class="sc-card">
    <div class="sc-stage-h"><div class="sc-step">2</div><h3>分集规划</h3>
      <span class="sc-hint">按小说字数占比切集，每集给出标题 / logline / 钩子 / 悬念收尾 / 覆盖原文章节范围</span></div>
    <div class="sc-row" style="align-items:flex-end">
      <div class="sc-field" style="flex:1;min-width:260px"><label>额外要求（可选，会并入规划提示词）</label>
        <textarea class="sc-textarea" data-form="instruction" placeholder="例如：第 1 集必须 15 秒内出冲突；把宗门大比提前到第 3 集；弱化感情线…">${esc(S.form?.instruction || '')}</textarea></div>
      <label class="sc-inline"><input type="checkbox" data-form="overwrite"${S.form?.overwrite ? ' checked' : ''}/> 覆盖已有规划</label>
      <button class="sc-btn sc-primary" data-act="plan">生成 / 更新分集规划</button>
      <button class="sc-btn" data-act="sb-all">全部生成分镜（异步任务）</button>
    </div>
    <div id="sc-job-plan">${renderJobBox('plan')}</div>
    <div class="sc-split"></div>
    ${eps.length ? `
    <div class="sc-tbl-wrap" style="max-height:46vh"><table class="sc-tbl">
      <thead><tr><th>集号</th><th>标题</th><th>Logline</th><th>钩子</th><th>悬念收尾</th><th>覆盖章节</th><th>场次</th><th>镜头</th><th>时长</th><th>状态</th><th>审核</th><th>操作</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>` : `<div class="sc-empty">还没有分集规划，点击「生成 / 更新分集规划」。共将生成 ${(Number(S.form?.episodesPerSeason) || 0) * (Number(S.form?.seasons) || 1)} 集。</div>`}
  </div>`;
}

function renderStage3() {
  const s = S.current;
  const ep = S.episodes.find((e) => e.code === S.episodeCode) || S.episodes.find((e) => e.shot_count > 0) || S.episodes[0] || null;
  const code = ep?.code || '';
  const target = Number(ep?.duration || s.episode_seconds || 0);
  const total = Number((S.shots.reduce((a, x) => a + (Number(x.duration) || 0), 0)).toFixed(2));
  const drift = Number((total - target).toFixed(2));
  const driftPct = target ? Math.abs(drift) / target * 100 : 0;
  const overTolerance = target > 0 && S.shots.length > 0 && driftPct > 2;
  const epOpts = S.episodes.map((e) => `<option value="${attr(e.code)}"${e.code === code ? ' selected' : ''}>${esc(e.code)}｜${esc(e.title || '')}（${e.shot_count || 0} 镜）</option>`).join('');

  return `
  <div class="sc-card">
    <div class="sc-stage-h"><div class="sc-step">3</div><h3>分镜表 / 提示词</h3>
      <span class="sc-hint">景别·机位·运镜·转场·时长·动作·台词·音效·音乐·情绪·英文提示词·成本级</span></div>
    <div class="sc-tabs">
      <select class="sc-select" style="width:auto;min-width:220px" data-act="pick-ep">${epOpts || '<option>（暂无集）</option>'}</select>
      <div class="sc-chips">
        <span class="sc-chip${S.view === 'table' ? ' sc-on' : ''}" data-act="view" data-v="table">表格视图</span>
        <span class="sc-chip${S.view === 'card' ? ' sc-on' : ''}" data-act="view" data-v="card">卡片视图</span>
      </div>
      <span class="sc-tag ${overTolerance ? 'sc-err' : (S.shots.length ? 'sc-ok' : '')}">时长 ${fmtSec(total)} / 目标 ${fmtSec(target)}（偏差 ${driftPct.toFixed(2)}%）${overTolerance ? ' ⚠️ 超 2% 容差' : ''}</span>
      <div class="sc-row" style="margin-left:auto">
        <button class="sc-btn sc-sm" data-act="rebalance" data-code="${attr(code)}">重新配平时长</button>
        <button class="sc-btn sc-sm" data-act="add-shot" data-code="${attr(code)}">＋ 新增一镜</button>
        <button class="sc-btn sc-sm" data-act="sync-performance" data-code="${attr(code)}" title="按台词/动作推断说话人，补全声音元数据并同步出场角色，让制作台配音用对演员音色">按角色补全说话人</button>
        <button class="sc-btn sc-sm" data-act="review" data-code="${attr(code)}">审核本集</button>
        <button class="sc-btn sc-sm" data-act="gen-sb" data-code="${attr(code)}">重生成本集分镜</button>
      </div>
    </div>
    <div id="sc-job-sb">${renderJobBox('sb')}</div>
    ${renderExports(code)}
    <div class="sc-split"></div>
    ${S.shots.length ? (S.view === 'card' ? renderShotCards(overTolerance) : renderShotTable(overTolerance)) : `<div class="sc-empty">本集还没有分镜。点击「生成分镜」把本集拆成「场 → 镜」，并自动拼装英文提示词。</div>`}
    ${S.episodeDetail && S.shots.length ? renderSceneBrief() : ''}
  </div>`;
}

function renderExports(code) {
  const base = S.current ? `/api/scripts/${S.current.id}/export` : '#';
  const extBase = S.current ? `/api/scripts/${S.current.id}/export-ext` : '#';
  const epParam = code ? `&episode=${encodeURIComponent(code)}` : '';
  return `<div class="sc-row" style="margin-top:10px">
    <button class="sc-btn" data-act="bind-canvas" title="把画布上的环境/物品/参考图绑定为剧本权威设定（分镜提示词与会自动带上，关键帧用其参考图）">🎨 绑定画布资产</button>
    <button class="sc-btn" data-act="go-render" title="去制作台：把本集分镜推进到关键帧 → 视频 → 整集成片">🎞 去制作台</button>
    <span class="sc-side-sub">导出本集：</span>
    ${['json', 'csv', 'md', 'fountain'].map((f) => `<a class="sc-btn sc-sm" href="${base}?format=${f}${epParam}&download=1" download>${f.toUpperCase()}</a>`).join('')}
    <span class="sc-side-sub">导出全部：</span>
    ${['json', 'csv', 'md', 'fountain'].map((f) => `<a class="sc-btn sc-sm" href="${base}?format=${f}&download=1" download>全部 ${f.toUpperCase()}</a>`).join('')}
  </div>
  <div class="sc-row" style="margin-top:6px">
    <span class="sc-side-sub">体检与版本：</span>
    <button class="sc-btn sc-sm" data-act="ref-check" title="检查角色/地点引用是否失效或与动作文字不一致">引用体检</button>
    <button class="sc-btn sc-sm" data-act="prompt-check" data-code="${attr(code)}" title="检查重复 token、时间矛盾、无关道具、空角色锚点">提示词体检</button>
    <button class="sc-btn sc-sm" data-act="prompt-pro" data-code="${attr(code)}" title="按画风补镜头/光影/质量尾，去重、踢中文；不调用 LLM、不花钱">专业化提示词</button>
    <button class="sc-btn sc-sm" data-act="estimate" data-code="${attr(code)}" title="生成前预估 LLM 调用、关键帧、视频数量和费用">成本预估</button>
    <button class="sc-btn sc-sm" data-act="budget" title="设置本项目成本上限，超额时提示或拒绝">项目预算</button>
    <button class="sc-btn sc-sm" data-act="save-snapshot" data-code="${attr(code)}">保存快照</button>
    <button class="sc-btn sc-sm" data-act="list-snapshots" data-code="${attr(code)}">快照/回滚</button>
    <span class="sc-side-sub">扩展导出：</span>
    <a class="sc-btn sc-sm" href="${extBase}?format=fdx${epParam}&download=1" download>FDX</a>
    <a class="sc-btn sc-sm" href="${extBase}?format=html${epParam}" target="_blank" rel="noopener">打印/PDF</a>
    <a class="sc-btn sc-sm" href="${extBase}?format=otio${epParam}&download=1" download title="OpenTimelineIO，可用于 DaVinci Resolve / Premiere 等">OTIO</a>
    <a class="sc-btn sc-sm" href="${extBase}?format=edl${epParam}&download=1" download title="CMX3600 EDL 剪辑表">EDL</a>
    <a class="sc-btn sc-sm" href="${extBase}?format=fcpxml${epParam}&download=1" download title="Final Cut Pro XML">FCPXML</a>
  </div>`;
}

function pagedShots() {
  const size = Math.max(1, Number(S.shotPageSize) || 50);
  const total = S.shots.length;
  const pages = Math.max(1, Math.ceil(total / size));
  let page = Math.min(Math.max(0, Number(S.shotPage) || 0), pages - 1);
  if (Number.isNaN(page)) page = 0;
  S.shotPage = page;
  const start = page * size;
  return { list: S.shots.slice(start, start + size), total, pages, page, size, start };
}

function pagerHtml(p) {
  const sizeSel = `<select class="sc-select" style="width:auto" data-act="shot-page-size">${[25, 50, 100, 200].map((n) => `<option value="${n}"${n === p.size ? ' selected' : ''}>${n}/页</option>`).join('')}</select>`;
  if (p.total <= p.size) {
    return `<div class="sc-pager"><span class="sc-page-info">共 ${p.total} 镜</span>${sizeSel}</div>`;
  }
  return `<div class="sc-pager">
    <span class="sc-page-info">共 ${p.total} 镜 · 第 ${p.page + 1}/${p.pages} 页</span>
    ${sizeSel}
    <button class="sc-btn sc-sm" data-act="shot-page" data-v="0"${p.page === 0 ? ' disabled' : ''}>首页</button>
    <button class="sc-btn sc-sm" data-act="shot-page" data-v="${p.page - 1}"${p.page === 0 ? ' disabled' : ''}>上一页</button>
    <button class="sc-btn sc-sm" data-act="shot-page" data-v="${p.page + 1}"${p.page >= p.pages - 1 ? ' disabled' : ''}>下一页</button>
    <button class="sc-btn sc-sm" data-act="shot-page" data-v="${p.pages - 1}"${p.page >= p.pages - 1 ? ' disabled' : ''}>末页</button>
  </div>`;
}

function renderShotTable(over) {
  const p = pagedShots();
  const rows = p.list.map((x) => {
    const long = Number(x.duration) > 15;
    return `<tr class="${long ? 'sc-over' : ''}">
      <td class="sc-mono">${x.idx}</td>
      <td class="sc-mono">${esc(x.scene_no || '')}</td>
      <td>${esc(x.shot_size || '')}</td>
      <td>${esc(x.camera || '')}</td>
      <td>${esc(x.move || '')}</td>
      <td>${esc(x.transition || '')}</td>
      <td>${Number(x.duration).toFixed(1)}s</td>
      <td style="max-width:220px">${esc(x.action || '')}</td>
      <td class="sc-shot-dlg" style="max-width:180px">${esc(x.dialogue || '')}</td>
      <td>${esc(x.mood || '')}</td>
      <td>${esc(String(x.cost_level || '').slice(0, 1))}</td>
      <td class="sc-mono">${esc((x.refs?.characters || []).join(' '))}</td>
      <td><div class="sc-prompt">${esc(x.prompt_pos || '')}</div></td>
      <td>${reviewTag(x.review_status)}</td>
      <td><div class="sc-row">
        <button class="sc-btn sc-sm" data-act="copy" data-id="${attr(x.id)}">复制提示词</button>
        <button class="sc-btn sc-sm" data-act="toggle-lock" data-id="${attr(x.id)}" title="锁定后重生成和配平会跳过这一镜">${Number(x.locked) === 1 ? '解锁' : '锁定'}</button>
        <button class="sc-btn sc-sm" data-act="shot-review" data-id="${attr(x.id)}">审核</button>
        <button class="sc-btn sc-sm" data-act="edit-shot" data-id="${attr(x.id)}">编辑</button>
        <button class="sc-btn sc-sm sc-danger" data-act="del-shot" data-id="${attr(x.id)}">删除</button>
      </div></td>
    </tr>`;
  }).join('');
  return `<div class="sc-tbl-wrap"><table class="sc-tbl">
    <thead><tr><th>#</th><th>场</th><th>景别</th><th>机位</th><th>运镜</th><th>转场</th><th>时长</th><th>动作</th><th>台词</th><th>情绪</th><th>成本</th><th>角色</th><th>英文正向提示词</th><th>审核</th><th>操作</th></tr></thead>
    <tbody>${rows}</tbody></table></div>
    ${pagerHtml(p)}
    ${over ? `<div class="sc-warnbox">⚠️ 本集镜头时长合计与单集目标偏差超过 2%，可点「重新配平时长」一键配平。</div>` : ''}`;
}

function renderShotCards(over) {
  const p = pagedShots();
  const cards = p.list.map((x) => `
    <div class="sc-shot ${Number(x.duration) > 15 ? 'sc-over' : ''}">
      <div class="sc-shot-h"><b>#${x.idx}</b>
        <span class="sc-tag">场 ${esc(x.scene_no || '-')}</span>
        <span class="sc-tag sc-acc">${esc(x.shot_size || '')}</span>
        <span class="sc-tag">${esc(x.camera || '')}·${esc(x.move || '')}</span>
        <span class="sc-tag">${esc(x.transition || '')}</span>
        <span class="sc-tag sc-warn">${Number(x.duration).toFixed(1)}s</span>
        <span class="sc-tag">${esc(String(x.cost_level || '').slice(0, 1))}</span>
      </div>
      <div class="sc-shot-body">${esc(x.action || '')}</div>
      ${x.dialogue ? `<div class="sc-shot-body sc-shot-dlg">💬 ${esc(x.dialogue)}</div>` : ''}
      <div class="sc-shot-h">
        ${x.sfx ? `<span class="sc-tag">SFX ${esc(x.sfx)}</span>` : ''}
        ${x.music ? `<span class="sc-tag">♪ ${esc(x.music)}</span>` : ''}
        <span class="sc-tag">${esc(x.mood || '')}</span>
        <span class="sc-tag">${esc(x.time_of_day || '')}</span>
        <span class="sc-tag">${esc(x.location_id || '')}</span>
        <span class="sc-tag sc-acc">${esc((x.refs?.characters || []).join(' '))}</span>
        ${reviewTag(x.review_status)}
      </div>
      <div class="sc-shot-p">POS: ${esc(x.prompt_pos || '')}</div>
      <div class="sc-shot-p">NEG: ${esc(x.prompt_neg || '')}</div>
      <div class="sc-row">
        <button class="sc-btn sc-sm" data-act="copy" data-id="${attr(x.id)}">复制提示词</button>
        <button class="sc-btn sc-sm" data-act="toggle-lock" data-id="${attr(x.id)}" title="锁定后重生成和配平会跳过这一镜">${Number(x.locked) === 1 ? '解锁' : '锁定'}</button>
        <button class="sc-btn sc-sm" data-act="shot-review" data-id="${attr(x.id)}">审核</button>
        <button class="sc-btn sc-sm" data-act="edit-shot" data-id="${attr(x.id)}">编辑</button>
        <button class="sc-btn sc-sm sc-danger" data-act="del-shot" data-id="${attr(x.id)}">删除</button>
      </div>
    </div>`).join('');
  return `<div class="sc-shot-cards">${cards}</div>
    ${pagerHtml(p)}
    ${over ? `<div class="sc-warnbox">⚠️ 本集镜头时长偏差超过 2%，建议「重新配平时长」。</div>` : ''}`;
}

function renderSceneBrief() {
  const scenes = S.episodeDetail?.scenes?.scenes || [];
  if (!scenes.length) return '';
  return `<div class="sc-split"></div>
  <div class="sc-side-sub" style="margin-bottom:6px">本集场次表（${scenes.length} 场，来源：${esc(S.episodeDetail.scenes?.mode || '')}）</div>
  <div class="sc-tbl-wrap" style="max-height:30vh"><table class="sc-tbl">
    <thead><tr><th>场</th><th>场景</th><th>地点</th><th>时间</th><th>出场</th><th>beat 数</th><th>功能</th></tr></thead>
    <tbody>${scenes.map((x) => `<tr>
      <td class="sc-mono">${esc(x.no)}</td><td>${esc(x.slug || '')}</td><td>${esc(x.location || x.location_id || '')}</td>
      <td>${esc(x.time || '')}</td><td class="sc-mono">${esc((x.characters || []).join(' '))}</td>
      <td>${(x.beats || []).length}</td><td>${esc(x.summary || '')}</td></tr>`).join('')}</tbody>
  </table></div>`;
}

function renderJobBox(key) {
  const j = S.jobs[key];
  if (!j) return '';
  const pct = Math.round(j.progress || 0);
  return `<div style="margin-top:8px">
    <div class="sc-job"><span>${esc(j.title || '任务')} · ${esc(j.status)}</span><span>${pct}%${j.error ? ` · ${esc(j.error)}` : ''}</span></div>
    <div class="sc-prog"><i style="width:${pct}%"></i></div>
  </div>`;
}

// ---------------- 画布资产绑定（环境 / 物品 / 参考图 → 剧本权威设定） ----------------
async function bindCanvasAssets() {
  const scriptId = S.current?.id || S.scriptId;
  if (!scriptId) { toast('先选择一个剧本项目'); return; }
  try {
    const list = await ctxRef.api.get('/api/canvas/list');
    const canvases = (list.canvases || []).filter((c) => (c.node_count || 0) > 0);
    if (!canvases.length) { toast('还没有可绑定的画布：先到「明星演员矩阵」放好环境/物品/参考图节点', 'warn', 3600); return; }
    const cur = await ctxRef.api.get(`/api/scripts/${scriptId}/canvas-binding`).catch(() => null);
    const body = document.createElement('div');
    body.innerHTML = `
      <div class="sc-hint" style="margin-bottom:8px">把画布上的 <b>环境 / 物品 / 参考图</b> 节点绑定为剧本的权威设定：分镜提示词会自动带上场景与道具令牌（<code>canvas set: …</code>），渲染关键帧时优先使用其参考图（参考生图）。</div>
      <div class="sc-field"><label>选择画布</label>
        <select class="sc-select" id="sc-cv-sel">
          ${canvases.map((c) => `<option value="${attr(c.id)}"${cur?.binding?.canvasId === c.id ? ' selected' : ''}>${esc(c.name)}（${c.node_count} 节点）</option>`).join('')}
        </select>
      </div>
      <div class="sc-hint" style="margin-top:8px">当前绑定：${cur?.summary ? `画布「${esc(cur.summary.canvasName)}」 · 环境 ${cur.summary.scenes} · 物品 ${cur.summary.items} · 参考图 ${cur.summary.refs}` : '未绑定'}</div>`;
    const cancel = document.createElement('button');
    cancel.className = 'sc-btn';
    cancel.textContent = '解绑';
    cancel.addEventListener('click', async () => {
      await ctxRef.api.del(`/api/scripts/${scriptId}/canvas-binding`);
      toast('已解绑画布资产', 'ok');
      m.close();
    });
    const confirm = document.createElement('button');
    confirm.className = 'sc-btn sc-primary';
    confirm.textContent = '绑定';
    confirm.addEventListener('click', async () => {
      try {
        const sel = document.getElementById('sc-cv-sel');
        const r = await ctxRef.api.post(`/api/scripts/${scriptId}/canvas-binding`, { canvasId: sel.value });
        toast(`已绑定画布资产：环境 ${r.summary.scenes} · 物品 ${r.summary.items} · 参考图 ${r.summary.refs}`, 'ok', 3600);
        m.close();
      } catch (e) { toast('绑定失败：' + e.message, 'err'); }
    });
    const m = ctxRef.modal({ title: '🎨 绑定画布资产', body, width: 580, footer: [cancel, confirm] });
  } catch (e) { toast('绑定失败：' + e.message, 'err'); }
}

// ---------------- 事件 ----------------
function setForm(k, v) { if (S.form) S.form[k] = v; }

function onClick(e) {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const act = t.getAttribute('data-act');
  const id = t.getAttribute('data-id');
  const code = t.getAttribute('data-code');
  const handlers = {
    new: () => newScript(),
    open: () => { S.episodeCode = ''; selectScript(id); },
    'preset-dur': () => { setForm('episodeSeconds', Number(t.getAttribute('data-v'))); render(); },
    'load-builtin': () => useBuiltinSkill(),
    'preview-skill': () => previewSkill(),
    'download-builtin': () => {
      const fmt = S.form?.format || 'manju';
      window.open(`/api/script-skills?download=1&format=${encodeURIComponent(fmt)}`, '_blank');
    },
    'clear-skill': () => { setForm('skillDocPath', ''); setForm('skillDocName', ''); render(); toast('已取消技能文档关联（将使用内置模板）'); },
    'save-config': () => saveConfig(false),
    'save-and-plan': () => saveConfig(true),
    plan: () => planEpisodes(),
    'sb-all': () => storyboard({ all: true }),
    'gen-sb': () => storyboard({ episode: code }),
    'gen-ep': () => genEpisode(code),
    'view-ep': () => { S.episodeCode = code; loadEpisodeShots(code, false); },
    view: () => { S.view = t.getAttribute('data-v'); render(); },
    'pick-ep': () => { /* change 事件处理 */ },
    rebalance: () => rebalance(code),
    'add-shot': () => shotModal(null, code),
    'edit-shot': () => shotModal(S.shots.find((x) => x.id === id), S.episodeCode),
    'del-shot': () => delShot(id),
    copy: () => copyPrompt(id),
    'del-script': () => delScript(),
    'bind-canvas': () => bindCanvasAssets(),
    'go-render': () => ctxRef.go('render'),
    'ref-check': () => refCheck(),
    'ref-repair': () => refRepair(),
    'prompt-check': () => promptCheck(code),
    'prompt-repair': () => promptRepair(code),
    'prompt-pro': () => promptProfessionalize(code),
    estimate: () => showEstimate(code),
    'save-snapshot': () => saveSnapshot(code),
    'list-snapshots': () => listSnapshots(code),
    'toggle-lock': () => toggleLock(id),
    review: () => reviewPanel(code),
    'sync-performance': () => syncPerformances(code),
    budget: () => budgetPanel(),
    'shot-review': () => shotReview(id),
    'shot-page': () => { S.shotPage = Number(t.getAttribute('data-v')) || 0; render(); },
  };
  const fn = handlers[act];
  if (fn) fn();
}

function onChange(e) {
  const el = e.target;
  if (el.id === 'sc-skill-file') { uploadSkill(el.files?.[0]); return; }
  const act = el.getAttribute('data-act');
  if (act === 'pick-ep') { S.episodeCode = el.value; loadEpisodeShots(el.value, false); return; }
  if (act === 'shot-page-size') { S.shotPageSize = Number(el.value) || 50; S.shotPage = 0; render(); return; }
  const key = el.getAttribute('data-form');
  if (key) {
    if (el.type === 'checkbox') setForm(key, el.checked);
    else if (el.type === 'number') setForm(key, Number(el.value));
    else setForm(key, el.value);
    if (key === 'format' || key === 'episodeSeconds' || key === 'episodesPerSeason') render();
    return;
  }
}

const toast = (m, t) => ctxRef.toast(m, t);

// ---------------- 业务动作 ----------------
async function newScript() {
  const styles = ctxRef.meta?.styles || FB_STYLES;
  const formats = ctxRef.meta?.scriptFormats || FB_FORMATS;
  let novels = S.novels;
  if (!novels.length && S.novelsOk) {
    try { const r = await ctxRef.api.get('/api/novels'); novels = r.novels || []; S.novels = novels; } catch { /* ignore */ }
  }
  const body = document.createElement('div');
  body.innerHTML = `
    <div class="sc-field" style="margin-bottom:8px"><label>选择小说（已写完）</label>
      <select class="sc-select" id="sc-n-novel">${novels.length
        ? novels.map((n) => `<option value="${attr(n.id)}">${esc(n.title || n.id)}（${esc(n.id)}）</option>`).join('')
        : '<option value="">（无小说可选，请先在模块2 小说工坊创建）</option>'}</select></div>
    <div class="sc-field" style="margin-bottom:8px"><label>剧本名称</label>
      <input class="sc-input" id="sc-n-title" placeholder="留空自动命名"/></div>
    <div class="sc-grid">
      <div class="sc-field"><label>剧本形态</label><select class="sc-select" id="sc-n-format">
        ${formats.map((x) => `<option value="${attr(x.id)}">${esc(x.name)}</option>`).join('')}</select></div>
      <div class="sc-field"><label>画风</label><select class="sc-select" id="sc-n-style">
        ${styles.map((x) => `<option value="${attr(x.id)}">${esc(x.name)}</option>`).join('')}</select></div>
      <div class="sc-field"><label>单集时长（秒）</label><input class="sc-input" type="number" min="15" id="sc-n-sec" value="120"/></div>
      <div class="sc-field"><label>每季集数</label><input class="sc-input" type="number" min="1" max="500" id="sc-n-eps" value="100"/></div>
      <div class="sc-field"><label>季数</label><input class="sc-input" type="number" min="1" max="50" id="sc-n-seasons" value="1"/></div>
    </div>
    <div class="sc-row" style="margin-top:8px">
      <span class="sc-side-sub">预设：</span>
      ${DURATION_PRESETS.map((p) => `<span class="sc-chip" data-preset="${p.v}">${esc(p.label)}</span>`).join('')}
    </div>
    ${novels.length ? '' : `<div class="sc-warnbox">未获取到小说列表。可先到「小说工坊」创建并写完一部小说，或直接关闭本弹窗后手工填小说 ID。</div>`}`;
  const modal = ctxRef.modal({ title: '新建剧本项目', body, width: 640 });
  body.querySelectorAll('[data-preset]').forEach((c) => c.addEventListener('click', () => {
    body.querySelector('#sc-n-sec').value = c.getAttribute('data-preset');
  }));
  body.querySelector('#sc-n-format').addEventListener('change', (ev) => {
    const f = (ctxRef.meta?.scriptFormats || FB_FORMATS).find((x) => x.id === ev.target.value);
    if (f) {
      body.querySelector('#sc-n-sec').value = f.defaultEpisodeSeconds;
      body.querySelector('#sc-n-eps').value = f.defaultEpisodes;
    }
  });
  body.appendChild(Object.assign(document.createElement('div'), {
    className: 'sc-row',
    innerHTML: `<button class="sc-btn sc-primary" id="sc-n-ok">创建</button>
      <button class="sc-btn" id="sc-n-cancel">取消</button>
      ${novels.length ? '' : `<button class="sc-btn" id="sc-n-gonovel">去小说工坊 →</button>`}`,
    style: 'margin-top:12px',
  }));
  body.querySelector('#sc-n-cancel').addEventListener('click', () => modal.close());
  const goNovel = body.querySelector('#sc-n-gonovel');
  if (goNovel) goNovel.addEventListener('click', () => { modal.close(); ctxRef.go('novel'); });
  body.querySelector('#sc-n-ok').addEventListener('click', async () => {
    const novelId = body.querySelector('#sc-n-novel').value;
    if (!novelId) { toast('请先选择一部小说（或先在模块2 创建）', 'err'); return; }
    try {
      const r = await ctxRef.api.post('/api/scripts', {
        novelId,
        title: body.querySelector('#sc-n-title').value.trim(),
        format: body.querySelector('#sc-n-format').value,
        styleId: body.querySelector('#sc-n-style').value,
        episodeSeconds: Number(body.querySelector('#sc-n-sec').value),
        episodesPerSeason: Number(body.querySelector('#sc-n-eps').value),
        seasons: Number(body.querySelector('#sc-n-seasons').value),
      });
      modal.close();
      (r.warnings || []).forEach((w) => toast(w, 'info'));
      toast(`已创建剧本项目 ${r.script.id}`, 'ok');
      await loadScripts(r.script.id);
    } catch (e) { toast(`创建失败：${e.message}`, 'err'); }
  });
}

async function saveConfig(thenPlan) {
  const f = S.form;
  if (!S.current) return;
  try {
    const r = await ctxRef.api.put(`/api/scripts/${S.current.id}`, {
      title: f.title, novelId: f.novelId || null, format: f.format, styleId: f.styleId,
      episodeSeconds: Number(f.episodeSeconds), episodesPerSeason: Number(f.episodesPerSeason), seasons: Number(f.seasons),
      skillDocPath: f.skillDocPath || null, skillDocName: f.skillDocName || null,
    });
    (r.warnings || []).forEach((w) => toast(w, 'info'));
    toast('配置已保存', 'ok');
    await selectScript(S.current.id, true);
    if (thenPlan) await planEpisodes();
  } catch (e) { toast(`保存失败：${e.message}`, 'err'); }
}

async function uploadSkill(file) {
  if (!file) return;
  try {
    const up = await ctxRef.api.upload(file);
    const path = up.path || up.files?.[0]?.path;
    const name = up.name || up.files?.[0]?.name || file.name;
    setForm('skillDocPath', path);
    setForm('skillDocName', name);
    await ctxRef.api.put(`/api/scripts/${S.current.id}`, { skillDocPath: path, skillDocName: name });
    toast(`技能文档已上传并关联：${name}`, 'ok');
    render();
  } catch (e) { toast(`上传失败：${e.message}`, 'err'); }
}

async function useBuiltinSkill() {
  try {
    const fmt = S.form?.format || 'manju';
    const r = await ctxRef.api.get(`/api/script-skills?format=${encodeURIComponent(fmt)}`);
    S.skills = r;
    const text = r.template?.text || r.text || '';
    const body = document.createElement('div');
    body.innerHTML = `<div class="sc-side-sub" style="margin-bottom:6px">内置模板：${esc(r.template?.name || '')}（${text.length} 字，${esc(r.template?.version || '')}）</div>
      <div class="sc-md">${esc(text)}</div>
      <div class="sc-row" style="margin-top:10px">
        <button class="sc-btn sc-primary" id="sc-skill-use">用此模板（填入配置，生成时注入）</button>
        <button class="sc-btn" id="sc-skill-download">下载模板文件</button>
        <button class="sc-btn" id="sc-skill-close">关闭</button>
      </div>
      <div class="sc-side-sub" style="margin-top:8px">提示：也可以把模板下载后按项目需要改写，再用「选择文件」上传，上传的文档优先于内置模板。</div>`;
    const modal = ctxRef.modal({ title: '内置转换技能文档模板', body, width: 900 });
    body.querySelector('#sc-skill-close').addEventListener('click', () => modal.close());
    body.querySelector('#sc-skill-download').addEventListener('click', () => {
      window.open(`/api/script-skills?download=1&format=${encodeURIComponent(fmt)}`, '_blank');
    });
    body.querySelector('#sc-skill-use').addEventListener('click', () => {
      setForm('skillDocPath', '');
      setForm('skillDocName', `内置模板：${r.template?.name || fmt}`);
      modal.close();
      toast('已选用内置模板（生成时注入；不再使用上传文档）', 'ok');
      render();
    });
  } catch (e) { toast(`内置模板加载失败：${e.message}`, 'err'); }
}

async function previewSkill() {
  if (!S.current) return;
  try {
    const r = await ctxRef.api.get(`/api/scripts/${S.current.id}/skill-doc`);
    const body = document.createElement('div');
    body.innerHTML = `<div class="sc-row" style="margin-bottom:6px">
        <span class="sc-tag sc-acc">${esc(r.source === 'upload' ? '上传文档（优先）' : '内置模板')}</span>
        <span class="sc-side-sub">${esc(r.name || '')} · ${(r.text || '').length} 字</span></div>
      ${r.warning ? `<div class="sc-warnbox">${esc(r.warning)}</div>` : ''}
      <div class="sc-md">${esc(r.text || '')}</div>`;
    ctxRef.modal({ title: '生成时将注入的技能文档', body, width: 900 });
  } catch (e) { toast(`预览失败：${e.message}`, 'err'); }
}

function watch(key, jobId, label, onDone) {
  const stop = ctxRef.watchJob(jobId, (job) => {
    if (!S) return;
    S.jobs[key] = job;
    const box = q(`#sc-job-${key}`);
    if (box) box.innerHTML = renderJobBox(key);
    if (job.status === 'done') {
      ctxRef.toast(`${label}完成`, 'ok');
      (job.result?.warnings || []).slice(0, 4).forEach((w) => ctxRef.toast(w, 'info'));
      stop();
      if (onDone) onDone(job);
    } else if (job.status === 'error') {
      ctxRef.toast(`${label}失败：${job.error || '未知错误'}`, 'err');
      stop();
    } else if (job.status === 'canceled') {
      ctxRef.toast(`${label}已取消`, 'info');
      stop();
    }
  });
  stops.push(stop);
}

async function planEpisodes() {
  if (!S.current) return;
  const f = S.form;
  const total = Number(f.episodesPerSeason) * Number(f.seasons);
  const okGo = await ctxRef.confirm(`将按小说内容生成 ${total} 集分集大纲${f.overwrite ? '（覆盖已有规划）' : ''}，是否继续？`);
  if (!okGo) return;
  try {
    const r = await ctxRef.api.post(`/api/scripts/${S.current.id}/plan`, {
      instruction: f.instruction || '', overwrite: Boolean(f.overwrite),
    });
    if (r.sync) {
      toast(`规划完成，共 ${r.episodes?.length || 0} 集`, 'ok');
      (r.warnings || []).slice(0, 4).forEach((w) => toast(w, 'info'));
      await selectScript(S.current.id, true);
      return;
    }
    toast(`规划任务已提交（${r.total} 批）`, 'info');
    watch('plan', r.jobId, '分集规划', async () => { await selectScript(S.current.id, true); });
  } catch (e) { toast(`规划失败：${e.message}`, 'err'); }
}

async function genEpisode(code) {
  if (!S.current || !code) return;
  await snapshotSilent(code, 'episode');
  try {
    const r = await ctxRef.api.post(`/api/scripts/${S.current.id}/episodes/${code}/generate`, {});
    if (r.sync) { toast(`${code} 剧本已生成`, 'ok'); await selectScript(S.current.id, true); return; }
    toast(`${code} 剧本生成任务已提交`, 'info');
    watch('plan', r.jobId, `${code} 剧本`, async () => { await selectScript(S.current.id, true); });
  } catch (e) { toast(`生成失败：${e.message}`, 'err'); }
}

async function storyboard({ episode, all }) {
  if (!S.current) return;
  if (episode) await snapshotSilent(episode, 'storyboard');
  else if (all) for (const ep of S.episodes) await snapshotSilent(ep.code, 'storyboard');
  if (all) {
    const n = S.episodes.length;
    const okGo = await ctxRef.confirm(`将为全部 ${n} 集生成分镜（后台任务，逐集调用 LLM 拆分镜并配平时长），可能耗时较长。是否继续？`);
    if (!okGo) return;
  }
  try {
    const r = await ctxRef.api.post(`/api/scripts/${S.current.id}/storyboard`, episode ? { episode } : { all: Boolean(all) });
    if (r.sync) { toast(`分镜完成：${r.shots} 镜 / ${fmtSec(r.duration)}`, 'ok'); await selectScript(S.current.id, true); return; }
    toast(`分镜任务已提交（共 ${r.total} 集）`, 'info');
    watch('sb', r.jobId, '分镜生成', async () => { await selectScript(S.current.id, true); });
  } catch (e) { toast(`分镜失败：${e.message}`, 'err'); }
}

async function rebalance(code) {
  if (!S.current) return;
  try {
    const r = await ctxRef.api.post(`/api/scripts/${S.current.id}/rebalance`, code ? { episode: code } : { all: true });
    const list = r.rebalanced || [];
    if (!list.length) toast((r.warnings || ['没有需要配平的集'])[0], 'info');
    else {
      const bad = list.filter((x) => !x.ok);
      toast(bad.length ? `配平后仍有 ${bad.length} 集超差，请检查镜头数` : `已配平 ${list.length} 集，时长误差 < 2%`, bad.length ? 'err' : 'ok');
      (r.warnings || []).slice(0, 3).forEach((w) => toast(w, 'info'));
    }
    await loadEpisodeShots(S.episodeCode, true);
    await selectScript(S.current.id, true);
  } catch (e) { toast(`配平失败：${e.message}`, 'err'); }
}

async function delShot(id) {
  const okGo = await ctxRef.confirm('确定删除这一镜吗？删除后可点「重新配平时长」补偿总时长。');
  if (!okGo) return;
  try {
    const r = await ctxRef.api.del(`/api/scripts/${S.current.id}/shots/${id}`);
    (r.warnings || []).forEach((w) => toast(w, 'info'));
    toast('已删除该镜', 'ok');
    await loadEpisodeShots(S.episodeCode, true);
    await selectScript(S.current.id, true);
  } catch (e) { toast(`删除失败：${e.message}`, 'err'); }
}

async function delScript() {
  if (!S.current) return;
  const okGo = await ctxRef.confirm(`删除剧本项目「${S.current.title}」？将连带删除其全部分集与分镜，不可恢复。`);
  if (!okGo) return;
  try {
    const r = await ctxRef.api.del(`/api/scripts/${S.current.id}`);
    toast(`已删除（集 ${r.episodes_deleted || 0} / 镜 ${r.shots_deleted || 0}）`, 'ok');
    S.current = null; S.episodes = []; S.shots = [];
    await loadScripts();
  } catch (e) { toast(`删除失败：${e.message}`, 'err'); }
}

async function copyPrompt(id) {
  const x = S.shots.find((n) => n.id === id);
  if (!x) return;
  const text = `POS: ${x.prompt_pos || ''}\nNEG: ${x.prompt_neg || ''}`;
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    toast('提示词已复制到剪贴板', 'ok');
  } catch (e) { ctxRef.modal({ title: '提示词（手动复制）', body: `<div class="sc-md">${esc(text)}</div>`, width: 760 }); }
}

async function snapshotSilent(code, kind = 'storyboard') {
  if (!S.current || !code) return null;
  try {
    return await ctxRef.api.post(`/api/scripts/${S.current.id}/snapshots`, {
      episode: code, kind, note: '重生成前自动快照', createdBy: 'system',
    });
  } catch { return null; }
}

async function saveSnapshot(code) {
  if (!S.current) return;
  const ep = code || S.episodeCode;
  if (!ep) { toast('请先选择一集', 'warn'); return; }
  try {
    const r = await ctxRef.api.post(`/api/scripts/${S.current.id}/snapshots`, { episode: ep, kind: 'storyboard', note: '手动快照', createdBy: 'human' });
    toast(`已保存快照 v${r.version}（${r.shots} 镜）`, 'ok');
  } catch (e) { toast(`保存快照失败：${e.message}`, 'err'); }
}

async function listSnapshots(code) {
  if (!S.current) return;
  const ep = code || S.episodeCode;
  try {
    const r = await ctxRef.api.get(`/api/scripts/${S.current.id}/snapshots?episode=${encodeURIComponent(ep || '')}`);
    const body = document.createElement('div');
    if (!r.snapshots?.length) body.innerHTML = '<div class="sc-empty">这一集还没有快照。</div>';
    else body.innerHTML = `<div class="sc-tbl-wrap" style="max-height:360px"><table class="sc-tbl"><thead><tr><th>版本</th><th>类型</th><th>说明</th><th>时间</th><th>操作</th></tr></thead><tbody>${r.snapshots.map(s=>`<tr><td>v${s.version}</td><td>${esc(s.kind)}</td><td>${esc(s.note||'')}</td><td>${esc(s.created_at)}</td><td><button class="sc-btn sc-sm" data-snapshot="${attr(s.id)}">回滚</button></td></tr>`).join('')}</tbody></table></div>`;
    const m = ctxRef.modal({ title: `快照与回滚 · ${ep || '全部'}`, body, width: 760 });
    body.querySelectorAll('[data-snapshot]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const ok = await ctxRef.confirm('回滚会用该快照覆盖本集剧本和分镜；已锁定镜头会保留。继续？');
        if (!ok) return;
        try {
          const r2 = await ctxRef.api.post(`/api/scripts/${S.current.id}/snapshots/${btn.getAttribute('data-snapshot')}/restore`, { keepLocked: true });
          toast(`已回滚：${r2.restoredShots} 镜，跳过锁定 ${r2.skippedLocked} 镜`, 'ok');
          m.close();
          await selectScript(S.current.id, true);
        } catch (e) { toast(`回滚失败：${e.message}`, 'err'); }
      });
    });
  } catch (e) { toast(`读取快照失败：${e.message}`, 'err'); }
}

async function refCheck() {
  if (!S.current) return;
  try {
    const r = await ctxRef.api.get(`/api/scripts/${S.current.id}/ref-integrity`);
    const s = r.summary || {};
    const body = document.createElement('div');
    body.innerHTML = `<div class="sc-hint">镜头 ${s.shots || 0} · 有问题 ${s.issueShots || 0} · 失效引用 ${s.invalidRefs || 0} · 缺失引用 ${s.missingRefs || 0} · plan 失效 ${s.planIssues || 0} · 画布失效 ${s.canvasIssues || 0}</div>
      ${(r.shots || []).length ? `<div class="sc-tbl-wrap" style="max-height:320px;margin-top:8px"><table class="sc-tbl"><thead><tr><th>#</th><th>动作</th><th>失效</th><th>缺失</th><th>不一致</th><th>旧ID</th></tr></thead><tbody>${r.shots.map((x) => `<tr><td>${x.idx}</td><td>${esc(x.action)}</td><td>${esc(x.invalid.join(' '))}</td><td>${esc(x.missing.join(' '))}</td><td>${x.mismatched ? '是' : ''}</td><td>${esc(x.staleActionIds.join(' '))}</td></tr>`).join('')}</tbody></table></div>` : '<div class="sc-oknote" style="margin-top:8px">没有发现引用问题。</div>'}`;
    const m = ctxRef.modal({ title: '引用体检', body, width: 920 });
    const bar = document.createElement('div');
    bar.className = 'sc-row'; bar.style.marginTop = '10px';
    bar.innerHTML = '<button class="sc-btn sc-primary" data-a="repair">一键修复（跳过锁定）</button><button class="sc-btn" data-a="close">关闭</button>';
    body.appendChild(bar);
    bar.querySelector('[data-a="close"]').onclick = () => m.close();
    bar.querySelector('[data-a="repair"]').onclick = async () => { m.close(); await refRepair(); };
  } catch (e) { toast(`引用体检失败：${e.message}`, 'err'); }
}

async function refRepair() {
  if (!S.current) return;
  try {
    const r = await ctxRef.api.post(`/api/scripts/${S.current.id}/ref-repair`, {});
    toast(`引用修复：镜头 ${r.repairedShots} · plan ${r.repairedPlanCast} · 画布 ${r.repairedCanvasActors} · 跳过锁定 ${r.skippedLocked}`, 'ok', 4200);
    await selectScript(S.current.id, true);
  } catch (e) { toast(`引用修复失败：${e.message}`, 'err'); }
}

async function promptCheck(code) {
  if (!S.current) return;
  const ep = code || S.episodeCode;
  try {
    const r = await ctxRef.api.get(`/api/scripts/${S.current.id}/prompt-audit?episode=${encodeURIComponent(ep || '')}`);
    const s = r.summary || {};
    const body = document.createElement('div');
    body.innerHTML = `<div class="sc-hint">镜头 ${s.shots || 0} · 有问题 ${s.issueShots || 0} · 重复 token ${s.duplicateTokens || 0} · 时间矛盾 ${s.timeConflicts || 0} · 无关道具 ${s.irrelevantProps || 0} · 空角色引用 ${s.emptyCharacterRefs || 0}</div>
      ${(r.shots || []).length ? `<div class="sc-tbl-wrap" style="max-height:340px;margin-top:8px"><table class="sc-tbl"><thead><tr><th>#</th><th>问题</th><th>锁定</th></tr></thead><tbody>${r.shots.map((x) => `<tr><td>${x.idx}</td><td>${esc(x.issues.join('；'))}</td><td>${x.locked ? '是' : ''}</td></tr>`).join('')}</tbody></table></div>` : '<div class="sc-oknote" style="margin-top:8px">提示词没有发现明显问题。</div>'}`;
    const m = ctxRef.modal({ title: '提示词体检', body, width: 900 });
    const bar = document.createElement('div');
    bar.className = 'sc-row'; bar.style.marginTop = '10px';
    bar.innerHTML = '<button class="sc-btn sc-primary" data-a="repair">一键修复（跳过锁定）</button><button class="sc-btn" data-a="close">关闭</button>';
    body.appendChild(bar);
    bar.querySelector('[data-a="close"]').onclick = () => m.close();
    bar.querySelector('[data-a="repair"]').onclick = async () => { m.close(); await promptRepair(ep); };
  } catch (e) { toast(`提示词体检失败：${e.message}`, 'err'); }
}

async function promptRepair(code) {
  if (!S.current) return;
  try {
    const r = await ctxRef.api.post(`/api/scripts/${S.current.id}/prompt-repair`, { episode: code || S.episodeCode || '' });
    toast(`提示词修复：${r.repairedShots} 镜（跳过锁定 ${r.skippedLocked}）`, 'ok', 4200);
    await loadEpisodeShots(S.episodeCode, true);
    await selectScript(S.current.id, true);
  } catch (e) { toast(`提示词修复失败：${e.message}`, 'err'); }
}

async function promptProfessionalize(code) {
  if (!S.current) return;
  const ep = code || S.episodeCode || '';
  try {
    const r = await ctxRef.api.post(`/api/scripts/${S.current.id}/prompt-professionalize`, { episode: ep });
    if (!r.professionalized) { toast(`专业化：没有需要改动的镜头（跳过锁定 ${r.skippedLocked}）`, 'info', 3600); return; }
    const left = (r.changes || []).reduce((n, x) => n + (x.remaining?.length || 0), 0);
    toast(`专业化：更新 ${r.professionalized} 镜（跳过锁定 ${r.skippedLocked}），剩余待处理 ${left} 项`, 'ok', 4200);
    await loadEpisodeShots(S.episodeCode, true);
    await selectScript(S.current.id, true);
  } catch (e) { toast(`专业化失败：${e.message}`, 'err'); }
}

async function showEstimate(code) {
  if (!S.current) return;
  try {
    const r = await ctxRef.api.get(`/api/scripts/${S.current.id}/estimate?episode=${encodeURIComponent(code || S.episodeCode || '')}`);
    const bg = await ctxRef.api.post(`/api/scripts/${S.current.id}/budget/check`, {
      codes: code ? [code] : (S.episodeCode ? [S.episodeCode] : []), confirm: true,
    }).catch(() => null);
    const body = document.createElement('div');
    body.innerHTML = `<div class="sc-grid">
      <div class="sc-field"><label>剧集</label><b>${r.episodes}</b></div>
      <div class="sc-field"><label>镜头</label><b>${r.shots}</b></div>
      <div class="sc-field"><label>待出关键帧</label><b>${r.keyframes}</b></div>
      <div class="sc-field"><label>建议出视频（M/H）</label><b>${r.videos}</b></div>
      <div class="sc-field"><label>全部视频</label><b>${r.videosAll}</b></div>
      <div class="sc-field"><label>总时长</label><b>${fmtSec(r.duration)}</b></div>
      <div class="sc-field"><label>LLM 调用预估</label><b>${r.estimatedLlmCalls}</b></div>
      <div class="sc-field"><label>成本级</label><b>L ${r.costLevels?.L || 0} / M ${r.costLevels?.M || 0} / H ${r.costLevels?.H || 0}</b></div>
      <div class="sc-field"><label>视频费用预估</label><b>${r.estimatedVideoCost == null ? '未配置单价' : `¥${r.estimatedVideoCost}`}</b></div>
    </div><div class="sc-hint" style="margin-top:8px">${esc(r.billingNote || '')}</div>
    ${bg ? `<div class="sc-hint" style="margin-top:6px">${bg.blocked ? '⛔ ' : bg.needConfirm ? '⚠️ ' : '✅ '}${esc(bg.reason)}</div>` : ''}`;
    const m = ctxRef.modal({ title: '生成前成本与工作量预估', body, width: 640 });
    const bar = document.createElement('div'); bar.className = 'sc-row'; bar.style.marginTop = '10px';
    bar.innerHTML = '<button class="sc-btn sc-primary" data-a="ok">知道了</button>';
    body.appendChild(bar);
    bar.querySelector('[data-a="ok"]').onclick = () => m.close();
  } catch (e) { toast(`预估失败：${e.message}`, 'err'); }
}

async function toggleLock(shotId) {
  if (!S.current) return;
  const shot = S.shots.find((x) => x.id === shotId);
  if (!shot) return;
  try {
    const r = await ctxRef.api.put(`/api/scripts/${S.current.id}/shots/${shotId}/lock`, { locked: !(Number(shot.locked) === 1) });
    toast(r.locked ? '已锁定该镜，重生成/配平会跳过' : '已解锁该镜', 'ok');
    await loadEpisodeShots(S.episodeCode, true);
    await selectScript(S.current.id, true);
  } catch (e) { toast(`锁定失败：${e.message}`, 'err'); }
}

// ---------------- 审核 / 预算 / 配音表演 ----------------
async function loadReview() {
  if (!S.current) { S.review = null; return; }
  try { S.review = await ctxRef.api.get(`/api/scripts/${S.current.id}/review`); }
  catch { S.review = null; }
}

async function reviewPanel(code) {
  if (!S.current) return;
  const ep = code || S.episodeCode || S.episodes[0]?.code;
  if (!ep) { toast('请先选择一集', 'warn'); return; }
  try {
    const r = await ctxRef.api.get(`/api/scripts/${S.current.id}/review`);
    S.review = r;
    const row = (r.episodes || []).find((x) => x.code === ep);
    const sc = row?.shotCounts || {};
    const body = document.createElement('div');
    body.innerHTML = `
      <div class="sc-row" style="margin-bottom:8px">
        <b>${esc(ep)}</b> ${reviewTag(row?.status || 'draft')}
        <span class="sc-side-sub">本集 ${row?.shots || 0} 镜 · 通过 ${sc.approved || 0} · 待审 ${sc.review || 0} · 草稿 ${sc.draft || 0} · 锁定镜 ${row?.lockedShots || 0}</span>
      </div>
      <div class="sc-field"><label>审核人</label><input class="sc-input" id="sc-rv-by" value="${attr(row?.reviewer || '')}" placeholder="姓名 / 工号"/></div>
      <div class="sc-field" style="margin-top:6px"><label>修改意见 / 备注</label><textarea class="sc-textarea" id="sc-rv-note" placeholder="例如：第 3 镜台词收一点；结尾钩子再狠些…">${esc(row?.reviewNote || '')}</textarea></div>
      <div class="sc-row" style="margin-top:10px">
        <button class="sc-btn" data-rv="draft">退回草稿</button>
        <button class="sc-btn" data-rv="review">提交待审</button>
        <button class="sc-btn sc-primary" data-rv="approved">审核通过</button>
        <button class="sc-btn" data-rv="locked">定稿锁定</button>
      </div>
      <div class="sc-split"></div>
      <div class="sc-row">
        <button class="sc-btn sc-sm" data-rv-batch="approved">全部镜头置为「已通过」</button>
        <button class="sc-btn sc-sm" data-rv-batch="review">全部镜头置为「待审」</button>
        <span class="sc-side-sub">批量操作会跳过已锁定的镜头。</span>
      </div>`;
    const m = ctxRef.modal({ title: `审核 · ${ep}`, body, width: 620 });
    const payload = () => ({
      reviewer: body.querySelector('#sc-rv-by').value.trim(),
      note: body.querySelector('#sc-rv-note').value.trim(),
    });
    body.querySelectorAll('[data-rv]').forEach((btn) => btn.addEventListener('click', async () => {
      try {
        const p = payload(); p.status = btn.getAttribute('data-rv');
        const r2 = await ctxRef.api.post(`/api/scripts/${S.current.id}/episodes/${encodeURIComponent(ep)}/review`, p);
        toast(`单集状态已改为「${REVIEW_LABELS[r2.status] || r2.status}」`, 'ok');
        m.close();
        await loadReview();
        await loadEpisodeShots(S.episodeCode, true);
        await selectScript(S.current.id, true);
      } catch (e) { toast(`提交失败：${e.message}`, 'err'); }
    }));
    body.querySelectorAll('[data-rv-batch]').forEach((btn) => btn.addEventListener('click', async () => {
      try {
        const p = payload(); p.status = btn.getAttribute('data-rv-batch');
        const r2 = await ctxRef.api.post(`/api/scripts/${S.current.id}/episodes/${encodeURIComponent(ep)}/review-batch`, p);
        toast(`批量审核：改动 ${r2.changed} 镜，跳过锁定 ${r2.skippedLocked}`, 'ok', 4200);
        m.close();
        await loadReview();
        await loadEpisodeShots(S.episodeCode, true);
        await selectScript(S.current.id, true);
      } catch (e) { toast(`批量审核失败：${e.message}`, 'err'); }
    }));
  } catch (e) { toast(`读取审核状态失败：${e.message}`, 'err'); }
}

async function shotReview(shotId) {
  if (!S.current) return;
  const shot = S.shots.find((x) => x.id === shotId);
  if (!shot) return;
  try {
    const next = (shot.review_status || 'draft') === 'approved' ? 'draft' : 'approved';
    const r = await ctxRef.api.post(`/api/scripts/${S.current.id}/shots/${shotId}/review`, { status: next, reviewer: 'human' });
    toast(`镜头审核状态：${REVIEW_LABELS[r.status] || r.status}`, 'ok');
    await loadEpisodeShots(S.episodeCode, true);
    await loadReview();
    render();
  } catch (e) { toast(`镜头审核失败：${e.message}`, 'err'); }
}

async function syncPerformances(code) {
  if (!S.current) return;
  const ep = code || S.episodeCode;
  if (!ep) { toast('请先选择一集', 'warn'); return; }
  try {
    const r = await ctxRef.api.post(`/api/scripts/${S.current.id}/performance/sync`, { episode: ep });
    toast(`说话人补全：更新 ${r.updated}/${r.shots} 镜`, 'ok', 4200);
    await loadEpisodeShots(S.episodeCode, true);
    render();
  } catch (e) { toast(`补全失败：${e.message}`, 'err'); }
}

async function budgetPanel() {
  if (!S.current) return;
  try {
    const r = await ctxRef.api.get(`/api/scripts/${S.current.id}/budget`);
    const b = r.budget || {};
    const body = document.createElement('div');
    body.innerHTML = `
      <div class="sc-hint">为本项目设置成本上限。单个项目预算独立于全局月度预算；未启用时按数量预估执行。</div>
      <div class="sc-row" style="margin-top:8px">
        <label class="sc-inline"><input type="checkbox" id="sc-bg-on"${b.enabled ? ' checked' : ''}/> 启用项目预算</label>
        <label class="sc-inline"><input type="checkbox" id="sc-bg-hard"${b.hard ? ' checked' : ''}/> 超额直接拒绝（硬上限）</label>
      </div>
      <div class="sc-grid" style="margin-top:8px">
        <div class="sc-field"><label>上限金额（${esc(b.currency || 'CNY')}）</label><input class="sc-input" type="number" min="0" step="1" id="sc-bg-limit" value="${attr(b.limit || 0)}"/></div>
        <div class="sc-field"><label>备注</label><input class="sc-input" id="sc-bg-note" value="${attr(b.note || '')}"/></div>
      </div>
      <div class="sc-row" style="margin-top:10px">
        <button class="sc-btn sc-primary" id="sc-bg-save">保存预算</button>
        <button class="sc-btn" id="sc-bg-check">按当前镜头试算</button>
        <button class="sc-btn" id="sc-bg-cancel">取消</button>
      </div>
      <div id="sc-bg-out" class="sc-hint" style="margin-top:8px"></div>`;
    const m = ctxRef.modal({ title: '项目预算', body, width: 620 });
    body.querySelector('#sc-bg-cancel').addEventListener('click', () => m.close());
    body.querySelector('#sc-bg-save').addEventListener('click', async () => {
      try {
        const r2 = await ctxRef.api.post(`/api/scripts/${S.current.id}/budget`, {
          enabled: body.querySelector('#sc-bg-on').checked,
          hard: body.querySelector('#sc-bg-hard').checked,
          limit: Number(body.querySelector('#sc-bg-limit').value) || 0,
          note: body.querySelector('#sc-bg-note').value.trim(),
        });
        toast(`预算已保存：${r2.budget.enabled ? `${r2.budget.limit} ${r2.budget.currency}` : '未启用'}`, 'ok');
        m.close();
        await selectScript(S.current.id, true);
      } catch (e) { toast(`保存失败：${e.message}`, 'err'); }
    });
    body.querySelector('#sc-bg-check').addEventListener('click', async () => {
      try {
        const r2 = await ctxRef.api.post(`/api/scripts/${S.current.id}/budget/check`, {
          codes: S.episodeCode ? [S.episodeCode] : [], confirm: true,
        });
        body.querySelector('#sc-bg-out').innerHTML = `${r2.blocked ? '⛔ ' : r2.needConfirm ? '⚠️ ' : '✅ '}${esc(r2.reason)}`;
      } catch (e) { body.querySelector('#sc-bg-out').textContent = `试算失败：${e.message}`; }
    });
  } catch (e) { toast(`读取预算失败：${e.message}`, 'err'); }
}

// ---------------- 单镜编辑 / 新增 ----------------
function shotModal(shot, code) {
  if (!S.current) return;
  const isNew = !shot;
  const x = shot || {
    scene_no: (S.shots[S.shots.length - 1]?.scene_no) || '1', shot_size: '中景', camera: '平视', move: '固定',
    transition: '硬切', duration: 3, action: '', dialogue: '', sfx: '', music: '', mood: '平静', cost_level: 'M 局部动效',
    refs: { characters: [], location: null, style: S.current.style_id },
  };
  const sel = (key, arr, val) => `<select class="sc-select" data-s="${key}">${arr.map((o) => `<option value="${attr(o)}"${String(val) === String(o) ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  const body = document.createElement('div');
  body.innerHTML = `
    <div class="sc-grid">
      <div class="sc-field"><label>场次号</label><input class="sc-input" data-s="scene_no" value="${attr(x.scene_no || '1')}"/></div>
      <div class="sc-field"><label>景别</label>${sel('shot_size', listOf('shot_sizes', 'shotSizes'), x.shot_size)}</div>
      <div class="sc-field"><label>机位</label>${sel('camera', listOf('camera_angles', 'cameraAngles'), x.camera)}</div>
      <div class="sc-field"><label>运镜</label>${sel('move', listOf('camera_moves', 'cameraMoves'), x.move)}</div>
      <div class="sc-field"><label>转场</label>${sel('transition', listOf('transitions', 'transitions'), x.transition)}</div>
      <div class="sc-field"><label>时长（秒）</label><input class="sc-input" type="number" step="0.5" min="1" data-s="duration" value="${attr(x.duration)}"/></div>
      <div class="sc-field"><label>时间</label>${sel('time_of_day', listOf('times_of_day', 'timesOfDay'), x.time_of_day || '白天')}</div>
      <div class="sc-field"><label>情绪</label>${sel('mood', listOf('moods', 'moodList'), x.mood)}</div>
      <div class="sc-field"><label>成本级</label>${sel('cost_level', listOf('cost_levels', 'costLevels'), x.cost_level)}</div>
      <div class="sc-field"><label>地点 ID</label><input class="sc-input" data-s="location_id" value="${attr(x.location_id || x.refs?.location || '')}" placeholder="L-0001"/></div>
      <div class="sc-field"><label>出场角色 ID（逗号分隔）</label><input class="sc-input" data-s="characters" value="${attr((x.refs?.characters || []).join(','))}" placeholder="C-0001,C-0002"/></div>
      <div class="sc-field"><label>说话人</label><input class="sc-input" data-s="speaker" value="${attr(x.speaker || '')}" placeholder="角色名 / C-xxxx"/></div>
      <div class="sc-field"><label>表演情绪</label><input class="sc-input" data-s="emotion" value="${attr(x.emotion || '')}" placeholder="冷静 / 愤怒 / 慌乱…"/></div>
      <div class="sc-field"><label>音色 ID</label><input class="sc-input" data-s="voice_id" value="${attr(x.voice_id || '')}" placeholder="可留空，默认用演员档案音色"/></div>
      <div class="sc-field"><label>音效</label><input class="sc-input" data-s="sfx" value="${attr(x.sfx || '')}"/></div>
      <div class="sc-field"><label>音乐</label><input class="sc-input" data-s="music" value="${attr(x.music || '')}"/></div>
    </div>
    <div class="sc-field" style="margin-top:8px"><label>动作（中文，画面里发生什么）</label>
      <textarea class="sc-textarea" data-s="action">${esc(x.action || '')}</textarea></div>
    <div class="sc-field" style="margin-top:8px"><label>台词（中文，可直接配音）</label>
      <textarea class="sc-textarea" data-s="dialogue">${esc(x.dialogue || '')}</textarea></div>
    <div class="sc-field" style="margin-top:8px"><label>英文正向提示词（留空=按景别/机位/角色锚点自动重建）</label>
      <textarea class="sc-textarea" data-s="prompt_pos" style="min-height:80px">${esc(x.prompt_pos || '')}</textarea></div>
    <div class="sc-field" style="margin-top:8px"><label>英文负面提示词（留空=自动）</label>
      <textarea class="sc-textarea" data-s="prompt_neg">${esc(x.prompt_neg || '')}</textarea></div>
    <div class="sc-row" style="margin-top:12px">
      <button class="sc-btn sc-primary" id="sc-shot-ok">${isNew ? '新增镜头' : '保存修改'}</button>
      <button class="sc-btn" id="sc-shot-cancel">取消</button>
      <span class="sc-side-sub">保存后会自动重算本集时长偏差并给出告警（不阻断保存）。</span>
    </div>`;
  const modal = ctxRef.modal({ title: isNew ? '新增一镜' : `编辑镜头 #${x.idx}`, body, width: 860 });
  body.querySelector('#sc-shot-cancel').addEventListener('click', () => modal.close());
  body.querySelector('#sc-shot-ok').addEventListener('click', async () => {
    const get = (k) => body.querySelector(`[data-s="${k}"]`)?.value ?? '';
    const payload = {
      scene_no: get('scene_no'), shot_size: get('shot_size'), camera: get('camera'), move: get('move'),
      transition: get('transition'), duration: Number(get('duration')) || 3, time_of_day: get('time_of_day'),
      mood: get('mood'), cost_level: get('cost_level'), location_id: get('location_id'),
      action: get('action'), dialogue: get('dialogue'), sfx: get('sfx'), music: get('music'),
      characters: get('characters').split(/[,，\s]+/).map((z) => z.trim().toUpperCase()).filter(Boolean),
    };
    const pos = get('prompt_pos').trim();
    const neg = get('prompt_neg').trim();
    if (pos) payload.prompt_pos = pos;
    if (neg) payload.prompt_neg = neg;
    if (pos || neg) payload.rebuildPrompt = false;
    try {
      let savedShotId = shot?.id || null;
      if (isNew) {
        const created = await ctxRef.api.post(`/api/scripts/${S.current.id}/shots`, { ...payload, episode: code });
        savedShotId = created?.shot?.id || created?.id || null;
      } else {
        await ctxRef.api.put(`/api/scripts/${S.current.id}/shots/${shot.id}`, payload);
      }
      if (savedShotId) {
        await ctxRef.api.put(`/api/scripts/${S.current.id}/shots/${savedShotId}/performance`, {
          speaker: get('speaker'), emotion: get('emotion'), voiceId: get('voice_id'),
        });
      }
      modal.close();
      toast(isNew ? '已新增镜头' : '已保存镜头', 'ok');
      await loadEpisodeShots(S.episodeCode, true);
      await selectScript(S.current.id, true);
    } catch (e) { toast(`保存失败：${e.message}`, 'err'); }
  });
}
