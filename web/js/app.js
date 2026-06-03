import { loadProcessedData, summarizeProcessedData } from "./data-loader.js";
import { createInitialState } from "./state.js";
import {
  ADVANCED_STAT_DUMP,
  createDefaultBreakpoint,
  createDefaultProfile,
  normalizeAdvancedConfig,
  normalizeAdvancedProfile,
  normalizeAdvancedStatDump,
  normalizeBreakpoint,
} from "./advanced-config.js";
import { buildAutoSelectedGearSet } from "./solver/engine.js";
import { ADVANCED_FRONTIER_RESULT_LIMIT, buildAdvancedSolveInput } from "./solver/advanced-mode-solver.js";
import { buildNormalSolveInput } from "./solver/normal-mode-solver.js";
import { scoreCandidate } from "./solver/score.js";
import { solveByMode } from "./solver/solve-dispatch.js";
import {
  applyAdvancedMode,
  buildAdvancedSummaryForTotals,
  compareAdvancedBreakpointSummaries,
  evaluateSavedPlanBreakpointCheck,
  normalizeSavedPlanBreakpointFoodDraftEntry,
  savedPlanTotalsWithoutFood,
  selectActiveAdvancedProfiles,
} from "./solver/advanced-postprocess.js";
import { isAdvancedSolverMode, SOLVER_MODES } from "./solver/solver-modes.js";
import { renderControlsPanel } from "./ui/controls.js";
import { renderGearEditor } from "./ui/gear-editor.js";
import { renderResultsTable } from "./ui/results-table.js";
import { computeFoodDeltaForTotals } from "./utils/food.js";
import { BASE_GATHERER_GP, getGearRowTrackedStats, statSum } from "./utils/gear-stats.js";
import { normalizeNonNegativeInteger, normalizeOptionalPriority } from "./utils/normalize.js";
import { hasAnyTargets, STAT_KEYS, summarizeTotals } from "./utils/stats.js";
import {
  applyDraftToSavedPlan,
  buildAvailableGradesByStat,
  buildOvermeldAllowedGradesByStat,
  buildMateriaGradeValueIndex,
  createDraftFromSavedPlan,
  createSavedPlanFromResult,
  duplicateSavedPlan,
  exportSavedPlanText,
  getMaxSavedPlans,
  loadSavedPlans,
  persistSavedPlans,
} from "./saved-plans.js";

const STAT_LABELS = Object.freeze({
  gathering: "Gathering",
  perception: "Perception",
  gp: "GP",
});
const SLOT_LABELS = Object.freeze({
  main_hand: "Main Hand",
  off_hand: "Off Hand",
  head: "Head",
  body: "Body",
  hands: "Hands",
  waist: "Waist",
  legs: "Legs",
  feet: "Feet",
  ears: "Ears",
  neck: "Neck",
  wrists: "Wrists",
  ring: "Ring",
});
const REFINE_OBJECTIVES = Object.freeze({
  IMPROVE_SCORE: "improve_score",
  HIT_NEW_TARGETS: "hit_new_targets",
});
const CONTROLS_COLLAPSE_STORAGE_KEY = "dol-meld-solver-controls-collapsed";
const ADVANCED_CONFIG_STORAGE_KEY = "dol-meld-solver-advanced-config-v1";
const GEARSET_STORAGE_KEY = "dol-meld-solver-gearset-v1";
const ADVANCED_PRESET_75_URL = new URL("./presets/current-advanced-preset.json", import.meta.url);
const ADVANCED_FRONTIER_GROWTH_FACTOR = 2;
const ADVANCED_FRONTIER_HARD_CAP = 96000;
const ADVANCED_FRONTIER_MAX_WIDEN_ATTEMPTS = 3;
const ADVANCED_FRONTIER_WALLTIME_GUARD_MULTIPLIER = 1.6;
const NORMAL_MODE_MAX_RESULTS_LIMIT = 25;
const ADVANCED_MODE_MAX_RESULTS_LIMIT = 10;
const ADVANCED_MODE_VARIANT_LIMIT = 5;

const state = createInitialState();
let loadedSummary = null;

let solverWorker = null;
let workerRequestSeq = 0;
let latestSolveToken = 0;
const pendingWorkerRequests = new Map();

const statusElement = document.getElementById("status");
const appMainElement = document.querySelector(".app-main");
const controlsToggleElement = document.getElementById("controls-toggle");
const controlsPanelElement = document.getElementById("controls-panel");
const resultsPanelElement = document.getElementById("results-panel");
const solveLoadingElement = document.getElementById("solve-loading");
const solveLoadingMessageElement = document.getElementById("solve-loading-message");
const solveLoadingElapsedElement = document.getElementById("solve-loading-elapsed");
const solveLoadingVisitedElement = document.getElementById("solve-loading-visited");
const SOLVE_LOADING_SEARCHING_MESSAGE = "Solving meld plans...";
const SOLVE_LOADING_BUILDING_MESSAGE = "Building meld options...";
let solveLoadingActiveToken = 0;
let solveLoadingStartedAtMs = 0;
let solveLoadingIntervalId = null;
let solveLoadingProgress = {
  elapsedMs: 0,
  visitedBranches: 0,
};

function canUseLocalStorage() {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return Boolean(window.localStorage);
  } catch (_error) {
    return false;
  }
}

function readLocalStorageItem(key, warningMessage) {
  if (!canUseLocalStorage()) {
    return null;
  }
  try {
    return window.localStorage.getItem(key);
  } catch (error) {
    if (warningMessage) {
      console.warn(warningMessage, error);
    }
    return null;
  }
}

function writeLocalStorageItem(key, value, warningMessage) {
  if (!canUseLocalStorage()) {
    return false;
  }
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch (error) {
    if (warningMessage) {
      console.warn(warningMessage, error);
    }
    return false;
  }
}

function readLocalStorageJson(key, warningMessage) {
  const raw = readLocalStorageItem(key, warningMessage);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    if (warningMessage) {
      console.warn(warningMessage, error);
    }
    return null;
  }
}

function writeLocalStorageJson(key, value, warningMessage) {
  return writeLocalStorageItem(key, JSON.stringify(value), warningMessage);
}

function normalizeRingSlotMap(map) {
  const normalized = map && typeof map === "object" ? { ...map } : {};

  if (Object.prototype.hasOwnProperty.call(normalized, "ring")) {
    const ringId = normalizeNonNegativeInteger(normalized.ring, 0);
    if (!Object.prototype.hasOwnProperty.call(normalized, "ring_left")) {
      normalized.ring_left = ringId;
    }
    if (!Object.prototype.hasOwnProperty.call(normalized, "ring_right")) {
      normalized.ring_right = ringId;
    }
    delete normalized.ring;
  }

  const hasLeft = Object.prototype.hasOwnProperty.call(normalized, "ring_left");
  const hasRight = Object.prototype.hasOwnProperty.call(normalized, "ring_right");
  if (hasLeft && !hasRight) {
    normalized.ring_right = normalizeNonNegativeInteger(normalized.ring_left, 0);
  }
  if (hasRight && !hasLeft) {
    normalized.ring_left = normalizeNonNegativeInteger(normalized.ring_right, 0);
  }

  return normalized;
}

function setRingSelection(map, leftRingId, rightRingId = leftRingId) {
  if (!map || typeof map !== "object") {
    return;
  }
  map.ring_left = normalizeNonNegativeInteger(leftRingId, 0);
  map.ring_right = normalizeNonNegativeInteger(rightRingId, map.ring_left);
}

function applyControlsPanelVisibility() {
  if (!appMainElement || !controlsToggleElement) {
    return;
  }

  const collapsed = state?.ui?.controlsCollapsed === true;
  appMainElement.classList.toggle("controls-collapsed", collapsed);
  controlsToggleElement.textContent = collapsed ? ">" : "<";
  controlsToggleElement.setAttribute(
    "aria-label",
    collapsed ? "Show inputs panel" : "Hide inputs panel",
  );
  controlsToggleElement.setAttribute("title", collapsed ? "Show inputs" : "Hide inputs");
  controlsToggleElement.setAttribute("aria-expanded", collapsed ? "false" : "true");
}

function setControlsCollapsed(collapsed, options = {}) {
  state.ui.controlsCollapsed = collapsed === true;
  applyControlsPanelVisibility();

  if (options?.persist === false) {
    return;
  }

  writeLocalStorageItem(
    CONTROLS_COLLAPSE_STORAGE_KEY,
    state.ui.controlsCollapsed ? "1" : "0",
    "Unable to persist controls panel toggle state.",
  );
}

function initializeControlsPanelToggle() {
  const persisted = readLocalStorageItem(
    CONTROLS_COLLAPSE_STORAGE_KEY,
    "Unable to read controls panel toggle state.",
  );
  state.ui.controlsCollapsed = persisted === "1";

  if (controlsToggleElement) {
    controlsToggleElement.addEventListener("click", () => {
      setControlsCollapsed(!state.ui.controlsCollapsed);
    });
  }
  applyControlsPanelVisibility();
}

function setStatus(message, isError = false) {
  if (!statusElement) {
    return;
  }

  statusElement.textContent = message;
  statusElement.classList.toggle("error", isError);
}

function renderSolveLoading() {
  if (!solveLoadingElement) {
    return;
  }
  const visible = solveLoadingActiveToken !== 0;
  solveLoadingElement.classList.toggle("visible", visible);
  solveLoadingElement.setAttribute("aria-hidden", visible ? "false" : "true");
}

function formatElapsedSeconds(ms) {
  const safeMs = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  return `${(safeMs / 1000).toFixed(1)}s`;
}

function formatVisitedBranches(value) {
  const safeValue = Math.max(0, normalizeNonNegativeInteger(value, 0));
  return safeValue.toLocaleString("en-US");
}

function renderSolveLoadingProgress() {
  if (!solveLoadingElapsedElement || !solveLoadingVisitedElement) {
    return;
  }
  solveLoadingElapsedElement.textContent = `Elapsed: ${formatElapsedSeconds(solveLoadingProgress.elapsedMs)}`;
  solveLoadingVisitedElement.textContent = `Visited branches: ${formatVisitedBranches(
    solveLoadingProgress.visitedBranches,
  )}`;
}

function setSolveLoadingMessage(message) {
  if (!solveLoadingMessageElement) {
    return;
  }
  solveLoadingMessageElement.textContent = message;
}

function updateSolveLoadingProgress(progress = {}, solveToken = solveLoadingActiveToken) {
  if (solveToken !== solveLoadingActiveToken || solveLoadingActiveToken === 0) {
    return;
  }
  if (progress?.phase === "building") {
    setSolveLoadingMessage(SOLVE_LOADING_BUILDING_MESSAGE);
  } else if (progress?.phase === "searching") {
    setSolveLoadingMessage(SOLVE_LOADING_SEARCHING_MESSAGE);
  }
  solveLoadingProgress.elapsedMs = Math.max(0, Math.floor(nowMs() - solveLoadingStartedAtMs));
  if (Number.isFinite(progress?.visitedBranches)) {
    solveLoadingProgress.visitedBranches = Math.max(
      solveLoadingProgress.visitedBranches,
      normalizeNonNegativeInteger(progress.visitedBranches, 0),
    );
  }
  renderSolveLoadingProgress();
}

function beginSolveLoading(solveToken) {
  solveLoadingActiveToken = Number.isFinite(solveToken) ? solveToken : 0;
  solveLoadingStartedAtMs = nowMs();
  solveLoadingProgress = {
    elapsedMs: 0,
    visitedBranches: 0,
  };
  setSolveLoadingMessage(SOLVE_LOADING_SEARCHING_MESSAGE);
  renderSolveLoadingProgress();
  if (solveLoadingIntervalId != null) {
    window.clearInterval(solveLoadingIntervalId);
  }
  solveLoadingIntervalId = window.setInterval(() => {
    updateSolveLoadingProgress({}, solveToken);
  }, 100);
  renderSolveLoading();
}

function endSolveLoading(solveToken) {
  if (solveToken !== solveLoadingActiveToken) {
    return;
  }
  if (solveLoadingIntervalId != null) {
    window.clearInterval(solveLoadingIntervalId);
    solveLoadingIntervalId = null;
  }
  solveLoadingActiveToken = 0;
  renderSolveLoading();
}

function slotLabel(slotKey) {
  return SLOT_LABELS[String(slotKey ?? "")] ?? String(slotKey ?? "Unknown slot");
}

function savedPlanTotals(savedPlan) {
  return summarizeTotals({
    gathering: savedPlan?.totalGathering,
    perception: savedPlan?.totalPerception,
    gp: savedPlan?.totalGp,
  });
}

function normalizeRefineObjective(value) {
  return value === REFINE_OBJECTIVES.HIT_NEW_TARGETS
    ? REFINE_OBJECTIVES.HIT_NEW_TARGETS
    : REFINE_OBJECTIVES.IMPROVE_SCORE;
}

