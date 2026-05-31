const STORAGE_KEY = "dol-meld-solver-saved-plans";
const MAX_SAVED_PLANS = 20;
const STAT_KEYS = Object.freeze(["gathering", "perception", "gp"]);
const STAT_DISPLAY = Object.freeze({
  gathering: "Gathering",
  perception: "Perception",
  gp: "GP",
});
const GRADE_ROMAN = Object.freeze(["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"]);

function normalizeInt(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.floor(parsed);
}

function normalizeNonNegativeInt(value, fallback = 0) {
  return Math.max(0, normalizeInt(value, fallback));
}

function emptyStats() {
  return {
    gathering: 0,
    perception: 0,
    gp: 0,
  };
}

function cloneStats(value) {
  return {
    gathering: normalizeNonNegativeInt(value?.gathering, 0),
    perception: normalizeNonNegativeInt(value?.perception, 0),
    gp: normalizeNonNegativeInt(value?.gp, 0),
  };
}

function statSum(values) {
  return (
    normalizeNonNegativeInt(values?.gathering, 0) +
    normalizeNonNegativeInt(values?.perception, 0) +
    normalizeNonNegativeInt(values?.gp, 0)
  );
}

function addStats(left, right) {
  return {
    gathering: normalizeNonNegativeInt(left?.gathering, 0) + normalizeNonNegativeInt(right?.gathering, 0),
    perception: normalizeNonNegativeInt(left?.perception, 0) + normalizeNonNegativeInt(right?.perception, 0),
    gp: normalizeNonNegativeInt(left?.gp, 0) + normalizeNonNegativeInt(right?.gp, 0),
  };
}

