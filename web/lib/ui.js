// 前端 UI 工具：元素创建、弹窗、提示、右键菜单、格式化
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') node.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'multiple') node[k] = Boolean(v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children || [])) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function toast(msg, type = 'info', timeout = 3600) {
  let box = $('.toasts');
  if (!box) { box = el('div', { class: 'toasts' }); document.body.append(box); }
  const t = el('div', { class: `toast ${type}` }, [el('div', { text: String(msg) })]);
  box.append(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateX(16px)'; t.style.transition = '.25s'; setTimeout(() => t.remove(), 260); }, timeout);
  return t;
}

export function confirmDialog(message, { title = '确认操作', okText = '确定', cancelText = '取消' } = {}) {
  return new Promise((resolve) => {
    const overlay = el('div', { class: 'overlay' });
    const close = (v) => { overlay.remove(); resolve(v); };
    const modal = el('div', { class: 'modal', style: { width: '400px' } }, [
      el('header', {}, ['❓ ', title]),
      el('div', { class: 'm-body' }, [el('div', { text: message, style: { lineHeight: '1.7' } })]),
      el('footer', {}, [
        el('button', { class: 'btn', onclick: () => close(false) }, [cancelText]),
        el('button', { class: 'btn primary', onclick: () => close(true) }, [okText]),
      ]),
    ]);
    overlay.append(modal);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
    document.body.append(overlay);
  });
}

export function modal({ title = '', body = '', width = 560, footer = null, onClose } = {}) {
  const overlay = el('div', { class: 'overlay' });
  const bodyEl = el('div', { class: 'm-body' });
  if (body instanceof Node) bodyEl.append(body); else bodyEl.innerHTML = body;
  const footEl = el('footer');
  if (footer) for (const b of footer) footEl.append(b);
  else footEl.append(el('button', { class: 'btn', onclick: () => close() }, ['关闭']));
  const m = el('div', { class: 'modal', style: { width: `${width}px`, maxWidth: '94vw' } }, [
    title ? el('header', {}, [title]) : null, bodyEl, footEl,
  ]);
  overlay.append(m);
  const close = () => { overlay.remove(); onClose?.(); };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  const onKey = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
  return { close, body: bodyEl, overlay, modal: m };
}

// ---------------- 右键菜单（支持子菜单） ----------------
let activeMenu = null;
export function closeContextMenu() {
  if (activeMenu) { activeMenu.remove(); activeMenu = null; }
  $$('.ctx-menu').forEach((n) => n.remove());
}

/**
 * items: [{label,icon,disabled,separator,header,onClick} | {label, children:[...]}]
 */
export function contextMenu(x, y, items) {
  closeContextMenu();
  const menu = buildMenu(items, 0);
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  if (r.right > innerWidth - 6) menu.style.left = `${Math.max(6, innerWidth - r.width - 6)}px`;
  if (r.bottom > innerHeight - 6) menu.style.top = `${Math.max(6, innerHeight - r.height - 6)}px`;
  activeMenu = menu;
  return menu;
}

function buildMenu(items, depth) {
  const menu = el('div', { class: `ctx-menu${depth ? ' ctx-sub' : ''}` });
  for (const it of items || []) {
    if (!it) continue;
    if (it.separator) { menu.append(el('div', { class: 'sep' })); continue; }
    if (it.header) { menu.append(el('div', { class: 'head', text: it.header })); continue; }
    const mi = el('div', { class: `mi${it.disabled ? ' disabled' : ''}` }, [
      el('span', { style: { width: '16px', textAlign: 'center' } }, [it.icon || '']),
      el('span', { text: it.label }),
      it.children ? el('span', { class: 'arrow', text: '▸' }) : (it.hint ? el('span', { class: 'arrow small', text: it.hint }) : null),
    ]);
    if (it.children && !it.disabled) {
      let sub = null;
      mi.addEventListener('mouseenter', () => {
        $$('.ctx-sub').forEach((n) => n.remove());
        const rect = mi.getBoundingClientRect();
        sub = buildMenu(it.children, depth + 1);
        sub.style.left = `${rect.right - 4}px`;
        sub.style.top = `${rect.top - 5}px`;
        document.body.append(sub);
        const sr = sub.getBoundingClientRect();
        if (sr.right > innerWidth - 6) sub.style.left = `${Math.max(6, rect.left - sr.width + 4)}px`;
        if (sr.bottom > innerHeight - 6) sub.style.top = `${Math.max(6, innerHeight - sr.height - 6)}px`;
      });
      mi.addEventListener('mouseleave', () => { setTimeout(() => { if (sub && !sub.matches(':hover')) { sub.remove(); sub = null; } }, 180); });
    } else if (!it.disabled) {
      mi.addEventListener('click', () => { closeContextMenu(); it.onClick?.(); });
    }
    menu.append(mi);
  }
  return menu;
}

document.addEventListener('click', (e) => { if (!e.target.closest('.ctx-menu')) closeContextMenu(); });
document.addEventListener('scroll', () => closeContextMenu(), true);
window.addEventListener('blur', () => closeContextMenu());

// ---------------- 格式化 ----------------
export const fmtDate = (s) => (s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '—');
export const fmtNum = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('zh-CN'));
export function fmtWords(n) {
  const v = Number(n) || 0;
  if (v >= 100000000) return `${(v / 100000000).toFixed(2)} 亿`;
  if (v >= 10000) return `${(v / 10000).toFixed(v >= 1000000 ? 0 : 1)} 万`;
  return `${v}`;
}
export const fmtDuration = (s) => {
  const v = Math.round(Number(s) || 0);
  const m = Math.floor(v / 60);
  return m ? `${m}分${String(v % 60).padStart(2, '0')}秒` : `${v}秒`;
};
export function debounce(fn, ms = 260) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/** 注入一次性样式 */
export function injectStyle(id, css) {
  if (document.getElementById(id)) return;
  document.head.append(el('style', { id, html: css }));
}

/** 简单下拉选择 */
export function select(options, value, onchange, extra = {}) {
  const s = el('select', { ...extra, onchange: (e) => onchange?.(e.target.value) });
  for (const o of options) {
    const opt = el('option', { value: o.id ?? o.value, text: o.name ?? o.label });
    if (String(o.id ?? o.value) === String(value ?? '')) opt.selected = true;
    s.append(opt);
  }
  return s;
}

export function labeled(label, control) {
  return el('label', { class: 'f' }, [el('span', { text: label }), control]);
}

export const ui = { el, $, $$, toast, confirm: confirmDialog, modal, contextMenu, closeContextMenu, fmtDate, fmtNum, fmtWords, fmtDuration, debounce, injectStyle, select, labeled };
