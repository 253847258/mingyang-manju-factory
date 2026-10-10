// 字幕智能断行测试（任务卡 T-208，被测模块 src/subtitle-wrap.js，契约 strategist/reports/T-104-subtitle-wrap-spec.md）
//
// 覆盖四类验收点：
//   ① 断行规则：标点优先 / 禁行首标点 / 禁行尾开括号 / 数字英文不拆 / 超长原子退化；
//   ② 兼容性：默认 legacy 与既有 buildSRT 逐字节同源（含 cue 时间码 golden 快照）；
//   ③ 安全区联动：L_safe / L_eff 与真实 PLATFORM_PRESETS 对得上，中文告警齐全；
//   ④ 边界、反例、幂等性、中文报错。
//
// 约定：全部离线纯计算 —— 不联网、不起服务、不引任何依赖；库与目录一律指向 mkdtemp 临时路径；
// 时间戳全部由固定的镜头时长推导，不依赖运行时刻。
// 用法：node tests/test-subtitle-wrap.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------- 临时环境（必须在 import 被测模块之前设置：db.js 在 import 期就会建目录并打开库）----------------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-subtitle-wrap-'));
const DATA_TMP = path.join(TMP, 'data');
const DB = path.join(TMP, 'factory.db');
const CFG = path.join(TMP, 'config.json');
process.env.FACTORY_DATA_DIR = DATA_TMP;
process.env.FACTORY_DB = DB;
process.env.FACTORY_CONFIG = CFG;
fs.mkdirSync(DATA_TMP, { recursive: true });
fs.writeFileSync(CFG, JSON.stringify({ finish: { subtitleSize: 22, maxCharsPerLine: 18 } }, null, 2));

const SW = await import('../src/subtitle-wrap.js');
const { validateSubtitles, parseSrt } = await import('../src/subtitles.js');
const { buildSRT } = await import('../src/finish.js');
const { PLATFORM_PRESETS } = await import('../src/variants.js');

