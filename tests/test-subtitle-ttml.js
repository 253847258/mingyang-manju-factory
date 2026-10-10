// TTML 逐条位置/样式测试：位置（displayAlign）/对齐（textAlign）/region 生成 / 未知取值回落
// ★ 核心断言：默认参数下的 TTML 输出与**改动前**的 src/subtitles.js.bak 逐字符一致（把 .bak 复制成 .mjs 后真跑两边对比）。
// 全部用固定时间戳与固定样例：不联网、不依赖运行时刻。
// 用法：node tests/test-subtitle-ttml.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseSrt, toTtml, toTtmlDetailed, parseAlignSpec, TTML_POSITIONS, TTML_TEXT_ALIGNS } from '../src/subtitles.js';
import { parseXmlDocument, decodeEntities } from '../src/interchange-import.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? `  ${extra}` : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? `  ${extra}` : ''}`); }
};
const zh = (ws) => Array.isArray(ws) && ws.length > 0 && ws.every((w) => /[\u4e00-\u9fa5]/.test(w));

// ---------------- 固定样例：3 条字幕（固定时间戳） ----------------
const SRT = [
  '1', '00:00:01,000 --> 00:00:03,500', '第一句台词', '第二行', '',
  '2', '00:00:04,000 --> 00:00:06,000', '第二句 & <测试>', '',
  '3', '00:00:07,250 --> 00:00:09,750', '第三句', '',
].join('\n');
const CUES = parseSrt(SRT);

// ---------------- 改动前的基线（.bak 复制成 .mjs 再导入，真正跑的不是同一份代码） ----------------
const BAK = new URL('../src/subtitles.js.bak', import.meta.url);
const hasBak = fs.existsSync(BAK);
let base = null;
if (hasBak) {
  const tmp = path.join(os.tmpdir(), `subtitles-baseline-${process.pid}-${Date.now()}.mjs`);
  fs.copyFileSync(BAK, tmp);
  base = await import(pathToFileURL(tmp).href);
  fs.unlinkSync(tmp);
}

// ---------------- XML 结构小工具（复用导入侧自带的极简解析器，不引依赖） ----------------
const walk = (node, name, out = []) => {
  if (node.name === name) out.push(node);
  for (const c of node.children || []) walk(c, name, out);
  return out;
};
const xmlOf = (ttml) => {
  const root = parseXmlDocument(ttml);
  return { root, regions: walk(root, 'region'), ps: walk(root, 'p'), bodies: walk(root, 'body') };
};

console.log('\n【1】默认参数下与改动前逐字符一致（基线来自 src/subtitles.js.bak）');
ok('改动前的基线文件 src/subtitles.js.bak 存在且能独立加载', hasBak && typeof base?.toTtml === 'function', hasBak ? '' : '缺少 .bak，无法做逐字符对比');
const BASE_CASES = [
  ['默认参数（cues 对象输入）', () => base.toTtml(CUES), () => toTtml(CUES)],
  ['默认参数（SRT 字符串输入）', () => base.toTtml(SRT), () => toTtml(SRT)],
  ['自定义 lang / title', () => base.toTtml(CUES, { lang: 'en', title: '雾港 第1集' }), () => toTtml(CUES, { lang: 'en', title: '雾港 第1集' })],
  ['safeArea = null（不写 extent）', () => base.toTtml(CUES, { safeArea: null }), () => toTtml(CUES, { safeArea: null })],
  ['自定义 safeArea', () => base.toTtml(CUES, { safeArea: { top: 5, bottom: 20, left: 8, right: 8 } }), () => toTtml(CUES, { safeArea: { top: 5, bottom: 20, left: 8, right: 8 } })],
  ['空字幕（0 条）', () => base.toTtml([]), () => toTtml([])],
  ['无参数（undefined）', () => base.toTtml(), () => toTtml()],
  ['显式安全区等值（5/10/15/5 与默认相同）', () => base.toTtml(CUES, { safeArea: { top: 10, bottom: 15, left: 5, right: 5 } }), () => toTtml(CUES, { safeArea: { top: 10, bottom: 15, left: 5, right: 5 } })],
];
let identical = 0;
for (const [name, a, b] of BASE_CASES) {
  const before = hasBak ? a() : null;
  const now = b();
  const same = before !== null && before === now;
  if (same) identical++;
  ok(`逐字符一致：${name}`, same, same ? `${now.length} 字符` : '与基线不同');
}
ok(`基线对比全部逐字符一致（${identical}/${BASE_CASES.length} 组，含默认参数、字符串输入、空字幕）`, identical === BASE_CASES.length);
ok('默认参数下仍是既有形状：只有一个 region（id=bottom）、<body region="bottom">、每条 <p> 不带 region',
  (() => {
    const { regions, ps, bodies } = xmlOf(toTtml(CUES));
    return regions.length === 1 && regions[0].attrs['xml:id'] === 'bottom'
      && bodies[0].attrs.region === 'bottom' && ps.length === 3 && ps.every((p) => p.attrs.region === undefined);
  })());
