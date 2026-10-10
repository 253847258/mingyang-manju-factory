// 小说改编工作台（plain text module）
//
// 上传小说 → 自动产出：
//   1. 分集剧本草案
//   2. 角色清单
//   3. 场景清单
//   4. 道具清单
//   5. 文生图提示词
//   6. 可执行资产清单
//
// 设计原则：
//   - 先离线可用：没有 LLM Key 也能跑，规则引擎给出可编辑的第一版。
//   - 不破坏原有模块：只新增 adapt_* 表，不改 novels / scripts / shots。
//   - 所有结果都落库，可导出 JSON / Markdown / CSV。

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { all, get, run, resolveAsset } from './db.js';
import { nowISO, countWords, clipWords } from './util.js';

export const ADAPT_VERSION = '1.0.0';

const DEFAULT_NEGATIVE = '多余手指，肢体崩坏，脸部变形，重复人物，文字水印，低清晰度，比例失调，塑料感，过曝，杂乱背景';
const STYLE_HEAD = '国漫写实风，电影感构图，干净线条，高对比光影，统一色彩规范';

const COMMON_SURNAMES = '赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳酆鲍史唐费廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐于时傅皮卞齐康伍余元卜顾孟平黄和穆萧尹姚邵湛汪祁毛禹狄米贝明臧计伏成戴谈宋茅庞熊纪舒屈项祝董梁杜阮蓝闵席季麻强贾路娄危江童颜郭梅盛林刁钟徐邱骆高夏蔡田樊胡凌霍虞万支柯昝管卢莫经房裘缪干解应宗丁宣邓单杭洪包诸左石崔吉龚程邢裴陆荣翁荀羊於惠甄曲家封芮羿储靳汲邴糜松井段富巫乌焦巴弓牧隗山谷车侯宓蓬全郗班仰秋仲伊宫宁仇栾暴甘钭厉戎祖武符刘景詹束龙叶幸司韶郜黎蓟薄印宿白怀蒲台从鄂索咸籍赖卓蔺屠蒙池乔阴胥能苍双闻莘党翟谭贡劳逄姬申扶堵冉宰郦雍璩桑桂濮牛寿通边扈燕冀郏浦尚农温别庄晏柴习瞿阎充慕连茹习宦艾鱼容向古易慎戈廖庾终暨居衡步都耿满弘匡国文寇广禄阙东欧殳沃利蔚越夔隆师巩厍聂晁勾敖融冷訾辛阚那简饶空曾毋沙乜养鞠须丰巢关蒯相查后荆红游竺权逯盖益桓公';

const STOP_WORDS = new Set([
  '一个', '这个', '那个', '自己', '他们', '我们', '你们', '什么', '怎么', '因为', '所以', '但是', '然后', '已经', '还是', '只是',
  '不是', '没有', '知道', '看到', '觉得', '时候', '地方', '东西', '事情', '眼神', '声音', '心里', '脸上', '手里', '身后', '面前',
  '现在', '如果', '可能', '应该', '终于', '突然', '立刻', '马上', '似乎', '仿佛', '于是', '接着', '同时', '仍然', '依然', '只是',
  '一阵', '一声', '一切', '一片', '一边', '有些', '很多', '所有', '整个', '唯一', '真正', '直接', '根本', '居然', '果然', '难道',
  '这里', '那里', '外面', '里面', '旁边', '中间', '远处', '身后', '眼前', '心中', '嘴角', '目光', '肩膀', '手指', '背影', '呼吸',
]);

const ROLE_MALE = ['总裁', '少爷', '先生', '父亲', '哥哥', '弟弟', '医生', '警官', '军官', '老板', '大师', '老者', '少年', '青年', '男人', '男主', '王爷', '将军', '公子', '先生'];
const ROLE_FEMALE = ['小姐', '夫人', '太太', '姐姐', '妹妹', '母亲', '女生', '女孩', '护士', '女主', '公主', '王妃', '女士', '婆婆', '姑娘'];
const ROLE_ANTAGONIST = ['反派', '敌人', '对手', '幕后', '凶手', '叛徒', '恶人', 'boss', '黑手', '仇人'];
const ROLE_PROTAGONIST = ['男主', '女主', '主角', '主人公'];

const CHARACTER_BLACKLIST = new Set([
  '冷笑', '冷冷地', '从后门', '医院', '办公室', '仓库', '手机', '照片', '文件', '合同', '玉佩', '地图',
  '木盒', '酒杯', '钢笔', '背包', '绳索', '档案', '印章', '箱子', '椅子', '门口', '窗外', '走廊',
  '码头', '古堡', '海边', '夜晚', '雨夜', '深夜', '白天', '黄昏', '清晨',
]);
const CHARACTER_SUFFIX_BAD = /(地|的|得|着|了|过|来|去|上|下|里|中|外|前|后|门|面|边|起|住|开|出|入|回)$/;
const SCENE_BLACKLIST = new Set([
  '椅子', '桌面', '门口', '窗外', '手机', '照片', '文件', '合同', '玉佩', '地图', '木盒', '酒杯',
  '钢笔', '背包', '绳索', '档案', '印章', '箱子', '沈砚面', '林越面', '赵天豪面',
]);
const SCENE_ACTION_BAD = /(打开|走进|来到|回到|站在|坐在|躺在|望向|穿过|跑|冲|抓|拿|放|说|看|听|想|笑|哭)/;
const PROP_BLACKLIST = new Set(['门', '窗', '灯', '盒']);

