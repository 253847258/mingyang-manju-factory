// 模块2 前端视图：小说工坊（100 题材 / 大纲可视化 / 逐章写作 / 阅读导出）
// 只使用 ctx 提供的成员，类名统一 nv- 前缀，样式自行注入。
const STYLE_ID = 'nv-style';

const CSS = `
.nv-wrap{display:flex;gap:14px;height:100%;min-height:0;padding:10px 12px;color:var(--text,#e8e8ef);font-size:13px}
.nv-wrap *{box-sizing:border-box}
.nv-side{width:290px;flex:0 0 290px;display:flex;flex-direction:column;gap:8px;background:var(--panel,#16161d);border:1px solid var(--line,#2a2a36);border-radius:var(--radius,10px);padding:10px;min-height:0}
.nv-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:10px;min-height:0;overflow:auto;padding-right:2px}
.nv-h1{font-size:15px;font-weight:700;display:flex;align-items:center;gap:6px;margin:0}
.nv-h2{font-size:13px;font-weight:700;margin:0 0 6px}
.nv-muted{color:var(--muted,#8b8b9c);font-size:12px}
.nv-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.nv-col{display:flex;flex-direction:column;gap:8px}
.nv-grow{flex:1;min-width:0}
.nv-hint{color:var(--muted,#8b8b9c);font-size:11.5px;line-height:1.5}
.nv-card{background:var(--panel,#16161d);border:1px solid var(--line,#2a2a36);border-radius:var(--radius,10px);padding:12px}
.nv-card-t{font-weight:700;font-size:13px;margin-bottom:8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.nv-btn{background:var(--panel-2,#1e1e28);color:var(--text,#e8e8ef);border:1px solid var(--line,#2a2a36);border-radius:8px;padding:5px 10px;cursor:pointer;font-size:12px;line-height:1.5;text-decoration:none;display:inline-flex;align-items:center;gap:4px;white-space:nowrap}
.nv-btn:hover{border-color:var(--accent,#6c8cff)}
.nv-btn:disabled{opacity:.45;cursor:not-allowed}
.nv-btn-p{background:var(--accent,#6c8cff);border-color:var(--accent,#6c8cff);color:#0b0b12;font-weight:700}
.nv-btn-a{background:var(--accent-2,#48d1a0);border-color:var(--accent-2,#48d1a0);color:#08120e;font-weight:700}
.nv-btn-d{border-color:var(--err,#f06060);color:var(--err,#f06060)}
.nv-btn-sm{padding:2px 7px;font-size:11.5px}
.nv-input,.nv-select,.nv-area{background:var(--bg,#0f0f14);color:var(--text,#e8e8ef);border:1px solid var(--line,#2a2a36);border-radius:8px;padding:5px 8px;font-size:12.5px;font-family:inherit;width:100%}
.nv-area{line-height:1.7;resize:vertical;min-height:90px}
.nv-input:focus,.nv-select:focus,.nv-area:focus{outline:none;border-color:var(--accent,#6c8cff)}
.nv-list{flex:1;overflow:auto;min-height:0;display:flex;flex-direction:column;gap:6px}
.nv-item{background:var(--panel-2,#1e1e28);border:1px solid var(--line,#2a2a36);border-radius:8px;padding:8px;cursor:pointer}
.nv-item:hover{border-color:var(--accent,#6c8cff)}
.nv-item.nv-on{border-color:var(--accent,#6c8cff);background:rgba(108,140,255,.12)}
.nv-item-t{font-weight:700;display:flex;justify-content:space-between;gap:6px;align-items:center}
.nv-item-m{color:var(--muted,#8b8b9c);font-size:11.5px;margin-top:3px;display:flex;gap:8px;flex-wrap:wrap}
.nv-tabs{display:flex;gap:6px;flex-wrap:wrap}
.nv-tab{padding:5px 12px;border-radius:8px;border:1px solid var(--line,#2a2a36);background:var(--panel,#16161d);cursor:pointer;font-size:12.5px}
.nv-tab.nv-on{background:var(--accent,#6c8cff);border-color:var(--accent,#6c8cff);color:#0b0b12;font-weight:700}
.nv-badge{display:inline-block;padding:1px 6px;border-radius:6px;font-size:11px;border:1px solid var(--line,#2a2a36);color:var(--muted,#8b8b9c)}
.nv-badge-ok{border-color:var(--ok,#48d1a0);color:var(--ok,#48d1a0)}
.nv-badge-warn{border-color:var(--warn,#f0b060);color:var(--warn,#f0b060)}
.nv-badge-err{border-color:var(--err,#f06060);color:var(--err,#f06060)}
.nv-badge-acc{border-color:var(--accent,#6c8cff);color:var(--accent,#6c8cff)}
.nv-bar{height:6px;border-radius:99px;background:var(--panel-2,#1e1e28);overflow:hidden;flex:1;min-width:80px}
.nv-bar>i{display:block;height:100%;background:linear-gradient(90deg,var(--accent,#6c8cff),var(--accent-2,#48d1a0))}
.nv-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(148px,1fr));gap:6px;max-height:230px;overflow:auto;padding:2px}
.nv-gitem{background:var(--panel-2,#1e1e28);border:1px solid var(--line,#2a2a36);border-radius:8px;padding:6px 8px;cursor:pointer}
.nv-gitem:hover{border-color:var(--accent,#6c8cff)}
.nv-gitem.nv-on{border-color:var(--accent-2,#48d1a0);background:rgba(72,209,160,.12)}
.nv-gitem b{font-size:12.5px;display:block}
.nv-gitem span{color:var(--muted,#8b8b9c);font-size:11px;display:block;margin-top:2px;line-height:1.4}
.nv-chips{display:flex;gap:5px;flex-wrap:wrap}
.nv-chip{padding:2px 8px;border-radius:99px;border:1px solid var(--line,#2a2a36);cursor:pointer;font-size:11.5px;background:var(--panel-2,#1e1e28)}
.nv-chip.nv-on{background:var(--accent,#6c8cff);border-color:var(--accent,#6c8cff);color:#0b0b12;font-weight:700}
.nv-tbl{width:100%;border-collapse:collapse;font-size:12px}
.nv-tbl th,.nv-tbl td{border-bottom:1px solid var(--line,#2a2a36);padding:4px 6px;text-align:left;vertical-align:top}
.nv-tbl th{color:var(--muted,#8b8b9c);font-weight:600;white-space:nowrap}
.nv-tbl tr:hover td{background:rgba(108,140,255,.06)}
.nv-scroll{max-height:340px;overflow:auto;border:1px solid var(--line,#2a2a36);border-radius:8px}
.nv-sec{border:1px solid var(--line,#2a2a36);border-radius:8px;margin-bottom:8px;overflow:hidden;background:var(--panel,#16161d)}
.nv-sec>summary{padding:7px 10px;cursor:pointer;font-weight:700;font-size:12.5px;background:var(--panel-2,#1e1e28);display:flex;gap:8px;align-items:center}
.nv-sec>div{padding:10px;max-height:420px;overflow:auto}
.nv-kv{display:grid;grid-template-columns:110px 1fr;gap:4px 10px;font-size:12px}
.nv-kv dt{color:var(--muted,#8b8b9c)}
.nv-kv dd{margin:0;line-height:1.6}
.nv-actor{display:flex;gap:8px;align-items:center;padding:5px 6px;border-radius:8px;cursor:pointer;border:1px solid transparent}
.nv-actor:hover{background:var(--panel-2,#1e1e28)}
.nv-actor.nv-on{border-color:var(--accent-2,#48d1a0);background:rgba(72,209,160,.1)}
.nv-av{width:26px;height:26px;border-radius:6px;background:var(--panel-2,#1e1e28);border:1px solid var(--line,#2a2a36);object-fit:cover;flex:0 0 26px;display:flex;align-items:center;justify-content:center;font-size:11px;color:var(--muted,#8b8b9c)}
.nv-read{line-height:2;font-size:13.5px;max-height:60vh;overflow:auto;padding:4px 2px}
.nv-read p{margin:0 0 12px;text-indent:2em}
.nv-chlist{flex:0 0 250px;max-height:62vh;overflow:auto;display:flex;flex-direction:column;gap:4px}
.nv-ch{display:flex;gap:6px;align-items:center;padding:4px 6px;border-radius:6px;cursor:pointer;border:1px solid transparent;font-size:12px}
.nv-ch:hover{background:var(--panel-2,#1e1e28)}
.nv-ch.nv-on{border-color:var(--accent,#6c8cff);background:rgba(108,140,255,.12)}
.nv-ch i{font-style:normal;color:var(--muted,#8b8b9c);flex:0 0 34px}
.nv-ch b{font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nv-warn{background:rgba(240,176,96,.1);border:1px solid var(--warn,#f0b060);color:var(--warn,#f0b060);border-radius:8px;padding:8px 10px;font-size:12px;line-height:1.6}
.nv-note{background:rgba(108,140,255,.08);border:1px solid var(--line,#2a2a36);border-radius:8px;padding:8px 10px;font-size:12px;line-height:1.6}
.nv-beat{display:flex;gap:6px;align-items:center;font-size:11.5px;margin-bottom:3px}
.nv-beat i{font-style:normal;flex:0 0 66px;color:var(--muted,#8b8b9c)}
.nv-beat b{height:9px;border-radius:3px;display:block}
.nv-empty{padding:26px 12px;text-align:center;color:var(--muted,#8b8b9c);font-size:12.5px;line-height:1.8}
.nv-step{display:flex;gap:6px;align-items:center;font-weight:700;font-size:12.5px;margin:2px 0 8px}
.nv-step em{font-style:normal;background:var(--accent,#6c8cff);color:#0b0b12;border-radius:99px;width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center;font-size:11px}
.nv-job{display:flex;gap:8px;align-items:center;background:var(--panel-2,#1e1e28);border:1px solid var(--line,#2a2a36);border-radius:8px;padding:6px 10px;font-size:12px}
.nv-split{display:flex;gap:10px;align-items:flex-start}
.nv-lbl{color:var(--muted,#8b8b9c);font-size:11.5px;margin-bottom:3px;display:block}
.nv-num{max-width:110px}
.nv-f{display:flex;flex-direction:column;gap:2px;min-width:110px}
.nv-pill{font-size:11px;padding:1px 6px;border-radius:6px;background:var(--panel-2,#1e1e28);border:1px solid var(--line,#2a2a36);color:var(--muted,#8b8b9c)}
.nv-preview{white-space:pre-wrap;font-size:11.5px;line-height:1.6;color:var(--muted,#8b8b9c);max-height:120px;overflow:auto;background:var(--bg,#0f0f14);border:1px solid var(--line,#2a2a36);border-radius:8px;padding:6px 8px}
@media(max-width:1080px){.nv-wrap{flex-direction:column}.nv-side{width:auto;flex:0 0 auto;max-height:230px}}
`;

const POV_FALLBACK = [
  { id: 'third-limited', name: '第三人称限知（跟随主角）' },
  { id: 'third-omniscient', name: '第三人称全知' },
  { id: 'first', name: '第一人称（我）' },
  { id: 'multi', name: '多视角轮换（POV 章节切换）' },
];
const TONE_FALLBACK = ['爽文快节奏', '热血燃向', '暗黑压抑', '轻松搞笑', '悬疑烧脑', '温情治愈', '史诗厚重', '狗血反转', '冷峻现实', '浪漫唯美'];
const OUTLINE_SECTIONS_FALLBACK = [
  { key: 'logline', label: '一句话故事' }, { key: 'framework', label: '故事框架与核心冲突' },
  { key: 'worldview', label: '世界观设定' }, { key: 'volumes', label: '卷/季结构规划' },
  { key: 'chapters', label: '章节大纲与走向' }, { key: 'timeline', label: '宏大时间线' },
  { key: 'locations', label: '地点档案（ID）' }, { key: 'characters', label: '人物 ID 与出场规划' },
  { key: 'foreshadow', label: '伏笔与回收表' }, { key: 'reversals', label: '反转清单' },
  { key: 'beats', label: '节奏卡点与爽点曲线' }, { key: 'hooks', label: '钩子银行（章末钩子）' },
  { key: 'loops', label: '跨季章节时间回路' }, { key: 'logic', label: '全篇逻辑关系与因果链' },
];

