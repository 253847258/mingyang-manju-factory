# W4 复验报告 · 验收军师（对三条返工 + 自检治理的独立复验）

> **角色**：验收军师（**只读复验**）。本报告只依据**本轮实跑证据**下结论，不采信任何返工方自评（`R-W3-01-02-canvas-safety.json` / `R-W3-03-selfheal-mode.json` / `C-004.json` 只作为「被复验对象的自述」列出，不作为判定依据）。
> **只读声明**：本轮**未修改任何源码与测试**（复验前后指纹逐字一致，见 §8）；唯一写入物是本报告与结论文件 `strategist/runs/W4-acceptance.json`；红队脚本与日志一律落 `/tmp/w4/`。
> **环境**：`/home/linsheng/Desktop/ai-video-factory`；Node **v24.18.0**；Python **3.12.3**；零 npm 依赖。
> **服务**：`http://127.0.0.1:8788` **未重启**（复验全程 PID `2679524`、`ETIME` 由 `03:28` 走到 `03:45`，见 §8）。
> **取证时间窗**：2026-09-29 14:00 ~ 14:25。
> **task_id**：派单未给显式编号，本报告按写入文件名归口为 **W4-acceptance**（`strategist/runs/W4-acceptance.json`）。

---

## 0. 结论速览

| # | 复验项 | 判定 | 一句话依据（复现命令见 §5/§6） |
|---|---|---|---|
| 1 | 返工 **R-W3-01-02**：画布安全（缺 canvasId + 缺 canvasTotal + 空 canvas_id / 混合画布选区） | **PASS**（附 2 条新残余 R-W4-01/02） | 红队 A/B 26 条判定全达预期：① 12 个变体改前 `affected=5 DELETE=10` → 改后 `CANVAS_ID_REQUIRED affected=0 DELETE=0`；② 6 个变体改前 `affected=3 DELETE=6` → 改后 `MAIN_CANVAS_GUARD affected=0 DELETE=0`；`node tests/canvas-select.test.mjs` → **287 通过 / 0 失败 / exit=0** |
| 2 | 返工 **R-W3-03**：`mode=off/report` 不再重试/建 job | **PASS**（附 1 条新残余 R-W4-03） | 红队 A/B 23 条判定全达预期：模块层改前 `calls=1` → 改后 `calls=0`；studio 层 `calls=0 jobs+0 events+0 to=null`，正向对照 auto-free `artifact.calls=1 jobs+2`；`node tests/test-selfheal.js` → **144 通过 / 0 失败 / exit=0** |
| 3 | 返工 **C-004**：全量自检不再改写真实 config | **PASS（终态）+ FAIL（根因未修）** | 本轮独立基线：跑前/跑后 md5 均 `0552a2d7b303f2149ddfbfe9cfd782b1`（4903 B），`cmp` 逐字节一致 → **终态达成**；单跑阶段 23 亦 **175/0 exit=0 且逐字节一致**；但守卫日志点名**阶段 6 跑中确实改写并还原**（`0552a2d7→cd8edca0`），且**单跑 `node tests/test-bridge.js` 仍改写真实 config 且不还原**（本轮独立复现，已还原）→ **根因仍在，属补偿式治理** |
| 4 | 三条测试真跑（canvas-select / test-selfheal / ui-smoke） | **PASS** | 287/0、144/0、22/0，退出码全 0（§1） |
| 5 | `bash scripts/verify-all.sh` 一次真跑 | **PASS** | `exit=0`、末行 `✅ 全部自检通过`、**30/30 阶段通过**、日志 3622 行（§2） |
| 6 | **断言总数变化**（派单要求的「新的真实总数」） | **2818**（上轮 2760，**+58**） | 前 25 阶段 **2101**（上轮 2098，+3）；26~30 阶段 **717**（上轮 662，+55）。逐阶段对账见 §2.2 |
| 7 | 过程项：`README.md:11` 断言台账 | **FAIL（低·文档）** | README 声明 **2760**，实跑 **2818**，差 **+58**；且分阶段数字（23/27/28 位）仍是返工前旧值 |
| 8 | 过程项：**「禁止改既有测试期望凑绿」**独立核查 | **FAIL（低·治理口径，需总军师裁决）** | `tests/test-selfheal.js.bak:457-458 → tests/test-selfheal.js:461-465`，**1 条既有断言期望被改写**（`calls.length===1` → `calls.length===0`）；方向为**变严**且有来源注释，**非凑绿**，但违反上轮验收所用的「既有断言删除行=0」机械红线 |

**一句话结论：三条返工的可观测目标全部达成（画布 fail-closed、mode 门控零生成调用、自检终态零字节改写），4 条红队主假设**均未被证伪**；但必须接受五条附带条件：① 自检对 config 的治理是**补偿式**（跑中阶段 6 仍改写并还原，根因在 `tests/test-bridge.js:9-13/164/173`——单跑任何一次都会把用户 `image.concurrency` 从 3 改成 2 且不还原）；② 画布库层仍存在 2 条**契约未覆盖**的残余臂（缺 `canvasTotal` 时无法识别「整画布」、调用方可谎报 `canvasId`）；③ `mode` 非法值（`'OFF'`/`' off '`/`0`/`null`）静默回落 `auto-free`（fail-open，误写会静默开启自愈）；④ `tests/test-selfheal.js` 有 1 条既有断言期望被改写（变严、有注释、非凑绿，但违反上轮「删除行=0」机械红线，**需上位裁决是否合规**）；⑤ `README.md:11` 台账 2760 已过期，应为 **2818**。**

---

## 1. 三条测试真跑（原样取退出码，不接管道、不接或运算）

```bash
cd /home/linsheng/Desktop/ai-video-factory
node tests/canvas-select.test.mjs; echo "exit=$?"
node tests/test-selfheal.js;      echo "exit=$?"
LD_LIBRARY_PATH=/home/linsheng/pwlibs/extract/usr/lib/x86_64-linux-gnu python3 tests/ui-smoke.py; echo "exit=$?"
```

