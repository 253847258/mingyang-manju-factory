// 模块：小说改编（上传小说 → 剧本 / 角色 / 场景 / 道具 / 提示词 / 资产清单）
const STYLE_ID = 'ad-style';

const CSS = `
.ad-wrap{display:flex;gap:14px;height:100%;min-height:0;padding:10px 12px;color:var(--text,#e8e8ef);font-size:13px}
.ad-wrap *{box-sizing:border-box}
.ad-side{width:300px;flex:0 0 300px;display:flex;flex-direction:column;gap:8px;background:var(--panel,#16161d);border:1px solid var(--line,#2a2a36);border-radius:10px;padding:10px;min-height:0}
.ad-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:10px;min-height:0;overflow:auto;padding-right:2px}
.ad-h1{font-size:15px;font-weight:700;display:flex;align-items:center;gap:6px;margin:0}
.ad-h2{font-size:13px;font-weight:700;margin:0 0 6px}
.ad-muted{color:var(--muted,#8b8b9c);font-size:12px}
.ad-hint{color:var(--muted,#8b8b9c);font-size:11.5px;line-height:1.6}
.ad-card{background:var(--panel,#16161d);border:1px solid var(--line,#2a2a36);border-radius:10px;padding:12px}
.ad-card-t{font-weight:700;font-size:13px;margin-bottom:8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ad-btn{background:var(--panel-2,#1e1e28);color:var(--text,#e8e8ef);border:1px solid var(--line,#2a2a36);border-radius:8px;padding:5px 10px;cursor:pointer;font-size:12px;line-height:1.5;display:inline-flex;align-items:center;gap:4px;white-space:nowrap}
.ad-btn:hover{border-color:var(--accent,#6c8cff)}
.ad-btn:disabled{opacity:.45;cursor:not-allowed}
.ad-btn-p{background:var(--accent,#6c8cff);border-color:var(--accent,#6c8cff);color:#0b0b12;font-weight:700}
.ad-btn-a{background:var(--accent-2,#48d1a0);border-color:var(--accent-2,#48d1a0);color:#08120e;font-weight:700}
.ad-btn-d{border-color:var(--err,#f06060);color:var(--err,#f06060)}
.ad-btn-sm{padding:2px 7px;font-size:11.5px}
.ad-list{flex:1;overflow:auto;min-height:0;display:flex;flex-direction:column;gap:6px}
.ad-item{background:var(--panel-2,#1e1e28);border:1px solid var(--line,#2a2a36);border-radius:8px;padding:8px;cursor:pointer}
.ad-item:hover{border-color:var(--accent,#6c8cff)}
.ad-item.ad-on{border-color:var(--accent,#6c8cff);background:rgba(108,140,255,.12)}
.ad-item-t{font-weight:700;display:flex;justify-content:space-between;gap:6px;align-items:center}
.ad-item-m{color:var(--muted,#8b8b9c);font-size:11.5px;margin-top:3px;display:flex;gap:8px;flex-wrap:wrap}
.ad-tabs{display:flex;gap:6px;flex-wrap:wrap}
.ad-tab{padding:5px 12px;border-radius:8px;border:1px solid var(--line,#2a2a36);background:var(--panel,#16161d);cursor:pointer;font-size:12.5px}
.ad-tab.ad-on{background:var(--accent,#6c8cff);border-color:var(--accent,#6c8cff);color:#0b0b12;font-weight:700}
.ad-badge{display:inline-block;padding:1px 6px;border-radius:6px;font-size:11px;border:1px solid var(--line,#2a2a36);color:var(--muted,#8b8b9c)}
.ad-badge-ok{border-color:var(--ok,#48d1a0);color:var(--ok,#48d1a0)}
.ad-badge-warn{border-color:var(--warn,#f0b060);color:var(--warn,#f0b060)}
.ad-badge-err{border-color:var(--err,#f06060);color:var(--err,#f06060)}
.ad-badge-acc{border-color:var(--accent,#6c8cff);color:var(--accent,#6c8cff)}
.ad-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:8px}
.ad-kpi{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px}
.ad-kpi>div{background:var(--panel-2,#1e1e28);border:1px solid var(--line,#2a2a36);border-radius:8px;padding:10px}
.ad-kpi b{display:block;font-size:20px;line-height:1.2}
.ad-kpi span{color:var(--muted,#8b8b9c);font-size:11.5px}
.ad-prompt{white-space:pre-wrap;font-size:11.5px;line-height:1.6;background:var(--bg,#0f0f14);border:1px solid var(--line,#2a2a36);border-radius:8px;padding:6px 8px;max-height:150px;overflow:auto;margin-top:6px}
.ad-tbl{width:100%;border-collapse:collapse;font-size:12px}
.ad-tbl th,.ad-tbl td{border-bottom:1px solid var(--line,#2a2a36);padding:5px 6px;text-align:left;vertical-align:top}
.ad-tbl th{color:var(--muted,#8b8b9c);font-weight:600;white-space:nowrap}
.ad-scroll{max-height:420px;overflow:auto;border:1px solid var(--line,#2a2a36);border-radius:8px}
.ad-empty{padding:34px 12px;text-align:center;color:var(--muted,#8b8b9c);font-size:12.5px;line-height:2}
.ad-steps{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin-top:10px}
.ad-step{background:var(--panel-2,#1e1e28);border:1px solid var(--line,#2a2a36);border-radius:8px;padding:8px 10px;font-size:12px}
.ad-warn{background:rgba(240,176,96,.1);border:1px solid var(--warn,#f0b060);color:var(--warn,#f0b060);border-radius:8px;padding:8px 10px;font-size:12px;line-height:1.6}
.ad-busy{position:absolute;inset:0;background:rgba(10,10,16,.72);display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px;z-index:20;border-radius:10px}
.ad-wrap{position:relative}
.ad-spin{width:28px;height:28px;border-radius:50%;border:3px solid rgba(255,255,255,.18);border-top-color:var(--accent,#6c8cff);animation:ad-spin .8s linear infinite}
@keyframes ad-spin{to{transform:rotate(360deg)}}
.ad-beat{display:grid;grid-template-columns:52px 60px 90px 70px 110px 1fr;gap:6px;font-size:11.5px;padding:4px 0;border-bottom:1px solid var(--line,#2a2a36)}
.ad-beat span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ad-beat .ad-beat-w{white-space:normal;color:var(--muted,#8b8b9c)}
@media(max-width:1080px){.ad-wrap{flex-direction:column}.ad-side{width:auto;flex:0 0 auto;max-height:240px}}
`;

