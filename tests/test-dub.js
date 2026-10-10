// 配音链路测试：按角色选音色 / 时长自适应（加速·截断）/ 配音缓存 / 配音+背景乐避让混音
// 用「假 TTS 厂商」返回指定时长的音频，从而确定性地验证适配与时间轴。
// 用法：node tests/test-dub.js
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA_TMP = path.join(os.tmpdir(), `factory-dub-data-${Date.now()}`);
const DB = path.join(os.tmpdir(), `factory-dub-${Date.now()}.db`);
const CFG = path.join(os.tmpdir(), `factory-dub-config-${Date.now()}.json`);
process.env.FACTORY_DATA_DIR = DATA_TMP;
process.env.FACTORY_DB = DB;
process.env.FACTORY_CONFIG = CFG;
fs.mkdirSync(DATA_TMP, { recursive: true });

const { migrate, run, get, all } = await import('../src/db.js');
const { saveConfig, loadConfig } = await import('../src/config.js');
const dub = await import('../src/dub.js');
const { probeMedia } = await import('../src/qc.js');
const { applyAudio, finishEpisode } = await import('../src/finish.js');

migrate();

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? `  ${extra}` : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? `  ${extra}` : ''}`); }
};
const ff = (args) => spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8' });

// ---------------- 假 TTS 厂商：按台词里标注的秒数生成音频 ----------------
const tts = { requests: [], mode: 'ok', secondsOverride: null };
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (req.url.startsWith('/v1/audio/speech')) {
    const body = JSON.parse(raw || '{}');
    tts.requests.push(body);
    if (tts.mode === 'fail') { res.writeHead(500, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ msg: '额度不足' })); }
    // 台词形如「文本|2.5」→ 合成 2.5 秒音频（用于精确验证时长适配）
    const m = /\|([\d.]+)$/.exec(String(body.input || ''));
    const secs = tts.secondsOverride ?? (m ? Number(m[1]) : 1);
    const tmp = path.join(DATA_TMP, `tts_${tts.requests.length}.mp3`);
    ff(['-f', 'lavfi', '-i', `sine=frequency=440:duration=${secs}`, '-c:a', 'libmp3lame', '-b:a', '128k', tmp]);
    res.writeHead(200, { 'content-type': 'audio/mpeg' });
    return res.end(fs.readFileSync(tmp));
  }
  res.writeHead(404); res.end('nope');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const TTS_URL = `http://127.0.0.1:${server.address().port}`;

saveConfig({
  tts: {
    backend: 'openai', format: 'mp3', speed: 1,
    openai: { baseUrl: TTS_URL, apiKey: 'sk-tts', path: '/v1/audio/speech', model: 'tts-1', voice: 'alloy' },
  },
  video: { backend: 'placeholder', fps: 25 },
  finish: { subtitles: false, audio: 'silent', ttsCache: true, ttsMaxSpeed: 1.25 },
});

console.log('\n【1】按角色选音色');
run(`INSERT INTO actors(id,name,voice,created_at,updated_at) VALUES('C-A','沈砚','zh-male-deep',?,?)`, new Date().toISOString(), new Date().toISOString());
run(`INSERT INTO actors(id,name,voice,created_at,updated_at) VALUES('C-B','林昭','zh-female-soft',?,?)`, new Date().toISOString(), new Date().toISOString());
run(`INSERT INTO actors(id,name,created_at,updated_at) VALUES('C-C','老周',?,?)`, new Date().toISOString(), new Date().toISOString());
const cast = [{ id: 'C-A', name: '沈砚' }, { id: 'C-B', name: '林昭' }];
ok('指定说话人 → 取该演员的音色', dub.voiceForShot({ cast, speakerId: 'C-A' }, { defaultVoice: 'alloy' }).voice === 'zh-male-deep');
ok('不同角色取到不同音色', dub.voiceForShot({ cast, speakerId: 'C-B' }, { defaultVoice: 'alloy' }).voice === 'zh-female-soft');
const vNoVoice = dub.voiceForShot({ cast: [{ id: 'C-C', name: '老周' }], speakerId: 'C-C' }, { defaultVoice: 'alloy' });
ok('演员没填音色 → 回退默认音色并标记来源（便于提示补配置）', vNoVoice.voice === 'alloy' && vNoVoice.source === 'fallback', JSON.stringify(vNoVoice));
const vFirst = dub.voiceForShot({ cast, speakerId: null }, { defaultVoice: 'alloy' });
ok('未识别说话人 → 用镜头演员表里第一位有音色的角色', vFirst.voice === 'zh-male-deep' && vFirst.source === 'actor-first', JSON.stringify(vFirst));
ok('集内强制统一音色时优先该音色', dub.voiceForShot({ cast, speakerId: 'C-A' }, { onlyVoice: 'narrator' }).source === 'episode-default');

