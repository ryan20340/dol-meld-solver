export function createInitialState() {
  const defaultAdvancedProfiles = [
    {
      id: "profile_1",
      name: "Profile 1",
      enabled: true,
      useHq: true,
      allowedFoodIds: [],
      breakpoints: [],
    },
  ];

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
      maxResults: 10,
      timeBudgetMs: 10000,
      maxBranches: 5000000,
      useBruteForce: false,
    },
    advanced: {
      enabled: false,
      activeProfileIndex: 0,
      nextProfileId: 2,
      nextBreakpointId: 1,
      profiles: defaultAdvancedProfiles,
    },
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
    },
  };
}
