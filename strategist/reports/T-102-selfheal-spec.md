# T-102 · 阶段失败自愈换后端契约（v1 · 冻结稿）

> 任务卡：`strategist/tasks/T-102.yaml` ｜ 角色：架构 / 运维 / 文档军师（**只读侦察**，本文件是唯一产物）
> 依据：全部结论来自对现有源码的逐行阅读（`src/retry.js`、`src/video.js`、`src/comfy.js`、`src/backend-fit.js`、`src/graph.js`、
> `src/modules/render.js`、`src/studio.js`、`src/jobs.js`、`src/guard.js`、`src/skills.js`、`src/decisions.js`、`src/db.js`、`tests/*.js`），
> 附录 A 列出「结论 → 文件:行号」索引，实现者可直接核对。**本文件不写代码、不改任何既有文件。**

**一句话结论**：把「阶段失败」拆成 ①错误分类 → ②同后端重试一次 → ③沿单向降级链 `comfyui-h3 → generic-http → placeholder` 换后端一次 → ④
**先写告知记录、再执行生成**（写不进就不许换）；换后端只允许发生在**实例侧故障**上，内容/账号类错误一律不许换；
落到 `placeholder`（免费）可自动化，落到任何付费后端**必须重新走人工批准**。全程禁止静默：见 §1 五条硬不变量。

---

## 0. 术语与口径

| 术语 | 定义 | 依据 |
|---|---|---|
| **阶段** | 制片流水线的一个 stage：`brief/cast/novel/script/canvas/keyframe/video/finish/qc/deliver/publish` | `src/studio.js:30-44`（`STUDIO_STAGES`） |
| **后端** | 视频/出图的实际执行后端 id：视频 `placeholder \| comfyui-h3 \| generic-http`；出图 `placeholder \| openai-images \| generic-http \| comfyui` | `src/video.js:16-28`、`src/image.js:24-38` |
| **可自愈** | 不需要人改配置/充值/改提示词，系统自己换一个可用后端就能继续把阶段跑完 | 本契约 §2 |
| **换后端（degrade）** | 权威定义：**实际用于生成的后端 id 与本次操作的起点不同，并把这一事实写进告知字段与账本** | 本契约 §1 |
| **重试一次** | 同一个后端、同一份输入，再发起**一次**生成调用（既有的指数退避重试算作同一次调用内部行为） | 本契约 §7.2 |
| **告知** | 用户可在「任务详情 / 阶段卡片 / 镜头列表 / 决策时间线 / 交付包」任一处看到的那句话与字段 | 本契约 §5 |
| **付费后端** | `comfyui-h3`、`generic-http`（均会计入用量台账 `videos+1`，`capabilities` 里标记 `paid:true`） | `src/video.js:91`、`src/skills.js:175-176` |
| **免费后端** | `placeholder`（本地 ffmpeg 运镜，不进台账） | `src/video.js:22-23`、`src/video.js:91` |

**口径提醒（重要）**：本项目里 `placeholder` **不是**「真实视频生成」，它只是「有运动的关键帧」（`src/backend-fit.js:22` 原文：
「本地 ffmpeg 运镜：免费，但只是「有运动的关键帧」，不是真实视频生成」）。因此 `→placeholder` 是**画质级降级**，必须显式告知 + 人工复看，
绝不可当作「换了台机器重跑」轻描淡写。

---

## 1. 五条硬不变量（「禁止静默换后端」的可执行定义）

| # | 不变量 | 违反时的行为（fail-closed） |
|---|---|---|
| **I1** | **无告知不换**：换后端前必须先成功写入一条 `selfheal_events`，且 `notice` 非空、`to_backend` 非空、`event_id` 回填进产物 | 写库失败 / `notice` 为空 → **放弃换后端**，抛中文错误并保持原阶段为 `error`（`notify 为空时抛错，零生成调用`） |
| **I2** | **单向不反向**：只允许沿 `DEGRADE_CHAIN` 向后走；任何「升到更贵/更真」的跳（`placeholder → comfyui-h3`、`placeholder → generic-http`、`generic-http → comfyui-h3`）一律禁止 | 直接返回 `action:'hold-human'` + 中文建议，不生成 |
| **I3** | **付费不自动**：目标后端为付费后端时，换后端**不算自愈成功**，而是「生成一个新的执行计划 + 等待人工批准 + 确认码」（沿用 P4 闸门，`canvas_plan_audits` 记录 `created/approved/consumed`） | `action:'hold-human'`，阶段保持 `error` 并写明「已准备好降级方案：X → Y，需人工批准」 |
| **I4** | **内容不换**：`moderation`（审核）类错误**永久禁止**换后端 —— 换后端 = 换一个厂商绕过审核，属红线 | `healable:false, switchAllowed:false`，只给「改提示词/改画面/人工复核」的中文建议 |
| **I5** | **一次为限**：同一 `(scope, scope_id, stage, from_backend)` 只允许成功换一次后端（DB 唯一约束强制，跨重启生效） | 第二次触发 → `action:'hold-human'`，`notice` 里写明「本阶段已降级过 1 次（事件 X），不再自动降级」 |

> I1 是「禁止静默」的技术实现：**先落账、再执行**。只要生成调用发生了，账本里必有那条 `notice`；
> 反过来说，账本里没有的记录，就不可能发生过生成（测试用「生成调用计数 = 0」来证伪，见 §8.3）。

---

## 2. 错误分类表（可自愈 / 不可自愈）

### 2.1 分类来源：**复用 `src/retry.js`，不新增 kind、不改既有正则**

- `ERROR_KINDS`（11 类，`src/retry.js:6-18`）与 `classifyError()`（`src/retry.js:37-53`）是既有权威口径，
  已被 `tests/test-adapters.js:273-282`（归类表 10/10）、`tests/test-guard.js:159-160,174` 断言锁定。
- 因此本契约**不修改** `ERROR_KINDS`、不改 `RULES` 顺序、不改 `withRetry` 默认值（`DEFAULT_RETRY_KINDS = ['rate','server','network']`，
  `src/retry.js:73`），而是在新模块 `src/selfheal.js` 里增加一张 **`errorKind → 自愈动作`** 的映射表（§2.3 `healProfile`）。
  这样既不动既有公开签名，也不会让既有断言变红。
- 副作用（记入风险 R4）：少数含降级语义的报错会落到 `unknown`（例：`通用视频模板里没有 {{lastImage}} 占位符`，
  `src/video.js:221`），因此 §2.4 给出「报错样例 → kind」速查表，实现者按该表验证自己的判定是否正确。

### 2.2 主表：11 类 × 故障归属 × 是否可自愈 × 动作 × 判定依据