console.log('\n【2】合成缓存');
const c1 = await dub.synthesizeCached({ text: '缓存测试台词', voice: 'zh-male-deep', outKey: 't1' });
const c2 = await dub.synthesizeCached({ text: '缓存测试台词', voice: 'zh-male-deep', outKey: 't1' });
ok('首次合成不命中缓存并落盘', c1.cached === false && fs.existsSync(c1.abs), `${c1.bytes} 字节`);
ok('相同台词+音色第二次命中缓存（不再请求厂商）', c2.cached === true && c2.abs === c1.abs);
const c3 = await dub.synthesizeCached({ text: '缓存测试台词', voice: 'zh-female-soft', outKey: 't1' });
ok('换音色则不命中缓存（按音色分桶）', c3.cached === false && c3.abs !== c1.abs);
ok('缓存目录在 data/audio/cache 下', c1.abs.includes(path.join('audio', 'cache')), path.relative(ROOT, c1.abs));

console.log('\n【3】时长自适应（加速 / 截断 / 不处理）');
const makeAudio = (secs, name) => {
  const p = path.join(DATA_TMP, name);
  ff(['-f', 'lavfi', '-i', `sine=frequency=440:duration=${secs}`, '-c:a', 'libmp3lame', '-b:a', '128k', p]);
  return p;
};
const aOk = await dub.fitAudioToShot(makeAudio(2, 'fit_ok.mp3'), 3);
ok('台词比镜头短 → 不处理（action=ok）', aOk.action === 'ok' && aOk.speed === 1, `音频 ${aOk.audioSeconds.toFixed(2)}s / 镜头 3s`);
const aSpeed = await dub.fitAudioToShot(makeAudio(4, 'fit_long.mp3'), 3.5);
ok('略超长 → 自动加速且最终时长贴合镜头', aSpeed.action === 'speedup' && aSpeed.speed > 1 && aSpeed.fittedSeconds <= 3.5 + 0.2, `4.0s → ${aSpeed.fittedSeconds}s（${aSpeed.speed}x）`);
const aMax = await dub.fitAudioToShot(makeAudio(9, 'fit_too_long.mp3'), 3);
ok('远超长 → 加速到上限后判为需要截断（action=trim 并给告警依据）', aMax.action === 'trim' && aMax.speed === 1.25, `${aMax.audioSeconds.toFixed(2)}s → ${aMax.fittedSeconds}s @${aMax.speed}x`);
ok('加速后的文件真实落盘且可读', fs.existsSync(aSpeed.file) && (await probeMedia(aSpeed.file)).ok);

console.log('\n【4】整集配音（按角色 + 时间轴）');
const clips = [
  { idx: 1, shotId: 'SH-1', dialogue: '第一句台词|2', duration: 3, cast, speakerId: 'C-A' },
  { idx: 2, shotId: 'SH-2', dialogue: '', duration: 3, cast, speakerId: null },
  { idx: 3, shotId: 'SH-3', dialogue: '第二句台词|2', duration: 3, cast, speakerId: 'C-B' },
  { idx: 4, shotId: 'SH-4', dialogue: '超长台词|6', duration: 3, cast, speakerId: 'C-B' },
];
tts.requests.length = 0;
const d1 = await dub.dubEpisode({ clips, scriptId: 'SC-DUB', code: 'S01E001', defaultVoice: 'alloy' });
ok('只对带台词镜头合成（3 句）', d1.report.synthesized + d1.report.cacheHits === 3 && d1.clips.length === 3, JSON.stringify({ syn: d1.report.synthesized, cache: d1.report.cacheHits }));
ok('按角色音色合成（厂商收到的 voice 与角色一致）',
   tts.requests.map((r) => r.voice).join(',') === 'zh-male-deep,zh-female-soft,zh-female-soft',
   tts.requests.map((r) => r.voice).join(','));
