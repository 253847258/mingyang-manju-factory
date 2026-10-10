# W3 独立验收报告 · 验收军师（对 W2 四路交付的独立验收）

> **角色**：验收军师（独立验收，只读）。本报告**只依据实跑证据**下结论，不采信任何实现方自评（C-002.json / C-003.json / W2-B.json / T-403.json 均只作为「被验收对象的自述」列出，不作为判定依据）。
> **只读声明**：本轮**未修改任何源码与测试**（验收前后指纹逐字一致，见 §7）。唯一写入物是本报告 `strategist/reports/W3-acceptance.md` 与结论文件 `strategist/runs/W3-acceptance.json`；红队脚本与日志一律落 `/tmp/w3/`。
> **写入范围**：派单给的写入范围是 `strategist/reports/W3-acceptance.md`；派单未给 `task_id`，本报告按写入文件名归口为 **W3-acceptance**（`strategist/runs/W3-acceptance.json`）。若台账另有编号，请以其实编号归档本报告内容。
> **环境**：`/home/linsheng/Desktop/ai-video-factory`；Node **v24.18.0**；零 npm 依赖；Python 侧仅标准库 + 既有 playwright。
> **服务**：`http://127.0.0.1:8788` **未重启**（验收前后 PID `2679524`、STARTED `Tue Sep 29 10:31:14 2026` 完全一致，见 §7）。
> **取证时间窗**：2026-09-29 12:20 ~ 12:38（本报告内所有命令均在该窗口内真跑）。

---

## 0. 结论速览

| # | 被验收对象 | 交付物 | 判定 | 一句话依据（可复核命令见 §4/§6） |
|---|---|---|---|---|
| 1 | **C-002** 画布主画布保护 fail-closed | `web/lib/canvas-select.js`（1217 行） | **PASS**（附 2 条新发现残余绕过路径 R-W3-01/02） | 改前版本（`.bak`）同输入 `ok=true affected=5 DELETE请求=10`（复现原缺陷）；改后同输入 `code=CANVAS_ID_REQUIRED affected=0 DELETE请求=0`；`node tests/canvas-select.test.mjs` → **247 通过 / 0 失败 / exit=0** |
| 2 | **C-003** 单轮 tick 触发上限 S-10 | `src/schedules.js`（1747 行） | **PASS** | 6 条同刻到期 + cap=2 → `fired=2 cap={"limit":2,"fired":2,"capped":4} deferred=4 jobs增量=2`；被截断窗口台账行数=0、下一轮补上；`node tests/test-schedules.js` → **130 通过 / 0 失败 / exit=0** |
| 3 | **W2-B** 阶段级熔断（自愈） | `src/studio.js` / `src/self-heal.js` | **PASS**（附 2 条残余风险 R-W3-03/04） | 连续第 3 次同类失败 → `action=hold-human tripped=true calls=0 to=null`，jobs+0、selfheal_events+0、节点状态零改写；熔断后再调 4 次仍全 hold-human；`node tests/test-selfheal.js` → **129 通过 / 0 失败 / exit=0** |
| 4 | **T-403** canvas-perf 接线 | `web/views/actors.js`（4957 行） | **PASS** | 同页同数据 A/B（B 组由 Playwright 路由拦截提供 `.bak` 接线前代码）**18 个视口状态**下 `drawn/lod/HUD/items/zoom` 逐值相同；独立重算（接线前公式 + 真实几何）18/18 一致 |
| 5 | 过程项：4 个受影响测试真跑 | — | **PASS** | 247/130/129/22 通过，失败全 0，退出码全 0（§1） |
| 6 | 过程项：`verify-all.sh` 一次真跑 | — | **PASS** | `exit=0`、末行 `✅ 全部自检通过`、30/30 阶段通过；**前 25 阶段合计 2098 = 第 1 轮基线（守恒，证明既有断言未被删改）** |
| 7 | 过程项：RK-L6-06 全量自检对真实 config 的副作用 | — | **FAIL**（治理未落地） | 跑前 `0552a2d7…` → 跑后 `cd8edca0…`，且**语义值被改写**：`image.concurrency 3 → 2`（不是「语义仍为原值」）；已按派单要求还原（`cmp` 逐字节一致）。对应治理卡 **C-004 未交付**（无 `strategist/runs/C-004.json`）→ 记为 **BLOCKED（缺交付物）** |
| 8 | 过程项：`README.md:11` 断言台账 | — | **FAIL**（低，文档线） | 实跑 30 阶段合计 **2760**，`README.md:11` 声明 **2693**，差 **+67**（= C-003 +14 / W2-B +28 / C-002 +25）；台账未同步（不在本卡写入范围，需另开卡） |

**总计：4 路交付 4 × PASS（附 6 条残余风险）；过程项 3 PASS / 1 FAIL（config 副作用，治理卡未交付 → 其交付状态为 BLOCKED） / 1 FAIL（README 台账过期，低）。**
**一句话结论：本轮 W2 四路交付可以交付**（四路交付物本身均通过独立复核且未发现阻断面），**但「全量自检会改写用户真实配置」这一条仍未治理，跑全量自检前必须留 config 基线**。

---

## 1. 四个受影响测试真跑（原样取退出码，不接管道、不接或运算）

