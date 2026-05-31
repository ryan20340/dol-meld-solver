function normalizeTarget(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return Math.floor(parsed);
}

function addTotals(left, right) {
  return {
    gathering: (Number(left?.gathering) || 0) + (Number(right?.gathering) || 0),
    perception: (Number(left?.perception) || 0) + (Number(right?.perception) || 0),
    gp: (Number(left?.gp) || 0) + (Number(right?.gp) || 0),
  };
}

export function canPruneBranch(context) {
  const targets = {
    gathering: normalizeTarget(context?.targets?.gathering),
    perception: normalizeTarget(context?.targets?.perception),
    gp: normalizeTarget(context?.targets?.gp),
  };

  const hasTargets = targets.gathering + targets.perception + targets.gp > 0;

  const current = context?.currentTotals ?? {};
  const remaining = context?.remainingMaxTotals ?? {};
  const projected = addTotals(current, remaining);

  if (
    hasTargets &&
    (
      projected.gathering < targets.gathering ||
      projected.perception < targets.perception ||
      projected.gp < targets.gp
    )
  ) {
    return {
      prune: true,
      reason: "target_unreachable",
      projectedTotals: projected,
    };
  }

  const minimumScoreToKeep = Number(context?.minimumScoreToKeep);
  const evaluate = context?.evaluate;
  if (Number.isFinite(minimumScoreToKeep) && typeof evaluate === "function") {
    const optimisticScore = Number(evaluate(projected));
    if (Number.isFinite(optimisticScore) && optimisticScore <= minimumScoreToKeep) {
      return {
        prune: true,
        reason: "score_bound",
        optimisticScore,
        projectedTotals: projected,
      };
    }
  }

  return {
    prune: false,
    reason: null,
    projectedTotals: projected,
  };
}
