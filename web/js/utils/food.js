import { STAT_KEYS } from "./stats.js";

export function computeFoodDeltaForTotals(totals, foodRow, useHq) {
  const deltas = {
    gathering: 0,
    perception: 0,
    gp: 0,
  };
  if (!foodRow || !Array.isArray(foodRow.effects)) {
    return deltas;
  }

  for (const effect of foodRow.effects) {
    const statKey = effect?.stat;
    if (!STAT_KEYS.includes(statKey)) {
      continue;
    }

    const value = useHq && foodRow?.can_be_hq ? Number(effect?.hq_value) || 0 : Number(effect?.nq_value) || 0;
    const maxCap = useHq && foodRow?.can_be_hq ? Number(effect?.hq_max) || 0 : Number(effect?.nq_max) || 0;
    const baseStat = Number(totals?.[statKey]) || 0;

    let delta = 0;
    if (effect?.is_relative) {
      delta = Math.floor((baseStat * value) / 100);
    } else {
      delta = value;
    }

    if (maxCap > 0) {
      delta = Math.min(delta, maxCap);
    }
    deltas[statKey] += Math.max(0, delta);
  }

  return deltas;
}
