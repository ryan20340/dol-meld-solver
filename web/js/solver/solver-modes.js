export const SOLVER_MODES = Object.freeze({
  NORMAL: "normal",
  ADVANCED: "advanced",
});

export function normalizeSolverMode(value) {
  const mode = String(value ?? "").trim().toLowerCase();
  if (mode === SOLVER_MODES.ADVANCED) {
    return SOLVER_MODES.ADVANCED;
  }
  return SOLVER_MODES.NORMAL;
}

export function isAdvancedSolverMode(value) {
  return normalizeSolverMode(value) === SOLVER_MODES.ADVANCED;
}