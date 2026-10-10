# L6 独立验收报告 · 测试军师（只读取证）

> **角色**：测试军师（独立验收）。本报告**只依据实跑证据**下结论，不采信任何实现方自评。
> **只读声明**：本轮**未修改任何源码或测试**（因为一个既有文件都没动，故未产生 `.bak`）；唯一写入物是本报告 `strategist/reports/L6-verify.md`。
> **环境**：`/home/linsheng/Desktop/ai-video-factory`；Node **v24.18.0**；零 npm 依赖。
> **服务**：`http://127.0.0.1:8788` **未启动、未重启**（取证时 PID 1934283，STARTED `Tue Sep 29 02:01:13 2026`，ELAPSED `08:35:40`）。
> **被测对象**：`strategist/tasks/T-501..T-506.yaml`（6 张验收卡）+ `strategist/reports/T-106-test-plan.md`。
> **说明**：任务书写「6 个新测试文件」，但给出的清单只有 **5 个文件**；`scripts/verify-all.sh` 也恰好新增 **5 个阶段**（26/30~30/30）。按 **5 个文件**验收，差异记录为 RK-L6-04。

---

## 0. 结论速览

| 验收项 | 对象 | 判定 | 一句话依据（可复核命令见各节） |
|---|---|---|---|
| **T-501** | 排产线 `src/schedules.js` + `tests/test-schedules.js` | **PASS** | `node tests/test-schedules.js` → `=== 结果：116 通过 / 0 失败 ===`，exit=0；红队 RT-01 六种重复触发姿势均未复现重复建 job |
| **T-502** | 自愈线 `src/self-heal.js` + 测试 + `src/studio.js` 接入 | **PASS** | `101 通过 / 0 失败`，exit=0；红队 RT-02 未能证伪「静默换后端」：账本写不进去 → 抛中文 Error 且**零新后端生成** |
| **T-503** | 画布筛选/批处理 `web/lib/canvas-select.js` + 测试 + `web/views/actors.js` 接入 | **PASS**（附 1 条中危风险 RK-L6-01） | `222 通过 / 0 失败`；主画布硬闸门在**真实接线路径**（`actors.js:4862-4866` 传 `canvasId`）生效；库层 `canvasId` 缺省时 fail-open |
| **T-504** | 字幕断行 + 画布性能（两个纯模块 + 两套测试） | **PASS**（附残留 RK-L6-03） | `67 通过 / 0 失败`、`89 通过 / 0 失败`；RT-04 边界卡位零丢失；`canvas-perf.js` 零接线属实 |
| **T-505** | 集成与回归：`scripts/verify-all.sh` / `server.js` / `README.md` | **PASS** | `bash scripts/verify-all.sh` 一次性真跑 **exit=0**、末行 `✅ 全部自检通过`；30 阶段实跑合计 **2693 = README.md:11 声明值**，逐阶段零不符 |
| **T-506** | 红队线：主动证伪 ≥5 条 | **PASS** | 5 条假设**全部证伪不成立**（无重复扣费 / 无静默换后端 / 无误删主画布 / 无边界丢卡 / 无计数虚报），另 6/6 变异测试被套件抓到 |

**总计：6 × PASS，0 × FAIL，0 × BLOCKED。** 发现 5 条风险（1 中危 + 1 中低 + 3 低危/残留），**均不构成本轮验收 FAIL**，详见 §6。
（另：全量自检自身对工作区有 2 处**预期内**的文件副作用 —— 阶段 21 写 `docs/全模块功能模拟测试报告.md|.json`、阶段 23 经 GUI「保存出图配置」回头改写 `config/config.json`；**本报告作者未写任何仓库文件**，详见 RK-L6-06。）

---

## 1. 五个新测试套件真跑（逐套件原始证据）

```bash
cd /home/linsheng/Desktop/ai-video-factory
for t in test-schedules.js test-selfheal.js canvas-select.test.mjs test-subtitle-wrap.js canvas-perf.test.mjs; do
  node "tests/$t"; echo "exit=$?"     # 原样取退出码，不接管道、不接或运算
done
```

| # | 测试文件 | 对应卡 | 通过/失败 | 退出码 | 被测模块（行数） |
|---|---|---|---|---|---|
| 1 | `tests/test-schedules.js` | T-501 | **116 / 0** | 0 | `src/schedules.js`（1699 行） |
| 2 | `tests/test-selfheal.js` | T-502 | **101 / 0** | 0 | `src/self-heal.js`（910 行） |
| 3 | `tests/canvas-select.test.mjs` | T-503 | **222 / 0** | 0 | `web/lib/canvas-select.js`（1175 行） |
| 4 | `tests/test-subtitle-wrap.js` | T-504 | **67 / 0** | 0 | `src/subtitle-wrap.js`（831 行） |
| 5 | `tests/canvas-perf.test.mjs` | T-504 | **89 / 0** | 0 | `web/lib/canvas-perf.js`（221 行） |
| | **合计** | | **595 / 0** | 全 0 | |

**与 T-106 §7.4 下限对照**（A≥24 / B≥21 / C≥27 / D≥19 / E≥18）：116 / 101 / 222 / 67 / 89 —— **全部远超下限**；`fail=0` 且每套件尾部都有标准计数行（`=== 结果：N 通过 / M 失败 ===`），符合 T-106 §1.2 的「绿」定义。

### 1.1 各套件原始输出尾部（含退出码）

```text
$ node tests/test-schedules.js; echo "exit=$?"
  ✓ 临时库里才有本次的排产数据（schedules/schedule_runs 非空）  ← schedules=5 runs=7
  ✓ 零依赖：被测模块与自测都只依赖 Node 内置能力（无新增 npm 依赖）  ← once/interval/daily/weekly/monthly/cron

=== 结果：116 通过 / 0 失败 ===
exit=0
```

