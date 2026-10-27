#!/usr/bin/env node
// 文生图桥接（验证/过渡用，免费、无 Key）
//
// 作用：把系统的 generic-http 出图协议，转成 Pollinations 的图片 URL 拉取，
// 返回 { ok, image: dataURL }，让「真文生图」先跑通。
// 生产请优先用火山方舟 Seedream（质量/合规/稳定性更好）。
//
// 用法：node scripts/text-to-image-bridge.js          # 默认 8791
//      IMAGE_BRIDGE_PORT=8791 node scripts/text-to-image-bridge.js

import http from 'node:http';

const PORT = Number(process.env.IMAGE_BRIDGE_PORT || 8791);
const HOST = process.env.IMAGE_BRIDGE_HOST || '127.0.0.1';
const MODEL = process.env.IMAGE_BRIDGE_MODEL || 'flux';
const TIMEOUT_MS = Number(process.env.IMAGE_BRIDGE_TIMEOUT || 120000);
const DEFAULT_STYLE = process.env.IMAGE_BRIDGE_STYLE || '';
const CINEMATIC_SUFFIX = ', cinematic film still, photorealistic, natural skin texture, subtle film grain, shallow depth of field, ARRI Alexa 35mm, dramatic key light, color graded, 24fps motion feel';

const clamp = (n, a, b) => Math.min(b, Math.max(a, Number(n) || a));

async function generate({ prompt, width, height, seed, model, style }) {
  const w = clamp(width, 256, 1536);
  const h = clamp(height, 256, 1536);
  const s = Number.isFinite(Number(seed)) ? Number(seed) : Math.floor(Math.random() * 1e9);
  const useStyle = style || DEFAULT_STYLE;
  const finalPrompt = useStyle === 'cinematic' ? `${String(prompt || 'cinematic scene')}${CINEMATIC_SUFFIX}` : String(prompt || 'cinematic scene');
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(finalPrompt)}`
    + `?width=${w}&height=${h}&seed=${s}&nologo=true&model=${encodeURIComponent(model || MODEL)}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`文生图服务返回 ${res.status}`);
  const ct = res.headers.get('content-type') || '';
  if (!/image\//i.test(ct)) throw new Error(`文生图服务返回的不是图片（${ct}）`);
  let buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('文生图服务返回空图片');

  // 去掉右下角的服务水印：裁掉底部 7%，再按目标尺寸输出
  try {
    const sharp = (await import('sharp')).default;
    const meta = await sharp(buf).metadata();
    const keep = Math.max(1, Math.floor((meta.height || h) * 0.93));
    buf = await sharp(buf)
      .extract({ left: 0, top: 0, width: meta.width || w, height: keep })
      .resize(w, h, { fit: 'cover' })
      .jpeg({ quality: 92 })
      .toBuffer();
  } catch { /* sharp 不可用时保留原图 */ }

  return { ok: true, image: `data:image/jpeg;base64,${buf.toString('base64')}`, width: w, height: h, seed: s, style: useStyle || 'default', backend: `pollinations-${model || MODEL}` };
}

const server = http.createServer(async (req, res) => {
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
  if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true, service: 'text-to-image-bridge', port: PORT, model: MODEL });
  if (req.method !== 'POST') return send(405, { ok: false, error: '只接受 POST' });
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 2 * 1024 * 1024) { send(413, { ok: false, error: '请求体过大' }); return; } }
  let body = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch { return send(400, { ok: false, error: '请求体不是合法 JSON' }); }
  try {
    const r = await generate(body);
    send(200, r);
  } catch (e) {
    send(502, { ok: false, error: `文生图失败：${e.message}` });
  }
});

server.listen(PORT, HOST, () => {
  console.log('==========================================================');
  console.log('  真文生图桥接服务 已启动');
  console.log(`  地址： http://${HOST}:${PORT}/generate`);
  console.log(`  引擎： Pollinations · ${MODEL}（免费，无需 Key）`);
  console.log('  说明：验证/过渡用；生产请切火山方舟 Seedream');
  console.log('==========================================================');
});
