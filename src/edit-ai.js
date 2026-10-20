// 后期精修 · AI 辅助分析（纯本地、零 API 费用）
//
// - detectBeats：PCM 能量起始点检测（BGM 卡点）
// - analyzeSubtitles / autoFixSubtitles：CPS 与行宽体检、自动拆行/延长
// - proposeRoughCut / applyRoughCut：按目标时长做粗剪方案（可审阅、可拒绝）
// - analyzeConsistency：跨镜关键帧感知哈希抽检（sharp 不可用时如实跳过）

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFile } from 'node:child_process';
import { resolveMediaPath } from './edit-timeline.js';

const SAMPLE_RATE = 22050;
const WIN = 512;

export function detectBeats(file, { minGapMs = 220, threshold = 1.2 } = {}) {
  const abs = resolveMediaPath(file);
  if (!abs || !fs.existsSync(abs)) throw new Error('音频文件不存在');
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', abs, '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', '-'], { maxBuffer: 200 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`音频解码失败：${String(r.stderr || '').trim().split('\n').slice(-2).join(' | ')}`);
  const buf = r.stdout;
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + (buf.length & ~1));
  const samples = new Int16Array(ab);
  const rms = [];
  for (let i = 0; i + WIN <= samples.length; i += WIN) {
    let s = 0;
    for (let j = 0; j < WIN; j += 1) { const v = samples[i + j] / 32768; s += v * v; }
    rms.push(Math.sqrt(s / WIN));
  }
  const onset = rms.map((v, i) => (i ? Math.max(0, v - rms[i - 1]) : 0));
  const mean = onset.reduce((a, b) => a + b, 0) / Math.max(1, onset.length);
  const std = Math.sqrt(onset.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, onset.length));
  const thr = mean + std * threshold;
  const minGap = Math.max(1, Math.round((minGapMs / 1000) * SAMPLE_RATE / WIN));
  const beats = [];
  let last = -1e9;
  for (let i = 1; i < onset.length; i += 1) {
    if (onset[i] >= thr && onset[i] >= onset[i - 1] && i - last >= minGap) {
      beats.push(Number(((i * WIN) / SAMPLE_RATE).toFixed(3)));
      last = i;
    }
  }
  const duration = Number((samples.length / SAMPLE_RATE).toFixed(3));
  return { ok: true, beats, count: beats.length, duration, bpm: beats.length > 1 ? Number(((beats.length - 1) / (beats[beats.length - 1] - beats[0]) * 60).toFixed(1)) : null };
}

function charsOf(text) {
  return [...String(text || '').replace(/\s+/g, '')].length;
}

export function analyzeSubtitles(doc, { maxCps = 9, maxCharsPerLine = 20 } = {}) {
  const track = doc.tracks.find((t) => t.kind === 'subtitle');
  const issues = [];
  let total = 0;
  for (const c of track?.clips || []) {
    const text = String(c.subtitle_text || '').trim();
    if (!text) continue;
    total += 1;
    const durMs = Math.max(1, Number(c.src_out_ms) - Number(c.src_in_ms));
    const chars = charsOf(text);
    const cps = Number((chars / (durMs / 1000)).toFixed(2));
    const longest = Math.max(...text.split('\n').map((l) => [...l].length));
    if (cps > maxCps) {
      issues.push({ clip_id: c.id, type: 'cps', severity: cps > maxCps * 1.5 ? 'blocker' : 'major', cps, chars, duration_ms: durMs, text, message: `语速 ${cps} 字/秒，超过 ${maxCps} 字/秒` });
    }
    if (longest > maxCharsPerLine) {
      issues.push({ clip_id: c.id, type: 'line', severity: 'minor', longest, text, message: `单行 ${longest} 字，超过 ${maxCharsPerLine} 字` });
    }
  }
  return {
    ok: true,
    total,
    issues,
    summary: {
      cps: issues.filter((i) => i.type === 'cps').length,
      line: issues.filter((i) => i.type === 'line').length,
      blocker: issues.filter((i) => i.severity === 'blocker').length,
    },
  };
}