```bash
cd /home/linsheng/Desktop/ai-video-factory
node tests/canvas-select.test.mjs; echo "exit=$?"
node tests/test-schedules.js;      echo "exit=$?"
node tests/test-selfheal.js;       echo "exit=$?"
LD_LIBRARY_PATH=/home/linsheng/pwlibs/extract/usr/lib/x86_64-linux-gnu python3 tests/ui-smoke.py; echo "exit=$?"
```

| # | 测试文件 | 对应交付 | 通过/失败 | 退出码 | 与预期基线对照 |
|---|---|---|---|---|---|
| 1 | `tests/canvas-select.test.mjs` | C-002 | **247 / 0** | 0 | C-002 卡要求 ≥228（基线 222）→ 达标（+25） |
| 2 | `tests/test-schedules.js` | C-003 | **130 / 0** | 0 | C-003 卡要求 ≥124（基线 116）→ 达标（+14） |
| 3 | `tests/test-selfheal.js` | W2-B | **129 / 0** | 0 | L6 基线 101 → +28（W2-B 卡要求「只增不减」）→ 达标 |
| 4 | `tests/ui-smoke.py` | 四路共同（E-04 前端冒烟） | **22 / 0** | 0 | 与 L6 基线 22 一致（含「演员矩阵挂载（主画布 + 小地图 + 工具栏）」「无 JS 控制台错误」） |

原始结论行（尾行原文）：

```text
=== 结果：247 通过 / 0 失败 ===
exit=0
=== 结果：130 通过 / 0 失败 ===
exit=0
=== 结果：129 通过 / 0 失败 ===
exit=0
=== 结果：22 通过 / 0 失败 ===
exit=0
```

完整日志：`/tmp/w3/tests-node.log`（446 行）、`/tmp/w3/tests-rest.log`（187 行）。

**「禁止改既有测试期望凑绿」的独立核查**（不采信实现方 diff 自述，验收方自己重算）：

```bash
for f in tests/canvas-select.test.mjs tests/test-schedules.js tests/test-selfheal.js; do
  printf '%s 删除行=%s 新增行=%s\n' "$f" "$(diff "$f.bak" "$f" | grep -c '^<')" "$(diff "$f.bak" "$f" | grep -c '^>')"
done
```

```text
tests/canvas-select.test.mjs 删除行=0 新增行=69
tests/test-schedules.js      删除行=0 新增行=129
tests/test-selfheal.js       删除行=0 新增行=184
```

三个套件**删除行均为 0**（只有新增）→ 既有期望未被替换或删除；三套件计数只增不减，且 §2 的「前 25 阶段 2098 守恒」从**全量自检**层面再次证明既有断言未被削减。

---

## 2. `scripts/verify-all.sh` 一次真跑（硬证据 · 本轮仅此一次）

跑前已按派单要求留基线（**这一步是 C-004 契约里的建议做法，本轮由验收军师自行执行**）：

```bash
cp config/config.json /tmp/config.baseline.json && md5sum config/config.json
# 0552a2d7b303f2149ddfbfe9cfd782b1  config/config.json   （4903 字节）
mkdir -p /tmp/w3 && { bash scripts/verify-all.sh; echo "verify-all exit=$?"; } > /tmp/w3/verify-all.log 2>&1
# 完整日志 3540 行
```

**结论**：`exit=0`，30 个阶段全部「通过」，无一个被 `[ -f ]` 守卫跳过。

### 2.1 末 30 行原始输出（硬证据，逐字）

```text

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
  · 实测：200 卡位 0.0109 ms/次，1000 卡位 0.0414 ms/次（visibleItems + cullStats 合计均值，100 次）
  ✓ 预算：200 卡位单次 visibleItems + cullStats 合计 ≤ 1 ms
  ✓ 预算：1000 卡位单次 visibleItems + cullStats 合计 ≤ 5 ms

=== 结果：89 通过 / 0 失败 ===
── 30/30 画布性能（视口裁剪/LOD 分级/批量几何/单帧预算与 z 序稳定）：通过

✅ 全部自检通过
verify-all exit=0
```

### 2.2 逐阶段断言对账（验收方自己解析日志，不抄实现方数字）

| 阶段 | 实跑 | README:11 | | 阶段 | 实跑 | README:11 |
|---|---|---|---|---|---|---|
| 1 引擎自检 | 23 | 23 ✓ | | 16 规模压测 | 24 | 24 ✓ |
| 2 模块1 演员矩阵 | 105 | 105 ✓ | | 17 交付包 | 74 | 74 ✓ |
| 3 模块2 小说工坊 | 45 | 45 ✓ | | 18 成片质检 | 47 | 47 ✓ |
| 4 模块3 剧本工厂 | 74 | 74 ✓ | | 19 配音链路 | 32 | 32 ✓ |
| 5 模块4 制作台 | 71 | 71 ✓ | | 20 出海物料 | 32 | 32 ✓ |
| 6 画布资产桥 | 33 | 33 ✓ | | 21 全模块端到端 | 83 | 83 ✓ |
| 7 ComfyUI 视频引擎 | 63 | 63 ✓ | | 22 前端冒烟 | 22 | 22 ✓ |
| 8 厂商适配器 | 82 | 82 ✓ | | 23 全模块 UI 模拟 | 172 | 172 ✓ |
| 9 生产守护 | 37 | 37 ✓ | | 24 满配前端 | 21 | 21 ✓ |
| 10 生产看板 | 30 | 30 ✓ | | 25 无限画布审计 | 177 | 177 ✓ |
| 11 任务队列与取消 | 47 | 47 ✓ | | **26 定时排产** | **130** | 116 ★ |
| 12 Agent 接口与闸门 | 284 | 284 ✓ | | **27 阶段失败自愈** | **129** | 101 ★ |
| 13 画布 DAG 引擎 | 199 | 199 ✓ | | **28 画布筛选批处理** | **247** | 222 ★ |
| 14 自动化制片 Agent | 148 | 148 ✓ | | 29 字幕智能断行 | 67 | 67 ✓ |
| 15 时间线多轨音频 | 173 | 173 ✓ | | 30 画布性能 | 89 | 89 ✓ |

