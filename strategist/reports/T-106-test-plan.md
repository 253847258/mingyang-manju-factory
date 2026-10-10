# T-106 测试计划：五条新线验收用例矩阵 + 既有 2098 项断言的回归策略

> 任务卡：`strategist/tasks/T-106.yaml`（角色：测试/安全/红队军师；类型：只读分析 + 报告）
> 写入范围：仅本文件（`strategist/reports/T-106-test-plan.md`）
> 依赖契约：`T-101-schedules-spec.md`、`T-102-selfheal-spec.md`、`T-103-canvas-select-spec.md`、`T-104-subtitle-wrap-spec.md`、`T-105-canvas-perf-spec.md`（均已逐节通读）
> 状态：**测试计划（待实现卡落地后执行）**
> 本卡未改动任何源码、未新增依赖、未启动/重启服务、未运行 `./scripts/verify-all.sh`。

---

## 0. 一页速览

| 线 | 上游契约 | 实现卡 | 测试卡 | 测试文件 | 本计划用例数 | 是否花钱 | 回归辐射面 |
|---|---|---|---|---|---|---|---|
| **A 定时排产** | T-101（827 行） | T-201 `src/schedules.js` | T-202 | `tests/test-schedules.js` | **24** | 间接（触发的 studio 任务会花钱，测试必须离线） | 中（新增文件 + `server.js` 一行注册） |
| **B 阶段失败自愈** | T-102（695 行） | T-203 | T-204 | `tests/test-selfheal.js` | **21** | **是**（换后端 = 再生成一次） | **高**（改 `graph.js`/`render.js`/`studio.js`/`decisions.js`/`config.js`/`routes/render.js`/`mcp-tools.js`） |
| **C 画布筛选与批处理** | T-103（1003 行） | T-205 `web/lib/canvas-select.js` | T-206 | `tests/canvas-select.test.mjs` | **30**（筛选 12 + 批处理 15 + 撤销/快照 3） | 部分是（`rerun-kinds`） | **高**（改 `web/views/actors.js`，Python 审计 177+172 项依赖它） |
| **D 字幕换行与安全区** | T-104（565 行） | T-207 | T-208 | `tests/test-subtitle-wrap.js` | **19** | 否 | 中（改 `src/subtitles.js`/`src/finish.js`/`src/config.js`，影响交付包/QC/发布物） |
| **E 画布性能纯逻辑** | T-105（459 行） | T-209 `web/lib/canvas-perf.js` | T-210 | `tests/canvas-perf.test.mjs` | **18** | 否 | 低（零接线，`actors.js` 必须零改动） |
| **合计** | 5 份契约（3549 行） | 5 个新模块 | 5 个测试卡 | 5 个新套件 | **112** | — | 辐射 25 个阶段中的 **22** 个（仅模块2/模块3/画布资产桥 三个阶段无关） |

**三条本计划的核心判断（可被证伪，见 §8）**
1. **五条线里只有 B 与 C 的 `rerun-kinds` 会真实扣费**。因此「离线假实例 + 生成调用计数」是这两条线唯一的验收手段；任何需要真实后端才能跑的断言都不算验收证据。
2. **D 与 E 的验收底线是「零行为变化」**，不是「新功能好用」。D 的 `legacy` 默认、E 的 `pad=50`/LOD 阈值/闭区间裁剪，都必须有**反例断言**把「顺手优化」钉死；只测新功能会漏掉真实风险。
3. **2098 项断言必须全绿**，但本计划**不要求**跑 `./scripts/verify-all.sh`（任务铁律：太重、并发冲突）。替代方案是 §7.3 的**分层门禁**：新测试各自 `node tests/xxx.js` 退出码为 0，既有套件按「辐射面」抽跑，Python 审计在验收波次单线程只读跑。

---

## 1. 通用约定（五条线的新测试**一律**遵守）

### 1.1 环境隔离模板（照抄 `tests/test-jobs.js:1-25`、`tests/test-graph.js:10-30`）

所有涉及建表/落库的测试（A/B/C/D）**必须先设 env 再动态 import**：

```js
// ---- 环境隔离：临时数据目录 + 临时库 + 临时配置（强制 placeholder 后端，杜绝任何真实网络/计费）----
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-<线名>-'));
const DB = path.join(TMP, '<线名>.db');
const DATA_TMP = path.join(TMP, 'data');
const CFG = path.join(TMP, 'config.json');
fs.mkdirSync(DATA_TMP, { recursive: true });
fs.writeFileSync(CFG, JSON.stringify({
  image: { backend: 'placeholder', retries: 0, retryBaseMs: 0 },
  video: { backend: 'placeholder', retries: 0, retryBaseMs: 0 },
  llm: { provider: 'mock' },
}), 'utf8');
process.env.FACTORY_DATA_DIR = DATA_TMP;
process.env.FACTORY_DB = DB;
process.env.FACTORY_CONFIG = CFG;

const { migrate, get, all, run, ROOT } = await import('../src/db.js');   // ⚠️ 必须先设 env 再 import
migrate();
```

**每个套件必须自带「未触碰真实库」自检**（两条既有写法任选其一，`tests/test-graph.js:104` / `tests/test-mcp.js:115`）：

```js
ok('未触碰真实库 data/factory.db',
  path.resolve(String(process.env.FACTORY_DB)) !== path.resolve(ROOT, 'data', 'factory.db'),
  `FACTORY_DB=${process.env.FACTORY_DB}`);
```

纯函数测试（C 的筛选谓词、D 的断行、E 的全部）**不需要**临时库，直接相对路径 `import` 即可（先例：`tests/test-novel.js:535/542` 直接 `import('../web/views/novel.js')`、`import('../web/lib/api.js')`）。

### 1.2 断言风格（全项目不用 `node:test`）

```js
let pass = 0, fail = 0;
const ok = (name, cond, evidence = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${evidence ? `  ← ${evidence}` : ''}`); }
  else { fail++; console.error(`  ✗ ${name}  ← ${evidence}`); }
};
const eq = (name, actual, expected) => ok(name, actual === expected, `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`);

