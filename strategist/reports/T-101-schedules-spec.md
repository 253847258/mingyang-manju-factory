# T-101 定时排产（schedules）实现契约

- 任务卡：`strategist/tasks/T-101.yaml`（角色：架构/运维/文档军师）
- 下游消费者：`T-201`（`src/schedules.js`）、`T-202`（`tests/test-schedules.js`）、`T-401`（`src/routes/schedules.js` + `server.js` 注册）、`T-402`（`web/views/render.js` 排产入口）、`T-108`（运维与恢复）、`T-107`（安全面）
- 本文只做契约，不含实现代码；所有函数签名、表结构、字段名、中文文案以此文为准。
- 结论先行：**排产不引入任何新依赖、不新增常驻进程、不改 `db.js` 的 `SCHEMA_VERSION`；幂等由 `schedule_runs` 的 `(schedule_id, window_key, trigger)` 唯一索引在数据库层兜底；「暂停不降级为堆积」是不可协商的不变量。**
- 与并行产出的 T-108（运行与恢复方案）已做逐条对齐，字面差异与待裁决项见 §15。

---

## 0. 侦察事实（写契约前已核对源码，禁止凭想象写 API）

| 事实 | 出处 | 对契约的约束 |
| --- | --- | --- |
| 队列暂停状态存 `app_config.jobs:paused`，暂停期间 `pump()` 直接 return，排队任务留在 `pending`，恢复时 `resumeQueues()` 把所有类型重新泵一遍 | `src/jobs.js:15-66,147-156` | 排产**不能**在暂停期间建 job：否则恢复瞬间会一次性灌爆队列（见 §8） |
| `pauseQueues({reason,by,scope})` 会写 `jobs:pause-log`，决策时间线第 ⑤ 段会把它摊开 | `src/jobs.js:34-56`、`src/decisions.js:143-156` | 排产自动暂停必须走 `pauseQueues`（by:`system`），复用既有时间线与文案 |
| 队列按 `type` 分桶，`studio` 类型的既有用法是 `limit:1`（一条流水线独占） | `src/routes/studio.js:15-40` | 排产触发的任务用 `type:'studio', limit:1`，天然与人工任务串行、共享暂停闸门 |
| 预算：`checkBudget()` 在「本月已用+本次预估 > monthlyCap」时 `blocked:true`（提交前拒绝）；`shouldAutoPause()` 在**同一条件**下返回 `pause:true`（暂停整个队列）；`checkProductionBudget()` 管单次制片上限 | `src/guard.js:82-107,188-204,215-228` | 排产把「本次拒绝」与「全局暂停」分成两级闸门，不自己造第二套预算算法（§8） |
| 制片侧已有同款闸门先例：`studio.autoPauseGate()` = 暂停态拦截 → 付费阶段按 `estimate.keyframeCalls/videoCalls` 估算 → `shouldAutoPause` → `pauseQueues(by:'system')` | `src/studio.js:966-987` | 排产闸门与它保持同形、同文案风格，避免两套语义打架 |
| `estimateProduction({spec})` 返回 `{shots, keyframeCalls, videoCalls, totalCalls, seconds, amount, costLevel, priced, note}` | `src/studio.js:366-395` | 排产预算估算直接复用它，不自算镜数 |
| `runPipeline(id,{until,force,provider,offline,onLog})` 内部对免费阶段也会检查 `pauseState()`，付费阶段必须人工批准+确认码 | `src/studio.js:891-940,970-987` | 定时不改付费红线；`until` 默认可给 `'all'`，因为闸门在流水线内部 |
| `db.js` 暴露 `all/get/run/nextId(prefix,seqName)`，`nextId('S','schedule')` → `S-0001`；表结构集中在 `SCHEMA` 常量里，`SCHEMA_VERSION = 13` | `src/db.js:20,339-405` | **写范围里没有 `db.js`**（全部 34 张卡都没授权）→ 排产表必须由 `src/schedules.js` 自建（照抄 `studio.ensureStudioSchema()` 套路，`src/studio.js:60-96`） |
| `config.js` 里有 `budget.monthlyCap/confirmOver/productionCap/storage` 等，但**写范围里没有 `config.js`** | `src/config.js:10-174` | 排产默认值写死在 `src/schedules.js` 常量里，允许被 `loadConfig().schedules` 覆盖（用户可在设置页写 config.json，无需改代码） |
| `http.js` 的 `match()` 按注册顺序线性匹配，先命中先返回，路径段数必须相等 | `src/http.js:79-94` | `/api/schedules/runs` 与 `/api/schedules/preview` 必须**先于** `/api/schedules/:id` 注册（§9 已标注） |
| `run()` 返回 `{changes,lastInsertRowid}`，`INSERT OR IGNORE` 命中唯一索引时 `changes===0`（本机 Node v24.18.0 实测） | 实测 `node:sqlite` | 幂等预留用 `changes` 判定，不靠先 SELECT 后 INSERT（避免并发竞态） |
| `Intl.DateTimeFormat(tz, {hourCycle:'h23'})` 可用；非法时区抛 `RangeError: Invalid time zone specified`；`hour12:false` 在午夜会给出 `24:00` | 实测 Node v24.18.0 | 时区换算用 `formatToParts` + `hourCycle:'h23'` + try/catch 转中文报错（§6） |
| `/api/jobs-stream` 只转发 `job` 与 `job:log` 两个事件 | `src/routes/meta.js:270-283` | 排产自建事件名只供进程内订阅；前端靠「排产建的是普通 studio job」+ 轮询 `/api/schedules` 感知（§9.4） |
| `/api/export` 与 `/api/import` 只覆盖演员/小说/剧本相关表 | `src/routes/meta.js:286-330` | 备份不包含排产表 → 记入风险（§13） |

---

## 1. 不可协商的不变量（实现与测试都按这 6 条判）

1. **同一窗口至多触发一次**：`(schedule_id, occurrence_at)` 唯一；并发 tick、进程重启、手动与自动撞车都只能产生一个 job。
2. **暂停不降级为堆积**：队列处于暂停态时排产**不建 job**（只记一条 `skipped_paused`），恢复后不自动补跑（除非显式开 `catchup_after_pause`）。
3. **水位线单调递增**：`next_run_at` 只在评估/触发时向前推进，永不回退；重算后必须 `> 上一次的 next_run_at`。
4. **付费红线不因定时而消失**：定时触发的流水线跑到付费阶段仍然停下等「人工批准 + 确认码」。
5. **纯函数可测**：所有「算下一次 / 判该不该跑」的函数都把 `now` 作为参数注入，内部不读 `Date.now()`；只有 `startScheduler()` 里允许出现 `setInterval`。
6. **中文报错、中文注释、零新依赖**：非法时区/非法 cron/非法 kind 一律抛中文 `Error`，路由层包成 `badRequest`（`src/http.js:22`）。

---

## 2. 数据模型

### 2.1 `schedules`（排产定义）

必须由 `src/schedules.js` 导出的 `ensureSchedulesSchema()` 幂等创建（`CREATE TABLE IF NOT EXISTS` + 缺列 `ALTER TABLE` 兜底），**不得**改 `src/db.js`。

```sql
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,                          -- S-0001（nextId('S','schedule')；与 T-108 §3.1 的示例 `sched:S-0001:…` 对齐）
  name TEXT NOT NULL,                           -- 人类可读名，≤60 字
  enabled INTEGER NOT NULL DEFAULT 1,           -- 1=启用 0=停用（用户的本条开关）
  kind TEXT NOT NULL,                           -- once|interval|daily|weekly|monthly|cron
  cron TEXT,                                    -- kind=cron：5 段简版表达式（§7）
  interval_minutes INTEGER,                     -- kind=interval：1..10080
  at_time TEXT,                                 -- daily/weekly/monthly：'HH:MM'
  weekdays TEXT,                                -- weekly：'0,1,3'（0=周日 … 6=周六）
  day_of_month INTEGER,                         -- monthly：1..31
  once_at TEXT,                                 -- once：目标窗口（UTC ISO 秒级；写入时由 tz 墙钟换算）
  anchor_at TEXT,                               -- interval 的对齐基准（UTC ISO 秒级，默认=创建时刻向下取整到分钟）
  tz TEXT NOT NULL DEFAULT 'Asia/Shanghai',     -- IANA 时区名；必须能用 Intl 构造成功
  mode TEXT NOT NULL DEFAULT 'new_production',  -- new_production | existing_production
  target TEXT NOT NULL,                         -- JSON：{brief,spec,provider,offline,until,skill,productionId}
  miss_policy TEXT NOT NULL DEFAULT 'skip',     -- skip | catchup | catchup_all
  catchup_max INTEGER NOT NULL DEFAULT 1,       -- 单次 tick 最多补跑几个窗口，0..50
  grace_min INTEGER NOT NULL DEFAULT 5,         -- 宽限：到点后多少分钟内仍按「正常到点」而不是「错过」
  skip_if_running INTEGER NOT NULL DEFAULT 1,   -- 上一个排产任务未结束时不叠跑
  catchup_after_pause INTEGER NOT NULL DEFAULT 0, -- 恢复队列后是否补跑暂停期间错过的窗口
  budget_guard INTEGER NOT NULL DEFAULT 1,      -- 触发前是否过预算闸门
  retry_failed_max INTEGER NOT NULL DEFAULT 1,  -- 同一窗口因建 job/建项目失败允许的额外重试次数
  next_run_at TEXT,                             -- 权威水位线（UTC ISO 秒级）；NULL=没有未来窗口
  last_run_at TEXT,                             -- 最近一次实际触发时刻
  last_occurrence_at TEXT,                      -- 最近一次触发对应的窗口
  last_job_id TEXT,                             -- 最近一次任务 id
  last_production_id TEXT,                      -- 最近一次产出的制片项目 id
  last_status TEXT,                             -- fired|skipped_paused|skipped_budget|skipped_running|skipped_no_target|error
  last_error TEXT,
  fire_count INTEGER NOT NULL DEFAULT 0,        -- 累计触发次数
  skip_count INTEGER NOT NULL DEFAULT 0,        -- 累计跳过次数（闸门拦下）
  miss_count INTEGER NOT NULL DEFAULT 0,        -- 累计错过的窗口数（按策略放弃的）
  created_by TEXT DEFAULT 'human',              -- human | agent | system
  created_at TEXT, updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(enabled, next_run_at);   -- tick 的主查询
CREATE INDEX IF NOT EXISTS idx_schedules_created ON schedules(created_at DESC);    -- 列表默认排序
```

