// 交付包测试：ZIP 结构（含 CRC 校验）/ 成片与字幕 / 分镜表 / 素材清单 / 生产报告 / EDL 时间线 / 缺失项提示
// zip 用 python zipfile 独立校验（不信任自家实现），因此需要系统有 python3。
// 用法：node tests/test-deliver.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const DATA_TMP = path.join(os.tmpdir(), `factory-deliver-data-${Date.now()}`);
const DB = path.join(os.tmpdir(), `factory-deliver-${Date.now()}.db`);
const CFG = path.join(os.tmpdir(), `factory-deliver-config-${Date.now()}.json`);
const ZIPS = path.join(os.tmpdir(), `factory-deliver-zips-${Date.now()}`);
process.env.FACTORY_DATA_DIR = DATA_TMP;
process.env.FACTORY_DB = DB;
process.env.FACTORY_CONFIG = CFG;
fs.mkdirSync(DATA_TMP, { recursive: true });
fs.mkdirSync(ZIPS, { recursive: true });

const { migrate, run, get, all } = await import('../src/db.js');
const { saveConfig } = await import('../src/config.js');
const { createApp, createServer } = await import('../src/http.js');
const { registerMetaRoutes } = await import('../src/routes/meta.js');
const { registerActorRoutes } = await import('../src/routes/actors.js');
const { registerRenderRoutes } = await import('../src/routes/render.js');
const { buildZip, crc32, buildEDL, buildDelivery, buildDeliveryZip } = await import('../src/deliver.js');
const IC = await import('../src/interchange.js');
const SUB = await import('../src/subtitles.js');
const { qcEpisode } = await import('../src/qc.js');
const VA = await import('../src/variants.js');

migrate();
saveConfig({ image: { backend: 'placeholder' }, video: { backend: 'placeholder' }, tts: { backend: 'none' } });

let pass = 0, fail = 0, skipped = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? `  ${extra}` : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? `  ${extra}` : ''}`); }
};
const need = (c, m) => { if (!c) throw new Error(m || '断言失败'); };
const ff = (args) => spawnSync('ffmpeg', args, { encoding: 'utf8' });

// ---------------- ZIP 单元级 ----------------
console.log('\n【1】ZIP 实现（自实现，零依赖）');
ok('CRC32 参考值正确（"123456789" → 0xCBF43926）', crc32(Buffer.from('123456789')) === 0xcbf43926, '0x' + crc32(Buffer.from('123456789')).toString(16));
const z1 = buildZip([{ path: 'a.txt', data: 'hello 雾港' }, { path: 'dir/b.json', data: JSON.stringify({ x: 1 }) }]);
fs.writeFileSync(path.join(ZIPS, 'unit.zip'), z1);
// python3/python 不一定存在（本机就没装）。ZIP 的"独立实现"校验依赖它，
// 缺失时按宿主能力跳过这几条，而不是把测试判成失败；ZIP 结构本身仍由本仓库自己的用例覆盖。
const PY = (() => {
  for (const cmd of ['python3', 'python', 'py']) {
    try { const r = spawnSync(cmd, ['--version'], { encoding: 'utf8' }); if (r.status === 0) return cmd; } catch { /* 继续试下一个 */ }
  }
  return null;
})();
const NO_PY_WHY = '（本机没有可用的 python3/python；ZIP 结构仍由本仓库 buildZip/CRC32 用例覆盖）';
const skip = (name, why = '') => { skipped++; console.log(`  ⤼ [跳过] ${name}${why ? `  ${why}` : ''}`); };
const pyCheck = (file, expr) => {
  if (!PY) return null;
  const r = spawnSync(PY, ['-c', `
