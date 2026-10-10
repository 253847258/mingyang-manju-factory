// 剧本工厂 · 项目预算（plain text module）
//
// 在「生成前预估」的基础上，给单个剧本项目加一条成本上限：
//   scripts.options.budget = { enabled, limit, hard, currency, note }
//     enabled 是否启用
//     limit   上限金额（与 billing 币种一致）
//     hard    true=超额直接拒绝（硬上限）；false=超额需人工确认后继续
//
// - getBudget / setBudget：读写项目预算
// - budgetCheck：按集/阶段预估本次花费，与上限比对，给出中文结论
//
// 复用 modules/render.js 的 estimateRender，保证和制作台口径一致。

import { get, run } from './db.js';
import { nowISO } from './util.js';
import { estimateRender } from './modules/render.js';

function safeJson(value, fallback) {
  try {
    if (value === null || value === undefined || value === '') return fallback;
    if (typeof value === 'object') return value;
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function money(n) {
  const v = Number(n) || 0;
  return Math.round(v * 100) / 100;
}

export function getBudget(scriptId) {
  const script = get('SELECT * FROM scripts WHERE id = ?', scriptId);
  if (!script) throw new Error('剧本不存在');
  const options = safeJson(script.options, {}) || {};
  const raw = options.budget || {};
  return {
    enabled: Boolean(raw.enabled),
    limit: Number(raw.limit) || 0,
    hard: Boolean(raw.hard),
    currency: raw.currency || 'CNY',
    note: raw.note || '',
  };
}

export function setBudget(scriptId, patch = {}) {
  const script = get('SELECT * FROM scripts WHERE id = ?', scriptId);
  if (!script) throw new Error('剧本不存在');
  const options = safeJson(script.options, {}) || {};
  const prev = options.budget || {};
  const next = {
    enabled: patch.enabled === undefined ? Boolean(prev.enabled) : Boolean(patch.enabled),
    limit: patch.limit === undefined ? (Number(prev.limit) || 0) : Math.max(0, Number(patch.limit) || 0),
    hard: patch.hard === undefined ? Boolean(prev.hard) : Boolean(patch.hard),
    currency: patch.currency || prev.currency || 'CNY',
    note: patch.note === undefined ? (prev.note || '') : String(patch.note).slice(0, 200),
  };
  options.budget = next;
  run('UPDATE scripts SET options = ?, updated_at = ? WHERE id = ?', JSON.stringify(options), nowISO(), scriptId);
  return { ok: true, budget: next };
}

export function budgetCheck(scriptId, { codes = [], stages = [], confirm = false } = {}) {
  const budget = getBudget(scriptId);
  let estimate = null;
  try {
    estimate = estimateRender({ scriptId, codes, stages });
  } catch (err) {
    return {
      ok: true, blocked: false, needConfirm: false, confirm,
      budget, estimate: null, amount: null,
      reason: `无法预估本项目花费（${err.message}），请人工确认后再继续`,
    };
  }
  const amount = money(estimate?.cost?.amount);
  const month = money(estimate?.cost?.month?.amount);
  const totals = estimate?.totals || {};
  const currency = budget.currency || estimate?.cost?.currency || 'CNY';

  if (!budget.enabled || budget.limit <= 0) {
    return {
      ok: true, blocked: false, needConfirm: false, confirm,
      budget, estimate: totals, amount, month, currency,
      reason: '未设置项目预算上限，按数量预估执行',
    };
  }
  const over = amount > budget.limit;
  if (!over) {
    return {
      ok: true, blocked: false, needConfirm: false, confirm,
      budget, estimate: totals, amount, month, currency,
      remaining: money(budget.limit - amount),
      reason: `本次预估 ${currency} ${amount}，未超过上限 ${currency} ${budget.limit}`,
    };
  }
  const reason = `本次预估 ${currency} ${amount}，超过项目上限 ${currency} ${budget.limit}（超出 ${currency} ${money(amount - budget.limit)}）`;
  if (budget.hard) {
    return {
      ok: false, blocked: true, needConfirm: false, confirm,
      budget, estimate: totals, amount, month, currency,
      reason: `${reason}。项目已设为硬上限，已拒绝本次生成；请上调预算或删减镜头。`,
    };
  }
  if (!confirm) {
    return {
      ok: true, blocked: false, needConfirm: true, confirm,
      budget, estimate: totals, amount, month, currency,
      reason: `${reason}。请确认是否继续。`,
    };
  }
  return {
    ok: true, blocked: false, needConfirm: false, confirm: true,
    budget, estimate: totals, amount, month, currency,
    reason: `${reason}。已按人工确认继续。`,
  };
}
