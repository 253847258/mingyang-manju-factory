#!/usr/bin/env node
// 中文短剧提示词 → 英文出图提示词。
// 纯函数、无第三方依赖；未知中文片段保留，并可通过 withStats 获取统计。

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PHRASE_MAP = Object.freeze({
  // 影像风格与画质
  电影剧照: 'cinematic film still',
  电影质感: 'cinematic texture',
  电影灯光: 'cinematic lighting',
  电影感: 'cinematic',
  电影级: 'cinematic',
  写实风格: 'photorealistic style',
  写实: 'photorealistic',
  冷蓝色调: 'cool blue color grading',
  蓝灰色调: 'blue-gray color grading',
  冷色调: 'cool tones',
  暖色调: 'warm color grading',
  低饱和: 'low saturation',
  高对比度: 'high contrast',
  浅景深: 'shallow depth of field',
  胶片颗粒: 'film grain',
  颗粒感: 'film grain',
  自然皮肤质感: 'natural skin texture',
  自然皮肤: 'natural skin',
  柔光: 'soft light',

  // 景别、角度与运镜
  大特写: 'extreme close-up',
  中近景: 'medium close-up',
  近景: 'medium close-up',
  特写: 'close-up',
  中景: 'medium shot',
  远景: 'wide shot',
  全景: 'full shot',
  低角度仰拍: 'low-angle shot',
  低角度: 'low angle',
  高角度: 'high angle',
  平视: 'eye-level shot',
  仰拍: 'low-angle shot',
  俯拍: 'overhead shot',
  鸟瞰: 'bird\'s-eye view',
  航拍: 'aerial shot',
  推镜头: 'dolly-in shot',
  推镜: 'dolly-in shot',
  拉镜: 'dolly-out shot',
  摇镜头: 'pan shot',
  摇镜: 'pan shot',
  跟拍: 'tracking shot',
  手持: 'handheld camera',
  逆光剪影: 'backlit silhouette',
  逆光: 'backlight',
  侧脸特写: 'profile close-up',
  侧脸: 'side profile',
  正脸: 'frontal view',
  背影: 'seen from behind',
  全身: 'full body',
  半身: 'half body',

  // 时间与天气
  雨夜码头: 'rainy night dockside',
  雨夜街道: 'rainy night street',
  雪夜: 'snowy night',
  雨夜: 'rainy night',
  暴风雨: 'storm',
  大雨: 'heavy rain',
  小雨: 'light rain',
  大雪: 'heavy snow',
  薄雾: 'light fog',
  浓雾: 'dense fog',
  黄昏: 'dusk',
  傍晚: 'evening',
  深夜: 'late night',
  夜晚: 'night',
  清晨: 'dawn',
  黎明: 'daybreak',
  白天: 'daytime',
  雨: 'rain',
  雪: 'snow',
  雾: 'fog',
  烟雾: 'smoke',
  火光: 'firelight',

  // 场景与道具
  医院走廊: 'hospital corridor',
  医院: 'hospital',
  病房: 'hospital room',
  办公室内: 'inside the office',
  办公室: 'office',
  室内: 'interior',
  街道: 'street',
  街头: 'street',
  森林: 'forest',
  码头: 'dockside',
  天台: 'rooftop',
  走廊: 'corridor',
  地铁: 'subway',
  酒吧: 'bar',
  餐厅: 'restaurant',
  酒店: 'hotel',
  公寓: 'apartment',
  学校: 'school',
  车内: 'inside a car',
  出租车: 'taxi',
  汽车: 'car',
  霓虹灯: 'neon lights',
  路灯: 'streetlight',
  积水: 'puddles',
  雨伞: 'umbrella',
  窗户: 'window',
  镜子: 'mirror',

  // 人物、造型与动作
  '35岁': '35-year-old',
  男主角: 'male lead',
  女主角: 'female lead',
  男演员: 'male actor',
  女演员: 'female actress',
  男子: 'man',
  女子: 'woman',
  男人: 'man',
  女人: 'woman',
  男孩: 'boy',
  女孩: 'girl',
  少年: 'teenage boy',
  少女: 'teenage girl',
  老人: 'elderly person',
  中年: 'middle-aged',
  青年: 'young adult',
  黑色风衣: 'black trench coat',
  风衣: 'trench coat',
  白衬衫: 'white shirt',
  衬衫: 'shirt',
  西装: 'suit',
  皮鞋: 'leather shoes',
  长发: 'long hair',
  短发: 'short hair',
  眼镜: 'glasses',
  眼神: 'gaze',
  站在: 'standing at',
  坐在: 'sitting on',
  回头: 'looking back',
  奔跑: 'running',
  走向: 'walking toward',
  撑伞: 'holding an umbrella',
  看着镜头: 'looking at camera',
  看向镜头: 'looking at camera',
  拥抱: 'embracing',
  握手: 'shaking hands',
  打电话: 'talking on the phone',
  表情严肃: 'serious expression',
  微笑: 'smiling',
  哭泣: 'crying',
  愤怒: 'angry',
  紧张: 'nervous',
  悲伤: 'sad',
  冷静: 'calm',
  疲惫: 'exhausted',
  岁: 'years old',
});

