// 设置页：LLM / 出图后端 / 数据备份 / 快速上手
import { api } from '../lib/api.js';
import { el, toast, confirmDialog, modal, injectStyle, select, fmtDate } from '../lib/ui.js';

let injected = false;
let C = null;
let rootEl = null;

const SET_CSS = `
.set-wrap { padding: 18px; overflow: auto; height: 100%; }
.set-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(430px, 1fr)); gap: 16px; align-items: start; max-width: 1400px; }
.set-card { border: 1px solid var(--line); border-radius: var(--radius-lg); background: var(--panel); overflow: hidden; }
.set-card > h3 { margin: 0; padding: 12px 14px; font-size: 14px; border-bottom: 1px solid var(--line); display: flex; align-items: center; gap: 8px; background: linear-gradient(180deg, rgba(109,140,255,.06), transparent); }
.set-card > .b { padding: 14px; display: flex; flex-direction: column; gap: 11px; }
.hint { font-size: 11.5px; color: var(--muted); line-height: 1.7; }
.hint code { background: #070b12; padding: 1px 5px; border-radius: 4px; font-family: var(--mono); color: #b8c6ff; }
.result-box { border: 1px solid var(--line); border-radius: 8px; padding: 9px 11px; background: #070b12; font-size: 12px; white-space: pre-wrap; max-height: 190px; overflow: auto; color: #c8d6ee; }
.kv2 { display: grid; grid-template-columns: 130px 1fr; gap: 5px 12px; font-size: 12.5px; }
.kv2 .k { color: var(--muted); }
/* 模型矩阵（按专业角色配置模型）：表格横跨整行，避免 12 行角色挤在 430px 的一列里 */
.set-card.mm-card { grid-column: 1 / -1; }
.mm-table { display: flex; flex-direction: column; font-size: 12.5px; }
.mm-head, .mm-row { display: grid; grid-template-columns: 165px 1.35fr 1.15fr 108px 1.7fr; gap: 10px; align-items: start; padding: 7px 9px; }
.mm-head { color: var(--muted); font-size: 11.5px; border-bottom: 1px solid var(--line); position: sticky; top: 0; background: var(--panel); z-index: 2; }
.mm-group { margin-top: 8px; padding: 5px 9px; font-size: 11.5px; color: var(--muted); background: linear-gradient(90deg, rgba(109,140,255,.13), transparent); border-radius: 6px; }
.mm-row { border-bottom: 1px dashed rgba(255,255,255,.055); }
.mm-row.dirty { background: rgba(109,140,255,.08); }
.mm-name { display: flex; flex-direction: column; gap: 3px; }
.mm-edit { display: grid; grid-template-columns: 1.05fr 1fr; gap: 6px; align-items: center; }
.mm-edit select, .mm-edit input { font-size: 12px; padding: 5px 7px; }
.mm-verdict { padding: 7px 9px; border-radius: 8px; border: 1px solid var(--line); background: #070b12; font-size: 12.5px; }
.mm-verdict.mm-ok { border-color: rgba(53,208,127,.4); color: #9ff0c4; }
.mm-verdict.mm-bad { border-color: rgba(255,95,109,.45); color: #ffb3b9; }
.mm-issue { border-left: 3px solid rgba(245,181,68,.7); padding: 3px 0 3px 8px; margin: 5px 0; font-size: 12px; }
.mm-issue.error { border-left-color: rgba(255,95,109,.85); }
`;

export function unmount() { C = null; rootEl = null; }

export async function mount(root, ctx) {
  C = ctx; rootEl = root;
  if (!injected) { injectStyle('settings-view', SET_CSS); injected = true; }
  root.innerHTML = '';
  const wrap = el('div', { class: 'set-wrap' });
  root.append(wrap);
  const grid = el('div', { class: 'set-grid', id: 'set-grid' });
  wrap.append(
    el('div', { class: 'row', style: { marginBottom: '14px', gap: '10px' } }, [
      el('div', {}, [el('div', { style: { fontSize: '17px', fontWeight: 700 } }, ['⚙️ 系统设置']), el('div', { class: 'small muted', text: '配置文本模型与出图后端；所有配置写入 config/config.json，Key 只在本地保存。' })]),
      el('div', { class: 'grow' }),
      el('button', { class: 'btn sm', onclick: () => load() }, ['↻ 重新读取']),
    ]),
    grid,
  );
  await load();
}

async function load() {
  const grid = rootEl.querySelector('#set-grid');
  grid.innerHTML = el('div', { class: 'mod-loading' }, [el('div', { class: 'spinner' })]).outerHTML;
  let cfg, health, mm;
  try { cfg = (await api.get('/api/settings')).settings; health = await api.get('/api/health'); }
  catch (e) { grid.innerHTML = ''; grid.append(el('div', { class: 'result-box', text: '读取配置失败：' + e.message })); return; }
  // 模型矩阵的只读数据源：GET /api/settings/models（角色字典 + 方案 + validateModels 结论 + resolveModelFor 解析结果）
  // 单独 try：这个接口挂了不能连累既有的 LLM / 出图 / 预算区块
  try { mm = await api.get('/api/settings/models'); }
  catch (e) { mm = { error: e.message || String(e) }; }
  const meta = C?.meta || {};
  grid.innerHTML = '';
  grid.append(llmCard(cfg, health), modelMatrixCard(mm), imageCard(cfg, health), videoCard(cfg, health), ttsCard(cfg, health), dataCard(health), helpCard());
}

// ---------------- LLM ----------------
function llmCard(cfg, health) {
  const form = { ...cfg.llm };
  const result = el('div', { class: 'result-box', text: '未测试' });
  const stat = el('span', { class: `chip ${health.llm?.ready ? 'ok' : 'warn'}` }, [health.llm?.ready ? `已就绪 · ${health.llm.model}` : '未就绪']);

  const body = el('div', { class: 'b' }, [
    el('div', { class: 'row' }, [el('span', { class: 'small muted' }, ['当前状态：']), stat]),
    el('label', { class: 'f', id: 'llm-provider-wrap' }, ['提供方 provider', select([
      { id: 'deepseek', name: 'DeepSeek 官方（推荐，已在 DSH 中配好 Key）' },
      { id: 'openai', name: 'OpenAI 兼容（任意 base_url，如本地 vLLM/Ollama 网关）' },
      { id: 'mock', name: 'mock 离线模板（不联网，仅跑通流程）' },
    ], form.provider, (v) => { form.provider = v; })]),
    el('div', { class: 'grid2' }, [
      el('label', { class: 'f' }, ['base_url', el('input', { id: 'llm-base-url', type: 'text', value: form.baseUrl || '', oninput: (e) => { form.baseUrl = e.target.value; } })]),
      el('label', { class: 'f' }, ['模型 model', el('input', { id: 'llm-model', type: 'text', value: form.model || '', oninput: (e) => { form.model = e.target.value; } })]),
    ]),
    el('label', { class: 'f' }, [`API Key${cfg.llm.hasKey ? '（已配置，留空则不修改）' : '（未配置）'}`, el('input', { type: 'password', placeholder: cfg.llm.hasKey ? '已保存，如需更换请粘贴新 Key' : 'sk-…（留空则自动读取 ~/.dsh/.credentials.yaml 的 DEEPSEEK_API_KEY）', oninput: (e) => { form.apiKey = e.target.value; } })]),
    el('div', { class: 'row wrap' }, [
      el('button', { class: 'btn xs', onclick: () => {
        form.provider = 'openai';
        form.baseUrl = 'https://ark.cn-beijing.volces.com/api/v3';
        form.model = 'doubao-seed-1-6-250615';
        const sel = document.querySelector('#llm-provider-wrap select'); if (sel) sel.value = 'openai';
        const bu = document.getElementById('llm-base-url'); if (bu) bu.value = form.baseUrl;
        const md = document.getElementById('llm-model'); if (md) md.value = form.model;
        toast('已填入火山方舟地址与默认模型；请粘贴 API Key 后点保存', 'ok', 4200);
      } }, ['🔥 火山方舟预设']),
      el('span', { class: 'small muted' }, ['模型可填模型 ID，也可填 Endpoint ID（ep-…）']),
    ]),
    el('div', { class: 'grid3' }, [
      el('label', { class: 'f' }, ['温度 temperature', el('input', { type: 'number', step: 0.05, min: 0, max: 2, value: form.temperature, oninput: (e) => { form.temperature = Number(e.target.value); } })]),
      el('label', { class: 'f' }, ['单次最大 tokens', el('input', { type: 'number', min: 256, max: 64000, value: form.maxTokens, oninput: (e) => { form.maxTokens = Number(e.target.value); } })]),
      el('label', { class: 'f' }, ['超时 (ms)', el('input', { type: 'number', min: 10000, step: 10000, value: form.timeoutMs, oninput: (e) => { form.timeoutMs = Number(e.target.value); } })]),
    ]),
    el('div', { class: 'row wrap' }, [
      el('button', { class: 'btn primary sm', onclick: async () => { try { await api.put('/api/settings', { llm: form }); toast('LLM 配置已保存', 'ok'); await load(); } catch (e) { toast(e.message, 'err'); } } }, ['💾 保存 LLM 配置']),
      el('button', { class: 'btn sm', onclick: async () => { result.textContent = '测试中…'; try { const r = await api.post('/api/settings/test-llm', {}); result.textContent = r.ok ? `✓ 连接成功（${r.elapsedMs}ms，model=${r.model}${r.mocked ? '，mock 模式' : ''}）\n回复：${r.reply}` : `✗ 失败：${r.error}`; toast(r.ok ? '连接正常' : '连接失败', r.ok ? 'ok' : 'err'); } catch (e) { result.textContent = '✗ ' + e.message; } } }, ['🔌 测试连接']),
      el('button', { class: 'btn sm', onclick: () => { form.provider = 'mock'; toast('已切换为 mock，别忘了点保存', 'warn'); } }, ['离线模式']),
    ]),
    result,
    el('div', { class: 'hint' }, [
      '· DeepSeek 默认 ', el('code', {}, ['https://api.deepseek.com']), ' + ', el('code', {}, ['deepseek-chat']), '；长文写作建议 maxTokens ≥ 8000。',
      el('br'), '· 小说/剧本的长文生成会分多次调用，模型能力越强，章节连贯性越好。',
      el('br'), '· 未配置 Key 时，把 provider 切到 mock 可先跑通整条流程（不产生真实内容）。',
    ]),
  ]);
  return el('div', { class: 'set-card' }, [el('h3', {}, ['🤖 文本生成（LLM）']), body]);
}

// ---------------- 模型矩阵（按专业角色配置模型） ----------------
// 为什么要有这一块：
//   同一条流水线里「写大纲」和「抠首尾帧」对模型的要求完全不同，一个全局 llm.provider 表达不了。
//   后端已经把「角色 → provider/model」抽成 config.models 一层，并给出四级优先级解析
//   （角色显式设置 > 激活的搭配方案 > 该类别既有分段默认 > 内置默认）。这里把解析结果、来源、
//   密钥就绪情况与校验结论摊开给使用者看，并允许逐角色改 provider + model。
//
// 下面这份提供方字典是**界面兜底副本**——唯一事实来源是 src/model-registry.js 的 PROVIDERS：
//   正常路径：M-101 起 GET /api/settings/models 会把整份 PROVIDERS（+ PROVIDER_ALIASES）一起回给界面，
//             下拉与保存前预检直接用后端那份（见下面的 mmProvidersOf）；
//   兜底路径：接口挂了（mm.error）时才用这份副本，保证模型矩阵还能显示与预检。
// **改 src/model-registry.js 的 PROVIDERS 时必须同步这里**：tests/test-model-registry.js 里有一条
// 「界面副本与 registry 不漂移」的断言会解析本文件、比对两处 id 集合 / kinds / needsModel / suggestedModel，
// 漏同步会直接把测试跑红（不允许静默漂移）。
// 真正的白名单校验仍由后端 PUT /api/settings 兜底
// （未登记提供方 / 未知角色 / temperature 越界 / baseUrl 非 http(s) 一律 400，且整体不落盘）。
const MM_PROVIDERS = {
  mock: { name: '离线模板（mock）', kinds: ['llm', 'vision', 'image', 'video', 'tts'], needsModel: false },
  placeholder: { name: '离线占位实现', kinds: ['image', 'video'], needsModel: false },
  none: { name: '不启用（none）', kinds: ['tts'], needsModel: false },
  deepseek: { name: 'DeepSeek', kinds: ['llm', 'vision'], needsModel: true },
  google: { name: 'Google Gemini（多模态读图）', kinds: ['vision'], needsModel: true, suggestedModel: 'gemini-3.8-flash' },
  openai: { name: 'OpenAI（对话/多模态/配音）', kinds: ['llm', 'vision', 'tts'], needsModel: true },
  'openai-images': { name: 'OpenAI 图像', kinds: ['image'], needsModel: true },
  'generic-http': { name: '自定义 HTTP 接口', kinds: ['image', 'video', 'tts'], needsModel: true },
  comfyui: { name: 'ComfyUI（出图）', kinds: ['image'], needsModel: false },
  'comfyui-h3': { name: 'ComfyUI H3（视频）', kinds: ['video', 'image'], needsModel: false },
};
// 提供方别名（与 registry 的 PROVIDER_ALIASES 同步）：手写配置里可能是 gemini，等价于 google；
// 别名只在「回显 / 预检」时识别，下拉里不单列（避免同一家出现两项）。
const MM_PROVIDER_ALIASES = { gemini: 'google' };
const MM_KINDS = [
  { id: 'llm', name: '文本' }, { id: 'image', name: '图像' }, { id: 'video', name: '视频' },
  { id: 'tts', name: '配音' }, { id: 'vision', name: '视觉' },
];
const MM_KIND_NAME = Object.fromEntries(MM_KINDS.map((k) => [k.id, k.name]));
// 来源层级 → 中文说明（与 src/model-registry.js 的 SOURCE_LABELS / sourceLevel 对齐）
const MM_SOURCE_LABEL = { role: '角色显式设置', profile: '方案', kind: '全局段默认', provider: '提供方默认地址', default: '内置默认' };