// 末尾（照抄 tests/test-jobs.js 尾部）
console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ }
process.exit(fail ? 1 : 0);
```

**硬性要求**：
- `fail > 0` 必须 `exit 1`（否则 `verify-all.sh` 的 `run()` 会把它判成通过）。
- 输出末尾必须有 `=== 结果：N 通过 / M 失败 ===` 且 `M === 0` —— 这是本计划唯一的「绿」定义。
- **每条用例名必须是中文**（便于红队按名反查），失败时必须打印期望值与实际值（`evidence` 参数不得为空）。

### 1.3 禁用清单（「假绿」手法，任一出现即判该测试无效）

| # | 禁止 | 为什么 | 门禁 |
|---|---|---|---|
| J1 | `try/catch` 把断言异常吞成「通过」 | 让崩溃看起来像正常 | 断言抛错必须冒泡到顶层；只允许对**被测函数自身**做 try/catch 并断言抛出的中文消息 |
| J2 | 环境缺失时 `skip` 并计入通过 | 「没跑」≠「通过」 | 缺依赖/缺文件必须 `exit 1` 并打印中文原因 |
| J3 | 只断言 `pass` 计数变大、不校验内容 | 空断言也能刷数 | 只允许断言**具体值**（相等/包含正则/抛错消息） |
| J4 | 用被测模块自己算期望值（同源比对） | 循环论证 | 期望值必须来自契约文档（如 T-101 §6 的 DST 基准表、T-105 §3.2 的解析表）或独立常量 |
| J5 | 把既有测试期望改小/改宽以凑绿 | 铁律明令禁止 | §7.4 的「断言计数守恒」检查 |
| J6 | 用「或真值兜底」、`tail` 截断输出、命令末尾追加 `echo ok` 等方式掩盖退出码 | 掩盖失败 | 命令必须原样给出退出码（`node tests/x.js; echo "exit=$?"`），不得接管道或或运算 |
| J7 | 为了让断言过而把生产默认值改成测试友好值 | 反向污染 | D/E 两线必须显式断言「默认值仍是 legacy/false」 |
| J8 | 改 `scripts/verify-all.sh` 增删阶段 | 集成线独占文件 | 只读 |

### 1.4 命名与路径（三处**契约冲突**必须先裁决，否则测试会「测到空气」）

通读五份契约与任务卡后，发现三处**卡面与契约不一致**。这三处不裁决，测试会 `import` 到一个不存在的模块 → `undefined` → 若断言写法不严会**假通过**（见 §8 RT-15）。

| # | 冲突 | 任务卡写法 | 冻结契约写法 | 本计划建议 | 理由 |
|---|---|---|---|---|---|
| N1 | 自愈模块名 | T-203：`src/self-heal.js` | T-102 §4.1/§8.1：`src/selfheal.js` | **以契约为准 `src/selfheal.js`**，测试首个断言就是「导出存在性」 | 契约是「冻结稿」，且 §8.3 的测试清单逐条引用 `planSelfHeal` 等签名；卡面只是标题 |
| N2 | 断行模块落点 | T-207：新文件 `src/subtitle-wrap.js` | T-104 §2.1：**改既有** `src/subtitles.js`（该文件已零 import，是排版口径归属地） | **以契约为准**：导出在 `src/subtitles.js`。若实现方另建 `src/subtitle-wrap.js`，测试应 `import` 契约路径并在报告里记为偏差 | §1.4 的 3 条进入路径分析决定了它必须被 `finish.js` 单向依赖；新建文件会让依赖图多一跳且与 `qc.js` 的动态 import 口径分叉 |
| N3 | 测试文件扩展名 | T-206/T-210：`.test.mjs` | 全仓库 22 个既有测试**均为 `.js`**，且 `package.json` 为 `"type": "module"`（`.js` 本身就是 ESM） | 两种都能跑；**建议统一 `.mjs` 不变**（卡面已指定，`type:module` 下无风险），但必须在 `verify-all.sh` 增阶段时写对文件名 | `node tests/canvas-perf.test.mjs` 在 `type:module` 下正常；风险仅在「忘了加进 verify-all.sh」 |

### 1.5 evidence（证据）格式要求

每个实现卡交付时必须贴**原始输出尾部**（不是转述），格式：

```bash
cd /home/linsheng/Desktop/ai-video-factory
node tests/<套件>.js; echo "exit=$?"
# 输出尾部至少包含：
#   === 结果：NNN 通过 / 0 失败 ===
#   exit=0
```

**禁止**在 evidence 里贴「我确认通过」这类不可复核的句子。红队复核时只用 `node tests/<套件>.js; echo "exit=$?"` 一条命令。

---

## 2. 线 A：定时排产（T-201 → `tests/test-schedules.js`）

### 2.1 被测面（T-101 §3 的导出清单，测试必须逐名断言存在）

常量：`SCHEDULE_KINDS`(6) / `MISS_POLICIES`(3) / `SCHEDULE_RUN_STATUSES`(5) / `SCHEDULE_RUN_REASON_CODES`(15) / `SCHEDULE_DEFAULTS`
纯函数：`zonedParts` `zonedToUtc` `formatInTz` `isoSeconds` `windowKeyOf` `idemKeyOf` `parseCron` `cronMatches` `nextOccurrence` `nextRuns` `evaluateSchedule` `tickSchedules` `scheduleSummary`
写库/服务：`ensureSchedulesSchema` `schedulesConfig` `fireSchedule` `listSchedules` `getSchedule` `createSchedule` `updateSchedule` `deleteSchedule` `listScheduleRuns` `enqueueScheduledRun` `startScheduler` `readSchedulerLease` `acquireSchedulerLease` `reconcileScheduleRuns`

**注入点（这是本线能离线测的关键）**：`tickSchedules({ now, dryRun, rows })` 的 `rows` 允许直接喂 schedule 行，**不需要插库**即可测纯判定（T-101 §11）。

### 2.2 用例矩阵（24 条）

| # | 用例名（中文） | 输入 / 构造 | 期望（可断言） | 类型 |
|---|---|---|---|---|
| A01 | 导出清单逐名存在 | `import('../src/schedules.js')` | 上列 27 个名字的 `typeof` 分别是 `function`/`object`；`SCHEDULE_KINDS.length===6`、`SCHEDULE_RUN_STATUSES` 深等于 `['fired','deduped','skipped','missed','failed']` | 护栏 |
| A02 | 建表幂等 | 连调 `ensureSchedulesSchema()` 两次 | 第一次 `true`、第二次 `false`；`sqlite_master` 里 `schedules`/`schedule_runs` 与 2+4 个索引存在 | 正例 |
| A03 | 每日 09:00 上海的下一次触发 | `daily/at_time='09:00'/tz='Asia/Shanghai'`，`after='2025-05-31T23:00:00Z'` | `nextOccurrence(...).at === '2025-06-01T01:00:00Z'`（T-101 §11-1） | 正例 |
| A04 | 春季夏令时跳变（本地时刻不存在） | `America/New_York`，`zonedToUtc('2025-03-09 02:30')` | `2025-03-09T07:30:00Z`，`note` 含「已顺延」 | 边界 |
| A05 | 秋季夏令时重叠（同墙钟出现两次） | `America/New_York`，`zonedToUtc('2025-11-02 01:30')` | `2025-11-02T05:30:00Z`（取**较早**一次） | 边界 |
| A06 | 无 DST 时区固定偏移 | `Asia/Shanghai 2025-01-01 00:00` | `2024-12-31T16:00:00Z` | 正例 |
| A07 | DST 周水位线单调递增 | `daily 09:00 America/New_York`，从 `3-08` 扫到 `3-11` | 三次 `nextOccurrence` 结果**严格递增**；相邻间隔出现 23h（跳变日）与 25h（重叠日） | 边界 |
| A08 | 无效时区抛中文错误 | `createSchedule({tz:'Bad/Zone'})` 与 `zonedParts(new Date(), 'Bad/Zone')` | 抛 `Error`，消息匹配 `/无效时区：Bad\/Zone（请用 IANA 名称/`；且 `schedules` 表行数不变 | 中文报错 |
| A09 | cron 周字段边界与 `7`=周日归一 | `parseCron('0 9 * * 8')` / `parseCron('0 9 * * 7')` | 前者 `{ok:false}`，`error` 含「周字段超出范围 0-6」；后者 `ok:true` 且 `sets.weekdays` 含 `0` | 边界 |
| A10 | cron 不支持秒级 / 宏 / 名称（反例） | `'0 0 9 * * *'`、`'@daily'`、`'0 9 * * MON'` | 三条都 `{ok:false}` 且 `error` 中文；**不得**静默忽略（不得返回 `ok:true`） | 反例 |
| A11 | cron 日/周同时受限 = OR 语义 | `cronMatches` 于 `'0 9 1 * 1'`：分别取「只有 1 号」「只有周一」「两者都不是」的日期 | 前两个 `true`，第三个 `false`（Vixie 语义，易错点） | 边界 |
| A12 | `monthly` 无 31 号的月份被跳过 | `monthly/day_of_month=31`，从 `2025-02-01` 起 | 下一次落在 `2025-03-31`，**不**顺延到 `2-28`；`scheduleSummary` 里写明该语义 | 边界 |
| A13 | `interval` 对齐 anchor（重启不漂移） | `interval_minutes=30`，`anchor_at` 为整点，抖动 ±7 分钟多次求下一次 | 所有结果 ≡ `anchor + k*30min`（取模 0），不随抖动累积漂移 | 边界 |
| A14 | 宽限内算准点 / 宽限外算错过（±1 分钟） | `grace_min=5`；延迟 4 分钟 与 延迟 6 分钟各一次 `evaluateSchedule` | 4 分钟 → `due:true`；6 分钟 → `due:false`（按策略） | 边界 |
| A15 | `skip` 策略下停机 3 天 | 3 个到期窗口，`miss_policy='skip'`，非宽限 | 返回 `skipped_missed`；`miss === 3`；`next_run_at` 推进到最新窗口之后；`schedules.miss_count += 3` | 反例 |
| A16 | `catchup` 只补最近 1 个 | 同上，`miss_policy='catchup'` | `occurrence` = **最新**窗口；`dropped.length === k-1` | 正例 |
| A17 | `catchup_all` 受 `catchup_max` 截断 | 5 个窗口，`catchup_all` + `catchup_max=2` | `occurrence` = 倒数第 2 个（`occurrences[k-n]`，保证顺序）；`miss === 3` | 边界 |
| A18 | `maxCatchupScan=64` 截断计数 | 构造 100 个到期窗口（`interval_minutes=1`，停机 100 分钟） | `truncated === 36`，枚举不跑飞（函数在毫秒级返回，断言耗时不作为硬指标） | 边界 |
| A19 | 同窗口重复触发幂等（唯一索引） | 同一 `(schedule_id, window_key, trigger)` 连调两次 `fireSchedule` | 第 2 次 `{fired:false, deduped:true, reasonCode:'skipped_deduped'}`；`schedule_runs` 该窗口**只 1 行**；`jobs` 只 **+1** | 护栏 |
| A20 | 并发抢同一窗口只建 1 个 job | `Promise.all([fireSchedule(id), fireSchedule(id)])` | `jobs` 行数增量 `=== 1`（唯一索引是原子去重手段） | 护栏 |
| A21 | 暂停期间不建 job、恢复后默认不补跑 | 先 `pauseQueues()`，再 tick（有到期窗口），再 `resumeQueues()` 再 tick | ① 首轮 `schedule_runs.status='skipped'` 且 `reason_code='skipped_paused'`，`reason` 含中文「队列暂停中」；② `jobs` 行数**在两次 tick 前后都不变**；③ `resumeQueues()` 后不自动补跑窗口 | 反例 |
| A22 | `catchup_after_pause=1` 才补跑 | 同上但该字段置 1 且 `miss_policy='catchup'` | 恢复后按策略补 1 个窗口（`jobs` +1） | 边界 |
| A23 | 闸门顺序固定：暂停 → 存储 → 预算 | 同时制造「已暂停 + 磁盘超限 + 月度预算超限」 | `reason_code` 必须是 `skipped_paused`（不是 `skipped_storage` / `skipped_budget`） | 反例 |
| A24 | `once` 触发后自停用 | `kind='once'`，到点触发 | `enabled===0`、`next_run_at===null`、run 行 `reason_code='done_once'`；再 tick 不再触发 | 边界 |

**补充必测（并入 A21/A24 的 evidence，不单独占号）**：闸门跳过也推进水位线（避免暂停 8 小时后灌 8 个 job，T-101 §5.2 取舍 3）；`reconcileScheduleRuns()` 把 job 终态回写 `job_status` 但**不改写** `status='fired'`；`canceled` → `jobs`/`schedules.last_error` 记中文「任务已取消（已完成的部分产物保留）」。

### 2.3 本线的三条「易假绿」点

1. **`INSERT OR IGNORE` 的 `changes` 判定**：`node:sqlite` 里 `run()` 返回的 `changes` 为 0 才是「已存在」。测试必须断言 `schedule_runs` 行数，而不是断言返回值对象里有没有 `deduped` 字段（实现方可能用 `SELECT` 先查再插，看起来对但在并发下会重复花钱）。
2. **`ctx` 注入**：`evaluateSchedule(s, nowISO, ctx)` 的 `ctx.paused/running/budget` 必须由 `tickSchedules` 预取。测试要**显式构造** `ctx`，不能依赖真实全局暂停态（否则并行跑时会互相污染）。
3. **`now` 参数化**：`SCHEDULE_DEFAULTS` 要求所有判定函数不读 `Date.now()`。加一条静态断言：源码里除 `startScheduler` 之外不出现 `Date.now()`（`grep -n 'Date.now()' src/schedules.js`，输出只有 1 处且在该函数内）。

### 2.4 运行命令

```bash
cd /home/linsheng/Desktop/ai-video-factory
node tests/test-schedules.js; echo "exit=$?"
```

---

## 3. 线 B：阶段失败自愈换后端（T-203 → `tests/test-selfheal.js`）

### 3.1 被测面

`src/selfheal.js`（**契约路径，非卡面 `self-heal.js`**）：常量 `HEAL_ACTIONS` `HEAL_FAULTS` `DEGRADE_CHAIN` `FREE_BACKENDS` `PAID_BACKENDS` `MAX_SAME_BACKEND_RETRY` `MAX_SWITCHES_PER_SCOPE` `MAX_GENERATE_CALLS_PER_SHOT` `DEGRADE_TRIP_THRESHOLD` `SELFHEAL_MODES` `NO_SWITCH_KINDS`；函数 `selfHealPolicy` `healProfile` `nextBackend` `canDegradeTo` `planSelfHeal` `degradationOf` `degradeNotice` `recordSelfHeal` `selfHealEvents` `degradeSummary` `ensureSelfHealSchema`。

**核心测试手法**：`planSelfHeal` 是纯函数，副作用全部走入参注入（`probeOf` / `factsOf` / `needs` / `paused` / `budget`）。因此**离线假实例 = 几个计数器函数**，零网络零计费：

```js
let genCalls = 0;
const fakeGen = async () => { genCalls++; throw new Error('视频接口 500: internal server error'); };
const probeOf = async (b) => ({ ok: b === 'placeholder', detail: b === 'placeholder' ? 'ffmpeg 可用' : '实例不可达' });
```

### 3.2 用例矩阵（21 条）

| # | 用例名（中文） | 输入 / 构造 | 期望（可断言） | 类型 |
|---|---|---|---|---|
| B01 | 错误分类映射表 11 类逐一正确 | 用 `ERROR_KINDS` 的 11 个 key 逐个调 `healProfile` | `fault/healable/switchAllowed/action` 与 T-102 §2.2 主表逐格相等（11×4 = 44 个断言点） | 正例 |
| B02 | **审核类永不换后端**（I4 红线） | `healProfile({errorKind:'moderation'})` + `planSelfHeal({errorKind:'moderation'})` | `action==='hold-human'`、`switchAllowed===false`、`toBackend===null`，且**假实例生成调用计数 === 0** | 反例 |
| B03 | 账号/请求/未知类不可自愈 | `auth` `quota` `client` `unknown` 四类 | 全部 `hold-human`，`advice` 非空中文，生成调用 **0** | 反例 |
| B04 | 超时按「原实例是否还活着」分流（两种分支） | `timeout` + `probeFrom={ok:false}` vs `{ok:true}` | 前者 `action==='degrade'`；后者 `hold-human` 且 `advice` 含「仍在运行」 | 边界 |
| B05 | 降级链单向且有限（反例：禁止反向） | `nextBackend({from:'comfyui-h3', allow:['generic-http','placeholder']})` 逐步；`nextBackend({from:'placeholder'})`；构造「反向跳」断言 | 正向得到 `generic-http` → `placeholder`；`placeholder` 返回 `null`；`DEGRADE_CHAIN` 中**不存在**任何指向更贵后端的边 | 反例 |
| B06 | C1：目标探测不通过则不换 | `probeOf` 对所有候选返回 `{ok:false}` | `action==='hold-human'`、`blockedBy==='C1'`、`toBackend===null`、生成调用 **0** | 边界 |
| B07 | C2：能力不满足则跳过该跳（**防 `supportsFirstFrame` 恒真陷阱**） | `needs` 要求尾帧 + `factsOf('generic-http')` 的模板**无** `{{lastImage}}` | 结果**不得**是 `generic-http`；要么跳到 `placeholder`，要么 `hold-human` 且 `advice` 含缺失能力中文名 | 反例 |
| B08 | C3：暂停态不自愈 | `paused:true` | `action==='stop'` 或 `hold-human`、`blockedBy==='C3'`、生成调用 **0** | 反例 |
| B09 | C4：告知写不进去就不换（I1 的杀手锏） | 把 `recordSelfHeal` 打桩为抛错（或 `notice:''`） | `recordSelfHeal({notice:''})` 抛**中文** `Error`；调用方包一层后生成调用计数**必须为 0**，阶段保持 `error` | 反例 |
| B10 | I3：付费跳必须人工批准 | `to='generic-http'`（`PAID_BACKENDS`） | `requiresApproval===true`，`action` 不为 `degrade` 或标记「未执行」，生成调用 **0**；告知含「不会自动执行」 | 反例 |
| B11 | I5：同一 scope 只换一次 | 同一 `(scope,scope_id,stage,from)` 第二次 `degrade` 写库 | 第二次被唯一索引拒绝 → `hold-human`；`notice` 提到**首次** `eventId` | 反例 |
| B12 | 调用预算：可退避类 3 次 / 不可退避类 2 次 / 不可自愈类 1 次 | `attempts=1,2,3` × 三类错误 | `rate` 类：`attempts=1`→`retry-same`；`2`→`degrade`；`3`→`stop`。`config/format`：一上来就 `degrade`。`auth/quota/moderation/client/unknown`：恒 `hold-human` | 边界 |
| B13 | 熔断：连续 3 个同类 → 阶段级降级 | 连续 3 镜 `server` 失败（`tripThreshold=3`） | 第 4 镜**直接以新后端首发**（`switches` 仍为 1，不逐镜换）；账本只多 1 行 `degrade` | 边界 |
| B14 | 一集一致性锁定 | 首镜降级后第 2、3 镜 | `consistency.locked===true`、`scope==='episode'`、`note` 含「前后画风可能不一致」；三镜 `toBackend` 相同 | 正例 |
| B15 | 降级比例告警触发暂停 | 同集 10 镜中 4 镜降级（`degradedRatioAlert=0.3`） | 调用了 `pauseQueues({by:'system'})`：`pauseState().paused===true` 且 `reason` 含中文 | 边界 |
| B16 | 幂等：同 `input_fp` + 已有 done 不重复生成 | 复用 `graph.shouldSkip` 语义 | 生成调用计数**不变** | 护栏 |
| B17 | 自愈状态不污染输入指纹 | 写自愈状态前后各调一次 `inputFingerprint()` | 两次结果**相等**（`degrade`/`lastDegrade`/`lastBackend` 必须在 `VOLATILE_DATA_KEYS` 内） | 护栏 |
| B18 | 不覆盖人工已采用版本 | 该镜 `shot_renders.picked=1`，触发自愈 | 自愈产物 `picked===0`；原行字段逐列不变；`notice` 含「已有人工采用版本」 | 护栏 |
| B19 | `degrade` 对象字段级不变量 | 构造 `healed:true` 的完整对象 | `healed===true` ⟺ `to!==null && eventId!==null && notice.length>0 && Array.isArray(lostCapabilities) && needsHumanReview===true`；`costImpact.to==='paid'` ⟹ `requiresApproval===true` | 护栏 |
| B20 | 中文告知模板逐要素 | `degradeNotice(rec)` | 返回非空字符串，含 `from → to`、`损失：`、`保留：`、`费用：`、`一致性：`、`事件 SH-` | 中文报错 |
| B21 | 既有口径零回归 | `ERROR_KINDS` 键集合快照（11 个）、`classifyError` 对 T-102 §2.4 速查表 12 条源码原文的输出、`DEFAULT_RETRY_KINDS` | 三者与改动前**逐值相等**（快照写死在测试里，来自契约表而非实现） | 护栏 |

**补充断言（并入 B19/B21 的 evidence）**：`errorExcerpt` 保留厂商原文前 200 字（**不翻译、不截断掉关键信息**）；`shot_renders.meta.degrade` / `canvas_node_runs.meta.degrade` / `jobs.result.degradeSummary` / `production_stages.warnings` / `GET /api/render/selfheal` **五处能读到同一 `eventId` 与同一 `notice`**（T-102 §5.4 的一句话规则）。

### 3.3 本线的两条「易假绿」点

1. **用「返回值里有 `degrade` 字样」当证据** → 必须断言 **生成调用计数**。契约 §1 的不变量 I1 明确：账本里没有的记录，就不可能发生过生成；反之「调用计数 0」是唯一能证伪「静默换后端」的证据。
2. **只测 `planSelfHeal`（纯函数）不测 `recordSelfHeal`（写库）** → C4/I5/跨重启都靠 DB 唯一索引兜底，必须真的建临时库跑一次 `INSERT`，并断言第二次插入被拒。

### 3.4 运行命令

```bash
cd /home/linsheng/Desktop/ai-video-factory
node tests/test-selfheal.js; echo "exit=$?"
```

---

## 4. 线 C：画布类型筛选与多选批处理（T-205/T-206 → `tests/canvas-select.test.mjs`）

### 4.1 被测面

**纯逻辑层（`web/lib/canvas-select.js`，零依赖零 DOM，Node 可直接 import）**：
`DEFAULT_NODE_FILTER` `NODE_FILTER_DIMS` `KIND_LABELS` `nodeKindOf` `nodeGroupOf` `isNodeLocked` `hasArtifactOf` `normalizeNodeFilter` `matchNodeFilter` `filterItems` `describeNodeFilter` `nodeFilterChips`（+ `BATCH_MAX_NODES`）。

**接线层（`web/views/actors.js`，不在 T-205 写入范围，由集成线独占）**：`runBatchAction` 与 `batchMove` / `batchResize` / `batchDelete` / `batchGroup` / `batchRerunByKind` / `batchSetLocked`。**本计划的 C13–C27 需要先物化接线，若接线未落地则该部分标记「未执行」并计入风险，不得记为通过。**

### 4.2 A 组：筛选谓词（12 条，纯函数）

| # | 用例名（中文） | 输入 / 构造 | 期望 | 类型 |
|---|---|---|---|---|
| C01 | 空规格 → 全通过（默认态零差异） | `filterItems(items, DEFAULT_NODE_FILTER)` | `length === items.length`，且元素**同一引用** | 正例 |
| C02 | 类型多选 = 维度内 OR | `kinds:['video','image']` | 结果全是 video 或 image，两类都出现 | 正例 |
| C03 | 类型 + 锁定 = 维度间 AND | `kinds:['video'], locked:'yes'` | 只剩「video 且 locked」；`video 且未锁定` **不**出现 | 边界 |
| C04 | `groups:['']` 只看未分组 | 构造 3 个未分组 + 2 个有组 | 结果全是 `groupId` 空 | 边界 |
| C05 | `negate` 只对外层取反（**不是**逐维取反） | `{kinds:['note'], negate:true}` | 结果里**无 note**，且原集合中所有非 note 项**都在**（逐维取反会得到「非 note 且 非其它」的空集） | 边界 |
| C06 | 三态非法值回落 `any` 不抛错 | `hasArtifact:'maybe'`、`failed:1`、`locked:null` | 归一化为 `'any'`；不抛错 | 反例 |
| C07 | `hasArtifactOf` 分类型逐条 | `actor`(有/无 `cover_image`)、`note`、`scene`(`refImages` 空/非空)、`video`(`lastFile` 空/非空) | 与 T-103 §2.7 判定表逐格一致；**便签恒 `false`** | 正例 |
| C08 | 失败只认 `data.status==='error'` | `status` 分别为 `'error'` / `'failed'` / `'error '` / `undefined` 的节点 | 只有 `'error'` 命中 `failed:'yes'` | 反例 |
| C09 | `data` 非法 JSON 不崩 | `node.data = '{坏'` | `dataOf` 回落 `{}`；`hasArtifactOf===false`；整条筛选不抛错 | 边界 |
| C10 | 演员卡的「失败」恒 false | `kind:'actor'` 且该演员有失败的出图记录 | `failed:'yes'` **不**命中（T-103 §2.7 明确：演员失败不适用） | 反例 |
| C11 | `normalizeNodeFilter` 去重 / 剔非法 / 补默认 / 永不抛错 | `{kinds:['video','video','bogus-kind'], groups:['a','a'], failed:'maybe'}` 以及 `null` / `'x'` / `123` | 去重后保留合法项；非法 kind 是否剔除按实现（契约要求「剔非法值」）；输入为 `null`/字符串时返回**默认规格**且不抛错 | 反例 |
| C12 | `filterItems` 保序且不改入参 | 任意 20 项；调用前后 `JSON.stringify(items)` | 顺序与输入一致；入参 JSON 前后**相等** | 护栏 |

**中文文案断言（并入 C12 evidence）**：`describeNodeFilter` 输出形如 `筛选：视频/关键帧 · 有产物 · 未锁定（12/48）`；空结果文案固定为 `当前筛选没有匹配的节点；点「⌀ 清除筛选」查看全部`；无匹配时「选中筛选结果」提示 `当前筛选没有可选的节点`；清除提示 `已清除节点筛选`。三者必须**逐字**匹配（T-103 §3.6 标明「测试按此断言」）。

### 4.3 C/D 组：批处理前置校验与落库正确性（15 条）

| # | 用例名（中文） | 输入 / 构造 | 期望 | 类型 |
|---|---|---|---|---|
| C13 | 空选区被拒 | `batchMove(10,10)`，`S.selection` 为空 | `ok===false`，`reason` 匹配 `/请先在画布上选中要处理的节点/` | 中文报错 |
| C14 | 宫格模式拒绝批量移动 | `S.mode==='matrix'` | 拒绝，`reason` 匹配 `/宫格模式/`（不得「默默改了但没效果」） | 反例 |
| C15 | 全部锁定项时拒绝；部分锁定则跳过并计数 | 3 项全锁定 / 3 项中 1 项锁定 | 全锁定 → 拒绝，`reason` 含「全部已锁定」；部分 → `affected===2 && skipped===1`，提示含「跳过 1 个已锁定」 | 边界 |
| C16 | 节点数上限 `BATCH_MAX_NODES=500` | 501 项选中 | 拒绝，`reason` 匹配 `/一次最多处理 500 个节点/` | 反例 |
| C17 | 分组框 / 连线不在选择集 | 选中分组框 / 选中连线后调批处理 | 两者分别被 G4/G5 拒绝，中文提示指向各自独立入口 | 反例 |
| C18 | 缩放夹紧且不报错 | `batchResize({w:5000})` / `{w:10}` / `{h:5000}` / `{h:10}` | 落库值分别是 900 / 90 / 1200 / 90；提示含 `尺寸已限制在 90×90 ~ 900×1200 之间`；**不抛错** | 边界 |
| C19 | `purge` 未过第二段确认 → 零副作用 | 打桩 `fetch`，`purge` 模式只过第一段确认 | **不发出任何** `DELETE /api/actors/:id`；演员档案与卡位都不变 | 反例（最高优先） |
| C20 | `detach` 先清连线后删节点 | 建 2 个节点 + 1 条连线，`batchDelete({mode:'detach'})` | `canvas_links` 中该节点的边**为 0 行**；`canvas_nodes` 少 2 行；`getActor(id)` **仍非空** | 护栏 |
| C21 | `purge` 的跨画布影响面被写进提示 | 演员同时存在于两张画布，`purge` | 另一张画布上的卡位也被清（断言跨画布）；确认文案含「影响所有画布，快照只保护当前画布」 | 护栏 |
| C22 | 便签/资产不能被 `POST /api/canvas/nodes` 改几何 | `{nodes:[{actor_id:'', x:1}]}` | 静默丢弃：`updated===0`（**记录既有行为**，防止实现方走错路）；批处理必须改走 `PUT /api/canvas/assets/:id` | 反例 |
| C23 | 幽灵卡位物化必须用 `actor_id` 为键 | `item.node === null`、`item.id === 'actor:'+actorId` 的项做 `batchMove` | 库中**新增**一行（行数 +1），且新行 `actor_id` 正确；**不得**出现 `id === 'actor:xxx'` 的行 | 护栏 |
| C24 | 批量成组跳过非演员节点 | 选区含 2 演员 + 1 便签 | 提示含 `便签/资产/流程节点暂不支持批量成组（已跳过 N 项）`；便签的 `group_id` **保持 NULL**；演员进组成功 | 反例 |
| C25 | 重跑前置校验五连（反例组） | ① 全 `scene/actor/shot` ② 队列暂停 ③ 超月度预算 ④ 画布有环 ⑤ 无可执行节点 | ①`/没有可执行的节点/` ②透传暂停中文 `reason` ③透传 `checkBudget` 中文 `reason` ④`/环形依赖/` ⑤`/没有需要执行的节点/`；**五条都不得发起任何执行** | 反例 |
| C26 | 重跑必须走审批闸门（三关） | ① 未批准直接 `POST /api/canvas/plans/:id/run` ② 批准后改画布再 run ③ 错误确认码 | ①`/尚未经人工审批/` ②被拒（二次 `planGraph` 比对不一致）③被拒且 `canvas_plan_audits.action==='run_denied'`；三次都**零生成调用** | 护栏 |
| C27 | **静态护栏：批处理不得走无闸门入口** | 对 `web/lib/canvas-select.js` 与接线后的 `web/views/actors.js` 做文本检索 | 不出现 `/api/canvas/run'`、`/api/canvas/run-node`（注意排除 `/api/canvas/run-` 前缀与 `/api/canvas/runs`）；命中即 FAIL | 护栏 |

