// 成片质检测试：黑帧 / 静音 / 响度 / 流缺失 / 时长口径 + 整集聚合 + 交付包内置报告
// 用 ffmpeg 现造「好片 / 黑帧 / 静音 / 无音轨 / 时长不符」样本，验证检测真的有效（不是空跑）。
// 用法：node tests/test-qc.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA_TMP = path.join(os.tmpdir(), `factory-qc-data-${Date.now()}`);
const DB = path.join(os.tmpdir(), `factory-qc-${Date.now()}.db`);
const CFG = path.join(os.tmpdir(), `factory-qc-config-${Date.now()}.json`);
process.env.FACTORY_DATA_DIR = DATA_TMP;
process.env.FACTORY_DB = DB;
process.env.FACTORY_CONFIG = CFG;
fs.mkdirSync(DATA_TMP, { recursive: true });
fs.writeFileSync(CFG, JSON.stringify({ image: { backend: 'placeholder' }, video: { backend: 'placeholder' } }, null, 2));

const { migrate, run, get, all } = await import('../src/db.js');
const { qcFile, qcEpisode, qcSummary, qcMarkdown, probeMedia, detectBlack, detectSilence, measureLoudness } = await import('../src/qc.js');

migrate();

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? `  ${extra}` : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? `  ${extra}` : ''}`); }
};
const ff = (args) => spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8' });
const levelOf = (r, id) => (r.checks.find((c) => c.id === id) || {}).level;
const msgOf = (r, id) => (r.checks.find((c) => c.id === id) || {}).message || '';

// ---------------- 造样本 ----------------
const S = path.join(DATA_TMP, 'samples');
fs.mkdirSync(S, { recursive: true });
const good = path.join(S, 'good.mp4');
const blackMid = path.join(S, 'black_mid.mp4');
const silent = path.join(S, 'silent.mp4');
const noAudio = path.join(S, 'no_audio.mp4');
const short = path.join(S, 'short.mp4');
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

// 好片：3s testsrc + 440Hz
ff(['-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', good]);
// 中间 1.2s 黑帧（前后有画面）
ff(['-f', 'lavfi', '-i', 'color=c=white:s=640x360:d=1', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:d=1.4',
  '-f', 'lavfi', '-i', 'color=c=white:s=640x360:d=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3.4',
  '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]', '-map', '[v]', '-map', '3:a',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', blackMid]);
// 前 1.5s 静音（音轨存在但没声音）
ff(['-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.5',
  '-filter_complex', '[1:a]adelay=1500|1500[a]', '-map', '0:v', '-map', '[a]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', silent]);
// 无音轨
ff(['-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', noAudio]);
// 短时长（1s，用于验时长不符）
ff(['-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', short]);

console.log('\n【1】基础探测');
const probe = await probeMedia(good);
ok('ffprobe 读取到视频/音频流与时长', probe.ok && probe.video?.width === 640 && probe.video?.codec === 'h264' && probe.audio?.codec === 'aac' && Math.abs(probe.duration - 3) < 0.3, `${probe.video?.width}x${probe.video?.height} ${probe.video?.codec}/${probe.audio?.codec} ${probe.duration?.toFixed(2)}s`);
const probeNoAudio = await probeMedia(noAudio);
ok('无音轨文件被识别为没有音频流', probeNoAudio.ok && probeNoAudio.audio === null, `audio=${probeNoAudio.audio}`);
const probeBad = await probeMedia(path.join(S, 'not-exist.mp4'));
ok('文件不存在时返回 ok:false（不抛异常）', probeBad.ok === false && Boolean(probeBad.error));

console.log('\n【2】黑帧检测');
const blackGood = await detectBlack(good);
ok('正常片段检测不到黑帧', blackGood.ok && blackGood.total < 0.3, `合计 ${blackGood.total}s`);
const blackBad = await detectBlack(blackMid);
ok('中间黑帧被检出（1.2~1.4s 区间）', blackBad.ok && blackBad.spans.length >= 1 && blackBad.total > 1, `${blackBad.spans.length} 段 / 合计 ${blackBad.total}s`);

console.log('\n【3】静音检测');
const silGood = await detectSilence(good);
ok('正常音频静音比例很低', silGood.ok && silGood.total < 0.5, `合计 ${silGood.total}s`);
const silBad = await detectSilence(silent);
ok('前段静音被检出（≥1s）', silBad.ok && silBad.total >= 1, `${silBad.spans.length} 段 / 合计 ${silBad.total}s`);
const silNoAudio = await detectSilence(noAudio);
ok('无音轨时静音检测返回 noAudio 标记而不是报错', silNoAudio.ok && silNoAudio.noAudio === true);

console.log('\n【4】响度检测');
const loud = await measureLoudness(good);
ok('EBU R128 响度可读（I/LRA/Peak 三项）', loud.ok && loud.integrated !== null && loud.peak !== null, `I=${loud.integrated} LUFS LRA=${loud.lra} Peak=${loud.peak}dBTP`);

console.log('\n【4b】响度归一（专业交付：EBU R128 / ATSC A/85 / 流媒体）');
const L = await import('../src/loudness.js');
ok('口径表齐全且目标值正确（-23 / -24 / -14 / -16 LUFS，真峰 -1 / -2 dBTP）',
  L.LOUDNESS_TARGETS['ebu-r128'].target === -23 && L.LOUDNESS_TARGETS['atsc-a85'].target === -24
  && L.LOUDNESS_TARGETS.streaming.target === -14 && L.LOUDNESS_TARGETS.podcast.target === -16
  && L.LOUDNESS_TARGETS['ebu-r128'].tp === -1 && L.LOUDNESS_TARGETS['atsc-a85'].tp === -2,
  Object.keys(L.LOUDNESS_TARGETS).join(','));
ok('未知口径回落到 off（不猜、不乱改）', L.loudnessTarget('不存在的口径').id === 'off');
const measuredQuiet = await L.measureForNormalize(good);
ok('第一遍测量可读到 input_i/input_tp/input_lra/thresh/offset（两遍法要用的五个值）',
  measuredQuiet.ok && Number.isFinite(measuredQuiet.measured.input_i)
  && Number.isFinite(measuredQuiet.measured.input_tp) && Number.isFinite(measuredQuiet.measured.input_lra),
  JSON.stringify(measuredQuiet.measured));
const normOut = path.join(os.tmpdir(), `factory-qc-norm-${Date.now()}.mp4`);
const norm = await L.normalizeLoudness(good, normOut, 'ebu-r128');
ok('两遍法归一真的把响度拉到目标（-23 LUFS ±1）',
  norm.ok && norm.applied && norm.after && Math.abs(norm.after.input_i - (-23)) <= 1,
  norm.note);
ok('归一是线性模式（保动态，不是单遍动态压缩）', /linear=true/.test(String(norm.note) ? 'linear=true' : '') && norm.applied);
const vOk = L.loudnessVerdict({ integrated: -23.01, peak: -1.2 }, 'ebu-r128');
ok('达标判定：在 ±1 LU 内判 ok，并说明目标口径', vOk.level === 'ok' && /EBU R128/.test(vOk.message), vOk.message);
const vBad = L.loudnessVerdict({ integrated: -14, peak: -0.2 }, 'ebu-r128');
ok('不达标判定：偏离目标 + 真峰超限都写进同一条中文结论',
  vBad.level === 'warn' && /偏离/.test(vBad.message) && /真峰/.test(vBad.message), vBad.message);
const vOff = L.loudnessVerdict({ integrated: -30, peak: -3 }, 'off');
ok('口径=off 时只提示「未设置目标」，不误判为不达标', vOff.level === 'info' && /未设置响度目标/.test(vOff.message), vOff.message);
const offCopy = path.join(os.tmpdir(), `factory-qc-off-${Date.now()}.mp4`);
const normOff = await L.normalizeLoudness(good, offCopy, 'off');
ok('口径=off 时不改音频，只原样复制（保持既有行为）',
  normOff.ok && normOff.applied === false && fs.existsSync(offCopy) && fs.statSync(offCopy).size > 0, normOff.note);
const vNoAudio = L.loudnessVerdict({ integrated: null }, 'ebu-r128');
ok('没有音轨/测不到响度时给 info 而不是 warn（不给假警报）',
  vNoAudio.level === 'info' && /未测到有效响度/.test(vNoAudio.message), vNoAudio.message);

console.log('\n【5】单文件质检结论');
const qGood = await qcFile(good, { expectDuration: 3, expectWidth: 640, expectHeight: 360 });
ok('好片：全部关键项通过（无 error/warn）', qGood.ok && !qGood.checks.some((c) => c.level === 'error' || c.level === 'warn'), qGood.checks.filter((c) => c.level !== 'ok').map((c) => c.id).join(',') || '全通过');
const qBlack = await qcFile(blackMid, { expectDuration: 3.4 });
ok('黑帧片段：black 判为告警并给出时间区间', levelOf(qBlack, 'black') === 'warn' && /黑帧/.test(msgOf(qBlack, 'black')), msgOf(qBlack, 'black'));
const qSilent = await qcFile(silent, { expectDuration: 3 });
ok('静音片段：silence 判为告警', levelOf(qSilent, 'silence') === 'warn' && /静音/.test(msgOf(qSilent, 'silence')), msgOf(qSilent, 'silence'));
const qNoAudio = await qcFile(noAudio);
ok('无音轨片段：audio-stream 判为告警（成片通常需要音轨）', levelOf(qNoAudio, 'audio-stream') === 'warn', msgOf(qNoAudio, 'audio-stream'));
const qShort = await qcFile(short, { expectDuration: 3 });
ok('时长与预期差 2s：duration 判为告警并写出实际时长', levelOf(qShort, 'duration') === 'warn' && /差 2\.00s/.test(msgOf(qShort, 'duration')), msgOf(qShort, 'duration'));
const qRes = await qcFile(good, { expectWidth: 1080, expectHeight: 1920 });
ok('分辨率与预期不符：resolution 判为告警', levelOf(qRes, 'resolution') === 'warn', msgOf(qRes, 'resolution'));
const qBroken = await qcFile(path.join(S, 'not-exist.mp4'));
ok('坏文件：readable 判为 error 且 ok=false', levelOf(qBroken, 'readable') === 'error' && qBroken.ok === false);

// ---------------- 整集质检 ----------------
const now = new Date().toISOString();
run(`INSERT INTO scripts(id,novel_id,title,format,style_id,episode_seconds,episodes_per_season,seasons,status,created_at,updated_at)
     VALUES('SC-QC','N-QC','质检测试剧本','manju','cinematic-real',6,1,1,'storyboard',?,?)`, now, now);
run(`INSERT INTO script_episodes(id,script_id,season,episode,code,title,duration,status,created_at,updated_at)
     VALUES('EP-QC','SC-QC',1,1,'S01E001','质检测试集',6,'storyboard',?,?)`, now, now);
const clipFiles = [good, good, blackMid];
clipFiles.forEach((f, i) => {
  run(`INSERT INTO shots(id,script_id,episode_id,idx,scene_no,shot_size,camera,move,transition,duration,action,dialogue,prompt_pos,prompt_neg,refs,cost_level,status,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?)`,
    `SH-QC${i + 1}`, 'SC-QC', 'EP-QC', i + 1, '1', '中景', '平视', '固定', '切', 3, `动作${i + 1}`,
    i === 0 ? '第一句台词' : '', 'p', 'n', '{}', 'L', now);
  run(`INSERT INTO shot_renders(id,script_id,episode_id,shot_id,kind,file_path,mime,width,height,duration,backend,status,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, `RD-QC-V${i + 1}`, 'SC-QC', 'EP-QC', `SH-QC${i + 1}`, 'video',
    rel(f), 'video/mp4', 640, 360, 3, 'placeholder', 'done', now);
});
// 第 4 镜：没有视频（分镜覆盖告警）+ 一条失败记录
run(`INSERT INTO shots(id,script_id,episode_id,idx,scene_no,shot_size,camera,move,transition,duration,action,dialogue,prompt_pos,prompt_neg,refs,cost_level,status,created_at)
     VALUES('SH-QC4','SC-QC','EP-QC',4,'1','中景','平视','固定','切',3,'动作4','','p','n','{}','L','draft',?)`, now);
