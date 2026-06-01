import { normalizeNonNegativeInteger } from "./normalize.js";

export const STAT_KEYS = Object.freeze(["gathering", "perception", "gp"]);

export function summarizeTotals(totals) {
  return {
    gathering: normalizeNonNegativeInteger(totals?.gathering, 0),
    perception: normalizeNonNegativeInteger(totals?.perception, 0),
    gp: normalizeNonNegativeInteger(totals?.gp, 0),
  };
}

export function hasAnyTargets(targets) {
  const safe = summarizeTotals(targets);
  return safe.gathering + safe.perception + safe.gp > 0;
}