- **前 25 阶段合计 = 2098**（第 1 轮基线 2098）→ **守恒**，证明既有断言零删改（与 §1 的删除行=0 互为独立证据）。
- 26~30 阶段合计 = 662（第 1 轮 595，+67 = 14 + 28 + 25，与三张卡的新增断言数一致）。
- 30 阶段合计 = **2760**；`README.md:11` 声明 **2693** → 台账过期（FAIL，低，见 §4-8）。
- 阶段 23（ui-simulate）实跑 172 ≥ C-004 契约要求 172 → 达标。
- 解析脚本与结果：`/tmp/w3/stage-table.txt`。

### 2.3 config 副作用取证 + 还原（派单要求：跑前 cp、跑后 diff 并还原）

```bash
diff /tmp/config.baseline.json config/config.json
# 18c18
# <     "concurrency": 3,
# ---
# >     "concurrency": 2,
md5sum config/config.json            # cd8edca0224e89b41481aba4e8f4409a （跑后）
cp /tmp/config.baseline.json config/config.json
cmp /tmp/w3/config.baseline.bytes config/config.json && echo "cmp: 与跑前逐字节一致"
# cmp: 与跑前逐字节一致
```

**如实记录（比 L6-verify §6 的结论更严重）**：L6-verify 第 106/430 行写「文件内容语义上仍是原值」并**诚实标注当时没有字节基线**；本轮有基线，实测**语义值确实被改写**：`image.concurrency` 由 **3 变成 2**（阶段 23 经设置页「保存出图配置」写盘：`tests/ui-simulate.py:1423` → `src/routes/meta.js:168 saveConfig(patch)` → `src/config.js:193 fs.writeFileSync`）。已按派单要求还原为跑前字节（`md5 0552a2d7…`）。
其余设计内副作用：`docs/全模块功能模拟测试报告.md|.json`（阶段 21）、`data/` 下的图片/交付包/看板缩略图等运行产物（阶段 21/24 等）。

---

## 3. 红队证伪（4 条主假设 + 逐条对抗尝试，共 56 条判定，全部有原始输出）

脚本（全部只写 `/tmp/w3/`，破坏性验证一律在 `mkdtemp` 临时库内）：

| 脚本 | 覆盖 | 结果 |
|---|---|---|
| `/tmp/w3/rt1-canvasid-whole-delete.mjs` | ①不传 canvasId 整画布删除 | **11 条判定通过 / 0 未达预期**（日志 `rt1.log`） |
| `/tmp/w3/rt2-tick-cap.mjs` | ②单轮 tick 超过 maxFiresPerTick | **12 / 0**（`rt2.log`） |
| `/tmp/w3/rt3-heal-trip.mjs` | ③自愈熔断后仍继续换后端 | **17 / 0**（`rt3.log`） |
| `/tmp/w3/rt4-render-ab.py` + `/tmp/w3/rt4b-links-and-zoom.mjs` | ④canvas-perf 接线后渲染行为变化 | **11 / 0** + **5 / 0**（`rt4.log` / `rt4b.log`） |

### ① 「不传 canvasId 仍能整画布删除」——**原缺陷路径已堵死**，但发现 2 条**新的残余绕过路径**

手法：把第 1 轮基线 `web/lib/canvas-select.js.bak`（md5 `8fad191e…`）复制成 `.mjs` 与当前实现**并排跑同一批对抗输入**。

```bash
node /tmp/w3/rt1-canvasid-whole-delete.mjs
```

```text
RT-①-A 改前版本（.bak 基线）：planBatch → ok=false code=NEED_CONFIRM canvasSource=undefined mainCanvas=false
                             applyBatchPlan(confirm:true,confirmAgain:true) → ok=true code=OK affected=5 DELETE请求=10   ← 原缺陷复现
RT-①-B 改后版本（当前实现）：planBatch → ok=false code=CANVAS_ID_REQUIRED reason=未提供画布 ID，无法确认是否为主画布，已拒绝整画布批量删除：请传 canvasId（或 canvasTotal）后重试。
                             applyBatchPlan(confirm:true,confirmAgain:true) → ok=false code=CANVAS_ID_REQUIRED affected=0 DELETE请求=0
RT-①-C 自证（items[*].node.canvas_id='CV-MAIN' + scope=all）→ code=MAIN_CANVAS_GUARD mainCanvas=true DELETE请求=0
RT-①-D 对抗1（不传 canvasId / 不传 canvasTotal / 节点 canvas_id 为空，把整画布 5 个节点当选区）→ NEED_CONFIRM → 确认后 ok=true affected=5 DELETE请求=10   ← 残余绕过
RT-①-E 对抗2（混合选区：首个非空 canvas_id='CV-2'，同选区含 2 个 'CV-MAIN' 节点，scope=all）→ NEED_CONFIRM → 确认后 ok=true affected=3 DELETE请求=6，主画布节点被删且未触发 MAIN_CANVAS_GUARD   ← 残余绕过
RT-①-F 形态变体：'cv-main'→mainCanvas=false（NEED_CONFIRM）；' CV-MAIN '、'CV-MAIN\n'→MAIN_CANVAS_GUARD（isMainCanvas 会 trim）；'CV-MAIN2'→false
RT-①-G 空选区 + scope=all → EMPTY_SELECTION，DELETE请求=0
RT-①-H opts.canvasId 与 params.canvasId 同时空白 → CANVAS_ID_REQUIRED canvasSource=none
```

