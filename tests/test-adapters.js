// 厂商协议适配器测试（离线假服务端）：出图 generic-http / openai-images、视频 generic-http、配音 openai / generic-http
// 为什么需要它：真实出图/视频/配音仍需自备厂商接口，先用假服务端把「模板渲染 → 提交 → 轮询 → 取回 → 落盘」全链路钉死，
//              等你把 base_url / key / 模型名填进来时，链路本身已经被验证过，出问题只会在厂商侧参数上。
// 用法：node tests/test-adapters.js
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const DATA_TMP = path.join(os.tmpdir(), `factory-adapter-data-${Date.now()}`);
const DB = path.join(os.tmpdir(), `factory-adapter-${Date.now()}.db`);
const CFG = path.join(os.tmpdir(), `factory-adapter-config-${Date.now()}.json`);
process.env.FACTORY_DATA_DIR = DATA_TMP;
process.env.FACTORY_DB = DB;
process.env.FACTORY_CONFIG = CFG;
fs.mkdirSync(DATA_TMP, { recursive: true });

const { migrate } = await import('../src/db.js');
const { saveConfig, loadConfig } = await import('../src/config.js');
const imageMod = await import('../src/image.js');
const { generateImage, imageBackendStatus } = imageMod;
const { generateVideo, videoBackendStatus } = await import('../src/video.js');
const { synthesize, ttsStatus } = await import('../src/tts.js');

migrate();

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? `  ${extra}` : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? `  ${extra}` : ''}`); }
};
const need = (cond, msg) => { if (!cond) throw new Error(msg); };

// ---------------- 假厂商服务端 ----------------
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
// 假厂商返回的视频要是「真 mp4」，否则 ffprobe 校验没意义 → 用 ffmpeg 现场生成一个 0.3 秒样片
const MP4_TMP = path.join(DATA_TMP, 'sample.mp4');
spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=0.3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', MP4_TMP]);
const MP4 = fs.existsSync(MP4_TMP) ? fs.readFileSync(MP4_TMP) : Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(4096, 9)]);
const AUDIO = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(2048, 3)]);

const state = {
  lastRequest: null,        // { path, method, headers, body, raw }（会被后续请求覆盖）
  log: [],                  // 全部请求（含落盘下载的 GET），便于按路径回溯
  polls: 0,
  pollUntil: 2,             // 前 N 次 /task 返回 processing
  pollStatus: 'succeeded',
  mode: 'b64',              // b64 | url | http500 | notjson | badfield
  failTimes: 0,             // 前 N 次请求返回 failStatus（用于验证退避重试）
  failStatus: 429,
  hits: 0,                  // /vendor/txt2img 命中次数
  openaiAuth: '',           // 记录收到的 Authorization
  nodeErrors200: false,     // 让 /comfy/prompt 返回「HTTP 200 但 node_errors 非空」（ComfyUI 最常见的坑）
  llmModelEcho: '',         // 让 /v1/chat/completions 回显/不回显模型名（默认不回显）
};

const readBody = (req) => new Promise((resolve) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => resolve(Buffer.concat(chunks)));
});
const json = (res, code, obj) => {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': b.length });
  res.end(b);
};

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const body = await readBody(req);
  const ct = req.headers['content-type'] || '';
  state.lastRequest = {
    path: u.pathname,
    method: req.method,
    headers: req.headers,
    body: ct.includes('json') ? (() => { try { return JSON.parse(body.toString('utf8')); } catch { return null; } })() : null,
    raw: body,
    rawText: body.toString('latin1'),
  };
  state.log.push(state.lastRequest);
  const lastOf = (p) => [...state.log].reverse().find((r) => r.path === p) || null;

  // ---- 静态产物 ----
  if (u.pathname === '/files/img.png') {
    res.writeHead(200, { 'content-type': 'image/png' });
    return res.end(Buffer.from(PNG_B64, 'base64'));
  }
  if (u.pathname === '/files/photo.jpg') {
    res.writeHead(200, { 'content-type': 'image/jpeg' });
    return res.end(Buffer.from(PNG_B64, 'base64'));
  }
  if (u.pathname === '/files/clip.mp4') {
    res.writeHead(200, { 'content-type': 'video/mp4' });
    return res.end(MP4);
  }
  if (u.pathname === '/files/line.mp3') {
    res.writeHead(200, { 'content-type': 'audio/mpeg' });
    return res.end(AUDIO);
  }

  // ---- OpenAI 兼容：出图 ----
  if (u.pathname === '/v1/images/generations') {
    state.openaiAuth = req.headers.authorization || '';
    if (state.mode === 'http500') return json(res, 500, { error: { message: '厂商内部错误' } });
    if (state.mode === 'notjson') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html>oops</html>'); }
    if (state.mode === 'badfield') return json(res, 200, { created: 1, data: [{ revised_prompt: '没有图' }] });
    if (state.mode === 'url') return json(res, 200, { data: [{ url: `http://127.0.0.1:${server.address().port}/files/img.png` }] });
    return json(res, 200, { data: [{ b64_json: PNG_B64, revised_prompt: '英文改写后的提示词' }] });
  }
  if (u.pathname === '/v1/images/edits') {
    state.openaiAuth = req.headers.authorization || '';
    return json(res, 200, { data: [{ b64_json: PNG_B64 }] });
  }

  // ---- 通用模板：文生图 ----
  if (u.pathname === '/vendor/direct-image') {
    res.writeHead(200, { 'content-type': 'image/png' });
    return res.end(Buffer.from(PNG_B64, 'base64'));
  }
  if (u.pathname === '/vendor/nested') {
    return json(res, 200, { code: 0, request_id: 'R-1', data: { task_id: 'T-9', images: [{ url: `http://127.0.0.1:${server.address().port}/files/img.png` }] }, output: { b64: PNG_B64 } });
  }
  if (u.pathname === '/vendor/txt2img') {
    state.hits++;
    if (state.failTimes > 0) {
      state.failTimes--;
      return json(res, state.failStatus, { msg: state.failStatus === 429 ? 'rate limit exceeded' : '上游服务异常' });
    }
    if (state.mode === 'http500') return json(res, 500, { msg: '额度不足' });
    if (state.mode === 'notjson') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('not json at all'); }
    if (state.mode === 'badfield') return json(res, 200, { code: 0, payload: { nothing: true } });
    if (state.mode === 'url') return json(res, 200, { output: [`http://127.0.0.1:${server.address().port}/files/photo.jpg`] });
    return json(res, 200, { data: [{ b64_json: PNG_B64 }] });
  }

  // ---- 通用模板：异步任务 ----
  if (u.pathname === '/vendor/async') return json(res, 200, { data: { task_id: 'T-1001' } });
  if (u.pathname.startsWith('/vendor/task/')) {
    state.polls++;
    if (state.polls <= state.pollUntil) return json(res, 200, { data: { status: 'processing' } });
    if (state.pollStatus === 'failed') return json(res, 200, { data: { status: 'FAILED', reason: '内容审核不通过' } });
    return json(res, 200, { data: { status: 'SUCCESS', result: { url: `http://127.0.0.1:${server.address().port}/files/img.png` } } });
  }

  // ---- 通用模板：万相 DashScope 异步（任务号放在 output.task_id，状态在 output.task_status）----
  if (u.pathname === '/vendor/wanx') {
    return json(res, 200, { request_id: 'W-REQ-1', output: { task_id: 'W-2026', task_status: 'PENDING' } });
  }
  if (u.pathname.startsWith('/vendor/wanx/task/')) {
    state.polls++;
    return json(res, 200, { request_id: 'W-REQ-1', output: { task_status: 'SUCCEEDED', results: [{ url: `http://127.0.0.1:${server.address().port}/files/img.png` }] } });
  }

  // ---- 通用模板：火山方舟 Seedream（同步，image 字段可为空 → 会报 InvalidImageURL.EmptyURL）----
  if (u.pathname === '/vendor/ark-image') {
    return json(res, 200, { model: 'doubao-seedream-5-0-pro-260628', data: [{ url: `http://127.0.0.1:${server.address().port}/files/img.png` }], usage: { generated_images: 1 } });
  }

  // ---- ComfyUI（/prompt 的「HTTP 200 但 node_errors 非空」坑）----
  if (u.pathname === '/comfy/prompt') {
    if (state.nodeErrors200) {
      return json(res, 200, { prompt_id: 'p-comfy-1', node_errors: { 10: { class_type: 'LoadImageProbe', message: 'required_input_missing: image' } } });
    }
    return json(res, 200, { prompt_id: 'p-comfy-1', node_errors: {} });
  }
  if (u.pathname.startsWith('/comfy/history/')) {
    const id = u.pathname.split('/').pop();
    return json(res, 200, { [id]: { status: { status_str: 'success', completed: true }, outputs: { 9: { images: [{ filename: 'comfy_out_00001_.png', subfolder: '', type: 'output' }] } } } });
  }
  if (u.pathname === '/comfy/view') {
    res.writeHead(200, { 'content-type': 'image/png' });
    return res.end(Buffer.from(PNG_B64, 'base64'));
  }

  // ---- LLM（OpenAI 兼容 /chat/completions；默认不回显模型名）----
  if (u.pathname === '/v1/chat/completions') {
    const payload = { choices: [{ message: { content: '好的' } }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } };
    if (state.llmModelEcho) payload.model = state.llmModelEcho;
    return json(res, 200, payload);
  }

  // ---- 通用模板：出视频 ----
  if (u.pathname === '/vendor/video') {
    if (state.mode === 'badfield') return json(res, 200, { data: { nothing: true } });
    if (state.mode === 'url') return json(res, 200, { data: [{ url: `http://127.0.0.1:${server.address().port}/files/clip.mp4` }] });
    return json(res, 200, { data: [{ video_url: `http://127.0.0.1:${server.address().port}/files/clip.mp4` }] });
  }
  // ---- 通用模板：视频任务号探测（各家把任务号放在不同位置，见 docs/模型对接参考.md）----
  // state.videoShape 决定提交响应形状：output.task_id（万相）/ data.id（通用）/ id（Ark）/ data.output.task_id（嵌套变形）/ both / none
  if (u.pathname === '/vendor/video-shape') {
    const shape = state.videoShape || '';
    if (shape === 'output.task_id') return json(res, 200, { request_id: 'W-REQ-2', output: { task_id: 'WANX-V1', task_status: 'PENDING' } });
    if (shape === 'data.id') return json(res, 200, { data: { id: 'DATA-V1' } });
    if (shape === 'id') return json(res, 200, { id: 'ARK-V1' });
    if (shape === 'data.output.task_id') return json(res, 200, { code: 0, data: { output: { task_id: 'NEST-V1' } } });
    if (shape === 'both') return json(res, 200, { id: 'SECOND-V1', data: { task_id: 'FIRST-V1' } });   // 既有顺序优先：data.task_id 先命中
    return json(res, 200, { code: 0, msg: 'ok' });                                                     // 既没有任务号，也没有成片地址
  }
  if (u.pathname.startsWith('/vendor/vtask/')) {
    state.videoTaskHits.push(u.pathname.split('/').pop());
    // 万相口径：状态在 output.task_status、成片地址在 output.video_url（同时验证两处兜底候选）
    if (state.videoShape === 'output.task_id') return json(res, 200, { request_id: 'W-REQ-2', output: { task_status: 'SUCCEEDED', video_url: `http://127.0.0.1:${server.address().port}/files/clip.mp4` } });
    return json(res, 200, { data: { status: 'SUCCEEDED', video_url: `http://127.0.0.1:${server.address().port}/files/clip.mp4` } });
  }

  // ---- 配音 ----
  if (u.pathname === '/v1/audio/speech') {
    res.writeHead(200, { 'content-type': 'audio/mpeg' });
    return res.end(AUDIO);
  }
  if (u.pathname === '/vendor/tts') {
    if (state.mode === 'badfield') return json(res, 200, { data: { nothing: true } });
    if (state.mode === 'url') return json(res, 200, { data: [{ url: `http://127.0.0.1:${server.address().port}/files/line.mp3` }] });
    if (state.mode === 'binary') { res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(AUDIO); }
    return json(res, 200, { data: [{ audio_base64: AUDIO.toString('base64') }] });
  }

  json(res, 404, { error: 'not found' });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const exists = (p) => Boolean(p) && fs.existsSync(p);
const size = (p) => (exists(p) ? fs.statSync(p).size : 0);
const IMG_GENERIC = {
  image: {
    backend: 'generic-http', defaultRatio: '3:4', defaultWidth: 1024, defaultHeight: 1365,
    generic: {
      url: `${BASE}/vendor/txt2img`, method: 'POST',
      headers: '{"Content-Type":"application/json","Authorization":"Bearer {{apiKey}}","X-Actor":"{{actorId}}"}',
      bodyTemplate: '{"model":"{{model}}","prompt":"{{prompt}}","negative_prompt":"{{negative}}","width":{{width}},"height":{{height}},"seed":{{seed}},"ratio":"{{ratio}}","kind":"{{kind}}","ref_image":"{{ref_image}}","image":"{{refImage}}"}',
      responseImagePath: 'data.0.b64_json', apiKey: 'sk-vendor-test', model: 'vendor-image-v2',
      refImageField: 'image', refImageFormat: 'base64',
      pollUrl: '', pollIntervalMs: 10, pollMaxTimes: 3, pollStatusPath: 'data.status', pollSuccessValues: 'succeeded,SUCCESS,done',
    },
  },
};
const resetReq = () => { state.lastRequest = null; state.log = []; state.polls = 0; state.mode = 'b64'; state.pollUntil = 2; state.pollStatus = 'succeeded'; state.failTimes = 0; state.failStatus = 429; state.hits = 0; state.nodeErrors200 = false; state.llmModelEcho = ''; };
const reqOf = (p) => [...state.log].reverse().find((r) => r.path === p) || null;