const SCENE_WORDS = [
  '客厅', '卧室', '书房', '厨房', '浴室', '阳台', '办公室', '会议室', '会议室', '走廊', '电梯', '楼梯', '天台', '地下室', '仓库',
  '医院', '病房', '学校', '教室', '图书馆', '操场', '公司', '酒店', '宴会厅', '餐厅', '咖啡厅', '酒吧', '商场', '超市', '车站',
  '机场', '码头', '港口', '街道', '巷子', '公园', '广场', '桥', '河边', '湖边', '海边', '山上', '森林', '树林', '田野', '村庄',
  '宫殿', '大殿', '王府', '府邸', '庭院', '花园', '牢房', '实验室', '档案馆', '警局', '法院', '教堂', '寺庙', '古堡', '废墟',
  '车里', '地铁', '公交', '火车', '飞机', '船舱', '甲板', '雪地',
];

const PROP_WORDS = [
  '手机', '钥匙', '玉佩', '戒指', '项链', '手镯', '耳环', '手表', '眼镜', '面具', '帽子', '围巾', '手套', '背包', '行李箱', '箱子',
  '信', '信封', '照片', '日记', '笔记', '地图', '文件', '合同', '档案', '报纸', '书', '钢笔', '铅笔', '印章', '徽章', '令牌',
  '刀', '匕首', '剑', '枪', '子弹', '弓', '箭', '药', '药瓶', '针', '绷带', '酒杯', '茶杯', '咖啡', '烟', '打火机', '伞',
  '电脑', '相机', '录音笔', 'U盘', '硬盘', '银行卡', '钱', '钱包', '收据', '票据', '门', '窗', '镜子', '画', '相框', '灯',
  '车', '自行车', '摩托车', '船', '飞机', '火车', '电梯', '蜡烛', '火把', '绳索', '铁链', '笼子', '盒', '木盒', '礼盒',
];

const TIME_WORDS = ['清晨', '黎明', '上午', '中午', '下午', '黄昏', '傍晚', '夜晚', '深夜', '凌晨', '白天', '雨夜', '雪夜'];
const MOOD_WORDS = ['紧张', '愤怒', '悲伤', '温柔', '惊悚', '压抑', '轻松', '燃', '热血', '悬疑', '甜蜜', '绝望', '冷静', '慌乱'];

