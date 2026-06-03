import { computeFoodDeltaForTotals } from "../utils/food.js";
import { normalizeNonNegativeInteger, normalizeOptionalPriority } from "../utils/normalize.js";
import { STAT_KEYS, summarizeTotals } from "../utils/stats.js";

const ADVANCED_STAT_DUMP = Object.freeze({
  NONE: "none",
  GATHERING: "gathering",
  PERCEPTION: "perception",
  GP: "gp",
  EVEN: "even",
});
const ADVANCED_STAT_DUMP_MODES = new Set(Object.values(ADVANCED_STAT_DUMP));
const UNNUMBERED_PRIORITY_KEY = "__unnumbered__";
const DEFAULT_ADVANCED_VARIANT_LIMIT = 5;

function normalizeAdvancedStatDump(value, fallback = ADVANCED_STAT_DUMP.NONE) {
  const normalizedFallback = ADVANCED_STAT_DUMP_MODES.has(String(fallback ?? "").trim().toLowerCase())
    ? String(fallback).trim().toLowerCase()
    : ADVANCED_STAT_DUMP.NONE;
  const raw = String(value ?? "").trim().toLowerCase();
  if (ADVANCED_STAT_DUMP_MODES.has(raw)) {
    return raw;
  }
  return normalizedFallback;
}

function createDefaultBreakpoint(index = 1) {
  const safeIndex = Math.max(1, normalizeNonNegativeInteger(index, 1));
  return {
    id: `bp_${safeIndex}`,
    name: `Breakpoint ${safeIndex}`,
    stat: "gathering",
    value: 0,
    priority: null,
    enabled: true,
  };
}

function normalizeBreakpoint(raw, fallbackIndex = 1) {
  const fallback = createDefaultBreakpoint(fallbackIndex);
  const rawStat = String(raw?.stat ?? "");
  const stat = STAT_KEYS.includes(rawStat) ? rawStat : fallback.stat;
  return {
    id: String(raw?.id ?? fallback.id),
    name: String(raw?.name ?? fallback.name).trim() || fallback.name,
    stat,
    value: normalizeNonNegativeInteger(raw?.value, 0),
    priority: normalizeOptionalPriority(raw?.priority),
    enabled: raw?.enabled !== false,
  };
}

function buildNoFoodOption() {
  return {
    itemId: 0,
    name: "No food",
    useHq: false,
    delta: { gathering: 0, perception: 0, gp: 0 },
  };
}

function priorityKey(priority) {
  return priority == null ? UNNUMBERED_PRIORITY_KEY : String(priority);
}

function enabledBreakpoints(profile) {
  const raw = Array.isArray(profile?.breakpoints) ? profile.breakpoints : [];
  return raw
    .map((bp, index) => normalizeBreakpoint(bp, index + 1))
    .filter((bp) => bp.enabled && STAT_KEYS.includes(bp.stat) && bp.value > 0);
}

function breakpointHit(updatedTotals, breakpoint) {
  const stat = String(breakpoint?.stat ?? "");
  const value = normalizeNonNegativeInteger(breakpoint?.value, 0);
  if (!STAT_KEYS.includes(stat) || value === 0) {
    return false;
  }
  return (Number(updatedTotals?.[stat]) || 0) >= value;
}

function buildPriorityLedger(breakpointResults) {
  const rows = Array.isArray(breakpointResults) ? breakpointResults : [];
  const hitByKey = Object.create(null);
  const enabledByKey = Object.create(null);
  const numericLevels = new Set();

  for (const row of rows) {
    const priority = normalizeOptionalPriority(row?.priority);
    const key = priorityKey(priority);
    enabledByKey[key] = (enabledByKey[key] ?? 0) + 1;
    if (row?.hit) {
      hitByKey[key] = (hitByKey[key] ?? 0) + 1;
    }
    if (priority != null) {
      numericLevels.add(priority);
    }
  }

  return {
    orderedNumericLevels: Array.from(numericLevels).sort((left, right) => right - left),
    hitByKey,
    enabledByKey,
  };
}

function comparePriorityLedgers(leftLedger, rightLedger) {
  const leftLevels = Array.isArray(leftLedger?.orderedNumericLevels) ? leftLedger.orderedNumericLevels : [];
  const rightLevels = Array.isArray(rightLedger?.orderedNumericLevels) ? rightLedger.orderedNumericLevels : [];
  const allNumericLevels = Array.from(new Set([...leftLevels, ...rightLevels])).sort((left, right) => right - left);

  for (const level of allNumericLevels) {
    const levelKey = String(level);
    const hitDiff =
      (Number(rightLedger?.hitByKey?.[levelKey]) || 0) -
      (Number(leftLedger?.hitByKey?.[levelKey]) || 0);
    if (hitDiff !== 0) {
      return hitDiff;
    }
  }

  const unnumberedHitDiff =
    (Number(rightLedger?.hitByKey?.[UNNUMBERED_PRIORITY_KEY]) || 0) -
    (Number(leftLedger?.hitByKey?.[UNNUMBERED_PRIORITY_KEY]) || 0);
  if (unnumberedHitDiff !== 0) {
    return unnumberedHitDiff;
  }

  return 0;
}