**结论**：假设**未能证伪到「原缺陷仍在」**——原缺陷路径（不传 canvasId + `scope='all'`/声明整画布）已被 fail-closed 拒绝（含 apply 阶段 0 effects），且**真实唯一调用点** `web/views/actors.js:4862-4864` 始终显式传 `canvasId: S.canvasId` 与 `canvasTotal: items.length`，真实路径不受影响。但红队独立找到 **2 条契约未覆盖的绕过路径**（R-W3-01/02，见 §4），属**新发现**、非本轮引入。

### ② 「单轮 tick 超过 maxFirePerTick」——**未能证伪（保护成立）**

```bash
node /tmp/w3/rt2-tick-cap.mjs
```

```text
RT-②-1 cap=2、6 条同刻到期 → tick fired=2 skipped=4 cap={"limit":2,"fired":2,"capped":4} deferred=4 jobs增量=2
        截断项原因原文="单轮触发条数已达上限（本轮最多触发 2 条），该窗口留待下一轮"
        日志：[schedules] 本轮触发已达上限 2 条：4 个到期窗口留待下一轮（未写台账行，窗口不会被幂等键占掉）
RT-②-2 被截断窗口 schedule_runs 行数 = 0（窗口未被唯一索引占掉）
RT-②-3 下一轮（+60s）→ fired=2 cap={"limit":2,"fired":2,"capped":2} jobs增量=2（窗口不丢）
RT-②-4 单条排产 catchup_all + 3 小时漏跑（宽限 180 分）→ scanned=3 fired=2 skipped=1 jobs增量=2（≤cap）
RT-②-5 配置畸形逐值：undefined/0/-1/'abc'/null → 20；1.9 → 1；200 → 200；201/9999/1e9 → 200；Infinity/NaN → 20；2.999 → 2
RT-②-6 dry-run → fired=5 cap.limit=2，jobs增量=0（契约声明 dry-run 只判定，实测零副作用）
RT-②-7 「窗口已在台账」的两条排产 → scan 阶段即被 skipped_running/占位拦下，**不消耗配额**；3 条新窗口仍触发 2 条（fired=2 capped=1）
RT-②-8 注入 4 行 rows（绕过库读取）→ fired=0（目标不存在）jobs增量=0，仍受 cap=1 约束
RT-②-9 manual 逐条触发 3 次不受 tick 配额约束（设计口径：配额只作用于自动轮）
```

**结论**：4 类对抗（畸形配置 / catchup 大量漏跑 / 注入 rows / 幂等去重挤配额）都没有突破上限；被截断窗口**零台账行**且下一轮可补跑（不存在「窗口永久丢失」）。唯一需要如实记录的语义边界：`dry-run` 与 `manual` 不受单轮配额约束（**契约明示的设计口径**，非缺陷）。

### ③ 「自愈熔断后仍在继续换后端」——**未能证伪（熔断后零换后端、零生成调用）**

手法：临时库造景（项目 + 2 个 `kind='video'` 失败节点 + 阶段 `status='error'`），用**显式注入的可自愈错误**（`timeout`）驱动真实 `studio.healVideoStage`，并**先做未熔断对照**证明造景与判据有判别力。

```bash
node /tmp/w3/rt3-heal-trip.mjs
```

```text
RT-③-1 nextTripState 连打 5 次：1:1/false/0  2:2/false/0  3:3/true/1  4:4/true/1  5:5/true/1  （trips 不重复计数）
RT-③-2 对照（consecutive=0）：action=hold-human artifact.calls=1 jobs+2 to=null  ← 未熔断时确实会动手（说明判据有判别力）
RT-③-3 主假设（consecutive=2，本次为第 3 次同类失败）：
        action=hold-human tripped=true calls=0 to=null jobs+0 events+0
        reason=阶段级熔断：请求超时 在本阶段连续 3 次（阈值 3），已停止自动重跑与换后端
        artifact.selfHeal：tripped=true consecutive=3 threshold=3；节点 lastError 未被改写
RT-③-4 熔断后再调 4 次（force=true）：hold-human/hold-human/hold-human/hold-human，calls 全 0，jobs+0，events+0
RT-③-5 清空熔断采样位后：I5 账本（switches=1）→ decideHeal action=hold-human to=null；链尾 placeholder 无目标 → 亦 hold
RT-③-6 三种 mode 对照：off/report/auto-free 均 to=null（未换后端），但三者 artifact.calls 都 =1（见 R-W3-03）
RT-③-7 tripThreshold 归一化：undefined/0/'abc'→3；1→1；99→99；-1→-1（负值未夹紧，方向为更早熔断）
```