/** 整体替换配置（saveConfig 是深合并，写用例时必须整段替换，否则上一个用例的字段会串场） */
const configWith = (patch) => saveConfig(patch);
const setCfg = (obj) => { fs.writeFileSync(CFG, JSON.stringify(obj, null, 2)); loadConfig({ reload: true }); };

// ════════════════ 1. 出图 · 通用 HTTP 模板 ════════════════
console.log('\n【1】出图后端 generic-http（任意厂商协议）');
resetReq();
setCfg(IMG_GENERIC);
const img1 = await generateImage({ actorId: 'C-0001', kind: 'face', variant: 'closeup', prompt: 'close-up portrait, cinematic', negative: 'blurry', seed: 4242 });
ok('文生图：base64 产物落盘', img1.ok && exists(img1.absPath) && size(img1.absPath) > 50, `${img1.filePath}（${size(img1.absPath)}B）`);
ok('文生图：记录 backend/model/尺寸/seed', img1.backend === 'generic-http' && img1.model === 'vendor-image-v2' && img1.width === 1024 && img1.height === 1365 && img1.seed === 4242, JSON.stringify({ b: img1.backend, m: img1.model, w: img1.width, h: img1.height }));
ok('文生图：中文 negative 走 negative_prompt 字段', state.lastRequest.body.negative_prompt === 'blurry' && state.lastRequest.body.prompt.includes('close-up portrait'));
ok('模板变量：{{ratio}} 由宽高推导（1024:1365）', state.lastRequest.body.ratio === '1024:1365', state.lastRequest.body.ratio);
ok('模板变量：{{kind}} / {{model}} 正确注入', state.lastRequest.body.kind === 'face' && state.lastRequest.body.model === 'vendor-image-v2');
ok('headers 模板：Authorization 与自定义头都渲染', state.lastRequest.headers.authorization === 'Bearer sk-vendor-test' && state.lastRequest.headers['x-actor'] === 'C-0001', `${state.lastRequest.headers.authorization} / ${state.lastRequest.headers['x-actor']}`);

// 参考生图（dataurl）
resetReq();
setCfg({ image: { ...IMG_GENERIC.image, generic: { ...IMG_GENERIC.image.generic, refImageFormat: 'dataurl', refImageField: 'ref_image' } } });
const refFile = path.join(DATA_TMP, 'ref-src.png');
fs.writeFileSync(refFile, Buffer.from(PNG_B64, 'base64'));
const img2 = await generateImage({ actorId: 'C-0001', kind: 'costume', variant: 'fabric', prompt: 'costume detail', refImage: refFile });
const refFieldVal = String(state.lastRequest?.body?.ref_image || '');
ok('参考生图：dataurl 参考图填进自定义字段 ref_image', img2.ok && refFieldVal.startsWith('data:image/png;base64,'), refFieldVal.slice(0, 42) || '(空)');
ok('参考生图：base64 载荷与源文件字节数一致', refFieldVal.includes(',') && Buffer.from(refFieldVal.split(',')[1], 'base64').length === fs.statSync(refFile).size, `解码 ${refFieldVal.includes(',') ? Buffer.from(refFieldVal.split(',')[1], 'base64').length : 0}B / 源 ${fs.statSync(refFile).size}B`);
ok('参考生图：{{refImage}} 通用变量同样可用（两种写法都支持）', String(state.lastRequest?.body?.image || '').startsWith('data:image/png;base64,'));

// URL 响应 + 按 content-type 定扩展名
resetReq();
setCfg({ image: { ...IMG_GENERIC.image, generic: { ...IMG_GENERIC.image.generic, responseImagePath: 'output.0' } } });
state.mode = 'url';
const img3 = await generateImage({ actorId: 'C-0001', kind: 'full', variant: 'front', prompt: 'full body' });
ok('URL 响应：服务端下载落盘并按 content-type 定扩展名（jpg）', img3.ok && exists(img3.absPath) && img3.absPath.endsWith('.jpg'), img3.filePath);
ok('URL 响应：mime 记为 image/jpeg', img3.mime === 'image/jpeg', img3.mime);

// 异步任务轮询
resetReq();
setCfg({ image: { ...IMG_GENERIC.image, generic: { ...IMG_GENERIC.image.generic, url: `${BASE}/vendor/async`, responseImagePath: 'data.result.url', pollUrl: `${BASE}/vendor/task/{{taskId}}`, pollMaxTimes: 5 } } });
const img4 = await generateImage({ actorId: 'C-0002', kind: 'face', variant: 'front', prompt: 'async task' });
ok('异步任务：task_id → 轮询 → 成功后下载产物', img4.ok && exists(img4.absPath) && state.polls >= 3, `轮询 ${state.polls} 次，产物 ${path.basename(img4.absPath)}`);
ok('异步任务：raw 里回填 taskId 便于排查', img4.raw?.taskId === 'T-1001', JSON.stringify(img4.raw));

// 失败与异常路径
resetReq();
setCfg({ image: { ...IMG_GENERIC.image, generic: { ...IMG_GENERIC.image.generic, url: `${BASE}/vendor/async`, responseImagePath: 'data.result.url', pollUrl: `${BASE}/vendor/task/{{taskId}}`, pollMaxTimes: 2 } } });
state.pollUntil = 99;
let err1 = ''; try { await generateImage({ actorId: 'C-0003', kind: 'face', variant: 'front', prompt: 'x' }); } catch (e) { err1 = e.message; }
ok('轮询超时给出中文错误', /轮询超时/.test(err1), err1);

resetReq();
state.pollUntil = 0; state.pollStatus = 'failed';
let err2 = ''; try { await generateImage({ actorId: 'C-0003', kind: 'face', variant: 'front', prompt: 'x' }); } catch (e) { err2 = e.message; }
ok('任务失败给出中文错误并带上厂商原因', /出图任务失败/.test(err2) && /审核/.test(err2), err2.slice(0, 90));

resetReq();
setCfg(IMG_GENERIC);
state.mode = 'http500';
let err3 = ''; try { await generateImage({ actorId: 'C-0003', kind: 'face', variant: 'front', prompt: 'x' }); } catch (e) { err3 = e.message; }
ok('接口 500 时中文错误含状态码与厂商原文', /出图接口 500/.test(err3) && /额度不足/.test(err3), err3.slice(0, 80));

resetReq(); state.mode = 'notjson';
let err4 = ''; try { await generateImage({ actorId: 'C-0003', kind: 'face', variant: 'front', prompt: 'x' }); } catch (e) { err4 = e.message; }
ok('非 JSON 响应给出中文错误', /返回非 JSON/.test(err4), err4.slice(0, 80));

resetReq(); state.mode = 'badfield';
let err5 = ''; try { await generateImage({ actorId: 'C-0003', kind: 'face', variant: 'front', prompt: 'x' }); } catch (e) { err5 = e.message; }
ok('响应缺图片字段时点名字段路径', /找不到图片字段/.test(err5) && err5.includes('data.0.b64_json'), err5.slice(0, 100));

resetReq();
// 注意：'{"prompt":"{{prompt}"}' 其实是合法 JSON（少一个 } 只影响占位符匹配），这里用真正非法的模板
setCfg({ image: { ...IMG_GENERIC.image, generic: { ...IMG_GENERIC.image.generic, bodyTemplate: '{"prompt": "a",,}' } } });
let err6 = ''; try { await generateImage({ actorId: 'C-0003', kind: 'face', variant: 'front', prompt: 'x' }); } catch (e) { err6 = e.message; }
ok('bodyTemplate 非法 JSON 时中文报错（不静默失败）', /bodyTemplate 渲染后不是合法 JSON/.test(err6), err6.slice(0, 90));

// ════════════════ 1b. 失败重试与错误归类 ════════════════
console.log('\n【1b】自动重试与错误归类（真实厂商最常见的 429 / 5xx / 网络抖动）');
const retry = await import('../src/retry.js');
const clsCases = [
  [Object.assign(new Error('出图接口 429: rate limit'), { status: 429 }), 'rate'],
  [new Error('出图接口 500: internal error'), 'server'],
  [Object.assign(new Error('出图接口 401: invalid api key'), { status: 401 }), 'auth'],
  [new Error('出图接口 500: {"msg":"额度不足"}'), 'quota'],
  [new Error('内容审核不通过：violates content policy'), 'moderation'],
  [new Error('fetch failed'), 'network'],
  [new Error('出图接口响应里找不到图片字段「data.0.b64_json」'), 'format'],
  [new Error('未配置通用出图 URL'), 'config'],
  [new Error('完全看不懂的错误'), 'unknown'],
  [Object.assign(new Error('boom'), { status: 503 }), 'server'],
];
const clsBad = clsCases.filter(([e, want]) => retry.classifyError(e).kind !== want);
ok('错误归类表 10/10（限流/5xx/鉴权/额度/审核/网络/字段/配置/未知）', clsBad.length === 0, clsBad.map(([e, w]) => `${e.message}→${retry.classifyError(e).kind}/want ${w}`).join(' | '));
ok('可重试性判定：429/5xx/网络可重试，401/额度/审核/字段不可重试',
   retry.classifyError(Object.assign(new Error('x'), { status: 429 })).retryable === true
   && retry.classifyError(Object.assign(new Error('x'), { status: 500 })).retryable === true
   && retry.classifyError(new Error('fetch failed')).retryable === true
   && retry.classifyError(Object.assign(new Error('x'), { status: 401 })).retryable === false
   && retry.classifyError(new Error('额度不足')).retryable === false
   && retry.classifyError(new Error('响应里找不到图片字段「a.b」')).retryable === false);
ok('错误文案自带归类与尝试次数', retry.describeError(Object.assign(new Error('出图接口 429: rate limit'), { status: 429, attempts: 3, errorKind: 'rate', errorLabel: retry.ERROR_KINDS.rate.label })) === '[触发限流（429）] 出图接口 429: rate limit（已尝试 3 次）', retry.describeError(Object.assign(new Error('出图接口 429: rate limit'), { status: 429, attempts: 3, errorKind: 'rate', errorLabel: retry.ERROR_KINDS.rate.label })));

// 429 → 500 → 成功：应自动重试到成功
resetReq();
setCfg({ image: { ...IMG_GENERIC.image, retries: 2, retryBaseMs: 5, generic: { ...IMG_GENERIC.image.generic, url: `${BASE}/vendor/txt2img` } } });
state.failTimes = 1; state.failStatus = 429;
const rt1 = await generateImage({ actorId: 'C-0010', kind: 'face', variant: 'front', prompt: 'retry-a' });
ok('限流 429 自动退避重试后成功', rt1.ok && rt1.attempts === 2 && state.hits === 2, `attempts=${rt1.attempts} hits=${state.hits}`);

resetReq();
setCfg({ image: { ...IMG_GENERIC.image, retries: 3, retryBaseMs: 5 } });
state.failTimes = 2; state.failStatus = 503;
const rt2 = await generateImage({ actorId: 'C-0010', kind: 'face', variant: 'front', prompt: 'retry-b' });
ok('5xx 连续两次后第三次成功（指数退避）', rt2.ok && rt2.attempts === 3 && state.hits === 3, `attempts=${rt2.attempts} hits=${state.hits}`);

resetReq();
setCfg({ image: { ...IMG_GENERIC.image, retries: 5, retryBaseMs: 5 } });
state.failTimes = 99; state.failStatus = 429;
let errRt = null;
try { await generateImage({ actorId: 'C-0010', kind: 'face', variant: 'front', prompt: 'retry-c' }); } catch (e) { errRt = e; }
ok('重试用尽后抛出带归类的错误', Boolean(errRt) && errRt.errorKind === 'rate' && errRt.attempts === 6, `kind=${errRt?.errorKind} attempts=${errRt?.attempts}`);
ok('重试用尽的文案含中文归类与次数', /触发限流/.test(String(errRt?.message)) && /已尝试 6 次/.test(String(errRt?.message)), String(errRt?.message).slice(0, 90));
ok('重试次数确实被遵守（5 次重试 = 6 次请求）', state.hits === 6, `hits=${state.hits}`);

resetReq();
setCfg({ image: { ...IMG_GENERIC.image, retries: 3, retryBaseMs: 5 } });
state.failTimes = 99; state.failStatus = 401;
let errAuth = null;
try { await generateImage({ actorId: 'C-0010', kind: 'face', variant: 'front', prompt: 'auth' }); } catch (e) { errAuth = e; }
ok('鉴权失败不重试（一次即返回，避免白白重试付费接口）', errAuth?.errorKind === 'auth' && errAuth?.attempts === 1 && state.hits === 1, `kind=${errAuth?.errorKind} attempts=${errAuth?.attempts} hits=${state.hits}`);

resetReq();
setCfg({ image: { ...IMG_GENERIC.image, retries: 0 } });
state.failTimes = 99; state.failStatus = 500;
let err0 = null;
try { await generateImage({ actorId: 'C-0010', kind: 'face', variant: 'front', prompt: 'no-retry' }); } catch (e) { err0 = e; }
ok('retries=0 时立即失败（可关闭重试）', err0?.attempts === 1 && state.hits === 1, `attempts=${err0?.attempts} hits=${state.hits}`);

// ════════════════ 2. 出图 · OpenAI 兼容 ════════════════
console.log('\n【2】出图后端 openai-images（OpenAI 兼容协议）');
resetReq();
const OPENAI_IMG = { baseUrl: BASE, apiKey: 'sk-openai-test', model: 'gpt-image-1', generatePath: '/v1/images/generations', editPath: '/v1/images/edits' };
setCfg({ image: { backend: 'openai-images', openai: OPENAI_IMG } });
const oa1 = await generateImage({ actorId: 'C-0004', kind: 'face', variant: 'closeup', prompt: 'portrait', width: 768, height: 1024 });
ok('文生图：b64_json 落盘 + Bearer 鉴权', oa1.ok && exists(oa1.absPath) && state.openaiAuth === 'Bearer sk-openai-test', `${oa1.filePath} / ${state.openaiAuth}`);
ok('文生图：请求体含 model 与 size', state.lastRequest.body.model === 'gpt-image-1' && state.lastRequest.body.size === '768x1024', JSON.stringify({ m: state.lastRequest.body.model, s: state.lastRequest.body.size }));
ok('文生图：回传 revised_prompt 供排查', oa1.raw?.revised_prompt === '英文改写后的提示词');

