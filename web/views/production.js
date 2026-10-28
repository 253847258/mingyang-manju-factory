// 生产看板：多项目 / 多集进度、阻塞、成本与订单摘要。
// 约定：只使用 ctx.api / ctx.toast / ctx.confirm / ctx.modal；所有自有类名使用 prod- 前缀。
import { el, injectStyle, fmtDate } from '../lib/ui.js';

const STYLE_ID = 'prod-dashboard-view';

const CSS = `
.prod-page{height:100%;min-height:0;display:flex;flex-direction:column;gap:14px;padding:14px 16px;color:var(--text,#e8e8ef);position:relative}
.prod-page *{box-sizing:border-box}
.prod-head{display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap}
.prod-head-main{min-width:220px}
.prod-title{margin:0;font-size:19px;font-weight:750;letter-spacing:.01em}
.prod-subtitle{margin-top:4px;font-size:12px;line-height:1.6;color:var(--muted,#8b8b9c)}
.prod-head-actions{margin-left:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.prod-btn{appearance:none;background:var(--panel-2,#1e1e28);color:var(--text,#e8e8ef);border:1px solid var(--line,#2a2a36);border-radius:8px;padding:7px 12px;cursor:pointer;font:inherit;font-size:12px;line-height:1.4;display:inline-flex;align-items:center;justify-content:center;gap:6px;white-space:nowrap}
.prod-btn:hover:not(:disabled){border-color:var(--accent,#6c8cff);background:rgba(108,140,255,.08)}
.prod-btn:focus-visible{outline:2px solid var(--accent,#6c8cff);outline-offset:2px}
.prod-btn:disabled{opacity:.45;cursor:not-allowed}
.prod-btn-primary{background:var(--accent,#6c8cff);border-color:var(--accent,#6c8cff);color:#0b0b12;font-weight:700}
.prod-btn-primary:hover:not(:disabled){background:#7f9aff;border-color:#7f9aff}
.prod-btn-ghost{background:transparent}
.prod-count{display:inline-flex;align-items:center;gap:5px;padding:5px 9px;border:1px solid var(--line,#2a2a36);border-radius:999px;background:rgba(255,255,255,.025);font-size:11.5px;color:var(--muted,#8b8b9c)}
.prod-count b{color:var(--text,#e8e8ef);font-size:12px}
.prod-layout{flex:1;min-height:0;display:grid;grid-template-columns:minmax(310px,390px) minmax(0,1fr);gap:14px}
.prod-panel{min-height:0;background:var(--panel,#16161d);border:1px solid var(--line,#2a2a36);border-radius:12px;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 12px 28px rgba(0,0,0,.12)}
.prod-panel-head{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--line,#2a2a36);background:linear-gradient(180deg,rgba(108,140,255,.07),transparent)}
.prod-panel-title{font-size:13px;font-weight:700}
.prod-panel-hint{margin-left:auto;font-size:11px;color:var(--muted,#8b8b9c)}
.prod-order-list{display:flex;flex-direction:column;gap:7px;padding:10px;overflow:auto;min-height:0}
.prod-order{appearance:none;width:100%;border:1px solid var(--line,#2a2a36);background:var(--panel-2,#1e1e28);color:var(--text,#e8e8ef);border-radius:9px;padding:10px;text-align:left;font:inherit;cursor:pointer;transition:border-color .16s,background .16s,transform .16s}
.prod-order:hover{border-color:rgba(108,140,255,.7);background:rgba(108,140,255,.07);transform:translateY(-1px)}
.prod-order:focus-visible{outline:2px solid var(--accent,#6c8cff);outline-offset:1px}
.prod-order-active{border-color:var(--accent,#6c8cff);background:rgba(108,140,255,.12);box-shadow:inset 3px 0 0 var(--accent,#6c8cff)}
.prod-order-top{display:flex;align-items:flex-start;gap:8px}
.prod-order-name{font-size:12.5px;font-weight:700;line-height:1.45;min-width:0;overflow-wrap:anywhere;flex:1}
.prod-order-id{margin-top:3px;font-family:var(--mono,ui-monospace,monospace);font-size:10px;color:var(--muted,#8b8b9c);overflow-wrap:anywhere}
.prod-order-meta{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;margin-top:9px}
.prod-order-meta-item{padding-top:7px;border-top:1px dashed rgba(255,255,255,.07);min-width:0}
.prod-order-meta-label{display:block;font-size:9.5px;color:var(--muted,#8b8b9c);margin-bottom:2px}
.prod-order-meta-value{display:block;font-size:11.5px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.prod-badge{display:inline-flex;align-items:center;gap:4px;padding:2px 7px;border-radius:999px;border:1px solid var(--line,#2a2a36);font-size:10.5px;line-height:1.5;white-space:nowrap;color:var(--muted,#8b8b9c);background:rgba(255,255,255,.025)}
.prod-badge::before{content:'';width:5px;height:5px;border-radius:50%;background:currentColor;opacity:.9}
.prod-badge-ok{color:var(--ok,#48d1a0);border-color:rgba(72,209,160,.35);background:rgba(72,209,160,.08)}
.prod-badge-warn{color:var(--warn,#f0b060);border-color:rgba(240,176,96,.36);background:rgba(240,176,96,.08)}
.prod-badge-err{color:var(--err,#f06060);border-color:rgba(240,96,96,.38);background:rgba(240,96,96,.08)}
.prod-badge-info{color:var(--accent,#6c8cff);border-color:rgba(108,140,255,.4);background:rgba(108,140,255,.08)}
.prod-summary-body{min-height:0;overflow:auto;padding:14px}
.prod-summary-head{display:flex;align-items:flex-start;gap:12px;padding-bottom:13px;border-bottom:1px solid var(--line,#2a2a36)}
.prod-summary-heading{min-width:0;flex:1}
.prod-summary-title{margin:0;font-size:16px;line-height:1.45;font-weight:750;overflow-wrap:anywhere}
.prod-summary-meta{display:flex;gap:8px 14px;flex-wrap:wrap;margin-top:6px;font-size:11px;color:var(--muted,#8b8b9c)}
.prod-summary-meta code{font-family:var(--mono,ui-monospace,monospace);color:var(--accent-3,#8ad8ff);font-size:10.5px;overflow-wrap:anywhere}
.prod-summary-tools{display:flex;align-items:center;gap:7px;flex-wrap:wrap;justify-content:flex-end}
.prod-metrics{display:grid;grid-template-columns:repeat(3,minmax(130px,1fr));gap:9px;margin-top:13px}
.prod-metric{min-width:0;padding:11px 12px;border:1px solid var(--line,#2a2a36);border-radius:9px;background:linear-gradient(160deg,rgba(255,255,255,.035),rgba(255,255,255,.012))}
.prod-metric-label{font-size:10.5px;color:var(--muted,#8b8b9c)}
.prod-metric-value{display:block;margin-top:5px;font-size:20px;line-height:1.2;font-weight:750;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.prod-metric-value-prod-small{font-size:15px}
.prod-metric-note{margin-top:4px;font-size:10px;line-height:1.45;color:var(--muted,#8b8b9c)}
.prod-metric-err{color:var(--err,#f06060)}
.prod-metric-warn{color:var(--warn,#f0b060)}
.prod-rate{margin-top:13px;padding:12px;border:1px solid var(--line,#2a2a36);border-radius:9px;background:var(--panel-2,#1e1e28)}
.prod-rate-head{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:11.5px;color:var(--muted,#8b8b9c)}
.prod-rate-head b{color:var(--text,#e8e8ef);font-size:13px}
.prod-rate-track{height:8px;margin-top:9px;border-radius:999px;background:rgba(255,255,255,.07);overflow:hidden}
.prod-rate-fill{height:100%;border-radius:inherit;background:linear-gradient(90deg,var(--accent,#6c8cff),var(--accent-2,#48d1a0));transition:width .28s ease}
.prod-blocked{margin-top:13px;padding:12px;border:1px solid var(--line,#2a2a36);border-radius:9px;background:rgba(240,96,96,.035)}
.prod-section-title{display:flex;align-items:center;gap:7px;font-size:11.5px;font-weight:700}
.prod-blocked-list{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.prod-code{display:inline-flex;padding:3px 7px;border-radius:6px;border:1px solid rgba(240,96,96,.35);background:rgba(240,96,96,.08);color:#ffb3b3;font-family:var(--mono,ui-monospace,monospace);font-size:10.5px}
.prod-blocked-empty{margin-top:7px;font-size:11px;color:var(--muted,#8b8b9c)}
.prod-note{margin-top:12px;padding:9px 10px;border-radius:8px;font-size:11px;line-height:1.55;border:1px solid rgba(240,176,96,.35);background:rgba(240,176,96,.07);color:#f5cf91}
.prod-loading{display:flex;align-items:center;justify-content:center;gap:10px;min-height:180px;padding:24px;color:var(--muted,#8b8b9c);font-size:12px;text-align:center}
.prod-spinner{width:24px;height:24px;border-radius:50%;border:2px solid rgba(255,255,255,.14);border-top-color:var(--accent,#6c8cff);animation:prod-spin .75s linear infinite;flex:0 0 auto}
@keyframes prod-spin{to{transform:rotate(360deg)}}
.prod-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:240px;padding:30px 22px;text-align:center;color:var(--muted,#8b8b9c)}
.prod-empty-icon{font-size:31px;line-height:1;margin-bottom:10px;opacity:.9}
.prod-empty-title{font-size:13px;font-weight:700;color:var(--text,#e8e8ef)}
.prod-empty-text{max-width:360px;margin:6px 0 14px;font-size:11.5px;line-height:1.7}
.prod-error-state{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:240px;padding:30px 22px;text-align:center}
.prod-error-title{font-size:13px;font-weight:700;color:var(--err,#f06060)}
.prod-error-text{max-width:460px;margin:7px 0 14px;font-size:11.5px;line-height:1.7;color:var(--muted,#8b8b9c);overflow-wrap:anywhere}
.prod-skeleton{display:flex;flex-direction:column;gap:8px;padding:12px}
.prod-skeleton-row{height:72px;border-radius:9px;background:linear-gradient(90deg,rgba(255,255,255,.045),rgba(255,255,255,.085),rgba(255,255,255,.045));background-size:220% 100%;animation:prod-shimmer 1.2s ease-in-out infinite}
@keyframes prod-shimmer{0%{background-position:100% 0}100%{background-position:-100% 0}}
.prod-form{display:flex;flex-direction:column;gap:13px;padding:2px}
.prod-field{display:flex;flex-direction:column;gap:6px}
.prod-field-label{font-size:11.5px;font-weight:650;color:var(--text,#e8e8ef)}
.prod-field-hint{font-size:10.5px;line-height:1.5;color:var(--muted,#8b8b9c)}
.prod-input{width:100%;border:1px solid var(--line,#2a2a36);border-radius:8px;background:var(--bg,#0f0f14);color:var(--text,#e8e8ef);padding:8px 10px;font:inherit;font-size:12.5px;outline:none}
.prod-input:focus{border-color:var(--accent,#6c8cff);box-shadow:0 0 0 2px rgba(108,140,255,.14)}
.prod-input[aria-invalid='true']{border-color:var(--err,#f06060)}
.prod-form-error{display:none;padding:8px 10px;border:1px solid rgba(240,96,96,.4);border-radius:8px;background:rgba(240,96,96,.08);color:#ffb3b3;font-size:11.5px;line-height:1.55}
.prod-form-error-visible{display:block}
@media (max-width:900px){.prod-layout{grid-template-columns:1fr;overflow:auto}.prod-panel-list{max-height:360px}.prod-summary-body{overflow:visible}.prod-metrics{grid-template-columns:repeat(2,minmax(130px,1fr))}}
@media (max-width:560px){.prod-page{padding:11px}.prod-head-actions{margin-left:0;width:100%}.prod-btn{flex:1}.prod-metrics{grid-template-columns:1fr}.prod-order-meta{grid-template-columns:1fr 1fr}.prod-summary-head{flex-direction:column}.prod-summary-tools{width:100%;justify-content:flex-start}}
`;

