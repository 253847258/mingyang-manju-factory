// 真实画面质检测试（全离线、零付费）：
//   1. buildVisionRequest 形状与 llm.js 兼容性（含图片块、模型来自 resolveModelFor、source 非空、同步不发请求）；
//   2. parseVisionVerdict 容错（合法 JSON / ```json 代码块 / 纯文本 / 空 / 乱码 / 0~10 与百分制折算）；
//   3. compareShotsByVision：注入假 runVision 能标出离群并给中文摘要；未注入 → 明确跳过 + 中文原因（不抛异常）；
//   4. visionAvailable 的中文可用性说明（mock / 缺 Key / 未知提供方 / 已配置）；
//   5. 与 src/llm.js 的 chat() 真跑一次 —— 打到**本机 127.0.0.1 的假服务端**（不碰任何付费接口）；
//   6. src/qc.js 新增检查项 consistency-vision 的分级（无后端 info / 注入后 warn）与既有 check id 防回归。
// 用法：node tests/test-vision-qc.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA_TMP = path.join(os.tmpdir(), `factory-vq-data-${Date.now()}`);
const DB = path.join(os.tmpdir(), `factory-vq-${Date.now()}.db`);
const CFG = path.join(os.tmpdir(), `factory-vq-config-${Date.now()}.json`);
process.env.FACTORY_DATA_DIR = DATA_TMP;
process.env.FACTORY_DB = DB;
process.env.FACTORY_CONFIG = CFG;
fs.mkdirSync(DATA_TMP, { recursive: true });
// 离线配置：LLM 用 mock（本测试的任何真实调用都只打到本机假服务端）
fs.writeFileSync(CFG, JSON.stringify({ llm: { provider: 'mock', model: '' }, image: { backend: 'placeholder' }, video: { backend: 'placeholder' } }, null, 2));

const { migrate, run, get } = await import('../src/db.js');
const { buildVisionRequest, parseVisionVerdict, compareShotsByVision, visionAvailable, visionSummary, DEFAULT_VISION_QUESTION } = await import('../src/vision-qc.js');
const { resolveModelFor } = await import('../src/model-registry.js');
const { qcEpisode } = await import('../src/qc.js');

migrate();

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? `  ${extra}` : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? `  ${extra}` : ''}`); }
};

// ---------------- 夹具：4 张关键帧（3 张绿 + 1 张品红当离群）+ 1 个角色 ----------------
const IMG_DIR = path.join(DATA_TMP, 'images');
fs.mkdirSync(IMG_DIR, { recursive: true });
const mkPng = (name, args) => {
  const rel = path.join('images', name);
  try {
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', args, '-frames:v', '1', path.join(DATA_TMP, rel)], { stdio: 'pipe' });
  } catch {
    fs.writeFileSync(path.join(DATA_TMP, rel), Buffer.from('not-a-real-png', 'utf8')); // 极端兜底（一致性评分会因此降级，但本文件其它断言仍可跑）
  }
  return rel;
};
const ACTOR = 'C-VQ01';
const SHOTS = [
  { idx: 1, file: mkPng('vq-1-green.png', 'color=c=green:s=256x256:d=0.1') },
  { idx: 2, file: mkPng('vq-2-green.png', 'color=c=green:s=256x256:d=0.1') },
  { idx: 3, file: mkPng('vq-3-green.png', 'color=c=green:s=256x256:d=0.1') },
  { idx: 4, file: mkPng('vq-4-magenta.png', 'color=c=magenta:s=256x256:d=0.1') },
];
const MAGENTA = SHOTS[3].file;
const pngAbs = path.join(DATA_TMP, SHOTS[0].file);

// 可用性判定用的配置（角色级 qcVision = deepseek + llm.apiKey，完全离线可控，不受环境变量影响）
const VCFG = {
  llm: { provider: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-fake-for-test', model: 'deepseek-flash', temperature: 0.2 },
  models: { roles: { qcVision: { provider: 'deepseek', model: 'deepseek-flash', temperature: 0.2 } } },
};

console.log('\n【1】buildVisionRequest：请求体形状（不发请求）');
const req1 = buildVisionRequest({ images: [SHOTS[0].file], question: '这两帧一致吗？只输出 JSON', cfg: VCFG });
const resolved = resolveModelFor('qcVision', VCFG);
ok('形状：{model, provider, baseUrl, messages, source} 齐全，模型取自 resolveModelFor',
  req1.ok === true && req1.model === resolved.model && req1.provider === resolved.provider && req1.baseUrl === resolved.baseUrl && req1.source === resolved.source,
  `model=${req1.model} provider=${req1.provider} baseUrl=${req1.baseUrl}`);
ok('source 非空且说明来自哪一层', typeof req1.source === 'string' && req1.source.length > 0, req1.source.slice(0, 60));
ok('messages 与 llm.js 兼容：单条 user + content 块数组（文本块在前）',
  Array.isArray(req1.messages) && req1.messages.length === 1 && req1.messages[0].role === 'user'
  && Array.isArray(req1.messages[0].content) && req1.messages[0].content[0].type === 'text'
  && req1.messages[0].content[1].type === 'image_url', JSON.stringify(req1.messages[0].content.map((c) => c.type)));
ok('本地关键帧被转成 data URL（真图字节进请求体，不是只放路径）',
  req1.imageCount === 1 && /^data:image\/png;base64,[A-Za-z0-9+/=]{64,}$/.test(req1.messages[0].content[1].image_url.url)
  && req1.images[0] === SHOTS[0].file, `${req1.messages[0].content[1].image_url.url.slice(0, 42)}… (${fs.statSync(pngAbs).size}B)`);
ok('自定义问题写进文本块，且默认问题里带「JSON」字样（json_object 模式要求）',
  /这两帧一致吗/.test(req1.messages[0].content[0].text) && /JSON/.test(DEFAULT_VISION_QUESTION), `text=${req1.messages[0].content[0].text.slice(0, 40)}…`);
ok('零网络：同步返回（不是 Promise），调用本身不可能发起请求', typeof req1.then !== 'function' && req1.ok === true);
const reqMulti = buildVisionRequest({
  images: ['https://example.com/a.png', { base64: Buffer.from('fake-bytes').toString('base64'), mime: 'image/jpeg' }, SHOTS[1].file],
  cfg: VCFG,
});
ok('三种图片来源（URL / base64 / 本地路径）都能变成图片块',
  reqMulti.imageCount === 3 && reqMulti.messages[0].content.length === 4
  && reqMulti.messages[0].content[1].image_url.url === 'https://example.com/a.png'
  && /^data:image\/jpeg;base64,/.test(reqMulti.messages[0].content[2].image_url.url), `imageCount=${reqMulti.imageCount}`);
ok('文本块写明张数（模型知道要比较几张）', /共 3 张关键帧/.test(reqMulti.messages[0].content[0].text));
const reqBad = buildVisionRequest({ images: ['images/不存在.png', SHOTS[2].file], cfg: VCFG });
ok('缺文件被跳过并给中文警告（不抛异常，剩余图片仍可用）',
  reqBad.ok === true && reqBad.imageCount === 1 && reqBad.warnings.some((w) => /文件不存在/.test(w)), reqBad.warnings[0]);
const svgRel = path.join('images', 'vq-placeholder.svg');
fs.writeFileSync(path.join(DATA_TMP, svgRel), '<svg xmlns="http://www.w3.org/2000/svg"><rect width="8" height="8"/></svg>');
const reqSvg = buildVisionRequest({ images: [svgRel], cfg: VCFG });
ok('占位 SVG 会被明确警告（多模态读不了位图以外的占位图）',
  reqSvg.ok === true && reqSvg.warnings.some((w) => /SVG/.test(w)), reqSvg.warnings[0].slice(0, 60));
const reqNone = buildVisionRequest({ images: [], cfg: VCFG });
ok('一张图都没有时 ok:false + 中文 error（不静默发空请求）', reqNone.ok === false && /没有可用图片/.test(reqNone.error), reqNone.error);

console.log('\n【2】parseVisionVerdict：容错解析（永不抛异常）');
const pJson = parseVisionVerdict(JSON.stringify({ ok: true, score: 0.93, issues: [], summary: '四帧同角色、同画风' }));
ok('合法 JSON：字段齐全', pJson.ok === true && pJson.score === 0.93 && pJson.issues.length === 0 && /同画风/.test(pJson.summary) && pJson.parsed === true, JSON.stringify(pJson).slice(0, 90));
const pFence = parseVisionVerdict('好的，结论如下：\n```json\n{"ok": false, "score": 8, "issues": [{"shot": 3, "reason": "面部变形"}], "summary": "第 3 张不一致"}\n```\n以上。');
ok('```json 代码块：能解析，且 10 分制折算成 0~1', pFence.ok === false && pFence.score === 0.8 && pFence.format === 'fenced-json', `score=${pFence.score} format=${pFence.format}`);
ok('问题项是对象时压成中文一行（带镜号）', pFence.issues.length === 1 && /镜 3/.test(pFence.issues[0]) && /面部变形/.test(pFence.issues[0]), pFence.issues[0]);
const pTextBad = parseVisionVerdict('第 3 张明显不一致，人物脸部变形，手部畸形。');
ok('纯文本负面：判为未通过并抽出问题条目', pTextBad.ok === false && pTextBad.issues.length >= 1 && /变形|不一致|畸形/.test(pTextBad.issues[0]), `${pTextBad.format}｜${pTextBad.issues[0]}`);
const pTextGood = parseVisionVerdict('四张关键帧看起来是同一个角色，画风一致，未发现明显异常。');
ok('纯文本正面：含「未发现异常」不会被误判成负面', pTextGood.ok === true && pTextGood.issues.length === 0, pTextGood.summary.slice(0, 60));
const pTextScore = parseVisionVerdict('一致性评分 8/10，可以接受。');
ok('纯文本里的「8/10」「85%」也能折算成 0~1', pTextScore.score === 0.8 && parseVisionVerdict('相似度 85%').score === 0.85, `${pTextScore.score} / ${parseVisionVerdict('相似度 85%').score}`);
const pEmpty = parseVisionVerdict('');
const pNull = parseVisionVerdict(null);
ok('空 / null：中文兜底、ok:false、不抛异常', pEmpty.ok === false && pEmpty.score === null && /空内容/.test(pEmpty.summary) && pNull.ok === false && pNull.format === 'empty');
const pJunk = parseVisionVerdict('@@@###%%%  ⌘⌥⇧  ###');
ok('乱码：判为无法判读（format=garbage）并建议人工复核', pJunk.ok === false && pJunk.format === 'garbage' && /人工复核/.test(pJunk.summary), pJunk.summary.slice(0, 70));
const pPartial = parseVisionVerdict('{"summary": "看起来还行"}');
ok('缺字段的 JSON：给中文兜底说明并降置信度（不假装通过）',
  pPartial.ok === false && pPartial.score === null && pPartial.confidence === 'low' && /没有 ok \/ score/.test(pPartial.summary), pPartial.summary.slice(0, 70));
