import { solveLegalityOnly } from "./engine.js";

const NORMAL_MODE_MAX_RESULTS_LIMIT = 25;

function normalizeNonNegativeInteger(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function summarizeTotals(totals) {
  return {
    gathering: normalizeNonNegativeInteger(totals?.gathering, 0),
    perception: normalizeNonNegativeInteger(totals?.perception, 0),
    gp: normalizeNonNegativeInteger(totals?.gp, 0),
  };
}

export function buildNormalSolveInput(state, options = {}) {
  const targetOverride = options?.targetsOverride;
  const targets = targetOverride ? summarizeTotals(targetOverride) : summarizeTotals(state?.targets);
  const maxResults = Math.min(
    NORMAL_MODE_MAX_RESULTS_LIMIT,
    Math.max(1, normalizeNonNegativeInteger(state?.solve?.maxResults, NORMAL_MODE_MAX_RESULTS_LIMIT)),
  );

  return {
    selectedGearRows: state?.selectedGearRows,
    materiaRows: state?.data?.materia?.rows,
    rules: state?.data?.rules,
    targets,
    maxResults,
    maxBranches: state?.solve?.maxBranches,
    maxDurationMs: state?.solve?.timeBudgetMs,
    maxCandidatesPerPiece: 0,
    useBruteForce: state?.solve?.useBruteForce === true,
    useGearHq: state?.gear?.useHq,
    baseGathererGp: options?.baseGathererGp,
  };
}

export function solveNormalMode(solveInput, options = {}) {
  return solveLegalityOnly(solveInput, options);
}
