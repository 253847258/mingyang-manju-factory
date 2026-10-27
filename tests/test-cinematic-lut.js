#!/usr/bin/env node
// 电影感 LUT：结构、范围、黑白端点、幂等
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const { buildCube } = await import('../scripts/make-cinematic-lut.js');
let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`  PASS ${n}${e ? ` -> ${e}` : ''}`); } else { fail++; console.error(`  FAIL ${n}${e ? ` -> ${e}` : ''}`); } };

const cube = buildCube(17);
const lines = cube.trim().split('\n');
ok('头部包含 LUT_3D_SIZE 17', cube.includes('LUT_3D_SIZE 17'), '');
const dataLines = lines.filter((l) => /^\d/.test(l) && l.trim().split(/\s+/).length === 3);
ok('条目数 = 17³ = 4913', dataLines.length === 4913, `entries=${dataLines.length}`);
const values = dataLines.map((l) => l.split(/\s+/).map(Number));
ok('全部数值在 [0,1]', values.every((v) => v.length === 3 && v.every((x) => Number.isFinite(x) && x >= 0 && x <= 1)), '');
const black = values[0]; const white = values[values.length - 1];
ok('黑端点不完全死黑', black.every((x) => x >= 0.001 && x <= 0.05), black.join(','));
ok('白端点不完全死白', white.every((x) => x >= 0.95 && x <= 0.999), white.join(','));
ok('重复生成内容一致（幂等）', buildCube(17) === cube, '');
console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);
