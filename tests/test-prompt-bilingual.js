#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  toCinematicPrompt,
  toEnglishPrompt,
  toEnglishPromptWithStats,
} from '../scripts/prompt-bilingual.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(ROOT, 'scripts', 'prompt-bilingual.js');

let pass = 0;
let fail = 0;

function test(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  PASS ${name}`);
  } catch (error) {
    fail += 1;
    console.error(`  FAIL ${name} -> ${error.message}`);
  }
}

test('短剧常见短语全部替换', () => {
  const cases = {
    电影剧照: 'cinematic film still',
    电影感: 'cinematic',
    雨夜: 'rainy night',
    码头: 'dockside',
    黑色风衣: 'black trench coat',
    侧脸: 'side profile',
    冷蓝色调: 'cool blue color grading',
    浅景深: 'shallow depth of field',
    胶片颗粒: 'film grain',
    自然皮肤: 'natural skin',
    写实: 'photorealistic',
    中景: 'medium shot',
    特写: 'close-up',
    推镜: 'dolly-in shot',
    摇镜: 'pan shot',
    黄昏: 'dusk',
    室内: 'interior',
    医院: 'hospital',
    办公室: 'office',
    街道: 'street',
    森林: 'forest',
    雪: 'snow',
    雨: 'rain',
    雾: 'fog',
    火光: 'firelight',
    逆光: 'backlight',
    低角度: 'low angle',
    俯拍: 'overhead shot',
  };

  for (const [chinese, english] of Object.entries(cases)) {
    assert.equal(toEnglishPrompt(chinese), english, `${chinese} 的转换结果不正确`);
  }
});

test('最长匹配：雨夜优先于雨', () => {
  assert.equal(toEnglishPrompt('雨夜'), 'rainy night');
  assert.equal(toEnglishPrompt('雨'), 'rain');
  assert.equal(toEnglishPrompt('雨夜码头'), 'rainy night dockside');
});

test('未知中文原样保留并计数', () => {
  const result = toEnglishPromptWithStats('赛博朋克街道');
  assert.equal(result.prompt, '赛博朋克 street');
  assert.deepEqual(result.unknownTerms, ['赛博朋克']);
  assert.equal(result.unknownCount, 1);
});

test('cinematic 风格词追加完整', () => {
  const result = toCinematicPrompt('雨夜码头');
  for (const term of [
    'cinematic film still',
    'photorealistic',
    'natural skin texture',
    'shallow depth of field',
    'film grain',
  ]) {
    assert.ok(result.includes(term), `缺少 cinematic 风格词: ${term}`);
  }
});

test('重复调用不重复追加 cinematic 风格词', () => {
  const once = toCinematicPrompt('雨夜码头');
  const twice = toCinematicPrompt(once);
  assert.equal(twice, once);
});

test('纯英文输入保持稳定', () => {
  const english = 'rainy night dockside, cinematic film still, photorealistic, natural skin texture, shallow depth of field, film grain';
  assert.equal(toCinematicPrompt(english), english);
});

test('默认保留括号内中文姓名', () => {
  assert.equal(toEnglishPrompt('【林雪】站在雨夜码头'), '【林雪】 standing at rainy night dockside');
});

test('CLI 输出英文电影提示词', () => {
  const output = execFileSync(
    process.execPath,
    [SCRIPT, '雨夜码头，35岁男演员，黑色风衣'],
    { encoding: 'utf8' },
  ).trim();

  assert.match(output, /rainy night dockside/);
  assert.match(output, /35-year-old male actor/);
  assert.match(output, /black trench coat/);
  assert.match(output, /cinematic film still/);
});

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exitCode = fail ? 1 : 0;