function nowMs() {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function isDoLGearRow(row) {
  return !!row && typeof row.slot === "string" && statSum(getGearRowTrackedStats(row, { useHq: true })) > 0;
}

function isFisherPrimaryToolRow(row) {
  if (!row || row.slot !== "main_hand") {
    return false;
  }
  return !!(
    row?.class_job_flags?.fsh &&
    !row?.class_job_flags?.min &&
    !row?.class_job_flags?.btn
  );
}

function getEligibleGearRows() {
  const rows = Array.isArray(state?.data?.gear?.rows) ? state.data.gear.rows : [];
  return rows.filter((row) => isDoLGearRow(row));
}

function getFoodRows() {
  return Array.isArray(state?.data?.food?.rows) ? state.data.food.rows : [];
}

function allFoodIds() {
  return getFoodRows()
    .map((row) => normalizeNonNegativeInteger(row?.item_id, 0))
    .filter((itemId) => itemId > 0);
}

function normalizeAdvancedConfigAgainstData(raw, options = {}) {
  return normalizeAdvancedConfig(raw, {
    ...options,
    allFoodIds: allFoodIds(),
  });
}

function persistAdvancedConfig() {
  writeLocalStorageJson(
    ADVANCED_CONFIG_STORAGE_KEY,
    state.advanced,
    "Unable to persist advanced configuration.",
  );
}

function loadAdvancedConfig() {
  const parsed = readLocalStorageJson(
    ADVANCED_CONFIG_STORAGE_KEY,
    "Unable to read advanced configuration; using defaults.",
  );
  if (parsed == null) {
    state.advanced = normalizeAdvancedConfigAgainstData(state.advanced, {
      keepEmptyFoodSelection: false,
    });
    return;
  }
  try {
    state.advanced = normalizeAdvancedConfigAgainstData(parsed, {
      keepEmptyFoodSelection: true,
    });
  } catch (error) {
    console.warn("Unable to read advanced configuration; using defaults.", error);
    state.advanced = normalizeAdvancedConfigAgainstData(state.advanced, {
      keepEmptyFoodSelection: false,
    });
  }
}

function normalizePersistedGearSelectionMap(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }

  const normalized = {};
  for (const [rawSlot, rawItemId] of Object.entries(raw)) {
    const slot = String(rawSlot ?? "").trim();
    if (!slot) {
      continue;
    }
    const itemId = normalizeNonNegativeInteger(rawItemId, -1);
    if (itemId < 0) {
      continue;
    }
    normalized[slot] = itemId;
  }

  return normalizeRingSlotMap(normalized);
}

function persistGearSelection() {
  const payload = {
    selectedGearBySlot: normalizePersistedGearSelectionMap(state.selectedGearBySlot),
    useHq: state?.gear?.useHq !== false,
  };
  writeLocalStorageJson(
    GEARSET_STORAGE_KEY,
    payload,
    "Unable to persist gearset selection.",
  );
}

function loadGearSelection() {
  const parsed = readLocalStorageJson(
    GEARSET_STORAGE_KEY,
    "Unable to read persisted gearset selection; using defaults.",
  );
  if (parsed == null) {
    return null;
  }
  const selectedGearBySlot = normalizePersistedGearSelectionMap(parsed?.selectedGearBySlot);
  const hasSelectedGear = Object.keys(selectedGearBySlot).length > 0;
  const hasUseHq = parsed?.useHq === true || parsed?.useHq === false;
  if (!hasSelectedGear && !hasUseHq) {
    return null;
  }
  return {
    selectedGearBySlot: hasSelectedGear ? selectedGearBySlot : null,
    useHq: hasUseHq ? parsed.useHq === true : null,
  };
}

function hydrateAdvancedConfigAgainstData() {
  state.advanced = normalizeAdvancedConfigAgainstData(state.advanced, {
    keepEmptyFoodSelection: true,
  });
}

async function loadJsonFromUrl(url) {
  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`${response.status} while fetching ${url.toString()}`);
  }
  return response.json();
}

function extractAdvancedConfigFromPreset(presetData) {
  if (presetData && typeof presetData === "object" && presetData.advanced && typeof presetData.advanced === "object") {
    return presetData.advanced;
  }
  return presetData;
}

async function applyAdvancedPreset75() {
  try {
    const presetData = await loadJsonFromUrl(ADVANCED_PRESET_75_URL);
    const advancedPreset = extractAdvancedConfigFromPreset(presetData);
    if (!advancedPreset || typeof advancedPreset !== "object") {
      throw new Error("Invalid preset format.");
    }
    if (!Array.isArray(advancedPreset.profiles) || advancedPreset.profiles.length === 0) {
      throw new Error('Preset is missing a non-empty "profiles" array.');
    }

    state.advanced = normalizeAdvancedConfigAgainstData(
      {
        ...advancedPreset,
        enabled: true,
        activeProfileIndex: 0,
      },
      {
        keepEmptyFoodSelection: true,
      },
    );
    applySolveDefaultsForMode(resolveSolveMode());
    state.savedPlansUi.breakpointCheckViewPlanId = null;
    markAdvancedDirty();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown preset load error.";
    setStatus(`Unable to load 7.5 preset: ${message}`, true);
    console.error(error);
  }
}

function buildDefaultSelectionMap() {
  const eligibleRows = getEligibleGearRows();
  const preferredRows = eligibleRows.filter((row) => !isFisherPrimaryToolRow(row));
  let defaults = buildAutoSelectedGearSet(preferredRows, { useGearHq: state.gear.useHq });

  // Prefer MIN/BTN as default main-hand; only fall back to Fisher if needed.
  if (!defaults.some((row) => row.slot === "main_hand")) {
    defaults = buildAutoSelectedGearSet(eligibleRows, { useGearHq: state.gear.useHq });
  }

  return normalizeRingSlotMap(Object.fromEntries(defaults.map((row) => [row.slot, Number(row.id)])));
}

function syncSelectedGearMap() {
  const eligibleRows = getEligibleGearRows();
  const bySlot = new Map();
  const byId = new Map();
  for (const row of eligibleRows) {
    byId.set(Number(row.id), row);
    if (!bySlot.has(row.slot)) {
      bySlot.set(row.slot, []);
    }
    bySlot.get(row.slot).push(row);
  }

  const defaultMap = buildDefaultSelectionMap();
  const selectedMap = normalizePersistedGearSelectionMap(state.selectedGearBySlot);
  const resolveSelectedIdForRows = (rows, rawSelectedId, rawDefaultId) => {
    const selectedId = Number(rawSelectedId);
    if (selectedId === 0) {
      return 0;
    }
    const selectedRow = rows.find((row) => Number(row.id) === selectedId);
    if (selectedRow) {
      return Number(selectedRow.id);
    }
    const defaultId = Number(rawDefaultId);
    if (defaultId === 0) {
      return 0;
    }
    const defaultRow = rows.find((row) => Number(row.id) === defaultId);
    if (defaultRow) {
      return Number(defaultRow.id);
    }
    return Number(rows[0]?.id) || 0;
  };
  const mainHandRows = bySlot.get("main_hand") ?? [];
  const selectedMainHandId = Number(selectedMap.main_hand);
  const defaultMainHandId = Number(defaultMap.main_hand);
  const explicitMainHandNone = selectedMainHandId === 0;
  const selectedMainHandRow =
    explicitMainHandNone
      ? null
      : mainHandRows.find((row) => Number(row.id) === selectedMainHandId) ??
        mainHandRows.find((row) => Number(row.id) === defaultMainHandId) ??
        mainHandRows[0] ??
        null;
  const lockOffHand = isFisherPrimaryToolRow(selectedMainHandRow);

  const nextMap = {};
  for (const [slot, rows] of bySlot.entries()) {
    if (slot === "ring") {
      continue;
    }
    if (lockOffHand && slot === "off_hand") {
      continue;
    }
    nextMap[slot] = resolveSelectedIdForRows(rows, selectedMap[slot], defaultMap[slot]);
  }

  const ringRows = bySlot.get("ring") ?? [];
  if (ringRows.length > 0) {
    const leftRingId = resolveSelectedIdForRows(
      ringRows,
      selectedMap.ring_left,
      defaultMap.ring_left,
    );
    const rightDefaultId =
      Number.isFinite(Number(defaultMap.ring_right)) && Number(defaultMap.ring_right) > 0
        ? Number(defaultMap.ring_right)
        : leftRingId;
    const rightRingId = resolveSelectedIdForRows(
      ringRows,
      selectedMap.ring_right,
      rightDefaultId,
    );
    setRingSelection(nextMap, leftRingId, rightRingId);
  }

  state.selectedGearBySlot = nextMap;
  const selectedRows = Object.values(nextMap)
    .map((itemId) => byId.get(Number(itemId)))
    .filter(Boolean);

  state.selectedGearRows = selectedRows;
}

function syncFoodSelection() {
  const foodRows = getFoodRows();
  if (foodRows.length === 0) {
    state.food.selectedFoodId = null;
    return;
  }

  const selectedRaw = state.food.selectedFoodId;
  if (selectedRaw === 0 || selectedRaw === "0") {
    state.food.selectedFoodId = 0;
    return;
  }

  if (selectedRaw == null) {
    state.food.selectedFoodId = Number(foodRows[0].item_id);
    return;
  }

  const selectedId = Number(selectedRaw);
  const selectedRow = foodRows.find((row) => Number(row.item_id) === selectedId);
  if (selectedRow) {
    return;
  }

  state.food.selectedFoodId = Number(foodRows[0].item_id);
}

function getSelectedFoodRow() {
  const selectedId = Number(state.food.selectedFoodId);
  return getFoodRows().find((row) => Number(row.item_id) === selectedId) ?? null;
}

function totalsMeetTargets(totals) {
  const gatheringTarget = normalizeNonNegativeInteger(state.targets.gathering, 0);
  const perceptionTarget = normalizeNonNegativeInteger(state.targets.perception, 0);
  const gpTarget = normalizeNonNegativeInteger(state.targets.gp, 0);

  if (gatheringTarget + perceptionTarget + gpTarget === 0) {
    return true;
  }

  return (
    (Number(totals?.gathering) || 0) >= gatheringTarget &&
    (Number(totals?.perception) || 0) >= perceptionTarget &&
    (Number(totals?.gp) || 0) >= gpTarget
  );
}

function isAdvancedModeEnabled(options = {}) {
  if (options?.forceLegacyMode) {
    return false;
  }
  return state?.advanced?.enabled === true;
}

function buildFoodOptionForTotals(resultTotals, foodRow) {
  const useHq = !!(state.food.useHq && foodRow?.can_be_hq);
  const delta = computeFoodDeltaForTotals(resultTotals, foodRow, useHq);
  const updatedTotals = {
    gathering: (Number(resultTotals?.gathering) || 0) + delta.gathering,
    perception: (Number(resultTotals?.perception) || 0) + delta.perception,
    gp: (Number(resultTotals?.gp) || 0) + delta.gp,
  };
  return {
    score: delta.gathering + delta.perception + delta.gp,
    updatedTotals,
    food: {
      itemId: Number(foodRow?.item_id) || 0,
      name: String(foodRow?.name ?? "No food"),
      useHq,
      delta,
    },
  };
}

const NORMAL_MODE_VARIANT_LIMIT = 5;
const NO_FOOD_VARIANT_KEY = "__no_food__";

function buildNoFoodOptionForTotals(resultTotals) {
  const totals = summarizeTotals(resultTotals);
  const delta = {
    gathering: 0,
    perception: 0,
    gp: 0,
  };
  return {
    score: 0,
    updatedTotals: totals,
    food: {
      itemId: 0,
      name: "No food",
      useHq: false,
      delta,
    },
  };
}

function buildNoFoodVariantSpec() {
  return {
    key: NO_FOOD_VARIANT_KEY,
    itemId: 0,
    name: "No food",
    useHq: false,
    foodRow: null,
  };
}

function buildFoodVariantSpecFromRow(foodRow) {
  const itemId = normalizeNonNegativeInteger(foodRow?.item_id, 0);
  const useHq = !!(state.food.useHq && foodRow?.can_be_hq);
  return {
    key: `food:${itemId}:${useHq ? "hq" : "nq"}`,
    itemId,
    name: String(foodRow?.name ?? `Food ${itemId}`),
    useHq,
    foodRow,
  };
}

function buildNormalModeVariantFoodSpecs() {
  const noFood = buildNoFoodVariantSpec();
  if (state.food.isFixed) {
    const selectedFoodRow = getSelectedFoodRow();
    if (!selectedFoodRow) {
      return [noFood];
    }
    return [buildFoodVariantSpecFromRow(selectedFoodRow)];
  }

  const specs = [noFood, ...getFoodRows().map((foodRow) => buildFoodVariantSpecFromRow(foodRow))];
  const deduped = new Map();
  for (const spec of specs) {
    if (!spec || !spec.key) {
      continue;
    }
    deduped.set(spec.key, spec);
  }
  return Array.from(deduped.values());
}

