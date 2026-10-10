# T-104 字幕换行与安全区契约（中文断行 / 单行上限 / CPS 与安全区联动 / 与现有 wrapCjk 兼容）

> 任务卡：`strategist/tasks/T-104.yaml`　角色：架构/运维/文档军师（只读侦察，产出契约）
> 状态：**契约（待实现）**　写入范围：仅本文件
> 所有结论均来自对现有源码的通读 + 本机实测（ffmpeg 6.1.1 + libass + Noto Serif CJK），未凭想象写 API。

---

## 0. 契约摘要

本契约解决 4 件事，全部为**纯离线计算**，不引入任何依赖、不动网络与厂商接口：

| # | 交付 | 结论 |
|---|---|---|
| A | 中文断行算法 | 新增 `wrapSubtitles(text, options)`：**原子化 + 禁则回溯 + 标点优先**，解决现有 `wrapCjk` 的三处缺陷（行首标点、英文/数字被腰斩、满行超长 per+1） |
| B | 单行上限与安全区联动 | `L_eff = min(maxCharsPerLine, L_safe)`，`L_safe` 由**平台安全区百分比 + 字号 + 画幅比**按纯比例公式反算（不写死像素）；复用既有 `PLATFORM_PRESETS`，不新增第二张平台表 |
| C | 向后兼容 | `lineBreakMode: 'legacy'` 为**默认**，与现有 `wrapCjk(text, 18)` **逐字节等价**（含 UTF-16 计数与 per+1 怪癖）；新算法与安全区联动均为**显式 opt-in**，既有 2098 项断言零改动 |
| D | CPS 联动 | 新增拆条闸门 `splitForCps()`：`k = max(1, ceil(字数 / (maxLines × L_eff)), ceil(字数 / (maxCps × 时长)))`，默认关闭 |

**关键实测发现（决定了本契约的必要性与兼容策略）**：在 1080×1920 竖屏上，以默认 `subtitleSize=22` 硬烧一行 18 个汉字，**libass 会自动二次折行成 2 行**（实测墨迹行段数 = 2，每行约 9 字）。也就是说：`validateSubtitles` 判定的「单行 ≤18 字 = 合规」与**硬烧后的真实画面并不一致**；18 字上限实际是**横屏口径**。竖屏每行真实容量只有约 9 字。这正是「18 字行为不变」必须走 opt-in 而非直接改默认的原因。

---

## 1. 现状侦察（只读，均经实测确认）

### 1.1 现有实现

`src/finish.js:86-96` 模块私有函数（**未导出**）：

```js
function wrapCjk(text, per) {
  const out = [];
  let line = '';
  for (const ch of String(text)) {
    line += ch;
    if (line.length >= per && !/[，。！？、；：]$/.test(ch)) { out.push(line); line = ''; }
    if (/[。！？]/.test(ch) && line.length > per * 0.6) { out.push(line); line = ''; }
  }
  if (line) out.push(line);
  return out.join('\n');
}
```

唯一调用点：`src/finish.js:78`，来自 `export function buildSRT(shots, { includeAction = false, maxCharsPerLine = 18 })`。
`buildSRT` 的 cue 时长与行数**强耦合**（改动断行会连带改时间轴，实现时必须注意）：

```js
// src/finish.js:79
`${srtTime(t)} --> ${srtTime(t + Math.min(dur, Math.max(1, wrapped.split('\n').length * 1.6 + 1.2)))}`
```

### 1.2 相关既有函数（签名不可改）

| 位置 | 签名 | 与本契约的关系 |
|---|---|---|
| `src/finish.js:66` | `buildSRT(shots = [], { includeAction = false, maxCharsPerLine = 18 } = {})` | **公开签名不变**；行数变化会影响 cue 时长 |
| `src/subtitles.js:99` | `validateSubtitles(srtOrCues, { maxCharsPerLine = 18, maxLines = 2, maxCps = 21, minDuration = 0.8, maxDuration = 8, videoHeight = 1280, marginV = 60, safeBottomPct = 12 } = {})` | 校验口径的**唯一权威**；本契约产出的 L_eff 必须喂给它 |
| `src/subtitles.js:71` | `toTtml(srtOrCues, { lang, title, safeArea = { top: 10, bottom: 15, left: 5, right: 5 } })` | 安全区百分比已被 TTML region 使用 |
| `src/variants.js:17` | `export const PLATFORM_PRESETS` | **平台规格唯一数据表**，含 `width/height/safeArea{top,bottom,left,right}` |
| `src/variants.js:84` | `planVariant({ preset, sourceWidth, sourceHeight, fit, subtitleMarginV })` | 安全区底部换算既有实现，本契约与之一致 |
| `src/config.js:157` | `finish.{subtitleMode,subtitleFont,subtitleSize:22,subtitleMarginV:40,…}` | 本契约新增配置挂在 `finish` 下 |

### 1.3 现有算法的缺陷（实测复现）

用现有算法逐字复刻运行（`per = 18`）：

| 输入 | 现有输出 | 缺陷 |
|---|---|---|
| `这是一二三四五六七八九十甲乙丙丁戊己，然后继续说下去吧` | `这是一二三四五六七八九十甲乙丙丁戊` / `，然后继续说下去吧` | **行首标点**（第 2 行以「，」开头） |
| `这里有个单词 supercalifragilistic 后面继续写中文内容` | `这里有个单词 supercalifr` / `agilistic 后面继续写中文内` / `容` | **英文单词被腰斩** |
| `预算约为 1234567890 元人民币请确认这个数字` | `预算约为 1234567890 元人` / `民币请确认这个数字` | 数字侥幸完整，但 `Hello世界ABC123…` 类会拆到字母数字中间 |
| `一二三四五六七八九十甲乙丙丁戊己庚，然后接着说下去` | 行1 = **19 字** `一二三四五六七八九十甲乙丙丁戊己庚，然` | **满行超长 per+1**（`line.length >= per` 遇上标点时不推行，继续累加到 `per+1`） |
| `测试😀表情符号…` | 行1 = UTF-16 `length` 18，码点仅 17 | **计数口径不一致**：`wrapCjk` 用 `.length`（UTF-16 单元），`validateSubtitles` 用 `[...l].length`（码点）→ 两处判定会打架 |