ok('默认 region 的 origin/extent/displayAlign 与改动前口径相同（5% 85% / 90% 75% / after）',
  (() => {
    const r = xmlOf(toTtml(CUES)).regions[0];
    return r.attrs['tts:origin'] === '5% 85%' && r.attrs['tts:extent'] === '90% 75%' && r.attrs['tts:displayAlign'] === 'after';
  })());

console.log('\n【2】逐条位置：perCueAlign 的三种来源');
const byObj = toTtmlDetailed(CUES, { perCueAlign: { 2: 'top', 3: 'bottom-left' } });
ok('perCueAlign 对象（键 = cue.index）→ 每条落到自己的 region',
  JSON.stringify(byObj.alignments.map((a) => a.region)) === JSON.stringify(['bottom', 'top', 'bottom-left']),
  JSON.stringify(byObj.alignments.map((a) => a.region)));
ok('每条 <p> 都带上了正确的 region 属性，且 layout 里每个 region 都被引用',
  (() => {
    const { regions, ps } = xmlOf(byObj.ttml);
    const ids = regions.map((r) => r.attrs['xml:id']);
    return ps.length === 3 && ps[0].attrs.region === 'bottom' && ps[1].attrs.region === 'top' && ps[2].attrs.region === 'bottom-left'
      && ps.every((p) => ids.includes(p.attrs.region));
  })());
const byArr = toTtmlDetailed(CUES, { perCueAlign: ['top-left', null, 'right'] });
ok('perCueAlign 数组（0 基序号）生效，null 保持默认',
  JSON.stringify(byArr.alignments.map((a) => a.region)) === JSON.stringify(['top-left', 'bottom', 'bottom-right']));
const byFn = toTtmlDetailed(CUES, { perCueAlign: (c, i) => (i === 2 ? 'top-right' : null) });
ok('perCueAlign 函数（(cue, i) => 取值）生效，回调抛错也不会拖垮整篇',
  JSON.stringify(byFn.alignments.map((a) => a.region)) === JSON.stringify(['bottom', 'bottom', 'top-right'])
  && toTtmlDetailed(CUES, { perCueAlign: () => { throw new Error('boom'); } }).ttml.includes('<p begin='));
const byMap = toTtmlDetailed(CUES, { perCueAlign: new Map([[3, 'middle']]) });
ok('perCueAlign 支持 Map（键 = cue.index）', byMap.alignments[2].region === 'middle' && byMap.alignments[0].region === 'bottom');

console.log('\n【3】逐条位置：cue 上的 align / position 字段 + perCueAlign 覆盖');
const cueFields = toTtmlDetailed(CUES.map((c, i) => (i === 0 ? { ...c, position: 'top', align: 'left' } : i === 1 ? { ...c, align: 'top-right' } : c)));
ok('cue.position / cue.align 字段生效（含 top-left 这类组合写法）',
  JSON.stringify(cueFields.alignments.map((a) => a.region)) === JSON.stringify(['top-left', 'top-right', 'bottom']),
  JSON.stringify(cueFields.alignments.map((a) => a.region)));
