# W6 · 上轮验收 4 条 P0 修复与独立复验报告

- 波次：W6（P0 返工与复验）
- 复验时间：2026-09-29 23:34 ~ 2026-09-30 00:05（CST）
- 复验环境：Node v24.18.0、python3 + playwright（chromium-1234）；零 npm 依赖
- 复验结论：**① ② ③ ④ 四项均 PASS**；`bash scripts/verify-all.sh` 退出码 0 且打印 `✅ 全部自检通过`
- 红线遵守：**未启动、未重启、未触碰 `127.0.0.1:8788` 上的任何服务**（复验期间该端口始终无服务，见 §6）
- 数据安全：全程结束时 `config/config.json` 的 **md5 / mtime / 权限位 / 字节数四项与复验前逐项一致**
  （`0552a2d7b303f2149ddfbfe9cfd782b1`｜`2026-09-29 22:29:16.001430573 +0800`｜`664`｜`4903`）

> **关于「改文件前 cp .bak」与本次改动面**：本条 P0 的四项修复代码在**本会话开始时已在盘上**
> （`tests/canvas-audit.py` / `tests/test-actors.js` / `scripts/verify-all.sh` 的 mtime 为 23:20~23:22，
> 且启动时另有一路**同任务的并发进程**正在跑 `verify-all.sh http://127.0.0.1:8799`，产物见 `/tmp/w6-*.log`）。
> 本次复验**没有再改动这四个文件的源码**（避免与并发进程的产物互相覆盖），因此没有产生新的 `.bak`；
> 复验方式是逐条读码 + 真跑取证 + 补充强取证实验，全部原始输出见下文与 `/tmp/v6-*.log`。

---

## ① 画布审计夹具缺失（`canvas-audit.py` 裸跑必崩）—— PASS

**真实所需文件名（读码确认）**：`/tmp/refs/ref1.png`、`ref2.png`、`ref3.png`（共 3 张）
- `tests/canvas-audit.py:38-39`：`REFS_DIR = $AUDIT_REFS_DIR || /tmp/refs`，`REFS = [REFS_DIR/"ref{i}.png" for i in 1..3]`
- 两处上传点：`:1167` 参考图矩阵批量上传（用全部 3 张，断言 `len(refs) == 3`）、`:1191` 资产节点挂参考图（用 `REFS[0]`、`REFS[2]`）

**修复落点**：新增 `tests/make-audit-refs.py`（夹具唯一真源，ffmpeg 优先、缺失时回落标准库 `zlib+struct` 手写 PNG），
并在 `canvas-audit.py:42-58` 由 `_ensure_ref_fixtures()` 在**任何 API 调用之前**导入调用（失败给中文原因并以非 0 退出）。

**裸跑取证（先把夹具目录整个删掉，模拟干净机器）**

```bash
rm -rf /tmp/refs
LD_LIBRARY_PATH=/home/linsheng/pwlibs/extract/usr/lib/x86_64-linux-gnu \
  BASE=http://127.0.0.1:8803 python3 tests/canvas-audit.py     # 日志：/tmp/v6-audit-bare.log
```
- 前两行：`=== 准备审计夹具（参考图）===` → `参考图夹具就绪：/tmp/refs（共 3 张，新生成 3 张（ref1.png, ref2.png, ref3.png））`
- **结论行（第 224 行）**：`=== 审计结果：179 通过 / 0 失败 / 0 提示 ===`，**退出码 0**，全程 **0 次 FileNotFoundError**
- 夹具终态：`ref1.png 2756B / ref2.png 3325B / ref3.png 3300B`，均为合法 640×480 PNG

**补充健壮性取证（防退化为「只是碰巧文件在」）**

| 场景 | 命令要点 | 结果 |
|---|---|---|
| 幂等（重复执行） | `python3 tests/make-audit-refs.py /tmp/refs-idem 3` 连跑两次 | 第二次「新生成 0 张，复用 3 张」，三个文件 **mtime 逐字节不变**（`23:35:37.532989823`） |
| 损坏夹具自愈 | 往 `/tmp/refs/ref2.png` 写 `not-a-png-at-all` 后重跑 | 打印「已存在但不是合法 640×480 PNG，将重新生成」→ 重建为合法 PNG（签名 `\x89PNG`，尺寸 640×480） |
| 无 ffmpeg 回落 | 把 `_gen_with_ffmpeg` 打成恒 False（模拟 ffmpeg 不可用） | 走标准库回落，3 张全部生成成功，尺寸均 640×480（2735/3304/3279 字节） |

