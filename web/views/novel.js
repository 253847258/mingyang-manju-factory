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
.nv-asset-bar{display:grid;grid-template-columns:repeat(3,minmax(180px,1fr));gap:8px;margin-top:8px}
.nv-asset-col{background:var(--panel-2,#1e1e28);border:1px solid var(--line,#2a2a36);border-radius:8px;padding:7px 8px;min-width:0}
.nv-asset-col>b{font-size:11.5px;display:block;margin-bottom:5px}
.nv-asset-list{display:flex;gap:5px;flex-wrap:wrap;max-height:76px;overflow:auto}
.nv-asset-chip{display:inline-flex;gap:4px;align-items:center;border:1px solid var(--line,#2a2a36);border-radius:6px;padding:2px 6px;background:var(--panel,#16161d);cursor:pointer;font-size:11.5px;max-width:100%}
.nv-asset-chip:hover{border-color:var(--accent,#6c8cff)}
.nv-asset-chip b{white-space:nowrap;font-size:11px}
.nv-asset-chip span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nv-asset-c b{color:#6c8cff}.nv-asset-e b{color:#48d1a0}.nv-asset-p b{color:#f0b060}
.nv-id{padding:0 3px;border-radius:4px;font-weight:700;font-size:.92em}
.nv-id-c{background:rgba(108,140,255,.16);color:#9eb1ff}
.nv-id-e{background:rgba(72,209,160,.14);color:#74e0b8}
.nv-id-p{background:rgba(240,176,96,.14);color:#f3c57f}
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
.nv-pipe{display:flex;gap:8px;align-items:center;flex-wrap:wrap;background:linear-gradient(90deg,rgba(108,140,255,.12),rgba(72,209,160,.08));border:1px solid var(--line,#2a2a36);border-radius:8px;padding:7px 10px}
.nv-pipe-t{font-weight:700;font-size:12px;color:var(--accent,#6c8cff)}
.nv-split{display:flex;gap:10px;align-items:flex-start}
.nv-lbl{color:var(--muted,#8b8b9c);font-size:11.5px;margin-bottom:3px;display:block}
.nv-num{max-width:110px}
.nv-f{display:flex;flex-direction:column;gap:2px;min-width:110px}
.nv-pill{font-size:11px;padding:1px 6px;border-radius:6px;background:var(--panel-2,#1e1e28);border:1px solid var(--line,#2a2a36);color:var(--muted,#8b8b9c)}
.nv-preview{white-space:pre-wrap;font-size:11.5px;line-height:1.6;color:var(--muted,#8b8b9c);max-height:120px;overflow:auto;background:var(--bg,#0f0f14);border:1px solid var(--line,#2a2a36);border-radius:8px;padding:6px 8px}
@media(max-width:1080px){.nv-wrap{flex-direction:column}.nv-side{width:auto;flex:0 0 auto;max-height:230px}}
@media(max-width:860px){.nv-asset-bar{grid-template-columns:1fr}}
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
const CHAPTER_OUTLINE_MIN_CHARS = 2500;
const CHAPTER_OUTLINE_MAX_CHARS = 3500;
const CHAPTER_WRITE_MIN_WORDS = 2500;
const CHAPTER_WRITE_MAX_WORDS = 3500;
const CHAPTER_WRITE_TARGET_WORDS = 3000;
const FRAMEWORK_MODULES = [
  ['模块 1｜世界观体系', [
    ['世界风格', 'worldStyle'], ['基础背景与开放区域', 'worldBackground'], ['底层规则体系', 'worldRules'],
    ['势力分层', 'factionLayers'], ['持续循环危机', 'coreLoopCrisis'], ['终极世界谜团', 'ultimateMystery'],
  ]],
  ['模块 2｜人物矩阵', [
    ['主角是谁', 'protagonist'], ['主角特别之处', 'protagonistSpecial'], ['主角成长与代价', 'protagonistGrowth'],
    ['主角固定小队', 'allyTeam'], ['反派三层金字塔', 'villainPyramid'], ['中立摇摆角色', 'neutralCharacters'],
  ]],
  ['模块 3｜主线分段规划', [
    ['推荐叙事视角', 'recommendedPov'], ['推荐角色规模', 'recommendedCastSize'],
    ['主线阶段目标', 'mainPlot'], ['分季锁坑规划', 'seasonPlan'], ['开局方向', 'openingDirection'], ['结局方向', 'endingDirection'],
  ]],
  ['模块 4｜支线储备库', [['四类支线弹药库', 'sidequests'], ['爆点清单', 'highlights']]],
  ['模块 5｜基调、主题与受众', [['核心主题', 'theme'], ['风格基调与受众', 'toneStyle'], ['内容约束规则', 'contentRules']]],
  ['模块 6｜叙事节奏与反转', [['漫剧节奏与爽点反转', 'rhythm']]],
  ['模块 7｜伏笔管控', [['伏笔分级与回收规则', 'foreshadowRules']]],
];

const S = {
  root: null, ctx: null, meta: null, llm: null,
  novels: [], q: '',
  view: 'empty',            // empty | create | workspace
  currentId: null, detail: null,
  assets: null,
  freeMode: null,
  creativeOptions: null,
  tab: 'params',
  genres: [], categories: [], povs: POV_FALLBACK, tones: TONE_FALLBACK, sections: OUTLINE_SECTIONS_FALLBACK, limits: null,
  genreCat: '全部', genreQ: '', genreMode: 'system', genreCollapsed: false, genreOptions: null,
  actors: [], actorQ: '', actorsLoaded: false,
  form: null, formMode: 'create',
  chapterIdx: null, chapter: null, editing: false,
  jobId: null, stopWatch: null, timers: [], busy: false, computeOn: false,
  handlers: null,
};

// ---------------- 工具 ----------------
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function highlightIds(s) {
  return esc(s).replace(/([CLP]-[A-Z0-9-]+)/gi, (id) => {
    const kind = id[0].toUpperCase() === 'C' ? 'c' : (id[0].toUpperCase() === 'L' ? 'e' : 'p');
    return `<span class="nv-id nv-id-${kind}">${id.toUpperCase()}</span>`;
  });
}
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const fmtWords = (n) => (num(n) >= 10000 ? `${(num(n) / 10000).toFixed(1)} 万字` : `${num(n)} 字`);
const badge = (text, kind = '') => `<span class="nv-badge${kind ? ` nv-badge-${kind}` : ''}">${esc(text)}</span>`;
const STATUS_LABEL = { outline: '待写', writing: '写作中', done: '已完成', error: '失败', draft: '草稿' };
const statusBadge = (s) => badge(STATUS_LABEL[s] || s || '—', s === 'done' ? 'ok' : s === 'error' ? 'err' : s === 'writing' ? 'warn' : '');
const chapterWriteStatus = (c) => {
  const words = num(c?.words, 0);
  if (c?.status !== 'done') return 'pending';
  if (words < CHAPTER_WRITE_MIN_WORDS) return 'under';
  if (words > CHAPTER_WRITE_MAX_WORDS) return 'over';
  return 'ok';
};
const chapterWordBadge = (c) => {
  const s = chapterWriteStatus(c);
  if (s === 'under') return badge(`${fmtWords(c.words || 0)} 不足`, 'warn');
  if (s === 'over') return badge(`${fmtWords(c.words || 0)} 超长`, 'warn');
  return badge(fmtWords(c.words || 0), s === 'ok' ? 'ok' : '');
};

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
  const baseSections = Array.isArray(m.outlineSections) && m.outlineSections.length ? m.outlineSections : OUTLINE_SECTIONS_FALLBACK;
  const sections = baseSections.some((x) => x.key === 'storyline')
    ? baseSections
    : [...baseSections.slice(0, 2), { key: 'storyline', label: '头尾逻辑与故事线' }, ...baseSections.slice(2)];
  S.sections = sections;
  if (m.limits) S.limits = { castSize: m.limits.castSize || limits().castSize, chapterWords: m.limits.chapterWords || limits().chapterWords, targetWords: m.limits.targetWords || limits().targetWords };
  if (m.scales) S.scales = m.scales;
  if (m.llm) S.llm = m.llm;
  try {
    const creative = await S.ctx.api.get('/api/novels/ai/creative-options');
    if (Array.isArray(creative?.tones) && creative.tones.length >= 100) S.tones = creative.tones.slice(0, 100);
  } catch { /* 保留字典兜底 */ }
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
  const [detail, assets, freeMode, creativeOptions] = await Promise.all([
    S.ctx.api.get(`/api/novels/${id}`),
    S.ctx.api.get(`/api/novels/${id}/assets`).catch(() => ({ characters: [], environments: [], props: [] })),
    S.ctx.api.get(`/api/novels/${id}/characters/free-mode`).catch(() => null),
    S.ctx.api.get(`/api/novels/${id}/creative-options`).catch(() => null),
  ]);
  S.detail = detail;
  S.assets = assets;
  S.freeMode = freeMode;
  S.creativeOptions = creativeOptions;
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
  const [detail, assets, freeMode, creativeOptions] = await Promise.all([
    S.ctx.api.get(`/api/novels/${S.currentId}`),
    S.ctx.api.get(`/api/novels/${S.currentId}/assets`).catch(() => ({ characters: [], environments: [], props: [] })),
    S.ctx.api.get(`/api/novels/${S.currentId}/characters/free-mode`).catch(() => null),
    S.ctx.api.get(`/api/novels/${S.currentId}/creative-options`).catch(() => null),
  ]);
  S.detail = detail;
  S.assets = assets;
  S.freeMode = freeMode;
  S.creativeOptions = creativeOptions;
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
    free_mode: S.freeMode?.enabled !== false,
    free_max: (S.freeMode?.enabled !== false) ? limits().castSize.max : num(S.freeMode?.maxCharacters, num(n.cast_size, 20)),
    free_style: S.freeMode?.stylePolicy || 'plot-driven',
    title_description: S.creativeOptions?.titleDescription || '',
    auto_pov: Boolean(S.creativeOptions?.autoPov),
    auto_cast: Boolean(S.creativeOptions?.autoCast),
    unlimited_characters: Boolean(S.creativeOptions?.unlimitedCharacters),
    custom_genre: S.creativeOptions?.customGenre || null,
  };
  S.genreMode = S.creativeOptions?.genreMode || 'system';
  S.genreCollapsed = false;
}

function newForm() {
  const g = S.genres[0] || {};
  return {
    title: '', genre: g.id || '', tone: g.tone || S.tones[0], scale: 'medium',
    cast_size: limits().castSize.default, target_words: limits().targetWords.default,
    chapter_words: limits().chapterWords.default, pov: S.povs[0]?.id || 'third-limited', seasons: 1,
    framework_intro: '', ref_doc_path: '', ref_doc_name: '', actor_ids: [], custom_actors: [],
    free_mode: true, free_max: limits().castSize.max, free_style: 'plot-driven',
    title_description: '', auto_pov: false, auto_cast: false, unlimited_characters: false,
    custom_genre: null,
  };
  S.genreMode = 'system';
  S.genreCollapsed = false;
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
    <div class="nv-item-m"><span>${esc(n.id)}</span><span>${esc(n.genre_name || (String(n.genre || '').startsWith('custom-') ? '自定义题材' : (n.genre === 'custom-free' ? '自由创作' : '未选题材')))}</span><span>${fmtWords(n.target_words)}/${num(n.chapter_words, 2000)}字</span></div>
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
  return `${pipelineHtml()}<div class="nv-hint" style="margin:-2px 0 4px">一键流程：① 加入参数与角色 → ② 生成大纲 → ③ 生成逐章大纲 → ④ 写作正文。每步都会先保存当前表单。</div>${formHtml('create')}`;
}

function pipelineHtml() {
  return `<div class="nv-pipe">
    <span class="nv-pipe-t">一键流程</span>
    <button class="nv-btn nv-btn-p nv-btn-sm" data-act="pipe-params" title="AI 补全参数（题材/基调/视角/规模）+ 生成故事框架 + 按剧情补齐角色">① 一键加入参数角色</button>
    <button class="nv-btn nv-btn-sm" data-act="pipe-outline" title="按整条故事线生成完整大纲（章节大纲 + 全部叙事分节）">② 一键生成大纲</button>
    <button class="nv-btn nv-btn-sm" data-act="pipe-chapters" title="从第 1 章到最后一章逐章生成 2500-3500 字章节大纲">③ 一键生成章节</button>
    <button class="nv-btn nv-btn-a nv-btn-sm" data-act="pipe-write" title="按章节大纲逐章写作正文（未写的章节）">④ 一键写作</button>
  </div>`;
}

function currentGenreLabel() {
  const f = S.form || {};
  const custom = f.custom_genre;
  if (custom && custom.name && f.genre === custom.genreId) return `自定义：${custom.name}`;
  if (f.genre === 'custom-free') return '自由创作（不限定题材）';
  const g = S.genres.find((x) => x.id === f.genre);
  return g ? `已选：${g.name}（${g.cat}）` : '';
}

function novelGenreLabel(n) {
  if (!n) return '未选题材';
  const cg = S.creativeOptions?.customGenre;
  if (cg && cg.genreId === n.genre && cg.name) return cg.name;
  if (n.genre === 'custom-free') return '自由创作';
  if (n.genre_name) return n.genre_name;
  if (String(n.genre || '').startsWith('custom-')) return '自定义题材';
  return '未选题材';
}

function systemGenrePanel(f, shown, genre, isFree) {
  const collapsed = !!S.genreCollapsed;
  return `
    <div class="nv-row" style="margin-bottom:6px">
      <button class="nv-btn nv-btn-sm" data-act="genre-collapse">${collapsed ? '展开 100 种题材' : '收起题材列表'}</button>
      <button class="nv-btn nv-btn-sm ${isFree ? 'nv-btn-a' : ''}" data-act="genre-off">${isFree ? '已关闭系统题材（自由创作）' : '关闭系统题材（不按 100 种写）'}</button>
      <input class="nv-input" id="nv-genre-q" data-role="genreQ" style="max-width:180px" placeholder="搜索题材关键词…" value="${esc(S.genreQ)}">
      <span class="nv-hint">共 ${S.genres.length} 种，命中 ${shown.length} 种</span>
    </div>
    ${isFree ? '<div class="nv-note" style="margin-bottom:6px">当前为自由创作：不套用系统题材，故事框架、大纲与正文由 AI 按你的设定与关键词自由规划。</div>' : ''}
    ${collapsed ? '' : `
    <div class="nv-chips" style="margin-bottom:6px">
      <button class="nv-chip ${S.genreCat === '全部' ? 'nv-on' : ''}" data-act="cat" data-cat="全部">全部</button>
      ${S.categories.map((c) => `<button class="nv-chip ${S.genreCat === c ? 'nv-on' : ''}" data-act="cat" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}
    </div>
    <div class="nv-grid">${shown.map((g) => `<div class="nv-gitem ${g.id === f.genre ? 'nv-on' : ''}" data-act="genre" data-id="${esc(g.id)}">
      <b>${esc(g.name)}</b><span>${esc(g.cat)} · ${esc(g.desc || '')}</span><span>钩子：${esc(g.hook || '—')}</span></div>`).join('')}</div>
    <div class="nv-row" style="margin-top:8px">
      ${genre ? `<button class="nv-btn nv-btn-sm" data-act="genre-skill" data-id="${esc(genre.id)}" title="显示该题材专属的故事框架写法参考技能提示词">📐 写作技能提示词</button>
      <button class="nv-btn nv-btn-sm" data-act="genre-blueprint" data-id="${esc(genre.id)}">查看 AI 题材创意引擎</button>`
        : '<span class="nv-hint">点上方题材卡片选择一个系统题材。</span>'}
    </div>
    ${genre ? `<div class="nv-hint" style="margin-top:4px">推荐基调：${esc(genre.tone || '—')}｜关键词：${esc((genre.tags || []).join('、'))}｜开篇钩子：${esc(genre.hook || '—')}</div>` : ''}
    `}`;
}

function customGenrePanel(kind, custom) {
  const isGen = kind === 'generator';
  const active = custom && S.genreMode === kind;
  return `
    <div class="nv-note">
      ${isGen
        ? '题材生成器：按「世界背景 × 主角设定 × 核心冲突 × 基调 × 节奏 × 受众 × 关键词」组合出一个自定义题材，不联网、不消耗额度。'
        : 'AI 头脑风暴创意题材规划：让 AI 从 100 种题材里挑一个最易出爆款、可无限续集的题材，并给出参数与完整故事框架。'}
    </div>
    <div class="nv-row" style="margin-top:8px">
      <button class="nv-btn nv-btn-a" data-act="${isGen ? 'open-genre-generator' : 'brainstorm-genre'}">${isGen ? '🧪 打开题材生成器' : '💡 开始 AI 头脑风暴'}</button>
    </div>
    ${active && custom ? `<div class="nv-card" style="padding:10px;margin-top:8px">
      <div class="nv-card-t">当前自定义题材：${esc(custom.name || '')}</div>
      <div class="nv-hint" style="line-height:1.7">${esc(custom.positioning || custom.description || '')}<br>
      关键词：${esc((custom.keywords || []).join('、') || '—')}<br>基调：${esc(custom.tone || '—')}</div>
    </div>` : ''}`;
}

function genreSectionHtml(f) {
  const mode = S.genreMode || 'system';
  const label = currentGenreLabel();
  const shown = S.genres.filter((g) => (S.genreCat === '全部' || g.cat === S.genreCat)
    && (!S.genreQ || `${g.name} ${(g.tags || []).join(' ')} ${g.desc || ''}`.toLowerCase().includes(S.genreQ.toLowerCase())));
  const genre = S.genres.find((g) => g.id === f.genre) || null;
  const isFree = f.genre === 'custom-free';
  const custom = f.custom_genre && f.genre === f.custom_genre.genreId ? f.custom_genre : null;
  return `<div style="margin-top:10px">
    <div class="nv-row" style="margin-bottom:6px">
      <b style="font-size:12.5px">题材（3 选 1）</b>
      <div class="nv-chips">
        <button class="nv-chip ${mode === 'system' ? 'nv-on' : ''}" data-act="genre-mode" data-mode="system">① 选择系统题材</button>
        <button class="nv-chip ${mode === 'generator' ? 'nv-on' : ''}" data-act="genre-mode" data-mode="generator">② 题材生成器</button>
        <button class="nv-chip ${mode === 'brainstorm' ? 'nv-on' : ''}" data-act="genre-mode" data-mode="brainstorm">③ AI 头脑风暴</button>
      </div>
      <span class="nv-grow"></span>
      <span class="nv-pill ${label ? '' : 'nv-badge-warn'}">${esc(label || '尚未确定题材')}</span>
    </div>
    ${mode === 'system' ? systemGenrePanel(f, shown, genre, isFree) : ''}
    ${mode === 'generator' ? customGenrePanel('generator', custom) : ''}
    ${mode === 'brainstorm' ? customGenrePanel('brainstorm', custom) : ''}
  </div>`;
}

function formHtml(mode) {
  const f = S.form;
  const lim = limits();
  const total = castTotal();
  const overCast = total > num(f.cast_size, 20);
  const toneOptions = [...new Set([f.tone, ...(S.tones || [])].filter(Boolean))].slice(0, 100);
  const genre = S.genres.find((g) => g.id === f.genre) || null;
  const shown = S.genres.filter((g) => (S.genreCat === '全部' || g.cat === S.genreCat)
    && (!S.genreQ || `${g.name} ${g.tags?.join(' ') || ''} ${g.desc || ''}`.toLowerCase().includes(S.genreQ.toLowerCase())));
  return `<div class="nv-card">
    <div class="nv-card-t">${mode === 'create' ? '新建小说项目' : `参数与角色 · ${esc(S.detail?.novel?.id || '')}`}
      <span class="nv-grow"></span>
      ${mode === 'create' ? '<button class="nv-btn" data-act="cancel-create">返回</button>' : '<button class="nv-btn" data-act="cancel-edit">返回工作区</button>'}
      <button class="nv-btn nv-btn-p" data-act="${overCast ? 'cast-warn' : 'save-form'}">${mode === 'create' ? '创建项目' : '保存修改'}</button>
    </div>

    <div class="nv-step"><em>1</em>题材与参数${(() => { const l = currentGenreLabel(); return l ? `　<span class="nv-pill">${esc(l)}</span>` : '　<span class="nv-pill">未选</span>'; })()}</div>
    <div class="nv-row">
      <div class="nv-f nv-grow"><span class="nv-lbl">标题</span>
        <div class="nv-row"><input class="nv-input nv-grow" id="nv-title" data-role="title" style="min-width:220px" placeholder="例如：剑落青芜" value="${esc(f.title)}">
        <button class="nv-btn nv-btn-sm" data-act="plan-genre" title="根据标题和标题描述自动从 100 种题材中选择">AI 自动规划题材</button></div>
        <input class="nv-input" data-role="title_description" placeholder="标题描述：用一句话补充标题意象、主角或核心冲突" value="${esc(f.title_description || '')}" style="margin-top:4px">
      </div>
      <div class="nv-f"><span class="nv-lbl">基调（100 种）</span><select class="nv-select" data-role="tone" style="min-width:150px">${toneOptions.map((t) => `<option ${t === f.tone ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></div>
      <div class="nv-f"><span class="nv-lbl">叙事视角</span>
        <select class="nv-select" data-role="pov" style="min-width:190px">${S.povs.map((p) => `<option value="${esc(p.id)}" ${p.id === f.pov ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
        <label class="nv-hint" style="cursor:pointer"><input type="checkbox" data-role="auto_pov" ${f.auto_pov ? 'checked' : ''}> AI 自动规划视角</label>
      </div>
      <div class="nv-f"><span class="nv-lbl">角色规模上限（≤200）</span>
        <input class="nv-input nv-num" id="nv-cast" type="number" min="${lim.castSize.min}" max="${lim.castSize.max}" data-role="cast_size" value="${num(f.cast_size, 20)}">
        <label class="nv-hint" style="cursor:pointer"><input type="checkbox" data-role="auto_cast" ${f.auto_cast ? 'checked' : ''}> AI 自动规划规模</label>
        <button class="nv-btn nv-btn-sm ${f.unlimited_characters ? 'nv-btn-a' : ''}" data-act="unlimited-cast">${f.unlimited_characters ? '无创意限制：开启' : '无创意限制'}</button>
        <input type="checkbox" data-role="unlimited_characters" ${f.unlimited_characters ? 'checked' : ''} style="display:none">
      </div>
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

    ${genreSectionHtml(f)}

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

    <div class="nv-note" style="margin-top:10px">
      <div class="nv-row">
        <label class="nv-row" style="cursor:pointer"><input type="checkbox" data-role="free_mode" ${f.free_mode !== false ? 'checked' : ''}> <b>角色自由模式（默认开启，数量与风格全由 AI 按剧情规划）</b></label>
        <label class="nv-f" data-role="free-max-wrap" style="${f.free_mode !== false ? 'display:none' : ''}"><span class="nv-lbl">最多按剧情新增</span><input class="nv-input nv-num" data-role="free-max" type="number" min="1" max="${num(f.cast_size, 20)}" value="${num(f.free_max, num(f.cast_size, 20))}"></label>
        <label class="nv-f" style="min-width:190px"><span class="nv-lbl">角色风格策略</span>
          <select class="nv-select" data-role="free-style">
            ${[
              ['plot-driven', '根据剧情需要（推荐）'],
              ['cinematic-real', '电影写实'],
              ['guoman-real', '国漫写实'],
              ['anime', '二次元动画'],
              ['ink', '水墨国风'],
            ].map(([id, label]) => `<option value="${id}" ${(f.free_style || 'plot-driven') === id ? 'selected' : ''}>${label}</option>`).join('')}
          </select>
        </label>
        <button class="nv-btn nv-btn-a" data-act="auto-characters">AI 按剧情补齐角色</button>
        <span class="nv-pill">已有 ${S.freeMode?.currentCharacters ?? total}/${num(f.cast_size, 20)} · 可新增 ${S.freeMode?.availableCharacters ?? Math.max(0, num(f.cast_size, 20) - total)}</span>
      </div>
      <div class="nv-hint" style="margin-top:5px">开启并保存后，AI 会结合故事大纲、章首章末和故事线自动发现剧情缺口，创建详细角色档案，并归档为本小说专属引用；不会自动生成定妆图。</div>
    </div>

    <div class="nv-step" style="margin-top:14px"><em>3</em>故事框架介绍 与 参考范本
      <span class="nv-grow"></span>
      <button class="nv-btn nv-btn-p nv-btn-sm" data-act="ai-framework" title="调用 1 次 LLM，按 7 模块生成故事框架，并直接写入下方填写区（含标题与角色建议）">✨ AI 自动填写并写入故事框架</button>
    </div>
    <textarea class="nv-area" id="nv-framework" data-role="framework_intro" rows="7" placeholder="把故事框架尽量写清楚：主角是谁、想要什么、阻碍是什么、世界规则、开局与结局方向、必须出现的桥段…（越具体，大纲越贴合）">${esc(f.framework_intro)}</textarea>
    <div class="nv-hint" id="nv-fw-count">已输入 ${String(f.framework_intro || '').length} 字 · 点上方按钮后 AI 会按 7 模块把完整框架直接写入这里（调用 1 次 LLM）</div>
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
        <span class="nv-pill">${esc(novelGenreLabel(n))}</span>
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
        <span class="nv-muted">已写 ${st.written || 0}/${st.total || 0} 章 · 共 ${fmtWords(st.words || 0)} · 目标 ${fmtWords(n.target_words)} · 单章正文 ${CHAPTER_WRITE_MIN_WORDS}-${CHAPTER_WRITE_MAX_WORDS} 字 · 角色 ${n.cast_total}/${n.cast_size}</span>
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
      ${pipelineHtml()}
      ${jobBarHtml()}
      ${assetIndexHtml()}
      <div class="nv-tabs" style="margin-top:10px">${tabs.map(([k, label]) => `<button class="nv-tab ${S.tab === k ? 'nv-on' : ''}" data-act="tab" data-tab="${k}">${esc(label)}</button>`).join('')}</div>
    </div>
    ${S.tab === 'params' ? formHtml('edit') : S.tab === 'outline' ? outlineHtml() : S.tab === 'chapters' ? chaptersHtml() : exportHtml()}`;
}

function assetIndexHtml() {
  const a = S.assets || {};
  const groups = [
    ['character', '人物', a.characters || []],
    ['environment', '环境', a.environments || []],
    ['prop', '物品', a.props || []],
  ];
  if (!groups.some(([, , rows]) => rows.length)) return '';
  return `<div class="nv-asset-bar">
    ${groups.map(([kind, label, rows]) => `<div class="nv-asset-col">
      <b>${label}资产 ${rows.length}</b>
      <div class="nv-asset-list">${rows.length ? rows.map((x) => {
        const cls = kind === 'character' ? 'c' : (kind === 'environment' ? 'e' : 'p');
        return `<button class="nv-asset-chip nv-asset-${cls}" data-act="asset-view" data-kind="${kind}" data-id="${esc(x.id)}"><b>${esc(x.id)}</b><span>${esc(x.name)}</span></button>`;
      }).join('') : '<span class="nv-hint">暂无</span>'}</div>
    </div>`).join('')}
  </div>`;
}

function showAsset(asset) {
  if (!asset) return;
  const body = document.createElement('div');
  body.innerHTML = `<div class="nv-note" style="line-height:1.8"><b>${esc(asset.id)}</b>　${esc(asset.name)}<br>
    <span class="nv-muted">类型：${asset.kind === 'character' ? '人物' : asset.kind === 'environment' ? '环境' : '物品'}｜定位：${esc(asset.role || '—')}｜来源：${esc(asset.source || '—')}</span></div>
    ${asset.desc ? `<div style="margin-top:10px;line-height:1.9;white-space:pre-wrap">${highlightIds(asset.desc)}</div>` : '<div class="nv-hint" style="margin-top:10px">暂无详细描述</div>'}`;
  const m = S.ctx.modal({ title: '资产 ID 详情', body, width: 620 });
  const bar = document.createElement('div');
  bar.className = 'nv-row';
  bar.style.marginTop = '10px';
  bar.innerHTML = '<button class="nv-btn nv-btn-p" data-a="close">关闭</button>';
  body.appendChild(bar);
  bar.querySelector('[data-a="close"]').onclick = () => m.close();
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
  const chapterStats = chapterPlanStatsLocal(s.chapters, S.detail?.novel);
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
    <div class="nv-note" style="margin-bottom:8px">AI 规划状态：${S.sections.length} 个分节中 <b>${empty.length}</b> 个为空；章节规划 <b>${chapterStats.complete}/${chapterStats.expected}</b> 章完整${emptyFillable.length ? `（可自动补齐 ${emptyFillable.length} 个非章节分节）` : ''}</div>
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

function chapterPlanComplete(c) {
  const len = String(c?.summary || '').trim().length;
  return Boolean(
    c
    && !c._placeholder
    && String(c.title || '').trim()
    && String(c.start_state || '').trim()
    && String(c.end_state || '').trim()
    && len >= CHAPTER_OUTLINE_MIN_CHARS
    && len <= CHAPTER_OUTLINE_MAX_CHARS,
  );
}

function chapterPlanStatsLocal(rows, novel) {
  const expected = Math.max(
    num(novel?.planned_chapters, 0),
    Array.isArray(rows) ? rows.length : 0,
    num(novel?.target_words, 0) > 0 && num(novel?.chapter_words, 0) > 0
      ? Math.ceil(num(novel.target_words, 0) / num(novel.chapter_words, 1))
      : 0,
  );
  const byIdx = new Map((Array.isArray(rows) ? rows : []).map((c) => [num(c?.idx, 0), c]));
  const missing = [];
  for (let idx = 1; idx <= expected; idx += 1) {
    if (!chapterPlanComplete(byIdx.get(idx))) missing.push(idx);
  }
  return { expected, complete: expected - missing.length, missing };
}

function sectionHtml(sec, val) {
  const count = Array.isArray(val) ? val.length : (val && typeof val === 'object' ? Object.keys(val).length : (val ? 1 : 0));
  return `<details class="nv-sec" ${['chapters', 'framework'].includes(sec.key) ? 'open' : ''}>
    <summary>${esc(sec.label)} <span class="nv-pill">${count}</span>${outlineSectionEmpty(sec.key, val) ? badge('空', 'warn') : ''}
      <span class="nv-grow"></span>
      <button class="nv-btn nv-btn-sm" data-act="${sec.key === 'chapters' ? 'outline-ai-chapters' : 'outline-ai-section'}" data-key="${esc(sec.key)}" data-label="${esc(sec.label)}">${sec.key === 'chapters' ? '指定章节规划' : 'AI 生成本节'}</button>
      ${sec.key === 'chapters' ? '<button class="nv-btn nv-btn-sm nv-btn-a" data-act="outline-ai-chapters-all" title="从第 1 章到最后一章逐章重写，并写入章首/章末/上下文衔接">一键全部重写</button>' : ''}
    </summary>
    <div>${sectionBody(sec.key, val)}</div>
  </details>`;
}

const KV_LABEL = {
  core_conflict: '核心冲突', protagonist_goal: '主角目标', antagonist_force: '对立力量', three_acts: '三幕结构',
  theme: '主题内核', opening_image: '开篇画面', ending: '结局走向', opening_logic: '开篇逻辑',
  story_chain: '故事因果链', turning_points: '重大转折', ending_logic: '结局逻辑',
  head_tail_closure: '头尾闭环', final_image: '最终画面', era: '时代背景', rules: '世界规则',
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
  if (typeof val === 'string') return `<div style="line-height:1.8;white-space:pre-wrap">${highlightIds(val)}</div>`;
  if (!Array.isArray(val)) {
    const rows = Object.entries(val).map(([k, v]) => `<dt>${esc(KV_LABEL[k] || k)}</dt><dd>${Array.isArray(v) ? v.map((x) => highlightIds(typeof x === 'object' ? JSON.stringify(x) : x)).join('<br>') : highlightIds(typeof v === 'object' ? JSON.stringify(v) : v)}</dd>`).join('');
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
  if (Array.isArray(v)) return v.map((x) => highlightIds(typeof x === 'object' ? JSON.stringify(x) : x)).join('、') || '<span class="nv-muted">—</span>';
  return highlightIds(v);
}

function chaptersOutlineTable(chs) {
  return `<div class="nv-scroll"><table class="nv-tbl"><thead><tr><th>章</th><th>标题</th><th>剧情走向</th><th>人物/地点</th><th>章末钩子</th><th>操作</th></tr></thead><tbody>
    ${chs.map((c) => {
      const summary = String(c.summary || '').trim();
      const preview = summary.length > 260 ? `${summary.slice(0, 260)}…` : summary;
      const short = !c._placeholder && summary.length < CHAPTER_OUTLINE_MIN_CHARS;
      return `<tr>
      <td>${num(c.idx, 0)}</td>
      <td>${esc(c.title || '')}</td>
      <td style="max-width:480px">
        <div style="line-height:1.6">${esc(preview || '—')}</div>
        <div class="nv-note" style="margin-top:6px;line-height:1.6"><b>章首：</b>${highlightIds(String(c.start_state || '').slice(0, 120) || '—')}<br><b>章末：</b>${highlightIds(String(c.end_state || '').slice(0, 120) || '—')}</div>
        <div class="nv-hint">大纲 ${summary.length} 字${c._placeholder ? ' ' + badge('待补全', 'warn') : (short ? ' ' + badge('不足 2500 字', 'warn') : '')}</div>
      </td>
      <td class="nv-muted">${esc((c.characters || []).join('、') || '—')}<br>${esc((c.locations || []).join('、') || '')}</td>
      <td style="max-width:200px">${esc(c.cliffhanger || c.hook || '—')}</td>
      <td><button class="nv-btn nv-btn-sm" data-act="read" data-idx="${num(c.idx, 0)}">读</button>
          <button class="nv-btn nv-btn-sm" data-act="outline-chapter-view" data-idx="${num(c.idx, 0)}">大纲</button>
          <button class="nv-btn nv-btn-sm" data-act="gen-chapter" data-idx="${num(c.idx, 0)}" title="按大纲重写本章正文">写作</button>
          <button class="nv-btn nv-btn-sm" data-act="outline-ai-chapter" data-idx="${num(c.idx, 0)}" title="只重新规划这一章的大纲细节">AI 规划</button></td>
    </tr>`;
    }).join('')}</tbody></table></div>`;
}

function showChapterOutline(idx) {
  const c = (S.detail?.outline?.sections?.chapters || []).find((x) => num(x.idx, 0) === num(idx, 0));
  if (!c) { toast('本章大纲不存在', 'err'); return; }
  const summary = String(c.summary || '').trim();
  const body = document.createElement('div');
  body.innerHTML = `<div class="nv-note" style="line-height:1.8">
    <b>第 ${num(c.idx, 0)} 章　${esc(c.title || '')}</b>
    <span class="nv-pill">大纲 ${summary.length} 字</span>
    ${summary.length < CHAPTER_OUTLINE_MIN_CHARS ? badge('低于 2500 字', 'warn') : badge('长度达标', 'ok')}
  </div>
  <div style="margin-top:10px;line-height:1.9;white-space:pre-wrap;max-height:62vh;overflow:auto;font-size:13px">${highlightIds(summary || '（本章大纲为空）')}</div>
  <div class="nv-note" style="margin-top:10px;line-height:1.8"><b>章首承接：</b>${highlightIds(c.start_state || '（未规划）')}</div>
  <div class="nv-note" style="margin-top:8px;line-height:1.8"><b>章末落点：</b>${highlightIds(c.end_state || '（未规划）')}</div>
  <div class="nv-note" style="margin-top:8px;line-height:1.8"><b>进入本章：</b>${highlightIds(c.handoff_in || '（未规划）')}<br><b>交给下一章：</b>${highlightIds(c.handoff_out || '（未规划）')}</div>
  <div class="nv-note" style="margin-top:8px;line-height:1.8"><b>故事线锚点：</b>${highlightIds(c.storyline_anchor || '（未规划）')}</div>
  ${(c.events || []).length ? `<div class="nv-note" style="margin-top:10px"><b>关键事件：</b>${c.events.map((x) => esc(x)).join('；')}</div>` : ''}
  ${(c.cliffhanger || c.hook) ? `<div class="nv-note" style="margin-top:8px"><b>章末钩子：</b>${esc(c.cliffhanger || c.hook)}</div>` : ''}`;
  const m = S.ctx.modal({ title: `第 ${num(c.idx, 0)} 章大纲`, body, width: 760 });
  const bar = document.createElement('div');
  bar.className = 'nv-row';
  bar.style.marginTop = '10px';
  bar.innerHTML = `<button class="nv-btn nv-btn-a" data-a="replan">AI 重规划本章</button><button class="nv-btn" data-a="close">关闭</button>`;
  body.appendChild(bar);
  bar.querySelector('[data-a="close"]').onclick = () => m.close();
  bar.querySelector('[data-a="replan"]').onclick = () => { m.close(); openChapterAiPlan({ from: num(c.idx, 0), to: num(c.idx, 0), onlyEmptyDefault: false }); };
}

// ---------- 章节面板 ----------
function chaptersHtml() {
  const chs = S.detail.chapters || [];
  const st = S.detail.stats || {};
  if (!chs.length) return `<div class="nv-card"><div class="nv-empty">还没有章节骨架，请先「① 生成章节大纲」。</div></div>`;
  return `<div class="nv-card">
    <div class="nv-card-t">章节（写 ${st.written || 0} / 共 ${st.total || 0} · ${fmtWords(st.words || 0)}）
      <span class="nv-grow"></span>
      <span class="nv-hint">每章正文按 ${CHAPTER_WRITE_MIN_WORDS}-${CHAPTER_WRITE_MAX_WORDS} 字规划，并带全书框架、本章大纲、前章结尾、人物/地点和伏笔上下文</span>
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
          ${c.status === 'done' ? chapterWordBadge(c) : badge(STATUS_LABEL[c.status] || c.status, c.status === 'error' ? 'err' : '')}
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
      ${statusBadge(c.status)}${c.status === 'done' ? chapterWordBadge(c) : ''}
      ${c.model ? `<span class="nv-pill">${esc(c.model)}</span>` : ''}
      <span class="nv-grow"></span>
      ${S.editing ? `<button class="nv-btn nv-btn-p nv-btn-sm" data-act="save-chapter">保存</button><button class="nv-btn nv-btn-sm" data-act="cancel-edit">取消</button>`
        : `<button class="nv-btn nv-btn-sm" data-act="edit-chapter">✎ 编辑</button>`}
      <button class="nv-btn nv-btn-sm" data-act="gen-chapter" data-idx="${c.idx}" title="按大纲重写本章">↻ 重写</button>
      <button class="nv-btn nv-btn-sm nv-btn-d" data-act="del-chapter" data-idx="${c.idx}">删除</button>
    </div>
    ${c.error ? `<div class="nv-warn" style="margin-bottom:8px">上次失败：${esc(c.error)}</div>` : ''}
    ${hasContent && chapterWriteStatus(c) === 'under' ? `<div class="nv-warn" style="margin-bottom:8px">本章正文 ${num(c.words, 0)} 字，低于 ${CHAPTER_WRITE_MIN_WORDS} 字目标；点「↻ 重写」可按 ${CHAPTER_WRITE_MIN_WORDS}-${CHAPTER_WRITE_MAX_WORDS} 字重新生成。</div>` : ''}
    ${hasContent && chapterWriteStatus(c) === 'over' ? `<div class="nv-warn" style="margin-bottom:8px">本章正文 ${num(c.words, 0)} 字，超过 ${CHAPTER_WRITE_MAX_WORDS} 字目标；点「↻ 重写」可压缩到目标范围。</div>` : ''}
    ${c.summary ? `<div class="nv-note" style="margin-bottom:8px"><b>大纲：</b>${esc(c.summary)}<br><b>章末钩子：</b>${esc(c.cliffhanger || c.hook || '—')}　<b>人物：</b>${esc((c.characters || []).join('、') || '—')}　<b>地点：</b>${esc((c.locations || []).join('、') || '—')}</div>` : ''}
    ${S.editing
      ? `<textarea class="nv-area" id="nv-content" data-role="content" rows="22" style="min-height:46vh">${esc(c.content || '')}</textarea>
         <div class="nv-hint" id="nv-content-count">当前 ${fmtWords(c.words || 0)}（目标 ${CHAPTER_WRITE_MIN_WORDS}-${CHAPTER_WRITE_MAX_WORDS} 字）</div>`
      : (hasContent ? `<div class="nv-read" id="nv-read">${paras.map((p) => `<p>${highlightIds(p)}</p>`).join('')}</div>`
        : `<div class="nv-empty">本章尚未写作<br><span class="nv-hint">点上方「↻ 重写」或章节列表的「写作」按钮，按 ${CHAPTER_WRITE_MIN_WORDS}-${CHAPTER_WRITE_MAX_WORDS} 字生成本章</span></div>`)}
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
  setIf('title_description', 'title_description');
  setIf('auto_pov', 'auto_pov'); setIf('auto_cast', 'auto_cast'); setIf('unlimited_characters', 'unlimited_characters');
  setIf('cast_size', 'cast_size'); setIf('seasons', 'seasons');
  setIf('target_words', 'target_words'); setIf('chapter_words', 'chapter_words');
  setIf('framework_intro', 'framework_intro');
  setIf('free_mode', 'free_mode');
  setIf('free-max', 'free_max');
  setIf('free-style', 'free_style');
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
  if (f.unlimited_characters) {
    f.cast_size = limits().castSize.max;
    f.free_max = limits().castSize.max;
    f.auto_cast = true;
  }
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
      await S.ctx.api.put(`/api/novels/${r.novel.id}/characters/free-mode`, {
        enabled: f.free_mode !== false,
        maxCharacters: num(f.free_max, num(f.cast_size, 20)),
        stylePolicy: f.free_style || 'plot-driven',
        autoCreate: true,
      });
      await S.ctx.api.put(`/api/novels/${r.novel.id}/creative-options`, {
        titleDescription: f.title_description || '',
        autoPov: Boolean(f.auto_pov),
        autoCast: Boolean(f.auto_cast),
        unlimitedCharacters: Boolean(f.unlimited_characters),
        genreMode: S.genreMode || 'system',
        customGenre: f.custom_genre || null,
      });
      await loadList();
      S.formMode = 'edit';
      await openNovel(r.novel.id);
      return r;
    }
    await S.ctx.api.put(`/api/novels/${S.currentId}`, payload);
    await S.ctx.api.post(`/api/novels/${S.currentId}/actors`, { actorIds: payload.actor_ids, customActors: payload.custom_actors });
    await S.ctx.api.put(`/api/novels/${S.currentId}/characters/free-mode`, {
      enabled: f.free_mode !== false,
      maxCharacters: num(f.free_max, num(f.cast_size, 20)),
      stylePolicy: f.free_style || 'plot-driven',
      autoCreate: true,
    });
    await S.ctx.api.put(`/api/novels/${S.currentId}/creative-options`, {
      titleDescription: f.title_description || '',
      autoPov: Boolean(f.auto_pov),
      autoCast: Boolean(f.auto_cast),
      unlimitedCharacters: Boolean(f.unlimited_characters),
      genreMode: S.genreMode || 'system',
      customGenre: f.custom_genre || null,
    });
    await reloadDetail();
    await loadList();
    return true;
  }, S.formMode === 'create' ? '项目已创建，下一步：① 生成章节大纲' : '已保存');
  if (saved && S.formMode === 'edit') S.tab = 'outline';
  if (saved) render();
}

async function saveFreeMode(enabledOverride = undefined, { silent = false } = {}) {
  const current = S.freeMode || {};
  const enabled = enabledOverride === undefined ? Boolean(current.enabled) : Boolean(enabledOverride);
  const maxCharacters = num(readVal('free-max'), num(S.detail?.novel?.cast_size, 20));
  const stylePolicy = readVal('free-style') || current.stylePolicy || 'plot-driven';
  const r = await guard(async () => S.ctx.api.put(`/api/novels/${S.currentId}/characters/free-mode`, {
    enabled,
    maxCharacters,
    stylePolicy,
    autoCreate: true,
  }));
  if (!r) return null;
  S.freeMode = r.mode;
  if (!silent) toast(`角色自由模式已${r.mode.enabled ? '开启' : '关闭'}`, 'ok');
  if (!silent) render();
  return r.mode;
}

async function planGenreFromForm() {
  S.form = collectForm();
  if (!String(S.form.title || '').trim() && !String(S.form.title_description || '').trim()) {
    toast('请先填写标题或标题描述', 'err');
    return;
  }
  const r = await guard(async () => S.ctx.api.post('/api/novels/ai/plan-genre', {
    title: S.form.title || '',
    titleDescription: S.form.title_description || '',
    tone: S.form.tone || '',
  }));
  if (!r?.genreId) return;
  S.form.genre = r.genreId;
  S.form.custom_genre = null;
  S.genreMode = 'system';
  const g = S.genres.find((x) => x.id === r.genreId);
  if (g?.tone) S.form.tone = g.tone;
  S.genreCat = g?.cat || S.genreCat;
  S.genreQ = '';
  render();
  toast(`AI 规划题材：${r.genreName}（${Math.round((r.confidence || 0) * 100)}%）${r.reason ? `｜${r.reason}` : ''}`, 'ok');
}

// 把「AI 头脑风暴创意题材规划」的结果应用到当前表单（不写库）
function applyBrainstormToForm(r) {
  if (!r) return;
  S.form = collectForm();
  if (r.genreId) {
    S.form.genre = r.genreId;
    const g = S.genres.find((x) => x.id === r.genreId);
    S.genreCat = g?.cat || S.genreCat;
    S.genreQ = '';
  }
  if (r.tone) S.form.tone = r.tone;
  if (r.title) S.form.title = r.title;
  if (r.titleDescription) S.form.title_description = r.titleDescription;
  if (r.pov) {
    const pov = S.povs.find((p) => p.id === r.pov || p.name === r.pov || String(r.pov).includes(p.name) || p.name.includes(String(r.pov)));
    if (pov) S.form.pov = pov.id;
  }
  const cast = Math.min(limits().castSize.max, Math.max(1, num(r.castSize, S.form.cast_size)));
  S.form.cast_size = cast;
  S.form.free_max = cast;
  if (r.seasons) S.form.seasons = Math.min(99, Math.max(1, num(r.seasons, S.form.seasons)));
  if (r.frameworkIntro) S.form.framework_intro = r.frameworkIntro;
  if (r.skillPrompt) S.genreSkillPrompt = r.skillPrompt;
  if (r.genreId) {
    S.form.custom_genre = {
      genreId: r.genreId, name: r.genreName || r.name, category: r.category,
      positioning: r.reason || '', keywords: [], tone: r.tone,
      frameworkIntro: r.frameworkIntro || '', skillPrompt: r.skillPrompt || '',
      source: 'brainstorm',
    };
  }
  S.genreMode = 'brainstorm';
  render();
}

function showBrainstormPreview(r) {
  const wrap = document.createElement('div');
  const alts = Array.isArray(r.alternatives) ? r.alternatives : [];
  wrap.innerHTML = `
    ${r.mocked ? '<div class="nv-warn" style="margin-bottom:8px">当前为离线模板（mock）方案，配置真实 LLM 后可获得更强的选题创意。</div>' : ''}
    <div class="nv-note" style="line-height:1.8"><b>推荐题材：${esc(r.genreName || '')}</b>（${esc(r.category || '')}）｜基调：${esc(r.tone || '—')}｜推荐视角：${esc(r.pov || '—')}｜推荐角色规模：${esc(String(r.castSize || ''))}｜季数：${esc(String(r.seasons || ''))}</div>
    ${r.reason ? `<div class="nv-hint" style="margin-top:6px">推荐理由：${esc(r.reason)}</div>` : ''}
    ${alts.length ? `<div class="nv-hint" style="margin-top:4px">其他候选：${alts.map((x) => esc(x.genreName)).join('、')}</div>` : ''}
    <div class="nv-card" style="padding:10px;margin-top:8px">
      <div class="nv-card-t">故事框架（会写入「故事框架介绍」）</div>
      <div class="nv-preview" style="max-height:320px">${esc(r.frameworkIntro || '')}</div>
    </div>
    ${r.skillPrompt ? `<details style="margin-top:8px"><summary style="cursor:pointer;font-weight:700">该题材写作技能提示词</summary><div class="nv-preview" style="max-height:240px;margin-top:6px">${esc(r.skillPrompt)}</div></details>` : ''}`;
  const m = S.ctx.modal({ title: '💡 AI 头脑风暴创意题材规划', body: wrap, width: 800 });
  const bar = document.createElement('div');
  bar.className = 'nv-row';
  bar.style.marginTop = '10px';
  bar.innerHTML = '<button class="nv-btn nv-btn-p" data-a="ok">应用并填入表单</button><button class="nv-btn" data-a="again">重新规划</button><button class="nv-btn" data-a="no">取消</button>';
  wrap.appendChild(bar);
  bar.querySelector('[data-a="no"]').onclick = () => m.close();
  bar.querySelector('[data-a="again"]').onclick = () => { m.close(); setTimeout(() => brainstormGenreFromForm(), 0); };
  bar.querySelector('[data-a="ok"]').onclick = () => {
    applyBrainstormToForm(r);
    m.close();
    toast('AI 创意题材、参数与故事框架已填入表单，请检查后保存', 'ok');
  };
}

async function brainstormGenreFromForm() {
  if (S.busy) return;
  S.form = collectForm();
  const r = await guard(async () => S.ctx.api.post('/api/novels/ai/brainstorm-genre', {
    title: S.form.title || '',
    titleDescription: S.form.title_description || '',
    tone: S.form.tone || '',
    targetWords: num(S.form.target_words, 1000000),
    chapterWords: num(S.form.chapter_words, 2000),
  }));
  if (r?.genreId) showBrainstormPreview(r);
}

// 应用「题材生成器 / AI 头脑风暴」产出的自定义题材到表单（不写库）
function applyCustomGenre(genre, mode) {
  if (!genre?.genreId) return;
  S.form = collectForm();
  S.form.genre = genre.genreId;
  S.form.custom_genre = {
    genreId: genre.genreId,
    name: genre.name || genre.genreName || '',
    category: genre.category || '',
    positioning: genre.positioning || genre.description || '',
    keywords: Array.isArray(genre.keywords) ? genre.keywords : [],
    tone: genre.tone || '',
    description: genre.description || '',
    hook: genre.hook || '',
    frameworkIntro: genre.frameworkIntro || '',
    skillPrompt: genre.skillPrompt || '',
    options: genre.options || null,
    source: mode,
  };
  if (genre.tone) S.form.tone = genre.tone;
  if (genre.frameworkIntro) S.form.framework_intro = genre.frameworkIntro;
  if (genre.description && !String(S.form.title_description || '').trim()) S.form.title_description = genre.description;
  S.genreMode = mode;
  render();
}

function showGeneratedGenrePreview(r) {
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="nv-note" style="line-height:1.8"><b>生成题材：${esc(r.name || '')}</b>（${esc(r.category || '')}）｜基调：${esc(r.tone || '—')}</div>
    <div class="nv-hint" style="margin-top:6px">关键词：${esc((r.keywords || []).join('、') || '—')}</div>
    ${r.positioning ? `<div class="nv-hint" style="margin-top:4px">${esc(r.positioning)}</div>` : ''}
    <div class="nv-card" style="padding:10px;margin-top:8px">
      <div class="nv-card-t">故事框架（会写入「故事框架介绍」）</div>
      <div class="nv-preview" style="max-height:320px">${esc(r.frameworkIntro || '')}</div>
    </div>
    ${r.skillPrompt ? `<details style="margin-top:8px"><summary style="cursor:pointer;font-weight:700">题材写作技能提示词</summary><div class="nv-preview" style="max-height:220px;margin-top:6px">${esc(r.skillPrompt)}</div></details>` : ''}`;
  const m = S.ctx.modal({ title: '🧪 题材生成结果', body: wrap, width: 800 });
  const bar = document.createElement('div');
  bar.className = 'nv-row';
  bar.style.marginTop = '10px';
  bar.innerHTML = '<button class="nv-btn nv-btn-p" data-a="ok">应用并填入表单</button><button class="nv-btn" data-a="again">重新生成</button><button class="nv-btn" data-a="no">取消</button>';
  wrap.appendChild(bar);
  bar.querySelector('[data-a="no"]').onclick = () => m.close();
  bar.querySelector('[data-a="again"]').onclick = () => { m.close(); setTimeout(() => openGenreGenerator(), 0); };
  bar.querySelector('[data-a="ok"]').onclick = () => {
    applyCustomGenre(r, 'generator');
    m.close();
    toast('自定义题材、基调与故事框架已填入表单，请检查后保存', 'ok');
  };
}

async function openGenreGenerator() {
  if (S.busy) return;
  let opts = S.genreOptions;
  if (!opts) {
    const r = await guard(async () => S.ctx.api.get('/api/novels/ai/genre-generator-options'));
    if (!r?.options) return;
    opts = S.genreOptions = r.options;
  }
  const f = S.form || {};
  const cur = (f.custom_genre && f.custom_genre.options) || {};
  const sel = (list, chosen) => (list || []).map((o) => `<option value="${esc(o.id)}" ${o.id === chosen ? 'selected' : ''}>${esc(o.label)}</option>`).join('');
  const toneOptions = [...new Set([f.tone, ...(S.tones || [])].filter(Boolean))].slice(0, 100);
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="nv-hint" style="line-height:1.7">选择取向，生成器会组合出一个自定义题材（不联网、不消耗额度），并给出完整 7 模块故事框架与写作技能提示词。</div>
    <div class="nv-row" style="margin-top:10px">
      <label class="nv-f"><span class="nv-lbl">世界背景</span><select class="nv-select" id="gg-world">${sel(opts.worlds, cur.world)}</select></label>
      <label class="nv-f"><span class="nv-lbl">主角设定</span><select class="nv-select" id="gg-pro">${sel(opts.protagonists, cur.protagonist)}</select></label>
      <label class="nv-f"><span class="nv-lbl">核心冲突</span><select class="nv-select" id="gg-con">${sel(opts.conflicts, cur.conflict)}</select></label>
    </div>
    <div class="nv-row" style="margin-top:8px">
      <label class="nv-f"><span class="nv-lbl">叙事节奏</span><select class="nv-select" id="gg-pace">${sel(opts.paces, cur.pace)}</select></label>
      <label class="nv-f"><span class="nv-lbl">目标受众</span><select class="nv-select" id="gg-aud">${sel(opts.audiences, cur.audience)}</select></label>
      <label class="nv-f"><span class="nv-lbl">基调</span><select class="nv-select" id="gg-tone">${toneOptions.map((t) => `<option ${t === f.tone ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
    </div>
    <label class="nv-f" style="margin-top:8px"><span class="nv-lbl">题材名（留空则自动生成）</span><input class="nv-input" id="gg-name" placeholder="例如：都市·重生·商战复仇" value="${esc((f.custom_genre && f.custom_genre.name) || '')}"></label>
    <label class="nv-f" style="margin-top:8px"><span class="nv-lbl">关键词（空格/逗号分隔，可留空）</span><input class="nv-input" id="gg-keyword" placeholder="例如：豪门 商战 复仇 打脸" value="${esc((f.custom_genre && (f.custom_genre.keywords || []).join(' ')) || '')}"></label>`;
  const m = S.ctx.modal({ title: '🧪 题材生成器', body: wrap, width: 720 });
  const bar = document.createElement('div');
  bar.className = 'nv-row';
  bar.style.marginTop = '10px';
  bar.innerHTML = '<button class="nv-btn nv-btn-a" data-a="go">生成题材</button><button class="nv-btn" data-a="no">取消</button>';
  wrap.appendChild(bar);
  bar.querySelector('[data-a="no"]').onclick = () => m.close();
  bar.querySelector('[data-a="go"]').onclick = async () => {
    const payload = {
      world: wrap.querySelector('#gg-world').value,
      protagonist: wrap.querySelector('#gg-pro').value,
      conflict: wrap.querySelector('#gg-con').value,
      pace: wrap.querySelector('#gg-pace').value,
      audience: wrap.querySelector('#gg-aud').value,
      tone: wrap.querySelector('#gg-tone').value,
      name: wrap.querySelector('#gg-name').value.trim(),
      keyword: wrap.querySelector('#gg-keyword').value.trim(),
      targetWords: num(S.form?.target_words, 1000000),
    };
    const r = await guard(async () => S.ctx.api.post('/api/novels/ai/generate-genre', payload));
    if (!r?.genreId) return;
    m.close();
    showGeneratedGenrePreview(r);
  };
}

async function showGenreSkillPrompt(genreId) {
  const id = genreId || S.form?.genre;
  if (!id) { toast('请先选择题材', 'err'); return; }
  const cg = S.form?.custom_genre;
  const r = (cg && cg.genreId === id && cg.skillPrompt)
    ? { genreName: cg.name, skillPrompt: cg.skillPrompt }
    : await guard(async () => S.ctx.api.get(`/api/novels/ai/genre-skill-prompt?genre=${encodeURIComponent(id)}`));
  if (!r?.skillPrompt) return;
  S.genreSkillPrompt = r.skillPrompt;
  const body = document.createElement('div');
  body.innerHTML = `<div class="nv-hint" style="margin-bottom:6px">这是「${esc(r.genreName)}」题材专属的故事框架写法参考技能提示词，可作为写作标准或参考范本。</div>
    <div class="nv-preview" style="max-height:440px">${esc(r.skillPrompt)}</div>`;
  const m = S.ctx.modal({ title: '📐 题材写作技能提示词', body, width: 760 });
  const bar = document.createElement('div');
  bar.className = 'nv-row';
  bar.style.marginTop = '10px';
  bar.innerHTML = '<button class="nv-btn nv-btn-p" data-a="copy">复制</button><button class="nv-btn" data-a="close">关闭</button>';
  body.appendChild(bar);
  bar.querySelector('[data-a="close"]').onclick = () => m.close();
  bar.querySelector('[data-a="copy"]').onclick = async () => {
    try { await navigator.clipboard.writeText(r.skillPrompt); toast('已复制写作技能提示词', 'ok'); }
    catch { toast('浏览器拒绝了剪贴板权限，请手动选择复制', 'err'); }
  };
}

// 保存当前表单（创建页会创建项目）；返回是否已存在可操作的 novelId
async function ensureNovelSaved() {
  if (S.currentId && S.formMode !== 'create') return true;
  S.form = collectForm();
  if (!String(S.form.title || '').trim() || !S.form.genre) {
    toast('请先填写标题并选择题材（或点「AI 头脑风暴创意题材规划」自动补全）', 'err');
    return false;
  }
  toast('正在保存参数与角色…', 'info');
  await saveForm();
  return Boolean(S.currentId) && S.formMode !== 'create';
}

async function pipelineParamsAndCast() {
  if (S.busy) return;
  S.form = collectForm();
  if (!S.form.genre || !String(S.form.title || '').trim()) {
    const r = await guard(async () => S.ctx.api.post('/api/novels/ai/brainstorm-genre', {
      title: S.form.title || '',
      titleDescription: S.form.title_description || '',
      tone: S.form.tone || '',
      targetWords: num(S.form.target_words, 1000000),
      chapterWords: num(S.form.chapter_words, 2000),
    }));
    if (!r?.genreId) return;
    applyBrainstormToForm(r);
    if (!(await S.ctx.confirm('已用 AI 补全题材与参数。是否继续生成故事框架并按剧情补齐角色？'))) return;
  }
  if (!(await ensureNovelSaved())) return;
  await openAiFramework();
}

async function pipelineOutline() {
  if (S.busy) return;
  if (!(await ensureNovelSaved())) return;
  const estimate = await S.ctx.api.get(`/api/novels/${S.currentId}/estimate?action=outline`).catch(() => null);
  const calls = estimate?.estimate?.llmCalls || 1;
  if (!(await S.ctx.confirm(`将按整条故事线生成完整大纲（逐章大纲 + 全部叙事分节），预计约 ${calls} 次 LLM 调用，任务进入后台队列。继续？`))) return;
  const r = await guard(async () => S.ctx.api.post(`/api/novels/${S.currentId}/outline/ai/robust-job`, {
    instruction: '按整条故事线规划每章章首、章末与上下文衔接，确保前后逻辑一致；补齐全部非章节分节。',
  }));
  if (!r?.jobId) return;
  S.tab = 'outline';
  watchAiJob(r.jobId, `一键生成大纲（${r.total} 步）`);
}

async function pipelineChapters() {
  if (S.busy) return;
  if (!(await ensureNovelSaved())) return;
  if (!S.detail?.outline) { toast('还没有大纲：请先点「② 一键生成大纲」', 'err'); return; }
  const stats = chapterPlanStatsLocal(S.detail?.outline?.sections?.chapters || [], S.detail?.novel);
  const expected = stats.expected || (S.detail?.outline?.sections?.chapters || []).length;
  if (!expected) { toast('无法推导章节数，请检查总字数与单章字数', 'err'); return; }
  if (!(await S.ctx.confirm(`将从第 1 章到第 ${expected} 章逐章生成 ${CHAPTER_OUTLINE_MIN_CHARS}-${CHAPTER_OUTLINE_MAX_CHARS} 字章节大纲，已有内容会被覆盖（正文不受影响）。继续？`))) return;
  const r = await guard(async () => S.ctx.api.post(`/api/novels/${S.currentId}/outline/ai/rewrite-all`, {
    instruction: '整章大纲必须从章首状态推进到章末状态，承上启下，并与整条故事线、重大转折和结局逻辑一致。',
  }));
  if (!r?.jobId) return;
  S.tab = 'outline';
  watchAiJob(r.jobId, `一键生成章节大纲（${r.total} 章）`);
}

async function pipelineWrite() {
  if (S.busy) return;
  if (!(await ensureNovelSaved())) return;
  const todo = (S.detail?.chapters || []).filter((c) => c.status !== 'done');
  if (!todo.length) { toast('所有章节都已写完', 'info'); return; }
  if (!(await S.ctx.confirm(`将逐章写作 ${todo.length} 章正文（每章 ${CHAPTER_WRITE_MIN_WORDS}-${CHAPTER_WRITE_MAX_WORDS} 字），任务进入后台队列。继续？`))) return;
  await startWrite({ mode: 'all' });
}

function showAutoCharacterReport(r) {
  const created = Array.isArray(r.created) ? r.created : [];
  const failed = Array.isArray(r.failed) ? r.failed : [];
  const warnings = Array.isArray(r.warnings) ? r.warnings : [];
  const body = document.createElement('div');
  body.innerHTML = `<div class="nv-note" style="line-height:1.8">
    <b>角色自由模式结果</b><br>
    本次提案 ${r.characters?.length || 0} 个角色，已创建/复用 ${created.length} 个，失败 ${failed.length} 个。
  </div>
  ${created.length ? `<div class="nv-note" style="margin-top:8px"><b>归档到本小说：</b><br>${created.map((x) => `${esc(x.actorId)} ${esc(x.name)}${x.reused ? '（复用）' : '（新建）'}`).join('<br>')}</div>` : ''}
  ${failed.length ? `<div class="nv-warn" style="margin-top:8px">${failed.map((x) => `${esc(x.name)}：${esc(x.error)}`).join('<br>')}</div>` : ''}
  ${warnings.length ? `<div class="nv-warn" style="margin-top:8px">${warnings.map((x) => esc(x)).join('<br>')}</div>` : ''}`;
  const m = S.ctx.modal({ title: 'AI 剧情角色归档', body, width: 660 });
  const bar = document.createElement('div');
  bar.className = 'nv-row';
  bar.style.marginTop = '10px';
  bar.innerHTML = '<button class="nv-btn nv-btn-p" data-a="close">知道了</button>';
  body.appendChild(bar);
  bar.querySelector('[data-a="close"]').onclick = () => m.close();
}

async function autoCharactersFromPlot({ silentIfNone = false, quiet = false } = {}) {
  if (!S.freeMode?.enabled) {
    if (!(await S.ctx.confirm('角色自由模式尚未开启。是否开启并按当前剧情自动补齐角色？'))) return null;
    const mode = await saveFreeMode(true, { silent: true });
    if (!mode) return null;
  }
  if (!quiet && !(await S.ctx.confirm('将启动后台角色缺口任务，按剧情自动创建并归档角色。继续？'))) return null;
  const estimate = await S.ctx.api.get(`/api/novels/${S.currentId}/estimate?action=characters`).catch(() => null);
  const r = await guard(async () => S.ctx.api.post(`/api/novels/${S.currentId}/characters/free-mode/auto-job`, {
    apply: true,
    instruction: '根据故事大纲、章首章末、故事线和现有角色缺口自动补齐角色。',
  }));
  if (!r?.jobId) return null;
  watchAiJob(r.jobId, `角色剧情补齐（预计 ${estimate?.estimate?.llmCalls || 1} 次调用）`);
  return r;
}

function buildFrameworkText(framework = {}) {
  const logline = String(framework?.logline || '').trim();
  const modules = FRAMEWORK_MODULES.map(([title, items]) => {
    const body = items
      .map(([label, key]) => {
        const value = String(framework?.[key] || '').trim();
        return value ? `【${label}】\n${value}` : '';
      })
      .filter(Boolean)
      .join('\n');
    return body ? `## ${title}\n${body}` : '';
  }).filter(Boolean);
  return [
    logline ? `【一句话故事】\n${logline}` : '',
    ...modules,
  ].filter(Boolean).join('\n\n');
}

function aiFrameworkPayload() {
  const f = collectForm();
  return {
    title: f.title || '',
    titleDescription: f.title_description || '',
    genre: f.genre || '',
    genreName: (f.custom_genre && f.genre === f.custom_genre.genreId)
      ? f.custom_genre.name
      : (f.genre === 'custom-free' ? '自由创作（不限定题材）' : ''),
    tone: f.tone || '',
    pov: f.pov || '',
    castSize: num(f.cast_size, 20),
    targetWords: num(f.target_words, 1000000),
    chapterWords: num(f.chapter_words, 2000),
    seasons: num(f.seasons, 1),
    autoPov: Boolean(f.auto_pov),
    autoCast: Boolean(f.auto_cast || f.unlimited_characters),
    unlimitedCharacters: Boolean(f.unlimited_characters),
    actorIds: f.actor_ids || [],
    customActors: (f.custom_actors || []).filter((c) => (c.name || '').trim() || (c.desc || '').trim()),
    refDocPath: f.ref_doc_path || '',
  };
}

async function showGenreBlueprint(genreId) {
  const r = await guard(async () => S.ctx.api.get(`/api/novels/ai/genre-blueprints?genre=${encodeURIComponent(genreId)}`));
  const b = r?.blueprint;
  if (!b) return;
  const body = document.createElement('div');
  body.innerHTML = `<div class="nv-note" style="line-height:1.8"><b>${esc(b.genreName)}</b> · ${esc(b.category)}｜${esc(b.tone || '')}<br>${esc(b.creativePositioning)}</div>
    <div class="nv-card" style="padding:10px;margin-top:8px">
      <div class="nv-card-t">世界与主线引擎</div>
      <div style="line-height:1.8"><b>世界风格：</b>${esc(b.worldStyle)}<br><b>世界规则：</b>${esc(b.worldRules)}<br><b>循环危机：</b>${esc(b.coreLoopCrisis)}<br><b>终极谜团：</b>${esc(b.ultimateMystery)}</div>
    </div>
    <div class="nv-card" style="padding:10px;margin-top:8px">
      <div class="nv-card-t">人物与爆款钩子</div>
      <div style="line-height:1.8"><b>主角公式：</b>${esc(b.protagonistFormula)}<br><b>特别之处：</b>${esc(b.protagonistSpecial)}<br><b>开局：</b>${esc(b.openingFormula)}<br><b>结局方向：</b>${esc(b.endingDirection)}<br><b>爽点循环：</b>${esc(b.payoffLoop)}</div>
    </div>
    <div class="nv-card" style="padding:10px;margin-top:8px">
      <div class="nv-card-t">爆款与续集发动机</div>
      <div style="line-height:1.8">${(b.hitHooks || []).map((x, i) => `${i + 1}. ${esc(x)}`).join('<br>')}<br>
      <b>新区域：</b>${esc(b.sequelEngine?.newRegions || '')}<br>
      <b>新势力：</b>${esc(b.sequelEngine?.newFactions || '')}<br>
      <b>新危机：</b>${esc(b.sequelEngine?.newCrisis || '')}<br>
      <b>番外角色：</b>${esc(b.sequelEngine?.characterSpinoffs || '')}</div>
    </div>`;
  const m = S.ctx.modal({ title: 'AI 题材创意引擎', body, width: 720 });
  const bar = document.createElement('div');
  bar.className = 'nv-row';
  bar.style.marginTop = '10px';
  bar.innerHTML = '<button class="nv-btn nv-btn-p" data-a="close">关闭</button>';
  body.appendChild(bar);
  bar.querySelector('[data-a="close"]').onclick = () => m.close();
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
  const frameworkText = buildFrameworkText(framework);
  const characters = Array.isArray(proposal.characters) ? proposal.characters : [];
  wrap.innerHTML = `
    <div class="nv-hint" style="margin-bottom:8px;line-height:1.7">本次生成只调用 1 次 LLM。确认后标题和故事框架会直接覆盖当前表单；勾选的角色会创建演员矩阵 C-xxxx 角色卡，不会自动出定妆图。</div>
    ${proposal.mocked ? '<div class="nv-warn" style="margin-bottom:8px">当前是 mock 模式，只会填入「【离线占位】」内容，不会创建角色卡。</div>' : ''}
    <div class="nv-card" style="padding:10px">
      <div class="nv-card-t">标题</div>
      <div class="nv-col">${titleOptions.map((t, i) => `<label class="nv-row" style="gap:6px;cursor:pointer"><input type="radio" name="nv-ai-title" value="${esc(t)}" ${i === 0 ? 'checked' : ''}> <span>${esc(t)}${i === 0 ? '（主标题）' : '（备选）'}</span></label>`).join('')}</div>
    </div>
    <div class="nv-card" style="padding:10px;margin-top:8px">
      <div class="nv-card-t">故事框架</div>
      <div class="nv-preview" style="max-height:360px">${esc(frameworkText)}</div>
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
    if (!String(frameworkText || '').trim()) { toast('AI 未返回有效框架内容，请点「重新生成」再试', 'err'); okBtn.disabled = false; return; }
    S.form.framework_intro = frameworkText;
    if (payload.autoPov && framework.recommendedPov) {
      const recommended = String(framework.recommendedPov);
      const pov = S.povs.find((x) => x.id === recommended || x.name === recommended) || S.povs.find((x) => recommended.includes(x.name) || x.name.includes(recommended));
      if (pov) S.form.pov = pov.id;
    }
    if ((payload.autoCast || payload.unlimitedCharacters) && framework.recommendedCastSize) {
      const n = Math.min(limits().castSize.max, Math.max(1, num(framework.recommendedCastSize, S.form.cast_size)));
      S.form.cast_size = n;
      S.form.free_max = n;
    }
    if (createdNames.size) {
      S.form.custom_actors = (S.form.custom_actors || []).filter((c) => !createdNames.has(String(c.name || '').toLowerCase()));
      S.form.actor_ids = [...new Set([...(S.form.actor_ids || []), ...createdActorIds])];
    }
    m.close();
    S.tab = 'params';
    render();
    const area = S.root?.querySelector('[data-role="framework_intro"]');
    if (area) area.value = frameworkText;
    toast(proposal.mocked ? '已把离线占位框架写入「故事框架介绍」；mock 模式不会创建角色卡' : `已把故事框架（${frameworkText.length} 字）写入「故事框架介绍」，请检查后点「保存修改」`, 'ok');
  };
}

function plannedChapterCount() {
  const n = S.detail?.novel || {};
  return Math.min(200, Math.max(
    1,
    num(n.planned_chapters, 0),
    Math.ceil(num(n.target_words, 0) / Math.max(1, num(n.chapter_words, 2000))),
  ));
}

async function startOutlineGen() {
  if (!llmReady() && !(await S.ctx.confirm('当前 LLM 未就绪，生成会失败。可到「设置」页把 provider 切换为 mock（离线模板）后使用占位内容演示。仍要继续尝试吗？'))) return;
  const has = !!S.detail?.outline;
  if (has && !(await S.ctx.confirm('重新生成会新增一个大纲版本（已写作的章节正文不会被覆盖）。继续？'))) return;
  const planned = plannedChapterCount();
  // 章节较多时，整份大纲一次性生成容易因输出过长被截断（实测 10 章 + 完整框架会 JSON 截断报错）。
  // 直接用稳健模式按批逐章规划，避免先浪费一次几十秒的失败调用。
  if (planned > 12) {
    const useRobust = await S.ctx.confirm(`本项目约 ${planned} 章：整份大纲一次性生成容易因输出过长被截断。建议直接用「稳健模式」（每批 20 章逐章规划 + 逐节补齐，约 ${Math.ceil(planned / 20) + 1} 次调用）。是否使用稳健模式？`);
    if (useRobust) {
      const job = await guard(async () => S.ctx.api.post(`/api/novels/${S.currentId}/outline/ai/robust-job`, {
        instruction: '按整条故事线规划每章章首、章末和上下文衔接，确保前后逻辑一致。',
      }));
      if (!job?.jobId) return;
      S.tab = 'outline';
      watchAiJob(job.jobId, `稳健大纲生成（约 ${planned} 章）`);
      return;
    }
  }
  const primary = await guard(async () => {
    try {
      return await S.ctx.api.post(`/api/novels/${S.currentId}/outline`, { saveVersion: true });
    } catch (err) {
      return { __error: errText(err) };
    }
  });
  if (!primary) return;
  let r = primary;
  if (primary.__error) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const useFallback = await confirmOutlineFallback(`整份大纲 JSON 生成失败：${primary.__error}\n\n是否切换为稳健模式？将分 ${Math.ceil(planned / 20)} 批逐章规划，再逐节补齐非章节内容。`);
    if (!useFallback) { toast(`大纲生成失败：${primary.__error}`, 'err'); return; }
    const job = await guard(async () => S.ctx.api.post(`/api/novels/${S.currentId}/outline/ai/robust-job`, {
      instruction: '按整条故事线规划每章章首、章末和上下文衔接，确保前后逻辑一致。',
    }));
    if (!job?.jobId) return;
    S.tab = 'outline';
    watchAiJob(job.jobId, '稳健大纲生成');
    return;
  }
  const plannedCount = (r.outline?.sections?.chapters || []).length || r.planned || r.results?.length || 0;
  toast(`大纲已生成：规划 ${plannedCount} 章，${r.summary?.calls || 0} 次模型调用${r.summary?.warnings?.length ? `（${r.summary.warnings.length} 条提示）` : ''}`, 'ok');
  S.tab = 'outline';
  await reloadDetail();
  await loadList();
  if (S.freeMode?.enabled) await autoCharactersFromPlot({ silentIfNone: true, quiet: true });
}

function outlineAiSnapshot() {
  const s = S.detail?.outline?.sections || {};
  const empty = S.sections.filter((sec) => outlineSectionEmpty(sec.key, s[sec.key]));
  const chapterStats = chapterPlanStatsLocal(s.chapters, S.detail?.novel);
  return {
    sections: s,
    empty,
    fillable: empty.filter((sec) => sec.key !== 'chapters'),
    chaptersEmpty: chapterStats.complete === 0,
    chaptersIncomplete: chapterStats.missing.length,
    chapterStats,
  };
}

function showOutlineAiReport(result) {
  const fill = result?.fill || {};
  const chapter = result?.chapter || {};
  const chapterPlan = result?.chapterPlan || {};
  const warnings = [
    ...(Array.isArray(fill.warnings) ? fill.warnings : []),
    ...(Array.isArray(chapter.summary?.warnings) ? chapter.summary.warnings : []),
    ...(Array.isArray(chapterPlan.warnings) ? chapterPlan.warnings : []),
  ].filter(Boolean);
  if (!warnings.length && !fill.mocked && !chapterPlan.mocked) return;
  const body = document.createElement('div');
  body.innerHTML = `<div class="nv-note" style="line-height:1.8">
    <b>规划结果</b><br>
    章节大纲：${chapter.outline ? `v${chapter.outline.version}，规划 ${(chapter.outline.sections?.chapters || []).length} 章` : '本次未重新规划'}<br>
    指定章节补全：${chapterPlan.results ? `${chapterPlan.results.length} 章` : '本次未处理'}<br>
    非章节分节：本次补齐 ${(fill.results || []).length} 个
  </div>
  ${warnings.length ? `<div class="nv-warn" style="margin-top:8px;max-height:240px;overflow:auto">${warnings.map((w) => esc(w)).join('<br>')}</div>` : ''}
  ${(fill.mocked || chapterPlan.mocked) ? '<div class="nv-note" style="margin-top:8px">当前包含离线占位内容。配置真实 LLM 后可逐节点重做。</div>' : ''}`;
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
  if (!snap.chaptersEmpty && !snap.chaptersIncomplete && !snap.fillable.length) {
    toast('大纲 14 个分节和全部章节都已有完整内容；如需重做，请点对应节的「AI 生成本节」或章节行的「AI 规划」', 'info');
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
    将自动完成整份大纲的缺口规划：${snap.chaptersEmpty ? '<b>先规划章节大纲</b>，' : ''}${(!snap.chaptersEmpty && snap.chaptersIncomplete) ? `补齐 ${snap.chaptersIncomplete} 个不完整章节，` : ''}${snap.fillable.length ? `再逐节生成 ${snap.fillable.length} 个空缺分节（${snap.fillable.map((x) => esc(x.label)).join('、')}）` : '非章节分节已完整'}。
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
      let chapterPlan = null;
      if (snap.chaptersEmpty) {
        chapter = await S.ctx.api.post(`/api/novels/${S.currentId}/outline`, { saveVersion: true });
      } else if (snap.chaptersIncomplete) {
        chapterPlan = await S.ctx.api.post(`/api/novels/${S.currentId}/outline/ai/chapters`, {
          from: 1,
          to: snap.chapterStats.expected,
          onlyEmpty: true,
          instruction,
          save: true,
        });
      }
      let fill = null;
      if (snap.fillable.length) {
        fill = await S.ctx.api.post(`/api/novels/${S.currentId}/outline/ai/fill`, {
          save: true,
          onlyEmpty: true,
          instruction,
        });
      }
      return { chapter, chapterPlan, fill };
    }, 'AI 大纲规划已保存为新版本');
    if (!result) return;
    S.tab = 'outline';
    await reloadDetail();
    await loadList();
    if (result.fill?.mocked || result.chapterPlan?.mocked) toast('已生成离线占位大纲；配置真实 LLM 后可逐节重做', 'warn');
    if (S.freeMode?.enabled) await autoCharactersFromPlot({ silentIfNone: true, quiet: true });
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

function openChapterAiPlan({ from = 1, to = null, onlyEmptyDefault = true } = {}) {
  const rows = S.detail?.outline?.sections?.chapters || [];
  const stats = chapterPlanStatsLocal(rows, S.detail?.novel);
  if (!stats.expected) { toast('请先设置小说总字数与单章字数，生成章节规划范围', 'err'); return; }
  const start = Math.min(Math.max(num(from, 1), 1), stats.expected);
  const endDefault = to == null ? Math.min(stats.expected, start + 19) : num(to, start);
  const end = Math.min(Math.max(endDefault, start), stats.expected);
  const single = start === end;
  const wrap = document.createElement('div');
  wrap.innerHTML = `<div class="nv-hint" style="line-height:1.8">按章调用 AI 规划，每章大纲目标 <b>${CHAPTER_OUTLINE_MIN_CHARS}-${CHAPTER_OUTLINE_MAX_CHARS} 个中文字符</b>，并产出标题、关键事件、人物/地点、章末钩子和伏笔。当前共 ${stats.expected} 章，${stats.missing.length} 章未达标；本次最多处理 20 章。</div>
    <div class="nv-row" style="margin-top:10px">
      <label class="nv-f"><span class="nv-lbl">起始章</span><input class="nv-input" id="nv-ch-from" type="number" min="1" max="${stats.expected}" value="${start}"></label>
      <label class="nv-f"><span class="nv-lbl">结束章</span><input class="nv-input" id="nv-ch-to" type="number" min="1" max="${stats.expected}" value="${end}"></label>
    </div>
    <label class="nv-hint" style="margin-top:8px;display:flex;gap:6px;align-items:center"><input type="checkbox" id="nv-ch-only-empty" ${onlyEmptyDefault && !single ? 'checked' : ''}> 只补不完整章节（取消则覆盖所选章节的大纲，不影响已写正文）</label>
    <label class="nv-f" style="margin-top:8px"><span class="nv-lbl">额外要求（可选）</span>
      <textarea class="nv-area" id="nv-ch-note" rows="4" placeholder="例如：本章加强反转；让反派提前暴露；补一条主角与沈砚的冲突"></textarea>
    </label>`;
  const m = S.ctx.modal({ title: single ? `AI 规划第 ${start} 章` : 'AI 指定章节规划', body: wrap, width: 580 });
  const bar = document.createElement('div');
  bar.className = 'nv-row';
  bar.style.marginTop = '10px';
  bar.innerHTML = '<button class="nv-btn nv-btn-a" data-a="go">开始规划</button><button class="nv-btn" data-a="no">取消</button>';
  wrap.appendChild(bar);
  bar.querySelector('[data-a="no"]').onclick = () => m.close();
  bar.querySelector('[data-a="go"]').onclick = async () => {
    const a = num(wrap.querySelector('#nv-ch-from').value, 0);
    const b = num(wrap.querySelector('#nv-ch-to').value, 0);
    const onlyEmpty = wrap.querySelector('#nv-ch-only-empty').checked;
    const instruction = wrap.querySelector('#nv-ch-note').value.trim();
    if (a < 1 || b < a || b > stats.expected) { toast(`章节范围必须在 1~${stats.expected}，且结束章不小于起始章`, 'err'); return; }
    if (b - a + 1 > 20) { toast('单次最多规划 20 章，请分多次指定', 'err'); return; }
    m.close();
    const r = await guard(async () => S.ctx.api.post(`/api/novels/${S.currentId}/outline/ai/chapters`, {
      from: a,
      to: b,
      onlyEmpty,
      instruction,
      save: true,
      maxCalls: 20,
    }), `章节规划已保存为新版本`);
    if (!r) return;
    S.tab = 'outline';
    await reloadDetail();
    await loadList();
    if (r.mocked) toast('已生成离线占位章节，配置真实 LLM 后可对单章重做', 'warn');
    showOutlineAiReport({ chapterPlan: r });
  };
}

async function rewriteAllChapterPlans() {
  const rows = S.detail?.outline?.sections?.chapters || [];
  const stats = chapterPlanStatsLocal(rows, S.detail?.novel);
  if (!stats.expected) { toast('当前没有可规划的章节', 'err'); return; }
  const estimate = await guard(async () => S.ctx.api.get(`/api/novels/${S.currentId}/estimate?action=outline`));
  const calls = estimate?.estimate?.llmCalls || Math.ceil(stats.expected / 20) + 1;
  if (!(await S.ctx.confirm(`将从第 1 章到第 ${stats.expected} 章全部重写，预计约 ${calls} 次 LLM 调用。任务会进入后台队列，支持进度和取消。继续？`))) return;
  const r = await guard(async () => S.ctx.api.post(`/api/novels/${S.currentId}/outline/ai/rewrite-all`, {
    instruction: '整章大纲必须从章首状态推进到章末状态，承上启下，并与整条故事线、重大转折和结局逻辑一致。',
  }));
  if (!r?.jobId) return;
  S.tab = 'outline';
  watchAiJob(r.jobId, `全部章节大纲重写（${r.total} 章）`);
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
  if (S.ctx?.compute?.start) { S.ctx.compute.start('电脑正在运行计算…'); S.computeOn = true; }
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
  if (S.computeOn) { try { S.ctx?.compute?.stop?.(); } catch { /* ignore */ } S.computeOn = false; }
}

function watchAiJob(jobId, label) {
  stopWatching();
  S.jobId = jobId;
  S.job = { status: 'queued', progress: 0, done: 0, total: 1 };
  if (S.ctx?.compute?.start) { S.ctx.compute.start(label || '电脑正在运行计算…'); S.computeOn = true; }
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
    }
    if (!['done', 'error', 'canceled'].includes(job.status)) return;
    stopWatching();
    if (job.status === 'done') toast(`${label}完成`, 'ok');
    else if (job.status === 'error') toast(`${label}失败：${job.error || '未知错误'}`, 'err');
    else toast(`${label}已取消`, 'info');
    Promise.all([reloadDetail(), loadList()]).catch(() => { /* ignore */ });
    if (S.freeMode?.enabled && label.includes('大纲')) {
      autoCharactersFromPlot({ silentIfNone: true, quiet: true }).catch(() => { /* ignore */ });
    }
  };
  if (S.ctx.watchJob) {
    S.stopWatch = S.ctx.watchJob(jobId, onUpdate);
  } else {
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

async function startWrite(payload) {
  const r = await guard(async () => {
    const cw = num(S.detail?.novel?.chapter_words, 0);
    if (cw < CHAPTER_WRITE_MIN_WORDS || cw > CHAPTER_WRITE_MAX_WORDS) {
      await S.ctx.api.put(`/api/novels/${S.currentId}`, { chapter_words: CHAPTER_WRITE_TARGET_WORDS });
      await reloadDetail();
    }
    return S.ctx.api.post(`/api/novels/${S.currentId}/chapters/ai-write-job`, payload);
  });
  if (r?.jobId) {
    S.tab = 'chapters';
    watchAiJob(r.jobId, `一键写作（${r.total} 章）`);
    toast(`已创建长章写作任务：${r.total} 章（按 ${CHAPTER_WRITE_MIN_WORDS}-${CHAPTER_WRITE_MAX_WORDS} 字规划）`, 'info');
  }
}

async function startLongWrite(idx) {
  const chapter = (S.detail?.chapters || []).find((x) => num(x.idx, 0) === num(idx, 0));
  if (!chapter) { toast(`第 ${idx} 章不存在`, 'err'); return; }
  if (chapter.status === 'done' && !(await S.ctx.confirm(`第 ${idx} 章已有正文，将按 ${CHAPTER_WRITE_MIN_WORDS}-${CHAPTER_WRITE_MAX_WORDS} 字重新生成并覆盖。继续？`))) return;
  const r = await guard(async () => S.ctx.api.post(`/api/novels/${S.currentId}/chapters/${idx}/ai-write`, {
    save: true,
  }));
  if (!r) return;
  toast(`第 ${idx} 章写作完成：${r.words} 字${r.mocked ? '（离线占位）' : ''}`, r.words >= CHAPTER_WRITE_MIN_WORDS && r.words <= CHAPTER_WRITE_MAX_WORDS ? 'ok' : 'warn');
  S.tab = 'chapters';
  S.chapterIdx = idx;
  await reloadDetail();
  await loadChapter(idx);
  await loadList();
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
    const upd = () => { cc.textContent = `当前约 ${content.value.replace(/\s/g, '').length} 字（目标 ${CHAPTER_WRITE_MIN_WORDS}-${CHAPTER_WRITE_MAX_WORDS} 字）`; };
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
    case 'toggle-free-mode': await saveFreeMode(!S.freeMode?.enabled); return;
    case 'save-free-mode': await saveFreeMode(); return;
    case 'auto-characters': await autoCharactersFromPlot(); return;
    case 'asset-view': {
      const kind = el.dataset.kind;
      const rows = kind === 'character' ? S.assets?.characters : kind === 'environment' ? S.assets?.environments : S.assets?.props;
      showAsset((rows || []).find((x) => x.id === el.dataset.id));
      return;
    }
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
      S.form.custom_genre = null;
      S.genreMode = 'system';
      const g = S.genres.find((x) => x.id === el.dataset.id);
      if (g?.tone) S.form.tone = g.tone;
      render();
      return;
    }
    case 'genre-mode': {
      S.form = collectForm();
      S.genreMode = ['system', 'generator', 'brainstorm'].includes(el.dataset.mode) ? el.dataset.mode : 'system';
      render();
      return;
    }
    case 'genre-collapse': S.genreCollapsed = !S.genreCollapsed; collectForm(); render(); return;
    case 'genre-off': {
      S.form = collectForm();
      if (S.form.genre === 'custom-free') {
        S.form.genre = S.genres[0]?.id || '';
        const g = S.genres.find((x) => x.id === S.form.genre);
        if (g?.tone) S.form.tone = g.tone;
      } else {
        S.form.genre = 'custom-free';
        S.form.custom_genre = null;
      }
      S.genreMode = 'system';
      render();
      return;
    }
    case 'open-genre-generator': await openGenreGenerator(); return;
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
    case 'plan-genre': await planGenreFromForm(); return;
    case 'unlimited-cast': {
      S.form = collectForm();
      S.form.unlimited_characters = !S.form.unlimited_characters;
      if (S.form.unlimited_characters) {
        S.form.auto_cast = true;
        S.form.cast_size = limits().castSize.max;
        S.form.free_max = limits().castSize.max;
      }
      render();
      return;
    }
    case 'ai-framework': await openAiFramework(); return;
    case 'genre-blueprint': await showGenreBlueprint(el.dataset.id); return;
    case 'genre-skill': await showGenreSkillPrompt(el.dataset.id); return;
    case 'brainstorm-genre': await brainstormGenreFromForm(); return;
    case 'pipe-params': await pipelineParamsAndCast(); return;
    case 'pipe-outline': await pipelineOutline(); return;
    case 'pipe-chapters': await pipelineChapters(); return;
    case 'pipe-write': await pipelineWrite(); return;
    case 'upload-ref': S.root.querySelector('#nv-ref-file')?.click(); return;
    case 'clear-ref':
      S.form = collectForm(); S.form.ref_doc_path = ''; S.form.ref_doc_name = ''; render(); return;
    case 'tab': S.tab = el.dataset.tab; render(); return;
    case 'outline-gen': await startOutlineGen(); return;
    case 'outline-ai-plan': startOutlineAiPlan(); return;
    case 'outline-ai-chapters': openChapterAiPlan(); return;
    case 'outline-ai-chapters-all': rewriteAllChapterPlans(); return;
    case 'outline-ai-chapter': openChapterAiPlan({ from: idx, to: idx, onlyEmptyDefault: false }); return;
    case 'outline-chapter-view': showChapterOutline(idx); return;
    case 'outline-ai-section': await startOutlineAiSection(el.dataset.key, el.dataset.label || '大纲分节'); return;
    case 'outline-optimize': optimizeOutline(); return;
    case 'outline-append': appendOutline(); return;
    case 'write-next': {
      const next = (S.detail?.chapters || []).find((c) => c.status !== 'done');
      if (!next) { toast('所有章节都已写完', 'info'); return; }
      await startLongWrite(next.idx);
      return;
    }
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
    case 'gen-chapter': await startLongWrite(idx); return;
    case 'read': await loadChapter(idx); return;
    case 'edit-chapter': S.editing = true; render(); return;
    case 'cancel-edit': S.editing = false; render(); return;
    case 'save-chapter': {
      const content = readVal('content');
      const r = await guard(async () => S.ctx.api.put(`/api/novels/${S.currentId}/chapters/${S.chapterIdx}`, { content }));
      if (r) {
        S.editing = false;
        await loadChapter(S.chapterIdx);
        await reloadDetail();
        const words = num(r.words ?? r.chapter?.words, 0);
        toast(words < CHAPTER_WRITE_MIN_WORDS || words > CHAPTER_WRITE_MAX_WORDS
          ? `已保存，但正文 ${words} 字不在 ${CHAPTER_WRITE_MIN_WORDS}-${CHAPTER_WRITE_MAX_WORDS} 字范围`
          : '已保存', words < CHAPTER_WRITE_MIN_WORDS || words > CHAPTER_WRITE_MAX_WORDS ? 'warn' : 'ok');
      }
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

function confirmOutlineFallback(message) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const body = document.createElement('div');
    body.innerHTML = `<div class="nv-warn" style="line-height:1.8;white-space:pre-wrap">${esc(message)}</div>
      <div class="nv-note" style="margin-top:10px;line-height:1.8">
        稳健模式会按每批 20 章逐章规划，并补齐非章节大纲。调用次数会明显增加，但可以避开整份 JSON 截断导致的整体失败。
      </div>`;
    const m = S.ctx.modal({
      title: '整份大纲生成失败',
      body,
      width: 620,
      onClose: () => finish(false),
    });
    const bar = document.createElement('div');
    bar.className = 'nv-row';
    bar.style.marginTop = '10px';
    bar.innerHTML = '<button class="nv-btn nv-btn-a" data-a="ok">切换稳健模式</button><button class="nv-btn" data-a="no">取消</button>';
    body.appendChild(bar);
    bar.querySelector('[data-a="no"]').onclick = () => m.close();
    bar.querySelector('[data-a="ok"]').onclick = () => { finish(true); m.close(); };
  });
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
  if (role === 'free_mode') {
    S.form = collectForm();
    const on = !!e.target.checked;
    if (on) S.form.free_max = limits().castSize.max;
    const wrap = S.root?.querySelector('[data-role="free-max-wrap"]');
    if (wrap) wrap.style.display = on ? 'none' : '';
    return;
  }
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
  S.freeMode = null;
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
