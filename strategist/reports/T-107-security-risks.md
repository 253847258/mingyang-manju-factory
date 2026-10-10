# T-107 · 安全风险清单：排产自动执行面 / 自愈换后端越权 / 批处理删除误伤 / 路径与输入校验

| 项 | 值 |
| --- | --- |
| 任务卡 | `strategist/tasks/T-107.yaml`（receiver_role = security，P1，wave 1） |
| 角色 | 测试/安全/红队军师（**只读分析**，只写本报告与 `strategist/runs/T-107.json`） |
| 依赖 | T-101（排产契约）、T-102（自愈契约）、T-103（画布筛选与批处理契约） |
| 上游契约 | `strategist/reports/T-101-schedules-spec.md`、`T-102-selfheal-spec.md`、`T-103-canvas-select-spec.md` |
| 本卡产出 | 本文件（风险表 + 每条的风险四要素 + 高危项的**可验证阻断断言**） |
| 验收标准 | ① 每条风险给出「文件/接口 + 触发条件 + 影响 + 最小修复建议」；② 高危项必须给出可验证的阻断断言 |

> **本文件的性质**：只读侦察 + 风险登记。所有「既有事实」都在本机逐条核对源码并标注 `文件:行号`；
> 所有「实测结论」都附上原始输出（§7），**没有凭想象写的判断**。
> 本卡不写任何实现代码、不改白名单外文件、不引入依赖、不启动/重启服务（8788 正在服务 GUI）、不跑 `./scripts/verify-all.sh`。

---

## 0. 阅读指引与严重度口径

| 严重度 | 判据（本项目语境） | 处置要求 |
| --- | --- | --- |
| **严重（P0）** | 未鉴权即可达成「任意文件读 / 整库下载 / 绕过人工确认闸门」，或直接造成凭证外泄 | 合并进集成线**立即**修，修复前不得把自动化（排产/自愈）打开 |
| **高（P1）** | 可让「人类闸门（暂停/预算/审批）」被绕过、可让付费调用被无限放大，或让契约硬不变量（I1–I5）形同虚设 | 在对应实现卡内**必须**带断言落地 |
| **中（P2）** | 误伤面/一致性缺口：单次操作可能删错、半成品状态、审计缺口、口径漂移 | 排进同波次或紧随的修复卡 |
| **低（P3）** | 加固项与信息泄露面：本身不直接花钱或丢数据，但会放大上面几条 | 记录，随最近的改动顺手修 |

**风险编号**：`S-xx`。`S-01`–`S-05` 属 P0/高，逐条给可复制粘贴的阻断断言；P1 也逐条给断言；P2/P3 给「最小确证步骤」。

**本卡覆盖的四个面**（任务卡原文）映射到分组：

| 组 | 面 | 编号 |
| --- | --- | --- |
| A | 排产的自动执行面 | S-06 – S-11 |
| B | 自愈换后端的越权风险 | S-03、S-04、S-12 |
| C | 批处理删除的误伤面 | S-13、S-14 |
| D | 路径与输入校验 | S-01、S-02、S-05、S-15 |
| E | 跨面（无鉴权 / 配置 / 信息泄露） | S-16、S-17 |

---

## 1. 结论摘要（先修什么）

1. **S-01（严重）**：`data/factory.db` 就在 `DATA_DIR` 里，而 `DATA_DIR` 被整目录挂在 `/data` 静态路径上（`server.js:102` + `db.js:12`）。
   结果：**整库可下载**，而库里的 `canvas_plans.confirm_code` 是明文（`db.js:283`）。
   「人工确认闸门」的唯一秘密和它的载体在同一台无鉴权服务上 —— 排产/自愈把审批变成流水线的一环之后，这条就是**第一优先**。
2. **S-02（严重）**：`GET /api/upload/text?path=<绝对路径>` 可读**任意文件**：`resolveAsset` 对绝对路径直接放行（`db.js:417`），
   实测 `resolveAsset('/etc/passwd') === '/etc/passwd'`（§7 证据 A）。`config/config.json`（含 API Key 明文）首当其冲。
3. **S-03（高，契约级）**：`classifyError` 的规则顺序把 `rate` 排在 `moderation` 之前（`retry.js:23` vs `24`），
   实测「429 + content policy violation」被判 `kind='rate'`、`retryable=true`（证据 D）。
   T-102 的 I4「moderation 永不换后端」若只按 `kind` 判，**厂商用 429 包裹审核拦截**的常见形态会直接绕过红线。
4. **S-04（高）**：`fireSchedule` 的**手动触发**分支里，窗口键的「窗口」部分来自调用方传入的 `occurrence_at`（`schedules.js:1341`、`296-298`）。
   契约 §9.6 又把这个字段列为请求体字段 → **幂等去重可被请求方逐次换值绕开**，每次触发都新建制片项目 + 入队。
   幂等是 T-101 §5.4 自己声明的「唯一原子去重手段」，一旦可绕，T-101/T-102 的成本护栏全部失效。
5. **S-05（高）**：`POST /api/schedules/tick` 的 `now` / `limit` 同样来自请求体（`schedules.js:1518`），
   而 `now` 会参与 `schedule_runs.at`、水位线推进与「到点」判定 → 请求方可以**提前消费未来窗口**、污染台账时间线、放大触发批量。
6. **S-06（高）**：`force:true` 一次性绕开**暂停 + 存储 + 预算**三道闸门（`schedules.js:1362-1379`）。
   在「端点无鉴权」（S-16）的现实下，等于一条 HTTP 请求即可关闭人类暂停与月度上限。

---

## 2. 风险总表

| 编号 | 严重度 | 面 | 风险一句话 | 文件 / 接口（行号） | 最小修复方向 |
| --- | --- | --- | --- | --- | --- |
| S-01 | **严重** | D/E | `/data` 整目录托管 `DATA_DIR`，`factory.db` 与 uploads 全部可下载，`confirm_code` 明文在库 → 人工闸门秘密泄露 | `server.js:101-105`；`db.js:8,12`；`db.js:283` | `/data` 只挂白名单子目录（images/thumbs/videos/finish/publish/deliveries），禁止挂 DB 与 uploads |
| S-02 | **严重** | D | `resolveAsset` 绝对路径直通 → `/api/upload/text?path=` 任意文件读（含 config.json 的 API Key） | `db.js:414-425`（417）；`routes/meta.js:248-255` | `resolveAsset` 加 `allowAbsolute=false` 默认拒绝；该端点改用 `safeJoin` + 扩展名白名单 |
| S-03 | **高** | B | `rate` 规则先于 `moderation` → 429 包裹的审核拦截被判可自愈 → 违反 T-102 I4 | `retry.js:20-31`；T-102 §2.3 / I4 | 自愈层在 kind 之前先做 moderation 文本命中；或把 moderation 规则提到 RULES 最前 |
| S-04 | **高** | A | 手动触发的窗口键由请求方给（`occurrence_at`）→ 唯一索引去重被绕开，可无限建项目/入队 | `schedules.js:1324-1345`、`296-302`；T-101 §9.6 | 路由层忽略 `occurrence_at`（manual 恒用当前整秒）；同排产 N 秒内限一次 |
| S-05 | **高** | A | `tick` 的 `now`/`limit` 由请求方给 → 提前消费未来窗口、污染水位线与台账时间 | `schedules.js:1518-1560`；T-101 §9.7 | `now` 只允许 dev 且要求本机来源，否则一律用服务端时间；`limit` 硬上限（≤200） |
| S-06 | **高** | A | `force:true` 绕开暂停/存储/预算三道闸门 | `schedules.js:1362-1379`；T-101 §9.6 | force 需一次性人工令牌；force 仍必须过存储闸门并强制写审计 |
| S-07 | 中 | A | 支持启动即 tick（`runOnce()`）→ 若注册早于 `recoverStaleJobs()`，重启瞬间重复建项目/花钱 | `schedules.js:1660-1684`；`server.js:31`；T-101 §10.1 | 静态约束：`startScheduler(` 必须出现在 `recoverStaleJobs(` 之后 |
| S-08 | 中 | A | `target.provider` / `target.spec` 无白名单与量纲上限 → 排产可指定任意 provider、超大制片规模 | `schedules.js:714-780`、`1442`、`1452` | provider 白名单（null/mock/deepseek/openai）；spec 走既有 LIMITS 校验 |
| S-09 | 中 | A | 定时任务与人工任务同队（type='studio'），`limit:1` 串行 → 一条长流水线可长期占用队列、饿死人工任务 | `schedules.js:1275-1298`；`jobs.js:68-73` | 记录并展示排队来源；提供「排产优先级低于人工」的队列策略或人工插队语义 |
| S-10 | 中 | A | `ignore/deny` 缺失：排产 `runHistoryLimit`/`maxCatchupEnumerate=4096` 只挡枚举，不挡「一次 tick 内触发 N 条排产」 | `schedules.js:50,1020-1023,1536` | tick 增加「单轮最多触发 K 条」的硬上限并写中文原因 |
| S-11 | 中 | A | 排产 createProduction 走 LLM，**不进月度台账**（T-101 §8.1 已自认）→ 排产是唯一「无预算上限的自动花钱路径」 | `guard.js:32-42`；T-101 §8.1 | 至少对排产免费阶段记 LLM 用量；或在面板显式标注「不受月度上限约束」 |
| S-12 | 中 | B | T-102 I1 要求「账本写不进去就不换」，而既有 `audit()` 是**失败不抛错**的旁路写法 → 复用即破坏不变量 | `mcp-tools.js:135-147`；T-102 §3.3 C4 / I1 | `recordSelfHeal()` 不得复用 `audit()` 的吞错语义；写失败必须返回 `healed:false` |
| S-13 | 中 | C | 批处理「计划与选区同源」只比**数量**（`itemCount`）→ 同数量换一批节点后仍执行旧计划 → 误删/撤销恢复错对象 | `web/lib/canvas-select.js:1069`、delete 分支 effects | 计划内存排序后的 id 指纹（`shortHash`），不一致即 `STALE_PLAN` |
| S-14 | 中 | C | detach 批量删除 = 每节点 2 条 HTTP（清线 + 删点），无服务端事务、无批量端点 → 中途失败留半删画布 | `web/lib/canvas-select.js` planDelete；`modules/actors.js:299` | 新增单事务批量删除端点；前端一次请求下发 |
| S-15 | 中 | D | `POST /api/import` 用请求体的键当 SQL 列名（实测可改写语句），且错误被静默吞掉 | `routes/meta.js:311-330`（323、325） | 列名与 `PRAGMA table_info` 求交集；不再吞错 |
| S-16 | 中 | E | 全部 HTTP 端点无鉴权，只靠 127.0.0.1 绑定；表单型 CSRF 可命中 POST 类危险端点 | `src/http.js:101-179`、`122-126`；`server.js:100-108` | 校验 Host/Origin；危险动作要求自定义头或 CSRF 令牌；提供本机 token 模式 |
| S-17 | 低 | D/E | 500 响应回显 `err.stack`（绝对路径、内部行号）；`http.js` 双重解码；`__dirname` 式路径外泄 | `http.js:175`、`103`、`88` | 生产模式不回显 stack；pathname 只解码一次 |
| S-18 | 低 | E | `PUT /api/settings` 无鉴权且 `server` 段直写（可改 host/port）；`generic.url` 可改 → 与自动降级叠加成凭证外泄链 | `routes/meta.js:167`、`71-104`；`config.js:189-196` | `server` 段禁改；`generic.url` 加协议/主机白名单，禁止内网与本机 |
| S-19 | 低 | E | `POST /api/guard/reset-usage` 无鉴权：清零月度台账即让预算闸门放行，配合 `/api/queue/resume` 解除自动暂停 | `routes/meta.js:207-209`；`routes/render.js:117-121` | 清零需二次确认 + 审计；恢复队列记录操作者与理由 |
| S-20 | 低 | B | `confirm_code` 用 `Math.random()` 6 位、无失败次数上限 → 有效期内可在线枚举放行付费计划 | `mcp-tools.js:295`、`385-388`；`routes/... /run` | 改 `crypto.randomInt` 8 位+字母；失败 ≥5 次作废计划并写审计 |

