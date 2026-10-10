// 一次性修复：演示小说/剧本里指向「已不存在的演员」的引用，重新绑到当前演员表
// 用法：node scripts/fix-demo-cast.js            （默认修复全部）
//       node scripts/fix-demo-cast.js N-0001     （只修某部小说）
import { migrate, all, get, run } from '../src/db.js';

migrate();
const only = process.argv[2] || null;
const cast = all('SELECT id, name, role_type FROM actors ORDER BY sort ASC, created_at ASC');
if (!cast.length) { console.error('演员表为空：请先 node scripts/seed-demo.js'); process.exit(1); }
const alive = new Set(cast.map((a) => a.id));
const pick = (i) => cast[i % cast.length].id;

let novelFixed = 0, shotFixed = 0, shotCleared = 0;
for (const n of all('SELECT * FROM novels' + (only ? ' WHERE id = ?' : ''), ...(only ? [only] : []))) {
  let ids = [];
  try { ids = JSON.parse(n.actor_ids || '[]'); } catch { ids = []; }
  const kept = ids.filter((x) => alive.has(x));
  const want = Math.max(kept.length, Math.min(Number(n.cast_size) || 6, cast.length));
  const next = [...kept];
  for (let i = 0; next.length < want; i++) { const id = pick(i); if (!next.includes(id)) next.push(id); }
  if (JSON.stringify(next) !== JSON.stringify(ids)) {
    run('UPDATE novels SET actor_ids = ?, updated_at = ? WHERE id = ?', JSON.stringify(next), new Date().toISOString(), n.id);
    novelFixed++;
  }
  // 该小说下的剧本镜头：refs.characters 里失效的引用换成现有班底
  const scripts = all('SELECT id FROM scripts WHERE novel_id = ?', n.id);
  for (const sc of scripts) {
    for (const s of all('SELECT id, refs FROM shots WHERE script_id = ?', sc.id)) {
      let refs = null;
      try { refs = s.refs ? JSON.parse(s.refs) : null; } catch { refs = null; }
      const chars = Array.isArray(refs?.characters) ? refs.characters : [];
      if (!chars.length) continue;
      const keptC = chars.filter((x) => alive.has(x));
      const nextC = keptC.length ? keptC : [pick(0), pick(1)].filter(Boolean);
      if (JSON.stringify(nextC) !== JSON.stringify(chars)) {
        const merged = { ...(refs || {}), characters: nextC };
        run('UPDATE shots SET refs = ? WHERE id = ?', JSON.stringify(merged), s.id);
        keptC.length ? shotFixed++ : shotCleared++;
      }
    }
  }
}
console.log(`[fix-cast] 小说修复 ${novelFixed} 部｜镜头引用重绑 ${shotFixed} 处、失效引用替换 ${shotCleared} 处｜当前演员 ${cast.length} 位`);
