// 资产库：角色 / 场景 / 道具 / 服装 + 版本回退 + 集级冻结快照
// 约定：只使用 ctx.api / ctx.toast / ctx.confirm / ctx.modal / ctx.go；类名统一 asset- 前缀。

const STYLE_ID = 'asset-library-style';
const TYPE_ORDER = ['role', 'scene', 'prop', 'costume'];
const TYPE_META = {
  role: { label: '角色', icon: '👤', hint: '人物、身份与造型设定' },
  scene: { label: '场景', icon: '🏙️', hint: '地点、空间与时间氛围' },
  prop: { label: '道具', icon: '🗝️', hint: '关键物件与剧情道具' },
  costume: { label: '服装', icon: '👘', hint: '服装、配饰与材质设定' },
};
const TYPE_ALIASES = new Map([
  ['role', 'role'], ['character', 'role'], ['角色', 'role'], ['人物', 'role'],
  ['scene', 'scene'], ['场景', 'scene'],
  ['prop', 'prop'], ['道具', 'prop'],
  ['costume', 'costume'], ['服装', 'costume'],
]);

const CSS = `
.asset-shell { height:100%; min-height:0; box-sizing:border-box; padding:16px; display:flex; flex-direction:column; gap:12px; color:var(--text); overflow:hidden; }
.asset-topbar { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; flex-wrap:wrap; }
.asset-title { margin:0; font-size:22px; letter-spacing:.3px; }
.asset-subtitle { margin-top:5px; color:var(--muted); font-size:12px; line-height:1.65; max-width:760px; }
.asset-actions { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.asset-btn { appearance:none; border:1px solid var(--line); background:var(--panel-2,var(--panel)); color:var(--text); border-radius:8px; padding:7px 11px; font:inherit; font-size:12px; cursor:pointer; transition:.15s; white-space:nowrap; }
.asset-btn:hover:not(:disabled) { border-color:var(--accent); background:var(--panel-3,var(--panel-2)); }
.asset-btn:focus-visible, .asset-card-main:focus-visible, .asset-version-main:focus-visible, .asset-tab:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.asset-btn:disabled { opacity:.42; cursor:not-allowed; }
.asset-btn-primary { border-color:transparent; background:linear-gradient(135deg,var(--accent),#5b76e6); color:#fff; font-weight:650; }
.asset-btn-accent { border-color:rgba(165,107,255,.45); background:rgba(165,107,255,.15); color:#d9c8ff; }
.asset-btn-danger { border-color:rgba(255,95,109,.36); color:#ffb3b9; }
.asset-btn-ghost { background:transparent; }
.asset-btn-small { padding:4px 8px; border-radius:7px; font-size:11px; }
.asset-tabs { display:flex; align-items:center; gap:6px; flex-wrap:wrap; border-bottom:1px solid var(--line); padding-bottom:9px; }
.asset-tab { border:1px solid transparent; background:transparent; color:var(--muted); border-radius:9px; padding:7px 12px; font:inherit; font-size:12.5px; cursor:pointer; display:flex; align-items:center; gap:7px; }
.asset-tab:hover { background:var(--panel-2,var(--panel)); color:var(--text); }
.asset-tab-on { background:rgba(109,140,255,.14); border-color:rgba(109,140,255,.36); color:#c9d5ff; }
.asset-tab-count { min-width:20px; text-align:center; padding:1px 6px; border-radius:999px; background:var(--panel-3,var(--panel)); color:var(--muted); font-size:10.5px; font-variant-numeric:tabular-nums; }
.asset-tab-on .asset-tab-count { background:rgba(109,140,255,.2); color:#dbe3ff; }
.asset-layout { flex:1; min-height:0; display:grid; grid-template-columns:minmax(275px,.82fr) minmax(390px,1.38fr) minmax(280px,.88fr); gap:12px; }
.asset-panel { min-width:0; min-height:0; border:1px solid var(--line); border-radius:12px; background:var(--panel); overflow:hidden; display:flex; flex-direction:column; }
.asset-panel-head { padding:11px 12px; border-bottom:1px solid var(--line); display:flex; align-items:center; justify-content:space-between; gap:9px; background:linear-gradient(180deg,rgba(109,140,255,.055),transparent); }
.asset-panel-title { font-size:13px; font-weight:700; display:flex; align-items:center; gap:7px; }
.asset-panel-sub { color:var(--muted); font-size:10.5px; font-variant-numeric:tabular-nums; }
.asset-list-tools { padding:9px; border-bottom:1px solid var(--line); display:flex; gap:7px; }
.asset-input, .asset-select, .asset-textarea { box-sizing:border-box; width:100%; border:1px solid var(--line); border-radius:8px; background:var(--bg-2,var(--panel)); color:var(--text); padding:7px 9px; font:inherit; font-size:12px; outline:none; transition:.15s; }
.asset-input:focus, .asset-select:focus, .asset-textarea:focus { border-color:var(--accent); box-shadow:0 0 0 3px rgba(109,140,255,.13); }
.asset-textarea { resize:vertical; line-height:1.6; }
.asset-search { flex:1; min-width:0; }
.asset-list-body { flex:1; min-height:0; display:flex; flex-direction:column; }
.asset-list-scroll { flex:1; overflow:auto; padding:8px; display:flex; flex-direction:column; gap:7px; min-height:0; }
.asset-card { position:relative; display:flex; align-items:stretch; border:1px solid var(--line); border-radius:10px; background:var(--panel-2,var(--panel)); overflow:hidden; transition:.14s; }
.asset-card:hover { border-color:rgba(109,140,255,.5); transform:translateY(-1px); }
.asset-card-on { border-color:rgba(109,140,255,.78); background:linear-gradient(135deg,rgba(109,140,255,.15),rgba(165,107,255,.06)); box-shadow:inset 3px 0 0 var(--accent); }
.asset-card-main { flex:1; min-width:0; appearance:none; border:0; background:transparent; color:inherit; text-align:left; padding:9px 8px 9px 10px; display:flex; gap:9px; cursor:pointer; font:inherit; }
.asset-card-icon { width:32px; height:32px; flex:0 0 32px; border-radius:9px; display:grid; place-items:center; background:rgba(109,140,255,.11); font-size:17px; }
.asset-card-copy { min-width:0; flex:1; }
.asset-card-name { font-size:12.5px; font-weight:680; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.asset-card-desc { margin-top:3px; color:var(--muted); font-size:10.5px; line-height:1.45; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; overflow-wrap:anywhere; }
.asset-card-meta { margin-top:5px; color:var(--muted-2,var(--muted)); font-size:10px; display:flex; gap:7px; flex-wrap:wrap; }
.asset-card-edit { align-self:flex-start; margin:7px 7px 0 0; }
.asset-count-pill, .asset-state-pill { display:inline-flex; align-items:center; gap:4px; padding:2px 7px; border-radius:999px; font-size:10px; background:var(--panel-3,var(--panel)); color:var(--muted); white-space:nowrap; }
.asset-state-pill-ok { background:rgba(53,208,127,.14); color:#9ff0c4; }
.asset-state-pill-warn { background:rgba(245,181,68,.15); color:#ffd894; }
.asset-state-pill-err { background:rgba(255,95,109,.15); color:#ffb3b9; }
.asset-state-pill-neutral { background:rgba(109,140,255,.12); color:#c5d0ff; }
.asset-detail-scroll, .asset-snapshot-scroll { flex:1; min-height:0; overflow:auto; padding:13px; }
.asset-detail { display:flex; flex-direction:column; gap:13px; }
.asset-detail-head { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; }
.asset-detail-name { font-size:18px; font-weight:760; line-height:1.35; overflow-wrap:anywhere; }
.asset-detail-description { color:var(--text); opacity:.82; font-size:12px; line-height:1.7; white-space:pre-wrap; overflow-wrap:anywhere; }
.asset-kv { display:grid; grid-template-columns:82px minmax(0,1fr); gap:6px 10px; font-size:11px; }
.asset-kv-key { color:var(--muted); }
.asset-kv-value { min-width:0; overflow-wrap:anywhere; color:var(--text); opacity:.9; font-family:var(--mono,ui-monospace,monospace); }
.asset-divider { height:1px; background:var(--line); }
.asset-section-head { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:9px; }
.asset-section-title { font-size:12.5px; font-weight:720; display:flex; align-items:center; gap:6px; }
.asset-version-list { display:flex; flex-direction:column; gap:7px; }
.asset-version-row { display:flex; align-items:stretch; border:1px solid var(--line); border-radius:9px; overflow:hidden; background:var(--panel-2,var(--panel)); }
.asset-version-row-current { border-color:rgba(53,208,127,.33); background:rgba(53,208,127,.045); }
.asset-version-main { flex:1; min-width:0; appearance:none; border:0; background:transparent; color:inherit; text-align:left; padding:8px 9px; cursor:pointer; font:inherit; }
.asset-version-line { display:flex; align-items:center; gap:7px; flex-wrap:wrap; font-size:11.5px; font-weight:650; }
.asset-version-meta { margin-top:4px; color:var(--muted); font-size:10px; display:flex; gap:8px; flex-wrap:wrap; }
.asset-version-actions { display:flex; align-items:center; padding:6px; }
.asset-version-detail { border:1px solid var(--line); border-radius:10px; padding:10px; background:rgba(7,11,18,.34); }
.asset-json { margin:0; padding:8px 9px; border-radius:7px; background:#070b12; border:1px solid rgba(255,255,255,.05); color:#bdcbed; font-family:var(--mono,ui-monospace,monospace); font-size:10.5px; line-height:1.55; white-space:pre-wrap; overflow-wrap:anywhere; max-height:180px; overflow:auto; }
.asset-ref-list { display:flex; gap:5px; flex-wrap:wrap; margin-top:7px; }
.asset-ref { max-width:100%; padding:2px 7px; border-radius:6px; background:var(--panel-3,var(--panel)); color:var(--muted); font-size:10px; overflow-wrap:anywhere; }
.asset-snapshot-status { border:1px solid var(--line); border-radius:11px; padding:11px; margin-bottom:11px; background:linear-gradient(145deg,rgba(109,140,255,.09),rgba(7,11,18,.2)); }
.asset-snapshot-status-frozen { border-color:rgba(53,208,127,.35); background:linear-gradient(145deg,rgba(53,208,127,.1),rgba(7,11,18,.2)); }
.asset-snapshot-status-error { border-color:rgba(255,95,109,.35); background:linear-gradient(145deg,rgba(255,95,109,.08),rgba(7,11,18,.2)); }
.asset-snapshot-status-pending { border-color:rgba(245,181,68,.35); background:linear-gradient(145deg,rgba(245,181,68,.08),rgba(7,11,18,.2)); }
.asset-snapshot-status-title { display:flex; align-items:center; justify-content:space-between; gap:8px; font-size:12px; font-weight:700; }
.asset-snapshot-status-main { margin-top:7px; font-size:11.5px; line-height:1.55; overflow-wrap:anywhere; }
.asset-snapshot-status-meta { margin-top:6px; color:var(--muted); font-size:10px; display:flex; gap:8px; flex-wrap:wrap; }
.asset-snapshot-list { display:flex; flex-direction:column; gap:7px; }
.asset-snapshot-row { border:1px solid var(--line); border-radius:9px; padding:8px 9px; background:var(--panel-2,var(--panel)); }
.asset-snapshot-row-head { display:flex; align-items:center; justify-content:space-between; gap:7px; }
.asset-snapshot-episode { font-size:11.5px; font-weight:680; overflow-wrap:anywhere; }
.asset-snapshot-note { margin-top:5px; color:var(--muted); font-size:10.5px; line-height:1.5; overflow-wrap:anywhere; }
.asset-empty, .asset-error, .asset-loading { flex:1; min-height:140px; display:flex; align-items:center; justify-content:center; padding:22px; text-align:center; }
.asset-empty-box, .asset-error-box, .asset-loading-box { max-width:350px; display:flex; flex-direction:column; align-items:center; gap:8px; }
.asset-empty-icon, .asset-error-icon { font-size:30px; line-height:1; }
.asset-empty-title, .asset-error-title { font-size:13px; font-weight:700; }
.asset-empty-text, .asset-error-text, .asset-loading-text { color:var(--muted); font-size:11px; line-height:1.65; overflow-wrap:anywhere; }
.asset-error-box { border:1px solid rgba(255,95,109,.28); background:rgba(255,95,109,.055); border-radius:10px; padding:15px; width:100%; box-sizing:border-box; }
.asset-spinner { width:21px; height:21px; border-radius:50%; border:2px solid rgba(109,140,255,.2); border-top-color:var(--accent); animation:asset-spin .8s linear infinite; }
.asset-skeleton { border-radius:9px; background:linear-gradient(90deg,rgba(255,255,255,.035),rgba(255,255,255,.08),rgba(255,255,255,.035)); background-size:220% 100%; animation:asset-shimmer 1.25s linear infinite; }
.asset-skeleton-card { height:67px; }
.asset-skeleton-line { height:12px; margin:9px 0; }
.asset-form { display:flex; flex-direction:column; gap:11px; }
.asset-form-grid { display:grid; grid-template-columns:minmax(0,1fr) minmax(160px,.42fr); gap:10px; }
.asset-field { display:flex; flex-direction:column; gap:5px; min-width:0; }
.asset-field-label { color:var(--muted); font-size:11px; display:flex; align-items:center; gap:5px; }
.asset-field-help { color:var(--muted-2,var(--muted)); font-size:10px; line-height:1.5; }
.asset-form-error { display:none; border:1px solid rgba(255,95,109,.35); background:rgba(255,95,109,.08); color:#ffb3b9; border-radius:8px; padding:8px 10px; font-size:11.5px; line-height:1.55; overflow-wrap:anywhere; }
.asset-form-error-on { display:block; }
.asset-modal-hint { border:1px solid rgba(109,140,255,.18); background:rgba(109,140,255,.06); border-radius:8px; padding:8px 10px; color:var(--muted); font-size:10.5px; line-height:1.6; }
.asset-mono { font-family:var(--mono,ui-monospace,monospace); }
.asset-muted { color:var(--muted); }
.asset-small { font-size:10.5px; }
.asset-wrap-any { overflow-wrap:anywhere; min-width:0; }
@keyframes asset-spin { to { transform:rotate(360deg); } }
@keyframes asset-shimmer { 0% { background-position:100% 0; } 100% { background-position:-100% 0; } }
@media (max-width:1180px) {
  .asset-layout { grid-template-columns:minmax(260px,.75fr) minmax(390px,1.25fr); }
  .asset-snapshot-panel { grid-column:1 / -1; min-height:230px; max-height:290px; }
  .asset-snapshot-scroll { display:grid; grid-template-columns:minmax(230px,.65fr) minmax(300px,1.35fr); gap:12px; align-content:start; }
  .asset-snapshot-status { margin-bottom:0; }
}
@media (max-width:760px) {
  .asset-shell { height:auto; min-height:100%; padding:11px; overflow:auto; }
  .asset-title { font-size:19px; }
  .asset-actions { width:100%; }
  .asset-actions .asset-btn { flex:1; }
  .asset-layout { display:flex; flex-direction:column; }
  .asset-panel { min-height:300px; }
  .asset-list-panel { max-height:390px; }
  .asset-snapshot-panel { max-height:none; }
  .asset-snapshot-scroll { display:block; }
  .asset-snapshot-status { margin-bottom:11px; }
  .asset-form-grid { grid-template-columns:1fr; }
}
`;

