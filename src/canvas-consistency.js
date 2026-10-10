// 画布一致性闸门（plain text module）
//
// 说明：现有的 consistency.js#scoreConsistency 是「按镜头渲染记录」打分的，
// 只能吃 script 的真实 shots（内部按 shot.id 找 keyframe），无法直接对任意图片打分。
// 因此这里用同一套方法（8×8 灰度 aHash + 组内离群）在纯明文里实现一份，
// 直接对演员图片 / 节点 refImages 打分，产出「标红清单」，只告警不阻断出片。

import fs from 'node:fs';
import { all, get, resolveAsset } from './db.js';
import { decodePng } from './pngd.js';

export const CONSISTENCY_THRESHOLD = 0.34;

function safeJson(value, fallback) {
  try {
    if (value === null || value === undefined || value === '') return fallback;
    if (typeof value === 'object') return value;
    return JSON.parse(value);
  } catch { return fallback; }
}

const RASTER_RE = /\.(png|jpe?g|webp|bmp|gif|tiff?)$/i;

function isRaster(file) {
  return RASTER_RE.test(String(file || ''));
}

// 8×8 灰度 aHash（64 bit）
function aHash(rgba, w, h) {
  const gw = 8;
  const gh = 8;
  const gray = new Float64Array(gw * gh);
  for (let by = 0; by < gh; by += 1) {
    for (let bx = 0; bx < gw; bx += 1) {
      const x0 = Math.floor((bx * w) / gw);
      const x1 = Math.max(x0 + 1, Math.floor(((bx + 1) * w) / gw));
      const y0 = Math.floor((by * h) / gh);
      const y1 = Math.max(y0 + 1, Math.floor(((by + 1) * h) / gh));
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const o = (y * w + x) * 4;
          sum += 0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2];
          n += 1;
        }
      }
      gray[by * gw + bx] = n ? sum / n : 0;
    }
  }
  let total = 0;
  for (let i = 0; i < gray.length; i += 1) total += gray[i];
  const mean = total / gray.length;
  const bits = new Uint8Array(gw * gh);
  for (let i = 0; i < gray.length; i += 1) bits[i] = gray[i] >= mean ? 1 : 0;
  return bits;
}

function hamming(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) d += 1;
  return d / a.length;
}

let sharpMod = null;
let sharpTried = false;
async function loadSharp() {
  if (!sharpTried) {
    sharpTried = true;
    try { sharpMod = (await import('sharp')).default; } catch { sharpMod = null; }
  }
  return sharpMod;
}

function bitsFromGray(gray) {
  let total = 0;
  for (let i = 0; i < gray.length; i += 1) total += gray[i];
  const mean = total / gray.length;
  const bits = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i += 1) bits[i] = gray[i] >= mean ? 1 : 0;
  return bits;
}

