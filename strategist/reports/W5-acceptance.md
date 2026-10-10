# W5 验收报告 · 被中断返工波次的真实状态复验（只读复验）

> **角色**：验收军师（只读复验；除本文件外未修改任何源码 / 测试 / 配置）
> **工作目录**：`/home/linsheng/Desktop/ai-video-factory`
> **复验时间**：2026-09-29 21:53 ~ 22:4x（本地）
> **复验对象**：被中断返工波次疑似改动的 4 个文件
> `tests/test-bridge.js`、`src/self-heal.js`、`tests/test-selfheal.js`、`tests/canvas-audit.py`
> **真跑方式**：全部为真跑（非静态推断），原始日志落在 `/tmp/w5/*.log`，本报告逐条抄录原文

---

## §0 结论摘要（先给判定）

| # | 复验项 | 判定 | 关键证据 |
|---|---|---|---|
| 1 | 4 文件语法 / 可编译 | **PASS** | `node --check` × 3 与 `py_compile` × 1 全部 exit=0（§1） |
| 2 | `test-bridge.js` 不再改写真实配置 | **PASS** | 跑前跑后 md5 逐字节一致 `0552a2d7…82b1`（§2） |
| 3 | `test-selfheal.js` | **PASS** | `152 通过 / 0 失败`，exit=0（§3） |
| 4 | `canvas-audit.py` 无 IndexError | **PASS** | 便签章节 6 条断言全 ✓；`179 通过 / 0 失败 / 0 提示`，exit=0（§4） |
| 5 | `canvas-audit.py` 在**干净机器**上可跑 | **FAIL（环境前置缺失，非本次返工引入）** | 无 `/tmp/refs` 时 `:1138` FileNotFoundError，整个审计中断在总结之前（§4.1、§6-④） |
| 6 | `scripts/verify-all.sh` 全量自检 | **PASS（30/30，exit=0）** | 第 2 次真跑：30 个阶段全「通过」、`✅ 全部自检通过`（§5） |
| 7 | 配置守卫（全量自检零改写真实配置） | **PASS** | 两次真跑均「跑前跑后逐字节一致，无需还原」（§5） |
| 8 | 红队证伪 ①：单跑 test-bridge 仍改写真实配置 | **证伪（不成立）** | §6-① |
| 9 | 红队证伪 ②：audit 仍抛 IndexError | **证伪（不成立）** | §6-② |
| 10 | 红队证伪 ③：`mode='OFF'/'0'/null` 仍开启自愈 | **证伪（不成立）** | §6-③ |
| 11 | 被中断波次的记录留痕 | **FAIL（治理缺口）** | `strategist/runs/` 无 R-W4-03 / R-W4-05 结论文件，无任何 `F-0*.json`（§7） |
| 12 | 红队证伪 ⑤：同类缺陷是否只修了一个文件 | **FAIL（同类未修尽）** | `tests/test-actors.js:383` 同样真写真实配置且**零隔离零守卫**，实测改 mtime（§6-⑤） |
| 13 | 「零改写」口径的严密性 | **需修正口径** | md5 一致 ≠ 无写盘：阶段 23 按设计真写真实配置再逐字节还原，**mtime 会变**，md5 门禁看不见（§5.3） |

**一句话判定：代码与测试的实际状态是「改到位、真跑全绿」，可以交付；但交付物之外的治理留痕（R-W4-03 / R-W4-05 运行结论）与审计脚本的 `/tmp/refs` 外部夹具前置缺失两项应当补齐 —— 前者影响可追溯性，后者会让任何干净机器上的 `verify-all` 阶段 25 直接判红。另须登记两项「同源未修尽 / 口径不严密」：`tests/test-actors.js` 仍在无隔离地真写真实配置（今天因值恰好相同而不可见），且现有 md5 级门禁发现不了「同字节重写」。**

---

## §1 语法 / 可编译性（步骤 1）

```console
$ for f in tests/test-bridge.js src/self-heal.js tests/test-selfheal.js; do node --check "$f"; echo "$f exit=$?"; done
tests/test-bridge.js exit=0
src/self-heal.js exit=0
tests/test-selfheal.js exit=0
$ LD_LIBRARY_PATH=/home/linsheng/pwlibs/extract/usr/lib/x86_64-linux-gnu python3 -m py_compile tests/canvas-audit.py
canvas-audit.py compile exit=0
```

**判定：PASS** — 4 个文件全部 exit=0，无语法 / 编译期错误。

---

## §2 配置基线 + `test-bridge.js` 隔离真跑（步骤 2）

### 2.1 两次 md5（原文）

```console
=== md5 BEFORE test-bridge ===
0552a2d7b303f2149ddfbfe9cfd782b1  config/config.json
=== running test-bridge ===
=== 结果：33 通过 / 0 失败 ===
TEST_BRIDGE_EXIT=0
=== md5 AFTER test-bridge ===
0552a2d7b303f2149ddfbfe9cfd782b1  config/config.json
```

| 项 | 值 |
|---|---|
| 跑前 md5 | `0552a2d7b303f2149ddfbfe9cfd782b1`（4903 字节） |
| 跑后 md5 | `0552a2d7b303f2149ddfbfe9cfd782b1` |
| **是否一致** | **一致（逐字节相同）** |
| 测试结果 | `33 通过 / 0 失败`，exit=0 |

