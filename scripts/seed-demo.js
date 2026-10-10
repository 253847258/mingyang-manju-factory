// 演示数据：10 位演员 + 宫格排布 + 一组定妆图（默认占位出图）
// 用法：node scripts/seed-demo.js [--yes] [baseUrl]   默认 http://127.0.0.1:8788
//
// ⚠️ 会花钱：最后一步「全员定妆主图」会按当前出图后端真出 10 张（真实后端接入后，
//    按 budget.imageUnit 计价 —— 百炼 wan2.7-image ¥0.2/张时约 ¥2）。
//    因此**不带 --yes 时只打印「将要做什么 + 预估费用」然后退出，不调用任何付费接口**
//    （只读 GET /api/health 与 GET /api/guard/status）。
const ARGV = process.argv.slice(2);
const YES = ARGV.includes('--yes') || ARGV.includes('-y');
const BASE = (ARGV.find((a) => !a.startsWith('-')) || process.env.BASE || 'http://127.0.0.1:8788').replace(/\/+$/, '');

const DEMO = [
  { name: '林知夏', gender: 'female', age: 19, race: 'asian-east', height_cm: 162, body_type: 'petite', skin: 'fair', hair_style: 'twin-tails', hair_color: 'brown', eyes: 'amber', style_id: 'jp-anime', ratio: '2:3', role_type: '女主', personality: '活泼开朗，嘴上不饶人', background: '普通高中二年级学生，意外卷入了一场跨越十年的秘密。', costume: 'white sailor uniform with red ribbon' },
  { name: '沈砚', gender: 'male', age: 28, race: 'asian-east', height_cm: 186, body_type: 'athletic', skin: 'light', hair_style: 'undercut', hair_color: 'black', eyes: 'grey', style_id: 'cinematic-real', ratio: '16:9', role_type: '男主', personality: '沉默寡言，行动派', background: '退役特种兵，如今在城市边缘做着不能上台面的活。', costume: 'black trench coat, leather gloves' },
  { name: '苏晚晴', gender: 'female', age: 24, race: 'asian-east', height_cm: 170, body_type: 'slim', skin: 'fair', hair_style: 'long-straight', hair_color: 'black', eyes: 'violet', style_id: 'cn-guofeng', ratio: '2:3', role_type: '女主', personality: '外冷内热，心思缜密', background: '药王谷传人，为查清师门灭门真相而下山入世。', costume: 'white hanfu with silver embroidery' },
  { name: '陆沉舟', gender: 'male', age: 35, race: 'asian-east', height_cm: 188, body_type: 'burly', skin: 'tan', hair_style: 'short-bob', hair_color: 'black', eyes: 'black', style_id: 'dark-gothic', ratio: '2:3', role_type: '终极反派', personality: '阴鸷狠辣，城府极深', background: '帝国的暗面执掌者，用二十年布下一盘棋。', costume: 'black gothic armor with gold trim' },
  { name: '艾莉丝', gender: 'female', age: 120, race: 'elf', height_cm: 175, body_type: 'tall-lean', skin: 'fair', hair_style: 'long-wavy', hair_color: 'silver', eyes: 'green', style_id: 'pixar-3d', ratio: '2:3', role_type: '导师', personality: '优雅从容，见证过太多生死', background: '森林最后的守望者，把人类当作短暂却珍贵的火种。', costume: 'elven green robe with leaf ornaments' },
  { name: '凯', gender: 'male', age: 30, race: 'cyborg', height_cm: 195, body_type: 'muscular', skin: 'grey', hair_style: 'bald', hair_color: 'black', eyes: 'red', style_id: 'cyberpunk', ratio: '16:9', role_type: '搭档', personality: '冷幽默，机械义体占七成', background: '义体佣兵，靠接单养活自己和一台老旧机器人。', costume: 'chrome exosuit with neon strips' },
  { name: '白无咎', gender: 'male', age: 22, race: 'spirit', height_cm: 180, body_type: 'slim', skin: 'pale-blue', hair_style: 'long-straight', hair_color: 'silver', eyes: 'heterochromia', style_id: 'ink-wash', ratio: '2:3', role_type: '男配', personality: '妖异疏离，似人非人', background: '一只活了几百年的狐妖，只记得自己答应过一个人一件事。', costume: 'flowing white robe with fox mask' },
  { name: '罗刹', gender: 'female', age: 27, race: 'demon', height_cm: 172, body_type: 'curvy', skin: 'pale-blue', hair_style: 'wolf-cut', hair_color: 'red', eyes: 'gold', style_id: 'us-comic', ratio: '2:3', role_type: '反派', personality: '暴烈张狂，享受战斗', background: '魔界第七军的先锋，被放逐到人间后反而找到了乐子。', costume: 'spiked leather armor, demon horns' },
  { name: '秦昭', gender: 'male', age: 45, race: 'asian-east', height_cm: 178, body_type: 'standard', skin: 'light', hair_style: 'bun', hair_color: 'black', eyes: 'brown', style_id: 'retro-cel', ratio: '4:3', role_type: '导师', personality: '温和固执，一板一眼', background: '旧时代的档案管理员，掌握着所有人不愿提起的记录。', costume: 'vintage brown suit, round glasses' },
  { name: '星野遥', gender: 'female', age: 16, race: 'android', height_cm: 152, body_type: 'chibi', skin: 'fair', hair_style: 'ponytail', hair_color: 'blue', eyes: 'gold', style_id: 'kr-webtoon', ratio: '3:4', role_type: '男配', personality: '天真直接，学习能力惊人', background: '实验体 07 号，第一次走出实验室时以为世界只有一间屋子那么大。', costume: 'white futuristic bodysuit with blue glow' },
];

