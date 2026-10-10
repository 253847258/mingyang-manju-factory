# C-02 四路开发线 · 回滚预案与集成次序（第 2 轮 W2）

> **角色**：统筹 · 风险与回滚（不实现功能，只给可执行的次序与回退步骤）
> **写入范围**：本文件 `strategist/reports/C-02-rollback-plan.md`、结论 `strategist/runs/C-02.json`；**不改任何源码与既有测试**
> **上游依据（全部只读核对，行号即证据）**：`strategist/reports/README.md`（两次运行收口报告）｜`strategist/reports/L6-verify.md`（L6 独立验收 466 行 + 6 条残余风险）｜`strategist/reports/A-01-arch-ruling.md`（架构裁定 451 行）｜`strategist/reports/D-01-ui-plan.md`（UI 规划 545 行）｜`strategist/tasks/C-001~C-005*.yaml`｜`strategist/reports/T-101/T-102/T-103/T-104/T-105/T-106/T-107/T-108*.md`｜`strategist/runs/*.json`
> **环境事实取证**：2026-09-29 11:5x；`node --version` = **v24.18.0**；**不是 git 仓库**（`git status` → `fatal: not a git repository`）；本仓零 npm 依赖
> **本文件性质**：W2 开发线**开工前必读**的操作手册。每条步骤都带命令与判据；不出现"优化一下""注意一下"类空话（自查见 §14）。

---

## 0. 结论速览（先看这张表）

| # | 事项 | 结论 |
|---|---|---|
| 1 | 版本控制 | **无 git**。唯一回滚手段是文件副本 `.bak`；本仓现有 6 个 `.bak` **全部是 09:26 的 L5 集成前版本**，直接还原会连带回退已验收能力 → 见 §3.2 归档规则。 |
| 2 | 服务 | 8788 由 **PID 2679524**（`node server.js`，STARTED `Tue Sep 29 10:31:35 2026`）持有，`GET /api/schedules` → **200**（1673 字节）。**禁止重启**：回滚源码后进程内仍持旧模块，改动要生效必须重启 → 只能由总军师裁决，W2 任何角色不得自行重启或另起实例。 |
| 3 | 四路 | **排产线（C-003）｜画布线（C-002）｜字幕线（A-01 §5 卡 B，未派卡）｜UI 线（D-01 落地，未派卡）**；C-004 是**前置安全线**（不是四路之一），C-005 是验收线。 |
| 4 | 集成次序（一句话） | **C-004 配置安全 → 字幕线 → 画布线 → 排产线 → UI 线 → 共享文件收口 → 全量回归 → 归档**（理由见 §6.1）。 |
| 5 | 最大风险文件 | `web/views/actors.js`：**4958 行 / 277,921 字节**（本仓最大），专项回退步骤 **A-1~A-10** 见 §9。 |
| 6 | 必须先裁决的冲突 | ① **错误码二义**：C-002 卡面 = `CANVAS_ID_REQUIRED`，D-01 `D-C-07` 写 `NO_CANVAS_CONTEXT` → UI 线不得自造第三个码（§15 C02-R1）；② **`scripts/verify-all.sh` 当前无卡承接**（阶段 31/32 追加无 owner，§15 C02-R2）。 |
| 7 | 最易踩的四个坑 | ① 用整文件覆盖式写 `actors.js`；② 覆盖已存在的旧 `.bak`（丢掉 L5 前还原点）；③ 跑全量自检会**改写真实 `config/config.json`**（RK-L6-06，阶段 23）；④ 回滚后以为线上已生效（其实需重启，而重启被禁）。 |

---

## 1. 四路的定义、卡面状态与白名单

### 1.1 四路对照表（**以任务卡为唯一口径**）

| 线 | 目标 | 主文件（write_scope） | 卡状态 | 依赖 | 卡面 `.bak` 约定 |
|---|---|---|---|---|---|
| **线一 排产线** | 修 `RK-L6-01` 之外的排产两处：`S-10` 单轮触发上限 + manual 丢弃 `occurrence_at` | `src/schedules.js`、`tests/test-schedules.js`；**路由层回显**：`src/routes/schedules.js`（A-01 §2.4 步骤 2，当前**无卡承接**） | **C-003 已派**（wave 2）；路由层部分待派 | C-001 | `cp src/schedules.js src/schedules.js.bak`、`cp tests/test-schedules.js tests/test-schedules.js.bak`（**当前无同名旧 `.bak`**，安全） |
| **线二 画布线** | 修 `RK-L6-01`：`planBatch` 的 `canvasId` 三级自证 + 缺省**拒绝** | `web/lib/canvas-select.js`、`tests/canvas-select.test.mjs` | **C-002 已派**（wave 2） | C-001 | `cp web/lib/canvas-select.js web/lib/canvas-select.js.bak`、`cp tests/canvas-select.test.mjs tests/canvas-select.test.mjs.bak`（**当前无同名旧 `.bak`**，安全） |
| **线三 字幕线** | 把 `src/finish.js` 的断行接给 `src/subtitle-wrap.js`（缺省 `legacy`，逐字节不变） | `src/finish.js`、新建 `tests/test-subtitle-wire.js` | **未派卡**（A-01 §5「卡 B」，本文 §5.3/§10.3 补齐卡面要素） | A-01 裁定 ② | `cp src/finish.js src/finish.js.bak`（**当前无同名旧 `.bak`**，安全） |
| **线四 UI 线** | 落地 D-01 的 `D-C-01~14` / `D-S-01~12`（含消费 C-002 新错误码） | `web/views/actors.js`、`web/views/render.js`（+ `web/lib/ui.js` a11y） | **未派卡**（D-01 是规划书，不是任务卡） | **C-002 必须先落地**（消费其错误码/字段） | ⚠️ **`web/views/actors.js.bak`（261,726 B / 09:26）与 `web/views/render.js.bak`（140,198 B / 09:26）已存在** → **必须先归档再建新备份**，见 §3.2 |
| 前置线 | `tests/ui-simulate.py` 对 `config/config.json` **零改写** + 补 ≥3 断言 + T-108 运维须知 | `tests/ui-simulate.py`、`strategist/reports/T-108-ops-plan.md` | **C-004 已派**（wave 2） | C-001 | 卡面已给：`cp tests/ui-simulate.py tests/ui-simulate.py.bak`、`cp strategist/reports/T-108-ops-plan.md strategist/reports/T-108-ops-plan.md.bak`（**无同名旧 `.bak`**） |
| 验收线 | 独立验收 C-002/C-003/C-004 + 红队 ≥5 + 全量回归 + README 台账 | `strategist/reports/C-005-verify.md`、`README.md` | **C-005 已派**（wave 3） | C-002/C-003/C-004 | `cp README.md README.md.bak` ⚠️ **`README.md.bak`（45,351 B / 09:26）已存在 → 先归档** |

**四路的并行安全性（来自卡面 write_scope 实测）**：C-002 与 C-003 的 write_scope **两两不相交**（`web/lib/*` vs `src/schedules.js`），可并行；C-004 只碰 `tests/ui-simulate.py` 与 T-108 报告，也可并行；**字幕线（`src/finish.js`）与 UI 线（`web/views/*`）互相不相交，但 UI 线功能上依赖 C-002 的新错误码** → 次序上排到最后（§6）。

### 1.2 "四路"与上游用词的对齐（避免复核者按旧口径误判）

- A-01 §5 给的是 **3 张建议卡（卡 A 排产幂等收口 / 卡 B 字幕接线 / 卡 C 集成与文档）**，D-01 给的是 **UI 待补齐清单**，实际派卡为 **C-001~C-005**。
- 本文的"四路"= **功能开发线**（排产 / 画布 / 字幕 / UI），其中 C-004 是**前置安全线**、C-005 是**验收线**、A-01 卡 C 的收口动作**当前没有卡承接**（§15 C02-R2）。
- 若总军师改用"三卡"口径，按 §1.1 的"主文件"列重映射即可：**本文的所有回滚单位都是"文件 + 线"，与卡编号无关**。