const pNoneIssues = parseVisionVerdict('{"ok": true, "score": 0.9, "issues": ["无"], "summary": "一致"}');
ok('issues 为「无」/空数组时按没有问题处理', pNoneIssues.issues.length === 0 && pNoneIssues.ok === true);
const pPercent = parseVisionVerdict('{"ok": true, "score": "92%", "issues": [], "summary": "一致"}');
ok('score 写成百分数字符串也能折算', pPercent.score === 0.92, String(pPercent.score));
ok('解析空字符串之外的脏输入永不抛异常（10 种脏输入全过）',
  ['', null, undefined, 0, '[]', '{}', '```', 'ok', '{"ok":', '\u0000\u0001'].every((x) => { try { return typeof parseVisionVerdict(x).ok === 'boolean'; } catch { return false; } }));

console.log('\n【3】compareShotsByVision：注入假 runVision（零付费，纯离线）');
const visionCalls = [];
// 假多模态后端：请求里出现品红那张 → 低分 + 问题；否则高分（完全确定性，不打任何网络）
const fakeRunVision = async (req) => {
  visionCalls.push(req);
  const bad = (req.images || []).some((f) => String(f).includes('magenta'));
  return { text: `\`\`\`json\n${JSON.stringify(bad
    ? { ok: false, score: 0.18, issues: ['面部变形、画风与同角色其他镜头不一致'], summary: '这一镜与同角色其他镜头明显不一致' }
    : { ok: true, score: 0.93, issues: [], summary: '与同角色其他镜头一致' })}\n\`\`\`` };
};
const shotInputs = SHOTS.map((s, i) => ({ shotId: `SH-VQ${i + 1}`, idx: s.idx, file: s.file, characters: [ACTOR] }));
run(`INSERT INTO actors(id, name, gender, created_at) VALUES(?,?,?,?)`, ACTOR, '质检演员', 'female', new Date().toISOString());
const cmp = await compareShotsByVision({ shots: shotInputs, runVision: fakeRunVision, cfg: VCFG });
ok('两两比较：4 张关键帧跑满 6 对调用，全部返回可判读分数',
  cmp.skipped === false && cmp.summary.calls === 6 && cmp.summary.scored === 4 && cmp.summary.failed === 0, JSON.stringify(cmp.summary));
ok('离群判定：故意做坏的品红那镜被标出，其余三镜不报',
  cmp.outliers.length === 1 && cmp.outliers[0].idx === 4 && !cmp.outliers.some((o) => o.idx !== 4),
  cmp.outliers.map((o) => `#${o.idx}:${o.score}`).join(','));
ok('perShot 给出逐镜真实评分与来源（分数=该镜与同组各镜两两分的均值，来源是模型不是 aHash）',
  cmp.perShot.length === 4 && cmp.perShot.find((p) => p.idx === 4).score === 0.18
  && cmp.perShot.find((p) => p.idx === 1).vs.map((x) => x.score).sort().join(',') === '0.18,0.93,0.93'
  && cmp.perShot.filter((p) => p.idx !== 4).every((p) => p.score === 0.68 && p.score > cmp.outliers[0].score)
  && cmp.perShot.every((p) => p.scoreSource === 'model'),
  cmp.perShot.map((p) => `#${p.idx}=${p.score}`).join(' '));
ok('中文摘要可读（含组数/对数/离群数与最低分）', /离群/.test(visionSummary(cmp)) && /最低 0\.18/.test(visionSummary(cmp)), visionSummary(cmp));
ok('离群项带角色名、问题清单与「只重跑这几镜」建议',
  cmp.outliers[0].actorName === '质检演员' && /变形/.test(cmp.outliers[0].issues[0]) && /只重跑这 1 镜/.test(String(cmp.retryHint)), cmp.retryHint);
ok('假后端确实收到了真实请求（每次 1 文本块 + 2 张 data URL 图片）',
  visionCalls.length === 6 && visionCalls.every((r) => r.messages[0].content.length === 3 && /^data:image\/png;base64,/.test(r.messages[0].content[1].image_url.url)),
  `调用 ${visionCalls.length} 次，首张图 ${String(visionCalls[0].messages[0].content[1].image_url.url).slice(0, 30)}…`);
const cmpHighThreshold = await compareShotsByVision({ shots: shotInputs, runVision: fakeRunVision, cfg: VCFG, threshold: 0.1 });
ok('阈值是权威口径：调到 0.1 后不再报任何离群镜头（0.18 > 0.1）',
  cmpHighThreshold.outliers.length === 0 && cmpHighThreshold.threshold === 0.1, `outliers=${cmpHighThreshold.outliers.length}`);
const cmpSkipped = await compareShotsByVision({ shots: shotInputs, runVision: null, cfg: VCFG });
ok('未注入 runVision：明确跳过（skipped:true）并给中文原因，不抛异常',
  cmpSkipped.skipped === true && cmpSkipped.ok === false && /未配置多模态质检后端/.test(cmpSkipped.reason) && /代理指标仍可用/.test(cmpSkipped.reason),
  cmpSkipped.reason);