resetReq();
setCfg({ image: { backend: 'openai-images', openai: { ...OPENAI_IMG, model: 'dall-e-3' } } });
await generateImage({ actorId: 'C-0004', kind: 'face', variant: 'front', prompt: 'p' });
ok('dall-e 模型自动加 response_format=b64_json', state.lastRequest.body.response_format === 'b64_json', JSON.stringify(state.lastRequest.body));

resetReq();
const oa2 = await generateImage({ actorId: 'C-0004', kind: 'costume', variant: 'fabric', prompt: 'costume', negative: 'extra fingers', refImage: refFile });
ok('参考生图走 /v1/images/edits（multipart）', state.lastRequest.path === '/v1/images/edits' && String(state.lastRequest.headers['content-type']).includes('multipart/form-data'), state.lastRequest.path);
ok('edits：prompt 把负向词合并成 Avoid 段', /Avoid: extra fingers/.test(state.lastRequest.rawText), state.lastRequest.rawText.includes('Avoid: extra fingers') ? 'ok' : '未找到');
ok('edits：multipart 里带上了参考图文件', /filename="[^"]+\.png"/.test(state.lastRequest.rawText) && oa2.ok, (state.lastRequest.rawText.match(/filename="[^"]+"/) || [''])[0]);

resetReq();
state.mode = 'url';
const oa3 = await generateImage({ actorId: 'C-0004', kind: 'full', variant: 'front', prompt: 'p' });
ok('URL 形式响应同样落盘', oa3.ok && exists(oa3.absPath) && oa3.raw?.url, oa3.filePath);

resetReq();
setCfg({ image: { backend: 'openai-images', openai: { ...OPENAI_IMG, apiKey: '' } } });
process.env.IMAGE_API_KEY = '';
process.env.OPENAI_API_KEY = '';
let err7 = ''; try { await generateImage({ actorId: 'C-0004', kind: 'face', variant: 'front', prompt: 'p' }); } catch (e) { err7 = e.message; }
ok('缺少 Key 时给出中文引导（不发起请求）', /未配置出图 API Key/.test(err7), err7);

// ════════════════ 3. 视频 · 通用 HTTP 模板 ════════════════
console.log('\n【3】视频后端 generic-http');
resetReq();
const VIDEO_GENERIC = {
  video: {
    backend: 'generic-http', defaultRatio: '16:9',
    generic: {
      url: `${BASE}/vendor/video`, method: 'POST',
      headers: '{"Content-Type":"application/json","Authorization":"Bearer {{apiKey}}"}',
      bodyTemplate: '{"model":"{{model}}","prompt":"{{prompt}}","duration":{{duration}},"width":{{width}},"height":{{height}},"seed":{{seed}},"image":"{{refImage}}"}',
      responseVideoPath: 'data.0.video_url', apiKey: 'sk-video-test', model: 'vendor-video-1',
      refImageFormat: 'base64', pollUrl: '', pollStatusPath: '',
    },
  },
};
setCfg(VIDEO_GENERIC);
const vid1 = await generateVideo({ scriptId: 'SC-A', code: 'S01E001', shotId: 'SH-A1', prompt: 'tracking shot', duration: 4, refImage: null });
ok('文生视频：URL 产物下载落盘（mp4）', vid1.ok && exists(vid1.absPath) && size(vid1.absPath) > 1000, `${vid1.filePath}（${size(vid1.absPath)}B）`);
const vidReq = reqOf('/vendor/video');
ok('文生视频：body 变量含 duration/width/height/seed', Boolean(vidReq?.body) && vidReq.body.duration === 4 && vidReq.body.width === 1280 && vidReq.body.height === 720 && typeof vidReq.body.seed === 'number', JSON.stringify({ d: vidReq?.body?.duration, w: vidReq?.body?.width, s: vidReq?.body?.seed }));
ok('文生视频：厂商请求带 Bearer 鉴权头', vidReq?.headers?.authorization === 'Bearer sk-video-test', String(vidReq?.headers?.authorization));
const probe = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', vid1.absPath], { encoding: 'utf8' }).stdout || '{}');
ok('产物可被 ffprobe 识别为 mp4 容器', probe.format?.format_name?.includes('mp4'), probe.format?.format_name || '(无法识别)');

resetReq();
setCfg(VIDEO_GENERIC);
const vid2 = await generateVideo({ scriptId: 'SC-A', code: 'S01E001', shotId: 'SH-A2', prompt: 'p', duration: 3, keyframe: refFile });
const vidReq2 = reqOf('/vendor/video');
ok('图生视频：关键帧 base64 回填 {{refImage}}', vid2.ok && String(vidReq2?.body?.image || '').length > 40, `长度 ${String(vidReq2?.body?.image || '').length}`);

resetReq();
setCfg(VIDEO_GENERIC);
state.mode = 'badfield';
let err8 = ''; try { await generateVideo({ scriptId: 'SC-A', code: 'S01E001', shotId: 'SH-A3', prompt: 'p', duration: 3 }); } catch (e) { err8 = e.message; }
ok('视频响应缺字段时点名字段路径', /找不到字段/.test(err8) && err8.includes('data.0.video_url'), err8.slice(0, 100));

// ════════════════ 3b. 视频任务号探测路径扩展（有序候选 + 中文报错列出尝试路径）════════════════
console.log('\n【3b】视频任务号探测（有序候选路径：万相 output.task_id / Ark id / MiniMax task_id / 通用 data.task_id、data.id）');
const VIDEO_SHAPE_CFG = { video: {
  backend: 'generic-http', defaultRatio: '16:9', retries: 0,
  generic: {
    url: `${BASE}/vendor/video-shape`, method: 'POST',
    headers: '{"Content-Type":"application/json"}',
    bodyTemplate: '{"model":"{{model}}","prompt":"{{prompt}}","image":"{{refImage}}"}',
    responseVideoPath: 'data.video_url', apiKey: 'sk-video-test', model: 'vendor-video-1', refImageFormat: 'base64',
    pollUrl: `${BASE}/vendor/vtask/{{taskId}}`, pollStatusPath: 'data.status',
    pollIntervalMs: 1, pollMaxTimes: 3, pollSuccessValues: 'succeeded,success,done',
  },
} };
/** 用指定形状的假响应跑一次视频生成，返回 { out, err } 与本次轮询到的任务号（state.videoTaskHits） */
const shapeOf = async (shape) => {
  resetReq();
  state.videoShape = shape;
  state.videoTaskHits = [];
  setCfg(VIDEO_SHAPE_CFG);
  try { return { out: await generateVideo({ scriptId: 'SC-A', code: 'S01E001', shotId: 'SH-T1', prompt: 'p', duration: 3 }), err: '' }; }
  catch (e) { return { out: null, err: e.message }; }
};

const shWanx = await shapeOf('output.task_id');
ok('任务号候选路径：万相 output.task_id 命中（既有 4 条都不命中时仍取到并轮询）',
  shWanx.out?.ok === true && state.videoTaskHits.includes('WANX-V1'), `轮询到 ${JSON.stringify(state.videoTaskHits)}`);
ok('任务号候选路径：万相轮询响应走兜底「状态字段 output.task_status + 成片地址 output.video_url」',
  shWanx.out?.ok === true && /output\.task_status/.test(JSON.stringify(shWanx.out?.raw?.notes || [])) && /output\.video_url/.test(JSON.stringify(shWanx.out?.raw?.notes || [])),
  JSON.stringify(shWanx.out?.raw?.notes || []).slice(0, 160));

const shDataId = await shapeOf('data.id');
ok('任务号候选路径：通用 data.id 命中', shDataId.out?.ok === true && state.videoTaskHits.includes('DATA-V1'), `轮询到 ${JSON.stringify(state.videoTaskHits)}`);

const shId = await shapeOf('id');
ok('任务号候选路径：Ark 风格顶层 id 命中', shId.out?.ok === true && state.videoTaskHits.includes('ARK-V1'), `轮询到 ${JSON.stringify(state.videoTaskHits)}`);

const shNest = await shapeOf('data.output.task_id');
ok('任务号候选路径：嵌套变形 data.output.task_id 命中', shNest.out?.ok === true && state.videoTaskHits.includes('NEST-V1'), `轮询到 ${JSON.stringify(state.videoTaskHits)}`);

const shBoth = await shapeOf('both');
ok('向后兼容：同时有 data.task_id 与 id 时，仍按既有顺序先命中 data.task_id（顺序不变）',
  shBoth.out?.ok === true && state.videoTaskHits.includes('FIRST-V1') && !state.videoTaskHits.includes('SECOND-V1'), `轮询到 ${JSON.stringify(state.videoTaskHits)}`);

const shNone = await shapeOf('none');
ok('完全取不到任务号时：中文报错里列出尝试过的路径（含 output.task_id / data.id / id）',
  /找不到字段/.test(shNone.err) && /已尝试路径/.test(shNone.err) && /output\.task_id/.test(shNone.err)
  && /data\.task_id/.test(shNone.err) && /data\.id/.test(shNone.err) && /→ id/.test(shNone.err)
  && /[\u4e00-\u9fa5]/.test(shNone.err),
  shNone.err.slice(0, 420));

// ════════════════ 4. 配音 · openai / 通用模板 ════════════════
console.log('\n【4】配音后端 openai / generic-http');
resetReq();
setCfg({ tts: { backend: 'openai', format: 'mp3', voice: 'alloy', openai: { baseUrl: BASE, apiKey: 'sk-tts-test', path: '/v1/audio/speech', model: 'tts-1', voice: 'alloy' } } });
const t1 = await synthesize({ text: '你来得太晚了。', outKey: 'S01E001_line01' });
ok('openai 配音：二进制音频落盘', t1.ok && exists(t1.absPath) && size(t1.absPath) > 100, `${t1.filePath}（${size(t1.absPath)}B）`);
ok('openai 配音：请求体含 input/voice/speed/response_format', state.lastRequest.body.input === '你来得太晚了。' && state.lastRequest.body.voice === 'alloy' && state.lastRequest.body.response_format === 'mp3', JSON.stringify(state.lastRequest.body));

resetReq();
const TTS_GENERIC = { url: `${BASE}/vendor/tts`, method: 'POST', headers: '{"Content-Type":"application/json","Authorization":"Bearer {{apiKey}}"}', bodyTemplate: '{"text":"{{text}}","voice":"{{voice}}","model":"{{model}}","speed":{{speed}}}', responseType: 'b64', responseAudioPath: 'data.0.audio_base64', apiKey: 'sk-tts-x', model: 'vendor-tts' };
setCfg({ tts: { backend: 'generic-http', format: 'mp3', speed: 1, generic: TTS_GENERIC } });
const t2 = await synthesize({ text: '怀表停在十点四十。', outKey: 'S01E001_line02' });
ok('通用配音：b64 响应落盘', t2.ok && exists(t2.absPath) && size(t2.absPath) > 100, `${t2.filePath}（${size(t2.absPath)}B）`);
ok('通用配音：bodyTemplate 注入 text/voice/model/speed', state.lastRequest.body.text === '怀表停在十点四十。' && state.lastRequest.body.model === 'vendor-tts' && state.lastRequest.body.speed === 1, JSON.stringify(state.lastRequest.body));

resetReq();
setCfg({ tts: { backend: 'generic-http', format: 'mp3', speed: 1, generic: { ...TTS_GENERIC, responseType: 'url', responseAudioPath: 'data.0.url' } } });
state.mode = 'url';
const t3 = await synthesize({ text: '第三句台词。', outKey: 'S01E001_line03' });
ok('通用配音：URL 响应下载落盘', t3.ok && exists(t3.absPath) && size(t3.absPath) > 100, t3.filePath);

resetReq();
setCfg({ tts: { backend: 'generic-http', format: 'mp3', speed: 1, generic: { ...TTS_GENERIC, responseType: 'binary' } } });
state.mode = 'binary';
const t4 = await synthesize({ text: '第四句台词。', outKey: 'S01E001_line04' });
ok('通用配音：纯二进制响应落盘', t4.ok && exists(t4.absPath) && size(t4.absPath) > 100, `${path.basename(t4.absPath)}（${size(t4.absPath)}B）`);

resetReq();
setCfg({ tts: { backend: 'generic-http', format: 'mp3', speed: 1, generic: TTS_GENERIC } });
state.mode = 'badfield';
let err9 = ''; try { await synthesize({ text: '缺字段。', outKey: 'x' }); } catch (e) { err9 = e.message; }
ok('配音响应缺字段时点名字段路径', /找不到音频字段/.test(err9), err9.slice(0, 80));

let err10 = ''; try { await synthesize({ text: '', outKey: 'x' }); } catch (e) { err10 = e.message; }
ok('空台词直接中文报错（不发起请求）', /台词为空/.test(err10), err10);

setCfg({ tts: { backend: 'none' } });
let err11 = ''; try { await synthesize({ text: '你好', outKey: 'x' }); } catch (e) { err11 = e.message; }
ok('未启用配音时中文引导去设置', /未启用 TTS 后端/.test(err11), err11);

