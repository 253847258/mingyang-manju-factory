# 军师矩阵 · 产物索引（INDEX）

> 目的：一眼看清「哪份产物是谁在哪个波次交付的、去哪个文件看」。按 `strategist/README.md` 硬约定，未落盘 `strategist/runs/<task_id>.json` 的卡视为未交付（用 `node scripts/check-runs.js` 查）。

## 一、侦察与契约（第 1 轮 L1）

| 卡 | 产物 | 用途 |
|---|---|---|
| T-101 | `T-101-schedules-spec.md` | 定时排产：数据模型 / cron / miss 策略 / 时区 |
| T-102 | `T-102-selfheal-spec.md` | 阶段失败自愈：错误分类 / 降级链 / 告知字段 |
| T-103 | `T-103-canvas-select-spec.md` | 画布类型筛选与多选批处理：维度 / 动作 / 保护 |
| T-104 | `T-104-subtitle-wrap-spec.md` | 字幕断行与安全区：断行规则 / 兼容策略 |
| T-105 | `T-105-canvas-perf-spec.md` | 画布性能纯逻辑：裁剪 / LOD / 几何函数签名 |
| T-106 | `T-106-test-plan.md` | 测试计划与红队证伪点清单 |
| T-107 | `T-107-security-risks.md` | 安全风险表（含 S-10 单轮 tick 上限建议） |
| T-108 | `T-108-ops-plan.md` | 运维：重启恢复 / 观测点 / 回滚 |
| T-109 | `T-109-docs-plan.md` | 文档影响面与落点清单 |

## 二、裁定与规划（第 2 轮 W1）

| 卡 | 产物 | 结论要点 |
|---|---|---|
| B-01 | `B-01-research.md` | 接线可行性：**必须命名空间导入**（否则与 actors.js 同名声明冲突白屏） |
| A-01 | `A-01-arch-ruling.md` | 裁定 `occurrence_at` 禁止 manual 传入；契约名与落地名对齐口径 |
| D-01 | `D-01-ui-plan.md` | 画布筛选/批处理 + 排产面板的交互、状态表、危险确认 |
| C-02 | `C-02-rollback-plan.md` | 四路开发的回滚预案与集成次序 |

## 三、验收与收口（逐轮）

| 文件 | 覆盖范围 | 结论 |
|---|---|---|
| `L6-verify.md` | 第 1 轮 6 张验收卡 + 红队 | 6×PASS；红队 5 假设未证伪 |
| `README.md` | 第 1 轮总收口（含被截断记录与续跑） | 30 阶段全绿 |
| `W3-acceptance.md` | 第 2 轮四路开发独立验收 | 6×PASS；发现 2 条 fail-open + 配置改写 |
| `W4-acceptance.md` | P0 返工复验（画布保护 / mode 门控 / 自检安全） | 3 条主假设未证伪；断言 2760→2818 |
| `W5-acceptance.md` | 被打断波次的补验 | 4 文件可交付；新增 4 条附注 |
| `W6-p0-fixes.md` | 4 条 P0 收尾（夹具 / 隔离 / 守卫 / 留痕） | 4×PASS；断言 2828 |
| `W7-round1-2.md` | 留痕补录 + 功能收尾 | 待产出（进行中） |

## 四、台账与自检入口

- 矩阵定义：`strategist/matrix.yaml`｜任务卡：`strategist/tasks/*.yaml`（39 张）｜运行留痕：`strategist/runs/*.json`
- 留痕自检：`node scripts/check-runs.js`（缺留痕即视为未交付）
- 全量自检：`bash scripts/verify-all.sh`（30 阶段；跑前跑后会对 `config/config.json` 做 md5+mtime 守卫）
