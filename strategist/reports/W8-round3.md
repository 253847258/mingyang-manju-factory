# W8 第 3 轮报告 · 阶段 23「同字节重写真实 config」根因返工 + canvas-select 残余两条独立验收 + 复跑取证

- 波次：W8（第 3 轮，单写入者串行执行；上一轮执行者被中断，本卡安全接管其文件）
- 工作目录：`/home/linsheng/Desktop/ai-video-factory`（零依赖 Node ≥22 ESM）
- 环境：Node **v24.18.0**、Python **3.12.3**、Playwright chromium（`LD_LIBRARY_PATH=/home/linsheng/pwlibs/extract/usr/lib/x86_64-linux-gnu`）
- 服务：`http://127.0.0.1:8788`（PID **331961**，`STARTED Tue Sep 29 23:57:58 2026`，本轮结束时 `ELAPSED 04:06:30`）→ **全程未重启、未启动替代服务**
- 红线遵守：未引入 npm 依赖；未重启 8788；**未改 README.md**；未改任何既有测试断言的**期望方向**（阶段 23 的改动是把「写盘 + 还原」换成「零写盘 + 只读取证」，见 §1.4 的诚实披露）；改文件前一律 `cp -p <file> <file>.w8.bak`
- 本轮仓库内写入物（仅 3 个）：`strategist/reports/W8-round3.md`、`strategist/runs/W8-round3.json`、`tests/ui-simulate.py`（+ 备份 `tests/ui-simulate.py.w8.bak`）；其余取证脚本/日志全部落在仓库外 `/tmp/w8/`

---

## 〇、结论速览