字段语义要点：

- `enabled` 与「队列暂停」是**两个维度**：`enabled` 是「这条排产要不要跑」，暂停是「整座工厂的闸门」。列在 §8 的交互表里。
- `next_run_at` 是唯一水位线，`last_*` 只是展示与审计用；**判定只看 `next_run_at`**（不解析 `last_run_at` 反推，避免语义分叉）。
- `target` JSON 结构（与 `createProduction` 的入参对齐，`src/studio.js:321`）：

```jsonc
{
  "brief": "一句话需求（mode=new_production 时至少给它或 spec）",
  "spec": { "episodes": 3, "episodeSeconds": 60, "ratio": "9:16", "reuseActors": true },
  "provider": null,          // LLM provider 覆盖（null=用全局配置）
  "offline": false,          // true=离线规则兜底（自检/演练用）
  "skill": null,             // 技能 id（见 GET /api/skills）
  "until": "all",            // 跑到哪个阶段为止；默认 'all'（付费阶段仍会停下等批准）
  "productionId": "PR-xxx"   // 仅 mode=existing_production 用：对既有项目重跑（例如每周重跑质检）
}
```

- 时间字段统一 **UTC ISO、秒级截断**（`YYYY-MM-DDTHH:MM:SSZ`），比较全部用字符串比较（定长 ISO 的字典序等于时间序），与既有 `plan.expires_at <= nowISO()` 的写法一致（`src/studio.js:907`）。

### 2.2 `schedule_runs`（每次「到点判定」一行，幂等与审计的唯一证据）

```sql
CREATE TABLE IF NOT EXISTS schedule_runs (
  id TEXT PRIMARY KEY,                    -- RUN-0001（nextId('RUN','schedule_run')）
  schedule_id TEXT NOT NULL,              -- 对应 schedules.id
  window_key TEXT NOT NULL,               -- 本次窗口起点（UTC ISO 秒级）；手动触发为触发时刻
  idem_key TEXT,                          -- = `sched:{schedule_id}:{window_key}`（与 T-108 §3.1 的任务幂等键同形）
  trigger TEXT NOT NULL DEFAULT 'auto',   -- auto | manual
  status TEXT NOT NULL,                   -- fired|deduped|skipped|missed|failed（枚举与本表唯一键以 T-108 §3.6 为准）
  reason_code TEXT,                       -- 机器可读判定码（§5.3）；status 粗粒度、reason_code 细粒度
  reason TEXT,                            -- 中文人话（直接给界面/审计）
  attempts INTEGER NOT NULL DEFAULT 1,    -- 同一窗口的尝试次数（failed 时可重试）
  miss_count INTEGER NOT NULL DEFAULT 0,  -- 本次评估连带放弃的窗口数
  job_id TEXT, job_status TEXT,           -- job_status：对账回写 queued|running|done|error|canceled（§10.3）
  production_id TEXT,
  estimate TEXT,                          -- JSON：estimateProduction 的关键字段（amount/keyframeCalls/videoCalls/costLevel）
  producer TEXT DEFAULT 'scheduler',
  at TEXT,                                -- 判定时刻（UTC ISO）
  fired_at TEXT, created_at TEXT, updated_at TEXT
);
-- 唯一键（与 T-108 §3.6 一致）：同一窗口无论 tick 多少次、重启多少次，只有一行台账
CREATE UNIQUE INDEX IF NOT EXISTS idx_sched_runs_window ON schedule_runs(schedule_id, window_key, trigger);
CREATE INDEX IF NOT EXISTS idx_sched_runs_at ON schedule_runs(at DESC);
CREATE INDEX IF NOT EXISTS idx_schedule_runs ON schedule_runs(schedule_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_schedule_runs_status ON schedule_runs(status, created_at DESC);
```

> 关于唯一键：T-108 定的是 `(schedule_id, window_key)`。这里**加了 `trigger` 列**并纳入唯一键，唯一目的是让「自动窗口」与「手动立即跑」（`manual:` 前缀窗口）不互相顶掉；除此之外与 T-108 完全一致（见 §15 合并说明）。

`status` 取值（粗粒度，5 个值，与 T-108 §3.6 一致）+ `reason_code`（细粒度，§5.3）：

| status | 含义 | `reason_code` 示例 | 是否推进水位线 |
| --- | --- | --- | --- |
| `fired` | 已建项目并入队（`job_id` 有值），后续任务终态写在 `job_status` | `due` | 是 |
| `deduped` | 撞上已有窗口，未重复触发 | `skipped_deduped` | 否 |
| `skipped` | 闸门拦下，窗口作废 | `skipped_paused` / `skipped_budget` / `skipped_storage` / `skipped_running` / `skipped_disabled` / `skipped_no_target` | 是（默认策略） |
| `missed` | 按 `miss_policy` 主动放弃的过期窗口（可能一行记多个，用 `miss_count`） | `skipped_missed` | 是 |
| `failed` | 触发过程本身失败（建项目/入队抛错），`attempts` 未超 `retry_failed_max` 时下一轮可重试 | `error_trigger_failed` | 否（保留窗口待重试） |

> 内部实现细节：为在并发下原子去重，`fireSchedule` 会先插一行 `status='failed'`、`reason_code='pending'` 的**预留行**再建 job。故意用 `failed`（「未完成」语义）而不是新增状态，有两个好处：① `status` 枚举与 T-108 完全一致，不引入第 6 个值；② 进程若在入队途中被杀，下一轮 tick 会看到 `failed` 且 `attempts < 1 + retry_failed_max`，从而**重试同一窗口**，窗口不会被悄悄丢掉。入队成功后改写为 `fired`；被闸门拦下时改写为 `skipped`/`deduped`。

---

## 3. 模块与导出契约（T-201 必须逐字实现这些名字）

文件：`src/schedules.js`（ESM，`export function` 风格，与既有代码一致）

```js
// ---- 常量 ----
export const SCHEDULE_KINDS = ['once', 'interval', 'daily', 'weekly', 'monthly', 'cron'];
export const MISS_POLICIES = ['skip', 'catchup', 'catchup_all'];
export const SCHEDULE_RUN_STATUSES = ['fired', 'deduped', 'skipped', 'missed', 'failed'];   // §2.2（与 T-108 §3.6 一致）
export const SCHEDULE_RUN_REASON_CODES = [...];       // §5.3 的 reason_code 全集
export const SCHEDULE_DEFAULTS = {
  enabled: true,          // 总开关（env FACTORY_SCHEDULER=off 优先，见 §10.5）
  tickSeconds: 60,        // tick 周期（T-108 §2 用的名字；内部换算成 ms）
  tickMs: 60000,          // 兼容写法：给了 tickMs 就以它为准
  defaultTz: 'Asia/Shanghai',
  catchup: false,         // 新建排产时「未显式给 miss_policy」的默认来源：true→catchup，false→skip
  maxCatchup: 1,          // 新建排产时 catchup_max 的默认值（T-108 §2 命名）
  graceMin: 5,
  skipIfRunning: true,
  catchupAfterPause: false,
  maxDayScan: 1462,       // nextOccurrence 最多向后扫 4 年（覆盖闰年 2/29）
  maxCatchupScan: 64,     // 单次评估最多枚举的到期窗口数（防停机一年后枚举 50 万次）
  runHistoryLimit: 50,
  allowManualTick: true,  // POST /api/schedules/tick 是否可用
  leaseTtlSeconds: 180,   // 实例租约有效期（3× tick），见 §10.5
};

// ---- 建表 ----
export function ensureSchedulesSchema() {}            // 幂等；返回 boolean（true=本次建了）
export function schedulesConfig(cfg = loadConfig()) {} // 默认值与 loadConfig().schedules 深合并（不写 config.js）

// ---- 纯函数：时间与时区（§6）----
export function zonedParts(date, tz) {}               // -> {y,mo,d,h,mi,s,weekday}
export function zonedToUtc(wall, tz) {}               // -> {ok, date|error, note}
export function formatInTz(date, tz) {}               // -> '2025-06-01 09:00'（时区墙钟，界面用）
export function isoSeconds(date) {}                   // -> 秒级 UTC ISO（水位线与窗口键统一用它）

// ---- 纯函数：窗口计算（§7）----
export function windowKeyOf(scheduleId, occurrenceAt, trigger = 'auto') {}  // -> 窗口键（= schedule_runs.window_key 的来源）
export function idemKeyOf(scheduleId, windowKey) {}   // -> `sched:{scheduleId}:{windowKey}`（写入 schedule_runs.idem_key）
export function parseCron(expr) {}                    // -> {ok, error?, sets?, text?}
export function cronMatches(date, sets, tz) {}        // -> boolean（按 tz 墙钟匹配）
export function nextOccurrence(schedule, afterISO, opts) {} // -> {ok, at|null, error?, scanned}
export function nextRuns(schedule, { count = 5, from } = {}) {} // -> [{at, inMinutes, text}]

// ---- 判定（核心，§5）----
export function evaluateSchedule(s, nowISO, ctx) {}   // 纯判定，不落库、不建 job
export function tickSchedules({ now, dryRun, dry_run, limit, rows } = {}) {} // 扫一轮；rows 是测试注入点
                                                      // dryRun 为准（与 T-108 同形），dry_run 兼容别名

// ---- 触发（写库）----
export async function fireSchedule(scheduleId, opts) {} // §5.4，含幂等预留与闸门

// ---- CRUD ----
export function listSchedules({ enabled, limit = 50 } = {}) {}
export function getSchedule(id) {}                    // 水合：解析 target/estimate JSON、补 next_run_text
export function createSchedule(input, { by = 'human' } = {}) {}   // 校验失败抛中文 Error
export function updateSchedule(id, patch) {}          // 时间字段变更时重算 next_run_at
export function deleteSchedule(id, { purge = false } = {}) {}     // purge=1 连 runs 一起删
export function listScheduleRuns({ scheduleId, limit = 50, status } = {}) {}

// ---- 供路由/运维调用 ----
export function enqueueScheduledRun({ productionId, until, offline, provider, scheduleId, occurrenceAt, idemKey }) {}
                                                      // -> jobId（复用 jobs.enqueue，type:'studio', limit:1）
                                                      // idemKey 可选：仅在将来 jobs.js 支持 idemKey 时透传（§15），当前不依赖
export function startScheduler({ tickMs, tickSeconds } = {}) {}   // -> {stop()}；唯一允许出现定时器的地方
export function readSchedulerLease(now = new Date()) {}           // -> {owner, expires_at, held}
export function acquireSchedulerLease({ owner, now = new Date(), ttlSeconds }) {}  // -> {ok, reason}
export function reconcileScheduleRuns({ scheduleId = null, limit = 200 } = {}) {} // 惰性对账（§10.3）
export function scheduleSummary(s) {}                 // 中文一句话：'每天 09:00（Asia/Shanghai）· 下次 2025-06-02 09:00'
```

