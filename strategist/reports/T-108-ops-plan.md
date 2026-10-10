# T-108 运行与恢复方案（排产队列交互 · 重启恢复 · 暂停联动 · 观测点 · 回滚）

> 任务卡：`strategist/tasks/T-108.yaml`（receiver_role=ops，P1，write_scope 仅本文件）
> 结论先行：**「不漏跑、不重复跑」不能靠现有队列实现** —— `src/jobs.js` 的 pending 是纯内存数组，进程重启即丢失；
> `recoverStaleJobs()` 把残留的 `running/queued` **一律标记为 error**（这是既有测试断言的行为，必须保留）。
> 因此本方案的核心是给队列补三样东西：**① 可重投的幂等键（idemKey）② 排产窗口台账（schedule_runs）③ 先采集→再自愈→后重投的启动序列**。
> 本文件只给契约与运维步骤，不含代码；所有 DDL 与去重语义均已用临时库实测（见 §1.4）。

---

## 1. 现状盘点（先说清事实，再说改法）

### 1.1 已核实的队列机制（`src/jobs.js`，214 行）

| 事实 | 位置 | 对恢复的影响 |
|---|---|---|
| 队列是内存结构 `queues: Map<type, {running, limit, pending[]}>` | `jobs.js:9` | **重启即丢**，pending 中的任务不会有任何执行者 |
| 暂停状态落库在 `app_config['jobs:paused']` | `jobs.js:15-24` | 暂停**跨重启持久**（实测 B4），重启绕不过闸门 |
| 暂停历史落 `app_config['jobs:pause-log']`（保留最近 100 条） | `jobs.js:16,34-40` | 可作审计，可被决策时间线读取 |
| `pump()` 在暂停时不启动新任务，并 emit `job:pump-blocked` | `jobs.js:151-155` | 暂停期间入队安全；但**不会有恢复动作**，必须人工/流程触发 |
| `resumeQueues()` 遍历 `queues.keys()` 全部 pump | `jobs.js:59-66` | 恢复瞬间会**同时**放行所有类型队列 → 排产补跑会雪崩（见 §3.4） |
| `recoverStaleJobs()` 把 `status IN ('running','queued')` 一律改 `error` | `jobs.js:199-208` | 既有测试 `tests/test-jobs.js:145-149`、`tests/test-render.js:302-307` 断言此行为 → **语义不得改** |
| `canceled` 集合是内存 Set，取消同时写库 `status='canceled'` | `jobs.js:125-132` | 取消语义**跨重启有效**（pump 会跳过 DB 为 canceled 的行，`jobs.js:160`） |
| `enqueue()` 直接返回 `jobId` 字符串 | `jobs.js:138-145` | 已有调用方按字符串用 |
| `queueStats()` 只统计内存队列 | `jobs.js:210-213` | 重启后返回 `{}`（实测 B5）→ **观测缺口**：`/api/health.jobs` 会显示空队列，误判「没有任务」 |

**现存队列类型（实测 grep）**：`image`、`keyframe`、`video`、`novel`、`script-plan`、`script-episode`、`script-storyboard`、`pipeline`、`compose`、`assemble`、`variant`、`studio`、`graph`。
其中 `studio` / `variant` / `graph` 的 `limit` 都是 **1**（串行），`image` 是 `cfg.image.concurrency || 2`。

### 1.2 已核实的制片侧语义（`src/studio.js`）

| 机制 | 位置 | 复用价值 |
|---|---|---|
| `runStage()` 对已完成阶段幂等跳过（`force=false`） | `studio.js:860` | 重投后**不会重复花钱**的第一道保证 |
| 付费阶段（`keyframe`/`video`）不自动执行，只建计划等人工确认码 | `studio.js:863-874` | 恢复时**绝不能**自动续跑付费阶段 |
| 付费阶段被暂停闸门拦下时状态回 `pending`（不是 `awaiting_approval`） | `studio.js:866-871` | 恢复的正确落点 |
| `autoPauseGate()` 用 `shouldAutoPause()` → `pauseQueues({by:'system'})` | `studio.js:969-984` | 预算闸门只负责「暂停队列」，不负责杀任务 |
| `runPipeline()` 免费阶段也看 `pauseState()` | `studio.js:925-929` | 暂停期间流水线不推进 |
| `reconcileStages()` 惰性对账：`running` 且 `job_id` 非空的阶段，按 jobs 终态回写 | `studio.js:944-965` | 重启后阶段状态能自愈，**不需要**常驻监听 |
| `waitJob()` 单任务等待上限 15 分钟 | `studio.js:621` | 长任务（出图/视频）远超优雅停机窗口 |

### 1.3 已核实的启动/停机现状（`server.js`）

```
migrate() → ensureMcpSchema() → ensureStudioSchema()
→ recoverStaleJobs()            ← 启动自愈（一律标 error，无重投）
→ cleanupIntermediates()        ← 清理中间产物
→ createApp() / registerXRoutes / listen
SIGINT|SIGTERM → server.close(() => exit(0)); 1500ms 兜底 exit    ← 没有 drain，长任务被硬杀
```

三个缺口，对应本方案的三处改动：

1. **缺口 A（漏跑）**：pending 任务重启后无人接手，只能人工重提。
2. **缺口 B（不重复跑无保证）**：没有任何「同一件事只能有一个活任务」的约束；重复点一次「运行」或排产 tick 重入就会双跑。
3. **缺口 C（观测缺口）**：`queueStats()` 重启后为空；排产没有任何台账；无实例锁，两个进程指向同一库会**双份排产**。

### 1.4 实测证据（临时库 + 两个独立进程，未触碰 `data/factory.db`、未启动/重启任何服务）

```
# 进程A（模拟被杀前的现场）
A: 残留 running=JOB-mulmcvk5b2edbc queued=JOB-mulmcvk5ef5300 暂停={"paused":true,...,"by":"system","scope":"all"}

# 进程B（模拟重启后的新进程，内存队列为空）
B1: 采集残留（自愈前）=JOB-mulmcvk5ef5300/variant/queued, JOB-mulmcvk5b2edbc/studio/running
B2: recoverStaleJobs={"recovered":2,"ids":[...]}
B3: 各任务终态=JOB-mulmcvk5b2edbc=error, JOB-mulmcvk5ef5300=error
B4: 重启后 pauseState={"paused":true,"reason":"本月金额将超上限","by":"system","scope":"all"}
B5: 重启后 queueStats（内存队列）={}
B6: 重启后 listJobs 仍可读历史=2 条
B7: 残留 payload 可解析（重投依据）={"scriptId":"SC-0001","code":"S01E001","targets":["douyin"],"fit":"crop"}

# 进程C（验证本方案的 DDL 与去重语义）
C1: 同一窗口重复入队被唯一索引拦下 -> UNIQUE constraint failed: jobs.idem_key
C2: 旧任务进入终态后同键可再入队 -> 成功
C3: error 终态后同键可重投（返工）-> 成功
C4: 按 idem 查占用 -> ["running"]
C5: VACUUM INTO 备份 -> 311296 字节（零依赖备份可行）
C6: jobs 现有列 -> id,type,title,status,progress,total,done,payload,result,error,created_at,updated_at,finished_at
```

结论：**B1 证明残留可采集（必须先采集再自愈）；B7 证明 payload 足以重建任务；C1~C4 证明「同一件事只有一个活任务」用部分唯一索引即可表达；C5 证明零依赖备份可用。**

---

## 2. 契约总览（新增物一览，实施者按此清单落地）

