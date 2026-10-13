// 100 种题材的 AI 创意引擎
// 每个题材在运行时生成独立蓝图：爆款钩子、世界规则、循环危机、人物公式、续集发动机。

import { GENRES, genreById } from './data/genres.js';
import { buildGenreOverride } from './genre-overrides.js';

const CATEGORY_PROFILES = {
  都市: {
    worldStyle: '现代都市与隐藏规则并存，表面日常、暗处存在资源、身份和权力博弈',
    rules: '资源、地位、证据、人情与规则漏洞构成核心力量；越级行动必须付出身份、事业或关系代价',
    crisis: '城市旧秩序持续失衡，每隔一段时间就会出现新的资本、异能或旧案危机',
    mystery: '城市中有一个影响所有势力的旧时代秘密，前期只以档案、传闻和失踪事件出现',
    protagonist: '被低估的普通人、归来者或掌握稀缺能力的行动者',
    special: '拥有信息差、专业技能或重生记忆，但不能单靠能力解决所有现实问题',
  },
  玄幻: {
    worldStyle: '多大陆、多境界、多纪元更替的升级世界，开放区域之外永远存在更高层文明',
    rules: '力量来自功法、血脉、资源与境界；突破必须伴随瓶颈、反噬或因果代价',
    crisis: '旧纪元封印持续衰减，天地异象与异族战场会周期性爆发',
    mystery: '世界为何不断经历纪元毁灭与重生，真正掌局者从未完整现身',
    protagonist: '出身低微却拥有异常成长路径的少年或觉醒者',
    special: '传承、特殊体质或旁人看不懂的成长方式，但每次升级都会带来新敌人和代价',
  },
  仙侠: {
    worldStyle: '仙门、洞天、凡俗与上界互相牵引，问道之路越往上越孤独',
    rules: '修行讲究道心、因果、寿元与天劫；逆天改命必须承担反噬和失去',
    crisis: '天地灵气与大道秩序周期性衰败，仙门之间的旧盟约不断破裂',
    mystery: '飞升之后究竟去了哪里，仙路尽头是否只是另一重牢笼',
    protagonist: '被宗门轻视、背负旧债或执念入道的修行者',
    special: '拥有罕见道体、本命法宝或残缺大道传承，但成长与情感必须付出代价',
  },
  历史: {
    worldStyle: '王朝、边关、宫廷、地方势力与民间经济交织的历史舞台',
    rules: '权力来自名分、军权、财政和信息；谋略必须符合时代资源与身份限制',
    crisis: '旧王朝周期性面对外患、财政崩塌、继承危机与地方割据',
    mystery: '历史被胜利者改写，一个被抹去的旧案影响后世所有权力更替',
    protagonist: '穿越者、寒门、被贬者或夹在权力夹缝中的执行者',
    special: '掌握未来知识、军略或识人能力，但不能违背时代结构和粮草资源',
  },
  科幻: {
    worldStyle: '星际、赛博城市、废土或近未来社会，技术高度发展但资源分配失衡',
    rules: '物理法则、AI协议、基因权限和能源限制构成边界；技术突破伴随伦理代价',
    crisis: '文明循环面临资源枯竭、AI失控、文明筛选或宇宙级威胁',
    mystery: '人类历史是否被更高文明或自身技术篡改',
    protagonist: '工程师、士兵、幸存者或发现异常数据的普通人',
    special: '拥有特殊权限、记忆、基因或技术入口，但每次使用都会暴露新的系统风险',
  },
  悬疑: {
    worldStyle: '现实城市与隐秘规则叠加，案件表象之下存在长期结构性问题',
    rules: '证据、动机、时间线和信息差决定胜负；错误推理必须造成真实后果',
    crisis: '旧案周期复现，新的案件总与隐藏组织或历史秘密相连',
    mystery: '所有案件背后指向同一个被隐藏的真相或规则制定者',
    protagonist: '侦探、记者、法医、律师或被迫卷入案件的普通人',
    special: '具备异常观察力、记忆或推理能力，但个人创伤会成为判断盲区',
  },
  言情: {
    worldStyle: '都市、校园、豪门或古代关系场域，情感与身份压力同时推进',
    rules: '关系推进必须由选择、误会、成长和现实代价推动，不能只靠巧合',
    crisis: '关系中的旧秘密和新利益不断制造分合循环',
    mystery: '双方命运被一段旧事、家族秘密或未完成承诺绑定',
    protagonist: '有独立目标但情感上有缺口的男女主',
    special: '双方存在强烈互补与冲突点，彼此既是解药也是最大难题',
  },
  军事: {
    worldStyle: '战场、边境、情报网络与军工体系构成高压世界',
    rules: '胜负由情报、补给、纪律、技术和牺牲决定；个人英雄不能违背战术现实',
    crisis: '地区冲突周期性升级，旧战争遗留问题不断制造新战场',
    mystery: '战争背后存在被掩盖的行动、叛徒或更高层利益交换',
    protagonist: '军人、特工、军工专家或战争幸存者',
    special: '拥有稀缺战术能力，但必须面对服从、家国与个人情感的冲突',
  },
  游戏: {
    worldStyle: '网游、全息世界或规则副本，现实与虚拟资源互相影响',
    rules: '等级、职业、机制、资源和团队配合构成边界；漏洞必须有代价',
    crisis: '游戏世界会周期性出现新版本、新副本或系统异常',
    mystery: '游戏为何存在，系统背后是否连接真实世界或更高意识',
    protagonist: '普通玩家、被困者、职业选手或规则破解者',
    special: '掌握隐藏职业、特殊天赋或机制理解，但无法独自通关全部内容',
  },
  奇幻: {
    worldStyle: '王国、魔法、异种族、古代遗迹与预言交织的大陆',
    rules: '魔法、契约、神术和种族能力都必须遵守代价与禁忌',
    crisis: '古老封印和神魔平衡周期性崩坏，新大陆与新种族不断出现',
    mystery: '预言与神明的真实来源，世界是否只是更高存在的棋盘',
    protagonist: '冒险者、被预言者、学院新人或边缘种族成员',
    special: '拥有禁忌血统、特殊契约或能改变规则的能力，但会被多方争夺',
  },
  灵异: {
    worldStyle: '现实民俗、阴阳规则与看不见的灵界相互影响',
    rules: '禁忌、仪式、因果和代价决定能否活着解决问题',
    crisis: '阴阳失衡周期性出现，旧封印与怨念不断在新地点爆发',
    mystery: '灵界规则由谁制定，主角为何能被两界同时注意',
    protagonist: '道士、驱魔人、民间异士或误入禁忌的普通人',
    special: '能看到或沟通常人无法接触的存在，但每次使用都会削弱自身',
  },
  体育: {
    worldStyle: '职业联赛、训练体系、对手梯队和商业体育生态',
    rules: '实力、体能、战术、团队和心理状态共同决定胜负',
    crisis: '赛季循环带来新对手、新伤病和新规则挑战',
    mystery: '旧时代传奇退役真相或主角天赋来源',
    protagonist: '被低估的年轻选手或跌落后的复出者',
    special: '拥有独特技术、身体天赋或比赛阅读能力，但必须靠团队完成冠军',
  },
  职场: {
    worldStyle: '公司、医院、律所、乡村或家庭组织中的现实规则网络',
    rules: '专业能力、资源、人情、规则和底线共同决定结果',
    crisis: '行业周期、组织变动和伦理冲突持续制造新问题',
    mystery: '组织背后的旧项目、事故或权力交易',
    protagonist: '新人、被边缘化专家或想改革旧规则的人',
    special: '拥有专业判断和执行力，但每次坚持原则都会付出职业代价',
  },
  二次元: {
    worldStyle: '日常与幻想元素并存，角色关系和情绪弧光驱动世界展开',
    rules: '事件服务于人物成长、羁绊和主题，夸张设定必须内部一致',
    crisis: '平静日常会周期性被新角色、新任务或灾难打破',
    mystery: '世界温柔表象下隐藏的过去与角色使命',
    protagonist: '有缺口但愿意连接他人的少年少女或群像核心',
    special: '拥有治愈、创造、感知或连接他人的能力，但成长必须面对失去',
  },
};

