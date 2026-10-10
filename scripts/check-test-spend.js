#!/usr/bin/env node
// ============================================================================
// scripts/check-test-spend.js —— 测试「偷偷花钱」哨兵（G-101 · 测试花费审计线）
//
// 一句话：
//   把每个测试/脚本套件放进**子进程**跑一遍，在子进程里拦掉一切「非回环地址」的
//   fetch / http.request / https.request / net.connect，谁打真实外网就当场记下来
//   并拒绝，跑完输出一张表：目标 / 是否非回环 / 地址 / 调用栈首帧 / 结果 / 是否已授权。
//
// 为什么需要它（真实事故 · 本会话发现）：
//   tests/test-adapters.js 里曾有一句
//     typeof llmMod.chat({ prompt: 'x' }).then === 'function'
//   —— 只为断言 chat() 返回 thenable，每次跑套件都会真发一次 DeepSeek 付费请求
//   （打 api.deepseek.com，走宿主机真实凭据）。而 app_config['usage:monthly'] 台账
//   只统计 images / videos / ttsChars 三类，**LLM token 根本不进台账**，所以这个
//   花钱行为长期没被发现。已修（改成 llmMod.chat.constructor.name === 'AsyncFunction'）。
//   本脚本的作用：让「下一个同类问题」在跑套件的第一时间变成一条红色记录，
//   而不是等到月底看账单。
//
// 用法（日常怎么跑，见下）：
//   node scripts/check-test-spend.js                     # 全量扫描（顺序单跑；人读表格）
//   node scripts/check-test-spend.js --json              # 机器可读（stdout 只有 JSON）
//   node scripts/check-test-spend.js --only=test-guard   # 只查路径含 test-guard 的目标（可重复）
//   node scripts/check-test-spend.js --list              # 只列目标与执行策略，不跑
//   node scripts/check-test-spend.js --timeout=180       # 每目标超时秒数（默认 300）
//   node scripts/check-test-spend.js --env=SKIP_REAL_LLM=1        # 以「关掉真实 LLM」的口径重跑（验证本白名单项是否真被关掉）
//   node scripts/check-test-spend.js --run-python        # 强行真跑全部 Python 套件（默认只跑安全的那个，见下）
//   node scripts/check-test-spend.js --allow-real        # ★危险★ 白名单目标放行真实厂商请求（会真花钱；默认全拦）
//   node scripts/check-test-spend.js --quiet             # 只输出表格与结论行
// 退出码：0 = 全部干净或全部命中白名单；1 = 存在**未登记**的非回环调用；2 = 用法错误。
//
// 什么时候跑：
//   · 改完 tests/ 或 scripts/ 下任何套件之后（尤其是「顺手加一句断言」这种改动）；
//   · 收口/发版前跑一次（比 verify-all.sh 便宜得多：默认口径 ≈ 一次全量套件运行）；
//   · 怀疑某次门禁花了钱 → `node scripts/check-test-spend.js --only=test-script` 单查。
// 与 verify-all.sh 的关系（2026-10-03 更新，别再看旧说法）：
//   **已经接进门禁**：scripts/verify-all.sh 在 35 个阶段之前跑「**第 0 关 测试花费哨兵**」，命令是
//     node scripts/check-test-spend.js --only=test-script --only=test-novel --only=test-adapters --quiet
//   取「轻量口径」：只盯这 3 个已知会打真实厂商的套件（<10s，未登记的非回环调用即判本轮失败），
//   不改变 35 个阶段的编号；**全量扫描**（46 个目标 / 约 160s，覆盖 tests/ 与 scripts/）仍需手动跑：
//     node scripts/check-test-spend.js
//   之所以不全量接入：+160s（≈+15% 门禁时长）且与后续阶段重复跑同一批套件（见决策 D-024）。
//
// 零付费保证（本脚本自身）：
//   1) 本脚本自己绝不发任何真实厂商请求（只用 node: 内置模块 + 子进程）；
//   2) 默认对**所有**目标都拦截非回环请求（拦截 = 抛错，套件因此失败属预期，不是 bug）；
//   3) 只有显式 --allow-real 才放行白名单目标，并在输出里把它们标成「真实放行（已花钱）」。
//
// 已知局限（诚实声明，别把它当万能）：
//   · Python 套件：本脚本默认给 Python 注入 sitecustomize 守卫（拦 socket.connect）后才会跑；
//     默认只跑安全的 make-audit-refs.py，其余 Python 套件（需要在线实例/浏览器）默认不跑，
//     其非回环调用**未被动态覆盖**，只做了静态扫描，表格里会明确标「未拦截」。
//   · 间接花费：如果套件只是打 127.0.0.1 上的**宿主实例**（用户正在用的 8788），真实厂商
//     请求发生在**另一个进程**里，本脚本拦不到（回环调用一律放行）。这类目标在表格里标
//     「打宿主实例（本脚本看不到其内部花费）」，并默认不执行。
//   · 提前解构（如 `const f = globalThis.fetch` 后再调用）或自带 HTTP 客户端（自写 socket、
//     undici 私有实例）可能绕过；子进程若清空 NODE_OPTIONS 再 spawn，孙进程也会失去守卫。
// ============================================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// 静态扫描时视为「安全/非外网」的域名（文档出处、规范链接、示例域名等）
const KNOWN_SAFE_HOSTS = new Set(['www.w3.org', 'w3.org', 'schemas.android.com', 'example.com', 'www.example.com',
  'nodejs.org', 'github.com', 'registry.npmjs.org', 'localhost', '127.0.0.1', 'json-schema.org', 'tools.ietf.org', 'www.ietf.org']);