| 类型 | 名称 | 归属 | 说明 |
|---|---|---|---|
| 新导出 | `submitJob(opts)` | `src/jobs.js` | **唯一入队闸门**（幂等 + 生产者标记 + 优先级） |
| 新导出 | `findJobByIdem(idemKey, opts)` | `src/jobs.js` | 查同键活任务（去重判定） |
| 新导出 | `jobIdemKey(type, scope)` | `src/jobs.js` | 幂等键拼接（统一命名规范） |
| 新导出 | `markDraining()` / `isDraining()` | `src/jobs.js` | 优雅停机（纯内存，**不落库**） |
| 新导出 | `collectLeftoverJobs()` | `src/jobs.js` | 采集重启残留（自愈**之前**调用） |
| 新导出 | `resumeLeftovers()` | `src/jobs.js` | 按判定矩阵重投残留 |
| 新导出 | `warmQueues(types)` | `src/jobs.js` | 启动时预建队列，修掉 `queueStats={}` 观测缺口 |
| 新列 | `jobs.idem_key TEXT`、`jobs.producer TEXT DEFAULT 'human'` | `src/db.js` migrate + `addMissingColumns` | 去重与来源观测（**本卡独有增量**） |
| 新索引 | `idx_jobs_idem(idem_key,status)`、`idx_jobs_idem_alive`（部分唯一） | 同上 | 「同一件事只有一个活任务」的硬约束 |
| 排产台账 | `schedule_runs`（含唯一索引 `uq_schedule_runs_fire`） | **T-101 已有契约**（`src/schedules.js` 的 `ensureSchedulesSchema()`） | 本卡**不新建第二张表**，只做映射与残行处置（§3.6） |
| 排产巡检 | `tickSchedules({ now, dry_run, limit, rows })`、`startScheduler({tickMs})`、`reconcileScheduleRuns()` | **T-101 已有契约** | 本卡只规定「tick 内的入队座位」与启动时机（§3.7、§4.2） |
| 新路由 | `GET /api/ops/status`、`POST /api/ops/resume` | `src/routes/ops.js`（新增：一个只读汇总 + 一个受控动作） | 观测与人工补救；排产台账读 T-101 的 `GET /api/schedules/runs`，**不重复造** |
| 配置 | `schedules.tickMs`（T-101 已有）、环境变量 `FACTORY_SCHEDULER=off`（本卡新增的运维开关） | 默认值放 `src/schedules.js` 的 `SCHEDULE_DEFAULTS`（T-101 明确「不写 `src/config.js`」） | 一级回滚开关 |
| 启动序列 | `server.js` 启动段改为「采集 → 自愈 → 重投 → 预热队列 → 注册路由（含 `startScheduler`）」 | `server.js`（T-401 范围） | 见 §4.2 |

> **不改既有公开函数签名**：`enqueue/getJob/listJobs/cancelJob/queueStats/recoverStaleJobs/pauseState/pauseQueues/resumeQueues` 全部保持原签名与语义；新增能力走新导出。`jobs` 表新增列对旧代码透明（SQLite 加列向后兼容，旧代码忽略新列）。
> **与 T-101 的唯一权威口径**：排产**定义**（`schedules` 表、cron/时区、`miss_policy`/`catchup_max`/`catchup_after_pause`、状态枚举、`fire_key`、`/api/schedules*` 路由、`[schedules]` 日志句式）**一律以 T-101 契约为准**；本卡只负责「tick → `jobs` 队列的座位」「重启恢复」「陈旧残行处置」「观测聚合」。

---

## 3. 排产 → 队列交互契约

### 3.1 唯一入队闸门 `submitJob`

```js
/**
 * 入队（唯一闸门：幂等去重 + 生产者标记 + 优先级）。
 * ★ 本函数内部不得出现任何 await —— Node 单线程 + node:sqlite 同步 API 保证
 *   「查重 → 插入」是原子的；一旦插入 await 就会产生并发重入的竞态。
 * @param {{
 *   type:string, title?:string, total?:number, payload?:object, limit?:number,
 *   idemKey?:string|null,        // 幂等键；null = 不去重（既有调用方式保持可用）
 *   producer?:'human'|'agent'|'scheduler'|'system',
 *   priority?:number,            // 0=人工（默认） 10=排产 20=后台补算；数字越小越先跑
 *   handler:(ctx)=>Promise<any>,
 * }} opts
 * @returns {{jobId:string, deduped:boolean, existingJobId:string|null, reason:string}}  // reason 为中文
 */
export function submitJob(opts) {}

/** 查同键的「活任务」（排队中/执行中，可选含已完成） */
export function findJobByIdem(idemKey, { includeDone = false } = {}) {}

/** 幂等键拼接：jobIdemKey('studio','P-0001:script') → 'studio:P-0001:script' */
export function jobIdemKey(type, scope) {}
```

**`enqueue()` 保持原样**（内部可改为 `submitJob({...opts, idemKey:null})` 的薄封装，行为逐字不变，`enqueue` 仍返回 jobId 字符串）。

**去重判定表（必须严格按此实现，`reason` 全中文）**

| 已存在同 `idem_key` 的任务状态 | 行为 | 返回 | 说明 |
|---|---|---|---|
| `queued` | **不新建**，复用已存在任务 | `deduped:true, existingJobId, reason:'该任务已在队列中（未开始），本次提交已合并'` | 防重复点按、防 tick 重入 |
| `running` | **不新建**，复用 | `deduped:true, reason:'该任务正在执行中，本次提交已合并'` | 同上去重 |
| `done` | **不新建**（除非 `force:true`） | `deduped:true, reason:'该任务已完成（产物已存在）；确需重做请显式重跑'` | 排产同一窗口绝不会二次产出 |
| `error` / `canceled` | **允许新建** | `deduped:false` | 返工路径（实测 C3） |
| 无记录 / `idem_key` 为 null | 新建 | `deduped:false` | 兼容既有调用方 |

**兜底硬约束**：`CREATE UNIQUE INDEX idx_jobs_idem_alive ON jobs(idem_key) WHERE idem_key IS NOT NULL AND status IN ('queued','running')`（实测 C1/C2：活任务重复插入被拒，进入终态后自动释放）。若被索引拒绝，`submitJob` 必须 `catch` 后转成中文返回，**不得把英文 SQLite 报错抛给界面**：`reason:'该任务已在队列中（并发提交被拦截），本次提交已合并'`。

**幂等键命名规范（全项目统一，实施者不得自定义格式）**

| 生产者 | `jobs.idem_key` 取值 | 举例 |
|---|---|---|
| 排产自动触发 | **逐字等于 T-101 的 `schedule_runs.fire_key`** = `${schedule_id}#${occurrence_at}` | `SCH-0001#2026-06-01T01:00:00Z` |
| 排产手动触发（T-101 `POST /api/schedules/:id/trigger`） | 同上，等于 `${schedule_id}#manual:${occurrence_at}` | `SCH-0001#manual:2026-06-01T01:05:00Z` |
| 制片整条流水线 | `studio:{productionId}:pipeline:{until}` | `studio:PR-0001:pipeline:all` |
| 制片单阶段 | `studio:{productionId}:stage:{stage}` | `studio:PR-0001:stage:keyframe` |
| 画布整图执行 | `graph:{canvasId}:{planFingerprint}` | `graph:CV-MAIN:9f3a1c2e`（指纹取 `planGraph` 计划哈希，复用 P3 已有指纹） |
| 多平台版本 | `variant:{scriptId}:{code}:{targets.join('+')}:{fit}` | `variant:SC-0001:S01E001:douyin+tiktok:crop` |
| 整集成片 | `assemble:{scriptId}:{code}` | `assemble:SC-0001:S01E001` |
| 人工/Agent 单次生成（去重要求低） | `null`（不传） | 保持现状 |

> **一条字符串贯穿两套幂等**：`jobs.idem_key` 与 `schedule_runs.fire_key` **必须逐字相同**（不要加 `sched:` 前缀、不要改大小写），这样「某个窗口到底有没有建过 job」用一条 SQL 就能互证：`SELECT r.status, j.id FROM schedule_runs r LEFT JOIN jobs j ON j.idem_key = r.fire_key WHERE r.fire_key = ?`。排产侧的唯一索引负责「一格只触发一次」，队列侧的活任务唯一索引负责「同一件事只有一个在执行」——两者互补，缺任一个都会漏。
> 时间串口径以 T-101 §11 为准：**秒级 UTC ISO 字符串**（例 `2026-06-01T01:00:00Z`），不是毫秒串；本卡不另立口径。

### 3.2 队列类型与并发上限：排产**不得新开队列类型**