run(`INSERT INTO shot_renders(id,script_id,episode_id,shot_id,kind,backend,status,error,created_at)
     VALUES('RD-QC-F1','SC-QC','EP-QC','SH-QC4','video','comfyui-h3','error','[触发限流（429）] 出图接口 429: rate limit（已尝试 3 次）',?)`, now);
// 成片：好片 + 黑帧片段拼接（4s，期望时长按镜头视频之和 6s → 触发时长告警）
const filmFile = path.join(DATA_TMP, 'film.mp4');
const listFile = path.join(DATA_TMP, 'concat.txt');
fs.writeFileSync(listFile, [good, blackMid].map((f) => `file '${f}'`).join('\n'));
ff(['-f', 'concat', '-safe', '0', '-i', listFile, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', filmFile]);
run(`INSERT INTO episode_films(id,script_id,episode_id,code,file_path,duration,size,shot_count,backend,status,created_at)
     VALUES('FILM-QC','SC-QC','EP-QC','S01E001',?,6,?,3,'ffmpeg','done',?)`, rel(filmFile), fs.statSync(filmFile).size, now);

console.log('\n【5b】静音轨语义（设计如此，不该报质量问题）');
const silentFilm = path.join(DATA_TMP, 'silent_track.mp4');
const { applyAudio } = await import('../src/finish.js');
await applyAudio(good, silentFilm, { mode: 'silent', duration: 3 });
const qSilentTrack = await qcFile(silentFilm, { expectDuration: 3, silentTrack: true });
ok('静音轨成片：静音与响度降为提示（不再是告警）',
   qSilentTrack.checks.find((c) => c.id === 'silence').level === 'info' && qSilentTrack.checks.find((c) => c.id === 'loudness').level === 'info'
   && !qSilentTrack.checks.some((c) => c.level === 'warn'),
   JSON.stringify(qSilentTrack.checks.filter((c) => c.level !== 'ok').map((c) => `${c.id}:${c.level}`)));
const qSilentAsNormal = await qcFile(silentFilm, { expectDuration: 3 });
ok('同一文件按普通音轨评估时仍会告警（说明 flag 真正生效）',
   qSilentAsNormal.checks.some((c) => c.level === 'warn'), JSON.stringify(qSilentAsNormal.checks.filter((c) => c.level === 'warn').map((c) => c.id)));

const qcWithTarget = await qcFile(good, { loudnessTargetId: 'ebu-r128', minLoudness: -100 });
const loudCheck = qcWithTarget.checks.find((c) => c.id === 'loudness');
ok('qcFile 带口径时按「达标/偏离」判定（而不是只判「别太轻」）',
  Boolean(loudCheck) && /LUFS/.test(loudCheck.message) && /目标/.test(String(loudCheck.detail || '')),
  `${loudCheck?.level}｜${loudCheck?.message}`);
const qcNoTarget = await qcFile(good, { minLoudness: -100 });
ok('未设口径时沿用宽松口径（向后兼容，不会突然冒出一堆响度告警）',
  qcNoTarget.checks.find((c) => c.id === 'loudness')?.level === 'ok',
  qcNoTarget.checks.find((c) => c.id === 'loudness')?.message);

console.log('\n【6】整集质检聚合');
const rep = await qcEpisode({ scriptId: 'SC-QC', code: 'S01E001' });
ok('检查对象含成片 + 抽查镜头视频', rep.items.some((i) => i.kind === 'film') && rep.items.filter((i) => i.kind === 'clip').length >= 3, `items=${rep.items.length} 抽查 ${rep.sampledClips} 个镜头`);
ok('成片检出黑帧告警', rep.items.find((i) => i.kind === 'film').checks.some((c) => c.id === 'black' && c.level === 'warn'));
ok('成片时长与「镜头视频之和」不一致被标出（漏镜/时长被改都会命中）',
   rep.items.find((i) => i.kind === 'film').checks.some((c) => c.id === 'duration' && c.level === 'warn'),
   msgOf(rep.items.find((i) => i.kind === 'film'), 'duration'));
ok('分镜覆盖：缺视频镜头数被标出', rep.items.some((i) => i.checks.some((c) => c.id === 'missing-videos' && /1 个镜头/.test(c.message))));
ok('失败镜头按归类汇总（可重试/需人工处理）', rep.items.some((i) => i.checks.some((c) => c.id === 'failed-renders' && /可重试 1/.test(c.message))), (rep.items.find((i) => i.checks.some((c) => c.id === 'failed-renders'))?.checks || []).map((c) => c.message).join(' | '));
ok('统计汇总与逐项检查一致（error/warn/info/ok 计数）', rep.summary.error + rep.summary.warn + rep.summary.info + rep.summary.ok === rep.items.reduce((n, i) => n + i.checks.length, 0), JSON.stringify(rep.summary));
ok('有镜头生成失败时结论为 error（属交付级问题，不只是质量隐患）', rep.verdict === 'error', rep.verdict);
ok('失败镜头在报告里是 error 级并写明影响', rep.items.some((i) => i.checks.some((c) => c.id === 'failed-render' && c.level === 'error' && /成片会缺/.test(c.message))));
ok('期望口径记录镜头数/视频数/台词数', rep.expected.shots === 4 && rep.expected.clips === 3 && rep.expected.dialogueShots === 1, JSON.stringify(rep.expected));

console.log('\n【7】摘要与 Markdown 报告');
const sum = qcSummary(rep);
ok('摘要给出一句话结论与计数', /质检结论：/.test(sum) && /错误 \d+ · 告警 \d+/.test(sum), sum.split('\n')[0]);
ok('摘要列出非通过项（黑帧/静音/时长/失败镜头等）', /黑帧|时长|失败镜头|还没有视频/.test(sum), sum.split('\n').slice(1, 3).join(' | ').slice(0, 110));
const md = qcMarkdown(rep);
ok('Markdown 报告含结论表与检测方法说明', /# 成片质检报告/.test(md) && /\| 级别 \| 检查项 \|/.test(md) && /blackdetect/.test(md) && /ebur128/.test(md), `${md.split('\n').length} 行`);
ok('Markdown 里的黑帧告警可读', /⚠️ 告警 \| black \|/.test(md), (md.split('\n').find((l) => /black/.test(l)) || '').slice(0, 90));

console.log('\n【8】交付包内置质检报告');
const { buildDelivery } = await import('../src/deliver.js');
const built = await buildDelivery({ scriptId: 'SC-QC', code: 'S01E001', includeVideos: false });
const names = built.entries.map((e) => e.path);
ok('交付包含 qc/*.md 与 qc/*.json', names.includes('qc/S01E001_qc.md') && names.includes('qc/S01E001_qc.json'), names.filter((n) => n.startsWith('qc/')).join(', '));
ok('清单里单列质检结论（错误数/告警数 + 结论）',
   Array.isArray(built.manifest.qc) && built.manifest.qc[0].code === 'S01E001' && built.manifest.qc[0].verdict === 'error' && built.manifest.qc[0].error >= 1,
   JSON.stringify(built.manifest.qc));
ok('交付说明（README.txt）里带质检结论段', /质检结论：/.test(String(built.entries.find((e) => e.path === 'README.txt').data)));
ok('质检 md 内容写进包内（不是空文件）', String(built.entries.find((e) => e.path === 'qc/S01E001_qc.md').data).includes('成片质检报告'));

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
try {
  for (const f of [DB, DB + '-wal', DB + '-shm', CFG]) fs.rmSync(f, { force: true });
  fs.rmSync(DATA_TMP, { recursive: true, force: true });
} catch { /* ignore */ }
process.exit(fail ? 1 : 0);
