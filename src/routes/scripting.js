// 剧本工厂增强路由（plain text module）

import { badRequest, notFound } from '../http.js';
import { all, get } from '../db.js';
import { adaptToProduction } from '../production-bridge.js';
import { refIntegrity, refRepair, promptAudit, promptRepair, promptProfessionalize } from '../script-integrity.js';
import {
  ensureScriptingSchema,
  snapshotEpisode,
  listSnapshots,
  restoreSnapshot,
  setShotLocked,
  updateShotPerformance,
  estimateEpisode,
} from '../scripting-schema.js';
import {
  ensureReviewSchema,
  setEpisodeReview,
  setShotReview,
  batchSetShotReview,
  reviewOverview,
  reviewGate,
} from '../script-review.js';
import { getBudget, setBudget, budgetCheck } from '../script-budget.js';
import { syncEpisodePerformances, speedForEmotion } from '../dub-bridge.js';

function param(ctx, name) {
  if (ctx?.params && typeof ctx.params === 'object') return ctx.params[name];
  return '';
}

function xml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function html(value) {
  return xml(value).replace(/\n/g, '<br>');
}

function safeJson(value, fallback) {
  try {
    if (value === null || value === undefined || value === '') return fallback;
    if (typeof value === 'object') return value;
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function fdxOf(scriptId, episodeCode = '') {
  const script = get('SELECT * FROM scripts WHERE id = ?', scriptId);
  if (!script) throw new Error('剧本不存在');
  const episodes = episodeCode
    ? all('SELECT * FROM script_episodes WHERE script_id = ? AND code = ?', scriptId, episodeCode)
    : all('SELECT * FROM script_episodes WHERE script_id = ? ORDER BY episode ASC', scriptId);
  const lines = [
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>',
    '<FinalDraft DocumentType="Script" Template="No Template" Version="1">',
    '  <Content>',
  ];
  for (const ep of episodes) {
    lines.push(`    <Paragraph Type="Scene Heading"><Text>${xml(`${ep.code} ${ep.title || ''}`)}</Text></Paragraph>`);
    if (ep.logline) lines.push(`    <Paragraph Type="Action"><Text>${xml(ep.logline)}</Text></Paragraph>`);
    const shots = all('SELECT * FROM shots WHERE episode_id = ? ORDER BY idx ASC', ep.id);
    let lastScene = '';
    for (const shot of shots) {
      const sceneKey = String(shot.scene_no || '');
      if (sceneKey && sceneKey !== lastScene) {
        lastScene = sceneKey;
        const heading = [shot.location_id || '', shot.time_of_day || '', shot.shot_size || ''].filter(Boolean).join(' · ');
        lines.push(`    <Paragraph Type="Scene Heading"><Text>${xml(heading || `场 ${sceneKey}`)}</Text></Paragraph>`);
      }
      if (shot.action) lines.push(`    <Paragraph Type="Action"><Text>${xml(shot.action)}</Text></Paragraph>`);
      if (shot.dialogue) {
        const speaker = shot.speaker || '角色';
        lines.push(`    <Paragraph Type="Character"><Text>${xml(speaker)}</Text></Paragraph>`);
        lines.push(`    <Paragraph Type="Dialogue"><Text>${xml(shot.dialogue)}</Text></Paragraph>`);
      }
    }
  }
  lines.push('  </Content>', '</FinalDraft>');
  return lines.join('\n');
}

function htmlOf(scriptId, episodeCode = '') {
  const script = get('SELECT * FROM scripts WHERE id = ?', scriptId);
  if (!script) throw new Error('剧本不存在');
  const episodes = episodeCode
    ? all('SELECT * FROM script_episodes WHERE script_id = ? AND code = ?', scriptId, episodeCode)
    : all('SELECT * FROM script_episodes WHERE script_id = ? ORDER BY episode ASC', scriptId);
  const parts = [
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
    `<title>${html(script.title)} · 剧本</title>`,
    `<style>
      @page { size: A4; margin: 18mm 16mm; }
      body { font-family: "Microsoft YaHei","Noto Sans CJK SC",sans-serif; color:#111; line-height:1.7; font-size:13px; }
      h1 { font-size:22px; margin:0 0 6px; } h2 { font-size:17px; margin:22px 0 8px; border-bottom:1px solid #999; padding-bottom:4px; }
      .meta { color:#555; margin-bottom:14px; } .scene { margin:14px 0 6px; font-weight:700; color:#333; }
      .shot { border-left:3px solid #ddd; padding:4px 0 4px 10px; margin:6px 0; page-break-inside:avoid; }
      .prompt { color:#555; font-size:11px; word-break:break-word; } .tag { display:inline-block; border:1px solid #bbb; border-radius:4px; padding:0 5px; margin-right:4px; font-size:11px; }
      @media print { .noprint { display:none; } }
    </style></head><body>`,
    '<div class="noprint" style="background:#fff7e6;border:1px solid #f0b060;padding:8px 10px;margin-bottom:12px">打印此页并选择「另存为 PDF」即可导出 PDF。</div>',
    `<h1>${html(script.title)}</h1>`,
    `<div class="meta">${html(script.id)} · ${html(script.format)} · 单集 ${script.episode_seconds}s · ${episodes.length} 集</div>`,
  ];
  for (const ep of episodes) {
    parts.push(`<h2>${html(ep.code)} ${html(ep.title || '')}</h2>`);
    if (ep.logline) parts.push(`<p>${html(ep.logline)}</p>`);
    if (ep.hook) parts.push(`<p><b>钩子：</b>${html(ep.hook)}</p>`);
    const shots = all('SELECT * FROM shots WHERE episode_id = ? ORDER BY idx ASC', ep.id);
    for (const shot of shots) {
      parts.push(`<div class="shot">`);
      parts.push(`<div><span class="tag">#${shot.idx}</span><span class="tag">${html(shot.shot_size || '')}</span><span class="tag">${html(shot.camera || '')} ${html(shot.move || '')}</span><span class="tag">${Number(shot.duration || 0).toFixed(1)}s</span></div>`);
      if (shot.action) parts.push(`<div>${html(shot.action)}</div>`);
      if (shot.dialogue) parts.push(`<div><b>${html(shot.speaker || '角色')}：</b>${html(shot.dialogue)}</div>`);
      if (shot.prompt_pos) parts.push(`<div class="prompt">POS: ${html(shot.prompt_pos)}</div>`);
      parts.push('</div>');
    }
  }
  parts.push('</body></html>');
  return parts.join('\n');
}

function timelineOf(scriptId, episodeCode = '') {
  const script = get('SELECT * FROM scripts WHERE id = ?', scriptId);
  if (!script) throw new Error('剧本不存在');
  const episodes = episodeCode
    ? all('SELECT * FROM script_episodes WHERE script_id = ? AND code = ?', scriptId, episodeCode)
    : all('SELECT * FROM script_episodes WHERE script_id = ? ORDER BY episode ASC', scriptId);
  const flat = [];
  let cursor = 0;
  for (const ep of episodes) {
    const shots = all('SELECT * FROM shots WHERE episode_id = ? ORDER BY idx ASC', ep.id);
    for (const shot of shots) {
      const dur = Number(shot.duration) || 0;
      flat.push({ ep, shot, start: cursor, dur });
      cursor += dur;
    }
  }
  return { script, episodes, flat, total: cursor };
}

function tc(seconds, fps, dropFrame = false) {
  const total = Math.max(0, Math.round((Number(seconds) || 0) * fps));
  const f = total % fps;
  const totalSec = Math.floor(total / fps);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(h)}:${p(m)}:${p(s)}${dropFrame ? ';' : ':'}${p(f)}`;
}

function otioOf(scriptId, episodeCode = '', fps = 24) {
  const { script, flat, total } = timelineOf(scriptId, episodeCode);
  const rt = (value) => ({ OTIO_SCHEMA: 'RationalTime.1', rate: fps, value: Number(value.toFixed(3)) });
  const clip = ({ ep, shot, start, dur }) => ({
    OTIO_SCHEMA: 'Clip.2',
    name: `${shot.idx}`,
    source_range: { OTIO_SCHEMA: 'TimeRange.1', start_time: rt(0), duration: rt(Math.round(dur * fps)) },
    metadata: {
      episode: ep.code,
      scene: shot.scene_no || '',
      shotSize: shot.shot_size || '',
      camera: shot.camera || '',
      move: shot.move || '',
      timeOfDay: shot.time_of_day || '',
      location: shot.location_id || '',
      characters: safeJson(shot.refs, {})?.characters || [],
      dialogue: shot.dialogue || '',
      action: shot.action || '',
      prompt_pos: shot.prompt_pos || '',
      prompt_neg: shot.prompt_neg || '',
      speaker: shot.speaker || '',
      emotion: shot.emotion || '',
      voice_id: shot.voice_id || '',
      shotId: shot.id,
    },
    markers: [
      { OTIO_SCHEMA: 'Marker.2', name: `${ep.code} #${shot.idx}`, range: { OTIO_SCHEMA: 'TimeRange.1', start_time: rt(0), duration: rt(Math.round(dur * fps)) } },
    ],
  });
  return JSON.stringify({
    OTIO_SCHEMA: 'Timeline.1',
    name: script.title || script.id,
    global_start_time: rt(0),
    metadata: { scriptId: script.id, fps, durationSeconds: Number(total.toFixed(3)), generatedBy: 'AI漫剧工厂 / 剧本工厂' },
    tracks: {
      OTIO_SCHEMA: 'Stack.1',
      name: 'tracks',
      children: [{ OTIO_SCHEMA: 'Track.1', name: 'V1', kind: 'Video', children: flat.map(clip) }],
    },
  }, null, 2);
}