### 1.4 字幕的 3 条进入路径（决定契约的生效边界）

| 路径 | 来源 | 是否经过断行 |
|---|---|---|
| ① 自动生成 | `buildSRT(clips)` → `src/finish.js:246` | **是**（本契约作用域） |
| ② 画布字幕轨 | `timeline.js:206` 置 `options.subtitleSource`，`finish.js:238-244` 直接 `parseSRT` 读外部 SRT | **否**（用户稿件，必须原样尊重，不得重排） |
| ③ 质检/交付/发布 | `src/qc.js:242`、`src/deliver.js:277`、`src/publish.js:152`、`src/routes/render.js:243/410`、`src/mcp-tools.js:774` 各自调 `buildSRT` | 是（受 ① 影响） |

> **契约约束**：断行只对路径 ① 生效。路径 ② 的外部 SRT 一律不重排（否则会与用户显式稿件冲突）。

---

## 2. 契约 A：中文断行算法（验收标准 1）

### 2.1 落点与函数签名

落在**既有排版规范模块** `src/subtitles.js`（该文件已无任何 import，被 `qc.js`/`routes/render.js` 动态 import，是排版口径的天然归属），**不新建模块**。

```js
// ===== src/subtitles.js 新增导出（纯函数，无副作用、无 IO、无依赖）=====

/** 行首禁则字符集：不允许出现在一行的第一个字符位置 */
export const FORBID_LINE_START = '，。、！？；：）】》」』”’…～·,.;:!?)]}>%‰℃°';

/** 行尾禁则字符集：不允许出现在一行的最后一个字符位置 */
export const FORBID_LINE_END = '（【《「『“‘([{<';

/** 句末标点（标点优先断行的触发点） */
export const SENTENCE_END_RE = /[。！？…!?]/;

/** 中文断行主函数（契约核心） */
export function wrapSubtitles(text, {
  maxCharsPerLine = 18,      // 单行上限（全角字当量；charUnit 决定计数口径）
  maxLines        = 0,       // 0 = 不限制行数（仅产出 lines，不截断、不静默丢字）
  charUnit        = 'char',  // 'char'（默认，每个码点计 1，兼容既有口径）| 'em'（全角 1 / 半角 0.5）
  lineBreakMode   = 'legacy',// 'legacy'（默认，与现有 wrapCjk 逐字节等价）| 'cjk'（新算法）
  sentenceFillRatio = 0.6,   // 标点优先的最低填充比（等价既有 per*0.6 阈值）
  forbidLineStart = FORBID_LINE_START,
  forbidLineEnd   = FORBID_LINE_END,
  preserveNewlines = true,   // 输入中的 \n 视为硬换行（作者显式意图）
} = {}) {
  // lineBreakMode === 'legacy' → 直接委托 wrapCjkLegacy(text, maxCharsPerLine)
  // 其余 → §2.4 算法
}

/** 旧算法（逐字复刻 src/finish.js:86-96，含全部怪癖），导出供等价性测试与 legacy 委托使用 */
export function wrapCjkLegacy(text, per = 18) { /* 见 §2.5 逐字源码 */ }
```

`src/finish.js` 侧（**最小改动**）：删掉模块私有 `wrapCjk`，改为一行委托，`buildSRT` 其余一字不动：

```js
import { wrapCjkLegacy, wrapSubtitles } from './subtitles.js';   // 依赖方向 subtitles.js → 无（无循环）
// src/finish.js:78 改为：
const wrapped = (opt.subtitleWrap === 'cjk'
  ? wrapSubtitles(speaker + body, { maxCharsPerLine, lineBreakMode: 'cjk', charUnit: opt.subtitleCharUnit || 'char' })
  : { text: wrapCjkLegacy(speaker + body, maxCharsPerLine).text }
).text;
```

> 依赖方向说明：`subtitles.js` 目前零 import；`finish.js` 已 import `config/loudness/db/util/tts/dub/i18n`。因此 `finish.js → subtitles.js` **不构成循环依赖**。`qc.js`、`routes/render.js` 对 `subtitles.js` 是动态 `import()`，不受影响。

### 2.2 `wrapSubtitles` 返回结构（字段表）

| 字段 | 类型 | 说明 |
|---|---|---|
| `lines` | `string[]` | 断行结果，每项 = 一行的纯文本（已 `trimEnd`，无 `\n`） |
| `text` | `string` | `lines.join('\n')`，可直接放进 SRT cue 正文 |
| `warnings` | `string[]` | 中文告警；**不抛异常**，超长原子等降级情形在此报告 |
| `mode` | `'legacy' \| 'cjk'` | 实际生效的断行模式（回显，便于 QC 记录） |
| `charUnit` | `'char' \| 'em'` | 实际生效的计数口径 |
| `maxLineChars` | `number` | 实测最长行的**码点数**（与 `validateSubtitles` 同口径，便于直接比对） |
| `overflow` | `boolean` | 是否存在「单原子超过 maxCharsPerLine」的降级行 |