function makePlanId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `plan-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
}

function clampPlans(plans) {
  if (!Array.isArray(plans)) {
    return [];
  }
  return [...plans]
    .sort((left, right) => String(right?.savedAt ?? "").localeCompare(String(left?.savedAt ?? "")))
    .slice(0, MAX_SAVED_PLANS);
}

function saveLocalStorageRaw(value) {
  if (typeof window === "undefined" || !window.localStorage) {
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch (error) {
    console.error("Unable to write saved plans to localStorage.", error);
  }
}

function loadLocalStorageRaw() {
  if (typeof window === "undefined" || !window.localStorage) {
    return null;
  }
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch (error) {
    console.error("Unable to read saved plans from localStorage.", error);
    return null;
  }
}

function normalizeGrade(grade) {
  const parsed = normalizeInt(grade, 0);
  if (parsed < 1) {
    return 1;
  }
  return Math.min(parsed, 12);
}

function normalizeStatKey(stat) {
  const value = String(stat ?? "").toLowerCase();
  if (STAT_KEYS.includes(value)) {
    return value;
  }
  return "gathering";
}

function normalizeMeld(meld) {
  return {
    slotIndex: normalizeNonNegativeInt(meld?.slotIndex, 0),
    isOvermeld: Boolean(meld?.isOvermeld),
    overmeldIndex: normalizeInt(meld?.overmeldIndex, -1),
    stat: normalizeStatKey(meld?.stat),
    grade: normalizeGrade(meld?.grade),
    itemId: normalizeNonNegativeInt(meld?.itemId, 0),
    name: String(meld?.name ?? ""),
    rawValue: normalizeNonNegativeInt(meld?.rawValue, 0),
    appliedValue: normalizeNonNegativeInt(meld?.appliedValue, 0),
  };
}

function normalizePiece(piece) {
  const melds = Array.isArray(piece?.melds) ? piece.melds.map(normalizeMeld) : [];
  const trackedMeldCaps = {
    gathering: normalizeNonNegativeInt(piece?.trackedMeldCaps?.gathering, 0),
    perception: normalizeNonNegativeInt(piece?.trackedMeldCaps?.perception, 0),
    gp: normalizeNonNegativeInt(piece?.trackedMeldCaps?.gp, 0),
  };
  return {
    pieceId: normalizeNonNegativeInt(piece?.pieceId, 0),
    slot: String(piece?.slot ?? ""),
    pieceName: String(piece?.pieceName ?? "Unknown piece"),
    maxMateriaSlots: normalizeNonNegativeInt(piece?.maxMateriaSlots, 0),
    trackedMeldCaps,
    melds,
  };
}

function normalizeFood(food) {
  if (!food) {
    return null;
  }
  return {
    itemId: normalizeNonNegativeInt(food.itemId, 0),
    name: String(food.name ?? "No food"),
    useHq: Boolean(food.useHq),
    delta: cloneStats(food.delta),
  };
}

function normalizeSavedPlan(plan) {
  const pieceMelds = Array.isArray(plan?.pieceMelds) ? plan.pieceMelds.map(normalizePiece) : [];
  const food = normalizeFood(plan?.food);
  const baseTotalsWithoutMeldsAndFood = cloneStats(plan?.baseTotalsWithoutMeldsAndFood);
  return {
    id: String(plan?.id ?? makePlanId()),
    name: String(plan?.name ?? "Saved plan"),
    savedAt: String(plan?.savedAt ?? new Date().toISOString()),
    score: normalizeInt(plan?.score, 0),
    totalGathering: normalizeNonNegativeInt(plan?.totalGathering, 0),
    totalPerception: normalizeNonNegativeInt(plan?.totalPerception, 0),
    totalGp: normalizeNonNegativeInt(plan?.totalGp, 0),
    baseTotalsWithoutMeldsAndFood,
    food,
    pieceMelds,
  };
}

export function loadSavedPlans() {
  const raw = loadLocalStorageRaw();
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    const normalized = Array.isArray(parsed) ? parsed.map(normalizeSavedPlan) : [];
    return clampPlans(normalized);
  } catch (error) {
    console.error("Unable to parse saved plans from localStorage.", error);
    return [];
  }
}

export function persistSavedPlans(plans) {
  const clamped = clampPlans(plans.map(normalizeSavedPlan));
  saveLocalStorageRaw(JSON.stringify(clamped));
  return clamped;
}

function buildGearQueues(selectedGearRows) {
  const rows = Array.isArray(selectedGearRows) ? selectedGearRows : [];
  const queuesByKey = new Map();
  for (const row of rows) {
    const key = `${String(row?.slot ?? "")}|${String(row?.name ?? "")}`;
    if (!queuesByKey.has(key)) {
      queuesByKey.set(key, []);
    }
    queuesByKey.get(key).push(row);
  }
  return queuesByKey;
}

function takeGearRowForPiece(queuesByKey, piece) {
  const key = `${String(piece?.slot ?? "")}|${String(piece?.pieceName ?? "")}`;
  const queue = queuesByKey.get(key);
  if (Array.isArray(queue) && queue.length > 0) {
    return queue.shift();
  }
  return null;
}

function buildDefaultPlanName(resultIndex, planIndex, row, planVariant = null) {
  const totalGathering = normalizeNonNegativeInt(planVariant?.totalGathering ?? row?.totalGathering, 0);
  const totalPerception = normalizeNonNegativeInt(planVariant?.totalPerception ?? row?.totalPerception, 0);
  const totalGp = normalizeNonNegativeInt(planVariant?.totalGp ?? row?.totalGp, 0);
  return `Plan #${resultIndex + 1}.${planIndex + 1} - ${totalGathering}/${totalPerception}/${totalGp}`;
}

function normalizeTrackedCaps(gearRow) {
  return {
    gathering: normalizeNonNegativeInt(gearRow?.tracked_meld_caps?.gathering, 0),
    perception: normalizeNonNegativeInt(gearRow?.tracked_meld_caps?.perception, 0),
    gp: normalizeNonNegativeInt(gearRow?.tracked_meld_caps?.gp, 0),
  };
}