### 2.2 隔离机制与「非空洞通过」证明

- `tests/test-bridge.js:20` → `process.env.FACTORY_CONFIG = CFG;`（`CFG` = `os.tmpdir()/factory-bridge-config-<ts>.json`）
- 位置正确：该赋值在 `:22` 起的**动态 import**（`await import('../src/config.js')`）**之前**，而 `CONFIG_FILE` 是模块加载期常量，因此重定向生效。实测机制：

```console
$ node --input-type=module -e "process.env.FACTORY_CONFIG='/tmp/w5/probe-config.json'; const m = await import('./src/config.js'); console.log(m.CONFIG_FILE);"
CONFIG_FILE with FACTORY_CONFIG set = /tmp/w5/probe-config.json
$ node --input-type=module -e "const m = await import('./src/config.js'); console.log(m.CONFIG_FILE);"
CONFIG_FILE without env (default)     = /home/linsheng/Desktop/ai-video-factory/config/config.json
```

- **非空洞（判别力）证明**：本测试确实会走「写配置」路径 —— `tests/test-bridge.js:172` 与 `:181` 两次 `PUT /api/settings`，载荷里显式带 `concurrency: 2`（真实配置为 3）。若无隔离，`/api/settings` → `src/config.js` 的 `saveConfig` → `fs.writeFileSync(CONFIG_FILE)` 会把真实配置的 `image.concurrency` 由 3 改成 2。跑后 `:179`「关闭 useCanvasRefs 后不再使用画布参考图」为 ✓，说明该 PUT **确实落库生效**（写进了临时配置），而真实 `config/config.json` 的 md5 分毫未动 —— 证明重定向真实生效，而非「测试没触发写路径」的空洞通过。
- 收尾清理：`tests/test-bridge.js:203-204` 删除临时库 / 临时数据目录 / 临时配置文件（真实配置全程零触碰）。

**判定：PASS**（真实配置零改写，且证据非空洞）。

---

## §3 `test-selfheal.js` 真跑（步骤 3）

```console
$ node tests/test-selfheal.js
...
=== 结果：152 通过 / 0 失败 ===
TEST_SELFHEAL_EXIT=0
```

- **原文结论行：`=== 结果：152 通过 / 0 失败 ===`，exit=0。**
- 新增章节落在 `tests/test-selfheal.js:849`（`---------- 12.6 mode 归一化（W4 验收 R-W4-03 修复）`）与 `:855` 的打印头，即 `【12.6】mode 归一化（R-W4-03）`。该章节关键输出（原文摘录）：

```
【12.6】mode 归一化（R-W4-03）：大小写/空白归一 + 假值视为 off（不再静默回落 auto-free）
  ✓ 归一化·大小写与空白归一、0/false/null/空串视为 off（不再静默回落 auto-free），未提供才回落默认 auto-free  19 组字面值全部符合
  ✓ 门控·归一化后的 off 走「零生成调用」分支：blocked=true / allowed=false / mode=off，decideHeal 一律 stop 且不换后端
  ✓ 归一化·runWithHeal 真跑 mode="OFF"：归一回 off → **零生成调用**（旧实现 calls=3，静默开启自愈）  calls=0 mode=off
  ✓ 归一化·判别力对照：mode=" AUTO-FREE " 归一回 auto-free，同一造景下照样动手（≥1 次生成调用）  calls=3 policyMode=auto-free
```

- 计数演进核对：`R-W3-03-selfheal-mode.json` 记录当时为 144；同波次 `13:30` 备份为 W4 返工版；当前 `152`，增量即 `【12.6】` 的 8 条新增断言。

**判定：PASS**（152/0，且判别力对照存在，不是「全绿因为没测」）。

---

## §4 `canvas-audit.py` 真跑（步骤 4）

### 4.1 按派单原样真跑（无外部夹具）

```console
$ LD_LIBRARY_PATH=/home/linsheng/pwlibs/extract/usr/lib/x86_64-linux-gnu python3 tests/canvas-audit.py
...
  ✓ 可新建便签节点（含内容与颜色）
  ✓ 便签节点落在画布可见区内（可定位屏幕坐标）      ← 新增的显式可见性断言
  ✓ 点击便签可选中（不再被当成缩放手柄）
  ✓ 便签可复制到剪贴板
  ✓ 便签可粘贴（新增一张）
  ✓ 粘贴后的便签仍在可见区内（拖拽前置条件）
  ✓ 便签可拖动并落库
...
[cleanup] 已还原审计前画布（12 卡位 / 1 分组 / 0 连线）
FileNotFoundError: [Errno 2] No such file or directory: '/tmp/refs/ref1.png'
AUDIT_EXIT=1
```

- **`IndexError` 已消失**：`tests/canvas-audit.py:957` 的旧写法 `note_scr = visible_items("note")[0]` 已被 `first_visible(...)`（`:980`）取代；便签章节 7 条断言**全部 ✓**，审计继续向后执行（不再中断）。
- **但整体仍 exit=1**：失败于 `tests/canvas-audit.py:1138`
  `page.locator("input[data-role=\"ref-matrix\"]").set_input_files([f"/tmp/refs/ref{i}.png" for i in range(1, 4)])`
  堆栈首行：`FileNotFoundError: [Errno 2] No such file or directory: '/tmp/refs/ref1.png'`
  （`playwright/_impl/_set_input_files_helpers.py:148 item_stat = os.stat(item)`）
