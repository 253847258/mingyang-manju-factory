// 后期精修 · 专业 NLE 回灌（FCP7 XML / OTIO → 差异计划 → 应用）
// 纯解析 + 差异计算；应用时才写库（由路由显式调用）。

import fs from 'node:fs';
import path from 'node:path';
import { detectInterchange, parseFcp7Xml, parseOtio } from './interchange-import.js';
import { getTimelineDoc, saveTimelineDoc, resolveMediaPath, EDIT_ROOT } from './edit-timeline.js';

const FRAME_MS = 1000 / 30;
const EPS = FRAME_MS * 1.5;

const keyOf = (v) => String(v || '')
  .replace(/^.*[\\/]/, '')
  .replace(/\.[A-Za-z0-9]{1,6}$/, '')
  .toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, '');

export function parseImport(content) {
  const kind = detectInterchange(content);
  if (!kind) return { ok: false, error: '无法识别格式：请粘贴 FCP7 XML（xmeml）或 OTIO JSON' };
  let r;
  try {
    r = kind === 'fcp7' ? parseFcp7Xml(content) : parseOtio(content);
  } catch (e) {
    return { ok: false, error: `解析失败：${e.message}` };
  }
  if (!r.ok) return { ok: false, error: (r.warnings || []).join('；') || '解析失败' };
  const fps = Number(r.fps) || 30;
  // FCP7 解析器不读 <in>：用我们导出的 edit-in 标记兜底恢复裁剪入点
  for (const c of r.clips) {
    const mk = (c.markers || []).find((m) => String(m.name || '').trim() === 'edit-in');
    if (mk && (!(Number(c.sourceIn) > 0))) {
      const frames = Number(String(mk.comment || '').trim());
      if (Number.isFinite(frames) && frames > 0) c.sourceIn = frames / fps;
    }
  }
  const clips = [...r.clips].sort((a, b) => (Number(a.start) || 0) - (Number(b.start) || 0));
  return { ok: true, format: kind, fps, clips, warnings: r.warnings || [] };
}

function usableFile(file) {
  const s = String(file || '').trim();
  if (!s) return '';
  const abs = path.isAbsolute(s) ? s : path.join(EDIT_ROOT, s);
  return fs.existsSync(abs) ? abs : '';
}

export function diffTimeline(doc, parsed) {
  const main = doc.tracks.find((t) => t.kind === 'main');
  const current = [...(main?.clips || [])].sort((a, b) => a.order_index - b.order_index);
  const imported = parsed.clips || [];
  const used = new Set();

  const byFile = new Map();
  for (const c of current) {
    const k = keyOf(c.file_path);
    if (k && !byFile.has(k)) byFile.set(k, c);
  }

  const rows = imported.map((ic, i) => {
    const kFile = keyOf(ic.file);
    const kName = keyOf(ic.name);
    let hit = byFile.get(kFile);
    let by = 'file';
    if (!hit || used.has(hit)) {
      hit = current.find((c) => !used.has(c) && keyOf(c.title) === kName);
      by = 'name';
    }
    if (!hit || used.has(hit)) { hit = null; by = ''; }
    if (hit) used.add(hit);
    return {
      index: i,
      name: String(ic.name || ''),
      file: String(ic.file || ''),
      start: Number(ic.start) || 0,
      duration: Number(ic.duration) || 0,
      sourceInMs: Math.max(0, Math.round((Number(ic.sourceIn) || 0) * 1000)),
      matchId: hit?.id || null,
      matchBy: by,
      match: hit || null,
    };
  });

  const added = rows.filter((r) => !r.match).map((r) => ({ index: r.index, name: r.name, file: r.file, duration: r.duration }));
  const removed = current.filter((c) => !used.has(c)).map((c) => ({ id: c.id, title: c.title, shot_id: c.shot_id }));

  const matched = rows.filter((r) => r.match);
  const currentOrder = matched.map((r) => r.match.id);
  const sortedByCurrent = [...matched].sort((a, b) => current.indexOf(a.match) - current.indexOf(b.match));
  const reordered = sortedByCurrent
    .filter((r, i) => r.match.id !== currentOrder[i])
    .map((r) => ({ id: r.match.id, title: r.match.title, from: current.indexOf(r.match), to: matched.indexOf(r) }));

  const trimmed = [];
  for (const r of matched) {
    const c = r.match;
    const durMs = Math.max(0, Math.round(r.duration * 1000));
    const curDur = Math.max(0, Number(c.src_out_ms) - Number(c.src_in_ms));
    const durChanged = Math.abs(durMs - curDur) > EPS;
    const inChanged = Math.abs(r.sourceInMs - Number(c.src_in_ms)) > EPS;
    // 旧版导出器会丢掉 sourceIn（恒为 0）：只有时长也变了才算裁剪，避免误报
    const inReal = inChanged && (r.sourceInMs > 0 || durChanged);
    if (durChanged || inReal) {
      trimmed.push({
        id: c.id, title: c.title,
        fromMs: Number(c.src_in_ms), toMs: r.sourceInMs,
        fromDur: curDur, toDur: durMs,
      });
    }
  }

  return {
    ok: true,
    format: parsed.format,
    fps: parsed.fps || 30,
    warnings: parsed.warnings || [],
    total: { current: current.length, imported: imported.length },
    added, removed, reordered, trimmed,
    rows: rows.map((r) => ({
      index: r.index, name: r.name, duration: r.duration,
      matched: !!r.match, matchBy: r.matchBy, matchId: r.matchId,
      file: r.file, fileExists: !!usableFile(r.file),
    })),
    changed: !!(added.length || removed.length || reordered.length || trimmed.length),
  };
}

export function applyImport(timelineId, { content, docVersion, operator = '未署名' }) {
  const doc = getTimelineDoc(timelineId);
  if (!doc) throw new Error('时间线不存在');
  const parsed = parseImport(content);
  if (!parsed.ok) throw new Error(parsed.error);
  const diff = diffTimeline(doc, parsed);
  if (!diff.changed) return { ok: true, changed: false, doc, diff };

  const main = doc.tracks.find((t) => t.kind === 'main');
  const current = [...(main.clips || [])].sort((a, b) => a.order_index - b.order_index);
  const byId = new Map(current.map((c) => [c.id, c]));

  let cursor = 0;
  const nextClips = diff.rows.map((r, i) => {
    const base = r.matchId ? byId.get(r.matchId) : null;
    const durMs = Math.max(100, Math.round((r.duration || 0) * 1000));
    const clip = base
      ? { ...base }
      : {
        id: `CL-${Date.now().toString(36)}${i}`,
        shot_id: null, render_id: null, file_path: '', poster_path: '',
        gain_db: 0, speed: 1, transition_in: i === 0 ? 'cut' : 'cut', transition_ms: 0,
        subtitle_text: '', title: r.name || `片段${i + 1}`,
      };
    const abs = usableFile(r.file);
    if (abs) clip.file_path = abs;
    clip.order_index = i;
    clip.start_ms = cursor;
    clip.src_in_ms = r.sourceInMs > 0 ? r.sourceInMs : 0;
    clip.src_out_ms = clip.src_in_ms + durMs;
    if (r.name) clip.title = r.name;
    cursor += durMs;
    return clip;
  });

  const tracks = doc.tracks.map((t) => (t.kind === 'main' ? { ...t, clips: nextClips } : t));
  const saved = saveTimelineDoc(timelineId, { tracks }, { docVersion, operator });
  return { ok: true, changed: true, doc: saved, diff };
}