---

## 2. 硬约束与逐条校验命令（违反即返工）

| # | 约束（出处） | 校验命令 | 判据 |
|---|---|---|---|
| 1 | 零 npm 依赖（全卡） | `grep -c '"dependencies"' package.json` | `0` |
| 2 | **不重启 8788**（任务书红线 + L6-verify 红线） | `ps -eo pid,lstart,cmd \| grep -c '^ *2679524'` | `1`（PID 与启动时间全程不变） |
| 3 | 不改既有测试期望凑绿（C-002/C-003 卡面） | `node tests/canvas-select.test.mjs`、`node tests/test-schedules.js` 计数 | **只增不减**：222 → ≥228；116 → ≥124 |
| 4 | 既有 25 阶段编号与名称不变（T-401 口径） | `grep -n 'run "' scripts/verify-all.sh \| sed -n '1,25p'` | 与 §3.3 基线逐行一致 |
| 5 | 中文注释与中文报错（全卡） | 见 §11 各症状对应的原始输出 | 新增码/原因均为中文原文 |
| 6 | 只写白名单（全卡） | `find . -newermt '-2 hours' -type f -not -path './data/*'` | 只列出该卡 write_scope + `strategist/` 产物 |
| 7 | 改既有文件先 `cp .bak`（全卡 `requires_backup`） | `ls -la <file>.bak` | 每个被改的既有文件都有**本波次**备份（旧同名备份已按 §3.2 归档） |
| 8 | 排产测试**不得碰真实库**（C-003 卡面） | `grep -c "data/factory.db" tests/test-schedules.js` | `0`（全程临时库） |
| 9 | 界面判定只来自 `canvas-select.js`；**不重构既有 DOM**（D-01 §0 铁律） | `python3 tests/ui-simulate.py http://127.0.0.1:8788` | 阶段 23 通过（D-01 明确：结构重构会引入假回归） |
| 10 | `config/config.json` **零改写**（C-004 卡面） | `md5sum config/config.json` 跑全量前后比对 | 字节一致 |
| 11 | 付费动作只出计划、禁打 `/api/canvas/run(-node)`（T-103 / D-01） | `grep -c "canvas/run" web/views/actors.js` | 不新增命中 |
| 12 | 不暴露思维链（任务书） | 交付物只含结论/命令/原始输出 | —— |

---

## 3. 事实基线（S0 必须原样执行）

### 3.1 指纹基线（本文件写作时实测；`md5sum -c` 可直接复现）

```bash
cd /home/linsheng/Desktop/ai-video-factory
mkdir -p /tmp/c02 && cat > /tmp/c02/baseline.md5 <<'EOF'
e4799441410b5c021cc816c22e2ea81f  src/schedules.js
379a35c643776c3a97a2f9188a1c6f4e  src/self-heal.js
502454ed11bc165c5c4fc1086b8b0bef  src/subtitle-wrap.js
54986a31255df20e69154679d8a478c0  src/routes/schedules.js
d39f8e8b97f5a1a0ab1b4ed2e1a29ea4  server.js
09866843fc3af6e2e0e0cbf56d4d990c  src/studio.js
7ba2c53c3d811f9b9a0122c505cff3a2  src/finish.js
8fad191e6608defd48ee9f62b91a08f6  web/lib/canvas-select.js
385167759e328fe4866b459457c95102  web/lib/canvas-perf.js
9df6e580e7c8c4bc737c346beb0d4d24  web/lib/ui.js
f70a1f39a2ee096f7dcb91257980606a  web/app.js
69f1774847c67608d03b3a8c17f88809  web/views/actors.js
fb6eaedef783f26daa17889268caf085  web/views/render.js
c0ddda84a7417e339f96f59549becc44  scripts/verify-all.sh
3e193ce640f4c9fb3ed03dfbaf504571  README.md
b7c67ee5c23f50d70dbe27a0bff1bf0b  tests/test-schedules.js
bf210565afa6266d8044e1e7f61373d3  tests/test-selfheal.js
c4b836918fec35e0c8cc655525539b30  tests/canvas-select.test.mjs
1e841e547831cbf14d14b904ea7582ef  tests/test-subtitle-wrap.js
2d3bac0b967bb13606890f32c132f580  tests/canvas-perf.test.mjs
EOF
md5sum -c /tmp/c02/baseline.md5      # 期望 20 行全部 OK
```

与 `L6-verify.md:462` 的记录**逐字一致**（5 个模块 + 5 个套件），说明 L6 之后无人在这些文件上落过字节；`web/lib/ui.js`、`web/app.js` 两个值与 `D-01-ui-plan.md:30-31` 一致（互证）。

### 3.2 旧 `.bak` 归档规则（**W2 开工第一件事**）

本仓现存 6 个 `.bak`（`ls -la *.bak */*.bak web/views/*.bak`）：

| 文件 | 大小/时间 | 语义 | 本波次是否会撞名 |
|---|---|---|---|
| `web/views/actors.js.bak` | 261,726 B / 09:26 | **L5 集成前** | ⚠️ **UI 线会撞**（`cp actors.js actors.js.bak` 会覆盖它） |
| `web/views/render.js.bak` | 140,198 B / 09:26 | L5 集成前 | ⚠️ **UI 线会撞** |
| `README.md.bak` | 45,351 B / 09:26 | 计数更新前 | ⚠️ **C-005 会撞** |
| `server.js.bak` | 6,475 B / 09:09 | T-401 注册前 | 本波次无人写 `server.js` |
| `scripts/verify-all.sh.bak` | 6,267 B / 09:09 | **25 阶段版** | 收口若追加阶段会撞（当前无卡承接，§15 C02-R2） |
| `src/studio.js.bak` | 85,554 B / 09:26 | T-402 自愈接线前 | 本波次无人写 `studio.js` |

**归档命令（撞名前必做，一次一条）**：
```bash
mkdir -p /tmp/c02/prebak
for f in web/views/actors.js.bak web/views/render.js.bak README.md.bak \
         server.js.bak scripts/verify-all.sh.bak src/studio.js.bak; do
  cp -p "$f" "/tmp/c02/prebak/$(echo "$f" | tr '/' '_').$(date +%Y%m%dT%H%M%S)"
done
ls -la /tmp/c02/prebak/        # 期望 6 个文件，大小与上表一致
```
**规则**：① 归档后可安全按卡面命令 `cp <file> <file>.bak` 建新备份；② 还原时**新 `.bak` 优先**；③ 只有在"新备份也损坏"时才动 `/tmp/c02/prebak/` 里的 L5 前版本，并按 **R2 整线回滚**处理（§8.2）；④ **严禁半还原**（恢复旧 `.bak` 的一部分区块却保留另一部分 → 半接线，§9 A-6）。

### 3.3 数值基线 → W2 目标（回滚判据的标尺）

| 指标 | **基线（现状）** | **W2 目标（卡面验收值）** | 取数命令 |
|---|---|---|---|
| 全量阶段数 | **30** | **32**：新增 31/30「排产路由套件」、32/30「字幕接线套件」（A-01 §5 卡 C） | `grep -c 'run "' scripts/verify-all.sh` |
| 全量断言合计 | **2693**（前 25 阶段 **2098** 守恒） | 2693 + 四路新增断言（逐阶段只增不减） | `bash scripts/verify-all.sh` 逐阶段求和；`README.md:11` 必须逐阶段一致 |
| 套件：排产 | **116 / 0** | **≥124 / 0**（C-003 卡面） | `node tests/test-schedules.js` |
| 套件：自愈 | **101 / 0** | **101 / 0**（本波无人动） | `node tests/test-selfheal.js` |
| 套件：画布筛选 | **222 / 0** | **≥228 / 0**（C-002 卡面） | `node tests/canvas-select.test.mjs` |
| 套件：字幕断行 | **67 / 0** | **67 / 0**（不得减少，A-01 E3） | `node tests/test-subtitle-wrap.js` |
| 套件：画布性能 | **89 / 0** | **89 / 0**（本波不接线） | `node tests/canvas-perf.test.mjs` |
| 新增套件 | 无 | `tests/test-schedules-route.js`（A-01 卡 A）、`tests/test-subtitle-wire.js`（A-01 卡 B），均 0 失败 | 见 §7.2 |
| 服务 | PID 2679524；`GET /` = 200 (493 B)；`GET /api/schedules` = 200 (1673 B) | 同上（**不得重启**） | 见 §7.3 |

