function emptyTotals() {
  return {
    gathering: 0,
    perception: 0,
    gp: 0,
  };
}

function addTotals(left, right) {
  return {
    gathering: (Number(left?.gathering) || 0) + (Number(right?.gathering) || 0),
    perception: (Number(left?.perception) || 0) + (Number(right?.perception) || 0),
    gp: (Number(left?.gp) || 0) + (Number(right?.gp) || 0),
  };
}

function sortedTopResults(results, maxResults) {
  results.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    // Refine mode: among equally-scoring layouts prefer the one closest to the
    // player's existing melds. Inert (all zero) outside refine.
    const baselineDistanceDiff =
      (Number(left?.baselineDistance) || 0) - (Number(right?.baselineDistance) || 0);
    if (baselineDistanceDiff !== 0) {
      return baselineDistanceDiff;
    }
    const offHandGatheringDiff =
      (Number(left?.offHandGathering) || 0) - (Number(right?.offHandGathering) || 0);
    if (offHandGatheringDiff !== 0) {
      return offHandGatheringDiff;
    }
    if (left.meldCount !== right.meldCount) {
      return left.meldCount - right.meldCount;
    }
    return String(left?.layoutKey ?? "").localeCompare(String(right?.layoutKey ?? ""));
  });
  if (results.length > maxResults) {
    results.length = maxResults;
  }
}

const TIME_BUDGET_CHECK_INTERVAL = 1024;
const TIMED_OUT_RESULT_OVERSAMPLE_FACTOR = 4;
const TIMED_OUT_RESULT_HARD_CAP = 20000;
const PROGRESS_BRANCH_INTERVAL = 2048;
const PROGRESS_MIN_INTERVAL_MS = 100;

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

function normalizeTarget(value) {
  return normalizeNonNegativeInteger(value, 0);
}