**结论**：熔断闸门 `src/studio.js:1633-1643` 位于 `runWithHeal`（真正发起重跑/换后端的入口）**之前**，实测熔断时 `calls=0 / to=null / jobs+0 / selfheal_events+0`，且熔断事实落进阶段 artifact 可审计；熔断后反复调用（含 `force=true`）无法重新触发换后端；即使熔断采样位被清掉，I5 账本（同 `(scope, stage, from)` 只换一次）仍拦得住。

### ④ 「canvas-perf 接线后既有渲染行为变化」——**未能证伪（A/B 与独立重算逐值一致）**

手法：**同一页面、同一份真实数据、同一串视口操作**，A 组 = 线上已接线版本；B 组 = Playwright 路由拦截，把 `/views/actors.js` 换成仓库既有的接线前 `web/views/actors.js.bak` 内容（不重启 8788、不改任何仓库文件）。

```bash
LD_LIBRARY_PATH=/home/linsheng/pwlibs/extract/usr/lib/x86_64-linux-gnu python3 /tmp/w3/rt4-render-ab.py
node /tmp/w3/rt4b-links-and-zoom.mjs
```

```text
A 组（线上已接线）加载 canvas-perf.js = True；pageerror 0 条
B 组（路由拦截为 .bak 接线前）加载 canvas-perf.js = False；pageerror 0 条   ← 拦截生效的判据
18 个视口状态（zoom 0.05/0.15/0.22/0.35/0.50/0.80/1.00/2.00/8.00 × {滚轮定位, 方向键平移}）：
  drawn(A/B) 逐值相同（差异状态数 = 0/18）、lod 相同、HUD 文案（含「视野内 N」）逐字相同、items 相同、zoom/pan 相同
  例：zoom=8.00000 时 A/B 均为 drawn=2，HUD 均为「🔍 800% ▦ 宫格 👥 10（视野内 2） 🗂 7 组 🔗 21 LOD 全」
RT-④-2 独立重算（接线前内联公式 + 真实几何 + pad 50）与线上 drawn：18/18 一致（可比状态=18 不一致=0）
RT-④-3 试验后画布视图已还原为试验前原值（zoom=0.5314410000000002 panX=642.4561465901197 panY=583.8538050319788）
RT-④-b1 从 .bak 源码文本取基线：LOD 阈值=[0.22,0.5]、pad=[50,50,50,50]（与 CULL_PAD=50 一致）
RT-④-b2 LOD 18 个采样点（含 NaN/Infinity/-1/边界）与接线前内联式逐点相同
RT-④-b3 45 种 (showLinks, links) 组合下「是否进入连线绘制」与接线前语义一致（不一致=0）
RT-④-b4 3000 组随机+边界：视口矩形 0 不一致、z 序 0 不一致、drawn 0 不一致
```

**结论**：接线前后既有渲染行为**无可观测变化**（`__acDebug` 字段 + HUD 条数 + 独立重算三重证据），且接线未引入 `pageerror`。

---

## 4. 逐项判定表（含文件:行号与复现命令）