**离线/在线分界**：阶段 **1~25 依赖 `$BASE`（默认 `http://127.0.0.1:8788`，22/23/25 直打线上、24 起临时实例）**；阶段 **26~32 为纯离线 Node**（5 个新套件内 `8788`/`fetch(` 零命中）。→ **线内门（G1）不碰服务即可判定；全量门（G3）必须服务在线，而重启被禁。**

---

## 4. 共享文件写入者独占矩阵

| 文件 | 本波次写入者 | 独占/串行规则 | 冲突后果 |
|---|---|---|---|
| `src/schedules.js` | 线一（C-003） | 独占 | 与路由层「丢弃 `occurrence_at`」的语义分叉（函数层接受、路由层忽略）→ 幂等被绕（T-107 S-04） |
| `src/routes/schedules.js` | **当前无卡**（A-01 §2.4 步骤 2 待派） | 派卡后独占 | `ignoredOccurrenceNote` 上线前，前端 D-S-01 的第 ④ 步断言会拿不到字段 |
| `web/lib/canvas-select.js` | 线二（C-002） | 独占；**UI 线不得改它**（D-01 `D-C-07` 改的是同一处 → 必须由 C-002 落地） | 两处同时改 `planBatch` → 后写者覆盖先写者 |
| `tests/canvas-select.test.mjs` | 线二 | 独占 | 断言互相覆盖 → 计数虚高/假绿 |
| `tests/test-schedules.js` | 线一 | 独占 | 同上 |
| `src/finish.js` | 线三 | 独占；`buildSRT` 既有键默认值与签名不变（A-01 §3.5 步骤 2） | 交付物时间码漂移（T-104 R6） |
| `web/views/actors.js` | 线四 | **本波唯一写者**；一次打开、一次备份、一次收工 | 两次打开超大文件 → 第二次基于陈旧内容覆盖第一次（不可恢复） |
| `web/views/render.js` | 线四 | 同上 | 同上 |
| `web/lib/ui.js`、`web/app.js` | 线四（a11y/`toast`） | 独占 | 弹窗基础件被改坏 → 阶段 23 大面积假回归 |
| `scripts/verify-all.sh` | **当前无卡**（A-01 卡 C 待派） | 只允许在 26~30 区块**追加** 31/32 两行 | 阶段编号错位 → README 计数对不上 → 假 FAIL |
| `README.md` | C-005（wave 3） | 独占；`README.md:11` 计数取实测真值 | 多写者互相覆盖计数 |
| `tests/ui-simulate.py` | C-004 | 独占 | 阶段 23 继续改写 `config/config.json` |
| `config/config.json` | 无人（但**阶段 23 会改写**） | 跑前后取 md5 | RK-L6-06 |

---

## 5. 四路的冻结接口 / 字段（W2 改动不得破坏；回滚以此为准）

### 5.1 线一 排产线

| 类别 | 冻结内容 |
|---|---|
| 既有导出（不得删改） | 常量 `SCHEDULE_KINDS`（6 值）、`SCHEDULE_MODES`、`MISS_POLICIES`、`SCHEDULE_RUN_STATUSES`（5 值）、`SCHEDULE_DEFAULTS`、`SCHEDULE_STATUS_TEXT`、`SCHEDULE_REASON_TEXT`；函数 `isoSeconds` `windowKeyOf` `idemKeyOf` `parseCron` `cronMatches` `nextOccurrence` `nextRuns` `nextRunAt` `evaluateSchedule` `dueSchedules` `isScheduleRunning` `enqueueScheduledRun` `fireSchedule` `tickSchedules` `reconcileScheduleRuns` `readSchedulerLease` `acquireSchedulerLease` `startScheduler` |
| **W2 授权新增**（C-003 卡面） | 配置键 `maxFiresPerTick`（缺省 **20**；`0`/负数/非数字 → 20；`>200` → **200**，均不抛错）；返回 `cap.{limit, fired, capped}` 与 `jobEvents` 载荷 `capped`；**新判定码 `skipped_round_cap`**（须同时进 `SCHEDULE_RUN_REASON_CODES` 与 `SCHEDULE_REASON_TEXT` 的中文原文）；`dry-run` **不受**上限约束 |
| **W2 授权新增**（A-01 §2.4） | `fireSchedule` manual 分支：`occurrence = nowISOStr`（丢弃入参，且**不得**把 `null` 交给 `windowKeyOf`——会抛「时间非法：null」）；路由 `ignoredOccurrence`（现有）+ **新增 `ignoredOccurrenceNote`**（挂到 `src/routes/schedules.js:295` 与 `:298` 两处 `ctx.json`） |
| 台账不变量（**回滚最易踩**） | 截断项**不写** `schedule_runs` 行（否则：写 skipped 台账 → 唯一索引 `(schedule_id, window_key, trigger)` 去重 → 该窗口**永久丢失**）；截断项零副作用（不建 job、不建项目、不进预算闸门）；被截断窗口下一轮仍能 fire |
| 既有测试锚点（不得动） | `tests/test-schedules.js:305/328/339` 的 `occurrence_at` 用法（auto 分支）必须继续通过 |
| 数据表 | `schedules`、`schedule_runs`（列集合冻结，见 `src/schedules.js` 的 `SCHEDULE_COLUMNS`/`RUN_COLUMNS`） |

### 5.2 线二 画布线

| 类别 | 冻结内容 |
|---|---|
| 既有导出（不得删改） | 19 常量 + 17 函数（D-01 §1.1 第 11 条：共 **36 个 export**），其中硬约束项：`MAIN_CANVAS_ID='CV-MAIN'`、`BATCH_MAX_NODES=500`、`SUPPORTED_ACTIONS`（7 项）、`BATCH_ACTIONS`、`RERUN_FORBIDDEN_ENDPOINTS`（`/api/canvas/run`、`/api/canvas/run-node`）、`SIZE_LIMITS`（90×90~900×1200） |
| **W2 授权新增**（C-002 卡面，唯一权威） | 三级自证：`opts.canvasId` → `params.canvasId` → `items[*].node.canvas_id`；取不到 → **`code='CANVAS_ID_REQUIRED'`**，`reason` 含「未提供画布 ID」与「已拒绝」两处原文；自证到主画布 → **`code='MAIN_CANVAS_GUARD'`**（复用既有码，不新增）；计划对象新增 **`canvasSource`**（四态可断言）；`applyBatchPlan` 对 `CANVAS_ID_REQUIRED`：`ok=false`、`effects=[]`、`code/reason` 原样 |
| **零回归要求** | 不传 `canvasId` 的**部分选区**（`coversAll` 不成立）行为与改前**逐字节相同**（`NEED_CONFIRM`，确认段数与提示文案一致）；既有 **222 条断言的名称与期望值零改动**（含 `D3 被测模块是纯函数库`、`不修改入参`、`B7h isMainCanvas 为硬编码字符串比对` 三条逐字保留） |
| 16 个错误码全集（D-01 §1.1 第 12 条） | `UNSUPPORTED_ACTION` `EMPTY_SELECTION` `TOO_MANY_NODES` `BAD_PARAMS` `MATRIX_MODE` `ALL_LOCKED` `CANVAS_DELETE_FORBIDDEN` `MAIN_CANVAS_GUARD` `NOTHING_TO_DO` `NO_ACTOR` `NO_EXECUTABLE` `SERVER_BLOCKED` `NEED_CONFIRM` `NO_PLAN` `STALE_PLAN` `PLAN_NOT_OK`（成功码 `OK`）——**UI 线的错误码处置表必须覆盖这 17 个**（D-01 §3.6） |