```text
$ node tests/test-selfheal.js; echo "exit=$?"
  ✓ 端到端·超时阶梯（原实例在线）：不换后端，只 1 次生成调用（避免丢掉已跑完并计费的计算）
  ✓ 端到端·超时阶梯（原实例已不可用）：才允许沿链换后端，探测证据写进结果 probe  comfyui-h3→placeholder

=== 结果：101 通过 / 0 失败 ===
exit=0
```

```text
$ node tests/canvas-select.test.mjs; echo "exit=$?"
  ✓ D3 被测模块是纯函数库：全程未创建任何库文件  ← DB 存在=false
  ✓ D4 临时数据目录与配置已就位（隔离生效）  ← CFG=/tmp/factory-canvas-select-8kgKkn/config.json

=== 结果：222 通过 / 0 失败 ===
exit=0
```

```text
$ node tests/test-subtitle-wrap.js; echo "exit=$?"
  ✓ 批量断行遵守安全区上限：竖屏每条每行都不超过 9 字  [["甲：短句"],["今天天气不错今天天","气不错今天天气不错","今天天气不错"]]
  ✓ 批量断行入参非法时返回中文错误而不抛异常（数组/ {cues}/{shots} 三种入参都吃）

=== 结果：67 通过 / 0 失败 ===
exit=0
```

```text
$ node tests/canvas-perf.test.mjs; echo "exit=$?"
  ✓ 预算：200 卡位单次 visibleItems + cullStats 合计 ≤ 1 ms
  ✓ 预算：1000 卡位单次 visibleItems + cullStats 合计 ≤ 5 ms

=== 结果：89 通过 / 0 失败 ===
exit=0
```

---

## 2. `scripts/verify-all.sh` 一次性真跑（硬证据）

```bash
cd /home/linsheng/Desktop/ai-video-factory
bash scripts/verify-all.sh            # 本轮唯一一次全量跑，不重启 8788
# 完整日志：/tmp/l6/verify-all.log（3458 行）
```

**结论**：`exit=0`，末行 `✅ 全部自检通过`；30 个阶段全部「通过」，无一个被 `[ -f ]` 守卫跳过（26~30 阶段文件均存在）。
**副作用如实记录**：本次全量跑改动了 3 个非源码文件 —— `docs/全模块功能模拟测试报告.md|.json`（阶段 21 设计内产物）与 `config/config.json`（阶段 23 经 GUI「保存出图配置」回头改写，mtime `2026-09-29 10:30:58`），详见 RK-L6-06。
阶段级结论行原文（`/tmp/l6/verify-all.log`）：

```text
2226:── 21/30 全模块端到端模拟（演员→小说→剧本→关键帧→视频→成片，离线零成本）：通过
2256:── 22/30 前端端到端冒烟（http://127.0.0.1:8788）：通过
2455:── 23/30 全模块 UI 模拟（5 个页面，含状态还原校验）：通过
2493:── 24/30 满配前端（200 演员 / 100 集 / 单集 200 镜，独立临时实例）：通过
2718:── 25/30 无限画布功能一致性审计（http://127.0.0.1:8788）：通过
2879:── 26/30 定时排产（下一次触发/时区与 cron/宽限与补跑策略/暂停联动/幂等去重/预算闸门中文报错）：通过
3007:── 27/30 阶段失败自愈（错误分类与可自愈判定/单向降级链/审核与配额不换后端/中文告知/假执行器端到端）：通过
3242:── 28/30 画布筛选与多选批处理（谓词组合/危险动作确认闸门/计划与选区同源/中文文案/幂等一致）：通过
3330:── 29/30 字幕智能断行与安全区联动（标点禁则/数字英文不拆/与既有 buildSRT 逐字节同源/平台预设安全区）：通过
3455:── 30/30 画布性能（视口裁剪/LOD 分级/批量几何/单帧预算与 z 序稳定）：通过
3457:✅ 全部自检通过
3458:verify-all exit=0
```

### 2.1 末 40 行原始输出（`tail -40 /tmp/l6/verify-all.log`，逐字粘贴）

```text
[11] 入参校验与中文报错
  ✓ 反例：visibleItems 传非数组抛中文 TypeError（含「必须是数组」与函数名）
  ✓ 反例：visibleItems 传 null 视口抛中文 TypeError（提示 {x0,y0,x1,y1}）
  ✓ 反例：视口缺键（非有限数）同样拒绝
  ✓ 反例：cullStats 与 viewClipKeep 各自报出带函数名的中文错误
  ✓ 反例：viewportOf / shouldDrawLinks 传非对象抛中文 TypeError

[12] 入参不被修改
  ✓ visibleItems / cullStats / sortByZ 均不修改入参 items 与 item
  ✓ visibleItems / cullStats 不修改入参 view

[13] 200/1000 卡位解析表复算（cols=5 cell=210 gap=14，视口 1320×860，pan=0）
  ✓ 200 卡位 zoom=0.05：drawn=200 / LOD=0
  ✓ 200 卡位 zoom=0.1：drawn=195 / LOD=0
  ✓ 200 卡位 zoom=0.12：drawn=165 / LOD=0
  ✓ 200 卡位 zoom=0.22：drawn=90 / LOD=1
  ✓ 200 卡位 zoom=0.35：drawn=60 / LOD=1
  ✓ 200 卡位 zoom=0.5：drawn=40 / LOD=2
  ✓ 200 卡位 zoom=1：drawn=20 / LOD=2
  ✓ 200 卡位 zoom=2：drawn=12 / LOD=2
  ✓ 200 卡位 zoom=4：drawn=4 / LOD=2
  ✓ 200 卡位 zoom=8：drawn=1 / LOD=2
  ✓ 200 卡位最低缩放：全部 200 张卡位都在视野内（低缩放区裁剪几乎无收益）
  ✓ 1000 卡位 zoom=0.1：drawn=195（高缩放区裁剪收益显著）
  ✓ 1000 卡位 zoom=0.22：drawn=90（高缩放区裁剪收益显著）
  ✓ 1000 卡位 zoom=1：drawn=20（高缩放区裁剪收益显著）
  ✓ 1000 卡位 zoom=8：drawn=1（高缩放区裁剪收益显著）
  ✓ 解析表自洽：200 卡位任一缩放下 hidden + drawn === total
  ✓ 收益口径：高缩放区可见数严格小于低缩放区（1x 时 20 < 0.05x 时 200）

[14] M6 纯函数预算（实测值仅作证据，断言只对预算上界）
  · 实测：200 卡位 0.0137 ms/次，1000 卡位 0.0466 ms/次（visibleItems + cullStats 合计均值，100 次）
  ✓ 预算：200 卡位单次 visibleItems + cullStats 合计 ≤ 1 ms
  ✓ 预算：1000 卡位单次 visibleItems + cullStats 合计 ≤ 5 ms

=== 结果：89 通过 / 0 失败 ===
── 30/30 画布性能（视口裁剪/LOD 分级/批量几何/单帧预算与 z 序稳定）：通过

✅ 全部自检通过
verify-all exit=0
```