| 项 | 判定 | 证据锚点（文件:行号） | 复现命令 |
|---|---|---|---|
| C-002-ac① 不传 canvasId 且无法自证时整画布删除被拒（scope='all' / 覆盖整画布） | **PASS** | `web/lib/canvas-select.js:752-753`（CANVAS_ID_REQUIRED 分支，位于 coversAll 之后、MAIN_CANVAS_GUARD 之前） | `node /tmp/w3/rt1-canvasid-whole-delete.mjs` → RT-①-B |
| C-002-ac② 自证为主画布时返回 MAIN_CANVAS_GUARD | **PASS** | `web/lib/canvas-select.js:756`、`deriveCanvasId:308-317`、`isMainCanvas:290-292` | 同上 → RT-①-C |
| C-002-ac③ 不传 canvasId 的部分选区行为逐字节不变 | **PASS** | `web/lib/canvas-select.js:747-756`（coversAll=false 时不进新分支） | `node tests/canvas-select.test.mjs`（247/0，含 B7k 对照断言） |
| C-002-ac④ applyBatchPlan 对拒绝码零 effects | **PASS** | `web/lib/canvas-select.js:1119-1133`（确认闸门先于拒绝码校验，走既有分支） | RT-①-B（DELETE请求=0）；`rt1.log` |
| C-002-ac⑤ canvasSource 四态 | **PASS** | `web/lib/canvas-select.js:308-317、535-536` | RT-①-F/H 输出四态 |
| C-002-ac⑥ 套件 ≥228 / 失败 0 / exit 0 | **PASS** | `tests/canvas-select.test.mjs` | `node tests/canvas-select.test.mjs; echo $?` → 247/0/0 |
| C-002-ac⑦ 既有 222 条期望零改动 | **PASS** | diff 删除行=0（§1） | `diff tests/canvas-select.test.mjs.bak tests/canvas-select.test.mjs | grep -c '^<'` → 0 |
| **C-002 新发现 R-W3-01** 不传 canvasId + 不传 canvasTotal + 节点 `canvas_id` 为空时，把整画布全部节点当「选区」→ 确认后仍然全删 | **RISK（中低·契约未覆盖）** | `web/lib/canvas-select.js:747-748`（`total===null` → `coversAll=false`，不经任何画布 id 校验） | RT-①-D：`ok=true affected=5 DELETE请求=10` |
| **C-002 新发现 R-W3-02** 混合选区取「首个非空 canvas_id」自证，若首项非主画布则同选区内主画布节点被删且不触发闸门 | **RISK（中低）** | `web/lib/canvas-select.js:311-315`（只取首个非空，不校验一致性） | RT-①-E：`canvasId=CV-2(来源items) mainCanvas=false DELETE请求=6` |
| C-003-ac① 单轮触发 ≤ cap，中文原因 | **PASS** | `src/schedules.js:1572`（cap 二次夹紧）、`1581-1596`（截断分支） | `node /tmp/w3/rt2-tick-cap.mjs` → RT-②-1 |
| C-003-ac② 被截断窗口不丢（不写台账行） | **PASS** | `src/schedules.js:1583-1589`（注释写明唯一索引风险；只调 `recordSkipCounters` 且不传 nextRunAt） | RT-②-2（该窗口行数=0）、RT-②-3（下一轮补上） |
| C-003-ac③ 被截断项零副作用（不建 job、不进预算闸门） | **PASS** | `src/schedules.js:1578-1596`（判定在 dry 分支之后、预算闸门之前） | RT-②-1（jobs增量=2 = cap）、RT-②-4 |
| C-003-ac④ 配置健壮（0/负/非数 → 20，>200 → 200） | **PASS** | `src/schedules.js:180-197` | RT-②-5（13 个逐值输出） |
| C-003-ac⑤ 返回值 cap/deferred 与事件载荷 | **PASS** | `src/schedules.js:1630-1637` | RT-②-1 输出 `cap={"limit":2,"fired":2,"capped":4} deferred=4` |
| C-003-ac⑥ manual 忽略 occurrence_at 且幂等 | **PASS** | `src/schedules.js:1366-1377、1441` | RT-②-9；`node tests/test-schedules.js`（S-10 ⑪⑫ 断言） |
| C-003-ac⑦ auto 分支零回归 | **PASS** | `src/schedules.js` auto 分支判定逻辑未改：被删的 12 行经逐行核对**全部是就地替换的接口行**（`skipped_deduped` 原因码数组行、manual 窗口键行、6 处返回体行、`schedule:tick` 事件载荷行、tick 返回体行），无任何无关逻辑被删除 | `diff src/schedules.js.bak src/schedules.js \| grep '^<'`（12 行逐行核对）；`node tests/test-schedules.js` → 130/0/0 |
| C-003-ac⑧ 套件 ≥124 / 失败 0 / exit 0 | **PASS** | `tests/test-schedules.js` | `node tests/test-schedules.js; echo $?` → 130/0/0 |
| W2-B-ac① 连续 N 次同类可自愈错误 → 阶段级熔断 | **PASS** | `src/studio.js:1631-1643`（闸门在动手之前）、`src/self-heal.js:697-724`（nextTripState） | `node /tmp/w3/rt3-heal-trip.mjs` → RT-③-1/③-3 |
| W2-B-ac② 熔断即停止自动重跑与换后端（零生成调用） | **PASS** | `src/studio.js:1414-1433`（`calls: 0`、`to: null`、`action:'hold-human'`） | RT-③-3（calls=0 jobs+0 events+0）、RT-③-4（再调 4 次全 hold） |
| W2-B-ac③ 熔断事实可审计（artifact/中文告知） | **PASS** | `src/studio.js:1420-1427`、`src/self-heal.js:749+`（tripNotice 单一文案源） | RT-③-3（artifact.selfHeal.tripped/consecutive/threshold） |
| W2-B-ac④ 熔断不误伤不可自愈类别 | **PASS** | `src/self-heal.js:697-724`（`healable!==true` 原样返回） | RT-③-1（moderation 不计入，tripped 原样保持） |
| W2-B-ac⑤ 套件 101→129 且既有全绿 | **PASS** | `tests/test-selfheal.js`（新增 184 行、删除 0 行） | `node tests/test-selfheal.js; echo $?` → 129/0/0 |
| **W2-B 新发现 R-W3-03** `mode=off/report` 文案写「不重试」，实测仍执行一次同后端重跑并建 job | **RISK（中低）** | `src/self-heal.js:495-496`（mode 判定）vs `src/self-heal.js:865-880`（「① 首发」在 mode 判定之前无条件调用）；`src/studio.js:891` 调用 `healVideoStage` 时不看 mode | RT-③-6：`mode=off artifact.calls=1 jobs+2`、`mode=report artifact.calls=1 jobs+2` |
| **W2-B 新发现 R-W3-04** `tripThreshold` 负值未夹紧 | **RISK（低·fail-closed 方向）** | `src/self-heal.js:98`（`Number(out.tripThreshold) \|\| 默认`，-1 为真值） | RT-③-7：`tripThreshold=-1 → -1；首次失败即 tripped=true` |
| T-403-ac① 接线 4 处（导入 / lodLevel / draw 五处替换 / 连线开关）行为等价 | **PASS** | `web/views/actors.js:13`（命名空间导入）、`:414`、`:566-584`、`:616`、`:620`；被删的 16 行逐行核对**全部是被替换的内联实现**（LOD 三行/视口矩形四行/`zOf`+sort 两行/裁剪条件一行/`drawn++` 与 `S._drawn`/连线开关/`updateHud`），无其它逻辑被删 | RT-④ A/B（18/18）+ RT-④-b1~b4；`diff web/views/actors.js.bak web/views/actors.js \| grep '^<'` |
| T-403-ac② 既有渲染行为零变化（__acDebug 字段/条数） | **PASS** | 同上 | `python3 /tmp/w3/rt4-render-ab.py` → 18 状态 drawn/lod/HUD 全同 |
| T-403-ac③ 无 pageerror / 画布页仍挂载 | **PASS** | 线上页面 + `tests/ui-smoke.py` | RT-④-0（pageerror 0）；ui-smoke 22/0 |
| T-403-ac④ `web/lib/canvas-perf.js` 冻结指纹未动 | **PASS** | `web/lib/canvas-perf.js` md5 `385167759e328fe4866b459457c95102`（= L6-verify §5 冻结值） | `md5sum web/lib/canvas-perf.js` |
| 过程项：`README.md:11` 断言台账 | **FAIL（低）** | `README.md:11`（声明 2693）vs 实跑 2760 | `bash scripts/verify-all.sh` 后按 §2.2 解析；`/tmp/w3/stage-table.txt` |
| 过程项：C-004（config 零字节副作用） | **BLOCKED（治理未交付）+ 目标实测未达成 FAIL** | 缺 `strategist/runs/C-004.json`；`tests/ui-simulate.py:1423` 仍会写盘（`src/routes/meta.js:168` → `src/config.js:193`） | §2.3 的 before/after md5 与 `image.concurrency 3→2` |
| 过程项：`strategist/reports/README.md:79`「canvas-perf 目前零接线」表述 | **FAIL（低·文档）** | 第 79 行（§8 第 5 条）已被 T-403 接线改写为过期 | `sed -n '79p' strategist/reports/README.md` |

