// 后期精修 · 本地渲染管线（plain text module）
//
// 输入：edit_timelines 里的多轨时间线；输出：新成片 + 版本记录 + QC。
// 全部本地 ffmpeg，零 API 费用。不修改混淆层 finish.js，独立并存。

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { get, run, all } from './db.js';
import { nowISO } from './util.js';
import {
  ensureEditSchema, getTimelineDoc, resolveMediaPath, recordVersion, newId, EDIT_ROOT,
} from './edit-timeline.js';

const W = 1920;
const H = 1080;
const FPS = 30;

function ffprobe(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { encoding: 'utf8' });
  try { return JSON.parse(r.stdout || '{}'); } catch { return {}; }
}
function hasStream(probe, type) {
  return (probe.streams || []).some((s) => s.codec_type === type);
}
function mediaDuration(probe, fallbackSec) {
  const d = Number(probe?.format?.duration);
  return Number.isFinite(d) && d > 0 ? d : fallbackSec;
}
function escFilterPath(p) {
  // ffmpeg filter 参数里的路径：反斜杠、冒号、单引号转义
  return String(p).replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

function buildSrt(timelineId, subtitleClips) {
  const lines = [];
  let n = 0;
  for (const c of subtitleClips) {
    const text = String(c.subtitle_text || '').trim();
    if (!text) continue;
    n += 1;
    const start = Math.max(0, Number(c.start_ms) || 0);
    const dur = Math.max(200, (Number(c.src_out_ms) - Number(c.src_in_ms)) || 1000);
    const end = start + dur;
    const ts = (ms) => {
      const h = Math.floor(ms / 3600000);
      const m = Math.floor((ms % 3600000) / 60000);
      const s = Math.floor((ms % 60000) / 1000);
      const f = ms % 1000;
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(f).padStart(3, '0')}`;
    };
    lines.push(String(n), `${ts(start)} --> ${ts(end)}`, text.replace(/\r?\n/g, '\n'), '');
  }
  if (!lines.length) return null;
  const dir = path.join(EDIT_ROOT, 'data', 'subtitles');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `edit_${timelineId}_${Date.now()}.srt`);
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  return file;
}

/**
 * 同步构建 ffmpeg 参数（纯函数，便于单测）
 * doc: getTimelineDoc() 的返回；opts.mediaExists: (p)=>bool
 */
export function buildRenderPlan(doc, { subtitleFile = null, outFile = 'out.mp4', mediaExists = (p) => fs.existsSync(p), width = W, height = H, denoise = false, subtitleFontSize = 22, subtitleMarginV = 40, smartCrop = false } = {}) {
  const main = doc.tracks.find((t) => t.kind === 'main');
  if (!main || !main.clips.length) throw new Error('主轨为空，无法渲染');
  const clips = [...main.clips].sort((a, b) => a.order_index - b.order_index);
  const inputs = [];
  const filters = [];
  const probes = [];
  let idx = 0;

  const addInput = (file, extra = []) => {
    inputs.push(...extra, '-i', file);
    const probe = ffprobe(file);
    probes.push(probe);
    const cur = idx;
    idx += 1;
    return { index: cur, probe };
  };

  const mainLabels = [];
  const durations = [];
  let totalSec = 0;
  let anyAudio = false;

  for (const [i, c] of clips.entries()) {
    const abs = resolveMediaPath(c.file_path);
    const isVideo = abs && mediaExists(abs);
    const fallbackImg = resolveMediaPath(c.extra?.poster_path || '');
    let src = abs;
    let isImage = false;
    if (!isVideo) {
      if (fallbackImg && mediaExists(fallbackImg)) { src = fallbackImg; isImage = true; }
      else throw new Error(`第 ${i + 1} 个镜头没有可用视频或关键帧（${c.title || c.shot_id || c.id}），请先回制作台生成`);
    }
    const inSec = Math.max(0, Number(c.src_in_ms) / 1000);
    const outSec = Math.max(inSec + 0.1, Number(c.src_out_ms) / 1000);
    const dur = Math.max(0.1, outSec - inSec);
    const extra = isImage ? ['-loop', '1', '-t', String(dur + 1)] : [];
    const { index, probe } = addInput(src, extra);
    const srcHasAudio = isImage ? false : hasStream(probe, 'audio');
    let vf;
    if (smartCrop) {
      // 竖屏智能重构：按主体焦点裁 9:16，再等比放大（不再上下/左右加黑边）
      const st = (probe.streams || []).find((x) => x.codec_type === 'video') || {};
      const sw = Number(st.width) || width;
      const sh = Number(st.height) || height;
      const cw = Math.max(1, Math.min(sw, Math.round((sh * 9) / 16)));
      const fx = Math.max(0, Math.min(1, Number(c.extra?.focus_x ?? 0.5)));
      const cx = Math.round((sw - cw) * fx);
      vf = `trim=start=${inSec}:end=${outSec},setpts=PTS-STARTPTS,crop=${cw}:${sh}:${cx}:0,scale=${width}:${height},setsar=1,fps=${FPS}`;
    } else {
      vf = `trim=start=${inSec}:end=${outSec},setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${FPS}`;
    }
    if (c.transition_in === 'fade-to-black') vf += ',fade=t=in:st=0:d=0.4,fade=t=out:st=' + Math.max(0, dur - 0.4).toFixed(3) + ':d=0.4';
    filters.push(`[${index}:v]${vf}[v${i}]`);
    mainLabels.push(`v${i}`);
    durations.push(dur);
    totalSec += dur;

    if (srcHasAudio) {
      anyAudio = true;
      const gain = clamp(Number(c.gain_db) || 0, -60, 12);
      filters.push(`[${index}:a]atrim=start=${inSec}:end=${outSec},asetpts=PTS-STARTPTS,volume=${gain}dB[a${i}]`);
    } else {
      filters.push(`aevalsrc=0:d=${dur.toFixed(3)}:s=48000[a${i}]`);
    }
  }

  // 视频拼接：cut 用 concat；dissolve 用 xfade
  const trans = clips.map((c, i) => (i === 0 ? 'cut' : (c.transition_in === 'dissolve' ? 'dissolve' : 'cut')));
  let vOut;
  let videoDur = totalSec;
  const hasDissolve = trans.includes('dissolve');
  if (!hasDissolve) {
    filters.push(`${mainLabels.map((l) => `[${l}]`).join('')}concat=n=${mainLabels.length}:v=1:a=0[vmain]`);
    vOut = 'vmain';
  } else {
    let prev = mainLabels[0];
    let acc = durations[0];
    let k = 0;
    for (let i = 1; i < mainLabels.length; i += 1) {
      k += 1;
      const label = `xm${k}`;
      if (trans[i] === 'dissolve') {
        const d = clamp(Number(clips[i].transition_ms) / 1000 || 0.4, 0.1, Math.min(2, durations[i - 1] * 0.8, durations[i] * 0.8));
        const offset = Math.max(0, acc - d);
        filters.push(`[${prev}][${mainLabels[i]}]xfade=transition=fade:duration=${d.toFixed(3)}:offset=${offset.toFixed(3)}[${label}]`);
        acc = acc + durations[i] - d;
      } else {
        filters.push(`[${prev}][${mainLabels[i]}]concat=n=2:v=1:a=0[${label}]`);
        acc += durations[i];
      }
      prev = label;
    }
    vOut = prev;
    videoDur = acc;
  }

  // 画中画轨
  const overlays = doc.tracks.filter((t) => t.kind === 'overlay' && t.enabled !== 0);
  for (const [ti, track] of overlays.entries()) {
    for (const [ci, c] of (track.clips || []).entries()) {
      const abs = resolveMediaPath(c.file_path);
      if (!abs || !mediaExists(abs)) continue;
      const inSec = Math.max(0, Number(c.src_in_ms) / 1000);
      const outSec = Math.max(inSec + 0.1, Number(c.src_out_ms) / 1000);
      const startSec = Math.max(0, Number(c.start_ms) / 1000);
      const dur = outSec - inSec;
      const scale = clamp(Number(c.extra?.scale) || 0.35, 0.05, 1);
      const opacity = clamp(Number(c.extra?.opacity ?? 1), 0, 1);
      const x = String(c.extra?.x || 'W-w-40');
      const y = String(c.extra?.y || '40');
      const { index } = addInput(abs);
      const label = `ov${ti}_${ci}`;
      filters.push(`[${index}:v]trim=start=${inSec}:end=${outSec},setpts=PTS-STARTPTS,scale=iw*${scale}:-1,setsar=1,fps=${FPS},format=rgba,colorchannelmixer=aa=${opacity}[${label}]`);
      const next = `vb${ti}_${ci}`;
      filters.push(`[${vOut}][${label}]overlay=${x}:${y}:enable='between(t,${startSec.toFixed(3)},${(startSec + dur).toFixed(3)})'[${next}]`);
      vOut = next;
    }
  }

  // 字幕烧录
  if (subtitleFile) {
    filters.push(`[${vOut}]subtitles='${escFilterPath(subtitleFile)}':force_style='FontName=Hiragino Sans GB,FontSize=${subtitleFontSize},PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=1,MarginV=${subtitleMarginV},Alignment=2'[vsub]`);
    vOut = 'vsub';
  }

  // 音频：主轨 concat
  const aLabels = clips.map((_, i) => `[a${i}]`).join('');
  filters.push(`${aLabels}concat=n=${clips.length}:v=0:a=1[amain]`);
  let aOut = 'amain';

  // 音频轨（配乐/音效）
  const audioTracks = doc.tracks.filter((t) => t.kind === 'audio' && t.enabled !== 0 && !t.muted);
  let aIdx = 0;
  for (const track of audioTracks) {
    for (const c of (track.clips || [])) {
      const abs = resolveMediaPath(c.file_path);
      if (!abs || !mediaExists(abs)) continue;
      const inSec = Math.max(0, Number(c.src_in_ms) / 1000);
      const outSec = Math.max(inSec + 0.1, Number(c.src_out_ms) / 1000);
      const gain = clamp((Number(c.gain_db) || 0) + (Number(track.gain_db) || 0), -60, 12);
      const { index, probe } = addInput(abs);
      if (!hasStream(probe, 'audio')) continue;
      anyAudio = true;
      const label = `bg${aIdx}`;
      aIdx += 1;
      filters.push(`[${index}:a]atrim=start=${inSec}:end=${outSec},asetpts=PTS-STARTPTS,volume=${gain}dB[${label}]`);
      const next = `amix${aIdx}`;
      filters.push(`[${aOut}][${label}]amix=inputs=2:duration=first:dropout_transition=0[${next}]`);
      aOut = next;
    }
  }
  // 音频必须与视频等长：dissolve 会让画面变短，音频若仍按原长 concat 会把成片拖长。
  // 先 apad 补静音再 atrim 到视频时长，保证两条流严格对齐。
  // 注意：整条音频都是纯静音时，loudnorm 会产出非法采样帧、AAC 直接报 Invalid argument。
  // 因此「没有任何真实音源」时跳过 loudnorm/降噪，只做等长收口。
  const proc = anyAudio ? `${denoise ? 'afftdn=nf=-25,highpass=f=80,' : ''}loudnorm=I=-16:TP=-1.5:LRA=11,` : '';
  filters.push(`[${aOut}]${proc}apad,atrim=0:${videoDur.toFixed(3)},asetpts=PTS-STARTPTS[aout]`);

  const args = [
    '-y', '-hide_banner', '-loglevel', 'error',
    ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', `[${vOut}]`, '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-movflags', '+faststart',
    '-t', videoDur.toFixed(3),
    outFile,
  ];
  return { args, durationSec: videoDur, clipCount: clips.length, filters, inputs };
}

function runFfmpeg(args, { onStep } = {}) {
  return new Promise((resolve, reject) => {
    const cp = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    cp.stderr.on('data', (d) => { err = (err + d.toString()).slice(-4000); });
    cp.on('error', reject);
    cp.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg 退出码 ${code}：${err.trim().split('\n').slice(-4).join(' | ')}`));
    });
    onStep?.({ phase: 'render', pid: cp.pid });
  });
}