const S = {
  root: null, ctx: null, meta: null, llm: null,
  novels: [], q: '',
  view: 'empty',            // empty | create | workspace
  currentId: null, detail: null,
  tab: 'params',
  genres: [], categories: [], povs: POV_FALLBACK, tones: TONE_FALLBACK, sections: OUTLINE_SECTIONS_FALLBACK, limits: null,
  genreCat: '全部', genreQ: '',
  actors: [], actorQ: '', actorsLoaded: false,
  form: null, formMode: 'create',
  chapterIdx: null, chapter: null, editing: false,
  jobId: null, stopWatch: null, timers: [], busy: false,
  handlers: null,
};

// ---------------- 工具 ----------------
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const fmtWords = (n) => (num(n) >= 10000 ? `${(num(n) / 10000).toFixed(1)} 万字` : `${num(n)} 字`);
const badge = (text, kind = '') => `<span class="nv-badge${kind ? ` nv-badge-${kind}` : ''}">${esc(text)}</span>`;
const STATUS_LABEL = { outline: '待写', writing: '写作中', done: '已完成', error: '失败', draft: '草稿' };
const statusBadge = (s) => badge(STATUS_LABEL[s] || s || '—', s === 'done' ? 'ok' : s === 'error' ? 'err' : s === 'writing' ? 'warn' : '');

function toast(msg, type = 'info') { try { S.ctx.toast(msg, type); } catch { /* ignore */ } }

function llmReady() {
  const l = S.llm || S.detail?.llm || S.meta?.llm;
  return l ? !!l.ready : true;
}
function limits() {
  return S.limits || { castSize: { min: 1, max: 200, default: 20 }, chapterWords: { min: 1000, max: 3000, default: 2000 }, targetWords: { min: 10000, max: 10000000, default: 1000000 } };
}

function errText(e) {
  const msg = String(e?.message || e || '未知错误');
  return msg.replace(/^Error:\s*/, '');
}
/** LLM 相关错误 → 明确中文提示 + 离线模板指引 */
function handleLlmError(e) {
  const msg = errText(e);
  const isLlm = /API Key|LLM 未|未配置|provider/i.test(msg);
  if (isLlm && /API Key|未配置|未就绪/.test(msg)) {
    const body = document.createElement('div');
    body.innerHTML = `<div class="nv-hint" style="line-height:1.8">${esc(msg)}</div>
      <div class="nv-note" style="margin-top:10px;line-height:1.8">
      <b>两种处理方式：</b><br>
      ① 配置真实模型：打开「设置」页 → LLM → 填入 DeepSeek API Key（或 DSH 凭据里的 DEEPSEEK_API_KEY）；<br>
      ② 切换离线模板：打开「设置」页 → LLM provider 选择 <b>mock</b> → 保存。此后生成的是结构化占位内容，用于先把流程跑通，不消耗额度。
      </div>`;
    const m = S.ctx.modal({ title: 'LLM 未就绪', body, width: 520 });
    const bar = document.createElement('div');
    bar.className = 'nv-row';
    bar.style.marginTop = '10px';
    bar.innerHTML = `<button class="nv-btn nv-btn-p" data-act="goto-settings">去设置页</button><button class="nv-btn" data-act="modal-close">知道了</button>`;
    body.appendChild(bar);
    bar.querySelector('[data-act="modal-close"]').onclick = () => m.close();
    bar.querySelector('[data-act="goto-settings"]').onclick = () => { m.close(); stopWatching(); S.ctx.go('settings'); };
    return;
  }
  if (/未配置/.test(msg) || !llmReady()) toast(`${msg}（可在「设置」页把 provider 切到 mock 使用离线模板）`, 'err');
  else toast(msg, 'err');
}

async function guard(fn, okMsg) {
  if (S.busy) return undefined;
  S.busy = true;
  try {
    const r = await fn();
    if (okMsg) toast(okMsg, 'ok');
    return r;
  } catch (e) {
    handleLlmError(e);
    return undefined;
  } finally {
    S.busy = false;
  }
}

// ---------------- 数据 ----------------
async function loadMeta() {
  S.meta = S.ctx.meta || null;
  if (!S.meta || !Array.isArray(S.meta.genres) || !S.meta.genres.length) {
    try { S.meta = await S.ctx.api.get('/api/meta'); } catch { S.meta = S.meta || {}; }
  }
  const m = S.meta || {};
  S.genres = Array.isArray(m.genres) ? m.genres : [];
  S.categories = Array.isArray(m.genreCategories) && m.genreCategories.length ? m.genreCategories : [...new Set(S.genres.map((g) => g.cat))];
  S.povs = Array.isArray(m.povs) && m.povs.length ? m.povs : POV_FALLBACK;
  S.tones = Array.isArray(m.tones) && m.tones.length ? m.tones : TONE_FALLBACK;
  S.sections = Array.isArray(m.outlineSections) && m.outlineSections.length ? m.outlineSections : OUTLINE_SECTIONS_FALLBACK;
  if (m.limits) S.limits = { castSize: m.limits.castSize || limits().castSize, chapterWords: m.limits.chapterWords || limits().chapterWords, targetWords: m.limits.targetWords || limits().targetWords };
  if (m.scales) S.scales = m.scales;
  if (m.llm) S.llm = m.llm;
}

async function loadList() {
  const r = await S.ctx.api.get('/api/novels');
  S.novels = r.novels || [];
  if (r.llm) S.llm = r.llm;
}

async function loadActors() {
  if (S.actorsLoaded) return;
  try {
    const r = await S.ctx.api.get('/api/actors?limit=500');
    S.actors = r.actors || [];
    S.actorsLoaded = true;
  } catch (e) { toast(`演员表读取失败：${errText(e)}`, 'err'); }
}

async function openNovel(id) {
  S.detail = await S.ctx.api.get(`/api/novels/${id}`);
  S.currentId = id;
  S.view = 'workspace';
  if (S.detail.llm) S.llm = S.detail.llm;
  if (S.detail.novel) applyFormFromNovel(S.detail.novel);
  const first = (S.detail.chapters || []).find((c) => c.status === 'done') || (S.detail.chapters || [])[0];
  if (!S.chapterIdx && first) S.chapterIdx = first.idx;
  render();
}

async function reloadDetail() {
  if (!S.currentId) return;
  S.detail = await S.ctx.api.get(`/api/novels/${S.currentId}`);
  if (S.detail.llm) S.llm = S.detail.llm;
  if (S.detail.novel) applyFormFromNovel(S.detail.novel);
  render();
}

function applyFormFromNovel(n) {
  S.form = {
    title: n.title || '', genre: n.genre || '', tone: n.tone || '', scale: n.scale || '',
    cast_size: num(n.cast_size, 20), target_words: num(n.target_words, 1000000), chapter_words: num(n.chapter_words, 2000),
    pov: n.pov || 'third-limited', seasons: num(n.seasons, 1), framework_intro: n.framework_intro || '',
    ref_doc_path: n.ref_doc_path || '', ref_doc_name: n.ref_doc_name || '',
    actor_ids: (n.actor_ids || []).slice(), custom_actors: (n.custom_actors || []).map((c) => ({ ...c })),
  };
}

function newForm() {
  const g = S.genres[0] || {};
  return {
    title: '', genre: g.id || '', tone: g.tone || S.tones[0], scale: 'medium',
    cast_size: limits().castSize.default, target_words: limits().targetWords.default,
    chapter_words: limits().chapterWords.default, pov: S.povs[0]?.id || 'third-limited', seasons: 1,
    framework_intro: '', ref_doc_path: '', ref_doc_name: '', actor_ids: [], custom_actors: [],
  };
}
const castTotal = () => (S.form?.actor_ids?.length || 0) + (S.form?.custom_actors?.length || 0);

// ---------------- 渲染 ----------------
function render() {
  if (!S.root) return;
  const focusId = document.activeElement?.id;
  const selStart = document.activeElement?.selectionStart;
  S.root.innerHTML = `<div class="nv-wrap">${sideHtml()}<div class="nv-main" id="nv-main">${mainHtml()}</div></div>`;
  if (focusId) {
    const el = S.root.querySelector(`#${focusId}`);
    if (el && typeof el.focus === 'function') {
      try { el.focus(); if (selStart != null && el.setSelectionRange) el.setSelectionRange(selStart, selStart); } catch { /* ignore */ }
    }
  }
  bindFileInput();
  bindAreaCounters();
}

function sideHtml() {
  const items = S.novels.filter((n) => {
    if (!S.q) return true;
    const q = S.q.toLowerCase();
    return `${n.title} ${n.genre_name} ${n.id}`.toLowerCase().includes(q);
  });
  return `<div class="nv-side">
    <div class="nv-row"><div class="nv-h1 nv-grow">📖 小说工坊</div>
      <button class="nv-btn nv-btn-p nv-btn-sm" data-act="new-novel">＋ 新建</button>
      <button class="nv-btn nv-btn-sm" data-act="refresh" title="刷新列表">↻</button></div>
    <input class="nv-input" id="nv-q" data-role="q" placeholder="搜索标题 / 题材 / 编号…" value="${esc(S.q)}">
    <div class="nv-list">${items.length ? items.map(itemHtml).join('') : `<div class="nv-empty">还没有小说项目<br>点「＋ 新建」开始：选题材 → 定角色 → 写框架 → 两步生成</div>`}</div>
    <div class="nv-hint">共 ${S.novels.length} 个项目${S.llm ? `｜LLM ${S.llm.ready ? '已就绪' : '未配置'}` : ''}</div>
  </div>`;
}

function itemHtml(n) {
  const st = n.stats || {};
  const pct = num(st.progress, 0);
  return `<div class="nv-item ${S.currentId === n.id ? 'nv-on' : ''}" data-act="open" data-id="${esc(n.id)}">
    <div class="nv-item-t"><span>${esc(n.title)}</span>${badge(`${st.written || 0}/${st.total || 0} 章`, pct > 0 ? 'acc' : '')}</div>
    <div class="nv-item-m"><span>${esc(n.id)}</span><span>${esc(n.genre_name || '未选题材')}</span><span>${fmtWords(n.target_words)}/${num(n.chapter_words, 2000)}字</span></div>
    <div class="nv-row" style="margin-top:5px"><div class="nv-bar"><i style="width:${Math.min(100, pct)}%"></i></div><span class="nv-muted">${fmtWords(st.words || 0)}</span>
      <button class="nv-btn nv-btn-sm nv-btn-d" data-act="del-novel" data-id="${esc(n.id)}">删</button></div>
  </div>`;
}

function mainHtml() {
  if (S.view === 'create') return createHtml();
  if (S.view === 'workspace' && S.detail) return workspaceHtml();
  return `<div class="nv-card"><div class="nv-empty">左侧选择项目，或点「＋ 新建」创建一部小说。<br>
    <span class="nv-hint">创作流程：① 参数与题材 → ② 定义演员/自定义角色 → ③ 上传故事框架范本（可选）→ ④ <b>生成章节大纲</b> → ⑤ <b>按大纲逐章写作</b> → ⑥ 阅读 / 编辑 / 导出</span></div></div>`;
}

// ---------- 创建 / 参数表单 ----------
function createHtml() {
  return formHtml('create');
}