- 该文件另在 `:1162` 硬编码 `/tmp/refs/ref1.png`、`/tmp/refs/ref3.png`。
- **全仓库无任何脚本创建 `/tmp/refs`**（`grep -rn "refs/ref" tests/*.py scripts/*.sh` 只命中 `canvas-audit.py:1138/:1162` 自身），用法注释（`:1-12`）也未声明该前置。属**历史遗留的隐式环境前置**：上一波（W4）能跑通是因为该目录当时已被手工建出；本次机器上 `/tmp/refs` 不存在，故 stage 25 直接判红。
- 中断点发生在打印 `=== 审计结果 ===` 总结**之前**，因此干净机器上 stage 25 连通过/失败计数都拿不到 —— 属「失败得响但信息不全」。

### 4.2 补齐夹具后真跑（隔离假设的排除实验）

为把「脚本缺陷」与「我的隔离环境缺素材」区分开，做了对照实验：

**[实验 A]** 仅补 `/tmp/refs/ref{1,2,3}.png`（我在 `/tmp` 用 PIL 生成 640×480 占位图，未写入仓库）：

```console
=== 审计结果：177 通过 / 2 失败 / 0 提示 ===
   ✗ >50% → LOD 全 且图片开始解码   lod=2 loaded=0 drawn=10
   ✗ 全流程无 JS 错误   [error] Failed to load resource: the server responded with a status of 404 (Not Found); ×3
AUDIT_EXIT=1
```

**[实验 B]** 再把真实 `data/images`、`data/thumbs`、`data/uploads` 复制进隔离 `FACTORY_DATA_DIR` 后重跑：

```console
=== 审计结果：179 通过 / 0 失败 / 0 提示 ===
截图目录：/tmp/canvas-audit
[cleanup] 已还原审计前画布（12 卡位 / 1 分组 / 0 连线）
AUDIT_EXIT=0
```

**结论**：实验 A 的 2 条失败是**我自己的隔离环境缺图片素材**导致（DB 副本里引用的图片文件不在隔离 `DATA_DIR` → 前端 404 → `imgLoaded=0`），与被复验的 4 个文件无关。素材补齐后 **`179 通过 / 0 失败 / 0 提示`、exit=0**，与 W4 记录（`R-W4-canvas-audit-rework.json`：179/0/exit=0）逐数吻合。

**判定：IndexError 修复 PASS；脚本在干净机器上的可跑性 FAIL（前置缺失，未修）。**

---

## §5 `scripts/verify-all.sh` 全量自检真跑（步骤 5）· 跑了两次

### 5.1 第 1 次（环境原样：无 `/tmp/refs`）

```console
VERIFY_ALL_EXIT=1
```

最后 25 行原始输出：

```
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
  · 实测：200 卡位 0.0089 ms/次，1000 卡位 0.0410 ms/次（visibleItems + cullStats 合计均值，100 次）
  ✓ 预算：200 卡位单次 visibleItems + cullStats 合计 ≤ 1 ms
  ✓ 预算：1000 卡位单次 visibleItems + cullStats 合计 ≤ 5 ms

=== 结果：89 通过 / 0 失败 ===
── 30/30 画布性能（视口裁剪/LOD 分级/批量几何/单帧预算与 z 序稳定）：通过
【配置守卫】跑后比对：md5=0552a2d7b303f2149ddfbfe9cfd782b1（跑前 0552a2d7b303f2149ddfbfe9cfd782b1）
【配置守卫】✅ 跑前跑后逐字节一致，无需还原

❌ 存在失败项，请查看上方输出
```

- **唯一失败阶段（原文）**：`── 25/30 无限画布功能一致性审计（http://127.0.0.1:8788）：失败(exit=1)`（日志 `:2691`），成因即 §4.1 的 `/tmp/refs` 缺失。
- 其余 29 个阶段全「通过」（含阶段 6 `33/0`、阶段 27 `152/0`）。
- **配置 md5 对比**：

| 项 | md5 |
|---|---|
| 跑前基线（第 2 步同一基线） | `0552a2d7b303f2149ddfbfe9cfd782b1` |
| 跑后 | `0552a2d7b303f2149ddfbfe9cfd782b1` |
| **是否一致** | **一致**；且逐阶段守卫（`scripts/verify-all.sh:43` `config_guard_stage`）全程 **0 次命中**（日志中不存在任何「⚠ 阶段…改写了真实配置」行）→ 说明连「改写后还原」的补偿动作都没被触发 |

### 5.2 第 2 次（补齐 `/tmp/refs` 后）

```console
VERIFY_ALL_2_EXIT=0
```

最后 25 行原始输出（节选尾部）：