- 排产触发的制片任务统一入 **`type:'studio'`（`limit:1`）**，与人工点击共用同一条串行队列。
- 理由：若排产另开 `type:'scheduled-studio'`，各类型独立 `limit` ⇒ 并发翻倍、预算与磁盘闸门同时被两个生产任务冲击；且「暂停」是全局语义，分队列后 `resumeQueues()` 的放行顺序不再可控。
- 因此：**新类型只允许用于「互不争抢同一资源」的任务**；任何会写出图/视频/成片的任务都必须落在 `studio` / `graph` / `image` / `video` 这四类既有队列里。

### 3.3 优先级：人工可插队，排产不许插队

- 现实现按 `pending` 数组 FIFO（`jobs.js:157` `pending.shift()`）。
- 改法（最小）：`submitJob` 按 `priority` **稳定插入**（从队尾向前找到第一个 `priority <= 自身` 的位置，插到它后面），不修改 `pump()` 取任务逻辑。
- 约定：人工 = `0`，排产 = `10`，后台补算/回填 = `20`。**同优先级必须保持插入顺序**（既有测试对串行 FIFO 有断言，不得破坏）。

### 3.4 暂停态联动矩阵（本卡核心之一）

| 场景 | 触发者 | 已在跑的任务 | 排队中的任务 | 排产 tick | 制片流水线 | 恢复动作 |
|---|---|---|---|---|---|---|
| 预算软着陆 | `autoPauseGate` → `pauseQueues({by:'system'})` | **跑完**（不打断） | 留在 `pending` | **不建 job**，窗口记 `skipped_budget`（T-101 §8.2） | 停在下一阶段，`reason='auto_paused'`/`'queue_paused'` | 提高上限或清零台账 → `POST /api/queue/resume` |
| 人工暂停 | `POST /api/queue/pause` | 跑完 | 留在 `pending` | 同上，窗口记 `skipped_paused` | 同上 | `POST /api/queue/resume` |
| 进程优雅停机 | `markDraining()`（纯内存） | 等在跑任务结束（超时后放行为残留） | 不启动新的；`submitJob` 正常写库但 `pump` 不启动 | 停 tick（`app.__scheduler.stop()`） | 同上 | 重启后由 §4 恢复流程接手 |
| 重启后仍是暂停态 | 库里的 `jobs:paused` | 无 | 无（pending 已丢） | **tick 必须先读 `pauseState()`**（T-101 §8.2 第一列），暂停则只记 `skipped_paused` | 不推进 | 同上（**必须人工**，这是防「重启绕闸门」的设计） |

**两个必须避开的坑（实测/读码得出）**

1. ❌ **不要用 `pauseQueues()` 做停机 drain**：它会把 `paused:true` 写进 `app_config['jobs:paused']`，重启后队列**永久暂停**（实测 B4），必须人工恢复 —— 停机动作会变成一次「把生产闸门关上」。drain 必须用**纯内存** `markDraining()`。
2. ❌ **不要用 `resumeQueues()` 触发排产补跑**：它一次性放行所有类型队列。排产恢复只能由 tick 按 `miss_policy`/`catchup_after_pause` 决定（T-101 不变量 2：暂停期间不建 job，恢复后默认不补跑），且补跑数受 `catchup_max`（0..50）封顶。

### 3.5 与预算/额度闸门的分工（避免语义漂移）

| 闸门 | 位置 | 语义 | 谁负责 |
|---|---|---|---|
| `checkBudget({images,videos,ttsChars})` | `guard.js:82` | **提交前拒绝这一次**（`ok:false, blocked:true`） | 排产 tick 在 `submitJob` 前调用；被拒 → 窗口记 `skipped_budget` + 中文原因（T-101 §8.1） |
| `checkProductionBudget({amount})` | `guard.js:215` | 单次制片超 `budget.productionCap` → 拒绝整条流水线 | 建项目入口（既有）+ 排产 `skipped_production_cap`（T-101 §5.3） |
| `shouldAutoPause()` | `guard.js:188` | **暂停队列**（不丢任务） | 付费阶段 `autoPauseGate`（既有）+ 排产触发前（T-101 §8.1） |
| `checkStorage()` | `guard.js:164` | 磁盘超 `storage.maxGB` → 拒绝新任务 | tick 前置检查；本卡要求把被拒窗口统一落成 `skipped_budget`，`reason` 里写明「存储闸门：…」（T-101 未单列 `skipped_storage`，**不新增状态值**，避免状态枚举两处不一致） |

**排产 tick 不得自行预扣/写入用量台账**（避免与 `addUsage` 双重计数）；只做「读闸门 → 决定是否 `submitJob`」。

### 3.6 与 T-101 台账 `schedule_runs` 的对齐（本卡**不新建**第二张表）

T-101 §2.2 已定义权威台账，本卡逐字沿用，**不复述、不改写、不新增同义列**：

| T-101 字段 | 本卡用途 |
|---|---|
| `fire_key`（唯一索引 `uq_schedule_runs_fire`） | 就是 `jobs.idem_key` 的取值来源（§3.1），一条字符串贯穿两套幂等 |
| `status`（`pending`/`queued`/`done`/`error`/`skipped_*`） | 观测与恢复判定的状态源；**本卡不新增状态值** |
| `reason_code` / `reason` | 「为什么昨晚 3 点没跑」的机器码与中文人话，`/api/ops/status.incidents` 直接引用 |
| `job_id` / `production_id` | 与 `jobs`、`productions` 的连接键（追账） |
| `miss_count` / `attempts` / `deduped` | 「漏跑」「重复尝试」的计数证据 |
| `pending` 残行 | **本卡负责的缺口**：见 §4.6（T-101 §10.2/§12.4 把该残行留给人工，本卡给出启动期统一处置与可见性） |

### 3.7 tick 内的入队座位（本卡只加两处，其余以 T-101 §7 伪代码为准）

T-101 的 `tickSchedules({ now, dry_run, limit, rows })` 伪代码（其 §7）已经规定了闸门顺序、水位线推进、`pending` → 建项目 → 入队的顺序。本卡**不重写该算法**，只固定下面两个「座位」：

1. **入队必须经过 `submitJob`**：T-101 §3 导出的是 `enqueueScheduledRun({ productionId, until, offline, provider, scheduleId, occurrenceAt }) → jobId`（内部写的是「复用 `jobs.enqueue`」）。本卡要求把这个**内部实现**改为：
   ```js
   // src/schedules.js —— 对外签名与返回（jobId 字符串）不变，仅内部改走幂等闸门
   const r = submitJob({
     type: 'studio', limit: 1, priority: 10, producer: 'scheduler',
     idemKey: fireKey,                       // = `${scheduleId}#${occurrenceAt}`（逐字同 schedule_runs.fire_key）
     title: `排产制片 · ${schedule?.name || scheduleId} · ${occurrenceAt}`,
     payload: { productionId, until, offline, provider, scheduleId, occurrenceAt, fireKey, resume: true },
     handler: /* 与人工路径同形的 studio handler */,
   });
   if (r.deduped) return { jobId: r.existingJobId, deduped: true };   // 撞上活任务：按 T-101 记 skipped_deduped
   return { jobId: r.jobId, deduped: false };
   ```
   > 这是**唯一跨卡改动点**，请 T-201 在实现 T-101 时按此写；不改 `enqueueScheduledRun` 的对外签名。
2. **`payload` 必须带 `scheduleId` / `occurrenceAt` / `fireKey` / `resume`**：`fireKey` 用于与台账互证；`resume` 供 §4.3 的重启恢复判定使用（排产流水线是幂等的，允许重投）。人工路径与画布路径也按 §3.1 补 `resume` 字段。

**补跑策略**：以 T-101 的 `miss_policy`（`skip` / `catchup` / `catchup_all`）+ `catchup_max`（0..50）+ `catchup_after_pause` 为准，**本卡不另立 `catchup/maxCatchup` 等同义配置项**（避免两套拨盘）。运维含义只有一句：`skip` = 错过就记 `skipped_missed` 不补跑（默认，防雪崩）；`catchup`/`catchup_all` 补跑数受 `catchup_max` 封顶。

### 3.8 手动触发（`POST /api/schedules/:id/trigger`，T-101 §9.6）

- 与自动触发**走同一个 `submitJob`**（不得绕过队列直调 `runPipeline`/`createProduction` 后自行放行，否则并发上限、暂停、预算三道闸门全绕过）。
- 幂等由 T-101 的 `fire_key = ${id}#manual:${occurrence_at}` 承担：**同一秒重复点击只触发一次**；`force:true` 绕闸门但绕不过幂等（本卡 §3.1 的 `jobs.idem_key` 同键去重是第二道保险）。
- 暂停期间：T-101 语义为「`force:true` 才放行」；本卡补充要求——`force` 放行时必须把覆盖理由写进 `schedule_runs.reason` 与观测日志（`producer=human`），且**不得**覆盖预算/磁盘闸门。