// ════════════════ 5. 后端状态与就绪判定 ════════════════
console.log('\n【5】后端状态与就绪判定');
setCfg({ image: IMG_GENERIC.image, video: VIDEO_GENERIC.video, tts: { backend: 'generic-http', generic: TTS_GENERIC } });
ok('出图状态：通用后端显示接口地址', imageBackendStatus().backend === 'generic-http' && imageBackendStatus().ready === true, imageBackendStatus().note.slice(0, 60));
ok('视频状态：通用后端显示接口地址', videoBackendStatus().backend === 'generic-http' && videoBackendStatus().ready === true, videoBackendStatus().note.slice(0, 60));
ok('配音状态：通用后端显示接口地址', ttsStatus().backend === 'generic-http' && ttsStatus().ready === true, String(ttsStatus().note || '').slice(0, 60));
setCfg({ image: { ...IMG_GENERIC.image, generic: { ...IMG_GENERIC.image.generic, url: '' } }, video: { ...VIDEO_GENERIC.video, generic: { ...VIDEO_GENERIC.video.generic, url: '' } } });
ok('未填地址时状态标记为未就绪（界面给黄色告警）', imageBackendStatus().ready === false && videoBackendStatus().ready === false, `出图 ready=${imageBackendStatus().ready} 视频 ready=${videoBackendStatus().ready}`);
ok('未配置出图接口时状态栏标注「未填 url」（界面黄色告警的依据）', /未填 url/.test(imageBackendStatus().note), imageBackendStatus().note);
setCfg({ image: { ...IMG_GENERIC.image, generic: { ...IMG_GENERIC.image.generic, url: '' } } });
let err12 = ''; try { await generateImage({ actorId: 'C-0009', kind: 'face', variant: 'front', prompt: 'x' }); } catch (e) { err12 = e.message; }
ok('真正发起生成时给出中文引导（未配置通用出图 URL）', /未配置通用出图 URL/.test(err12), err12);

// ════════════════ 5b. LLM 失败也带中文归类（与出图/视频/配音一致） ════════════════
console.log('\n【5b】LLM 调用的失败归类');
const { chat } = await import('../src/llm.js');
setCfg({ llm: { provider: 'openai', baseUrl: 'http://127.0.0.1:9', apiKey: 'sk-x', model: 'x', timeoutMs: 3000 } });
let llmErr = null;
try { await chat({ prompt: 'hi', retries: 0 }); } catch (e) { llmErr = e; }
ok('LLM 连接失败被归类为网络类（中文标签）', llmErr?.errorKind === 'network' && /网络/.test(llmErr?.errorLabel || ''), `${llmErr?.errorKind} / ${llmErr?.errorLabel}`);
ok('LLM 错误消息保留原文（便于排查）', /LLM/.test(String(llmErr?.message || '')), String(llmErr?.message).slice(0, 60));

// ════════════════ 6. 厂商接入向导（粘贴 curl / 试发推荐字段） ════════════════
console.log('\n【6】厂商接入向导：curl 解析 + 响应字段推荐');
const vendor = await import('../src/vendor.js');

const curlA = `curl -X POST 'https://api.vendor.com/v1/images/generations' \\
  -H 'Authorization: Bearer sk-abc123' -H 'Content-Type: application/json' \\
  -d '{"model":"vendor-v2","prompt":"a cat on a roof","negative_prompt":"blurry","width":1024,"height":768,"seed":123,"size":"1024x768"}'`;
const pA = vendor.parseCurl(curlA);
ok('curl 解析：URL 与方法', pA.url === 'https://api.vendor.com/v1/images/generations' && pA.method === 'POST', `${pA.method} ${pA.url}`);
ok('curl 解析：Key 被替换成 {{apiKey}}（不落明文）', /Bearer \{\{apiKey\}\}/.test(pA.headers) && !/sk-abc123/.test(pA.headers), pA.headers);
ok('curl 解析：提示词 → {{prompt}} 且负向词 → {{negative}}（不被 prompt 规则抢走）', /"prompt":"\{\{prompt\}\}"/.test(pA.bodyTemplate) && /"negative_prompt":"\{\{negative\}\}"/.test(pA.bodyTemplate), pA.bodyTemplate.slice(0, 120));
ok('curl 解析：数值字段输出不加引号的占位符', /"width":\{\{width\}\}/.test(pA.bodyTemplate) && /"seed":\{\{seed\}\}/.test(pA.bodyTemplate), pA.bodyTemplate.slice(0, 140));
ok('curl 解析：字符串尺寸 → {{width}}x{{height}}', /"size":"\{\{width\}\}x\{\{height\}\}"/.test(pA.bodyTemplate));
const filledTemplate = pA.bodyTemplate.replace(/"\{\{(\w+)\}\}"/g, '"x"').replace(/\{\{(\w+)\}\}/g, '1');
let tplValid = true; try { JSON.parse(filledTemplate); } catch { tplValid = false; }
ok('curl 解析：填入变量后模板仍是合法 JSON', tplValid, filledTemplate.slice(0, 110));
ok('curl 解析：给出中文操作提示', Array.isArray(pA.notes) && pA.notes.length >= 1 && /占位符/.test(pA.notes.join(' ')), pA.notes.join(' | ').slice(0, 90));

const pB = vendor.parseCurl("curl -X GET 'https://api.v.com/v1/tasks/123'");
ok('curl 解析：GET 无请求体也支持（并提示没有请求体）', pB.method === 'GET' && pB.bodyTemplate === '' && pB.notes.some((n) => /没有请求体/.test(n)), pB.notes.join(' | ').slice(0, 70));
const pC = vendor.parseCurl("curl 'https://api.v.com/v1/img' -u user:pass -F 'image=@/tmp/a.png' -F 'prompt=a cat'");
ok('curl 解析：-u 基本鉴权 → Bearer {{apiKey}}', /Bearer \{\{apiKey\}\}/.test(pC.headers), pC.headers);
ok('curl 解析：-F 表单上传被识别并给出提示', pC.isMultipart === true && pC.notes.some((n) => /表单上传/.test(n)), pC.notes.find((n) => /表单/.test(n)) || '');
let curlErr = ''; try { vendor.parseCurl('wget http://x'); } catch (e) { curlErr = e.message; }
ok('curl 解析：非 curl 输入给出中文错误', /不是可识别的 curl/.test(curlErr), curlErr);
let curlErr2 = ''; try { vendor.parseCurl("curl -X POST -d '{}'"); } catch (e) { curlErr2 = e.message; }
ok('curl 解析：缺少 URL 给出中文错误', /没从 curl 里找到 URL/.test(curlErr2), curlErr2);

const nested = { code: 0, request_id: 'R-1', data: { task_id: 'T-9', images: [{ url: 'https://cdn.v.com/a.png' }] }, output: { b64: `iVBORw0KGgo${'A'.repeat(200)}` } };
const sug = vendor.suggestFields(nested, { kind: 'image' });
ok('字段推荐：能定位嵌套的媒体 URL 与 base64 数据', sug.some((x) => x.path === 'data.images.0.url') && sug.some((x) => x.path === 'output.b64'), sug.map((x) => `${x.path}(${x.score})`).join(', '));
ok('字段推荐：base64 媒体数据排在普通字段之前', sug[0].path === 'output.b64' && /base64/.test(sug[0].reason), JSON.stringify(sug[0]));

// 试发探测：成功 / 二进制媒体 / 失败 / 未配置
const probeCfg = { image: { ...IMG_GENERIC.image, generic: { ...IMG_GENERIC.image.generic, url: `${BASE}/vendor/nested`, responseImagePath: '' } } };
const pv1 = await vendor.probeVendor({ kind: 'image', cfg: probeCfg });
ok('试发探测：返回状态/耗时/推荐字段与目标配置键', pv1.ok && pv1.status === 200 && pv1.elapsedMs >= 0 && pv1.suggestions.length >= 1 && pv1.pathKey === 'responseImagePath', `status=${pv1.status} 推荐 ${pv1.suggestions.length} 条`);
ok('试发探测：带原始响应片段（便于人工核对）', typeof pv1.raw === 'string' && pv1.raw.includes('request_id'), String(pv1.raw).slice(0, 70));

const probeBin = await vendor.probeVendor({ kind: 'image', cfg: { image: { ...IMG_GENERIC.image, generic: { ...IMG_GENERIC.image.generic, url: `${BASE}/vendor/direct-image` } } } });
ok('试发探测：响应直接是二进制媒体时提示「无需字段路径」', probeBin.ok && probeBin.binary === true && probeBin.bytes > 50 && probeBin.tips.some((t) => /二进制/.test(t)), `${probeBin.contentType} ${probeBin.bytes}B`);

const probeFail = await vendor.probeVendor({ kind: 'image', cfg: { image: { ...IMG_GENERIC.image, generic: { ...IMG_GENERIC.image.generic, url: `${BASE}/vendor/txt2img` } } } });
state.mode = 'http500';
const probeFail2 = await vendor.probeVendor({ kind: 'image', cfg: { image: { ...IMG_GENERIC.image, generic: { ...IMG_GENERIC.image.generic, url: `${BASE}/vendor/txt2img` } } } });
ok('试发探测：接口报错时返回归类（额度/服务端）而不是抛异常', probeFail2.ok === false && probeFail2.status === 500 && ['quota', 'server'].includes(probeFail2.errorKind), `kind=${probeFail2.errorKind} status=${probeFail2.status}`);
ok('试发探测成功路径不受上一个用例影响（状态隔离）', probeFail.ok === true, `ok=${probeFail.ok}`);

const probeNoUrl = await vendor.probeVendor({ kind: 'video', cfg: { video: { generic: { url: '' } } } });
ok('试发探测：未配置 URL 时给中文引导', probeNoUrl.ok === false && probeNoUrl.errorKind === 'config' && /未配置/.test(probeNoUrl.error), probeNoUrl.error);

// 「先试后存」：draft 只用于本次探测，不写进配置
setCfg({ image: { ...IMG_GENERIC.image, generic: { ...IMG_GENERIC.image.generic, url: `${BASE}/vendor/txt2img` } } });
const before = loadConfig().image.generic.url;
const pvDraft = await vendor.probeVendor({ kind: 'image', cfg: { ...loadConfig(), image: { ...loadConfig().image, generic: { ...loadConfig().image.generic, url: `${BASE}/vendor/nested` } } } });
ok('试发探测：draft 配置不落库（界面可「先试后存」）', pvDraft.ok === true && loadConfig().image.generic.url === before, `探测用 ${pvDraft.status}，配置仍为 ${loadConfig().image.generic.url}`);

// ════════════════ 7. 万相 DashScope 异步：任务号在 output.task_id（此前取不到 → 永不轮询） ════════════════
// 官方出处：docs/模型对接参考.md 2.0 警告 + 2.3「阿里云百炼 通义万相 Wanx」
//   POST /api/v1/services/aigc/text2image/image-synthesis → 轮询 GET /api/v1/tasks/{task_id} → output.results[0].url
//   状态字段 output.task_status ∈ PENDING|RUNNING|SUCCEEDED|FAILED|CANCELED|UNKNOWN
console.log('\n【7】万相 Wanx 异步任务（output.task_id / output.task_status）');
resetReq();
const WANX_CFG = {
  image: {
    backend: 'generic-http', defaultRatio: '3:4', defaultWidth: 1104, defaultHeight: 1472,
    generic: {
      url: `${BASE}/vendor/wanx`, method: 'POST',
      headers: '{"Content-Type":"application/json","Authorization":"Bearer {{apiKey}}","X-DashScope-Async":"enable"}',
      bodyTemplate: '{"model":"{{model}}","input":{"prompt":"{{prompt}}"},"parameters":{"size":"1104*1472","negative_prompt":"{{negative}}","watermark":false,"prompt_extend":true}}',
      responseImagePath: 'output.results.0.url', apiKey: 'sk-dashscope', model: 'wan2.6-t2i',
      pollUrl: `${BASE}/vendor/wanx/task/{{taskId}}`, pollIntervalMs: 5, pollMaxTimes: 4,
      pollStatusPath: 'output.task_status', pollSuccessValues: 'SUCCEEDED',
    },
  },
};
setCfg(WANX_CFG);
const wx1 = await generateImage({ actorId: 'C-0021', kind: 'face', variant: 'front', prompt: '一间有着精致窗户的花店' });
ok('万相异步：task_id 能从 output.task_id 取到（此前只探 4 条路径 → 取不到、不轮询）', wx1.raw?.taskId === 'W-2026', JSON.stringify(wx1.raw));
ok('万相异步：任务号回填进 pollUrl 的 {{taskId}} 并轮询', Boolean(reqOf('/vendor/wanx/task/W-2026')) && state.polls >= 1, `${(reqOf('/vendor/wanx/task/W-2026') || {}).path || '(未轮询)'} × ${state.polls}`);
ok('万相异步：SUCCEEDED 后按 output.results.0.url 下载落盘', wx1.ok && exists(wx1.absPath), `${wx1.filePath}（${size(wx1.absPath)}B）`);

resetReq();
setCfg({ image: { ...WANX_CFG.image, generic: { ...WANX_CFG.image.generic, pollStatusPath: 'status' } } });
const wx2 = await generateImage({ actorId: 'C-0021', kind: 'face', variant: 'front', prompt: '花店' });
ok('万相异步：pollStatusPath 未命中时兜底读 output.task_status（官方状态字段）', wx2.ok && state.polls >= 1, `轮询 ${state.polls} 次，${wx2.filePath}`);

ok('万相字段口径：parameters.n 官方默认 4（按张计费）→ 未显式给 n 时注入 n:1', (() => {
  const b = reqOf('/vendor/wanx')?.body;
  return b?.parameters?.n === 1;
})(), JSON.stringify(reqOf('/vendor/wanx')?.body?.parameters));
ok('万相字段口径：注入 n:1 时带中文提示（说明默认会扣 4 张）', (wx2.notes || []).some((n) => /万相/.test(n) && /n:1|默认 4/.test(n)), (wx2.notes || []).join(' | ').slice(0, 130));