function sumMeldTotalsFromPlanVariant(planVariant) {
  const totals = {
    gathering: 0,
    perception: 0,
    gp: 0,
  };
  const pieces = Array.isArray(planVariant?.pieceMelds) ? planVariant.pieceMelds : [];
  for (const piece of pieces) {
    const melds = Array.isArray(piece?.melds) ? piece.melds : [];
    for (const meld of melds) {
      const statKey = normalizeStatKey(meld?.stat);
      totals[statKey] += normalizeNonNegativeInt(meld?.appliedValue, 0);
    }
  }
  return totals;
}

export function createSavedPlanFromResult({
  resultRow,
  planVariant,
  resultIndex,
  planIndex,
  selectedGearRows,
  customName,
}) {
  const row = resultRow ?? {};
  const plan = planVariant ?? {};
  const food = normalizeFood(plan?.food ?? row.food);
  const foodDelta = cloneStats(food?.delta);
  const totalGathering = normalizeNonNegativeInt(
    plan?.totalGathering ?? row?.totalGathering,
    normalizeNonNegativeInt(row?.totalGathering, 0),
  );
  const totalPerception = normalizeNonNegativeInt(
    plan?.totalPerception ?? row?.totalPerception,
    normalizeNonNegativeInt(row?.totalPerception, 0),
  );
  const totalGp = normalizeNonNegativeInt(
    plan?.totalGp ?? row?.totalGp,
    normalizeNonNegativeInt(row?.totalGp, 0),
  );
  const meldTotalsFromPlan = sumMeldTotalsFromPlanVariant(plan);
  const usePlanMeldTotals = Array.isArray(plan?.pieceMelds);
  const meldTotals = usePlanMeldTotals
    ? meldTotalsFromPlan
    : {
        gathering: normalizeNonNegativeInt(row?.meldGathering, 0),
        perception: normalizeNonNegativeInt(row?.meldPerception, 0),
        gp: normalizeNonNegativeInt(row?.meldGp, 0),
      };
  const baseTotalsWithoutMeldsAndFood = {
    gathering: Math.max(0, totalGathering - meldTotals.gathering - foodDelta.gathering),
    perception: Math.max(0, totalPerception - meldTotals.perception - foodDelta.perception),
    gp: Math.max(0, totalGp - meldTotals.gp - foodDelta.gp),
  };

  const queuesByKey = buildGearQueues(selectedGearRows);
  const pieceMelds = Array.isArray(plan?.pieceMelds)
    ? plan.pieceMelds.map((piece) => {
        const gearRow = takeGearRowForPiece(queuesByKey, piece);
        const normalizedPiece = normalizePiece(piece);
        return {
          ...normalizedPiece,
          pieceId: normalizeNonNegativeInt(gearRow?.id ?? normalizedPiece.pieceId, normalizedPiece.pieceId),
          trackedMeldCaps: normalizeTrackedCaps(gearRow),
        };
      })
    : [];

  return normalizeSavedPlan({
    id: makePlanId(),
    name: String(customName || buildDefaultPlanName(resultIndex, planIndex, row, plan)),
    savedAt: new Date().toISOString(),
    score: normalizeInt(row?.score, 0),
    totalGathering,
    totalPerception,
    totalGp,
    baseTotalsWithoutMeldsAndFood,
    food,
    pieceMelds,
  });
}

export function buildMateriaGradeValueIndex(materiaRows) {
  const rows = Array.isArray(materiaRows) ? materiaRows : [];
  const index = {
    gathering: new Map(),
    perception: new Map(),
    gp: new Map(),
  };
  for (const row of rows) {
    const stat = normalizeStatKey(row?.stat);
    const grade = normalizeGrade(row?.grade);
    const value = normalizeNonNegativeInt(row?.value, 0);
    const existing = index[stat].get(grade) ?? 0;
    if (value > existing) {
      index[stat].set(grade, value);
    }
  }
  return index;
}