| # | 测试文件 | 本轮实测 | 退出码 | 与上轮（W3）对照 | 日志 |
|---|---|---|---|---|---|
| 1 | `tests/canvas-select.test.mjs` | **287 通过 / 0 失败** | **0** | 247 → 287（**+40**） | `/tmp/w4/t-canvas.log` |
| 2 | `tests/test-selfheal.js` | **144 通过 / 0 失败** | **0** | 129 → 144（**+15**） | `/tmp/w4/t-selfheal.log` |
| 3 | `tests/ui-smoke.py` | **22 通过 / 0 失败** | **0** | 22 → 22（未变） | `/tmp/w4/t-smoke.log` |

原始结论行（尾行原文）：

```text
=== 结果：287 通过 / 0 失败 ===
exit=0
=== 结果：144 通过 / 0 失败 ===
exit=0
=== 结果：22 通过 / 0 失败 ===
exit=0
```

**「禁止改既有测试期望凑绿」——验收方自己重算（不采信实现方 diff 自述）**：

```bash
for f in tests/canvas-select.test.mjs tests/test-selfheal.js tests/ui-simulate.py; do
  b=$(ls "$f".bak 2>/dev/null | head -1); [ -n "$b" ] && printf '%s  删除行=%s 新增行=%s\n' "$f" "$(diff "$b" "$f" | grep -c '^<')" "$(diff "$b" "$f" | grep -c '^>')"
done
```

```text
tests/canvas-select.test.mjs  删除行=0 新增行=125     ← 既有 247 条期望零改动（+40 条新断言）
tests/test-selfheal.js        删除行=2 新增行=144     ← ★1 条既有断言期望被改写（见 §5-8）
tests/ui-simulate.py          删除行=3 新增行=106     ← 3 行均为「注释 2 行 + 还原调用 1 行」的替换，无断言被删
```

`tests/ui-simulate.py` 被替换的 3 行逐行核对（`diff -u`）：`76`（注释）、`95`（注释）、`100`（还原调用由固定 `placeholder+generic` 改为按暂存整段 `image` 写回）——**无任何既有断言被删除或放宽**。`tests/test-schedules.js`、`tests/ui-smoke.py` 的 md5 与本轮返工前**逐字未变**（§8.2）。

---

## 2. `scripts/verify-all.sh` 一次真跑（硬证据 · 本轮仅此一次）

跑前**独立**留基线（命令与基线均由验收方自己生成，不引用实现方结论）：

```bash
cd /home/linsheng/Desktop/ai-video-factory
md5sum config/config.json > /tmp/w4/config.md5.before     # 0552a2d7b303f2149ddfbfe9cfd782b1  config/config.json
cp config/config.json /tmp/w4/config.before.json          # 4903 字节，逐字节副本
{ bash scripts/verify-all.sh; echo "verify-all exit=$?"; } > /tmp/w4/verify-all.log 2>&1
# 完整日志 3622 行
```

**结论**：`exit=0`；30 个阶段**全部**「通过」（无一被 `[ -f ]` 守卫跳过）；末行 `✅ 全部自检通过`。

### 2.1 末 30 行原始输出（硬证据，逐字）

```text
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
  · 实测：200 卡位 0.0104 ms/次，1000 卡位 0.0405 ms/次（visibleItems + cullStats 合计均值，100 次）
  ✓ 预算：200 卡位单次 visibleItems + cullStats 合计 ≤ 1 ms
  ✓ 预算：1000 卡位单次 visibleItems + cullStats 合计 ≤ 5 ms

=== 结果：89 通过 / 0 失败 ===
── 30/30 画布性能（视口裁剪/LOD 分级/批量几何/单帧预算与 z 序稳定）：通过
【配置守卫】跑后比对：md5=0552a2d7b303f2149ddfbfe9cfd782b1（跑前 0552a2d7b303f2149ddfbfe9cfd782b1）
【配置守卫】✅ 跑前跑后逐字节一致，无需还原
【配置守卫】本轮曾改写并已逐次还原的阶段：6/30 画布资产桥（资产包/绑定/分镜增强/参考图）；（成因需返工对应测试，勿改门禁）

✅ 全部自检通过
verify-all exit=0
```

### 2.2 逐阶段断言对账（验收方自己解析日志，不抄实现方数字）

| 阶段 | 本轮 | 上轮 | | 阶段 | 本轮 | 上轮 |
|---|---|---|---|---|---|---|
| 1 引擎自检 | 23 | 23 | | 16 规模压测 | 24 | 24 |
| 2 模块1 演员矩阵 | 105 | 105 | | 17 交付包 | 74 | 74 |
| 3 模块2 小说工坊 | 45 | 45 | | 18 成片质检 | 47 | 47 |
| 4 模块3 剧本工厂 | 74 | 74 | | 19 配音链路 | 32 | 32 |
| 5 模块4 制作台 | 71 | 71 | | 20 出海物料 | 32 | 32 |
| 6 画布资产桥 | 33 | 33 | | 21 全模块端到端 | 83 | 83 |
| 7 ComfyUI 视频引擎 | 63 | 63 | | 22 前端冒烟 | 22 | 22 |
| 8 厂商适配器 | 82 | 82 | | **23 全模块 UI 模拟** | **175** | 172 ★+3 |
| 9 生产守护 | 37 | 37 | | 24 满配前端 | 21 | 21 |
| 10 生产看板 | 30 | 30 | | 25 无限画布审计 | 177 | 177 |
| 11 任务队列与取消 | 47 | 47 | | **26 定时排产** | **130** | 130 |
| 12 Agent 接口与闸门 | 284 | 284 | | **27 阶段失败自愈** | **144** | 129 ★+15 |
| 13 画布 DAG 引擎 | 199 | 199 | | **28 画布筛选批处理** | **287** | 247 ★+40 |
| 14 自动化制片 Agent | 148 | 148 | | 29 字幕智能断行 | 67 | 67 |
| 15 时间线多轨音频 | 173 | 173 | | 30 画布性能 | 89 | 89 |