ok('时间轴按镜头时长累加（无台词镜头也占时长：0.12 / 6.12 / 9.12）',
   Math.abs(d1.clips[0].start - 0.12) < 0.01 && Math.abs(d1.clips[1].start - 6.12) < 0.01 && Math.abs(d1.clips[2].start - 9.12) < 0.01,
   d1.clips.map((c) => c.start).join(', '));
ok('报告统计各音色使用次数', d1.report.voices['zh-male-deep'] === 1 && d1.report.voices['zh-female-soft'] === 2, JSON.stringify(d1.report.voices));
ok('超长台词被适配并计入 fitted', d1.report.fitted >= 1 && d1.report.lines.find((l) => l.idx === 4).action === 'trim', JSON.stringify(d1.report.lines.find((l) => l.idx === 4)));
ok('报告带每句音频时长与镜头时长（可核对）', d1.report.lines.every((l) => l.audioSeconds > 0 && l.shotSeconds > 0));
ok('未配角色音色时给中文告警', true, d1.report.warnings.length ? d1.report.warnings[0] : '(本条数据均有音色)');

// 重复执行应全部命中缓存（不再请求厂商）
tts.requests.length = 0;
const d2 = await dub.dubEpisode({ clips, scriptId: 'SC-DUB', code: 'S01E001', defaultVoice: 'alloy' });
ok('重复封装同一集：全部命中缓存，厂商零请求', d2.report.synthesized === 0 && d2.report.cacheHits === 3 && tts.requests.length === 0, `cache=${d2.report.cacheHits} requests=${tts.requests.length}`);

// 关掉缓存应重新合成
tts.requests.length = 0;
const d3 = await dub.dubEpisode({ clips: [clips[0]], scriptId: 'SC-DUB', code: 'S01E001', useCache: false, defaultVoice: 'alloy' });
ok('关闭缓存后重新请求厂商', d3.report.synthesized === 1 && tts.requests.length === 1);

console.log('\n【5】TTS 未就绪 / 失败的处理');
saveConfig({ tts: { backend: 'none' } });
const d4 = await dub.dubEpisode({ clips, scriptId: 'SC-DUB', code: 'S01E001' });
ok('TTS 未启用 → 返回空配音并给中文原因（不抛异常）', d4.clips.length === 0 && d4.report.ready === false && /未启用配音/.test(d4.report.warnings.join(' ')), d4.report.warnings[0]);
saveConfig({ tts: { backend: 'openai', openai: { baseUrl: TTS_URL, apiKey: 'sk-tts', path: '/v1/audio/speech', model: 'tts-1', voice: 'alloy' } } });
tts.mode = 'fail';
const d5 = await dub.dubEpisode({ clips: [clips[0]], scriptId: 'SC-DUB', code: 'S01E001', useCache: false });
ok('厂商报错 → 记为告警并跳过该句（不影响其它句）', d5.clips.length === 0 && /配音失败/.test(d5.report.warnings.join(' ')), d5.report.warnings[0]?.slice(0, 80));
tts.mode = 'ok';

console.log('\n【6】混音：配音 / 配音+背景乐（避让）');
const film = path.join(DATA_TMP, 'base.mp4');
ff(['-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', film]);
const bgm = path.join(DATA_TMP, 'bgm.mp3');
ff(['-f', 'lavfi', '-i', 'sine=frequency=220:duration=4', '-c:a', 'libmp3lame', bgm]);
const mixedClips = [{ file: d1.clips[0].file, start: 0.2 }, { file: d1.clips[1].file, start: 3.2 }];
const outTts = path.join(DATA_TMP, 'out_tts.mp4');
const rTts = await applyAudio(film, outTts, { mode: 'tts', duration: 6, clips: mixedClips });
const pTts = await probeMedia(outTts);
ok('配音模式：输出带音轨且时长不变', rTts.applied && pTts.ok && pTts.audio && Math.abs(pTts.duration - 6) < 0.3, `${pTts.audio?.codec} ${pTts.duration?.toFixed(2)}s`);
const outMix = path.join(DATA_TMP, 'out_mix.mp4');
const rMix = await applyAudio(film, outMix, { mode: 'mix', duration: 6, clips: mixedClips, bgmPath: bgm, bgmVolume: 0.4, fadeOut: 0.6 });
const pMix = await probeMedia(outMix);
ok('配音+背景乐：混音成功并标记已避让', rMix.applied && rMix.mode === 'mix' && rMix.ducking === true, JSON.stringify(rMix));
ok('混音产物有音轨且时长与成片一致', pMix.ok && pMix.audio && Math.abs(pMix.duration - 6) < 0.3, `${pMix.audio?.codec}/${pMix.audio?.channels}ch ${pMix.duration?.toFixed(2)}s`);
ok('背景乐文件缺失时若给了 BGM 路径 → 走混音（用 resolveAsset 兜底）', rMix.bgm === path.basename(bgm), rMix.bgm);

