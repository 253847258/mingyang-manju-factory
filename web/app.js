// 应用外壳：导航、上下文注入、模块装载
import { api } from './lib/api.js';
import { el, toast, confirmDialog, modal, injectStyle, fmtNum } from './lib/ui.js';
import { computeWheel } from './lib/compute-wheel.js';

const MODULES = [
  { id: 'actors', title: '明星演员矩阵', icon: '🎭', file: './views/actors.js', desc: '宫格矩阵画布 · 明星档案 · 文生图/参考生图' },
  { id: 'adapt', title: '小说改编', icon: '📥', file: './views/adapt.js', desc: '上传小说 → 剧本 / 角色 / 场景 / 道具 / 提示词 / 资产清单' },
  { id: 'novel', title: '小说工坊', icon: '📖', file: './views/novel.js', desc: '高级创作模式：大纲 → 完整章节（100 题材 / 200 角色 / 1000 万字）' },
  { id: 'script', title: '剧本工厂', icon: '🎬', file: './views/script.js', desc: '小说 → 漫剧/电影剧本 → 分镜提示词' },
  { id: 'render', title: '制作台', icon: '🎞', file: './views/render.js', desc: '分镜 → 关键帧 → 视频 → 整集成片' },
  { id: 'editor', title: '后期精修', icon: '✂️', file: './views/editor.js', desc: '多轨轻剪 · 审片打点 · 版本溯源' },
  { id: 'assets', title: '资产库', icon: '🗂️', file: './views/assets.js', desc: '实体资产 · 版本快照 · 血缘追踪 · 成本与订单' },
  { id: 'production', title: '生产看板', icon: '📊', file: './views/production.js', desc: '多项目/多集进度 · 阻塞 · 预算 · 订单摘要' },
  { id: 'studio', title: '制片 Agent', icon: '🎬', file: './views/studio.js', desc: '一句话需求 → 全自动制片流水线（付费阶段人工闸门）' },
  { id: 'settings', title: '设置', icon: '⚙️', file: './views/settings.js', desc: 'LLM / 出图后端 / 数据备份' },
];

const state = {
  current: null,
  view: null,           // { mount, unmount }
  meta: null,
  health: null,
  loaded: {},           // moduleId -> module
};

function ctxFor(id) {
  return {
    api,
    meta: state.meta,
    toast,
    confirm: confirmDialog,
    modal,
    go: (target) => navigate(target),
    watchJob: api.watchJob,
    health: () => state.health,
    compute: computeWheel,
  };
}

async function loadModule(mod) {
  if (state.loaded[mod.id]) return state.loaded[mod.id];
  try {
    // 先探测文件是否存在（避免 SPA 回退把 index.html 当模块返回，产生 MIME 报错）
    const head = await fetch(mod.file, { method: 'HEAD' }).catch(() => null);
    const ct = head?.headers?.get('content-type') || '';
    if (head && !head.ok) { console.warn(`[app] 模块 ${mod.id} 文件不存在（HTTP ${head.status}）`); return null; }
    if (ct && !/javascript/i.test(ct)) { console.warn(`[app] 模块 ${mod.id} 文件尚未生成（content-type=${ct}）`); return null; }
    const m = await import(mod.file);
    state.loaded[mod.id] = m;
    return m;
  } catch (err) {
    console.warn(`[app] 模块 ${mod.id} 加载失败：`, err);
    return null;
  }
}

function notReady(mod, err) {
  return el('div', { class: 'mod-loading' }, [
    el('div', { style: { fontSize: '34px' } }, [mod.icon]),
    el('div', { style: { fontWeight: 600, color: 'var(--text)' } }, [`${mod.title} 模块尚未就绪`]),
    el('div', { class: 'small', text: `前端文件 ${mod.file} 加载失败或后端路由未安装。` }),
    el('div', { class: 'small muted', text: String(err?.message || err || '') }),
    el('button', { class: 'btn', onclick: () => location.reload() }, ['重新加载页面']),
  ]);
}

async function navigate(id, opts = {}) {
  const mod = MODULES.find((m) => m.id === id) || MODULES[0];
  if (state.current === mod.id && !opts.force) return;
  if (state.view?.unmount) { try { state.view.unmount(); } catch (e) { console.warn(e); } }
  state.view = null;
  state.current = mod.id;
  location.hash = `#/${mod.id}`;
  document.querySelectorAll('.nav button').forEach((b) => b.classList.toggle('active', b.dataset.id === mod.id));
  const rootEl = document.getElementById('view-root');
  rootEl.innerHTML = '';
  const loading = el('div', { class: 'mod-loading' }, [el('div', { class: 'spinner' }), el('div', { text: `正在装载 ${mod.title}…` })]);
  rootEl.append(loading);

  const m = await loadModule(mod);
  if (!m || typeof m.mount !== 'function') { rootEl.innerHTML = ''; rootEl.append(notReady(mod, m ? '未导出 mount()' : '模块文件缺失')); return; }
  rootEl.innerHTML = '';
  try {
    await m.mount(rootEl, ctxFor(mod.id));
    state.view = m;
  } catch (err) {
    console.error(err);
    rootEl.innerHTML = '';
    rootEl.append(notReady(mod, err));
  }
}