| errorKind | 中文标签（`ERROR_KINDS`） | `retryable` | 故障归属 | 可自愈？ | 自愈动作 | 判定依据（既有正则 / 状态码） | 允许换后端？ |
|---|---|---|---|---|---|---|---|
| `rate` | 触发限流（429） | ✅ | 实例侧（限流） | ✅ | 同后端退避重试 → 仍失败**可**换后端 | `/(^\|[^0-9])429([^0-9]\|$)\|rate[_ ]?limit\|too many requests\|限流\|请求过于频繁/i`（`retry.js:23`） | ✅（受 I3 付费闸门） |
| `server` | 服务端错误（5xx） | ✅ | 实例侧 | ✅ | 同上 | `/(^\|[^0-9])5\d\d([^0-9]\|$)\|internal server\|bad gateway\|服务端错误/i`（`retry.js:29`） | ✅（受 I3） |
| `network` | 网络异常（连接失败/被重置） | ✅ | 实例侧 | ✅ | 同上 | `/fetch failed\|ECONNRESET\|ECONNREFUSED\|ETIMEDOUT\|ENOTFOUND\|EAI_AGAIN\|socket hang up\|网络\|无法连接\|连接失败/i`（`retry.js:26`） | ✅（受 I3） |
| `timeout` | 请求超时 | ❌（默认不重试） | 实例侧 | ⚠️ 有条件 | **先探测原实例**：在线 → 不换（只延长等待/交人）；探测失败（容器已释放）→ 可换后端 | `/timeout\|timed out\|超时\|AbortError\|aborted/i`（`retry.js:25`）+ `probeVideoBackend(from)`（`video.js:298-315`） | ⚠️ 仅当探测失败 |
| `config` | 本地配置缺失或非法 | ❌ | 本地配置 | ⚠️ 优先前置拦截 | 阶段开跑前由 `backendFit()` 拦（block 级）；若仍在执行期出现 → 可沿链换到**已配置且探测通过**的下一跳 | `/未配置\|未启用\|缺少 path\|演员为空\|台词为空\|画布不存在\|请先/i`（`retry.js:28`） | ✅（受 I3） |
| `format` | 响应结构不符合配置的字段路径 | ❌ | 本地配置（本后端字段映射） | ⚠️ 可有条件换 | 只在目标是**免费**后端、或 `mode='allow-paid'` 时换；否则 `hold-human`（附「核对 `responseVideoPath` / `fieldMap`」建议） | `/找不到(图片\|音频\|视频)?字段\|不是合法 JSON\|非 JSON\|未返回图片\|未返回 scenes/i`（`retry.js:27`） | ⚠️ 受限 |
| `auth` | 鉴权失败（Key 无效或未授权） | ❌ | 账号侧 | ❌ | **停阶段** + 中文指引（换 Key / 换实例地址） | `/(^\|[^0-9])(401\|403)([^0-9]\|$)\|unauthor\|invalid[_ ]?api[_ ]?key\|authentication\|鉴权\|未授权\|api key/i`（`retry.js:21`） | ❌ |
| `quota` | 额度/余额不足 | ❌ | 账号侧 | ❌ | **停阶段** + 中文指引（充值 / 清零台账 / 改用免费占位） | `/insufficient\|quota\|balance\|billing\|欠费\|余额\|额度\|配额/i`（`retry.js:22`） | ❌（唯一例外：人工选择「降级到免费占位」，见 §9.2） |
| `moderation` | 内容审核不通过 | ❌ | 内容侧 | ❌ | **停阶段** + 「换后端不会解决审核问题」 | `/moderation\|content[_ ]?policy\|safety\|violat\|sensitive\|敏感\|审核\|违规/i`（`retry.js:24`） | ❌ **（I4 红线）** |
| `client` | 请求参数被厂商拒绝（4xx） | ❌ | 请求侧 | ❌ | **停阶段** + 「本镜参数被该厂商拒绝，先核对模板字段映射」 | `/(^\|[^0-9])4\d\d([^0-9]\|$)/`（`retry.js:30`） | ❌ |
| `unknown` | 未知错误 | ❌ | 未知 | ❌ | **停阶段** + 原文前 200 字 + 归类提示（不猜、不硬跑） | 兜底（`retry.js:40`） | ❌ |

**判定总则（三句话）**
1. **实例侧（rate/server/network/timeout-探测失败/config/format）→ 可自愈**：这类故障换后端真的能解决。
2. **账号侧（auth/quota）、请求侧（client）、内容侧（moderation）、未知 → 不可自愈**：换后端解决不了，或解决方式本身违规/花钱。
3. **`moderation` 永不换**（I4 红线）：这一条写成硬编码常量 + 单测断言（§8.3 第 2 条），任何配置都不能覆盖。

### 2.3 判定伪代码（`healProfile`，`src/selfheal.js` 导出）

```js
// src/selfheal.js 顶部：import { ERROR_KINDS, classifyError } from './retry.js';
// 输入：{ errorKind, status, probeOk }；输出：{ fault, healable, switchAllowed, action, advice }
export function healProfile({ errorKind = 'unknown', status = null, probeOk = null } = {}) {
  const kind = ERROR_KINDS[errorKind] ? errorKind : 'unknown';
  const base = HEAL_BY_KIND[kind];            // §2.2 主表的代码化（常量对象，见 §4.1）
  // ① 内容侧红线：任何配置都无法放开
  if (kind === 'moderation') return { fault: 'content', healable: false, switchAllowed: false, action: 'hold-human',
    advice: '换后端不会解决审核问题：请修改该镜提示词/画面内容后重跑，或人工复核这一镜' };
  // ② 超时：先看原实例是否还活着（活着 = 可能是排队/慢镜，换后端反而丢已跑的计算）
  if (kind === 'timeout') {
    return probeOk === false
      ? { fault: 'instance', healable: true, switchAllowed: true, action: 'degrade',
          advice: '原实例已不可用（探测未通过），可沿降级链换后端' }
      : { fault: 'instance', healable: false, switchAllowed: false, action: 'hold-human',
          advice: '原实例仍在运行：超时可能只是排队/慢镜，默认不换后端（生成类接口超时可能已在服务端跑完并计费）' };
  }
  return { fault: base.fault, healable: base.healable, switchAllowed: base.switchAllowed, action: base.action, advice: base.advice };
}
```

`action` 取值（全库统一，UI/Agent 都按这 4 个值渲染）：

| action | 含义 | 是否发生生成调用 |
|---|---|---|
| `retry-same` | 同后端重试一次（退避由 `withRetry` 负责） | ✅ 1 次 |
| `degrade` | 换后端后重跑一次（必须先过 I1/I3） | ✅ 1 次（`retries: 0`） |
| `hold-human` | 不自愈：停在这里，给出中文原因 + 可执行建议（含「已备好的降级方案」） | ❌ 0 次 |
| `stop` | 硬停（策略 `report`/`off`、闸门不允许、额度/鉴权/审核） | ❌ 0 次 |

### 2.4 报错样例 → kind 速查表（**验收自测用**，取自源码原文）

| 源码原文（节选） | 出处 | `classifyError().kind` | 期望动作 |
|---|---|---|---|
| `ComfyUI 视频生成超时（等待 900000ms 仍未完成…）` | `comfy.js:422` | `timeout` | 探测原实例 → 失败则 `degrade` |
| `ComfyUI 执行失败：{"status_str":"error"…}` | `comfy.js:387` | `unknown` | `hold-human`（附原文） |
| `该实例的「MiniMaxH3ImageToVideo」必须提供首帧图：请先渲染本镜关键帧…` | `comfy.js:265` | `config` | 前置拦截优先：`hold-human` + 建议先跑关键帧阶段 |
| `ComfyUI 工作流与实例不匹配（h3-image-to-video.workflow.json）：…` | `comfy.js:267` | `unknown` | `hold-human`（工作流与实例不匹配 = 必须人改配置/换实例） |
| `未配置通用视频接口 URL（设置 → 视频后端）` | `video.js:207` | `config` | 沿链换到已配置且探测通过的后端 |
| `通用视频模板里没有 {{lastImage}} 占位符，无法接收尾帧…` | `video.js:221` | `unknown`（字符串未命中既有正则） | `hold-human`；**不得**换到同样不支持尾帧的后端（§3.3 能力校验会拦） |
| `视频接口 429: rate limit…` | `video.js:242` | `rate` | `retry-same` → 仍失败 `degrade` |
| `视频接口 500: internal server error` | `video.js:242` | `server` | `retry-same` → 仍失败 `degrade` |
| `视频接口返回非 JSON：<html>…` | `video.js:243` | `format` | 受限换后端（见 §2.2） |
| `视频响应里找不到字段「data.0.url」：…` | `video.js:262` | `format` | 受限换后端 |
| `未找到 ffmpeg，无法生成本地运镜视频（请安装 ffmpeg 或改用云端视频后端）` | `video.js:120` | `config` | `hold-human`（连免费后端都不可用 → 停） |
| `缺少可用关键帧（请先渲染关键帧，或改用文生视频后端）` | `video.js:122` | `config` | `hold-human`；**禁止**换到 placeholder（它也必须有关键帧） |

---

## 3. 降级链与判定依据

### 3.1 链条（单向、有限、每跳都要过闸）

```
comfyui-h3  ──跳1──▶  generic-http  ──跳2──▶  placeholder  ──▶（终点，无下一跳）
   付费                  付费                    免费
真实视频生成          真实视频生成            「有运动的关键帧」（非真实视频）
```

```js
// src/selfheal.js
export const DEGRADE_CHAIN = {
  'comfyui-h3':  ['generic-http', 'placeholder'],
  'generic-http': ['placeholder'],
  'placeholder':  [],                       // 链尾：无下一跳，失败即 hold-human
};
export const FREE_BACKENDS = ['placeholder'];
export const PAID_BACKENDS = ['comfyui-h3', 'generic-http'];
```

> **为什么把跳1 默认关掉（`allowPaidSwitch:false`）**：`comfyui-h3` 与 `generic-http` **都是付费后端**
> （`video.js:91` 对非 placeholder 记 `videos+1`；`skills.js:175-176` 把 `video-comfy`/`video-generic` 标为 `paid:true, confirm:true`），
> 换到另一个付费后端 = **换一个计费主体并在未经批准的情况下再花钱**，与仓库既有的「付费必须人工批准 + 确认码」口径
> （`studio.js:863-875`、`mcp-tools.js` 的 `canvas_run` 需 `plan_id + confirm_code`）直接冲突。
> 因此跳1 **保留在链上但默认需要人工批准**（I3）；默认策略下 `comfyui-h3` 的实例侧故障走**直连跳2**（免费、可自动、必须告知）。