---

## 4. 重启恢复方案（不漏跑、不重复跑）

### 4.1 停机（先保证「不重复」，再保证「不漏」）

**`markDraining()` / `isDraining()`（新增，纯内存）**

```js
export function markDraining(note = '')      // 置内存标志 + 记录 note/时刻；不写 app_config
export function isDraining()                 // => boolean
```
`pump()` 在 `draining` 时与 `paused` 同样不启动新任务，但**不 emit `job:pump-blocked` 的暂停语义**，改为 emit 观测事件 `queue.drain`。

**停机步骤（Runbook，实施后写入 `docs/使用手册.md` 的运维章节）**

```
1. 置 drain：调用 markDraining('计划内重启')（或走 SIGTERM 钩子自动置位）
2. 停排产 tick：clearInterval(schedulerTimer)，并置内存 draining（拒绝 manual run-now 的新提交）
3. 等队列排空：轮询 queueStats()，直到所有类型 running==0；上限 drainTimeoutMs（默认 30000，可配）
4. 记录停机现场：app_config['ops:last-shutdown'] = { at, pid, reason, running:[jobId…], queued:[jobId…], paused:pauseState() }
5. server.close() → 等待连接结束 → exit 0
6. 超时仍未排空 → 记录 running 清单后放行退出（这些任务会成为 §4.3 的「残留」，由恢复流程接手）
```

**硬性约定**

- 禁止 `kill -9` 后直接启动：会留下 `running` 残留且**没有停机现场记录**，恢复判定只能降级为「保守不重投」。
- 禁止用 `pauseQueues()` 做 drain（§3.4 坑 1）。
- `SIGINT/SIGTERM` 的 1500ms 兜底退出只对「已排空」场景生效；drain 超时值必须显式可配，避免长任务（`waitJob` 上限 15 分钟）每次都被硬杀。

### 4.2 启动序列（顺序不可颠倒）

```
migrate()                        # 建表/补列（含 jobs.idem_key/producer）
ensureMcpSchema()
ensureStudioSchema()
# ↓ 本卡新增的恢复块（顺序不可颠倒；紧贴既有 recoverStaleJobs() 的位置插入）
  const leftover = collectLeftoverJobs()          # ★ 必须在自愈之前采集
  const recovered = recoverStaleJobs()            # ★ 语义不变：一律标 error（既有测试依赖）
  const resumed = await resumeLeftovers({ leftover, now: nowISO() })   # 按 §4.3 矩阵重投
  const swept = sweepPendingScheduleRuns()        # ★ 新增：处置 schedule_runs 的 pending 残行（§4.6）
  warmQueues(REGISTERED_JOB_TYPES)                # ★ 新增：预建队列 → 修掉 queueStats()={} 的观测缺口
cleanupIntermediates()
createApp() → registerMetaRoutes / registerActorRoutes / … / registerStudioRoutes
             → registerSchedulesRoutes(app)       # T-101 §10.1：startScheduler 挂在这里（内部 ensureSchedulesSchema + tick）
```

**启动时机（与 T-101 §10.1 对齐，必须满足两条）**

1. `registerSchedulesRoutes(app)` **必须排在恢复块之后**（T-101 明确要求 `recoverStaleJobs()` 之后才 `startScheduler()`，否则重启瞬间会把「上一次被标记为中断的任务」当成「上一轮还在跑」）。现 `server.js` 的所有 `register*` 本来就在 `recoverStaleJobs()` 之后，**只要把新增的采集/重投/预热三行紧贴 `recoverStaleJobs()` 插入、不要挪到 register 之后**即可。
2. T-101 的 `startScheduler` 启动时会**立刻跑一轮 tick**（补齐停机期间错过的窗口）。本卡要求 `resumeLeftovers()` 与 `warmQueues()` 都在它之前完成 —— 否则恢复重投的 job 还没落库，tick 的 `skip_if_running` 判定会以为「上一轮没在跑」而重复触发同一窗口（虽然会被 `fire_key` 幂等去重，但会平白多一条 `skipped_deduped` 噪声）。

**为什么必须「先采集后自愈」**：实测 B2/B3 显示 `recoverStaleJobs()` 会把残留行全部改成 `error`，之后再也无法区分「跑到一半被杀」与「排队中未开始」。采集只读不写，是零风险的。

**`collectLeftoverJobs()` 契约**

```js
/** 采集重启残留（只读）：status IN ('queued','running') 的全部任务 + 停机现场比对 */
export function collectLeftoverJobs() // => [{ id, type, status, progress, total, done, payload, idem_key, producer, created_at, updated_at }]
```
实现要点：payload 用 `safeParse` 容错解析（实测 B7）；解析失败的任务**不得**重投，直接归入「不可恢复」。

### 4.3 恢复判定矩阵（`resumeLeftovers` 的唯一依据）

| 残留状态 | 类型/阶段 | payload 判定 | 行为 | `reason`（中文，写入观测与返回） |
|---|---|---|---|---|
| `queued` | 已注册 handler | — | **重投**（`submitJob` 同 type/idemKey=原 idem 或按 §3.1 规则拼接） | `'排队中未开始：已按原参数重新入队'` |
| `running` | `studio` 免费阶段 | `payload.resume === true` | **重投**；阶段层幂等（`runStage` 已完成阶段跳过） | `'执行中被打断：已重投，已完成阶段会自动跳过'` |
| `running` | `studio` 付费阶段（`keyframe`/`video`） | 任意 | **不重投**；把 `production_stages` 该阶段置回 `pending`，`plan_id=null` | `'付费阶段执行中被打断：确认码一次性，须人工重新生成计划并批准（不自动续跑）'` |
| `running` | `graph` 整图执行 | `payload.resume === true` | **重投**（`overwrite:false`，靠 P3 输入指纹跳过已产出节点） | `'图执行被打断：已重投，已产出节点按输入指纹跳过'` |
| `running` | 有副作用的封装类：`assemble` / `variant` / `compose` | 任意 | **不重投**（产物落盘中断无指纹可判） | `'封装类任务中断：产物可能不完整，请人工重跑（不会重复计费）'` |
| 任意 | `type` 未注册 handler | — | 不重投，保持 `error` | `'重启后无法自动续跑：该任务类型不支持恢复'` |
| 任意 | payload 解析失败 | — | 不重投 | `'重启后无法自动续跑：任务参数已损坏'` |
| 任意 | 本项目/画布已被删除 | — | 不重投 | `'重启后无法自动续跑：关联的制片项目/画布已不存在'` |

**「不重复跑」的三道保证（缺一不可）**

1. **排产台账唯一键** `schedule_runs.fire_key`（`uq_schedule_runs_fire`，T-101 §2.2）：同一窗口只能有一行、只能建一个 job，重启与并发 tick 都撞唯一索引。
2. **活任务唯一索引** `idx_jobs_idem_alive`：同一 `idem_key`（排产场景即 `fire_key`）同时只能有一个 `queued/running` 任务（实测 C1~C4）。
3. **业务层幂等**（重投后即使执行也不重复产出）：
   - `runStage()` 已完成阶段跳过（`studio.js:860`）；
   - `graph` 输入指纹 `input_fp`，`overwrite:false` 时跳过已产出节点；
   - 配音按「台词+音色」缓存；缩略图按「路径+mtime+size」缓存；
   - `production_stages.reconcileStages()` 会把跑完的任务终态回写阶段，重启后阶段状态自愈。
   - **例外（必须如实告知）**：整集成片每次封装文件名唯一（不覆盖），重跑会产生**新的成片文件**（多一份产物、但不重复计费）。恢复报告里必须给出 `duplicates:[文件名…]`，运维按需删旧文件。

