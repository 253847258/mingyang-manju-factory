// 交付硬门禁：必须绑定已锁定成片版本，并满足审片与 QC 条件。

import { all, get } from './db.js';
import { listComments } from './edit-timeline.js';
import { qcEpisode } from './qc.js';

const text = (value, max = 120) => String(value ?? '').trim().slice(0, max);

export function isDeliveryDownload(url) {
  const pathname = String(url || '').split('?')[0];
  return pathname === '/api/render/deliver';
}

export function isProductionDeliveryDownload(url) {
  return Boolean(productionDeliveryId(url));
}

export function productionDeliveryId(url) {
  const pathname = String(url || '').split('?')[0];
  const match = pathname.match(/^\/api\/studio\/productions\/([^/]+)\/delivery$/);
  return match ? decodeURIComponent(match[1]) : '';
}

function findTimeline({ scriptId, code, timelineId }) {
  if (timelineId) return get('SELECT * FROM edit_timelines WHERE id=?', timelineId);
  return get(
    `SELECT * FROM edit_timelines WHERE code=? ${scriptId ? 'AND script_id=?' : ''}
     ORDER BY rowid DESC LIMIT 1`,
    code, ...(scriptId ? [scriptId] : []),
  );
}

function filmOf(timeline, versionNo = null) {
  if (!timeline) return null;
  return versionNo
    ? get('SELECT * FROM episode_films WHERE timeline_id=? AND version_no=? ORDER BY rowid DESC LIMIT 1', timeline.id, Number(versionNo))
    : get('SELECT * FROM episode_films WHERE timeline_id=? ORDER BY version_no DESC, rowid DESC LIMIT 1', timeline.id);
}

export async function checkDeliveryGate({ scriptId = '', code = '', timelineId = '', versionNo = null } = {}) {
  const sid = text(scriptId);
  const episodeCode = text(code);
  if (!episodeCode) return { ok: false, gate: 'delivery', error: '交付缺少剧集 code' };
  const timeline = findTimeline({ scriptId: sid, code: episodeCode, timelineId: text(timelineId) });
  if (!timeline) return { ok: false, gate: 'delivery-version', error: '没有找到该集已锁定的后期时间线，禁止交付' };
  if (timeline.status !== 'locked') {
    return { ok: false, gate: 'delivery-version', error: `时间线尚未锁定（当前：${timeline.status}），禁止交付`, timelineId: timeline.id };
  }
  const film = filmOf(timeline, versionNo);
  if (!film) return { ok: false, gate: 'delivery-version', error: '锁定时间线没有可播放成片，禁止交付', timelineId: timeline.id };
  const latestFilm = get(
    'SELECT * FROM episode_films WHERE script_id=? AND code=? ORDER BY rowid DESC LIMIT 1',
    sid || timeline.script_id, episodeCode,
  );
  if (latestFilm && latestFilm.id !== film.id) {
    return {
      ok: false,
      gate: 'delivery-version',
      error: `最新成片 ${latestFilm.id} 不是锁定版本 ${film.id}；请先锁定最新版或明确选择交付版本`,
      timelineId: timeline.id,
      filmId: film.id,
    };
  }
  const comments = listComments(timeline.id);
  const open = comments.filter((x) => ['open', 'pending'].includes(String(x.status || 'open')) && ['blocker', 'major'].includes(x.severity));
  if (open.length) {
    return { ok: false, gate: 'delivery-review', error: `还有 ${open.length} 条未关闭的 blocker/major 审片意见`, timelineId: timeline.id, filmId: film.id };
  }
  let qc;
  try {
    qc = await qcEpisode({ scriptId: sid || timeline.script_id, code: episodeCode });
  } catch (error) {
    return { ok: false, gate: 'delivery-qc', error: `交付前 QC 失败：${error.message || error}`, timelineId: timeline.id, filmId: film.id };
  }
  if (String(qc?.verdict || '').toLowerCase() === 'error') {
    return { ok: false, gate: 'delivery-qc', error: 'QC 结果为 error，禁止交付', timelineId: timeline.id, filmId: film.id, qc };
  }
  return {
    ok: true,
    gate: 'delivery',
    timelineId: timeline.id,
    versionNo: film.version_no,
    filmId: film.id,
    reviewStatus: timeline.status,
    qcVerdict: qc?.verdict || 'warn',
    film,
  };
}

export async function checkProductionDeliveryGate(productionId) {
  const id = text(productionId);
  if (!id) return { ok: false, gate: 'delivery-version', error: '缺少制片项目 id' };
  const { getProduction } = await import('./studio.js');
  const production = getProduction(id);
  if (!production) return { ok: false, gate: 'delivery-version', error: `制片项目不存在：${id}` };
  if (!production.script_id) return { ok: false, gate: 'delivery-version', error: '制片项目还没有剧本，禁止交付' };
  const codes = all(
    `SELECT DISTINCT code FROM episode_films
     WHERE script_id=? AND code IS NOT NULL AND TRIM(code)<>'' ORDER BY code`,
    production.script_id,
  ).map((row) => text(row.code, 80)).filter(Boolean);
  if (!codes.length) return { ok: false, gate: 'delivery-version', error: '制片项目还没有成片，禁止交付', productionId: id };
  const episodes = [];
  for (const code of codes) {
    const gate = await checkDeliveryGate({ scriptId: production.script_id, code });
    if (!gate.ok) return { ...gate, productionId: id, code, checkedEpisodes: episodes };
    episodes.push(gate);
  }
  return {
    ok: true,
    gate: 'delivery',
    productionId: id,
    scriptId: production.script_id,
    episodes,
    timelineIds: episodes.map((x) => x.timelineId),
    versionNos: episodes.map((x) => x.versionNo),
    qcVerdicts: episodes.map((x) => x.qcVerdict),
  };
}

export function deliveryGateQuery(url) {
  const u = new URL(String(url || ''), 'http://127.0.0.1');
  return {
    scriptId: text(u.searchParams.get('scriptId') || u.searchParams.get('script_id')),
    code: text(u.searchParams.get('code')),
    timelineId: text(u.searchParams.get('timelineId') || u.searchParams.get('timeline_id')),
    versionNo: u.searchParams.get('versionNo') || u.searchParams.get('version_no') || null,
  };
}
