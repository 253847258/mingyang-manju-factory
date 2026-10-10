#!/usr/bin/env node
// ============================================================================
// 后端体检 / Backend Doctor —— 把「配置切到不可用后端」这类事故变成一条命令可见。
//
// 为什么需要它（真实事故）：
//   1) 把 config/config.json 切到火山方舟 Ark 后，出图/出视频一律 403，
//      只有真跑一次生成才发现；根因是账号欠费（控制面 QueryBalanceAcct：
//      AccountID 2130449616 / 可用余额 −2.62 元）。
//   2) 面板「看起来就绪」骗人：
//        - GET /api/health → 200
//        - GET /api/video-backend → ready:true
//      这两处的 ready 只是「配置字段非空」的静态判断（见 src/video.js#videoBackendStatus
//      与 src/image.js#imageBackendStatus：ready = Boolean(url)），根本没有发过一次请求。
//      → 本脚本只做**真网络只读探测**，不看配置字段是否填了。
//
// 三条硬约束（本脚本的设计红线）：
//   1) **零付费**：只发只读 GET（余额 / 模型列表 / 实例状态 / 节点字典），
//      **绝不提交任何出图、出视频、TTS 生成任务**，绝不 POST 到生成类端点。
//   2) **零副作用**：不写配置、不写数据库、不重启服务、不 kill 任何进程、
//      不装依赖（纯 node: 内置模块 + 一处 import 项目自身的 loadConfig）。
//   3) **不泄密**：任何密钥只显示「前 4 后 4」掩码；响应体回显的密钥一律打码。
//
// 用法：
//   node scripts/check-backends.js                      # 全员体检（人读）
//   node scripts/check-backends.js --json               # 机读（stdout 只有 JSON）
//   node scripts/check-backends.js --only image,video   # 只查部分段
//   node scripts/check-backends.js --timeout 8000       # 每项探测超时（默认 8000ms）
//   FACTORY_CONFIG=/tmp/x.json node scripts/check-backends.js   # 体检另一份配置（不动真配置）
//
// 退出码：0 = 全部可用或未启用；1 = 存在不可用项；2 = 参数错误 / 配置读取失败。
//
// 已知盲区（诚实声明，写进 JSON 的 risks）：
//   - 只读探测只能证明「鉴权 + 账户额度」这一层；厂商侧的模型白名单/内容审核
//     仍可能在实际生成时拒绝，所以「可用」= 没有发现阻断性问题，不等于保证出片。
//   - 方舟 GET /api/v3/models 在**欠费账号上依然返回 200**（实测），所以对
//     方舟唯一可靠的判据是 AK/SK 查余额（QueryBalanceAcct），模型列表只能证鉴权。
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT = 'ai-video-factory';

/** 火山方舟（Ark）域名特征：配置里出现即触发「查余额」这条特有逻辑 */
const ARK_HOST_RE = /(^|\.)(volces\.com|bytepluses\.com)$/i;
/** 火山引擎 AK/SK 存放位置（只读；脚本绝不打印明文，也不复制到别处） */
const ARK_AK_FILE = '/mnt/k/AI/铭胜运营技能/铭扬核心/APi/AccessKey.txt';

// ---------------------------------------------------------------------------
// 状态枚举：机器判据（进 CI）与人读结论分离，避免中文串被拿来当逻辑用
// ---------------------------------------------------------------------------
const S = {
  OK: 'ok',                 // 探测通过
  DOWN: 'down',             // 明确不可用（鉴权失败/欠费/5xx/限流耗尽）
  UNREACHABLE: 'unreachable', // 网络层不可达（连接被拒/解析失败/超时）
  OFFLINE: 'offline',       // 本地实现或未启用：无需探测，天然零成本
  UNKNOWN: 'unknown',       // 无只读探测端点，本次无法判定（需真机验证）
};

/** 会让退出码变 1 的状态：只有「明确不可用」和「不可达」。
 *  unknown 不算不可用（没证据说它坏了），但会进 risks 提示残余风险。 */
const FAILING = new Set([S.DOWN, S.UNREACHABLE]);

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { json: false, only: null, timeoutMs: 8000, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--only') {
      const v = argv[++i];
      if (!v) throw new UsageError('--only 需要一个值，例如 --only image,video');
      out.only = new Set(v.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
    } else if (a.startsWith('--only=')) {
      out.only = new Set(a.slice(7).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
    } else if (a === '--timeout') {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v <= 0) throw new UsageError('--timeout 需要一个正数（毫秒）');
      out.timeoutMs = Math.min(v, 60000);
    } else if (a.startsWith('--timeout=')) {
      const v = Number(a.slice(10));
      if (!Number.isFinite(v) || v <= 0) throw new UsageError('--timeout 需要一个正数（毫秒）');
      out.timeoutMs = Math.min(v, 60000);
    } else throw new UsageError(`无法识别的参数：${a}`);
  }
  return out;
}
class UsageError extends Error {}

const VALID_SECTIONS = new Set(['llm', 'image', 'video', 'tts', 'ark', 'server']);

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 密钥掩码：前 4 后 4，中间固定 ****。空值返回『(未配置)』 */
function mask(v) {
  const s = String(v == null ? '' : v);
  if (!s) return '(未配置)';
  if (s.length <= 8) return `${s.slice(0, 1)}****`;
  return `${s.slice(0, 4)}****${s.slice(-4)}`;
}

/** 显示用路径：项目内用相对路径，项目外（如 /tmp 临时配置）直接给绝对路径 */
function displayPath(p) {
  const rel = path.relative(ROOT, p);
  return (!rel || rel.startsWith('..')) ? p : rel;
}

/** 去掉尾部斜杠 */
const stripSlash = (s) => String(s || '').replace(/\/+$/, '');

/** 把 baseUrl 归一成「Origin + 可选的 /vN 前缀」，用于拼只读端点 */
function apiRoot(baseUrl) {
  const raw = stripSlash(baseUrl);
  if (!raw) return '';
  try {
    const u = new URL(raw);
    // 方舟的余额不在同一 host（走 billing.volcengineapi.com），此处只处理 API host
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  } catch { return raw; }
}

/** 主机名小写；非法 URL 返回空串 */
function hostOf(url) {
  try { return new URL(String(url)).hostname.toLowerCase(); } catch { return ''; }
}

const isArkUrl = (url) => ARK_HOST_RE.test(hostOf(url));

/** 计算终端显示宽度（CJK 全角算 2 格），用于对齐中文表格 */
function dispWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    const wide =
      (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1f9ff) ||
      (c >= 0x20000 && c <= 0x3fffd);
    w += wide ? 2 : 1;
  }
  return w;
}
function pad(s, width) {
  const t = String(s == null ? '' : s);
  const w = dispWidth(t);
  return w >= width ? t : t + ' '.repeat(width - w);
}

/** 把长文本压成一行，便于进表格 */
function oneLine(s, max = 160) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// ---------------------------------------------------------------------------
// 脱敏：任何进日志/输出的文本，先把已知密钥和疑似密钥抹掉
// ---------------------------------------------------------------------------
let SECRETS = [];
function setSecrets(list) {
  SECRETS = Array.from(new Set((list || []).filter((s) => typeof s === 'string' && s.length >= 8)));
}
function scrub(text) {
  let t = String(text == null ? '' : text);
  for (const s of SECRETS) if (s) t = t.split(s).join('****');
  t = t.replace(/\b(sk-[A-Za-z0-9_-]{6,})/g, (m) => mask(m));
  t = t.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1****');
  t = t.replace(/\b(Authorization"\s*:\s*")[^"]{8,}(")/gi, '$1****$2');
  return t;
}

// ---------------------------------------------------------------------------
// 只读 HTTP 探测：区分「不可达」（网络层）与「失败」（HTTP 层）
// ---------------------------------------------------------------------------
/** Node 的 fetch 把真实错误藏在 cause 里（还可能包成 AggregateError.errors[]），要挖到底：
 *  最深一层的信息最具体（如 'bad port' / 'connect ECONNREFUSED 127.0.0.1:8799'），
 *  所以 message 取最深、code 取第一个找到的。 */