function buildFoodOptionForSpec(baseTotals, foodSpec) {
  if (normalizeNonNegativeInteger(foodSpec?.itemId, 0) <= 0 || !foodSpec?.foodRow) {
    return buildNoFoodOptionForTotals(baseTotals);
  }
  return buildFoodOptionForTotals(baseTotals, foodSpec.foodRow);
}

function normalModeExcessTotal(updatedTotals, targets) {
  const safeTotals = summarizeTotals(updatedTotals);
  const safeTargets = summarizeTotals(targets);
  return (
    Math.max(0, safeTotals.gathering - safeTargets.gathering) +
    Math.max(0, safeTotals.perception - safeTargets.perception) +
    Math.max(0, safeTotals.gp - safeTargets.gp)
  );
}

function normalizeNormalModeScore(value) {
  const score = Number(value);
  if (!Number.isFinite(score)) {
    return Number.NEGATIVE_INFINITY;
  }
  return score;
}

function buildNormalModeMeldSignature(plan) {
  const pieces = Array.isArray(plan?.pieceMelds) ? plan.pieceMelds : [];
  return pieces
    .map((piece, pieceIndex) => {
      const pieceId = normalizeNonNegativeInteger(piece?.pieceId, 0);
      const slot = String(piece?.slot ?? "unknown");
      const meldTokens = (Array.isArray(piece?.melds) ? piece.melds : [])
        .map((meld) => {
          const slotIndex = normalizeNonNegativeInteger(meld?.slotIndex, 0);
          const statKey = String(meld?.stat ?? "x");
          const grade = normalizeNonNegativeInteger(meld?.grade, 0);
          const appliedValue = normalizeNonNegativeInteger(meld?.appliedValue, 0);
          return `${slotIndex}:${statKey}:${grade}:${appliedValue}`;
        })
        .sort()
        .join(",");
      return `${pieceIndex}:${slot}:${pieceId}:${meldTokens}`;
    })
    .join("|");
}

function normalModePlanMeldStatTotal(plan) {
  const pieces = Array.isArray(plan?.pieceMelds) ? plan.pieceMelds : [];
  let total = 0;
  for (const piece of pieces) {
    for (const meld of Array.isArray(piece?.melds) ? piece.melds : []) {
      total += normalizeNonNegativeInteger(meld?.appliedValue, 0);
    }
  }
  return total;
}

function compareNormalModeVariantCandidates(left, right) {
  const leftMeets = left?.meetsTargets === true;
  const rightMeets = right?.meetsTargets === true;
  if (leftMeets !== rightMeets) {
    return Number(rightMeets) - Number(leftMeets);
  }
  const scoreDiff = normalizeNormalModeScore(right?.score) - normalizeNormalModeScore(left?.score);
  if (scoreDiff !== 0) {
    return scoreDiff;
  }
  const excessDiff =
    normalizeNonNegativeInteger(left?.excessTotal, Number.MAX_SAFE_INTEGER) -
    normalizeNonNegativeInteger(right?.excessTotal, Number.MAX_SAFE_INTEGER);
  if (excessDiff !== 0) {
    return excessDiff;
  }
  const meldDiff = normalizeNonNegativeInteger(left?.meldStatTotal, 0) - normalizeNonNegativeInteger(right?.meldStatTotal, 0);
  if (meldDiff !== 0) {
    return meldDiff;
  }
  const foodItemDiff =
    normalizeNonNegativeInteger(left?.food?.itemId, Number.MAX_SAFE_INTEGER) -
    normalizeNonNegativeInteger(right?.food?.itemId, Number.MAX_SAFE_INTEGER);
  if (foodItemDiff !== 0) {
    return foodItemDiff;
  }
  const sourceRowDiff =
    normalizeNonNegativeInteger(left?.sourceRowIndex, Number.MAX_SAFE_INTEGER) -
    normalizeNonNegativeInteger(right?.sourceRowIndex, Number.MAX_SAFE_INTEGER);
  if (sourceRowDiff !== 0) {
    return sourceRowDiff;
  }
  return normalizeNonNegativeInteger(left?.sourcePlanIndex, Number.MAX_SAFE_INTEGER) - normalizeNonNegativeInteger(
    right?.sourcePlanIndex,
    Number.MAX_SAFE_INTEGER,
  );
}

function buildNormalModeScoredCandidates(sourceRows, foodSpecs) {
  const rows = Array.isArray(sourceRows) ? sourceRows : [];
  const specs = Array.isArray(foodSpecs) ? foodSpecs : [];
  const targetTotals = summarizeTotals(state.targets);
  const candidates = [];

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const sourcePlans = Array.isArray(row?.plans) ? row.plans.filter((plan) => !!plan) : [];
    if (sourcePlans.length === 0) {
      continue;
    }
    const baseTotals = summarizeTotals({
      gathering: row?.totalGathering,
      perception: row?.totalPerception,
      gp: row?.totalGp,
    });
    for (let planIndex = 0; planIndex < sourcePlans.length; planIndex += 1) {
      const plan = sourcePlans[planIndex];
      const meldSignature = buildNormalModeMeldSignature(plan);
      const meldStatTotal = normalModePlanMeldStatTotal(plan);
      for (const spec of specs) {
        const option = buildFoodOptionForSpec(baseTotals, spec);
        const updatedTotals = summarizeTotals(option?.updatedTotals);
        const score = normalizeNormalModeScore(scoreCandidate(updatedTotals, targetTotals));
        const food = option?.food ?? buildNoFoodOptionForTotals(baseTotals).food;
        const foodKey = String(spec?.key ?? `food:${normalizeNonNegativeInteger(food?.itemId, 0)}:${food?.useHq ? "hq" : "nq"}`);
        candidates.push({
          sourceRow: row,
          sourceRowIndex: rowIndex,
          sourcePlanIndex: planIndex,
          plan,
          score,
          meetsTargets: totalsMeetTargets(updatedTotals),
          excessTotal: normalModeExcessTotal(updatedTotals, targetTotals),
          meldStatTotal,
          updatedTotals,
          food,
          foodKey,
          meldSignature,
          variantKey: `${meldSignature}|${foodKey}`,
        });
      }
    }
  }

  return candidates;
}

function selectDistinctVariantsForScoreBucket(candidates, maxVariants = NORMAL_MODE_VARIANT_LIMIT) {
  const sorted = [...(Array.isArray(candidates) ? candidates : [])].sort(compareNormalModeVariantCandidates);
  const selected = [];
  const usedMeldSignatures = new Set();
  const usedFoodKeys = new Set();
  const usedVariantKeys = new Set();

  for (const candidate of sorted) {
    if (!candidate || usedVariantKeys.has(candidate.variantKey)) {
      continue;
    }
    const meldSignature = String(candidate?.meldSignature ?? "");
    const foodKey = String(candidate?.foodKey ?? "");
    if (usedMeldSignatures.has(meldSignature) || usedFoodKeys.has(foodKey)) {
      continue;
    }
    selected.push(candidate);
    usedVariantKeys.add(candidate.variantKey);
    usedMeldSignatures.add(meldSignature);
    usedFoodKeys.add(foodKey);
    if (selected.length >= Math.max(1, normalizeNonNegativeInteger(maxVariants, NORMAL_MODE_VARIANT_LIMIT))) {
      return selected;
    }
  }

  if (selected.length > 0) {
    return selected;
  }

  for (const candidate of sorted) {
    if (!candidate || usedVariantKeys.has(candidate.variantKey)) {
      continue;
    }
    selected.push(candidate);
    usedVariantKeys.add(candidate.variantKey);
    if (selected.length >= Math.max(1, normalizeNonNegativeInteger(maxVariants, NORMAL_MODE_VARIANT_LIMIT))) {
      break;
    }
  }
  return selected;
}

function buildPlanVariantFromScoredCandidate(candidate) {
  const updatedTotals = summarizeTotals(candidate?.updatedTotals);
  return {
    ...(candidate?.plan ?? {}),
    score: normalizeNormalModeScore(candidate?.score),
    varianceScore: 0,
    food: candidate?.food ?? buildNoFoodOptionForTotals(updatedTotals).food,
    totalGathering: updatedTotals.gathering,
    totalPerception: updatedTotals.perception,
    totalGp: updatedTotals.gp,
    meetsTargets: Boolean(candidate?.meetsTargets),
  };
}

function buildNormalModeRowFromVariantGroup(variants) {
  const primary = Array.isArray(variants) ? variants[0] ?? null : null;
  const row = primary?.sourceRow ?? {};
  const totals = summarizeTotals(primary?.updatedTotals);
  return {
    ...row,
    score: normalizeNormalModeScore(primary?.score),
    totalGathering: totals.gathering,
    totalPerception: totals.perception,
    totalGp: totals.gp,
    meetsTargets: Boolean(primary?.meetsTargets),
    food: primary?.food ?? buildNoFoodOptionForTotals(totals).food,
    plans: (Array.isArray(variants) ? variants : []).map((variant) => buildPlanVariantFromScoredCandidate(variant)),
  };
}

function buildNormalModeRowsFromScoredCandidates(candidates) {
  const rows = Array.isArray(candidates) ? candidates : [];
  if (rows.length === 0) {
    return [];
  }

  const byScore = new Map();
  for (const candidate of rows) {
    const score = normalizeNormalModeScore(candidate?.score);
    const key = String(score);
    if (!byScore.has(key)) {
      byScore.set(key, []);
    }
    byScore.get(key).push(candidate);
  }

  const scoreKeys = Array.from(byScore.keys()).sort((left, right) => normalizeNormalModeScore(right) - normalizeNormalModeScore(left));
  const maxRows = normalizeMaxResultsForSolveMode(state?.solve?.maxResults, SOLVER_MODES.NORMAL);
  const builtRows = [];

  for (const scoreKey of scoreKeys) {
    const scoreCandidates = byScore.get(scoreKey) ?? [];
    const variants = selectDistinctVariantsForScoreBucket(scoreCandidates, NORMAL_MODE_VARIANT_LIMIT);
    if (variants.length === 0) {
      continue;
    }
    builtRows.push(buildNormalModeRowFromVariantGroup(variants));
    if (builtRows.length >= maxRows) {
      break;
    }
  }

  return builtRows;
}

function applyFixedFood(results) {
  const sourceRows = Array.isArray(results) ? results : [];
  const foodSpecs = buildNormalModeVariantFoodSpecs();
  const candidates = buildNormalModeScoredCandidates(sourceRows, foodSpecs);
  const rows = buildNormalModeRowsFromScoredCandidates(candidates);
  if (rows.length > 0) {
    return rows;
  }
  return sourceRows;
}

function gpSpreadOrder(rows) {
  const sorted = [...rows].sort((left, right) => {
    const offHandGatheringDiff =
      (Number(left?.offHandGathering) || 0) - (Number(right?.offHandGathering) || 0);
    if (offHandGatheringDiff !== 0) {
      return offHandGatheringDiff;
    }
    const gpDiff = (Number(left?.totalGp) || 0) - (Number(right?.totalGp) || 0);
    if (gpDiff !== 0) {
      return gpDiff;
    }
    return (Number(right?.score) || 0) - (Number(left?.score) || 0);
  });

  const spread = [];
  let left = 0;
  let right = sorted.length - 1;
  let takeLow = true;

  while (left <= right) {
    if (takeLow) {
      spread.push(sorted[left]);
      left += 1;
    } else {
      spread.push(sorted[right]);
      right -= 1;
    }
    takeLow = !takeLow;
  }

  return spread;
}

function diversifyDisplayOrderByScoreGp(rows) {
  const source = Array.isArray(rows) ? rows : [];
  if (source.length <= 1) {
    return source;
  }

  const groupedByRoundedScore = new Map();
  for (const row of source) {
    const scoreKey = Math.round(Number(row?.score) || 0);
    if (!groupedByRoundedScore.has(scoreKey)) {
      groupedByRoundedScore.set(scoreKey, []);
    }
    groupedByRoundedScore.get(scoreKey).push(row);
  }

  const orderedScoreKeys = Array.from(groupedByRoundedScore.keys()).sort((a, b) => b - a);
  const diversified = [];
  for (const scoreKey of orderedScoreKeys) {
    const groupRows = groupedByRoundedScore.get(scoreKey) ?? [];
    diversified.push(...gpSpreadOrder(groupRows));
  }
  return diversified;
}

function syncSelectedGearToSavedPlan(savedPlan) {
  const planPieces = Array.isArray(savedPlan?.pieceMelds) ? savedPlan.pieceMelds : [];
  const nextMap = normalizePersistedGearSelectionMap(state.selectedGearBySlot ?? {});
  delete nextMap.ring;
  let ringPieceCount = 0;
  for (const piece of planPieces) {
    const slot = String(piece?.slot ?? "");
    const pieceId = normalizeNonNegativeInteger(piece?.pieceId, 0);
    if (!slot || pieceId <= 0) {
      continue;
    }
    if (slot === "ring") {
      if (ringPieceCount === 0) {
        nextMap.ring_left = pieceId;
      } else {
        nextMap.ring_right = pieceId;
      }
      ringPieceCount += 1;
      continue;
    }
    nextMap[slot] = pieceId;
  }
  if (ringPieceCount === 1 && Number(nextMap.ring_left) > 0) {
    setRingSelection(nextMap, nextMap.ring_left);
  }
  state.selectedGearBySlot = nextMap;
  syncSelectedGearMap();
  persistGearSelection();
}