const PHRASES = Object.entries(PHRASE_MAP).sort(
  ([left], [right]) => Array.from(right).length - Array.from(left).length,
);

const CJK_RUN = /[\u3400-\u9fff\uf900-\ufaff]+/g;
const AGE_PATTERN = /^(\d{1,3})\s*岁/;
function translateFreeText(value) {
  let output = '';
  let index = 0;

  while (index < value.length) {
    const rest = value.slice(index);
    const ageMatch = rest.match(AGE_PATTERN);
    if (ageMatch) {
      output += ` ${ageMatch[1]}-year-old `;
      index += ageMatch[0].length;
      continue;
    }

    let matched = null;
    for (const [chinese, english] of PHRASES) {
      if (rest.startsWith(chinese)) {
        matched = { chinese, english };
        break;
      }
    }

    if (matched) {
      output += ` ${matched.english} `;
      index += matched.chinese.length;
    } else {
      output += value[index];
      index += 1;
    }
  }

  return output;
}

function translateWithProtectedNames(value) {
  const pattern = /(【[^】]*】|\[[^\]]*\])/g;
  let output = '';
  let lastIndex = 0;

  for (const match of value.matchAll(pattern)) {
    output += translateFreeText(value.slice(lastIndex, match.index));
    output += ` ${match[0]} `;
    lastIndex = match.index + match[0].length;
  }

  return output + translateFreeText(value.slice(lastIndex));
}

function tidyPrompt(value) {
  let text = String(value)
    .replace(/[，、；;：]/g, ', ')
    .replace(/。/g, '. ')
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ', ')
    .replace(/(?:,\s*){2,}/g, ', ')
    .replace(/,\s*([.!?])/g, '$1')
    .replace(/\s+([.!?])/g, '$1')
    .trim();

  text = text
    .replace(/([\u3400-\u9fff\uf900-\ufaff])([A-Za-z0-9])/g, '$1 $2')
    .replace(/([A-Za-z0-9])([\u3400-\u9fff\uf900-\ufaff])/g, '$1 $2')
    .replace(/([】\]])([A-Za-z0-9])/g, '$1 $2')
    .replace(/([A-Za-z0-9])([【\[])/g, '$1 $2');

  return text.replace(/^[\s,]+|[\s,]+$/g, '');
}

function findUnknownTerms(prompt) {
  return prompt.match(CJK_RUN) || [];
}

/**
 * 返回转换结果及未知中文统计。
 * @param {string} zh
 * @param {{keepNames?: boolean}} [options]
 */
export function toEnglishPromptWithStats(zh, options = {}) {
  const source = String(zh ?? '');
  const keepNames = options.keepNames !== false;
  const translated = keepNames ? translateWithProtectedNames(source) : translateFreeText(source);
  const prompt = tidyPrompt(translated);
  const unknownTerms = findUnknownTerms(prompt);

  return {
    prompt,
    unknownTerms,
    unknownCount: unknownTerms.length,
  };
}

/**
 * 中文短语按最长匹配转换为英文；未知中文片段原样保留。
 * 默认返回字符串；传 { withStats: true } 时返回 { prompt, unknownTerms, unknownCount }。
 * @param {string} zh
 * @param {{keepNames?: boolean, withStats?: boolean}} [options]
 */
export function toEnglishPrompt(zh, options = {}) {
  const result = toEnglishPromptWithStats(zh, options);
  return options.withStats ? result : result.prompt;
}

const CINEMATIC_TERMS = Object.freeze([
  'cinematic film still',
  'photorealistic',
  'natural skin texture',
  'shallow depth of field',
  'film grain',
]);

/**
 * 转为英文电影剧照提示词，只补齐尚不存在的电影化描述，重复调用不会重复追加。
 * @param {string} zh
 * @param {{keepNames?: boolean}} [options]
 */
export function toCinematicPrompt(zh, options = {}) {
  const base = toEnglishPrompt(zh, options);
  const lower = base.toLowerCase();
  const additions = CINEMATIC_TERMS.filter((term) => !lower.includes(term));
  return [base, ...additions].filter(Boolean).join(', ');
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const input = process.argv.slice(2).join(' ').trim();
  if (!input) {
    console.error('用法: node scripts/prompt-bilingual.js "中文提示词"');
    process.exitCode = 1;
  } else {
    console.log(toCinematicPrompt(input));
  }
}