### 2.3 原子化规则（「数字英文不拆」的实现机制）

「不拆」不是靠特殊判断，而是靠**把不可拆的串先合并成一个原子（atom），断行只发生在原子之间**。原子正则（已验证，顺序敏感，长模式在前）：

```js
const ATOM_RE = /(https?:\/\/[^\s]+                 // URL
                | [A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}   // 邮箱
                | \d+(?::\d{2})+(?:[.,]\d+)?        // 时间码 12:34 / 01:02:03
                | \d+(?:[.,]\d+)?%?                 // 数字 / 小数 / 百分比 22%
                | [A-Za-z]+(?:['’\-][A-Za-z]+)*     // 英文单词（含连字符、撇号）
                | [ \t]+                            // 连续空白（不参与断行）
                | [\s\S]                            // 其余单字符（CJK 一字一原子）
                )/g;
```

| `type` | 判定 | 是否可被内部分割 |
|---|---|---|
| `token` | 匹配 URL / 邮箱 / 时间码 | **否** |
| `num` | `^\d` | **否** |
| `latin` | `^[A-Za-z]` | **否** |
| `space` | 纯空白（空格 / Tab） | 不参与计入行宽 |
| `char` | 其它（含全部 CJK） | 单字符即原子 |

`em`（全角当量，`charUnit='em'` 时用于计量）：宽字符 `1.0`，其余 `0.5`。宽字符正则：

```js
const WIDE_RE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/;
```

### 2.4 断行算法（贪心 + 禁则回溯 + 标点优先）

```
输入：atoms（§2.3）、L = maxCharsPerLine、sentenceFillRatio = r
1) 逐段处理（preserveNewlines 时按 \n 切段，段内独立断行；空段跳过）
2) 行起点 i：
   a. 跳过行首空格原子
   b. 从 i 起按行宽累计，取最大可容纳位置 end（atoms[end] 是第一个放不下的原子）
   c. 若 end == i（首个原子自身就超长）：end = i+1，记 warning「原子超长：…（n > L），已独占一行」，overflow = true
   d. 若 end >= atoms.length：本段收尾，输出 atoms[i..] 并结束本段
   e. 断点回溯：b 从 end 递减到 i+1，逐个用 canBreak(b) 判定：
        - legal  := 最靠右的「合法断点」（第一个碰到的合法 b）
        - punct  := 最靠右的「标点优先断点」
                    条件：atoms[b-1] 的末字符匹配 SENTENCE_END_RE
                     且 累计宽度(i..b-1) >= L × r
   f. 取断点 brk = punct ?? legal ?? end
        - 若 punct 与 legal 均为 null（禁则导致无合法断点）→ 强制 brk = end，记 warning「禁则无合法断点，已在第 n 个原子处强制断行」
   g. 输出行文本 = atoms[i..brk-1].map(text).join('').trimEnd()
   h. i = brk，回到 a
```

`canBreak(b)`（禁则核心，决定「不可行首标点」与「不可行尾开括号」）：

```js
function canBreak(atoms, b) {
  const prev = atoms[b - 1], next = atoms[b];
  if (prev.type === 'space') return false;                        // 上一行不以空格收尾
  if (forbidLineStart.includes(cp(next.text)[0])) return false;   // 不可行首标点
  if (forbidLineEnd.includes(cp(prev.text).slice(-1)[0])) return false; // 不可行尾开括号
  return true;
}
// cp = (s) => [...String(s)]  // 一律按码点取首/末字符，避免代理对撕裂
```

**三条验收要点在算法中的落点**：

| 验收要点 | 落点 |
|---|---|
| 标点优先 | 步骤 2e 的 `punct`（断在句末标点**之后**），且以 `L × r` 为最低填充门槛，避免产出过短行 |
| 不可行首标点 | `canBreak` 的 `forbidLineStart` 判定（**内容层面禁止**，优于事后修补：不会产生「行首标点 → 拉字回上一行 → 连锁重排」的震荡） |
| 数字英文不拆 | `ATOM_RE` 原子化（§2.3）：数字/英文/URL/时间码在原子层面不可分割，断行只发生在原子边界 |

### 2.5 `wrapCjkLegacy` 逐字源码（兼容基线，必须原样搬运）

```js
/** 旧版断行：为兼容既有 18 字行为而冻结，任何「优化」都必须走 wrapSubtitles(text,{lineBreakMode:'cjk'}) */
export function wrapCjkLegacy(text, per = 18) {
  const out = [];
  let line = '';
  for (const ch of String(text)) {
    line += ch;
    if (line.length >= per && !/[，。！？、；：]$/.test(ch)) { out.push(line); line = ''; }
    if (/[。！？]/.test(ch) && line.length > per * 0.6) { out.push(line); line = ''; }
  }
  if (line) out.push(line);
  const lines = out;
  return {
    lines, text: lines.join('\n'), warnings: [], mode: 'legacy', charUnit: 'char',
    maxLineChars: lines.length ? Math.max(...lines.map((l) => [...l].length)) : 0,
    overflow: false,
  };
}
```

> 注意：`.length`（UTF-16 单元）是**兼容性的一部分**，不得顺手改成码点计数 —— 改了就不再逐字节等价。

### 2.6 标准用例表（期望输出，全部已实机验证 PASS）

`lineBreakMode: 'cjk'`，`maxCharsPerLine: 18`，`charUnit: 'char'`：