function wrapText(text, maxChars) {
  const src = String(text || '').replace(/\s+/g, ' ').trim();
  if (!src) return '';
  const parts = src.split(/(?<=[，。！？；、,.!?;：:])/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const p of parts) {
    if ([...cur + p].length <= maxChars) { cur += p; continue; }
    if (cur) lines.push(cur);
    if ([...p].length <= maxChars) { cur = p; continue; }
    const chars = [...p];
    for (let i = 0; i < chars.length; i += maxChars) lines.push(chars.slice(i, i + maxChars).join(''));
    cur = '';
  }
  if (cur) lines.push(cur);
  return lines.join('\n');
}

export function autoFixSubtitles(doc, { maxCps = 9, maxCharsPerLine = 18 } = {}) {
  const track = doc.tracks.find((t) => t.kind === 'subtitle');
  const clips = [...(track?.clips || [])].sort((a, b) => a.start_ms - b.start_ms);
  const fixes = [];
  for (let i = 0; i < clips.length; i += 1) {
    const c = clips[i];
    const text = String(c.subtitle_text || '').trim();
    if (!text) continue;
    const nextStart = clips[i + 1]?.start_ms ?? Infinity;
    const curDur = Math.max(1, Number(c.src_out_ms) - Number(c.src_in_ms));
    const chars = charsOf(text);
    const cps = chars / (curDur / 1000);
    if (cps > maxCps) {
      const needMs = Math.ceil((chars / maxCps) * 1000);
      const cap = Number.isFinite(nextStart) ? Math.max(0, nextStart - Number(c.start_ms)) : needMs;
      const targetMs = Math.max(curDur, Math.min(needMs, cap || needMs));
      if (targetMs > curDur) {
        c.src_out_ms = Number(c.src_in_ms) + targetMs;
        fixes.push({ clip_id: c.id, type: 'extend', from_ms: curDur, to_ms: targetMs });
      }
    }
    const longest = Math.max(...text.split('\n').map((l) => [...l].length));
    if (longest > maxCharsPerLine) {
      const wrapped = wrapText(text, maxCharsPerLine);
      if (wrapped && wrapped !== text) { c.subtitle_text = wrapped; fixes.push({ clip_id: c.id, type: 'wrap', text: wrapped }); }
    }
  }
  return { ok: true, fixes, changed: fixes.length > 0, clips };
}

export function proposeRoughCut(doc, { targetSeconds = null, maxShotMs = 4000, minShotMs = 800 } = {}) {
  const main = doc.tracks.find((t) => t.kind === 'main');
  const clips = [...(main?.clips || [])].sort((a, b) => a.order_index - b.order_index);
  const durOf = (c) => Math.max(0, Number(c.src_out_ms) - Number(c.src_in_ms));
  const before = clips.reduce((a, c) => a + durOf(c), 0) / 1000;
  const target = Number(targetSeconds) || Number((before * 0.85).toFixed(2));
  const trim = [];
  const drop = [];
  let afterMs = before * 1000;
  clips.forEach((c, i) => {
    const d = durOf(c);
    if (i > 0 && i < clips.length - 1 && d > maxShotMs) {
      const newDur = maxShotMs;
      trim.push({ id: c.id, title: c.title, from_ms: d, to_ms: newDur });
      afterMs -= d - newDur;
    }
  });
  const candidates = clips
    .map((c, i) => ({ c, i }))
    .filter(({ c, i }) => i > 0 && i < clips.length - 1 && !String(c.subtitle_text || '').trim() && durOf(c) >= minShotMs)
    .sort((a, b) => durOf(b.c) - durOf(a.c));
  for (const { c } of candidates) {
    if (afterMs / 1000 <= target) break;
    const d = durOf(c);
    drop.push({ id: c.id, title: c.title, duration_ms: d });
    afterMs -= d;
  }
  return {
    ok: true,
    before: Number(before.toFixed(2)),
    target: Number(target.toFixed(2)),
    after: Number((afterMs / 1000).toFixed(2)),
    trims: trim,
    drops: drop,
    changed: trim.length > 0 || drop.length > 0,
  };
}

export function applyRoughCut(doc, plan) {
  const main = doc.tracks.find((t) => t.kind === 'main');
  if (!main) throw new Error('主轨为空');
  const dropIds = new Set((plan.drops || []).map((x) => x.id));
  const trimMap = new Map((plan.trims || []).map((x) => [x.id, x.to_ms]));
  main.clips = (main.clips || [])
    .filter((c) => !dropIds.has(c.id))
    .sort((a, b) => a.order_index - b.order_index)
    .map((c, i) => {
      const next = { ...c, order_index: i };
      if (trimMap.has(c.id)) next.src_out_ms = Number(c.src_in_ms) + Number(trimMap.get(c.id));
      return next;
    });
  let cursor = 0;
  for (const c of main.clips) { c.start_ms = cursor; cursor += Math.max(0, Number(c.src_out_ms) - Number(c.src_in_ms)); }
  return { ok: true, tracks: doc.tracks, kept: main.clips.length };
}

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return s[Math.floor(s.length / 2)];
}