/** 来源说明（来自后端 resolved[].source / sourceLevel）：例「角色显式设置」「方案：均衡」「全局段默认」 */
function mmSourceText(res) {
  const lvl = res.sourceLevel || '';
  if (lvl === 'profile') return `方案：${res.profile || '(未激活)'}`;
  return MM_SOURCE_LABEL[lvl] || (lvl || '未知来源');
}

/**
 * 本次要用的提供方字典与别名表。
 * 优先用后端 GET /api/settings/models 回的 providers / providerAliases（唯一事实来源 = src/model-registry.js 的 PROVIDERS），
 * 接口不可用时才回落到本文件的 MM_PROVIDERS 副本（保证模型矩阵仍可用）。
 */
function mmProvidersOf(mm) {
  const fromApi = mm && !mm.error && mm.providers && typeof mm.providers === 'object';
  const src = fromApi ? mm.providers : MM_PROVIDERS;
  const list = {};
  for (const [id, p] of Object.entries(src)) {
    list[id] = {
      name: (p && p.name) || id,
      kinds: Array.isArray(p?.kinds) ? p.kinds : [],
      needsModel: Boolean(p && p.needsModel),
      suggestedModel: String(p?.suggestedModel || ''),
    };
  }
  const aliases = (fromApi && mm.providerAliases && typeof mm.providerAliases === 'object') ? mm.providerAliases : MM_PROVIDER_ALIASES;
  return { list, aliases, source: fromApi ? 'registry（GET /api/settings/models）' : '界面兜底副本（接口不可用）' };
}

function modelMatrixCard(mm) {
  const roles = Array.isArray(mm?.roles) ? mm.roles : [];
  const resolvedById = Object.fromEntries((Array.isArray(mm?.resolved) ? mm.resolved : []).map((r) => [r.role, r]));
  const validation = mm?.validation || { ok: false, issues: [], summary: '', counts: {} };
  const active = mm?.activeProfile || '';
  const kindLabel = (k) => MM_KIND_NAME[k] || k;
  // 提供方字典来自 registry（后端 providers），别名（gemini → google）只在回显/预检时识别
  const { list: mmProv, aliases: mmAlias } = mmProvidersOf(mm);
  const provOf = (id) => mmProv[mmAlias[id] || id] || null;

  // draft = 界面草稿（provider 与 model 一起编辑/一起提交）；saved = 后端当前生效值，用于算「改动」与「保存」
  const draft = {};
  const saved = {};
  for (const r of roles) {
    const res = resolvedById[r.id] || {};
    const v = { provider: res.provider || r.defaultProvider || '', model: res.model ?? '' };
    draft[r.id] = { ...v };
    saved[r.id] = { ...v };
  }

  const tableBox = el('div', { class: 'mm-table', id: 'mm-table' });
  const checkBox = el('div', { class: 'result-box', id: 'mm-draft-check' });
  const serverBox = el('div', { class: 'result-box', id: 'mm-validation' });
  const saveBtn = el('button', { class: 'btn primary sm', id: 'mm-save', disabled: true, onclick: () => save() }, ['💾 保存模型矩阵']);
  const activeChip = el('span', { class: `chip ${active ? 'ok' : ''}`, id: 'mm-active-profile' }, [active ? `当前方案：${active}` : '当前方案：未激活（回落既有分段默认）']);

  const isDirty = (rid) => draft[rid].provider !== saved[rid].provider || String(draft[rid].model || '') !== String(saved[rid].model || '');
  const dirtyCount = () => roles.filter((r) => isDirty(r.id)).length;

  /** 保存前的本地预检：与后端白名单口径一致（未登记提供方 / kind 不匹配 / 需要显式模型名却留空） */
  function draftErrors() {
    const out = [];
    for (const r of roles) {
      const d = draft[r.id];
      const p = provOf(d.provider);
      if (!d.provider) { out.push(`角色「${r.name}」未指定提供方（可选：${Object.keys(mmProv).join('、')}）`); continue; }
      if (!p) { out.push(`角色「${r.name}」的提供方「${d.provider}」未登记，后端会拒绝保存`); continue; }
      if (!p.kinds.includes(r.kind)) out.push(`提供方「${p.name}」不支持${kindLabel(r.kind)}（角色「${r.name}」）`);
      if (p.needsModel && !String(d.model || '').trim()) out.push(`角色「${r.name}」的提供方「${p.name}」需要显式模型名：model 不能为空`);
    }
    return out;
  }

  function refreshCheck() {
    const errs = draftErrors();
    const n = dirtyCount();
    checkBox.innerHTML = '';
    checkBox.append(el('div', {
      class: errs.length ? 'mm-verdict mm-bad' : 'mm-verdict mm-ok',
      text: errs.length
        ? `⛔ 保存前校验未通过：${errs.length} 项错误，已禁用保存（后端 PUT 还有一道白名单校验，非法时整体不落盘）`
        : (n ? `✓ 保存前校验通过：待保存 ${n} 个角色，provider 与 model 会成对写入` : '✓ 保存前校验通过：暂无改动（改任意一行后即可保存）'),
    }));
    for (const e of errs) checkBox.append(el('div', { class: 'hint', text: '· ' + e }));
    saveBtn.disabled = errs.length > 0 || n === 0;
  }

  /** 换 provider 时的模型兜底：同类别同 provider 的其它角色用什么，就跟着用什么（避免 model 属于旧提供方导致跨层错配）；
   *  都没有时用 registry 给的该提供方推荐模型名（如 google → gemini-3.8-flash），免得选完因「需要显式模型名」连保存都点不动 */
  function suggestModel(r, provider) {
    if (provider === r.defaultProvider) return r.defaultModel || '';
    const same = roles.filter((x) => x.kind === r.kind && resolvedById[x.id]?.provider === provider && String(resolvedById[x.id]?.model || '').trim());
    if (same.length) return resolvedById[same[0].id].model;
    const d = roles.find((x) => x.kind === r.kind && x.defaultProvider === provider);
    if (d && d.defaultModel) return d.defaultModel;
    return provOf(provider)?.suggestedModel || '';
  }

  function mmRow(r) {
    const res = resolvedById[r.id] || {};
    const dirtyChip = el('span', { class: 'chip warn', style: { display: 'none' }, dataset: { mmDirty: r.id } }, ['已修改']);
    const nameCell = el('div', { class: 'mm-name' }, [
      el('div', {}, [el('b', { text: r.name }), el('span', { class: 'muted small', text: ' ' + r.id })]),
      el('div', { class: 'hint', text: r.hint || '' }),
      dirtyChip,
    ]);
    const effCell = el('div', {}, [
      el('div', { class: 'mono small', text: `${res.provider || '(未指定提供方)'} / ${res.model ? res.model : '（未指定模型）'}` }),
      el('div', {
        class: 'hint',
        text: [res.baseUrl ? `地址 ${res.baseUrl}` : '', typeof res.temperature === 'number' ? `温度 ${res.temperature}` : '', res.note ? `备注：${res.note}` : ''].filter(Boolean).join(' · ') || '—',
      }),
    ]);
    // 来源说明：短标签（来自 sourceLevel）+ 后端原文（来自 source），例「角色显式设置」「方案：均衡」「全局段默认」
    const srcCell = el('div', { dataset: { mmSource: r.id } }, [
      el('div', { class: 'small', text: mmSourceText(res) }),
      el('div', { class: 'hint', text: res.source || '（后端未给出说明）' }),
    ]);
    // 密钥状态：只用后端返回的 hasKey / keyDetail（掩码口径，绝无明文）
    const keyCell = el('div', { dataset: { mmKey: r.id }, title: res.keyDetail || '' }, [
      el('span', { class: `chip ${res.hasKey ? 'ok' : 'warn'}` }, [res.hasKey ? 'Key 已配置' : '缺 Key / URL']),
      el('div', { class: 'hint', text: res.keyDetail || '' }),
    ]);

    // provider 下拉只放「该类别支持」的提供方；当前值即使不支持也保留在列表里并标注，避免静默改值
    const opts = Object.entries(mmProv)
      .filter(([, p]) => p.kinds.includes(r.kind))
      .map(([id, p]) => ({ id, name: p.name }));
    if (draft[r.id].provider && !opts.some((o) => o.id === draft[r.id].provider)) {
      const cur = provOf(draft[r.id].provider);
      opts.unshift({ id: draft[r.id].provider, name: `${cur ? cur.name : draft[r.id].provider}${cur ? '（不支持该类别）' : '（未登记）'}` });
    }
    const modelInput = el('input', {
      type: 'text', value: draft[r.id].model || '', placeholder: r.defaultModel || '模型名',
      dataset: { mmModel: r.id },
      oninput: (e) => { draft[r.id].model = e.target.value; markDirty(); },
    });
    const sel = select(opts, draft[r.id].provider, (v) => {
      draft[r.id].provider = v;
      if (provOf(v) && !String(draft[r.id].model || '').trim()) draft[r.id].model = suggestModel(r, v);
      modelInput.value = draft[r.id].model || '';
      markDirty();
    });
    sel.dataset.mmProvider = r.id;
    const editCell = el('div', { class: 'mm-edit' }, [sel, modelInput]);

    const row = el('div', { class: 'mm-row', dataset: { mmRole: r.id } }, [nameCell, effCell, srcCell, keyCell, editCell]);
    function markDirty() {
      const d = isDirty(r.id);
      dirtyChip.style.display = d ? '' : 'none';
      row.classList.toggle('dirty', d);
      refreshCheck();
    }
    return row;
  }

  async function save() {
    const errs = draftErrors();
    if (errs.length) { toast('保存前校验未通过：' + errs[0], 'err'); return; }
    // provider 与 model 成对写入：只提交改动过的角色，但每行都带上 provider + model 两个字段，
    // 避免只写 model 时与角色层/分段层的 provider 跨层错配（后端按角色条目整体合并）
    const rolesPatch = {};
    let changed = 0;
    for (const r of roles) {
      if (!isDirty(r.id)) continue;
      changed++;
      rolesPatch[r.id] = { provider: draft[r.id].provider, model: String(draft[r.id].model || '').trim() };
    }
    if (!changed) { toast('没有改动，无需保存', 'warn'); return; }
    saveBtn.disabled = true;
    try {
      await api.put('/api/settings', { models: { roles: rolesPatch } });
      toast(`模型矩阵已保存（${changed} 个角色，provider + model 成对写入）`, 'ok');
      await load();
    } catch (e) {
      toast('保存失败：' + e.message, 'err');
      saveBtn.disabled = false;
    }
  }

  async function applyProfile(name) {
    try {
      // 只写 activeProfile：后端校验方案名是否存在（内置三套来自 config.models.profiles），不存在即 400 中文报错
      await api.put('/api/settings', { models: { activeProfile: name || '' } });
      toast(name ? `已切换到搭配方案「${name}」` : '已取消搭配方案：各角色回落到既有分段默认', 'ok');
      await load();
    } catch (e) { toast('切换方案失败：' + e.message, 'err'); }
  }

  // ---- 表头 + 分组行（按 kind：文本 / 图像 / 视频 / 配音 / 视觉）----
  tableBox.append(el('div', { class: 'mm-head' }, [
    el('div', {}, ['角色']), el('div', {}, ['当前生效（provider / model）']), el('div', {}, ['来源说明']),
    el('div', {}, ['密钥状态']), el('div', {}, ['改为（provider + model 成对写入）']),
  ]));
  let rowCount = 0;
  for (const k of MM_KINDS) {
    const list = roles.filter((r) => r.kind === k.id);
    if (!list.length) continue;
    tableBox.append(el('div', { class: 'mm-group' }, [`${kindLabel(k.id)}（kind=${k.id} · ${list.length} 个角色）`]));
    for (const r of list) { tableBox.append(mmRow(r)); rowCount++; }
  }

  // ---- 一键切换方案（省钱 / 均衡 / 高质量；来自 GET /api/settings/models 的 profiles）----
  const profiles = Array.isArray(mm?.profiles) ? mm.profiles : [];
  const profileRow = el('div', { class: 'row wrap', id: 'mm-profiles' }, [
    el('span', { class: 'small muted' }, ['一键切换搭配方案：']),
    ...profiles.map((p) => el('button', {
      class: `btn sm${p.active ? ' primary' : ''}`,
      dataset: { mmProfile: p.name },
      title: `${p.description || ''}\n依据：${p.basis || ''}`,
      onclick: () => applyProfile(p.name),
    }, [`${p.active ? '✓ ' : ''}${p.name}（${p.coverage}）`])),
    el('button', {
      class: 'btn sm', dataset: { mmProfile: '' }, title: '取消激活：各角色回落到「既有分段默认」（config.models.activeProfile = ""）',
      onclick: () => applyProfile(''),
    }, ['取消方案（回落分段默认）']),
  ]);

  // ---- 后端校验结论（validateModels：中文 summary + 逐角色 warn/error）----
  const issues = Array.isArray(validation.issues) ? validation.issues : [];
  const cnt = validation.counts || {};
  serverBox.append(el('div', {
    class: 'mm-verdict ' + (validation.ok ? 'mm-ok' : 'mm-bad'),
    id: 'mm-validation-summary',
    text: `后端校验：${validation.summary || '（未返回结论）'}`,
  }));
  if (cnt.roles) serverBox.append(el('div', { class: 'hint', text: `角色 ${cnt.roles} · 可直接运行 ${cnt.ready} · 错误 ${cnt.errors} · 提醒 ${cnt.warns}` }));
  if (!issues.length) serverBox.append(el('div', { class: 'hint', text: '· 逐角色检查：无 warn / error' }));
  for (const it of issues) {
    const rn = roles.find((x) => x.id === it.role)?.name || it.role;
    serverBox.append(el('div', { class: `mm-issue ${it.level}`, dataset: { mmIssue: it.level } }, [
      el('span', { class: `chip ${it.level === 'error' ? 'err' : 'warn'}` }, [it.level === 'error' ? '错误' : '提醒']),
      el('span', { text: ` ${rn}：${it.message}` }),
    ]));
  }
  if (mm?.error) serverBox.append(el('div', { class: 'mm-issue error' }, [`读取 /api/settings/models 失败：${mm.error}（模型矩阵不可用，其余设置区块不受影响）`]));

  const body = el('div', { class: 'b' }, [
    el('div', { class: 'row wrap' }, [
      activeChip,
      el('span', { class: 'chip' }, [`角色 ${rowCount}/12`]),
      el('span', { class: `chip ${validation.ok ? 'ok' : 'err'}` }, [validation.ok ? `校验通过 · ${cnt.ready ?? '—'}/12 可直接运行` : `校验有错误 · ${cnt.errors ?? '—'} 项`]),
      el('div', { class: 'grow' }),
      el('button', { class: 'btn sm', id: 'mm-refresh', onclick: () => load() }, ['⟳ 重新校验 / 刷新']),
    ]),
    profileRow,
    tableBox,
    el('div', { class: 'row wrap' }, [
      saveBtn,
      el('span', { class: 'hint', text: '有 error 时保存会被禁用；后端 PUT 对 models 段做白名单校验，非法请求整体不落盘。' }),
    ]),
    checkBox,
    el('div', { class: 'small muted' }, ['后端校验结论（src/model-registry.js · validateModels）']),
    serverBox,
    el('div', { class: 'hint' }, [
      '· 优先级（逐字段判定）：', el('b', { text: '角色显式设置 > 激活的搭配方案 > 该类别既有分段默认 > 内置默认' }), '；「来源说明」列就是后端 resolveModelFor 的实际判定（含配置路径），不是界面猜测。',
      el('br'), '· provider 与 model 成对写入：只改 model 也会把该行当前 provider 一起写进角色层，避免 provider 来自方案、model 来自角色的跨层错配。',
      el('br'), '· 一键切换方案只写 ', el('code', {}, ['models.activeProfile']), '；已被「角色显式设置」过的角色仍优先用角色值（取消激活或改回默认才会跟随方案）。',
      el('br'), '· 密钥状态取自后端 ', el('code', {}, ['hasKey']), ' / ', el('code', {}, ['keyDetail']), '（只回掩码与来源，例如「已配置 Key（来源：llm.apiKey）」），界面任何位置都不显示明文 Key。',
      el('br'), '· 提供方下拉与「保存前校验」用的是后端 ', el('code', {}, ['GET /api/settings/models']), ' 回的 registry 字典（单一事实来源 = ', el('code', {}, ['src/model-registry.js']), ' 的 PROVIDERS）；接口不可用时才用本文件的兜底副本。',
      el('br'), '· ', el('b', {}, ['Google Gemini']), ' 目前只登记为「多模态读图」可用（vision 类角色，例如「画面质检」）：选它后填模型名（如 ', el('code', {}, ['gemini-3.8-flash']), '）即可保存，Key 填在角色或环境变量 ', el('code', {}, ['GEMINI_API_KEY']), '；文本类角色的下拉里不会列出它——', el('code', {}, ['src/llm.js']), ' 还没有 Gemini 的对话分支，硬选会在真实调用时失败。',
    ]),
  ]);
  // 首屏也要给出「保存前校验」结论（否则 checkBox 会一直是空的，使用者不知道保存按钮为什么是灰的）
  refreshCheck();
  return el('div', { class: 'set-card mm-card', id: 'mm-card' }, [el('h3', {}, ['🧠 模型矩阵（按专业角色配置模型）']), body]);
}