function deepNetInfo(e) {
  const seen = new Set();
  let code = '';
  let message = '';
  const walk = (x, depth = 0) => {
    if (!x || depth > 6 || typeof x !== 'object' || seen.has(x)) return;
    seen.add(x);
    if (!code && typeof x.code === 'string' && x.code) code = x.code;
    if (typeof x.message === 'string' && x.message) message = x.message;
    if (Array.isArray(x.errors)) for (const sub of x.errors) walk(sub, depth + 1);
    if (x.cause) walk(x.cause, depth + 1);
  };
  walk(e);
  return { code, message };
}

function classifyNetError(e, timeoutMs) {
  const deep = deepNetInfo(e);
  const code = deep.code || e?.code || '';
  const msg = String(deep.message || e?.message || e || '');
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError' || /abort|timed? ?out/i.test(String(e?.message || ''))) {
    return { label: `超时（>${timeoutMs}ms 无响应）`, code: code || 'ETIMEDOUT' };
  }
  if (code === 'ECONNREFUSED') return { label: '连接被拒绝（对端端口无监听）', code };
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return { label: '域名解析失败', code };
  if (code === 'ECONNRESET') return { label: '连接被重置', code };
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return { label: '网络不可达', code };
  if (code === 'ETIMEDOUT') return { label: `超时（>${timeoutMs}ms 无响应）`, code };
  if (code === 'CERT_HAS_EXPIRED' || /certificate/i.test(msg)) return { label: 'TLS 证书校验失败', code: code || 'CERT' };
  // Fetch 规范有一份「禁用端口」名单（9/25/465/587…），撞上会报 bad port 而不是连接被拒，
  // 极易被误读成网络故障 —— 单列出来提示换端口。
  if (/bad port/i.test(msg) || /bad port/i.test(String(e?.message || ''))) {
    return { label: '端口被 fetch 拒绝连接（命中 Fetch 规范的禁用端口名单，如 9/25/465/587；换端口重试）', code: 'BADPORT' };
  }
  return { label: `网络错误：${oneLine(msg || 'fetch failed', 80)}`, code: code || e?.name || 'NETERR' };
}

/**
 * 发一个只读请求。**调用方必须保证是只读语义**（GET/HEAD），
 * 或对火山控制面走 POST-Query（QueryBalanceAcct 是查询语义，不产生计费）。
 */
async function httpProbe(url, { headers = {}, method = 'GET', body, timeoutMs } = {}) {
  const started = Date.now();
  // 系统时钟可能被 NTP 回调 → 耗时算出来会是负数，钳到 0 避免出现「耗时 -12117ms」
  const elapsed = () => Math.max(0, Date.now() - started);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, headers, body, signal: ac.signal, redirect: 'follow' });
    const full = String((await res.text().catch(() => '')) || '');
    return {
      transport: 'http', status: res.status, ok: res.ok,
      // text = 脱敏 + 截断，只用于展示；raw = 完整原文，只用于 JSON 解析
      // （截断过的 JSON 解析必失败，曾导致「模型 N 个」数不出来）
      text: scrub(full).slice(0, 4000), raw: full.slice(0, 262144),
      ms: elapsed(), url,
    };
  } catch (e) {
    const net = classifyNetError(e, timeoutMs);
    return { transport: 'net', status: 0, ok: false, text: '', raw: '', ms: elapsed(), url, net };
  } finally { clearTimeout(timer); }
}

/** 解析响应体 JSON（优先用未截断的原文） */
function parseProbeJson(probe) {
  for (const src of [probe?.raw, probe?.text]) {
    if (!src) continue;
    try { return JSON.parse(src); } catch { /* 换下一个 */ }
  }
  return null;
}

/** 从响应体里抠出厂商错误码/信息（人读「依据」列要靠它） */
function errSummary(probe) {
  if (probe.transport === 'net') return `错误码 ${probe.net.code}：${probe.net.label}`;
  const j = parseProbeJson(probe);
  if (j) {
    const code = j?.error?.code || j?.code || j?.ResponseMetadata?.Error?.Code || j?.error?.type || '';
    const msg = j?.error?.message || j?.message || j?.ResponseMetadata?.Error?.Message || '';
    if (code || msg) return `HTTP ${probe.status} ${oneLine([code, msg].filter(Boolean).join(' · '), 120)}`;
  }
  // 成功响应没有错误码时只报状态码，绝不把整段模型列表 JSON 倒进「依据」（表格会被撑爆）
  if (probe.ok) return `HTTP ${probe.status}`;
  const snippet = oneLine(probe.text, 100);
  return `HTTP ${probe.status}${snippet ? ` ${snippet}` : ''}`;
}

/** 「依据」列的短形式：只要状态码 + 错误码，进结论表用 */
function shortBasis(probe, models) {
  if (!probe) return '无只读探测端点';
  if (probe.transport === 'net') return `网络错误 ${probe.net.code}`;
  if (probe.ok) return `HTTP ${probe.status}${models != null ? `（模型 ${models} 个）` : ''}`;
  const j = parseProbeJson(probe);
  if (j) {
    const code = j?.error?.code || j?.code || j?.ResponseMetadata?.Error?.Code || '';
    const type = j?.error?.type || '';
    if (type || code) return `HTTP ${probe.status} ${[type, code].filter(Boolean).join(' / ')}`;
  }
  return `HTTP ${probe.status}`;
}

/** 从 OpenAI 兼容 /models 响应里数模型个数 */
function countModels(probe) {
  const j = parseProbeJson(probe);
  if (!j) return null;
  const arr = Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : null;
  return arr ? arr.length : null;
}