**`verify_all_tail`（供上层直接引用，清洗后文本）**：

```
=== 结果：89 通过 / 0 失败 ===
── 30/30 画布性能（视口裁剪/LOD 分级/批量几何/单帧预算与 z 序稳定）：通过

✅ 全部自检通过
verify-all exit=0
```

---

## 3. 红队证伪（5 条假设，每条：假设 / 手法 / 命令 / 原始输出 / 结论）

> 全部脚本落在 `/tmp/l6/rt/`，**只读仓库、只写 `/tmp`**；所有数据都进 `mkdtemp` 临时库与临时 config，**不碰 `data/factory.db` 与 `config/config.json`**，不重启 8788。

### RT-01 排产重复触发（假幂等）→ **证伪未成立（PASS）**

- **假设**：唯一索引形同虚设；同一窗口在「同一进程并发 / 跨进程重放 / 连续两次 tick」下会各建一个 job → 重复扣费。
- **手法**：临时库 + `existing_production` 目标 + `pauseQueues()`（job 停在 queued，离线零成本）；`Promise.all` 并发触发、另起 OS 进程重放、连续两次 `tickSchedules`，再查 `jobs`/`schedule_runs` 行数与唯一索引定义。
- **命令**：

```bash
cd /home/linsheng/Desktop/ai-video-factory
node /tmp/l6/rt/rt1-dup.mjs; echo "exit=$?"        # 内部 execFile 起第二个 node 进程
```

- **原始输出**：

```text
[schedules] 新建排产 S-0001（daily）：每天 09:00（Asia/Shanghai） · 下次 2025-06-01 09:00
[前置] schedule=S-0001 next_run_at=2025-06-01T01:00:00Z
[schedules] 触发 S-0001 → 窗口 2025-06-01T01:00:00Z → 任务 JOB-mum2frk674b295（项目 PR-RT1）
[① in-process 并发] fired= true,false deduped= false,true
[① in-process 并发] jobs 增量=1, schedule_runs 行数=1
[② 跨进程] 子进程输出: pid=2676464 fired=false deduped=true reasonCode=skipped_deduped jobs=1 runs=1
[② 跨进程] 触发后 jobs 增量=1, schedule_runs 行数=1
[③ 连续两次 tick] t1: fired=0 deduped=0 skipped=0
[③ 连续两次 tick] t2: fired=0 deduped=0 skipped=0 reason=
[③ 连续两次 tick] jobs 总增量=0（唯一窗口只允许 +1）
[④ 索引] 唯一索引: idx_sched_runs_window => CREATE UNIQUE INDEX idx_sched_runs_window ON schedule_runs(schedule_id, window_key, trigger)
[④ 索引] jobs 总数=1, schedule_runs 总数=1
exit=0
```

- **结论**：**证伪未成立**。并发两次只有 1 次 `fired`，另 1 次 `deduped=true / reasonCode=skipped_deduped`；**跨进程**重放同样被拒（子进程 `fired=false deduped=true`）；`jobs` 增量恒为 1、`schedule_runs` 恒为 1 行。原子去重来自 `src/schedules.js:1416-1419` 的 `INSERT OR IGNORE` 与 `src/schedules.js:157` 的 `CREATE UNIQUE INDEX idx_sched_runs_window ON schedule_runs(schedule_id, window_key, trigger)`，判定在 `src/schedules.js:1421-1429`。

### RT-02 自愈静默吞错（未落账就换后端 / 错误被吞）→ **证伪未成立（PASS）**

- **假设**：换后端发生在写账本之前，或账本写失败被 `catch` 吞掉后继续生成 → 用户永远不知道被降级（违反不变量 I1）。
- **手法**：`runWithHeal` 的 `record` 注入口分别打桩为「抛错」「返回空 id」；用计数器假执行器统计每个后端真实生成调用次数；另跑 `moderation` 类错误 × `auto-free/allow-paid` 两种模式验证 I4 红线。
- **命令**：

```bash
cd /home/linsheng/Desktop/ai-video-factory
node /tmp/l6/rt/rt2-selfheal-silent.mjs; echo "exit=$?"
```

- **原始输出**：

```text
[① 账本抛错] 抛出= 是（未能写入降级告知记录，已放弃切换后端（禁止静默换后端）：账本表被锁）
[① 账本抛错] 返回= 无（异常已冒泡）
[① 账本抛错] 后端调用序列= comfyui-h3→comfyui-h3 （不得出现 placeholder）
[① 账本抛错] 是否生成到新后端= false
[② 账本无 id] 抛出= 是（未能写入降级告知记录，已放弃切换后端（禁止静默换后端）：账本未返回事件 id）
[② 账本无 id] 后端调用序列= comfyui-h3→comfyui-h3 是否生成到新后端= false
[③ 正常路径] 真实顺序= record == comfyui-h3→comfyui-h3→placeholder
[③ 正常路径] healed=true to=placeholder eventId=SH-mum2frnp999591 notice首行=⚠️ 已自动降级后端：comfyui-h3 → placeholder（原因：服务端错误（5xx）；同后端已重试 1 次仍失败）。
[④ moderation/auto-free] action=hold-human to=null 调用序列=comfyui-h3（新后端调用次数=0）
[④ moderation/allow-paid] action=hold-human to=null 调用序列=comfyui-h3（新后端调用次数=0）
exit=0
```