function mergePriorityLedgers(ledgers) {
  const rows = Array.isArray(ledgers) ? ledgers : [];
  const aggregateHitByKey = Object.create(null);
  const aggregateEnabledByKey = Object.create(null);
  const numericLevels = new Set();

  for (const ledger of rows) {
    const orderedLevels = Array.isArray(ledger?.orderedNumericLevels) ? ledger.orderedNumericLevels : [];
    for (const level of orderedLevels) {
      numericLevels.add(level);
      const key = String(level);
      aggregateHitByKey[key] = (aggregateHitByKey[key] ?? 0) + (Number(ledger?.hitByKey?.[key]) || 0);
      aggregateEnabledByKey[key] = (aggregateEnabledByKey[key] ?? 0) + (Number(ledger?.enabledByKey?.[key]) || 0);
    }

    aggregateHitByKey[UNNUMBERED_PRIORITY_KEY] =
      (aggregateHitByKey[UNNUMBERED_PRIORITY_KEY] ?? 0) +
      (Number(ledger?.hitByKey?.[UNNUMBERED_PRIORITY_KEY]) || 0);
    aggregateEnabledByKey[UNNUMBERED_PRIORITY_KEY] =
      (aggregateEnabledByKey[UNNUMBERED_PRIORITY_KEY] ?? 0) +
      (Number(ledger?.enabledByKey?.[UNNUMBERED_PRIORITY_KEY]) || 0);
  }

  return {
    orderedNumericLevels: Array.from(numericLevels).sort((left, right) => right - left),
    hitByKey: aggregateHitByKey,
    enabledByKey: aggregateEnabledByKey,
  };
}

function highestBreakpointTargetsByStat(profile, breakpoints = null) {
  const targets = {
    gathering: 0,
    perception: 0,
    gp: 0,
  };
  const rows = Array.isArray(breakpoints) ? breakpoints : enabledBreakpoints(profile);
  for (const breakpoint of rows) {
    const stat = String(breakpoint?.stat ?? "");
    if (!STAT_KEYS.includes(stat)) {
      continue;
    }
    targets[stat] = Math.max(targets[stat], normalizeNonNegativeInteger(breakpoint?.value, 0));
  }
  return targets;
}

function computeStatDumpSurplus(updatedTotals, breakpointTargets) {
  const gathering = Math.max(
    0,
    normalizeNonNegativeInteger(updatedTotals?.gathering, 0) -
      normalizeNonNegativeInteger(breakpointTargets?.gathering, 0),
  );
  const perception = Math.max(
    0,
    normalizeNonNegativeInteger(updatedTotals?.perception, 0) -
      normalizeNonNegativeInteger(breakpointTargets?.perception, 0),
  );
  const gp = Math.max(
    0,
    normalizeNonNegativeInteger(updatedTotals?.gp, 0) -
      normalizeNonNegativeInteger(breakpointTargets?.gp, 0),
  );
  const total = gathering + perception + gp;
  const min = Math.min(gathering, perception, gp);
  const max = Math.max(gathering, perception, gp);
  const spread = max - min;
  return {
    gathering,
    perception,
    gp,
    total,
    min,
    max,
    spread,
  };
}

function statDumpPreferenceScore(statDump, surplus) {
  const mode = normalizeAdvancedStatDump(statDump, ADVANCED_STAT_DUMP.NONE);
  const safe = {
    gathering: normalizeNonNegativeInteger(surplus?.gathering, 0),
    perception: normalizeNonNegativeInteger(surplus?.perception, 0),
    gp: normalizeNonNegativeInteger(surplus?.gp, 0),
    total: normalizeNonNegativeInteger(surplus?.total, 0),
    min: normalizeNonNegativeInteger(surplus?.min, 0),
    spread: normalizeNonNegativeInteger(surplus?.spread, 0),
  };
  if (mode === ADVANCED_STAT_DUMP.GATHERING) {
    return safe.gathering * 1_000_000 + safe.total * 1_000 + safe.min;
  }
  if (mode === ADVANCED_STAT_DUMP.PERCEPTION) {
    return safe.perception * 1_000_000 + safe.total * 1_000 + safe.min;
  }
  if (mode === ADVANCED_STAT_DUMP.GP) {
    return safe.gp * 1_000_000 + safe.total * 1_000 + safe.min;
  }
  if (mode === ADVANCED_STAT_DUMP.NONE) {
    return 0;
  }
  return safe.min * 1_000_000 - safe.spread * 1_000 + safe.total;
}

