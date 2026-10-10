// 时间线交换格式导入侧测试：FCP7 XML（xmeml v4）/ OTIO（Timeline.1）→ 统一 clips → 成片节点接入计划
// 全部用固定样例与固定时间戳：不联网、不读运行时刻、不依赖外部服务（零依赖，只要 node ≥22）。
// 用法：node tests/test-interchange-import.js
import fs from 'node:fs';
import { buildFcp7Xml, buildOtio } from '../src/interchange.js';
import {
  parseFcp7Xml, parseOtio, detectInterchange, parseInterchange, clipsToTimelinePlan,
  urlToPath, parseXmlDocument, framesToSeconds, secondsToFrames,
} from '../src/interchange-import.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? `  ${extra}` : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? `  ${extra}` : ''}`); }
};
const zh = (ws) => Array.isArray(ws) && ws.length > 0 && ws.every((w) => typeof w === 'string' && /[\u4e00-\u9fa5]/.test(w));
const never = (fn, label) => { try { fn(); return true; } catch (e) { console.log(`      ⚠ ${label} 抛了未捕获异常：${e.message}`); return false; } };

// ---------------- 固定样例：FCP7 XML（xmeml v4） ----------------
// 故意做成「片段在文档里倒序（镜头B 在前）」，用来验证：解析保留文档顺序、接入计划按 recordIn 重排。
const FIX_FCP7 = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
  <sequence id="sequence-1">
    <name>雾港 第1集</name>
    <duration>240</duration>
    <rate><timebase>24</timebase><ntsc>FALSE</ntsc></rate>
    <media>
      <video>
        <format><samplecharacteristics><width>720</width><height>1280</height></samplecharacteristics></format>
        <track>
          <clipitem id="clipitem-2">
            <name>镜头B</name>
            <duration>48</duration>
            <rate><timebase>24</timebase></rate>
            <start>96</start>
            <end>144</end>
            <in>0</in>
            <out>48</out>
            <file id="file-2">
              <name>镜 2.mp4</name>
              <pathurl>file://localhost/Users/lin/%E7%B4%A0%E6%9D%90/%E9%95%9C%202.mp4</pathurl>
              <rate><timebase>24</timebase></rate>
              <duration>48</duration>
            </file>
            <marker><name>台词</name><comment>别回头 &amp; 快走</comment><in>0</in><out>-1</out></marker>
          </clipitem>
          <clipitem id="clipitem-1">
            <name>镜头A</name>
            <duration>96</duration>
            <start>0</start>
            <end>96</end>
            <file id="file-1">
              <name>镜 1.mp4</name>
              <pathurl>file://localhost/Users/lin/%E7%B4%A0%E6%9D%90/%E9%95%9C%201.mp4</pathurl>
            </file>
            <marker><name>动作</name><comment>推门</comment></marker>
          </clipitem>
        </track>
      </video>
      <audio>
        <track>
          <clipitem id="audio-1"><name>配音</name><duration>96</duration><start>0</start><end>96</end>
            <file><name>vo.wav</name><pathurl>file://localhost/Users/lin/%E7%B4%A0%E6%9D%90/vo.wav</pathurl></file>
          </clipitem>
        </track>
      </audio>
    </media>
  </sequence>
</xmeml>
`;

// FCP7 容错样例：缺帧率 / -inf / 零时长 / 重复 id
const FIX_FCP7_BAD = `<?xml version="1.0" encoding="UTF-8"?>
<xmeml version="4">
  <sequence id="sequence-1">
    <name>容错样例</name>
    <media><video><track>
      <clipitem id="dup-1"><name>缺帧率</name><duration>50</duration><start>0</start><end>50</end>
        <file><name>a.mp4</name><pathurl>file://localhost/tmp/a.mp4</pathurl></file></clipitem>
      <clipitem id="dup-1"><name>负数时间</name><duration>-inf</duration><start>-inf</start><end>25</end>
        <file><name>b.mp4</name><pathurl>file://localhost/tmp/b.mp4</pathurl></file></clipitem>
      <clipitem id="dup-3"><name>零时长</name><duration>0</duration><start>25</start><end>25</end>
        <file><name>c.mp4</name><pathurl>file://localhost/tmp/c.mp4</pathurl></file></clipitem>
    </track></video></media>
  </sequence>
