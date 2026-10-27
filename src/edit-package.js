// 后期精修 · 工程包（代理素材 + EDL/FCP7/OTIO + 素材清单）
// 全部本地 ffmpeg/zip，零 API 费用。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { getTimelineDoc, resolveMediaPath, EDIT_ROOT } from './edit-timeline.js';
import { all } from './db.js';
const FPS = 30;

// ---------- 自建交换格式（保留 in/out，现有 interchange 导出会丢裁剪入点） ----------
const xmlEsc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const framesOf = (ms, fps) => Math.max(0, Math.round((Number(ms) || 0) / 1000 * fps));
function tcOf(frames, fps) {
  const f = Math.max(0, Math.round(frames));
  const ff = f % fps;
  const total = Math.floor(f / fps);
  const ss = total % 60;
  const mm = Math.floor(total / 60) % 60;
  const hh = Math.floor(total / 3600);
  return [hh, mm, ss, ff].map((n) => String(n).padStart(2, '0')).join(':');
}
function pathUrl(abs) {
  return `file://localhost${String(abs).split('/').map((seg) => encodeURIComponent(seg)).join('/')}`;
}

export function buildEdl(clips, { title = 'timeline', fps = FPS } = {}) {
  const lines = [`TITLE: ${title}`, 'FCM: NON-DROP FRAME', ''];
  let rec = 0;
  clips.forEach((c, i) => {
    const inF = framesOf(c.src_in_ms, fps);
    const outF = framesOf(c.src_out_ms, fps);
    const dur = Math.max(1, outF - inF);
    lines.push(`${String(i + 1).padStart(3, '0')}  AX       V     C        ${tcOf(inF, fps)} ${tcOf(outF, fps)} ${tcOf(rec, fps)} ${tcOf(rec + dur, fps)}`);
    lines.push(`* FROM CLIP NAME: ${path.basename(c.file || c.name || `clip_${i + 1}`)}`);
    if (c.dialogue) lines.push(`* COMMENT: ${c.dialogue}`);
    lines.push('');
    rec += dur;
  });
  return lines.join('\n');
}