function compareStatDumpPreference(leftOption, rightOption, statDump) {
  const mode = normalizeAdvancedStatDump(statDump, ADVANCED_STAT_DUMP.NONE);
  if (mode === ADVANCED_STAT_DUMP.NONE) {
    return 0;
  }
  const leftSurplus = leftOption?.statDumpSurplus ?? {};
  const rightSurplus = rightOption?.statDumpSurplus ?? {};
  const scoreDiff =
    (Number(rightOption?.statDumpPreferenceScore) || 0) -
    (Number(leftOption?.statDumpPreferenceScore) || 0);
  if (scoreDiff !== 0) {
    return scoreDiff;
  }

  if (mode === ADVANCED_STAT_DUMP.GATHERING) {
    const targetDiff = (Number(rightSurplus?.gathering) || 0) - (Number(leftSurplus?.gathering) || 0);
    if (targetDiff !== 0) {
      return targetDiff;
    }
  } else if (mode === ADVANCED_STAT_DUMP.PERCEPTION) {
    const targetDiff = (Number(rightSurplus?.perception) || 0) - (Number(leftSurplus?.perception) || 0);
    if (targetDiff !== 0) {
      return targetDiff;
    }
  } else if (mode === ADVANCED_STAT_DUMP.GP) {
    const targetDiff = (Number(rightSurplus?.gp) || 0) - (Number(leftSurplus?.gp) || 0);
    if (targetDiff !== 0) {
      return targetDiff;
    }
  } else {
    const minDiff = (Number(rightSurplus?.min) || 0) - (Number(leftSurplus?.min) || 0);
    if (minDiff !== 0) {
      return minDiff;
    }
    const spreadDiff = (Number(leftSurplus?.spread) || 0) - (Number(rightSurplus?.spread) || 0);
    if (spreadDiff !== 0) {
      return spreadDiff;
    }
  }

  return (Number(rightSurplus?.total) || 0) - (Number(leftSurplus?.total) || 0);
}

function compareProfileFoodOptions(left, right, profile) {
  const priorityDiff = comparePriorityLedgers(left?.priorityLedger, right?.priorityLedger);
  if (priorityDiff !== 0) {
    return priorityDiff;
  }
  const hitDiff = (Number(right?.hitCount) || 0) - (Number(left?.hitCount) || 0);
  if (hitDiff !== 0) {
    return hitDiff;
  }
  const dumpDiff = compareStatDumpPreference(left, right, profile?.statDump);
  if (dumpDiff !== 0) {
    return dumpDiff;
  }
  const sumDiff = (Number(right?.statSum) || 0) - (Number(left?.statSum) || 0);
  if (sumDiff !== 0) {
    return sumDiff;
  }
  const gatheringDiff =
    normalizeNonNegativeInteger(right?.updatedTotals?.gathering, 0) -
    normalizeNonNegativeInteger(left?.updatedTotals?.gathering, 0);
  if (gatheringDiff !== 0) {
    return gatheringDiff;
  }
  const perceptionDiff =
    normalizeNonNegativeInteger(right?.updatedTotals?.perception, 0) -
    normalizeNonNegativeInteger(left?.updatedTotals?.perception, 0);
  if (perceptionDiff !== 0) {
    return perceptionDiff;
  }
  const gpDiff =
    normalizeNonNegativeInteger(right?.updatedTotals?.gp, 0) -
    normalizeNonNegativeInteger(left?.updatedTotals?.gp, 0);
  if (gpDiff !== 0) {
    return gpDiff;
  }
  return normalizeNonNegativeInteger(left?.food?.itemId, 0) - normalizeNonNegativeInteger(right?.food?.itemId, 0);
}

function foodRowByItemId(foodRows, itemId) {
  const safeItemId = normalizeNonNegativeInteger(itemId, 0);
  if (safeItemId <= 0) {
    return null;
  }
  const rows = Array.isArray(foodRows) ? foodRows : [];
  return rows.find((row) => normalizeNonNegativeInteger(row?.item_id, 0) === safeItemId) ?? null;
}

function allowedFoodRowsForProfile(profile, foodRows) {
  const rows = Array.isArray(foodRows) ? foodRows : [];
  const allowedIds = new Set(
    (Array.isArray(profile?.allowedFoodIds) ? profile.allowedFoodIds : [])
      .map((itemId) => normalizeNonNegativeInteger(itemId, 0))
      .filter((itemId) => itemId > 0),
  );
  if (allowedIds.size === 0) {
    return [];
  }
  return rows.filter((row) => allowedIds.has(normalizeNonNegativeInteger(row?.item_id, 0)));
}

