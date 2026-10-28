// 镜头数规范化：把一集分镜压/补到目标区间（默认 8–12）
// 规则：
//  - 超出上限：优先合并「相邻且都无台词」的短镜头；合并后保留第一个 id
//  - 不足下限：拆分最长的镜头（≥6 秒）
//  - 只返回新数组与变更清单，不写库；应用由路由负责

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const txt = (v) => String(v ?? '').trim();

function mergePair(a, b) {
  const prompt = [txt(a.prompt_pos), txt(b.prompt_pos)]
    .filter(Boolean)
    .filter((v, i, arr) => arr.indexOf(v) === i)
    .join(', ');
  const neg = [txt(a.prompt_neg), txt(b.prompt_neg)]
    .filter(Boolean)
    .filter((v, i, arr) => arr.indexOf(v) === i)
    .join(', ');
  return {
    ...a,
    duration: Math.round((num(a.duration) + num(b.duration)) * 10) / 10,
    dialogue: [txt(a.dialogue), txt(b.dialogue)].filter(Boolean).join(' '),
    action: [txt(a.action), txt(b.action)].filter(Boolean).join('；'),
    prompt_pos: prompt,
    prompt_neg: neg,
    _mergedFrom: [a.id, b.id],
  };
}

export function normalizeShotCount(shots = [], { min = 10, max = 12, minSplitSec = 6 } = {}) {
  const list = (Array.isArray(shots) ? shots : []).map((s) => ({ ...s }));
  const before = list.length;
  const changes = [];

  // 超出：合并
  while (list.length > max) {
    let best = -1;
    let bestScore = Infinity;
    for (let i = 0; i < list.length - 1; i += 1) {
      const a = list[i];
      const b = list[i + 1];
      const noTalk = !txt(a.dialogue) && !txt(b.dialogue);
      const score = (noTalk ? 0 : 1000) + num(a.duration) + num(b.duration);
      if (score < bestScore) { bestScore = score; best = i; }
    }
    if (best < 0) break;
    const a = list[best];
    const b = list[best + 1];
    const merged = mergePair(a, b);
    changes.push({ type: 'merge', from: [a.id, b.id], to: merged.id, at: best });
    list.splice(best, 2, merged);
  }

  // 不足：拆分最长镜头
  while (list.length < min) {
    let idx = -1;
    let maxDur = 0;
    list.forEach((s, i) => { const d = num(s.duration); if (d > maxDur) { maxDur = d; idx = i; } });
    if (idx < 0 || maxDur < minSplitSec) break;
    const s = list[idx];
    const half = Math.round((maxDur / 2) * 10) / 10;
    const rest = Math.round((maxDur - half) * 10) / 10;
    const a = { ...s, duration: half, _splitFrom: s.id };
    const b = {
      ...s, id: `${s.id}-B`, duration: rest, dialogue: '', _splitFrom: s.id,
      prompt_pos: txt(s.prompt_pos), prompt_neg: txt(s.prompt_neg),
    };
    changes.push({ type: 'split', from: s.id, to: [a.id, b.id], at: idx });
    list.splice(idx, 1, a, b);
  }

  list.forEach((s, i) => { s.idx = i + 1; });
  return {
    ok: true,
    before,
    after: list.length,
    inRange: list.length >= min && list.length <= max,
    changes,
    shots: list,
  };
}