const override = toTtmlDetailed(CUES.map((c, i) => (i === 0 ? { ...c, position: 'top', align: 'left' } : c)), { perCueAlign: { 1: 'bottom-right' } });
ok('perCueAlign 覆盖 cue 字段（按轴覆盖，最优先）', override.alignments[0].region === 'bottom-right' && override.alignments[0].position === 'bottom' && override.alignments[0].textAlign === 'right');
const axisMerge = toTtmlDetailed(CUES.map((c, i) => (i === 0 ? { ...c, position: 'top' } : c)), { perCueAlign: { 1: { align: 'right' } } });
ok('perCueAlign 只给横向时，纵向仍用 cue 字段（逐轴合并而不是整条替换）',
  axisMerge.alignments[0].position === 'top' && axisMerge.alignments[0].textAlign === 'right' && axisMerge.alignments[0].region === 'top-right');

console.log('\n【4】defaultAlign：5 个位置关键字 → displayAlign / origin');
const posCases = [['bottom', 'after'], ['after', 'after'], ['top', 'before'], ['before', 'before'], ['middle', 'center']];
let posOk = true, posDetail = [];
for (const [kw, expected] of posCases) {
  const d = toTtmlDetailed(CUES, { defaultAlign: kw });
  const { regions, bodies } = xmlOf(d.ttml);
  const good = regions.length === 1 && regions[0].attrs['tts:displayAlign'] === expected
    && bodies[0].attrs.region === regions[0].attrs['xml:id'];
  if (!good) { posOk = false; posDetail.push(`${kw}→${regions[0]?.attrs['tts:displayAlign']}`); }
}
ok('bottom/after → after，top/before → before，middle → center（region 各一个，body 正确指向）', posOk, posDetail.join(' '));
ok('defaultAlign 支持全部位置关键字（导出常量 TTML_POSITIONS 一致）',
  JSON.stringify(TTML_POSITIONS) === JSON.stringify(['bottom', 'top', 'middle', 'after', 'before']));
const topT = toTtmlDetailed(CUES, { defaultAlign: 'top' });
ok('top 位置的 origin 贴着安全区上沿（默认安全区 → 5% 10%）',
  xmlOf(topT.ttml).regions[0].attrs['tts:origin'] === '5% 10%');
const midT = toTtmlDetailed(CUES, { defaultAlign: { position: 'middle' } });
ok('defaultAlign 也支持对象写法（{ position: "middle" } → displayAlign=center）',
  midT.alignments.every((a) => a.region === 'middle') && xmlOf(midT.ttml).regions[0].attrs['tts:displayAlign'] === 'center');

console.log('\n【5】横向对齐：tts:textAlign 与安全区换算');
const safe = { top: 8, bottom: 20, left: 10, right: 6 };
const geom = toTtmlDetailed(CUES, { perCueAlign: ['bottom-left', 'bottom-right', 'middle'], safeArea: safe });
ok('自定义安全区换算正确（bottom → origin 10% 80%；origin x/y 与 extent 都由安全区算）',
  geom.regions.find((r) => r.id === 'bottom-left').origin === '10% 80%'
  && geom.regions.find((r) => r.id === 'bottom-left').extent === '84% 72%'
  && geom.regions.find((r) => r.id === 'middle').origin === '10% 8%',
  JSON.stringify(geom.regions.map((r) => `${r.id}:${r.origin}/${r.extent}`)));
ok('left / right 会写到 region 上（tts:textAlign="left"/"right"），每个用到的位置各一个 region',
  (() => {
    const { regions } = xmlOf(geom.ttml);
    const byId = Object.fromEntries(regions.map((r) => [r.attrs['xml:id'], r.attrs]));
    return regions.length === 3
      && byId['bottom-left']['tts:textAlign'] === 'left'
      && byId['bottom-right']['tts:textAlign'] === 'right'
      && byId['middle']['tts:textAlign'] === undefined
      && byId['bottom-left']['tts:displayAlign'] === 'after'
      && byId['middle']['tts:displayAlign'] === 'center';
  })());
ok('center 是默认对齐：region 上不重复写 textAlign（继承 <style xml:id="default">）',
  toTtmlDetailed(CUES, { perCueAlign: ['bottom', 'bottom', 'bottom'] }).regions.length === 1
  && xmlOf(toTtmlDetailed(CUES).ttml).regions[0].attrs['tts:textAlign'] === undefined);
ok('没有用到的位置不生成多余 region（3 条只用 2 个位置 → layout 里正好 2 个 region）',
  xmlOf(toTtmlDetailed(CUES, { perCueAlign: { 2: 'top' } }).ttml).regions.length === 2);