```
  ✓ 200 卡位 zoom=0.35：drawn=60 / LOD=1
  ...
  ✓ 收益口径：高缩放区可见数严格小于低缩放区（1x 时 20 < 0.05x 时 200）

[14] M6 纯函数预算（实测值仅作证据，断言只对预算上界）
  · 实测：200 卡位 0.0090 ms/次，1000 卡位 0.0357 ms/次（visibleItems + cullStats 合计均值，100 次）
  ✓ 预算：200 卡位单次 visibleItems + cullStats 合计 ≤ 1 ms
  ✓ 预算：1000 卡位单次 visibleItems + cullStats 合计 ≤ 5 ms

=== 结果：89 通过 / 0 失败 ===
── 30/30 画布性能（视口裁剪/LOD 分级/批量几何/单帧预算与 z 序稳定）：通过
【配置守卫】跑后比对：md5=0552a2d7b303f2149ddfbfe9cfd782b1（跑前 0552a2d7b303f2149ddfbfe9cfd782b1）
【配置守卫】✅ 跑前跑后逐字节一致，无需还原

✅ 全部自检通过
```

**30 个阶段逐条结果（全「通过」）**：

| 阶段 | 结果 | 阶段 | 结果 |
|---|---|---|---|
| 1/30 引擎自检 | 通过 | 16/30 规模压测 | 通过 |
| 2/30 模块1 演员矩阵 | 通过 | 17/30 交付包 | 通过 |
| 3/30 模块2 小说工坊 | 通过 | 18/30 成片质检 | 通过 |
| 4/30 模块3 剧本工厂 | 通过 | 19/30 配音链路 | 通过 |
| 5/30 模块4 制作台 | 通过 | 20/30 出海物料 | 通过 |
| 6/30 画布资产桥（**33/0**） | 通过 | 21/30 全模块端到端模拟 | 通过 |
| 7/30 ComfyUI H3 引擎 | 通过 | 22/30 前端冒烟 | 通过 |
| 8/30 厂商协议适配器 | 通过 | 23/30 全模块 UI 模拟 | 通过 |
| 9/30 生产守护 | 通过 | 24/30 满配前端 | 通过 |
| 10/30 生产看板 | 通过 | 25/30 画布一致性审计（**179/0/0**） | 通过 |
| 11/30 任务队列与取消 | 通过 | 26/30 定时排产 | 通过 |
| 12/30 Agent 接口与审核闸门 | 通过 | 27/30 阶段失败自愈（**152/0**） | 通过 |
| 13/30 画布 DAG 引擎 | 通过 | 28/30 画布筛选与多选 | 通过 |
| 14/30 自动化制片 Agent | 通过 | 29/30 字幕智能断行 | 通过 |
| 15/30 时间线·多轨·音频 | 通过 | 30/30 画布性能（**89/0**） | 通过 |

- 第 2 次跑后 md5：`0552a2d7b303f2149ddfbfe9cfd782b1`（与基线一致）。

**判定：PASS（30/30，exit=0；配置零改写）**。第 1 次 exit=1 的**全部**成因就是 stage 25 的 `/tmp/refs` 前置缺失。

### 5.3 「配置零改写」的精确口径（重要修正：md5 一致 ≠ 没有写盘）

复验收尾时发现 `config/config.json` 的 **mtime 被改写**（`2026-09-29 14:52` → `22:23:39`），而 **md5 自始至终是 `0552a2d7…82b1`**。也就是说：**内容零差异成立，但「没有任何写盘动作」并不成立**，而 `scripts/verify-all.sh:43` 的逐阶段门禁与 `:119-140` 的跑后比对**只比 md5**，对「同字节重写」完全不可见。

机制已定位（写盘方按设计真写真实文件）：

- `tests/ui-simulate.py:23-24` 自述：设置页「保存出图配置」会**真实写盘**（前端 → `PUT /api/settings` → `saveConfig` → `fs.writeFileSync(config/config.json)`），因此该步骤「保存前暂存 image 配置、结束后按暂存值还原」；`src/config.js:189-196` 的 `saveConfig` 是 `mergeDeep` 后 `JSON.stringify(next, null, 2)` **整文件覆盖写**。
- run2 日志原文（阶段 23）：
  `· 出图配置暂存源：磁盘 config/config.json（还原后 image 段回到步骤前原值）`
  `✓ 设置页段落结束后 config/config.json 与启动快照逐字节一致（md5 0552a2d7…）`
  `✓ 脚本收尾时 config/config.json 仍与启动快照逐字节一致（md5 0552a2d7…）`
- 另有一个**零守卫**的写盘方（`tests/test-actors.js:383`，阶段 2），见 §6-⑤ —— 它每次真跑都会重写真实配置。

**口径修正**：本报告 §2、§5 的「零改写」严格含义是**字节级内容一致（md5 相同）**，这是现有门禁能保证的强度，也是本轮复验实测到的强度；但它**不排除**真实文件被重写（mtime 已证明被重写）。若要达到「全程零触碰」的强口径，需把 md5 门禁升级为「mtime+inode+md5」或干脆把 §6-⑤ 的零守卫写盘方按 test-bridge 的方式隔离掉。

---

## §6 红队证伪（步骤 6）

### ① 「单跑 test-bridge.js 仍改写真实配置」→ **证伪（不成立）**

复现命令：

```bash
md5sum config/config.json
node tests/test-bridge.js; echo "exit=$?"
md5sum config/config.json
```

