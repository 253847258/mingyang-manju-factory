// 按专业角色配置模型 · 自测（纯离线零成本：临时 config/db，不联网、不起服务、不碰真实配置）
// 用法：node tests/test-model-registry.js
// 覆盖：①角色字典完整性（中文名/kind/默认提供方/说明）②resolveModelFor 四级优先级（角色 > 方案 > 既有分段 > 内置默认）
//       ③未知角色 / 未知提供方的中文报错 ④validateModels 的 warn/error 分档（缺模型名 / kind 不匹配 / 缺 Key / 缺接口地址）
//       ⑤三套内置方案覆盖全部角色 ⑥applyProfile 不改磁盘也不改入参 ⑦config.js 新 models 段与既有段兼容
//       ⑧PUT /api/settings 的 models 段白名单清洗（结构与取值校验、中文报错、掩码不覆盖真 Key）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-models-'));
const DATA_TMP = path.join(TMP, 'data');
process.env.FACTORY_DATA_DIR = DATA_TMP;
process.env.FACTORY_DB = path.join(TMP, 'models.db');
process.env.FACTORY_CONFIG = path.join(TMP, 'config.json');
fs.mkdirSync(DATA_TMP, { recursive: true });
// 初始配置：只有 llm 段（模拟真实项目里已经存在的配置），models 段应由 DEFAULT_CONFIG 补齐
fs.writeFileSync(process.env.FACTORY_CONFIG, JSON.stringify({
  llm: { provider: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: '', model: 'deepseek-chat', temperature: 0.85 },
}), 'utf8');

const { migrate } = await import('../src/db.js');
const { DEFAULT_CONFIG, loadConfig, saveConfig, publicConfig } = await import('../src/config.js');
const MR = await import('../src/model-registry.js');

migrate();