**恢复返回契约**

```js
export async function resumeLeftovers({ leftover = null, now = nowISO() } = {}) 
// => { resumed:[{jobId, fromJobId, type, idemKey, reason}], skipped:[{jobId, type, reason}],
//      pendingApproval:[{productionId, stage, reason}], counts:{resumed,skipped,pendingApproval} }
```

### 4.4 单实例锁与排产租约（防「双份排产」）

- 现象风险：两个进程指向同一 `FACTORY_DB`（例如换端口起了一个调试实例）→ 两个 tick → 同一窗口两次 `submitJob`。台账唯一键能拦住重复，但两个进程都会去抢；且队列是内存的，**并发上限在两个进程里各算一份**，`studio:limit=1` 形同虚设。
- 方案（最小）：`app_config['ops:scheduler-lease'] = { instanceId, pid, host, at }`，`instanceId = rid('INST')`（进程启动时生成，内存态）。
  - tick 前：无租约 → 写入并持有；租约存在且 `at` 在 `2 × tickMs` 内 → **放弃排产**，打中文警告 `[schedules] 另一实例（pid=…, at=…）正在排产，本实例只读不排产`；租约过期 → 抢占（覆盖写入）。
  - 每个 tick 更新 `at`（心跳）。
- 落点：租约检查放在 T-101 的 `tickSchedules()` **入口**（其 §7 伪代码的 0 步之前），通过 `SCHEDULE_DEFAULTS` 增加 `leaseGuard:true` 开关；不改 T-101 已冻结的函数签名。
- 明确不做的事：不引入文件锁/端口锁/新依赖；多进程并发执行本身仍不支持，属**部署约束**（写进使用手册：**同一 `FACTORY_DB` 只允许一个服务进程**）。

### 4.5 恢复操作手册（可直接照着做）

**前置**：所有演练**必须在临时库 + 独立端口**进行，严禁重启/干扰正在服务 GUI 的 8788 实例。

```
# 步骤 0：备份现场（零依赖，实测 C5 可用）
#   在临时实例上执行，或用 node 一行（VACUUM INTO 与主库 WAL 不冲突）
TMPD=$(mktemp -d)
FACTORY_DATA_DIR="$TMPD/data" FACTORY_DB="$TMPD/factory.db" node -e '
  const { db, DATA_DIR } = await import("./src/db.js");
  db.exec("VACUUM INTO \x27" + DATA_DIR + "/backup-前.db\x27");      // 备份不需要停服务
  console.log("已备份到 " + DATA_DIR + "/backup-前.db");'

# 步骤 1：优雅停机（有 drain 后）→ 或模拟「被 kill」场景时跳过本步
kill -TERM <pid>            # 触发 markDraining → 排空 → 写 ops:last-shutdown

# 步骤 2：启动（临时实例）
FACTORY_DATA_DIR="$TMPD/data" FACTORY_DB="$TMPD/factory.db" \
FACTORY_CONFIG="$TMPD/config.json" PORT=8799 node server.js
# 期待日志（顺序即恢复顺序）：
#   [boot] 采集到 N 个残留任务
#   [jobs] 已将 N 个中断任务标记为失败：…
#   [jobs] 恢复重投：resumed=M skipped=K pendingApproval=J
#   [ops] 排产残行清理：pending=P 已处置（error=E）
#   [schedules] 已启动（tickMs=60000）：立刻跑一轮补齐停机窗口

# 步骤 3：核对（只读接口，不改状态）
curl -s localhost:8799/api/ops/status | python3 -m json.tool
curl -s "localhost:8799/api/jobs?status=queued&limit=50"
curl -s "localhost:8799/api/schedules/runs?limit=50"      # T-101 的台账接口，本卡不另开

# 步骤 4：逐条核对「不漏跑」（残留清单里的每个 jobId 必须有归宿）
#   · 已重投 → 新 jobId 的 payload.fromJobId 等于原 id（或 ledger 有行）
#   · 未重投 → 观测里有中文 reason，且该业务对象（制片项目阶段/画布节点）处于可人工重跑状态
#   判定：collectLeftoverJobs() 的数量 == resumed + skipped + pendingApproval 数量（恒等式，写进测试）

# 步骤 5：逐条核对「不重复跑」
#   node -e '…SELECT idem_key, COUNT(*) c FROM jobs WHERE status IN ("queued","running") GROUP BY idem_key HAVING c>1…'
#   期望：0 行；schedule_runs 同一 fire_key 也只有 1 行

# 步骤 6：放行人工闸门（付费阶段）
#   恢复流程**不会**自动跑付费阶段：确认码是一次性的，被核销后不可复用。
#   人工在界面重新生成计划 → 批准 → 用新确认码放行。

# 步骤 7：解除暂停（若重启前是暂停态）
#   恢复流程默认**不解除暂停**（防「重启绕闸门」）。确认预算/额度后再 POST /api/queue/resume。

# 步骤 8：处置排产 pending 残行（若有）
#   GET /api/schedules/runs?status=pending 逐条看：有 job_id 的已被 §4.6 对账回写；
#   没有 job_id 的说明「预留在建项目阶段就被杀」→ 用 POST /api/schedules/:id/trigger 人工补一次。

# 步骤 9：清理重复产物（若有）
#   恢复报告 duplicates 里的旧成片文件：确认交付包已引用新文件后再删（交付包内含引用路径）。
```

### 4.6 陈旧残行：`schedule_runs.status='pending'`（本卡补 T-101 遗留的「漏跑」洞）

T-101 §7 的写入顺序是「**先写 `pending` 台账行 → 再建项目/入队**」（其 §7 结尾解释了原因：唯一索引必须原子占位，宁可留残行也不能重复花钱），并在 §12.4 明确：**`fireSchedule` 期间进程被杀会留下 `pending` 残行，重启后该窗口会被幂等去重、不自动重试，需要人工在 `/api/schedules/runs` 里看到并手动触发**。

这正是「不漏跑」的最后一个洞：残行所在的窗口既没建项目、也不会被后续 tick 重新触发（`fire_key` 已占位），**若无人看就永久静默丢失**。本卡要求在启动恢复块里显式处置：

```js
/**
 * 启动期清理陈旧排产残行（只读判定 + 有限的写回；不建项目、不入队、不自动重试）
 * @param {{ now?:string, staleMs?:number, dryRun?:boolean }} opts
 *        staleMs 默认 10 分钟（远大于 createProduction 的最坏耗时，避免误判正在跑的 tick）
 * @returns {{ swept:number, reconciled:number, stale:[{runId,scheduleId,fireKey,status,jobId,action,reason}] }}
 */
export function sweepPendingScheduleRuns({ now = nowISO(), staleMs = 600000, dryRun = false } = {}) 
```

| 残行情形 | 判定依据 | 处置 | `reason`（中文） |
|---|---|---|---|
| `status='pending'` 且 `job_id` 非空 | 已经入队，只是没结算 | 调 T-101 的 `reconcileScheduleRuns()` 回写 `done/error` | 沿用 T-101 §10.3 文案 |
| `status='pending'` 且 `job_id` 为空，且 `production_id` 非空 | 项目建好了、job 没建成 | 回写 `status='error'`，保留 `production_id` 可追溯 | `'重启时该窗口在建任务阶段被打断：制片项目已建但任务未入队，请用「立即跑一次」补跑'` |
| `status='pending'` 且 `job_id`/`production_id` 均为空，且 `updated_at` 早于 `staleMs` | 什么都没建成 | 回写 `status='error'`（**不删行**，保留占位让窗口不重复触发） | `'重启时该窗口在预留阶段被打断：未创建任何项目或任务，请用「立即跑一次」补跑'` |
| 任意 | `updated_at` 在 `staleMs` 之内 | **不动**（可能正是本进程/其他实例正在跑的 tick） | — |