function buildProfileFoodOption(baseTotals, profile, foodRow) {
  const useHq = Boolean(profile?.useHq && foodRow?.can_be_hq);
  const delta = computeFoodDeltaForTotals(baseTotals, foodRow, useHq);
  const updatedTotals = {
    gathering: (Number(baseTotals?.gathering) || 0) + delta.gathering,
    perception: (Number(baseTotals?.perception) || 0) + delta.perception,
    gp: (Number(baseTotals?.gp) || 0) + delta.gp,
  };
  const breakpoints = enabledBreakpoints(profile);
  const breakpointTargets = highestBreakpointTargetsByStat(profile, breakpoints);
  const breakpointResults = breakpoints.map((breakpoint) => ({
    ...breakpoint,
    hit: breakpointHit(updatedTotals, breakpoint),
  }));
  const priorityLedger = buildPriorityLedger(breakpointResults);
  const statDump = normalizeAdvancedStatDump(profile?.statDump, ADVANCED_STAT_DUMP.NONE);
  const statDumpSurplus = computeStatDumpSurplus(updatedTotals, breakpointTargets);
  const hitCount = breakpointResults.reduce((count, row) => count + (row.hit ? 1 : 0), 0);
  const statSum =
    normalizeNonNegativeInteger(updatedTotals.gathering, 0) +
    normalizeNonNegativeInteger(updatedTotals.perception, 0) +
    normalizeNonNegativeInteger(updatedTotals.gp, 0);

  return {
    hitCount,
    enabledCount: breakpointResults.length,
    statSum,
    statDump,
    breakpointTargets,
    statDumpSurplus,
    statDumpPreferenceScore: statDumpPreferenceScore(statDump, statDumpSurplus),
    updatedTotals,
    priorityLedger,
    breakpointResults,
    food: foodRow
      ? {
          itemId: normalizeNonNegativeInteger(foodRow?.item_id, 0),
          name: String(foodRow?.name ?? "No food"),
          useHq,
          delta,
        }
      : buildNoFoodOption(),
  };
}

function evaluateProfileForTotals(baseTotals, profile, foodRows) {
  const candidateRows = allowedFoodRowsForProfile(profile, foodRows);
  const options =
    candidateRows.length > 0
      ? candidateRows.map((foodRow) => buildProfileFoodOption(baseTotals, profile, foodRow))
      : [buildProfileFoodOption(baseTotals, profile, null)];

  options.sort((left, right) => compareProfileFoodOptions(left, right, profile));

  const top = options[0];
  const bestOptions = options.filter(
    (candidate) =>
      compareProfileFoodOptions(candidate, top, profile) === 0 &&
      (Number(candidate?.statDumpPreferenceScore) || 0) === (Number(top?.statDumpPreferenceScore) || 0) &&
      normalizeNonNegativeInteger(candidate?.statSum, 0) === normalizeNonNegativeInteger(top?.statSum, 0),
  );

  return {
    profileName: String(profile?.name ?? "Profile"),
    profileId: String(profile?.id ?? ""),
    statDump: normalizeAdvancedStatDump(profile?.statDump, ADVANCED_STAT_DUMP.NONE),
    useHq: profile?.useHq !== false,
    bestOption: top,
    bestOptions,
  };
}

function cloneAdvancedProfileSummary(profileSummary) {
  const best = profileSummary?.bestOption;
  return {
    profileName: String(profileSummary?.profileName ?? "Profile"),
    profileId: String(profileSummary?.profileId ?? ""),
    statDump: normalizeAdvancedStatDump(profileSummary?.statDump, ADVANCED_STAT_DUMP.NONE),
    enabledBreakpoints: normalizeNonNegativeInteger(best?.enabledCount, 0),
    breakpointsMet: normalizeNonNegativeInteger(best?.hitCount, 0),
    totals: summarizeTotals(best?.updatedTotals),
    food: best?.food ?? buildNoFoodOption(),
    breakpointResults: Array.isArray(best?.breakpointResults)
      ? best.breakpointResults.map((entry) => ({
          id: String(entry?.id ?? ""),
          name: String(entry?.name ?? "Breakpoint"),
          stat: STAT_KEYS.includes(String(entry?.stat ?? "")) ? String(entry.stat) : "gathering",
          value: normalizeNonNegativeInteger(entry?.value, 0),
          priority: normalizeOptionalPriority(entry?.priority),
          hit: Boolean(entry?.hit),
        }))
      : [],
  };
}

export function compareAdvancedSummaries(left, right) {
  const priorityDiff = comparePriorityLedgers(left?.priorityLedger, right?.priorityLedger);
  if (priorityDiff !== 0) {
    return priorityDiff;
  }
  const hitDiff =
    normalizeNonNegativeInteger(right?.breakpointsMet, 0) -
    normalizeNonNegativeInteger(left?.breakpointsMet, 0);
  if (hitDiff !== 0) {
    return hitDiff;
  }
  const enabledDiff =
    normalizeNonNegativeInteger(right?.breakpointsEnabled, 0) -
    normalizeNonNegativeInteger(left?.breakpointsEnabled, 0);
  if (enabledDiff !== 0) {
    return enabledDiff;
  }
  const dumpDiff = (Number(right?.dumpPreferenceScore) || 0) - (Number(left?.dumpPreferenceScore) || 0);
  if (dumpDiff !== 0) {
    return dumpDiff;
  }
  const sumDiff =
    normalizeNonNegativeInteger(right?.tiebreakStatSum, 0) -
    normalizeNonNegativeInteger(left?.tiebreakStatSum, 0);
  if (sumDiff !== 0) {
    return sumDiff;
  }
  return 0;
}

export function compareAdvancedBreakpointSummaries(left, right) {
  const priorityDiff = comparePriorityLedgers(left?.priorityLedger, right?.priorityLedger);
  if (priorityDiff !== 0) {
    return priorityDiff;
  }
  return (
    normalizeNonNegativeInteger(right?.breakpointsMet, 0) -
    normalizeNonNegativeInteger(left?.breakpointsMet, 0)
  );
}