// 优先用 sharp（可选依赖，支持 PNG/JPEG/WebP），不可用时回退到纯 JS PNG 解码器
async function readHash(file) {
  const abs = resolveAsset(file) || file;
  if (!abs || !fs.existsSync(abs)) return null;
  const sharp = await loadSharp();
  if (sharp) {
    try {
      const out = await sharp(abs).resize(8, 8, { fit: 'fill' }).greyscale().raw().toBuffer({ resolveWithObject: true });
      return { file, hash: bitsFromGray(out.data.subarray(0, out.info.width * out.info.height)) };
    } catch { /* 回退纯 JS */ }
  }
  const buf = fs.readFileSync(abs);
  const isPng = buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47;
  if (!isPng) return null; // 纯 JS 解码器只处理 PNG
  const img = decodePng(buf);
  return { file, hash: aHash(img.rgba, img.width, img.height) };
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function scoreFiles(files, threshold) {
  const list = (files || []).filter(isRaster);
  if (list.length < 3) {
    return { ok: true, images: list.length, scored: 0, low: false, outliers: [], note: '图片不足 3 张，暂不打分' };
  }
  const hashed = [];
  let unreadable = 0;
  for (const f of list) {
    const h = await readHash(f);
    if (h) hashed.push(h); else unreadable += 1;
  }
  if (hashed.length < 3) {
    return { ok: true, images: list.length, scored: hashed.length, low: false, outliers: [], unreadable, note: '可读栅格图不足 3 张（没装 sharp 时只支持 PNG）' };
  }
  // 中位哈希（逐位多数投票）作为「组中心」
  const center = new Uint8Array(64);
  for (let b = 0; b < 64; b += 1) {
    let ones = 0;
    for (const h of hashed) ones += h.hash[b];
    center[b] = ones * 2 >= hashed.length ? 1 : 0;
  }
  const dists = hashed.map((h) => hamming(h.hash, center));
  const med = median(dists);
  const mad = median(dists.map((d) => Math.abs(d - med)));
  const cutoff = Math.max(threshold, Math.min(0.5, med + 3 * mad));
  const outliers = hashed
    .map((h, i) => ({ file: h.file, distance: Number(dists[i].toFixed(4)) }))
    .filter((x) => x.distance > cutoff);
  return {
    ok: true,
    images: list.length,
    scored: hashed.length,
    unreadable,
    centerDistance: Number(med.toFixed(4)),
    cutoff: Number(cutoff.toFixed(4)),
    low: outliers.length > 0,
    outliers,
  };
}

export async function scoreActor(actorId, { threshold = CONSISTENCY_THRESHOLD } = {}) {
  const rows = all("SELECT * FROM actor_images WHERE actor_id = ? AND status = 'done' ORDER BY is_primary DESC, created_at DESC", actorId);
  const files = rows.map((r) => r.file_path || r.file_url).filter(Boolean);
  const r = await scoreFiles(files, threshold);
  return { ...r, scope: 'actor', id: actorId, images: files.length };
}

export async function scoreNode(node, { threshold = CONSISTENCY_THRESHOLD } = {}) {
  if (node.kind === 'actor') return scoreActor(node.actor_id, { threshold });
  const data = safeJson(node.data, {}) || {};
  const refs = Array.isArray(data.refImages) ? data.refImages : [];
  const files = refs.map((x) => (typeof x === 'string' ? x : x?.file)).filter(Boolean);
  const r = await scoreFiles(files, threshold);
  return { ...r, scope: node.kind, id: node.id, images: files.length };
}

export async function scoreCanvas(canvasId, { threshold = CONSISTENCY_THRESHOLD } = {}) {
  const canvas = get('SELECT * FROM canvases WHERE id = ?', canvasId) || { id: canvasId };
  const nodes = all('SELECT * FROM canvas_nodes WHERE canvas_id = ?', canvasId);
  const results = [];
  for (const node of nodes) {
    const kind = String(node.kind || 'actor');
    if (!['actor', 'scene', 'item'].includes(kind)) continue;
    if (kind === 'actor' && !node.actor_id) continue;
    const r = await scoreNode(node, { threshold });
    if (!r.images) continue;
    results.push({
      id: node.id,
      kind,
      actorId: node.actor_id || null,
      title: node.title || '',
      locked: Number(node.locked) === 1,
      images: r.images,
      scored: r.scored,
      cutoff: r.cutoff ?? null,
      low: Boolean(r.low),
      outliers: r.outliers || [],
      note: r.note || null,
    });
  }
  const lowNodes = results.filter((x) => x.low);
  return {
    ok: true,
    canvasId,
    canvasName: canvas.name || '',
    threshold,
    summary: {
      checked: results.length,
      low: lowNodes.length,
      images: results.reduce((n, x) => n + x.images, 0),
      outliers: lowNodes.reduce((n, x) => n + x.outliers.length, 0),
    },
    nodes: results,
    low: lowNodes,
    note: lowNodes.length
      ? `${lowNodes.length} 个节点存在明显离群图（超过一致性判定线 ${threshold}），建议一键重跑。`
      : '未发现明显离群图。',
  };
}