ok('跳过时也给出「怎么才能启用」的中文指引（不是静默失败）',
  /runVision/.test(String(cmpSkipped.detail)) && cmpSkipped.outliers.length === 0 && cmpSkipped.perShot.length === 0, String(cmpSkipped.detail).slice(0, 80));
const cmpBoom = await compareShotsByVision({ shots: shotInputs, runVision: async () => { throw new Error('连接被拒绝'); }, cfg: VCFG });
ok('注入的调用器抛错：记录失败原因、判为未取得判据（ok:false），不把异常抛给调用方',
  cmpBoom.skipped === false && cmpBoom.ok === false && cmpBoom.summary.failed === 6 && cmpBoom.summary.scored === 0
  && /未取得有效判据/.test(cmpBoom.reason) && /连接被拒绝/.test(cmpBoom.failed[0].error), cmpBoom.reason.slice(0, 70));
const cmpJunk = await compareShotsByVision({ shots: shotInputs, runVision: async () => '@@@###', cfg: VCFG });
ok('后端返回乱码：不给分、not scored + 中文警告（不会把读不懂当成读出了坏画面）',
  cmpJunk.ok === false && cmpJunk.summary.scored === 0 && cmpJunk.outliers.length === 0
  && cmpJunk.perShot.every((p) => p.score === null) && cmpJunk.warnings.some((w) => /没有给出任何可判读的分数/.test(w)), cmpJunk.warnings[0].slice(0, 70));
const cmpSingle = await compareShotsByVision({ shots: [shotInputs[0]], runVision: fakeRunVision, cfg: VCFG });
ok('同角色只有 1 张关键帧：没有可比较项，如实说明（不报假离群）',
  cmpSingle.summary.calls === 0 && cmpSingle.outliers.length === 0 && /没有可比较的关键帧|没有可执行的两两比较/.test(`${cmpSingle.reason}${cmpSingle.note}`));

console.log('\n【4】visionAvailable：中文可用性说明');
const avMock = visionAvailable({ llm: { provider: 'mock', model: '' }, models: {} });
ok('mock 后端：判为不可用并说明「不会真的读图 / 已跳过（代理指标仍可用）」',
  avMock.available === false && /离线模板/.test(avMock.reason) && /代理指标仍可用/.test(avMock.reason), avMock.reason.slice(0, 60));
const avOk = visionAvailable(VCFG);
ok('deepseek + 已配置 Key：判为可用，并说明来源与「要注入 runVision」',
  avOk.available === true && /已配置多模态质检后端/.test(avOk.reason) && /runVision/.test(avOk.hint), `${avOk.reason}｜${avOk.hint.slice(0, 40)}`);
const avUnknown = visionAvailable({ llm: { provider: 'mock' }, models: { roles: { qcVision: { provider: '不存在的厂' } } } });
ok('未知提供方：不可用 + 中文原因（不抛异常）', avUnknown.available === false && /不在支持列表|不支持视觉类/.test(avUnknown.reason), avUnknown.reason.slice(0, 60));
const avNoKey = visionAvailable({ llm: { provider: 'openai', baseUrl: 'https://api.openai.com', apiKey: '', model: 'gpt-4o-mini' }, models: { roles: { qcVision: { provider: 'openai', model: 'gpt-4o-mini' } } } });
ok('缺 Key：不可用并指出缺什么', avNoKey.available === false && /缺少可用的 API Key|Key/.test(avNoKey.reason), avNoKey.reason.slice(0, 60));