function buildAdvancedSummaryFromProfileEvaluations(profileEvaluations) {
  const rows = Array.isArray(profileEvaluations) ? profileEvaluations : [];
  const scoringProfiles = rows.filter(
    (profileEval) => normalizeNonNegativeInteger(profileEval?.bestOption?.enabledCount, 0) > 0,
  );
  const breakpointsEnabled = scoringProfiles.reduce(
    (sum, profileEval) => sum + normalizeNonNegativeInteger(profileEval?.bestOption?.enabledCount, 0),
    0,
  );
  const breakpointsMet = scoringProfiles.reduce(
    (sum, profileEval) => sum + normalizeNonNegativeInteger(profileEval?.bestOption?.hitCount, 0),
    0,
  );
  const priorityLedger = mergePriorityLedgers(
    scoringProfiles.map((profileEval) => profileEval?.bestOption?.priorityLedger),
  );
  const dumpPreferenceScore = scoringProfiles.reduce(
    (sum, profileEval) => sum + (Number(profileEval?.bestOption?.statDumpPreferenceScore) || 0),
    0,
  );
  const tiebreakStatSum = scoringProfiles.reduce(
    (sum, profileEval) => sum + normalizeNonNegativeInteger(profileEval?.bestOption?.statSum, 0),
    0,
  );

  return {
    breakpointsEnabled,
    breakpointsMet,
    priorityLedger,
    dumpPreferenceScore,
    tiebreakStatSum,
  };
}

export function selectActiveAdvancedProfiles(advancedProfiles) {
  const profiles = Array.isArray(advancedProfiles) ? advancedProfiles : [];
  return profiles.filter((profile) => profile?.enabled !== false);
}

export function buildAdvancedSummaryForTotals(baseTotals, options = {}) {
  const safeTotals = summarizeTotals(baseTotals);
  const profiles = selectActiveAdvancedProfiles(options?.advancedProfiles);
  const profileEvaluations = profiles.map((profile) =>
    evaluateProfileForTotals(safeTotals, profile, options?.foodRows),
  );
  return buildAdvancedSummaryFromProfileEvaluations(profileEvaluations);
}

function sumSavedPlanMeldTotals(savedPlan) {
  const totals = {
    gathering: 0,
    perception: 0,
    gp: 0,
  };
  const pieces = Array.isArray(savedPlan?.pieceMelds) ? savedPlan.pieceMelds : [];
  for (const piece of pieces) {
    const melds = Array.isArray(piece?.melds) ? piece.melds : [];
    for (const meld of melds) {
      const statKey = String(meld?.stat ?? "").toLowerCase();
      if (!STAT_KEYS.includes(statKey)) {
        continue;
      }
      totals[statKey] += normalizeNonNegativeInteger(meld?.appliedValue, 0);
    }
  }
  return totals;
}

function savedPlanTotals(savedPlan) {
  return summarizeTotals({
    gathering: savedPlan?.totalGathering,
    perception: savedPlan?.totalPerception,
    gp: savedPlan?.totalGp,
  });
}

export function savedPlanTotalsWithoutFood(savedPlan) {
  const base = summarizeTotals(savedPlan?.baseTotalsWithoutMeldsAndFood);
  const meldTotals = sumSavedPlanMeldTotals(savedPlan);
  const computedFromParts = summarizeTotals({
    gathering: base.gathering + meldTotals.gathering,
    perception: base.perception + meldTotals.perception,
    gp: base.gp + meldTotals.gp,
  });
  const hasBaseParts = computedFromParts.gathering + computedFromParts.perception + computedFromParts.gp > 0;
  if (hasBaseParts) {
    return computedFromParts;
  }

  const fallbackTotals = savedPlanTotals(savedPlan);
  const fallbackFoodDelta = summarizeTotals(savedPlan?.food?.delta);
  return summarizeTotals({
    gathering: Math.max(0, fallbackTotals.gathering - fallbackFoodDelta.gathering),
    perception: Math.max(0, fallbackTotals.perception - fallbackFoodDelta.perception),
    gp: Math.max(0, fallbackTotals.gp - fallbackFoodDelta.gp),
  });
}

export function normalizeSavedPlanBreakpointFoodDraftEntry(entry, profile, fallbackFood, foodRows) {
  const requestedFoodItemId = normalizeNonNegativeInteger(
    entry?.foodItemId,
    normalizeNonNegativeInteger(fallbackFood?.itemId, 0),
  );
  const selectedFoodRow = foodRowByItemId(foodRows, requestedFoodItemId);
  const useHqDefault =
    entry?.useHq == null ? Boolean(fallbackFood?.useHq ?? profile?.useHq !== false) : Boolean(entry.useHq);
  const useHq = Boolean(useHqDefault && selectedFoodRow?.can_be_hq);
  return {
    foodItemId: selectedFoodRow ? normalizeNonNegativeInteger(selectedFoodRow?.item_id, 0) : 0,
    useHq,
  };
}