let rootEl = null;
let ctxRef = null;
let state = blankState();
let lifecycle = 0;
let abortController = null;
const openDialogs = new Set();

function blankState() {
  return {
    selectedType: 'role',
    search: '',
    assets: [],
    assetStatus: 'loading',
    assetError: '',
    selectedId: '',
    versionStatus: 'idle',
    versions: [],
    versionError: '',
    selectedVersionNo: null,
    rollbackBusy: null,
    snapshotStatus: 'loading',
    snapshots: [],
    snapshotError: '',
  };
}

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.append(style);
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function normalizeType(value) {
  return TYPE_ALIASES.get(String(value ?? '').trim().toLowerCase()) || 'role';
}

function typeMeta(type) {
  return TYPE_META[normalizeType(type)] || TYPE_META.role;
}

function fmtTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('zh-CN', { hour12: false });
}

function parseMaybeJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function jsonForEditor(value, fallback) {
  if (value === null || value === undefined || value === '') return JSON.stringify(fallback, null, 2);
  if (typeof value === 'string') {
    try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
  }
  try { return JSON.stringify(value, null, 2); } catch { return JSON.stringify(fallback, null, 2); }
}

function prettyJson(value) {
  if (value === null || value === undefined || value === '') return '{}';
  if (typeof value === 'string') {
    try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
  }
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function refImagesOf(value) {
  const parsed = parseMaybeJson(value, value);
  if (Array.isArray(parsed)) return parsed.map((item) => String(item)).filter(Boolean);
  if (typeof parsed === 'string' && parsed.trim()) return [parsed.trim()];
  return [];
}

function extractList(payload, keys = []) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  const candidates = [...keys, 'data', 'result'];
  for (const key of candidates) {
    const value = payload[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') {
      const nested = extractList(value, keys);
      if (nested.length) return nested;
    }
  }
  return [];
}

