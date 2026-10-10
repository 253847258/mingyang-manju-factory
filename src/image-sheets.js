// 人物 / 环境 九宫格（plain text module）
//
// - CHARACTER_SHEET_CELLS：固定 9 格「专业设定表」（定妆 + 三视角 + 三表情 + 服饰 + 手部）
// - ENVIRONMENT_SHEET_CELLS：3 视角 × 3 时段 = 9 格
// - planSheet：产出每格的 kind/variant/prompt/negative/尺寸（不触库、不出图）
// - composeSheet：把 9 张图拼成一张 3×3 PNG；优先 ffmpeg（xstack），不可用时用 pngd 纯 JS 兜底
//
// 提示词复用现有 prompts.js 的 buildPrompt 与 data/styles.js 的风格包，保证与批量定妆一致。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildPrompt } from './prompts.js';
import { styleById, BASE_QUALITY } from './data/styles.js';
import { composeSheetJS } from './pngd.js';

export const SHEET_COLS = 3;

export const CHARACTER_SHEET_CELLS = [
  { key: 'keyart', label: '定妆主图', kind: 'full', variant: 'keyart' },
  { key: 'front', label: '正面全身', kind: 'angle', variant: 'front' },
  { key: 'left', label: '侧面全身', kind: 'angle', variant: 'left' },
  { key: 'back', label: '背面全身', kind: 'angle', variant: 'back' },
  { key: 'neutral', label: '平静', kind: 'expression', variant: 'neutral' },
  { key: 'smile', label: '微笑', kind: 'expression', variant: 'smile' },
  { key: 'angry', label: '愤怒', kind: 'expression', variant: 'angry' },
  { key: 'costume', label: '服饰细节', kind: 'costume', variant: 'embroidery' },
  { key: 'hand', label: '手部特写', kind: 'gesture', variant: 'open-palm' },
];

const ENV_VIEWS = [
  { key: 'wide', label: '全景', token: 'wide establishing shot showing the whole location and its scale' },
  { key: 'medium', label: '中景', token: 'medium shot of the location, key props and furniture readable' },
  { key: 'close', label: '特写', token: 'close-up detail shot of the location, material and small props' },
];

const ENV_TIMES = [
  { key: 'day', label: '白天', token: 'bright daylight, clear natural sunlight, soft shadows' },
  { key: 'dusk', label: '黄昏', token: 'golden hour dusk, warm rim light, long shadows, orange sky' },
  { key: 'night', label: '夜晚', token: 'night time, moody artificial lighting, deep shadows, practical lights' },
];

export const ENVIRONMENT_SHEET_CELLS = ENV_VIEWS.flatMap((v) => ENV_TIMES.map((t) => ({
  key: `${v.key}-${t.key}`,
  label: `${v.label}·${t.label}`,
  view: v.key,
  time: t.key,
  viewToken: v.token,
  timeToken: t.token,
})));

function pickRatio(styleId, ratio) {
  return ratio || styleById(styleId)?.ratio || '3:4';
}

function ratioToSize(ratio) {
  const m = String(ratio || '3:4').split(':').map(Number);
  const w = m[0] > 0 ? m[0] : 3;
  const h = m[1] > 0 ? m[1] : 4;
  const base = 1024;
  if (w >= h) return { width: base, height: Math.round((base * h) / w) };
  return { width: Math.round((base * w) / h), height: base };
}

// 环境节点 data → 英文提示词（场景/地点/天气/氛围 + 风格包）
function envPromptBits(scene = {}) {
  const bits = [];
  const push = (v) => { const s = String(v || '').trim(); if (s) bits.push(s); };
  push(scene.title);
  push(scene.desc);
  if (scene.timeOfDay) push(String(scene.timeOfDay));
  if (scene.weather) push(String(scene.weather));
  if (Array.isArray(scene.tags) && scene.tags.length) push(scene.tags.join(', '));
  if (scene.mood) push(String(scene.mood));
  if (scene.palette) push(String(scene.palette));
  return bits.join(', ');
}