// ---------------- 出图 ----------------
function imageCard(cfg, health) {
  const form = { ...cfg.image, generic: { ...cfg.image.generic }, openai: { ...cfg.image.openai }, comfy: { ...cfg.image.comfy } };
  const result = el('div', { class: 'result-box', text: '未测试' });
  const detail = el('div', { id: 'img-detail' });

  const presets = [
    {
      name: '🔥 火山方舟 Seedream', hint: '填 API Key 与模型 ID（如 doubao-seedream-5-0-pro-260628）；参考图走图生图模板',
      apply: () => {
        form.backend = 'generic-http';
        form.generic.url = 'https://ark.cn-beijing.volces.com/api/v3/images/generations';
        form.generic.method = 'POST';
        form.generic.headers = '{"Content-Type":"application/json"}';
        // 文生图模板不含 image（Ark 收到空 image 会 400）；图生图模板才带 image
        form.generic.bodyTemplate = '{"model":"{{model}}","prompt":"{{prompt}}","size":"{{width}}x{{height}}","response_format":"url","watermark":false}';
        form.generic.refBodyTemplate = '{"model":"{{model}}","prompt":"{{prompt}}","image":"{{refImage}}","size":"{{width}}x{{height}}","response_format":"url","watermark":false}';
        form.generic.responseImagePath = 'data.0.url';
        form.generic.model = 'doubao-seedream-5-0-pro-260628';
        form.generic.refImageField = 'image';
        form.generic.refImageFormat = 'dataurl';
      },
    },
    {
      name: 'OpenAI 兼容示例', apply: () => {
        form.backend = 'generic-http';
        form.generic.url = 'https://api.example.com/v1/images/generations';
        form.generic.bodyTemplate = '{"model":"{{model}}","prompt":"{{prompt}}","negative_prompt":"{{negative}}","width":{{width}},"height":{{height}},"seed":{{seed}},"n":1}';
        form.generic.responseImagePath = 'data.0.b64_json';
      },
    },
    {
      name: '返回 URL 型接口', apply: () => {
        form.backend = 'generic-http';
        form.generic.bodyTemplate = '{"prompt":"{{prompt}}","size":"{{width}}x{{height}}","seed":{{seed}}}';
        form.generic.responseImagePath = 'data.0.url';
      },
    },
    {
      name: '异步任务型（提交→轮询）', apply: () => {
        form.backend = 'generic-http';
        form.generic.bodyTemplate = '{"prompt":"{{prompt}}","width":{{width}},"height":{{height}}}';
        form.generic.responseImagePath = 'data.output.0.url';
        form.generic.pollUrl = 'https://api.example.com/v1/tasks/{{taskId}}';
        form.generic.pollStatusPath = 'data.status';
      },
    },
    {
      name: '参考生图（图生图 base64）',
      hint: '有参考图时走 refBodyTemplate（图生图），无参考图走请求体模板（文生图）',
      apply: () => {
        form.backend = 'generic-http';
        // 双模板口径（与 src/image.js 的 pickImageBodyTemplate 一致，不新造接口）：
        //   请求体模板 = 文生图模板（**不含 image 键**）；图生图模板 refBodyTemplate = 含 image/strength 的那套。
        //   以前这个预设把 i2i 模板写进 bodyTemplate，纯文生图时会把 "image":"" 发给厂商被判参数非法。
        form.generic.bodyTemplate = '{"prompt":"{{prompt}}","width":{{width}},"height":{{height}},"seed":{{seed}}}';
        form.generic.refBodyTemplate = '{"prompt":"{{prompt}}","image":"{{refImage}}","strength":0.6,"width":{{width}},"height":{{height}}}';
        form.generic.refImageField = 'image';
        form.generic.refImageFormat = 'base64';
        form.generic.responseImagePath = 'data.0.b64_json';
      },
    },
  ];

  function renderDetail() {
    detail.innerHTML = '';
    const be = form.backend;
    if (be === 'placeholder') {
      detail.append(el('div', { class: 'hint' }, ['本地占位出图：按档案信息渲染 SVG 定妆卡（含 ID / 类型 / 提示词 / 负面词），无需任何外部服务即可跑通「档案 → 提示词 → 出图 → 素材库 → 宫格封面」全链路。配置真实后端后自动切换真实画面。']));
      return;
    }
    if (be === 'openai-images') {
      detail.append(
        el('div', { class: 'grid2' }, [
          fi('base_url', form.openai.baseUrl, 'https://api.openai.com', (v) => { form.openai.baseUrl = v; }),
          fi('模型', form.openai.model, 'gpt-image-1 / dall-e-3 …', (v) => { form.openai.model = v; }),
          fi('生成路径', form.openai.generatePath, '/v1/images/generations', (v) => { form.openai.generatePath = v; }),
          fi('参考生图路径(edits)', form.openai.editPath, '/v1/images/edits', (v) => { form.openai.editPath = v; }),
        ]),
        fi('API Key', form.openai.apiKey, '留空则沿用上面的 Key / DSH Key', (v) => { form.openai.apiKey = v; }, 'password'),
        el('div', { class: 'hint' }, ['标准 OpenAI 图像接口；参考生图会自动改走 ', el('code', {}, ['/images/edits']), '（multipart 上传参考图）。']),
      );
      return;
    }
    if (be === 'generic-http') {
      const g = form.generic;
      detail.append(
        el('div', { class: 'row wrap' }, presets.map((p) => el('button', { class: 'btn xs', title: p.hint ? `套用后：${p.hint}` : '', onclick: () => { p.apply(); renderDetail(); toast(`已套用预设：${p.name}${p.hint ? `（${p.hint}）` : ''}`, 'ok'); } }, [p.name]))),
        el('div', { class: 'grid2' }, [
          fi('接口 URL', g.url, 'https://…/v1/images/generations', (v) => { g.url = v; }),
          fi('方法', g.method, 'POST', (v) => { g.method = v; }),
          fi('API Key', g.apiKey, '（可选）', (v) => { g.apiKey = v; }, 'password'),
          fi('模型名 {{model}}', g.model, '（可选）', (v) => { g.model = v; }),
          fi('鉴权头名 authHeader', g.authHeader, 'Authorization（默认）', (v) => { g.authHeader = v; }),
          fi('鉴权前缀 authPrefix', g.authPrefix, "Bearer （默认，末尾一个空格）", (v) => { g.authPrefix = v; }),
        ]),
        el('div', { class: 'hint' }, [
          '· 鉴权头：默认 ', el('code', {}, ['Authorization: Bearer <key>']), '，与下面「请求头」模板里那行 Authorization 等效 —— 不改就保持原样，现有请求头一字不变。',
          el('br'), '· 厂商口径不同才需要改：生数 Vidu 用前缀 ', el('code', {}, ['Token ']), '（末尾带空格）；火山引擎语音 V1 用 ', el('code', {}, ['Bearer;']), '（分号，不是空格）；ElevenLabs 用头名 ', el('code', {}, ['xi-api-key']), ' + 空前缀。',
          el('br'), '· 这两栏只描述「头名 + 前缀怎么拼」，本身不含密钥：API Key 始终只在上面的密码框与 ', el('code', {}, ['config/config.json']), ' 里保存，界面不回显明文。',
          el('br'), '· 头名只允许字母、数字、连字符（≤64 字符），前缀不允许含换行（≤32 字符）；填错保存时会中文报错，且整次改动都不写入。',
        ]),
        fl('请求头（JSON，支持 {{apiKey}}）', el('textarea', { rows: 2, style: { fontFamily: 'var(--mono)', fontSize: '11.5px' }, oninput: (e) => { g.headers = e.target.value; } }, [g.headers || ''])),
        fl('请求体模板（JSON，变量：{{prompt}} {{negative}} {{width}} {{height}} {{seed}} {{model}} {{apiKey}} {{refImage}} {{ratio}}）', el('textarea', { rows: 5, style: { fontFamily: 'var(--mono)', fontSize: '11.5px' }, oninput: (e) => { g.bodyTemplate = e.target.value; } }, [g.bodyTemplate || ''])),
        fl('图生图模板（有参考图时用；留空=仍用上面那套）', el('textarea', { rows: 5, style: { fontFamily: 'var(--mono)', fontSize: '11.5px' }, oninput: (e) => { g.refBodyTemplate = e.target.value; } }, [g.refBodyTemplate || ''])),
        el('div', { class: 'grid2' }, [
          fi('响应图片字段路径', g.responseImagePath, 'data.0.b64_json / data.0.url', (v) => { g.responseImagePath = v; }),
          fi('参考图字段名', g.refImageField, 'image', (v) => { g.refImageField = v; }),
          fi('参考图格式', g.refImageFormat, 'base64 | dataurl', (v) => { g.refImageFormat = v; }),
          fi('轮询 URL（异步接口）', g.pollUrl, 'https://…/tasks/{{taskId}}', (v) => { g.pollUrl = v; }),
          fi('轮询状态字段', g.pollStatusPath, 'data.status', (v) => { g.pollStatusPath = v; }),
          fi('轮询间隔 ms', g.pollIntervalMs, '3000', (v) => { g.pollIntervalMs = Number(v) || 3000; }),
          fi('最大轮询次数', g.pollMaxTimes, '100', (v) => { g.pollMaxTimes = Number(v) || 100; }),
          fi('成功状态值', g.pollSuccessValues, 'succeeded,success,done', (v) => { g.pollSuccessValues = v; }),
        ]),
        el('div', { class: 'hint' }, [
          '· 这套模板适配任意厂商协议：把你文档里的请求体结构照抄到「请求体模板」，把返回里图片的位置写进「响应图片字段路径」即可（支持 base64 或图片 URL）。',
          el('br'), '· 参考生图：勾选生成面板里的「参考生图」后，参考图会以 base64/dataURL 填入 ', el('code', {}, ['{{refImage}}']), ' 或「参考图字段名」指定的字段。',
          el('br'), '· 两套模板：本次带参考图（画布参考图/定妆图/参考生图）→ 用「图生图模板」（refBodyTemplate）；不带 → 用「请求体模板」（bodyTemplate）。分开写是因为文生图时空的 ', el('code', {}, ['"image":""']), ' 会被多数厂商判参数非法（如火山方舟 Seedream 报 InvalidImageURL.EmptyURL）。返回结构里的 usedTemplate 标明本次用 t2i 还是 i2i；「图生图模板」留空则两路都用「请求体模板」（老行为）。上面「参考生图（图生图 base64）」预设就是按这个口径填的：请求体模板不含 image 键，含 image/strength 的那套写进「图生图模板」——有参考图时才用它。',
          el('br'), '· 异步任务型接口：提交后若返回 task_id，会自动按「轮询 URL」轮询到成功状态再取图。',
          el('br'), '· 不想手抄文档？用下面的向导：把厂商 curl 粘进来自动填表，或先试发一次让它推荐响应字段。',
        ]),
        vendorWizard({ kind: 'image', title: '出图·通用 HTTP', getForm: () => g, pathField: 'responseImagePath', pathLabel: '响应图片字段路径', rerender: renderDetail }),
      );
      return;
    }
    if (be === 'comfyui') {
      detail.append(
        el('div', { class: 'grid2' }, [
          fi('ComfyUI 地址', form.comfy.url, 'http://127.0.0.1:8188', (v) => { form.comfy.url = v; }),
          fi('工作流 JSON（API 格式）路径', form.comfy.workflowPath, '/path/to/workflow_api.json', (v) => { form.comfy.workflowPath = v; }),
          fi('参考图节点 (nodeId.field)', form.comfy.refImageNode, '10.image', (v) => { form.comfy.refImageNode = v; }),
          fi('超时 ms', form.comfy.timeoutMs, '600000', (v) => { form.comfy.timeoutMs = Number(v) || 600000; }),
        ]),
        fl('节点映射（JSON：positive/negative/width/height/seed/steps/cfg 对应的 "节点id.字段"）', el('textarea', { rows: 3, style: { fontFamily: 'var(--mono)', fontSize: '11.5px' }, oninput: (e) => { form.comfy.map = e.target.value; } }, [typeof form.comfy.map === 'string' ? form.comfy.map : JSON.stringify(form.comfy.map || {})])),
        el('div', { class: 'hint' }, ['支持本地或云端 ComfyUI（API 模式）。工作流需为 API 格式（', el('code', {}, ['class_type']), '+数字键），参考图会自动 ', el('code', {}, ['/upload/image']), ' 后填入指定节点。']),
      );
    }
  }

  const body = el('div', { class: 'b' }, [
    el('div', { class: 'row' }, [
      el('span', { class: 'small muted' }, ['当前后端：']),
      el('span', { class: `chip ${health.image?.ready ? 'ok' : 'warn'}` }, [health.image?.backend || '—', health.image?.ready ? ' ✓ 就绪' : ' 未就绪']),
    ]),
    el('div', { class: 'grid2' }, [
      el('label', { class: 'f' }, ['出图后端 backend', select([
        { id: 'placeholder', name: '本地占位出图（无依赖，先跑通流程）' },
        { id: 'generic-http', name: '通用 HTTP 模板（任意厂商协议，推荐）' },
        { id: 'openai-images', name: 'OpenAI 兼容 images 接口' },
        { id: 'comfyui', name: 'ComfyUI（本地/云端 API 模式）' },
      ], form.backend, (v) => { form.backend = v; renderDetail(); })]),
      el('div', { class: 'grid2' }, [
        el('label', { class: 'f' }, ['并发数', el('input', { type: 'number', min: 1, max: 8, value: form.concurrency, oninput: (e) => { form.concurrency = Number(e.target.value) || 1; } })]),
        el('label', { class: 'f' }, ['失败重试次数（限流/5xx/网络自动退避）', el('input', { type: 'number', min: 0, max: 6, value: form.retries ?? 2, oninput: (e) => { form.retries = Number(e.target.value) || 0; } })]),
        el('label', { class: 'f' }, ['默认比例', select((meta_ratios()), form.defaultRatio, (v) => { form.defaultRatio = v; })]),
      ]),
    ]),
    detail,
    el('div', { class: 'row wrap' }, [
      el('button', { class: 'btn primary sm', onclick: async () => { try { await api.put('/api/settings', { image: form }); toast('出图配置已保存', 'ok'); await load(); } catch (e) { toast(e.message, 'err'); } } }, ['💾 保存出图配置']),
      el('button', { class: 'btn sm', onclick: async () => {
        result.textContent = '测试出图中…';
        try { const r = await api.post('/api/settings/test-image', { backend: form.backend }); result.textContent = r.ok ? `✓ 出图成功（${r.elapsedMs}ms，${r.backend}）→ ${r.filePath}` : `✗ 失败：${r.error}`; if (r.ok) modal({ title: '出图测试结果', body: el('img', { src: api.fileUrl(r.filePath), style: { maxWidth: '100%' } }), width: 640 }); toast(r.ok ? '出图成功' : '出图失败', r.ok ? 'ok' : 'err'); } catch (e) { result.textContent = '✗ ' + e.message; }
      } }, ['🧪 测试出图']),
    ]),
    result,
  ]);

  function meta_ratios() {
    return (C?.meta?.ratios || []).map((r) => ({ id: r.id, name: r.name }));
  }
  renderDetail();
  return el('div', { class: 'set-card' }, [el('h3', {}, ['🖼 出图后端']), body]);
}