// ---------------------------------------------------------------------------
// 火山引擎 V4 签名（HMAC-SHA256）—— 用于控制面 QueryBalanceAcct（只读查询，不计费）
// 参考火山引擎 OpenAPI 签名规则；等价 AWS SigV4：
//   SigningKey = HMAC(HMAC(HMAC(HMAC(SK, date), region), service), 'request')
// ---------------------------------------------------------------------------
const volcHmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
/** 火山要求 RFC3986 严格编码（encodeURIComponent 不编码 !'()*，需补上） */
const rfc3986 = (s) => encodeURIComponent(String(s)).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function volcSignedRequest({ service, region, host, action, version, query = {}, ak, sk, timeoutMs }) {
  const now = new Date();
  const xDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); // 20260930T111307Z
  const date = xDate.slice(0, 8);
  const q = { Action: action, Version: version, ...query };
  const canonicalQuery = Object.keys(q).sort().map((k) => `${rfc3986(k)}=${rfc3986(q[k])}`).join('&');
  const payloadHash = sha256hex('');
  const headers = { host, 'x-content-sha256': payloadHash, 'x-date': xDate };
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers).sort().map((k) => `${k}:${headers[k].trim()}\n`).join('');
  const canonicalRequest = ['POST', '/', canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${date}/${region}/${service}/request`;
  const stringToSign = ['HMAC-SHA256', xDate, scope, sha256hex(canonicalRequest)].join('\n');
  const kSigning = volcHmac(volcHmac(volcHmac(volcHmac(sk, date), region), service), 'request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return {
    url: `https://${host}/?${canonicalQuery}`,
    method: 'POST',
    headers: {
      ...headers,
      Authorization: `HMAC-SHA256 Credential=${ak}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    body: '',
    timeoutMs,
  };
}

/** 读 AK/SK（只读，绝不外传；返回掩码用于展示） */
function readArkCredentials() {
  try {
    if (!fs.existsSync(ARK_AK_FILE)) return { ok: false, reason: `AK/SK 文件不存在：${ARK_AK_FILE}` };
    const txt = fs.readFileSync(ARK_AK_FILE, 'utf8');
    const grab = (n) => { const m = new RegExp(`${n}\\s*[:=]\\s*(\\S+)`).exec(txt); return m ? m[1].trim() : ''; };
    const ak = grab('AccessKeyId');
    const sk = grab('SecretAccessKey');
    if (!ak || !sk) return { ok: false, reason: 'AK/SK 文件里缺少 AccessKeyId 或 SecretAccessKey 字段' };
    return { ok: true, ak, sk, akMasked: mask(ak), skMasked: mask(sk), file: ARK_AK_FILE };
  } catch (e) {
    return { ok: false, reason: `AK/SK 不可读（${e.code || e.name}）` };
  }
}

let arkBalanceCache = null;
/** 查询火山账户余额（控制面，只读查询；结果缓存一次，多个后端共用） */
async function arkBalance({ timeoutMs }) {
  if (arkBalanceCache) return arkBalanceCache;
  const cred = readArkCredentials();
  if (!cred.ok) {
    arkBalanceCache = { ok: false, skipped: true, reason: cred.reason, akMasked: '', evidence: `跳过余额查询：${cred.reason}` };
    return arkBalanceCache;
  }
  setSecrets([...SECRETS, cred.ak, cred.sk]);
  const req = volcSignedRequest({
    service: 'billing', region: 'cn-north-1', host: 'billing.volcengineapi.com',
    action: 'QueryBalanceAcct', version: '2022-01-01', ak: cred.ak, sk: cred.sk, timeoutMs,
  });
  const probe = await httpProbe(req.url, { ...req, headers: req.headers });
  if (probe.transport === 'net') {
    arkBalanceCache = { ok: false, skipped: false, reason: `余额接口不可达`, akMasked: cred.akMasked, probe, evidence: errSummary(probe) };
    return arkBalanceCache;
  }
  let j = null;
  try { j = JSON.parse(probe.text); } catch { /* ignore */ }
  const err = j?.ResponseMetadata?.Error;
  if (err) {
    arkBalanceCache = { ok: false, skipped: false, reason: `控制面查询失败：${err.Code}`, akMasked: cred.akMasked, probe, evidence: errSummary(probe) };
    return arkBalanceCache;
  }
  const R = j?.Result || {};
  const available = Number(R.AvailableBalance);
  const arrears = Number(R.ArrearsBalance);
  const accountId = R.AccountID != null ? String(R.AccountID) : '(未返回)';
  const currency = R.Currency || 'CNY';
  const inArrears = (Number.isFinite(available) && available < 0) || (Number.isFinite(arrears) && arrears > 0);
  arkBalanceCache = {
    ok: true, skipped: false, akMasked: cred.akMasked, accountId, available, arrears, currency, inArrears,
    evidence: `控制面 QueryBalanceAcct：AccountID ${accountId} · 可用余额 ${R.AvailableBalance} ${currency} · 欠费 ${R.ArrearsBalance} ${currency}`,
  };
  return arkBalanceCache;
}

// ---------------------------------------------------------------------------
// 只读探测端点推导：不同厂商的「鉴权类只读端点」各不相同
// ---------------------------------------------------------------------------
function readOnlyEndpoint(url, kind = 'models') {
  const raw = stripSlash(url);
  if (!raw) return null;
  const host = hostOf(raw);
  if (!host) return null;

  if (ARK_HOST_RE.test(host)) {
    return { url: `https://${host}/api/v3/models`, note: '方舟模型列表（只读；注意欠费账号也会返回 200，仅能证明鉴权通过）' };
  }
  if (/^dashscope\.aliyuncs\.com$/.test(host) || /\.aliyuncs\.com$/.test(host)) {
    return { url: `${new URL(raw).origin}/compatible-mode/v1/models`, note: '百炼 OpenAI 兼容模型列表（只读）' };
  }
  if (/^api\.deepseek\.com$/.test(host)) {
    return { url: `${new URL(raw).origin}/models`, note: 'DeepSeek 模型列表（只读）' };
  }
  if (/^api\.openai\.com$/.test(host)) {
    return { url: `${new URL(raw).origin}/v1/models`, note: 'OpenAI 模型列表（只读）' };
  }
  // 通用兜底：URL 里若带 /vN 版本前缀，就把尾部换成 /models
  try {
    const u = new URL(raw);
    const m = /^(\/v\d+(?:\.\d+)?)(\/|$)/.exec(u.pathname);
    if (m) return { url: `${u.origin}${m[1]}/models`, note: `按 URL 的 ${m[1]} 前缀推导的只读模型列表` };
    if (/^\/(models|v\d+\/models)$/.test(u.pathname)) return { url: `${u.origin}${u.pathname}`, note: 'URL 本身即只读模型列表' };
  } catch { return null; }
  return null;
}

// ---------------------------------------------------------------------------
// 退款/回滚建议：找一个「确实和当前配置不同」的备份当回滚点
//   真实坑：config.json.bak.ark 可能已经被同步成方舟配置（与线上逐字节相同），
//   拿它当回滚点是空操作 —— 所以这里必须比对内容而不是照抄文件名。
// ---------------------------------------------------------------------------
function findRollbackTarget(liveConfigPath) {
  let liveRaw = '';
  try { liveRaw = fs.readFileSync(liveConfigPath, 'utf8'); } catch { return null; }
  const liveHash = crypto.createHash('md5').update(liveRaw).digest('hex');
  let liveImg = '';
  try { liveImg = JSON.parse(liveRaw)?.image?.generic?.url || ''; } catch { /* ignore */ }
  // 备份通常留在项目 config/ 下；即使用 FACTORY_CONFIG 指到别处（如 /tmp 的临时配置），
  // 也要回项目 config/ 找可回滚点。两个目录都扫，按绝对路径去重。
  const dirs = Array.from(new Set([path.dirname(liveConfigPath), path.join(ROOT, 'config')]));
  const liveAbs = path.resolve(liveConfigPath);
  const scored = [];
  const seenPaths = new Set();
  for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(dir).filter((f) => /^config\.json.*(bak|broken|old)/i.test(f)); } catch { continue; }
    for (const f of names) {
      const p = path.resolve(path.join(dir, f));
      if (seenPaths.has(p) || p === liveAbs) continue;
      seenPaths.add(p);
      let raw = '';
      try { raw = fs.readFileSync(p, 'utf8'); } catch { continue; }
      if (crypto.createHash('md5').update(raw).digest('hex') === liveHash) continue; // 与线上同内容 → 不是有效回滚点
      let imgUrl = '';
      try { imgUrl = JSON.parse(raw)?.image?.generic?.url || ''; } catch { /* ignore */ }
      // 优先：非方舟的（说明是切方舟之前的备份）
      const nonArk = Boolean(imgUrl) && !isArkUrl(imgUrl);
      let mtime = 0;
      try { mtime = fs.statSync(p).mtimeMs; } catch { /* ignore */ }
      scored.push({ file: displayPath(p), abs: p, nonArk, imgUrl, mtime });
    }
  }
  if (!scored.length) return null;
  scored.sort((a, b) => (Number(b.nonArk) - Number(a.nonArk)) || (b.mtime - a.mtime));
  const best = scored[0];
  return { ...best, candidates: scored.length, liveIsArk: isArkUrl(liveImg) };
}

// ---------------------------------------------------------------------------
// 各段体检
// ---------------------------------------------------------------------------

/** 统一构造一条 check 记录 */
function mkCheck({ section, backend, endpoint, model, keyMasked, status, conclusion, evidence, advice, basis, impactsExit }) {
  const autoBasis = status === S.OFFLINE
    ? '—（无需网络）'
    : (/未配置|配置缺少/.test(String(conclusion)) ? '配置缺失' : '—');
  return {
    section, backend, endpoint: endpoint || '—', model: model || '—',
    keyMasked: keyMasked || '', status, conclusion,
    evidence: oneLine(evidence, 300),
    basis: oneLine(basis || autoBasis, 60),
    advice: advice || '无需动作',
    impactsExit: impactsExit !== false,
  };
}

const STATUS_LABEL = {
  [S.OK]: '可用', [S.DOWN]: '不可用', [S.UNREACHABLE]: '不可达',
  [S.OFFLINE]: '未启用/离线', [S.UNKNOWN]: '未知',
};

