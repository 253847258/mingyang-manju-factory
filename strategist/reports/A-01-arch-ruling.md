# A-01 · 架构裁定书（两项冲突冻结）

> **角色**：架构师 ｜ **裁定日**：2026-09-29 ｜ **编号**：A-01
> **依据（上游，只读）**：`strategist/reports/README.md`（收口报告，第 2 次运行）、`strategist/reports/L6-verify.md`（L6 独立验收 466 行）、`strategist/reports/T-101-schedules-spec.md`（827 行）、`T-102-selfheal-spec.md`（695 行）、`T-104-subtitle-wrap-spec.md`（565 行）、`T-106-test-plan.md`（568 行）、`T-107-security-risks.md`（844 行）、`strategist/runs/T-101.json`、`T-102.json`、`T-203.json`、`T-207.json`、`T-301.json`。
> **本文件性质**：**接口冻结 + 裁定**。本次**未改动任何源码、测试、配置与既有报告**（唯一写入物即本文件）；不重启 8788；不引入 npm 依赖；不暴露思维链。
> **取证副本**：本裁定的两个新证据脚本落在 `/tmp/arch-ruling/`（仓库零写入），命令与原始输出见 §1.3 / §2.6 / §3.6。

---

## 0. 裁定摘要（先看这张表，再往下读细节）

| # | 冲突 | 争议双方 | **裁定（冻结口径）** | W2 影响 |
|---|---|---|---|---|
| **①** | 手动触发能否由请求方传 `occurrence_at` | T-101 §9.6（列为可传字段，窗口键=`manual:${occurrence_at}`）**vs** T-107 S-04（高危：窗口键被请求方控制→幂等失效，建议路由层丢弃） | **不允许**。`occurrence_at` 仅对 `trigger='auto'` 有效；`trigger='manual'` 时窗口键**必须**由服务端按当前整秒生成，路由层与函数层**双层丢弃**并回显中文说明。补跑历史窗口只允许走 `auto` 判定路径（受 `miss_policy/catchup` 约束） | 需 1 张返工卡：`src/schedules.js:1353` 一行判定 + `src/routes/schedules.js:284` 一处回显；见 §2.4 |
| **②** | 契约名与落地名对齐口径 | T-102 §4.1/§8.1（`src/selfheal.js`）、T-104 §2.1/§6（改既有 `src/subtitles.js`）**vs** 实际落地 `src/self-heal.js` / 新建 `src/subtitle-wrap.js` | **以落地名为唯一权威**：`src/self-heal.js`、`src/subtitle-wrap.js` 为正式名；`src/subtitles.js` **保持既有职责**（SRT/VTT/TTML 格式转换与校验），**不新增断行导出**。**禁止**再建 `src/selfheal.js`、`src/subtitles.js` 转发层或把断行搬回 `subtitles.js` | 契约/卡面/报告**回写**（文档线，§3.4）；`finish.js` 断行**接线**（实现线，§3.5） |

**一句话**：① 收口到「服务端生成窗口键」，把 T-101 §9.6 的字段描述改成「忽略并回显」；② 收口到「落地名为准、职责拆分」，把 T-104 §2.1 的「不新建模块」作废、`subtitles.js` 与 `subtitle-wrap.js` 分工写死。

---

## 1. 取证：事实基线与复核方式（先把「现在到底是什么样」钉死）

### 1.1 现状事实（每条都有可复核命令）

| 事实 | 复核命令 | 结果 |
|---|---|---|
| 落地文件存在，契约名不存在 | `ls -la src/self-heal.js src/subtitle-wrap.js src/selfheal.js` | 前两者存在（910 / 831 行）；`src/selfheal.js` **No such file** |
| `src/subtitles.js` 是**既有**文件（非本次新建） | `ls -la src/subtitles.js src/self-heal.js src/subtitle-wrap.js`；`grep -n "^export" src/subtitles.js` | 存在，150 行，mtime `Sep 28 21:38`（**早于** W2 的 `Sep 29 03:26/03:28`）；**未新增任何断行导出**（导出仍是 `parseTime/parseSrt/toVtt/toTtml/validateSubtitles`） |
| `subtitles.js` 已有 4 个使用方（改名会炸） | `grep -rn "subtitles\.js" src/ \| grep -v subtitle-wrap` | `src/deliver.js:11`（静态）、`src/qc.js:241`、`src/mcp-tools.js:773`、`src/routes/render.js:240`（动态） |
| `subtitle-wrap.js` **零生产调用点** | `grep -rn "subtitle-wrap" src/ web/` | 只命中模块自身注释（`src/subtitle-wrap.js:3`、`:27`），**无任何 import** |
| `self-heal.js` 已被生产接线 | `grep -rn "self-heal\.js" src/` | `src/studio.js:26` 静态 import（`healPolicy/classifyForHeal/planSelfHeal/runWithHeal/describeHeal`） |
| 路由层已丢弃 `occurrence_at` | `sed -n '280,298p' src/routes/schedules.js` | 只在注释与回显里出现，**没有**传给 `fireSchedule` |
| 函数层**仍**接受 `occurrence_at` | `sed -n '1352,1367p' src/schedules.js` | `let occurrence = occurrence_at ? isoSeconds(occurrence_at) : null;` → manual 分支只在「没给」时才回落当前秒 |
| 路由无节流 | `grep -n "节流\|throttle" src/routes/schedules.js` | **零命中**（T-107 S-04 的第三条建议未落地） |
| `/trigger` 无任何自动化测试 | `grep -rln "/trigger" tests/ web/ src/` | 只有 `src/routes/schedules.js` 自己 |
| `verify-all.sh` 已引用落地名 | `grep -n "selfheal\|subtitle-wrap" scripts/verify-all.sh` | `:69`（27/30）、`:71`（29/30） |

### 1.2 冻结时点的指纹基线（任何 W2 改动前先比对，改后必须重贴）

```bash
cd /home/linsheng/Desktop/ai-video-factory
md5sum src/schedules.js src/routes/schedules.js src/self-heal.js src/subtitle-wrap.js \
       src/subtitles.js src/finish.js src/studio.js \
       tests/test-schedules.js tests/test-selfheal.js tests/test-subtitle-wrap.js scripts/verify-all.sh
```