- **不自动补跑**：与 T-101 不变量 2 一致（恢复闸门与补跑是人类的决定）；残行只做「可见 + 可人工补救」。
- **可见性**：`/api/ops/status.incidents` 增加 `sched_run_pending_stuck`（严重度 中，条件：存在 `status='pending'` 且 `updated_at` 超 `staleMs` 的行），并在 `queue.runs` 里给出计数。
- **人工补救路径**：`GET /api/schedules/runs?status=pending`（T-101 路由）→ 人工确认后 `POST /api/schedules/:id/trigger`（T-101 §9.6，`occurrence_at` 给一个新值即可绕开幂等）。**本卡不新增补救接口**。

---

## 5. 观测点

### 5.1 日志字段规范（stdout，行首固定标签 + key=value，末尾中文人话）

格式：`[标签] event=<事件名> k=v k=v … | 中文说明`

> **排产日志以 T-101 §10.4 的句式为准**（`console.log('[schedules] 触发 %s → 窗口 %s → 任务 %s', …)` / `'[schedules] 跳过 %s：%s'`），本卡**只在其后追加键值**（`fire=<fire_key> idem=<key> producer=scheduler prio=10`），**不改标签名、不另立 `[sched]`**。下表其余标签（`[boot]`/`[jobs]`/`[queue]`/`[ops]`/`[heal]`）由本卡固定。

| 事件 | 标签 | 必带字段 | 中文说明示例 |
|---|---|---|---|
| 启动采集 | `[boot]` | `event=boot.collect leftovers=<n>` | `采集到 3 个残留任务` |
| 启动自愈 | `[jobs]` | `event=jobs.recover recovered=<n> ids=<逗号分隔前5>` | `已将 3 个中断任务标记为失败`（既有日志保留，一字不改） |
| 恢复重投 | `[jobs]` | `event=jobs.resume resumed=<n> skipped=<n> pendingApproval=<n> jobIds=<…>` | `恢复重投 2 个、跳过 1 个、待人工批准 1 个` |
| 单条不可恢复 | `[jobs]` | `event=jobs.resume.skip job=<id> type=<t> reasonCode=<枚举>` | `JOB-xxx 不支持自动续跑：封装类任务中断请人工重跑` |
| 队列暂停 | `[queue]` | `event=queue.pause by=<human\|system> scope=<all> reason=<文本> queued=<n> running=<n>` | `队列已暂停（system）：本月金额将超上限…` |
| 队列恢复 | `[queue]` | `event=queue.resume by=<…> resumedFrom=<原因>` | `队列已恢复（原因为：…）` |
| 停机 drain | `[queue]` | `event=queue.drain note=<文本> running=<n> pending=<n>` | `进入停机排空：10 个任务执行中，最多等 30s` |
| 排产触发 | `[schedules]` | T-101 原句 + 追加 `fire=<fire_key> idem=<key> producer=scheduler prio=10` | `[schedules] 触发 SCH-0001 → 窗口 2026-06-01T01:00:00Z → 任务 JOB-xxx | fire=…` |
| 排产跳过/漏跑 | `[schedules]` | T-101 原句 + 追加 `reasonCode=<skipped_paused\|skipped_budget\|skipped_running\|skipped_missed\|skipped_deduped>` | `[schedules] 跳过 SCH-0001：队列暂停中（…）` |
| 排产巡检 | `[schedules]` | T-101 的 `schedule:tick` 事件 + 追加 `due=<n> queued=<n> skipped=<n> deduped=<n> paused=<bool>` | `[schedules] 巡检：2 个窗口到期，1 个已入队，1 个因暂停跳过` |
| 残行清理 | `[ops]` | `event=ops.sweep.pending pending=<n> reconciled=<n> errored=<n> staleMs=<n>` | `排产残行清理：3 条 pending，1 条对账回写，2 条标记需人工补跑` |
| 去重合并 | `[jobs]` | `event=job.dedupe idem=<key> existing=<JOB-id> status=<…> producer=<…>` | `提交被合并：该任务已在队列中` |
| 实例租约 | `[schedules]` | `event=sched.lease action=<acquire\|renew\|lose> pid=<n> heldBy=<pid>` | `另一实例正在排产，本实例只读不排产` |
| 任务失败（既有） | `[job:<type>]` | 保持现状 | `[job:studio] JOB-xxx 失败：…` |
| 后端降级（T-102 联动） | `[heal]` | `event=heal.degrade stage=<s> from=<backend> to=<backend> errorKind=<kind> attempt=<n>` | `关键帧出图后端从 comfyui-h3 降级为 placeholder（原因：超时）` |

**字段字典（固定含义，不得一名多义）**

| 字段 | 含义 | 取值 |
|---|---|---|
| `job` | 任务 id | `JOB-…` |
| `type` | 队列类型 | §1.1 的类型集 |
| `idem` | 幂等键 | §3.1 命名规范 |
| `producer` | 提交来源 | `human` / `agent` / `scheduler` / `system` |
| `stage` | 制片阶段 | `STUDIO_STAGES` 的 11 个 id |
| `window` | 排产窗口起点 | UTC ISO |
| `backend` | 出图/视频后端 | `placeholder` / `comfyui-h3` / `generic-http` / `openai-images` |
| `errorKind` | 错误归类 | `ERROR_KINDS` 的 11 类（`retry.js:6`） |
| `gate` | 拦截闸门 | `paused` / `budget` / `storage` / `plan_expired` |
| `reasonCode` | 停顿原因枚举 | `paused` / `auto_paused` / `queue_paused` / `awaiting_approval` / `plan_expired` / `draining` / `locked` / `not_resumable` |

### 5.2 库表字段（事实源，SQL 可查）

| 表 | 新增字段 | 用途 |
|---|---|---|
| `jobs` | `idem_key TEXT`、`producer TEXT DEFAULT 'human'` | 去重键与来源；`idx_jobs_idem(idem_key,status)` 支撑查重 |
| `jobs.payload` | 约定字段 `fromJobId`（恢复重投时写入）、`scheduleId`、`occurrenceAt`、`fireKey`、`resume` | 恢复可追溯、排产可追账（T-101 §3 的 `enqueueScheduledRun` 已带 `scheduleId/occurrenceAt`） |
| `jobs.result` | 约定字段 `attempts`（含重试）、`degrade:{from,to,errorKind}`（T-102）、`duplicates:[…]` | 降级与重复产物可见 |
| `schedule_runs` | **T-101 已定义，本卡不改表**（见 §3.6 对齐表） | 排产窗口台账，唯一索引 `uq_schedule_runs_fire(fire_key)` = 不重复跑的最终防线 |
| `app_config` | `ops:scheduler-lease`、`ops:last-shutdown`、`ops:last-boot`（新增）；`jobs:paused`、`jobs:pause-log`（既有） | 租约/停机现场/启动现场/暂停状态 |

### 5.3 接口字段（最小新增，**只做加法**）

| 接口 | 改动 | 具体字段 |
|---|---|---|
| `GET /api/health` | **新增字段**（既有字段一个不动，`jobs` 仍为 `queueStats()`） | `scheduler:{ enabled, tickMs, lastTickAt, nextDueAt, dueCount, pendingStuck, lease:{ holder, at, mine } }`、`recovery:{ lastBootAt, lastShutdownAt, leftovers, resumed, skipped, pendingApproval, swept }`、`instance:{ instanceId, pid, uptimeSec, draining }` |
| `GET /api/queue/state` | 新增字段（既有 `paused/reason/by/at/scope/stats/usage/history` 全保留） | `draining:bool`、`schedules:{due, pendingStuck, last24h:{queued,skipped,missed,deduped}}` |
| `GET /api/jobs` | 列表项新增 | `idem_key`、`producer`；过滤支持 `?idem=<key>`、`?producer=scheduler` |
| `GET /api/jobs/:id` | 新增 | `resume`（同 §4.3 判定结论）、`idem_key`、`producer` |
| `GET /api/ops/status`（新） | 只读汇总，一屏给运维 | `{ ok, instance:{instanceId,pid,uptimeSec,draining}, queue:{paused,reason,by,stats,queued,running}, scheduler:{enabled,tickMs,lastTickAt,nextDueAt,dueCount,pendingStuck,lease}, runs:{due,last24h:{queued,skipped,missed,deduped,pending}}, recovery:{lastBootAt,lastShutdownAt,leftovers,resumed,skipped,pendingApproval,swept}, budget:{month,amount,cap,projected,blocked}, storage:{totalGB,warnGB,maxGB,over}, backends:{image,video,llm}, incidents:[{code,severity,at,text}] }` |
| `GET /api/schedules/runs` | **复用 T-101 §9.7 的既有契约**，本卡不新建 | 排产台账的唯一读取入口（含中文 `reason`） |
| `POST /api/ops/resume`（新，受控动作） | 人工补救**被重启打断的任务**（与排产手动触发 `POST /api/schedules/:id/trigger` 分工不同：那个是「补一个窗口」，这个是「补一个半途而废的任务」） | 入参 `{ dryRun:true（默认）, jobIds?:[…] }`；`dryRun` 时只返回将要重投的清单与中文原因，`dryRun=false` 时才真正重投；**白名单内类型才允许**，付费阶段一律返回「须人工重新批准」 |