function extractEntity(payload, keys = []) {
  if (!payload || typeof payload !== 'object') return null;
  for (const key of [...keys, 'data', 'result']) {
    const value = payload[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (value.id || value.asset_id || value.version_no || value.episode) return value;
      const nested = extractEntity(value, keys);
      if (nested) return nested;
    }
  }
  return payload.id || payload.asset_id ? payload : null;
}

function normalizeAsset(raw) {
  const item = raw && typeof raw === 'object' ? raw : {};
  return {
    id: String(item.id ?? item.asset_id ?? ''),
    type: normalizeType(item.type ?? item.asset_type ?? item.kind),
    name: String(item.name ?? item.title ?? '未命名资产'),
    description: String(item.description ?? item.summary ?? ''),
    projectId: item.project_id ?? item.projectId ?? '',
    currentVersion: Number(item.current_version ?? item.currentVersion ?? item.version ?? 1) || 1,
    params: parseMaybeJson(item.params, item.params ?? {}),
    refImages: refImagesOf(item.ref_images ?? item.refImages),
    createdAt: item.created_at ?? item.createdAt ?? '',
    updatedAt: item.updated_at ?? item.updatedAt ?? '',
    raw: item,
  };
}

function normalizeVersion(raw) {
  const item = raw && typeof raw === 'object' ? raw : {};
  return {
    id: String(item.id ?? item.version_id ?? ''),
    assetId: String(item.asset_id ?? item.assetId ?? ''),
    versionNo: Number(item.version_no ?? item.versionNo ?? item.version ?? item.no ?? 0) || 0,
    refImages: refImagesOf(item.ref_images ?? item.refImages),
    fingerprint: String(item.fingerprint ?? ''),
    params: parseMaybeJson(item.params, item.params ?? {}),
    createdAt: item.created_at ?? item.createdAt ?? '',
    raw: item,
  };
}