### 4.4 E 组：与撤销 / 快照 / 主画布保护的交互（并入 C20/C21 evidence，另加 3 条）

| # | 用例名（中文） | 期望 |
|---|---|---|
| C28 | 一个批处理动作 = 一步撤销 | 连续两个批处理动作后 `undoStack.length` **只 +2**（不是 +N） |
| C29 | 40 步上限 | 连续 45 次 `pushUndo()` 后 `undoStack.length===40` |
| C30 | 危险动作触发自动快照 | `batchDelete` 后 `listSnapshots(canvasId).count` +1，最新一张 `kind==='auto'`；空画布返回 `{ok:true, skipped:...}` **不**产生快照；快照失败**不阻断**主操作但提示带回原因 |

**另加一条硬断言**（C20 的延伸）：**主画布 `CV-MAIN` 的删除必须抛 `主画布不可删除`**（`tests/test-actors.js:172` 已有同款断言，此处只做交叉引用，不重复造）。

### 4.5 本线的三条「易假绿」点

1. **用 `items` 全量做批处理** → 用户看到的 12 项与选区里的 48 项不一致（危险 H9）。必须构造「筛选后可见 2 项、`S.selection` 含 40 项」的场景，断言实际处理数 === **可见且被选中**的数量。
2. **断言「调用过 `autoSnapshotBefore`」而不检查落库** → 必须查 `canvas_snapshots` 行数与 `kind`。
3. **`purge` 只测「有确认」不测「无确认时的零副作用」** → C19 必须是**打桩 `fetch` 断言调用次数为 0**，而不是断言提示文案正确。