const fi = (label, value, ph, oninput, type = 'text') => el('label', { class: 'f' }, [el('span', { text: label }), el('input', { type, value: value ?? '', placeholder: ph, oninput: (e) => oninput(e.target.value) })]);const fl = (label, control) => el('label', { class: 'f' }, [el('span', { text: label }), control]);

// ---------------- 视频后端（模块4 制作台） ----------------
function videoCard(cfg, health) {
  const v0 = cfg.video || {};
  const form = { ...v0, comfy: { ...(v0.comfy || {}) }, generic: { ...(v0.generic || {}) } };
  const result = el('div', { class: 'result-box', text: '未探测' });
  const detail = el('div');

  function renderDetail() {
    detail.innerHTML = '';
    const be = form.backend;
    if (be === 'placeholder') {
      detail.append(el('div', { class: 'hint' }, [
        '本地 ffmpeg 运镜成片：按分镜的运镜把关键帧做成真 mp4（h264），支持 推镜/拉镜/摇镜/移镜/跟拍/升降/环绕/手持晃动/变焦/甩镜/希区柯克变焦。',
        el('br'), '无需任何外部服务，用于跑通「分镜 → 关键帧 → 视频 → 整集成片」闭环；接上云端模型后切换即可得到真实 AI 视频。',
      ]));
    } else if (be === 'comfyui-h3') {
      const c = form.comfy;
      detail.append(
        el('div', { class: 'grid2' }, [
          fi('ComfyUI 实例地址', c.url, 'https://xxxx.container.x-gpu.com/', (x) => { c.url = x; }),
          fi('视频工作流 JSON 路径（留空=内置模板）', c.workflowPath, '留空则自动选内置 H3 模板', (x) => { c.workflowPath = x; }),
          fi('视频节点 id（判定首帧能力）', c.videoNode, '131', (x) => { c.videoNode = x; }),
          fi('模型名（记录用）', c.model, 'minimax-h3', (x) => { c.model = x; }),
          fl('有分镜关键帧时用首帧驱动（i2v）', select([{ id: true, name: '是（画面与关键帧一致）' }, { id: false, name: '否（纯文生视频）' }], c.preferKeyframe !== false, (x) => { c.preferKeyframe = x === true || x === 'true'; })),
          fl('用 turbo LoRA 加速（≈45s/条）', select([{ id: true, name: '开（4 步）' }, { id: false, name: '关（20 步，≈120s/条）' }], c.useTurbo !== false, (x) => { c.useTurbo = x === true || x === 'true'; })),
          fl('提交前用 /object_info 预检', select([{ id: true, name: '开（推荐，拦住节点/模型不匹配）' }, { id: false, name: '关（直接提交）' }], c.preflight !== false, (x) => { c.preflight = x === true || x === 'true'; })),
          fi('turbo LoRA 文件名', c.turboLora, 'minimax_h3_fl2v_lightx2v_turbo_4step_v0.1_comfy.safetensors', (x) => { c.turboLora = x; }),
          fi('turbo 步数', c.turboSteps, '4', (x) => { c.turboSteps = Number(x) || 4; }),
          fi('分辨率 megapixels', c.megapixels, '0.4', (x) => { c.megapixels = Number(x) || 0.4; }),
          fi('轮询间隔 ms', c.pollMs, '3000', (x) => { c.pollMs = Number(x) || 3000; }),
          fi('超时 ms', c.timeoutMs, '900000', (x) => { c.timeoutMs = Number(x) || 900000; }),
        ]),
        fl('节点映射（JSON；positive=提示词节点、duration=时长、firstFrame=首帧图、aspectRatio/megapixels=分辨率、lora/steps 等）', el('textarea', { rows: 3, style: { fontFamily: 'var(--mono)', fontSize: '11.5px' }, oninput: (e) => { c.map = e.target.value; } }, [typeof c.map === 'string' ? c.map : JSON.stringify(c.map || {})])),
        el('div', { class: 'hint' }, [
          '内置两套官方 H3 工作流（', el('code', {}, ['config/workflows/h3-image-to-video.workflow.json']), ' 首帧驱动 / ', el('code', {}, ['h3-text-to-video.workflow.json']), ' 文生视频），留空工作流路径即自动选用：该镜有关键帧就用首帧驱动（先把关键帧光栅化并上传 ', el('code', {}, ['/upload/image']), '），实例不支持首帧时自动回退文生视频。产物自带音频。',
          el('br'), '提交前会拉 ', el('code', {}, ['/object_info']), ' 校验节点类型/必填项/模型清单（云实例节点版本常与前端导出不一致，这是最常见的 400 原因），并把「提示词优化」节点强制关掉以免提示词外发第三方 LLM。',
          el('br'), '字段映射里的 lastImageNode 用于**首尾帧过渡**（指向工作流中负责尾帧的 LoadImage 节点，留空表示该工作流不支持尾帧；给了尾帧却没有映射时会明确报错，不会静默丢帧）。工作流必须是 API 格式（', el('code', {}, ['class_type']), ' + 数字键）；点「探测」会返回显卡/节点校验/turbo 可用性等中文结论，实例 503 多为临时容器正在启动或已释放。',
        ]),
      );
    } else {
      const g = form.generic;
      detail.append(
        el('div', { class: 'row wrap' }, [
          el('button', { class: 'btn xs', onclick: () => {
            g.url = 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks';
            g.method = 'POST';
            g.model = 'doubao-seedance-2-5-260628';
            g.bodyTemplate = '{"model":"{{model}}","content":[{"type":"text","text":"{{prompt}}"},{"type":"image_url","image_url":{"url":"{{refImage}}"},"role":"first_frame"}],"ratio":"adaptive","duration":{{duration}}}';
            g.responseVideoPath = 'content.video_url';
            g.pollUrl = 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/{{taskId}}';
            g.pollStatusPath = 'status';
            g.refImageFormat = 'dataurl';
            renderDetail();
            toast('已套用火山方舟 Seedance 预设，请填 API Key 与模型 ID 后保存', 'ok', 4200);
          } }, ['🔥 火山方舟 Seedance']),
          el('button', { class: 'btn xs', onclick: () => {
            g.url = 'https://api-beijing.klingai.com/image-to-video/kling-2.5-turbo';
            g.method = 'POST';
            g.model = 'kling-2.5-turbo';
            g.headers = '{"Content-Type":"application/json"}';
            g.authHeader = 'Authorization';
            g.authPrefix = 'Bearer ';
            g.bodyTemplate = '{"contents":[{"type":"prompt","text":"{{prompt}}"},{"type":"first_frame","url":"{{refImage}}"},{"type":"last_frame","url":"{{lastImage}}"}],"settings":{"resolution":"1080p","duration":5},"options":{"watermark_info":{"enabled":false}}}';
            g.responseVideoPath = 'data.0.outputs.0.url';
            g.pollUrl = 'https://api-beijing.klingai.com/tasks?task_ids={{taskId}}';
            g.pollStatusPath = 'data.0.status';
            g.pollSuccessValues = 'succeeded';
            g.pollIntervalMs = 10000;
            g.pollMaxTimes = 90;
            g.refImageFormat = 'base64';
            renderDetail();
            toast('已套用 Kling 2.5 预设，请填 API Key 后保存', 'ok', 4200);
          } }, ['🔥 Kling 2.5']),
          el('button', { class: 'btn xs', onclick: () => {
            g.url = 'https://api.dev.runwayml.com/v1/image_to_video';
            g.method = 'POST';
            g.model = 'gen4_turbo';
            g.headers = '{"Content-Type":"application/json","X-Runway-Version":"2024-11-06"}';
            g.authHeader = 'Authorization';
            g.authPrefix = 'Bearer ';
            g.bodyTemplate = '{"model":"{{model}}","promptText":"{{prompt}}","promptImage":[{"uri":"{{refImage}}","position":"first"}],"ratio":"1280:720","duration":5}';
            g.responseVideoPath = 'output.0';
            g.pollUrl = 'https://api.dev.runwayml.com/v1/tasks/{{taskId}}';
            g.pollStatusPath = 'status';
            g.pollSuccessValues = 'SUCCEEDED';
            g.pollIntervalMs = 5000;
            g.pollMaxTimes = 120;
            g.refImageFormat = 'dataurl';
            renderDetail();
            toast('已套用 Runway Gen-4 预设（已带版本请求头），请填 API Key 后保存', 'ok', 4200);
          } }, ['🔥 Runway Gen-4']),
          el('button', { class: 'btn xs', onclick: () => {
            g.url = 'https://api.lumalabs.ai/dream-machine/v1/generations/video';
            g.method = 'POST';
            g.model = 'ray-2';
            g.headers = '{"Content-Type":"application/json"}';
            g.authHeader = 'Authorization';
            g.authPrefix = 'Bearer ';
            g.bodyTemplate = '{"model":"{{model}}","prompt":"{{prompt}}","aspect_ratio":"16:9","resolution":"720p","duration":"5s","keyframes":{"frame0":{"type":"image","url":"{{refImage}}"},"frame1":{"type":"image","url":"{{lastImage}}"}}}';
            g.responseVideoPath = 'assets.video';
            g.pollUrl = 'https://api.lumalabs.ai/dream-machine/v1/generations/{{taskId}}';
            g.pollStatusPath = 'state';
            g.pollSuccessValues = 'completed';
            g.pollIntervalMs = 5000;
            g.pollMaxTimes = 120;
            g.refImageFormat = 'base64';
            renderDetail();
            toast('已套用 Luma 预设，请填 API Key 后保存', 'ok', 4200);
          } }, ['🔥 Luma']),
          el('span', { class: 'small muted' }, ['首帧驱动；模型可填 seedance 模型 ID 或 Endpoint ID']),
        ]),
        el('div', { class: 'grid2' }, [
          fi('视频接口 URL', g.url, 'https://…/v1/videos/generations', (x) => { g.url = x; }),
          fi('方法', g.method, 'POST', (x) => { g.method = x; }),
          fi('API Key', g.apiKey, '（可选）', (x) => { g.apiKey = x; }, 'password'),
          fi('模型名 {{model}}', g.model, '（可选）', (x) => { g.model = x; }),
          fi('响应视频字段路径', g.responseVideoPath, 'data.0.url', (x) => { g.responseVideoPath = x; }),
          fi('参考图格式', g.refImageFormat, 'base64 | dataurl', (x) => { g.refImageFormat = x; }),
          fi('轮询 URL（异步接口）', g.pollUrl, 'https://…/tasks/{{taskId}}', (x) => { g.pollUrl = x; }),
          fi('轮询状态字段', g.pollStatusPath, 'data.status', (x) => { g.pollStatusPath = x; }),
          fi('鉴权头名 authHeader', g.authHeader, 'Authorization（默认）', (x) => { g.authHeader = x; }),
          fi('鉴权前缀 authPrefix', g.authPrefix, "Bearer （默认，末尾一个空格）", (x) => { g.authPrefix = x; }),
        ]),
        el('div', { class: 'hint' }, [
          '· 鉴权头：默认 ', el('code', {}, ['Authorization: Bearer <key>']), '，与出图用的是同一套口径，不改就保持原样。视频厂商里最常见的是生数 Vidu（', el('code', {}, ['https://api.vidu.cn/ent/v2/start-end2video']), '）用前缀 ', el('code', {}, ['Token ']), '；Runway 每个请求必带的 ', el('code', {}, ['X-Runway-Version']), ' 仍走请求头模板原样透传。',
          el('br'), '· 这两栏不含密钥：API Key 只在上面的密码框与 ', el('code', {}, ['config/config.json']), ' 里保存，界面不回显明文。头名只允许字母、数字、连字符，前缀不允许含换行。',
        ]),
        fl('请求体模板（变量：{{prompt}} {{negative}} {{duration}} {{width}} {{height}} {{seed}} {{model}} {{apiKey}} {{refImage}} {{move}}）', el('textarea', { rows: 4, style: { fontFamily: 'var(--mono)', fontSize: '11.5px' }, oninput: (e) => { g.bodyTemplate = e.target.value; } }, [g.bodyTemplate || ''])),
        el('div', { class: 'hint' }, ['把厂商文档里的请求体照抄进模板、把返回里视频地址写进「响应视频字段路径」即可；关键帧会以 base64 填进 ', el('code', {}, ['{{refImage}}']), '。']),
        vendorWizard({ kind: 'video', title: '视频·通用 HTTP', getForm: () => g, pathField: 'responseVideoPath', pathLabel: '响应视频字段路径', rerender: renderDetail }),
      );
    }
  }

  const body = el('div', { class: 'b' }, [
    el('div', { class: 'row' }, [
      el('span', { class: 'small muted' }, ['当前后端：']),
      el('span', { class: 'chip', id: 'vd-chip' }, [health.image?.backend ? `出图 ${health.image.backend}` : '出图 —']),
      el('span', { class: 'chip', id: 'vd-chip2' }, ['视频 ' + (form.backend || 'placeholder')]),
    ]),
    el('div', { class: 'grid3' }, [
      el('label', { class: 'f' }, ['视频后端', select([
        { id: 'placeholder', name: '本地 ffmpeg 运镜（默认，零依赖）' },
        { id: 'comfyui-h3', name: 'ComfyUI · MiniMax H3 图生视频' },
        { id: 'generic-http', name: '通用 HTTP 模板（任意厂商）' },
      ], form.backend, (x) => { form.backend = x; renderDetail(); })]),
      el('label', { class: 'f' }, ['并发数', el('input', { type: 'number', min: 1, max: 4, value: form.concurrency ?? 1, oninput: (e) => { form.concurrency = Number(e.target.value) || 1; } })]),
      el('label', { class: 'f' }, ['单镜最长秒数', el('input', { type: 'number', min: 1, max: 30, value: form.maxShotSeconds ?? 12, oninput: (e) => { form.maxShotSeconds = Number(e.target.value) || 12; } })]),
      el('label', { class: 'f' }, ['默认比例', select([
        { id: '16:9', name: '16:9 横屏' }, { id: '9:16', name: '9:16 竖屏漫剧' },
        { id: '21:9', name: '21:9 宽银幕' }, { id: '1:1', name: '1:1' }, { id: '4:3', name: '4:3' },
      ], form.defaultRatio, (x) => { form.defaultRatio = x; })]),
      el('label', { class: 'f' }, ['失败重试次数（限流/5xx/网络自动退避）', el('input', { type: 'number', min: 0, max: 6, value: form.retries ?? 2, oninput: (e) => { form.retries = Number(e.target.value) || 0; } })]),
      el('label', { class: 'f' }, ['帧率 fps', el('input', { type: 'number', min: 12, max: 60, value: form.fps ?? 25, oninput: (e) => { form.fps = Number(e.target.value) || 25; } })]),
      el('label', { class: 'f' }, ['画质 CRF（越小越清晰）', el('input', { type: 'number', min: 16, max: 34, value: form.crf ?? 26, oninput: (e) => { form.crf = Number(e.target.value) || 26; } })]),
    ]),
    detail,
    el('div', { class: 'row wrap' }, [
      el('button', { class: 'btn primary sm', onclick: async () => { try { await api.put('/api/settings', { video: form }); toast('视频后端配置已保存', 'ok'); await load(); } catch (e) { toast(e.message, 'err'); } } }, ['💾 保存视频配置']),
      el('button', { class: 'btn sm', onclick: async () => {
        result.textContent = '探测中…';
        try {
          const r = await api.post('/api/video-backend/probe', { backend: form.backend });
          result.textContent = `${r.ready ? '✓' : '✗'} ${r.backend}：${r.detail}`;
          toast(r.ready ? '视频后端可用' : '视频后端不可用：' + r.detail, r.ready ? 'ok' : 'warn');
        } catch (e) { result.textContent = '✗ ' + e.message; }
      } }, ['📡 探测后端']),
      el('button', { class: 'btn sm', onclick: async () => {
        result.textContent = '试渲染中（本地运镜约 1~3 秒）…';
        try {
          const r = await api.post('/api/render/test-video', { backend: form.backend, duration: 2, move: '推镜' });
          result.textContent = r.ok ? `✓ 试渲染成功 → ${r.filePath}（${r.backend}）` : `✗ ${r.error}`;
          if (r.ok) modal({ title: '试渲染结果（2 秒）', body: el('video', { src: api.fileUrl(r.filePath), controls: 'true', autoplay: 'true', style: { maxWidth: '100%' }, muted: 'true' }), width: 720 });
        } catch (e) { result.textContent = '✗ ' + e.message; }
      } }, ['🎬 试渲染 2 秒']),
    ]),
    result,
    el('div', { class: 'hint' }, ['本地运镜需要关键帧：请先在「🎞 制作台」渲染该集关键帧，或用「试渲染」里的示例。']),
  ]);
  renderDetail();
  return el('div', { class: 'set-card' }, [el('h3', {}, ['🎞 视频后端（制作台）']), body]);
}