export function buildAvailableGradesByStat(materiaRows) {
  const index = buildMateriaGradeValueIndex(materiaRows);
  return {
    gathering: Array.from(index.gathering.keys()).sort((a, b) => a - b),
    perception: Array.from(index.perception.keys()).sort((a, b) => a - b),
    gp: Array.from(index.gp.keys()).sort((a, b) => a - b),
  };
}

export function buildOvermeldAllowedGradesByStat(materiaRows) {
  const rows = Array.isArray(materiaRows) ? materiaRows : [];
  const slotGradeSetsByStat = {
    gathering: new Map(),
    perception: new Map(),
    gp: new Map(),
  };

  for (const row of rows) {
    const stat = normalizeStatKey(row?.stat);
    const grade = normalizeGrade(row?.grade);
    const allowedSlots = Array.isArray(row?.overmeld_allowed_slots) ? row.overmeld_allowed_slots : [];
    const rates = Array.isArray(row?.overmeld_rates_nq) ? row.overmeld_rates_nq : [];
    for (const slotRaw of allowedSlots) {
      const overmeldIndex = normalizeInt(slotRaw, -1);
      if (overmeldIndex < 0) {
        continue;
      }
      const rate = Number(rates[overmeldIndex] ?? 0);
      if (!Number.isFinite(rate) || rate <= 0) {
        continue;
      }
      if (!slotGradeSetsByStat[stat].has(overmeldIndex)) {
        slotGradeSetsByStat[stat].set(overmeldIndex, new Set());
      }
      slotGradeSetsByStat[stat].get(overmeldIndex).add(grade);
    }
  }

  const toSortedArrays = (slotMap) => {
    const result = {};
    for (const [overmeldIndex, gradeSet] of slotMap.entries()) {
      result[overmeldIndex] = Array.from(gradeSet).sort((a, b) => a - b);
    }
    return result;
  };

  return {
    gathering: toSortedArrays(slotGradeSetsByStat.gathering),
    perception: toSortedArrays(slotGradeSetsByStat.perception),
    gp: toSortedArrays(slotGradeSetsByStat.gp),
  };
}

function getMateriaRawValue(stat, grade, index) {
  const safeStat = normalizeStatKey(stat);
  const safeGrade = normalizeGrade(grade);
  const value = index?.[safeStat]?.get(safeGrade);
  return normalizeNonNegativeInt(value, 0);
}

function availableGradesForStat(stat, gradeValueIndex) {
  const safeStat = normalizeStatKey(stat);
  return Array.from(gradeValueIndex?.[safeStat]?.keys?.() ?? []).sort((a, b) => a - b);
}

function legalGradesForMeld(stat, meld, gradeValueIndex, overmeldAllowedGradesByStat) {
  const safeStat = normalizeStatKey(stat);
  const allStatGrades = availableGradesForStat(safeStat, gradeValueIndex);
  if (!Boolean(meld?.isOvermeld)) {
    return allStatGrades;
  }

  const overmeldIndex = normalizeInt(meld?.overmeldIndex, -1);
  if (overmeldIndex < 0) {
    return allStatGrades;
  }
  const allowedForSlot = overmeldAllowedGradesByStat?.[safeStat]?.[overmeldIndex];
  if (!Array.isArray(allowedForSlot) || allowedForSlot.length === 0) {
    return allStatGrades;
  }
  const allowedSet = new Set(allowedForSlot.map((grade) => normalizeGrade(grade)));
  const filtered = allStatGrades.filter((grade) => allowedSet.has(normalizeGrade(grade)));
  return filtered.length > 0 ? filtered : allStatGrades;
}