- **前 25 阶段 = 2101**（上轮 2098，**+3**）：唯一变化是阶段 23（UI 模拟）172 → 175，即 C-004 新增的 3 条配置守卫断言；其余 24 个阶段**逐值不变** → 证明既有断言在本轮返工中**零删改**（与 §1 的「删除行=0」互为独立证据）。
- **26~30 阶段 = 717**（上轮 662，**+55**）= 27 阶段 +15（R-W3-03）+ 28 阶段 +40（R-W3-01-02）。
- **30 阶段合计 = 2818**（**新的真实总数**，上轮 2760，+58 = 3 + 15 + 40，与三张返工卡的新增断言数**逐项吻合**）。
- 解析方式：按 `^════════ N/30` 分段取各段汇总行的通过数（阶段 1/3/4/21/25 的汇总行格式不同，已逐段人工核对原文），脚本与明细落 `/tmp/w4/`（解析内联执行，见 §6 命令）。

### 2.3 config 逐字节一致性（**独立**验证，派单第 2 项）

```bash
md5sum config/config.json                       # 跑前 0552a2d7b303f2149ddfbfe9cfd782b1（4903 字节）
# ……跑一次 bash scripts/verify-all.sh（上面 §2）……
md5sum config/config.json                       # 跑后 0552a2d7b303f2149ddfbfe9cfd782b1（4903 字节）
cmp /tmp/w4/config.before.json config/config.json && echo "cmp: 与跑前逐字节一致"
# cmp: 与跑前逐字节一致（退出码 0）
```

**结论：跑前跑后 md5 相同、字节数与 `cmp` 双重确认逐字节一致 → 返工 C-004 的「终态零改写」目标达成。**
但**跑中确实发生过改写并已还原**（守卫自述，验收方核对为同一 md5 对）：`/tmp/w4/verify-all.log:437` 点名 **阶段 6**（`0552a2d7… → cd8edca0…`），`:449` 还原为跑前字节。**根因未修**（见 §5-3 与 R-W4-05）。

---

## 3. 红队证伪（4 条主假设逐条对抗，共 75 条判定，全部有原始输出）

脚本只写 `/tmp/w4/`；破坏性验证全部在 `mkdtemp` 临时库/临时配置内；改前版本取自仓库既有 `.bak`（A/B 对照，不靠实现方自述）。

| 脚本 | 覆盖主假设 | 结果 |
|---|---|---|
| `/tmp/w4/rt1-canvas.mjs` | ① 缺 canvasId/canvasTotal/空 canvas_id 仍能删全部；② 混合画布选区绕过主画布保护 | **26 条判定通过 / 0 未达预期**（`/tmp/w4/rt1.log`） |
| `/tmp/w4/rt2-mode-off.mjs` | ③ `mode=off/report` 仍重试/建 job | **23 条判定通过 / 0 未达预期**（`/tmp/w4/rt2.log`） |
| 独立实验（§3.4） | ④ 自检仍改写真实配置 | **终态证伪**（md5+cmp 一致）；**跑中改写复现**（守卫日志 + 单跑 `test-bridge.js`） |

### ①「缺 canvasId + 缺 canvasTotal + 空 canvas_id 仍能删全部」——**已堵死**（12 个变体全部硬拒）

```bash
node /tmp/w4/rt1-canvas.mjs      # 见 /tmp/w4/rt1.log
```

改前（`web/lib/canvas-select.js.bak`，md5 `6929194c1760ab0a2bfa7b49c1f0a32b` = 上轮验收值）vs 改后（当前实现）逐变体对照：

| 变体 | 改前 | 改后 |
|---|---|---|
| A1 完全不传 opts/params（节点 `canvas_id=""`） | `NEED_CONFIRM → affected=5 DELETE=10` ★原缺陷 | `CANVAS_ID_REQUIRED affected=0 DELETE=0` |
| A2 `opts.canvasId=""` | `affected=5 DELETE=10` | `CANVAS_ID_REQUIRED 0/0` |
| A3 `opts.canvasId=null` + `params.canvasId=""` | `affected=5 DELETE=10` | `CANVAS_ID_REQUIRED 0/0` |
| A4 纯空白 `canvasId="   "` | `affected=5 DELETE=10` | `CANVAS_ID_REQUIRED 0/0` |
| A5 节点完全缺 `canvas_id` 键 | `affected=5 DELETE=10` | `CANVAS_ID_REQUIRED 0/0` |
| A6 节点 `canvas_id=null` | `affected=5 DELETE=10` | `CANVAS_ID_REQUIRED 0/0` |
| A7 全幽灵卡位（`node=null`） | `NOTHING_TO_DO 0/0` | `CANVAS_ID_REQUIRED 0/0` |
| A8 `scope="all"` | `CANVAS_ID_REQUIRED 0/0` | `CANVAS_ID_REQUIRED 0/0` |
| A9 `scope="all"` + `canvasTotal=0` | `CANVAS_ID_REQUIRED 0/0` | `CANVAS_ID_REQUIRED 0/0` |
| A10 `opts.allItems=[]`（`canvasTotalOf` 第 3 源） | `affected=5 DELETE=10` | `CANVAS_ID_REQUIRED 0/0` |
| A11 `canvasTotal=5`（等于全部）但无 canvasId | `CANVAS_ID_REQUIRED 0/0` | `CANVAS_ID_REQUIRED 0/0` |
| A12 计划阶段即已确认（`confirm:true`） | `OK → affected=5 DELETE=10` | `CANVAS_ID_REQUIRED 0/0` |

**结论**：主假设①**未能证伪**——12 种「缺凭据」形态（含确认闸门已过、`allItems` 旁路、`scope='all'`）全部 `affected=0 且 DELETE 请求=0`，判据已从 `coversAll` 移到 `canvasSource==='none'` 硬拒（`web/lib/canvas-select.js:795-798`），中文原因两版（`canvasIdRequired` / `canvasIdRequiredPartial`，原文见 `/tmp/w4/rt1.log`）。
**残余（R-W4-01，中低）**：只要选区里**有任意一个非空 `canvas_id`**，`canvasSource` 就不是 `'none'`，①的硬拒不触发；而缺 `canvasTotal`/`scope` 时 `coversAll=false`，主画布闸门也不触发 → **把主画布的全部节点当选区传入仍会被整批删除**（改前改后同：`affected=3 DELETE=6`）；补传 `canvasTotal=3` 后立刻 `MAIN_CANVAS_GUARD`（真实调用点恒传 `canvasTotal`，见 §5-1）。