**「真·裸跑」额外说明**：不加 `BASE` 时默认 `http://127.0.0.1:8788`，按红线不启动该服务，故该次运行在
**夹具准备成功之后**停在连接层：`参考图夹具就绪：/tmp/refs（共 3 张，复用 3 张）` → `URLError: Connection refused`，
`FileNotFoundError` 计数 **0**（日志 `/tmp/v6-audit-trulybare.log`）。即：**缺陷已从「缺文件崩」变为「仅受服务未启动影响」**。

---

## ② `test-actors.js` 零隔离真写真实配置 —— PASS

**修复落点**：`tests/test-actors.js:13-24`（在 import `src/*` 之前设置三项 env，写法与 `tests/test-publish.js:9-17` 同源，
且按任务要求用 `mkdtemp`）：

```js
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-actors-'));  // :13
process.env.FACTORY_DATA_DIR = DATA_TMP;   // :17
process.env.FACTORY_DB       = DB;         // :18
process.env.FACTORY_CONFIG   = CFG;        // :19  ← src/config.js:8 的 CONFIG_FILE 唯一出口
```

**单跑取证（前后逐项比对）**

| 项 | 跑前 | 跑后 | 结论 |
|---|---|---|---|
| md5 | `0552a2d7b303f2149ddfbfe9cfd782b1` | `0552a2d7b303f2149ddfbfe9cfd782b1` | 未变 |
| mtime | `2026-09-29 22:29:16.001430573 +0800` | `2026-09-29 22:29:16.001430573 +0800` | **未变** |
| 权限位 / 字节数 | `664` / `4903` | `664` / `4903` | 未变 |

`node tests/test-actors.js` → 退出码 **0**，`=== 结果：105 通过 / 0 失败 ===`（日志 `/tmp/v6-actors.log`）。
肇事路径（`PUT /api/settings` → `src/routes/meta.js:168` → `src/config.js:193 saveConfig` → `CONFIG_FILE`）已随隔离落到临时文件。

**补充对照实验（证明「不是写盘被静默跳过」，而是真的写进了隔离文件）**——`/tmp/v6-actors-iso-probe.mjs`：

```
PUT /api/settings 返回 image.concurrency = 3
隔离临时配置存在 = true  路径 = /tmp/v6-actors-probe-*/config.json
隔离临时配置 image.concurrency = 3     ← 写盘确实发生，且落在 FACTORY_CONFIG 指向的文件
真实 config/config.json 跑前 = {"md5":"0552a2d7…","mtime":"…22:29:16.001Z","mode":"664","size":4903}
真实 config/config.json 跑后 = {"md5":"0552a2d7…","mtime":"…22:29:16.001Z","mode":"664","size":4903}
✓ 通过：真实配置 md5/mtime/mode/size 四项均未变（探针退出码 0）
```

---

## ③ `verify-all.sh` 配置守卫：md5 → md5 + mtime 双比对 —— PASS

**修复落点**：`scripts/verify-all.sh:20-100`（跑前 `cp -p` 快照同时保留原始 mtime；`config_drift_kind()` 先判 md5 再判 mtime；
`config_restore()` 用快照字节回写 + `touch -r` 对齐 mtime；`config_guard_stage()` 在每个阶段结束后点名阶段并打印摘要）。
**门禁语义保持不变**：漂移只告警 + 还原，**不因此判红**；仅「还原失败」置 `FAILED=1`。

**单元级验证**（`/tmp/w6-guard-unit-verify.sh`，从**真实文件第 20~100 行原样抽取**守卫代码驱动，沙箱副本，退出码 **0**）：

| 场景 | 断言 | 结果 |
|---|---|---|
| 1 阶段零副作用 | 无告警、drift 为空、FAILED=0 | PASS |
| 2 **同字节重写（仅 mtime 变）** | 被抓到并点名阶段；md5+mtime 双还原到基线；FAILED 仍为 0 | PASS |
| 3 内容真改写（md5 变） | 打印差异摘要（含 `concurrency`）；快照逐字节还原；FAILED 仍为 0 | PASS |
| 4 还原失败（目标只读） | 打印「自动还原失败」+ 手工恢复命令；**FAILED=1** | PASS |

**端到端实证（升级要抓的历史盲区在真实全量自检里当场命中）**——`/tmp/v6-verify-all-full.log`：