function edlOf(scriptId, episodeCode = '', fps = 24) {
  const { script, flat } = timelineOf(scriptId, episodeCode);
  const lines = [`TITLE: ${String(script.title || script.id).replace(/[\r\n]+/g, ' ').slice(0, 70)}`, 'FCM: NON-DROP FRAME', ''];
  flat.forEach((item, i) => {
    const { shot, start, dur } = item;
    const n = String(i + 1).padStart(3, '0');
    const srcIn = tc(0, fps);
    const srcOut = tc(dur, fps);
    const recIn = tc(start, fps);
    const recOut = tc(start + dur, fps);
    lines.push(`${n}  AX       V     C        ${srcIn} ${srcOut} ${recIn} ${recOut}`);
    lines.push(`* FROM CLIP NAME: #${shot.idx} ${shot.shot_size || ''} ${shot.camera || ''} ${shot.move || ''}`.trim());
    if (shot.dialogue) lines.push(`* COMMENT: ${shot.speaker ? `${shot.speaker}: ` : ''}${String(shot.dialogue).replace(/[\r\n]+/g, ' ')}`);
    if (item.ep.code) lines.push(`* SOURCE EPISODE: ${item.ep.code}`);
    lines.push('');
  });
  return lines.join('\n');
}

function fcpxmlOf(scriptId, episodeCode = '', fps = 24) {
  const { script, flat, total } = timelineOf(scriptId, episodeCode);
  const frameDur = `1/${fps}s`;
  const body = flat.map(({ ep, shot, start, dur }) => {
    const offsetFrames = Math.round(start * fps);
    const durationFrames = Math.round(dur * fps);
    return `        <asset-clip name="#${shot.idx} ${xml(shot.shot_size || '')}" offset="${offsetFrames}/${fps}s" duration="${durationFrames}/${fps}s" start="0/${fps}s" tcFormat="NDF" audioRole="dialogue">
          <note>${xml([ep.code, shot.scene_no && `场${shot.scene_no}`, shot.camera, shot.move, shot.dialogue && (shot.speaker ? `${shot.speaker}: ${shot.dialogue}` : shot.dialogue)].filter(Boolean).join(' · '))}</note>
        </asset-clip>`;
  }).join('\n');
  const totalFrames = Math.round(total * fps);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE fcpxml>',
    '<fcpxml version="1.10">',
    '  <resources>',
    `    <format id="r1" name="FFVideoFormat_${1080}p${fps}" frameDuration="${frameDur}" width="1080" height="1920"/>`,
    '  </resources>',
    '  <library>',
    '    <event name="AI漫剧工厂">',
    `      <project name="${xml(script.title || script.id)}">`,
    `        <sequence format="r1" duration="${totalFrames}/${fps}s" tcStart="0/${fps}s" tcFormat="NDF">`,
    '          <spine>',
    body,
    '          </spine>',
    '        </sequence>',
    '      </project>',
    '    </event>',
    '  </library>',
    '</fcpxml>',
  ].join('\n');
}