/** 根据只读探测结果 + 方舟余额给出结论与建议（出图/视频/TTS 共用） */
function judgeProbe({ section, backend, probe, apiKeyMasked, endpoint, model, kindLabel, arkCtx }) {
  const models = probe ? countModels(probe) : null;
  const base = { section, backend, endpoint, model, keyMasked: apiKeyMasked, basis: shortBasis(probe, models) };
  if (!probe) {
    return mkCheck({
      ...base, status: S.UNKNOWN,
      conclusion: '未知：无只读探测端点，需真机验证',
      evidence: '该后端没有可安全调用的只读端点（生成类接口多为 POST，探测即计费，违反零付费约束）',
      basis: '无只读探测端点',
      advice: `无法零成本判定。上线前用一条最小成本的${kindLabel}真机验证，或改用有 /models 只读端点的厂商`,
    });
  }
  if (probe.transport === 'net') {
    return mkCheck({
      ...base, status: S.UNREACHABLE,
      conclusion: '不可达：网络层连不上',
      evidence: `${errSummary(probe)}（${probe.ms}ms）`,
      advice: '确认服务地址/网络/防火墙；若为临时容器实例，可能已被平台释放，需重新申请地址并写回配置',
    });
  }
  const st = probe.status;

  // 方舟特有：欠费账号 /models 也返回 200 → 结论必须以余额为准，否则会给出假「可用」
  if (arkCtx && st >= 200 && st < 300) {
    if (arkCtx.ok && arkCtx.inArrears) {
      const owe = arkCtx.arrears > 0 ? arkCtx.arrears : Math.abs(arkCtx.available);
      return mkCheck({
        ...base, status: S.DOWN,
        basis: `QueryBalanceAcct 余额 ${arkCtx.available} ${arkCtx.currency}（欠费）`,
        conclusion: `不可用：方舟账号欠费（可用余额 ${arkCtx.available} ${arkCtx.currency}）`,
        evidence: `${arkCtx.evidence}；只读探测 ${errSummary(probe)} —— 注意模型列表在欠费账号上**仍返回 200**，不能作为可用依据`,
        advice: `充值 ${owe} ${arkCtx.currency} 即可解除 403；或切回非方舟后端（见下方回滚建议）`,
      });
    }
    if (arkCtx.ok && !arkCtx.inArrears) {
      return mkCheck({
        ...base, status: S.OK,
        basis: `HTTP ${st} 鉴权通过 + 余额 ${arkCtx.available} ${arkCtx.currency}`,
        conclusion: '可用：鉴权通过且余额充足',
        evidence: `${errSummary(probe)}${models != null ? `（模型 ${models} 个）` : ''}；${arkCtx.evidence}`,
        advice: '无需动作。注意本项未实测生成接口（零付费约束），仅证鉴权与余额',
      });
    }
    if (!arkCtx.ok) {
      return mkCheck({
        ...base, status: S.UNKNOWN,
        conclusion: '未知：只读端点返回 200，但无法确认余额（欠费账号同样返回 200）',
        evidence: `${errSummary(probe)}${models != null ? `（模型 ${models} 个）` : ''}；${arkCtx.evidence}`,
        advice: '这是本次事故的典型假阳性：/models 200 不代表能出图。请修好 AK/SK 读取后重跑以查余额，或直接做一次最小真机验证',
      });
    }
  }

  if (st >= 200 && st < 300) {
    return mkCheck({
      ...base, status: S.OK,
      conclusion: '可用：只读鉴权探测通过',
      evidence: `HTTP ${st} 只读端点可读${models != null ? `（模型 ${models} 个）` : ''}，耗时 ${probe.ms}ms`,
      advice: '无需动作',
    });
  }
  if (st === 401) {
    return mkCheck({
      ...base, status: S.DOWN, conclusion: '不可用：鉴权失败（密钥无效/未配置）',
      evidence: errSummary(probe),
      advice: `检查该段的 apiKey（当前掩码 ${apiKeyMasked}）：重新填写或在设置页保存有效密钥`,
    });
  }
  if (st === 403) {
    const arrearsHint = arkCtx && arkCtx.inArrears ? '（余额已确认为欠费）' : '';
    return mkCheck({
      ...base, status: S.DOWN, conclusion: `不可用：无权限/被拒${arrearsHint}`,
      evidence: errSummary(probe),
      advice: arkCtx && arkCtx.inArrears
        ? `方舟账号欠费导致 403 → 充值后重试；或立即切回非方舟后端（见下方回滚建议）`
        : '确认密钥权限、账号是否欠费、以及该模型是否已开通；方舟账号请用 AK/SK 查余额确认',
    });
  }
  if (st === 404) {
    return mkCheck({
      ...base, status: S.UNKNOWN, conclusion: '未知：只读端点不存在（404）',
      evidence: errSummary(probe),
      advice: '该厂商可能不提供模型列表端点；请直接做一次最小真机验证',
    });
  }
  if (st === 429) {
    return mkCheck({
      ...base, status: S.DOWN, conclusion: '不可用：限流（额度/并发超限）',
      evidence: errSummary(probe),
      advice: '降低并发（image.concurrency / video.concurrency）后重试；若为欠费型限流需充值',
    });
  }
  if (st >= 500) {
    return mkCheck({
      ...base, status: S.DOWN, conclusion: `不可用：厂商侧故障（HTTP ${st}）`,
      evidence: errSummary(probe),
      advice: '厂商侧临时故障 → 稍后重试，或临时切到备用后端',
    });
  }
  return mkCheck({
    ...base, status: S.DOWN, conclusion: `不可用：HTTP ${st}`,
    evidence: errSummary(probe),
    advice: '按上面的状态码与错误码排查该后端配置',
  });
}

async function checkLlm(cfg, { timeoutMs, arkCtx }) {
  const checks = [];
  const provider = String(cfg.llm?.provider || '').toLowerCase();
  const baseUrl = stripSlash(cfg.llm?.baseUrl);
  const apiKey = cfg.llm?.apiKey || process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || '';
  const model = cfg.llm?.model || '';
  const keyMasked = mask(apiKey);

  if (provider === 'mock') {
    checks.push(mkCheck({
      section: 'llm', backend: 'llm/mock', endpoint: '—', model: model || 'mock', keyMasked: '(不需要)',
      status: S.OFFLINE, conclusion: '离线，无需探测',
      evidence: 'mock 提供方为本地实现，不发任何网络请求，零成本',
      advice: '无需动作（如需真实写作请切到 deepseek/openai）',
    }));
    return checks;
  }
  if (!baseUrl) {
    checks.push(mkCheck({
      section: 'llm', backend: `llm/${provider || '(未配置)'}`, endpoint: '—', model, keyMasked,
      status: S.DOWN, conclusion: '不可用：未配置 baseUrl',
      evidence: '配置缺少 llm.baseUrl',
      advice: '在设置页填写 LLM 服务地址（DeepSeek 默认 https://api.deepseek.com）',
    }));
    return checks;
  }

  const root = apiRoot(baseUrl);
  // DeepSeek 专有：余额端点（只读查询，不计费）
  if (provider === 'deepseek' || /api\.deepseek\.com$/i.test(hostOf(baseUrl))) {
    const url = `${root}/user/balance`;
    const probe = await httpProbe(url, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}, timeoutMs });
    if (probe.transport === 'http' && probe.ok) {
      let j = null; try { j = JSON.parse(probe.text); } catch { /* ignore */ }
      const infos = Array.isArray(j?.balance_infos) ? j.balance_infos : [];
      const first = infos[0] || {};
      const total = Number(first.total_balance);
      const avail = j?.is_available;
      if (avail === false || (Number.isFinite(total) && total <= 0)) {
        checks.push(mkCheck({
          section: 'llm', backend: 'llm/deepseek（余额）', endpoint: url, model, keyMasked,
          basis: `HTTP ${probe.status} 余额 ${first.total_balance ?? '?'}`,
          status: S.DOWN, conclusion: `不可用：DeepSeek 账户余额不足（${first.total_balance ?? '?'} ${first.currency || 'CNY'}）`,
          evidence: errSummary(probe),
          advice: 'DeepSeek 平台充值后再跑剧本/大纲类任务；或切到有余额的提供方',
        }));
      } else {
        checks.push(mkCheck({
          section: 'llm', backend: 'llm/deepseek（余额）', endpoint: url, model, keyMasked,
          basis: `HTTP ${probe.status} 余额 ${first.total_balance ?? '?'} ${first.currency || 'CNY'}`,
          status: S.OK, conclusion: `可用：余额 ${first.total_balance ?? '?'} ${first.currency || 'CNY'}`,
          evidence: `HTTP ${probe.status} is_available=${avail} balance_infos=${infos.length} 条（${probe.ms}ms）`,
          advice: '无需动作',
        }));
      }
    } else {
      checks.push(judgeProbe({
        section: 'llm', backend: 'llm/deepseek（余额）', probe, apiKeyMasked: keyMasked,
        endpoint: url, model, kindLabel: 'LLM', arkCtx: null,
      }));
    }
  }

  // 通用：GET /models（OpenAI 兼容与 DeepSeek 都支持）
  const modelsUrl = `${root}/models`;
  const probe = await httpProbe(modelsUrl, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}, timeoutMs });
  checks.push(judgeProbe({
    section: 'llm', backend: `llm/${provider || 'openai'}（模型列表）`, probe, apiKeyMasked: keyMasked,
    endpoint: modelsUrl, model, kindLabel: 'LLM', arkCtx: null,
  }));
  return checks;
}