// ---------------- 配音后端（TTS，模块4 成片包装用） ----------------
function ttsCard(cfg, health) {
  const t0 = cfg.tts || {};
  const form = { ...t0, openai: { ...(t0.openai || {}) }, generic: { ...(t0.generic || {}) } };
  const result = el('div', { class: 'result-box', text: '未试听' });
  const detail = el('div');

  function renderDetail() {
    detail.innerHTML = '';
    const be = form.backend;
    if (be === 'none') {
      detail.append(el('div', { class: 'hint' }, [
        '未启用配音：成片会带一条静音音轨（保证时间轴与播放器行为正常），台词以字幕呈现。',
        el('br'), '配置任意 TTS 接口后，「制作台 → 成片包装 → 音轨」即可选择「配音」，系统会按每镜时间点把台词音频混入成片。',
      ]));
      return;
    }
    if (be === 'openai') {
      const o = form.openai;
      detail.append(
        el('div', { class: 'grid2' }, [
          fi('base_url', o.baseUrl, 'https://api.openai.com', (x) => { o.baseUrl = x; }),
          fi('接口路径', o.path, '/v1/audio/speech', (x) => { o.path = x; }),
          fi('模型', o.model, 'tts-1 / gpt-4o-mini-tts', (x) => { o.model = x; }),
          fi('音色 voice', o.voice, 'alloy / nova / zh-CN-XiaoxiaoNeural', (x) => { o.voice = x; }),
        ]),
        fi('API Key', o.apiKey, '留空则读 OPENAI_API_KEY 环境变量', (x) => { o.apiKey = x; }, 'password'),
      );
      return;
    }
    const g = form.generic;
    detail.append(
      el('div', { class: 'grid2' }, [
        fi('TTS 接口 URL', g.url, 'https://…/v1/tts', (x) => { g.url = x; }),
        fi('方法', g.method, 'POST', (x) => { g.method = x; }),
        fi('API Key', g.apiKey, '（可选）', (x) => { g.apiKey = x; }, 'password'),
        fi('模型', g.model, '（可选）', (x) => { g.model = x; }),
        fi('响应类型', g.responseType, 'binary | b64 | url', (x) => { g.responseType = x; }),
        fi('音频字段路径（非 binary 时）', g.responseAudioPath, 'data.0.url', (x) => { g.responseAudioPath = x; }),
        fi('鉴权头名 authHeader', g.authHeader, 'Authorization（默认）', (x) => { g.authHeader = x; }),
        fi('鉴权前缀 authPrefix', g.authPrefix, "Bearer （默认，末尾一个空格）", (x) => { g.authPrefix = x; }),
      ]),
      el('div', { class: 'hint' }, [
        '· 鉴权头：默认 ', el('code', {}, ['Authorization: Bearer <key>']), '，generic-http 与上面的 OpenAI 兼容接口两条路都认这一套口径，不改就保持原样（OpenAI 路的默认输出与改造前逐字节一致）。',
        el('br'), '· 火山引擎语音 V1（', el('code', {}, ['https://openspeech.bytedance.com/api/v1/tts']), '）的官方口径是 ', el('code', {}, ['Authorization: Bearer;<token>']), ' —— 前缀填 ', el('code', {}, ['Bearer;']), '（分号，不是空格）；ElevenLabs 用头名 ', el('code', {}, ['xi-api-key']), ' + 空前缀。',
        el('br'), '· 这两栏不含密钥：API Key 只在上面的密码框与 ', el('code', {}, ['config/config.json']), ' 里保存，界面不回显明文。头名只允许字母、数字、连字符，前缀不允许含换行。',
      ]),
      fl('请求体模板（变量：{{text}} {{voice}} {{model}} {{apiKey}} {{speed}}）', el('textarea', { rows: 3, style: { fontFamily: 'var(--mono)', fontSize: '11.5px' }, oninput: (e) => { g.bodyTemplate = e.target.value; } }, [g.bodyTemplate || ''])),
      vendorWizard({ kind: 'tts', title: '配音·通用 HTTP', getForm: () => g, pathField: 'responseAudioPath', pathLabel: '音频字段路径', rerender: renderDetail }),
    );
  }

  const audioBox = el('div');
  const body = el('div', { class: 'b' }, [
    el('div', { class: 'row' }, [
      el('span', { class: 'small muted' }, ['当前后端：']),
      el('span', { class: 'chip' }, ['配音 ' + (form.backend || 'none')]),
    ]),
    el('div', { class: 'grid3' }, [
      el('label', { class: 'f' }, ['配音后端', select([
        { id: 'none', name: '不启用（成片带静音轨 + 字幕）' },
        { id: 'openai', name: 'OpenAI 兼容 /v1/audio/speech' },
        { id: 'generic-http', name: '通用 HTTP 模板（任意厂商）' },
      ], form.backend, (x) => { form.backend = x; renderDetail(); })]),
      el('label', { class: 'f' }, ['默认音色', el('input', { type: 'text', value: form.voice || '', oninput: (e) => { form.voice = e.target.value; } })]),
      el('label', { class: 'f' }, ['语速', el('input', { type: 'number', step: 0.05, min: 0.5, max: 2, value: form.speed ?? 1, oninput: (e) => { form.speed = Number(e.target.value) || 1; } })]),
      el('label', { class: 'f' }, ['失败重试次数', el('input', { type: 'number', min: 0, max: 6, value: form.retries ?? 2, oninput: (e) => { form.retries = Number(e.target.value) || 0; } })]),
    ]),
    detail,
    el('div', { class: 'row wrap' }, [
      el('button', { class: 'btn primary sm', onclick: async () => { try { await api.put('/api/settings', { tts: form }); toast('配音配置已保存', 'ok'); await load(); } catch (e) { toast(e.message, 'err'); } } }, ['💾 保存配音配置']),
      el('button', { class: 'btn sm', onclick: async () => {
        try { const r = await api.post('/api/tts-backend/probe', { backend: form.backend }); result.textContent = `${r.ok ? '✓' : '✗'} ${r.backend}：${r.detail}`; } catch (e) { result.textContent = '✗ ' + e.message; }
      } }, ['📡 探测']),
      el('button', { class: 'btn sm', onclick: async () => {
        result.textContent = '合成中…';
        audioBox.innerHTML = '';
        try {
          const r = await api.post('/api/tts-backend/test', { text: '雾港的深秋，连呼吸都带着咸腥的铁锈味。', voice: form.voice, backend: form.backend });
          if (r.ok) {
            result.textContent = `✓ 合成成功（${r.elapsedMs}ms）→ ${r.filePath}`;
            audioBox.append(el('audio', { controls: 'true', src: api.fileUrl(r.filePath), style: { width: '100%', marginTop: '6px' } }));
          } else { result.textContent = '✗ ' + r.error; }
        } catch (e) { result.textContent = '✗ ' + e.message; }
      } }, ['🔊 试听一句']),
    ]),
    result,
    audioBox,
  ]);
  renderDetail();
  return el('div', { class: 'set-card' }, [el('h3', {}, ['🔊 配音后端（TTS）']), body]);
}