async function main() {
  const post = async (p, body) => {
    const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
    const j = await r.json();
    if (!j.ok) throw new Error(`${p} 失败：${j.error}`);
    return j;
  };
  const health = await (await fetch(BASE + '/api/health')).json();

  // ── 二次确认闸门：不带 --yes 只做只读预演（打印将要做什么 + 预估费用），绝不提交任何付费任务 ──
  let guard = null;
  try { guard = await (await fetch(BASE + '/api/guard/status')).json(); } catch { guard = null; }
  const unit = Number(guard?.cost?.units?.imageUnit ?? 0);
  const est = Math.round(DEMO.length * unit * 10000) / 10000;
  if (!YES) {
    const backend = health.image?.backend || '(未知)';
    console.log(`[seed] 目标服务：${BASE}`);
    console.log(`[seed] 当前演员 ${health.counts?.actors ?? '?'} 位，出图后端 ${backend}`);
    console.log('[seed] 预演（未带 --yes，不会调用任何付费接口）：');
    console.log(`  1) 新增 ${DEMO.length} 位演示演员：${DEMO.map((a) => a.name).join('、')}`);
    console.log(`  2) 画布宫格排布（5 列 × 210px，本地写库，零费用）`);
    console.log(`  3) 提交「演示：全员定妆主图」批量出图 ${DEMO.length} 张 —— ${backend === 'placeholder' ? '占位后端：本地 SVG，零费用' : `真实后端「${backend}」：按单价 ¥${unit}/张真花钱`}`);
    console.log(`[seed] 预估费用：¥${est}${guard ? `（本月已用 ¥${guard.cost?.amount ?? '?'} / 上限 ¥${guard.budget?.monthlyCap ?? '?'}）` : ''}`);
    console.log('[seed] 确认要真跑（并接受上面这笔费用）：node scripts/seed-demo.js --yes');
    return { planOnly: true, actors: DEMO.length, images: DEMO.length, backend, estimatedCostCNY: est };
  }

  console.log(`[seed] 目标服务：${BASE}`);
  console.log(`[seed] 当前演员 ${health.counts.actors} 位，出图后端 ${health.image.backend}`);
  if (guard && unit > 0 && health.image?.backend !== 'placeholder') {
    console.log(`[seed] 已确认 --yes：本次将真出 ${DEMO.length} 张，预估 ¥${est}（本月已用 ¥${guard.cost?.amount ?? 0} / 上限 ¥${guard.budget?.monthlyCap ?? 0}）`);
  }

  const ids = [];
  for (const a of DEMO) {
    const r = await post('/api/actors', a);
    ids.push(r.actor.id);
    console.log(`  ✓ ${r.actor.id}  ${r.actor.name}  (${r.actor.style_id})`);
  }
  const arr = await post('/api/canvas/auto-arrange', { cols: 5, cell: 210 });
  console.log(`[seed] 宫格排布完成，画布节点 ${arr.canvas.nodes.length} 个`);

  const job = await post('/api/generate/batch', { actorIds: ids, kind: 'full', variants: ['keyart'], title: '演示：全员定妆主图' });
  console.log(`[seed] 已提交定妆图任务 ${job.jobId}（${job.total} 张），可在界面右下角查看进度`);
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const j = await (await fetch(`${BASE}/api/jobs/${job.jobId}`)).json();
    if (j.job.status === 'done' || j.job.status === 'error') {
      console.log(`[seed] 任务${j.job.status === 'done' ? '完成' : '失败'}：${j.job.done}/${j.job.total}${j.job.error ? ' · ' + j.job.error : ''}`);
      break;
    }
  }
  console.log('[seed] 全部完成，打开 http://127.0.0.1:8788/ 查看明星宫格矩阵。');
}

main().catch((e) => { console.error('[seed] 失败：', e.message); process.exit(1); });