> 表中「既有问题」（S-01、S-02、S-15–S-19）**不是本次新增功能引入的**，但它们是新增自动化（排产/自愈/批处理）的**放大系数**，
> 因此按同一张清单登记，并写清「谁该修」（§6）。

---

## 3. 逐条详述（风险四要素 + 断言）

### 3.1 A 组：排产的自动执行面

---

#### S-01（严重）· `/data` 静态挂载覆盖 SQLite 库文件与上传目录

- **文件 / 接口**：
  - `server.js:101-105`：`staticMounts: [{ prefix: '/data', dir: DATA_DIR, cache: 'public, max-age=30' }, …]`
  - `src/db.js:8`：`export const DATA_DIR = process.env.FACTORY_DATA_DIR || path.join(ROOT, 'data')`
  - `src/db.js:12`：`export const DB_FILE = process.env.FACTORY_DB || path.join(DATA_DIR, 'factory.db')`
  - `src/db.js:283`：`confirm_code TEXT,  -- 6 位确认码（只写服务端日志；接口仅返回掩码）`
  - 实机核对：`ls -la data/` → `factory.db`（3.1MB）、`factory.db-wal`（4.1MB）、`uploads/`、`images/`、`videos/`、`deliveries/` 均在 `DATA_DIR` 下
- **触发条件**：任意能访问 8788 的调用方（本机任意进程、本机浏览器中打开的任意页面、`HOST=0.0.0.0` 部署后的任意内网主机）发
  `GET /data/factory.db`（静态分支只要求 `GET/HEAD` + 路径在挂载内，`http.js:183-206`，无鉴权、无扩展名白名单）。
- **影响**：
  1. **整库下载**：`canvas_plans.confirm_code`（明文 6 位码，`mcp-tools.js:295`）+ `approved/approved_by` 状态 → 拿到码即可 `POST /api/canvas/plans/:id/run` **放行付费计划**，人工确认闸门（`mcp-tools.js:355-416`）被完全旁路；
  2. `app_config` 里的 `jobs:paused`（暂停真相）、`usage:monthly`（用量台账）、`jobs:pause-log`、`scheduler:lease`（H-08 租约）一并泄露 → 可精准绕过闸门与实例互斥；
  3. `data/uploads/**`（用户上传的私有素材）、`data/videos/**`、`data/deliveries/**` 可直接下载；
  4. 与 T-102 §5.1「degrade 必须告知」相反：攻击者可静默观察一切。
- **最小修复建议**（`server.js` 不在任何 wave-1 卡写范围内 → 需派卡，见 §6）：
  - `/data` 挂载改为**白名单子目录**（只挂确实要对外提供的 `images`、`thumbs`、`videos`、`finish`、`publish`、`deliveries`），或者保持整目录挂载但给静态分支加「路径后缀白名单（图片/视频/音频/字幕）+ 显式拒绝 `*.db`、`*.db-wal`、`*.db-shm`、`uploads/**`」；
  - 更彻底：`/data` 只提供「由 DB 行引用的资源」，由 API 端点按 id 出流（`ctx.sendFile`），不用目录托管。
- **可验证的阻断断言**（集成线合入后执行；本卡不能起服务，见 §8 诚实声明）：

```bash
# 期望：全部 404（当前实现会 200 + 二进制流）
for u in /data/factory.db /data/factory.db-wal /data/factory.db-shm; do
  printf '%s → %s\n' "$u" "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:8788$u")"
done
# 期望：uploads 不对外；但真实图片仍 200
curl -s -o /dev/null -w 'uploads → %{http_code}\n' 'http://127.0.0.1:8788/data/uploads/2025-09-27/1758900000000_x.png'
curl -s -o /dev/null -w 'images  → %{http_code}\n' "$(printf 'http://127.0.0.1:8788/data/images/%s' "$(ls data/images | head -1)")"
```

  纯代码侧断言（不依赖服务，可用于 `tests/`）：

```js
// 断言静态挂载白名单：mounts 展开后不得包含 DATA_DIR 本身
import { readFileSync } from 'node:fs';
const src = readFileSync('server.js', 'utf8');
const ok = !/prefix:\s*'\/data',\s*dir:\s*DATA_DIR/.test(src);
if (!ok) throw new Error('S-01 未修复：/data 仍整目录托管 DATA_DIR（含 factory.db 与 confirm_code）');
```

---

#### S-02（严重）· `resolveAsset` 绝对路径直通 → 任意文件读取

- **文件 / 接口**：
  - `src/db.js:414-425`：
    ```js
    export function resolveAsset(rel) {
      if (!rel) return null;
      const s = String(rel);
      if (path.isAbsolute(s)) return fs.existsSync(s) ? s : s;   // ← 绝对路径原样放行（第 417 行）
      for (const base of [ROOT, DATA_DIR]) { try { const abs = safeJoin(base, s); … } catch { /* 越界，试下一个 base */ } }
      try { return safeJoin(ROOT, s); } catch { return null; }
    }
    ```
  - `src/routes/meta.js:248-255`：`GET /api/upload/text?path=` → `resolveAsset(rel)` → `fs.readFileSync(abs,'utf8').slice(0, 400000)` 直接回给调用方。
  - 实测（§7 证据 A/B/C）：`resolveAsset('/etc/passwd') === '/etc/passwd'`；相对穿越 `../../etc/passwd` 被 `safeJoin` 正确拦成 `null`（说明防线只差绝对路径这一条）。
- **触发条件**：`GET /api/upload/text?path=%2Fhome%2Flinsheng%2FDesktop%2Fai-video-factory%2Fconfig%2Fconfig.json`（无需鉴权）。
- **影响**：
  - 读 `config/config.json` → `llm.apiKey` / `image.generic.apiKey` / `image.openai.apiKey` / `tts.*.apiKey` **明文泄露**（`config.js:222-239` 的脱敏只在 API 响应里做，磁盘上是原文）；
  - 读 `~/.dsh/.credentials.yaml`（`config.js:199-209` 正是从它取 Key）、`~/.ssh/id_rsa`、仓库内任意源码/报告；
  - 顺着 `deliveries/**`、`data/**` 之外的路径还能读走本机任意文本文件；
  - 与 S-01 组合 = 「任意文件读 + 整库下载 + 确认码明文」三件套。
- **最小修复建议**：
  - `resolveAsset(rel, { allowAbsolute = false } = {})`：默认**拒绝**绝对路径（返回 `null` 并记中文 warn）；只有确需绝对路径的内部调用点显式传 `allowAbsolute:true`（`audio-node.js:70` 是唯一「本来就接受绝对路径」的调用点，逐个核对）；
  - `GET /api/upload/text` 改用 `safeJoin(ROOT, rel) || safeJoin(DATA_DIR, rel)` 并加扩展名白名单（`.md/.txt/.json/.csv/.srt/.vtt/.yaml/.yml`）；
  - `routes/studio.js:202` 的 `resolveAsset(rel) || path.join(ROOT, rel)` 兜底分支同样危险（交付包路径若被污染即任意读）→ 一并改掉。
- **可验证的阻断断言**：