- **结论**：**证伪未成立**。① 账本抛错 → 抛**中文** `Error`（异常冒泡，未被吞）且**新后端生成 0 次**（调用序列停在 `comfyui-h3→comfyui-h3`）；② 账本返回空 id 同样放弃切换；③ 正常路径顺序是 `record` 先、`placeholder` 后 —— 与 `src/self-heal.js:868-878`（先落账，写不进就抛中文错）与 `src/self-heal.js:880-882`（落账成功后才是新后端生成）逐行一致；④ 审核类在 `allow-paid` 模式下仍 `hold-human`、`to=null`、新后端调用 0 次（I4 红线成立）。接线侧 `src/studio.js:1571-1583` 未包 try/catch，异常会一路冒泡（`src/studio.js:886-890`），**没有静默降级路径**。

### RT-03 批处理误删主画布卡位 → **部分成立（中危风险 RK-L6-01）**

- **假设**：批处理用全量 `items` 而非选区/筛选命中项；或主画布保护可被绕过 → 用户以为删 2 个、实际清空主画布。
- **手法**：构造主画布（`CV-MAIN`）节点集，分别以「全量选区 / `scope:canvas` / `scope:all` / 部分选区 / **不传 canvasId** / 含锁定卡位 / 只传 2 项但画布共 40 项」调用 `planBatch`+`applyBatchPlan`，检查计划拒绝码、确认段、effects 序列。
- **命令**：

```bash
cd /home/linsheng/Desktop/ai-video-factory
node /tmp/l6/rt/rt3-batch-maincanvas.mjs; echo "exit=$?"
```

- **原始输出**：

```text
[① 主画布全量删除] 拒绝 code=MAIN_CANVAS_GUARD affected=0 主画布判定=true 确认段数=0 effects=0
    reason= 主画布不可删除（它是宫格预览全部演员的入口画布）：请先用筛选缩小选区后再批量删除，或改用「⊕ 放入全部」恢复
[② 删除画布本身] 拒绝 code=CANVAS_DELETE_FORBIDDEN affected=0 主画布判定=true 确认段数=0 effects=0 | reason= 批处理不允许删除画布：主画布由后端硬闸门保护，其他画布请走画布栏入口
[③ 主画布清空] 拒绝 code=MAIN_CANVAS_GUARD affected=0 主画布判定=true 确认段数=0 effects=0 | code= MAIN_CANVAS_GUARD
[④ 主画布部分删除] 拒绝 code=NEED_CONFIRM affected=2 主画布判定=true 确认段数=2 effects=0
    确认段= ["把选中的 2 个卡位从本画布移除？演员档案与定妆图不受影响。","再次确认：主画布是「宫格预览全部演员」的入口画布；需要恢复请用「⊕ 放入全部」。"] 提示= ["未指定删除模式，已按最安全的「移出画布」处理（演员档案与定妆图不受影响）","主画布上移除卡位后，可用「⊕ 放入全部」恢复"]
    effects 顺序= 
[⑤ 未传 canvasId 的整画布删除] 拒绝 code=NEED_CONFIRM affected=5 主画布判定=false 确认段数=2 effects=0 | code= NEED_CONFIRM | reason= 「批量删除」是危险动作，必须显式确认后才能执行：请传 confirm: 2（表示两段提示均已确认）或 confirm: true + confirmAgain: true。确认文案：把选中的 5 个卡位从本画布移除？演员档案与定妆图不受影响。
再次确认：清空画布的全部卡位与关系线？
[⑥ 含锁定卡位] 拒绝 code=NEED_CONFIRM affected=2 主画布判定=true 确认段数=2 effects=0 | 跳过= 1 | 跳过项= ["已锁定（未勾选「包含已锁定」）"]
[⑦ 只传 2 项但画布共 40 项] 拒绝 code=NEED_CONFIRM affected=2 主画布判定=false 确认段数=1 effects=0 | 是否越界处理= false
[⑧ 受禁端点] ["/api/canvas/run","/api/canvas/run-node"]
    计划里是否出现受禁端点= false
    rerun 计划审批链= null
[⑨a 主画布部分删除·已确认] ok=true affected=2 请求数=4
    请求序列= DELETE /api/canvas/nodes/N1/links → DELETE /api/canvas/node/N1 → DELETE /api/canvas/nodes/N2/links → DELETE /api/canvas/node/N2
    提示= "⚠️ 该操作连带删除的连线无法用「撤销」恢复；需要回退请用「📸 快照」。"
[⑨b 未传 canvasId·整画布删除·已确认] ok=true affected=5 请求数=10
    请求序列前 4 条= DELETE /api/canvas/nodes/N1/links → DELETE /api/canvas/node/N1 → DELETE /api/canvas/nodes/N2/links → DELETE /api/canvas/node/N2
    ↑ 若这里 ok=true 且请求数>0，说明「未传 canvasId 时主画布保护不生效」（fail-open）
exit=0
```