async function refreshStatus() {
  try {
    const h = await api.get('/api/health');
    state.health = h;
    const box = document.getElementById('status-chips');
    box.innerHTML = '';
    const llmOk = h.llm?.ready;
    const imgOk = h.image?.ready;
    box.append(
      el('span', {
        class: `chip clickable ${llmOk ? 'ok' : 'warn'}`,
        title: '点击进入设置页配置 LLM',
        onclick: () => navigate('settings'),
      }, [`🤖 `, el('b', { text: h.llm?.provider === 'mock' ? '离线模板' : (h.llm?.model || 'LLM') }), llmOk ? ' ✓' : ' 未配置']),
      el('span', {
        class: `chip clickable ${imgOk ? 'ok' : 'warn'}`,
        title: h.image?.note || '',
        onclick: () => navigate('settings'),
      }, [`🖼 `, el('b', { text: h.image?.backend || '出图' }), imgOk ? ' ✓' : ' 未就绪']),
      el('span', { class: 'chip', title: '演员 / 定妆图 / 小说 / 章节 / 剧本 / 镜头' },
        [`📊 `, el('b', { text: `${fmtNum(h.counts?.actors)} 演员` }), ` / ${fmtNum(h.counts?.images)} 图 / ${fmtNum(h.counts?.chapters)} 章 / ${fmtNum(h.counts?.shots)} 镜`]),
      el('span', { class: 'chip', title: '数据目录' }, [el('b', { text: 'v' + h.version })]),
    );
    // 队列暂停横幅（预算/额度自动暂停或人工暂停）：全局可见，一眼能看到「为什么不动了」并一键恢复
    try {
      const ps = await (await fetch('/api/queue/state')).json();
      if (ps?.paused) {
        box.append(el('span', {
          class: 'chip err clickable',
          title: `${ps.reason || '队列已暂停'}\n排队中 ${Object.values(ps.stats || {}).reduce((a, x) => a + (x.pending || 0), 0)} 个任务（未丢失）\n点击恢复队列`,
          onclick: async () => {
            try {
              const r = await (await fetch('/api/queue/resume', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
              if (r?.ok) { location.reload(); } else { alert('恢复失败：' + (r?.error || '未知')); }
            } catch (e) { alert('恢复失败：' + e.message); }
          },
        }, [`⏸ 队列已暂停 `, el('b', { text: ps.auto === false ? '人工' : '预算/额度' }), ' · 点击恢复']));
      }
    } catch { /* 暂停状态读不到不影响主流程 */ }
  } catch (err) {
    document.getElementById('status-chips').innerHTML = '';
    document.getElementById('status-chips').append(el('span', { class: 'chip err' }, ['后端连接失败：' + err.message]));
  }
}

async function bootstrap() {
  injectStyle('app-base', '');
  const app = document.getElementById('app');
  app.innerHTML = '';
  const topbar = el('div', { class: 'topbar' }, [
    el('div', { class: 'brand' }, [
      el('span', { class: 'logo' }, ['🎬']),
      el('div', {}, [el('div', { text: '铭扬漫剧自动化工厂' }), el('small', { text: '明星定妆 → 小说 → 剧本分镜 一体化生产' })]),
    ]),
    el('div', { class: 'nav' }, MODULES.map((m) => el('button', { dataset: { id: m.id }, title: m.desc, onclick: () => navigate(m.id) }, [
      el('span', { text: m.icon }), el('span', { text: m.title }),
    ]))),
    el('div', { class: 'spacer' }),
    el('div', { class: 'status-chips', id: 'status-chips' }, [el('span', { class: 'chip' }, ['连接中…'])]),
  ]);
  const viewRoot = el('div', { class: 'view-root', id: 'view-root' });
  app.append(topbar, viewRoot);

  try { state.meta = await api.get('/api/meta'); }
  catch (e) { console.warn('meta 加载失败', e); }

  refreshStatus();
  setInterval(refreshStatus, 20000);

  if (/^#[^/]/.test(location.hash || '')) location.hash = '#/' + location.hash.slice(1);   // 路由别名：#studio → #/studio
  const hash = (location.hash || '').replace('#/', '');
  await navigate(MODULES.some((m) => m.id === hash) ? hash : 'actors');
}

window.addEventListener('hashchange', () => {
  if (/^#[^/]/.test(location.hash || '')) { location.hash = '#/' + location.hash.slice(1); return; }   // 路由别名：#studio → #/studio
  const id = (location.hash || '').replace('#/', '');
  if (id && id !== state.current) navigate(id);
});

bootstrap();
export { navigate, state, MODULES };