```bash
# 期望：全部 400/404；现在至少 config.json 那条会 200 并回显 Key 明文
curl -s -o /dev/null -w 'passwd   → %{http_code}\n' 'http://127.0.0.1:8788/api/upload/text?path=/etc/passwd'
curl -s -o /dev/null -w 'config   → %{http_code}\n' 'http://127.0.0.1:8788/api/upload/text?path=/home/linsheng/Desktop/ai-video-factory/config/config.json'
curl -s -o /dev/null -w 'traversal→ %{http_code}\n' 'http://127.0.0.1:8788/api/upload/text?path=../../config/config.json'
```

```js
// 纯函数断言（临时库，无服务）：tests/ 可直接用
import { resolveAsset } from '../src/db.js';
if (resolveAsset('/etc/passwd') !== null) throw new Error('S-02 未修复：resolveAsset 仍放行绝对路径');
if (resolveAsset('../../config/config.json') !== null) throw new Error('S-02 回归：相对穿越又被放行');
```

---

#### S-04（高）· 手动触发的幂等窗口由请求方控制 → 去重失效、可无限触发

- **文件 / 接口**：
  - `src/schedules.js:1340-1348`：
    ```js
    let occurrence = occurrence_at ? isoSeconds(occurrence_at) : null;
    if (manual) { if (!occurrence) occurrence = nowISOStr; }     // 手动：窗口=当前整秒（除非调用方给了）
    ```
  - `src/schedules.js:296-302`：`windowKeyOf()` 对 manual 返回 `` `manual:${occ}` ``
  - `src/schedules.js:1391-1394`：`INSERT OR IGNORE INTO schedule_runs (… window_key …)`，`reserve.changes === 0` 才算 deduped
  - 契约侧：T-101 §9.6 请求体把 `occurrence_at` 列为**可传字段**（`{ "dry_run": false, "force": false, "occurrence_at": null }`）
- **触发条件**：`POST /api/schedules/:id/trigger`，body 里给不同的 `occurrence_at`（同一排产、同一秒内也能连续多次）。
- **影响**：
  - 每次请求都是「新窗口」→ 唯一索引永不命中 → 每次都走 `createProduction()`（走 LLM，`schedules.js:1438-1449`）+ `enqueueScheduledRun()`；
  - T-101 §5.4 明确把「唯一索引」当作**唯一的原子去重手段**（「宁可留下一条 failed/pending 残行……也不能重复花钱」），S-04 让它形同虚设；
  - 与 S-16（无鉴权）叠加 = 本机任意页面/进程可脚本化堆叠制片项目与队列任务 → 队列饥饿（S-09）+ LLM 花费不受月度上限约束（S-11）。
- **最小修复建议**：
  - **路由层丢弃 `body.occurrence_at`**：`trigger='manual'` 时窗口恒为服务端当前整秒；若确实需要补跑历史窗口，只能走 `fireSchedule(..., { trigger:'auto' })` 的判定路径（受 `missed/catchup` 策略约束）；
  - 若坚持保留 `occurrence_at`：只允许 `<= now` 且必须落在**该排产已存在的到期窗口**集合内（用 `collectDue` 校验），否则 400 中文拒绝；
  - 同排产触发节流：N 秒（建议 ≥10s）内重复请求直接返回 `deduped` + 中文原因；对 `force` 另加令牌（见 S-06）。
- **可验证的阻断断言**：

```bash
# 期望：三次请求只有第一次 fired:true，其余 deduped:true；jobs 表只 +1
for i in 1 2 3; do
  curl -s -X POST 'http://127.0.0.1:8788/api/schedules/S-0001/trigger' \
       -H 'content-type: application/json' \
       -d "{\"occurrence_at\":\"2025-06-01T01:00:0${i}Z\",\"force\":false}" | head -c 200; echo
done
curl -s 'http://127.0.0.1:8788/api/schedules/S-0001' | grep -o '"fire_count":[0-9]*'
```

```js
// 函数级断言（临时库）：同一排产连续三次 manual 触发，带不同 occurrence_at，jobs 只 +1
// 断言要点：occurrence_at 被忽略 → 第二次起 progress/reasonCode 必须是 skipped_deduped
const before = all('SELECT COUNT(*) c FROM jobs')[0].c;
await fireSchedule(sid, { trigger: 'manual', occurrence_at: '2025-06-01T01:00:01Z' });
const after1 = all('SELECT COUNT(*) c FROM jobs')[0].c;
const r2 = await fireSchedule(sid, { trigger: 'manual', occurrence_at: '2025-06-01T01:00:02Z' });
if (after1 > before + 1) throw new Error('S-04 未修复：单次手动触发建了多个任务');
if (!r2.deduped) throw new Error('S-04 未修复：换 occurrence_at 即绕开幂等去重');
```

---

#### S-05（高）· `tick` 的 `now` / `limit` 由请求方控制 → 提前消费窗口 + 台账时间线污染

- **文件 / 接口**：
  - `src/schedules.js:1518`：`export async function tickSchedules({ now = new Date(), dryRun, dry_run, limit = 200, rows = null } = {})`
  - `src/schedules.js:1521`：`const nowStr = isoSeconds(now);` → 参与 `dueSchedules({ now, limit })`、`fireSchedule(..., { trigger:'auto', now })`、`recordSkip(..., { nowISOStr: scan.now })`
  - 契约侧：T-101 §9.7 `POST /api/schedules/tick` body `{now?, dryRun?|dry_run?, limit?}`，仅注明「`now` 仅用于对表排错」
- **触发条件**：`POST /api/schedules/tick {"now":"2030-01-01T00:00:00Z"}`（无鉴权），或 `{"limit":200}` 放大单轮触发条数。
- **影响**：
  - **提前消费未来窗口**：把 `now` 推到未来 → `collectDue` 认为窗口已到 → 直接触发；随后 `next_run_at` 被推进到更远的未来 → **真实到点时不再触发**（排产被静默「吃掉一个周期」）；
  - 反向：把 `now` 设成过去 → 水位线被写成过去值，`schedule_runs.at` 与后续 `late_min`/`grace_min` 判定全部失真；
  - `schedule_runs.at`、`schedules.last_run_at/last_occurrence_at` 是决策时间线（T-102 §5.2 第 13 项）的事实来源 → 时间线可被伪造成任意时间戳；
  - `limit` 无二次上限校验（`dueSchedules` 内部只 `Math.min(200,…)`，`schedules.js:1158+`）→ 一次请求把 N 条排产全部触发。
- **最小修复建议**：
  - `POST /api/schedules/tick` **忽略** `body.now`（服务端取 `new Date()`）；确需对表能力时只允许 `FACTORY_SCHEDULER_ALLOW_FAKE_NOW=1` 且要求请求来自本机回环（`req.socket.remoteAddress` 为 `127.0.0.1/::1`）；
  - `limit` 强制 `Math.max(1, Math.min(20, …))` 并写中文原因；
  - 单轮触发条数上限（见 S-10）：`fired` 超过 K 条时改为「只触发 K 条，其余记 skipped 中文原因」。
- **可验证的阻断断言**：

```bash
# 期望：两个请求都不得触发任何排产，且 next_run_at 不变
before=$(curl -s http://127.0.0.1:8788/api/schedules | grep -o '"next_run_at":"[^"]*"' | head -1)
curl -s -X POST http://127.0.0.1:8788/api/schedules/tick \
     -H 'content-type: application/json' -d '{"now":"2030-01-01T00:00:00Z"}' | head -c 200; echo
after=$(curl -s http://127.0.0.1:8788/api/schedules | grep -o '"next_run_at":"[^"]*"' | head -1)
[ "$before" = "$after" ] && echo 'S-05 OK' || echo 'S-05 未修复：now 可控已推进水位线'
```

```js
// 函数级断言（临时库 + 假时钟）：路由层不得把 body.now 透传
const r1 = await tickSchedules({ now: '2030-01-01T00:00:00Z' });   // 直接调用是合法的（测试注入点）
// 断言：HTTP 层不透传——静态断言更稳：
const routeSrc = readFileSync('src/routes/schedules.js', 'utf8');
if (/body\.now|body\[.now.\]/.test(routeSrc) && !/remoteAddress/.test(routeSrc))
  throw new Error('S-05 未修复：tick 路由把请求体 now 透传给了 tickSchedules');
```

---

#### S-06（高）· `force:true` 一次绕开暂停 + 存储 + 预算三道闸门

- **文件 / 接口**：
  - `src/schedules.js:1362-1379`：
    ```js
    // ② 闸门（force 时全部绕过；手动触发不绕，除非 force）
    if (!force) {
      if (c.paused) { … recordSkip('skipped_paused') … }
      if (Number(s.skip_if_running) === 1 && c.running) { … }
      if (Number(s.budget_guard) === 1) { … budgetGate() … }
    }
    ```
  - 契约侧：T-101 §9.6「`force:true` 绕过闸门（暂停/存储/预算/上一轮在跑）**但不绕过幂等**」
- **触发条件**：`POST /api/schedules/:id/trigger {"force":true, "occurrence_at":"<新值>"}` → 同时绕过暂停 + 预算 + 幂等（S-04），闸门三道全灭。
- **影响**：T-101 §8.2 明写「暂停是硬闸门」「排产永不自动恢复」；`force` 把「硬」降级为「建议」。
  更关键的是**暂停的语义是人类的最后一道刹车**（`jobs.js:12-16` 注释：重启也要保持暂停，避免「重启一下就把闸门绕过去」）——
  一个 body 字段就能做到同样的事。