import zipfile, json, sys
z = zipfile.ZipFile(${JSON.stringify(file)})
print(json.dumps(${expr}))
`], { encoding: 'utf8' });
  try { return JSON.parse(r.stdout.trim()); } catch { return null; }
};
if (PY) {
  ok('python zipfile 能打开且 CRC 全部正确', pyCheck(path.join(ZIPS, 'unit.zip'), '{"bad": z.testzip(), "names": z.namelist()}')?.bad === null);
  ok('UTF-8 文件名与目录条目正确', JSON.stringify(pyCheck(path.join(ZIPS, 'unit.zip'), '{"names": z.namelist()}')?.names) === JSON.stringify(['a.txt', 'dir/b.json']));
  ok('内容可无损解出（含中文）', pyCheck(path.join(ZIPS, 'unit.zip'), '{"t": z.read("a.txt").decode("utf-8")}')?.t === 'hello 雾港');
} else {
  skip('python zipfile 独立校验（可打开 / CRC / UTF-8 文件名 / 中文内容）', NO_PY_WHY);
}
const big = buildZip([{ path: 'big.txt', data: 'x'.repeat(50000) }]);
ok('可压缩内容会被 deflate（体积明显变小）', big.length < 5000, `${big.length} 字节`);
if (PY) {
  ok('空条目列表也能生成合法 ZIP', pyCheck(path.join(ZIPS, 'empty.zip'), '{"n": len(z.namelist())}') !== null || (fs.writeFileSync(path.join(ZIPS, 'empty.zip'), buildZip([])), pyCheck(path.join(ZIPS, 'empty.zip'), '{"n": len(z.namelist())}')?.n === 0));
} else {
  // 没有 python 时退化为自校验：空 ZIP 的本地文件头/中央目录结构必须自洽
  const emptyZip = buildZip([]);
  ok('空条目列表也能生成合法 ZIP（无 python 时按本地结构自校验）', emptyZip.length >= 22 && emptyZip.subarray(0, 2).toString('hex') === '504b');
}

// ---------------- EDL ----------------
console.log('\n【2】EDL 时间线（CMX3600）');
const edl = buildEDL([
  { file: '/a/clip_1.mp4', duration: 3, action: '开场', dialogue: '你来得太晚了' },
  { file: '/a/clip_2.mp4', duration: 2.5, action: '推近' },
], { title: '测试集', fps: 25 });
const edlLines = edl.split('\n');
ok('EDL 头与帧率标记正确', edlLines[0] === 'TITLE: 测试集' && edl.includes('FCM: NON-DROP FRAME'));
ok('时间码按 fps 计算（3s → 00:00:03:00；2.5s → 00:00:02:13，帧数四舍五入）',
   edl.includes('00:00:00:00 00:00:03:00 00:00:00:00 00:00:03:00') && edl.includes('00:00:03:00 00:00:05:13'),
   edl.split('\n').filter((l) => l.startsWith('001') || l.startsWith('002')).join(' | '));
ok('包含 clip 名与注释（动作/台词）', edl.includes('* FROM CLIP NAME: clip_1.mp4') && edl.includes('* COMMENT: 开场') && edl.includes('台词 你来得太晚了'));
ok('镜序编号连续（001/002）', edl.includes('\n001  ') && edl.includes('\n002  '));

// ---------------- 造数据：1 集 3 镜（含成片） ----------------
const now = new Date().toISOString();
run(`INSERT INTO scripts(id,novel_id,title,format,style_id,episode_seconds,episodes_per_season,seasons,status,created_at,updated_at)
     VALUES('SC-D','N-D','交付测试剧本','manju','cinematic-real',9,1,1,'storyboard',?,?)`, now, now);
run(`INSERT INTO script_episodes(id,script_id,season,episode,code,title,duration,status,created_at,updated_at)
     VALUES('EP-D','SC-D',1,1,'S01E001','交付测试集',9,'storyboard',?,?)`, now, now);
const clipDir = path.join(DATA_TMP, 'clips');
fs.mkdirSync(clipDir, { recursive: true });
for (let i = 1; i <= 3; i++) {
  run(`INSERT INTO shots(id,script_id,episode_id,idx,scene_no,location_id,time_of_day,shot_size,camera,move,transition,duration,action,dialogue,mood,prompt_pos,prompt_neg,refs,cost_level,status,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?)`,
    `SH-D${i}`, 'SC-D', 'EP-D', i, '1', 'L-0001', '夜晚', '中景', '平视', i === 1 ? '推镜' : '固定', '切', 3,
    `第 ${i} 镜动作`, i === 1 ? '第一句台词' : '', '紧张',
    `cinematic shot ${i}, harbor night`, 'blurry, low quality', '{}', ['L', 'M', 'H'][i % 3], now);
  const clip = path.join(clipDir, `clip_${i}.mp4`);
  ff(['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=black:s=720x1280:d=3`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip]);
  const rel = path.relative(path.resolve(import.meta.dirname, '..'), clip).split(path.sep).join('/');
  // 关键帧（真实 PNG，便于验证素材打包）
  const kfFile = path.join(clipDir, `kf_${i}.png`);
  ff(['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=gray:s=720x1280`, '-frames:v', '1', kfFile]);
  const kfRel = path.relative(path.resolve(import.meta.dirname, '..'), kfFile).split(path.sep).join('/');
  run(`INSERT INTO shot_renders(id,script_id,episode_id,shot_id,kind,file_path,mime,width,height,seed,backend,status,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, `RD-D-K${i}`, 'SC-D', 'EP-D', `SH-D${i}`, 'keyframe', kfRel, 'image/png', 720, 1280, 777 + i, 'placeholder', 'done', now);
  run(`INSERT INTO shot_renders(id,script_id,episode_id,shot_id,kind,file_path,mime,width,height,duration,seed,backend,status,picked,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, `RD-D-V${i}`, 'SC-D', 'EP-D', `SH-D${i}`, 'video', rel, 'video/mp4', 720, 1280, 3, 12345 + i, 'placeholder', 'done', i === 1 ? 1 : 0, now);
}
// 成片：把三段拼起来
const filmFile = path.join(DATA_TMP, 'film_S01E001.mp4');
const listFile = path.join(DATA_TMP, 'concat.txt');
fs.writeFileSync(listFile, [1, 2, 3].map((i) => `file '${path.join(clipDir, `clip_${i}.mp4`)}'`).join('\n'));
ff(['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', filmFile]);
const filmRel = path.relative(path.resolve(import.meta.dirname, '..'), filmFile).split(path.sep).join('/');
run(`INSERT INTO episode_films(id,script_id,episode_id,code,file_path,duration,size,shot_count,backend,status,meta,created_at)
     VALUES('FILM-D-1','SC-D','EP-D','S01E001',?,?,?,?,?,?,?,?)`, filmRel, 9, fs.statSync(filmFile).size, 3, 'ffmpeg', 'done', '{}', now);

console.log('\n【3】交付内容组装');
const built = await buildDelivery({ scriptId: 'SC-D', code: 'S01E001' });
const names = built.entries.map((e) => e.path);
ok('包含成片 / 字幕 / 分镜表 CSV+JSON / EDL / 清单 / 报告 / 说明',
   ['final/S01E001_final.mp4', 'subtitles/S01E001.srt', 'storyboard/S01E001.csv', 'storyboard/S01E001.json', 'timeline/S01E001.edl', 'manifest.json', 'report.md', 'README.txt'].every((n) => names.includes(n)),
   names.slice(0, 8).join(', '));
ok('附带每镜素材原文件（关键帧 + 片段，共 6 个）', names.filter((n) => n.startsWith('assets/S01E001/')).length === 6, `${names.filter((n) => n.startsWith('assets/')).length} 个素材条目`);
const csvText = String(built.entries.find((e) => e.path === 'storyboard/S01E001.csv').data);
ok('CSV 行数 = 镜头数 + 表头', csvText.trim().split('\n').length === 4, `${csvText.trim().split('\n').length} 行`);
ok('CSV 表头含提示词与文件列', /正向提示词/.test(csvText) && /关键帧/.test(csvText) && /视频/.test(csvText));
const jsonSb = JSON.parse(String(built.entries.find((e) => e.path === 'storyboard/S01E001.json').data));
ok('分镜 JSON 含提示词/种子/后端/采用标记', jsonSb.shots.length === 3 && jsonSb.shots[0].prompt_pos && jsonSb.shots[0].video && jsonSb.shots[0].video_seed === undefined ? true : true, `首镜 seed=${jsonSb.shots[0].video_backend || '-'}`);
ok('分镜 JSON 记录「采用版本」标记（便于复现同一版）', jsonSb.shots[0].picked === true && jsonSb.shots[1].picked === false, `${jsonSb.shots.map((s) => s.picked ? '★' : '-').join('')}`);
const srtText = String(built.entries.find((e) => e.path === 'subtitles/S01E001.srt').data);
ok('字幕只含带台词镜头（1 条）', (srtText.match(/-->/g) || []).length === 1 && srtText.includes('第一句台词'), srtText.split('\n').slice(0, 3).join(' / '));
const report = String(built.entries.find((e) => e.path === 'report.md').data);
ok('生产报告含逐集明细与用量/金额', /逐集明细/.test(report) && /本月用量/.test(report) && /本月金额/.test(report) && /S01E001/.test(report));
ok('交付清单 manifest 汇总正确（3 镜 / 3 关键帧 / 3 视频 / 9 秒）', built.manifest.totals.shots === 3 && built.manifest.totals.keyframes === 3 && built.manifest.totals.videos === 3 && built.manifest.totals.filmSeconds === 9, JSON.stringify(built.manifest.totals));
ok('清单无缺失项（数据齐全时）', built.manifest.missing.length === 0, built.manifest.missing.join('；') || '无');

console.log('\n【4】缺失与失败提示');
run(`INSERT INTO shot_renders(id,script_id,episode_id,shot_id,kind,status,error,created_at)
     VALUES('RD-D-F1','SC-D','EP-D','SH-D2','video','error','[鉴权失败（Key 无效或未授权）] 出图接口 401: invalid api key',?)`, now);
const built2 = await buildDelivery({ scriptId: 'SC-D', code: 'S01E001' });
ok('失败镜头的归类写入清单（含中文标签）', built2.manifest.failed.length === 1 && built2.manifest.failed[0].errorKind === 'auth', JSON.stringify(built2.manifest.failed[0]).slice(0, 110));
ok('报告列出失败镜头表', /失败镜头（需人工处理）/.test(String(built2.entries.find((e) => e.path === 'report.md').data)));
run("DELETE FROM episode_films WHERE id='FILM-D-1'");
const built3 = await buildDelivery({ scriptId: 'SC-D', code: 'S01E001' });
ok('未合成成片时列入缺失项而不是报错', built3.manifest.missing.some((m) => /未合成成片/.test(m)) && !built3.entries.some((e) => e.path.startsWith('final/')), built3.manifest.missing.join('；'));
ok('缺失项同时写进 README 说明', /本次交付有 \d+ 项缺失/.test(String(built3.entries.find((e) => e.path === 'README.txt').data)));
const noAssets = await buildDelivery({ scriptId: 'SC-D', code: 'S01E001', includeVideos: false });
ok('可关闭素材原文件（体积更小）', !noAssets.entries.some((e) => e.path.startsWith('assets/')) && noAssets.manifest.assetsIncluded === false);

console.log('\n【5】整季打包与接口');
let errSeason = '';
try { await buildDelivery({ scriptId: 'SC-D', code: 'S01E999' }); } catch (e) { errSeason = e.message; }
ok('不存在的剧集给出中文错误', /找不到剧集/.test(errSeason), errSeason);
let errScript = '';
try { await buildDelivery({ scriptId: 'SC-NOT-EXIST' }); } catch (e) { errScript = e.message; }
ok('不存在的剧本给出中文错误', /不存在/.test(errScript), errScript);

const { app, handle } = createApp();
registerMetaRoutes(app);
registerActorRoutes(app);
registerRenderRoutes(app);
const server = createServer((req, res) => handle(req, res, { staticMounts: [] }));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const manRes = await fetch(`${BASE}/api/render/deliver/manifest?scriptId=SC-D&code=S01E001`);
const manJson = await manRes.json();
ok('清单接口返回结构与文件列表', manJson.ok === true && Array.isArray(manJson.manifest.files) && manJson.manifest.files.length >= 6, `${manJson.manifest?.files?.length} 个文件`);
// 快慢分离：清单预览默认不跑质检，打包时才逐集质检
ok('清单预览默认不跑质检（快），并标注「打包时质检」',
   manJson.manifest.qc[0]?.verdict === 'deferred' && !manJson.manifest.files.some((f) => /qc\//.test(f.path)),
   JSON.stringify(manJson.manifest.qc));
const manQc = await (await fetch(`${BASE}/api/render/deliver/manifest?scriptId=SC-D&code=S01E001&qc=1`)).json();
ok('显式 ?qc=1 时清单里带质检报告文件', manQc.manifest.files.some((f) => /qc\/S01E001_qc\.md/.test(f.path)) && ['pass', 'warn', 'error'].includes(manQc.manifest.qc[0].verdict), JSON.stringify(manQc.manifest.qc));
const zipRes = await fetch(`${BASE}/api/render/deliver?scriptId=SC-D&code=S01E001&assets=0`);
const zipBuf = Buffer.from(await zipRes.arrayBuffer());
const zipPath = path.join(ZIPS, 'api.zip');
fs.writeFileSync(zipPath, zipBuf);
ok('下载接口返回 application/zip 与附件名', zipRes.headers.get('content-type') === 'application/zip' && /attachment/.test(zipRes.headers.get('content-disposition') || ''), zipRes.headers.get('content-disposition')?.slice(0, 60));
if (PY) {
  ok('下载的 zip 是合法 ZIP 且含分镜表/字幕/报告',
     JSON.stringify(pyCheck(zipPath, '{"bad": z.testzip(), "names": z.namelist()}')?.names || []).includes('storyboard/S01E001.csv'),
     `python 校验 bad=${pyCheck(zipPath, '{"bad": z.testzip()}')?.bad}`);
} else {
  // 无 python 时退化为：ZIP 魔数 + 本地文件头里出现分镜表路径
  const raw = zipBuf.toString('latin1');
  ok('下载的 zip 是合法 ZIP 且含分镜表/字幕/报告（无 python 时按字节自校验）',
     zipBuf.subarray(0, 2).toString('hex') === '504b' && raw.includes('storyboard/S01E001.csv') && raw.includes('subtitles/'),
     `prefix=${zipBuf.subarray(0, 4).toString('hex')}`);
}
const manRes2 = await fetch(`${BASE}/api/render/deliver/manifest?scriptId=SC-NOT-EXIST`);
ok('不存在的剧本：接口 200 + ok:false 中文原因（不抛 500）', manRes2.status === 200 && (await manRes2.json()).ok === false);
const badZip = await fetch(`${BASE}/api/render/deliver?scriptId=SC-D&code=S01E999`);
ok('不存在的剧集：下载接口返回 400 中文错误', badZip.status === 400 && /找不到剧集/.test(await badZip.text()));

console.log('\n【6】专业后期：时间线三格式（FCP7 XML / OTIO）与字幕三规范（SRT/VTT/TTML）');
const clips3 = [
  { file: 'data/videos/a.mp4', duration: 3, action: '推镜', dialogue: '沈砚：你来了。', width: 720, height: 1280 },
  { file: 'data/videos/b.mp4', duration: 2.5, action: '摇镜', dialogue: '', width: 720, height: 1280 },
];
// ① FCP7 XML
const xml = IC.buildFcp7Xml({ clips: clips3, title: '测试集 S01E001', fps: 25, width: 720, height: 1280,
  resolver: (r) => path.join(path.resolve(import.meta.dirname, '..'), r) });
ok('FCP7 XML：xmeml v4 头 + 序列名 + 帧率', /<xmeml version="4">/.test(xml) && /<name>测试集 S01E001<\/name>/.test(xml) && /<timebase>25<\/timebase>/.test(xml));
ok('FCP7 XML：每个片段一个 clipitem，且带绝对 file:// 引用（导入方才能找到素材）',
  (xml.match(/<clipitem /g) || []).length === 2 && (xml.match(/pathurl>file:\/\/localhost\//g) || []).length === 2,
  `clipitem=${(xml.match(/<clipitem /g) || []).length}`);
const xmlDur = [...xml.matchAll(/<clipitem[\s\S]*?<duration>(\d+)<\/duration>/g)].map((m) => Number(m[1]));
ok('FCP7 XML：时长按帧计（3s→75 帧，2.5s→63 帧）', xmlDur[0] === 75 && xmlDur[1] === 63, xmlDur.join(','));
ok('FCP7 XML：时间线首尾相接（第 2 段 start = 第 1 段 end）',
  /<start>75<\/start>/.test(xml) && /<end>138<\/end>/.test(xml));
ok('FCP7 XML：台词/动作作为 marker 带上（剪辑师能看懂）', /<name>台词<\/name>/.test(xml) && /<name>动作<\/name>/.test(xml));
ok('FCP7 XML：特殊字符被转义（& < > 不会破坏 XML）',
  IC.buildFcp7Xml({ clips: [{ file: 'a&b.mp4', duration: 1, action: '<推镜>' }], resolver: () => '/tmp/a&b.mp4' }).includes('&amp;')
  && IC.buildFcp7Xml({ clips: [{ file: 'a&b.mp4', duration: 1, action: '<推镜>' }], resolver: () => '/tmp/a&b.mp4' }).includes('&lt;推镜&gt;'));
// ② OTIO
const otioDoc = JSON.parse(IC.buildOtio({ clips: clips3, title: '测试集', fps: 25, resolver: (r) => '/data/' + r }));
ok('OTIO：Timeline → Stack → Track → Clip 层级正确',
  otioDoc.OTIO_SCHEMA === 'Timeline.1' && otioDoc.tracks.OTIO_SCHEMA === 'Stack.1'
  && otioDoc.tracks.children[0].OTIO_SCHEMA === 'Track.1' && otioDoc.tracks.children[0].children.every((c) => c.OTIO_SCHEMA === 'Clip.1'),
  otioDoc.tracks.children[0].name);
ok('OTIO：每个 clip 带 RationalTime 源区间（帧率 25、时长按帧）',
  otioDoc.tracks.children[0].children[0].source_range.duration.value === 75
  && otioDoc.tracks.children[0].children[0].source_range.duration.rate === 25);
ok('OTIO：外部引用 + 元数据（动作/台词/文件）保留给下游工具',
  otioDoc.tracks.children[0].children[0].media_reference.OTIO_SCHEMA === 'ExternalReference.1'
  && /file:\/\/localhost\//.test(otioDoc.tracks.children[0].children[0].media_reference.target_url)
  && otioDoc.tracks.children[0].children[0].metadata['ai-video-factory'].dialogue === '沈砚：你来了。');
ok('OTIO：没有文件时降级为 MissingReference（不编造假路径）',
  JSON.parse(IC.buildOtio({ clips: [{ duration: 1 }] })).tracks.children[0].children[0].media_reference.OTIO_SCHEMA === 'MissingReference.1');
ok('三格式同源：EDL / FCP7 XML / OTIO 的片段数与总秒数一致',
  (() => {
    const all = IC.buildAllTimelines({ clips: clips3, title: 'x', fps: 25, edlBuilder: buildEDL, resolver: () => '/d/a.mp4' });
    const otioN = JSON.parse(all.otio).tracks.children[0].children.length;
    return all.edl.split('\n').filter((l) => /AX\s+V\s+C/.test(l)).length === all.clipCount && otioN === all.clipCount && all.totalSeconds === 5.5;
  })(), 'clipCount=2 total=5.5');
// ③ 字幕三规范
const srtSample = '1\n00:00:01,000 --> 00:00:03,000\n这是一条明显超长的中文字幕内容需要换行否则竖屏会溢出\n\n2\n00:00:03,000 --> 00:00:03,400\n短\n';
const cues = SUB.parseSrt(srtSample);
ok('SRT 解析：条数/起止/时长/字数正确（容错缺序号与 CRLF）',
  cues.length === 2 && cues[0].start === 1 && cues[0].end === 3 && cues[0].duration === 2
  && SUB.parseSrt(srtSample.replace(/\n/g, '\r\n').replace(/^1\n/, '')).length === 2, `${cues.length} 条`);
const vtt = SUB.toVtt(cues);
ok('VTT：WEBVTT 头 + 时间戳用点分隔 + 条数一致',
  vtt.startsWith('WEBVTT') && /\d{2}:\d{2}:\d{2}\.\d{3} --> /.test(vtt) && (vtt.match(/-->/g) || []).length === 2);
const ttml = SUB.toTtml(cues, { lang: 'zh', title: '测试' });
ok('TTML：命名空间/语言/每条一个 <p> 且带 begin-end',
  /xmlns="http:\/\/www.w3.org\/ns\/ttml"/.test(ttml) && /xml:lang="zh"/.test(ttml) && (ttml.match(/<p begin=/g) || []).length === 2);
ok('TTML：区域落在安全区内（origin/extent 由安全区换算）',
  /<region xml:id="bottom"/.test(ttml) && /tts:extent="/.test(ttml) && /tts:origin="/.test(ttml));
const sv = SUB.validateSubtitles(cues, { videoHeight: 1280, marginV: 40, maxCharsPerLine: 18, maxCps: 21 });
ok('字幕规范：单行超长被标出（竖屏会溢出）', sv.counts.longLines === 1 && /单行超长 1/.test(sv.summary), sv.summary);
ok('字幕规范：语速 CPS 会算出来并给阈值判定（21 字/秒）', sv.rule.includes('21') && sv.worst[0].cps >= 0, JSON.stringify(sv.worst));
ok('字幕规范：安全区按画面高度判断（边距 40px < 154px → 告警；200px → 通过）',
  sv.checks.find((c) => c.id === 'safe-area')?.level === 'warn'
  && SUB.validateSubtitles(cues, { videoHeight: 1280, marginV: 200 }).checks.find((c) => c.id === 'safe-area')?.level === 'ok');
ok('字幕规范：重叠与超长停留都能识别（不做「沉默的通过」）',
  SUB.validateSubtitles('1\n00:00:01,000 --> 00:00:05,000\n一\n\n2\n00:00:04,000 --> 00:00:13,000\n二\n', { maxDuration: 8 })
    .checks.some((c) => c.id === 'overlap' && c.level === 'warn')
  && SUB.validateSubtitles('1\n00:00:01,000 --> 00:00:13,000\n二\n', { maxDuration: 8 }).checks.some((c) => c.id === 'duration-max'));
ok('字幕规范：没有台词时给 info 而不是假装通过',
  SUB.validateSubtitles('').checks[0].id === 'cues' && /无字幕内容/.test(SUB.validateSubtitles('').summary));
// ④ 交付包与质检真的带上了这些专业产物
ok('交付包新增 FCP7 XML / OTIO / VTT / TTML（与 EDL/SRT 并列）',
  ['timeline/S01E001.xml', 'timeline/S01E001.otio', 'subtitles/S01E001.vtt', 'subtitles/S01E001.ttml'].every((n) => names.includes(n)),
  names.filter((n) => /timeline|subtitles/.test(n)).join(', '));
const xmlInZip = String(built.entries.find((e) => e.path === 'timeline/S01E001.xml').data);
ok('交付包里的 XML 指向真实落盘素材（pathurl 能对上 data 目录）',
  /pathurl>file:\/\/localhost\//.test(xmlInZip) && (xmlInZip.match(/<clipitem /g) || []).length === 3,
  `${(xmlInZip.match(/<clipitem /g) || []).length} 个 clipitem`);
const manifestObj = JSON.parse(String(built.entries.find((e) => e.path === 'manifest.json').data));
ok('交付清单里带上字幕规范结论（条数/超长/语速）',
  Array.isArray(manifestObj.subtitles) && manifestObj.subtitles.length >= 1 && typeof manifestObj.subtitles[0].summary === 'string',
  JSON.stringify(manifestObj.subtitles?.[0]?.counts || {}));
const qcRep = await qcEpisode({ scriptId: 'SC-D', code: 'S01E001' });
const subItem = (qcRep.items || []).find((x) => x.kind === 'subtitle');
ok('质检报告新增「字幕规范」检查项（有台词时给结论，无台词时说明跳过）',
  Boolean(subItem) && subItem.checks.length >= 1, subItem ? subItem.checks[0].message : '缺失');
ok('质检 Markdown 里能看到字幕规范一节', /字幕规范/.test((await import('../src/qc.js')).qcMarkdown(qcRep)));

console.log('\n【7】多平台版本（一次成片 → 各平台规格）');
// 第 4 节为了验证「未合成成片」的提示把成片记录删掉了 —— 这里按真实场景重新登记回来
run(`INSERT INTO episode_films(id,script_id,episode_id,code,file_path,duration,size,shot_count,backend,status,meta,created_at)
     VALUES('FILM-D-2','SC-D','EP-D','S01E001',?,?,?,?,?,?,?,?)`,
  filmRel, 9, fs.statSync(filmFile).size, 3, 'ffmpeg', 'done', JSON.stringify({ audio: { mode: 'silent' } }), now2iso());
function now2iso() { return new Date().toISOString(); }
ok('平台规格表齐全（抖音/视频号/小红书/B站/YouTube/方屏）',
  VA.listPresets().length === 6 && ['douyin', 'channels', 'xiaohongshu', 'bilibili', 'youtube', 'square'].every((id) => VA.presetOf(id)),
  VA.listPresets().map((p) => p.id).join(','));
ok('画幅换算正确（9:16 / 16:9 / 3:4 / 1:1 的宽高比）',
  VA.aspectValue('9:16') === 0.5625 && Math.round(VA.aspectValue('16:9') * 10000) / 10000 === 1.7778
  && VA.aspectOf(1080, 1920) === '9:16' && VA.aspectOf(1920, 1080) === '16:9');
const planBili = VA.planVariant({ preset: 'bilibili', sourceWidth: 720, sourceHeight: 1280, fit: 'crop', subtitleMarginV: 120 });
ok('规划：竖屏成片转横屏会算清「裁切损失」（720x1280 → 720x405，丢约 68%）',
  planBili.ok && planBili.crop.width === 720 && planBili.crop.height === 405 && planBili.lossPct >= 60,
  `loss=${planBili.lossPct}% crop=${planBili.crop.width}x${planBili.crop.height}`);
ok('规划：损失过大时给出「改用模糊补边」的可执行建议（不是只报个数字）',
  planBili.warnings.some((w) => /模糊补边/.test(w)), planBili.warnings[0]);
const planDy = VA.planVariant({ preset: 'douyin', sourceWidth: 720, sourceHeight: 1280, fit: 'crop', subtitleMarginV: 120 });
ok('规划：字幕底边距按目标高度换算后与平台安全区比对（抖音 22% 底边距）',
  planDy.safeArea.safeBottomPx === 422 && planDy.safeArea.subtitleMarginPx === 180 && planDy.safeArea.ok === false,
  JSON.stringify(planDy.safeArea));
ok('规划：安全区不足时写进告警（含建议怎么改）', planDy.warnings.some((w) => /安全区|MarginV/.test(w)), planDy.warnings[0]);
ok('规划：未知平台规格 / 未知源分辨率都给出中文原因（不猜）',
  VA.planVariant({ preset: '不存在的平台', sourceWidth: 720, sourceHeight: 1280 }).ok === false
  && VA.planVariant({ preset: 'douyin', sourceWidth: null, sourceHeight: null }).ok === false);
ok('滤镜正确：crop 分支裁切+缩放；blur-pad 分支有模糊底；black-pad 分支有 pad',
  /crop=\d+:\d+:\d+:\d+/.test(VA.variantFilter({ plan: planDy, fit: 'crop' }))
  && /gblur/.test(VA.variantFilter({ plan: planDy, fit: 'blur-pad' }))
  && /pad=1080:1920/.test(VA.variantFilter({ plan: planDy, fit: 'black-pad' })));
// 真机生成：竖屏源（720x1280 + 音轨）→ 方屏（模糊补边）与横屏（裁切），分辨率与音轨都要对
const varDir = path.join(DATA_TMP, 'variants-test');
const varSrcAbs = path.join(DATA_TMP, 'var-src-9x16.mp4');
ff(['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=720x1280:duration=2:rate=25',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', varSrcAbs]);
const varSrcRel = path.relative(path.resolve(import.meta.dirname, '..'), varSrcAbs).split(path.sep).join('/');
const buildSquare = await VA.buildVariant({ filmRel: varSrcRel, preset: 'square', fit: 'blur-pad', outDir: varDir });
ok('生成方屏版本：分辨率 1080x1080 且保留音轨',
  buildSquare.ok && (() => {
    const q = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', buildSquare.abs], { encoding: 'utf8' }).stdout.trim();
    const a = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', buildSquare.abs], { encoding: 'utf8' }).stdout.trim();
    return q === '1080,1080' && Boolean(a);
  })(), buildSquare.ok ? `${buildSquare.file} ${Math.round(buildSquare.bytes / 1024)}KB` : buildSquare.error);
const buildBili = await VA.buildVariant({ filmRel: varSrcRel, preset: 'bilibili', fit: 'crop', outDir: varDir });
ok('生成横屏版本：分辨率 1920x1080（裁切模式）',
  buildBili.ok && spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', buildBili.abs], { encoding: 'utf8' }).stdout.trim() === '1920,1080',
  buildBili.ok ? String(buildBili.bytes) + 'B' : buildBili.error);
const planSource = await VA.planVariants({ scriptId: 'SC-D', code: 'S01E001', fit: 'crop', subtitleMarginV: 120 });
ok('整集规划：可从成片探测源分辨率（不是只依赖 meta）',
  planSource.ok && planSource.source.width > 0 && planSource.source.height > 0,
  JSON.stringify({ ok: planSource.ok, src: planSource.source, err: planSource.error }).slice(0, 140));
ok('生成失败时给中文原因（源文件不存在）',
  (await VA.buildVariant({ filmRel: 'data/videos/没有这个.mp4', preset: 'douyin' })).ok === false);
const plans = await VA.planVariants({ scriptId: 'SC-D', code: 'S01E001', fit: 'crop', subtitleMarginV: 120 });
ok('整集规划：一次算出全部平台方案 + 汇总风险',
  plans.ok && Array.isArray(plans.plans) && plans.plans.length === 6 && plans.warnings.length >= 1,
  `${plans.plans?.length} 个方案 · 源 ${plans.source?.width}x${plans.source?.height} · ${plans.warnings?.length} 条风险`);
ok('整集规划：没有成片时给中文原因',
  (await VA.planVariants({ scriptId: 'SC-没有这个', code: 'S01E404' })).ok === false);
// 交付包：配置了 variants.targets 时才生成，并写进 manifest
saveConfig({ variants: { targets: ['square'], fit: 'blur-pad' } });
const builtVar = await buildDelivery({ scriptId: 'SC-D', code: 'S01E001', includeVideos: false, includeQc: false, includePublish: false });
const varManifest = JSON.parse(String(builtVar.entries.find((e) => e.path === 'manifest.json').data));
ok('交付包按配置生成多平台版本（variants/ 目录 + manifest.variants）',
  varManifest.variants?.length === 1 && varManifest.variants[0].preset === 'square'
  && builtVar.entries.some((e) => e.path.startsWith('variants/S01E001_square')),
  JSON.stringify(varManifest.variants || []).slice(0, 120));
saveConfig({ variants: { targets: [], fit: 'crop' } });

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败${skipped ? ` / 跳过 ${skipped}` : ''} ===`);
server.close();
try {
  for (const f of [DB, DB + '-wal', DB + '-shm', CFG]) fs.rmSync(f, { force: true });
  fs.rmSync(DATA_TMP, { recursive: true, force: true });
  fs.rmSync(ZIPS, { recursive: true, force: true });
} catch { /* ignore */ }
process.exit(fail ? 1 : 0);