**依赖方向（防循环 import）**：`src/schedules.js` 只允许依赖 `./db.js`、`./util.js`、`./jobs.js`、`./guard.js`、`./config.js`、`./studio.js`（`estimateProduction` / `createProduction` / `runPipeline` / `STAGE_IDS`）。
`src/studio.js` 在 T-402 里**不得** import `src/schedules.js`（否则成环）；需要联动时由路由层或 server.js 编排。

---

## 4. `next_run_at` 的初始化与推进规则（所有分支的唯一出口）

| 时机 | `next_run_at` 的取值 |
| --- | --- |
| 创建排产 | `nextOccurrence(s, after = now + 1s)`（`kind=once` 用 `once_at`） |
| 触发成功（`status=fired`） | `nextOccurrence(s, after = 本次 occurrence)` —— **不**用 `now`，避免长 tick 跳过中间窗口 |
| 闸门跳过（`skipped` + `reason_code=skipped_paused/budget/storage/running`） | 同上（窗口「已用过」）；理由：周期性排产的下一个窗口自然会来，不制造补跑雪崩 |
| 按策略放弃（`missed` + `reason_code=skipped_missed`） | 从**最新到期窗口**向后再算一次 |
| `kind=once` 触发成功 | `NULL` 且 `enabled=0`（并在 run 行写 `reason_code='done_once'`） |
| 手动触发（`trigger='manual'`） | **不推进**（手动是「插队跑一次」，不消费自动窗口） |
| `PATCH` 改了 `kind/cron/at_time/weekdays/day_of_month/interval_minutes/once_at/tz/anchor_at` | 重算（`nextOccurrence(after = now + 1s)`），除非 `body.keep_next_run_at === true` |
| `PATCH` 改了其他字段（name/target/enabled…） | 不动水位线 |
| `enabled` 由 0→1 | 重算（避免停用 3 个月后沿用旧水位线而立刻补跑一堆） |

---

## 5. 「到点该不该跑」判定（验收点 2 的核心）

### 5.1 到期窗口收集

```text
function collectDue(s, nowISO):
    if s.next_run_at == null:
        s.next_run_at = nextOccurrence(s, after=nowISO)      # 自愈：老数据/刚修过时间字段
        if s.next_run_at == null: return { occurrences: [], truncated: 0 }

    out = []; cur = s.next_run_at; truncated = 0
    while cur != null and cur <= nowISO:
        if out.length >= cfg.maxCatchupScan:                 # 防跑飞：停机一年 + 1 分钟间隔
            truncated += 1; cur = nextOccurrence(s, after=cur); continue
        out.push(cur)
        cur = nextOccurrence(s, after=cur)
    return { occurrences: out, truncated }                   # out 升序，out[0] 是最老的到期窗口
```

`nowISO` 与 `cur` 一律是**秒级 UTC ISO 字符串**，直接字典序比较。空集合 ⇒ 未到点，`next_run_at` 不变。

### 5.2 判定伪代码（补跑 / 跳过错过的窗口）

```text
function evaluateSchedule(s, nowISO, ctx):
    # 0) 停用：最优先，不碰任何统计
    if s.enabled != 1: return skip('skipped_disabled', '排产已停用：不触发（启用后重算下次触发）')

    # 1) 收集到期窗口
    { occurrences, truncated } = collectDue(s, nowISO)
    if occurrences.length == 0:
        return skip('not_due', `未到点：下次 ${s.next_run_at}`, { nextRunAt: s.next_run_at })

    oldest = occurrences[0]
    late_min = floor((nowISO - oldest) / 60000)               # 距最老窗口延迟了多少分钟
    on_time  = late_min <= cfg.graceMin                       # tick 抖动宽限（默认 5 分钟）
    dropped  = []                                            # 本次要放弃的窗口
    picked   = null

    # 2) 按 miss_policy 选窗口
    if on_time:
        picked = oldest                                      # 正常到点：跑最老的那个
        dropped = occurrences.slice(1)                       # 剩余（极端情况：tick 停了很久又落在宽限内）
    else:
        k = occurrences.length                               # 全部算「错过」
        switch s.miss_policy:
          case 'skip':
              dropped = occurrences                          # 一个都不补
          case 'catchup':
              picked = occurrences[k-1]                      # 只补最近一个
              dropped = occurrences.slice(0, k-1)
          case 'catchup_all':
              n = min(k, s.catchup_max)                      # 最多补 catchup_max 个
              picked = occurrences[k-n]                      # 从最近的 n 个里挑最老的先跑（保证顺序）
              dropped = occurrences.slice(0, k-n)

    miss_n = dropped.length + truncated                      # 本次遗漏计数

    # 3) 闸门（force 时由 fireSchedule 跳过，evaluate 只负责如实报告）
    st = ctx.paused ? {paused:true, reason:ctx.pauseReason} : pauseState()
    if st.paused:
        if picked != null and s.catchup_after_pause == 1:    # 显式允许「恢复后补跑」
            pass                                             # 继续往下走闸门
        else:
            return skip('skipped_paused',
              `队列暂停中（${st.reason}）：本窗口不触发；${s.miss_policy=='skip' ? '错过不补跑' : '恢复后按策略补跑'}`,
              { occurrence: picked ?? oldest, miss: miss_n, nextRunAt: advance(s, occurrences) })

    if picked == null:                                       # 全部按策略放弃
        return skip('skipped_missed',
          `已错过 ${miss_n} 个窗口（策略 ${s.miss_policy}）：不补跑，下次 ${advance(s, occurrences)}`,
          { miss: miss_n, nextRunAt: advance(s, occurrences) })

    if s.skip_if_running == 1 and ctx.running:               # 上一条流水线还没结束
        return skip('skipped_running', '上一次排产任务仍在执行：本次不叠跑（窗口作废，等下一次）',
                    { occurrence: picked, miss: miss_n, nextRunAt: advance(s, occurrences) })

    if s.budget_guard == 1:
        b = ctx.budget                                     # 由 tickSchedules 预取（见 §8）
        if b.pause or b.blocked:
            return skip('skipped_budget', b.reason, { occurrence: picked, miss: miss_n, nextRunAt: advance(s, occurrences) })

    # 4) 放行
    return { due: true, decision: 'fire', occurrence: picked,
             occurrences, missed: miss_n, nextRunAt: advance(s, occurrences),
             reasonCode: 'due', reason: on_time ? `到点触发（窗口 ${picked}）`
                                                : `补跑错过的窗口（延迟 ${late_min} 分钟，策略 ${s.miss_policy}）` }

function advance(s, occurrences):
    # 水位线推进：从最新到期窗口继续向后算；不再回调去枚举中间窗口
    return nextOccurrence(s, after = occurrences[occurrences.length - 1])?.at ?? null
```

`skip(code, reason, extra)` 返回 `{ due:false, decision:'skip', reasonCode:code, reason, ...extra }`。
`reason_code` → `schedule_runs.status` 的映射（写库时用）：`skipped_missed` → `missed`；`skipped_deduped` → `deduped`；其余 `skipped_*` 与 `error_*` 分别 → `skipped` / `failed`。

