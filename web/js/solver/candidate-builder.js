const STAT_KEYS = Object.freeze(["gathering", "perception", "gp"]);

function normalizePositiveInteger(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function getPieceCaps(piece, options = {}) {
  const caps = {};
  const sourceCaps = piece?.tracked_meld_caps;
  // tracked_meld_caps is computed from HQ stats. When NQ stats are used on a
  // HQ-capable piece, the true cap is larger by the HQ bonus amount.
  const adjustForNq = options.useGearHq === false && Boolean(piece?.can_be_hq);
  for (const key of STAT_KEYS) {
    let cap = normalizePositiveInteger(sourceCaps?.[key], 0);
    if (adjustForNq) {
      cap += normalizePositiveInteger(piece?.tracked_special_stats?.[key], 0);
    }
    if (cap > 0) {
      caps[key] = cap;
    }
  }
  return caps;
}

function getEffectiveGain(materia, pieceCaps, candidateTotals) {
  const statKey = materia.stat;
  const hardCap = pieceCaps[statKey];
  const baseValue = normalizePositiveInteger(materia.value, 0);

  if (!hardCap) {
    return baseValue;
  }

  const used = normalizePositiveInteger(candidateTotals[statKey], 0);
  const remaining = Math.max(0, hardCap - used);
  return Math.min(baseValue, remaining);
}

function buildPieceSlots(piece, rules) {
  const maxTotalSlots = normalizePositiveInteger(
    rules?.constants?.max_total_materia_slots_per_piece,
    5,
  );
  const maxOvermeldSlots = normalizePositiveInteger(
    rules?.constants?.max_overmeld_slots_per_piece,
    4,
  );
  const guaranteedSlots = normalizePositiveInteger(piece?.guaranteed_materia_slots, 0);
  const normalizedGuaranteed = Math.min(guaranteedSlots, maxTotalSlots);

  const allowedOvermeldSlots = piece?.advanced_melding_permitted
    ? Math.min(Math.max(0, maxTotalSlots - normalizedGuaranteed), maxOvermeldSlots)
    : 0;

  const slots = [];
  for (let idx = 0; idx < normalizedGuaranteed; idx += 1) {
    slots.push({
      slotIndex: idx,
      isOvermeld: false,
      overmeldIndex: null,
    });
  }
  for (let idx = 0; idx < allowedOvermeldSlots; idx += 1) {
    slots.push({
      slotIndex: normalizedGuaranteed + idx,
      isOvermeld: true,
      overmeldIndex: idx,
    });
  }

  return slots;
}

function isMateriaLegalForSlot(materia, slot) {
  if (!slot.isOvermeld) {
    return true;
  }

  const overmeldIndex = slot.overmeldIndex;
  const allowedSlots = Array.isArray(materia.overmeld_allowed_slots)
    ? materia.overmeld_allowed_slots
    : [];
  if (!allowedSlots.includes(overmeldIndex)) {
    return false;
  }

  const rates = Array.isArray(materia.overmeld_rates_nq) ? materia.overmeld_rates_nq : [];
  const rateAtIndex = Number(rates[overmeldIndex] ?? 0);
  return Number.isFinite(rateAtIndex) && rateAtIndex > 0;
}

function buildLegalMateriaBySlot(slots, materiaRows) {
  const rowsBySlotIndex = new Map();

  for (const slot of slots) {
    const legalRows = materiaRows
      .filter((row) => isMateriaLegalForSlot(row, slot))
      .sort((left, right) => {
        const gradeDiff =
          normalizePositiveInteger(right?.grade, 0) - normalizePositiveInteger(left?.grade, 0);
        if (gradeDiff !== 0) {
          return gradeDiff;
        }
        return normalizePositiveInteger(right?.value, 0) - normalizePositiveInteger(left?.value, 0);
      });
    rowsBySlotIndex.set(slot.slotIndex, legalRows);
  }

  return rowsBySlotIndex;
}

function createEmptyTotals() {
  return {
    gathering: 0,
    perception: 0,
    gp: 0,
  };
}

function candidateSignature(candidate) {
  if (!candidate || !Array.isArray(candidate.melds) || candidate.melds.length === 0) {
    return "empty";
  }
  return candidate.melds
    .map(
      (meld) =>
        `${meld.slotIndex}:${meld.itemId ?? "x"}:${meld.stat}:${meld.grade}:${meld.appliedValue}`,
    )
    .join("|");
}

function candidateValue(candidate) {
  if (!candidate || !candidate.totals) {
    return 0;
  }
  return (
    normalizePositiveInteger(candidate.totals.gathering, 0) +
    normalizePositiveInteger(candidate.totals.perception, 0) +
    normalizePositiveInteger(candidate.totals.gp, 0)
  );
}

function getCandidateStat(candidate, statKey) {
  return normalizePositiveInteger(candidate?.totals?.[statKey], 0);
}

function meldCount(candidate) {
  return Array.isArray(candidate?.melds) ? candidate.melds.length : 0;
}

function isOffHandPiece(piece) {
  return String(piece?.slot ?? "") === "off_hand";
}

function gatheringPerceptionDelta(candidate) {
  const gathering = getCandidateStat(candidate, "gathering");
  const perception = getCandidateStat(candidate, "perception");
  return Math.abs(gathering - perception);
}

function weakerMainStat(candidate) {
  const gathering = getCandidateStat(candidate, "gathering");
  const perception = getCandidateStat(candidate, "perception");
  return Math.min(gathering, perception);
}

function sortForPreference(left, right, piece) {
  const valueDiff = candidateValue(right) - candidateValue(left);
  if (valueDiff !== 0) {
    return valueDiff;
  }

  if (isOffHandPiece(piece)) {
    const perceptionDiff = getCandidateStat(right, "perception") - getCandidateStat(left, "perception");
    if (perceptionDiff !== 0) {
      return perceptionDiff;
    }
    const gatheringDiff = getCandidateStat(right, "gathering") - getCandidateStat(left, "gathering");
    if (gatheringDiff !== 0) {
      return gatheringDiff;
    }
  } else {
    const balanceDiff = gatheringPerceptionDelta(left) - gatheringPerceptionDelta(right);
    if (balanceDiff !== 0) {
      return balanceDiff;
    }
    const weakerStatDiff = weakerMainStat(right) - weakerMainStat(left);
    if (weakerStatDiff !== 0) {
      return weakerStatDiff;
    }
    const perceptionDiff = getCandidateStat(right, "perception") - getCandidateStat(left, "perception");
    if (perceptionDiff !== 0) {
      return perceptionDiff;
    }
  }

  const gpDiff = getCandidateStat(right, "gp") - getCandidateStat(left, "gp");
  if (gpDiff !== 0) {
    return gpDiff;
  }
  const meldCountDiff = meldCount(left) - meldCount(right);
  if (meldCountDiff !== 0) {
    return meldCountDiff;
  }
  return candidateSignature(left).localeCompare(candidateSignature(right));
}

function candidateDominates(left, right) {
  const gatheringDiff = getCandidateStat(left, "gathering") - getCandidateStat(right, "gathering");
  const perceptionDiff = getCandidateStat(left, "perception") - getCandidateStat(right, "perception");
  const gpDiff = getCandidateStat(left, "gp") - getCandidateStat(right, "gp");
  return (
    gatheringDiff >= 0 &&
    perceptionDiff >= 0 &&
    gpDiff >= 0 &&
    (gatheringDiff > 0 || perceptionDiff > 0 || gpDiff > 0)
  );
}

function buildParetoFrontier(candidates, piece) {
  if (!Array.isArray(candidates) || candidates.length <= 1) {
    return Array.isArray(candidates) ? candidates : [];
  }

  const frontier = [];
  const sorted = [...candidates].sort((left, right) => sortForPreference(left, right, piece));
  for (const candidate of sorted) {
    let dominated = false;
    for (const kept of frontier) {
      if (candidateDominates(kept, candidate)) {
        dominated = true;
        break;
      }
    }
    if (dominated) {
      continue;
    }

    for (let i = frontier.length - 1; i >= 0; i -= 1) {
      if (candidateDominates(candidate, frontier[i])) {
        frontier.splice(i, 1);
      }
    }
    frontier.push(candidate);
  }

  return frontier;
}

function buildEmptyCandidate(piece) {
  return {
    pieceId: piece.id,
    pieceName: piece.name,
    pieceSlot: piece.slot,
    focus: "empty",
    melds: [],
    totals: createEmptyTotals(),
  };
}

function totalsKey(totals) {
  return `${normalizePositiveInteger(totals?.gathering, 0)}|${normalizePositiveInteger(totals?.perception, 0)}|${normalizePositiveInteger(totals?.gp, 0)}`;
}

function createMeldRecord(slot, materia, appliedValue) {
  return {
    slotIndex: slot.slotIndex,
    isOvermeld: slot.isOvermeld,
    overmeldIndex: slot.overmeldIndex,
    stat: materia.stat,
    grade: materia.grade,
    itemId: materia.item_id,
    name: materia.name,
    rawValue: normalizePositiveInteger(materia.value, 0),
    appliedValue,
  };
}

// Materia overkill: raw value the cap clamped away (raw - applied), summed over a
// layout's melds. Zero when nothing is capped. Among layouts that reach the same
// totals with the same meld count, the one with less waste uses lower-grade
// materia for the same result — e.g. a Grade VII clamped to +6 wastes 6, while a
// lower grade that still fills the +6 of cap room wastes nothing.
function candidateWastedValue(candidate) {
  const melds = Array.isArray(candidate?.melds) ? candidate.melds : [];
  let waste = 0;
  for (const meld of melds) {
    const raw = normalizePositiveInteger(meld?.rawValue, 0);
    const applied = normalizePositiveInteger(meld?.appliedValue, 0);
    if (raw > applied) {
      waste += raw - applied;
    }
  }
  return waste;
}

function shouldPreferCandidateByMelds(nextCandidate, currentCandidate) {
  if (!currentCandidate) {
    return true;
  }

  const nextMeldCount = Array.isArray(nextCandidate?.melds) ? nextCandidate.melds.length : 0;
  const currentMeldCount = Array.isArray(currentCandidate?.melds) ? currentCandidate.melds.length : 0;
  if (nextMeldCount !== currentMeldCount) {
    return nextMeldCount < currentMeldCount;
  }

  // Identical totals and meld count: prefer the layout that wastes the least
  // materia, so the solver doesn't melt a needlessly high grade into a slot the
  // cap clamps anyway. Lower grades only reach here if legal for the slot, so an
  // illegal lower grade never displaces a legal higher one.
  const nextWaste = candidateWastedValue(nextCandidate);
  const currentWaste = candidateWastedValue(currentCandidate);
  if (nextWaste !== currentWaste) {
    return nextWaste < currentWaste;
  }

  const nextSignature = candidateSignature(nextCandidate);
  const currentSignature = candidateSignature(currentCandidate);
  return nextSignature < currentSignature;
}

// Remove partial layouts already dominated in every stat AND in meld count:
// another reachable layout matches or beats them on gathering, perception, and
// gp while using no more melds. Because cap-clamped meld gains are monotonic, a
// state dominated here stays dominated after any further melds, so it can never
// extend into a surviving candidate. Pruning it leaves the final stat frontier
// and every surviving stat line's meld count unchanged — it only avoids
// exploring combinations that are already beaten. (Among equally-minimal layouts
// for the same stat line the specific materia chosen is an arbitrary tie-break,
// so it can differ from a fully unpruned enumeration; the stats and meld count
// are identical.)
function pruneDominatedPieceStates(states) {
  if (states.length <= 1) {
    return states;
  }

  const sorted = states.sort((left, right) => {
    const leftTotals = left.totals;
    const rightTotals = right.totals;
    return (
      rightTotals.gathering - leftTotals.gathering ||
      rightTotals.perception - leftTotals.perception ||
      rightTotals.gp - leftTotals.gp ||
      left.melds.length - right.melds.length
    );
  });

  const frontier = [];
  for (const state of sorted) {
    const totals = state.totals;
    const meldCount = state.melds.length;
    let dominated = false;
    for (const kept of frontier) {
      const keptTotals = kept.totals;
      if (
        keptTotals.gathering >= totals.gathering &&
        keptTotals.perception >= totals.perception &&
        keptTotals.gp >= totals.gp &&
        kept.melds.length <= meldCount &&
        (keptTotals.gathering > totals.gathering ||
          keptTotals.perception > totals.perception ||
          keptTotals.gp > totals.gp ||
          kept.melds.length < meldCount)
      ) {
        dominated = true;
        break;
      }
    }
    if (!dominated) {
      frontier.push(state);
    }
  }

  return frontier;
}

function enumerateAllPieceCandidates(piece, slots, legalMateriaBySlot, pieceCaps, prune = false) {
  if (slots.length === 0) {
    return [buildEmptyCandidate(piece)];
  }

  const initialState = {
    totals: createEmptyTotals(),
    melds: [],
  };
  let states = [initialState];

  for (const slot of slots) {
    const legalMateriaRows = legalMateriaBySlot.get(slot.slotIndex) ?? [];
    const nextByTotals = new Map();

    for (const state of states) {
      const keepKey = totalsKey(state.totals);
      if (!nextByTotals.has(keepKey) || shouldPreferCandidateByMelds(state, nextByTotals.get(keepKey))) {
        nextByTotals.set(keepKey, state);
      }

      for (const materia of legalMateriaRows) {
        const appliedValue = getEffectiveGain(materia, pieceCaps, state.totals);
        if (appliedValue <= 0) {
          continue;
        }

        const nextTotals = { ...state.totals };
        nextTotals[materia.stat] = normalizePositiveInteger(nextTotals[materia.stat], 0) + appliedValue;
        const nextState = {
          totals: nextTotals,
          melds: [...state.melds, createMeldRecord(slot, materia, appliedValue)],
        };

        const nextKey = totalsKey(nextTotals);
        if (!nextByTotals.has(nextKey) || shouldPreferCandidateByMelds(nextState, nextByTotals.get(nextKey))) {
          nextByTotals.set(nextKey, nextState);
        }
      }
    }

    states = Array.from(nextByTotals.values());
    if (prune) {
      states = pruneDominatedPieceStates(states);
    }
  }

  const candidates = states.map((state) => ({
    pieceId: piece.id,
    pieceName: piece.name,
    pieceSlot: piece.slot,
    focus: "bruteforce",
    melds: state.melds,
    totals: state.totals,
  }));

  const hasEmpty = candidates.some((candidate) => candidate.melds.length === 0);
  if (!hasEmpty) {
    candidates.push(buildEmptyCandidate(piece));
  }

  const deduped = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const key = candidateSignature(candidate);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(candidate);
  }

  deduped.sort((left, right) => {
    return sortForPreference(left, right, piece);
  });
  return deduped;
}