### 5.3 线三 字幕线（A-01 §3.5 落地口径）

| 类别 | 冻结内容 |
|---|---|
| 接线方式 | `src/finish.js` 顶部新增 `import { wrapCjkLegacy, wrapCjkSmart, resolveLineBreakMode, subtitleLayout } from './subtitle-wrap.js';`（`finish.js` 原无此依赖，不成环） |
| 签名 | `export function buildSRT(shots = [], { includeAction = false, maxCharsPerLine = 18, lineBreakMode = null } = {})`：**前两个键的默认值与语义不变**，只**新增一个可选键**；返回结构 `{srt, cues, duration}` 不变 |
| 分派 | `const mode = resolveLineBreakMode({ lineBreakMode })`（null/未知 → `'legacy'`，不抛错）；`mode === 'cjk' ? wrapCjkSmart(...) : wrapCjkLegacy(...).text`（**两者返回形状不同**：前者字符串、后者对象取 `.text`） |
| **不得删** | 私有 `wrapCjk`（`src/finish.js:86-95`）**保留**作为冻结基线对照点；删掉它就无法再自证"逐字节同源" |
| 平台预设 | `lineBreakMode:'cjk'` 且配了 `cfg.finish.subtitlePlatformPreset` 时注入 `setPlatformPresets()` 后用 `subtitleLayout()` 求 `L_eff`；**未注入必须降级不崩**（中文告警 + 回落 18 字），不得抛错中断出片 |
| 时间码耦合 | `cue 时长 = min(镜头时长, max(1, 行数 × 1.6 + 1.2))`（`src/finish.js:79`）⇒ 行数一变，交付包/发布物时间码就漂移；**缺省 `legacy` 是零行为变化的唯一保证** |
| 既有调用方（零改动） | `src/qc.js:242`、`src/mcp-tools.js:774`、`src/routes/render.js:243/410` |
| 新套件 | `tests/test-subtitle-wire.js`（跨模块逐字节断言：`buildSRT(shots,{})` 与 `wrapCjkLegacy` 拼接同输入同输出） |

### 5.4 线四 UI 线（D-01 待补齐项，须先派卡）

| 类别 | 冻结内容 |
|---|---|
| 铁律 | ① 判定/文案/确认闸门/主画布保护**只来自** `canvas-select.js` 纯函数；② 付费动作（按类型重跑）**只出计划** + 人工批准 + 终端确认码，禁打 `/api/canvas/run(-node)`；③ 筛选是纯 UI 内存态**不落库**；④ **不重构既有 DOM**（阶段 23 `ui-simulate.py` 与阶段 25 `canvas-audit.py` 按选择器驱动真实 UI） |
| 开发项（筛选） | `D-C-01` groups 维度控件（`actors.js:4693-4733`）｜`D-C-02` 无匹配文案统一到 `BATCH_MESSAGES.noMatchingNodes`/`filterCleared`（`actors.js:4786/4790-4792`）｜`D-C-03` HUD 筛选 chip（`actors.js:623-645`）｜`D-C-04` `S.kindFilter` 显式声明（`actors.js:69-73`）｜`D-C-05` 筛选面板 a11y（`ui.js:53-70` + `actors.js:4698-4731`）｜`D-C-06` 应用回执 N=实际写入 `S.selection` 的数量（`actors.js:4780-4788`） |
| 开发项（批处理） | `D-C-07` 主画布保护收口（**`canvas-select.js` 由 C-002 改；UI 只消费新码**）｜`D-C-08` `rerun-kinds` 的 `params.kinds` 控件（取 `EXECUTABLE_KINDS`）｜`D-C-09` 锁定项参与重跑提示（`BATCH_MESSAGES.rerunLockedNotice(n)`）｜`D-C-10` `delete` 的 `mode/scope`（**默认保持现状**，开放须标"永久删除演员档案（跨画布生效）"+ 双段确认取自 `plan.confirmStages`）｜`D-C-11` `plan.skippedEntries` 可见化（前 5 条）｜`D-C-12` 与 D-C-03 合并｜`D-C-13` 批处理 a11y｜`D-C-14` 空态「去筛选」可点 |
| 开发项（排产面板） | `D-S-01` 「立即跑一次」（`render.js:2466-2468`：`confirmDialog` → `POST /api/schedules/:id/trigger {dryRun:false}` → 分支处理 `deduped`/`skipped`/成功/`ignoredOccurrence` 非空）｜`D-S-02` 闸门横幅｜`D-S-03` `costNote` 逐字常驻｜`D-S-04` `last_error`/`last_job_id`/`last_production_id`｜`D-S-05` 费用确认（须含"到点会自动推进制片流水线（真实计费）"）｜`D-S-06` 删除入口｜`D-S-07` 30s 轮询 + **关闭面板必清 `setInterval`**（不新增 SSE）｜`D-S-08` 触发历史内联化｜`D-S-09` 试算表格化｜`D-S-10` 表单字段补齐（`PATCHABLE` 全集见 `src/schedules.js:657-661`）｜`D-S-11` a11y｜`D-S-12` `web/app.js:121-122` `alert()` → `toast()` |
| 依赖 | **必须消费 C-002 落地后的 `CANVAS_ID_REQUIRED` / `canvasSource`** → UI 线排在画布线之后（§6） |

---

## 6. 集成次序（W2 工序表）

### 6.1 排序理由

1. **配置安全先行（C-004）**：后面每条线都要跑全量回归取证；只要阶段 23 还在改写真实 `config/config.json`，回归结论就不可信（RK-L6-06 已实测 mtime `10:30:58` 被改）。**先修测试基础设施，再动功能。**
2. **字幕线第二**：它是唯一会改变**成片交付物时间码**的线（T-104 R6 / A-01 E5）。缺省 `legacy` 保障零行为变化，但必须最早锁住"逐字节同源"基线（A-01 证据② 36/36），后续线在稳定基线上叠加回归。
3. **画布线第三**：`CANVAS_ID_REQUIRED` 与 `canvasSource` 是 UI 线的输入 → 必须先落地并冻结码名（§15 C02-R1）。
4. **排产线第四**：它会**自动花钱**（到点建项目入队）。放在画布/字幕之后，确保异常时系统里只有"低爆炸半径"的改动需要排查；且它的路由层回显依赖 A-01 已知 diff。
5. **UI 线第五（最后一条功能线）**：`actors.js`（4958 行）+ `render.js`（2776 行）是超大/大文件，且要消费前面所有线的新字段与错误码；放在最后 → 一次打开、一次备份、一次收工。
6. **共享文件收口第六**：`scripts/verify-all.sh`（+2 阶段）与 `README.md:11`（计数）是"多线共用"文件，压缩到一次性编辑（§4 独占矩阵）。

### 6.2 步骤表