**三条取舍（写进代码注释）**：

1. **`grace_min` 默认 5 分钟**：tick 周期 60s、机器抖动、SQLite 写锁都可能让评估晚几秒；没有宽限会把「准点」误判成「错过」而按 `skip` 丢掉窗口。宽限只管「算不算准点」，不改变窗口本身。
2. **`skip` 是默认策略**：定时排产最常见的用途是「每天 9 点看一眼」，一次性补跑 3 个错过的窗口会连建 3 个项目、烧 3 份额度，属于**静默放大代价**；宁可少跑，让人显式选择 `catchup`。
3. **闸门跳过也推进水位线**（而不是「窗口保留，下一 tick 再试」）：若保留，暂停 8 小时后恢复会瞬间涌入 8 个窗口的 job，与「暂停不丢任务但也不放大」的既有语义冲突（`src/jobs.js:13`）。

### 5.3 `reason_code` 全集（机器可读）

`due` / `not_due` / `pending`（预留行）/ `skipped_disabled` / `skipped_paused` / `skipped_budget` / `skipped_production_cap` / `skipped_storage` / `skipped_running` / `skipped_missed` / `skipped_no_target` / `skipped_deduped` / `error_trigger_failed` / `error_invalid_time` / `done_once`。

（`status` 5 值粗粒度 + `reason_code` 细粒度的分工见 §2.2；界面只展示 `status` 的中文映射，审计与测试断言用 `reason_code`。）

### 5.4 `fireSchedule` 的执行顺序（幂等 + 闸门）

```text
async function fireSchedule(scheduleId, { occurrence_at=null, trigger='auto', dryRun=false, dry_run=false, force=false, now=new Date(), note='' }):
    ensureSchedulesSchema(); s = getSchedule(scheduleId)
    if !s: throw new Error(`排产不存在：${scheduleId}`)
    nowISO = isoSeconds(now)
    occurrence = occurrence_at ?? (trigger=='manual' ? nowISO : evaluateSchedule(s, nowISO, ctx).occurrence)
    if occurrence == null: return { ok:true, fired:false, reasonCode:'not_due', reason:'没有到期窗口' }

    # ① 判定（force 绕过闸门，但绝不绕过幂等）
    if !force:
        ev = evaluateSchedule(s, nowISO, ctx)
        if !ev.due and trigger=='auto': return { ok:true, fired:false, ...ev }
        # 手动触发即使未到点也允许跑（窗口用当前秒），但仍受幂等与闸门约束（force 才绕过闸门）

    if dryRun: return { ok:true, fired:false, dryRun:true, occurrence, ...ev }   # 不落库、不建 job

    # ② 预留窗口（唯一索引是唯一的原子去重手段；先写行再建 job）
    windowKey = windowKeyOf(s.id, occurrence, trigger)          # 见 §3：auto→occurrence；manual→'manual:'+occurrence
    idemKey   = idemKeyOf(s.id, windowKey)
    runId     = nextId('RUN', 'schedule_run')                   # RUN-0001
    r = run(`INSERT OR IGNORE INTO schedule_runs(id, schedule_id, window_key, idem_key, trigger, status, reason_code, attempts, at, created_at, updated_at)
             VALUES(?,?,?,?,?,'failed','pending',1,?,?,?)`, runId, s.id, windowKey, idemKey, trigger, nowISO, nowISO, nowISO)
    if r.changes === 0:
        old = get('SELECT * FROM schedule_runs WHERE schedule_id=? AND window_key=? AND trigger=?', s.id, windowKey, trigger)
        if old.status != 'failed' or old.attempts >= 1 + s.retry_failed_max:
            return { ok:true, fired:false, deduped:true, reasonCode:'skipped_deduped',
                     reason:`该窗口已处理过（${old.status}${old.reason_code ? ' / ' + old.reason_code : ''}）：幂等去重，未重复触发`, runId: old.id }
        run(`UPDATE schedule_runs SET status='failed', reason_code='pending', attempts=attempts+1, at=?, updated_at=? WHERE id=?`,
            nowISO, nowISO, old.id)                              # 同一窗口的上一次是「触发失败」→ 允许按 retry_failed_max 重试

    # ③ 建项目 + 入队（失败不改写既有产物）
    try:
        if s.mode == 'existing_production':
            projectId = s.target.productionId
            if !getProduction(projectId): -> 结算 skipped_no_target
        else:
            p = await createProduction({ brief:s.target.brief, spec:s.target.spec, offline:s.target.offline===true,
                                         provider:s.target.provider ?? null, skill:s.target.skill ?? null, createdBy:'system' })
            projectId = p.id
        jobId = enqueueScheduledRun({ productionId:projectId, until:s.target.until ?? 'all',
                                      offline:s.target.offline===true, provider:s.target.provider ?? null,
                                      scheduleId:s.id, occurrenceAt:occurrence, idemKey })
    catch (e):
        run(`UPDATE schedule_runs SET status='failed', reason_code='error_trigger_failed', reason=?, updated_at=? WHERE id=?`,
            `触发失败：${e.message}（同一窗口最多自动重试 ${s.retry_failed_max} 次，也可手动触发）`, nowISO, runId)
        run('UPDATE schedules SET last_status=?, last_error=?, updated_at=? WHERE id=?', 'failed', String(e.message).slice(0,200), nowISO, s.id)
        return { ok:false, fired:false, error: e.message, reasonCode:'error_trigger_failed' }

    # ④ 结算（水位线 + 计数）
    run(`UPDATE schedule_runs SET status='fired', reason_code='due', reason=?, job_id=?, job_status='queued', production_id=?,
         fired_at=?, estimate=?, miss_count=?, updated_at=? WHERE id=?`, ...)
    run(`UPDATE schedules SET next_run_at=?, last_run_at=?, last_occurrence_at=?, last_job_id=?, last_production_id=?,
         last_status='fired', last_error=NULL, fire_count=fire_count+1, miss_count=miss_count+?, skip_count=skip_count+?,
         enabled = CASE WHEN kind='once' THEN 0 ELSE enabled END, updated_at=? WHERE id=?`, ...)
    jobEvents.emit('schedule:fired', { scheduleId:s.id, occurrence, windowKey, jobId, productionId:projectId, trigger })
    return { ok:true, fired:true, jobId, productionId:projectId, runId, occurrence, windowKey, reasonCode:'due' }
```

跳过分支同样**写 `schedule_runs` 行**（`status='skipped'`（闸门）或 `'missed'`（策略放弃）+ `reason_code` + 中文 `reason` + `miss_count`），并在 `schedules` 上累加 `skip_count`/`miss_count`、推进 `next_run_at`；同时 `jobEvents.emit('schedule:skipped', {...})`。

**为什么要「先写 run 行再建 job」**：唯一索引是原子的；如果先建 job 再写行，两个并发 tick（或重启后补 tick）会各建一个项目/任务，去重就失效了。宁可留下一条 `failed/pending` 残行（下一轮 tick 会按 `retry_failed_max` 重试，或人工触发），也不能重复花钱。

**超时兜底**：`fireSchedule` 里 `createProduction` 走 LLM（可能几十秒）。因此 `tickSchedules` 必须用**串行 + 不可重入**守卫（即使守卫被绕过，唯一索引仍能兜底不重复花钱）：

```text
let ticking = false
function tickSchedules({ now = new Date(), dryRun = false, dry_run = false, limit = 200, rows = null } = {}):
    dry = dryRun || dry_run
    if ticking and !dry: return { ok:true, skipped:true, reason:'上一轮 tick 尚未结束（跳过，避免重叠）' }
    if env.FACTORY_SCHEDULER == 'off' or cfg.enabled == false:
        return { ok:true, enabled:false, fired:[], skipped:[], reason:'排产已关闭（配置或环境变量）' }
    if !acquireSchedulerLease({ owner: processOwnerTag() }).ok:
        return { ok:true, enabled:false, fired:[], skipped:[], reason:'另一实例正在排产（本实例只读）' }
    ticking = true
    try: ... finally: ticking = false
```

---

## 6. 时区契约（验收点 1、2 共同依赖）

- 时区用 IANA 名（`Asia/Shanghai`、`America/New_York`），实现只用 `Intl.DateTimeFormat(tz, {...})`，零依赖。
- 取墙钟必须 `hourCycle: 'h23'`（`hour12:false` 在午夜会给出 `24`，实测），且用 `formatToParts` 而不是 `format` 字符串切片。
- 非法时区：`Intl` 抛 `RangeError: Invalid time zone specified` → 一律转成中文报错：`无效时区：Bad/Zone（请用 IANA 名称，如 Asia/Shanghai / UTC）`。

```text
function zonedParts(date, tz):                      # 纯函数，已被本机 Node v24 实测
    try: fmt = cached(tz)                            # 按 tz 缓存 DateTimeFormat 实例（性能）
    catch: throw new Error(`无效时区：${tz}（请用 IANA 名称，如 Asia/Shanghai / UTC）`)
    p = {}; for part of fmt.formatToParts(date): p[part.type] = part.value
    return { y:+p.year, mo:+p.month, d:+p.day, h:+p.hour, mi:+p.minute, s:+p.second,
             weekday:'Sun|Mon|…' 映射成 0..6（0=周日） }

function zonedToUtc({y,mo,d,h,mi,s=0}, tz):
    guess = Date.UTC(y, mo-1, d, h, mi, s)
    t1 = guess - offsetOf(guess)                     # offsetOf(x) = zonedParts(x,tz) 拼回 UTC - x
    if wall(t1) == 请求的墙钟: return { ok:true, date:t1, note:'' }        # 正常；秋令重叠时这里取到**较早**的一次
    t2 = guess - offsetOf(t1)
    if wall(t2) == 请求的墙钟: return { ok:true, date:t2, note:'经二次校正' }
    return { ok:true, date:max(t1,t2),
             note:'本地时刻不存在（夏令时跳变）：已顺延到跳变后的第一个有效时刻' }
```