function normalizeMeldKey(meld) {
  return normalizeNonNegativeInteger(meld?.slotIndex, 0);
}

function buildMeldLookupBySlotIndex(piece) {
  const melds = Array.isArray(piece?.melds) ? piece.melds : [];
  const lookup = new Map();
  for (const meld of melds) {
    lookup.set(normalizeMeldKey(meld), meld);
  }
  return lookup;
}

function meldEquivalent(left, right) {
  return (
    String(left?.stat ?? "") === String(right?.stat ?? "") &&
    normalizeNonNegativeInteger(left?.grade, 0) === normalizeNonNegativeInteger(right?.grade, 0) &&
    normalizeNonNegativeInteger(left?.appliedValue, 0) === normalizeNonNegativeInteger(right?.appliedValue, 0)
  );
}

function describeMeldShort(meld) {
  const statKey = String(meld?.stat ?? "");
  const statLabel = STAT_LABELS[statKey] ?? statKey.toUpperCase();
  const grade = normalizeNonNegativeInteger(meld?.grade, 0);
  const value = normalizeNonNegativeInteger(meld?.appliedValue, 0);
  return `${statLabel} ${grade > 0 ? `X${grade}` : ""} +${value}`.trim();
}

function buildAdjustmentDiffForPlan(baselinePlan, candidatePlan) {
  const baselinePieces = Array.isArray(baselinePlan?.pieceMelds) ? baselinePlan.pieceMelds : [];
  const candidatePieces = Array.isArray(candidatePlan?.pieceMelds) ? candidatePlan.pieceMelds : [];
  const maxPieceCount = Math.max(baselinePieces.length, candidatePieces.length);
  const lines = [];
  const changedPieceIndices = new Set();
  const changedMeldKeys = new Set();

  for (let pieceIndex = 0; pieceIndex < maxPieceCount; pieceIndex += 1) {
    const baselinePiece = baselinePieces[pieceIndex] ?? null;
    const candidatePiece = candidatePieces[pieceIndex] ?? null;
    const pieceSlot = candidatePiece?.slot ?? baselinePiece?.slot ?? "unknown";
    const pieceName = candidatePiece?.pieceName ?? baselinePiece?.pieceName ?? "Unknown piece";
    const pieceLabel = `${slotLabel(pieceSlot)} - ${pieceName}`;

    const baselineLookup = buildMeldLookupBySlotIndex(baselinePiece);
    const candidateLookup = buildMeldLookupBySlotIndex(candidatePiece);
    const slotIndices = new Set([
      ...Array.from(baselineLookup.keys()),
      ...Array.from(candidateLookup.keys()),
    ]);
    const orderedSlots = Array.from(slotIndices.values()).sort((a, b) => a - b);

    for (const slotIndex of orderedSlots) {
      const baselineMeld = baselineLookup.get(slotIndex);
      const candidateMeld = candidateLookup.get(slotIndex);
      const slotTag = `slot ${slotIndex + 1}`;
      const meldKey = `${pieceIndex}:${slotIndex}`;
      if (!baselineMeld && candidateMeld) {
        changedPieceIndices.add(pieceIndex);
        changedMeldKeys.add(meldKey);
        lines.push(`${pieceLabel} ${slotTag}: add ${describeMeldShort(candidateMeld)}`);
        continue;
      }
      if (baselineMeld && !candidateMeld) {
        changedPieceIndices.add(pieceIndex);
        changedMeldKeys.add(meldKey);
        lines.push(`${pieceLabel} ${slotTag}: remove ${describeMeldShort(baselineMeld)}`);
        continue;
      }
      if (baselineMeld && candidateMeld && !meldEquivalent(baselineMeld, candidateMeld)) {
        changedPieceIndices.add(pieceIndex);
        changedMeldKeys.add(meldKey);
        lines.push(
          `${pieceLabel} ${slotTag}: replace ${describeMeldShort(baselineMeld)} -> ${describeMeldShort(candidateMeld)}`,
        );
      }
    }
  }

  return {
    count: lines.length,
    lines,
    changedPieceIndices: Array.from(changedPieceIndices.values()).sort((a, b) => a - b),
    changedMeldKeys: Array.from(changedMeldKeys.values()).sort(),
  };
}

function annotateResultsWithRefineDiff(results, baselinePlan) {
  const rows = Array.isArray(results) ? results : [];
  return rows.map((row) => {
    const plans = Array.isArray(row?.plans) ? row.plans : [];
    const plansWithDiff = plans
      .map((plan) => ({
        ...plan,
        adjustmentDiff: buildAdjustmentDiffForPlan(baselinePlan, plan),
      }))
      .sort((left, right) => {
        const leftCount = normalizeNonNegativeInteger(left?.adjustmentDiff?.count, 0);
        const rightCount = normalizeNonNegativeInteger(right?.adjustmentDiff?.count, 0);
        return leftCount - rightCount;
      });
    const bestAdjustmentCount = plansWithDiff.reduce((minValue, plan) => {
      const count = normalizeNonNegativeInteger(plan?.adjustmentDiff?.count, 0);
      return Math.min(minValue, count);
    }, Number.POSITIVE_INFINITY);
    return {
      ...row,
      plans: plansWithDiff,
      bestAdjustmentCount: Number.isFinite(bestAdjustmentCount) ? bestAdjustmentCount : 0,
    };
  });
}

function refineObjectiveLabel(objective) {
  return objective === REFINE_OBJECTIVES.HIT_NEW_TARGETS ? "Hit new targets" : "Improve score";
}

function rankRefineResults(rows, options) {
  const objective = options?.objective;
  const baselineScore = Number(options?.baselineScore);
  const useAdvancedScoring = options?.useAdvancedScoring === true;
  const baselineAdvancedSummary = options?.baselineAdvancedSummary;
  const source = Array.isArray(rows) ? rows : [];
  let filtered = source;

  if (objective === REFINE_OBJECTIVES.HIT_NEW_TARGETS) {
    if (useAdvancedScoring && baselineAdvancedSummary) {
      filtered = source.filter((row) => compareAdvancedBreakpointSummaries(baselineAdvancedSummary, row?.advanced) > 0);
    } else {
      filtered = source.filter((row) => row?.meetsTargets);
    }
  } else if (useAdvancedScoring && baselineAdvancedSummary) {
    filtered = source.filter((row) => compareAdvancedBreakpointSummaries(baselineAdvancedSummary, row?.advanced) > 0);
  } else if (Number.isFinite(baselineScore)) {
    filtered = source.filter((row) => Number(row?.score) > baselineScore);
  }

  const ranked = [...filtered].sort((left, right) => {
    if (useAdvancedScoring) {
      const advancedDiff = compareAdvancedBreakpointSummaries(left?.advanced, right?.advanced);
      if (advancedDiff !== 0) {
        return advancedDiff;
      }
    }
    const scoreDiff = (Number(right?.score) || 0) - (Number(left?.score) || 0);
    if (scoreDiff !== 0) {
      return scoreDiff;
    }
    const adjustmentDiff =
      normalizeNonNegativeInteger(left?.bestAdjustmentCount, 0) -
      normalizeNonNegativeInteger(right?.bestAdjustmentCount, 0);
    if (adjustmentDiff !== 0) {
      return adjustmentDiff;
    }
    const leftStatTotal =
      normalizeNonNegativeInteger(left?.totalGathering, 0) +
      normalizeNonNegativeInteger(left?.totalPerception, 0) +
      normalizeNonNegativeInteger(left?.totalGp, 0);
    const rightStatTotal =
      normalizeNonNegativeInteger(right?.totalGathering, 0) +
      normalizeNonNegativeInteger(right?.totalPerception, 0) +
      normalizeNonNegativeInteger(right?.totalGp, 0);
    return rightStatTotal - leftStatTotal;
  });
  const limit = normalizeNonNegativeInteger(options?.limit, 0);
  return limit > 0 ? ranked.slice(0, limit) : ranked;
}

function savedPlansGradeValueIndex() {
  return buildMateriaGradeValueIndex(state?.data?.materia?.rows);
}

function allowedGradesForDraftMeld(statKey, meld) {
  const safeStat = String(statKey ?? "").toLowerCase();
  const allStatGrades = Array.isArray(state.savedPlansUi.availableGradesByStat?.[safeStat])
    ? state.savedPlansUi.availableGradesByStat[safeStat]
    : [];
  if (!Boolean(meld?.isOvermeld)) {
    return allStatGrades;
  }
  const overmeldIndex = Number(meld?.overmeldIndex);
  if (!Number.isFinite(overmeldIndex) || overmeldIndex < 0) {
    return allStatGrades;
  }
  const allowedForSlot = state.savedPlansUi.overmeldAllowedGradesByStat?.[safeStat]?.[overmeldIndex];
  if (!Array.isArray(allowedForSlot) || allowedForSlot.length === 0) {
    return allStatGrades;
  }
  const allowedSet = new Set(allowedForSlot.map((grade) => normalizeNonNegativeInteger(grade, 0)));
  const filtered = allStatGrades.filter((grade) => allowedSet.has(normalizeNonNegativeInteger(grade, 0)));
  return filtered.length > 0 ? filtered : allStatGrades;
}

function refreshSavedPlansUiDerived() {
  state.savedPlansUi.availableGradesByStat = buildAvailableGradesByStat(state?.data?.materia?.rows);
  state.savedPlansUi.overmeldAllowedGradesByStat = buildOvermeldAllowedGradesByStat(state?.data?.materia?.rows);
  state.savedPlansUi.gradeValueIndexByStat = savedPlansGradeValueIndex();

  const validPlanIds = new Set((state.savedPlans ?? []).map((plan) => String(plan?.id ?? "")));
  const currentViewId = String(state.savedPlansUi.viewPlanId ?? "");
  if (currentViewId && !validPlanIds.has(currentViewId)) {
    state.savedPlansUi.viewPlanId = null;
  }
  const currentEditingId = String(state.savedPlansUi.editingPlanId ?? "");
  if (currentEditingId && !validPlanIds.has(currentEditingId)) {
    state.savedPlansUi.editingPlanId = null;
  }
  const currentBreakpointCheckViewId = String(state.savedPlansUi.breakpointCheckViewPlanId ?? "");
  if (currentBreakpointCheckViewId && !validPlanIds.has(currentBreakpointCheckViewId)) {
    state.savedPlansUi.breakpointCheckViewPlanId = null;
  }
  const currentRefinePlanId = String(state.savedPlansUi.refineDialog?.planId ?? "");
  if (currentRefinePlanId && !validPlanIds.has(currentRefinePlanId)) {
    state.savedPlansUi.refineDialog = null;
  }

  const gradeValueIndex = state.savedPlansUi.gradeValueIndexByStat;
  const foodRows = getFoodRows();
  const previewByPlanId = {};
  const existingBreakpointFoodByPlanId =
    state.savedPlansUi.breakpointCheckFoodByPlanId && typeof state.savedPlansUi.breakpointCheckFoodByPlanId === "object"
      ? state.savedPlansUi.breakpointCheckFoodByPlanId
      : {};
  const nextBreakpointFoodByPlanId = {};
  const breakpointCheckPreviewByPlanId = {};
  const breakpointProfiles = selectActiveAdvancedProfiles(state?.advanced?.profiles);

  for (const plan of state.savedPlans ?? []) {
    const planId = String(plan?.id ?? "");
    const draft = state.savedPlansUi.draftsByPlanId?.[planId];
    const previewPlan = draft
      ? applyDraftToSavedPlan(plan, draft, gradeValueIndex, {
          gearRows: state?.data?.gear?.rows,
          useGearHq: state?.gear?.useHq,
          foodRows,
          overmeldAllowedGradesByStat: state.savedPlansUi.overmeldAllowedGradesByStat,
        }).plan
      : plan;
    previewByPlanId[planId] = previewPlan;

    const existingPlanDraft =
      existingBreakpointFoodByPlanId[planId] && typeof existingBreakpointFoodByPlanId[planId] === "object"
        ? existingBreakpointFoodByPlanId[planId]
        : {};
    const normalizedFoodDraftByProfileId = {};
    for (const profile of breakpointProfiles) {
      const profileId = String(profile?.id ?? "");
      if (!profileId) {
        continue;
      }
      normalizedFoodDraftByProfileId[profileId] = normalizeSavedPlanBreakpointFoodDraftEntry(
        existingPlanDraft[profileId],
        profile,
        previewPlan?.food,
        foodRows,
      );
    }
    nextBreakpointFoodByPlanId[planId] = normalizedFoodDraftByProfileId;
    breakpointCheckPreviewByPlanId[planId] = evaluateSavedPlanBreakpointCheck(previewPlan, normalizedFoodDraftByProfileId, {
      advancedProfiles: state?.advanced?.profiles,
      foodRows,
    });
  }
  state.savedPlansUi.previewByPlanId = previewByPlanId;
  state.savedPlansUi.breakpointCheckFoodByPlanId = nextBreakpointFoodByPlanId;
  state.savedPlansUi.breakpointCheckPreviewByPlanId = breakpointCheckPreviewByPlanId;
}