function normalizeSnapshot(raw) {
  const item = raw && typeof raw === 'object' ? raw : {};
  const assets = extractList(item, ['assets', 'asset_versions', 'versions']);
  const ids = item.asset_ids ?? item.assetIds;
  const fallbackCount = Array.isArray(assets) && assets.length
    ? assets.length
    : (Array.isArray(ids) ? ids.length : 0);
  return {
    id: String(item.id ?? item.snapshot_id ?? ''),
    scriptId: String(item.script_id ?? item.scriptId ?? ''),
    episode: String(item.code ?? item.episode ?? item.episode_code ?? item.episodeCode ?? item.episode_id ?? item.episodeId ?? '未标注集'),
    status: String(item.status ?? item.state ?? ''),
    note: String(item.note ?? item.remark ?? item.description ?? ''),
    assetCount: Number(item.asset_count ?? item.assetCount ?? fallbackCount) || 0,
    createdAt: item.frozen_at ?? item.frozenAt ?? item.created_at ?? item.createdAt ?? '',
    raw: item,
  };
}

function selectedAsset() {
  return state.assets.find((asset) => asset.id === state.selectedId) || null;
}

function assetsOfType(type) {
  return state.assets.filter((asset) => asset.type === type);
}

function isAlive(token) {
  return Boolean(rootEl && token === lifecycle);
}

function render() {
  if (!rootEl) return;
  rootEl.innerHTML = `
    <div class="asset-shell" data-asset-view>
      <header class="asset-topbar">
        <div>
          <h2 class="asset-title">资产库</h2>
          <div class="asset-subtitle">统一管理角色、场景、道具与服装；每次编辑自动生成新版本，集级快照冻结开拍时的资产版本。</div>
        </div>
        <div class="asset-actions">
          <button type="button" class="asset-btn asset-btn-ghost" data-asset-action="refresh">↻ 刷新</button>
          <button type="button" class="asset-btn asset-btn-accent" data-asset-action="snapshot-open">📸 冻结快照</button>
          <button type="button" class="asset-btn asset-btn-primary" data-asset-action="create">＋ 新建资产</button>
        </div>
      </header>
      ${renderTabs()}
      <div class="asset-layout">
        <section class="asset-panel asset-list-panel">
          <div class="asset-panel-head">
            <div class="asset-panel-title">${typeMeta(state.selectedType).icon} ${typeMeta(state.selectedType).label}资产</div>
            <div class="asset-panel-sub">${assetsOfType(state.selectedType).length} 项</div>
          </div>
          <div id="asset-list-host">${renderListHost()}</div>
        </section>
        <section class="asset-panel asset-detail-panel">
          <div class="asset-panel-head">
            <div class="asset-panel-title">版本与详情</div>
            <div class="asset-panel-sub">${state.selectedId ? '版本只增不改' : '选择左侧资产'}</div>
          </div>
          <div class="asset-detail-scroll">${renderDetail()}</div>
        </section>
        <aside class="asset-panel asset-snapshot-panel">
          <div class="asset-panel-head">
            <div class="asset-panel-title">集级快照</div>
            <button type="button" class="asset-btn asset-btn-ghost asset-btn-small" data-asset-action="snapshot-refresh">刷新</button>
          </div>
          <div class="asset-snapshot-scroll">${renderSnapshotPanel()}</div>
        </aside>
      </div>
    </div>`;
}

function renderTabs() {
  return `<nav class="asset-tabs" aria-label="资产类型">
    ${TYPE_ORDER.map((type) => {
      const meta = TYPE_META[type];
      return `<button type="button" class="asset-tab${state.selectedType === type ? ' asset-tab-on' : ''}" data-asset-action="tab" data-type="${type}" aria-selected="${state.selectedType === type}">
        <span>${meta.icon}</span><span>${meta.label}</span><span class="asset-tab-count">${assetsOfType(type).length}</span>
      </button>`;
    }).join('')}
  </nav>`;
}

function renderListHost() {
  if (state.assetStatus === 'loading') {
    return `<div class="asset-list-scroll" aria-live="polite">
      ${Array.from({ length: 5 }, () => '<div class="asset-skeleton asset-skeleton-card"></div>').join('')}
      <div class="asset-loading-text">正在读取资产库…</div>
    </div>`;
  }
  if (state.assetStatus === 'error') {
    return `<div class="asset-error" aria-live="polite"><div class="asset-error-box">
      <div class="asset-error-icon">⚠️</div>
      <div class="asset-error-title">资产列表读取失败</div>
      <div class="asset-error-text">${esc(state.assetError || '请检查后端接口后重试')}</div>
      <button type="button" class="asset-btn" data-asset-action="retry-assets">重新加载</button>
    </div></div>`;
  }

  return `<div class="asset-list-tools">
      <input class="asset-input asset-search" data-asset-search type="search" value="${esc(state.search)}" placeholder="搜索名称 / 描述 / 参数" aria-label="搜索资产" />
      <button type="button" class="asset-btn asset-btn-small" data-asset-action="create">＋ 新建</button>
    </div>
    <div class="asset-list-body" data-asset-list-body>${renderAssetListBody()}</div>`;
}

function renderAssetListBody() {
  const all = assetsOfType(state.selectedType);
  const keyword = state.search.trim().toLowerCase();
  const filtered = keyword ? all.filter((asset) => {
    const haystack = `${asset.name} ${asset.description} ${prettyJson(asset.params)} ${asset.id}`.toLowerCase();
    return haystack.includes(keyword);
  }) : all;
  const meta = typeMeta(state.selectedType);
  return `<div class="asset-list-scroll" aria-live="polite">
      ${filtered.length ? filtered.map(renderAssetCard).join('') : `<div class="asset-empty"><div class="asset-empty-box">
        <div class="asset-empty-icon">${keyword ? '🔎' : meta.icon}</div>
        <div class="asset-empty-title">${keyword ? '没有匹配的资产' : `还没有${meta.label}资产`}</div>
        <div class="asset-empty-text">${keyword ? '换个关键词试试，清空搜索可查看全部资产。' : meta.hint + '；新建后会立即生成 v1 版本。'}</div>
        ${keyword ? '<button type="button" class="asset-btn" data-asset-action="clear-search">清空搜索</button>' : '<button type="button" class="asset-btn asset-btn-primary" data-asset-action="create">新建第一项</button>'}
      </div></div>`}
    </div>`;
}

function renderAssetCard(asset) {
  const meta = typeMeta(asset.type);
  return `<article class="asset-card${asset.id === state.selectedId ? ' asset-card-on' : ''}">
    <button type="button" class="asset-card-main" data-asset-action="select" data-id="${esc(asset.id)}" title="查看 ${esc(asset.name)} 的版本">
      <span class="asset-card-icon">${meta.icon}</span>
      <span class="asset-card-copy">
        <span class="asset-card-name">${esc(asset.name)}</span>
        <span class="asset-card-desc">${esc(asset.description || '暂无描述')}</span>
        <span class="asset-card-meta"><span class="asset-count-pill">v${asset.currentVersion}</span><span>${esc(fmtTime(asset.updatedAt))}</span></span>
      </span>
    </button>
    <button type="button" class="asset-btn asset-btn-small asset-btn-ghost asset-card-edit" data-asset-action="edit" data-id="${esc(asset.id)}">编辑</button>
  </article>`;
}