const {
  wrapSubtitles, wrapCjkSmart, wrapCjkLegacy, subtitleLayout, splitForCps,
  wrapCuesForPlatform, estimateLines, tokenizeAtoms, canBreak, visibleChars,
  resolveLineBreakMode, setPlatformPresets, getPlatformPresets, resetPlatformPresets,
  FORBID_LINE_START, FORBID_LINE_END, GLYPH_HEIGHT_RATIO, MIN_READABLE_CHARS_PER_LINE,
} = SW;

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? `  ${extra}` : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? `  ${extra}` : ''}`); }
};
const cp = (s) => [...String(s ?? '')];
const firstCp = (s) => cp(s)[0] ?? '';
const lastCp = (s) => { const a = cp(s); return a.length ? a[a.length - 1] : ''; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const cjk = (text, extra = {}) => wrapSubtitles(text, { lineBreakMode: 'cjk', maxCharsPerLine: 18, ...extra });

// =====================================================================================
console.log('\n【1】兼容性：默认路径与既有 buildSRT 同源（legacy 冻结基线）');

ok('默认断行模式是 legacy（未显式开启新算法时既有 18 字行为不变）',
  resolveLineBreakMode({}) === 'legacy' && resolveLineBreakMode('legacy') === 'legacy' && wrapSubtitles('短句').mode === 'legacy');
ok('未知断行模式回落 legacy 而不抛异常（成片流水线不被打断）',
  resolveLineBreakMode({ lineBreakMode: 'weird-mode' }) === 'legacy' && resolveLineBreakMode({ lineBreakMode: 'CJK' }) === 'cjk');

const compatText = '甲：这是一二三四五六七八九十甲乙丙丁戊己，然后继续说下去吧';
ok('默认模式下 wrapSubtitles().text 与冻结基线 wrapCjkLegacy() 逐字节一致',
  wrapSubtitles(compatText).text === wrapCjkLegacy(compatText, 18).text,
  JSON.stringify(wrapSubtitles(compatText).lines));

// 固定镜头（时长写死 ⇒ 时间码不依赖运行时刻），与 buildSRT 做 golden 快照比对
const GOLDEN_SHOTS = [
  { idx: 1, speaker: '甲', dialogue: '这是一二三四五六七八九十甲乙丙丁戊己，然后继续说下去吧', duration: 3 },
  { idx: 2, dialogue: '', duration: 1 },
  { idx: 3, speaker: '乙', dialogue: '今天我们一起去公园散步了。好的明天再说', duration: 2.5 },
];
const GOLDEN_SRT = '1\n00:00:00,000 --> 00:00:03,000\n甲：这是一二三四五六七八九十甲乙丙丁\n戊己，然后继续说下去吧\n\n'
  + '2\n00:00:04,000 --> 00:00:06,500\n乙：今天我们一起去公园散步了。\n好的明天再说\n';
const built = buildSRT(GOLDEN_SHOTS);
ok('buildSRT 输出与既有 golden 快照逐字节一致（含 cue 时间码，断行/行数耦合未被改动）',
  built.srt === GOLDEN_SRT, `${built.cues} 条 / ${built.duration}s`);
ok('buildSRT 的空台词镜头仍然不出字幕（skipEmpty 语义与既有行为一致）',
  built.cues === 2 && parseSrt(built.srt).length === 2);

const wrappedByApi = wrapCuesForPlatform(GOLDEN_SHOTS);
const builtCues = parseSrt(built.srt);
ok('默认口径下 wrapCuesForPlatform 与 buildSRT 的条数与每 cue 正文逐字节一致（含说话人前缀）',
  wrappedByApi.ok && wrappedByApi.stats.cuesOut === built.cues
  && eq(wrappedByApi.cues.map((c) => c.text), builtCues.map((c) => c.text)),
  JSON.stringify(wrappedByApi.cues.map((c) => c.text)));

const perPlusOne = '一二三四五六七八九十甲乙丙丁戊己庚，然后接着说下去';
const legacyPerPlusOne = wrapCjkLegacy(perPlusOne, 18);
ok('legacy 保留「满行遇标点产出 per+1 超长行」怪癖（兼容优先，不顺手修正）',
  (legacyPerPlusOne.lines[0] || '').length === 19 && legacyPerPlusOne.maxLineChars === 19,
  `首行 ${(legacyPerPlusOne.lines[0] || '').length} 字`);
ok('legacy 计数口径是 UTF-16 单元（emoji 行实际码点少于 18，标志兼容性未被改成码点计数）',
  wrapCjkLegacy('测试😀表情符号一二三四五六七八九十甲乙丙丁戊己庚辛', 18).maxLineChars === 17,
  JSON.stringify(wrapCjkLegacy('测试😀表情符号一二三四五六七八九十甲乙丙丁戊己庚辛', 18).lines));

// =====================================================================================
console.log('\n【2】正常路径：断行规则（标点优先 / 禁则 / 数字英文不拆）');

ok('标点优先：句末标点「。」之后断行，且不把短句并到后一行',
  eq(cjk('今天我们一起去公园散步了。好的明天再说').lines, ['今天我们一起去公园散步了。', '好的明天再说']));
ok('数字英文不拆：长英文整词独占一行并给出中文告警',
  eq(cjk('这里有个单词 supercalifragilistic 后面继续写中文内容').lines, ['这里有个单词', 'supercalifragilistic', '后面继续写中文内容']));
ok('不可拆数字完整保留：10 位数字不被腰斩',
  eq(cjk('预算约为 1234567890 元人民币请确认这个数字').lines, ['预算约为 1234567890 元人', '民币请确认这个数字']));
ok('时间码与百分比不拆（12:34 / 25% 各自完整）',
  eq(cjk('进度 12:34 已经到 25% 了请确认这个数据').lines, ['进度 12:34 已经到 25% 了', '请确认这个数据']));
ok('连续标点整组不拆到两行（「，。」留在同一行末尾）',
  eq(cjk('一二三四五六七八九十甲乙丙丁戊己，。然后接着说').lines, ['一二三四五六七八九十甲乙丙丁戊己，。', '然后接着说']));
ok('插入说明场景不产生行尾开括号（行尾字符不在行尾禁则集里）',
  eq(cjk('他说（这是一个很长的插入说明内容）然后继续说话').lines, ['他说（这是一个很长的插入说明内容）然', '后继续说话']));
ok('说话人前缀计入单行字数，短台词不加行',
  eq(cjk('甲：第一句台词').lines, ['甲：第一句台词']));
ok('未超单行上限时不主动加行',
  eq(cjk('甲乙丙丁戊己庚辛壬癸').lines, ['甲乙丙丁戊己庚辛壬癸']));

// =====================================================================================
console.log('\n【3】反例：既有算法会踩的禁则，新算法必须避开');

const punctFirst = '这是一二三四五六七八九十甲乙丙丁戊己，然后继续说下去吧';
const legacyBad = wrapCjkLegacy(punctFirst, 18);
const cjkGood = cjk(punctFirst);
ok('反例（行首标点）：legacy 第 2 行以「，」开头', String(legacyBad.lines[1] ?? '').startsWith('，'), JSON.stringify(legacyBad.lines));
ok('禁行首标点：cjk 断行结果没有任何一行以禁则字符开头',
  eq(cjkGood.lines, ['这是一二三四五六七八九十甲乙丙丁戊', '己，然后继续说下去吧'])
  && cjkGood.lines.every((l) => !FORBID_LINE_START.includes(firstCp(l))),
  JSON.stringify(cjkGood.lines));

const bracketLast = '一二三四五六七八九十甲乙丙丁戊己庚（后面继续说话';
ok('反例（行尾开括号）：legacy 第 1 行以「（」收尾',
  FORBID_LINE_END.includes(lastCp(wrapCjkLegacy(bracketLast, 18).lines[0])),
  JSON.stringify(wrapCjkLegacy(bracketLast, 18).lines));
ok('禁行尾开括号：cjk 断行结果没有任何一行以「（」收尾，且不丢字',
  cjk(bracketLast).lines.every((l) => !FORBID_LINE_END.includes(lastCp(l)))
  && cjk(bracketLast).lines.join('') === bracketLast,
  JSON.stringify(cjk(bracketLast).lines));

const longWord = '这里有个单词 supercalifragilistic 后面继续写中文内容';
ok('反例（英文被腰斩）：legacy 把 supercalifragilistic 拆到两行',
  wrapCjkLegacy(longWord, 18).lines.some((l) => l.includes('supercalifr')),
  JSON.stringify(wrapCjkLegacy(longWord, 18).lines));
ok('不可拆原子：cjk 输出中该词完整出现在同一行内',
  cjk(longWord).lines.includes('supercalifragilistic'));

// 与既有校验口径对齐：legacy 的 per+1 长行会被自己的 validateSubtitles 判超长，cjk 不会
const asCues = (lines) => [{ index: 1, start: 0, end: 2.6, duration: 2.6, lines, text: lines.join('\n'), chars: visibleChars(lines.join('')) }];
const cjkPerPlusOne = cjk(perPlusOne);
const vLegacy = validateSubtitles(asCues(legacyPerPlusOne.lines), { maxCharsPerLine: 18, maxLines: 2 });
const vCjk = validateSubtitles(asCues(cjkPerPlusOne.lines), { maxCharsPerLine: 18, maxLines: 2 });
ok('口径闭环：legacy 的 19 字行被 validateSubtitles 判「单行超长」（R7 已知差异，未被隐藏）',
  vLegacy.counts.longLines === 1 && /单行 19 字/.test((vLegacy.checks.find((c) => c.id === 'line-length') || {}).message || ''),
  (vLegacy.checks.find((c) => c.id === 'line-length') || {}).message);
ok('口径闭环：cjk 同一输入不再触发单行超长，且没有一行以「，」开头',
  vCjk.counts.longLines === 0 && vCjk.checks.length > 0
  && cjkPerPlusOne.lines.every((l) => !FORBID_LINE_START.includes(firstCp(l))),
  JSON.stringify(cjkPerPlusOne.lines));

// =====================================================================================
console.log('\n【4】边界：空串 / 极小上限 / 超长原子 / 硬换行 / 行数上限');

ok('边界（空串与纯空白）：cjk 返回空行数组且 maxLineChars 为 0',
  eq(cjk('').lines, []) && eq(cjk('   ').lines, []) && cjk('   ').maxLineChars === 0);
ok('边界（未超限）：不主动加行、不改字',
  eq(cjk('短句').lines, ['短句']));
ok('边界（极小上限 maxCharsPerLine=1）：逐字一行且不丢字不增字',
  eq(cjk('短句', { maxCharsPerLine: 1 }).lines, ['短', '句'])
  && cjk('短句', { maxCharsPerLine: 1 }).lines.join('') === '短句');
ok('边界（上限非法）：maxCharsPerLine=0/负数回落默认 18，不抛异常',
  wrapSubtitles('甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申', { maxCharsPerLine: 0 }).maxCharsPerLine === 18
  && wrapSubtitles('甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申', { maxCharsPerLine: -5 }).maxCharsPerLine === 18);

const longAtom = cjk('这里有个单词 supercalifragilistic 后面继续写中文内容');
ok('边界（单原子超长退化）：独占一行且 overflow 标记为真，不拆字不丢字',
  longAtom.overflow === true && longAtom.lines.includes('supercalifragilistic')
  && longAtom.lines.join('') === '这里有个单词supercalifragilistic后面继续写中文内容'
  && eq(longAtom.lines, ['这里有个单词', 'supercalifragilistic', '后面继续写中文内容']),
  JSON.stringify(longAtom.lines));
ok('中文告警：超长原子给出「原子超长…（20 > 18）…已独占一行」的可读提示',
  longAtom.warnings.some((w) => /原子超长：supercalifragilistic（20 > 18），已独占一行/.test(w)) && !/undefined|NaN/.test(longAtom.warnings.join('')),
  JSON.stringify(longAtom.warnings));

const emojiText = '测试😀表情符号一二三四五六七八九十甲乙丙丁戊己庚辛';
const emojiWrap = cjk(emojiText);
ok('边界（代理对）：emoji 不被撕裂，且 cjk 每行码点数不超过上限',
  emojiWrap.lines.join('') === emojiText
  && emojiWrap.lines.every((l) => cp(l).length <= 18)
  && emojiWrap.lines.every((l) => !l.includes('\uFFFD')),
  JSON.stringify(emojiWrap.lines));
ok('边界（UTF-16 vs 码点）：同一 emoji 文本上 cjk 按码点计满 18，legacy 因按 UTF-16 计数而更短',
  emojiWrap.maxLineChars === 18 && wrapCjkLegacy(emojiText, 18).maxLineChars === 17,
  `cjk ${emojiWrap.maxLineChars} / legacy ${wrapCjkLegacy(emojiText, 18).maxLineChars}`);

ok('边界（硬换行）：默认把 \\n 当作者显式意图保留',
  eq(cjk('第一行\n第二行内容').lines, ['第一行', '第二行内容']));
ok('边界（关掉硬换行）：preserveNewlines=false 时 \\n 按空白处理并重新断行',
  eq(wrapSubtitles('第一行\n第二行内容', { lineBreakMode: 'cjk', preserveNewlines: false }).lines, ['第一行 第二行内容']));
ok('边界（行数上限）：超过 maxLines 只告警不截断、不丢字',
  (() => {
    const r = wrapSubtitles('今天我们一起去公园散步了。好的明天再说，顺便看看这个 1234567890 数字', { lineBreakMode: 'cjk', maxLines: 1 });
    return r.exceedsMaxLines === true && r.lines.length === 3 && r.lines.join('').replace(/\s/g, '').length === visibleChars(r.lines.join('\n'))
      && r.warnings.some((w) => /超过 maxLines=1/.test(w) && /不截断、不丢字/.test(w));
  })(),
  JSON.stringify(wrapSubtitles('今天我们一起去公园散步了。好的明天再说，顺便看看这个 1234567890 数字', { lineBreakMode: 'cjk', maxLines: 1 }).warnings.slice(-1)));

const punctOnly = wrapSubtitles('。'.repeat(12), { lineBreakMode: 'cjk', maxCharsPerLine: 6 });
ok('边界（全标点退化输入）：行内不存在合法断点时强制断行，仍然不丢字、不超限，并给中文告警',
  punctOnly.lines.join('') === '。'.repeat(12) && punctOnly.lines.every((l) => cp(l).length <= 6)
  && punctOnly.warnings.some((w) => /禁则无合法断点，已在第 1 个原子处强制断行/.test(w)),
  `${JSON.stringify(punctOnly.lines)} ${JSON.stringify(punctOnly.warnings)}`);

// =====================================================================================
console.log('\n【5】平台安全区联动（L_safe / L_eff）与中文报错');

setPlatformPresets(PLATFORM_PRESETS);
ok('平台规格表可注入也可读出（不直接 import variants.js，避免 db.js 副作用）',
  getPlatformPresets() === PLATFORM_PRESETS && Object.keys(PLATFORM_PRESETS).length >= 6);

const layDouyinOff = subtitleLayout({ presetId: 'douyin' });
const layDouyinOn = subtitleLayout({ presetId: 'douyin', applySafeAreaLimit: true });
ok('未开联动时单行上限就是配置值 18（既有行为不变，安全区不构成约束）',
  layDouyinOff.maxCharsPerLine === 18 && layDouyinOff.maxCharsPerLineSafe === 9 && layDouyinOff.safeAreaLimited === false);
ok('竖屏抖音开启联动：L_safe=9 且 L_eff 被安全区收窄为 9（契约 §3.3）',
  layDouyinOn.maxCharsPerLine === 9 && layDouyinOn.safeAreaLimited === true && layDouyinOn.capacityChars === 18,
  `L_safe=${layDouyinOn.maxCharsPerLineSafe} L_eff=${layDouyinOn.maxCharsPerLine}`);
ok('联动公式只用比例：单字宽 = 100 × GLYPH_HEIGHT_RATIO × 字号 × 高/宽',
  Math.abs(layDouyinOn.glyphWidthPct - 100 * GLYPH_HEIGHT_RATIO * 22 * (1920 / 1080)) < 0.01
  && layDouyinOn.availWidthPct === 88,
  `glyphWidthPct=${layDouyinOn.glyphWidthPct}`);

const safeTable = {};
for (const id of ['douyin', 'xiaohongshu', 'square', 'bilibili']) {
  safeTable[id] = subtitleLayout({ presetId: id, applySafeAreaLimit: true }).maxCharsPerLine;
}
ok('各平台 L_eff 与契约数值表一致（抖音 9 / 小红书 12 / 方图 16 / B 站 18）',
  safeTable.douyin === 9 && safeTable.xiaohongshu === 12 && safeTable.square === 16 && safeTable.bilibili === 18,
  JSON.stringify(safeTable));
ok('横屏平台安全区放得下 18 字，因此不被收窄（safeAreaLimited=false）',
  subtitleLayout({ presetId: 'bilibili', applySafeAreaLimit: true }).safeAreaLimited === false
  && subtitleLayout({ presetId: 'bilibili', applySafeAreaLimit: true }).maxCharsPerLineSafe === 30);
ok('排版口径 rule 是可读中文描述，能直接进质检报告',
  /单行 ≤9 字/.test(layDouyinOn.rule) && /已按安全区收窄/.test(layDouyinOn.rule) && /1080×1920/.test(layDouyinOn.rule),
  layDouyinOn.rule);

const narrow = subtitleLayout({
  presets: { x: { id: 'x', width: 1080, height: 1920, safeArea: { top: 8, bottom: 22, left: 45, right: 45 } } },
  presetId: 'x', applySafeAreaLimit: true,
});
ok('中文告警：安全区放不下可读下限时，L_eff 收敛到 6 并给出调小字号的建议',
  narrow.maxCharsPerLineSafe === 1 && narrow.maxCharsPerLine === MIN_READABLE_CHARS_PER_LINE
  && narrow.warnings.some((w) => /低于可读下限 6/.test(w) && /finish\.subtitleSize/.test(w)),
  JSON.stringify(narrow.warnings.filter((w) => /可读下限/.test(w))));

const unknown = subtitleLayout({ presetId: 'not-a-platform' });
ok('中文报错：未知平台规格返回 ok:false 与可读中文错误信息（不抛异常）',
  unknown.ok === false && /未知平台规格：not-a-platform/.test(unknown.error),
  unknown.error);
ok('中文报错：平台规格表类型非法时抛出中文 TypeError',
  (() => { try { setPlatformPresets(42); return false; } catch (e) { return e instanceof TypeError && /平台规格表必须是对象/.test(e.message); } })());
ok('中文告警：没有成片尺寸时按默认尺寸估算并提示偏差风险',
  subtitleLayout({ applySafeAreaLimit: true }).warnings.some((w) => /未提供成片尺寸/.test(w))
  && subtitleLayout({ applySafeAreaLimit: true }).warnings.some((w) => /未提供平台安全区/.test(w)));
resetPlatformPresets();
ok('清空注入后预设失效，但显式传尺寸/安全区仍然可算（注入前后行为一致）',
  getPlatformPresets() === null
  && subtitleLayout({ videoWidth: 1080, videoHeight: 1920, safeArea: { top: 8, bottom: 22, left: 6, right: 6 }, applySafeAreaLimit: true }).maxCharsPerLine === 9);
setPlatformPresets(PLATFORM_PRESETS);

// =====================================================================================
console.log('\n【6】CPS 拆条（容量 / 阅读预算）与告警');

const longLine = '这是一段很长的台词需要被拆成两条来显示内容够长了吧';   // 25 字
const split = splitForCps({ text: longLine, duration: 3, presetId: 'douyin', applySafeAreaLimit: true, lineBreakMode: 'cjk' });
ok('竖屏 25 字 / 3s：超出单条容量（2×9=18），拆成 2 条',
  split.ok && split.segments === 2 && (split.layout || {}).maxCharsPerLine === 9, `segments=${split.segments}`);
ok('拆条时长按字数比例分配且总和等于原时长（时间轴不漂移）',
  Math.abs(split.cues.reduce((s, c) => s + c.duration, 0) - 3) < 0.01
  && split.cues.every((c) => c.splitTotal === 2 && c.splitIndex >= 1 && c.duration > 0),
  JSON.stringify(split.cues.map((c) => [c.chars, c.duration])));
ok('中文告警：拆条给出「超出单条容量/阅读预算…已拆成 2 条」的说明',
  split.warnings.some((w) => /超出单条容量\/阅读预算（25 字 · 3s），已拆成 2 条/.test(w)),
  JSON.stringify(split.warnings.filter((w) => /已拆成/.test(w))));
ok('容量放得下就不拆：12 字 / 3s 仍是一条（默认关闭拆条语义下不改变条数）',
  splitForCps({ text: '今天我们一起去公园散步了', duration: 3, presetId: 'douyin', applySafeAreaLimit: true, lineBreakMode: 'cjk' }).segments === 1);
const tooShort = splitForCps({ text: longLine, duration: 0.5, presetId: 'douyin', applySafeAreaLimit: true, lineBreakMode: 'cjk' });
ok('中文告警：拆出来的段低于最小停留时逐段提示，且提示语为中文',
  tooShort.warnings.some((w) => /低于最小停留 0\.8s/.test(w))
  && tooShort.warnings.some((w) => /超过 maxCps 21/.test(w)),
  JSON.stringify(tooShort.warnings.slice(1, 3)));
ok('错误传播：联动开启但平台规格未知时 splitForCps 返回 ok:false 与中文错误',
  splitForCps({ text: '短句', duration: 3, presetId: 'not-a-platform', applySafeAreaLimit: true }).ok === false
  && /未知平台规格/.test(splitForCps({ text: '短句', duration: 3, presetId: 'not-a-platform', applySafeAreaLimit: true }).error));

// =====================================================================================
console.log('\n【7】幂等性与确定性');

const idemSrc = '今天我们一起去公园散步了。好的明天再说，顺便看看这个数字';
const idemA = wrapSubtitles(idemSrc, { lineBreakMode: 'cjk', maxCharsPerLine: 9 });
const idemB = wrapSubtitles(idemSrc, { lineBreakMode: 'cjk', maxCharsPerLine: 9 });
ok('确定性：同一输入重复调用结果完全一致（行、文本、告警、统计）',
  eq(idemA.lines, idemB.lines) && idemA.text === idemB.text && eq(idemA.warnings, idemB.warnings)
  && idemA.maxLineChars === idemB.maxLineChars);
ok('幂等性：对已断行结果再断行一次，输出不变（不会越断越碎、不会丢字）',
  wrapSubtitles(idemA.text, { lineBreakMode: 'cjk', maxCharsPerLine: 9 }).text === idemA.text
  && wrapSubtitles(idemA.text, { lineBreakMode: 'cjk', maxCharsPerLine: 9 }).maxLineChars <= 9,
  JSON.stringify(idemA.lines));
ok('幂等性：含超长原子（10 位数字 · 上限 9）时也稳定 —— 再断行文本不变，overflow 仍被标出',
  (() => {
    const s = wrapSubtitles('今天天气不错 1234567890 出门走走', { lineBreakMode: 'cjk', maxCharsPerLine: 9 });
    return s.overflow === true && s.lines.includes('1234567890')
      && wrapSubtitles(s.text, { lineBreakMode: 'cjk', maxCharsPerLine: 9 }).text === s.text;
  })());
ok('幂等性：legacy 模式重复调用也完全一致（不引入随机与状态）',
  wrapSubtitles(idemSrc, {}).text === wrapSubtitles(idemSrc, {}).text
  && wrapSubtitles(idemSrc, {}).text === wrapCjkLegacy(idemSrc, 18).text);
ok('幂等性：平台化批量断行对同一批 cue 重复调用结果一致（无跨调用状态污染）',
  eq(wrapCuesForPlatform(GOLDEN_SHOTS).cues.map((c) => c.text), wrappedByApi.cues.map((c) => c.text))
  && eq(wrapCuesForPlatform(GOLDEN_SHOTS).warnings, wrappedByApi.warnings));
ok('便捷版 wrapCjkSmart 只取文本，默认 legacy / 显式 cjk 分别对应两种断行',
  wrapCjkSmart(punctFirst) === wrapCjkLegacy(punctFirst, 18).text
  && wrapCjkSmart(punctFirst, { lineBreakMode: 'cjk' }) === cjk(punctFirst).text
  && wrapCjkSmart(punctFirst) !== wrapCjkSmart(punctFirst, { lineBreakMode: 'cjk' }),
  JSON.stringify([wrapCjkSmart(punctFirst).split('\n'), wrapCjkSmart(punctFirst, { lineBreakMode: 'cjk' }).split('\n')]));

// =====================================================================================
console.log('\n【8】辅助口径与汇总一致性');

const atoms = tokenizeAtoms('进度 12:34 到 25% 见 https://a.b/c?d=1 或 book@ex.com ABC123');
ok('原子化：时间码/百分比/URL/邮箱各成不可拆原子，字母数字串合并为一个原子',
  atoms.some((a) => a.type === 'token' && a.text === '12:34')
  && atoms.some((a) => a.type === 'num' && a.text === '25%')
  && atoms.some((a) => a.type === 'token' && a.text === 'https://a.b/c?d=1')
  && atoms.some((a) => a.type === 'token' && a.text === 'book@ex.com')
  && atoms.some((a) => a.type === 'alnum' && a.text === 'ABC123'),
  JSON.stringify(atoms.map((a) => a.type).join(',')));
ok('禁则判定：不允许以上一行空格收尾，也不允许下一行以禁行首标点开头',
  canBreak({ type: 'space', text: ' ' }, { type: 'char', text: '中' }) === false
  && canBreak({ type: 'char', text: '中' }, { type: 'char', text: '，' }) === false
  && canBreak({ type: 'char', text: '中' }, { type: 'char', text: '文' }) === true);

const est = estimateLines(longLine, { duration: 3, presetId: 'douyin', applySafeAreaLimit: true, lineBreakMode: 'cjk' });
const estWrap = cjk(longLine, { maxCharsPerLine: 9 });
ok('行数预估与断行结果一致，并给出「放不下一整条 / 需要拆几条」的结论',
  est.ok && est.lineCount === estWrap.lines.length && est.chars === visibleChars(longLine)
  && est.maxCharsPerLine === 9 && est.capacityChars === 18 && est.requiredSegments === 2
  && est.needsSplit === true && est.fitsOneCue === false,
  `行数=${est.lineCount} 需要${est.requiredSegments}条`);

const batchShots = [
  { speaker: '甲', dialogue: '短句', duration: 1 },
  { dialogue: '   ', duration: 1 },
  { dialogue: '今天天气不错今天天气不错今天天气不错今天天气不错', duration: 4 },
];
const batch = wrapCuesForPlatform(batchShots, { presetId: 'douyin', applySafeAreaLimit: true, lineBreakMode: 'cjk' });
ok('批量断行统计自洽（输出条数 = 逐条行数求和、最长行与逐条一致、空台词被跳过并有中文说明）',
  batch.ok && batch.stats.cuesIn === 3 && batch.stats.cuesOut === 2 && batch.stats.skippedEmpty === 1
  && batch.stats.totalLines === batch.cues.reduce((s, c) => s + c.lines.length, 0)
  && batch.stats.maxLineChars === Math.max(...batch.cues.map((c) => c.lines.reduce((m, l) => Math.max(m, visibleChars(l)), 0)))
  && batch.warnings.some((w) => /已跳过 1 条无台词条目/.test(w)),
  JSON.stringify(batch.stats));
ok('默认口径下批量断行的出条数与既有 buildSRT 完全一致（空台词镜头两边都跳过）',
  wrapCuesForPlatform(batchShots).stats.cuesOut === buildSRT(batchShots).cues
  && wrapCuesForPlatform(batchShots).stats.cuesOut === 2,
  `批量 ${wrapCuesForPlatform(batchShots).stats.cuesOut} 条 / buildSRT ${buildSRT(batchShots).cues} 条`);
ok('批量断行遵守安全区上限：竖屏每条每行都不超过 9 字',
  batch.cues.every((c) => c.lines.every((l) => visibleChars(l) <= 9)),
  JSON.stringify(batch.cues.map((c) => c.lines)));
ok('批量断行入参非法时返回中文错误而不抛异常（数组/ {cues}/{shots} 三种入参都吃）',
  wrapCuesForPlatform(null).ok === false && /cues 必须是数组/.test(wrapCuesForPlatform(null).error)
  && wrapCuesForPlatform({ shots: GOLDEN_SHOTS }).ok === true && wrapCuesForPlatform({ cues: GOLDEN_SHOTS }).ok === true);

// =====================================================================================
console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch { /* 临时目录清理失败不影响结论 */ }
process.exit(fail ? 1 : 0);