// ============================================================================
// 一、白名单：**故意**打真实厂商的套件（必须显式登记；登记 ≠ 静默放过）
// ----------------------------------------------------------------------------
// 语义：命中的目标默认**仍然被拦截**（保证零花费），但退出码不算失败，输出里标
//       「已授权但仍在花钱（本次已拦截，未实际花费）」。加 --allow-real 才是真放行。
// ============================================================================
const ALLOWLIST = [
  {
    target: 'tests/test-script.js',
    hosts: ['api.deepseek.com'],
    lines: '第 12 行（开关）/ 第 260~286 行（第 9 节：真实 LLM 小调用）',
    note: '模块3 自测第 9 节**故意**做真实 LLM 小调用：默认 2 次（分集规划 + 单集剧本正文），'
      + 'REAL_LLM_EXTRA=1 时再加第 3 次（LLM 分镜）。脚本自己提供 SKIP_REAL_LLM=1 关闭开关，'
      + '但 scripts/verify-all.sh 第 4/35 步（第 121 行）直接跑 node tests/test-script.js，**没有设** '
      + 'SKIP_REAL_LLM=1 —— 也就是说每次跑门禁都会真花 2 次 DeepSeek 调用的钱。',
    cost: '每次运行 ≈ 2 次 DeepSeek chat 计费调用（约数千 input token + 数百 output token）',
    verdict: '已授权但仍在花钱',
  },
  {
    target: 'tests/test-novel.js',
    hosts: ['api.deepseek.com'],
    lines: '原第 278~310 行（第 4 节：真实 LLM 小调用）；G-101 于第 278~289 行补了 SKIP_REAL_LLM 开关',
    note: '模块2 自测第 4 节**故意**做真实 LLM 调用 1 次（POST /api/novels/:id/outline → chatJSON 通路），'
      + '原守卫只有「llmStatus().ready 为真才跑」—— 宿主机有真实 Key，所以默认口径下每次跑本套件都真花 1 次调用。'
      + 'G-101 已补上与 test-script.js 同名同语义的 SKIP_REAL_LLM=1 开关（默认行为不变，去掉即恢复覆盖）。'
      + 'verify-all.sh 第 3/35 步（第 120 行）跑本套件时同样没设 SKIP_REAL_LLM。',
    cost: '每次运行 ≈ 1 次 DeepSeek chatJSON 计费调用（总纲 + 首批 3 章）',
    verdict: '已授权但仍在花钱',
  },
  {
    target: 'scripts/verify-refimg.js',
    hosts: ['*.aliyuncs.com', 'dashscope.aliyuncs.com'],
    lines: '第 1~40 行用法注释（--yes 才真出图）',
    note: '万相参考图/图生图真机验证：不带 --yes 只打印计划（零请求）；--dry 用假 fetch 跑全链路（零费用）；'
      + '只有 --yes 才真出图（当前配置 ¥0.2/张 × 2 张）。本脚本以 --dry 口径运行。',
    cost: '默认 0；--yes 时 ≈ ¥0.4/次',
    verdict: '已授权（默认零费用；仅 --yes 花钱）',
  },
  {
    target: 'scripts/simulate-all.js',
    hosts: ['api.deepseek.com'],
    lines: '第 17 行（SIM_REAL_LLM=1 开关）/ 第 309、1126 行',
    note: '全模块端到端模拟：默认 LLM=mock、出图/视频=placeholder、TTS=none（离线零成本）；'
      + '只有 SIM_REAL_LLM=1 才走真实 LLM（2 次）。本脚本因红线（会写 docs/ 报告）未执行，'
      + '静态判定其默认口径不打外网。',
    cost: '默认 0；SIM_REAL_LLM=1 时 2 次 LLM 调用',
    verdict: '已授权（默认零费用；需显式开关才花钱）',
  },
  {
    target: 'scripts/check-backends.js',
    hosts: ['*'],
    lines: '第 1~30 行用法注释（设计红线：只做真网络只读探测）',
    note: '后端体检：**故意**发真实网络只读 GET（余额 QueryBalanceAcct / 模型列表 / 实例状态），'
      + '自述「零付费、不提交任何生成类任务」。属人工工具，不在 verify-all.sh 里；'
      + '本线未执行（需真实凭据且会返回账号余额），静态登记为已授权只读。',
    cost: '0 元（只读探测），但会产生真实外网流量',
    verdict: '已授权（只读、零付费）',
  },
];