function nowMs() {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function resolvePieceRow(pieceEntry) {
  if (pieceEntry && typeof pieceEntry === "object" && pieceEntry.piece) {
    return pieceEntry.piece;
  }
  return pieceEntry;
}

function totalsKey(totals) {
  return `${Number(totals?.gathering) || 0}|${Number(totals?.perception) || 0}|${Number(totals?.gp) || 0}`;
}

function candidateMeldSignature(candidate) {
  const melds = Array.isArray(candidate?.melds) ? candidate.melds : [];
  if (melds.length === 0) {
    return "empty";
  }
  return melds
    .map((meld) => {
      const slotIndex = Number(meld?.slotIndex);
      const safeSlotIndex = Number.isFinite(slotIndex) ? slotIndex : -1;
      const statKey = String(meld?.stat ?? "x");
      const grade = Number(meld?.grade);
      const safeGrade = Number.isFinite(grade) ? grade : 0;
      const appliedValue = Number(meld?.appliedValue);
      const safeAppliedValue = Number.isFinite(appliedValue) ? appliedValue : 0;
      return `${safeSlotIndex}:${statKey}:${safeGrade}:${safeAppliedValue}`;
    })
    .join("|");
}

function buildSegmentLayoutKey(piece, candidate) {
  const pieceSlot = String(piece?.slot ?? "unknown");
  return `${pieceSlot}=${totalsKey(candidate?.totals)}:${candidateMeldSignature(candidate)}`;
}

function compareStateRetentionPriority(left, right) {
  // Refine mode: keep the layout closest to the player's existing melds when
  // several layouts reach the same totals. Inert (all zero) outside refine.
  const leftBaselineDistance = Number(left?.baselineDistance) || 0;
  const rightBaselineDistance = Number(right?.baselineDistance) || 0;
  if (leftBaselineDistance !== rightBaselineDistance) {
    return leftBaselineDistance - rightBaselineDistance;
  }

  const leftOffHandGathering = Number(left?.offHandGathering) || 0;
  const rightOffHandGathering = Number(right?.offHandGathering) || 0;
  if (leftOffHandGathering !== rightOffHandGathering) {
    return leftOffHandGathering - rightOffHandGathering;
  }

  const leftMeldCount = Number(left?.meldCount) || 0;
  const rightMeldCount = Number(right?.meldCount) || 0;
  if (leftMeldCount !== rightMeldCount) {
    return leftMeldCount - rightMeldCount;
  }
  return String(left?.layoutKey ?? "").localeCompare(String(right?.layoutKey ?? ""));
}

function candidateOffHandGathering(piece, candidate) {
  if (String(piece?.slot ?? "") !== "off_hand") {
    return 0;
  }
  return Number(candidate?.totals?.gathering) || 0;
}

function maxTotalsFromCandidates(candidates) {
  const rows = Array.isArray(candidates) ? candidates : [];
  return rows.reduce(
    (maxima, candidate) => ({
      gathering: Math.max(maxima.gathering, Number(candidate?.totals?.gathering) || 0),
      perception: Math.max(maxima.perception, Number(candidate?.totals?.perception) || 0),
      gp: Math.max(maxima.gp, Number(candidate?.totals?.gp) || 0),
    }),
    emptyTotals(),
  );
}

function buildRemainingMaxTotalsByIndex(pieces) {
  const remaining = new Array(pieces.length + 1);
  remaining[pieces.length] = emptyTotals();

  for (let pieceIndex = pieces.length - 1; pieceIndex >= 0; pieceIndex -= 1) {
    const piece = pieces[pieceIndex];
    const pieceMax = maxTotalsFromCandidates(piece?.candidates);
    remaining[pieceIndex] = addTotals(pieceMax, remaining[pieceIndex + 1]);
  }

  return remaining;
}

function canReachTargets(currentTotals, remainingMaxTotals, targets) {
  const normalizedTargets = {
    gathering: normalizeTarget(targets?.gathering),
    perception: normalizeTarget(targets?.perception),
    gp: normalizeTarget(targets?.gp),
  };
  const hasAnyTarget =
    normalizedTargets.gathering + normalizedTargets.perception + normalizedTargets.gp > 0;
  if (!hasAnyTarget) {
    return true;
  }

  const projected = addTotals(currentTotals, remainingMaxTotals);
  return (
    projected.gathering >= normalizedTargets.gathering &&
    projected.perception >= normalizedTargets.perception &&
    projected.gp >= normalizedTargets.gp
  );
}

function totalsDominate(leftTotals, rightTotals) {
  const gDiff = (Number(leftTotals?.gathering) || 0) - (Number(rightTotals?.gathering) || 0);
  const pDiff = (Number(leftTotals?.perception) || 0) - (Number(rightTotals?.perception) || 0);
  const gpDiff = (Number(leftTotals?.gp) || 0) - (Number(rightTotals?.gp) || 0);

  return gDiff >= 0 && pDiff >= 0 && gpDiff >= 0 && (gDiff > 0 || pDiff > 0 || gpDiff > 0);
}

function totalsEqual(leftTotals, rightTotals) {
  return (
    (Number(leftTotals?.gathering) || 0) === (Number(rightTotals?.gathering) || 0) &&
    (Number(leftTotals?.perception) || 0) === (Number(rightTotals?.perception) || 0) &&
    (Number(leftTotals?.gp) || 0) === (Number(rightTotals?.gp) || 0)
  );
}

// Keep only states whose totals are not dominated by another state's totals.
//
// Many states share identical totals (the same stat line reached via different
// meld layouts — the variants the engine surfaces per result row). Equal-totals
// states neither dominate nor are dominated by one another, so they always
// survive or fall together as a group. The earlier implementation ran the
// dominance check once per state, which on the empty-target (advanced-mode)
// search meant O((variants * distinctTotals)^2) work as the frontier grew into
// the tens of thousands. Here we run the check once per *distinct totals group*
// instead. The output is identical — same surviving states, same order — because
// the sort is a total order on totals first, so equal-totals states are
// contiguous and any dominator sorts ahead of what it dominates.
function pruneDominatedStates(states) {
  const rows = Array.isArray(states) ? states : [];
  if (rows.length <= 1) {
    return rows;
  }

  const sorted = [...rows].sort((left, right) => {
    const leftTotals = left?.totals ?? emptyTotals();
    const rightTotals = right?.totals ?? emptyTotals();
    const gatheringDiff = (Number(rightTotals.gathering) || 0) - (Number(leftTotals.gathering) || 0);
    if (gatheringDiff !== 0) {
      return gatheringDiff;
    }
    const perceptionDiff = (Number(rightTotals.perception) || 0) - (Number(leftTotals.perception) || 0);
    if (perceptionDiff !== 0) {
      return perceptionDiff;
    }
    const gpDiff = (Number(rightTotals.gp) || 0) - (Number(leftTotals.gp) || 0);
    if (gpDiff !== 0) {
      return gpDiff;
    }
    return (Number(left?.meldCount) || 0) - (Number(right?.meldCount) || 0);
  });

  const frontier = [];
  const keptTotals = [];
  let groupStart = 0;
  while (groupStart < sorted.length) {
    const groupTotals = sorted[groupStart].totals ?? emptyTotals();
    let groupEnd = groupStart + 1;
    while (groupEnd < sorted.length && totalsEqual(sorted[groupEnd]?.totals, groupTotals)) {
      groupEnd += 1;
    }

    let dominated = false;
    for (const totals of keptTotals) {
      if (totalsDominate(totals, groupTotals)) {
        dominated = true;
        break;
      }
    }
    if (!dominated) {
      keptTotals.push(groupTotals);
      for (let i = groupStart; i < groupEnd; i += 1) {
        frontier.push(sorted[i]);
      }
    }

    groupStart = groupEnd;
  }

  return frontier;
}

function rebuildPath(leafState) {
  const path = [];
  let cursor = leafState;
  while (cursor?.prev) {
    path.push(cursor.segment);
    cursor = cursor.prev;
  }
  path.reverse();
  return path;
}

function getCandidateMeldCount(candidate) {
  return Array.isArray(candidate?.melds) ? candidate.melds.length : 0;
}

const DEFAULT_MAX_PLANS_PER_TOTAL = 5;

export function depthFirstSearch(config) {
  const pieces = Array.isArray(config?.pieceCandidates) ? config.pieceCandidates : [];
  const targets = config?.targets ?? {};
  const evaluate = typeof config?.evaluate === "function" ? config.evaluate : () => 0;
  const onProgress = typeof config?.onProgress === "function" ? config.onProgress : null;
  const maxResults = normalizePositiveInteger(config?.maxResults, 25);
  const maxBranches = normalizePositiveInteger(config?.maxBranches, 5000000);
  const maxDurationMs = normalizeNonNegativeInteger(config?.maxDurationMs, 3000);
  const maxPlansPerTotal = normalizePositiveInteger(
    config?.maxPlansPerTotal,
    DEFAULT_MAX_PLANS_PER_TOTAL,
  );

  if (pieces.length === 0) {
    return {
      results: [],
      visitedBranches: 0,
      terminatedEarly: false,
      terminatedByTime: false,
      pruneCounts: {
        target_unreachable: 0,
        score_bound: 0,
      },
      elapsedMs: 0,
    };
  }

  const startedAtMs = nowMs();
  const deadlineMs = startedAtMs + maxDurationMs;
  const hasTimeBudget = maxDurationMs > 0;
  const remainingMaxTotalsByIndex = buildRemainingMaxTotalsByIndex(pieces);

  let visitedBranches = 0;
  let terminatedEarly = false;
  let terminatedByTime = false;
  let currentPieceIndex = -1;
  let lastProgressAtMs = startedAtMs;
  const pruneCounts = {
    target_unreachable: 0,
    score_bound: 0,
  };

  function reportProgress(force = false) {
    if (!onProgress) {
      return;
    }
    const currentMs = nowMs();
    if (!force && currentMs - lastProgressAtMs < PROGRESS_MIN_INTERVAL_MS) {
      return;
    }
    lastProgressAtMs = currentMs;
    onProgress({
      visitedBranches,
      elapsedMs: Math.max(0, Math.round(currentMs - startedAtMs)),
      pieceIndex: currentPieceIndex,
      pieceCount: pieces.length,
      terminatedEarly,
      terminatedByTime,
    });
  }

  let currentStates = [
    {
      totals: emptyTotals(),
      offHandGathering: 0,
      meldCount: 0,
      baselineDistance: 0,
      prev: null,
      segment: null,
      layoutKey: "",
    },
  ];

  function markTimedOut() {
    terminatedEarly = true;
    terminatedByTime = true;
  }

  function deadlineReached() {
    return hasTimeBudget && nowMs() >= deadlineMs;
  }

  for (let pieceIndex = 0; pieceIndex < pieces.length; pieceIndex += 1) {
    currentPieceIndex = pieceIndex;
    if (terminatedEarly) {
      break;
    }

    if (deadlineReached()) {
      markTimedOut();
      break;
    }

    const pieceEntry = pieces[pieceIndex];
    const pieceRow = resolvePieceRow(pieceEntry);
    const candidateRows = Array.isArray(pieceEntry?.candidates) ? pieceEntry.candidates : [];
    const remainingMaxTotals = remainingMaxTotalsByIndex[pieceIndex + 1] ?? emptyTotals();

    if (candidateRows.length === 0) {
      continue;
    }

    const nextByTotals = new Map();
    for (const state of currentStates) {
      if (terminatedEarly) {
        break;
      }

      if (deadlineReached()) {
        markTimedOut();
        break;
      }

      for (const candidate of candidateRows) {
        if (
          hasTimeBudget &&
          visitedBranches > 0 &&
          visitedBranches % TIME_BUDGET_CHECK_INTERVAL === 0 &&
          deadlineReached()
        ) {
          markTimedOut();
          break;
        }
        if (visitedBranches >= maxBranches) {
          terminatedEarly = true;
          reportProgress(true);
          break;
        }
        visitedBranches += 1;
        if (visitedBranches % PROGRESS_BRANCH_INTERVAL === 0) {
          reportProgress(false);
        }

        const nextTotals = addTotals(state.totals, candidate.totals);
        if (!canReachTargets(nextTotals, remainingMaxTotals, targets)) {
          pruneCounts.target_unreachable += 1;
          continue;
        }

        const key = totalsKey(nextTotals);
        const nextState = {
          totals: nextTotals,
          offHandGathering:
            (Number(state?.offHandGathering) || 0) + candidateOffHandGathering(pieceRow, candidate),
          meldCount: (Number(state?.meldCount) || 0) + getCandidateMeldCount(candidate),
          baselineDistance:
            (Number(state?.baselineDistance) || 0) + (Number(candidate?.__baselineDistance) || 0),
          prev: state,
          segment: {
            piece: pieceRow,
            candidate,
          },
          layoutKey: state.layoutKey
            ? `${state.layoutKey};${buildSegmentLayoutKey(pieceRow, candidate)}`
            : buildSegmentLayoutKey(pieceRow, candidate),
        };

        const existing = nextByTotals.get(key);
        if (!existing) {
          nextByTotals.set(key, [nextState]);
          continue;
        }

        const duplicateIndex = existing.findIndex(
          (keptState) => keptState.layoutKey === nextState.layoutKey,
        );
        if (duplicateIndex >= 0) {
          if (compareStateRetentionPriority(nextState, existing[duplicateIndex]) < 0) {
            existing[duplicateIndex] = nextState;
          }
          continue;
        }

        if (existing.length < maxPlansPerTotal) {
          existing.push(nextState);
          continue;
        }

        let worstIdx = 0;
        for (let i = 1; i < existing.length; i += 1) {
          if (compareStateRetentionPriority(existing[worstIdx], existing[i]) < 0) {
            worstIdx = i;
          }
        }
        if (compareStateRetentionPriority(nextState, existing[worstIdx]) < 0) {
          existing[worstIdx] = nextState;
        }
      }
    }

    const rawNextStates = Array.from(nextByTotals.values()).flat();
    currentStates = pruneDominatedStates(rawNextStates);
    if (currentStates.length === 0) {
      break;
    }
  }

  const results = [];
  const timedOutResultCap = Math.max(
    1,
    Math.min(maxResults * TIMED_OUT_RESULT_OVERSAMPLE_FACTOR, TIMED_OUT_RESULT_HARD_CAP),
  );
  for (const state of currentStates) {
    if (terminatedByTime && results.length >= timedOutResultCap) {
      break;
    }
    if (!terminatedByTime && deadlineReached()) {
      markTimedOut();
      break;
    }
    const score = Number(evaluate(state.totals, state));
    results.push({
      score: Number.isFinite(score) ? score : Number.NEGATIVE_INFINITY,
      totals: state.totals,
      offHandGathering: Number(state?.offHandGathering) || 0,
      baselineDistance: Number(state?.baselineDistance) || 0,
      path: rebuildPath(state),
      meldCount: state.meldCount,
      layoutKey: state.layoutKey,
    });
  }

  if (!terminatedByTime && deadlineReached()) {
    markTimedOut();
  }
  sortedTopResults(results, maxResults);
  reportProgress(true);

  return {
    results: results.map((entry) => ({
      score: entry.score,
      totals: entry.totals,
      offHandGathering: entry.offHandGathering,
      baselineDistance: entry.baselineDistance,
      path: entry.path,
    })),
    visitedBranches,
    terminatedEarly,
    terminatedByTime,
    pruneCounts,
    elapsedMs: Math.max(0, Math.round(nowMs() - startedAtMs)),
  };
}