console.log('\n【5】与 llm.js 的 chat() 真跑一次（打到本机 127.0.0.1 假服务端，零付费）');
const received = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    received.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body || '{}') });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      model: 'deepseek-flash',
      choices: [{ message: { role: 'assistant', content: '```json\n{"ok": false, "score": 0.25, "issues": ["第 2 张换脸"], "summary": "两张不是同一角色"}\n```' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const { chat } = await import('../src/llm.js');
const vreq = buildVisionRequest({ images: [SHOTS[0].file, SHOTS[3].file], cfg: VCFG, question: '这两帧是同一个人吗？只输出 JSON' });
const chatRes = await chat({ ...vreq.chatOpts, url: `http://127.0.0.1:${port}/chat/completions`, apiKey: 'sk-local-fake', provider: 'deepseek', retries: 0, maxTokens: 512 });
server.close();
ok('llm.chat() 原样透传多模态 messages：假服务端收到 content 块数组（含 2 个 image_url）',
  received.length === 1 && Array.isArray(received[0].body.messages[0].content)
  && received[0].body.messages[0].content.filter((c) => c.type === 'image_url').length === 2
  && received[0].body.model === 'deepseek-flash', `POST ${received[0].url} model=${received[0].body.model} 图片块=${received[0].body.messages[0].content.filter((c) => c.type === 'image_url').length}`);
ok('假服务端只被打了一次（本测试没有任何真实付费调用）', received.length === 1);
const chatVerdict = parseVisionVerdict(chatRes.text);
ok('chat() 返回的文本能被 parseVisionVerdict 判读（端到端闭环：请求→转录→判据）',
  chatVerdict.ok === false && chatVerdict.score === 0.25 && /换脸/.test(chatVerdict.issues[0]), `score=${chatVerdict.score} issues=${chatVerdict.issues[0]}`);

console.log('\n【6】src/qc.js 接入：新增 consistency-vision（既有 check id 防回归）');
const now = new Date().toISOString();
run(`INSERT INTO scripts(id,novel_id,title,format,style_id,episode_seconds,episodes_per_season,seasons,status,created_at,updated_at)
     VALUES('SC-VQ','N-VQ','真实画面质检测试剧本','manju','cinematic-real',12,1,1,'storyboard',?,?)`, now, now);
run(`INSERT INTO script_episodes(id,script_id,season,episode,code,title,duration,status,created_at,updated_at)
     VALUES('EP-VQ','SC-VQ',1,1,'S01E001','真实画面质检集',12,'storyboard',?,?)`, now, now);
SHOTS.forEach((s, i) => {
  const sid = `SH-VQ${i + 1}`;
  run(`INSERT INTO shots(id,script_id,episode_id,idx,scene_no,shot_size,camera,move,transition,duration,action,dialogue,prompt_pos,prompt_neg,refs,cost_level,status,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?)`,
    sid, 'SC-VQ', 'EP-VQ', s.idx, '1', '中景', '平视', '固定', '切', 3, `动作${s.idx}`, '', 'p', 'n',
    JSON.stringify({ characters: [ACTOR] }), 'L', now);
  run(`INSERT INTO shot_renders(id,script_id,episode_id,shot_id,kind,file_path,mime,width,height,status,created_at)
       VALUES(?,?,?,?, 'keyframe', ?, 'image/png', 256, 256, 'done', ?)`, `RD-VQ${i + 1}`, 'SC-VQ', 'EP-VQ', sid, s.file, now);
});
const repNoVision = await qcEpisode({ scriptId: 'SC-VQ', code: 'S01E001' });
const itemsWith = (rep, id) => (rep.items || []).filter((it) => (it.checks || []).some((c) => c.id === id));
const checkOf = (rep, id) => { for (const it of rep.items || []) for (const c of it.checks || []) if (c.id === id) return c; return null; };
// 既有检查项集合（排除本次新增的 visual-qc 项）：用于「注入前/后既有项一个都没变」的防回归对比
const legacyIds = (rep) => rep.items.filter((it) => it.kind !== 'visual-qc')
  .map((it) => `${it.kind}:${(it.checks || []).map((c) => `${c.id}=${c.level}`).join('+')}`).sort();
const CONSISTENCY_IDS = ['consistency-ok', 'consistency-outliers', 'consistency-skip'];
ok('无多模态后端：新增检查项 consistency-vision 是 info「未配置多模态质检后端，使用代理指标」',
  checkOf(repNoVision, 'consistency-vision')?.level === 'info' && /未配置多模态质检后端，使用代理指标/.test(checkOf(repNoVision, 'consistency-vision').message),
  `${checkOf(repNoVision, 'consistency-vision')?.level}｜${checkOf(repNoVision, 'consistency-vision')?.message}`);
ok('无后端时也把「怎么启用」写进 detail（不静默失败）',
  /runVision/.test(String(checkOf(repNoVision, 'consistency-vision')?.detail)) && /不会发起任何多模态请求/.test(String(checkOf(repNoVision, 'consistency-vision')?.detail)),
  String(checkOf(repNoVision, 'consistency-vision')?.detail).slice(0, 80));
ok('既有 check id 全部仍在（防回归：成片/跨镜一致性/分镜覆盖/字幕）',
  ['film-exists', 'missing-videos', 'subtitle-empty'].every((id) => Boolean(checkOf(repNoVision, id)))
  && CONSISTENCY_IDS.some((id) => Boolean(checkOf(repNoVision, id))),
  repNoVision.items.flatMap((i) => i.checks.map((c) => c.id)).join(','));
ok('既有一致性检查结论未被改动（仍是 aHash 代理指标口径）',
  /未发现离群镜头|画风与同角色其他镜头明显不一致|没有可比较的关键帧/.test(checkOf(repNoVision, 'consistency-ok')?.message || checkOf(repNoVision, 'consistency-outliers')?.message || ''),
  checkOf(repNoVision, 'consistency-ok')?.message || checkOf(repNoVision, 'consistency-outliers')?.message || '(无)');

const qcVisionCalls = [];
const qcVision = async (req) => {
  qcVisionCalls.push(req);
  const bad = (req.images || []).some((f) => String(f).includes('magenta'));
  return { text: JSON.stringify(bad
    ? { ok: false, score: 0.16, issues: ['面部变形、画风漂移'], summary: '与同角色其他镜头明显不一致' }
    : { ok: true, score: 0.94, issues: [], summary: '与同角色其他镜头一致' }) };
};
const repVision = await qcEpisode({ scriptId: 'SC-VQ', code: 'S01E001' }, { vision: qcVision, cfg: VCFG });
const vCheck = checkOf(repVision, 'consistency-vision');
const vItem = itemsWith(repVision, 'consistency-vision')[0];
ok('注入假 runVision：consistency-vision 升级为 warn，并写出真实评分与离群镜头',
  vCheck?.level === 'warn' && /多模态评分/.test(vCheck.message) && /真实画面质检/.test(vCheck.message), `${vCheck?.level}｜${vCheck?.message}`);
ok('warn 的 detail 给出具体镜号/评分/问题与「只重跑」建议',
  /镜 #4 评分 0\.16/.test(String(vCheck.detail)) && /变形/.test(String(vCheck.detail)) && /只重跑/.test(String(vCheck.detail)), String(vCheck.detail).slice(0, 110));
ok('vision 结果挂在 item 上（perShot 逐镜评分 + summary 统计）',
  vItem?.vision && vItem.vision.perShot.length === 4 && vItem.vision.summary.scored === 4
  && vItem.vision.perShot.find((p) => p.idx === 4).score === 0.16 && vItem.vision.outliers[0].idx === 4 == true,
  JSON.stringify(vItem?.vision?.summary));
ok('注入路径真的发起了多模态调用，且请求里带的是关键帧图片（不是 aHash 数字）',
  qcVisionCalls.length === 6 && qcVisionCalls.every((r) => /^data:image\/png;base64,/.test(r.messages[0].content[1].image_url.url)), `调用 ${qcVisionCalls.length} 次`);
ok('新增检查项只有一项：visual-qc 项在两次质检里各出现 1 次（info → warn 升级，不是新增第二条）',
  itemsWith(repVision, 'consistency-vision').length === 1 && itemsWith(repNoVision, 'consistency-vision').length === 1
  && repVision.items.filter((it) => it.kind === 'visual-qc').length === 1,
  `items=${repNoVision.items.length} → ${repVision.items.length}`);
ok('既有返回结构字段未变（scriptId/code/expected/checked/summary/verdict/items/fps/generatedAt 全在）',
  ['scriptId', 'code', 'script', 'film', 'expected', 'checked', 'sampledClips', 'summary', 'verdict', 'items', 'fps', 'generatedAt']
    .every((k) => Object.prototype.hasOwnProperty.call(repVision, k))
  && repVision.expected.shots === 4 && repVision.summary.error + repVision.summary.warn + repVision.summary.info + repVision.summary.ok
    === repVision.items.reduce((n, i) => n + i.checks.length, 0),
  `verdict=${repVision.verdict} summary=${JSON.stringify(repVision.summary)}`);
ok('注入真实质检后既有检查项与其分级一个都没变（逐项对比 kind:check=level）',
  JSON.stringify(legacyIds(repVision)) === JSON.stringify(legacyIds(repNoVision)),
  legacyIds(repVision).join(' | '));
const repBadBackend = await qcEpisode({ scriptId: 'SC-VQ', code: 'S01E001' }, { vision: async () => { throw new Error('假后端 502'); }, cfg: VCFG });
const bCheck = checkOf(repBadBackend, 'consistency-vision');
ok('后端全部失败时降级为 info（如实说明未取得判据，不退化成假通过）',
  bCheck?.level === 'info' && /未取得有效评分/.test(bCheck.message) && repBadBackend.verdict === repNoVision.verdict,
  `${bCheck?.level}｜${bCheck?.message}｜verdict=${repBadBackend.verdict}`);
const repMockBackend = await qcEpisode({ scriptId: 'SC-VQ', code: 'S01E001' }, { vision: qcVision }); // 不传 cfg：默认配置（mock）→ 不可用
ok('后端不可用时即使注入了 runVision 也不调用（info + 中文原因，零请求）',
  checkOf(repMockBackend, 'consistency-vision')?.level === 'info' && /代理指标/.test(checkOf(repMockBackend, 'consistency-vision').message));

// =====================================================================================
// 【7】~【9】V-101 新增：多厂商多模态协议（Gemini generateContent）
//   目标：provider 是 google/Gemini 时，请求体按 Gemini 形状产出（contents/parts/inline_data + generationConfig），
//         响应按 candidates[].content.parts[].text 解析；OpenAI 兼容路径**逐字节不变**（下面的快照断言是硬证据）。
//   全部离线：只用纯函数 + 注入的假 runVision，**不允许任何真实网络请求**。
//   字段出处一律以仓库调研为准：docs/模型对接参考.md:1356（inline_data/mime_type/data）、:1357（响应路径）、
//   :1355（端点）、:1354（鉴权头）、:1359（图片 MIME 支持 png/jpeg/webp）、:1372（JSON 模式字段）。
// =====================================================================================
const PNG_1X1_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const PNG_1X1 = Buffer.from(PNG_1X1_B64, 'base64');
const WEBP_BYTES = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.from('VP8 '), Buffer.alloc(24)]);
const mkImg = (name, buf) => { const rel = path.join('images', name); fs.writeFileSync(path.join(DATA_TMP, rel), buf); return rel; };
const LEGACY_REL = mkImg('vq-legacy-1x1.png', PNG_1X1);              // 真 PNG（扩展名与内容一致）
const MISLABELED_REL = mkImg('vq-gem-mislabeled.jpg', PNG_1X1);      // PNG 字节，扩展名却是 .jpg
const WEBP_MISLABELED_REL = mkImg('vq-gem-webp.jpg', WEBP_BYTES);    // WEBP 字节，扩展名却是 .jpg

const GEMINI_BASE = 'https://generativelanguage.googleapis.com';
const GCFG = {
  llm: { provider: 'mock', model: '' },
  models: { roles: { qcVision: { provider: 'google', model: 'gemini-2.5-flash', baseUrl: GEMINI_BASE, temperature: 0.2, apiKey: 'AIza-fake-for-test' } } },
};

console.log('\n【7】Gemini 请求体形状（generateContent / parts / inline_data / generationConfig，零网络）');
const gReq = buildVisionRequest({ images: [MISLABELED_REL, WEBP_MISLABELED_REL], question: '这两帧一致吗？只输出 JSON', cfg: GCFG });
const gResolved = resolveModelFor('qcVision', GCFG, { strict: false });
ok('Gemini：如实标注 requestShape=gemini 与 protocol，provider/model 仍取自 resolveModelFor',
  gReq.requestShape === 'gemini' && gReq.protocol?.shape === 'gemini'
  && gReq.provider === gResolved.provider && gReq.model === gResolved.model && gReq.baseUrl === gResolved.baseUrl
  && /Gemini/.test(String(gReq.protocol.name)) && /x-goog-api-key/.test(String(gReq.protocol.authHeader)),
  `shape=${gReq.requestShape} provider=${gReq.provider} model=${gReq.model}`);
// ⚠️ M-101 更新（本文件唯一被改写的既有断言之一，原因见下）：
//    这一条原本断言「模型注册表里**还没有** google（strict 模式会抛错、PROVIDERS 白名单缺这一家）」，是 V-101
//    如实标注的缺口。M-101 已把 google 登记进 src/model-registry.js 的 PROVIDERS（kinds 含 vision），
//    该缺口闭合：strict 解析不再抛错、providerKnown 由 false 变 true。断言因此改为「缺口已闭合」的形态
//    （检查点仍是同一个：strict 解析是否可用 + providerKnown + model 取自 resolveModelFor），期望值随事实更新。
ok('Gemini：google 已登记进模型注册表（M-101 闭合 V-101 留下的白名单缺口）——strict 解析不再抛错且 providerKnown=true',
  (() => { try { resolveModelFor('qcVision', GCFG); return true; } catch { return false; } })()
  && gResolved.providerKnown === true && gResolved.model === 'gemini-2.5-flash',
  `providerKnown=${gResolved.providerKnown}（src/model-registry.js 的 PROVIDERS.google，kinds 含 vision）`);
const gParts = gReq.contents?.[0]?.parts || [];
ok('Gemini：contents[].parts[] = [text, inline_data, inline_data]（role=user，文本在前，张数写进文本）',
  gReq.contents.length === 1 && gReq.contents[0].role === 'user' && gParts.length === 3
  && /这两帧一致吗/.test(gParts[0].text) && /共 2 张关键帧/.test(gParts[0].text)
  && Object.keys(gParts[1]).join(',') === 'inline_data'
  && Object.keys(gParts[1].inline_data).join(',') === 'mime_type,data'
  && Object.keys(gParts[2].inline_data).join(',') === 'mime_type,data',
  JSON.stringify(gParts.map((p) => Object.keys(p).join('+'))));
ok('Gemini：inline_data.data 是纯 base64（无 data: 前缀），解码后与磁盘字节逐字节相同',
  !/^data:/.test(gParts[1].inline_data.data) && Buffer.from(gParts[1].inline_data.data, 'base64').equals(PNG_1X1)
  && Buffer.from(gParts[2].inline_data.data, 'base64').equals(WEBP_BYTES),
  `第 1 张 ${gParts[1].inline_data.data.slice(0, 22)}…（${PNG_1X1.length}B）`);
ok('Gemini：mime 按**真实文件类型**判定（PNG 存成 .jpg → image/png；WEBP 存成 .jpg → image/webp），不是照抄扩展名',
  gParts[1].inline_data.mime_type === 'image/png' && gParts[2].inline_data.mime_type === 'image/webp',
  `.jpg(PNG)=${gParts[1].inline_data.mime_type} .jpg(WEBP)=${gParts[2].inline_data.mime_type}`);
ok('Gemini：声明/扩展名与真实类型不一致时给中文警告', gReq.warnings.length === 2 && /真实类型/.test(gReq.warnings[0]), gReq.warnings[0]);
const gDataUrlDeclaredJpeg = buildVisionRequest({
  images: [`data:image/jpeg;base64,${PNG_1X1_B64}`], cfg: GCFG,
});
ok('Gemini：data URL 里声明的 mime 是错的（写 image/jpeg 实际是 PNG）也按真实字节纠正',
  gDataUrlDeclaredJpeg.contents[0].parts[1].inline_data.mime_type === 'image/png'
  && gDataUrlDeclaredJpeg.contents[0].parts[1].inline_data.data === PNG_1X1_B64,
  `mime=${gDataUrlDeclaredJpeg.contents[0].parts[1].inline_data.mime_type}｜${gDataUrlDeclaredJpeg.warnings[0] || '(无警告)'}`);
const gNoJson = buildVisionRequest({ images: [LEGACY_REL], cfg: GCFG, json: false, maxTokens: 512, temperature: 0 });
ok('Gemini：generationConfig 带 temperature / maxOutputTokens / responseMimeType（JSON 模式开关生效）',
  Object.keys(gReq.generationConfig).join(',') === 'temperature,maxOutputTokens,responseMimeType'
  && gReq.generationConfig.temperature === 0.2 && gReq.generationConfig.maxOutputTokens === 1024
  && gReq.generationConfig.responseMimeType === 'application/json', JSON.stringify(gReq.generationConfig));
ok('Gemini：json:false 时不产出 responseMimeType（开关是双向的），显式 temperature=0 不被 0.2 覆盖',
  !('responseMimeType' in gNoJson.generationConfig) && Object.keys(gNoJson.generationConfig).join(',') === 'temperature,maxOutputTokens'
  && gNoJson.generationConfig.temperature === 0 && gNoJson.generationConfig.maxOutputTokens === 512,
  JSON.stringify(gNoJson.generationConfig));
ok('Gemini：端点拼成 /v1beta/models/{model}:generateContent；baseUrl 已带版本号/已是完整端点时不重复拼',
  gReq.url === `${GEMINI_BASE}/v1beta/models/gemini-2.5-flash:generateContent`
  && buildVisionRequest({ images: [LEGACY_REL], cfg: { models: { roles: { qcVision: { provider: 'google', model: 'gemini-2.5-flash', baseUrl: `${GEMINI_BASE}/v1beta` } } } } }).url === gReq.url
  && buildVisionRequest({ images: [LEGACY_REL], cfg: { models: { roles: { qcVision: { provider: 'google', model: 'gemini-2.5-flash', baseUrl: `${gReq.url}` } } } } }).url === gReq.url,
  gReq.url);
ok('Gemini：body 就是 {contents, generationConfig}，method=POST，鉴权头只给头名（x-goog-api-key）不给 Key',
  gReq.method === 'POST' && JSON.stringify(Object.keys(gReq.body).sort()) === '["contents","generationConfig"]'
  && gReq.body.contents === gReq.contents && gReq.apiKeyHeader === 'x-goog-api-key'
  && JSON.stringify(gReq.headers) === '{"content-type":"application/json"}', JSON.stringify(gReq.headers));
ok('Gemini：返回体**不含任何 Key 明文**（脱敏；Key 由调用方自己从 cfg/环境变量取）',
  !JSON.stringify(gReq).includes('AIza-fake-for-test') && !JSON.stringify(gReq.headers).toLowerCase().includes('authorization')
  && /已配置角色级 API Key/.test(String(gReq.keySource)), String(gReq.keySource));
ok('Gemini：远端 http(s) 图被**明确跳过**（inline_data 只吃纯 base64，本模块不下载）并给中文原因，本地图仍可用',
  (() => {
    const r = buildVisionRequest({ images: ['https://example.com/a.png', LEGACY_REL], cfg: GCFG });
    return r.ok === true && r.imageCount === 1 && r.contents[0].parts.length === 2
      && r.warnings.some((w) => /inline_data/.test(w) && /跳过/.test(w));
  })(),
  buildVisionRequest({ images: ['https://example.com/a.png', LEGACY_REL], cfg: GCFG }).warnings[0]);
ok('Gemini：全是远端图时 ok:false + 中文 error（不静默发一个没有图的请求）',
  (() => { const r = buildVisionRequest({ images: ['https://example.com/a.png'], cfg: GCFG }); return r.ok === false && /没有可用图片/.test(r.error); })(),
  buildVisionRequest({ images: ['https://example.com/a.png'], cfg: GCFG }).error);
const GCFG_NO_MODEL = { models: { roles: { qcVision: { provider: 'google', baseUrl: GEMINI_BASE, model: '' } } } };
const gNoModel = buildVisionRequest({ images: [LEGACY_REL], cfg: GCFG_NO_MODEL });
ok('Gemini：缺模型名 → ok:false + 中文 error（模型名必须进 URL，拼不出端点就不假装能发）',
  gNoModel.ok === false && /模型名/.test(gNoModel.error) && /generateContent/.test(gNoModel.error) && !gNoModel.url
  && gNoModel.warnings.some((w) => /模型名为空/.test(w)), gNoModel.error.slice(0, 90));

console.log('\n【7b】OpenAI 兼容路径逐字节不变（改造前实现的输出快照，防回归硬证据）');
const LEGACY_EXPECT = {
  role: 'user',
  content: [
    { type: 'text', text: '这两帧一致吗？只输出 JSON\n\n（本次共 1 张关键帧，按给出顺序为第 1 ~ 1 张）' },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_1X1_B64}`, detail: 'auto' } },
  ],
};
const legacyReq = buildVisionRequest({ images: [LEGACY_REL], question: '这两帧一致吗？只输出 JSON', cfg: VCFG });
ok('OpenAI 路径 requestShape=openai，且不产出 contents/body/url（默认行为一字未变）',
  legacyReq.requestShape === 'openai' && legacyReq.protocol?.shape === 'openai'
  && !('contents' in legacyReq) && !('body' in legacyReq) && !('url' in legacyReq) && !('generationConfig' in legacyReq),
  `shape=${legacyReq.requestShape} keys=${Object.keys(legacyReq).length}`);
ok('OpenAI 路径 messages 与改造前**逐字节一致**（快照对比，不是「看起来差不多」）',
  JSON.stringify(legacyReq.messages) === JSON.stringify([LEGACY_EXPECT]), JSON.stringify(legacyReq.messages).slice(0, 120));
ok('OpenAI 路径 chatOpts 也逐字节一致（仍可直接喂 llm.chat）',
  JSON.stringify(legacyReq.chatOpts) === JSON.stringify({
    messages: [LEGACY_EXPECT], model: 'deepseek-flash', provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com', temperature: 0.2, maxTokens: 1024, json: true,
  }), JSON.stringify(legacyReq.chatOpts).slice(0, 120));
ok('非 Gemini 的未知提供方仍走 OpenAI 形状（不误判成 Gemini）',
  buildVisionRequest({ images: [LEGACY_REL], cfg: { models: { roles: { qcVision: { provider: '不存在的厂', model: 'x', baseUrl: 'https://example.com' } } } } }).requestShape === 'openai');

console.log('\n【8】Gemini 响应解析（candidates[].content.parts[].text，与 OpenAI 形状并存）');
const gemResp = (text, finishReason = 'STOP') => ({ candidates: [{ content: { parts: [{ text }] }, finishReason }], usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 40 } });
const gpJson = parseVisionVerdict(gemResp('{"ok": true, "score": 0.91, "issues": [], "summary": "同角色同画风"}'));
ok('Gemini 原生响应对象：能取出 candidates[].content.parts[].text 并解析成结论',
  gpJson.parsed === true && gpJson.ok === true && gpJson.score === 0.91 && /同画风/.test(gpJson.summary), `${gpJson.format}｜score=${gpJson.score}`);
const gpFence = parseVisionVerdict(gemResp('```json\n{"ok": false, "score": 8, "issues": [{"shot": 3, "reason": "面部变形"}], "summary": "第 3 张不一致"}\n```'));
ok('Gemini：正文被 ```json 围栏包住也能解析（沿用同一套容错），10 分制照样折算',
  gpFence.ok === false && gpFence.score === 0.8 && gpFence.format === 'fenced-json' && /镜 3/.test(gpFence.issues[0]),
  `${gpFence.format}｜${gpFence.issues[0]}`);
const gpArray = parseVisionVerdict(gemResp('[\n {"shot": 2, "issue": "手部畸形"},\n "第 4 张穿模"\n]'));
ok('Gemini：正文是被数组包裹的 JSON 时按问题清单处理（json-array）',
  gpArray.format === 'json-array' && gpArray.ok === false && gpArray.issues.length === 2 && /畸形/.test(gpArray.issues[0]),
  `${gpArray.format}｜${gpArray.issues.join(' / ')}`);
const gpMultiParts = parseVisionVerdict({
  candidates: [{ content: { parts: [{ text: '结论如下：' }, { text: '```json\n{"ok": true, "score": 0.88, "issues": [], "summary": "一致"}\n```' }] }, finishReason: 'STOP' }],
});
ok('Gemini：多个 parts 的文本按顺序拼接后再解析（不只取 parts[0]）',
  gpMultiParts.parsed === true && gpMultiParts.score === 0.88, `${gpMultiParts.format}｜score=${gpMultiParts.score}`);
const gpBlocked = parseVisionVerdict({ promptFeedback: { blockReason: 'SAFETY' } });
ok('Gemini 被安全拦截（只有 promptFeedback.blockReason、没有 candidates）：中文可读错误、不静默返回空结论',
  gpBlocked.ok === false && gpBlocked.format === 'blocked' && gpBlocked.parsed === false && gpBlocked.confidence === 'none'
  && /安全策略拦截/.test(gpBlocked.summary) && /SAFETY/.test(gpBlocked.summary), gpBlocked.summary.slice(0, 80));
const gpTruncated = parseVisionVerdict({ candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }], usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 800 } });
ok('Gemini 有 candidates 但没有文本（如被截断）：中文说明原因并带上用量，判为未取得判据',
  gpTruncated.ok === false && gpTruncated.format === 'gemini-empty' && /截断/.test(gpTruncated.summary)
  && /1200/.test(gpTruncated.summary), gpTruncated.summary.slice(0, 90));