// 计划：返回 9 格任务（不写库、不出图）
export function planSheet({ sheetKind, actor = null, scene = null, styleId = '', ratio = '' } = {}) {
  const kind = sheetKind === 'environment' ? 'environment' : 'character';
  const sid = styleId || (actor && actor.style_id) || scene?.styleId || 'cinematic-real';
  if (kind === 'character') {
    if (!actor) throw new Error('人物九宫格缺少 actor');
    const r = pickRatio(sid, ratio || actor.ratio);
    const { width, height } = ratioToSize(r);
    const cells = CHARACTER_SHEET_CELLS.map((cell) => {
      const built = buildPrompt({ actor, styleId: sid, kind: cell.kind, variant: cell.variant, ratio: r });
      return {
        key: cell.key,
        label: cell.label,
        kind: cell.kind,
        variant: cell.variant,
        prompt: built.positive,
        negative: built.negative,
        ratio: r,
        width: built.width || width,
        height: built.height || height,
      };
    });
    return { ok: true, sheetKind: kind, styleId: sid, ratio: r, count: cells.length, cols: SHEET_COLS, cells };
  }

  if (!scene) throw new Error('环境九宫格缺少 scene 节点数据');
  const style = styleById(sid);
  const r = pickRatio(sid, ratio || style?.ratio || '16:9');
  const { width, height } = ratioToSize(r);
  const base = envPromptBits(scene);
  const cells = ENVIRONMENT_SHEET_CELLS.map((cell) => {
    const positive = [
      style?.head || '',
      `${cell.viewToken}, ${cell.timeToken}`,
      base,
      'environment concept art, cinematic composition, atmospheric perspective, consistent art direction',
      BASE_QUALITY,
      style?.tail || '',
    ].filter(Boolean).join(', ');
    return {
      key: cell.key,
      label: cell.label,
      view: cell.view,
      time: cell.time,
      prompt: positive,
      negative: style?.negative || '',
      ratio: r,
      width,
      height,
    };
  });
  return { ok: true, sheetKind: kind, styleId: sid, ratio: r, count: cells.length, cols: SHEET_COLS, cells };
}

function hasFfmpeg(bin = 'ffmpeg') {
  try { return spawnSync(bin, ['-version'], { stdio: 'ignore' }).status === 0; } catch { return false; }
}

// 用 ffmpeg 把 N 张图拼成网格（等尺寸 tile，自带 gap 与外边距）
export function composeSheetFfmpeg({ files = [], cols = SHEET_COLS, cell = 512, gap = 12, outPath, bin = 'ffmpeg' } = {}) {
  if (!outPath) throw new Error('缺少输出路径');
  const tile = cell + gap * 2;
  const args = ['-y'];
  for (const f of files) args.push('-i', f);
  const parts = files.map((_, i) => `[${i}:v]scale=${cell}:${cell}:force_original_aspect_ratio=decrease,pad=${tile}:${tile}:(ow-iw)/2:(oh-ih)/2:color=0x0c0e14[v${i}]`);
  const inputs = files.map((_, i) => `[v${i}]`).join('');
  const positions = [];
  for (let r = 0; r < Math.ceil(files.length / cols); r += 1) {
    for (let c = 0; c < cols; c += 1) {
      if (r * cols + c >= files.length) break;
      const xs = c === 0 ? '0' : Array.from({ length: c }, (_, k) => `w${k}`).join('+');
      // 所有 tile 等尺寸：每下一行累加一个 tile 的高度（h0）
      const ys = r === 0 ? '0' : Array.from({ length: r }, () => 'h0').join('+');
      positions.push(`${xs}_${ys}`);
    }
  }
  const filter = `${parts.join(';')};${inputs}xstack=inputs=${files.length}:layout=${positions.join('|')}[out]`;
  args.push('-filter_complex', filter, '-map', '[out]', '-frames:v', '1', outPath);
  const r = spawnSync(bin, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg 拼图失败：${(r.stderr || '').split('\n').slice(-2).join(' ').trim() || '未知错误'}`);
  return outPath;
}

export function composeSheet({ files = [], cols = SHEET_COLS, cell = 512, gap = 12, outPath, preferFfmpeg = true, bin = 'ffmpeg' } = {}) {
  const list = (files || []).filter((f) => f && fs.existsSync(f));
  if (!list.length) throw new Error('没有可拼合的图片');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  if (preferFfmpeg && hasFfmpeg(bin)) {
    try {
      composeSheetFfmpeg({ files: list, cols, cell, gap, outPath, bin });
      return { ok: true, file: outPath, engine: 'ffmpeg', count: list.length, cols };
    } catch { /* 落到纯 JS 兜底 */ }
  }
  const buf = composeSheetJS({ files: list, cols, cell, gap });
  fs.writeFileSync(outPath, buf);
  return { ok: true, file: outPath, engine: 'js', count: list.length, cols };
}
