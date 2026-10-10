// 恢复备份启动闸门（plain text module）
//
// 目的：从旧备份恢复后，库里可能还留着 awaiting_approval / pending 的历史制片与阶段。
// 如果直接启动，studio reconcile 可能自动排队并在后台改写小说、剧本和分镜。
// 这个闸门在启动早期把未完成的历史阶段标记为 canceled，并暂停任务队列，
// 要求人类确认后再恢复。

import { all, run } from './db.js';
import { nowISO } from './util.js';

export function guardRestoredBackup({ force = false } = {}) {
  if (process.env.FACTORY_RESTORE_GUARD === 'off' && !force) {
    return { skipped: true, reason: 'FACTORY_RESTORE_GUARD=off' };
  }

  const productions = all(
    "SELECT id, title, status FROM productions WHERE status NOT IN ('done', 'canceled', 'error')",
  );
  const stages = all(
    "SELECT id, production_id, stage, status FROM production_stages WHERE status NOT IN ('done', 'canceled', 'error')",
  );

  if (!productions.length && !stages.length) {
    return { triggered: false, productions: 0, stages: 0, paused: false };
  }

  const now = nowISO();
  for (const p of productions) {
    run("UPDATE productions SET status = 'canceled' WHERE id = ?", p.id);
  }
  for (const s of stages) {
    run(
      "UPDATE production_stages SET status = 'canceled', error = ?, updated_at = ? WHERE id = ?",
      '恢复备份启动闸门：未完成的历史阶段不自动续跑，等待人工确认',
      now,
      s.id,
    );
  }
  run(
    "INSERT OR REPLACE INTO app_config(key, value) VALUES('jobs:paused', ?)",
    JSON.stringify({
      paused: true,
      reason: '恢复备份启动闸门：已暂停队列，避免历史任务自动续跑',
      by: 'system',
      at: now,
    }),
  );

  return {
    triggered: true,
    productions: productions.length,
    stages: stages.length,
    paused: true,
  };
}