/**
 * 厂商接入向导（出图 / 视频 / 配音共用）
 * ① 粘贴厂商文档里的 curl → 自动解析出 url / method / headers / bodyTemplate
 * ② 用当前（或草稿）模板试发一次 → 展示原始响应并推荐「响应字段路径」，点一下即填入
 */
function vendorWizard({ kind, title, getForm, pathField, pathLabel, rerender }) {
  const applyDraftTo = (g, patch) => {
    if (patch.url !== undefined) g.url = patch.url;
    if (patch.method !== undefined) g.method = patch.method;
    if (patch.headers !== undefined) g.headers = patch.headers;
    if (patch.bodyTemplate !== undefined) g.bodyTemplate = patch.bodyTemplate;
  };
  const curlBtn = el('button', { class: 'btn sm', onclick: () => {
    const ta = el('textarea', { rows: 10, style: { width: '100%', fontFamily: 'var(--mono)', fontSize: '11.5px' }, placeholder: "curl -X POST 'https://api.vendor.com/v1/images/generations' -H 'Authorization: Bearer sk-xxx' -H 'Content-Type: application/json' -d '{\"model\":\"xxx\",\"prompt\":\"a cat\",\"size\":\"1024x1024\"}'" });
    const out = el('div', { class: 'result-box', text: '把厂商文档里的 curl 整段粘进来，点「解析并填入」' });
    const apply = async () => {
      try {
        const r = await api.post('/api/settings/parse-curl', { curl: ta.value });
        if (!r.ok) { out.textContent = '✗ ' + r.error; return; }
        applyDraftTo(getForm(), r);
        out.textContent = `✓ 已填入：${r.method} ${r.url}\n` + (r.notes || []).map((n) => '· ' + n).join('\n');
        toast('已按 curl 填好模板，请检查后保存', 'ok');
        if (rerender) rerender();
      } catch (e) { out.textContent = '✗ ' + e.message; }
    };
    const m = modal({
      title: `📋 ${title} · 粘贴 curl 自动填表`,
      width: 760,
      body: el('div', {}, [
        el('div', { class: 'hint' }, ['支持 -X / -H / -d / -F / -u 等常见写法；Key 会被换成 ', el('code', {}, ['{{apiKey}}']), '，提示词/尺寸/种子会自动换成占位符。']),
        ta,
        el('div', { class: 'row', style: { marginTop: '8px' } }, [
          el('button', { class: 'btn primary sm', onclick: apply }, ['解析并填入']),
        ]),
        out,
      ]),
    });
    return m;
  } }, ['📋 粘贴 curl 自动填表']);

  const probeBtn = el('button', { class: 'btn sm', onclick: async () => {
    const body = el('div', { class: 'result-box', text: '正在用当前模板试发一次…' });
    const m = modal({ title: `🔎 ${title} · 试发并推荐字段`, width: 780, body });
    try {
      const r = await api.post('/api/settings/probe-vendor', { kind, draft: getForm() });
      body.innerHTML = '';
      const head = r.ok
        ? `✓ HTTP ${r.status}（${r.elapsedMs}ms，content-type: ${r.contentType || '未知'}）`
        : `✗ ${r.errorLabel ? `[${r.errorLabel}] ` : ''}${r.error}（${r.elapsedMs}ms）`;
      body.append(el('div', { class: r.ok ? 'good' : 'bad', text: head }));
      if (r.tips?.length) body.append(el('div', { class: 'hint' }, r.tips.map((t) => el('div', {}, ['· ' + t]))));
      if (r.bytes) body.append(el('div', { class: 'hint' }, [`响应体 ${r.bytes} 字节（二进制媒体，无需字段路径）`]));
      if (r.suggestions?.length) {
        body.append(el('div', { class: 'hint', style: { marginTop: '6px' } }, ['点一条即可填入「' + pathLabel + '」：']));
        for (const sug of r.suggestions) {
          body.append(el('button', {
            class: 'btn sm', style: { display: 'block', margin: '4px 0', width: '100%', textAlign: 'left' },
            onclick: () => { getForm()[pathField] = sug.path; if (rerender) rerender(); toast(`已填入 ${pathLabel}：${sug.path}`, 'ok'); m.close(); },
          }, [`${sug.path}  ·  ${sug.reason}  ·  ${sug.sample}`]));
        }
      }
      if (r.raw) body.append(el('pre', { class: 'code', style: { maxHeight: '240px', overflow: 'auto', fontSize: '11px' }, text: r.raw }));
      else if (r.sample) body.append(el('pre', { class: 'code', style: { maxHeight: '200px', overflow: 'auto', fontSize: '11px' }, text: r.sample }));
    } catch (e) { body.textContent = '✗ ' + e.message; }
  } }, ['🔎 试发一次并推荐字段']);

  return el('div', { class: 'row wrap', style: { marginTop: '6px' } }, [curlBtn, probeBtn]);
}

