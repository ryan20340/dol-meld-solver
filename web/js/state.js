import { buildDefaultAdvancedState } from "./advanced-config.js";

export function createInitialState() {
  return {
    data: null,
    selectedGearRows: [],
    selectedGearBySlot: {},
    gear: {
      useHq: true,
    },
    targets: {
      gathering: 0,
      perception: 0,
      gp: 0,
    },
    draftTargets: {
      gathering: 0,
      perception: 0,
      gp: 0,
    },
    food: {
      isFixed: true,
      selectedFoodId: 0,
      useHq: true,
    },
    solve: {
      maxResults: 25,
      timeBudgetMs: 10000,
      maxBranches: 5000000,
      useBruteForce: false,
      // Grades the player has disallowed per materia-slot tier. Empty = every
      // grade allowed (default). Tiers mirror the meld-dot colors: guaranteed
      // (green), overmeldFirst (yellow), overmeld (red). Applies to all solves.
      disallowedGradesByTier: {
        guaranteed: [],
        overmeldFirst: [],
        overmeld: [],
      },
    },
    advanced: buildDefaultAdvancedState(),
    solveDiagnostics: null,
    results: [],
    ui: {
      controlsCollapsed: false,
    },
    savedPlans: [],
    savedPlansUi: {
      viewPlanId: null,
      editingPlanId: null,
      breakpointCheckViewPlanId: null,
      refineDialog: null,
      draftsByPlanId: {},
      previewByPlanId: {},
      breakpointCheckFoodByPlanId: {},
      breakpointCheckPreviewByPlanId: {},
      availableGradesByStat: {
        gathering: [],
        perception: [],
        gp: [],
      },
      overmeldAllowedGradesByStat: {
        gathering: {},
        perception: {},
        gp: {},
      },
      gradeValueIndexByStat: null,
    },
    resultsUi: {
      diffEnabledByPlanKey: {},
      openPlanDetailsByPlanKey: {},
    },
  };
}