### 4.6 运行命令

```bash
cd /home/linsheng/Desktop/ai-video-factory
node tests/canvas-select.test.mjs; echo "exit=$?"
# 纯函数部分（C01-C12）不需要服务；C13-C30 需要接线 + 临时库（照 §1.1 模板）
```

---

## 5. 线 D：字幕换行与安全区（T-207 → `tests/test-subtitle-wrap.js`）

### 5.1 被测面

落点 **`src/subtitles.js`**（契约 §2.1；非卡面的新文件 `src/subtitle-wrap.js`）：常量 `FORBID_LINE_START` `FORBID_LINE_END` `SENTENCE_END_RE` `WIDE_RE` `GLYPH_HEIGHT_RATIO`；函数 `wrapSubtitles` `wrapCjkLegacy` `subtitleLayout` `splitForCps`。既有导出（`parseTime`/`parseSrt`/`toVtt`/`toTtml`/`validateSubtitles`）**一律不动**。

### 5.2 用例矩阵（19 条）

| # | 用例名（中文） | 输入 / 构造 | 期望 | 类型 |
|---|---|---|---|---|
| D01 | **legacy 逐字节等价（≥40 条语料）** | §2.6 的 12 条 + 纯 CJK / 中英混排 / 纯数字 / emoji / 各类标点 / 空串 / 纯空白 / 含 `\n` / 单原子超长，共 ≥40 条 | 对每条：`wrapSubtitles(t,{lineBreakMode:'legacy'}).text === wrapCjkLegacy(t,18).text`，且**两条都等于改动前 `src/finish.js:86-96` 的 `wrapCjk` 输出**（把旧函数体逐字复制进测试作为冻结基线） | 护栏（最高优先） |
| D02 | **golden SRT 快照（含时间码）** | 固定 shots 数组，`buildSRT(shots)` | 产出 SRT **全等**于冻结基线字符串（覆盖 §3.6 的「行数 × 1.6 + 1.2」时长耦合） | 护栏 |
| D03 | §2.6 标准用例 ①②③④ 逐条 | 输入→期望 `lines` 四元组 | 与契约表逐行相等（①②④ 无 warning；③ 有 `原子超长：supercalifragilistic（20 > 18）` 且 `overflow===true`） | 正例 |
| D04 | §2.6 标准用例 ⑤⑥⑦⑧ 逐条 | 连续标点 / 时间码+百分比 / 括号 / 说话人前缀 | 与契约表逐行相等；⑦ 断言 `lines` 中**无行以 `（` 收尾** | 正例 |
| D05 | §2.6 标准用例 ⑨⑩⑪⑫ 逐条 | 空串/纯空白 / 含 `\n` / `maxCharsPerLine:1` / 未超限 | ⑨ `lines===[]` 且 `maxLineChars===0`；⑩ 硬换行保留为两行；⑪ `lines.join('')===原文`（**不丢字**）；⑫ 不主动加行 | 边界 |
| D06 | 四条全局不变量（属性测试） | 对 D01 的 40 条语料全跑 | ① 无行以 `FORBID_LINE_START` 开头；② 无行以 `FORBID_LINE_END` 结尾；③ 不丢字不增字；④ 除 `overflow` 行外码点数 `<= maxCharsPerLine` | 护栏 |
| D07 | 原子化：URL / 邮箱 / 时间码 / 百分比 / 长英文词 | 四类各一条；再单独构造超长原子 | 四类都**不被内部切断**；超长原子独占一行 + `warning` + `overflow=true` | 边界 |
| D08 | emoji / 代理对按码点计数 | `测试😀表情符号…`，`lineBreakMode:'cjk'` | `maxLineChars` 与 `validateSubtitles` 的 `[...l].length` **同口径**（两者对同一行给出相同数） | 边界 |
| D09 | legacy 保留 UTF-16 计数差异（反例：不得「顺手统一」） | 同一 emoji 串在 `legacy` 模式 | `wrapCjkLegacy` 用 `.length`（UTF-16），与 `cjk` 模式结果**允许不同**；断言 legacy 结果与冻结基线相等 | 反例 |
| D10 | 满行遇到标点的 `per+1` 怪癖被保留 | `一二三四五六七八九十甲乙丙丁戊己庚，然后接着说下去` | `legacy` 模式首行 **19 字**（`per+1`）；`cjk` 模式首行 `<= 18` | 反例（兼容红线） |
| D11 | legacy 模式不改计数方式 | 静态断言 `wrapCjkLegacy` 源码含 `line.length`（UTF-16）而非 `[...line].length` | 出现码点计数即 FAIL | 护栏 |
| D12 | 六平台 `L_safe` / `L_eff` 数值表逐行 | `subtitleLayout({presetId, subtitleSize:22, maxCharsPerLine:18, applySafeAreaLimit:true})` | douyin 9 / channels 9 / xiaohongshu 12 / bilibili 30→`L_eff`18 / youtube 30→18 / square 16；`capacityChars === maxLines × L_eff` | 正例 |
| D13 | `L_MIN=6` 兜底与告警文案 | 构造 `L_safe < 6` 的参数（如极小画面 + 大字号） | `L_eff===6`，`warnings` 含 `安全区只放得下 N 字/行（低于可读下限 6），建议调小 finish.subtitleSize` | 中文报错 |
| D14 | 安全区联动**默认关闭**（兼容红线） | `subtitleLayout({presetId:'douyin'})`（不传 `applySafeAreaLimit`） | `safeAreaLimited===false` 且 `maxCharsPerLine===18`（= 配置值，不是 9） | 反例 |
| D15 | 字号反解一致性 | `subtitleSize` 分别 22 / 16 / 12 于 1080×1920 | `L_safe` 分别 9 / 12 / 17（允许 ±1 的取整口径差，超差即 FAIL 并打印实际值） | 边界 |
| D16 | `splitForCps` 四组样例 | 契约 §3.6 的 4 行（30字/3s 竖屏、12字/3s 竖屏、40字/6s 横屏、25字/2s 竖屏） | `segments` 分别 2 / 1 / 2 / 2；每段 `chars_i` 与 `duration_i` 按比例；`cues` 长度 === `segments` | 正例 |
| D17 | CPS 拆条默认关闭 | 读 `loadConfig().finish.subtitleSplitForCps` | `=== false`；且未开启时 `buildSRT` 的 `cues` 与基线相同 | 反例 |
| D18 | 外部 SRT 不重排（R4 红线） | 走 `options.subtitleSource` 的画布字幕轨路径 | 产出的 SRT 与输入**逐字节相同**（断行不得作用于用户稿件） | 反例 |
| D19 | 配置默认值快照 | 读 `finish.subtitleWrap` / `subtitleCharUnit` / `subtitleAutoLayout` / `subtitleSplitForCps` / `subtitleLayoutPreset` | 分别 `'legacy'` / `'char'` / `false` / `false` / `null`（**六个新键全部默认「关」**） | 护栏 |