- **最小修复建议**：
  - `force` 必须携带一次性人工令牌（复用 P4 的「计划 + 确认码」套路：`force` 前先落一条待批记录，由人在界面取码）；
  - 即使 `force`，也**强留存储闸门**（磁盘满时一切白跑，无任何理由绕过）与「不建 job 但记审计」；
  - `force` 触发的 run 行必须带 `reason_code='due'` + `reason` 里含「人工强制」，并 emit `schedule:fired` 让时间线可见。
- **可验证的阻断断言**：

```bash
curl -s -X POST http://127.0.0.1:8788/api/queue/pause -H 'content-type: application/json' -d '{"reason":"T-107 断言"}' >/dev/null
jobs_before=$(curl -s 'http://127.0.0.1:8788/api/jobs?limit=1' | grep -c JOB || true)
# 期望：force 无令牌 → 4xx（中文「需人工确认码」），jobs 不新增
curl -s -X POST http://127.0.0.1:8788/api/schedules/S-0001/trigger \
     -H 'content-type: application/json' -d '{"force":true}' | head -c 200; echo
curl -s -X POST http://127.0.0.1:8788/api/queue/resume -d '{}' >/dev/null
```

```js
// 函数级断言（临时库）：force 且队列暂停时，若实现保留了存储闸门/审计，必须能在库中看到记录
pauseQueues({ reason: '断言用暂停' });
const r = await fireSchedule(sid, { trigger: 'manual', force: true });
if (r.fired && !all("SELECT 1 FROM schedule_runs WHERE schedule_id=? AND reason IN ('人工强制','')", sid).length)
  throw new Error('S-06 未修复：force 触发没有任何审计行');
```

---

#### S-07（中）· `startScheduler` 的启动即 tick 与 `recoverStaleJobs()` 的时序

- **文件 / 接口**：`schedules.js:1660-1684`（`runOnce()` 在 `setInterval` 之前立刻执行）；`server.js:31`（`recoverStaleJobs()`）；T-101 §10.1 要求「启动顺序：`recoverStaleJobs()` 之后才 `startScheduler()`」。
- **触发条件**：若集成线把 `startScheduler()` 注册在 `recoverStaleJobs()` 之前（或放在 `registerSchedulesRoutes` 里、而该注册早于第 31 行执行），重启瞬间：
  上一次被标记为「中断」的 job 状态刚变 `error`，`isScheduleRunning()` 立刻为假 → 同一窗口被重新触发（若 `next_run_at` 未被推进）。
- **影响**：每次重启可能多建一个制片项目 + 一条流水线（真实花钱路径），且无人察觉（表现为「怎么每次重启都多跑一集」）。
- **最小修复建议**：`server.js` 里把排产路由注册放到 `recoverStaleJobs()` 之后（一行位移）；`startScheduler` 内部再做一次「首轮 tick 前先跑 `recoverStaleJobs()` 幂等调用」的双保险。
- **断言**：

```js
const src = readFileSync('server.js', 'utf8');
const iRecover = src.indexOf('recoverStaleJobs(');
const iReg = src.indexOf('registerSchedulesRoutes(');
if (iReg !== -1 && iReg < iRecover) throw new Error('S-07 未修复：排产注册早于 recoverStaleJobs');
```

---

#### S-08（中）· 排产 `target` 缺少白名单与量纲校验

- **文件 / 接口**：`schedules.js:714-780`（`normalizeFields` 只校验 name/kind/tz/mode/target 形状）；`1442`/`1452` 把 `s.target.provider` 原样传给 `createProduction` 与 `enqueueScheduledRun`。
- **触发条件**：`POST /api/schedules` 的 `target = { brief:"…", spec:{episodes:9999, episodeSeconds:99999}, provider:"任意字符串" }`。
- **影响**：`provider` 无白名单 → 进入 `llm.js:34` 的 `opts.provider || cfg.llm.provider` 分支，未知 provider 会按默认分支处理（`llm.js:41-45`），行为不可预期；`spec` 无上限 → 单次排产可生成巨型制片项目（估算/建表/分镜循环全部按 spec 放大）→ 单轮 tick 内的 CPU/磁盘/LLM 放大。
- **最小修复建议**：复用 `SPEC_LIMITS`/`LIMITS`（`src/data/dictionaries.js` 与 `studio.js` 已在用）对 `spec` 做 clamp；`provider` 限定 `null|'mock'|'deepseek'|'openai'`，其余中文 400。
- **断言**：`createSchedule({ target:{spec:{episodes:10**6}} })` 抛中文 Error 或返回被 clamp 后的 spec（断言 `spec.episodes <= LIMITS.max`）；`provider:'evil'` 抛中文 Error。

---

#### S-09（中）· 排产任务与人工任务同队同 `limit:1` → 队列饥饿

- **文件 / 接口**：`schedules.js:1275-1298`（`enqueue({ type:'studio', limit:1, payload:{ scheduled:true, producer:'scheduler' } })`）；`jobs.js:68-73` + `jobs.js:156-196`（每 type 一个 FIFO，`limit` 固定）。
- **触发条件**：一条排产触发后，其流水线会长时间占用 `studio` 队列的唯一并发槽；此时人工点「跑流水线」的任务排在后面。
- **影响**：自动化把人工交互的等待时间从秒级拉到分钟/十分钟级（体验与判断依据都失真：界面显示「排队中」，人会以为卡死）。另：`pump()` 在暂停期间不启动新任务是对的，但**已在跑的不打断**，于是「暂停后仍有一条排产在跑完」符合预期，需要在界面上说清。
- **最小修复建议**：不改 `jobs.js` 签名（红线），改为在 payload 记 `producer:'scheduler'`（已做）并在界面/接口把「排产排队/执行中」与「人工任务」区分显示；若需真正的优先级，另派卡（会改 `jobs.js` 内部 `pending` 排序，不改公开签名）。
- **断言**：`GET /api/jobs` 里排产任务的 `payload.producer === 'scheduler'`；UI 断言排产任务带 `[排产]` 前缀（`schedules.js:1283`）。

---

#### S-10（中）· 单轮 tick 无「触发条数上限」

- **文件 / 接口**：`schedules.js:50`（`maxCatchupEnumerate: 4096`，只限制**枚举**）、`1020-1023`、`1536`（`dueSchedules({ now, limit })` 的 `limit` 默认 200）。
- **触发条件**：50 条排产同时到点（或 S-05 放大 limit）→ 一轮 tick 触发 50 次 `createProduction`（各带 LLM 调用）并塞进同一个 `limit:1` 队列。
- **影响**：瞬时资源尖峰（SQLite 写锁、LLM 并发、磁盘），且这些任务的排队时间会达到数小时 → 「排产看起来没跑」的误判。
- **最小修复建议**：tick 增加 `maxFirePerTick`（默认 5），超出部分写 `skipped` + 中文原因「本轮触发已达上限，下轮继续」；并在响应里返回 `deferred` 计数。
- **断言**：构造 20 条同时到点的排产 → 单轮 `fired.length <= 5` 且 `skipped` 含中文原因。

---

#### S-11（中）· 排产的 LLM 花费不在月度台账内（契约已自认）

- **文件 / 接口**：`guard.js:32-42`（`addUsage` 只有 images/videos/ttsChars）；`schedules.js` 的 `budgetGate`（`1240-1272`）只问图/视频/配音；T-101 §8.1 的「诚实说明」。
- **触发条件**：排产周期短（如 15 分钟）+ `target.brief` 较长 → 每轮都产生 brief 解析 + 演员 + 小说 + 剧本 LLM 调用，`monthlyCap` 完全不介入。
- **影响**：这是**唯一一条「自动、周期、无预算上限」的花钱路径**。对商用账号是实打实的成本泄漏，且台账上看不到。
- **最小修复建议**：给 LLM 调用补一条轻量台账（`app_config` 里加 `usage:monthly:llm`，不改 `addUsage` 签名）；至少在排产面板与 `GET /api/guard/status` 输出中文提示「本排产免费阶段的 LLM 花费不受月度上限约束」。
- **断言**：跑一轮排产（offline 除外）后 `GET /api/guard/status` 的 `usage` 或新字段能看到 LLM 计数增加；或断言响应/面板里含上述中文提示字符串。

---

### 3.2 B 组：自愈换后端的越权风险

---

#### S-03（高）· 错误分类顺序让「429 包裹的审核拦截」被判可自愈 → 违反 I4

- **文件 / 接口**：`src/retry.js:20-31`：
  ```js
  const RULES = [
    { kind: 'auth', … }, { kind: 'quota', … },
    { kind: 'rate', re: /(^|[^0-9])429([^0-9]|$)|rate[_ ]?limit|too many requests|限流|请求过于频繁/i },   // 第 23 行
    { kind: 'moderation', re: /moderation|content[_ ]?policy|safety|violat|sensitive|敏感|审核|违规/i },  // 第 24 行
    …
  ];
  for (const r of RULES) { if (r.re.test(text)) { kind = r.kind; break; } }   // 首个命中即返回
  ```
- **触发条件**：厂商把审核拦截包在 429/限流文案里（真实世界常见：`429 Too Many Requests: content policy violation`），
  或任何同时含「429/rate limit」与「审核/violat/sensitive」的报错文本。
- **影响**（T-102 §2.3 的 `healProfile` 直接吃 `classifyError` 的 kind）：
  - `kind='rate'`、`retryable=true` → 被当作「限流类可自愈」→ 允许同后端重试 + 允许换后端；
  - **I4「moderation 永不换后端」被绕过**：同一个被审核拒绝的内容被自动送到另一家厂商再生成一次（付费、且违反内容安全口径）；
  - 实测证据 D 已确证：`{"kind":"rate","label":"触发限流（429）","retryable":true,"status":429}`；而纯审核文案（证据 E）正确落到 `moderation`。