---

## 5. 风险与残留（验收军师不修，交总军师派卡）

1. **R-W3-01（中低）** `web/lib/canvas-select.js:747-748` —— 库层无法在「调用方不声明 `canvasTotal`/`scope`」时识别「整画布」，节点自证也失效（`canvas_id` 为空）时仍可全删。**建议**：把「删除类动作缺 canvasId 且无法自证」升级为硬拒（不看 coversAll），或强制调用方传 `canvasTotal`。
2. **R-W3-02（中低）** `web/lib/canvas-select.js:311-315` —— 自证只取「首个非空 `canvas_id`」，混合画布选区（首项非主画布 + 含主画布节点）可绕过 `MAIN_CANVAS_GUARD`。**建议**：自证时校验所有非空 `canvas_id` 是否一致，不一致直接拒绝。
3. **R-W3-03（中低）** `src/self-heal.js:865-880` vs `:495-496` —— `mode=off`/`report` 的文案承诺「不重试」，实测**仍会**执行一次同后端重跑并建 job（`artifact.calls=1`、`jobs+2`）。若 `video.backend` 为付费后端，`mode=off` 下仍会产生一次付费重跑，与界面/文档承诺不一致。**建议**：把 mode 判定前移到 `runWithHeal` 的「① 首发」之前，或在 `src/studio.js:891` 调用 `healVideoStage` 前先看 mode。（口径提醒：该行为源自第 1 轮 T-402 接线，非本轮新增。）
4. **R-W3-04（低）** `src/self-heal.js:98` —— `tripThreshold` 负值未被夹紧（-1 直接生效）；方向是 **fail-closed**（更早熔断，不会更晚），故只登记不判 FAIL。
5. **R-W3-05（中·过程）** 全量自检改写真实 `config/config.json` 且**改的是语义值**（`image.concurrency 3→2`），治理卡 C-004 未交付。**运维须知（本轮实测口径）**：跑 `bash scripts/verify-all.sh` 前必须 `cp config/config.json /tmp/config.baseline.json`，跑后 `diff` 并还原；不要把「语义仍为原值」当作既定事实（L6-verify:106/430 的该表述已被本轮实测推翻）。
6. **R-W3-06（低·文档）** `README.md:11` 台账（2693）与实跑（2760）差 +67；`strategist/reports/README.md:79` 的「canvas-perf 零接线」已过期。
7. **已声明差异（非缺陷）**：`dry-run`/`manual` 不受单轮 tick 配额约束；`canvas-perf` 的 NaN 坐标语义与原内联式不同（坐标来自 SQLite 数值列，不产生 NaN）；`L.drawOrder` 仍为全量 z 序（刻意的等价取舍）。

---

## 6. 复现清单（一条命令一条结论）

