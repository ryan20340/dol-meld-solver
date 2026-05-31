function normalizeTarget(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return Math.floor(parsed);
}

export function scoreCandidate(candidateTotals, targets) {
  const totals = candidateTotals ?? {};
  const targetValues = {
    gathering: normalizeTarget(targets?.gathering),
    perception: normalizeTarget(targets?.perception),
    gp: normalizeTarget(targets?.gp),
  };

  const totalTarget = targetValues.gathering + targetValues.perception + targetValues.gp;
  const totalStats =
    (Number(totals.gathering) || 0) + (Number(totals.perception) || 0) + (Number(totals.gp) || 0);

  if (totalTarget === 0) {
    return totalStats;
  }

  const deficits = {
    gathering: Math.max(0, targetValues.gathering - (Number(totals.gathering) || 0)),
    perception: Math.max(0, targetValues.perception - (Number(totals.perception) || 0)),
    gp: Math.max(0, targetValues.gp - (Number(totals.gp) || 0)),
  };
  const deficitTotal = deficits.gathering + deficits.perception + deficits.gp;

  return totalStats - deficitTotal * 100000;
}