```
:2465 【配置守卫】⚠ 阶段「23/30 全模块 UI 模拟（5 个页面，含状态还原校验）」同字节重写了真实配置 config/config.json
      （md5 未变 = 0552a2d7…，但 mtime 变了）
:2469 【配置守卫】↩ 已还原为跑前状态：md5=0552a2d7… mtime=2026-09-29 22:29:16.001430573 +0800
:3626 【配置守卫】✅ 跑前跑后 md5 与 mtime 双一致（逐字节且未被重写），无需还原
```
且该阶段**未使全量自检变红**（全量退出码 0）——正是「告警 + 还原，不因此判红」的既有语义。
（注：阶段 23 的同字节重写是**既有缺陷成因**，按门禁口径需返工该 UI 阶段，本卡不改门禁。）

---

## ④ 矩阵留痕自检与硬约定 —— PASS

**新增** `scripts/check-runs.js`（零依赖、Node≥22 ESM、中文输出）：
读 `strategist/tasks/*.yaml` 的 `task_id`（JSON 语法优先，正则兜底）↔ `strategist/runs/*.json` 的 `task_id`（文件名兜底），
列出缺留痕的卡；退出码 **0 = 齐全**、**1 = 存在缺留痕 / 留痕非法 JSON / 卡解析不出 id**；支持 `--json`、`--quiet`、`--tasks/--runs`。

**真跑取证**

```bash
node scripts/check-runs.js          # 仓库真实数据
```
输出要点：`任务卡：39 张｜留痕：32 份`；**缺留痕 18 张**（C-001、C-005、T-107、T-110、T-201、T-401、T-402、T-501~T-506、T-601~T-604、T-701）；
末尾结论行 `❌ 留痕不齐：18 张卡缺留痕（…）`，**退出码 1**（日志 `/tmp/v6-check-runs.log`）——即「未交付」被如实点出。

| 用例 | 期望 | 实测 |
|---|---|---|
| 2 张卡 / 2 份留痕齐全（临时目录） | 打印「✅ 留痕齐全」+ 退出码 0 | 一致（EXIT=0） |
| 同上删掉 1 份留痕 | 点名缺卡 + 退出码 1 | 一致（EXIT=1） |
| `--json`（缺 1 张） | 机读 `ok:false` + `missing[]` | 一致 |
| 留痕文件损坏（`{oops`） | 解析问题 + 退出码 1 | 一致（EXIT=1） |

**硬约定已写入** `strategist/README.md`：
- `:16-19` 「**每一波智能体在结束前必须把结论写进 `strategist/runs/<task_id>.json`；没有这份文件，无论产出多好，一律视为「未交付」**」
- `:50-65` 用法与退出码口径（并明确 `:64-65`：**本脚本不接入** `verify-all.sh`，治理门禁与代码门禁分开）
- `:74-76` 红线：改既有文件先 `cp xxx.bak`、不得改断言凑绿、**不得重启 8788 上的服务**（自测用临时实例 + `FACTORY_*` 指向 mkdtemp）

---

## 5. 收尾自检真跑结果

| 检查 | 命令 | 结果 |
|---|---|---|
| 语法（改动过的 js） | `node --check tests/test-actors.js`、`node --check scripts/check-runs.js` | 均通过（另 `bash -n scripts/verify-all.sh`、`python3 -m py_compile tests/canvas-audit.py tests/make-audit-refs.py` 通过） |
| 模块1 单跑 | `node tests/test-actors.js` | 退出码 0｜105 通过 / 0 失败 |
| 画布审计裸跑 | 见 §① | 退出码 0｜**179 通过 / 0 失败 / 0 提示** |
| 留痕自检 | `node scripts/check-runs.js` | 退出码 1｜18 张卡缺留痕（如实报告，见 §④） |
| 全量自检（裸跑，无参数） | `bash scripts/verify-all.sh` | **退出码 0** ｜ `✅ 全部自检通过` ｜ **2431 项断言 / 0 失败**（22~25 被跳过，见下） |
| 全量自检（30 阶段全跑） | `bash scripts/verify-all.sh http://127.0.0.1:8803` | **退出码 0** ｜ `✅ 全部自检通过` ｜ **30/30 阶段通过、2828 项断言 / 0 失败** |

裸跑说明：`BASE` 默认 `http://127.0.0.1:8788`，按红线未启动该服务，脚本如实打印
`（跳过前端冒烟：http://127.0.0.1:8788 未启动。可先执行 node server.js）`，因此阶段 22/23/24/25 被跳过
（22 + 175 + 21 + 179 = 397 项断言未计入）。**2431 + 397 = 2828**，与全跑口径自洽。

### 与 README 的断言口径差异（按要求**只报告，不擅自改 README**）

| 口径 | 数值 |
|---|---|
| `README.md:11` / `:238` 文字宣称 | **30 个阶段 / 2760 项断言** |
| `README.md:11` 行内逐阶段数字相加（实测脚本抓取，30 项） | **2693**（README 自身内部就不自洽，差 67） |
| 本次实测（30 阶段全跑，日志 `/tmp/v6-verify-all-full.log`） | **2828**（0 失败） |

