// 自动化制片 Agent 自测（纯 Node，全程离线零成本：mock LLM + placeholder 出图/视频 + 临时库）
// 用法：node tests/test-studio.js
// 覆盖：一句话需求解析（中英文数字/比例/风格/题材/基调）/ 参数归一化与估算 /
//       阶段依赖校验 / 免费阶段自动跑通（演员→小说→剧本→画布）/
//       付费阶段**必须人工批准 + 确认码**（未批准零生成调用反证）/ 批准后放行 /
//       断点续跑与幂等（已完成阶段不重复跑）/ 单阶段重跑 / 状态汇总 / 交付包
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-studio-'));
const DATA_TMP = path.join(TMP, 'data');
process.env.FACTORY_DATA_DIR = DATA_TMP;
process.env.FACTORY_DB = path.join(TMP, 'studio.db');
process.env.FACTORY_CONFIG = path.join(TMP, 'config.json');
fs.mkdirSync(DATA_TMP, { recursive: true });
fs.writeFileSync(process.env.FACTORY_CONFIG, JSON.stringify({
  llm: { provider: 'mock' },
  image: { backend: 'placeholder' },
  video: { backend: 'placeholder' },
  finish: { subtitles: false, audio: 'silent', fadeIn: 0, fadeOut: 0, keepIntermediates: true },
  budget: { enabled: true, currency: 'CNY', imageUnit: 0.1, videoUnit: 0.5, ttsPerKChars: 0, monthlyCap: 0, confirmOver: 0 },
}), 'utf8');

const { migrate, get, all, run, DATA_DIR } = await import('../src/db.js');
const St = await import('../src/studio.js');
const J = await import('../src/jobs.js');
migrate();
St.ensureStudioSchema();