// ============================================================================
// 二、执行策略：谁能跑、谁不能跑、为什么
// ----------------------------------------------------------------------------
// 默认：tests/*.js|mjs 都跑（自带进程内服务 + 临时库）；tests/*.py 与部分 scripts 见下。
// ============================================================================
const NOEXEC = {
  'scripts/simulate-all.js': '会写 docs/全模块功能模拟测试报告.md（docs/ 是本线红线目录）；'
    + '默认口径（mock LLM / placeholder 出图 / placeholder 视频）静态可证不打外网，故不执行',
  'scripts/seed-demo.js': '默认打宿主机 http://127.0.0.1:8788（用户正在使用的实例）并向**正式库**写演示数据 —— '
    + '执行会污染用户数据，且其内部真实花费发生在宿主进程里，本脚本拦不到',
  'scripts/tour-chain.js': '默认打宿主机 http://127.0.0.1:8788 并逐环走真实接口（含闸门/执行环节），'
    + '可能触发宿主实例上的真实付费阶段 —— 不执行',
  'scripts/fix-demo-cast.js': '直接 migrate + 写仓库正式库 data/factory.db（用户生产库），不执行',
  'scripts/check-backends.js': '会发真实网络只读探测（厂商余额/模型列表），本线保持零外网流量，不执行',
};
// 「执行，但用安全参数」的套件（跑法写清楚，避免误用危险参数）
const SAFE_ARGS_NOTE = {
  'scripts/mcp.js': 'stdio 模式会阻塞等 stdin（会拖到超时），故以 --catalog 口径执行（仅打印工具目录，零副作用）',
  'scripts/verify-refimg.js': '以 --dry 口径执行（用假 fetch 跑全链路，零费用）；只有 --yes 才真出图',
};
const PY_NOEXEC = {
  'tests/canvas-audit.py': '需要在线实例（verify-all.sh 传 baseUrl，默认打用户 8788），'
    + '会点界面并可能触发宿主实例的真实出图/出视频 —— 不执行（用户此刻正在界面上出图）',
  'tests/ui-simulate.py': '同上：全模块 UI 模拟打在线实例，会真实操作界面 —— 不执行',
  'tests/ui-smoke.py': '同上：前端端到端冒烟打在线实例 —— 不执行',
  'tests/ui-scale.py': '会自造满配临时库（200 演员/100 集/单集 200 镜）并起浏览器，耗时极长 —— 不执行',
};

