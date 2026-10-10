#!/usr/bin/env node
// 配置备份体检（零依赖 Node ESM）：把 config/ 下所有 config.json* 备份与**线上 config.json 按内容比对**，
// 逐条判定它到底能不能当回滚点用。
//
// 为什么需要这个脚本（背景）：config/config.json.bak.ark 这个名字听起来像「Ark 版备份」，
// 但它与线上 config.json **逐字节相同**（md5 一致）—— 拿它「回滚」是彻头彻尾的空操作：
// 出事了执行 cp config.json.bak.ark config.json，配置一个字都不会变，白耽误排障时间。
// 同理，文件名里带 ark 不等于内容里是 ark、名字里带 bailian 也不等于内容可用；所以判定必须**只看内容**。
//
// 判定口径（按顺序命中即停，全部只看内容，不看文件名）：
//   1) 损坏了（读不出 / 不是合法 JSON）      → 损坏（不是合法 JSON，勿用）
//   2) 与线上 config.json 逐字节相同        → 与线上相同（空操作，勿用）
//   3) 内容里出现 ark 域名 / 豆包模型名     → 含 ark 配置（当前欠费，勿用）
//   4) 缺关键键（没有可用的出图后端/Key）   → 缺关键键
//   5) 其余                                → 有效回滚点
//
// 「关键键」具体指：顶层要有 llm 段与 image 段；且至少有一个能真跑通的出图后端，即
//   image.generic.url 非空（且配了 image.generic.apiKey 或 image.openai.apiKey）
//   或 image.openai.apiKey 非空
//   或 image.comfy.url 非空
// （LLM 的 Key 允许为空：运行时还会回落到 DEEPSEEK_API_KEY 环境变量 / ~/.dsh 凭据，不算致命。）
//
// 用法：
//   node scripts/check-config-backups.js                 # 看当前仓库 config/
//   node scripts/check-config-backups.js --json          # 机器可读（供编排方 / 留痕消费）
//   node scripts/check-config-backups.js --dir <目录> --live <文件>   # 指定位置（便于自测）
//   node scripts/check-config-backups.js --quiet         # 只输出汇总那一行
// 退出码：0 = 至少有一个「有效回滚点」；1 = 没有任何有效回滚点（那时线上配置一旦被改坏就回不去了）；
//         2 = 用法错误 / 目录或线上配置读不到。
//
// 安全：本脚本**只输出文件名、大小、md5 与判定结论，绝不打印任何密钥**。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');

function parseArgs(argv) {
  const out = { dir: path.join(ROOT, 'config'), live: null, json: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--dir') out.dir = path.resolve(argv[++i] || '');
    else if (a === '--live') out.live = path.resolve(argv[++i] || '');
    else if (a === '--help' || a === '-h') {
      console.log('用法：node scripts/check-config-backups.js [--json] [--quiet] [--dir <配置目录>] [--live <线上配置文件>]');
      process.exit(0);
    } else { console.error(`未知参数：${a}（用 --help 看用法）`); process.exit(2); }
  }
  if (!out.live) out.live = path.join(out.dir, 'config.json');
  return out;
}

const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');

/** ark（火山方舟）相关的域名与模型名 —— 当前欠费，凡命中即不可作为回滚点 */
const ARK_PATTERNS = [
  'ark.cn-beijing.volces.com',
  'volces.com',
  'bytepluses.com',
  'doubao-seedream',
];

const JUDGE = {
  BROKEN: '损坏（不是合法 JSON，勿用）',
  SAME: '与线上相同（空操作，勿用）',
  ARK: '含 ark 配置（当前欠费，勿用）',
  MISSING: '缺关键键',
  GOOD: '有效回滚点',
};

const get = (obj, dotted) => dotted.split('.').reduce((o, k) => (o === null || o === undefined ? o : o[k]), obj);
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';