| 文件 | md5（A-01 冻结时点） |
|---|---|
| `src/schedules.js` | `e4799441410b5c021cc816c22e2ea81f` |
| `src/routes/schedules.js` | `54986a31255df20e69154679d8a478c0` |
| `src/self-heal.js` | `379a35c643776c3a97a2f9188a1c6f4e` |
| `src/subtitle-wrap.js` | `502454ed11bc165c5c4fc1086b8b0bef` |
| `src/subtitles.js` | `ba90fbfde7c01dcb2398d07ef8b82987` |
| `src/finish.js` | `7ba2c53c3d811f9b9a0122c505cff3a2` |
| `src/studio.js` | `09866843fc3af6e2e0e0cbf56d4d990c` |
| `tests/test-schedules.js` | `b7c67ee5c23f50d70dbe27a0bff1bf0b` |
| `tests/test-selfheal.js` | `bf210565afa6266d8044e1e7f61373d3` |
| `tests/test-subtitle-wrap.js` | `1e841e547831cbf14d14b904ea7582ef` |
| `scripts/verify-all.sh` | `c0ddda84a7417e339f96f59549becc44` |

> `src/self-heal.js` / `src/subtitle-wrap.js` 的值与 `L6-verify.md:462` 记录值**逐字一致** → 说明 L6 验收后这两个模块没被动过，本裁定直接建立在**已被独立验收过的产物**之上。

### 1.3 本次新做的两个取证（原始输出，可原样重跑）

```bash
cd /home/linsheng/Desktop/ai-video-factory
node /tmp/arch-ruling/rt-s04-manual-occurrence.mjs   # 证据①：S-04 在函数层仍成立
node /tmp/arch-ruling/rt-legacy-byte-equal.mjs       # 证据②：新断行 legacy 与既有 buildSRT 逐字节同源
```

**证据 ①（`rt-s04-manual-occurrence.mjs`，临时库、离线、零成本）原始输出**：

```text
[前置] 排产=S-0001 next_run_at=2025-06-01T01:00:00Z
[① 传 occurrence_at] jobs 0 → 1 → 2
   第1次：fired=true deduped=undefined windowKey=manual:2025-06-01T01:00:01Z job=JOB-mum563zua59769
   第2次：fired=true deduped=undefined windowKey=manual:2025-06-01T01:00:02Z job=JOB-mum5641xd28b33
[② 不传 occurrence_at] jobs 2 → 2
   第1次：fired=false deduped=true windowKey=manual:2025-06-01T01:00:01Z
   第2次：fired=false deduped=true windowKey=manual:2025-06-01T01:00:01Z reasonCode=skipped_deduped
[结论] ①传 occurrence_at 两次 → jobs 增量 = 2（S-04 在此调用路径下成立）
[结论] ②不传 occurrence_at 两次 → jobs 增量 = 0（去重生效）
[台账] schedule_runs 行数 = 2
```

**证据 ②（`rt-legacy-byte-equal.mjs`）原始输出**：

```text
[逐字节同源校验] 用例 12 × 3 档 per = 36 组，不一致数 = 0
[空输入] finish 对空 dialogue 不产出 cue（buildSRT cues=0）
[接线现状] subprocess 检查：grep -rn "subtitle-wrap" src/ web/ 只命中模块自身注释
```

---

## 2. 裁定 ①：`occurrence_at` 是否允许 manual 触发传入

### 2.1 冲突原文（逐字）

- **T-101 §9.6（`T-101-schedules-spec.md:647-649`）**：「请求体：`{ "dry_run": false, "dryRun": false, "force": false, "occurrence_at": null, "note": "" }`（两种拼写都接受，`dry_run` 优先）」「默认 `occurrence_at = 当前整秒`，窗口键为 `manual:${occurrence_at}`」。
- **T-101 §1 不变量 1（`:34`）**：「**同一窗口至多触发一次**：`(schedule_id, occurrence_at)` 唯一；并发 tick、进程重启、手动与自动撞车都只能产生一个 job。」
- **T-107 S-04（`T-107-security-risks.md:182-200`，高危）**：「手动触发的窗口键由请求方给（`occurrence_at`）→ 唯一索引去重被绕开，可无限建项目/入队」，最小修复：「**路由层丢弃 `body.occurrence_at`**：`trigger='manual'` 时窗口恒为服务端当前整秒」。
- **T-107 §5 C-2（`:636`）**：「契约补一句：**manual 触发的窗口键必须由服务端生成**（写进 T-101 §9.6 与实现卡断言）」。
- **集成线的既成事实（L5/L4）**：`src/routes/schedules.js:280-284` 已按 T-107 丢弃并回显 `ignoredOccurrence`（`README.md:78` 记「集成线按 T-107 执行并回显 `ignoredOccurrence`」，并列为「契约待裁决」）。

### 2.2 事实核对（五层，结论=「路由层已修，函数层未修」）

| 层 | 现状 | 位置 |
|---|---|---|
| 契约层 | `occurrence_at` 是**可传字段**，manual 窗口键由它决定 | `T-101-schedules-spec.md:647-649` |
| 函数层 | **仍接受**：`manual` 分支只在「没给」时才回落当前秒 → 传不同值 = 不同窗口 = 每次 `fired=true` | `src/schedules.js:1353`、`:1356-1357`、`:1366`（实测见 §1.3 证据①） |
| 路由层 | **已丢弃**：`occurrence_at` 不传下去，仅回显 `ignoredOccurrence` | `src/routes/schedules.js:280-284`、`:293`、`:295/298` |
| 前端层 | 界面**从不**发送该字段（无引用） | `grep -rn "occurrence" web/` → 零命中 |
| 文档层 | 手册只把 `occurrence_at` 记在函数签名里，未承诺 HTTP 可传 | `docs/排产与自愈使用手册.md:252`、`:299-305`（`grep -rn "occurrence_at" docs/ README.md` → 零命中） |

**判定**：T-107 S-04 **成立**，且**只在函数层残留**。任何未来的新增调用点（新路由、脚本、Agent、内部调用）都能一步绕开幂等 → 重复建制片项目、重复花钱。仅靠路由层一行注释不是「冻结接口」，只是「当前调用点恰好写对了」。