ok('Gemini 空 parts 无 finishReason：仍给中文可读结论（envelope-empty，不回空字符串）',
  (() => { const v = parseVisionVerdict({ candidates: [{ content: { parts: [] } }] }); return v.ok === false && v.format === 'envelope-empty' && /没有可读文本/.test(v.summary); })(),
  parseVisionVerdict({ candidates: [{ content: { parts: [] } }] }).summary.slice(0, 80));
const gpJunk = parseVisionVerdict(gemResp('@@@###%%% ⌘⌥⇧'));
ok('Gemini 正文是乱码：判为无法判读（garbage）并建议人工复核（解析失败给中文错误）',
  gpJunk.ok === false && gpJunk.format === 'garbage' && /人工复核/.test(gpJunk.summary), gpJunk.summary.slice(0, 70));
const gpOpenAIEnvelope = parseVisionVerdict({ choices: [{ message: { role: 'assistant', content: '```json\n{"ok": false, "score": 0.25, "issues": ["换脸"], "summary": "不是同一角色"}\n```' } }] });
ok('OpenAI 原始响应对象（choices[].message.content）与 Gemini 形状并存，互不影响',
  gpOpenAIEnvelope.parsed === true && gpOpenAIEnvelope.score === 0.25 && /换脸/.test(gpOpenAIEnvelope.issues[0]), `${gpOpenAIEnvelope.format}｜score=${gpOpenAIEnvelope.score}`);
