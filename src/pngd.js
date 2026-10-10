// 纯 Node PNG 工具（plain text module）
//
// 用途：
//  1) 让「占位（placeholder）出图」直接产出 PNG —— 因为 src/video.js 明确只接受栅格图
//     （/\.(png|jpe?g|webp|bmp|gif|tiff?)$/i），SVG 会导致本地运镜与拼图断链。
//  2) 九宫格合成：ffmpeg 不可用时，用纯 JS 兜底把多张 PNG 拼成一张。
//
// 只用 node:zlib，无任何外部依赖。

import fs from 'node:fs';
import zlib from 'node:zlib';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'latin1');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

// rgba: Buffer(width*height*4)，filter 固定 0（无损且实现简单）
export function encodePng({ width, height, rgba }) {
  const w = Math.max(1, Math.round(Number(width) || 1));
  const h = Math.max(1, Math.round(Number(height) || 1));
  const src = rgba && rgba.length >= w * h * 4 ? rgba : Buffer.alloc(w * h * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y += 1) {
    raw[y * (stride + 1)] = 0;
    src.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 6 });
  return Buffer.concat([PNG_SIG, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// 只支持 bit depth 8 的常见 PNG（灰度/RGB/灰度+alpha/RGBA）——覆盖 ffmpeg 与自带编码器的输出。
export function decodePng(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length < 8 || b.readUInt32BE(0) !== 0x89504e47) throw new Error('不是有效的 PNG');
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = 6;
  let bitDepth = 8;
  let interlace = 0;
  const idatParts = [];
  while (pos + 8 <= b.length) {
    const len = b.readUInt32BE(pos);
    const type = b.toString('latin1', pos + 4, pos + 8);
    const data = b.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idatParts.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`暂不支持 ${bitDepth} 位 PNG`);
  if (interlace !== 0) throw new Error('暂不支持隔行 PNG');
  const channelsOf = { 0: 1, 2: 3, 4: 2, 6: 4 };
  const channels = channelsOf[colorType];
  if (!channels) throw new Error(`暂不支持的颜色类型 ${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idatParts));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  const prev = Buffer.alloc(stride);
  const cur = Buffer.alloc(stride);
  let rp = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[rp];
    rp += 1;
    raw.copy(cur, 0, rp, rp + stride);
    rp += stride;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? cur[x - channels] : 0;
      const bb = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = cur[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += bb;
      else if (filter === 3) v += (a + bb) >> 1;
      else if (filter === 4) v += paeth(a, bb, c);
      cur[x] = v & 0xff;
    }
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      if (colorType === 0) {
        const g = cur[x];
        out[o] = g; out[o + 1] = g; out[o + 2] = g; out[o + 3] = 255;
      } else if (colorType === 2) {
        out[o] = cur[x * 3]; out[o + 1] = cur[x * 3 + 1]; out[o + 2] = cur[x * 3 + 2]; out[o + 3] = 255;
      } else if (colorType === 4) {
        const g = cur[x * 2];
        out[o] = g; out[o + 1] = g; out[o + 2] = g; out[o + 3] = cur[x * 2 + 1];
      } else {
        out[o] = cur[x * 4]; out[o + 1] = cur[x * 4 + 1]; out[o + 2] = cur[x * 4 + 2]; out[o + 3] = cur[x * 4 + 3];
      }
    }
    cur.copy(prev, 0, 0, stride);
  }
  return { width, height, rgba: out };
}

// ---- 5x7 点阵字（ASCII）。小写映射到同形大写，非 ASCII 跳过。 ----
const FONT = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '_': ['00000', '00000', '00000', '00000', '00000', '00000', '11111'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  ',': ['00000', '00000', '00000', '00000', '01100', '01100', '01000'],
  ':': ['00000', '01100', '01100', '00000', '01100', '01100', '00000'],
  '/': ['00001', '00010', '00010', '00100', '01000', '01000', '10000'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

function hashHue(seedStr) {
  let h = 2166136261;
  const s = String(seedStr || '');
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % 360;
}

function hslToRgb(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

function drawText(rgba, w, h, text, x, y, scale, color) {
  const s = Math.max(1, Math.round(scale));
  let cx = x;
  for (const rawCh of String(text || '')) {
    const ch = rawCh >= 'a' && rawCh <= 'z' ? rawCh.toUpperCase() : rawCh;
    const glyph = FONT[ch];
    if (!glyph) { cx += 6 * s; continue; }
    for (let gy = 0; gy < 7; gy += 1) {
      for (let gx = 0; gx < 5; gx += 1) {
        if (glyph[gy][gx] !== '1') continue;
        for (let sy = 0; sy < s; sy += 1) {
          for (let sx = 0; sx < s; sx += 1) {
            const px = cx + gx * s + sx;
            const py = y + gy * s + sy;
            if (px < 0 || py < 0 || px >= w || py >= h) continue;
            const o = (py * w + px) * 4;
            rgba[o] = color[0]; rgba[o + 1] = color[1]; rgba[o + 2] = color[2]; rgba[o + 3] = 255;
          }
        }
      }
    }
    cx += 6 * s;
  }
  return cx;
}

function wrap(text, max) {
  const out = [];
  let cur = '';
  for (const ch of String(text || '')) {
    cur += ch;
    if (cur.length >= max) { out.push(cur); cur = ''; }
  }
  if (cur) out.push(cur);
  return out.length ? out : [''];
}

// 简化占位图：渐变底 + 光晕 + 角标 + 多行标签（ASCII 用点阵字，非 ASCII 跳过）
export function renderPlaceholderPng({
  width = 768, height = 1024, label = '', actorId = '', kind = '', variant = '',
  prompt = '', negative = '', seed = null,
} = {}) {
  const w = Math.max(64, Math.round(Number(width) || 768));
  const h = Math.max(64, Math.round(Number(height) || 1024));
  const rgba = Buffer.alloc(w * h * 4);
  const hue = hashHue(actorId || prompt || label);
  const hue2 = (hue + 40) % 360;
  const c1 = hslToRgb(hue, 0.55, 0.20);
  const c2 = hslToRgb(hue2, 0.50, 0.12);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const t = (x / w) * 0.5 + (y / h) * 0.5;
      const o = (y * w + x) * 4;
      rgba[o] = Math.round(c1[0] + (c2[0] - c1[0]) * t);
      rgba[o + 1] = Math.round(c1[1] + (c2[1] - c1[1]) * t);
      rgba[o + 2] = Math.round(c1[2] + (c2[2] - c1[2]) * t);
      rgba[o + 3] = 255;
    }
  }
  // 中心光晕
  const gx0 = w / 2; const gy0 = h * 0.3; const gr = Math.max(w, h) * 0.42;
  const glow = hslToRgb(hue, 0.9, 0.72);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const d = Math.hypot(x - gx0, y - gy0) / gr;
      if (d >= 1) continue;
      const a = (1 - d) * 0.42;
      const o = (y * w + x) * 4;
      rgba[o] = Math.round(rgba[o] * (1 - a) + glow[0] * a);
      rgba[o + 1] = Math.round(rgba[o + 1] * (1 - a) + glow[1] * a);
      rgba[o + 2] = Math.round(rgba[o + 2] * (1 - a) + glow[2] * a);
    }
  }
  const white = [226, 232, 240];
  const dim = [148, 163, 184];
  const scaleMain = Math.max(2, Math.round(w / 220));
  let y = Math.round(h * 0.08);
  y = drawText(rgba, w, h, label || kind || 'PLACEHOLDER', Math.round(w * 0.06), y, scaleMain, white) ? y + 8 * scaleMain + 12 : y;
  const scaleSm = Math.max(1, Math.round(w / 420));
  drawText(rgba, w, h, `${actorId || 'unassigned'}  ${kind}${variant ? '/' + variant : ''}  ${w}x${h}${seed != null ? '  seed=' + seed : ''}`, Math.round(w * 0.06), y, scaleSm, dim);
  y += 8 * scaleSm + 16;
  for (const line of wrap(prompt, 46).slice(0, 13)) {
    drawText(rgba, w, h, line, Math.round(w * 0.06), y, scaleSm, dim);
    y += 8 * scaleSm + 4;
  }
  y += 8;
  for (const line of wrap(negative, 50).slice(0, 4)) {
    drawText(rgba, w, h, `NEG ${line}`, Math.round(w * 0.06), y, scaleSm, [120, 140, 165]);
    y += 8 * scaleSm + 4;
  }
  drawText(rgba, w, h, 'OFFLINE PLACEHOLDER PNG', Math.round(w * 0.06), h - Math.max(24, h * 0.04), scaleSm, white);
  return encodePng({ width: w, height: h, rgba });
}

// ---- 纯 JS 拼图兜底（ffmpeg 不可用时）----
function sampleNearest(img, sx, sy) {
  const x = Math.max(0, Math.min(img.width - 1, Math.round(sx)));
  const y = Math.max(0, Math.min(img.height - 1, Math.round(sy)));
  const o = (y * img.width + x) * 4;
  return [img.rgba[o], img.rgba[o + 1], img.rgba[o + 2], img.rgba[o + 3]];
}

export function composeSheetJS({ files = [], cols = 3, cell = 512, gap = 12, background = [12, 14, 20] } = {}) {
  const images = files.map((f) => decodePng(fs.readFileSync(f)));
  const n = images.length;
  if (!n) throw new Error('没有可拼合的图片');
  const rows = Math.ceil(n / cols);
  const tile = cell + gap * 2;
  const width = cols * tile;
  const height = rows * tile;
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    rgba[i * 4] = background[0];
    rgba[i * 4 + 1] = background[1];
    rgba[i * 4 + 2] = background[2];
    rgba[i * 4 + 3] = 255;
  }
  images.forEach((img, i) => {
    const cx = (i % cols) * tile + gap;
    const cy = Math.floor(i / cols) * tile + gap;
    const scale = Math.min(cell / img.width, cell / img.height);
    const dw = Math.round(img.width * scale);
    const dh = Math.round(img.height * scale);
    const ox = cx + Math.floor((cell - dw) / 2);
    const oy = cy + Math.floor((cell - dh) / 2);
    for (let y = 0; y < dh; y += 1) {
      for (let x = 0; x < dw; x += 1) {
        const px = ox + x;
        const py = oy + y;
        if (px < 0 || py < 0 || px >= width || py >= height) continue;
        const [r, g, b, a] = sampleNearest(img, x / scale, y / scale);
        const o = (py * width + px) * 4;
        const alpha = a / 255;
        rgba[o] = Math.round(r * alpha + rgba[o] * (1 - alpha));
        rgba[o + 1] = Math.round(g * alpha + rgba[o + 1] * (1 - alpha));
        rgba[o + 2] = Math.round(b * alpha + rgba[o + 2] * (1 - alpha));
        rgba[o + 3] = 255;
      }
    }
  });
  return encodePng({ width, height, rgba });
}