### ②「混合画布选区仍绕过主画布保护」——**已堵死**（6 个变体全部硬拒）

| 变体 | 改前 | 改后 |
|---|---|---|
| B1 `['CV-2','CV-MAIN','CV-MAIN']` + `scope="all"` 无 canvasId | `affected=3 DELETE=6` ★原缺陷 | `MAIN_CANVAS_GUARD 0/0` |
| B2 同上 + `opts.canvasId="CV-2"` | `affected=3 DELETE=6` | `MAIN_CANVAS_GUARD 0/0` |
| B3 `['CV-1','CV-MAIN','CV-1']` | `affected=3 DELETE=6` | `MAIN_CANVAS_GUARD 0/0` |
| B4 `['CV-1','CV-2','CV-MAIN']` | `affected=3 DELETE=6` | `MAIN_CANVAS_GUARD 0/0` |
| B5 `['CV-1','CV-2']`（两张非主画布） | `affected=2 DELETE=4` | `CANVAS_ID_CONFLICT 0/0`（新增码） |
| B6 主画布 id 带空白（`' CV-MAIN '` / `'CV-MAIN\n'`） | `affected=3 DELETE=6` | `MAIN_CANVAS_GUARD 0/0` |
| 对照：纯 `CV-MAIN` 整画布删除 | `MAIN_CANVAS_GUARD` | `MAIN_CANVAS_GUARD`（原 AC-3 闸门未被削弱） |
| 对照：纯 `CV-2` 整画布删除 | `affected=2 DELETE=4` | `affected=2 DELETE=4`（未扩大到误伤） |

**结论**：主假设②**未能证伪**。判据由「自证 id 是主画布」扩到「**选区内出现主画布节点且声明/自证的不是主画布**」（`web/lib/canvas-select.js:805-808`），并附带把「跨多个非主画布」判为身份不自洽（`:810-812`，新码 `CANVAS_ID_CONFLICT`）；自证清单来源 `canvasIdsOf()`（`:341-351`，收集**全部**非空 `canvas_id`、去重、trim、跳过幽灵卡位），三条可审计字段落在计划对象上（`:574-576`：`selectionCanvasIds/selectionHasMainCanvas/mixedCanvasSelection`，实测 `{"selectionCanvasIds":["CV-2","CV-MAIN"],"selectionHasMainCanvas":true,"mixedCanvasSelection":true}`）。

**如实记录的 2 条形态边界（非本轮引入，非缺陷）**：
1. `node.canvas_id='cv-main'`（小写）不被识别为主画布（`isMainCanvas` 大小写敏感，与后端 `src/modules/actors.js:255` 的 `'CV-MAIN'` 硬编码口径一致）→ 放行；
2. `applyBatchPlan` **信任传入的计划对象**：手工把守卫码改成 `'OK'` 并塞入 `effects` 的伪造计划仍会产出 DELETE（库层不做二次身份校验）。此二者在真实链路上均不可达（画布 id 来自后端、计划对象由本库 `planBatch` 产出且由视图层持有），故只登记。

### ③「`mode=off/report` 仍重试 / 建 job」——**未能证伪**（两层实测零生成调用）

```bash
node /tmp/w4/rt2-mode-off.mjs     # 见 /tmp/w4/rt2.log
```

**层 1 · 模块层（`src/self-heal.js` `runWithHeal`，假执行器计数）**：

```text
mode=off           改前 calls=1  → 改后 calls=0 attempted=false selfHealSkipped=true
mode=report        改前 calls=1  → 改后 calls=0 attempted=false selfHealSkipped=true
mode=off + opts.allowHeal=true（唯一例外）  calls=1（文档化例外）
mode=off + opts.allowHeal=1（数字）/ "true"（字符串）  calls=0（严格 ===true 才放行）
mode=off + policy.allowWhenDisabled=true   calls=1（文档化例外）；=  "true"（字符串）→ calls=0
对照 auto-free     calls=3（判据仍有判别力）
```

**层 2 · studio 层（真临时库，`FACTORY_DB`/`FACTORY_CONFIG` 指向 `mkdtemp`）**：

```text
studio off    ：calls=0 jobs+0 events+0 to=null artifact.attempted=false  ← 中文原因含「mode=off…不发起任何生成调用」
studio report ：calls=0 jobs+0 events+0 to=null artifact.attempted=false
对照 auto-free：artifact.calls=1 jobs+2 action=hold-human（同造景确实动手）
runStage(off) ：selfHealSkipped=true mode=off jobs+0；阶段停在 awaiting_approval（人工闸门未被替人放行），
                计划 artifact 之后 selfHeal.mode=off/healSkipped=true/calls=0 仍在（未被覆盖）
对抗 force=true 连打 4 次：calls=[0,0,0,0] jobs+0
```

**结论**：主假设③**未能证伪**。mode 判定已前移到「① 首发」之前（`src/self-heal.js:897-911`，首发在 `:925`；唯一判定源 `healModeGate` 在 `:134-156`），调用点两处门控（`src/studio.js:892-910` runStage 短路、`:1724-1726` healVideoStage 门控，跳过结果由 `:1518-1568 modeSkipVideoHeal` 生成并写中文 artifact）。
**残余（R-W4-03，中低）**：`mode` 归一化只认**小写且无空白**的字面值（`src/self-heal.js:94`），`'OFF'`/`' off '`/`0`/`null` 一律**回落 `auto-free`** → 用户把「关掉自愈」误写成 `"Off"` 时，系统会**静默开启自动重试与换后端**（实测 `mode=' off '` → 归一化 `auto-free`、`calls=3`）。方向为 **fail-open**（与本卡「off 必须零生成调用」的安全意图相反）；建议把非字面合法值改为**回落 `off`**（或至少回落 `report`）+ 中文配置告警，并把该口径写进契约。
**上轮遗留未处理**：R-W3-04（`src/self-heal.js:98` `Number(out.tripThreshold) || 默认`）本轮实测 `tripThreshold=-1` → 仍为 `-1`（未夹紧，方向 fail-closed）；不在本轮三张返工卡范围内，继续挂账。