resetReq();
setCfg({ image: { ...WANX_CFG.image, generic: { ...WANX_CFG.image.generic, bodyTemplate: '{"model":"{{model}}","input":{"prompt":"{{prompt}}"},"parameters":{"n":2,"size":"1104*1472"}}' } } });
await generateImage({ actorId: 'C-0021', kind: 'face', variant: 'front', prompt: '花店' });
ok('万相字段口径：模板里显式写的 n:2 不被覆盖（只补默认值）', reqOf('/vendor/wanx')?.body?.parameters?.n === 2, JSON.stringify(reqOf('/vendor/wanx')?.body?.parameters));
ok('万相端点识别：官方域名与旧版异步端点都能认出（dashscope.aliyuncs.com）', imageMod.isWanxEndpoint('https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis', '') === true
  && imageMod.isWanxEndpoint('https://ws-1.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation', '') === true
  && imageMod.isWanxEndpoint('https://api.openai.com/v1/images/generations', 'gpt-image-1') === false);

// ════════════════ 8. 空参考图删键 + 火山方舟 Seedream 字段口径 ════════════════
// 官方出处：docs/模型对接参考.md 2.2「火山方舟 Seedream」—— image 为空串会 InvalidImageURL.EmptyURL；
//          watermark 官方默认 true；官方字段表里没有 n / seed / negative_prompt（塞进去 400 InvalidParameter.UnsupportedParameter）
console.log('\n【8】纯文生图：空参考图删键 + Ark 字段口径（watermark / n / seed / negative_prompt）');
resetReq();
setCfg({ image: { ...IMG_GENERIC.image, generic: { ...IMG_GENERIC.image.generic, bodyTemplate: '{"model":"{{model}}","prompt":"{{prompt}}","image":"{{refImage}}","nested":{"image":"{{refImage}}"}}' } } });
const noRef = await generateImage({ actorId: 'C-0022', kind: 'face', variant: 'front', prompt: '纯文生图' });
const noRefBody = reqOf('/vendor/txt2img')?.body || {};
ok('纯文生图：空的参考图键被删除（顶层与嵌套都不发空串）', noRef.ok && !('image' in noRefBody) && !('image' in (noRefBody.nested || {})), JSON.stringify(noRefBody));
ok('纯文生图：删键动作带中文提示（写明后果，如 Seedream InvalidImageURL.EmptyURL）', (noRef.notes || []).some((n) => /参考图字段/.test(n) && /删除/.test(n)), (noRef.notes || []).join(' | ').slice(0, 130));

resetReq();
setCfg({ image: { ...IMG_GENERIC.image, generic: { ...IMG_GENERIC.image.generic, bodyTemplate: '{"model":"{{model}}","prompt":"{{prompt}}","image":"{{refImage}}"}' } } });
const withRef = await generateImage({ actorId: 'C-0022', kind: 'costume', variant: 'fabric', prompt: '带参考图', refImage: refFile });
ok('有参考图时该键照常保留（只删空值，不影响参考生图）', withRef.ok && String(reqOf('/vendor/txt2img')?.body?.image || '').length > 40, `长度 ${String(reqOf('/vendor/txt2img')?.body?.image || '').length}`);

resetReq();
const ARK_GENERIC = {
  ...IMG_GENERIC.image,
  generic: {
    ...IMG_GENERIC.image.generic,
    url: `${BASE}/vendor/ark-image`,
    bodyTemplate: '{"model":"{{model}}","prompt":"{{prompt}}","image":"{{refImage}}","size":"{{width}}x{{height}}","response_format":"url","n":1,"seed":{{seed}},"negative_prompt":"{{negative}}"}',
    responseImagePath: 'data.0.url', apiKey: 'ark-key', model: 'doubao-seedream-5-0-pro-260628',
    refImageField: 'image', refImageFormat: 'dataurl', pollUrl: '', pollStatusPath: '',
  },
};
setCfg({ image: ARK_GENERIC });
const ark1 = await generateImage({ actorId: 'C-0023', kind: 'face', variant: 'front', prompt: '赛博朋克雨夜街头', negative: '模糊', seed: 42 });
const arkBody = reqOf('/vendor/ark-image')?.body || {};
ok('Seedream：未显式设置时注入 watermark:false（官方默认 true，会带「AI 生成」水印）', arkBody.watermark === false, JSON.stringify(arkBody.watermark));
ok('Seedream：剔除官方字段表没有的 n / seed / negative_prompt（否则 InvalidParameter.UnsupportedParameter）',
  !('n' in arkBody) && !('seed' in arkBody) && !('negative_prompt' in arkBody), JSON.stringify(Object.keys(arkBody)));
ok('Seedream：剔除动作带中文提示（点名火山方舟官方字段表）', (ark1.notes || []).some((n) => /火山方舟|Ark/.test(n) && /n、seed、negative_prompt|不支持/.test(n)), (ark1.notes || []).find((n) => /剔除/.test(n))?.slice(0, 140) || '(无)');
ok('Seedream：纯文生图时空的 image 字段同样被删除', ark1.ok && !('image' in arkBody), JSON.stringify(arkBody.image));
ok('Ark 端点识别：官方域名（volces.com / 国际版 bytepluses.com）与 doubao-seedream 模型名都能认出',
  imageMod.isArkEndpoint('https://ark.cn-beijing.volces.com/api/v3/images/generations', '') === true
  && imageMod.isArkEndpoint('', 'doubao-seedream-5-0-lite-260128') === true
  && imageMod.isArkEndpoint('https://api.openai.com/v1/images/generations', 'gpt-image-1') === false);

resetReq();
setCfg({ image: { ...ARK_GENERIC, generic: { ...ARK_GENERIC.generic, bodyTemplate: '{"model":"{{model}}","prompt":"{{prompt}}","watermark":true}' } } });
await generateImage({ actorId: 'C-0023', kind: 'face', variant: 'front', prompt: '要水印' });
ok('Seedream：用户显式写的 watermark:true 不被覆盖（只补默认值）', reqOf('/vendor/ark-image')?.body?.watermark === true, JSON.stringify(reqOf('/vendor/ark-image')?.body));

// ════════════════ 9. 非 Bearer 鉴权头模板 ════════════════
// 官方出处：docs/模型对接参考.md 速查表 —— Vidu `Authorization: Token <key>`（api.vidu.cn/ent/v2/start-end2video）；
//          火山语音 V1 `Authorization: Bearer;{token}`（分号，openspeech.bytedance.com/api/v1/tts）；
//          ElevenLabs `xi-api-key`（api.elevenlabs.io/v1/text-to-speech）；Runway 必带 `X-Runway-Version: 2024-11-06`
console.log('\n【9】非 Bearer 鉴权头模板（authHeader / authPrefix）');
resetReq();
setCfg({ image: { ...IMG_GENERIC.image, generic: { ...IMG_GENERIC.image.generic, headers: '{"Content-Type":"application/json"}' } } });
await generateImage({ actorId: 'C-0024', kind: 'face', variant: 'front', prompt: '默认鉴权' });
ok('默认口径不变：未配置 authHeader 时仍是 Authorization: Bearer <key>', reqOf('/vendor/txt2img')?.headers?.authorization === 'Bearer sk-vendor-test', String(reqOf('/vendor/txt2img')?.headers?.authorization));

resetReq();
setCfg({ image: { ...IMG_GENERIC.image, generic: { ...IMG_GENERIC.image.generic, authHeader: 'Authorization', authPrefix: 'Token ', headers: '{"Content-Type":"application/json"}' } } });
const viduImg = await generateImage({ actorId: 'C-0024', kind: 'face', variant: 'front', prompt: 'Vidu 口径' });
ok('Vidu 口径：Authorization: Token <key>（前缀是 Token 不是 Bearer）', reqOf('/vendor/txt2img')?.headers?.authorization === 'Token sk-vendor-test', String(reqOf('/vendor/txt2img')?.headers?.authorization));
ok('鉴权头注入带中文提示（说明用的是哪家官方口径）', (viduImg.notes || []).some((n) => /authHeader/.test(n) && /Token /.test(n)), (viduImg.notes || []).find((n) => /authHeader/.test(n))?.slice(0, 120) || '(无)');

resetReq();
setCfg({ image: { ...IMG_GENERIC.image, generic: { ...IMG_GENERIC.image.generic, authHeader: 'Authorization', authPrefix: 'Bearer;', headers: '{"Content-Type":"application/json"}' } } });
await generateImage({ actorId: 'C-0024', kind: 'face', variant: 'front', prompt: '火山语音口径' });
ok('火山语音 V1 口径：Authorization: Bearer;<token>（官方明确分号，不是空格）', reqOf('/vendor/txt2img')?.headers?.authorization === 'Bearer;sk-vendor-test', String(reqOf('/vendor/txt2img')?.headers?.authorization));

resetReq();
setCfg({ image: { ...IMG_GENERIC.image, generic: { ...IMG_GENERIC.image.generic, authHeader: 'xi-api-key', authPrefix: '', headers: '{"Content-Type":"application/json"}' } } });
await generateImage({ actorId: 'C-0024', kind: 'face', variant: 'front', prompt: 'ElevenLabs 口径' });
ok('ElevenLabs 口径：自定义头名 xi-api-key + 空前缀也能注入', reqOf('/vendor/txt2img')?.headers?.['xi-api-key'] === 'sk-vendor-test' && !reqOf('/vendor/txt2img')?.headers?.authorization, JSON.stringify({ xi: reqOf('/vendor/txt2img')?.headers?.['xi-api-key'], auth: reqOf('/vendor/txt2img')?.headers?.authorization }));

resetReq();
setCfg({ image: { ...IMG_GENERIC.image, generic: { ...IMG_GENERIC.image.generic, authHeader: 'Authorization', authPrefix: 'Token ' } } });
await generateImage({ actorId: 'C-0024', kind: 'face', variant: 'front', prompt: '覆盖模板里的 Bearer' });
ok('authHeader 会覆盖模板里已渲染的同名头（不会拼成两个 Authorization）', reqOf('/vendor/txt2img')?.headers?.authorization === 'Token sk-vendor-test', String(reqOf('/vendor/txt2img')?.headers?.authorization));

resetReq();
setCfg({ video: { ...VIDEO_GENERIC.video, generic: { ...VIDEO_GENERIC.video.generic, authHeader: 'Authorization', authPrefix: 'Token ', headers: '{"Content-Type":"application/json"}' } } });
await generateVideo({ scriptId: 'SC-A', code: 'S01E001', shotId: 'SH-A9', prompt: 'Vidu 视频', duration: 3 });
ok('视频侧同一套模板：Vidu 首尾帧端点用 Token 前缀（api.vidu.cn/ent/v2/start-end2video）', reqOf('/vendor/video')?.headers?.authorization === 'Token sk-video-test', String(reqOf('/vendor/video')?.headers?.authorization));

resetReq();
setCfg({ video: { ...VIDEO_GENERIC.video, generic: { ...VIDEO_GENERIC.video.generic, headers: '{"Content-Type":"application/json","Authorization":"Bearer {{apiKey}}","X-Runway-Version":"2024-11-06"}' } } });
await generateVideo({ scriptId: 'SC-A', code: 'S01E001', shotId: 'SH-A10', prompt: 'Runway', duration: 3 });
ok('Runway 每请求必带的 X-Runway-Version 头原样透传（缺它官方明确说会失败）', reqOf('/vendor/video')?.headers?.['x-runway-version'] === '2024-11-06', String(reqOf('/vendor/video')?.headers?.['x-runway-version']));
ok('Runway 同请求仍是 Bearer 鉴权（版本头不影响默认鉴权口径）', reqOf('/vendor/video')?.headers?.authorization === 'Bearer sk-video-test', String(reqOf('/vendor/video')?.headers?.authorization));

// ════════════════ 10. openai-images 尺寸白名单（gpt-image-1 三档） ════════════════
// 官方出处：docs/模型对接参考.md 2.1 —— size 只接受 1024x1024 / 1536x1024 / 1024x1536（dall-e-3 另有 1792x1024 / 1024x1792）；
//          gpt-image-2 / 2.5 系列：宽高都要能被 16 整除、宽高比 ∈ [1:3,3:1]、最大 3840x2160
console.log('\n【10】出图尺寸白名单与归一（gpt-image-1 只收三档）');
ok('缺陷来源：项目 RATIO_SIZE 的 3:4 = 1024x1365（1365 不是 16 的倍数，也不在 gpt-image-1 白名单）',
  JSON.stringify(imageMod.RATIO_SIZE['3:4']) === '[1024,1365]', JSON.stringify(imageMod.RATIO_SIZE['3:4']));
const norm1 = imageMod.normalizeOpenAIImageSize(1024, 1365, 'gpt-image-1', { derived: true });
ok('归一：3:4 的 1024x1365 → 最近合法档 1024x1536（竖版 2:3）', norm1.changed === true && norm1.width === 1024 && norm1.height === 1536, JSON.stringify(norm1));
ok('归一：中文提示写明「白名单 + 原尺寸会被 400 拒绝」', /白名单/.test(norm1.note) && /1024x1536/.test(norm1.note) && /400/.test(norm1.note), norm1.note.slice(0, 130));
ok('归一：1024x1024 / 1536x1024 / 1024x1536 三档原样放行（不改写合法请求）',
  [['1024', '1024'], ['1536', '1024'], ['1024', '1536']].every(([w, h]) => imageMod.normalizeOpenAIImageSize(+w, +h, 'gpt-image-1', { derived: true }).changed === false));
ok('归一：gpt-image-2 只把 1365 收成 16 的倍数（1024x1360），而 16:9 的 1536x864 本来就合法',
  imageMod.normalizeOpenAIImageSize(1024, 1365, 'gpt-image-2', { derived: true }).height === 1360
  && imageMod.normalizeOpenAIImageSize(1536, 864, 'gpt-image-2', { derived: true }).changed === false);
ok('归一：自建/聚合端点的非官方模型（flux 等）不做任何干涉',
  imageMod.normalizeOpenAIImageSize(1024, 1365, 'flux-dev', { derived: true }).changed === false
  && imageMod.openaiImageSizeRule('flux-dev').kind === 'none');
ok('归一：dall-e-3 的档位是 1024x1024 / 1792x1024 / 1024x1792（与 gpt-image-1 不同）',
  JSON.stringify(imageMod.openaiImageSizeRule('dall-e-3').sizes) === JSON.stringify(['1024x1024', '1792x1024', '1024x1792']));