const HASH_CACHE = new Map(); // key: 文件+mtime(+抽帧点) → 64 位 pHash

const execFileP = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, timeout: 20000, ...opts }, (err, stdout, stderr) => {
    if (err) reject(new Error(String(stderr || err.message).slice(-400)));
    else resolve({ stdout, stderr });
  });
});

async function mapLimit(items, limit, worker) {
  const list = Array.from(items || []);
  const out = new Array(list.length);
  let cursor = 0;
  const run = async () => {
    for (;;) {
      const i = cursor; cursor += 1;
      if (i >= list.length) return;
      out[i] = await worker(list[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, list.length || 1)) }, run));
  return out;
}

async function hashOfImage(sharp, file) {
  const raw = await sharp(file).resize(9, 8, { fit: 'fill' }).grayscale().raw().toBuffer();
  let hash = 0n;
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      if (raw[y * 9 + x] > raw[y * 9 + x + 1]) hash |= (1n << BigInt(63 - (y * 8 + x)));
    }
  }
  return hash;
}

export async function analyzeConsistency(doc) {
  const main = doc.tracks.find((t) => t.kind === 'main');
  const clips = main?.clips || [];
  let sharp = null;
  try { sharp = (await import('sharp')).default; } catch { /* 可选依赖 */ }
  if (!sharp) return { ok: false, reason: 'sharp 不可用，跳过一致性抽检', checked: 0, skipped: clips.length, outliers: [] };

  const tmpDir = fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'phash-'));
  try {
    // 并发 4：ffmpeg 抽帧是进程启动开销，串行 33 镜要 ~30s，并发后 ~8s；命中缓存后近 0
    const results = await mapLimit(clips, 4, async (c) => {
      let p = resolveMediaPath(c.extra?.poster_path || '');
      const raster = /\.(png|jpe?g|webp|bmp|tiff?)$/i.test(p || '');
      let cacheKey = '';
      if (raster && fs.existsSync(p)) {
        cacheKey = `${p}|${fs.statSync(p).mtimeMs}`;
      } else {
        const video = resolveMediaPath(c.file_path || '');
        if (!video || !fs.existsSync(video)) return null;
        const dur = Math.max(0.1, (Number(c.src_out_ms) - Number(c.src_in_ms)) / 1000);
        const mid = Math.max(0, Number(c.src_in_ms) / 1000 + dur / 2);
        cacheKey = `${video}|${fs.statSync(video).mtimeMs}|${mid.toFixed(2)}`;
        if (!HASH_CACHE.has(cacheKey)) {
          const frame = path.join(tmpDir, `${String(c.id).replace(/[^\w.-]/g, '_')}.png`);
          try {
            await execFileP('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(mid), '-i', video, '-frames:v', '1', '-vf', 'scale=320:-2', frame]);
          } catch { return null; }
          if (!fs.existsSync(frame)) return null;
          p = frame;
        }
      }
      if (!HASH_CACHE.has(cacheKey)) {
        try { HASH_CACHE.set(cacheKey, await hashOfImage(sharp, p)); } catch { return null; }
      }
      return { clip_id: c.id, title: c.title, hash: HASH_CACHE.get(cacheKey) };
    });
    const items = results.filter(Boolean);
    const skipped = results.length - items.length;
    const hamming = (a, b) => { let x = a ^ b; let n = 0; while (x) { n += Number(x & 1n); x >>= 1n; } return n; };
    const ref = median(items.map((x) => x.hash));
    const outliers = items
      .map((x) => ({ clip_id: x.clip_id, title: x.title, distance: hamming(x.hash, ref) }))
      .filter((x) => x.distance > 20)
      .sort((a, b) => b.distance - a.distance);
    return { ok: true, checked: items.length, skipped, outliers, summary: { checked: items.length, skipped, outliers: outliers.length } };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

export { wrapText as wrapSubtitleText };