- **最小修复建议**（`retry.js` 不在本卡写范围内，但**最小改动即可**）：
  - 方案 A（最稳，1 行）：把 `moderation` 规则整体移到 `RULES` 数组**最前**（与 `auth` 同优先级组），任何含审核关键词的文本一律 `moderation`；
  - 方案 B（不碰既有分类）：在 T-102 的 `src/selfheal.js` 里加 `MODERATION_RE` 前置闸门——`healProfile()` 在 `classifyError` 之前先跑一次文本命中，命中即返回 `{kind:'moderation', action:'hold-human'}`；
  - 两个方案都要在 `selfheal_events` 里落 `errorKind='moderation'`，保证审计一致。
- **可验证的阻断断言**：

```bash
cd /home/linsheng/Desktop/ai-video-factory
node --input-type=module -e "
import { classifyError } from './src/retry.js';
const cases = [
  '429 Too Many Requests: content policy violation (审核未通过)',
  'rate limit exceeded: sensitive content blocked',
  '429 rate_limit: 违规内容',
];
let bad = 0;
for (const c of cases) {
  const k = classifyError(new Error(c));
  const okModeration = k.kind === 'moderation' && k.retryable === false;
  console.log((okModeration ? 'PASS ' : 'FAIL ') + JSON.stringify(c) + ' → ' + k.kind + ' retryable=' + k.retryable);
  if (!okModeration) bad++;
}
process.exit(bad ? 1 : 0);
"
# 期望（修复后）：三行全 PASS、exit 0；当前实现三行全 FAIL（kind=rate，见 §7.7 原始输出）
```

```js
// 自愈层断言（T-102 实现卡内）：审核文本必须 hold-human 且 healed=false、零生成调用
const p = planSelfHeal({ error: new Error('429 Too Many Requests: content policy violation'), from: 'comfyui-h3', stage: 'video' });
if (p.action !== 'hold-human' || p.healed !== false) throw new Error('S-03 未修复：审核拦截被当成可自愈');
```

---

#### S-12（中）· `audit()` 的「失败不抛错」语义与 I1/C4 直接矛盾

- **文件 / 接口**：`src/mcp-tools.js:135-147`：
  ```js
  /** 写一条审核审计（失败不抛错：审计是旁路，不能影响主流程） */
  export function audit(planId, action, actor = 'system', detail = '') { … try { … } catch (e) { console.warn(…); return null; } }
  ```
  T-102 §3.3 C4 / I1：`recordSelfHeal()` 写不进去 → **不换后端**（且 0 次生成调用）。
- **触发条件**：实现者出于「与既有风格一致」的直觉，把 `recordSelfHeal()` 写成 `audit()` 同形（吞错返回 null），
  调用方再写成 `const id = recordSelfHeal(x); if (id) doDegrade(); else doDegrade();`（或忽略返回值）。
- **影响**：数据库只读/磁盘满/唯一索引冲突时，**静默换后端**——正是 I1 要禁止的行为；且事件不在账本里 → 「用户到底在哪看到降级」的 15 个落地位置（T-102 §5.2）全部落空。
- **最小修复建议**：`recordSelfHeal()` **必须**在失败时抛中文错误（或返回 `{ok:false}`），由 `planSelfHeal()` 转成 `{healed:false, action:'stop', blockedBy:'C4'}`；在文件头注释里显式写「本函数不得复用 audit() 的吞错语义」。
- **断言**：

```js
// 注入写失败（只读库/触碰唯一索引），断言零生成调用
const calls = [];
const plan = planSelfHeal({ error: new Error('500 internal server error'), from: 'comfyui-h3', stage: 'video', recordFn: () => { throw new Error('库只读'); } });
if (plan.healed !== false || plan.blockedBy !== 'C4' || calls.length !== 0)
  throw new Error('S-12 未修复：账本写失败仍然换了后端');
```

---

#### S-20（低，但门槛很低）· 确认码 6 位 + `Math.random()` + 无失败上限 → 在线枚举

- **文件 / 接口**：`src/mcp-tools.js:295`（`String(Math.floor(100000 + Math.random() * 900000))`）、`385-388`（只做字符串比对并写一条审计，不锁定）；端点 `POST /api/canvas/plans/:id/run`（`mcp-server.js:183-192`）。
- **触发条件**：拿到一份 `approved` 计划 id（`GET /api/canvas/plans` 可列出，见 `mcp-server.js:132-143`），在 30 分钟 TTL（`mcp-tools.js:30`）内离线撞码。
- **影响**：90 万空间、单机脚本每秒数百次请求 → 数十分钟可撞开；撞开后 `consumePlan()` 一次性消费 → 付费执行落地。与 S-01 组合则无需撞码（直接读库）。
- **最小修复建议**：`crypto.randomInt(0, 1e8)` 生成 8 位（或 6 位+字母），失败 ≥5 次把计划置 `expired` 并写 `AUDIT_ACTIONS.DENIED_RUN`，端点加节流；`GET /api/canvas/plans` 默认不列出非本机的计划（或要求带 `plan_id` 精确查询）。
- **断言**：连续 5 次错误码后，第 6 次用**正确**码也必须失败（计划已作废），且 `planAudits` 有 5 条 `run_denied` + 1 条 `expired`。

---

### 3.3 C 组：批处理删除的误伤面

---

#### S-13（中）· 「计划与选区同源」只比数量 → 同数量换一批即误删

- **文件 / 接口**：`web/lib/canvas-select.js:1067-1071`：
  ```js
  // 计划与 items 必须同源（防止「筛选变了 / 画布重载了」却拿旧计划落地）
  if (p.itemCount !== list.length) { return applyFail('STALE_PLAN', …); }
  ```
  而 delete 分支的落库 effects 来自**计划期**的 `p.entries`（`planDelete` 里 `plan.entries = deletable`，effects 用 `e.nodeId`），内存投影却用 `e.index` 去裁**当前** `list`（`case 'delete': const gone = new Set(entries.map(e=>e.index)); out.items = list.filter((_,i)=>!gone.has(i));`）。
- **触发条件**：先 `planBatch('delete', 选中的 12 项)`，随后在**同数量**但不同节点被选中时（例如按类型筛选条件改了但命中数恰好相同、或画布被他人重载后 `items` 顺序变了）调用 `applyBatchPlan(oldPlan, { items: newList })`。
- **影响**：
  - 校验通过 → 执行的是**旧计划的 nodeId**（服务端删掉用户当前并没有选中的那批节点）；
  - 内存投影按 index 裁的是**新列表** → 界面显示的「消失项」与服务端实际删除项**不是同一批**；
  - 撤销栈（U 系列）按 index/nodeId 记录 → 恢复的也是错的 → 「撤销之后画布更乱」。
  这是 typo 级误删的典型形态，且**无法用快照兜底**（快照能救数据，但用户不知道自己被删了什么）。
- **最小修复建议**：计划里存**排序后的 id 指纹**（`nodeId` 优先、幽灵项回落 `actorId`/`id`）：
  ```js
  plan.idFingerprint = shortHash(list.map(idOf).sort().join('|'));
  // applyBatchPlan：if (p.idFingerprint && p.idFingerprint !== shortHash(list.map(idOf).sort().join('|')))
  //                    return applyFail('STALE_PLAN', '计划与当前选区不是同一批节点：请重新生成计划', list);
  ```
  并把现有「数量校验」保留为第二道（数量不符时错误文案更友好）。
- **可验证的阻断断言**：

```bash
cd /home/linsheng/Desktop/ai-video-factory
node --input-type=module -e "
import { planBatch, applyBatchPlan } from './web/lib/canvas-select.js';
const mk = (id, actor) => ({ id, actorId: actor, kind: 'actor', x: 0, y: 0, w: 180, h: 220, node: { id, actor_id: actor, locked: 0 }, locked: false, groupId: null });
const A = [mk('ND-1','C-1'), mk('ND-2','C-2')];
const B = [mk('ND-9','C-9'), mk('ND-8','C-8')];       // 同数量、不同节点
const plan = planBatch('delete', A, { mode: 'detach', confirm: true, confirmAgain: true });
const res  = applyBatchPlan(plan, { items: B, confirm: true, confirmAgain: true });
console.log('同数量换批 →', res.code, res.ok, JSON.stringify(res.effects.map(e => e.path)));
if (res.ok) { console.log('FAIL：S-13 未修复（旧计划被应用到新选区，effects 指向', res.effects[0]?.path, '）'); process.exit(1); }
console.log('PASS：已按指纹拒绝陈旧计划');
"
# 期望（修复后）：PASS；当前实现会打印 FAIL（effects 指向旧节点 ND-1/ND-2）
```

---

#### S-14（中）· detach 批量删除无服务端事务、无批量端点

- **文件 / 接口**：`web/lib/canvas-select.js` 的 `planDelete`（detach 分支为每个节点 push 两条 effects：`DELETE /api/canvas/nodes/:id/links` + `DELETE /api/canvas/node/:id`）；服务端 `src/modules/actors.js:299`：
  ```js
  export function removeCanvasNode(id) { run('DELETE FROM canvas_nodes WHERE id = ?', id); return { ok: true }; }
  ```
  （只删一行，**不清 `canvas_links`**，所以前端才要两条请求）