**`GET /api/ops/status` 的 `incidents` 生成规则（告警判据）**

| code | 触发条件 | 严重度 |
|---|---|---|
| `queue_paused` | `pauseState().paused === true` | 高（闸门已关闭） |
| `scheduler_stalled` | `scheduler.enabled && now - lastTickAt > 3 × tickMs` | 高（排产停摆） |
| `scheduler_lease_lost` | 租约被其他实例持有 | 中 |
| `jobs_stuck` | 存在 `running` 任务且其耗时 > 3 × 该类型 `stats.productionStats().tasks.byType[type].p95Ms`（无历史则用 15 分钟兜底） | 高 |
| `jobs_leftover` | 上次启动 `recovery.leftovers > 0` | 中 |
| `sched_run_pending_stuck` | 存在 `schedule_runs.status='pending'` 且 `updated_at` 超 `staleMs`（默认 10 分钟） | 中（该窗口可能永久漏跑，见 §4.6） |
| `runs_missed` | 近 24h `schedule_runs` 中 `status IN ('skipped_missed')` 的行数 > 0 | 中 |
| `budget_near_cap` | `projected >= 0.9 × cap`（`guard.getUsage`+`shouldAutoPause` 口径） | 中 |
| `disk_warn` / `disk_over` | `diskUsage().warn` / `.over` | 中 / 高 |
| `backend_not_ready` | `imageBackendStatus().ready === false` 或 `video.backend` 探测失败 | 中 |
| `dup_alive_idem` | `SELECT idem_key,COUNT(*) c FROM jobs WHERE status IN ('queued','running') GROUP BY idem_key HAVING c>1` 非空 | 高（说明唯一索引没建上） |

### 5.4 观测不到的盲区（必须如实写进文档，不许假装有数据）

- **执行中的实时进度只有内存事件**：`jobEvents` 的 `job:log` 只推给 SSE 订阅者（`/api/jobs-stream`），不落库 → 重启后**日志正文不可追溯**，只能看 `jobs.progress/updated_at`。
- **队列的实时并发现状重启即归零**：`queueStats()` 是内存快照；`/api/health.jobs` 只在**当前进程**有意义。
- **暂停的 `scope` 字段目前只是记录**（`pauseQueues` 存了 `scope`，`pump` 只读全局 `paused`）→ 不要对外宣称「支持按类型暂停」。
- **`jobs` 表不记录重试次数**（`withRetry` 的 attempts 只进内存错误对象）→ 观测重试需要 T-102 把 `attempts` 写进 `jobs.result`。
- **ffmpeg/后端耗时没有独立埋点**：`stats.productionStats()` 的 `avgMs/p95Ms` 是 `finished_at - created_at` 的粗粒度口径，含排队时间 → 判「卡死」时要区分「排队久」与「执行久」。

---

## 6. 回滚方案

三级回滚，按「影响面 × 恢复时间」从轻到重；**每级都有明确的触发条件**，不允许拍脑袋回滚。

### 6.1 一级：配置回滚（秒级，不动代码、不改数据）

| 触发条件 | 动作 | 命令/接口 | 验证 |
|---|---|---|---|
| 排产误触发/重复触发 | 关排产（tick 立即停止，队列中已排的照常跑） | `config/config.json` 置 `schedules.enabled=false`，或带 `FACTORY_SCHEDULER=off` 启动 | `GET /api/ops/status` → `scheduler.enabled=false`，`schedule_runs` 不再新增 `queued` |
| 花费异常增长 | 暂停队列（**不丢任务**） | `POST /api/queue/pause {reason:'费用异常，人工核查'}` | `pauseState().paused=true`（重启后依然暂停，防绕闸门） |
| 排产补跑雪崩 | 把 `miss_policy` 改回 `'skip'`（`catchup_max` 调 0） | `PATCH /api/schedules/:id {miss_policy:'skip', catchup_max:0}` | 台账中 `skipped_missed` 增加但不再出现 `queued` |
| 单实例锁误判（明明只有一个实例却不排产） | 删租约键 | `node -e` 删 `app_config['ops:scheduler-lease']` | 下一 tick 日志出现 `sched.lease action=acquire` |

### 6.2 二级：代码回滚（分钟级，保留数据）

- **回滚内容**：`server.js` 的启动序列恢复为「`recoverStaleJobs()` 一行 + `cleanupIntermediates()`」，去掉 `collectLeftoverJobs/resumeLeftovers/sweepPendingScheduleRuns/warmQueues` 与 scheduler 定时器（`app.__scheduler?.stop()`）；`src/routes/ops.js` 可整体不挂载。
- **保留不删**：`jobs.idem_key` / `jobs.producer` 两列、两个索引 —— 旧代码完全忽略它们（SQLite 加列向后兼容），删除反而制造额外风险。`schedule_runs` 属 T-101，本卡不涉及删表。
- **不需要数据迁移回退**：本方案**不改任何既有列的类型与语义**，不写数据回填脚本。
- **禁止**：为了让回滚后的自检变绿而修改既有测试期望（`tests/test-jobs.js`、`tests/test-render.js` 对 `recoverStaleJobs` 的断言必须原样通过）。
- **回滚判定指标**：回滚后必须满足 ①`node tests/test-jobs.js` 全绿 ②`node tests/test-studio.js` 全绿 ③`node tests/selfcheck.js` 全绿 ④`GET /api/health` 的既有字段（`jobs/counts/llm/image`）一个不少。

### 6.3 三级：数据回滚（小时级，最后手段）

- **备份（零依赖，实测 C5 可行）**：
  ```js
  // 备份函数契约（新增导出，供 CLI 与 /api/ops/backup 复用）
  /** 备份数据库到 data/backups/<file>（用 SQLite VACUUM INTO，热备份不锁服务） */
  export function backupDatabase({ file } = {}) // => { ok, file, bytes, at }
  ```
  目标目录：`DATA_DIR/backups/`；文件名 `factory-<YYYYMMDD-HHmmss>.db`；路径必须经 `safeJoin(DATA_DIR, …)` 校验，禁止绝对路径逃逸。
- **不得依赖 `/api/export` 做运维回滚**：`src/routes/meta.js:286` 的导出**只含** `actors/actor_images/canvases/canvas_nodes/novels/novel_outlines/novel_chapters/scripts/script_episodes/shots` —— **不含** `jobs`、`productions`、`production_stages`、`app_config`（暂停状态！）、`canvas_plans`、`canvas_snapshots`。用它回滚会丢队列与暂停状态，反而制造「闸门被打开」的事故。
- **还原步骤**：
  ```
  1. 停进程（优雅停机，§4.1）
  2. 现场留档：把当前 data/factory.db、factory.db-wal、factory.db-shm 三个文件改名留档（不要直接删）
  3. 用备份文件替换：cp backups/factory-<ts>.db data/factory.db，并删除残留的 -wal/-shm
  4. 启动：观察 [boot] 采集/自愈日志；确认 recovery.leftovers 与备份时点一致
  5. 对账：GET /api/ops/status + GET /api/schedules/runs，核对排产窗口没有重复 queued
  ```
- **触发条件（任一）**：恢复流程产生重复产出且交付包引用了错误文件；排产在无人确认的情况下让付费阶段实际执行（安全事件，须走 T-107 流程）；`jobs` 表出现同 `idem_key` 双活。

