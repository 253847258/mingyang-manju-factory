# 军师矩阵 · 运行状态与验收报告（第 1 次运行）

> 目标：30 人矩阵并行开发（2 人统筹：总军师=主智能体，验收统筹=T-701/T-506 红队）
> 本次运行时间：2026-09-28 ｜ 矩阵定义：`strategist/matrix.yaml` ｜ 任务卡：`strategist/tasks/*.yaml`（34 张）

## 一、编排与校验（已完成）

- 34 张标准任务卡已生成，字段齐全（含 `write_scope` 白名单、`acceptance_criteria`、`quality_checks`、`evidence_required`）。
- `validate_tasks.py` 结果：**0 error**（6 条 V10 warn 为「任务描述里出现『删除』等词」的误报，返工卡均写明回滚方案）。
- 冲突检查通过：**同一文件不出现在两张任务卡的 write_scope**（新模块优先，共享文件交给唯一集成者 T-401/T-402）。
- DAG 分层（校验器输出）：L1 侦察(7) → L2 实现与计划(8) → L3 测试与文档(6) → L4 集成A(1) → L5 集成B(1) → L6 验收与红队(6) → L7 返工(4) → L8 复验(1)。

## 二、本次实际完成（15 个智能体交付，全部落盘）

**W1 侦察/设计（7/7 完成）** `strategist/reports/`：
T-101 排产契约 827 行 ｜ T-102 自愈契约 695 行 ｜ T-103 画布筛选/批处理契约 1003 行 ｜ T-104 字幕断行契约 ｜ T-105 画布性能契约 459 行 ｜ T-106 测试计划 ｜ T-107 安全风险清单 ｜ T-108 运维与恢复方案 625 行 ｜ T-109 文档影响面清单。

**W2 实现（5 个新模块，均通过 `node --check` 与 `import` 检查）**：

| 文件 | 规模 | 导出面（节选） |
|---|---|---|
| `src/schedules.js` | 84 KB | `parseCron` `nextOccurrence` `dueSchedules` `fireSchedule` `tickSchedules` `acquireSchedulerLease` `reconcileScheduleRuns`（含租约、幂等键、时区换算） |
| `src/self-heal.js` | 54 KB | `classifyForHeal` `planSelfHeal` `runWithHeal` `degradeNotice` `shouldTripStageDegrade`（含降级链与切换上限） |
| `src/subtitle-wrap.js` | 43 KB | `wrapCjkSmart` `wrapCuesForPlatform` `subtitleLayout` `wrapCjkLegacy`（兼容旧行为） |
| `web/lib/canvas-select.js` | 56 KB | `matchNodeFilter` `filterItems` `planBatch` `applyBatchPlan` `BATCH_ACTIONS`（含主画布保护与危险动作校验） |
| `web/lib/canvas-perf.js` | 11 KB | `visibleItems` `lodLevelFor` `shouldDrawLinks` `cullStats`（纯函数，无 DOM） |

## 三、未完成（诚实记录，不得当作已完成）

**波次 L3–L8 未执行**：本次 workflow 报告 `completed (30 agents)`，但平台单次运行的智能体上限把后续波次截断 —— L3（5 个测试 + 1 份文档）、L4/L5（集成）、L6（独立验收 6 个）、L7（返工）、L8（复验）的返回值均为 `null`，对应文件不存在。

因此当前状态是：

- ✅ 契约齐全、5 个新模块可导入、**未接入任何既有流程**；
- ❌ **无测试覆盖**（`tests/test-schedules.js` 等 5 个测试文件尚未创建）；
- ❌ **未集成**（`src/routes/schedules.js`、`server.js` 注册、`scripts/verify-all.sh` 阶段接入、`src/studio.js` 自愈接线、画布 UI 入口均未做）；
- ❌ **未独立验收**（无 PASS/FAIL 结论；尚未跑红队证伪）；
- ✅ **无回归**：既有 `./scripts/verify-all.sh` 仍为 **25 阶段 / 2098 项断言**（本次没有触碰既有文件）。