### 3.2 四种策略模式（`video.selfHeal.mode`）

| mode | 含义 | 允许换后端 | 适用 |
|---|---|---|---|
| `off` | 完全关闭自愈：错误只记录、不重试不换 | ❌ | 排查问题 / 需要逐步人工确认 |
| `report` | **只报告不换**：写账本 + 写告知 + 给建议，阶段标 `error` | ❌ | 商用交付、审核敏感、需要严格可复现 |
| `auto-free`（**默认**） | 允许 `→placeholder`（免费）自动执行；付费跳仍要人工批准 | ⚠️ 仅免费跳 | 日常自动化制片 |
| `allow-paid` | 额外允许 `comfyui-h3 → generic-http`，但**仍须**目标已获人工批准的计划（I3） | ✅（免费跳 + 已批准的付费跳） | 多厂商容灾、有备份供应商 |

**必须改用 `report` 的场景**（契约强制建议，落地时写进中文提示）：本片要做出海/商用交付、该镜已 `picked=1`、
`video.selfHeal.mode` 未显式设置而 `budget.monthlyCap` 已用超 80%、或本次是「质检/交付阶段」的重跑。

### 3.3 跳到下一跳的**四个前置条件**（缺一不换，返回 `stop`/`hold-human`）

| # | 条件 | 依据 / 调用 |
|---|---|---|
| **C1 目标可用** | `probeVideoBackend(to).ok === true`。`placeholder` 的探测是**真实**的 ffmpeg 检查（不是常量 true） | `video.js:298-315`（`placeholder` 分支调用 `hasFfmpeg()`，`video.js:30-36`） |
| **C2 能力够用** | `canDegradeTo()`：用 `factsFromProbe({backend:to, probe})` 与 `requirementsOf({scriptId, code, canvasId})` 逐项对齐：比例、单镜时长上限、首帧、**尾帧** | `backend-fit.js:26-83`（能力事实表）、`backend-fit.js:86-124`（本集需求） |
| **C3 闸门放行** | `pauseState().paused === false`（暂停期不换不跑，任务留在队列，对齐 `preflightBatch` 的暂停判定）；目标是付费后端时另过 `checkBudget()`；若已有「更贵的替代方案」`checkProductionBudget()` 兜底 | `jobs.js:19-24`、`modules/render.js:481-491`、`guard.js:82-107`、`guard.js:215-228` |
| **C4 账本可写** | `recordSelfHeal()` 成功（`notice`/`to_backend` 非空，唯一约束满足）→ 返回 `eventId`；失败则 **不换**（I1） | 本契约 §6、§7.3 |

**能力对比表（C2 的判定表，实现时直接落成 `degradationOf()` 常量）**

| 能力 | `comfyui-h3` | `generic-http` | `placeholder` |
|---|---|---|---|
| 真实视频生成（物理运动） | ✅ | ✅ | ❌ 仅关键帧运镜 |
| 首帧驱动（关键帧 → 视频） | ✅ i2v 模板（`pickComfyTemplate`，`comfy.js:145-149`） | ⚠️ 视模板是否含 `{{refImage}}/image` 占位符 | ✅ 但**必须已有可用关键帧**（`video.js:121-122`） |
| 尾帧过渡 | ⚠️ 视 `map.lastImageNode`（`backend-fit.js:55`） | ⚠️ 模板必须含 `{{lastImage}}`，否则**直接报错**（`video.js:218-223`） | ✅ 降级为**交叉溶解 xfade**（`video.js:144-163`，结果里 `raw.lastFrame='xfade'`） |
| 单镜时长 | 约 `perClipSeconds`（默认 5s，`backend-fit.js:61`） | 视厂商 | 不限（`duration` 由本机决定） |
| 画幅/比例 | 实例 `aspect_ratio` 清单（`pickAspectRatio`） | 模板 `width/height` | 全比例表（`resolveSize`，`video.js:177-182`） |
| 出片速度 | 45s（turbo）~120s/条 | 视厂商 | ≈1.4s/条（`modules/render.js:577`） |
| 音频 | H3 自带音轨（`raw.withAudio:true`，`comfy.js:404-416`） | 视厂商 | **无音轨**（`-an`，`video.js:142`） |
| 计费 | 付费 | 付费 | 免费 |
| 本地可复现 | 中（种子 + 模板） | 低 | 高（纯本地） |

> **实现注意（既有代码缺口，记风险 R1）**：`backend-fit.js:77` 把 `generic-http` 的 `supportsFirstFrame` 写成
> `/image|first|keyframe/i.test(tpl) || true` —— 恒为 `true`。C2 校验**不得**直接复用该字段，
> 必须自己检查模板占位符（`{{refImage}}`/`{{firstImage}}`/`{{image}}`），否则会「以为换过去支持首帧」而产出文生视频。

### 3.4 熔断与「一集一致性锁定」

真实故障形态是**实例整体挂掉**（H3 容器被回收）：30 个镜头会**逐个**失败。若逐镜自愈，会出现「换 30 次后端」的荒唐账。

```js
export const DEGRADE_TRIP_THRESHOLD = 3;    // 同阶段连续 3 个同类可自愈错误 → 触发阶段级降级（熔断）
export const LOCK_EPISODE_BACKEND = true;   // 触发后本集剩余镜头直接用新后端，不再逐个试
```

- **熔断**：按 `(stage, from_backend)` 计数，`selfheal_events` 或本次运行内的计数器达到 `tripThreshold` →
  一次**阶段级降级**（写 1 条事件、1 条 notice），后续镜头直接以新后端首发（`switches += 0`）。
- **一致性锁定**：同集内一旦发生 `degrade`，剩余未跑镜头**一律使用同一后端**，并在结果里写
  `consistency: { scope:'episode', locked:true, note:'本集自第 N 镜起改用 <to>，前后画风可能不一致，请人工复看' }`。
  理由与既有口径一致：README/`backend-fit.js:189` 已明确「全量后中途换 LoRA 会让前后画风不一致」。
- **降级比例告警**：同集降级镜头占比 ≥ `degradedRatioAlert`（默认 0.3）或 ≥5 镜 → 调用既有的
  `pauseQueues({ reason, by:'system' })`（`jobs.js:46-56`）暂停队列并中文告警，避免「整集被悄悄做成占位片」。

### 3.5 触发时机（三个层次，只在这三处挂载，别四处开花）

| 层次 | 挂载点 | 触发信号 | 自愈单位 |
|---|---|---|---|
| **L1 镜头级** | `src/modules/render.js` `runVideos()` / `runKeyframes()` 的 `catch`（`render.js:280-297`） | 单镜 `generateVideo()` 抛错 | 单镜 |
| **L2 节点级** | `src/graph.js` `runGraph()` 的 `catch`（`graph.js:766-779`），在既有 `withRetry` 用尽之后 | 节点执行失败（`meta.errorKind` 已落 `canvas_node_runs`） | 单节点 |
| **L3 阶段级** | `src/studio.js` `runStage()` 的 `catch`（`studio.js:881-884`）与 `reconcileStages()`（`studio.js:944-965`） | 阶段 job 终态 `error` | 整阶段（含熔断/锁定） |

三层共用 §4 的同一个纯函数 `planSelfHeal()` 与 §5 的同一份告知字段，**禁止各写一套判定**。
`reconcileStages()` 是付费阶段唯一的「终态回写点」（`studio.js:956-961`），因此付费阶段的自愈决策**必须**在那里对账后做出。

---

## 4. 自愈决策：函数签名与伪代码

### 4.1 新模块 `src/selfheal.js`（本契约要求新建；导出风格 `export function` / `export const`，全中文注释）