function uid(prefix) {
  return `${prefix}-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function asInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function safeJson(value, fallback = null) {
  try {
    if (value === null || value === undefined || value === '') return fallback;
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    return fallback;
  }
}

function jstr(value) {
  return JSON.stringify(value ?? null);
}

function cleanText(text) {
  return String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function splitSentences(text) {
  const out = [];
  for (const line of String(text || '').split(/\n+/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.match(/[^。！？!?；;「」“”"]*[。！？!?；;]?[」”"]?/g) || [trimmed];
    for (const part of parts) {
      const s = part.trim();
      if (s.length >= 4) out.push(s);
    }
  }
  return out;
}

function extractDialogue(text) {
  const out = [];
  const re = /[“"]([^”"]{1,80})[”"]/g;
  let m;
  while ((m = re.exec(String(text || '')))) out.push(m[1].trim());
  return out;
}

function guessTime(text) {
  for (const word of TIME_WORDS) if (String(text || '').includes(word)) return word;
  return '白天';
}

function guessMood(text) {
  for (const word of MOOD_WORDS) if (String(text || '').includes(word)) return word;
  return '紧张';
}

export function splitChapters(text) {
  const source = cleanText(text);
  const re = /(第[零一二三四五六七八九十百千万两\d]+[章节回卷篇][^\n]{0,40})/g;
  const matches = [...source.matchAll(re)];
  if (matches.length >= 2) {
    const chapters = [];
    for (let i = 0; i < matches.length; i += 1) {
      const start = matches[i].index;
      const end = i + 1 < matches.length ? matches[i + 1].index : source.length;
      const body = source.slice(start, end).trim();
      const title = matches[i][1].trim();
      chapters.push({ idx: i + 1, title, text: body, chars: body.length });
    }
    return chapters;
  }
  const chunks = [];
  const size = 4000;
  for (let i = 0; i < source.length; i += size) {
    const body = source.slice(i, i + size).trim();
    if (body) chunks.push({ idx: chunks.length + 1, title: `第 ${chunks.length + 1} 段`, text: body, chars: body.length });
  }
  return chunks;
}

function candidateCharacters(sentences) {
  const stats = new Map();
  const add = (name, sentence, bonus = 0) => {
    if (!name) return;
    const n = String(name).trim();
    if (n.length < 2 || n.length > 4) return;
    if (STOP_WORDS.has(n)) return;
    if (CHARACTER_BLACKLIST.has(n)) return;
    if (CHARACTER_SUFFIX_BAD.test(n)) return;
    if (!/^[\u4e00-\u9fa5]+$/.test(n)) return;
    if (!stats.has(n)) stats.set(n, { name: n, count: 0, sentences: [], bonus: 0 });
    const item = stats.get(n);
    item.count += 1;
    item.bonus += bonus;
    if (item.sentences.length < 6 && sentence && !item.sentences.includes(sentence)) item.sentences.push(sentence);
  };

  const surname = `[${COMMON_SURNAMES}]`;
  const speechRe = new RegExp(`(${surname}[\\u4e00-\\u9fa5]{1,2})(?=说|道|问|答|喊|叫|笑|哭|骂|吼|低声|沉声|开口|点头|摇头|皱眉|叹气|抬头|转身)`, 'g');
  const actionRe = new RegExp(`(${surname}[\\u4e00-\\u9fa5]{1,2})(?=走|站|坐|看|望|拿|推|拉|抓|握|抬|低|回|转|冲|跑|停|笑|哭|沉默|皱眉)`, 'g');

  for (const sentence of sentences) {
    for (const re of [speechRe, actionRe]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(sentence))) add(m[1], sentence, re === speechRe ? 2 : 1);
    }
    for (const role of [...ROLE_MALE, ...ROLE_FEMALE, ...ROLE_ANTAGONIST, ...ROLE_PROTAGONIST]) {
      let index = sentence.indexOf(role);
      while (index >= 0) {
        const before = sentence.slice(Math.max(0, index - 4), index).match(new RegExp(`(${surname}[\\u4e00-\\u9fa5]{1,2})$`));
        if (before) add(before[1], sentence, 3);
        index = sentence.indexOf(role, index + role.length);
      }
    }
  }
  const ranked = [...stats.values()]
    .filter((item) => item.count >= 2 || item.bonus >= 4)
    .map((item) => {
      const joined = item.sentences.join(' ');
      const female = ROLE_FEMALE.some((w) => joined.includes(w)) || joined.includes('她');
      const male = ROLE_MALE.some((w) => joined.includes(w)) || joined.includes('他');
      const antagonist = ROLE_ANTAGONIST.some((w) => joined.includes(w));
      const protagonist = ROLE_PROTAGONIST.some((w) => joined.includes(w));
      return {
        ...item,
        gender: female && !male ? 'female' : male && !female ? 'male' : 'unknown',
        role: antagonist ? 'antagonist' : protagonist ? 'protagonist' : 'supporting',
        score: item.count + item.bonus + (protagonist ? 20 : 0) + (antagonist ? 8 : 0),
      };
    })
    .sort((a, b) => b.score - a.score);
  ranked.forEach((item, index) => {
    if (item.role === 'supporting') {
      if (index < 2) item.role = 'protagonist';
      else if (/(枪|刀|冲进|追杀|冷笑|威胁|抓住|叛徒|凶手)/.test(item.sentences.join(' '))) item.role = 'antagonist';
    }
  });
  const merged = [];
  for (const item of ranked) {
    const parent = merged.find((m) => m.name !== item.name && (m.name.includes(item.name) || item.name.includes(m.name)));
    if (parent) {
      parent.aliases.push(item.name);
      parent.count += item.count;
      parent.score += item.score;
      for (const sentence of item.sentences) {
        if (!parent.sentences.includes(sentence) && parent.sentences.length < 6) parent.sentences.push(sentence);
      }
      if (parent.role === 'supporting' && item.role !== 'supporting') parent.role = item.role;
      if (parent.gender === 'unknown' && item.gender !== 'unknown') parent.gender = item.gender;
    } else {
      merged.push({ ...item, aliases: [] });
    }
  }
  return merged;
}

function extractScenes(sentences, characterNames = []) {
  const stats = new Map();
  const add = (name, sentence) => {
    const n = String(name || '').trim().replace(/(里|中|内|上|旁|前|后|外|边|下)$/, '');
    if (!n || n.length < 2 || n.length > 10) return;
    if (SCENE_BLACKLIST.has(n)) return;
    if (TIME_WORDS.includes(n)) return;
    if (characterNames.some((c) => n.includes(c))) return;
    if (!stats.has(n)) stats.set(n, { name: n, count: 0, sentences: [] });
    const item = stats.get(n);
    item.count += 1;
    if (item.sentences.length < 6 && sentence && !item.sentences.includes(sentence)) item.sentences.push(sentence);
  };
  const placeRe = /(?:在|来到|走进|进入|回到|站在|坐在|躺在|望向|穿过)([\u4e00-\u9fa5]{2,10})/g;
  for (const sentence of sentences) {
    for (const word of SCENE_WORDS) {
      if (sentence.includes(word)) add(word, sentence);
    }
    placeRe.lastIndex = 0;
    let m;
    while ((m = placeRe.exec(sentence))) add(m[1], sentence);
  }
  const list = [...stats.values()]
    .sort((a, b) => b.count - a.count)
    .filter((item) => !TIME_WORDS.some((t) => item.name.includes(t)) && !SCENE_ACTION_BAD.test(item.name));
  return list.filter((item) => !list.some((other) => other !== item
    && other.name.length < item.name.length
    && item.name.includes(other.name)
    && other.count >= item.count));
}

function extractProps(sentences) {
  const stats = new Map();
  for (const sentence of sentences) {
    for (const word of PROP_WORDS) {
      if (!sentence.includes(word)) continue;
      if (PROP_BLACKLIST.has(word)) continue;
      if (!stats.has(word)) stats.set(word, { name: word, count: 0, sentences: [] });
      const item = stats.get(word);
      item.count += 1;
      if (item.sentences.length < 6 && !item.sentences.includes(sentence)) item.sentences.push(sentence);
    }
  }
  const list = [...stats.values()].sort((a, b) => b.count - a.count);
  return list.filter((item) => !list.some((other) => other !== item && other.name.includes(item.name) && other.name.length > item.name.length));
}

function buildCharacterPrompt(character, index) {
  const gender = character.gender === 'female' ? '女性' : character.gender === 'male' ? '男性' : '角色';
  const role = character.role === 'antagonist' ? '反派' : character.role === 'protagonist' ? '主角' : '配角';
  const hint = clipWords(character.sentences.join(' '), 90);
  return `${STYLE_HEAD}，${character.name}，${gender}，${role}，${hint || '根据小说描述设计外形'}，半身参考图，正面/侧面/背面三视图，冷色侧逆光，高细节`;
}

function buildScenePrompt(scene) {
  const hint = clipWords(scene.sentences.join(' '), 80);
  return `${STYLE_HEAD}，${scene.name}，${hint || '根据小说描述还原场景'}，环境概念图，广角，氛围光，高细节`;
}

function buildPropPrompt(prop) {
  const hint = clipWords(prop.sentences.join(' '), 70);
  return `${STYLE_HEAD}，${prop.name}，${hint || '根据小说描述设计道具'}，物品特写，干净背景，产品级光影，高细节`;
}

function buildScript(project, chapters, characters, scenes) {
  const episodes = [];
  let beatNo = 0;
  for (const chapter of chapters.slice(0, 60)) {
    const sentences = splitSentences(chapter.text);
    const beats = [];
    let currentLocation = scenes[0]?.name || '未知场景';
    for (const sentence of sentences.slice(0, 40)) {
      const sceneHit = scenes.find((s) => sentence.includes(s.name));
      if (sceneHit) currentLocation = sceneHit.name;
      const dialogue = extractDialogue(sentence);
      const names = characters.filter((c) => sentence.includes(c.name)).slice(0, 4).map((c) => c.name);
      const action = sentence.replace(/[“"][^”"]+[”"]/g, '').trim() || sentence;
      const duration = Math.max(3, Math.min(10, Math.ceil((dialogue.join('').length || action.length) / 4)));
      beatNo += 1;
      beats.push({
        no: beatNo,
        shot: beatNo % 3 === 0 ? '近景' : beatNo % 3 === 1 ? '中景' : '特写',
        location: currentLocation,
        time: guessTime(sentence),
        mood: guessMood(sentence),
        characters: names,
        action: clipWords(action, 120),
        dialogue: dialogue.join(' / '),
        duration,
      });
    }
    episodes.push({
      episode: `S01E${String(episodes.length + 1).padStart(3, '0')}`,
      title: chapter.title,
      sourceChapter: chapter.idx,
      hook: sentences.at(-1) ? clipWords(sentences.at(-1), 80) : '',
      beats,
      totalDuration: beats.reduce((sum, b) => sum + b.duration, 0),
    });
  }
  return {
    title: project.title,
    format: '竖屏漫剧',
    episodeSeconds: 60,
    totalEpisodes: episodes.length,
    episodes,
  };
}

export function ensureAdaptSchema() {
  run(`CREATE TABLE IF NOT EXISTS adapt_projects (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    source_name TEXT,
    source_path TEXT,
    char_count INTEGER DEFAULT 0,
    chapter_count INTEGER DEFAULT 0,
    status TEXT DEFAULT 'uploaded',
    use_llm INTEGER DEFAULT 0,
    summary TEXT,
    warnings TEXT,
    error TEXT,
    created_at TEXT,
    updated_at TEXT
  )`);
  run(`CREATE TABLE IF NOT EXISTS adapt_sources (
    project_id TEXT PRIMARY KEY,
    text TEXT,
    chapters TEXT,
    created_at TEXT
  )`);
  run(`CREATE TABLE IF NOT EXISTS adapt_items (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    category TEXT NOT NULL,
    name TEXT NOT NULL,
    subtitle TEXT,
    summary TEXT,
    details TEXT,
    prompt TEXT,
    negative TEXT,
    tags TEXT,
    importance INTEGER DEFAULT 0,
    source_refs TEXT,
    asset_path TEXT,
    created_at TEXT,
    updated_at TEXT
  )`);
  run('CREATE INDEX IF NOT EXISTS idx_adapt_items_project ON adapt_items(project_id, category)');
}

function readSourceText(sourcePath) {
  const abs = resolveAsset(sourcePath);
  if (!abs || !fs.existsSync(abs)) throw new Error(`上传文件不存在：${sourcePath}`);
  const ext = path.extname(abs).toLowerCase();
  if (!['.txt', '.md', '.json'].includes(ext)) throw new Error('目前支持 txt / md / json，其他格式请先转成纯文本');
  const raw = fs.readFileSync(abs, 'utf8');
  if (ext !== '.json') return raw;
  try {
    const data = JSON.parse(raw);
    if (typeof data === 'string') return data;
    if (typeof data.text === 'string') return data.text;
    if (Array.isArray(data.chapters)) {
      return data.chapters.map((c) => `${c.title || c.name || ''}\n${c.content || c.text || ''}`).join('\n\n');
    }
    return JSON.stringify(data, null, 2);
  } catch {
    return raw;
  }
}

export function createAdaptProject({ title, sourceName, sourcePath, text } = {}) {
  ensureAdaptSchema();
  const body = text !== undefined && text !== null && String(text).trim()
    ? String(text)
    : readSourceText(sourcePath);
  const clean = cleanText(body);
  if (!clean) throw new Error('小说正文为空');
  const id = uid('ADP');
  const now = nowISO();
  const projectTitle = String(title || sourceName || '未命名小说').replace(/\.[^.]+$/, '').trim() || '未命名小说';
  run(
    `INSERT INTO adapt_projects(id, title, source_name, source_path, char_count, chapter_count, status, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?)`,
    id, projectTitle, sourceName || '', sourcePath || '', clean.length, 0, 'uploaded', now, now,
  );
  run(
    'INSERT INTO adapt_sources(project_id, text, chapters, created_at) VALUES(?,?,?,?)',
    id, clean, '[]', now,
  );
  return get('SELECT * FROM adapt_projects WHERE id = ?', id);
}

export function listAdaptProjects() {
  ensureAdaptSchema();
  return all('SELECT * FROM adapt_projects ORDER BY rowid DESC LIMIT 200').map((p) => ({
    ...p,
    summary: safeJson(p.summary, null),
  }));
}

export function getAdaptProject(id) {
  ensureAdaptSchema();
  const project = get('SELECT * FROM adapt_projects WHERE id = ?', id);
  if (!project) return null;
  const source = get('SELECT * FROM adapt_sources WHERE project_id = ?', id);
  const items = all('SELECT * FROM adapt_items WHERE project_id = ? ORDER BY category, importance DESC, rowid', id).map((item) => ({
    ...item,
    details: safeJson(item.details, null),
    tags: safeJson(item.tags, []),
    source_refs: safeJson(item.source_refs, []),
    asset_path: item.asset_path || null,
  }));
  return {
    project: { ...project, summary: safeJson(project.summary, null), warnings: safeJson(project.warnings, []) },
    source: source ? { chars: source.text?.length || 0, chapters: safeJson(source.chapters, []) } : null,
    items,
    grouped: groupItems(items),
  };
}

function groupItems(items) {
  const grouped = {};
  for (const item of items) {
    if (!grouped[item.category]) grouped[item.category] = [];
    grouped[item.category].push(item);
  }
  return grouped;
}

export function deleteAdaptProject(id) {
  ensureAdaptSchema();
  run('DELETE FROM adapt_items WHERE project_id = ?', id);
  run('DELETE FROM adapt_sources WHERE project_id = ?', id);
  run('DELETE FROM adapt_projects WHERE id = ?', id);
  return { ok: true };
}

function clearItems(projectId) {
  run('DELETE FROM adapt_items WHERE project_id = ?', projectId);
}

function insertItem(projectId, category, name, payload = {}) {
  const now = nowISO();
  const id = uid('ADI');
  run(
    `INSERT INTO adapt_items(id, project_id, category, name, subtitle, summary, details, prompt, negative, tags, importance, source_refs, asset_path, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, projectId, category, name,
    payload.subtitle || '',
    payload.summary || '',
    jstr(payload.details || null),
    payload.prompt || '',
    payload.negative || DEFAULT_NEGATIVE,
    jstr(payload.tags || []),
    payload.importance || 0,
    jstr(payload.sourceRefs || []),
    payload.assetPath || null,
    now, now,
  );
  return id;
}