function renderDetail() {
  const asset = selectedAsset();
  if (!asset) {
    return `<div class="asset-empty"><div class="asset-empty-box">
      <div class="asset-empty-icon">🧩</div>
      <div class="asset-empty-title">选择一个资产查看详情</div>
      <div class="asset-empty-text">点击左侧资产可读取完整版本链；历史版本可回退为当前版本，但不会被删除。</div>
      <button type="button" class="asset-btn" data-asset-action="create">新建资产</button>
    </div></div>`;
  }

  const meta = typeMeta(asset.type);
  const current = Number(asset.currentVersion) || 1;
  return `<div class="asset-detail">
    <div class="asset-detail-head">
      <div class="asset-wrap-any">
        <div class="asset-detail-name">${meta.icon} ${esc(asset.name)}</div>
        <div class="asset-card-meta"><span class="asset-state-pill asset-state-pill-neutral">${meta.label}</span><span class="asset-count-pill">当前 v${current}</span></div>
      </div>
      <button type="button" class="asset-btn asset-btn-small" data-asset-action="edit" data-id="${esc(asset.id)}">编辑并生成新版本</button>
    </div>
    <div class="asset-detail-description">${esc(asset.description || '暂无描述')}</div>
    <div class="asset-kv">
      <div class="asset-kv-key">资产 ID</div><div class="asset-kv-value">${esc(asset.id || '—')}</div>
      <div class="asset-kv-key">项目 ID</div><div class="asset-kv-value">${esc(asset.projectId || '未绑定项目')}</div>
      <div class="asset-kv-key">更新时间</div><div class="asset-kv-value">${esc(fmtTime(asset.updatedAt))}</div>
    </div>
    <div class="asset-divider"></div>
    <div>
      <div class="asset-section-head">
        <div class="asset-section-title">📚 版本历史 <span class="asset-muted asset-small">${state.versionStatus === 'ready' ? `${state.versions.length} 个版本` : ''}</span></div>
        <button type="button" class="asset-btn asset-btn-small asset-btn-ghost" data-asset-action="retry-versions">刷新</button>
      </div>
      ${renderVersions(asset)}
    </div>
  </div>`;
}

function renderVersions(asset) {
  if (state.versionStatus === 'loading' || state.versionStatus === 'idle') {
    return `<div class="asset-skeleton asset-skeleton-line"></div><div class="asset-skeleton asset-skeleton-line"></div><div class="asset-loading-text">正在读取版本链…</div>`;
  }
  if (state.versionStatus === 'error') {
    return `<div class="asset-error-box">
      <div class="asset-error-icon">⚠️</div>
      <div class="asset-error-title">版本列表读取失败</div>
      <div class="asset-error-text">${esc(state.versionError || '请稍后重试')}</div>
      <button type="button" class="asset-btn asset-btn-small" data-asset-action="retry-versions">重新加载</button>
    </div>`;
  }
  if (!state.versions.length) {
    return `<div class="asset-empty" style="min-height:90px"><div class="asset-empty-box">
      <div class="asset-empty-title">暂无版本记录</div>
      <div class="asset-empty-text">后端尚未返回该资产的版本，可刷新后重试。</div>
    </div></div>`;
  }

  const current = Number(asset.currentVersion) || 1;
  const selected = state.versions.find((version) => version.versionNo === state.selectedVersionNo)
    || state.versions.find((version) => version.versionNo === current)
    || state.versions[0];
  const rows = state.versions.map((version) => {
    const isCurrent = version.versionNo === current;
    const isPreview = selected && version.versionNo === selected.versionNo;
    return `<div class="asset-version-row${isCurrent ? ' asset-version-row-current' : ''}">
      <button type="button" class="asset-version-main" data-asset-action="version" data-version-no="${version.versionNo}" aria-pressed="${isPreview}">
        <span class="asset-version-line">v${version.versionNo}
          ${isCurrent ? '<span class="asset-state-pill asset-state-pill-ok">当前版本</span>' : ''}
          ${isPreview ? '<span class="asset-state-pill asset-state-pill-neutral">预览中</span>' : ''}
        </span>
        <span class="asset-version-meta"><span>${esc(fmtTime(version.createdAt))}</span><span>${version.refImages.length} 张参考图</span>${version.fingerprint ? `<span class="asset-mono">${esc(version.fingerprint.slice(0, 12))}</span>` : ''}</span>
      </button>
      <span class="asset-version-actions">
        ${isCurrent
          ? '<span class="asset-muted asset-small">已启用</span>'
          : `<button type="button" class="asset-btn asset-btn-small${state.rollbackBusy === version.versionNo ? ' asset-btn-primary' : ''}" data-asset-action="rollback" data-version-no="${version.versionNo}"${state.rollbackBusy !== null ? ' disabled' : ''}>${state.rollbackBusy === version.versionNo ? '回退中…' : '回退到此版本'}</button>`}
      </span>
    </div>`;
  }).join('');

  const refs = selected?.refImages?.length
    ? selected.refImages.map((ref) => `<span class="asset-ref">${esc(ref)}</span>`).join('')
    : '<span class="asset-muted asset-small">未关联参考图</span>';

  return `<div class="asset-version-list">${rows}</div>
    <div class="asset-version-detail" style="margin-top:9px">
      <div class="asset-section-head"><div class="asset-section-title">v${selected?.versionNo ?? '—'} 快照内容</div><span class="asset-muted asset-small">${selected?.fingerprint ? `指纹 ${esc(selected.fingerprint.slice(0, 16))}` : '无指纹'}</span></div>
      <pre class="asset-json">${esc(prettyJson(selected?.params ?? {}))}</pre>
      <div class="asset-ref-list">${refs}</div>
    </div>`;
}

function snapshotState(snapshot) {
  const raw = String(snapshot?.status || '').trim().toLowerCase();
  if (['frozen', 'ready', 'done', 'complete', 'completed', 'success', 'active'].includes(raw)) {
    return { label: '已冻结', className: 'asset-state-pill-ok', card: 'asset-snapshot-status-frozen' };
  }
  if (['failed', 'error', 'canceled', 'cancelled'].includes(raw)) {
    return { label: '冻结失败', className: 'asset-state-pill-err', card: 'asset-snapshot-status-error' };
  }
  if (['pending', 'creating', 'running', 'processing'].includes(raw)) {
    return { label: '冻结中', className: 'asset-state-pill-warn', card: 'asset-snapshot-status-pending' };
  }
  return { label: snapshot?.id ? '已冻结' : '未冻结', className: 'asset-state-pill-neutral', card: 'asset-snapshot-status' };
}