```js
// 阶段失败自愈：错误分类 → 同后端重试一次 → 沿单向降级链换后端一次 → 结果必须告知（禁止静默换后端）
// 设计口径：本模块只做「判定 + 记账 + 生成中文告知」，不直接发起生成调用；生成仍由既有适配器完成。
// 依赖（新文件只读既有模块，不反向依赖）：import { ERROR_KINDS, classifyError } from './retry.js';
//                                             import { loadConfig } from './config.js';  import { all, get, run } from './db.js';  import { nowISO, rid } from './util.js';

export const HEAL_ACTIONS = { RETRY_SAME:'retry-same', DEGRADE:'degrade', HOLD:'hold-human', STOP:'stop' };
export const HEAL_FAULTS  = { INSTANCE:'instance', ACCOUNT:'account', CONTENT:'content', PARAMS:'params', LOCAL:'local-config', UNKNOWN:'unknown' };
export const DEGRADE_CHAIN = { /* §3.1 */ };
export const FREE_BACKENDS = ['placeholder'];
export const PAID_BACKENDS = ['comfyui-h3', 'generic-http'];
export const MAX_SAME_BACKEND_RETRY = 1;      // 「重试一次」
export const MAX_SWITCHES_PER_SCOPE = 1;      // 每条 (scope,scope_id,stage,from) 只换一次
export const MAX_GENERATE_CALLS_PER_SHOT = 3; // 首发 + 同后端重试一次 + 换后端后一次（口径见 §7.2）
export const DEGRADE_TRIP_THRESHOLD = 3;
export const SELFHEAL_MODES = ['off', 'report', 'auto-free', 'allow-paid'];
export const NO_SWITCH_KINDS = ['moderation', 'auth', 'quota', 'client', 'unknown'];   // 硬编码红线

/** 自愈策略（从配置读，缺省即默认值；不修改 src/config.js 现有键） */
export function selfHealPolicy(cfg = loadConfig()) {
  // → { mode:'auto-free', maxSameBackendRetry:1, maxSwitchesPerScope:1, tripThreshold:3,
  //     lockEpisodeBackend:true, allowFreeFallback:true, allowPaidSwitch:false, requireProbe:true, degradedRatioAlert:0.3 }
}

/** §2.3：错误 → 故障归属与动作（纯函数，无副作用） */
export function healProfile({ errorKind, status, retryable, probeOk } = {}) { /* … */ }

/** 降级链下一跳；used 为本次已用过的后端，allow 为策略允许的目标（如 ['placeholder']） */
export function nextBackend({ from, chain = DEGRADE_CHAIN, used = [], allow = null, probeOf = null } = {}) {
  // 返回 string | null；跳过不在 allow 内、或 probeOf(x).ok===false 的候选（C1）
}

/** C2：目标后端能力是否满足本集需求（复用 backend-fit 的能力事实表与需求表） */
export function canDegradeTo({ to, facts = null, needs = null, cfg = loadConfig() } = {}) {
  // → { ok:boolean, missing:string[], reason:string }   missing 例：['尾帧过渡（模板缺 {{lastImage}}）']
}

/** 单次自愈决策（纯函数；已把所有副作用抽成入参，便于单测离线跑） */
export function planSelfHeal({
  error = null,                // Error（已 tagError 过，带 errorKind/errorLabel/status）
  errorKind = null, from = null, stage = null, scope = 'shot', scopeId = null,
  attempts = 1,                // 累计生成调用次数（含本次失败）
  switches = 0,                // 已成功换过的次数（跨重启由 selfheal_events 提供）
  probeFrom = null,            // probeVideoBackend(from) 的结果（timeout 阶梯判定用）
  probeOf = null,              // (backend) => Promise<{ok,detail}> 注入，便于离线假实例
  factsOf = null, needs = null,
  paused = false, budget = null,
  cfg = loadConfig(),
} = {}) { /* → SelfHealPlan */ }

/** 能力损失/保留/费用口径（§3.3 表的代码化） */
export function degradationOf({ from, to, need = null } = {}) {
  // → { lostCapabilities:[], keptCapabilities:[], costImpact:{ from:'paid'|'free', to, currency, unit, note, usageRecorded } }
}

/** §5.3 中文告知模板（唯一实现，禁止各处重写文案） */
export function degradeNotice(rec = {}) { /* → string（非空） */ }

/** 写账本；notify 为空 / to_backend 为空 → 抛中文错误（I1，fail-closed） */
export function recordSelfHeal(ev = {}) { /* → selfheal_events 行 */ }

/** 只读查询（界面 / 时间线 / MCP 共用） */
export function selfHealEvents({ productionId=null, canvasId=null, scope=null, scopeId=null, action=null, limit=50 } = {}) {}

/** 汇总（任务详情 / 阶段 artifact / 交付包共用） */
export function degradeSummary(events = []) {
  // → { count, healed, switched, pairs:['comfyui-h3→placeholder'], notices:[...], needsHumanReview:boolean, backends:{from,to} }
}
```

**`SelfHealPlan` 返回结构（与 §5.1 的 `degrade` 字段同名同义，避免两套口径）**

```js
{
  action: 'retry-same' | 'degrade' | 'hold-human' | 'stop',
  toBackend: string | null,
  requiresApproval: boolean,          // to 为非免费后端时为 true（I3）
  reason: string,                     // 中文，给日志/阶段 error
  advice: string,                     // 中文可执行建议（hold-human 时必填）
  notice: string,                     // 中文告知（degrade 时必填、非空）
  lostCapabilities: string[],
  keptCapabilities: string[],
  costImpact: object,
  consistency: { scope, locked, note },
  attempts: number,
  chainIndex: number,
  blockedBy: 'C1'|'C2'|'C3'|'C4'|null,   // 被哪个前置条件拦下（便于回归定位）
}
```

### 4.2 决策伪代码（`planSelfHeal` 主体）

```
1. kind = error.errorKind || classifyError(error).kind
2. profile = healProfile({ errorKind:kind, status:error.status, probeOk:probeFrom?.ok })
3. attempts >= maxGenerateCallsPerShot(3)              → { action:'stop', reason:'本镜已尝试 N 次，达到上限' }
4. policy.mode === 'off'                               → { action:'stop', reason:'自愈已关闭（video.selfHeal.mode=off）' }
5. paused === true                                     → { action:'stop', reason:'队列处于暂停态，不换后端不提交（任务保留）' }
                                              // C3，对齐 jobs.js:19-24 / preflightBatch 的暂停判定
6. profile.action === 'hold-human' 或 NO_SWITCH_KINDS 含 kind
                                                       → { action:'hold-human', advice:profile.advice }（I4：moderation 永不换）
7. profile 可退避重试（kind ∈ rate/server/network）且 attempts === 1
                                                       → { action:'retry-same' }（退避由 withRetry 负责；这是「重试一次」）
8. kind === 'timeout' 且 probeFrom?.ok !== false        → { action:'hold-human', advice:'原实例仍在运行，默认不换' }
9. switches >= maxSwitchesPerScope                      → { action:'hold-human',
                                                           advice:`本阶段已自动降级过 1 次（事件 ${lastEventId}），不再自动降级` }（I5）
10. policy.mode === 'report'                             → { action:'stop', reason:'当前为只报告模式（report），已把降级方案写入账本' }
11. allow = policy.allowFreeFallback ? ['placeholder'] : []
    if (policy.mode === 'allow-paid' && policy.allowPaidSwitch) allow = ['generic-http', ...allow]
12. to = nextBackend({ from, used:[from], allow, probeOf })     // C1：逐个候选探测，全不过 → null
    if (!to)                                            → { action:'hold-human', advice:'链上没有可用后端：…（逐个候选的探测原因）' }
13. canDegradeTo({ to, facts: factsOf(to), needs })      // C2
    if (!ok) → 跳过该候选继续链上下一跳；都不过 → { action:'hold-human', advice:'能力不满足：<missing>' }
14. requiresApproval = PAID_BACKENDS.includes(to)        // I3
    if (requiresApproval && !已获人工批准的计划)          → { action:'hold-human',
                                                           advice:'已备好降级方案 from→to：请人工批准后执行（付费后端不会自动切换）' }
15. d = degradationOf({ from, to, need: needs }); n = degradeNotice({ ... })
16. → { action:'degrade', toBackend:to, requiresApproval, notice:n, lostCapabilities:d.lost, ... , attempts: attempts+1 }
```

**调用预算（`attempts` 的准确语义，决定第 3/7/9 步何时触发）**

| 错误类型 | 首发 | 同后端重试 | 换后端后 | 合计调用 | 说明 |
|---|---|---|---|---|---|
| `rate` / `server` / `network`（可退避重试） | 1 | 1 | 1 | **3** | `attempts=1` 走第 7 步；`attempts=2` 才允许换后端（第 12 步） |
| `timeout`（探测原实例失败）/ `config` / `format`（受限） | 1 | 0 | 1 | **2** | 第 7 步按 kind 短路，直接进降级判定 |
| `auth` / `quota` / `moderation` / `client` / `unknown` | 1 | 0 | 0 | **1** | 第 6 步即 `hold-human`，不换不重试 |