</xmeml>
`;

// ---------------- 固定样例：OTIO（Timeline.1 → Stack.1 → Track.1 → Clip.1） ----------------
const FIX_OTIO = JSON.stringify({
  OTIO_SCHEMA: 'Timeline.1',
  name: '雾港 第1集',
  metadata: { 'ai-video-factory': { generator: 'test', fps: 24 } },
  global_start_time: { OTIO_SCHEMA: 'RationalTime.1', rate: 24, value: 0 },
  tracks: {
    OTIO_SCHEMA: 'Stack.1',
    name: 'tracks',
    children: [
      {
        OTIO_SCHEMA: 'Track.1', name: 'V1', kind: 'Video', children: [
          {
            OTIO_SCHEMA: 'Clip.1', name: '镜头A',
            source_range: {
              OTIO_SCHEMA: 'TimeRange.1',
              start_time: { OTIO_SCHEMA: 'RationalTime.1', rate: 24, value: 12 },
              duration: { OTIO_SCHEMA: 'RationalTime.1', rate: 24, value: 48 },
            },
            media_reference: { OTIO_SCHEMA: 'ExternalReference.1', target_url: 'file://localhost/Users/lin/%E7%B4%A0%E6%9D%90/%E9%95%9C%201.mp4' },
            markers: [{ OTIO_SCHEMA: 'Marker.2', name: '台词', comment: '别回头' }],
          },
          { OTIO_SCHEMA: 'Gap.1', source_range: { OTIO_SCHEMA: 'TimeRange.1', duration: { rate: 24, value: 24 } } },
          {
            OTIO_SCHEMA: 'Clip.1', name: '镜头B',
            source_range: { OTIO_SCHEMA: 'TimeRange.1', duration: { rate: 24, value: 36 } },
            media_reference: { OTIO_SCHEMA: 'MissingReference.1' },
          },
        ],
      },
      {
        OTIO_SCHEMA: 'Track.1', name: 'A1', kind: 'Audio', children: [
          {
            OTIO_SCHEMA: 'Clip.1', name: '配音',
            source_range: { OTIO_SCHEMA: 'TimeRange.1', duration: { rate: 24, value: 48 } },
            media_reference: { OTIO_SCHEMA: 'ExternalReference.1', target_url: 'file://localhost/Users/lin/%E7%B4%A0%E6%9D%90/vo.wav' },
          },
        ],
      },
    ],
  },
}, null, 2);

// ================= 1. 格式嗅探（按内容，不看扩展名） =================
console.log('\n【1】detectInterchange 内容嗅探');
ok('FCP7 XML 文本 → fcp7', detectInterchange(FIX_FCP7) === 'fcp7');
ok('OTIO JSON 文本 → otio', detectInterchange(FIX_OTIO) === 'otio');
ok('SRT / HTML / 空文本 → null',
  detectInterchange('1\n00:00:01,000 --> 00:00:02,000\n台词\n') === null
  && detectInterchange('<html><body>hi</body></html>') === null
  && detectInterchange('   ') === null && detectInterchange(null) === null);
ok('坏 JSON（截断）→ null（不瞎猜格式，交给 parse* 报中文原因）', detectInterchange('{ "OTIO_SCHEMA": "Timeline.1"') === null);
ok('空序列（无 clipitem）的 FCP7 也能认出来', detectInterchange('<?xml version="1.0"?><xmeml version="4"><sequence><rate><timebase>25</timebase></rate></sequence></xmeml>') === 'fcp7');

// ================= 2. FCP7 XML 正常解析 =================
console.log('\n【2】parseFcp7Xml 正常样例');
const R = parseFcp7Xml(FIX_FCP7);
ok('ok=true / 帧率 24 / 序列名 / 片段数 2', R.ok === true && R.fps === 24 && R.sequenceName === '雾港 第1集' && R.clips.length === 2, JSON.stringify({ fps: R.fps, n: R.clips.length }));
ok('音频轨片段不计入 clips，且给出中文提示',
  R.clips.every((c) => c.name !== '配音') && R.warnings.some((w) => /音频轨/.test(w)), JSON.stringify(R.warnings));
const cA = R.clips.find((c) => c.name === '镜头A'), cB = R.clips.find((c) => c.name === '镜头B');
ok('保留文档顺序（样例里镜头B 写在前面，clips[0] 就是镜头B）', R.clips[0].name === '镜头B' && R.clips[1].name === '镜头A');
ok('帧 → 秒 换算正确（镜头B：96~144 帧 @24fps → 4s~6s，时长 2s）',
  cB.start === 4 && cB.end === 6 && cB.duration === 2 && cB.recordIn === 96 && cB.recordOut === 144, JSON.stringify({ s: cB.start, e: cB.end, d: cB.duration }));
ok('镜头A：0~96 帧 → 0s~4s，recordIn/recordOut 保留原始帧值',
  cA.start === 0 && cA.end === 4 && cA.duration === 4 && cA.recordIn === 0 && cA.recordOut === 96);
ok('file://localhost/... 还原成路径（%20 与中文百分号编码都解码）',
  cA.pathurl === 'file://localhost/Users/lin/%E7%B4%A0%E6%9D%90/%E9%95%9C%201.mp4'
  && cA.file === '/Users/lin/素材/镜 1.mp4' && cB.file === '/Users/lin/素材/镜 2.mp4', cB.file);
ok('标记（marker）名字与注释都解出来，且 &amp; 实体解码',
  cB.markers.length === 1 && cB.markers[0].name === '台词' && cB.markers[0].comment === '别回头 & 快走'
  && cA.markers[0].name === '动作' && cA.markers[0].comment === '推门', JSON.stringify(cB.markers));
ok('视频轨编号可追溯（track=V1）', cA.track === 'V1' && cB.track === 'V1');

// ================= 3. FCP7 容错（中文 warnings，不抛异常） =================
console.log('\n【3】parseFcp7Xml 容错');
const B = parseFcp7Xml(FIX_FCP7_BAD);
ok('缺 <rate><timebase> → 回落 25 fps 并给中文提示',
  B.fps === 25 && B.warnings.some((w) => /帧率/.test(w)) && zh(B.warnings.filter((w) => /帧率/.test(w))));
ok('-inf 等非法时间值 → 中文提示且按 0 处理（负数时长不会算进成片）',
  B.warnings.some((w) => /-inf|不是有效数字/.test(w)) && B.clips.every((c) => Number.isFinite(c.duration) && c.duration >= 0),
  JSON.stringify(B.clips.map((c) => c.duration)));
ok('零时长片段被标出（start==end 不会出现在成片上）',
  B.warnings.some((w) => /时长为 0/.test(w)) && B.clips.some((c) => c.name === '零时长' && c.duration === 0));
ok('重复 clipitem id 被标出（不静默合并、不丢片段）',
  B.warnings.some((w) => /重复出现/.test(w)) && B.clips.length === 3, `${B.clips.length} 段`);
ok('非法 XML（标签未闭合）→ ok=false + 中文原因，且不抛未捕获异常',
  never(() => parseFcp7Xml('<xmeml version="4"><sequence><name>雾港</name></sequence>'), 'parseFcp7Xml(未闭合)')
  && parseFcp7Xml('<xmeml version="4"><sequence><name>x</name></sequence>').ok === false
  && zh(parseFcp7Xml('<xmeml version="4"><sequence><name>x</name></sequence>').warnings));
ok('不是 FCP7 的 XML（TTML/HTML）→ ok=false + 中文原因',
  parseFcp7Xml('<?xml version="1.0"?><tt xmlns="http://www.w3.org/ns/ttml"><body/></tt>').ok === false
  && zh(parseFcp7Xml('<?xml version="1.0"?><tt><body/></tt>').warnings));
ok('空文本 / null → ok=false + 中文原因（不抛）',
  parseFcp7Xml('').ok === false && parseFcp7Xml(null).ok === false && zh(parseFcp7Xml('').warnings));
ok('片段缺 <pathurl> → file 为空 + 中文提示（要求手动指定素材）', (() => {
  const r = parseFcp7Xml('<xmeml version="4"><sequence><name>s</name><rate><timebase>25</timebase></rate><media><video><track><clipitem id="c1"><name>无素材</name><duration>25</duration><start>0</start><end>25</end><file><name>only.mp4</name></file></clipitem></track></video></media></sequence></xmeml>');
  return r.ok && r.clips.length === 1 && r.clips[0].file === null && r.clips[0].pathurl === null && r.warnings.some((w) => /pathurl|素材/.test(w));
})());

// ================= 4. 与导出侧对称（同一份 clips 转一圈回来） =================
console.log('\n【4】与 src/interchange.js 导出侧往返一致');
const RT_CLIPS = [
  { file: '/data/media/a.mp4', duration: 2, name: '镜头1', dialogue: '你好', action: '走近' },
  { file: '/data/media/b.mp4', duration: 3, name: '镜头2', dialogue: '再见', action: '' },
];
const RT_FCP7 = parseFcp7Xml(buildFcp7Xml({ clips: RT_CLIPS, title: '往返集', fps: 25 }));
ok('FCP7：导出的 XML 能被自己读回（条数/名称/文件/时长/台词标记全一致）',
  RT_FCP7.ok && RT_FCP7.clips.length === 2
  && RT_FCP7.clips[0].name === '镜头1' && RT_FCP7.clips[0].file === '/data/media/a.mp4' && RT_FCP7.clips[0].duration === 2
  && RT_FCP7.clips[1].start === 2 && RT_FCP7.clips[1].end === 5
  && RT_FCP7.clips[0].markers.some((m) => m.name === '台词' && m.comment === '你好')
  && RT_FCP7.warnings.length === 0, JSON.stringify(RT_FCP7.warnings));
const RT_OTIO = parseOtio(buildOtio({ clips: RT_CLIPS, title: '往返集', fps: 25 }));
// 导出侧 OTIO 的时长按帧取整（value=round(秒*rate)），所以往返误差 ≤ 1 帧
ok('OTIO：导出的 JSON 能被自己读回（名称/文件一致，时长误差 ≤1 帧）',
  RT_OTIO.ok && RT_OTIO.clips.length === 2
  && RT_OTIO.clips[0].name === '镜头1' && RT_OTIO.clips[0].file === '/data/media/a.mp4'
  && Math.abs(RT_OTIO.clips[0].duration - 2) <= 1 / 25 + 1e-9
  && Math.abs(RT_OTIO.clips[1].duration - 3) <= 1 / 25 + 1e-9
  && RT_OTIO.fps === 25, JSON.stringify(RT_OTIO.clips.map((c) => c.duration)));

// ================= 5. OTIO 解析与容错 =================
console.log('\n【5】parseOtio');
const O = parseOtio(FIX_OTIO);
ok('Timeline.1→Stack.1→Track.1→Clip.1 读通：只导入视频轨的 2 个片段',
  O.ok === true && O.clips.length === 2 && O.sequenceName === '雾港 第1集' && O.fps === 24 && O.clips.every((c) => c.track === 'V1'), JSON.stringify({ n: O.clips.length, fps: O.fps }));
ok('value/rate 换算秒（48 帧 @24 → 2s；start_time 12 帧 → sourceIn 0.5s）',
  O.clips[0].start === 0 && O.clips[0].end === 2 && O.clips[0].duration === 2 && O.clips[0].sourceIn === 0.5, JSON.stringify(O.clips[0]));
ok('ExternalReference.target_url → file 路径还原', O.clips[0].pathurl === 'file://localhost/Users/lin/%E7%B4%A0%E6%9D%90/%E9%95%9C%201.mp4' && O.clips[0].file === '/Users/lin/素材/镜 1.mp4');
ok('MissingReference.1 → file=null 且进 warnings（中文、说明要手动指定）',
  O.clips[1].file === null && O.clips[1].pathurl === null && O.warnings.some((w) => /MissingReference/.test(w)));
ok('Gap.1 空隙按无画面跳过并顺延（48 帧空隙=1s → 第二段从 3s 开始）',
  O.clips[1].start === 3 && O.clips[1].end === 4.5 && O.warnings.some((w) => /Gap\.1/.test(w)), JSON.stringify({ s: O.clips[1].start, e: O.clips[1].end }));
ok('非 Video 轨（kind=Audio）跳过并给中文提示，音频片段不出现在 clips 里',
  O.warnings.some((w) => /非视频轨/.test(w)) && O.clips.every((c) => c.name !== '配音'));
ok('OTIO 标记（markers）也能读（name + comment）', O.clips[0].markers.length === 1 && O.clips[0].markers[0].name === '台词' && O.clips[0].markers[0].comment === '别回头');
ok('缺 rate 的片段 → 中文提示 + 按成片帧率兜底换算（不静默、不出 NaN）', (() => {
  const r = parseOtio(JSON.stringify({ OTIO_SCHEMA: 'Timeline.1', name: 't', tracks: { OTIO_SCHEMA: 'Stack.1', children: [{ OTIO_SCHEMA: 'Track.1', kind: 'Video', children: [{ OTIO_SCHEMA: 'Clip.1', name: '无帧率', source_range: { duration: { value: 100 } }, media_reference: { OTIO_SCHEMA: 'ExternalReference.1', target_url: '/x/y.mp4' } }] }] } }));
  return r.ok && r.clips.length === 1 && r.clips[0].duration === 4 && Number.isFinite(r.clips[0].duration)
    && r.warnings.some((w) => /rate/.test(w) && /duration/.test(w));
})());
ok('整条时间线都缺 rate（无 metadata/global_start_time）→ 25 fps 兜底 + 中文提示', (() => {
  const r = parseOtio(JSON.stringify({ OTIO_SCHEMA: 'Timeline.1', name: 't', tracks: { OTIO_SCHEMA: 'Stack.1', children: [{ OTIO_SCHEMA: 'Track.1', kind: 'Video', children: [{ OTIO_SCHEMA: 'Clip.1', name: '无帧率', source_range: { duration: { value: 100 } } }] }] } }));
  return r.fps === 25 && r.clips[0].duration === 4 && r.clips[0].recordOut === 100 && r.warnings.some((w) => /25 fps/.test(w));
})());
ok('非法 JSON → ok=false + 中文原因；只支持 Timeline.1（传 Clip.1 会被拒）',
  parseOtio('{ "OTIO_SCHEMA": ').ok === false && zh(parseOtio('{ "OTIO_SCHEMA": ').warnings)
  && parseOtio('{ "OTIO_SCHEMA": "Clip.1", "name": "单个片段" }').ok === false
  && parseOtio('{ "OTIO_SCHEMA": "Clip.1" }').warnings.some((w) => /Timeline\.1/.test(w)));
ok('缺 OTIO_SCHEMA 但结构正确 → 仍能读 + 中文提示', (() => {
  const r = parseOtio({ name: '无标记', tracks: { children: [{ OTIO_SCHEMA: 'Track.1', kind: 'Video', children: [{ OTIO_SCHEMA: 'Clip.1', name: 'A', source_range: { duration: { rate: 25, value: 50 } }, media_reference: { OTIO_SCHEMA: 'ExternalReference.1', target_url: '/x/a.mp4' } }] }] } });
  return r.ok && r.clips.length === 1 && r.clips[0].duration === 2 && r.warnings.some((w) => /OTIO_SCHEMA/.test(w));
})());
ok('空 timeline（没有任何片段）→ ok=true 但中文提示「没有可导入的视频片段」',
  parseOtio('{ "OTIO_SCHEMA": "Timeline.1", "name": "空", "tracks": { "OTIO_SCHEMA": "Stack.1", "children": [] } }').warnings.some((w) => /没有/.test(w)));

// ================= 6. 接入计划（纯计划：不发请求、不写库） =================
console.log('\n【6】clipsToTimelinePlan');
const plan = clipsToTimelinePlan(R.clips, { canvasId: 'CV-MAIN', timelineNodeId: 'ND-TL-1' });
ok('按 recordIn 升序重排（输入是文档顺序 镜头B 在前）→ clip1=镜头A clip2=镜头B，slot=0/1',
  plan.ports.length === 2 && plan.ports[0].port === 'clip1' && plan.ports[0].slot === 0 && plan.ports[0].name === '镜头A'
  && plan.ports[1].port === 'clip2' && plan.ports[1].slot === 1 && plan.ports[1].name === '镜头B',
  plan.ports.map((p) => `${p.port}:${p.name}`).join(' '));
ok('计划里的连线条数与端口一一对应、目标节点正确、只是计划（dryRun）',
  plan.links.length === 2 && plan.links[0].to_node === 'ND-TL-1' && plan.links[0].to_port === 'clip1'
  && plan.links[1].slot === 1 && plan.dryRun === true && plan.applies === false && plan.canvasId === 'CV-MAIN');
ok('总时长按 recordIn 顺序累加（4s + 2s = 6s）', plan.totalSeconds === 6, String(plan.totalSeconds));
ok('纯函数：不写库/不发请求（模块源码不含 db/http/fetch/fs 调用），且结果可复现',
  (() => {
    const src = fs.readFileSync(new URL('../src/interchange-import.js', import.meta.url), 'utf8');
    const pure = !/from '\.\/db\.js'|require\(|fetch\(|XMLHttpRequest|node:http|node:https|child_process|writeFile/.test(src);
    const frozen = Object.freeze(R.clips.map((c) => Object.freeze({ ...c })));
    const a = JSON.stringify(clipsToTimelinePlan(Object.freeze(frozen), { canvasId: 'CV-MAIN', timelineNodeId: 'ND-TL-1' }));
    const b = JSON.stringify(clipsToTimelinePlan(Object.freeze(frozen), { canvasId: 'CV-MAIN', timelineNodeId: 'ND-TL-1' }));
    return pure && a === b && !(clipsToTimelinePlan(R.clips, { timelineNodeId: 'x' }) instanceof Promise);
  })());
ok('超 24 段 → 分块 + 中文提示（30 段 → 2 块，第 2 块需要新建成片节点）', (() => {
  const many = Array.from({ length: 30 }, (_, i) => ({ name: `片段${i + 1}`, file: `/d/${i + 1}.mp4`, duration: 1, recordIn: i * 25, recordOut: i * 25 + 25 }));
  const p = clipsToTimelinePlan(many, { canvasId: 'CV-MAIN', timelineNodeId: 'ND-TL-9' });
  return p.chunks.length === 2 && p.chunks[0].ports.length === 24 && p.chunks[1].ports.length === 6
    && p.chunks[0].timelineNodeId === 'ND-TL-9' && p.chunks[1].needsNewNode === true && p.chunks[1].timelineNodeId === null
    && p.ports[23].port === 'clip24' && p.ports[24].port === 'clip25' && p.ports[24].slot === 24
    && p.warnings.some((w) => /24/.test(w) && /分块/.test(w) && zh([w]));
})());
ok('空片段 / 非数组 → ok=false + 中文提示（不抛异常）',
  never(() => clipsToTimelinePlan(null, {}), 'clipsToTimelinePlan(null)')
  && clipsToTimelinePlan([]).ok === false && zh(clipsToTimelinePlan([]).warnings)
  && clipsToTimelinePlan('不是数组').ok === false);
ok('缺 timelineNodeId → ok=false + 中文提示（并说清要选成片节点）',
  clipsToTimelinePlan(R.clips).ok === false && zh(clipsToTimelinePlan(R.clips).warnings)
  && clipsToTimelinePlan(R.clips).warnings.some((w) => /成片节点/.test(w)));
ok('没有素材文件的片段会进 warnings（接入前必须先指定文件）',
  clipsToTimelinePlan([{ name: '缺文件', duration: 2, recordIn: 0, recordOut: 50 }, { name: '有文件', file: '/a.mp4', duration: 1, recordIn: 50, recordOut: 75 }], { timelineNodeId: 'ND-1' })
    .warnings.some((w) => /没有素材文件/.test(w)));
ok('缺时间信息的片段不会乱序（没有 recordIn/start 时排到已知位置的后面）', (() => {
  const p = clipsToTimelinePlan([{ name: '无时间', file: '/x.mp4', duration: 1 }, { name: '有时间', file: '/y.mp4', duration: 1, recordIn: 0, recordOut: 25 }], { timelineNodeId: 'ND-1' });
  return p.ports[0].name === '有时间' && p.ports[1].name === '无时间';
})());

// ================= 7. 一站式解析 + 小工具 =================
console.log('\n【7】parseInterchange / urlToPath / 帧秒换算');
const auto = parseInterchange(FIX_OTIO);
ok('parseInterchange 自动识别 OTIO 并解析（format=otio）', auto.ok === true && auto.format === 'otio' && auto.clips.length === 2);
ok('parseInterchange 无法识别时 ok=false + 中文原因',
  parseInterchange('hello world').ok === false && parseInterchange('hello world').format === null && zh(parseInterchange('hello world').warnings));
ok('urlToPath：localhost / 空主机 / UNC / 非 file URL 都正确',
  urlToPath('file://localhost/tmp/a b.mp4') === '/tmp/a b.mp4'
  && urlToPath('file:///tmp/a.mp4') === '/tmp/a.mp4'
  && urlToPath('file://server/share/a.mp4') === '//server/share/a.mp4'
  && urlToPath('/tmp/plain.mp4') === '/tmp/plain.mp4' && urlToPath('') === null);
ok('秒↔帧 换算与边界（负值归零、NaN 归零）',
  secondsToFrames(2, 25) === 50 && secondsToFrames(-3, 25) === 0 && secondsToFrames('x', 25) === 0
  && framesToSeconds(50, 25) === 2 && framesToSeconds(1, 0) === 0.04);
ok('自带的极简 XML 解析器：合法 XML 可解析、坏 XML 抛中文错误',
  parseXmlDocument('<a x="1"><b/>文本</a>').children[0].name === 'a'
  && (() => { try { parseXmlDocument('<a><b></a>'); return false; } catch (e) { return /标签不匹配/.test(e.message); } })()
  && (() => { try { parseXmlDocument('<a>'); return false; } catch (e) { return /没有闭合/.test(e.message); } })());

// ================= 8. 接线口径（导入 → 画布成片节点：端口顺序 / 连线形状 / 分块守恒） =================
// 这三条是「导入接线」的契约：POST /api/render/timeline-import 直接消费 plan.ports / plan.links / plan.chunks，
// 所以顺序、端口编号、连线形状与分块守恒必须在这里被钉死（计划本身仍是纯计划，不写库）。
console.log('\n【8】接入计划的可接线形状（供 /api/render/timeline-import 消费）');
// 25 段：recordIn 故意打乱（i*3 mod 25 是 0..24 的一个排列），且刚好越过 24 端口上限
const SHUF = Array.from({ length: 25 }, (_, i) => ({
  name: `片段${i + 1}`, file: `/d/${i + 1}.mp4`, duration: 1,
  recordIn: ((i * 3) % 25) * 25, recordOut: ((i * 3) % 25) * 25 + 25,
}));
const sp = clipsToTimelinePlan(SHUF, { canvasId: 'CV-MAIN', timelineNodeId: 'ND-TL-25' });
ok('ports 严格按 recordIn 升序（port 编号 = 顺序，slot = 序号-1），乱序输入也不会乱接',
  sp.ports.length === 25 && sp.ports.every((p, i) => p.port === `clip${i + 1}` && p.slot === i)
  && sp.ports.every((p, i) => i === 0 || p.recordIn > sp.ports[i - 1].recordIn)
  && new Set(sp.ports.map((p) => p.name)).size === 25,
  sp.ports.slice(0, 3).map((p) => `${p.port}@${p.recordIn}`).join(' '));
ok('links 与 ports 一一对应（to_port=clipN、slot=N-1、to_node=成片节点），且 from_node 仍为 null（上游节点由接线方解析，计划不伪造节点）',
  sp.links.length === sp.ports.length && sp.links.every((l, i) => l.to_port === sp.ports[i].port
    && l.slot === sp.ports[i].slot && l.from_node === null && l.to_node === 'ND-TL-25' && l.canvasId === 'CV-MAIN'));
ok('25 段按 24 端口上限分 2 块（24+1）：端口守恒且第 2 块明确 needsNewNode（接线方不得伪造节点）',
  sp.chunks.length === 2 && sp.chunks[0].ports.length === 24 && sp.chunks[1].ports.length === 1
  && sp.chunks.flatMap((c) => c.ports).join('|') === sp.ports.map((p) => p.port).join('|')
  && sp.chunks[0].timelineNodeId === 'ND-TL-25' && sp.chunks[1].needsNewNode === true && sp.chunks[1].timelineNodeId === null
  && sp.warnings.some((w) => /分块/.test(w) && zh([w])));

console.log(`\n========== 时间线导入：${pass} 通过 / ${fail} 失败 ==========`);
process.exit(fail ? 1 : 0);