// ============================================================================
// 三、子进程守卫源码（Node 侧）
// ============================================================================
const GUARD_MJS = String.raw`// G-101 测试花费哨兵 · 子进程预加载守卫（由 scripts/check-test-spend.js 生成，勿手工改）
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

const LOG = process.env.G101_LOG;
const TAG = '[G-101 测试花费哨兵]';
const MARK = Symbol.for('g101.spend.guard');

function isLoopback(host) {
  const h = String(host == null ? '' : host).trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (!h) return true;                                  // 没写主机名 = 本机
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  if (h === '::' || h === '0.0.0.0') return true;       // 本机任意地址
  if (h.startsWith('127.')) return true;
  if (h.startsWith('0x7f')) return true;
  return false;
}

function hostAllowed(host) {
  const list = String(process.env.G101_ALLOW_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!list.length) return false;
  const h = String(host || '').toLowerCase();
  return list.some((p) => (p.startsWith('*.') ? (h === p.slice(2) || h.endsWith(p.slice(1))) : h === p));
}

function collectFrames() {
  let st = '';
  try { st = new Error().stack || ''; } catch { st = ''; }
  const out = [];
  const root = process.env.G101_ROOT || '';
  for (const raw of st.split('\n').slice(1)) {
    const t = raw.trim().replace(/^at\s+/, '');
    if (!t) continue;
    if (t.startsWith('node:')) continue;
    if (t.includes('node:internal')) continue;
    if (t.includes('g101-guard') || t.includes('data:text/javascript') || t.includes('check-test-spend')) continue;
    if (t.includes('G101')) continue;
    const m = /\(?((?:file:\/\/)?[^()\s]+):(\d+):(\d+)\)?$/.exec(t);
    if (m) {
      let f = m[1].replace(/^file:\/\//, '');
      if (root && f.startsWith(root + '/')) f = f.slice(root.length + 1);
      const frame = f + ':' + m[2];
      if (!out.includes(frame)) out.push(frame);
    }
  }
  return out;
}

function report(kind, url, host, blocked) {
  const frames = collectFrames();
  const rec = { kind, url, host, frame: frames[0] || '(未知调用点)', frames: frames.slice(0, 6), blocked, pid: process.pid, ts: new Date().toISOString() };
  try { if (LOG) fs.appendFileSync(LOG, JSON.stringify(rec) + '\n'); } catch { /* 记录失败不掩盖主流程 */ }
  try {
    process.stderr.write(TAG + (blocked ? ' 已拦截并拒绝 ' : ' 已放行（白名单）') + kind + ' → ' + url + '  @ ' + frames.slice(0, 3).join(' ← ') + '\n');
  } catch { /* ignore */ }
}

function guard(kind, u) {
  if (!u || !u.hostname || isLoopback(u.hostname)) return;
  if (hostAllowed(u.hostname)) { report(kind, u.href, u.hostname, false); return; }
  report(kind, u.href, u.hostname, true);
  const err = new Error(TAG + ' 拒绝非回环请求：' + u.href + '（如属故意调用，请登记到 scripts/check-test-spend.js 的 ALLOWLIST）');
  err.code = 'G101_BLOCKED';
  throw err;
}

function urlOf(scheme, args) {
  const a = args && args[0];
  try {
    if (typeof a === 'string') return new URL(a);
    if (a && typeof a === 'object' && typeof a.href === 'string') return new URL(a.href);
    if (a && typeof a === 'object') {
      const host = a.hostname || a.host || '';
      const port = a.port ? ':' + a.port : '';
      let p = a.path || a.pathname || '/';
      if (String(p).indexOf('/') !== 0) p = '/' + p;
      if (!host) return null;
      return new URL(scheme + '://' + host + port + p);
    }
  } catch { /* 解析不出来就放行，交给 Node 自己报错 */ }
  return null;
}

if (!globalThis[MARK]) {
  globalThis[MARK] = true;

  const origFetch = globalThis.fetch;
  if (typeof origFetch === 'function') {
    globalThis.fetch = function (input, init) {
      let u = urlOf('http', [input]);
      guard('fetch', u);
      return origFetch.apply(this, arguments);
    };
  }

  const wrap = (scheme, orig, label) => function (...args) {
    guard(label, urlOf(scheme, args));
    return orig.apply(this, args);
  };
  http.request = wrap('http', http.request, 'http.request');
  http.get = wrap('http', http.get, 'http.get');
  https.request = wrap('https', https.request, 'https.request');
  https.get = wrap('https', https.get, 'https.get');
  net.connect = wrap('tcp', net.connect, 'net.connect');
  net.createConnection = wrap('tcp', net.createConnection, 'net.createConnection');
}
`;

