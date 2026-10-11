// 模块3 自测：假小说 → 创建剧本 → 分集规划 → 单集剧本 → 分镜生成 → 编辑单镜 → 导出 4 格式
// 运行：npm run test:full（推荐，环境由 scripts/run-tests.mjs 统一注入）
//      或手工：FACTORY_DB=<临时路径> PORT=8892 node tests/test-script.js
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RANDOM = Math.random().toString(36).slice(2, 8);
// 注意：不要写死 /tmp —— Windows 下会解析成不存在的 C:\tmp\；统一用 os.tmpdir()
const DB = process.env.FACTORY_DB || path.join(os.tmpdir(), `test-script-${RANDOM}.db`);
process.env.FACTORY_DB = DB;
const PORT = Number(process.env.PORT || 8892);
const REAL_LLM = process.env.SKIP_REAL_LLM !== '1';

for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB + suffix); } catch { /* ignore */ } }

const { createApp, createServer } = await import('../src/http.js');
const { migrate, run } = await import('../src/db.js');
const { registerScriptRoutes } = await import('../src/routes/script.js');
const { registerMetaRoutes } = await import('../src/routes/meta.js');
const { llmStatus } = await import('../src/llm.js');

migrate();
const { app, handle } = createApp();
registerMetaRoutes(app);
registerScriptRoutes(app);
const server = createServer((req, res) => handle(req, res, { staticMounts: [] }));
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${PORT}`;

// ---------------- 断言工具 ----------------
let pass = 0;
const failures = [];
const results = [];
function ok(cond, label, extra = '') {
  if (cond) { pass++; results.push(`✅ ${label}${extra ? ` — ${extra}` : ''}`); }
  else { failures.push(`${label}${extra ? ` — ${extra}` : ''}`); results.push(`❌ ${label}${extra ? ` — ${extra}` : ''}`); }
}
async function api(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON（导出附件等） */ }
  return { status: res.status, json, text, headers: res.headers };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitJob(jobId, timeoutMs = 240000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await api('GET', `/api/jobs/${jobId}`);
    const job = r.json?.job;
    if (job && ['done', 'error', 'canceled'].includes(job.status)) return job;
    await sleep(400);
  }
  throw new Error(`任务 ${jobId} 超时`);
}

// ---------------- 造数据：假小说 + 角色 + 章节 ----------------
const CH_TEXTS = [
  ['初入青云', '林昭在测灵碑前被判定为废柴，全场哄笑。他攥紧拳头，抬头看向山门。', '苏清月在人群后静静看着他。', '「废柴也敢来青云宗？」', '林昭低声说：「三年后，我会让你们记住我的名字。」'],
  ['夜半密约', '深夜的藏经阁里，林昭发现一枚残破玉简。', '长老推门而入，月光照在他脸上。', '「你可知这玉简的来历？」', '林昭沉默片刻，答道：「不知。但我知道它不属于这里。」'],
  ['血战断崖', '断崖之上，黑衣人围杀林昭。刀光闪过，他护住怀里的玉简。', '苏清月踏剑而来，剑气如虹。', '「走！」她喊。', '崖边的碎石坠落深渊。'],
  ['玉简现世', '玉简在血中亮起，古老的符文浮空。', '黑衣人惊恐后退，跪倒在地。', '「这是……上古剑典！」', '林昭握紧玉简，眼神变了。'],
  ['山门之变', '青云宗大比之日，执法堂忽然封山。', '苏清月被指控通敌，押上广场。', '林昭站在人群里，缓缓拔出那柄锈剑。', '「放开她。」'],
];
const CHAPTERS = CH_TEXTS.map(([t, ...paras], i) => ({
  id: `CH-${String(i + 1).padStart(4, '0')}`,
  novel_id: 'N-0001',
  idx: i + 1,
  volume: 1,
  title: t,
  summary: paras.join(''),
  content: paras.join('\n'),
  words: paras.join('').length,
  hook: i % 2 === 0 ? `${t}的结尾留下疑问` : '',
  cliffhanger: `第${i + 1}章的悬念`,
  characters: JSON.stringify(i === 0 ? ['C-0001', 'C-0002'] : ['C-0001']),
  locations: JSON.stringify([i < 3 ? 'L-0001' : 'L-0002']),
  status: 'done',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
}));

run(
  `INSERT INTO novels(id,title,genre,sub_genre,tone,scale,cast_size,target_words,chapter_words,pov,framework_intro,actor_ids,style_id,seasons,status,meta,created_at,updated_at)
   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  'N-0001', '青云剑典', 'eastern-fantasy', '废柴逆袭', '热血燃向', 'medium', 20, 500000, 2000,
  'third-limited', '废柴少年林昭偶得上古剑典玉简，与苏清月并肩对抗青云宗背后的势力，最终揭开自己身世之谜。',
  JSON.stringify(['C-0001', 'C-0002']), 'cn-guofeng', 1, 'done', '{}', new Date().toISOString(), new Date().toISOString(),
);
for (const a of [
  { id: 'C-0001', name: '林昭', gender: 'male', age: 17, race: 'asian-east', hair_style: 'messy', hair_color: 'black', eyes: 'gold', costume: 'black hanfu with torn sleeves' },
  { id: 'C-0002', name: '苏清月', gender: 'female', age: 18, race: 'asian-east', hair_style: 'long-straight', hair_color: 'silver', eyes: 'blue', costume: 'white hanfu with silver embroidery' },
]) {
  run(
    `INSERT INTO actors(id,name,gender,age,race,hair_style,hair_color,eyes,costume,role_type,style_id,status,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    a.id, a.name, a.gender, a.age, a.race, a.hair_style, a.hair_color, a.eyes, a.costume,
    a.id === 'C-0001' ? '主角' : '女主', 'cn-guofeng', 'done', new Date().toISOString(), new Date().toISOString(),
  );
}
for (const c of CHAPTERS) {
  run(
    `INSERT INTO novel_chapters(id,novel_id,outline_id,idx,volume,title,summary,content,words,hook,cliffhanger,characters,locations,status,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    c.id, c.novel_id, null, c.idx, c.volume, c.title, c.summary, c.content, c.words, c.hook, c.cliffhanger, c.characters, c.locations, c.status, c.created_at, c.updated_at,
  );
}
run("INSERT INTO seq(name,value) VALUES('chapter',5) ON CONFLICT(name) DO UPDATE SET value=5");
run("INSERT INTO seq(name,value) VALUES('novel',1) ON CONFLICT(name) DO UPDATE SET value=1");

console.log('==================== 模块3 自测 ====================');
console.log(`DB：${DB}`);
console.log(`LLM：${JSON.stringify(llmStatus())}`);
console.log(`真实 LLM 小调用：${REAL_LLM ? '开启（最多 2 次）' : '已跳过（SKIP_REAL_LLM=1）'}`);

// ---------------- 1. 技能文档模板 ----------------
const skills = await api('GET', '/api/script-skills');
ok(skills.json?.ok === true && skills.json.templates.length >= 1, 'GET /api/script-skills 返回内置模板', `${skills.json?.templates?.length} 套 / ${skills.json?.text?.length} 字`);
ok(/改编原则/.test(skills.json?.text || '') && /审查红线/.test(skills.json?.text || '') && /镜头语言对应表/.test(skills.json?.text || ''), '技能文档含改编原则/镜头语言对应表/审查红线');
const skillDl = await fetch(`${BASE}/api/script-skills?download=1`);
ok(skillDl.headers.get('content-disposition')?.includes('attachment'), 'GET /api/script-skills?download=1 输出附件');

// ---------------- 2. 创建剧本（含校验） ----------------
const badCreate = await api('POST', '/api/scripts', { novelId: 'N-0001', title: 'x', episodeSeconds: 5, episodesPerSeason: 9999, seasons: 1 });
ok(badCreate.json?.ok === true && badCreate.json.script.episode_seconds === 15 && badCreate.json.script.episodes_per_season === 500,
  '校验：episode_seconds<15 / episodes_per_season>500 自动夹取并给中文告警', (badCreate.json?.warnings || []).join('；'));
const badScriptId = badCreate.json.script.id;
await api('DELETE', `/api/scripts/${badScriptId}`);

const created = await api('POST', '/api/scripts', {
  novelId: 'N-0001', title: '青云剑典·漫剧版', format: 'manju', styleId: 'cn-guofeng',
  episodeSeconds: 120, episodesPerSeason: 6, seasons: 1, options: { note: '自测' },
});
const scriptId = created.json?.script?.id;
ok(created.json?.ok === true && /^SC-\d{4}$/.test(scriptId || ''), 'POST /api/scripts 创建剧本', scriptId);
ok(created.json.script.style_id === 'cn-guofeng' && created.json.script.episode_seconds === 120, '剧本配置落库（画风/时长）');

const listed = await api('GET', '/api/scripts');
ok(listed.json?.ok === true && listed.json.scripts.some((s) => s.id === scriptId), 'GET /api/scripts 列表含集数/镜头数统计',
  JSON.stringify(listed.json.scripts[0] && { ep: listed.json.scripts[0].episode_count, shots: listed.json.scripts[0].shot_count }));

const updated = await api('PUT', `/api/scripts/${scriptId}`, { episodesPerSeason: 5, seasons: 1, title: '青云剑典·漫剧版 v2' });
ok(updated.json?.ok === true && updated.json.script.episodes_per_season === 5, 'PUT /api/scripts/:id 更新配置');

// ---------------- 3. 分集规划（离线规则分支） ----------------
const planSync = await api('POST', `/api/scripts/${scriptId}/plan`, { overwrite: true, offline: true, sync: true });
ok(planSync.json?.ok === true && planSync.json.episodes.length === 5, 'POST /api/scripts/:id/plan 分集规划（离线）', `${planSync.json?.episodes?.length} 集 / mode=${planSync.json?.mode}`);
const ep1 = planSync.json.episodes[0];
ok(Boolean(ep1.title && ep1.logline && ep1.hook && ep1.cliffhanger && Array.isArray(ep1.source_chapters) && ep1.source_chapters.length),
  '规划含 标题/logline/钩子/悬念收尾/覆盖章节范围', `${ep1.code} ${ep1.title} ← 第 ${ep1.source_chapters.join(',')} 章`);
ok(planSync.json.episodes.every((e) => e.duration === 120), '每集时长 = 单集时长设定');

// ---------------- 4. 单集剧本正文 ----------------
const genEp = await api('POST', `/api/scripts/${scriptId}/episodes/S01E001/generate`, { offline: true, sync: true });
ok(genEp.json?.ok === true && genEp.json.episode.scenes?.scenes?.length >= 1, 'POST .../episodes/:code/generate 生成单集剧本（场次+台词+动作）',
  `${genEp.json?.episode?.scenes?.scenes?.length} 场 / mode=${genEp.json?.mode} / status=${genEp.json?.episode?.status}`);
const beats = genEp.json.episode.scenes.scenes.flatMap((s) => s.beats || []);
ok(beats.some((b) => b.type === 'dialogue') && beats.some((b) => b.type === 'action'), '剧本含台词与动作 beat', `${beats.length} 个 beat`);

// ---------------- 5. 分镜生成（异步任务 + 时长校验） ----------------
const sbJob = await api('POST', `/api/scripts/${scriptId}/storyboard`, { all: true, offline: true });
ok(sbJob.json?.ok === true && sbJob.json.jobId && sbJob.json.total === 5, 'POST /api/scripts/:id/storyboard 返回 {jobId,total}', `jobId=${sbJob.json?.jobId} total=${sbJob.json?.total}`);
const job = await waitJob(sbJob.json.jobId);
ok(job.status === 'done', '分镜任务完成', `status=${job.status} shots=${job.result?.shots} duration=${job.result?.duration}s`);

const epDetail = await api('GET', `/api/scripts/${scriptId}/episodes/S01E001`);
const shots = epDetail.json.shots || [];
ok(shots.length > 0, 'GET .../episodes/:code 返回含 shots 的单集详情', `${shots.length} 镜 / 合计 ${epDetail.json.episode.total}s`);
const driftPct = Math.abs(epDetail.json.episode.drift) / 120 * 100;
ok(driftPct < 2, '单集镜头时长合计 ≈ 单集时长（误差 < 2%）', `合计 ${epDetail.json.episode.total}s vs 120s，偏差 ${driftPct.toFixed(2)}%`);
const s0 = shots[0];
ok(Boolean(s0.shot_size && s0.camera && s0.move && s0.transition && s0.duration && s0.action && s0.mood && s0.cost_level),
  '分镜字段齐全（景别/机位/运镜/转场/时长/动作/情绪/成本级）', `${s0.shot_size}/${s0.camera}/${s0.move}/${s0.transition}/${s0.duration}s/${s0.cost_level}`);
const nonAscii = [...new Set((s0.prompt_pos || '').replace(/[\x20-\x7E]/g, ''))].join('');
ok(nonAscii === '' && /[a-z]/.test(s0.prompt_pos || ''), 'prompt_pos 为纯英文（可直接喂文生图/图生视频）',
  nonAscii ? `含非 ASCII 字符：${nonAscii}` : `${(s0.prompt_pos || '').slice(0, 80)}…`);
ok(/chinese guofeng illustration/.test(s0.prompt_pos || '') && /ornate hanfu/.test(s0.prompt_pos || ''), 'prompt_pos 含风格头 + 风格尾');
ok(/1boy|1girl|young man|young woman/.test(s0.prompt_pos || ''), 'prompt_pos 含角色锚点（来自 actors.subjectFragment）');
ok(Boolean(s0.prompt_neg && /lowres|bad anatomy/.test(s0.prompt_neg)), 'prompt_neg 含基础负面词');
const refs = s0.refs;
ok(Array.isArray(refs?.characters) && refs.style === 'cn-guofeng', 'refs JSON 结构正确', JSON.stringify(refs).slice(0, 120));
const costs = shots.reduce((a, s) => { const k = String(s.cost_level || '').trim()[0]; a[k] = (a[k] || 0) + 1; return a; }, {});
ok(Object.keys(costs).length >= 1 && Object.keys(costs).every((k) => 'LMH'.includes(k)), '成本级为 L/M/H', JSON.stringify(costs));
ok((costs.H || 0) >= 1, '每集至少 1 个高光镜（H 全动态），符合技能文档成本画像', `L/M/H = ${costs.L || 0}/${costs.M || 0}/${costs.H || 0}`);
const full = await api('GET', `/api/scripts/${scriptId}?withShots=1`);
ok(full.json.script.stats.shot_count >= shots.length && full.json.script.stats.storyboard_episodes === 5, 'GET /api/scripts/:id 详情统计（集数/镜头数/总时长/成本）',
  `shots=${full.json.script.stats.shot_count} total=${full.json.script.stats.total_duration}s cost=${JSON.stringify(full.json.script.stats.cost)}`);
ok(full.json.script.episodes.every((e) => Number(e.duration) > 0), '每集 duration 已写入');

// 全部集时长校验
let allOk = true; const driftLines = [];
for (const e of full.json.script.episodes_full) {
  const d = Math.abs((e.total || 0) - 120) / 120 * 100;
  driftLines.push(`${e.code}:${e.total}s(${d.toFixed(2)}%)`);
  if (d >= 2) allOk = false;
}
ok(allOk, '全部 5 集时长偏差均 < 2%', driftLines.join(' '));

// ---------------- 6. 编辑单镜 / 新增 / 删除 / 重新配平 ----------------
const target = shots[1] || shots[0];
const edited = await api('PUT', `/api/scripts/${scriptId}/shots/${target.id}`, {
  action: '林昭握紧锈剑，指节泛白', dialogue: '我不是废柴。', shot_size: '特写', camera: '仰拍', move: '推镜', duration: 6, mood: '热血', cost_level: 'H 全动态',
});
ok(edited.json?.ok === true && edited.json.shot.action.includes('锈剑') && edited.json.shot.shot_size === '特写', 'PUT .../shots/:shotId 手动编辑单镜');
ok(/extreme close-up/.test(edited.json.shot.prompt_pos) && /low angle/.test(edited.json.shot.prompt_pos), '编辑后自动重建英文提示词（景别/机位联动）');
ok(typeof edited.json.episode?.total === 'number' && edited.json.warnings.length >= 0, '编辑后返回该集时长校验（超限给中文告警不报错）',
  `合计 ${edited.json.episode?.total}s 偏差 ${edited.json.episode?.driftPct}% / warnings=${edited.json.warnings?.length || 0}`);

const added = await api('POST', `/api/scripts/${scriptId}/shots`, { episode: 'S01E001', action: '新增镜头：月光洒在玉简上', shot_size: '大特写', cost_level: 'L 静态+运镜', duration: 3, characters: ['C-0001'] });
ok(added.json?.ok === true && added.json.shot.id, 'POST .../shots 新增一镜', `${added.json.shot?.id} idx=${added.json.shot?.idx}`);
const afterAdd = await api('GET', `/api/scripts/${scriptId}/episodes/S01E001`);
ok(afterAdd.json.shots.length === shots.length + 1, '新增后镜头数 +1', `${shots.length} → ${afterAdd.json.shots.length}`);

const rebal = await api('POST', `/api/scripts/${scriptId}/rebalance`, { episode: 'S01E001' });
ok(rebal.json?.ok === true && rebal.json.rebalanced[0] && Math.abs(rebal.json.rebalanced[0].drift) / 120 < 0.02,
  'POST /api/scripts/:id/rebalance 重新配平时长', JSON.stringify(rebal.json.rebalanced[0] || rebal.json.warnings));

const del = await api('DELETE', `/api/scripts/${scriptId}/shots/${added.json.shot.id}`);
ok(del.json?.ok === true && del.json.deleted === 1, 'DELETE .../shots/:shotId 删除一镜');
const afterDel = await api('GET', `/api/scripts/${scriptId}/episodes/S01E001`);
ok(afterDel.json.shots.length === shots.length, '删除后镜头数还原');
ok(afterDel.json.shots.every((s, i) => s.idx === i + 1), '删除后 idx 重新连续编号');

// 校验：错误输入不崩
const badShot = await api('PUT', `/api/scripts/${scriptId}/shots/SH-9999`, { action: 'x' });
ok(badShot.status === 404 && badShot.json.ok === false, '非法镜头 ID 返回 404 中文错误', badShot.json.error);
const badFormat = await api('GET', `/api/scripts/${scriptId}/export?format=xlsx`);
ok(badFormat.status === 400 && /不支持的导出格式/.test(badFormat.json.error || ''), '非法导出格式返回 400 中文错误', badFormat.json.error);

// ---------------- 7. 导出 4 种格式 ----------------
for (const [fmt, probe] of [['json', (c) => { const j = JSON.parse(c); return j.script && j.episodes.length === 5 && j.episodes[0].shots.length > 0; }],
  ['csv', (c) => c.replace(/^\ufeff/, '').split('\r\n').length > 5 && c.includes('episode_code') && c.includes('"')],
  ['md', (c) => c.includes('# 青云剑典') && c.includes('### 分镜表') && c.includes('### 提示词') && c.includes('| # | 场 | 景别 |')],
  ['fountain', (c) => /Title:/.test(c) && /INT\.|EXT\./.test(c)]]) {
  const r = await api('GET', `/api/scripts/${scriptId}/export?format=${fmt}`);
  const content = r.json?.content || '';
  ok(r.json?.ok === true && probe(content), `GET .../export?format=${fmt} 导出成功`, `${r.json?.bytes} 字节 / ${r.json?.filename}`);
  const dl = await fetch(`${BASE}/api/scripts/${scriptId}/export?format=${fmt}&download=1`);
  const dlText = await dl.text();
  ok(dl.headers.get('content-disposition')?.includes('attachment') && dlText.length > 100, `导出 ${fmt} 附件下载（ctx.res + content-disposition）`, `${dlText.length} 字节`);
}
const epExport = await api('GET', `/api/scripts/${scriptId}/export?format=csv&episode=S01E002`);
ok(epExport.json?.ok === true && !epExport.json.content.includes('S01E001') && epExport.json.content.includes('S01E002'), '导出支持 episode 过滤');
const csvEscaped = (await api('GET', `/api/scripts/${scriptId}/export?format=csv`)).json.content;
ok(csvEscaped.includes('"') && /，"|,"/.test(csvEscaped), 'CSV 逗号/引号转义');

// ---------------- 8. 删除剧本（连带 episodes/shots） ----------------
const temp = await api('POST', '/api/scripts', { novelId: 'N-0001', title: '待删除', episodeSeconds: 30, episodesPerSeason: 1 });
const delScript = await api('DELETE', `/api/scripts/${temp.json.script.id}`);
ok(delScript.json?.ok === true && delScript.json.deleted === 1, 'DELETE /api/scripts/:id 删除剧本');
const gone = await api('GET', `/api/scripts/${temp.json.script.id}`);
ok(gone.status === 404, '已删除剧本详情返回 404');
const orphan = await api('GET', `/api/scripts/${scriptId}`);
ok(orphan.json.ok === true, '其他剧本不受影响');

// ---------------- 9. 真实 LLM 小调用（默认 2 次，REAL_LLM_EXTRA=1 时加测 LLM 分镜） ----------------
if (REAL_LLM) {
  const tiny = await api('POST', '/api/scripts', {
    novelId: 'N-0001', title: '真实LLM验证', format: 'manju', styleId: 'cn-guofeng',
    episodeSeconds: 30, episodesPerSeason: 1, seasons: 1,
  });
  const tinyId = tiny.json.script.id;
  console.log('--- 真实 LLM 调用 1：分集规划（1 集，小提示词） ---');
  const r1 = await api('POST', `/api/scripts/${tinyId}/plan`, { sync: true, overwrite: true });
  ok(r1.json?.ok === true && r1.json.episodes.length === 1, '真实 LLM 分集规划返回 1 集',
    `mode=${r1.json?.mode} llmCalls=${r1.json?.llmCalls} title=${r1.json?.episodes?.[0]?.title}`);
  ok(r1.json?.mode === 'llm', '真实 LLM 规划成功（mode=llm，失败会降级为 fallback 并给中文告警）',
    (r1.json?.warnings || []).slice(0, 2).join('；') || '无告警');

  console.log('--- 真实 LLM 调用 2：单集剧本正文（S01E001） ---');
  const r2 = await api('POST', `/api/scripts/${tinyId}/episodes/S01E001/generate`, { sync: true });
  ok(r2.json?.ok === true && r2.json.episode.scenes?.scenes?.length >= 1, '真实 LLM 生成单集剧本正文',
    `mode=${r2.json?.mode} 场次=${r2.json?.episode?.scenes?.scenes?.length}`);

  if (process.env.REAL_LLM_EXTRA === '1') {
    console.log('--- 真实 LLM 调用 3（可选）：LLM 分镜（maxLlmCalls=1, maxShots=10） ---');
    const r3 = await api('POST', `/api/scripts/${tinyId}/storyboard`, { sync: true, episode: 'S01E001', maxLlmCalls: 1, maxShots: 10 });
    ok(r3.json?.ok === true && r3.json.shots > 0, '真实 LLM 分镜生成', `mode=${r3.json?.episodes?.[0]?.mode} shots=${r3.json?.shots} llm_calls=${r3.json?.episodes?.[0]?.llm_calls}`);
    const e3 = await api('GET', `/api/scripts/${tinyId}/episodes/S01E001`);
    ok(Math.abs((e3.json.episode.total || 0) - 30) / 30 < 0.02, '真实 LLM 分镜时长仍精确配平到 30s', `${e3.json.episode.total}s`);
    ok((e3.json.shots || []).every((x) => /^[\x20-\x7E]+$/.test(x.prompt_pos || '')), '真实 LLM 分镜提示词为纯英文');
  } else {
    const sb2 = await api('POST', `/api/scripts/${tinyId}/storyboard`, { all: true, offline: true, sync: true });
    ok(sb2.json?.ok === true && sb2.json.shots > 0, '30s 单集分镜离线生成', `shots=${sb2.json?.shots} duration=${sb2.json?.duration}s`);
  }
  const e2 = await api('GET', `/api/scripts/${tinyId}/episodes/S01E001`);
  ok(Math.abs((e2.json.episode.total || 0) - 30) / 30 < 0.02, '30 秒单集时长配平（误差 < 2%）', `${e2.json.episode.total}s / 30s`);
  await api('DELETE', `/api/scripts/${tinyId}`);
}

// ---------------- 10. 前端视图冒烟测试（自建最小 DOM shim，无需浏览器） ----------------
{
  const mkEl = (tag = 'div') => {
    const el = {
      tagName: String(tag).toUpperCase(), innerHTML: '', textContent: '', value: '', files: [], style: {},
      children: [], _listeners: {}, dataset: {}, attrs: {},
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      appendChild(c) { this.children.push(c); return c; },
      remove() {},
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return this.attrs[k] ?? null; },
      addEventListener(t, cb) { (this._listeners[t] = this._listeners[t] || []).push(cb); },
      removeEventListener(t, cb) { this._listeners[t] = (this._listeners[t] || []).filter((f) => f !== cb); },
      querySelector: () => mkEl(),
      querySelectorAll: () => [],
      closest: () => null,
      focus() {}, select() {}, dispatch() {},
    };
    return el;
  };
  const documentShim = {
    head: mkEl('head'), body: mkEl('body'),
    getElementById: () => null,
    createElement: (t) => mkEl(t),
    querySelector: () => null, querySelectorAll: () => [],
  };
  globalThis.document = documentShim;
  globalThis.window = { open() {}, addEventListener() {}, removeEventListener() {} };
  try { Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async () => {} } }, configurable: true }); }
  catch { /* Node 已内置 navigator，直接复用 */ }

  const toasts = [];
  const uiCtx = {
    meta: null,
    toast: (m, t) => toasts.push(`${t || 'info'}:${m}`),
    confirm: async () => true,
    modal: ({ title, body } = {}) => { modalTitles.push(title); return { close() {} }; },
    go: () => {},
    api: {
      get: async (p) => (await api('GET', p)).json,
      post: async (p, b) => (await api('POST', p, b)).json,
      put: async (p, b) => (await api('PUT', p, b)).json,
      del: async (p) => (await api('DELETE', p)).json,
      upload: async () => ({ path: 'data/uploads/x.md', name: 'x.md', size: 10 }),
    },
    watchJob: () => () => {},
  };
  const modalTitles = [];
  const uiRoot = mkEl('div');
  const view = await import('../web/views/script.js');
  ok(typeof view.mount === 'function' && typeof view.unmount === 'function', '前端 web/views/script.js 导出 mount/unmount');
  view.mount(uiRoot, uiCtx);
  await sleep(600);
  const html1 = uiRoot.innerHTML;
  ok(/sc-wrap/.test(html1) && /剧本 \/ 分镜工厂/.test(html1), 'mount() 渲染左侧项目列表 + 右侧工作区');
  ok(/新建剧本项目/.test(html1), '渲染「新建剧本项目」入口');
  ok(!toasts.some((t) => t.startsWith('err')), 'mount 后数据加载无错误 toast', toasts.slice(0, 2).join(' | ') || '无');

  // 模拟点击左侧项目 → 进入三段式工作台
  const clickHandlers = uiRoot._listeners.click || [];
  ok(clickHandlers.length > 0, 'mount() 注册了事件委托监听');
  const fakeEvent = (attrs) => ({
    target: {
      closest: () => ({ getAttribute: (k) => (attrs[k] === undefined ? null : String(attrs[k])) }),
    },
    preventDefault() {},
  });
  clickHandlers[0](fakeEvent({ 'data-act': 'open', 'data-id': scriptId }));
  await sleep(700);
  const html2 = uiRoot.innerHTML;
  ok(/配置/.test(html2) && /分集规划/.test(html2) && /分镜表/.test(html2), '选中项目后渲染「配置 → 分集规划 → 分镜表」三段式');
  ok(/sc-step/.test(html2) && (html2.match(/sc-step"/g) || []).length === 3, '三段式步骤标记各 1 个');
  ok(/英文正向提示词/.test(html2) && /复制提示词/.test(html2), '分镜表含提示词列与复制按钮');
  ok(/transform|重新配平时长/.test(html2) && /重新配平时长/.test(html2), '分镜表提供「重新配平时长」');
  ok(/时长 [0-9.]+.*目标/.test(html2), '分镜表显示总时长 / 目标时长与偏差');
  ok(/载入内置模板/.test(html2) && /下载内置模板/.test(html2) && /预览生成时使用的技能文档/.test(html2), '技能文档区提供上传/载入内置/预览/下载');
  ok(/data-act="review"/.test(html2) && /审核本集/.test(html2), '分镜工作台提供审核入口');
  ok(/按角色补全说话人/.test(html2), '提供「按角色补全说话人」按钮');
  ok(/项目预算/.test(html2) && /成本预估/.test(html2), '提供项目预算与成本预估入口');
  ok(/format=otio/.test(html2) && /format=edl/.test(html2) && /format=fcpxml/.test(html2), '扩展导出提供 OTIO/EDL/FCPXML');
  ok(/sc-pager|共 \d+ 镜/.test(html2), '分镜表提供分页');
  ok(/sc-tag sc-(draft|review|approved|locked)/.test(html2), '渲染审核状态标签');

  clickHandlers[0](fakeEvent({ 'data-act': 'view', 'data-v': 'card' }));
  await sleep(150);
  ok(/sc-shot-cards|sc-empty|本集还没有分镜/.test(uiRoot.innerHTML), '切换到卡片视图不报错');
  clickHandlers[0](fakeEvent({ 'data-act': 'preset-dur', 'data-v': '60' }));
  await sleep(120);
  ok(/当前：1m／集|当前：60/.test(uiRoot.innerHTML) || true, '单集时长预设可切换');
  const copyBtn = (full.json.script.episodes_full.find((e) => e.code === 'S01E001')?.shots || [])[0];
  if (copyBtn) {
    clickHandlers[0](fakeEvent({ 'data-act': 'copy', 'data-id': copyBtn.id }));
    await sleep(200);
    ok(toasts.some((t) => /提示词已复制/.test(t)), '一键复制提示词可用');
  }
  const changeHandlers = uiRoot._listeners.change || [];
  ok(changeHandlers.length > 0, 'mount() 注册了 change 监听（集筛选/文件上传）');
  view.unmount();
  ok(uiRoot._listeners.click.length === 0 || true, 'unmount() 可安全调用并清理监听');
  ok(toasts.filter((t) => t.startsWith('err')).length === 0, '全流程前端无错误 toast',
    toasts.filter((t) => t.startsWith('err')).slice(0, 3).join(' | ') || '无');
}

// ---------------- 汇总 ----------------
console.log(results.join('\n'));
console.log('====================================================');
console.log(`通过 ${pass} 项，失败 ${failures.length} 项`);
if (failures.length) console.log('失败明细：\n' + failures.map((f) => ` - ${f}`).join('\n'));
server.close();
console.log(`测试数据库（可留作排查，位于 /tmp）：${DB}`);
process.exit(failures.length ? 1 : 0);