function revalidatePieceMelds(piece, gradeValueIndex, overmeldAllowedGradesByStat) {
  const caps = cloneStats(piece?.trackedMeldCaps);
  const used = emptyStats();
  const melds = Array.isArray(piece?.melds) ? piece.melds : [];
  const normalizedMelds = melds.map((meld) => {
    const stat = normalizeStatKey(meld?.stat);
    const requestedGrade = normalizeGrade(meld?.grade);
    const legalGrades = legalGradesForMeld(stat, meld, gradeValueIndex, overmeldAllowedGradesByStat);
    const grade = legalGrades.includes(requestedGrade)
      ? requestedGrade
      : normalizeGrade(legalGrades[legalGrades.length - 1] ?? requestedGrade);
    const rawValue = getMateriaRawValue(stat, grade, gradeValueIndex);
    const cap = normalizeNonNegativeInt(caps[stat], 0);
    const remaining = cap > 0 ? Math.max(0, cap - used[stat]) : rawValue;
    const appliedValue = cap > 0 ? Math.min(rawValue, remaining) : rawValue;
    used[stat] += appliedValue;
    return {
      ...normalizeMeld(meld),
      stat,
      grade,
      rawValue,
      appliedValue,
    };
  });

  return {
    ...normalizePiece(piece),
    melds: normalizedMelds,
  };
}

function sumMeldTotals(pieceMelds) {
  return (Array.isArray(pieceMelds) ? pieceMelds : []).reduce((totals, piece) => {
    const melds = Array.isArray(piece?.melds) ? piece.melds : [];
    for (const meld of melds) {
      const stat = normalizeStatKey(meld?.stat);
      totals[stat] += normalizeNonNegativeInt(meld?.appliedValue, 0);
    }
    return totals;
  }, emptyStats());
}

function computeFoodDeltaForTotals(totals, foodRow, useHq) {
  const deltas = emptyStats();
  if (!foodRow || !Array.isArray(foodRow.effects)) {
    return deltas;
  }

  for (const effect of foodRow.effects) {
    const statKey = normalizeStatKey(effect?.stat);
    if (!STAT_KEYS.includes(statKey)) {
      continue;
    }

    const value = useHq && foodRow.can_be_hq ? Number(effect?.hq_value) || 0 : Number(effect?.nq_value) || 0;
    const maxCap = useHq && foodRow.can_be_hq ? Number(effect?.hq_max) || 0 : Number(effect?.nq_max) || 0;
    const baseStat = normalizeNonNegativeInt(totals?.[statKey], 0);
    const isRelative = Boolean(effect?.is_relative);
    let delta = isRelative ? Math.floor((baseStat * value) / 100) : value;
    if (maxCap > 0) {
      delta = Math.min(delta, maxCap);
    }
    deltas[statKey] += Math.max(0, delta);
  }
  return deltas;
}

function buildDraftFood(basePlan, draft, foodRows, totalsWithoutFood) {
  const fallbackItemId = normalizeNonNegativeInt(basePlan?.food?.itemId, 0);
  const draftItemId = normalizeNonNegativeInt(draft?.foodItemId, fallbackItemId);
  if (draftItemId === 0) {
    return null;
  }

  const rows = Array.isArray(foodRows) ? foodRows : [];
  const row = rows.find((foodRow) => normalizeNonNegativeInt(foodRow?.item_id, 0) === draftItemId);
  if (!row) {
    return normalizeFood(basePlan?.food);
  }

  const requestedUseHq = draft?.foodUseHq == null ? Boolean(basePlan?.food?.useHq) : Boolean(draft.foodUseHq);
  const useHq = Boolean(requestedUseHq && row.can_be_hq);
  const delta = computeFoodDeltaForTotals(totalsWithoutFood, row, useHq);
  return normalizeFood({
    itemId: normalizeNonNegativeInt(row?.item_id, 0),
    name: String(row?.name ?? "No food"),
    useHq,
    delta,
  });
}