async function runLlmExtraction(text, warnings) {
  try {
    const { chatJSON } = await import('./llm.js');
    const sample = String(text || '').slice(0, 14000);
    const system = '你是 AI 漫剧改编策划。只输出 JSON，不要输出解释、Markdown 围栏或多余文字。';
    const user = `请从下面小说片段中抽取漫剧制作需要的结构化信息。JSON 格式：
{
  "characters":[{"name":"","role":"protagonist|antagonist|supporting","gender":"male|female|unknown","appearance":"","personality":"","costume":""}],
  "scenes":[{"name":"","summary":"","timeOfDay":""}],
  "props":[{"name":"","summary":"","importance":1}],
  "episodes":[{"title":"","hook":"","beats":[{"shot":"","location":"","time":"","characters":[],"action":"","dialogue":"","duration":4}]}]
}
要求：角色名保留原文；不要编造原文没有的重要人物；每集按 60 秒左右拆 beat；只输出 JSON。
小说正文：
${sample}`;
    const result = await chatJSON({ system, user });
    if (result?.mocked) {
      warnings.push('LLM 当前是 mock，已自动回退到离线规则抽取。');
      return null;
    }
    const data = result?.data || result?.json || null;
    if (!data || typeof data !== 'object') {
      warnings.push('LLM 没有返回可解析的 JSON，已回退到离线规则抽取。');
      return null;
    }
    return data;
  } catch (err) {
    warnings.push(`LLM 深度提炼失败，已回退到离线规则抽取：${err.message}`);
    return null;
  }
}