/** 关键键体检：返回缺失项的中文说明数组（空数组 = 关键键齐全） */
function missingKeys(cfg) {
  const missing = [];
  if (!cfg.llm || typeof cfg.llm !== 'object') missing.push('缺 llm 段');
  if (!cfg.image || typeof cfg.image !== 'object') { missing.push('缺 image 段'); return missing; }
  const genericUrl = get(cfg, 'image.generic.url');
  const genericKey = get(cfg, 'image.generic.apiKey');
  const openaiKey = get(cfg, 'image.openai.apiKey');
  const comfyUrl = get(cfg, 'image.comfy.url');
  if (!nonEmpty(genericUrl) && !nonEmpty(openaiKey) && !nonEmpty(comfyUrl)) {
    missing.push('没有任何可用出图后端（image.generic.url / image.openai.apiKey / image.comfy.url 全为空）');
  } else if (nonEmpty(genericUrl) && !nonEmpty(genericKey) && !nonEmpty(openaiKey)) {
    missing.push('image.generic.url 填了但没配任何出图 Key（image.generic.apiKey / image.openai.apiKey 都为空）');
  }
  return missing;
}

/** 摘要：只给出「能判断安全问题」的信息，不含任何密钥 */
function summarize(cfg) {
  const url = String(get(cfg, 'image.generic.url') || '');
  let host = '';
  try { host = new URL(url).host; } catch { host = ''; }
  const hasKey = (v) => (nonEmpty(v) ? '已配' : '未配');
  return {
    imageBackend: String(get(cfg, 'image.backend') || '(未写)'),
    imageHost: host || '(未填 url 或不是合法 URL)',
    imageModel: String(get(cfg, 'image.generic.model') || '(未填)'),
    imageKey: `generic=${hasKey(get(cfg, 'image.generic.apiKey'))} openai=${hasKey(get(cfg, 'image.openai.apiKey'))}`,
    llmModel: String(get(cfg, 'llm.model') || '(未填)'),
    llmKey: hasKey(get(cfg, 'llm.apiKey')),
  };
}

const args = parseArgs(process.argv.slice(2));

if (!fs.existsSync(args.dir) || !fs.statSync(args.dir).isDirectory()) {
  console.error(`✗ 配置目录不存在：${args.dir}`);
  process.exit(2);
}
if (!fs.existsSync(args.live)) {
  console.error(`✗ 线上配置不存在：${args.live}（没有基准就无从比对）`);
  process.exit(2);
}

const liveBuf = fs.readFileSync(args.live);
const liveMd5 = md5(liveBuf);
let liveCfg = null;
try { liveCfg = JSON.parse(liveBuf.toString('utf8')); }
catch (e) { console.error(`✗ 线上配置不是合法 JSON：${args.live}（${e.message}）`); process.exit(2); }

// 备份 = config/ 下所有 config.json* 且不是线上文件本身；排序稳定，输出可复现
const entries = fs.readdirSync(args.dir)
  .filter((n) => n === 'config.json' || n.startsWith('config.json.'))
  .filter((n) => path.join(args.dir, n) !== args.live)
  .sort();

