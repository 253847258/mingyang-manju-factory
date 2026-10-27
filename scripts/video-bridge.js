#!/usr/bin/env node
// 火山方舟 Seedance 视频适配桥（8792）
//
// 解决三件事：
//  1) 时长档位：系统按镜头时长传（如 3s），Seedance 2.5 要求 [4,30] → 这里钳制
//  2) 有无首帧：无关键帧时模板会传空 image_url → 这里剔除，自动退化为文生视频
//  3) 错误透传：厂商的 SetLimitExceeded / 真人审核错误原样返回，交给系统分类
//
// 协议（与系统 generic-http 视频后端对接）：
//  POST /generate  → 创建任务，返回方舟原始 JSON（含 id / status）
//  GET  /tasks/:id → 查询任务，返回方舟原始 JSON（含 status / content.video_url）
//  GET  /health

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CONFIG = process.env.FACTORY_CONFIG || path.join(ROOT, 'config', 'config.json');
const PORT = Number(process.env.VIDEO_BRIDGE_PORT || 8793);
const ARK_BASE = process.env.ARK_BASE || 'https://ark.cn-beijing.volces.com/api/v3';
const CREATE = `${ARK_BASE}/contents/generations/tasks`;
const DEFAULT_MODEL = process.env.ARK_VIDEO_MODEL || 'doubao-seedance-2-5-260628';

function apiKey() {
  if (process.env.ARK_API_KEY) return process.env.ARK_API_KEY;
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8'))?.video?.generic?.apiKey || ''; } catch { return ''; }
}

export function normalizeVideoBody(body = {}) {
  const model = String(body.model || DEFAULT_MODEL);
  let duration = Math.round(Number(body.duration));
  if (!Number.isFinite(duration)) duration = 5;
  duration = Math.min(30, Math.max(4, duration)); // Seedance 2.5: [4,30]；3s 镜头 → 4s
  const content = (Array.isArray(body.content) ? body.content : [])
    .filter((x) => !(x?.type === 'image_url' && !String(x?.image_url?.url || '').trim()));
  return { model, content, ratio: String(body.ratio || 'adaptive'), duration };
}

// 把厂商错误翻译成系统能看懂、用户能执行的中文提示
export function translateArkError(status, text) {
  const raw = String(text || '');
  if (/SetLimitExceeded|Safe Experience Mode/i.test(raw)) {
    return {
      status: 409,
      body: { error: { code: 'SetLimitExceeded', message: '账号额度上限：该视频模型已被「Safe Experience Mode」暂停。请到火山方舟控制台 → 模型开通 → 调整或关闭体验模式上限后重试' } },
    };
  }
  if (/SensitiveContentDetected|PrivacyInformation|real person/i.test(raw)) {
    return {
      status: 409,
      body: { error: { code: 'ContentModeration', message: '内容审核未通过：首帧可能被识别为真人。请改用动漫化/风格化人设，或换一张非真人首帧' } },
    };
  }
  if (/InvalidParameter/i.test(raw)) {
    return { status: 400, body: { error: { code: 'InvalidParameter', message: `视频参数不合法：${raw.slice(0, 240)}` } } };
  }
  return null;
}

const send = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return send(res, 200, { ok: true, service: 'video-bridge', port: PORT, model: DEFAULT_MODEL, hasKey: !!apiKey() });
  }
  const key = apiKey();
  if (!key) return send(res, 500, { ok: false, error: '未配置方舟 API Key（config.video.generic.apiKey）' });

  if (req.method === 'POST' && req.url === '/generate') {
    let raw = '';
    for await (const chunk of req) { raw += chunk; if (raw.length > 4 * 1024 * 1024) return send(res, 413, { ok: false, error: '请求体过大' }); }
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { return send(res, 400, { ok: false, error: '请求体不是合法 JSON' }); }
    const payload = normalizeVideoBody(body);
    if (!payload.content.length) return send(res, 400, { ok: false, error: '缺少提示词内容' });
    try {
      const r = await fetch(CREATE, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify(payload),
      });
      const text = await r.text();
      const tr = translateArkError(r.status, text);
      if (tr) return send(res, tr.status, tr.body);
      res.writeHead(r.status, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(text);
    } catch (e) {
      return send(res, 502, { ok: false, error: `创建任务失败：${e.message}` });
    }
  }

  const m = req.url.match(/^\/tasks\/([^/?]+)$/);
  if (req.method === 'GET' && m) {
    try {
      const r = await fetch(`${CREATE}/${encodeURIComponent(m[1])}`, { headers: { authorization: `Bearer ${key}` } });
      const text = await r.text();
      const tr = translateArkError(r.status, text);
      if (tr) return send(res, tr.status, tr.body);
      res.writeHead(r.status, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(text);
    } catch (e) {
      return send(res, 502, { ok: false, error: `查询任务失败：${e.message}` });
    }
  }

  send(res, 404, { ok: false, error: 'not found' });
});

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  server.listen(PORT, '127.0.0.1', () => {
    console.log('==========================================================');
    console.log('  Seedance 视频适配桥 已启动');
    console.log(`  地址： http://127.0.0.1:${PORT}/generate`);
    console.log(`  模型： ${DEFAULT_MODEL}`);
    console.log('  能力：时长 4–30s 钳制 / 空首帧剔除 / 厂商错误透传');
    console.log('==========================================================');
  });
}