function renderSnapshotPanel() {
  if (state.snapshotStatus === 'loading') {
    return `<div class="asset-loading"><div class="asset-loading-box"><div class="asset-spinner"></div><div class="asset-loading-text">正在读取快照状态…</div></div></div>`;
  }
  if (state.snapshotStatus === 'error') {
    return `<div class="asset-error"><div class="asset-error-box">
      <div class="asset-error-icon">⚠️</div>
      <div class="asset-error-title">快照状态读取失败</div>
      <div class="asset-error-text">${esc(state.snapshotError || '请检查快照接口后重试')}</div>
      <button type="button" class="asset-btn" data-asset-action="retry-snapshots">重新加载</button>
    </div></div>`;
  }

  const latest = state.snapshots[0];
  const badge = snapshotState(latest);
  const statusCard = latest
    ? `<div class="asset-snapshot-status ${badge.card}">
        <div class="asset-snapshot-status-title"><span>当前快照状态</span><span class="asset-state-pill ${badge.className}">${esc(badge.label)}</span></div>
        <div class="asset-snapshot-status-main"><b>${esc(latest.episode)}</b>${latest.assetCount ? ` · 冻结 ${latest.assetCount} 项资产` : ''}</div>
        <div class="asset-snapshot-status-meta"><span>${esc(fmtTime(latest.createdAt))}</span>${latest.note ? `<span>${esc(latest.note)}</span>` : ''}</div>
      </div>`
    : `<div class="asset-snapshot-status">
        <div class="asset-snapshot-status-title"><span>当前快照状态</span><span class="asset-state-pill asset-state-pill-neutral">尚未冻结</span></div>
        <div class="asset-snapshot-status-main">还没有集级快照</div>
        <div class="asset-snapshot-status-meta">开拍前冻结当前资产版本，后续修改不会影响已锁定集。</div>
      </div>`;

  const rows = state.snapshots.map((snapshot) => {
    const info = snapshotState(snapshot);
    return `<div class="asset-snapshot-row">
      <div class="asset-snapshot-row-head"><span class="asset-snapshot-episode">${esc(snapshot.episode)}</span><span class="asset-state-pill ${info.className}">${esc(info.label)}</span></div>
      <div class="asset-snapshot-status-meta"><span>${snapshot.assetCount || 0} 项资产</span>${snapshot.scriptId ? `<span>剧本 ${esc(snapshot.scriptId)}</span>` : ''}<span>${esc(fmtTime(snapshot.createdAt))}</span></div>
      ${snapshot.note ? `<div class="asset-snapshot-note">${esc(snapshot.note)}</div>` : ''}
    </div>`;
  }).join('');

  return `${statusCard}
    <div class="asset-section-head"><div class="asset-section-title">🗂️ 快照记录</div><span class="asset-panel-sub">${state.snapshots.length} 条</span></div>
    ${rows ? `<div class="asset-snapshot-list">${rows}</div>` : `<div class="asset-empty" style="min-height:95px"><div class="asset-empty-box">
      <div class="asset-empty-title">暂无快照记录</div>
      <div class="asset-empty-text">点击顶部「冻结快照」，填写剧本 ID 与集编号后即可锁定当前资产版本。</div>
    </div></div>`}`;
}

async function loadAssets({ silent = false } = {}) {
  const token = lifecycle;
  if (!silent) {
    state.assetStatus = 'loading';
    state.assetError = '';
    render();
  }
  try {
    const payload = await ctxRef.api.get('/api/assets');
    if (!isAlive(token)) return false;
    const rows = extractList(payload, ['assets', 'items', 'rows']);
    state.assets = rows.map(normalizeAsset).filter((asset) => asset.id);
    state.assetStatus = 'ready';
    state.assetError = '';
    if (state.selectedId && !state.assets.some((asset) => asset.id === state.selectedId)) {
      state.selectedId = '';
      state.versionStatus = 'idle';
      state.versions = [];
      state.selectedVersionNo = null;
    }
    render();
    return true;
  } catch (error) {
    if (!isAlive(token)) return false;
    state.assetStatus = 'error';
    state.assetError = error?.message || String(error);
    render();
    return false;
  }
}

async function loadVersions(assetId, { silent = false } = {}) {
  const token = lifecycle;
  if (!assetId) return;
  if (!silent) {
    state.versionStatus = 'loading';
    state.versionError = '';
    render();
  }
  try {
    const payload = await ctxRef.api.get(`/api/assets/${encodeURIComponent(assetId)}/versions`);
    if (!isAlive(token) || state.selectedId !== assetId) return;
    state.versions = extractList(payload, ['versions', 'items', 'rows'])
      .map(normalizeVersion)
      .filter((version) => version.versionNo > 0)
      .sort((a, b) => b.versionNo - a.versionNo);
    state.versionStatus = 'ready';
    state.versionError = '';
    const asset = selectedAsset();
    const current = Number(asset?.currentVersion) || 1;
    if (!state.versions.some((version) => version.versionNo === state.selectedVersionNo)) {
      state.selectedVersionNo = state.versions.find((version) => version.versionNo === current)?.versionNo
        ?? state.versions[0]?.versionNo
        ?? null;
    }
    render();
  } catch (error) {
    if (!isAlive(token) || state.selectedId !== assetId) return;
    state.versionStatus = 'error';
    state.versionError = error?.message || String(error);
    state.versions = [];
    render();
  }
}

async function loadSnapshots({ silent = false } = {}) {
  const token = lifecycle;
  if (!silent) {
    state.snapshotStatus = 'loading';
    state.snapshotError = '';
    render();
  }
  try {
    const payload = await ctxRef.api.get('/api/assets/snapshot');
    if (!isAlive(token)) return;
    let rows = extractList(payload, ['snapshots', 'items', 'rows']);
    if (!rows.length) {
      const one = extractEntity(payload, ['snapshot']);
      if (one && (one.id || one.script_id || one.scriptId || one.code || one.episode || one.episode_code)) rows = [one];
    }
    state.snapshots = rows.map(normalizeSnapshot).filter((snapshot) => snapshot.id || snapshot.episode !== '未标注集')
      .sort((a, b) => {
        const left = new Date(a.createdAt || 0).getTime() || 0;
        const right = new Date(b.createdAt || 0).getTime() || 0;
        return right - left;
      });
    state.snapshotStatus = 'ready';
    state.snapshotError = '';
    render();
  } catch (error) {
    if (!isAlive(token)) return;
    state.snapshotStatus = 'error';
    state.snapshotError = error?.message || String(error);
    render();
  }
}