实测基准（T-202 可直接拿去做断言）：

| 输入（`America/New_York`） | 期望 UTC | 说明 |
| --- | --- | --- |
| `2025-03-09 02:30` | `2025-03-09T07:30:00Z` | 春季跳变，本地时刻不存在 → 顺延（当地 03:30） |
| `2025-11-02 01:30` | `2025-11-02T05:30:00Z` | 秋季重叠出现两次 → 取较早 |
| `2025-06-01 09:00` | `2025-06-01T13:00:00Z` | 常规 |
| `Asia/Shanghai 2025-01-01 00:00` | `2024-12-31T16:00:00Z` | 无 DST，固定 +08:00 |

**单调性保证**：由于 `nextOccurrence` 永远以「上一次结果」为 `after`（§4），DST 跳变最多让相邻两次触发间隔变化 1 小时，不会重复触发或永久漏触发；这一点必须有一条断言（T-202）。

---

## 7. 排产表达式（cron 简版 + 间隔）

### 7.1 `kind` 语义

| kind | 必填字段 | 语义 | 下次窗口 |
| --- | --- | --- | --- |
| `once` | `once_at`（墙钟 `'YYYY-MM-DD HH:MM'`，按 `tz` 换算） | 只跑一次 | `once_at`；触发后 `enabled=0`、`next_run_at=NULL` |
| `interval` | `interval_minutes` | 每 N 分钟 | `anchor_at + ceil((after-anchor)/step)*step`（**对齐 anchor，重启/抖动不漂移**） |
| `daily` | `at_time` | 每天 `at_time` | 当日/次日 `at_time` |
| `weekly` | `weekdays` + `at_time` | 每周指定星期 | 下一个匹配星期的 `at_time` |
| `monthly` | `day_of_month` + `at_time` | 每月 N 号 | 下一个有 N 号的月份；**该月没有 31 号就跳过该月**（不顺延到月末，保持「指定日期」语义） |
| `cron` | `cron` | 5 段简版表达式 | 见下 |

### 7.2 cron 简版语法（明确边界，避免实现各写一套）

- 段序：`分 时 日 月 周`；范围：分 `0-59`、时 `0-23`、日 `1-31`、月 `1-12`、周 `0-6`（`0`=周日，**同时接受 `7`=周日**，内部归一到 0）。
- 每个字段支持：`*`、`N`、`A-B`、`A,B,C`、`*/N`、`A-B/N`（列表元素允许是区间或步进）。
- **不支持**（必须中文报错，不许静默忽略）：秒级（第 6 段）、`MON/JAN` 名称、`@daily` 之类宏、`L/W/#/?` 扩展。
- **`日` 与 `周` 同时受限时按 OR 语义**（与 Vixie cron 一致）：`0 9 1 * 1` = 每月 1 号**或**每周一 9:00。这一点必须写进注释与测试，否则语义歧义。
- 报错文案示例：`cron 表达式非法：'0 9 * * 8'（周字段超出范围 0-6，0=周日）；支持 * / N / A-B / A,B / */N`。
- `parseCron` 返回预编译集合 `{ok, sets:{minutes:[],hours:[],days:[],months:[],weekdays:[]}, text}`，`cronMatches(parts, sets)` 只做题面匹配；不要在每次比较时重新解析字符串。

### 7.3 `nextOccurrence` 算法（性能与终止性）

```text
function nextOccurrence(s, afterISO, { maxDayScan = 1462 } = {}):
    if s.kind == 'interval': 算术解（见 §7.1），O(1)
    if s.kind == 'once':     return s.once_at > afterISO ? once_at : null
    # 其余按「本地日扫描 + 日内候选槽位升序」：
    start = zonedParts(afterISO, s.tz)
    for day in 0..maxDayScan:                                   # 最多 4 年，覆盖闰年 2/29 与稀有组合
        wallDay = start 日期 + day 天
        if 月/日/周（cron 为 OR 语义）不匹配: continue
        for hour of 候选小时（升序）:
            for minute of 候选分钟（升序）:
                t = zonedToUtc({...wallDay, hour, minute}, s.tz)
                if t.date > afterISO: return { ok:true, at:isoSeconds(t.date), scanned:day }
    return { ok:false, at:null, error:'在 4 年内找不到下一次触发：请检查表达式（例如 2 月 30 日永远不存在）' }
```

复杂度：匹配日的槽位数 ≤ 24×60；不匹配的日期只做一次日历判断 → 最坏约 `1462 × 1440` 次 Date 构造（仅当表达式极其罕见时），常见表达式（每日/每周）首日即返回。**候选槽位集合在解析阶段预计算并缓存于 schedule 对象**（不每次重算）。

---

## 8. 与队列暂停、月度上限的交互（验收点 3）

### 8.1 两级预算闸门（复用既有算法，不自造）

```text
function budgetGate(s, nowISO):
    if s.budget_guard != 1: return { ok:true }
    est = await estimateProduction({ spec: s.target.spec })      # src/studio.js:366
    # ① 全局闸门（与 studio.autoPauseGate 同源同响应）
    if shouldAutoPause({ images: est.keyframeCalls, videos: est.videoCalls }):
        pauseQueues({ reason: check.reason, by:'system' })       # 复用既有自动暂停（进 jobs:pause-log → 决策时间线可见）
        return { ok:false, pause:true, reason: check.reason }
    # ② 存储闸门（T-108 §3.7 的顺序：暂停 → 预算 → 磁盘）
    st = checkStorage()                                          # src/guard.js:164（超 maxGB 直接拒绝新任务）
    if st.blocked: return { ok:false, blocked:true, code:'skipped_storage', reason: st.reason }
    # ③ 本次预算闸门（防其他入口已把台账推高）
    if checkBudget({...}).blocked: return { ok:false, blocked:true, code:'skipped_budget', reason: check.reason }
    # ④ 单次制片上限（定时任务不该悄悄花超单次上限的钱）
    if checkProductionBudget({ amount: est.amount }).ok === false:
        return { ok:false, blocked:true, code:'skipped_production_cap', reason: checkProductionBudget(...).reason }
    return { ok:true, estimate: est }
```

闸门顺序固定为 **暂停 → 存储 → 预算（月度）→ 预算（单次）**，理由：暂停是人的意志（最先），存储是硬约束（磁盘满了跑什么都白跑），预算是钱（先看全局再看单次）。顺序写进代码注释与测试断言，不许各实现各的顺序。

诚实说明（写进注释）：`monthlyCap` 只覆盖**图/视频/配音**三项计费（`src/guard.js:32-42`），LLM token 未进台账 → 排产免费阶段（brief/cast/novel/script/canvas）的 LLM 花费**不受月度上限约束**；因此排产必须记录 `estimate` 并给出中文提示，不能宣称「有预算闸门就一定不超支」。

### 8.2 暂停 × 排产 的四种组合（必须逐条实现并测试）

| 场景 | 排产行为 | 记录（status / reason_code） | 恢复队列后 |
| --- | --- | --- | --- |
| 队列**未**暂停、本条 `enabled=1` | 正常触发 | `fired` / `due` | — |
| 队列**暂停**（预算自动暂停或人工暂停） | **不建 job、不建项目**（否则恢复瞬间全部 pending 一次性开跑） | `skipped` / `skipped_paused` + 中文原因（含暂停原因摘录）；`skip_count+1` | 默认**不补跑**（窗口作废）；仅当 `catchup_after_pause=1` 且 `miss_policy != 'skip'` 时才按策略补跑 |
| 本条 `enabled=0`（用户按停单条） | 不触发，`next_run_at` 不动（保留水位线） | `skipped` / `skipped_disabled`（`skip_count` 不增，避免把「用户主动停用」统计成「跳过」） | 重新启用时按 §4 重算水位线 |
| 排产任务在执行中、又到下一个窗口 | `skip_if_running=1` → 本次不叠跑（窗口作废） | `skipped` / `skipped_running` | 下一次 tick 自然进入新窗口 |
| 磁盘超上限（`checkStorage().blocked`） | 不触发 | `skipped` / `skipped_storage` | 清理磁盘后再看下一窗口 |

补充约定：

- **`enabled` 是软开关，暂停是硬闸门**：`enabled=1` 只表示「这条排产想跑」，能不能跑由 `pauseState()` 决定。UI 文案必须区分（T-402：排产面板顶部显示「队列暂停中：所有排产暂停触发」+ 恢复按钮复用既有 `POST /api/queue/resume`）。
- **排产任务与人工任务同队列同闸门**：`enqueueScheduledRun` 用 `type:'studio', limit:1`（`src/routes/studio.js:15-40` 同形），因此 `jobs.pump()` 的暂停检查是**第二道闸门**（即使排产判定漏判，任务也不会真的开跑），双保险。
- **不在排产侧调用 `resumeQueues()`**：恢复队列是人类的决定（预算是否已放开只有人知道），排产永不自动恢复。
- **暂停不影响 `schedule_runs` 的记录**：每个被跳过的窗口都留一行中文原因，保证「为什么昨晚 3 点没跑」可追溯。

