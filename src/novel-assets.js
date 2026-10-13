// 小说工坊 · 资产 ID 索引（人物 / 环境 / 物品）
// 统一从演员矩阵、改编资产、大纲分节生成稳定 ID，供前端高亮和 AI 提示词优先引用。

import { all, get } from './db.js';

const TEXT = (v, max = 300) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const safeJson = (v, fallback) => {
  try {
    const out = JSON.parse(v || '');
    return out == null ? fallback : out;
  } catch { return fallback; }
};
const uniqBy = (rows, keyOf) => {
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const key = keyOf(row);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
};

function samePlaceName(a, b) {
  const left = TEXT(a, 60).replace(/^(临海市|第?[一二三四五六七八九十]+)/, '');
  const right = TEXT(b, 60).replace(/^(临海市|第?[一二三四五六七八九十]+)/, '');
  if (!left || !right) return false;
  if (left === right) return true;
  return left.length >= 2 && right.length >= 2 && (left.includes(right) || right.includes(left));
}

function latestOutline(novelId) {
  const row = get('SELECT payload FROM novel_outlines WHERE novel_id = ? ORDER BY version DESC LIMIT 1', novelId);
  return row ? safeJson(row.payload, {}) : {};
}

function adaptationItems(novel) {
  const meta = safeJson(novel?.meta, {});
  const projectId = meta.adaptProjectId || '';
  if (!projectId) return { items: [], assets: [] };
  return {
    assets: all(
      `SELECT name, subtitle, summary, tags, importance
       FROM adapt_items WHERE project_id = ? AND category = 'asset'
       ORDER BY importance DESC, rowid`,
      projectId,
    ),
    items: all(
      `SELECT name, subtitle, summary, tags, importance
       FROM adapt_items WHERE project_id = ? AND category IN ('character','scene','prop')
       ORDER BY importance DESC, rowid`,
      projectId,
    ),
  };
}

function idFromSummary(summary, prefix) {
  const m = String(summary || '').match(new RegExp(`${prefix}-[A-Z0-9-]+`, 'i'));
  return m ? m[0].toUpperCase() : '';
}