### 2.3 裁定（R1 系列，全部冻结）

| 编号 | 裁定 | 理由（可核） |
|---|---|---|
| **R1-1** | **HTTP 层**：`POST /api/schedules/:id/trigger` 的 `body.occurrence_at` / `body.occurrenceAt` **永久忽略**，窗口键一律服务端生成（当前整秒）。**不返回 400**，仍返回 HTTP 200 + `deduped:true` + `reasonCode:'skipped_deduped'` | 400 会把「前端重试」变成错误路径，与 T-101 §9.6「同一秒重复点击返回 deduped、HTTP 仍 200，便于前端重试安全」冲突；忽略是信息最少的正确行为 |
| **R1-2** | **函数层**：`fireSchedule(id, { trigger:'manual', occurrence_at })` 中 `occurrence_at` **必须被丢弃**（`manual → 当前整秒`）。**`trigger:'auto'` 继续接受 `occurrence_at`**（窗口键 = 给定窗口起点），此点**不得改** | ① 函数层丢弃是唯一能防「未来新调用点」的地方（证据①已复现漏洞）；② 既有 `tests/test-schedules.js:305/328/339` 三条断言用 `auto + occurrence_at` 指定窗口，改掉 auto 会破坏既有 116 条断言（铁律：不得改既有测试期望） |
| **R1-3** | **补跑历史窗口**：不新增「任意窗口手动补跑」入口。唯一合法路径是 `trigger:'auto'` 判定路径（受 `miss_policy/catchup_max` 约束）。若产品确需按下标补跑，**必须**满足 4 条：① 只允许 `occurrence <= now`；② 该 occurrence 必须命中 `collectDue(s, nowStr, cfg).occurrences`（`src/schedules.js:1009`）；③ 不命中 → `400` 中文拒绝，文案逐字：`指定的窗口不在该排产的到期窗口集合内（不会为人工请求凭空造窗口）：请用 POST /api/schedules/tick 或等待自动窗口`；④ 触发后仍走同一 `window_key` 幂等 | T-107 S-04 第二方案；`collectDue` 保证「窗口是排产自己算出来的」，请求方无法凭空造键 |
| **R1-4** | **不落「N 秒内限一次」节流**（T-107 第三条建议不作为 W2 必做项）。前端可自行做 3 秒按钮防连点（纯 UI，不改后端语义），标记 **P2 可选** | 换一秒再点一次是 T-101 §9.6 明示的合法意图（「`force:true` 绕过闸门但不绕过幂等：换一秒再点即可再跑一次」）；真正的花钱闸门是「预算/暂停/存储」三闸门 + 唯一索引，已实现且 L6 已验证 |
| **R1-5** | **响应字段冻结**（手册/契约/前端一律按此名）：`ignoredOccurrence`（无请求值= `null`，有则**原样回显**）、`ignoredOccurrenceNote`（**新增**，`ignoredOccurrence` 非 null 时非空中文说明）、`windowKey`（`manual:<ISO秒>Z`）、`occurrence`、`deduped`、`reasonCode`、`jobId`、`productionId`、`runId`、`dryRun`、`force`、`queue:{paused,reason}` | 路由现状只回显值不回显**原因**，调用方拿不到「为什么我给的窗口没用」；T-107 要求「回显**说明**」，补一个明确字段名即可被前端与测试断言 |

**`ignoredOccurrenceNote` 文案（逐字冻结，实现时原样输出）**：

```text
请求体 occurrence_at=<原值> 已被忽略：手动触发的窗口键一律由服务端按当前整秒生成（T-107 S-04），否则换个 occurrence_at 即可绕开排产幂等去重。
```

### 2.4 W2 落地步骤（最小 diff，逐行给出）

**步骤 1 —— 函数层（`src/schedules.js`，改 1 处、加 1 行中文注释）**

现状（`src/schedules.js:1352-1358`）：

```js
  const manual = trigger === 'manual';
  let ev = null;
  let occurrence = occurrence_at ? isoSeconds(occurrence_at) : null;

  // ① 判定（force 绕过闸门，但**绝不绕过幂等**）
  if (manual) {
    if (!occurrence) occurrence = nowISOStr;                // 手动：窗口=当前整秒
```

改为（**只动这一段的赋值，判定与闸门逻辑一行不改**）：

```js
  const manual = trigger === 'manual';
  let ev = null;
  // A-01 裁定 R1-2：manual 的窗口键必须由服务端生成，函数层也丢弃 occurrence_at（否则任何新调用点
  // 都能用「换个 occurrence_at」绕开 schedule_runs 的唯一索引 → 重复建项目、重复花钱，T-107 S-04）。
  // auto 路径继续接受 occurrence_at（既有测试用它指定窗口，见 tests/test-schedules.js:305/328/339）。
  let occurrence = (manual || !occurrence_at) ? null : isoSeconds(occurrence_at);

  // ① 判定（force 绕过闸门，但**绝不绕过幂等**）
  if (manual) {
    occurrence = nowISOStr;                                 // 手动：窗口 = 服务端当前整秒（忽略入参）
```

> 注意：`occurrence` 必须显式赋成 `nowISOStr` 后再进 `windowKeyOf`（`src/schedules.js:1366`）。**不要**把 `null` 直接交给 `windowKeyOf`——`windowKeyOf` 内部 `isoSeconds(null)` 会抛 `时间非法：null`（`src/schedules.js:203-207`，默认参数只对 `undefined` 生效）。

**步骤 2 —— 路由层（`src/routes/schedules.js`，改 1 处、加 1 行）**

在 `src/routes/schedules.js:284` 之后补中文说明，并挂到两个 `ctx.json` 上：

```js
    // A-01 裁定 R1-5：不仅回显值，还要回显「为什么忽略」，前端与测试都能断言这一条
    const ignoredOccurrenceNote = ignoredOccurrence === null ? '' :
      `请求体 occurrence_at=${String(ignoredOccurrence)} 已被忽略：手动触发的窗口键一律由服务端按当前整秒生成（T-107 S-04），否则换个 occurrence_at 即可绕开排产幂等去重。`;
```