ok('横向关键字常量与实现一致（center/left/right）', JSON.stringify(TTML_TEXT_ALIGNS) === JSON.stringify(['center', 'left', 'right']));

console.log('\n【6】未知取值：回落默认 + 中文 warnings（不静默）');
const bogus = toTtmlDetailed(CUES, { defaultAlign: '中间', perCueAlign: { 2: 'top-under', 3: '45deg' } });
ok('未知的 defaultAlign 回落默认并给中文 warning',
  bogus.alignments[0].region === 'bottom'
  && bogus.warnings.some((w) => /默认位置取值/.test(w) && /不是支持的值/.test(w)) && zh(bogus.warnings));
ok('未知的逐条取值回落默认、且带上条目序号（不静默、不抛异常）',
  bogus.alignments[1].region === 'top' && bogus.alignments[2].region === 'bottom'
  && bogus.warnings.some((w) => /第 2 条/.test(w) && /under/.test(w))
  && bogus.warnings.some((w) => /第 3 条/.test(w) && /45deg/.test(w)), JSON.stringify(bogus.warnings));
ok('合规取值不产生任何 warning（warnings 为空 = 没有静默问题）',
  toTtmlDetailed(CUES, { defaultAlign: 'top', perCueAlign: { 2: 'bottom-left' } }).warnings.length === 0);
ok('toTtml（字符串返回值）也能通过 opts.warnings / opts.onWarn 拿到 warnings',
  (() => {
    const box = [];
    const seen = [];
    const out = toTtml(CUES, { defaultAlign: 'nope', warnings: box, onWarn: (w) => seen.push(w) });
    return typeof out === 'string' && box.length > 0 && box.length === seen.length && zh(box);
  })());
ok('parseAlignSpec 解析规则：字符串/组合/对象/数组 都对，未知值进 unknown',
  parseAlignSpec('top-left').position === 'top' && parseAlignSpec('top-left').textAlign === 'left'
  && parseAlignSpec({ position: 'after', align: 'right' }).position === 'bottom'
  && parseAlignSpec(['middle', 'right']).textAlign === 'right'
  && parseAlignSpec('bottom center').textAlign === 'center'
  && parseAlignSpec('xxx').unknown.length === 1 && parseAlignSpec('').position === null);

console.log('\n【7】结构与兼容性（XML 合法 / 时间戳 / 既有调用方）');
ok('默认与非默认输出都是合法 XML（自带解析器可解析，根节点为 tt）',
  xmlOf(toTtml(CUES)).root.children.some((c) => c.name === 'tt')
  && xmlOf(byObj.ttml).root.children.some((c) => c.name === 'tt'));
ok('时间戳仍是固定格式 00:00:01.000（逐条位置的改动没有动时间轴）',
  toTtml(CUES).includes('begin="00:00:01.000" end="00:00:03.500"') && toTtml(CUES).includes('begin="00:00:07.250"'));
ok('每条字幕一个 <p>，文本转义保留（& / < / >）',
  (() => {
    const { ps } = xmlOf(toTtml(CUES));
    return ps.length === 3 && decodeEntities(ps[1].text).includes('第二句 & <测试>');
  })());
ok('既有签名兼容：toTtml(cues) / toTtml(srt) / toTtml() 都返回字符串',
  typeof toTtml(CUES) === 'string' && typeof toTtml(SRT) === 'string' && typeof toTtml() === 'string');
ok('不传 defaultAlign/perCueAlign 时不触发任何新 warning（老调用方零感知）',
  toTtmlDetailed(CUES, { lang: 'zh', title: '测试' }).warnings.length === 0);
ok('defaultAlign 与逐条 coexisted：非默认 defaultAlign 下未覆盖的条目仍跟默认走',
  (() => {
    const d = toTtmlDetailed(CUES, { defaultAlign: 'top', perCueAlign: { 2: 'bottom' } });
    return d.alignments[0].region === 'top' && d.alignments[1].region === 'bottom' && d.alignments[2].region === 'top'
      && xmlOf(d.ttml).regions.length === 2;
  })());

console.log(`\n========== TTML 位置样式：${pass} 通过 / ${fail} 失败 ==========`);
process.exit(fail ? 1 : 0);