resetReq();
setCfg({ image: { backend: 'openai-images', defaultRatio: '3:4', defaultWidth: 1024, defaultHeight: 1365, openai: OPENAI_IMG } });
const g34 = await generateImage({ actorId: 'C-0025', kind: 'face', variant: 'front', prompt: '竖版定妆' });
ok('端到端：defaultRatio=3:4 时实际发出 1024x1536（此前发 1024x1365，必然 400）', state.lastRequest?.body?.size === '1024x1536', String(state.lastRequest?.body?.size));
ok('端到端：结果里带真实尺寸与 sizeNote（排查时能看到被改写过）',
  g34.width === 1024 && g34.height === 1536 && /白名单/.test(String(g34.sizeNote)) && g34.raw?.sizeChanged === true,
  `${g34.width}x${g34.height} · ${String(g34.sizeNote).slice(0, 60)}`);
resetReq();
const gExplicit = await generateImage({ actorId: 'C-0025', kind: 'face', variant: 'front', prompt: '显式尺寸', width: 768, height: 1024 });
ok('显式传入的尺寸不被悄悄改写，但会给出中文风险提示（避免用户以为已经合法）',
  state.lastRequest?.body?.size === '768x1024' && /白名单/.test(String(gExplicit.sizeNote)) && gExplicit.raw?.sizeChanged === false,
  `${state.lastRequest?.body?.size} · ${String(gExplicit.sizeNote).slice(0, 60)}`);

// ════════════════ 11. ComfyUI 出图：HTTP 200 但 node_errors 非空 ════════════════
// 官方出处：docs/模型对接参考.md 3.2「ComfyUI 原生 HTTP API」—— 「HTTP 200 不等于会出片」，
//          校验失败的节点放在响应体 node_errors 里（missing_node_type / required_input_missing …）
console.log('\n【11】ComfyUI 出图：/prompt 返回 200 但 node_errors 非空');
resetReq();
const IMG_WF = path.join(DATA_TMP, 'img-workflow.json');
fs.writeFileSync(IMG_WF, JSON.stringify({ 6: { class_type: 'CLIPTextEncode', inputs: { text: '' } } }));
setCfg({ image: { backend: 'comfyui', comfy: { url: `${BASE}/comfy`, workflowPath: IMG_WF, map: '{"positive":"6.text"}', timeoutMs: 3000 } } });
state.nodeErrors200 = true;
let comfyImgErr = '';
try { await generateImage({ actorId: 'C-0026', kind: 'face', variant: 'front', prompt: '节点校验失败' }); } catch (e) { comfyImgErr = e.message; }
ok('出图侧：200 + node_errors 非空 → 中文报错并点名首个节点（不再静默等到超时）',
  /node_errors/.test(comfyImgErr) && /首个节点错误/.test(comfyImgErr) && /LoadImageProbe/.test(comfyImgErr) && /required_input_missing/.test(comfyImgErr), comfyImgErr.slice(0, 170));
ok('出图侧：报错即停，没有去轮询 /history（说明没有静默空跑）', !state.log.some((r) => r.path.startsWith('/comfy/history')), state.log.map((r) => r.path).join(','));

resetReq();
const cImg = await generateImage({ actorId: 'C-0026', kind: 'face', variant: 'front', prompt: '正常出图' });
ok('出图侧：node_errors 为空的 200 响应照常提交、轮询并落盘（新校验不误伤正常路径）',
  cImg.ok && exists(cImg.absPath) && cImg.raw?.filename === 'comfy_out_00001_.png', `${cImg.filePath}（${size(cImg.absPath)}B）`);

// ════════════════ 12. LLM：DeepSeek 官方现行模型名 ════════════════
// 官方出处：docs/模型对接参考.md 1.1 —— 官方模型 & 价格页现行列出 deepseek-flash（V4.1-Flash，支持图像理解、便宜）
//          与 deepseek-v4-pro（V4-Pro-0813，推理更强但不支持图像理解、单价高）；旧默认 deepseek-chat 已不在官方列表里
console.log('\n【12】LLM 模型名：DeepSeek 官方现行模型（deepseek-flash / deepseek-v4-pro）');
const llmMod = await import('../src/llm.js');
ok('llm.js 既有导出签名不变（chat / chatJSON / chatStreamChapters / llmStatus / LlmError 都还在）',
  // 注意：这里**不能**真的调用 chat() 来验「返回 Promise」——原写法 `typeof chat({prompt:'x'}).then` 会真发一次
  // 付费 LLM 请求（实测打到 api.deepseek.com，走宿主机真实凭据；LLM token 不计入 usage 台账，所以一直没被发现）。
  // 改为按类型断言（chat 是 async function，天然返回 Promise），语义等价、零外部调用。
  ['chat', 'chatJSON', 'chatStreamChapters', 'llmStatus', 'LlmError'].every((k) => typeof llmMod[k] === 'function')
  && llmMod.chat.constructor.name === 'AsyncFunction');
ok('默认模型常量按官方文档写死为 deepseek-flash，旧名映射表指向官方现行模型',
  llmMod.DEFAULT_DEEPSEEK_MODEL === 'deepseek-flash'
  && llmMod.DEEPSEEK_LEGACY_MODELS['deepseek-chat'] === 'deepseek-flash'
  && llmMod.DEEPSEEK_LEGACY_MODELS['deepseek-reasoner'] === 'deepseek-v4-pro',
  JSON.stringify(llmMod.DEEPSEEK_LEGACY_MODELS));

resetReq();
setCfg({ llm: { provider: 'deepseek', baseUrl: BASE, apiKey: 'sk-ds', model: 'deepseek-chat', temperature: 0.5, maxTokens: 128, timeoutMs: 5000 } });
const llm1 = await llmMod.chat({ prompt: '你好', retries: 0 });
ok('配置里的 deepseek-chat 已改写成官方现行 deepseek-flash（请求体里就是它）',
  reqOf('/v1/chat/completions')?.body?.model === 'deepseek-flash' && llm1.requestedModel === 'deepseek-flash', String(reqOf('/v1/chat/completions')?.body?.model));
ok('改写带中文提示（写明为什么改、去哪里改）', /deepseek-flash/.test(String(llm1.modelNote)) && /官方/.test(String(llm1.modelNote)), String(llm1.modelNote).slice(0, 120));
ok('响应里缺模型名时给出可读提示（不再静默回填请求模型名）',
  llm1.model === 'deepseek-flash' && /没有返回模型名/.test((llm1.notes || []).join(' ')), (llm1.notes || []).join(' | ').slice(0, 150));
ok('llmStatus 同时给出「实际会发的模型」与「配置里写的模型」，便于界面提示',
  llmMod.llmStatus().model === 'deepseek-flash' && llmMod.llmStatus().configuredModel === 'deepseek-chat'
  && /官方/.test(String(llmMod.llmStatus().modelNote)), JSON.stringify({ model: llmMod.llmStatus().model, configured: llmMod.llmStatus().configuredModel }));

resetReq();
setCfg({ llm: { provider: 'deepseek', baseUrl: BASE, apiKey: 'sk-ds', model: 'deepseek-v4-pro', temperature: 0.5, maxTokens: 128, timeoutMs: 5000 } });
const llm2 = await llmMod.chat({ prompt: '你好', retries: 0 });
ok('官方现行模型 deepseek-v4-pro 原样透传（需要更强推理时的取舍项，不触发改名提示）',
  reqOf('/v1/chat/completions')?.body?.model === 'deepseek-v4-pro' && llm2.requestedModel === 'deepseek-v4-pro'
  && !/不在 DeepSeek 官方现行模型列表/.test(String(llm2.modelNote)),
  `${reqOf('/v1/chat/completions')?.body?.model} / 改名提示=${/不在 DeepSeek/.test(String(llm2.modelNote)) ? '有' : '无'}`);
ok('非 DeepSeek 端点不受改名规则影响（第三方 OpenAI 兼容端点原样使用）',
  llmMod.resolveLlmModel('deepseek-chat', { cfg: { provider: 'openai', baseUrl: 'https://api.siliconflow.cn/v1' } }).model === 'deepseek-chat');

resetReq();
setCfg({ llm: { provider: 'deepseek', baseUrl: BASE, apiKey: 'sk-ds', model: '', temperature: 0.5, maxTokens: 128, timeoutMs: 5000 } });
const llm3 = await llmMod.chat({ prompt: '你好', retries: 0 });
ok('未配置模型名时兜底用官方现行 deepseek-flash（而不是发出空 model）',
  reqOf('/v1/chat/completions')?.body?.model === 'deepseek-flash' && /deepseek-flash/.test(String(llm3.modelNote)), String(reqOf('/v1/chat/completions')?.body?.model));

resetReq();
state.llmModelEcho = 'deepseek-flash-lite';
setCfg({ llm: { provider: 'deepseek', baseUrl: BASE, apiKey: 'sk-ds', model: 'deepseek-flash', temperature: 0.5, maxTokens: 128, timeoutMs: 5000 } });
const llm4 = await llmMod.chat({ prompt: '你好', retries: 0 });
ok('厂商回显了与请求不同的模型名时，按厂商返回记录并提示（便于发现别名/降级）',
  llm4.model === 'deepseek-flash-lite' && /实际使用的模型/.test((llm4.notes || []).join(' ')), (llm4.notes || []).join(' | ').slice(0, 140));

resetReq();
setCfg({ llm: { provider: 'deepseek', baseUrl: BASE, apiKey: 'sk-ds', model: 'deepseek-flash', temperature: 0.5, maxTokens: 128, timeoutMs: 5000 } });
const llmThinkOff = await llmMod.chat({ prompt: '你好', retries: 0 });
ok('官方出处（文档 1.1）：deepseek-flash 默认会思考，思考 token 计入 max_tokens → 默认关思考以保住正文额度',
  reqOf('/v1/chat/completions')?.body?.thinking?.type === 'disabled'
  && (llmThinkOff.notes || []).some((n) => /thinking\.type=disabled/.test(n)), JSON.stringify(reqOf('/v1/chat/completions')?.body?.thinking));

resetReq();
setCfg({ llm: { provider: 'deepseek', baseUrl: BASE, apiKey: 'sk-ds', model: 'deepseek-flash', temperature: 0.5, maxTokens: 128, timeoutMs: 5000, thinking: true } });
await llmMod.chat({ prompt: '你好', retries: 0 });
ok('要思考时显式打开：llm.thinking=true → thinking.type=enabled（可再配 reasoning_effort）',
  reqOf('/v1/chat/completions')?.body?.thinking?.type === 'enabled', JSON.stringify(reqOf('/v1/chat/completions')?.body?.thinking));

resetReq();
setCfg({ llm: { provider: 'openai', baseUrl: BASE, apiKey: 'sk-x', model: 'gpt-4o', temperature: 0.5, maxTokens: 128, timeoutMs: 5000 } });
await llmMod.chat({ prompt: '你好', retries: 0 });
ok('非 DeepSeek 端点不注入 thinking 字段（避免第三方 OpenAI 兼容端点因未知参数 400）',
  !('thinking' in (reqOf('/v1/chat/completions')?.body || {})),
  JSON.stringify(Object.keys(reqOf('/v1/chat/completions')?.body || {})));

// ════════════════ 1c. 错误归类修正（P0-ERR：403 细分 + model_not_found 不再可重试）════════════════
// 追加断言（不改动上面任何既有断言）：①403 的「欠费/额度」与「鉴权」必须分成 quota / auth 两类；
// ②被包成 503 的 model_not_found 必须归 model 且不可重试（否则付费接口白跑 2 次）。
console.log('\n【1c】错误归类修正：403 欠费 vs 鉴权 · model_not_found 不重试');

const 欠费403 = retry.classifyError(Object.assign(new Error('出图接口 403: {"code":"AccountOverdueError","message":"Arrearage"}'), { status: 403 }));
ok('403 欠费（AccountOverdueError / Arrearage）→ quota（细分前会被误归成 auth），且不可自动重试',
  欠费403.kind === 'quota' && 欠费403.retryable === false, `${欠费403.kind} / retryable=${欠费403.retryable}`);

const 无权限403 = retry.classifyError(Object.assign(new Error('出图接口 403: AccessDenied'), { status: 403 }));
ok('403 AccessDenied（非额度类）→ 仍归 auth，不可自动重试（既有行为不变）',
  无权限403.kind === 'auth' && 无权限403.retryable === false, `${无权限403.kind} / retryable=${无权限403.retryable}`);

const 额度关键词 = ['insufficient balance：余额不足', '您的账户已欠费，请充值', 'quota exceeded', '3001 requested resource not granted']
  .map((m) => retry.classifyError(new Error(m)));
ok('额度/欠费关键词全覆盖：insufficient / balance / quota / 欠费 / 余额 / resource not granted → 一律 quota 且不可重试',
  额度关键词.every((c) => c.kind === 'quota' && c.retryable === false), 额度关键词.map((c) => c.kind).join(','));

const 模型503 = retry.classifyError(Object.assign(new Error('出图接口 503: model_not_found'), { status: 503 }));
ok('model_not_found 被厂商包成 503 → 归 model（细分前落进可重试的 server，会白跑 2 次），不可重试',
  模型503.kind === 'model' && 模型503.retryable === false, `${模型503.kind} / retryable=${模型503.retryable} / status=${模型503.status}`);

const 模型族 = ['404 ModelNotOpen', 'InvalidEndpointOrModel.NotFound', 'UnsupportedModel: 不支持的模型'].map((m) => retry.classifyError(new Error(m)));
ok('模型/端点不存在家族（ModelNotOpen / InvalidEndpointOrModel / UnsupportedModel）→ 一律 model 且不可重试',
  模型族.every((c) => c.kind === 'model' && c.retryable === false), 模型族.map((c) => `${c.kind}:${c.retryable}`).join(','));