`:295` 与 `:298` 两处 `ctx.json({ ... })` 各加一个 `ignoredOccurrenceNote` 字段。

**步骤 3 —— 断言补网（见 §2.5，归属卡见 §5）**

### 2.5 验收点（可直接执行，逐条给命令与期望）

**验收点 A（函数层·不必起服务）**

```bash
cd /home/linsheng/Desktop/ai-video-factory
node /tmp/arch-ruling/rt-s04-manual-occurrence.mjs; echo "exit=$?"
# 修复后必须变成：
#   [① 传 occurrence_at] jobs 2 → 2      ← 第 1、2 次都 deduped（同一整秒）
#   [结论] ①传 occurrence_at 两次 → jobs 增量 = 0
#   [结论] ②不传 occurrence_at 两次 → jobs 增量 = 0
```

> 提示：该脚本第 ① 段用固定 ISO 串且 `force:true`。修复后两次调用落到**同一真实整秒**才会去重；若跨秒（脚本跑得慢），把第 ① 段两次调用的 `now` 都显式注入同一个 `new Date('2025-06-01T01:00:01Z')` 再断言 jobs 增量 = 1（这是正式断言应采用的写法，见下条）。

**验收点 B（追加到 `tests/test-schedules.js` 第 8 节末尾；只新增断言，不得改动既有断言的期望值）**

必须新增且全部为真的 5 条（中文断言名建议逐字使用）：

1. `★ A-01 R1-2：manual 传 occurrence_at 被丢弃（窗口键 = 服务端注入 now）`
   证据：`fireSchedule(id,{trigger:'manual', occurrence_at:'2025-06-01T02:00:00Z', now:'2025-06-01T02:00:00Z', force:true, ctx:{paused:true}})` → `windowKey === 'manual:2025-06-01T02:00:00Z'`。
2. `★ A-01 R1-2：manual 换个 occurrence_at 也仍是同一窗口（幂等不被绕开）`
   证据：同一次 `now` 下再传 `occurrence_at:'2030-01-01T00:00:00Z'` → `fired===false && deduped===true && reasonCode==='skipped_deduped'`，且 `jobs` 增量 = 0、`schedule_runs` manual 行数 = 1。
3. `A-01 R1-2：auto 仍接受 occurrence_at（不回归既有窗口语义）`
   证据：`fireSchedule(id,{trigger:'auto', occurrence_at:T0900, force:true, now:'2025-06-01T01:00:07Z', ctx:{paused:true}})` → `windowKey === T0900`。
4. `A-01 R1-2：manual 不推进自动水位线、不消费自动窗口`（既有语义保持）
   证据：触发前后 `next_run_at` 不变。
5. `A-01 R1-5：manual 响应字段齐全（windowKey/occurrence/runId/jobId/reasonCode）`。

**验收点 C（路由层·独立临时实例，**不得**碰 8788）**
沿用仓库既有取证法（`tests/ui-scale.py:57-84`：`free_port()` + `PORT=<自由端口>` + 临时 `FACTORY_DB/DATA_DIR/CONFIG` + `node server.js` + 轮询 `/api/health`）：

```bash
# 新文件 tests/test-schedules-route.js（纯 Node，零依赖；见 §5 卡 A 的 write_scope）
node tests/test-schedules-route.js; echo "exit=$?"
```

必须断言：

| # | 断言 | 期望 |
|---|---|---|
| C1 | 临时实例健康检查 | `GET /api/health` 200 |
| C2 | 建一条 `existing_production` 排产（队列 `pauseQueues` 后，job 停 queued，零成本） | `S-0001` |
| C3 | 连发 3 次 `POST /api/schedules/S-0001/trigger`，body 分别带 `occurrence_at=...01Z/...02Z/...03Z` | 第 1 次 `fired:true`；第 2、3 次 `fired:false deduped:true reasonCode:'skipped_deduped'`，**HTTP 全 200** |
| C4 | 三次响应都带 `ignoredOccurrence`（原值）与 `ignoredOccurrenceNote`（非空、含「已被忽略」） | 逐条为真 |
| C5 | `jobs` 表（经 `GET /api/jobs` 或临时库直查）增量 = 1 | = 1 |
| C6 | 收尾：`POST /api/schedules/tick` 不因上面的窗口产生新任务 | 无新增 job |

**验收点 D（回归，禁止降级）**

```bash
node tests/test-schedules.js; echo "exit=$?"   # 期望 ≥116 通过 / 0 失败（只增不减）
node tests/test-selfheal.js; echo "exit=$?"    # 101 / 0
bash scripts/verify-all.sh; echo "exit=$?"     # 末行 ✅ 全部自检通过；阶段数 30→31（若并入新路由套件）
```

### 2.6 契约回写文本（T-101 §9.6 替换稿，逐字可用）

> 以下文本由**文档线/总军师**回写进 `T-101-schedules-spec.md`（**不在本裁定写入范围**，此处只提供成稿以免二次解释）。

- 把 `:647` 的请求体改为：
  `请求体：{ "dry_run": false, "dryRun": false, "force": false, "note": "" }（两种拼写都接受，dry_run 优先）。**occurrence_at / occurrenceAt 为已废弃字段：A-01 裁定 R1-1 起一律被忽略并在响应里回显 ignoredOccurrence + ignoredOccurrenceNote；保留解析只为不把既有调用的字段变成 400。**`
- 把 `:649` 改为：
  `**窗口键一律由服务端生成**：默认 occurrence_at = 服务端当前整秒，窗口键为 manual:${occurrence_at} → 同一秒内重复点击只会触发一次（返回 deduped:true + status=deduped，HTTP 仍 200，便于前端重试安全）。请求方给不出窗口（T-107 S-04）：这保证唯一索引（schedule_id, window_key, trigger）永远是唯一原子去重手段。`
- 把 `:34` 不变量 1 的措辞改为：
  `**同一窗口至多触发一次**：(schedule_id, window_key, trigger) 唯一；并发 tick、进程重启、手动与自动撞车都只能产生一个 job。`

---

## 3. 裁定 ②：契约名与落地名对齐口径

### 3.1 冲突原文（三处，T-106 §1.4 已列 N1/N2/N3）