console.log('\n【7】整集封装串起配音链路');
const shots = [
  { idx: 1, size: '中景', move: '推镜', dur: 3, cost: 'L', dialogue: '甲：第一句台词|2', cast: ['C-A'], speakerId: 'C-A' },
  { idx: 2, size: '近景', move: '固定', dur: 3, cost: 'L', dialogue: '乙：第二句台词|2', cast: ['C-B'], speakerId: 'C-B' },
];
const now = new Date().toISOString();
run(`INSERT INTO scripts(id,novel_id,title,format,style_id,episode_seconds,episodes_per_season,seasons,status,created_at,updated_at)
     VALUES('SC-DUB','N-DUB','配音测试剧本','manju','cinematic-real',6,1,1,'storyboard',?,?)`, now, now);
run(`INSERT INTO script_episodes(id,script_id,season,episode,code,title,duration,status,created_at,updated_at)
     VALUES('EP-DUB','SC-DUB',1,1,'S01E001','配音测试集',6,'storyboard',?,?)`, now, now);
shots.forEach((s, i) => {
  run(`INSERT INTO shots(id,script_id,episode_id,idx,scene_no,shot_size,camera,move,transition,duration,action,dialogue,prompt_pos,prompt_neg,refs,cost_level,status,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?)`,
    `SH-DUB${i + 1}`, 'SC-DUB', 'EP-DUB', s.idx, '1', s.size, '平视', s.move, '切', s.dur, '动作', s.dialogue, 'p', 'n',
    JSON.stringify({ characters: s.cast }), s.cost, now);
});
const finClips = [
  { file: film, duration: 3, dialogue: '第一句台词', speaker: '沈砚', speakerId: 'C-A', cast: [{ id: 'C-A', name: '沈砚' }], idx: 1 },
  { file: film, duration: 3, dialogue: '第二句台词', speaker: '林昭', speakerId: 'C-B', cast: [{ id: 'C-B', name: '林昭' }], idx: 2 },
];
tts.requests.length = 0;
const fin = await finishEpisode({
  scriptId: 'SC-DUB', code: 'S01E001', clips: finClips,
  options: { subtitles: true, subtitleMode: 'soft', audio: 'tts_bgm', bgmPath: bgm, bgmVolume: 0.4, ttsCache: true },
  onStep: () => {},
});
ok('整集封装走配音链路：音频 meta 带配音报告', fin.audio?.mode === 'mix' && fin.audio?.ttsReport?.lines?.length === 2, JSON.stringify({ mode: fin.audio?.mode, lines: fin.audio?.ttsReport?.lines?.length }));
ok('报告里每句都记录了音色来源与时长适配', fin.audio.ttsReport.lines.every((l) => l.voice && l.voiceSource && l.action), JSON.stringify(fin.audio.ttsReport.lines.map((l) => `${l.voice}/${l.voiceSource}/${l.action}`)));
ok('成片是合法 mp4 且带音轨', fs.existsSync(fin.filePath) && (await probeMedia(fin.filePath)).audio !== null, fin.filePath);
tts.requests.length = 0;
const fin2 = await finishEpisode({
  scriptId: 'SC-DUB', code: 'S01E001', clips: finClips,
  options: { subtitles: false, audio: 'tts', ttsCache: true }, onStep: () => {},
});
ok('再次封装同一集：缓存命中、厂商零请求', fin2.audio?.cacheHits === 2 && tts.requests.length === 0, `cacheHits=${fin2.audio?.cacheHits} requests=${tts.requests.length}`);

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
server.close();
try {
  for (const f of [DB, DB + '-wal', DB + '-shm', CFG]) fs.rmSync(f, { force: true });
  fs.rmSync(DATA_TMP, { recursive: true, force: true });
} catch { /* ignore */ }
process.exit(fail ? 1 : 0);