| 步 | 动作 | 触碰文件 | 前置门 | 验收命令 | 判据 | 失败 → 级别 |
|---|---|---|---|---|---|---|
| **S0** | 冻结基线 + 旧 `.bak` 归档 + 库/配置快照 | **只写 `/tmp/c02/`**（仓库零写入） | — | §3.1 `md5sum -c`；§3.2 归档 `ls`；`ps -o pid,lstart,cmd -p 2679524` | 20 行 `OK`；归档 6 个；PID 记为 2679524 | 基线缺失 → **停工上报** |
| **S1** | **C-004**：`ui-simulate.py` 对 config 零改写 + ≥3 断言 + T-108 须知 | `tests/ui-simulate.py`、`strategist/reports/T-108-ops-plan.md` | S0 | `md5sum config/config.json > /tmp/c02/cfg.before`；`bash scripts/verify-all.sh`；`md5sum -c /tmp/c02/cfg.before` | 全量 `exit=0`；`config.json` **字节一致**；阶段 23 通过 | 失败 → **R1**（卡面命令还原两个 `.bak`） |
| **S2** | **字幕线**：`finish.js` 接线（缺省 legacy）+ 新套件 | `src/finish.js`、`tests/test-subtitle-wire.js` | S1 | `node tests/test-subtitle-wire.js`；`node /tmp/arch-ruling/rt-legacy-byte-equal.mjs`；`node tests/test-subtitle-wrap.js`；`node tests/test-deliver.js`；`node tests/test-qc.js` | 跨模块不一致数 **0**；67 通过 0 失败；既有交付/质检套件计数**不降** | 失败 → **R1**（还原 `src/finish.js`） |
| **S3** | **画布线 C-002**：`canvasId` 三级自证 + 缺省拒绝 + ≥6 条断言 | `web/lib/canvas-select.js`、`tests/canvas-select.test.mjs` | S2 | `node --check web/lib/canvas-select.js`；`node tests/canvas-select.test.mjs` | exit=0；**≥228 通过 / 0 失败**；不传 `canvasId` 且无法自证 → `CANVAS_ID_REQUIRED`；自证 `CV-MAIN` → `MAIN_CANVAS_GUARD`；部分选区行为逐字节不变 | 失败 → **R1**（卡面：还原两个 `.bak` 并回到 222） |
| **S4** | **排产线 C-003**（+ 路由层 `ignoredOccurrenceNote`，若已派卡） | `src/schedules.js`、`tests/test-schedules.js`、`src/routes/schedules.js`（待派卡） | S3 | `node --check src/schedules.js`；`node tests/test-schedules.js`；`curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8788/api/schedules` | exit=0；**≥124 通过 / 0 失败**；`cap.{limit,fired,capped}` 可断言；截断项台账行数恒 0；`/api/schedules` 仍 200 | 失败 → **R1**（还原 `src/schedules.js` 与 `tests/test-schedules.js`） |
| **S5** | **UI 线**（D-01 落地；需先派卡） | `web/views/actors.js`、`web/views/render.js`、`web/lib/ui.js`、`web/app.js` | S4（**必须先有 C-002 的码名**） | §9 A-3 全套 + `python3 tests/ui-smoke.py http://127.0.0.1:8788` + `python3 tests/ui-simulate.py http://127.0.0.1:8788` + `python3 tests/canvas-audit.py http://127.0.0.1:8788` | G0 全绿；阶段 22/23/25 通过；`grep -c "canvas/run" web/views/actors.js` 不新增；锚点漂移量与插入行数吻合 | 失败 → **R1**（先 `actors.js`，再 `render.js`；**禁止**用旧 `.bak` 半还原） |
| **S6** | 共享文件收口（**单写者**）：`verify-all.sh` 追加 31/32；`README.md:11` 计数取真值 | `scripts/verify-all.sh`（待派卡）、`README.md`（C-005） | S5 | `grep -c 'run "' scripts/verify-all.sh`；`grep -n '个阶段' README.md \| head -3` | = **32**；计数与实测逐阶段一致；1~25 行未动 | 失败 → **R1**（还原 `verify-all.sh`／`README.md`） |
| **S7** | 全量回归 | 只跑不写（例外：阶段 21 写 `docs/全模块功能模拟测试报告.*`、阶段 23 若 S1 未完成会写 config） | S6 | §7.4 | `exit=0`、末行 `✅ 全部自检通过`、32 阶段、断言 ≥2693 且**逐阶段不减** | 任一既有阶段红 → **R2** |
| **S8** | 归档上报 | `strategist/runs/<task_id>.json` | S7 | §11 字段 | `task_id/ok/summary/files/evidence/risks` 齐全 | — |

### 6.3 并行度与备份规则

- **可并行**：C-002（`web/lib/*`）、C-003（`src/schedules.js`）、C-004（`tests/ui-simulate.py`）三者 write_scope 两两不相交；但**全量回归（G3）必须串行**，同一时刻只允许一个跑（否则阶段 21/23 的写盘副作用互相干扰）。
- **必须串行**：所有既有文件的编辑按 S1→S6 进行，一个写者一条线。
- **编辑前置硬步骤**：`cp -p <file> <file>.bak`（撞名先归档，§3.2）→ `md5sum` 记入该线 `runs/*.json`。
- **编辑后立即**：`node --check <file>`（前端视图同样适用）；失败**不修，直接 R1**。

---

## 7. 三道门（命令与判据写死）

### 7.1 G0 语法门
```bash
cd /home/linsheng/Desktop/ai-video-factory
for f in src/schedules.js src/routes/schedules.js src/finish.js web/lib/canvas-select.js \
         web/lib/ui.js web/app.js web/views/actors.js web/views/render.js; do
  node --check "$f" || echo "语法失败：$f"
done
bash -n scripts/verify-all.sh
```
**判据**：无输出（全部退出码 0）。

### 7.2 G1 线内门（离线，不碰服务）
```bash
node tests/test-schedules.js        # 基线 116 → W2 ≥124
node tests/test-selfheal.js         # 101（不动）
node tests/canvas-select.test.mjs   # 基线 222 → W2 ≥228
node tests/test-subtitle-wrap.js    # 67（不得减少）
node tests/canvas-perf.test.mjs     # 89（不动）
node tests/test-subtitle-wire.js    # 字幕线新增（0 失败）
node tests/test-schedules-route.js  # 排产路由新增（0 失败）
```
**判据**：每个 `echo $?` = 0；计数**只增不减**（下限对齐 `T-106 §7.4`：A≥24/B≥21/C≥27/D≥19/E≥18）。

### 7.3 G2 相邻门（8788 在线，**只跑不重启**）
```bash
BASE=http://127.0.0.1:8788
curl -s -o /tmp/g2-root  -w '%{http_code} %{size_download}\n' $BASE/               # 期望 200 493
curl -s -o /tmp/g2-sched -w '%{http_code} %{size_download}\n' $BASE/api/schedules # 期望 200 ≈1673
head -c 120 /tmp/g2-sched
```
**解读（最容易误判）**：`200 + 1673`（JSON）= 路由已在当前进程注册（进程 10:31:35 启动晚于 09:10 的注册改动）；`200 + 493`（HTML）= 静态兜底 = 路由未注册 = **改了代码但进程没重启**。此时**不得重启（红线）**：按 R1 回退该次改动，并把"需重启才生效"写进上报交总军师裁决。
按线选跑相邻阶段：字幕线 → `node tests/test-deliver.js`、`test-qc.js`、`test-publish.js`；画布线 → `python3 tests/ui-smoke.py $BASE`；排产线 → `node tests/test-jobs.js`、`test-guard.js`、`node scripts/simulate-all.js`；UI 线 → `python3 tests/ui-simulate.py $BASE`、`python3 tests/canvas-audit.py $BASE`。

### 7.4 G3 收口门
```bash
md5sum config/config.json > /tmp/c02/config.before
bash scripts/verify-all.sh 2>&1 | tee /tmp/c02/verify-all.log; echo "exit=${PIPESTATUS[0]}"
tail -3 /tmp/c02/verify-all.log                 # 期望末行「✅ 全部自检通过」
grep -c 'run "' scripts/verify-all.sh           # 期望 32
grep -c '跳过.*文件缺失' /tmp/c02/verify-all.log # 期望 0
md5sum -c /tmp/c02/config.before                # 期望 OK（C-004 完成后必须一致）
```
**判据**：`exit=0` + **32 阶段** + 断言合计 ≥2693 且逐阶段不减 + `README.md:11` 与实测逐项零偏差。

---

## 8. 回滚分级、触发阈值与命令

### 8.1 触发阈值表（命中即执行，**先回退再讨论**）