export function registerScriptingRoutes(app) {
  ensureScriptingSchema();
  ensureReviewSchema();

  app.post('/api/adapt/projects/:id/to-production', async (ctx) => {
    try {
      const result = await adaptToProduction(param(ctx, 'id'), (await ctx.body()) || {});
      ctx.json(result);
    } catch (err) {
      throw badRequest(err.message || '改编项目物化失败');
    }
  });

  app.get('/api/scripts/:id/ref-integrity', async (ctx) => {
    try { ctx.json(refIntegrity(param(ctx, 'id'))); }
    catch (err) { throw badRequest(err.message || '引用体检失败'); }
  });

  app.post('/api/scripts/:id/ref-repair', async (ctx) => {
    try { ctx.json(refRepair(param(ctx, 'id'))); }
    catch (err) { throw badRequest(err.message || '引用修复失败'); }
  });

  app.get('/api/scripts/:id/prompt-audit', async (ctx) => {
    try { ctx.json(promptAudit(param(ctx, 'id'), String(ctx.query?.episode || ''))); }
    catch (err) { throw badRequest(err.message || '提示词体检失败'); }
  });

  app.post('/api/scripts/:id/prompt-repair', async (ctx) => {
    try {
      const body = (await ctx.body()) || {};
      ctx.json(promptRepair(param(ctx, 'id'), String(body.episode || '')));
    } catch (err) { throw badRequest(err.message || '提示词修复失败'); }
  });

  app.post('/api/scripts/:id/prompt-professionalize', async (ctx) => {
    try {
      const body = (await ctx.body()) || {};
      ctx.json(promptProfessionalize(param(ctx, 'id'), String(body.episode || '')));
    } catch (err) { throw badRequest(err.message || '提示词专业化失败'); }
  });

  app.get('/api/scripts/:id/snapshots', async (ctx) => {
    try {
      ctx.json({ ok: true, snapshots: listSnapshots(param(ctx, 'id'), { episodeCode: String(ctx.query?.episode || ''), kind: String(ctx.query?.kind || '') }) });
    } catch (err) { throw badRequest(err.message || '读取快照失败'); }
  });

  app.post('/api/scripts/:id/snapshots', async (ctx) => {
    try {
      const body = (await ctx.body()) || {};
      ctx.json(snapshotEpisode(param(ctx, 'id'), String(body.episode || ''), body));
    } catch (err) { throw badRequest(err.message || '保存快照失败'); }
  });

  app.post('/api/scripts/:id/snapshots/:snapshotId/restore', async (ctx) => {
    try {
      const body = (await ctx.body()) || {};
      ctx.json(restoreSnapshot(param(ctx, 'snapshotId'), { keepLocked: body.keepLocked !== false }));
    } catch (err) { throw badRequest(err.message || '恢复快照失败'); }
  });

  app.put('/api/scripts/:id/shots/:shotId/lock', async (ctx) => {
    try {
      const body = (await ctx.body()) || {};
      ctx.json(setShotLocked(param(ctx, 'id'), param(ctx, 'shotId'), body.locked !== false));
    } catch (err) { throw badRequest(err.message || '镜头锁定失败'); }
  });

  app.put('/api/scripts/:id/shots/:shotId/performance', async (ctx) => {
    try {
      const body = (await ctx.body()) || {};
      ctx.json(updateShotPerformance(param(ctx, 'id'), param(ctx, 'shotId'), body));
    } catch (err) { throw badRequest(err.message || '声音元数据保存失败'); }
  });

  app.get('/api/scripts/:id/estimate', async (ctx) => {
    try { ctx.json(estimateEpisode(param(ctx, 'id'), String(ctx.query?.episode || ''))); }
    catch (err) { throw badRequest(err.message || '预估失败'); }
  });

  // ---- 审核流程：draft → review → approved → locked ----
  app.get('/api/scripts/:id/review', async (ctx) => {
    try { ctx.json(reviewOverview(param(ctx, 'id'))); }
    catch (err) { throw badRequest(err.message || '读取审核状态失败'); }
  });

  app.get('/api/scripts/:id/review-gate', async (ctx) => {
    try {
      const codes = String(ctx.query?.episode || '').split(',').map((x) => x.trim()).filter(Boolean);
      ctx.json(reviewGate(param(ctx, 'id'), codes));
    } catch (err) { throw badRequest(err.message || '审核前置校验失败'); }
  });

  app.post('/api/scripts/:id/episodes/:code/review', async (ctx) => {
    try {
      const body = (await ctx.body()) || {};
      ctx.json(setEpisodeReview(param(ctx, 'id'), String(body.code || param(ctx, 'code')), body));
    } catch (err) { throw badRequest(err.message || '提交单集审核失败'); }
  });

  app.post('/api/scripts/:id/episodes/:code/review-batch', async (ctx) => {
    try {
      const body = (await ctx.body()) || {};
      ctx.json(batchSetShotReview(param(ctx, 'id'), String(body.code || param(ctx, 'code')), body));
    } catch (err) { throw badRequest(err.message || '批量审核镜头失败'); }
  });

  app.post('/api/scripts/:id/shots/:shotId/review', async (ctx) => {
    try {
      const body = (await ctx.body()) || {};
      ctx.json(setShotReview(param(ctx, 'id'), param(ctx, 'shotId'), body));
    } catch (err) { throw badRequest(err.message || '镜头审核失败'); }
  });

  // ---- 项目预算 ----
  app.get('/api/scripts/:id/budget', async (ctx) => {
    try { ctx.json({ ok: true, budget: getBudget(param(ctx, 'id')) }); }
    catch (err) { throw badRequest(err.message || '读取预算失败'); }
  });

  app.post('/api/scripts/:id/budget', async (ctx) => {
    try {
      const body = (await ctx.body()) || {};
      ctx.json(setBudget(param(ctx, 'id'), body));
    } catch (err) { throw badRequest(err.message || '保存预算失败'); }
  });

  app.post('/api/scripts/:id/budget/check', async (ctx) => {
    try {
      const body = (await ctx.body()) || {};
      ctx.json(budgetCheck(param(ctx, 'id'), {
        codes: Array.isArray(body.codes) ? body.codes.map(String) : (body.codes ? [String(body.codes)] : []),
        stages: Array.isArray(body.stages) ? body.stages : [],
        confirm: Boolean(body.confirm),
      }));
    } catch (err) { throw badRequest(err.message || '预算校验失败'); }
  });

  // ---- 配音表演桥：说话人 / 情绪 / 音色 ----
  app.post('/api/scripts/:id/performance/sync', async (ctx) => {
    try {
      const body = (await ctx.body()) || {};
      ctx.json(syncEpisodePerformances(param(ctx, 'id'), String(body.episode || '')));
    } catch (err) { throw badRequest(err.message || '同步说话人失败'); }
  });

  app.get('/api/scripts/:id/emotion-speeds', async (ctx) => {
    try { ctx.json({ ok: true, speeds: { 平静: speedForEmotion('平静'), 紧张: speedForEmotion('紧张'), 愤怒: speedForEmotion('愤怒'), 悲伤: speedForEmotion('悲伤') } }); }
    catch (err) { throw badRequest(err.message || '读取情绪语速失败'); }
  });

  app.get('/api/scripts/:id/export-ext', async (ctx) => {
    const format = String(ctx.query?.format || 'fdx').toLowerCase();
    const episode = String(ctx.query?.episode || '');
    try {
      if (format === 'fdx') {
        const body = Buffer.from(fdxOf(param(ctx, 'id'), episode), 'utf8');
        ctx.res.writeHead(200, {
          'content-type': 'application/xml; charset=utf-8',
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${param(ctx, 'id')}.fdx`)}`,
          'content-length': body.length,
        });
        return ctx.res.end(body);
      }
      if (format === 'html') {
        const body = Buffer.from(htmlOf(param(ctx, 'id'), episode), 'utf8');
        ctx.res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': body.length });
        return ctx.res.end(body);
      }
      if (format === 'otio') {
        const body = Buffer.from(otioOf(param(ctx, 'id'), episode), 'utf8');
        ctx.res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${param(ctx, 'id')}.otio`)}`,
          'content-length': body.length,
        });
        return ctx.res.end(body);
      }
      if (format === 'edl') {
        const body = Buffer.from(edlOf(param(ctx, 'id'), episode), 'utf8');
        ctx.res.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${param(ctx, 'id')}.edl`)}`,
          'content-length': body.length,
        });
        return ctx.res.end(body);
      }
      if (format === 'fcpxml') {
        const body = Buffer.from(fcpxmlOf(param(ctx, 'id'), episode), 'utf8');
        ctx.res.writeHead(200, {
          'content-type': 'application/xml; charset=utf-8',
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${param(ctx, 'id')}.fcpxml`)}`,
          'content-length': body.length,
        });
        return ctx.res.end(body);
      }
      throw badRequest(`不支持的扩展导出格式：${format}（可用 fdx / html / otio / edl / fcpxml）`);
    } catch (err) {
      throw badRequest(err.message || '导出失败');
    }
  });
}
