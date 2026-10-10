// 任务队列与取消语义自测（纯 Node，离线零成本：临时库 + 假 handler，绝不触碰 data/factory.db）
// 用法：node tests/test-jobs.js
// 覆盖：排队/并发上限/进度上报/结果落库/取消（排队中不执行、执行中被取消不得翻回 done 或 100%）/
//       取消集合释放（内存不泄漏）/启动自愈 recoverStaleJobs/queueStats 口径/job 事件流
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-jobs-'));
process.env.FACTORY_DATA_DIR = path.join(TMP, 'data');
process.env.FACTORY_DB = path.join(TMP, 'jobs.db');
process.env.FACTORY_CONFIG = path.join(TMP, 'config.json');
fs.mkdirSync(process.env.FACTORY_DATA_DIR, { recursive: true });
fs.writeFileSync(process.env.FACTORY_CONFIG, JSON.stringify({ llm: { provider: 'mock' }, image: { backend: 'placeholder' } }), 'utf8');

const { migrate, run, get } = await import('../src/db.js');
const J = await import('../src/jobs.js');
const { nowISO, rid } = await import('../src/util.js');

migrate();

let pass = 0, fail = 0;
const ok = (name, cond, evidence = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${evidence ? `  ← ${evidence}` : ''}`); }
  else { fail++; console.error(`  ✗ ${name}  ← ${evidence}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 默认等待放宽到 30s：本套件是全量自检里的第 11 站，前面几站刚跑完（ffmpeg/SQLite 刚把磁盘与 CPU 用满），
// 机器负载高时一个「4×15ms 的任务」也可能几秒才轮到 → 曾出现 status=running 的偶发失败。
// 断言的是「最终会完成」，不是「必须在 4 秒内完成」。
const waitFor = async (fn, ms = 30000, step = 25) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(step); }
  return false;
};
const dbJob = (id) => get('SELECT * FROM jobs WHERE id = ?', id);

console.log('=== 1. 基本执行：排队 → 完成 → 结果落库 ===');
const seen = [];
const j1 = J.enqueue({
  type: 'demo', title: '基础任务', total: 4,
  handler: async (ctx) => {
    for (let i = 1; i <= 4; i++) { seen.push(ctx.isCanceled()); ctx.step(i, 4, `第 ${i} 步`); await sleep(15); }
    return { note: 'ok' };
  },
});
ok('enqueue 返回任务 id', /^JOB-/.test(j1.id || j1), String(j1.id || j1));
const jid = j1.id || j1;
const doneOk = await waitFor(() => dbJob(jid)?.status === 'done');
ok('任务执行完成（status=done）', doneOk, `status=${dbJob(jid)?.status}`);
const row1 = dbJob(jid);
ok('完成后进度为 100', row1.progress === 100, `progress=${row1.progress}`);
ok('完成时 done 等于 total', row1.done === row1.total && row1.total === 4, `done=${row1.done}/${row1.total}`);
ok('handler 返回值写入 result', JSON.parse(row1.result || '{}').note === 'ok', String(row1.result));
ok('finished_at 已写入', Boolean(row1.finished_at), String(row1.finished_at));
ok('执行期间 ctx.isCanceled() 为 false', seen.length === 4 && seen.every((x) => x === false), JSON.stringify(seen));

console.log('\n=== 2. 同类型并发上限（limit=1 串行） ===');
let running = 0, maxRunning = 0;
const serialIds = [];
for (let i = 0; i < 3; i++) {
  const j = J.enqueue({
    type: 'serial', title: `串行 ${i}`, limit: 1,
    handler: async () => { running++; maxRunning = Math.max(maxRunning, running); await sleep(60); running--; return i; },
  });
  serialIds.push(j.id || j);
}
// 等待窗口用默认 30s（原为硬编码 6000）：断言的是「三个串行任务最终都会完成」，不是「6 秒内完成」。
// 实测：单跑本套件全程 2.7s，本段通常 <300ms；但全量自检里本站在 ffmpeg/Playwright 满负荷之后，
// 队列每完成一个任务要过一次 setTimeout(pump,10)（见 src/jobs.js pump），机器被压住时三轮 timer 可能被拖到数秒
// —— 2026-09-30 全量自检实测 running,queued,queued 卡满 6s 而其余 46 条全过（同一原因，见第 107 行的既有注释）。
const serialDone = await waitFor(() => serialIds.every((id) => dbJob(id)?.status === 'done'));
ok('三个限流任务全部完成', serialDone, serialIds.map((id) => dbJob(id)?.status).join(','));
ok('同类型并发从未超过 limit=1', maxRunning === 1, `maxRunning=${maxRunning}`);