| # | 任务卡写法 | 冻结契约写法 | T-106 §1.4 的建议 | 现实 |
|---|---|---|---|---|
| **N1** | T-203 `src/self-heal.js`（`strategist/tasks/T-203.yaml:16`） | T-102 §4.1/§8.1 `src/selfheal.js`（`:230`、`:582`） | **以契约为准 `src/selfheal.js`** | **卡面胜**：`src/self-heal.js` 存在且被 `src/studio.js:26` 接线 |
| **N2** | T-207 `src/subtitle-wrap.js`（`T-207.yaml:16`） | T-104 §2.1 **改既有** `src/subtitles.js`「**不新建模块**」（`:91`、`:127`、`:512`） | **以契约为准**：导出写进 `src/subtitles.js` | **卡面胜**：`src/subtitle-wrap.js` 存在、67 条断言全绿；`src/subtitles.js` 未加任何新导出 |
| **N3** | T-206/T-210 `.test.mjs` | 仓库既有 22 个套件全为 `.js` | 两种都能跑，**保持 `.mjs` 不变**（须写对文件名） | 现状已如此，`verify-all.sh:70/72` 引用正确 |

**附带**：T-106 §1.4 的「以契约为准」建议若照做，等于要求**重命名已验收产物**——而重命名会连带撞碎 `tests/*（5 个已绿套件）`、`scripts/verify-all.sh:69/71`、`README.md` 计数、`docs/排产与自愈使用手册.md` 的 import 路径，属于「改既有测试与集成文件去迁就文档」。这**与铁律冲突**（禁止改既有测试期望凑绿、禁止为口径改已验收产物）。因此 T-106 §1.4 N1/N2 的建议**作废**。

### 3.2 事实核对（为什么必须收口到落地名）

| 判据 | `src/self-heal.js` | `src/subtitle-wrap.js` / `src/subtitles.js` |
|---|---|---|
| 文件存在 | ✅ 910 行 | ✅ 831 行 / ✅ 150 行（既有） |
| 生产接线 | ✅ `src/studio.js:26` 静态 import，L5 已完成 | ❌ `subtitle-wrap.js` **零调用点**；`finish.js:78` 仍调私有 `wrapCjk`（`:86`） |
| 测试引用 | ✅ `tests/test-selfheal.js:21`（101 通过，L6 §1 实测） | ✅ `tests/test-subtitle-wrap.js:27`（67 通过） |
| 集成脚本引用 | ✅ `scripts/verify-all.sh:69`（27/30） | ✅ `:71`（29/30） |
| 独立验收 | ✅ T-502 PASS（`L6-verify.md:17`） | ✅ T-504 PASS（`L6-verify.md:19`） |
| 契约名可用性 | ❌ `src/selfheal.js` 不存在 | ⚠️ `src/subtitles.js` 存在但**无断行导出、也不能改名**（4 个既有使用方，见 §1.1） |
| 契约函数名是否齐备 | ✅ 别名已给：`healProfile = classifyForHeal`（`:240`）、`degradeNotice = describeHeal`（`:454`），契约 `planSelfHeal/nextBackend/fallbackChain` 等**逐名存在** | ✅ `wrapCjkSmart/wrapSubtitles/subtitleLayout/splitForCps/wrapCjkLegacy/estimateLines/wrapCuesForPlatform` + 常量 `FORBID_LINE_START/FORBID_LINE_END/GLYPH_HEIGHT_RATIO` 齐备 |

**结论**：契约的**函数级要求（签名、行为、不变量）已 100% 落地**，分歧只在**文件名**上；而文件名已被 5 个测试、`verify-all.sh`、README 计数、L6 验收报告共同固化为事实标准。**以落地名为权威是唯一零回归的选择**。

### 3.3 裁定（R2 系列，全部冻结）

| 编号 | 裁定 |
|---|---|
| **R2-1** | **`src/self-heal.js` 是自愈模块唯一权威名**。`src/selfheal.js` 从所有文档/契约/报告中废止。**禁止**新建 `src/selfheal.js` 转发层（会造出第三个名字、两处 export 面必须长期同步）。 |
| **R2-2** | **断行能力归属 `src/subtitle-wrap.js`（新模块）**；**`src/subtitles.js` 保持既有职责**（`parseTime/parseSrt/toVtt/toTtml/validateSubtitles`，格式转换与排版校验），**不得**把断行搬进去、**不得**改名、**不得**在它里面加转发导出。T-104 §2.1「不新建模块」与 §6 文件清单**作废**，替换为 R2-2 的分工。 |
| **R2-3** | **依赖方向冻结（单向）**：`finish.js → subtitle-wrap.js`（`subtitle-wrap.js` 自身**零 import**，已实测：`grep -n "^import" src/subtitle-wrap.js` 零命中）。`subtitles.js` 的既有使用方（`deliver.js:11`、`qc.js:241`、`mcp-tools.js:773`、`routes/render.js:240`）**一行不改**。 |
| **R2-4** | **配置键口径（最小 diff）**：接线只**读** `cfg.finish?.subtitleLineBreakMode`（`'legacy'`\|`'cjk'`，缺省 `'legacy'`）与 `cfg.finish?.subtitlePlatformPreset`（平台预设名，缺省空）。**不新增 `src/config.js` 的默认键**（`src/config.js:156-162` 的 finish 段保持不动），避免与共享热点文件抢写。缺省值下行为**必须与今天逐字节相同**（证据②：36/36 组同源）。 |
| **R2-5** | **测试文件扩展名（N3）保持现状**：新套件 `.test.mjs`（`canvas-select`/`canvas-perf`）与 `.js`（其余）混用**不再统一**——统一会改 `verify-all.sh` 的 5 行阶段与既有套件文件名，收益为零。**唯一硬要求**：`verify-all.sh` 增阶段时文件名逐字写对（`L6-verify.md:429` N3 的风险正是「忘了加进 verify-all.sh」）。 |

**逐名对照表（W2 照此接线，任一命名都不用再猜）**：