逐阶段差异（README → 实测）：`23/30 全模块UI模拟 172 → 175`、`25/30 无限画布审计 177 → 179`、
`26/30 定时排产 116 → 130`、`27/30 阶段失败自愈 101 → 152`、`28/30 画布筛选与多选批处理 222 → 287`。
其余阶段与 README 数字一致。其中 `25/30` 的 179 与上轮 `W5-acceptance.md:160` 记录一致
（`W5-acceptance.md:151` 的 `177 通过 / 2 失败` = 179 项断言中的 2 项失败），可判定 README 的 177 为**修复前的旧口径**。

---

## 6. 残余项 / 需协调者裁决

1. **8788 无服务**：复验全程 `127.0.0.1:8788` 无监听（与 `W5-acceptance.md:496-499` 记录的环境一致）。按红线未启动，
   故「无参数裸跑 `verify-all.sh`」与「无 `BASE` 裸跑审计」只能覆盖非前端阶段。若需 8788 口径的全绿，需由协调者决定是否启动该服务。
2. **`node scripts/check-runs.js` 现为红（退出码 1，18 张卡缺留痕）**：这是治理门禁的**真实结论**，未做任何「补录凑绿」。
   缺留痕卡：C-001、C-005、T-107、T-110、T-201、T-401、T-402、T-501~T-506、T-601~T-604、T-701。
3. **阶段 23 同字节重写真实配置**（`config/config.json` 被以相同字节重写、仅 mtime 变）：门禁已告警并还原，未判红；
   成因属 `tests/ui-simulate.py` 保存出图配置的写盘行为，建议按既有返工流程单独开卡（本卡不改门禁、不改断言）。
4. **`/tmp/refs` 属临时夹具**：会被系统清理，但审计启动即幂等重建（已用「删目录后裸跑」与「损坏后自愈」两种方式验证），无需人工维护。
5. **非本会话遗留的临时实例**：`127.0.0.1:8799`（PID 186399，另一路同任务并发进程所起）复验结束时仍在监听；非本次复验所起，故未处置。
   本次复验自建的 `8803` 实例已关闭（`8788`、`8799` 均未触碰）。
6. **全量自检固有副作用**：第 21 阶段 `scripts/simulate-all.js` 会重写 `docs/全模块功能模拟测试报告.md/.json`
   （README 已声明该行为），本次两轮 `verify-all.sh`（含并发进程那轮）都会刷新这两个文件的 mtime，属门禁自身行为，非卡内改动。
7. **复验辅助脚本落在 `/tmp`**（非仓库文件，按 `write_scope` 原则不擅自入库）：
   `/tmp/w6-guard-unit-verify.sh`（③ 单元验证）、`/tmp/v6-actors-iso-probe.mjs`（② 对照实验）、
   `/tmp/v6-count-assertions.py`（断言总数统计）、日志 `/tmp/v6-*.log`。若需长期回归，请由协调者开卡后移入 `tests/`。

---

## 7. 原始证据清单（可直接复核）

| 文件 | 内容 |
|---|---|
| `/tmp/v6-audit-bare.log` | ① 删掉 `/tmp/refs` 后裸跑审计：夹具重建 + `审计结果：179 通过 / 0 失败 / 0 提示` |
| `/tmp/v6-audit-trulybare.log` | ① 无 `BASE` 真裸跑：夹具 OK、0 次 FileNotFoundError、停在连接层 |
| `/tmp/v6-actors.log` + `/tmp/v6-cfg-before.*` / `/tmp/v6-cfg-after.*` | ② 单跑 105/0 + 真实配置前后 md5/mtime |
| `/tmp/v6-actors-probe.log` | ② 对照实验：临时配置被写入 concurrency=3，真实配置四项不变 |
| `/tmp/v6-guard-unit.log` | ③ 抽取真实守卫代码的 4 场景单元验证（退出码 0） |
| `/tmp/v6-verify-all-bare.log` / `.exit` | 收尾：裸跑全量自检 exit=0、`✅ 全部自检通过`、2431 断言 |
| `/tmp/v6-verify-all-full.log` / `.exit` | 收尾：30 阶段全跑 exit=0、`✅ 全部自检通过`、2828 断言、③ 的 mtime 漂移实锤 |
| `/tmp/v6-check-runs.log` | ④ `check-runs.js` 真实输出（39 卡 / 32 留痕 / 18 缺，退出码 1） |