**执行侧的顺序（不可调换）**：`planSelfHeal` → **`recordSelfHeal`（C4，写库成功拿到 `eventId`）** → 探测已完成 →
以 `to` 后端发起**一次**生成（`retries: 0`，`only: []`，避免与既有退避叠加）→ 把 `degrade` 对象写进产物 meta（§5.2）。
若第 3 步写库失败：**终止自愈**，抛中文错误 `未能写入降级告知记录，已放弃切换后端（禁止静默换后端）`，且生成调用计数必须为 0。

---

## 5. 「必须告知用户降级了什么」的字段契约

### 5.1 `degrade` 对象（**权威字段表**；JSON camelCase，落库时 `JSON.stringify`）

| 字段 | 类型 | 必填 | 取值 / 说明 |
|---|---|---|---|
| `healed` | boolean | ✅ | 是否真的换了后端（`false` = 只重试过或只报告） |
| `action` | string | ✅ | `retry-same` / `degrade` / `hold-human` / `stop` |
| `errorKind` | string | ✅ | `src/retry.js` 的 kind（11 类之一） |
| `errorLabel` | string | ✅ | 中文标签（`ERROR_KINDS[kind].label`） |
| `errorExcerpt` | string | ✅ | 原始报错前 200 字（**不得**吞掉厂商原文） |
| `from` | string | ✅ | 原后端 id |
| `to` | string \| null | `healed=true` 时必填 | 目标后端 id |
| `attempts` | number | ✅ | 累计生成调用次数（含换后端后那次） |
| `chainIndex` | number | ✅ | 走到降级链第几跳（0 = 未换，1 = 跳1，2 = 跳2） |
| `lostCapabilities` | string[] | `healed=true` 时**字段必须存在**（可为空数组） | 中文能力名，例：`['真实视频生成（物理运动）','自带音轨','单条 5s 以上时长']` |
| `keptCapabilities` | string[] | ✅ | 仍保留的能力，例：`['首帧驱动','关键帧一致性','首尾帧过渡（降级为交叉溶解）']` |
| `costImpact` | object | ✅ | `{ from:'paid'\|'free', to:'paid'\|'free', currency, unit, note(中文), usageRecorded:boolean }` |
| `consistency` | object | ✅ | `{ scope:'episode'\|'shot'\|'node', locked:boolean, note(中文) }` |
| `needsHumanReview` | boolean | ✅ | `healed=true` 时**恒为 `true`**（降级产物必须人工复看） |
| `requiresApproval` | boolean | ✅ | 目标为付费后端时 `true`（本次未执行，仅告知） |
| `eventId` | string \| null | `healed=true` 时必填 | `selfheal_events.id`（`SH-xxxx`） |
| `notice` | string | ✅ **非空** | 中文告知一句话（模板见 §5.3） |
| `at` | string | ✅ | ISO 时间（`nowISO()`） |
| `probe` | object | 建议 | `{ from:{ok,detail}, to:{ok,detail} }`（C1 证据） |
| `matched` | object | 建议 | `{ ratioOk, durationOk, firstFrameOk, lastFrameOk }`（C2 证据） |
| `blockedBy` | string \| null | 建议 | `C1`/`C2`/`C3`/`C4`（被哪个前置条件拦下） |

**字段级不变量（校验/测试直接断言）**

1. `healed === true` ⟺ `to !== null && eventId !== null && notice.length > 0 && Array.isArray(lostCapabilities) && needsHumanReview === true`。
2. `notice` 为空字符串 → `recordSelfHeal()` 抛中文错误，**且 0 次生成调用**（I1）。
3. `healed === true` 且 `costImpact.to === 'paid'` ⟹ `requiresApproval === true`（I3）。
4. `errorKind === 'moderation'` ⟹ `healed === false && action === 'hold-human'`（I4）。
5. 同一 `(scope, scope_id, stage, from)` 的 `healed=true` 记录全库唯一（I5，DB 唯一索引，§6）。

### 5.2 落地位置矩阵（**这是「用户到底在哪看到」的答案**）

| # | 位置（表 / 字段路径） | 写入者 | 用户可见面 | 说明 |
|---|---|---|---|---|
| 1 | `shot_renders.meta.degrade` | `modules/render.js` `runVideos/runKeyframes` | 制作台镜头列表 / 版本列表 | 单镜级权威记录（`meta` 现已有 `{elapsedMs, raw, keyframe}`，`render.js:288-291`） |
| 2 | `shot_renders.error` 末尾追加 `notices` | 同上（失败态） | 失败镜头清单 | **不替换**原文，格式：`<原文> ｜ ⚠️ 已降级：<notice>` |
| 3 | `canvas_node_runs.meta.degrade` | `graph.js` `runGraph` | 画布节点右键「执行记录」 | 节点级；`meta` 现已有 `{elapsedMs, attempts, placeholder, single, raw}`（`graph.js:755`） |
| 4 | `canvas_node_runs.backend` | `graph.js` | 节点徽章 | 语义强化：写**实际使用**的后端（不是配置里的） |
| 5 | `jobs.result.degradeSummary` | 各 job handler / `runGraph` 汇总 | 任务详情面板 | `{ count, healed, switched, pairs:['comfyui-h3→placeholder'], notices:[...], needsHumanReview }` |
| 6 | `production_stages.artifact.degrade` | `studio.js` `runStage` / `reconcileStages` | 制片阶段卡片 | 数组（一个阶段可能多镜降级），元素即 §5.1 对象 |
| 7 | `production_stages.artifact.degradeSummary` | 同上 | 制片阶段卡片 | §5 汇总结构 |
| 8 | `production_stages.warnings`（**已有列**，`db.js:317-327`） | `studio.js` `setStage` | 阶段卡片告警 | 追加纯文本 `notice`（既有 `setStage` 已支持 `warnings` 入参，`studio.js:283/289`） |
| 9 | `production_stages.error` | `studio.js` | 阶段卡片 | `hold-human`/`stop` 时：`中文原因 + 「已尝试：…；建议：…」` |
| 10 | `productions.warnings`（**已有列**） | `studio.js` | 制片项目页 | 汇总一条：「本片发生 N 次后端降级（事件 …），交付前请人工复看」 |
| 11 | `episode_films.meta.degradeSummary` + `meta.degradedOnly` | `modules/render.js` `createAssembleJob` | 成片列表徽章 | **交付物级**：本集是否含降级镜头（`meta` 现写 `{subtitles, audio, fades, loudness, missingShots}`，`render.js:378-383`） |
| 12 | 交付包 `manifest.degraded[]` | `deliver.js`（**后续卡**，本卡只约定形状） | 交付包生产报告 | 元素 `{ shotId, kind, from, to, errorKind, notice, eventId }` |
| 13 | 决策时间线事件 | `decisions.js`（只读聚合 `selfheal_events`） | 决策时间线页 | `{ kind:'stage', icon:'🔻', actor:'system', decide:false, title:`阶段自愈换后端：${STAGE_TEXT[stage]} ${from}→${to}`, detail:notice }`；`summary` 增加 `degraded` 计数 |
| 14 | `GET /api/render/selfheal` | `routes/render.js`（新增只读路由） | 界面 / 外部 | `?productionId=&canvasId=&scope=&scopeId=&limit=` → `{ ok:true, events:[…], summary:degradeSummary(events) }` |
| 15 | MCP 只读工具 `selfheal_events` | `mcp-tools.js`（可选，`level: READ`） | Agent | 让 Agent 能回答「这次跑有没有偷偷换后端」 |

> 写入者只在**自己的层**写：镜头层不写阶段行，阶段层不写镜头行；跨层的统一入口是 `degradeSummary()` + `selfheal_events`。

### 5.3 中文告知模板（**唯一实现 `degradeNotice()`，禁止各处重写文案**）

```
⚠️ 已自动降级后端：{from} → {to}（原因：{errorLabel}；同后端已重试 {retryTimes} 次仍失败）。
损失：{lostCapabilities.join('、') || '无（能力等价）'}。
保留：{keptCapabilities.join('、')}。
费用：{costImpact.note}。
一致性：{consistency.note}。
请人工复看后再交付（事件 {eventId}）。
```

**实例（`comfyui-h3 → placeholder`，`server` 类故障）**

```
⚠️ 已自动降级后端：comfyui-h3 → placeholder（原因：服务端错误（5xx）；同后端已重试 1 次仍失败）。
损失：真实视频生成（物理运动）、自带音轨、单条 5s 以上时长。
保留：首帧驱动、关键帧一致性、首尾帧过渡（降级为交叉溶解）。
费用：本条由真实视频后端（付费，已记 1 条用量）降级为本地免费运镜，后续镜头不再计费。
一致性：本集自第 7 镜起改用 placeholder，前后画风可能不一致，请人工复看。
请人工复看后再交付（事件 SH-2f1c9a）。
```