实测：跑前 `0552a2d7b303f2149ddfbfe9cfd782b1` → 跑后 `0552a2d7b303f2149ddfbfe9cfd782b1`，**一致**；测试自身 `33 通过 / 0 失败` exit=0。
机制核对：`tests/test-bridge.js:20` 在动态 import 之前设 `FACTORY_CONFIG`；`config.js` 实测被重定向到 `/tmp/...json`；且该测试确有一次 `concurrency:2` 的真实写配置调用（`:172`、`:181`）→ 隔离非空洞。**红队断言不成立。**

### ② 「audit 仍抛 IndexError」→ **证伪（不成立）**

复现命令：

```bash
grep -n 'visible_items([^)]*)\s*\[0\]' tests/canvas-audit.py     # 只应命中注释，无代码命中
LD_LIBRARY_PATH=/home/linsheng/pwlibs/extract/usr/lib/x86_64-linux-gnu python3 tests/canvas-audit.py
```

实测：`grep` 仅命中 `:173`、`:977` 两处**注释**，无任何代码级 `visible_items(...)[0]`；`first_visible`（`:171-182`）取不到时显式判红并返回 `None`，调用方（`:981`）把 4 条交互断言逐条判红而非跳过。真跑中便签章节 7 条断言全 ✓，`IndexError` **未出现**。**红队断言不成立。**
（注：审计整体 exit=1 的原因是另一件事 —— 见 ④。）

### ③ 「self-heal 的 mode='OFF'/'0'/null 仍会开启自愈」→ **证伪（不成立）**

复现命令（直接 import，未改任何代码）：

```bash
node --input-type=module -e "
import { normalizeHealMode, healModeGate } from './src/self-heal.js';
for (const c of ['OFF',' off ','0',0,null,false,'',undefined,'AUTO-FREE','report','FALSE','no','关闭'])
  console.log(JSON.stringify(c), '=>', normalizeHealMode(c), '| allowed=', healModeGate({mode:c}).allowed);
"
```

实测输出（原文）：

```
"OFF" => normalize= off | gate.allowed= false blocked= true mode= off
" off " => normalize= off | gate.allowed= false blocked= true mode= off
"0" => normalize= off | gate.allowed= false blocked= true mode= off
0 => normalize= off | gate.allowed= false blocked= true mode= off
null => normalize= off | gate.allowed= false blocked= true mode= off
false => normalize= off | gate.allowed= false blocked= true mode= off
"" => normalize= off | gate.allowed= false blocked= true mode= off
undefined => normalize= auto-free | gate.allowed= true blocked= false mode= auto-free
"AUTO-FREE" => normalize= auto-free | gate.allowed= true blocked= false mode= auto-free
"report" => normalize= report | gate.allowed= false blocked= true mode= report
"FALSE" => normalize= off | ...
"no" => normalize= off | ...
"关闭" => normalize= off | ...
```

端到端真跑 `runWithHeal`（假执行器计数，同造景）：

```
"OFF" => calls= 0 policyMode= off attempted= false healed= false
" off " => calls= 0 policyMode= off attempted= false healed= false
0 => calls= 0 policyMode= off attempted= false healed= false
null => calls= 0 policyMode= off attempted= false healed= false
false => calls= 0 policyMode= off attempted= false healed= false
"" => calls= 0 policyMode= off attempted= false healed= false
"auto-free" => calls= 3 policyMode= auto-free attempted= undefined healed= true   ← 判别力对照
```

- 实现位置：`src/self-heal.js:112`（`normalizeHealMode`）、`:91`（`HEAL_MODE_OFF_ALIASES`）、`:127`（`healPolicy` 接入归一）、`:171`（`healModeGate` fail-closed）。
- **唯一「开启」的输入是 `undefined`（键不存在）**，即「未提供 → 落默认 `auto-free`」，这是**既有口径的显式保留**（代码注释已声明），不是「假值静默开启」。**红队断言不成立。**
- 附带核对生产配置：真实 `config/config.json` 的 `video` 段**不存在 `selfHeal` 键**（`'selfHeal' in c['video'] == False`）→ 走 `undefined` → `auto-free`，**与改前行为完全一致，无生产行为翻转**。仅当运维**显式**写入 `null`/`0`/`'OFF'` 时才变为 `off`（fail-closed，符合卡片意图）。

### ④ 【新发现·未被修复】`tests/canvas-audit.py` 依赖无人创建的外部夹具 `/tmp/refs`

```bash
rm -rf /tmp/refs
LD_LIBRARY_PATH=/home/linsheng/pwlibs/extract/usr/lib/x86_64-linux-gnu python3 tests/canvas-audit.py; echo "exit=$?"
# → FileNotFoundError: [Errno 2] No such file or directory: '/tmp/refs/ref1.png'（tests/canvas-audit.py:1138），exit=1
```

- 位置：`tests/canvas-audit.py:1138`、`:1162` 硬编码 `/tmp/refs/ref{1,2,3}.png`；仓库内**无任何脚本创建该目录**，文件头用法注释也未声明。
- 影响：任何干净机器 / 新 CI 容器上，`verify-all.sh` 阶段 25 必定判红（且中断在总结行之前，拿不到通过计数），**看起来像代码回归，实际是环境前置缺失**。
- 该脆弱点与本次返工修掉的 `IndexError`（`:957`）是**两个不同的缺陷**，被中断的那一波**没有**修它。
- 复现/取证命令与结论已如 §4.1、§5.1。