| 契约/卡面旧名 | **落地权威名（冻结）** | 关键导出（必存在） | 权威位置 |
|---|---|---|---|
| `src/selfheal.js`（T-102 §4.1/§8.1、T-106 §1.4、T-107 §C-4/S-03/S-12） | **`src/self-heal.js`** | `healPolicy` `classifyForHeal`(=`healProfile`) `planSelfHeal` `nextBackend` `fallbackChain` `canDegradeTo` `degradationOf` `runWithHeal` `describeHeal`(=`degradeNotice`) `shouldTripStageDegrade` `degradeSummary` `DEFAULT_HEAL_POLICY` `DEGRADE_CHAIN` `FREE_BACKENDS` `PAID_BACKENDS` `NO_SWITCH_KINDS` `MAX_*` | `src/self-heal.js`；接线 `src/studio.js:26` |
| `src/subtitles.js` 新增断行导出（T-104 §2.1/§6） | **`src/subtitle-wrap.js`**（新文件） | `wrapCjkSmart` `wrapSubtitles` `wrapCjkLegacy` `subtitleLayout` `splitForCps` `estimateLines` `wrapCuesForPlatform` `setPlatformPresets` `getPlatformPresets` `resetPlatformPresets` `resolveLineBreakMode` `FORBID_LINE_START` `FORBID_LINE_END` `GLYPH_HEIGHT_RATIO` `DEFAULT_SAFE_AREA` `DEFAULT_VIDEO_SIZE` | `src/subtitle-wrap.js` |
| `src/subtitles.js`（既有，职责不变） | **`src/subtitles.js`（不改名、不加导出）** | `parseTime` `parseSrt` `toVtt` `toTtml` `validateSubtitles` | 使用方见 R2-3 |

### 3.4 契约/文档回写清单（**由文档线执行**，不在本裁定写入范围）

| 文件 | 位置 | 改成 |
|---|---|---|
| `strategist/reports/T-102-selfheal-spec.md` | `:55`、`:81`、`:84`、`:143`、`:230`、`:505`、`:582`、`:596` | `src/selfheal.js` → `src/self-heal.js` |
| `strategist/reports/T-104-subtitle-wrap-spec.md` | `:91`、`:94`、`:127`、`:135`、`:512`、`:516` | 删除「改既有 `src/subtitles.js`，不新建模块」→ 改为「新增 `src/subtitle-wrap.js`；`src/subtitles.js` 既有导出不动」；`:512` 的「新增导出清单」整体移到 `src/subtitle-wrap.js` 行；`:127` 的 import 示例改 `from './subtitle-wrap.js'` |
| `strategist/reports/T-106-test-plan.md` | `:105` 的 N1/N2 行 | 「以契约为准」→「**以落地实现为准（A-01 裁定 R2-1/R2-2）**」 |
| `strategist/reports/T-107-security-risks.md` | `:389`、`:651`、`:655`、`:833` | `selfheal.js` → `self-heal.js` |
| `strategist/reports/README.md` | `:77`（RK-L6-05） | 结论从「建议下轮把契约名回写为落地名」改为「**已由 A-01 裁定 R2-1/R2-2 冻结：契约名以落地名为准，回写清单见该裁定 §3.4**」 |
| `strategist/reports/L6-verify.md` | `:429`（RK-L6-05） | 同上补一句「A-01 已裁决，N1/N2 以落地名为准；N3 维持现状」 |
| `strategist/runs/T-106.json` | `RK1` | 同上 |
| `docs/排产与自愈使用手册.md` | 模块路径处 | 已是 `src/self-heal.js`（`:53` 附近提到排产尚未落地的旧话需同步更新——该项属 RK-L6-05 之外，见 §7） |

### 3.5 W2 落地步骤（字幕接线，把「零调用点」补齐）

**现状**：`src/finish.js:66` `buildSRT()` 内部 `:78` 调私有 `wrapCjk()`（`:86-95`）；`src/subtitle-wrap.js` 无人 import → T-207 R1「无调用点」、RK-L6-03 同类问题。

**步骤 1**：`src/finish.js` 顶部加一行 import（`finish.js` 现在无对 `subtitle-wrap.js` 的依赖，新增不成环）：

```js
import { wrapCjkLegacy, wrapCjkSmart, resolveLineBreakMode, subtitleLayout } from './subtitle-wrap.js';
```

**步骤 2**：`buildSRT` 的**既有两个键默认值与语义不变**（既有调用方 `src/qc.js:242`、`src/mcp-tools.js:774`、`src/routes/render.js:243/410` **零改动**），只**新增一个可选键** `lineBreakMode`：

```js
export function buildSRT(shots = [], { includeAction = false, maxCharsPerLine = 18, lineBreakMode = null } = {}) {
```

内部断行改为按模式分派（注意两个函数的返回形状不同：`wrapCjkSmart` 直接返回**字符串**，`wrapCjkLegacy` 返回**对象**，取 `.text`）：

```js
      const mode = resolveLineBreakMode({ lineBreakMode });                      // null/未知值 → 'legacy'（不抛错打断成片）
      const wrapped = mode === 'cjk'
        ? wrapCjkSmart(speaker + body, { maxCharsPerLine })                      // 契约新行为：智能断行
        : wrapCjkLegacy(speaker + body, maxCharsPerLine).text;                   // 与旧私有 wrapCjk 逐字节同源（A-01 证据② 36/36）
```

> 私有 `wrapCjk`（`src/finish.js:86`）**保留**：它是既有行为的**冻结基线**，建议加注释「与 `src/subtitle-wrap.js` 的 `wrapCjkLegacy` 逐字节等价（A-01 证据②），新行为一律走 subtitle-wrap，勿在此处改算法」。**不得**直接删掉它再声称等价——删掉会失去自证基线的对照点。

**步骤 3**：平台预设注入（T-207 R2 的集成缺口）：`lineBreakMode:'cjk'` 且配置了 `cfg.finish?.subtitlePlatformPreset` 时，调用 `setPlatformPresets(表)` 后再用 `subtitleLayout()` 求 `L_eff`（实现卡按 `wrapCuesForPlatform` 的既有入参形状传 `videoHeight/width/safeArea/subtitleSize`）。**未注入时**必须保持 T-207 定义的降级行为（不崩、给中文告警、回落 18 字），**不得**抛错中断出片。