**实例（`comfyui-h3 → generic-http`，需人工批准时）**

```
⚠️ 已备好降级方案：comfyui-h3 → generic-http（原因：网络异常（连接失败/被重置）；同后端已重试 1 次仍失败）。
generic-http 与 comfyui-h3 同属付费后端：换供应商会再次计费，**不会自动执行**，请人工批准后重跑本镜（事件 SH-77ab31）。
```

### 5.4 一句话规则（给界面/文档直接引用）

> **任何一次后端变化，都能在「镜头 meta / 节点 meta / 任务 result / 阶段 artifact+warnings / 成片 meta / 决策时间线 / `GET /api/render/selfheal`」里找到同一条 `notice` 与同一个 `eventId`。**

---

## 6. 表结构：`selfheal_events`（自愈账本，跨重启的「已换过一次」凭据）

### 6.1 DDL（SQLite；`rid('SH')` 生成 id，命名/索引风格对齐 `db.js` 现有表）

```sql
-- 阶段失败自愈账本：每一次「重试 / 换后端 / 交人处理」都留一行；notify 非空是「禁止静默换后端」的落库保证
CREATE TABLE IF NOT EXISTS selfheal_events (
  id            TEXT PRIMARY KEY,          -- rid('SH')
  scope         TEXT NOT NULL,             -- shot | node | stage
  scope_id      TEXT NOT NULL,             -- shotId | nodeId | productionId
  production_id TEXT,                      -- 制片项目（可空）
  canvas_id     TEXT,                      -- 画布（可空）
  job_id        TEXT,                      -- 触发的任务 id（可空）
  stage         TEXT,                      -- keyframe | video | finish | …（可空）
  shot_id       TEXT,
  node_id       TEXT,
  error_kind    TEXT NOT NULL,             -- retry.js 的 kind
  error_label   TEXT,                      -- 中文标签
  error_excerpt TEXT,                      -- 原文前 200 字
  from_backend  TEXT NOT NULL,             -- 原后端
  to_backend    TEXT,                      -- 目标后端（不换则为 NULL）
  action        TEXT NOT NULL,             -- retry-same | degrade | hold-human | stop
  attempt       INTEGER DEFAULT 1,         -- 该 scope_id 的累计生成调用次数
  chain_index   INTEGER DEFAULT 0,         -- 降级链第几跳
  ok            INTEGER DEFAULT 0,         -- 换后端后是否成功（1/0）
  lost          TEXT,                      -- JSON 数组（中文能力名）
  kept          TEXT,                      -- JSON 数组
  cost_impact   TEXT,                      -- JSON（§5.1 costImpact）
  consistency   TEXT,                      -- JSON（§5.1 consistency）
  notify        TEXT NOT NULL,             -- 中文告知（**NOT NULL，空串即视为非法**）
  meta          TEXT,                      -- JSON：probe / matched / blockedBy 等证据
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_selfheal_scope  ON selfheal_events(scope, scope_id, created_at);
CREATE INDEX IF NOT EXISTS idx_selfheal_prod   ON selfheal_events(production_id, created_at);
CREATE INDEX IF NOT EXISTS idx_selfheal_kind   ON selfheal_events(error_kind, created_at);
-- I5 的数据库级强制：同一 (scope, scope_id, stage, from_backend) 只允许成功换一次后端
CREATE UNIQUE INDEX IF NOT EXISTS idx_selfheal_once
  ON selfheal_events(scope, scope_id, stage, from_backend)
  WHERE action = 'degrade' AND ok = 1;
```

### 6.2 建表方式（二选一，按并发隔离需要）

| 方案 | 做法 | 取舍 |
|---|---|---|
| **A（推荐，符合矩阵「新模块优先」）** | `src/selfheal.js` 内 `let schemaReady = false; export function ensureSelfHealSchema()`，幂等 `CREATE TABLE IF NOT EXISTS` + `PRAGMA table_info` 补列 | 与 `ensureStudioSchema()`（`studio.js:64-92`）、`ensureGraphSchema()`（`graph.js:66`）完全同款；**不动 `db.js`**，避免与其他并行任务卡抢同一文件 |
| B | 写进 `src/db.js` 的 `SCHEMA` 并把 `SCHEMA_VERSION` 13 → 14（`db.js:20`） | 更「正统」，但 `db.js` 是并行会话的高冲突文件 |

> 契约建议 A；若选 B，必须在任务卡里把 `src/db.js` 加进 `write_scope`（当前 T-102 只有本 md，**实现卡需另开并声明该文件**）。

### 6.3 新增配置项（`src/config.js` 的 `DEFAULT_CONFIG.video.selfHeal`，**全部为新增键，不改现有键**）

```js
selfHeal: {
  mode: 'auto-free',            // off | report | auto-free | allow-paid
  maxSameBackendRetry: 1,       // 「重试一次」
  maxSwitchesPerScope: 1,       // 每条 scope 只换一次后端
  maxGenerateCallsPerShot: 3,   // 首发 + 同后端重试一次 + 换后端后一次
  tripThreshold: 3,             // 连续 3 个同类可自愈错误 → 熔断为阶段级降级
  lockEpisodeBackend: true,     // 一集内一致性锁定
  allowFreeFallback: true,      // 允许 → placeholder（免费）
  allowPaidSwitch: false,       // 允许 comfyui-h3 → generic-http（仍须人工批准）
  requireProbe: true,           // C1：目标必须探测通过
  degradedRatioAlert: 0.3,      // 同集降级比例告警阈值 → 暂停队列
},
```

---

## 7. 幂等与重试上限

### 7.1 幂等：三层键，全部复用既有机制

| 层 | 幂等键 | 既有实现 | 自愈场景下的语义 |
|---|---|---|---|
| 节点 | `input_fp = sha1({kind, params(stable), inputs, upstream}) .slice(0,16)` | `graph.js:232-243`、`shouldSkip()` `graph.js:307-311` | 同指纹 + 已有 `done` 产物 → 跳过，**不重复生成** |
| 镜头 | `(shot_id, kind)` 最新 `status='done'` 存在则跳过；`overwrite=true` 才重跑 | `modules/render.js:265-268`、`retryFailedRenders({overwrite:true})` `render.js:552-553` | 换后端后 `backend` 不同 → 作为**新版本行**插入，旧行保留（`shot_renders` 一行一版本 + `picked`） |
| 阶段 | `production_stages.status='done'` 默认跳过（`force=true` 才重跑） | `studio.js:860`、`runPipeline` `studio.js:903` | 自愈**只重跑失败的镜/节点**，绝不重跑已 `done` 的部分 |

**必须遵守的两条幂等纪律**

1. **指纹不被自愈污染**：`degrade`/`lastDegrade`/`lastBackend` 等自愈状态键**必须**加进 `graph.js:57` 的 `VOLATILE_DATA_KEYS`
   （否则每写一次自愈状态，`input_fp` 就变一次，下游会全量重算），且**不得**直接改 `canvas_nodes.data.backend`。
   换后端通过**本次执行的入参**传递（`execNode → generateVideo({ backend: params.backend })`，`graph.js:525` 已支持该入参），
   不写回节点参数。
2. **不覆盖人工选择**：`shot_renders.picked=1`（`db.js:355` 新增列，`pickRender()` `render.js:172`）的镜头
   **禁止**被自愈产物覆盖或改变 `picked`；自愈产物一律 `picked=0`，并在 `notice` 里注明「该镜已有人工采用版本，本次降级产物另存为候选」。

### 7.2 重试上限（三张表，全部可断言）

| 口径 | 值 | 说明 |
|---|---|---|
| **同后端重试** | `maxSameBackendRetry = 1`（**「重试一次」**） | 阶段级自愈路径自身发起的额外重试；既有 `withRetry` 的退避（`video.generic` retries=2、出图 retries=2）算作「同一次生成调用内部行为」，**不改**其默认值（`retry.js:74`） |
| **换后端次数** | `maxSwitchesPerScope = 1` | 每个 `(scope, scope_id, stage, from_backend)` 一次；DB 唯一索引兜底（§6.1），**跨重启有效** |
| **单镜生成调用上限** | `maxGenerateCallsPerShot = 3` | 口径：**一次生成调用 = 一次 `generateVideo()`/`generateImage()` 包裹**（含其内部退避）；即 `首发 + 同后端重试一次 + 换后端后一次`（见 §4.2 调用预算表；不可退避类最多 2 次，不可自愈类恒为 1 次）；换后端后那次必须 `retries:0, only:[]`，防止与既有退避叠加 |
| **熔断阈值** | `tripThreshold = 3` | 同阶段连续 3 个同类可自愈错误 → 一次性阶段级降级（此后本集锁定后端，不再逐镜试） |
| **降级比例告警** | `degradedRatioAlert = 0.3` | 同集降级镜 ≥30% → `pauseQueues()`（`jobs.js:46-56`）+ 中文告警 |
| **阶段重跑** | 沿用 `force` 语义 | 阶段已 `error` 可重跑；重跑时 `switches` 由账本读回，已换过 → `hold-human`（I5） |