- **结论（分开说，避免一句话糊过去）**：
  - **未误伤、未越界（PASS 部分）**：`scope:'canvas'` → `CANVAS_DELETE_FORBIDDEN`（`web/lib/canvas-select.js:707`）；主画布 + 全量/`scope:'all'` → `MAIN_CANVAS_GUARD`（`web/lib/canvas-select.js:716`）；只传 2 项时处理数恒为 2（**不越界处理**）；锁定卡位被跳过并给出中文原因；effects 序列是「先 `DELETE /api/canvas/nodes/:id/links` 再 `DELETE /api/canvas/node/:id`」（`web/lib/canvas-select.js:777-784`）→ **不留脏连线**；受禁付费端点 `/api/canvas/run|run-node` 未出现在任何计划里（`web/lib/canvas-select.js:157`）。
  - **接口层 fail-open（中危风险 RK-L6-01）**：主画布判定取自 `mainCanvas: isMainCanvas(canvasId)`（`web/lib/canvas-select.js:502`），而 `canvasId` 只从 `opts/params` 读（`web/lib/canvas-select.js:486`）。**调用方忘传 `canvasId` 时 `mainCanvas=false`，硬闸门不生效**：第 ⑤ 步 `affected=5`（等于整画布清空）只走到 `NEED_CONFIRM`，第 ⑨b 步确认后 `ok=true affected=5 请求数=10` —— 即「整画布删除」被放行。
  - **真实接线路径下不成立**：唯一调用点 `web/views/actors.js:4862-4866` 显式传了 `canvasId: S.canvasId` 与 `canvasTotal: items.length`，且 `web/views/actors.js:4918` 起走危险动作二次确认；因此**用户实际使用路径上主画布保护成立** → 不影响本轮 PASS，但要按风险项治理（见 §6）。

### RT-04 边界卡位被裁剪丢失 → **证伪未成立（PASS）**

- **假设**：与视口**相切**的卡位被判为不可见（闭区间被改成半开区间）；`pad` 随 zoom 缩放导致极端缩放下留白丢失；`width=0`（画布隐藏）时兜底「全部可见」。
- **手法**：把 `canvas-perf` 的 `viewClipKeep` 与 `actors.js:573` 的**原始裁剪条件**在 6 个边界点上逐点对照（等价性）；再打 4 个缩放档的留白、四角相切、完全在外 1px、`width=0` 退化矩形、200 卡矩阵右下角卡位。
- **命令**：

```bash
cd /home/linsheng/Desktop/ai-video-factory
node /tmp/l6/rt/rt4-clip-edge.mjs; echo "exit=$?"
```

- **原始输出**：

```text
[① 原始实现] actors.js:573 = if (it.x + it.w < view.x0 || it.x > view.x1 || it.y + it.h < view.y0 || it.y > view.y1) continue;
[① 视口] pad=50 => x0=-50 x1=1370 y0=-50 y1=910
[① 等价性] 左边界相切（x+w === x0） → canvas-perf=true / actors.js原式=true ✓一致
[① 等价性] 左边界外 1px → canvas-perf=false / actors.js原式=false ✓一致
[① 等价性] 右边界相切（x === x1） → canvas-perf=true / actors.js原式=true ✓一致
[① 等价性] 右边界外 1px → canvas-perf=false / actors.js原式=false ✓一致
[① 等价性] 上边界相切（y+h === y0） → canvas-perf=true / actors.js原式=true ✓一致
[① 等价性] 下边界相切（y === y1） → canvas-perf=true / actors.js原式=true ✓一致
[① 等价性] 不一致点数=0（>0 即「边界卡位被裁剪丢失」成立）
[② 缩放 0.05] x0=-150 y0=-100 左留白=-50 上留白=-50
[② 缩放 0.22] x0=-150 y0=-100 左留白=-50 上留白=-50
[② 缩放 1] x0=-150 y0=-100 左留白=-50 上留白=-50
[② 缩放 8] x0=-150 y0=-100 左留白=-50 上留白=-50
[③ 四角相切] 左上角相切 → 可见=true
[③ 四角相切] 右下角相切 → 可见=true
[③ 完全在外 1px] 可见=false（必须 false）
[④ width=0] 视口={"x0":-50,"y0":-50,"x1":50,"y1":50} 退化矩形=true
[④ width=0] total=100 drawn=1 hidden=99（drawn 必须极小，不得=100）
[⑤ 200 卡] 矩阵尺寸=1106x8946 适配zoom=0.0961 视口={"x0":-50,"y0":-50,"x1":13781.06976744186,"y1":8996}
[⑤ 200 卡] drawn=200/200；最后一张卡(916,8756,210,210) 可见=true
[⑤ 200 卡] 是否「右下角被裁掉」= false
[⑥ NaN 坐标] canvas-perf 可见=false / actors.js 原式可见=true（差异点，契约已声明）
exit=0
```

- **结论**：**证伪未成立**。6/6 边界点与 `actors.js:573` 原式**完全一致**（闭区间保持，相切可见、外 1px 不可见）；`pad=CULL_PAD=50` 在 0.05~8 全档恒定（`web/lib/canvas-perf.js:59`、`:119-136`）；`width=0` 得到退化矩形且 `drawn=1/100`（**没有兜底全可见**）；200 卡矩阵右下角卡位在适配缩放下可见（`drawn=200/200`）；唯一差异是 **NaN 坐标**下新实现判不可见、原式判可见，该差异在 `web/lib/canvas-perf.js:138-152` 注释里已显式声明（坐标来自数据库数值列）。

### RT-05 README 计数虚报 → **证伪未成立（PASS）**

- **假设**：`README.md:11` 的「30 个阶段 / 2693 项断言」是手写虚报，或既有套件被改小期望凑绿（违反铁律 J5）。
- **手法**：解析**一次真跑**的完整日志 `/tmp/l6/verify-all.log`，按阶段头切分、取每阶段计数行，与 `README.md:11` 括号内逐项对账；并单独复核 T-106 §7.1 的「前 25 阶段 = 2098」基线是否守恒。
- **命令**：

```bash
cd /home/linsheng/Desktop/ai-video-factory
node /tmp/l6/rt/rt5-readme-counts.mjs; echo "exit=$?"
```

- **原始输出**：

