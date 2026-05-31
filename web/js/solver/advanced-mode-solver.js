import { solveLegalityOnly } from "./engine.js";

export const ADVANCED_FRONTIER_RESULT_LIMIT = 12000;

export function buildAdvancedSolveInput(state, options = {}) {
  return {
    selectedGearRows: state?.selectedGearRows,
    materiaRows: state?.data?.materia?.rows,
    rules: state?.data?.rules,
    targets: { gathering: 0, perception: 0, gp: 0 },
    maxResults: options?.frontierResultLimit ?? ADVANCED_FRONTIER_RESULT_LIMIT,
    maxBranches: state?.solve?.maxBranches,
    maxDurationMs: state?.solve?.timeBudgetMs,
    maxCandidatesPerPiece: 0,
    useBruteForce: state?.solve?.useBruteForce === true,
    useGearHq: state?.gear?.useHq,
    baseGathererGp: options?.baseGathererGp,
  };
}

export function solveAdvancedMode(solveInput, options = {}) {
  const input = {
    ...(solveInput ?? {}),
    targets: { gathering: 0, perception: 0, gp: 0 },
  };
  return solveLegalityOnly(input, options);
}