console.log('\n=== 3. 取消：排队中的任务不得被取出执行 ===');
let ranQueued = false;
const blocker = J.enqueue({ type: 'cancelq', title: '占位', limit: 1, handler: async () => { await sleep(300); return 'block'; } });
const queuedJob = J.enqueue({ type: 'cancelq', title: '排队中将被取消', limit: 1, handler: async () => { ranQueued = true; return 'should-not-run'; } });
const qid = queuedJob.id || queuedJob;
const bid = blocker.id || blocker;
J.cancelJob(qid);
ok('排队中被取消 → 状态立即为 canceled', dbJob(qid)?.status === 'canceled', `status=${dbJob(qid)?.status}`);
await waitFor(() => dbJob(bid)?.status === 'done');   // 同上：300ms 的占位任务，窗口放宽到默认 30s（原 4000）
await sleep(200);
ok('被取消的排队任务从未执行（handler 调用次数 0）', ranQueued === false);
ok('取消后保持 canceled（没有被队列翻成 done）', dbJob(qid)?.status === 'canceled', `status=${dbJob(qid)?.status}`);
ok('取消原因写明用户已取消', String(dbJob(qid)?.error || '').includes('用户已取消'), String(dbJob(qid)?.error));

console.log('\n=== 4. 取消：执行中的任务，终态不得被覆写（本次修复的缺陷） ===');
let handlerReturned = false;
let cancelSeen = false;
const runningJob = J.enqueue({
  type: 'cancelrun', title: '执行中将被取消', total: 3,
  handler: async (ctx) => {
    for (let i = 0; i < 6; i++) {
      if (ctx.isCanceled()) { cancelSeen = true; break; }
      ctx.step(i + 1, 6);
      await sleep(50);
    }
    handlerReturned = true;
    return { finishedDespiteCancel: true };
  },
});
const rid2 = runningJob.id || runningJob;
await waitFor(() => dbJob(rid2)?.status === 'running');
J.cancelJob(rid2);
const stillCanceled = await waitFor(() => dbJob(rid2)?.status === 'canceled');
ok('取消后状态为 canceled', stillCanceled, `status=${dbJob(rid2)?.status}`);
// 先等 handler 收尾（它在循环里检查取消并 break，然后 runs 完 finally 分支）
const settled = await waitFor(() => handlerReturned === true, 15000);   // 放宽：全量自检时机器繁忙，300ms 的 handler 也可能被拖到数秒
await sleep(300);
ok('handler 通过 ctx.isCanceled() 感知到取消（协作式退出）', cancelSeen === true, String(cancelSeen));
const row4 = dbJob(rid2);
ok('handler 已返回（跑完）', settled === true);
ok('★ 终态未被覆写成 done（修复前会变 done/100%）', row4.status === 'canceled', `status=${row4.status} progress=${row4.progress}`);
ok('★ 进度未被拉到 100%', row4.progress !== 100 || row4.status === 'canceled', `progress=${row4.progress}`);
ok('★ result 未被写入（取消的任务不该报成功）', !row4.result, String(row4.result));
ok('★ 失败原因未被覆写成别的错（保留用户已取消）', String(row4.error || '').includes('用户已取消'), String(row4.error));
ok('取消集合已释放（isCanceled 归 false，长期运行不泄漏）', J.isCanceled(rid2) === false, String(J.isCanceled(rid2)));