export function buildCandidatesForPiece(piece, options) {
  const rules = options?.rules ?? {};
  const useGearHq = options?.useGearHq !== false;
  const rawMaxCandidatesPerPiece = Number(options?.maxCandidatesPerPiece);
  const hasMaxCandidatesLimit = Number.isFinite(rawMaxCandidatesPerPiece) && rawMaxCandidatesPerPiece > 0;
  const maxCandidatesPerPiece = hasMaxCandidatesLimit
    ? Math.floor(rawMaxCandidatesPerPiece)
    : Number.POSITIVE_INFINITY;
  const materiaRows = Array.isArray(options?.materiaRows) ? options.materiaRows : [];

  const slots = buildPieceSlots(piece, rules);
  if (slots.length === 0 || materiaRows.length === 0) {
    return [buildEmptyCandidate(piece)];
  }

  const pieceCaps = getPieceCaps(piece, { useGearHq });
  const legalMateriaBySlot = buildLegalMateriaBySlot(slots, materiaRows);
  // Always prune dominated partial layouts (lossless for the stat frontier).
  // Both the fast and the thorough ("brute force") search use this — the modes
  // differ only in their branch/time budgets, not in pruning correctness.
  const exhaustive = enumerateAllPieceCandidates(piece, slots, legalMateriaBySlot, pieceCaps, true);

  const frontier = buildParetoFrontier(exhaustive, piece);
  frontier.sort((left, right) => {
    return sortForPreference(left, right, piece);
  });
  return frontier.slice(0, maxCandidatesPerPiece);
}