**步骤 4（可选，另卡）**：`src/qc.js:251` 读 `cfg.finish?.marginV` 而真实键是 `finish.subtitleMarginV`（T-207 R11）→ 不属本裁定范围，另开卡，本裁定只记录。

### 3.6 验收点

| # | 命令 | 期望 |
|---|---|---|
| E1 | `node /tmp/arch-ruling/rt-legacy-byte-equal.mjs; echo "exit=$?"` | `不一致数 = 0`（接线后**必须仍是 0**） |
| E2 | `grep -rn "subtitle-wrap" src/ \| grep -v "^src/subtitle-wrap.js"` | 接线后命中 `src/finish.js` 的 import 与调用（≥2 行） |
| E3 | `node tests/test-subtitle-wrap.js; echo "exit=$?"` | `67 通过 / 0 失败`，exit=0（**不得减少**） |
| E4 | `node tests/test-finish.js; echo "exit=$?"`（若存在，见 `scripts/verify-all.sh` 对应阶段） | 全绿、计数不降 |
| E5 | `bash scripts/verify-all.sh; echo "exit=$?"` | 末行 `✅ 全部自检通过`，前 25 阶段断言 **2098 守恒**、既有 30 阶段计数逐项不减（`L6-verify.md:342-376` 的对账法） |
| E6 | 新增跨模块断言（落在卡 B 独占的新文件 `tests/test-subtitle-wire.js`，见 §5）：`buildSRT(shots,{})` 与「`wrapCjkLegacy` 拼接」同输入同输出，逐字节 | 0 处不一致 |
| E7 | `grep -rn "selfheal\.js\|src/subtitles\.js 新增" strategist/reports/ docs/ README.md \| grep -v "test-selfheal\.js"` | 回写后**零命中**（只剩历史裁定文件自身的引用） |

---

## 4. 冻结接口速查（W2 直接照抄，不用再翻契约）

**`POST /api/schedules/:id/trigger`（A-01 冻结版）**

```jsonc
// 请求体（occurrence_at/occurrenceAt 为已废弃字段，忽略）
{ "dry_run": false, "dryRun": false, "force": false, "note": "" }
// 响应（HTTP 200）
{ "ok": true, "fired": true, "jobId": "JOB-xxx", "productionId": "PR-xxx", "runId": "RUN-0007",
  "occurrence": "2025-06-01T01:05:00Z", "windowKey": "manual:2025-06-01T01:05:00Z",
  "reasonCode": "due", "next_run_at": "2025-06-02T01:00:00Z",
  "ignoredOccurrence": "2030-01-01T00:00:00Z",              // 无请求值 → null
  "ignoredOccurrenceNote": "请求体 occurrence_at=2030-01-01T00:00:00Z 已被忽略：…（逐字见 §2.3）",
  "queue": { "paused": false, "reason": "" } }
// 去重响应（同秒第二次）仍是 200
{ "ok": true, "fired": false, "deduped": true, "reasonCode": "skipped_deduped", "runId": "RUN-0007", … }
```

**`fireSchedule(scheduleId, opts)` 语义（A-01 冻结版）**