async function selectAsset(id) {
  if (!id) return;
  state.selectedId = id;
  state.versionStatus = 'idle';
  state.versions = [];
  state.versionError = '';
  state.selectedVersionNo = null;
  state.rollbackBusy = null;
  render();
  await loadVersions(id);
}

async function rollbackVersion(versionNo) {
  const asset = selectedAsset();
  if (!asset || state.rollbackBusy !== null) return;
  const version = state.versions.find((item) => item.versionNo === Number(versionNo));
  if (!version || version.versionNo === Number(asset.currentVersion)) return;
  const ok = await ctxRef.confirm(`将「${asset.name}」回退到 v${version.versionNo}？当前版本指针会切换，但所有历史版本都会保留。`);
  if (!ok) return;

  const token = lifecycle;
  state.rollbackBusy = version.versionNo;
  render();
  try {
    await ctxRef.api.post(`/api/assets/${encodeURIComponent(asset.id)}/current-version`, { versionNo: version.versionNo });
    if (!isAlive(token)) return;
    ctxRef.toast(`已回退到 v${version.versionNo}`, 'ok');
    await loadAssets({ silent: true });
    if (!isAlive(token) || state.selectedId !== asset.id) return;
    await loadVersions(asset.id, { silent: true });
  } catch (error) {
    if (isAlive(token)) ctxRef.toast(`回退失败：${error?.message || error}`, 'err');
  } finally {
    if (isAlive(token)) {
      state.rollbackBusy = null;
      render();
    }
  }
}

function openAssetForm(asset) {
  if (!ctxRef) return;
  const token = lifecycle;
  const isEdit = Boolean(asset);
  const initialType = asset?.type || state.selectedType;
  const typeOptions = TYPE_ORDER.map((type) => `<option value="${type}"${type === initialType ? ' selected' : ''}>${TYPE_META[type].label}</option>`).join('');
  const body = document.createElement('div');
  body.className = 'asset-form';
  body.innerHTML = `
    <div class="asset-form-grid">
      <label class="asset-field"><span class="asset-field-label">资产名称 <b>必填</b></span><input class="asset-input" data-field="name" type="text" maxlength="200" value="${esc(asset?.name || '')}" placeholder="例如：林越 · 主角定版" /></label>
      <label class="asset-field"><span class="asset-field-label">资产类型</span><select class="asset-select" data-field="type"${isEdit ? ' disabled' : ''}>${typeOptions}</select></label>
    </div>
    <label class="asset-field"><span class="asset-field-label">项目 ID</span><input class="asset-input" data-field="projectId" type="text" value="${esc(asset?.projectId || '')}" placeholder="可选，用于按项目筛选" /></label>
    <label class="asset-field"><span class="asset-field-label">描述</span><textarea class="asset-textarea" data-field="description" rows="3" placeholder="外观、性格、场景氛围、材质或关键剧情用途">${esc(asset?.description || '')}</textarea></label>
    <div class="asset-form-grid">
      <label class="asset-field"><span class="asset-field-label">参数 JSON</span><textarea class="asset-textarea asset-mono" data-field="params" rows="7" spellcheck="false">${esc(jsonForEditor(asset?.params, {}))}</textarea><span class="asset-field-help">保存为对象；每次保存都会生成一个新版本。</span></label>
      <label class="asset-field"><span class="asset-field-label">参考图 JSON 数组</span><textarea class="asset-textarea asset-mono" data-field="refImages" rows="7" spellcheck="false">${esc(JSON.stringify(asset?.refImages || [], null, 2))}</textarea><span class="asset-field-help">示例：["refs/lin-v1.png"]</span></label>
    </div>
    <div class="asset-form-error" data-form-error></div>
    <div class="asset-modal-hint">${isEdit ? `保存后将生成 v${(Number(asset.currentVersion) || 1) + 1}，旧版本仍可查看和回退。` : '创建成功会立即生成 v1 版本。'}</div>`;

  const errorBox = body.querySelector('[data-form-error]');
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'asset-btn';
  cancel.textContent = '取消';
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'asset-btn asset-btn-primary';
  save.textContent = isEdit ? '保存并生成新版本' : '创建资产';

  const dialog = ctxRef.modal({
    title: isEdit ? '编辑资产' : `新建${typeMeta(initialType).label}资产`,
    body,
    width: 700,
    footer: [cancel, save],
    onClose: () => openDialogs.delete(dialog),
  });
  openDialogs.add(dialog);
  cancel.addEventListener('click', () => dialog.close());

  const showError = (message) => {
    errorBox.textContent = message;
    errorBox.classList.add('asset-form-error-on');
    errorBox.scrollIntoView({ block: 'nearest' });
  };

  const submit = async () => {
    if (save.disabled) return;
    errorBox.classList.remove('asset-form-error-on');
    const name = body.querySelector('[data-field="name"]').value.trim();
    const type = body.querySelector('[data-field="type"]').value;
    const projectId = body.querySelector('[data-field="projectId"]').value.trim();
    const description = body.querySelector('[data-field="description"]').value;
    if (!name) {
      showError('资产名称不能为空。');
      return;
    }

    let params;
    let refImages;
    try {
      const paramsText = body.querySelector('[data-field="params"]').value.trim();
      params = paramsText ? JSON.parse(paramsText) : {};
      if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('资产参数必须是 JSON 对象');
      const refsText = body.querySelector('[data-field="refImages"]').value.trim();
      refImages = refsText ? JSON.parse(refsText) : [];
      if (!Array.isArray(refImages)) throw new Error('参考图必须是 JSON 数组');
      refImages = refImages.map((item) => String(item).trim()).filter(Boolean);
    } catch (error) {
      showError(`JSON 格式错误：${error?.message || error}`);
      return;
    }

    save.disabled = true;
    cancel.disabled = true;
    save.textContent = isEdit ? '保存中…' : '创建中…';
    try {
      const payload = { name, description, projectId: projectId || null, params, refImages };
      let result;
      if (isEdit) {
        result = await ctxRef.api.put(`/api/assets/${encodeURIComponent(asset.id)}`, payload);
      } else {
        result = await ctxRef.api.post('/api/assets', { type: normalizeType(type), ...payload });
      }
      if (!isAlive(token)) return;
      const returned = extractEntity(result, ['asset']);
      const targetId = returned?.id ? String(returned.id) : (isEdit ? asset.id : '');
      state.selectedType = normalizeType(isEdit ? asset.type : type);
      dialog.close();
      ctxRef.toast(isEdit ? '已保存并生成新版本' : '资产已创建', 'ok');
      await loadAssets({ silent: true });
      if (targetId && state.assets.some((item) => item.id === targetId)) await selectAsset(targetId);
    } catch (error) {
      if (isAlive(token)) {
        showError(`保存失败：${error?.message || error}`);
        save.disabled = false;
        cancel.disabled = false;
        save.textContent = isEdit ? '保存并生成新版本' : '创建资产';
      }
    }
  };

  save.addEventListener('click', submit);
  const onKey = (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    }
  };
  body.addEventListener('keydown', onKey);
}

