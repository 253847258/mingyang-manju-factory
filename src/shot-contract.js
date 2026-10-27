// 分镜契约：V2 方案的单集硬指标（可配置）
// 默认：8–12 镜 / 单镜 3–6 秒 / 台词 ≤30 字
// 只做校验，不修改数据；由闸门路由与前端 preflight 调用。

export const DEFAULT_CONTRACT = Object.freeze({
  minShots: 8,
  maxShots: 12,
  minSec: 3,
  maxSec: 6,
  maxDialogue: 30,
});

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

export function validateShots(shots = [], options = {}) {
  const c = { ...DEFAULT_CONTRACT, ...(options || {}) };
  const list = Array.isArray(shots) ? shots : [];
  const issues = [];
  const n = list.length;

  if (n < c.minShots) issues.push({ type: 'shot_count', severity: 'major', message: `镜头数 ${n}，低于目标 ${c.minShots}–${c.maxShots}` });
  if (n > c.maxShots) issues.push({ type: 'shot_count', severity: 'major', message: `镜头数 ${n}，超出目标 ${c.minShots}–${c.maxShots}` });

  const tooShort = list.filter((s) => num(s.duration) < c.minSec);
  const tooLong = list.filter((s) => num(s.duration) > c.maxSec);
  if (tooShort.length) issues.push({ type: 'duration_short', severity: 'minor', message: `${tooShort.length} 镜短于 ${c.minSec}s`, shotIds: tooShort.map((s) => s.id) });
  if (tooLong.length) issues.push({ type: 'duration_long', severity: 'major', message: `${tooLong.length} 镜超过 ${c.maxSec}s`, shotIds: tooLong.map((s) => s.id) });

  const longDialogue = list.filter((s) => String(s.dialogue || '').replace(/\s+/g, '').length > c.maxDialogue);
  if (longDialogue.length) issues.push({ type: 'dialogue_long', severity: 'major', message: `${longDialogue.length} 镜台词超过 ${c.maxDialogue} 字`, shotIds: longDialogue.map((s) => s.id) });

  const empties = list.filter((s) => !String(s.prompt_pos || '').trim());
  if (empties.length) issues.push({ type: 'prompt_empty', severity: 'blocker', message: `${empties.length} 镜没有正向提示词`, shotIds: empties.map((s) => s.id) });

  return {
    ok: issues.length === 0,
    contract: c,
    issues,
    summary: {
      shots: n,
      tooShort: tooShort.length,
      tooLong: tooLong.length,
      longDialogue: longDialogue.length,
      emptyPrompt: empties.length,
    },
  };
}