| # | 输入 | 期望 `lines` | 验证的不变量 |
|---|---|---|---|
| ① | `这是一二三四五六七八九十甲乙丙丁戊己，然后继续说下去吧` | `["这是一二三四五六七八九十甲乙丙丁戊", "己，然后继续说下去吧"]` | 无行以禁则字符开头 |
| ② | `预算约为 1234567890 元人民币请确认这个数字` | `["预算约为 1234567890 元人", "民币请确认这个数字"]` | `1234567890` 完整 |
| ③ | `这里有个单词 supercalifragilistic 后面继续写中文内容` | `["这里有个单词", "supercalifragilistic", "后面继续写中文内容"]` + warning `原子超长：supercalifragilistic（20 > 18）` | 英文整词独占一行且告警，`overflow === true` |
| ④ | `今天我们一起去公园散步了。好的明天再说` | `["今天我们一起去公园散步了。", "好的明天再说"]` | 标点优先：断在「。」之后 |
| ⑤ | `一二三四五六七八九十甲乙丙丁戊己，。然后接着说` | `["一二三四五六七八九十甲乙丙丁戊己，。", "然后接着说"]` | 连续标点整组不拆到两行 |
| ⑥ | `进度 12:34 已经到 25% 了请确认这个数据` | `["进度 12:34 已经到 25% 了", "请确认这个数据"]` | 时间码 / 百分比不拆 |
| ⑦ | `他说（这是一个很长的插入说明内容）然后继续说话` | `["他说（这是一个很长的插入说明内容）然", "后继续说话"]` | 无行以 `（` 收尾 |
| ⑧ | `甲：第一句台词` | `["甲：第一句台词"]` | 说话人前缀计入字数、不超限不加行 |
| ⑨ | `""` / `"   "` | `[]` | 空串安全，`maxLineChars === 0` |
| ⑩ | `第一行\n第二行内容` | `["第一行", "第二行内容"]` | 显式换行保留为硬换行 |
| ⑪ | `短句`，`maxCharsPerLine: 1` | `["短","句"]` | 极小上限不丢字（`join('') === 原文`） |
| ⑫ | `甲乙丙丁戊己庚辛壬癸` | `["甲乙丙丁戊己庚辛壬癸"]` | 未超限不主动加行 |

**全局不变量（实现者应作为属性测试断言）**：

1. `lines.every(l => !forbidLineStart.includes([...l][0]))`
2. `lines.every(l => !forbidLineEnd.includes([...l].slice(-1)[0]))`
3. `lines.join('') === 原文去掉空白后的等价形式`（**不丢字、不增字**，仅丢弃行首/行尾空白）
4. `lineBreakMode === 'cjk'` 时，除 §2.6③ 的 `overflow` 情形外，`[...l].length <= maxCharsPerLine`（`charUnit='char'`）

---

## 3. 契约 B：单行上限 × 平台安全区联动（验收标准 2）

### 3.1 字号像素基准（实测标定，是整个联动公式的地基）

实测方法（可复现，零依赖）：用 `-f lavfi -i color=black:s=<W>x<H>` 造帧，经 `subtitles=…:force_style='FontSize=…,Alignment=2,MarginV=40'` 烧录单字，再把 PNG 转 `rawvideo -pix_fmt gray` 求**墨迹包围盒**：

```bash
ffmpeg -f lavfi -i color=black:s=1080x1920:d=0.2:r=5 \
  -vf "subtitles=one.srt:force_style='FontSize=22,Alignment=2,MarginV=40'" -frames:v 1 out.png
```

实测矩阵（单字「测」的墨迹像素）：

| 帧尺寸 | FontSize | 墨迹宽 px | 墨迹高 px | `墨迹/画面高` |
|---|---|---|---|---|
| 1080×1920 | 22 | 91 | 92 | 0.0479 |
| 1080×1920 | 44 | 181 | 184 | 0.0958 |
| 1080×1080 | 22 | 51 | 52 | 0.0481 |
| 1080×1080 | 44 | 102 | 104 | 0.0963 |
| 1920×1080 | 22 | 51 | 52 | 0.0481 |
| 1920×1080 | 44 | 102 | 104 | 0.0963 |
| 720×1280 | 22 | 60 | 61 | 0.0477 |
| 720×1280 | 44 | 120 | 123 | 0.0961 |

**结论（与宽度无关，只随画面高度线性缩放）**：

```
em_px = subtitleSize × videoHeight × GLYPH_HEIGHT_RATIO
GLYPH_HEIGHT_RATIO = 0.00238      // 实测标定常数（8 个数据点极差 < 1%）
```

即：字号的对齐基准是**画面高度**，`FontSize=22` 在 1920 高上约合 **100 px/字**（91 px 墨迹 + 字身留白）。
旁证：`ffmpeg -f lavfi -i color=… -i x.srt -c:s ass` 生成的 ASS 头为 `PlayResX: 384 / PlayResY: 288`（libass 默认），实测缩放系数 `0.00238 × 288 ≈ 0.685`。

> **标定项（重要）**：该常数绑定「ffmpeg 6.1.1 + libass + 系统 CJK 字体（实测 Noto Serif CJK）」。换字体族 / 换 ffmpeg 版本 / 改 `subtitleFont` 后**必须重新标定**，方法见上。契约把它做成命名常量而非散落的魔数，就是为了只改一处。

### 3.2 单行字数上限 `L_safe` 公式（纯比例，不写死像素）

单字宽度占可用宽度的百分比：

```
glyphWidthPct = 100 × GLYPH_HEIGHT_RATIO × subtitleSize × (videoHeight / videoWidth)
```

平台安全区给出的可用宽度百分比（字段直接取自 `PLATFORM_PRESETS[id].safeArea`，**左右各扣**）：

```
availWidthPct = 100 − safeArea.left − safeArea.right
```

安全区允许的单行字数：