ok('可重试集合 RETRY_KINDS 不含 quota / auth / model，仍为 rate / server / network',
  Array.isArray(retry.RETRY_KINDS) && retry.RETRY_KINDS.join(',') === 'rate,server,network'
  && !['quota', 'auth', 'model'].some((k) => retry.RETRY_KINDS.includes(k)), JSON.stringify(retry.RETRY_KINDS));

ok('三种网络/服务端类错误仍可自动重试（429 / 5xx / network / timeout 未被误伤）',
  retry.classifyError(Object.assign(new Error('x'), { status: 429 })).retryable === true
  && retry.classifyError(Object.assign(new Error('x'), { status: 500 })).retryable === true
  && retry.classifyError(Object.assign(new Error('x'), { status: 503 })).retryable === true
  && retry.classifyError(new Error('fetch failed')).retryable === true
  && retry.classifyError(new Error('请求超时')).retryable === true,
  `${retry.ERROR_KINDS.rate.retryable}/${retry.ERROR_KINDS.server.retryable}/${retry.ERROR_KINDS.network.retryable}`);

ok('两个新类别都有中文标签，并写明「不自动重试」与下一步（充值/提额 · 检查模型名/开通状态）',
  /额度\/欠费/.test(欠费403.label) && /不自动重试/.test(欠费403.label) && /充值|提额/.test(欠费403.label)
  && /模型不可用/.test(模型503.label) && /不自动重试/.test(模型503.label) && /模型名|开通/.test(模型503.label),
  `${欠费403.label} ｜ ${模型503.label}`);

// 端到端（纯本地重试循环，不触碰任何厂商接口）：新类别必须「一次即返回」，可重试类别照旧重试
let 欠费调用 = 0;
try { await retry.withRetry(async () => { 欠费调用 += 1; throw Object.assign(new Error('403 Arrearage 欠费'), { status: 403 }); }, { retries: 5, baseMs: 1 }); } catch { /* 预期抛出 */ }
let 模型调用 = 0;
try { await retry.withRetry(async () => { 模型调用 += 1; throw Object.assign(new Error('503 model_not_found'), { status: 503 }); }, { retries: 5, baseMs: 1 }); } catch { /* 预期抛出 */ }
ok('端到端：quota / model 在 withRetry 下只尝试 1 次（不给付费接口白跑重试）', 欠费调用 === 1 && 模型调用 === 1, `欠费=${欠费调用} 次 / 模型=${模型调用} 次`);

let 限流调用 = 0;
try { await retry.withRetry(async () => { 限流调用 += 1; throw Object.assign(new Error('429 rate limit'), { status: 429 }); }, { retries: 2, baseMs: 1 }); } catch { /* 预期抛出 */ }
ok('端到端对照：rate（429）仍按 retries=2 重试到 3 次（重试能力没被改坏）', 限流调用 === 3, `限流=${限流调用} 次`);


// ════════════════ 13. 鉴权头打通到配置层（config 默认值 / tts 接入 / 前缀口径 / 非法值拦截） ════════════════
// 为什么补这一节：src/image.js（以及复用它的 src/video.js）早就读 image.generic.authHeader/authPrefix，
// 但 config.js 没有默认值、PUT /api/settings 白名单不放行、设置页没有输入框、src/tts.js 完全没接
// —— 结果是「代码支持、用户配不到」。这一节把「默认请求头不变」与「配到了就生效」两头都钉死。
console.log('\n【13】鉴权头配置层：默认值 / 前缀生效 / 非法值拦截不落盘');

const { DEFAULT_CONFIG } = await import('../src/config.js');

ok('config.js 默认值补齐：image / video / tts 的 generic 段都带 authHeader=Authorization + authPrefix="Bearer "',
  ['image', 'video', 'tts'].every((k) => DEFAULT_CONFIG[k]?.generic?.authHeader === 'Authorization' && DEFAULT_CONFIG[k]?.generic?.authPrefix === 'Bearer '),
  ['image', 'video', 'tts'].map((k) => `${k}=${JSON.stringify(DEFAULT_CONFIG[k]?.generic?.authHeader)}/${JSON.stringify(DEFAULT_CONFIG[k]?.generic?.authPrefix)}`).join('　'));

// ---- 13.1 默认值不改变既有请求头 ----
// 参照物：authHeader 写成空串 → 走的就是改造前唯一存在的那条「未配置 → 不注入自定义头」老分支。
// 把两次请求**收到的完整请求头**逐键比对，才算真的证明「默认值让现有请求头一字不变」。
const hdrSnapshot = (p) => Object.fromEntries(Object.entries(reqOf(p)?.headers || {}).sort(([a], [b]) => a.localeCompare(b)));
const hdrDiff = (a, b) => Object.keys({ ...a, ...b }).filter((k) => a[k] !== b[k]).map((k) => `${k}: ${JSON.stringify(a[k])} → ${JSON.stringify(b[k])}`);

resetReq();
setCfg({ image: { ...IMG_GENERIC.image, generic: { ...IMG_GENERIC.image.generic, authHeader: '', authPrefix: '' } } });
await generateImage({ actorId: 'C-0030', kind: 'face', variant: 'front', prompt: '鉴权头基线' });
const imgHdrLegacy = hdrSnapshot('/vendor/txt2img');
resetReq();
setCfg({ image: IMG_GENERIC.image });      // 不写 authHeader/authPrefix → 由 config.js 新默认值兜底
await generateImage({ actorId: 'C-0030', kind: 'face', variant: 'front', prompt: '鉴权头基线' });
const imgHdrDefault = hdrSnapshot('/vendor/txt2img');
ok('默认值下出图请求头逐字节不变（默认 Authorization + "Bearer " 与改造前那条老分支收到的头完全一致）',
  imgHdrLegacy.authorization === 'Bearer sk-vendor-test' && hdrDiff(imgHdrLegacy, imgHdrDefault).length === 0,
  `Authorization=${imgHdrDefault.authorization}｜差异=${hdrDiff(imgHdrLegacy, imgHdrDefault).join('、') || '无'}`);

resetReq();
setCfg({ video: { ...VIDEO_GENERIC.video, generic: { ...VIDEO_GENERIC.video.generic, authHeader: '', authPrefix: '' } } });
await generateVideo({ scriptId: 'SC-A', code: 'S01E001', shotId: 'SH-B1', prompt: '鉴权头基线', duration: 3 });
const vidHdrLegacy = hdrSnapshot('/vendor/video');
resetReq();
setCfg({ video: VIDEO_GENERIC.video });
await generateVideo({ scriptId: 'SC-A', code: 'S01E001', shotId: 'SH-B1', prompt: '鉴权头基线', duration: 3 });
const vidHdrDefault = hdrSnapshot('/vendor/video');
ok('默认值下视频请求头逐字节不变（src/video.js 复用同一套 applyAuthHeader，默认口径同样零影响）',
  vidHdrLegacy.authorization === 'Bearer sk-video-test' && hdrDiff(vidHdrLegacy, vidHdrDefault).length === 0,
  `Authorization=${vidHdrDefault.authorization}｜差异=${hdrDiff(vidHdrLegacy, vidHdrDefault).join('、') || '无'}`);

resetReq();
setCfg({ tts: { backend: 'generic-http', format: 'mp3', speed: 1, generic: { ...TTS_GENERIC, authHeader: '', authPrefix: '' } } });
await synthesize({ text: '鉴权头基线。', outKey: 'S01E001_auth01' });
const ttsHdrLegacy = hdrSnapshot('/vendor/tts');
resetReq();
setCfg({ tts: { backend: 'generic-http', format: 'mp3', speed: 1, generic: TTS_GENERIC } });
await synthesize({ text: '鉴权头基线。', outKey: 'S01E001_auth01' });
const ttsHdrDefault = hdrSnapshot('/vendor/tts');
ok('默认值下通用配音请求头逐字节不变（src/tts.js 新接入的鉴权头与请求头模板里那行渲染结果完全一致）',
  ttsHdrLegacy.authorization === 'Bearer sk-tts-x' && hdrDiff(ttsHdrLegacy, ttsHdrDefault).length === 0,
  `Authorization=${ttsHdrDefault.authorization}｜差异=${hdrDiff(ttsHdrLegacy, ttsHdrDefault).join('、') || '无'}`);

resetReq();
setCfg({ tts: { backend: 'openai', format: 'mp3', openai: { baseUrl: BASE, apiKey: 'sk-tts-test', path: '/v1/audio/speech', model: 'tts-1', voice: 'alloy' } } });
await synthesize({ text: '鉴权头基线。', outKey: 'S01E001_auth02' });
const oaHdr = hdrSnapshot('/v1/audio/speech');
ok('openai 配音路默认输出不变：仍是改造前硬编码的 authorization: Bearer <key>，不多不少',
  oaHdr.authorization === 'Bearer sk-tts-test' && oaHdr['content-type'] === 'application/json' && Object.keys(oaHdr).filter((k) => /auth/i.test(k)).length === 1,
  JSON.stringify({ authorization: oaHdr.authorization, 'content-type': oaHdr['content-type'] }));

// ---- 13.2 前缀 / 头名真的可配（Vidu `Token ` / 火山语音 `Bearer;` / ElevenLabs `xi-api-key`）----
resetReq();
setCfg({ tts: { backend: 'generic-http', format: 'mp3', speed: 1, generic: { ...TTS_GENERIC, authHeader: 'Authorization', authPrefix: 'Token ' } } });
await synthesize({ text: '生数 Vidu 口径。', outKey: 'S01E001_auth03' });
ok('authPrefix 生效：Token 前缀 → Authorization: Token <key>（生数 Vidu 官方口径，前缀不是 Bearer）',
  reqOf('/vendor/tts')?.headers?.authorization === 'Token sk-tts-x', String(reqOf('/vendor/tts')?.headers?.authorization));

resetReq();
setCfg({ tts: { backend: 'generic-http', format: 'mp3', speed: 1, generic: { ...TTS_GENERIC, authHeader: 'Authorization', authPrefix: 'Bearer;' } } });
await synthesize({ text: '火山语音口径。', outKey: 'S01E001_auth04' });
ok('火山语音 V1 的分号坑可用：authPrefix "Bearer;" → Authorization: Bearer;<token>（官方是分号不是空格）',
  reqOf('/vendor/tts')?.headers?.authorization === 'Bearer;sk-tts-x', String(reqOf('/vendor/tts')?.headers?.authorization));

resetReq();
setCfg({ tts: { backend: 'generic-http', format: 'mp3', speed: 1, generic: { ...TTS_GENERIC, authHeader: 'xi-api-key', authPrefix: '' } } });
await synthesize({ text: 'ElevenLabs 口径。', outKey: 'S01E001_auth05' });
ok('自定义头名可用：authHeader "xi-api-key" + 空前缀 → 只发 xi-api-key，不会再多发一个 Authorization',
  reqOf('/vendor/tts')?.headers?.['xi-api-key'] === 'sk-tts-x' && !reqOf('/vendor/tts')?.headers?.authorization,
  JSON.stringify({ xi: reqOf('/vendor/tts')?.headers?.['xi-api-key'], authorization: reqOf('/vendor/tts')?.headers?.authorization }));

resetReq();
setCfg({ tts: { backend: 'openai', format: 'mp3', openai: { baseUrl: BASE, apiKey: 'sk-tts-test', path: '/v1/audio/speech', authHeader: 'Authorization', authPrefix: 'Token ' } } });
await synthesize({ text: 'openai 路换口径。', outKey: 'S01E001_auth06' });
ok('openai 配音路原本硬编码的 Bearer 已改为可配：显式配 Token 前缀后发的是 Token（不配则仍是 Bearer）',
  reqOf('/v1/audio/speech')?.headers?.authorization === 'Token sk-tts-test',
  `收到的 Authorization=${reqOf('/v1/audio/speech')?.headers?.authorization}`);

