#!/usr/bin/env node
/**
 * 多角度角色圣经生成器。
 *
 * 用法：
 *   node scripts/character-sheet.js --name "陆行舟" --desc "35岁中国男演员，黑色风衣" \
 *     --out data/images/character-sheets
 *
 * 可选：
 *   --bridge http://127.0.0.1:8791/generate
 *   --ref ./reference.jpg
 *   --dry-run
 *
 * 说明：当前出图桥接协议只接收 prompt/width/height/seed/style。参考图路径会写入
 * manifest，供后续支持图生图或人工复核时追溯，不会伪装成已参与本次推理。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DEFAULT_BRIDGE = 'http://127.0.0.1:8791/generate';
const DEFAULT_OUT = 'data/images/character-sheets';
const DEFAULT_WIDTH = 768;
const DEFAULT_HEIGHT = 1024;
const DEFAULT_STYLE = 'cinematic';
const REQUEST_TIMEOUT_MS = 120_000;

const JOB_DEFINITIONS = [
  {
    id: 'angle-front',
    kind: 'angle',
    angle: '正面',
    angleCode: 'front',
    expression: '平静',
    expressionCode: 'calm',
    view: '正面全身视角，人物正对镜头，面部、肩线、躯干和服装完整可见',
  },
  {
    id: 'angle-three-quarter',
    kind: 'angle',
    angle: '3/4侧',
    angleCode: 'three-quarter',
    expression: '平静',
    expressionCode: 'calm',
    view: '人物向右转约 45 度的 3/4 侧全身视角，面部轮廓与服装侧面结构清晰',
  },
  {
    id: 'angle-side',
    kind: 'angle',
    angle: '侧面',
    angleCode: 'side',
    expression: '平静',
    expressionCode: 'calm',
    view: '正侧面全身视角，完整展示鼻梁、下颌、发型侧面轮廓和服装侧面剪裁',
  },
  {
    id: 'angle-back',
    kind: 'angle',
    angle: '背面',
    angleCode: 'back',
    expression: '平静',
    expressionCode: 'calm',
    view: '背面全身视角，展示后脑发型、肩背轮廓、服装背面结构和整体身高比例',
  },
  {
    id: 'expression-calm',
    kind: 'expression',
    angle: '正面',
    angleCode: 'front',
    expression: '平静',
    expressionCode: 'calm',
    view: '正面胸部以上近景，表情平静克制，眼神自然看向镜头',
  },
  {
    id: 'expression-angry',
    kind: 'expression',
    angle: '正面',
    angleCode: 'front',
    expression: '愤怒',
    expressionCode: 'angry',
    view: '正面胸部以上近景，表情愤怒但克制，眉峰收紧、眼神锐利，不夸张变形',
  },
  {
    id: 'expression-sad',
    kind: 'expression',
    angle: '正面',
    angleCode: 'front',
    expression: '悲伤',
    expressionCode: 'sad',
    view: '正面胸部以上近景，表情悲伤内敛，眉眼低垂、嘴角轻微下压，不夸张变形',
  },
];

const USAGE = `多角度角色圣经生成器

必填：
  --name <角色名>
  --desc <中文或英文角色描述>

可选：
  --out <输出根目录>       默认 ${DEFAULT_OUT}
  --bridge <地址>          默认 ${DEFAULT_BRIDGE}
  --ref <参考图路径>       记录到 manifest（当前桥接为纯文生图协议）
  --width <像素>           默认 ${DEFAULT_WIDTH}
  --height <像素>          默认 ${DEFAULT_HEIGHT}
  --style <风格>           默认 ${DEFAULT_STYLE}
  --seed <整数>            指定基础种子
  --dry-run                只打印计划，不请求、不落盘
  --help                   显示帮助`;

function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function parseInteger(value, flag, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${flag} 必须是 ${min} 到 ${max} 之间的整数`);
  }
  return n;
}

function parseArgs(argv) {
  const opts = {
    name: '',
    description: '',
    out: DEFAULT_OUT,
    bridge: DEFAULT_BRIDGE,
    referenceImage: null,
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    style: DEFAULT_STYLE,
    seed: null,
    dryRun: false,
    help: false,
  };

  const valueFlags = new Set([
    '--name', '--desc', '--out', '--bridge', '--ref', '--reference',
    '--width', '--height', '--style', '--seed',
  ]);

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      opts.dryRun = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
      continue;
    }
    if (!valueFlags.has(arg)) throw new Error(`未知参数：${arg}`);

    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${arg} 缺少值`);
    i += 1;

    if (arg === '--name') opts.name = cleanText(value);
    else if (arg === '--desc') opts.description = cleanText(value);
    else if (arg === '--out') opts.out = cleanText(value);
    else if (arg === '--bridge') opts.bridge = cleanText(value);
    else if (arg === '--ref' || arg === '--reference') opts.referenceImage = cleanText(value);
    else if (arg === '--width') opts.width = parseInteger(value, '--width', 256, 1536);
    else if (arg === '--height') opts.height = parseInteger(value, '--height', 256, 1536);
    else if (arg === '--style') opts.style = cleanText(value);
    else if (arg === '--seed') opts.seed = parseInteger(value, '--seed', 0, 4_294_967_295);
  }

  if (opts.help) return opts;
  if (!opts.name) throw new Error('缺少 --name 角色名');
  if (!opts.description) throw new Error('缺少 --desc 角色描述');
  if (!opts.out) throw new Error('--out 不能为空');
  if (!opts.bridge) throw new Error('--bridge 不能为空');
  if (!opts.style) throw new Error('--style 不能为空');
  return opts;
}

function normalizeBridge(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`--bridge 地址无效：${input}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('--bridge 只支持 http 或 https 地址');
  }
  if (!url.pathname || url.pathname === '/') url.pathname = '/generate';
  return url.href;
}

function slugify(value) {
  const base = String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^\p{L}\p{N}-]/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)
    .replace(/-$/g, '');
  if (base) return base;
  return `character-${createHash('sha256').update(String(value || '')).digest('hex').slice(0, 8)}`;
}

function stableSeed(name, description) {
  return Number.parseInt(
    createHash('sha256').update(`${name}\n${description}`).digest('hex').slice(0, 8),
    16,
  );
}

function buildPrompt({ name, description, job }) {
  return [
    '角色圣经定妆照（character reference sheet）',
    `角色名：${name}`,
    `固定角色设定：${description}`,
    `镜头与姿态：${job.view}`,
    `表情：${job.expression}`,
    '跨镜一致性硬约束：所有画面必须是同一个人物，脸型、五官比例、年龄、肤色、发型、服装剪裁、材质和颜色完全一致，不得换脸、改服装或增加无关配饰',
    '单人、居中构图、干净的中性摄影棚背景、真实皮肤纹理、电影级柔光、写实摄影、高清细节',
    '不要文字、水印、边框、拼图、多人、肢体重复或变形',
  ].join('。') + '。';
}

function buildJobs(opts, bridge) {
  const baseSeed = opts.seed ?? stableSeed(opts.name, opts.description);
  return JOB_DEFINITIONS.map((job, index) => ({
    ...job,
    index: index + 1,
    prompt: buildPrompt({
      name: opts.name,
      description: opts.description,
      job,
    }),
    width: opts.width,
    height: opts.height,
    style: opts.style,
    seed: (baseSeed + index * 104729) % 4_294_967_296,
    bridge,
  }));
}

function imageExtension(mimeType) {
  const subtype = String(mimeType).toLowerCase().split('/')[1] || 'png';
  if (subtype === 'jpeg' || subtype === 'jpg') return 'jpg';
  if (subtype === 'svg+xml') return 'svg';
  return subtype.replace(/[^a-z0-9]/g, '') || 'png';
}

function decodeImageDataUrl(dataUrl) {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(String(dataUrl || ''));
  if (!match) throw new Error('桥接返回的 image 不是合法图片 dataURL');
  const mimeType = match[1].toLowerCase();
  const base64 = match[2].replace(/\s+/g, '');
  if (!base64) throw new Error('桥接返回的图片数据为空');
  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length) throw new Error('桥接返回的图片数据为空');
  return { buffer, mimeType, extension: imageExtension(mimeType) };
}

async function requestImage(job) {
  let response;
  try {
    response = await fetch(job.bridge, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: job.prompt,
        width: job.width,
        height: job.height,
        seed: job.seed,
        style: job.style,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new Error('文生图桥接请求超时');
    }
    throw new Error(`无法连接文生图桥接：${error?.message || error}`);
  }

  const raw = await response.text();
  let body = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    // 非 JSON 响应统一在下面给出可读错误。
  }

  if (!response.ok) {
    const detail = cleanText(body?.error || raw).slice(0, 300);
    throw new Error(`桥接返回 HTTP ${response.status}${detail ? `：${detail}` : ''}`);
  }
  if (!body || body.ok === false) {
    const detail = cleanText(body?.error || raw).slice(0, 300);
    throw new Error(`桥接生成失败${detail ? `：${detail}` : ''}`);
  }
  if (typeof body.image !== 'string' || !body.image) {
    throw new Error('桥接响应缺少 image dataURL');
  }
  return body;
}

function readableError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /[\u3400-\u9fff]/u.test(message) ? message : `生成失败：${message}`;
}

async function writeManifest(manifestPath, manifest) {
  const tempPath = `${manifestPath}.tmp`;
  await fsp.writeFile(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await fsp.rename(tempPath, manifestPath);
}

async function run(opts, logger = console) {
  const bridge = normalizeBridge(opts.bridge);
  const slug = slugify(opts.name);
  const outputRoot = path.resolve(opts.out);
  const sheetDir = path.join(outputRoot, slug);
  const manifestPath = path.join(sheetDir, 'manifest.json');
  const jobs = buildJobs(opts, bridge);

  let referenceImage = null;
  if (opts.referenceImage) {
    referenceImage = path.resolve(opts.referenceImage);
    let stat;
    try {
      stat = await fsp.stat(referenceImage);
    } catch {
      throw new Error(`参考图不存在：${referenceImage}`);
    }
    if (!stat.isFile()) throw new Error(`参考图不是文件：${referenceImage}`);
  }

  const plan = {
    dryRun: opts.dryRun,
    name: opts.name,
    slug,
    description: opts.description,
    referenceImage,
    bridge,
    outputRoot,
    sheetDir,
    manifestPath,
    width: opts.width,
    height: opts.height,
    style: opts.style,
    total: jobs.length,
    items: jobs.map((job) => ({
      index: job.index,
      id: job.id,
      kind: job.kind,
      angle: job.angle,
      angleCode: job.angleCode,
      expression: job.expression,
      expressionCode: job.expressionCode,
      prompt: job.prompt,
      width: job.width,
      height: job.height,
      seed: job.seed,
      style: job.style,
    })),
  };

  if (opts.dryRun) {
    logger.log(JSON.stringify(plan, null, 2));
    return { dryRun: true, total: jobs.length, succeeded: 0, failed: 0, manifestPath };
  }

  await fsp.mkdir(sheetDir, { recursive: true });
  const items = [];

  for (const job of jobs) {
    const base = {
      index: job.index,
      id: job.id,
      kind: job.kind,
      angle: job.angle,
      angleCode: job.angleCode,
      expression: job.expression,
      expressionCode: job.expressionCode,
      prompt: job.prompt,
      width: job.width,
      height: job.height,
      seed: job.seed,
      style: job.style,
    };

    try {
      const response = await requestImage(job);
      const image = decodeImageDataUrl(response.image);
      const filename = `${String(job.index).padStart(2, '0')}-${job.id}.${image.extension}`;
      const absolutePath = path.join(sheetDir, filename);
      await fsp.writeFile(absolutePath, image.buffer);

      items.push({
        ...base,
        ok: true,
        file: filename,
        path: absolutePath,
        mimeType: image.mimeType,
        bytes: image.buffer.length,
      });
      logger.log(`[${job.index}/${jobs.length}] ${job.angle} · ${job.expression}：已生成 ${filename}`);
    } catch (error) {
      const message = readableError(error);
      items.push({ ...base, ok: false, file: null, error: message });
      logger.error(`[${job.index}/${jobs.length}] ${job.angle} · ${job.expression}：失败，已记录并继续（${message}）`);
    }
  }

  const succeeded = items.filter((item) => item.ok).length;
  const failed = items.length - succeeded;
  const manifest = {
    version: 1,
    task: 'character-sheet',
    ok: failed === 0,
    name: opts.name,
    slug,
    description: opts.description,
    referenceImage,
    referenceImageUsed: false,
    bridge,
    generatedAt: new Date().toISOString(),
    settings: {
      width: opts.width,
      height: opts.height,
      style: opts.style,
    },
    counts: {
      total: items.length,
      succeeded,
      failed,
    },
    items,
  };

  await writeManifest(manifestPath, manifest);
  logger.log(`完成：成功 ${succeeded} / ${items.length}，失败 ${failed}`);
  logger.log(`manifest：${manifestPath}`);

  return { dryRun: false, total: items.length, succeeded, failed, manifestPath, manifest };
}

async function main() {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      console.log(USAGE);
      return;
    }
    const result = await run(opts);
    if (!result.dryRun && result.failed > 0) process.exitCode = 1;
  } catch (error) {
    console.error(`错误：${error instanceof Error ? error.message : error}`);
    console.error('使用 --help 查看用法。');
    process.exitCode = 2;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) main();

export {
  JOB_DEFINITIONS,
  buildJobs,
  buildPrompt,
  decodeImageDataUrl,
  normalizeBridge,
  parseArgs,
  run,
  slugify,
};
