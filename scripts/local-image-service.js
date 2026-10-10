#!/usr/bin/env node
/**
 * 本地 PNG 占位出图服务（离线零依赖外部接口）
 *
 * 为什么需要它：
 *   placeholder 出图后端默认产出 SVG；下游的本地 ffmpeg 运镜链路在 Windows
 *   官方 essentials 构建里没有 librsvg，无法解码 SVG。这个服务把占位图直接
 *   渲染成 PNG，通过工厂已有的 generic-http 出图后端接入，整条
 *   「关键帧 -> 视频 -> 成片 -> 质检」链路即可在裸 Windows 上离线跑通。
 *
 * 用法：
 *   node scripts/local-image-service.js
 *   LOCAL_IMAGE_PORT=8790 node scripts/local-image-service.js
 *
 * 协议：
 *   GET  /health           -> { ok, service, port }
 *   POST /generate         -> { ok, image: "data:image/png;base64,...", width, height }
 *   其余 POST 路径同样接受，便于直接填入通用 HTTP 出图后端。
 */

import http from 'node:http';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

const PORT = Number(process.env.LOCAL_IMAGE_PORT || 8790);
const HOST = process.env.LOCAL_IMAGE_HOST || '127.0.0.1';
const MAX_BODY = 24 * 1024 * 1024;

const clamp = (n, min, max) => Math.min(max, Math.max(min, Number(n) || min));

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function hashOf(text) {
  return createHash('sha256').update(String(text || '')).digest('hex');
}

function palette(seed) {
  const hue = parseInt(hashOf(seed).slice(0, 4), 16) % 360;
  const second = (hue + 42) % 360;
  return {
    hue,
    bgA: `hsl(${hue} 38% 12%)`,
    bgB: `hsl(${second} 32% 20%)`,
    accent: `hsl(${(hue + 180) % 360} 70% 62%)`,
    dim: `hsl(${(hue + 180) % 360} 30% 72%)`,
  };
}

function wrapText(text, limit) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return ['（无提示词）'];
  const lines = [];
  let line = '';
  for (const ch of raw) {
    if (ch === ' ' && line.length >= limit * 0.6) {
      lines.push(line.trim());
      line = '';
      if (lines.length >= 14) break;
      continue;
    }
    line += ch;
    if (line.length >= limit) {
      const cut = ch === ' ' && /[a-zA-Z0-9]/.test(line.at(-2) || '') ? line.lastIndexOf(' ') : -1;
      if (cut > limit * 0.5) {
        lines.push(line.slice(0, cut).trim());
        line = line.slice(cut + 1);
      } else {
        lines.push(line.trim());
        line = '';
      }
      if (lines.length >= 14) break;
    }
  }
  if (line && lines.length < 14) lines.push(line.trim());
  return lines.length ? lines : ['（无提示词）'];
}

function pickPrompt(body) {
  return body.prompt || body.text || body.input || body.positive || body.message || '';
}

function pickSize(body) {
  const raw = String(body.size || body.parameters?.size || '').replace('x', '*');
  const pair = raw.split('*').map(Number).filter(Number.isFinite);
  let width = Number(body.width) || pair[0] || 768;
  let height = Number(body.height) || pair[1] || 1152;
  if (width > height * 1.25) {
    [width, height] = [Math.min(width, 1280), Math.min(height, 720)];
  }
  width = clamp(width, 320, 1600);
  height = clamp(height, 320, 1600);
  return { width: Math.round(width), height: Math.round(height) };
}