### 5.3 本线的两条「易假绿」点

1. **用新算法自测新算法** → D01/D02 的期望值必须来自**冻结基线**（旧函数体逐字复制 + 固定 shots 的 SRT 字符串），不能来自 `wrapCjkLegacy` 的当前实现（否则实现方把两者一起改坏也能通过）。正确写法：测试文件内**自带**一份 `wrapCjkOriginal` 副本。
2. **只测 `cjk` 新功能** → 本线的真实风险是**破坏既有产物**（交付包/QC/发布物时间码漂移）。D01/D02/D14/D17/D19 五条才是验收主体。

### 5.4 运行命令

```bash
cd /home/linsheng/Desktop/ai-video-factory
node tests/test-subtitle-wrap.js; echo "exit=$?"
```

---

## 6. 线 E：画布性能纯逻辑（T-209/T-210 → `tests/canvas-perf.test.mjs`）

### 6.1 被测面

`web/lib/canvas-perf.js`，**零 import、零 DOM、零副作用**。核心批：`ZOOM_MIN` `ZOOM_MAX` `LOD_THRESHOLDS` `CULL_PAD` `clampZoom` `lodLevelFor` `viewportOf` `viewClipKeep` `visibleItems` `cullStats` `zOf` `sortByZ` `shouldDrawLinks`；扩展批（可分批交付）：`hitTestAt` `marqueeHitIds` `boundsOf` `matrixLayout` `zoomAtPoint` `fitViewport` `zoomToRect` `ensureVisiblePan` `snapPosition` `alignOffsets` `distributeOffsets` `resizeSize` `freeSpot` `niceStep` `portPoint` `portPointAt` `edgeAnchor` `resolvedLinks`。

### 6.2 用例矩阵（18 条）