- **触发条件**：批量删除 100 个节点 = 200 次 HTTP；在第 57 次请求时关页面/断网/服务重启/命中一条外键约束。
- **影响**：留下「删了一半 + 若干悬空连线」的状态。悬空连线会被 `graph.js` 的连线解析读到（`from_node`/`to_node` 指向不存在的节点），表现可能是静默忽略、也可能是执行时抛出难以归因的错误；对用户而言是**最难恢复的中间态**（快照能回滚，但回滚点若被 40 张上限淘汰则回不去，见下方 S-13 相关注记）。
- **最小修复建议**：新增单事务批量端点（例如 `POST /api/canvas/nodes/batch-delete { nodeIds:[], includeLinks:true }`，内部一个 SQLite 事务：先删 links 再删 nodes），前端一次请求下发；返回逐项结果便于 HUD 对账。
- **断言**：故意混入一个不存在的 nodeId → 断言**没有任何**节点被删除（全或全无），且响应含中文原因。
- **注记（快照兜底能力）**：`snapshots.js:13` 单画布最多 40 张、`pruneSnapshots()` **优先淘汰自动快照**（`:67-80`）。而 T-103 要求「破坏性操作前自动快照」→ 频繁批处理会把自动快照挤掉。
  建议：给「批量删除/清空」产生的快照打 `kind='manual'`（或新增 `kind='auto-keep'` 并在淘汰时最后处理），否则**误删的兜底能力会随操作次数衰减**。

---

### 3.4 D 组：路径与输入校验

（S-01、S-02 已在上文；此处为其余输入校验面。）

---

#### S-15（中）· `POST /api/import` 把请求体的键当 SQL 列名（实测可改写语句）+ 静默吞错

- **文件 / 接口**：`src/routes/meta.js:311-330`：
  ```js
  const cols = Object.keys(row).filter((c) => row[c] !== undefined);
  try { run(`INSERT OR REPLACE INTO ${t}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`, …); n++; }
  catch { /* 跳过冲突行 */ }        // ← 所有错误（含注入导致的语法错误）都被吞掉
  ```
- **触发条件**：`POST /api/import {"data":{"actors":[{"id,name) VALUES (?,'丙')--":1}]}}`。
- **实测**（§7 证据 K）：构造出的语句**执行成功**（`changes = 1`，表里真的多了一行 `C-9/丙`）→ 说明列名确实进入了 SQL 结构，而不是被当字面量。
- **影响（诚实定级：中偏低）**：`t` 仍是白名单表的字面量、`node:sqlite` 的 `prepare` 拒绝多语句（实测带尾随 ` VALUES(?)` 的朴素注入直接语法报错），**因此不能跨表写、不能 DROP**；
  真实影响是 ① 输入校验缺口（列名未过滤）② **catch 吞错**导致导入静默丢数据（用户以为导入成功）③ 给未来的重构埋雷（一旦有人把 `t` 也参数化或改成多语句，立刻升级为高危）。
- **最小修复建议**：`cols` 与 `PRAGMA table_info(t)` 求交集，出现未知列立即返回 400 中文错误（`列名非法：<name>（表 <t> 不存在该列）`）；把 catch 改成收集错误并计入 `stats[t].errors`。
- **断言**：

```js
const before = all('SELECT COUNT(*) c FROM actors')[0].c;
// 直接调用路由逻辑或发 HTTP，断言：返回 400 且 actors 行数不变
```

---

#### S-17（低）· 500 响应回显 `err.stack`；`http.js` 双重解码

- **文件 / 接口**：`src/http.js:175`：
  ```js
  res.end(JSON.stringify({ ok:false, error: err.message, detail: err.detail ?? (status === 500 ? String(err.stack || '') : undefined) }));
  ```
  `src/http.js:103`（`decodeURIComponent(url.pathname)`）与 `88`（参数再 `decodeURIComponent`）。
- **触发条件**：任意触发 500 的请求（例如畸形 JSON、`node:sqlite` 抛错）；`GET /api/actors/%252e%252e%252fetc`。
- **影响**：`stack` 含**绝对路径**（`/home/linsheng/Desktop/…`）、函数名与行号 → 为后续利用提供地图；双重解码本身**当前不可穿越**（实测证据 B/C：相对穿越被 `safeJoin` 拦住），但它会让任何「按 pathname 做前缀/正则白名单」的未来判断失效。
- **最小修复建议**：`detail` 仅在本机/开发模式（`process.env.FACTORY_DEBUG=1`）回显；`match()` 的参数解码失败返回 400 中文错误而不是让 `URIError` 冒到 `createServer`（`http.js:222-227` 会把它变成 500）。
- **断言**：`GET /api/actors/%E4%B8%AD` 正常 404；`GET /api/actors/%ZZ` 返回 400 且响应体不含 `at file:///`；任意 500 响应体不含 `at ` 行。

---

### 3.5 E 组：跨面（无鉴权 / 配置 / 审计）

---

#### S-16（中）· 全站无鉴权，只靠 127.0.0.1 绑定；表单型 CSRF 可命中 POST 危险端点

- **文件 / 接口**：`src/http.js:101-179`（`handle` 全程无身份校验；`src/routes/*.js` 亦无 `authorization`/token 校验，grep 结果为空）；`server.js:107-108`（`HOST = process.env.HOST || cfg.server.host`，默认 `127.0.0.1`）；`src/http.js:122-126`（`ctx.body()` 同时接受 `application/x-www-form-urlencoded` 与任意其它 Content-Type 的原文本）。
- **实机状态**：`ss -ltnp` → `8788`/`3080` 均监听 `127.0.0.1`（见 §7.5）→ 当前**不对外**，这是唯一还起作用的防线。
- **触发条件**：用户在本机浏览器打开任意网页，该页面用 `<form method="POST" action="http://127.0.0.1:8788/api/queue/resume">` 之类的简单请求（无预检）即可命中
  `POST /api/queue/resume`（`routes/render.js:117`）、`POST /api/guard/reset-usage`（`meta.js:207`）、`POST /api/schedules/:id/trigger`（T-101 §9.6）；
  本机任意非特权进程同理（curl 即可）。
- **影响**：所有「人类闸门」（暂停、预算、审批、手动触发）在**本机范围内**都没有身份概念 → 闸门是「防止误操作」而不是「防止越权」。
  排产/自愈把系统从「人点一下才动」变成「自己会动」之后，无鉴权的代价从「误操作」升级为「被任意本机页面/进程遥控」。
- **最小修复建议**（最小改动、不动公开签名）：
  - 在 `createApp().handle` 前加一层极简校验：`Host`/`Origin` 必须是本机地址（`127.0.0.1`、`localhost`、`[::1]`），非本机来源一律 403；
  - 危险端点（queue resume、guard reset、settings 写、schedules 写、canvas run/plans approve）要求自定义头（`X-Factory-Action: 1`）或一次性 CSRF 令牌——简单表单请求无法带自定义头，天然免疫表单 CSRF；
  - 可选：加 `FACTORY_TOKEN`，非本机绑定时强制 `Authorization: Bearer <token>`。
- **断言**：

```bash
# 期望：403（当前会 200 且真的恢复队列）
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8788/api/queue/resume \
     -H 'Origin: https://evil.example' -H 'Host: 127.0.0.1:8788' -d '{}'
```

---

#### S-18（低）· `PUT /api/settings` 无鉴权、`server` 段直写、`generic.url` 可改（与自动降级叠加）

- **文件 / 接口**：`src/routes/meta.js:167`（`if (body.server) patch.server = body.server;`，无字段过滤）→ `config.js:189-196`（`saveConfig` 直接 `mergeDeep` 落盘）；
  `meta.js:71-104`（`image.generic.url/headers/apiKey`、`video.generic.url/headers/apiKey` 均可写）。
- **触发条件**：`PUT /api/settings {"server":{"host":"0.0.0.0"}}`（重启后对外暴露）；或把 `image.generic.url` 改成攻击者地址。
- **影响**：
  - `server.host/port` 可通过 HTTP 改写 → 下次重启即监听全网（与 S-16 叠加 = 无鉴权服务暴露）；
  - `generic.url` 可改 + **T-102 的自动降级**（`comfyui-h3 → generic-http`）→ 一旦降级发生，配置里的 API Key 会随 `Authorization: Bearer {{apiKey}}` 模板发到该 url；
    即便 key 为空，也是标准 **SSRF**（服务端替攻击者发请求）。
- **最小修复建议**：`server` 段禁止通过该接口修改（或只允许 `port` 且校验 1024–65535）；`generic.url` 校验协议（http/https）+ 主机白名单，且禁止指向本机/内网段（与 S-16 的 Host/Origin 校验一起做）。
- **断言**：`PUT /api/settings {"server":{"host":"0.0.0.0"}}` 后 `loadConfig().server.host !== '0.0.0.0'`；`PUT` 一个 `http://127.0.0.1:9999/` 的 generic.url 必须 400 中文错误。

---

#### S-19（低）· 预算台账可被一键清零、队列可由任意调用方恢复

- **文件 / 接口**：`src/routes/meta.js:207-209`（`POST /api/guard/reset-usage` → `resetUsage()`，无二次确认、无审计）；`src/routes/render.js:111-121`（`/api/queue/pause|resume`）。
- **触发条件**：`POST /api/guard/reset-usage` 然后 `POST /api/queue/resume`。
- **影响**：`checkBudget`/`shouldAutoPause` 依赖 `usage:monthly`（`guard.js:19-42`）→ 清零后闸门立刻放行，自动暂停被解除。
  这是设计上「给人用的逃生口」，但**没有留下任何痕迹**（`resetUsage` 只删桶、`resumeQueues` 会写 `jobs:pause-log`，而清零不会）→ 事后无法回答「谁把台账清了」。
- **最小修复建议**：`resetUsage` 写一条 `jobs:pause-log` 反面对照的审计（或新增 `app_config.ui:audit-log`），并在响应里回显被清的桶原值（已有 `had`）与操作来源 IP。
- **断言**：调用后 `SELECT value FROM app_config WHERE key='jobs:pause-log'` 长度增加且含 `reset-usage` 条目。