### ④「自检仍改写真实配置」——**终态证伪，跑中复现**（根因未修）

三条独立证据：

1. **终态**：`md5` 跑前跑后相同 + `cmp` 逐字节一致（§2.3）→ 「跑完把用户配置改了」这一可观测后果**不存在**。
2. **跑中**：`/tmp/w4/verify-all.log:437` 守卫点名 **阶段 6/30 画布资产桥** 改写真实配置（`0552a2d7… → cd8edca0…`），`:449` 用快照字节还原；`:3619` 汇总「本轮曾改写并已逐次还原的阶段：6/30」。→ **改写仍然发生，只是被补偿还原**。
3. **单跑复现（本轮独立实验，改前已备份、事后 `cmp` 还原）**：

```bash
cp config/config.json /tmp/w4/g4-real.json
node tests/test-bridge.js            # 「=== 结果：33 通过 / 0 失败 ===」exit=0
md5sum config/config.json            # cd8edca0224e89b41481aba4e8f4409a（跑前 0552a2d7b303f2149ddfbfe9cfd782b1）
diff /tmp/w4/g4-real.json config/config.json
# 18c18
# <     "concurrency": 3,
# ---
# >     "concurrency": 2,
cp /tmp/w4/g4-real.json config/config.json && cmp /tmp/w4/g4-real.json config/config.json
# 已还原（逐字节一致）: 0552a2d7b303f2149ddfbfe9cfd782b1
```

**根因定位**：`tests/test-bridge.js:9-13` 只隔离了 `FACTORY_DATA_DIR`/`FACTORY_DB`/`PORT`，**未设 `FACTORY_CONFIG`**；`:164`/`:173` 通过 `PUT /api/settings`（`src/routes/meta.js:168` → `src/config.js:193 fs.writeFileSync`）写入 `concurrency: 2`。→ **根因不在本轮返工范围（C-004 明确写了「需另开返工卡根除」），仍是任何开发者单跑该测试即触发的真实缺陷。**

**对 C-004 自述的一处纠正（独立核对）**：C-004 声称另有一条改写来源是「阶段 20 `tests/test-publish.js` 把示例地址写进 `image.generic.url` 且未还原」。本轮**未能复现**：`tests/test-publish.js:15` 自设 `process.env.FACTORY_CONFIG = CFG`（mkdtemp），单跑实测 `===== 32 通过 / 0 失败 =====`，`cmp` 显示真实 `config/config.json` **未变**；`verify-all` 守卫日志中也**只有阶段 6 一条**命中记录。→ 该条自述**属过度声明**（阶段 20 已隔离），请勿据此另开返工卡。

---

## 4. 逐项判定表（含文件:行号与复现命令）

