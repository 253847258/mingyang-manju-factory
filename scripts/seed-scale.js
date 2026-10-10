#!/usr/bin/env node
/**
 * 规模种子数据：按产品上限造一套「满配」数据（200 演员 / 100 集 / 单集 200 镜 / 200 章 / 200 连线）。
 * 供两类测试复用：
 *   · tests/test-scale.js   —— 后端接口规模压测（直接调用本模块导出的 seedScale）
 *   · tests/ui-scale.py     —— 前端满配渲染检查（CLI 方式生成库，再启动服务用浏览器验证）
 * 用法：node scripts/seed-scale.js <dbPath> [dataDir] [--actors=200 --episodes=100 --shots=200 --chapters=200]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DEFAULT_SCALE = { actors: 200, imagesPerActor: 1, episodes: 100, shotsPerEpisode: 200, chapters: 200, canvasLinks: 200, groups: 20, jobs: 300 };

/**
 * 写入满配种子数据（要求：db 已 migrate）
 * @param {{actors?:number,episodes?:number,shotsPerEpisode?:number,chapters?:number,canvasLinks?:number,groups?:number,jobs?:number,imagesPerActor?:number}} scale
 * @returns {{shotRows:number,kfRows:number,videoRows:number,ms:number}}
 */
export function seedScale(scale = {}, db = null) {
  const S = { ...DEFAULT_SCALE, ...scale };
  const t0 = performance.now();
  const d = db;
  const { run } = d || {};
  if (!run) throw new Error('seedScale 需要传入 db 模块（{ run }）');
  const now = new Date().toISOString();
  const styles = ['cinematic-real', 'cn-guofeng', 'jp-anime', 'noir-crime', 'cyberpunk'];
  let shotRows = 0, kfRows = 0, vidRows = 0;
  run('BEGIN');
  try {
  for (let i = 1; i <= S.actors; i++) {
    const id = `C-${String(i).padStart(4, '0')}`;
    run(`INSERT INTO actors(id,name,role_type,gender,age,race,height_cm,body_type,style_id,hair_style,hair_color,eyes,costume,personality,background,prompt_pos,prompt_neg,ratio,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, `演员${i}`, i % 7 === 0 ? '反派' : i % 3 === 0 ? '配角' : '主角', i % 2 ? 'male' : 'female', 18 + (i % 30),
      'asian-east', 160 + (i % 30), ['slim', 'athletic', 'average'][i % 3], styles[i % styles.length],
      'long-straight', 'black', 'brown', 'wearing coat', '冷静', '来自港口城市',
      `1person, ${18 + (i % 30)} years old, east asian, cinematic`, 'blurry, low quality', '3:4', now, now);
    for (let k = 0; k < S.imagesPerActor; k++) {
      run(`INSERT INTO actor_images(id,actor_id,kind,variant,label,file_path,mime,width,height,prompt_pos,prompt_neg,backend,status,created_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        `IMG-SC-${i}-${k}`, id, 'full', 'front', '定妆图', `data/images/${id}/full_front_${k}.svg`, 'image/svg+xml', 768, 1024,
        'cinematic portrait', 'blurry', 'placeholder', 'done', now);
    }
  }
  for (let i = 0; i < S.actors; i++) {
    run(`INSERT INTO canvas_nodes(id,canvas_id,actor_id,x,y,w,h,z,locked,kind,group_id)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      `ND-SC-${i}`, 'CV-MAIN', `C-${String(i + 1).padStart(4, '0')}`, (i % 20) * 240, Math.floor(i / 20) * 300, 210, 210, i, 0, 'actor', null);
  }
  for (let g = 0; g < S.groups; g++) {
    run('INSERT INTO canvas_groups(id,canvas_id,name,color,x,y,w,h,collapsed,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,0,?,?)',
      `GP-SC-${g}`, 'CV-MAIN', `分组${g + 1}`, '#888888', (g % 5) * 1000, Math.floor(g / 5) * 700, 900, 600, now, now);
  }
  for (let l = 0; l < S.canvasLinks; l++) {
    const a = `ND-SC-${l % S.actors}`;
    const b = `ND-SC-${(l * 7 + 3) % S.actors}`;
    if (a === b) continue;
    run(`INSERT INTO canvas_links(id,canvas_id,from_actor,to_actor,from_node,to_node,from_side,to_side,label,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)`, `LK-SC-${l}`, 'CV-MAIN', '', '', a, b, 'right', 'left', `关系${l % 5}`, now);
  }

  run(`INSERT INTO novels(id,title,genre,tone,scale,cast_size,target_words,chapter_words,pov,seasons,status,created_at,updated_at)
       VALUES('N-SCALE','压测小说','classic-xianxia','史诗厚重','long',200,2000000,2000,'third-limited',2,'outline',?,?)`, now, now);
  for (let c = 1; c <= S.chapters; c++) {
    run(`INSERT INTO novel_chapters(id,novel_id,idx,title,summary,content,words,status,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
      `CH-SC-${c}`, 'N-SCALE', c, `第${c}章`, `第${c}章摘要`, `第${c}章正文内容。`.repeat(30), 600, c <= 100 ? 'done' : 'planned', now, now);
    void 0;
  }
  run(`INSERT INTO scripts(id,novel_id,title,format,style_id,episode_seconds,episodes_per_season,seasons,status,created_at,updated_at)
       VALUES('SC-SCALE','N-SCALE','压测剧本','manju','cinematic-real',180,100,1,'storyboard',?,?)`, now, now);
  for (let e = 1; e <= S.episodes; e++) {
    const code = `S01E${String(e).padStart(3, '0')}`;
    run(`INSERT INTO script_episodes(id,script_id,season,episode,code,title,duration,status,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)`, `EP-SC-${e}`, 'SC-SCALE', 1, e, code, `第${e}集`, 180, 'storyboard', now, now);
    for (let s = 1; s <= S.shotsPerEpisode; s++) {
      const sid = `SH-SC-${e}-${s}`;
      run(`INSERT INTO shots(id,script_id,episode_id,idx,scene_no,location_id,shot_size,camera,move,transition,duration,action,dialogue,prompt_pos,prompt_neg,refs,cost_level,status,created_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        sid, 'SC-SCALE', `EP-SC-${e}`, s, String(1 + (s % 5)), 'L-0001', '中景', '平视', '固定', '切', 3,
        `第${e}集第${s}镜动作`, s % 4 === 0 ? `第${e}集第${s}镜台词` : '', `cinematic shot ${e}-${s}, harbor at night`, 'blurry, low quality',
        '{}', ['L', 'M', 'H'][s % 3], 'draft', now);
      shotRows++;
      // 前 20 集给关键帧与视频（模拟「已做一半」的真实状态）
      if (e <= 20) {
        kfRows++;
        run(`INSERT INTO shot_renders(id,script_id,episode_id,shot_id,kind,file_path,mime,width,height,backend,status,created_at)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, `RD-SC-K-${e}-${s}`, 'SC-SCALE', `EP-SC-${e}`, sid, 'keyframe',
          `data/images/S_SC-SCALE/k_${e}_${s}.svg`, 'image/svg+xml', 720, 1280, 'placeholder', 'done', now);
        if (s % 2 === 0) {
          vidRows++;
          run(`INSERT INTO shot_renders(id,script_id,episode_id,shot_id,kind,file_path,mime,width,height,duration,backend,status,created_at)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, `RD-SC-V-${e}-${s}`, 'SC-SCALE', `EP-SC-${e}`, sid, 'video',
            `data/videos/S_SC-SCALE/v_${e}_${s}.mp4`, 'video/mp4', 720, 1280, 3, 'placeholder', 'done', now);
        }
      }
    }
  }
  for (let j = 1; j <= S.jobs; j++) {
    run(`INSERT INTO jobs(id,type,title,status,progress,total,done,payload,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)`, `JOB-SC-${j}`, j % 2 ? 'keyframe' : 'video', `压测任务${j}`,
      ['done', 'error', 'queued'][j % 3], 100, 10, 10, '{}', now, now);
  }

  const seedMs = Math.round(performance.now() - t0);
  const dbMB = (() => { try { return Math.round((fs.statSync(DB).size / 1048576) * 10) / 10; } catch { return 0; } })();
  } catch (e) { run('ROLLBACK'); throw e; }
  run('COMMIT');
  return { shotRows, kfRows, videoRows: vidRows, ms: Math.round(performance.now() - t0) };
}

// ---------------- CLI ----------------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dbPath = process.argv[2];
  const dataDir = process.argv[3] || path.join(path.dirname(dbPath), 'scale-data');
  if (!dbPath) { console.error('用法：node scripts/seed-scale.js <dbPath> [dataDir]'); process.exit(2); }
  const flags = {};
  for (const a of process.argv.slice(4)) {
    const m = /^--(\w+)=?(\d+)?$/.exec(a);
    if (m) flags[m[1]] = m[2] ? Number(m[2]) : true;
  }
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
  fs.mkdirSync(dataDir, { recursive: true });
  process.env.FACTORY_DB = dbPath;
  process.env.FACTORY_DATA_DIR = dataDir;
  const db = await import('../src/db.js');
  db.migrate();
  const out = seedScale(flags, db);
  console.log(JSON.stringify({ db: dbPath, dataDir, ...out, scale: { ...DEFAULT_SCALE, ...flags } }));
}