ok('畸形 Gemini 响应 6 种都不抛异常，且都给出中文结论（不静默）', [
  { candidates: [] }, { candidates: [{}] }, { candidates: [{ content: {} }] }, { candidates: [{ content: { parts: [{}, { text: '' }] } }] },
  { promptFeedback: {} }, { candidates: [{ content: { parts: [{ text: 42 }] } }] },
].every((x) => { try { const v = parseVisionVerdict(x); return typeof v.ok === 'boolean' && /[\u4e00-\u9fa5]/.test(v.summary); } catch { return false; } }));
ok('坏 Gemini 响应不会被折算成「读出了坏画面」（confidence=none 时不给分）',
  parseVisionVerdict({ promptFeedback: { blockReason: 'SAFETY' } }).confidence === 'none' && gpJunk.confidence === 'none');

console.log('\n【9】visionAvailable 的 Gemini 路径 + Gemini 端到端（注入假后端，零付费）');
const avGem = visionAvailable(GCFG, {});
ok('Gemini：Key + model + baseUrl 齐备 → 可用，并说明协议与「不能用 chat() 发」',
  avGem.available === true && avGem.requestShape === 'gemini' && /Gemini generateContent/.test(avGem.reason)
  && /inline_data/.test(avGem.reason) && /chat\(\)/.test(avGem.hint) && /x-goog-api-key/.test(avGem.hint),
  `${avGem.reason}｜${avGem.hint.slice(0, 60)}`);