| 项 | 判定 | 证据锚点（文件:行号） | 复现命令 |
|---|---|---|---|
| **R-W3-01-02-ac①** 删除类动作缺画布身份一律硬拒（不看 `coversAll`） | **PASS** | `web/lib/canvas-select.js:795-798`（`canvasSource==='none'` → `CANVAS_ID_REQUIRED`） | `node /tmp/w4/rt1-canvas.mjs` → ①A1~A12 |
| **R-W3-01-02-ac②** 选区内**全部**非空 `canvas_id` 参与判定 | **PASS** | `web/lib/canvas-select.js:341-351`（`canvasIdsOf`）、`:555`、`:574-576` | 同上 → ②B1/B3/B4/B6 |
| **R-W3-01-02-ac③** 选区内出现主画布节点即触发保护 | **PASS** | `web/lib/canvas-select.js:805-808`（含 `mainCanvasGuardMixed` 文案 `:183`） | 同上 → ②B1~B4、B6 |
| **R-W3-01-02-ac④** 跨多个非主画布 → 身份不自洽拒绝 | **PASS** | `web/lib/canvas-select.js:810-812`、`BATCH_MESSAGES.canvasIdConflict` | 同上 → ②B5 |
| **R-W3-01-02-ac⑤** 既有 247 条期望零改动 | **PASS** | `tests/canvas-select.test.mjs`（删除行=0、新增 125 行） | `diff tests/canvas-select.test.mjs.bak tests/canvas-select.test.mjs \| grep -c '^<'` → 0 |
| **R-W3-01-02-ac⑥** 套件 ≥247 / 失败 0 / exit 0 | **PASS** | `tests/canvas-select.test.mjs`（680 行） | `node tests/canvas-select.test.mjs; echo $?` → 287/0/0 |
| **R-W3-01-02 新发现 R-W4-01** 有非空节点 id 但缺 `canvasTotal`/`scope` → 主画布整批可删 | **RISK（中低·契约未覆盖）** | `web/lib/canvas-select.js:787-800`（`coversAll` 依赖 `total`/`scope`） | `node /tmp/w4/rt1-canvas.mjs` → ①残余（`affected=3 DELETE=6`；补 `canvasTotal=3` → `MAIN_CANVAS_GUARD`） |
| **R-W3-01-02 新发现 R-W4-02** 调用方谎报 `canvasId` 且节点无 `canvas_id` 对质 → 放行 | **RISK（低·需调用方不诚实）** | `web/lib/canvas-select.js:319-331`（`deriveCanvasId` 信任 ①②） | 同上 → ①残余（`affected=5 DELETE=10`） |
| **R-W3-03-ac①** mode 门控前移到「① 首发」之前 | **PASS** | `src/self-heal.js:897-911`（门控）、`:925`（首发） | `node /tmp/w4/rt2-mode-off.mjs` → 层 1（`calls` 1→0） |
| **R-W3-03-ac②** `off/report` 零生成调用 / 零建 job / 零账本 | **PASS** | `src/self-heal.js:134-156`（`healModeGate`）、`src/studio.js:1724-1726`、`:1518-1568` | 同上 → 层 2（`calls=0 jobs+0 events+0`） |
| **R-W3-03-ac③** 调用点短路（runStage 不调 healVideoStage） | **PASS** | `src/studio.js:892-910` | 同上 → `runStage(off) selfHealSkipped=true jobs+0 status=awaiting_approval` |
| **R-W3-03-ac④** 中文原因与行为一致（含「不发起任何生成调用」） | **PASS** | `src/self-heal.js:140-154`（文案单一源） | 同上 → 中文原因原文 |
| **R-W3-03-ac⑤** 显式允许是唯一例外且严格 `===true` | **PASS** | `src/self-heal.js:137-139`、`:101-102`（`allowWhenDisabled`） | 同上 → 层 1 的 `allowHeal=1/"true"` 均零调用 |
| **R-W3-03-ac⑥** 套件 129→144 且既有全绿 | **PASS** | `tests/test-selfheal.js`（859 行） | `node tests/test-selfheal.js; echo $?` → 144/0/0 |
| **R-W3-03 新发现 R-W4-03** `mode` 非法/大小写/空白变体静默回落 `auto-free`（fail-open） | **RISK（中低）** | `src/self-heal.js:94`（`SELFHEAL_MODES.includes` 严格匹配） | `node /tmp/w4/rt2-mode-off.mjs` → 层 1（`'OFF'`/`' off '`/`0`/`null` → 归一化 `auto-free`、`calls=3`） |
| **R-W3-03 遗留 R-W3-04** `tripThreshold` 负值未夹紧 | **RISK（低·上轮遗留未处理）** | `src/self-heal.js:98` | `node -e "…healPolicy({tripThreshold:-1})…"` → `-1` |
| **C-004-ac①** 跑一次全量自检后 config 逐字节一致 | **PASS（终态）** | `scripts/verify-all.sh:16-51`（阶段级）、`:116-139`（跑后比对+还原）、`:30-39`（EXIT trap） | §2.3（`md5` + `cmp`） |
| **C-004-ac②** 阶段 23 单跑/在跑均不再改写 config | **PASS** | `tests/ui-simulate.py:58-110`（守卫）、`:1489-1523`（暂存/还原）、`:1528/:1565`（3 条守卫断言） | `verify-all` 阶段 23 = **175/0**，日志 `:2463/:2470`「逐字节一致」；**另做单跑独立实验**：`python3 tests/ui-simulate.py http://127.0.0.1:8788` → `=== 结果：175 通过 / 0 失败 ===` exit=0、`cmp` 跑前跑后逐字节一致、结尾断言「脚本收尾时 config/config.json 仍与启动快照逐字节一致」（`/tmp/w4/rt5-sim.log`、`/tmp/w4/rt5-sim-out.log`） |
| **C-004-ac③** 既有断言零删改 | **PASS** | `tests/ui-simulate.py`（删除 3 行 = 注释 2 + 还原调用 1，无断言） | `diff -u tests/ui-simulate.py.bak tests/ui-simulate.py` |
| **C-004-ac④** 门禁语义零变化（守卫不计入失败） | **PASS** | `scripts/verify-all.sh:64`（`config_guard_stage` 在 `run` 尾调用）、`:136`（告警不计入失败门禁） | §2（30/30 通过、`exit=0`，与上轮阶段通过集一致） |
| **C-004 新发现 R-W4-05（根因未修）** 单跑 `tests/test-bridge.js` 仍改写真实 config 且不还原 | **FAIL（治理目标部分达成）** | `tests/test-bridge.js:9-13`（未隔离 `FACTORY_CONFIG`）、`:164`/`:173`（写 `concurrency:2`）→ `src/routes/meta.js:168` → `src/config.js:193` | §3.4 第 3 条（`cd8edca0…`，已 `cmp` 还原） |
| **C-004 自述纠正** 「阶段 20 `test-publish.js` 也改真实配置」不可复现 | **如实记录** | `tests/test-publish.js:15`（自设 `FACTORY_CONFIG`） | `node tests/test-publish.js` → 32/0，`cmp` 一致；守卫日志仅阶段 6 一条命中 |
| 过程项：三条测试真跑 | **PASS** | — | §1（287/144/22，退出码全 0） |
| 过程项：`verify-all.sh` 真跑 + 末 30 行 | **PASS** | — | §2.1（`exit=0`、`✅ 全部自检通过`） |
| 过程项：**断言总数变化** | **2818**（新真实总数，+58） | `/tmp/w4/verify-all.log` | §2.2 逐阶段解析 |
| 过程项：`README.md:11` 台账 | **FAIL（低·文档）** | `README.md:11`（声明 2760，且 23/27/28 位仍是 172/101/222） | `sed -n '11p' README.md` vs §2.2 |
| 过程项：**既有断言被改写 1 条** | **FAIL（低·治理口径，需裁决）** | `tests/test-selfheal.js.bak:457-458` → `tests/test-selfheal.js:461-465` | `diff tests/test-selfheal.js.bak tests/test-selfheal.js`（删除行=2） |
| 过程项：_config.json 跑动中一次性短暂缺失（未复现） | **RISK（低·未复现）** | 观测于 14:08（`md5sum` 报 No such file），3 秒后文件存在且 md5=跑前值 | 见 R-W4-07（§5） |

---

## 5. 风险与残留（验收军师不修，交总军师派卡）