---

## 9. API 形状（验收点 4）

统一前缀 `/api/schedules`，实现放 `src/routes/schedules.js`，导出 `registerSchedulesRoutes(app)`，在 `server.js` 里 `registerSchedulesRoutes(app);` 一行注册（与 `registerStudioRoutes(app)` 同风格，`server.js:63`）。
**注册顺序**：`/api/schedules/runs`、`/api/schedules/preview` 必须先于 `/api/schedules/:id`（`http.js` 首命中即返回，段数相同会互相遮蔽，`src/http.js:79-94`）。
金额/ID 复用既有 `ctx.json`/`badRequest`/`notFound`，错误一律中文。

### 9.1 `GET /api/schedules`

查询参数：`enabled`（`1|0`）、`limit`（默认 50，上限 200）。
响应：

```jsonc
{
  "ok": true,
  "now": "2025-06-01T01:00:00Z",
  "queue": { "paused": false },                       // 复用 pauseState()，让界面一眼看出「排产此刻会不会被闸门拦下」
  "schedules": [{
    "id": "S-0001", "name": "每日 9 点短剧排产", "enabled": 1, "kind": "daily",
    "cron": null, "interval_minutes": null, "at_time": "09:00", "weekdays": null,
    "day_of_month": null, "once_at": null, "tz": "Asia/Shanghai",
    "mode": "new_production", "target": { "brief": "…", "spec": { "episodes": 3 }, "until": "all" },
    "miss_policy": "skip", "catchup_max": 1, "grace_min": 5,
    "skip_if_running": 1, "catchup_after_pause": 0, "budget_guard": 1, "retry_failed_max": 1,
    "next_run_at": "2025-06-02T01:00:00Z",
    "next_run_text": "2025-06-02 09:00（Asia/Shanghai）",
    "in_minutes": 1440, "running": false,
    "last_run_at": "2025-06-01T01:00:00Z", "last_status": "fired", "last_job_id": "JOB-xxx", "last_job_status": "done",
    "last_production_id": "PR-xxx", "last_error": null,
    "fire_count": 3, "skip_count": 1, "miss_count": 0,
    "summary": "每天 09:00（Asia/Shanghai）· 下次 2025-06-02 09:00 · 上次已触发"
  }]
}
```

### 9.2 `POST /api/schedules`（创建）

请求体（snake_case，字段同表）：

```jsonc
{ "name": "每日 9 点短剧排产", "kind": "daily", "at_time": "09:00", "tz": "Asia/Shanghai",
  "mode": "new_production",
  "target": { "brief": "拍一部 3 集都市悬疑短剧", "spec": { "episodes": 3, "episodeSeconds": 60 }, "until": "all" },
  "miss_policy": "skip", "grace_min": 5 }
```

响应 `{ ok:true, schedule:{...}, next_run_text:"…" }`；校验失败 → `400 { ok:false, error:"中文原因" }`（沿用 `badRequest`）。
必做校验（全部中文报错）：

| 校验 | 报错示例 |
| --- | --- |
| `name` 非空且 ≤60 字 | `排产名称必填（≤60 字）` |
| `kind ∈ SCHEDULE_KINDS` | `kind 非法：xx（可选 once/interval/daily/weekly/monthly/cron）` |
| `interval_minutes` 整数 1..10080 | `interval 间隔必须是 1~10080 的整数分钟` |
| `at_time` 匹配 `^([01]\d\|2[0-3]):[0-5]\d$` | `at_time 必须是 'HH:MM'（24 小时制），例如 '09:30'` |
| `weekly` 至少一个 `weekdays`，取值 0..6 | `weekdays 必须是 0~6（0=周日）的列表，例如 '1,3,5'` |
| `monthly` 的 `day_of_month` 1..31 | `day_of_month 必须是 1~31（该月没有这一天时跳过该月）` |
| `cron` 可解析 | `cron 表达式非法：…（支持 * / N / A-B / A,B / */N；不支持秒级与 MON/@daily）` |
| `once_at` 为 `'YYYY-MM-DD HH:MM'` 且在将来 | `once_at 必须是 'YYYY-MM-DD HH:MM'（按 tz 解释）且晚于当前时刻` |
| `tz` 可构造 `Intl.DateTimeFormat` | `无效时区：Bad/Zone（请用 IANA 名称，如 Asia/Shanghai / UTC）` |
| `mode=existing_production` → `target.productionId` 必填且存在 | `mode=existing_production 时必须给 target.productionId，且该制片项目必须存在` |
| `new_production` → `target.brief` 或 `target.spec` 至少一个 | `请给 target.brief（一句话需求）或 target.spec（制片参数）` |
| `miss_policy ∈ MISS_POLICIES`；`catchup_max` 0..50；`grace_min` 0..1440 | `miss_policy 非法：xx（可选 skip/catchup/catchup_all）` |

创建时若 `nextOccurrence` 返回 `null` → `400 '按当前表达式算不出未来的触发时刻（请检查 cron / once_at）'`（不落库半成品）。

### 9.3 `GET /api/schedules/:id`

`{ ok:true, schedule:{...}, runs:[最近 20 条], queue:{paused} }`；不存在 → `404 排产不存在：S-9999`。
读取时先跑 `reconcileScheduleRuns({ scheduleId })`（§10.3），保证 run 行的 `job_status` 与任务终态一致。

### 9.4 `PATCH /api/schedules/:id`

局部更新（`name/enabled/target/miss_policy/catchup_max/grace_min/skip_if_running/catchup_after_pause/budget_guard/retry_failed_max/kind/cron/interval_minutes/at_time/weekdays/day_of_month/once_at/tz`）。
- 时间相关字段变更 → 重算 `next_run_at`（§4），除非 `keep_next_run_at:true`（用于「只改时区显示但不想动窗口」的极端场景）。
- 响应带 `changed:[字段名]` 与 `note:'已按新表达式重算下次触发：…'`。
- 不存在的 id → `404`。

### 9.5 `DELETE /api/schedules/:id`

默认删 `schedules` 行、**保留** `schedule_runs`（审计证据，与 `DELETE /api/studio/productions/:id` 的「删记录、留产物」风格一致）。
`?purge=1` 同时删除该排产的 runs。
响应：`{ ok:true, deleted:"S-0001", purged:false, note:'已删除排产定义；触发历史保留（加 ?purge=1 可一并清理）' }`。

### 9.6 `POST /api/schedules/:id/trigger`（手动触发）

请求体：`{ "dry_run": false, "dryRun": false, "force": false, "occurrence_at": null, "note": "" }`（两种拼写都接受，`dry_run` 优先）

- 默认 `occurrence_at = 当前整秒`，窗口键为 `manual:${occurrence_at}` → **同一秒内重复点击只会触发一次**（返回 `deduped:true` + `status=deduped`，HTTP 仍 200，便于前端重试安全）。
- `force:true` 绕过闸门（暂停/存储/预算/上一轮在跑）**但不绕过幂等**：换一秒再点即可再跑一次。
- **不推进自动水位线**（不消费自动窗口），但写 `last_run_at/last_job_id`。
- `dry_run:true` 只返回判定结果，不落库、不建项目。

响应示例：

```jsonc
{ "ok": true, "fired": true, "jobId": "JOB-xxx", "productionId": "PR-xxx",
  "runId": "RUN-0007", "occurrence": "2025-06-01T01:05:00Z", "windowKey": "manual:2025-06-01T01:05:00Z", "reasonCode": "due",
  "reason": "手动触发（当前时刻窗口）", "next_run_at": "2025-06-02T01:00:00Z" }
```

### 9.7 其他端点

| 方法与路径 | 用途 | 说明 |
| --- | --- | --- |
| `GET /api/schedules/runs?scheduleId=&status=&limit=` | 触发历史 | **必须先于 `/:id` 注册**；返回中文 reason 与 estimate 摘要 |
| `GET /api/schedules/:id/runs` | 单条排产的触发历史 | 等价于上一条带 scheduleId |
| `POST /api/schedules/preview` | dry-run：未来 N 次触发时刻 | body 为「未落库的 schedule 草稿」+ `{count:5}`；返回 `[{at, text, inMinutes, weekdayText}]`；用于设置界面「接下来 5 次」 |
| `POST /api/schedules/tick` | 手动催一轮 tick | body `{now?, dryRun?\|dry_run?, limit?}`；幂等安全（同一窗口不会重复触发），因此默认开放（`SCHEDULE_DEFAULTS.allowManualTick=false` 时返回 `403 已禁用`）；`now` 仅用于对表排错 |

`POST /api/schedules/tick` 与 `GET /api/schedules` 的响应都带 `queue:{paused, reason}`，让界面能解释「为什么排产不跑」。

### 9.8 前端（T-402）需要的最小数据面

- 面板顶部：全局 `queue.paused` + `POST /api/queue/resume` 的既有恢复按钮（复用 `web/app.js:113-120`）。
- 每条排产：`summary` 一句话、`next_run_text`、`last_status` 的中文映射、开关（`PATCH {enabled}`）、「立即跑一次」（`POST trigger`）。
- 实时刷新：排产产生的是**普通 studio job**，会走既有 `/api/jobs-stream` 的 `job` 事件；排产自身状态用 30s 轮询 `GET /api/schedules` 即可，**不新增 SSE 通道**（`/api/jobs-stream` 只转发 `job`/`job:log`，`src/routes/meta.js:270-283`）。

