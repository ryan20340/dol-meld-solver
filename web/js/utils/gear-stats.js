export const BASE_GATHERER_GP = 400;

const STAT_KEYS = Object.freeze(["gathering", "perception", "gp"]);

export function emptyTrackedStats() {
  return {
    gathering: 0,
    perception: 0,
    gp: 0,
  };
}

export function addTrackedStats(left, right) {
  return {
    gathering: (Number(left?.gathering) || 0) + (Number(right?.gathering) || 0),
    perception: (Number(left?.perception) || 0) + (Number(right?.perception) || 0),
    gp: (Number(left?.gp) || 0) + (Number(right?.gp) || 0),
  };
}

export function statSum(stats) {
  return STAT_KEYS.reduce((total, key) => total + (Number(stats?.[key]) || 0), 0);
}

export function getGearRowTrackedStats(row, options = {}) {
  const useHq = options.useHq !== false;
  const base = {
    gathering: Number(row?.tracked_base_stats?.gathering) || 0,
    perception: Number(row?.tracked_base_stats?.perception) || 0,
    gp: Number(row?.tracked_base_stats?.gp) || 0,
  };
  const special = {
    gathering: Number(row?.tracked_special_stats?.gathering) || 0,
    perception: Number(row?.tracked_special_stats?.perception) || 0,
    gp: Number(row?.tracked_special_stats?.gp) || 0,
  };

  const includeSpecial = row?.can_be_hq ? useHq : true;
  return includeSpecial ? addTrackedStats(base, special) : base;
}

export function sumSelectedGearTrackedStats(selectedGearRows, options = {}) {
  const rows = Array.isArray(selectedGearRows) ? selectedGearRows : [];
  const useHq = options.useHq !== false;
  const includeBaseGp = options.includeBaseGp === true;

  let totals = emptyTrackedStats();
  for (const row of rows) {
    totals = addTrackedStats(totals, getGearRowTrackedStats(row, { useHq }));
  }

  if (includeBaseGp) {
    totals.gp += BASE_GATHERER_GP;
  }

  return totals;
}