async function checkImage(cfg, { timeoutMs, arkCtx }) {
  const checks = [];
  const backend = String(cfg.image?.backend || 'placeholder');
  const key = cfg.image?.generic?.apiKey || cfg.image?.openai?.apiKey || process.env.IMAGE_API_KEY || process.env.OPENAI_API_KEY || '';
  const keyMasked = mask(key);

  if (backend === 'placeholder') {
    checks.push(mkCheck({
      section: 'image', backend: 'image/placeholder', endpoint: '—', model: '本地 SVG 占位', keyMasked: '(不需要)',
      status: S.OFFLINE, conclusion: '本地占位，零成本',
      evidence: '按档案信息渲染 SVG 定妆卡，不发任何外部请求',
      advice: '无需动作（正式出图需切到 generic-http / openai-images）',
    }));
    return checks;
  }
  if (backend === 'comfyui') {
    const url = stripSlash(cfg.image?.comfy?.url);
    if (!url) {
      checks.push(mkCheck({
        section: 'image', backend: 'image/comfyui', endpoint: '—', model: cfg.image?.comfy?.workflowPath || '',
        keyMasked: '(不需要)', status: S.DOWN, conclusion: '不可用：未配置 ComfyUI 地址',
        evidence: '配置缺少 image.comfy.url',
        advice: '在设置 → 出图 填写 ComfyUI 实例地址，或改回百炼 generic-http',
      }));
      return checks;
    }
    const probe = await httpProbe(`${url}/system_stats`, { timeoutMs });
    checks.push(judgeProbe({
      section: 'image', backend: 'image/comfyui', probe, apiKeyMasked: '(不需要)',
      endpoint: `${url}/system_stats`, model: 'comfyui', kindLabel: '出图', arkCtx: null,
    }));
    return checks;
  }

  const isOpenai = backend === 'openai-images';
  const rawUrl = isOpenai ? cfg.image?.openai?.baseUrl : cfg.image?.generic?.url;
  const model = isOpenai ? cfg.image?.openai?.model : cfg.image?.generic?.model;
  const url = stripSlash(rawUrl);
  if (!url) {
    checks.push(mkCheck({
      section: 'image', backend: `image/${backend}`, endpoint: '—', model, keyMasked,
      status: S.DOWN, conclusion: '不可用：未配置后端地址',
      evidence: `配置缺少 image.${isOpenai ? 'openai.baseUrl' : 'generic.url'}`,
      advice: '在设置 → 出图 填写后端地址，或先切到 placeholder 跑通流程',
    }));
    return checks;
  }
  const ep = readOnlyEndpoint(url, 'image');
  const probe = ep ? await httpProbe(ep.url, { headers: key ? { Authorization: `Bearer ${key}` } : {}, timeoutMs }) : null;
  checks.push(judgeProbe({
    section: 'image', backend: `image/${backend}`, probe, apiKeyMasked: keyMasked,
    endpoint: ep ? `${ep.url}${ep.note ? ` （${ep.note}）` : ''}` : `${url} （生成端点为 POST，无只读探测端点）`,
    model, kindLabel: '出图', arkCtx: isArkUrl(url) ? arkCtx : null,
  }));
  return checks;
}

async function checkVideo(cfg, { timeoutMs, arkCtx }) {
  const checks = [];
  const backend = String(cfg.video?.backend || 'placeholder');
  const key = cfg.video?.generic?.apiKey || '';

  if (backend === 'placeholder') {
    checks.push(mkCheck({
      section: 'video', backend: 'video/placeholder', endpoint: '—', model: '本地 ffmpeg 运镜', keyMasked: '(不需要)',
      status: S.OFFLINE, conclusion: '本地占位，零成本',
      evidence: '把关键帧做推/拉/摇/移镜头生成 mp4，无外部依赖',
      advice: '无需动作（正式出片需切到 comfyui-h3 / generic-http）',
    }));
    return checks;
  }
  if (backend === 'comfyui-h3') {
    const url = stripSlash(cfg.video?.comfy?.url);
    const model = cfg.video?.comfy?.model || 'minimax-h3';
    if (!url) {
      checks.push(mkCheck({
        section: 'video', backend: 'video/comfyui-h3', endpoint: '—', model, keyMasked: '(不需要)',
        status: S.DOWN, conclusion: '不可用：未配置 ComfyUI 实例地址',
        evidence: '配置缺少 video.comfy.url',
        advice: '在设置 → 视频 填写云实例地址；临时容器被释放后需向平台索取新地址',
      }));
      return checks;
    }
    const statsUrl = `${url}/system_stats`;
    const probe = await httpProbe(statsUrl, { timeoutMs });
    let gpuNote = '';
    if (probe.transport === 'http' && probe.ok) {
      try {
        const j = JSON.parse(probe.text);
        const dev = j?.devices?.[0] || {};
        if (dev.name) gpuNote = `${dev.name}${dev.vram_total ? `（显存 ${Math.round(dev.vram_total / 1073741824)}GB）` : ''}`;
      } catch { /* ignore */ }
    }
    const c = judgeProbe({
      section: 'video', backend: 'video/comfyui-h3', probe, apiKeyMasked: '(不需要)',
      endpoint: statsUrl, model, kindLabel: '视频', arkCtx: null,
    });
    if (gpuNote && c.status === S.OK) {
      c.evidence = `HTTP 200 /system_stats：ComfyUI 在线 ${gpuNote}；${c.evidence}`;
    }
    // 可选：/object_info 头部（只读，验证节点字典可拉取；失败不影响主结论，只作补充）
    if (c.status === S.OK) {
      const oi = await httpProbe(`${url}/object_info`, { timeoutMs });
      if (oi.ok) {
        let n = null;
        try { n = Object.keys(JSON.parse(oi.text)).length; } catch { /* ignore */ }
        c.evidence = `${c.evidence}；/object_info HTTP 200${n ? `（节点 ${n} 个）` : ''}`;
      } else {
        c.evidence = `${c.evidence}；/object_info ${oi.transport === 'net' ? oi.net.label : `HTTP ${oi.status}`}（不影响在线判定，但提交前的节点预检会失败）`;
      }
    }
    checks.push(c);
    return checks;
  }

  // generic-http
  const url = stripSlash(cfg.video?.generic?.url);
  const model = cfg.video?.generic?.model || '';
  if (!url) {
    checks.push(mkCheck({
      section: 'video', backend: 'video/generic-http', endpoint: '—', model, keyMasked: mask(key),
      status: S.DOWN, conclusion: '不可用：未配置后端地址',
      evidence: '配置缺少 video.generic.url',
      advice: '在设置 → 视频 填写后端地址，或先切到 placeholder',
    }));
    return checks;
  }
  const ep = readOnlyEndpoint(url, 'video');
  const probe = ep ? await httpProbe(ep.url, { headers: key ? { Authorization: `Bearer ${key}` } : {}, timeoutMs }) : null;
  if (!ep) {
    // 无只读端点：明确写出来，别假装可用（方舟视频任务接口就是这种）
    const isArk = isArkUrl(url);
    const extra = isArk && arkCtx && arkCtx.ok
      ? `；方舟余额：${arkCtx.evidence}${arkCtx.inArrears ? ` → **欠费，生成任务必然 403**` : ' → 余额正常'}`
      : '';
    checks.push(mkCheck({
      section: 'video', backend: 'video/generic-http', endpoint: `${url} （生成端点为 POST，无只读探测端点）`,
      model, keyMasked: mask(key), basis: '无只读探测端点（未判定）',
      status: isArk && arkCtx && arkCtx.inArrears ? S.DOWN : S.UNKNOWN,
      conclusion: isArk && arkCtx && arkCtx.inArrears
        ? `不可用：方舟账号欠费（可用余额 ${arkCtx.available} ${arkCtx.currency}）`
        : '无只读探测端点，需真机验证',
      evidence: `该后端的创建任务是 POST（提交即计费），本脚本在零付费约束下不探测${extra}`,
      advice: isArk && arkCtx && arkCtx.inArrears
        ? `充值 ${arkCtx.arrears > 0 ? arkCtx.arrears : Math.abs(arkCtx.available)} ${arkCtx.currency} 后重试；或切回 placeholder / 非方舟后端`
        : '上线前做一次最小成本真机验证（单条最短时长），失败时优先怀疑余额/模型白名单',
    }));
    return checks;
  }
  checks.push(judgeProbe({
    section: 'video', backend: 'video/generic-http', probe, apiKeyMasked: mask(key),
    endpoint: `${ep.url}${ep.note ? ` （${ep.note}）` : ''}`, model, kindLabel: '视频', arkCtx: isArkUrl(url) ? arkCtx : null,
  }));
  return checks;
}