ok('Gemini：返回体不含 Key 明文（只回来源说明）',
  !JSON.stringify(avGem).includes('AIza-fake-for-test') && /角色级 API Key/.test(avGem.keyDetail), avGem.keyDetail);
const avGemEnv = visionAvailable({ models: { roles: { qcVision: { provider: 'google', model: 'gemini-2.5-flash', baseUrl: GEMINI_BASE } } } }, { GEMINI_API_KEY: 'AIza-from-env' });
ok('Gemini：Key 只来自环境变量也算可用（并说明来自哪个变量）',
  avGemEnv.available === true && /环境变量 GEMINI_API_KEY/.test(avGemEnv.keyDetail), avGemEnv.keyDetail);
const avGemNoKey = visionAvailable({ models: { roles: { qcVision: { provider: 'google', model: 'gemini-2.5-flash', baseUrl: GEMINI_BASE } } } }, {});
ok('Gemini：有 model + baseUrl 但没有任何 Key → 不可用 + 中文原因（指出 Gemini 用 x-goog-api-key）',
  avGemNoKey.available === false && /缺少可用的 API Key/.test(avGemNoKey.reason) && /x-goog-api-key/.test(avGemNoKey.reason)
  && /代理指标仍可用/.test(avGemNoKey.reason), avGemNoKey.reason.slice(0, 70));
const avGemNoModel = visionAvailable({ models: { roles: { qcVision: { provider: 'google', model: '', baseUrl: GEMINI_BASE, apiKey: 'k' } } } }, {});
ok('Gemini：缺模型名 → 不可用 + 中文原因（模型名要进 URL）',
  avGemNoModel.available === false && /模型名/.test(avGemNoModel.reason) && /generateContent/.test(avGemNoModel.reason), avGemNoModel.reason.slice(0, 70));
// ⚠️ M-101 更新（本文件第三处被改写的既有断言）：原来用 provider='google' 造「缺 baseUrl」用例，
//   但 google 登记进 registry 后**会自动带上提供方默认地址**（与 openai/deepseek 等既有条目同一个口径），
//   所以「缺 baseUrl」不再可能发生在 google 上。检查点（缺地址 → 不可用 + 中文原因 + 给出官方地址）保留，
//   改用「按协议认得出是 Gemini、但没登记进 registry」的写法（google-ai 在 GEMINI_PROVIDER_IDS 里）来触发，
//   并另外补一条断言确认 google 现在会兜底默认地址——两件事都不丢。
const avGemNoUrl = visionAvailable({ models: { roles: { qcVision: { provider: 'google-ai', model: 'gemini-2.5-flash', apiKey: 'k' } } } }, {});
ok('Gemini：缺 baseUrl → 不可用 + 中文原因（并给出官方地址）',
  avGemNoUrl.available === false && /baseUrl/.test(avGemNoUrl.reason) && /generativelanguage\.googleapis\.com/.test(avGemNoUrl.reason), avGemNoUrl.reason.slice(0, 70));
const avGemDefaultUrl = visionAvailable({ models: { roles: { qcVision: { provider: 'google', model: 'gemini-2.5-flash', apiKey: 'k' } } } }, {});
ok('Gemini：登记后不写 baseUrl 也会自动用注册表里的官方默认地址（provider 层兜底，与其它厂商同口径）',
  avGemDefaultUrl.available === true && avGemDefaultUrl.baseUrl === GEMINI_BASE, `${avGemDefaultUrl.baseUrl}｜available=${avGemDefaultUrl.available}`);
// ⚠️ M-101 更新（本文件第二处被改写的既有断言）：google 登记后，vision-qc 里那段
//   「提供方「google」还没登记进 PROVIDERS 白名单（设置页保存时可能拒收）」的提示**不再出现**
//   （它只在 !providerKnown 时拼接）。检查点不变（协议识别 + 可用性 + 中文原因），只把「缺口提示存在」
//   改为「缺口提示已消失」，避免留下一条会因登记而永久失败的红灯。
ok('Gemini：登记后不再出现「未登记 / 白名单可能拒收」提示（providerKnown=true），协议识别与可用性照旧',
  !/PROVIDERS 白名单/.test(String(avGem.reason)) && avGem.available === true && avGem.requestShape === 'gemini',
  String(avGem.reason).slice(-90));
const GCFG_BY_BASE = {
  llm: { provider: 'openai', baseUrl: GEMINI_BASE, apiKey: 'sk-fake-openai', model: 'gemini-2.5-flash' },
  models: { roles: { qcVision: { provider: 'openai', model: 'gemini-2.5-flash', baseUrl: GEMINI_BASE } } },
};
ok('baseUrl 指向 generativelanguage 时也按 Gemini 判定（provider 写 openai 也不会拼错形状）',
  visionAvailable(GCFG_BY_BASE, {}).requestShape === 'gemini' && visionAvailable(GCFG_BY_BASE, {}).available === true
  && buildVisionRequest({ images: [LEGACY_REL], cfg: GCFG_BY_BASE }).requestShape === 'gemini');
const gemCalls = [];
const geminiRunVision = async (req) => {
  gemCalls.push(req);
  const bad = (req.images || []).some((f) => String(f).includes('magenta'));
  const verdict = bad
    ? { ok: false, score: 0.17, issues: ['面部变形、与同角色其他镜头不一致'], summary: '这一镜明显不一致' }
    : { ok: true, score: 0.92, issues: [], summary: '与同角色其他镜头一致' };
  // 故意回**厂商原始响应 JSON**（不是 {text}）：考验 compareShotsByVision → parseVisionVerdict 的 Gemini 通路
  return gemResp('```json\n' + JSON.stringify(verdict) + '\n```');
};
const cmpGem = await compareShotsByVision({ shots: shotInputs, runVision: geminiRunVision, cfg: GCFG });
ok('Gemini 端到端：6 对调用全部按 Gemini 形状发出（contents/parts/inline_data），且拿回 4 张真实评分',
  cmpGem.requestShape === 'gemini' && cmpGem.summary.calls === 6 && cmpGem.summary.scored === 4 && cmpGem.summary.failed === 0
  && gemCalls.length === 6 && gemCalls.every((r) => r.requestShape === 'gemini' && r.contents[0].parts.length === 3
    && r.contents[0].parts.slice(1).every((p) => p.inline_data?.data && !/^data:/.test(p.inline_data.data)))
  && gemCalls.every((r) => r.url.endsWith(':generateContent')), JSON.stringify(cmpGem.summary));
ok('Gemini 端到端：离群镜判定仍成立（品红那镜被标出），中文摘要可读',
  cmpGem.outliers.length === 1 && cmpGem.outliers[0].idx === 4 && /离群/.test(visionSummary(cmpGem)), visionSummary(cmpGem));
const cmpGemBlocked = await compareShotsByVision({ shots: shotInputs, runVision: async () => ({ promptFeedback: { blockReason: 'SAFETY' } }), cfg: GCFG });
ok('Gemini 全部被安全拦截：不给分、如实说未取得判据（中文原因透传到逐镜摘要，不静默、不假通过）',
  cmpGemBlocked.ok === false && cmpGemBlocked.summary.scored === 0 && cmpGemBlocked.outliers.length === 0
  && cmpGemBlocked.perShot.every((p) => p.score === null)
  && /安全策略拦截/.test(String(cmpGemBlocked.perShot[0]?.summaries?.[0]))
  && cmpGemBlocked.warnings.some((w) => /没有给出任何可判读的分数/.test(w)),
  String(cmpGemBlocked.perShot[0]?.summaries?.[0]).slice(0, 70));