const rows = [];
for (const name of entries) {
  const full = path.join(args.dir, name);
  const buf = fs.readFileSync(full);
  const digest = md5(buf);
  const row = {
    file: name,
    path: path.relative(ROOT, full).split(path.sep).join('/'),
    sizeBytes: buf.length,
    md5: digest,
    mtime: fs.statSync(full).mtime.toISOString(),
    sameAsLive: digest === liveMd5,
    judge: '',
    reasons: [],
    summary: null,
  };

  let cfg = null;
  try { cfg = JSON.parse(buf.toString('utf8')); }
  catch (e) { row.reasons.push(`读不出合法 JSON：${e.message}`); }

  if (!cfg || typeof cfg !== 'object') {
    row.judge = JUDGE.BROKEN;
  } else {
    const text = buf.toString('utf8');
    const arkHits = ARK_PATTERNS.filter((p) => text.includes(p));
    row.summary = summarize(cfg);
    row.arkHits = arkHits;

    if (row.sameAsLive) {
      row.judge = JUDGE.SAME;
      row.reasons.push(`md5 ${digest.slice(0, 8)} 与线上 config.json 完全一致 → 拷回去配置一个字都不会变，属于空操作`);
      if (arkHits.length) row.reasons.push(`注意：内容里也含 ark 关键词 ${arkHits.join('、')}（因为线上当前就是它）`);
      if (/backup-bailian-verified/.test(name)) {
        row.reasons.push('这份是「百炼实跑核验之后」由线上配置生成的快照：现在用它是空操作，但线上配置一旦被改坏，它就是最贴近现状的回滚点（比下面那些更早的备份更新）');
        row.freshSnapshot = true;
      }
    } else if (arkHits.length) {
      row.judge = JUDGE.ARK;
      row.reasons.push(`内容里出现 ark（火山方舟）关键词：${arkHits.join('、')}；方舟当前欠费，回滚到它 = 出图直接 403`);
    } else {
      const missing = missingKeys(cfg);
      if (missing.length) {
        row.judge = JUDGE.MISSING;
        row.reasons.push(...missing);
      } else {
        row.judge = JUDGE.GOOD;
        row.reasons.push(`纯百炼（image.generic.url 主机 ${row.summary.imageHost}，不含 ark 域名），关键键齐全，且与线上内容不同 → 可以真的回滚`);
        // 内容越全（越接近线上那份 12.5KB 的完整配置）越适合当回滚点，把体量差异明确提示出来
        if (row.sizeBytes < liveBuf.length * 0.6) {
          row.reasons.push(`注意：只有 ${row.sizeBytes} B，明显比线上配置（${liveBuf.length} B）简，缺的段会在加载时用内置默认值补齐（预算/计费/成片包装等自定义设置会丢）`);
        }
      }
    }
  }
  rows.push(row);
}

const good = rows.filter((r) => r.judge === JUDGE.GOOD);
const same = rows.filter((r) => r.judge === JUDGE.SAME);
const ark = rows.filter((r) => r.judge === JUDGE.ARK);
const missing = rows.filter((r) => r.judge === JUDGE.MISSING);
const broken = rows.filter((r) => r.judge === JUDGE.BROKEN);
const ok = good.length > 0;

const conclusion = ok
  ? `共 ${rows.length} 份备份：${good.length} 份有效回滚点（${good.map((r) => r.file).join('、')}）；另有 ${same.length} 份与线上逐字节相同（空操作）、${ark.length} 份含 ark 配置（欠费勿用）、${missing.length} 份缺关键键${broken.length ? `、${broken.length} 份损坏` : ''}。`
  : `共 ${rows.length} 份备份：**没有任何有效回滚点** —— 线上配置一旦被改坏就无法回滚（${same.length} 份与线上逐字节相同=空操作、${ark.length} 份含 ark 配置=欠费勿用、${missing.length} 份缺关键键${broken.length ? `、${broken.length} 份损坏` : ''}）。`;

