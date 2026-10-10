#!/usr/bin/env node
// 矩阵留痕自检（零依赖）：对比 strategist/tasks/*.yaml 声明的任务卡 id 与 strategist/runs/*.json 的落盘留痕。
//
// 硬约定（见 strategist/README.md）：每一波智能体必须把结论落盘 strategist/runs/<task_id>.json，
// 否则视为「未交付」。本脚本就是这条约定在下一轮矩阵开跑前/收口时自检。
//
// 用法：
//   node scripts/check-runs.js                # 检查仓库默认的 strategist/{tasks,runs}
//   node scripts/check-runs.js --json         # 机器可读输出（供编排方消费）
//   node scripts/check-runs.js --tasks <dir> --runs <dir>   # 指定目录（便于自测）
//   node scripts/check-runs.js --quiet        # 只输出结论行
// 退出码：0 = 每张任务卡都有留痕；1 = 存在缺留痕 / 留痕文件损坏 / 无法解析任务卡
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

function parseArgs(argv) {
  const out = { tasks: path.join(ROOT, 'strategist', 'tasks'), runs: path.join(ROOT, 'strategist', 'runs'), json: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--tasks') out.tasks = path.resolve(argv[++i] || '');
    else if (a === '--runs') out.runs = path.resolve(argv[++i] || '');
    else if (a === '--help' || a === '-h') { console.log('用法：node scripts/check-runs.js [--json] [--quiet] [--tasks <dir>] [--runs <dir>]'); process.exit(0); }
    else { console.error(`未知参数：${a}（用 --help 看用法）`); process.exit(2); }
  }
  return out;
}

/** 从任务卡文本里取 task_id：任务卡是 JSON 语法（.yaml 后缀），但保留正则兜底以防将来改成真 YAML */
function extractTaskId(text) {
  try {
    const o = JSON.parse(text);
    if (o && typeof o.task_id === 'string' && o.task_id.trim()) return { id: o.task_id.trim(), how: 'json' };
    if (o && typeof o.id === 'string' && o.id.trim()) return { id: o.id.trim(), how: 'json:id' };
  } catch { /* 不是 JSON → 走正则兜底 */ }
  const m = /^\s*(?:task_id|id)\s*:\s*["']?([A-Za-z0-9._/-]+)["']?\s*$/m.exec(text);
  return m ? { id: m[1], how: 'yaml' } : null;
}

const args = parseArgs(process.argv.slice(2));
const problems = [];
const tasks = [];
const runs = [];

if (!fs.existsSync(args.tasks)) problems.push(`任务卡目录不存在：${args.tasks}`);
else {
  for (const f of fs.readdirSync(args.tasks).filter((n) => n.endsWith('.yaml') || n.endsWith('.yml')).sort()) {
    const text = fs.readFileSync(path.join(args.tasks, f), 'utf8');
    const got = extractTaskId(text);
    if (!got) problems.push(`任务卡无法解析 task_id：${f}`);
    else tasks.push({ file: f, id: got.id, how: got.how });
  }
  if (!tasks.length) problems.push(`任务卡目录里没有任何 .yaml 任务卡：${args.tasks}`);
}

if (!fs.existsSync(args.runs)) problems.push(`留痕目录不存在：${args.runs}`);
else {
  for (const f of fs.readdirSync(args.runs).filter((n) => n.endsWith('.json')).sort()) {
    const full = path.join(args.runs, f);
    let rec = null;
    try { rec = JSON.parse(fs.readFileSync(full, 'utf8')); }
    catch (e) { problems.push(`留痕文件不是合法 JSON：${f}（${e.message}）`); continue; }
    // task_id 优先；缺失时用文件名干（去扩展名）兜底，避免「文件在但 id 字段写法不一」被误判为缺失
    const id = (typeof rec?.task_id === 'string' && rec.task_id.trim()) || path.basename(f, '.json');
    runs.push({ file: f, id: id.trim(), ok: rec?.ok, has_task_id: Boolean(rec?.task_id) });
  }
  if (!runs.length) problems.push(`留痕目录里没有任何 .json 留痕：${args.runs}`);
}

const taskIds = new Set(tasks.map((t) => t.id));
const runIds = new Set(runs.map((r) => r.id));
const missing = tasks.filter((t) => !runIds.has(t.id));                       // 有卡无留痕 → 未交付
const orphan = runs.filter((r) => !taskIds.has(r.id));                        // 有留痕无卡 → 提示（返工卡/验收卡常无独立卡）
const failed = runs.filter((r) => r.ok === false);                            // 留痕在但结论失败 → 提示
const dupRuns = Object.entries(runs.reduce((m, r) => ((m[r.id] = (m[r.id] || 0) + 1), m), {})).filter(([, n]) => n > 1);

const missingIds = missing.map((t) => t.id);
const ok = problems.length === 0 && missingIds.length === 0;

if (args.json) {
  console.log(JSON.stringify({
    ok,
    tasks: tasks.length, runs: runs.length,
    missing: missing.map((t) => ({ task_id: t.id, card: t.file })),
    orphan: orphan.map((r) => ({ task_id: r.id, run: r.file })),
    failed: failed.map((r) => ({ task_id: r.id, run: r.file })),
    duplicate_runs: dupRuns.map(([id, n]) => ({ task_id: id, count: n })),
    problems,
  }, null, 2));
} else {
  if (!args.quiet) {
    console.log('=== 矩阵留痕自检（strategist/tasks ↔ strategist/runs）===');
    console.log(`任务卡：${tasks.length} 张（${args.tasks}）｜留痕：${runs.length} 份（${args.runs}）`);
  }
  if (problems.length) {
    console.log('\n【解析问题】');
    for (const p of problems) console.log(`  ✗ ${p}`);
  }
  if (missing.length) {
    console.log(`\n【缺留痕任务卡】${missing.length} 张 —— 按 strategist/README.md 的硬约定，这些卡视为「未交付」：`);
    for (const t of missing) console.log(`  ✗ ${t.id}（卡：strategist/tasks/${t.file}，缺 strategist/runs/${t.id}.json）`);
  }
  if (!args.quiet) {
    if (orphan.length) {
      console.log(`\n【有留痕但无对应任务卡】${orphan.length} 份（提示，不计入失败；返工/验收类留痕常属此类）：`);
      for (const r of orphan) console.log(`  ! ${r.id}（${r.file}）`);
    }
    if (failed.length) {
      console.log(`\n【留痕存在但结论为 ok=false】${failed.length} 份（提示，不计入失败；请人工确认是否已返工闭环）：`);
      for (const r of failed) console.log(`  ! ${r.id}（${r.file}）`);
    }
    if (dupRuns.length) {
      console.log(`\n【同一 task_id 有多份留痕】${dupRuns.length} 组（提示）：${dupRuns.map(([id, n]) => `${id}×${n}`).join('、')}`);
    }
  }
  console.log('');
  console.log(ok
    ? `✅ 留痕齐全：${tasks.length} 张任务卡全部有 strategist/runs/<task_id>.json`
    : `❌ 留痕不齐：${missingIds.length} 张卡缺留痕（${missingIds.slice(0, 12).join('、')}${missingIds.length > 12 ? ' …' : ''}）${problems.length ? `，另有 ${problems.length} 条解析问题` : ''}`);
}
process.exit(ok ? 0 : 1);