// ============================================================================
// 四、子进程守卫源码（Python 侧 · sitecustomize）
// ============================================================================
const GUARD_PY = `# G-101 测试花费哨兵 · Python 守卫（由 scripts/check-test-spend.js 生成）
import json, os, socket, traceback

_LOG = os.environ.get('G101_LOG')
_ROOT = os.environ.get('G101_ROOT') or ''
_ALLOW = [h.strip().lower() for h in os.environ.get('G101_ALLOW_HOSTS', '').split(',') if h.strip()]
_LOOP = ('127.', 'localhost', '::1', '0.0.0.0', '::', '0:0:0:0:0:0:0:1')


def _is_loopback(host):
    h = str(host or '').strip().lower().strip('[]')
    if not h:
        return True
    if h in _LOOP or h.endswith('.localhost'):
        return True
    return h.startswith('127.')


def _allowed(host):
    h = str(host or '').lower()
    for p in _ALLOW:
        if p.startswith('*.') and (h == p[2:] or h.endswith(p[1:])):
            return True
        if h == p:
            return True
    return False


def _frame():
    frames = [f for f in traceback.format_stack() if 'sitecustomize' not in f]
    if not frames:
        return '(未知调用点)'
    last = frames[-1].strip().split('\\n')[0]
    return last.replace('File "', '').replace('", line ', ':').replace('"', '')


def _report(kind, url, host, blocked):
    if not _LOG:
        return
    try:
        with open(_LOG, 'a', encoding='utf-8') as f:
            f.write(json.dumps({'kind': kind, 'url': url, 'host': host, 'frame': _frame(),
                                'blocked': blocked, 'pid': os.getpid(),
                                'note': 'Python 侧只能看到解析后的 IP（域名信息在 getaddrinfo 阶段丢失）'}, ensure_ascii=False) + '\\n')
    except Exception:
        pass


def _guard(kind, host, port):
    if _is_loopback(host):
        return
    url = '%s:%s' % (host, port)
    if _allowed(host):
        _report(kind, url, host, False)
        return
    _report(kind, url, host, True)
    raise OSError('[G-101 测试花费哨兵] 拒绝非回环连接：' + url + '（该套件存在未登记的真实外网调用）')


_orig_connect = socket.socket.connect
_orig_connect_ex = socket.socket.connect_ex


def _patched_connect(self, address, *a, **kw):
    try:
        host = address[0] if isinstance(address, (tuple, list)) and address else (address if isinstance(address, str) else '')
        port = address[1] if isinstance(address, (tuple, list)) and len(address) > 1 else 0
    except Exception:
        host, port = '', 0
    _guard('py.socket.connect', host, port)
    return _orig_connect(self, address, *a, **kw)


def _patched_connect_ex(self, address, *a, **kw):
    try:
        host = address[0] if isinstance(address, (tuple, list)) and address else (address if isinstance(address, str) else '')
        port = address[1] if isinstance(address, (tuple, list)) and len(address) > 1 else 0
    except Exception:
        host, port = '', 0
    _guard('py.socket.connect_ex', host, port)
    return _orig_connect_ex(self, address, *a, **kw)


socket.socket.connect = _patched_connect
socket.socket.connect_ex = _patched_connect_ex
`;

// ============================================================================
// 五、目标发现与命令行
// ============================================================================
function parseArgs(argv) {
  const out = { json: false, list: false, quiet: false, allowReal: false, runPython: false, timeout: 300, only: [], env: {} };
  for (const a of argv) {
    if (a === '--json') out.json = true;
    else if (a.startsWith('--json=')) out.jsonPath = a.slice(7);
    else if (a === '--list') out.list = true;
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--allow-real') out.allowReal = true;
    else if (a === '--run-python') out.runPython = true;
    else if (a.startsWith('--only=')) out.only.push(a.slice(7));
    else if (a.startsWith('--env=')) { const kv = a.slice(6); const i = kv.indexOf('='); if (i > 0) out.env[kv.slice(0, i)] = kv.slice(i + 1); }
    else if (a.startsWith('--timeout=')) out.timeout = Math.max(5, Number(a.slice(10)) || 300);
    else if (a === '--help' || a === '-h') { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 46).join('\n').replace(/^\/\/ ?/gm, '')); process.exit(0); }
    else { console.error('未知参数：' + a + '（用 --help 看用法）'); process.exit(2); }
  }
  return out;
}

function isBackup(name) { return name.includes('.bak') || name.includes('.w6.') || name.includes('.w7.') || name.includes('.w8.'); }

function discoverTargets() {
  const targets = [];
  for (const name of fs.readdirSync(path.join(ROOT, 'tests')).sort()) {
    if (isBackup(name) || name.startsWith('.')) continue;
    const rel = 'tests/' + name;
    if (/\.(js|mjs)$/.test(name)) targets.push({ rel, kind: 'node', exec: true, why: '', args: [] });
    else if (/\.py$/.test(name)) {
      const noexec = PY_NOEXEC[rel];
      targets.push({ rel, kind: 'python', exec: !noexec, why: noexec || '', args: name === 'make-audit-refs.py' ? ['__TMPREFS__', '3'] : [] });
    }
  }
  for (const name of fs.readdirSync(path.join(ROOT, 'scripts')).sort()) {
    if (isBackup(name) || !/\.js$/.test(name)) continue;
    const rel = 'scripts/' + name;
    if (rel === 'scripts/check-test-spend.js') continue;   // 不检查自己（自我递归）
    const why = NOEXEC[rel] || '';
    const args = [];
    if (rel === 'scripts/mcp.js') args.push('--catalog');
    if (rel === 'scripts/verify-refimg.js') args.push('--dry');
    if (rel === 'scripts/seed-scale.js') args.push('__SEEDDB__', '__SEEDDATA__', '--actors=20', '--episodes=3', '--shots=20', '--chapters=10', '--canvasLinks=10', '--groups=3', '--jobs=10');
    targets.push({ rel, kind: 'node', exec: !why, why, args, note: SAFE_ARGS_NOTE[rel] || '' });
  }
  return targets;
}