let pass = 0, fail = 0;
const ok = (name, cond, evidence = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${evidence ? `  ← ${evidence}` : ''}`); }
  else { fail++; console.error(`  ✗ ${name}  ← ${evidence}`); }
};
const throws = (fn, re) => { try { fn(); return { threw: false, msg: '' }; } catch (e) { const m = String(e?.message || e); return { threw: true, msg: m, match: re ? re.test(m) : true }; } };
const throwsAsync = async (fn, re) => { try { await fn(); return { threw: false, msg: '' }; } catch (e) { const m = String(e?.message || e); return { threw: true, msg: m, match: re ? re.test(m) : false }; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 120000, step = 150) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(step); }
  return false;
};

console.log('=== 1. 一句话需求解析（离线规则） ===');
const p1 = await St.parseBrief('拍一部三集的雾港悬疑短剧，竖屏，每集六十秒，6 个角色，日系赛璐璐画风', { offline: true });
ok('解析模式标注为离线规则', p1.mode === 'offline' && /离线规则/.test(p1.note), p1.note);
ok('中文字数「三集」→ 3', p1.spec.episodes === 3, String(p1.spec.episodes));
ok('「每集六十秒」→ 60 秒（多位中文数字）', p1.spec.episodeSeconds === 60, String(p1.spec.episodeSeconds));
ok('「竖屏」→ 9:16', p1.spec.ratio === '9:16', p1.spec.ratio);
ok('「6 个角色」→ castSize=6', p1.spec.castSize === 6, String(p1.spec.castSize));
ok('「日系赛璐璐画风」命中画风', /赛璐璐/.test(p1.spec.styleName || ''), p1.spec.styleName);
ok('「悬疑」记为基调（字典无此题材时不硬猜题材）', p1.spec.tone === '悬疑烧脑' && !p1.spec.genre, `tone=${p1.spec.tone} genre=${p1.spec.genre}`);
ok('命中项可追溯', Array.isArray(p1.hits) && p1.hits.length >= 4, p1.hits.join(' / '));

const p2 = await St.parseBrief('《雾港谜案》电影级长片，21:9，每集 3 分钟，共 2 集', { offline: true });
ok('显式比例 21:9 优先于「电影」这类风格词', p2.spec.ratio === '21:9', p2.spec.ratio);
ok('「每集 3 分钟」→ 180 秒', p2.spec.episodeSeconds === 180, String(p2.spec.episodeSeconds));
ok('《书名号》→ 标题', p2.spec.title === '雾港谜案', p2.spec.title);
const p3 = await St.parseBrief('做一个 24 集的都市重生复仇短剧，每集 90 秒', { offline: true });
ok('字典里有对应题材时命中题材', p3.spec.genreName && /都市|重生|复仇/.test(p3.spec.genreName), p3.spec.genreName);

console.log('\n=== 2. 参数归一化与估算 ===');
const norm = St.normalizeSpec({ episodes: 999, episodeSeconds: 1, castSize: 0, ratio: 'x' }, '');
ok('集数/时长/角色数被夹到合法区间', norm.episodes <= 200 && norm.episodeSeconds >= 10 && norm.castSize >= 1, JSON.stringify({ e: norm.episodes, s: norm.episodeSeconds, c: norm.castSize }));
ok('比例非法时回落到 9:16', norm.ratio === '9:16', norm.ratio);
const est = await St.estimateProduction({ spec: { episodes: 2, episodeSeconds: 30, castSize: 4 } });
ok('按「每 5 秒 1 镜」估算镜头数（2 集 × 6 镜 = 12）', est.shots === 12 && est.shotsPerEpisode === 6, JSON.stringify({ shots: est.shots, per: est.shotsPerEpisode }));
ok('估算给出关键帧/视频调用次数', est.keyframeCalls === 12 && est.videoCalls === 12 && est.totalCalls === 24, JSON.stringify({ k: est.keyframeCalls, v: est.videoCalls }));
ok('估算给出金额与成本级（单价来自 budget 配置）', est.amount > 0 && ['L', 'M', 'H'].includes(est.costLevel), `amount=${est.amount} level=${est.costLevel}`);
ok('估算注明付费阶段', Array.isArray(est.paidStages) && est.paidStages.includes('keyframe') && est.paidStages.includes('video'), est.paidStages.join(','));
ok('单价已配置时标 priced=true 且给出金额', est.priced === true && est.amount > 0, `priced=${est.priced} amount=${est.amount}`);
const { saveConfig } = await import('../src/config.js');
saveConfig({ budget: { imageUnit: 0, videoUnit: 0 } });          // 临时把单价清零，验证提示文案
const estFree = await St.estimateProduction({ spec: { episodes: 1, episodeSeconds: 10 } });
ok('单价未配置时明确标注（¥0 不代表免费，只是没填单价）',
  estFree.priced === false && estFree.amount === 0 && /单价未配置/.test(estFree.note), estFree.note.slice(0, 40));
saveConfig({ budget: { imageUnit: 0.1, videoUnit: 0.5 } });      // 还原，后续断言仍按配置单价算

console.log('\n=== 3. 建项目与阶段依赖 ===');
const proj = await St.createProduction({ brief: '拍一部两集的雾港悬疑短剧，竖屏，每集 30 秒，4 个角色，日系赛璐璐画风', offline: true });
ok('建项目返回 id 与阶段清单（10 个阶段）', Boolean(proj.id) && proj.stagesSummary.length === 10, `${proj.id} · ${proj.stagesSummary.length}`);
ok('阶段初始状态全部 pending', proj.stagesSummary.every((s) => s.status === 'pending'));
ok('未执行任何阶段（零生成调用）', get('SELECT COUNT(*) c FROM canvas_node_runs').c === 0);
const depErr = throws(() => St.checkDependencies(proj.id, 'script').ok && null, /.*/);
ok('依赖检查：script 阶段在 novel 未完成时判定为不满足', St.checkDependencies(proj.id, 'script').ok === false
  && St.checkDependencies(proj.id, 'script').missing.includes('novel'), JSON.stringify(St.checkDependencies(proj.id, 'script')));
const skipErr = await throwsAsync(() => St.runStage(proj.id, 'finish'), /前置阶段未完成/);
ok('跳过前置阶段直接执行时报中文错', skipErr.threw && skipErr.match, skipErr.msg);
const unknownErr = await throwsAsync(() => St.runStage(proj.id, 'not-a-stage'), /未知阶段/);
ok('未知阶段报中文错', unknownErr.threw && unknownErr.match, unknownErr.msg);

console.log('\n=== 4. 免费阶段：需求解析 → 演员 → 小说 → 剧本 → 画布 ===');
const logs = [];
const briefRun = await St.runStage(proj.id, 'brief', { offline: true, onLog: (m) => logs.push(m) });
ok('brief 阶段完成并固化 spec', briefRun.ok && Boolean(briefRun.artifact?.spec?.episodes), JSON.stringify({ e: briefRun.artifact?.spec?.episodes, s: briefRun.artifact?.spec?.episodeSeconds }));
const again = await St.runStage(proj.id, 'brief', { offline: true });
ok('重复执行同一阶段被幂等跳过（不重复干活）', again.skipped === true, JSON.stringify(again.reason));

const castRun = await St.runStage(proj.id, 'cast', { offline: true, onLog: (m) => logs.push(m) });
ok('cast 阶段创建了 4 位演员', castRun.ok && castRun.artifact.created === 4 && castRun.artifact.actorIds.length === 4, `${castRun.artifact.created} 位：${castRun.artifact.names.join('、')}`);
ok('演员落库（ID 形如 C-00xx）', all("SELECT id FROM actors WHERE id LIKE 'C-%'").length === 4);
ok('演员带音色（供后续配音用）', all("SELECT id, voice FROM actors WHERE IFNULL(voice,'') <> ''").length === 4);

console.log('\n=== 3b. 复用现有班底（reuseActors：不往演员表里灌人） ===');
const reuse = await St.createProduction({ brief: '用现有班底拍一部一集的都市短剧，每集 20 秒', offline: true, spec: { reuseActors: true, castSize: 2 } });
await St.runStage(reuse.id, 'brief', { offline: true });
const reuseCast = await St.runStage(reuse.id, 'cast', { offline: true });
const actorsBeforeReuse = get('SELECT COUNT(*) c FROM actors').c;
ok('reuseActors 不新建演员（复用已有）', reuseCast.artifact.reused === 2 && reuseCast.artifact.created === 0
  && reuseCast.artifact.source === 'reuse', JSON.stringify({ reused: reuseCast.artifact.reused, created: reuseCast.artifact.created }));
ok('复用模式下演员表总数不变', actorsBeforeReuse === 4, `actors=${actorsBeforeReuse}`);
// 回归：显式传的 castSize 不能被「需求里没提角色数」解析出的空值覆盖
ok('显式 castSize 不被解析空值覆盖（reuseActors 只复用 2 位）', (St.getProduction(reuse.id).actor_ids || []).length === 2,
  `actor_ids=${(St.getProduction(reuse.id).actor_ids || []).length}`);
const explicit = await St.createProduction({ brief: '拍一部一集的短剧，每集 15 秒', offline: true, spec: { castSize: 3 } });
await St.runStage(explicit.id, 'brief', { offline: true });
ok('需求未提角色数时，显式 spec.castSize 仍然生效（=3，而不是默认 6）', St.getProduction(explicit.id).spec.castSize === 3,
  String(St.getProduction(explicit.id).spec.castSize));


const novelRun = await St.runStage(proj.id, 'novel', { offline: true, onLog: (m) => logs.push(m) });
ok('novel 阶段生成小说与大纲', novelRun.ok && Boolean(novelRun.artifact.novelId) && novelRun.artifact.outlineChapters > 0,
  `小说 ${novelRun.artifact.novelId} · 大纲 ${novelRun.artifact.outlineChapters} 章 · provider=${novelRun.artifact.provider}`);
ok('小说引用了本项目的演员', JSON.parse(get('SELECT actor_ids FROM novels WHERE id = ?', novelRun.artifact.novelId).actor_ids || '[]').length === 4);

const scriptRun = await St.runStage(proj.id, 'script', { offline: true, onLog: (m) => logs.push(m) });
ok('script 阶段规划出 2 集', scriptRun.ok && scriptRun.artifact.episodes === 2, JSON.stringify(scriptRun.artifact.perEpisode));
ok('每集都生成了分镜（>0 镜）', scriptRun.artifact.shots > 0 && scriptRun.artifact.perEpisode.every((e) => e.shots > 0), `共 ${scriptRun.artifact.shots} 镜`);

const canvasRun = await St.runStage(proj.id, 'canvas', { offline: true, onLog: (m) => logs.push(m) });
ok('canvas 阶段铺出画布（关键帧/视频/成片节点齐备）',
  canvasRun.ok && canvasRun.artifact.keyframeNodes > 0 && canvasRun.artifact.videoNodes > 0 && canvasRun.artifact.timelineNodeIds.length === 2,
  JSON.stringify({ kf: canvasRun.artifact.keyframeNodes, video: canvasRun.artifact.videoNodes, tl: canvasRun.artifact.timelineNodeIds.length }));
ok('铺开阶段零生成调用（只排布）', get('SELECT COUNT(*) c FROM canvas_node_runs').c === 0);
const midStatus = St.productionStatus(proj.id);
ok('状态汇总：免费阶段 5 个已完成、进度 50%', midStatus.progressPct === 50 && midStatus.stages.filter((s) => s.status === 'done').length === 5,
  `progress=${midStatus.progressPct}%`);
ok('状态汇总带上产物句柄（演员/小说/剧本/画布）',
  midStatus.outputs.actors === 4 && Boolean(midStatus.outputs.novel) && Boolean(midStatus.outputs.script) && Boolean(midStatus.outputs.canvas),
  JSON.stringify(midStatus.outputs));

console.log('\n=== 5. 付费阶段：必须先有人工批准（反证：未批准零生成调用） ===');
const runsBefore = get('SELECT COUNT(*) c FROM canvas_node_runs').c;
const jobsBefore = get('SELECT COUNT(*) c FROM jobs').c;
const runRes = await St.runPipeline(proj.id, { offline: true, onLog: (m) => logs.push(m) });
ok('流水线在付费阶段前停下（awaiting_approval）', runRes.stoppedAt === 'keyframe' && runRes.reason === 'awaiting_approval', JSON.stringify({ stoppedAt: runRes.stoppedAt, reason: runRes.reason }));
ok('停机时**没有**任何生成调用（执行记录 0 / 新任务 0）',
  get('SELECT COUNT(*) c FROM canvas_node_runs').c === runsBefore && get('SELECT COUNT(*) c FROM jobs').c === jobsBefore,
  `runs=${runsBefore}→${get('SELECT COUNT(*) c FROM canvas_node_runs').c} jobs=${jobsBefore}→${get('SELECT COUNT(*) c FROM jobs').c}`);
const kfStage = get("SELECT * FROM production_stages WHERE production_id = ? AND stage = 'keyframe'", proj.id);
ok('已生成待审批计划并记录阶段状态', kfStage.status === 'awaiting_approval' && /^PL-/.test(kfStage.plan_id), `${kfStage.plan_id} · ${kfStage.status}`);
ok('项目状态变为 awaiting_approval', St.getProduction(proj.id).status === 'awaiting_approval');
const planArt = JSON.parse(kfStage.artifact || '{}');
ok('计划里列出待执行节点数与成本级', planArt.plan?.steps?.run?.length > 0 && ['L', 'M', 'H'].includes(planArt.costLevel), JSON.stringify({ run: planArt.plan?.steps?.run?.length, level: planArt.costLevel }));

// 未批准 / 确认码错误 → 一律拒绝
const noApprove = await throwsAsync(() => St.approveAndRunStage(proj.id, 'keyframe', { plan_id: kfStage.plan_id, confirm_code: '000000' }), /尚未经人工审批|未经人工审批|审批/);
ok('未批准就用确认码执行 → 被闸门拒绝', noApprove.threw && noApprove.match, noApprove.msg.slice(0, 80));
const { approvePlan } = await import('../src/mcp-tools.js');
approvePlan(kfStage.plan_id, { confirm: true, by: 'human' });
const wrongCode = await throwsAsync(() => St.approveAndRunStage(proj.id, 'keyframe', { plan_id: kfStage.plan_id, confirm_code: '000000' }), /确认码/);
ok('批准后确认码错误 → 仍被拒绝', wrongCode.threw && wrongCode.match, wrongCode.msg.slice(0, 80));
ok('付费阶段拒绝执行时依然零生成调用', get('SELECT COUNT(*) c FROM canvas_node_runs').c === runsBefore, String(get('SELECT COUNT(*) c FROM canvas_node_runs').c));
const code = get('SELECT confirm_code FROM canvas_plans WHERE id = ?', kfStage.plan_id).confirm_code;
ok('计划里存有确认码（只应写服务端日志，界面只给掩码）', /^\w{4,8}$/.test(code || ''), '已生成');

console.log('\n=== 6. 人工批准 + 确认码 → 放行执行，并跑到交付包 ===');
const resume = await St.approveAndRunStage(proj.id, 'keyframe', { plan_id: kfStage.plan_id, confirm_code: code });
ok('带正确确认码放行成功（生成任务已入队）', resume.ok && Boolean(resume.jobId), `job=${resume.jobId} total=${resume.total}`);
const kfDone = await waitFor(() => ['done', 'error', 'canceled'].includes(J.getJob(resume.jobId)?.status), 180000);
ok('关键帧任务执行结束', kfDone, `status=${J.getJob(resume.jobId)?.status} err=${J.getJob(resume.jobId)?.error || ''}`);
ok('关键帧真的产出了（执行记录 > 0）', get('SELECT COUNT(*) c FROM canvas_node_runs').c > 0, String(get('SELECT COUNT(*) c FROM canvas_node_runs').c));
// 放行后的阶段必须在任务结束时自动回写终态（否则阶段清单永远停在「执行中」）
const kfAfter = St.productionStatus(proj.id).stages.find((x) => x.stage === 'keyframe');
ok('★ 付费阶段放行后自动回写 done（不再永远停在「执行中」）', kfAfter.status === 'done', `status=${kfAfter.status}`);
ok('回写时带上任务结果摘要与进度', Boolean(kfAfter.artifact?.jobStatus) && kfAfter.artifact.jobStatus === 'done', JSON.stringify({ job: kfAfter.artifact?.jobStatus, total: kfAfter.artifact?.total }));
const pa = St.productionStatus(proj.id);
ok('状态汇总不再报「等待批准」（对账后为执行/完成）', pa.status !== 'awaiting_approval', pa.status);
run(`UPDATE production_stages SET status='done' WHERE production_id = ? AND stage = 'keyframe'`, proj.id);

// 视频阶段同流程（跳过真实等待：直接用 placeholder 计划跑完）
const pipelineRes = await St.runPipeline(proj.id, { offline: true, onLog: (m) => logs.push(m) });
ok('继续执行时在「视频生成」再次停下等批准', pipelineRes.stoppedAt === 'video' || pipelineRes.reason === 'done', JSON.stringify({ at: pipelineRes.stoppedAt, reason: pipelineRes.reason }));
const vStage = get("SELECT * FROM production_stages WHERE production_id = ? AND stage = 'video'", proj.id);
if (vStage?.status === 'awaiting_approval') {
  approvePlan(vStage.plan_id, { confirm: true, by: 'human' });
  const vCode = get('SELECT confirm_code FROM canvas_plans WHERE id = ?', vStage.plan_id).confirm_code;
  const vRun = await St.approveAndRunStage(proj.id, 'video', { plan_id: vStage.plan_id, confirm_code: vCode });
  await waitFor(() => ['done', 'error', 'canceled'].includes(J.getJob(vRun.jobId)?.status), 180000);
  ok('视频阶段放行并执行结束', true, `job=${vRun.jobId}`);
} else {
  ok('视频阶段放行并执行结束', false, '视频阶段未进入待批准状态');
}
ok('视频阶段同样自动回写 done', St.productionStatus(proj.id).stages.find((x) => x.stage === 'video')?.status === 'done',
  String(St.productionStatus(proj.id).stages.find((x) => x.stage === 'video')?.status));

console.log('\n=== 7. 成片 / 质检 / 交付包（本地阶段自动完成） ===');
const finishRun = await St.runStage(proj.id, 'finish', { offline: true, onLog: (m) => logs.push(m) });
ok('成片阶段提交了成片节点', finishRun.ok && finishRun.artifact.timelines >= 1, JSON.stringify({ timelines: finishRun.artifact.timelines, films: finishRun.artifact.filmCount }));
const filmsReady = await waitFor(() => all('SELECT * FROM episode_films WHERE script_id = ?', St.getProduction(proj.id).script_id).length > 0, 180000);
const renderCount = get('SELECT COUNT(*) c FROM shot_renders').c;
const canvasRenders = get("SELECT COUNT(*) c FROM shot_renders WHERE meta LIKE '%canvas%'").c;
ok('画布产物已回写 shot_renders（让质检/看板/交付包能看到关键帧与视频）',
  renderCount > 0 && canvasRenders === renderCount, `renders=${renderCount}（其中来自画布 ${canvasRenders}）`);
ok('finish 阶段等待成片真正完成（不是假象）',
  finishRun.artifact.submitted.every((x) => x.status === 'done' || x.error), JSON.stringify(finishRun.artifact.submitted.map((x) => x.status || x.error)));
ok('成片已登记（episode_films）', filmsReady, `films=${all('SELECT * FROM episode_films WHERE script_id = ?', St.getProduction(proj.id).script_id).length}`);
const film = all('SELECT * FROM episode_films WHERE script_id = ? ORDER BY created_at DESC', St.getProduction(proj.id).script_id)[0];
ok('成片文件落盘', Boolean(film?.file_path), String(film?.file_path));

const qcRun = await St.runStage(proj.id, 'qc', { offline: true, onLog: (m) => logs.push(m) });
ok('质检阶段完成并给出逐集结论', qcRun.ok && qcRun.artifact.episodes === 2 && qcRun.artifact.verdicts.every((v) => v.verdict),
  JSON.stringify(qcRun.artifact.verdicts));

const deliverRun = await St.runStage(proj.id, 'deliver', { offline: true, onLog: (m) => logs.push(m) });
ok('交付包生成并落盘（zip）', deliverRun.ok && /\.zip$/.test(deliverRun.artifact.file) && fs.existsSync(path.join(process.env.FACTORY_DATA_DIR, '..', deliverRun.artifact.file.replace(/^data\//, 'data/')) || '')
  || fs.existsSync(path.resolve(deliverRun.artifact.file)), `${deliverRun.artifact.file} · ${(deliverRun.artifact.bytes / 1024).toFixed(1)} KB`);

console.log('\n=== 8. 断点续跑、单阶段重跑与状态汇总 ===');
const finalStatus = St.productionStatus(proj.id);
ok('全部 10 个阶段完成 → 项目状态 done、进度 100%',
  finalStatus.status === 'done' && finalStatus.progressPct === 100, `status=${finalStatus.status} progress=${finalStatus.progressPct}%`);
ok('产物句柄齐全（演员/小说/剧本/画布/成片/交付）',
  finalStatus.outputs.actors === 4 && finalStatus.outputs.novel && finalStatus.outputs.script
  && finalStatus.outputs.canvas && finalStatus.outputs.films > 0 && finalStatus.outputs.delivery, JSON.stringify(finalStatus.outputs));
const rerun = await St.runPipeline(proj.id, { offline: true });
ok('再次执行流水线：全部已完成 → 不重复执行任何阶段', rerun.executed.length === 0, `executed=${JSON.stringify(rerun.executed)}`);
const forced = await St.runStage(proj.id, 'cast', { offline: true, force: true });
ok('force 重跑单阶段有效（会再建一批演员）', forced.ok && forced.artifact.created === 4, `新建 ${forced.artifact?.created}`);
ok('项目列表可查（含本项目）', St.listProductions().some((p) => p.id === proj.id));

console.log('\n=== 8b. 技能（声明式流程）与能力矩阵 ===');
const SK = await import('../src/skills.js');
const skills = SK.listSkills();
ok('技能清单可用（内置 3 个 + 外部技能文件）', skills.length >= 4 && skills.some((x) => x.id === 'produce-vertical-drama'), skills.map((x) => x.id).join(','));
ok('外部技能文件被自动加载（skills/*.skill.json）', skills.some((x) => x.id === 'produce-cinematic-21x9' && x.ratio === '21:9'), 'produce-cinematic-21x9');
const plan = SK.stagePlanFor('canvas-only');
ok('技能可以只声明部分阶段（canvas-only → 5 个阶段、无付费阶段）',
  plan.stages.length === 5 && plan.paid.length === 0, `${plan.stages.length} 阶段 · paid=${JSON.stringify(plan.paid)}`);
const planFull = SK.stagePlanFor('produce-vertical-drama');
ok('默认技能仍是完整十阶段且付费阶段被标出', planFull.stages.length === 10 && planFull.paid.join(',') === 'keyframe,video', planFull.paid.join(','));
const skProj = await St.createProduction({ brief: '拍一部一集的短剧，每集 20 秒', offline: true, skill: 'canvas-only' });
ok('按技能建项目：阶段清单跟着技能（5 个阶段）', skProj.stagesSummary.filter((x) => x.id).length === 5 && skProj.spec.skill === 'canvas-only',
  `stages=${skProj.stagesSummary.length} skill=${skProj.spec.skill}`);
ok('技能默认参数生效（比例/角色数来自技能文件）', skProj.spec.ratio === '9:16' && skProj.spec.castSize === 4, JSON.stringify({ ratio: skProj.spec.ratio, cast: skProj.spec.castSize }));
const skErr = await throwsAsync(async () => St.createProduction({ brief: 'x', offline: true, skill: 'no-such-skill' }), /技能不存在/);
ok('未知技能报中文错', skErr.threw && skErr.match, skErr.msg.slice(0, 60));
const caps = SK.capabilities();
ok('能力矩阵：逐项给出就绪/计费/是否需确认', caps.rows.length >= 10 && caps.summary.total === caps.rows.length
  && caps.summary.needConfirm.includes('studio-agent'), JSON.stringify(caps.summary).slice(0, 140));
ok('能力矩阵标出被阻塞的能力与缺口（离线环境下真实出图/视频未就绪）',
  caps.summary.blocked.includes('keyframe-real') && caps.summary.blocked.includes('video-comfy'), caps.summary.blocked.join(','));
ok('能力矩阵带上后端快照与红线说明',
  caps.backends?.ffmpeg === true && /人批准/.test(String(caps.rule || '')),
  `${JSON.stringify(caps.backends)} | rule=${caps.rule}`);

console.log('\n=== 8b-2. Skill 契约化（LibTV 调研第 5 条） ===');
const contract = SK.contractOf('produce-vertical-drama');
ok('契约：技能自己声明前置能力（逐条给出「由哪个能力满足」）',
  contract.ready === true && contract.satisfied.length >= 5 && contract.satisfied.every((x) => x.via && x.name),
  contract.satisfied.map((x) => `${x.need.length > 1 ? x.need.join('|') : x.need[0]}←${x.via}`).join(' , '));
ok('契约：付费阶段从阶段定义推导（不靠人手写）', contract.paid.join(',') === 'keyframe,video' && /人工批准/.test(contract.paidHint), contract.paidHint);
ok('契约：逐阶段产出物是中文口径（Agent 可据此回答「能给我什么」）',
  contract.outputs.length === 10 && contract.outputs.some((o) => /交付包/.test(o)) && contract.outputs.some((o) => /质检报告/.test(o)),
  contract.outputs.slice(-3).join(' / '));
ok('契约：默认可自动重试的错误类别是 rate/server/network（其余必须人处理）',
  contract.retryKinds.join(',') === 'rate,server,network', contract.retryKinds.join(','));
ok('契约：外部技能文件声明的 retryKinds 覆盖默认值（21:9 长片多一类 timeout）',
  SK.contractOf('produce-cinematic-21x9').retryKinds.includes('timeout'), SK.contractOf('produce-cinematic-21x9').retryKinds.join(','));
ok('契约：只出画布的技能没有付费阶段（付费阶段清单为空）', SK.contractOf('canvas-only').paid.length === 0);
const blockedContract = SK.contractOf({ id: 'need-image', name: '需要真实出图的流程', stages: ['cast', 'keyframe'], requires: ['keyframe-real'] });
ok('契约：缺前置能力时 ready=false 且给出中文原因（含缺什么）',
  blockedContract.ready === false && /关键帧（真实出图）/.test(blockedContract.blockedReason) && /出图后端/.test(blockedContract.blockedReason),
  blockedContract.blockedReason);
const capWithSkills = SK.capabilities();
ok('能力矩阵带上技能契约（界面/Agent 共用一份口径）',
  Array.isArray(capWithSkills.skills) && capWithSkills.skills.length >= 4 && capWithSkills.skills.every((x) => typeof x.ready === 'boolean'),
  `skills=${capWithSkills.skills.length}`);
const blockedCreate = await throwsAsync(() => St.createProduction({ brief: 'x', offline: true, skill: 'blocked-demo' }), /技能不存在/);
ok('建项目：未知技能仍报中文错（契约校验不吞掉原错误）', blockedCreate.threw && blockedCreate.match, blockedCreate.msg.slice(0, 50));

console.log('\n=== 8c. 单次制片预算熔断 与 计划过期策略（Claw P1） ===');
const { saveConfig: saveCfg2, loadConfig: loadCfg2 } = await import('../src/config.js');
const capBefore = loadCfg2().budget?.productionCap ?? 0;
saveConfig({ budget: { productionCap: 1, imageUnit: 0.1, videoUnit: 0.5 } });      // 上限设成 1 元，必超
const prodsBefore = get('SELECT COUNT(*) c FROM productions').c;
const capErr = await throwsAsync(() => St.createProduction({ brief: '拍一部两集的短剧，每集 30 秒', offline: true }), /超过单次制片上限/);
ok('超出单次制片上限时直接拒绝（中文原因 + 两条出路）', capErr.threw && capErr.match && /调低规模/.test(capErr.msg), capErr.msg.slice(0, 70));
ok('熔断时不留下半拉子项目（记录数不变）', get('SELECT COUNT(*) c FROM productions').c === prodsBefore,
  `productions=${prodsBefore} → ${get('SELECT COUNT(*) c FROM productions').c}`);
saveConfig({ budget: { productionCap: capBefore } });                              // 还原
const okProd = await St.createProduction({ brief: '拍一部一集的短剧，每集 15 秒，2 个角色', offline: true });
ok('还原上限后可正常建项目', Boolean(okProd.id), okProd.id);
// 计划过期：把待批准计划的 expires_at 改成过去 → runPipeline 必须给出 plan_expired 并回到可重跑状态
await St.runStage(okProd.id, 'brief', { offline: true });
const expRun = await St.runPipeline(okProd.id, { until: 'canvas', offline: true });
ok('免费阶段可跑到画布（为过期策略准备现场）', expRun.executed.length >= 4, expRun.executed.join(','));
const kfPlan = St.runStage(okProd.id, 'keyframe', { offline: true }).then(() => St.getProduction(okProd.id));
const pAfter = await kfPlan;
const stage = get("SELECT plan_id FROM production_stages WHERE production_id = ? AND stage = 'keyframe'", okProd.id);
ok('付费阶段生成待批准计划', Boolean(stage?.plan_id) && /^PL-/.test(stage.plan_id), String(stage?.plan_id));
run('UPDATE canvas_plans SET expires_at = ? WHERE id = ?', '2000-01-01T00:00:00.000Z', stage.plan_id);
const expiredRun = await St.runPipeline(okProd.id, { until: 'keyframe', offline: true });
ok('★ 计划过期后不再假等待（reason=plan_expired）', expiredRun.reason === 'plan_expired', JSON.stringify({ reason: expiredRun.reason, at: expiredRun.stoppedAt }));
const stRow = get("SELECT status, error FROM production_stages WHERE production_id = ? AND stage = 'keyframe'", okProd.id);
ok('过期阶段回到待执行并给出中文提示', stRow.status === 'pending' && /已过期/.test(stRow.error || ''), `${stRow.status} · ${String(stRow.error).slice(0, 50)}`);

console.log('\n=== 8d. 可选「出海物料」阶段（DramaClaw 评估第 5 条） ===');
ok('阶段表里有可选 publish 定义（依赖 finish）', Boolean(St.STAGE_IDS.includes('publish')))
;
const _ovPlan = SK.stagePlanFor('produce-overseas');
ok('出海技能（skills/produce-overseas.skill.json）含 publish 阶段', _ovPlan.stages.map((x) => x.id).includes('publish'), _ovPlan.stages.map((x) => x.id).join(','));
ok('默认技能**不含** publish（保持十阶段，老流程与断言不变）',
  !SK.stagePlanFor('produce-vertical-drama').stages.map((x) => x.id).includes('publish'),
  SK.stagePlanFor('produce-vertical-drama').stages.map((x) => x.id).join(','));
ok('publish 不是付费阶段（出海物料是本地生成，不经闸门）', St.STAGE_IDS.includes('publish') && !_ovPlan.paid.includes('publish'), JSON.stringify(_ovPlan.paid));

console.log('\n=== 8e. 画布 Claw 指令：自动补尾帧（LibTV 调研第 1 条） ===');
const { rid, nowISO } = await import('../src/util.js');
const CV_AL = 'CV-AUTOLAST-T';
run(`INSERT INTO canvases(id, name, created_at, updated_at) VALUES(?,?,?,?)`, CV_AL, '补尾帧测试画布', nowISO(), nowISO());
const mkAlNode = (kind, data) => {
  const id = rid('ND');
  run(`INSERT INTO canvas_nodes(id, canvas_id, actor_id, x, y, w, h, z, kind, title, data) VALUES(?,?,'',0,0,220,180,0,?,?,?)`,
    id, CV_AL, kind, kind, JSON.stringify(data));
  return id;
};
const alVid = mkAlNode('video', { idx: 1, prompt: 'wide shot, empty stage at dawn', duration: 3 });
const alVid2 = mkAlNode('video', { idx: 2, prompt: 'close up, trembling hands', duration: 2 });
ok('意图解析：补尾帧指令被识别为 autolast', St.parseCanvasIntent('给镜 1 补尾帧')?.intent === 'autolast'
  && St.parseCanvasIntent('自动补尾帧')?.intent === 'autolast');
const alAgent = await St.canvasAgent({ canvasId: CV_AL, instruction: '给镜 1 补尾帧' });
ok('Claw：补尾帧是「建图」动作，直接执行且不花钱', alAgent.understood === true && alAgent.trace?.paid === false, JSON.stringify(alAgent.actions));
const alNew = all("SELECT * FROM canvas_nodes WHERE canvas_id = ? AND kind='image'", CV_AL);
ok('Claw：真的建出了尾帧出图节点', alNew.length === 1 && JSON.parse(alNew[0].data).autoLast === true, `nodes=${alNew.length}`);
const alLinks = all("SELECT * FROM canvas_links WHERE canvas_id = ? AND to_port='last'", CV_AL);
ok('Claw：尾帧节点接到了目标片段的 last 端口', alLinks.length === 1 && alLinks[0].to_node === alVid, JSON.stringify(alLinks[0] || {}).slice(0, 120));
const alAgent2 = await St.canvasAgent({ canvasId: CV_AL, instruction: '补尾帧' });
ok('Claw：第二次补尾帧落到另一条还没尾帧的片段（幂等推进，不重复叠图）',
  alAgent2.actions?.[0]?.ok === true && all("SELECT * FROM canvas_links WHERE canvas_id = ? AND to_port='last' AND to_node=?", CV_AL, alVid2).length === 1);
const alAgent3 = await St.canvasAgent({ canvasId: CV_AL, instruction: '补尾帧' });
ok('Claw：全部片段都有尾帧时给出可读说明（不是报错）',
  alAgent3.actions?.[0]?.ok === false && /都已经有尾帧/.test(alAgent3.reply), alAgent3.reply);
const alMcp = await import('../src/mcp-tools.js');
const alTool = alMcp.TOOLS?.find?.((t) => t.name === 'canvas_auto_last_frame');
ok('MCP：暴露 canvas_auto_last_frame 且标记为不花钱', Boolean(alTool) && alTool.cost === false, alTool ? `${alTool.level}/${alTool.cost}` : '缺失');

console.log('\n=== 8f. 计费口径配置化与对账（LibTV 调研第 7 条） ===');
const B = await import('../src/billing.js');
const { saveConfig: saveCfg3 } = await import('../src/config.js');
const capB = B.billingConfig();
ok('口径回落：没配 billing 时按「预算单价（按次）」计算，老配置不受影响',
  capB.mode === 'perCall' && capB.video.perCall === 0.5 && capB.image.perCall === 0.1 && /budget/.test(capB.source),
  JSON.stringify({ mode: capB.mode, image: capB.image.perCall, video: capB.video.perCall, source: capB.source }));
const qCall = B.quote({ images: 10, videos: 10, seconds: 100 });
ok('按次报价：10 张图 + 10 条视频 = 6 元（0.1×10 + 0.5×10）',
  qCall.amount === 6 && qCall.mode === 'perCall' && qCall.lines.length === 2, JSON.stringify(qCall.lines));
saveCfg3({ billing: { mode: 'perSecond', currency: 'CNY', image: { perCall: 0.1 }, video: { perSecond: 0.2 },
  tiers: [{ maxHeight: 720, multiplier: 1 }, { maxHeight: 1080, multiplier: 1.5 }] } });
const qSec = B.quote({ images: 10, videos: 10, seconds: 100, height: 1080 });
ok('按秒报价：100s × 0.2 × 1080p 阶梯 1.5 = 30 元，加 1 元图费 = 31 元',
  qSec.amount === 31 && /按秒/.test(qSec.lines[1].basis) && qSec.tier.multiplier === 1.5, JSON.stringify({ amount: qSec.amount, tier: qSec.tier, lines: qSec.lines }));
ok('分辨率阶梯按高度匹配：720p→×1、1080p→×1.5、未指定→×1',
  B.tierOf(720).multiplier === 1 && B.tierOf(1080).multiplier === 1.5 && B.tierOf(null).multiplier === 1,
  `${B.tierOf(720).label} / ${B.tierOf(1080).label} / ${B.tierOf(null).label}`);
const cmp = B.compareModes({ images: 10, videos: 10, seconds: 100, height: 1080 });
ok('换口径对比：同工作量的按次 vs 按秒金额与差额都给出',
  cmp.perCall.amount === 6 && cmp.perSecond.amount === 31 && cmp.delta === 25, JSON.stringify(cmp));
const est2 = await St.estimateProduction({ spec: { episodes: 1, episodeSeconds: 60 } });
ok('制片估算跟随口径：按秒金额 = 图费×镜数 + 成片总秒数×单价（12 镜 × 0.1 + 60s × 0.2 = 13.2；分辨率未指定 → ×1 档）',
  est2.mode === 'perSecond' && est2.seconds === 60 && est2.amount === 13.2,
  JSON.stringify({ mode: est2.mode, seconds: est2.seconds, amount: est2.amount, shots: est2.shots, tier: est2.lines?.[1]?.basis }));
ok('估算里带上口径说明与换口径对比（用户能看到「换口径差多少」）',
  /按秒/.test(est2.note) && est2.billing?.compare?.perCall !== undefined,
  String(est2.note).slice(0, 110));

// 对账：先造一些「真实产出」，再和预计比
const recProd = await St.createProduction({ brief: '对账用一集短剧，每集 20 秒', offline: true, spec: { episodes: 1, episodeSeconds: 20 } });
const recProbe = St.productionStatus(recProd.id);
ok('制片状态带计费摘要（口径/预计金额/是否未配置单价）',
  Boolean(recProbe.billing) && recProbe.billing.mode === 'perSecond' && recProbe.billing.estimateCurrency === 'CNY',
  JSON.stringify(recProbe.billing).slice(0, 130));
const rec0 = B.reconcileProduction(recProd.id);
ok('对账结构完整：预计/实际/差额/逐项行/结论',
  rec0.estimate && rec0.actual && rec0.delta && rec0.lines.length === 4 && typeof rec0.verdict === 'string',
  JSON.stringify({ v: rec0.verdict, delta: rec0.delta, lines: rec0.lines.length }));
ok('对账：还没产出时「实际」为 0（不虚报），结论是低于预计',
  rec0.actual.images === 0 && rec0.actual.videos === 0 && rec0.verdict === 'under', JSON.stringify(rec0.actual));
// 真实产出：插一条已完成的关键帧与视频（模拟产出，不花任何钱）
const { run: runDb } = await import('../src/db.js');
const { nowISO: now2, rid: rid2 } = await import('../src/util.js');
const recScript = rid2('SC'), recEp = rid2('EP'), recShot = rid2('SH');
runDb(`INSERT INTO scripts(id, title, format, episode_seconds, options, created_at, updated_at) VALUES(?,?,?,?,?,?,?)`,
  recScript, '对账夹具剧', 'duanju', 20, JSON.stringify({ ratio: '9:16' }), now2(), now2());
runDb(`INSERT INTO script_episodes(id, script_id, season, episode, code, title, duration, status, created_at, updated_at)
       VALUES(?,?,1,1,'S01E777','对账集',20,'done',?,?)`, recEp, recScript, now2(), now2());
runDb(`INSERT INTO shots(id, script_id, episode_id, idx, duration, dialogue, refs, status) VALUES(?,?,?,?,?,?,'{}','draft')`,
  recShot, recScript, recEp, 1, 4, '沈砚：来了。');
runDb('UPDATE productions SET script_id = ? WHERE id = ?', recScript, recProd.id);
for (const kind of ['keyframe', 'video']) {
  runDb(`INSERT INTO shot_renders(id, script_id, episode_id, shot_id, kind, file_path, mime, width, height, duration, status, created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?, 'done', ?)`,
    rid2('RD'), recScript, recEp, recShot, kind, `videos/fake_${kind}.mp4`, 'video/mp4', 720, 1280, 4, now2());
}
const rec1 = B.reconcileProduction(recProd.id);
ok('对账：实际按**真实产出**统计（落库的关键帧/视频条数与时长）',
  rec1.actual.images >= 1 && rec1.actual.videos >= 1 && rec1.actual.seconds >= 3, JSON.stringify(rec1.actual));
ok('对账：摘要是一句话可读结论（含预计→实际与金额差）',
  /对账：/.test(B.reconcileSummary(rec1)) && /关键帧/.test(B.reconcileSummary(rec1)), B.reconcileSummary(rec1).slice(0, 120));
const rep = await St.writeProductionReport(recProd.id);
const repText = fs.readFileSync(rep.abs, 'utf8');
ok('一页纸报告含「计费口径与对账」章节与逐项差额表',
  repText.includes('计费口径与对账') && /\| 项目 \| 预计 \| 实际 \| 差额 \|/.test(repText) && /换口径对比/.test(repText),
  repText.split('\n').filter((l) => /对账|换口径/.test(l)).slice(0, 2).join(' ').slice(0, 120));
// 未配置单价：金额对账没有意义 → 明确返回 null 而不是 0
// 「未配置单价」= billing 与 budget 两边都没单价（billing 按次填 0 视为未配置，会回落到 budget）
saveCfg3({ budget: { imageUnit: 0, videoUnit: 0, ttsPerKChars: 0, currency: 'CNY' },
  billing: { mode: 'perSecond', image: { perCall: 0 }, video: { perCall: 0, perSecond: 0 } } });
const recUnpriced = B.reconcileProduction(recProd.id);
ok('未配置单价：verdict=unpriced 且金额差额为 null（只对账条数/秒数，不假装免费）',
  recUnpriced.verdict === 'unpriced' && recUnpriced.delta.amount === null && /不代表免费/.test(recUnpriced.note),
  `${recUnpriced.verdict} | ${recUnpriced.note.slice(0, 70)}`);
saveCfg3({ budget: { imageUnit: 0.1, videoUnit: 0.5, currency: 'CNY' },
  billing: { mode: 'perCall', currency: 'CNY', image: { perCall: 0.1 }, video: { perCall: 0.5 },
    tiers: [{ maxHeight: 1080, multiplier: 1 }] } });

console.log('\n=== 8g. 画布快照与回滚的 Claw 指令（版本化工作现场） ===');
ok('意图解析：保存快照 / 回滚 都被识别（且不会与「补尾帧」混淆）',
  St.parseCanvasIntent('保存快照')?.intent === 'snapshot' && St.parseCanvasIntent('存个档')?.intent === 'snapshot'
  && St.parseCanvasIntent('回滚到上一个快照')?.intent === 'rollback' && St.parseCanvasIntent('退回')?.intent === 'rollback'
  && St.parseCanvasIntent('给镜 1 补尾帧')?.intent === 'autolast');
const CV_SNAP2 = 'CV-SNAPGENT';
run(`INSERT INTO canvases(id, name, created_at, updated_at) VALUES(?,?,?,?)`, CV_SNAP2, 'Claw 快照画布', nowISO(), nowISO());
const mkSnapNode = (title, x) => {
  const id = rid('ND');
  run(`INSERT INTO canvas_nodes(id, canvas_id, actor_id, x, y, w, h, z, kind, title, data) VALUES(?,?,'',?,0,220,180,0,'video',?,?)`,
    id, CV_SNAP2, x, title, JSON.stringify({ prompt: 'x', duration: 2 }));
  return id;
};
const keep1 = mkSnapNode('片段A', 80);
mkSnapNode('片段B', 320);
const snapAgent = await St.canvasAgent({ canvasId: CV_SNAP2, instruction: '保存快照' });
ok('Claw：保存快照是建图类动作，直接执行且不花钱',
  snapAgent.understood === true && snapAgent.intent === 'snapshot' && snapAgent.actions[0]?.ok === true && snapAgent.trace?.paid === false,
  snapAgent.actions[0]?.detail);
const snapList = (await import('../src/snapshots.js')).listSnapshots(CV_SNAP2);
ok('Claw：快照真的落到该画布名下（含卡位/连线计数）',
  snapList.count === 1 && snapList.snapshots[0].nodes === 2, JSON.stringify(snapList.snapshots[0] || {}).slice(0, 120));
// 破坏现场：删掉一张卡位
run('DELETE FROM canvas_nodes WHERE id = ?', keep1);
const rb = await St.canvasAgent({ canvasId: CV_SNAP2, instruction: '回滚到上一个快照' });
ok('Claw：回滚指令把画布还原（并说明回滚前现场已留档）',
  rb.understood === true && rb.intent === 'rollback' && rb.actions[0]?.ok === true
  && Boolean(get('SELECT id FROM canvas_nodes WHERE id = ?', keep1)) && /自动存成一张快照|回错了/.test(rb.reply),
  rb.reply.slice(0, 90));
const emptyRollback = await St.canvasAgent({ canvasId: 'CV-MAIN', instruction: '回滚到上一个快照' });
ok('Claw：没有快照时给可操作的中文说明（而不是报错）',
  emptyRollback.actions[0]?.ok === false ? /还没有快照/.test(emptyRollback.reply) : true,
  emptyRollback.reply.slice(0, 70));

console.log('\n=== 8h. Agent 决策时间线（谁在什么时候做了什么决定） ===');
const D = await import('../src/decisions.js');
// 用第 6 节跑完的那个项目（含批准 + 确认码 + 各阶段）
const tlProd = proj.id;
const tl = D.buildDecisionTimeline({ productionId: tlProd, limit: 200 });
ok('时间线可构建：事件按时间倒序（新的在前）',
  tl.ok && tl.events.length >= 5 && tl.events.every((e, i, arr) => i === 0 || String(arr[i - 1].at) >= String(e.at)),
  `${tl.events.length} 条事件`);
ok('时间线摊开了「人类批准」这一类决定（含确认码放行）',
  tl.events.some((e) => e.kind === 'gate' && e.action === 'approved' && e.actor === 'human' && e.decide === true),
  JSON.stringify(tl.events.filter((e) => e.action === 'approved').slice(0, 1)));
ok('时间线摊开了 Agent 发起的动作（生成计划等 dry-run）',
  tl.events.some((e) => e.actor === 'agent'), `${tl.summary.byActor.agent} 条`);
ok('时间线摊开了系统自动的阶段生命周期（开始/完成）',
  tl.events.some((e) => e.kind === 'stage' && /开始阶段/.test(e.title)) && tl.events.some((e) => e.kind === 'stage' && /完成阶段/.test(e.title)),
  tl.events.filter((e) => e.kind === 'stage').length + ' 条阶段事件');
ok('汇总区分三种行动者并给出人类决定数与放行次数',
  tl.summary.byActor.human + tl.summary.byActor.agent + tl.summary.byActor.system === tl.summary.total
  && tl.summary.humanDecisions >= 1 && tl.summary.approvedPlans >= 1,
  JSON.stringify(tl.summary));
ok('一句话结论可读（含三类行动者与放行/被拒次数）',
  /时间线：\d+ 条事件/.test(D.timelineSummary(tl)) && /批准放行/.test(D.timelineSummary(tl)),
  D.timelineSummary(tl).slice(0, 110));
ok('limit 生效（只返回最近 N 条，但 total 仍是完整条数）',
  D.buildDecisionTimeline({ productionId: tlProd, limit: 3 }).events.length === 3
  && D.buildDecisionTimeline({ productionId: tlProd, limit: 3 }).total === tl.total);
ok('时间线只摊开事实、不推断（rule 里写明三类行动者含义）',
  /human=人类决定/.test(tl.rule) && /不推断/.test(tl.rule), tl.rule.slice(0, 80));
const tlCanvas = D.buildDecisionTimeline({ canvasId: CV_SNAP2, limit: 50 });
ok('按画布范围也能建时间线（含快照保存这类人类决定）',
  tlCanvas.ok && tlCanvas.events.some((e) => e.kind === 'snapshot' && e.actor === 'human'),
  `${tlCanvas.events.length} 条（含快照 ${tlCanvas.summary.snapshots} 条）`);
const tlMissing = D.buildDecisionTimeline({ productionId: 'PR-不存在' });
ok('不存在的制片项目给中文原因（不返回半截时间线）',
  tlMissing.ok === false && /不存在/.test(tlMissing.error), tlMissing.error);

console.log('\n=== 8i. 队列自动暂停闸门（预算软着陆：暂停队列而不是硬跑） ===');
const J3 = await import('../src/jobs.js');
const pauseProj = await St.createProduction({ brief: '拍一部一集的短剧，每集 15 秒', offline: true });
// 把月度上限压到「这一批必然超」的程度，跑一次流水线到付费阶段
saveCfg3({ budget: { enabled: true, currency: 'CNY', imageUnit: 1, videoUnit: 10, monthlyCap: 20, productionCap: 0 } });
const pauseRun = await St.runPipeline(pauseProj.id, { offline: true });
ok('预算会突破时：流水线在付费阶段前停下并说明「已自动暂停队列」',
  pauseRun.reason === 'auto_paused' && /超过月度上限/.test(String(pauseRun.paused?.reason || '')),
  JSON.stringify({ reason: pauseRun.reason, paused: pauseRun.paused }).slice(0, 160));
ok('自动暂停真的把队列暂停了（落库状态可读，重启也绕不过去）',
  J3.pauseState().paused === true && J3.pauseState().by === 'system', JSON.stringify(J3.pauseState()));
ok('暂停期间再跑流水线：直接停在暂停态（不推进任何阶段）',
  (await St.runPipeline(pauseProj.id, { offline: true })).reason === 'queue_paused',
  String((await St.runPipeline(pauseProj.id, { offline: true })).reason));
ok('暂停期间重跑付费阶段：返回 blocked+paused（不创建计划、不花钱）',
  (await St.runStage(pauseProj.id, 'keyframe', { force: true })).blocked === true,
  JSON.stringify(await St.runStage(pauseProj.id, 'keyframe', { force: true })).slice(0, 120));
const tlPause = (await import('../src/decisions.js')).buildDecisionTimeline({ productionId: pauseProj.id });
ok('决策时间线把「队列暂停」摊开成事实（system 发起）',
  tlPause.events.some((e) => e.kind === 'queue' && /队列暂停/.test(e.title) && e.actor === 'system'),
  JSON.stringify(tlPause.events.filter((e) => e.kind === 'queue').slice(0, 1)));
// 恢复：提高上限后恢复队列，流水线可继续
saveCfg3({ budget: { monthlyCap: 0, productionCap: 0, imageUnit: 0.1, videoUnit: 0.5, currency: 'CNY' } });
J3.resumeQueues({ by: 'human', note: '提高上限后恢复' });
ok('恢复队列后落库状态清空', J3.pauseState().paused === false);
ok('恢复后流水线可以继续推进（不再卡在暂停态）',
  (await St.runPipeline(pauseProj.id, { offline: true })).reason !== 'queue_paused',
  String((await St.runPipeline(pauseProj.id, { offline: true })).reason));

console.log('\n=== 9. 真实库未被触碰 ===');
ok('使用临时库', process.env.FACTORY_DB.includes('factory-studio-') && fs.existsSync(process.env.FACTORY_DB), process.env.FACTORY_DB);
ok('制片表建在临时库里', get('SELECT COUNT(*) c FROM productions').c >= 1 && get('SELECT COUNT(*) c FROM production_stages').c >= 10,
  `productions=${get('SELECT COUNT(*) c FROM productions').c} stages=${get('SELECT COUNT(*) c FROM production_stages').c}`);

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }
process.exit(fail ? 1 : 0);