**既有重试叠加现状（必须知道，避免新代码再叠一层）**：`graph.runGraph` 外层 `withRetry(retries=DEFAULT_RETRIES=1)`
（`graph.js:36`、`graph.js:738-747`）包裹 `execNode`，而 `generateImage` 内部还有一层 `withRetry(image.retries=2)`
（`image.js:95-108`）、`generateVideo` 的 `generic-http` 分支也有 `withRetry(video.retries=2)`（`video.js:86`）。
即现状最坏可达 2×3 次调用。本契约**不要求**改动这些默认值（会碰既有断言，见 `tests/test-graph.js:427-468`、
`tests/test-adapters.js:302`），只要求**新增的换后端那一次调用 `retries:0`**，并把「单镜上限」口径写进日志与告知（`attempts`）。

### 7.3 跨重启与并发

- **跨重启**：`jobs.js` 的 `recoverStaleJobs()`（`jobs.js:199-208`）会把中断任务标 `error`；自愈决策读
  `selfheal_events` 判断「本阶段是否已降级过」，因此重启后**不会**再自动换一次（I5）。
- **并发**：同一 `productionId` 的阶段由 `jobs` 队列串行（`type:'studio'`），不存在同阶段并发自愈；
  `selfheal_events` 的唯一索引是最后一道防线（并发写时第二条会被 DB 拒绝 → 走 `hold-human`）。
- **取消优先**：`jobs.js:174-179` 的取消语义不变 —— 用户取消时不得把 `canceled` 翻成 `error`/`done`，
  自愈也**不得**在 `isCanceled()` 为真时继续（`render.js:265`、`graph.js:676-679` 已有判定，自愈路径必须复用）。

---

## 8. 落地挂载点与最小改动清单

### 8.1 新增文件

| 文件 | 内容 | 备注 |
|---|---|---|
| `src/selfheal.js` | §4.1 的全部导出 + `ensureSelfHealSchema()` | **新文件**，符合矩阵「新模块优先」 |
| `tests/test-selfheal.js` | §8.3 断言清单 | 临时库 + 离线假实例 |

### 8.2 改动点（每处都是小改；**实现卡必须把对应文件写进自己的 write_scope**）

| 文件 | 改动 | 精确位置 |
|---|---|---|
| `src/graph.js` | `runGraph` 的 catch 里：`withRetry` 用尽后调 `planSelfHeal()`；`degrade` 时以新后端重跑节点一次并把 `degrade` 写进 `recordRun({meta:{...}})`；`VOLATILE_DATA_KEYS` 增加 `degrade`/`lastDegrade`/`lastBackend` | `graph.js:57`、`graph.js:766-779` |
| `src/modules/render.js` | `runVideos/runKeyframes` 的 catch 调 `planSelfHeal()`；`insertShotRender` 的 `meta` 带 `degrade`；`createAssembleJob` 写 `episode_films.meta.degradeSummary` | `render.js:280-297`、`render.js:105-115`、`render.js:378-383` |
| `src/studio.js` | `runStage` catch 与 `reconcileStages` 里做阶段级决策（含熔断/一致性锁定）；`setStage(..., {warnings})` 追加 `notice`；`updateProduction` 汇总 `productions.warnings` | `studio.js:881-884`、`studio.js:944-965` |
| `src/decisions.js` | 新增只读来源：`selfheal_events` → `kind:'stage', icon:'🔻'` 事件；`summary.degraded` 计数 | `decisions.js:143-156`（与队列暂停历史同款写法） |
| `src/routes/render.js` | 新增只读路由 `GET /api/render/selfheal` | 与 `GET /api/render/backend-fit`（`routes/render.js:265`）同款 |
| `src/mcp-tools.js`（可选） | 只读工具 `selfheal_events` | 与 `render_backend_fit`（`mcp-tools.js:797`）同款 |
| `src/config.js` | `DEFAULT_CONFIG.video.selfHeal` 新键（§6.3） | `config.js:73` 起 `video` 段 |
| `src/db.js` **或** `src/selfheal.js` | `selfheal_events` 建表（§6.2 方案 A/B 二选一） | 方案 A 优先 |

### 8.3 测试要求（`tests/test-selfheal.js`；**临时库 + 离线假实例**，不起服务、不跑 `verify-all.sh`）

约定（照抄同目录既有测试）：`FACTORY_DB` / `FACTORY_DATA_DIR` / `FACTORY_CONFIG` 指向 `fs.mkdtempSync`；
`probeOf`/`executors` 注入假实现，**零外网、零真实计费**；断言用「生成调用计数」证伪。

| # | 断言（中文用例名） | 关键期望 |
|---|---|---|
| 1 | 错误分类映射表 11 类逐一正确 | 每类的 `fault/healable/switchAllowed/action` 与 §2.2 主表一致 |
| 2 | **审核类永不换后端** | `errorKind='moderation'` → `hold-human`，且假实例调用计数 = 0 |
| 3 | 降级链顺序与跳数 | `nextBackend({from:'comfyui-h3'})` = `generic-http`→`placeholder`；`placeholder` 无下一跳 |
| 4 | C1：目标探测不通过则不换 | `probeOf` 返回 `{ok:false}` → `hold-human`，`blockedBy='C1'` |
| 5 | C2：能力不满足则跳过该跳 | 需要尾帧 + `generic-http` 模板无 `{{lastImage}}` → 跳到 `placeholder` 或停，**不得**换到 generic-http |
| 6 | C3：暂停态不自愈 | `paused=true` → 不换、不跑，`blockedBy='C3'` |
| 7 | C4：告知写不进去就不换 | `notice=''` → `recordSelfHeal` 抛中文错，生成调用计数 = 0 |
| 8 | I3：付费跳必须人工批准 | `to='generic-http'` → `requiresApproval=true`，且**未发生**生成调用 |
| 9 | I5：同一 scope 只换一次 | 第二次 `degrade` 被唯一索引拒绝 → `hold-human`，`notice` 提到首次 `eventId` |
| 10 | 上限：单镜 ≤3 次生成调用 | 三连失败后 `attempts` 不再增长，`action='stop'`；不可退避类 ≤2 次；不可自愈类恒为 1 次 |
| 11 | 熔断：连续 3 个同类 → 阶段级降级 | 第 4 个镜头直接以新后端首发（`switches` 仍为 1） |
| 12 | 一致性锁定 | 本集首镜降级后，其余镜头 `degrade.consistency.locked=true` 且使用同一后端 |
| 13 | 幂等：同 `input_fp` + 已有 done → 不重复生成 | 复用既有 `shouldSkip` 语义，生成计数不变 |
| 14 | 不污染指纹 | 自愈状态写入后 `inputFingerprint()` 结果**不变** |
| 15 | 不覆盖人工选择 | `picked=1` 的镜头自愈产物 `picked=0` 且原行不变 |
| 16 | 告知可达性 | `shot_renders.meta.degrade` / `canvas_node_runs.meta.degrade` / `jobs.result.degradeSummary` / `production_stages.warnings` / `GET /api/render/selfheal` 五处都能读到同一 `eventId` 与同一 `notice` |
| 17 | 既有口径不回归 | `ERROR_KINDS` 键集合、`classifyError` 对既有样例的输出、`DEFAULT_RETRY_KINDS` 快照断言不变 |

---

## 9. 风险与不适用场景

### 9.1 R1–R8（实现前必读）