export function applyDraftToSavedPlan(plan, draft, gradeValueIndex, options = {}) {
  const basePlan = normalizeSavedPlan(plan);
  const sourcePieceMelds = Array.isArray(draft?.pieceMelds) ? draft.pieceMelds : basePlan.pieceMelds;
  const pieceMelds = sourcePieceMelds.map((piece) =>
    revalidatePieceMelds(piece, gradeValueIndex, options?.overmeldAllowedGradesByStat),
  );
  const meldTotals = sumMeldTotals(pieceMelds);
  const totalsWithoutFood = addStats(basePlan.baseTotalsWithoutMeldsAndFood, meldTotals);
  const food = buildDraftFood(basePlan, draft, options?.foodRows, totalsWithoutFood);
  const totalStats = addStats(totalsWithoutFood, cloneStats(food?.delta));
  const name = String(draft?.name ?? basePlan.name).trim() || basePlan.name;

  return {
    plan: {
      ...basePlan,
      name,
      food,
      pieceMelds,
      totalGathering: totalStats.gathering,
      totalPerception: totalStats.perception,
      totalGp: totalStats.gp,
    },
    meldTotals,
    totalStats,
  };
}

export function createDraftFromSavedPlan(plan) {
  const normalized = normalizeSavedPlan(plan);
  return {
    name: normalized.name,
    foodItemId: normalizeNonNegativeInt(normalized?.food?.itemId, 0),
    foodUseHq: Boolean(normalized?.food?.useHq),
    pieceMelds: normalized.pieceMelds.map((piece) => ({
      ...piece,
      melds: piece.melds.map((meld) => ({
        ...meld,
      })),
    })),
  };
}

export function exportSavedPlanText(plan) {
  const savedPlan = normalizeSavedPlan(plan);
  const lines = [];
  lines.push(`${savedPlan.name}`);
  lines.push(`Saved: ${savedPlan.savedAt}`);
  lines.push(
    `Totals: G ${savedPlan.totalGathering} | P ${savedPlan.totalPerception} | GP ${savedPlan.totalGp}`,
  );
  if (savedPlan.food) {
    const quality = savedPlan.food.useHq ? "HQ" : "NQ";
    lines.push(
      `Food: ${savedPlan.food.name} [${quality}] (+G${savedPlan.food.delta.gathering} +P${savedPlan.food.delta.perception} +GP${savedPlan.food.delta.gp})`,
    );
  }
  lines.push("");

  for (const piece of savedPlan.pieceMelds) {
    lines.push(`${piece.slot}: ${piece.pieceName}`);
    const melds = Array.isArray(piece.melds) ? piece.melds : [];
    if (melds.length === 0) {
      lines.push("  - no melds");
      continue;
    }
    for (const meld of melds) {
      const statLabel = STAT_DISPLAY[normalizeStatKey(meld.stat)] ?? normalizeStatKey(meld.stat);
      const grade = normalizeGrade(meld.grade);
      const gradeRoman = GRADE_ROMAN[grade] || String(grade);
      const applied = normalizeNonNegativeInt(meld.appliedValue, 0);
      const raw = normalizeNonNegativeInt(meld.rawValue, 0);
      const rawSuffix = raw !== applied ? ` (raw +${raw})` : "";
      lines.push(`  - ${statLabel} +${applied} (${gradeRoman})${rawSuffix}`);
    }
  }

  return lines.join("\n");
}

export function getSavedPlansStorageKey() {
  return STORAGE_KEY;
}

export function getMaxSavedPlans() {
  return MAX_SAVED_PLANS;
}

export function countTotalMelds(plan) {
  return (Array.isArray(plan?.pieceMelds) ? plan.pieceMelds : []).reduce((total, piece) => {
    return total + (Array.isArray(piece?.melds) ? piece.melds.length : 0);
  }, 0);
}

export function hasAnyMelds(plan) {
  return countTotalMelds(plan) > 0;
}

export function savedPlanTotals(plan) {
  return {
    gathering: normalizeNonNegativeInt(plan?.totalGathering, 0),
    perception: normalizeNonNegativeInt(plan?.totalPerception, 0),
    gp: normalizeNonNegativeInt(plan?.totalGp, 0),
  };
}

export function formatSavedAt(savedAt) {
  const dt = new Date(savedAt);
  if (Number.isNaN(dt.getTime())) {
    return String(savedAt ?? "");
  }
  return dt.toLocaleString();
}

export function statKeys() {
  return [...STAT_KEYS];
}