let pass = 0;
let fail = 0;
const ok = (name, cond, evidence = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${evidence ? `  ← ${evidence}` : ''}`); }
  else { fail++; console.error(`  ✗ ${name}  ← ${evidence}`); }
};
const throws = (fn, re) => {
  try { fn(); return { threw: false, msg: '' }; }
  catch (e) { const m = String(e?.message || e); return { threw: true, msg: m, match: re ? re.test(m) : true }; }
};
const clone = (v) => JSON.parse(JSON.stringify(v));
/** 基础配置：既有分段齐全 + 空的角色层 + 内置三套方案（env 一律传 {}，保证缺 Key 判定不受宿主机环境影响） */
const baseCfg = (over = {}) => {
  const c = clone(DEFAULT_CONFIG);
  c.models = { activeProfile: '', roles: {}, profiles: clone(DEFAULT_CONFIG.models.profiles), ...(over.models || {}) };
  c.llm = { ...c.llm, provider: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: '', model: 'deepseek-chat', temperature: 0.85, ...(over.llm || {}) };
  c.image = { ...c.image, backend: 'placeholder', ...(over.image || {}) };
  c.video = { ...c.video, backend: 'placeholder', ...(over.video || {}) };
  c.tts = { ...c.tts, backend: 'none', ...(over.tts || {}) };
  return c;
};
const NO_ENV = { env: {} };
const resolve = (role, cfg) => MR.resolveModelFor(role, cfg, NO_ENV);
const issueFor = (v, role, re) => v.issues.find((i) => i.role === role && re.test(i.message));

// ---------------- ① 角色字典 ----------------
console.log('=== 1. 角色字典完整性 ===');
{
  const ids = MR.ROLES.map((r) => r.id);
  const required = ['outline', 'chapter', 'script', 'storyboard', 'promptOpt', 'brief', 'keyframe', 'refImage', 'firstLast', 'video', 'tts', 'qcVision'];
  ok('角色字典：共 12 个角色且 id 唯一', MR.ROLES.length === 12 && new Set(ids).size === 12, `实际 ${MR.ROLES.length} 个：${ids.join(',')}`);
  ok('角色字典：需求列出的 12 个角色全部存在', required.every((id) => MR.ROLE_MAP[id]), required.filter((id) => !MR.ROLE_MAP[id]).join(',') || '无缺失');
  ok('角色字典：每项都有中文名/合法 kind/已登记默认提供方/中文说明',
    MR.ROLES.every((r) => r.name && /[\u4e00-\u9fff]/.test(r.name) && MR.MODEL_KINDS.includes(r.kind)
      && MR.PROVIDERS[r.defaultProvider] && r.hint && /[\u4e00-\u9fff]/.test(r.hint)),
    MR.ROLES.filter((r) => !(r.name && MR.MODEL_KINDS.includes(r.kind) && MR.PROVIDERS[r.defaultProvider] && r.hint)).map((r) => r.id).join(',') || '全部合规');
  const byKind = (k) => MR.rolesByKind(k).map((r) => r.id);
  ok('角色字典：类别分布正确（6 文本 / 3 图像 / 1 视频 / 1 配音 / 1 多模态）',
    byKind('llm').length === 6 && byKind('image').length === 3 && byKind('video').length === 1 && byKind('tts').length === 1 && byKind('vision').length === 1,
    `llm=${byKind('llm').length} image=${byKind('image').length} video=${byKind('video').length} tts=${byKind('tts').length} vision=${byKind('vision').length}`);
  ok('角色字典：视觉产物与质检角色归类正确',
    ['keyframe', 'refImage', 'firstLast'].every((id) => MR.ROLE_MAP[id].kind === 'image')
      && MR.ROLE_MAP.video.kind === 'video' && MR.ROLE_MAP.tts.kind === 'tts' && MR.ROLE_MAP.qcVision.kind === 'vision');
  ok('提供方字典：每项都声明了支持的类别与中文说明',
    MR.PROVIDER_IDS.every((p) => MR.PROVIDERS[p].kinds.length > 0 && MR.PROVIDERS[p].name && MR.PROVIDERS[p].configHint),
    `提供方 ${MR.PROVIDER_IDS.length} 个`);
}

// ---------------- ⑦ config.js 新段与既有段兼容 ----------------
console.log('=== 2. config.js 新段与既有段兼容 ===');
{
  const d = DEFAULT_CONFIG;
  ok('DEFAULT_CONFIG 新增 models 段（空 roles + 空 activeProfile + 三套方案）',
    Boolean(d.models) && typeof d.models.activeProfile === 'string' && d.models.activeProfile === ''
      && Object.keys(d.models.roles).length === 0 && Object.keys(d.models.profiles).length === 3,
    `roles=${Object.keys(d.models.roles).length} profiles=${Object.keys(d.models.profiles).join('/')}`);
  ok('既有段语义未被改动（端口/LLM/出图/视频/配音默认值与改动前一致）',
    d.server.port === 8788 && d.llm.provider === 'deepseek' && d.llm.model === 'deepseek-chat' && d.llm.temperature === 0.85
      && d.image.backend === 'placeholder' && d.image.defaultRatio === '3:4' && d.video.backend === 'placeholder' && d.tts.backend === 'none',
    `${d.llm.provider}/${d.llm.model} image=${d.image.backend} video=${d.video.backend} tts=${d.tts.backend}`);
  const cfg = loadConfig();
  ok('loadConfig（真实磁盘配置 + 默认值合并）里 models 段就位', cfg.models && Object.keys(cfg.models.profiles).length === 3 && cfg.models.activeProfile === '');
  ok('兼容：默认配置下角色仍回落到既有分段（llm 段的 deepseek/deepseek-chat，来源=既有分段默认）',
    resolve('outline', cfg).provider === 'deepseek' && resolve('outline', cfg).model === 'deepseek-chat' && resolve('outline', cfg).sourceLevel === 'kind',
    `provider=${resolve('outline', cfg).provider} model=${resolve('outline', cfg).model} sourceLevel=${resolve('outline', cfg).sourceLevel}`);
  ok('兼容：默认配置下图像/视频角色回落到 image.backend / video.backend',
    resolve('keyframe', cfg).provider === 'placeholder' && resolve('video', cfg).provider === 'placeholder' && resolve('tts', cfg).provider === 'none');
}

// ---------------- ② resolveModelFor 四级优先级 ----------------
console.log('=== 3. 解析优先级（角色 > 方案 > 既有分段 > 内置默认）===');
{
  // 第 1 级：角色显式设置（同时压过激活的方案）
  const c1 = baseCfg({ models: { activeProfile: '省钱', roles: { outline: { provider: 'openai', model: 'gpt-4o', baseUrl: 'https://api.openai.com', temperature: 1.1, note: '大纲换旗舰' } } } });
  const r1 = resolve('outline', c1);
  ok('优先级①角色显式设置胜过激活的方案', r1.provider === 'openai' && r1.model === 'gpt-4o' && r1.temperature === 1.1 && r1.sourceLevel === 'role',
    `provider=${r1.provider} model=${r1.model} temp=${r1.temperature} level=${r1.sourceLevel}`);
  ok('优先级①source 文案说明来自哪一层（含配置路径）', /角色显式设置/.test(r1.source) && /models\.roles\.outline/.test(r1.source), r1.source);

  // 第 2 级：激活的搭配方案
  const c2 = baseCfg({ models: { activeProfile: '省钱', roles: {} } });
  const r2 = resolve('storyboard', c2);
  ok('优先级②激活的方案覆盖既有分段默认', r2.provider === 'deepseek' && r2.model === 'deepseek-chat' && r2.sourceLevel === 'profile' && /搭配方案/.test(r2.source),
    `provider=${r2.provider} model=${r2.model} level=${r2.sourceLevel} source=${r2.source}`);
  const r2b = resolve('keyframe', c2);
  ok('优先级②方案的图像角色生效（省钱方案走自建 ComfyUI）', r2b.provider === 'comfyui' && r2b.sourceLevel === 'profile', `${r2b.provider} level=${r2b.sourceLevel}`);

  // 第 3 级：该 kind 的既有分段默认
  const c3 = baseCfg({ llm: { provider: 'mock', model: 'mock-template', temperature: 0.4 } });
  const r3 = resolve('chapter', c3);
  ok('优先级③未配角色/方案时回落既有分段默认', r3.provider === 'mock' && r3.model === 'mock-template' && r3.temperature === 0.4 && r3.sourceLevel === 'kind',
    `provider=${r3.provider} model=${r3.model} temp=${r3.temperature} level=${r3.sourceLevel}`);
  ok('优先级③source 文案指出是哪个分段的默认', /既有分段默认/.test(r3.source) && /llm/.test(r3.source), r3.source);

  // 第 4 级：内置默认（连分段都没有）
  const c4 = { models: { activeProfile: '', roles: {}, profiles: {} } };
  const r4 = resolve('outline', c4);
  ok('优先级④角色/方案/分段全空时用角色内置默认', r4.provider === 'deepseek' && r4.model === 'deepseek-chat' && r4.sourceLevel === 'default' && /内置默认/.test(r4.source),
    `provider=${r4.provider} model=${r4.model} level=${r4.sourceLevel}`);
  const r4b = resolve('keyframe', c4);
  ok('优先级④图像角色内置默认为商用出图模型', r4b.provider === 'openai-images' && r4b.model === 'gpt-image-1' && r4b.sourceLevel === 'default', `${r4b.provider}/${r4b.model}`);

  // 逐字段独立判定：provider 来自角色、model 来自方案
  const c5 = baseCfg({ models: { activeProfile: '省钱', roles: { storyboard: { provider: 'openai' } } } });
  const r5 = resolve('storyboard', c5);
  ok('逐字段优先级：provider 取角色层、model 取方案层（各自 source 正确）',
    r5.provider === 'openai' && r5.sources.provider === 'role' && r5.model === 'deepseek-chat' && r5.sources.model === 'profile',
    `provider=${r5.provider}(${r5.sources.provider}) model=${r5.model}(${r5.sources.model})`);
  ok('逐字段优先级：混合来源时 source 逐字段标注、sourceLevel 取最高层',
    r5.sourceLevel === 'role' && /provider←角色显式设置/.test(r5.source) && /model←搭配方案/.test(r5.source), r5.source);

  // baseUrl 必须跟随提供方（不能把 deepseek 的地址套给 openai）
  const c6 = baseCfg({ models: { roles: { chapter: { provider: 'openai', model: 'gpt-4o' } } } });
  const r6 = resolve('chapter', c6);
  ok('baseUrl 正确性：提供方换成 OpenAI 时不误用 llm 段的 DeepSeek 地址',
    r6.baseUrl === 'https://api.openai.com' && r6.sources.baseUrl === 'provider',
    `${r6.baseUrl}（来源 ${r6.sources.baseUrl}）`);
  const r6b = resolve('chapter', baseCfg());
  ok('baseUrl 正确性：提供方与分段一致时沿用分段地址（kind 层）', r6b.baseUrl === 'https://api.deepseek.com' && r6b.sources.baseUrl === 'kind', `${r6b.baseUrl}(${r6b.sources.baseUrl})`);

  // temperature 分层 + 非文本角色不适用
  const c7 = baseCfg({ models: { activeProfile: '高质量', roles: { brief: { provider: 'deepseek', model: 'deepseek-chat' } } } });
  ok('temperature：角色没写时取激活方案的值（高质量方案的 brief=0.3）', resolve('brief', c7).temperature === 0.3 && resolve('brief', c7).sources.temperature === 'profile',
    `temp=${resolve('brief', c7).temperature}(${resolve('brief', c7).sources.temperature})`);
  const c8 = baseCfg({ models: { roles: { brief: { provider: 'deepseek', model: 'deepseek-chat', temperature: 1.6 } } } });
  ok('temperature：角色显式值优先', resolve('brief', c8).temperature === 1.6 && resolve('brief', c8).sources.temperature === 'role');
  ok('temperature：图像/视频/配音类默认返回 null（不适用）', resolve('keyframe', baseCfg()).temperature === null && resolve('video', baseCfg()).temperature === null);

  // 返回值结构完整（界面与 Agent 解释用）
  const r9 = resolve('outline', baseCfg());
  ok('返回值含 provider/model/baseUrl/temperature/source + note/kind/提供方就绪信息',
    ['provider', 'model', 'baseUrl', 'temperature', 'source', 'sourceLevel', 'sources'].every((k) => k in r9)
      && r9.kind === 'llm' && r9.name === '小说大纲' && typeof r9.keyOk === 'boolean' && typeof r9.hasKey === 'boolean',
    Object.keys(r9).join(','));
}

// ---------------- ③ 未知角色 / 未知提供方的中文报错 ----------------
console.log('=== 4. 中文报错（未知角色 / 未知提供方）===');
{
  const e1 = throws(() => MR.resolveModelFor('nope', baseCfg(), NO_ENV), /未知角色/);
  ok('未知角色：抛中文错误并列出可选角色', e1.threw && e1.match && /可选角色/.test(e1.msg), e1.msg.slice(0, 90));
  const e2 = throws(() => MR.resolveModelFor('', baseCfg(), NO_ENV), /未知角色/);
  ok('空角色 id：同样给中文错误（不是 TypeError）', e2.threw && /\(空\)/.test(e2.msg), e2.msg.slice(0, 60));
  const badCfg = baseCfg({ models: { roles: { outline: { provider: '不存在的厂商', model: 'x' } } } });
  const e3 = throws(() => resolve('outline', badCfg), /未知模型提供方/);
  ok('未知提供方：抛中文错误并列出可选提供方', e3.threw && e3.match && /可选/.test(e3.msg), e3.msg.slice(0, 90));
  const soft = MR.resolveModelFor('outline', badCfg, { env: {}, strict: false });
  ok('strict:false 时不抛错，改由 providerKnown=false 表达（供校验使用）',
    soft.provider === '不存在的厂商' && soft.providerKnown === false && soft.providerKindOk === false);
}

// ---------------- ④ validateModels 的 warn / error ----------------
console.log('=== 5. validateModels 分档（warn / error）===');
{
  // 缺模型名 → warn（提供方与角色内置推荐不一致时才会真的「没模型名可用」）
  const cv1 = baseCfg({ models: { roles: { script: { provider: 'openai', model: '' } } }, llm: { apiKey: 'sk-llm' } });
  const v1 = MR.validateModels(cv1, NO_ENV);
  const i1 = issueFor(v1, 'script', /未指定模型名/);
  ok('缺模型名 → warn（不阻塞整体）', Boolean(i1) && i1.level === 'warn', i1?.message?.slice(0, 70));
  const v1b = MR.validateModels(baseCfg({ models: { roles: { script: { provider: 'openai', model: 'gpt-4o' } } } }), NO_ENV);
  ok('写明模型名后该角色的 warn 消失（其他角色不受影响）', !issueFor(v1b, 'script', /未指定模型名/) && v1b.counts.errors > 0, `script 的 issue：${v1b.issues.filter((i) => i.role === 'script').map((i) => i.level + ':' + i.message.slice(0, 30)).join(' | ') || '无'}`);

  // kind 与 provider 不匹配 → error
  const cv2 = baseCfg({ models: { roles: { video: { provider: 'deepseek', model: 'deepseek-chat' } } } });
  const v2 = MR.validateModels(cv2, NO_ENV);
  const i2 = issueFor(v2, 'video', /不支持/);
  ok('提供方与类别不匹配 → error（并说明该提供方只做什么）', Boolean(i2) && i2.level === 'error' && /视频生成/.test(i2.message), i2?.message?.slice(0, 80));

  // 缺 Key → error
  const v3 = MR.validateModels(baseCfg(), NO_ENV);
  const i3 = issueFor(v3, 'outline', /缺少 API Key/);
  ok('缺 Key → error（带中文指引）', Boolean(i3) && i3.level === 'error' && /llm\.apiKey|DEEPSEEK_API_KEY/.test(i3.message), i3?.message?.slice(0, 80));

  // 角色级 Key 可消除该角色的缺 Key 报错
  const cv4 = baseCfg({ models: { roles: { outline: { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'sk-role' } } } });
  const v4 = MR.validateModels(cv4, NO_ENV);
  ok('角色级 apiKey：该角色不再报缺 Key，其它角色照旧',
    !issueFor(v4, 'outline', /缺/) && Boolean(issueFor(v4, 'chapter', /缺少 API Key/)),
    MR.resolveModelFor('outline', cv4, NO_ENV).keyDetail);

  // 缺接口地址（generic-http / comfyui 这类无 Key 但有 URL 的）→ error
  const cv5 = baseCfg({ models: { activeProfile: '省钱', roles: {} } });
  const v5 = MR.validateModels(cv5, NO_ENV);
  const i5 = issueFor(v5, 'keyframe', /未配置接口地址/);
  ok('缺接口地址 → error（提示 image.comfy.url）', Boolean(i5) && i5.level === 'error' && /image\.comfy\.url/.test(i5.message), i5?.message?.slice(0, 80));
  const cv5b = baseCfg({ models: { activeProfile: '省钱', roles: {} }, image: { comfy: { url: 'http://127.0.0.1:8188' } }, video: { comfy: { url: 'http://127.0.0.1:8188' } }, llm: { apiKey: 'sk-x' } });
  const v5b = MR.validateModels(cv5b, NO_ENV);
  ok('补齐 URL/Key 后这些角色不再报错误', !issueFor(v5b, 'keyframe', /未配置接口地址/) && !issueFor(v5b, 'video', /未配置接口地址/) && !issueFor(v5b, 'outline', /缺少 API Key/));

  // 离线实现不需要 Key
  const cv6 = baseCfg({ llm: { provider: 'mock' }, image: { backend: 'placeholder' }, video: { backend: 'placeholder' } });
  const v6 = MR.validateModels(cv6, NO_ENV);
  ok('离线提供方（mock/placeholder/none）不报缺 Key，整体 ok=true',
    v6.ok === true && v6.counts.errors === 0 && v6.counts.ready === 12 && /[\u4e00-\u9fff]/.test(v6.summary),
    `${v6.summary}`);

  // 未知提供方 → 校验里是 error（不抛异常）
  const cv7 = baseCfg({ models: { roles: { outline: { provider: '野厂商', model: 'm' } } } });
  let v7;
  let threw = false;
  try { v7 = MR.validateModels(cv7, NO_ENV); } catch { threw = true; }
  const i7 = v7 && issueFor(v7, 'outline', /未登记|未知/);
  ok('配置里出现未登记提供方时，校验返回 error 而不是抛异常', !threw && Boolean(i7) && i7.level === 'error' && v7.ok === false, i7?.message?.slice(0, 70));

  // 激活不存在的方案 → error
  const cv8 = baseCfg({ models: { activeProfile: '不存在的方案' } });
  const v8 = MR.validateModels(cv8, NO_ENV);
  const i8 = v8.issues.find((i) => i.role === '(全局)');
  ok('激活的搭配方案不存在 → error（列出可用方案）', Boolean(i8) && i8.level === 'error' && /不存在/.test(i8.message), i8?.message?.slice(0, 70));

  // summary / counts 口径
  const v9 = MR.validateModels(baseCfg({ llm: { provider: 'mock' }, image: { backend: 'placeholder' }, video: { backend: 'placeholder' } }), NO_ENV);
  ok('summary 是一句话中文结论，counts 覆盖 12 个角色',
    /共 12 个角色/.test(v9.summary) && v9.counts.roles === 12 && v9.counts.errors === 0 && v9.resolved.length === 12,
    `${v9.summary}｜counts=${JSON.stringify(v9.counts)}`);
  ok('issues 结构统一（role/level/message 三字段）',
    v9.issues.every((i) => typeof i.role === 'string' && ['warn', 'error'].includes(i.level) && typeof i.message === 'string' && /[\u4e00-\u9fff]/.test(i.message)),
    `${v9.issues.length} 条（本用例应为 1 条 none 提醒：${v9.issues.map((i) => i.level).join(',')}）`);
}

// ---------------- ⑤ 三套内置方案 ----------------
console.log('=== 6. 搭配方案（省钱 / 均衡 / 高质量）===');
{
  const cfg = baseCfg();
  const list = MR.listProfiles(cfg);
  ok('内置三套方案齐全', ['省钱', '均衡', '高质量'].every((n) => list.some((p) => p.name === n)), list.map((p) => p.name).join('/'));
  const full = list.filter((p) => ['省钱', '均衡', '高质量'].includes(p.name));
  ok('每套方案覆盖全部 12 个角色（无 missing）',
    full.every((p) => p.roles === 12 && p.missing.length === 0), full.map((p) => `${p.name}=${p.coverage}`).join(' '));
  ok('每套方案都写明中文依据', full.every((p) => p.basis && /[\u4e00-\u9fff]/.test(p.basis) && p.description), full.map((p) => `${p.name}:${p.basis.slice(0, 18)}…`).join(' ｜ '));
  const cfgActive = baseCfg({ models: { activeProfile: '均衡' } });
  ok('listProfiles 标注当前激活的方案（active 唯一）',
    MR.listProfiles(cfgActive).filter((p) => p.active).length === 1 && MR.listProfiles(cfgActive).find((p) => p.active).name === '均衡');

  // 只覆盖一个角色的自定义方案：被覆盖的角色才标「当前生效」，没覆盖的角色不能误报
  const partial = baseCfg({ models: { activeProfile: '小方案', profiles: { 小方案: { storyboard: { provider: 'mock', model: 'mock-template' } } } } });
  ok('部分覆盖的激活方案：覆盖到的角色标记 profileApplied，没覆盖的角色不误报',
    resolve('storyboard', partial).profileApplied === true && /小方案/.test(resolve('storyboard', partial).source)
      && resolve('chapter', partial).profileApplied === false && !/小方案/.test(resolve('chapter', partial).source),
    `storyboard=${resolve('storyboard', partial).profileApplied} chapter=${resolve('chapter', partial).profileApplied}`);

  // 方案里的关键取舍符合注释里的依据
  const cheap = MR.BUILTIN_PROFILES.省钱;
  const best = MR.BUILTIN_PROFILES.高质量;
  ok('省钱方案：文本用便宜长上下文模型、出图/视频走自建 ComfyUI、质检用便宜多模态',
    cheap.outline.provider === 'deepseek' && cheap.keyframe.provider === 'comfyui' && cheap.video.provider === 'comfyui-h3' && cheap.qcVision.model === 'gpt-4o-mini');
  ok('高质量方案：大纲上推理模型、剧本/提示词上旗舰模型、质检用强多模态',
    best.outline.model === 'deepseek-reasoner' && best.script.model === 'gpt-4o' && best.promptOpt.model === 'gpt-4o' && best.qcVision.model === 'gpt-4o');
  ok('方案不含任何密钥（Key 只走分段或角色级配置）',
    Object.values(MR.BUILTIN_PROFILES).every((p) => Object.values(p).every((e) => !('apiKey' in e))));

  // applyProfile：返回新配置、不改入参、不写磁盘
  const fileCfg = baseCfg();
  saveConfig(fileCfg);                                  // 先把「真实配置」落到临时盘上
  const bytesBefore = fs.readFileSync(process.env.FACTORY_CONFIG, 'utf8');
  const mtimeBefore = fs.statSync(process.env.FACTORY_CONFIG).mtimeMs;
  const diskCfg = loadConfig();
  const frozen = JSON.stringify(diskCfg);
  const applied = MR.applyProfile('高质量', diskCfg);
  ok('applyProfile 返回新对象且不改入参（深比较入参未变）', applied !== diskCfg && JSON.stringify(diskCfg) === frozen,
    `入参 models.roles = ${JSON.stringify(diskCfg.models.roles)}`);
  ok('applyProfile 不写磁盘（配置字节与 mtime 都没变）',
    fs.readFileSync(process.env.FACTORY_CONFIG, 'utf8') === bytesBefore && fs.statSync(process.env.FACTORY_CONFIG).mtimeMs === mtimeBefore,
    `mtime ${mtimeBefore} → ${fs.statSync(process.env.FACTORY_CONFIG).mtimeMs}`);
  ok('applyProfile 后角色确实按方案解析（含 source 指向方案名）',
    MR.resolveModelFor('outline', applied, NO_ENV).model === 'deepseek-reasoner'
      && MR.resolveModelFor('outline', applied, NO_ENV).sources.provider === 'role'
      && applied.models.activeProfile === '高质量'
      && /高质量/.test(MR.resolveModelFor('chapter', applied, NO_ENV).source),
    `outline=${MR.resolveModelFor('outline', applied, NO_ENV).model} activeProfile=${applied.models.activeProfile}`);
  ok('applyProfile 会保留既有的角色级 apiKey（只覆盖 provider/model/温度等项）',
    MR.applyProfile('均衡', (() => { const c = baseCfg(); c.models.roles = { outline: { provider: 'deepseek', model: 'm', apiKey: 'sk-keep' } }; return c; })()).models.roles.outline.apiKey === 'sk-keep');
  const e4 = throws(() => MR.applyProfile('不存在的方案', diskCfg), /未知搭配方案/);
  ok('applyProfile 未知方案名 → 中文报错并列出可用方案', e4.threw && /省钱/.test(e4.msg), e4.msg.slice(0, 70));
  ok('applyProfile 传空串 = 取消激活（角色设置保留）',
    (() => { const c = MR.applyProfile('省钱', diskCfg); const off = MR.applyProfile('', c); return off.models.activeProfile === '' && off.models.roles.outline.provider === 'deepseek'; })());
}

// ---------------- ⑧ PUT models 段白名单清洗 ----------------
console.log('=== 7. PUT /api/settings 的 models 段清洗 ===');
{
  const existing = MR.builtinProfiles();
  const good = MR.sanitizeModelsPatch({
    roles: { outline: { provider: 'openai', model: 'gpt-4o', temperature: 0.9, note: '大纲换旗舰', apiKey: 'sk-role-secret', 乱七八糟: '忽略我' } },
    profiles: { 我的方案: { storyboard: { provider: 'mock', model: 'mock-template' } } },
    activeProfile: '我的方案',
  }, { existingProfiles: existing });
  ok('合法 patch：通过并只保留白名单字段（未知字段被丢弃）',
    good.ok && good.patch.roles.outline.model === 'gpt-4o' && good.patch.roles.outline.apiKey === 'sk-role-secret'
      && !('乱七八糟' in good.patch.roles.outline) && good.patch.activeProfile === '我的方案',
    JSON.stringify(good.patch.roles.outline));
  ok('合法 patch：自定义方案（同一请求里新建并激活）被接受', good.ok && good.patch.profiles['我的方案'].storyboard.provider === 'mock');

  const bad = [
    ['未知角色', { roles: { 不存在的角色: { provider: 'mock' } } }, /未知角色「不存在的角色」/],
    ['未知提供方', { roles: { outline: { provider: '野厂商' } } }, /未登记的模型提供方|未登记/],
    ['temperature 越界', { roles: { outline: { temperature: 9 } } }, /temperature 必须是 0~2/],
    ['temperature 非数字', { roles: { outline: { temperature: '热' } } }, /temperature 必须是 0~2/],
    ['baseUrl 非法', { roles: { outline: { baseUrl: 'ftp://x' } } }, /baseUrl 必须以 http/],
    ['activeProfile 不存在', { activeProfile: '没有这套' }, /搭配方案「没有这套」不存在/],
    ['roles 不是对象', { roles: [] }, /roles 必须是/],
    ['方案为空', { profiles: { 空方案: {} } }, /至少要包含一个角色/],
    ['方案里角色未知', { profiles: { P: { 野角色: { provider: 'mock' } } } }, /未知角色「野角色」/],
  ];
  const results = bad.map(([label, input, re]) => {
    const r = MR.sanitizeModelsPatch(input, { existingProfiles: existing });
    return { label, ok: !r.ok && r.patch === null && r.errors.some((m) => re.test(m)) && r.errors.every((m) => /[\u4e00-\u9fff]/.test(m)), err: r.errors[0] };
  });
  ok('非法 models 请求逐类给出中文报错且不产生 patch（9 类）',
    results.every((r) => r.ok), results.filter((r) => !r.ok).map((r) => `${r.label}:${r.err}`).join(' | ') || `全部命中：${results.map((r) => r.label).join('、')}`);

  const masked = MR.sanitizeModelsPatch({ roles: { outline: { apiKey: '****' } } }, { existingProfiles: existing });
  ok('界面回传的掩码值 **** 不会覆盖真实 Key（不写入 apiKey 字段）', masked.ok && !('apiKey' in masked.patch.roles.outline));

  const cleared = MR.sanitizeModelsPatch({ roles: { outline: { provider: 'mock', model: '' } } }, { existingProfiles: existing });
  ok('清空写法被接受（写入空串即回落到下一层）', cleared.ok && cleared.patch.roles.outline.provider === 'mock' && cleared.patch.roles.outline.model === '');

  // 与 saveConfig / loadConfig 串起来：清洗 → 落盘（meta.js 的写法是 patch.models = r.patch）→ 读回 → 解析生效
  const clean = MR.sanitizeModelsPatch({ roles: { outline: { provider: 'openai', model: 'gpt-4o', temperature: 1.2 } }, activeProfile: '省钱' }, { existingProfiles: existing });
  saveConfig({ models: clean.patch });
  const reloaded = loadConfig({ reload: true });
  const r = MR.resolveModelFor('outline', reloaded, NO_ENV);
  ok('清洗后的 patch 经 saveConfig 落盘、loadConfig 读回后解析正确',
    r.provider === 'openai' && r.model === 'gpt-4o' && r.temperature === 1.2 && reloaded.models.activeProfile === '省钱',
    `${r.provider}/${r.model}/${r.temperature} activeProfile=${reloaded.models.activeProfile}`);
  const pub = publicConfig();
  ok('publicConfig：角色级 apiKey 被掩码（明文不外泄，另给 apiKeyMasked）',
    pub.models.roles.outline.apiKey === '****' ? true : !('apiKey' in pub.models.roles.outline),
    JSON.stringify(pub.models.roles.outline));
}

// ---------------- 掩码专项：真实 Key 不出现在公开配置里 ----------------
console.log('=== 8. 角色级 Key 掩码 ===');
{
  saveConfig({ models: { roles: { chapter: { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'sk-super-secret-123456' } } } });
  const pub = publicConfig();
  const text = JSON.stringify(pub);
  ok('角色级真实 Key 不以明文出现在 /api/settings 的返回里', !text.includes('sk-super-secret-123456') && pub.models.roles.chapter.apiKey === '****', pub.models.roles.chapter.apiKeyMasked);
  ok('掩码同时给出 apiKeyMasked（只露头尾，便于人工核对）', /^sk-su\*{4}\d{4}$|^sk-su/.test(pub.models.roles.chapter.apiKeyMasked || ''), pub.models.roles.chapter.apiKeyMasked);
  ok('掩码后的公开配置仍可用于解析（读到的是 **** 但结构完整）', MR.resolveModelFor('chapter', pub, { env: {}, strict: false }).provider === 'deepseek');
}

// =====================================================================================
// M-101 追加：Google / Gemini 登记进「按角色模型矩阵」（不改上面任何既有断言的语义）
//   背景：V-101 打通了 src/vision-qc.js 的 generateContent 协议形状，但 PROVIDERS 白名单里没有 google，
//         于是 strict 的 resolveModelFor 抛「未知模型提供方：google」、PUT /api/settings 也拒收，
//         设置页「模型矩阵」选不到 Gemini。本节把「能选 / 能存 / 能解析」三件事钉死。
// =====================================================================================
console.log('=== 9. Google / Gemini 登记（能选 / 能存 / 能解析）===');
{
  const g = MR.PROVIDERS.google;
  ok('提供方字典：google 已登记（id 为 google，字段与既有条目同构，支持 vision）',
    Boolean(g) && g.id === 'google' && /[\u4e00-\u9fff]/.test(g.name) && g.kinds.includes('vision')
      && g.needsKey === true && g.needsModel === true && typeof g.configHint === 'string'
      && MR.PROVIDER_IDS.includes('google'),
    `kinds=${(g?.kinds || []).join('/')} needsKey=${g?.needsKey} needsModel=${g?.needsModel}`);
  ok('提供方字典：baseUrl 与鉴权说明与仓库调研一致（:1355 地址 / :1354 x-goog-api-key）',
    g.baseUrl === 'https://generativelanguage.googleapis.com' && /x-goog-api-key/.test(g.configHint),
    `${g.baseUrl}｜${g.configHint.slice(0, 60)}…`);
  ok('提供方字典：envKeys 覆盖 GEMINI_API_KEY / GOOGLE_API_KEY / GOOGLE_GENAI_API_KEY',
    ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_API_KEY'].every((k) => g.envKeys.includes(k)), g.envKeys.join(' / '));
  ok('提供方字典：模型名只写调研已确证的清单（docs/模型对接参考.md:1358，不编造）',
    g.suggestedModel === 'gemini-3.8-flash' && Array.isArray(g.knownModels) && g.knownModels.length > 0
      && g.knownModels.includes('gemini-3.8-flash') && g.knownModels.every((m) => /^gemini-[\w.-]+$/.test(m)),
    `${g.suggestedModel}｜${g.knownModels.join('、')}`);
  ok('提供方字典：**只登记 vision、刻意不含 llm**（src/llm.js 没有 Gemini 对话分支，登记 llm 会让界面把文本角色也指向打不通的端点）',
    g.kinds.length === 1 && g.kinds[0] === 'vision' && !g.kinds.includes('llm'), g.kinds.join('/'));
  ok('别名：gemini 等价于 google（getProvider / canonicalProviderId / providerSupports 都认；未知别名原样返回）',
    MR.PROVIDER_ALIASES.gemini === 'google' && MR.canonicalProviderId('gemini') === 'google'
      && MR.getProvider('gemini')?.id === 'google' && MR.providerSupports('gemini', 'vision') === true
      && MR.canonicalProviderId('google') === 'google' && MR.canonicalProviderId('野厂商') === '野厂商',
    JSON.stringify(MR.PROVIDER_ALIASES));

  // 解析（strict）：这是界面上「选了 Google 之后后端能不能解释这一行」的关键
  const GBASE = 'https://generativelanguage.googleapis.com';
  const gcfg = baseCfg({ models: { roles: { qcVision: { provider: 'google', model: 'gemini-3.8-flash', baseUrl: GBASE, temperature: 0.2, apiKey: 'AIza-role-key-for-test' } } } });
  let gr = null;
  let gThrew = false;
  try { gr = MR.resolveModelFor('qcVision', gcfg, NO_ENV); } catch { gThrew = true; }
  ok('strict 解析：provider=google 不再抛「未知模型提供方」（V-101 留的缺口已闭合）',
    !gThrew && gr?.provider === 'google' && gr?.providerKnown === true,
    gThrew ? '仍然抛错' : `provider=${gr.provider} providerKnown=${gr.providerKnown}`);
  ok('strict 解析：baseUrl/keyOk/source/sourceLevel 齐备（角色写了 baseUrl 时按角色层）',
    gr.baseUrl === GBASE && gr.sources.baseUrl === 'role' && gr.keyOk === true && gr.hasKey === true
      && gr.providerKindOk === true && typeof gr.source === 'string' && /角色显式设置/.test(gr.source) && gr.sourceLevel === 'role',
    `${gr.baseUrl}(${gr.sources.baseUrl}) keyOk=${gr.keyOk} sourceLevel=${gr.sourceLevel}`);
  const grNoUrl = MR.resolveModelFor('qcVision', baseCfg({ models: { roles: { qcVision: { provider: 'google', model: 'gemini-3.8-flash', apiKey: 'AIza-k' } } } }), NO_ENV);
  ok('strict 解析：角色没写 baseUrl 时自动用提供方默认地址（来源标注为「提供方默认地址」）',
    grNoUrl.baseUrl === GBASE && grNoUrl.sources.baseUrl === 'provider' && /提供方默认地址/.test(grNoUrl.source),
    `${grNoUrl.baseUrl}(${grNoUrl.sources.baseUrl})｜${grNoUrl.source.slice(0, 60)}`);
  ok('解析结果：模型名与温度按角色层生效（temperature 对 vision 角色有效，与既有 llm/vision 口径一致）',
    gr.model === 'gemini-3.8-flash' && gr.temperature === 0.2 && gr.sources.temperature === 'role', `${gr.model} temp=${gr.temperature}`);
  ok('解析结果：provider=gemini（别名写法）同样解析成功且 providerKnown=true',
    (() => { const r = MR.resolveModelFor('qcVision', baseCfg({ models: { roles: { qcVision: { provider: 'gemini', model: 'gemini-3.8-flash' } } } }), NO_ENV); return r.provider === 'gemini' && r.providerKnown === true && r.baseUrl === GBASE; })(),
    MR.resolveModelFor('qcVision', baseCfg({ models: { roles: { qcVision: { provider: 'gemini', model: 'gemini-3.8-flash' } } } }), NO_ENV).keyDetail);

  // 凭据：角色级 Key / 环境变量 / llm 段（仅当 llm 自己也指向 Gemini）
  const gNoKey = MR.resolveModelFor('qcVision', baseCfg({ models: { roles: { qcVision: { provider: 'google', model: 'gemini-3.8-flash' } } } }), NO_ENV);
  ok('缺凭据：keyOk=false 且中文 detail 里给出 Key 的来源（角色 apiKey 或 GEMINI_API_KEY）',
    gNoKey.keyOk === false && /GEMINI_API_KEY/.test(gNoKey.keyDetail) && /[\u4e00-\u9fff]/.test(gNoKey.keyDetail), gNoKey.keyDetail);
  const gEnv = MR.resolveModelFor('qcVision', baseCfg({ models: { roles: { qcVision: { provider: 'google', model: 'gemini-3.8-flash' } } } }), { env: { GEMINI_API_KEY: 'AIza-from-env' } });
  ok('环境变量 GEMINI_API_KEY 可作 Key（detail 说明来源变量）', gEnv.keyOk === true && /环境变量 GEMINI_API_KEY/.test(gEnv.keyDetail), gEnv.keyDetail);
  const gLlmKey = MR.resolveModelFor('qcVision', baseCfg({ llm: { provider: 'google', apiKey: 'AIza-llm' }, models: { roles: { qcVision: { provider: 'google', model: 'gemini-3.8-flash' } } } }), NO_ENV);
  const gLlmKeyOther = MR.resolveModelFor('qcVision', baseCfg({ llm: { provider: 'deepseek', apiKey: 'sk-deepseek' }, models: { roles: { qcVision: { provider: 'google', model: 'gemini-3.8-flash' } } } }), NO_ENV);
  ok('凭据口径与 src/vision-qc.js 的 geminiKeyInfo 对齐：只有 llm 段本身指向 Gemini 时才认 llm.apiKey',
    gLlmKey.keyOk === true && /llm\.apiKey/.test(gLlmKey.keyDetail) && gLlmKeyOther.keyOk === false,
    `llm=google → ${gLlmKey.keyDetail}｜llm=deepseek → keyOk=${gLlmKeyOther.keyOk}`);

  // 校验：google 配置不产生阻塞项；用在文本角色上会被明确拦下（而不是静默打不通的端点）
  const gv = MR.validateModels(gcfg, NO_ENV);
  ok('validateModels：qcVision 配 google 无阻塞项（issues 里没有 qcVision 的 error/warn）',
    gv.issues.filter((i) => i.role === 'qcVision').length === 0
      && gv.resolved.find((r) => r.role === 'qcVision').providerKnown === true,
    `qcVision issues=${JSON.stringify(gv.issues.filter((i) => i.role === 'qcVision'))}`);
  const gvNoKey = MR.validateModels(baseCfg({ models: { roles: { qcVision: { provider: 'google', model: 'gemini-3.8-flash' } } } }), NO_ENV);
  const gIssue = issueFor(gvNoKey, 'qcVision', /缺少 API Key/);
  ok('validateModels：google 缺 Key 时给 error（中文指引，不静默）', Boolean(gIssue) && gIssue.level === 'error' && /GEMINI_API_KEY/.test(gIssue.message), gIssue?.message?.slice(0, 80));
  const gvLlm = MR.validateModels(baseCfg({ llm: { apiKey: 'AIza-x' }, models: { roles: { outline: { provider: 'google', model: 'gemini-3.8-flash' } } } }), NO_ENV);
  const gLlmIssue = issueFor(gvLlm, 'outline', /不支持/);
  ok('validateModels：把 google 用在文本角色上 → error，并说明这一家只做「多模态理解（读图）」',
    Boolean(gLlmIssue) && gLlmIssue.level === 'error' && /多模态理解/.test(gLlmIssue.message), gLlmIssue?.message?.slice(0, 90));

  // 保存通路：PUT /api/settings 的 models 段白名单（sanitizeModelsPatch 是 meta.js 唯一校验入口）
  const gExisting = MR.builtinProfiles();
  const gPatch = MR.sanitizeModelsPatch({ roles: { qcVision: { provider: 'google', model: 'gemini-3.8-flash', baseUrl: GBASE, temperature: 0.2 } } }, { existingProfiles: gExisting });
  ok('保存通路：roles.qcVision = {provider:google, model, baseUrl} 被接受（不再被白名单拒收）',
    gPatch.ok && gPatch.patch.roles.qcVision.provider === 'google' && gPatch.patch.roles.qcVision.model === 'gemini-3.8-flash'
      && gPatch.patch.roles.qcVision.baseUrl === GBASE,
    JSON.stringify(gPatch.patch?.roles?.qcVision));
  const gPatchAlias = MR.sanitizeModelsPatch({ roles: { qcVision: { provider: 'gemini', model: 'gemini-3.8-flash' } } }, { existingProfiles: gExisting });
  ok('保存通路：别名 provider=gemini 同样被接受', gPatchAlias.ok && gPatchAlias.patch.roles.qcVision.provider === 'gemini');
  const gBad = [
    ['拼错的厂商名', { roles: { qcVision: { provider: 'googlex' } } }, /未登记/],
    ['google 的 baseUrl 非法', { roles: { qcVision: { provider: 'google', baseUrl: 'ftp://x' } } }, /baseUrl 必须以 http/],
    ['方案里写未登记提供方', { profiles: { P: { qcVision: { provider: 'gemini-pro' } } } }, /未登记/],
  ].map(([label, input, re]) => {
    const r = MR.sanitizeModelsPatch(input, { existingProfiles: gExisting });
    return { label, ok: !r.ok && r.patch === null && r.errors.some((m) => re.test(m)) && r.errors.every((m) => /[\u4e00-\u9fff]/.test(m)), err: r.errors[0] };
  });
  ok('非法值仍给中文 400 且不产生 patch（拼错厂商名 / 非法 baseUrl / 方案里的未登记厂商）',
    gBad.every((r) => r.ok), gBad.filter((r) => !r.ok).map((r) => `${r.label}:${r.err}`).join(' | ') || gBad.map((r) => r.label).join('、'));

  // 端到端：清洗 → saveConfig 落盘 → loadConfig 读回 → 解析（「能存、回读不丢」）
  saveConfig({ models: { roles: { qcVision: { provider: 'google', model: 'gemini-3.8-flash', baseUrl: GBASE, temperature: 0.2, apiKey: 'AIza-saved' } } } });
  const gReloaded = loadConfig({ reload: true });
  const gBack = MR.resolveModelFor('qcVision', gReloaded, NO_ENV);
  ok('端到端：google 配置落盘后读回不丢（provider/model/baseUrl 与写入一致）且能直接解析',
    gBack.provider === 'google' && gBack.model === 'gemini-3.8-flash' && gBack.baseUrl === GBASE && gBack.keyOk === true,
    `${gBack.provider}/${gBack.model}/${gBack.baseUrl} keyOk=${gBack.keyOk}`);
  const gPub = publicConfig();
  ok('端到端：/api/settings 的公开配置里 qcVision 的 Key 被掩码（明文不外泄）',
    gPub.models.roles.qcVision.provider === 'google' && gPub.models.roles.qcVision.apiKey === '****'
      && !JSON.stringify(gPub).includes('AIza-saved'),
    JSON.stringify(gPub.models.roles.qcVision).slice(0, 120));

  // 默认行为不变：三套内置方案的角色映射一个字都没动
  const gUsedInProfiles = Object.values(MR.BUILTIN_PROFILES)
    .flatMap((p) => Object.values(p))
    .filter((e) => ['google', 'gemini'].includes(e.provider));
  ok('默认行为不变：三套内置方案（省钱/均衡/高质量）里没有任何 google/gemini 角色映射',
    gUsedInProfiles.length === 0, `命中 ${gUsedInProfiles.length} 处`);
  ok('默认行为不变：qcVision 的内置默认与三套方案仍是 OpenAI 多模态（V-101 前的口径）',
    MR.ROLE_MAP.qcVision.defaultProvider === 'openai' && MR.ROLE_MAP.qcVision.defaultModel === 'gpt-4o-mini'
      && MR.BUILTIN_PROFILES.省钱.qcVision.provider === 'openai' && MR.BUILTIN_PROFILES.高质量.qcVision.model === 'gpt-4o',
    `${MR.ROLE_MAP.qcVision.defaultProvider}/${MR.ROLE_MAP.qcVision.defaultModel}`);
}

// =====================================================================================
// M-101 追加：设置页厂商副本与 registry **不漂移**（web/views/settings.js 的 MM_PROVIDERS / MM_PROVIDER_ALIASES）
//   为什么要有这条：界面那份字典是「唯一的第二份事实」，漏同步就会变成「界面选得到、后端拒收」或反过来的静默漂移。
//   做法：把 settings.js 当文本读出来做括号配对解析（不执行任何项目代码、不联网），比对 id 集合 / kinds / needsModel。
// =====================================================================================
console.log('=== 10. 设置页厂商副本与 registry 不漂移 ===');
{
  /** 从源码文本里抠出 `const NAME = { ... }` 的对象字面量（括号配对，跳过字符串与行注释；不执行代码） */
  function objectLiteralOf(src, name) {
    const at = src.indexOf(`const ${name} = `);
    if (at < 0) return null;
    const open = src.indexOf('{', at);
    if (open < 0) return null;
    let depth = 0;
    let q = '';
    for (let i = open; i < src.length; i++) {
      const ch = src[i];
      if (q) {
        if (ch === '\\') { i++; continue; }
        if (ch === q) q = '';
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') { q = ch; continue; }
      if (ch === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i); i = e < 0 ? src.length : e; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
    }
    return null;
  }
  /** 对象字面量 → 顶层条目文本数组（按顶层逗号切，括号配对 + 跳过字符串） */
  function splitTopLevel(body) {
    const inner = body.slice(1, -1);
    const out = [];
    let depth = 0;
    let q = '';
    let cur = '';
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i];
      if (q) {
        cur += ch;
        if (ch === '\\') { cur += inner[i + 1] || ''; i++; continue; }
        if (ch === q) q = '';
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') { q = ch; cur += ch; continue; }
      if (ch === '{' || ch === '[' || ch === '(') depth++;
      else if (ch === '}' || ch === ']' || ch === ')') depth--;
      if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
      cur += ch;
    }
    if (cur.trim()) out.push(cur);
    return out.map((s) => s.trim()).filter(Boolean);
  }
  const KEY_RE = /^(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*:\s*([\s\S]*)$/;
  const unquote = (s) => String(s ?? '').trim().replace(/^['"`]|['"`]$/g, '');
  /** 解析 settings.js 里的厂商副本：只取本测试要比对的字段（name / kinds / needsModel / suggestedModel） */
  function parseUiProviders(src) {
    const lit = objectLiteralOf(src, 'MM_PROVIDERS');
    if (!lit) return null;
    const list = {};
    for (const entry of splitTopLevel(lit)) {
      const m = entry.match(KEY_RE);
      if (!m) return null;
      const body = m[4] || '';
      const nameM = body.match(/name:\s*(?:'([^']*)'|"([^"]*)")/);
      const kindsM = body.match(/kinds:\s*\[([^\]]*)\]/);
      const needsM = body.match(/needsModel:\s*(true|false)/);
      const sugM = body.match(/suggestedModel:\s*(?:'([^']*)'|"([^"]*)")/);
      list[m[1] || m[2] || m[3]] = {
        name: unquote(nameM ? (nameM[1] ?? nameM[2]) : ''),
        kinds: kindsM ? kindsM[1].split(',').map(unquote).filter(Boolean) : [],
        needsModel: needsM ? needsM[1] === 'true' : null,
        suggestedModel: unquote(sugM ? (sugM[1] ?? sugM[2]) : ''),
      };
    }
    const aliasLit = objectLiteralOf(src, 'MM_PROVIDER_ALIASES');
    const aliases = {};
    if (aliasLit) {
      for (const entry of splitTopLevel(aliasLit)) {
        const m = entry.match(/^(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*:\s*(?:'([^']*)'|"([^"]*)")\s*$/);
        if (m) aliases[m[1] || m[2] || m[3]] = m[4] ?? m[5];
      }
    }
    return { list, aliases };
  }

  const settingsPath = path.join(import.meta.dirname, '..', 'web', 'views', 'settings.js');
  const settingsSrc = fs.readFileSync(settingsPath, 'utf8');
  const ui = parseUiProviders(settingsSrc);
  ok('能解析出设置页的厂商副本（解析失败 = 文件格式变了，请同步本测试的解析逻辑，不要删这条）',
    Boolean(ui) && Object.keys(ui.list).length > 0,
    ui ? `${Object.keys(ui.list).length} 个：${Object.keys(ui.list).join('、')}` : '解析失败');
  const uiIds = ui ? Object.keys(ui.list) : [];
  const missing = MR.PROVIDER_IDS.filter((id) => !uiIds.includes(id));
  const extra = uiIds.filter((id) => !MR.PROVIDER_IDS.includes(id));
  ok('设置页厂商 id 集合与 registry 的 PROVIDER_IDS 完全一致（漂移即报错：多/少都会被指出）',
    uiIds.length === MR.PROVIDER_IDS.length && missing.length === 0 && extra.length === 0,
    `界面 ${uiIds.length} 个 / registry ${MR.PROVIDER_IDS.length} 个${missing.length ? '｜缺 ' + missing.join('、') : ''}${extra.length ? '｜多 ' + extra.join('、') : ''}`);
  ok('设置页每个厂商的 kinds 与 needsModel 与 registry 一致（决定「哪些角色能选到这一家」）',
    MR.PROVIDER_IDS.every((id) => {
      const a = MR.PROVIDERS[id];
      const b = ui.list[id];
      return b && a.kinds.join('/') === b.kinds.join('/') && Boolean(b.needsModel) === Boolean(a.needsModel);
    }),
    MR.PROVIDER_IDS.map((id) => `${id}:${(ui.list[id]?.kinds || []).join('/')}${ui.list[id]?.needsModel !== Boolean(MR.PROVIDERS[id].needsModel) ? '(needsModel 不一致)' : ''}`).join(' '));
  ok('设置页的 google 条目与 registry 一致（含推荐模型名：选完会自动填上，不会因空模型名卡住保存）',
    ui.list.google?.kinds.includes('vision') === true && ui.list.google.suggestedModel === MR.PROVIDERS.google.suggestedModel,
    JSON.stringify(ui.list.google));
  ok('设置页别名表与 registry 的 PROVIDER_ALIASES 一致（gemini → google）',
    JSON.stringify(ui.aliases) === JSON.stringify({ ...MR.PROVIDER_ALIASES }), JSON.stringify(ui.aliases));
  ok('设置页的 vision 类别过滤后包含 google（「画面质检」这一行的下拉里能选到 Google/Gemini）',
    uiIds.filter((id) => ui.list[id].kinds.includes('vision')).includes('google'),
    uiIds.filter((id) => ui.list[id].kinds.includes('vision')).join('、'));
  ok('界面文案同步了政策：Google 只登记 vision（下拉不列给文本角色），并注明「改 registry 必须同步这里」',
    /\[(?:'|")vision(?:'|")\]/.test(settingsSrc) && /改 src\/model-registry\.js 的 PROVIDERS 时必须同步这里/.test(settingsSrc));
  ok('设置页优先用后端 GET /api/settings/models 回的 providers（registry 唯一事实来源），接口不可用才回落副本',
    /mm\.providers/.test(settingsSrc) && /providerAliases/.test(settingsSrc) && /function mmProvidersOf/.test(settingsSrc));
}

// =====================================================================================
// M-101 追加：真跑一遍 PUT /api/settings 的路由处理器（不起服务、不联网、不碰真实配置）
//   为什么值得单独测：sanitizeModelsPatch 只是「清洗函数」，而任务要确认的是「PUT 的 models 段能接受 google、
//   非法值给中文 400 且整体不落盘」——这里把 src/routes/meta.js 的**真实 handler** 挂到一个假 app 上直接调用，
//   连 saveConfig / badRequest(400) 的实际效果一起验（顶层 await 动态 import，避免影响本文件前面的断言顺序）。
// =====================================================================================
console.log('=== 11. PUT /api/settings 与 GET /api/settings/models 的路由层实测 ===');
{
  const { registerMetaRoutes } = await import('../src/routes/meta.js');
  const routes = new Map();
  const app = {
    get: (p, h) => routes.set(`GET ${p}`, h), put: (p, h) => routes.set(`PUT ${p}`, h),
    post: (p, h) => routes.set(`POST ${p}`, h), delete: (p, h) => routes.set(`DELETE ${p}`, h),
  };
  registerMetaRoutes(app);
  const putSettings = routes.get('PUT /api/settings');
  const getModels = routes.get('GET /api/settings/models');
  ok('路由层：PUT /api/settings 与 GET /api/settings/models 都注册成功（假 app 捕获到 handler）',
    typeof putSettings === 'function' && typeof getModels === 'function', `共注册 ${routes.size} 条路由`);

  /** 调一次 PUT：返回 {ok:true,payload} 或 {ok:false,status,message} */
  const put = async (body) => {
    let payload = null;
    try { await putSettings({ body: async () => body, json: (o) => { payload = o; } }); return { ok: true, payload }; }
    catch (e) { return { ok: false, status: e.status || e.statusCode || null, message: String(e?.message || e) }; }
  };
  const cfgText = () => fs.readFileSync(process.env.FACTORY_CONFIG, 'utf8');

  const r1 = await put({ models: { roles: { qcVision: { provider: 'google', model: 'gemini-3.8-flash', baseUrl: 'https://generativelanguage.googleapis.com', temperature: 0.2 } } } });
  const saved = loadConfig({ reload: true }).models.roles.qcVision;
  ok('路由层：PUT models.roles.qcVision={provider:google,…} → 200 且落盘三字段一个不丢（不再被白名单拒收）',
    r1.ok && r1.payload?.ok === true && saved.provider === 'google' && saved.model === 'gemini-3.8-flash'
      && saved.baseUrl === 'https://generativelanguage.googleapis.com',
    r1.ok ? JSON.stringify(saved) : `status=${r1.status} ${r1.message}`);

  const bytesGood = cfgText();
  const r2 = await put({ models: { roles: { qcVision: { provider: 'googlex' } } } });
  ok('路由层：拼错的厂商名 → 400 + 中文报错，且配置文件逐字节未变（整体不落盘）',
    !r2.ok && r2.status === 400 && /[\u4e00-\u9fff]/.test(r2.message) && /未登记/.test(r2.message) && cfgText() === bytesGood,
    `status=${r2.status} ${r2.message}`);
  const r3 = await put({ models: { roles: { qcVision: { provider: 'google', model: 'm', temperature: 9 } } } });
  ok('路由层：temperature 越界 → 400 + 中文，且仍不落盘',
    !r3.ok && r3.status === 400 && /temperature 必须是 0~2/.test(r3.message) && cfgText() === bytesGood, `status=${r3.status} ${r3.message}`);

  const r4 = await put({ models: { roles: { qcVision: { provider: 'gemini', model: 'gemini-3.8-flash' } } } });
  const aliasSaved = loadConfig({ reload: true }).models.roles.qcVision;
  ok('路由层：别名 provider=gemini → 200 并原样落盘（baseUrl 空缺时由提供方默认地址兜底）',
    r4.ok && r4.payload?.ok === true && aliasSaved.provider === 'gemini' && aliasSaved.baseUrl === 'https://generativelanguage.googleapis.com',
    JSON.stringify(aliasSaved));

  let mm = null;
  await getModels({ json: (o) => { mm = o; } });
  ok('路由层：GET /api/settings/models 回传 providers / providerAliases（设置页下拉的 registry 数据源）',
    Boolean(mm?.providers?.google) && mm.providers.google.kinds.includes('vision') && mm.providerAliases?.gemini === 'google'
      && Array.isArray(mm.roles) && Array.isArray(mm.resolved),
    `providers=${Object.keys(mm?.providers || {}).join('、')}`);
  ok('路由层：该返回体不含任何 Key 明文（只有 envKeys 变量名与 configHint）',
    !Object.values(mm.providers).some((p) => 'apiKey' in p) && mm.providers.google.envKeys.every((k) => /^[A-Z_]+$/.test(k)),
    JSON.stringify(mm.providers.google.envKeys));

  // 复位：别把「google 已保存」的临时配置留给本文件后面的用例（虽然本节已在末尾，仍保持整洁）
  await put({ models: { roles: { qcVision: { provider: '', model: '' } } } });
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(fail ? 1 : 0);
