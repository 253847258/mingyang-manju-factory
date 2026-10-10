#!/usr/bin/env node
// 付费闸门残留恢复：把 config/config.json 还原成「自检/审计跑之前」的那一份，并把出图/视频/配音后端切回去。
//
// 什么时候需要它（2026-10-03 事故）：
//   `tests/canvas-audit.py` 有「付费后端闸门」——跑之前把出图后端临时切成 placeholder（零花钱）、
//   跑完切回真实后端，并把跑之前的配置另存为 `config/config.json.before-paid-gate`。
//   如果那次运行被 **SIGKILL / 整机异常 / /tmp 被清空** 之类硬中断打断，闸门就没机会收尾：
//   服务端会永久停在 placeholder —— 用户下一次出图拿到的是占位 SVG，却完全不知情。
//   （本会话真实发生过：8788 实例消失、/tmp 被系统清空，出图后端卡在 placeholder。）
//
// 用法（零依赖、只发本地 HTTP 请求，不碰任何付费接口）：
//   node scripts/restore-backends.js            # 看快照里存的是什么，并还原
//   node scripts/restore-backends.js --dry-run  # 只看，不改
//   BASE=http://127.0.0.1:8788 node scripts/restore-backends.js
//
// 退出码：0 = 已还原或无需还原；1 = 有快照但还原失败；2 = 用法/环境错误（例如服务没起）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE || 'http://127.0.0.1:8788';
const dryRun = process.argv.includes('--dry-run');
const CONFIG = process.env.FACTORY_CONFIG || path.join(ROOT, 'config', 'config.json');
const SNAP = `${CONFIG}.before-paid-gate`;

const log = (...a) => console.log(...a);
const fail = (msg, code = 1) => { console.error(`✗ ${msg}`); process.exit(code); };

async function settings() {
  try {
    const r = await fetch(`${BASE}/api/settings`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const d = await r.json();
    return d.settings || null;
  } catch { return null; }
}

const cur = await settings();
if (!cur) fail(`读不到 ${BASE}/api/settings —— 服务没起？先 ./start.sh 再跑本脚本`, 2);

const backends = {
  image: (cur.image || {}).backend,
  video: (cur.video || {}).backend,
  tts: (cur.tts || {}).backend,
};
log(`现状：出图=${backends.image} 视频=${backends.video} 配音=${backends.tts}`);

if (!fs.existsSync(SNAP)) {
  log(`没有残留快照（${path.relative(ROOT, SNAP)} 不存在）→ 无需还原。`);
  process.exit(0);
}
const st = fs.statSync(SNAP);
log(`发现残留快照：${path.relative(ROOT, SNAP)}（保存于 ${st.mtime.toISOString()}，${st.size} 字节）`);

let snap;
try {
  snap = JSON.parse(fs.readFileSync(SNAP, 'utf8'));
} catch (e) {
  fail(`快照不是合法 JSON（${e.message}）—— 请人工核对 ${path.relative(ROOT, SNAP)} 与 ${path.relative(ROOT, CONFIG)}`);
}
const orig = snap?.orig || {};
log(`快照记录的真实后端：出图=${orig.image} 视频=${orig.video} 配音=${orig.tts}（快照时间 ${snap?.at || '未知'}）`);
if (!orig.image) fail('快照里没有 orig.image —— 无法判断该还原成什么，请人工核对配置');

// 先比对配置字节：若当前 config.json 与快照记录的字节一致，说明配置本来就是「闸门之前」的样子（只是后端被 PUT 改了）
let bytesNote = '';
try {
  const curBytes = fs.readFileSync(CONFIG);
  const snapBytes = Buffer.from(snap.config_hex || '', 'hex');
  bytesNote = (snapBytes.length && curBytes.equals(snapBytes)) ? '（config.json 字节与快照一致）' : '（config.json 字节与快照不同，将按快照覆盖）';
} catch { bytesNote = '（读不到 config.json，跳过字节比对）'; }
log(`配置比对${bytesNote}`);

if (dryRun) {
  log('--dry-run：到此为止，未做任何修改。去掉 --dry-run 即执行还原。');
  process.exit(0);
}

// ① 还原后端（走接口，服务端会同步内存里的配置）
try {
  const r = await fetch(`${BASE}/api/settings`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ image: { backend: orig.image }, video: { backend: orig.video || 'placeholder' }, tts: { backend: orig.tts || 'none' } }),
    signal: AbortSignal.timeout(15000),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.ok === false) fail(`PUT /api/settings 失败：HTTP ${r.status} ${JSON.stringify(d).slice(0, 200)}`);
} catch (e) {
  fail(`PUT /api/settings 抛出异常：${e.message}`);
}

// ② 按快照整份覆盖 config.json（保住当时的模型/单价/密钥等所有细节）
if (snap.config_hex) {
  try {
    fs.writeFileSync(CONFIG, Buffer.from(snap.config_hex, 'hex'));
  } catch (e) {
    fail(`config.json 覆盖失败：${e.message}（后端已切回，但配置文件可能不完整）`);
  }
}

const after = await settings();
log(`✅ 已还原：出图=${(after?.image || {}).backend} 视频=${(after?.video || {}).backend} 配音=${(after?.tts || {}).backend}`);
try { fs.unlinkSync(SNAP); log(`已删除残留快照 ${path.relative(ROOT, SNAP)}`); } catch { /* 删不掉也无害，下轮闸门会再自愈一次 */ }
log('提示：出图后端已恢复为真实厂商 → 之后每次出图都会真花钱，请确认这就是你要的状态。');