### 6.4 回滚验收清单（每次回滚都要走完）

```
□ node tests/selfcheck.js          全绿（引擎/字典/提示词/队列）
□ node tests/test-jobs.js          全绿（★ 含 recoverStaleJobs 既有断言，未改期望）
□ node tests/test-studio.js        全绿（★ 含 auto_paused / queue_paused / 时间线 queue 事件）
□ node tests/test-guard.js         全绿（预算闸门语义未变）
□ GET /api/health、GET /api/queue/state 既有字段完整；新增字段缺省不报错
□ 恢复恒等式：leftovers == resumed + skipped + pendingApproval
□ 无双活 idem：group by 查询 0 行
□ 排产窗口无重复：schedule_runs 每个 fire_key 仅 1 行；无超期 pending 残行
```
（以上均用**临时库**执行；`./scripts/verify-all.sh` 太重且与并行任务冲突，本卡不跑，由 T-106/T-701 在收口阶段执行。）

---

## 7. 风险评估（只记录，不在本卡修改）

| # | 风险 | 证据 | 影响 | 建议（交实施卡） |
|---|---|---|---|---|
| R1 | 停机被系统当 drain 使用会**永久关闭闸门** | 实测 B4：`pauseQueues` 的状态跨重启持久 | 重启后队列停摆且无人知道原因 | 严格区分 `markDraining()`（内存）与 `pauseQueues()`（落库） |
| R2 | `resumeQueues()` 一次性放行全部队列 | `jobs.js:64` 遍历所有类型 | 停机一天后恢复可能瞬间涌入多个大任务，冲爆预算/磁盘 | 恢复后由排产 tick 按 `miss_policy`/`catchup_max` 逐个放行 |
| R3 | 多进程共享同一 `FACTORY_DB` 时并发上限失效 | 队列在内存（`jobs.js:9`） | 双份排产、双倍计费 | 实例租约 + 文档明确「单进程约束」 |
| R4 | `queueStats()` 重启后为空被误读为「队列空」 | 实测 B5 | 运维误判「没有任务在跑」 | `warmQueues()` 预建 + `/api/ops/status` 给明确口径 |
| R5 | 付费阶段确认码被重启打断后不可复用 | `canvas_plans.status='consumed'` 一次性核销 | 若自动重投会变成「无批准执行」的安全事故 | 恢复矩阵中付费阶段**永不自动重投**（§4.3） |
| R6 | 长任务（15 分钟级）与 1500ms 兜底退出冲突 | `server.js:131` 兜底 exit | 每次重启都硬杀任务 → 残留常态化 | drain 超时可配 + 恢复流程常态化演练 |
| R7 | `/api/export` 不含队列/暂停/制片表 | `meta.js:286` | 用它回滚会打开预算闸门 | 运维回滚一律用 `VACUUM INTO` 备份 |
| R8 | 暂停的 `scope` 字段不生效 | `pauseQueues` 存了 `scope`，`pump` 只读全局 `paused` | 界面若按 scope 展示会误导 | 文档标注「当前仅记录」，或后续实现按队列暂停 |
| R9 | 封装类任务重跑产生重复成片文件（不重复计费） | `episode_films` 文件名唯一 | 磁盘增长、交付包可能引用旧件 | 恢复报告输出 `duplicates`，由人工确认后清理 |
| R10 | 脚本与运行实例共用 `data/` | 既有测试强制临时库，但脚本若不设环境变量会污染生产库 | 生产数据被测试写脏 | 运维约定：任何脚本运行必须显式给 `FACTORY_DB/FACTORY_DATA_DIR` |
| R11 | 排产 `pending` 残行会让该窗口**永久静默漏跑** | T-101 §7 先写台账再建项目；其 §12.4 承认残行需人工处理 | 定时任务丢一档且无人知晓 | 本卡 §4.6 `sweepPendingScheduleRuns()` + `sched_run_pending_stuck` 告警 |

---

## 8. 验收对照（逐条对 `acceptance_criteria`）

| 验收项 | 落点 | 自检方式 |
|---|---|---|
| **给出重启恢复步骤（不漏跑、不重复跑）** | §4.1 停机 6 步、§4.2 启动序列（含与 T-101 `startScheduler` 的时序）、§4.3 判定矩阵、§4.5 操作手册 9 步、§4.6 排产 `pending` 残行处置 | 恒等式 `leftovers == resumed + skipped + pendingApproval`；同 `idem_key` 无双活；`schedule_runs` 单 `fire_key` 单行；无超期 `pending` 残行 |
| **给出观测点（日志字段/接口字段）** | §5.1 日志事件与字段字典（排产沿用 T-101 的 `[schedules]` 句式）、§5.2 表字段、§5.3 接口字段、§5.4 盲区 | 按 §5.1 的关键字 grep 日志可复现每个恢复动作；`GET /api/ops/status` 覆盖 11 条告警判据（含 `sched_run_pending_stuck`） |
| **给出回滚方案** | §6 三级回滚 + 触发条件 + 备份/还原步骤 + 验收清单 | 一级回滚后 `scheduler.enabled=false` 可验；二级回滚后四个既有套件全绿（未改测试期望） |
| 契约可直接指导实现 | §2 新增物清单、§3.1 函数签名与幂等键、§3.7 入队座位（唯一跨卡改动点）、§4.3/§4.6 返回值契约、§5.3 字段路径 | 本卡自有 DDL 与去重语义已在临时库实测（§1.4 C1~C6）；排产表结构沿用 T-101 已核实契约 |

---

## 9. 与其他任务卡的边界

| 卡 | 边界 |
|---|---|
| T-101 定时排产契约（已落地，本卡逐字对齐） | T-101 定 `schedules`/`schedule_runs` 表结构、`fire_key` 唯一键、状态枚举、`miss_policy`/`catchup_max`/`catchup_after_pause`、`tickSchedules`/`startScheduler`/`reconcileScheduleRuns` 签名、`/api/schedules*` 路由、`[schedules]` 日志句式。**本卡只加三样**：① `jobs.idem_key = fire_key` 的队列侧活任务唯一约束 ② `enqueueScheduledRun` 内部改走 `submitJob`（唯一跨卡改动点，对外签名不变）③ §4.6 的 `pending` 残行处置与 §4.4 的实例租约 |
| T-102 阶段失败自愈 | 自愈换后端把 `attempts/degrade` 写进 `jobs.result`（§5.2）；**恢复重投不得与自愈重试叠加放大**：重投时把历史次数写入 `payload.prevAttempts`，重投后总次数上限仍为 1 次业务重试 |
| T-106 测试计划 | 本卡给出「恢复恒等式 / 无双活 idem / 单窗口单行」三条可断言不变式，T-106 据此写用例；测试必须用临时库与离线假实例，不得重启 8788 |
| T-107 安全风险 | 本卡 §4.3「付费阶段永不自动重投」是安全约束；`POST /api/ops/resume` 默认 `dryRun:true` 属高风险管理动作，需按 T-107 要求加白名单与审计 |
| T-109 文档影响面 | 本卡 §4.1/§4.5 的运维章节应落进 `docs/使用手册.md` 的「运维」章节；`README.md` 的运行段需补 `FACTORY_SCHEDULER` 与「同一库只允许一个进程」 |

---

## 10. 本卡未做（明确声明）

- **未写任何代码、未改任何白名单外文件**；`strategist/reports/` 下仅新增本文件。
- **未启动/重启任何服务**，未触碰 `data/factory.db`；§1.4 的全部证据均来自 `mkdtemp` 临时库的两个独立进程。
- **未运行 `./scripts/verify-all.sh`**（金律：太重且与并行任务冲突）；本卡只做只读侦察与契约产出。
- T-101 的契约在本卡写作过程中已落地（`strategist/reports/T-101-schedules-spec.md`），本卡已按其真实字段名/状态枚举/路由/日志句式**逐字对齐**（§3.6、§3.7、§4.2、§4.6、§5.1、§5.3、§9）；T-102 尚未落地，其 `jobs.result.attempts/degrade` 字段约定属**本卡提议**，实施前需与 T-102 对齐一次。
