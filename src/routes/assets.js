// V2 资产层 HTTP 路由：资产、版本、快照、血缘、成本与生产订单。
// 快照模块按约定惰性加载；模块尚未生成时返回明确的中文 501，不影响其他端点注册。

import { badRequest, notFound } from '../http.js';
import {
  createAsset,
  getAsset,
  listAssets,
  listVersions,
  setCurrentVersion,
  updateAsset,
} from '../assets.js';
import { recordCost, sumCost } from '../cost-ledger.js';
import { getLineage, hashRef, listLineage, recordLineage } from '../lineage.js';
import { createOrder, getOrder, listOrders, orderSummary, upsertEpisode } from '../production-order.js';

class ModuleUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ModuleUnavailableError';
    this.status = 501;
  }
}

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const textOf = (value) => (value === null || value === undefined ? '' : String(value).trim());

function messageOf(error) {
  return textOf(error?.message) || '未知错误';
}

function route(label, handler) {
  return async (ctx) => {
    try {
      await handler(ctx);
    } catch (error) {
      if (Number.isInteger(error?.status) && error.status >= 400) throw error;
      throw badRequest(`${label}：${messageOf(error)}`);
    }
  };
}

async function bodyObject(ctx) {
  const body = await ctx.body();
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('请求体必须是 JSON 对象');
  }
  return body;
}

function firstText(...values) {
  for (const value of values) {
    const text = textOf(value);
    if (text) return text;
  }
  return '';
}

function snapshotInput(body) {
  const input = { ...body };
  const scriptId = firstText(input.scriptId, input.script_id);
  const code = firstText(
    input.code,
    input.episodeCode,
    input.episode_code,
    input.episode,
    input.episodeId,
    input.episode_id,
  );
  const episodeId = firstText(input.episodeId, input.episode_id);

  if (!scriptId) throw badRequest('缺少必填字段：script_id（剧本 ID）');
  if (!code) throw badRequest('缺少必填字段：code（剧集编号）');

  input.scriptId = scriptId;
  input.script_id = scriptId;
  input.code = code;
  input.episodeCode = code;
  input.episode_code = code;
  input.episode = code;
  if (episodeId) {
    input.episodeId = episodeId;
    input.episode_id = episodeId;
  }
  if (!hasOwn(input, 'assets') && hasOwn(input, 'asset_ids')) input.assets = input.asset_ids;
  if (hasOwn(input, 'assets')) input.asset_ids = input.assets;
  if (!hasOwn(input, 'takeIds') && hasOwn(input, 'take_ids')) input.takeIds = input.take_ids;
  if (hasOwn(input, 'takeIds')) input.take_ids = input.takeIds;
  return input;
}

function snapshotQuery(query = {}) {
  const input = { ...query };
  const scriptId = firstText(query.script_id, query.scriptId);
  const code = firstText(query.code, query.episodeCode, query.episode_code, query.episode);
  const episodeId = firstText(query.episode_id, query.episodeId);
  if (scriptId) {
    input.scriptId = scriptId;
    input.script_id = scriptId;
  }
  if (code) {
    input.code = code;
    input.episodeCode = code;
    input.episode_code = code;
    input.episode = code;
  }
  if (episodeId) {
    input.episodeId = episodeId;
    input.episode_id = episodeId;
  }
  return input;
}

function lineageInput(body) {
  const input = { ...body };
  const alias = (camel, snake) => {
    if (!hasOwn(input, camel) && hasOwn(input, snake)) input[camel] = body[snake];
  };
  alias('takeId', 'take_id');
  alias('modelVersion', 'model_version');
  alias('refHash', 'ref_hash');
  if (!textOf(input.refHash) && (input.ref !== undefined || input.refImages !== undefined)) {
    input.refHash = hashRef(input.ref ?? input.refImages);
  }
  return input;
}