```bash
cd /home/linsheng/Desktop/ai-video-factory

# ① 四个受影响测试（结论行 + 退出码）
node tests/canvas-select.test.mjs; echo $?        # 247 通过 / 0 失败 / 0
node tests/test-schedules.js;      echo $?        # 130 通过 / 0 失败 / 0
node tests/test-selfheal.js;       echo $?        # 129 通过 / 0 失败 / 0
LD_LIBRARY_PATH=/home/linsheng/pwlibs/extract/usr/lib/x86_64-linux-gnu python3 tests/ui-smoke.py; echo $?   # 22 通过 / 0 失败 / 0

# ② 全量自检一次（必须先留 config 基线，跑后还原）
cp config/config.json /tmp/config.baseline.json && md5sum config/config.json
bash scripts/verify-all.sh; echo $?               # exit=0、末行「✅ 全部自检通过」、30/30
diff /tmp/config.baseline.json config/config.json # 18c18 image.concurrency 3 → 2（副作用）
cp /tmp/config.baseline.json config/config.json   # 还原（cmp 逐字节一致）

# ③ 红队四条
node /tmp/w3/rt1-canvasid-whole-delete.mjs        # ① 11/0（改前 fail-open 复现 + 改后拒绝 + 2 条残余绕过）
node /tmp/w3/rt2-tick-cap.mjs                     # ② 12/0（截断/窗口不丢/配置夹紧/注入/dry-run/dedup）
node /tmp/w3/rt3-heal-trip.mjs                    # ③ 17/0（熔断 hold-human、calls=0、I5 账本）
LD_LIBRARY_PATH=/home/linsheng/pwlibs/extract/usr/lib/x86_64-linux-gnu python3 /tmp/w3/rt4-render-ab.py   # ④ 11/0（18 状态 A/B 全同）
node /tmp/w3/rt4b-links-and-zoom.mjs              # ④ 5/0（LOD/pad/连线开关/3000 组几何等价）

# ④ 只读自查
md5sum web/lib/canvas-select.js src/schedules.js src/self-heal.js src/studio.js web/views/actors.js web/lib/canvas-perf.js
ps -o pid,lstart,etime,cmd -p 2679524             # 验收前后 PID/STARTED 一致（未重启）
```

---

## 7. 红线自查（验收方自身合规）

- **未改任何源码与测试**：验收前后逐项 md5 **逐字一致**，且与四份实现方 run 记录的 `md5_after` 完全吻合：

  ```text
  6929194c1760ab0a2bfa7b49c1f0a32b  web/lib/canvas-select.js     （C-002 报 md5_after 一致）
  5cbbba8dd6c889b1f63fc8422b8d6df3  src/schedules.js             （C-003 报 md5_after 一致）
  4d8a15ad21b955703b59c1da853267f6  src/self-heal.js
  2e856bda2fe5ab264d1f158ca0c4c7cd  src/studio.js
  b389cf7c518b88748e8915d03ce0a5bd  web/views/actors.js          （T-403 报改后 md5 一致）
  385167759e328fe4866b459457c95102  web/lib/canvas-perf.js       （L6-verify §5 冻结指纹一致）
  f4fccec38dab2a8188a606b354381721  tests/canvas-select.test.mjs
  de82ff650754da1b4669c57646155d9a  tests/test-schedules.js
  22339068a648835edb7f820bb1396f74  tests/test-selfheal.js
  8dc2d44dd1bb0ef8b0d85b8fd067be17  tests/ui-smoke.py
  fd3241cc6da2ea882c4905372cb4826c  tests/ui-simulate.py
  0552a2d7b303f2149ddfbfe9cfd782b1  config/config.json          （已还原为跑前字节）
  ```

- **写入范围**：只写了 `strategist/reports/W3-acceptance.md` 与 `strategist/runs/W3-acceptance.json`；红队脚本/日志全部落 `/tmp/w3/`（`rt1/rt2/rt3/rt4/rt4b`、`verify-all.log`、`tests-*.log`、`stage-table.txt`）。
- **未重启 8788**：`ps -o pid,lstart,etime,cmd -p 2679524` → `2679524 Tue Sep 29 10:31:14 2026`（与派单给的 PID 一致；验收全程 ELAPSED 从 01:50 走到 02:05，未重启）。
- **未使用真实库做破坏性验证**：红队 ②③ 全程 `FACTORY_DB/FACTORY_DATA_DIR/FACTORY_CONFIG` 指向 `mkdtemp` 临时库；红队 ④ 只做只读页面观测 + 把画布视图**还原为试验前原值**（还原后实测与试验前逐值一致）。
- **未暴露思维链**：本报告只给「命令 + 原始输出 + 判定」。
- **未采信实现方自评**：四份 `strategist/runs/*.json` 的 PASS 声明均被独立重跑替换；红队另行找到实现方未报的 2 条绕过路径与 2 条行为/文案不一致。
- **副作用如实记录**：全量自检自身写 `docs/全模块功能模拟测试报告.md|.json`（阶段 21 设计内产物）、`data/` 运行产物、以及被本报告定量的 `config/config.json` 语义改写（已还原）。

---

## 8. 一句话结论

**W2 四路交付（C-002 / C-003 / W2-B / T-403）经独立实跑复核：4 × PASS，可交付；** 但必须同时接受两条附带条件：① **全量自检前必须留 `config/config.json` 基线并在跑后还原**（RK-L6-06 不仅改写文件，还会改写 `image.concurrency` 这类语义值，治理卡 C-004 尚未交付）；② `README.md:11` 断言台账（2693）已过期（实跑 2760），需文档线同步。红队新发现的 2 条画布绕过路径（R-W3-01/02）与 2 条自愈口径不一致（R-W3-03/04）**不阻断本轮交付**，但建议按 §5 建议各开一张返工卡。