ok('Gemini 配置下未注入 runVision：仍然明确跳过（不因支持了 Gemini 就偷偷发请求）',
  (await compareShotsByVision({ shots: shotInputs, runVision: null, cfg: GCFG })).skipped === true);

// =====================================================================================
// 【10】M-101 追加：registry（google 登记）↔ vision-qc 的端到端一致性
//   目标：设置页里给「画面质检」选 Google/Gemini 之后，配置能存、能读回、能被 resolveModelFor 解析，
//         并且 buildVisionRequest 真的按 Gemini 形状产出（requestShape='gemini'）——三段链路一次串起来。
//   全程离线：本节把 globalThis.fetch 换成计数桩，跑完断言「一次网络调用都没有」（零付费硬证据）。
// =====================================================================================
console.log('\n【10】M-101：google 登记后 registry ↔ vision-qc 端到端一致（保存 → 读回 → 拼请求，零网络）');
{
  const MR = await import('../src/model-registry.js');
  const VQ = await import('../src/vision-qc.js');
  const { saveConfig, loadConfig } = await import('../src/config.js');
  const netCalls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (...args) => { netCalls.push(String(args[0])); return realFetch(...args); };
  try {
    // ① 两份「事实」不漂移：registry 的条目与 vision-qc 的协议常量必须对得上
    const gp = MR.PROVIDERS.google;
    ok('一致性：registry 的 PROVIDERS.google 与 vision-qc 的 Gemini 常量对齐（baseUrl / envKeys / provider id）',
      gp.baseUrl === VQ.DEFAULT_GEMINI_BASE_URL && VQ.GEMINI_PROVIDER_IDS.includes('google')
        && VQ.GEMINI_KEY_ENV.every((k) => gp.envKeys.includes(k))
        && MR.canonicalProviderId('google') === 'google' && MR.canonicalProviderId('gemini') === 'google',
      `baseUrl=${gp.baseUrl}｜envKeys=${gp.envKeys.join('/')}`);
    ok('一致性：google 只登记为 vision（不含 llm/images），vision-qc 也是唯一的 Gemini 调用分支',
      gp.kinds.join('/') === 'vision' && MR.providerSupports('google', 'vision') === true
        && MR.providerSupports('google', 'llm') === false && MR.providerSupports('google', 'image') === false,
      gp.kinds.join('/'));

    // ② strict 解析不再抛错，且解析结果与拼出来的请求逐字段一致
    let strictResolved = null;
    let strictThrew = false;
    try { strictResolved = MR.resolveModelFor('qcVision', GCFG); } catch { strictThrew = true; }
    ok('端到端：strict 解析 qcVision=google 不抛错（providerKnown/providerKindOk 都为 true）',
      !strictThrew && strictResolved?.providerKnown === true && strictResolved?.providerKindOk === true
        && strictResolved?.provider === 'google' && strictResolved?.model === 'gemini-2.5-flash',
      strictThrew ? '仍然抛错' : `${strictResolved.provider}/${strictResolved.model}`);
    const strictReq = buildVisionRequest({ images: [LEGACY_REL], cfg: GCFG });
    ok('端到端：buildVisionRequest 用 registry 解析出的 provider/baseUrl 产出 requestShape=gemini（不再是「未登记也照样拼」）',
      strictReq.requestShape === 'gemini' && strictReq.provider === strictResolved.provider
        && strictReq.model === strictResolved.model && strictReq.baseUrl === strictResolved.baseUrl
        && strictReq.url === `${GEMINI_BASE}/v1beta/models/gemini-2.5-flash:generateContent`
        && strictReq.headers?.['x-goog-api-key'] === undefined,
      `${strictReq.requestShape}｜${strictReq.url}`);
    ok('端到端：鉴权头仍是 x-goog-api-key（registry 的 configHint 与协议自描述同口径，不是 Bearer）',
      strictReq.apiKeyHeader === 'x-goog-api-key' && /x-goog-api-key/.test(gp.configHint) && /不是 Authorization: Bearer/.test(gp.configHint),
      `apiKeyHeader=${strictReq.apiKeyHeader}`);

    // ③ 保存通路：PUT /api/settings 的 models 段白名单 + 落盘 + 读回（设置页按这条路走）
    const patch = MR.sanitizeModelsPatch({
      roles: { qcVision: { provider: 'google', model: 'gemini-3.8-flash', baseUrl: GEMINI_BASE, temperature: 0.2, apiKey: 'AIza-offline-test' } },
    }, { existingProfiles: MR.builtinProfiles() });
    ok('保存通路：PUT 的 models 段接受 roles.qcVision={provider:google,…}（不再被白名单拒收）',
      patch.ok && patch.patch.roles.qcVision.provider === 'google' && patch.patch.roles.qcVision.baseUrl === GEMINI_BASE,
      JSON.stringify(patch.patch?.roles?.qcVision));
    saveConfig({ models: patch.patch });
    const reloaded = loadConfig({ reload: true });
    const backReq = buildVisionRequest({ images: [LEGACY_REL], cfg: reloaded });
    ok('端到端：落盘 → loadConfig 读回 → buildVisionRequest 仍是 Gemini 形状，provider/model/baseUrl 一个不丢',
      backReq.requestShape === 'gemini' && backReq.provider === 'google' && backReq.model === 'gemini-3.8-flash'
        && backReq.baseUrl === GEMINI_BASE && backReq.url === `${GEMINI_BASE}/v1beta/models/gemini-3.8-flash:generateContent`,
      `${backReq.provider}/${backReq.model}｜${backReq.url}`);
    const backAvail = visionAvailable(reloaded, {});
    ok('端到端：读回后 visionAvailable 判为可用（Key 来自角色级 apiKey），requestShape=gemini',
      backAvail.available === true && backAvail.requestShape === 'gemini' && /角色级 API Key/.test(backAvail.keyDetail),
      `${backAvail.reason.slice(0, 70)}`);

    // ④ 校验与非法值：能跑的角色不报错，非法值仍然中文拒绝
    const v = MR.validateModels(reloaded, { env: {} });
    ok('端到端：validateModels 对 google 配置的 qcVision 无阻塞项（issues 里没有这一角色）',
      v.issues.filter((i) => i.role === 'qcVision').length === 0,
      JSON.stringify(v.issues.filter((i) => i.role === 'qcVision')));
    const badPatch = MR.sanitizeModelsPatch({ roles: { qcVision: { provider: 'googlex' } } }, { existingProfiles: MR.builtinProfiles() });
    ok('端到端：拼错的厂商名仍被中文拒绝且不产生 patch（非法值整体不落盘）',
      !badPatch.ok && badPatch.patch === null && badPatch.errors.every((m) => /[\u4e00-\u9fff]/.test(m)),
      badPatch.errors[0]);

    // ⑤ 别名写法（gemini）在 registry 与 vision-qc 两侧都被认
    const aliasCfg = { models: { roles: { qcVision: { provider: 'gemini', model: 'gemini-3.8-flash', baseUrl: GEMINI_BASE, apiKey: 'k' } } } };
    let aliasOk = true;
    try { MR.resolveModelFor('qcVision', aliasCfg); } catch { aliasOk = false; }
    ok('端到端：别名 provider=gemini 在两侧都被认（strict 不抛错 + buildVisionRequest 仍是 gemini 形状）',
      aliasOk && buildVisionRequest({ images: [LEGACY_REL], cfg: aliasCfg }).requestShape === 'gemini');
  } finally {
    globalThis.fetch = realFetch;
  }
  ok('零网络反证：本节全部断言（登记一致性 / 落盘 / 读回 / 拼请求）没有发起任何 fetch 调用',
    netCalls.length === 0, `fetch 调用 ${netCalls.length} 次${netCalls.length ? '：' + netCalls.join(',') : ''}`);
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
try {
  for (const f of [DB, DB + '-wal', DB + '-shm', CFG]) fs.rmSync(f, { force: true });
  fs.rmSync(DATA_TMP, { recursive: true, force: true });
} catch { /* ignore */ }
process.exit(fail ? 1 : 0);