export function evaluateSavedPlanBreakpointCheck(savedPlan, foodDraftByProfileId, options = {}) {
  const baseTotals = savedPlanTotalsWithoutFood(savedPlan);
  const profiles = selectActiveAdvancedProfiles(options?.advancedProfiles);
  const perProfileDraft =
    foodDraftByProfileId && typeof foodDraftByProfileId === "object" ? foodDraftByProfileId : {};

  const profileEvaluations = profiles.map((profile) => {
    const profileId = String(profile?.id ?? "");
    const selectedDraft = normalizeSavedPlanBreakpointFoodDraftEntry(
      perProfileDraft[profileId],
      profile,
      savedPlan?.food,
      options?.foodRows,
    );
    const selectedFoodRow = foodRowByItemId(options?.foodRows, selectedDraft.foodItemId);
    const option = buildProfileFoodOption(
      baseTotals,
      {
        ...profile,
        useHq: selectedDraft.useHq,
      },
      selectedFoodRow,
    );
    return {
      profileName: String(profile?.name ?? "Profile"),
      profileId,
      statDump: normalizeAdvancedStatDump(profile?.statDump, ADVANCED_STAT_DUMP.NONE),
      useHq: selectedDraft.useHq,
      bestOption: option,
      bestOptions: [option],
      selectedFood: selectedDraft,
    };
  });

  const summary = buildAdvancedSummaryFromProfileEvaluations(profileEvaluations);
  return {
    breakpointsEnabled: summary.breakpointsEnabled,
    breakpointsMet: summary.breakpointsMet,
    priorityLedger: summary.priorityLedger,
    dumpPreferenceScore: summary.dumpPreferenceScore,
    tiebreakStatSum: summary.tiebreakStatSum,
    baseTotals,
    profiles: profileEvaluations.map((profileEval) => cloneAdvancedProfileSummary(profileEval)),
    foodDraftByProfileId: Object.fromEntries(
      profileEvaluations.map((profileEval) => [
        String(profileEval?.profileId ?? ""),
        { ...profileEval.selectedFood },
      ]),
    ),
  };
}

function advancedBreakpointPatternKeyFromProfiles(profiles) {
  const rows = Array.isArray(profiles) ? profiles : [];
  return rows
    .map((profile, profileIndex) => {
      const profileId = String(profile?.profileId ?? `profile_${profileIndex + 1}`);
      const breakpointRows = Array.isArray(profile?.breakpointResults) ? profile.breakpointResults : [];
      const breakpointToken = breakpointRows
        .map((entry, breakpointIndex) => {
          const breakpointId = String(entry?.id ?? `bp_${breakpointIndex + 1}`);
          return `${breakpointId}:${entry?.hit === true ? 1 : 0}`;
        })
        .join(",");
      return `${profileId}[${breakpointToken}]`;
    })
    .join("||");
}

function advancedBreakpointPatternKeyForRow(row) {
  return advancedBreakpointPatternKeyFromProfiles(row?.advanced?.profiles);
}

function advancedRowTotalKey(row) {
  const totals = summarizeTotals({
    gathering: row?.totalGathering,
    perception: row?.totalPerception,
    gp: row?.totalGp,
  });
  return `${totals.gathering}|${totals.perception}|${totals.gp}`;
}

function compareAdvancedRows(left, right) {
  const advancedDiff = compareAdvancedSummaries(left?.advanced, right?.advanced);
  if (advancedDiff !== 0) {
    return advancedDiff;
  }
  const scoreDiff = (Number(right?.score) || 0) - (Number(left?.score) || 0);
  if (scoreDiff !== 0) {
    return scoreDiff;
  }
  const totalDiff =
    normalizeNonNegativeInteger(right?.totalGathering, 0) +
    normalizeNonNegativeInteger(right?.totalPerception, 0) +
    normalizeNonNegativeInteger(right?.totalGp, 0) -
    (normalizeNonNegativeInteger(left?.totalGathering, 0) +
      normalizeNonNegativeInteger(left?.totalPerception, 0) +
      normalizeNonNegativeInteger(left?.totalGp, 0));
  if (totalDiff !== 0) {
    return totalDiff;
  }
  return 0;
}

function planAdjustmentCount(plan) {
  const count = Number(plan?.adjustmentDiff?.count);
  return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : Number.POSITIVE_INFINITY;
}

function bestAdjustmentCountForPlans(plans) {
  const rows = Array.isArray(plans) ? plans : [];
  return rows.reduce((best, plan) => Math.min(best, planAdjustmentCount(plan)), Number.POSITIVE_INFINITY);
}

function rowAdjustmentCount(row) {
  const direct = Number(row?.bestAdjustmentCount);
  if (Number.isFinite(direct)) {
    return Math.max(0, Math.floor(direct));
  }
  return bestAdjustmentCountForPlans(row?.plans);
}

function compareAdvancedRowsForRefine(left, right) {
  const breakpointDiff = compareAdvancedBreakpointSummaries(left?.advanced, right?.advanced);
  if (breakpointDiff !== 0) {
    return breakpointDiff;
  }
  const scoreDiff = (Number(right?.score) || 0) - (Number(left?.score) || 0);
  if (scoreDiff !== 0) {
    return scoreDiff;
  }

  const leftAdjustment = rowAdjustmentCount(left);
  const rightAdjustment = rowAdjustmentCount(right);
  if (leftAdjustment !== rightAdjustment) {
    return leftAdjustment - rightAdjustment;
  }

  return compareAdvancedRows(left, right);
}