| # | 用例名（中文） | 输入 / 构造 | 期望 | 类型 |
|---|---|---|---|---|
| E01 | 空数组不产生 NaN | `visibleItems([], v)` / `cullStats([], v)` | `[]` / `{total:0,drawn:0,hidden:0,ratio:0}`，`ratio` **不是** NaN | 边界 |
| E02 | 边界相切 4 条边全部可见 | `x+w===view.x0` / `x===view.x1` / `y+h===view.y0` / `y===view.y1` | 四条 `viewClipKeep === true`（**闭区间**语义） | 边界 |
| E03 | 越界 1px 4 条边全部不可见 | 上述四例各外移 1px | 四条全部 `false` | 边界 |
| E04 | 裁剪口径 = 现状 4 条件取反 | 逐条构造 `x+w < x0` / `x > x1` / `y+h < y0` / `y > y1` | 四种都 `false`；`viewClipKeep` 与「跳过条件取反」**逐例等价** | 护栏 |
| E05 | `pad=50` 不随 zoom 变化（反例：禁止 `pad/zoom`） | `viewportOf({zoom:0.05,panX:10})` 与 `{zoom:8,panX:10}` | 两者 `x0 === -10 - 50`；**不得**出现 `-10 - 50/zoom` | 反例 |
| E06 | `pad` 是世界单位（同时锁 4 个边界） | 同上 + `y0/y1` | `y0 === -panY-50`、`x1 === -panX + width/zoom + 50`、`y1 === -panY + height/zoom + 50` | 护栏 |
| E07 | `width=0`（画布隐藏）不兜底 | `viewportOf({zoom:1,width:0,height:0})` | `x1 === x0 + 2*pad`（退化矩形）；对应 `drawn` **极小**而非全部（禁止「兜底全可见」） | 反例 |
| E08 | 保序 + 稳定排序 | 输入含等 z 的 5 项 | `visibleItems` 与输入同序；`sortByZ` 在等 z 时保持输入顺序（比较器须显式 `idx` 差值，不得依赖引擎稳定性） | 护栏 |
| E09 | 元素同一引用（不做拷贝） | 对结果做 `===` 比对 | 每个元素 `===` 输入中对应元素（`_itemsById` 依赖 identity） | 护栏 |
| E10 | LOD 阈值 6 个采样点 | `0.21999 / 0.22 / 0.49999 / 0.5 / 0.05 / 8` | `0 / 1 / 1 / 2 / 0 / 2`（阈值取自 `LOD_THRESHOLDS`，**不得**在测试里写死 0.22） | 边界 |
| E11 | 非有限数不做兜底 | `lodLevelFor(NaN)` / `lodLevelFor(Infinity)` | 返回 `2`（保持现状 JS 语义）；不抛错 | 反例 |
| E12 | `clampZoom` 边界 | `0.001 / 0.05 / 1 / 8 / 100` | `0.05 / 0.05 / 1 / 8 / 8` | 边界 |
| E13 | `shouldDrawLinks` 三态 | `{showLinks:false,links:[1]}` / `{showLinks:undefined,links:[]}` / `{showLinks:true,links:[1]}` | `false / false / true` | 正例 |
| E14 | 两种口径必须不同（**最强的一条反例**） | 取一条与视口**恰好相切**的矩形 | `viewClipKeep(rect,v) === true` **且** `marqueeHitIds([item], 相切矩形选它)` 为 `[]`（闭区间 vs 半开区间），两者不得被「统一」 | 反例 |
| E15 | 中文报错 | `visibleItems('x', v)` / `visibleItems([], null)` | 抛 `TypeError`，消息分别匹配 `/必须是数组/` 与 `/x0/`（含函数名与实参类型） | 中文报错 |
| E16 | 入参不被修改 | 传 `items` 与 `item` 前后 `JSON.stringify` | 前后相等；`view` 对象也不被改写 | 护栏 |
| E17 | 200/1000 卡解析表（M5） | `matrixLayout({count:200,cols:5,cell:210,gap:14})` + `viewportOf`（1320×860、pad 50） | §3.2 表 10 行 `drawn` 逐行相等（200/195/165/90/60/40/20/12/4/1）；1000 卡抽查 4 点（195/90/20/1） | 正例 |
| E18 | 统计口径 + 预算（M6） | `cullStats` 与计时 | `hidden===total-drawn`、`ratio===drawn/total`（浮点相等）；打印 200/1000 卡实测 ms 作为 evidence，**只断言预算上界**（200 卡 ≤1ms、1000 卡 ≤5ms），绝不写死实测毫秒 | 护栏 |

**另加两条交付证据断言（不占用例号，但必须贴原始输出）**：
- **模块洁净**：`grep -nE "\b(window|document|navigator|localStorage|console|performance|Date|Math\.random)\b|^import " web/lib/canvas-perf.js` 输出为**空**。
- **`actors.js` 零改动**：`md5sum web/views/actors.js` 必须等于本卡侦察基线 `a510a8211f87fb8b4a6ffd473d029029`（4669 行）。

### 6.3 本线的一条「易假绿」点

**测试自己写死阈值/留白** → 实现方把 `LOD_THRESHOLDS.mid` 从 0.22 改成 0.3，测试仍全绿（因为测试里也写的 0.22）。正确写法：从模块 `import { LOD_THRESHOLDS, CULL_PAD }`，再用 `LOD_THRESHOLDS.mid - 1e-9` / `+0` 两个采样点断言切换行为；`CULL_PAD` 同理。

### 6.4 运行命令

```bash
cd /home/linsheng/Desktop/ai-video-factory
node --check web/lib/canvas-perf.js
node -e "import('./web/lib/canvas-perf.js').then(m=>console.log(Object.keys(m).sort().join(',')))"
node tests/canvas-perf.test.mjs; echo "exit=$?"
```

---

## 7. 回归策略：哪些既有套件必须全绿

### 7.1 基线：25 个阶段 / 2098 项断言（来自 `README.md:11`）

| 阶段 | 套件 | 断言数 | 与哪些新线相关 |
|---|---|---|---|
| 1 | `tests/selfcheck.js` | 23 | C、E（宫格画布段） |
| 2 | `tests/test-actors.js` | 105 | C、**E**（主画布保护 `:172`、画布 CRUD、分组、视图持久化） |
| 3 | `tests/test-novel.js` | 45 | —（前端 import 先例来源） |
| 4 | `tests/test-script.js` | 74 | — |
| 5 | `tests/test-render.js` | 71 | **D**（`:244` `srtBuild.cues===2`）、**B**（镜头 catch 挂载点） |
| 6 | `tests/test-bridge.js` | 33 | — |
| 7 | `tests/test-comfy.js` | 63 | **B**（H3 超时/模板回退/`withAudio`） |
| 8 | `tests/test-adapters.js` | 82 | **B**（`:273-282` classifyError 10/10、`:302`） |
| 9 | `tests/test-guard.js` | 37 | **A、B**（`:159-160,174` 失败归类可重试集；预算/存储闸门） |
| 10 | `tests/test-stats.js` | 30 | 间接（失败原因 Top 会随 B 变化） |
| 11 | `tests/test-jobs.js` | 47 | **A**（暂停/取消/启动自愈语义） |
| 12 | `tests/test-mcp.js` | 284 | **B、C**（审批闸门、`CV-MAIN`、`canvas_plan_audits`） |
| 13 | `tests/test-graph.js` | 199 | **B**（`:427-468` DEFAULT_RETRIES/DEFAULT_RETRY_KINDS）、**C**（计划/指纹/跳过） |
| 14 | `tests/test-studio.js` | 148 | **A、B**（阶段幂等、`reconcileStages`、快照与决策时间线 `:445-449`/`:492-493`） |
| 15 | `tests/test-timeline.js` | 173 | **D**（画布字幕轨 `subtitleSource`） |
| 16 | `tests/test-scale.js` | 24 | 间接（200 演员规模） |
| 17 | `tests/test-deliver.js` | 74 | **D**（`:237` validateSubtitles 口径、交付包 SRT） |
| 18 | `tests/test-qc.js` | 47 | **D**（QC 字幕规范/安全区） |
| 19 | `tests/test-dub.js` | 32 | 间接 |
| 20 | `tests/test-publish.js` | 32 | **D**（发布 SRT/多语言） |
| 21 | `scripts/simulate-all.js` | 83 | **D**（端到端 SRT）、**A**（若接排产） |
| 22 | `tests/ui-smoke.py` | 22 | **C** |
| 23 | `tests/ui-simulate.py` | 172 | **C**（`:518-520` `Ctrl+A` 断言，**不得回归**） |
| 24 | `tests/ui-scale.py` | 21 | **C、E** |
| 25 | `tests/canvas-audit.py` | 177 | **C、E**（E 段 6 条断言 `:317/318/327/331/333/337`；框选/对齐/撤销/文档一致性四项） |
| | **合计** | **2098** | |

### 7.2 每线的辐射面与「点名不可改红」的既有断言

| 线 | 改动文件 | 必须全绿（点名到行） |
|---|---|---|
| **A** | 新增 `src/schedules.js`、`src/routes/schedules.js`；`server.js` 一行注册（集成线独占） | `test-jobs.js`(47) · `test-guard.js`(37) · `test-studio.js`(148) · `test-mcp.js`(284，**路由注册顺序**：`/api/schedules/runs`、`/preview` 必须先于 `/:id`，否则首命中即返回会互相遮蔽 `src/http.js:79-94`) · `selfcheck.js`(23) |
| **B** | `src/selfheal.js`（新）；`graph.js`(`:57` VOLATILE、`:766-779` catch)、`modules/render.js`(`:280-297`)、`studio.js`(`:881-884`、`:944-965`)、`decisions.js`(`:143-156`)、`routes/render.js`、`mcp-tools.js`、`config.js`(`video` 段新增 `selfHeal`) | `test-adapters.js`（`:273-282` 归类 10/10、`:302`、`:311`）· `test-graph.js`（`:427-468`）· `test-guard.js`（`:159-160`、`:174`）· `test-render.js`(71) · `test-studio.js`(148) · `test-mcp.js`(284) · `test-qc.js`(47) · `test-comfy.js`(63) |
| **C** | 新增 `web/lib/canvas-select.js`；`web/views/actors.js`（集成线独占） | `test-actors.js`(105，`CV-MAIN` 断言 `:172`) · `test-graph.js`(199) · `test-mcp.js`(284) · `test-studio.js`(148) · `canvas-audit.py`(177，重点：框选与顺序角标、对齐与分布、撤销重做不丢数据、文档与实现一致) · `ui-simulate.py`(172，`:518-520`) · `ui-smoke.py`(22) · `ui-scale.py`(21) |
| **D** | `src/subtitles.js`（新增导出，既有导出不动）、`src/finish.js`（删私有 `wrapCjk` + 1 行 import + `:78` 分派）、`src/config.js`（`finish` 下 6 个新键） | `test-render.js`(71，`:244` `cues===2` **不得变**) · `test-deliver.js`(74，`:237`) · `test-qc.js`(47) · `test-publish.js`(32) · `test-timeline.js`(173) · `test-dub.js`(32) · `simulate-all.js`(83) |
| **E** | 仅新增 `web/lib/canvas-perf.js`（**零接线**，`actors.js` 必须零改动） | `test-actors.js`(105) · `selfcheck.js`(23，「6. 宫格画布」段) · `canvas-audit.py`(177，E 段 6 条 `:317/318/327/331/333/337`) |

### 7.3 分层回归门禁（`verify-all.sh` 的合规替代）

