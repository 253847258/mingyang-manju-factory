// 出海物料测试：SRT 解析往返 / 多语言翻译（时间码与条数不变、缓存、失败回退）/ 发布元数据 / 封面截帧 / 交付包内置
// 全部离线：翻译用 provider=mock，LLM 不可用时验证规则兜底与「保留原文」告警。
// 用法：node tests/test-publish.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA_TMP = path.join(os.tmpdir(), `factory-publish-data-${Date.now()}`);
const DB = path.join(os.tmpdir(), `factory-publish-${Date.now()}.db`);
const CFG = path.join(os.tmpdir(), `factory-publish-config-${Date.now()}.json`);
process.env.FACTORY_DATA_DIR = DATA_TMP;
process.env.FACTORY_DB = DB;
process.env.FACTORY_CONFIG = CFG;
fs.mkdirSync(DATA_TMP, { recursive: true });
fs.writeFileSync(CFG, JSON.stringify({ llm: { provider: 'mock' }, image: { backend: 'placeholder' }, video: { backend: 'placeholder' }, tts: { backend: 'none' } }, null, 2));

const { migrate, run, get, all } = await import('../src/db.js');
const { saveConfig } = await import('../src/config.js');
const i18n = await import('../src/i18n.js');
const publish = await import('../src/publish.js');

migrate();

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? `  ${extra}` : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? `  ${extra}` : ''}`); }
};
const ff = (args) => spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8' });

const SRT = `1
00:00:01,000 --> 00:00:03,200
第一句台词

2
00:00:03,500 --> 00:00:05,000
第二句台词
带第二行