export async function runAdaptation(id, { useLlm = false, maxCharacters = 40, maxScenes = 30, maxProps = 40 } = {}) {
  ensureAdaptSchema();
  const project = get('SELECT * FROM adapt_projects WHERE id = ?', id);
  if (!project) throw new Error('改编项目不存在');
  const source = get('SELECT * FROM adapt_sources WHERE project_id = ?', id);
  if (!source?.text) throw new Error('项目没有正文');

  const warnings = [];

  const chapters = splitChapters(source.text);
  const sentences = splitSentences(source.text);
  let characters = candidateCharacters(sentences).slice(0, asInt(maxCharacters, 40, 1, 200));
  let scenes = extractScenes(sentences, characters.map((c) => c.name)).slice(0, asInt(maxScenes, 30, 1, 200));
  let props = extractProps(sentences).slice(0, asInt(maxProps, 40, 1, 300));
  let script = buildScript(project, chapters, characters, scenes);

  if (useLlm) {
    const llm = await runLlmExtraction(source.text, warnings);
    if (llm) {
      const llmChars = Array.isArray(llm.characters) ? llm.characters : [];
      if (llmChars.length) {
        const offlineByName = new Map(characters.map((c) => [c.name, c]));
        characters = llmChars.map((c) => {
          const offline = offlineByName.get(c.name) || {};
          return {
            name: c.name,
            role: c.role || offline.role || 'supporting',
            gender: c.gender || offline.gender || 'unknown',
            count: offline.count || 1,
            score: offline.score || 50,
            aliases: offline.aliases || [],
            sentences: [c.appearance, c.personality, c.costume, ...(offline.sentences || [])].filter(Boolean).slice(0, 6),
          };
        }).concat(characters.filter((c) => !llmChars.some((l) => l.name === c.name)));
      }
      for (const s of (Array.isArray(llm.scenes) ? llm.scenes : [])) {
        if (s?.name && !scenes.some((x) => x.name === s.name)) scenes.push({ name: s.name, count: 1, sentences: [s.summary || ''].filter(Boolean) });
      }
      for (const p of (Array.isArray(llm.props) ? llm.props : [])) {
        if (p?.name && !props.some((x) => x.name === p.name)) props.push({ name: p.name, count: 1, sentences: [p.summary || ''].filter(Boolean) });
      }
      if (Array.isArray(llm.episodes) && llm.episodes.length) {
        script = {
          ...script,
          totalEpisodes: llm.episodes.length,
          episodes: llm.episodes.map((ep, i) => {
            const beats = Array.isArray(ep.beats) ? ep.beats : [];
            return {
              episode: ep.episode || `S01E${String(i + 1).padStart(3, '0')}`,
              title: ep.title || `第 ${i + 1} 集`,
              sourceChapter: ep.sourceChapter || i + 1,
              hook: ep.hook || '',
              beats,
              totalDuration: beats.reduce((n, b) => n + (Number(b.duration) || 3), 0),
            };
          }),
        };
      }
    }
  }

  clearItems(id);

  insertItem(id, 'script', '剧本转换结果', {
    subtitle: `${script.totalEpisodes} 集 · ${script.episodes.reduce((n, e) => n + e.beats.length, 0)} 个 beat`,
    summary: `已把 ${chapters.length} 个章节拆成 ${script.totalEpisodes} 集竖屏漫剧草案，单集目标 60 秒。`,
    details: script,
    tags: ['剧本', '分集', 'beat'],
    importance: 100,
  });

  const characterAssets = characters.map((c, i) => {
    const prompt = buildCharacterPrompt(c, i);
    const asset = {
      assetType: 'actor',
      targetModule: '明星演员矩阵',
      suggestedId: `C-ADP-${String(i + 1).padStart(3, '0')}`,
      suggestedFileName: `actor_${c.name}_${String(i + 1).padStart(3, '0')}.png`,
      priority: c.role === 'protagonist' ? 'S' : c.role === 'antagonist' ? 'A' : 'B',
      usage: '角色定妆、跨镜参考、角色卡',
      prompt,
      negative: DEFAULT_NEGATIVE,
    };
    insertItem(id, 'character', c.name, {
      subtitle: c.role === 'protagonist' ? '主角' : c.role === 'antagonist' ? '反派' : '配角',
      summary: clipWords(c.sentences.join(' '), 180),
      details: { frequency: c.count, gender: c.gender, role: c.role, sourceRefs: c.sentences.slice(0, 3) },
      prompt,
      negative: DEFAULT_NEGATIVE,
      tags: ['角色', c.role],
      importance: c.score,
      sourceRefs: c.sentences.slice(0, 3),
    });
    insertItem(id, 'prompt', `角色提示词 · ${c.name}`, {
      subtitle: '文生图 / 参考生图',
      summary: prompt,
      details: { type: 'character', target: asset.suggestedId, ratio: '3:4' },
      prompt,
      negative: DEFAULT_NEGATIVE,
      tags: ['提示词', '角色'],
      importance: c.score,
    });
    insertItem(id, 'asset', c.name, {
      subtitle: '角色资产',
      summary: `${asset.suggestedId} · ${asset.targetModule}`,
      details: asset,
      prompt,
      negative: DEFAULT_NEGATIVE,
      tags: ['资产', '角色', asset.priority],
      importance: c.score,
      assetPath: null,
    });
    return { name: c.name, ...asset };
  });

  const sceneAssets = scenes.map((s, i) => {
    const prompt = buildScenePrompt(s);
    const asset = {
      assetType: 'scene',
      targetModule: '画布场景节点',
      suggestedId: `L-ADP-${String(i + 1).padStart(3, '0')}`,
      suggestedFileName: `scene_${s.name}_${String(i + 1).padStart(3, '0')}.png`,
      priority: i < 5 ? 'S' : i < 12 ? 'A' : 'B',
      usage: '场景概念图、关键帧背景、画布场景节点',
      prompt,
      negative: DEFAULT_NEGATIVE,
    };
    insertItem(id, 'scene', s.name, {
      subtitle: '场景',
      summary: clipWords(s.sentences.join(' '), 180),
      details: { frequency: s.count, sourceRefs: s.sentences.slice(0, 3) },
      prompt,
      negative: DEFAULT_NEGATIVE,
      tags: ['场景'],
      importance: s.count,
      sourceRefs: s.sentences.slice(0, 3),
    });
    insertItem(id, 'prompt', `场景提示词 · ${s.name}`, {
      subtitle: '环境概念图',
      summary: prompt,
      details: { type: 'scene', target: asset.suggestedId, ratio: '16:9' },
      prompt,
      negative: DEFAULT_NEGATIVE,
      tags: ['提示词', '场景'],
      importance: s.count,
    });
    insertItem(id, 'asset', s.name, {
      subtitle: '场景资产',
      summary: `${asset.suggestedId} · ${asset.targetModule}`,
      details: asset,
      prompt,
      negative: DEFAULT_NEGATIVE,
      tags: ['资产', '场景', asset.priority],
      importance: s.count,
    });
    return { name: s.name, ...asset };
  });

  const propAssets = props.map((p, i) => {
    const prompt = buildPropPrompt(p);
    const asset = {
      assetType: 'prop',
      targetModule: '画布物品节点',
      suggestedId: `P-ADP-${String(i + 1).padStart(3, '0')}`,
      suggestedFileName: `prop_${p.name}_${String(i + 1).padStart(3, '0')}.png`,
      priority: i < 8 ? 'S' : i < 20 ? 'A' : 'B',
      usage: '道具概念图、关键道具特写、画布物品节点',
      prompt,
      negative: DEFAULT_NEGATIVE,
    };
    insertItem(id, 'prop', p.name, {
      subtitle: '道具',
      summary: clipWords(p.sentences.join(' '), 180),
      details: { frequency: p.count, sourceRefs: p.sentences.slice(0, 3) },
      prompt,
      negative: DEFAULT_NEGATIVE,
      tags: ['道具'],
      importance: p.count,
      sourceRefs: p.sentences.slice(0, 3),
    });
    insertItem(id, 'prompt', `道具提示词 · ${p.name}`, {
      subtitle: '物品特写',
      summary: prompt,
      details: { type: 'prop', target: asset.suggestedId, ratio: '1:1' },
      prompt,
      negative: DEFAULT_NEGATIVE,
      tags: ['提示词', '道具'],
      importance: p.count,
    });
    insertItem(id, 'asset', p.name, {
      subtitle: '道具资产',
      summary: `${asset.suggestedId} · ${asset.targetModule}`,
      details: asset,
      prompt,
      negative: DEFAULT_NEGATIVE,
      tags: ['资产', '道具', asset.priority],
      importance: p.count,
    });
    return { name: p.name, ...asset };
  });

  const allAssets = [...characterAssets, ...sceneAssets, ...propAssets];
  insertItem(id, 'asset', '总资产清单', {
    subtitle: `${allAssets.length} 项资产`,
    summary: `角色 ${characterAssets.length} · 场景 ${sceneAssets.length} · 道具 ${propAssets.length}`,
    details: { isSummary: true, assets: allAssets, counts: { characters: characterAssets.length, scenes: sceneAssets.length, props: propAssets.length } },
    tags: ['资产清单', '总表'],
    importance: 999,
  });

  const summary = {
    version: ADAPT_VERSION,
    chapters: chapters.length,
    sentences: sentences.length,
    characters: characterAssets.length,
    scenes: sceneAssets.length,
    props: propAssets.length,
    episodes: script.totalEpisodes,
    beats: script.episodes.reduce((n, e) => n + e.beats.length, 0),
    prompts: characterAssets.length + sceneAssets.length + propAssets.length,
    assets: allAssets.length,
  };
  const now = nowISO();
  run(
    `UPDATE adapt_projects SET status='done', chapter_count=?, summary=?, warnings=?, updated_at=? WHERE id=?`,
    chapters.length, jstr(summary), jstr(warnings), now, id,
  );
  run('UPDATE adapt_sources SET chapters=? WHERE project_id=?', jstr(chapters.map((c) => ({ idx: c.idx, title: c.title, chars: c.chars }))), id);
  return getAdaptProject(id);
}