let styleInjected = false;
let rootEl = null;
let ctxRef = null;
let activeModal = null;
let clickHandler = null;
let session = 0;
let state = initialState();

function initialState() {
  return {
    loading: true,
    error: '',
    orders: [],
    selectedId: null,
    summary: null,
    summaryLoading: false,
    summaryError: '',
    costError: '',
    summaries: new Map(),
    detailSeq: 0,
  };
}

function ensureStyle() {
  if (styleInjected || (typeof document !== 'undefined' && document.getElementById(STYLE_ID))) {
    styleInjected = true;
    return;
  }
  injectStyle(STYLE_ID, CSS);
  styleInjected = true;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function firstObject(...values) {
  return values.find(isObject) || null;
}

function numberValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function pickNumber(source, keys) {
  if (!isObject(source)) return null;
  for (const key of keys) {
    const value = numberValue(source[key]);
    if (value !== null) return value;
  }
  return null;
}

function pickText(source, keys) {
  if (!isObject(source)) return '';
  for (const key of keys) {
    if (source[key] !== null && source[key] !== undefined && String(source[key]).trim()) {
      return String(source[key]).trim();
    }
  }
  return '';
}

function extractOrders(payload) {
  if (Array.isArray(payload)) return payload.filter(isObject);
  const data = firstObject(payload?.data);
  const candidates = [payload?.orders, payload?.list, data?.orders, data?.list];
  const orders = candidates.find(Array.isArray);
  return (orders || []).filter(isObject);
}

function orderBudget(order) {
  return pickNumber(order, ['budgetLimit', 'budget_limit', 'budget']);
}

function orderEpisodeCount(order) {
  const episodeValue = order?.episodeCount ?? order?.episode_count ?? order?.episodes;
  if (Array.isArray(episodeValue)) return episodeValue.length;
  return numberValue(episodeValue);
}

function normalizeSummary(payload, fallbackOrder = {}) {
  const root = isObject(payload) ? payload : {};
  const data = firstObject(root.data) || {};
  const orderInfo = firstObject(root.order, data.order) || {};
  const raw = firstObject(root.summary, root.orderSummary, data.summary, data.orderSummary, data, root) || {};
  const merged = { ...fallbackOrder, ...orderInfo, ...raw };

  const episodeValue = merged.episodeCount ?? merged.episode_count ?? merged.episodes;
  const episodeCount = Array.isArray(episodeValue) ? episodeValue.length : numberValue(episodeValue);
  const completed = pickNumber(merged, ['completedCount', 'completed', 'completedEpisodes', 'completed_episodes']);
  const shotTotal = pickNumber(merged, ['shotTotal', 'shot_total']);
  const shotDone = pickNumber(merged, ['shotDone', 'shot_done']);

  let shotRate = pickNumber(merged, ['shotDonePct', 'shot_done_pct', 'shotRatePct', 'shot_rate_pct']);
  if (shotRate === null) {
    shotRate = pickNumber(merged, ['shotCompletionRate', 'shot_completion_rate', 'completionRate', 'completion_rate']);
    if (shotRate !== null && Math.abs(shotRate) <= 1) shotRate *= 100;
  }
  if (shotRate === null && shotTotal !== null && shotTotal > 0 && shotDone !== null) {
    shotRate = (shotDone / shotTotal) * 100;
  }
  if (shotRate !== null) shotRate = Math.max(0, Math.min(100, shotRate));

  const blockedRaw = merged.blockedCodes ?? merged.blockedEpisodeCodes ?? merged.blocked_codes ?? merged.blocked_episode_codes;
  const blockedCodes = Array.isArray(blockedRaw) ? blockedRaw.map(String) : [];
  const blockedValue = merged.blockedCount ?? merged.blockedEpisodes ?? merged.blocked_episodes ?? merged.blocked;
  const blocked = Array.isArray(blockedValue)
    ? blockedValue.length
    : (numberValue(blockedValue) ?? blockedCodes.length);

  const cost = firstObject(merged.cost) || {};
  const budgetLimit = pickNumber(merged, ['budgetLimit', 'budget_limit', 'budget']);
  const spent = pickNumber(merged, ['spent', 'actualCost', 'actual_cost', 'usedCost', 'used_cost'])
    ?? pickNumber(cost, ['spent', 'actualCost', 'actual_cost', 'used', 'amount', 'total']);
  let remaining = pickNumber(merged, ['remaining', 'remainingBudget', 'remaining_budget', 'balance'])
    ?? pickNumber(cost, ['remaining', 'remainingBudget', 'remaining_budget', 'balance']);
  if (remaining === null && budgetLimit !== null && budgetLimit > 0 && spent !== null) {
    remaining = budgetLimit - spent;
  }
  const currency = pickText(merged, ['currency']) || pickText(cost, ['currency']) || 'CNY';
  const over = merged.over === true || cost.over === true || (budgetLimit !== null && budgetLimit > 0 && spent !== null && spent > budgetLimit);

  return {
    ...merged,
    id: pickText(merged, ['id', 'orderId', 'order_id']),
    projectId: pickText(merged, ['projectId', 'project_id']),
    title: pickText(merged, ['title', 'name']),
    status: pickText(merged, ['status']),
    updatedAt: pickText(merged, ['updatedAt', 'updated_at']),
    episodes: episodeCount,
    episodeCount,
    completed,
    shotTotal,
    shotDone,
    shotCompletionRate: shotRate,
    blocked,
    blockedCodes,
    budgetLimit,
    spent,
    remaining,
    currency,
    over,
  };
}

function costCollectionCandidates(root) {
  const data = firstObject(root?.data) || {};
  const costRoot = firstObject(root?.cost) || {};
  const dataCost = firstObject(data?.cost) || {};
  return [
    root?.projects,
    root?.byProject,
    root?.by_project,
    root?.costs,
    costRoot?.projects,
    costRoot?.byProject,
    costRoot?.by_project,
    data?.projects,
    data?.byProject,
    data?.by_project,
    data?.costs,
    dataCost?.projects,
    dataCost?.byProject,
    dataCost?.by_project,
  ].filter((value) => value !== undefined && value !== null);
}

function findProjectCost(collection, projectId) {
  if (Array.isArray(collection)) {
    return collection.find((item) => {
      if (!isObject(item)) return false;
      const id = pickText(item, ['projectId', 'project_id', 'id']);
      return id === projectId;
    }) || null;
  }
  if (!isObject(collection)) return null;
  if (collection[projectId] !== undefined) return collection[projectId];
  return Object.values(collection).find((item) => {
    if (!isObject(item)) return false;
    const id = pickText(item, ['projectId', 'project_id', 'id']);
    return id === projectId;
  }) || null;
}

function normalizeCostValue(raw) {
  if (numberValue(raw) !== null) return { spent: numberValue(raw), remaining: null, budget: null, currency: 'CNY', over: false };
  if (!isObject(raw)) return null;
  const nested = firstObject(raw.cost) || firstObject(raw.summary) || {};
  const spent = pickNumber(raw, ['spent', 'actualCost', 'actual_cost', 'usedCost', 'used_cost', 'totalCost', 'total_cost', 'amount', 'total'])
    ?? pickNumber(nested, ['spent', 'actualCost', 'actual_cost', 'usedCost', 'used_cost', 'totalCost', 'total_cost', 'amount', 'total'])
    ?? numberValue(raw.cost);
  const budget = pickNumber(raw, ['budget', 'budgetLimit', 'budget_limit', 'limit'])
    ?? pickNumber(nested, ['budget', 'budgetLimit', 'budget_limit', 'limit']);
  let remaining = pickNumber(raw, ['remaining', 'remainingBudget', 'remaining_budget', 'balance'])
    ?? pickNumber(nested, ['remaining', 'remainingBudget', 'remaining_budget', 'balance']);
  if (remaining === null && budget !== null && spent !== null) remaining = budget - spent;
  const currency = pickText(raw, ['currency']) || pickText(nested, ['currency']) || 'CNY';
  const over = raw.over === true || nested.over === true || (budget !== null && spent !== null && spent > budget);
  if (spent === null && budget === null && remaining === null) return null;
  return { spent, budget, remaining, currency, over };
}

function normalizeCost(payload, projectId) {
  const root = isObject(payload) ? payload : {};
  const data = firstObject(root.data) || {};
  const rootCost = firstObject(root.cost) || {};
  const dataCost = firstObject(data.cost) || {};
  const scopedRoots = [rootCost, dataCost, root.summary, data.summary, data, root];

  for (const scope of scopedRoots) {
    if (!isObject(scope)) continue;
    const scopeProjectId = pickText(scope, ['projectId', 'project_id']);
    if (scopeProjectId && scopeProjectId === projectId) {
      const normalized = normalizeCostValue(scope);
      if (normalized) return normalized;
    }
  }

  let hadProjectCollections = false;
  for (const collection of costCollectionCandidates(root)) {
    hadProjectCollections = true;
    const matched = findProjectCost(collection, projectId);
    if (matched !== null) {
      const normalized = normalizeCostValue(matched);
      if (normalized) return normalized;
    }
  }

  if (hadProjectCollections) return null;

  // 常见实现会在带 projectId 查询时直接返回该项目成本；只有响应不带其它项目作用域时才采信。
  for (const scope of scopedRoots) {
    if (!isObject(scope)) continue;
    const scopeProjectId = pickText(scope, ['projectId', 'project_id']);
    if (scopeProjectId && scopeProjectId !== projectId) continue;
    const normalized = normalizeCostValue(scope);
    if (normalized) return normalized;
  }
  return null;
}

function orderStatus(status) {
  const value = String(status || '').trim();
  const key = value.toLowerCase();
  if (['done', 'completed', 'complete', 'finished', 'delivered', '已完成'].includes(key)) {
    return { label: '已完成', tone: 'ok' };
  }
  if (['blocked', '阻塞', '已阻塞'].includes(key)) return { label: '阻塞', tone: 'err' };
  if (['in_progress', 'active', 'running', '制作中', '进行中'].includes(key)) {
    return { label: '制作中', tone: 'info' };
  }
  if (['draft', '草稿'].includes(key)) return { label: '草稿', tone: 'muted' };
  return { label: value || '未知状态', tone: 'muted' };
}

function money(value, currency = 'CNY') {
  const number = numberValue(value);
  if (number === null) return '—';
  const symbols = { CNY: '¥', USD: '$', EUR: '€', JPY: '¥', GBP: '£' };
  const symbol = symbols[String(currency || 'CNY').toUpperCase()] || `${String(currency || 'CNY').toUpperCase()} `;
  return `${symbol}${number.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatRate(value) {
  const number = numberValue(value);
  if (number === null) return '—';
  return `${number.toFixed(1)}%`;
}

function formatCount(value, suffix = '') {
  const number = numberValue(value);
  return number === null ? '—' : `${number.toLocaleString('zh-CN')}${suffix}`;
}

function badge(status) {
  const info = orderStatus(status);
  return el('span', { class: `prod-badge prod-badge-${info.tone}`, text: info.label });
}

function effectiveOrder(order) {
  const cached = state.summaries.get(order.id);
  return cached ? { ...order, ...cached } : order;
}

function renderHeader() {
  return el('div', { class: 'prod-head' }, [
    el('div', { class: 'prod-head-main' }, [
      el('h1', { class: 'prod-title' }, ['🎬 生产看板']),
      el('div', { class: 'prod-subtitle', text: '多项目订单、集级进度、阻塞与预算消耗一屏掌握。' }),
    ]),
    el('div', { class: 'prod-head-actions' }, [
      el('span', { class: 'prod-count' }, [el('span', { text: '订单' }), el('b', { text: state.orders.length })]),
      el('button', {
        class: 'prod-btn prod-btn-ghost',
        type: 'button',
        dataset: { prodAction: 'refresh' },
        disabled: state.loading,
        title: '重新读取订单列表',
      }, ['↻ 刷新']),
      el('button', {
        class: 'prod-btn prod-btn-primary',
        type: 'button',
        dataset: { prodAction: 'create' },
      }, ['＋ 新建订单']),
    ]),
  ]);
}

function renderOrderItem(order) {
  const view = effectiveOrder(order);
  const selected = state.selectedId === order.id;
  const budget = orderBudget(view);
  const episodes = orderEpisodeCount(view);
  return el('button', {
    class: `prod-order${selected ? ' prod-order-active' : ''}`,
    type: 'button',
    dataset: { prodAction: 'select', prodId: order.id },
    'aria-pressed': selected ? 'true' : 'false',
  }, [
    el('div', { class: 'prod-order-top' }, [
      el('div', { class: 'prod-order-name', text: view.title || '未命名订单' }),
      badge(view.status),
    ]),
    el('div', { class: 'prod-order-id', text: order.id || '—' }),
    el('div', { class: 'prod-order-meta' }, [
      el('div', { class: 'prod-order-meta-item' }, [
        el('span', { class: 'prod-order-meta-label', text: '预算' }),
        el('span', { class: 'prod-order-meta-value', title: money(budget), text: money(budget) }),
      ]),
      el('div', { class: 'prod-order-meta-item' }, [
        el('span', { class: 'prod-order-meta-label', text: '集数' }),
        el('span', { class: 'prod-order-meta-value', text: formatCount(episodes, ' 集') }),
      ]),
      el('div', { class: 'prod-order-meta-item' }, [
        el('span', { class: 'prod-order-meta-label', text: '阻塞' }),
        el('span', { class: 'prod-order-meta-value', text: formatCount(view.blocked, ' 集') }),
      ]),
    ]),
  ]);
}

function renderEmptyList() {
  return el('div', { class: 'prod-empty' }, [
    el('div', { class: 'prod-empty-icon', text: '🗂️' }),
    el('div', { class: 'prod-empty-title', text: '暂无生产订单' }),
    el('div', { class: 'prod-empty-text', text: '创建第一张订单后，这里会展示预算、集数和制作进度。' }),
    el('button', { class: 'prod-btn prod-btn-primary', type: 'button', dataset: { prodAction: 'create' } }, ['＋ 新建订单']),
  ]);
}

function renderError(title, message, retryAction = 'refresh') {
  return el('div', { class: 'prod-error-state' }, [
    el('div', { class: 'prod-empty-icon', text: '⚠️' }),
    el('div', { class: 'prod-error-title', text: title }),
    el('div', { class: 'prod-error-text', text: message || '未知错误' }),
    el('button', { class: 'prod-btn', type: 'button', dataset: { prodAction: retryAction } }, ['重试']),
  ]);
}

function renderListPanel() {
  let content;
  if (state.loading && !state.orders.length) {
    content = el('div', { class: 'prod-skeleton', 'aria-label': '正在加载订单列表' }, [
      el('div', { class: 'prod-skeleton-row' }),
      el('div', { class: 'prod-skeleton-row' }),
      el('div', { class: 'prod-skeleton-row' }),
    ]);
  } else if (state.error) {
    content = renderError('订单读取失败', state.error);
  } else if (!state.orders.length) {
    content = renderEmptyList();
  } else {
    content = el('div', { class: 'prod-order-list' }, state.orders.map(renderOrderItem));
  }

  return el('section', { class: 'prod-panel prod-panel-list', 'aria-label': '生产订单列表' }, [
    el('div', { class: 'prod-panel-head' }, [
      el('div', { class: 'prod-panel-title', text: '订单列表' }),
      el('div', { class: 'prod-panel-hint', text: state.loading && state.orders.length ? '刷新中…' : '点击查看摘要' }),
    ]),
    content,
  ]);
}

function metric(label, value, note = '', tone = '') {
  const sizeClass = String(value).length > 12 ? ' prod-metric-value-prod-small' : '';
  const toneClass = tone ? ` prod-metric-${tone}` : '';
  return el('div', { class: 'prod-metric' }, [
    el('span', { class: 'prod-metric-label', text: label }),
    el('strong', { class: `prod-metric-value${sizeClass}${toneClass}`, text: value }),
    note ? el('div', { class: 'prod-metric-note', text: note }) : null,
  ]);
}

function renderSummaryLoading() {
  return el('div', { class: 'prod-loading', 'aria-live': 'polite' }, [
    el('div', { class: 'prod-spinner' }),
    el('div', { text: '正在读取订单摘要与成本…' }),
  ]);
}

function renderSummaryEmpty() {
  return el('div', { class: 'prod-empty' }, [
    el('div', { class: 'prod-empty-icon', text: '📋' }),
    el('div', { class: 'prod-empty-title', text: state.orders.length ? '选择一个订单' : '暂无订单摘要' }),
    el('div', { class: 'prod-empty-text', text: state.orders.length ? '点击左侧订单，查看集数、完成率、阻塞集与预算消耗。' : '新建订单后即可查看生产摘要。' }),
  ]);
}

function renderSummaryPanel() {
  let content;
  if (state.loading && !state.orders.length) {
    content = renderSummaryLoading();
  } else if (state.error && !state.orders.length) {
    content = renderError('摘要暂不可用', '请先恢复订单列表。');
  } else if (!state.selectedId) {
    content = renderSummaryEmpty();
  } else if (state.summaryLoading && !state.summary) {
    content = renderSummaryLoading();
  } else if (state.summaryError && !state.summary) {
    content = renderError('订单摘要读取失败', state.summaryError, 'retry-summary');
  } else {
    content = renderSummaryBody();
  }
  return el('section', { class: 'prod-panel', 'aria-label': '订单摘要' }, [
    el('div', { class: 'prod-panel-head' }, [
      el('div', { class: 'prod-panel-title', text: '订单摘要' }),
      el('div', { class: 'prod-panel-hint', text: state.summaryLoading ? '同步中…' : '实时数据' }),
    ]),
    content,
  ]);
}

function renderSummaryBody() {
  const selectedOrder = state.orders.find((order) => order.id === state.selectedId) || {};
  const summary = normalizeSummary(state.summary || {}, selectedOrder);
  const budget = summary.budgetLimit;
  const spent = summary.spent;
  const remaining = summary.remaining;
  const currency = summary.currency || 'CNY';
  const rate = summary.shotCompletionRate;
  const blockedCodes = Array.isArray(summary.blockedCodes) ? summary.blockedCodes : [];
  const budgetNote = budget === null ? '订单未设置预算' : `预算上限 ${money(budget, currency)}`;
  const spentTone = summary.over ? 'err' : '';
  const remainingTone = summary.over ? 'err' : '';

  return el('div', { class: 'prod-summary-body' }, [
    el('div', { class: 'prod-summary-head' }, [
      el('div', { class: 'prod-summary-heading' }, [
        el('h2', { class: 'prod-summary-title', text: summary.title || selectedOrder.title || '未命名订单' }),
        el('div', { class: 'prod-summary-meta' }, [
          badge(summary.status || selectedOrder.status),
          el('span', {}, ['项目 ', el('code', { text: summary.projectId || selectedOrder.projectId || '—' })]),
          el('span', { text: `更新 ${fmtDate(summary.updatedAt || selectedOrder.updatedAt)}` }),
        ]),
      ]),
      el('div', { class: 'prod-summary-tools' }, [
        el('button', { class: 'prod-btn', type: 'button', dataset: { prodAction: 'retry-summary' }, disabled: state.summaryLoading }, ['↻ 刷新摘要']),
      ]),
    ]),
    el('div', { class: 'prod-metrics' }, [
      metric('集数', formatCount(summary.episodes, ' 集'), '订单内全部生产集'),
      metric('完成数', formatCount(summary.completed, ' 集'), '状态为已完成'),
      metric('镜头完成率', formatRate(rate), summary.shotTotal !== null ? `${formatCount(summary.shotDone)} / ${formatCount(summary.shotTotal)} 镜` : '暂无镜头数据'),
      metric('阻塞集', formatCount(summary.blocked, ' 集'), blockedCodes.length ? '需优先处理' : '当前无阻塞', summary.blocked > 0 ? 'warn' : ''),
      metric('已花费', money(spent, currency), state.costError ? state.costError : budgetNote, spentTone),
      metric('剩余预算', money(remaining, currency), summary.over ? '已超出预算' : (budget === null ? '订单未设置预算' : '按订单预算计算'), remainingTone),
    ]),
    el('div', { class: 'prod-rate' }, [
      el('div', { class: 'prod-rate-head' }, [
        el('span', { text: '镜头完成率' }),
        el('b', { text: formatRate(rate) }),
      ]),
      el('div', {
        class: 'prod-rate-track',
        role: 'progressbar',
        'aria-label': '镜头完成率',
        'aria-valuemin': '0',
        'aria-valuemax': '100',
        'aria-valuenow': rate === null ? '0' : String(rate),
      }, [
        el('div', { class: 'prod-rate-fill', style: { width: `${rate === null ? 0 : rate}%` } }),
      ]),
    ]),
    el('div', { class: 'prod-blocked' }, [
      el('div', { class: 'prod-section-title', text: '⛔ 阻塞集' }),
      blockedCodes.length
        ? el('div', { class: 'prod-blocked-list' }, blockedCodes.map((code) => el('span', { class: 'prod-code', text: code })))
        : el('div', { class: 'prod-blocked-empty', text: summary.blocked > 0 ? `当前有 ${formatCount(summary.blocked)} 个阻塞集，接口未返回集编号。` : '当前没有阻塞集。' }),
    ]),
    state.costError ? el('div', { class: 'prod-note', text: `成本接口异常：${state.costError}。摘要中的其他进度数据仍可查看。` }) : null,
  ]);
}

function render() {
  if (!rootEl) return;
  rootEl.replaceChildren(el('div', { class: 'prod-page' }, [
    renderHeader(),
    el('div', { class: 'prod-layout' }, [renderListPanel(), renderSummaryPanel()]),
  ]));
}

async function loadOrders(runId, { selectId = null } = {}) {
  const api = ctxRef?.api;
  if (!api || runId !== session) return;
  state.loading = true;
  state.error = '';
  render();
  try {
    const payload = await api.get('/api/production/orders');
    if (runId !== session) return;
    state.orders = extractOrders(payload);
    state.loading = false;

    const preferred = selectId || state.selectedId;
    const selected = state.orders.find((order) => order.id === preferred) || state.orders[0] || null;
    render();
    if (selected) {
      void selectOrder(selected.id, runId);
      void enrichOrders(state.orders, runId);
    } else {
      state.selectedId = null;
      state.summary = null;
      state.summaryError = '';
      state.costError = '';
      render();
    }
  } catch (error) {
    if (runId !== session) return;
    state.loading = false;
    state.error = error?.message || String(error);
    render();
  }
}

async function enrichOrders(orders, runId) {
  const api = ctxRef?.api;
  if (!api || runId !== session) return;
  const targets = orders.filter((order) => orderEpisodeCount(effectiveOrder(order)) === null);
  if (!targets.length) return;
  let cursor = 0;
  const worker = async () => {
    while (cursor < targets.length) {
      const order = targets[cursor++];
      try {
        const payload = await api.get(`/api/production/orders/${encodeURIComponent(order.id)}`);
        if (runId !== session) return;
        state.summaries.set(order.id, normalizeSummary(payload, order));
      } catch {
        // 单条摘要失败不拖垮列表；点击订单时仍会显示独立错误与重试入口。
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(5, targets.length) }, worker));
  if (runId === session) render();
}

async function fetchSummary(order, runId) {
  const api = ctxRef?.api;
  if (!api) throw new Error('生产看板上下文已失效');
  const payload = await api.get(`/api/production/orders/${encodeURIComponent(order.id)}`);
  if (runId !== session) throw new Error('请求已取消');
  return normalizeSummary(payload, order);
}

async function fetchCost(projectId, runId) {
  const api = ctxRef?.api;
  if (!api || !projectId) return null;
  const params = new URLSearchParams({ projectId, project_id: projectId });
  const payload = await api.get(`/api/assets/cost?${params.toString()}`);
  if (runId !== session) throw new Error('请求已取消');
  return normalizeCost(payload, projectId);
}

async function selectOrder(orderId, runId) {
  if (runId !== session) return;
  const order = state.orders.find((item) => item.id === orderId);
  if (!order) return;
  const sequence = ++state.detailSeq;
  state.selectedId = orderId;
  state.summary = state.summaries.get(orderId) || null;
  state.summaryLoading = true;
  state.summaryError = '';
  state.costError = '';
  render();

  const [summaryResult, costResult] = await Promise.allSettled([
    fetchSummary(order, runId),
    fetchCost(pickText(order, ['projectId', 'project_id']), runId),
  ]);
  if (runId !== session || sequence !== state.detailSeq || state.selectedId !== orderId) return;

  if (summaryResult.status === 'fulfilled') {
    state.summary = summaryResult.value;
    state.summaries.set(orderId, summaryResult.value);
  } else if (!state.summary) {
    state.summaryError = summaryResult.reason?.message || String(summaryResult.reason);
  }

  if (costResult.status === 'fulfilled' && costResult.value) {
    const cost = costResult.value;
    const base = normalizeSummary(state.summary || {}, order);
    state.summary = {
      ...base,
      spent: cost.spent ?? base.spent,
      remaining: cost.remaining ?? base.remaining,
      budgetLimit: base.budgetLimit ?? cost.budget,
      currency: cost.currency || base.currency,
      over: cost.over || base.over,
    };
    state.summaries.set(orderId, state.summary);
  } else if (costResult.status === 'rejected') {
    state.costError = costResult.reason?.message || String(costResult.reason);
  }

  state.summaryLoading = false;
  render();
}

function openCreateModal(runId) {
  if (runId !== session || !ctxRef) return;
  const ctx = ctxRef;
  if (activeModal) activeModal.close();

  const selected = state.orders.find((order) => order.id === state.selectedId);
  const projectInput = el('input', {
    class: 'prod-input',
    name: 'projectId',
    type: 'text',
    value: selected?.projectId || selected?.project_id || '',
    placeholder: '例如 PRJ-001',
    autocomplete: 'off',
  });
  const titleInput = el('input', {
    class: 'prod-input',
    name: 'title',
    type: 'text',
    placeholder: '例如 都市悬疑短剧',
    autocomplete: 'off',
  });
  const budgetInput = el('input', {
    class: 'prod-input',
    name: 'budgetLimit',
    type: 'number',
    min: '0',
    step: '0.01',
    placeholder: '例如 120000',
  });
  const errorBox = el('div', { class: 'prod-form-error', role: 'alert' });
  const submitButton = el('button', { class: 'prod-btn prod-btn-primary', type: 'button' }, ['创建订单']);
  const cancelButton = el('button', {
    class: 'prod-btn',
    type: 'button',
    onclick: () => activeModal?.close(),
  }, ['取消']);

  const showError = (message, field) => {
    errorBox.textContent = message;
    errorBox.classList.add('prod-form-error-visible');
    field?.setAttribute('aria-invalid', 'true');
    field?.focus();
  };

  const submit = async () => {
    if (submitButton.disabled) return;
    errorBox.classList.remove('prod-form-error-visible');
    projectInput.setAttribute('aria-invalid', 'false');
    titleInput.setAttribute('aria-invalid', 'false');
    budgetInput.setAttribute('aria-invalid', 'false');
    const projectId = projectInput.value.trim();
    const title = titleInput.value.trim();
    const budgetRaw = budgetInput.value.trim();
    const budgetLimit = budgetRaw === '' ? 0 : Number(budgetRaw);
    if (!projectId) return showError('请填写项目 ID。', projectInput);
    if (!title) return showError('请填写订单标题。', titleInput);
    if (!Number.isFinite(budgetLimit) || budgetLimit < 0) return showError('预算必须是大于或等于 0 的数字。', budgetInput);

    submitButton.disabled = true;
    cancelButton.disabled = true;
    submitButton.textContent = '创建中…';
    try {
      const payload = await ctx.api.post('/api/production/orders', { projectId, title, budgetLimit });
      if (runId !== session) return;
      const created = firstObject(payload?.order, payload?.data?.order)
        || (isObject(payload?.data) ? payload.data : null)
        || (isObject(payload) ? payload : null);
      const createdId = pickText(created, ['id', 'orderId', 'order_id']);
      activeModal?.close();
      activeModal = null;
      ctx.toast('生产订单已创建', 'ok');
      await loadOrders(runId, { selectId: createdId });
    } catch (error) {
      if (runId === session) {
        showError(`创建失败：${error?.message || String(error)}`);
        ctx.toast(`创建订单失败：${error?.message || String(error)}`, 'err');
      }
    } finally {
      if (runId === session) {
        submitButton.disabled = false;
        cancelButton.disabled = false;
        submitButton.textContent = '创建订单';
      }
    }
  };

  submitButton.addEventListener('click', submit);
  const form = el('form', { class: 'prod-form', onsubmit: (event) => { event.preventDefault(); submit(); } }, [
    el('label', { class: 'prod-field' }, [
      el('span', { class: 'prod-field-label', text: '项目 ID *' }),
      projectInput,
      el('span', { class: 'prod-field-hint', text: '用于把订单关联到已有项目与成本台账。' }),
    ]),
    el('label', { class: 'prod-field' }, [
      el('span', { class: 'prod-field-label', text: '订单标题 *' }),
      titleInput,
      el('span', { class: 'prod-field-hint', text: '建议使用项目名 + 版本或交付批次。' }),
    ]),
    el('label', { class: 'prod-field' }, [
      el('span', { class: 'prod-field-label', text: '预算上限' }),
      budgetInput,
      el('span', { class: 'prod-field-hint', text: '留空按 0 创建；创建后仍可查看实时花费与剩余预算。' }),
    ]),
    errorBox,
  ]);

  const modal = ctx.modal({
    title: '新建生产订单',
    body: form,
    width: 520,
    footer: [cancelButton, submitButton],
    onClose: () => { if (activeModal === modal) activeModal = null; },
  });
  activeModal = modal;
  requestAnimationFrame(() => projectInput.focus());
}

function onClick(event) {
  const runId = session;
  const target = event.target?.closest?.('[data-prod-action]');
  if (!target || !rootEl?.contains(target)) return;
  const action = target.dataset.prodAction;
  if (action === 'create') { openCreateModal(runId); return; }
  if (action === 'refresh') { void loadOrders(runId); return; }
  if (action === 'select') { void selectOrder(target.dataset.prodId, runId); return; }
  if (action === 'retry-summary' && state.selectedId) { void selectOrder(state.selectedId, runId); }
}

export function mount(root, ctx) {
  if (!root || !ctx?.api) throw new Error('生产看板缺少挂载节点或 ctx.api');
  if (rootEl) unmount();
  styleInjected = styleInjected || (typeof document !== 'undefined' && Boolean(document.getElementById(STYLE_ID)));
  ensureStyle();
  session += 1;
  const runId = session;
  rootEl = root;
  ctxRef = ctx;
  state = initialState();
  clickHandler = onClick;
  rootEl.addEventListener('click', clickHandler);
  render();
  void loadOrders(runId);
}

export function unmount() {
  session += 1;
  if (rootEl && clickHandler) rootEl.removeEventListener('click', clickHandler);
  if (activeModal) {
    try { activeModal.close(); } catch { /* ignore */ }
  }
  activeModal = null;
  rootEl = null;
  ctxRef = null;
  clickHandler = null;
  state = initialState();
}