| 症状 | 判定命令 | 级别 |
|---|---|---|
| 任一 `node --check` 非 0 | §7.1 | **R1** |
| 本线套件 `fail>0` | §7.2 | **R1** |
| 本线套件计数**下降**（116/222/67/89 任一项变小） | §7.2 | **R1** ＋ 上报"疑似改期望凑绿" |
| 相邻既有阶段失败（14/17/18/19/20/22/23/25 等） | §7.3 | **R2** |
| 全量断言合计 < 2693 或出现"（跳过…文件缺失）" | §7.4 | **R2** ＋ 立刻查 `verify-all.sh` 是否被误删行 |
| `/api/schedules` 返回 493 字节 HTML | §7.3 | **R1** ＋ 上报"需重启才生效" |
| `config.json` 跑全量后字节变化（C-004 之后仍变化） | `md5sum -c` | **R1**（还原 `ui-simulate.py`）＋ 用备份还原 config |
| SRT/cue 时长或交付物时间码漂移 | `tests/test-deliver.js` + `test-subtitle-wire.js` | **R1**（`src/finish.js`） |
| 排产截断项写进了 `schedule_runs` | 台账行数查询（§11 F9） | **R1**（`src/schedules.js`）＋ **人工清该次截断行**（否则窗口永久丢） |
| 付费路径被非预期触发（自动建项目/换后端） | `/api/schedules/runs`、`selfheal_events` 计数 | **R2** ＋ 立即停排产：`PATCH /api/schedules/:id {"enabled":false}` |
| 同一 FAIL 修 2 次不绿 / 超时（普通 30 min，`actors.js` 45 min） | 计时 | **R2**（第 3 次不得再试） |

### 8.2 四级动作

**R0 行级**（改动 ≤10 行且有明确 diff）：用 `edit` 反向替换，随后 `node --check` + 该线套件。**不适用于 `actors.js`**（见 §9）。

**R1 文件级（默认手段）**
```bash
cp -p <file>.bak <file>          # 卡面约定的备份名
md5sum <file>                    # 与 §3.1 基线一致
node --check <file>
node <本线套件>                   # 计数回到基线（116 / 222 / 67 …）
```

**R2 线级**
```bash
# ① 该线 write_scope 内全部既有文件逐个 R1
# ② 新增文件：隔离不删
mkdir -p /tmp/c02/quarantine && mv <新增文件> /tmp/c02/quarantine/
# ③ verify-all.sh：用 edit 删掉该线追加的阶段行（1~25 行与其后行不动）
# ④ 复验 §7.1 + §7.2 + §7.3
# ⑤ 数据侧不动库（§12）；排产类必须停用：
curl -s -X PATCH -H 'Content-Type: application/json' -d '{"enabled":false,"by":"human"}' \
     http://127.0.0.1:8788/api/schedules/<id>
```

**R3 全量级（仅总军师批准）**
```bash
# ① 既有文件按本波次 .bak 逐个还原（server.js/studio.js/finish.js/actors.js/render.js/verify-all.sh/README.md/ui-simulate.py）
# ② 新增文件 mv 到 /tmp/c02/quarantine/（禁止 rm）
# ③ 若需回到 L5 前状态：从 /tmp/c02/prebak/ 取归档副本（等同"回退到上一波已验收状态"，必须整线声明）
# ④ 复验：5 个既有套件（116/101/222/67/89 全绿）+ 25 阶段既有口径
# ⑤ 上报总军师：R3 已执行 + 原因 + 原始输出 + 是否需要重启（由总军师裁决，W2 不得自行重启）
```

### 8.3 回滚**不**做什么

不重启/kill 8788；不起第二个 `server.js`；不 `rm` 仓库文件（一律 `mv` 到 `/tmp/c02/quarantine/`）；不删断言/放宽断言/删 `verify-all.sh` 阶段行；不在服务运行中还原 `data/factory.db`。

---

## 9. 超大文件专项：`web/views/actors.js` 失败回退步骤（A-1 ~ A-10）

**为什么单列**：**4958 行 / 277,921 字节**（本仓最大，是第二名的 1.82 倍：`render.js` 153,051 B）。而且它的失败形态**不会被离线套件捕获**——`tests/canvas-select.test.mjs` 只测纯逻辑库，界面接线坏了它照样 ≥228 全绿。整文件覆盖一旦出错，靠 review 无法恢复。

| 步 | 动作 | 命令 / 判据 |
|---|---|---|
| **A-1** | 打开前备份 + 记录锚点 | **先归档旧 `.bak`（§3.2）**，再 `cp -p web/views/actors.js web/views/actors.js.bak`；`md5sum`（基线 `69f1774847c67608d03b3a8c17f88809`）；`wc -l`（基线 **4958**）；记录锚点：`4-9`（`canvas-select` import）、`69-73`（`S` 声明）、`200`/`201`（筛选/批处理按钮）、`623-645`（HUD chips）、`4683`（`visibleItems`）、`4693-4733`（筛选控件）、`4825-4908`（批处理对话框）、`4862-4866`（`planBatch` 传 `canvasId`）、`4915-4956`（执行链） |
| **A-2** | **只做定点编辑，禁止整文件重写** | 用 `edit` 工具字面替换；**禁止** `write` 整文件覆盖（27 万字节覆盖一次＝赌命）；每次编辑后立即 `node --check web/views/actors.js` |
| **A-3** | 编辑后立即过门 | `node --check`；`node tests/canvas-select.test.mjs`（≥228）；`grep -c "canvas-select" web/views/actors.js`（=1 处 import）；`grep -c "canvas/run" web/views/actors.js`（不新增）；锚点行号漂移量必须与插入/删除行数**吻合（±0）** |
| **A-4** | 失败判据（任一命中即回退，不修） | ① `node --check` 非 0；② 套件不再全绿或计数下降；③ `python3 tests/ui-smoke.py http://127.0.0.1:8788` 失败；④ `python3 tests/ui-simulate.py http://127.0.0.1:8788`（阶段 23）失败；⑤ 锚点数量异常（`planBatch` 调用点 ≠1 个）；⑥ 行数漂移与预期不符 |
| **A-5** | **首选回退**：整文件还原本波次备份 | `cp -p web/views/actors.js.bak web/views/actors.js`；`md5sum` 与 A-1 记录一致；重跑 A-3 |
| **A-6** | 本波次备份也损坏时的**次选**（危险，必须整线回退） | 从 `/tmp/c02/prebak/` 取 **09:26 L5 前**副本还原 ⇒ **同时必须**：① 声明 **R2 整线回退**（`canvas-select` 接线在 `actors.js` 内的部分一并失效）；② 同批处理 `verify-all.sh` 阶段 28 的口径与 `README.md` §8 记录；③ **严禁**只还原一部分区块却保留 `canvas-select` 的 import（半接线 = 按钮在、依赖缺 = 白屏） |
| **A-7** | **区块级回滚**（只退本波改动、保留 L5 集成） | ① `grep -n '<本次新增函数/控件的首行特征>' web/views/actors.js` 定位起止；② 用**行号无关**的方式删除（按函数名与成对括号定位的脚本，或 `edit` 字面替换整块）；③ 校验特征串归零：`grep -c '<新特征>' web/views/actors.js` = 0；④ 重跑 A-3 全套 |
| **A-8** | 回退后必跑（顺序不可省） | `node --check` → `node tests/canvas-select.test.mjs` → `python3 tests/ui-smoke.py $BASE` → `python3 tests/ui-simulate.py $BASE` →（时间允许）`bash scripts/verify-all.sh` |
| **A-9** | 记录（写进本线 `runs/*.json`） | `{file, before_md5, backup_path, after_md5, rollback_level, rollback_reason, rerun_evidence}`，md5 贴 `md5sum` 原始输出 |
| **A-10** | 时间盒 | 单次编辑 `actors.js` **≤45 分钟**；超时即 A-5，不再尝试 |

**同类规则（照抄 A-1~A-10 骨架）**

| 文件 | 行数 | 备份名 | 特有失败判据 |
|---|---|---|---|
| `web/views/render.js` | 2776 | `render.js.bak`（旧备份已归档） | `node --check`；锚点 `603`、`2318+`、`2355-2535` 在位；阶段 22/23 通过 |
| `web/lib/ui.js` | 172 | `ui.js.bak` | 弹窗基础件被改坏 → 阶段 23 大面积假回归；`node --check` + 阶段 23 |
| `src/finish.js` | 346 | `finish.js.bak` | `buildSRT` 缺省路径与 `wrapCjkLegacy` 逐字节同源（不一致数 0） |
| `src/schedules.js` | 1699 | `schedules.js.bak` | `node tests/test-schedules.js` ≥124；`schedules`/`schedule_runs` 列集合不变（`PRAGMA table_info` 比对） |
| `tests/ui-simulate.py` | ~90 KB | `ui-simulate.py.bak` | 跑全量后 `config/config.json` md5 不变；阶段 23 仍通过 |