// ---- 13.3 PUT /api/settings：白名单放行 + 非法值中文 400 且整体不落盘 ----
const { createApp, createServer } = await import('../src/http.js');
const { registerMetaRoutes } = await import('../src/routes/meta.js');
const { app: metaApp, handle: metaHandle } = createApp();
registerMetaRoutes(metaApp);
const apiServer = createServer(metaHandle);
await new Promise((r) => apiServer.listen(0, '127.0.0.1', r));
const API = `http://127.0.0.1:${apiServer.address().port}`;
const putSettings = async (patch) => {
  const r = await fetch(`${API}/api/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
  return { status: r.status, body: await r.json() };
};
const getSettings = async () => (await (await fetch(`${API}/api/settings`)).json()).settings;
const cfgText = () => fs.readFileSync(CFG, 'utf8');

setCfg({ image: IMG_GENERIC.image, video: VIDEO_GENERIC.video, tts: { backend: 'generic-http', generic: TTS_GENERIC } });
const cfgBefore = cfgText();

// 非法请求里故意夹带一个**合法**字段（url），验证「整体不落盘」而不是「只挡坏字段」
const bad1 = await putSettings({ image: { generic: { url: 'https://should-not-be-saved.example.com/x', authHeader: 'Authorization\r\nX-Injected' } } });
ok('非法 authHeader（含换行，CRLF 头注入）被拒：中文 400 + 同请求里的合法字段也不落盘（整体不落盘）',
  bad1.status === 400 && /authHeader/.test(bad1.body.error || '') && /[\u4e00-\u9fa5]/.test(bad1.body.error || '') && cfgText() === cfgBefore,
  `HTTP ${bad1.status}｜${String(bad1.body.error || '').slice(0, 110)}｜配置文件未变=${cfgText() === cfgBefore}`);

const bad2 = await putSettings({ tts: { generic: { authPrefix: 'x'.repeat(33) } } });
ok('非法 authPrefix（超 32 字符）被拒：中文 400 且不落盘',
  bad2.status === 400 && /authPrefix/.test(bad2.body.error || '') && /32/.test(bad2.body.error || '') && cfgText() === cfgBefore,
  `HTTP ${bad2.status}｜${String(bad2.body.error || '').slice(0, 110)}`);

const bad3 = await putSettings({ video: { generic: { authHeader: 'X Api Key' } } });
ok('非法 authHeader（含空格等非 [A-Za-z0-9-] 字符）被拒：中文 400 且不落盘',
  bad3.status === 400 && /authHeader/.test(bad3.body.error || '') && /非法字符/.test(bad3.body.error || '') && cfgText() === cfgBefore,
  `HTTP ${bad3.status}｜${String(bad3.body.error || '').slice(0, 110)}`);

const bad4 = await putSettings({ image: { generic: { authHeader: 123 } } });
ok('非法 authHeader（不是字符串）被拒：中文 400 且不落盘',
  bad4.status === 400 && /必须是字符串/.test(bad4.body.error || '') && cfgText() === cfgBefore,
  `HTTP ${bad4.status}｜${String(bad4.body.error || '').slice(0, 110)}`);

const badAfter = await getSettings();
ok('连续 4 次非法 PUT 之后，GET /api/settings 里这三个键仍是默认值（没有写进去一半）',
  badAfter.image.generic.authHeader === 'Authorization' && badAfter.image.generic.authPrefix === 'Bearer '
  && badAfter.video.generic.authHeader === 'Authorization' && badAfter.tts.generic.authPrefix === 'Bearer ',
  JSON.stringify({ image: [badAfter.image.generic.authHeader, badAfter.image.generic.authPrefix], video: badAfter.video.generic.authHeader, tts: badAfter.tts.generic.authPrefix }));

const good1 = await putSettings({ image: { generic: { authHeader: 'Authorization', authPrefix: 'Token ' } } });
const readBack = await getSettings();
ok('合法值放行：PUT authHeader/authPrefix → 200，且能 GET 读回（用户终于配得到了）',
  good1.status === 200 && readBack.image.generic.authHeader === 'Authorization' && readBack.image.generic.authPrefix === 'Token '
  && JSON.parse(cfgText()).image.generic.authPrefix === 'Token ',
  `HTTP ${good1.status}｜读回 ${JSON.stringify({ authHeader: readBack.image.generic.authHeader, authPrefix: readBack.image.generic.authPrefix })}`);

const good2 = await putSettings({ video: { generic: { authPrefix: 'Bearer;' } }, tts: { generic: { authHeader: 'xi-api-key', authPrefix: '' } } });
const readBack2 = await getSettings();
ok('三处 generic 全部放行：视频写 Bearer;（分号）、配音写 xi-api-key + 空前缀，都能读回',
  good2.status === 200 && readBack2.video.generic.authPrefix === 'Bearer;'
  && readBack2.tts.generic.authHeader === 'xi-api-key' && readBack2.tts.generic.authPrefix === '',
  JSON.stringify({ video: readBack2.video.generic.authPrefix, tts: [readBack2.tts.generic.authHeader, readBack2.tts.generic.authPrefix] }));

ok('GET /api/settings 不泄露 Key 明文（新增的两栏只是头名/前缀，本身不含密钥）',
  readBack2.image.generic.apiKey === '****' && !/sk-/.test(JSON.stringify(readBack2.image.generic.authHeader))
  && !/sk-/.test(JSON.stringify(readBack2.tts.generic.authHeader)),
  `image.generic.apiKey=${readBack2.image.generic.apiKey}`);

// ════════════════ 14. 参考图「真实类型」与 SVG 栅格化（2026-09-30 百炼 400 实测回归）════════════════
// 现场故障：演员定妆走参考生图（useRef），而占位后端的定妆图是 **SVG**；通用出图把 data URL 硬编码成
// `data:image/png;base64,…`，声明类型与内容不符 → 百炼（DashScope）回
//   400 InvalidParameter: Cannot determine file type for http://ds-restful-…oss…/data-uri/…
// 这一节把「按魔数定类型 + SVG 先栅格化 + 用不了就降级文生图」三条钉死（全程本地假服务端，零付费）。
console.log('\n【14】参考图真实类型与 SVG 栅格化');
const { sniffImageMime, readImageForVendor } = await import('../src/util.js');
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
ok('魔数嗅探：PNG → image/png', sniffImageMime(Buffer.from(PNG_B64, 'base64')) === 'image/png');
ok('魔数嗅探：JPEG → image/jpeg', sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])) === 'image/jpeg');
ok('魔数嗅探：WebP → image/webp', sniffImageMime(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])) === 'image/webp');
ok('魔数嗅探：SVG 文本 → image/svg+xml（不看扩展名）', sniffImageMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')) === 'image/svg+xml');
ok('魔数嗅探：非图片内容 → null（按「厂商不支持」处理，而不是硬说成 png）', sniffImageMime(Buffer.from('这不是图片，只是一段文本')) === null);

const svgRef = path.join(DATA_TMP, 'ref-src.svg');
fs.writeFileSync(svgRef, '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#123456"/></svg>');
const prepSvg = readImageForVendor(svgRef);
ok('readImageForVendor：SVG 被本机栅格化为真 PNG（首 8 字节是 PNG 魔数）',
  prepSvg.ok && prepSvg.mime === 'image/png' && prepSvg.rasterized === true
  && Buffer.from(prepSvg.base64, 'base64').subarray(0, 8).equals(PNG_MAGIC),
  `mime=${prepSvg.mime} rasterized=${prepSvg.rasterized} 首字节=${Buffer.from(prepSvg.base64, 'base64').subarray(0, 4).toString('hex')}`);
ok('readImageForVendor：栅格化给出中文说明（便于落库留痕）', /栅格化/.test(prepSvg.note), prepSvg.note.slice(0, 90));
// cacheDir 必须真的生效：调用方（src/image.js / src/video.js）会传 DATA_DIR/cache/refs，
// 若被忽略就会落到系统临时目录 —— 那样「清理缓存」「磁盘占用」都管不到它（本轮实测踩过这个坑）
{
  const cacheDir = path.join(DATA_TMP, 'cache', 'refs');
  const prepCached = readImageForVendor(svgRef, { cacheDir });
  ok('readImageForVendor：cacheDir 参数真的生效（栅格化落盘到指定目录，而不是系统临时目录）',
    prepCached.ok && prepCached.rasterized === true && path.dirname(prepCached.abs) === cacheDir && fs.existsSync(prepCached.abs),
    `${prepCached.abs}（期望目录 ${cacheDir}）`);
}
ok('readImageForVendor：栅格化按内容哈希缓存（第二次命中缓存不再调 ffmpeg）', readImageForVendor(svgRef).abs === prepSvg.abs, prepSvg.abs);
const prepTxtPath = path.join(DATA_TMP, 'not-image.bin');
fs.writeFileSync(prepTxtPath, '这不是图片，只是一段文本');
const prepTxt = readImageForVendor(prepTxtPath);
ok('readImageForVendor：魔数认不出时不猜也不丢 —— 按扩展名如实声明类型照发（ok:true），并在 note 写明可能被拒绝',
  prepTxt.ok === true && prepTxt.mime === 'application/octet-stream' && prepTxt.base64.length > 0 && /可能拒绝/.test(prepTxt.note),
  `mime=${prepTxt.mime} note=${prepTxt.note.slice(0, 70)}`);
const mp4Like = path.join(DATA_TMP, 'clip-ref.mp4');
fs.writeFileSync(mp4Like, Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(64, 3)]));
const prepMp4 = readImageForVendor(mp4Like);
ok('readImageForVendor：非图片（如 mp4）也不会被静默丢成空串（否则调用方会「静默丢尾帧」）',
  prepMp4.ok === true && prepMp4.mime === 'video/mp4' && prepMp4.base64.length > 0,
  `mime=${prepMp4.mime} base64=${prepMp4.base64.length}B`);

// 14.1 出图：SVG 参考图 → 栅格化成 PNG 后发送，且不再声明成 image/png 却发 SVG 字节
resetReq();
setCfg({ image: { ...IMG_GENERIC.image, generic: { ...IMG_GENERIC.image.generic, refImageFormat: 'dataurl', refImageField: 'image' } } });
const imgSvg = await generateImage({ actorId: 'C-0001', kind: 'costume', variant: 'svg-ref', prompt: 'svg ref', refImage: svgRef });
const svgSent = String(state.lastRequest?.body?.image || '');
ok('出图·SVG 参考图：发出的 data URL 里是真 PNG 字节（不是 SVG 冒充 PNG）',
  svgSent.startsWith('data:image/png;base64,') && Buffer.from(svgSent.split(',')[1] || '', 'base64').subarray(0, 8).equals(PNG_MAGIC),
  svgSent.slice(0, 30));
ok('出图·SVG 参考图：结果留痕 refImageRasterized=true / refImageMime=image/png / usedTemplate=i2i',
  imgSvg.refImageRasterized === true && imgSvg.refImageMime === 'image/png' && imgSvg.usedTemplate === 'i2i',
  JSON.stringify({ rasterized: imgSvg.refImageRasterized, mime: imgSvg.refImageMime, used: imgSvg.usedTemplate }));
ok('出图·SVG 参考图：notes 里有中文栅格化说明', (imgSvg.notes || []).some((n) => /栅格化/.test(n)), (imgSvg.notes || []).join(' | ').slice(0, 110));

// 14.2 出图：JPEG 参考图 → 声明成 image/jpeg（不再一律谎报 png）
resetReq();
const jpgRef = path.join(DATA_TMP, 'ref-src.jpg');
fs.writeFileSync(jpgRef, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]), Buffer.alloc(64, 7)]));
const imgJpg = await generateImage({ actorId: 'C-0001', kind: 'costume', variant: 'jpg-ref', prompt: 'jpg ref', refImage: jpgRef });
ok('出图·JPEG 参考图：data URL 声明为 image/jpeg（按真实类型，不写死 png）',
  String(state.lastRequest?.body?.image || '').startsWith('data:image/jpeg;base64,') && imgJpg.refImageMime === 'image/jpeg',
  String(state.lastRequest?.body?.image || '').slice(0, 30));
ok('出图·JPEG 参考图：没有多余栅格化（本来就能直接发）', imgJpg.refImageRasterized === false, String(imgJpg.refImageRasterized));

// 14.3 出图：魔数认不出的参考图 → 不静默改语义，按扩展名声明类型照发（并在 notes 提示风险）
resetReq();
const badRef = path.join(DATA_TMP, 'not-image.bin');
fs.writeFileSync(badRef, '这不是图片，只是一段文本');
const imgBad = await generateImage({ actorId: 'C-0001', kind: 'costume', variant: 'bad-ref', prompt: 'bad ref', refImage: badRef });
ok('出图·坏参考图：不静默降级文生图（仍按参考图发送，refImageSent=true）',
  imgBad.ok === true && imgBad.refImageSent === true && imgBad.usedTemplate === 'i2i',
  JSON.stringify({ ok: imgBad.ok, used: imgBad.usedTemplate, sent: imgBad.refImageSent }));
ok('出图·坏参考图：出站请求里确实带了参考图，且声明类型不是谎报的 image/png',
  String(state.lastRequest?.body?.image || '').startsWith('data:application/octet-stream;base64,'),
  String(state.lastRequest?.body?.image || '(空)').slice(0, 46));
ok('出图·坏参考图：notes 写明「类型无法从文件头识别…厂商可能拒绝」（把不确定性摊开给用户）',
  (imgBad.notes || []).some((n) => /可能拒绝/.test(n)), (imgBad.notes || []).join(' | ').slice(0, 120));

// 14.3b SVG 栅格化失败时：明确报中文错，不「假装没给参考图」（静默改语义比报错更难查）
const brokenSvg = path.join(DATA_TMP, 'broken.svg');
fs.writeFileSync(brokenSvg, '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>');
const utilMod = await import('../src/util.js');
const realSpawn = utilMod.rasterizeSvgToPng;
{
  // 用「图片目录不可写路径」逼迫 ffmpeg 失败：把缓存目录指向一个已存在的普通文件
  const notADir = path.join(DATA_TMP, 'not-a-dir');
  fs.writeFileSync(notADir, 'x');
  const rasterFail = realSpawn(brokenSvg, { cacheDir: notADir });
  ok('rasterizeSvgToPng：失败时返回 ok:false + 原因（不抛异常、不静默）',
    rasterFail.ok === false && typeof rasterFail.error === 'string' && rasterFail.error.length > 0, String(rasterFail.error).slice(0, 80));
}

// 14.4 视频：首帧（关键帧）是 SVG 占位图时同口径栅格化
resetReq();
setCfg({ video: { ...VIDEO_GENERIC.video, generic: { ...VIDEO_GENERIC.video.generic, refImageFormat: 'dataurl', bodyTemplate: '{"model":"{{model}}","prompt":"{{prompt}}","image":"{{refImage}}","duration":{{duration}}}' } } });
const vidSvg = await generateVideo({ scriptId: 'SC-A', code: 'S01E001', shotId: 'SH-SVG', prompt: 'svg keyframe', duration: 3, keyframe: svgRef });
const vidSent = String(reqOf('/vendor/video')?.body?.image || '');
ok('视频·SVG 首帧：同样按真实类型处理，发出的是真 PNG 字节',
  vidSvg?.ok === true && vidSent.startsWith('data:image/png;base64,') && Buffer.from(vidSent.split(',')[1] || '', 'base64').subarray(0, 8).equals(PNG_MAGIC),
  vidSent.slice(0, 30));
ok('视频·SVG 首帧：notes 里有中文栅格化说明', (vidSvg?.notes || []).some((n) => /栅格化/.test(n)), (vidSvg?.notes || []).join(' | ').slice(0, 110));

await new Promise((r) => apiServer.close(r));

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
server.close();
try {
  fs.rmSync(DB, { force: true }); fs.rmSync(DB + '-wal', { force: true }); fs.rmSync(DB + '-shm', { force: true });
  fs.rmSync(DATA_TMP, { recursive: true, force: true }); fs.rmSync(CFG, { force: true });
} catch { /* ignore */ }
process.exit(fail ? 1 : 0);
