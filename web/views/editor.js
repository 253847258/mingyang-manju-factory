// 后期精修 · 多轨编辑器（plain text view）
// 约定：只使用 ctx.api / ctx.toast / ctx.confirm / ctx.watchJob
// 类名统一 ed- 前缀

const STYLE_ID = 'ed-style';
let S = null;
let root = null;
let ctxRef = null;
let stopJob = null;
let videoEl = null;
let overlayEl = null;
let boxEl = null;
let rafTimer = 0;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const attr = (s) => esc(s);
const num = (n, d = 0) => (Number.isFinite(Number(n)) ? Number(n) : d);
const fmtMs = (ms) => {
  const n = Math.max(0, Math.round(Number(ms) || 0));
  const m = Math.floor(n / 60000);
  const s = Math.floor((n % 60000) / 1000);
  const f = Math.floor((n % 1000) / 1000 * 30);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(f).padStart(2, '0')}`;
};
const fileUrl = (p) => (p ? (ctxRef?.api?.fileUrl ? ctxRef.api.fileUrl(p) : `/${String(p).replace(/^\/+/, '')}`) : '');

function h(tag, attrs = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') n.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) n.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined) continue;
    n.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return n;
}

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const st = document.createElement('style');
  st.id = STYLE_ID;
  st.textContent = `
  .ed-wrap{display:flex;flex-direction:column;height:calc(100vh - 92px);gap:10px;padding:12px}
  .ed-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;background:var(--panel,#15181d);border:1px solid var(--line,#2a2f38);border-radius:10px;padding:8px 10px}
  .ed-btn{background:#20252d;color:#dfe6ef;border:1px solid #333b46;border-radius:8px;padding:6px 11px;cursor:pointer;font-size:13px}
  .ed-btn:hover{background:#2a313b}.ed-btn:disabled{opacity:.45;cursor:not-allowed}
  .ed-primary{background:#2563eb;border-color:#2563eb;color:#fff}
  .ed-danger{background:#7f1d1d;border-color:#991b1b;color:#fff}
  .ed-grid{flex:1;display:grid;grid-template-columns:230px 1fr 340px;gap:10px;min-height:0}
  .ed-col{background:var(--panel,#15181d);border:1px solid var(--line,#2a2f38);border-radius:10px;min-height:0;overflow:auto}
  .ed-col h4{margin:0;padding:9px 11px;font-size:12px;color:#93a1b3;border-bottom:1px solid #2a2f38;position:sticky;top:0;background:#15181d;z-index:2}
  .ed-stage{display:flex;flex-direction:column;min-height:0}
  .ed-video{position:relative;background:#000;flex:0 0 auto;display:flex;justify-content:center;align-items:center;height:44%}
  .ed-video video{max-width:100%;max-height:100%;display:block}
  .ed-video .ed-empty{color:#5c6673;font-size:13px;text-align:center;padding:20px}
  .ed-overlay{position:absolute;inset:0;cursor:crosshair}
  .ed-box{position:absolute;border:2px solid #f59e0b;background:rgba(245,158,11,.12);display:none}
  .ed-timeline{flex:1;overflow:auto;padding:8px 10px 16px}
  .ed-track{display:flex;align-items:stretch;gap:6px;margin-bottom:6px}
  .ed-tname{width:64px;flex:0 0 64px;font-size:11px;color:#8d99a8;display:flex;align-items:center}
  .ed-strip{flex:1;display:flex;gap:2px;min-height:56px;background:#0f1216;border:1px solid #232a32;border-radius:6px;padding:3px;position:relative}
  .ed-clip{position:relative;min-width:34px;border-radius:5px;background:#1e3a5f;border:1px solid #2f5f96;overflow:hidden;cursor:pointer;display:flex;align-items:flex-end}
  .ed-clip.ov{background:#3b2a5f;border-color:#5b3f96}
  .ed-clip.au{background:#1f4a3a;border-color:#2f7a5c}
  .ed-clip.sb{background:#4a3a1f;border-color:#8a6a2f}
  .ed-clip.sel{outline:2px solid #f59e0b;outline-offset:1px}
  .ed-clip img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:.55}
  .ed-clip span{position:relative;z-index:1;font-size:10px;padding:2px 4px;color:#e8eef7;text-shadow:0 1px 2px #000;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .ed-clip.dragging{opacity:.4}
  .ed-side{padding:10px 12px;font-size:13px}
  .ed-side label{display:block;font-size:11px;color:#8d99a8;margin:8px 0 3px}
  .ed-side input,.ed-side select,.ed-side textarea{width:100%;background:#0f1216;border:1px solid #2a313b;color:#dfe6ef;border-radius:6px;padding:5px 7px;font-size:12px}
  .ed-row{display:flex;gap:6px}
  .ed-tabs{display:flex;gap:4px;padding:8px 10px;border-bottom:1px solid #2a2f38;position:sticky;top:0;background:#15181d;z-index:2}
  .ed-tab{font-size:12px;padding:4px 9px;border-radius:6px;cursor:pointer;color:#93a1b3}
  .ed-tab.on{background:#243041;color:#fff}
  .ed-item{border-bottom:1px solid #222932;padding:8px 10px;font-size:12px;color:#c7d2de}
  .ed-item small{display:block;color:#7b8795;margin-top:2px}
  .ed-badge{font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid #333b46;color:#9aa7b6}
  .ed-badge.draft{background:#262c35}.ed-badge.review{background:#4a3a12;color:#f0c674}
  .ed-badge.approved{background:#123a24;color:#69d39a}.ed-badge.locked{background:#3a1d2a;color:#f08aa8}
  .ed-muted{color:#7b8795;font-size:12px}
  .ed-err{color:#f08aa8;font-size:12px;padding:6px 10px}
  .ed-warn{color:#f0c674;font-size:12px;padding:6px 10px}
  `;
  document.head.append(st);
}

function item(text, sub, onClick) {
  return h('div', { class: 'ed-item', onclick: onClick || null }, [text, sub ? h('small', {}, [sub]) : null]);
}

// ---------------- 数据 ----------------
async function loadStatus() {
  try { const r = await ctxRef.api.get('/api/edit/status'); S.enabled = !!r.enabled; S.operator = r.operator || '未署名'; }
  catch { S.enabled = false; }
}
async function loadEpisodes() {
  try { S.episodes = (await ctxRef.api.get('/api/edit/episodes')).episodes || []; }
  catch (e) { S.episodes = []; toastErr(e.message); }
  renderBar(); renderLibrary();
  if (S.episodes.length) {
    const first = S.episodes[0];
    await loadTimeline(first.code, first.script_id);
  }
}
async function loadTimeline(code, scriptId) {
  try {
    const r = await ctxRef.api.get(`/api/edit/timelines/${encodeURIComponent(code)}${scriptId ? `?script_id=${encodeURIComponent(scriptId)}` : ''}`);
    S.doc = { timeline: r.timeline, tracks: r.tracks || [] };
    S.code = code; S.scriptId = scriptId || r.timeline.script_id;
    S.savedDocVersion = r.timeline.doc_version;
    S.selected = null; S.dirty = false;
    await loadVersions(); await loadComments(); await loadAudit();
    renderAll();
  } catch (e) { toastErr(e.message); }
}
async function loadVersions() {
  if (!S.doc) return;
  try { const r = await ctxRef.api.get(`/api/edit/timelines/${S.doc.timeline.id}/versions`); S.versions = r.versions || []; S.films = r.films || []; }
  catch { S.versions = []; S.films = []; }
}
async function loadComments() {
  if (!S.doc) return;
  try { S.comments = (await ctxRef.api.get(`/api/edit/timelines/${S.doc.timeline.id}/comments`)).comments || []; } catch { S.comments = []; }
}
async function loadAudit() {
  if (!S.doc) return;
  try { S.audit = (await ctxRef.api.get(`/api/edit/timelines/${S.doc.timeline.id}/audit`)).logs || []; } catch { S.audit = []; }
}

function toastErr(msg) { ctxRef.toast(String(msg || '操作失败'), 'err', 4200); }
function toastOk(msg) { ctxRef.toast(String(msg || '完成'), 'ok', 2600); }

function mainTrack() { return S.doc?.tracks.find((t) => t.kind === 'main'); }
function trackByKind(kind) { return S.doc?.tracks.find((t) => t.kind === kind); }
function clipDur(c) { return Math.max(100, num(c.src_out_ms) - num(c.src_in_ms)); }
function totalDur() { return (mainTrack()?.clips || []).reduce((a, c) => a + clipDur(c), 0) || 1; }
function relayoutClipStarts() {
  let cur = 0;
  for (const c of (mainTrack()?.clips || [])) { c.start_ms = cur; cur += clipDur(c); }
  for (const t of S.doc.tracks) {
    if (t.kind === 'main') continue;
    if (t.kind === 'subtitle') {
      let s = 0;
      for (const c of t.clips || []) { c.start_ms = s; s += clipDur(c); }
    }
  }
}

// ---------------- 渲染 ----------------
function renderAll() { renderBar(); renderLibrary(); renderStage(); renderSide(); }

function renderBar() {
  const bar = root.querySelector('#ed-bar');
  if (!bar) return;
  bar.innerHTML = '';
  const sel = h('select', { class: 'ed-btn', onchange: (e) => {
    const ep = S.episodes.find((x) => `${x.script_id}:${x.code}` === e.target.value);
    if (ep) loadTimeline(ep.code, ep.script_id);
  } }, (S.episodes || []).map((x) => h('option', { value: `${x.script_id}:${x.code}` },
    `${x.script_id} · ${x.code}（${x.done}/${x.n} 镜头）`)));
  if (S.doc) sel.value = `${S.scriptId}:${S.code}`;
  const op = h('input', { class: 'ed-btn', style: { width: '110px' }, value: S.operator || '',
    onchange: async (e) => { try { const r = await ctxRef.api.post('/api/edit/operator', { name: e.target.value }); S.operator = r.operator; toastOk(`当前操作人：${r.operator}`); } catch (err) { toastErr(err.message); } } });
  const status = S.doc ? S.doc.timeline.status : 'draft';
  const labels = { draft: '草稿', review: '待审', approved: '已通过', locked: '已锁定' };
  bar.append(
    h('span', { class: 'ed-badge ' + status }, [labels[status] || status]),
    sel,
    h('span', { class: 'ed-muted' }, ['操作人']), op,
    h('span', { style: { flex: '1' } }),
    h('button', { class: 'ed-btn', disabled: S.doc?.timeline.status === 'locked' ? '' : null, onclick: saveDoc }, ['💾 保存']),
    h('button', { class: 'ed-btn ed-primary', disabled: S.doc?.timeline.status === 'locked' ? '' : null, onclick: renderFilm }, ['🎬 渲染成片']),
    h('button', { class: 'ed-btn', onclick: doResync }, ['🔄 从画布同步']),
  );
  if (!S.enabled) bar.append(h('span', { class: 'ed-err' }, ['后期精修未启用（config.edit.enabled=false）']));
}

function renderLibrary() {
  const box = root.querySelector('#ed-lib'); if (!box) return;
  box.innerHTML = '';
  const clips = mainTrack()?.clips || [];
  box.append(h('h4', {}, [`镜头（${clips.length}）`]));
  clips.forEach((c, i) => {
    box.append(item(`${i + 1}. ${c.title || c.shot_id || '未命名'}`, `${(clipDur(c) / 1000).toFixed(2)}s${c.file_path ? '' : ' · 缺视频'}`,
      () => { S.selected = c.id; renderAll(); }));
  });
  if (!clips.length) box.append(h('div', { class: 'ed-muted', style: { padding: '10px' } }, ['暂无分镜']));
}

function renderStage() {
  const stage = root.querySelector('#ed-stage');
  if (!stage) return;
  stage.innerHTML = '';
  const videoBox = h('div', { class: 'ed-video' });
  const film = (S.films || [])[0];
  if (film && film.file_path) {
    videoEl = h('video', { controls: '', preload: 'metadata', src: fileUrl(film.file_path) });
    videoEl.addEventListener('timeupdate', () => { S.currentMs = videoEl.currentTime * 1000; updatePlayhead(); });
    videoBox.append(videoEl);
    overlayEl = h('div', { class: 'ed-overlay', title: '按住拖拽可框选画面（用于审片批注）' });
    boxEl = h('div', { class: 'ed-box' });
    overlayEl.append(boxEl);
    bindBoxDrawing();
    videoBox.append(overlayEl);
  } else {
    videoEl = null;
    videoBox.append(h('div', { class: 'ed-empty' }, ['还没有成片。编辑完成后点「渲染成片」，这里会出现播放器。']));
  }
  const tl = h('div', { class: 'ed-timeline' });
  const total = totalDur();
  for (const t of S.doc.tracks) {
    const strip = h('div', { class: 'ed-strip' });
    const clips = t.clips || [];
    if (!clips.length) strip.append(h('span', { class: 'ed-muted', style: { padding: '16px 8px' } }, ['空轨']));
    clips.forEach((c) => {
      const w = Math.max(34, (clipDur(c) / total) * 100);
      const kindCls = t.kind === 'overlay' ? 'ov' : t.kind === 'audio' ? 'au' : t.kind === 'subtitle' ? 'sb' : '';
      const node = h('div', {
        class: `ed-clip ${kindCls} ${S.selected === c.id ? 'sel' : ''}`,
        style: { width: w + '%' },
        draggable: t.kind === 'main' ? 'true' : 'false',
        title: `${c.title || c.shot_id || ''}\n${fmtMs(c.src_in_ms)} → ${fmtMs(c.src_out_ms)}`,
        onclick: () => { S.selected = c.id; renderAll(); },
        ondragstart: (e) => { S.dragId = c.id; e.dataTransfer.effectAllowed = 'move'; },
        ondragover: (e) => { if (t.kind === 'main') e.preventDefault(); },
        ondrop: (e) => { if (t.kind !== 'main') return; e.preventDefault(); reorderMain(S.dragId, c.id); },
      }, [
        c.extra?.poster_path ? h('img', { src: fileUrl(c.extra.poster_path), alt: '' }) : null,
        h('span', {}, [c.title || c.shot_id || '镜头']),
      ]);
      strip.append(node);
    });
    tl.append(h('div', { class: 'ed-track' }, [h('div', { class: 'ed-tname' }, [t.name || t.kind]), strip]));
  }
  stage.append(videoBox, tl);
}

function renderSide() {
  const side = root.querySelector('#ed-side'); if (!side) return;
  side.innerHTML = '';
  const tabs = h('div', { class: 'ed-tabs' });
  for (const [id, name] of [['props', '属性'], ['review', '审片'], ['versions', '版本'], ['audit', '审计']]) {
    tabs.append(h('div', { class: `ed-tab ${S.tab === id ? 'on' : ''}`, onclick: () => { S.tab = id; renderSide(); } }, [name]));
  }
  side.append(tabs);
  const body = h('div', { class: 'ed-side' });
  if (S.tab === 'props') body.append(renderProps());
  if (S.tab === 'review') body.append(renderReview());
  if (S.tab === 'versions') body.append(renderVersions());
  if (S.tab === 'audit') body.append(renderAudit());
  side.append(body);
}

function findClip(id) {
  for (const t of S.doc.tracks) for (const c of t.clips || []) if (c.id === id) return { t, c };
  return null;
}

function renderProps() {
  const wrap = h('div');
  const found = S.selected ? findClip(S.selected) : null;
  if (!found) { wrap.append(h('div', { class: 'ed-muted' }, ['在左侧或时间线上点一个片段'])); return wrap; }
  const { t, c } = found;
  const field = (label, input) => h('div', {}, [h('label', {}, [label]), input]);
  const inputNum = (key, value, onChange, step = '50') => h('input', { type: 'number', step, value: String(value), onchange: (e) => { onChange(Number(e.target.value)); markDirty(); renderAll(); } });
  wrap.append(
    field('标题', h('input', { value: c.title || '', onchange: (e) => { c.title = e.target.value; markDirty(); renderAll(); } })),
    h('div', { class: 'ed-row' }, [
      h('div', { style: { flex: '1' } }, [h('label', {}, ['入点(ms)']), inputNum('in', c.src_in_ms, (v) => { c.src_in_ms = Math.max(0, v); if (c.src_out_ms <= c.src_in_ms) c.src_out_ms = c.src_in_ms + 500; })]),
      h('div', { style: { flex: '1' } }, [h('label', {}, ['出点(ms)']), inputNum('out', c.src_out_ms, (v) => { c.src_out_ms = Math.max(c.src_in_ms + 100, v); })]),
    ]),
    field('转场', h('select', { onchange: (e) => { c.transition_in = e.target.value; markDirty(); renderAll(); } },
      ['cut', 'dissolve', 'fade-to-black'].map((v) => h('option', { value: v, selected: c.transition_in === v ? '' : null }, [v])))),
    field('转场时长(ms)', inputNum('tm', c.transition_ms, (v) => { c.transition_ms = Math.max(0, Math.min(2000, v)); })),
    field('音量(dB)', inputNum('gain', c.gain_db, (v) => { c.gain_db = Math.max(-60, Math.min(12, v)); }, '1')),
  );
  if (t.kind === 'subtitle') {
    wrap.append(field('字幕文本', h('textarea', { rows: '4', onchange: (e) => { c.subtitle_text = e.target.value; markDirty(); } }, [c.subtitle_text || ''])));
  }
  if (t.kind === 'overlay') {
    const ex = c.extra || (c.extra = {});
    wrap.append(field('缩放(0-1)', inputNum('scale', ex.scale ?? 0.35, (v) => { ex.scale = Math.max(0.05, Math.min(1, v)); }, '0.05')));
    wrap.append(field('透明度(0-1)', inputNum('opacity', ex.opacity ?? 1, (v) => { ex.opacity = Math.max(0, Math.min(1, v)); }, '0.05')));
  }
  wrap.append(h('div', { class: 'ed-row', style: { marginTop: '12px' } }, [
    h('button', { class: 'ed-btn', onclick: splitClip }, ['✂ 分割（S）']),
    h('button', { class: 'ed-btn ed-danger', onclick: deleteClip }, ['🗑 删除']),
  ]));
  return wrap;
}

function renderReview() {
  const wrap = h('div');
  const status = S.doc.timeline.status;
  wrap.append(h('div', { class: 'ed-muted' }, [`当前状态：${status}`]));
  const btn = (label, target, cls = 'ed-btn') => h('button', { class: cls, onclick: () => setReview(target) }, [label]);
  const row = h('div', { class: 'ed-row', style: { margin: '10px 0' } });
  if (status === 'draft') row.append(btn('提交送审', 'review', 'ed-btn ed-primary'));
  if (status === 'review') { row.append(btn('通过', 'approved', 'ed-btn ed-primary'), btn('退回草稿', 'draft')); }
  if (status === 'approved') row.append(btn('锁定终版', 'locked', 'ed-btn ed-danger'), btn('退回重审', 'review'));
  wrap.append(row);
  wrap.append(h('label', {}, ['审片意见（暂停到某一帧后打点）']));
  const ta = h('textarea', { rows: '3', placeholder: '例如：这一镜字幕出得太快，压缩到 2 秒内' });
  const sev = h('select', {}, ['blocker', 'major', 'minor'].map((v) => h('option', { value: v }, [v])));
  const cat = h('select', {}, ['content', 'subtitle', 'audio', 'visual', 'pacing'].map((v) => h('option', { value: v }, [v])));
  const tc = h('input', { value: String(Math.round(S.currentMs || 0)), placeholder: '时间码(ms)' });
  wrap.append(h('div', { class: 'ed-row', style: { marginTop: '6px' } }, [sev, cat]));
  wrap.append(h('div', { class: 'ed-row', style: { marginTop: '6px' } }, [h('div', { style: { flex: '1' } }, [tc]), h('button', { class: 'ed-btn ed-primary', onclick: async () => {
    try {
      await ctxRef.api.post(`/api/edit/timelines/${S.doc.timeline.id}/comments`, {
        timecode_ms: Number(tc.value) || 0, severity: sev.value, category: cat.value, body: ta.value,
        x: S.box?.x, y: S.box?.y, w: S.box?.w, h: S.box?.h,
      });
      ta.value = ''; S.box = null; if (boxEl) boxEl.style.display = 'none';
      await loadComments(); renderSide(); toastOk('批注已记录');
    } catch (e) { toastErr(e.message); }
  } }, ['打点'])]));
  wrap.append(h('div', { class: 'ed-muted', style: { marginTop: '10px' } }, [`批注 ${S.comments.length} 条`]));
  for (const c of S.comments) {
    wrap.append(h('div', { class: 'ed-item' }, [
      `[${c.severity}] ${fmtMs(c.timecode_ms)} · ${c.body}`,
      h('small', {}, [`${c.author} · ${c.status}${c.x != null ? ' · 已框选' : ''}`]),
      h('button', { class: 'ed-btn', style: { marginTop: '4px' }, onclick: async () => {
        try {
          await ctxRef.api.patch(`/api/edit/comments/${c.id}`, { status: c.status === 'open' ? 'fixed' : 'open' });
          await loadComments(); renderSide();
        } catch (e) { toastErr(e.message); }
      } }, [c.status === 'open' ? '标记已处理' : '重新打开']),
    ]));
  }
  return wrap;
}

function renderVersions() {
  const wrap = h('div');
  wrap.append(h('div', { class: 'ed-muted' }, [`版本 ${S.versions.length} 个（渲染才会产生新版本）`]));
  for (const v of S.versions) {
    const film = (S.films || []).find((f) => f.id === v.film_id);
    wrap.append(h('div', { class: 'ed-item' }, [
      `v${v.version_no} · ${v.note || ''}`,
      h('small', {}, [`${v.operator} · ${String(v.created_at || '').slice(0, 19).replace('T', ' ')}${film ? ` · ${Math.round(film.size / 1024)} KB` : ''}`]),
      h('div', { class: 'ed-row', style: { marginTop: '5px' } }, [
        film ? h('a', { class: 'ed-btn', href: fileUrl(film.file_path), target: '_blank' }, ['▶ 播放']) : null,
        h('button', { class: 'ed-btn', onclick: async () => {
          if (!(await ctxRef.confirm(`恢复到 v${v.version_no}？当前未保存的改动会丢失。`))) return;
          try { const r = await ctxRef.api.post(`/api/edit/timelines/${S.doc.timeline.id}/versions/${v.version_no}/restore`, {}); S.doc = { timeline: r.timeline, tracks: r.tracks }; S.savedDocVersion = r.timeline.doc_version; S.dirty = false; await loadVersions(); renderAll(); toastOk(`已恢复到 v${v.version_no}`); }
          catch (e) { toastErr(e.message); }
        } }, ['↩ 恢复']),
      ]),
    ]));
  }
  return wrap;
}

function renderAudit() {
  const wrap = h('div');
  for (const a of S.audit) {
    wrap.append(h('div', { class: 'ed-item' }, [`${a.actor} · ${a.action}`, h('small', {}, [String(a.at || '').slice(0, 19).replace('T', ' ')])]));
  }
  if (!S.audit.length) wrap.append(h('div', { class: 'ed-muted' }, ['暂无审计记录']));
  return wrap;
}

// ---------------- 交互 ----------------
function markDirty() { S.dirty = true; renderBar(); }

function reorderMain(fromId, toId) {
  const clips = mainTrack()?.clips;
  if (!clips || !fromId || fromId === toId) return;
  const from = clips.findIndex((c) => c.id === fromId);
  const to = clips.findIndex((c) => c.id === toId);
  if (from < 0 || to < 0) return;
  const [moved] = clips.splice(from, 1);
  clips.splice(to, 0, moved);
  clips.forEach((c, i) => { c.order_index = i; });
  relayoutClipStarts();
  markDirty(); renderAll();
}

function splitClip() {
  const found = S.selected ? findClip(S.selected) : null;
  if (!found) return toastErr('先选一个片段');
  const { t, c } = found;
  const at = Math.max(c.src_in_ms + 100, Math.min(c.src_out_ms - 100, Math.round((c.src_in_ms + c.src_out_ms) / 2)));
  const right = JSON.parse(JSON.stringify(c));
  right.id = 'CL-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  c.src_out_ms = at;
  right.src_in_ms = at;
  const list = t.clips || [];
  list.splice(list.indexOf(c) + 1, 0, right);
  list.forEach((x, i) => { x.order_index = i; });
  relayoutClipStarts();
  markDirty(); renderAll();
}

function deleteClip() {
  const found = S.selected ? findClip(S.selected) : null;
  if (!found) return;
  const { t, c } = found;
  t.clips = (t.clips || []).filter((x) => x.id !== c.id);
  t.clips.forEach((x, i) => { x.order_index = i; });
  S.selected = null;
  relayoutClipStarts();
  markDirty(); renderAll();
}

async function saveDoc() {
  if (!S.doc) return true;
  try {
    const r = await ctxRef.api.put(`/api/edit/timelines/${S.doc.timeline.id}`, {
      doc_version: S.savedDocVersion,
      tracks: S.doc.tracks.map((t) => ({ ...t, clips: t.clips || [] })),
      operator: S.operator,
    });
    S.doc = { timeline: r.timeline, tracks: r.tracks };
    S.savedDocVersion = r.timeline.doc_version;
    S.dirty = false;
    renderAll();
    toastOk('已保存');
    return true;
  } catch (e) {
    toastErr(e.message);
    if (/版本/.test(e.message)) { await loadTimeline(S.code, S.scriptId); }
    return false;
  }
}

async function renderFilm() {
  if (S.dirty && !(await saveDoc())) return;
  try {
    const r = await ctxRef.api.post(`/api/edit/timelines/${S.doc.timeline.id}/render`, { operator: S.operator });
    if (!r.jobId) return;
    toastOk('渲染已提交，正在后台处理…');
    stopJob?.();
    stopJob = ctxRef.watchJob(r.jobId, '后期渲染', async (job) => {
      if (job.status === 'done') {
        await loadVersions();
        renderAll();
        toastOk('渲染完成，已生成新版本');
      } else if (job.status === 'error') toastErr(job.error || '渲染失败');
    });
  } catch (e) { toastErr(e.message); }
}

async function setReview(target) {
  try {
    const r = await ctxRef.api.post(`/api/edit/timelines/${S.doc.timeline.id}/review`, { status: target, operator: S.operator });
    S.doc.timeline = r.timeline;
    await loadAudit();
    renderAll();
    toastOk(`状态已更新：${r.timeline.status}`);
  } catch (e) { toastErr(e.message); }
}

async function doResync() {
  try {
    const r = await ctxRef.api.post(`/api/edit/timelines/${S.doc.timeline.id}/resync`, {});
    const p = r.preview;
    if (!p?.changed) return toastOk('画布与时间线一致，无需同步');
    if (!(await ctxRef.confirm(`画布已变化：新增 ${p.added.length} 镜、移除 ${p.removed.length} 镜。\n同步会用画布顺序覆盖主轨（当前精修会丢失），继续？`))) return;
    const applied = await ctxRef.api.post(`/api/edit/timelines/${S.doc.timeline.id}/resync`, { apply: true, operator: S.operator });
    S.doc = { timeline: applied.timeline, tracks: applied.tracks };
    S.savedDocVersion = applied.timeline.doc_version;
    renderAll();
    toastOk('已从画布同步');
  } catch (e) { toastErr(e.message); }
}

// 画面圈选
function bindBoxDrawing() {
  if (!overlayEl) return;
  let start = null;
  overlayEl.addEventListener('mousedown', (e) => {
    const r = overlayEl.getBoundingClientRect();
    start = { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height };
    boxEl.style.display = 'block';
    boxEl.style.left = start.x + 'px'; boxEl.style.top = start.y + 'px';
    boxEl.style.width = '0px'; boxEl.style.height = '0px';
  });
  overlayEl.addEventListener('mousemove', (e) => {
    if (!start) return;
    const r = overlayEl.getBoundingClientRect();
    const x = e.clientX - r.left; const y = e.clientY - r.top;
    boxEl.style.left = Math.min(x, start.x) + 'px';
    boxEl.style.top = Math.min(y, start.y) + 'px';
    boxEl.style.width = Math.abs(x - start.x) + 'px';
    boxEl.style.height = Math.abs(y - start.y) + 'px';
  });
  overlayEl.addEventListener('mouseup', () => {
    if (!start) return;
    const r = overlayEl.getBoundingClientRect();
    const x = parseFloat(boxEl.style.left);
    const y = parseFloat(boxEl.style.top);
    const w = parseFloat(boxEl.style.width);
    const h = parseFloat(boxEl.style.height);
    if (w > 6 && h > 6) S.box = { x: +(x / r.width).toFixed(4), y: +(y / r.height).toFixed(4), w: +(w / r.width).toFixed(4), h: +(h / r.height).toFixed(4) };
    start = null;
  });
}

function updatePlayhead() { /* 预留：时间线播放头 */ }

// ---------------- 生命周期 ----------------
export async function mount(el, ctx) {
  root = el; ctxRef = ctx;
  S = { enabled: false, episodes: [], doc: null, selected: null, tab: 'props', comments: [], versions: [], films: [], audit: [], currentMs: 0 };
  injectStyle();
  root.innerHTML = '';
  const wrap = h('div', { class: 'ed-wrap' });
  wrap.append(h('div', { class: 'ed-bar', id: 'ed-bar' }));
  wrap.append(h('div', { class: 'ed-grid' }, [
    h('div', { class: 'ed-col', id: 'ed-lib' }),
    h('div', { class: 'ed-col ed-stage', id: 'ed-stage' }),
    h('div', { class: 'ed-col', id: 'ed-side' }),
  ]));
  root.append(wrap);
  await loadStatus();
  renderBar();
  await loadEpisodes();
}

export function unmount() {
  try { stopJob?.(); } catch { /* ignore */ }
  stopJob = null;
  if (rafTimer) clearInterval(rafTimer);
  rafTimer = 0;
  S = null; root = null; ctxRef = null; videoEl = null; overlayEl = null; boxEl = null;
}