---

## 4. 已核对为「已有正确防护」的部分（请勿再加固或误改）

登记这些是为了防止后续实现卡「重复造闸门」或「好心改坏」：

| 既有防护 | 位置 | 结论 |
| --- | --- | --- |
| 目录穿越的相对路径防线 | `util.js:98-105` `safeJoin` | **有效**（实测证据 C 抛中文错误）；S-02 是它上游的绝对路径分支漏了 |
| 静态托管越界 | `http.js:191-201`（`safeJoin` + try/catch → 404） | 有效：`/data/../config/config.json` 会被拦 |
| `canvas_plans` 的审批链 | `mcp-tools.js:355-416`（有效期 → 一次性 → approved → 确认码 → 范围一致 → 二次干跑逐字比对 → 预算闸门） | 设计**严密**；本报告的问题全在「秘密的存放（S-01）」与「撞码成本（S-20）」，不在闸门逻辑本身 |
| 确认码不经接口返回 | `mcp-tools.js:607`、`mcp-server.js:163`（HTTP）、`planView()` 只给掩码 | 有效（`scripts/mcp.js:82` 还专门自测了这一条） |
| 计划消费的原子性 | `consumePlan()`（`mcp-tools.js:419-425`，`WHERE status='approved'` + `changes` 判定） | 有效：并发只有一个赢家 |
| 队列暂停的持久化与「不丢任务」语义 | `jobs.js:12-16`、`46-66`、`150-155` | 有效：重启保持暂停、暂停期间不启动新任务、已在跑的跑完 |
| 批量批处理的破坏性动作确认 | `web/lib/canvas-select.js`（NEED_CONFIRM / 两段确认 / 主画布硬闸门 / `RERUN_FORBIDDEN_ENDPOINTS`） | 设计良好；缺口是 S-13（同源校验）与 S-14（无事务），不是确认流程 |
| 图表执行的 `overwrite` 与主画布保护 | `modules/actors.js:1012+` `deleteCanvas`（主画布不可删） | 有效（T-103 V1/V5 已引用） |
| 预算/存储闸门的既有实现 | `guard.js:82-107/188-204/215-228`、`modules/render.js:474-505` `preflightBatch` | 有效且被 `/api/render/keyframes|videos` 正确调用；S-06 是「新入口绕闸门」而不是闸门本身有问题 |
| 排产的四级闸门顺序（暂停→存储→预算→单次） | `schedules.js:1240-1272` `budgetGate` | 与 T-101 §8.1 一致，**实现正确** |
| 排产的「先落账再花钱」 | `schedules.js:1391-1394`（reserve）→ `1440-1455`（createProduction/enqueue） | 顺序正确；问题是幂等键本身可被请求方控制（S-04） |

---

## 5. 与上游契约的口径差异 / 需裁决项

| # | 事项 | 契约怎么说 | 代码/现实怎样 | 建议 |
| --- | --- | --- | --- | --- |
| C-1 | T-103 R1「批处理重跑**禁止**调用 `/api/canvas/run`、`/api/canvas/run-node`」 | 契约把这两个端点定义为**必须绕开的无闸门入口** | `server.js:51-58` 仍然暴露它们，且 `web/views/actors.js:3523` 的「单节点重跑」正在用 `/api/canvas/run-node` | 契约是对的，**现状是漏洞**（S-06/S-12 之外的独立条目：本报告 S-06 已覆盖闸门语义，此处补「现有调用点必须迁移」）。需要一张集成卡同时改 `server.js` 与 `web/views/actors.js` |
| C-2 | T-101 §9.6 `force` 绕过闸门「但绕过不了幂等」 | 依赖「窗口键不可被请求方控制」这一隐含前提 | `occurrence_at` 是请求体字段，且 `fireSchedule` 直接用它（`schedules.js:1341`）→ 幂等同时被绕 | 契约补一句：**manual 触发的窗口键必须由服务端生成**（写进 T-101 §9.6 与实现卡断言） |
| C-3 | T-101 §9.7 `POST /api/schedules/tick` 开放 `now` 参数 | 「`now` 仅用于对表排错」 | `now` 参与判定与水位线写入（`schedules.js:1521`）→ 对表能力 = 触发器 | 契约把 `now` 限定为「仅测试/本机 dev」，路由层默认忽略 |
| C-4 | T-102 I4「moderation 永不换后端」（硬编码红线） | 判定入口是 `classifyError` 的 kind（§2.1/§2.3） | `rate` 规则先于 `moderation` → 429+审核被判 `rate`（实测证据 D） | 见 S-03：要么在 `retry.js` 调顺序，要么在 `selfheal.js` 加前置文本闸门；契约需明确「I4 的判定必须在 kind 之外独立做一次」 |
| C-5 | T-102 I1/C4「账本写不进去就不换」 | 要求 `recordSelfHeal()` 成功才允许切换 | 仓库既有习惯是「审计/旁路失败不抛错」（`mcp-tools.js:135`） | 契约补一句反例说明（禁止复用 `audit()` 的吞错语义），并在测试契约里加「注入写失败 → 零生成调用」用例 |
| C-6 | T-103 §5 快照兜底（破坏性操作前自动快照） | 期望误删可回滚 | `snapshots.js:13` 单画布 40 张、`pruneSnapshots()` **优先淘汰 auto 快照**（`:67-80`）→ 兜底能力随操作次数衰减 | 契约补「批处理产生的快照不参与 auto 优先淘汰」或提升上限 |
| C-7 | T-101 §8.1 诚实说明「LLM token 未进台账」 | 已自认排产免费阶段的 LLM 花费不受月度上限约束 | 无任何代码落实「至少给提示/记账」 | 至少在 `GET /api/schedules` 的响应与面板文案里写入该中文提示（见 S-11） |

---

## 6. 修复落点与写范围（谁该改哪个文件）

| 问题 | 需要改的文件 | 属于哪条线（不在本卡写范围，需派卡/并入集成线） |
| --- | --- | --- |
| S-01 `/data` 挂载白名单 | `server.js` | 集成线（server.js 已被独占） |
| S-02 `resolveAsset` 绝对路径 + `upload/text` 端点 | `src/db.js`、`src/routes/meta.js`、`src/routes/studio.js` | 需新派安全修复卡（db.js 是共享热点，建议单卡独占） |
| S-03 分类顺序 / 自愈前置闸门 | `src/retry.js` 或 `src/selfheal.js` | T-102 实现卡（`selfheal.js` 是新文件，优先走方案 B 不动 `retry.js`） |
| S-04/S-05/S-06/S-08/S-10 路由层校验 | `src/routes/schedules.js`（尚未创建）+ `src/schedules.js` | T-101/T-201/T-401 线；`schedules.js` 已存在但无路由 |
| S-07 `startScheduler` 注册顺序 | `server.js` | 集成线 |
| S-09/S-11 队列与台账 | `src/schedules.js`（记账）、界面文案（T-402） | T-201/T-402 线 |
| S-12 `recordSelfHeal` 语义 | `src/selfheal.js` | T-102 实现卡 |
| S-13/S-14 批处理同源指纹 + 批量事务端点 | `web/lib/canvas-select.js`（本卡只读）、`web/views/actors.js`、`src/routes/actors.js`、`src/modules/actors.js` | T-103 实现线（canvas-select.js 已落地，需一张小卡补指纹与批量端点） |
| S-15 import 列名白名单 | `src/routes/meta.js` | 需派卡 |
| S-16/S-17/S-18/S-19 鉴权·信息泄露·配置 | `src/http.js`、`src/routes/meta.js`、`src/routes/render.js` | 建议单开「本机访问控制」卡（改动面集中，风险也集中） |
| S-20 确认码强度 | `src/mcp-tools.js`、`src/mcp-server.js` | 需派卡 |

> 本卡**只写了** `strategist/reports/T-107-security-risks.md` 与 `strategist/runs/T-107.json`（铁律要求），未触碰任何上述源码文件。

---

## 7. 本卡自测与原始证据

### 7.1 质量检查（任务卡 `quality_checks`）

```bash
cd /home/linsheng/Desktop/ai-video-factory
node -e "require('node:fs').accessSync('strategist/reports/T-107-security-risks.md')" && echo OK
```

### 7.2 证据 A–F：路径校验与错误分类（临时库，离线，无服务）

```bash
cd /home/linsheng/Desktop/ai-video-factory
T=$(mktemp -d)
FACTORY_DB="$T/f.db" FACTORY_DATA_DIR="$T/data" FACTORY_CONFIG="$T/config.json" node --input-type=module -e "
import { resolveAsset } from './src/db.js';
import { safeJoin } from './src/util.js';
import { classifyError } from './src/retry.js';
console.log('A) resolveAsset(/etc/passwd)      =', JSON.stringify(resolveAsset('/etc/passwd')));
console.log('B) resolveAsset(../../etc/passwd) =', (()=>{try{return JSON.stringify(resolveAsset('../../etc/passwd'))}catch(e){return 'throw: '+e.message}})());
console.log('C) safeJoin 相对穿越              =', (()=>{try{return JSON.stringify(safeJoin('./data','../../etc/passwd'))}catch(e){return 'throw: '+e.message}})());
console.log('D) classifyError 429+content policy =', JSON.stringify(classifyError(new Error('429 Too Many Requests: content policy violation (审核未通过)'))));
console.log('E) classifyError 纯审核           =', JSON.stringify(classifyError(new Error('内容审核不通过：violat'))));
console.log('F) classifyError 500+额度         =', JSON.stringify(classifyError(new Error('500 internal server error: insufficient balance'))));
"
rm -rf "$T"
```

**原始输出（本机实测）**：