| # | 风险 | 证据 | 影响 / 处置 |
|---|---|---|---|
| **R1** | `backend-fit.js:77` 的 `supportsFirstFrame` 恒为 `true`（`\|\| true`） | `backend-fit.js:77` | C2 若直接复用该字段会误判「通用 HTTP 支持首帧」；契约要求自行检查模板占位符 |
| **R2** | 既有重试叠加（graph 外层 1 × 出图内层 2 ≈ 最多 6 次调用） | `graph.js:36,738`；`image.js:95-108`；`video.js:86` | 换后端那次必须 `retries:0`；「单镜 ≤3 次（不可退避类 ≤2 次）」口径按「一次包裹 = 一次调用」定义；真实最坏耗时可能很长，需在 `hold-human` 建议里提示 |
| **R3** | `pickComfyTemplate` 有**静默回退**：实例不支持首帧时自动 `i2v → t2v`，只把原因塞进 `warnings`、不阻断 | `comfy.js:145-148`、`comfy.js:253-256` | 这是**同一后端内部**的静默降级，本契约要求把 `warnings` + `raw.templateKind` 提升为 `degrade` 对象（`from='comfyui-h3'`、`to='comfyui-h3(t2v)'`、`lost=['首帧驱动（画面与关键帧一致性下降）']`），否则用户会以为「关键帧驱动」还在生效 |
| **R4** | 部分具降级语义的报错落到 `unknown`（如「模板里没有 {{lastImage}}」） | `video.js:221` vs `retry.js:27-28` | 契约不新增 kind（避免动既有断言），改为在 `HEAL_BY_KIND` 里对 `unknown` 走 `hold-human`；并把 §2.4 速查表作为回归基线 |
| **R5** | `placeholder` 需要**关键帧**才能出片；缺关键帧时换过去必然再失败 | `video.js:121-122` | C2 必须校验「该镜是否已有可用关键帧」，否则「换了个更差的后端还失败」 |
| **R6** | 付费降级链的「花钱」语义与既有闸门冲突 | `video.js:91`、`skills.js:175-176`、`studio.js:863-875` | 已用 I3 + `mode='allow-paid'` 双重约束；默认不自动跨付费供应商 |
| **R7** | 一集内换后端 → 前后画风/音轨不一致（H3 带音轨、placeholder 无人声轨） | `comfy.js:413`（`withAudio:true`）vs `video.js:142`（`-an`） | 已用「一致性锁定 + 成片 meta 标注 + notice 明示」处置；交付前必须人工复看 |
| **R8** | 新增路由/MCP 工具会扩大接口面，需与并行任务卡协调（同一文件只能有一个写入者） | 矩阵铁律 §5.2 | `routes/render.js`、`mcp-tools.js`、`db.js` 均为高冲突文件：实现卡须独占写入，或由集成者统一接线 |

### 9.2 不适用场景（**这些场景明确不要自愈**）

| 场景 | 为什么不该换后端 | 正确做法 |
|---|---|---|
| 审核不通过（`moderation`） | 换后端 = 绕过内容审核（I4 红线） | 改提示词/画面 → 人工复核 |
| 鉴权失败 / 余额不足（`auth`/`quota`） | 是账号或配置问题；换到付费后端多半再失败，换到免费占位是**画质级**降级 | 停阶段给指引；「降级到免费占位」只能由**人**点 |
| 商用/出海交付片 | placeholder 产物不是真实视频；平台与客户不接受 | `mode='report'`：只报告不换，交人决策 |
| 该镜已 `picked=1`（人工已采用版本） | 自动重跑会让人误以为「采用版本被换了」 | 不覆盖，降级产物另存候选版本 |
| 需要严格首尾帧过渡、真实物理运动、长镜（>~5s） | placeholder 只能交叉溶解 + 关键帧运镜；generic-http 无 `{{lastImage}}` 时直接报错 | 换实例/补模板，或改分镜（拆成两条用「续写」接上，`backend-fit.js:176-180` 已有同款建议） |
| 需要自带音轨（H3 出片带声） | `placeholder` 输出恒定 `-an` 无音轨 | 不许自动降级；改用 TTS/配音链路补齐或换回真实后端 |
| `pauseState().paused === true`（预算自动暂停/人工暂停） | 暂停的语义就是「先把账算清」 | 不换不跑，任务保留在队列（`jobs.js:150-155`） |
| 模型/工作流与实例不匹配（`ComfyUI 工作流与实例不匹配`） | 属配置问题，链上所有后端都可能不匹配 | `hold-human`，按 `probeComfyVideo()` 的 `detail` 逐项修 |
| 画布「单节点重跑」且该节点计划已 `consumed` | P4 计划一次性核销（`canvas_plan_audits: consumed`） | 重新生成计划 + 人工批准；不得复用旧凭据 |

---

## 10. 与既有代码的兼容性承诺（验收对齐）

1. **不改既有公开函数签名**：`generateVideo` / `execNode` / `runGraph` / `runStage` / `withRetry` / `classifyError` 的入参出参一律向后兼容（新增可选字段只在返回值里追加）。
2. **不改既有测试期望**：`ERROR_KINDS` 键集合与 `classifyError` 输出不变（`tests/test-adapters.js:273-282`）；`DEFAULT_RETRIES=1`、`DEFAULT_RETRY_KINDS` 不变（`tests/test-graph.js:427-468`）；`classifyFailedRenders` 的「可重试=rate/server/network」不变（`tests/test-guard.js:159-160`）。
3. **中文口径**：所有 `notice`/`reason`/`advice`/错误一律中文；`errorExcerpt` 保留厂商原文（原样，不翻译）。
4. **零新依赖**：只使用 Node 内置能力（`node:crypto`、`node:sqlite` 由 `db.js` 统一提供）。
5. **测试环境**：临时库 + 离线假实例（`FACTORY_DB`/`FACTORY_DATA_DIR`/`FACTORY_CONFIG`），不触网、不起服务、不跑 `verify-all.sh`。

---

## 附录 A：结论 → 源码行号索引（实现者核对用）

| 结论 | 依据 |
|---|---|
| 错误分类 11 类与正则、`retryable` 语义 | `src/retry.js:6-18`、`20-31`、`37-53` |
| 只重试 rate/server/network；超时默认不重试（怕重复计费） | `src/retry.js:71-74` |
| `describeError` 的中文改写口径 | `src/retry.js:102-107` |
| 三个后端 id 与就绪判定；`placeholder` 免费、其余记 `videos+1` | `src/video.js:16-28`、`72-93` |
| `generic-http` 走 `withRetry(video.retries)`；H3 分支无自带重试 | `src/video.js:81-88` |
| 未配 URL / 缺 `{{lastImage}}` / 字段找不到 的中文报错 | `src/video.js:207`、`218-223`、`262` |
| `probeVideoBackend` 三后端探测（placeholder 真查 ffmpeg） | `src/video.js:298-315`、`30-36` |
| 模板静默回退 i2v→t2v 与失败时自动改写模板 | `src/comfy.js:145-148`、`250-256` |
| H3 返回 `warnings` / `raw.templateKind` / `withAudio` | `src/comfy.js:404-416`（`warnings` 在 416、`raw` 在 412-415、`withAudio` 在 413） |
| 能力事实表与需求表（降级建议的唯一口径） | `src/backend-fit.js:19-23`、`26-83`、`86-124`、`227` |
| `supportsFirstFrame` 恒真的缺口（R1） | `src/backend-fit.js:77` |
| 节点级重试与失败记录（`meta.errorKind/attempts`） | `src/graph.js:36-39`、`733-779` |
| 指纹与易变键（自愈状态必须加入 VOLATILE） | `src/graph.js:57`、`232-243`、`307-311` |
| 镜头级 per-shot try/catch 与 `meta` 形状 | `src/modules/render.js:105-115`、`261-303` |
| 失败镜头重试（按归类分流）与预算前置 | `src/modules/render.js:518-560`、`476-500` |
| 阶段定义、`setStage` 的 warnings 列、阶段幂等与错误回写 | `src/studio.js:30-44`、`275-292`、`853-885` |
| 状态对账 `reconcileStages`（付费阶段唯一终态回写点） | `src/studio.js:944-965` |
| 暂停闸门 `autoPauseGate` 与暂停语义 | `src/studio.js:969-984`、`src/jobs.js:12-66`、`150-155` |
| 取消语义（不覆写终态）与启动自愈 | `src/jobs.js:174-179`、`199-208` |
| 预算闸门 / 自动暂停 / 失败归类 / 单次制片上限 | `src/guard.js:82-107`、`170-178`、`188-204`、`215-228` |
| 技能契约 `retryKinds` / `blockedReason` / 能力矩阵 paid | `src/skills.js:97`、`100-141`、`167-184` |
| 决策时间线的可扩展只读写法 | `src/decisions.js:34-37`、`82-85`、`143-156` |
| 表结构参考（shot_renders / canvas_node_runs / production_stages） | `src/db.js:204-215`、`261-275`、`317-327`；`SCHEMA_VERSION=13`（`db.js:20`） |
| 既有断言基线（不得改红） | `tests/test-adapters.js:273-282,302,311`、`tests/test-graph.js:427-468`、`tests/test-guard.js:159-160,174` |

**本文件仅为契约，不含代码改动；实现请另开任务卡并把 §8.2 的每个文件写进该卡的 `write_scope`。**
