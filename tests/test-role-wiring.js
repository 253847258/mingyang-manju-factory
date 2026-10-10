// 「按角色接线」自测：让 config.models 的 12 个角色真正驱动制片流水线与画布节点
// 用法：node tests/test-role-wiring.js
//
// 零付费红线（本文件全程零联网、零计费）：
//   · 临时库 + 临时配置（FACTORY_DB / FACTORY_DATA_DIR / FACTORY_CONFIG 全在 mkdtemp 里）；
//   · 出图/视频后端固定 placeholder，付费阶段只走到「建计划」就停（人工闸门不变）；
//   · 文本角色用 provider=mock（离线模板）驱动；唯一一次 offline:false 的跑动把
//     llm.baseUrl 指向本机死端口（http://127.0.0.1:9）并只把角色指向 mock——
//     即「接线一旦失效就会立刻连接被拒而失败」，从机制上保证不可能打到真实付费端点。
//   · 本机 ~/.dsh/.credentials.yaml 里有真实 DeepSeek 凭据（llmStatus().ready=true），
//     所以本文件刻意删除进程内的 *_API_KEY 环境变量，让「缺 Key 判定」可复现、与宿主机无关。
//
// 覆盖：①各阶段 artifact 里的「角色 → 模型」映射（brief/novel/script/canvas/keyframe/video/qc + 画布智能体）
//       ②source/sourceLevel 体现四级优先级（角色显式 > 搭配方案 > 既有分段默认 > 内置默认，四层全覆盖）
//       ③配置缺失/提供方未登记/类别不匹配/缺凭据时回落既有全局段行为且阶段不失败（中文原因进 artifact）
//       ④既有 artifact 字段一个不少（语义未变）
//       ⑤零付费反证（placeholder 后端 + 零生成调用 + 用量金额 0 + 按角色真的把 mock 传给了模块）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 先清掉宿主机环境变量：让「缺 Key → 回落」的判定只看临时配置，与开发机的凭据环境解耦
for (const k of ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'IMAGE_API_KEY']) delete process.env[k];

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-rolewiring-'));
const DATA_TMP = path.join(TMP, 'data');
process.env.FACTORY_DATA_DIR = DATA_TMP;
process.env.FACTORY_DB = path.join(TMP, 'rolewiring.db');
process.env.FACTORY_CONFIG = path.join(TMP, 'config.json');
fs.mkdirSync(DATA_TMP, { recursive: true });

/** 本机死端口：任何「本该走 mock 却打到真实端点」的漏接都会在这里被立刻拒绝（零计费、零数据出网） */
const DEAD_BASE = 'http://127.0.0.1:9';
fs.writeFileSync(process.env.FACTORY_CONFIG, JSON.stringify({
  llm: { provider: 'mock', baseUrl: DEAD_BASE, apiKey: '', model: 'deepseek-chat', temperature: 0.85 },
  image: { backend: 'placeholder' },
  video: { backend: 'placeholder' },
  finish: { subtitles: false, audio: 'silent', fadeIn: 0, fadeOut: 0, keepIntermediates: true },
  budget: { enabled: true, currency: 'CNY', imageUnit: 0.1, videoUnit: 0.5, ttsPerKChars: 0, monthlyCap: 0, confirmOver: 0 },
}), 'utf8');

const { migrate, get, all, run } = await import('../src/db.js');
const { saveConfig, loadConfig } = await import('../src/config.js');
const { getUsage } = await import('../src/guard.js');
const St = await import('../src/studio.js');
const MR = await import('../src/model-registry.js');
migrate();
St.ensureStudioSchema();