const GENERIC_PROFILE = {
  worldStyle: '现实规则与题材特色叠加的开放世界',
  rules: '能力、资源、关系和代价共同构成边界',
  crisis: '旧秩序周期性失衡，新危机不断浮现',
  mystery: '世界核心真相前期隐藏，只释放碎片线索',
  protagonist: '被卷入更大事件的成长型主角',
  special: '拥有独特优势，但优势会带来新的责任和短板',
};

const HIT_VARIANTS = [
  '开局三分钟强钩子，先给结果再解释原因',
  '每卷一次身份反差与认知推翻',
  '主角每次胜利都带来更大代价',
  '关键配角拥有可独立成篇的支线',
  '终极谜团分层释放，保证长期追更',
];

function hash(text) {
  let value = 0;
  for (const ch of String(text || '')) value = (value * 31 + ch.charCodeAt(0)) >>> 0;
  return value;
}

function pick(list, seed, offset = 0) {
  return list[(hash(seed) + offset) % list.length];
}

function tagsOf(genre) {
  return Array.isArray(genre.tags) ? genre.tags.filter(Boolean).slice(0, 8) : [];
}

export function buildGenreCreativeBlueprint(genreOrId) {
  const genre = typeof genreOrId === 'object' ? genreOrId : genreById(genreOrId);
  if (!genre?.id) throw new Error('未知题材');
  const p = CATEGORY_PROFILES[genre.cat] || GENERIC_PROFILE;
  const override = buildGenreOverride(genre);
  const tags = tagsOf(genre);
  const seed = `${genre.cat}|${genre.id}|${genre.name}`;
  const tagLine = tags.join('、') || genre.name;
  return {
    genreId: genre.id,
    genreName: genre.name,
    category: genre.cat,
    tone: genre.tone || '',
    sourceHook: genre.hook || '',
    creativePositioning: `${genre.name}：以${tagLine}为核心卖点，保持${genre.tone || '题材默认基调'}，用长期循环危机支撑续集。`,
    worldStyle: `${p.worldStyle}；风格关键词：${tagLine}。`,
    worldRules: `${p.rules}；${override.worldRules}`,
    factionLayers: '表层势力制造单元冲突；中层势力跨季博弈；深层隐秘势力只释放痕迹，最终指向终极谜团。',
    coreLoopCrisis: `${p.crisis}。${override.coreLoopCrisis}`,
    ultimateMystery: `${p.mystery}；${override.ultimateMystery}`,
    protagonistFormula: `${p.protagonist}；${override.protagonistFormula}`,
    protagonistSpecial: `${p.special}；${override.protagonistSpecial}`,
    openingFormula: override.openingFormula,
    hitHooks: [
      pick(HIT_VARIANTS, seed, 0),
      pick(HIT_VARIANTS, seed, 1),
      pick(HIT_VARIANTS, seed, 2),
      `围绕${tagLine}制造可传播名场面`,
      `每季至少一次立场反转和一次格局升级`,
      ...override.hitHooks.slice(0, 2),
    ],
    payoffLoop: '压抑 → 试探 → 反击 → 代价 → 更大真相 → 新目标，形成可持续爽点循环。',
    endingDirection: '回收开局核心意象与主角执念，但保留未开放区域、未解谜团和下一代威胁。',
    sequelEngine: {
      newRegions: `${genre.cat}世界的未开放区域持续扩展`,
      newFactions: '每季引入新势力、旧势力内斗和立场摇摆者',
      newCrisis: `${override.sequelEngine}；根源始终指向终极谜团`,
      characterSpinoffs: '固定小队与反派的个人往事均可独立成番外',
      mysteryLayers: '微型伏笔单卷回收，中型伏笔跨季回收，顶级伏笔保留到终章',
    },
    adaptationValue: '每卷可拆成独立单元漫剧，同时保留主线长线追更动力。',
  };
}

export function listGenreCreativeBlueprints() {
  return GENRES.map((genre) => buildGenreCreativeBlueprint(genre));
}