---

## 10. 逐线回滚 runbook

### 10.1 线一 排产线（C-003）
```bash
cd /home/linsheng/Desktop/ai-video-factory
# ① 先停血（不删账）：停用线上排产
curl -s "http://127.0.0.1:8788/api/schedules" | python3 -c "import sys,json;[print(s['id'],s.get('enabled')) for s in json.load(sys.stdin).get('schedules',[])]"
curl -s -X PATCH -H 'Content-Type: application/json' -d '{"enabled":false,"by":"human"}' http://127.0.0.1:8788/api/schedules/<id>
# ② 卡面回滚命令（逐字照抄）
cp src/schedules.js.bak src/schedules.js
cp tests/test-schedules.js.bak tests/test-schedules.js
# ③ 若已改路由层：cp src/routes/schedules.js.bak src/routes/schedules.js
# ④ 复验（期望回到 116 / 0）
node --check src/schedules.js && node tests/test-schedules.js
```
**特有注意**
- 截断项台账红线：若失败版本已经为被截断窗口写了 `schedule_runs` 行，**必须人工清除该次截断行**，否则唯一索引会让该窗口**永久不再触发**（查询：`SELECT schedule_id, window_key, trigger, reason_code FROM schedule_runs WHERE reason_code='skipped_round_cap';`）。
- 新判定码 `skipped_round_cap` 与 `SCHEDULE_REASON_TEXT` 的中文映射必须**同批**回退（只退一处 → 前端拿到未映射码）。
- `occurrence_at` 相关：`src/routes/schedules.js` 的 `ignoredOccurrence` 属**上一波已上线**能力，回滚 C-003 **不得**把它一起退掉（那是 A-01 §4 的冻结接口）。
- 数据侧：`schedules`/`schedule_runs` 保留；只有明确判定为"错误产生"的行才清理，且清理前先 `SELECT` 存证。

### 10.2 线二 画布线（C-002）
```bash
cp web/lib/canvas-select.js.bak web/lib/canvas-select.js
cp tests/canvas-select.test.mjs.bak tests/canvas-select.test.mjs
node --check web/lib/canvas-select.js && node tests/canvas-select.test.mjs   # 期望回到 222 / 0
```
**特有注意**：卡面明确"既有 222 条断言的名称与期望值零改动" → 回滚后必须 `grep -c "D3 被测模块是纯函数库\|不修改入参\|B7h isMainCanvas" tests/canvas-select.test.mjs` = 3；若反悔"只退源码不退测试"，会出现**新断言测旧行为**的假 FAIL——因此**源码与测试必须同批回退**（这不属于"改期望凑绿"，属于同批撤销）。
**下游影响**：UI 线若已消费 `CANVAS_ID_REQUIRED`/`canvasSource`，回滚 C-002 后 UI 线必须同步 R2（否则界面拿到未知码 → 走 default 分支）。

### 10.3 线三 字幕线（A-01 §5 卡 B）
```bash
cp src/finish.js.bak src/finish.js
node --check src/finish.js
node tests/test-subtitle-wire.js && node tests/test-subtitle-wrap.js && node tests/test-deliver.js
node /tmp/arch-ruling/rt-legacy-byte-equal.mjs   # 期望「不一致数 = 0」
```
**特有注意**：新建的 `tests/test-subtitle-wire.js` 在回滚后**必然失败**（它断言 `finish.js` 已接线）→ 必须与 `src/finish.js` **同批**隔离（`mv` 到 `/tmp/c02/quarantine/`）并同步 `verify-all.sh` 的 32/30 行；否则全量回归会红（且这不是回归，是"测试与实现不同批撤销"）。
**数据侧**：不重算既有 `data/subtitles/`、`data/finish/` 产出。

### 10.4 线四 UI 线（D-01 落地）
按 **§9 A-1~A-10** 执行；顺序固定为：**`actors.js` → `render.js` → `ui.js`/`app.js`**。
**特有注意**：① `S.kindFilter` 之类"只加属性"的改动也要走 A-7 区块回滚，不要用行号硬删；② 若本次新增了筛选 chip / 批处理控件，回滚后必须 `grep -c '<新增控件文案>' web/views/actors.js` = 0，再跑阶段 22/23；③ 回滚涉及 `web/lib/ui.js` 时，**先退 `actors.js`/`render.js` 的调用点，再退 `ui.js`**（反序会出现"调用了不存在的 `toast`/`modal` 参数"）。

### 10.5 前置线（C-004）
```bash
cp tests/ui-simulate.py.bak tests/ui-simulate.py
cp strategist/reports/T-108-ops-plan.md.bak strategist/reports/T-108-ops-plan.md
md5sum config/config.json                    # 与跑前基线比对；不一致 → 用 config.json.bak-c02-<ts> 还原
python3 tests/ui-simulate.py http://127.0.0.1:8788   # 阶段 23 仍通过
```

---

## 11. 失败模式 → 回退动作对照表（值班一页表）

| # | 症状 | 判据命令 | 级别 | 立即动作 | 复验 |
|---|---|---|---|---|---|
| F1 | 语法错 | `node --check <file>` | R1 | 还原该文件 | G0+G1 |
| F2 | 本线套件红 | `node tests/<线>` | R1 | 还原该文件（**禁止**改断言） | G1 |
| F3 | 计数下降（222→<222、116→<116） | 计数行比对 §3.3 | R1+上报 | 还原该文件 | G1 |
| F4 | 既有阶段红 | §7.3 | R2 | 退整线 | G2 |
| F5 | 全量 <2693 或出现"文件缺失跳过" | §7.4 | R2 | 退最近一线 + 查 `verify-all.sh` 行数 | G3 |
| F6 | `/api/schedules` 返 493 B HTML | `curl -w '%{size_download}'` | R1+上报 | 退 `src/routes/schedules.js`；**不重启** | G2 |
| F7 | UI 白屏/模块 404 | `python3 tests/ui-smoke.py $BASE` | R1 | 退 `actors.js`/`render.js` | G0+G2 |
| F8 | UI 结构回归（阶段 23 红） | `python3 tests/ui-simulate.py $BASE` | R1 | 退该次 DOM 改动（**不得重构既有 DOM**，改回只加属性/文案） | G2 |
| F9 | 截断窗口永久丢失 | `SELECT count(*) FROM schedule_runs WHERE reason_code='skipped_round_cap'` 应为 0 | R1+人工 | 退 C-003 改动 + 清理误写台账行 | G1+G2 |
| F10 | 主画布整画布删除被放行 | 不传 `canvasId` 调 `planBatch`，期望 `CANVAS_ID_REQUIRED` | R1 | 退 `canvas-select.js`（**保持 fail-closed**，禁止退回 fail-open） | G1 |
| F11 | 交付时间码漂移 | `test-subtitle-wire.js` / `test-deliver.js` | R1 | 退 `src/finish.js` | G1+G2 |
| F12 | `config.json` 被改写 | `md5sum -c /tmp/c02/config.before` | R1 | 退 `ui-simulate.py` 改动 + 用备份还原 config | G2+G3 |
| F13 | 同一 FAIL 修 2 次不绿 / 超时 | 计时 | R2 | 停止尝试，退整线 | G2 |
| F14 | 改到白名单外文件 | `find . -newermt '-2 hours' -type f` | R1 | 还原越界文件 + 上报纪律问题 | G0 |
| F15 | 有人重启了 8788（PID 变化） | `ps -eo pid,lstart,cmd \| grep -c '2679524'` | **停工上报** | 记录新 PID/启动时间，重跑 G3 取证（此前的回归结论作废） | 全部 |