export function buildFcp7(clips, { title = 'timeline', fps = FPS, width = 1920, height = 1080 } = {}) {
  let rec = 0;
  const items = clips.map((c, i) => {
    const inF = framesOf(c.src_in_ms, fps);
    const outF = framesOf(c.src_out_ms, fps);
    const dur = Math.max(1, outF - inF);
    const start = rec;
    rec += dur;
    const file = path.basename(c.file || `clip_${i + 1}`);
    return `      <clipitem id="clipitem-${i + 1}">
        <name>${xmlEsc(c.name || file)}</name>
        <duration>${dur}</duration>
        <rate><timebase>${fps}</timebase><ntsc>FALSE</ntsc></rate>
        <start>${start}</start>
        <end>${rec}</end>
        <in>${inF}</in>
        <out>${outF}</out>
        <marker><name>edit-in</name><comment>${inF}</comment><in>0</in><out>-1</out></marker>
        <file id="file-${i + 1}">
          <name>${xmlEsc(file)}</name>
          <pathurl>${xmlEsc(pathUrl(c.file || ''))}</pathurl>
          <rate><timebase>${fps}</timebase><ntsc>FALSE</ntsc></rate>
          <duration>${outF}</duration>
        </file>
      </clipitem>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
  <sequence id="sequence-1">
    <name>${xmlEsc(title)}</name>
    <duration>${rec}</duration>
    <rate><timebase>${fps}</timebase><ntsc>FALSE</ntsc></rate>
    <media>
      <video>
        <format><samplecharacteristics><width>${width}</width><height>${height}</height></samplecharacteristics></format>
        <track>
${items}
        </track>
      </video>
    </media>
  </sequence>
</xmeml>
`;
}

export function buildOtio(clips, { title = 'timeline', fps = FPS } = {}) {
  const rt = (value) => ({ OTIO_SCHEMA: 'RationalTime.1', rate: fps, value });
  const children = clips.map((c) => {
    const inF = framesOf(c.src_in_ms, fps);
    const outF = framesOf(c.src_out_ms, fps);
    return {
      OTIO_SCHEMA: 'Clip.1',
      name: c.name || path.basename(c.file || 'clip'),
      source_range: { OTIO_SCHEMA: 'TimeRange.1', start_time: rt(inF), duration: rt(Math.max(1, outF - inF)) },
      media_reference: {
        OTIO_SCHEMA: 'ExternalReference.1',
        target_url: pathUrl(c.file || ''),
        available_range: { OTIO_SCHEMA: 'TimeRange.1', start_time: rt(0), duration: rt(Math.max(1, outF)) },
      },
    };
  });
  return JSON.stringify({
    OTIO_SCHEMA: 'Timeline.1',
    name: title,
    global_start_time: rt(0),
    tracks: {
      OTIO_SCHEMA: 'Stack.1',
      children: [{ OTIO_SCHEMA: 'Track.1', name: 'V1', kind: 'Video', children }],
    },
  }, null, 2);
}

export function interchangeClips(doc) {
  const main = doc.tracks.find((t) => t.kind === 'main');
  return [...(main?.clips || [])]
    .sort((a, b) => a.order_index - b.order_index)
    .map((c) => ({
      file: resolveMediaPath(c.file_path) || c.file_path || '',
      duration: Math.max(0.1, (Number(c.src_out_ms) - Number(c.src_in_ms)) / 1000),
      name: c.title || c.shot_id || c.id,
      action: '',
      dialogue: c.subtitle_text || '',
      shot_id: c.shot_id,
      src_in_ms: Number(c.src_in_ms) || 0,
      src_out_ms: Number(c.src_out_ms) || 0,
    }));
}

function proxyName(file, height) {
  const base = path.basename(file).replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_');
  const hash = crypto.createHash('sha1').update(file).digest('hex').slice(0, 10);
  return `${base}_${hash}_${height}p.mp4`;
}

export function buildProxies(doc, { height = 540, onStep = () => {} } = {}) {
  const clips = interchangeClips(doc);
  const dir = path.join(EDIT_ROOT, 'data', 'proxies');
  fs.mkdirSync(dir, { recursive: true });
  const map = new Map();
  const uniq = [...new Set(clips.map((c) => c.file).filter(Boolean))];
  uniq.forEach((file, i) => {
    if (!fs.existsSync(file)) return;
    const out = path.join(dir, proxyName(file, height));
    if (fs.existsSync(out) && fs.statSync(out).size > 0) { map.set(file, out); return; }
    onStep({ phase: 'proxy', index: i + 1, total: uniq.length, file: path.basename(file) });
    const r = spawnSync('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error', '-i', file,
      '-vf', `scale=-2:${height}:force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24',
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out,
    ], { encoding: 'utf8' });
    if (r.status !== 0) {
      throw new Error(`代理转码失败（${path.basename(file)}）：${String(r.stderr || '').trim().split('\n').slice(-2).join(' | ')}`);
    }
    map.set(file, out);
  });
  return map;
}

function manifestOf(doc, clips, proxyMap, height) {
  return {
    package: 'edit-timeline',
    timeline_id: doc.timeline.id,
    code: doc.timeline.code,
    title: doc.timeline.title || doc.timeline.code,
    doc_version: doc.timeline.doc_version,
    status: doc.timeline.status,
    fps: FPS,
    proxy_height: proxyMap.size ? height : 0,
    clip_count: clips.length,
    created_at: new Date().toISOString(),
    clips: clips.map((c, i) => ({
      index: i + 1,
      name: c.name,
      shot_id: c.shot_id,
      source: c.file,
      proxy: proxyMap.get(c.file) || '',
      in_ms: c.src_in_ms,
      out_ms: c.src_out_ms,
      duration_sec: Number(c.duration.toFixed(3)),
      dialogue: c.dialogue || '',
    })),
    proxies: [...proxyMap.entries()].map(([src, out]) => ({
      source: src,
      proxy: out,
      size: fs.existsSync(out) ? fs.statSync(out).size : 0,
    })),
  };
}

function csvOf(manifest) {
  const head = 'index,name,shot_id,source,proxy,in_ms,out_ms,duration_sec';
  const rows = manifest.clips.map((c) => [c.index, c.name, c.shot_id, c.source, c.proxy, c.in_ms, c.out_ms, c.duration_sec]
    .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','));
  return [head, ...rows].join('\n');
}

export function buildEditPackage(timelineId, { operator = '未署名', withProxy = true, height = 540, onStep = () => {} } = {}) {
  const doc = getTimelineDoc(timelineId);
  if (!doc) throw new Error('时间线不存在');
  const clips = interchangeClips(doc);
  if (!clips.length) throw new Error('主轨为空，无法导出工程包');

  onStep({ phase: 'timeline', message: '生成 EDL / FCP7 / OTIO' });
  const title = doc.timeline.title || doc.timeline.code;
  const bundle = {
    edl: buildEdl(clips, { title, fps: FPS }),
    fcp7: buildFcp7(clips, { title, fps: FPS }),
    otio: buildOtio(clips, { title, fps: FPS }),
    totalSeconds: clips.reduce((a, c) => a + c.duration, 0),
  };

  let proxyMap = new Map();
  if (withProxy) proxyMap = buildProxies(doc, { height, onStep });

  const manifest = manifestOf(doc, clips, proxyMap, height);
  // 占位产物门禁：交付包必须显式标注是否含占位素材
  try {
    const renderIds = [...new Set(((doc.tracks.find((t) => t.kind === 'main')?.clips) || []).map((c) => c.render_id).filter(Boolean))];
    const rows = renderIds.length ? all(`SELECT backend FROM shot_renders WHERE id IN (${renderIds.map(() => '?').join(',')})`, ...renderIds) : [];
    manifest.placeholder_clips = rows.filter((r) => /placeholder|local-image/i.test(String(r.backend || ''))).length;
    manifest.placeholder = manifest.placeholder_clips > 0;
  } catch { manifest.placeholder = false; manifest.placeholder_clips = 0; }
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'editpkg-'));
  try {
    fs.writeFileSync(path.join(staging, 'timeline.edl'), bundle.edl, 'utf8');
    fs.writeFileSync(path.join(staging, 'timeline.xml'), bundle.fcp7, 'utf8');
    fs.writeFileSync(path.join(staging, 'timeline.otio'), bundle.otio, 'utf8');
    fs.writeFileSync(path.join(staging, 'timeline.json'), JSON.stringify(doc, null, 2), 'utf8');
    fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    fs.writeFileSync(path.join(staging, 'manifest.csv'), csvOf(manifest), 'utf8');
    fs.writeFileSync(path.join(staging, 'README.txt'), [
      `后期工程包 · ${manifest.code}`,
      `时间线 ${manifest.timeline_id} · v${manifest.doc_version} · ${manifest.clip_count} 个片段 · ${bundle.totalSeconds}s`,
      '',
      '怎么用：',
      '1) 剪映专业版 / Premiere / DaVinci / FCP：导入 timeline.xml（FCP7）或 timeline.otio',
      '2) 素材重链接：优先用 proxies/ 里的 540p 代理（时间轴完全一致），成片前再换回源素材',
      '3) 回灌：在 NLE 里改完顺序/裁剪后，导出 FCP7 XML 或 OTIO，回到系统「后期精修 → 导入时间线」',
      '',
      '文件说明：',
      '  timeline.edl   CMX3600（剪辑点清单）',
      '  timeline.xml   FCP7 XML（xmeml v4）',
      '  timeline.otio  OpenTimelineIO',
      '  timeline.json  系统内部时间线（含画中画/字幕/音量）',
      '  manifest.json  素材映射（源文件 ↔ 代理）',
      '  manifest.csv   同上，表格版',
      ...(manifest.placeholder ? ['', `⚠️ 警告：本包包含 ${manifest.placeholder_clips} 个占位镜头（backend=placeholder/local-image），不可作为最终交付片。`] : []),
    ].join('\n'), 'utf8');

    if (proxyMap.size) {
      const pdir = path.join(staging, 'proxies');
      fs.mkdirSync(pdir, { recursive: true });
      for (const [src, out] of proxyMap.entries()) {
        if (fs.existsSync(out)) fs.copyFileSync(out, path.join(pdir, path.basename(out)));
      }
    }

    const outDir = path.join(EDIT_ROOT, 'data', 'deliveries');
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const base = `edit-${String(doc.timeline.code || 'timeline').replace(/[^\w.-]/g, '_')}-${stamp}`;
    const zipPath = path.join(outDir, `${base}.zip`);
    const zr = spawnSync('zip', ['-r', '-q', '-X', zipPath, '.'], { cwd: staging, encoding: 'utf8' });
    if (zr.status !== 0) throw new Error(`打包失败：${String(zr.stderr || '').trim().slice(-200)}`);
    const size = fs.statSync(zipPath).size;
    const entries = clips.length + proxyMap.size + 7;
    return {
      ok: true,
      file: path.relative(EDIT_ROOT, zipPath),
      absFile: zipPath,
      size,
      clipCount: clips.length,
      proxyCount: proxyMap.size,
      totalSeconds: bundle.totalSeconds,
      entries,
      manifest,
      operator,
    };
  } finally {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