function allowFor(rel) { return ALLOWLIST.find((a) => a.target === rel) || null; }

// ============================================================================
// 六、主流程
// ============================================================================
const args = parseArgs(process.argv.slice(2));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'g101-spend-'));
const GUARD_MJS_FILE = path.join(TMP, 'g101-guard.mjs');
const GUARD_PY_DIR = path.join(TMP, 'pysite');
fs.writeFileSync(GUARD_MJS_FILE, GUARD_MJS, 'utf8');
fs.mkdirSync(GUARD_PY_DIR, { recursive: true });
fs.writeFileSync(path.join(GUARD_PY_DIR, 'sitecustomize.py'), GUARD_PY, 'utf8');

// 真实配置的**副本**：让套件读到的行为与线上一致（含 Key），但写不到真配置
const CFG_COPY = path.join(TMP, 'config.json');
let cfgNote = '（仓库无 config/config.json，未做配置副本）';
try {
  fs.copyFileSync(path.join(ROOT, 'config', 'config.json'), CFG_COPY);
  cfgNote = '（已复制 config/config.json → 临时副本，套件写入不会碰真实配置）';
} catch { /* 无真配置 */ }

const all = discoverTargets();
const selected = args.only.length
  ? all.filter((t) => args.only.some((o) => t.rel.toLowerCase().includes(o.toLowerCase())))
  : all;

if (args.list) {
  console.log('目标清单（' + selected.length + ' 个）' + cfgNote);
  console.log('执行  目标                                        拦截方式                   说明');
  for (const t of selected) {
    const mode = t.exec ? (t.kind === 'node' ? 'Node fetch/http/https/net' : 'Python socket') : '不执行（仅静态扫描）';
    console.log(pad(t.exec ? '跑' : '跳过', 6) + pad(t.rel, 44) + pad(mode, 26) + (t.why || t.note || '').slice(0, 70));
  }
  process.exit(0);
}

const results = [];
let unregistered = 0;
let idx = 0;
const started = performance.now();