let pass = 0; let fail = 0;
const ok = (name, cond, evidence = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${evidence ? `  ← ${evidence}` : ''}`); }
  else { fail++; console.error(`  ✗ ${name}  ← ${evidence}`); }
};
const artOf = (prodId, stage) => {
  const row = get('SELECT artifact FROM production_stages WHERE production_id = ? AND stage = ?', prodId, stage);
  try { return row?.artifact ? JSON.parse(row.artifact) : null; } catch { return null; }
};
const hasModels = (art, roles) => roles.every((r) => art?.models?.[r] && 'provider' in art.models[r] && 'model' in art.models[r]
  && 'source' in art.models[r] && 'sourceLevel' in art.models[r]);
const isCN = (s) => /[\u4e00-\u9fff]/.test(String(s || ''));

// =====================================================================================
console.log('=== 1. 免费阶段：角色 → 模型写进 artifact（brief / novel / script / canvas） ===');
// 配置：llm 段 = mock（离线模板），角色层为空 → 各文本角色落到「既有分段默认」这一层
const logs = [];
const P1 = await St.createProduction({
  brief: '拍一部两集的雾港悬疑短剧，竖屏，每集 20 秒，2 个角色，日系赛璐璐画风',
  offline: true, spec: { castSize: 2, chaptersToWrite: 1 },
});
const briefRun = await St.runStage(P1.id, 'brief', { offline: true, onLog: (m) => logs.push(m) });
const briefArt = briefRun.artifact;
await St.runStage(P1.id, 'cast', { offline: true });
ok('brief 阶段 artifact 带 models.brief 的角色→模型映射',
  hasModels(briefArt, ['brief']) && briefArt.models.brief.provider === 'mock',
  JSON.stringify({ provider: briefArt?.models?.brief?.provider, model: briefArt?.models?.brief?.model, level: briefArt?.models?.brief?.sourceLevel }));
ok('brief 角色被真正驱动（applied=true）且来源是中文说明',
  briefArt.models.brief.applied === true && isCN(briefArt.models.brief.source),
  `${briefArt.models.brief.applied} · ${briefArt.models.brief.source}`);
ok('onLog 打出中文「角色 → 模型（来自：哪一层）」日志',
  logs.some((l) => /需求解析用 mock\/.+（来自：/.test(l)), logs.find((l) => /需求解析用/.test(l)) || '(无)');

const novelRun = await St.runStage(P1.id, 'novel', { offline: true, onLog: (m) => logs.push(m) });
ok('novel 阶段同时落下 outline（大纲）与 chapter（章节写作）两个角色的映射',
  hasModels(novelRun.artifact, ['outline', 'chapter'])
  && novelRun.artifact.models.outline.applied === true,
  JSON.stringify({ outline: novelRun.artifact.models.outline.provider, chapter: novelRun.artifact.models.chapter.provider }));
ok('chaptersToWrite=0 时如实标明 chapter 角色未实际调用（artifact 不虚报「已驱动」）',
  novelRun.artifact.models.chapter.applied === false && novelRun.artifact.models.chapter.skipped === true
  && /chaptersToWrite=0/.test(novelRun.artifact.models.chapter.note || '') && isCN(novelRun.artifact.models.chapter.note),
  String(novelRun.artifact.models.chapter.note));
ok('outline 角色带上调用点说明（N.generateOutline）',
  /generateOutline/.test(novelRun.artifact.models.outline.callpoint || ''),
  String(novelRun.artifact.models.outline.callpoint));
ok('chapter 角色带上调用点说明（N.writeChapter）与温度（角色可分层控制）',
  /writeChapter/.test(novelRun.artifact.models.chapter.callpoint || '') && novelRun.artifact.models.chapter.temperature === 0.85,
  `${novelRun.artifact.models.chapter.callpoint} · temp=${novelRun.artifact.models.chapter.temperature}`);

const scriptRun = await St.runStage(P1.id, 'script', { offline: true, onLog: (m) => logs.push(m) });
ok('script 阶段分别落下 script（剧本/分集）与 storyboard（分镜）两个角色',
  hasModels(scriptRun.artifact, ['script', 'storyboard'])
  && scriptRun.artifact.models.script.applied === true && scriptRun.artifact.models.storyboard.applied === true,
  JSON.stringify({ script: scriptRun.artifact.models.script.callpoint, board: scriptRun.artifact.models.storyboard.callpoint }));

const canvasRun = await St.runStage(P1.id, 'canvas', { offline: true, onLog: (m) => logs.push(m) });
const kfPlanRun = await St.runStage(P1.id, 'keyframe', { offline: true, onLog: (m) => logs.push(m) });
// 付费阶段的 runner 只返回「等待批准」的结果对象，artifact 落库（与既有行为一致）
const kfPlanArt = artOf(P1.id, 'keyframe');
ok('canvas 阶段落下 promptOpt 角色，并如实说明「本阶段没有提示词优化调用点」（不新增付费调用）',
  hasModels(canvasRun.artifact, ['promptOpt']) && canvasRun.artifact.models.promptOpt.applied === false
  && /没有「提示词优化」的生成调用点/.test(canvasRun.artifact.models.promptOpt.note || '')
  && isCN(canvasRun.artifact.models.promptOpt.note),
  String(canvasRun.artifact.models.promptOpt.note).slice(0, 90));
ok('canvas 阶段照旧只布局（零生成调用）', get('SELECT COUNT(*) c FROM canvas_node_runs').c === 0,
  `runs=${get('SELECT COUNT(*) c FROM canvas_node_runs').c}`);

console.log('\n=== 2. 付费阶段：keyframe / video 三个出图角色只记录（计划照旧等人工批准） ===');
ok('keyframe 阶段落下 keyframe / refImage / firstLast 三个出图角色',
  hasModels(kfPlanArt, ['keyframe', 'refImage', 'firstLast'])
  && ['keyframe', 'refImage', 'firstLast'].every((r) => kfPlanArt.models[r].applied === false && isCN(kfPlanArt.models[r].note)),
  JSON.stringify(['keyframe', 'refImage', 'firstLast'].map((r) => `${r}=${kfPlanArt.models[r].provider}/${kfPlanArt.models[r].model}`)));
ok('keyframe 角色的中文说明点明「真正出图走画布节点 + 停在人工闸门」',
  /人工批准闸门/.test(kfPlanArt.models.keyframe.note || '') && /image 段/.test(kfPlanArt.models.keyframe.note || ''),
  String(kfPlanArt.models.keyframe.note).slice(0, 100));
ok('付费阶段照旧停在 awaiting_approval（角色接线没有绕过人工闸门）',
  get("SELECT status FROM production_stages WHERE production_id = ? AND stage = 'keyframe'", P1.id).status === 'awaiting_approval'
  && kfPlanRun.models?.keyframe?.provider === kfPlanArt.models.keyframe.provider,
  'artifact 与返回值都带同一份角色解析结果');

// 视频阶段（同样只建计划）。为了让依赖检查通过，先把 keyframe 标成 done——
// 这里只借 test-studio 既有的「SQL 快捷方式」推进阶段状态，不触发任何生成调用（runs 仍为 0）。
run("UPDATE production_stages SET status='done' WHERE production_id = ? AND stage = 'keyframe'", P1.id);
await St.runStage(P1.id, 'video', { offline: true, onLog: (m) => logs.push(m) });
const videoPlanArt2 = artOf(P1.id, 'video');
ok('video 阶段落下 video 角色 + 中文说明（真正出视频走画布节点、后端取自 video 段）',
  hasModels(videoPlanArt2, ['video']) && videoPlanArt2.models.video.applied === false
  && /video 段/.test(videoPlanArt2.models.video.note || ''),
  `${videoPlanArt2.models.video.provider}/${videoPlanArt2.models.video.model} · ${String(videoPlanArt2.models.video.note).slice(0, 60)}`);
run("UPDATE production_stages SET status='done' WHERE production_id = ? AND stage IN ('keyframe','video','finish')", P1.id);
const qcRun = await St.runStage(P1.id, 'qc', { offline: true, onLog: (m) => logs.push(m) });ok('qc 阶段落下 qcVision 角色，并如实说明「当前无多模态读图调用点」',
  hasModels(qcRun.artifact, ['qcVision']) && qcRun.artifact.models.qcVision.applied === false
  && /多模态读图/.test(qcRun.artifact.models.qcVision.note || ''),
  String(qcRun.artifact.models.qcVision.note).slice(0, 90));

console.log('\n=== 3. 画布智能体（canvasAgent）也按 promptOpt 角色接线 ===');
const agent = await St.canvasAgent({ canvasId: canvasRun.artifact.canvasId, instruction: '看画布状态' });
ok('canvasAgent 返回 trace.models.promptOpt（画布侧同样可追溯）',
  hasModels(agent.trace, ['promptOpt']) && agent.trace.models.promptOpt.role === 'promptOpt'
  && agent.trace.models.promptOpt.callpoint === 'chatJSON（画布指令归一化）',
  String(agent.trace.models.promptOpt.callpoint));
ok('canvasAgent 仍然零付费（paid=false），调用点与角色来源可查',
  agent.trace.paid === false && agent.trace.models.promptOpt.callpoint === 'chatJSON（画布指令归一化）'
  && agent.trace.models.promptOpt.provider === 'mock',
  `paid=${agent.trace.paid} · ${agent.trace.models.promptOpt.provider}/${agent.trace.models.promptOpt.model}`);

console.log('\n=== 4. 优先级：角色显式 > 搭配方案 > 既有分段默认 > 内置默认（四层全覆盖） ===');
const planOf = (stage = 'novel', opts = {}) => St.stageRolePlan(stage, opts);
// ④ 内置默认：把 llm 段清空 → 落到角色字典的 defaultProvider/defaultModel
saveConfig({ llm: { provider: '', model: '', baseUrl: '', temperature: '' }, models: { activeProfile: '', roles: {} } });
let p = planOf();
ok('第 4 层「内置默认」：llm 段为空时用角色自带推荐值，sourceLevel=default',
  p.models.outline.sourceLevel === 'default' && p.models.outline.provider === 'deepseek' && p.models.outline.model === 'deepseek-chat',
  `${p.models.outline.provider}/${p.models.outline.model} · ${p.models.outline.sourceLevel} · ${p.models.outline.source}`);

// ③ 既有分段默认：只配 llm 段
saveConfig({ llm: { provider: 'mock', model: 'deepseek-chat', baseUrl: DEAD_BASE, temperature: 0.85 } });
p = planOf();
ok('第 3 层「既有分段默认」：llm 段（mock/deepseek-chat）压过内置默认，sourceLevel=kind',
  p.models.outline.sourceLevel === 'kind' && p.models.outline.provider === 'mock' && p.models.outline.model === 'deepseek-chat'
  && /llm 段/.test(p.models.outline.source),
  `${p.models.outline.provider}/${p.models.outline.model} · ${p.models.outline.source}`);

// ② 搭配方案
saveConfig({ models: { activeProfile: '高质量' } });
p = planOf();
ok('第 2 层「搭配方案」：激活的高质量方案压过既有分段默认，sourceLevel=profile 且来源中文含方案名',
  p.models.outline.sourceLevel === 'profile' && p.models.outline.model === 'deepseek-reasoner'
  && /搭配方案「高质量」/.test(p.models.outline.source),
  `${p.models.outline.provider}/${p.models.outline.model} · ${p.models.outline.source}`);

// ① 角色显式设置
saveConfig({ models: { roles: { outline: { provider: 'mock', model: 'mock-role-model', temperature: 0.5 } } } });
p = planOf();
ok('第 1 层「角色显式设置」：压过激活的方案与既有分段，sourceLevel=role',
  p.models.outline.sourceLevel === 'role' && p.models.outline.model === 'mock-role-model'
  && /角色显式设置/.test(p.models.outline.source),
  `${p.models.outline.provider}/${p.models.outline.model} · ${p.models.outline.source}`);
ok('四层优先级逐字段合并（provider 来自角色、baseUrl 仍来自既有分段，没有整体覆盖）',
  /provider←角色显式设置/.test(p.models.outline.source) && /baseUrl←/.test(p.models.outline.source)
  && p.models.outline.sourceLevel === 'role',
  String(p.models.outline.source).slice(0, 80));
ok('角色级 temperature 也随之生效（逐字段分层，不是整体覆盖）',
  p.models.outline.temperature === 0.5 && p.models.chapter.temperature === 0.85,
  `outline=${p.models.outline.temperature} chapter=${p.models.chapter.temperature}`);

// 角色层字段写全时，source 会直接给出配置路径（回答「为什么用这个模型」时可溯源）
saveConfig({ models: { roles: { outline: { provider: 'mock', model: 'mock-role-model', baseUrl: DEAD_BASE, temperature: 0.5 } } } });
p = planOf();
ok('角色层字段写全时，source 直接给出配置路径（config.models.roles.outline）',
  /config\.models\.roles\.outline/.test(p.models.outline.source) && p.models.outline.sourceLevel === 'role',
  p.models.outline.source);

saveConfig({ llm: { provider: 'mock', model: 'deepseek-chat', baseUrl: DEAD_BASE, temperature: 0.85 }, models: { activeProfile: '', roles: {} } });

console.log('\n=== 5. 降级安全：配置缺失/未登记/类别不匹配/缺凭据 → 回落既有全局段行为（中文原因） ===');
saveConfig({ models: { roles: { outline: { provider: 'no-such-provider', model: 'x', baseUrl: '' } } } });
let bad = planOf('novel');
ok('提供方未登记 → 不驱动，fallbackReason 中文点明「未登记」',
  bad.models.outline.applied === false && bad.models.outline.fallback === true
  && /未登记/.test(bad.models.outline.fallbackReason || '') && isCN(bad.models.outline.fallbackReason),
  String(bad.models.outline.fallbackReason));

saveConfig({ models: { roles: { outline: { provider: 'openai-images', model: 'gpt-image-1', baseUrl: '' } } } });
bad = planOf('novel');
ok('类别不匹配（文本角色配了出图提供方）→ 回落并说明不支持该类别',
  bad.models.outline.applied === false && /不支持文本生成/.test(bad.models.outline.fallbackReason || ''),
  String(bad.models.outline.fallbackReason));

saveConfig({ models: { roles: { outline: { provider: 'openai', model: 'gpt-4o', baseUrl: '' } } } });
bad = planOf('novel', { env: {} });            // env={} 固定住「缺 Key」判定，与宿主机凭据无关
ok('缺凭据 → 回落既有全局段行为（中文原因带上 keyDetail）',
  bad.models.outline.applied === false && /回落既有全局段行为/.test(bad.models.outline.fallbackReason || '')
  && /缺少 API Key/.test(bad.models.outline.fallbackReason || ''),
  String(bad.models.outline.fallbackReason));

saveConfig({ models: { roles: { outline: { provider: 'openai', baseUrl: 'https://proxy.example.com' } } } });
bad = planOf('novel', { env: { OPENAI_API_KEY: 'sk-test-not-real' } });
ok('角色显式设了自定义 baseUrl（既有模块入参透传不了）→ 宁可不驱动，也不把请求打到别的端点',
  bad.models.outline.applied === false && /baseUrl/.test(bad.models.outline.fallbackReason || ''),
  String(bad.models.outline.fallbackReason));

// 离线红线：角色指向真实提供方时，离线模式下一律不驱动（保证本任务与离线跑批都零付费）
saveConfig({ models: { roles: { promptOpt: { provider: 'deepseek', model: 'deepseek-reasoner' } } } });
const offlinePlan = planOf('canvasAgent', { offline: true });
ok('★ 离线模式（offline=true）：角色指向真实提供方也一律不驱动，中文原因写明「不发起真实调用」',
  offlinePlan.models.promptOpt.applied === false && /离线模式/.test(offlinePlan.models.promptOpt.fallbackReason || '')
  && isCN(offlinePlan.models.promptOpt.fallbackReason),
  String(offlinePlan.models.promptOpt.fallbackReason));

ok('未知阶段/无角色阶段 → 解析为空但不抛错（防御性回落）',
  (() => { try { const r = St.stageRolePlan('not-a-stage'); return r.models && Object.keys(r.models).length === 0 && r.picks && Object.keys(r.picks).length === 0; } catch { return false; } })());

// 用「坏配置」真跑一遍阶段：必须仍然成功（绝不因缺配置让阶段失败）
saveConfig({ models: { roles: { outline: { provider: 'no-such-provider', model: 'x', baseUrl: '', temperature: '' }, storyboard: { provider: 'openai-images', model: 'gpt-image-1', baseUrl: '' } } } });
const P2 = await St.createProduction({ brief: '拍一部一集的短剧，每集 15 秒，2 个角色', offline: true, spec: { castSize: 2 } });
await St.runStage(P2.id, 'brief', { offline: true });
await St.runStage(P2.id, 'cast', { offline: true });
const badNovelRun = await St.runStage(P2.id, 'novel', { offline: true, onLog: (m) => logs.push(m) });
const badScriptRun = await St.runStage(P2.id, 'script', { offline: true, onLog: (m) => logs.push(m) });
ok('坏配置下 novel/script 阶段照旧成功（ok=true，没有因角色配置失败）',
  badNovelRun.ok === true && badScriptRun.ok === true);
ok('坏配置下 artifact 里留下中文回落原因（fallback + fallbackReason）',
  badNovelRun.artifact.models.outline.fallback === true && isCN(badNovelRun.artifact.models.outline.fallbackReason)
  && badScriptRun.artifact.models.storyboard.fallback === true && isCN(badScriptRun.artifact.models.storyboard.fallbackReason),
  String(badNovelRun.artifact.models.outline.fallbackReason).slice(0, 80));
ok('坏配置不影响既有产物（大纲章节与分镜照旧产出）',
  badNovelRun.artifact.outlineChapters > 0 && badScriptRun.artifact.shots > 0,
  `outline=${badNovelRun.artifact.outlineChapters} 章 · shots=${badScriptRun.artifact.shots}`);
ok('坏配置下列表兜底走既有全局段行为（provider=mock）',
  badNovelRun.artifact.provider === 'mock' && badScriptRun.artifact.provider === 'mock');

console.log('\n=== 6. 既有 artifact 字段一个不少（语义未变） ===');
ok('brief：spec / hits / mode / note 仍在',
  Boolean(briefArt.spec?.episodes) && Array.isArray(briefArt.hits) && briefArt.mode === 'offline' && Boolean(briefArt.note),
  `episodes=${briefArt.spec?.episodes} hits=${briefArt.hits.length} mode=${briefArt.mode}`);
ok('novel：novelId / title / outlineId / outlineChapters / outlineWarnings / chaptersWritten / provider 仍在',
  Boolean(novelRun.artifact.novelId) && Boolean(novelRun.artifact.title) && 'outlineId' in novelRun.artifact
  && novelRun.artifact.outlineChapters > 0 && Array.isArray(novelRun.artifact.outlineWarnings)
  && novelRun.artifact.chaptersWritten >= 0 && Boolean(novelRun.artifact.provider),
  `${novelRun.artifact.novelId} · 大纲 ${novelRun.artifact.outlineChapters} 章 · 正文 ${novelRun.artifact.chaptersWritten} 章`);
ok('script：scriptId / title / episodes / shots / plan / perEpisode / provider 仍在',
  Boolean(scriptRun.artifact.scriptId) && scriptRun.artifact.episodes === 2 && scriptRun.artifact.shots > 0
  && scriptRun.artifact.plan === 2 && scriptRun.artifact.perEpisode.every((e) => e.code && 'shots' in e)
  && Boolean(scriptRun.artifact.provider),
  `episodes=${scriptRun.artifact.episodes} shots=${scriptRun.artifact.shots}`);
ok('canvas：canvasId / canvasName / episodes / timelineNodeIds / keyframeNodes / videoNodes / nodes 仍在',
  Boolean(canvasRun.artifact.canvasId) && Boolean(canvasRun.artifact.canvasName)
  && canvasRun.artifact.keyframeNodes > 0 && canvasRun.artifact.videoNodes > 0
  && canvasRun.artifact.timelineNodeIds.length === 2 && Array.isArray(canvasRun.artifact.nodes));
ok('keyframe/video 计划 artifact：plan_id / plan / costLevel / estimate / episodes / nodeIds 仍在',
  Boolean(kfPlanArt.plan_id) && kfPlanArt.plan?.steps?.run?.length > 0
  && ['L', 'M', 'H'].includes(kfPlanArt.costLevel) && Array.isArray(kfPlanArt.nodeIds)
  && kfPlanArt.episodes.length === 2 && Boolean(videoPlanArt2.plan_id));
ok('qc：episodes / verdicts / summary 仍在',
  qcRun.artifact.episodes === 2 && qcRun.artifact.verdicts.length === 2 && typeof qcRun.artifact.summary === 'string');

console.log('\n=== 7. 零付费反证 + 「按角色真的把模型传给了调用点」 ===');
ok('出图/视频后端仍是 placeholder（配置层面不可能计费）',
  loadConfig().image.backend === 'placeholder' && loadConfig().video.backend === 'placeholder',
  `${loadConfig().image.backend} / ${loadConfig().video.backend}`);
const runsBeforePaid = get('SELECT COUNT(*) c FROM canvas_node_runs').c;
const jobsBeforePaid = get('SELECT COUNT(*) c FROM jobs').c;
ok('所有阶段（含付费阶段建计划）零生成调用、零新任务',
  runsBeforePaid === 0 && jobsBeforePaid === 0, `runs=${runsBeforePaid} jobs=${jobsBeforePaid}`);
ok('用量台账金额 0（本月图/视频/配音用量全 0）',
  getUsage().images === 0 && getUsage().videos === 0 && getUsage().amount === 0,
  JSON.stringify(getUsage()));

// ★ 接线真的生效：把 llm 段指向「死端口 + 假 Key」，角色指向 mock。
//   若角色没驱动成功 → 代码会回落既有全局段行为 → 打向 127.0.0.1:9（连接被拒）→ 阶段必然失败；
//   角色驱动成功 → provider=mock（离线模板）→ 阶段成功且 model 记为 mock-template。全程零网络、零计费。
saveConfig({
  llm: { provider: 'deepseek', baseUrl: DEAD_BASE, apiKey: 'sk-role-wiring-test-not-real', model: 'deepseek-chat', temperature: 0.85 },
  models: {
    activeProfile: '',
    roles: {
      brief: { provider: 'mock', baseUrl: '' }, outline: { provider: 'mock', model: '', baseUrl: '', temperature: '' },
      chapter: { provider: 'mock', baseUrl: '' }, script: { provider: 'mock', baseUrl: '' },
      storyboard: { provider: 'mock', baseUrl: '' }, promptOpt: { provider: 'mock', baseUrl: '' },
    },
  },
});
const P3 = await St.createProduction({ brief: '拍一部一集的短剧，每集 15 秒，2 个角色', offline: true, spec: { castSize: 2, chaptersToWrite: 1 } });
const driveBrief = await St.runStage(P3.id, 'brief', { offline: false });
await St.runStage(P3.id, 'cast', { offline: true });
ok('★ brief 角色 driving 生效：parseBrief 收到角色给的 mock（note=按离线规则解析，而不是「模型解析失败」）',
  driveBrief.ok === true && driveBrief.artifact.mode === 'offline' && driveBrief.artifact.note === '按离线规则解析'
  && driveBrief.artifact.models.brief.applied === true && driveBrief.artifact.models.brief.provider === 'mock',
  `mode=${driveBrief.artifact.mode} note=${driveBrief.artifact.note}`);
// 既有 runBrief 会把 spec.chaptersToWrite 归零（离线解析出的默认 0 会盖掉显式值，属既有行为、本次不动它）：
// 为了真的走一遍「chapter 角色驱动正文写作」，这里直接改库把章节数打开（只改测试项目自己的一行 spec）。
const p3Spec = St.getProduction(P3.id).spec || {};
run('UPDATE productions SET spec = ? WHERE id = ?', JSON.stringify({ ...p3Spec, chaptersToWrite: 1 }), P3.id);
const driveNovel = await St.runStage(P3.id, 'novel', { offline: false });
const outlineModel = get('SELECT model FROM novel_outlines WHERE novel_id = ? ORDER BY version DESC LIMIT 1', driveNovel.artifact.novelId)?.model;
const chapterModel = get('SELECT model FROM novel_chapters WHERE novel_id = ? ORDER BY idx ASC LIMIT 1', driveNovel.artifact.novelId)?.model;
ok('★ 大纲确实按角色走 mock 模型（novel_outlines.model = mock-template，没有打到真实端点）',
  driveNovel.ok === true && outlineModel === 'mock-template' && driveNovel.artifact.models.outline.applied === true,
  `outline.model=${outlineModel} · ${driveNovel.artifact.models.outline.provider}/${driveNovel.artifact.models.outline.model}`);
ok('★ 章节正文按 chapter 角色驱动（novel_chapters.model = mock-template）',
  chapterModel === 'mock-template' && driveNovel.artifact.models.chapter.applied === true,
  `chapter.model=${chapterModel}`);
const driveScript = await St.runStage(P3.id, 'script', { offline: false });
const scriptPlan = (() => { try { return JSON.parse(get('SELECT plan FROM scripts WHERE id = ?', driveScript.artifact.scriptId)?.plan || '{}'); } catch { return {}; } })();
ok('★ 分集规划/分镜按 script、storyboard 角色走 mock 分支（llmCalls=0，未发起任何 LLM 调用）',
  driveScript.ok === true && scriptPlan.llmCalls === 0 && scriptPlan.mode === 'fallback'
  && driveScript.artifact.models.script.applied === true && driveScript.artifact.models.storyboard.applied === true
  && driveScript.artifact.shots > 0,
  `llmCalls=${scriptPlan.llmCalls} mode=${scriptPlan.mode} shots=${driveScript.artifact.shots}`);
ok('★ 全程仍零生成调用、零用量金额（真跑也没有产生任何计费）',
  get('SELECT COUNT(*) c FROM canvas_node_runs').c === 0 && getUsage().amount === 0 && getUsage().images === 0 && getUsage().videos === 0,
  `runs=${get('SELECT COUNT(*) c FROM canvas_node_runs').c} amount=${getUsage().amount}`);

console.log('\n=== 8. 角色字典对齐与临时库隔离 ===');
ok('接线覆盖 12 个角色中的 11 个（tts 角色的调用点在成片/画布执行链里，本文件不改那里的代码）',
  new Set(Object.values(St.STAGE_ROLES).flat()).size === 11
  && MR.ROLE_IDS.every((id) => id === 'tts' || Object.values(St.STAGE_ROLES).flat().includes(id)),
  Object.entries(St.STAGE_ROLES).map(([k, v]) => `${k}:${v.join('+')}`).join(' | '));
ok('用到的角色 id 全部来自 model-registry 的角色字典（没有自造角色）',
  Object.values(St.STAGE_ROLES).flat().every((id) => Boolean(MR.getRole(id))));
ok('使用临时库与临时配置（真实 config/config.json 未被触碰）',
  process.env.FACTORY_DB === path.join(TMP, 'rolewiring.db') && fs.existsSync(process.env.FACTORY_CONFIG));

console.log('\n=== 9. M-101：google 登记后 studio 的角色接线判定（「未登记」→「不支持该类别」）===');
{
  // stageRolePlan 是纯读配置的解析（不发请求、不写磁盘），最适合检验「登记之后接线怎么判」：
  // 把 google 同时配给「有调用点的文本角色 brief」与「无调用点的 qcVision」，看两条判定是否都成立。
  saveConfig({
    models: {
      activeProfile: '',
      roles: {
        brief: { provider: 'google', model: 'gemini-3.8-flash' },
        qcVision: { provider: 'google', model: 'gemini-3.8-flash', baseUrl: 'https://generativelanguage.googleapis.com', apiKey: 'AIza-offline-test' },
      },
    },
  });
  const jobsBeforePlan = get('SELECT COUNT(*) c FROM jobs').c;
  const planBrief = St.stageRolePlan('brief', { env: {} });
  const planQc = St.stageRolePlan('qc', { env: {} });
  ok('登记生效：文本角色选 google → 回落原因是「不支持文本生成」（不再是「未登记」），且绝不驱动调用点',
    planBrief.models.brief.fallback === true && /不支持/.test(planBrief.models.brief.fallbackReason || '')
      && !/未登记/.test(planBrief.models.brief.fallbackReason || '') && !planBrief.picks.brief
      && /不支持/.test(planBrief.models.brief.note || ''),
    `${planBrief.models.brief.fallbackReason}`);
  ok('登记生效：qcVision 解析出 google / gemini-3.8-flash（该阶段无读图调用点：只记录、不发起任何请求）',
    planQc.models.qcVision.provider === 'google' && planQc.models.qcVision.model === 'gemini-3.8-flash'
      && planQc.models.qcVision.applied === false && !planQc.picks.qcVision
      && /多模态读图/.test(planQc.models.qcVision.note || '') && isCN(planQc.models.qcVision.note),
    `${planQc.models.qcVision.provider} / ${planQc.models.qcVision.model}｜${String(planQc.models.qcVision.note).slice(0, 60)}`);
  ok('零付费：上述解析不新建任何任务（jobs 数不变）',
    get('SELECT COUNT(*) c FROM jobs').c === jobsBeforePlan && getUsage().amount === 0,
    `jobs=${jobsBeforePlan} → ${get('SELECT COUNT(*) c FROM jobs').c}｜amount=${getUsage().amount}`);
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
if (fail) process.exitCode = 1;