```
A) resolveAsset(/etc/passwd)      = "/etc/passwd"
B) resolveAsset(../../etc/passwd) = null
C) safeJoin 相对穿越              = throw: 非法路径：越界访问被拒绝
D) classifyError 429+content policy = {"kind":"rate","label":"触发限流（429）","retryable":true,"status":429}
E) classifyError 纯审核           = {"kind":"moderation","label":"内容审核不通过","retryable":false,"status":null}
F) classifyError 500+额度         = {"kind":"quota","label":"额度/余额不足","retryable":false,"status":500}
```

**判读**：A 证明 S-02 的前提成立（绝对路径被放行）；B/C 证明防线只差这一条；D 证明 S-03 成立（429 包裹审核 → `rate`/`retryable=true`，I4 可被绕过）。

### 7.3 证据 G–K：`/api/import` 列名拼接是否进入 SQL 结构

```bash
cd /home/linsheng/Desktop/ai-video-factory
T=$(mktemp -d)
FACTORY_DB="$T/f.db" FACTORY_DATA_DIR="$T/data" FACTORY_CONFIG="$T/config.json" node --input-type=module -e "
import { run, all, migrate } from './src/db.js';
migrate();
const cols = [\"id,name) VALUES (?,'丙')--\"];
const r = run('INSERT OR REPLACE INTO actors(' + cols.join(',') + ') VALUES(' + cols.map(()=>'?').join(',') + ')', 'C-9');
console.log('K) 列名注入 changes =', r.changes, '行 =', JSON.stringify(all('SELECT id,name FROM actors')));
"
rm -rf "$T"
```

**原始输出**：

```
K) 列名注入 changes = 1 行 = [{"id":"C-9","name":"丙"}]
```

**判读**：列名确实进入 SQL 结构并**执行成功**（S-15 成立）。同批另测两种朴素注入均报错（`near "VALUES": syntax error`、`2 values for 1 columns`），说明 `node:sqlite` 的单语句限制与占位符计数提供了**天然的部分保护** —— 故 S-15 诚实定级为「中」，不夸大。

### 7.4 证据 L：`src/graph.js` 全文无闸门引用（支撑 S-06 的「无闸门入口」判断）

```bash
cd /home/linsheng/Desktop/ai-video-factory
grep -n "guard\|budget\|pause\|checkStorage" src/graph.js ; echo "[exit=$?]"
```

**原始输出**：空（`[exit=1]`，无匹配）。

**判读**：`server.js:51-58` 的 `/api/canvas/run`、`/api/canvas/run-node` → `createGraphRunJob`/`runSingleNode`（`graph.js:829-851`）→ `runGraph`，全程没有预算/存储/暂停/审批任一闸门；而 `graph.js:450-520` 的 `image`/`video` 节点会真实调用付费后端（`image.js:117`、`video.js:91` 记用量）。

### 7.5 证据 M：无鉴权核验 + 监听地址

```bash
cd /home/linsheng/Desktop/ai-video-factory
grep -rn "authorization\|Bearer\|token\|session\|cookie" src/http.js src/routes/*.js server.js | grep -vi "apikey\|api_key" ; echo "[exit=$?]"
ss -ltnp | grep -E "8788|3080"
```

**原始输出**：

```
（无匹配，exit=1 → 无鉴权中间件）
LISTEN 0 511 127.0.0.1:8788 0.0.0.0:*
LISTEN 0 511 127.0.0.1:3080 0.0.0.0:*
```

**判读**：无身份校验；当前只监听回环（这是唯一还在起作用的防线，与 `server.js:108` 的 `HOST` 环境变量/配置可覆盖形成对照 → S-18/S-16）。

### 7.6 证据 N：S-13 的实测复现（批处理「旧计划落到新选区」）

```bash
cd /home/linsheng/Desktop/ai-video-factory
node --input-type=module -e "
import { planBatch, applyBatchPlan } from './web/lib/canvas-select.js';
const mk = (id, actor) => ({ id, actorId: actor, kind: 'actor', x: 0, y: 0, w: 180, h: 220, node: { id, actor_id: actor, locked: 0 }, locked: false, groupId: null });
const A = [mk('ND-1','C-1'), mk('ND-2','C-2')];
const B = [mk('ND-9','C-9'), mk('ND-8','C-8')];        // 同数量、不同节点
const plan = planBatch('delete', A, { mode: 'detach', confirm: true, confirmAgain: true });
const res  = applyBatchPlan(plan, { items: B, confirm: true, confirmAgain: true });
console.log('同数量换批 →', res.code, 'ok=' + res.ok, JSON.stringify(res.effects.map(e => e.path)));
if (res.ok) { console.log('FAIL：S-13 未修复（旧计划被应用到新选区）'); process.exit(1); }
console.log('PASS：已按指纹拒绝陈旧计划');
"; echo "[exit=\$?]"
```

**原始输出（本机实测）**：

```
同数量换批 → OK ok=true ["/api/canvas/nodes/ND-1/links","/api/canvas/node/ND-1","/api/canvas/nodes/ND-2/links","/api/canvas/node/ND-2"]
FAIL：S-13 未修复（旧计划被应用到新选区）
[exit=1]
```

**判读**：传入的选区是 `ND-9/ND-8`，产出的 effects 却删 `ND-1/ND-2`（计划期的旧节点）—— `itemCount` 相同即放行（`web/lib/canvas-select.js:1069`）。S-13 **已实测复现**，不是推测。

### 7.7 证据 O：S-03 的一键验收脚本（当前应 FAIL）

```bash
cd /home/linsheng/Desktop/ai-video-factory
node --input-type=module -e "
import { classifyError } from './src/retry.js';
const cases = [
  '429 Too Many Requests: content policy violation (审核未通过)',
  'rate limit exceeded: sensitive content blocked',
  '429 rate_limit: 违规内容',
];
let bad = 0;
for (const c of cases) {
  const k = classifyError(new Error(c));
  const ok = k.kind === 'moderation' && k.retryable === false;
  console.log((ok ? 'PASS ' : 'FAIL ') + JSON.stringify(c) + ' → ' + k.kind + ' retryable=' + k.retryable);
  if (!ok) bad++;
}
process.exit(bad ? 1 : 0);
"; echo "[exit=\$?]"
```

**原始输出（本机实测）**：

```
FAIL "429 Too Many Requests: content policy violation (审核未通过)" → rate retryable=true
FAIL "rate limit exceeded: sensitive content blocked" → rate retryable=true
FAIL "429 rate_limit: 违规内容" → rate retryable=true
[exit=1]
```

**判读**：修复后应输出三行 `PASS … → moderation retryable=false` 且 `[exit=0]`；当前三行全 FAIL（`[exit=1]`）即 S-03 未被修复的证据 ——
**只要审核关键词与限流关键词同时出现，I4 就一定失守**（不是边缘情况，而是规则的次序问题）。

### 7.8 证据 P：质量检查（任务卡 `quality_checks`）

```
$ node -e "require('node:fs').accessSync('strategist/reports/T-107-security-risks.md')"
quality_check OK exit=0
```


---

## 8. 残留风险与诚实声明

1. **本卡没有起服务做端到端复现**（铁律禁止启动/重启服务，8788 正在服务 GUI）。因此 S-01/S-02/S-04/S-05/S-06/S-16 的 `curl` 断言是**给集成线合入后执行**的，不是本卡的实测输出；
   本卡实测的是**函数级证据**（§7.2/7.3/7.4/7.5），它们足以证明风险的前提条件成立（例如「绝对路径被放行」这一条，`resolveAsset` 的返回值就是充分证据）。
2. **`src/selfheal.js` 与 `src/routes/schedules.js` 尚不存在**：B 组与 A 组中涉及「路由层」的条目（S-04/S-05/S-06/S-08）针对的是**已实现的 `src/schedules.js` 函数能力**与**T-101 §9 契约**——
   实现者只要按本报告的两条红线写路由（丢弃 `occurrence_at`、不信任 `body.now`；`force` 需令牌），这些风险就不会落地。
3. **`src/schedules.js`（83KB/1684 行）是并发实现中的文件**，本卡按「只读快照」审查了 `fireSchedule`/`tickSchedules`/`budgetGate`/租约/定时器五处关键路径；
   它仍在被其它波次改写，行号可能漂移（本报告所有引用都以**函数名 + 行号**双写，便于重新定位）。
4. **S-15 的定级刻意保守**：SQL 注入面存在但被 `node:sqlite` 的单语句限制与白名单表名限制收窄，本报告不宣称「可拖库/可删表」。
5. **S-11 无法用「闸门」解决**：这是台账口径问题（LLM token 未计量），本报告只要求「记账或显式告知」，不假设能在本波次内做完 LLM 计费。
6. **未覆盖的面**（超出本卡四个任务面，留给后续红队卡）：
   - `src/comfy.js` / `src/video.js` / `src/llm.js` 的出站请求是否存在 SSRF 面（工作流 JSON 由用户文件提供 `workflowPath`，`config.image.comfy.workflowPath` 可为任意路径 → 可能读到非预期文件）；
   - `vendor.js` 的 `parseCurl`（把用户粘贴的 curl 文本解析为配置）是否会把 `<script>` 类 payload 带进界面（前端 XSS 面）；
   - `deliver.js` 打包 zip 时的路径规范化（`zip` 内文件名是否可能带 `../`，即 zip-slip）；
   - 前端 `web/views/*.js` 的 HTML 拼接是否统一走 `s()` 转义（本次只看到个别位置）；
   - `scripts/*.js`（seed/tour/simulate）在真实库上的破坏性（这些脚本不在服务路径上，但会写真实 `data/`）。