function refreshSavedPlansUiAndRender() {
  refreshSavedPlansUiDerived();
  render();
}

function savedPlanPreviewById(planId) {
  const safeId = String(planId ?? "");
  if (!safeId) {
    return null;
  }
  return state.savedPlansUi.previewByPlanId?.[safeId] ?? null;
}

function toggleSavedPlanBreakpointCheck(planId) {
  if (!isAdvancedModeEnabled()) {
    return;
  }
  const safeId = String(planId ?? "");
  if (!safeId) {
    return;
  }
  const isOpen = state.savedPlansUi.breakpointCheckViewPlanId === safeId;
  state.savedPlansUi.breakpointCheckViewPlanId = isOpen ? null : safeId;
  refreshSavedPlansUiAndRender();
}

function updateSavedPlanBreakpointCheckDraft({ planId, profileId, field, value }) {
  const safePlanId = String(planId ?? "");
  const safeProfileId = String(profileId ?? "");
  if (!safePlanId || !safeProfileId) {
    return;
  }

  const planPreview = savedPlanPreviewById(safePlanId);
  if (!planPreview) {
    return;
  }
  const profile = selectActiveAdvancedProfiles(state?.advanced?.profiles).find(
    (entry) => String(entry?.id ?? "") === safeProfileId,
  );
  if (!profile) {
    return;
  }

  const existingPlanEntries =
    state.savedPlansUi.breakpointCheckFoodByPlanId?.[safePlanId] &&
    typeof state.savedPlansUi.breakpointCheckFoodByPlanId[safePlanId] === "object"
      ? state.savedPlansUi.breakpointCheckFoodByPlanId[safePlanId]
      : {};
  const foodRows = getFoodRows();
  const currentEntry = normalizeSavedPlanBreakpointFoodDraftEntry(
    existingPlanEntries[safeProfileId],
    profile,
    planPreview?.food,
    foodRows,
  );
  if (field === "foodItemId") {
    currentEntry.foodItemId = normalizeNonNegativeInteger(value, 0);
  } else if (field === "useHq") {
    currentEntry.useHq = Boolean(value);
  } else {
    return;
  }

  const normalizedEntry = normalizeSavedPlanBreakpointFoodDraftEntry(
    currentEntry,
    profile,
    planPreview?.food,
    foodRows,
  );
  state.savedPlansUi.breakpointCheckFoodByPlanId[safePlanId] = {
    ...existingPlanEntries,
    [safeProfileId]: normalizedEntry,
  };
  refreshSavedPlansUiAndRender();
}

function saveAndStoreSavedPlans(nextPlans) {
  state.savedPlans = persistSavedPlans(Array.isArray(nextPlans) ? nextPlans : []);
  refreshSavedPlansUiDerived();
}

function findSavedPlanIndexById(planId) {
  const safeId = String(planId ?? "");
  return (state.savedPlans ?? []).findIndex((plan) => String(plan?.id ?? "") === safeId);
}

function planDiffToggleKey(resultIndex, planIndex) {
  return `${normalizeNonNegativeInteger(resultIndex, 0)}:${normalizeNonNegativeInteger(planIndex, 0)}`;
}

function defaultSavedPlanNameForVariant(resultIndex, planIndex, row, planVariant) {
  const totals = summarizeTotals({
    gathering: planVariant?.totalGathering ?? row?.totalGathering,
    perception: planVariant?.totalPerception ?? row?.totalPerception,
    gp: planVariant?.totalGp ?? row?.totalGp,
  });
  return `Plan #${resultIndex + 1}.${planIndex + 1} - ${totals.gathering}/${totals.perception}/${totals.gp}`;
}

function saveResultPlanVariant(resultIndex, planIndex) {
  const row = state.results?.[resultIndex];
  const planVariant = row?.plans?.[planIndex];
  if (!row || !planVariant) {
    setStatus("Cannot save plan variant: missing result row data.", true);
    return;
  }

  const defaultName = defaultSavedPlanNameForVariant(resultIndex, planIndex, row, planVariant);
  let customName = defaultName;
  if (typeof window !== "undefined" && typeof window.prompt === "function") {
    try {
      const prompted = window.prompt("Save plan name", defaultName);
      if (prompted != null) {
        customName = String(prompted).trim() || defaultName;
      }
    } catch (error) {
      console.warn("Save plan name prompt unavailable; using default name.", error);
    }
  }

  const savedPlan = createSavedPlanFromResult({
    resultRow: row,
    planVariant,
    resultIndex,
    planIndex,
    selectedGearRows: state.selectedGearRows,
    customName,
  });
  saveAndStoreSavedPlans([savedPlan, ...(state.savedPlans ?? [])]);
  setStatus(`Saved plan "${savedPlan.name}". Stored ${state.savedPlans.length}/${getMaxSavedPlans()} plans.`);
  render();
}