---

## 12. 数据与配置回滚口径（**只回代码，不回数据**）

| 对象 | 位置 | 口径 |
|---|---|---|
| `schedules` / `schedule_runs` | `data/factory.db`（3.38 MB，WAL 4.14 MB，`-shm` 32 KB） | 保留；台账是"是否重复花钱"的唯一证据（T-101 §5.4）。止血用停用（`PATCH … {"enabled":false}`）而非删除。**唯一例外**：误写的 `skipped_round_cap` 行必须清理（否则窗口永久丢），清理前 `SELECT` 存证 |
| `selfheal_events` | 同上 | 保留（只增账本） |
| `productions` / `production_stages` | 同上 | 保留；**不得**用删除来"回滚" |
| 全库快照（S0 必做） | `/tmp/c02/factory.baseline.db` | `node --input-type=module -e "import{DatabaseSync}from'node:sqlite';const d=new DatabaseSync('data/factory.db');d.exec(\"VACUUM INTO '/tmp/c02/factory.baseline.db'\");"`（服务运行中执行安全；**还原须停机窗口，本会话禁止**） |
| `config/config.json` | 仓库内用户数据 | S0 备份 `config.json.bak-c02-<ts>` + md5；**C-004 完成后跑全量必须字节不变**；不符则还原（文件级，不需重启） |
| 产出物 `data/deliveries`、`data/subtitles`、`data/finish`、`data/videos` | 磁盘 | 不回滚；字幕线回滚**不重算**既有 SRT |

---

## 13. 时间盒、决策权与禁止动作

| 项 | 规定 |
|---|---|
| 单文件编辑时间盒 | 普通 30 分钟；`web/views/actors.js` 45 分钟；超时即 R1/R2 |
| 修复次数 | 单点最多 **2 次**（对齐卡面 `max_rework: 2`）；第 3 次直接回退 |
| R0/R1 决策权 | 该线自行执行，事后上报 |
| R2 决策权 | 该线可紧急止血，**必须**同批上报总军师 |
| R3 决策权 | **仅总军师**；执行前须列出"退哪些文件 + 会丢哪些已验收能力"（逐条：线二接线、L5 已验收的 UI 入口、A-01 `ignoredOccurrence` 回显等） |
| **重启 8788** | **任何角色不得自行执行**；需重启时写进上报由总军师裁决 |
| 禁止动作 | 引入 npm 依赖｜重启/kill 8788｜另起实例｜`rm` 仓库文件｜改既有测试期望凑绿｜删 `verify-all.sh` 既有阶段｜整文件覆盖 `actors.js`｜覆盖未归档的旧 `.bak`｜半还原（半接线）｜运行中还原 `factory.db`｜把主画布闸门退回 fail-open｜暴露思维链 |

---

## 14. 本预案自身验收点（可核对）

```bash
cd /home/linsheng/Desktop/ai-video-factory
wc -l strategist/reports/C-02-rollback-plan.md
grep -c '^## ' strategist/reports/C-02-rollback-plan.md
for k in '四路' '回滚分级' '超大文件专项' '共享文件写入者独占矩阵' '冻结接口' '失败模式' '集成次序'; do
  printf "%s=%s\n" "$k" "$(grep -c "$k" strategist/reports/C-02-rollback-plan.md)"
done
grep -n 'A-[1-9]\|A-10' strategist/reports/C-02-rollback-plan.md | head        # actors.js 专项在位
grep -nE 'C-002|C-003|C-004|C-005' strategist/reports/C-02-rollback-plan.md | wc -l # 卡面锚定
grep -nE '优化一下|注意一下|适当处理' strategist/reports/C-02-rollback-plan.md | wc -l # 期望 ≤2（自指说明）
md5sum -c /tmp/c02/baseline.md5                                             # 基线清单可直接用
```

**验收判据（对齐"接口/字段/步骤/验收点写全"）**
1. 四路每条线都有 **主文件/卡 ID/依赖/`.bak` 约定（§1.1）+ 冻结接口与字段（§5）+ 集成步骤（§6.2）+ 回滚 runbook（§10）+ 命令级判据（§7）**；
2. `actors.js`（4958 行 / 277,921 字节）有 **A-1~A-10 完整失败回退步骤**，含"旧 `.bak` 覆盖陷阱"与"半接线陷阱"两条典型误操作；
3. 每个回滚级别都给出**可粘贴命令**与**回到哪个基线数值**（116/222/67/89、30→32 阶段、2693、§3.1 指纹）；
4. 全文无空话（§14 的自查期望 ≤2 行自指）。

---

## 15. 残余风险与待裁决项（本预案不能消除的）

| # | 等级 | 风险/待裁决 | 说明与应对 |
|---|---|---|---|
| **C02-R1** | **高（待裁决）** | **错误码二义**：C-002 卡面 `CANVAS_ID_REQUIRED`（含中文 reason「未提供画布 ID」+「已拒绝」）vs D-01 `D-C-07` 写 `NO_CANVAS_CONTEXT` | 二者指同一情形。**裁定建议：以 C-002 卡面/接口契约为准**（它是已派卡的 write_scope 持有者），UI 线只消费 `CANVAS_ID_REQUIRED`，并把 D-01 §3.8 `D-C-07` 回写。**在裁定前 UI 线不得开工**（自造第三个码会让界面分支与测试断言同时错） |
| **C02-R2** | **中（待裁决）** | `scripts/verify-all.sh`（阶段 31/32 追加）与 `docs/排产与自愈使用手册.md` 的收口动作**当前无卡承接**（A-01 卡 C 未派；C-005 只写 `README.md`） | 若不派卡：新套件（`test-subtitle-wire.js`、`test-schedules-route.js`）会"存在但不被全量自检执行" → 假绿。**裁定建议：把 A-01 卡 C 派为 C-006（write_scope=`scripts/verify-all.sh`、`README.md`、`docs/排产与自愈使用手册.md`）** |
| **C02-R3** | 中 | 无版本控制，唯一防线是文件副本 | 忘记 `cp .bak` 就只能走 R3 并可能丢 L5 集成。应对：§6.3 把备份列为硬前置；每线 `runs/*.json` 记录 `before_md5`/`backup_path` |
| **C02-R4** | 中 | 回滚后在**运行中进程内不生效**（ESM 缓存），而重启被禁 | 离线门（G1）可立即判定代码回到了基线；线上门（G2）只能观察 `curl` 表现；进程内生效交总军师裁决 |
| **C02-R5** | 中 | `actors.js` 的坏接线**不被离线套件捕获** | 依赖阶段 22/23 作为唯一界面门；建议 UI 线在同波新增"筛选/批处理控件存在且可打开"的**新断言**（只增断言，不改既有期望） |
| **C02-R6** | 中低 | UI 线**尚无任务卡**（只有 D-01 规划书），write_scope/`.bak` 约定由本文临时补齐 | 未派卡前不得开工（否则无白名单、无回滚约定）；派卡时建议直接引用 §5.4 与 §9 作为卡面 |
| **C02-R7** | 中低 | 字幕线**尚无任务卡**（A-01 §5 卡 B 未派） | 同上；卡面要素见 §5.3，回滚见 §10.3 |
| **C02-R8** | 低 | `A-01` 的 `E7` 回写（`selfheal.js`/`subtitles.js` 命名分歧）属文档线动作，本波无卡 | 交总军师在收口卡（C-006）里一并下达 |
| **C02-R9** | 低 | 本文基线在 `render.js`（10:07）、`studio.js`（09:33）、`actors.js`（09:35）三处晚于 L6 复核窗口，属**首次登记** | 以 §3.1 为唯一基线；**不得**再引用 `T-106 §6.2` 的 `actors.js` 旧 md5（`a510a821…` 已过期，RK-L6-02） |
| **C02-R10** | 低 | "四路"与上游"三卡/五线/六卡"等多种口径并存 | §1.2 已给重映射方法；回滚单位始终是"文件 + 线"，与编号无关 |