---

## 10. 启动、重启与观测（T-108 会展开）

### 10.1 定时器托管

- `src/routes/schedules.js` 的 `registerSchedulesRoutes(app)` 内部调用 `startScheduler({ tickSeconds })`，并把 `{stop}` 挂到 `app.__scheduler`，`server.js` 只需一行注册（最小 diff，符合 T-401 验收）。
- `startScheduler` 用 `setInterval(...).unref()`（不阻塞进程退出），启动时**立刻跑一轮 tick**（补齐停机期间错过的窗口，按 `miss_policy` 处理）。
- tick 周期默认 60s（`cfg.schedules.tickSeconds`，兼容 `tickMs`）；总开关 `cfg.schedules.enabled` 与环境变量 `FACTORY_SCHEDULER=off`（env 优先）。config.json 是用户数据文件、不在任何写范围内 → **不新增配置项也能跑**，缺省即 `SCHEDULE_DEFAULTS`。
- 启动顺序要求：`recoverStaleJobs()`（`server.js:31`）之后才 `startScheduler()`，否则重启瞬间会把「上一次被标记为中断的任务」当成「上一轮还在跑」。

### 10.2 重启恢复语义

- `next_run_at` 持久化 → 重启不丢水位线；停机期间错过的窗口在启动那一轮按 `miss_policy` 处理（`skip` 默认不补跑）。
- **不因重启而重复触发**：唯一索引保证同一窗口只有一行台账、一个 job；重启后 `fireSchedule` 对同一窗口只会返回 `deduped`（`status=deduped`）。
- 重启不会重置 `skip_count/miss_count/fire_count`（统计连续）。

### 10.3 惰性对账（与 `studio.reconcileStages` 同套路）

`reconcileScheduleRuns()`：把 `schedule_runs` 中 `status='fired'` 且 `job_id` 对应的 job 已到终态的行回写 `job_status`（`done/error/canceled`），并同步 `schedules.last_status/last_error`（`canceled` 记 `failed` + 中文原因「任务已取消（已完成的部分产物保留）」）。**不改写 `status`**（`fired` 是台账事实：那一刻确实触发了），任务成败写在 `job_status` 里，二者职责分离。
**读取时对账**而不是常驻监听：服务重启、跨进程、Agent 轮询都能自愈（照抄 `src/studio.js:944-967` 的理由）。

### 10.4 日志与观测点（供 ops/界面）

- `console.log('[schedules] 触发 %s → 窗口 %s → 任务 %s', id, occurrence, jobId)`；跳过记 `console.log('[schedules] 跳过 %s：%s', id, reason)`。
- 关键计数：`fire_count / skip_count / miss_count / attempts / deduped`。
- 进程内事件：`jobEvents.emit('schedule:fired'|'schedule:skipped'|'schedule:tick', {...})`（自定义名只供进程内订阅与测试，**不要**指望现有 SSE 转发）。

### 10.5 实例租约（防「两个进程指向同一个库 → 双份排产」，T-108 §4.5 缺口 C 在本层的落点）

不改 `db.js`、不加新表，直接用既有 `getConfigValue/setConfigValue`（`src/db.js:427-435`）在 `app_config` 里放一行租约：

```text
key: 'scheduler:lease'
value: { owner: `${os.hostname()}#${process.pid}`, expires_at: isoSeconds(now + leaseTtlSeconds) }

acquireSchedulerLease({ owner, ttlSeconds = cfg.leaseTtlSeconds }):
    cur = getConfigValue('scheduler:lease', null)
    if cur and cur.owner != owner and cur.expires_at > nowISO:
        return { ok:false, reason:`另一实例 ${cur.owner} 正在排产（租约至 ${cur.expires_at}）` }
    setConfigValue('scheduler:lease', { owner, expires_at: isoPlus(now, ttlSeconds) })
    return { ok:true }
