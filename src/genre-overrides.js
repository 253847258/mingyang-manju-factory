// 100 个题材的专属覆盖层。
// 分类骨架负责世界规则下限，本模块保证每个题材有自己的开局、世界规则、主角、危机和续集发动机。

import { GENRES, genreById } from './data/genres.js';

const TEXT = (v, max = 300) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function tagsOf(genre) {
  return (Array.isArray(genre?.tags) ? genre.tags : []).map((x) => TEXT(x, 20)).filter(Boolean).slice(0, 8);
}

export function buildGenreOverride(genreOrId) {
  const genre = typeof genreOrId === 'object' ? genreOrId : genreById(genreOrId);
  if (!genre?.id) throw new Error('未知题材');
  const tags = tagsOf(genre);
  const tagLine = tags.join('、') || genre.name;
  const hook = TEXT(genre.hook, 120) || `${genre.name}的第一个强事件`;
  return {
    genreId: genre.id,
    openingFormula: `以“${hook}”作为第 1 集强钩子，立刻制造不可逆事件，再用“${tagLine}”锁定观众预期。`,
    worldRules: `${genre.name}专属规则必须围绕${tagLine}展开；每次使用核心能力、资源或身份优势，都要产生可见代价。`,
    protagonistFormula: `${genre.name}主角以${tagLine}中的一个核心矛盾为执念，先解决眼前生存问题，再被推向更大格局。`,
    protagonistSpecial: `主角特别之处来自${tagLine}带来的独特视角或能力，同时必须暴露一个无法回避的短板。`,
    coreLoopCrisis: `${genre.name}世界持续出现与${tagLine}相关的周期性危机；解决一个事件只会暴露更大的同类问题。`,
    ultimateMystery: `${genre.name}的终极谜团围绕“${hook}”的真正来源及其背后势力展开，前期只释放碎片。`,
    hitHooks: [
      `开局围绕“${hook}”制造强反差`,
      `每卷围绕${tagLine}升级一次规则`,
      `主角每次获胜都要付出与${tagLine}相关的代价`,
      `中层反派拥有可反转立场`,
      `终极谜团始终只揭一层`,
    ],
    sequelEngine: `每季新增与${tagLine}相关的区域、势力和危机；旧问题被解决后，同类规则在更大范围重演。`,
    contentRule: `${genre.name}内容必须保持题材内部规则自洽，避免只靠偶然和万能能力解决问题。`,
    sourceHook: hook,
  };
}

export function listGenreOverrides() {
  return GENRES.map((genre) => buildGenreOverride(genre));
}