if (args.json) {
  console.log(JSON.stringify({
    ok,
    live: { path: path.relative(ROOT, args.live).split(path.sep).join('/'), md5: liveMd5, sizeBytes: liveBuf.length, summary: summarize(liveCfg) },
    totals: { backups: rows.length, good: good.length, same: same.length, ark: ark.length, missing: missing.length, broken: broken.length },
    conclusion,
    judgments: {
      有效回滚点: good.map((r) => r.file),
      与线上相同: same.map((r) => r.file),
      含ark配置: ark.map((r) => r.file),
      缺关键键: missing.map((r) => r.file),
      损坏: broken.map((r) => r.file),
    },
    backups: rows.map((r) => ({
      file: r.file, sizeBytes: r.sizeBytes, md5: r.md5, mtime: r.mtime, sameAsLive: r.sameAsLive,
      judge: r.judge, arkHits: r.arkHits || [], freshSnapshot: Boolean(r.freshSnapshot),
      reasons: r.reasons, summary: r.summary,
    })),
  }, null, 2));
} else {
  const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
  if (args.quiet) {   // 编排方 / 脚本调用只关心结论那一行与退出码
    console.log(ok ? `✅ ${conclusion}` : `❌ ${conclusion}`);
    process.exit(ok ? 0 : 1);
  }
  console.log('=== 配置备份体检（config/ 下所有 config.json* ↔ 线上 config.json 按内容比对）===');
  console.log(`线上基准：${rel(args.live)}（${liveBuf.length} B，md5 ${liveMd5.slice(0, 8)}…）`);
  console.log(`出图后端：${summarize(liveCfg).imageBackend} · 主机 ${summarize(liveCfg).imageHost} · 模型 ${summarize(liveCfg).imageModel}`);
  console.log('');

  const W = 46;
  const pad = (s, n) => {
    // 中文按 2 个字符宽估算，保证表格对齐
    const width = [...String(s)].reduce((acc, ch) => acc + (/[\u4e00-\u9fa5\u3001\u2014\uff08\uff09\uff1a\uff0c\/]/.test(ch) ? 2 : 1), 0);
    return String(s) + ' '.repeat(Math.max(0, n - width));
  };
  console.log(`  ${pad('备份文件', W)}${pad('大小', 10)}${pad('md5(前8)', 11)}判定`);
  console.log(`  ${'-'.repeat(W + 10 + 11 + 24)}`);
  for (const r of rows) {
    console.log(`  ${pad(r.file, W)}${pad(`${r.sizeBytes} B`, 10)}${pad(r.md5.slice(0, 8), 11)}${r.judge}`);
  }
  console.log('');

  console.log('【逐条判据】');
  for (const r of rows) {
    console.log(`  · ${r.file} → ${r.judge}`);
    for (const reason of r.reasons) console.log(`      - ${reason}`);
    if (r.summary) {
      console.log(`      - 内容摘要：出图 ${r.summary.imageBackend} · 主机 ${r.summary.imageHost} · 模型 ${r.summary.imageModel} · 出图 Key ${r.summary.imageKey} · LLM ${r.summary.llmModel}（Key ${r.summary.llmKey}）`);
    }
  }
  console.log('');

  if (same.length) {
    console.log(`【空操作备份】${same.length} 份 —— 与线上逐字节相同，拿来「回滚」等于什么都没做：`);
    for (const r of same) console.log(`  ! ${r.file}（md5 ${r.md5.slice(0, 8)}…）`);
    console.log('');
  }
  if (ark.length) {
    console.log(`【含 ark 配置】${ark.length} 份 —— 方舟当前欠费，回滚过去出图直接 403：`);
    for (const r of ark) console.log(`  ✗ ${r.file}（命中 ${(r.arkHits || []).join('、')}）`);
    console.log('');
  }
  if (missing.length) {
    console.log(`【缺关键键】${missing.length} 份 —— 配置不完整，拷回去会缺出图后端或 Key：`);
    for (const r of missing) console.log(`  ✗ ${r.file}：${r.reasons[0] || ''}`);
    console.log('');
  }
  if (broken.length) {
    console.log(`【损坏】${broken.length} 份 —— 不是合法 JSON，无法作为配置使用：`);
    for (const r of broken) console.log(`  ✗ ${r.file}：${r.reasons.join('；')}`);
    console.log('');
  }
  console.log('【可用回滚点】');
  if (good.length) {
    // 按修改时间从新到旧列：越新越接近「出事前那一刻」，推荐用的就是最新那份
    const byNewest = [...good].sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)));
    for (const r of byNewest) console.log(`  ✓ ${r.file}（md5 ${r.md5.slice(0, 8)}…，${r.summary.imageHost}，${r.sizeBytes} B，改于 ${r.mtime.slice(0, 19).replace('T', ' ')}）`);
    const pick = byNewest[0];
    console.log(`     推荐回滚点（最新的一份）：${pick.file}`);
    console.log(`     用法示例：cp config/${pick.file} config/config.json`);
    console.log('     提示：回滚完建议再跑一次 node scripts/check-config-backups.js 与 node scripts/check-backends.js 确认。');
  } else {
    console.log('  （无）');
  }
  console.log('');
  console.log(ok ? `✅ ${conclusion}` : `❌ ${conclusion}`);
}

process.exit(ok ? 0 : 1);
