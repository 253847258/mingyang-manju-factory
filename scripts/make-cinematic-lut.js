#!/usr/bin/env node
// 生成「青橙电影感」3D LUT（.cube），供 ffmpeg lut3d 使用。
// 特点：暗部偏青、高光偏暖、轻微 S 曲线、黑白端点不压死。
// 用法：node scripts/make-cinematic-lut.js [--size 33] [--out data/luts/filmic-teal-orange.cube]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SIZE = Number(process.argv.includes('--size') ? process.argv[process.argv.indexOf('--size') + 1] : 33);
const OUT = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1]
  : path.join(ROOT, 'data', 'luts', 'filmic-teal-orange.cube');

const clamp01 = (v, lo = 0.008, hi = 0.992) => Math.min(hi, Math.max(lo, v));
const smooth = (v) => v * v * (3 - 2 * v);

export function gradePixel(r, g, b) {
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  // 轻度 S 曲线 + 对比
  const s = (x) => clamp01(0.5 + (smooth(x) - 0.5) * 1.08);
  let R = s(r), G = s(g), B = s(b);
  const shadow = (1 - luma) ** 2;
  const highlight = luma ** 2;
  // 暗部偏青：减红、加蓝；高光偏暖：加红、减蓝
  R = clamp01(R - 0.020 * shadow + 0.045 * highlight);
  G = clamp01(G + 0.008 * shadow + 0.010 * highlight);
  B = clamp01(B + 0.035 * shadow - 0.025 * highlight);
  return [R, G, B];
}

export function buildCube(size = SIZE) {
  const n = Math.max(2, Math.min(65, Math.trunc(size)));
  const lines = [
    'TITLE "filmic-teal-orange"',
    `LUT_3D_SIZE ${n}`,
    'DOMAIN_MIN 0.0 0.0 0.0',
    'DOMAIN_MAX 1.0 1.0 1.0',
    '',
  ];
  for (let bi = 0; bi < n; bi += 1) {
    for (let gi = 0; gi < n; gi += 1) {
      for (let ri = 0; ri < n; ri += 1) {
        const [r, g, b] = gradePixel(ri / (n - 1), gi / (n - 1), bi / (n - 1));
        lines.push(`${r.toFixed(6)} ${g.toFixed(6)} ${b.toFixed(6)}`);
      }
    }
  }
  return lines.join('\n') + '\n';
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const cube = buildCube(SIZE);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, cube, 'utf8');
  const n = Number(/LUT_3D_SIZE (\d+)/.exec(cube)[1]);
  console.log(`已生成：${OUT}`);
  console.log(`尺寸：${n}³ = ${n * n * n} 条`);
}