export async function importAdaptation(id, options = {}) {
  const bundle = getAdaptProject(id);
  if (!bundle) throw new Error('改编项目不存在');
  const actorsMod = await import('./modules/actors.js');
  const result = {
    characters: [],
    scenes: [],
    props: [],
    script: null,
    canvasId: null,
    skipped: [],
  };

  if (options.characters !== false) {
    for (const item of bundle.grouped.character || []) {
      const exists = get('SELECT id FROM actors WHERE name = ?', item.name);
      if (exists) {
        result.skipped.push(`角色已存在：${item.name}`);
        continue;
      }
      const detail = item.details || {};
      const actor = actorsMod.createActor({
        name: item.name,
        alias: (detail.aliases || []).join(','),
        gender: detail.gender === 'female' ? 'female' : detail.gender === 'male' ? 'male' : '',
        role_type: detail.role === 'protagonist' ? '主角' : detail.role === 'antagonist' ? '反派' : '配角',
        personality: item.summary || '',
        background: item.summary || '',
        style_id: 'cinematic-real',
        ratio: '3:4',
        prompt_pos: item.prompt || '',
        prompt_neg: item.negative || '',
        tags: JSON.stringify(item.tags || []),
      });
      result.characters.push({ id: actor.id, name: item.name });
    }
  }

  const wantCanvas = options.scenes !== false || options.props !== false;
  if (wantCanvas && ((bundle.grouped.scene || []).length || (bundle.grouped.prop || []).length)) {
    const canvasName = `小说改编·${bundle.project.title}`;
    const existing = (actorsMod.listCanvases() || []).find((c) => c.name === canvasName);
    const created = existing ? { canvas: existing } : actorsMod.createCanvas({ name: canvasName, cols: 6, cell: 220 });
    const canvasId = created.canvas?.id || created.id;
    result.canvasId = canvasId;
    let x = 60;
    let y = 60;
    const addAsset = (category, kind, item) => {
      const exists = get('SELECT id FROM canvas_nodes WHERE canvas_id = ? AND title = ? AND kind = ? LIMIT 1', canvasId, item.name, kind);
      if (exists) {
        result[category === 'scene' ? 'scenes' : 'props'].push({ id: exists.id, name: item.name, canvasId, reused: true });
        return;
      }
      const made = actorsMod.createAsset({
        canvas_id: canvasId,
        kind,
        title: item.name,
        x,
        y,
        w: 220,
        h: 170,
        data: {
          desc: item.summary || '',
          prompt: item.prompt || '',
          negative: item.negative || '',
          category: 'novel-adapt',
          tags: item.tags || [],
        },
      });
      result[category === 'scene' ? 'scenes' : 'props'].push({ id: made.node.id, name: item.name, canvasId });
      x += 250;
      if (x > 1500) { x = 60; y += 210; }
    };
    if (options.scenes !== false) for (const item of bundle.grouped.scene || []) addAsset('scene', 'scene', item);
    if (options.props !== false) for (const item of bundle.grouped.prop || []) addAsset('prop', 'item', item);
  }

  if (options.script !== false) {
    const scriptItem = (bundle.grouped.script || [])[0];
    const episodes = scriptItem?.details?.episodes || [];
    if (episodes.length) {
      const title = `${bundle.project.title}·改编剧本`;
      const existing = get('SELECT * FROM scripts WHERE title = ? ORDER BY rowid DESC LIMIT 1', title);
      if (existing) {
        result.script = { id: existing.id, episodes: episodes.length, reused: true };
      } else {
        const scriptId = uid('SC');
        const now = nowISO();
        run(
          `INSERT INTO scripts(id, novel_id, title, format, style_id, episode_seconds, episodes_per_season, seasons, status, created_at, updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
          scriptId, null, title, 'manju', 'cinematic-real', 60, episodes.length, 1, 'draft', now, now,
        );
        for (let i = 0; i < episodes.length; i += 1) {
          const ep = episodes[i];
          const episodeId = uid('EP');
          const code = ep.episode || `S01E${String(i + 1).padStart(3, '0')}`;
          run(
            `INSERT INTO script_episodes(id, script_id, season, episode, code, title, logline, hook, cliffhanger, duration, source_chapters, scenes, status, created_at, updated_at)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            episodeId, scriptId, 1, i + 1, code, ep.title || `第 ${i + 1} 集`, ep.hook || '', ep.hook || '', ep.hook || '',
            Number(ep.totalDuration) || 60, JSON.stringify([ep.sourceChapter].filter(Boolean)),
            JSON.stringify({ beats: ep.beats || [], source: 'novel-adapt' }), 'planned', now, now,
          );
        }
        result.script = { id: scriptId, episodes: episodes.length, reused: false };
      }
    }
  }

  return result;
}