```text
README 声明合计 = 2693 （README.md:11 写的总数 = 2693 ）
1/30 引擎自检：README=23 实跑=23 ✓ 结论=通过 该阶段失败数=0 计数行=1
2/30 模块1 演员矩阵：README=105 实跑=105 ✓ 结论=通过 该阶段失败数=0 计数行=1
3/30 模块2 小说工坊：README=45 实跑=45 ✓ 结论=通过 该阶段失败数=0 计数行=1
4/30 模块3 剧本工厂：README=74 实跑=74 ✓ 结论=通过 该阶段失败数=0 计数行=1
5/30 模块4 制作台：README=71 实跑=71 ✓ 结论=通过 该阶段失败数=0 计数行=1
6/30 画布资产桥：README=33 实跑=33 ✓ 结论=通过 该阶段失败数=0 计数行=1
7/30 ComfyUI 视频引擎：README=63 实跑=63 ✓ 结论=通过 该阶段失败数=0 计数行=1
8/30 厂商适配器：README=82 实跑=82 ✓ 结论=通过 该阶段失败数=0 计数行=1
9/30 生产守护：README=37 实跑=37 ✓ 结论=通过 该阶段失败数=0 计数行=1
10/30 生产看板：README=30 实跑=30 ✓ 结论=通过 该阶段失败数=0 计数行=1
11/30 任务队列：README=47 实跑=47 ✓ 结论=通过 该阶段失败数=0 计数行=1
12/30 Agent 接口与审核闸门：README=284 实跑=284 ✓ 结论=通过 该阶段失败数=0 计数行=1
13/30 画布 DAG 引擎：README=199 实跑=199 ✓ 结论=通过 该阶段失败数=0 计数行=1
14/30 自动化制片 Agent：README=148 实跑=148 ✓ 结论=通过 该阶段失败数=0 计数行=1
15/30 时间线：README=173 实跑=173 ✓ 结论=通过 该阶段失败数=0 计数行=1
16/30 规模压测：README=24 实跑=24 ✓ 结论=通过 该阶段失败数=0 计数行=1
17/30 交付包：README=74 实跑=74 ✓ 结论=通过 该阶段失败数=0 计数行=1
18/30 成片质检：README=47 实跑=47 ✓ 结论=通过 该阶段失败数=0 计数行=1
19/30 配音链路：README=32 实跑=32 ✓ 结论=通过 该阶段失败数=0 计数行=1
20/30 出海物料：README=32 实跑=32 ✓ 结论=通过 该阶段失败数=0 计数行=1
21/30 全模块端到端模拟：README=83 实跑=83 ✓ 结论=通过 该阶段失败数=0 计数行=1
22/30 前端冒烟：README=22 实跑=22 ✓ 结论=通过 该阶段失败数=0 计数行=1
23/30 全模块 UI 模拟：README=172 实跑=172 ✓ 结论=通过 该阶段失败数=0 计数行=1
24/30 满配前端：README=21 实跑=21 ✓ 结论=通过 该阶段失败数=0 计数行=1
25/30 无限画布审计：README=177 实跑=177 ✓ 结论=通过 该阶段失败数=0 计数行=1
26/30 定时排产：README=116 实跑=116 ✓ 结论=通过 该阶段失败数=0 计数行=1
27/30 阶段失败自愈：README=101 实跑=101 ✓ 结论=通过 该阶段失败数=0 计数行=1
28/30 画布筛选与多选批处理：README=222 实跑=222 ✓ 结论=通过 该阶段失败数=0 计数行=1
29/30 字幕智能断行：README=67 实跑=67 ✓ 结论=通过 该阶段失败数=0 计数行=1
30/30 画布性能：README=89 实跑=89 ✓ 结论=通过 该阶段失败数=0 计数行=1
---
实跑合计 = 2693 | README 合计 = 2693 | 差 = 0
前 25 个既有阶段实跑合计 = 2098 （T-106 §7.1 基线 = 2098）
不符阶段数 = 0 （>0 即「README 计数虚报」成立）
exit=0
```

- **结论**：**证伪未成立**。30/30 阶段声明数 = 实跑数（差 0），合计 **2693 = 2693**；**前 25 阶段 = 2098**，与 T-106 §7.1 基线逐字相符 → 既有断言计数**没有下降**，可排除「删/改既有期望凑绿」这一类手法（铁律 J5）。增强的 5 个新阶段贡献 116+101+222+67+89 = **595**，2098+595 = 2693 自洽。

---

## 4. 附加：变异测试（证明新套件不是「假绿」）

T-106 §8 的 RT-14 要求「故意破坏一处后必须 exit=1」。为了**不改动仓库内任何文件**，用 Node 模块加载钩子在**内存里**替换被测模块源码（`module.register` + `load` 钩子，磁盘零改动），对 5 个套件共做 6 次变异：

```bash
cd /home/linsheng/Desktop/ai-video-factory
MUT_RULES=/tmp/l6/mut/<规则>.json node --import /tmp/l6/mut/mutate.mjs tests/<套件>
```

| # | 变异点（内存替换） | 期望 | 实测 | 判定 |
|---|---|---|---|---|
| m1 | `src/schedules.js:1425` `reasonCode:'skipped_deduped'` → `'skipped_dup_XX'` | exit=1 | `114 通过 / 2 失败`，exit=1 | ✅ 被抓 |
| m2 | `src/self-heal.js:868` `if (typeof record === 'function')` → `if (false)`（关掉 I1 落账闸门） | exit=1 | `94 通过 / 7 失败`，exit=1 | ✅ 被抓 |
| m3 | `web/lib/canvas-select.js:502` `mainCanvas: isMainCanvas(canvasId)` → `false`（关主画布闸门） | exit=1 | `212 通过 / 10 失败`，exit=1 | ✅ 被抓 |
| m4 | `src/subtitle-wrap.js:53` 禁则行首去掉「。」 | exit=1 | `66 通过 / 1 失败`，exit=1 | ✅ 被抓 |
| m5 | `web/lib/canvas-perf.js:61` `LOD_THRESHOLDS.mid` 0.22 → 0.33 | exit=1 | `86 通过 / 3 失败`，exit=1 | ✅ 被抓（证明阈值单源、测试没写死 0.22） |
| m6 | `web/lib/canvas-perf.js:59` `CULL_PAD` 50 → 40 | exit=1 | `84 通过 / 5 失败`，exit=1 | ✅ 被抓（证明留白单源） |