```
L_safe = floor( availWidthPct / glyphWidthPct )
       = floor( (100 − safeArea.left − safeArea.right)
                / (100 × GLYPH_HEIGHT_RATIO × subtitleSize × videoHeight / videoWidth) )
```

### 3.3 各平台数值表（`subtitleSize = 22`，预设取自 `src/variants.js:17`）

| 平台 id | 画幅 | 安全区 l/r | 可用宽% | 单字宽% | `L_safe` | 配置 `maxCharsPerLine` | **`L_eff`** | 单条容量 `maxLines=2` | 硬烧实测（单行 18 字） |
|---|---|---|---|---|---|---|---|---|---|
| `douyin` | 1080×1920 | 6/6 | 88% | 9.31% | **9** | 18 | **9** | 18 字 | **自动折成 2 行** |
| `channels` | 1080×1920 | 6/6 | 88% | 9.31% | **9** | 18 | **9** | 18 字 | **自动折成 2 行** |
| `xiaohongshu` | 1080×1440 | 6/6 | 88% | 6.98% | **12** | 18 | **12** | 24 字 | **自动折成 2 行** |
| `bilibili` | 1920×1080 | 5/5 | 90% | 2.95% | 30 | 18 | **18** | 36 字 | 1 行（1021 px，不触边） |
| `youtube` | 1920×1080 | 5/5 | 90% | 2.95% | 30 | 18 | **18** | 36 字 | 1 行 |
| `square` | 1080×1080 | 6/6 | 88% | 5.24% | **16** | 18 | **16** | 32 字 | **自动折成 2 行** |
| （无预设，成片原生尺寸） | 1080×1920 | 6/6（默认） | 88% | 9.31% | **9** | 18 | **9** | 18 字 | **自动折成 2 行** |

> 「硬烧实测」一列是用 §3.1 方法真实渲染 18 个汉字得到的**墨迹行段数**，不是推算 —— 它证明了竖屏上 18 字会被 libass 二次折行。

### 3.4 联动公式总式

```
L_eff = max( L_MIN, min( maxCharsPerLine_cfg, L_safe ) )
L_MIN = 6      // 可读性下限：低于 6 字/行会导致频繁折行，反而更难读
```

- `L_eff === L_MIN` 且 `L_safe < L_MIN` → warning：`安全区只放得下 {L_safe} 字/行（低于可读下限 6），建议调小 finish.subtitleSize（当前 {subtitleSize}）或改用安全区更宽的画幅`
- `maxCharsPerLine_cfg < L_safe` → 以配置值为准（安全区不构成约束）
- **反解（供实现者做提示文案）**：要让 18 字/行在 1080×1920 竖屏成立，需 `subtitleSize ≤ 11.6`（默认 22 太大）。参考：`subtitleSize=16 → 12 字/行`，`subtitleSize=12 → 17 字/行`。

### 3.5 `subtitleLayout()` —— 联动计算函数签名（新增导出）

```js
/**
 * 算出一份「字幕排版口径」（纯计算，供 buildSRT / validateSubtitles / QC / 交付包 / MCP 共用）
 * @param {{
 *   presetId?: string|null,     // PLATFORM_PRESETS 的 id；null = 用成片原生尺寸 + 默认安全区
 *   videoWidth?: number,        // 成片宽（presetId 为空时必填）
 *   videoHeight?: number,       // 成片高
 *   subtitleSize?: number,      // finish.subtitleSize，默认 22
 *   maxCharsPerLine?: number,   // finish.maxCharsPerLine，默认 18
 *   maxLines?: number,          // 默认 2
 *   maxCps?: number,            // 默认 21
 *   applySafeAreaLimit?: boolean, // 默认 false（见 §4）
 * }} opts
 * @returns {{
 *   ok: boolean, error?: string,
 *   presetId: string|null, videoWidth: number, videoHeight: number, subtitleSize: number,
 *   safeArea: { top:number, bottom:number, left:number, right:number },  // 百分比
 *   glyphWidthPct: number,      // 单字宽占画面宽百分比
 *   glyphHeightPct: number,     // 单字高占画面高百分比（= 100 × GLYPH_HEIGHT_RATIO × subtitleSize）
 *   availWidthPct: number,
 *   maxCharsPerLineCfg: number, // 配置值（18）
 *   maxCharsPerLineSafe: number,// 安全区反算值 L_safe
 *   maxCharsPerLine: number,    // L_eff（真正下发给换行算法的值）
 *   maxLines: number, maxCps: number,
 *   capacityChars: number,      // maxLines × maxCharsPerLine（单条字幕的显示字数容量）
 *   safeAreaLimited: boolean,   // L_eff 是否被安全区收窄
 *   warnings: string[],
 *   rule: string,               // 中文口径描述，可直接进质检报告
 * }}
 */
export function subtitleLayout(opts = {}) {}
```

**字段映射（复用既有表，不新增平台表）**：

| `subtitleLayout` 字段 | 来源 | 说明 |
|---|---|---|
| `presetId` | `PLATFORM_PRESETS[id].id` | `listPresets()` / `presetOf(id)`（`src/variants.js:56-57`） |
| `videoWidth/videoHeight` | `PLATFORM_PRESETS[id].width/height`（无预设时取成片 meta） | 与 `planVariant` 的 `target.width/height` 同源 |
| `safeArea` | `PLATFORM_PRESETS[id].safeArea` | 与 `validateSubtitles`/`toTtml` 的 `safeArea` 同构 |
| `subtitleSize` | `config.finish.subtitleSize` | 默认 22（`src/config.js:160`） |
| `maxCharsPerLineCfg` | `config.finish.maxCharsPerLine` | **新增配置**，默认 18 |
| `maxCharsPerLineSafe` | §3.2 公式 | — |
| `maxCharsPerLine` | §3.4 公式 | 喂给 `wrapSubtitles` 与 `validateSubtitles` |

