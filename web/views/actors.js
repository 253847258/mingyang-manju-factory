// 模块1 视图：明星演员宫格矩阵画布 + 明星档案 + 右键生成清单
import { api } from '../lib/api.js';
import { el, toast, confirmDialog, modal, contextMenu, closeContextMenu, fmtNum, fmtDate, injectStyle, select, labeled } from '../lib/ui.js';
// 画布类型筛选与多选批处理（T-402 ②）：判定/文案/确认闸门全部取自 canvas-select 的**纯逻辑**，本视图只做渲染与调用
import {
  KIND_LABELS, BATCH_ACTIONS, SUPPORTED_ACTIONS, TRIPLE_STATES, NODE_FILTER_DIMS,
  normalizeNodeFilter, filterItems, describeNodeFilter, nodeFilterChips,
  planBatch, describeBatchPlan, applyBatchPlan, isMainCanvas,
} from '../lib/canvas-select.js';
// 画布性能纯逻辑（T-105 契约 / T-209 交付）：视口矩形、裁剪口径、LOD 分级、z 序的唯一真源。
// 必须用命名空间导入：本文件模块级已声明 ZOOM_MIN(398)/ZOOM_MAX(399)/clampZoom(400)/visibleItems(4683)，
// 裸命名导入会触发「Identifier '…' has already been declared」SyntaxError（ESM 静态检查），整个画布视图白屏。
import * as perf from '../lib/canvas-perf.js';

let C = null;           // ctx
let rootEl = null;
let S = null;           // 局部状态
let styleInjected = false;

const VIEW_CSS = `
.ac-main { position: relative; }
.ac-cell-badge { position:absolute; font-size:10.5px; padding:1px 5px; border-radius:5px; background:rgba(8,12,20,.72); border:1px solid var(--line); }
.gen-dialog .row { gap: 10px; }
.pill-group { display:flex; flex-wrap:wrap; gap:6px; }
.pill { padding:4px 9px; border-radius:20px; background:var(--panel-2); border:1px solid var(--line); cursor:pointer; font-size:12px; user-select:none; }
.pill:hover { border-color:var(--line-2); }
.pill.on { background:linear-gradient(135deg, rgba(109,140,255,.28), rgba(165,107,255,.22)); border-color:var(--accent); color:#fff; }
.kind-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; }
.kind-card { border:1px solid var(--line); border-radius:10px; padding:9px; cursor:pointer; background:var(--bg-2); transition:.14s; }
.kind-card:hover { border-color:var(--line-2); transform:translateY(-1px); }
.kind-card.on { border-color:var(--accent); background:linear-gradient(135deg, rgba(109,140,255,.16), rgba(165,107,255,.1)); }
.kind-card .t { font-weight:600; display:flex; gap:6px; align-items:center; }
.kind-card .d { font-size:11px; color:var(--muted); margin-top:3px; line-height:1.5; }
.ac-float { position:absolute; right:14px; bottom:14px; z-index:20; display:flex; flex-direction:column; gap:8px; align-items:flex-end; }
.ac-sep { width:1px; height:20px; background:var(--line); margin:0 3px; }
.ac-check { display:inline-flex; align-items:center; gap:5px; font-size:12px; color:var(--muted); cursor:pointer; user-select:none; }
.ac-check input { width:auto; }
.ac-hud { position:absolute; left:12px; top:10px; display:flex; gap:6px; flex-wrap:wrap; pointer-events:none; }
.ac-hud-chip { background:rgba(10,14,22,.8); border:1px solid var(--line); border-radius:20px; padding:3px 9px; font-size:11.5px; color:var(--muted); font-family:var(--mono); }
.ac-hud-chip.on { border-color:var(--accent); color:#c3d0ff; }
.ac-arrange-box .pill, #ac-arrange-box .pill { padding:4px 9px; font-size:12px; }
#ac-canvas-picker select { background:var(--bg-2); }
.ac-minimap { position:absolute; right:14px; bottom:44px; width:208px; height:140px; border:1px solid var(--line-2); border-radius:10px; background:rgba(8,12,20,.92); box-shadow:var(--shadow); cursor:crosshair; z-index:12; }
.ac-minimap.hidden { display:none; }
.ac-zoombar { position:absolute; left:12px; bottom:44px; display:flex; align-items:center; gap:2px; background:rgba(10,14,22,.9); border:1px solid var(--line); border-radius:24px; padding:3px; z-index:12; }
.ac-zoom-btn { background:transparent; border:none; color:var(--muted); width:28px; height:26px; border-radius:20px; cursor:pointer; font-size:14px; line-height:1; }
.ac-zoom-btn:hover { background:var(--panel-3); color:var(--text); }
.ac-zoom-val { background:transparent; border:none; color:#c3d0ff; min-width:54px; height:26px; border-radius:20px; cursor:pointer; font-family:var(--mono); font-size:12px; }
.ac-zoom-val:hover { background:var(--panel-3); }
.ac-align-bar { position:absolute; left:50%; transform:translateX(-50%); bottom:44px; display:flex; align-items:center; gap:4px; background:rgba(10,14,22,.92); border:1px solid var(--line-2); border-radius:22px; padding:4px 10px; z-index:13; box-shadow:var(--shadow); }
.ac-align-bar.hidden { display:none; }
.job-mini { background:rgba(18,26,40,.95); border:1px solid var(--line-2); border-radius:10px; padding:8px 10px; min-width:250px; box-shadow:var(--shadow); }
/* 节点内联编辑（双击流程/资产/便签节点）：画布本体是 <canvas>，文字无法就地编辑，
   所以在 .ac-canvas-wrap 里浮一个真实输入框，位置随视口同步（见 syncInlineEdit） */
.ac-inline-edit { position:absolute; z-index:26; box-sizing:border-box; padding:4px 8px; border-radius:8px; border:1px solid var(--accent); background:rgba(8,12,20,.96); color:#eef3ff; font-family:var(--sans); line-height:1.3; box-shadow:0 8px 24px rgba(0,0,0,.55); outline:none; resize:none; }
.ac-inline-edit:focus { border-color:#fff; box-shadow:0 0 0 2px rgba(109,140,255,.35), 0 8px 24px rgba(0,0,0,.55); }
`;

export function unmount() {
  if (S) {
    S.imgObserver?.disconnect?.();
    if (S.resizeObs) S.resizeObs.disconnect();
    if (S.jobTimers) for (const t of S.jobTimers) t();
    if (S.onKeyDown) window.removeEventListener('keydown', S.onKeyDown);
    clearTimeout(viewSaveTimer);
    try { delete window.__acDebug; } catch { /* ignore */ }
    if (S.onMouseUp) window.removeEventListener('mouseup', S.onMouseUp);
    if (S.raf) cancelAnimationFrame(S.raf);
    // 内联编辑框是挂在 .ac-canvas-wrap 上的额外 DOM：先清状态再摘除，避免 remove 触发的 blur 回写
    if (S.editing) { const edEl = S.editing.el; S.editing = null; try { edEl?.remove(); } catch { /* ignore */ } }
  }
  closeContextMenu();
  S = null; C = null; rootEl = null;
}

export async function mount(root, ctx) {
  C = ctx; rootEl = root;
  if (!styleInjected) { injectStyle('actors-view', VIEW_CSS); styleInjected = true; }

  S = {
    actors: [], selection: new Set(), selectedOrder: [], nodes: new Map(), zoom: 1, panX: 0, panY: 0,
    mode: 'matrix', cols: 5, cell: 210, gap: 14, canvasId: 'CV-MAIN',
    imgCache: new Map(), filter: '', styleFilter: '', kindTab: 'all', currentActor: null, clipDrag: null,
    dragging: null, jobs: [], jobTimers: [], hover: null,
    // 画布增强状态
    canvases: [], layout: {}, groups: [], snap: true, showGroups: true, moveMode: false,
    view: {}, links: [], gridSize: 40, showMinimap: true, showLinks: true,
    groupFrames: [], selectedGroup: null, selectedNote: null, selectedExtra: null, selectedLink: null,
    assetNodes: [], linking: null, linkingSticky: null, hoverPort: null,
    findQuery: '', findHits: [], findIdx: -1,   // 画布内查找：命中节点 id 列表与游标
    undoStack: [], redoStack: [], clipboard: null,
    marquee: null, guides: [], spaceDown: false, dirty: false, lastFit: false,
    // T-L3 ①：内联编辑态（{id, kind, el, orig, canvasId}）；null = 未在编辑
    editing: null,
    // T-L3 ②：类型筛选偏好（随画布持久化到 layout.view.filter）；null/默认态 = 不限
    kindFilter: null,
  };

  root.append(buildLayout());
  await Promise.all([loadActors(), loadCanvasList(), loadCanvas()]);
  renderList();
  resizeCanvas();
  S.resizeObs = new ResizeObserver(() => resizeCanvas());
  S.resizeObs.observe(root.querySelector('.ac-canvas-wrap'));
  bindKeyboard();

  // 只读调试钩子（自动化审计用；不修改任何状态）
  window.__acDebug = () => ({
    zoom: S?.zoom ?? null, panX: S?.panX ?? null, panY: S?.panY ?? null,
    mode: S?.mode ?? null, lod: S ? lodLevel() : null, bg: S?.view?.bg ?? null,
    gridSize: S?.view?.gridSize ?? null, snap: S?.snap ?? null,
    showMinimap: S?.showMinimap ?? null, showLinks: S?.showLinks ?? null,
    selection: S ? [...S.selection] : [], order: S?.selectedOrder ?? [],
    items: S?._layout?.items?.length ?? 0, drawn: S?._drawn ?? 0,
    links: S?.links?.length ?? 0, groups: S?.groups?.length ?? 0,
    nodes: S ? [...S.nodes.entries()].map(([id, n]) => ({ id, x: n.x, y: n.y, locked: n.locked || 0 })) : [],
    imgCache: S?.imgCache?.size ?? 0, imgLoaded: S ? [...S.imgCache.values()].filter((r) => r.ok).length : 0,
    canvases: S?.canvases?.length ?? 0, canvasId: S?.canvasId ?? null, showAll: S?.showAll ?? null,
    groups: S?.groupFrames?.length ?? 0, groupList: (S?.groupFrames || []).map((g) => ({ id: g.id, name: g.name, x: g.x, y: g.y, w: g.w, h: g.h, collapsed: g.collapsed })),
    notes: S?.noteNodes?.length ?? 0, noteList: (S?.noteNodes || []).map((n) => ({ id: n.id, x: n.x, y: n.y, w: n.w, h: n.h, text: n.note_text, color: n.note_color })),
    assets: (S?.assetNodes || []).map((n) => ({ id: n.id, kind: n.kind, title: n.title, x: n.x, y: n.y, w: n.w, h: n.h, refs: (n.asset?.refImages || []).length })),
    linkList: (S?.links || []).map((l) => ({ id: l.id, from: l.from_node, to: l.to_node, label: l.label, from_side: l.from_side, to_side: l.to_side, from_port: l.from_port || null, to_port: l.to_port || null, slot: l.slot ?? 0 })),
    selectedLink: S?.selectedLink ?? null, selectedExtra: S?.selectedExtra ?? null, linkingSticky: S?.linkingSticky ?? null,
    panning: Boolean(S?.panning), marquee: Boolean(S?.marquee),
    // T-L3 ①：内联编辑态（自动化验证用；不含输入框 DOM，只报 id/kind）
    editing: S?.editing ? { id: S.editing.id, kind: S.editing.kind } : null,
    // T-L3 ②：类型筛选偏好（active=是否偏离「不限」；dims=生效维度名；spec=归一化后的筛选规格）
    filter: S ? (() => {
      const spec = nodeFilterSpec();
      const dims = activeFilterDims(spec);
      return { active: dims.length > 0, dims, spec };
    })() : null,
    ports: (S?._layout?.items || []).map((it) => ({ id: it.id, kind: it.kind || 'actor', right: portPoint(it, 'right', 0), left: portPoint(it, 'left', 0) })),
    // P2 类型化端口：每个端口名的世界坐标（审计用精确点击拖拽建立数据流边）
    typedPorts: (S?._layout?.items || []).map((it) => ({
      id: it.id, kind: it.kind || 'actor',
      ports: Object.fromEntries([
        ...portsOf(it).out.map((p) => [p, portPointAt(it, 'right', portsOf(it).out.indexOf(p), portsOf(it).out.length)]),
        ...portsOf(it).in.map((p) => [p, portPointAt(it, 'left', portsOf(it).in.indexOf(p), portsOf(it).in.length)]),
      ]),
    })),
    edgePorts: (S?.links || []).map((l) => ({ id: l.id, from_port: l.from_port || null, to_port: l.to_port || null, slot: l.slot ?? 0 })),
    portNames: NODE_KINDS,
    findSet: (q, step = 0) => { S.findQuery = String(q || '').trim(); return findJump(step); },
    find: { query: S?.findQuery || '', hits: (S?.findHits || []).length, ids: S?.findHits || [], idx: S?.findIdx ?? -1 },
    undoDepth: S?.undoStack?.length ?? 0, redoDepth: S?.redoStack?.length ?? 0,
    selectedGroup: S?.selectedGroup ?? null, selectedNote: S?.selectedNote ?? null,
    clipboard: S?.clipboard ? { kind: S.clipboard.kind, n: (S.clipboard.items || []).length } : null,
    clipDrag: S?.clipDrag ? { nodeId: S.clipDrag.nodeId, from: S.clipDrag.from, to: S.clipDrag.to } : null,
    clipTracks: (S?._layout?.items || []).filter((it) => it.clipRects?.length).map((it) => ({
      nodeId: it.id, rect: it.clipRect || null,
      clips: (it.clipRects || []).map((r) => ({ index: r.index, linkId: r.linkId, title: r.title, file: r.file, hasFile: Boolean(r.file), x: r.x, w: r.w })),
    })),
    worldAt: (clientX, clientY) => { const w = toWorld(clientX, clientY); return { x: w.x, y: w.y }; },
    // 世界坐标 → 屏幕坐标（审计用：把类型化端口的精确坐标换算成可点击的页面坐标）
    screenAt: (wx, wy) => {
      const cv = canvasEl(); if (!cv) return { x: 0, y: 0 };
      const r = cv.getBoundingClientRect();
      return { x: r.left + (wx + S.panX) * S.zoom, y: r.top + (wy + S.panY) * S.zoom };
    },
    // 卡片中心的世界坐标与屏幕坐标（供自动化审计精确点击）
    screenItems: () => {
      const cv = canvasEl();
      if (!cv) return [];
      const r = cv.getBoundingClientRect();
      return (S?._layout?.items || []).map((it) => ({
        id: it.id, actorId: it.actorId || null, kind: it.kind || 'actor', name: it.actor.name,
        wx: it.x, wy: it.y, w: it.w, h: it.h, z: it.kind === 'note' ? (it.note?.z || 0) : (it.node?.z || 0), groupId: it.groupId || null,
        cx: r.left + (it.x + S.panX) * S.zoom + (it.w * S.zoom) / 2,
        cy: r.top + (it.y + S.panY) * S.zoom + (it.h * S.zoom) / 2,
        rightPort: { x: r.left + (it.x + it.w + 6 / S.zoom + S.panX) * S.zoom, y: r.top + (it.y + it.h / 2 + S.panY) * S.zoom },
        leftPort: { x: r.left + (it.x - 6 / S.zoom + S.panX) * S.zoom, y: r.top + (it.y + it.h / 2 + S.panY) * S.zoom },
      }));
    },
  });
  requestAnimationFrame(draw);
  S.imgObserver = null;
}

// ---------------- 布局 ----------------
function buildLayout() {
  const side = el('div', { class: 'ac-side' }, [
    el('div', { class: 'ac-side-head' }, [
      el('div', { class: 'row' }, [
        el('div', { class: 'grow', style: { fontWeight: '600' } }, ['🎭 演员阵容']),
        el('button', { class: 'btn sm primary', onclick: () => openActorEditor(null) }, ['+ 新建']),
      ]),
      el('div', { class: 'row' }, [
        el('input', { type: 'text', placeholder: '搜索姓名 / ID / 标签…', oninput: (e) => { S.filter = e.target.value.trim(); renderList(); } }),
      ]),
      el('div', { class: 'row', id: 'ac-style-filter' }),
      el('div', { class: 'small muted', id: 'ac-count' }, ['—']),
    ]),
    el('div', { class: 'ac-list', id: 'ac-list' }),
  ]);

  const toolbar = el('div', { class: 'ac-toolbar' }, [
    el('button', { class: 'btn sm', onclick: () => openActorEditor(null) }, ['➕ 新建演员']),
    el('div', { class: 'row', style: { gap: '4px' }, id: 'ac-canvas-picker' }),
    el('button', { class: 'btn sm', onclick: () => newCanvasDialog() }, ['🗂 新建画布']),
    el('button', { class: 'btn sm', id: 'ac-delcanvas', title: '删除当前画布（含其卡位与关系线；主画布不可删除）', onclick: () => deleteCurrentCanvas() }, ['🗑 删除画布']),
      el('button', { class: 'btn sm', id: 'ac-find', title: '画布内查找节点（Ctrl+F）：按标题/类型/演员名匹配，命中的节点高亮并自动居中', onclick: () => findDialog() }, ['🔍 查找']),
      el('button', { class: 'btn sm', id: 'ac-gorender', title: '去制作台：把分镜推进到关键帧 → 视频 → 整集成片（画布负责资产精修，制作台负责批量出片）', onclick: () => C.go('render') }, ['🎞 去制作台']),
    el('span', { class: 'ac-sep' }),
    el('div', { class: 'row', style: { gap: '4px' }, id: 'ac-canvas-ops' }, [
      el('button', { class: 'btn xs', id: 'ac-putall', title: '把演员表里的全部演员放入本画布（宫格）', onclick: () => putAllActors() }, ['⊕ 放入全部']),
      el('button', { class: 'btn xs', title: '清空本画布卡位（不删除演员与素材）', onclick: () => clearCurrentCanvas() }, ['⌀ 清空本画布']),
      el('span', { class: 'ac-sep' }),
      el('button', { class: 'btn xs', title: '把选中卡片组成分组（Ctrl+G）', onclick: () => groupSelected() }, ['🗂 成组']),
      el('button', { class: 'btn xs', title: '新建便签', onclick: () => addNote() }, ['📝 便签']),
      el('button', { class: 'btn xs', title: '新建环境节点（场景/地点）', onclick: () => addAsset('scene') }, ['🏞 环境']),
      el('button', { class: 'btn xs', title: '新建物品节点（道具/信物）', onclick: () => addAsset('item') }, ['🗝 物品']),
      el('button', { class: 'btn xs', title: '新建参考图节点（可上传多图矩阵）', onclick: () => addAsset('refimg') }, ['🖼 参考图']),
      el('button', { class: 'btn xs', title: '批量上传图片生成参考图矩阵', onclick: () => refMatrixDialog() }, ['🧩 参考图矩阵']),
      el('button', { class: 'btn xs accent', id: 'ac-sheet', title: '九宫格：人物=定妆+三视角+三表情+服饰+手部；环境=视角×时段。生成 9 张独立图并自动拼成一张 3×3 设定表，人物默认设为主参考图', onclick: () => sheetDialog() }, ['🔲 九宫格']),
      el('button', { class: 'btn xs', id: 'ac-describe', title: '描述自动改进：为选中的角色/环境/物品生成更专业的设定描述，先预览再确认，可撤销', onclick: () => describeDialog() }, ['✨ 描述改进']),
      el('button', { class: 'btn xs', id: 'ac-consistency', title: '一致性体检：对画布上的演员/环境图片做感知哈希离群检测，低分节点标红，可一键重跑（锁定节点跳过）', onclick: () => consistencyDialog() }, ['📐 一致性']),
      el('button', { class: 'btn xs', id: 'ac-audio', title: '新建音频节点（配音 / 音乐 / 音效）：拉到视频节点的 dub 端口即成为该镜配音，拉到成片节点的 bgm 端口即成为整片背景乐', onclick: () => audioNodeDialog() }, ['🔊 音频']),
      el('button', { class: 'btn xs', id: 'ac-flow', title: '手工创建流程节点（关键帧 / 视频片段 / 文本 / 成片时间线 / 交付终点），可自己连线搭出工作流', onclick: (ev) => flowNodeMenu(ev) }, ['➕ 流程节点']),
      el('button', { class: 'btn xs', id: 'ac-snapshots', title: '画布快照：给整张画布打命名快照 / 看差异 / 一键回滚（破坏性操作前会自动留档）', onclick: () => snapshotsDialog() }, ['📸 快照']),
      el('button', { class: 'btn xs accent', id: 'ac-claw', title: 'Claw 指令：一句话操作画布（状态 / 计划 / 按技能铺开 / 续写 / 补尾帧）——只读与建图类直接做，花钱的动作只出计划交人工闸门', onclick: () => clawDialog() }, ['🤖 Claw 指令']),
      el('span', { class: 'ac-sep' }),
      el('button', { class: 'btn xs accent', id: 'ac-compose', title: '用选中的节点组合出图（演员 × 环境 × 物品 × 参考图，自动带上连线关联的节点）', onclick: () => composeDialog() }, ['⚡ 组合出图']),
      el('span', { class: 'ac-sep' }),
      // P5 流程：分镜铺开 → 时间线成片 → 交付；P3 计划（dry-run）→ 人工确认后执行
      el('button', { class: 'btn xs', id: 'ac-kind-filter', title: '类型筛选：按节点类型/分组/有无产物/是否失败/是否锁定做五维筛选，命中项一键选中并可框入视口（只筛选与选中，不删任何节点）', onclick: () => kindFilterDialog() }, ['🔎 类型筛选']),
      el('button', { class: 'btn xs', id: 'ac-batch-select', title: '多选批处理：对当前选区批量移动/缩放/成组/锁定/移出画布/按类型重跑 —— 危险动作走二次确认，付费重跑只出计划交人工批准', onclick: () => batchSelectDialog() }, ['⇄ 多选批处理']),
      el('button', { class: 'btn xs', id: 'ac-spread', title: '把某一集的分镜铺到画布（建分镜容器 + 视频节点 + clip1..N 连线 + 成片节点；只布局不生成）', onclick: () => spreadEpisodeDialog() }, ['🎞 铺开分集']),
      el('button', { class: 'btn xs', id: 'ac-plan', title: '生成画布执行计划（dry-run：会跑哪些节点、要花多少钱、哪些可跳过），确认后才执行', onclick: () => planDialog() }, ['🧭 执行计划']),
      el('span', { class: 'ac-sep' }),
      el('button', { class: 'btn xs', title: '撤销（Ctrl+Z）', onclick: () => undo() }, ['↶']),
      el('button', { class: 'btn xs', title: '重做（Ctrl+Shift+Z）', onclick: () => redo() }, ['↷']),
      el('button', { class: 'btn xs', title: '统一选中卡片尺寸', onclick: () => uniformSize() }, ['📐 统一尺寸']),
    ]),
    el('span', { class: 'ac-sep' }),
    el('div', { class: 'row ac-arrange-box', style: { gap: '4px' }, id: 'ac-arrange-box' }, [
      el('span', { class: 'small muted' }, ['排布']),
      el('button', { class: 'btn xs', title: '按当前列数重排宫格', onclick: () => autoArrange('matrix') }, ['▦ 宫格']),
      el('button', { class: 'btn xs', title: '按画风生成分组框', onclick: () => autoGroup('style_id') }, ['🎨 画风组']),
      el('button', { class: 'btn xs', title: '按角色类型生成分组框', onclick: () => autoGroup('role_type') }, ['🎭 角色组']),
      el('button', { class: 'btn xs', title: '按种族生成分组框', onclick: () => autoGroup('race') }, ['🧬 种族组']),
    ]),
    el('span', { class: 'small muted' }, ['列数']),
    el('input', { type: 'number', value: 5, min: 1, max: 12, style: { width: '58px' }, onchange: (e) => { S.cols = Math.max(1, Math.min(12, +e.target.value || 5)); saveCanvas(); relayoutMatrix(); draw(); } }),
    el('span', { class: 'small muted' }, ['格宽']),
    el('input', { type: 'number', value: 210, min: 90, max: 460, step: 10, style: { width: '64px' }, onchange: (e) => { S.cell = +e.target.value || 210; saveCanvas(); relayoutMatrix(); draw(); } }),
    el('span', { class: 'ac-sep' }),
    el('button', { class: 'btn sm', id: 'ac-mode-btn', onclick: () => toggleMode() }, ['🔀 宫格模式']),
    el('label', { class: 'ac-check', title: '自由拖拽时按网格吸附，并显示对齐参考线' }, [
      el('input', { type: 'checkbox', checked: true, onchange: (e) => { S.snap = e.target.checked; draw(); } }),
      el('span', { text: '吸附' }),
    ]),
    el('div', { class: 'row', style: { gap: '4px' }, id: 'ac-bg-picker' }),
    el('label', { class: 'ac-check', title: '显示小地图' }, [
      el('input', { type: 'checkbox', checked: true, onchange: (e) => { S.showMinimap = e.target.checked; scheduleViewSave(); draw(); } }),
      el('span', { text: '小地图' }),
    ]),
    el('label', { class: 'ac-check', title: '显示关系连线' }, [
      el('input', { type: 'checkbox', checked: true, onchange: (e) => { S.showLinks = e.target.checked; scheduleViewSave(); draw(); } }),
      el('span', { text: '连线' }),
    ]),
    el('span', { class: 'spacer', style: { flex: 1 } }),
    el('button', { class: 'btn sm', title: '适应窗口（F）', onclick: () => fitView() }, ['⤢ 适应']),
    el('button', { class: 'btn sm', onclick: () => zoomBy(1.15) }, ['🔍+']),
    el('button', { class: 'btn sm', onclick: () => zoomBy(0.87) }, ['🔍−']),
    el('button', { class: 'btn sm', onclick: () => resetView() }, ['⟲ 复位']),
    el('button', { class: 'btn sm', title: '把当前画布导出为 PNG 阵容图', onclick: () => exportCanvasPNG() }, ['🖼 导出图']),
    el('button', { class: 'btn sm accent', id: 'ac-batch', onclick: () => batchGenerateDialog() }, ['⚡ 批量生成 (0)']),
    el('button', { class: 'btn sm', onclick: () => loadAll() }, ['↻ 刷新']),
  ]);

  const canvasWrap = el('div', { class: 'ac-canvas-wrap' }, [
    el('canvas', { id: 'ac-canvas' }),
    el('div', { class: 'ac-empty', id: 'ac-empty' }),
    el('div', { class: 'ac-hud', id: 'ac-hud' }),
    el('canvas', { class: 'ac-minimap', id: 'ac-minimap', title: '小地图：点击或拖拽跳转视口' }),
    el('div', { class: 'ac-zoombar', id: 'ac-zoombar' }, [
      el('button', { class: 'ac-zoom-btn', title: '缩小（-）', onclick: () => zoomBy(0.82) }, ['−']),
      el('button', { class: 'ac-zoom-val', title: '点击恢复 100%（0）', onclick: () => resetView() }, ['100%']),
      el('button', { class: 'ac-zoom-btn', title: '放大（+）', onclick: () => zoomBy(1.22) }, ['＋']),
      el('button', { class: 'ac-zoom-btn', title: '适应窗口（F）', onclick: () => fitView() }, ['⤢']),
      el('button', { class: 'ac-zoom-btn', title: '缩放到选中（Ctrl+2）', onclick: () => zoomToSelection() }, ['▣']),
    ]),
    el('div', { class: 'ac-align-bar hidden', id: 'ac-align-bar' }, [
      el('span', { class: 'small muted' }, ['对齐']),
      el('button', { class: 'btn xs', title: '左对齐', onclick: () => alignSelection('left') }, ['⇤']),
      el('button', { class: 'btn xs', title: '水平居中', onclick: () => alignSelection('center-x') }, ['↔']),
      el('button', { class: 'btn xs', title: '右对齐', onclick: () => alignSelection('right') }, ['⇥']),
      el('button', { class: 'btn xs', title: '顶对齐', onclick: () => alignSelection('top') }, ['⇡']),
      el('button', { class: 'btn xs', title: '垂直居中', onclick: () => alignSelection('center-y') }, ['↕']),
      el('button', { class: 'btn xs', title: '底对齐', onclick: () => alignSelection('bottom') }, ['⇣']),
      el('span', { class: 'ac-sep' }),
      el('span', { class: 'small muted' }, ['分布']),
      el('button', { class: 'btn xs', title: '水平等距分布', onclick: () => distributeSelection('x') }, ['⇹ 横向']),
      el('button', { class: 'btn xs', title: '垂直等距分布', onclick: () => distributeSelection('y') }, ['⇳ 纵向']),
    ]),
    el('div', { class: 'ac-hint' }, [
      '无限画布：滚轮/触控板缩放（5%–800%，以光标为中心）· 空格/中键/双指拖动平移 · 空白框选 · 双击空白=在光标处新建演员 · 右键=生成清单/连线 · F 适应 · Ctrl+2 缩放到选区',
    ]),
  ]);

  const main = el('div', { class: 'ac-main' }, [toolbar, canvasWrap, el('div', { class: 'ac-float', id: 'ac-float' })]);
  const wrap = el('div', { class: 'ac-layout' }, [side, main]);
  const drawer = el('div', { class: 'drawer', id: 'ac-drawer' });
  const container = el('div', { style: { height: '100%', position: 'relative' } }, [wrap, drawer]);

  setTimeout(() => bindCanvasEvents(), 0);
  return container;
}

// ---------------- 数据 ----------------
async function loadAll() { await Promise.all([loadActors(), loadCanvas()]); renderList(); draw(); }

async function loadActors() {
  const r = await api.get('/api/actors');
  S.actors = r.actors || [];
  updateStyleFilter();
  updateCount();
}

let viewSaveTimer = null;
function scheduleViewSave() {
  clearTimeout(viewSaveTimer);
  viewSaveTimer = setTimeout(() => {
    if (!S) return;                       // 视图已卸载（切换模块）时定时器可能仍会触发
    api.put('/api/canvas/viewport', {
      id: S.canvasId, zoom: S.zoom, panX: S.panX, panY: S.panY,
      bg: S.view?.bg, gridSize: S.view?.gridSize, snap: S.snap,
      showMinimap: S.showMinimap, showLinks: S.showLinks,
    }).catch(() => {});
  }, 600);
}

async function loadCanvas() {
  const r = await api.get('/api/canvas?id=' + S.canvasId);
  const c = r.canvas;
  S.links = c.links || [];
  S.groupFrames = c.groups || [];
  S.cols = c.cols || 5; S.cell = c.cell_size || 210;
  S.gap = c.layout?.gap ?? S.gap;
  S.layout = c.layout || {};
  S.showAll = S.layout.showAll !== false;
  // 老数据兼容：历史「分组排布」写的是 layout.mode='group'，等价于自由排布 + 真实分组框
  if (S.layout.mode === 'group') S.mode = 'free';
  S.nodes = new Map((c.nodes || []).filter((n) => (n.kind || 'actor') === 'actor' && n.actor_id).map((n) => [n.actor_id, n]));
  S.noteNodes = (c.nodes || []).filter((n) => n.kind === 'note');
  S.assetNodes = (c.nodes || []).filter((n) => ['scene', 'item', 'refimg'].includes(n.kind));
  // P5 流程节点：分镜容器 / 视频片段 / 成片时间线（与资产节点同一套渲染与命中，只是内容不同）
  S.flowNodes = (c.nodes || []).filter((n) => FLOW_KINDS.includes(n.kind));
  // 恢复该画布上次的视图状态（无限画布：缩放/平移/背景随画布保存）
  const v = (c.layout && c.layout.view) || {};
  S.view = v;
  if (typeof v.zoom === 'number') S.zoom = clampZoom(v.zoom);
  if (typeof v.panX === 'number') S.panX = v.panX;
  if (typeof v.panY === 'number') S.panY = v.panY;
  if (typeof v.gridSize === 'number') S.gridSize = v.gridSize;
  if (typeof v.snap === 'boolean') S.snap = v.snap;
  if (typeof v.showMinimap === 'boolean') S.showMinimap = v.showMinimap;
  if (typeof v.showLinks === 'boolean') S.showLinks = v.showLinks;
  // T-L3 ②：类型筛选偏好存在同一块视图偏好里（layout.view.filter），因此主画布与其它画布各自独立。
  // filterSaveFor === 本画布 表示这次筛选刚改、还没落库：以内存态为准，避免读回旧值把用户的选择冲掉。
  if (filterSaveFor !== S.canvasId) S.kindFilter = v.filter ? normalizeNodeFilter(v.filter) : null;
  // 内联编辑的归属画布变了（切换画布）：先按既有口径把编辑内容写回去，不静默丢弃用户输入
  if (S.editing && S.editing.canvasId !== c.id) endInlineEdit(true);
  renderBgPicker();
  const tb = rootEl?.querySelector('.ac-toolbar');
  if (tb) { tb.querySelectorAll('input[type=number]')[0].value = S.cols; tb.querySelectorAll('input[type=number]')[1].value = S.cell; }
  updateModeButton();
}

async function saveCanvas() {
  try { await api.put('/api/canvas', { id: S.canvasId, cols: S.cols, cell_size: S.cell }); } catch (e) { /* 忽略 */ }
}

// T-L3 ②：类型筛选偏好的持久化。
// 存在该画布的 layout.view.filter（与缩放/平移同一块视图偏好），刷新与切画布后都能恢复。
// 为什么不用 /api/canvas/viewport：后端 saveViewport 只认 zoom/panX/panY/bg/gridSize/snap/showLinks/
// showMinimap/lod 白名单，自造的 filter 字段会被丢弃；所以照抄文件里既有的另一种画布写入方式
// （saveCanvas 用的 PUT /api/canvas）。先读回最新 layout 再合并，避免覆盖 saveViewport 刚写的缩放/平移。
let filterSaveFor = null;      // 正在保存筛选偏好的画布 id（保存期间 loadCanvas 不回滚内存态）
async function saveFilterPref() {
  if (!S) return null;
  const canvasId = S.canvasId;
  const spec = nodeFilterSpec();
  filterSaveFor = canvasId;
  try {
    const r = await api.get('/api/canvas?id=' + canvasId);
    if (!S || S.canvasId !== canvasId) return null;      // 期间切了画布：这次写入作废（新画布自己有偏好）
    const layout = r?.canvas?.layout || S.layout || {};
    const view = { ...(layout.view || {}), filter: spec };
    await api.put('/api/canvas', { id: canvasId, layout: { ...layout, view } });
    if (S && S.canvasId === canvasId) S.layout = { ...layout, view };
    return view;
  } catch (e) {
    return null;      // 偏好保存失败不影响筛选本身（内存态照常生效）
  } finally {
    if (filterSaveFor === canvasId) filterSaveFor = null;
  }
}

function updateStyleFilter() {
  const box = rootEl.querySelector('#ac-style-filter');
  if (!box) return;
  box.innerHTML = '';
  const styles = C.meta?.styles || [];
  box.append(select([{ id: '', name: '全部画风' }, ...styles.map((s) => ({ id: s.id, name: s.name }))], S.styleFilter, (v) => { S.styleFilter = v; renderList(); }));
}

function filteredActors() {
  return S.actors.filter((a) => {
    if (S.styleFilter && a.style_id !== S.styleFilter) return false;
    if (!S.filter) return true;
    const hay = `${a.id} ${a.name} ${a.alias || ''} ${a.tags || ''} ${a.role_type || ''}`.toLowerCase();
    return hay.includes(S.filter.toLowerCase());
  });
}

function updateCount() {
  const c = rootEl.querySelector('#ac-count');
  if (c) c.textContent = `共 ${S.actors.length} 位演员 · 已选 ${S.selection.size} 位`;
  const b = rootEl.querySelector('#ac-batch');
  if (b) b.textContent = `⚡ 批量生成 (${S.selection.size})`;
}

function renderList() {
  const list = rootEl.querySelector('#ac-list');
  if (!list) return;
  list.innerHTML = '';
  const items = filteredActors();
  if (!items.length) {
    list.append(el('div', { class: 'small muted', style: { padding: '10px' } }, ['还没有演员。点击「+ 新建」创建第一位明星。']));
    return;
  }
  for (const a of items) {
    const cover = a.primary_image?.file_path;
    const item = el('div', {
      class: `ac-item${S.currentActor === a.id ? ' active' : ''}`,
      draggable: 'true',
      title: '可拖到画布上放置/归入分组',
      ondragstart: (e) => { e.dataTransfer.setData('text/plain', a.id); e.dataTransfer.effectAllowed = 'copyMove'; },
      onclick: (e) => { if (e.ctrlKey || e.shiftKey) toggleSelect(a.id); else { selectOnly(a.id); } updateCount(); renderList(); draw(); }, ondblclick: () => openProfile(a.id), oncontextmenu: (e) => { e.preventDefault(); if (!S.selection.has(a.id)) selectOnly(a.id); updateCount(); draw(); actorContextMenu(e.clientX, e.clientY, [...S.selection]); } }, [
      cover ? el('img', { class: 'av', src: api.fileUrl(cover), loading: 'lazy' }) : el('div', { class: 'av' }, [(a.name || '?').slice(0, 1)]),
      el('div', { class: 'meta' }, [
        el('div', { class: 'nm', text: a.name }),
        el('div', { class: 'sub' }, [`${a.id} · ${a.image_count || 0} 图`]),
      ]),
    ]);
    list.append(item);
  }
  updateCount();
}


// ---------------- 画布（渲染 + 交互核心） ----------------
const ZOOM_MIN = 0.05;
const ZOOM_MAX = 8;
const clampZoom = (z) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
/** 1-2-5 序列，用于无限画布的自适应网格间距 */
function niceStep(base) {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(base, 1e-6))));
  const n = base / p;
  const m = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return m * p;
}
/** 按缩放级别决定渲染细节（LOD）：块 → 缩略图 → 完整信息（阈值与判定取自 canvas-perf，单一真源） */
function lodLevel() {
  return perf.lodLevelFor(S.zoom);
}

function canvasEl() { return rootEl?.querySelector('#ac-canvas'); }

function resizeCanvas() {
  const cv = canvasEl();
  if (!cv) return;
  const wrap = cv.parentElement;
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.max(10, Math.round(wrap.clientWidth * dpr));
  cv.height = Math.max(10, Math.round(wrap.clientHeight * dpr));
  cv.dataset.dpr = String(dpr);
  draw();
}

const toWorld = (clientX, clientY) => {
  const cv = canvasEl(); if (!cv) return { x: 0, y: 0 };
  const r = cv.getBoundingClientRect();
  return { x: (clientX - r.left) / S.zoom - S.panX, y: (clientY - r.top) / S.zoom - S.panY };
};

/** 计算画布布局：宫格模式按顺序排，自由模式用持久化坐标；返回可视 bounds 与分组标题 */
function computeLayout() {
  const all = filteredActors();
  // 画布语义：showAll=true（主画布默认）= 宫格预览全部演员；false（新建画布）= 只显示已放入的卡片
  const list = S.showAll === false ? all.filter((a) => S.nodes.has(a.id)) : all;
  // 折叠的分组：其成员不参与绘制与命中
  const collapsedGroups = new Set((S.groupFrames || []).filter((g) => g.collapsed).map((g) => g.id));
  const hiddenByGroup = new Set();
  for (const [actorId, n] of S.nodes.entries()) {
    if (n.group_id && collapsedGroups.has(n.group_id)) hiddenByGroup.add(actorId);
  }
  const items = [];
  const gap = S.gap;
  list.forEach((a, i) => {
    if (hiddenByGroup.has(a.id)) return;
    const node = S.nodes.get(a.id);
    let x; let y;
    if (S.mode === 'matrix' || !node) {
      const col = i % S.cols;
      const row = Math.floor(i / S.cols);
      x = 20 + col * (S.cell + gap);
      y = 20 + row * (S.cell + gap);
    } else { x = node.x; y = node.y; }
    items.push({
      // id = 画布节点 id（连线命中/端口都以节点 id 为准）；actorId = 演员 id
      id: node?.id || `actor:${a.id}`, actorId: a.id,
      actor: a, index: i, x, y, w: node?.w || S.cell, h: node?.h || S.cell, node,
      locked: Boolean(node?.locked), groupId: node?.group_id || null, kind: 'actor',
    });
  });
  // 便签 / 环境 / 物品 / 参考图节点（自由画布元素，与演员无关）
  for (const n of (S.noteNodes || [])) {
    if (collapsedGroups.size && n.group_id && collapsedGroups.has(n.group_id)) continue;
    items.push({
      kind: 'note', note: n, id: n.id, actorId: null, x: n.x, y: n.y, w: n.w || 240, h: n.h || 160,
      locked: Boolean(n.locked), groupId: n.group_id || null, z: n.z || 0,
      actor: { id: n.id, name: n.note_text ? n.note_text.split('\n')[0].slice(0, 20) : '便签', style_id: 'note' },
    });
  }
  for (const n of [...(S.assetNodes || []), ...(S.flowNodes || [])]) {
    if (collapsedGroups.size && n.group_id && collapsedGroups.has(n.group_id)) continue;
    const a = n.asset || {};
    items.push({
      kind: n.kind, node: n, asset: a, id: n.id, actorId: null, x: n.x, y: n.y,
      w: n.w || 260, h: n.h || 220, locked: Boolean(n.locked), groupId: n.group_id || null, z: n.z || 0,
      actor: { id: n.id, name: n.title || n.kind, style_id: n.kind },
    });
  }
  const groups = S.showGroups ? (S.groupFrames || []) : [];
  const bounds = items.reduce((b, it) => ({
    minX: Math.min(b.minX, it.x), minY: Math.min(b.minY, it.y),
    maxX: Math.max(b.maxX, it.x + it.w), maxY: Math.max(b.maxY, it.y + it.h),
  }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
  for (const g of groups) {
    bounds.minX = Math.min(bounds.minX, g.x); bounds.minY = Math.min(bounds.minY, g.y);
    bounds.maxX = Math.max(bounds.maxX, g.x + g.w); bounds.maxY = Math.max(bounds.maxY, g.y + g.h);
  }
  return { items, groups, bounds };
}

function draw() {
  const cv = canvasEl();
  if (!cv) return;
  const g = cv.getContext('2d');
  const dpr = Number(cv.dataset.dpr || 1);
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = '#080c14';
  g.fillRect(0, 0, cv.width, cv.height);

  // 无限画布背景：按缩放自适应间距的点阵 / 网格 / 纯色（世界坐标无边界）
  const bgMode = S.view?.bg || 'dots';
  if (bgMode !== 'none') {
    const baseStep = Number(S.view?.gridSize) || 40;
    const stepWorld = niceStep(Math.max(baseStep, 26 / S.zoom));   // 屏幕上至少 ~26px
    const stepPx = stepWorld * S.zoom * dpr;
    const offX = (S.panX * S.zoom * dpr) % stepPx;
    const offY = (S.panY * S.zoom * dpr) % stepPx;
    const major = stepPx * 5;
    const offMX = (S.panX * S.zoom * dpr) % major;
    const offMY = (S.panY * S.zoom * dpr) % major;
    g.save();
    if (bgMode === 'lines') {
      g.strokeStyle = 'rgba(52,70,104,.26)';
      g.lineWidth = 1;
      for (let x = offX; x < cv.width; x += stepPx) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, cv.height); g.stroke(); }
      for (let y = offY; y < cv.height; y += stepPx) { g.beginPath(); g.moveTo(0, y); g.lineTo(cv.width, y); g.stroke(); }
      g.strokeStyle = 'rgba(70,94,138,.5)';
      for (let x = offMX; x < cv.width; x += major) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, cv.height); g.stroke(); }
      for (let y = offMY; y < cv.height; y += major) { g.beginPath(); g.moveTo(0, y); g.lineTo(cv.width, y); g.stroke(); }
    } else {
      // 点阵：小点 + 每 5 格一个亮点
      const r1 = Math.max(0.7, 1.1 * dpr);
      const r2 = Math.max(1.1, 1.8 * dpr);
      g.fillStyle = 'rgba(70,92,132,.55)';
      for (let x = offX; x < cv.width; x += stepPx) {
        for (let y = offY; y < cv.height; y += stepPx) { g.beginPath(); g.arc(x, y, r1, 0, Math.PI * 2); g.fill(); }
      }
      g.fillStyle = 'rgba(110,140,200,.75)';
      for (let x = offMX; x < cv.width; x += major) {
        for (let y = offMY; y < cv.height; y += major) { g.beginPath(); g.arc(x, y, r2, 0, Math.PI * 2); g.fill(); }
      }
    }
    g.restore();
  }

  g.setTransform(dpr * S.zoom, 0, 0, dpr * S.zoom, dpr * S.zoom * S.panX, dpr * S.zoom * S.panY);
  const L = computeLayout();
  S._layout = L;
  S._itemsById = new Map(L.items.map((it) => [it.actor.id, it]));

  const empty = rootEl.querySelector('#ac-empty');
  if (empty) {
    if (!L.items.length) {
      empty.innerHTML = '';
      const isNewCanvas = S.showAll === false && S.actors.length > 0;
      empty.append(el('div', { class: 'card' }, [
        el('div', { style: { fontSize: '40px' } }, [isNewCanvas ? '🗂' : '🎬']),
        el('div', { style: { fontWeight: 600, color: 'var(--text)', marginTop: '6px' } }, [
          isNewCanvas ? '这是一张空画布' : (S.actors.length ? '当前筛选没有匹配的演员' : '还没有演员上台'),
        ]),
        el('div', { class: 'small', style: { marginTop: '4px' } }, [
          isNewCanvas
            ? `把演员放进这张画布：点「⊕ 放入全部演员」，或双击空白在该处新建，也可从左侧列表拖入。`
            : (S.actors.length ? '清空搜索或切换画风筛选试试。' : '点击左侧「+ 新建」建立第一位明星，右键即可生成脸部特写/多角度/多表情/姿态/手势/服饰。'),
        ]),
        isNewCanvas ? el('button', { class: 'btn primary', style: { marginTop: '10px', pointerEvents: 'auto' }, onclick: () => putAllActors() }, [`⊕ 放入全部演员（${S.actors.length}）`]) : null,
      ]));
    } else empty.innerHTML = '';
  }

  // 视口裁剪：只画可见卡片（大项目不卡）。视口矩形 / 裁剪口径 / 统计口径 / z 序全部取自 canvas-perf（单一真源）
  const cvEl = canvasEl();
  const view = perf.viewportOf({ zoom: S.zoom, panX: S.panX, panY: S.panY, width: cvEl.clientWidth, height: cvEl.clientHeight });
  const stats = perf.cullStats(L.items, view);     // 与 __acDebug().drawn、HUD「视野内 N」同源；空表 ratio=0（不得 NaN）
  const ordered = perf.sortByZ(L.items);           // z 升序、等 z 保持输入顺序（显式稳定，不依赖引擎稳定性）
  L.drawOrder = ordered;
  for (const it of ordered) {
    if (!perf.viewClipKeep(it, view)) continue;    // 闭区间：与视口边界相切必须可见
    if (it.kind === 'note') drawNoteNode(g, it);
    else if (['scene', 'item', 'refimg', ...FLOW_KINDS].includes(it.kind)) drawAssetNode(g, it);
    else drawCell(g, it);
    if (isFindHit(it)) {
      g.save();
      g.strokeStyle = '#f5b544'; g.lineWidth = 2.5 / S.zoom;
      roundRect(g, it.x - 3 / S.zoom, it.y - 3 / S.zoom, it.w + 6 / S.zoom, it.h + 6 / S.zoom, 10);
      g.stroke(); g.restore();
    }
  }
  S._drawn = stats.drawn;                          // 位置与旧赋值一致（仍在绘制循环之后）

  // 对齐参考线
  if (S.guides.length) {
    g.save();
    g.strokeStyle = 'rgba(255,120,180,.85)';
    g.lineWidth = 1 / S.zoom;
    g.setLineDash([6 / S.zoom, 4 / S.zoom]);
    for (const gd of S.guides) {
      g.beginPath();
      if (gd.axis === 'x') { g.moveTo(gd.pos, gd.from); g.lineTo(gd.pos, gd.to); }
      else { g.moveTo(gd.from, gd.pos); g.lineTo(gd.to, gd.pos); }
      g.stroke();
    }
    g.restore();
  }

  // 框选矩形
  if (S.marquee) {
    const m = S.marquee;
    const x = Math.min(m.x0, m.x1); const y = Math.min(m.y0, m.y1);
    const w = Math.abs(m.x1 - m.x0); const h = Math.abs(m.y1 - m.y0);
    g.save();
    g.fillStyle = 'rgba(109,140,255,.14)';
    g.strokeStyle = 'rgba(140,170,255,.9)';
    g.lineWidth = 1.2 / S.zoom;
    g.fillRect(x, y, w, h);
    g.strokeRect(x, y, w, h);
    g.restore();
  }

  drawGroupFrames(g, L);          // 分组框（在卡片之下）
  if (perf.shouldDrawLinks({ showLinks: S.showLinks, links: S.links })) drawLinks(g, L);
  drawPorts(g, L);
  drawSelectionBox(g);
  drawMinimap();
  updateHud(stats.drawn, stats.total);
  syncInlineEdit();               // T-L3 ①：内联编辑框跟随视口（缩放/平移/重排后都不跑偏）
}

function updateHud(drawn, total) {
  const hud = rootEl?.querySelector('#ac-hud');
  if (!hud) return;
  const sel = S.selection.size;
  hud.innerHTML = '';
  hud.append(el('span', {}, []));   // 占位，随后整体替换
  hud.innerHTML = '';
  const chips = [
    el('span', { class: 'ac-hud-chip' }, [`🔍 ${Math.round(S.zoom * 100)}%`]),
    el('span', { class: 'ac-hud-chip' }, [S.mode === 'matrix' ? '▦ 宫格' : '✦ 自由']),
    el('span', { class: 'ac-hud-chip' }, [`👥 ${total}${drawn < total ? `（视野内 ${drawn}）` : ''}`]),
  ];
  if (sel) chips.push(el('span', { class: 'ac-hud-chip on' }, [`✓ 已选 ${sel}`]));
  if (sel > 1) chips.push(el('span', { class: 'ac-hud-chip' }, ['顺序角标 1…n']));
  if ((S.groupFrames || []).length) chips.push(el('span', { class: 'ac-hud-chip' }, [`🗂 ${S.groupFrames.length} 组`]));
  if ((S.noteNodes || []).length) chips.push(el('span', { class: 'ac-hud-chip' }, [`📝 ${S.noteNodes.length}`]));
  if (S.undoStack?.length) chips.push(el('span', { class: 'ac-hud-chip', title: '可撤销步数（Ctrl+Z / Ctrl+Shift+Z）' }, [`↶ ${S.undoStack.length}`]));
  if (S.links?.length) chips.push(el('span', { class: 'ac-hud-chip' }, [`🔗 ${S.links.length}`]));
  // T-L3 ②：类型筛选生效时挂一片 HUD 提示——刷新后一眼可见「筛选条件仍在起作用」
  const fDims = activeFilterDims();
  if (fDims.length) {
    const fSpec = nodeFilterSpec();
    const fItems = visibleItems();       // draw() 末尾：S._layout 已就绪，这里不重算布局
    chips.push(el('span', {
      class: 'ac-hud-chip on',
      title: describeNodeFilter(fSpec, fItems.length, filterItems(fItems, fSpec).length),
    }, [`🔎 筛选：${fDims.map((d) => NODE_FILTER_DIMS[d] || '反选').join('/')}`]));
  }
  const lod = lodLevel();
  chips.push(el('span', { class: 'ac-hud-chip', title: '渲染细节级别：低缩放只画色块以保证流畅' }, [lod === 0 ? 'LOD 简' : lod === 1 ? 'LOD 中' : 'LOD 全']));
  for (const c of chips) hud.append(c);
  const zv = rootEl?.querySelector('.ac-zoom-val');
  if (zv) zv.textContent = `${Math.round(S.zoom * 100)}%`;
  const alignBar = rootEl?.querySelector('#ac-align-bar');
  if (alignBar) alignBar.classList.toggle('hidden', S.selection.size < 2);
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function imageFor(actor) {
  const rel = actor.cover_image || actor.primary_image?.file_path;
  if (!rel) return null;
  if (lodLevel() === 0) return null;              // LOD0：只画色块，避免 200 张图全解码
  if (S.imgCache.has(rel)) {
    const rec = S.imgCache.get(rel);
    return rec.ok ? rec.img : null;
  }
  const img = new Image();
  const rec = { img, ok: false, error: false };
  S.imgCache.set(rel, rec);
  img.onload = () => { rec.ok = true; draw(); };
  img.onerror = () => { rec.error = true; };
  img.src = api.fileUrl(rel);
  return null;
}

const STYLE_HUES = new Map();
function styleHue(styleId) {
  if (!STYLE_HUES.has(styleId)) {
    const seed = [...String(styleId || 'x')].reduce((n, c) => n + c.charCodeAt(0), 0);
    STYLE_HUES.set(styleId, seed % 360);
  }
  return STYLE_HUES.get(styleId);
}

function drawCell(g, it) {
  const { actor, x, y, w, h } = it;
  const selected = S.selection.has(actor.id);
  const hovered = S.hover === actor.id;
  const order = selected ? S.selectedOrder.indexOf(actor.id) + 1 : 0;
  const generating = actor.status === 'generating';

  g.save();
  g.shadowColor = selected ? 'rgba(109,140,255,.55)' : 'rgba(0,0,0,.45)';
  g.shadowBlur = selected ? 20 : 10;
  roundRect(g, x, y, w, h, 12);
  const grad = g.createLinearGradient(x, y, x, y + h);
  grad.addColorStop(0, '#16203a'); grad.addColorStop(1, '#0d1420');
  g.fillStyle = grad; g.fill();

  const lod = lodLevel();
  const img = imageFor(actor);
  if (img && lod >= 1) {
    g.save(); roundRect(g, x, y, w, h, 12); g.clip();
    const scale = Math.max(w / img.width, h / img.height);
    const dw = img.width * scale; const dh = img.height * scale;
    g.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    const og = g.createLinearGradient(x, y + h * 0.45, x, y + h);
    og.addColorStop(0, 'rgba(6,10,18,0)'); og.addColorStop(1, 'rgba(6,10,18,.92)');
    g.fillStyle = og; g.fillRect(x, y + h * 0.4, w, h * 0.6);
    g.restore();
  } else {
    const hue = styleHue(actor.style_id);
    const pg = g.createLinearGradient(x, y, x + w, y + h);
    pg.addColorStop(0, `hsla(${hue},55%,26%,.9)`);
    pg.addColorStop(1, `hsla(${(hue + 50) % 360},55%,14%,.95)`);
    g.fillStyle = pg; roundRect(g, x, y, w, h, 12); g.fill();
    g.fillStyle = 'rgba(226,236,255,.30)';
    g.font = `700 ${Math.round(w * 0.42)}px var(--sans, sans-serif)`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText((actor.name || '?').slice(0, 1), x + w / 2, y + h * 0.42);
    g.font = `500 ${Math.max(9, Math.round(w * 0.05))}px var(--sans, sans-serif)`;
    g.fillStyle = 'rgba(200,215,240,.55)';
    g.fillText('未生成定妆图', x + w / 2, y + h * 0.62);
  }

  // 画风色条（左上竖条）
  const hue = styleHue(actor.style_id);
  g.save();
  roundRect(g, x, y, w, h, 12); g.clip();
  g.fillStyle = `hsl(${hue} 70% 58%)`;
  g.fillRect(x, y, 4, h);
  g.restore();

  // 边框
  g.shadowBlur = 0;
  roundRect(g, x + .5, y + .5, w - 1, h - 1, 12);
  g.lineWidth = selected ? 2.6 : (hovered ? 1.8 : 1);
  g.strokeStyle = selected ? '#6d8cff' : (hovered ? '#3d4f77' : 'rgba(60,78,112,.9)');
  g.stroke();

  // 文本（LOD0 只画名字，保证 200 人时依然可读且流畅）
  g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  g.fillStyle = '#f1f5ff';
  g.font = `700 ${Math.max(11, Math.round(w * 0.072))}px var(--sans, sans-serif)`;
  g.fillText(clip(actor.name, Math.floor(w / 12)), x + 9, y + h - (lod >= 2 ? 30 : 14));
  if (lod >= 2) {
    g.font = `500 ${Math.max(9.5, Math.round(w * 0.055))}px var(--mono, monospace)`;
    g.fillStyle = '#9fb2d4';
    g.fillText(`${actor.id} · ${actor.role_type || '演员'}${actor.height_cm ? ` · ${actor.height_cm}cm` : ''}`, x + 9, y + h - 15);
  }
  if (lod === 0) { g.restore(); return; }

  // 风格徽章
  g.font = `600 ${Math.max(9, Math.round(w * 0.05))}px var(--mono, monospace)`;
  const badge = actor.style_id || 'no-style';
  const bw = g.measureText(badge).width + 12;
  g.fillStyle = 'rgba(8,12,20,.78)';
  roundRect(g, x + 9, y + 7, bw, 17, 5); g.fill();
  g.strokeStyle = `hsla(${hue},70%,58%,.75)`; g.lineWidth = 1; g.stroke();
  g.fillStyle = '#a9bde0';
  g.fillText(badge, x + 15, y + 19.5);

  // 素材数
  const nImgs = actor.image_count || 0;
  if (nImgs) {
    const t = `🖼 ${nImgs}`;
    const tw = g.measureText(t).width + 12;
    g.fillStyle = 'rgba(8,12,20,.78)';
    roundRect(g, x + w - tw - 7, y + 7, tw, 17, 5); g.fill();
    g.fillStyle = '#9ff0c4'; g.fillText(t, x + w - tw - 1, y + 19.5);
  }

  // 锁定标记
  if (it.locked) {
    g.fillStyle = 'rgba(8,12,20,.78)';
    roundRect(g, x + w - 24, y + h - 26, 18, 18, 5); g.fill();
    g.font = '11px sans-serif'; g.fillStyle = '#ffd894'; g.textAlign = 'center';
    g.fillText('🔒', x + w - 15, y + h - 12);
    g.textAlign = 'left';
  }

  // 多选顺序角标
  if (order > 0 && S.selection.size > 1) {
    g.beginPath();
    g.arc(x + 18, y + h - 60, 11, 0, Math.PI * 2);
    g.fillStyle = '#6d8cff'; g.fill();
    g.fillStyle = '#fff'; g.font = '700 12px var(--sans, sans-serif)';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(String(order), x + 18, y + h - 59);
    g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  }

  // 右下角缩放手柄（选中时出现）
  if (selected) {
    const hs = Math.max(12, 13 / S.zoom);
    g.fillStyle = '#6d8cff';
    roundRect(g, x + w - hs - 3 / S.zoom, y + h - hs - 3 / S.zoom, hs, hs, 3);
    g.fill();
    g.strokeStyle = 'rgba(255,255,255,.85)'; g.lineWidth = 1 / S.zoom; g.stroke();
  }

  if (generating) {
    g.fillStyle = 'rgba(9,13,22,.55)';
    roundRect(g, x, y, w, h, 12); g.fill();
    g.fillStyle = '#ffd894';
    g.font = '600 13px var(--sans, sans-serif)';
    g.textAlign = 'center';
    g.fillText('⏳ 生成中…', x + w / 2, y + h / 2);
    g.textAlign = 'left';
  }
  g.restore();
}

const GROUP_COLORS = ['#6d8cff', '#23d5c0', '#f5b544', '#ff7ab0', '#a56bff', '#35d07f', '#ff9f6b', '#5ac8fa'];
function groupColor(gr) {
  if (gr.color) return gr.color;
  const idx = [...String(gr.id)].reduce((n, c) => n + c.charCodeAt(0), 0) % GROUP_COLORS.length;
  return GROUP_COLORS[idx];
}

/** 分组框（Frame）：标题栏 + 边框 + 折叠态；在卡片之下绘制 */
function drawGroupFrames(g, L) {
  const frames = L.groups || [];
  if (!frames.length) return;
  const memberCount = (id) => (L.items || []).filter((it) => it.groupId === id).length
    + (S.noteNodes || []).filter((n) => n.group_id === id).length;
  for (const gr of frames) {
    const color = groupColor(gr);
    const sel = S.selectedGroup === gr.id;
    const collapsed = Boolean(gr.collapsed);
    const headerH = Math.max(22, 30 / S.zoom);
    const w = Math.max(60, gr.w); const h = collapsed ? headerH : Math.max(headerH, gr.h);
    g.save();
    // 底板
    g.fillStyle = sel ? hexAlpha(color, 0.16) : hexAlpha(color, 0.07);
    roundRect(g, gr.x, gr.y, w, h, 12);
    g.fill();
    g.strokeStyle = sel ? color : hexAlpha(color, 0.55);
    g.lineWidth = (sel ? 2.2 : 1.2) / S.zoom;
    g.setLineDash(collapsed ? [6 / S.zoom, 4 / S.zoom] : []);
    g.stroke();
    g.setLineDash([]);
    // 标题栏
    g.fillStyle = hexAlpha(color, sel ? 0.34 : 0.22);
    roundRect(g, gr.x, gr.y, w, headerH, 12);
    g.fill();
    g.fillStyle = 'rgba(240,246,255,.96)';
    g.font = `600 ${Math.max(10, 12.5 / S.zoom)}px var(--sans, sans-serif)`;
    g.textBaseline = 'middle';
    const label = `${collapsed ? '▸' : '▾'} ${gr.name || '分组'} · ${memberCount(gr.id)}`;
    g.fillText(clip(label, Math.max(8, Math.floor(w / (7 / S.zoom)))), gr.x + 10, gr.y + headerH / 2 + 0.5);
    g.textBaseline = 'alphabetic';
    g.restore();
  }
}

function hexAlpha(hex, a) {
  const h = String(hex || '#6d8cff').replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** 便签节点 */
const NOTE_COLORS = { amber: '#f5b544', blue: '#6d8cff', green: '#35d07f', pink: '#ff7ab0', purple: '#a56bff', grey: '#8c9cb8' };
function drawNoteNode(g, it) {
  const n = it.note;
  const color = NOTE_COLORS[n.note_color] || NOTE_COLORS.amber;
  const { x, y, w, h } = it;
  const sel = S.selectedNote === n.id || (n.group_id && S.selectedGroup === n.group_id);
  g.save();
  g.shadowColor = 'rgba(0,0,0,.35)'; g.shadowBlur = 8;
  g.fillStyle = hexAlpha(color, 0.18);
  roundRect(g, x, y, w, h, 10); g.fill();
  g.shadowBlur = 0;
  g.fillStyle = color;
  roundRect(g, x, y, w, 5, 3); g.fill();          // 顶部色条
  g.strokeStyle = sel ? '#fff' : hexAlpha(color, 0.75);
  g.lineWidth = (sel ? 2 : 1.1) / S.zoom;
  roundRect(g, x + 0.5, y + 0.5, w - 1, h - 1, 10); g.stroke();
  // 文本
  g.fillStyle = '#eef3ff';
  g.font = `${Math.max(9, 12 / S.zoom)}px var(--sans, sans-serif)`;
  const lineH = Math.max(11, 16 / S.zoom);
  const text = String(n.note_text || '双击编辑便签…');
  const perLine = Math.max(6, Math.floor((w - 20) / (12 / S.zoom)));
  let ty = y + 18 / S.zoom + 6;
  let line = '';
  const lines = [];
  for (const ch of text) {
    if (ch === '\n') { lines.push(line); line = ''; continue; }
    line += ch;
    if (line.length >= perLine) { lines.push(line); line = ''; }
  }
  if (line) lines.push(line);
  for (const ln of lines.slice(0, Math.max(1, Math.floor((h - 26 / S.zoom) / lineH)))) {
    g.fillText(ln, x + 10, ty);
    ty += lineH;
  }
  g.restore();
}

const ASSET_STYLE = {
  scene: { icon: '🏞', name: '环境', color: '#23d5c0' },
  item: { icon: '🗝', name: '物品', color: '#f5b544' },
  refimg: { icon: '🖼', name: '参考图', color: '#a56bff' },
  // P5 流程节点
  shot: { icon: '🎞', name: '分镜容器', color: '#6d8cff' },
  image: { icon: '🖼', name: '关键帧（出图）', color: '#35d07f' },
  audio: { icon: '🔊', name: '音频节点', color: '#ff7ab0' },
  overlay: { icon: '🖼️', name: '叠加层（画中画）', color: '#35d07f' },
  subtitle: { icon: '💬', name: '字幕轨', color: '#6d8cff' },
  text: { icon: '📝', name: '文本', color: '#6d8cff' },
  video: { icon: '🎬', name: '视频片段', color: '#a56bff' },
  timeline: { icon: '🎬', name: '成片时间线', color: '#ff9f43' },
  output: { icon: '📦', name: '交付终点', color: '#35d07f' },
};
/** P5 流程节点类型（分镜容器 / 视频片段 / 成片时间线 / 交付终点） */
const FLOW_KINDS = ['shot', 'video', 'timeline', 'output', 'image', 'text', 'audio', 'overlay', 'subtitle'];

function assetImage(rel) {
  if (!rel) return null;
  if (S.imgCache.has(rel)) {
    const rec = S.imgCache.get(rel);
    return rec.ok ? rec.img : null;
  }
  const img = new Image();
  const rec = { img, ok: false, error: false };
  S.imgCache.set(rel, rec);
  img.onload = () => { rec.ok = true; draw(); };
  img.onerror = () => { rec.error = true; };
  img.src = api.fileUrl(rel);
  return null;
}

// ============================ 时间线缩略轨（LibTV 调研第 4 条） ============================
/** 视频/图片 → 缩略图（走服务端 ffmpeg 抽帧 + 缓存；结果按 URL 记在 imgCache 里） */
function thumbImg(rel) {
  if (!rel) return null;
  const key = `thumb:${rel}`;
  if (S.imgCache.has(key)) { const rec = S.imgCache.get(key); return rec.ok ? rec.img : null; }
  const img = new Image();
  const rec = { img, ok: false, error: false };
  S.imgCache.set(key, rec);
  img.onload = () => { rec.ok = true; draw(); };
  img.onerror = () => { rec.error = true; };
  img.src = `/api/render/thumb?size=160&path=${encodeURIComponent(rel)}`;
  return null;
}

/** 成片节点上的片段条目（顺序口径与后端 orderedClips 一致：端口号 → slot → id） */
const clipPortIdx = (p) => { const m = /^clip(\d+)$/.exec(String(p || '')); return m ? Number(m[1]) : 999; };
function clipEntriesOf(nodeId) {
  const links = (S.links || []).filter((l) => l.to_node === nodeId && (!l.to_port || /^clip\d+$/.test(String(l.to_port))));
  return links.map((l) => {
    const up = S._itemsById?.get(l.from_node) || S.nodes.get(l.from_node);
    let d = {};
    try { d = up?.node?.data ? JSON.parse(up.node.data) : (up?.data ? JSON.parse(up.data) : {}); } catch { d = {}; }
    return { linkId: l.id, from: l.from_node, port: l.to_port || null, slot: Number(l.slot) || 0,
      file: d.lastFile || null, title: up?.node?.title || up?.title || l.from_node };
  }).sort((a, b) => (clipPortIdx(a.port) - clipPortIdx(b.port)) || (a.slot - b.slot) || String(a.linkId).localeCompare(String(b.linkId)));
}

/** 命中缩略轨：返回 {item, index, linkId} */
function hitClipThumb(wx, wy) {
  for (const it of (S._layout?.items || [])) {
    const rects = it.clipRects;
    if (!rects || !rects.length) continue;
    const tr = it.clipRect;
    if (!tr || wy < tr.y || wy > tr.y + tr.h || wx < tr.x || wx > tr.x + tr.w) continue;
    for (const r of rects) if (wx >= r.x && wx <= r.x + r.w) return { item: it, index: r.index, linkId: r.linkId };
    return { item: it, index: rects.length - 1, linkId: rects[rects.length - 1].linkId };
  }
  return null;
}

/** 拖拽中的插入位置：按 x 落在哪个格子 */
function clipIndexAt(nodeId, wx) {
  for (const it of (S._layout?.items || [])) {
    if (it.id !== nodeId || !it.clipRect) continue;
    const rects = it.clipRects || [];
    for (const r of rects) if (wx < r.x + r.w / 2) return r.index;
    return Math.max(0, rects.length - 1);
  }
  return -1;
}

/** 提交调序：把新顺序写回后端（端口 clip1..N + slot），成功后重载画布 */
async function applyClipReorder(drag) {
  const entries = clipEntriesOf(drag.nodeId);
  if (drag.from === drag.to || !entries.length) { draw(); return; }
  const order = entries.map((e) => e.linkId);
  const [moved] = order.splice(drag.from, 1);
  order.splice(drag.to, 0, moved);
  try {
    const r = await api.post('/api/canvas/reorder-clips', { canvasId: S.canvasId, nodeId: drag.nodeId, order });
    await loadCanvas();
    draw();
    const names = (r.order || []).map((x, i) => `${i + 1}.${(entries.find((e) => e.linkId === x.linkId)?.title || '').slice(0, 6)}`).join(' ');
    toast(`已调序：${names}（成片会按这个顺序拼接）`, 'ok', 4200);
  } catch (e) {
    draw();
    toast('调序失败：' + e.message, 'err', 4200);
  }
}

/** 环境 / 物品 / 参考图节点（参考图以矩阵网格展示） */
function drawAssetNode(g, it) {
  const { x, y, w, h, kind, asset, node } = it;
  const st = ASSET_STYLE[kind] || ASSET_STYLE.scene;
  const sel = S.selectedExtra === it.id || (it.groupId && S.selectedGroup === it.groupId);
  const lod = lodLevel();
  const headerH = Math.max(20, 26 / S.zoom);
  g.save();
  g.shadowColor = 'rgba(0,0,0,.4)'; g.shadowBlur = 8;
  g.fillStyle = 'rgba(12,18,30,.94)';
  roundRect(g, x, y, w, h, 10); g.fill();
  g.shadowBlur = 0;
  // 头部色条
  g.fillStyle = hexAlpha(st.color, 0.9);
  roundRect(g, x, y, w, headerH, 8); g.fill();
  g.fillStyle = 'rgba(8,12,20,.85)';
  g.font = `600 ${Math.max(9.5, 12 / S.zoom)}px var(--sans, sans-serif)`;
  g.textBaseline = 'middle';
  const title = `${st.icon} ${it.node?.title || st.name}`;
  g.fillText(clip(title, Math.max(6, Math.floor((w - 16) / (12 / S.zoom)))), x + 8, y + headerH / 2 + 1);
  g.textBaseline = 'alphabetic';
  // 边框
  g.strokeStyle = sel ? '#fff' : hexAlpha(st.color, 0.7);
  g.lineWidth = (sel ? 2 : 1.1) / S.zoom;
  roundRect(g, x + 0.5, y + 0.5, w - 1, h - 1, 10); g.stroke();

  // P5 流程节点：显示执行状态 / 片段信息（不展示参考图矩阵）
  if (FLOW_KINDS.includes(kind)) {
    let d = {};
    try { d = node?.data ? JSON.parse(node.data) : {}; } catch { d = {}; }
    const fs2 = Math.max(9, 11 / S.zoom);
    g.font = `${fs2}px var(--sans, sans-serif)`;
    let ty2 = y + headerH + fs2 + 6 / S.zoom;
    const badge = (text, color) => {
      const tw = g.measureText(text).width + 10 / S.zoom;
      g.fillStyle = hexAlpha(color, 0.22);
      roundRect(g, x + 7, ty2 - fs2, tw, fs2 + 6 / S.zoom, 4 / S.zoom); g.fill();
      g.fillStyle = color;
      g.fillText(text, x + 7 + 5 / S.zoom, ty2);
      return tw;
    };
    const stCol = d.status === 'done' ? '#35d07f' : d.status === 'error' ? '#ff6b81' : d.status === 'running' ? '#f5b544' : 'rgba(170,185,210,.9)';
    badge(d.status ? `状态 ${d.status}` : '未执行', stCol);
    ty2 += fs2 + 9 / S.zoom;
    const lines = [];
    if (kind === 'shot') lines.push(`分镜 ${d.shotCount ?? '?'} 镜`);
    if (kind === 'overlay') {
      const modeName = { pip: '画中画', full: '全屏叠加', watermark: '水印' }[d.mode] || '画中画';
      lines.push(`${modeName} · ${d.position || '右下'}`);
      lines.push(`宽度 ${Math.round((Number(d.widthRatio) || 0.32) * 100)}%${d.opacity < 1 ? ` · 不透明度 ${Math.round(d.opacity * 100)}%` : ''}`);
      lines.push(d.start === '' || d.start == null ? '整片出现' : `时间窗 ${d.start}s ~ ${d.end || '片尾'}s`);
    }
    if (kind === 'subtitle') {
      lines.push(d.file ? `SRT：${String(d.file).split('/').pop().slice(0, 18)}` : `手工 ${(d.lines || []).length} 行`);
      lines.push(d.mode === 'soft' ? '软字幕轨（可开关）' : '烧录进画面');
    }
    if (kind === 'audio') {
      const modeName = { tts: '配音（TTS）', file: '已有音频', bgm: '背景乐' }[d.mode] || '配音（TTS）';
      lines.push(modeName);
      if (d.text) lines.push(`「${String(d.text).slice(0, 14)}${String(d.text).length > 14 ? '…' : ''}」`);
      if (d.voice) lines.push(`音色 ${d.voice}`);
      if (d.file) lines.push(String(d.file).split('/').pop().slice(0, 20));
    }
    if (kind === 'video') {
      lines.push(`镜头 ${d.shotId ? String(d.shotId).slice(-4) : '—'} · ${d.duration || 3}s`);
      const inLinks = (S.links || []).filter((l) => l.to_node === it.id);
      const fromClip = inLinks.some((l) => l.to_port === 'first' && (S._itemsById?.get(l.from_node)?.kind === 'video' || /clip/i.test(String(l.label || ''))));
      const hasLast = inLinks.some((l) => l.to_port === 'last');
      const hasDub = inLinks.some((l) => l.to_port === 'dub');
      if (fromClip) lines.push('↻ 续写（首帧取自上游片段尾帧）');
      if (hasLast) lines.push('⇥ 首尾帧过渡');
      if (hasDub) lines.push('🔊 有画布配音');
    }
    if (kind === 'timeline') {
      const ins = (S.links || []).filter((l) => l.to_node === it.id);
      lines.push(`片段 ${ins.length} 段 · ${d.scriptId ? String(d.scriptId) : '未绑定剧本'}`);
    }
    if (kind === 'timeline' && lod !== 0) {
      // 逐镜缩略轨：顺序 = 成片拼接顺序；可横向拖拽调序（拖完写回端口与 slot）
      const entries = clipEntriesOf(it.id);
      const trackH = Math.max(16, Math.min(34, h * 0.24));
      const pad = 7;
      const ty = y + h - trackH - pad;
      const tw = w - pad * 2;
      const n = Math.max(1, entries.length);
      const cw = tw / n;
      it.clipRect = { x: x + pad, y: ty, w: tw, h: trackH };
      it.clipRects = entries.map((e, i) => ({ x: x + pad + i * cw, y: ty, w: cw, h: trackH, index: i, linkId: e.linkId, file: e.file, title: e.title }));
      // 底槽
      g.save();
      g.fillStyle = 'rgba(8,12,20,.55)';
      roundRect(g, x + pad, ty, tw, trackH, 4 / S.zoom); g.fill();
      entries.forEach((e, i) => {
        const cx = x + pad + i * cw;
        const inner = Math.max(2, cw - 2 / S.zoom);
        const img = e.file ? thumbImg(e.file) : null;
        if (img && img.width) {
          // 等比裁切成格子（cover）
          const scale = Math.max(inner / img.width, (trackH - 2 / S.zoom) / img.height);
          const dw = img.width * scale, dh = img.height * scale;
          g.save();
          g.beginPath(); g.rect(cx + 1 / S.zoom, ty + 1 / S.zoom, inner, trackH - 2 / S.zoom); g.clip();
          g.drawImage(img, cx + 1 / S.zoom + (inner - dw) / 2, ty + 1 / S.zoom + (trackH - 2 / S.zoom - dh) / 2, dw, dh);
          g.restore();
        } else {
          g.fillStyle = e.file ? 'rgba(120,150,200,.35)' : 'rgba(255,107,129,.28)';
          roundRect(g, cx + 1 / S.zoom, ty + 1 / S.zoom, inner, trackH - 2 / S.zoom, 3 / S.zoom); g.fill();
        }
        // 序号（小字，压在缩略图左上）
        const fs3 = Math.max(7.5, 9 / S.zoom);
        g.font = `600 ${fs3}px var(--sans, sans-serif)`;
        const label = String(i + 1);
        const lw = g.measureText(label).width + 5 / S.zoom;
        g.fillStyle = 'rgba(0,0,0,.62)';
        roundRect(g, cx + 2 / S.zoom, ty + 2 / S.zoom, lw, fs3 + 3 / S.zoom, 2 / S.zoom); g.fill();
        g.fillStyle = '#fff';
        g.fillText(label, cx + 2 / S.zoom + 2.5 / S.zoom, ty + 2 / S.zoom + fs3);
        // 分隔线
        if (i) { g.strokeStyle = 'rgba(0,0,0,.5)'; g.lineWidth = 1 / S.zoom; g.beginPath(); g.moveTo(cx, ty); g.lineTo(cx, ty + trackH); g.stroke(); }
      });
      // 拖拽态：被拖的格子高亮 + 目标位置画插入条
      if (S.clipDrag && S.clipDrag.nodeId === it.id) {
        const from = it.clipRects[S.clipDrag.from], to = it.clipRects[S.clipDrag.to];
        if (from) { g.strokeStyle = '#7fd1ff'; g.lineWidth = 2 / S.zoom; roundRect(g, from.x + 1 / S.zoom, from.y + 1 / S.zoom, from.w - 2 / S.zoom, from.h - 2 / S.zoom, 3 / S.zoom); g.stroke(); }
        if (to) {
          const mx = S.clipDrag.to > S.clipDrag.from ? to.x + to.w - 1 / S.zoom : to.x + 1 / S.zoom;
          g.strokeStyle = '#ffd479'; g.lineWidth = 3 / S.zoom;
          g.beginPath(); g.moveTo(mx, ty - 2 / S.zoom); g.lineTo(mx, ty + trackH + 2 / S.zoom); g.stroke();
        }
      }
      g.restore();
    } else {
      it.clipRects = null; it.clipRect = null;
    }
    if (d.lastFile) lines.push('已产出');
    if (d.lastError) lines.push(`失败：${String(d.lastError).slice(0, 18)}`);
    g.fillStyle = 'rgba(190,205,230,.92)';
    for (const ln of lines) {
      if (ty2 > y + h - 6 / S.zoom) break;
      g.fillText(clip(ln, Math.max(6, Math.floor((w - 16) / (fs2 * 0.62)))), x + 8, ty2);
      ty2 += fs2 + 4 / S.zoom;
    }
    g.restore();
    return;
  }

  // 参考图 + 生成结果（组合图/概念图）统一在节点内以矩阵展示
  const imgs = [...(asset?.refImages || []), ...((asset?.generated || []).map((x) => x.file))];
  const pad = 6;
  const imgTop = y + headerH + pad;
  const descLines = asset?.desc ? 2 : (asset?.timeOfDay || asset?.weather || asset?.category ? 1 : 0);
  const descH = descLines ? descLines * (14 / S.zoom) + 4 : 0;
  const imgH = Math.max(0, h - headerH - pad * 2 - descH - 14 / S.zoom);
  if (imgs.length && imgH > 20 && lod >= 1) {
    const cols = Math.max(1, Math.min(Number(asset.cols) || 2, 4));
    const rows = Math.ceil(Math.min(imgs.length, cols * 2) / cols);
    const cw = (w - pad * 3) / cols;
    const ch = (imgH - pad * (rows - 1)) / rows;
    imgs.slice(0, cols * 2).forEach((rel, i) => {
      const c = i % cols; const r = Math.floor(i / cols);
      const ix = x + pad + c * (cw + pad);
      const iy = imgTop + r * (ch + pad);
      const img = assetImage(rel);
      g.save();
      roundRect(g, ix, iy, cw, ch, 5); g.clip();
      g.fillStyle = 'rgba(8,12,20,.9)'; g.fillRect(ix, iy, cw, ch);
      if (img) {
        const sc = Math.max(cw / img.width, ch / img.height);
        g.drawImage(img, ix + (cw - img.width * sc) / 2, iy + (ch - img.height * sc) / 2, img.width * sc, img.height * sc);
      } else {
        g.fillStyle = 'rgba(140,160,200,.5)';
        g.font = `${Math.max(9, 11 / S.zoom)}px var(--sans, sans-serif)`;
        g.textAlign = 'center';
        g.fillText('图片', ix + cw / 2, iy + ch / 2);
        g.textAlign = 'left';
      }
      g.restore();
    });
  } else if (lod === 0) {
    g.fillStyle = hexAlpha(st.color, 0.25);
    roundRect(g, x + pad, imgTop, w - pad * 2, Math.max(10, imgH || 20), 5); g.fill();
  }

  // 描述信息
  let ty = y + h - 8 / S.zoom - (descLines ? descLines * (13 / S.zoom) : 0);
  g.font = `${Math.max(8.5, 10.5 / S.zoom)}px var(--sans, sans-serif)`;
  g.fillStyle = 'rgba(190,205,230,.92)';
  const chips = [];
  if (kind === 'scene') { if (asset?.timeOfDay) chips.push(asset.timeOfDay); if (asset?.weather) chips.push(asset.weather); }
  if (kind === 'item' && asset?.category) chips.push(asset.category);
  if (kind === 'refimg') chips.push(`${imgs.length} 张参考`);
  if (chips.length) g.fillText(clip(chips.join(' · '), Math.max(6, Math.floor((w - 16) / (10.5 / S.zoom)))), x + 8, ty + 10 / S.zoom);
  if (asset?.desc) {
    const lines = wrapTextBy(asset.desc, Math.max(6, Math.floor((w - 16) / (10.5 / S.zoom)))).slice(0, 2);
    lines.forEach((ln, i) => g.fillText(ln, x + 8, ty + (10 + (i + 1) * 13) / S.zoom));
  }
  if ((asset?.tags || []).length) {
    g.fillStyle = hexAlpha(st.color, 0.85);
    g.font = `500 ${Math.max(8, 9.5 / S.zoom)}px var(--sans, sans-serif)`;
    g.fillText(clip(asset.tags.slice(0, 4).join(' · '), Math.max(6, Math.floor((w - 16) / (9.5 / S.zoom)))), x + 8, y + headerH + 12 / S.zoom + (imgs.length ? 0 : 2));
  }
  g.restore();
}

function wrapTextBy(text, per) {
  const out = []; let line = '';
  for (const ch of String(text || '')) {
    if (ch === '\n') { out.push(line); line = ''; continue; }
    line += ch;
    if (line.length >= per) { out.push(line); line = ''; }
  }
  if (line) out.push(line);
  return out;
}

/** 关系连线：把 canvas_links 画成贝塞尔曲线（缩放到很低时省略标签） */
function drawLinks(g, L) {
  const links = S.links || [];
  if (!links.length) return;
  const byId = new Map((L.items || []).map((it) => [it.id, it]));
  const lod = lodLevel();
  const LINE_COLORS = ['#6d8cff', '#ff7ab0', '#23d5c0', '#f5b544', '#a56bff', '#35d07f'];
  g.save();
  for (const link of links) {
    const a = byId.get(link.from_node) || (link.from_actor ? (L.items || []).find((i2) => i2.actorId === link.from_actor) : null);
    const b = byId.get(link.to_node) || (link.to_actor ? (L.items || []).find((i2) => i2.actorId === link.to_actor) : null);
    if (!a || !b) continue;
    const p1 = edgeAnchor(a, link.from_port, link.from_side || 'right');
    const p2 = edgeAnchor(b, link.to_port, link.to_side || 'left');
    const color = link.color || LINE_COLORS[String(link.id).length % LINE_COLORS.length];
    const active = S.selectedLink === link.id
      || S.selection.has(link.from_actor) || S.selection.has(link.to_actor)
      || S.selectedExtra === link.from_node || S.selectedExtra === link.to_node;
    const dx = Math.max(40 / S.zoom, Math.abs(p2.x - p1.x) * 0.45);
    const sgn = (link.from_side === 'left' ? -1 : 1);
    const c1 = { x: p1.x + dx * sgn, y: p1.y };
    const c2 = { x: p2.x - dx * (link.to_side === 'right' ? -1 : 1), y: p2.y };
    g.strokeStyle = color;
    g.globalAlpha = active ? 0.98 : 0.55;
    g.lineWidth = (active ? 2.6 : 1.7) / S.zoom;
    g.beginPath();
    g.moveTo(p1.x, p1.y);
    g.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, p2.x, p2.y);
    g.stroke();
    // 箭头
    const t = 0.94;
    const bx = cubic(t, p1.x, c1.x, c2.x, p2.x);
    const by = cubic(t, p1.y, c1.y, c2.y, p2.y);
    const ang = Math.atan2(p2.y - by, p2.x - bx);
    const ah = 10 / S.zoom;
    g.globalAlpha = active ? 1 : 0.7;
    g.fillStyle = color;
    g.beginPath();
    g.moveTo(p2.x, p2.y);
    g.lineTo(p2.x - ah * Math.cos(ang - 0.42), p2.y - ah * Math.sin(ang - 0.42));
    g.lineTo(p2.x - ah * Math.cos(ang + 0.42), p2.y - ah * Math.sin(ang + 0.42));
    g.closePath();
    g.fill();
    // 标签（放在曲线中点）
    if (link.label && lod >= 1) {
      const mx = cubic(0.5, p1.x, c1.x, c2.x, p2.x);
      const my = cubic(0.5, p1.y, c1.y, c2.y, p2.y);
      const fs = Math.max(10, 12 / S.zoom);
      g.font = `600 ${fs}px var(--sans, sans-serif)`;
      const tw = g.measureText(link.label).width;
      g.globalAlpha = 0.94;
      g.fillStyle = 'rgba(10,14,22,.88)';
      roundRect(g, mx - tw / 2 - 7, my - fs * 0.78 - 4, tw + 14, fs * 1.55 + 6, 6);
      g.fill();
      g.strokeStyle = g.strokeStyle = color; g.lineWidth = 1 / S.zoom; g.stroke();
      g.fillStyle = '#dbe6ff';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(link.label, mx, my);
      g.textAlign = 'left'; g.textBaseline = 'alphabetic';
    }
    // 槽位角标（①②③…）：只在类型化输入端口上显示，历史无端口连线不画，保持原样
    if (link.to_port && Number(link.slot) > 0 && lod >= 1) {
      const n = Number(link.slot);
      const txt = n <= 8 ? String.fromCharCode(0x2460 + n) : `(${n + 1})`;
      const fs = Math.max(10, 12 / S.zoom);
      g.font = `700 ${fs}px var(--sans, sans-serif)`;
      const bx = p2.x + 14 / S.zoom;
      const by = p2.y - 14 / S.zoom;
      const pad = 7 / S.zoom;
      g.globalAlpha = 0.96;
      g.fillStyle = 'rgba(10,14,22,.9)';
      roundRect(g, bx - pad, by - fs * 0.8, fs + pad * 2, fs * 1.6, 5 / S.zoom);
      g.fill();
      g.strokeStyle = color; g.lineWidth = 1 / S.zoom; g.stroke();
      g.fillStyle = '#dbe6ff';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(txt, bx - pad + (fs + pad * 2) / 2, by);
      g.textAlign = 'left'; g.textBaseline = 'alphabetic';
    }
  }
  // 正在拉线：从起点端口到光标画虚线
  if (S.linking) {
    const a = byId.get(S.linking.fromId);
    if (a) {
      const p1 = S.linking.port ? edgeAnchor(a, S.linking.port, S.linking.side) : portPoint(a, S.linking.side, 0);
      g.globalAlpha = 0.95;
      g.strokeStyle = '#8ea8ff';
      g.lineWidth = 2 / S.zoom;
      g.setLineDash([8 / S.zoom, 6 / S.zoom]);
      const dx = Math.max(40 / S.zoom, Math.abs(S.linking.x - p1.x) * 0.45);
      g.beginPath();
      g.moveTo(p1.x, p1.y);
      g.bezierCurveTo(p1.x + dx * (S.linking.side === 'left' ? -1 : 1), p1.y, S.linking.x - dx, S.linking.y, S.linking.x, S.linking.y);
      g.stroke();
      g.setLineDash([]);
      g.beginPath(); g.arc(S.linking.x, S.linking.y, 5 / S.zoom, 0, Math.PI * 2);
      g.fillStyle = '#8ea8ff'; g.fill();
    }
  }
  g.restore();
}

const cubic = (t, a, b, c, d) => {
  const mt = 1 - t;
  return mt * mt * mt * a + 3 * mt * mt * t * b + 3 * mt * t * t * c + t * t * t * d;
};

/** 节点端口坐标（左右中点，向内收 0 距离；向内偏移量用于绘制小圆） */
function portPoint(it, side, inset = 0) {
  if (!it) return { x: 0, y: 0 };
  const midY = it.y + it.h / 2;
  const r = Math.max(4, 6 / S.zoom) + inset;
  if (side === 'left') return { x: it.x - r, y: midY };
  if (side === 'top') return { x: it.x + it.w / 2, y: it.y - r };
  if (side === 'bottom') return { x: it.x + it.w / 2, y: it.y + it.h + r };
  return { x: it.x + it.w + r, y: midY };
}

/**
 * 节点类型 → 类型化端口（P2 数据流边）
 * ⚠️ 必须与后端 `src/modules/actors.js` 的 `PORT_RULES` 保持一致（改一处要同步另一处）；
 *    渲染端口与本地预校验都读这张表，真正的裁决仍在服务端。
 */
const NODE_KINDS = {
  actor:  { in: [],                                out: ['image', 'ref'] },
  note:   { in: [],                                out: ['text'] },
  scene:  { in: ['ref1', 'ref2'],                  out: ['image', 'ref'] },
  item:   { in: ['ref1', 'ref2'],                  out: ['image', 'ref'] },
  refimg: { in: [],                                out: ['ref', 'image'] },
  text:   { in: [],                                out: ['text'] },
  image:  { in: ['in', 'ref1', 'ref2', 'ref3'],    out: ['image'] },
  video:  { in: ['first', 'last', 'ref1', 'ref2', 'dub'], out: ['clip'] },   // dub = 该镜配音（音频节点）
  shot:   { in: [],                                out: ['clip'] },
  timeline: { in: ['clip1', 'clip2', 'clip3', 'clip4', 'clip5', 'clip6', 'clip7', 'clip8', 'clip9', 'clip10', 'clip11', 'clip12', 'clip13', 'clip14', 'clip15', 'clip16', 'clip17', 'clip18', 'clip19', 'clip20', 'clip21', 'clip22', 'clip23', 'clip24', 'bgm', 'ov1', 'ov2', 'ov3', 'ov4', 'sub'], out: ['film'] },   // 多轨：clip1..N 主轨 + ov1..4 叠加轨 + bgm 音乐 + sub 字幕   // bgm = 整片背景乐（混音时自动 ducking）
  audio:  { in: ['in', 'text'],                  out: ['audio'] },
  overlay: { in: ['in', 'clip', 'text'],           out: ['overlay'] },  // 叠加层：画中画 / 全屏叠加 / 水印
  subtitle: { in: ['in', 'text'],                  out: ['subtitle'] }, // 字幕轨：自有 SRT / 手工行 / 上游文本  // 音频节点：配音 / 音乐 / 音效
  output: { in: ['in'],                            out: [] },
};
/** 输出端口 → 允许接入的输入端口（`in` 为通用汇，任何输出都允许） */
const PORT_COMPAT = {
  image: ['ref1', 'ref2', 'ref3', 'first', 'last', 'in'],
  text:  ['in', 'text'],
  clip:  ['clip1', 'clip2', 'clip3', 'clip4', 'clip5', 'clip6', 'clip7', 'clip8', 'clip9', 'clip10', 'clip11', 'clip12', 'clip13', 'clip14', 'clip15', 'clip16', 'clip17', 'clip18', 'clip19', 'clip20', 'clip21', 'clip22', 'clip23', 'clip24', 'first', 'in'],   // 也能接到 first：上游片段 → 下一段首帧 = 视频续写
  audio: ['audio', 'bgm', 'dub', 'in'],
  overlay: ['ov1', 'ov2', 'ov3', 'ov4', 'in'],
  subtitle: ['sub', 'in'],
  film:  ['in'],
  ref:   ['ref1', 'ref2', 'ref3', 'first', 'last', 'in'],
};
const PORT_COLORS = { image: '#35d07f', text: '#6d8cff', clip: '#a56bff', first: '#f5b544', last: '#f5b544' };
const portColor = (name) => PORT_COLORS[name] || (/^ref\d*$/.test(name || '') ? '#23d5c0' : '#6d8cff');
const portsOf = (it) => NODE_KINDS[(it && it.kind) || 'actor'] || { in: [], out: [] };
const portCompatible = (out, inp) => inp === 'in'
  || (/^clip\d+$/.test(String(inp || '')) && out === 'clip')
  || (PORT_COMPAT[out] || []).includes(inp);
/** 该侧是否需要画「语义端口」（旧的中点圆点）：该侧没有类型化端口时保留，保证关系线仍可拖拽 */
const hasLegacyPort = (it, side) => (side === 'right' ? portsOf(it).out.length === 0 : portsOf(it).in.length === 0);

/** 第 index 个（共 count 个）端口在该侧的位置；count<=1 时退化为中心点（与 portPoint 一致） */
function portPointAt(it, side, index = 0, count = 1, inset = 0) {
  if (!it) return { x: 0, y: 0 };
  const r = Math.max(4, 6 / S.zoom) + inset;
  const f = count <= 1 ? 0.5 : (index + 1) / (count + 1);   // 沿侧边均分，避开端点
  if (side === 'left') return { x: it.x - r, y: it.y + it.h * f };
  if (side === 'right') return { x: it.x + it.w + r, y: it.y + it.h * f };
  if (side === 'top') return { x: it.x + it.w * f, y: it.y - r };
  return { x: it.x + it.w * f, y: it.y + it.h + r };
}

/** 解析一条边在节点上的锚点：优先按端口名，回退到旧 side 语义（历史无端口连线走旧逻辑） */
function edgeAnchor(it, portName, side) {
  if (!it) return { x: 0, y: 0 };
  const p = portsOf(it);
  if (portName && p.out.includes(portName)) return portPointAt(it, 'right', p.out.indexOf(portName), p.out.length);
  if (portName && p.in.includes(portName)) {
    const idx = p.in.indexOf(portName);
    return portPointAt(it, 'left', idx, p.in.length);
  }
  return portPoint(it, side || 'right', 0);
}

/**
 * 列出某节点在某一侧的全部可命中端口：类型化端口 + **始终保留的旧中点圆点**
 * 旧中点必须是可命中的（名为 null），否则历史「语义关系线」的拖拽起点会失效（审计已覆盖该回归）。
 */
function portsOnSide(it, side) {
  const p = portsOf(it);
  const names = side === 'right' ? p.out : p.in;
  const out = names.map((name, i) => ({ name, side, p: portPointAt(it, side, i, names.length) }));
  out.push({ name: null, side, p: portPoint(it, side, 0) });   // 语义端口：老行为，永远可拖
  return out;
}

/** 绘制节点端口（类型化端口按数量均分；悬停/选中时放大高亮；LOD 简时跳过，避免低缩放卡顿） */
function drawPorts(g, L) {
  if (lodLevel() === 0) return;
  const items = L.drawOrder || L.items || [];
  g.save();
  for (const it of items) {
    const sel = S.selection.has(it.actor?.id) || S.selectedExtra === it.id || S.selectedNote === it.id
      || (it.groupId && S.selectedGroup === it.groupId);
    const hover = S.hover === (it.actor?.id || it.id);
    if (!sel && !hover && !S.linkingSticky) continue;
    for (const side of ['right', 'left']) {
      for (const port of portsOnSide(it, side)) {
        const hot = S.hoverPort && S.hoverPort.item === it && S.hoverPort.side === side
          && (S.hoverPort.name || null) === port.name;
        const rr = Math.max(4, (hot ? 8 : 5.5) / S.zoom);
        g.beginPath();
        g.arc(port.p.x, port.p.y, rr, 0, Math.PI * 2);
        g.fillStyle = port.name ? portColor(port.name) : (side === 'right' ? '#6d8cff' : '#23d5c0');
        g.fill();
        g.lineWidth = 1.4 / S.zoom;
        g.strokeStyle = 'rgba(255,255,255,.92)';
        g.stroke();
        // 类型化端口在高倍率下标注端口名，便于确认连的是哪个槽位
        if (port.name && S.zoom >= 0.75) {
          const fs = Math.max(9, 10 / S.zoom);
          g.font = `600 ${fs}px var(--sans, sans-serif)`;
          g.fillStyle = 'rgba(219,230,255,.86)';
          g.textAlign = side === 'right' ? 'left' : 'right';
          g.textBaseline = 'middle';
          g.fillText(port.name, port.p.x + (side === 'right' ? 8 / S.zoom : -8 / S.zoom), port.p.y);
          g.textAlign = 'left'; g.textBaseline = 'alphabetic';
        }
      }
    }
  }
  g.restore();
}

/** 命中端口（类型化端口优先，回退到旧中点圆点；返回 { item, side, name }） */
function hitPort(x, y) {
  const items = S._layout?.drawOrder || S._layout?.items || [];
  const rr = Math.max(7, 11 / S.zoom);
  let best = null;
  let bestD = Infinity;
  for (const it of items) {
    for (const side of ['right', 'left']) {
      for (const port of portsOnSide(it, side)) {
        const d = Math.hypot(x - port.p.x, y - port.p.y);
        // 类型化端口优先命中（同名多端口时取最近一个）
        const score = d - (port.name ? 0.01 : 0);
        if (d <= rr && score < bestD) { bestD = score; best = { item: it, side, name: port.name }; }
      }
    }
  }
  return best;
}

/** 命中连线（对曲线采样，最近点距离小于阈值即命中） */
function hitLink(x, y) {
  const links = S.links || [];
  if (!links.length) return null;
  const byId = new Map((S._layout?.items || []).map((it) => [it.id, it]));
  const tol = Math.max(6, 10 / S.zoom);
  for (let i = links.length - 1; i >= 0; i--) {
    const link = links[i];
    const a = byId.get(link.from_node) || (link.from_actor ? [...byId.values()].find((it) => it.actorId === link.from_actor) : null);
    const b = byId.get(link.to_node) || (link.to_actor ? [...byId.values()].find((it) => it.actorId === link.to_actor) : null);
    if (!a || !b) continue;
    const p1 = edgeAnchor(a, link.from_port, link.from_side || 'right');
    const p2 = edgeAnchor(b, link.to_port, link.to_side || 'left');
    const dx = Math.max(40 / S.zoom, Math.abs(p2.x - p1.x) * 0.45);
    const c1 = { x: p1.x + dx * (link.from_side === 'left' ? -1 : 1), y: p1.y };
    const c2 = { x: p2.x - dx * (link.to_side === 'right' ? -1 : 1), y: p2.y };
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const px = cubic(t, p1.x, c1.x, c2.x, p2.x);
      const py = cubic(t, p1.y, c1.y, c2.y, p2.y);
      if (Math.hypot(px - x, py - y) <= tol) return link;
    }
  }
  return null;
}

/** 小地图：右下角缩略图 + 当前视口矩形（可点击/拖拽跳转） */
function drawMinimap() {
  const mini = rootEl?.querySelector('#ac-minimap');
  if (!mini) return;
  if (S.showMinimap === false) { mini.classList.add('hidden'); return; }
  mini.classList.remove('hidden');
  const L = S._layout;
  const cv = canvasEl();
  if (!L || !cv) return;
  const dpr = window.devicePixelRatio || 1;
  const mw = mini.clientWidth || 200;
  const mh = mini.clientHeight || 140;
  if (mini.width !== Math.round(mw * dpr)) { mini.width = Math.round(mw * dpr); mini.height = Math.round(mh * dpr); }
  const g = mini.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, mw, mh);
  g.fillStyle = 'rgba(8,12,20,.92)';
  g.fillRect(0, 0, mw, mh);

  const viewW = cv.clientWidth / S.zoom;
  const viewH = cv.clientHeight / S.zoom;
  const vx = -S.panX; const vy = -S.panY;
  const minX = Math.min(L.bounds.minX, vx);
  const minY = Math.min(L.bounds.minY, vy);
  const maxX = Math.max(L.bounds.maxX, vx + viewW);
  const maxY = Math.max(L.bounds.maxY, vy + viewH);
  const pad = 20;
  const scale = Math.min((mw - pad) / Math.max(1, maxX - minX), (mh - pad) / Math.max(1, maxY - minY));
  const ox = (mw - (maxX - minX) * scale) / 2 - minX * scale;
  const oy = (mh - (maxY - minY) * scale) / 2 - minY * scale;
  S._mini = { scale, ox, oy };

  for (const it of L.items) {
    g.fillStyle = S.selection.has(it.actor.id) ? 'rgba(109,140,255,.85)' : `hsla(${styleHue(it.actor.style_id)},60%,55%,.55)`;
    g.fillRect(ox + it.x * scale, oy + it.y * scale, Math.max(2, it.w * scale), Math.max(2, it.h * scale));
  }
  g.strokeStyle = 'rgba(255,255,255,.75)';
  g.lineWidth = 1.2;
  g.strokeRect(ox + vx * scale, oy + vy * scale, viewW * scale, viewH * scale);
}

function minimapNavigate(clientX, clientY) {
  const mini = rootEl?.querySelector('#ac-minimap');
  const cv = canvasEl();
  if (!mini || !cv || !S._mini) return;
  const r = mini.getBoundingClientRect();
  const lx = clientX - r.left; const ly = clientY - r.top;
  const wx = (lx - S._mini.ox) / S._mini.scale;
  const wy = (ly - S._mini.oy) / S._mini.scale;
  S.panX = -(wx - cv.clientWidth / S.zoom / 2);
  S.panY = -(wy - cv.clientHeight / S.zoom / 2);
  draw();
}

function drawSelectionBox(g) {
  const sel = (S._layout?.items || []).filter((i) => S.selection.has(i.actor.id));
  if (sel.length < 2) return;
  const x1 = Math.min(...sel.map((s) => s.x)); const y1 = Math.min(...sel.map((s) => s.y));
  const x2 = Math.max(...sel.map((s) => s.x + s.w)); const y2 = Math.max(...sel.map((s) => s.y + s.h));
  g.save();
  g.strokeStyle = 'rgba(165,107,255,.75)';
  g.setLineDash([7, 5]);
  g.lineWidth = 1.5 / S.zoom;
  roundRect(g, x1 - 8, y1 - 8, x2 - x1 + 16, y2 - y1 + 16, 14);
  g.stroke();
  g.restore();
}

function clip(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s; }

// ---------------- 交互 ----------------
function hitTest(x, y) {
  // 从绘制顺序的顶部（z 最大）开始命中
  const items = S._layout?.drawOrder || S._layout?.items || [];
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (x >= it.x && x <= it.x + it.w && y >= it.y && y <= it.y + it.h) return it;
  }
  return null;
}

/** 命中分组框（只认标题栏与边框，避免挡住卡片操作） */
function hitGroup(x, y, { borderOnly = true } = {}) {
  const frames = (S._layout?.groups || []);
  const headerH = Math.max(22, 30 / S.zoom);
  const edge = Math.max(6, 10 / S.zoom);
  for (let i = frames.length - 1; i >= 0; i--) {
    const gr = frames[i];
    const h = gr.collapsed ? headerH : gr.h;
    const inX = x >= gr.x - edge && x <= gr.x + gr.w + edge;
    const inY = y >= gr.y - edge && y <= gr.y + h + edge;
    if (!inX || !inY) continue;
    const inHeader = y <= gr.y + headerH;
    const onEdge = x <= gr.x + edge || x >= gr.x + gr.w - edge || y >= gr.y + h - edge;
    if (inHeader) return { group: gr, zone: 'header' };
    if (!borderOnly || onEdge) return { group: gr, zone: onEdge ? 'edge' : 'body' };
  }
  return null;
}

/** 命中缩放手柄：只有卡片/便签右下角的小方块才算（此前把整张便签都当成了手柄） */
function hitResizeHandle(x, y) {
  const it = hitTest(x, y);
  if (!it) return null;
  const pad = Math.max(16, 20 / S.zoom);
  if (x >= it.x + it.w - pad && y >= it.y + it.h - pad) return { item: it };
  return null;
}

function selectOnly(id) { S.selection = new Set(id ? [id] : []); S.selectedOrder = id ? [id] : []; S.currentActor = id || null; }
function addToSelection(id) {
  if (S.selection.has(id)) { S.selection.delete(id); S.selectedOrder = S.selectedOrder.filter((x) => x !== id); }
  else { S.selection.add(id); S.selectedOrder.push(id); }
  S.currentActor = id;
}
function toggleSelect(id) { addToSelection(id); updateCount(); renderList(); draw(); }
function selectAllVisible() {
  S.selection = new Set(filteredActors().map((a) => a.id));
  S.selectedOrder = [...S.selection];
  updateCount(); renderList(); draw();
}
function clearSelection() { S.selection = new Set(); S.selectedOrder = []; updateCount(); renderList(); draw(); }

/** 自由模式下拖动时的吸附 + 对齐参考线 */
function snapPosition(it, nx, ny, others) {
  const threshold = 6;
  const guides = [];
  let x = nx; let y = ny;
  const candsX = others.flatMap((o) => [o.x, o.x + o.w / 2, o.x + o.w]);
  const candsY = others.flatMap((o) => [o.y, o.y + o.h / 2, o.y + o.h]);
  const selfX = [nx, nx + it.w / 2, nx + it.w];
  const selfY = [ny, ny + it.h / 2, ny + it.h];

  for (const sx of selfX) {
    for (const cx of candsX) {
      if (Math.abs(sx - cx) <= threshold) {
        x = nx + (cx - sx);
        guides.push({ axis: 'x', pos: cx, from: Math.min(ny, ...others.map((o) => o.y)) - 20, to: Math.max(ny + it.h, ...others.map((o) => o.y + o.h)) + 20 });
        break;
      }
    }
  }
  for (const sy of selfY) {
    for (const cy of candsY) {
      if (Math.abs(sy - cy) <= threshold) {
        y = ny + (cy - sy);
        guides.push({ axis: 'y', pos: cy, from: Math.min(nx, ...others.map((o) => o.x)) - 20, to: Math.max(nx + it.w, ...others.map((o) => o.x + o.w)) + 20 });
        break;
      }
    }
  }
  if (S.snap) {
    if (!guides.length) {
      // 无参考线：吸附到半格网格
      const grid = S.cell / 2;
      x = Math.round(nx / grid) * grid;
      y = Math.round(ny / grid) * grid;
    } else {
      // 有参考线：对齐到邻卡边缘的同时**保持整数坐标**。
      // 参考线吸附是在「原始（可能带小数的）拖拽坐标」上做偏移，不做这步会把 147.5555 这类小数写进库，
      // 既让「坐标应为整数」的既定契约失效，也让后续对齐/吸附累积误差。
      x = Math.round(x);
      y = Math.round(y);
    }
  }
  return { x, y, guides: guides.slice(0, 4) };
}

function bindCanvasEvents() {
  const cv = canvasEl();
  if (!cv) return;
  // 平移状态挂在 S 上（而不是闭包变量），这样 __acDebug 与外部自动化都能观测到它是否已复位
  S.panning = null;

  const mini = rootEl?.querySelector('#ac-minimap');
  if (mini) {
    let draggingMini = false;
    mini.addEventListener('mousedown', (ev) => { ev.preventDefault(); draggingMini = true; minimapNavigate(ev.clientX, ev.clientY); });
    mini.addEventListener('mousemove', (ev) => { if (draggingMini) minimapNavigate(ev.clientX, ev.clientY); });
    window.addEventListener('mouseup', () => { draggingMini = false; });
  window.addEventListener('blur', () => { S.panning = null; draggingMini = false; S.linking = null; });
  }

  // 从左侧演员列表拖入画布：落在分组框内 → 放入该组；否则放置到落点
  cv.addEventListener('dragover', (ev) => { ev.preventDefault(); ev.dataTransfer.dropEffect = 'copy'; });
  cv.addEventListener('drop', async (ev) => {
    ev.preventDefault();
    const actorId = ev.dataTransfer.getData('text/plain');
    if (!actorId || !S.actors.some((a) => a.id === actorId)) return;
    const world = toWorld(ev.clientX, ev.clientY);
    const gHit = hitGroup(world.x, world.y, { borderOnly: false });
    pushUndo();
    try {
      const existing = S.nodes.get(actorId);
      const w = existing?.w || S.cell; const h = existing?.h || S.cell;
      let x = Math.round(world.x - w / 2); let y = Math.round(world.y - h / 2);
      if (gHit) {
        const gr = gHit.group;
        x = Math.max(gr.x + 20, Math.min(x, gr.x + gr.w - w - 20));
        y = Math.max(gr.y + Math.max(40, 34 / S.zoom), Math.min(y, gr.y + Math.max(60, gr.h) - h - 20));
      } else if (S.snap) {
        const grid = S.cell / 2;
        x = Math.round(x / grid) * grid; y = Math.round(y / grid) * grid;
      }
      await api.post('/api/canvas/node', { canvas_id: S.canvasId, actor_id: actorId, x, y, w, h, z: 99000 });
      if (gHit) await api.post(`/api/canvas/groups/${gHit.group.id}/members`, { actorIds: [actorId] });
      await loadCanvas();
      S.mode = 'free';
      updateModeButton();
      selectOnly(actorId);
      updateCount(); renderList(); draw();
      ensureVisible({ x, y, w, h });
      draw();
      toast(gHit ? `已把 ${actorId} 拖入分组「${gHit.group.name || ''}」` : `已把 ${actorId} 放置到画布`, 'ok');
    } catch (e) { toast('拖入失败：' + e.message, 'err'); }
  });

  cv.addEventListener('mousedown', (ev) => {
    closeContextMenu();
    const world = toWorld(ev.clientX, ev.clientY);
    const panMode = ev.button === 1 || ev.altKey || S.spaceDown || S.moveMode;

    // 平移起手：左键 + (Alt/空格/移动模式)，或直接中键拖拽（画布提示语承诺了中键平移）
    if (panMode && (ev.button === 0 || ev.button === 1)) {
      S.panning = { x: ev.clientX - S.panX * S.zoom, y: ev.clientY - S.panY * S.zoom };
      ev.preventDefault();
      return;
    }
    if (ev.button !== 0) return;

    // ⓿ 端口 / 连线
    if (ev.button === 0 && !panMode) {
      const port = hitPort(world.x, world.y);
      // 已选起点后直接点在目标端口上 → 建立「类型化数据流边」
      if (S.linkingSticky && port && port.item.id !== S.linkingSticky.fromId) {
        const from = S.linkingSticky;
        S.linkingSticky = null;
        openLinkLabelPicker(from, { id: port.item.id, item: port.item, port: port.name });
        return;
      }
      if (port) {
        pushUndo();
        S.linking = { fromId: port.item.id, side: port.side, port: port.name || null, x: world.x, y: world.y, moved: false };
        S.linkingSticky = null;
        draw();
        return;
      }
      if (S.linkingSticky) {
        const it = hitTest(world.x, world.y);
        if (it && it.id !== S.linkingSticky.fromId) {
          const from = S.linkingSticky;
          S.linkingSticky = null;
          openLinkLabelPicker(from, { id: it.id, item: it });
          return;
        }
        S.linkingSticky = null;
      }
      const lk = hitLink(world.x, world.y);
      if (lk && !hitTest(world.x, world.y)) {
        S.selectedLink = lk.id; S.selectedExtra = null; S.selectedNote = null; S.selectedGroup = null;
        draw();
        return;
      }
    }

    // ⓿ 缩略轨拖拽调序（优先于节点拖动，否则会变成拖走整个成片节点）
    if (!panMode) {
      const ct = hitClipThumb(world.x, world.y);
      if (ct) {
        S.selectedExtra = ct.item.id; S.selectedNote = null; S.selectedGroup = null;
        S.clipDrag = { nodeId: ct.item.id, from: ct.index, to: ct.index };
        draw();
        ev.preventDefault();
        return;
      }
    }

    // ① 缩放手柄
    const handle = hitResizeHandle(world.x, world.y);
    if (handle) {
      pushUndo();
      if (handle.item.kind === 'note') { S.selectedNote = handle.item.id; S.selectedGroup = null; }
      else { S.selectedNote = null; S.selectedGroup = null; if (!S.selection.has(handle.item.actor.id)) selectOnly(handle.item.actor.id); }
      S.dragging = { kind: 'resize', id: handle.item.kind === 'note' ? handle.item.id : handle.item.actor.id, item: handle.item, sx: world.x, sy: world.y, ow: handle.item.w, oh: handle.item.h };
      updateCount(); renderList(); draw();
      return;
    }

    const hit = hitTest(world.x, world.y);
    // ② 分组框（标题栏拖动整体移动；边缘拖动改大小）
    const gHit = hitGroup(world.x, world.y);
    if (!hit && gHit) {
      S.selectedGroup = gHit.group.id; S.selectedNote = null;
      pushUndo();
      if (gHit.zone === 'header') {
        S.dragging = { kind: 'group-move', group: gHit.group, sx: world.x, sy: world.y, members: (S._layout.items || []).filter((i2) => i2.groupId === gHit.group.id).map((i2) => ({ id: i2.actor.id, kind: i2.kind, x: i2.x, y: i2.y })) };
      } else {
        S.dragging = { kind: 'group-resize', group: gHit.group, sx: world.x, sy: world.y, ow: gHit.group.w, oh: gHit.group.h };
      }
      draw();
      return;
    }

    if (hit) {
      if (hit.kind === 'note' || ['scene', 'item', 'refimg', ...FLOW_KINDS].includes(hit.kind)) {
        if (hit.kind === 'note') { S.selectedNote = hit.id; } else { S.selectedNote = null; }
        S.selectedExtra = hit.id;
        S.selectedGroup = null; S.selectedLink = null;
        S.selection = new Set(); S.selectedOrder = [];
        updateCount(); renderList();
        pushUndo();
        S.dragging = { kind: 'note-move', id: hit.id, sx: world.x, sy: world.y, ox: hit.x, oy: hit.y };
        draw();
        return;
      }
      S.selectedGroup = null; S.selectedNote = null;
      S.selectedExtra = null;      // 点演员卡时清掉此前选中的资产/便签节点，避免混入组合出图
      S.selectedLink = null;
      if (ev.ctrlKey || ev.metaKey || ev.shiftKey) addToSelection(hit.actor.id);
      else if (!S.selection.has(hit.actor.id)) selectOnly(hit.actor.id);
      else S.currentActor = hit.actor.id;
      updateCount(); renderList(); draw();
      if (!hit.locked) {
        pushUndo();
        S.dragging = {
          kind: 'move', id: hit.actor.id, sx: world.x, sy: world.y,
          origin: new Map([...S.selection].map((id) => {
            const n = S.nodes.get(id) || S._itemsById.get(id);
            return [id, { x: n?.x ?? 0, y: n?.y ?? 0 }];
          })),
          moved: false,
        };
      }
    } else {
      if (!ev.shiftKey && !ev.ctrlKey && !ev.metaKey) {
        clearSelection();
        S.selectedNote = null;
        S.selectedGroup = null;
      }
      S.marquee = { x0: world.x, y0: world.y, x1: world.x, y1: world.y, additive: ev.shiftKey || ev.ctrlKey || ev.metaKey, base: new Set(S.selection) };
    }
  });

  cv.addEventListener('mousemove', (ev) => {
    const world = toWorld(ev.clientX, ev.clientY);
    if (S.clipDrag) {
      const to = clipIndexAt(S.clipDrag.nodeId, world.x);
      if (to >= 0 && to !== S.clipDrag.to) { S.clipDrag.to = to; draw(); }
      return;
    }
    if (S.panning) { S.panX = (ev.clientX - S.panning.x) / S.zoom; S.panY = (ev.clientY - S.panning.y) / S.zoom; scheduleViewSave(); draw(); return; }

    if (S.marquee) {
      S.marquee.x1 = world.x; S.marquee.y1 = world.y;
      const x0 = Math.min(S.marquee.x0, world.x); const x1 = Math.max(S.marquee.x0, world.x);
      const y0 = Math.min(S.marquee.y0, world.y); const y1 = Math.max(S.marquee.y0, world.y);
      const inside = new Set((S._layout?.items || [])
        .filter((it) => it.x + it.w > x0 && it.x < x1 && it.y + it.h > y0 && it.y < y1)
        .map((it) => it.actor.id));
      S.selection = S.marquee.additive ? new Set([...S.marquee.base, ...inside]) : inside;
      S.selectedOrder = [...S.selection];
      if (S.selection.size) S.currentActor = [...S.selection][S.selection.size - 1];
      updateCount(); draw();
      return;
    }

    if (S.linking) {
      const movedDist = Math.hypot(world.x - S.linking.x, world.y - S.linking.y);
      if (movedDist > 4 / S.zoom) S.linking.moved = true;
      S.linking.x = world.x; S.linking.y = world.y;
      const port = hitPort(world.x, world.y);
      S.hoverPort = port;
      draw();
      return;
    }
    if (S.dragging && S.dragging.kind === 'resize') {
      const d = S.dragging;
      const w = Math.max(90, Math.min(900, d.ow + (world.x - d.sx)));
      const h = Math.max(90, Math.min(1200, d.oh + (world.y - d.sy)));
      if (d.item.kind === 'note') {
        const n = (S.noteNodes || []).find((x2) => x2.id === d.id);
        if (n) { n.w = Math.round(w); n.h = Math.round(h); }
      } else {
        const node = S.nodes.get(d.id);
        if (node) { node.w = Math.round(w); node.h = Math.round(h); }
      }
      S.dirty = true; draw(); return;
    }
    if (S.dragging && S.dragging.kind === 'note-move') {
      const d = S.dragging;
      const n = (S.noteNodes || []).find((x2) => x2.id === d.id) || (S.assetNodes || []).find((x2) => x2.id === d.id);
      if (n) {
        let nx = d.ox + (world.x - d.sx); let ny = d.oy + (world.y - d.sy);
        if (S.snap) { const grid = S.cell / 2; nx = Math.round(nx / grid) * grid; ny = Math.round(ny / grid) * grid; }
        n.x = Math.round(nx); n.y = Math.round(ny);
        S.dirty = true;
      }
      draw(); return;
    }
    if (S.dragging && (S.dragging.kind === 'group-move' || S.dragging.kind === 'group-resize')) {
      const d = S.dragging;
      const dx = world.x - d.sx; const dy = world.y - d.sy;
      d.moved = d.moved || Math.abs(dx) > 3 || Math.abs(dy) > 3;
      if (!d.moved) return;
      if (d.kind === 'group-move') {
        let sdx = dx; let sdy = dy;
        if (S.snap) { const grid = S.cell / 2; sdx = Math.round(dx / grid) * grid; sdy = Math.round(dy / grid) * grid; }
        d.group.x = Math.round(d.group.x + sdx - (d.appliedDx || 0));
        d.group.y = Math.round(d.group.y + sdy - (d.appliedDy || 0));
        d.appliedDx = sdx; d.appliedDy = sdy;
        for (const m of d.members) {
          if (m.kind === 'note') { const n = (S.noteNodes || []).find((x2) => x2.id === m.id); if (n) { n.x = m.x + sdx; n.y = m.y + sdy; } }
          else { const node = S.nodes.get(m.id); if (node) { node.x = m.x + sdx; node.y = m.y + sdy; } }
        }
      } else {
        d.group.w = Math.max(120, Math.round(d.ow + dx));
        d.group.h = Math.max(60, Math.round(d.oh + dy));
      }
      S.dirty = true; draw(); return;
    }
    if (S.dragging && S.dragging.kind === 'move') {
      const d = S.dragging;
      const dx = world.x - d.sx; const dy = world.y - d.sy;
      d.moved = d.moved || Math.abs(dx) > 3 || Math.abs(dy) > 3;
      if (!d.moved) return;

      if (S.mode === 'matrix') {
        const target = hitTest(world.x, world.y);
        if (target && target.actor.id !== d.id && !target.locked) { reorder(d.id, target.actor.id); d.sx = world.x; d.sy = world.y; d.origin = new Map(); }
        return;
      }
      // 自由模式：多选整体移动 + 吸附
      const others = (S._layout?.items || []).filter((it) => !S.selection.has(it.actor.id));
      let applied = null;
      for (const [id, origin] of d.origin.entries()) {
        const it = S._itemsById.get(id);
        if (!it) continue;
        const raw = { x: origin.x + dx, y: origin.y + dy };
        const snapped = snapPosition(it, raw.x, raw.y, others);
        if (!applied) applied = snapped;
        S.nodes.set(id, { actor_id: id, x: snapped.x, y: snapped.y, w: it.w, h: it.h });
      }
      S.guides = applied?.guides || [];
      S.dirty = true;
      draw();
      return;
    }

    const hit = hitTest(world.x, world.y);
    const id = hit?.actor.id || null;
    if (id !== S.hover) { S.hover = id; cv.style.cursor = S.moveMode || S.spaceDown ? 'grab' : (id ? 'pointer' : 'default'); draw(); }
  });

  window.addEventListener('mouseup', async () => {
    if (!S) return;
    if (S.clipDrag) {
      const drag = S.clipDrag;
      S.clipDrag = null;
      await applyClipReorder(drag);
      return;
    }
    // 松手即结束平移：不复位会导致之后「不按键移动鼠标也在平移」，并让框选/拖拽/缩放/连线全部失灵
    if (S.panning) { S.panning = null; scheduleViewSave(); }
    if (S.linking) {
      const from = S.linking;
      S.linking = null;
      // 只有真正拖动过才算“连到目标”：落在目标端口上 → 类型化边；落在节点上 → 语义关系线
      const targetPort = from.moved ? hitPort(from.x, from.y) : null;
      const target = from.moved ? hitTest(from.x, from.y) : null;
      if (targetPort && targetPort.item.id !== from.fromId && targetPort.name) {
        openLinkLabelPicker({ fromId: from.fromId, side: from.side, port: from.port },
          { id: targetPort.item.id, item: targetPort.item, port: targetPort.name });
      } else if (target && target.id !== from.fromId) {
        openLinkLabelPicker({ fromId: from.fromId, side: from.side }, { id: target.id, item: target });
      } else {
        // 单击端口（或拖到空白处）→ 记住起点，下一次点击目标节点即连线
        S.linkingSticky = { fromId: from.fromId, side: from.side, port: from.port || null };
        toast('已选择起点端口，点击目标节点（或目标端口）完成连线（Esc 取消）', 'info', 2600);
      }
      draw();
      return;
    }
    // 便签移动/缩放
    const extraKind = S.dragging?.item?.kind || (S.dragging ? (S.noteNodes || []).find((x2) => x2.id === S.dragging.id) ? 'note' : (S.assetNodes || []).find((x2) => x2.id === S.dragging.id)?.kind : null);
    if (S.dragging && (S.dragging.kind === 'note-move' || (S.dragging.kind === 'resize' && ['note', 'scene', 'item', 'refimg', ...FLOW_KINDS].includes(S.dragging.item?.kind))) && S.dirty) {
      const id = S.dragging.id;
      const n = (S.noteNodes || []).find((x2) => x2.id === id);
      const a = (S.assetNodes || []).find((x2) => x2.id === id);
      try {
        if (n) await api.put('/api/canvas/notes/' + id, { x: n.x, y: n.y, w: n.w, h: n.h });
        else if (a) await api.put('/api/canvas/assets/' + id, { x: a.x, y: a.y, w: a.w, h: a.h });
        S.dirty = false;
      } catch (e) { toast('节点保存失败：' + e.message, 'err'); }
    }
    // 卡片缩放
    if (S.dragging && S.dragging.kind === 'resize' && S.dragging.item?.kind !== 'note' && S.dirty) {
      const id = S.dragging.id;
      const node = S.nodes.get(id);
      const it = S._itemsById.get(id);
      if (node && it) {
        try { await api.post('/api/canvas/nodes', { nodes: [{ canvas_id: S.canvasId, actor_id: id, x: it.x, y: it.y, w: it.w, h: it.h }] }); S.dirty = false; } catch (e) { toast('尺寸保存失败：' + e.message, 'err'); }
      }
    }
    // 分组移动 / 缩放
    if (S.dragging && (S.dragging.kind === 'group-move' || S.dragging.kind === 'group-resize') && S.dirty) {
      const gr = S.dragging.group;
      try {
        if (S.dragging.kind === 'group-move') {
          await api.post(`/api/canvas/groups/${gr.id}/move`, { dx: S.dragging.appliedDx || 0, dy: S.dragging.appliedDy || 0 });
        } else {
          await api.put('/api/canvas/groups/' + gr.id, { w: gr.w, h: gr.h });
        }
        S.dirty = false;
        await loadCanvas();
      } catch (e) { toast('分组保存失败：' + e.message, 'err'); }
    }
    // 拖拽结束：若卡片落在某个分组框内（且未属于该组）→ 自动归组
    if (S.dragging && S.dragging.kind === 'move' && S.dragging.moved && S.mode === 'free') {
      const it = S._itemsById.get(S.dragging.id);
      if (it) {
        const gHit = hitGroup(it.x + it.w / 2, it.y + it.h / 2, { borderOnly: false });
        if (gHit && it.groupId !== gHit.group.id) {
          try {
            await api.post(`/api/canvas/groups/${gHit.group.id}/members`, { actorIds: [it.actor.id] });
            toast(`已归入分组「${gHit.group.name || ''}」`, 'ok', 1600);
            await loadCanvas();
          } catch (e) { toast('归组失败：' + e.message, 'err'); }
        }
      }
    }
    if (S.dragging && S.dragging.kind === 'move' && S.dragging.moved && S.mode === 'free' && S.dirty) {
      const nodes = [...S.selection].map((id) => {
        const n = S.nodes.get(id);
        const it = S._itemsById.get(id);
        return n ? { canvas_id: S.canvasId, actor_id: id, x: n.x, y: n.y, w: it?.w, h: it?.h } : null;
      }).filter(Boolean);
      if (nodes.length) {
        try { await api.post('/api/canvas/nodes', { nodes }); S.dirty = false; } catch (e) { toast('位置保存失败：' + e.message, 'err'); }
      }
    }
    if (S.marquee) { S.marquee = null; updateCount(); draw(); }
    S.dragging = null; S.guides = [];
    scheduleViewSave();
    draw();
  });

  cv.addEventListener('dblclick', (ev) => {
    const world = toWorld(ev.clientX, ev.clientY);
    const gHit = hitGroup(world.x, world.y);
    if (gHit && gHit.zone === 'header') { renameGroupDialog(gHit.group); return; }
    const hit = hitTest(world.x, world.y);
    if (!hit) { openActorEditor(null, { placeAt: { x: Math.round(world.x), y: Math.round(world.y) } }); return; }
    // T-L3 ①：流程节点/资产节点/便签 → 就地内联编辑（演员卡不在其列，双击仍打开档案，行为不变）
    if (inlineEditableKind(hit.kind)) { startInlineEdit(hit); return; }
    openProfile(hit.actor.id);
  });

  cv.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    const world = toWorld(ev.clientX, ev.clientY);
    const gCtx = hitGroup(world.x, world.y);
    if (gCtx && gCtx.zone === 'header') {
      S.selectedGroup = gCtx.group.id;
      groupContextMenu(ev.clientX, ev.clientY, gCtx.group);
      draw();
      return;
    }
    const hit = hitTest(world.x, world.y);
    if (!hit) {
      const lk = hitLink(world.x, world.y);
      if (lk) {
        S.selectedLink = lk.id;
        contextMenu(ev.clientX, ev.clientY, [
          { header: `关系线 · ${lk.label || '未命名'}` },
          { label: `起点：${nodeLabel(lk.from_node)} → 终点：${nodeLabel(lk.to_node)}`, disabled: true },
          { label: '✏️ 修改标签', onClick: async () => {
            const lb = await promptDialog('关系线标签', lk.label || '参考');
            if (lb === null) return;
            try { await api.post('/api/canvas/links', { canvas_id: S.canvasId, from_node: lk.from_node, to_node: lk.to_node, label: lb, from_side: lk.from_side, to_side: lk.to_side });
              const del = await api.get('/api/canvas/links?id=' + S.canvasId);
              // 简单做法：删除旧线再建新线
              await api.del('/api/canvas/links/' + lk.id);
              await loadCanvas(); draw(); toast('已更新标签', 'ok');
            } catch (e) { toast(e.message, 'err'); }
          } },
          { label: '🔄 反转方向', onClick: async () => {
            try {
              await api.post('/api/canvas/links', { canvas_id: S.canvasId, from_node: lk.to_node, to_node: lk.from_node, label: lk.label, from_side: lk.to_side || 'left', to_side: lk.from_side || 'right' });
              await api.del('/api/canvas/links/' + lk.id);
              await loadCanvas(); draw(); toast('已反转方向', 'ok');
            } catch (e) { toast(e.message, 'err'); }
          } },
          { separator: true },
          { label: '🗑 删除这条关系线', onClick: async () => { try { await api.del('/api/canvas/links/' + lk.id); S.selectedLink = null; await loadCanvas(); draw(); toast('已删除关系线', 'ok'); } catch (e) { toast(e.message, 'err'); } } },
        ]);
        draw();
        return;
      }
    }
    if (hit && ['scene', 'item', 'refimg', ...FLOW_KINDS].includes(hit.kind)) {
      S.selectedExtra = hit.id; S.selectedNote = null;
      const st = ASSET_STYLE[hit.kind];
      const flowItems = [];
      if (hit.kind === 'video') {
        flowItems.push(
          { label: '↻ 生成续写片段（自动接 clip → first，取本段尾帧当首帧）', onClick: async () => {
            try {
              const r = await api.post('/api/canvas/continuation', { canvasId: S.canvasId, fromNodeId: hit.id, move: hit.node?.data ? (JSON.parse(hit.node.data).move || '推镜') : '推镜' });
              await loadCanvas(); draw();
              toast('已创建续写片段（未生成）：执行计划里会取本段尾帧作为它的首帧', 'ok', 4200);
              const nx = S._itemsById?.get(r.nodeId);
              if (nx) { S.selectedExtra = r.nodeId; S.selection = new Set(); draw(); }
            } catch (e) { toast('创建续写片段失败：' + e.message, 'err', 3600); }
          } },
          { label: '⌛ 自动补尾帧（按本镜提示词建尾帧出图节点并接 last，不生成）', onClick: async () => {
            try {
              const r = await api.post('/api/canvas/auto-last', { canvasId: S.canvasId, nodeId: hit.id });
              await loadCanvas(); draw();
              toast('已建尾帧节点并接到 last：执行计划时会作为首尾帧过渡的尾帧（本操作不生成任何内容）', 'ok', 4600);
              S.selectedExtra = r.nodeId; S.selection = new Set(); draw();
            } catch (e) { toast('自动补尾帧失败：' + e.message, 'err', 4200); }
          } },
          { label: '▶ 生成 / 重跑该片段（走 DAG 单点重跑）', onClick: () => runCanvasNode(hit.id, '该片段') },
        );
      }
      if (hit.kind === 'timeline') {
        flowItems.push(
          { label: '👁 预览拼接顺序（dry-run）', onClick: () => timelineOrderDialog(hit.id) },
          { label: '🎬 立即成片（按 clip1..N 顺序）', onClick: () => runCanvasNode(hit.id, '成片') },
        );
      }
      if (hit.kind === 'shot') {
        flowItems.push({ label: '🎞 再铺一次该集分镜', onClick: () => spreadEpisodeDialog() });
      }
      if (hit.kind === 'overlay') {
        flowItems.push({ label: '✏️ 编辑叠加层（模式 / 位置 / 时间窗 / 不透明度）', onClick: () => overlayNodeDialog(hit.id) },
          { label: '▶ 执行该叠加层（取上游画面 + 参数）', onClick: () => runCanvasNode(hit.id, '叠加层') });
      }
      if (hit.kind === 'subtitle') {
        flowItems.push({ label: '✏️ 编辑字幕轨（SRT / 手工行 / 烧录方式）', onClick: () => subtitleNodeDialog(hit.id) },
          { label: '▶ 生成字幕文件（单点重跑）', onClick: () => runCanvasNode(hit.id, '字幕轨') });
      }
      if (hit.kind === 'audio') {
        flowItems.push(
          { label: '✏️ 编辑音频节点（台词 / 音色 / 文件）', onClick: () => audioNodeDialog(hit.id) },
          { label: '▶ 合成 / 重跑该音频（走 DAG 单点重跑）', onClick: () => runCanvasNode(hit.id, '音频') },
        );
      }
      if (FLOW_KINDS.includes(hit.kind)) flowItems.push({ label: '🧭 查看整图执行计划', onClick: () => planDialog() });
      contextMenu(ev.clientX, ev.clientY, [
        { header: `${st.icon} ${st.name} · ${hit.node?.title || ''}` },
        ...flowItems,
        { label: '✏️ 编辑内容 / 参考图', onClick: () => assetEditDialog(hit.id) },
        { label: '📎 上传参考图（可多选）', onClick: () => uploadAssetRefs(hit.id) },
        { label: '🎨 生成概念图（文生图）', onClick: () => generateAssetImage(hit.id) },
        { label: '⚡ 与选中演员组合出图', onClick: () => composeDialog([hit.id, ...currentSelectionNodeIds()]) },
    { label: '🎬 复制该节点的提示词/描述', onClick: () => {
      const a = hit.asset || {};
      const txt = [hit.node?.title, a.desc, a.timeOfDay, a.weather, a.category, (a.tags || []).join(', ')].filter(Boolean).join(' · ');
      navigator.clipboard?.writeText(txt);
      toast('已复制节点描述', 'ok');
    } },
        { label: '🔗 从右侧端口连线…', onClick: () => { const op = portsOf(hit).out[0] || null; S.linkingSticky = { fromId: hit.id, side: 'right', port: op }; toast(op ? `起点端口 ${op} 已选，点击目标节点（或端口）完成连线` : '已选择起点端口，点击目标节点完成连线', 'info', 2600); } },
        { label: '🔗 从左侧端口连线…', onClick: () => { S.linkingSticky = { fromId: hit.id, side: 'left', port: null }; toast('已选择起点端口，点击目标节点完成连线（左侧是输入侧，按语义关系线创建）', 'info', 2600); } },
        { label: '🧹 清理该节点的全部连线', onClick: async () => {
          try { const r = await api.del(`/api/canvas/nodes/${hit.id}/links`); await loadCanvas(); draw(); toast(`已清理 ${r.removed} 条连线`, 'ok'); }
          catch (e) { toast(e.message, 'err'); }
        } },
        { separator: true },
        { label: '🗂 组成分组', onClick: async () => { pushUndo(); const g = await api.post('/api/canvas/groups', { canvas_id: S.canvasId, name: '节点组', actorIds: [] }); await api.post(`/api/canvas/groups/${g.group.id}/move`, { dx: 0, dy: 0 }); await loadCanvas(); draw(); toast('已建分组（可把节点拖入）', 'ok'); } },
        { label: '🗑 删除节点', onClick: async () => { await api.del('/api/canvas/node/' + hit.id); await loadCanvas(); draw(); toast('节点已删除', 'ok'); } },
      ]);
      draw();
      return;
    }
    if (hit && hit.kind === 'note') {
      S.selectedNote = hit.id;
      contextMenu(ev.clientX, ev.clientY, [
        { header: '便签' },
        { label: '✏️ 编辑内容', onClick: () => noteEditDialog(hit.note) },
        { label: '🎨 换个颜色', onClick: async () => { const keys = Object.keys(NOTE_COLORS); const next = keys[(keys.indexOf(hit.note.note_color || 'amber') + 1) % keys.length]; await api.put('/api/canvas/notes/' + hit.id, { color: next }); await loadCanvas(); draw(); } },
        { label: '🗂 组成分组', onClick: async () => { await api.post('/api/canvas/groups', { canvas_id: S.canvasId, name: '便签组', nodes: [] }); } },
        { separator: true },
        { label: '🗑 删除便签', onClick: async () => { await api.del('/api/canvas/node/' + hit.id); await loadCanvas(); draw(); toast('便签已删除', 'ok'); } },
      ]);
      draw();
      return;
    }
    if (hit) {
      if (!S.selection.has(hit.actor.id)) { selectOnly(hit.actor.id); }
      actorContextMenu(ev.clientX, ev.clientY, [...S.selection]);
    } else {
      canvasContextMenu(ev.clientX, ev.clientY, world);
    }
    draw(); renderList();
  });

  cv.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    // 触控板双指平移：像素级 delta 且未按 ctrl（Ctrl/⌘+滚轮 = 缩放，鼠标滚轮 = 缩放）
    const pixel = ev.deltaMode === 0 && Math.abs(ev.deltaY) < 60 && !Number.isInteger(ev.deltaY);
    if ((ev.shiftKey && !ev.ctrlKey && !ev.metaKey) || (pixel && !ev.ctrlKey && !ev.metaKey)) {
      S.panX -= (ev.shiftKey ? ev.deltaY : ev.deltaX || ev.deltaY) / S.zoom;
      S.panY -= (ev.shiftKey ? 0 : ev.deltaY) / S.zoom;
      scheduleViewSave(); draw(); return;
    }
    if (ev.altKey) { S.panY -= ev.deltaY / S.zoom / 3; scheduleViewSave(); draw(); return; }
    const cvr = cv.getBoundingClientRect();
    const mx = ev.clientX - cvr.left; const my = ev.clientY - cvr.top;
    const before = { x: mx / S.zoom - S.panX, y: my / S.zoom - S.panY };
    S.zoom = clampZoom(S.zoom * (ev.deltaY < 0 ? 1.1 : 0.9));
    S.panX = mx / S.zoom - before.x;
    S.panY = my / S.zoom - before.y;
    scheduleViewSave(); draw();
  }, { passive: false });
}

function bindKeyboard() {
  S.onKeyDown = (ev) => {
    if (!rootEl || !S) return;
    const tag = (ev.target?.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || ev.target?.isContentEditable;
    if (ev.code === 'Space' && !typing) { S.spaceDown = true; const cv = canvasEl(); if (cv) cv.style.cursor = 'grab'; }
    if (typing) return;
    const mod = ev.ctrlKey || ev.metaKey;

    if (ev.key === 'Escape') {
      closeContextMenu();
      if (S.linkingSticky || S.linking) { S.linkingSticky = null; S.linking = null; draw(); return; }
      if (S.selectedLink) { S.selectedLink = null; draw(); return; }
      clearSelection();
      S.selectedExtra = null; S.selectedNote = null; S.selectedGroup = null;
      draw();
      return;
    }
    if (ev.key === 'Delete' || ev.key === 'Backspace') {
      if (S.selectedLink) {
        ev.preventDefault();
        (async () => { try { await api.del('/api/canvas/links/' + S.selectedLink); S.selectedLink = null; await loadCanvas(); draw(); toast('已删除关系线', 'ok'); } catch (e) { toast(e.message, 'err'); } })();
        return;
      }
      if (S.selectedExtra && !S.selectedNote) {
        ev.preventDefault();
        (async () => { try { await api.del('/api/canvas/node/' + S.selectedExtra); S.selectedExtra = null; await loadCanvas(); draw(); toast('节点已删除（连线一并清理）', 'ok'); } catch (e) { toast(e.message, 'err'); } })();
        return;
      }
      if (S.selectedNote) {
        ev.preventDefault();
        (async () => { await api.del('/api/canvas/node/' + S.selectedNote); S.selectedNote = null; await loadCanvas(); draw(); toast('便签已删除', 'ok'); })();
        return;
      }
      if (S.selectedGroup) {
        ev.preventDefault();
        const gr = (S.groupFrames || []).find((x2) => x2.id === S.selectedGroup);
        if (gr) dissolveGroup(gr, true);
        return;
      }
      if (S.selection.size) { ev.preventDefault(); deleteActors([...S.selection]); }
      return;
    }
    if (mod && ev.key.toLowerCase() === 'a') { ev.preventDefault(); selectAllVisible(); return; }
    if (mod && ev.key.toLowerCase() === 'd') { ev.preventDefault(); duplicateActors([...S.selection]); return; }
    if (mod && ev.key.toLowerCase() === 'z' && !ev.shiftKey) { ev.preventDefault(); undo(); return; }
    if (mod && (ev.key.toLowerCase() === 'y' || (ev.key.toLowerCase() === 'z' && ev.shiftKey))) { ev.preventDefault(); redo(); return; }
    if (mod && ev.key.toLowerCase() === 'g') { ev.preventDefault(); groupSelected(); return; }
    if (mod && ev.key.toLowerCase() === 'c') { ev.preventDefault(); copySelection(); return; }
    if (mod && ev.key.toLowerCase() === 'v') { ev.preventDefault(); pasteSelection(); return; }
    if (ev.key === ']') { ev.preventDefault(); bumpZ('top'); return; }
    if (ev.key === '[') { ev.preventDefault(); bumpZ('bottom'); return; }
    if (ev.key === 'Enter') { if (S.currentActor) openProfile(S.currentActor); return; }
    if (ev.key === '+' || ev.key === '=') { zoomBy(1.15); return; }
    if (ev.key === '-' || ev.key === '_') { zoomBy(0.87); return; }
    if (ev.key === '0') { resetView(); return; }
    if (ev.key.toLowerCase() === 'f') { fitView(); return; }
    if (mod && ev.key === '2') { ev.preventDefault(); zoomToSelection(); return; }
    if (ev.key === 'Home') { ev.preventDefault(); S.panX = 0; S.panY = 0; scheduleViewSave(); draw(); return; }
    if (mod && ev.key.toLowerCase() === 'l') { ev.preventDefault(); S.showLinks = !S.showLinks; scheduleViewSave(); draw(); return; }
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(ev.key)) {
      ev.preventDefault();
      const stepPx = ev.shiftKey ? 40 : 12;
      const dx = ev.key === 'ArrowLeft' ? -stepPx : ev.key === 'ArrowRight' ? stepPx : 0;
      const dy = ev.key === 'ArrowUp' ? -stepPx : ev.key === 'ArrowDown' ? stepPx : 0;
      nudgeSelection(dx, dy);
    }
  };
  S.onMouseUp = (ev) => { if (ev.code === 'Space') { S.spaceDown = false; const cv = canvasEl(); if (cv) cv.style.cursor = 'default'; } };
  window.addEventListener('keydown', S.onKeyDown);
  window.addEventListener('keyup', (ev) => { if (ev.code === 'Space' && S) { S.spaceDown = false; const cv = canvasEl(); if (cv) cv.style.cursor = 'default'; } });
}

/** 方向键微调：自由模式移动坐标，宫格模式交换顺序 */
async function nudgeSelection(dx, dy) {
  if (!S.selection.size) return;
  if (S.mode === 'matrix') {
    const list = filteredActors();
    const first = list.findIndex((a) => S.selection.has(a.id));
    if (first < 0) return;
    const delta = dx < 0 ? -1 : dx > 0 ? 1 : (dy < 0 ? -S.cols : S.cols);
    const target = first + delta;
    if (target < 0 || target >= list.length) return;
    await reorder(list[first].id, list[target].id);
    return;
  }
  const nodes = [];
  for (const id of S.selection) {
    const n = S.nodes.get(id) || S._itemsById.get(id);
    if (!n) continue;
    const nx = (n.x ?? 0) + dx; const ny = (n.y ?? 0) + dy;
    S.nodes.set(id, { actor_id: id, x: nx, y: ny });
    nodes.push({ canvas_id: S.canvasId, actor_id: id, x: nx, y: ny });
  }
  draw();
  if (nodes.length) { try { await api.post('/api/canvas/nodes', { nodes }); } catch { /* 忽略 */ } }
}

function zoomBy(f) { S.zoom = clampZoom(S.zoom * f); scheduleViewSave(); draw(); }

function resetView() { S.zoom = 1; S.panX = 0; S.panY = 0; S.lastFit = false; scheduleViewSave(); draw(); }

/** 适应窗口 */
function fitView() {
  const L = S._layout || computeLayout();
  if (!L.items.length) { resetView(); return; }
  const cv = canvasEl();
  const padding = 40;
  const w = L.bounds.maxX - L.bounds.minX + padding * 2;
  const h = L.bounds.maxY - L.bounds.minY + padding * 2;
  const zoom = clampZoom(Math.min(cv.clientWidth / w, cv.clientHeight / h));
  S.zoom = zoom;
  S.panX = -L.bounds.minX * zoom + (cv.clientWidth - (L.bounds.maxX - L.bounds.minX) * zoom) / 2 - padding * zoom;
  S.panY = -L.bounds.minY * zoom + (cv.clientHeight - (L.bounds.maxY - L.bounds.minY) * zoom) / 2 - padding * zoom;
  S.lastFit = true;
  draw();
  toast(`已适应窗口（${Math.round(zoom * 100)}%）`, 'info', 1600);
}

/** 把某个世界矩形平移进视野（不改缩放），用于成组/新建便签后自动定位 */
function ensureVisible(rect, pad = 40) {
  const cv = canvasEl();
  if (!cv || !rect) return;
  const vw = cv.clientWidth / S.zoom;
  const vh = cv.clientHeight / S.zoom;
  let panX = S.panX;
  let panY = S.panY;
  const left = rect.x + panX; const top = rect.y + panY;
  const right = rect.x + rect.w + panX; const bottom = rect.y + rect.h + panY;
  if (left < pad / S.zoom) panX += (pad / S.zoom) - left;
  if (top < pad / S.zoom) panY += (pad / S.zoom) - top;
  if (right > vw - pad / S.zoom) panX -= right - (vw - pad / S.zoom);
  if (bottom > vh - pad / S.zoom) panY -= bottom - (vh - pad / S.zoom);
  if (panX !== S.panX || panY !== S.panY) { S.panX = panX; S.panY = panY; scheduleViewSave(); }
}

/** 缩放到选中项（Ctrl+2） */
function zoomToSelection() {
  const sel = (S._layout?.items || []).filter((it) => S.selection.has(it.actor.id));
  if (!sel.length) { toast('先选中要放大的卡片', 'warn'); return; }
  const cv = canvasEl();
  const pad = 60;
  const x1 = Math.min(...sel.map((i) => i.x)); const y1 = Math.min(...sel.map((i) => i.y));
  const x2 = Math.max(...sel.map((i) => i.x + i.w)); const y2 = Math.max(...sel.map((i) => i.y + i.h));
  S.zoom = clampZoom(Math.min((cv.clientWidth - pad * 2) / (x2 - x1), (cv.clientHeight - pad * 2) / (y2 - y1)));
  S.panX = -(x1 - pad / S.zoom);
  S.panY = -(y1 - pad / S.zoom);
  scheduleViewSave(); draw();
}

/** 对齐（自由模式）：以选区包围盒为基准 */
async function alignSelection(mode) {
  const sel = (S._layout?.items || []).filter((it) => S.selection.has(it.actor.id));
  if (sel.length < 2) { toast('至少选择 2 张卡片', 'warn'); return; }
  pushUndo();
  const x1 = Math.min(...sel.map((i) => i.x)); const x2 = Math.max(...sel.map((i) => i.x + i.w));
  const y1 = Math.min(...sel.map((i) => i.y)); const y2 = Math.max(...sel.map((i) => i.y + i.h));
  const nodes = [];
  for (const it of sel) {
    let nx = it.x; let ny = it.y;
    if (mode === 'left') nx = x1;
    if (mode === 'right') nx = x2 - it.w;
    if (mode === 'center-x') nx = (x1 + x2) / 2 - it.w / 2;
    if (mode === 'top') ny = y1;
    if (mode === 'bottom') ny = y2 - it.h;
    if (mode === 'center-y') ny = (y1 + y2) / 2 - it.h / 2;
    S.nodes.set(it.actor.id, { actor_id: it.actor.id, x: nx, y: ny, w: it.w, h: it.h });
    nodes.push({ canvas_id: S.canvasId, actor_id: it.actor.id, x: nx, y: ny, w: it.w, h: it.h });
  }
  if (S.mode === 'matrix') { S.mode = 'free'; updateModeButton(); }
  draw();
  try { await api.post('/api/canvas/nodes', { nodes }); toast('已对齐', 'ok', 1200); } catch (e) { toast(e.message, 'err'); }
}

/** 等距分布 */
async function distributeSelection(axis) {
  const sel = (S._layout?.items || []).filter((it) => S.selection.has(it.actor.id));
  if (sel.length < 3) { toast('至少选择 3 张卡片', 'warn'); return; }
  pushUndo();
  const key = axis === 'x' ? 'x' : 'y';
  const sizeKey = axis === 'x' ? 'w' : 'h';
  const sorted = [...sel].sort((a, b) => a[key] - b[key]);
  const first = sorted[0]; const last = sorted[sorted.length - 1];
  const span = (last[key] + last[sizeKey]) - first[key];
  const totalSize = sorted.reduce((n, i) => n + i[sizeKey], 0);
  const gap = (span - totalSize) / (sorted.length - 1);
  let cursor = first[key];
  const nodes = [];
  for (const it of sorted) {
    const nx = axis === 'x' ? cursor : it.x;
    const ny = axis === 'y' ? cursor : it.y;
    S.nodes.set(it.actor.id, { actor_id: it.actor.id, x: nx, y: ny, w: it.w, h: it.h });
    nodes.push({ canvas_id: S.canvasId, actor_id: it.actor.id, x: nx, y: ny, w: it.w, h: it.h });
    cursor += it[sizeKey] + gap;
  }
  if (S.mode === 'matrix') { S.mode = 'free'; updateModeButton(); }
  draw();
  try { await api.post('/api/canvas/nodes', { nodes }); toast('已等距分布', 'ok', 1200); } catch (e) { toast(e.message, 'err'); }
}

/** 背景/网格选择器（无限画布背景：点阵 / 网格 / 无） */
function renderBgPicker() {
  const box = rootEl?.querySelector('#ac-bg-picker');
  if (!box) return;
  box.innerHTML = '';
  const bg = S.view?.bg || 'dots';
  const gridSize = S.view?.gridSize || 40;
  box.append(
    el('span', { class: 'small muted' }, ['背景']),
    select([
      { id: 'dots', name: '· 点阵' },
      { id: 'lines', name: '▦ 网格' },
      { id: 'none', name: '○ 纯色' },
    ], bg, (v) => { S.view = { ...(S.view || {}), bg: v }; scheduleViewSave(); draw(); }, { style: { width: '92px' } }),
    select([
      { id: '20', name: '网格 20' },
      { id: '40', name: '网格 40' },
      { id: '80', name: '网格 80' },
    ], String(gridSize), (v) => { S.view = { ...(S.view || {}), gridSize: Number(v) }; scheduleViewSave(); draw(); }, { style: { width: '104px' } }),
  );
}

/** 把演员表的全部演员放入当前画布（新画布填充的标准入口） */
async function putAllActors() {
  if (!S.actors.length) { toast('还没有演员可放入', 'warn'); return; }
  pushUndo();
  try {
    await api.post('/api/canvas/arrange', { id: S.canvasId, mode: 'matrix', cols: S.cols, cell: S.cell, gap: S.gap });
    await api.put('/api/canvas/show-all', { id: S.canvasId, showAll: true });
    S.mode = 'matrix';
    await loadCanvas();
    updateModeButton();
    draw();
    toast(`已把 ${S.actors.length} 位演员放入本画布`, 'ok');
  } catch (e) { toast('放入失败：' + e.message, 'err'); }
}

/** 清空本画布卡位（演员与素材不受影响） */
async function clearCurrentCanvas() {
  const name = S.canvases.find((c) => c.id === S.canvasId)?.name || S.canvasId;
  const isMain = S.canvasId === 'CV-MAIN';
  if (!(await confirmDialog(`清空「${name}」上的所有卡位与关系线？${isMain ? '\n\n⚠️ 这是主画布：清空后所有演员卡会从画布移除（演员档案与定妆图不受影响，可用「⊕ 放入全部」一键恢复）。' : '\n\n演员档案、定妆图、小说、剧本都不会受影响。'}`))) return;
  if (isMain && !(await confirmDialog('再次确认：清空主画布的全部卡位与关系线？'))) return;
  try {
    const r = await api.post('/api/canvas/clear', { id: S.canvasId });
    await api.put('/api/canvas/show-all', { id: S.canvasId, showAll: false });
    await loadCanvas();
    draw();
    toast(`已清空 ${r.removed} 个卡位`, 'ok');
  } catch (e) { toast('清空失败：' + e.message, 'err'); }
}

/** 宫格模式下按列数/格宽重排并落库 */
async function relayoutMatrix() {
  if (S.mode !== 'matrix') return;
  try { await api.post('/api/canvas/arrange', { id: S.canvasId, mode: 'matrix', cols: S.cols, cell: S.cell, gap: S.gap }); await loadCanvas(); }
  catch (e) { toast('重排失败：' + e.message, 'err'); }
}

async function reorder(fromId, toId) {
  const items = filteredActors();
  const fi = items.findIndex((a) => a.id === fromId);
  const ti = items.findIndex((a) => a.id === toId);
  if (fi < 0 || ti < 0 || fi === ti) return;
  const moved = items.splice(fi, 1)[0];
  items.splice(ti, 0, moved);
  // 本地先更新，界面即时反馈
  const orderIds = items.map((a) => a.id);
  S.actors.sort((a, b) => {
    const ia = orderIds.indexOf(a.id); const ib = orderIds.indexOf(b.id);
    if (ia >= 0 && ib >= 0) return ia - ib;
    return (a.sort ?? 0) - (b.sort ?? 0);
  });
  S.actors.forEach((a, i) => { a.sort = i; });
  renderList(); draw();
  try { await api.post('/api/actors/reorder', { ids: S.actors.map((a) => a.id) }); }
  catch (e) { toast('排序保存失败：' + e.message, 'err'); }
}

async function autoArrange(mode = 'matrix', groupBy = 'style_id') {
  pushUndo();
  try {
    const r = await api.post('/api/canvas/arrange', { id: S.canvasId, mode, groupBy, cols: S.cols, cell: S.cell, gap: S.gap });
    S.mode = 'matrix';
    await loadCanvas();
    updateModeButton();
    draw();
    toast(`已按 ${S.cols} 列宫格排布（${r.created} 个卡位）`, 'ok');
    setTimeout(() => fitView(), 60);
  } catch (e) { toast('排布失败：' + e.message, 'err'); }
}

function updateModeButton() {
  const b = rootEl?.querySelector('#ac-mode-btn');
  if (b) b.textContent = S.mode === 'matrix' ? '🔀 宫格模式' : '🔀 自由模式';
}

function toggleMode() {
  S.mode = S.mode === 'matrix' ? 'free' : 'matrix';
  if (S.mode === 'free') {
    // 把当前排布固化下来作为自由模式起点
    for (const it of (S._layout?.items || [])) {
      if (it.kind === 'note') continue;
      S.nodes.set(it.actor.id, { actor_id: it.actor.id, x: it.x, y: it.y, w: it.w, h: it.h });
    }
  }
  updateModeButton();
  toast(S.mode === 'matrix' ? '已切换：宫格矩阵模式（拖拽=换位）' : '已切换：自由拖拽模式（拖拽=摆放，自动吸附对齐）', 'info');
  draw();
}

/** 导出画布为 PNG 阵容图 */
function exportCanvasPNG() {
  const L = S._layout || computeLayout();
  if (!L.items.length) { toast('画布上没有演员', 'warn'); return; }
  const pad = 40; const scale = 2;
  const w = L.bounds.maxX - L.bounds.minX + pad * 2;
  const h = L.bounds.maxY - L.bounds.minY + pad * 2 + 40;
  const off = document.createElement('canvas');
  off.width = Math.round(w * scale); off.height = Math.round(h * scale);
  const g = off.getContext('2d');
  g.scale(scale, scale);
  g.fillStyle = '#080c14'; g.fillRect(0, 0, w, h);
  g.fillStyle = 'rgba(150,170,210,.9)';
  g.font = '600 18px sans-serif';
  g.fillText(`AI 漫剧 · 明星阵容矩阵（${L.items.length} 位演员） · ${new Date().toLocaleString('zh-CN')}`, pad, pad - 12);
  g.translate(pad - L.bounds.minX, pad + 20 - L.bounds.minY);
  for (const grp of L.groups) {
    if (!grp) continue;
    g.save(); g.font = '600 15px sans-serif'; g.fillStyle = 'rgba(140,160,200,.9)';
    g.fillText(`▚ ${grp.label}（${grp.count}）`, 22, (grp.y || 24) - 10);
    g.restore();
  }
  for (const it of L.items) drawCell(g, it);
  try {
    const url = off.toDataURL('image/png');
    const a = el('a', { href: url, download: `明星阵容矩阵_${new Date().toISOString().slice(0, 10)}.png` });
    document.body.append(a); a.click(); a.remove();
    toast(`已导出 PNG（${off.width}×${off.height}）`, 'ok');
  } catch (e) { toast('导出失败：' + e.message, 'err'); }
}

async function duplicateActors(ids) {
  if (!ids.length) return;
  if (!(await confirmDialog(`复制选中的 ${ids.length} 位演员？（生成新 ID 的副本，档案与提示词一并复制）`))) return;
  let ok = 0;
  for (const id of ids) {
    try { const r = await api.post(`/api/actors/${id}/duplicate`, {}); if (r.ok) ok++; } catch (e) { toast(e.message, 'err'); }
  }
  await loadAll();
  toast(`已复制 ${ok} 位演员`, ok ? 'ok' : 'err');
}

// ---------------- 复制 / 粘贴（画布内节点） ----------------
function copySelection() {
  const notes = (S.noteNodes || []).filter((n) => S.selectedNote === n.id || (n.group_id && S.selectedGroup === n.group_id));
  if (notes.length) {
    S.clipboard = { kind: 'notes', items: notes.map((n) => ({ text: n.note_text, color: n.note_color, w: n.w, h: n.h, dx: n.x, dy: n.y })) };
    toast(`已复制 ${notes.length} 张便签（Ctrl+V 粘贴到视野内）`, 'ok', 1800);
    return;
  }
  if (S.selection.size) {
    toast('演员卡片在一张画布上是唯一的：粘贴不会新增卡片。要复制演员请用 Ctrl+D（生成「副本」新演员）', 'warn', 4200);
    return;
  }
  toast('先选中便签（或演员卡片查看提示）', 'warn');
}

async function pasteSelection() {
  if (S.clipboard?.kind !== 'notes' || !S.clipboard.items.length) { toast('剪贴板为空（目前支持复制便签）', 'warn'); return; }
  pushUndo();
  const minX = Math.min(...S.clipboard.items.map((c) => c.dx));
  const minY = Math.min(...S.clipboard.items.map((c) => c.dy));
  try {
    for (const c of S.clipboard.items) {
      await api.post('/api/canvas/notes', {
        canvas_id: S.canvasId,
        x: Math.round(-S.panX + 60 + (c.dx - minX)),
        y: Math.round(-S.panY + 60 + (c.dy - minY)),
        w: c.w, h: c.h, text: c.text, color: c.color,
      });
    }
    await loadCanvas(); draw();
    toast(`已粘贴 ${S.clipboard.items.length} 张便签`, 'ok');
  } catch (e) { toast('粘贴失败：' + e.message, 'err'); }
}

// ---------------- 撤销 / 重做 ----------------
function snapshot() {
  // 必须记录「该画布上的全部卡位」（含被筛选/折叠隐藏的），否则撤销恢复会丢卡片
  const nodes = [];
  for (const [actorId, n] of S.nodes.entries()) {
    nodes.push({
      id: n.id, actor_id: actorId, x: n.x, y: n.y, w: n.w || S.cell, h: n.h || S.cell,
      z: n.z || 0, locked: n.locked ? 1 : 0, group_id: n.group_id || null, kind: 'actor', note: n.note || '',
    });
  }
  const notes = (S.noteNodes || []).map((n) => ({ ...n }));
  // 资产/流程节点：撤销是「整体替换」，若不一起快照，一次 Ctrl+Z 就会把环境/物品/参考图/分镜/成片节点全清掉
  const extras = [...(S.assetNodes || []), ...(S.flowNodes || [])].map((n) => ({
    id: n.id, actor_id: '', x: n.x, y: n.y, w: n.w, h: n.h, z: n.z || 0, locked: n.locked ? 1 : 0,
    group_id: n.group_id || null, kind: n.kind, title: n.title || '', color: n.color || '', data: n.data ?? null,
  }));
  return { nodes, notes, extras, groups: (S.groupFrames || []).map((g) => ({ ...g })) };
}

function pushUndo() {
  if (!S) return;
  const snap = snapshot();
  const last = S.undoStack[S.undoStack.length - 1];
  if (last && JSON.stringify(last) === JSON.stringify(snap)) return;
  S.undoStack.push(snap);
  if (S.undoStack.length > 40) S.undoStack.shift();
  S.redoStack = [];
}

async function applySnapshot(snap) {
  const nodes = [
    ...snap.nodes.map((n) => ({ ...n })),
    ...(snap.notes || []).map((n) => ({
      id: n.id, actor_id: '', x: n.x, y: n.y, w: n.w, h: n.h, z: n.z || 0, locked: n.locked || 0,
      group_id: n.group_id || null, kind: 'note',
      note: JSON.stringify({ text: n.note_text || '', color: n.note_color || 'amber' }),
    })),
    // 资产/流程节点原样带回（含 data，执行状态不丢）
    ...(snap.extras || []).map((n) => ({ ...n })),
  ];
  await api.post('/api/canvas/restore', { canvas_id: S.canvasId, nodes, groups: snap.groups || [] });
  await loadCanvas();
  S.selection = new Set(); S.selectedOrder = []; S.selectedGroup = null; S.selectedNote = null;
  updateCount(); renderList(); draw();
}

async function undo() {
  if (!S.undoStack.length) { toast('没有可撤销的操作', 'info', 1400); return; }
  const cur = snapshot();
  const prev = S.undoStack.pop();
  S.redoStack.push(cur);
  await applySnapshot(prev);
  toast('已撤销', 'ok', 1200);
}

async function redo() {
  if (!S.redoStack.length) { toast('没有可重做的操作', 'info', 1400); return; }
  const cur = snapshot();
  const next = S.redoStack.pop();
  S.undoStack.push(cur);
  await applySnapshot(next);
  toast('已重做', 'ok', 1200);
}

// ---------------- 分组 / 便签 / 节点操作 ----------------
async function groupSelected() {
  const ids = S.selectedOrder.length ? S.selectedOrder.filter((id) => S.selection.has(id)) : [...S.selection];
  if (ids.length < 1) { toast('先选中要成组的卡片', 'warn'); return; }
  pushUndo();
  try {
    const r = await api.post('/api/canvas/groups', { canvas_id: S.canvasId, name: `分组 ${(S.groupFrames || []).length + 1}`, actorIds: ids });
    await loadCanvas();
    S.selectedGroup = r.group.id;
    ensureVisible({ x: r.group.x, y: r.group.y, w: r.group.w, h: r.group.h });
    draw();
    toast(`已把 ${ids.length} 张卡片组成「${r.group.name}」`, 'ok');
  } catch (e) { toast('成组失败：' + e.message, 'err'); }
}

function groupContextMenu(mx, my, gr) {
  const members = (S._layout?.items || []).filter((i) => i.groupId === gr.id);
  contextMenu(mx, my, [
    { header: `分组 · ${gr.name || '未命名'}（${members.length}）` },
    { label: '✏️ 重命名', onClick: () => renameGroupDialog(gr) },
    { label: gr.collapsed ? '▾ 展开分组' : '▸ 收起分组', onClick: () => toggleGroupCollapse(gr) },
    { label: '🎨 换个颜色', onClick: () => cycleGroupColor(gr) },
    { separator: true },
    { label: '☑️ 选中组内全部卡片', onClick: () => {
      S.selection = new Set(members.map((m) => m.actor.id));
      S.selectedOrder = [...S.selection];
      updateCount(); renderList(); draw();
    } },
    { label: '➕ 把当前选中项加入本组', disabled: !S.selection.size, onClick: async () => {
      pushUndo();
      try { await api.post(`/api/canvas/groups/${gr.id}/members`, { actorIds: [...S.selection] }); await loadCanvas(); draw(); toast('已加入分组', 'ok'); }
      catch (e) { toast(e.message, 'err'); }
    } },
    { label: '➖ 把当前选中项移出本组', disabled: !S.selection.size, onClick: async () => {
      pushUndo();
      try { await api.post(`/api/canvas/groups/${gr.id}/members`, { actorIds: [...S.selection], remove: true }); await loadCanvas(); draw(); toast('已移出分组', 'ok'); }
      catch (e) { toast(e.message, 'err'); }
    } },
    { label: '⤢ 贴合内容大小', onClick: () => refitGroup(gr) },
    { separator: true },
    { label: '🎬 为组内演员批量生成定妆图', children: [
      { label: '⭐ 全身定妆主图（每人 1 张）', onClick: () => groupGenerate(gr, 'full', ['keyart']) },
      { label: '🙂 脸部大图特写（每人 1 张）', onClick: () => groupGenerate(gr, 'face', ['front']) },
      { label: '😀 全部 12 表情', onClick: () => groupGenerate(gr, 'expression', (C.meta?.kinds?.find((k) => k.id === 'expression')?.variants || []).map((v) => v.id)) },
      { label: '🔄 多角度全身', onClick: () => groupGenerate(gr, 'angle', (C.meta?.kinds?.find((k) => k.id === 'angle')?.variants || []).map((v) => v.id)) },
      { separator: true },
      { label: '✎ 自定义参数生成…', onClick: () => generateDialog(groupMemberIds(gr), 'face', []) },
    ] },
    { label: '📖 把组内演员加入小说选角…', disabled: groupMemberIds(gr).length === 0, onClick: () => addGroupToNovel(gr) },
    { label: '📄 复制组内演员 ID 清单', disabled: groupMemberIds(gr).length === 0, onClick: () => {
      const list = groupMemberIds(gr).join(', ');
      navigator.clipboard?.writeText(list);
      toast(`已复制 ${groupMemberIds(gr).length} 个演员 ID`, 'ok');
    } },
    { label: '🧹 清空组内成员（保留分组框）', disabled: groupMemberIds(gr).length === 0, onClick: async () => {
      pushUndo();
      try { await api.post(`/api/canvas/groups/${gr.id}/members`, { actorIds: groupMemberIds(gr), remove: true }); await loadCanvas(); draw(); toast('已清空组内成员', 'ok'); }
      catch (e) { toast(e.message, 'err'); }
    } },
    { separator: true },
    { label: '🗑 解散分组（保留卡片）', onClick: () => dissolveGroup(gr, true) },
    { label: '🗑 解散并删除组内卡位', onClick: () => dissolveGroup(gr, false) },
  ]);
}

function groupMemberIds(gr) {
  return (S._layout?.items || []).filter((it) => it.kind !== 'note' && it.groupId === gr.id).map((it) => it.actor.id);
}

/** 分组批量出图：用统一的生成参数面板，对象是组内全部演员 */
function groupGenerate(gr, kind, variants) {
  const ids = groupMemberIds(gr);
  if (!ids.length) { toast('该分组还没有成员卡片', 'warn'); return; }
  generateDialog(ids, kind, variants);
}

/** 把任意演员加入某部小说的选角 */
async function addActorsToNovel(ids) {
  if (!ids?.length) { toast('先选中演员', 'warn'); return; }
  let novels = [];
  try { novels = (await api.get('/api/novels')).novels || []; } catch (e) { toast('读取小说列表失败：' + e.message, 'err'); return; }
  if (!novels.length) { toast('还没有小说项目，先到「小说工坊」创建', 'warn'); return; }
  const form = { novelId: novels[0].id };
  const body = el('div', { class: 'col', style: { gap: '12px' } }, [
    el('div', { class: 'small muted' }, [`将把 ${ids.length} 位演员（${ids.join('、')}）加入所选小说的演员表。`]),
    el('label', { class: 'f' }, ['目标小说', select(novels.map((n) => ({ id: n.id, name: `${n.title}（${n.id} · ${n.actor_ids?.length || 0} 位演员）` })), form.novelId, (v) => { form.novelId = v; })]),
  ]);
  const m = modal({
    title: '📖 加入小说选角', body, width: 520,
    footer: [
      el('button', { class: 'btn', onclick: () => m.close() }, ['取消']),
      el('button', { class: 'btn primary', onclick: async () => {
        try {
          const novel = novels.find((n) => n.id === form.novelId);
          const merged = [...new Set([...(novel.actor_ids || []), ...ids])];
          await api.post(`/api/novels/${form.novelId}/actors`, { actorIds: merged });
          m.close();
          toast(`已加入《${novel.title}》选角（合计 ${merged.length} 位）`, 'ok', 3000);
        } catch (e) { toast('加入失败：' + e.message, 'err', 4200); }
      } }, ['加入选角']),
    ],
  });
}

/** 把分组演员加入某部小说的选角（模块2 的演员表） */
async function addGroupToNovel(gr) {
  const ids = groupMemberIds(gr);
  if (!ids.length) { toast('该分组还没有成员卡片', 'warn'); return; }
  let novels = [];
  try { novels = (await api.get('/api/novels')).novels || []; } catch (e) { toast('读取小说列表失败：' + e.message, 'err'); return; }
  if (!novels.length) { toast('还没有小说项目，先到「小说工坊」创建', 'warn'); return; }
  const form = { novelId: novels[0].id, append: true };
  const body = el('div', { class: 'col', style: { gap: '12px' } }, [
    el('div', { class: 'small muted' }, [`将把分组「${gr.name || '未命名'}」的 ${ids.length} 位演员（${ids.join('、')}）加入所选小说的演员表。`]),
    el('label', { class: 'f' }, ['目标小说', select(novels.map((n) => ({ id: n.id, name: `${n.title}（${n.id} · ${n.actor_ids?.length || 0} 位演员）` })), form.novelId, (v) => { form.novelId = v; })]),
    el('label', { class: 'row', style: { gap: '8px' } }, [
      el('input', { type: 'checkbox', style: { width: 'auto' }, checked: true, onchange: (e) => { form.append = e.target.checked; } }),
      el('span', { text: '追加到现有演员表（取消则替换为这几位）' }),
    ]),
    el('div', { class: 'hint' }, ['超过小说设定的「角色规模」时会给出中文错误提示，可先到小说工坊调大角色规模。']),
  ]);
  const m = modal({
    title: '📖 加入小说选角', body, width: 560,
    footer: [
      el('button', { class: 'btn', onclick: () => m.close() }, ['取消']),
      el('button', { class: 'btn primary', onclick: async () => {
        try {
          const novel = novels.find((n) => n.id === form.novelId);
          const existing = form.append ? (novel.actor_ids || []) : [];
          const merged = [...new Set([...existing, ...ids])];
          await api.post(`/api/novels/${form.novelId}/actors`, { actorIds: merged });
          m.close();
          toast(`已把 ${ids.length} 位演员加入《${novel.title}》选角（合计 ${merged.length} 位）`, 'ok', 3200);
        } catch (e) { toast('加入失败：' + e.message, 'err', 4200); }
      } }, ['加入选角']),
    ],
  });
}

/** 连线标签选择：拖完端口后弹quick picker，一键建线 */
function openLinkLabelPicker(from, to) {
  const labels = ['参考', '出现在', '持有', '使用', '饰演', '对手戏', '敌对', '同盟', '场景切换', '道具来源'];
  const fromItem = (S._layout?.items || []).find((i) => i.id === from.fromId);
  const toItem = to.item || (S._layout?.items || []).find((i) => i.id === to.id);
  const fp = from.port || null;                                   // 起点输出端口（未命中端口时为 null → 语义关系线）
  const tp = to.port || null;                                     // 落点输入端口
  const compatIns = (fp && toItem) ? portsOf(toItem).in.filter((p) => portCompatible(fp, p)) : [];
  const typed = Boolean(fp && tp && compatIns.includes(tp));
  const form = { label: '参考', custom: '', toPort: typed ? tp : null };
  const fromName = nodeLabel(from.fromId);
  const toName = toItem?.id === to.id ? nodeLabel(to.id) : (toItem?.node?.title || to.id);
  const portRow = el('div', { class: 'col', style: { gap: '6px' } });
  if (typed) {
    portRow.append(
      el('div', { class: 'small muted' }, [`类型化端口：${fp} → ${form.toPort}（数据流边，会带槽位顺序）`]),
      compatIns.length > 1
        ? el('div', { class: 'pill-group' }, compatIns.map((p) => el('div', {
          class: `pill${form.toPort === p ? ' on' : ''}`,
          onclick: (e) => {
            form.toPort = p;
            [...e.target.parentElement.children].forEach((c) => c.classList.remove('on'));
            e.target.classList.add('on');
            tip.textContent = `类型化端口：${fp} → ${p}（数据流边，会带槽位顺序）`;
          },
        }, [p])))
        : null,
    );
  } else if (fp && toItem) {
    portRow.append(el('div', { class: 'hint' }, [`「${portKindName(toItem)}」没有可接入 ${fp} 的输入端口 → 本次按语义关系线创建（无端口/无槽位）`]));
  }
  const tip = portRow.querySelector?.('.small.muted') || el('span');
  const body = el('div', { class: 'col', style: { gap: '12px' } }, [
    el('div', { class: 'small muted' }, [`连线：${fromName} → ${toName}`]),
    el('div', { class: 'pill-group' }, labels.map((lb) => el('div', {
      class: `pill${form.label === lb ? ' on' : ''}`,
      onclick: (e) => { form.label = lb; [...e.target.parentElement.children].forEach((c) => c.classList.remove('on')); e.target.classList.add('on'); },
    }, [lb]))),
    el('label', { class: 'f' }, ['自定义标签（可留空）', el('input', { type: 'text', placeholder: '例如：同一场景出现', oninput: (e) => { form.custom = e.target.value; } })]),
    portRow,
    el('div', { class: 'hint' }, [`关系线数量不限，可在任意两个节点之间连接（演员 / 环境 / 物品 / 参考图 / 便签）。把线拖到目标节点的端口上即建立类型化数据流边（可自动排序，用于成片拼接）。${fp === 'clip' && toItem && (toItem.kind === 'video') ? ' 把「片段」接到视频节点的 first 端口 = 视频续写（自动取上一段的尾帧作为下一段首帧）。' : ''}`]),
  ]);
  const m = modal({
    title: typed ? '🔗 建立数据流边' : '🔗 建立关系线', body, width: 520,
    footer: [
      el('button', { class: 'btn', onclick: () => { m.close(); S.linkingSticky = null; draw(); } }, ['取消']),
      el('button', { class: 'btn primary', onclick: async () => {
        try {
          const payload = {
            canvas_id: S.canvasId, from_node: from.fromId, to_node: to.id,
            from_side: from.side || 'right', to_side: (from.side || 'right') === 'right' ? 'left' : 'right',
            label: (form.custom || '').trim() || form.label,
          };
          if (typed) { payload.from_port = fp; payload.to_port = form.toPort; }   // 未命中端口 → 走旧语义连线
          const r = await api.post('/api/canvas/links', payload);
          S.links = [...(S.links || []), r.link];
          m.close(); S.linkingSticky = null; await loadCanvas(); draw();
          toast(typed ? `已连接（${fp} → ${form.toPort}，槽位 ${r.link?.slot ?? 0}）：${fromName} → ${toName}` : `已连接：${fromName} → ${toName}`, 'ok');
        } catch (e) { toast('连线失败：' + e.message, 'err'); }
      } }, ['连线']),
    ],
  });
}

/** 节点类型的中文名（用于连线提示） */
function portKindName(it) {
  const k = (it && it.kind) || 'actor';
  if (k === 'note') return '便签';
  if (['scene', 'item', 'refimg', ...FLOW_KINDS].includes(k)) return ASSET_STYLE[k]?.name || k;
  return it?.actor?.name ? '演员卡' : k;
}

/** 简易文本输入对话框（Promise） */
function promptDialog(title, defaultValue = '') {
  return new Promise((resolve) => {
    const input = el('input', { type: 'text', value: defaultValue });
    const m = modal({
      title: `✏️ ${title}`, width: 420,
      body: el('div', { class: 'col' }, [el('label', { class: 'f' }, [title, input])]),
      footer: [
        el('button', { class: 'btn', onclick: () => { m.close(); resolve(null); } }, ['取消']),
        el('button', { class: 'btn primary', onclick: () => { const v = input.value; m.close(); resolve(v); } }, ['确定']),
      ],
    });
    setTimeout(() => input.focus(), 50);
  });
}

function nodeLabel(nodeId) {
  const it = (S._layout?.items || []).find((i) => i.id === nodeId);
  if (!it) return nodeId;
  if (it.kind === 'note') return '便签';
  if (['scene', 'item', 'refimg', ...FLOW_KINDS].includes(it.kind)) return it.node?.title || ASSET_STYLE[it.kind]?.name || it.kind;
  return it.actor?.name || nodeId;
}

/** 新建资产节点（环境 / 物品 / 参考图），可指定落点 */
function freeSpot(w = 260, h = 220) {
  // 从视野左上方开始，按 40px 步长找一个不与现有卡片重叠的位置
  const items = S._layout?.items || [];
  const baseX = Math.round(-S.panX + 80);
  const baseY = Math.round(-S.panY + 80);
  const overlaps = (x, y) => items.some((it) => x < it.x + it.w + 20 && x + w + 20 > it.x && y < it.y + it.h + 20 && y + h + 20 > it.y);
  for (let row = 0; row < 30; row++) {
    for (let col = 0; col < 12; col++) {
      const x = baseX + col * (w + 40);
      const y = baseY + row * (h + 40);
      if (!overlaps(x, y)) return { x, y };
    }
  }
  return { x: baseX, y: baseY };
}

async function addAsset(kind, placeAt = null) {
  const world = placeAt || freeSpot();
  pushUndo();
  try {
    const r = await api.post('/api/canvas/assets', { canvas_id: S.canvasId, kind, x: Math.round(world.x), y: Math.round(world.y) });
    await loadCanvas();
    S.mode = 'free'; updateModeButton();
    S.selectedExtra = r.node.id; S.selectedNote = null;
    ensureVisible({ x: r.node.x, y: r.node.y, w: r.node.w, h: r.node.h });
    draw();
    assetEditDialog(r.node.id);
  } catch (e) { toast('新建失败：' + e.message, 'err'); }
}

/** 编辑资产节点：标题 / 描述 / 场景时间天气 / 物品分类 / 参考图矩阵 */
function assetEditDialog(nodeId) {
  const node = (S.assetNodes || []).find((n) => n.id === nodeId);
  if (!node) { toast('节点不存在，请刷新后再试', 'warn'); return; }
  const st = ASSET_STYLE[node.kind] || ASSET_STYLE.scene;
  const a = node.asset || {};
  const form = { title: node.title || '', desc: a.desc || '', timeOfDay: a.timeOfDay || '', weather: a.weather || '', category: a.category || '', owner: a.owner || '', cols: a.cols || (node.kind === 'refimg' ? 3 : 2), tags: (a.tags || []).join(',') };
  const thumbs = el('div', { class: 'pill-group' });
  const renderThumbs = () => {
    thumbs.innerHTML = '';
    const imgs = a.refImages || [];
    if (!imgs.length) { thumbs.append(el('span', { class: 'small muted' }, ['还没有参考图'])); return; }
    imgs.forEach((rel, i) => {
      thumbs.append(el('div', { style: { position: 'relative' } }, [
        el('img', { src: api.fileUrl(rel), style: { width: '84px', height: '84px', objectFit: 'cover', borderRadius: '8px', border: i === 0 ? '2px solid var(--accent)' : '1px solid var(--line)' } }),
        el('button', { class: 'btn xs danger', style: { position: 'absolute', top: '-6px', right: '-6px' }, title: '移除', onclick: async () => {
          try { const r = await api.post(`/api/canvas/assets/${nodeId}/ref-images`, { remove: [rel] }); a.refImages = r.refImages; renderThumbs(); await loadCanvas(); draw(); }
          catch (e) { toast(e.message, 'err'); }
        } }, ['✕']),
        el('div', { class: 'small muted', style: { textAlign: 'center', fontSize: '10px' } }, [i === 0 ? '主参考' : `#${i + 1}`]),
      ]));
    });
  };
  renderThumbs();
  const body = el('div', { class: 'col', style: { gap: '12px' } }, [
    el('label', { class: 'f' }, ['标题', el('input', { type: 'text', value: form.title, oninput: (e) => { form.title = e.target.value; } })]),
    node.kind === 'scene' ? el('div', { class: 'grid2' }, [
      el('label', { class: 'f' }, ['时间', el('input', { type: 'text', placeholder: '深夜 / 清晨', value: form.timeOfDay, oninput: (e) => { form.timeOfDay = e.target.value; } })]),
      el('label', { class: 'f' }, ['天气/氛围', el('input', { type: 'text', placeholder: '浓雾 / 暴雨', value: form.weather, oninput: (e) => { form.weather = e.target.value; } })]),
    ]) : null,
    node.kind === 'item' ? el('div', { class: 'grid2' }, [
      el('label', { class: 'f' }, ['分类', el('input', { type: 'text', placeholder: '道具 / 武器 / 信物', value: form.category, oninput: (e) => { form.category = e.target.value; } })]),
      el('label', { class: 'f' }, ['持有者', el('input', { type: 'text', placeholder: '演员 ID 或姓名', value: form.owner, oninput: (e) => { form.owner = e.target.value; } })]),
    ]) : null,
    el('label', { class: 'f' }, ['描述', el('textarea', { rows: 3, oninput: (e) => { form.desc = e.target.value; } }, [form.desc])]),
    el('label', { class: 'f' }, ['标签（逗号分隔）', el('input', { type: 'text', value: form.tags, oninput: (e) => { form.tags = e.target.value; } })]),
    el('label', { class: 'f' }, ['参考图矩阵列数（1-4）', el('input', { type: 'number', min: 1, max: 4, value: form.cols, oninput: (e) => { form.cols = Math.max(1, Math.min(4, +e.target.value || 2)); } })]),
    el('div', {}, [el('div', { class: 'small muted', style: { marginBottom: '6px' } }, ['参考图（第一张为主参考，节点内以矩阵展示）']), thumbs]),
    el('div', { class: 'row wrap' }, [
      el('button', { class: 'btn sm', onclick: () => uploadAssetRefs(nodeId) }, ['📎 上传参考图（可多选）']),
      el('button', { class: 'btn sm', onclick: async () => {
        try { await api.put('/api/canvas/assets/' + nodeId, { data: { desc: form.desc }, title: form.title }); await loadCanvas(); draw(); toast('已保存', 'ok'); }
        catch (e) { toast(e.message, 'err'); }
      } }, ['💾 保存']),
    ]),
    el('div', { class: 'hint' }, ['参考图会保存到 data/uploads 下；连线时可把环境/物品/参考图与演员自由连接（数量不限）。']),
  ]);
  const m = modal({
    title: `${st.icon} ${st.name}节点 · ${node.title || ''}`, body, width: 640,
    footer: [
      el('button', { class: 'btn danger', onclick: async () => {
        try { await api.del('/api/canvas/node/' + nodeId); m.close(); await loadCanvas(); draw(); toast('节点已删除（相关连线一并清理）', 'ok'); }
        catch (e) { toast(e.message, 'err'); }
      } }, ['删除节点']),
      el('button', { class: 'btn', onclick: () => m.close() }, ['关闭']),
      el('button', { class: 'btn primary', onclick: async () => {
        try {
          const data = { desc: form.desc, cols: form.cols, tags: form.tags.split(',').map((x) => x.trim()).filter(Boolean) };
          if (node.kind === 'scene') { data.timeOfDay = form.timeOfDay; data.weather = form.weather; }
          if (node.kind === 'item') { data.category = form.category; data.owner = form.owner; }
          await api.put('/api/canvas/assets/' + nodeId, { title: form.title, data });
          m.close(); await loadCanvas(); draw(); toast('已保存', 'ok');
        } catch (e) { toast('保存失败：' + e.message, 'err'); }
      } }, ['保存']),
    ],
  });
}

/** 给资产节点上传参考图（可多选），第一张自动成为主参考 */
function uploadAssetRefs(nodeId) {
  const inp = el('input', { type: 'file', accept: 'image/*', multiple: true, dataset: { role: 'asset-refs' }, style: { display: 'none' } });
  document.body.append(inp);
  inp.onchange = async () => {
    const files = [...(inp.files || [])];
    inp.remove();
    if (!files.length) return;
    try {
      const paths = [];
      for (const f of files) { const up = await api.upload(f); if (up) paths.push(up.path); }
      await api.post(`/api/canvas/assets/${nodeId}/ref-images`, { add: paths });
      await loadCanvas(); draw();
      const node = (S.assetNodes || []).find((n) => n.id === nodeId);
      if (node) { const m = rootEl.querySelector('.overlay'); }
      toast(`已上传 ${paths.length} 张参考图`, 'ok');
      assetEditDialog(nodeId);
    } catch (e) { toast('上传失败：' + e.message, 'err'); }
  };
  inp.click();
}

/**
 * 画布内「智能 Claw 指令」：一句话操作画布
 * 副作用分级（见 docs/智能Claw研究报告.md）：只读/建图类直接执行；花钱的动作只返回计划，交人工闸门放行。
 */
/** 画布快照：保存 / 看差异 / 回滚 / 删除（破坏性操作前会自动留一张） */
async function snapshotsDialog() {
  const box = el('div', { class: 'col', style: { gap: '8px', minWidth: '560px' } });
  const nameInput = el('input', { type: 'text', placeholder: '快照名称（留空自动命名）', style: { flex: '1' } });
  const noteInput = el('input', { type: 'text', placeholder: '备注（可选，比如「铺开 S01E001 前的布局」）', style: { flex: '1' } });
  const listBox = el('div', { class: 'col', style: { gap: '6px', maxHeight: '46vh', overflow: 'auto' } }, [el('div', { class: 'small muted', text: '读取中…' })]);

  const reload = async () => {
    listBox.innerHTML = '';
    try {
      const r = await api.get(`/api/canvas/snapshots?canvas_id=${encodeURIComponent(S.canvasId)}`);
      const list = r.snapshots || [];
      if (!list.length) {
        listBox.appendChild(el('div', { class: 'small muted' }, ['这张画布还没有快照。点上面「保存当前画布」即可打第一张。']));
        return;
      }
      for (const sn of list) {
        const row = el('div', { class: 'row', style: { gap: '6px', alignItems: 'center', border: '1px solid var(--line)', borderRadius: '8px', padding: '6px 8px' } }, [
          el('span', { class: `tag ${sn.kind === 'auto' ? '' : 'accent'}`.trim(), text: sn.kind === 'auto' ? '自动' : '人工' }),
          el('div', { class: 'col', style: { gap: '2px', flex: '1', minWidth: '0' } }, [
            el('div', { style: { fontSize: '13px', fontWeight: 600 }, text: sn.name || sn.id }),
            el('div', { class: 'small muted', text: `${sn.nodes} 卡位 / ${sn.groups} 分组 / ${sn.links} 连线 · ${String(sn.createdAt || '').slice(0, 16).replace('T', ' ')}${sn.note ? ` · ${sn.note}` : ''}` }),
          ]),
          el('button', { class: 'btn xs', onclick: async () => {
            try {
              const d = await api.get(`/api/canvas/snapshots/${sn.id}/diff`);
              toast(`差异：${d.summary}`, d.same ? 'info' : 'warn', 5200);
              if (!d.same && d.nodes) {
                const more = [
                  d.nodes.added.length ? `当前多出：${d.nodes.added.slice(0, 5).join('、')}` : '',
                  d.nodes.removed.length ? `快照里有、现在没了：${d.nodes.removed.slice(0, 5).join('、')}` : '',
                  d.nodes.movedCount ? `${d.nodes.movedCount} 个卡位被移动/改尺寸` : '',
                ].filter(Boolean).join('；');
                if (more) toast(more, 'info', 6000);
              }
            } catch (e) { toast('差异对比失败：' + e.message, 'err'); }
          } }, ['🔍 差异']),
          el('button', { class: 'btn xs accent', onclick: async () => {
            if (!confirm(`回滚到「${sn.name}」？\n\n当前现场会先自动存成一张快照（可再退回）。`)) return;
            try {
              const r = await api.post(`/api/canvas/snapshots/${sn.id}/restore`, {});
              await loadCanvas(); draw();
              toast(`已回滚到「${r.name}」（${r.nodes} 卡位 / ${r.groups} 分组）`, 'ok', 4200);
              await reload();
              const l2 = await api.get(`/api/canvas/snapshots?canvas_id=${encodeURIComponent(S.canvasId)}`);
              S.snapshots = l2.snapshots || [];
            } catch (e) { toast('回滚失败：' + e.message, 'err', 4200); }
          } }, ['↩ 回滚']),
          el('button', { class: 'btn xs', onclick: async () => {
            try { await api.del(`/api/canvas/snapshots/${sn.id}`); toast('快照已删除', 'ok'); await reload(); }
            catch (e) { toast('删除失败：' + e.message, 'err'); }
          } }, ['🗑']),
        ]);
        listBox.appendChild(row);
      }
    } catch (e) {
      listBox.innerHTML = '';
      listBox.appendChild(el('div', { class: 'small', style: { color: 'var(--err)' } }, [`读取快照失败：${e.message}`]));
    }
  };

  const saveBtn = el('button', { class: 'btn primary sm', onclick: async () => {
    try {
      const r = await api.post('/api/canvas/snapshots', { canvas_id: S.canvasId, name: nameInput.value || undefined, note: noteInput.value || undefined });
      toast(`已保存快照「${r.snapshot.name}」（${r.snapshot.nodes} 卡位 / ${r.snapshot.links} 连线）`, 'ok', 3600);
      nameInput.value = ''; noteInput.value = '';
      await reload();
      const l2 = await api.get(`/api/canvas/snapshots?canvas_id=${encodeURIComponent(S.canvasId)}`);
      S.snapshots = l2.snapshots || [];
    } catch (e) { toast('保存快照失败：' + e.message, 'err', 4200); }
  } }, ['📸 保存当前画布']);

  box.append(
    el('div', { class: 'small muted' }, ['整张画布（卡位 / 分组 / 连线 / 视图）一起存；清空画布与铺开分集前会自动留一张「自动」快照。单画布最多 40 张，超出时先淘汰最旧的自动快照。']),
    el('div', { class: 'row', style: { gap: '6px' } }, [nameInput, noteInput, saveBtn]),
    listBox,
  );
  modal({ title: '📸 画布快照与回滚', width: 720, body: box, footer: [] });
  await reload();
}

async function clawDialog(presetText = '') {
  const input = el('textarea', { rows: 2, placeholder: '例如：看看画布状态 / 生成执行计划 / 按 canvas-only 技能铺开 S01E001 / 从镜 1 续写 / 给镜 1 补尾帧',
    style: { width: '100%' } });
  input.value = presetText;
  const out = el('div', { class: 'code', style: { maxHeight: '240px', whiteSpace: 'pre-wrap' } }, ['（等待指令）']);
  const examples = ['看看画布状态', '生成执行计划', '按 canvas-only 技能铺开 S01E001', '从镜 1 续写', '给镜 1 补尾帧'];
  const run = async () => {
    const text = (input.value || '').trim();
    if (!text) { toast('请先输入一条指令', 'warn', 2200); return; }
    out.textContent = '🤖 解析中…';
    try {
      const r = await api.post('/api/canvas/agent', { canvas_id: S.canvasId, instruction: text });
      const lines = [r.reply || '(无回复)'];
      if (r.plan?.steps?.run?.length) {
        lines.push('', `待执行 ${r.plan.steps.run.length} 个节点，前 5 个：`,
          ...r.plan.steps.run.slice(0, 5).map((st, i) => `  ${i + 1}. ${st.title || st.id}（${st.kind}）`));
      }
      if (r.actions?.length) lines.push('', ...r.actions.map((a) => `  ${a.ok ? '✓' : '✗'} ${a.kind}：${a.detail}`));
      if (r.trace) {
        lines.push('', '— 结构化留痕 —',
          `  现状：节点 ${r.trace.observed?.nodes ?? '-'}（可执行 ${r.trace.observed?.executable ?? '-'} / 完成 ${r.trace.observed?.done ?? '-'} / 失败 ${r.trace.observed?.error ?? '-'}）`,
          `  意图：${r.trace.intent || '未识别（不误动作）'}`,
          `  副作用：${r.trace.effects?.filter((e) => e.ok).map((e) => e.kind).join('、') || '无'}（画布 Agent 自身永不发起付费调用）`,
          `  建议：${r.trace.next}`);
      }
      out.textContent = lines.join('\n');
      const acted = (r.actions || []).some((a) => a.ok && ['spread', 'continue'].includes(a.kind));
      if (acted) { await loadCanvas(); draw(); toast('画布已更新（未生成任何内容）', 'ok', 2600); }
      else toast(r.understood ? '指令已执行' : '没听懂这条指令', r.understood ? 'ok' : 'warn', 2600);
    } catch (e) { out.textContent = '✗ ' + e.message; toast('指令失败：' + e.message, 'err', 3600); }
  };
  const body = el('div', { class: 'col', style: { gap: '10px' } }, [
    el('div', { class: 'small muted' }, ['一句话操作画布：**只读**（状态/计划）与**建图**（铺开/续写）直接执行且不生成任何内容；**花钱的动作**只会返回计划，必须人工批准 + 输入确认码才会真正出图/出片。']),
    input,
    el('div', { class: 'pill-group' }, examples.map((x) => el('div', { class: 'pill', onclick: () => { input.value = x; run(); } }, [x]))),
    el('div', { class: 'f' }, ['执行结果', out]),
  ]);
  const m = modal({
    title: '🤖 Claw 指令（画布）', body, width: 640,
    footer: [
      el('button', { class: 'btn', onclick: () => m.close() }, ['关闭']),
      el('button', { class: 'btn primary', onclick: () => run() }, ['▶ 执行指令']),
    ],
  });
  setTimeout(() => input.focus(), 60);
}

/** 手工创建流程节点（画布即可执行图：关键帧 / 视频片段 / 文本 / 成片时间线 / 交付终点） */
function flowNodeMenu(ev) {
  const spot = { x: Math.round(-S.panX + 140), y: Math.round(-S.panY + 140) };
  const items = [
    { id: 'image', label: '🖼 关键帧（出图节点）', hint: '连到视频节点的 first 当首帧' },
    { id: 'video', label: '🎬 视频片段', hint: 'first=首帧 / last=尾帧 / dub=配音 → clip 输出' },
    { id: 'text', label: '📝 文本', hint: '接到出图/配音节点的文本端口' },
    { id: 'timeline', label: '🎬 成片时间线', hint: 'clip1..N 主轨 + ov1..4 叠加轨 + bgm + sub 字幕轨' },
    { id: 'overlay', label: '🖼️ 叠加层（画中画 / 水印）', hint: '接到成片节点的 ov1..ov4，按时间窗叠加' },
    { id: 'subtitle', label: '💬 字幕轨', hint: '自有 SRT 或手工行 → 接到成片节点的 sub' },
    { id: 'output', label: '📦 交付终点', hint: '标记交付物（裸拼接）' },
  ];
  contextMenu(ev.clientX, ev.clientY, [
    ...items.map((it) => ({ label: `${it.label}　${it.hint}`, onClick: async () => {
      try {
        const r = await api.post('/api/canvas/assets', { canvas_id: S.canvasId, kind: it.id, x: spot.x, y: spot.y, title: '' });
        await loadCanvas(); draw();
        if (r.node?.id) { S.selectedExtra = r.node.id; S.selection = new Set(); S.selectedNote = null; draw(); }
        toast(`已创建「${it.label.replace(/^\S+\s/, '')}」节点（右键可编辑/连线）`, 'ok', 3200);
      } catch (e) { toast('创建失败：' + e.message, 'err', 3600); }
    } })),
  ]);
}

/** 叠加层节点（多轨 V2..V5）：画中画 / 全屏叠加 / 水印 */
async function overlayNodeDialog(nodeId = null) {
  const existing = nodeId ? (S.assetNodes || []).concat(S.flowNodes || []).find((n) => n.id === nodeId) : null;
  let cur = {};
  try { cur = existing ? JSON.parse(existing.data || '{}') : {}; } catch { cur = {}; }
  const form = {
    mode: cur.mode || 'pip', position: cur.position || '右下', widthRatio: cur.widthRatio ?? 0.32,
    start: cur.start ?? 0, end: cur.end ?? '', opacity: cur.opacity ?? 1, fade: cur.fade ?? 0.4,
    file: cur.file || '', title: existing?.title || '',
  };
  const fileBox = el('div', { class: 'small muted' }, [form.file ? `当前画面：${form.file}` : '（未指定：默认用接入它的上游画面）']);
  const numF = (label, key, { min = 0, max = 100, step = 0.05, hint = '' } = {}) => el('label', { class: 'f' }, [label,
    el('input', { type: 'number', value: form[key], min, max, step, oninput: (e) => { form[key] = e.target.value === '' ? '' : +e.target.value; } }),
    hint ? el('span', { class: 'hint' }, [` ${hint}`]) : null]);
  const body = el('div', { class: 'col', style: { gap: '10px' } }, [
    el('div', { class: 'small muted' }, ['叠加层是成片时间线的画面轨（V2..V5）：接到成片节点的 ov1..ov4 端口，按「时间窗」叠加到主画面上。画面默认取接入它的上游片段，也可在这里直接指定一张图片/视频（水印常用）。']),
    el('div', { class: 'pill-group' }, [['pip', '🖼️ 画中画'], ['full', '🖥 全屏叠加'], ['watermark', '🔖 水印']].map(([id, label]) => el('div', {
      class: `pill${form.mode === id ? ' on' : ''}`,
      onclick: (e) => { form.mode = id; [...e.target.parentElement.children].forEach((c) => c.classList.remove('on')); e.target.classList.add('on'); },
    }, [label]))),
    el('div', { class: 'row', style: { gap: '8px' } }, [
      el('label', { class: 'f' }, ['位置', el('select', { onchange: (e) => { form.position = e.target.value; } },
        ['右下', '左下', '右上', '左上', '居中'].map((v) => el('option', { value: v, selected: v === form.position }, [v])))]),
      numF('宽度占主画面比例', 'widthRatio', { min: 0.05, max: 1, step: 0.01, hint: '0.32 ≈ 三分之一宽' }),
      numF('不透明度', 'opacity', { min: 0.05, max: 1, step: 0.05 }),
    ]),
    el('div', { class: 'row', style: { gap: '8px' } }, [
      numF('出现时间（秒，留空=从片头）', 'start', { min: 0, max: 9999, step: 0.1 }),
      numF('消失时间（秒，留空=到片尾）', 'end', { min: 0, max: 9999, step: 0.1 }),
      numF('淡入淡出（秒）', 'fade', { min: 0, max: 3, step: 0.1 }),
    ]),
    el('label', { class: 'f' }, ['画面文件（可留空用上游画面）', el('div', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, [
      el('button', { class: 'btn xs', onclick: () => {
        const inp = el('input', { type: 'file', accept: 'image/*,video/*' });
        inp.onchange = async () => {
          const f = inp.files?.[0]; if (!f) return;
          try { const up = await api.upload(f); form.file = up.path; fileBox.textContent = `当前画面：${up.path}`; toast('已上传', 'ok'); }
          catch (e) { toast('上传失败：' + e.message, 'err'); }
        };
        inp.click();
      } }, ['📎 上传画面']), fileBox])]),
    el('label', { class: 'f' }, ['节点标题', el('input', { type: 'text', value: form.title, oninput: (e) => { form.title = e.target.value; } })]),
    el('div', { class: 'hint' }, ['合成由成片节点的执行完成（一次 ffmpeg 完成所有叠加轨）；执行计划里能看到它，人工审批后才真正跑。']),
  ]);
  const m = modal({
    title: existing ? '🖼️ 编辑叠加层' : '🖼️ 新建叠加层', body, width: 640,
    footer: [
      el('button', { class: 'btn', onclick: () => m.close() }, ['取消']),
      el('button', { class: 'btn primary', onclick: async () => {
        const data = { mode: form.mode, position: form.position, widthRatio: Number(form.widthRatio) || 0.32,
          start: form.start === '' ? '' : Number(form.start), end: form.end === '' ? '' : Number(form.end),
          opacity: Number(form.opacity) || 1, fade: Number(form.fade) || 0, file: form.file,
          desc: { pip: '画中画', full: '全屏叠加', watermark: '水印' }[form.mode] };
        try {
          if (existing) await api.put('/api/canvas/assets/' + existing.id, { data, title: form.title || existing.title });
          else await api.post('/api/canvas/assets', { canvas_id: S.canvasId, kind: 'overlay', title: form.title || '叠加层', data, x: Math.round(-S.panX + 200), y: Math.round(-S.panY + 200) });
          m.close(); await loadCanvas(); draw();
          toast('叠加层已保存：把 overlay 端口拉到成片节点的 ov1..ov4', 'ok', 4200);
        } catch (e) { toast('保存失败：' + e.message, 'err', 3600); }
      } }, [existing ? '保存' : '创建节点']),
    ],
  });
}

/** 字幕轨节点：自有 SRT / 手工行 → 成片节点的 sub 端口（可烧录或做软字幕轨） */
async function subtitleNodeDialog(nodeId = null) {
  const existing = nodeId ? (S.assetNodes || []).concat(S.flowNodes || []).find((n) => n.id === nodeId) : null;
  let cur = {};
  try { cur = existing ? JSON.parse(existing.data || '{}') : {}; } catch { cur = {}; }
  const form = { file: cur.file || '', mode: cur.mode === 'soft' ? 'soft' : 'hard', title: existing?.title || '', lines: Array.isArray(cur.lines) && cur.lines.length ? cur.lines : [{ start: 0, end: 3, text: '' }] };
  const fileBox = el('div', { class: 'small muted' }, [form.file ? `当前 SRT：${form.file}` : '（未上传：用下方手工行）']);
  const rows = el('div', { class: 'col', style: { gap: '6px', maxHeight: '180px', overflow: 'auto' } });
  const renderRows = () => {
    rows.innerHTML = '';
    form.lines.forEach((ln, i) => {
      rows.append(el('div', { class: 'row', style: { gap: '6px', alignItems: 'center' } }, [
        el('input', { type: 'number', value: ln.start, step: 0.1, style: { width: '70px' }, oninput: (e) => { ln.start = +e.target.value || 0; } }),
        el('span', { class: 'small muted' }, ['→']),
        el('input', { type: 'number', value: ln.end, step: 0.1, style: { width: '70px' }, oninput: (e) => { ln.end = +e.target.value || 0; } }),
        el('input', { type: 'text', value: ln.text, placeholder: '字幕文字', style: { flex: '1' }, oninput: (e) => { ln.text = e.target.value; } }),
        el('button', { class: 'btn xs', onclick: () => { form.lines.splice(i, 1); renderRows(); } }, ['✕']),
      ]));
    });
    rows.append(el('button', { class: 'btn xs', onclick: () => { form.lines.push({ start: 0, end: 3, text: '' }); renderRows(); } }, ['＋ 加一行']));
  };
  renderRows();
  const body = el('div', { class: 'col', style: { gap: '10px' } }, [
    el('div', { class: 'small muted' }, ['字幕轨接到成片节点的 sub 端口：可用现成 .srt（时间码原样沿用），也可直接手工写时间码行。比「按台词自动生成字幕」更可控。']),
    el('label', { class: 'f' }, ['字幕方式', el('select', { onchange: (e) => { form.mode = e.target.value; } },
      [el('option', { value: 'hard', selected: form.mode === 'hard' }, ['烧录进画面（默认）']), el('option', { value: 'soft', selected: form.mode === 'soft' }, ['软字幕轨（播放器可开关）'])])]),
    el('label', { class: 'f' }, ['SRT 文件', el('div', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, [
      el('button', { class: 'btn xs', onclick: () => {
        const inp = el('input', { type: 'file', accept: '.srt,.ass,text/plain' });
        inp.onchange = async () => {
          const f = inp.files?.[0]; if (!f) return;
          try { const up = await api.upload(f); form.file = up.path; fileBox.textContent = `当前 SRT：${up.path}`; toast('已上传字幕文件', 'ok'); }
          catch (e) { toast('上传失败：' + e.message, 'err'); }
        };
        inp.click();
      } }, ['📎 上传 .srt']),
      el('button', { class: 'btn xs', onclick: () => { form.file = ''; fileBox.textContent = '（未上传：用下方手工行）'; } }, ['清除']),
      fileBox])]),
    el('div', { class: 'f' }, ['手工时间码行（秒）', rows]),
    el('label', { class: 'f' }, ['节点标题', el('input', { type: 'text', value: form.title, oninput: (e) => { form.title = e.target.value; } })]),
  ]);
  const m = modal({
    title: existing ? '💬 编辑字幕轨' : '💬 新建字幕轨', body, width: 660,
    footer: [
      el('button', { class: 'btn', onclick: () => m.close() }, ['取消']),
      el('button', { class: 'btn primary', onclick: async () => {
        const data = { file: form.file, mode: form.mode, lines: form.lines, desc: '字幕轨' };
        try {
          if (existing) await api.put('/api/canvas/assets/' + existing.id, { data, title: form.title || existing.title });
          else await api.post('/api/canvas/assets', { canvas_id: S.canvasId, kind: 'subtitle', title: form.title || '字幕轨', data, x: Math.round(-S.panX + 200), y: Math.round(-S.panY + 300) });
          m.close(); await loadCanvas(); draw();
          toast('字幕轨已保存：把 subtitle 端口拉到成片节点的 sub', 'ok', 4200);
        } catch (e) { toast('保存失败：' + e.message, 'err', 3600); }
      } }, [existing ? '保存' : '创建节点']),
    ],
  });
}

/**
 * 音频节点（画布音频闭环）：配音（TTS）/ 已有音频 / 背景乐
 * 接线：音频节点 audio 端口 → 视频节点 dub（该镜配音）或 成片节点 bgm（整片背景乐，混音自动 ducking）
 */
async function audioNodeDialog(nodeId = null) {
  const existing = nodeId ? (S.assetNodes || []).concat(S.flowNodes || []).find((n) => n.id === nodeId) : null;
  const cur = existing ? (() => { try { return JSON.parse(existing.data || '{}'); } catch { return {}; } })() : {};
  const form = {
    mode: cur.mode || 'tts', text: cur.text || '', voice: cur.voice || '', speed: cur.speed || 1,
    file: cur.file || '', title: existing?.title || '',
  };
  const fileBox = el('div', { class: 'small muted' }, [form.file ? `当前文件：${form.file}` : '（未选择音频文件）']);
  const textArea = el('textarea', { rows: 3, placeholder: '要合成的台词（可留空：自动取上游文本节点或所绑定镜头的台词）',
    oninput: (e) => { form.text = e.target.value; } });
  textArea.value = form.text;
  const pickBtn = el('button', { class: 'btn xs', onclick: () => {
    const inp = el('input', { type: 'file', accept: 'audio/*' });
    inp.onchange = async () => {
      const f = inp.files?.[0];
      if (!f) return;
      try {
        const up = await api.upload(f, { kind: 'audio' });
        if (!up?.path) throw new Error('上传未返回路径');
        form.file = up.path; fileBox.textContent = `当前文件：${up.path}`;
        toast('音频已上传', 'ok');
      } catch (e) { toast('上传失败：' + e.message, 'err', 3600); }
    };
    inp.click();
  } }, ['📎 上传音频文件']);
  const body = el('div', { class: 'col', style: { gap: '10px' } }, [
    el('div', { class: 'small muted' }, ['音频节点把「配音 / 音乐 / 音效」变成画布上的一等节点：接到某个视频片段的 dub 端口 = 该镜配音；接到成片节点的 bgm 端口 = 整片背景乐（混音时自动压低人声以外的音乐）。']),
    el('div', { class: 'pill-group' }, [['tts', '🔊 配音（TTS 合成）'], ['file', '🎧 已有音频'], ['bgm', '🎵 背景乐']].map(([id, label]) => el('div', {
      class: `pill${form.mode === id ? ' on' : ''}`,
      onclick: (e) => {
        form.mode = id;
        [...e.target.parentElement.children].forEach((c) => c.classList.remove('on'));
        e.target.classList.add('on');
        sync();
      },
    }, [label]))),
    el('label', { class: 'f', id: 'ac-audio-text' }, ['台词（配音模式）', textArea]),
    el('div', { class: 'row', style: { gap: '8px' } }, [
      el('label', { class: 'f' }, ['音色（留空用设置里的默认音色）', el('input', { type: 'text', value: form.voice, placeholder: '例如 zh-female-soft', oninput: (e) => { form.voice = e.target.value; } })]),
      el('label', { class: 'f' }, ['语速', el('input', { type: 'number', value: form.speed, min: 0.5, max: 2, step: 0.05, oninput: (e) => { form.speed = +e.target.value || 1; } })]),
    ]),
    el('label', { class: 'f', id: 'ac-audio-file' }, ['音频文件（已有音频 / 背景乐模式）', el('div', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, [pickBtn, fileBox])]),
    el('label', { class: 'f' }, ['节点标题', el('input', { type: 'text', value: form.title, oninput: (e) => { form.title = e.target.value; } })]),
    el('div', { class: 'hint' }, ['生成走画布执行计划（🧭 执行计划 → 人工审批 → 确认码）；已合成的台词会按「台词 + 音色」缓存，重复执行不再重复付费。']),
  ]);
  const sync = () => {
    const tts = form.mode === 'tts';
    const t = body.querySelector('#ac-audio-text'), f2 = body.querySelector('#ac-audio-file');
    if (t) t.style.display = ''; else t.style.display = 'none';
    if (f2) f2.style.display = tts ? 'none' : '';
  };
  sync();
  const m = modal({
    title: existing ? '🔊 编辑音频节点' : '🔊 新建音频节点', body, width: 600,
    footer: [
      el('button', { class: 'btn', onclick: () => m.close() }, ['取消']),
      el('button', { class: 'btn primary', onclick: async () => {
        const data = { mode: form.mode, text: form.text, voice: form.voice, speed: form.speed, file: form.file,
          desc: form.mode === 'bgm' ? '整片背景乐（人声处自动压低）' : (form.mode === 'file' ? '已有音频文件' : '按台词合成配音') };
        try {
          if (existing) {
            await api.put('/api/canvas/assets/' + existing.id, { data, title: form.title || existing.title });
          } else {
            const r = await api.post('/api/canvas/assets', { canvas_id: S.canvasId, kind: 'audio', title: form.title || (form.mode === 'bgm' ? '背景乐' : (form.mode === 'file' ? '音频' : '配音')), data, x: Math.round(-S.panX + 120), y: Math.round(-S.panY + 120) });
            S.selectedExtra = r.node?.id || null;
          }
          m.close();
          await loadCanvas(); draw();
          toast(existing ? '音频节点已更新' : '音频节点已创建：把 audio 端口拉到视频节点的 dub 或成片节点的 bgm', 'ok', 4200);
        } catch (e) { toast('保存失败：' + e.message, 'err', 3600); }
      } }, [existing ? '保存' : '创建节点']),
    ],
  });
}

/** P5 · 把某一集的分镜铺到画布（只布局、不生成；生成走「🧭 执行计划」的审核闸门） */
async function spreadEpisodeDialog() {
  let scripts = [];
  try { scripts = (await api.get('/api/scripts')).scripts || []; } catch (e) { toast('读取剧本失败：' + e.message, 'err'); return; }
  if (!scripts.length) { toast('还没有剧本：请先到「剧本工厂」生成一个剧本', 'warn', 3200); return; }
  const form = { scriptId: scripts[0].id, code: '', cols: 4 };
  const epBox = el('div', { class: 'col', style: { gap: '6px' } }, ['加载分集中…']);
  const loadEps = async () => {
    epBox.innerHTML = '';
    try {
      const r = await api.get(`/api/scripts/${encodeURIComponent(form.scriptId)}/episodes`);
      const eps = (r.episodes || r.episodes_full || []);
      if (!eps.length) { epBox.append(el('div', { class: 'hint' }, ['该剧本还没有分集，请先生成分集与分镜'])); return; }
      form.code = eps[0].code;
      epBox.append(el('div', { class: 'pill-group' }, eps.slice(0, 24).map((e) => el('div', {
        class: `pill${form.code === e.code ? ' on' : ''}`,
        onclick: (ev) => {
          form.code = e.code;
          [...ev.target.parentElement.children].forEach((c) => c.classList.remove('on'));
          ev.target.classList.add('on');
        },
      }, [`${e.code}${e.shot_count ? ` · ${e.shot_count} 镜` : ''}`]))));
    } catch (e) { epBox.append(el('div', { class: 'hint' }, ['读取分集失败：' + e.message])); }
  };
  const body = el('div', { class: 'col', style: { gap: '12px' } }, [
    el('div', { class: 'small muted' }, ['把一集的每个镜头铺成「视频片段」节点，并按 clip1..N 接到「成片时间线」节点上。']),
    el('label', { class: 'f' }, ['剧本', el('select', { onchange: (e) => { form.scriptId = e.target.value; loadEps(); } },
      scripts.map((sc) => el('option', { value: sc.id, selected: sc.id === form.scriptId }, [`${sc.title || sc.id}（${sc.id}）`])))]),
    el('label', { class: 'f' }, ['分集', epBox]),
    el('label', { class: 'f' }, ['每行片段数', el('input', { type: 'number', value: 4, min: 1, max: 8, oninput: (e) => { form.cols = +e.target.value || 4; } })]),
    el('div', { class: 'hint' }, ['★ 只排版、不生成：铺开后到工具栏点「🧭 执行计划」查看要跑哪些片段与预估花费，确认后才真正出视频。']),
  ]);
  const m = modal({
    title: '🎞 铺开分集到画布', body, width: 560,
    footer: [
      el('button', { class: 'btn', onclick: () => m.close() }, ['取消']),
      el('button', { class: 'btn primary', onclick: async () => {
        try {
          const r = await api.post('/api/canvas/spread-episode', { canvasId: S.canvasId, scriptId: form.scriptId, code: form.code, cols: form.cols });
          m.close();
          await loadCanvas(); draw();
          toast(`已铺开 ${r.clipCount} 个镜头片段 + 成片节点（未生成任何内容）`, 'ok', 3600);
          const tid = r.timelineNodeId;
          if (tid && S._itemsById?.get(tid)) {
            const it = S._itemsById.get(tid);
            S.selectedExtra = tid; S.selectedNote = null; S.selection = new Set();
            S.panX = -(it.x + it.w / 2) + canvasEl().clientWidth / (2 * S.zoom);
            S.panY = -(it.y + it.h / 2) + canvasEl().clientHeight / (2 * S.zoom);
            draw(); scheduleViewSave();
          }
        } catch (e) { toast('铺开失败：' + e.message, 'err', 3600); }
      } }, ['🎞 铺开到画布']),
    ],
  });
  loadEps();
}

/**
 * 画布执行计划：dry-run 预览 → **人工审批（P4 闸门）** → 输入确认码 → 执行
 * 闸门语义：Agent 只能提交计划；人必须显式批准并输入只打印在服务端终端的 6 位确认码，才会真正开始生成。
 */
async function planDialog() {
  let created = null;
  try { created = (await api.post('/api/canvas/plans', { canvas_id: S.canvasId, created_by: 'human' })).plan; }
  catch (e) {
    const msg = String(e.message || e);
    if (msg.includes('没有可执行的节点')) {
      const m0 = modal({
        title: '🧭 还没有可执行的节点', width: 520,
        body: el('div', { class: 'col', style: { gap: '10px' } }, [
          el('div', { class: 'small' }, ['画布上的演员 / 环境 / 物品 / 参考图 / 便签都是「素材源」，本身不需要执行。']),
          el('div', { class: 'hint' }, ['先点工具栏「🎞 铺开分集」把某一集的分镜铺成「视频片段 + 成片时间线」节点；或右键环境节点「生成概念图」建立出图节点。之后「🧭 执行计划」会列出要跑哪些节点、预估花多少钱，确认后才执行。']),
        ]),
        footer: [el('button', { class: 'btn primary', onclick: () => { m0.close(); spreadEpisodeDialog(); } }, ['🎞 铺开分集'])],
      });
      return;
    }
    toast('生成计划失败：' + msg, 'err', 4000);
    return;
  }
  const plan = created?.plan || {};
  const est = plan.estimate || created?.estimate || {};
  const runSteps = plan.steps?.run || [];
  const skipSteps = plan.steps?.skip || [];
  const codeInput = el('input', { type: 'text', placeholder: '6 位确认码（见运行服务的终端）', style: { width: '190px' } });
  const state = el('div', { class: 'hint' }, [`计划 ${created?.plan_id || ''} · 状态 ${created?.status || 'pending'} · 成本级 ${created?.cost_level || '—'} · 有效期至 ${created?.expires_at || '—'}`]);
  const runRows = runSteps.map((st, i) => el('div', { class: 'row', style: { gap: '8px' } }, [
    el('span', { class: 'small muted' }, [`${i + 1}.`]),
    el('span', { class: 'small' }, [`${st.title || st.id}（${st.kind}）`]),
    st.reason ? el('span', { class: 'hint' }, [`· ${st.reason}`]) : null,
  ]));
  const skipRows = skipSteps.slice(0, 12).map((st) => el('div', { class: 'row', style: { gap: '8px' } }, [
    el('span', { class: 'small muted' }, ['—']),
    el('span', { class: 'small' }, [`${st.title || st.id}（${st.kind}）`]),
    el('span', { class: 'hint' }, [`· 跳过：${st.reason || '已有产物'}`]),
  ]));
  const body = el('div', { class: 'col', style: { gap: '10px' } }, [
    el('div', { class: 'small' }, [`将执行 ${runSteps.length} 个节点 · 可跳过 ${skipSteps.length} 个 · 预估调用 ${est.totalCalls || 0} 次（出图 ${est.imageCalls || 0} / 视频 ${est.videoCalls || 0}）`]),
    plan.cycles?.length ? el('div', { class: 'hint', style: { color: 'var(--danger)' } }, [`⚠ 存在环形依赖：${plan.cycles.join('、')}`]) : null,
    el('div', { class: 'code', style: { maxHeight: '220px' } }, runRows.length ? runRows : [el('div', { class: 'hint' }, ['没有需要执行的节点（都已是最新产物）'])]),
    skipRows.length ? el('details', {}, [el('summary', { class: 'small muted' }, [`已跳过 ${skipSteps.length} 个（点开查看）`]), ...skipRows]) : null,
    state,
    el('div', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, [
      el('button', { class: 'btn xs', onclick: async (ev) => {
        try {
          const r = await api.post(`/api/canvas/plans/${encodeURIComponent(created.plan_id)}/approve`, { confirm: true, by: 'human' });
          state.textContent = `已批准（${r.approved_at}）。确认码已打印在运行服务的终端，请填入下方输入框后执行。`;
          ev.target.disabled = true;
          toast('计划已批准（还需确认码才能执行）', 'ok', 3200);
        } catch (e) { toast('批准失败：' + e.message, 'err', 3600); }
      } }, ['✅ 批准计划']),
      el('button', { class: 'btn xs', onclick: async () => {
        try {
          await api.post(`/api/canvas/plans/${encodeURIComponent(created.plan_id)}/reject`, { reason: '人工拒绝', by: 'human' });
          state.textContent = '已拒绝该计划（不会产生任何生成调用）';
          toast('已拒绝计划', 'ok');
        } catch (e) { toast('拒绝失败：' + e.message, 'err', 3600); }
      } }, ['⛔ 拒绝']),
      codeInput,
    ]),
    el('div', { class: 'hint' }, ['★ 人类审核闸门：确认码只打印在运行 `./start.sh` 的终端里（形如 [plan] 确认码 ABC123）。Agent 只能提交计划，拿不到确认码，因此无法自行开始花钱的生成。']),
  ]);
  const m = modal({
    title: '🧭 画布执行计划（dry-run → 人工审批）', body, width: 660,
    footer: [
      el('button', { class: 'btn', onclick: () => m.close() }, ['关闭']),
      el('button', { class: 'btn primary', disabled: !runSteps.length, onclick: async () => {
        const code = (codeInput.value || '').trim();
        if (!code) { toast('请先填写 6 位确认码（在运行服务的终端里）', 'warn', 3200); return; }
        try {
          const r = await api.post(`/api/canvas/plans/${encodeURIComponent(created.plan_id)}/run`, { confirm_code: code });
          m.close();
          const jobId = r.result?.job_id || r.job_id;
          toast(`已开始执行（任务 ${jobId || '—'}，共 ${r.result?.total ?? runSteps.length} 个节点）`, 'ok', 3200);
          if (jobId) {
            const stop = api.watchJob(jobId, async (job) => {
              if (['done', 'error', 'canceled'].includes(job.status)) {
                stop?.();
                await loadCanvas(); draw();
                toast(job.status === 'done' ? '画布执行完成' : `画布执行结束：${job.status}（${job.error || ''}）`, job.status === 'done' ? 'ok' : 'err', 4000);
              }
            });
          }
        } catch (e) { toast('执行被拒绝：' + e.message, 'err', 4200); }
      } }, ['▶ 执行（需确认码）']),
    ],
  });
}

/** 执行单个画布节点（视频片段 / 成片时间线等）：走 DAG 单点重跑 */
async function runCanvasNode(nodeId, label = '节点') {
  try {
    const r = await api.post('/api/canvas/run-node', { canvasId: S.canvasId, nodeId, overwrite: true });
    toast(`已开始重跑${label}（任务 ${r.jobId}）`, 'ok', 2600);
    const stop = api.watchJob(r.jobId, async (job) => {
      if (['done', 'error', 'canceled'].includes(job.status)) {
        stop?.();
        await loadCanvas(); draw();
        toast(job.status === 'done' ? `${label}已完成` : `${label}失败：${job.error || job.status}`, job.status === 'done' ? 'ok' : 'err', 4200);
      }
    });
  } catch (e) { toast('执行失败：' + e.message, 'err', 3600); }
}

/** 时间线拼接顺序预览（dry-run：不生成，只按 clip1..N → slot → 创建时间解析） */
async function timelineOrderDialog(nodeId) {
  let r = null;
  try { r = await api.get(`/api/canvas/timeline-order?canvas_id=${encodeURIComponent(S.canvasId)}&node_id=${encodeURIComponent(nodeId)}`); }
  catch (e) { toast('读取顺序失败：' + e.message, 'err'); return; }
  const rows = (r.clips || []).map((c) => el('div', { class: 'row', style: { gap: '8px' } }, [
    el('span', { class: 'small muted' }, [`${c.order}.`]),
    el('span', { class: 'small' }, [`${c.port || '（无端口）'} · ${c.duration}s`]),
    el('span', { class: 'hint' }, [`${c.dialogue ? `台词：${c.dialogue.slice(0, 18)}` : '无台词'}${c.dub ? ' · 🔊 已有画布配音' : ''} · ${String(c.file).split('/').pop()}`]),
  ]));
  const body = el('div', { class: 'col', style: { gap: '8px' } }, [
    el('div', { class: 'small' }, [`共 ${r.total} 段 · 预计总时长 ${r.totalDuration}s${r.ready ? '' : ' · ⚠ 还有片段未产出'} `]),
    r.bgm ? el('div', { class: 'small' }, [`🎵 背景乐：${String(r.bgm).split('/').pop()}（混音时自动压低人声以外的音乐）`]) : null,
    r.bgmMissing ? el('div', { class: 'hint', style: { color: 'var(--warn)' } }, ['⚠ 背景乐连线已接上，但上游音频节点还没有产出']) : null,
    r.duplicated?.length ? el('div', { class: 'hint', style: { color: 'var(--danger)' } }, [`⚠ 端口重复：${r.duplicated.map((d) => d.port).join('、')}（每个 clipN 只应接一条线）`]) : null,
    r.missing?.length ? el('div', { class: 'hint', style: { color: 'var(--warn)' } }, [`⚠ ${r.missing.length} 条连线的上游还没有产出视频，成片会失败`]) : null,
    el('div', { class: 'code', style: { maxHeight: '240px' } }, rows.length ? rows : [el('div', { class: 'hint' }, ['还没有片段接入：把视频节点的 clip 端口连到本节点的 clip1..N'])]),
  ]);
  const m2 = modal({
    title: '👁 成片拼接顺序（按画布连线解析）', body, width: 620,
    footer: [el('button', { class: 'btn', onclick: () => m2.close() }, ['关闭'])],
  });
}

/** 组合出图：把选中的节点（+ 连线关联的节点）合成一条提示词并提交出图 */
function composeDialog(presetIds = null) {
  const selected = (presetIds && presetIds.length) ? presetIds : currentSelectionNodeIds();
  if (!selected.length) { toast('先在画布上选中要参与出图的节点（演员卡 / 环境 / 物品 / 参考图）', 'warn', 3200); return; }
  const meta = C.meta || {};
  const params = { kind: 'full', variant: 'keyart', ratio: '', perVariant: 1, seed: '', extra: '', negativeExtra: '', useLinked: true, backend: '' };
  const preview = el('div', { class: 'code', style: { maxHeight: '190px' } }, ['正在生成预览…']);
  const summaryBox = el('div', { class: 'small muted' }, ['—']);
  const kindBox = el('div', { class: 'pill-group' });

  const KINDS = [
    { id: 'full', label: '⭐ 全身定妆', variant: 'keyart' },
    { id: 'face', label: '🙂 脸部特写', variant: 'front' },
    { id: 'group', label: '👥 多角色同框', variant: 'duo' },
    { id: 'pose', label: '🧍 姿态动作', variant: 'standing' },
    { id: 'custom', label: '✎ 自由构图', variant: 'custom' },
  ];
  const renderKinds = () => {
    kindBox.innerHTML = '';
    for (const k of KINDS) {
      kindBox.append(el('div', {
        class: `pill${params.kind === k.id ? ' on' : ''}`,
        onclick: (e) => { params.kind = k.id; params.variant = k.variant; [...e.target.parentElement.children].forEach((c) => c.classList.remove('on')); e.target.classList.add('on'); refresh(); },
      }, [k.label]));
    }
  };
  let timer = null;
  async function refresh() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        const r = await api.post('/api/canvas/compose/preview', {
          canvasId: S.canvasId, nodeIds: selected, kind: params.kind, variant: params.variant,
          ratio: params.ratio || undefined, extra: params.extra, negativeExtra: params.negativeExtra,
          perVariant: params.perVariant, useLinked: params.useLinked,
        });
        summaryBox.textContent = `参与节点 ${r.nodes.length} 个：${r.nodes.map((n) => `${n.title || n.kind}`).join(' + ')} ｜ 演员 ${r.actorCount} · 场景/道具/参考 ${r.assetCount} ｜ 尺寸 ${r.width}×${r.height}（${r.ratio}）｜ 将生成 ${r.total} 张${r.usedRef ? ' ｜ 使用参考图：' + String(r.ref).split('/').pop() : ''}`;
        preview.textContent = `【风格】${r.style.name}\n\n【正向 POSITIVE】\n${r.positive}\n\n【负向 NEGATIVE】\n${r.negative}`;
      } catch (e) { preview.textContent = '预览失败：' + e.message; }
    }, 220);
  }
  const body = el('div', { class: 'col', style: { gap: '12px' } }, [
    el('div', { class: 'small muted' }, [`已选中 ${selected.length} 个节点；开启「带上连线关联节点」后，与它们直接相连的环境/物品/参考图也会自动参与。`]),
    el('div', {}, [el('div', { class: 'small muted', style: { marginBottom: '6px' } }, ['① 出图类型']), kindBox]),
    el('div', { class: 'grid3' }, [
      el('label', { class: 'f' }, ['比例尺寸', select([{ id: '', name: '跟随演员/默认' }, ...(meta.ratios || []).map((r) => ({ id: r.id, name: r.name }))], '', (v) => { params.ratio = v; refresh(); })]),
      el('label', { class: 'f' }, ['每角色张数', el('input', { type: 'number', min: 1, max: 6, value: 1, oninput: (e) => { params.perVariant = Math.max(1, Math.min(6, +e.target.value || 1)); refresh(); } })]),
      el('label', { class: 'f' }, ['种子（空=随机）', el('input', { type: 'text', placeholder: '随机', oninput: (e) => { params.seed = e.target.value.trim(); } })]),
    ]),
    el('label', { class: 'f' }, ['补充正向词', el('input', { type: 'text', placeholder: 'e.g. rain, neon reflections', oninput: (e) => { params.extra = e.target.value; refresh(); } })]),
    el('label', { class: 'f' }, ['补充负向词', el('input', { type: 'text', placeholder: 'e.g. hat, glasses', oninput: (e) => { params.negativeExtra = e.target.value; refresh(); } })]),
    el('label', { class: 'row', style: { gap: '8px' } }, [
      el('input', { type: 'checkbox', style: { width: 'auto' }, checked: true, onchange: (e) => { params.useLinked = e.target.checked; refresh(); } }),
      el('span', { text: '带上连线关联的节点（连线即约束）' }),
    ]),
    summaryBox,
    el('div', {}, [el('div', { class: 'small muted', style: { marginBottom: '6px' } }, ['② 提示词实时预览（英文）']), preview]),
  ]);
  renderKinds(); refresh();
  const m = modal({
    title: '⚡ 画布组合出图', body, width: 760,
    footer: [
      el('button', { class: 'btn', onclick: () => m.close() }, ['取消']),
      el('button', { class: 'btn primary', onclick: async () => {
        m.close();
        try {
          const r = await api.post('/api/canvas/compose', {
            canvasId: S.canvasId, nodeIds: selected, kind: params.kind, variant: params.variant,
            ratio: params.ratio || undefined, extra: params.extra, negativeExtra: params.negativeExtra,
            perVariant: params.perVariant, seed: params.seed === '' ? null : Number(params.seed),
            useLinked: params.useLinked,
          });
          toast(`已提交组合出图（${r.total} 张）`, 'ok');
          watchGeneration(r.jobId, r.total);
        } catch (e) { toast('提交失败：' + e.message, 'err'); }
      } }, ['🚀 开始生成']),
    ],
  });
}

/** 当前选中的节点 id 列表（演员卡按选中集合，其余按 selectedExtra/分组） */
function currentSelectionNodeIds() {
  const ids = new Set();
  for (const it of (S._layout?.items || [])) {
    if (it.kind === 'actor' && S.selection.has(it.actorId)) ids.add(it.id);
    if (it.kind !== 'actor' && S.selectedExtra === it.id) ids.add(it.id);
    if (it.groupId && S.selectedGroup === it.groupId) ids.add(it.id);
  }
  return [...ids];
}

/** 资产节点生成概念图 */
async function generateAssetImage(nodeId) {
  try {
    const r = await api.post(`/api/canvas/assets/${nodeId}/generate`, {});
    toast('已提交概念图生成', 'ok');
    watchGeneration(r.jobId, 1);
    setTimeout(async () => { await loadCanvas(); draw(); }, 1200);
  } catch (e) { toast('生成失败：' + e.message, 'err'); }
}

/** 参考图矩阵：一次上传多张 → 自动生成矩阵排布的参考图节点 */
function refMatrixDialog(placeAt = null) {
  const form = { cols: 4, cell: 220, name: '' };
  const files = [];
  const list = el('div', { class: 'small muted' }, ['尚未选择图片']);
  const body = el('div', { class: 'col', style: { gap: '12px' } }, [
    el('div', { class: 'hint' }, ['一次选择多张参考图 → 自动生成 N 个「参考图节点」，按矩阵排布并自动成组，可直接与演员/环境连线。']),
    el('div', { class: 'row wrap' }, [
      el('button', { class: 'btn sm', onclick: () => inp.click() }, ['📎 选择图片（可多选）']),
    ]),
    list,
    el('div', { class: 'grid2' }, [
      el('label', { class: 'f' }, ['矩阵列数', el('input', { type: 'number', min: 1, max: 8, value: form.cols, oninput: (e) => { form.cols = Math.max(1, Math.min(8, +e.target.value || 4)); } })]),
      el('label', { class: 'f' }, ['单元格尺寸', el('input', { type: 'number', min: 140, max: 420, step: 10, value: form.cell, oninput: (e) => { form.cell = +e.target.value || 220; } })]),
    ]),
    el('label', { class: 'f' }, ['分组名称（可留空自动命名）', el('input', { type: 'text', placeholder: '例如：第一季场景参考', value: form.name, oninput: (e) => { form.name = e.target.value; } })]),
  ]);
  const inp = el('input', { type: 'file', accept: 'image/*', multiple: true, dataset: { role: 'ref-matrix' }, style: { display: 'none' } });
  document.body.append(inp);
  inp.onchange = () => {
    files.length = 0;
    files.push(...[...(inp.files || [])]);
    list.textContent = files.length ? `已选择 ${files.length} 张：${files.map((f) => f.name).slice(0, 3).join('、')}${files.length > 3 ? ' …' : ''}` : '尚未选择图片';
  };
  const m = modal({
    title: '🖼 参考图矩阵', body, width: 560,
    footer: [
      el('button', { class: 'btn', onclick: () => { inp.remove(); m.close(); } }, ['取消']),
      el('button', { class: 'btn primary', onclick: async () => {
        if (!files.length) { toast('请先选择图片', 'warn'); return; }
        try {
          const fd = new FormData();
          files.forEach((f) => fd.append('images', f, f.name));
          const world = placeAt || { x: Math.round(-S.panX + 80), y: Math.round(-S.panY + 80) };
          fd.append('meta', JSON.stringify({ canvas_id: S.canvasId, x: Math.round(world.x), y: Math.round(world.y), cols: form.cols, cell: form.cell, groupName: form.name }));
          const res = await fetch('/api/canvas/ref-matrix', { method: 'POST', body: fd });
          const j = await res.json();
          if (!j.ok) throw new Error(j.error || '生成失败');
          inp.remove(); m.close();
          await loadCanvas(); S.mode = 'free'; updateModeButton(); draw();
          toast(`已生成 ${j.created} 个参考图节点（已自动成组）`, 'ok');
        } catch (e) { toast('生成失败：' + e.message, 'err'); }
      } }, ['生成参考图矩阵']),
    ],
  });
}

// ---------------- 画布增强：九宫格 / 描述改进 / 一致性 ----------------
function preferredActorId() {
  for (const id of S.selection) if ((S.actors || []).some((a) => a.id === id)) return id;
  if (S.currentActor?.id) return S.currentActor.id;
  return (S.actors || [])[0]?.id || '';
}

function preferredAssetNode() {
  const pool = (S.assetNodes || []).filter((n) => ['scene', 'item', 'refimg'].includes(n.kind));
  if (S.selectedExtra && pool.some((n) => n.id === S.selectedExtra.id)) return S.selectedExtra;
  const id = [...S.selection].find((x) => String(x).startsWith('ND-'));
  return pool.find((n) => n.id === id) || pool[0] || null;
}

async function sheetDialog() {
  const form = { kind: 'character', styleId: '', cell: 512, gap: 12, useRef: true, setPrimary: true, sync: true };
  const actorSel = el('select', {}, (S.actors || []).map((a) => el('option', { value: a.id }, [`${a.name || a.id}（${a.id}）`])));
  actorSel.value = preferredActorId();
  const assetPool = (S.assetNodes || []).filter((n) => ['scene', 'item', 'refimg'].includes(n.kind));
  const assetSel = el('select', {}, assetPool.map((n) => el('option', { value: n.id }, [`${n.title || n.id}（${n.kind}）`])));
  const p0 = preferredAssetNode();
  if (p0) assetSel.value = p0.id;

  const actorRow = el('label', { class: 'f' }, ['角色', actorSel]);
  const assetRow = el('label', { class: 'f' }, ['环境 / 物品节点', assetSel]);
  assetRow.style.display = 'none';
  const previewBox = el('div', { class: 'col', style: { gap: '4px' } }, [el('div', { class: 'small muted' }, ['点「预览 9 格」查看每格内容；确认后再生成。'])]);

  const kindTip = el('div', { class: 'hint' }, ['人物：定妆主图 + 正/侧/背三视角 + 平静/微笑/愤怒三表情 + 服饰细节 + 手部特写。环境：3 视角（全景/中景/特写）× 3 时段（白天/黄昏/夜晚）。']);
  const kindSel = el('select', {
    onchange: (e) => {
      form.kind = e.target.value;
      const env = form.kind === 'environment';
      actorRow.style.display = env ? 'none' : '';
      assetRow.style.display = env ? '' : 'none';
      previewBox.replaceChildren(el('div', { class: 'small muted' }, ['点「预览 9 格」查看每格内容。']));
    },
  }, [el('option', { value: 'character' }, ['人物九宫格（专业设定表）']), el('option', { value: 'environment' }, ['环境九宫格（视角 × 时段）'])]);

  const body = el('div', { class: 'col', style: { gap: '10px' } }, [
    kindTip,
    el('label', { class: 'f' }, ['类型', kindSel]),
    actorRow,
    assetRow,
    el('div', { class: 'grid2' }, [
      el('label', { class: 'f' }, ['风格 ID（留空=用角色/节点默认）', el('input', { type: 'text', placeholder: 'cinematic-real', oninput: (e) => { form.styleId = e.target.value.trim(); } })]),
      el('label', { class: 'f' }, ['单格尺寸', el('input', { type: 'number', min: 256, max: 1024, step: 64, value: form.cell, oninput: (e) => { form.cell = +e.target.value || 512; } })]),
    ]),
    el('label', { class: 'row' }, ['用角色主图当参考图（更稳）', el('input', { type: 'checkbox', checked: true, onchange: (e) => { form.useRef = e.target.checked; } })]),
    el('label', { class: 'row' }, ['合成设定表并设为角色主参考图', el('input', { type: 'checkbox', checked: true, onchange: (e) => { form.setPrimary = e.target.checked; } })]),
    el('label', { class: 'row' }, ['同步生成（离线秒回；真实后端大项目建议改后台）', el('input', { type: 'checkbox', checked: true, onchange: (e) => { form.sync = e.target.checked; } })]),
    previewBox,
  ]);

  const payload = () => ({
    kind: form.kind, actorId: form.kind === 'character' ? actorSel.value : undefined,
    nodeId: form.kind === 'environment' ? assetSel.value : undefined,
    styleId: form.styleId || undefined, cell: form.cell, gap: form.gap,
    useRef: form.useRef, setPrimary: form.setPrimary,
  });

  const m = modal({
    title: '🔲 九宫格（9 图 + 3×3 设定表）', body, width: 620,
    footer: [
      el('button', { class: 'btn', onclick: () => m.close() }, ['取消']),
      el('button', { class: 'btn', onclick: async () => {
        try {
          const r = await api.post('/api/canvas/sheets/plan', payload());
          previewBox.replaceChildren(...[
            el('div', { class: 'small' }, [`${r.count} 格 · 风格 ${r.styleId} · 比例 ${r.ratio}${r.reason ? ' · ' + r.reason : ''}`]),
            ...r.cells.map((c, i) => el('div', { class: 'small muted', title: c.prompt }, [`${i + 1}. ${c.label}`])),
          ]);
        } catch (e) { toast('预览失败：' + e.message, 'err'); }
      } }, ['预览 9 格']),
      el('button', { class: 'btn primary', onclick: async () => {
        const p = payload();
        if (p.kind === 'character' && !p.actorId) { toast('请先选择角色', 'warn'); return; }
        if (p.kind === 'environment' && !p.nodeId) { toast('请先选择环境/物品节点', 'warn'); return; }
        try {
          const base = form.sync ? { ...p, sync: true } : { ...p };
          // 先不带 confirm 探一次：能拿到「队列暂停 / 预算超额」的中文原因
          let r = await api.post('/api/canvas/sheets/generate', base);
          if (r.blocked) { toast('已阻止：' + r.reason, 'err', 4600); return; }
          if (r.needConfirm) {
            const y = await confirmDialog(`${r.reason}\n\n确认继续生成 9 格？`);
            if (!y) { toast('已取消', 'info'); return; }
            if (form.sync) toast('正在生成 9 格并拼图…', 'info', 5000);
            r = await api.post('/api/canvas/sheets/generate', { ...base, confirm: true });
          }
          if (r.needConfirm) { toast('仍需要确认，已取消', 'warn'); return; }
          if (r.jobId) {
            toast('九宫格已进入后台任务', 'ok');
            api.watchJob(r.jobId, (job) => {
              if (job.status === 'done') { toast('九宫格完成', 'ok'); applySheetResult(job.result || {}); }
              else if (job.status === 'error') toast('九宫格失败：' + (job.error || ''), 'err');
            });
          } else applySheetResult(r);
          m.close();
        } catch (e) { toast('生成失败：' + e.message, 'err'); }
      } }, ['生成九宫格']),
    ],
  });
  function applySheetResult(r) {
    if (!r || !r.ok) { toast('生成未完成', 'warn'); return; }
    loadCanvas().then(() => draw());
    toast(`九宫格完成：${r.cells?.length || 9} 格 · ${r.engine || ''}${r.primarySet ? ' · 已设为主参考图' : ''}`, 'ok', 4000);
  }
}

async function describeDialog() {
  const actorPool = S.actors || [];
  const assetPool = (S.assetNodes || []).filter((n) => ['scene', 'item', 'refimg'].includes(n.kind));
  const scopeSel = el('select', {}, [el('option', { value: 'actor' }, ['角色']), el('option', { value: 'asset' }, ['环境 / 物品'])]);
  const actorSel = el('select', {}, actorPool.map((a) => el('option', { value: a.id }, [`${a.name || a.id}（${a.id}）`])));
  actorSel.value = preferredActorId();
  const assetSel = el('select', {}, assetPool.map((n) => el('option', { value: n.id }, [`${n.title || n.id}（${n.kind}）`])));
  const ap0 = preferredAssetNode(); if (ap0) assetSel.value = ap0.id;
  const actorRow = el('label', { class: 'f' }, ['角色', actorSel]);
  const assetRow = el('label', { class: 'f' }, ['环境 / 物品', assetSel]);
  assetRow.style.display = 'none';
  scopeSel.onchange = () => {
    const env = scopeSel.value === 'asset';
    actorRow.style.display = env ? 'none' : '';
    assetRow.style.display = env ? '' : 'none';
  };
  const out = el('div', { class: 'col', style: { gap: '6px' } }, [el('div', { class: 'small muted' }, ['点「生成预览」得到改进建议（不会直接改库）'])]);
  let undoToken = '';
  const body = el('div', { class: 'col', style: { gap: '10px' } }, [
    el('div', { class: 'hint' }, ['描述自动改进：为角色补性格/背景/服饰/发型/五官/音色，为环境补描述/氛围/配色/镜头建议。先预览，确认后写库，可撤销。']),
    el('label', { class: 'f' }, ['作用范围', scopeSel]),
    actorRow, assetRow, out,
  ]);
  const m = modal({
    title: '✨ 描述自动改进', body, width: 640,
    footer: [
      el('button', { class: 'btn', onclick: () => m.close() }, ['关闭']),
      el('button', { class: 'btn', onclick: async () => {
        try {
          const scope = scopeSel.value;
          const id = scope === 'asset' ? assetSel.value : actorSel.value;
          if (!id) { toast('请选择目标', 'warn'); return; }
          const r = await api.post('/api/describe/preview', { scope, id });
          window.__dscToken = r.token;
          const rows = Object.keys(r.after || {}).map((k) => el('div', { class: 'small' }, [
            el('b', {}, [k + '：']),
            el('span', { class: 'muted' }, [' 原：' + String(r.before?.[k] || '（空）').slice(0, 40)]),
            el('br'),
            el('span', {}, [' 新：' + String(r.after[k] || '').slice(0, 120)]),
          ]));
          out.replaceChildren(el('div', { class: 'small' }, [`来源：${r.source}`]), ...rows);
        } catch (e) { toast('预览失败：' + e.message, 'err'); }
      } }, ['生成预览']),
      el('button', { class: 'btn primary', onclick: async () => {
        if (!window.__dscToken) { toast('请先生成预览', 'warn'); return; }
        try {
          const r = await api.post('/api/describe/apply', { token: window.__dscToken });
          undoToken = r.undoToken; window.__dscToken = '';
          toast('已应用（可撤销）', 'ok');
          await loadCanvas(); draw();
        } catch (e) { toast('应用失败：' + e.message, 'err'); }
      } }, ['应用']),
      el('button', { class: 'btn', onclick: async () => {
        if (!undoToken) { toast('没有可撤销的改动', 'warn'); return; }
        try { await api.post('/api/describe/undo', { token: undoToken }); undoToken = ''; toast('已撤销', 'ok'); await loadCanvas(); draw(); }
        catch (e) { toast('撤销失败：' + e.message, 'err'); }
      } }, ['撤销']),
    ],
  });
}

async function consistencyDialog() {
  const body = el('div', { class: 'col', style: { gap: '8px' } }, [el('div', { class: 'small muted' }, ['正在评分…'])]);
  let last = null;
  const m = modal({
    title: '📐 一致性体检（标红 + 一键重跑）', body, width: 660,
    footer: [
      el('button', { class: 'btn', onclick: () => m.close() }, ['关闭']),
      el('button', { class: 'btn primary', onclick: async () => {
        try {
          let r = await api.post('/api/canvas/consistency/rerun', { canvasId: S.canvasId, confirm: false });
          if (r.needConfirm) { const y = await confirmDialog(`${r.reason}\n\n确认重跑？`); if (!y) return; r = await api.post('/api/canvas/consistency/rerun', { canvasId: S.canvasId, confirm: true }); }
          toast(`一键重跑：${r.rerun || 0} 个节点${r.skippedLocked ? `（跳过锁定 ${r.skippedLocked}）` : ''}`, 'ok', 3600);
          await loadCanvas(); draw();
          body.replaceChildren(el('div', { class: 'small muted' }, [r.reason || '完成']));
        } catch (e) { toast('重跑失败：' + e.message, 'err'); }
      } }, ['一键重跑低分节点']),
    ],
  });
  try {
    const r = await api.get(`/api/canvas/consistency?canvasId=${encodeURIComponent(S.canvasId)}`);
    last = r;
    const rows = (r.nodes || []).map((n) => el('div', { class: 'small' }, [
      el('b', { style: { color: n.low ? 'var(--err)' : 'inherit' } }, [`${n.low ? '● ' : '○ '}${n.title || n.id}（${n.kind}）`]),
      el('span', { class: 'muted' }, [` ${n.images} 张 · ${n.low ? `离群 ${n.outliers.length} 张` : '正常'}${n.locked ? ' · 已锁定' : ''}`]),
    ]));
    body.replaceChildren(
      el('div', { class: 'small' }, [`检查 ${r.summary.checked} 个节点 / ${r.summary.images} 张图 · 低分 ${r.summary.low} 个 · 离群 ${r.summary.outliers} 张（阈值 ${r.threshold}）`]),
      el('div', { class: 'small muted' }, [r.note || '']),
      ...rows,
    );
  } catch (e) {
    body.replaceChildren(el('div', { class: 'small' }, ['评分失败：' + e.message]));
  }
}

async function renameGroupDialog(gr) {
  const form = { name: gr.name || '' };
  const body = el('div', { class: 'col', style: { gap: '10px' } }, [
    el('label', { class: 'f' }, ['分组名称', el('input', { type: 'text', value: form.name, oninput: (e) => { form.name = e.target.value; } })]),
    el('div', { class: 'hint' }, ['分组框用于在无限画布上组织演员（如「第一季主演」「反派家族」），可整体拖动、收起、着色；不影响演员档案与出图。']),
  ]);
  const m = modal({
    title: '✏️ 重命名分组', body, width: 460,
    footer: [
      el('button', { class: 'btn', onclick: () => m.close() }, ['取消']),
      el('button', { class: 'btn primary', onclick: async () => {
        try { await api.put('/api/canvas/groups/' + gr.id, { name: form.name }); m.close(); await loadCanvas(); draw(); toast('已重命名', 'ok'); }
        catch (e) { toast(e.message, 'err'); }
      } }, ['保存']),
    ],
  });
}

async function toggleGroupCollapse(gr) {
  try {
    await api.put('/api/canvas/groups/' + gr.id, { collapsed: !gr.collapsed });
    await loadCanvas(); draw();
    toast(gr.collapsed ? '已展开分组' : '已收起分组', 'ok', 1400);
  } catch (e) { toast(e.message, 'err'); }
}

async function cycleGroupColor(gr) {
  const cur = groupColor(gr);
  const idx = GROUP_COLORS.indexOf(cur);
  const next = GROUP_COLORS[(idx + 1 + GROUP_COLORS.length) % GROUP_COLORS.length];
  try { await api.put('/api/canvas/groups/' + gr.id, { color: next }); await loadCanvas(); draw(); }
  catch (e) { toast(e.message, 'err'); }
}

async function refitGroup(gr) {
  pushUndo();
  try { await api.post(`/api/canvas/groups/${gr.id}/members`, { actorIds: [] }); await loadCanvas(); draw(); toast('已贴合内容', 'ok', 1400); }
  catch (e) { toast(e.message, 'err'); }
}

async function dissolveGroup(gr, keepNodes) {
  if (!(await confirmDialog(keepNodes ? `解散分组「${gr.name}」？组内卡片会保留在画布上。` : `解散分组「${gr.name}」并删除组内卡位？演员档案不受影响。`))) return;
  pushUndo();
  try {
    await api.del(`/api/canvas/groups/${gr.id}?keepNodes=${keepNodes ? 1 : 0}`);
    S.selectedGroup = null;
    await loadCanvas(); draw();
    toast('已解散分组', 'ok');
  } catch (e) { toast(e.message, 'err'); }
}

async function autoGroup(groupBy) {
  pushUndo();
  try {
    const r = await api.post('/api/canvas/auto-group', { id: S.canvasId, groupBy, cols: S.cols, cell: S.cell, gap: S.gap });
    S.mode = 'matrix';
    await loadCanvas();
    updateModeButton(); draw();
    toast(`已按「${groupBy === 'style_id' ? '画风' : groupBy === 'role_type' ? '角色类型' : '种族'}」生成 ${r.groups.length} 个分组框`, 'ok');
    setTimeout(() => fitView(), 60);
  } catch (e) { toast('自动分组失败：' + e.message, 'err'); }
}

/** 便签：新建 / 编辑 / 改色 / 删除 */
async function addNote(placeAt = null) {
  const spot = placeAt || freeSpot(260, 170);
  const x = spot.x;
  const y = spot.y;
  pushUndo();
  try {
    await api.post('/api/canvas/notes', { canvas_id: S.canvasId, x, y, w: 260, h: 170, text: '双击编辑便签…', color: 'amber' });
    await loadCanvas(); draw();
    const notes = S.noteNodes || [];
    const last = notes[notes.length - 1];
    if (last) { ensureVisible({ x: last.x, y: last.y, w: last.w, h: last.h }); draw(); noteEditDialog(last); }
  } catch (e) { toast('新建便签失败：' + e.message, 'err'); }
}

function noteEditDialog(note) {
  const form = { text: note.note_text || '', color: note.note_color || 'amber' };
  const body = el('div', { class: 'col', style: { gap: '10px' } }, [
    el('label', { class: 'f' }, ['便签内容', el('textarea', { rows: 5, oninput: (e) => { form.text = e.target.value; } }, [form.text])]),
    el('div', {}, [
      el('div', { class: 'small muted', style: { marginBottom: '6px' } }, ['颜色']),
      el('div', { class: 'pill-group' }, Object.keys(NOTE_COLORS).map((k) => el('div', {
        class: `pill${form.color === k ? ' on' : ''}`,
        style: { borderColor: NOTE_COLORS[k] },
        onclick: (e) => { form.color = k; [...e.target.parentElement.children].forEach((c) => c.classList.remove('on')); e.target.classList.add('on'); },
      }, [k]))),
    ]),
  ]);
  const m = modal({
    title: '📝 便签', body, width: 520,
    footer: [
      el('button', { class: 'btn danger', onclick: async () => {
        try { await api.del('/api/canvas/node/' + note.id); m.close(); await loadCanvas(); draw(); toast('便签已删除', 'ok'); } catch (e) { toast(e.message, 'err'); }
      } }, ['删除便签']),
      el('button', { class: 'btn', onclick: () => m.close() }, ['取消']),
      el('button', { class: 'btn primary', onclick: async () => {
        try { await api.put('/api/canvas/notes/' + note.id, { text: form.text, color: form.color }); m.close(); await loadCanvas(); draw(); toast('便签已保存', 'ok'); }
        catch (e) { toast(e.message, 'err'); }
      } }, ['保存']),
    ],
  });
}

// ============================ T-L3 ① 节点内联编辑 ============================
// 双击「流程节点 / 资产节点 / 便签」就地改标题（note 改便签文本）：Enter / 失焦保存，Esc 取消。
// 写入一律复用文件里既有的接口，不新造：
//   note                        → PUT /api/canvas/notes/:id  （与 noteEditDialog 同一个）
//   scene/item/refimg + FLOW_KINDS → PUT /api/canvas/assets/:id（与资产节点编辑器同一个）
// 画布本体是 <canvas>，文字无法就地编辑，所以编辑框是浮在 .ac-canvas-wrap 里的真实 DOM 输入框；
// 它不在 canvas 上，因此拖拽/端口连线/框选/右键菜单/缩放平移的既有命中逻辑完全不受影响。

/** 可内联编辑的节点类型：便签 + 资产节点 + 流程节点（演员卡不在其列：双击仍打开档案） */
function inlineEditableKind(kind) {
  return kind === 'note' || ['scene', 'item', 'refimg', ...FLOW_KINDS].includes(kind);
}

/** 节点当前的编辑文本（便签取便签文本，其余取节点标题） */
function inlineValueOf(it) {
  return it.kind === 'note' ? (it.note?.note_text || '') : (it.node?.title || '');
}

/** 把编辑框定位到节点在屏幕上的位置（每帧 draw() 末尾调用；节点被删/换画布则自动收起） */
function syncInlineEdit() {
  const ed = S?.editing;
  if (!ed) return;
  const cv = canvasEl();
  const wrap = cv?.parentElement;
  if (!cv || !wrap) return;
  const it = (S._layout?.items || []).find((i2) => i2.id === ed.id && inlineEditableKind(i2.kind));
  if (!it) {                        // 节点已不在本画布（被删 / 切了画布）→ 收起，不写任何数据
    S.editing = null;
    try { ed.el.remove(); } catch { /* ignore */ }
    return;
  }
  const zoom = S.zoom || 1;
  const pad = 6 * zoom;
  const left = (it.x + S.panX) * zoom + pad;
  const top = (it.y + S.panY) * zoom + pad;
  const w = Math.max(120, it.w * zoom - pad * 2);
  const h = ed.kind === 'note' ? Math.max(48, Math.min(it.h * zoom - pad * 2, 220)) : Math.max(26, 30 * zoom);
  const st = ed.el.style;
  st.left = `${Math.round(left)}px`;
  st.top = `${Math.round(top)}px`;
  st.width = `${Math.round(w)}px`;
  st.height = `${Math.round(h)}px`;
  st.fontSize = `${Math.round(Math.max(12, Math.min(18, 13 * zoom)))}px`;
  // 节点被平移到视野外时把编辑框收起来（避免浮在画布空白处）
  const onScreen = left + w > 0 && top + h > 0 && left < cv.clientWidth && top < cv.clientHeight;
  st.display = onScreen ? '' : 'none';
}

/** 开始内联编辑：同一时刻只允许一个编辑框；换目标时先把上一个按「失焦保存」同口径存掉 */
function startInlineEdit(it) {
  if (!S || !it || !inlineEditableKind(it.kind)) return null;
  if (S.editing?.id === it.id) return S.editing;
  if (S.editing) endInlineEdit(true);
  const cv = canvasEl();
  const wrap = cv?.parentElement;
  if (!cv || !wrap) return null;
  const isNote = it.kind === 'note';
  const input = el(isNote ? 'textarea' : 'input', {
    class: 'ac-inline-edit',
    type: isNote ? undefined : 'text',
    value: inlineValueOf(it),
    placeholder: isNote ? '便签内容' : '节点标题',
    title: 'Enter / 失焦保存 · Esc 取消',
    rows: isNote ? 6 : undefined,
    dataset: { nodeId: it.id, nodeKind: it.kind },
  });
  // 编辑框自身的事件不参与画布交互（它不在 canvas 上，这里只是双保险）
  for (const t of ['pointerdown', 'mousedown', 'click', 'dblclick', 'contextmenu', 'wheel']) {
    input.addEventListener(t, (ev) => ev.stopPropagation());
  }
  input.addEventListener('keydown', (ev) => {
    ev.stopPropagation();                       // 不惊动画布级快捷键（删除/适应/撤销…）
    if (ev.key === 'Escape') { ev.preventDefault(); endInlineEdit(false); return; }
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); endInlineEdit(true); }
  });
  input.addEventListener('blur', () => { endInlineEdit(true); });
  wrap.append(input);
  S.editing = { id: it.id, kind: it.kind, el: input, orig: input.value, canvasId: S.canvasId };
  syncInlineEdit();
  try { input.focus(); input.select(); } catch { /* ignore */ }
  draw();
  return S.editing;
}

/** 结束内联编辑：commit=true 按既有接口落库；commit=false 为 Esc 取消（一个字节都不写） */
async function endInlineEdit(commit) {
  const ed = S?.editing;
  if (!ed) return null;
  S.editing = null;                             // 先清状态：blur/Enter 不会二次触发
  const value = String(ed.el?.value ?? '');
  try { ed.el?.remove(); } catch { /* ignore */ }
  draw();
  if (!commit) return { ok: true, cancelled: true, id: ed.id };
  if (value === ed.orig) return { ok: true, unchanged: true, id: ed.id };
  try {
    if (ed.kind === 'note') await api.put('/api/canvas/notes/' + ed.id, { text: value });
    else await api.put('/api/canvas/assets/' + ed.id, { title: value });   // data 缺省即不动物料字段
    await loadCanvas(); draw();
    toast(`已保存节点${ed.kind === 'note' ? '便签内容' : '标题'}`, 'ok', 1800);
    return { ok: true, saved: true, id: ed.id, value };
  } catch (e) {
    toast('节点保存失败：' + e.message, 'err', 3600);
    return { ok: false, id: ed.id, error: e.message };
  }
}

/** 节点层级 / 尺寸 */
async function bumpZ(delta) {
  const ids = [...S.selection];
  if (!ids.length) { toast('先选中卡片', 'warn'); return; }
  pushUndo();
  const nodes = (S._layout?.items || []).filter((i) => S.selection.has(i.actor.id)).map((i) => {
    const node = S.nodes.get(i.actor.id) || {};
    const z = delta === 'top' ? 100000 + i.index : delta === 'bottom' ? -1 : (node.z || 0) + (delta === 'up' ? 2 : -2);
    return { canvas_id: S.canvasId, actor_id: i.actor.id, x: i.x, y: i.y, w: i.w, h: i.h, z };
  });
  if (!nodes.length) return;
  try { await api.post('/api/canvas/nodes', { nodes }); await loadCanvas(); draw(); toast('已调整层级', 'ok', 1200); }
  catch (e) { toast(e.message, 'err'); }
}

async function uniformSize() {
  if (!S.selection.size) { toast('先选中卡片', 'warn'); return; }
  pushUndo();
  const nodes = (S._layout?.items || []).filter((i) => S.selection.has(i.actor.id)).map((i) => ({ canvas_id: S.canvasId, actor_id: i.actor.id, x: i.x, y: i.y, w: S.cell, h: S.cell }));
  try { await api.post('/api/canvas/nodes', { nodes }); await loadCanvas(); draw(); toast(`已统一为 ${S.cell}×${S.cell}`, 'ok'); }
  catch (e) { toast(e.message, 'err'); }
}

// ---------------- 画布管理（多画布） ----------------
async function loadCanvasList() {
  try {
    const r = await api.get('/api/canvas/list');
    S.canvases = r.canvases || [];
    renderCanvasPicker();
  } catch (e) { console.warn('画布列表加载失败', e); }
}

function renderCanvasPicker() {
  const box = rootEl?.querySelector('#ac-canvas-picker');
  if (!box) return;
  box.innerHTML = '';
  // 画布栏右键菜单：重命名 / 复制为新画布 / 清空卡位 / 删除（主画布受保护）
  const sel = select(S.canvases.map((c) => ({ id: c.id, name: `${c.name}（${c.node_count}）` })), S.canvasId, async (v) => {
    S.canvasId = v;
    S.selection = new Set(); S.selectedOrder = [];
    S.selectedGroup = null; S.selectedNote = null; S.undoStack = []; S.redoStack = [];
    await loadCanvas();
    updateCount(); renderList(); draw();
  }, { style: { width: '190px' } });   // 注意：原来是 box.append(select(...))，现在直接赋值给 sel，少一层括号
  sel.title = '左键切换画布；右键可重命名 / 复制 / 清空 / 删除';
  sel.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    const id = sel.value;
    const cur = (S.canvases || []).find((c) => c.id === id);
    if (!cur) return;
    const isMain = id === 'CV-MAIN';
    const pick = (target) => { if (target !== id) { sel.value = target; sel.dispatchEvent(new Event('change')); } };
    contextMenu(ev.clientX, ev.clientY, [
      { header: `🗂 ${cur.name}（${cur.node_count} 个卡位）` },
      { label: '✏️ 重命名画布…', onClick: () => renameCanvasDialog(cur, () => pick(id)) },
      { label: '📄 复制为新画布…', onClick: () => duplicateCanvasDialog(cur) },
      { label: '▦ 自动排布宫格', onClick: async () => {
        try { const r = await api.post('/api/canvas/arrange', { id, mode: 'matrix', cols: S.cols, cell: S.cell, gap: S.gap }); await loadCanvas(); draw(); toast(`已按 ${S.cols} 列宫格排布（${r?.created ?? 0} 个卡位）`, 'ok'); }
        catch (e) { toast('排布失败：' + e.message, 'err'); }
      } },
      { label: '⌀ 清空本画布卡位', onClick: () => { if (id !== S.canvasId) { sel.value = id; sel.dispatchEvent(new Event('change')); } setTimeout(() => clearCurrentCanvas(), 400); } },
      { label: isMain ? '🔒 主画布不可删除' : '🗑 删除该画布（含其卡位与连线）', danger: !isMain, onClick: async () => {
        if (isMain) { toast('主画布不可删除（它是宫格预览全部演员的入口画布）', 'warn', 3000); return; }
        if (!(await confirmDialog(`删除画布「${cur.name}」？\n\n该画布上的卡位与关系线会一起删除；演员档案、定妆图、小说、剧本、成片都不受影响。`))) return;
        try {
          await api.del('/api/canvas/' + id);
          const left = await api.get('/api/canvas/list');
          S.canvases = left.canvases || [];
          if (S.canvasId === id) { S.canvasId = 'CV-MAIN'; await loadCanvas(); updateCount(); renderList(); }
          renderCanvasPicker(); draw();
          toast(`已删除画布「${cur.name}」`, 'ok');
        } catch (e) { toast('删除失败：' + e.message, 'err', 3600); }
      } },
      { label: '↻ 刷新画布列表', onClick: async () => { S.canvases = (await api.get('/api/canvas/list')).canvases || []; renderCanvasPicker(); toast('已刷新', 'ok', 1400); } },
    ]);
  });
  sel.addEventListener('dblclick', () => {
    const cur = (S.canvases || []).find((c) => c.id === sel.value);
    if (cur) renameCanvasDialog(cur);
  });
  box.append(sel);
}

/** 查找对话框（工具栏「🔍 查找」/ 调试入口）：输入关键字 → 命中高亮并居中 */
async function findDialog() {
  const q = await promptDialog('查找节点（标题 / 类型 / 演员名）', S.findQuery || '');
  if (q === null) return { hits: S.findHits?.length || 0 };
  S.findQuery = String(q).trim();
  return findJump(0);
}

/** 画布内查找：按标题/类型/演员名匹配可见节点；回车在命中之间跳转并居中 */
function findJump(step = 1) {
  const q = String(S.findQuery || '').trim().toLowerCase();
  if (!q) { S.findHits = []; S.findIdx = -1; draw(); return { hits: 0 }; }
  const items = S._layout?.items || [];
  const hits = items.filter((it) => [it.node?.title, it.actor?.name, it.actorId, it.kind, it.node?.kind, it.note?.note_text]
    .filter(Boolean).join(' ').toLowerCase().includes(q)).map((it) => it.id);
  S.findHits = hits;
  if (!hits.length) { S.findIdx = -1; draw(); toast(`没有匹配「${S.findQuery}」的节点`, 'warn', 2000); return { hits: 0 }; }
  S.findIdx = ((S.findIdx + step) % hits.length + hits.length) % hits.length;
  const target = items.find((it) => it.id === hits[S.findIdx]);
  if (target) {
    const cv = canvasEl();
    S.panX = -(target.x + target.w / 2) + (cv ? cv.clientWidth : 800) / (2 * S.zoom);
    S.panY = -(target.y + target.h / 2) + (cv ? cv.clientHeight : 600) / (2 * S.zoom);
    S.selectedExtra = target.id; scheduleViewSave();
  }
  draw();
  toast(`命中 ${S.findIdx + 1}/${hits.length}：${target?.node?.title || target?.actor?.name || target?.kind || ''}`, 'ok', 1800);
  return { hits: hits.length, idx: S.findIdx };
}
const isFindHit = (it) => Boolean(S.findHits?.length && S.findHits.includes(it.id));

/** 删除当前画布（工具栏按钮；与画布栏右键删除同一套逻辑，主画布受保护） */
async function deleteCurrentCanvas() {
  const cur = (S.canvases || []).find((c) => c.id === S.canvasId);
  if (!cur) { toast('当前画布信息未就绪，请稍后重试', 'warn'); return; }
  if (cur.id === 'CV-MAIN') { toast('主画布不可删除（它是宫格预览全部演员的入口画布）', 'warn', 3200); return; }
  const n = (api.get ? 0 : 0);
  if (!(await confirmDialog(`删除画布「${cur.name}」？\n\n该画布上的卡位与关系线会一起删除；演员档案、定妆图、小说、剧本、成片都不受影响。\n\n此操作不可撤销。`))) return;
  try {
    await api.del('/api/canvas/' + cur.id);
    S.canvases = (await api.get('/api/canvas/list')).canvases || [];
    S.canvasId = 'CV-MAIN';
    S.selection = new Set(); S.selectedOrder = []; S.selectedGroup = null; S.selectedNote = null;
    S.undoStack = []; S.redoStack = [];
    await loadCanvas();
    renderCanvasPicker(); updateCount(); renderList(); draw();
    toast(`已删除画布「${cur.name}」，已切回主画布`, 'ok', 3600);
  } catch (e) { toast('删除失败：' + e.message, 'err', 4000); }
}

/** 重命名画布（画布栏右键 / 双击） */
function renameCanvasDialog(cur, after = null) {
  const form = { name: cur.name || '' };
  const body = el('div', { class: 'col', style: { gap: '10px' } }, [
    el('label', { class: 'f' }, ['画布名称', el('input', { type: 'text', value: form.name, oninput: (e) => { form.name = e.target.value; } })]),
    el('div', { class: 'hint' }, ['重命名只改显示名，画布 id 与卡位/分组/连线都不变。']),
  ]);
  const m = modal({
    title: '✏️ 重命名画布', body, width: 440,
    footer: [
      el('button', { class: 'btn', onclick: () => m.close() }, ['取消']),
      el('button', { class: 'btn primary', onclick: async () => {
        const name = (form.name || '').trim();
        if (!name) { toast('画布名称不能为空', 'warn'); return; }
        try {
          await api.put('/api/canvas', { id: cur.id, name });
          S.canvases = (await api.get('/api/canvas/list')).canvases || [];
          renderCanvasPicker();
          m.close();
          if (after) after();
          toast(`已重命名为「${name}」`, 'ok');
        } catch (e) { toast('重命名失败：' + e.message, 'err', 3600); }
      } }, ['保存']),
    ],
  });
  setTimeout(() => body.querySelector('input')?.focus(), 60);
}

/** 复制为新画布（含卡位/分组/连线，演员与素材共享） */
function duplicateCanvasDialog(cur) {
  const form = { name: `${cur.name} · 副本` };
  const body = el('div', { class: 'col', style: { gap: '10px' } }, [
    el('label', { class: 'f' }, ['新画布名称', el('input', { type: 'text', value: form.name, oninput: (e) => { form.name = e.target.value; } })]),
    el('div', { class: 'hint' }, ['复制会带上该画布的卡位排布、分组与关系线（演员档案与素材是共享的，不重复占空间）。']),
  ]);
  const m = modal({
    title: '📄 复制为新画布', body, width: 460,
    footer: [
      el('button', { class: 'btn', onclick: () => m.close() }, ['取消']),
      el('button', { class: 'btn primary', onclick: async () => {
        const name = (form.name || '').trim();
        if (!name) { toast('请填新画布名称', 'warn'); return; }
        try {
          // 取源画布快照 → 建新画布 → 还原快照（复用既有 restoreCanvas，连线含端口与槽位）
          const src = (await api.get('/api/canvas?id=' + encodeURIComponent(cur.id))).canvas;
          const created = (await api.post('/api/canvas/create', { name })).canvas;
          await api.post('/api/canvas/restore', { canvas_id: created.id, nodes: src.nodes || [], groups: src.groups || [], links: src.links || [], allowEmpty: true });
          S.canvases = (await api.get('/api/canvas/list')).canvases || [];
          m.close();
          toast(`已复制为「${name}」（${(src.nodes || []).length} 卡位 / ${(src.groups || []).length} 分组 / ${(src.links || []).length} 连线）`, 'ok', 4200);
        } catch (e) { toast('复制失败：' + e.message, 'err', 3600); }
      } }, ['创建副本']),
    ],
  });
}

function newCanvasDialog() {
  const form = { name: '', cols: S.cols, cell: S.cell };
  const body = el('div', { class: 'col', style: { gap: '10px' } }, [
    el('label', { class: 'f' }, ['画布名称', el('input', { type: 'text', placeholder: '例如：第一季主演阵容', oninput: (e) => { form.name = e.target.value; } })]),
    el('div', { class: 'grid2' }, [
      el('label', { class: 'f' }, ['宫格列数', el('input', { type: 'number', value: S.cols, min: 1, max: 12, oninput: (e) => { form.cols = +e.target.value || 5; } })]),
      el('label', { class: 'f' }, ['卡位宽度', el('input', { type: 'number', value: S.cell, min: 90, max: 460, oninput: (e) => { form.cell = +e.target.value || 210; } })]),
    ]),
    el('div', { class: 'hint' }, ['新画布是独立的排布空间（同一批演员可以出现在多个画布上）。创建后可「自动排布宫格」一键填充。']),
  ]);
  const m = modal({
    title: '🗂 新建画布', body, width: 480,
    footer: [
      el('button', { class: 'btn', onclick: () => m.close() }, ['取消']),
      el('button', { class: 'btn primary', onclick: async () => {
        try {
          const r = await api.post('/api/canvas/create', form);
          m.close();
          await loadCanvasList();
          S.canvasId = r.canvas.id;
          await loadCanvas();
          renderCanvasPicker();
          draw();
          toast('画布已创建', 'ok');
        } catch (e) { toast(e.message, 'err'); }
      } }, ['创建']),
    ],
  });
}

// ---------------- 右键清单 ----------------
function actorContextMenu(mx, my, actorIds) {
  const kinds = C.meta?.kinds || [];
  const one = actorIds.length === 1 ? actorIds[0] : null;
  const actor = S.actors.find((a) => a.id === one);
  const genSub = kinds.filter((k) => k.id !== 'group').map((k) => ({
    label: `${k.icon} ${k.label}`,
    hint: k.multi ? `${k.variants.length} 种` : '',
    children: [
      { label: `▶ 生成全部变体（${k.variants.length} 张）`, onClick: () => generateDialog(actorIds, k.id, k.variants.map((v) => v.id)) },
      { separator: true },
      ...k.variants.map((v) => ({ label: v.label, onClick: () => generateDialog(actorIds, k.id, [v.id]) })),
      k.id === 'custom' ? null : { separator: true },
      k.id === 'custom' ? null : { label: '自定义参数生成…', onClick: () => generateDialog(actorIds, k.id, []) },
    ].filter(Boolean),
  }));

  const items = [
    { header: actor ? `${actor.name} · ${actor.id}` : `${actorIds.length} 位演员` },
    { label: '📋 打开明星档案', disabled: !one, onClick: () => openProfile(one) },
    { label: '✏️ 编辑档案', disabled: !one, onClick: () => openActorEditor(one) },
    { separator: true },
    { label: '🖼 生成（文生图 / 参考生图）', icon: '✨', children: genSub },
    { label: '⚡ 打开生成参数面板…', onClick: () => generateDialog(actorIds, 'face', []) },
    { label: '⚡ 与选中的环境/物品组合出图…', onClick: () => composeDialog(currentSelectionNodeIds()) },
    { label: '🎨 仅优化提示词（LLM）', disabled: !one, onClick: () => optimizePrompt(one) },
    { label: '📖 加入小说选角…', onClick: () => addActorsToNovel(actorIds) },
    { label: '🧠 AI 补全人物描述', disabled: !one, onClick: () => describeActor(one) },
    { separator: true },
    { label: '⭐ 生成全身定妆主图', onClick: () => generateDialog(actorIds, 'full', ['keyart']) },
    { label: '🧑‍🤝‍🧑 双人同框（相手戏，按选择顺序取前 2 位）', disabled: actorIds.length < 2, onClick: () => generateDialog(actorIds.slice(0, 2), 'group', ['duo']) },
    { separator: true },
    { label: `☑️ 全选当前视图（${filteredActors().length}）`, onClick: () => selectAllVisible() },
    { label: '🧹 取消选择', onClick: () => clearSelection() },
    { separator: true },
    { label: '📄 复制演员 ID', disabled: !one, onClick: () => { navigator.clipboard?.writeText(one); toast('已复制 ' + one, 'ok'); } },
    { label: '📄 复制提示词', disabled: !one, onClick: () => copyPrompt(one) },
    { label: '🧬 复制为副本（Ctrl+D）', onClick: () => duplicateActors(actorIds) },
    { separator: true },
    { label: '🗂 组成分组（Frame）', disabled: actorIds.length < 1, onClick: () => groupSelected() },
    { label: '⬆️ 置于顶层', hint: ']', onClick: () => bumpZ('top') },
    { label: '⬇️ 置于底层', hint: '[', onClick: () => bumpZ('bottom') },
    { label: '⇧ 上移一层', onClick: () => bumpZ('up') },
    { label: '⇩ 下移一层', onClick: () => bumpZ('down') },
    { label: '📐 统一尺寸', onClick: () => uniformSize() },
    { label: '🔍 定位到卡片（缩放到选区）', disabled: !one, onClick: () => { selectOnly(one); zoomToSelection(); } },
    { label: '🔗 连线到…（关系/对手戏）', disabled: !one, onClick: () => linkDialog(one) },
    { label: '🔗 管理该演员的连线', disabled: !one, onClick: () => manageLinksDialog(one) },
    one ? { label: (S.nodes.get(one)?.locked ? '🔓 解锁卡位' : '🔒 锁定卡位（禁止拖动）'), onClick: () => toggleNodeLock(one) } : null,
    { separator: true },
    { label: '🔲 把选中项移到最前（宫格重排）', onClick: () => moveSelectedToFront() },
    { label: '🗑 删除演员', disabled: actorIds.length === 0, onClick: () => deleteActors(actorIds) },
  ];
  contextMenu(mx, my, items);
}

function canvasContextMenu(mx, my, world = null) {
  const kinds = [
    { label: '➕ 新建演员', onClick: () => openActorEditor(null) },
    world ? { label: `📍 在此处新建演员（${Math.round(world.x)}, ${Math.round(world.y)}）`, onClick: () => openActorEditor(null, { placeAt: { x: Math.round(world.x), y: Math.round(world.y) } }) } : null,
    { label: '🗂 新建画布…', onClick: () => newCanvasDialog() },
    { separator: true },
    { label: '📝 在此处新建便签', onClick: () => addNote(world ? { x: Math.round(world.x), y: Math.round(world.y) } : null) },
    { label: '🏞 在此处新建环境节点', onClick: () => addAsset('scene', world ? { x: Math.round(world.x), y: Math.round(world.y) } : null) },
    { label: '🗝 在此处新建物品节点', onClick: () => addAsset('item', world ? { x: Math.round(world.x), y: Math.round(world.y) } : null) },
    { label: '🖼 在此处新建参考图节点', onClick: () => addAsset('refimg', world ? { x: Math.round(world.x), y: Math.round(world.y) } : null) },
    { label: '🧩 参考图矩阵（批量上传）…', onClick: () => refMatrixDialog(world ? { x: Math.round(world.x), y: Math.round(world.y) } : null) },
    { label: '⚡ 组合出图（用当前选中节点）', disabled: !currentSelectionNodeIds().length, onClick: () => composeDialog() },
    { label: '🗂 把选中卡片组成分组', disabled: !S.selection.size, onClick: () => groupSelected() },
    { separator: true },
    { label: `⊕ 放入全部演员（${S.actors.length}）`, onClick: () => putAllActors() },
    { label: '⌀ 清空本画布卡位', onClick: () => clearCurrentCanvas() },
    { separator: true },
    { label: '🔲 宫格排布（按当前列数）', onClick: () => autoArrange('matrix') },
    { label: '🎨 按画风生成分组框', onClick: () => autoGroup('style_id') },
    { label: '🎭 按角色类型生成分组框', onClick: () => autoGroup('role_type') },
    { label: '🧬 按种族生成分组框', onClick: () => autoGroup('race') },
    { label: '🔀 切换 宫格 / 自由 模式', onClick: () => toggleMode() },
    { separator: true },
    { label: `☑️ 全选当前视图（${filteredActors().length}）`, onClick: () => selectAllVisible() },
    { label: '🧹 取消选择', onClick: () => clearSelection() },
    { label: `⚡ 批量生成全部演员（${filteredActors().length} 人 · 脸部特写）`, onClick: () => generateDialog(filteredActors().map((a) => a.id), 'face', ['front']) },
    { separator: true },
    { label: '⤢ 适应窗口', hint: 'F', onClick: () => fitView() },
    { label: '⟲ 复位视图', hint: '0', onClick: () => resetView() },
    { label: '🖼 导出 PNG 阵容图', onClick: () => exportCanvasPNG() },
    { label: `🔍 缩放 ${Math.round(S.zoom * 100)}%`, disabled: true },
    { separator: true },
    { label: '↻ 刷新数据', onClick: () => loadAll() },
  ];
  contextMenu(mx, my, [{ header: `画布 · ${S.mode === 'matrix' ? '宫格模式' : '自由模式'}` }, ...kinds]);
}

/** 连线到另一位演员（关系标签：对手戏/亲属/敌对/师徒…） */
function linkDialog(fromId) {
  const from = S.actors.find((a) => a.id === fromId);
  const others = S.actors.filter((a) => a.id !== fromId);
  if (!others.length) { toast('至少需要两位演员才能连线', 'warn'); return; }
  const LABELS = ['对手戏', '亲属', '敌对', '师徒', '恋人', '同盟', '上下级', '宿敌'];
  const form = { to: others[0].id, label: '对手戏', color: '' };
  const body = el('div', { class: 'col', style: { gap: '12px' } }, [
    el('div', { class: 'small muted' }, [`起点：${from?.name || fromId}（${fromId}）`]),
    el('label', { class: 'f' }, ['连接到', select(others.map((a) => ({ id: a.id, name: `${a.name}（${a.id}）` })), form.to, (v) => { form.to = v; })]),
    el('div', {}, [
      el('div', { class: 'small muted', style: { marginBottom: '6px' } }, ['关系标签']),
      el('div', { class: 'pill-group' }, LABELS.map((lb) => el('div', {
        class: `pill${form.label === lb ? ' on' : ''}`,
        onclick: (e) => { form.label = lb; [...e.target.parentElement.children].forEach((c) => c.classList.remove('on')); e.target.classList.add('on'); },
      }, [lb]))),
    ]),
    el('label', { class: 'f' }, ['自定义标签（可留空）', el('input', { type: 'text', placeholder: '例如：同父异母', oninput: (e) => { form.custom = e.target.value; } })]),
    el('div', { class: 'hint' }, ['连线会画在画布上（可开关显示），用于在选角矩阵里直观表达人物关系；不会影响出图或剧本数据。']),
  ]);
  const m = modal({
    title: '🔗 建立关系连线', body, width: 520,
    footer: [
      el('button', { class: 'btn', onclick: () => m.close() }, ['取消']),
      el('button', { class: 'btn primary', onclick: async () => {
        try {
          const link = await api.post('/api/canvas/links', { canvas_id: S.canvasId, from_actor: fromId, to_actor: form.to, label: (form.custom || '').trim() || form.label });
          S.links = [...(S.links || []), link.link];
          m.close(); draw();
          toast('已连线', 'ok');
        } catch (e) { toast(e.message, 'err'); }
      } }, ['连线']),
    ],
  });
}

/** 查看/删除与某位演员相关的连线 */
function manageLinksDialog(actorId) {
  const actor = S.actors.find((a) => a.id === actorId);
  const mine = (S.links || []).filter((l) => l.from_actor === actorId || l.to_actor === actorId);
  const nameOf = (id) => S.actors.find((a) => a.id === id)?.name || id;
  const box = el('div', { class: 'col', style: { gap: '8px' } });
  const render = () => {
    box.innerHTML = '';
    if (!mine.length) { box.append(el('div', { class: 'small muted' }, ['该演员还没有连线。右键卡片 →「🔗 连线到…」建立关系。'])); return; }
    for (const l of mine) {
      box.append(el('div', { class: 'row', style: { gap: '8px' } }, [
        el('div', { class: 'grow small' }, [`${nameOf(l.from_actor)} → ${nameOf(l.to_actor)}`, el('span', { class: 'tag accent', style: { marginLeft: '6px' } }, [l.label || '关系'])]),
        el('button', { class: 'btn xs danger', onclick: async () => {
          try {
            await api.del('/api/canvas/links/' + l.id);
            S.links = (S.links || []).filter((x) => x.id !== l.id);
            const i = mine.indexOf(l); if (i >= 0) mine.splice(i, 1);
            render(); draw(); toast('已删除连线', 'ok');
          } catch (e) { toast(e.message, 'err'); }
        } }, ['删除']),
      ]));
    }
  };
  render();
  modal({ title: `🔗 ${actor?.name || actorId} 的关系连线`, body: box, width: 520 });
}

async function toggleNodeLock(actorId) {
  const node = S.nodes.get(actorId) || S._itemsById?.get(actorId)?.node;
  if (!node?.id) { toast('该卡位尚未持久化，先拖动一次或执行「自动排布」', 'warn'); return; }
  try {
    const r = await api.post(`/api/canvas/node/${node.id}/lock`, { locked: !node.locked });
    node.locked = r.ok && !node.locked ? 1 : 0;
    if (S.nodes.has(actorId)) S.nodes.get(actorId).locked = node.locked;
    draw();
    toast(node.locked ? '已锁定卡位' : '已解锁卡位', 'ok');
  } catch (e) { toast(e.message, 'err'); }
}

async function moveSelectedToFront() {
  const order = S.selectedOrder.length ? S.selectedOrder : [...S.selection];
  if (!order.length) return;
  const ids = [...order, ...S.actors.map((a) => a.id).filter((id) => !order.includes(id))];
  try {
    await api.post('/api/actors/reorder', { ids });
    await loadActors(); renderList(); draw();
    toast('已把选中项排到最前', 'ok');
  } catch (e) { toast(e.message, 'err'); }
}

async function copyPrompt(id) {
  try {
    const r = await api.post(`/api/actors/${id}/prompt`, { kind: 'full', variant: 'keyart' });
    await navigator.clipboard?.writeText(r.positive);
    toast('已复制该演员的完整正向提示词', 'ok');
  } catch (e) { toast(e.message, 'err'); }
}

async function deleteActors(ids) {
  const names = ids.map((id) => S.actors.find((a) => a.id === id)?.name || id).join('、');
  if (!(await confirmDialog(`确认删除 ${ids.length} 位演员（${names}）？其定妆图记录也会一并删除。`))) return;
  pushUndo();
  for (const id of ids) { try { await api.del('/api/actors/' + id); } catch (e) { toast(e.message, 'err'); } }
  S.selection = new Set();
  await loadAll();
  toast('已删除', 'ok');
}

// ---------------- 生成参数对话框 ----------------
function generateDialog(actorIds, kind, variants) {
  if (!actorIds.length) { toast('请先选择演员', 'warn'); return; }
  const meta = C.meta || {};
  const kinds = meta.kinds || [];
  const kdef = kinds.find((k) => k.id === kind) || kinds[0];
  const selected = new Set(variants?.length ? variants : (kdef?.multi ? kdef.variants.map((v) => v.id) : ['default']));
  const chosenKind = { id: kind };
  const params = { perVariant: 1, styleId: '', ratio: '', seed: '', cfg: '', steps: '', extra: '', negativeExtra: '', scene: '', useRef: Boolean(S.actors.find((a) => a.id === actorIds[0])?.cover_image), randomize: false };

  const body = el('div', { class: 'col', style: { gap: '14px' } });
  const kindGrid = el('div', { class: 'kind-grid' });
  const varBox = el('div', { class: 'pill-group' });
  const styleBox = el('div', { class: 'pill-group' });
  const summary = el('div', { class: 'code', style: { maxHeight: '150px' } });

  function renderKinds() {
    kindGrid.innerHTML = '';
    for (const k of kinds) {
      kindGrid.append(el('div', {
        class: `kind-card${chosenKind.id === k.id ? ' on' : ''}`,
        onclick: () => { chosenKind.id = k.id; selected.clear(); (k.multi ? k.variants : [{ id: 'default' }]).forEach((v) => selected.add(v.id)); renderKinds(); renderVariants(); refreshPreview(); },
      }, [
        el('div', { class: 't' }, [`${k.icon} ${k.label}`]),
        el('div', { class: 'd', text: k.desc }),
      ]));
    }
  }
  function renderVariants() {
    const k = kinds.find((x) => x.id === chosenKind.id) || kdef;
    varBox.innerHTML = '';
    const list = k.multi ? k.variants : [{ id: 'default', label: '默认' }];
    for (const v of list) {
      varBox.append(el('div', { class: `pill${selected.has(v.id) ? ' on' : ''}`, onclick: () => { if (selected.has(v.id)) selected.delete(v.id); else selected.add(v.id); renderVariants(); refreshPreview(); } }, [v.label]));
    }
  }
  function renderStyles() {
    styleBox.innerHTML = '';
    const first = S.actors.find((a) => a.id === actorIds[0]);
    for (const s of [{ id: '', name: '跟随各自档案' }, ...(meta.styles || [])]) {
      styleBox.append(el('div', { class: `pill${params.styleId === s.id ? ' on' : ''}`, title: s.desc || '', onclick: () => { params.styleId = s.id; renderStyles(); refreshPreview(); } }, [s.name]));
    }
    const el0 = styleBox.querySelector('.pill');
    if (el0 && S.actors.length && first) el0.title = `各演员使用自己的风格（${first.style_id}）`;
  }

  async function refreshPreview() {
    try {
      const a = S.actors.find((x) => x.id === actorIds[0]);
      const r = await api.post('/api/prompt/preview', {
        actor: a, actorId: actorIds[0], styleId: params.styleId || undefined, kind: chosenKind.id,
        variant: [...selected][0] || undefined, extra: params.extra, scene: params.scene,
        ratio: params.ratio || undefined,
      });
      summary.textContent = `【正向 / POSITIVE】\n${r.positive}\n\n【负向 / NEGATIVE】\n${r.negative}\n\n【尺寸】${r.width}×${r.height}（${r.ratio}）· 本次将生成 ${actorIds.length * Math.max(1, selected.size) * params.perVariant} 张`;
    } catch (e) { summary.textContent = '预览失败：' + e.message; }
  }

  body.append(
    el('div', { class: 'small muted' }, [`对象：${actorIds.map((id) => S.actors.find((a) => a.id === id)?.name || id).join('、')}`]),
    el('div', {}, [el('div', { class: 'small muted', style: { marginBottom: '6px' } }, ['① 选择生成类型']), kindGrid]),
    el('div', {}, [el('div', { class: 'small muted', style: { marginBottom: '6px' } }, ['② 选择变体（可多选）']), varBox]),
    el('div', {}, [el('div', { class: 'small muted', style: { marginBottom: '6px' } }, ['③ 画风覆盖']), styleBox]),
    el('div', { class: 'grid3' }, [
      el('label', { class: 'f' }, ['每变体张数', el('input', { type: 'number', min: 1, max: 8, value: 1, onchange: (e) => { params.perVariant = Math.max(1, Math.min(8, +e.target.value || 1)); refreshPreview(); } })]),
      el('label', { class: 'f' }, ['比例尺寸', select([{ id: '', name: '跟随档案/类型' }, ...(meta.ratios || []).map((r) => ({ id: r.id, name: r.name }))], '', (v) => { params.ratio = v; refreshPreview(); })]),
      el('label', { class: 'f' }, ['种子 seed（空=随机）', el('input', { type: 'text', placeholder: '随机', oninput: (e) => { params.seed = e.target.value.trim(); } })]),
      el('label', { class: 'f' }, ['CFG', el('input', { type: 'text', placeholder: '默认', oninput: (e) => { params.cfg = e.target.value.trim(); } })]),
      el('label', { class: 'f' }, ['步数 steps', el('input', { type: 'text', placeholder: '默认', oninput: (e) => { params.steps = e.target.value.trim(); } })]),
      el('label', { class: 'f' }, ['随机参数', el('button', { class: 'btn sm', onclick: async () => {
        try { const r = await api.get('/api/prompt/random-params'); params.seed = r.params.seed; params.cfg = r.params.cfg; params.steps = r.params.steps; toast(`随机：seed ${r.params.seed} / cfg ${r.params.cfg} / steps ${r.params.steps}`, 'ok'); }
        catch (e) { toast(e.message, 'err'); }
      } }, ['🎲 一键随机'])]),
    ]),
    el('label', { class: 'f' }, ['补充正向词（英文/中文均可，自动拼接在人物锚点后）', el('input', { type: 'text', placeholder: 'e.g. rainy night, neon reflections', oninput: (e) => { params.extra = e.target.value; refreshPreview(); } })]),
    el('label', { class: 'f' }, ['补充负向词', el('input', { type: 'text', placeholder: 'e.g. glasses, hat', oninput: (e) => { params.negativeExtra = e.target.value; } })]),
    el('label', { class: 'f' }, ['场景/氛围（拼在构图段）', el('input', { type: 'text', placeholder: 'e.g. in a bamboo forest at dawn', oninput: (e) => { params.scene = e.target.value; refreshPreview(); } })]),
    el('label', { class: 'row', style: { gap: '8px' } }, [
      el('input', { type: 'checkbox', style: { width: 'auto' }, checked: params.useRef, onchange: (e) => { params.useRef = e.target.checked; } }),
      el('span', { text: '参考生图：以该演员的定妆主图 / 参考图为基准（推荐，用于跨图一致性；需后端支持图生图或参考图接口）' }),
    ]),
    el('div', {}, [el('div', { class: 'small muted', style: { marginBottom: '6px' } }, ['④ 提示词实时预览（英文）']), summary]),
  );

  renderKinds(); renderVariants(); renderStyles(); refreshPreview();

  const footer = [
    el('button', { class: 'btn', onclick: () => m.close() }, ['取消']),
    el('button', { class: 'btn primary', onclick: async () => {
      m.close();
      await startGeneration(actorIds, chosenKind.id, [...selected], params);
    } }, ['🚀 开始生成']),
  ];
  const m = modal({ title: `🎨 生成定妆素材 · ${actorIds.length} 位演员`, body, width: 760, footer });
  m.modal.classList.add('gen-dialog');
}

async function startGeneration(actorIds, kind, variants, params) {
  if (!variants.length) { toast('请至少选择一个变体', 'warn'); return; }
  const payload = {
    actorIds, kind, variants,
    perVariant: params.perVariant || 1,
    styleId: params.styleId || undefined,
    ratio: params.ratio || undefined,
    seed: params.seed === '' ? null : Number(params.seed),
    cfg: params.cfg === '' ? null : Number(params.cfg),
    steps: params.steps === '' ? null : Number(params.steps),
    extra: params.extra || '', negativeExtra: params.negativeExtra || '', scene: params.scene || '',
    useRef: Boolean(params.useRef),
  };
  try {
    const r = await api.post('/api/generate/batch', payload);
    toast(`已提交生成任务（${r.total} 张）`, 'ok');
    watchGeneration(r.jobId, r.total);
    for (const id of actorIds) { const a = S.actors.find((x) => x.id === id); if (a) a.status = 'generating'; }
    draw();
  } catch (e) { toast('生成失败：' + e.message, 'err'); }
}

function watchGeneration(jobId, total) {
  const box = rootEl.querySelector('#ac-float');
  const card = el('div', { class: 'job-mini' }, [
    el('div', { class: 'row' }, [el('div', { class: 'spinner' }), el('div', { class: 'grow', text: `生成中 0/${total}` })]),
    el('div', { class: 'bar', style: { marginTop: '7px' } }, [el('i', { style: { width: '0%' } })]),
  ]);
  box.append(card);
  const stop = api.watchJob(jobId, (job) => {
    const bar = card.querySelector('i');
    const txt = card.querySelector('.grow');
    if (bar) bar.style.width = `${job.progress || 0}%`;
    if (txt) txt.textContent = `${job.status === 'running' ? '生成中' : job.status} ${job.done || 0}/${job.total || total}`;
  }, {
    onDone: async (job) => {
      card.remove();
      const failed = job.result?.failed || 0;
      toast(job.status === 'done' ? `生成完成：${job.result?.total || total} 张${failed ? `，失败 ${failed} 张` : ''}` : `生成失败：${job.error || ''}`, job.status === 'done' ? (failed ? 'warn' : 'ok') : 'err');
      S.actors.forEach((a) => { if (a.status === 'generating') a.status = 'ready'; });
      await loadActors(); renderList(); draw();
      if (S.currentActor) openProfile(S.currentActor, true);
    },
  });
  S.jobTimers.push(stop);
}

async function batchGenerateDialog() {
  const ids = S.selectedOrder.length ? S.selectedOrder.filter((id) => S.selection.has(id)) : [...S.selection];
  if (!ids.length) { toast('请先在画布上选择演员（Ctrl/Shift 多选，或右键“全选”）', 'warn'); return; }
  generateDialog(ids, 'face', ['front']);
}

// ---------------- 明星档案 ----------------
async function openProfile(actorId, silent = false) {
  S.currentActor = actorId;
  const drawer = rootEl.querySelector('#ac-drawer');
  if (!drawer) return;
  if (!silent) drawer.classList.add('open');
  drawer.innerHTML = '';
  let data;
  try { data = (await api.get('/api/actors/' + actorId)).actor; }
  catch (e) { toast(e.message, 'err'); return; }
  if (!data) return;

  const meta = C.meta || {};
  const form = {};
  const F = (label, control) => el('label', { class: 'f' }, [el('span', { text: label }), control]);
  const input = (key, label, attrs = {}) => F(label, el('input', { type: 'text', value: data[key] ?? '', oninput: (e) => { form[key] = e.target.value; }, ...attrs }));
  const num = (key, label, attrs = {}) => F(label, el('input', { type: 'number', value: data[key] ?? '', oninput: (e) => { form[key] = e.target.value === '' ? null : Number(e.target.value); }, ...attrs }));
  const sel = (key, label, options, extra = {}) => F(label, select(options, data[key], (v) => { form[key] = v; }, extra));

  const head = el('div', { class: 'drawer-head' }, [
    el('div', { class: 'grow' }, [
      el('div', { style: { fontWeight: 700, fontSize: '15px' } }, [`${data.name}　`, el('span', { class: 'tag accent mono', text: data.id })]),
      el('div', { class: 'small muted', text: `${data.role_type || '演员'} · ${meta.styles?.find((s) => s.id === data.style_id)?.name || data.style_id} · ${data.image_count || (data.images || []).length} 张素材` }),
    ]),
    el('button', { class: 'btn sm', onclick: () => drawer.classList.remove('open') }, ['✕']),
  ]);

  const galleryBox = el('div', { class: 'gallery' });
  const galleryFilter = { kind: 'all' };
  function renderGallery() {
    galleryBox.innerHTML = '';
    const imgs = (data.images || []).filter((i) => galleryFilter.kind === 'all' || i.kind === galleryFilter.kind);
    if (!imgs.length) { galleryBox.append(el('div', { class: 'small muted', text: '暂无素材，右键画布 → 生成。' })); return; }
    for (const im of imgs) {
      const cell = el('div', { class: `g${im.is_primary ? ' sel' : ''}`, title: `${im.kind}/${im.variant} · seed ${im.seed ?? '—'} · ${im.backend || ''}`, onclick: async () => {
        if (!(await confirmDialog('将该图设为该演员的定妆主图（宫格封面 & 参考生图基准）？'))) return;
        try { await api.post(`/api/actors/${actorId}/primary-image`, { imageId: im.id }); toast('已设为主图', 'ok'); openProfile(actorId, true); await loadActors(); draw(); }
        catch (e) { toast(e.message, 'err'); }
      }, oncontextmenu: (e) => {
        e.preventDefault();
        contextMenu(e.clientX, e.clientY, [
          { label: '⭐ 设为主图', onClick: async () => { try { await api.post(`/api/actors/${actorId}/primary-image`, { imageId: im.id }); toast('已设为主图', 'ok'); openProfile(actorId, true); await loadActors(); draw(); } catch (err) { toast(err.message, 'err'); } } },
          { label: '🖼 大图查看', onClick: () => modal({ title: `${im.kind}/${im.variant}`, body: el('img', { src: api.fileUrl(im.file_path), style: { maxWidth: '100%' } }), width: 720 }) },
          { label: '📄 复制提示词', onClick: () => { navigator.clipboard?.writeText(im.prompt_pos || ''); toast('已复制', 'ok'); } },
          { separator: true },
          { label: '🗑 删除该图', onClick: async () => { if (await confirmDialog('删除这张图？')) { try { await api.del('/api/images/' + im.id); openProfile(actorId, true); await loadActors(); draw(); } catch (err) { toast(err.message, 'err'); } } } },
        ]);
      } }, [
        im.status === 'done' && im.file_path ? el('img', { src: api.fileUrl(im.file_path), loading: 'lazy' }) : el('div', { class: 'center', style: { height: '96px', color: 'var(--err)', fontSize: '11px', padding: '6px' } }, [im.error || '失败']),
        im.is_primary ? el('span', { class: 'badge tag ok', text: '主图' }) : null,
        el('div', { class: 'cap' }, [el('span', { text: `${im.kind}/${im.variant}` }), el('span', { text: im.seed != null ? String(im.seed).slice(-4) : '' })]),
      ]);
      galleryBox.append(cell);
    }
  }

  // ---- 生成快捷键 ----
  const quick = el('div', { class: 'pill-group' }, (meta.kinds || []).map((k) => el('div', {
    class: 'pill', title: k.desc, onclick: () => generateDialog([actorId], k.id, k.multi ? k.variants.map((v) => v.id) : ['default']),
  }, [`${k.icon} ${k.label}`])));

  const body = el('div', { class: 'drawer-body' }, [
    el('div', { class: 'sec' }, [
      el('h4', {}, ['⚡ 一键生成']),
      el('div', { class: 'body' }, [
        quick,
        el('div', { class: 'row wrap' }, [
          el('button', { class: 'btn sm primary', onclick: () => generateDialog([actorId], 'full', ['keyart']) }, ['⭐ 生成主人物定妆图']),
          el('button', { class: 'btn sm accent', onclick: () => generateDialog([actorId], 'face', (meta.kinds?.find((k) => k.id === 'face')?.variants || []).map((v) => v.id)) }, ['🙂 脸部多角度全套']),
          el('button', { class: 'btn sm', onclick: () => generateDialog([actorId], 'expression', (meta.kinds?.find((k) => k.id === 'expression')?.variants || []).map((v) => v.id)) }, ['😀 全部 12 表情']),
          el('button', { class: 'btn sm', onclick: () => generateDialog([actorId], 'custom', ['custom']) }, ['✎ 自定义提示词生成']),
        ]),
      ]),
    ]),
    el('div', { class: 'sec' }, [
      el('h4', {}, ['🖼 素材库']),
      el('div', { class: 'body' }, [
        el('div', { class: 'tabs' }, [{ id: 'all', label: '全部' }, ...(meta.kinds || []).map((k) => ({ id: k.id, label: k.label }))].map((t) => el('button', {
          class: galleryFilter.kind === t.id ? 'active' : '', text: t.label,
          onclick: (e) => { galleryFilter.kind = t.id; [...e.target.parentElement.children].forEach((c) => c.classList.remove('active')); e.target.classList.add('active'); renderGallery(); },
        }))),
        galleryBox,
      ]),
    ]),
    el('div', { class: 'sec' }, [
      el('h4', {}, ['🧬 基础档案']),
      el('div', { class: 'body' }, [
        el('div', { class: 'grid2' }, [
          input('name', '姓名'), input('alias', '别名/艺名'),
          sel('gender', '性别', meta.genders || []), num('age', '年龄', { min: 1, max: 200 }),
          sel('race', '种族', meta.races || []), num('height_cm', '身高 (cm)', { min: 50, max: 300 }),
          sel('body_type', '体型', meta.bodyTypes || []), num('weight_kg', '体重 (kg)', { min: 10, max: 400 }),
          sel('role_type', '角色类型', (meta.roleTypes || []).map((r) => ({ id: r, name: r }))),
          sel('skin', '肤色', meta.skinTones || []),
        ]),
      ]),
    ]),
    el('div', { class: 'sec' }, [
      el('h4', {}, ['💇 外形细节']),
      el('div', { class: 'body' }, [
        el('div', { class: 'grid2' }, [sel('hair_style', '发型', meta.hairStyles || []), sel('hair_color', '发色', meta.hairColors || []), sel('eyes', '瞳色', meta.eyeColors || [])]),
        input('hair', '发型补充（英文更佳）'),
        input('face', '五官特征（英文更佳）'),
        input('costume', '服饰（英文标签，如 black trench coat）'),
        input('accessories', '配饰/道具'),
      ]),
    ]),
    el('div', { class: 'sec' }, [
      el('h4', {}, ['🎭 人设']),
      el('div', { class: 'body' }, [
        el('label', { class: 'f' }, ['性格', el('textarea', { rows: 2, oninput: (e) => { form.personality = e.target.value; } }, [data.personality || ''])]),
        el('label', { class: 'f' }, ['背景故事', el('textarea', { rows: 4, oninput: (e) => { form.background = e.target.value; } }, [data.background || ''])]),
        input('voice', '音色/配音建议'), input('tags', '标签（逗号分隔）'),
        el('div', { class: 'row wrap' }, [
          el('button', { class: 'btn sm', onclick: () => describeActor(actorId, true) }, ['🧠 AI 补全人物描述']),
          el('button', { class: 'btn sm', onclick: () => optimizePrompt(actorId, true) }, ['🎨 一键优化提示词']),
        ]),
      ]),
    ]),
    el('div', { class: 'sec' }, [
      el('h4', {}, ['🎨 画风与出图参数']),
      el('div', { class: 'body' }, [
        el('div', { class: 'grid2' }, [
          sel('style_id', '画风风格（10 选 1）', (meta.styles || []).map((s) => ({ id: s.id, name: s.name }))),
          sel('ratio', '画面比例', (meta.ratios || []).map((r) => ({ id: r.id, name: r.name }))),
          num('width', '宽 (px)'), num('height', '高 (px)'),
          num('seed', '默认 seed'), num('cfg', '默认 CFG', { step: 0.1 }),
          num('steps', '默认步数'), input('sampler', '采样器'),
        ]),
        input('ext_prompt', '附加锚点词（受保护片段，如专属 LoRA 触发词）'),
        el('div', { class: 'row wrap' }, [
          el('button', { class: 'btn sm', onclick: () => uploadRefImage(actorId) }, ['📎 上传参考图（参考生图用）']),
          el('button', { class: 'btn sm', onclick: () => { form.seed = Math.floor(Math.random() * 4294967295); toast('下次保存将写入随机 seed', 'info'); } }, ['🎲 随机 seed']),
        ]),
        data.ref_image ? el('img', { src: api.fileUrl(data.ref_image), style: { maxWidth: '100%', borderRadius: '8px', border: '1px solid var(--line)' } }) : null,
      ]),
    ]),
    el('div', { class: 'sec' }, [
      el('h4', {}, ['📝 提示词（英文，可编辑）']),
      el('div', { class: 'body' }, [
        el('label', { class: 'f' }, ['正向提示词 POSITIVE', el('textarea', { rows: 6, style: { fontFamily: 'var(--mono)', fontSize: '11.5px' }, oninput: (e) => { form.prompt_pos = e.target.value; } }, [data.prompt_pos || ''])]),
        el('label', { class: 'f' }, ['负向提示词 NEGATIVE', el('textarea', { rows: 4, style: { fontFamily: 'var(--mono)', fontSize: '11.5px' }, oninput: (e) => { form.prompt_neg = e.target.value; } }, [data.prompt_neg || ''])]),
        el('div', { class: 'row wrap' }, [
          el('button', { class: 'btn sm', onclick: async () => {
            try { const r = await api.post(`/api/actors/${actorId}/prompt`, { kind: 'full', variant: 'keyart' }); await navigator.clipboard?.writeText(r.positive); toast('已复制引擎拼装的正向词', 'ok'); } catch (e) { toast(e.message, 'err'); }
          } }, ['📄 复制引擎拼装词']),
          el('button', { class: 'btn sm', onclick: async () => {
            try { const r = await api.post(`/api/actors/${actorId}/prompt`, { kind: 'full', variant: 'keyart' });
              const ta = document.querySelectorAll('#ac-drawer textarea'); form.prompt_pos = r.positive; form.prompt_neg = r.negative;
              ta[ta.length - 2].value = r.positive; ta[ta.length - 1].value = r.negative; toast('已用引擎结果覆盖编辑框（记得保存）', 'ok');
            } catch (e) { toast(e.message, 'err'); }
          } }, ['⟳ 用引擎结果填充']),
        ]),
        el('div', { class: 'kv' }, [
          el('div', { class: 'k' }, ['英文锚点']), el('div', { class: 'mono small', text: data.subject_en || '—' }),
          el('div', { class: 'k' }, ['中文描述']), el('div', { class: 'small', text: data.subject_zh || '—' }),
        ]),
      ]),
    ]),
    el('div', { class: 'sec' }, [
      el('h4', {}, ['ℹ️ 记录']),
      el('div', { class: 'body' }, [
        el('div', { class: 'kv' }, [
          el('div', { class: 'k' }, ['创建时间']), el('div', { text: fmtDate(data.created_at) }),
          el('div', { class: 'k' }, ['更新时间']), el('div', { text: fmtDate(data.updated_at) }),
          el('div', { class: 'k' }, ['素材数']), el('div', { text: fmtNum((data.images || []).length) }),
        ]),
      ]),
    ]),
  ]);

  const foot = el('div', { class: 'row', style: { padding: '11px 14px', borderTop: '1px solid var(--line)', gap: '8px' } }, [
    el('button', { class: 'btn primary', onclick: async () => {
      try { await api.put('/api/actors/' + actorId, form); toast('档案已保存', 'ok'); await loadActors(); renderList(); draw(); openProfile(actorId, true); }
      catch (e) { toast('保存失败：' + e.message, 'err'); }
    } }, ['💾 保存档案']),
    el('button', { class: 'btn', onclick: () => generateDialog([actorId], 'full', ['keyart']) }, ['🚀 开始生成主图']),
    el('div', { class: 'grow' }),
    el('button', { class: 'btn danger sm', onclick: async () => { if (await confirmDialog('删除该演员？')) { await api.del('/api/actors/' + actorId); drawer.classList.remove('open'); await loadAll(); } } }, ['删除']),
  ]);

  drawer.append(head, body, foot);
  renderGallery();
}

async function uploadRefImage(actorId) {
  const inp = el('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
  document.body.append(inp);
  inp.onchange = async () => {
    const f = inp.files?.[0];
    inp.remove();
    if (!f) return;
    try {
      const fd = new FormData();
      fd.append('image', f, f.name);
      const res = await fetch(`/api/actors/${actorId}/ref-image`, { method: 'POST', body: fd });
      const j = await res.json();
      if (!j.ok) throw new Error(j.error || '上传失败');
      toast('参考图已上传，可在生成时勾选「参考生图」', 'ok');
      openProfile(actorId, true);
    } catch (e) { toast('上传失败：' + e.message, 'err'); }
  };
  inp.click();
}

async function optimizePrompt(actorId, refresh = false) {
  toast('正在调用 LLM 优化提示词…', 'info');
  try {
    const r = await api.post(`/api/actors/${actorId}/optimize`, { kind: 'full', variant: 'keyart' });
    if (r.ok) { toast('提示词已优化并写回档案', 'ok'); await loadActors(); if (refresh) openProfile(actorId, true); }
    else toast(r.error || '优化失败', 'err');
  } catch (e) { toast('优化失败：' + e.message, 'err'); }
}

async function describeActor(actorId, refresh = false) {
  toast('正在让 AI 补全人物描述…', 'info');
  try {
    const r = await api.post(`/api/actors/${actorId}/describe`, {});
    toast('人物描述已补全（性格/背景/服饰/五官）', 'ok');
    await loadActors(); renderList(); draw();
    if (refresh) openProfile(actorId, true);
  } catch (e) { toast('补全失败：' + e.message, 'err'); }
}

// ---------------- 新建 / 编辑 ----------------
function openActorEditor(actorId, opts = {}) {
  const meta = C.meta || {};
  const actor = actorId ? S.actors.find((a) => a.id === actorId) : null;
  const form = actor ? { ...actor } : { style_id: meta.styles?.[0]?.id || 'jp-anime', ratio: '2:3', gender: 'female', race: 'asian-east', body_type: 'slim', skin: 'fair', hair_style: 'long-straight', hair_color: 'black', eyes: 'black', role_type: '主角' };
  const F = (label, control) => el('label', { class: 'f' }, [el('span', { text: label }), control]);
  const txt = (k, label, ph = '') => F(label, el('input', { type: 'text', value: form[k] ?? '', placeholder: ph, oninput: (e) => { form[k] = e.target.value; } }));
  const numF = (k, label) => F(label, el('input', { type: 'number', value: form[k] ?? '', oninput: (e) => { form[k] = e.target.value === '' ? null : Number(e.target.value); } }));
  const selF = (k, label, opts) => F(label, select(opts, form[k], (v) => { form[k] = v; }));

  const body = el('div', { class: 'col', style: { gap: '12px' } }, [
    el('div', { class: 'grid2' }, [txt('name', '姓名 *'), txt('alias', '别名/艺名')]),
    el('div', { class: 'grid3' }, [
      selF('gender', '性别', meta.genders || []), numF('age', '年龄'), selF('race', '种族', meta.races || []),
      selF('body_type', '体型', meta.bodyTypes || []), numF('height_cm', '身高 cm'), selF('skin', '肤色', meta.skinTones || []),
      selF('hair_style', '发型', meta.hairStyles || []), selF('hair_color', '发色', meta.hairColors || []), selF('eyes', '瞳色', meta.eyeColors || []),
    ]),
    txt('costume', '服饰（英文标签最佳）', 'e.g. black trench coat, leather gloves'),
    el('div', { class: 'grid3' }, [
      selF('style_id', '画风风格', (meta.styles || []).map((s) => ({ id: s.id, name: s.name }))),
      selF('ratio', '比例尺寸', (meta.ratios || []).map((r) => ({ id: r.id, name: r.name }))),
      selF('role_type', '角色类型', (meta.roleTypes || []).map((r) => ({ id: r, name: r }))),
    ]),
    F('性格 / 背景（可留空，稍后用 AI 补全）', el('textarea', { rows: 3, oninput: (e) => { form.personality = e.target.value; } }, [form.personality || ''])),
    el('label', { class: 'row' }, [
      el('input', { type: 'checkbox', style: { width: 'auto' }, checked: true, onchange: (e) => { form._genAfter = e.target.checked; } }),
      el('span', { text: '创建后立即生成一张全身定妆主图' }),
    ]),
    actor ? el('div', { class: 'small muted', text: `ID：${actor.id}（ID 创建后固定不变，供小说/剧本模块引用）` }) : el('div', { class: 'small muted', text: 'ID 将由系统自动分配（C-0001、C-0002…），用于小说与剧本模块的角色引用。' }),
  ]);

  const m = modal({
    title: actor ? `✏️ 编辑演员 · ${actor.id}` : '➕ 新建演员',
    body, width: 720,
    footer: [
      el('button', { class: 'btn', onclick: () => m.close() }, ['取消']),
      el('button', { class: 'btn primary', onclick: async () => {
        if (!form.name) { toast('请填写姓名', 'warn'); return; }
        try {
          const genAfter = form._genAfter !== false;
          delete form._genAfter;
          let id = actor?.id;
          if (actor) await api.put('/api/actors/' + id, form);
          else { const r = await api.post('/api/actors', form); id = r.actor.id; }
          m.close();
          if (!actor && opts.placeAt) {
            // 无限画布：把新演员的卡位放在双击/右键的位置
            try {
              await api.post('/api/canvas/node', {
                canvas_id: S.canvasId, actor_id: id,
                x: opts.placeAt.x, y: opts.placeAt.y, w: S.cell, h: S.cell, z: (S.actors.length || 0) + 1,
              });
              S.mode = 'free';
              updateModeButton();
            } catch (e) { toast('卡位放置失败：' + e.message, 'err'); }
          }
          await loadAll();
          toast(actor ? '档案已更新' : `已创建 ${id}`, 'ok');
          if (!actor && genAfter) { S.selection = new Set([id]); generateDialog([id], 'full', ['keyart']); }
          else openProfile(id);
        } catch (e) { toast('保存失败：' + e.message, 'err'); }
      } }, [actor ? '💾 保存' : '✨ 创建']),
    ],
  });
}

// ============================ 画布类型筛选与多选批处理（T-402 ②） ============================
// 口径：判定、中文文案、危险动作确认闸门、主画布保护**全部**由 web/lib/canvas-select.js 的纯函数给出，
// 本视图只做两件事：① 把纯函数返回的 chips/摘要渲染出来；② 严格按纯数据里的 effects 顺序发请求。
// 因此界面与测试断言同源：同一份 items + 同一份 spec → 同样的结论，不存在「界面另写一套判定」。

/** 当前画布上**可见**的 layout item（I4：调用方只传可见项；筛选/批处理都以此为准） */
function visibleItems() {
  const L = S._layout || computeLayout();
  S._layout = L;
  return L.items || [];
}

/** 当前生效的筛选规格（默认「不限」，与既有行为零差异） */
function nodeFilterSpec() { return normalizeNodeFilter(S?.kindFilter || {}); }

/**
 * 生效中的筛选维度名（HUD 提示、__acDebug().filter.dims 与「是否已启用筛选」判定同源）。
 * 维度名取自 canvas-select 的 NODE_FILTER_DIMS（界面文案唯一来源），空数组 = 不限。
 */
function activeFilterDims(spec = nodeFilterSpec()) {
  const s = normalizeNodeFilter(spec);
  const dims = [];
  if (s.kinds.length) dims.push('kinds');
  if (s.groups.length) dims.push('groups');
  for (const d of ['hasArtifact', 'failed', 'locked']) if (s[d] !== 'any') dims.push(d);
  if (s.negate) dims.push('negate');
  return dims;
}

/** 五维筛选控件：类型多选 + 分组/有产物/失败/锁定三态 + 反选 */
function nodeFilterEditor(spec, onChange) {
  const draft = { ...normalizeNodeFilter(spec) };
  const box = el('div', {});
  const refresh = () => onChange(draft);

  const kindRow = el('div', { class: 'pill-group', style: { marginTop: '4px' } });
  // 类型清单直接取本视图的 NODE_KINDS（端口表）：界面不会漏掉任何本视图能渲染的类型
  for (const k of Object.keys(NODE_KINDS)) {
    const on = draft.kinds.includes(k);
    kindRow.append(el('span', {
      class: `pill${on ? ' on' : ''}`, text: KIND_LABELS[k] || k,
      title: `类型 ${k}（点击切换）`,
      onclick: (ev) => {
        const hit = draft.kinds.includes(k);
        draft.kinds = hit ? draft.kinds.filter((x) => x !== k) : [...draft.kinds, k];
        ev.target.classList.toggle('on', !hit);
        refresh();
      },
    }));
  }

  const triRow = el('div', { class: 'row', style: { gap: '10px', flexWrap: 'wrap', marginTop: '8px' } });
  for (const [dim, label] of [['hasArtifact', '有产物'], ['failed', '失败'], ['locked', '锁定']]) {
    triRow.append(labeled(label, select(
      TRIPLE_STATES.map((v) => ({ id: v, name: v === 'any' ? '不限' : (v === 'yes' ? '是' : '否') })),
      draft[dim], (v) => { draft[dim] = v; refresh(); },
    )));
  }
  const negate = el('input', {
    type: 'checkbox', checked: draft.negate === true,
    onchange: (e) => { draft.negate = e.target.checked; refresh(); },
  });
  triRow.append(el('label', { class: 'ac-check', title: '五维判定后整体取反（不是逐维取反）' }, [negate, el('span', { text: '反选' })]));

  box.append(
    el('div', { class: 'small muted' }, ['按类型（可多选）']),
    kindRow,
    triRow,
  );
  return { node: box, get: () => normalizeNodeFilter(draft) };
}

/** 把命中项框入视口（筛选后直接看到结果；只改视口，不动任何数据）—— 与 zoomToSelection 同一套口径 */
function fitItemsInView(items) {
  const cv = canvasEl();
  if (!cv || !items.length) return;
  const pad = 60;
  const x1 = Math.min(...items.map((i) => i.x)); const y1 = Math.min(...items.map((i) => i.y));
  const x2 = Math.max(...items.map((i) => i.x + (i.w || S.cell))); const y2 = Math.max(...items.map((i) => i.y + (i.h || S.cell)));
  S.zoom = clampZoom(Math.min((cv.clientWidth - pad * 2) / Math.max(1, x2 - x1), (cv.clientHeight - pad * 2) / Math.max(1, y2 - y1)));
  S.panX = -(x1 - pad / S.zoom);
  S.panY = -(y1 - pad / S.zoom);
  scheduleViewSave(); draw();
}

/** 「🔎 类型筛选」：五维筛选 → 命中项一键选中（纯逻辑出结论，视图只落地选择与视口） */
function kindFilterDialog() {
  const items = visibleItems();
  const spec0 = nodeFilterSpec();
  const preview = el('div', { class: 'small', style: { marginTop: '8px', fontWeight: '600' } });
  const chipsBox = el('div', { class: 'pill-group', style: { marginTop: '6px' } });
  let spec = spec0;

  const refresh = () => {
    const matched = filterItems(items, spec);
    preview.textContent = describeNodeFilter(spec, items.length, matched.length);
    const chips = nodeFilterChips(spec, items);
    chipsBox.innerHTML = '';
    if (!chips.length) chipsBox.append(el('span', { class: 'small muted' }, ['当前不限（画布全部节点都在范围内）']));
    for (const c of chips) {
      chipsBox.append(el('span', { class: 'pill on', title: '该维度的命中数', text: `${c.label}（${c.count}）` }));
    }
  };

  const editor = nodeFilterEditor(spec0, (next) => { spec = next; refresh(); });
  const body = el('div', {}, [
    el('div', { class: 'small muted' }, [
      '筛选只影响「选中范围」与视口，不会删除或改动任何节点；「多选批处理」会沿用这里的筛选结果。',
    ]),
    editor.node,
    preview,
    chipsBox,
  ]);

  const m = modal({
    title: '🔎 类型筛选', body, width: 660,
    footer: [
      el('button', { class: 'btn primary', onclick: () => {
        const matched = filterItems(items, spec);
        S.kindFilter = spec;
        S.selection = new Set(matched.filter((it) => it.actor?.id).map((it) => it.actor.id));
        S.selectedOrder = [...S.selection];
        updateCount(); renderList(); fitItemsInView(matched);
        draw();                    // 命中 0 项时 fitItemsInView 会提前返回：这里补一次重绘，让 HUD 立刻显示筛选态
        saveFilterPref();          // T-L3 ②：筛选偏好写进本画布的视图偏好（刷新后仍生效）
        toast(matched.length ? `已按筛选选中 ${matched.length} 个节点：${describeNodeFilter(spec, items.length, matched.length)}` : '当前筛选没有匹配的节点（试试「清除筛选」）', matched.length ? 'ok' : 'warn', 3200);
        m.close();
      } }, ['✓ 应用并选中匹配项']),
      el('button', { class: 'btn', onclick: () => {
        S.kindFilter = normalizeNodeFilter({});
        updateCount(); renderList(); draw();
        saveFilterPref();          // T-L3 ②：清除也要落库，否则刷新后又被恢复
        toast('已清除节点筛选（全部节点回到范围内）', 'ok');
        m.close();
      } }, ['⌀ 清除筛选']),
      el('button', { class: 'btn', onclick: () => m.close() }, ['关闭']),
    ],
  });
  refresh();
}

/** 严格按纯数据的 effects 顺序发请求（canvas-select 只描述，不自己发请求） */
async function replayEffects(effects = []) {
  const out = { sent: 0, failed: [] };
  for (const e of effects) {
    if (!e?.path) continue;
    try {
      await api.raw(e.method || 'POST', e.path, e.body);
      out.sent += 1;
    } catch (err) {
      out.failed.push(`${e.method || 'POST'} ${e.path}：${err.message}`);
    }
  }
  return out;
}

/** 危险动作前自动留档（纯数据里的 before.autoSnapshot 为 true 时调用；失败不阻断但要说清） */
async function autoSnapshotBefore(label) {
  try {
    await api.post('/api/canvas/snapshots', { canvas_id: S.canvasId, name: `批处理前 · ${label}`, note: '多选批处理自动留档（可回滚）' });
    return true;
  } catch (e) { toast('自动快照失败（不影响本次操作）：' + e.message, 'warn', 4000); return false; }
}

/** 「⇄ 多选批处理」：对当前选区（或筛选命中项）批量执行，危险动作二次确认 */
function batchSelectDialog() {
  const items = visibleItems();
  const spec = nodeFilterSpec();
  const filtered = filterItems(items, spec);
  const selected = filtered.filter((it) => S.selection.has(it.actor?.id) || (it.actorId && S.selection.has(it.actorId)));

  // 视图状态只放「界面选择」，判定一律交给 planBatch
  const ui = { scope: selected.length ? 'selection' : 'filtered', action: 'move' };
  const includeLocked = el('input', { type: 'checkbox', title: '勾选后已锁定的节点也会一起处理' });
  const dxIn = el('input', { type: 'number', value: 0, step: 10, style: { width: '78px' } });
  const dyIn = el('input', { type: 'number', value: 0, step: 10, style: { width: '78px' } });
  const scaleIn = el('input', { type: 'number', value: 1, step: 0.1, min: 0.2, max: 3, style: { width: '78px' } });
  const nameIn = el('input', { type: 'text', placeholder: '新分组名（留空=自动命名）', style: { width: '190px' } });
  for (const ctl of [dxIn, dyIn, scaleIn, nameIn]) ctl.addEventListener('input', () => refresh());
  includeLocked.addEventListener('change', () => refresh());

  const head = el('div', {});
  const paramBox = el('div', { class: 'row', style: { gap: '8px', marginTop: '6px', flexWrap: 'wrap' } });
  const previewBox = el('div', { class: 'small', style: { marginTop: '10px', whiteSpace: 'pre-wrap' } });
  const guardBox = el('div', { class: 'small', style: { marginTop: '8px', color: 'var(--warn)', whiteSpace: 'pre-wrap' } });
  const runBtn = el('button', { class: 'btn primary' }, ['▶ 执行批处理']);
  const body = el('div', {}, [head, paramBox, previewBox, guardBox]);
  const m = modal({ title: '⇄ 多选批处理', body, width: 700, footer: [runBtn, el('button', { class: 'btn', onclick: () => m.close() }, ['关闭'])] });

  /** 当前作用范围（选区 / 筛选命中项） */
  const baseOf = () => (ui.scope === 'filtered' ? filtered : selected);

  /** 生成计划（纯函数：预览、确认闸门、中文文案全部来自 canvas-select） */
  const planOf = () => {
    const base = baseOf();
    const action = ui.action;
    const params = action === 'move' ? { dx: Number(dxIn.value) || 0, dy: Number(dyIn.value) || 0 }
      : action === 'resize' ? { scale: Number(scaleIn.value) || 1 }
        : action === 'group' ? { name: nameIn.value }
          : {};
    return {
      base,
      plan: planBatch(action, base, params, {
        canvasId: S.canvasId,
        canvasName: S.canvases?.find((c) => c.id === S.canvasId)?.name || '',
        mode: S.mode, includeLocked: includeLocked.checked, canvasTotal: items.length,
      }),
    };
  };

  function refresh() {
    head.innerHTML = '';
    head.append(
      el('div', { class: 'small muted' }, [
        `处理范围：选区 ${selected.length} 项 · 筛选命中 ${filtered.length} 项（${describeNodeFilter(spec, items.length, filtered.length)}）`,
      ]),
      el('div', { class: 'row', style: { gap: '8px', marginTop: '6px', flexWrap: 'wrap' } }, [
        labeled('取哪些节点', select([
          { id: 'selection', name: `画布选区（${selected.length}）` },
          { id: 'filtered', name: `筛选命中项（${filtered.length}）` },
        ], ui.scope, (v) => { ui.scope = v; refresh(); })),
        labeled('动作', select(SUPPORTED_ACTIONS.map((id) => ({
          id,
          name: `${BATCH_ACTIONS[id]?.label || id}${BATCH_ACTIONS[id]?.paid ? '（付费）' : ''}${BATCH_ACTIONS[id]?.requiresConfirm ? '（危险：需确认）' : ''}`,
        })), ui.action, (v) => { ui.action = v; refresh(); })),
        el('label', { class: 'ac-check' }, [includeLocked, el('span', { text: '包含已锁定' })]),
      ]),
    );
    paramBox.innerHTML = '';
    if (ui.action === 'move') paramBox.append(labeled('水平 dx', dxIn), labeled('垂直 dy', dyIn));
    if (ui.action === 'resize') paramBox.append(labeled('缩放比例', scaleIn));
    if (ui.action === 'group') paramBox.append(labeled('分组名', nameIn));

    const { base, plan } = planOf();
    runBtn.disabled = !plan.ok;
    runBtn.onclick = () => runBatchPlan(planOf, m);
    const lines = [describeBatchPlan(plan), plan.reason || '', ...(plan.messages || []), ...(plan.notices || []), plan.warning || ''].filter(Boolean);
    previewBox.textContent = lines.join('\n');
    previewBox.style.color = plan.ok ? 'var(--text)' : 'var(--warn)';
    guardBox.textContent = [
      plan.requiresConfirm ? `⚠️ 危险动作（危险等级 ${plan.danger || '-'}）：执行前会再确认${plan.confirmMode === 'double' ? '两次' : '一次'}` : '',
      plan.requiresApproval ? '⏳ 付费动作：本面板只生成执行计划，放行必须人工批准 + 终端确认码（程序不会自动开跑）' : '',
      plan.mainCanvas && !plan.ok ? '🛡 主画布保护：它是「宫格预览全部演员」的入口画布，批量删除「全部」会被拒绝' : '',
      isMainCanvas(S.canvasId) ? '当前画布：主画布（CV-MAIN）——保护闸门生效' : '',
      !base.length ? '没有可处理的节点：先在画布上框选，或到「🔎 类型筛选」缩小范围。' : '',
    ].filter(Boolean).join('\n');
  }
  refresh();
}

/**
 * 批处理执行：危险动作二次确认 → 按 effects 顺序发请求 → 刷新画布。
 * `makePlan` 在点击那一刻重新生成计划，保证「计划与当前选区/筛选同源」（applyBatchPlan 会用 itemCount 复核，
 * 筛选或画布变了就报 STALE_PLAN 而不是拿旧计划落地）。
 */
async function runBatchPlan(makePlan, m) {
  const { base, plan } = makePlan();
  if (!plan?.ok) { toast(plan?.reason || '批处理计划未通过前置校验，未执行任何动作', 'warn', 4000); return; }
  // ① 危险动作二次确认（确认文案由 canvas-select 给出，保证界面与测试断言同源）
  let confirm = false; let confirmAgain = false;
  if (plan.requiresConfirm) {
    const stages = (plan.confirmStages?.length ? plan.confirmStages : [plan.confirmText || `确认执行「${plan.label}」？`]);
    for (let i = 0; i < stages.length; i += 1) {
      if (!(await confirmDialog(stages[i]))) { toast('已取消：没有改动任何节点', 'info'); return; }
      if (i === 0) confirm = true; else confirmAgain = true;
    }
    if (stages.length >= 2) confirm = 2;
  }
  const out = applyBatchPlan(plan, { items: base, confirm, confirmAgain, includeLocked: plan.includeLocked === true });
  if (!out.ok) { toast(out.reason || '批处理未执行', 'warn', 4500); return; }
  try {
    // ② 破坏性动作先留档（纯数据里的 before.undo / before.autoSnapshot 说了算）
    if (out.before.undo) pushUndo();
    if (out.before.autoSnapshot) await autoSnapshotBefore(out.before.snapshotLabel || out.label);
    const sent = await replayEffects(out.effects);
    if (sent.failed.length) toast(`部分步骤失败：${sent.failed.slice(0, 2).join('；')}`, 'err', 6000);
    if (out.action === 'rerun-kinds') {
      // 付费重跑：这里只生成了执行计划（零成本），**绝不**自动放行 ——
      // 人工批准 + 终端确认码仍然在「🧭 执行计划」里走（不得调用 /api/canvas/run 等绕过闸门的入口）
      modal({
        title: '⏳ 按类型重跑：已生成执行计划，等待人工批准',
        width: 640,
        body: el('div', { class: 'small', style: { whiteSpace: 'pre-wrap' } }, [
          `${(out.messages || []).join('\n')}\n\n后续必须由人工完成（程序不会自动放行）：\n${(out.approvalChain || []).map((x, i) => `${i + 1}. ${x}`).join('\n')}\n\n下一步：点工具栏「🧭 执行计划」核对要跑哪些节点与花费，批准后在终端取确认码执行。`,
        ].join('')),
      });
    }
    await loadCanvas();
    updateCount(); renderList(); draw();
    const msgs = [...(out.messages || []), ...(out.notices || [])];
    toast(msgs[0] || `${out.label}已完成（${out.affected} 项）`, out.changed ? 'ok' : 'info', 3600);
    if (out.warning) toast(out.warning, 'warn', 6000);
    if (out.affected && m) m.close();
  } catch (e) {
    toast('批处理失败：' + e.message, 'err', 5000);
  }
}

export default { mount, unmount };