**本波次禁止跑 `./scripts/verify-all.sh`**（太重 + 与并行任务抢 SQLite/CPU/端口）。替代为三层门禁，**按顺序**执行：

| 层 | 内容 | 命令 | 前置条件 |
|---|---|---|---|
| **L1 纯函数层（可并行）** | 五个新套件 + 三个「零 IO」既有套件 | `node tests/test-schedules.js`、`node tests/test-selfheal.js`、`node tests/canvas-select.test.mjs`、`node tests/test-subtitle-wrap.js`、`node tests/canvas-perf.test.mjs`、`node tests/selfcheck.js`、`node tests/test-guard.js`、`node tests/test-jobs.js` | 无（全部临时库，互不冲突） |
| **L2 生成式临时库层（串行，避免 CPU 抖动导致 flaky）** | 受影响最重的四个既有套件 | `node tests/test-graph.js`、`node tests/test-studio.js`、`node tests/test-render.js`、`node tests/test-adapters.js` | 无（临时库 + 离线假实例） |
| **L3 服务/浏览器层（**单线程只读**，不重启 8788）** | 需要 `http://127.0.0.1:8788` 的四个 Python 审计 + 两个 API 套件 | `node tests/test-actors.js`、`node tests/test-mcp.js`、`python3 tests/canvas-audit.py "$BASE"`、`python3 tests/ui-smoke.py "$BASE"`、`env LD_LIBRARY_PATH="$PWLIBS" python3 tests/ui-simulate.py "$BASE"`、`env LD_LIBRARY_PATH="$PWLIBS" python3 tests/ui-scale.py` | 服务已在跑（**不得 start/restart**）；**同一时刻只跑一个**；跑 L3 前确认没有其他智能体在同一端口压测 |
| **L4 全量（仅最终验收波次，由总军师决定）** | `./scripts/verify-all.sh` | 同上 | 所有实现卡停止写入后 |

**门禁判定**：L1/L2 任何一条非 0 退出即「本轮不通过」，**不得**用「另一条过了」抵消。L3 的 Python 审计若因服务未启动而 `skip`，必须记为**未执行**（不是通过）。

### 7.4 断言计数守恒（防「改期望凑绿」）

**采集基线（在 W2 实现波次开始前，由验收统筹跑一次并贴原始输出）**：

```bash
cd /home/linsheng/Desktop/ai-video-factory
for t in tests/selfcheck.js tests/test-actors.js tests/test-novel.js tests/test-script.js tests/test-render.js \
         tests/test-bridge.js tests/test-comfy.js tests/test-adapters.js tests/test-guard.js tests/test-stats.js \
         tests/test-jobs.js tests/test-mcp.js tests/test-graph.js tests/test-studio.js tests/test-timeline.js \
         tests/test-scale.js tests/test-deliver.js tests/test-qc.js tests/test-dub.js tests/test-publish.js; do
  printf '%-28s ' "$t"; node "$t" 2>&1 | grep -o '=== 结果：[0-9]* 通过 / [0-9]* 失败 ===' || echo '(无标准尾部)'
done
```

**判定规则**：
- 每个既有套件的「通过数」**不得低于**基线；「失败数」必须为 0。
- 若某套件通过数**下降**，必须在报告里给出**逐条**说明（哪条断言被删/被改），并由验收统筹裁决 —— 默认判 FAIL（铁律：禁止改既有测试期望来凑绿）。
- 新增断言**只加不删**；新套件的通过数应 ≥ 本计划的用例数（A≥24 / B≥21 / C≥27 / D≥19 / E≥18）。

### 7.5 本计划明确**不**做的事

1. 不跑 `./scripts/verify-all.sh`（L4 由总军师在全部实现卡停写后决定）。
2. 不启动/重启任何服务（8788 正在服务 GUI）。
3. 不改任何既有测试文件的期望值。
4. 不把「服务未启动导致 skip」记为通过。
5. 不为了跑测试而改 `config/config.json`（用户数据文件；测试一律走 `FACTORY_CONFIG` 临时文件）。

---

## 8. 红队证伪点清单（15 条，每条附**可执行**的证伪命令）

> 使用说明：以下命令在**实现卡交付后**执行；全部指向临时库/临时配置，**不污染 `data/factory.db`**，不重启服务。判定标准一栏写明「什么样的输出算证伪成立」。

| # | 失败假设（最可能骗过测试的形态） | 假绿手法 | 证伪命令（模板） | 判定标准 |
|---|---|---|---|---|
| **RT-01** | **排产假幂等**：唯一索引建了，但并发下两次 tick 各建一个 job | 只断言返回值里有 `deduped` 字段 | `TMP=$(mktemp -d); FACTORY_DB=$TMP/a.db FACTORY_DATA_DIR=$TMP/d FACTORY_CONFIG=$TMP/c.json node -e '...并发两次 fireSchedule...; console.log(get("SELECT COUNT(*) n FROM jobs").n, all("SELECT COUNT(*) n FROM schedule_runs WHERE window_key=?", w)[0].n)'` | `jobs` 增量 `>1` 或 run 行 `>1` 即**证伪成立**（幂等是假的） |
| **RT-02** | **暂停期堆积**：`evaluate` 判了 paused，但 tick 直接调 `fireSchedule` 绕过判定 | 只测 `evaluateSchedule` 的纯函数分支 | 临时库 + `pauseQueues()` + 造到期窗口 + `tickSchedules()`，打印 `jobs` 行数与 `schedule_runs.reason_code` | `jobs` 行数增加 或 `reason_code !== 'skipped_paused'` 即证伪成立（恢复瞬间会灌爆队列） |
| **RT-03** | **`catchup_all` 雪崩**：`catchup_max` 未真正截断 | 只测 `catchup_max=2` 的小样例 | 造 100 个到期窗口（`interval_minutes=1`，停机 100 分钟）+ `catchup_all` + `catchup_max=2`，打印 `jobs` 增量与 `miss_count`/`truncated` | `jobs` 增量 `>2`，或 `miss_count + truncated` 对不上 `occurrences.length` 即证伪成立 |
| **RT-04** | **静默换后端**：换后端发生在写账本之前，或账本写失败仍继续生成（违反 I1） | 断言「返回对象里有 notice 字段」 | 把 `recordSelfHeal` 打桩为抛错，再调完整自愈路径，打印 `genCalls` 与阶段 `status` | `genCalls > 0` 即证伪成立（**这是「禁止静默换后端」唯一的硬证据**：只要生成发生了，账本里必须有行） |
| **RT-05** | **自愈越权**：`mode:'allow-paid'` + `allowPaidSwitch:true` 时连 `moderation` 也能换（绕过 I4 红线） | 只测默认配置 | 临时 config 写 `video.selfHeal.mode='allow-paid', allowPaidSwitch=true`，对 11 类错误逐个跑 `healProfile`/`planSelfHeal` | `moderation`/`auth`/`quota`/`client`/`unknown` 任一 `switchAllowed===true` 或 `genCalls > 0` 即证伪成立 |
| **RT-06** | **指纹被污染**：自愈状态写进了非 VOLATILE 的节点数据 → `input_fp` 变化 → 下游全量重算 | 不测指纹 | 写一次自愈状态，前后各调 `inputFingerprint()`，打印两次值 | 两次不相等即证伪成立 |
| **RT-07** | **批处理误伤被筛掉的项**（危险 H9）：批处理用 `items` 全量而非 `visibleItems` | 只测「选中 3 项处理 3 项」 | 构造「筛选后可见 2 项、`S.selection` 含 40 项」，调用 `batchDelete({dryRun:true})` 或埋桩 `fetch` 统计实际请求数 | 实际处理数 `>2` 即证伪成立（用户看到 2 个却删了 40 个） |
| **RT-08** | **批处理绕过审批闸门**：实现偷用 `POST /api/canvas/run` / `/api/canvas/run-node` | 只测正常路径 | `grep -nE "/api/canvas/run(-node)?['\"\`]" web/lib/canvas-select.js web/views/actors.js` + 运行时 monkey-patch `fetch` 断言零调用 | grep 有命中，或运行时调用了这两个路径即证伪成立（**付费可被无闸门触发**） |
| **RT-09** | **批删留脏连线**：只调 `DELETE /api/canvas/node/:id`，未调 `DELETE /api/canvas/nodes/:id/links` | 只断言「节点没了」 | 建 A→B 连线，`batchDelete({mode:'detach'})` 后 `SELECT COUNT(*) FROM canvas_links WHERE from_node=? OR to_node=?` | 计数 `>0` 即证伪成立（与 UI 文案「连线一并清理」矛盾） |
| **RT-10** | **字幕兼容破功**：把 `legacy` 默认改成 `cjk`，或把 `wrapCjkLegacy` 的 `.length` 改成码点 | 只测新算法 | ① 读 `loadConfig().finish.subtitleWrap` 必须 `'legacy'`；② 对 ≥40 条语料断言 `wrapSubtitles(t,{lineBreakMode:'legacy'}).text === 冻结基线`；③ `grep -n 'line.length' src/subtitles.js` 必须命中、`[...line].length` 在该函数内不得出现 | 任一条不成立即证伪成立（既有 2098 断言与交付物时间码都会漂移） |
| **RT-11** | **安全区联动擅自改默认**：`subtitleAutoLayout` 默认 true，导致竖屏字幕被强制切成 9 字/行 | 只测开启后的联动 | 不传 `applySafeAreaLimit` 时断言 `subtitleLayout({presetId:'douyin'}).maxCharsPerLine===18`；再断言 `buildSRT(固定 shots)` 的 SRT 与冻结基线**逐字节相同** | 得到 `9`，或 SRT 与基线有任一字节差异即证伪成立 |
| **RT-12** | **canvas-perf「顺手优化」**：`pad/zoom` 化、裁剪闭区间改半开、`width=0` 兜底全可见 | 只测「正常缩放下的 drawn」 | 四条反例断言：`viewportOf({zoom:0.05}).x0 === -panX-50` 与 `{zoom:8}` 相同；`width=0` 时 `cullStats().drawn` 极小；**相切矩形**上 `viewClipKeep===true` 而 `marqueeHitIds([item],相切矩形)` 为空 | 任一条不成立即证伪成立（LOD 解码量与命中/框选行为都会静默漂移） |
| **RT-13** | **阈值复制漂移**：测试与实现各写一份 `0.22`，改一处不报警 | 测试里写死数值 | 断言测试源码里不出现裸 `0.22` / `0.5` / `50`（改为从模块 import `LOD_THRESHOLDS`、`CULL_PAD`），再断言 `lodLevelFor(LOD_THRESHOLDS.mid - 1e-9)===0`、`lodLevelFor(LOD_THRESHOLDS.mid)===1` | 改动 `LOD_THRESHOLDS.mid` 后测试仍全绿即证伪成立（阈值单源失效） |
| **RT-14** | **测试假绿**：`try/catch` 吞异常、缺服务时 skip 计通过、只统计条数 | 把失败写成 pass | 对每个新套件：故意破坏一处（例如临时改一个期望值为错）后重跑，必须 `exit=1` | 破坏后期望 `exit=1`；若仍 `exit=0` 即证伪成立（套件无判别力） |
| **RT-15** | **模块名冲突导致「测到空气」**：`import('../src/selfheal.js')` 拿到 `undefined`（实现在 `src/self-heal.js`），弱断言下假通过 | 断言写成 `typeof M !== 'object'` 之类 | 每个新套件的**第 1 条**断言必须是导出存在性：`typeof M.planSelfHeal === 'function'` 等逐名检查 | 任一导出为 `undefined` 且套件仍 `exit=0` 即证伪成立（§1.4 的 N1/N2/N3 三处冲突必须先裁决） |