### 3.6 CPS 联动与拆条（与 `maxCps = 21` 的口径闭环）

单条 cue 同时受两条约束，取更严者：

```
显示容量   capacityChars = maxLines × L_eff            // 画面放得下
阅读预算   cpsBudget     = maxCps × duration           // 读得完（duration = cue 停留秒数）
拆条段数   k = max( 1, ceil(chars / capacityChars), ceil(chars / cpsBudget) )
每段字数   chars_i ≈ chars / k（按 §2 断行后按行边界切，不切碎句子）
每段时长   duration_i = duration × (chars_i / chars)  // 按字数比例分配
```

样例（`maxCps=21`、`maxLines=2`）：

| 字数 | 时长 | 平台口径 | `capacityChars` | `cpsBudget` | k | 结果 |
|---|---|---|---|---|---|---|
| 30 | 3s | 竖屏 `L_eff=9` | 18 | 63 | **2** | 每段 15 字 / 1.50s → CPS ≈ 10 |
| 12 | 3s | 竖屏 `L_eff=9` | 18 | 63 | 1 | 不拆，CPS ≈ 4 |
| 40 | 6s | 横屏 `L_eff=18` | 36 | 126 | **2** | 每段 20 字 / 3.00s → CPS ≈ 6.7 |
| 25 | 2s | 竖屏 `L_eff=9` | 18 | 42 | **2** | 每段 12.5 字 / 1.00s → CPS ≈ 12.5 |

```js
/** CPS 闸门：把「读不完」的一条拆成多条（默认关闭，见 §4） */
export function splitForCps({ text, duration, maxCharsPerLine = 18, maxLines = 2, maxCps = 21, minDuration = 0.8 } = {})
  // → { cues: [{ text, duration }], segments: number, warnings: string[] }
```

> **注意 SRT 时长耦合**：`buildSRT`（`src/finish.js:79`）的 cue 时长 = `min(镜头时长, max(1, 行数 × 1.6 + 1.2))`。断行改变行数 ⇒ 间接改变 cue 时长 ⇒ 改变交付包/发布物。因此换行算法上线必须连同 `buildSRT` 的 golden 快照一起比对（见 §5.4）。

---

## 4. 配置 schema（可新增字段，全部有默认值；「表结构」指此配置表）

挂在既有 `config.finish` 之下（`src/config.js:156-172`），**全部为新增键，不改任何既有键的语义与默认值**：

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `finish.subtitleWrap` | `'legacy' \| 'cjk'` | `'legacy'` | 断行算法。`legacy` = 既有行为（逐字节）；`cjk` = 新算法 |
| `finish.subtitleCharUnit` | `'char' \| 'em'` | `'char'` | 计数口径。`char` = 每码点计 1（兼容既有）；`em` = 全角 1 / 半角 0.5（开启安全区联动时推荐） |
| `finish.maxCharsPerLine` | `number` | `18` | 单行上限**配置值**（既有阈值，语义不变） |
| `finish.subtitleAutoLayout` | `boolean` | `false` | 是否启用安全区联动（把 `L_eff` 收窄到 `L_safe`）。**默认关 → 18 字行为不变** |
| `finish.subtitleSplitForCps` | `boolean` | `false` | 是否启用 CPS 拆条（会改变 cue 条数，默认关） |
| `finish.subtitleLayoutPreset` | `string \| null` | `null` | 按哪个平台口径做联动校验；`null` = 成片原生尺寸 + 默认安全区 |

**可选持久化表（P2，本卡不建议实现，仅给出 DDL 供后续卡复用）**：若要把每集每平台的字幕排版结论写进库（便于交付包与看板复用），按 `src/db.js` 既有风格建表（`id TEXT PRIMARY KEY` + `created_at TEXT`，与 `jobs` 表一致）：

```sql
-- P2 可选：仅在需要「同一集多平台排版结论留痕」时启用
CREATE TABLE IF NOT EXISTS subtitle_layouts (
  id                TEXT PRIMARY KEY,      -- SL-0001（nextId('SL','subtitle_layout')）
  script_id         TEXT,
  episode_code      TEXT,
  preset_id         TEXT,                  -- PLATFORM_PRESETS 的 id，可为 NULL（原生尺寸）
  video_width       INTEGER NOT NULL,
  video_height      INTEGER NOT NULL,
  subtitle_size     REAL    NOT NULL DEFAULT 22,
  char_unit         TEXT    NOT NULL DEFAULT 'char',   -- char|em
  wrap_mode         TEXT    NOT NULL DEFAULT 'legacy', -- legacy|cjk
  max_chars_cfg     INTEGER NOT NULL DEFAULT 18,
  max_chars_safe    INTEGER NOT NULL DEFAULT 18,
  max_chars_eff     INTEGER NOT NULL DEFAULT 18,
  max_lines         INTEGER NOT NULL DEFAULT 2,
  max_cps           REAL    NOT NULL DEFAULT 21,
  safe_area         TEXT,                  -- JSON: {top,bottom,left,right}（百分比）
  overflow          INTEGER NOT NULL DEFAULT 0,  -- 0/1：是否存在超长原子
  warnings          TEXT,                  -- JSON string[]
  rule              TEXT,
  created_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_subtitle_layouts_ep ON subtitle_layouts(script_id, episode_code);
```

---

## 5. 契约 C：向后兼容策略（验收标准 3）

### 5.1 兼容总原则