export function buildNovelAssets(novelOrId, sectionsOverride = null) {
  const novel = typeof novelOrId === 'object' ? novelOrId : get('SELECT * FROM novels WHERE id = ?', novelOrId);
  if (!novel) throw new Error('小说不存在');
  const meta = safeJson(novel.meta, {});
  const sections = sectionsOverride || latestOutline(novel.id);
  const adapt = adaptationItems(novel);
  const adaptByName = new Map(adapt.items.map((x) => [TEXT(x.name, 50), x]));
  const assetByName = new Map(
    adapt.assets
      .filter((x) => /角色资产|场景资产|道具资产/.test(x.subtitle || ''))
      .map((x) => [TEXT(x.name, 50), x]),
  );

  const actorIds = safeJson(novel.actor_ids, []).filter(Boolean).slice(0, 300);
  const actors = actorIds.length
    ? all(`SELECT id, name, role_type, gender, age, personality, background, costume, cover_image FROM actors WHERE id IN (${actorIds.map(() => '?').join(',')})`, ...actorIds)
    : [];
  const custom = safeJson(novel.custom_actors, []);
  const outlineCharacters = Array.isArray(sections.characters) ? sections.characters : [];

  const characters = uniqBy([
    ...actors.map((x) => ({
      id: x.id, kind: 'character', name: x.name, role: x.role_type || '',
      desc: [x.personality, x.background, x.costume].filter(Boolean).join('；'),
      source: '演员矩阵', thumb: x.cover_image || '',
    })),
    ...(Array.isArray(custom) ? custom.map((x, i) => ({
      id: TEXT(x.id, 20) || `CX-${String(i + 1).padStart(4, '0')}`,
      kind: 'character', name: x.name || '', role: x.role || '自定义角色',
      desc: x.desc || '', source: '自定义角色', thumb: '',
    })) : []),
    ...outlineCharacters.map((x) => ({
      id: TEXT(x.id, 20), kind: 'character', name: x.name || '', role: x.role || '',
      desc: [x.arc, x.function, x.relationships].filter(Boolean).join('；'),
      source: '大纲人物规划', thumb: '',
    })),
  ], (x) => x.id);

  const outlineLocations = Array.isArray(sections.locations) ? sections.locations : [];
  const findKnownLocation = (name) => outlineLocations.find((x) => samePlaceName(x.name, name));
  const adaptationScenes = adapt.items.filter((x) => x.subtitle === '场景');
  const environments = uniqBy([
    ...outlineLocations.map((x) => ({
      id: TEXT(x.id, 20), kind: 'environment', name: x.name || '', role: x.type || '场景',
      desc: x.desc || '', source: '大纲地点档案', thumb: '',
    })),
    ...adaptationScenes.map((x) => {
      const asset = assetByName.get(TEXT(x.name, 50));
      const known = findKnownLocation(x.name);
      return {
        id: known?.id || idFromSummary(asset?.summary, 'L') || '',
        kind: 'environment', name: x.name || '', role: '改编场景',
        desc: x.summary || '', source: '改编资产', thumb: '',
      };
    }),
  ], (x) => x.id);

  const adaptationProps = adapt.items.filter((x) => x.subtitle === '道具');
  const props = uniqBy([
    ...(Array.isArray(sections.props) ? sections.props.map((x) => ({
      id: TEXT(x.id, 20), kind: 'prop', name: x.name || '', role: x.type || '道具',
      desc: x.desc || '', source: '大纲物品档案', thumb: '',
    })) : []),
    ...adaptationProps.map((x) => {
      const asset = assetByName.get(TEXT(x.name, 50));
      return {
        id: idFromSummary(asset?.summary, 'P') || '',
        kind: 'prop', name: x.name || '', role: '改编道具',
        desc: x.summary || '', source: '改编资产', thumb: '',
      };
    }),
  ], (x) => x.id);

  const known = new Set([...characters, ...environments, ...props].map((x) => x.id));
  const chapterRows = all('SELECT title, summary, content FROM novel_chapters WHERE novel_id = ? ORDER BY idx LIMIT 300', novel.id);
  const scanText = [JSON.stringify(sections), ...chapterRows.map((x) => `${x.title || ''}\n${x.summary || ''}\n${x.content || ''}`)]
    .join('\n')
    .slice(0, 2_000_000);
  const ids = new Set((scanText.match(/\b[CLP]-[A-Z0-9-]+\b/gi) || []).map((x) => x.toUpperCase()));
  for (const id of ids) {
    if (known.has(id)) continue;
    if (id.startsWith('C-')) {
      characters.push({ id, kind: 'character', name: `角色 ${id}`, role: '大纲/正文引用', desc: '从大纲或正文中扫描到的角色 ID。', source: '引用扫描', thumb: '' });
    } else if (id.startsWith('L-')) {
      environments.push({ id, kind: 'environment', name: `环境 ${id}`, role: '大纲/正文引用', desc: '从大纲或正文中扫描到的环境 ID。', source: '引用扫描', thumb: '' });
    } else if (id.startsWith('P-')) {
      props.push({ id, kind: 'prop', name: `物品 ${id}`, role: '大纲/正文引用', desc: '从大纲或正文中扫描到的物品 ID。', source: '引用扫描', thumb: '' });
    }
  }

  return {
    ok: true,
    novelId: novel.id,
    adaptProjectId: meta.adaptProjectId || '',
    characters,
    environments,
    props,
    summary: {
      characters: characters.length,
      environments: environments.length,
      props: props.length,
      total: characters.length + environments.length + props.length,
    },
  };
}

export function assetPromptBlock(assets) {
  const a = assets || {};
  const lines = [
    '【全量资产 ID 索引（最高优先级，凡出现必须带 ID）】',
    `人物：${(a.characters || []).map((x) => `${x.id} ${x.name}${x.role ? `(${x.role})` : ''}`).join('；') || '无'}`,
    `环境：${(a.environments || []).map((x) => `${x.id} ${x.name}${x.role ? `(${x.role})` : ''}`).join('；') || '无'}`,
    `物品：${(a.props || []).map((x) => `${x.id} ${x.name}${x.role ? `(${x.role})` : ''}`).join('；') || '无'}`,
    '故事优先级：故事大纲 > 正文内容承接 > 头尾逻辑与故事线闭环。',
  ];
  return lines.join('\n');
}