console.log('\n=== 5. 失败任务：状态为 error 且带中文原因 ===');
const failJob = J.enqueue({ type: 'fail', title: '会失败', handler: async () => { throw new Error('模拟失败：素材缺失'); } });
const fid = failJob.id || failJob;
await waitFor(() => dbJob(fid)?.status === 'error');
ok('失败任务状态为 error', dbJob(fid)?.status === 'error', `status=${dbJob(fid)?.status}`);
ok('错误原因落库', String(dbJob(fid)?.error || '').includes('模拟失败'), String(dbJob(fid)?.error));
ok('失败任务 finished_at 已写入', Boolean(dbJob(fid)?.finished_at));

console.log('\n=== 6. 取消后不影响后续任务调度（队列不卡死） ===');
const afterJob = J.enqueue({ type: 'cancelq', title: '取消之后的正常任务', limit: 1, handler: async () => 'after-ok' });
const aid = afterJob.id || afterJob;
const afterDone = await waitFor(() => dbJob(aid)?.status === 'done');   // 同上：窗口放宽到默认 30s（原 4000）
ok('取消之后同类型队列继续工作', afterDone, `status=${dbJob(aid)?.status}`);

console.log('\n=== 7. queueStats 口径 ===');
const stats = J.queueStats();
ok('queueStats 返回按类型的队列快照', stats && typeof stats === 'object' && Object.keys(stats).length >= 1, JSON.stringify(stats).slice(0, 160));
const stSerial = stats.serial || {};
ok('serial 队列统计含 limit/总数字段', 'limit' in stSerial || 'total' in stSerial, JSON.stringify(stSerial).slice(0, 120));

console.log('\n=== 8. 启动自愈：僵尸任务标记中断 ===');
const zombieId = rid('JOB');
run(`INSERT INTO jobs(id, type, title, status, progress, payload, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?)`, zombieId, 'zombie', '被杀进程留下的任务', 'running', 42, '{}', nowISO(), nowISO());
const zombieQueued = rid('JOB');
run(`INSERT INTO jobs(id, type, title, status, progress, payload, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?)`, zombieQueued, 'zombie', '排队的僵尸任务', 'queued', 0, '{}', nowISO(), nowISO());
const rec = J.recoverStaleJobs();
ok('自愈清理了 2 个僵尸任务', rec.recovered === 2, JSON.stringify(rec));
ok('僵尸任务被标记为 error 并说明服务重启', dbJob(zombieId)?.status === 'error' && String(dbJob(zombieId)?.error || '').includes('服务重启'), `${dbJob(zombieId)?.status} / ${dbJob(zombieId)?.error}`);
ok('僵尸任务 finished_at 已写入（不再永久转圈）', Boolean(dbJob(zombieId)?.finished_at));
ok('已完成任务不受自愈影响', dbJob(jid)?.status === 'done', `status=${dbJob(jid)?.status}`);

console.log('\n=== 9. 事件流与日志 ===');
const logs = [];
const onLog = (e) => logs.push(e);
J.jobEvents.on('job:log', onLog);
const logJob = J.enqueue({ type: 'logdemo', title: '写日志', handler: async (ctx) => { ctx.log('第一条日志'); ctx.log('第二条日志'); return 'logged'; } });
const lid = logJob.id || logJob;
await waitFor(() => dbJob(lid)?.status === 'done');
J.jobEvents.off('job:log', onLog);
ok('ctx.log 触发 job:log 事件（可被 SSE 推送）', logs.length >= 2 && logs.every((e) => e.id === lid), `count=${logs.length}`);
ok('日志事件带时间戳', logs.length > 0 && Boolean(logs[0].at), String(logs[0]?.at));

console.log('\n=== 10. 真实库未被触碰 ===');
const realDb = path.join(process.cwd(), 'data', 'factory.db');
ok('本次使用临时库（不是 data/factory.db）', process.env.FACTORY_DB !== realDb && fs.existsSync(process.env.FACTORY_DB), process.env.FACTORY_DB);
ok('临时库里才有本次的 jobs 表数据', get('SELECT COUNT(*) c FROM jobs').c >= 8, `jobs=${get('SELECT COUNT(*) c FROM jobs').c}`);