for (const t of selected) {
  idx++;
  const slug = t.rel.replace(/[^a-zA-Z0-9._-]/g, '_');
  const logFile = path.join(TMP, slug + '.ndjson');
  fs.writeFileSync(logFile, '');
  const tmpData = path.join(TMP, slug + '.data');
  const tmpDb = path.join(TMP, slug + '.db');
  fs.mkdirSync(tmpData, { recursive: true });
  const allow = allowFor(t.rel);
  const port = 18900 + idx;

  const env = {
    ...process.env,
    G101_LOG: logFile,
    G101_ROOT: ROOT,
    FACTORY_DB: tmpDb,
    FACTORY_DATA_DIR: tmpData,
    FACTORY_CONFIG: CFG_COPY,
    PORT: String(port),
    SIM_PORT: String(port),
    NO_COLOR: '1',
    NODE_OPTIONS: ((process.env.NODE_OPTIONS || '') + ' --import ' + pathToFileURLStr(GUARD_MJS_FILE)).trim(),
    PYTHONPATH: GUARD_PY_DIR + (process.env.PYTHONPATH ? path.delimiter + process.env.PYTHONPATH : ''),
  };
  // 门禁口径：**不设** SKIP_REAL_LLM（verify-all.sh 也没设）→ 才能暴露 test-script.js 的默认真实调用。
  delete env.SKIP_REAL_LLM;
  delete env.SIM_REAL_LLM;
  delete env.REAL_LLM_EXTRA;
  for (const [k, v] of Object.entries(args.env)) env[k] = v;   // --env=K=V 显式覆盖（如 --env=SKIP_REAL_LLM=1）
  if (args.allowReal && allow) env.G101_ALLOW_HOSTS = allow.hosts.join(',');
  else if (allow) env.G101_ALLOW_HOSTS = '';   // 登记过但**仍然拦截**（保证零花费）

  const argv = t.args.map((a) => a
    .replace('__TMPREFS__', path.join(TMP, 'refs'))
    .replace('__SEEDDB__', tmpDb)
    .replace('__SEEDDATA__', tmpData));

  const rec = {
    target: t.rel, kind: t.kind, executed: Boolean(t.exec), reason: t.why || '',
    args: argv, port, calls: [], exit: null, signal: null, ms: 0, allowlisted: Boolean(allow),
    verdict: '', tail: [],
  };

  if (!t.exec) {
    rec.exit = 'skipped';
    rec.verdict = '未执行（未拦截）';
  } else {
    const t0 = performance.now();
    const cmd = t.kind === 'python' ? 'python3' : process.execPath;
    const res = spawnSync(cmd, t.kind === 'python' ? [t.rel, ...argv] : [t.rel, ...argv], {
      cwd: ROOT, env, timeout: args.timeout * 1000, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8',
    });
    rec.ms = Math.round(performance.now() - t0);   // 用单调时钟：本机墙钟会被调整（见 tests/test-clock-skew.js），Date.now() 差值可能为负
    rec.exit = res.status === null ? (res.error && res.error.code === 'ETIMEDOUT' ? 'timeout' : 'error') : res.status;
    rec.signal = res.signal || null;
    const out = ((res.stdout || '') + (res.stderr || '')).split('\n');
    rec.tail = out.slice(-14).filter((l) => l.trim());
  }

  // 读回拦截日志
  const raw = (() => { try { return fs.readFileSync(logFile, 'utf8'); } catch { return ''; } })();
  rec.calls = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

  const nonLoop = rec.calls;
  const hosts = [...new Set(nonLoop.map((c) => c.host))];
  const blockedCount = nonLoop.filter((c) => c.blocked).length;
  if (!t.exec) {
    rec.verdict = '未执行（未拦截）';
  } else if (!nonLoop.length) {
    rec.verdict = rec.exit === 0 ? '通过（无非回环调用）' : (rec.exit === 'timeout' ? '超时（无非回环调用）' : '失败（无非回环调用）');
  } else if (allow) {
    rec.verdict = blockedCount ? '已授权但仍在花钱（本次已拦截，未实际花费）' : '已授权且已真实放行（**已花钱**）';
  } else {
    unregistered += hosts.length ? 1 : 0;
    rec.verdict = '★未登记的非回环调用（' + blockedCount + ' 次已拦截）';
  }
  rec.hosts = hosts;
  // 静态扫描（所有目标都做，作为未执行目标的补充证据）
  rec.static = staticScan(t.rel);
  results.push(rec);
  try { fs.rmSync(tmpData, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(tmpDb, { force: true }); } catch { /* ignore */ }
}

// ---------------- 输出 ----------------
const summary = {
  scannedAt: new Date().toISOString(),
  node: process.version,
  seconds: Math.round((performance.now() - started) / 1000),
  root: ROOT,
  tmp: TMP,
  configNote: cfgNote,
  allowReal: args.allowReal,
  totals: {
    targets: results.length,
    executed: results.filter((r) => r.executed).length,
    skipped: results.filter((r) => !r.executed).length,
    withNonLoop: results.filter((r) => r.calls.length).length,
    unregistered: unregistered,
    allowlistedHit: results.filter((r) => r.allowlisted && r.calls.length).length,
  },
  allowlist: ALLOWLIST.map((a) => ({ target: a.target, hosts: a.hosts, lines: a.lines, cost: a.cost, verdict: a.verdict })),
  results,
};

if (args.jsonPath) {
  fs.writeFileSync(args.jsonPath, JSON.stringify(summary, null, 2), 'utf8');
}
if (args.json) {
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  process.exit(unregistered ? 1 : 0);
}

const W = { t: 42, n: 7, h: 30, f: 34, r: 30 };
console.log('');
console.log('================ 测试花费审计哨兵 G-101 ================');
console.log('仓库：' + ROOT);
console.log('Node：' + process.version + ' ｜ 临时目录：' + TMP + cfgNote);
console.log('口径：非回环调用 = 不是 127.0.0.1 / localhost / ::1 的 fetch / http(s).request / net.connect');
console.log('说明：默认**拦截并拒绝**非回环调用；命中白名单也只标「已授权」，不静默放过。');
console.log('');
console.log(pad('目标', W.t) + pad('非回环', W.n) + pad('目标地址', W.h) + pad('调用栈首帧', W.f) + pad('结果', W.r) + '备注');
console.log('-'.repeat(W.t + W.n + W.h + W.f + W.r + 10));
for (const r of results) {
  if (!r.calls.length) {
    console.log(pad(r.target, W.t) + pad('0', W.n) + pad('-', W.h) + pad('-', W.f) + pad(r.verdict, W.r)
      + (r.executed ? '' : '不执行：' + (r.reason || '').slice(0, 40)));
    continue;
  }
  r.calls.forEach((c, i) => {
    console.log(pad(i === 0 ? r.target : '', W.t)
      + pad(i === 0 ? String(r.calls.length) : '', W.n)
      + pad(c.host, W.h) + pad(c.frame, W.f)
      + pad(i === 0 ? r.verdict : '', W.r)
      + (i === 0 ? (c.blocked ? '已拦截（未花钱）' : '真实放行（已花钱）') : ''));
  });
}
console.log('-'.repeat(W.t + W.n + W.h + W.f + W.r + 10));
console.log('汇总：目标 ' + summary.totals.targets + ' 个（执行 ' + summary.totals.executed + ' / 跳过 ' + summary.totals.skipped + '）'
  + '｜有非回环调用的 ' + summary.totals.withNonLoop + ' 个｜其中已授权 ' + summary.totals.allowlistedHit
  + ' 个｜**未登记 ' + summary.totals.unregistered + ' 个**｜耗时 ' + summary.seconds + 's');
console.log('');

// 有非回环调用的目标：打印完整调用链路，便于直接定位到「哪一行触发」
const withCalls = results.filter((r) => r.calls.length);
if (withCalls.length) {
  console.log('---- 非回环调用明细（链路 = 直接发起者 ← … 最外层可回溯调用者）----');
  for (const r of withCalls) {
    for (const c of r.calls) {
      console.log('  ' + r.target + '  →  ' + c.url);
      console.log('      拦截=' + (c.blocked ? '是（未花钱）' : '否（白名单放行，已花钱）') + '  链路：' + (c.frames || [c.frame]).join(' ← '));
    }
  }
  console.log('');
}

if (!args.quiet) {
  for (const r of results) {
    if (!r.executed) continue;
    if (r.exit === 0 && !r.calls.length) continue;
    console.log('---- ' + r.target + '（exit=' + r.exit + (r.signal ? '/' + r.signal : '') + '，' + r.ms + 'ms）----');
    for (const l of r.tail) console.log('   ' + l);
    console.log('');
  }
}

if (unregistered) {
  console.log('❌ 发现 ' + unregistered + ' 个套件存在**未登记**的非回环调用（已全部拦截，本次零付费）。');
  console.log('   请二选一：① 修掉它（改类型断言 / 指向本地假服务端 / 配置指 127.0.0.1）；② 若确属故意，登记进本脚本 ALLOWLIST 并写清为什么。');
} else {
  console.log('✅ 全部干净或已登记：没有「未登记的真实外网调用」。');
  const hits = results.filter((r) => r.allowlisted && r.calls.length);
  if (hits.length) {
    console.log('⚠️  注意：以下套件**故意**打真实厂商（本次已拦截，未花钱；去掉拦截或加 --allow-real 就会真花钱）：');
    for (const h of hits) console.log('   · ' + h.target + ' → ' + h.hosts.join(',') + '（' + h.calls.length + ' 次）｜' + allowFor(h.target).verdict);
  }
  const skipped = results.filter((r) => !r.executed);
  if (skipped.length) {
    console.log('ℹ️  未执行（故其真实外网行为未被动态验证，只有静态扫描）：');
    for (const s of skipped) console.log('   · ' + s.target + ' —— ' + s.reason);
  }
}
process.exit(unregistered ? 1 : 0);

// ============================================================================
// 工具函数
// ============================================================================
function pathToFileURLStr(p) { return 'file://' + p.split(path.sep).map(encodeURIComponent).join('/'); }
function displayWidth(s) { return [...String(s)].reduce((n, c) => n + (/[\u1100-\u115f\u2e80-\ua4cf\ua960-\ua97f\uac00-\ud7ff\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(c) ? 2 : 1), 0); }
function pad(s, n) { s = String(s); return s + ' '.repeat(Math.max(0, n - displayWidth(s))); }

// 静态扫描：找非回环 URL 字面量与网络调用点（对未执行目标尤其重要）
function staticScan(rel) {
  const abs = path.join(ROOT, rel);
  let src = '';
  try { src = fs.readFileSync(abs, 'utf8'); } catch { return { hosts: [], networkCalls: 0, note: '读取失败' }; }
  const lines = src.split('\n');
  const found = new Map();
  lines.forEach((ln, i) => {
    const re = /https?:\/\/([a-zA-Z0-9._-]+)/g;
    let m;
    while ((m = re.exec(ln))) {
      const host = m[1].toLowerCase();
      if (KNOWN_SAFE_HOSTS.has(host) || host.startsWith('127.') || host === 'localhost') continue;
      const prev = found.get(host) || { host, lines: [] };
      if (prev.lines.length < 5) prev.lines.push(i + 1);
      found.set(host, prev);
    }
  });
  const netCalls = (src.match(/\bfetch\s*\(|https?\.request\s*\(|https?\.get\s*\(|urlopen\s*\(|requests\.(get|post)\s*\(|net\.connect\s*\(/g) || []).length;
  return { hosts: [...found.values()], networkCalls: netCalls };
}