function episodeInputs(body) {
  if (body.episodes === undefined) return [];
  if (!Array.isArray(body.episodes)) throw badRequest('episodes 必须是数组');
  return body.episodes.map((episode, index) => {
    if (!episode || typeof episode !== 'object' || Array.isArray(episode)) {
      throw badRequest(`episodes[${index}] 必须是对象`);
    }
    return episode;
  });
}

export function registerAssetRoutes(app, options = {}) {
  let snapshotModulePromise = null;

  async function snapshotApi() {
    let api = options.snapshotApi || null;
    if (!api) {
      if (!snapshotModulePromise) {
        snapshotModulePromise = import('../asset-snapshot.js').catch((error) => {
          if (error?.code === 'ERR_MODULE_NOT_FOUND' && /asset-snapshot\.js/.test(String(error.message))) {
            throw new ModuleUnavailableError('资产快照模块尚未生成（src/asset-snapshot.js），该接口暂不可用');
          }
          throw error;
        });
      }
      api = await snapshotModulePromise;
    }
    if (!api || typeof api !== 'object') {
      throw new ModuleUnavailableError('资产快照模块加载结果无效');
    }
    if (typeof api.ensureSnapshotSchema === 'function') await api.ensureSnapshotSchema();
    return api;
  }

  // GET /api/assets?type=&project_id=
  app.get('/api/assets', route('读取资产列表失败', async (ctx) => {
    const assets = listAssets({
      type: ctx.query?.type,
      projectId: ctx.query?.project_id ?? ctx.query?.projectId,
    });
    ctx.json({ ok: true, count: assets.length, assets });
  }));

  // POST /api/assets
  app.post('/api/assets', route('创建资产失败', async (ctx) => {
    const body = await bodyObject(ctx);
    const asset = createAsset({
      type: body.type,
      name: body.name,
      description: body.description,
      projectId: body.projectId ?? body.project_id,
      params: body.params,
      refImages: body.refImages ?? body.ref_images,
      fingerprint: body.fingerprint,
    });
    ctx.json({ ok: true, asset });
  }));

  // PUT /api/assets/:id
  app.put('/api/assets/:id', route('更新资产失败', async (ctx) => {
    const body = await bodyObject(ctx);
    const patch = {};
    for (const key of ['name', 'description', 'params', 'refImages', 'ref_images', 'fingerprint', 'projectId', 'project_id']) {
      if (hasOwn(body, key)) patch[key] = body[key];
    }
    if (!getAsset(ctx.params.id)) throw notFound(`资产不存在：${ctx.params.id}`);
    const asset = updateAsset(ctx.params.id, patch);
    ctx.json({ ok: true, asset });
  }));

  // GET /api/assets/:id/versions
  app.get('/api/assets/:id/versions', route('读取资产版本失败', async (ctx) => {
    if (!getAsset(ctx.params.id)) throw notFound(`资产不存在：${ctx.params.id}`);
    const versions = listVersions(ctx.params.id);
    ctx.json({ ok: true, count: versions.length, versions });
  }));

  // POST /api/assets/:id/current-version
  app.post('/api/assets/:id/current-version', route('切换资产版本失败', async (ctx) => {
    const body = await bodyObject(ctx);
    const versionNo = body.versionNo ?? body.version_no ?? body.version;
    const asset = setCurrentVersion(ctx.params.id, versionNo);
    ctx.json({ ok: true, asset });
  }));

  // POST /api/assets/snapshot
  app.post('/api/assets/snapshot', route('保存资产快照失败', async (ctx) => {
    const body = await bodyObject(ctx);
    const input = snapshotInput(body);
    const api = await snapshotApi();
    if (typeof api.freezeSnapshot !== 'function') {
      throw new ModuleUnavailableError('资产快照模块缺少 freezeSnapshot 接口');
    }
    const snapshot = await api.freezeSnapshot(input);
    ctx.json({ ok: true, snapshot });
  }));

  // GET /api/assets/snapshot?script_id=&code=
  // 带 script_id + code 读取单条；否则按现有筛选条件返回快照列表。
  app.get('/api/assets/snapshot', route('读取资产快照失败', async (ctx) => {
    const input = snapshotQuery(ctx.query);
    const scriptId = input.scriptId;
    const code = input.code;
    const api = await snapshotApi();

    if (scriptId && code) {
      if (typeof api.getSnapshot !== 'function') {
        throw new ModuleUnavailableError('资产快照模块缺少 getSnapshot 接口');
      }
      const snapshot = api.getSnapshot.length >= 2
        ? await api.getSnapshot(scriptId, code)
        : await api.getSnapshot(input);
      if (!snapshot) throw notFound(`资产快照不存在：${scriptId} / ${code}`);
      return ctx.json({ ok: true, snapshot });
    }

    if (typeof api.listSnapshots !== 'function') {
      throw new ModuleUnavailableError('资产快照模块缺少 listSnapshots 接口');
    }
    const listed = await api.listSnapshots(input);
    const snapshots = Array.isArray(listed)
      ? listed
      : (listed?.snapshots ?? listed?.items ?? []);
    ctx.json({ ok: true, count: snapshots.length, snapshots });
  }));

  // POST /api/assets/lineage
  app.post('/api/assets/lineage', route('写入生成血缘失败', async (ctx) => {
    const body = await bodyObject(ctx);
    const lineage = recordLineage(lineageInput(body));
    ctx.json({ ok: true, lineage });
  }));

  // GET /api/assets/lineage?take_id=
  app.get('/api/assets/lineage', route('读取生成血缘失败', async (ctx) => {
    const takeId = textOf(ctx.query?.take_id ?? ctx.query?.takeId);
    if (takeId) {
      const lineage = getLineage(takeId);
      if (!lineage) throw notFound(`生成血缘不存在：${takeId}`);
      return ctx.json({ ok: true, lineage });
    }
    const records = listLineage({
      model: ctx.query?.model,
      limit: ctx.query?.limit,
    });
    ctx.json({ ok: true, count: records.length, records });
  }));

  // GET /api/assets/cost?project_id=&episode_id=
  app.get('/api/assets/cost', route('读取成本失败', async (ctx) => {
    const projectId = textOf(ctx.query?.project_id ?? ctx.query?.projectId) || undefined;
    const episodeId = textOf(ctx.query?.episode_id ?? ctx.query?.episodeId) || undefined;
    const stage = textOf(ctx.query?.stage) || undefined;
    const currency = textOf(ctx.query?.currency) || undefined;
    const total = sumCost({ projectId, episodeId, stage, currency });
    ctx.json({ ok: true, projectId: projectId || null, episodeId: episodeId || null, total });
  }));

  // GET /api/production/orders
  app.get('/api/production/orders', route('读取生产订单列表失败', async (ctx) => {
    const orders = listOrders();
    ctx.json({ ok: true, count: orders.length, orders });
  }));

  // POST /api/production/orders
  app.post('/api/production/orders', route('创建生产订单失败', async (ctx) => {
    const body = await bodyObject(ctx);
    const order = createOrder({
      projectId: body.projectId ?? body.project_id,
      title: body.title,
      budgetLimit: body.budgetLimit ?? body.budget_limit,
    });
    const episodes = [];
    for (const episode of episodeInputs(body)) {
      episodes.push(upsertEpisode({
        orderId: order.id,
        code: episode.code,
        status: episode.status,
        shotTotal: episode.shotTotal ?? episode.shot_total,
        shotDone: episode.shotDone ?? episode.shot_done,
      }));
    }
    ctx.json({ ok: true, order, episodes, summary: orderSummary(order.id) });
  }));

  // GET /api/production/orders/:id
  app.get('/api/production/orders/:id', route('读取生产订单失败', async (ctx) => {
    const order = getOrder(ctx.params.id);
    ctx.json({ ok: true, order, summary: orderSummary(order.id) });
  }));
}

export default registerAssetRoutes;