| 入参 | manual | auto |
|---|---|---|
| `occurrence_at` | **被丢弃**（窗口 = 服务端 `now` 的整秒） | **生效**（窗口 = 给定值；缺省用评估出的窗口） |
| `force` | 绕闸门（暂停/预算/**上一轮在跑**），**不绕幂等**；存储闸门在路由层仍强留（S-06） | 同 |
| `now` | 决定窗口键（纯函数可测的关键） | 决定判定时刻与水位线 |
| 水位线 | **不推进**，只写 `last_run_at/last_job_id` | 推进 |
| `dryRun:true` | 不落库、不建项目、不入队，仍返回窗口键 | 同 |

**模块权威名与职责（A-01 冻结版）**

| 模块 | 职责 | 不得做的事 |
|---|---|---|
| `src/self-heal.js` | 错误分类→单向降级链→落账→中文告知（`src/studio.js:26` 接线） | 不得新建 `src/selfheal.js`；不得改 `runWithHeal` 的「先落账再生成」顺序（I1） |
| `src/subtitle-wrap.js` | 断行（legacy/cjk）、安全区、CPS 拆条、平台预设（纯函数、零 import） | 不得在 `src/subtitles.js` 加重导出；不得改 `wrapCjkLegacy` 的 UTF-16/`per+1` 怪癖（兼容基线） |
| `src/subtitles.js` | SRT/VTT/TTML 转换与排版校验（既有） | 不改名、不加断行导出、不动既有 5 个导出 |

---

## 5. 建议 W2 派卡（3 张，含 write_scope / 步骤 / 验收 / 回滚）

| 卡 | 目标 | write_scope（唯一写入者） | 验收 | 回滚 |
|---|---|---|---|---|
| **卡 A（P0，排产幂等收口）** | 落实 R1-1/R1-2/R1-5：`src/schedules.js` manual 丢弃 `occurrence_at`；`src/routes/schedules.js` 增 `ignoredOccurrenceNote`；**新建 `tests/test-schedules-route.js`**（独立临时实例，§2.5 C1–C6）；在 `tests/test-schedules.js` 第 8 节**只增** 5 条断言（§2.5 验收点 B） | `src/schedules.js`、`src/routes/schedules.js`、`tests/test-schedules.js`、`tests/test-schedules-route.js`（新建） | §2.5 A/B/C/D；`node tests/test-schedules.js` ≥116 且 0 失败；新套件 0 失败 | 改前 `cp` 两个 `.bak`；回滚 = 恢复 `.bak` 并删新测试文件 |
| **卡 B（P1，字幕接线）** | 落实 R2-2/R2-4：`src/finish.js` 断行改指 `src/subtitle-wrap.js`，`lineBreakMode` 缺省 `legacy`（行为逐字节不变）；平台预设注入与降级告警 | `src/finish.js`（+ 新增跨模块断言文件 `tests/test-subtitle-wire.js`） | §3.6 E1–E4、E6；E2 至少 2 行命中 | `cp src/finish.js .bak`；回滚 = 恢复 `.bak` |
| **卡 C（P2，集成与文档）** | `scripts/verify-all.sh` 增阶段（31/30 路由套件、32/30 字幕接线套件）；`README.md:11` 计数取真值；`docs/排产与自愈使用手册.md` 补 trigger 的 `ignoredOccurrence/ignoredOccurrenceNote` 与「occurrence_at 已废弃」；回写 §3.4 清单 | `scripts/verify-all.sh`、`README.md`、`docs/排产与自愈使用手册.md` + §3.4 各契约文件 | `bash scripts/verify-all.sh` exit=0；前 25 阶段 2098 守恒；§3.6 E7 零命中 | `cp` 各文件 `.bak`；回滚 = 恢复 |

> **并行安全**：三张卡的 write_scope **两两不相交**；`src/schedules.js` 只被卡 A 写，`scripts/verify-all.sh` 只被卡 C 写（矩阵铁律：共享文件唯一写入者）。

---

## 6. 附带裁定（同一冻结批次，避免 W2 再问）

| # | 事项 | 裁定 |
|---|---|---|
| A-01-a | T-101 §15.3 裁决点 1「唯一键是否纳入 `trigger`」 | **保留 `trigger`**（现状 `idx_sched_runs_window(schedule_id, window_key, trigger)`，`src/schedules.js:157`）。理由：manual 与 auto 窗口不互顶是 T-101 §9.6 的显式意图，且 L6 RT-01 已实测同窗口并发/跨进程重放全部去重 |
| A-01-b | T-101 §15.3 裁决点 2「闸门顺序」 | **采纳现状顺序：暂停 → 存储 → 预算**（`src/routes/schedules.js:288-291` 的 S-06 存储闸门在 `fireSchedule` 之前；`fireSchedule` 内为暂停→预算）。断言文案以现状为准 |
| A-01-c | T-101 §15.3 裁决点 3「`jobs.js` 的 `idemKey`/`priority`/实例锁是否另派卡」 | **不派卡**（本波不授权改 `jobs.js`）。T-108 §3.1/§3.3/§4.5 中依赖它的部分**标注为「未落地」**；排产侧幂等已由 `schedule_runs` 唯一索引独立完成（L6 RT-01 已证） |
| A-01-d | T-106 §1.4 N3 扩展名 | 维持现状（R2-5），不统一 |
| A-01-e | RK-L6-01（`canvas-select.js:502` 主画布 fail-open，中危） | **与本次两项裁定无关**，仍按下轮治理：`canvasId` 设必填或从 `node.canvas_id` 自证，缺省应**拒绝**而非放行。本案不改该文件 |
| A-01-f | RK-L6-03（`canvas-perf.js` 零接线）与 T-207 R1（`subtitle-wrap` 零调用点） | 两者同类（「新模块未接线」）。**字幕接线**纳入卡 B（§3.5）；**画布性能接线**仍保持「有意不接」（`L6-verify.md:427` 的理由成立：`actors.js:4683` 有同名 `visibleItems`，接线必须改名导入） |

---

## 7. 本裁定不覆盖 / 残余风险

1. **本裁定未改一行代码**：R1-2 与 §3.5 都是 W2 待执行项；在卡 A/卡 B 落地前，`src/schedules.js:1353` 的函数层漏洞（证据①）**依然存在**，只是当前唯一 HTTP 调用点已绕过它（`src/routes/schedules.js:293`）。任何在卡 A 之前新增的调用点都会踩坑。
2. **路由层无自动化测试**是当前最大的隐性缺口（`grep -rln "/trigger" tests/` 零命中）：卡 A 的 C1–C6 是**首个**路由级回归网，必须在卡 C 把它并入 `verify-all.sh`，否则「忽略 occurrence_at」只靠注释守。
3. **`docs/排产与自愈使用手册.md:53` 仍写「本仓库当前尚未落地（没有 `src/routes/schedules.js`）」**——该句在 L4 集成后已过期，属文档口径问题（不在 RK-L6-05 列出的两条命名分歧内），建议随卡 C 一并修正。
4. **本裁定不评估 rubric 之外的新增风险**：如 `occurrence_at` 之外的 S-05（`now` 伪造）已由路由层（`isLoopback` + `FACTORY_SCHEDULER_ALLOW_FAKE_NOW`）处置，本裁定仅确认现状、不改其口径。
5. **回写清单（§3.4）不在本裁定写入范围**：A-01 只写 `strategist/reports/A-01-arch-ruling.md`，契约/报告/README 的回写由总军师或文档线执行；K 若回写延迟，**以本裁定文档为唯一口径**（后续复核者按 §3.3 逐名对照表判读即可）。

---

## 8. 复现清单（一行一结论）

```bash
cd /home/linsheng/Desktop/ai-video-factory

# ① 冲突①的取证（S-04 在函数层仍成立）
node /tmp/arch-ruling/rt-s04-manual-occurrence.mjs; echo "exit=$?"

# ② 冲突②的取证（legacy 断行与既有 buildSRT 逐字节同源 36/36）
node /tmp/arch-ruling/rt-legacy-byte-equal.mjs; echo "exit=$?"

# ③ 命名现状（落地名存在、契约名不存在、无转发层）
ls -la src/self-heal.js src/subtitle-wrap.js; ls src/selfheal.js
grep -rn "selfheal\.js" src/ tests/ scripts/ | grep -v "test-selfheal\.js" || echo "（无 selfheal.js 引用，符合 R2-1）"
grep -rn "subtitle-wrap" src/ web/ | grep -v "^src/subtitle-wrap.js"

# ④ 三层口径现场（路由已丢弃、函数仍接受）
sed -n '280,298p' src/routes/schedules.js
sed -n '1352,1367p' src/schedules.js

# ⑤ 回归基线（本次裁定未跑全量，数值来自 L6-verify.md:39-44）
node tests/test-schedules.js; echo "exit=$?"        # 116 / 0
node tests/test-selfheal.js; echo "exit=$?"         # 101 / 0
node tests/test-subtitle-wrap.js; echo "exit=$?"    #  67 / 0
```

**红线自查**：未引入 npm 依赖；未重启 8788（本次只读代码与跑临时库脚本）；未改任何源码/测试/配置（唯一写入物 = 本文件 + `/tmp/arch-ruling/*`）；未改既有测试期望；未暴露思维链。