**默认路径零变化**：`finish.subtitleWrap` 默认 `'legacy'` ⇒ `buildSRT` 产出的 SRT 与今日**逐字节相同** ⇒ 既有 2098 项断言、交付包、QC 报告、发布物全部不受影响。新算法（`'cjk'`）与安全区联动（`subtitleAutoLayout`）、CPS 拆条（`subtitleSplitForCps`）**三者都是显式 opt-in**，且互不隐含（开了 `cjk` 不会自动开联动）。

### 5.2 兼容性三处「必须保持原样」的细节

| 细节 | 为什么必须保持 | 保住方式 |
|---|---|---|
| `.length` 是 **UTF-16 单元**而非码点 | 改了就与既有输出不等价（emoji/罕见字行首位置变化） | `wrapCjkLegacy` 逐字复刻，不改计数方式 |
| 满行遇标点会产出 **`per+1` 长行**（实测 19 字） | 属既有「怪癖」，但它是既有 18 字行为的一部分；直接修正会让 SRT 行数变化 | 保留在 `wrapCjkLegacy`；仅在 `'cjk'` 模式修正 |
| 说话人前缀 `甲：` **计入**单行字数 | 既有 `buildSRT` 把 `speaker + body` 一起 wrap；改成不计入会改变断行 | 保持 `speaker + body` 一起送入换行 |

### 5.3 渐进式升级路线（推荐，风险最低）

| 阶段 | 动作 | 默认值 | 影响面 |
|---|---|---|---|
| **阶段 1（本卡）** | 新增 `wrapSubtitles`/`wrapCjkLegacy`/`subtitleLayout`/`splitForCps`；`finish.js` 委托；配置项全部默认「关」 | 全 legacy | **零行为变化**，既有断言全绿 |
| **阶段 2** | 在 `config.json` 里显式打开 `subtitleWrap:'cjk'` + `subtitleAutoLayout:true`；交付包与 QC 走新口径 | 配置显式开启 | 新集生效；**已封装的旧成片不重封** ⇒ 无回归 |
| **阶段 3（另开卡）** | 若 QC/交付/发布连续两周无回归，再讨论「新算法为默认」 | 翻默认 | **必须单独立卡 + 独立验收**，不在本卡范围 |

### 5.4 兼容性测试要求（实现者必须做，本卡只写要求）

1. **legacy 等价测试**：用 `wrapCjkLegacy(t, 18)` 对 ≥40 条语料（含纯 CJK / 中英混排 / 纯数字 / emoji / 各类标点 / 空串 / 纯空白 / 含 `\n` / 单原子超长）断言与**改动前** `wrapCjk` 输出逐字节相等。语料建议直接取 `tests/test-deliver.js` 与 `tests/test-render.js` 中已出现的台词。
2. **golden 快照**：对固定 shots 断言 `buildSRT(shots).srt` 全等（含时间码，覆盖 §3.6 的时长耦合）。
3. **属性测试**：§2.6 的 4 条全局不变量（不丢字、无行首禁则、无行尾禁则、长度上限）。
4. **不变量**：`lineBreakMode:'legacy'` 时 `wrapSubtitles(...).text === wrapCjkLegacy(...).text`。
5. **外部 SRT 不动**：断言画布字幕轨路径（`options.subtitleSource`）产出的 SRT 字节不变。

---

## 6. 实现改动清单（最小改动，供实现者照做）

| 文件 | 改动 | 说明 |
|---|---|---|
| `src/subtitles.js` | **新增** `FORBID_LINE_START`、`FORBID_LINE_END`、`SENTENCE_END_RE`、`WIDE_RE`、`GLYPH_HEIGHT_RATIO`、`wrapSubtitles()`、`wrapCjkLegacy()`、`subtitleLayout()`、`splitForCps()` | 既有导出（`parseTime/parseSrt/toVtt/toTtml/validateSubtitles`）**一律不动** |
| `src/finish.js` | 删除私有 `wrapCjk`；新增 1 行 import；`buildSRT` 第 78 行改为按 `opt.subtitleWrap` 选择实现 | `buildSRT` **签名与返回结构不变** |
| `src/config.js` | `finish` 下新增 §4 的 6 个键（含默认值） | 不改既有键 |
| `src/qc.js` / `src/deliver.js` / `src/publish.js` / `src/routes/render.js` / `src/mcp-tools.js` | 保持 `buildSRT(...)` 调用形式；可选：把 `subtitleLayout().maxCharsPerLine` 传给 `validateSubtitles` | 均为可选增强，非本契约强制 |
| `tests/` | 新增 `tests/test-subtitle-wrap.js`（§5.4 的 5 类断言） | 不得改既有测试期望 |

**中文报错与注释**：所有 `warnings` 与异常文案一律中文（如 `原子超长：supercalifragilistic（20 > 18），已独占一行`、`安全区只放得下 9 字/行（低于可读下限 6），建议调小 finish.subtitleSize`），与既有风格一致。
**导出风格**：一律 `export function` / `export const`（与 `src/subtitles.js` 现状一致）。

---

## 7. 兼容性风险（evidence_required #2）