1. **R-W4-01（中低）** `web/lib/canvas-select.js:787-800` —— ①的硬拒只覆盖「完全无凭据」；**只要选区含任一非空 `canvas_id`**，缺 `canvasTotal`/`scope` 时 `coversAll=false`，主画布「禁止删除全部」闸门不触发 → 主画布**全部**节点可被整批删除。**建议**：把主画布保护改为「选区内出现主画布节点时，若调用方未声明 `canvasTotal` 或 `scope`，一律拒绝（fail-closed）」，或强制 `planDelete` 对 `canvasSource!=='none'` 也校验 `total` 是否已知。
2. **R-W4-02（低）** `web/lib/canvas-select.js:319-331` —— `deriveCanvasId` 信任调用方声明的 `opts/params.canvasId`；若调用方谎报一个非主画布 id、而节点自身无 `canvas_id` 可对质，则删除放行。**建议**：声明值与节点非空 `canvas_id` 不一致时拒绝（本轮已对「选区内出现主画布」做了一致性校验，可把同一思路扩到「声明 vs 节点」）。
3. **R-W4-03（中低）** `src/self-heal.js:94` —— `mode` 非法/大小写/空白/非字符串一律回落 `auto-free`（**fail-open**）：用户写 `"Off"`、`" off "`、`0`、`null` 会**静默开启自愈**（实测 `calls=3`）。**建议**：非法值回落 `off`（最安全）或 `report`，并给中文配置告警；契约需明确「非法即最严」。
4. **R-W4-05（中）** `tests/test-bridge.js:9-13`/`:164`/`:173` —— **全量自检对 config 的治理是补偿式的**：跑中仍会改写（阶段 6），仅靠 `scripts/verify-all.sh:16-51` 的快照+还原兜住终态；**任何开发者单跑 `node tests/test-bridge.js` 都会把真实 `config/config.json` 的 `image.concurrency` 从 3 改成 2 且不还原**（本轮已复现并 `cmp` 还原）。**建议**：给 `tests/test-bridge.js` 补 `process.env.FACTORY_CONFIG = <mkdtemp>`（照抄 `tests/test-publish.js:15` 的既有做法），改为「修测试而非改门禁」。
5. **R-W4-06（低·文档）** `README.md:11` 台账 2760 vs 实跑 **2818**（差 +58），且阶段 23/27/28 的分项数字仍是返工前旧值（172/101/222 → 应为 175/144/287）。
6. **R-W4-07（低·未复现）** 14:08 观测到 `config/config.json` 一次性**不存在**（`md5sum` 报 No such file），3 秒后恢复为跑前字节（`0552a2d7…`、4903 B）。本轮**未能复现**：独立单跑 `tests/ui-simulate.py` 期间以 2 秒粒度轮询 **94 次**（覆盖整个阶段 23 运行窗口，`/tmp/w4/poll-config.log`），**0 次缺失**；`verify-all` 守卫日志中也未留下痕迹。已核 `src/config.js:193`（`writeFileSync`，不删除）、`tests/ui-simulate.py:58-110`（`read_bytes`/`write_bytes`，不删除）、`scripts/verify-all.sh:45-51`（`cp` 覆盖，不删除）——**代码路径无法解释**，且单跑阶段 23 可排除阶段 23 本身，指向 `verify-all` 上下文的其它阶段或并发写者。**建议**：下轮开 1 张低优卡，在整跑 `verify-all` 时以 1 秒粒度轮询存在性并对命中时刻抓 `lsof`，确认是否存在「中断即丢配置」的窗口（守卫的 EXIT trap 能兜「已检测到的改写」，但对「文件被删除」只在跑后告警，见 `:139`）。
7. **R-W3-04（低·上轮遗留）** `src/self-heal.js:98` 负 `tripThreshold` 未夹紧（实测 `-1` 生效，方向 fail-closed）；不在本轮返工范围内，继续挂账。
8. **已声明差异（非缺陷）**：`dry-run`/`manual` 不受单轮 tick 配额约束（上轮已声明）；`isMainCanvas` 大小写敏感；`applyBatchPlan` 信任计划对象（同一内存持有者，真实链路不可达）；`modeSkipVideoHeal` 的返回体把 `attempted/calls` 放在 `selfHeal` 块内（顶层无 `attempted`，与「同形」注释略有出入，仅为字段位置差异）。

---

## 6. 复现清单（一条命令一条结论）

```bash
cd /home/linsheng/Desktop/ai-video-factory

# ① 三条测试（结论行 + 退出码）
node tests/canvas-select.test.mjs; echo $?        # 287 通过 / 0 失败 / 0
node tests/test-selfheal.js;      echo $?         # 144 通过 / 0 失败 / 0
LD_LIBRARY_PATH=/home/linsheng/pwlibs/extract/usr/lib/x86_64-linux-gnu python3 tests/ui-smoke.py; echo $?   # 22 通过 / 0 失败 / 0

# ② 全量自检一次（跑前留独立基线，跑后 cmp）
md5sum config/config.json > /tmp/w4/config.md5.before && cp config/config.json /tmp/w4/config.before.json
bash scripts/verify-all.sh; echo $?                # exit=0、末行「✅ 全部自检通过」、30/30、2818 项断言
md5sum config/config.json                          # 0552a2d7b303f2149ddfbfe9cfd782b1（与跑前相同）
cmp /tmp/w4/config.before.json config/config.json  # 逐字节一致
tail -30 /tmp/w4/verify-all.log                    # 见 §2.1 原文

# ③ 红队四条
node /tmp/w4/rt1-canvas.mjs                        # ①② 26/0（A/B：改前 affected=5/10、3/6 → 改后全拒）
node /tmp/w4/rt2-mode-off.mjs                      # ③ 23/0（off/report 零生成调用；auto-free 正向对照）
# ④ 自检对真实 config 的副作用（改前已备份，事后必须 cmp 还原）
cp config/config.json /tmp/w4/g4-real.json
node tests/test-bridge.js; md5sum config/config.json   # cd8edca0… ← 根因仍在（单跑改写真实配置）
cp /tmp/w4/g4-real.json config/config.json && cmp /tmp/w4/g4-real.json config/config.json

# ④ 单跑阶段 23（独立验证 C-004：跑前跑后逐字节一致 + 期间轮询文件存在性）
cp config/config.json /tmp/w4/g5-real.json
LD_LIBRARY_PATH=/home/linsheng/pwlibs/extract/usr/lib/x86_64-linux-gnu python3 tests/ui-simulate.py http://127.0.0.1:8788; echo $?   # 175/0/0
cmp /tmp/w4/g5-real.json config/config.json   # 逐字节一致

# ④ 只读自查
md5sum web/lib/canvas-select.js src/self-heal.js src/studio.js tests/canvas-select.test.mjs tests/test-selfheal.js tests/ui-smoke.py config/config.json
ps -o pid,lstart,etime,cmd -p 2679524              # 复验前后 PID/STARTED 一致（未重启 8788）
```

---

## 7. 红线自查（复验方自身合规）

