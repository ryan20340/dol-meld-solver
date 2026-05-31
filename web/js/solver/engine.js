import { buildCandidatesForPiece } from "./candidate-builder.js";
import { scoreCandidate } from "./score.js";
import { depthFirstSearch } from "./search.js";
import {
  BASE_GATHERER_GP,
  addTrackedStats,
  emptyTrackedStats,
  getGearRowTrackedStats,
  statSum,
} from "../utils/gear-stats.js";

const SLOT_ORDER = Object.freeze([
  "main_hand",
  "off_hand",
  "head",
  "body",
  "hands",
  "waist",
  "legs",
  "feet",
  "ears",
  "neck",
  "wrists",
  "ring",
  "soul_crystal",
]);

const STAT_KEYS = Object.freeze(["gathering", "perception", "gp"]);
const MAX_TOTAL_MATERIA_SLOTS_PER_PIECE = 5;
const MAX_OVERMELD_SLOTS_PER_PIECE = 4;

function emptyTotals() {
  return emptyTrackedStats();
}

function addTotals(left, right) {
  return addTrackedStats(left, right);
}

// Sum the applied meld values actually present in a built plan's layout. The
// search records meld totals for the slots it processed, but when it terminates
// early the layout is padded with extra pieces' melds for display. Deriving the
// totals from the displayed melds guarantees the shown layout always sums to the
// reported totals.
function sumDisplayedMeldTotals(plan) {
  const totals = emptyTotals();
  const pieces = Array.isArray(plan?.pieceMelds) ? plan.pieceMelds : [];
  for (const piece of pieces) {
    const melds = Array.isArray(piece?.melds) ? piece.melds : [];
    for (const meld of melds) {
      const stat = meld?.stat;
      if (stat === "gathering" || stat === "perception" || stat === "gp") {
        totals[stat] += Number(meld?.appliedValue) || 0;
      }
    }
  }
  return totals;
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function normalizeNonNegativeInteger(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function slotOrderIndex(slot) {
  const idx = SLOT_ORDER.indexOf(slot);
  if (idx >= 0) {
    return idx;
  }
  return SLOT_ORDER.length + 1;
}

function sortBySlotOrder(rows) {
  return [...rows].sort((left, right) => {
    const slotDiff = slotOrderIndex(left.slot) - slotOrderIndex(right.slot);
    if (slotDiff !== 0) {
      return slotDiff;
    }
    const nameLeft = String(left.name ?? "");
    const nameRight = String(right.name ?? "");
    if (nameLeft !== nameRight) {
      return nameLeft.localeCompare(nameRight);
    }
    return (Number(left.id) || 0) - (Number(right.id) || 0);
  });
}

function chooseBetterGear(currentBest, candidate, useGearHq = true) {
  if (!currentBest) {
    return candidate;
  }

  const maxTotalSlotsPerPiece = 5;
  const maxOvermeldSlotsPerPiece = 4;
  const calcPotentialSlots = (row) => {
    const guaranteed = Math.max(0, normalizePositiveInteger(row?.guaranteed_materia_slots, 0));
    if (!row?.advanced_melding_permitted) {
      return guaranteed;
    }

    const remaining = Math.max(0, maxTotalSlotsPerPiece - guaranteed);
    const overmeld = Math.min(remaining, maxOvermeldSlotsPerPiece);
    return guaranteed + overmeld;
  };

  const candidateItemLevel = Number(candidate?.item_level) || 0;
  const bestItemLevel = Number(currentBest?.item_level) || 0;
  if (candidateItemLevel !== bestItemLevel) {
    return candidateItemLevel > bestItemLevel ? candidate : currentBest;
  }

  const candidatePotentialSlots = calcPotentialSlots(candidate);
  const bestPotentialSlots = calcPotentialSlots(currentBest);
  if (candidatePotentialSlots !== bestPotentialSlots) {
    return candidatePotentialSlots > bestPotentialSlots ? candidate : currentBest;
  }

  const candidateStats = statSum(getGearRowTrackedStats(candidate, { useHq: useGearHq }));
  const bestStats = statSum(getGearRowTrackedStats(currentBest, { useHq: useGearHq }));
  if (candidateStats !== bestStats) {
    return candidateStats > bestStats ? candidate : currentBest;
  }

  const candidateId = Number(candidate?.id) || 0;
  const bestId = Number(currentBest?.id) || 0;
  return candidateId > bestId ? candidate : currentBest;
}

function isDoLGearRow(row) {
  if (!row || typeof row !== "object") {
    return false;
  }

  const baseTotal = statSum(getGearRowTrackedStats(row, { useHq: true }));
  if (baseTotal <= 0) {
    return false;
  }

  return typeof row.slot === "string" && row.slot.length > 0;
}


function meetsTargets(totals, targets) {
  const targetGathering = normalizePositiveInteger(targets?.gathering, 0);
  const targetPerception = normalizePositiveInteger(targets?.perception, 0);
  const targetGp = normalizePositiveInteger(targets?.gp, 0);

  if (targetGathering + targetPerception + targetGp === 0) {
    return true;
  }

  return (
    (Number(totals?.gathering) || 0) >= targetGathering &&
    (Number(totals?.perception) || 0) >= targetPerception &&
    (Number(totals?.gp) || 0) >= targetGp
  );
}

function toMeldTargets(absoluteTargets, baseTotals) {
  return {
    gathering: Math.max(
      0,
      normalizePositiveInteger(absoluteTargets?.gathering, 0) - (Number(baseTotals?.gathering) || 0),
    ),
    perception: Math.max(
      0,
      normalizePositiveInteger(absoluteTargets?.perception, 0) - (Number(baseTotals?.perception) || 0),
    ),
    gp: Math.max(0, normalizePositiveInteger(absoluteTargets?.gp, 0) - (Number(baseTotals?.gp) || 0)),
  };
}

function maxMateriaSlotsForPiece(piece) {
  const guaranteed = Math.max(0, Number(piece?.guaranteed_materia_slots) || 0);
  const normalizedGuaranteed = Math.min(guaranteed, MAX_TOTAL_MATERIA_SLOTS_PER_PIECE);
  if (!piece?.advanced_melding_permitted) {
    return normalizedGuaranteed;
  }

  const remaining = Math.max(0, MAX_TOTAL_MATERIA_SLOTS_PER_PIECE - normalizedGuaranteed);
  return normalizedGuaranteed + Math.min(remaining, MAX_OVERMELD_SLOTS_PER_PIECE);
}

function varianceSlotWeight(slot) {
  const slotKey = String(slot ?? "");
  if (slotKey === "main_hand" || slotKey === "off_hand") {
    return 8;
  }
  return 1;
}

function buildPlanVarianceTokenWeights(pieceMelds) {
  const pieces = Array.isArray(pieceMelds) ? pieceMelds : [];
  const tokenWeights = new Map();
  for (let pieceIndex = 0; pieceIndex < pieces.length; pieceIndex += 1) {
    const piece = pieces[pieceIndex];
    const pieceSlot = String(piece?.slot ?? "unknown");
    const slotWeight = varianceSlotWeight(pieceSlot);
    const melds = Array.isArray(piece?.melds) ? piece.melds : [];
    for (const meld of melds) {
      const slotIndex = normalizeNonNegativeInteger(meld?.slotIndex, 0);
      const statKey = String(meld?.stat ?? "x");
      const grade = normalizeNonNegativeInteger(meld?.grade, 0);
      const appliedValue = normalizeNonNegativeInteger(meld?.appliedValue, 0);
      const token = `${pieceIndex}:${pieceSlot}:${slotIndex}:${statKey}:${grade}:${appliedValue}`;
      tokenWeights.set(token, slotWeight);
    }
  }
  return tokenWeights;
}

function varianceTokenKey(tokenWeights) {
  const keys = tokenWeights instanceof Map ? Array.from(tokenWeights.keys()) : [];
  keys.sort();
  return keys.join("|");
}

function weightedSymmetricDifference(leftTokenWeights, rightTokenWeights) {
  const left = leftTokenWeights instanceof Map ? leftTokenWeights : new Map();
  const right = rightTokenWeights instanceof Map ? rightTokenWeights : new Map();
  let diffScore = 0;
  for (const [token, weight] of left.entries()) {
    if (!right.has(token)) {
      diffScore += normalizeNonNegativeInteger(weight, 1);
    }
  }
  for (const [token, weight] of right.entries()) {
    if (!left.has(token)) {
      diffScore += normalizeNonNegativeInteger(weight, 1);
    }
  }
  return diffScore;
}

const TOOL_VARIANCE_SLOTS = ["main_hand", "off_hand"];
const EMPTY_TOKEN_MAP = new Map();

// Build the weapon-slot meld token maps for a plan once. toolVarianceDistance is
// called O(picks * pool * selected) times per group during diversification, so
// these are cached on the plan (see ensurePlanVarianceCaches) rather than rebuilt
// on every pairwise comparison.
function buildToolTokensBySlot(plan) {
  const bySlot = new Map();
  for (const piece of Array.isArray(plan?.pieceMelds) ? plan.pieceMelds : []) {
    const slot = String(piece?.slot ?? "");
    if (slot !== "main_hand" && slot !== "off_hand") {
      continue;
    }
    const tokens = new Map();
    for (const meld of Array.isArray(piece?.melds) ? piece.melds : []) {
      const slotIndex = normalizeNonNegativeInteger(meld?.slotIndex, 0);
      const statKey = String(meld?.stat ?? "x");
      const grade = normalizeNonNegativeInteger(meld?.grade, 0);
      const appliedValue = normalizeNonNegativeInteger(meld?.appliedValue, 0);
      tokens.set(`${slot}:${slotIndex}:${statKey}:${grade}:${appliedValue}`, 1);
    }
    bySlot.set(slot, tokens);
  }
  return bySlot;
}

// Build the per-slot layout signatures for a plan once (cached on the plan).
function buildPieceSignatureBySlot(plan) {
  const signatures = new Map();
  for (const piece of Array.isArray(plan?.pieceMelds) ? plan.pieceMelds : []) {
    signatures.set(String(piece?.slot ?? "unknown"), buildPieceVarianceSignature(piece));
  }
  return signatures;
}

function planToolTokensBySlot(plan) {
  if (plan && plan.__toolTokensBySlot instanceof Map) {
    return plan.__toolTokensBySlot;
  }
  return buildToolTokensBySlot(plan);
}

function planPieceSignatureBySlot(plan) {
  if (plan && plan.__pieceSignatureBySlot instanceof Map) {
    return plan.__pieceSignatureBySlot;
  }
  return buildPieceSignatureBySlot(plan);
}

function toolVarianceDistance(leftPlan, rightPlan) {
  const leftBySlot = planToolTokensBySlot(leftPlan);
  const rightBySlot = planToolTokensBySlot(rightPlan);
  let total = 0;
  for (const slot of TOOL_VARIANCE_SLOTS) {
    total += weightedSymmetricDifference(
      leftBySlot.get(slot) ?? EMPTY_TOKEN_MAP,
      rightBySlot.get(slot) ?? EMPTY_TOKEN_MAP,
    );
  }
  return total;
}

function buildPieceVarianceSignature(piece) {
  const slot = String(piece?.slot ?? "unknown");
  const melds = Array.isArray(piece?.melds) ? piece.melds : [];
  const meldTokens = melds
    .map((meld) => {
      const slotIndex = normalizeNonNegativeInteger(meld?.slotIndex, 0);
      const statKey = String(meld?.stat ?? "x");
      const grade = normalizeNonNegativeInteger(meld?.grade, 0);
      const appliedValue = normalizeNonNegativeInteger(meld?.appliedValue, 0);
      return `${slotIndex}:${statKey}:${grade}:${appliedValue}`;
    })
    .sort();
  return `${slot}|${meldTokens.join(",")}`;
}

function changedPieceCount(leftPlan, rightPlan) {
  const leftSignatures = planPieceSignatureBySlot(leftPlan);
  const rightSignatures = planPieceSignatureBySlot(rightPlan);

  const slotKeys = new Set([...leftSignatures.keys(), ...rightSignatures.keys()]);
  let changed = 0;
  for (const slot of slotKeys) {
    const leftSignature = leftSignatures.get(slot) ?? `${slot}|`;
    const rightSignature = rightSignatures.get(slot) ?? `${slot}|`;
    if (leftSignature !== rightSignature) {
      changed += 1;
    }
  }
  return changed;
}

function planVarianceDistance(leftPlan, rightPlan) {
  const meldDistance = weightedSymmetricDifference(
    leftPlan?.__varianceTokenWeights,
    rightPlan?.__varianceTokenWeights,
  );
  const toolDistance = toolVarianceDistance(leftPlan, rightPlan);
  const pieceDistance = changedPieceCount(leftPlan, rightPlan);

  // Piece/tool differences are weighted higher so displayed variants diverge
  // more strongly in visible layout and tool meld patterns.
  const totalDistance = meldDistance + pieceDistance * 6 + toolDistance * 4;

  return {
    meldDistance,
    toolDistance,
    pieceDistance,
    totalDistance,
  };
}

function diversifyPlanVariants(plans) {
  const rows = Array.isArray(plans) ? plans : [];
  if (rows.length === 0) {
    return [];
  }
  if (rows.length === 1) {
    const cleaned = { ...rows[0], varianceScore: 0 };
    delete cleaned.__varianceTokenWeights;
    delete cleaned.__varianceTokenKey;
    return [cleaned];
  }

  // Precompute each plan's variance structures once. The pairwise distance
  // functions below run O(picks * pool * selected) times per group and would
  // otherwise rebuild these token maps and per-slot signatures on every call.
  for (const plan of rows) {
    if (!plan) {
      continue;
    }
    if (!(plan.__toolTokensBySlot instanceof Map)) {
      plan.__toolTokensBySlot = buildToolTokensBySlot(plan);
    }
    if (!(plan.__pieceSignatureBySlot instanceof Map)) {
      plan.__pieceSignatureBySlot = buildPieceSignatureBySlot(plan);
    }
  }

  const baseline = { ...rows[0], varianceScore: 0, baselineVarianceScore: 0 };
  const selected = [baseline];
  const remaining = rows.slice(1);

  // Favor tool changes when they are available in the pool.
  const hasToolAlternative = remaining.some((candidate) => toolVarianceDistance(baseline, candidate) > 0);
  const eligiblePool = hasToolAlternative
    ? remaining.filter((candidate) => toolVarianceDistance(baseline, candidate) > 0)
    : remaining;
  const fallbackPool = hasToolAlternative
    ? remaining.filter((candidate) => toolVarianceDistance(baseline, candidate) <= 0)
    : [];

  const pickFromPool = (pool) => {
    if (!Array.isArray(pool) || pool.length === 0) {
      return null;
    }
    let bestIndex = 0;
    let bestBaselineDistance = Number.NEGATIVE_INFINITY;
    let bestBaselinePieceDistance = Number.NEGATIVE_INFINITY;
    let bestMinSelectedDistance = Number.NEGATIVE_INFINITY;
    let bestMinSelectedPieceDistance = Number.NEGATIVE_INFINITY;
    let bestDistanceSum = Number.NEGATIVE_INFINITY;
    let bestToolDistance = Number.NEGATIVE_INFINITY;
    let bestTokenKey = "";

    for (let idx = 0; idx < pool.length; idx += 1) {
      const candidate = pool[idx];
      const baselineMetrics = planVarianceDistance(candidate, baseline);
      const baselineDistance = baselineMetrics.totalDistance;
      const baselinePieceDistance = baselineMetrics.pieceDistance;
      const toolDistance = baselineMetrics.toolDistance;

      let minSelectedDistance = Number.POSITIVE_INFINITY;
      let minSelectedPieceDistance = Number.POSITIVE_INFINITY;
      let distanceSum = 0;
      for (const chosen of selected) {
        const selectedMetrics = planVarianceDistance(candidate, chosen);
        minSelectedDistance = Math.min(minSelectedDistance, selectedMetrics.totalDistance);
        minSelectedPieceDistance = Math.min(
          minSelectedPieceDistance,
          selectedMetrics.pieceDistance,
        );
        distanceSum += selectedMetrics.totalDistance;
      }

      const tokenKey = String(candidate.__varianceTokenKey ?? "");
      const isBetter =
        minSelectedDistance > bestMinSelectedDistance ||
        (minSelectedDistance === bestMinSelectedDistance &&
          minSelectedPieceDistance > bestMinSelectedPieceDistance) ||
        (minSelectedDistance === bestMinSelectedDistance &&
          minSelectedPieceDistance === bestMinSelectedPieceDistance &&
          baselineDistance > bestBaselineDistance) ||
        (minSelectedDistance === bestMinSelectedDistance &&
          minSelectedPieceDistance === bestMinSelectedPieceDistance &&
          baselineDistance === bestBaselineDistance &&
          baselinePieceDistance > bestBaselinePieceDistance) ||
        (minSelectedDistance === bestMinSelectedDistance &&
          minSelectedPieceDistance === bestMinSelectedPieceDistance &&
          baselineDistance === bestBaselineDistance &&
          baselinePieceDistance === bestBaselinePieceDistance &&
          toolDistance > bestToolDistance) ||
        (minSelectedDistance === bestMinSelectedDistance &&
          minSelectedPieceDistance === bestMinSelectedPieceDistance &&
          baselineDistance === bestBaselineDistance &&
          baselinePieceDistance === bestBaselinePieceDistance &&
          toolDistance === bestToolDistance &&
          distanceSum > bestDistanceSum) ||
        (minSelectedDistance === bestMinSelectedDistance &&
          minSelectedPieceDistance === bestMinSelectedPieceDistance &&
          baselineDistance === bestBaselineDistance &&
          baselinePieceDistance === bestBaselinePieceDistance &&
          toolDistance === bestToolDistance &&
          distanceSum === bestDistanceSum &&
          tokenKey.localeCompare(bestTokenKey) < 0);
      if (isBetter) {
        bestIndex = idx;
        bestBaselineDistance = baselineDistance;
        bestBaselinePieceDistance = baselinePieceDistance;
        bestToolDistance = toolDistance;
        bestMinSelectedDistance = minSelectedDistance;
        bestMinSelectedPieceDistance = minSelectedPieceDistance;
        bestDistanceSum = distanceSum;
        bestTokenKey = tokenKey;
      }
    }

    const [chosen] = pool.splice(bestIndex, 1);
    return {
      ...chosen,
      baselineVarianceScore: normalizeNonNegativeInteger(bestBaselineDistance, 0),
      varianceScore: normalizeNonNegativeInteger(bestBaselineDistance, 0),
    };
  };

  while (eligiblePool.length > 0) {
    const chosen = pickFromPool(eligiblePool);
    if (!chosen) {
      break;
    }
    selected.push(chosen);
  }

  while (fallbackPool.length > 0) {
    const chosen = pickFromPool(fallbackPool);
    if (!chosen) {
      break;
    }
    selected.push(chosen);
  }

  return selected.map((plan) => {
    const cleaned = { ...plan };
    delete cleaned.__varianceTokenWeights;
    delete cleaned.__varianceTokenKey;
    delete cleaned.__toolTokensBySlot;
    delete cleaned.__pieceSignatureBySlot;
    delete cleaned.baselineVarianceScore;
    return cleaned;
  });
}

export function buildAutoSelectedGearSet(allGearRows, options = {}) {
  const rows = Array.isArray(allGearRows) ? allGearRows : [];
  const useGearHq = options.useGearHq !== false;
  const bestBySlot = new Map();

  for (const row of rows) {
    if (!isDoLGearRow(row)) {
      continue;
    }

    const currentBest = bestBySlot.get(row.slot);
    const better = chooseBetterGear(currentBest, row, useGearHq);
    bestBySlot.set(row.slot, better);
  }

  return sortBySlotOrder(Array.from(bestBySlot.values()));
}

export function solveLegalityOnly(input, options = {}) {
  const selectedGearRows = Array.isArray(input?.selectedGearRows) ? input.selectedGearRows : [];
  const materiaRows = Array.isArray(input?.materiaRows) ? input.materiaRows : [];
  const rules = input?.rules ?? {};
  const targets = input?.targets ?? {};
  const maxResults = normalizePositiveInteger(input?.maxResults, 25);
  const maxBranches = normalizePositiveInteger(input?.maxBranches, 5000000);
  const maxDurationMs = normalizePositiveInteger(input?.maxDurationMs, 3000);
  const rawMaxCandidatesPerPiece = normalizeNonNegativeInteger(input?.maxCandidatesPerPiece, 0);
  const maxCandidatesPerPiece =
    rawMaxCandidatesPerPiece > 0 ? rawMaxCandidatesPerPiece : Number.POSITIVE_INFINITY;
  const useBruteForce = input?.useBruteForce === true;
  const useGearHq = input?.useGearHq !== false;
  const baseGathererGp = Math.max(0, Number(input?.baseGathererGp ?? BASE_GATHERER_GP) || 0);
  const onProgress = typeof options?.onProgress === "function" ? options.onProgress : null;

  if (selectedGearRows.length === 0) {
    const emptyBaseTotals = emptyTotals();
    emptyBaseTotals.gp += baseGathererGp;
    return {
      selectedGearRows: [],
      baseTotals: emptyBaseTotals,
      results: [],
      diagnostics: {
        visitedBranches: 0,
        terminatedEarly: false,
        terminatedByTime: false,
        pruneCounts: {
          target_unreachable: 0,
          score_bound: 0,
        },
        elapsedMs: 0,
        pieceCount: 0,
      },
    };
  }

  const orderedPieces = sortBySlotOrder(selectedGearRows);
  const pieceCandidates = orderedPieces.map((piece) => ({
    piece,
    candidates: buildCandidatesForPiece(piece, {
      materiaRows,
      rules,
      maxCandidatesPerPiece,
      useGearHq,
    }),
  }));

  const baseTotals = orderedPieces.reduce(
    (totals, piece) => addTotals(totals, getGearRowTrackedStats(piece, { useHq: useGearHq })),
    emptyTotals(),
  );
  baseTotals.gp += baseGathererGp;
  const meldTargets = toMeldTargets(targets, baseTotals);

  const DISPLAY_MAX_PLANS_PER_TOTAL = 5;
  const SEARCH_MAX_PLANS_PER_TOTAL = 24;
  const SEARCH_OVERSAMPLE_FACTOR = 4;
  // "Brute force" is now a thorough run: same lossless pruning as the fast
  // search, but with no time cutoff and a generous branch budget so it explores
  // the whole frontier to completion. The pruned search realistically finishes
  // in a few million branches, so this ceiling is a safety net, not a target.
  const BRUTE_FORCE_MAX_BRANCHES = 50_000_000;

  const search = depthFirstSearch({
    pieceCandidates,
    targets: meldTargets,
    // Keep internal search breadth higher than displayed variant cap so
    // unique result rows do not collapse when many top paths share totals.
    maxResults: maxResults * SEARCH_MAX_PLANS_PER_TOTAL * SEARCH_OVERSAMPLE_FACTOR,
    maxPlansPerTotal: SEARCH_MAX_PLANS_PER_TOTAL,
    maxBranches: useBruteForce ? BRUTE_FORCE_MAX_BRANCHES : maxBranches,
    maxDurationMs: useBruteForce ? 0 : maxDurationMs,
    evaluate: (meldTotals) => scoreCandidate(addTotals(baseTotals, meldTotals), targets),
    onProgress,
  });

  // The search is done visiting branches; the remaining work (grouping the
  // frontier into displayable plan variants) emits no branch progress, so signal
  // the phase change once here. Runs on the worker thread, so the UI can swap its
  // message while post-processing proceeds.
  if (onProgress) {
    // Omit elapsedMs so the UI's wall-clock timer keeps owning the elapsed
    // readout (search.elapsedMs is search-relative and would tick it backward).
    onProgress({
      phase: "building",
      visitedBranches: search.visitedBranches,
    });
  }

  const plansByTotals = new Map();
  for (const entry of search.results) {
    const key = `${entry.totals.gathering}|${entry.totals.perception}|${entry.totals.gp}`;
    if (!plansByTotals.has(key)) {
      plansByTotals.set(key, []);
    }
    plansByTotals.get(key).push(entry);
  }

  const results = Array.from(plansByTotals.values())
    .map((group) => {
      group.sort((left, right) => {
        const offHandGatheringDiff =
          (Number(left?.offHandGathering) || 0) - (Number(right?.offHandGathering) || 0);
        if (offHandGatheringDiff !== 0) {
          return offHandGatheringDiff;
        }
        return (Number(right?.score) || 0) - (Number(left?.score) || 0);
      });
      const rep = group[0];
      const plans = diversifyPlanVariants(
        group.map((entry) => {
          const pieceMelds = entry.path.map((segment) => ({
            pieceId: Number(segment?.piece?.id) || 0,
            slot: segment?.piece?.slot,
            pieceName: segment?.piece?.name,
            maxMateriaSlots: maxMateriaSlotsForPiece(segment?.piece),
            trackedMeldCaps: {
              gathering: Number(segment?.piece?.tracked_meld_caps?.gathering) || 0,
              perception: Number(segment?.piece?.tracked_meld_caps?.perception) || 0,
              gp: Number(segment?.piece?.tracked_meld_caps?.gp) || 0,
            },
            melds: Array.isArray(segment?.candidate?.melds) ? segment.candidate.melds : [],
          }));
          // If the solver terminated early, the path is shorter than orderedPieces.
          // Pad with the best available candidate for each unprocessed piece so all
          // selected slots appear in the layout with a reasonable meld suggestion.
          for (let i = pieceMelds.length; i < orderedPieces.length; i++) {
            const piece = orderedPieces[i];
            const candidates = pieceCandidates[i]?.candidates ?? [];
            const bestNonEmpty = candidates.find(
              (c) => Array.isArray(c.melds) && c.melds.length > 0,
            );
            const chosen = bestNonEmpty ?? candidates[0] ?? null;
            pieceMelds.push({
              pieceId: Number(piece?.id) || 0,
              slot: piece.slot,
              pieceName: piece.name,
              maxMateriaSlots: maxMateriaSlotsForPiece(piece),
              trackedMeldCaps: {
                gathering: Number(piece?.tracked_meld_caps?.gathering) || 0,
                perception: Number(piece?.tracked_meld_caps?.perception) || 0,
                gp: Number(piece?.tracked_meld_caps?.gp) || 0,
              },
              melds: Array.isArray(chosen?.melds) ? chosen.melds : [],
            });
          }
          const varianceTokenWeights = buildPlanVarianceTokenWeights(pieceMelds);
          return {
            pieceMelds,
            varianceScore: 0,
            __varianceTokenWeights: varianceTokenWeights,
            __varianceTokenKey: varianceTokenKey(varianceTokenWeights),
          };
        }),
      ).slice(0, DISPLAY_MAX_PLANS_PER_TOTAL);
      // Derive totals from the melds actually shown in the representative plan so
      // the displayed layout always sums to the reported totals — including any
      // pieces padded in after an early search termination. All plans in a group
      // share the same searched meld totals and identical padding, so plans[0] is
      // representative of the whole row.
      const meldTotals = sumDisplayedMeldTotals(plans[0]);
      const totalStats = addTotals(baseTotals, meldTotals);
      return {
        score: scoreCandidate(totalStats, targets),
        offHandGathering: Number(rep?.offHandGathering) || 0,
        totalGathering: totalStats.gathering,
        totalPerception: totalStats.perception,
        totalGp: totalStats.gp,
        meldGathering: meldTotals.gathering,
        meldPerception: meldTotals.perception,
        meldGp: meldTotals.gp,
        meetsTargets: meetsTargets(totalStats, targets),
        plans,
      };
    })
    .sort((a, b) => {
      const scoreDiff = (Number(b?.score) || 0) - (Number(a?.score) || 0);
      if (scoreDiff !== 0) {
        return scoreDiff;
      }
      return (Number(a?.offHandGathering) || 0) - (Number(b?.offHandGathering) || 0);
    })
    .slice(0, maxResults);

  return {
    selectedGearRows: orderedPieces,
    baseTotals,
    results,
    diagnostics: {
      visitedBranches: search.visitedBranches,
      terminatedEarly: search.terminatedEarly,
      terminatedByTime: search.terminatedByTime,
      pruneCounts: search.pruneCounts,
      elapsedMs: search.elapsedMs,
      pieceCount: orderedPieces.length,
      candidateCountByPiece: pieceCandidates.map((entry) => ({
        slot: entry.piece.slot,
        pieceName: entry.piece.name,
        candidates: entry.candidates.length,
      })),
    },
  };

}
