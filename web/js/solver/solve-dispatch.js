import { solveAdvancedMode } from "./advanced-mode-solver.js";
import { solveNormalMode } from "./normal-mode-solver.js";
import { normalizeSolverMode, SOLVER_MODES } from "./solver-modes.js";

export function solveByMode(mode, solveInput, options = {}) {
  const normalizedMode = normalizeSolverMode(mode);
  if (normalizedMode === SOLVER_MODES.ADVANCED) {
    return solveAdvancedMode(solveInput, options);
  }
  return solveNormalMode(solveInput, options);
}