function formHtml(mode) {
  const f = S.form;
  const lim = limits();
  const total = castTotal();
  const overCast = total > num(f.cast_size, 20);
  const genre = S.genres.find((g) => g.id === f.genre) || null;
  const shown = S.genres.filter((g) => (S.genreCat === '全部' || g.cat === S.genreCat)
    && (!S.genreQ || `${g.name} ${g.tags?.join(' ') || ''} ${g.desc || ''}`.toLowerCase().includes(S.genreQ.toLowerCase())));
  return `<div class="nv-card">
    <div class="nv-card-t">${mode === 'create' ? '新建小说项目' : `参数与角色 · ${esc(S.detail?.novel?.id || '')}`}
      <span class="nv-grow"></span>
      ${mode === 'create' ? '<button class="nv-btn" data-act="cancel-create">返回</button>' : '<button class="nv-btn" data-act="cancel-edit">返回工作区</button>'}
      <button class="nv-btn nv-btn-p" data-act="${overCast ? 'cast-warn' : 'save-form'}">${mode === 'create' ? '创建项目' : '保存修改'}</button>
    </div>

    <div class="nv-step"><em>1</em>题材与参数${genre ? `　<span class="nv-pill">已选：${esc(genre.name)}（${esc(genre.cat)}）</span>` : '　<span class="nv-pill">未选</span>'}</div>
    <div class="nv-row">
      <div class="nv-f"><span class="nv-lbl">标题</span><input class="nv-input" id="nv-title" data-role="title" style="min-width:220px" placeholder="例如：剑落青芜" value="${esc(f.title)}"></div>
      <div class="nv-f"><span class="nv-lbl">基调</span><select class="nv-select" data-role="tone" style="min-width:130px">${S.tones.map((t) => `<option ${t === f.tone ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></div>
      <div class="nv-f"><span class="nv-lbl">叙事视角</span><select class="nv-select" data-role="pov" style="min-width:190px">${S.povs.map((p) => `<option value="${esc(p.id)}" ${p.id === f.pov ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
      <div class="nv-f"><span class="nv-lbl">角色规模上限（≤200）</span><input class="nv-input nv-num" id="nv-cast" type="number" min="${lim.castSize.min}" max="${lim.castSize.max}" data-role="cast_size" value="${num(f.cast_size, 20)}"></div>
      <div class="nv-f"><span class="nv-lbl">季/卷数</span><input class="nv-input nv-num" id="nv-seasons" type="number" min="1" max="99" data-role="seasons" value="${num(f.seasons, 1)}"></div>
    </div>
    <div class="nv-row" style="margin-top:8px">
      <div class="nv-f nv-grow"><span class="nv-lbl">小说总字数（≤1000 万）</span>
        <div class="nv-row"><input class="nv-input" id="nv-target" type="number" min="${lim.targetWords.min}" max="${lim.targetWords.max}" step="10000" data-role="target_words" value="${num(f.target_words, 1000000)}">
        ${(S.scales || []).map((s) => `<button class="nv-chip ${num(f.target_words, 0) >= s.min && num(f.target_words, 0) <= s.max ? 'nv-on' : ''}" data-act="scale" data-min="${s.min}" data-max="${s.max}" title="${esc(s.name)}">${esc(String(s.name).replace(/（.*/, ''))}</button>`).join('')}
        </div>
        <div class="nv-hint" id="nv-derived">按 总字数 ÷ 章节字数 推导需规划 <b>${Math.max(1, Math.ceil(num(f.target_words, 10000) / Math.max(1, num(f.chapter_words, 2000))))}</b> 章（单次生成上限 200 章，超出请分卷/分批继续）</div>
      </div>
      <div class="nv-f" style="min-width:250px"><span class="nv-lbl">章节字数（1000~3000）</span>
        <div class="nv-row"><input class="nv-input nv-num" id="nv-chapter" type="number" min="${lim.chapterWords.min}" max="${lim.chapterWords.max}" data-role="chapter_words" value="${num(f.chapter_words, 2000)}">
        <input type="range" id="nv-cw-range" min="${lim.chapterWords.min}" max="${lim.chapterWords.max}" step="100" data-role="chapter_words_range" value="${num(f.chapter_words, 2000)}" style="flex:1"></div>
      </div>
    </div>

    <div style="margin-top:10px">
      <div class="nv-row" style="margin-bottom:6px"><b style="font-size:12.5px">题材（100 种，可按分类筛选 / 关键词搜索）</b>
        <input class="nv-input" id="nv-genre-q" data-role="genreQ" style="max-width:200px" placeholder="搜索题材关键词…" value="${esc(S.genreQ)}">
        <span class="nv-hint">共 ${S.genres.length} 种，命中 ${shown.length} 种</span></div>
      <div class="nv-chips" style="margin-bottom:6px">
        <button class="nv-chip ${S.genreCat === '全部' ? 'nv-on' : ''}" data-act="cat" data-cat="全部">全部</button>
        ${S.categories.map((c) => `<button class="nv-chip ${S.genreCat === c ? 'nv-on' : ''}" data-act="cat" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}
      </div>
      <div class="nv-grid">${shown.map((g) => `<div class="nv-gitem ${g.id === f.genre ? 'nv-on' : ''}" data-act="genre" data-id="${esc(g.id)}">
        <b>${esc(g.name)}</b><span>${esc(g.cat)} · ${esc(g.desc || '')}</span><span>钩子：${esc(g.hook || '—')}</span></div>`).join('')}</div>
      ${genre ? `<div class="nv-hint" style="margin-top:6px">推荐基调：${esc(genre.tone || '—')}｜关键词：${esc((genre.tags || []).join('、'))}｜开篇钩子：${esc(genre.hook || '—')}</div>` : ''}
    </div>

    <div class="nv-step" style="margin-top:14px"><em>2</em>定义演员（引用模块1演员表 + 自定义角色，合计 ≤ ${num(f.cast_size, 20)} / 200）
      <span class="nv-grow"></span>
      <span class="nv-pill ${overCast ? 'nv-badge-err' : ''}" data-role="cast-pill">已定义 ${total} 名${overCast ? `（超出 ${total - num(f.cast_size, 20)} 名）` : ''}</span>
      <button class="nv-btn nv-btn-sm" data-act="load-actors">${S.actorsLoaded ? '刷新演员表' : '载入演员表'}</button>
    </div>
    <div class="nv-warn" data-role="cast-warn" style="margin-bottom:8px;${overCast ? '' : 'display:none'}">角色总数 ${total} 超过角色规模 ${num(f.cast_size, 20)}：请调大「角色规模上限」或减少角色后再保存（硬上限 200 名）。</div>
    <div class="nv-split">
      <div class="nv-grow">
        <input class="nv-input" id="nv-actor-q" data-role="actorQ" placeholder="搜索演员（姓名 / 编号 / 定位）…" value="${esc(S.actorQ)}">
        <div class="nv-scroll" id="nv-actor-list" style="margin-top:6px;max-height:210px">
          ${actorListHtml()}
        </div>
        <div class="nv-hint" style="margin-top:4px">已引用 ${(f.actor_ids || []).length} 名演员${(f.actor_ids || []).length ? `：${f.actor_ids.map(esc).join('、')}` : ''}</div>
      </div>
      <div class="nv-grow">
        <div class="nv-row" style="justify-content:space-between"><b style="font-size:12.5px">自定义角色（${(f.custom_actors || []).length}）</b>
          <button class="nv-btn nv-btn-sm" data-act="add-custom">＋ 添加角色</button></div>
        <div class="nv-scroll" style="margin-top:6px;max-height:210px;padding:6px">
          ${(f.custom_actors || []).length ? (f.custom_actors || []).map((c, i) => `<div class="nv-row" style="margin-bottom:5px" data-crow="${i}">
            <input class="nv-input" data-role="cname" data-i="${i}" placeholder="姓名" value="${esc(c.name || '')}" style="max-width:110px">
            <input class="nv-input" data-role="crole" data-i="${i}" placeholder="定位（主角/反派…）" value="${esc(c.role || '')}" style="max-width:120px">
            <select class="nv-select" data-role="cgender" data-i="${i}" style="max-width:70px">${['', '男', '女', '中性'].map((g) => `<option ${g === (c.gender || '') ? 'selected' : ''}>${g}</option>`).join('')}</select>
            <input class="nv-input" data-role="cage" data-i="${i}" placeholder="年龄" value="${esc(c.age ?? '')}" style="max-width:62px">
            <input class="nv-input nv-grow" data-role="cdesc" data-i="${i}" placeholder="一句话简介（性格/背景/作用）" value="${esc(c.desc || '')}">
            <button class="nv-btn nv-btn-sm nv-btn-d" data-act="rm-custom" data-i="${i}">×</button></div>`).join('')
            : '<div class="nv-empty">暂无自定义角色（自定义角色会以 CX-0001 形式的 ID 参与大纲与写作）</div>'}
        </div>
      </div>
    </div>

    <div class="nv-step" style="margin-top:14px"><em>3</em>故事框架介绍 与 参考范本
      <span class="nv-grow"></span>
      <button class="nv-btn nv-btn-sm" data-act="ai-framework" title="调用 1 次 LLM，生成故事框架、标题和角色建议">✨ AI 自动填写</button>
    </div>
    <textarea class="nv-area" id="nv-framework" data-role="framework_intro" rows="7" placeholder="把故事框架尽量写清楚：主角是谁、想要什么、阻碍是什么、世界规则、开局与结局方向、必须出现的桥段…（越具体，大纲越贴合）">${esc(f.framework_intro)}</textarea>
    <div class="nv-hint" id="nv-fw-count">已输入 ${String(f.framework_intro || '').length} 字 · AI 自动填写会调用 1 次 LLM</div>
    <div class="nv-row" style="margin-top:8px">
      <button class="nv-btn" data-act="upload-ref">📎 上传故事框架参考范本（txt/md/json）</button>
      <input type="file" id="nv-ref-file" accept=".txt,.md,.markdown,.json,.csv,text/*" style="display:none">
      ${f.ref_doc_path ? `<span class="nv-pill">${esc(f.ref_doc_name || f.ref_doc_path)}</span><button class="nv-btn nv-btn-sm" data-act="clear-ref">清除</button>` : '<span class="nv-hint">未上传（生成大纲时会把范本正文注入提示词作为风格/结构参考）</span>'}
    </div>
    ${f.ref_doc_path ? `<div class="nv-preview" id="nv-ref-preview">加载范本正文…</div>` : ''}
  </div>`;
}

function actorListHtml() {
  if (!S.actorsLoaded) return '<div class="nv-empty">点上方「载入演员表」从模块1选择演员</div>';
  const sel = new Set(S.form?.actor_ids || []);
  const list = S.actors.filter((a) => !S.actorQ || `${a.name} ${a.id} ${a.role_type || ''}`.toLowerCase().includes(S.actorQ.toLowerCase()));
  if (!list.length) return '<div class="nv-empty">没有匹配的演员，可到「演员宫格」模块先创建</div>';
  return list.map((a) => `<div class="nv-actor ${sel.has(a.id) ? 'nv-on' : ''}" data-act="pick-actor" data-id="${esc(a.id)}">
    ${a.cover_image ? `<img class="nv-av" src="/${esc(a.cover_image)}" alt="">` : `<div class="nv-av">${esc((a.name || '?').slice(0, 1))}</div>`}
    <div class="nv-grow"><b>${esc(a.name)}</b> <span class="nv-muted">${esc(a.id)}</span>
      <div class="nv-hint">${esc(a.role_type || '未定')}｜${esc(a.gender || '')} ${a.age ? `${a.age}岁` : ''}｜${esc(String(a.tags || '').slice(0, 40))}</div></div>
    <span class="nv-badge ${sel.has(a.id) ? 'nv-badge-ok' : ''}">${sel.has(a.id) ? '已选' : '选择'}</span></div>`).join('');
}

// ---------- 工作区 ----------
function workspaceHtml() {
  const n = S.detail.novel;
  const st = S.detail.stats || {};
  const tabs = [['params', '参数与角色'], ['outline', '大纲'], ['chapters', `章节 (${st.written || 0}/${st.total || 0})`], ['export', '导出']];
  return `<div class="nv-card">
      <div class="nv-card-t">
        <span class="nv-h1">${esc(n.title)}</span>
        <span class="nv-pill">${esc(n.id)}</span>
        <span class="nv-pill">${esc(n.genre_name || '未选题材')}</span>
        <span class="nv-pill">${esc(n.tone || '')}</span>
        <span class="nv-pill">${esc(n.pov_name || '')}</span>
        ${statusBadge(n.status)}
        ${S.detail.outline ? badge(`大纲 v${S.detail.outline.version}`, 'acc') : badge('无大纲', 'warn')}
        <span class="nv-grow"></span>
        <button class="nv-btn nv-btn-sm" data-act="refresh-detail">↻ 刷新</button>
        <button class="nv-btn nv-btn-sm" data-act="new-novel">＋ 新建</button>
      </div>
      <div class="nv-row">
        <div class="nv-bar"><i style="width:${num(st.progress, 0)}%"></i></div>
        <span class="nv-muted">已写 ${st.written || 0}/${st.total || 0} 章 · 共 ${fmtWords(st.words || 0)} · 目标 ${fmtWords(n.target_words)} · 单章 ${n.chapter_words} 字 · 角色 ${n.cast_total}/${n.cast_size}</span>
      </div>
      ${!llmReady() ? `<div class="nv-warn" style="margin-top:8px">LLM 未就绪：生成大纲/章节会失败。请到「设置」页填写 API Key，或把 provider 切换为 <b>mock（离线模板）</b> 后先跑通流程。
        <button class="nv-btn nv-btn-sm" data-act="goto-settings">去设置</button>
        <button class="nv-btn nv-btn-sm" data-act="llm-help">怎么做？</button></div>` : ''}
      <div class="nv-row" style="margin-top:8px">
        <button class="nv-btn nv-btn-p" data-act="outline-gen">① ${S.detail.outline ? '重新生成' : '生成'}章节大纲</button>
        <button class="nv-btn nv-btn-a" data-act="write-next">② 写作下一章</button>
        <button class="nv-btn" data-act="write-batch">批量写作…</button>
        ${S.detail.outline ? `<span class="nv-pill">大纲 v${S.detail.outline.version}｜${esc(S.detail.outline.model || '')}｜规划 ${(S.detail.outline.sections?.chapters || []).length} 章</span>` : '<span class="nv-hint">尚未生成大纲</span>'}
      </div>
      ${jobBarHtml()}
      <div class="nv-tabs" style="margin-top:10px">${tabs.map(([k, label]) => `<button class="nv-tab ${S.tab === k ? 'nv-on' : ''}" data-act="tab" data-tab="${k}">${esc(label)}</button>`).join('')}</div>
    </div>
    ${S.tab === 'params' ? formHtml('edit') : S.tab === 'outline' ? outlineHtml() : S.tab === 'chapters' ? chaptersHtml() : exportHtml()}`;
}

function jobBarHtml() {
  if (!S.job) return '';
  const j = S.job;
  const done = num(j.done, 0);
  const total = num(j.total, 1);
  return `<div class="nv-job" style="margin-top:8px">
    <span>${j.status === 'running' ? '⏳ 写作中' : j.status === 'done' ? '✅ 已完成' : j.status === 'error' ? '❌ 失败' : '⏹ 已取消'}</span>
    <div class="nv-bar"><i style="width:${num(j.progress, 0)}%"></i></div>
    <span>${done}/${total}</span><span class="nv-muted">${num(j.progress, 0)}%</span>
    ${j.error ? `<span class="nv-badge nv-badge-err">${esc(String(j.error).slice(0, 60))}</span>` : ''}
    ${['running', 'queued'].includes(j.status) ? `<button class="nv-btn nv-btn-sm nv-btn-d" data-act="cancel-job">取消</button>` : `<button class="nv-btn nv-btn-sm" data-act="dismiss-job">知道了</button>`}
  </div>`;
}

// ---------- 大纲面板 ----------
function outlineHtml() {
  const o = S.detail.outline;
  const s = o?.sections || {};
  const empty = S.sections.filter((sec) => outlineSectionEmpty(sec.key, s[sec.key]));
  const emptyFillable = empty.filter((sec) => sec.key !== 'chapters');
  if (!o) {
    return `<div class="nv-card"><div class="nv-empty">还没有大纲。<br>点 <b>✨ AI 自动规划生成</b>，自动规划章节大纲与每一节内容：故事走向 · 故事框架逻辑 · 全篇因果链 · 伏笔表（埋设章→回收章）· 宏大时间线 · 地点档案（L-0001）· 人物ID出场规划 · 反转清单 · 节奏卡点 · 章末钩子 · 跨季章节时间回路。</div>
      <div class="nv-row" style="justify-content:center;margin-top:10px">
        <button class="nv-btn nv-btn-a" data-act="outline-ai-plan">✨ AI 自动规划生成</button>
        <button class="nv-btn" data-act="outline-gen">仅生成章节大纲</button>
      </div>
      <div class="nv-hint" style="text-align:center;margin-top:8px">LLM 未配置时可在「设置」页把 provider 切到 mock（离线模板）先看结构。</div></div>`;
  }
  const meta = o.meta || {};
  return `<div class="nv-card">
    <div class="nv-card-t">结构化大纲
      <span class="nv-pill">v${o.version}</span>
      <span class="nv-pill">${esc(o.model || '')}</span>
      <span class="nv-pill">${num(o.tokens, 0)} tokens</span>
      <span class="nv-pill">${esc(String(o.created_at || '').slice(0, 19).replace('T', ' '))}</span>
      ${meta.mode === 'mock' ? badge('离线模板内容', 'warn') : ''}
      <span class="nv-grow"></span>
      <button class="nv-btn nv-btn-a nv-btn-sm" data-act="outline-ai-plan" title="自动规划缺失的章节大纲，并逐节补齐所有空缺内容">✨ AI 自动规划生成</button>
      <button class="nv-btn nv-btn-sm" data-act="outline-optimize">✎ 按指令优化</button>
      <button class="nv-btn nv-btn-sm" data-act="outline-append" title="超长篇分卷/分批继续：保留已有章节大纲，从第 N 章往后继续规划">⤵ 续规划章节</button>
      <button class="nv-btn nv-btn-sm" data-act="outline-gen">↻ 重新生成</button>
    </div>
    <div class="nv-note" style="margin-bottom:8px">AI 规划状态：${S.sections.length} 个分节中 <b>${empty.length}</b> 个为空${emptyFillable.length ? `（可自动补齐 ${emptyFillable.length} 个，章节大纲按批量规划）` : '（非章节内容已完整）'}</div>
    ${(meta.warnings || []).length ? `<div class="nv-warn" style="margin-bottom:8px">${meta.warnings.map((w) => esc(w)).join('<br>')}</div>` : ''}
    ${meta.instruction ? `<div class="nv-note" style="margin-bottom:8px"><b>生成时的额外要求：</b>${esc(meta.instruction)}</div>` : ''}
    ${s.logline ? `<div class="nv-note" style="margin-bottom:8px"><b>一句话故事：</b>${esc(s.logline)}</div>` : ''}
    ${S.sections.map((sec) => sectionHtml(sec, s[sec.key])).join('')}
  </div>`;
}

function outlineSectionEmpty(key, val) {
  if (key === 'chapters') {
    return !(Array.isArray(val) && val.some((c) => c && !c._placeholder && (c.summary || c.title)));
  }
  if (val == null) return true;
  if (Array.isArray(val)) return val.length === 0;
  if (typeof val === 'object') return Object.keys(val).length === 0;
  return !String(val).trim();
}

function sectionHtml(sec, val) {
  const count = Array.isArray(val) ? val.length : (val && typeof val === 'object' ? Object.keys(val).length : (val ? 1 : 0));
  return `<details class="nv-sec" ${['chapters', 'framework'].includes(sec.key) ? 'open' : ''}>
    <summary>${esc(sec.label)} <span class="nv-pill">${count}</span>${outlineSectionEmpty(sec.key, val) ? badge('空', 'warn') : ''}
      <span class="nv-grow"></span>
      <button class="nv-btn nv-btn-sm" data-act="${sec.key === 'chapters' ? 'outline-gen' : 'outline-ai-section'}" data-key="${esc(sec.key)}" data-label="${esc(sec.label)}">${sec.key === 'chapters' ? '规划章节' : 'AI 生成本节'}</button>
    </summary>
    <div>${sectionBody(sec.key, val)}</div>
  </details>`;
}

const KV_LABEL = {
  core_conflict: '核心冲突', protagonist_goal: '主角目标', antagonist_force: '对立力量', three_acts: '三幕结构',
  theme: '主题内核', opening_image: '开篇画面', ending: '结局走向', era: '时代背景', rules: '世界规则',
  power_system: '力量体系', taboos: '禁忌', text: '内容',
};
const FIELD_LABEL = {
  volume: '卷', title: '标题', from_chapter: '起章', to_chapter: '止章', goal: '卷目标', climax: '卷高潮',
  hook: '钩子', idx: '章', summary: '剧情走向', events: '关键事件', cliffhanger: '章末钩子', characters: '人物ID',
  locations: '地点ID', pov: '视角', time: '时间', event: '事件', chapter: '章节', impact: '影响',
  id: 'ID', name: '名称', type: '类型', desc: '描述', first_chapter: '首次出现', owner: '归属',
  role: '定位', arc: '弧光', function: '作用', relationships: '关系', content: '内容', setup_chapter: '埋设章',
  payoff_chapter: '回收章', status: '状态', payoff_way: '回收方式', intensity: '强度', note: '说明',
  from: '起因', to: '结果', relation: '关系', cause: '因果说明', foreshadow: '关联伏笔',
};

function sectionBody(key, val) {
  if (val == null || (Array.isArray(val) && !val.length) || (typeof val === 'object' && !Array.isArray(val) && !Object.keys(val).length)) {
    return '<div class="nv-hint">（本节为空，可用上方「AI 生成本节」或「AI 自动规划生成」补全）</div>';
  }
  if (typeof val === 'string') return `<div style="line-height:1.8;white-space:pre-wrap">${esc(val)}</div>`;
  if (!Array.isArray(val)) {
    const rows = Object.entries(val).map(([k, v]) => `<dt>${esc(KV_LABEL[k] || k)}</dt><dd>${Array.isArray(v) ? v.map((x) => esc(typeof x === 'object' ? JSON.stringify(x) : x)).join('<br>') : esc(typeof v === 'object' ? JSON.stringify(v) : v)}</dd>`).join('');
    return `<dl class="nv-kv">${rows}</dl>`;
  }
  if (!val.length) return '<div class="nv-hint">（空）</div>';
  if (val.every((x) => typeof x !== 'object')) return `<div style="line-height:1.9">${val.map((x, i) => `<div>${i + 1}. ${esc(x)}</div>`).join('')}</div>`;

  if (key === 'chapters') return chaptersOutlineTable(val);
  if (key === 'beats') {
    return val.map((b) => {
      const isCool = /爽/.test(b.type || '');
      return `<div class="nv-beat"><i>第${num(b.chapter, 0)}章</i><b style="width:${num(b.intensity, 5) * 6}px;background:${isCool ? 'var(--accent-2,#48d1a0)' : 'var(--err,#f06060)'}"></b>
        <span>${esc(b.type || '')} 强度 ${num(b.intensity, 5)} ${esc(b.note || '')}</span></div>`;
    }).join('');
  }
  const keys = [...new Set(val.flatMap((o) => Object.keys(o)))].filter((k) => k !== '_placeholder' && k !== 'volume');
  return `<div class="nv-scroll"><table class="nv-tbl"><thead><tr>${keys.map((k) => `<th>${esc(FIELD_LABEL[k] || k)}</th>`).join('')}</tr></thead>
    <tbody>${val.map((o, i) => `<tr>${keys.map((k) => `<td>${cellVal(o[k], k, i)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function cellVal(v, key, i) {
  if (v == null || v === '') return key === 'idx' || key === 'chapter' ? String(i + 1) : '<span class="nv-muted">—</span>';
  if (Array.isArray(v)) return v.map((x) => esc(typeof x === 'object' ? JSON.stringify(x) : x)).join('、') || '<span class="nv-muted">—</span>';
  return esc(v);
}

function chaptersOutlineTable(chs) {
  return `<div class="nv-scroll"><table class="nv-tbl"><thead><tr><th>章</th><th>标题</th><th>剧情走向</th><th>人物/地点</th><th>章末钩子</th><th>操作</th></tr></thead><tbody>
    ${chs.map((c) => `<tr>
      <td>${num(c.idx, 0)}</td>
      <td>${esc(c.title || '')}</td>
      <td style="max-width:420px">${esc(c.summary || '')}${c._placeholder ? ' ' + badge('待补全', 'warn') : ''}</td>
      <td class="nv-muted">${esc((c.characters || []).join('、') || '—')}<br>${esc((c.locations || []).join('、') || '')}</td>
      <td style="max-width:200px">${esc(c.cliffhanger || c.hook || '—')}</td>
      <td><button class="nv-btn nv-btn-sm" data-act="read" data-idx="${num(c.idx, 0)}">读</button>
          <button class="nv-btn nv-btn-sm" data-act="gen-chapter" data-idx="${num(c.idx, 0)}" title="按大纲重写本章">写作</button></td>
    </tr>`).join('')}</tbody></table></div>`;
}

// ---------- 章节面板 ----------
function chaptersHtml() {
  const chs = S.detail.chapters || [];
  const st = S.detail.stats || {};
  if (!chs.length) return `<div class="nv-card"><div class="nv-empty">还没有章节骨架，请先「① 生成章节大纲」。</div></div>`;
  return `<div class="nv-card">
    <div class="nv-card-t">章节（写 ${st.written || 0} / 共 ${st.total || 0} · ${fmtWords(st.words || 0)}）
      <span class="nv-grow"></span>
      <span class="nv-hint">每章都会带上下文生成：全书框架 + 本章大纲 + 前 2~3 章摘要与结尾 500 字 + 人物/地点档案 + 未回收伏笔 + 已发生事件时间线</span>
    </div>
    <div class="nv-row">
      <span class="nv-lbl" style="margin:0">写作范围</span>
      <select class="nv-select" data-role="mode" style="max-width:130px">
        <option value="next">下一章（未写）</option><option value="range">指定范围</option><option value="all">全部未写</option>
      </select>
      <input class="nv-input nv-num" data-role="from" placeholder="起" value="${num(S.writeFrom, Math.max(1, (chs.find((c) => c.status !== 'done') || {}).idx || 1))}">
      <input class="nv-input nv-num" data-role="to" placeholder="止" value="${num(S.writeTo, Math.min(chs.length, (chs.find((c) => c.status !== 'done') || {}).idx || 1))}">
      <input class="nv-input nv-num" data-role="count" placeholder="章数" value="${num(S.writeCount, 1)}">
      <label class="nv-hint"><input type="checkbox" data-role="force" ${S.writeForce ? 'checked' : ''}> 强制重写已完成的章</label>
      <span class="nv-grow"></span>
      <button class="nv-btn nv-btn-a" data-act="write-custom">开始写作</button>
      <button class="nv-btn" data-act="write-all">写全部未写</button>
    </div>
    <div class="nv-split" style="margin-top:10px">
      <div class="nv-chlist">
        ${chs.map((c) => `<div class="nv-ch ${S.chapterIdx === c.idx ? 'nv-on' : ''}" data-act="read" data-idx="${c.idx}">
          <i>${c.idx}</i><b title="${esc(c.title || '')}">${esc(c.title || '未命名')}</b>
          ${badge(c.status === 'done' ? `${fmtWords(c.words)}` : (STATUS_LABEL[c.status] || c.status), c.status === 'done' ? 'ok' : c.status === 'error' ? 'err' : '')}
        </div>`).join('')}
      </div>
      <div class="nv-grow">${readerHtml()}</div>
    </div>
  </div>`;
}

function readerHtml() {
  if (S.chapterIdx == null) return '<div class="nv-empty">左侧点选章节开始阅读 / 编辑</div>';
  const c = S.chapter || (S.detail.chapters || []).find((x) => x.idx === S.chapterIdx);
  if (!c) return '<div class="nv-empty">章节不存在</div>';
  const hasContent = !!c.content && String(c.content).trim();
  const paras = hasContent ? String(c.content).split(/\n+/).filter((p) => p.trim()) : [];
  return `<div class="nv-card" style="padding:10px">
    <div class="nv-card-t">第 ${c.idx} 章　${esc(c.title || '')}
      ${statusBadge(c.status)}<span class="nv-pill">${fmtWords(c.words || 0)}</span>
      ${c.model ? `<span class="nv-pill">${esc(c.model)}</span>` : ''}
      <span class="nv-grow"></span>
      ${S.editing ? `<button class="nv-btn nv-btn-p nv-btn-sm" data-act="save-chapter">保存</button><button class="nv-btn nv-btn-sm" data-act="cancel-edit">取消</button>`
        : `<button class="nv-btn nv-btn-sm" data-act="edit-chapter">✎ 编辑</button>`}
      <button class="nv-btn nv-btn-sm" data-act="gen-chapter" data-idx="${c.idx}" title="按大纲重写本章">↻ 重写</button>
      <button class="nv-btn nv-btn-sm nv-btn-d" data-act="del-chapter" data-idx="${c.idx}">删除</button>
    </div>
    ${c.error ? `<div class="nv-warn" style="margin-bottom:8px">上次失败：${esc(c.error)}</div>` : ''}
    ${c.summary ? `<div class="nv-note" style="margin-bottom:8px"><b>大纲：</b>${esc(c.summary)}<br><b>章末钩子：</b>${esc(c.cliffhanger || c.hook || '—')}　<b>人物：</b>${esc((c.characters || []).join('、') || '—')}　<b>地点：</b>${esc((c.locations || []).join('、') || '—')}</div>` : ''}
    ${S.editing
      ? `<textarea class="nv-area" id="nv-content" data-role="content" rows="22" style="min-height:46vh">${esc(c.content || '')}</textarea>
         <div class="nv-hint" id="nv-content-count">当前 ${fmtWords(c.words || 0)}（目标 ${S.detail.novel.chapter_words} 字）</div>`
      : (hasContent ? `<div class="nv-read" id="nv-read">${paras.map((p) => `<p>${esc(p)}</p>`).join('')}</div>`
        : `<div class="nv-empty">本章尚未写作<br><span class="nv-hint">点上方「↻ 重写」或章节列表的「写作」按钮开始生成本章</span></div>`)}
  </div>`;
}

// ---------- 导出面板 ----------
function exportHtml() {
  const id = S.currentId;
  const st = S.detail.stats || {};
  return `<div class="nv-card">
    <div class="nv-card-t">导出（${esc(id)}）<span class="nv-pill">已写 ${st.written || 0} 章 / ${fmtWords(st.words || 0)}</span></div>
    <div class="nv-row">
      <a class="nv-btn nv-btn-p" href="/api/novels/${encodeURIComponent(id)}/export?format=txt&download=1" download>⬇ 下载 TXT</a>
      <a class="nv-btn nv-btn-p" href="/api/novels/${encodeURIComponent(id)}/export?format=md&download=1" download>⬇ 下载 Markdown</a>
      <a class="nv-btn nv-btn-p" href="/api/novels/${encodeURIComponent(id)}/export?format=json&download=1" download>⬇ 下载 JSON（含大纲/角色/统计）</a>
      <button class="nv-btn" data-act="copy-all">📋 复制全文</button>
      <button class="nv-btn" data-act="preview-export">预览 TXT 前 3000 字</button>
    </div>
    <div class="nv-hint" style="margin-top:8px">TXT/MD 为可读全本（含章节标题与正文，未写作的章标注「本章尚未写作」）；JSON 含小说参数、演员绑定、大纲全量结构、章节正文与统计，可直接交给模块3 生成剧本。</div>
    ${S.exportPreview ? `<div class="nv-preview" style="max-height:320px;margin-top:8px">${esc(S.exportPreview)}</div>` : ''}
  </div>`;
}

// ---------------- 事件 ----------------
function readVal(role) {
  const el = S.root.querySelector(`[data-role="${role}"]`);
  if (!el) return undefined;
  if (el.type === 'checkbox') return el.checked;
  if (el.type === 'number' || el.type === 'range') return el.value === '' ? '' : Number(el.value);
  return el.value;
}
function collectForm() {
  const f = S.form;
  const setIf = (role, key) => { const v = readVal(role); if (v !== undefined) f[key] = v; };
  setIf('title', 'title'); setIf('tone', 'tone'); setIf('pov', 'pov');
  setIf('cast_size', 'cast_size'); setIf('seasons', 'seasons');
  setIf('target_words', 'target_words'); setIf('chapter_words', 'chapter_words');
  setIf('framework_intro', 'framework_intro');
  // 自定义角色行
  const rows = S.root.querySelectorAll('[data-crow]');
  rows.forEach((row) => {
    const i = Number(row.dataset.crow);
    if (!f.custom_actors[i]) return;
    const q = (r) => row.querySelector(`[data-role="${r}"]`)?.value ?? '';
    f.custom_actors[i] = { ...f.custom_actors[i], name: q('cname'), role: q('crole'), gender: q('cgender'), age: q('cage'), desc: q('cdesc') };
  });
  return f;
}

async function saveForm() {
  const f = collectForm();
  if (!String(f.title || '').trim()) { toast('请填写小说标题', 'err'); return; }
  if (!f.genre) { toast('请选择题材（100 种可选，支持分类筛选与关键词搜索）', 'err'); return; }
  const lim = limits();
  const total = castTotal();
  if (total > num(f.cast_size, 20)) { toast(`角色总数 ${total} 超过角色规模 ${f.cast_size}，请调大角色规模或减少角色`, 'err'); return; }
  if (num(f.chapter_words, 2000) < lim.chapterWords.min || num(f.chapter_words, 2000) > lim.chapterWords.max) { toast(`章节字数必须在 ${lim.chapterWords.min}~${lim.chapterWords.max} 之间`, 'err'); return; }
  if (num(f.target_words, 0) > lim.targetWords.max) { toast(`小说总字数不能超过 ${lim.targetWords.max}`, 'err'); return; }

  const payload = {
    title: f.title, genre: f.genre, tone: f.tone, scale: f.scale,
    cast_size: num(f.cast_size, 20), target_words: num(f.target_words, 1000000),
    chapter_words: num(f.chapter_words, 2000), pov: f.pov, seasons: num(f.seasons, 1),
    framework_intro: f.framework_intro || '',
    ref_doc_path: f.ref_doc_path || '', ref_doc_name: f.ref_doc_name || '',
    actor_ids: f.actor_ids || [], custom_actors: (f.custom_actors || []).filter((c) => (c.name || '').trim() || (c.desc || '').trim()),
  };
  const saved = await guard(async () => {
    if (S.formMode === 'create') {
      const r = await S.ctx.api.post('/api/novels', payload);
      await loadList();
      S.formMode = 'edit';
      await openNovel(r.novel.id);
      return r;
    }
    await S.ctx.api.put(`/api/novels/${S.currentId}`, payload);
    await S.ctx.api.post(`/api/novels/${S.currentId}/actors`, { actorIds: payload.actor_ids, customActors: payload.custom_actors });
    await reloadDetail();
    await loadList();
    return true;
  }, S.formMode === 'create' ? '项目已创建，下一步：① 生成章节大纲' : '已保存');
  if (saved && S.formMode === 'edit') S.tab = 'outline';
  if (saved) render();
}

function buildFrameworkText(framework = {}) {
  const sections = [
    ['一句话故事', 'logline'],
    ['主角', 'protagonist'],
    ['主角目标', 'goal'],
    ['核心阻碍', 'obstacle'],
    ['世界观', 'worldview'],
    ['主线', 'mainPlot'],
    ['支线', 'subplots'],
    ['爆点', 'highlights'],
    ['结局方向', 'ending'],
  ];
  return sections
    .map(([label, key]) => {
      const value = String(framework?.[key] || '').trim();
      return value ? `【${label}】\n${value}` : '';
    })
    .filter(Boolean)
    .join('\n\n');
}

function aiFrameworkPayload() {
  const f = collectForm();
  return {
    title: f.title || '',
    genre: f.genre || '',
    tone: f.tone || '',
    pov: f.pov || '',
    castSize: num(f.cast_size, 20),
    targetWords: num(f.target_words, 1000000),
    chapterWords: num(f.chapter_words, 2000),
    seasons: num(f.seasons, 1),
    actorIds: f.actor_ids || [],
    customActors: (f.custom_actors || []).filter((c) => (c.name || '').trim() || (c.desc || '').trim()),
    refDocPath: f.ref_doc_path || '',
  };
}

async function openAiFramework() {
  if (S.busy) return;
  const f = collectForm();
  const provider = S.llm?.provider;
  if (!llmReady() && provider !== 'mock') { showLlmHelp(); return; }
  const payload = aiFrameworkPayload();
  const r = await guard(async () => S.ctx.api.post('/api/novels/ai/framework', payload));
  if (r) showAiFrameworkPreview(r, payload);
}

function showAiFrameworkPreview(proposal, payload) {
  const wrap = document.createElement('div');
  const titleOptions = [...new Set([proposal.title, ...(Array.isArray(proposal.titleAlternatives) ? proposal.titleAlternatives : [])].filter(Boolean))];
  const framework = proposal.framework || {};
  const characters = Array.isArray(proposal.characters) ? proposal.characters : [];
  const sections = [
    ['一句话故事', 'logline'], ['主角', 'protagonist'], ['主角目标', 'goal'], ['核心阻碍', 'obstacle'],
    ['世界观', 'worldview'], ['主线', 'mainPlot'], ['支线', 'subplots'], ['爆点', 'highlights'], ['结局方向', 'ending'],
  ];
  wrap.innerHTML = `
    <div class="nv-hint" style="margin-bottom:8px;line-height:1.7">本次生成只调用 1 次 LLM。确认后标题和故事框架会直接覆盖当前表单；勾选的角色会创建演员矩阵 C-xxxx 角色卡，不会自动出定妆图。</div>
    ${proposal.mocked ? '<div class="nv-warn" style="margin-bottom:8px">当前是 mock 模式，只会填入「【离线占位】」内容，不会创建角色卡。</div>' : ''}
    <div class="nv-card" style="padding:10px">
      <div class="nv-card-t">标题</div>
      <div class="nv-col">${titleOptions.map((t, i) => `<label class="nv-row" style="gap:6px;cursor:pointer"><input type="radio" name="nv-ai-title" value="${esc(t)}" ${i === 0 ? 'checked' : ''}> <span>${esc(t)}${i === 0 ? '（主标题）' : '（备选）'}</span></label>`).join('')}</div>
    </div>
    <div class="nv-card" style="padding:10px;margin-top:8px">
      <div class="nv-card-t">故事框架</div>
      <div class="nv-preview" style="max-height:260px">${sections.map(([label, key]) => {
        const v = String(framework[key] || '').trim();
        return v ? `<b>【${esc(label)}】</b>\n${esc(v)}` : '';
      }).filter(Boolean).join('\n\n')}</div>
    </div>
    <div class="nv-card" style="padding:10px;margin-top:8px">
      <div class="nv-card-t">推荐角色（${characters.length}）</div>
      ${characters.length ? characters.map((c, i) => `<label class="nv-row" style="align-items:flex-start;gap:6px;margin-bottom:8px;cursor:pointer">
        <input type="checkbox" data-ai-char="${i}" checked>
        <span><b>${esc(c.name)}</b> ${esc(c.role || '')}${c.gender ? `｜${esc(c.gender)}` : ''}${c.age ? `｜${esc(c.age)}` : ''}<br>
        <span class="nv-hint">剧情作用：${esc(c.reason || '—')}<br>外观/性格：${esc([c.appearance, c.personality].filter(Boolean).join('；') || '—')}</span></span>
      </label>`).join('') : `<div class="nv-hint">${proposal.mocked ? 'mock 模式不推荐角色。' : 'AI 判断现有角色已经够用，没有推荐新角色。'}</div>`}
    </div>
    ${(proposal.warnings || []).length ? `<div class="nv-warn" style="margin-top:8px;line-height:1.7">${proposal.warnings.map(esc).join('<br>')}</div>` : ''}
  `;
  const m = S.ctx.modal({ title: '✨ AI 自动填写预览', body: wrap, width: 820 });
  const bar = document.createElement('div');
  bar.className = 'nv-row';
  bar.style.marginTop = '10px';
  bar.innerHTML = '<button class="nv-btn nv-btn-p" data-a="ok">确认填写</button><button class="nv-btn" data-a="again">重新生成</button><button class="nv-btn" data-a="no">取消</button>';
  wrap.appendChild(bar);
  bar.querySelector('[data-a="no"]').onclick = () => m.close();
  bar.querySelector('[data-a="again"]').onclick = () => { m.close(); setTimeout(() => { openAiFramework(); }, 0); };
  bar.querySelector('[data-a="ok"]').onclick = async () => {
    const okBtn = bar.querySelector('[data-a="ok"]');
    okBtn.disabled = true;
    const selectedTitle = wrap.querySelector('input[name="nv-ai-title"]:checked')?.value || proposal.title;
    const frameworkText = buildFrameworkText(proposal.framework);
    const selectedChars = [...wrap.querySelectorAll('input[data-ai-char]:checked')]
      .map((el) => characters[Number(el.dataset.aiChar)]).filter(Boolean);
    let createdNames = new Set();
    let createdActorIds = [];
    if (!proposal.mocked && selectedChars.length) {
      const r = await guard(async () => S.ctx.api.post('/api/novels/ai/commit-characters', {
        novelId: S.currentId || null,
        characters: selectedChars,
      }));
      if (!r) { okBtn.disabled = false; return; }
      const created = r.created || [];
      createdNames = new Set(created.map((x) => String(x.name || '').toLowerCase()));
      createdActorIds = created.map((x) => x.actorId).filter(Boolean);
      if (r.failed?.length) toast(`部分角色创建失败：${r.failed.map((x) => x.name).join('、')}`, 'err');
      if (r.warnings?.length) toast(r.warnings[0], 'warn');
    }
    S.form = collectForm();
    S.form.title = selectedTitle;
    S.form.framework_intro = frameworkText;
    if (createdNames.size) {
      S.form.custom_actors = (S.form.custom_actors || []).filter((c) => !createdNames.has(String(c.name || '').toLowerCase()));
      S.form.actor_ids = [...new Set([...(S.form.actor_ids || []), ...createdActorIds])];
    }
    m.close();
    S.tab = 'params';
    render();
    toast(proposal.mocked ? '已填入离线占位内容；mock 模式不会创建角色卡' : 'AI 内容已填入，请检查后点「保存修改」', 'ok');
  };
}

async function startOutlineGen() {
  if (!llmReady() && !(await S.ctx.confirm('当前 LLM 未就绪，生成会失败。可到「设置」页把 provider 切换为 mock（离线模板）后使用占位内容演示。仍要继续尝试吗？'))) return;
  const has = !!S.detail?.outline;
  if (has && !(await S.ctx.confirm('重新生成会新增一个大纲版本（已写作的章节正文不会被覆盖）。继续？'))) return;
  const r = await guard(async () => S.ctx.api.post(`/api/novels/${S.currentId}/outline`, { saveVersion: true }));
  if (!r) return;
  toast(`大纲已生成：规划 ${(r.outline?.sections?.chapters || []).length} 章，${r.summary?.calls || 0} 次模型调用${r.summary?.warnings?.length ? `（${r.summary.warnings.length} 条提示）` : ''}`, 'ok');
  S.tab = 'outline';
  await reloadDetail();
  await loadList();
}

function outlineAiSnapshot() {
  const s = S.detail?.outline?.sections || {};
  const empty = S.sections.filter((sec) => outlineSectionEmpty(sec.key, s[sec.key]));
  return {
    sections: s,
    empty,
    fillable: empty.filter((sec) => sec.key !== 'chapters'),
    chaptersEmpty: outlineSectionEmpty('chapters', s.chapters),
  };
}

function showOutlineAiReport(result) {
  const fill = result?.fill || {};
  const chapter = result?.chapter || {};
  const warnings = [
    ...(Array.isArray(fill.warnings) ? fill.warnings : []),
    ...(Array.isArray(chapter.summary?.warnings) ? chapter.summary.warnings : []),
  ].filter(Boolean);
  if (!warnings.length && !fill.mocked) return;
  const body = document.createElement('div');
  body.innerHTML = `<div class="nv-note" style="line-height:1.8">
    <b>规划结果</b><br>
    章节大纲：${chapter.outline ? `v${chapter.outline.version}，规划 ${(chapter.outline.sections?.chapters || []).length} 章` : '本次未重新规划'}<br>
    非章节分节：本次补齐 ${(fill.results || []).length} 个
  </div>
  ${warnings.length ? `<div class="nv-warn" style="margin-top:8px;max-height:240px;overflow:auto">${warnings.map((w) => esc(w)).join('<br>')}</div>` : ''}
  ${fill.mocked ? '<div class="nv-note" style="margin-top:8px">当前包含离线占位内容。配置真实 LLM 后可逐节点「AI 生成本节」重做。</div>' : ''}`;
  const m = S.ctx.modal({ title: 'AI 大纲规划结果', body, width: 560 });
  const bar = document.createElement('div');
  bar.className = 'nv-row';
  bar.style.marginTop = '10px';
  bar.innerHTML = '<button class="nv-btn nv-btn-p" data-act="modal-close">知道了</button>';
  body.appendChild(bar);
  bar.querySelector('[data-act="modal-close"]').onclick = () => m.close();
}

function startOutlineAiPlan() {
  const snap = outlineAiSnapshot();
  if (!snap.chaptersEmpty && !snap.fillable.length) {
    toast('大纲 14 个分节都已有内容；如需重做某一节，请点该节的「AI 生成本节」', 'info');
    return;
  }
  if (!llmReady()) {
    S.ctx.confirm('当前 LLM 未就绪：章节规划可能失败，非章节分节会退回离线占位。可先到「设置」页切换 mock 或配置 API Key。仍要继续吗？').then((ok) => {
      if (ok) openOutlineAiPlanModal(snap);
    });
    return;
  }
  openOutlineAiPlanModal(snap);
}

function openOutlineAiPlanModal(snap) {
  const wrap = document.createElement('div');
  wrap.innerHTML = `<div class="nv-hint" style="line-height:1.8">
    将自动完成整份大纲的缺口规划：${snap.chaptersEmpty ? '<b>先规划章节大纲</b>，' : ''}${snap.fillable.length ? `再逐节生成 ${snap.fillable.length} 个空缺分节（${snap.fillable.map((x) => esc(x.label)).join('、')}）` : '非章节分节已完整'}。
    已有内容默认保留；结果会保存为新的版本。</div>
    <label class="nv-f" style="margin-top:10px"><span class="nv-lbl">额外规划要求（可选）</span>
      <textarea class="nv-area" id="nv-outline-ai-note" rows="4" placeholder="例如：前三章必须强钩子；反派第 8 章登场；每 10 章一次大反转"></textarea>
    </label>`;
  const m = S.ctx.modal({ title: 'AI 自动规划生成', body: wrap, width: 600 });
  const bar = document.createElement('div');
  bar.className = 'nv-row';
  bar.style.marginTop = '10px';
  bar.innerHTML = '<button class="nv-btn nv-btn-a" data-a="go">开始规划</button><button class="nv-btn" data-a="no">取消</button>';
  wrap.appendChild(bar);
  bar.querySelector('[data-a="no"]').onclick = () => m.close();
  bar.querySelector('[data-a="go"]').onclick = async () => {
    const instruction = wrap.querySelector('#nv-outline-ai-note').value.trim();
    m.close();
    const result = await guard(async () => {
      let chapter = null;
      if (snap.chaptersEmpty) {
        chapter = await S.ctx.api.post(`/api/novels/${S.currentId}/outline`, { saveVersion: true });
      }
      let fill = null;
      if (snap.fillable.length) {
        fill = await S.ctx.api.post(`/api/novels/${S.currentId}/outline/ai/fill`, {
          save: true,
          onlyEmpty: true,
          instruction,
        });
      }
      return { chapter, fill };
    }, 'AI 大纲规划已保存为新版本');
    if (!result) return;
    S.tab = 'outline';
    await reloadDetail();
    await loadList();
    if (result.fill?.mocked) toast('已生成离线占位大纲；配置真实 LLM 后可逐节重做', 'warn');
    showOutlineAiReport(result);
  };
}

async function startOutlineAiSection(key, label) {
  if (!key) return;
  if (!llmReady() && !(await S.ctx.confirm('当前 LLM 未就绪，本节可能生成离线占位或失败。仍要继续吗？'))) return;
  if (!(await S.ctx.confirm(`AI 将重新生成「${label}」并保存为新的大纲版本，继续？`))) return;
  const r = await guard(async () => S.ctx.api.post(`/api/novels/${S.currentId}/outline/ai/section`, {
    key,
    save: true,
  }));
  if (!r) return;
  S.tab = 'outline';
  await reloadDetail();
  toast(r.mocked ? `「${label}」已生成离线占位内容` : `「${label}」已生成并保存为 v${r.saved?.version || ''}`, r.mocked ? 'warn' : 'ok');
}

function optimizeOutline() {
  const wrap = document.createElement('div');
  wrap.innerHTML = `<div class="nv-hint" style="margin-bottom:6px">用中文写清要改什么，例如：前三章节奏加快；把反派提前到第 5 章登场；伏笔 F-01 提前到第 8 章回收；增加一条主角与导师的师徒线。</div>
    <textarea class="nv-area" id="nv-opt" rows="5" placeholder="优化指令…"></textarea>`;
  const m = S.ctx.modal({ title: '按指令优化大纲', body: wrap, width: 560 });
  const bar = document.createElement('div');
  bar.className = 'nv-row';
  bar.style.marginTop = '10px';
  bar.innerHTML = '<button class="nv-btn nv-btn-p" data-a="go">开始优化</button><button class="nv-btn" data-a="no">取消</button>';
  wrap.appendChild(bar);
  bar.querySelector('[data-a="no"]').onclick = () => m.close();
  bar.querySelector('[data-a="go"]').onclick = async () => {
    const instruction = wrap.querySelector('#nv-opt').value.trim();
    if (!instruction) { toast('请填写优化指令', 'err'); return; }
    m.close();
    const r = await guard(async () => S.ctx.api.post(`/api/novels/${S.currentId}/outline/optimize`, { instruction }));
    if (r) {
      toast(`大纲已优化为 v${r.outline?.version}`, 'ok');
      S.tab = 'outline';
      await reloadDetail();
    }
  };
}

function appendOutline() {
  const o = S.detail?.outline;
  const done = (S.detail?.chapters || []).length;
  const wrap = document.createElement('div');
  wrap.innerHTML = `<div class="nv-hint" style="margin-bottom:6px;line-height:1.7">超长篇（>200 章 / 千万字）分卷继续：保留第 1~N-1 章既有大纲与全部正文，从第 N 章往后继续规划。
    当前大纲共 ${o ? (o.sections?.chapters || []).length : 0} 章（骨架 ${done} 行）。</div>
    <div class="nv-row"><label class="nv-f"><span class="nv-lbl">起始章</span><input class="nv-input" id="nv-app-from" type="number" min="2" value="${o ? (o.sections?.chapters || []).length + 1 : 2}"></label>
    <label class="nv-f"><span class="nv-lbl">本次规划章数（≤200）</span><input class="nv-input" id="nv-app-count" type="number" min="1" max="200" value="100"></label></div>
    <div class="nv-hint" style="margin-top:6px">按每批 20 章调用模型（例如 100 章约 5 次），请耐心等待；LLM 未就绪时可先到设置页切到 mock 验证流程。</div>`;
  const m = S.ctx.modal({ title: '续规划后续章节', body: wrap, width: 520 });
  const bar = document.createElement('div');
  bar.className = 'nv-row';
  bar.style.marginTop = '10px';
  bar.innerHTML = '<button class="nv-btn nv-btn-p" data-a="go">开始续规划</button><button class="nv-btn" data-a="no">取消</button>';
  wrap.appendChild(bar);
  bar.querySelector('[data-a="no"]').onclick = () => m.close();
  bar.querySelector('[data-a="go"]').onclick = async () => {
    const chapterFrom = num(wrap.querySelector('#nv-app-from').value, 0);
    const chapterCount = num(wrap.querySelector('#nv-app-count').value, 0);
    if (chapterFrom < 2) { toast('起始章必须大于 1（第 1 章起请用「重新生成」）', 'err'); return; }
    if (chapterCount < 1 || chapterCount > 200) { toast('本次规划章数必须在 1~200 之间', 'err'); return; }
    m.close();
    const r = await guard(async () => S.ctx.api.post(`/api/novels/${S.currentId}/outline`, { chapterFrom, chapterCount, saveVersion: true }));
    if (r) {
      toast(`续规划完成：现共 ${(r.outline?.sections?.chapters || []).length} 章（v${r.outline?.version}）`, 'ok');
      S.tab = 'outline';
      await reloadDetail();
      await loadList();
    }
  };
}

function watchJob(jobId) {
  stopWatching();
  S.jobId = jobId;
  S.job = { status: 'queued', progress: 0, done: 0, total: 1 };
  render();
  const onUpdate = (job) => {
    if (!job) return;
    S.job = job;
    const bar = S.root?.querySelector('.nv-job');
    if (bar) {
      const holder = document.createElement('div');
      holder.innerHTML = jobBarHtml();
      const fresh = holder.firstElementChild;
      if (fresh && bar.parentElement) bar.replaceWith(fresh);
    } else {
      const main = S.root?.querySelector('#nv-main');
      if (main && main.firstElementChild) main.firstElementChild.insertAdjacentHTML('beforeend', jobBarHtml());
    }
    if (['done', 'error', 'canceled'].includes(job.status)) {
      stopWatching();
      if (job.status === 'done') {
        const res = job.result || {};
        toast(`写作完成：成功 ${res.ok ?? 0} / ${res.total ?? job.total} 章，共 ${fmtWords(res.words || 0)}${res.failed ? `，失败 ${res.failed} 章` : ''}`, res.failed ? 'info' : 'ok');
      } else if (job.status === 'error') toast(`写作任务失败：${job.error}`, 'err');
      reloadDetail().then(loadList).catch(() => { /* ignore */ });
    }
  };
  if (S.ctx.watchJob) {
    S.stopWatch = S.ctx.watchJob(jobId, onUpdate);
  } else {
    // 兜底：自行轮询 /api/jobs/:id
    const timer = setInterval(async () => {
      try {
        const r = await S.ctx.api.get(`/api/jobs/${jobId}`);
        onUpdate(r.job);
      } catch { /* ignore */ }
    }, 1000);
    S.timers.push(timer);
    S.stopWatch = () => clearInterval(timer);
  }
}
function stopWatching() {
  if (S.stopWatch) { try { S.stopWatch(); } catch { /* ignore */ } S.stopWatch = null; }
}

async function startWrite(payload) {
  const r = await guard(async () => S.ctx.api.post(`/api/novels/${S.currentId}/chapters/generate`, payload));
  if (r?.jobId) {
    S.tab = 'chapters';
    watchJob(r.jobId);
    toast(`已创建写作任务：${r.total} 章`, 'info');
  }
}

async function loadChapter(idx) {
  S.chapterIdx = idx;
  S.editing = false;
  try {
    const r = await S.ctx.api.get(`/api/novels/${S.currentId}/chapters/${idx}`);
    S.chapter = r.chapter;
  } catch (e) { toast(errText(e), 'err'); }
  render();
}

function bindFileInput() {
  const input = S.root?.querySelector('#nv-ref-file');
  if (!input) return;
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    const f = S.form;
    toast('上传中…', 'info');
    try {
      const up = await S.ctx.api.upload(file);
      if (!up?.path) throw new Error('上传返回缺少 path');
      f.ref_doc_path = up.path;
      f.ref_doc_name = up.name || file.name;
      collectForm();
      render();
      toast(`范本已上传：${f.ref_doc_name}`, 'ok');
      loadRefPreview();
    } catch (e) { toast(`上传失败：${errText(e)}`, 'err'); }
  });
}

async function loadRefPreview() {
  const box = S.root?.querySelector('#nv-ref-preview');
  if (!box || !S.form?.ref_doc_path) return;
  try {
    const r = await S.ctx.api.get(`/api/upload/text?path=${encodeURIComponent(S.form.ref_doc_path)}`);
    box.textContent = String(r.text || '').slice(0, 1200) || '（范本为空）';
  } catch (e) { box.textContent = `范本正文读取失败：${errText(e)}`; }
}

function bindAreaCounters() {
  const area = S.root?.querySelector('#nv-framework');
  const count = S.root?.querySelector('#nv-fw-count');
  if (area && count) {
    const upd = () => { count.textContent = `已输入 ${area.value.length} 字`; };
    area.addEventListener('input', upd);
  }
  const content = S.root?.querySelector('#nv-content');
  const cc = S.root?.querySelector('#nv-content-count');
  if (content && cc) {
    const target = num(S.detail?.novel?.chapter_words, 2000);
    const upd = () => { cc.textContent = `当前约 ${content.value.replace(/\s/g, '').length} 字（目标 ${target} 字，偏离过大时生成会要求续写补足）`; };
    content.addEventListener('input', upd);
  }
  if (S.form?.ref_doc_path) loadRefPreview();
}

async function onClickEvent(e) {
  const el = e.target.closest('[data-act]');
  if (!el || !S.root.contains(el)) return;
  const act = el.dataset.act;
  const idx = Number(el.dataset.idx || 0);
  if (S.busy && !['modal-close'].includes(act)) { /* 允许并发读取类操作 */ }
  switch (act) {
    case 'goto-settings': stopWatching(); S.ctx.go('settings'); return;
    case 'llm-help': case 'llm-help2': showLlmHelp(); return;
    case 'modal-close': return;
    case 'new-novel':
      S.view = 'create'; S.formMode = 'create'; S.tab = 'params'; S.form = newForm();
      loadActors();
      render();
      return;
    case 'cancel-create': S.view = 'empty'; render(); return;
    case 'cancel-edit': S.tab = 'params'; S.form = applyFormFromNovel(S.detail.novel) || S.form; render(); return;
    case 'refresh': await guard(loadList, '已刷新'); render(); return;
    case 'refresh-detail': await guard(reloadDetail, '已刷新'); return;
    case 'open': await guard(() => openNovel(el.dataset.id)); return;
    case 'del-novel': {
      const id = el.dataset.id;
      if (!(await S.ctx.confirm(`删除小说 ${id}？其大纲与全部章节将一并删除，不可恢复。`))) return;
      await guard(async () => { await S.ctx.api.del(`/api/novels/${id}`); if (S.currentId === id) { S.currentId = null; S.detail = null; S.view = 'empty'; } await loadList(); }, '已删除');
      render();
      return;
    }
    case 'cat': S.genreCat = el.dataset.cat; collectForm(); render(); return;
    case 'genre': {
      S.form = collectForm();
      S.form.genre = el.dataset.id;
      const g = S.genres.find((x) => x.id === el.dataset.id);
      if (g?.tone) S.form.tone = g.tone;
      render();
      return;
    }
    case 'scale': S.form = collectForm(); S.form.target_words = num(el.dataset.min, 1000000); render(); return;
    case 'load-actors': S.actorsLoaded = false; await loadActors(); render(); return;
    case 'pick-actor': {
      S.form = collectForm();
      const id = el.dataset.id;
      const set = new Set(S.form.actor_ids || []);
      if (set.has(id)) set.delete(id); else set.add(id);
      S.form.actor_ids = [...set];
      render();
      return;
    }
    case 'add-custom':
      S.form = collectForm();
      S.form.custom_actors = [...(S.form.custom_actors || []), { name: '', role: '', gender: '', age: '', desc: '' }];
      render();
      return;
    case 'rm-custom': {
      S.form = collectForm();
      S.form.custom_actors.splice(Number(el.dataset.i), 1);
      S.form.custom_actors = S.form.custom_actors.map((c, i) => ({ ...c, id: c.id || `CX-${String(i + 1).padStart(4, '0')}` }));
      render();
      return;
    }
    case 'cast-warn': toast('角色总数超过角色规模，请先调整后再保存', 'err'); return;
    case 'save-form': await saveForm(); return;
    case 'ai-framework': await openAiFramework(); return;
    case 'upload-ref': S.root.querySelector('#nv-ref-file')?.click(); return;
    case 'clear-ref':
      S.form = collectForm(); S.form.ref_doc_path = ''; S.form.ref_doc_name = ''; render(); return;
    case 'tab': S.tab = el.dataset.tab; render(); return;
    case 'outline-gen': await startOutlineGen(); return;
    case 'outline-ai-plan': startOutlineAiPlan(); return;
    case 'outline-ai-section': await startOutlineAiSection(el.dataset.key, el.dataset.label || '大纲分节'); return;
    case 'outline-optimize': optimizeOutline(); return;
    case 'outline-append': appendOutline(); return;
    case 'write-next': await startWrite({ mode: 'next', count: 1 }); return;
    case 'write-all': await startWrite({ mode: 'all', force: !!readVal('force') }); return;
    case 'write-batch': S.tab = 'chapters'; render(); return;
    case 'write-custom': {
      const mode = readVal('mode') || 'next';
      const payload = { mode, force: !!readVal('force') };
      if (mode === 'range') { payload.from = num(readVal('from'), 1); payload.to = num(readVal('to'), payload.from); }
      if (mode === 'next') payload.count = num(readVal('count'), 1);
      S.writeFrom = readVal('from'); S.writeTo = readVal('to'); S.writeCount = readVal('count'); S.writeForce = !!readVal('force');
      await startWrite(payload);
      return;
    }
    case 'gen-chapter': await startWrite({ mode: 'range', from: idx, to: idx, force: true }); return;
    case 'read': await loadChapter(idx); return;
    case 'edit-chapter': S.editing = true; render(); return;
    case 'cancel-edit': S.editing = false; render(); return;
    case 'save-chapter': {
      const content = readVal('content');
      const r = await guard(async () => S.ctx.api.put(`/api/novels/${S.currentId}/chapters/${S.chapterIdx}`, { content }), '已保存');
      if (r) { S.editing = false; await loadChapter(S.chapterIdx); await reloadDetail(); }
      return;
    }
    case 'del-chapter': {
      if (!(await S.ctx.confirm(`删除第 ${idx} 章？正文将一并删除。`))) return;
      await guard(async () => { await S.ctx.api.del(`/api/novels/${S.currentId}/chapters/${idx}`); S.chapter = null; S.chapterIdx = null; }, '已删除');
      await guard(reloadDetail);
      return;
    }
    case 'cancel-job':
      if (S.jobId) await guard(async () => S.ctx.api.post(`/api/jobs/${S.jobId}/cancel`, {}), '已请求取消');
      return;
    case 'dismiss-job': S.job = null; S.jobId = null; render(); return;
    case 'copy-all': {
      const r = await guard(async () => S.ctx.api.get(`/api/novels/${S.currentId}/export?format=txt`));
      if (r?.content) {
        try { await navigator.clipboard.writeText(r.content); toast(`已复制全文（${fmtWords(r.bytes || r.content.length)}）`, 'ok'); }
        catch { toast('浏览器拒绝了剪贴板权限，请改用下载 TXT', 'err'); }
      }
      return;
    }
    case 'preview-export': {
      const r = await guard(async () => S.ctx.api.get(`/api/novels/${S.currentId}/export?format=txt`));
      if (r?.content) { S.exportPreview = r.content.slice(0, 3000); render(); }
      return;
    }
    default: return;
  }
}

function showLlmHelp() {
  const body = document.createElement('div');
  body.innerHTML = `<div class="nv-note" style="line-height:1.9">
    <b>方式一（推荐）：接入真实模型</b><br>「设置」页 → LLM → provider 选 deepseek → 填 API Key（也可在 ~/.dsh/.credentials.yaml 配置 DEEPSEEK_API_KEY）→ 保存 → 点「测试连接」。<br><br>
    <b>方式二：离线模板（mock）</b><br>「设置」页 → LLM → provider 选 <b>mock</b> → 保存。之后生成大纲/章节会得到结构化占位内容（不联网、不消耗额度），用于先把「大纲 → 章节 → 导出」流程跑通，结构、ID 规则、伏笔表等字段与真实生成完全一致。<br><br>
    <b>方式三：本地/其它 OpenAI 兼容服务</b><br>「设置」页 → LLM → baseUrl 填你的服务地址、model 填模型名即可（如 http://127.0.0.1:11434/v1）。
  </div>`;
  const m = S.ctx.modal({ title: 'LLM 未配置怎么办', body, width: 560 });
  const bar = document.createElement('div');
  bar.className = 'nv-row';
  bar.style.marginTop = '10px';
  bar.innerHTML = '<button class="nv-btn nv-btn-p" data-a="go">去设置页</button><button class="nv-btn" data-a="no">关闭</button>';
  body.appendChild(bar);
  bar.querySelector('[data-a="no"]').onclick = () => m.close();
  bar.querySelector('[data-a="go"]').onclick = () => { m.close(); stopWatching(); S.ctx.go('settings'); };
}

function onChangeEvent(e) {
  const role = e.target?.dataset?.role;
  if (!role) return;
  if (role === 'chapter_words_range') {
    const input = S.root.querySelector('[data-role="chapter_words"]');
    if (input) input.value = e.target.value;
    S.form = collectForm();
    S.form.chapter_words = Number(e.target.value);
    updateDerivedHints();
    return;
  }
  if (['mode', 'force', 'cgender'].includes(role)) return;
  if (role === 'chapter_words' || role === 'target_words' || role === 'cast_size' || role === 'seasons') {
    S.form = collectForm();
    updateDerivedHints();
  }
}

/** 局部刷新派生提示（避免整页重渲染导致输入框失焦） */
function updateDerivedHints() {
  const f = S.form || {};
  const derived = S.root?.querySelector('#nv-derived');
  if (derived) {
    const ch = num(f.chapter_words, 2000);
    derived.innerHTML = `按 总字数 ÷ 章节字数 推导需规划 <b>${Math.max(1, Math.ceil(num(f.target_words, 10000) / Math.max(1, ch)))}</b> 章（单次生成上限 200 章，超出请分卷/分批继续）`;
  }
  const range = S.root?.querySelector('[data-role="chapter_words_range"]');
  if (range && Number(range.value) !== num(f.chapter_words, 2000)) range.value = num(f.chapter_words, 2000);
  const pill = S.root?.querySelector('[data-role="cast-pill"]');
  if (pill) {
    const t = castTotal();
    const over = t > num(f.cast_size, 20);
    pill.className = `nv-pill ${over ? 'nv-badge-err' : ''}`;
    pill.textContent = `已定义 ${t} 名${over ? `（超出 ${t - num(f.cast_size, 20)} 名）` : ''}`;
  }
  const note = S.root?.querySelector('[data-role="cast-warn"]');
  if (note) {
    const t = castTotal();
    const over = t > num(f.cast_size, 20);
    note.style.display = over ? '' : 'none';
    note.innerHTML = `角色总数 ${t} 超过角色规模 ${num(f.cast_size, 20)}：请调大「角色规模上限」或减少角色后再保存（硬上限 200 名）。`;
  }
}

let inputTimer = null;
function onInputEvent(e) {
  const role = e.target?.dataset?.role;
  if (role === 'q') {
    S.q = e.target.value;
    const list = S.root.querySelector('.nv-list');
    if (list) list.innerHTML = S.novels.filter((n) => !S.q || `${n.title} ${n.genre_name} ${n.id}`.toLowerCase().includes(S.q.toLowerCase())).map(itemHtml).join('') || '<div class="nv-empty">没有匹配的项目</div>';
    return;
  }
  if (role === 'genreQ') {
    S.genreQ = e.target.value;
    const f = collectForm();
    const shown = S.genres.filter((g) => (S.genreCat === '全部' || g.cat === S.genreCat)
      && (!S.genreQ || `${g.name} ${g.tags?.join(' ') || ''} ${g.desc || ''}`.toLowerCase().includes(S.genreQ.toLowerCase())));
    const grid = S.root.querySelector('.nv-grid');
    if (grid) grid.innerHTML = shown.map((g) => `<div class="nv-gitem ${g.id === f.genre ? 'nv-on' : ''}" data-act="genre" data-id="${esc(g.id)}">
      <b>${esc(g.name)}</b><span>${esc(g.cat)} · ${esc(g.desc || '')}</span><span>钩子：${esc(g.hook || '—')}</span></div>`).join('');
    return;
  }
  if (role === 'actorQ') {
    S.actorQ = e.target.value;
    const list = S.root.querySelector('#nv-actor-list');
    if (list) list.innerHTML = actorListHtml();
    return;
  }
  if (['cname', 'crole', 'cdesc', 'cage'].includes(role)) {
    clearTimeout(inputTimer);
    inputTimer = setTimeout(() => { collectForm(); }, 300);
  }
}

// ---------------- 生命周期 ----------------
export function mount(root, ctx) {
  unmount();
  S.root = root;
  S.ctx = ctx;
  S.novels = []; S.q = ''; S.view = 'empty'; S.currentId = null; S.detail = null;
  S.tab = 'params'; S.chapterIdx = null; S.chapter = null; S.editing = false;
  S.job = null; S.jobId = null; S.busy = false; S.exportPreview = '';
  S.actors = []; S.actorsLoaded = false; S.actorQ = '';
  S.form = null; S.formMode = 'create';
  S.handlers = {
    click: (e) => { onClickEvent(e).catch((err) => handleLlmError(err)); },
    change: (e) => onChangeEvent(e),
    input: (e) => onInputEvent(e),
  };
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  root.addEventListener('click', S.handlers.click);
  root.addEventListener('change', S.handlers.change);
  root.addEventListener('input', S.handlers.input);
  root.innerHTML = '<div class="nv-empty">正在加载小说项目…</div>';
  (async () => {
    await loadMeta();
    try { await loadList(); } catch (e) { toast(`小说列表加载失败：${errText(e)}`, 'err'); }
    S.form = newForm();
    render();
    if (S.novels.length) { try { await openNovel(S.novels[0].id); } catch { /* ignore */ } }
  })();
}

export function unmount() {
  stopWatching();
  for (const t of S.timers) { try { clearInterval(t); clearTimeout(t); } catch { /* ignore */ } }
  S.timers = [];
  if (inputTimer) { clearTimeout(inputTimer); inputTimer = null; }
  if (S.root && S.handlers) {
    try {
      S.root.removeEventListener('click', S.handlers.click);
      S.root.removeEventListener('change', S.handlers.change);
      S.root.removeEventListener('input', S.handlers.input);
    } catch { /* ignore */ }
  }
  S.handlers = null;
  S.root = null;
  S.ctx = null;
  S.detail = null;
  S.job = null;
}