| 项 | 结论 | 一句话依据 |
|---|---|---|
| ① 阶段 23 同字节重写真实 config · **根因返工** | **PASS** | 逐阶段漂移扫描（20 个阶段逐个隔离实跑）证明：**唯一**改写真实 config 的阶段是 **23/30**（`tests/ui-simulate.py:1507` 点「保存出图配置」→ `src/routes/meta.js:168` → `src/config.js:193`），修复后单跑阶段 23 = **md5 与 mtime 双一致（零改写）**；`bash scripts/verify-all.sh` 跑后守卫原文「✅ 跑前跑后 md5 与 mtime 双一致（逐字节且未被重写），**无需还原**」 |
| ② canvas-select 残余两条 fail-open（T-110 H5）· **独立验收** | **PASS（两条均未复现 → fail-closed，零改动）** | 独立探针 9 个变体 + 边界补充 7 个变体：㈠ 不传 `canvasId`/`canvasTotal` 且节点 `canvas_id` 为空 → `CANVAS_ID_REQUIRED`，`affected=0`、`DELETE=0`；㈡ 混合画布选区（首项非主画布 + 含主画布节点）→ `MAIN_CANVAS_GUARD`，`affected=0`、`DELETE=0`。**源码与测试零改动**（未追加断言，因为派单口径是「成立才修」） |
| ③ 复跑取证 `bash scripts/verify-all.sh` | **PASS** | **exit=0**、末行 `✅ 全部自检通过`、**30/30 阶段通过**、**合计断言 2863 / 失败 0**、日志 3663 行；与基线口号 30/**2828** 相比：阶段数一致，断言总数 **+35**（逐阶段实测与 README 行内逐值一致，见 §3.3） |
| ③ 附 `node scripts/check-runs.js` | **PASS** | `ok:true, tasks:39, runs:50, missing:[], duplicate_runs:[], problems:[]`，**exit=0**（`failed` 6 张为提示项，非失败） |
| ③ 附 `bash scripts/accept-schedules.sh` | **PASS** | **14 通过 / 0 失败**，exit=0，含「真实 config/config.json 未被本脚本改动（md5 一致）」 |
| 收尾自证 | **PASS** | `python3 -m py_compile tests/ui-simulate.py`、`node --check`（canvas-select.js / canvas-select.test.mjs / check-runs.js）、`bash -n`（verify-all.sh / accept-schedules.sh）全部通过 |

---

## 一、① 阶段 23「同字节重写真实 config」根因返工

### 1.1 先定位：逐阶段「真实 config 是否被改写」隔离扫描（真跑，不是读代码推断）

方法：写探针 `/tmp/w8/sweep.sh`，**逐阶段单独执行** verify-all 里的同一条命令，每阶段跑前 `cp -p` 快照 + 记 md5/mtime，跑后比对并**立即还原到全局基线**，保证每阶段判定互相独立（等价于把 `verify-all.sh` 的每阶段守卫拆开单跑，但能给出全表）。

原始输出（`/tmp/w8/sweep.out` 逐字）：

```text
全局跑前：md5=0552a2d7b303f2149ddfbfe9cfd782b1 mtime=2026-09-29 22:29:16.001430573 +0800
阶段                                         退出码 跑前md5                    跑后md5                    mtime
2/30 test-actors                               0        0552a2d7                     0552a2d7                     零改写  2026-09-29 22:29:16.001430573 +0800
6/30 test-bridge                               0        0552a2d7                     0552a2d7                     零改写  2026-09-29 22:29:16.001430573 +0800
7/30 test-comfy                                0        0552a2d7                     0552a2d7                     零改写  2026-09-29 22:29:16.001430573 +0800
8/30 test-adapters                             0        0552a2d7                     0552a2d7                     零改写  2026-09-29 22:29:16.001430573 +0800
14/30 test-studio                              0        0552a2d7                     0552a2d7                     零改写  2026-09-29 22:29:16.001430573 +0800
20/30 test-publish                             0        0552a2d7                     0552a2d7                     零改写  2026-09-29 22:29:16.001430573 +0800
21/30 simulate-all                             0        0552a2d7                     0552a2d7                     零改写  2026-09-29 22:29:16.001430573 +0800
22/30 ui-smoke                                 0        0552a2d7                     0552a2d7                     零改写  2026-09-29 22:29:16.001430573 +0800
23/30 ui-simulate                              0        0552a2d7                     0552a2d7                     ★同字节重写  2026-09-30 03:40:16.318420913 +0800
24/30 ui-scale                                 0        0552a2d7                     0552a2d7                     零改写  2026-09-29 22:29:16.001430573 +0800
25/30 canvas-audit                             0        0552a2d7                     0552a2d7                     零改写  2026-09-29 22:29:16.001430573 +0800
1/30 selfcheck                                 0        0552a2d7                     0552a2d7                     零改写  2026-09-29 22:29:16.001430573 +0800
3/30 test-novel                                0        0552a2d7                     0552a2d7                     零改写  2026-09-29 22:29:16.001430573 +0800
4/30 test-script                               0        0552a2d7                     0552a2d7                     零改写  2026-09-29 22:29:16.001430573 +0800
5/30 test-render                               0        0552a2d7                     0552a2d7                     零改写  2026-09-29 22:29:16.001430573 +0800
26/30 test-schedules                           0        0552a2d7                     0552a2d7                     零改写  2026-09-29 22:29:16.001430573 +0800
27/30 test-selfheal                            0        0552a2d7                     0552a2d7                     零改写  2026-09-29 22:29:16.001430573 +0800
28/30 canvas-select                            0        0552a2d7                     0552a2d7                     零改写  2026-09-29 22:29:16.001430573 +0800
29/30 subtitle-wrap                            0        0552a2d7                     0552a2d7                     零改写  2026-09-29 22:29:16.001430573 +0800
30/30 canvas-perf                              0        0552a2d7                     0552a2d7                     零改写  2026-09-29 22:29:16.001430573 +0800
扫描结束；最终 md5=0552a2d7b303f2149ddfbfe9cfd782b1 mtime=2026-09-29 22:29:16.001430573 +0800（应为全局基线）
```

**结论：20 个疑点阶段里，只有 `23/30 tests/ui-simulate.py` 造成漂移，且是「同字节重写」（md5 未变、mtime 前移）。**
全部 Node 套件（含候选中点名的 `tests/test-bridge.js`、`tests/test-publish.js`）**均为零改写**——它们已在 W4/W5 返工中完成 `FACTORY_CONFIG` 环境隔离，且隔离赋值**都排在 `import '../src/*'` 之前**（逐文件核对 `process.env.FACTORY_CONFIG` 行号 vs 首个 `src/` import 行号：test-actors 19<25、test-bridge 20<22、test-comfy 15<18、test-adapters 16<19、test-studio 15<25、test-publish 15<19、test-guard 14<18、test-deliver 15<19、test-dub 16<19、test-timeline 18<28、test-graph 23<25、test-mcp 27<29、test-qc 15<19、test-stats 13<17、test-selfheal 18<21、test-subtitle-wrap 23<27、test-schedules 21<33、test-scale 13<17、test-jobs 12<16、canvas-select 32、simulate-all 36<114）。不设 `FACTORY_CONFIG` 的 `selfcheck.js / test-novel.js / test-render.js / test-script.js` **根本不调用 `saveConfig`**（`grep -rn saveConfig src/ tests/ scripts/` 逐条核对），故无需隔离。

### 1.2 真正写盘的文件与行号（根因链）

| # | 落点 | 行为 |
|---|---|---|
| 1 | `tests/ui-simulate.py:1507`（原文） | `img_card.locator("button", has_text="保存出图配置").first.click()` —— 阶段 23 通过浏览器点设置页保存按钮 |
| 2 | `web/views/settings.js:219` | 按钮回调 `api.put('/api/settings', { image: form })` |
| 3 | `src/routes/meta.js:168` | `saveConfig(patch)`（`grep` 实测行号确为 168） |
| 4 | `src/config.js:193` | `fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8')` —— **写盘，mtime 必然前移** |
| 5 | `tests/ui-simulate.py:1505`（原文） | 点保存前把表单后端切回「本地占位出图」，但表单里的通用 HTTP URL 仍是向导填入的示例 → 先写出**不同字节**（md5 变化） |
| 6 | `tests/ui-simulate.py:1515`（原文） | `api("/api/settings", "PUT", {"image": _img_stash})` —— 用暂存值写回 → **md5 回到原值、mtime 又前移一次** |
| 7 | `tests/ui-simulate.py:1525`（原文，`config_guard`） | 只比 md5 → 「逐字节一致」判 PASS（**对同字节重写完全失明**），随后 `scripts/verify-all.sh:78-97` 的阶段守卫发现 mtime 漂移 → 告警 + `touch -r` 还原（**补偿式治理**） |

> 关键辨别：`FACTORY_CONFIG` 隔离写法对阶段 23 **无效**——8788 是**已在运行**的服务进程（PID 331961，无 `FACTORY_CONFIG` 环境变量，实测 `/proc/331961/environ` 无该键），`src/config.js:8` 的 `CONFIG_FILE` 在**服务进程启动时**就已固定为真实 `config/config.json`；测试进程里再设 `FACTORY_CONFIG` 只会让守卫读错文件、丧失监督作用（与 W7 §3.4 一致）。

### 1.3 最小复现（隔离在临时实例上，全程未碰真实 config）

```bash
cp -p config/config.json /tmp/w8/repro/config.json                     # 真实配置副本
FACTORY_CONFIG=/tmp/w8/repro/config.json FACTORY_DB=/tmp/w8/repro/factory.db \
  FACTORY_DATA_DIR=/tmp/w8/repro/data FACTORY_SCHEDULER=off PORT=8833 node server.js &
IMG=$(curl -s http://127.0.0.1:8833/api/settings | python3 -c "import sys,json;print(json.dumps({'image':json.load(sys.stdin)['settings']['image']}))")
curl -s -X PUT -H 'content-type: application/json' -d "$IMG" http://127.0.0.1:8833/api/settings -o /dev/null -w 'put=%{http_code}\n'
```

原始输出（逐字）：

```text
health=200
--- 步骤1：原样 PUT 回服务端当前 image 段（同字节重写） ---
跑前 md5=0552a2d7b303f2149ddfbfe9cfd782b1 mtime=2026-09-29 22:29:16.001430573 +0800
put=200
跑后 md5=0552a2d7b303f2149ddfbfe9cfd782b1 mtime=2026-09-30 03:39:35.085079047 +0800
```

即：**同一份内容原样写回，md5 一模一样、mtime 前移** —— 这就是「同字节重写」的最小可复现形态（写盘动作真实存在，只是内容恰好相同）。探针实例用后即关（`/proc/<pid>/environ` 匹配 `FACTORY_CONFIG=/tmp/w8/repro/config.json` 后 kill，`curl` 复查返回 `000`）。

### 1.4 返工内容（唯一被改的仓库文件：`tests/ui-simulate.py`，改前已 `cp -p` 备份为 `.w8.bak`）

改动方向：**删掉写盘动作本身**（根因），并把守卫从「只比字节」升级为「md5 + mtime 双比对」。

| 位置 | 改前 | 改后 |
|---|---|---|
| `tests/ui-simulate.py:1507` | 点「保存出图配置」→ 真实写盘 | **不再点击**；改为只读取证：`sel.select_option(占位后端)`（纯表单态）+ `GET /api/settings` 比对 `image.backend` / `image.generic.url` 是否仍是进入本步骤前的值 |
| 原 `:1513-1521`（API 写回还原） | `PUT /api/settings {image: _img_stash}` 写回原值 | **整段删除**（已无写盘，无需还原） |
| 原 `:1488-1501`（磁盘暂存） | 从磁盘读 image 段做暂存 | 删除（不再需要补偿） |
| `config_snapshot()` / 新增 `config_mtime_now()` / 新增 `config_write_evidence(tag)` | 只返回 `(bytes, md5)` | 返回 `(bytes, md5, mtime_ns)`；新增「零写盘」取证函数，输出 `md5+mtime 双一致（零写盘）` / `md5 一致但 mtime 前移（★同字节重写）` / `★内容被改写（md5 变化）` 三种中文判定 |
| `:1528` 与收尾 `:1565` 两条断言 | 「与启动快照**逐字节**一致」（md5 单口径） | 「与启动快照 **md5+mtime 双一致（零写盘）**」——**判据变严**（新增 mtime 维度），期望方向未放宽 |
| 脚本 docstring / 注释 | 描述「保存会写盘 → 暂存还原」的补偿流程 | 改为「不点保存、零写盘、md5+mtime 双基线」 |

**诚实披露（两点，供上位裁决）**：

1. 这两条既有断言的**文案与依据**被改写（「已还原」→「零写盘」），因为其指向的写盘动作已不存在——按机械口径这属于「改既有断言」，但它**不是凑绿**：改动前两条断言本就是 ✓（脚本自评 175/0），改动后判据只增不减（多一条 mtime 约束）。
2. **覆盖取舍**：本步骤不再覆盖「浏览器点保存按钮 → 服务端写盘」这一条真实链路。该链路（`PUT /api/settings` → `saveConfig` → `fs.writeFileSync`）仍由**已做环境隔离**的 API 级测试覆盖：阶段 2 `tests/test-actors.js:392`、阶段 6 `tests/test-bridge.js:172/181`、阶段 9/17/19 等直接调用 `saveConfig` 的套件。阶段 23 仍保留「保存按钮存在性」（`:1450`）与「curl 向导解析回填」（`:1477`/`:1484`）断言。
   （W7 建议的「让 UI 阶段自带临时实例」是更彻底的结构性方案，但那要改 `scripts/verify-all.sh` 的门禁结构与阶段语义，超出本卡写入范围，未做。）

### 1.5 修复后取证（跑前 / 跑后 md5 + mtime 双取证）

**（a）单跑阶段 23（`/tmp/w8/drift-probe.sh`，原始输出逐字）**

```text
=== 探针阶段：23/30 ui-simulate（W8 修复后）
跑前 md5=0552a2d7b303f2149ddfbfe9cfd782b1
跑前 mtime=2026-09-29 22:29:16.001430573 +0800
命令退出码=0 耗时=161s 输出尾部：   ! 503 探测文案未在本轮触发 …
跑后 md5=0552a2d7b303f2149ddfbfe9cfd782b1
跑后 mtime=2026-09-29 22:29:16.001430573 +0800
判定：零改写（md5 与 mtime 双一致）
探针已还原：md5=0552a2d7b303f2149ddfbfe9cfd782b1 mtime=2026-09-29 22:29:16.001430573 +0800
```

该次真跑的断言结果：**`=== 结果：175 通过 / 0 失败 ===`**（与改前同为 175，**断言数未变**）；新增/变更后的守卫行原文：

```text
  配置基线：/home/linsheng/Desktop/ai-video-factory/config/config.json md5=0552a2d7…（4903 字节） mtime=1790692156001430573
  ✓ curl 向导回填未污染正式配置（服务端出图后端与通用 URL 仍是进入本步骤前的值）
  ✓ 设置页段落结束后 config/config.json 与启动快照 md5+mtime 双一致（零写盘；md5 0552a2d7…）
  ✓ 脚本收尾时 config/config.json 仍与启动快照 md5+mtime 双一致（零写盘；md5 0552a2d7…）
=== 结果：175 通过 / 0 失败 ===
```

**（b）`bash scripts/verify-all.sh` 全量跑（唯一一次）**

跑前独立基线（本卡自己取的，不引用脚本输出）：

```text
=== 跑前（W8 独立基线，2026-09-30 03:49:14 +0800）===
0552a2d7b303f2149ddfbfe9cfd782b1  config/config.json
mtime=2026-09-29 22:29:16.001430573 +0800 size=4903 inode=532135
```

跑后独立比对（`/tmp/w8/final/config.after.txt`）：

```text
=== 跑后（2026-09-30 04:04:15 +0800）===
0552a2d7b303f2149ddfbfe9cfd782b1  config/config.json
mtime=2026-09-29 22:29:16.001430573 +0800 size=4903 inode=532135
--- cmp 逐字节 ---
cmp: 逐字节一致（exit=0）
```

`verify-all.sh` 自带守卫的原文（日志 3658-3663 行）：

```text
【配置守卫】跑后比对：md5=0552a2d7b303f2149ddfbfe9cfd782b1（跑前 0552a2d7b303f2149ddfbfe9cfd782b1）
【配置守卫】跑后 mtime：2026-09-29 22:29:16.001430573 +0800（跑前 2026-09-29 22:29:16.001430573 +0800）
【配置守卫】✅ 跑前跑后 md5 与 mtime 双一致（逐字节且未被重写），无需还原

✅ 全部自检通过
verify-all exit=0
```

**判读：md5 与 mtime 都不变；`inode` 也未变（532135）= 文件从未被重写；且全日志中「阶段守卫命中」类告警（`⚠ 阶段「…」改写了/同字节重写了真实配置`）与「本轮曾改写并已逐次还原的阶段」**一次都没有出现** → 治理方式已由「补偿式还原」变为「零改写」。`scripts/verify-all.sh` 的门禁逻辑**一行未改**（文件 mtime 仍是 2026-09-29 23:21，`bash -n` 通过；本轮没有任何门禁被放宽——是测试侧不再写盘，而不是门禁不再检查）。

---

## 二、② canvas-select 残余两条 fail-open（T-110 H5）独立验收

### 2.1 复现方法（独立探针，不复用 `tests/canvas-select.test.mjs` 的任何断言）

探针 `/tmp/w8/h5-probe.mjs`、`/tmp/w8/h5-probe2.mjs`：纯函数直调 `planBatch` / `applyBatchPlan`，**同时**统计 `effects` 里的真实 DELETE 请求数与「落地（confirm 后）」DELETE 数。判据照 T-110 H5 原文：「两条都返回拒绝码（`CANVAS_ID_REQUIRED` 或主画布保护），`effects` 为空、DELETE 请求数 = 0」。

### 2.2 ㈠ 不传 `canvasId`、不传 `canvasTotal` 且节点 `canvas_id` 为空 → 整画布删除

原始输出（逐字，4 个变体）：

```text
㈠-1 节点 canvas_id 全空 + scope=all，不传 canvasId/canvasTotal：
    code=CANVAS_ID_REQUIRED ok=false canvasId="" canvasSource=none mainCanvas=false selectionCanvasIds=[] 
    selectionHasMainCanvas=false affected=0 effects=0 DELETE=0 落地后DELETE=0
    判定：拒绝（fail-closed）
㈠-2 节点 canvas_id 全空 + 不传 scope（默认 selection）：
    code=CANVAS_ID_REQUIRED ok=false canvasSource=none affected=0 effects=0 DELETE=0 落地后DELETE=0
    判定：拒绝（fail-closed）
㈠-3 首项幽灵卡位 + 4 项 canvas_id 全空 + scope=all：
    code=CANVAS_ID_REQUIRED ok=false affected=0 effects=0 DELETE=0 落地后DELETE=0
    判定：拒绝（fail-closed）
㈠-4 purge 模式 + 节点 canvas_id 全空 + scope=all：
    code=CANVAS_ID_REQUIRED ok=false affected=0 effects=0 DELETE=0 落地后DELETE=0
    判定：拒绝（fail-closed）
```

中文原因（`㈠-1` 原文）：`未提供画布 ID，无法确认是否为主画布，已拒绝整画布批量删除：请传 canvasId（或 canvasTotal）后重试。`

**判定：未复现（fail-closed）。** 命中判据 `web/lib/canvas-select.js:806-809`（`canvasSource === 'none'` → 硬拒，不看 `coversAll`）。

### 2.3 ㈡ 混合画布选区（首项非主画布 + 含主画布节点）→ 绕过主画布保护

原始输出（逐字，4 个变体 + 1 个反向护栏）：

```text
㈡-1 混合选区（首项 CV-2 + 2×CV-MAIN）+ scope=all，不传 canvasId：
    code=MAIN_CANVAS_GUARD ok=false canvasId="CV-2" canvasSource=items mainCanvas=false
    selectionCanvasIds=["CV-2","CV-MAIN"] selectionHasMainCanvas=true affected=0 effects=0 DELETE=0 落地后DELETE=0
    判定：拒绝（fail-closed）
㈡-2 混合选区 + 谎报 canvasId=CV-2 + scope=all：
    code=MAIN_CANVAS_GUARD ok=false canvasSource=opts selectionHasMainCanvas=true affected=0 DELETE=0 落地后DELETE=0
㈡-3 混合选区 + 谎报 canvasId=CV-2 + canvasTotal=3（自证整画布）：
    code=MAIN_CANVAS_GUARD ok=false affected=0 effects=0 DELETE=0 落地后DELETE=0
㈡-4 混合选区 + 谎报 canvasId=CV-2 + canvasTotal=99（伪称局部）：
    code=MAIN_CANVAS_GUARD ok=false affected=0 effects=0 DELETE=0 落地后DELETE=0
㈡-5 反向护栏：主画布节点在首位（对照，应为 MAIN_CANVAS_GUARD）：
    code=MAIN_CANVAS_GUARD ok=false canvasId="CV-MAIN" canvasSource=items mainCanvas=true affected=0 DELETE=0
```

中文原因含可审计判据（`㈡-1` 原文节选）：`（本次判据：选区内出现主画布（CV-MAIN）节点，但自证/声明的画布是「CV-2」；选区内出现的画布：CV-2、CV-MAIN）`

**判定：未复现（fail-closed）。** 命中判据 `web/lib/canvas-select.js:821-824`（`selectionHasMainCanvas && !mainCanvas` → `MAIN_CANVAS_GUARD`）。

### 2.4 补充边界变体（7 条，进一步证伪「仍有残余臂」）

```text
拒绝（fail-closed）  ㈢-1 空白污染的主画布 id（" CV-MAIN "）    code=MAIN_CANVAS_GUARD  DELETE=0 落地DELETE=0
拒绝（fail-closed）  ㈢-2 小写 cv-main（非主画布口径）          code=CANVAS_ID_CONFLICT DELETE=0 落地DELETE=0
拒绝（fail-closed）  ㈢-3 canvas_id 为 null（非空字符串）        code=CANVAS_ID_REQUIRED DELETE=0 落地DELETE=0
拒绝（fail-closed）  ㈢-4 全幽灵卡位 + 不传 canvasId/canvasTotal code=CANVAS_ID_REQUIRED DELETE=0 落地DELETE=0
拒绝（fail-closed）  ㈢-5 混合：幽灵首项 + 主画布节点            code=MAIN_CANVAS_GUARD  DELETE=0 落地DELETE=0
拒绝（fail-closed）  ㈢-6 主画布节点 + 不传 canvasId（自证）      code=MAIN_CANVAS_GUARD  DELETE=0 落地DELETE=0
放行（按设计）      ㈢-7 谎报 CV-2 + allItems 只给 2 项 → 计划 NEED_CONFIRM（plan DELETE=0），确认后落地 DELETE=4
```

㈢-7 的「放行」**不是 fail-open**：选区本身就是 **CV-2（非主画布）** 的全部 2 个节点，节点自证 `canvas_id=CV-2` 与声明一致，主画布保护不适用（H5 判据只管主画布）。已如实列出以免被误读为「未复现即通过」。

**② 最终判定：PASS（两条残余均未复现；`web/lib/canvas-select.js` 与 `tests/canvas-select.test.mjs` 本轮 md5 未变：`7fa9827a03eb3c6679ecb9432330c7cb` / `a1cb37665e1f86dbce379a28305b3aa1`，mtime 仍为 W7 的 03:24 / 03:25）。** 按派单口径「成立才修、不成立就写未复现及尝试过的输入」，本轮**不追加断言**（避免为已 fail-closed 的路径堆叠重复断言）。

---

## 三、③ 复跑取证

### 3.1 `bash scripts/verify-all.sh`（本轮唯一一次全量）

```bash
{ bash scripts/verify-all.sh; echo "verify-all exit=$?"; } > /tmp/w8/final/verify-all.log 2>&1
```

| 项 | 实测 | 基线（派单给定） | 判定 |
|---|---|---|---|
| 退出码 | **0** | 0 | 一致 |
| 末行 | **`✅ 全部自检通过`** | 同 | 一致 |
| 阶段数 | **30**（30/30 全部「：通过」，失败 0） | 30 | 一致 |
| 真实断言总数 | **2863**（失败合计 0） | 2828 | **不一致：+35**（只报告，未改 README） |
| 日志规模 | 3663 行 | ~3622（W4 期） | — |
| config 守卫 | `✅ md5 与 mtime 双一致…无需还原`，**零阶段命中** | 期望 | **改善（补偿式 → 零改写）** |

逐阶段实测（`node /tmp/w7/parse-stages.mjs /tmp/w8/final/verify-all.log`，与 W4/W7 同一解析器口径）：

```text
阶段数=30 合计断言=2863 失败合计=0 无计数行的阶段=[]
1/30  23 | 2/30 105 | 3/30  45 | 4/30  74 | 5/30  71 | 6/30  33 | 7/30  63 | 8/30  82 | 9/30  37 | 10/30 30
11/30 47 | 12/30 284 | 13/30 199 | 14/30 148 | 15/30 173 | 16/30 24 | 17/30 74 | 18/30 47 | 19/30 32 | 20/30 32
21/30 83 | 22/30 22 | 23/30 175 | 24/30 21 | 25/30 179 | 26/30 130 | 27/30 162 | 28/30 312 | 29/30 67 | 30/30 89
（逐阶段 verdict 全为 PASS，failed=0）
```

### 3.2 派单点名的两个附加门禁

```bash
$ node scripts/check-runs.js --json --quiet ; echo "EXIT=$?"
{"ok":true,"tasks":39,"runs":50,"missing":[],"orphan":[A-01,C-02,D-01,R-W3-01-02-canvas-safety,R-W3-03-selfheal-mode,
 R-W4-canvas-audit-rework,T-403,W2-B,W3-acceptance,W4-acceptance,W4-rework-dev],
 "failed":[C-001,C-005,T-601,T-602,T-603,T-604],"duplicate_runs":[],"problems":[]}
EXIT=0
$ node scripts/check-runs.js | tail -3
✅ 留痕齐全：39 张任务卡全部有 strategist/runs/<task_id>.json      （exit=0）

$ bash scripts/accept-schedules.sh | tail -4 ; echo "EXIT=$?"
  ✓ 真实 config/config.json 未被本脚本改动（md5 一致）

=== 结果：14 通过 / 0 失败 ===
✅ 排产 + 自愈验收通过（临时实例已关闭、临时数据已清理）
EXIT=0
```

**`check-runs` exit=0（缺留痕 0 张）**；`accept-schedules` **14/14 通过**，与派单预期一致。

### 3.3 与基线 30/2828 不一致的差异定位（只报告，按要求不改 README）

- `README.md:11` **表头**声明「**30 个阶段 / 2828 项断言**」，但该行**逐阶段数字相加 = 2863**（脚本核算：解析到 30 个条目，`行内相加 = 2863`）——即该行**自身不自洽，差 35**。
- 本轮实测 **30 阶段 / 2863 断言**，且**逐阶段 30 个数字与 README 行内 30 个数字逐值完全一致**（23/105/45/74/71/33/63/82/37/30/47/284/199/148/173/24/74/47/32/32/83/22/175/21/179/130/162/312/67/89）。
- 结论：**过期的只是表头的 2828**，行内明细其实已是当前真值；正确总数应为 **2863**。`README.md:238` 的 `（30 个阶段，2828 项断言）` 同理过期。
- 按派单「不一致只报告，不改 README」处理；本卡**未修改 README.md**（其 mtime 仍为 2026-09-30 03:31，即用户回写时刻）。

---

## 四、收尾自证（全部真跑）

```text
=== 本轮改动文件指纹 ===
-rw------- tests/ui-simulate.py        98879  2026-09-30 03:41   ← 唯一被改的仓库源文件
-rw------- tests/ui-simulate.py.w8.bak 97149  2026-09-29 13:25   ← 改前备份（md5 53a31c114fd7db249ff5e3d9556bdf89）
（未改动的对照：README.md 03:31 / web/lib/canvas-select.js 03:24 / tests/canvas-select.test.mjs 03:25 / scripts/verify-all.sh 23:21）

=== 语法门禁 ===
node --check web/lib/canvas-select.js      → OK
node --check tests/canvas-select.test.mjs  → OK
node --check scripts/check-runs.js         → OK
bash -n scripts/verify-all.sh              → OK
bash -n scripts/accept-schedules.sh        → OK
python3 -m py_compile tests/ui-simulate.py → OK（本轮唯一改动文件；仓库内无 js/sh 被改）

=== diff 规模（tests/ui-simulate.py）===
diff tests/ui-simulate.py.w8.bak tests/ui-simulate.py | grep -c '^<'  → 48（删除行）
diff tests/ui-simulate.py.w8.bak tests/ui-simulate.py | grep -c '^>'  → 72（新增行，多为中文根因注释与 mtime 取证函数）
```

---

## 五、未解决项 / 残余风险（如实）

1. **README 表头计数仍过期（低·文档）**：`README.md:11` 与 `:238` 的 **2828** 应为 **2863**（行内相加与实测均 2863）。按派单要求只报告、未改（用户已声明 README 由他回写）。
2. **`W7-round1-2.md` 未收尾（中·留痕）**：该报告正文残留 **5 处未替换占位符** —— `{{SELFHEAL_AFTER}}`(:153)、`{{CANVAS_AFTER}}`(:154)、`{{TOTAL_AFTER}}`(:155)、`{{FINAL_VERIFY_TABLE}}`(:200)、`{{VERIFY_TAIL}}`(:243)，且 §四/§六 为空的模板；这正是「上一轮执行者被中断」的残留。本卡按派单只写入 `W8-round3.md`，**未改 W7 报告**（避免覆盖他人留痕）；建议由总军师决定是否指派收尾该 5 处占位符。
3. **阶段 23 覆盖取舍（中·测试覆盖）**：设置页「保存按钮 → 服务端写盘」的**浏览器**链路不再被 UI 阶段覆盖（API 层仍覆盖，见 §1.4-2）。若上位要求保留该链路又要求零改写，唯一正解是 W7 §3.4 建议 2「UI 阶段自带临时实例」——属门禁结构调整，本卡未做。
4. **两个写盘级根因未动（低·设计）**：`src/config.js:193` 的 `fs.writeFileSync` 无条件写、`src/config.js:8` 的 `CONFIG_FILE` 启动期固定，使「同字节重写」这一**整类**副作用对任何驱动**已在运行**的服务进程的测试都成立。可选的根因级加固（`saveConfig` 在 `JSON.stringify` 结果与现有文件字节相同时跳过写盘）**修不了本 case**（向导会先写出**不同**字节再写回），且改的是公共写盘路径 / 需重启服务才生效，故本轮**未改生产代码**，如实记录。
5. **H5 判据的剩余理论盲区（低·契约）**：库层无法识别「调用方声明的 `canvasId` 与真实画布一致、但选区节点**全部**是幽灵卡位（无节点行）且 `canvasTotal` 未传」这一形态——实测该形态返回 `CANVAS_ID_REQUIRED`（㈢-4），已 fail-closed；仅当调用方同时补全 `canvasId` 与自洽的 `canvasTotal` 时才会放行，属「调用方已给出可自证凭据」的正常路径。
6. **`check-runs` 的 6 张 `ok:false`（低·治理）**：`C-001、C-005、T-601~T-604` 仍为提示项（门禁 exit=0 不受影响），与 W7 报告一致，需上位裁决「补产物 / 销卡」。

---

## 六、复现清单（一条命令一条结论）

```bash
cd /home/linsheng/Desktop/ai-video-factory

# 1) ① 逐阶段定位「谁在改真实 config」（约 13 分钟，含 3 个 Playwright 阶段；每阶段自带还原）
bash /tmp/w8/sweep.sh && cat /tmp/w8/sweep.out      # 仅 23/30 为「★同字节重写」，其余 19 个阶段「零改写」

# 2) ① 修复后单跑阶段 23：必须「零改写」且 175 通过 / 0 失败
bash /tmp/w8/drift-probe.sh "23/30 ui-simulate" env LD_LIBRARY_PATH=/home/linsheng/pwlibs/extract/usr/lib/x86_64-linux-gnu \
  python3 tests/ui-simulate.py http://127.0.0.1:8788

# 3) ① 全量：必须 exit=0 且守卫「✅ md5 与 mtime 双一致…无需还原」、零阶段命中
{ bash scripts/verify-all.sh; echo "verify-all exit=$?"; } > /tmp/w8/final/verify-all.log 2>&1
grep '配置守卫' /tmp/w8/final/verify-all.log
node /tmp/w7/parse-stages.mjs /tmp/w8/final/verify-all.log | head -1     # 阶段数=30 合计断言=2863 失败合计=0

# 4) ② H5 两条残余 fail-open 独立复现：必须全部「拒绝（fail-closed）」且 DELETE=0
node /tmp/w8/h5-probe.mjs     # ㈠ 4 变体 → CANVAS_ID_REQUIRED；㈡ 4 变体 → MAIN_CANVAS_GUARD
node /tmp/w8/h5-probe2.mjs    # 边界 7 变体 → 6 拒绝 + 1 按设计放行（非主画布 CV-2）

# 5) ③ 附加门禁
node scripts/check-runs.js --json --quiet ; echo "EXIT=$?"     # ok:true / missing:[] / exit=0
bash scripts/accept-schedules.sh | tail -4 ; echo "EXIT=$?"     # 14 通过 / 0 失败 / exit=0

# 6) 收尾
python3 -m py_compile tests/ui-simulate.py && node --check web/lib/canvas-select.js && bash -n scripts/verify-all.sh
md5sum config/config.json ; stat -c '%y %s %i' config/config.json   # 0552a2d7… / 2026-09-29 22:29:16.001430573 / 4903 / 532135
```

---

## 七、本次取证产物索引（仓库外，防误认为交付物）

| 路径 | 内容 |
|---|---|
| `/tmp/w8/sweep.sh`、`/tmp/w8/sweep.out`、`/tmp/w8/sweep-*.log` | ① 逐阶段漂移扫描脚本 / 结论表 / 每阶段完整日志 |
| `/tmp/w8/drift-probe.sh`、`/tmp/w8/stage23-after.out`、`/tmp/w8/stage23-after-full.log` | ① 单阶段漂移探针与「修复后」阶段 23 完整日志（175/0） |
| `/tmp/w8/h5-probe.mjs`、`h5-probe.out`、`h5-probe2.mjs`、`h5-probe2.out` | ② H5 两条残余 + 边界变体的独立探针与原始输出 |
| `/tmp/w8/final/verify-all.log`、`config.before.json/.txt`、`config.after.txt`、`stages.txt` | ③ 全量自检日志（3663 行）、跑前跑后独立基线、逐阶段解析 |
| `/tmp/w8/repro/` | ① 最小复现的临时实例（`FACTORY_CONFIG` 指向临时副本，用后已关闭） |