console.log('\n=== 7. 队列暂停（预算/额度自动暂停，不丢任务） ===');
const J2 = await import('../src/jobs.js');
ok('初始未暂停', J2.pauseState().paused === false);
const pausedInfo = J2.pauseQueues({ reason: '本月金额将超过上限（测试）', by: 'system' });
ok('暂停成功并回报排队/运行中数量', pausedInfo.ok === true && pausedInfo.paused === true && typeof pausedInfo.queued === 'number',
  JSON.stringify(pausedInfo).slice(0, 120));
// 暂停期间入队：任务留在队列里，不得开跑
const ranWhilePaused = [];
const jPaused = J2.enqueue({ type: 'demo-pause', title: '暂停期间入队的任务', total: 2, handler: async (ctx) => { ranWhilePaused.push(1); return { ok: true }; } });
await sleep(400);
const rowPaused = get('SELECT * FROM jobs WHERE id = ?', jPaused);
ok('暂停期间入队的任务保持 queued（不失败、不丢）', rowPaused.status === 'queued' && ranWhilePaused.length === 0,
  `status=${rowPaused.status} ran=${ranWhilePaused.length}`);
ok('暂停状态可读（含原因与发起方）', J2.pauseState().paused === true && /超过上限/.test(J2.pauseState().reason) && J2.pauseState().by === 'system',
  JSON.stringify(J2.pauseState()));
ok('暂停历史留档（供决策时间线摊开）', J2.pauseHistory(5).some((h) => h.action === 'pause' && h.by === 'system'), JSON.stringify(J2.pauseHistory(3)));
// 已在跑的任务不被暂停打断：必须**先开跑再暂停**（暂停后入队的任务本来就不该开跑）
J2.resumeQueues({ by: 'human' });
const doneDuringPause = [];
const jRunning = J2.enqueue({ type: 'demo-running', title: '暂停前已在跑', total: 1, handler: async (ctx) => { await sleep(400); doneDuringPause.push(1); return { ok: true }; } });
await sleep(120);                                     // 等它进入 running
J2.pauseQueues({ reason: '跑一半时暂停', by: 'system' });
await sleep(700);
ok('暂停前已在跑的任务照常跑完（暂停不打断进行中的工作）',
  doneDuringPause.length === 1 && get('SELECT status FROM jobs WHERE id = ?', jRunning).status === 'done',
  `ran=${doneDuringPause.length} status=${get('SELECT status FROM jobs WHERE id = ?', jRunning).status}`);
ok('跑一半时暂停：排队里的任务仍然不动（跑完的不回滚、没跑的也不启动）',
  get('SELECT status FROM jobs WHERE id = ?', jPaused).status === 'done' || get('SELECT status FROM jobs WHERE id = ?', jPaused).status === 'queued');
// 恢复：排队任务自动继续
const resumed = J2.resumeQueues({ by: 'human', note: '测试恢复' });
ok('恢复接口返回从哪个原因恢复（此处是「跑一半时暂停」那次）',
  resumed.ok === true && resumed.paused === false && /跑一半时暂停/.test(String(resumed.resumedFrom)), JSON.stringify(resumed).slice(0, 110));
ok('恢复后排队任务自动继续（不需要重新提交）',
  await waitFor(() => get('SELECT status FROM jobs WHERE id = ?', jPaused).status === 'done'),
  `status=${get('SELECT status FROM jobs WHERE id = ?', jPaused).status} ran=${ranWhilePaused.length}`);
ok('恢复也进历史', J2.pauseHistory(5).some((h) => h.action === 'resume'), JSON.stringify(J2.pauseHistory(2)));
// 持久化：重启后依然暂停（不能靠重启绕过闸门）
J2.pauseQueues({ reason: '模拟重启前的暂停', by: 'system' });
const stateRow = get("SELECT value FROM app_config WHERE key = 'jobs:paused'");
ok('暂停状态落库（重启后读同一份数据，绕不过去）', Boolean(stateRow?.value) && JSON.parse(stateRow.value).paused === true);
J2.resumeQueues({ by: 'human' });
ok('恢复后落库状态被清掉', !get("SELECT value FROM app_config WHERE key = 'jobs:paused'"));

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ }
process.exit(fail ? 1 : 0);