```

- 每轮 tick 续租一次（`leaseTtlSeconds = 3 × tickSeconds`，默认 180s）；进程崩溃后租约自然过期，不需要清理逻辑。
- 拿不到租约的实例**只读**：tick 直接返回 `{enabled:false, reason:'另一实例正在排产（本实例只读）'}`，但 GET 与手动触发仍可用（手动触发会重新尝试抢租约）。
- 当前单实例部署下这条逻辑恒为「抢到」，零成本；它存在的意义是让「双进程同库」这种事故**不会静默双花**。

---

## 11. 给 T-202 的测试契约（假时钟）

- 全部判定函数接收 `now`（`'2025-06-01T01:00:00Z'` 这种秒级 ISO 字符串）；测试**只需传时间**，不需要 mock 全局时钟。
- `tickSchedules({ now, dryRun, rows })` 的 `rows` 参数是测试注入点（免去插入库即可测纯判定）。
- 临时库照抄 `tests/test-jobs.js:1-25`：`mkdtemp` + `FACTORY_DB`/`FACTORY_DATA_DIR`/`FACTORY_CONFIG`，离线假实例（`llm.provider:'mock'`、`image.backend:'placeholder'`、`video.backend:'placeholder'`）。
- 必须覆盖的用例（T-106 会细化矩阵）：
  1. `daily 09:00 Asia/Shanghai` → `nextOccurrence('2025-05-31T23:00:00Z')` = `2025-06-01T01:00:00Z`。
  2. 相邻两次触发在 DST 跳变周的间隔分别是 23h/25h（`America/New_York`，1 周各一次），且水位线单调递增。
  3. `skip` 策略下停机 3 天：`occurrences` 枚举 3 个、`missed=2`、只触发最近 1 个或全不触发（按 in-time 判定），`miss_count` 正确累加。
  4. `catchup` / `catchup_all` + `catchup_max=2` 的差异（含 64 个窗口截断计数）。
  5. 同一 tick 连跑两次：第二次全部 `status=deduped`，`jobs` 表只多 1 行（唯一索引 `(schedule_id, window_key, trigger)` 生效）。
  6. 暂停期间 tick：run 行 `status=skipped`/`reason_code=skipped_paused`、`jobs` 表无新增、`reason` 是中文；`resumeQueues()` 后默认不补跑；`catchup_after_pause=1` 时才补跑。
  7. `monthlyCap` 设小（例如单张图单价 1、cap 1）→ 触发前 `shouldAutoPause` 命中：队列被 `pauseQueues(by:'system')` 暂停（`pauseState().reason` 含「超过月度上限」）+ 本次 `status=skipped`/`reason_code=skipped_budget`，且 **没有** job 落库。
  8. 手动触发同一秒并发两次 → 一次 `status=fired`、一次 `status=deduped`，`jobs` 只多 1 行；`force:true` 也绕不过。
  12. 闸门顺序固定：同时制造「暂停 + 磁盘超限 + 预算超限」→ 断言 `reason_code` 为 `skipped_paused`（顺序：暂停 → 存储 → 预算）。
  13. 实例租约：伪造 `app_config` 的 `scheduler:lease` 为别的 owner 且未过期 → tick 返回 `{enabled:false}` 且不触发；租约过期后能抢到。
  9. `once` 触发后 `enabled=0`、`next_run_at=NULL`，再 tick 不再触发。
  10. 非法输入（时区/cron/kind/at_time/weekdays）抛中文 `Error`，且**不落库**。
  11. `runs` 历史惰性对账：伪造一个 `done` 的 job → `reconcileScheduleRuns()` 把该行 `job_status` 回写 `done`、`schedules.last_status` 同步；`status` 仍是 `fired`（不改写台账事实）。

---

## 12. 明确不做（含理由）

| 不做 | 理由 |
| --- | --- |
| 改 `src/db.js`（加表 / 升 `SCHEMA_VERSION`） | 不在任何任务卡的 write_scope；排产自建表与 `ensureStudioSchema()` 同套路，已被验证可行 |
| 改 `src/config.js` 加 `schedules` 默认段 | 同上；默认值内聚在 `src/schedules.js`，用户配置走 `loadConfig().schedules` 覆盖 |
| 改 `src/decisions.js` 把排产事件并入决策时间线 | 不在任何 write_scope → 排产事件通过 `schedule_runs` + API 暴露；接入时间线需另派卡（已记入风险） |
| 改 `/api/export` 备份排产表 | 同上（`src/routes/meta.js` 不在写范围） |
| 休眠/唤醒式「智能排产」（按 GPU 空闲、按电价时段） | 超出本卡范围；`kind=interval` + 队列暂停已能覆盖「错峰」的基本需求 |
| 秒级 cron、`@daily` 宏、时区库（如 luxon） | 零依赖约束；§7.2 边界写清并中文报错 |
| 排产自动 `resumeQueues()` | 恢复闸门是人类的决定；自动恢复会把预算保护变成形式主义 |
| 依赖 `jobs.js` 的 `idemKey` / `priority` / 实例锁新 API（T-108 §3.1-§3.3 提出） | 这些改动落在 `src/jobs.js`，**不在任何任务卡的 write_scope**（T-401/T-402 也不含）→ 排产层只用「自己的唯一索引 + `app_config` 租约」把幂等与单实例做完；`enqueueScheduledRun` 预留 `idemKey` 参数，将来授权后透传即可（见 §15） |

---

## 13. 风险与残留（也写入 `strategist/runs/T-101.json`）

1. **备份不含排产**：`/api/export` 只导演员/小说/剧本相关表（`src/routes/meta.js:286-310`），导出再导入会丢排产定义；`meta.js` 不在写范围 → 需后续卡。
2. **决策时间线看不到排产**：`decisions.js` 不在写范围，排产的「谁在什么时候排了什么」只能通过 `/api/schedules/runs` 与 `jobs:pause-log`（自动暂停）间接看到。
3. **月度上限不含 LLM 花费**：`usage:monthly` 只记 images/videos/ttsChars（`src/guard.js:32-42`）；定时跑免费阶段（brief/cast/novel/script）的 token 成本不受 `monthlyCap` 约束，界面文案不得宣称「有闸门就一定不超支」。
4. **`createProduction` 走 LLM 可能数十秒**：tick 串行 + 不可重入守卫；若进程在入队途中被杀，会留下 `failed` / `reason_code=pending` 的预留行，下一轮 tick 按 `retry_failed_max`（默认 1）重试同一窗口，超出上限则需人工在 `/api/schedules/runs` 里看到并手动触发（避免同一窗口无限重试）。
5. **`catchup_all` 的放大效应**：即使有 `catchup_max` 上限，误配（如 `catchup_max=50`）仍可能一次灌 50 条流水线；默认 1，且 API 校验上限 50，并在响应里回显「本次将建 N 个制片项目」。
6. **`monthly` 31 号语义**：2 月/4 月等无 31 号的月份被跳过（不顺延），用户可能误以为「每月至少跑一次」；`scheduleSummary` 必须写出该语义。
7. **零依赖时区实现只覆盖 IANA 常用区**：`Intl` 依赖 Node 的 ICU 数据（本机 v24 全量 ICU 已确认可用）；若部署环境是 small-icu，个别时区可能不可用 → 创建时用 `zonedParts` 做一次「可用性探测」并中文报错，而不是运行时静默偏差。
8. **手动 `POST /api/schedules/tick` 带 `now` 参数**：幂等键保护了「重复触发」，但 `now` 可以让「未来窗口」提前触发（真正的语义是「对表」）；`T-107` 已把该面列为安全审视点（默认开启，可配置关闭）。
9. **跨卡命名已与 T-108 合并，仍有两处需协调者知悉**：① T-108 要求 `jobs.js` 支持 `idemKey`/`priority`/实例锁，这些文件不在任何 write_scope → 本卡不依赖、不阻塞；② T-108 建议把 `schedules` 配置段写进 `src/config.js` 的 `DEFAULT_CONFIG`，同样不在写范围 → 本卡用「代码内默认值 + `loadConfig().schedules` 覆盖」。两份契约的字面差异与已对齐项见 §15。

---

## 14. 验收对照（T-101 acceptance_criteria 逐条）

| 卡片验收点 | 落点 |
| --- | --- |
| 给出 schedules 表字段与索引 | §2.1（`schedules` 全字段 + `idx_schedules_due` / `idx_schedules_created`）、§2.2（`schedule_runs` 全字段 + 唯一索引 `idx_sched_runs_window(schedule_id, window_key, trigger)` + `idx_sched_runs_at` / `idx_schedule_runs_status`） |
| 给出「到点该不该跑」的判定伪代码（含补跑/跳过错过的窗口） | §5.1 收集窗口 + §5.2 完整伪代码（`grace_min` / `miss_policy` 三策略 / `catchup_max` / 截断计数）+ §4 水位线推进表 |
| 明确与队列暂停、月度上限的交互 | §8.1 四级闸门（暂停 → 存储 → 月度预算 → 单次制片上限，复用 `shouldAutoPause`/`checkStorage`/`checkBudget`/`checkProductionBudget`）、§8.2 暂停×排产组合表 + 「暂停不建 job、恢复不自动补跑、绝不自动 resume」 |
| 给出 API 形状（GET/POST/PATCH/DELETE + 手动触发） | §9（含请求/响应示例、12 条校验及其中文报错、路由注册顺序陷阱、`trigger` 的 `force`/`dryRun`/幂等语义、`preview`/`runs`/`tick`） |
| （附加，卡片约束）契约要能直接指导实现 | §3 逐字函数签名与常量、§6 时区伪代码与实测基准、§7 cron 语法与算法、§10 启动/租约/对账、§11 测试契约（13 条用例） |

---

## 15. 附录：与 T-108（运行与恢复方案）的合并点与待裁决项

`T-108` 与本卡是**同波次并行产出**、且都触及「排产 → 队列」的边界。为避免 T-201/T-401 拿到两份打架的契约，这里逐条对齐（本卡作为排产定义的主责方，按 T-108 §3.6 的要求「以本表唯一键与状态枚举为准并合并列，不新建第二张表」执行）。

### 15.1 已采纳 T-108 的约定（本卡已改写）

| 项 | T-108 的写法 | 本卡的落地 |
| --- | --- | --- |
| 台账唯一键 | `(schedule_id, window_key)` | `idx_sched_runs_window(schedule_id, window_key, trigger)`（**多一列 `trigger`**，让「自动窗口」与「手动立即跑」不互相顶掉；见 15.3） |
| 窗口键列名 | `window_key` | 列名即 `window_key`（不再出现 `fire_key` / `occurrence_at` 作为该列名） |
| 任务幂等键 | `sched:{scheduleId}:{windowKey}` | `schedule_runs.idem_key` 用同一格式，由 `idemKeyOf()` 生成 |
| runs 状态枚举 | `fired / deduped / skipped / missed / failed` | 完全一致；细粒度信息放新列 `reason_code`（T-108 的 `reason` 仍是中文人话列） |
| runs 表补充列 | `job_id / production_id / producer / at / created_at` | 全部保留，并新增 `attempts / estimate / miss_count / trigger / job_status` |
| 排产 ID / runs ID | 示例 `S-0001` | `nextId('S','schedule')` → `S-0001`；`nextId('RUN','schedule_run')` → `RUN-0001`（与 T-108 表注释一致） |
| 队列类型 | 排产**不得**新开队列类型，统一 `type:'studio'`（`limit:1`） | `enqueueScheduledRun` 就是 `type:'studio'`（§8.2） |
| 关闭开关 | `FACTORY_SCHEDULER=off` / `cfg.schedules.enabled=false` | 采纳（§3 常量、§5.4 伪代码首行、§10.1） |
| 配置名 | `schedules.{enabled,tickSeconds,catchup,maxCatchup}` | 采纳这四个名字（缺省值仍内聚在 `src/schedules.js`，因为 `src/config.js` 不在写范围）；`catchup/maxCatchup` 作为**新建排产时** `miss_policy/catchup_max` 的默认来源 |
| 实例锁 | §4.5 需要「实例租约」 | `app_config` 的 `scheduler:lease` 实现（§10.5），不改 `db.js` |
| tick 入参 | `tickSchedules({ now, dryRun })` | 采纳 `dryRun` 为准、`dry_run` 为兼容别名（§3） |
| 人工可插队 | 优先级 人工 0 / 排产 10 | 本层**不实现优先级**（要改 `jobs.js`，不在写范围）；改为排产任务标题前缀 `[排产]` + payload 标记，让界面与任务表可辨识（见 15.2） |

### 15.2 本卡保留的设计（T-108 未定义或定义在别处）

- `schedules` 表的**全部定义字段**（kind/cron/at_time/weekdays/day_of_month/once_at/tz/mode/target/miss_policy/catchup_max/grace_min/skip_if_running/catchup_after_pause/budget_guard/retry_failed_max/水位线与计数）—— T-108 §3.6 明确「排产定义由 T-101 定」。
- `schedule_runs.reason_code`（细粒度判定码）、`attempts`（同一窗口重试计数）、`estimate`（预算估算留痕）、`miss_count`、`trigger`、`job_status`。
- 幂等**不依赖 `jobs.js`**：靠 `schedule_runs` 唯一索引 + `INSERT OR IGNORE` 的 `changes` 判定完成（T-108 的 `jobIdemKey` / `findJobByIdem` 需要改 `jobs.js`，本波次无人被授权）。
- 「先写台账行（`failed` / `reason_code=pending` 预留）再建 job」的顺序（理由见 §5.4）。
- 排产任务标题前缀 `[排产] {name}`，`enqueue` 时 `payload` 带 `scheduleId/occurrenceAt`，让既有任务列表与时间线（读 `jobs` 表）天然带上排产来源。

### 15.3 需协调者（总军师）裁决的 3 点

1. **唯一键是否纳入 `trigger`**：本卡加了 `trigger`（`auto`/`manual`）以允许「同一秒手动跑一次」与「自动窗口」共存；若严格照 T-108 的 `(schedule_id, window_key)`，则手动触发的 `window_key` 必须带 `manual:` 前缀（本卡已按此设计）。两条路都能防重复 —— 建议保留 `trigger`，语义更直白、测试更好写。
2. **闸门顺序**：T-108 §3.7 是「暂停 → 预算 → 磁盘」，本卡是「暂停 → 存储 → 预算」。两者都不影响正确性（任一条命中即跳过），但断言文案需要唯一一种；建议采纳本卡顺序（物理约束排在钱之前）。
3. **`jobs.js` 的 `idemKey` / `priority` / 实例锁是否另派卡**：若授权改 `jobs.js`，本卡已预留 `enqueueScheduledRun({ idemKey })` 透传点，排产侧零改动即可升级；若不授权，T-108 §3.1/§3.3/§4.5 中依赖它的部分需标注为「未落地」。

（本附录只做对齐说明，不改动 §2–§11 的实现契约；字段名与行为以 §2–§11 为准。）