| # | 风险 | 影响 | 处置 |
|---|---|---|---|
| **R1** | 竖屏（1080×1920）18 字被 libass **二次自动折行**（实测：墨迹行段数 = 2，每行约 9 字） | `validateSubtitles` 判「单行 ≤18 合规」，与硬烧真实画面**不一致**；SRT 写 2 行时竖屏会被折成 4 行 | 契约给出 `L_safe` 联动。**不得直接改默认**（会改变既有产物），走 §5.3 阶段 2 |
| **R2** | 软字幕轨（`mov_text` / 播放器渲染）**不做 libass 折行**，行宽由播放器决定 | `maxCharsPerLine` 的口径只对**硬烧**有像素意义；软字幕轨上游尺寸未知 | 软字幕轨按「播放器最小宽度窗口」保守估（取 `L_safe` 与配置值的较小者）；契约明确该差异，不假装统一 |
| **R3** | 标定常数 `GLYPH_HEIGHT_RATIO = 0.00238` 绑定 ffmpeg 6.1.1 + libass 默认 `PlayRes 384x288` + 系统 CJK 字体（实测 Noto Serif CJK） | 换字体/换版本 ⇒ `L_safe` 偏差 ⇒ 竖屏可能溢出或过度保守 | 做成命名常量集中一处；换环境必须按 §3.1 方法重新标定；联动默认关闭，风险不默认暴露 |
| **R4** | 画布字幕轨走 `options.subtitleSource` 外部 SRT（`finish.js:238-244`、`timeline.js:206`） | 若新断行误作用于外部 SRT，会**擅自重排用户稿件** | 契约把生效域限定为 `buildSRT` 自动生成路径；外部 SRT 仅做 `validateSubtitles` 校验，不重排 |
| **R5** | CPS 拆条会**改变 cue 条数** | 既有测试断言 `srtBuild.cues === 2`（`tests/test-render.js:248`）等条数断言、以及交付包/manifest 的条数记录 | `subtitleSplitForCps` **默认 false**；仅显式开启后拆条 |
| **R6** | 断行改变行数 ⇒ 经 `finish.js:79` 的 `行数 × 1.6 + 1.2` **改变 cue 时长与成片时间轴** | 交付包/发布物时间码漂移 | §5.4 要求 golden 快照；阶段 2 只对新集生效 |
| **R7** | `legacy` 模式保留 `per+1` 超长怪癖（实测 19 字） | 会触发 `validateSubtitles` 的 `line-length` 告警（`src/subtitles.js:118`），产生「自己产的字幕自己判不合规」 | 契约如实保留（兼容优先），并在文档注明；`'cjk'` 模式已修正 |
| **R8** | 计数口径双轨：`wrapCjkLegacy` 用 UTF-16 `.length`，`validateSubtitles` 用码点 `[...l].length` | emoji/罕见字（代理对）上两处判定打架 | `wrapSubtitles` 一律按**码点**（`cp()`）取首末字符与长度，并与 `validateSubtitles` 口径对齐；`legacy` 模式按 R7 保留差异 |
| **R9** | **白名单外既有缺陷（本卡只记录、不修）**：`src/qc.js:251` 读 `cfg.finish?.marginV`，而配置键实为 `finish.subtitleMarginV`（`src/config.js:161`） | QC 的「字幕规范 · 安全区」永远拿不到真实边距，回落到 `\|\| 60`，与 `finish` 实际默认 40 不一致 ⇒ QC 安全区结论失真 | **本卡不修**（越界）；建议另开卡修正为 `cfg.finish?.subtitleMarginV` |
| **R10** | 实现者若顺手把 `wrapCjkLegacy` 的 `.length` 改成码点、或删掉 `per+1` 分支 | 立即破坏 §5.4-① 的逐字节等价，既有 golden 与断言可能变红 | 契约把 `wrapCjkLegacy` 标注为「冻结基线，禁止优化」 |

---

## 8. 验收对照表

| 卡片 `acceptance_criteria` | 契约落点 | 状态 |
|---|---|---|
| 给出断行算法（标点优先 / 不可行首标点 / 数字英文不拆） | §2 全节（签名 §2.1、原子化 §2.3、算法 §2.4、12 条已验证用例 §2.6） | ✅ |
| 给出与 `maxCharsPerLine`、平台安全区的联动公式 | §3 全节（`em_px` 实测标定 §3.1、`L_safe` §3.2、6 平台数值表 §3.3、`L_eff` §3.4、CPS 拆条 §3.6） | ✅ |
| 给出向后兼容策略（既有 18 字行为不变） | §5 全节（legacy 默认、3 处必须原样、3 阶段路线、5 类测试要求）+ §4 配置默认值 | ✅ |
| 契约能直接指导实现（含函数签名 / 表结构 / 字段名） | §2.1、§2.2、§3.5、§3.6 函数签名与返回字段表；§4 配置 schema 表 + 可选 DDL；§3.5 字段来源映射表；§6 文件级改动清单 | ✅ |
| `evidence_required`：契约摘要 | §0 | ✅ |
| `evidence_required`：兼容性风险 | §7（R1–R10） | ✅ |

---

## 9. 附：本契约的证据可复现方式（全部零依赖、离线）

```bash
# 1) 既有 wrapCjk 行为（§1.3）：函数体逐字复刻后直接跑，不需要任何依赖
# 2) libass 真实折行与字号基准（§3.1）：造帧 + 烧录 + 墨迹包围盒
ffmpeg -f lavfi -i color=black:s=1080x1920:d=0.2:r=5 \
  -vf "subtitles=one.srt:force_style='FontSize=22,Alignment=2,MarginV=40'" -frames:v 1 out.png
ffmpeg -i out.png -f rawvideo -pix_fmt gray out.gray     # 再用几行 Node 求非黑包围盒
# 3) 生成的 ASS 头（旁证 PlayRes 默认 384x288）
ffmpeg -f lavfi -i color=black:s=1080x1920:d=0.2:r=5 -i one.srt -c:s ass -f ass probe.ass
```

> 本卡为**契约交付**，未改动任何源码、未新增依赖、未启动/重启服务、未运行 `./scripts/verify-all.sh`。