function openSnapshotDialog() {
  if (!ctxRef) return;
  const token = lifecycle;
  const body = document.createElement('div');
  body.className = 'asset-form';
  body.innerHTML = `
    <div class="asset-modal-hint">冻结快照会把当前四类资产的版本指针完整留档。之后继续修改资产，不会影响该集已冻结的版本。</div>
    <label class="asset-field"><span class="asset-field-label">剧本 ID <b>必填</b></span><input class="asset-input" data-field="scriptId" type="text" autocomplete="off" placeholder="例如：script-xxxxxxxx；请填写该集所属剧本 ID" /></label>
    <label class="asset-field"><span class="asset-field-label">集编号 / 集 ID <b>必填</b></span><input class="asset-input" data-field="episode" type="text" placeholder="例如：EP01、第1集、episode-id" /></label>
    <label class="asset-field"><span class="asset-field-label">快照备注</span><textarea class="asset-textarea" data-field="note" rows="3" placeholder="例如：开拍前锁定，导演已确认定妆"></textarea></label>
    <div class="asset-form-error" data-form-error></div>`;
  const errorBox = body.querySelector('[data-form-error]');
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'asset-btn';
  cancel.textContent = '取消';
  const submitButton = document.createElement('button');
  submitButton.type = 'button';
  submitButton.className = 'asset-btn asset-btn-primary';
  submitButton.textContent = '确认冻结';
  const dialog = ctxRef.modal({
    title: '冻结集级快照',
    body,
    width: 620,
    footer: [cancel, submitButton],
    onClose: () => openDialogs.delete(dialog),
  });
  openDialogs.add(dialog);
  cancel.addEventListener('click', () => dialog.close());

  const showError = (message) => {
    errorBox.textContent = message;
    errorBox.classList.add('asset-form-error-on');
  };

  const submit = async () => {
    if (submitButton.disabled) return;
    errorBox.classList.remove('asset-form-error-on');
    const scriptId = body.querySelector('[data-field="scriptId"]').value.trim();
    const episode = body.querySelector('[data-field="episode"]').value.trim();
    const note = body.querySelector('[data-field="note"]').value.trim();
    if (!scriptId) {
      showError('请填写该集所属的剧本 ID。');
      return;
    }
    if (!episode) {
      showError('请填写要冻结的集编号或集 ID。');
      return;
    }
    submitButton.disabled = true;
    cancel.disabled = true;
    submitButton.textContent = '冻结中…';
    try {
      await ctxRef.api.post('/api/assets/snapshot', { script_id: scriptId, code: episode, note });
      if (!isAlive(token)) return;
      dialog.close();
      ctxRef.toast(`已冻结 ${scriptId} / ${episode} 的资产快照`, 'ok');
      await loadSnapshots({ silent: true });
    } catch (error) {
      if (isAlive(token)) {
        showError(`冻结失败：${error?.message || error}`);
        submitButton.disabled = false;
        cancel.disabled = false;
        submitButton.textContent = '确认冻结';
      }
    }
  };
  submitButton.addEventListener('click', submit);
  body.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    }
  });
}

async function refreshAll() {
  const token = lifecycle;
  await loadAssets();
  if (!isAlive(token)) return;
  if (state.selectedId) await loadVersions(state.selectedId, { silent: true });
  await loadSnapshots();
}

function bindEvents() {
  abortController = new AbortController();
  const { signal } = abortController;
  rootEl.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-asset-action]') : null;
    if (!target || !rootEl?.contains(target)) return;
    const action = target.getAttribute('data-asset-action');
    if (action === 'tab') {
      const type = normalizeType(target.getAttribute('data-type'));
      if (state.selectedType !== type) {
        state.selectedType = type;
        state.selectedId = '';
        state.versions = [];
        state.versionStatus = 'idle';
        state.search = '';
        render();
      }
      return;
    }
    if (action === 'select') { selectAsset(target.getAttribute('data-id') || ''); return; }
    if (action === 'edit') {
      const asset = state.assets.find((item) => item.id === target.getAttribute('data-id'));
      if (asset) openAssetForm(asset);
      return;
    }
    if (action === 'create') { openAssetForm(null); return; }
    if (action === 'snapshot-open') { openSnapshotDialog(); return; }
    if (action === 'refresh') { refreshAll(); return; }
    if (action === 'snapshot-refresh') { loadSnapshots(); return; }
    if (action === 'retry-assets') { loadAssets(); return; }
    if (action === 'retry-versions') {
      if (state.selectedId) loadVersions(state.selectedId);
      return;
    }
    if (action === 'retry-snapshots') { loadSnapshots(); return; }
    if (action === 'clear-search') {
      state.search = '';
      const input = rootEl.querySelector('[data-asset-search]');
      if (input) input.value = '';
      const listBody = rootEl.querySelector('[data-asset-list-body]');
      if (listBody) listBody.innerHTML = renderAssetListBody();
      return;
    }
    if (action === 'version') {
      state.selectedVersionNo = Number(target.getAttribute('data-version-no')) || null;
      render();
      return;
    }
    if (action === 'rollback') {
      rollbackVersion(Number(target.getAttribute('data-version-no')));
    }
  }, { signal });

  rootEl.addEventListener('input', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || !target.matches('[data-asset-search]')) return;
    state.search = target.value;
    const listBody = rootEl?.querySelector('[data-asset-list-body]');
    if (listBody) listBody.innerHTML = renderAssetListBody();
  }, { signal });
}

export async function mount(el, ctx) {
  rootEl = el;
  ctxRef = ctx;
  lifecycle += 1;
  state = blankState();
  injectStyle();
  if (abortController) abortController.abort();
  bindEvents();
  render();
  await Promise.allSettled([loadAssets({ silent: true }), loadSnapshots({ silent: true })]);
}

export function unmount() {
  lifecycle += 1;
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
  for (const dialog of [...openDialogs]) {
    try { dialog.close(); } catch { /* 关闭失败不阻断视图卸载 */ }
  }
  openDialogs.clear();
  rootEl = null;
  ctxRef = null;
  state = blankState();
}