// ---------------- 数据 ----------------
function dataCard(health) {
  const box = el('div', { class: 'result-box', text: '尚未操作' });
  // 预算与存储保护：接真实厂商 API 后的「防误操作烧额度 / 防长跑吃满磁盘」
  const b = { ...(C?.settings?.budget || {}) };
  // 计费口径（LibTV 调研第 7 条）：按次 / 按秒（含分辨率阶梯）；未配置时回落到上面的「预算单价（按次）」
  const bl = JSON.parse(JSON.stringify(C?.settings?.billing || {}));
  bl.mode = bl.mode || 'perCall';
  bl.image = { perCall: bl.image?.perCall ?? 0, perSecond: bl.image?.perSecond ?? 0 };
  bl.video = { perCall: bl.video?.perCall ?? 0, perSecond: bl.video?.perSecond ?? 0 };
  bl.tiers = Array.isArray(bl.tiers) && bl.tiers.length ? bl.tiers : [{ maxHeight: 720, multiplier: 1 }, { maxHeight: 1080, multiplier: 1.5 }];
  const tierText = () => bl.tiers.map((t) => `≤${t.maxHeight}p:×${t.multiplier}`).join('，');
  const parseTiers = (txt) => String(txt || '').split(/[,，;；]/).map((x) => {
    const m = /(\d+)\s*p?\s*[:：]?\s*[×x*]?\s*([\d.]+)/i.exec(x.trim());
    return m ? { maxHeight: Number(m[1]), multiplier: Number(m[2]) } : null;
  }).filter(Boolean);
  const st = { ...(C?.settings?.storage || {}) };
  const guardBox = el('div', { class: 'kv2', text: '正在读取预算与磁盘…' });

  // ---- 参考图栅格化缓存（REFIMG-FIX / H-101 接线）：占用数字 + 「查看可清理量」+「清理缓存」 ----
  // 两个数据源，口径一致（服务端同一份 cleanupRefCache 扫描逻辑，见 src/modules/render.js）：
  //   · 占用数字：GET /api/guard/status 的 disk.parts 里的 cache 行（与上面的磁盘总量同一次读取，刷新即同步）
  //   · 可清理量 / 真删结果：GET /api/render/cache（只读、无副作用）与 POST /api/render/cleanup {cache:true}
  // 后端若不返回 cache 这一项（老版本服务端），这里降级成「后端未上报」中文说明：不报错、不留空白。
  const cacheDirEl = el('div', { class: 'mono small', id: 'cache-dir', text: '读取中…' });
  const cacheNumEl = el('div', { class: 'mono small', id: 'cache-usage', text: '读取中…' });
  const cacheRow = el('div', { class: 'kv2', id: 'cache-row' }, [
    el('div', { class: 'k' }, ['缓存目录']), cacheDirEl,
    el('div', { class: 'k' }, ['文件数 / 占用']), cacheNumEl,
  ]);
  const cacheScanBox = el('div', { class: 'result-box', id: 'cache-scan-result', text: '尚未查询。点「🔍 查看可清理量」先看一眼能释放多少（只读接口，一个文件都不会删）。' });

  /** 把 guard/status 的 cache 项写进缓存行；errText 或后端未上报时给中文降级说明（不抛错、不空白页） */
  const setCacheUsage = (g, errText) => {
    const part = ((g && g.disk && g.disk.parts) || []).find((p) => p && p.name === 'cache');
    // 兜底：parts 里没有，但后端另给了 disk.cache（同一次扫描的同一份数据）也认
    const raw = part || (g && g.disk && g.disk.cache && g.disk.cache.exists ? g.disk.cache : null);
    cacheDirEl.textContent = (g && g.disk && g.disk.cache && g.disk.cache.dir) || 'data/cache/refs';
    if (errText) {
      cacheNumEl.textContent = `后端未上报（${errText}）—— 仍可点「查看可清理量」直接问 /api/render/cache`;
      return;
    }
    if (!raw) {
      cacheNumEl.textContent = '后端未上报（GET /api/guard/status 的 disk.parts 里没有 cache 项）—— 可点「查看可清理量」直接查';
      return;
    }
    const files = Number(raw.files || 0);
    const mb = raw.mb ?? Math.round((Number(raw.bytes || 0) / 1048576) * 10) / 10;
    // 注意口径：disk.parts.cache.files 是「目录内文件总数」（含万一存在的非 PNG / 子目录里的文件），
    // 只有 GET /api/render/cache 才按「可删的 *.png」计数 —— 所以这里写「文件」，精确的 PNG 数交给「查看可清理量」。
    cacheNumEl.textContent = files ? `${files} 个文件 · ${mb}MB` : `0 个文件 · 0MB（尚未栅格化过参考图，或刚清理过）`;
  };

  const refreshGuard = async () => {
    try {
      const g = await api.get('/api/guard/status');
      guardBox.innerHTML = '';
      const rows = [
        ['本月用量', `图 ${g.usage.images} · 视频 ${g.usage.videos} · 配音 ${g.usage.ttsChars} 字`],
        ['本月金额', `${g.cost.amount} ${g.cost.currency}${g.budget.monthlyCap ? `（上限 ${g.budget.monthlyCap}，剩余 ${g.remaining}）` : '（未设上限）'}`],
        ['单价设置', `图 ${g.cost.units.imageUnit} / 视频 ${g.cost.units.videoUnit} / 配音千字 ${g.cost.units.ttsPerKChars} ${g.cost.currency}`],
        ['磁盘占用', `${g.disk.totalMB}MB / 上限 ${g.disk.maxGB}GB（告警 ${g.disk.warnGB}GB）${g.disk.over ? ' · 已超上限' : g.disk.warn ? ' · 接近上限' : ''}`],
        ['占用明细', (g.disk.parts || []).map((p) => `${p.name} ${p.mb}MB`).join(' · ')],
      ];
      for (const [k, v] of rows) {
        guardBox.append(el('div', { class: 'k' }, [k]));
        guardBox.append(el('div', { class: 'mono small' }, [v]));
      }
      setCacheUsage(g);
    } catch (e) {
      guardBox.textContent = '读取失败：' + e.message;
      setCacheUsage(null, `读取 /api/guard/status 失败：${e.message}`);
    }
  };
  refreshGuard();

  /**
   * 缓存接口失败的中文说明：404 / 5xx / 不可达各自成句（不静默失败、也不把 ok:false 当成功）。
   * 注意 web/lib/api.js 在 `res.ok === false` **或** 业务体 `ok:false` 时都会抛错，
   * 所以能走到这里就一定是失败；后端的中文说明在 err.data.note（如「拒绝清理：缓存目录本身是符号链接…」）。
   */
  const cacheErrText = (e, what) => {
    const extra = (e && e.data && (e.data.note || e.data.error)) || '';
    const msg = extra || (e && e.message) || String(e);
    const st = e && e.status;
    if (st === 404) return `✗ ${what}失败：后端没有这个接口（HTTP 404）—— 服务端版本可能早于栅格化缓存功能，请更新服务端后重试`;
    if (st >= 500) return `✗ ${what}失败：服务端错误（HTTP ${st}）：${msg}`;
    if (st) return `✗ ${what}失败：HTTP ${st}：${msg}`;
    return `✗ ${what}失败：接口不可达（${msg}）—— 请确认服务在运行、页面没有被离线拦截`;
  };

  /** 「查看可清理量」：只读 GET /api/render/cache，绝不删除任何文件（后端 dryRun=true 同口径） */
  const scanCache = async () => {
    cacheScanBox.textContent = '查询中…（只读接口，不会删除任何文件）';
    try {
      const r = await api.get('/api/render/cache');
      const mb = r.freedMB ?? Math.round((Number(r.bytes || 0) / 1048576) * 10) / 10;
      cacheScanBox.textContent = [
        '✓ 可清理量（只看不删：本次没有删除任何文件）',
        `缓存目录：${r.dir || 'data/cache/refs'}${r.exists === false ? '（目录不存在，尚未栅格化过参考图）' : ''}`,
        `文件数：${r.files ?? 0} 个 PNG`,
        `占用：${r.bytes ?? 0} 字节（约 ${mb}MB）`,
        r.note ? `后端说明：${r.note}` : '',
      ].filter(Boolean).join('\n');
      toast(Number(r.files) ? `可清理 ${r.files} 个 PNG（约 ${mb}MB）` : '暂无可清理的栅格化缓存', 'ok');
      await refreshGuard(); // 顺手把上面的占用数字刷新（同样是只读）
    } catch (e) {
      cacheScanBox.textContent = cacheErrText(e, '查询可清理量');
      toast('查询缓存失败：' + ((e && e.message) || e), 'err');
    }
  };

  /** 真删：POST /api/render/cleanup {cache:true}（先过二次确认弹窗，见 cleanCache） */
  const doCleanCache = async () => {
    cacheScanBox.textContent = '清理中…';
    try {
      const r = await api.post('/api/render/cleanup', { cache: true });
      const c = r.cache || {};
      const mb = c.freedMB ?? Math.round((Number(c.bytes || 0) / 1048576) * 10) / 10;
      const removed = Number(c.removed || 0);
      cacheScanBox.textContent = [
        removed
          ? `✓ 清理完成：已从 ${c.dir || 'data/cache/refs'} 删除 ${removed} 个 PNG，实际释放 ${mb}MB`
          : `✓ 清理完成：没有可删的 PNG（缓存已是空的，实际释放 0MB）`,
        `后端说明：${c.note || '（未返回说明）'}`,
        `顺带清理的成片临时中间产物：${r.removed ?? 0} 个 / ${r.freedMB ?? 0}MB（已入档成片与关键帧、定妆图都不受影响）`,
        Number(c.failed) ? `⚠ ${c.failed} 个文件删除失败（后端已跳过并继续清剩下的，缓存可以稍后重试）` : '',
      ].filter(Boolean).join('\n');
      toast(removed ? `已清理 ${removed} 个 PNG，释放 ${mb}MB` : '没有可清理的缓存文件', removed ? 'ok' : 'info');
      await refreshGuard(); // 刷新上面的占用数字（数据同源于 GET /api/guard/status）
    } catch (e) {
      // 注意：后端「拒绝清理」（如缓存目录是软链 → ok:false）也走这里，绝不显示成成功
      cacheScanBox.textContent = cacheErrText(e, '清理缓存');
      toast('清理缓存失败：' + ((e && e.data && (e.data.note || e.data.error)) || (e && e.message) || e), 'err');
      await refreshGuard();
    }
  };

  const cleanCache = async () => {
    // 先只读问一次「能释放多少」，把真实数字写进二次确认弹窗（避免凭感觉删）
    let files = 0, mb = 0, unknown = '';
    cacheScanBox.textContent = '清理前先查询可清理量（只读）…';
    try {
      const r = await api.get('/api/render/cache');
      files = Number(r.files || 0);
      mb = r.freedMB ?? Math.round((Number(r.bytes || 0) / 1048576) * 10) / 10;
    } catch (e) {
      unknown = cacheErrText(e, '清理前查询');
      cacheScanBox.textContent = unknown;
    }
    const m = modal({
      title: '🗑 确认清理栅格化缓存（二次确认）',
      width: 600,
      body: el('div', { id: 'cache-clean-notice' }, [
        el('div', { style: { fontWeight: 600, marginBottom: '8px' }, text: unknown
          ? '⚠ 可清理量未知（清理前查询失败，见下方）'
          : `将释放：约 ${mb}MB（${files} 个 PNG）` }),
        el('div', { class: 'hint', id: 'cache-clean-scope' }, [
          '· ', el('b', {}, ['只删栅格化缓存']), '：', el('code', {}, ['data/cache/refs']), ' 目录下的 ', el('code', {}, ['*.png']),
          '（把 SVG 参考图栅格化成 PNG 的那一份缓存，文件名是参考图内容的 sha1 前 16 位）。',
          el('br'), '· ', el('b', {}, ['不影响成片 / 关键帧 / 定妆图']), '：成片（', el('code', {}, ['data/finish']), '）、关键帧与定妆图（',
          el('code', {}, ['data/images']), '）一个都不动；该目录下的非 PNG 文件与子目录也一律跳过。',
          el('br'), '· 该接口还会顺带清掉 ', el('code', {}, ['data/finish']), ' 下未被入档的临时中间产物（', el('code', {}, ['concat_']),
          ' / ', el('code', {}, ['merged_']), ' / ', el('code', {}, ['subs_']), ' / ', el('code', {}, ['faded_']), ' / ',
          el('code', {}, ['audio_']), ' 前缀与 ', el('code', {}, ['final_xxx.mp4']), '），已入档成片有白名单保护，不会被删。',
          el('br'), '· 这是可再生的中间产物，删掉', el('b', {}, ['只影响下次出图时把同一张 SVG 参考图重新转换一次']),
          '（多花一点转换时间，不产生任何额外费用，也不丢素材）。',
          el('br'), '· ', el('b', {}, ['删除不可撤销']), '（删掉的 PNG 无法还原，需要时会自动重新生成）。',
        ]),
        unknown ? el('div', { class: 'hint', style: { marginTop: '8px', color: '#ffb3b9' } }, [unknown]) : null,
      ]),
      footer: [
        el('button', { class: 'btn', id: 'cache-clean-cancel', onclick: () => m.close() }, ['取消（什么都不删）']),
        el('button', { class: 'btn danger', id: 'cache-clean-confirm', onclick: () => { m.close(); doCleanCache(); } }, ['确认清理（不可撤销）']),
      ],
    });
  };

  const budgetForm = el('div', { class: 'grid3', style: { marginTop: '8px' } }, [
    el('label', { class: 'f' }, ['预算保护', select([{ id: true, name: '开启' }, { id: false, name: '关闭' }], b.enabled !== false, (v) => { b.enabled = v === true || v === 'true'; })]),
    el('label', { class: 'f' }, ['货币', el('input', { type: 'text', value: b.currency || 'CNY', oninput: (e) => { b.currency = e.target.value; } })]),
    el('label', { class: 'f' }, ['本月上限 monthlyCap', el('input', { type: 'number', min: 0, step: 1, value: b.monthlyCap ?? 0, oninput: (e) => { b.monthlyCap = Number(e.target.value) || 0; } })]),
    el('label', { class: 'f' }, ['单次确认阈值 confirmOver', el('input', { type: 'number', min: 0, step: 1, value: b.confirmOver ?? 0, oninput: (e) => { b.confirmOver = Number(e.target.value) || 0; } })]),
    el('label', { class: 'f' }, ['单张图单价', el('input', { type: 'number', min: 0, step: 0.01, value: b.imageUnit ?? 0, oninput: (e) => { b.imageUnit = Number(e.target.value) || 0; } })]),
    el('label', { class: 'f' }, ['单条视频单价', el('input', { type: 'number', min: 0, step: 0.1, value: b.videoUnit ?? 0, oninput: (e) => { b.videoUnit = Number(e.target.value) || 0; } })]),
    el('label', { class: 'f' }, ['配音每千字单价', el('input', { type: 'number', min: 0, step: 0.01, value: b.ttsPerKChars ?? 0, oninput: (e) => { b.ttsPerKChars = Number(e.target.value) || 0; } })]),
    el('label', { class: 'f' }, ['计费口径 billing.mode', select([{ id: 'perCall', name: '按次（每条视频一次钱）' }, { id: 'perSecond', name: '按秒（时长计费，含分辨率阶梯）' }], bl.mode, (v) => { bl.mode = v || 'perCall'; })]),
    el('label', { class: 'f' }, ['出图单价（按次）', el('input', { type: 'number', min: 0, step: 0.01, value: bl.image.perCall, oninput: (e) => { bl.image.perCall = Number(e.target.value) || 0; } })]),
    el('label', { class: 'f' }, ['视频单价（按次）', el('input', { type: 'number', min: 0, step: 0.1, value: bl.video.perCall, oninput: (e) => { bl.video.perCall = Number(e.target.value) || 0; } })]),
    el('label', { class: 'f' }, ['视频单价（按秒）', el('input', { type: 'number', min: 0, step: 0.01, value: bl.video.perSecond, oninput: (e) => { bl.video.perSecond = Number(e.target.value) || 0; } })]),
    el('label', { class: 'f' }, ['分辨率阶梯（如 720:1，1080:1.5）', el('input', { type: 'text', value: tierText(), onchange: (e) => { const t = parseTiers(e.target.value); if (t.length) bl.tiers = t; } })]),
    el('label', { class: 'f' }, ['磁盘告警 warnGB', el('input', { type: 'number', min: 1, value: st.warnGB ?? 8, oninput: (e) => { st.warnGB = Number(e.target.value) || 8; } })]),
    el('label', { class: 'f' }, ['磁盘上限 maxGB（超过拒绝新任务）', el('input', { type: 'number', min: 1, value: st.maxGB ?? 20, oninput: (e) => { st.maxGB = Number(e.target.value) || 20; } })]),
  ]);
  const body = el('div', { class: 'b' }, [
    el('div', { class: 'kv2' }, [
      el('div', { class: 'k' }, ['数据目录']), el('div', { class: 'mono small', text: 'data/factory.db' }),
      el('div', { class: 'k' }, ['演员']), el('div', { text: String(health.counts?.actors ?? 0) }),
      el('div', { class: 'k' }, ['定妆图']), el('div', { text: String(health.counts?.images ?? 0) }),
      el('div', { class: 'k' }, ['小说 / 章节']), el('div', { text: `${health.counts?.novels ?? 0} / ${health.counts?.chapters ?? 0}` }),
      el('div', { class: 'k' }, ['剧本 / 镜头']), el('div', { text: `${health.counts?.scripts ?? 0} / ${health.counts?.shots ?? 0}` }),
      el('div', { class: 'k' }, ['任务队列']), el('div', { class: 'mono small', text: JSON.stringify(health.jobs || {}) }),
    ]),
    el('h3', { style: { marginTop: '12px' } }, ['💰 预算与存储保护']),
    el('div', { class: 'hint' }, ['接上真实厂商接口后，这里防止误操作烧额度与长跑吃满磁盘：超「本月上限」直接拒绝任务，超「单次确认阈值」先在制作台弹确认；磁盘超上限时拒绝提交新任务。单价填 0 时只记用量不算金额。']),
    el('div', { class: 'hint' }, ['**计费口径**：不同后端不是一种算法 —— 有的按次（每次调用一口价），有的按秒（同一集横屏 1080p 比竖屏 720p 贵好几倍）。选了「按秒」就按 `秒数 × 单价 × 分辨率阶梯` 折算；制片估算与「一页纸报告 → 计费口径与对账」都会跟着换口径，并给出**预计 vs 实际**（实际按真实产出统计，提交失败的不算）。']),
    budgetForm,
    el('div', { class: 'row wrap', style: { marginTop: '6px' } }, [
      el('button', { class: 'btn primary sm', onclick: async () => { try { await api.put('/api/settings', { budget: b, storage: st, billing: bl }); toast('预算 / 计费口径与存储设置已保存', 'ok'); await refreshGuard(); await load(); } catch (e) { toast(e.message, 'err'); } } }, ['💾 保存预算 / 计费口径与存储设置']),
      el('button', { class: 'btn sm', onclick: refreshGuard }, ['⟳ 刷新用量与磁盘']),
      el('button', { class: 'btn sm', onclick: async () => { if (await confirmDialog('把本月用量台账清零？（只影响金额统计，不会删除任何产物）')) { try { await api.post('/api/guard/reset-usage', {}); toast('本月用量已清零', 'ok'); await refreshGuard(); } catch (e) { toast(e.message, 'err'); } } } }, ['♻ 清零本月用量']),
    ]),
    guardBox,
    // ---- 参考图栅格化缓存（REFIMG-FIX）：与上面的磁盘保护同一区块，占用数字来自同一次 /api/guard/status ----
    el('h3', { style: { marginTop: '12px' } }, ['🧹 参考图栅格化缓存']),
    el('div', { class: 'hint' }, [
      '这是把 ', el('b', {}, ['SVG 参考图栅格化成 PNG']), ' 的缓存（', el('code', {}, ['data/cache/refs']),
      '）：厂商接口只认位图，出图/出视频时会先把 SVG 参考图转一份 PNG 存下来复用。它是**可再生的中间产物**——删掉',
      el('b', {}, ['只影响下次出图时重新转换一次']), '，不丢任何素材、也不产生额外费用。',
    ]),
    cacheRow,
    el('div', { class: 'row wrap', style: { marginTop: '6px' } }, [
      el('button', { class: 'btn sm', id: 'cache-scan', onclick: () => scanCache() }, ['🔍 查看可清理量']),
      el('button', { class: 'btn sm danger', id: 'cache-clean', onclick: () => cleanCache() }, ['🧹 清理缓存']),
      el('span', { class: 'hint', text: '「查看可清理量」是只读的（用完不会删任何文件）；「清理缓存」会先弹二次确认，确认后才会真删。' }),
    ]),
    cacheScanBox,
    el('div', { class: 'row wrap', style: { marginTop: '10px' } }, [
      el('button', { class: 'btn sm', onclick: () => window.open('/api/export?download=1', '_blank') }, ['⬇ 导出全量 JSON 备份']),
      el('button', { class: 'btn sm', onclick: () => importDialog(box) }, ['⬆ 导入 JSON 备份']),
      el('button', { class: 'btn sm', onclick: async () => { if (await confirmDialog('清理已完成/失败的任务记录？（不影响已生成的图片与文本）')) { try { await api.del('/api/jobs/clear'); toast('任务记录已清理', 'ok'); } catch (e) { toast(e.message, 'err'); } } } }, ['🧹 清理任务记录']),
      el('button', { class: 'btn sm danger', onclick: async () => { if (await confirmDialog('确认清空所有演员与其素材记录？此操作不可撤销，建议先导出备份。')) { const r = await api.get('/api/actors'); for (const a of r.actors) await api.del('/api/actors/' + a.id); toast('已清空演员', 'ok'); await load(); } } }, ['🗑 清空演员']),
    ]),
    box,
  ]);
  return el('div', { class: 'set-card' }, [el('h3', {}, ['💾 数据与备份']), body]);
}

