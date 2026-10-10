#!/usr/bin/env node
/**
 * 离线一键启动：自带 ffmpeg + 本地 PNG 占位出图 + 电影工厂主服务
 *
 * 为什么需要它：
 *   主服务默认的 placeholder 出图产出 SVG；Windows 上常见的 ffmpeg essentials
 *   构建不含 librsvg，无法把 SVG 转成视频。这个入口把「本地 PNG 占位出图服务」
 *   和「自带 ffmpeg」一起拉起来，关键帧直接是 PNG，后面的运镜、成片、质检全通。
 *
 * 用法：
 *   node scripts/start-offline.mjs
 *   PORT=8799 node scripts/start-offline.mjs
 *   LOCAL_IMAGE_SERVICE=off node scripts/start-offline.mjs   # 只启动主服务
 *
 * 默认地址：
 *   工厂界面    http://127.0.0.1:8788/
 *   本地出图    http://127.0.0.1:8790/generate
 */

import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BUNDLED_BIN = path.join(ROOT, 'bin', 'ffmpeg');
const FFMPEG_BIN = path.join(BUNDLED_BIN, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');

if (fs.existsSync(FFMPEG_BIN)) {
  const parts = (process.env.PATH || '').split(path.delimiter);
  if (!parts.includes(BUNDLED_BIN)) {
    process.env.PATH = `${BUNDLED_BIN}${path.delimiter}${process.env.PATH || ''}`;
  }
  console.log(`[offline] 已启用自带 ffmpeg：${BUNDLED_BIN}`);
} else {
  console.warn('[offline] 未找到自带 ffmpeg，将由系统 PATH 决定；关键帧/成片/质检可能不可用');
}

// 开发/演示默认关闭定时排产，避免后台自动触发生产；显式设置 FACTORY_SCHEDULER=on 可恢复。
if (!process.env.FACTORY_SCHEDULER) {
  process.env.FACTORY_SCHEDULER = 'off';
  console.log('[offline] 定时排产默认关闭（FACTORY_SCHEDULER=on 可开启）');
}

const IMAGE_HOST = process.env.LOCAL_IMAGE_HOST || '127.0.0.1';
const IMAGE_PORT = Number(process.env.LOCAL_IMAGE_PORT || 8790);
const IMAGE_URL = `http://${IMAGE_HOST}:${IMAGE_PORT}`;

let imageChild = null;
let stopping = false;

async function imageServiceReady() {
  try {
    const res = await fetch(`${IMAGE_URL}/health`, { signal: AbortSignal.timeout(1200) });
    if (!res.ok) return false;
    const body = await res.json();
    return body?.service === 'local-image-service' && body?.ok === true;
  } catch {
    return false;
  }
}

function stopImageService() {
  if (stopping) return;
  stopping = true;
  if (imageChild && !imageChild.killed) {
    try { imageChild.kill(); } catch { /* 退出路径不抛错 */ }
  }
  imageChild = null;
}

async function ensureImageService() {
  if (process.env.LOCAL_IMAGE_SERVICE === 'off') {
    console.log('[offline] LOCAL_IMAGE_SERVICE=off，跳过本地 PNG 出图服务');
    return;
  }
  if (await imageServiceReady()) {
    console.log(`[offline] 本地 PNG 出图服务已在运行：${IMAGE_URL}`);
    return;
  }
  const entry = path.join(HERE, 'local-image-service.js');
  if (!fs.existsSync(entry)) {
    console.warn('[offline] 缺少 scripts/local-image-service.js，跳过本地 PNG 出图服务');
    return;
  }
  imageChild = spawn(process.execPath, [entry], {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      LOCAL_IMAGE_HOST: IMAGE_HOST,
      LOCAL_IMAGE_PORT: String(IMAGE_PORT),
    },
  });
  imageChild.on('exit', (code, signal) => {
    if (!stopping && code !== null && code !== 0) {
      console.warn(`[offline] 本地 PNG 出图服务异常退出：code=${code} signal=${signal || '-'}`);
    }
    imageChild = null;
  });
  for (let i = 0; i < 40; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (await imageServiceReady()) {
      console.log(`[offline] 本地 PNG 出图服务已就绪：${IMAGE_URL}`);
      return;
    }
  }
  console.warn('[offline] 本地 PNG 出图服务 10 秒内未就绪，继续启动主服务');
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, stopImageService);
}
process.on('exit', stopImageService);

await ensureImageService();
console.log('[offline] 启动电影工厂主服务…');
await import(pathToFileURL(path.join(ROOT, 'server.js')).href);