### ⑤ 【新发现·同类未修尽】`tests/test-actors.js` 仍在无隔离地真写真实配置

派单要求「补 `FACTORY_CONFIG` 隔离」的目标只落在 `tests/test-bridge.js`，但**同一缺陷类在姊妹文件里原样存在**：

```bash
# 复现（等价于 verify-all 阶段 2 单跑）
stat -c '%y' config/config.json; md5sum config/config.json
node tests/test-actors.js; echo "exit=$?"      # 105 通过 / 0 失败
stat -c '%y' config/config.json; md5sum config/config.json
```

实测（原文）：

```
=== BEFORE ===
0552a2d7b303f2149ddfbfe9cfd782b1  config/config.json
2026-09-29 22:23:39.187969599 +0800  mtime
=== running ONLY test-actors.js ===
=== 结果：105 通过 / 0 失败 ===
=== AFTER ===
0552a2d7b303f2149ddfbfe9cfd782b1  config/config.json
2026-09-29 22:29:16.001430573 +0800  mtime      ← 被重写了（md5 未变）
```

- 证据链：`tests/test-actors.js:7-13` 只隔离了 `FACTORY_DATA_DIR` / `FACTORY_DB` / `PORT` / `HOST`，**全文 `FACTORY_CONFIG` 出现 0 次**（`grep -c FACTORY_CONFIG tests/test-actors.js` → `0`）；`tests/test-actors.js:383` → `put('/api/settings', { image: { concurrency: 3, backend: 'placeholder' } })` → `saveConfig`（`src/config.js:189-196`）→ `fs.writeFileSync` **整文件覆盖真实 `config/config.json`**。
- **为何至今没被发现**：真实配置当前恰为 `image.concurrency = 3`、`image.backend = 'placeholder'`（实测），重写后**字节完全相同** → md5 不变 → `verify-all` 的 md5 级门禁与「✅ 逐字节一致」结论**都不可能报警**。只有看 mtime 才能发现。
- **风险模型（这是真风险，不是洁癖）**：`saveConfig` 是 `mergeDeep(loadConfig(), patch)` 后整文件覆盖。一旦运维把 `image.concurrency` 调成 2（**历史事故 RK-L6-06 / R-W3-05 正是 concurrency 被 3↔2 来回改**）或把 `image.backend` 切到非 placeholder，则**单跑一次 `node tests/test-actors.js`（或 `verify-all` 阶段 2）就会把它们静默改回 3 / placeholder** —— 与 R-W4-05 要根治的 test-bridge 缺陷**完全同类同源**，只是当前值撞巧相同而处于「休眠」状态。
- 同类写盘方盘点（供返工时一次修尽）：

| 文件 | 是否写真实 `config/config.json` | 隔离/守卫 | 判定 |
|---|---|---|---|
| `tests/test-bridge.js:20` | 已不写（`FACTORY_CONFIG` 重定向） | ✅ 完全隔离 | 本轮已修 |
| `scripts/simulate-all.js:36` | 否 | ✅ 完全隔离 | 合格 |
| `tests/ui-simulate.py:58-110` | **是（按设计真写）** | ⚠️ 有声明 + 字节级守卫还原 | 可接受但依赖补偿 |
| `tests/test-actors.js:383` | **是（无任何声明）** | ❌ **零隔离、零守卫** | **同类未修尽（本报告新增）** |

**建议**：按 `tests/test-bridge.js:20` 的写法给 `tests/test-actors.js` 补 `FACTORY_CONFIG`（一行，import `src/config.js` 之前赋值），并把它登记为 R-W4-05 的**姊妹返工项**；同时把 `verify-all.sh` 的配置门禁从「只比 md5」升级为「md5 + mtime」，否则此类同字节重写永远是盲区。

---

## §7 被中断波次「只改了部分内容 / 引入回归」核对（步骤 7 要求项）

### 7.1 改了什么（以现存 `.bak` 为对照组，逐 hunk 核对）

| 文件 | mtime | 对照备份 | 改动范围核对 |
|---|---|---|---|
| `src/self-heal.js` | 14:27 | `src/self-heal.js.w4rework.bak`（13:28） | **仅 1 个 hunk，+39/−2**，全部是 `HEAL_MODE_OFF_ALIASES` + `normalizeHealMode` + `healPolicy` 一行接入。无其它逻辑被动过 |
| `tests/test-selfheal.js` | 14:28 | `tests/test-selfheal.js.w4rework.bak`（13:30） | **仅 1 个 hunk（`:849` 起追加 +63 行）**，经 `diff \| grep '^-'` 验证**纯增量、0 行既有断言被删改**（`NONE (purely additive)`）→ 无「放宽既有期望」情况 |
| `tests/test-bridge.js` | 14:27 | `tests/test-bridge.js.bak`（09-26，较旧） | 仅 2 个 hunk：`:10-18` 隔离块、`:200+` 收尾清理。无其它改动 |
| `tests/canvas-audit.py` | 14:29 | `tests/canvas-audit.py.bak`（00:25） | 4 个 hunk：`:109`（pre_state 增 `layout_mode/layout_groupBy`）、`:168`（新增 `first_visible`）、`:973`（便签块改为带 None 守卫，断言文案逐条保留 + 新增 1 条可见性断言）、`:1590`（收尾按原布局模式还原） |