function importDialog(box) {
  const inp = el('input', { type: 'file', accept: '.json,application/json' });
  const m = modal({
    title: '⬆ 导入 JSON 备份',
    body: el('div', { class: 'col', style: { gap: '10px' } }, [
      el('div', { class: 'hint' }, ['选择由「导出全量 JSON 备份」生成的文件。导入采用 ', el('code', {}, ['INSERT OR REPLACE']), '，同 ID 记录会被覆盖。']),
      inp,
    ]),
    width: 520,
    footer: [
      el('button', { class: 'btn', onclick: () => m.close() }, ['取消']),
      el('button', { class: 'btn primary', onclick: async () => {
        const f = inp.files?.[0];
        if (!f) { toast('请选择文件', 'warn'); return; }
        try {
          const text = await f.text();
          const data = JSON.parse(text);
          box.textContent = '导入中…';
          const r = await api.post('/api/import', { data });
          box.textContent = '导入完成：' + JSON.stringify(r.stats, null, 2);
          toast('导入完成', 'ok'); m.close(); await load();
        } catch (e) { toast('导入失败：' + e.message, 'err'); }
      } }, ['开始导入']),
    ],
  });
}

// ---------------- 帮助 ----------------
function helpCard() {
  return el('div', { class: 'set-card' }, [
    el('h3', {}, ['📖 四步跑通全流程']),
    el('div', { class: 'b' }, [
      el('div', { class: 'hint' }, [
        el('b', { text: '① 明星演员矩阵（定妆）' }), el('br'),
        '新建演员 → 填性别/种族/身高/体型/风格/比例 → 「AI 补全人物描述」+「一键优化提示词」→ 画布右键选择：脸部大图特写 / 多角度全身 / 多表情 / 头部多角度 / 姿态动作 / 手势细节 / 服饰细节 → 生成结果自动进素材库，可一键设为主图（作参考生图基准）。', el('br'), el('br'),
        el('b', { text: '② 小说工坊（188 章 · 大纲 → 正文）' }), el('br'),
        '选题材（100 种）→ 设定角色规模（≤200）/ 字数规模（≤1000 万）/ 叙事视角 / 章节字数（1000–3000）→ 绑定模块1的演员 ID 或自定义角色 → 可上传参考框架范本 → 先「生成章节大纲」（含时间线/伏笔/地点ID/出场规划/反转/卡点/钩子/跨季时间回路）→ 再「批量写完整章节」（逐章带上下文）。', el('br'), el('br'),
        el('b', { text: '③ 剧本工厂（小说 → 漫剧/电影剧本 → 分镜）' }), el('br'),
        '选已完成的小说 → 挑风格与单集时长/单季集数 → 可上传「转换技能文档」或载入内置模板 → 生成分集规划 → 逐集转成剧本与分镜提示词（景别/运镜/时长/英文正负向词/角色引用），导出 JSON/CSV/Markdown。', el('br'), el('br'),
        el('b', { text: '④ 制作台（分镜 → 关键帧 → 视频 → 整集成片）' }), el('br'),
        '选剧本与剧集 → 「渲染本集关键帧」（走当前出图后端）→ 「生成本集视频」（本地 ffmpeg 运镜 / 云端 MiniMax H3 / 任意视频 API）→ 「合成整集成片」得到整集 mp4，可直接播放下载；默认跳过已生成的镜头，也可只给 H/M 级镜头上视频以省算力。',
      ]),
      el('div', { class: 'row wrap' }, [
        el('button', { class: 'btn sm', onclick: () => C?.go('actors') }, ['🎭 去明星矩阵']),
        el('button', { class: 'btn sm', onclick: () => C?.go('novel') }, ['📖 去小说工坊']),
        el('button', { class: 'btn sm', onclick: () => C?.go('script') }, ['🎬 去剧本工厂']),
        el('button', { class: 'btn sm', onclick: () => C?.go('render') }, ['🎞 去制作台']),
      ]),
    ]),
  ]);
}

export default { mount, unmount };