const S = {
  root: null, ctx: null,
  projects: [], current: null, bundle: null,
  tab: 'overview', busy: '', error: '',
  handlers: null,
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (Number(n) >= 10000 ? `${(Number(n) / 10000).toFixed(1)} 万` : String(Number(n) || 0));
const badge = (text, kind = '') => `<span class="ad-badge${kind ? ` ad-badge-${kind}` : ''}">${esc(text)}</span>`;
const statusBadge = (s) => badge(s === 'done' ? '已完成' : s === 'error' ? '失败' : s === 'running' ? '解析中' : '待转换', s === 'done' ? 'ok' : s === 'error' ? 'err' : s === 'running' ? 'warn' : '');

function toast(msg, type = 'info') { try { S.ctx.toast(msg, type); } catch { /* ignore */ } }

async function loadList() {
  const r = await S.ctx.api.get('/api/adapt/projects');
  S.projects = r.projects || [];
  if (S.current && !S.projects.some((p) => p.id === S.current)) S.current = null;
}

async function selectProject(id) {
  S.current = id;
  S.error = '';
  S.bundle = null;
  render();
  try {
    S.bundle = await S.ctx.api.get(`/api/adapt/projects/${id}`);
    render();
  } catch (e) {
    S.error = e.message || String(e);
    render();
  }
}

async function runConversion(useLlm = false) {
  if (!S.current) return;
  S.busy = useLlm ? 'AI 深度提炼中…' : '正在解析小说并生成剧本、角色、场景、道具和资产清单…';
  render();
  try {
    const r = await S.ctx.api.post(`/api/adapt/projects/${S.current}/run`, { useLlm, maxCharacters: 60, maxScenes: 40, maxProps: 60 });
    S.bundle = r;
    toast(useLlm ? 'AI 深度提炼完成' : '小说改编完成', 'ok');
    await loadList();
  } catch (e) {
    S.error = e.message || String(e);
    toast(`改编失败：${S.error}`, 'err');
  } finally {
    S.busy = '';
    render();
  }
}

async function uploadNovel(file) {
  if (!file) return;
  S.busy = `上传 ${file.name}…`;
  render();
  try {
    const up = await S.ctx.api.upload(file);
    if (!up?.path) throw new Error('上传返回缺少 path');
    const title = file.name.replace(/\.[^.]+$/, '');
    const created = await S.ctx.api.post('/api/adapt/projects', { title, sourceName: up.name || file.name, sourcePath: up.path });
    await loadList();
    S.current = created.project.id;
    S.bundle = null;
    toast('上传完成，开始自动转换', 'ok');
    await runConversion(false);
  } catch (e) {
    S.busy = '';
    S.error = e.message || String(e);
    toast(`上传失败：${S.error}`, 'err');
    render();
  }
}

async function deleteProject(id) {
  if (!window.confirm('确定删除这个改编项目及其清单？原始上传文件不会被删除。')) return;
  try {
    await S.ctx.api.del(`/api/adapt/projects/${id}`);
    if (S.current === id) { S.current = null; S.bundle = null; }
    await loadList();
    toast('已删除改编项目', 'ok');
    render();
  } catch (e) {
    toast(`删除失败：${e.message}`, 'err');
  }
}

async function importAll() {
  if (!S.current) return;
  S.busy = '正在导入演员矩阵、画布节点和剧本工厂…';
  render();
  try {
    const r = await S.ctx.api.post(`/api/adapt/projects/${S.current}/import`, {
      characters: true, scenes: true, props: true, script: true,
    });
    S.busy = '';
    const skipped = r.skipped?.length ? `，跳过 ${r.skipped.length} 项` : '';
    toast(`导入完成：角色 ${r.characters.length} · 场景 ${r.scenes.length} · 道具 ${r.props.length}${r.script ? ` · 剧本 ${r.script.id}` : ''}${skipped}`, 'ok');
    render();
  } catch (e) {
    S.busy = '';
    S.error = e.message || String(e);
    toast(`导入失败：${S.error}`, 'err');
    render();
  }
}

async function toProduction() {
  if (!S.current) return;
  S.busy = '正在物化正式小说、剧本和分镜…';
  render();
  try {
    const r = await S.ctx.api.post(`/api/adapt/projects/${S.current}/to-production`, { sync: true });
    S.busy = '';
    (r.warnings || []).slice(0, 4).forEach((w) => toast(w, 'warn'));
    toast(`已生成：小说 ${r.novelId} · 剧本 ${r.scriptId} · ${r.episodeCount} 集${r.shotCount ? ` · ${r.shotCount} 镜` : ''}`, 'ok', 5600);
    render();
    if (window.confirm(`已生成正式小说和剧本：\n小说 ${r.novelId}\n剧本 ${r.scriptId}\n\n现在打开剧本工厂查看吗？`)) {
      S.ctx.go('script');
    }
  } catch (e) {
    S.busy = '';
    S.error = e.message || String(e);
    toast(`生成可拍分镜失败：${S.error}`, 'err');
    render();
  }
}

function copyPrompt(text) {
  const run = async () => {
    try { await navigator.clipboard.writeText(text); toast('提示词已复制', 'ok'); }
    catch { window.prompt('手动复制提示词：', text); }
  };
  run();
}

function renderSidebar() {
  return `<aside class="ad-side">
    <div class="ad-h1">📥 小说改编</div>
    <button class="ad-btn ad-btn-p" data-act="upload">上传小说（txt / md / json）</button>
    <input type="file" id="ad-file" accept=".txt,.md,.json" style="display:none">
    <div class="ad-hint">上传后自动分章、抽角色/场景/道具，并生成剧本草案、文生图提示词和资产清单。原始文件不会被修改。</div>
    <div class="ad-list">
      ${S.projects.length ? S.projects.map((p) => `<div class="ad-item${p.id === S.current ? ' ad-on' : ''}" data-act="open" data-id="${esc(p.id)}">
        <div class="ad-item-t"><b>${esc(p.title)}</b>${statusBadge(p.status)}</div>
        <div class="ad-item-m"><span>${fmt(p.char_count)} 字</span><span>${p.chapter_count || 0} 章</span><span>${esc(p.source_name || '')}</span></div>
      </div>`).join('') : '<div class="ad-hint" style="padding:10px 2px">还没有项目，点上方按钮上传第一本小说。</div>'}
    </div>
  </aside>`;
}

function kpi(label, value) {
  return `<div><b>${esc(value)}</b><span>${esc(label)}</span></div>`;
}

function renderOverview() {
  const p = S.bundle.project;
  const sum = p.summary || {};
  const warnings = p.warnings || [];
  return `<div class="ad-card">
    <div class="ad-card-t">📊 改编总览 ${statusBadge(p.status)}</div>
    <div class="ad-kpi">
      ${kpi('原文字数', fmt(p.char_count))}
      ${kpi('章节', sum.chapters || p.chapter_count || 0)}
      ${kpi('剧本集数', sum.episodes || 0)}
      ${kpi('Beat 数', sum.beats || 0)}
      ${kpi('角色', sum.characters || 0)}
      ${kpi('场景', sum.scenes || 0)}
      ${kpi('道具', sum.props || 0)}
      ${kpi('资产项', sum.assets || 0)}
    </div>
    ${warnings.length ? `<div class="ad-warn" style="margin-top:10px">${warnings.map(esc).join('<br>')}</div>` : ''}
    <div class="ad-hint" style="margin-top:10px">下一步：先把「角色」和「场景」的提示词挑一遍，再导入演员矩阵和画布节点；剧本页可以直接给剧本工厂做二次加工。</div>
  </div>`;
}

function renderScript() {
  const item = (S.bundle.grouped.script || [])[0];
  const script = item?.details;
  if (!script?.episodes?.length) return '<div class="ad-card ad-empty">还没有剧本结果，点「重新转换」。</div>';
  return `<div class="ad-card">
    <div class="ad-card-t">🎬 剧本草案（${script.totalEpisodes} 集 · 单集目标 ${script.episodeSeconds} 秒）</div>
    ${script.episodes.map((ep) => `<details style="margin-bottom:8px">
      <summary style="cursor:pointer;font-weight:700;padding:6px 0">${esc(ep.episode)} · ${esc(ep.title)} · ${ep.beats.length} beat · ${ep.totalDuration}s</summary>
      <div class="ad-hint" style="margin:4px 0 8px">章末钩子：${esc(ep.hook || '（无）')}</div>
      <div class="ad-scroll">
        <div class="ad-beat" style="font-weight:700;color:var(--muted)"><span>镜号</span><span>景别</span><span>场景</span><span>时间</span><span>人物</span><span>动作 / 台词</span></div>
        ${ep.beats.slice(0, 80).map((b) => `<div class="ad-beat">
          <span>${b.no}</span><span>${esc(b.shot)}</span><span>${esc(b.location)}</span><span>${esc(b.time)}</span><span>${esc((b.characters || []).join('、') || '—')}</span>
          <span class="ad-beat-w">${esc(b.action)}${b.dialogue ? ` ｜ 台词：${esc(b.dialogue)}` : ''}（${b.duration}s）</span>
        </div>`).join('')}
      </div>
    </details>`).join('')}
  </div>`;
}

function renderEntityCards(category) {
  const items = S.bundle.grouped[category] || [];
  if (!items.length) return `<div class="ad-card ad-empty">没有识别出${category === 'character' ? '角色' : category === 'scene' ? '场景' : '道具'}，可以补充原文后重新转换。</div>`;
  return `<div class="ad-grid">${items.map((it) => `<div class="ad-card">
    <div class="ad-card-t">${esc(it.name)} ${badge(it.subtitle || '')}</div>
    <div class="ad-hint">${esc(it.summary || '')}</div>
    <div class="ad-prompt">${esc(it.prompt || '')}</div>
    <div style="margin-top:8px"><button class="ad-btn ad-btn-sm" data-act="copy" data-text="${esc(it.prompt || '')}">复制提示词</button></div>
  </div>`).join('')}</div>`;
}

function renderPrompts() {
  const items = S.bundle.grouped.prompt || [];
  return `<div class="ad-card">
    <div class="ad-card-t">🎨 文生图提示词（${items.length}）</div>
    <div class="ad-scroll"><table class="ad-tbl">
      <thead><tr><th>名称</th><th>类型</th><th>正向提示词</th><th>负向提示词</th><th>操作</th></tr></thead>
      <tbody>${items.map((it) => `<tr>
        <td>${esc(it.name)}</td><td>${esc(it.subtitle || '')}</td>
        <td style="max-width:420px">${esc(it.prompt || '')}</td>
        <td style="max-width:220px;color:var(--muted)">${esc(it.negative || '')}</td>
        <td><button class="ad-btn ad-btn-sm" data-act="copy" data-text="${esc(it.prompt || '')}">复制</button></td>
      </tr>`).join('')}</tbody>
    </table></div>
  </div>`;
}

function renderAssets() {
  const items = (S.bundle.grouped.asset || []).filter((it) => !Array.isArray(it.details) && !it.details?.assets && !it.details?.isSummary);
  return `<div class="ad-card">
    <div class="ad-card-t">📦 资产清单（${items.length}）<button class="ad-btn ad-btn-sm" data-act="export" data-format="csv">导出 CSV</button></div>
    <div class="ad-scroll"><table class="ad-tbl">
      <thead><tr><th>类型</th><th>名称</th><th>建议ID</th><th>目标模块</th><th>优先级</th><th>建议文件名</th><th>用途</th><th>操作</th></tr></thead>
      <tbody>${items.map((it) => { const d = it.details || {}; return `<tr>
        <td>${esc(d.assetType || it.subtitle || '')}</td><td>${esc(it.name)}</td><td>${esc(d.suggestedId || '')}</td>
        <td>${esc(d.targetModule || '')}</td><td>${esc(d.priority || '')}</td><td>${esc(d.suggestedFileName || '')}</td>
        <td>${esc(d.usage || '')}</td><td><button class="ad-btn ad-btn-sm" data-act="copy" data-text="${esc(it.prompt || '')}">复制提示词</button></td>
      </tr>`; }).join('')}</tbody>
    </table></div>
  </div>`;
}

function renderTabContent() {
  if (!S.bundle) return `<div class="ad-card ad-empty">${S.error ? esc(S.error) : '正在加载项目…'}</div>`;
  if (S.tab === 'script') return renderScript();
  if (S.tab === 'character') return renderEntityCards('character');
  if (S.tab === 'scene') return renderEntityCards('scene');
  if (S.tab === 'prop') return renderEntityCards('prop');
  if (S.tab === 'prompt') return renderPrompts();
  if (S.tab === 'asset') return renderAssets();
  return renderOverview();
}

function renderMain() {
  if (!S.current) {
    return `<main class="ad-main"><div class="ad-card ad-empty">
      <div style="font-size:34px">📥</div>
      <div style="font-weight:700;color:var(--text)">把一本小说变成可直接开干的资产包</div>
      <div>上传 txt / md / json，自动产出剧本草案、角色、场景、道具、文生图提示词和资产清单。</div>
      <div class="ad-steps">
        <div class="ad-step">1. 上传小说</div><div class="ad-step">2. 自动分章</div><div class="ad-step">3. 抽角色/场景/道具</div>
        <div class="ad-step">4. 生成提示词</div><div class="ad-step">5. 导出资产清单</div>
      </div>
    </div></main>`;
  }
  const p = S.bundle?.project;
  const tabs = [['overview', '总览'], ['script', '剧本'], ['character', '角色'], ['scene', '场景'], ['prop', '道具'], ['prompt', '提示词'], ['asset', '资产清单']];
  return `<main class="ad-main">
    <div class="ad-card">
      <div class="ad-card-t" style="justify-content:space-between">
        <span>${esc(p?.title || '加载中…')} ${p ? statusBadge(p.status) : ''}</span>
        <span style="display:flex;gap:6px;flex-wrap:wrap">
          <button class="ad-btn ad-btn-p" data-act="run" ${S.busy ? 'disabled' : ''}>重新转换</button>
          <button class="ad-btn" data-act="run-ai" ${S.busy ? 'disabled' : ''}>AI 深度提炼</button>
          <button class="ad-btn ad-btn-a" data-act="import" ${S.busy ? 'disabled' : ''}>一键导入演员/画布/剧本</button>
          <button class="ad-btn ad-btn-a" data-act="to-production" ${S.busy ? 'disabled' : ''}>🎬 生成可拍分镜</button>
          <button class="ad-btn" data-act="export" data-format="json">导出 JSON</button>
          <button class="ad-btn" data-act="export" data-format="md">导出 MD</button>
          <button class="ad-btn ad-btn-d" data-act="delete" data-id="${esc(S.current)}">删除项目</button>
        </span>
      </div>
      <div class="ad-hint">来源：${esc(p?.source_name || '—')} · ${fmt(p?.char_count)} 字 · ${p?.chapter_count || 0} 章</div>
      ${S.error ? `<div class="ad-warn" style="margin-top:8px">${esc(S.error)}</div>` : ''}
    </div>
    <div class="ad-tabs">${tabs.map(([id, label]) => `<button class="ad-tab${S.tab === id ? ' ad-on' : ''}" data-act="tab" data-tab="${id}">${label}</button>`).join('')}</div>
    ${renderTabContent()}
  </main>`;
}

function render() {
  if (!S.root) return;
  S.root.innerHTML = `<div class="ad-wrap">${S.busy ? `<div class="ad-busy"><div class="ad-spin"></div><div>${esc(S.busy)}</div></div>` : ''}${renderSidebar()}${renderMain()}</div>`;
}

export function mount(root, ctx) {
  S.root = root;
  S.ctx = ctx;
  S.tab = 'overview';
  S.busy = '';
  S.error = '';
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  S.handlers = {
    click: async (e) => {
      const t = e.target.closest('[data-act]');
      if (!t) return;
      const act = t.dataset.act;
      if (act === 'upload') { S.root.querySelector('#ad-file')?.click(); return; }
      if (act === 'open') { await selectProject(t.dataset.id); return; }
      if (act === 'tab') { S.tab = t.dataset.tab; render(); return; }
      if (act === 'run') { await runConversion(false); return; }
      if (act === 'run-ai') { await runConversion(true); return; }
      if (act === 'import') { await importAll(); return; }
      if (act === 'to-production') { await toProduction(); return; }
      if (act === 'delete') { await deleteProject(t.dataset.id); return; }
      if (act === 'copy') { copyPrompt(t.dataset.text || ''); return; }
      if (act === 'export') { window.open(`/api/adapt/projects/${S.current}/export?format=${encodeURIComponent(t.dataset.format || 'json')}`, '_blank'); }
    },
    change: async (e) => {
      if (e.target?.id === 'ad-file') {
        const file = e.target.files?.[0];
        e.target.value = '';
        await uploadNovel(file);
      }
    },
  };
  root.addEventListener('click', S.handlers.click);
  root.addEventListener('change', S.handlers.change);
  render();
  (async () => {
    try {
      await loadList();
      if (S.projects.length) await selectProject(S.projects[0].id);
      else render();
    } catch (e) {
      S.error = e.message || String(e);
      render();
    }
  })();
}

export function unmount() {
  if (S.root && S.handlers) {
    try {
      S.root.removeEventListener('click', S.handlers.click);
      S.root.removeEventListener('change', S.handlers.change);
    } catch { /* ignore */ }
  }
  S.root = null;
  S.ctx = null;
  S.handlers = null;
  S.bundle = null;
}