**诚实记录一次自身失误**：m1 首次执行用的是 `reasonCode: 'skipped_deduped'` 这个较短的 `from` 串，`String.replace` 只替换**第一处**命中（落在 `src/schedules.js:1241` 的另一条去重分支），因而误得 `116 通过 / 0 失败`。换成 `src/schedules.js:1425` 的**唯一长串**后立刻被抓（`114 通过 / 2 失败`）。这说明：**变异测试的命中点必须唯一**，否则会得出「测试无判别力」的错误结论。

---

## 5. T-501..T-506 逐张卡对照

| 卡 | acceptance_criteria | 证据落点 | 判定 |
|---|---|---|---|
| **T-501** 排产线 | ① 结论只能 PASS/FAIL/BLOCKED ② FAIL 须给文件:行号+复现 ③ 红队 ≥5 动作 | ① 本节 ② 无 FAIL ③ §3 全 5 条 | **PASS** |
| **T-502** 自愈线 | 同上 | §1 #2、§3 RT-02、`src/self-heal.js:868-878`、`src/studio.js:1571-1583` | **PASS** |
| **T-503** 画布筛选/批处理 | 同上 | §1 #3、§3 RT-03、`web/lib/canvas-select.js:502/707/716/777-784`、接线 `web/views/actors.js:4862-4866` | **PASS**（附 RK-L6-01 中危风险） |
| **T-504** 字幕断行 + 画布性能 | 同上 | §1 #4/#5、§3 RT-04、`web/lib/canvas-perf.js:59/119-152` | **PASS**（附 RK-L6-03 残留） |
| **T-505** 集成与回归 | 同上 | §2（`verify-all.sh` exit=0）、§3 RT-05（2693/2693、2098 守恒） | **PASS** |
| **T-506** 红队线 | 同上 | §3 全 5 条 + §4 变异测试 6/6 | **PASS** |

`constraints.forbidden`（「修改任何源码或测试（只读验收）」）自查：`md5sum` 显示 5 个被测模块与 5 个测试文件在本轮验收前后**指纹不变**（`web/lib/canvas-perf.js` = `385167759e328fe4866b459457c95102`，与 T-210 报告记录值逐字一致）；本波未执行任何写操作到仓库文件。

---

## 6. 风险与残留（本轮只记录，不修改）

| # | 等级 | 风险 | 事实与证据 | 影响 | 建议处置 |
|---|---|---|---|---|---|
| **RK-L6-01** | **中** | 主画布保护的**接口层 fail-open** | `web/lib/canvas-select.js:502` 用 `isMainCanvas(canvasId)` 判定，`canvasId` 来自 `opts/params`（`web/lib/canvas-select.js:486`），缺省为 `''` → `mainCanvas=false`，`web/lib/canvas-select.js:716` 的 `MAIN_CANVAS_GUARD` 不触发。实测（§3 RT-03 第 ⑤/⑨b 步）：不传 `canvasId` 时整画布删除被放行（`ok=true affected=5 请求数=10`） | 只要将来新增一个调用点忘传 `canvasId`，主画布可被整画布批量清空（虽然可两段确认，但提示文案会退化为普通画布文案） | 让 `planBatch` 从入参节点自证画布（`node.canvas_id`）或把 `canvasId` 设为**必填**；缺省应**拒绝**而不是放行。当前唯一调用点 `web/views/actors.js:4862-4866` 已传值，真实路径不受影响 |
| **RK-L6-02** | 低 | T-106 §6.2 的 `actors.js` md5 基线**已过期** | T-106 要求 `md5sum web/views/actors.js` = `a510a8211f87fb8b4a6ffd473d029029`（4669 行）；实测 = `69f1774847c67608d03b3a8c17f88809`。原因是 C 线/集成线按 `T-503.write_scope` 合法改写了该文件（批处理接线）；T-105/T-209 的报告里已预见此点（`strategist/runs/T-105.json:80`） | 若后续验收照抄该 md5 当证据，会得到**假 FAIL** | E 线的「零接线」应以 `canvas-perf.js` 自身指纹 + 「无任何 `import` 引用」为证据，不要再用 `actors.js` md5 |
| **RK-L6-03** | 低 | `web/lib/canvas-perf.js` **零接线**（设计如此，但能力未生效） | `grep -rn "canvas-perf" web/ src/` → **零命中**；`web/views/actors.js:573` 仍用内联裁剪条件；`actors.js:4683` 另有同名函数 `visibleItems()`（多选批处理用），与 `canvas-perf.visibleItems(items, view)` **同名不同义** | 性能优化与 LOD 分级目前**不影响线上行为**；将来接线时若用裸 `import { visibleItems }`，会被 `actors.js:4683` 的本地同名函数遮蔽，出现「接了线却没效果」 | 接线时改名导入（如 `import { visibleItems as perfVisibleItems }`）或在 `actors.js` 内联侧显式调用；并把 `canvas-perf` 纳入 `verify-all` 的既有阶段（现已作为 30/30 独立阶段跑） |
| **RK-L6-04** | 低 | 任务书「6 个新测试文件」与实际 5 个不符 | 实际新增测试文件 5 个（`tests/test-schedules.js`、`tests/test-selfheal.js`、`tests/canvas-select.test.mjs`、`tests/test-subtitle-wrap.js`、`tests/canvas-perf.test.mjs`）；`scripts/verify-all.sh` 新增阶段也是 5 个（26~30）。「6」应指 **T-501..T-506 六张卡**（T-504 一张卡覆盖两个套件） | 无语义风险，仅口径 | 后续任务书按「6 张卡 / 5 个套件」表述 |
| **RK-L6-05** | 低 | 测试计划与实现存在命名分歧（T-106 §1.4 的 N1/N2/N3） | N1：计划建议契约名 `src/selfheal.js`，实现落在 `src/self-heal.js`（README.md:129 同）；N2：计划建议改 `src/subtitles.js`，实现另建 `src/subtitle-wrap.js`；N3：`.test.mjs` 与仓库既有 `.js` 混用 | 已由本轮验证消解：两套测试都 `import` 到**真实存在且有导出**的模块（套件首条断言即导出存在性，`test-selfheal.js` 101 条全绿、`test-subtitle-wrap.js` 67 条全绿） → **无「测到空气」** | 回写 T-106 §1.4 的裁决结果（以落地实现为准），避免后续复核者按旧契约路径去查而误判 |
| **RK-L6-06** | 中低 | **全量自检会改写用户真实 `config/config.json`**（与 T-106 §7.5 相冲突） | 本轮跑 `verify-all.sh` 期间 `config/config.json` 的 mtime 变为 **2026-09-29 10:30:58**（同批 `docs/全模块功能模拟测试报告.md` 为 10:28:14 = 阶段 21，故 10:30:58 落在阶段 23）。代码路径：`tests/ui-simulate.py:1423` 在**真实 8788 设置页**点「保存出图配置」（前端 → `PUT /api/settings` → `src/routes/meta.js:168 saveConfig(patch)` → `src/config.js:193 fs.writeFileSync(CONFIG_FILE, …)`），随后 `tests/ui-simulate.py:1429` 再用 API PUT 还原。文件内容语义上仍是原值（`image.backend=placeholder`、`image.generic.url=""`），但**文件被整体重写**。**诚实标注：本轮未在跑前留 `config.json` 快照，故无 before/after 字节级差异**，本条依据「代码路径 + mtime 时间吻合」，置信度中 | ①用户数据文件被自动化改写（键序/格式/未来新增未知键的存活情况不确定性）；②T-106 §7.5「不为了跑测试而改 config/config.json」的口径被阶段 23 实际突破；③若还原 PUT 失败（代码里有 `except` 分支），出图配置可能残留向导示例值 | ①下次全量跑前先 `md5sum config/config.json` 留基线、跑后再比对，把结论钉死；②`tests/ui-simulate.py:1419-1426` 注释写「不保存这次向导改动」，但点按钮就是保存 —— 应改为读原值→改→还原的 API 事务，或指向临时实例；③把该副作用写进 `strategist/reports/T-108-ops-plan.md` 的运维须知 |