function nextCopiedSavedPlanName(sourceName) {
  const baseName = String(sourceName ?? "Saved plan").trim() || "Saved plan";
  const existingNames = new Set((state.savedPlans ?? []).map((plan) => String(plan?.name ?? "")));
  let candidate = `${baseName} Copy`;
  let suffix = 2;
  while (existingNames.has(candidate)) {
    candidate = `${baseName} Copy ${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function copySavedPlan(planId) {
  const safeId = String(planId ?? "");
  if (state.savedPlansUi.editingPlanId === safeId) {
    setStatus("Save or cancel edits before copying this plan.", true);
    return;
  }
  const planIndex = findSavedPlanIndexById(safeId);
  if (planIndex < 0) {
    setStatus("Cannot copy saved plan: plan not found.", true);
    return;
  }

  const sourcePlan = state.savedPlans[planIndex];
  const copiedPlan = duplicateSavedPlan(sourcePlan, {
    name: nextCopiedSavedPlanName(sourcePlan?.name),
  });
  saveAndStoreSavedPlans([copiedPlan, ...(state.savedPlans ?? [])]);
  state.savedPlansUi.viewPlanId = copiedPlan.id;
  setStatus(`Copied saved plan "${sourcePlan.name}" to "${copiedPlan.name}".`);
  render();
}

function toggleSavedPlanView(planId) {
  const safeId = String(planId ?? "");
  if (state.savedPlansUi.editingPlanId === safeId) {
    return;
  }
  state.savedPlansUi.viewPlanId = state.savedPlansUi.viewPlanId === safeId ? null : safeId;
  render();
}

function toggleSavedPlanEdit(planId) {
  const safeId = String(planId ?? "");
  if (state.savedPlansUi.editingPlanId === safeId) {
    state.savedPlansUi.editingPlanId = null;
    delete state.savedPlansUi.draftsByPlanId[safeId];
    refreshSavedPlansUiAndRender();
    return;
  }

  const planIndex = findSavedPlanIndexById(safeId);
  if (planIndex < 0) {
    setStatus("Cannot edit saved plan: plan not found.", true);
    return;
  }

  const plan = state.savedPlans[planIndex];
  state.savedPlansUi.editingPlanId = safeId;
  state.savedPlansUi.viewPlanId = safeId;
  if (String(state.savedPlansUi.refineDialog?.planId ?? "") === safeId) {
    state.savedPlansUi.refineDialog = null;
  }
  state.savedPlansUi.draftsByPlanId[safeId] = createDraftFromSavedPlan(plan);
  refreshSavedPlansUiAndRender();
}

function updateSavedPlanDraftField({ planId, pieceIndex, meldIndex, field, value }) {
  const safeId = String(planId ?? "");
  const draft = state.savedPlansUi.draftsByPlanId?.[safeId];
  if (!draft) {
    return;
  }
  if (field === "name") {
    draft.name = String(value ?? "");
    return;
  }
  if (field === "foodItemId") {
    draft.foodItemId = normalizeNonNegativeInteger(value, 0);
    refreshSavedPlansUiAndRender();
    return;
  }
  if (field === "foodUseHq") {
    draft.foodUseHq = Boolean(value);
    refreshSavedPlansUiAndRender();
    return;
  }
  if (field === "pieceId") {
    const piece = draft?.pieceMelds?.[pieceIndex];
    if (!piece) {
      return;
    }
    const nextPieceId = normalizeNonNegativeInteger(value, 0);
    const gearRows = Array.isArray(state?.data?.gear?.rows) ? state.data.gear.rows : [];
    const gearRow = gearRows.find((row) => normalizeNonNegativeInteger(row?.id, 0) === nextPieceId);
    if (!gearRow || String(gearRow?.slot ?? "") !== String(piece?.slot ?? "")) {
      return;
    }
    piece.pieceId = nextPieceId;
    refreshSavedPlansUiAndRender();
    return;
  }
  const piece = draft?.pieceMelds?.[pieceIndex];
  const meld = piece?.melds?.[meldIndex];
  if (!meld) {
    return;
  }

  if (field === "stat") {
    const nextValue = String(value ?? "").toLowerCase();
    if (STAT_KEYS.includes(nextValue)) {
      meld.stat = nextValue;
      const legalGrades = allowedGradesForDraftMeld(nextValue, meld);
      if (Array.isArray(legalGrades) && legalGrades.length > 0) {
        const currentGrade = normalizeNonNegativeInteger(meld.grade, 1);
        if (!legalGrades.includes(currentGrade)) {
          meld.grade = legalGrades[legalGrades.length - 1];
        }
      }
    }
  } else if (field === "grade") {
    meld.grade = Math.max(1, Math.min(12, normalizeNonNegativeInteger(value, 1)));
  }

  refreshSavedPlansUiAndRender();
}

function saveSavedPlanEdits(planId) {
  const safeId = String(planId ?? "");
  const planIndex = findSavedPlanIndexById(safeId);
  if (planIndex < 0) {
    setStatus("Cannot save edits: saved plan not found.", true);
    return;
  }
  const draft = state.savedPlansUi.draftsByPlanId?.[safeId];
  if (!draft) {
    setStatus("Cannot save edits: no draft found for this plan.", true);
    return;
  }

  const currentPlan = state.savedPlans[planIndex];
  const updatedPlan = applyDraftToSavedPlan(currentPlan, draft, savedPlansGradeValueIndex(), {
    gearRows: state?.data?.gear?.rows,
    useGearHq: state?.gear?.useHq,
    foodRows: getFoodRows(),
    overmeldAllowedGradesByStat: state.savedPlansUi.overmeldAllowedGradesByStat,
  }).plan;
  const nextPlans = [...state.savedPlans];
  nextPlans[planIndex] = updatedPlan;
  saveAndStoreSavedPlans(nextPlans);

  state.savedPlansUi.editingPlanId = null;
  delete state.savedPlansUi.draftsByPlanId[safeId];
  state.savedPlansUi.viewPlanId = safeId;
  refreshSavedPlansUiDerived();
  setStatus(`Updated saved plan "${updatedPlan.name}".`);
  render();
}

function cancelSavedPlanEdits(planId) {
  const safeId = String(planId ?? "");
  if (state.savedPlansUi.editingPlanId === safeId) {
    state.savedPlansUi.editingPlanId = null;
  }
  delete state.savedPlansUi.draftsByPlanId[safeId];
  refreshSavedPlansUiAndRender();
}

function deleteSavedPlan(planId) {
  const safeId = String(planId ?? "");
  const idx = findSavedPlanIndexById(safeId);
  if (idx < 0) {
    return;
  }
  const plan = state.savedPlans[idx];
  const confirmed = typeof window === "undefined" || typeof window.confirm !== "function"
    ? true
    : window.confirm(`Delete saved plan "${plan?.name ?? "Saved plan"}"?`);
  if (!confirmed) {
    return;
  }

  const nextPlans = state.savedPlans.filter((_, index) => index !== idx);
  saveAndStoreSavedPlans(nextPlans);
  delete state.savedPlansUi.draftsByPlanId[safeId];
  if (state.savedPlansUi.viewPlanId === safeId) {
    state.savedPlansUi.viewPlanId = null;
  }
  if (state.savedPlansUi.editingPlanId === safeId) {
    state.savedPlansUi.editingPlanId = null;
  }
  if (String(state.savedPlansUi.refineDialog?.planId ?? "") === safeId) {
    state.savedPlansUi.refineDialog = null;
  }
  refreshSavedPlansUiDerived();
  setStatus(`Deleted saved plan "${plan?.name ?? "Saved plan"}".`);
  render();
}

function slugifyName(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function exportSavedPlan(planId) {
  const idx = findSavedPlanIndexById(planId);
  if (idx < 0) {
    return;
  }
  const plan = state.savedPlans[idx];
  const text = exportSavedPlanText(plan);
  const filenameBase = slugifyName(plan?.name || "saved-plan") || "saved-plan";
  const filename = `${filenameBase}.txt`;

  if (typeof window === "undefined" || typeof document === "undefined" || typeof URL === "undefined") {
    return;
  }

  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  setStatus(`Exported saved plan "${plan?.name ?? "Saved plan"}" as ${filename}.`);
}

function toggleResultPlanDiff({ resultIndex, planIndex }) {
  const row = state.results?.[resultIndex];
  const plan = row?.plans?.[planIndex];
  if (!plan?.adjustmentDiff) {
    return;
  }

  const key = planDiffToggleKey(resultIndex, planIndex);
  const current = Boolean(state.resultsUi?.diffEnabledByPlanKey?.[key]);
  state.resultsUi.diffEnabledByPlanKey[key] = !current;
  state.resultsUi.openPlanDetailsByPlanKey[key] = true;
  render();
}

function setResultPlanDetailsOpen({ resultIndex, planIndex, open }) {
  const key = planDiffToggleKey(resultIndex, planIndex);
  state.resultsUi.openPlanDetailsByPlanKey[key] = Boolean(open);
}

function defaultRefineTargetsForSavedPlan(savedPlan) {
  const baseline = savedPlanTotals(savedPlan);
  const currentTargets = summarizeTotals(state.targets);
  return hasAnyTargets(currentTargets) ? currentTargets : baseline;
}

function openSavedPlanRefineDialog(planId) {
  const idx = findSavedPlanIndexById(planId);
  if (idx < 0) {
    setStatus("Cannot refine saved plan: plan not found.", true);
    return;
  }

  const safeId = String(planId ?? "");
  if (state.savedPlansUi.editingPlanId === safeId) {
    setStatus("Save or cancel edits before refining this plan.", true);
    return;
  }

  const existing = state.savedPlansUi.refineDialog;
  if (existing && String(existing?.planId ?? "") === safeId) {
    state.savedPlansUi.refineDialog = null;
    render();
    return;
  }

  state.savedPlansUi.refineDialog = {
    planId: safeId,
    objective: REFINE_OBJECTIVES.IMPROVE_SCORE,
    targets: defaultRefineTargetsForSavedPlan(state.savedPlans[idx]),
  };
  render();
}

function updateSavedPlanRefineDraft({ planId, field, value }) {
  const safeId = String(planId ?? "");
  const dialog = state.savedPlansUi.refineDialog;
  if (!dialog || String(dialog?.planId ?? "") !== safeId) {
    return;
  }

  if (field === "objective") {
    state.savedPlansUi.refineDialog = {
      ...dialog,
      objective: normalizeRefineObjective(value),
    };
    render();
    return;
  }

  if (!STAT_KEYS.includes(field)) {
    return;
  }

  state.savedPlansUi.refineDialog = {
    ...dialog,
    targets: {
      ...(dialog.targets ?? {}),
      [field]: value,
    },
  };
}

function cancelSavedPlanRefineDialog(planId) {
  const safeId = String(planId ?? "");
  if (String(state.savedPlansUi.refineDialog?.planId ?? "") === safeId) {
    state.savedPlansUi.refineDialog = null;
    render();
  }
}

function parseRefineTargets(draftTargets) {
  const parsedTargets = {};
  for (const statKey of STAT_KEYS) {
    const raw = String(draftTargets?.[statKey] ?? "").trim();
    if (raw.length === 0) {
      return Number.NaN;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
      return Number.NaN;
    }
    parsedTargets[statKey] = parsed;
  }
  return summarizeTotals(parsedTargets);
}

async function submitSavedPlanRefineDialog(planId) {
  const safeId = String(planId ?? "");
  const dialog = state.savedPlansUi.refineDialog;
  if (!dialog || String(dialog?.planId ?? "") !== safeId) {
    setStatus("Cannot refine saved plan: refine options are not open.", true);
    return;
  }

  const objective = normalizeRefineObjective(dialog.objective);
  const refineWithAdvanced = isAdvancedModeEnabled();
  let targetOverride = null;
  if (objective === REFINE_OBJECTIVES.HIT_NEW_TARGETS && !refineWithAdvanced) {
    targetOverride = parseRefineTargets(dialog.targets);
    if (!Number.isFinite(targetOverride.gathering) || !Number.isFinite(targetOverride.perception) || !Number.isFinite(targetOverride.gp)) {
      setStatus("Invalid refine targets. Enter non-negative whole numbers.", true);
      return;
    }
  }

  state.savedPlansUi.refineDialog = null;
  await refineSavedPlan(planId, {
    objective,
    targetOverride,
  });
}

async function refineSavedPlan(planId, options = {}) {
  const idx = findSavedPlanIndexById(planId);
  if (idx < 0) {
    setStatus("Cannot refine saved plan: plan not found.", true);
    return;
  }

  const safeId = String(planId ?? "");
  if (state.savedPlansUi.editingPlanId === safeId) {
    setStatus("Save or cancel edits before refining this plan.", true);
    return;
  }

  const savedPlan = state.savedPlans[idx];
  const objective = normalizeRefineObjective(options?.objective);
  const refineWithAdvanced = isAdvancedModeEnabled();

  let targetOverride = summarizeTotals(state.targets);
  if (objective === REFINE_OBJECTIVES.HIT_NEW_TARGETS && !refineWithAdvanced) {
    const suppliedTargets = summarizeTotals(options?.targetOverride);
    if (!Number.isFinite(suppliedTargets.gathering) || !Number.isFinite(suppliedTargets.perception) || !Number.isFinite(suppliedTargets.gp)) {
      setStatus("Invalid refine targets. Enter non-negative whole numbers.", true);
      return;
    }
    targetOverride = suppliedTargets;
    state.targets = { ...targetOverride };
    state.draftTargets = { ...targetOverride };
  }

  syncSelectedGearToSavedPlan(savedPlan);

  const baselineTotals = refineWithAdvanced ? savedPlanTotalsWithoutFood(savedPlan) : savedPlanTotals(savedPlan);
  const baselineScore = refineWithAdvanced ? NaN : Number(scoreCandidate(baselineTotals, targetOverride));
  const baselineAdvancedSummary = refineWithAdvanced
    ? buildAdvancedSummaryForTotals(baselineTotals, {
        advancedProfiles: state?.advanced?.profiles,
        foodRows: getFoodRows(),
      })
    : null;
  const objectiveLabel = refineObjectiveLabel(objective);
  const statusContext = `Refine from "${savedPlan.name}" (${objectiveLabel}).`;

  const solved = await runSolver({
    targetsOverride: targetOverride,
    forceLegacyMode: !refineWithAdvanced,
    skipDiversify: true,
    statusContext,
    advancedDisplayLimit: refineWithAdvanced ? ADVANCED_FRONTIER_HARD_CAP : undefined,
    advancedDecoratePlan: refineWithAdvanced
      ? (plan) => ({
          ...plan,
          adjustmentDiff: buildAdjustmentDiffForPlan(savedPlan, plan),
        })
      : null,
    advancedPreferLowAdjustment: refineWithAdvanced,
    postProcessResults: (rows) => {
      const rowsWithTargets = (Array.isArray(rows) ? rows : []).map((row) => ({
        ...row,
        meetsTargets: totalsMeetTargets({
          gathering: row?.totalGathering,
          perception: row?.totalPerception,
          gp: row?.totalGp,
        }),
      }));
      const withDiff = annotateResultsWithRefineDiff(rowsWithTargets, savedPlan);
      return rankRefineResults(withDiff, {
        objective,
        baselineScore,
        useAdvancedScoring: refineWithAdvanced,
        baselineAdvancedSummary,
        limit: refineWithAdvanced
          ? normalizeMaxResultsForSolveMode(state?.solve?.maxResults, SOLVER_MODES.ADVANCED)
          : 0,
      });
    },
  });
  render();

  if (!solved) {
    return;
  }
  if (state.results.length > 0) {
    return;
  }

  if (objective === REFINE_OBJECTIVES.HIT_NEW_TARGETS) {
    if (refineWithAdvanced) {
      setStatus(`No refinement results hit additional advanced breakpoints for "${savedPlan.name}".`, true);
      return;
    }
    setStatus(`No refinement results met targets for "${savedPlan.name}".`, true);
    return;
  }
  setStatus(`No refinement results beat baseline score ${Math.round(baselineScore)} for "${savedPlan.name}".`, true);
}

function rejectAllPendingWorkerRequests(error) {
  for (const pending of pendingWorkerRequests.values()) {
    pending.reject(error);
  }
  pendingWorkerRequests.clear();
}

function handleWorkerMessage(event) {
  const payload = event.data ?? {};
  const requestId = Number(payload.requestId);
  if (!Number.isFinite(requestId)) {
    return;
  }
  const pending = pendingWorkerRequests.get(requestId);
  if (!pending) {
    return;
  }

  if (payload?.type === "solve_progress") {
    pending.onProgress?.(payload?.progress ?? {});
    return;
  }

  if (payload?.type !== "solve_result") {
    return;
  }

  pendingWorkerRequests.delete(requestId);
  if (payload.status === "ok") {
    pending.resolve(payload);
    return;
  }
  pending.reject(new Error(payload?.message || "Worker solve failed."));
}

function handleWorkerError(event) {
  const message = event?.message || "Unknown worker runtime error.";
  const error = new Error(`Solver worker error: ${message}`);
  rejectAllPendingWorkerRequests(error);
  teardownSolverWorker();
  console.error(event);
}

function teardownSolverWorker() {
  if (!solverWorker) {
    return;
  }

  solverWorker.removeEventListener("message", handleWorkerMessage);
  solverWorker.removeEventListener("error", handleWorkerError);
  solverWorker.terminate();
  solverWorker = null;
}

function ensureSolverWorker() {
  if (solverWorker) {
    return solverWorker;
  }
  if (typeof Worker === "undefined") {
    return null;
  }

  solverWorker = new Worker(new URL("./solver/solver.worker.js", import.meta.url), {
    type: "module",
  });
  solverWorker.addEventListener("message", handleWorkerMessage);
  solverWorker.addEventListener("error", handleWorkerError);
  return solverWorker;
}

// Advanced mode scores plans by independent breakpoints — a disjunctive goal
// ("hit as many of these per-stat thresholds as possible"). That cannot be
// expressed as a single conjunctive stat target (G>=a AND P>=b AND GP>=c) for
// solver pruning without over-constraining and discarding good plans. So in
// advanced mode we leave the solver targets empty (the depth-first search keeps
// the full Pareto frontier of gear+meld stat combinations via dominated-state
// pruning) and ask the engine for a broad frontier. applyAdvancedMode then ranks
// by breakpoint hits/stat-dump preferences and keeps the display count. To avoid
// truncation bias, runSolver adaptively widens the advanced frontier cap when a
// run saturates without timing out.
function resolveSolveMode(options = {}) {
  if (isAdvancedModeEnabled(options)) {
    return SOLVER_MODES.ADVANCED;
  }
  return SOLVER_MODES.NORMAL;
}

function maxResultsLimitForSolveMode(solveMode) {
  return isAdvancedSolverMode(solveMode)
    ? ADVANCED_MODE_MAX_RESULTS_LIMIT
    : NORMAL_MODE_MAX_RESULTS_LIMIT;
}

function normalizeMaxResultsForSolveMode(value, solveMode) {
  const modeLimit = maxResultsLimitForSolveMode(solveMode);
  return Math.min(modeLimit, Math.max(1, normalizeNonNegativeInteger(value, modeLimit)));
}

function applySolveDefaultsForMode(solveMode) {
  state.solve.maxResults = maxResultsLimitForSolveMode(solveMode);
  state.solve.useBruteForce = isAdvancedSolverMode(solveMode);
}

function buildSolveInputForMode(solveMode, options = {}) {
  if (isAdvancedSolverMode(solveMode)) {
    return buildAdvancedSolveInput(state, {
      baseGathererGp: BASE_GATHERER_GP,
      frontierResultLimit: options?.frontierResultLimit,
    });
  }

  return buildNormalSolveInput(state, {
    targetsOverride: options?.targetsOverride,
    baseGathererGp: BASE_GATHERER_GP,
  });
}

function applyDraftTargetsToSolveTargets() {
  state.targets.gathering = normalizeNonNegativeInteger(
    state.draftTargets.gathering,
    state.targets.gathering,
  );
  state.targets.perception = normalizeNonNegativeInteger(
    state.draftTargets.perception,
    state.targets.perception,
  );
  state.targets.gp = normalizeNonNegativeInteger(state.draftTargets.gp, state.targets.gp);
}

function setAwaitingSolveStatus() {
  setStatus("Ready. Press Solve to generate plans.");
}

function markSolveDirty(options = {}) {
  if (options.syncGear) {
    syncSelectedGearMap();
    if (options.persistGear !== false) {
      persistGearSelection();
    }
  }
  if (options.syncFood) {
    syncFoodSelection();
  }
  state.results = [];
  state.solveDiagnostics = null;
  state.resultsUi.diffEnabledByPlanKey = {};
  setAwaitingSolveStatus();
  render();
}

function currentEditableProfileCount() {
  const profiles = Array.isArray(state?.advanced?.profiles) ? state.advanced.profiles : [];
  return Math.max(1, profiles.length);
}

function clampActiveAdvancedProfileIndex() {
  const maxIndex = Math.max(0, currentEditableProfileCount() - 1);
  state.advanced.activeProfileIndex = Math.min(
    maxIndex,
    normalizeNonNegativeInteger(state?.advanced?.activeProfileIndex, 0),
  );
}

function markAdvancedDirty(options = {}) {
  hydrateAdvancedConfigAgainstData();
  clampActiveAdvancedProfileIndex();
  if (options?.persist !== false) {
    persistAdvancedConfig();
  }
  refreshSavedPlansUiDerived();
  markSolveDirty();
}

function getEditableAdvancedProfile(indexOverride) {
  const profileIndex = Number.isFinite(Number(indexOverride))
    ? normalizeNonNegativeInteger(indexOverride, 0)
    : normalizeNonNegativeInteger(state?.advanced?.activeProfileIndex, 0);
  const limit = Math.max(1, currentEditableProfileCount());
  const safeIndex = Math.min(limit - 1, profileIndex);
  const profiles = Array.isArray(state?.advanced?.profiles) ? state.advanced.profiles : [];
  return profiles[safeIndex] ?? profiles[0] ?? null;
}

function addAdvancedBreakpoint(profileIndex) {
  const profile = getEditableAdvancedProfile(profileIndex);
  if (!profile) {
    return;
  }
  const nextId = Math.max(1, normalizeNonNegativeInteger(state?.advanced?.nextBreakpointId, 1));
  const newBreakpoint = normalizeBreakpoint({
    ...createDefaultBreakpoint(nextId),
    id: `bp_${nextId}`,
  });
  state.advanced.nextBreakpointId = nextId + 1;
  if (!Array.isArray(profile.breakpoints)) {
    profile.breakpoints = [];
  }
  profile.breakpoints.push(newBreakpoint);
  markAdvancedDirty();
}

function removeAdvancedBreakpoint(profileIndex, breakpointId) {
  const profile = getEditableAdvancedProfile(profileIndex);
  if (!profile || !Array.isArray(profile.breakpoints)) {
    return;
  }
  const safeBreakpointId = String(breakpointId ?? "");
  profile.breakpoints = profile.breakpoints.filter((breakpoint) => String(breakpoint?.id ?? "") !== safeBreakpointId);
  markAdvancedDirty();
}

function updateAdvancedBreakpointField({ profileIndex, breakpointId, field, value }) {
  const profile = getEditableAdvancedProfile(profileIndex);
  if (!profile || !Array.isArray(profile.breakpoints)) {
    return;
  }
  const safeBreakpointId = String(breakpointId ?? "");
  const targetBreakpoint = profile.breakpoints.find(
    (breakpoint) => String(breakpoint?.id ?? "") === safeBreakpointId,
  );
  if (!targetBreakpoint) {
    return;
  }

  if (field === "name") {
    targetBreakpoint.name = String(value ?? "").trim() || targetBreakpoint.name || "Breakpoint";
  } else if (field === "enabled") {
    targetBreakpoint.enabled = Boolean(value);
  } else if (field === "stat" && STAT_KEYS.includes(String(value ?? ""))) {
    targetBreakpoint.stat = String(value);
  } else if (field === "value") {
    targetBreakpoint.value = normalizeNonNegativeInteger(value, 0);
  } else if (field === "priority") {
    targetBreakpoint.priority = normalizeOptionalPriority(value);
  }
  markAdvancedDirty();
}

function updateAdvancedProfileName(profileIndex, value) {
  const profile = getEditableAdvancedProfile(profileIndex);
  if (!profile) {
    return;
  }
  const fallbackName = `Profile ${normalizeNonNegativeInteger(profileIndex, 0) + 1}`;
  profile.name = String(value ?? "").trim() || fallbackName;
  markAdvancedDirty();
}

function updateAdvancedProfileFoodQuality(profileIndex, useHq) {
  const profile = getEditableAdvancedProfile(profileIndex);
  if (!profile) {
    return;
  }
  profile.useHq = Boolean(useHq);
  markAdvancedDirty();
}

function updateAdvancedProfileStatDump(profileIndex, statDump) {
  const profile = getEditableAdvancedProfile(profileIndex);
  if (!profile) {
    return;
  }
  profile.statDump = normalizeAdvancedStatDump(statDump, ADVANCED_STAT_DUMP.NONE);
  markAdvancedDirty();
}

function updateAdvancedProfileEnabled(profileIndex, enabled) {
  const profile = getEditableAdvancedProfile(profileIndex);
  if (!profile) {
    return;
  }
  profile.enabled = Boolean(enabled);
  markAdvancedDirty();
}

function addAdvancedProfile() {
  if (!Array.isArray(state?.advanced?.profiles)) {
    state.advanced.profiles = [];
  }
  const nextId = Math.max(1, normalizeNonNegativeInteger(state?.advanced?.nextProfileId, 1));
  const newProfile = normalizeAdvancedProfile(
    {
      ...createDefaultProfile(nextId),
      id: `profile_${nextId}`,
      name: `Profile ${nextId}`,
      enabled: true,
    },
    nextId,
    {
      keepEmptyFoodSelection: true,
      allFoodIds: allFoodIds(),
    },
  );
  state.advanced.nextProfileId = nextId + 1;
  state.advanced.profiles.push(newProfile);
  state.advanced.activeProfileIndex = state.advanced.profiles.length - 1;
  markAdvancedDirty();
}

function copyAdvancedProfile(profileIndex) {
  const sourceProfile = getEditableAdvancedProfile(profileIndex);
  if (!sourceProfile) {
    return;
  }
  if (!Array.isArray(state?.advanced?.profiles)) {
    state.advanced.profiles = [];
  }

  const nextId = Math.max(1, normalizeNonNegativeInteger(state?.advanced?.nextProfileId, 1));
  const copiedProfile = normalizeAdvancedProfile(
    {
      ...sourceProfile,
      id: `profile_${nextId}`,
      name: `${String(sourceProfile?.name ?? "Profile")} Copy`,
      enabled: sourceProfile?.enabled !== false,
      useHq: sourceProfile?.useHq !== false,
      allowedFoodIds: Array.isArray(sourceProfile?.allowedFoodIds) ? [...sourceProfile.allowedFoodIds] : [],
      breakpoints: Array.isArray(sourceProfile?.breakpoints)
        ? sourceProfile.breakpoints.map((breakpoint) => ({ ...breakpoint }))
        : [],
    },
    nextId,
    {
      keepEmptyFoodSelection: true,
      allFoodIds: allFoodIds(),
    },
  );

  state.advanced.nextProfileId = nextId + 1;
  state.advanced.profiles.push(copiedProfile);
  state.advanced.activeProfileIndex = state.advanced.profiles.length - 1;
  markAdvancedDirty();
}

function removeAdvancedProfile(profileIndex) {
  const profiles = Array.isArray(state?.advanced?.profiles) ? state.advanced.profiles : [];
  if (profiles.length <= 1) {
    return;
  }
  const safeIndex = Math.min(profiles.length - 1, normalizeNonNegativeInteger(profileIndex, 0));
  const profile = profiles[safeIndex];
  const fallbackName = `Profile ${safeIndex + 1}`;
  const profileName = String(profile?.name ?? fallbackName).trim() || fallbackName;
  const confirmed = typeof window === "undefined" || typeof window.confirm !== "function"
    ? true
    : window.confirm(`Are you sure you want to delete "${profileName}"?`);
  if (!confirmed) {
    return;
  }
  profiles.splice(safeIndex, 1);
  if (state.advanced.activeProfileIndex >= profiles.length) {
    state.advanced.activeProfileIndex = profiles.length - 1;
  }
  markAdvancedDirty();
}

function toggleAdvancedProfileFood(profileIndex, foodId, enabled) {
  const profile = getEditableAdvancedProfile(profileIndex);
  if (!profile) {
    return;
  }
  const safeFoodId = normalizeNonNegativeInteger(foodId, 0);
  if (safeFoodId <= 0) {
    return;
  }
  const currentSet = new Set(
    (Array.isArray(profile.allowedFoodIds) ? profile.allowedFoodIds : [])
      .map((itemId) => normalizeNonNegativeInteger(itemId, 0))
      .filter((itemId) => itemId > 0),
  );
  if (enabled) {
    currentSet.add(safeFoodId);
  } else {
    currentSet.delete(safeFoodId);
  }
  profile.allowedFoodIds = Array.from(currentSet).sort((a, b) => a - b);
  markAdvancedDirty();
}

function runSolveOnMainThread(solveMode, solveInput, options = {}) {
  const startedAt = nowMs();
  const solveOutput = solveByMode(solveMode, solveInput, {
    onProgress: options?.onProgress,
  });
  return {
    solveOutput,
    usedWorker: false,
    elapsedMs: Math.max(0, Math.round(nowMs() - startedAt)),
  };
}

async function runSolveInWorker(solveMode, solveInput, options = {}) {
  const worker = ensureSolverWorker();
  if (!worker) {
    throw new Error("Web Worker is not available in this browser.");
  }

  const requestId = ++workerRequestSeq;
  return new Promise((resolve, reject) => {
    pendingWorkerRequests.set(requestId, {
      resolve,
      reject,
      onProgress: typeof options?.onProgress === "function" ? options.onProgress : null,
    });
    try {
      worker.postMessage({
        type: "solve",
        requestId,
        solveMode,
        solveInput,
      });
    } catch (error) {
      pendingWorkerRequests.delete(requestId);
      reject(error);
    }
  });
}

function updateSolveStatus(_meta, statusContext = "", _options = {}) {
  const context = typeof statusContext === "string" ? statusContext.trim() : "";
  setStatus(context ? `${context} Solve complete.` : "Solve complete.");
}

async function solveOnceWithWorkerFallback(solveMode, solveInput, onProgress) {
  if (typeof Worker !== "undefined") {
    try {
      const workerResponse = await runSolveInWorker(solveMode, solveInput, {
        onProgress,
      });
      return {
        solveOutput: workerResponse.solveOutput,
        solveMeta: {
          usedWorker: true,
          elapsedMs: normalizeNonNegativeInteger(workerResponse.elapsedMs, 0),
        },
      };
    } catch (workerError) {
      console.error(workerError);
      teardownSolverWorker();
      const fallback = runSolveOnMainThread(solveMode, solveInput, {
        onProgress,
      });
      return {
        solveOutput: fallback.solveOutput,
        solveMeta: {
          usedWorker: false,
          elapsedMs: fallback.elapsedMs,
        },
      };
    }
  }

  const fallback = runSolveOnMainThread(solveMode, solveInput, {
    onProgress,
  });
  return {
    solveOutput: fallback.solveOutput,
    solveMeta: {
      usedWorker: false,
      elapsedMs: fallback.elapsedMs,
    },
  };
}

async function runSolver(options = {}) {
  if (!state.data) {
    return false;
  }

  const solveToken = ++latestSolveToken;
  const solveMode = resolveSolveMode(options);
  const advancedActive = isAdvancedSolverMode(solveMode);
  syncSelectedGearMap();
  syncFoodSelection();
  beginSolveLoading(solveToken);
  const handleSolveProgress = (progress) => {
    if (solveToken !== latestSolveToken) {
      return;
    }
    updateSolveLoadingProgress(progress, solveToken);
  };

  let solveOutput = null;
  let solveMeta = {
    usedWorker: false,
    elapsedMs: 0,
  };
  let advancedFrontierWidenAttempts = 0;
  let advancedFrontierLimitUsed = normalizeNonNegativeInteger(ADVANCED_FRONTIER_RESULT_LIMIT, 12000);
  const overallWalltimeGuardMs = Math.max(
    1,
    Math.round(
      normalizeNonNegativeInteger(state?.solve?.timeBudgetMs, 10000) *
        ADVANCED_FRONTIER_WALLTIME_GUARD_MULTIPLIER,
    ),
  );
  const solveWalltimeStartedAtMs = nowMs();

  try {
    while (true) {
      if (advancedActive) {
        advancedFrontierLimitUsed = Math.min(
          ADVANCED_FRONTIER_HARD_CAP,
          Math.max(1, advancedFrontierLimitUsed),
        );
      }

      const solveInput = buildSolveInputForMode(solveMode, {
        ...options,
        frontierResultLimit: advancedActive ? advancedFrontierLimitUsed : undefined,
      });
      const attempt = await solveOnceWithWorkerFallback(solveMode, solveInput, handleSolveProgress);
      solveOutput = attempt.solveOutput;
      solveMeta = attempt.solveMeta;

      if (!advancedActive) {
        break;
      }
      if (solveToken !== latestSolveToken) {
        return false;
      }

      const frontierRows = Array.isArray(solveOutput?.results) ? solveOutput.results.length : 0;
      const diagnostics = solveOutput?.diagnostics ?? {};
      const saturated = frontierRows >= advancedFrontierLimitUsed;
      const overallElapsedMs = Math.max(0, Math.round(nowMs() - solveWalltimeStartedAtMs));
      const canWiden =
        saturated &&
        diagnostics?.terminatedByTime !== true &&
        diagnostics?.terminatedEarly !== true &&
        advancedFrontierWidenAttempts < ADVANCED_FRONTIER_MAX_WIDEN_ATTEMPTS &&
        advancedFrontierLimitUsed < ADVANCED_FRONTIER_HARD_CAP &&
        overallElapsedMs < overallWalltimeGuardMs;

      if (!canWiden) {
        break;
      }

      const nextLimit = Math.min(
        ADVANCED_FRONTIER_HARD_CAP,
        advancedFrontierLimitUsed * ADVANCED_FRONTIER_GROWTH_FACTOR,
      );
      if (nextLimit <= advancedFrontierLimitUsed) {
        break;
      }
      advancedFrontierLimitUsed = nextLimit;
      advancedFrontierWidenAttempts += 1;
    }
  } catch (error) {
    if (solveToken !== latestSolveToken) {
      return false;
    }
    const message = error instanceof Error ? error.message : "Unexpected solver error.";
    setStatus(`Solve failed: ${message}`, true);
    console.error(error);
    return false;
  } finally {
    endSolveLoading(solveToken);
  }

  if (solveToken !== latestSolveToken || !solveOutput) {
    return false;
  }

  state.selectedGearRows = solveOutput.selectedGearRows;
  state.solveDiagnostics = solveOutput.diagnostics;
  const baseResults = Array.isArray(solveOutput?.results) ? solveOutput.results : [];
  const advancedDisplayLimit =
    options?.advancedDisplayLimit == null
      ? normalizeMaxResultsForSolveMode(state?.solve?.maxResults, SOLVER_MODES.ADVANCED)
      : Math.max(1, normalizeNonNegativeInteger(options.advancedDisplayLimit, ADVANCED_MODE_MAX_RESULTS_LIMIT));
  const rawResultsWithFood = advancedActive
    ? applyAdvancedMode(baseResults, {
        advancedProfiles: state?.advanced?.profiles,
        foodRows: getFoodRows(),
        displayLimit: advancedDisplayLimit,
        variantLimit: ADVANCED_MODE_VARIANT_LIMIT,
        decoratePlan: options?.advancedDecoratePlan,
        preferLowAdjustment: options?.advancedPreferLowAdjustment === true,
      })
    : applyFixedFood(baseResults);
  const maybePostProcessed =
    typeof options?.postProcessResults === "function"
      ? options.postProcessResults(rawResultsWithFood)
      : rawResultsWithFood;
  const nextResults = Array.isArray(maybePostProcessed) ? maybePostProcessed : rawResultsWithFood;
  state.results =
    options?.skipDiversify || advancedActive ? nextResults : diversifyDisplayOrderByScoreGp(nextResults);
  state.resultsUi.diffEnabledByPlanKey = {};
  state.resultsUi.openPlanDetailsByPlanKey = {};
  if (advancedActive) {
    solveMeta = {
      ...solveMeta,
      frontierResultLimit: advancedFrontierLimitUsed,
      frontierWidenAttempts: advancedFrontierWidenAttempts,
    };
  }
  updateSolveStatus(solveMeta, String(options?.statusContext ?? ""), {
    advancedActive,
  });
  return true;
}

function render() {
  if (!controlsPanelElement || !resultsPanelElement) {
    return;
  }

  applyControlsPanelVisibility();

  renderControlsPanel(controlsPanelElement, state, {
    onTargetDraftChange: (statKey, value) => {
      state.draftTargets[statKey] = normalizeNonNegativeInteger(value, state.draftTargets[statKey]);
      // Do not rerender on tab/blur between target inputs; keep native focus order intact.
    },
    onTargetSolve: () => {
      applyDraftTargetsToSolveTargets();
      void triggerSolveAndRender();
    },
    onFoodFixedChange: (isFixed) => {
      state.food.isFixed = !!isFixed;
      markSolveDirty({ syncFood: true });
    },
    onFoodSelectChange: (itemId) => {
      const parsed = normalizeNonNegativeInteger(itemId, 0);
      state.food.selectedFoodId = parsed === 0 ? 0 : parsed;
      markSolveDirty({ syncFood: true });
    },
    onFoodQualityChange: (useHq) => {
      state.food.useHq = !!useHq;
      markSolveDirty();
    },
    onMaxResultsChange: (value) => {
      const solveMode = resolveSolveMode();
      state.solve.maxResults = normalizeMaxResultsForSolveMode(value, solveMode);
      markSolveDirty();
    },
    onTimeBudgetChange: (value) => {
      const seconds = Math.max(1, normalizeNonNegativeInteger(value, Math.round(state.solve.timeBudgetMs / 1000)));
      state.solve.timeBudgetMs = seconds * 1000;
      markSolveDirty();
    },
    onBruteForceChange: (enabled) => {
      state.solve.useBruteForce = !!enabled;
      markSolveDirty();
    },
    onSolveNow: () => {
      if (!state?.advanced?.enabled) {
        applyDraftTargetsToSolveTargets();
      }
      void triggerSolveAndRender();
    },
  });
  renderGearEditor(controlsPanelElement, state, {
    onGearChange: (slot, itemId) => {
      const normalizedItemId = normalizeNonNegativeInteger(
        itemId,
        state.selectedGearBySlot[slot] ?? 0,
      );
      if (slot === "ring") {
        setRingSelection(state.selectedGearBySlot, normalizedItemId);
      } else {
        state.selectedGearBySlot[slot] = normalizedItemId;
      }
      markSolveDirty({ syncGear: true });
    },
    onGearQualityChange: (useHq) => {
      state.gear.useHq = !!useHq;
      markSolveDirty({ syncGear: true });
    },
  });
  renderResultsTable(resultsPanelElement, state, {
    onSaveResultPlan: ({ resultIndex, planIndex }) => {
      saveResultPlanVariant(resultIndex, planIndex);
    },
    onToggleSavedPlanView: ({ planId }) => {
      toggleSavedPlanView(planId);
    },
    onToggleSavedPlanEdit: ({ planId }) => {
      toggleSavedPlanEdit(planId);
    },
    onCopySavedPlan: ({ planId }) => {
      copySavedPlan(planId);
    },
    onSavedPlanDraftChange: ({ planId, pieceIndex, meldIndex, field, value }) => {
      updateSavedPlanDraftField({ planId, pieceIndex, meldIndex, field, value });
    },
    onSaveSavedPlanEdits: ({ planId }) => {
      saveSavedPlanEdits(planId);
    },
    onCancelSavedPlanEdits: ({ planId }) => {
      cancelSavedPlanEdits(planId);
    },
    onDeleteSavedPlan: ({ planId }) => {
      deleteSavedPlan(planId);
    },
    onExportSavedPlan: ({ planId }) => {
      exportSavedPlan(planId);
    },
    onRefineSavedPlan: ({ planId }) => {
      openSavedPlanRefineDialog(planId);
    },
    onSavedPlanRefineDraftChange: ({ planId, field, value }) => {
      updateSavedPlanRefineDraft({ planId, field, value });
    },
    onSubmitSavedPlanRefine: ({ planId }) => {
      void submitSavedPlanRefineDialog(planId);
    },
    onCancelSavedPlanRefine: ({ planId }) => {
      cancelSavedPlanRefineDialog(planId);
    },
    onToggleSavedPlanBreakpointCheck: ({ planId }) => {
      toggleSavedPlanBreakpointCheck(planId);
    },
    onSavedPlanBreakpointCheckChange: ({ planId, profileId, field, value }) => {
      updateSavedPlanBreakpointCheckDraft({ planId, profileId, field, value });
    },
    onToggleResultPlanDiff: ({ resultIndex, planIndex }) => {
      toggleResultPlanDiff({ resultIndex, planIndex });
    },
    onResultPlanDetailsToggle: ({ resultIndex, planIndex, open }) => {
      setResultPlanDetailsOpen({ resultIndex, planIndex, open });
    },
    onAdvancedEnabledChange: (enabled) => {
      state.advanced.enabled = Boolean(enabled);
      applySolveDefaultsForMode(resolveSolveMode());
      if (!state.advanced.enabled) {
        state.savedPlansUi.breakpointCheckViewPlanId = null;
      }
      markAdvancedDirty();
    },
    onAdvancedProfileTabChange: (profileIndex) => {
      state.advanced.activeProfileIndex = normalizeNonNegativeInteger(profileIndex, 0);
      clampActiveAdvancedProfileIndex();
      persistAdvancedConfig();
      render();
    },
    onAdvancedAddProfile: () => {
      addAdvancedProfile();
    },
    onAdvancedCopyProfile: ({ profileIndex }) => {
      copyAdvancedProfile(profileIndex);
    },
    onAdvancedLoadPreset75: () => {
      void applyAdvancedPreset75();
    },
    onAdvancedRemoveProfile: ({ profileIndex }) => {
      removeAdvancedProfile(profileIndex);
    },
    onAdvancedProfileEnabledChange: ({ profileIndex, enabled }) => {
      updateAdvancedProfileEnabled(profileIndex, enabled);
    },
    onAdvancedProfileNameChange: ({ profileIndex, value }) => {
      updateAdvancedProfileName(profileIndex, value);
    },
    onAdvancedProfileFoodQualityChange: ({ profileIndex, useHq }) => {
      updateAdvancedProfileFoodQuality(profileIndex, useHq);
    },
    onAdvancedProfileStatDumpChange: ({ profileIndex, statDump }) => {
      updateAdvancedProfileStatDump(profileIndex, statDump);
    },
    onAdvancedFoodToggle: ({ profileIndex, foodId, enabled }) => {
      toggleAdvancedProfileFood(profileIndex, foodId, enabled);
    },
    onAdvancedAddBreakpoint: ({ profileIndex }) => {
      addAdvancedBreakpoint(profileIndex);
    },
    onAdvancedRemoveBreakpoint: ({ profileIndex, breakpointId }) => {
      removeAdvancedBreakpoint(profileIndex, breakpointId);
    },
    onAdvancedBreakpointFieldChange: ({ profileIndex, breakpointId, field, value }) => {
      updateAdvancedBreakpointField({ profileIndex, breakpointId, field, value });
    },
  });
}

async function triggerSolveAndRender() {
  await runSolver();
  render();
}

function installIconHqFallback() {
  if (typeof document === "undefined") {
    return;
  }
  // Not every item has an HQ icon variant. When the `hq/` asset 404s, swap the
  // src back to the normal icon (same path without `hq/`) and retry once.
  // `error` events don't bubble, so we listen in the capture phase.
  document.addEventListener(
    "error",
    (event) => {
      const img = event.target;
      if (!(img instanceof HTMLImageElement) || img.dataset.hqFallbackTried === "1") {
        return;
      }
      const src = img.getAttribute("src") || "";
      if (!src.includes("v2.xivapi.com") || !src.includes("/hq/")) {
        return;
      }
      img.dataset.hqFallbackTried = "1";
      img.src = src.replace("/hq/", "/");
    },
    true,
  );
}

async function init() {
  installIconHqFallback();
  initializeControlsPanelToggle();
  setStatus("Loading processed JSON...");

  try {
    state.data = await loadProcessedData();
    loadedSummary = summarizeProcessedData(state.data);
    loadAdvancedConfig();
    hydrateAdvancedConfigAgainstData();
    applySolveDefaultsForMode(resolveSolveMode());
    const persistedGearSelection = loadGearSelection();
    if (persistedGearSelection?.useHq != null) {
      state.gear.useHq = persistedGearSelection.useHq;
    }
    state.selectedGearBySlot = persistedGearSelection?.selectedGearBySlot ?? buildDefaultSelectionMap();
    state.draftTargets = { ...state.targets };
    syncSelectedGearMap();
    persistGearSelection();
    syncFoodSelection();
    state.savedPlans = loadSavedPlans();
    refreshSavedPlansUiDerived();
    state.results = [];
    state.solveDiagnostics = null;
    setAwaitingSolveStatus();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    setStatus(`Unable to load processed data: ${message}`, true);
    console.error(error);
  }

  render();
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    rejectAllPendingWorkerRequests(new Error("Window unloaded."));
    teardownSolverWorker();
  });
}

init();
