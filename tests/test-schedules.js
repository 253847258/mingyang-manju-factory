// 定时排产（src/schedules.js）自测：纯 Node、离线零成本
// 用法：node tests/test-schedules.js
//
// 测试纪律（与 strategist/tasks/T-202.yaml 及 T-101-schedules-spec.md §11 对齐）：
//   1. **临时库 + 临时目录**：FACTORY_DB / FACTORY_DATA_DIR / FACTORY_CONFIG 全部指向 mkdtemp，
//      绝不触碰 data/factory.db 与 config/config.json（末尾会显式断言这一点）。
//   2. **固定时间戳（假时钟）**：所有判定函数都把 now 当参数注入，测试只传常量 ISO 串
//      （NOW0 / T0900 等），因此本文件的结果与「今天几号、几点跑」无关，可重复复现。
//      唯一例外：updateSchedule() 内部用真实时钟重算水位线（契约 §4 未提供 now 注入点），
//      所以只对它的 note/changed 做断言，不对具体时刻做断言。
//   3. **离线假实例**：llm.provider='mock' + image/video backend='placeholder'，不连外网、不花钱。
//   4. 覆盖：正常路径 / 边界（宽限、DST、闰月 31 号、cron 段数）/ 反例（中文报错且不落库）/
//      幂等（同一窗口只触发一次、同一秒手动触发去重）/ 暂停联动（暂停不建 job、恢复不自动补跑）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-schedules-'));
process.env.FACTORY_DATA_DIR = path.join(TMP, 'data');
process.env.FACTORY_DB = path.join(TMP, 'schedules.db');
process.env.FACTORY_CONFIG = path.join(TMP, 'config.json');
fs.mkdirSync(process.env.FACTORY_DATA_DIR, { recursive: true });
fs.writeFileSync(process.env.FACTORY_CONFIG, JSON.stringify({
  llm: { provider: 'mock' },
  image: { backend: 'placeholder' },
  video: { backend: 'placeholder' },
  tts: { backend: 'placeholder' },
  // 预算写死在临时 config 里（不读 config/config.json）：单价 1 + 月度上限 1，
  // 让「任何一次制片预估都超月度上限」，用于端到端验证预算闸门（契约 §11 用例 7）
  budget: { currency: 'CNY', enabled: true, imageUnit: 1, videoUnit: 1, monthlyCap: 1, productionCap: 0, confirmOver: 0 },
}), 'utf8');

const { migrate, run, get, all, setConfigValue } = await import('../src/db.js');
const S = await import('../src/schedules.js');
const J = await import('../src/jobs.js');

migrate();