function buildSvg({ prompt, negative, width, height, model }) {
  const colors = palette(`${prompt}|${model}|${width}x${height}`);
  const fontSize = Math.max(20, Math.round(Math.min(width, height) * 0.038));
  const labelSize = Math.max(13, Math.round(fontSize * 0.58));
  const lines = wrapText(prompt, Math.max(14, Math.floor(width / (fontSize * 0.72))));
  const startY = Math.round(height * 0.34);
  const lineHeight = Math.round(fontSize * 1.55);
  const textBlock = lines.map((line, i) =>
    `<text x="${Math.round(width * 0.08)}" y="${startY + i * lineHeight}" font-family="Microsoft YaHei, Noto Sans CJK SC, sans-serif" font-size="${fontSize}" fill="#ffffff">${escapeXml(line)}</text>`
  ).join('');
  const neg = negative ? escapeXml(String(negative).slice(0, 90)) : '无';
  const shortModel = escapeXml(String(model || 'local-image').slice(0, 48));
  const hash = hashOf(prompt).slice(0, 8).toUpperCase();

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${colors.bgA}"/>
      <stop offset="1" stop-color="${colors.bgB}"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${colors.accent}" stop-opacity="0.95"/>
      <stop offset="1" stop-color="${colors.accent}" stop-opacity="0.15"/>
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#bg)"/>
  <rect x="${Math.round(width * 0.045)}" y="${Math.round(height * 0.04)}" width="${Math.round(width * 0.91)}" height="${Math.round(height * 0.92)}" rx="18" fill="none" stroke="${colors.accent}" stroke-opacity="0.42" stroke-width="2"/>
  <rect x="${Math.round(width * 0.045)}" y="${Math.round(height * 0.04)}" width="${Math.round(width * 0.91)}" height="${Math.round(height * 0.012)}" rx="6" fill="url(#accent)"/>
  <text x="${Math.round(width * 0.08)}" y="${Math.round(height * 0.115)}" font-family="Microsoft YaHei, Noto Sans CJK SC, sans-serif" font-size="${labelSize}" fill="${colors.dim}" letter-spacing="1">LOCAL PNG PLACEHOLDER · OFFLINE</text>
  <text x="${Math.round(width * 0.92)}" y="${Math.round(height * 0.115)}" text-anchor="end" font-family="Consolas, monospace" font-size="${labelSize}" fill="${colors.dim}">${hash}</text>
  <circle cx="${Math.round(width * 0.12)}" cy="${Math.round(height * 0.22)}" r="${Math.round(width * 0.022)}" fill="${colors.accent}"/>
  <text x="${Math.round(width * 0.17)}" y="${Math.round(height * 0.235)}" font-family="Microsoft YaHei, Noto Sans CJK SC, sans-serif" font-size="${Math.round(labelSize * 1.25)}" fill="#ffffff">占位关键帧</text>
  ${textBlock}
  <line x1="${Math.round(width * 0.08)}" y1="${Math.round(height * 0.84)}" x2="${Math.round(width * 0.92)}" y2="${Math.round(height * 0.84)}" stroke="${colors.accent}" stroke-opacity="0.35" stroke-width="1"/>
  <text x="${Math.round(width * 0.08)}" y="${Math.round(height * 0.885)}" font-family="Microsoft YaHei, Noto Sans CJK SC, sans-serif" font-size="${labelSize}" fill="${colors.dim}">model: ${shortModel}</text>
  <text x="${Math.round(width * 0.08)}" y="${Math.round(height * 0.925)}" font-family="Microsoft YaHei, Noto Sans CJK SC, sans-serif" font-size="${labelSize}" fill="${colors.dim}">negative: ${neg}</text>
  <text x="${Math.round(width * 0.08)}" y="${Math.round(height * 0.965)}" font-family="Microsoft YaHei, Noto Sans CJK SC, sans-serif" font-size="${labelSize}" fill="${colors.dim}">${width} × ${height} · 此图由本地服务生成，不调用任何外部模型</text>
</svg>`;
}

async function render(body) {
  const { width, height } = pickSize(body);
  const prompt = pickPrompt(body);
  const svg = buildSvg({
    prompt,
    negative: body.negative || body.negative_prompt || '',
    width,
    height,
    model: body.model,
  });
  const png = await sharp(Buffer.from(svg)).png({ compressionLevel: 6 }).toBuffer();
  return {
    ok: true,
    image: `data:image/png;base64,${png.toString('base64')}`,
    width,
    height,
    mime: 'image/png',
    backend: 'local-image-placeholder',
    promptHash: hashOf(prompt).slice(0, 16),
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve({ prompt: text });
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const send = (code, payload) => {
    const body = JSON.stringify(payload);
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    });
    res.end(body);
  };

  if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/health'))) {
    return send(200, { ok: true, service: 'local-image-service', port: PORT, mode: 'png-placeholder' });
  }

  if (req.method !== 'POST') {
    return send(405, { ok: false, error: '只接受 GET /health 与 POST 出图请求' });
  }

  try {
    const started = Date.now();
    const body = await readBody(req);
    const result = await render(body);
    result.elapsedMs = Date.now() - started;
    console.log(`[local-image] ${result.width}x${result.height} ${result.promptHash} ${result.elapsedMs}ms`);
    send(200, result);
  } catch (err) {
    console.error('[local-image] 渲染失败：', err.message);
    send(500, { ok: false, error: err.message || '本地占位图渲染失败' });
  }
});

server.listen(PORT, HOST, () => {
  console.log('==========================================================');
  console.log('  本地 PNG 占位出图服务 已启动');
  console.log(`  地址： http://${HOST}:${PORT}/generate`);
  console.log('  模式： 离线 PNG（供 generic-http 出图后端接入）');
  console.log('==========================================================');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