3
00:00:05,200 --> 00:00:07,000
第三句台词
`;

console.log('\n【1】SRT 解析与重建');
const cues = i18n.parseSRT(SRT);
ok('解析出 3 条并保留多行文本与毫秒', cues.length === 3 && cues[1].text.includes('\n') && cues[2].startMs === 5200, JSON.stringify(cues.map((c) => [c.startMs, c.endMs])));
ok('时间码解析正确（1.000s / 3.200s）', cues[0].startMs === 1000 && cues[0].endMs === 3200);
ok('重建后与原文一致（往返无损）', i18n.buildSRTFromCues(cues).trim() === SRT.trim());
ok('忽略无时间码的碎片块', i18n.parseSRT('随便一段文字\n\n1\n00:00:01,000 --> 00:00:02,000\n有效\n').length === 1);
ok('语言表含 8 种常用出海语言', i18n.LANGS.length === 8 && i18n.LANGS.map((l) => l.id).join(',') === 'en,ja,ko,es,pt,th,vi,id', i18n.LANGS.map((l) => l.name).join('、'));

console.log('\n【2】整份 SRT 翻译（mock：离线可跑）');
const t1 = await i18n.translateSRT({ srt: SRT, target: 'en', provider: 'mock', outKey: 'S01E001' });
ok('翻译成功且条数不变', t1.ok && t1.cues === 3 && i18n.parseSRT(t1.srt).length === 3);
ok('时间码逐条完全一致（不允许漂移）',
   JSON.stringify(i18n.parseSRT(t1.srt).map((c) => [c.startMs, c.endMs])) === JSON.stringify(cues.map((c) => [c.startMs, c.endMs])),
   JSON.stringify(i18n.parseSRT(t1.srt).map((c) => `${c.startMs}-${c.endMs}`)));
ok('译文确实变了（mock 前缀）', t1.srt.includes('[EN]') && !t1.srt.includes('[EN] 第三句') === false);
ok('多行文本保持多行', i18n.parseSRT(t1.srt)[1].text.split('\n').length === 2);
ok('落盘到 data/subtitles 下可读路径', fs.existsSync(path.join(DATA_TMP, 'subtitles', 'S01E001.en.srt')));
const t2 = await i18n.translateSRT({ srt: SRT, target: 'en', provider: 'mock', outKey: 'S01E001' });
ok('第二次命中缓存（不重复调用模型）', t2.cached === true && t2.calls === 0);
const t3 = await i18n.translateSRT({ srt: SRT, target: 'ja', provider: 'mock', outKey: 'S01E001' });
ok('换语言各自独立缓存', t3.cached === false && t3.srt.includes('[JA]') && t3.langName === '日语');
let langErr = '';
try { await i18n.translateSRT({ srt: SRT, target: 'xx', provider: 'mock' }); } catch (e) { langErr = e.message; }
ok('未知语言给出中文错误', /不支持的目标语言/.test(langErr), langErr);

console.log('\n【3】翻译失败与缺条回退（不能把片子搞坏）');
saveConfig({ llm: { provider: 'openai', baseUrl: 'http://127.0.0.1:9', apiKey: 'sk-x', model: 'x', timeoutMs: 2000 } });
const tFail = await i18n.translateSRT({ srt: SRT, target: 'en', provider: 'openai', useCache: false, outKey: 'fail' });
ok('模型不可用时保留原文并给告警（不抛异常）', tFail.ok && tFail.warnings.length >= 1 && i18n.parseSRT(tFail.srt)[0].text.includes('第一句台词'), tFail.warnings[0]?.slice(0, 70));
ok('失败时条数与时间码仍不变', i18n.parseSRT(tFail.srt).length === 3 && i18n.parseSRT(tFail.srt)[0].startMs === 1000);
saveConfig({ llm: { provider: 'mock' } });
const tMulti = await i18n.translateMulti({ srt: SRT, languages: ['en', 'xx', 'ja'], provider: 'mock', outKey: 'multi' });
ok('多语言批量：跳过未知语言并告警，其余照常', tMulti.results.length === 2 && tMulti.warnings.some((w) => /未知/.test(w)), tMulti.warnings.join('；'));

console.log('\n【4】造数据：1 集 3 镜 + 成片 + 关键帧');
const now = new Date().toISOString();
run(`INSERT INTO scripts(id,novel_id,title,format,style_id,episode_seconds,episodes_per_season,seasons,status,created_at,updated_at)
     VALUES('SC-PUB','N-PUB','出海测试剧','manju','cinematic-real',9,1,1,'storyboard',?,?)`, now, now);
run(`INSERT INTO script_episodes(id,script_id,season,episode,code,title,logline,hook,cliffhanger,duration,status,created_at,updated_at)
     VALUES('EP-PUB','SC-PUB',1,1,'S01E001','雾港夜归','怀表停在十点四十，旧案重启','雨夜中的一声枪响','真相指向二十年前',9,'storyboard',?,?)`, now, now);
const clips = [];
for (let i = 1; i <= 3; i++) {
  run(`INSERT INTO shots(id,script_id,episode_id,idx,scene_no,time_of_day,shot_size,camera,move,transition,duration,action,dialogue,mood,prompt_pos,prompt_neg,refs,cost_level,status,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?)`,
    `SH-PUB${i}`, 'SC-PUB', 'EP-PUB', i, '1', '夜晚', '中景', '平视', '固定', '切', 3,
    `第 ${i} 镜动作`, i === 1 ? '怀表停在十点四十。' : i === 2 ? '你来得太晚了。' : '', '紧张',
    `cinematic shot ${i}, harbor night`, 'blurry', '{}', 'L', now);
  const clip = path.join(DATA_TMP, `clip_${i}.mp4`);
  ff(['-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip]);
  clips.push(clip);
  const rel = path.relative(ROOT, clip).split(path.sep).join('/');
  run(`INSERT INTO shot_renders(id,script_id,episode_id,shot_id,kind,file_path,mime,width,height,duration,backend,status,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, `RD-PUB-V${i}`, 'SC-PUB', 'EP-PUB', `SH-PUB${i}`, 'video', rel, 'video/mp4', 640, 360, 3, 'placeholder', 'done', now);
}
const listFile = path.join(DATA_TMP, 'concat.txt');
fs.writeFileSync(listFile, clips.map((c) => `file '${c}'`).join('\n'));
const film = path.join(DATA_TMP, 'film.mp4');
ff(['-f', 'concat', '-safe', '0', '-i', listFile, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', film]);
run(`INSERT INTO episode_films(id,script_id,episode_id,code,file_path,duration,size,shot_count,backend,status,created_at)
     VALUES('FILM-PUB','SC-PUB','EP-PUB','S01E001',?,9,?,3,'ffmpeg','done',?)`, path.relative(ROOT, film).split(path.sep).join('/'), fs.statSync(film).size, now);

console.log('\n【5】封面截帧');
const cov = await publish.extractCover({ filmAbs: film, ratio: '9:16', at: 1, outName: 'test_cover.jpg' });
ok('按目标比例截出封面（9:16 → 1080x1920）', cov.ok && cov.width === 1080 && cov.height === 1920 && cov.bytes > 3000, `${cov.width}x${cov.height} ${(cov.bytes / 1024).toFixed(0)}KB`);
ok('封面是合法 JPEG（ffprobe 可读）', (() => {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=codec_name,width,height', '-of', 'json', cov.file], { encoding: 'utf8' });
  try { const j = JSON.parse(r.stdout); return j.streams?.[0]?.codec_name === 'mjpeg' && j.streams[0].width === 1080; } catch { return false; }
})());
const covMissing = await publish.extractCover({ filmAbs: path.join(DATA_TMP, 'nope.mp4') });
ok('成片缺失时返回中文错误（不抛异常）', covMissing.ok === false && /不存在/.test(covMissing.error), covMissing.error);

console.log('\n【6】发布物料整套生成');
saveConfig({ publish: { languages: ['en', 'ja'] }, llm: { provider: 'mock' } });
const kit = await publish.buildPublishKit({ scriptId: 'SC-PUB', code: 'S01E001', languages: ['en', 'ja'], provider: 'mock', generateMetadata: true });
ok('生成中文字幕 + 两种语言字幕', kit.subtitles.length === 2 && kit.files.some((f) => f.kind === 'subtitle-zh'), kit.subtitles.map((s) => s.target).join(','));
ok('多语言字幕条数与中文一致（不漏条）', kit.subtitles.every((s) => s.cues === 2), kit.subtitles.map((s) => `${s.target}:${s.cues}`).join(' '));
ok('封面生成成功（来自成片截帧）', kit.cover.ok && fs.existsSync(kit.cover.file), `${kit.cover.width}x${kit.cover.height} @${kit.cover.atSeconds}s`);
ok('元数据有标题备选/简介/话题/钩子', kit.metadata.titles.length >= 2 && kit.metadata.description.length > 10 && kit.metadata.tags.length >= 3, JSON.stringify({ t: kit.metadata.titles.length, tags: kit.metadata.tags }));
ok('元数据来源可追溯（llm 或规则兜底）', ['llm', 'fallback', 'rule'].includes(kit.metadata.source), kit.metadata.source + (kit.metadata.reason ? `（${kit.metadata.reason.slice(0, 40)}）` : ''));
ok('落盘到 data/publish/<集号>/ 下', kit.dir.includes(path.join('publish', 'S01E001')) && kit.files.every((f) => fs.existsSync(f.file)));
ok('元数据 Markdown 含标题/简介/话题/字幕表', (() => {
  const md = fs.readFileSync(kit.files.find((f) => f.kind === 'metadata-md').file, 'utf8');
  return /## 标题备选/.test(md) && /## 简介/.test(md) && /## 话题标签/.test(md) && /多语言字幕/.test(md) && /## 封面/.test(md);
})());
const kitNoLang = await publish.buildPublishKit({ scriptId: 'SC-PUB', code: 'S01E001', languages: [], generateMetadata: false });
ok('不选语言时只出中文物料（不调用翻译）', kitNoLang.subtitles.length === 0 && kitNoLang.metadata.source === 'rule');
ok('关掉元数据生成时走规则兜底', kitNoLang.metadata.titles.length >= 1 && kitNoLang.metadata.tags.length >= 1, JSON.stringify(kitNoLang.metadata.titles).slice(0, 80));

console.log('\n【6b】无台词剧集：跳过多语言字幕并说明');
run(`INSERT INTO script_episodes(id,script_id,season,episode,code,title,duration,status,created_at,updated_at)
     VALUES('EP-PUB2','SC-PUB',1,2,'S01E002','无台词集',3,'storyboard',?,?)`, now, now);
run(`INSERT INTO shots(id,script_id,episode_id,idx,scene_no,shot_size,camera,move,transition,duration,action,dialogue,prompt_pos,prompt_neg,refs,cost_level,status,created_at)
     VALUES('SH-PUB2-1','SC-PUB','EP-PUB2',1,'1','远景','平视','固定','切',3,'纯空镜，无台词','','p','n','{}','L','draft',?)`, now);
const clip2 = path.join(DATA_TMP, 'clip_no_dialog.mp4');
ff(['-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip2]);
run(`INSERT INTO shot_renders(id,script_id,episode_id,shot_id,kind,file_path,mime,width,height,duration,backend,status,created_at)
     VALUES('RD-PUB-N1','SC-PUB','EP-PUB2','SH-PUB2-1','video',?,?,640,360,3,'placeholder','done',?)`,
  path.relative(ROOT, clip2).split(path.sep).join('/'), 'video/mp4', now);
const noDialog = await publish.buildPublishKit({ scriptId: 'SC-PUB', code: 'S01E002', languages: ['en'], provider: 'mock', generateMetadata: false });
ok('无台词时给出「无字幕可翻译」说明（而不是静默跳过）',
   noDialog.warnings.some((w) => /没有台词/.test(w)) && noDialog.subtitles.length === 0,
   noDialog.warnings.join('；') || '(无告警)');

console.log('\n【7】交付包内置发布物料');
const { buildDelivery } = await import('../src/deliver.js');
const built = await buildDelivery({ scriptId: 'SC-PUB', code: 'S01E001', includeVideos: false, includeQc: false });
const names = built.entries.map((e) => e.path);
ok('交付包含 publish/ 目录（元数据 + 封面 + 中文字幕）',
   names.some((n) => /publish\/.*_publish\.md/.test(n)) && names.some((n) => /publish\/.*_cover\.jpg/.test(n)) && names.some((n) => /publish\/S01E001\.zh\.srt/.test(n)),
   names.filter((n) => n.startsWith('publish/')).join(', '));
ok('配置了语言时交付包含多语言字幕', names.some((n) => /publish\/S01E001\.en\.srt/.test(n)) && names.some((n) => /publish\/S01E001\.ja\.srt/.test(n)));
ok('清单里汇总发布物料（语言/封面/元数据来源）', Array.isArray(built.manifest.publish) && built.manifest.publish[0].languages.length === 2 && built.manifest.publish[0].cover === true, JSON.stringify(built.manifest.publish));

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
try {
  for (const f of [DB, DB + '-wal', DB + '-shm', CFG]) fs.rmSync(f, { force: true });
  fs.rmSync(DATA_TMP, { recursive: true, force: true });
} catch { /* ignore */ }
process.exit(fail ? 1 : 0);