**结论：4 个文件的改动都收敛在各自卡片目标内，无越界、无顺手夹带；`test-selfheal.js` 与 `canvas-audit.py` 的既有断言零删改零放宽。**

### 7.2 是否引入回归 → **未发现**

- `verify-all.sh` **30/30 通过、exit=0**（§5.2）覆盖了这 4 个文件的全部调用面。
- `test-selfheal.js` 既有 144 条断言在新实现下全绿（现 152/0），`test-bridge.js` 33/0。
- 生产配置无行为翻转（`video.selfHeal` 键不存在 → `auto-free` 不变，§6-③）。

### 7.2.1 但是：该波次**只修了同类缺陷中的一个文件**（未修尽）

派单把 `FACTORY_CONFIG` 隔离的目标只写给了 `tests/test-bridge.js`，返工波次就**只改了这一个文件**，同一缺陷类在 `tests/test-actors.js:383` **原样留存**（零隔离、零守卫、真写真实配置，实测改 mtime，见 §6-⑤）。因此：

- **不能**把「配置隔离」记为已收口 —— 准确的写法是「test-bridge 这一个入口已收口，test-actors 同类入口仍敞着（当前因值相同而休眠）」。
- 另需注意 §5.3 的口径问题：现有 md5 级门禁连「同字节重写」都发现不了，所以「配置守卫全绿」并不等于「没有任何写盘」。
- 这属于**「部分完成」而非「回归」**：`verify-all` 30/30 通过是真实的，缺陷是覆盖面上的漏项，不是新引入的破坏。

### 7.3 留痕缺口（治理层面，非代码缺陷）

- `strategist/runs/` 内**只有** `R-W4-canvas-audit-rework.json`（14:37），**没有** R-W4-03（self-heal mode 归一化）与 R-W4-05（test-bridge `FACTORY_CONFIG` 隔离）的运行结论文件；也**没有任何 `F-0*.json`**。与派单描述一致。
- 4 个文件的 mtime（14:27~14:29）**晚于** `W4-acceptance.md`（14:18），即这轮改动发生在 W4 验收报告落盘之后、且未留下对应结论 → 属**「代码已落地、证据链断裂」**：本报告的 §1~§5 即为该缺口的事后补证。
- 建议：为 R-W4-03 / R-W4-05 各补一份 `strategist/runs/*.json`（内容可引用本报告 §2、§3、§6-③），并把 §6-④ 的 `/tmp/refs` 前置登记为新的返工卡（修法：在审计脚本开头用 `pathlib` 自建 3 张最小 PNG 夹具，或在 README/用法注释中显式声明该前置）。

---

## §8 复现命令汇总（逐条可执行）

```bash
cd /home/linsheng/Desktop/ai-video-factory

# 1) 语法
for f in tests/test-bridge.js src/self-heal.js tests/test-selfheal.js; do node --check "$f"; echo "$f=$?"; done
LD_LIBRARY_PATH=/home/linsheng/pwlibs/extract/usr/lib/x86_64-linux-gnu python3 -m py_compile tests/canvas-audit.py; echo "=$?"

# 2) 配置基线 + test-bridge 隔离（关键：两次 md5 必须一致）
md5sum config/config.json
node tests/test-bridge.js; echo "exit=$?"          # 33 通过 / 0 失败
md5sum config/config.json                          # 0552a2d7b303f2149ddfbfe9cfd782b1（一致）

# 3) 自愈测试
node tests/test-selfheal.js; echo "exit=$?"        # 152 通过 / 0 失败

# 4) 画布审计（需先起服务：node server.js，默认 8788）
LD_LIBRARY_PATH=/home/linsheng/pwlibs/extract/usr/lib/x86_64-linux-gnu python3 tests/canvas-audit.py
#    无 /tmp/refs → FileNotFoundError at tests/canvas-audit.py:1138（exit=1）
#    有 /tmp/refs 且 DATA_DIR 素材齐 → 179 通过 / 0 失败 / 0 提示（exit=0）

# 5) 全量自检 + 配置守卫
bash scripts/verify-all.sh; echo "exit=$?"         # /tmp/refs 存在时：30/30、exit=0
md5sum config/config.json

# 6) 红队 ③（直接 import 归一化函数，不改代码）
node --input-type=module -e "
import { normalizeHealMode, healModeGate } from './src/self-heal.js';
for (const c of ['OFF',' off ','0',0,null,false,'',undefined])
  console.log(JSON.stringify(c),'=>',normalizeHealMode(c),'allowed=',healModeGate({mode:c}).allowed);"

# 6b) 红队 ④（新发现：审计依赖无人创建的 /tmp/refs）
rm -rf /tmp/refs && LD_LIBRARY_PATH=/home/linsheng/pwlibs/extract/usr/lib/x86_64-linux-gnu python3 tests/canvas-audit.py; echo "exit=$?"

# 6c) 红队 ⑤（新发现：test-actors 同源缺陷 —— 无隔离真写真实配置，看 mtime 才可见）
stat -c '%y' config/config.json; md5sum config/config.json
node tests/test-actors.js; echo "exit=$?"          # 105 通过 / 0 失败
stat -c '%y' config/config.json; md5sum config/config.json   # mtime 变、md5 不变

# 6d) 口径核验：md5 级门禁发现不了「同字节重写」
grep -n "md5sum" scripts/verify-all.sh | head       # 门禁只比 md5（:23/:43/:119-140）
```

