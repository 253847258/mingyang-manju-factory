// ComfyUI · MiniMax H3 视频引擎测试（离线假实例，不需要任何外部服务）
// 覆盖：/object_info 预检、模板自动选择（首帧驱动/文生）、关键帧 SVG→PNG 光栅化上传、
//       turbo LoRA 与分辨率映射、超时中断、模型缺失提示、503 探测、各种坑的报错文案
// 用法：node tests/test-comfy.js
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const DATA_TMP = path.join(os.tmpdir(), `factory-comfy-data-${Date.now()}`);
const DB = path.join(os.tmpdir(), `factory-comfy-${Date.now()}.db`);
const CFG = path.join(os.tmpdir(), `factory-comfy-config-${Date.now()}.json`);
process.env.FACTORY_DATA_DIR = DATA_TMP;
process.env.FACTORY_DB = DB;
process.env.FACTORY_CONFIG = CFG;
fs.mkdirSync(DATA_TMP, { recursive: true });

const { migrate } = await import('../src/db.js');
const { saveConfig } = await import('../src/config.js');
const { generateVideo, probeVideoBackend, videoBackendStatus } = await import('../src/video.js');
const comfy = await import('../src/comfy.js');
const { DATA_DIR } = await import('../src/db.js');

migrate();

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? `  ${extra}` : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? `  ${extra}` : ''}`); }
};
let skipped = 0;
const skip = (name, why = '') => { skipped++; console.log(`  ⤼ [跳过] ${name}${why ? `  ${why}` : ''}`); };

// 宿主能力探测：自带 ffmpeg 是 essentials 构建，可能不含 SVG 解码器（librsvg）
const SVG_DECODER_OK = (() => {
  try {
    const out = spawnSync('ffmpeg', ['-hide_banner', '-decoders'], { encoding: 'utf8' });
    return /\bsvg\b|librsvg/i.test(`${out.stdout || ''}${out.stderr || ''}`);
  } catch { return false; }
})();
const NO_SVG_WHY = '（本机 ffmpeg 未编译 SVG 解码器；占位出图已改 PNG，不再依赖这条路径）';

// ---------------- 假 ComfyUI 实例（尽量照抄真实 /object_info 形态） ----------------
const TURBO_LORA = 'minimax_h3_fl2v_lightx2v_turbo_4step_v0.1_comfy.safetensors';
const state = {
  imageCapable: true,       // MiniMaxH3ImageToVideo 是否声明首帧输入
  imageRequired: false,     // 首帧是否为必填（有些实例不给图不让跑）
  dropNode: null,           // 让预检命中 missing_node_type
  unetFiles: ['minimax_h3_fl2va_pruned_int8_convrot.safetensors'],
  statsStatus: 200,
  neverFinish: false,
  historyEmptyTimes: 1,     // 前 N 次 /history 返回空（模拟排队）
  nodeErrors200: false,     // 让 /prompt 返回「HTTP 200 但 node_errors 非空」（官方文档写明最常见的坑）
  uploads: [], prompts: [], interrupts: 0, historyPolls: 0, submitted: null,
};

function buildObjectInfo() {
  const oi = {
    UNETLoader: { input: { required: { unet_name: [state.unetFiles, {}], weight_dtype: [['default', 'fp8_e4m3fn'], {}] } } },
    CLIPLoader: { input: { required: { clip_name: [['qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors'], {}], type: [['minimax'], {}], device: [['default'], {}] } } },
    VAELoader: { input: { required: { vae_name: [['minimax_h3_video_vae_fp16.safetensors', 'minimax_h3_audio_vae_fp32.safetensors'], {}] } } },
    MiniMaxH3ImageToVideo: {
      input: state.imageRequired
        ? { required: { image: ['IMAGE'], prompt: ['CONDITIONING'], width: ['INT'], height: ['INT'], length: ['INT'], clip: ['CLIP'], vae: ['VAE'] } }
        : {
          required: { prompt: ['CONDITIONING'], width: ['INT'], height: ['INT'], length: ['INT'], clip: ['CLIP'], vae: ['VAE'] },
          optional: state.imageCapable ? { image: ['IMAGE'] } : {},
        },
    },
    ResolutionSelector: { input: { required: { aspect_ratio: [['16:9 (Widescreen)', '9:16 (Portrait)', '1:1 (Square)', '4:3 (Standard)'], {}], megapixels: ['FLOAT', { default: 0.4 }], multiple: [['32'], {}] } } },
    ComfyMathExpression: { input: { required: { expression: ['STRING'], 'values.a': ['FLOAT'] } } },
    PrimitiveFloat: { input: { required: { value: ['FLOAT', { default: 5 }] } } },
    PrimitiveStringMultiline: { input: { required: { value: ['STRING', { default: '' }] } } },
    PrimitiveString: { input: { required: { value: ['STRING', { default: '' }] } } },
    PreviewAny: { input: { required: { source: ['*'] } } },
    ComfySwitchNode: { input: { required: { switch: ['BOOLEAN', { default: false }], on_false: ['*'], on_true: ['*'] } } },
    MiniMaxH3MemoryEfficientSageAttentionPatch: { input: { required: { model: ['MODEL'] } } },
    RAMCleanup: { input: { required: { clean_file_cache: ['BOOLEAN', { default: true }], clean_processes: ['BOOLEAN', { default: true }], clean_dlls: ['BOOLEAN', { default: true }], retry_times: ['INT', { default: 3 }], anything: ['*'] } } },
    VRAMCleanup: { input: { required: { input: ['*'], cleanup_mode: [['Cache Only', 'Full'], {}] } } },
    'Lora Loader Stack (rgthree)': {
      input: {
        required: {
          lora_01: [['None', TURBO_LORA], {}], strength_01: ['FLOAT', { default: 1 }],
          lora_02: [['None', TURBO_LORA], {}], strength_02: ['FLOAT', { default: 1 }],
          lora_03: [['None', TURBO_LORA], {}], strength_03: ['FLOAT', { default: 1 }],
          lora_04: [['None', TURBO_LORA], {}], strength_04: ['FLOAT', { default: 1 }],
          model: ['MODEL'], clip: ['CLIP'],
        },
      },
    },
    KSampler: {
      input: {
        required: {
          seed: ['INT', { default: 0 }], steps: ['INT', { default: 20 }], cfg: ['FLOAT', { default: 1 }],
          sampler_name: [['euler', 'dpmpp_2m'], {}], scheduler: [['simple', 'normal'], {}], denoise: ['FLOAT', { default: 1 }],
          model: ['MODEL'], positive: ['CONDITIONING'], negative: ['CONDITIONING'], latent_image: ['LATENT'],
        },
      },
    },
    ConditioningZeroOut: { input: { required: { conditioning: ['CONDITIONING'] } } },
    VAEDecode: { input: { required: { samples: ['LATENT'], vae: ['VAE'] } } },
    VAEDecodeAudio: { input: { required: { samples: ['LATENT'], vae: ['VAE'] } } },
    CreateVideo: { input: { required: { fps: ['INT', { default: 24 }], bit_depth: ['INT', { default: 8 }], images: ['IMAGE'], audio: ['AUDIO'] } } },
    SaveVideo: { input: { required: { filename_prefix: ['STRING', { default: 'video/x' }], format: [['auto', 'mp4'], {}], codec: [['auto', 'h264'], {}], video: ['VIDEO'] } } },
    LoadImage: { input: { required: { image: [['placeholder_first_frame.png'], {}] }, optional: { upload: ['IMAGEUPLOAD'] } } },
    H3_Promptor: {
      input: {
        required: {
          task_type: [['Auto'], {}], description: ['STRING'], duration: ['INT', { default: 5 }],
          reference_images: [['Auto'], {}], reference_videos: [['Auto'], {}], reference_audios: [['Auto'], {}],
          output_language: [['Chinese'], {}], provider: [['XLJ中转国内'], {}], api_key: ['STRING'],
          model_name: [['gemini-3.1-flash-lite-preview'], {}], temperature: ['FLOAT', { default: 0.7 }], max_tokens: ['INT', { default: 4096 }],
        },
      },
    },
  };
  if (state.dropNode) delete oi[state.dropNode];
  return oi;
}

const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(512, 7)]);

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (code, obj, type = 'application/json') => {
    const body = Buffer.isBuffer(obj) ? obj : Buffer.from(JSON.stringify(obj));
    res.writeHead(code, { 'content-type': type, 'content-length': body.length });
    res.end(body);
  };
  if (u.pathname === '/system_stats') {
    if (state.statsStatus !== 200) return send(state.statsStatus, '您的实例可能正在启动中，请稍后尝试重新访问', 'text/plain; charset=utf-8');
    return send(200, { system: { comfyui_version: '0.3.33' }, devices: [{ name: 'cuda:0 NVIDIA GeForce RTX 4090', vram_total: 27158118400 }] });
  }
  if (u.pathname === '/object_info') return send(200, buildObjectInfo());
  if (u.pathname === '/upload/image') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      const m = /filename="([^"]+)"/.exec(buf.toString('latin1'));
      const name = (m ? m[1] : 'upload.png').replace(/[^\w.\-]/g, '_');
      state.uploads.push({ name, size: buf.length, magic: buf.slice(buf.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47])), buf.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47])) + 4).toString('hex') });
      send(200, { name, subfolder: '', type: 'input' });
    });
    return;
  }
  if (u.pathname === '/prompt' && req.method === 'POST') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const { prompt } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const oi = buildObjectInfo();
      const nodeErrors = {};
      for (const [id, node] of Object.entries(prompt)) {
        const cls = oi[node.class_type];
        if (!cls) { nodeErrors[id] = { class_type: node.class_type, message: 'missing_node_type' }; continue; }
        const req2 = cls.input?.required || {};
        const miss = Object.keys(req2).filter((k) => node.inputs?.[k] === undefined && req2[k]?.[1]?.default === undefined);
        if (miss.length) nodeErrors[id] = { message: `required_input_missing: ${miss.join(',')}` };
      }
      if (Object.keys(nodeErrors).length) {
        // 官方 server.py 的行为：只要还有可执行的输出节点就入队并回 200，校验失败的节点放进 node_errors
        if (state.nodeErrors200) return send(200, { prompt_id: `p-${state.prompts.length + 1}`, node_errors: nodeErrors });
        return send(400, { error: { type: 'prompt_outputs_failed_validation' }, node_errors: nodeErrors });
      }
      state.submitted = prompt;
      state.prompts.push(prompt);
      state.historyPolls = 0;
      send(200, { prompt_id: `p-${state.prompts.length}` });
    });
    return;
  }
  if (u.pathname.startsWith('/history/')) {
    state.historyPolls++;
    if (state.neverFinish || state.historyPolls <= state.historyEmptyTimes) return send(200, {});
    return send(200, { [u.pathname.split('/').pop()]: { status: { status_str: 'success', completed: true }, outputs: { 92: { images: [{ filename: 'MiniMax_H3_test_00001_.mp4', subfolder: 'video', type: 'output' }] } } } });
  }
  if (u.pathname === '/view') return send(200, MP4, 'video/mp4');
  if (u.pathname === '/interrupt') { state.interrupts++; return send(200, {}); }
  send(404, { error: 'not found' });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

saveConfig({ video: { backend: 'comfyui-h3', comfy: { url: BASE, preflight: true, pollMs: 5, timeoutMs: 60000 } } });

const reset = () => { state.submitted = null; state.uploads = []; state.prompts = []; state.historyPolls = 0; state.neverFinish = false; state.historyEmptyTimes = 1; state.nodeErrors200 = false; comfy.clearObjectInfoCache(); };

// ---------------- 1. 内置模板与单元级能力 ----------------
console.log('\n【1】内置 H3 工作流模板');
ok('内置 t2v 模板存在且是 API 格式', fs.existsSync(comfy.BUILTIN_WORKFLOWS.t2v) && Object.values(JSON.parse(fs.readFileSync(comfy.BUILTIN_WORKFLOWS.t2v, 'utf8'))).every((n) => n.class_type && n.inputs));
ok('内置 i2v 模板存在且首帧接在 131.image', fs.existsSync(comfy.BUILTIN_WORKFLOWS.i2v) && JSON.stringify(JSON.parse(fs.readFileSync(comfy.BUILTIN_WORKFLOWS.i2v, 'utf8'))['131'].inputs.image) === '["148",0]');
ok('i2v 模板多出 LoadImage 节点（25 vs 24）', Object.keys(JSON.parse(fs.readFileSync(comfy.BUILTIN_WORKFLOWS.i2v, 'utf8'))).length === Object.keys(JSON.parse(fs.readFileSync(comfy.BUILTIN_WORKFLOWS.t2v, 'utf8'))).length + 1);
ok('比例挑选：9:16 → 9:16 (Portrait)', comfy.pickAspectRatio(['16:9 (Widescreen)', '9:16 (Portrait)'], '9:16') === '9:16 (Portrait)');
ok('比例挑选：1:1 → 1:1 (Square)', comfy.pickAspectRatio(['16:9 (Widescreen)', '1:1 (Square)'], '1:1') === '1:1 (Square)');
ok('比例挑选：21:9 无匹配 → null（不硬塞非法枚举）', comfy.pickAspectRatio(['16:9 (Widescreen)', '9:16 (Portrait)'], '21:9') === null);
ok('首帧字段探测：optional.image', comfy.detectImageInput({ input: { required: { prompt: ['CONDITIONING'] }, optional: { image: ['IMAGE'] } } }) === 'image');
ok('首帧字段探测：无字段 → null', comfy.detectImageInput({ input: { required: { prompt: ['CONDITIONING'] } } }) === null);

const tplWf = JSON.parse(fs.readFileSync(comfy.BUILTIN_WORKFLOWS.t2v, 'utf8'));
delete tplWf['115'].inputs.megapixels;
const preAuto = comfy.preflightComfyWorkflow(tplWf, buildObjectInfo());
ok('预检自动补全缺失必填项（megapixels 用 schema 默认值 0.4）', preAuto.ok && preAuto.autofilled.includes('115.megapixels') && tplWf['115'].inputs.megapixels === 0.4, `autofilled=${preAuto.autofilled.join(',')}`);

const noImg = JSON.parse(fs.readFileSync(comfy.BUILTIN_WORKFLOWS.i2v, 'utf8'));
state.imageCapable = false;
const preNoImg = comfy.preflightComfyWorkflow(noImg, buildObjectInfo());
ok('实例不接受 image 时给出「连线会被忽略」警告', preNoImg.warnings.some((w) => /不接受输入 image/.test(w)), preNoImg.warnings.find((w) => /image/.test(w)) || '(无)');
state.imageCapable = true;

const oiOk = buildObjectInfo();
ok('模板选择：有关键帧+实例支持 → i2v', comfy.pickComfyTemplate({ cfg: { video: { comfy: {} } }, objectInfo: oiOk, hasKeyframe: true }).kind === 'i2v');
ok('模板选择：无关键帧 → t2v', comfy.pickComfyTemplate({ cfg: { video: { comfy: {} } }, objectInfo: oiOk, hasKeyframe: false }).kind === 't2v');
state.imageCapable = false;
ok('模板选择：实例不支持首帧 → 自动回退 t2v 并说明原因', comfy.pickComfyTemplate({ cfg: { video: { comfy: {} } }, objectInfo: buildObjectInfo(), hasKeyframe: true }).kind === 't2v');
state.imageCapable = true;
comfy.clearObjectInfoCache();

console.log('\n【2】提示词优化节点强制关闭');
const swWf = JSON.parse(JSON.stringify(tplWf));
swWf['150'].inputs.switch = true;
ok('disablePromptorSwitch 关掉指向 H3_Promptor 的开关', comfy.disablePromptorSwitch(swWf) === true && swWf['150'].inputs.switch === false);

console.log('\n【3】关键帧光栅化（SVG → PNG）');
const svgDir = path.join(DATA_DIR, 'images', 'ASSET_TEST');
fs.mkdirSync(svgDir, { recursive: true });
// svgPath 在【3】与【5】都要用，声明在守卫外层（写文件本身不需要解码器）
const svgPath = path.join(svgDir, 'kf.svg');
fs.writeFileSync(svgPath, '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180"><rect width="320" height="180" fill="#123"/><circle cx="160" cy="90" r="60" fill="#e91"/></svg>');
const pngPath = path.join(svgDir, 'kf.png');
if (SVG_DECODER_OK) {
  const raster = await comfy.rasterizeKeyframe(svgPath);
  ok('SVG 被光栅化为 PNG', raster.rasterized === true && raster.abs.endsWith('.png') && fs.existsSync(raster.abs) && fs.readFileSync(raster.abs).slice(0, 4).toString('hex') === '89504e47');
  fs.copyFileSync(raster.abs, pngPath);
} else {
  skip('SVG 被光栅化为 PNG', NO_SVG_WHY);
  // 仍要验证「位图关键帧原样使用」，所以自己造一张真 PNG（用仓库自带的纯明文 PNG 编码器）
  const { encodePng } = await import('../src/pngd.js');
  fs.writeFileSync(pngPath, encodePng({ width: 8, height: 8, rgba: Buffer.alloc(8 * 8 * 4, 180) }));
}
const passthrough = await comfy.rasterizeKeyframe(pngPath);
ok('位图关键帧原样使用（不重复转码）', passthrough.rasterized === false && passthrough.abs === pngPath);
// 【6】【6.5】只关心"有无关键帧"的行为分支，与栅格化无关：
// 宿主能解 SVG 就用 SVG，不能就用真 PNG，两条路径语义一致。
const KF = SVG_DECODER_OK ? svgPath : pngPath;

// ---------------- 4. 端到端：文生视频（无关键帧） ----------------
console.log('\n【4】端到端 · 文生视频（无关键帧）');
reset();
const resT2v = await generateVideo({ backend: 'comfyui-h3', scriptId: 'SC-T', code: 'S01E001', shotId: 'SH-1', prompt: '雨夜码头，男人撑伞走近', move: '推镜', shotSize: '中景', duration: 5, ratio: '16:9' });
ok('生成成功且产出 mp4 落盘', resT2v.ok === true && fs.existsSync(resT2v.filePath) && fs.statSync(resT2v.filePath).size > 0, resT2v.filePath);
ok('走内置 t2v 模板', resT2v.raw.template === 'h3-text-to-video.workflow.json', resT2v.raw.template);
ok('提示词写进 144.value 且含运镜信息', /雨夜码头/.test(state.submitted['144'].inputs.value) && /推镜镜头/.test(state.submitted['144'].inputs.value), state.submitted['144'].inputs.value);
ok('时长写进 133.value', state.submitted['133'].inputs.value === 5);
ok('种子已随机化（≠模板硬编码值）', state.submitted['152'].inputs.seed !== 517023855606425, `seed=${state.submitted['152'].inputs.seed}`);
ok('turbo LoRA 与 4 步生效', state.submitted['151'].inputs.lora_01 === TURBO_LORA && state.submitted['152'].inputs.steps === 4);
ok('提示词优化开关被强制 false', state.submitted['150'].inputs.switch === false);
ok('16:9 映射到实例枚举值', state.submitted['115'].inputs.aspect_ratio === '16:9 (Widescreen)');
ok('轮询了 /history 并取回产物（含排队空轮询）', state.historyPolls >= 2, `polls=${state.historyPolls}`);
ok('返回记录自带音频标记与 promptId', resT2v.raw.withAudio === true && Boolean(resT2v.raw.promptId));
ok('无关键帧时未上传任何图', state.uploads.length === 0);

// ---------------- 5. 端到端：首帧驱动 i2v（占位 SVG 关键帧） ----------------
console.log('\n【5】端到端 · 首帧驱动（占位 SVG 关键帧自动光栅化）');
if (SVG_DECODER_OK) {
  reset();
  const resI2v = await generateVideo({ backend: 'comfyui-h3', scriptId: 'SC-T', code: 'S01E001', shotId: 'SH-2', prompt: '档案馆长廊，男子缓步', keyframe: KF, duration: 6, ratio: '9:16' });
  ok('走内置 i2v 模板', resI2v.raw.template === 'h3-image-to-video.workflow.json', resI2v.raw.template);
  ok('关键帧已上传且是 PNG（不是原始 SVG）', state.uploads.length === 1 && /\.png$/i.test(state.uploads[0].name) && state.uploads[0].magic === '89504e47', JSON.stringify(state.uploads[0] || {}));
  ok('上传的是被光栅化后的 PNG 文件名', /^kf_/.test(state.uploads[0].name), state.uploads[0].name);
  ok('131.image 指向刚上传的文件', state.submitted['131'].inputs.image === state.uploads[0].name);
  ok('结果标记 keyframeUploaded + 光栅化警告', resI2v.raw.keyframeUploaded === true && resI2v.warnings.some((w) => /光栅化/.test(w)), resI2v.warnings.join(' | ').slice(0, 120));
  ok('9:16 映射到竖屏枚举值', state.submitted['115'].inputs.aspect_ratio === '9:16 (Portrait)');
  ok('duration=6 也写进模板', state.submitted['133'].inputs.value === 6);
} else {
  skip('端到端首帧驱动 i2v（模板/上传 PNG/枚举/时长 共 7 条）', NO_SVG_WHY);
}

console.log('\n【6】实例不支持首帧时自动回退文生视频');
reset();
state.imageCapable = false;
comfy.clearObjectInfoCache();
const resFallback = await generateVideo({ backend: 'comfyui-h3', scriptId: 'SC-T', code: 'S01E001', shotId: 'SH-3', prompt: '夜航船', keyframe: KF, duration: 5 });
ok('回退到 t2v 模板并说明原因', resFallback.raw.template === 'h3-text-to-video.workflow.json' && resFallback.warnings.some((w) => /回退文生视频/.test(w)), resFallback.warnings.filter((w) => /回退/.test(w)).join(' | '));
ok('回退时不上传关键帧（不浪费带宽）', state.uploads.length === 0 && resFallback.raw.keyframeUploaded === false);
state.imageCapable = true;
comfy.clearObjectInfoCache();

console.log('\n【6.5】实例把首帧列为必填时的两种处置');
reset();
state.imageRequired = true;
comfy.clearObjectInfoCache();
const resReq = await generateVideo({ backend: 'comfyui-h3', scriptId: 'SC-T', code: 'S01E001', shotId: 'SH-3b', prompt: '雨夜追车', keyframe: KF, duration: 5 });
ok('有关键帧 → 直接用首帧驱动模板', resReq.raw.template === 'h3-image-to-video.workflow.json', resReq.raw.template);
ok('首帧确实提交给了实例', resReq.raw.keyframeUploaded === true && Boolean(state.submitted['131'].inputs.image));
// 关掉「首帧优先」后本会选文生模板，但实例要求必填首帧 → 预检失败后自动救回 i2v
reset();
saveConfig({ video: { comfy: { preferKeyframe: false } } });
const resReq2 = await generateVideo({ backend: 'comfyui-h3', scriptId: 'SC-T', code: 'S01E001', shotId: 'SH-3d', prompt: '雨夜追车', keyframe: KF, duration: 5 });
ok('文生模板缺首帧时自动改用首帧驱动模板并说明', resReq2.raw.template === 'h3-image-to-video.workflow.json' && resReq2.warnings.some((w) => /把首帧列为必填/.test(w)), resReq2.warnings.filter((w) => /必填/.test(w)).join(' | '));
saveConfig({ video: { comfy: { preferKeyframe: true } } });
reset();
let reqErr = '';
try { await generateVideo({ backend: 'comfyui-h3', scriptId: 'SC-T', code: 'S01E001', shotId: 'SH-3c', prompt: '无关键帧', duration: 5 }); }
catch (e) { reqErr = e.message; }
ok('无关键帧 → 报错教用户先渲染关键帧', /必须提供首帧图/.test(reqErr) && /先渲染本镜关键帧/.test(reqErr), reqErr.slice(0, 140));
state.imageRequired = false;
comfy.clearObjectInfoCache();

// ---------------- 7. 预检拦住实例缺节点（最常见的 400） ----------------
console.log('\n【7】预检拦截：实例缺节点类型');
reset();
state.dropNode = 'MiniMaxH3MemoryEfficientSageAttentionPatch';
comfy.clearObjectInfoCache();
let preErr = '';
try { await generateVideo({ backend: 'comfyui-h3', scriptId: 'SC-T', code: 'S01E001', shotId: 'SH-4', prompt: '测试', duration: 5 }); }
catch (e) { preErr = e.message; }
ok('抛出中文可读错误并点名节点', /工作流与实例不匹配/.test(preErr) && /missing_node_type/.test(preErr), preErr.slice(0, 140));
ok('预检失败时压根没提交（省一次 400）', state.prompts.length === 0);
state.dropNode = null;
comfy.clearObjectInfoCache();

console.log('\n【8】超时中断（云实例被占住时不留僵尸任务）');
reset();
state.neverFinish = true;
saveConfig({ video: { comfy: { timeoutMs: 400, pollMs: 5 } } });
let toErr = '';
try { await generateVideo({ backend: 'comfyui-h3', scriptId: 'SC-T', code: 'S01E001', shotId: 'SH-5', prompt: '超时测试', duration: 5 }); }
catch (e) { toErr = e.message; }
ok('超时报错含耗时与 H3 速度提示', /超时/.test(toErr) && /45s/.test(toErr), toErr.slice(0, 120));
ok('超时后调用 /interrupt 释放实例', state.interrupts >= 1, `interrupts=${state.interrupts}`);
state.neverFinish = false;
saveConfig({ video: { comfy: { timeoutMs: 60000, pollMs: 5 } } });

// ---------------- 9. 深度探测 ----------------
console.log('\n【9】深度探测（设置页「探测」按钮）');
reset();
const probe = await probeVideoBackend('comfyui-h3');
ok('探测成功并报出显卡/显存', probe.ok === true && /RTX 4090/.test(probe.detail) && /显存 25GB/.test(probe.detail), probe.detail.slice(0, 120));
ok('探测含节点校验结论', /节点校验通过/.test(probe.detail), probe.detail);
ok('探测含首帧能力与模板判定', /支持首帧输入/.test(probe.detail) && /首帧驱动/.test(probe.detail));
ok('探测含 turbo LoRA 可用性与速度换算', /turbo LoRA 可用/.test(probe.detail) && /45s/.test(probe.detail));

state.unetFiles = ['sd_xl_base_1.0.safetensors'];
comfy.clearObjectInfoCache();
const probeNoModel = await probeVideoBackend('comfyui-h3');
ok('实例缺 H3 底模时点出「模型缺失」', /模型缺失/.test(probeNoModel.detail), probeNoModel.detail.slice(0, 160));
state.unetFiles = ['minimax_h3_fl2va_pruned_int8_convrot.safetensors'];
comfy.clearObjectInfoCache();

state.statsStatus = 503;
const probe503 = await probeVideoBackend('comfyui-h3');
ok('503 时给出「实例正在启动/已释放」中文结论', probe503.ok === false && /HTTP 503/.test(probe503.detail) && /正在启动|已释放/.test(probe503.detail), probe503.detail);
state.statsStatus = 200;

saveConfig({ video: { comfy: { url: '' } } });
const probeNoUrl = await probeVideoBackend('comfyui-h3');
ok('未配置地址时明确提示去哪配', probeNoUrl.ok === false && /未配置 ComfyUI 地址/.test(probeNoUrl.detail));
saveConfig({ video: { backend: 'comfyui-h3' } });
const st = videoBackendStatus();
ok('后端状态文案指向内置工作流模板', st.backend === 'comfyui-h3' && /h3-image-to-video\.workflow\.json/.test(st.note) && /h3-text-to-video\.workflow\.json/.test(st.note), st.note.slice(0, 90));

// ---------------- 10. 工作流能力匹配建议（LibTV 调研第 6 条） ----------------
console.log('\n【10】工作流能力匹配：实例缺 LoRA / 缺尾帧 → 降级建议（而不是静默）');
const { backendFit, factsFromProbe } = await import('../src/backend-fit.js');
// 先造一条带台词、4s、带尾帧需求的分镜（需求侧真实取自库里）
const { nowISO, rid } = await import('../src/util.js');
const { run } = await import('../src/db.js');

const sid = rid('SC'), eid = rid('EP');
run(`INSERT INTO scripts(id, title, format, episode_seconds, options, created_at, updated_at) VALUES(?,?,?,?,?,?,?)`,
  sid, '匹配测试剧', 'duanju', 60, JSON.stringify({ ratio: '9:16' }), nowISO(), nowISO());
run(`INSERT INTO script_episodes(id, script_id, season, episode, code, title, duration, status, created_at, updated_at)
     VALUES(?,?,1,1,'S01E900','匹配集',60,'done',?,?)`, eid, sid, nowISO(), nowISO());
for (const [i, dur] of [3, 4, 9].entries()) {
  run(`INSERT INTO shots(id, script_id, episode_id, idx, duration, dialogue, refs, status) VALUES(?,?,?,?,?,?,'{}','draft')`,
    rid('SH'), sid, eid, i + 1, dur, i === 0 ? '沈砚：来了。' : '');
}
// 画布侧：一个视频节点 + 一条接了 last 的连线（代表这一集用了首尾帧过渡）
const cv = rid('CV');
run(`INSERT INTO canvases(id, name, created_at, updated_at) VALUES(?,?,?,?)`, cv, '匹配测试画布', nowISO(), nowISO());
const vnode = rid('ND'), img = rid('ND');
for (const [id, title] of [[vnode, '片段'], [img, '尾帧']]) {
  run(`INSERT INTO canvas_nodes(id, canvas_id, actor_id, x, y, w, h, z, kind, title, data) VALUES(?,?,'',0,0,220,180,0,?,?,?)`,
    id, cv, id === vnode ? 'video' : 'image', title, JSON.stringify({ duration: 4, prompt: 'x' }));
}
run(`INSERT INTO canvas_links(id, canvas_id, from_actor, to_actor, from_node, to_node, from_side, to_side, from_port, to_port, slot, label, color, created_at)
     VALUES(?,?,'','',?,?,'right','left','image','last',0,'尾帧','',?)`, rid('LK'), cv, img, vnode, nowISO());

const fitMismatch = await backendFit({ scriptId: sid, canvasId: cv, backend: 'placeholder', probe: { ok: true } });
ok('匹配：占位后端 + 9s 超长镜头 → 给出「拆镜/续写」建议而不是静默',
  fitMismatch.checks.some((c) => c.id === 'clip-duration' && c.level === 'warn' && /续写|拆/.test(String(c.suggestion))),
  JSON.stringify(fitMismatch.checks.find((c) => c.id === 'clip-duration')));
ok('匹配：需求侧真的读到了台詞与尾帧（说明是「按这一集判断」而不是套话）',
  fitMismatch.needs.hasDialogue === true && fitMismatch.needs.needLastFrame === true && fitMismatch.needs.shots === 3,
  JSON.stringify(fitMismatch.needs));
ok('匹配：有告警时 summary 明确写「可以跑但有 N 处需要降级」', /需要降级处理/.test(fitMismatch.summary), fitMismatch.summary);
ok('匹配：判定为 degraded 但 ready（warn 不阻断，block 才阻断）',
  fitMismatch.degraded === true && fitMismatch.ready === true, `degraded=${fitMismatch.degraded} ready=${fitMismatch.ready}`);
ok('匹配：每条建议都可执行（含去哪改/用什么替代）',
  fitMismatch.suggestions.length >= 2 && fitMismatch.suggestions.every((x) => x.length > 8), fitMismatch.suggestions.slice(0, 2).join(' | '));

// 假实例缺 turbo LoRA → 必须出现「按基础步数 120s/条」的耗时建议
state.unetFiles = ['minimax_h3_fl2va_pruned_int8_convrot.safetensors'];
const oiNoLora = buildObjectInfo();
oiNoLora['Lora Loader Stack (rgthree)'].input.required.lora_01 = [['None'], {}];
const { loadConfig } = await import('../src/config.js');
const factsNoLora = factsFromProbe({ backend: 'comfyui-h3', cfg: loadConfig(), objectInfo: oiNoLora, probe: { ok: true } });
ok('能力事实表：字典里 LoRA 清单为空 → turboAvailable=false（不是「未知」）',
  factsNoLora.turboAvailable === false && factsNoLora.loras.length === 0, JSON.stringify({ loras: factsNoLora.loras, turbo: factsNoLora.turboAvailable }));
const fitNoLora = await backendFit({ scriptId: sid, canvasId: cv, backend: 'comfyui-h3', probe: { ok: true }, objectInfo: oiNoLora });
ok('匹配：缺 turbo LoRA → 给出「120s/条 + 本集预计耗时」的时间量级建议（不是一句「不可用」）',
  fitNoLora.checks.some((c) => c.id === 'lora' && c.level === 'warn' && /120s\/条/.test(c.message)
    && /分钟/.test(String(c.suggestion)) && /turbo LoRA|补装/.test(String(c.suggestion))),
  JSON.stringify(fitNoLora.checks.find((c) => c.id === 'lora')));
const oiWithLora = buildObjectInfo();
const fitLora = await backendFit({ scriptId: sid, canvasId: cv, backend: 'comfyui-h3', probe: { ok: true }, objectInfo: oiWithLora });
ok('匹配：turbo LoRA 可用 → 换算成 45s/条与本集预计耗时（不是一句「可用」）',
  fitLora.checks.some((c) => c.id === 'lora' && c.level === 'ok' && /45s/.test(c.message)), JSON.stringify(fitLora.checks.find((c) => c.id === 'lora')));
const fitDown = await backendFit({ scriptId: sid, canvasId: cv, backend: 'comfyui-h3', probe: { ok: false, detail: '实例返回 HTTP 503' }, objectInfo: oiWithLora });
ok('匹配：后端不可用是 block 级 → ready=false 且给出替代方案（换 placeholder 先跑通）',
  fitDown.ready === false && fitDown.blocks.length >= 1 && /placeholder/.test(String(fitDown.blocks[0].suggestion)),
  fitDown.summary);
const fitPlaceholder = await backendFit({ scriptId: sid, backend: 'placeholder', probe: { ok: true } });
ok('匹配：占位后端免费 → 成本检查是 ok 级并写明「出片免费」',
  fitPlaceholder.checks.some((c) => c.id === 'cost' && c.level === 'ok' && /免费/.test(c.message)),
  JSON.stringify(fitPlaceholder.checks.find((c) => c.id === 'cost')));
ok('匹配：不修改任何配置、不发请求（纯判断；facts 里只带探测到的既有信息）',
  typeof fitMismatch.facts.backend === 'string' && fitMismatch.rule.includes('不改配置'), fitMismatch.rule);

// ---------------- 11. HTTP 200 但 node_errors 非空（官方文档写明最常见的坑） ----------------
// 官方出处：docs/模型对接参考.md 3.2「ComfyUI 原生 HTTP API」—— 「最常见的坑：HTTP 200 不等于会出片」，
//          只要还有可执行的输出节点，服务端就入队并返回 200，同时把校验失败的节点放进 node_errors
//          （missing_node_type 云实例最常见、required_input_missing、prompt_outputs_failed_validation…）
console.log('\n【11】/prompt 返回 HTTP 200 但 node_errors 非空（不得静默空跑到超时）');
reset();
const wfUnknown = path.join(DATA_TMP, 'wf-unknown-node.json');
// 造一个含「本实例没装的节点」的工作流（模拟云实例节点版本与前端 bundle 不一致）→ 服务端会把它放进 node_errors
fs.writeFileSync(wfUnknown, JSON.stringify({ 901: { class_type: 'NotInstalledNode', inputs: {} } }));
saveConfig({ video: { backend: 'comfyui-h3', comfy: { url: BASE, preflight: false, workflowPath: wfUnknown, pollMs: 5, timeoutMs: 3000 } } });
state.nodeErrors200 = true;
let nErr = '';
try { await generateVideo({ backend: 'comfyui-h3', scriptId: 'SC-T', code: 'S01E001', shotId: 'SH-6', prompt: '节点校验失败', duration: 5 }); }
catch (e) { nErr = e.message; }
ok('200 + node_errors 非空 → 中文报错，并带上首个节点错误（节点 id + class_type + 原始 message）',
  /node_errors/.test(nErr) && /首个节点错误/.test(nErr) && /901/.test(nErr) && /NotInstalledNode/.test(nErr) && /missing_node_type/.test(nErr),
  nErr.slice(0, 190));
ok('报错文案写明「实例不会真的出片」，不是一句看不懂的 JSON', /不会真的执行出片|节点校验失败/.test(nErr), nErr.slice(0, 90));
ok('没有静默空跑：任务压根没入队（服务端没记到 prompt）', state.prompts.length === 0, `prompts=${state.prompts.length}`);
ok('没有进入轮询阶段（不发 /history，也不白占实例）', state.historyPolls === 0, `polls=${state.historyPolls}`);

reset();
saveConfig({ video: { comfy: { workflowPath: '', preflight: true, pollMs: 5, timeoutMs: 60000 } } });
state.nodeErrors200 = true;   // 开关仍然开着：正常模板的响应 node_errors 为空 → 必须照常提交
const okAfter = await generateVideo({ backend: 'comfyui-h3', scriptId: 'SC-T', code: 'S01E001', shotId: 'SH-7', prompt: '正常路径', duration: 5 });
ok('node_errors 为空的 200 响应照常提交并出片（新校验不误伤正常路径）',
  okAfter.ok === true && state.prompts.length === 1 && Boolean(okAfter.raw?.promptId), `${okAfter.raw?.template || ''} promptId=${okAfter.raw?.promptId}`);
reset();
saveConfig({ video: { comfy: { workflowPath: '', preflight: true, pollMs: 5, timeoutMs: 60000 } } });

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败${skipped ? ` / 跳过 ${skipped}` : ''} ===`);
server.close();
try {
  fs.rmSync(DB, { force: true }); fs.rmSync(DB + '-wal', { force: true }); fs.rmSync(DB + '-shm', { force: true });
  fs.rmSync(DATA_TMP, { recursive: true, force: true }); fs.rmSync(CFG, { force: true });
} catch { /* ignore */ }
process.exit(fail ? 1 : 0);