---

## 9. 风险与残留（本卡只记录，不修）

| # | 风险 | 事实 | 影响 | 处置 |
|---|---|---|---|---|
| **RK1** | **卡面与契约三处命名冲突**（§1.4 N1/N2/N3） | T-203 `src/self-heal.js` vs T-102 `src/selfheal.js`；T-207 `src/subtitle-wrap.js` vs T-104 `src/subtitles.js`；T-206/T-210 `.test.mjs` vs 仓库既有 22 个 `.js` | 测试可能 import 到空模块而假通过（RT-15） | 建议总军师在 W2 开工前裁决并回写任务卡；无论选哪个，测试第 1 条断言必须是导出存在性 |
| **RK2** | **`server.js` / `web/views/actors.js` 是集成线独占** | 本卡写入范围只有本文件；`verify-all.sh` 也未加新阶段 | A/C 线的接线（路由注册、批处理入口）不在任何实现卡范围内的话会「有逻辑没入口」 | 需总军师明确「谁改 `server.js`（注册 `/api/schedules`）与谁改 `actors.js`（接线批处理）」，否则 §4.3 的 C13–C30 永远无法执行 |
| **RK3** | **`env FACTORY_SCHEDULER=off` 与 `cfg.schedules.enabled` 的优先级** | T-101 §10.1 规定 env 优先 | 若测试环境误设该变量，A 线全部 tick 类用例会静默变成 `{enabled:false}` 并「看似通过」 | 测试必须显式断言「未设 env 时 `enabled!==false`」，并在 `before` 阶段 `delete process.env.FACTORY_SCHEDULER` |
| **RK4** | **`monthly` 31 号语义易被误解为「每月至少跑一次」** | T-101 §7.1：该月无 31 号则跳过、不顺延 | 用户以为排产失灵 | 测试断言跳过语义 + `scheduleSummary` 必须写出该语义（A12） |
| **RK5** | **月度上限不含 LLM 花费** | `src/guard.js:32-42` 只记 images/videos/ttsChars | 「有预算闸门就一定不超支」是**错的**；排产免费阶段的 token 成本不受约束 | 测试不得断言「一定不超支」；界面文案不得宣称（属文案门禁，记入 T-107） |
| **RK6** | **`retry.js` 不新增 kind，部分降级语义报错落到 `unknown`** | 例：`通用视频模板里没有 {{lastImage}} 占位符`（`src/video.js:221`）→ `unknown` → `hold-human` | 该场景**不会**自愈（设计上可接受，但用户会觉得「没换」） | B 线用 T-102 §2.4 速查表 12 条作为回归基线（B21），把该口径**锁死**而不是「修正」 |
| **RK7** | **`src/backend-fit.js:77` 的 `supportsFirstFrame` 恒真** | 源码写的是「模板匹配结果 或 常量真」，因此恒为真 | 直接把该字段用于 C2 会「以为换过去支持首帧」，产出文生视频 | B07 必须构造「需要尾帧 + 模板无 `{{lastImage}}`」反例；实现方需自行检查模板占位符 |
| **RK8** | **`removeCanvasNode` 不清连线**（`src/modules/actors.js:299`） | 与 UI 文案矛盾 | 脏数据累积 | C20 强制断言连线清零；实现必须显式调 `DELETE /api/canvas/nodes/:id/links` |
| **RK9** | **`restoreSnapshot` 的 `allowEmpty` 恒被或真值兜底**（`src/snapshots.js:168`） | 传入的 `allowEmpty` 被「或真」兜底后恒为真 | 一张空快照可整体清空非空画布 | 本卡只记录（T-103 §8 R5）；C 线测试**不得**制造空快照路径 |
| **RK10** | **`canvas_links` 不在撤销快照内**（`web/views/actors.js:2595-2611`） | 批删连带删的连线，`Ctrl+Z` 回不来 | 用户误以为可撤销 | C20 的 evidence 必须包含「连线无法用撤销恢复」的提示文案断言 |
| **RK11** | **M6 的性能预算断言可能 flaky** | 200 卡 ≤1ms 在慢机器/高负载下可能不达标 | 诱发「改期望凑绿」（禁止项） | E18 只断言**预算上界**并把实测 ms 作为 evidence 打印；若在 L2/L3 已跑满负载时仍超标，记为风险而非失败重跑 |
| **RK12** | **L3 需要一个正在跑的 8788 且不得重启** | 本轮铁律禁止 start/restart | Python 审计若服务未起则 skip | 必须记为「未执行」；由总军师安排在全部实现卡停写后统一跑 L3/L4 |

---

## 10. 验收对照（T-106 `acceptance_criteria` 逐条）

| 卡片验收点 | 落点 | 状态 |
|---|---|---|
| 每条线 ≥6 条用例（含边界/反例/中文报错断言） | §2（A 线 **24** 条）· §3（B 线 **21** 条）· §4（C 线 **30** 条：A 组 12 + C/D 组 15 + E 组 3）· §5（D 线 **19** 条）· §6（E 线 **18** 条）——每条线均含「边界」「反例」「中文报错」三类，且每线单列小节「易假绿点」 | ✅ |
| 给出回归策略：哪些既有套件必须全绿 | §7.1（25 阶段 / 2098 项断言基线表）· §7.2（每线辐射面 + 点名到行的不可改红断言）· §7.3（L1–L4 分层门禁，替代 `verify-all.sh`）· §7.4（断言计数守恒与基线采集命令）· §7.5（明确不做） | ✅ |
| 给出「红队证伪点」清单 | §8（**15** 条，每条含：失败假设 / 假绿手法 / 可复制命令 / 判定标准；全部指向临时库，不污染真实库） | ✅ |
| `quality_checks`：文件存在 | 见附录 A | ✅ |
| `evidence_required`：用例矩阵摘要 | §0 速览表（5 线 × 用例数 24/21/30/19/18，**合计 112 条**；类型分布：边界 32 · 反例 32 · 护栏 25 · 正例 15 · 中文报错 5）+ 各节矩阵表 | ✅ |

---

## 附录 A：本报告的证据（命令 + 原始输出）

```bash
cd /home/linsheng/Desktop/ai-video-factory
node -e "require('node:fs').accessSync('strategist/reports/T-106-test-plan.md')" && echo "quality_check: OK"
wc -l strategist/reports/T-106-test-plan.md
grep -c '^| [A-E][0-9][0-9] ' strategist/reports/T-106-test-plan.md     # 用例行数
ls -l strategist/reports/T-106-test-plan.md
md5sum web/views/actors.js                                              # E 线零改动基线：a510a8211f87fb8b4a6ffd473d029029
```

```text
（原始输出见 strategist/runs/T-106.json 的 evidence.commands[].output_tail）
```

## 附录 B：临时库 / 离线假实例清单（五线共用）

| 线 | 需要临时库 | 需要假实例 | 需要服务 | 备注 |
|---|---|---|---|---|
| A | ✅（`schedules`/`schedule_runs`/`jobs`/`app_config` 租约） | ✅ LLM mock + image/video placeholder | ❌ | `tickSchedules({rows})` 可免插库测纯判定 |
| B | ✅（`selfheal_events`） | ✅ `probeOf`/`factsOf` + 生成调用计数器 | ❌ | 「调用计数 = 0」是核心证据 |
| C | ✅（`canvas_nodes`/`canvas_groups`/`canvas_links`/`canvas_snapshots`） | ✅ stub `fetch` / `mkExec`（照 `tests/test-graph.js:74-88`） | ❌（纯函数部分完全不需要） | C13–C30 需先完成 `actors.js` 接线 |
| D | ❌（纯计算） | ❌ | ❌ | 唯一的 IO 是 `buildSRT` 的字符串产出 |
| E | ❌（纯函数） | ❌ | ❌ | 可直接 `import('../web/lib/canvas-perf.js')` |

> 本卡为**测试计划交付**，未新增/修改任何源码或测试文件，未新增依赖，未启动/重启服务，未运行 `./scripts/verify-all.sh`。