function sortAdvancedPlansForRefine(plans) {
  return [...(Array.isArray(plans) ? plans : [])].sort((left, right) => {
    const leftAdjustment = planAdjustmentCount(left);
    const rightAdjustment = planAdjustmentCount(right);
    if (leftAdjustment !== rightAdjustment) {
      return leftAdjustment - rightAdjustment;
    }
    return 0;
  });
}

function buildAdvancedVariantPlanFromRow(row) {
  const sourcePlan = Array.isArray(row?.plans) && row.plans.length > 0 ? row.plans[0] : null;
  const totals = summarizeTotals({
    gathering: sourcePlan?.totalGathering ?? row?.totalGathering,
    perception: sourcePlan?.totalPerception ?? row?.totalPerception,
    gp: sourcePlan?.totalGp ?? row?.totalGp,
  });

  return {
    ...(sourcePlan ?? {}),
    score: Number(row?.score) || 0,
    food: sourcePlan?.food ?? row?.food ?? buildNoFoodOption(),
    totalGathering: totals.gathering,
    totalPerception: totals.perception,
    totalGp: totals.gp,
    meetsTargets: true,
    advanced: sourcePlan?.advanced ?? {
      baseTotals: summarizeTotals(row?.advanced?.baseTotals),
      profiles: Array.isArray(row?.advanced?.profiles) ? row.advanced.profiles : [],
    },
  };
}

function selectAdvancedPatternVariants(groupRows, maxVariants = DEFAULT_ADVANCED_VARIANT_LIMIT, options = {}) {
  const compareRows = options?.preferLowAdjustment === true ? compareAdvancedRowsForRefine : compareAdvancedRows;
  const rows = [...(Array.isArray(groupRows) ? groupRows : [])].sort(compareRows);
  if (rows.length === 0) {
    return [];
  }

  const selected = [];
  const usedTotals = new Set();
  for (const row of rows) {
    const totalsKey = advancedRowTotalKey(row);
    if (usedTotals.has(totalsKey)) {
      continue;
    }
    selected.push(buildAdvancedVariantPlanFromRow(row));
    usedTotals.add(totalsKey);
    if (selected.length >= Math.max(1, normalizeNonNegativeInteger(maxVariants, DEFAULT_ADVANCED_VARIANT_LIMIT))) {
      break;
    }
  }

  if (selected.length > 0) {
    return selected;
  }
  return [buildAdvancedVariantPlanFromRow(rows[0])];
}

function buildAdvancedRowFromPatternGroup(groupRows, activeScoringProfileCount, variantLimit, options = {}) {
  const compareRows = options?.preferLowAdjustment === true ? compareAdvancedRowsForRefine : compareAdvancedRows;
  const rows = [...(Array.isArray(groupRows) ? groupRows : [])].sort(compareRows);
  const primary = rows[0];
  if (!primary) {
    return null;
  }

  const plans = selectAdvancedPatternVariants(rows, variantLimit, options);
  const primaryPlan = plans[0] ?? buildAdvancedVariantPlanFromRow(primary);
  const totals = summarizeTotals({
    gathering: primaryPlan?.totalGathering ?? primary?.totalGathering,
    perception: primaryPlan?.totalPerception ?? primary?.totalPerception,
    gp: primaryPlan?.totalGp ?? primary?.totalGp,
  });
  const breakpointsMet = normalizeNonNegativeInteger(primary?.advanced?.breakpointsMet, Number(primary?.score) || 0);
  const bestAdjustmentCount = bestAdjustmentCountForPlans(plans);

  return {
    ...primary,
    score: breakpointsMet,
    totalGathering: totals.gathering,
    totalPerception: totals.perception,
    totalGp: totals.gp,
    food: primaryPlan?.food ?? primary?.food,
    meetsTargets: true,
    plans,
    ...(Number.isFinite(bestAdjustmentCount) ? { bestAdjustmentCount } : {}),
    advanced: {
      ...(primary?.advanced ?? {}),
      enabledProfileCount: activeScoringProfileCount,
    },
  };
}