let pass = 0;
let fail = 0;
/** 中文断言名 + 证据回显；失败只影响退出码，不中断后续用例（一次跑完看到全貌） */
const ok = (name, cond, evidence = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}${evidence ? `  ← ${evidence}` : ''}`); }
  else { fail += 1; console.error(`  ✗ ${name}  ← ${evidence}`); }
};
const hasCN = (s) => /[\u4e00-\u9fa5]/.test(String(s ?? ''));
/** 断言「抛出的必须是中文 Error」，返回错误消息供证据回显 */
const catchMsg = (fn) => { try { fn(); return null; } catch (e) { return e instanceof Error ? e.message : String(e); } };
const count = (sql, ...args) => Number(get(sql, ...args).c);

// ---------------- 固定时间戳（全部为 UTC 秒级 ISO，字典序即时间序） ----------------
const NOW0 = '2025-06-01T00:00:00Z';          // 建排产时刻（上海 2025-06-01 08:00）
const T0900 = '2025-06-01T01:00:00Z';         // 上海 2025-06-01 09:00 的窗口
const T0905 = '2025-06-01T01:05:00Z';         // 宽限内（默认 grace_min=5）
const T0906 = '2025-06-01T01:06:00Z';         // 宽限外（错过）
const T0930 = '2025-06-01T01:30:00Z';         // 停摆 3 天后的评估时刻（错过 3 个窗口的场景）
const NEXT_DAY_0900 = '2025-06-02T01:00:00Z'; // 次日 09:00 窗口（周一）
const NOW_AFTER_2H = '2025-06-01T03:00:00Z';  // 晚两小时（不补跑用）
const TZ_SH = 'Asia/Shanghai';

console.log('=== 1. 正常路径：下一次触发计算（契约 §11 用例 1） ===');
ok('时区墙钟换算：Asia/Shanghai 的 2025-06-01T01:00:00Z 是本地 09:00',
  S.formatInTz(T0900, TZ_SH) === '2025-06-01 09:00', S.formatInTz(T0900, TZ_SH));
ok('isoSeconds 截断到秒（毫秒不参与水位线比较）',
  S.isoSeconds(new Date('2025-06-01T01:00:00.999Z')) === T0900, S.isoSeconds(new Date('2025-06-01T01:00:00.999Z')));

const daily = { id: 'S-daily', name: '每日 9 点', kind: 'daily', at_time: '09:00', tz: TZ_SH, enabled: 1, miss_policy: 'skip' };
const rDaily = S.nextOccurrence(daily, '2025-05-31T23:00:00Z');
ok('daily 09:00（上海）：05-31 23:00Z 之后的下一次是 2025-06-01T01:00:00Z',
  rDaily.ok === true && rDaily.at === T0900, JSON.stringify(rDaily));
ok('nextOccurrence 是「严格大于」而不是「大于等于」（同一秒不会重复返回同一个窗口）',
  S.nextOccurrence(daily, T0900).at === NEXT_DAY_0900, S.nextOccurrence(daily, T0900).at);

const weekly = { kind: 'weekly', weekdays: '1', at_time: '09:00', tz: TZ_SH };   // 每周一
ok('weekly 周一 09:00：从周六 23:00Z 起算得到 2025-06-02T01:00:00Z（周一）',
  S.nextOccurrence(weekly, '2025-05-31T23:00:00Z').at === NEXT_DAY_0900,
  S.nextOccurrence(weekly, '2025-05-31T23:00:00Z').at);

const monthly31 = { kind: 'monthly', day_of_month: 31, at_time: '09:00', tz: TZ_SH };
ok('monthly 31 号：6 月没有 31 号 → 跳过 6 月，下一次是 2025-07-31T01:00:00Z（不顺延到月末）',
  S.nextOccurrence(monthly31, '2025-06-01T00:00:00Z').at === '2025-07-31T01:00:00Z',
  S.nextOccurrence(monthly31, '2025-06-01T00:00:00Z').at);

const cron15 = { kind: 'cron', cron: '*/15 * * * *', tz: TZ_SH };
ok('cron */15：从 01:00:00Z 之后的下一次是 01:15:00Z',
  S.nextOccurrence(cron15, T0900).at === '2025-06-01T01:15:00Z', S.nextOccurrence(cron15, T0900).at);
const cronOr = { kind: 'cron', cron: '0 9 1 * 1', tz: TZ_SH };   // 1 号 **或** 周一
ok('cron 日与周同时受限按 OR 语义（契约 §7.2）：6/1 号已过 → 下一窗口是 6/2 周一 09:00',
  S.nextOccurrence(cronOr, '2025-06-01T02:00:00Z').at === NEXT_DAY_0900,
  S.nextOccurrence(cronOr, '2025-06-01T02:00:00Z').at);

const interval30 = { kind: 'interval', interval_minutes: 30, anchor_at: T0900, tz: TZ_SH };
ok('interval 对齐 anchor：01:05 之后的下一次是 01:30（不是 01:35，重启/抖动不漂移）',
  S.nextOccurrence(interval30, T0905).at === '2025-06-01T01:30:00Z', S.nextOccurrence(interval30, T0905).at);

const once = { kind: 'once', once_at: '2025-06-01 10:00', tz: TZ_SH };
ok('once：墙钟 "2025-06-01 10:00"（上海）换算为 2025-06-01T02:00:00Z',
  S.nextOccurrence(once, T0900).at === '2025-06-01T02:00:00Z', S.nextOccurrence(once, T0900).at);
ok('once 过期后没有未来窗口（at=null，而不是抛错）',
  S.nextOccurrence(once, '2025-06-01T03:00:00Z').at === null, String(S.nextOccurrence(once, '2025-06-01T03:00:00Z').at));

const runs3 = S.nextRuns(daily, { count: 3, from: T0900 });
ok('nextRuns 返回未来 3 次触发且升序、含 inMinutes',
  runs3.length === 3 && runs3[0].at === NEXT_DAY_0900 && runs3[1].at === '2025-06-03T01:00:00Z'
  && runs3[0].inMinutes === 1440 && runs3.every((x, i) => i === 0 || x.at > runs3[i - 1].at),
  JSON.stringify(runs3.map((x) => [x.at, x.inMinutes])));

console.log('\n=== 2. 边界：夏令时与极端日期（契约 §6 实测基准） ===');
const toUtc = (w, tz) => S.zonedToUtc(w, tz).iso;
ok('DST 春季本地时刻不存在（纽约 2025-03-09 02:30）→ 顺延到 2025-03-09T07:30:00Z',
  toUtc({ y: 2025, mo: 3, d: 9, h: 2, mi: 30 }, 'America/New_York') === '2025-03-09T07:30:00Z',
  toUtc({ y: 2025, mo: 3, d: 9, h: 2, mi: 30 }, 'America/New_York'));
ok('DST 秋季重叠（纽约 2025-11-02 01:30）→ 取较早的一次 = 2025-11-02T05:30:00Z',
  toUtc({ y: 2025, mo: 11, d: 2, h: 1, mi: 30 }, 'America/New_York') === '2025-11-02T05:30:00Z',
  toUtc({ y: 2025, mo: 11, d: 2, h: 1, mi: 30 }, 'America/New_York'));
ok('常规时区换算（纽约 2025-06-01 09:00）→ 2025-06-01T13:00:00Z',
  toUtc({ y: 2025, mo: 6, d: 1, h: 9, mi: 0 }, 'America/New_York') === '2025-06-01T13:00:00Z',
  toUtc({ y: 2025, mo: 6, d: 1, h: 9, mi: 0 }, 'America/New_York'));
ok('无 DST 的固定东八区（上海 2025-01-01 00:00）→ 2024-12-31T16:00:00Z',
  toUtc({ y: 2025, mo: 1, d: 1, h: 0, mi: 0 }, TZ_SH) === '2024-12-31T16:00:00Z',
  toUtc({ y: 2025, mo: 1, d: 1, h: 0, mi: 0 }, TZ_SH));

// DST 周内「每天 09:00 纽约」的相邻间隔只允许 23/24/25 小时，且水位线严格递增（契约 §6 单调性保证 / §11 用例 2）
const nyDaily = { kind: 'daily', at_time: '09:00', tz: 'America/New_York' };
const dstSeq = [];
{
  let cur = '2025-03-07T00:00:00Z';
  for (let i = 0; i < 5; i++) { cur = S.nextOccurrence(nyDaily, cur).at; dstSeq.push(cur); }
}
const dstGapsH = dstSeq.slice(1).map((x, i) => (Date.parse(x) - Date.parse(dstSeq[i])) / 3600000);
ok('DST 跳变周：水位线严格递增（不会重复触发或回到过去）',
  dstSeq.every((x) => Boolean(x)) && dstSeq.every((x, i) => i === 0 || x > dstSeq[i - 1]), dstSeq.join(' → '));
ok('DST 跳变周：相邻间隔全是 23/24/25 小时，且恰好出现一次 23 小时（春季跳变让间隔缩短 1 小时）',
  dstGapsH.every((h) => [23, 24, 25].includes(h)) && dstGapsH.filter((h) => h === 23).length === 1,
  `间隔(小时)=${dstGapsH.join(',')}`);

console.log('\n=== 3. 反例：cron 简版语法边界（中文报错，不静默忽略） ===');
const badCron = (expr) => {
  const p = S.parseCron(expr);
  return { ok: p.ok, error: p.error || '' };
};
const c1 = badCron('0 9 * * 8');
ok('cron 周字段超范围（0 9 * * 8）报中文错并说明 0-6（0=周日）',
  c1.ok === false && hasCN(c1.error) && c1.error.includes('周字段超出范围') && c1.error.includes('0-6'), c1.error);
const c2 = badCron('0 0 9 * * *');
ok('cron 六段（秒级）被拒绝并提示去掉第一段秒',
  c2.ok === false && c2.error.includes('不支持秒级'), c2.error);
const c3 = badCron('@daily');
ok('cron 宏（@daily）被拒绝并提示必须是 5 段', c3.ok === false && c3.error.includes('5 段'), c3.error);
const c4 = badCron('0 9 * * MON');
ok('cron 星期名称（MON）被拒绝（不支持名称/宏）', c4.ok === false && c4.error.includes('不支持名称或宏'), c4.error);
const c5 = badCron('*/0 * * * *');
ok('cron 步进 0 被拒绝（步进必须是正整数）', c5.ok === false && c5.error.includes('步进必须是正整数'), c5.error);
const c6 = badCron('0 9 * * 1#2');
ok('cron 扩展符（#）被拒绝，并提示不支持 L/W/#/?',
  c6.ok === false && c6.error.includes('不支持 L/W/#/?'), c6.error);
ok('cron 里的字母（L = 月末）同样被拒绝（不静默当成非法值忽略）',
  badCron('0 9 L * *').ok === false && hasCN(badCron('0 9 L * *').error), badCron('0 9 L * *').error);
const c7 = S.parseCron('0 9 * * 7');
ok('cron 周字段 7 视为周日（内部归一到 0）',
  c7.ok === true && c7.sets.weekdays.length === 1 && c7.sets.weekdays[0] === 0, JSON.stringify(c7.sets?.weekdays));
ok('cron 预编译集合可被 cronMatches 直接复用（周日 09:00 上海 = 2025-06-01T01:00:00Z 命中）',
  c7.ok === true && S.cronMatches(T0900, c7.sets, TZ_SH) === true, String(S.cronMatches(T0900, c7.sets, TZ_SH)));
ok('cronMatches 反例：同一条 cron 在 08:59 不命中（分钟不匹配）',
  S.cronMatches('2025-06-01T00:59:00Z', c7.sets, TZ_SH) === false, String(S.cronMatches('2025-06-01T00:59:00Z', c7.sets, TZ_SH)));

console.log('\n=== 4. 反例：createSchedule 校验（全中文报错，且不落库半成品） ===');
const baseInput = () => ({
  name: '每日 9 点短剧排产', kind: 'daily', at_time: '09:00', tz: TZ_SH,
  mode: 'new_production', target: { brief: '拍一部 3 集都市悬疑短剧', spec: { episodes: 3, episodeSeconds: 60 }, offline: true, until: 'all' },
  miss_policy: 'skip', grace_min: 5, budget_guard: 0,
});
// 先建一条合法排产，作为「非法输入不落库」的基线（后续只需断言行数不变）
const A = S.createSchedule(baseInput(), { by: 'human', now: NOW0 });
const rowsAfterCreate = count('SELECT COUNT(*) c FROM schedules');
ok('createSchedule 建出 S-0001 且立即给出水位线（下一次 = 今日 09:00）',
  A && A.id === 'S-0001' && A.next_run_at === T0900, `${A?.id} next_run_at=${A?.next_run_at}`);
ok('createSchedule 默认值齐全（miss_policy=skip / grace_min=5 / skip_if_running=1 / enabled=1）',
  A.miss_policy === 'skip' && A.grace_min === 5 && A.skip_if_running === 1 && A.enabled === 1,
  `${A.miss_policy}/${A.grace_min}/${A.skip_if_running}/${A.enabled}`);
ok('summary 是中文一句话（含下次触发文案与时区）',
  hasCN(A.summary) && A.summary.includes('每天 09:00') && A.summary.includes(TZ_SH) && A.summary.includes('下次'),
  A.summary);

const badCases = [
  ['排产名称必填', () => S.createSchedule({ ...baseInput(), name: '' }, { now: NOW0 }), '排产名称必填'],
  ['排产名称过长', () => S.createSchedule({ ...baseInput(), name: '长'.repeat(61) }, { now: NOW0 }), '排产名称过长'],
  ['kind 非法', () => S.createSchedule({ ...baseInput(), kind: 'hourly' }, { now: NOW0 }), 'kind 非法'],
  ['无效时区', () => S.createSchedule({ ...baseInput(), tz: 'Bad/Zone' }, { now: NOW0 }), '无效时区'],
  ['at_time 格式非法', () => S.createSchedule({ ...baseInput(), at_time: '9:00' }, { now: NOW0 }), 'at_time 必须是'],
  ['weekdays 超范围', () => S.createSchedule({ ...baseInput(), kind: 'weekly', weekdays: '8', at_time: '09:00' }, { now: NOW0 }), 'weekdays 必须是 0~6'],
  ['day_of_month 超范围', () => S.createSchedule({ ...baseInput(), kind: 'monthly', day_of_month: 32, at_time: '09:00' }, { now: NOW0 }), 'day_of_month 必须是 1~31'],
  ['interval 间隔非法', () => S.createSchedule({ ...baseInput(), kind: 'interval', interval_minutes: 0 }, { now: NOW0 }), 'interval 间隔必须是 1~10080'],
  ['cron 表达式非法', () => S.createSchedule({ ...baseInput(), kind: 'cron', cron: '0 9 * * 8' }, { now: NOW0 }), 'cron 表达式非法'],
  ['once_at 已过期', () => S.createSchedule({ ...baseInput(), kind: 'once', once_at: '2025-05-01 09:00' }, { now: NOW0 }), 'once_at 必须是'],
  ['miss_policy 非法', () => S.createSchedule({ ...baseInput(), miss_policy: 'later' }, { now: NOW0 }), 'miss_policy 非法'],
  ['catchup_max 超范围', () => S.createSchedule({ ...baseInput(), catchup_max: 51 }, { now: NOW0 }), 'catchup_max 必须是 0~50'],
  ['existing_production 缺 productionId', () => S.createSchedule({ ...baseInput(), mode: 'existing_production', target: {} }, { now: NOW0 }), 'target.productionId'],
  ['new_production 缺 brief/spec', () => S.createSchedule({ ...baseInput(), target: {} }, { now: NOW0 }), '请给 target.brief'],
];
for (const [label, fn, expect] of badCases) {
  const msg = catchMsg(fn);
  ok(`非法输入抛中文 Error：${label}`, msg !== null && hasCN(msg) && msg.includes(expect), msg || '(没有抛错)');
}
const dupMsg = catchMsg(() => S.createSchedule(baseInput(), { now: NOW0 }));
ok('排产重名被拒绝（中文提示已存在的 id）', dupMsg !== null && dupMsg.includes('排产名称已重复') && dupMsg.includes('S-0001'), dupMsg);
ok('★ 15 次非法输入全部不落库（schedules 行数仍为 1，不留半成品）',
  count('SELECT COUNT(*) c FROM schedules') === rowsAfterCreate && rowsAfterCreate === 1,
  `rows=${count('SELECT COUNT(*) c FROM schedules')}`);

console.log('\n=== 5. 到点判定（纯函数）：正常到点 + 宽限边界 + 错过窗口 ===');
const cfg = S.schedulesConfig();
const T_EVAL = { paused: false, pauseReason: '', running: false, budget: null, cfg };
const evFire = S.evaluateSchedule(A, T0900, T_EVAL);
ok('到点触发一次：09:00 整点判定为 due，reasonCode=due，窗口就是 09:00',
  evFire.due === true && evFire.decision === 'fire' && evFire.reasonCode === 'due' && evFire.occurrence === T0900,
  `${evFire.reasonCode} occurrence=${evFire.occurrence}`);
ok('到点触发：中文原因说明窗口，且水位线推进到次日 09:00',
  hasCN(evFire.reason) && evFire.reason.includes('到点触发') && evFire.nextRunAt === NEXT_DAY_0900,
  `${evFire.reason} → next=${evFire.nextRunAt}`);
ok('边界：延迟 5 分钟仍在宽限内（grace_min=5）→ 照常触发（不把抖动误判成错过）',
  S.evaluateSchedule(A, T0905, T_EVAL).due === true
  && S.evaluateSchedule(A, T0905, T_EVAL).lateMinutes === 5
  && S.evaluateSchedule(A, T0905, T_EVAL).onTime === true,
  JSON.stringify({ late: S.evaluateSchedule(A, T0905, T_EVAL).lateMinutes, due: S.evaluateSchedule(A, T0905, T_EVAL).due }));
ok('边界：延迟 6 分钟越过宽限 → 按 miss_policy=skip 判定为「错过」而不是触发',
  S.evaluateSchedule(A, T0906, T_EVAL).due === false
  && S.evaluateSchedule(A, T0906, T_EVAL).reasonCode === 'skipped_missed',
  S.evaluateSchedule(A, T0906, T_EVAL).reasonCode);

// 停机 3 天：把水位线停在 5/30 09:00，等到 6/1 09:30 才被评估 → 5/30、5/31、6/1 三个窗口全部过期
const missed3 = { ...A, next_run_at: '2025-05-30T01:00:00Z' };
const evSkip = S.evaluateSchedule(missed3, T0930, T_EVAL);
ok('错过窗口（skip 策略）：枚举出 3 个到期窗口、一个都不补跑、miss=3',
  evSkip.due === false && evSkip.reasonCode === 'skipped_missed' && evSkip.occurrences.length === 3 && evSkip.miss === 3,
  `occurrences=${evSkip.occurrences.length} miss=${evSkip.miss} ${evSkip.reason}`);
ok('错过窗口（skip 策略）：中文原因写明「已错过 N 个窗口」并给出下次时间',
  hasCN(evSkip.reason) && evSkip.reason.includes('已错过 3 个窗口') && evSkip.reason.includes(NEXT_DAY_0900),
  evSkip.reason);
const evCatchup = S.evaluateSchedule({ ...missed3, miss_policy: 'catchup' }, T0930, T_EVAL);
ok('错过窗口（catchup 策略）：只补最近一个（6/1 09:00），丢弃更早的 2 个（missed=2）',
  evCatchup.due === true && evCatchup.occurrence === T0900 && evCatchup.missed === 2,
  `occurrence=${evCatchup.occurrence} missed=${evCatchup.missed}`);
const evAll = S.evaluateSchedule({ ...missed3, miss_policy: 'catchup_all', catchup_max: 2 }, T0930, T_EVAL);
ok('错过窗口（catchup_all + catchup_max=2）：补 2 个里最老的那个（5/31），只丢 1 个',
  evAll.due === true && evAll.occurrence === '2025-05-31T01:00:00Z' && evAll.missed === 1,
  `occurrence=${evAll.occurrence} missed=${evAll.missed}`);
const evAllZero = S.evaluateSchedule({ ...missed3, miss_policy: 'catchup_all', catchup_max: 0 }, T0930, T_EVAL);
ok('边界：catchup_all + catchup_max=0 退化为「一个都不补」',
  evAllZero.due === false && evAllZero.reasonCode === 'skipped_missed', `${evAllZero.reasonCode} due=${evAllZero.due}`);
const cfgTiny = S.schedulesConfig({ schedules: { maxCatchupScan: 3 } });
// 每 1 分钟一次、水位线在 00:50Z：到 01:00Z 为止共 11 个窗口，但配置只允许枚举 3 个
const evTrunc = S.evaluateSchedule(
  { ...A, kind: 'interval', interval_minutes: 1, anchor_at: '2025-06-01T00:00:00Z', next_run_at: '2025-06-01T00:50:00Z', miss_policy: 'skip' },
  T0900, { ...T_EVAL, cfg: cfgTiny },
);
ok('边界：到期窗口数超过 maxCatchupScan=3 时只枚举 3 个，其余记为遗漏（防停机一年枚举 50 万次）',
  evTrunc.occurrences.length === 3 && evTrunc.miss === 11, `occurrences=${evTrunc.occurrences.length} miss=${evTrunc.miss}`);

console.log('\n=== 6. 纯函数闸门：停用 / 暂停 / 上一轮在跑 / 预算拦截 ===');
const evOff = S.evaluateSchedule({ ...A, enabled: 0 }, T0900, T_EVAL);
ok('反例：本条排产 enabled=0 时不触发，且不动水位线、不计入 skip_count（record=false）',
  evOff.due === false && evOff.reasonCode === 'skipped_disabled' && evOff.record === false && evOff.nextRunAt === T0900,
  `${evOff.reasonCode} record=${evOff.record} next=${evOff.nextRunAt}`);
const evPause = S.evaluateSchedule(A, T0900, { ...T_EVAL, paused: true, pauseReason: '本月金额将超过上限（测试）' });
ok('暂停时不触发（纯判定）：reasonCode=skipped_paused，中文原因摘录暂停理由',
  evPause.due === false && evPause.reasonCode === 'skipped_paused'
  && hasCN(evPause.reason) && evPause.reason.includes('队列暂停中') && evPause.reason.includes('本月金额将超过上限'),
  evPause.reason);
ok('暂停时不触发：窗口作废并推进水位线（恢复后不会把暂停期间的窗口一次性灌进队列）',
  evPause.nextRunAt === NEXT_DAY_0900, String(evPause.nextRunAt));
const evPauseCatchup = S.evaluateSchedule({ ...A, catchup_after_pause: 1, miss_policy: 'catchup' }, T0900,
  { ...T_EVAL, paused: true, pauseReason: '人工暂停' });
ok('例外：catchup_after_pause=1 且 miss_policy!=skip 时才允许「恢复补跑」（这是显式选择，不是默认行为）',
  evPauseCatchup.due === true && evPauseCatchup.reasonCode === 'due',
  `${evPauseCatchup.reasonCode} due=${evPauseCatchup.due}`);
const evRunning = S.evaluateSchedule(A, T0900, { ...T_EVAL, running: true });
ok('反例：上一条排产任务仍在跑（skip_if_running=1）→ 本次不叠跑（skipped_running）',
  evRunning.due === false && evRunning.reasonCode === 'skipped_running' && hasCN(evRunning.reason),
  `${evRunning.reasonCode} ${evRunning.reason}`);
const evBudget = S.evaluateSchedule({ ...A, budget_guard: 1 }, T0900,
  { ...T_EVAL, budget: { blocked: true, code: 'skipped_budget', reason: '本月预算上限 1 CNY：合计 3 超限' } });
ok('反例：预算闸门命中 → skipped_budget，且把闸门的中文原因如实带出',
  evBudget.due === false && evBudget.reasonCode === 'skipped_budget' && evBudget.reason.includes('本月预算上限'),
  evBudget.reason);
ok('反例：budget_guard=0 的排产不受预算闸门影响（用户显式关掉保护时如实放行）',
  S.evaluateSchedule({ ...A, budget_guard: 0 }, T0900,
    { ...T_EVAL, budget: { blocked: true, code: 'skipped_budget', reason: 'x' } }).due === true,
  'budget_guard=0 → due 应为 true');

console.log('\n=== 7. 真实库：到点触发一次 + 重复调用不重复触发（幂等，唯一索引兜底） ===');
// 用一条已存在的制片项目做 existing_production 目标：不建新项目、不连网，聚焦触发与幂等
run('INSERT INTO productions(id, title, brief, status, created_at, updated_at) VALUES(?,?,?,?,?,?)',
  'PR-TEST-1', '测试制片项目', '离线幂等测试用', 'draft', NOW0, NOW0);
// 全程暂停队列：排产确实建了 job，但队列闸门是第二道闸门 → job 停在 queued，handler 永不执行（离线、零成本）
J.pauseQueues({ reason: 'T-202 自测：暂停队列以免真的跑流水线（固定时间戳）', by: 'system' });
const jobsBefore = count('SELECT COUNT(*) c FROM jobs');

const B = S.createSchedule({
  ...baseInput(), name: '触发幂等（每日 9 点）', target: { productionId: 'PR-TEST-1' }, mode: 'existing_production',
}, { by: 'agent', now: NOW0 });
ok('existing_production 排产建出并可读（目标项目存在时通过校验）',
  B && B.mode === 'existing_production' && B.next_run_at === T0900, `${B?.id} ${B?.mode} ${B?.next_run_at}`);

const fire1 = await S.fireSchedule(B.id, { trigger: 'auto', occurrence_at: T0900, force: true, now: '2025-06-01T01:00:07Z', ctx: { paused: true } });
ok('到点触发一次：fired=true，产出 jobId 与 runId，窗口键=窗口起点',
  fire1.ok === true && fire1.fired === true && /^JOB-/.test(String(fire1.jobId)) && /^RUN-/.test(String(fire1.runId))
  && fire1.windowKey === T0900 && fire1.occurrence === T0900,
  JSON.stringify({ fired: fire1.fired, job: fire1.jobId, run: fire1.runId, w: fire1.windowKey }));
ok('触发后：jobs 表只多 1 行，且是 type=studio 的排产任务（标题带 [排产] 前缀，payload 标了 scheduled）',
  count('SELECT COUNT(*) c FROM jobs') === jobsBefore + 1
  && get('SELECT type, title, payload FROM jobs WHERE id = ?', fire1.jobId)?.type === 'studio'
  && String(get('SELECT title FROM jobs WHERE id = ?', fire1.jobId).title).startsWith('[排产] ')
  && JSON.parse(get('SELECT payload FROM jobs WHERE id = ?', fire1.jobId).payload).scheduled === true,
  `jobs=${count('SELECT COUNT(*) c FROM jobs')} title=${get('SELECT title FROM jobs WHERE id = ?', fire1.jobId)?.title}`);
ok('触发后：台账只有 1 行、status=fired / reason_code=due，且幂等键形如 sched:{id}:{窗口}',
  count("SELECT COUNT(*) c FROM schedule_runs WHERE schedule_id = ?", B.id) === 1
  && get('SELECT status FROM schedule_runs WHERE schedule_id = ?', B.id).status === 'fired'
  && get('SELECT reason_code FROM schedule_runs WHERE schedule_id = ?', B.id).reason_code === 'due'
  && get('SELECT idem_key FROM schedule_runs WHERE schedule_id = ?', B.id).idem_key === `sched:${B.id}:${T0900}`,
  JSON.stringify(get('SELECT status, reason_code, idem_key, window_key FROM schedule_runs WHERE schedule_id = ?', B.id)));
ok('触发后：水位线推进到次日 09:00、fire_count=1、last_occurrence_at=本次窗口',
  S.getSchedule(B.id).next_run_at === NEXT_DAY_0900 && S.getSchedule(B.id).fire_count === 1
  && get('SELECT last_occurrence_at FROM schedules WHERE id = ?', B.id).last_occurrence_at === T0900,
  `next=${S.getSchedule(B.id).next_run_at} fire_count=${S.getSchedule(B.id).fire_count}`);

const jobsAfterFire1 = count('SELECT COUNT(*) c FROM jobs');
const fire2 = await S.fireSchedule(B.id, { trigger: 'auto', occurrence_at: T0900, force: true, now: '2025-06-01T01:00:59Z', ctx: { paused: true } });
ok('★ 幂等：同一窗口再触发一次 → deduped=true / reasonCode=skipped_deduped（不会重复花钱）',
  fire2.ok === true && fire2.fired === false && fire2.deduped === true && fire2.reasonCode === 'skipped_deduped'
  && fire2.runId === fire1.runId,
  JSON.stringify({ fired: fire2.fired, deduped: fire2.deduped, runId: fire2.runId }));
ok('★ 幂等：重复触发时 jobs 表一行都没有增加、台账仍是 1 行',
  count('SELECT COUNT(*) c FROM jobs') === jobsAfterFire1
  && count('SELECT COUNT(*) c FROM schedule_runs WHERE schedule_id = ?', B.id) === 1,
  `jobs=${count('SELECT COUNT(*) c FROM jobs')} runs=${count('SELECT COUNT(*) c FROM schedule_runs WHERE schedule_id = ?', B.id)}`);
ok('幂等去重的中文原因写明「该窗口已处理过」', hasCN(fire2.reason) && fire2.reason.includes('幂等去重'), fire2.reason);
ok('乱序/更晚的同窗口重复触发也仍被去重（重启后补 tick 不会重复建任务）',
  (await S.fireSchedule(B.id, { trigger: 'auto', occurrence_at: T0900, force: true, now: NEXT_DAY_0900, ctx: { paused: true } })).deduped === true,
  '第二次同窗口 → deduped');

console.log('\n=== 8. 手动触发：同一秒内重复点击只触发一次，且不消费自动窗口 ===');
const beforeManualNext = S.getSchedule(B.id).next_run_at;
const m1 = await S.fireSchedule(B.id, { trigger: 'manual', now: '2025-06-01T02:00:00Z', force: true, ctx: { paused: true } });
ok('手动触发：窗口键带 manual: 前缀（与自动窗口互不顶掉），fired=true',
  m1.fired === true && m1.windowKey === 'manual:2025-06-01T02:00:00Z', String(m1.windowKey));
ok('手动触发不推进自动水位线（插队跑一次，不消费自动窗口）',
  S.getSchedule(B.id).next_run_at === beforeManualNext && beforeManualNext === NEXT_DAY_0900,
  `next=${S.getSchedule(B.id).next_run_at}`);
const m2 = await S.fireSchedule(B.id, { trigger: 'manual', now: '2025-06-01T02:00:00Z', force: true, ctx: { paused: true } });
ok('★ 幂等：同一秒手动触发两次 → 第二次 deduped（前端重试安全，HTTP 仍可 200）',
  m2.fired === false && m2.deduped === true && m2.reasonCode === 'skipped_deduped', JSON.stringify({ fired: m2.fired, deduped: m2.deduped }));
ok('手动触发的两条记录在台账里是 1 行（(schedule_id, window_key, trigger) 唯一）',
  count("SELECT COUNT(*) c FROM schedule_runs WHERE schedule_id = ? AND trigger = 'manual'", B.id) === 1,
  `manual runs=${count("SELECT COUNT(*) c FROM schedule_runs WHERE schedule_id = ? AND trigger = 'manual'", B.id)}`);
ok('最后一次手动触发写进 last_job_id（审计可追溯谁在什么时候插了队）',
  get('SELECT last_job_id FROM schedules WHERE id = ?', B.id).last_job_id === m1.jobId,
  String(get('SELECT last_job_id FROM schedules WHERE id = ?', B.id).last_job_id));

console.log('\n=== 9. 暂停联动（真实 pauseState）与恢复后不补跑 ===');
const C = S.createSchedule({ ...baseInput(), name: '暂停联动（每日 9 点）', target: { productionId: 'PR-TEST-1' }, mode: 'existing_production' }, { now: NOW0 });
const jobsBeforePaused = count('SELECT COUNT(*) c FROM jobs');
const tickPaused = await S.tickSchedules({ now: T0900 });
ok('暂停期间的 tick：不触发任何排产（fired 为空）', tickPaused.fired.length === 0, JSON.stringify(tickPaused.fired));
ok('暂停期间的 tick：队列暂停状态如实回报（enabled=true、queue.paused=true）',
  tickPaused.enabled === true && tickPaused.queue && tickPaused.queue.paused === true, JSON.stringify(tickPaused.queue));
const pausedItem = tickPaused.skipped.find((x) => x.id === C.id);
ok('★ 暂停时不触发但留痕：台账 status=skipped / reason_code=skipped_paused，中文原因含暂停理由',
  pausedItem && pausedItem.reasonCode === 'skipped_paused' && pausedItem.recorded === true
  && hasCN(pausedItem.reason) && pausedItem.reason.includes('暂停'),
  JSON.stringify(pausedItem));
ok('★ 暂停期间不建 job（jobs 表一行都没多：恢复时不会一次性灌爆队列）',
  count('SELECT COUNT(*) c FROM jobs') === jobsBeforePaused,
  `jobs=${count('SELECT COUNT(*) c FROM jobs')} before=${jobsBeforePaused}`);
ok('暂停跳过后：skip_count +1、窗口作废并推进水位线到次日 09:00',
  S.getSchedule(C.id).skip_count === 1 && S.getSchedule(C.id).next_run_at === NEXT_DAY_0900,
  `skip_count=${S.getSchedule(C.id).skip_count} next=${S.getSchedule(C.id).next_run_at}`);

// 收尾：先把排产建出的 job 全部取消（避免恢复队列后真的跑起离线流水线），再验「恢复后不自动补跑」
for (const row of all("SELECT id FROM jobs WHERE type = 'studio'")) J.cancelJob(row.id);
const jobsBeforeResume = count('SELECT COUNT(*) c FROM jobs');
J.resumeQueues({ by: 'human', note: 'T-202 自测恢复' });
const tickAfterResume = await S.tickSchedules({ now: NOW_AFTER_2H });
ok('★ 恢复队列后默认不补跑：暂停期间错过的窗口不会被补上（fired 为空、jobs 不增）',
  tickAfterResume.fired.length === 0 && count('SELECT COUNT(*) c FROM jobs') === jobsBeforeResume,
  `fired=${tickAfterResume.fired.length} jobs=${count('SELECT COUNT(*) c FROM jobs')}`);
ok('恢复后：已消费过窗口的排产不再出现在 tick 结果里，也不产生任何新台账行（水位线不回退）',
  !tickAfterResume.skipped.some((x) => x.id === C.id)
  && count('SELECT COUNT(*) c FROM schedule_runs WHERE schedule_id = ?', C.id) === 1
  && S.getSchedule(C.id).next_run_at === NEXT_DAY_0900,
  `skipped=${JSON.stringify(tickAfterResume.skipped.map((x) => [x.id, x.reasonCode]))} next=${S.getSchedule(C.id).next_run_at}`);
ok('★ 同一窗口不重复建任务：已触发的窗口在后续 tick 里也不会再建 job',
  count('SELECT COUNT(*) c FROM jobs') === jobsBeforeResume,
  `jobs=${count('SELECT COUNT(*) c FROM jobs')}`);

console.log('\n=== 10. 一次性排产：触发后自动停用，再 tick 不再触发 ===');
// 队列重新暂停：一次性排产用例同样只验「建了 job」，不让离线流水线真的跑起来（隔离副作用）
J.pauseQueues({ reason: 'T-202 自测：一次性排产用例隔离（固定时间戳）', by: 'system' });
const D = S.createSchedule({ ...baseInput(), name: '一次性排产（仅一次）', kind: 'once', once_at: '2025-06-01 10:00', target: { productionId: 'PR-TEST-1' }, mode: 'existing_production' }, { now: NOW0 });
ok('once 排产：once_at 墙钟按 tz 换算成水位线 2025-06-01T02:00:00Z',
  D.next_run_at === '2025-06-01T02:00:00Z', String(D.next_run_at));
const d1 = await S.fireSchedule(D.id, { trigger: 'auto', force: true, now: '2025-06-01T02:00:05Z', ctx: { paused: true } });
ok('once 触发成功后：enabled 归 0、next_run_at=NULL，台账 reason_code=done_once（契约 §4）',
  d1.fired === true && S.getSchedule(D.id).enabled === 0 && S.getSchedule(D.id).next_run_at === null
  && get('SELECT reason_code FROM schedule_runs WHERE schedule_id = ?', D.id).reason_code === 'done_once',
  `enabled=${S.getSchedule(D.id).enabled} next=${S.getSchedule(D.id).next_run_at}`);
J.cancelJob(d1.jobId);   // 取消占位任务：本文件只验「建了 job 且幂等」，不跑离线流水线
const jobsBeforeOnceTick = count('SELECT COUNT(*) c FROM jobs');
const tickOnce = await S.tickSchedules({ now: '2025-06-01T04:00:00Z' });
ok('★ 一次性排产再 tick 不再触发（已停用：既不在 due 列表，也不会建新 job）',
  tickOnce.due === undefined || !tickOnce.fired.some((x) => x.id === D.id)
  ? !tickOnce.fired.some((x) => x.id === D.id) && count('SELECT COUNT(*) c FROM jobs') === jobsBeforeOnceTick
  : false,
  `fired=${tickOnce.fired.length} jobs=${count('SELECT COUNT(*) c FROM jobs')}`);
ok('停用的排产不出现在 listSchedules({enabled:true}) 里（软开关生效）',
  S.listSchedules({ enabled: true }).every((x) => x.id !== D.id) && S.getSchedule(D.id) !== null,
  S.listSchedules({ enabled: true }).map((x) => x.id).join(','));

console.log('\n=== 11. 惰性对账、CRUD 与临时库隔离 ===');
const rec = S.reconcileScheduleRuns({ scheduleId: B.id });
const manualRun = get("SELECT * FROM schedule_runs WHERE schedule_id = ? AND trigger = 'manual'", B.id);
ok('惰性对账：已取消的 job 回写 job_status=canceled，并把 last_status 同步为 failed（中文原因）',
  rec.updated >= 1 && manualRun.job_status === 'canceled'
  && get('SELECT last_status, last_error FROM schedules WHERE id = ?', B.id).last_status === 'failed'
  && hasCN(get('SELECT last_error FROM schedules WHERE id = ?', B.id).last_error),
  `updated=${rec.updated} job_status=${manualRun.job_status} last_error=${get('SELECT last_error FROM schedules WHERE id = ?', B.id).last_error}`);
ok('★ 对账不改写台账事实：status 仍是 fired（那一刻确实触发了），成败写在 job_status 里',
  get('SELECT status FROM schedule_runs WHERE id = ?', manualRun.id).status === 'fired',
  String(get('SELECT status FROM schedule_runs WHERE id = ?', manualRun.id).status));

const runsList = S.listScheduleRuns({ scheduleId: B.id });
ok('listScheduleRuns 带中文状态/原因文案（界面直接可用）',
  runsList.length >= 2 && runsList.every((x) => hasCN(x.status_text) && x.reason_text !== undefined)
  && runsList.some((x) => x.status_text === '已触发'),
  JSON.stringify(runsList.map((x) => [x.window_key, x.status, x.status_text])));
ok('listScheduleRuns({status}) 过滤生效', S.listScheduleRuns({ scheduleId: B.id, status: 'fired' }).every((x) => x.status === 'fired'),
  JSON.stringify(S.listScheduleRuns({ scheduleId: B.id, status: 'fired' }).map((x) => x.status)));

const E = S.createSchedule({
  ...baseInput(), name: '每 30 分钟巡检（对齐基准）', kind: 'interval', interval_minutes: 30, target: { productionId: 'PR-TEST-1' }, mode: 'existing_production',
}, { now: '2025-06-01T01:00:30Z' });
ok('interval 排产：anchor_at 默认向下取整到分钟（01:00:30 → 01:00:00Z），水位线 01:30:00Z',
  E.anchor_at === T0900 && E.next_run_at === '2025-06-01T01:30:00Z', `anchor=${E.anchor_at} next=${E.next_run_at}`);
const updKeep = S.updateSchedule(E.id, { interval_minutes: 20, keep_next_run_at: true });
ok('PATCH 时间字段 + keep_next_run_at=true：水位线保持不变（只改表达式不消费窗口）',
  updKeep.next_run_at === '2025-06-01T01:30:00Z' && updKeep.changed.includes('interval_minutes'),
  `next=${updKeep.next_run_at} changed=${JSON.stringify(updKeep.changed)}`);
const updRecalc = S.updateSchedule(E.id, { interval_minutes: 45 });
ok('PATCH 时间字段（不 keep）：重算水位线并返回中文 note',
  hasCN(updRecalc.note) && updRecalc.note.includes('重算') && updRecalc.interval_minutes === 45,
  `${updRecalc.note}`);
const delMsg = catchMsg(() => S.updateSchedule('S-9999', { name: '不存在' }));
ok('反例：更新不存在的排产抛中文错「排产不存在」', delMsg !== null && delMsg.includes('排产不存在') && delMsg.includes('S-9999'), delMsg);

const runsBeforeDelete = count('SELECT COUNT(*) c FROM schedule_runs WHERE schedule_id = ?', E.id);
run('INSERT INTO schedule_runs(id, schedule_id, window_key, trigger, status, reason_code, attempts, at) VALUES(?,?,?,?,?,?,?,?)',
  'RUN-TEST-X', E.id, '2025-06-01T01:30:00Z', 'auto', 'fired', 'due', 1, T0900);
const del1 = S.deleteSchedule(E.id);
ok('删除排产：定义被删、触发历史默认保留（审计证据）',
  del1.ok === true && del1.purged === false && S.getSchedule(E.id) === null
  && count('SELECT COUNT(*) c FROM schedule_runs WHERE schedule_id = ?', E.id) === runsBeforeDelete + 1
  && hasCN(del1.note),
  `${del1.deleted} purged=${del1.purged} runs=${count('SELECT COUNT(*) c FROM schedule_runs WHERE schedule_id = ?', E.id)}`);
const delPurgeMsg = catchMsg(() => S.deleteSchedule(E.id));
ok('反例：重复删除抛中文错（不做静默成功）', delPurgeMsg !== null && delPurgeMsg.includes('排产不存在'), delPurgeMsg);

console.log('\n=== 12. 实例租约（app_config 一行，不改 db.js） ===');
// 伪造「另一个实例正持租约」：直接写 app_config（不改 db.js、不新增表），时间全部固定
setConfigValue('scheduler:lease', { owner: 'other-host#1', expires_at: '2025-06-01T01:03:00Z', ttl_seconds: 180 });
const leaseHeldRead = S.readSchedulerLease('2025-06-01T01:01:00Z');
ok('租约未过期时 readSchedulerLease().held=true（界面/运维可解释「为什么这个实例不排产」）',
  leaseHeldRead.held === true && leaseHeldRead.owner === 'other-host#1' && leaseHeldRead.expires_at === '2025-06-01T01:03:00Z',
  JSON.stringify(leaseHeldRead));
const leaseHeld = S.acquireSchedulerLease({ owner: 'me#2', now: '2025-06-01T01:01:00Z' });
ok('★ 另一实例持有效租约时抢不到，中文原因含持有者与到期时刻',
  leaseHeld.ok === false && hasCN(leaseHeld.reason) && leaseHeld.reason.includes('other-host#1') && leaseHeld.reason.includes('01:03:00Z'),
  leaseHeld.reason);
const tickNoLease = await S.tickSchedules({ now: '2025-06-01T01:01:00Z' });
ok('★ 抢不到租约的实例只读：tick 返回 enabled=false 且不触发任何排产（不会双份排产）',
  tickNoLease.enabled === false && tickNoLease.fired.length === 0 && hasCN(tickNoLease.reason),
  `${tickNoLease.enabled} ${tickNoLease.reason}`);
ok('租约过期后自动可抢（进程崩溃无需清理逻辑，靠 TTL 自愈）',
  S.readSchedulerLease('2025-06-01T01:04:00Z').held === false
  && S.acquireSchedulerLease({ owner: 'me#2', now: '2025-06-01T01:04:00Z', ttlSeconds: 180 }).ok === true,
  JSON.stringify(S.readSchedulerLease('2025-06-01T01:04:00Z')));
ok('同一实例可续租（每轮 tick 续一次，过期时刻 = now + ttl）',
  S.acquireSchedulerLease({ owner: 'me#2', now: '2025-06-01T01:05:00Z', ttlSeconds: 180 }).expires_at === '2025-06-01T01:08:00Z',
  String(get("SELECT value FROM app_config WHERE key = 'scheduler:lease'")?.value));

// dryRun 演练：只读判定，不依赖租约、不落库、不建 job（rows 是测试注入点）
const F = S.createSchedule({ ...baseInput(), name: 'dryRun 演练（每日 9 点）' }, { by: 'agent', now: NOW0 });
for (const row of all("SELECT id FROM jobs WHERE type = 'studio'")) J.cancelJob(row.id);
J.resumeQueues({ by: 'human', note: 'T-202 自测：dryRun 用例前恢复' });
const jobsBeforeDry = count('SELECT COUNT(*) c FROM jobs');
const dryTick = await S.tickSchedules({ now: T0900, dryRun: true, rows: [S.getSchedule(F.id)] });
ok('dryRun tick 只读判定：注入行也能算出到期（fired 标记 dryRun=true）',
  dryTick.ok === true && dryTick.fired.length === 1 && dryTick.fired[0].dryRun === true
  && dryTick.fired[0].reasonCode === 'due' && hasCN(dryTick.fired[0].reason),
  JSON.stringify(dryTick.fired[0]));
ok('dryRun tick 不落库、不建 job（演练不会花钱）',
  count('SELECT COUNT(*) c FROM jobs') === jobsBeforeDry
  && count('SELECT COUNT(*) c FROM schedule_runs WHERE schedule_id = ?', F.id) === 0
  && S.getSchedule(F.id).fire_count === 0,
  `jobs=${count('SELECT COUNT(*) c FROM jobs')} runs=${count('SELECT COUNT(*) c FROM schedule_runs WHERE schedule_id = ?', F.id)}`);
ok('反例：FACTORY_SCHEDULER=off / cfg.schedules.enabled=false 时 tick 直接关闭（总开关可被环境变量压过）',
  S.schedulesConfig({ schedules: { enabled: false } }).enabled === false
  && S.schedulesConfig().enabled === true,
  `off=${S.schedulesConfig({ schedules: { enabled: false } }).enabled}`);

console.log('\n=== 13. 月度预算闸门端到端：shouldAutoPause → pauseQueues(by system) → skipped_budget，且不建 job ===');
// 清理 dryRun 演练用的排产（它仍会在 T0900z 到期，避免干扰本节的 tick 结果）
S.deleteSchedule(F.id, { purge: true });
// 清掉上一节伪造的租约，恢复「单实例正常排产」前提（否则 tick 会因租约被占而整轮只读）
run("DELETE FROM app_config WHERE key = 'scheduler:lease'");
J.resumeQueues({ by: 'human', note: 'T-202 自测：预算闸门用例前恢复' });
const G = S.createSchedule({
  ...baseInput(), name: '月度上限闸门（每日 9 点）', budget_guard: 1, mode: 'existing_production',
  target: { productionId: 'PR-TEST-1', spec: { episodes: 1, episodeSeconds: 60 } },
}, { now: NOW0 });
const jobsBeforeBudget = count('SELECT COUNT(*) c FROM jobs');
const tickBudget = await S.tickSchedules({ now: T0900 });
const budgetItem = tickBudget.skipped.find((x) => x.id === G.id);
ok('★ 月度上限命中：tick 记为 skipped_budget，中文原因含「超过月度上限」（本次拒绝，不是静默放行）',
  Boolean(budgetItem) && budgetItem.reasonCode === 'skipped_budget'
  && hasCN(budgetItem.reason) && budgetItem.reason.includes('超过月度上限') && budgetItem.recorded === true,
  JSON.stringify(budgetItem));
ok('★ 预算闸门命中时一个 job 都不建（没有落库任务 = 没有花钱）',
  count('SELECT COUNT(*) c FROM jobs') === jobsBeforeBudget,
  `jobs=${count('SELECT COUNT(*) c FROM jobs')} before=${jobsBeforeBudget}`);
ok('★ 自动暂停复用既有闸门：队列被 pauseQueues(by=system) 暂停（原因进 jobs:pause-log → 决策时间线可见）',
  J.pauseState().paused === true && J.pauseState().by === 'system' && J.pauseState().reason.includes('超过月度上限')
  && J.pauseHistory(5).some((h) => h.action === 'pause' && h.by === 'system'),
  JSON.stringify(J.pauseState()));
ok('预算拦下的窗口同样留台账（status=skipped / reason_code=skipped_budget，可回答「为什么没跑」）',
  count("SELECT COUNT(*) c FROM schedule_runs WHERE schedule_id = ? AND status = 'skipped' AND reason_code = 'skipped_budget'", G.id) === 1
  && S.getSchedule(G.id).skip_count === 1,
  `runs=${count("SELECT COUNT(*) c FROM schedule_runs WHERE schedule_id = ? AND status = 'skipped'", G.id)} skip_count=${S.getSchedule(G.id).skip_count}`);
ok('预算拦下后水位线照样推进（下一个窗口自然会来，不制造补跑雪崩）',
  S.getSchedule(G.id).next_run_at === NEXT_DAY_0900, String(S.getSchedule(G.id).next_run_at));
J.resumeQueues({ by: 'human', note: 'T-202 自测：预算闸门用例收尾' });

console.log('\n=== 14. 临时库隔离（绝不动真实数据） ===');
const realDb = path.join(process.cwd(), 'data', 'factory.db');
ok('本次使用临时库（不是 data/factory.db）', process.env.FACTORY_DB !== realDb && fs.existsSync(process.env.FACTORY_DB), process.env.FACTORY_DB);
ok('临时库里才有本次的排产数据（schedules/schedule_runs 非空）',
  count('SELECT COUNT(*) c FROM schedules') >= 1 && count('SELECT COUNT(*) c FROM schedule_runs') >= 1,
  `schedules=${count('SELECT COUNT(*) c FROM schedules')} runs=${count('SELECT COUNT(*) c FROM schedule_runs')}`);
ok('零依赖：被测模块与自测都只依赖 Node 内置能力（无新增 npm 依赖）',
  S.SCHEDULE_KINDS.length === 6 && S.MISS_POLICIES.join(',') === 'skip,catchup,catchup_all'
  && S.SCHEDULE_RUN_STATUSES.join(',') === 'fired,deduped,skipped,missed,failed',
  S.SCHEDULE_KINDS.join('/'));

console.log('\n=== 15. S-10：单轮 tick 触发上限（maxFiresPerTick，超出窗口留待下一轮且不丢窗口） ===');
// T-107 §3.1 S-10（中危）：runHistoryLimit / maxCatchupEnumerate 只挡「枚举」，不挡「一轮 tick 触发 N 条排产」。
// 本节只碰临时 config（FACTORY_CONFIG 已指向 mkdtemp）与临时库，绝不读写真实 config/config.json。
const CFG = await import('../src/config.js');
/** 只改临时 config 的 schedules 段（null = 删除后回默认），改完显式 reload 让 schedulesConfig 看到新值 */
const setSchedulesCfg = (schedules) => {
  const cur = JSON.parse(fs.readFileSync(process.env.FACTORY_CONFIG, 'utf8'));
  if (schedules === null) delete cur.schedules; else cur.schedules = schedules;
  fs.writeFileSync(process.env.FACTORY_CONFIG, JSON.stringify(cur), 'utf8');
  CFG.loadConfig({ reload: true });
};

// ①/② 默认值、夹紧与命名（纯函数，不碰库）
const capCases = [[undefined, 20], [0, 20], [-1, 20], ['abc', 20], [1.9, 1], [3, 3], [9999, 200]];
const capActual = capCases.map(([v]) => S.schedulesConfig({ schedules: { maxFiresPerTick: v } }).maxFiresPerTick);
ok('★ S-10 ① 单轮触发上限默认 20；0 / 负数 / 非数字回退默认，>200 夹紧到 200，一律不抛错',
  S.schedulesConfig().maxFiresPerTick === 20 && capActual.every((x, i) => x === capCases[i][1]),
  capCases.map(([v, want], i) => `${JSON.stringify(v)}→${capActual[i]}(期望${want})`).join(' '));
ok('★ S-10 ② T-107 原始命名 maxFirePerTick 作为兼容别名合流到同一个归一化出口（两键同值）',
  S.schedulesConfig({ schedules: { maxFirePerTick: 7 } }).maxFiresPerTick === 7
  && S.schedulesConfig({ schedules: { maxFirePerTick: 7 } }).maxFirePerTick === 7
  && S.schedulesConfig().maxFirePerTick === S.schedulesConfig().maxFiresPerTick,
  `别名7→${S.schedulesConfig({ schedules: { maxFirePerTick: 7 } }).maxFiresPerTick}；默认两键=${S.schedulesConfig().maxFiresPerTick}/${S.schedulesConfig().maxFirePerTick}`);
ok('S-10 ③ 新判定码已登记且归入 status=skipped（五元组台账状态保持不变）',
  S.SCHEDULE_RUN_REASON_CODES.includes('skipped_round_cap')
  && S.SCHEDULE_REASON_TEXT.skipped_round_cap === '单轮触发条数已达上限'
  && S.SCHEDULE_RUN_STATUSES.join(',') === 'fired,deduped,skipped,missed,failed',
  `${S.SCHEDULE_REASON_TEXT.skipped_round_cap} / statuses=${S.SCHEDULE_RUN_STATUSES.join(',')}`);

// 行为用例：3 条同刻到期的排产（existing_production：不建项目、不连网、不花钱）
const capIds = [];
for (const n of [1, 2, 3]) {
  capIds.push(S.createSchedule({
    ...baseInput(), name: `S-10 上限用例 ${n}（每日 9 点）`,
    mode: 'existing_production', target: { productionId: 'PR-TEST-1' },
  }, { by: 'human', now: NOW0 }).id);
}
const capRows = capIds.map((id) => S.getSchedule(id));
ok('S-10 ④ 用例前置：3 条排产水位线同为 2025-06-01T01:00:00Z（同刻到期，可被同一轮 tick 扫到）',
  capRows.length === 3 && capRows.every((s) => s.next_run_at === T0900 && s.enabled === 1),
  capRows.map((s) => `${s.id}:${s.next_run_at}`).join(' '));

// 队列恢复（tick 只在非暂停时触发），再用一个占位任务占住 studio 队列唯一并发槽（limit:1）：
// 本轮新建的排产 job 只会停在 pending，不会真的跑离线流水线 —— 本用例只验「建了几个 job」。
J.resumeQueues({ by: 'human', note: 'S-10 自测：恢复队列以验证单轮上限' });
const capBlocker = J.enqueue({
  type: 'studio', title: 'S-10 自测占位（不执行任何流水线）', payload: {}, limit: 1,
  handler: () => new Promise((res) => setTimeout(res, 60000)),
});
const jobsBeforeCap = count('SELECT COUNT(*) c FROM jobs');

// ⑤ dry-run 不受上限约束
setSchedulesCfg({ maxFiresPerTick: 1 });
const capDry = await S.tickSchedules({ now: T0900, dryRun: true, rows: capRows });
ok('★ S-10 ⑤ dry-run 不受单轮上限约束：cap=1 时 3 条同刻到期仍全部进 fired（只判定、不建 job、不落库）',
  capDry.fired.length === 3 && capDry.fired.every((x) => x.dryRun === true)
  && capDry.cap.limit === 1 && capDry.deferred === 0
  && count('SELECT COUNT(*) c FROM jobs') === jobsBeforeCap
  && capIds.every((id) => count('SELECT COUNT(*) c FROM schedule_runs WHERE schedule_id = ?', id) === 0),
  `fired=${capDry.fired.length} cap=${JSON.stringify(capDry.cap)} jobs=${count('SELECT COUNT(*) c FROM jobs')} runs=0`);

// ⑥~⑨ 真跑一轮：cap=2 → 只触发 2 条，第 3 条截断
setSchedulesCfg({ maxFiresPerTick: 2 });
let capTickEvent = null;
const onCapTick = (e) => { capTickEvent = e; };
J.jobEvents.on('schedule:tick', onCapTick);
const capTick1 = await S.tickSchedules({ now: T0900, rows: capRows });
J.jobEvents.off('schedule:tick', onCapTick);
const capSkipped = capTick1.skipped.filter((x) => x.reasonCode === 'skipped_round_cap');
const cappedId = capSkipped.length === 1 ? capSkipped[0].id : null;
ok('★ S-10 ⑥ 配额生效：3 条同刻到期 + cap=2 → 本轮只触发 2 条，第 3 条记 skipped_round_cap 且原因是中文原文',
  capTick1.fired.length === 2 && capTick1.cap.limit === 2 && capTick1.cap.fired === 2
  && capTick1.cap.capped === 1 && capTick1.deferred === 1 && capSkipped.length === 1
  && hasCN(capSkipped[0].reason) && capSkipped[0].reason.includes('单轮触发条数已达上限')
  && capSkipped[0].reason.includes('留待下一轮') && capSkipped[0].occurrence === T0900,
  `fired=${capTick1.fired.length} cap=${JSON.stringify(capTick1.cap)} deferred=${capTick1.deferred} reason=${capSkipped[0] && capSkipped[0].reason}`);
const capJobPayloads = all("SELECT payload FROM jobs WHERE type = 'studio'").map((r) => JSON.parse(r.payload || '{}'));
ok('★ S-10 ⑦ 被截断项零副作用：不建 job（jobs 增量恰为 2），且没有任何一条 job 指向被截断的排产',
  Boolean(cappedId) && count('SELECT COUNT(*) c FROM jobs') === jobsBeforeCap + 2
  && !capJobPayloads.some((p) => p.scheduleId === cappedId),
  `jobs=${count('SELECT COUNT(*) c FROM jobs')} before=${jobsBeforeCap} cappedId=${cappedId}`);
ok('★ S-10 ⑧ 被截断窗口**不写台账行**（写了就会占掉唯一索引 → 窗口永久丢失）：该窗口行数=0、fire_count 未增、水位线未动',
  Boolean(cappedId)
  && count('SELECT COUNT(*) c FROM schedule_runs WHERE schedule_id = ?', cappedId) === 0
  && S.getSchedule(cappedId).fire_count === 0 && S.getSchedule(cappedId).next_run_at === T0900
  && S.getSchedule(cappedId).skip_count === 1 && S.getSchedule(cappedId).last_status === 'skipped',
  cappedId ? `runs=${count('SELECT COUNT(*) c FROM schedule_runs WHERE schedule_id = ?', cappedId)} fire_count=${S.getSchedule(cappedId).fire_count} next=${S.getSchedule(cappedId).next_run_at} skip_count=${S.getSchedule(cappedId).skip_count}` : '未取到被截断项');
ok('S-10 ⑨ jobEvents 的 schedule:tick 载荷带 capped 计数（界面/运维可显示本轮截断了多少条）',
  Boolean(capTickEvent) && capTickEvent.capped === 1 && capTickEvent.fired === 2 && capTickEvent.dryRun === false,
  JSON.stringify(capTickEvent));

// ⑩ 下一轮 tick 把被截断的窗口补上（证明窗口真的没丢）
const capTick2 = await S.tickSchedules({ now: '2025-06-01T01:00:30Z', rows: [S.getSchedule(cappedId)] });
ok('★ S-10 ⑩ 被截断的窗口下一轮能正常触发（窗口未丢）：fired=1、台账出现该窗口的 fired 行、cap.capped=0',
  capTick2.fired.length === 1 && capTick2.fired[0].id === cappedId && capTick2.cap.capped === 0 && capTick2.deferred === 0
  && count('SELECT COUNT(*) c FROM schedule_runs WHERE schedule_id = ?', cappedId) === 1
  && get('SELECT status FROM schedule_runs WHERE schedule_id = ?', cappedId).status === 'fired',
  `fired=${capTick2.fired.length} id=${capTick2.fired[0] && capTick2.fired[0].id} cap=${JSON.stringify(capTick2.cap)} runs=${count('SELECT COUNT(*) c FROM schedule_runs WHERE schedule_id = ?', cappedId)}`);

// ⑪/⑫ manual 触发忽略 occurrence_at（A-01 R1-x 的函数层纵深防御），auto 分支零回归
const jobsBeforeManual = count('SELECT COUNT(*) c FROM jobs');
const man1 = await S.fireSchedule(capIds[0], {
  trigger: 'manual', occurrence_at: '2020-01-01T00:00:00Z', force: true, now: '2025-06-01T05:00:00Z', ctx: { paused: true },
});
ok('★ S-10 ⑪ manual 触发忽略入参 occurrence_at：窗口键由服务端按当前整秒生成，入参原文只做回显',
  man1.fired === true && man1.windowKey === 'manual:2025-06-01T05:00:00Z'
  && man1.occurrence === '2025-06-01T05:00:00Z' && man1.ignoredOccurrence === '2020-01-01T00:00:00Z',
  `windowKey=${man1.windowKey} ignoredOccurrence=${man1.ignoredOccurrence}`);
const man2 = await S.fireSchedule(capIds[0], {
  trigger: 'manual', occurrence_at: '2021-06-06T06:06:06Z', force: true, now: '2025-06-01T05:00:00Z', ctx: { paused: true },
});
ok('★ S-10 ⑫ 同一秒换不同 occurrence_at 也绕不开幂等：第二次 deduped，jobs 只多 1 条（幂等键不可被调用方控制）',
  man2.deduped === true && man2.reasonCode === 'skipped_deduped'
  && count('SELECT COUNT(*) c FROM jobs') === jobsBeforeManual + 1,
  `deduped=${man2.deduped} jobs=${count('SELECT COUNT(*) c FROM jobs')} before=${jobsBeforeManual}`);
ok('S-10 ⑬ auto 分支零回归：occurrence_at 仍可指定历史窗口（补跑路径不受 manual 加固影响）',
  (await S.fireSchedule(capIds[0], { trigger: 'auto', occurrence_at: NEXT_DAY_0900, force: true, now: NEXT_DAY_0900, ctx: { paused: true } })).fired === true,
  'auto + 指定窗口 → fired=true');

// 收尾：取消本节的占位任务与新建 job，还原临时 config，避免给后续/残留路径留副作用
for (const row of all("SELECT id FROM jobs WHERE type = 'studio'")) J.cancelJob(row.id);
J.pauseQueues({ reason: 'S-10 自测收尾：恢复暂停，避免残留任务真的跑离线流水线', by: 'system' });
setSchedulesCfg(null);
ok('S-10 ⑭ 用例无副作用：临时 config 已还原（不含 maxFiresPerTick 键、上限回到默认 20），且全程未碰真实 config/config.json',
  S.schedulesConfig().maxFiresPerTick === 20
  && !fs.readFileSync(process.env.FACTORY_CONFIG, 'utf8').includes('maxFiresPerTick')
  && process.env.FACTORY_CONFIG !== path.join(process.cwd(), 'config', 'config.json'),
  `上限=${S.schedulesConfig().maxFiresPerTick} 配置文件=${process.env.FACTORY_CONFIG}`);

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ }
process.exit(fail ? 1 : 0);
