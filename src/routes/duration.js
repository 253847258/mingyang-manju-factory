// 成片时长对账（plain text module）
//
// GET /api/render/duration-reconcile?filmId=FM-xxx
// 返回目标时长（分镜/报告记录）与实际文件时长（ffprobe），并给出偏差判定。

import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { get, resolveAsset } from '../db.js';
import { badRequest, notFound } from '../http.js';

const execFileAsync = promisify(execFile);

export function registerDurationRoutes(app) {
  app.get('/api/render/duration-reconcile', async (ctx) => {
    const filmId = String(ctx.query?.filmId || '').trim();
    if (!filmId) throw badRequest('缺少 filmId');
    const film = get('SELECT * FROM episode_films WHERE id = ?', filmId);
    if (!film) throw notFound('成片不存在');
    const abs = resolveAsset(film.file_path);
    if (!abs || !fs.existsSync(abs)) throw badRequest(`成片文件不存在：${film.file_path}`);
    let actual = null;
    try {
      const { stdout } = await execFileAsync('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        abs,
      ], { timeout: 30000 });
      actual = Number(String(stdout).trim());
    } catch (err) {
      throw badRequest(`ffprobe 读取时长失败：${err.message}`);
    }
    const target = Number(film.duration) || 0;
    const delta = actual - target;
    const deltaPct = target ? (delta / target) * 100 : null;
    const verdict = deltaPct === null ? 'unknown' : Math.abs(deltaPct) > 10 ? 'warn' : 'ok';
    ctx.json({
      ok: true,
      filmId,
      file: film.file_path,
      targetDuration: target,
      actualDuration: actual,
      delta: Number(delta.toFixed(3)),
      deltaPct: deltaPct === null ? null : Number(deltaPct.toFixed(2)),
      verdict,
      note: verdict === 'warn'
        ? `实际时长与目标时长偏差 ${deltaPct.toFixed(2)}%，请检查占位视频或真实视频后端时长设置`
        : '时长在 10% 容差内',
    });
  });
}