---

## 7. 复现清单（一条命令一条结论）

```bash
cd /home/linsheng/Desktop/ai-video-factory

# ① 五个新套件（合 595 通过 / 0 失败）
node tests/test-schedules.js; echo "exit=$?"        # 116 通过 / 0 失败
node tests/test-selfheal.js; echo "exit=$?"         # 101 通过 / 0 失败
node tests/canvas-select.test.mjs; echo "exit=$?"   # 222 通过 / 0 失败
node tests/test-subtitle-wrap.js; echo "exit=$?"    #  67 通过 / 0 失败
node tests/canvas-perf.test.mjs; echo "exit=$?"     #  89 通过 / 0 失败

# ② 全量（本轮只跑一次；30 阶段 / 2693 断言）
bash scripts/verify-all.sh; echo "exit=$?"          # 末行 ✅ 全部自检通过 / exit=0

# ③ 红队五条
node /tmp/l6/rt/rt1-dup.mjs                 # 幂等：并发/跨进程/连续 tick 全被去重
node /tmp/l6/rt/rt2-selfheal-silent.mjs     # 自愈：账本写不进 → 抛中文错且零新后端生成
node /tmp/l6/rt/rt3-batch-maincanvas.mjs    # 批处理：主画布闸门成立（缺省 canvasId 时 fail-open）
node /tmp/l6/rt/rt4-clip-edge.mjs           # 裁剪：边界等价比对不一致点数 = 0
node /tmp/l6/rt/rt5-readme-counts.mjs       # 计数：2693 = 2693，前 25 阶段 = 2098 守恒
```

**红线自查**：
- 未引入任何 npm 依赖（5 个新套件与全部红队脚本都只用 Node 内置能力）。
- 未重启 8788（PID 1934283，`STARTED Tue Sep 29 02:01:13 2026`，验收前后一致）。
- **未修改任何源码或测试**：取证方式二选一都成立 ——
  ① `find . -newermt '-25 minutes' -type f` 在验收窗口内只列出 `strategist/reports/L6-verify.md` 与 `config/config.json`、`docs/全模块功能模拟测试报告.md|.json`（后三者是 `verify-all.sh` 自身阶段 21/23 的副作用，见 RK-L6-06），**没有任何源码或测试文件**；
  ② 指纹与外部记录比对：`web/lib/canvas-perf.js` = `385167759e328fe4866b459457c95102`，与 T-210 报告记录的验收前值**逐字一致**；`web/lib/canvas-select.js` = `8fad191e6608defd48ee9f62b91a08f6`、`src/schedules.js` = `e4799441410b5c021cc816c22e2ea81f`、`src/self-heal.js` = `379a35c643776c3a97a2f9188a1c6f4e`、`src/subtitle-wrap.js` = `502454ed11bc165c5c4fc1086b8b0bef`；5 个测试文件 = `b7c67ee5…`（schedules）/ `bf210565…`（selfheal）/ `c4b83691…`（canvas-select）/ `1e841e54…`（subtitle-wrap）/ `2d3bac0b…`（canvas-perf）。
  本轮无 `.bak` 产生（因为一个既有文件都没动）。
- 未改既有测试期望（§3 RT-05 证明 30 阶段计数零下降、前 25 阶段 2098 守恒）。
- 未暴露思维链；**唯一写入物是本报告**，其余全部产物落在 `/tmp/l6/`。
- **如实披露**：`verify-all.sh` 自身（阶段 21 / 阶段 23）会写 `docs/全模块功能模拟测试报告.md|.json` 与 `config/config.json` —— 这是**被测套件的既有行为**，非本报告作者所为，已记为 RK-L6-06。