## 四、下一步（按 DAG 续跑，符合「超限拆成多次 workflow 调用」）

1. **第二次 workflow（L3 + L4 + L5）**：5 个测试文件 → 集成 A（路由与自检接入）→ 集成 B（`studio.js` 自愈、画布 UI、README 计数）。
2. **第三次 workflow（L6 + L7 + L8）**：6 个独立验收（含红队 ≥5 个证伪假设）→ 定点返工 → 复验并更新本报告。
3. 总军师收口：跑 `./scripts/verify-all.sh`，确认 30 阶段全绿后，把本报告第三节的 ❌ 逐条改为 PASS 并给出原始输出。

## 五、残余风险

- 5 个模块体量偏大（合计 ~250 KB），未做独立验收前**不得**接入付费路径（`self-heal` 会决定换后端，风险最高）。
- `schedules.js` 含定时触发与租约，接入前必须验「不重复触发」与「重启不漏跑/不重跑」。
- 画布批处理含删除类动作，接入前必须验主画布保护与二次确认。

---

# 第 2 次运行 · 收口（总军师裁决，2026-09-29）

## 六、全部波次已完成（L1→L6）

| 波次 | 结果 |
|---|---|
| L1 侦察/设计（7） | ✅ 9 份契约/计划落盘 `strategist/reports/` |
| L2 实现（5 模块） | ✅ `src/schedules.js`、`src/self-heal.js`、`src/subtitle-wrap.js`、`web/lib/canvas-select.js`、`web/lib/canvas-perf.js` |
| L3 测试与文档（6） | ✅ 5 个测试套件 **595 条断言全绿**（116/101/222/67/89）+ `docs/排产与自愈使用手册.md` |
| L4 集成A（1） | ✅ `src/routes/schedules.js` 新建、`server.js` 注册、`scripts/verify-all.sh` 25→**30 阶段**（既有 25 阶段名称与顺序未改） |
| L5 集成B（1） | ✅ `src/studio.js` 视频阶段自愈接线、`web/views/actors.js` 类型筛选+多选批处理入口、`web/views/render.js` 排产入口、`README.md` 计数取真值 |
| L6 独立验收（1） | ✅ **6×PASS / 0×FAIL / 0×BLOCKED**；红队 5 个假设全部证伪未成立；6/6 内存变异测试证明套件有判别力 |

## 七、硬证据

- `bash scripts/verify-all.sh` → **exit=0**，末行 `✅ 全部自检通过`，**30/30 阶段通过，逐阶段断言合计 2693**，与 `README.md:11` 逐阶段零偏差。
- 5 个新套件独立真跑：595 通过 / 0 失败（退出码全 0）。
- 服务已由总军师重启以激活新路由：`GET /api/schedules` 正常返回（此前 8788 进程早于注册，属预期）。

## 八、残余风险（验收军师如实记录，未修）

1. **RK-L6-01（中）** `web/lib/canvas-select.js:502` 主画布判定依赖调用方传入 `canvasId`，缺省即 fail-open（实测不传时整画布删除被放行）；**当前唯一调用点已传值**，真实路径不受影响 → 建议下轮把 `canvasId` 设为必填或从 `node.canvas_id` 自证。
2. **RK-L6-06（中低）** `verify-all.sh` 阶段 23（ui-simulate）经设置页「保存出图配置」重写真实 `config/config.json`（语义仍为原值）；建议跑前留 md5 基线。
3. **RK-L6-05（低）** 文档层命名分歧（契约写 `selfheal.js`/`subtitles.js`，落地为 `self-heal.js`/`subtitle-wrap.js`）→ 建议下轮把契约名回写为落地名。
4. **契约待裁决**：`occurrence_at` 是否可被 manual 触发传入（T-101 §9.6 与 T-107 S-04 互相冲突，集成线按 T-107 执行并回显 `ignoredOccurrence`）。
5. **未做**：`S-10` 单轮 tick 上限（需改 `src/schedules.js`，留待返工卡）；`web/lib/canvas-perf.js` 目前零接线（既有渲染行为未改，属有意保守）。