const ASPECTS = { '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1080, 1080] };

export async function renderTimeline(timelineId, { operator = '未署名', onStep = () => {}, denoise = false, aspect = '16:9' } = {}) {
  ensureEditSchema();
  const doc = getTimelineDoc(timelineId);
  if (!doc) throw new Error('时间线不存在');
  const tl = doc.timeline;
  if (tl.status === 'locked') throw new Error('时间线已锁定，不能重新渲染；请先复制为新版本');

  const subtitleTrack = doc.tracks.find((t) => t.kind === 'subtitle' && t.enabled !== 0);
  const srt = buildSrt(timelineId, subtitleTrack?.clips || []);

  const code = String(tl.code || 'EDIT').replace(/[^\w.-]/g, '_');
  const dir = path.join(EDIT_ROOT, 'data', 'finish', `${tl.script_id || 'SC'}_${code}`);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = Date.now();
  const outFile = path.join(dir, `${code}_edit_${stamp}.mp4`);

  onStep({ phase: 'plan', message: '正在构建渲染计划' });
  const [width, height] = ASPECTS[aspect] || ASPECTS['16:9'];
  const vertical = aspect === '9:16';
  const plan = buildRenderPlan(doc, {
    subtitleFile: srt, outFile, width, height, denoise,
    subtitleFontSize: vertical ? 18 : 22,
    subtitleMarginV: vertical ? 140 : 40,
    smartCrop: aspect === '9:16',
  });
  onStep({ phase: 'render', message: `正在渲染 ${plan.clipCount} 个镜头（约 ${plan.durationSec.toFixed(1)} 秒）` });
  await runFfmpeg(plan.args, { onStep });

  const probe = ffprobe(outFile);
  const duration = Number(probe?.format?.duration) || plan.durationSec;
  const size = fs.existsSync(outFile) ? fs.statSync(outFile).size : 0;
  if (!size) throw new Error('渲染完成但没有产出文件');

  const filmId = newId('FM');
  const relPath = path.relative(EDIT_ROOT, outFile);
  const now = nowISO();
  run(`INSERT INTO episode_films(id,script_id,episode_id,code,file_path,duration,size,shot_count,backend,status,error,job_id,meta,created_at,timeline_id,version_no,parent_film_id,review_status,operator)
    VALUES(?,?,?,?,?,?,?,?,'edit-ffmpeg','done',NULL,NULL,?,?,?,?,NULL,'draft',?)`,
    filmId, tl.script_id, tl.episode_id, tl.code, relPath, Math.round(duration * 1000) / 1000, size, plan.clipCount,
    JSON.stringify({ timeline_id: timelineId, doc_version: tl.doc_version, w: width, h: height, fps: FPS, aspect, denoise }), now, timelineId, null, operator);

  // 占位产物门禁：统计这一版里有多少镜头的源素材是占位/本地图
  let placeholderClips = 0;
  try {
    const renderIds = [...new Set(((doc.tracks.find((t) => t.kind === 'main')?.clips) || []).map((c) => c.render_id).filter(Boolean))];
    if (renderIds.length) {
      const rows = all(`SELECT backend FROM shot_renders WHERE id IN (${renderIds.map(() => '?').join(',')})`, ...renderIds);
      placeholderClips = rows.filter((r) => /placeholder|local-image/i.test(String(r.backend || ''))).length;
    }
  } catch { /* 统计失败不影响渲染 */ }

  const prev = get('SELECT MAX(version_no) n FROM edit_versions WHERE timeline_id=?', timelineId);
  const versionNo = Number(prev?.n || 0) + 1;
  run('UPDATE episode_films SET version_no=? WHERE id=?', versionNo, filmId);
  recordVersion(timelineId, { filmId, docVersion: tl.doc_version, snapshot: doc, note: `渲染 v${versionNo}`, operator });
  run('UPDATE edit_timelines SET render_id=?, updated_at=?, operator=? WHERE id=?', filmId, now, operator, timelineId);

  return { ok: true, filmId, versionNo, file: relPath, absFile: outFile, duration, size, clipCount: plan.clipCount, subtitleFile: srt, width, height, aspect, denoise, placeholder: placeholderClips > 0, placeholderClips };
}