async function checkTts(cfg, { timeoutMs, arkCtx }) {
  const checks = [];
  const backend = String(cfg.tts?.backend || 'none');

  if (backend === 'none') {
    checks.push(mkCheck({
      section: 'tts', backend: 'tts/none', endpoint: '—', model: cfg.tts?.model || '—', keyMasked: '(未启用)',
      status: S.OFFLINE, conclusion: '未启用',
      evidence: '配置 tts.backend = none，成片不配音（finish.audio 走 silent/bgm）',
      advice: '无需动作（需要配音时切到 openai / generic-http，并注意按字符计费）',
    }));
    return checks;
  }

  const isOpenai = backend === 'openai';
  const baseUrl = stripSlash(isOpenai ? cfg.tts?.openai?.baseUrl : cfg.tts?.generic?.url);
  const key = isOpenai ? cfg.tts?.openai?.apiKey : cfg.tts?.generic?.apiKey;
  const model = isOpenai ? (cfg.tts?.openai?.model || cfg.tts?.model) : cfg.tts?.generic?.model;
  const keyMasked = mask(key);

  if (!baseUrl) {
    checks.push(mkCheck({
      section: 'tts', backend: `tts/${backend}`, endpoint: '—', model, keyMasked,
      status: S.DOWN, conclusion: '不可用：未配置服务地址',
      evidence: `配置缺少 tts.${isOpenai ? 'openai.baseUrl' : 'generic.url'}`,
      advice: '在设置 → 配音 填写地址，或把 tts.backend 改回 none',
    }));
    return checks;
  }
  // TTS 的合成端点是 POST；能用的只读探测是模型列表（/v1/models 或按前缀推导）
  const ep = isOpenai
    ? { url: `${apiRoot(baseUrl) || baseUrl}/models`, note: 'OpenAI 兼容模型列表（只读）' }
    : readOnlyEndpoint(baseUrl, 'tts');
  const probe = ep ? await httpProbe(ep.url, { headers: key ? { Authorization: `Bearer ${key}` } : {}, timeoutMs }) : null;
  checks.push(judgeProbe({
    section: 'tts', backend: `tts/${backend}`, probe, apiKeyMasked: keyMasked,
    endpoint: ep ? `${ep.url}${ep.note ? ` （${ep.note}）` : ''}` : `${baseUrl} （合成端点为 POST，无只读探测端点）`,
    model, kindLabel: 'TTS', arkCtx: isArkUrl(baseUrl) ? arkCtx : null,
  }));
  return checks;
}

/** 方舟特有段：AK/SK → QueryBalanceAcct
 *  arkInUse=false（当前配置压根没用方舟）时，这条只作「潜在风险」提示，
 *  不参与退出码判定 —— 退出码表达的是「当前配置能不能跑」，不是「别的账号有没有欠费」。 */
async function checkArk(cfg, { timeoutMs, arkInUse }) {
  const bal = await arkBalance({ timeoutMs });
  const cred = readArkCredentials();
  const base = {
    section: 'ark', backend: 'ark/火山方舟计费（AK/SK 签名）',
    endpoint: 'POST https://billing.volcengineapi.com/?Action=QueryBalanceAcct&Version=2022-01-01',
    model: 'QueryBalanceAcct', keyMasked: cred.ok ? `AK ${cred.akMasked} / SK ${cred.skMasked}` : (bal.akMasked || '(不可读)'),
    impactsExit: Boolean(arkInUse),
  };
  if (bal.ok) {
    const owe = bal.arrears > 0 ? bal.arrears : Math.abs(bal.available);
    return [mkCheck({
      ...base,
      status: bal.inArrears ? S.DOWN : S.OK,
      basis: `QueryBalanceAcct AccountID ${bal.accountId}`,
      conclusion: bal.inArrears
        ? `欠费：可用余额 ${bal.available} ${bal.currency}（欠 ${owe} ${bal.currency}）`
        : `正常：可用余额 ${bal.available} ${bal.currency}`,
      evidence: bal.evidence,
      advice: bal.inArrears
        ? (arkInUse
          ? `充值 ${owe} ${bal.currency} 解除欠费；欠费状态下方舟所有生成接口返回 403，出图/出视频全废`
          : `当前配置未使用方舟，本次结论不受影响；但一旦切到方舟（出图/出视频）会全线 403 → 切之前先充值 ${owe} ${bal.currency}`)
        : '无需动作',
    })];
  }
  if (bal.skipped) {
    return [mkCheck({
      ...base, status: S.UNKNOWN, basis: 'AK/SK 不可读',
      conclusion: '跳过：AK/SK 不可读，无法查余额',
      evidence: `${bal.evidence}（只读读取 ${ARK_AK_FILE}）`,
      advice: '补上可读的 AK/SK 后重跑本项；在此之前方舟欠费类故障（/models 仍 200 但生成 403）无法被自动发现',
    })];
  }
  return [mkCheck({
    ...base, status: bal.reason === '余额接口不可达' ? S.UNREACHABLE : S.DOWN,
    basis: bal.probe ? shortBasis(bal.probe) : '查询失败',
    conclusion: `查询失败：${bal.reason}`, evidence: bal.evidence,
    advice: '检查 AK/SK 是否有效、本机能否访问 billing.volcengineapi.com；签名错误通常表现为 InvalidAccessKey 或 SignatureDoesNotMatch',
  })];
}

// ---------------------------------------------------------------------------
// 环境风险：双 server 实例（双份 loadConfig 内存缓存会互相覆盖配置）
// ---------------------------------------------------------------------------
/** 用 ss/lsof 把 PID 映射到监听端口（只读；失败就留空，不影响主结论） */
function listenPortsByPid() {
  const map = new Map();
  const parse = (out, re) => {
    for (const line of String(out).split('\n')) {
      const m = re.exec(line);
      if (m) map.set(Number(m[2]), Number(m[1]));
    }
  };
  try {
    // ss -ltnp: LISTEN 0 511 127.0.0.1:8788 0.0.0.0:* users:(("MainThread",pid=1611475,fd=24))
    const out = execFileSync('ss', ['-ltnp'], { encoding: 'utf8', timeout: 5000 });
    parse(out, /\s(?:\d+\.\d+\.\d+\.\d+|\[::\]|\*):(\d+)\s.*pid=(\d+)/);
  } catch { /* ss 不可用，忽略 */ }
  return map;
}

