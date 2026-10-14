// 黄金五行八卦旋转飞轮：生成 / 计算时的全局「电脑正在运行」指示器。
//
// 用法：
//   computeWheel.begin('AI 正在推演…')   // 计数 +1（可用作长任务开始）
//   computeWheel.end()                   // 计数 -1，归零后隐藏
//   computeWheel.with('AI 正在推演…', fn) // 包裹异步任务，自动开始/结束
//
// 说明：为避免「一闪而过」，请求在超过 delayMs 后才真正显示；overlay 使用
// pointer-events:none，不遮挡页面交互（用户仍可查看进度、点取消）。

import { el, injectStyle } from './ui.js';

const STYLE_ID = 'compute-wheel-style';
const DEFAULT_LABEL = '电脑正在运行计算…';
const DEFAULT_DELAY = 450;

const TRIGRAMS = ['☰', '☱', '☲', '☳', '☴', '☵', '☶', '☷'];
const ELEMENTS = [
  { ch: '金', color: '#f7d774' },
  { ch: '木', color: '#9fe0a8' },
  { ch: '水', color: '#9fd0f5' },
  { ch: '火', color: '#f6a17a' },
  { ch: '土', color: '#e0c18a' },
];

const CSS = `
.cw-overlay{position:fixed;inset:0;z-index:9998;display:flex;align-items:flex-end;justify-content:center;padding-bottom:56px;pointer-events:none;opacity:0;transition:opacity .22s ease}
.cw-overlay.cw-on{opacity:1}
.cw-panel{display:flex;flex-direction:column;align-items:center;gap:10px;padding:18px 22px 16px;border-radius:16px;background:radial-gradient(120% 120% at 50% 0%,rgba(42,31,8,.94),rgba(12,12,16,.95));border:1px solid rgba(212,160,23,.55);box-shadow:0 18px 60px rgba(0,0,0,.55),0 0 42px rgba(212,160,23,.18);backdrop-filter:blur(3px)}
.cw-wheel{position:relative;width:142px;height:142px}
.cw-ring{position:absolute;inset:0;border-radius:50%}
.cw-r8{animation:cwSpin 14s linear infinite;border:1px dashed rgba(212,160,23,.45)}
.cw-r5{inset:18px;animation:cwSpinRev 9s linear infinite;border:1px solid rgba(255,231,150,.28)}
.cw-tri{position:absolute;left:50%;top:50%;width:18px;height:18px;margin:-9px 0 0 -9px;line-height:18px;text-align:center;font-size:15px;color:#f7d774;text-shadow:0 0 8px rgba(247,215,116,.7);transform:rotate(calc(var(--i)*45deg)) translateY(-63px) rotate(calc(var(--i)*-45deg))}
.cw-elem{position:absolute;left:50%;top:50%;width:18px;height:18px;margin:-9px 0 0 -9px;line-height:18px;text-align:center;font-size:13px;font-weight:700;color:#ffe9a8;text-shadow:0 0 8px rgba(247,215,116,.55);transform:rotate(calc(var(--i)*72deg)) translateY(-41px) rotate(calc(var(--i)*-72deg))}
.cw-core{position:absolute;left:50%;top:50%;width:46px;height:46px;margin:-23px 0 0 -23px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:28px;color:#f7d774;animation:cwSpin 6s linear infinite;background:radial-gradient(circle at 50% 35%,#3a2c0a,#141118);border:1px solid rgba(255,231,150,.5);box-shadow:0 0 18px rgba(212,160,23,.5)}
.cw-glow{position:absolute;left:50%;top:50%;width:120px;height:120px;margin:-60px 0 0 -60px;border-radius:50%;background:conic-gradient(from 0deg,rgba(247,215,116,0),rgba(247,215,116,.4),rgba(247,215,116,0) 55%);animation:cwSpin 3.4s linear infinite;filter:blur(3px);opacity:.6}
.cw-label{font-size:12.5px;font-weight:700;letter-spacing:.5px;background:linear-gradient(90deg,#f7d774,#ffe9a8,#d4a017);-webkit-background-clip:text;background-clip:text;color:transparent}
.cw-sub{font-size:11px;color:#cbbd90;max-width:280px;text-align:center;line-height:1.5}
@keyframes cwSpin{to{transform:rotate(360deg)}}
@keyframes cwSpinRev{to{transform:rotate(-360deg)}}
@keyframes cwPulse{0%,100%{opacity:.65}50%{opacity:1}}
@media (prefers-reduced-motion: reduce){.cw-r8,.cw-r5,.cw-glow{animation:none}.cw-core{animation:cwPulse 1.6s ease-in-out infinite}}
`;

let overlay = null;
let subEl = null;
let count = 0;
let showTimer = null;
let hideTimer = null;
let visible = false;

function ensureMounted() {
  if (overlay && document.body.contains(overlay)) return overlay;
  injectStyle(STYLE_ID, CSS);
  // 注意：CSS 自定义属性必须用 setProperty 写入（style 对象无法直接赋值 --i）
  const tris = TRIGRAMS.map((ch, i) => {
    const node = el('span', { class: 'cw-tri' }, [ch]);
    node.style.setProperty('--i', String(i));
    return node;
  });
  const elems = ELEMENTS.map((e, i) => {
    const node = el('span', { class: 'cw-elem' }, [e.ch]);
    node.style.setProperty('--i', String(i));
    node.style.color = e.color;
    return node;
  });
  const r8 = el('div', { class: 'cw-ring cw-r8' }, tris);
  const r5 = el('div', { class: 'cw-ring cw-r5' }, elems);
  const wheel = el('div', { class: 'cw-wheel' }, [
    el('div', { class: 'cw-glow' }),
    r8,
    r5,
    el('div', { class: 'cw-core' }, ['☯']),
  ]);
  subEl = el('div', { class: 'cw-sub', text: '' });
  const panel = el('div', { class: 'cw-panel' }, [
    wheel,
    el('div', { class: 'cw-label', text: DEFAULT_LABEL }),
    subEl,
  ]);
  overlay = el('div', { class: 'cw-overlay', 'aria-hidden': 'true' }, [panel]);
  document.body.append(overlay);
  return overlay;
}

function doShow() {
  showTimer = null;
  if (visible) return;
  const o = ensureMounted();
  visible = true;
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  // 触发过渡
  requestAnimationFrame(() => o.classList.add('cw-on'));
}

function doHide() {
  hideTimer = null;
  if (!overlay || !visible) return;
  visible = false;
  overlay.classList.remove('cw-on');
}

function begin(label = '') {
  count += 1;
  if (label) { ensureMounted(); if (subEl) subEl.textContent = String(label); }
  else if (count === 1) { ensureMounted(); if (subEl) subEl.textContent = ''; }
  if (count === 1 && !showTimer && !visible) showTimer = setTimeout(doShow, DEFAULT_DELAY);
}

function end() {
  count = Math.max(0, count - 1);
  if (count > 0) return;
  if (showTimer) { clearTimeout(showTimer); showTimer = null; }
  if (visible) hideTimer = setTimeout(doHide, 180);
}

export const computeWheel = {
  begin,
  end,
  start: begin,
  stop: end,
  /** 立即显示（跳过延迟），用于已知的长时间任务 */
  force(label = '') {
    begin(label);
    if (showTimer) { clearTimeout(showTimer); showTimer = null; }
    doShow();
  },
  /** 包裹异步任务，自动开始与结束 */
  async with(label, fn) {
    begin(label);
    try { return await fn(); } finally { end(); }
  },
  get active() { return count > 0; },
};

export default computeWheel;
