#!/usr/bin/env node
// 成片一致性 QC：按时间线抽检跨镜关键帧，输出中文或 JSON 报告。

import fs from 'node:fs';
import path from 'node:path';
import { get } from '../src/db.js';
import { getTimelineDoc } from '../src/edit-timeline.js';
import { analyzeConsistency } from '../src/edit-ai.js';

const USAGE = `用法：
  node scripts/qc-consistency.js --timeline TL-xxx [--json] [--out docs/qc-xxx.md]

参数：
  --timeline  时间线 ID（也兼容时间线编码）
  --json      输出机器可读 JSON
  --out       将报告写入指定文件
  --help      显示帮助`;

class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

function readOptionValue(argv, index, name) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new CliError(`${name} 缺少参数值`, 2);
  return value;
}

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };

  const options = { timeline: '', json: false, out: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--timeline') {
      options.timeline = readOptionValue(argv, i, '--timeline');
      i += 1;
    } else if (arg.startsWith('--timeline=')) {
      options.timeline = arg.slice('--timeline='.length).trim();
    } else if (arg === '--out') {
      options.out = readOptionValue(argv, i, '--out');
      i += 1;
    } else if (arg.startsWith('--out=')) {
      options.out = arg.slice('--out='.length).trim();
    } else if (arg === '--json') {
      options.json = true;
    } else {
      throw new CliError(`未知参数：${arg}`, 2);
    }
  }
  if (!options.timeline) throw new CliError('必须指定 --timeline', 2);
  if (!options.out && argv.some((arg) => arg === '--out=' || arg === '--out')) {
    throw new CliError('--out 缺少参数值', 2);
  }
  return options;
}

function resolveTimeline(input) {
  let doc = getTimelineDoc(input);
  if (!doc) {
    const found = get('SELECT id FROM edit_timelines WHERE code=? ORDER BY updated_at DESC, created_at DESC LIMIT 1', input);
    if (found) doc = getTimelineDoc(found.id);
  }
  if (!doc) throw new CliError(`时间线不存在：${input}`, 2);
  return doc;
}

function clipLabel(outlier) {
  if (outlier.shot_no) return `第${outlier.shot_no}镜`;
  return outlier.title || outlier.clip_id;
}

function buildSuggestions({ checked, skipped, outliers }) {
  const suggestions = [];
  if (outliers.length) {
    suggestions.push(`建议逐镜复核 ${outliers.map(clipLabel).join('、')} 的人物外观、服装和光线，确认是否为同一角色。`);
  } else if (checked > 0) {
    suggestions.push('当前抽检范围内未发现明显的人物外观离群，发布前仍建议抽查高光、暗部及快速运动镜头。');
  }
  if (skipped > 0) {
    suggestions.push(`有 ${skipped} 个镜头未能取得可读关键帧或视频，建议补齐素材后重新抽检。`);
  }
  if (checked > 0 && checked < 3) {
    suggestions.push(`有效抽检仅 ${checked} 镜，中位数参考不足，建议至少补充到 3 镜后再判断。`);
  }
  return suggestions;
}

function renderMarkdown(report) {
  const timelineName = [report.timeline.code, report.timeline.title].filter(Boolean).join(' · ');
  const lines = [
    '# 成片一致性 QC 报告',
    '',
    `- 时间线：${report.timeline.id}${timelineName ? `（${timelineName}）` : ''}`,
    `- 抽检数：${report.checked}`,
    `- 跳过数：${report.skipped}`,
    `- 离群镜头：${report.outliers.length}`,
    `- 判定规则：64 位感知哈希，与中位数汉明距离大于 ${report.threshold} 判为离群`,
    '',
    '## 离群镜头',
    '',
  ];

  if (report.outliers.length) {
    for (const outlier of report.outliers) {
      lines.push(`- ${clipLabel(outlier)}（${outlier.clip_id}）：汉明距离 ${outlier.distance}`);
    }
  } else {
    lines.push('- 无');
  }

  lines.push('', '## 建议', '');
  for (const suggestion of report.suggestions) lines.push(`- ${suggestion}`);
  return `${lines.join('\n')}\n`;
}

async function createReport(options) {
  const doc = resolveTimeline(options.timeline);
  const main = doc.tracks.find((track) => track.kind === 'main');
  const clips = main?.clips || [];
  if (!clips.length) {
    throw new CliError(`时间线 ${options.timeline} 没有镜头，无法进行一致性 QC`, 2);
  }

  const analysis = await analyzeConsistency(doc);
  if (!analysis.ok) throw new CliError(`一致性抽检无法执行：${analysis.reason || '未知原因'}`, 1);

  const positions = new Map(clips.map((clip, index) => [clip.id, index + 1]));
  const outliers = (analysis.outliers || []).map((outlier) => ({
    ...outlier,
    shot_no: positions.get(outlier.clip_id) || null,
  }));
  const checked = Number(analysis.checked) || 0;
  const skipped = Number(analysis.skipped) || 0;

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    timeline: {
      id: doc.timeline.id,
      code: doc.timeline.code || '',
      title: doc.timeline.title || '',
      status: doc.timeline.status || '',
    },
    checked,
    skipped,
    threshold: 20,
    outliers,
    summary: { checked, skipped, outliers: outliers.length },
    suggestions: buildSuggestions({ checked, skipped, outliers }),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const report = await createReport(options);
  const output = options.json ? `${JSON.stringify(report, null, 2)}\n` : renderMarkdown(report);

  if (options.out) {
    const outFile = path.resolve(process.cwd(), options.out);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, output, 'utf8');
  }
  process.stdout.write(output);
  if (options.out && !options.json) process.stdout.write(`\n报告已写入：${path.resolve(process.cwd(), options.out)}\n`);
}

main().catch((error) => {
  const message = error instanceof CliError ? error.message : `执行失败：${error.message}`;
  if (process.argv.includes('--json')) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: message })}\n`);
  } else {
    process.stderr.write(`错误：${message}\n`);
  }
  process.exitCode = error.exitCode || 1;
});