---

## §9 环境与限制声明（不美化）

1. **服务**：复验开始时 `127.0.0.1:8788` **没有**服务在跑（W4 报告里的 PID 2679524 已不在）。为满足阶段 22~25 与步骤 4 的真跑前置，我以托管后台任务启动了 `node server.js`（`PORT=8788`），并**刻意隔离数据面**：
   `FACTORY_DATA_DIR=/tmp/w5/data`、`FACTORY_DB=/tmp/w5/data/factory.db`（真实 `factory.db` + `-wal` + `-shm` 的副本，另补拷 `data/images`、`data/thumbs`、`data/uploads` 供前端取图）。
   → **真实 `data/factory.db` 与真实业务数据未被本次复验写入。** `config/config.json` 用的是**真实文件**（正是为了检验配置守卫本身），全程 md5 未变。
   → 复验结束后该服务已关闭（见 §9.4），环境恢复为「8788 无服务」。
2. **`/tmp/refs` 是我新建的**：为把「脚本缺陷」与「我的隔离环境缺素材」分开（§4.2 的 A/B 实验），我用 PIL 在 `/tmp/refs/` 生成了 3 张 640×480 占位 PNG（**只在 `/tmp`，未写入仓库任何路径**）。这不改变代码结论，但意味着 §5.2 的 exit=0 是在「补齐该前置」后取得的 —— 而**该前置本应由脚本自己保证却并没有**，这一点已在 §6-④ 如实登记为未修项。
3. **写入范围**：本次只写了 `strategist/reports/W5-acceptance.md` 一个文件；未修改任何源码 / 测试 / 配置；未创建任何 `.bak`。
4. **收尾**：托管后台服务进程已 kill；`/tmp/w5/*.log`、`/tmp/canvas-audit/` 截图保留供复核。`/tmp/refs/` 保留（删除后 stage 25 会重新判红，是否删除请由总军师决定）。
5. **未复验的内容**：本报告只覆盖派单指定的 4 个文件与其调用面；`src/studio.js` 的 `healModeGate` 调用点短路属 R-W3-03 范围（W4 已验收），本次仅通过 `verify-all` 阶段 14/27 间接覆盖，未单独重做红队。
6. **真实配置的最终状态**：`config/config.json` 内容自始至终为 `0552a2d7b303f2149ddfbfe9cfd782b1`（4903 字节，**内容零差异**）；但 **mtime 被自检过程改写**（`14:52` → `22:23:39` → 单跑 `test-actors` 后 `22:29:16`），机制见 §5.3 与 §6-⑤。复验**结束时**该文件的 md5 与派单给定基线一致。
7. **自检派生出的其它文件改动（非我所写）**：`scripts/simulate-all.js`（阶段 21）按设计自动重写了 `docs/全模块功能模拟测试报告.md` / `.json`（其源码 `:1174-1176` 即写这两个路径），`python3 -m py_compile` 生成了 `tests/__pycache__/canvas-audit.cpython-312.pyc`。除这三个自检产物与本报告外，仓库内无其它文件被本次复验改动。

---

## §10 交付判定

**「当前可否交付」：可以交付（4 个文件本身改到位、真跑全绿）；但交付结论必须带 4 条附注，不能写成「零缺陷全绿」。**

**可以交付的依据**：4 个文件的语法、隔离、归一化、审计健壮性**四项全部真跑通过**；`verify-all.sh` **30/30、exit=0**；真实配置**两次全量自检 + 单跑被测测试均为字节级零差异**；红队 ①/②/③ 三条断言**全部证伪**；被中断波次的改动逐 hunk 收敛、测试纯增量，**未发现回归**。

**必须随交付一起登记的 4 条附注**：

1. **治理留痕缺口**：`R-W4-03` / `R-W4-05` 无 `strategist/runs/*.json` 结论文件，无 `F-0*.json` → 建议用本报告 §2/§3/§6-③ 回填。
2. **测试基建缺口**：`tests/canvas-audit.py:1138/:1162` 依赖无人创建的 `/tmp/refs/ref{1,2,3}.png` → 干净机器上 `verify-all` 阶段 25 必红（§6-④）。建议新开返工卡让脚本自建夹具，**不建议**改门禁绕过。
3. **同类缺陷未修尽**：`tests/test-actors.js:383` 仍无隔离地真写真实配置，实测改 mtime；今天因 `image.concurrency/backend` 值与真实配置相同而 md5 不可见，运维一改就会静默回滚（§6-⑤）。建议按 `tests/test-bridge.js:20` 一行补齐，并作为 R-W4-05 姊妹项归档。
4. **门禁口径不严密**：「零改写」目前只保证 md5 内容一致，**不排除同字节重写**（mtime 实测被改，§5.3）。若要强口径，需把门禁升级为 md5+mtime，或把 §6-⑤ 的零守卫写盘方隔离掉。

**不建议**因附注 2/3/4 阻塞本次交付：它们影响的是「可追溯性」「干净机器可复现性」与「门禁严密性」，均已被本次复验用真跑证据兜住，且均不改变 4 个文件的 PASS 结论。