export function applyAdvancedMode(results, options = {}) {
  const rows = Array.isArray(results) ? results : [];
  const profiles = selectActiveAdvancedProfiles(options?.advancedProfiles);
  const activeScoringProfileCount = profiles.length;
  const variantLimit = Math.max(
    1,
    normalizeNonNegativeInteger(options?.variantLimit, DEFAULT_ADVANCED_VARIANT_LIMIT),
  );
  const decoratePlan = typeof options?.decoratePlan === "function" ? options.decoratePlan : null;
  const preferLowAdjustment = options?.preferLowAdjustment === true;

  const evaluated = rows.map((row) => {
    const baseTotals = {
      gathering: normalizeNonNegativeInteger(row?.totalGathering, 0),
      perception: normalizeNonNegativeInteger(row?.totalPerception, 0),
      gp: normalizeNonNegativeInteger(row?.totalGp, 0),
    };
    const profileEvaluations = profiles.map((profile) =>
      evaluateProfileForTotals(baseTotals, profile, options?.foodRows),
    );
    const summary = buildAdvancedSummaryFromProfileEvaluations(profileEvaluations);

    const profilesForRow = profileEvaluations.map((profileEval) => cloneAdvancedProfileSummary(profileEval));

    const sourcePlans = Array.isArray(row?.plans) ? row.plans : [];
    const planRows = sourcePlans.map((plan, planIndex) => {
      const planProfiles = profileEvaluations.map((profileEval) => {
        const optionsForProfile = Array.isArray(profileEval?.bestOptions) ? profileEval.bestOptions : [];
        const option =
          optionsForProfile[planIndex % Math.max(1, optionsForProfile.length)] ??
          profileEval?.bestOption ??
          buildProfileFoodOption(baseTotals, {}, null);
        return {
          profileName: String(profileEval?.profileName ?? "Profile"),
          profileId: String(profileEval?.profileId ?? ""),
          statDump: normalizeAdvancedStatDump(profileEval?.statDump, ADVANCED_STAT_DUMP.NONE),
          enabledBreakpoints: normalizeNonNegativeInteger(option?.enabledCount, 0),
          breakpointsMet: normalizeNonNegativeInteger(option?.hitCount, 0),
          totals: summarizeTotals(option?.updatedTotals),
          food: option?.food ?? buildNoFoodOption(),
          breakpointResults: Array.isArray(option?.breakpointResults)
            ? option.breakpointResults.map((entry) => ({
                id: String(entry?.id ?? ""),
                name: String(entry?.name ?? "Breakpoint"),
                stat: STAT_KEYS.includes(String(entry?.stat ?? "")) ? String(entry.stat) : "gathering",
                value: normalizeNonNegativeInteger(entry?.value, 0),
                priority: normalizeOptionalPriority(entry?.priority),
                hit: Boolean(entry?.hit),
              }))
            : [],
        };
      });

      const primaryProfileFood = planProfiles[0]?.food ?? row?.food ?? null;
      const primaryProfileTotals = planProfiles[0]?.totals ?? baseTotals;
      const builtPlan = {
        ...plan,
        food: primaryProfileFood,
        totalGathering: normalizeNonNegativeInteger(primaryProfileTotals.gathering, 0),
        totalPerception: normalizeNonNegativeInteger(primaryProfileTotals.perception, 0),
        totalGp: normalizeNonNegativeInteger(primaryProfileTotals.gp, 0),
        advanced: {
          baseTotals,
          profiles: planProfiles,
        },
      };
      return decoratePlan ? decoratePlan(builtPlan) : builtPlan;
    });
    const plans = preferLowAdjustment ? sortAdvancedPlansForRefine(planRows) : planRows;
    const bestAdjustmentCount = bestAdjustmentCountForPlans(plans);

    const primaryFood = profilesForRow[0]?.food ?? row?.food ?? null;
    const primaryTotals = profilesForRow[0]?.totals ?? baseTotals;
    return {
      ...row,
      score: summary.breakpointsMet,
      totalGathering: normalizeNonNegativeInteger(primaryTotals.gathering, 0),
      totalPerception: normalizeNonNegativeInteger(primaryTotals.perception, 0),
      totalGp: normalizeNonNegativeInteger(primaryTotals.gp, 0),
      food: primaryFood,
      meetsTargets: true,
      plans,
      ...(Number.isFinite(bestAdjustmentCount) ? { bestAdjustmentCount } : {}),
      advanced: {
        enabledProfileCount: activeScoringProfileCount,
        baseTotals,
        profiles: profilesForRow,
        breakpointsMet: summary.breakpointsMet,
        breakpointsEnabled: summary.breakpointsEnabled,
        priorityLedger: summary.priorityLedger,
        dumpPreferenceScore: summary.dumpPreferenceScore,
        tiebreakStatSum: summary.tiebreakStatSum,
      },
    };
  });

  const compareRows = preferLowAdjustment ? compareAdvancedRowsForRefine : compareAdvancedRows;
  const ranked = evaluated.sort(compareRows);

  const groupedByBreakpointPattern = new Map();
  for (const row of ranked) {
    const patternKey = advancedBreakpointPatternKeyForRow(row);
    if (!groupedByBreakpointPattern.has(patternKey)) {
      groupedByBreakpointPattern.set(patternKey, []);
    }
    groupedByBreakpointPattern.get(patternKey).push(row);
  }

  const groupedRows = Array.from(groupedByBreakpointPattern.values())
    .map((groupRows) =>
      buildAdvancedRowFromPatternGroup(groupRows, activeScoringProfileCount, variantLimit, {
        preferLowAdjustment,
      }),
    )
    .filter((row) => !!row)
    .sort(compareRows);

  const displayLimit = Math.max(
    1,
    normalizeNonNegativeInteger(options?.displayLimit, groupedRows.length > 0 ? groupedRows.length : 1),
  );
  return groupedRows.slice(0, displayLimit);
}