export function exportAdaptation(id, format = 'json') {
  const bundle = getAdaptProject(id);
  if (!bundle) throw new Error('改编项目不存在');
  const fmt = String(format || 'json').toLowerCase();
  if (fmt === 'json') return { format: 'json', bundle };
  if (fmt === 'md') {
    const lines = [`# ${bundle.project.title} · 小说改编资产包`, ''];
    lines.push('## 总览', '');
    lines.push('```json', JSON.stringify(bundle.project.summary || {}, null, 2), '```', '');
    for (const [category, label] of [['script', '剧本'], ['character', '角色'], ['scene', '场景'], ['prop', '道具'], ['prompt', '提示词'], ['asset', '资产清单']]) {
      const items = bundle.grouped[category] || [];
      lines.push(`## ${label}（${items.length}）`, '');
      for (const item of items) {
        lines.push(`### ${item.name}`, '');
        if (item.subtitle) lines.push(`- 类型：${item.subtitle}`);
        if (item.summary) lines.push(`- 摘要：${item.summary}`);
        if (item.prompt) lines.push(`- 正向提示词：${item.prompt}`);
        if (item.negative) lines.push(`- 负向提示词：${item.negative}`);
        lines.push('');
      }
    }
    return { format: 'md', filename: `${bundle.project.title}_改编资产包.md`, text: lines.join('\n') };
  }
  if (fmt === 'csv') {
    const rows = [['类型', '名称', '建议ID', '目标模块', '优先级', '用途', '正向提示词', '负向提示词', '建议文件名']];
    for (const item of bundle.grouped.asset || []) {
      const d = item.details || {};
      if (d.isSummary || d.assets) continue;
      if (!Array.isArray(d)) {
        rows.push([d.assetType || item.subtitle || '', item.name, d.suggestedId || '', d.targetModule || '', d.priority || '', d.usage || '', item.prompt || '', item.negative || '', d.suggestedFileName || '']);
      }
    }
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    return { format: 'csv', filename: `${bundle.project.title}_资产清单.csv`, text: rows.map((r) => r.map(esc).join(',')).join('\n') };
  }
  throw new Error(`不支持的导出格式：${format}`);
}