function detectServerInstances() {
  let out = '';
  try {
    out = execFileSync('ps', ['-eo', 'pid=,ppid=,etime=,args='], { encoding: 'utf8', timeout: 5000 });
  } catch (e) {
    return { supported: false, reason: `ps 不可用：${e.code || e.message}`, instances: [] };
  }
  const ports = listenPortsByPid();
  const instances = [];
  for (const row of String(out).split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(row);
    if (!m) continue;
    const [, pid, ppid, etime, cmd] = m;
    if (!/\bnode\b/.test(cmd)) continue;
    if (!/(^|[\s/])server\.js(\s|$)/.test(cmd)) continue;
    if (!/server\.js/.test(cmd)) continue;
    let cwd = '';
    try { cwd = fs.realpathSync(`/proc/${pid}/cwd`); } catch { cwd = ''; }
    if (cwd && cwd !== ROOT) continue; // 别的项目的 server.js，不算本项目的双实例
    instances.push({
      pid: Number(pid), ppid: Number(ppid), etime, cmd: oneLine(cmd, 120),
      cwd: cwd || '(未知)', port: ports.get(Number(pid)) || null,
    });
  }
  return { supported: true, instances };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (e) {
    process.stderr.write(`参数错误：${e.message}\n用法：node scripts/check-backends.js [--json] [--only image,video] [--timeout 8000]\n`);
    process.exit(2);
  }
  if (args.help) {
    process.stdout.write([
      '后端体检（只读 · 零付费）',
      '',
      '用法：node scripts/check-backends.js [选项]',
      '  --json              只输出 JSON（stdout 干净，便于 CI 解析）',
      '  --only <段>         只查部分段，逗号分隔：llm,image,video,tts,ark,server',
      '  --timeout <ms>      每项探测超时（默认 8000，上限 60000）',
      '  -h, --help          显示本帮助',
      '',
      '退出码：0=全部可用或未启用；1=存在不可用项；2=参数错误/配置读取失败',
      '环境变量：FACTORY_CONFIG=<路径> 可体检另一份配置（不动线上 config/config.json）',
      '',
    ].join('\n'));
    process.exit(0);
  }

  let cfg, configPath = '', dbIsolation = '';
  try {
    // import '../src/config.js' 会连带 import '../src/db.js'，而 db.js 在模块顶层就
    // new DatabaseSync(DB_FILE)（还会跑 PRAGMA journal_mode=WAL）。虽然实测不改动
    // data/factory.db 的 mtime，但一个「只读体检」没有任何理由去打开生产库 ——
    // 万一以后 SCHEMA_VERSION 自增触发 migrate()，就会写库。
    // 所以先把 db.js 的数据目录指到一次性临时目录，让它开一份废弃的 SQLite；
    // 配置读取完全不受影响（CONFIG_DIR/CONFIG_FILE 由 FACTORY_CONFIG 与项目根决定）。
    const prevDataDir = process.env.FACTORY_DATA_DIR;
    const prevDbFile = process.env.FACTORY_DB;
    const tmpDir = path.join(os.tmpdir(), `backend-doctor-${process.pid}`);
    let isolated = false;
    try {
      fs.mkdirSync(tmpDir, { recursive: true });
      process.env.FACTORY_DATA_DIR = tmpDir;
      process.env.FACTORY_DB = path.join(tmpDir, 'probe.db');
      isolated = true;
    } catch { /* 临时目录不可用 → 回落，仍不影响正确性 */ }
    const mod = await import('../src/config.js');
    cfg = mod.loadConfig();
    configPath = mod.CONFIG_FILE;
    // 自证清白：把 db.js 实际打开的库文件路径记下来（模块已缓存，这次 import 不产生副作用），
    // 写进 JSON 的 db_file，任何人都能据此核对「体检没有碰线上 data/factory.db」。
    let openedDb = '';
    try { openedDb = (await import('../src/db.js')).DB_FILE || ''; } catch { /* ignore */ }
    const prodDb = path.join(ROOT, 'data', 'factory.db');
    const touchedProd = path.resolve(openedDb || prodDb) === path.resolve(prodDb);
    dbIsolation = isolated && !touchedProd
      ? `已隔离：db.js 打开的是临时库 ${openedDb}，未打开线上 data/factory.db`
      : `未隔离：db.js 打开的是 ${openedDb || '(未知)'}`;
    if (!isolated) {
      process.env.FACTORY_DATA_DIR = prevDataDir;
      process.env.FACTORY_DB = prevDbFile;
    }
    // 进程退出时清掉一次性临时库（尽力而为）
    if (isolated) process.on('exit', () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } });
  } catch (e) {
    process.stderr.write(`配置读取失败：${scrub(e.message)}\n`);
    process.exit(2);
  }
  // 配置文件不存在时 src/config.js 会静默回落到内置默认值 —— 此时结论不代表线上配置，
  // 必须显式说明，否则「体检通过」会变成一句误导。
  const configMissing = !fs.existsSync(configPath);
  if (configMissing) {
    process.stderr.write(`警告：配置文件不存在（${displayPath(configPath)}），本次体检的是内置默认配置，结论不代表线上效果。\n`);
  }
  // 收集所有密钥用于脱敏（绝不打印）
  setSecrets([
    cfg.llm?.apiKey, cfg.image?.generic?.apiKey, cfg.image?.openai?.apiKey,
    cfg.video?.generic?.apiKey, cfg.video?.comfy?.apiKey,
    cfg.tts?.openai?.apiKey, cfg.tts?.generic?.apiKey,
    process.env.DEEPSEEK_API_KEY, process.env.OPENAI_API_KEY, process.env.IMAGE_API_KEY,
  ]);

  const timeoutMs = args.timeoutMs;
  const ctx = { timeoutMs, arkCtx: null };

  const sel = args.only;
  const wants = (s) => !sel || sel.has(s);
  if (sel) {
    const bad = [...sel].filter((s) => !VALID_SECTIONS.has(s));
    if (bad.length) {
      process.stderr.write(`参数错误：--only 里有不认识的段 ${bad.join(', ')}；可选 ${[...VALID_SECTIONS].join(',')}\n`);
      process.exit(2);
    }
  }

  // 当前配置里哪些「被选中的段」真的指向方舟 —— 决定欠费是否影响退出码
  const arkRefs = [
    ['llm', cfg.llm?.baseUrl], ['image', cfg.image?.generic?.url], ['image', cfg.image?.openai?.baseUrl],
    ['video', cfg.video?.generic?.url], ['video', cfg.video?.comfy?.url],
    ['tts', cfg.tts?.openai?.baseUrl], ['tts', cfg.tts?.generic?.url],
  ].filter(([sec, url]) => url && isArkUrl(url) && wants(sec));
  const arkInUse = arkRefs.length > 0;

  const checks = [];

  // 方舟余额必须在各段体检**之前**拿到：欠费是整个方舟链路的否决项，
  // 而 /models 在欠费账号上照样返回 200 —— 先探测再查余额会得出假「可用」。
  const arkNeeded = wants('ark') || arkInUse;
  if (arkNeeded) ctx.arkCtx = await arkBalance({ timeoutMs });

  if (wants('llm')) checks.push(...await checkLlm(cfg, ctx));
  if (wants('image')) checks.push(...await checkImage(cfg, ctx));
  if (wants('video')) checks.push(...await checkVideo(cfg, ctx));
  if (wants('tts')) checks.push(...await checkTts(cfg, ctx));
  if (wants('ark') && arkNeeded) checks.push(...await checkArk(cfg, { timeoutMs, arkInUse }));

  // 环境检查：双实例
  const server = wants('server') ? detectServerInstances() : { supported: true, instances: [] };
  const configuredPort = cfg.server?.port || 8788;
  const portText = (i) => (i.port ? `监听 :${i.port}` : '未监听任何端口（可能绑定失败）');
  const keeper = server.instances.find((i) => i.port === configuredPort);
  const dualWarning = server.instances.length > 1
    ? `检测到 ${server.instances.length} 个 server.js 实例同时运行：${server.instances.map((i) => `PID ${i.pid}（${portText(i)}，已运行 ${i.etime}）`).join('、')}。双实例各持一份 loadConfig 内存缓存，界面保存配置后另一边仍用旧配置，会互相覆盖（这就是「改了配置不生效」的常见根因）。建议只保留${keeper ? `监听配置端口 :${configuredPort} 的 PID ${keeper.pid}` : `监听 :${configuredPort} 的那个`}，其余按精确 PID 停掉（本脚本只告警，绝不代劳）。`
    : '';

  // 建议：回滚目标
  const rollback = findRollbackTarget(configPath);
  const failing = checks.filter((c) => FAILING.has(c.status) && c.impactsExit !== false);
  const advisoryFailing = checks.filter((c) => FAILING.has(c.status) && c.impactsExit === false);
  if (failing.length) {
    for (const c of failing) {
      const bits = [c.advice];
      if (rollback) {
        bits.push(`可回滚到 ${rollback.file}（内容与线上不同${rollback.nonArk ? '，指向非方舟后端' : ''}）：cp ${rollback.file} ${displayPath(configPath)} 后按精确 PID 重启`);
      } else if (arkInUse) {
        bits.push('未找到与线上内容不同的可用备份：请先 cp config/config.json config/config.json.bak.<日期> 再改，避免下次无点可回滚');
      }
      c.advice = oneLine(bits.filter(Boolean).join(' → '), 400);
    }
  }

  const risks = [];
  const unknown = checks.filter((c) => c.status === S.UNKNOWN);
  if (unknown.length) risks.push(`${unknown.length} 项为「未知」（无只读探测端点或无法判定，本次未能确认）：${unknown.map((c) => c.backend).join('、')} —— 零付费约束下的必然盲区，需最小成本真机验证`);
  if (advisoryFailing.length) risks.push(`潜在风险（不影响本次退出码，因为当前配置未使用它）：${advisoryFailing.map((c) => `${c.backend} → ${c.conclusion}`).join('；')}`);
  if (dualWarning) risks.push(dualWarning);
  risks.push('只读探测只能证明「鉴权 + 账户额度」；厂商侧模型白名单、内容审核、尺寸约束仍可能在实际生成时拒绝，「可用」不等于保证出片');
  risks.push('方舟特性：欠费账号 GET /api/v3/models 仍返回 200，故方舟结论以 AK/SK 查余额（QueryBalanceAcct）为准，模型列表只证鉴权');
  risks.push('本脚本只读，不生成、不写配置、不重启服务；任何自动修复动作均需人工执行');

  const exitCode = failing.length ? 1 : 0;

  // 一句话总结：同一段多项时取最差状态，避免「LLM=可用；LLM=可用」这种重复
  const SEC_ORDER = ['llm', 'image', 'video', 'tts', 'ark'];
  const SEC_CN_LABEL = { llm: 'LLM', image: '出图', video: '视频', tts: 'TTS', ark: '方舟计费' };
  const rank = { [S.DOWN]: 3, [S.UNREACHABLE]: 3, [S.UNKNOWN]: 2, [S.OK]: 1, [S.OFFLINE]: 0 };
  const summaryParts = [];
  for (const sec of SEC_ORDER) {
    const group = checks.filter((c) => c.section === sec);
    if (!group.length) continue;
    const worst = group.reduce((a, b) => (rank[b.status] > rank[a.status] ? b : a));
    const lbl = SEC_CN_LABEL[sec];
    if (sec === 'ark' && worst.status === S.DOWN && worst.impactsExit === false) {
      const m = /可用余额\s*(-?[\d.]+)/.exec(worst.conclusion);
      summaryParts.push(`${lbl}=欠费${m ? ` ${Math.abs(Number(m[1]))} ${ctx.arkCtx?.currency || 'CNY'}` : ''}（当前配置未使用）`);
      continue;
    }
    const OFFLINE_WORD = { tts: '未启用', llm: '离线(mock)', image: '本地零成本', video: '本地零成本' };
    const WORD = { [S.OK]: '可用', [S.DOWN]: '不可用', [S.UNREACHABLE]: '不可达', [S.UNKNOWN]: '未知', [S.OFFLINE]: OFFLINE_WORD[sec] || '离线' };
    summaryParts.push(`${lbl}=${WORD[worst.status]}`);
  }
  const summary = `${summaryParts.join('；')}${dualWarning ? '；⚠ 双 server 实例' : ''}`;

  const report = {
    tool: 'scripts/check-backends.js',
    project: PROJECT,
    generated_at: new Date().toISOString(),
    config_path: displayPath(configPath),
    config_source: configMissing
      ? '配置文件不存在 → 已回落到内置默认配置（结论不代表线上）'
      : (process.env.FACTORY_CONFIG ? 'FACTORY_CONFIG 环境变量（临时配置）' : '默认 config/config.json'),
    config_missing: configMissing,
    readonly: true,
    zero_cost: true,
    db_isolation: dbIsolation,
    timeout_ms: timeoutMs,
    only: sel ? [...sel] : null,
    summary,
    checks,
    ark_in_use: arkInUse,
    warnings: dualWarning ? [dualWarning] : [],
    server_instances: server,
    exit_codes: { 0: '全部可用或未启用', 1: '存在不可用项', 2: '参数错误 / 配置读取失败' },
    exit_code: exitCode,
    risks,
  };

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exit(exitCode);
  }

  // ---------------- 人读输出 ----------------
  const L = [];
  L.push('══════════════════ 后端体检（只读 · 零付费） ══════════════════');
  L.push(`配置来源 : ${report.config_path}（${report.config_source}）`);
  L.push(`体检时间 : ${report.generated_at}`);
  L.push(`探测超时 : ${timeoutMs}ms/项    仅探测: ${sel ? [...sel].join(',') : '全部'}`);
  L.push('');
  L.push('【逐后端体检明细】');
  const SEC_CN = { llm: 'LLM', image: '出图', video: '视频', tts: 'TTS', ark: '方舟计费' };
  const MARK = { ok: '✔ 可用', down: '✘ 不可用', unreachable: '✘ 不可达', offline: '· 无需探测', unknown: '? 未知' };
  for (const c of checks) {
    L.push(`── ${SEC_CN[c.section] || c.section} ───────────────────────────────────`);
    L.push(`  后端类型 : ${c.backend}`);
    L.push(`  端点     : ${oneLine(c.endpoint, 200)}`);
    L.push(`  模型     : ${c.model}${c.keyMasked ? `    密钥: ${c.keyMasked}` : ''}`);
    L.push(`  结论     : ${MARK[c.status] || c.status} — ${c.conclusion}`);
    L.push(`  依据     : ${c.evidence}`);
    L.push(`  建议动作 : ${c.advice}`);
    L.push('');
  }
  if (server.supported) {
    L.push('【运行环境】');
    L.push(`  只读声明 : ${report.db_isolation}`);
    if (configMissing) L.push('  ⚠ 配置文件不存在，以上结论来自内置默认配置，不代表线上效果');
    if (!server.instances.length) L.push('  server 实例 : 未检测到（服务可能没在跑；本脚本只做只读探测，不会启动服务）');
    else for (const i of server.instances) L.push(`  server 实例 : PID ${i.pid}（父 ${i.ppid}，已运行 ${i.etime}，${i.port ? `监听 :${i.port}` : '未监听端口'}） ${i.cmd}`);
    if (dualWarning) L.push(`  ⚠ ${dualWarning}`);
    L.push('');
  }
  L.push('【结论表】');
  const cols = [
    { h: '段', w: 8 }, { h: '后端', w: 22 }, { h: '结论', w: 12 }, { h: '依据（状态码/错误码）', w: 30 },
  ];
  L.push(cols.map((c) => pad(c.h, c.w)).join('  '));
  L.push(cols.map((c) => '─'.repeat(c.w)).join('  '));
  for (const c of checks) {
    const lbl = { llm: 'LLM', image: '出图', video: '视频', tts: 'TTS', ark: '方舟计费' }[c.section] || c.section;
    L.push([pad(lbl, 8), pad(oneLine(c.backend, 22), 22), pad(STATUS_LABEL[c.status] || c.status, 12), pad(oneLine(c.basis, 30), 30)].join('  '));
  }
  if (advisoryFailing.length) L.push('  （注：方舟计费那条为「潜在风险」，因当前配置未使用方舟，不计入退出码）');
  L.push('');
  L.push(`【一句话总结】${summary}`);
  L.push(`【残余风险】`);
  for (const r of risks) L.push(`  · ${r}`);
  L.push('');
  L.push(`退出码 : ${exitCode}（${exitCode === 0 ? '全部可用或未启用' : '存在不可用项'}）`);
  L.push('');
  process.stdout.write(`${L.join('\n')}\n`);
  process.exit(exitCode);
}

main().catch((e) => {
  process.stderr.write(`体检脚本异常：${scrub(e?.stack || e?.message || String(e))}\n`);
  process.exit(2);
});