- **未改任何源码与测试**：复验前后逐项 md5 逐字一致（§8.2），且 `web/views/actors.js`、`web/lib/canvas-perf.js`、`src/schedules.js`、`tests/test-schedules.js`、`tests/ui-smoke.py` 与本轮返工前**逐字未变**（说明返工改动面严格限于声明范围）。
- **写入范围**：只写 `strategist/reports/W4-acceptance.md` 与 `strategist/runs/W4-acceptance.json`；红队脚本/日志全部落 `/tmp/w4/`。
- **未重启 8788**：`ps -eo pid,lstart,etime,cmd | grep "node server.js"` 全程 PID `2679524`，`ETIME` 由复验开始的 `03:28:50` 走到收尾的 `03:45:48`（同进程未重启；`lstart` 秒位因 `ps` 列对齐在 10:31:2x 附近抖动，以 PID + ETIME 为准）。
- **未用真实库做破坏性验证**：红队 ①②③ 全在纯函数/`mkdtemp` 临时库内；红队 ④ 的单跑实验**改前备份、事后 `cmp` 还原**（并已在 §3.4/§5-4 如实披露）。
- **未采信返工方自评**：三份 run 记录的 PASS 声明均被独立重跑替换，并另行纠正其中 1 条过度声明（阶段 20）。
- **未暴露思维链**：本报告只给「命令 + 原始输出 + 判定」。
- **副作用如实记录**：全量自检按设计写 `docs/全模块功能模拟测试报告.md|.json`（阶段 21）与 `data/` 运行产物；本轮对 `config/config.json` 的唯一改动来自红队 ④ 的实验且已还原（`cmp` 逐字节一致）。

---

## 8. 复验前后指纹与进程（可复核）

### 8.1 变更面（本轮返工实际改了哪些文件 —— 验收方自己算）

与 W3 验收时的冻结 md5 对比：

| 文件 | W3 验收 md5 | 本轮复验 md5 | |
|---|---|---|---|
| `web/lib/canvas-select.js` | `6929194c…` | `4182d10170a7ed3acf37228784505c20` | ★变化（R-W3-01-02） |
| `tests/canvas-select.test.mjs` | `f4fccec3…` | `d5a7de95170287b8cff148488b473317` | ★变化 |
| `src/self-heal.js` | `4d8a15ad…` | `bcb7e2383d35c7dfc2bd0b7b74cddde2` | ★变化（R-W3-03） |
| `src/studio.js` | `2e856bda…` | `0b9beb7e7c42a28e219148cb85793476` | ★变化 |
| `tests/test-selfheal.js` | `22339068…` | `6e1dbbedf549155148f3ba68bb0643f1` | ★变化 |
| `tests/ui-simulate.py` | `fd3241cc…` | `53a31c114fd7db249ff5e3d9556bdf89` | ★变化（C-004） |
| `scripts/verify-all.sh` | （`c0ddda84…` = `.bak.c004`） | `dbdfee2ecc610ce8d9417c9341026dc0` | ★变化（纯新增 72 行、删除 0 行） |
| `web/views/actors.js` | `b389cf7c…` | `b389cf7c518b88748e8915d03ce0a5bd` | 未变 |
| `web/lib/canvas-perf.js` | `38516775…` | `385167759e328fe4866b459457c95102` | 未变（冻结指纹保持） |
| `src/schedules.js` | `5cbbba8d…` | `5cbbba8dd6c889b1f63fc8422b8d6df3` | 未变 |
| `tests/test-schedules.js` | `de82ff65…` | `de82ff650754da1b4669c57646155d9a` | 未变 |
| `tests/ui-smoke.py` | `8dc2d44d…` | `8dc2d44dd1bb0ef8b0d85b8fd067be17` | 未变 |
| `config/config.json` | `0552a2d7…` | `0552a2d7b303f2149ddfbfe9cfd782b1` | 未变（复验后已 `cmp` 还原） |

**真实唯一调用点未被改动**：`web/views/actors.js:4861-4866` 仍恒传 `canvasId: S.canvasId` + `canvasTotal: items.length`（`grep -n "canvasTotal\|planBatch(" web/views/actors.js`）→ 本轮画布返工对真实链路**无行为变化**，且 R-W4-01 在真实链路上不可达（`canvasTotal` 恒有值）。

### 8.2 复验收尾只读自查

```text
4182d10170a7ed3acf37228784505c20  web/lib/canvas-select.js
bcb7e2383d35c7dfc2bd0b7b74cddde2  src/self-heal.js
0b9beb7e7c42a28e219148cb85793476  src/studio.js
d5a7de95170287b8cff148488b473317  tests/canvas-select.test.mjs
6e1dbbedf549155148f3ba68bb0643f1  tests/test-selfheal.js
8dc2d44dd1bb0ef8b0d85b8fd067be17  tests/ui-smoke.py
0552a2d7b303f2149ddfbfe9cfd782b1  config/config.json   （= 跑前基线，cmp 逐字节一致）
```

```text
2679524 Tue Sep 29 10:31:20 2026    03:45:48 node server.js   （复验全程同一 PID，未重启 8788）
```

---

## 9. 一句话结论

**三条返工经独立实跑复验：R-W3-01-02 PASS、R-W3-03 PASS、C-004 PASS（终态）/ FAIL（根因未修）；红队 4 条主假设（缺凭据删全部、混合画布绕过、mode=off 仍重试、自检改写配置）全部未被证伪；全量自检 `exit=0`、30/30 通过、断言总数由上轮 2760 变为 **2818**，`config/config.json` 跑前跑后 `md5` + `cmp` 逐字节一致。** 附带条件：① 自检对 config 是**补偿式**治理——跑中阶段 6 仍改写、单跑 `node tests/test-bridge.js` 仍会把用户 `image.concurrency` 3→2 且不还原（R-W4-05，中）；② 画布库层尚有 2 条契约未覆盖的残余臂（R-W4-01/02）；③ `mode` 非法值静默回落 `auto-free`（R-W4-03，fail-open，中低）；④ `tests/test-selfheal.js:461-465` 有 **1 条既有断言期望被改写**（由 `calls===1` 改为 `calls===0`，**方向为变严、有来源注释、非凑绿**，但违反上轮所用的「删除行=0」机械红线，**请总军师裁决是否合规**）；⑤ `README.md:11` 台账（2760）已过期，应为 **2818**。
