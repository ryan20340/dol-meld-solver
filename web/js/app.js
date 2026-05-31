import { loadProcessedData, summarizeProcessedData } from "./data-loader.js";
import { createInitialState } from "./state.js";
import { buildAutoSelectedGearSet, solveLegalityOnly } from "./solver/engine.js";
import { scoreCandidate } from "./solver/score.js";
import { renderControlsPanel } from "./ui/controls.js";
import { renderGearEditor } from "./ui/gear-editor.js";
import { renderResultsTable } from "./ui/results-table.js";
import { BASE_GATHERER_GP, getGearRowTrackedStats, statSum } from "./utils/gear-stats.js";
import {
  applyDraftToSavedPlan,
  buildAvailableGradesByStat,
  buildOvermeldAllowedGradesByStat,
  buildMateriaGradeValueIndex,
  createDraftFromSavedPlan,
  createSavedPlanFromResult,
  exportSavedPlanText,
  getMaxSavedPlans,
  loadSavedPlans,
  persistSavedPlans,
} from "./saved-plans.js";

const STAT_KEYS = Object.freeze(["gathering", "perception", "gp"]);
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
const UNNUMBERED_PRIORITY_KEY = "__unnumbered__";

function createDefaultBreakpoint(index = 1) {
  const safeIndex = Math.max(1, normalizeNonNegativeInteger(index, 1));
  return {
    id: `bp_${safeIndex}`,
    name: `Breakpoint ${safeIndex}`,
    stat: "gathering",
    value: 0,
    priority: null,
    enabled: true,
  };
}

function createDefaultProfile(index = 1) {
  const safeIndex = Math.max(1, normalizeNonNegativeInteger(index, 1));
  return {
    id: `profile_${safeIndex}`,
    name: `Profile ${safeIndex}`,
    enabled: true,
    useHq: true,
    allowedFoodIds: [],
    breakpoints: [],
  };
}

function buildDefaultAdvancedState() {
  return {
    enabled: false,
    activeProfileIndex: 0,
    nextProfileId: 2,
    nextBreakpointId: 1,
    profiles: [createDefaultProfile(1)],
  };
}

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

  if (typeof window === "undefined" || !window.localStorage) {
    return;
  }

  try {
    window.localStorage.setItem(
      CONTROLS_COLLAPSE_STORAGE_KEY,
      state.ui.controlsCollapsed ? "1" : "0",
    );
  } catch (error) {
    console.warn("Unable to persist controls panel toggle state.", error);
  }
}

function initializeControlsPanelToggle() {
  if (typeof window !== "undefined" && window.localStorage) {
    try {
      const persisted = window.localStorage.getItem(CONTROLS_COLLAPSE_STORAGE_KEY);
      state.ui.controlsCollapsed = persisted === "1";
    } catch (error) {
      console.warn("Unable to read controls panel toggle state.", error);
    }
  }

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

function normalizeNonNegativeInteger(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function normalizeOptionalPriority(value) {
  if (value == null) {
    return null;
  }
  const asText = String(value).trim();
  if (asText === "") {
    return null;
  }
  const parsed = Number(asText);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.floor(parsed);
}

function slotLabel(slotKey) {
  return SLOT_LABELS[String(slotKey ?? "")] ?? String(slotKey ?? "Unknown slot");
}

function summarizeTotals(totals) {
  return {
    gathering: normalizeNonNegativeInteger(totals?.gathering, 0),
    perception: normalizeNonNegativeInteger(totals?.perception, 0),
    gp: normalizeNonNegativeInteger(totals?.gp, 0),
  };
}

function hasAnyTargets(targets) {
  const safe = summarizeTotals(targets);
  return safe.gathering + safe.perception + safe.gp > 0;
}

function savedPlanTotals(savedPlan) {
  return summarizeTotals({
    gathering: savedPlan?.totalGathering,
    perception: savedPlan?.totalPerception,
    gp: savedPlan?.totalGp,
  });
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

function normalizeBreakpoint(raw, fallbackIndex = 1) {
  const fallback = createDefaultBreakpoint(fallbackIndex);
  const rawStat = String(raw?.stat ?? "");
  const stat = STAT_KEYS.includes(rawStat) ? rawStat : fallback.stat;
  return {
    id: String(raw?.id ?? fallback.id),
    name: String(raw?.name ?? fallback.name).trim() || fallback.name,
    stat,
    value: normalizeNonNegativeInteger(raw?.value, 0),
    priority: normalizeOptionalPriority(raw?.priority),
    enabled: raw?.enabled !== false,
  };
}

function normalizeAdvancedProfile(raw, fallbackIndex = 1, options = {}) {
  const fallback = createDefaultProfile(fallbackIndex);
  const validFoodIds = new Set(allFoodIds());
  const keepEmptyFoodSelection = options?.keepEmptyFoodSelection === true;

  const hasExplicitFoodSelection = Array.isArray(raw?.allowedFoodIds);
  const rawAllowedFoodIds = hasExplicitFoodSelection
    ? raw.allowedFoodIds.map((itemId) => normalizeNonNegativeInteger(itemId, 0)).filter((itemId) => validFoodIds.has(itemId))
    : [];
  const uniqueAllowedFoodIds = Array.from(new Set(rawAllowedFoodIds));
  const allowedFoodIds =
    uniqueAllowedFoodIds.length > 0
      ? uniqueAllowedFoodIds
      : keepEmptyFoodSelection && hasExplicitFoodSelection
        ? []
        : allFoodIds();

  const rawBreakpoints = Array.isArray(raw?.breakpoints) ? raw.breakpoints : [];
  return {
    id: String(raw?.id ?? fallback.id),
    name: String(raw?.name ?? fallback.name).trim() || fallback.name,
    enabled: raw?.enabled !== false,
    useHq: raw?.useHq !== false,
    allowedFoodIds,
    breakpoints: rawBreakpoints.map((bp, idx) => normalizeBreakpoint(bp, idx + 1)),
  };
}

function normalizeAdvancedConfig(raw, options = {}) {
  const fallback = buildDefaultAdvancedState();
  const rawProfiles = Array.isArray(raw?.profiles) ? raw.profiles : [];
  if (rawProfiles.length === 0) {
    rawProfiles.push(createDefaultProfile(1));
  }

  const profiles = rawProfiles.map((profile, index) =>
    normalizeAdvancedProfile(profile, index + 1, options),
  );

  const maxProfileIndex = Math.max(0, profiles.length - 1);
  const activeProfileIndex = Math.min(
    maxProfileIndex,
    normalizeNonNegativeInteger(raw?.activeProfileIndex, fallback.activeProfileIndex),
  );
  let nextProfileId = normalizeNonNegativeInteger(raw?.nextProfileId, fallback.nextProfileId);
  let nextBreakpointId = normalizeNonNegativeInteger(raw?.nextBreakpointId, fallback.nextBreakpointId);

  for (const profile of profiles) {
    const profileIdMatch = String(profile?.id ?? "").match(/^profile_(\d+)$/);
    if (profileIdMatch) {
      const seenProfileIndex = normalizeNonNegativeInteger(profileIdMatch[1], 0);
      nextProfileId = Math.max(nextProfileId, seenProfileIndex + 1);
    }
    for (const breakpoint of profile.breakpoints) {
      const idMatch = String(breakpoint?.id ?? "").match(/^bp_(\d+)$/);
      if (!idMatch) {
        continue;
      }
      const seenIndex = normalizeNonNegativeInteger(idMatch[1], 0);
      nextBreakpointId = Math.max(nextBreakpointId, seenIndex + 1);
    }
  }

  return {
    enabled: raw?.enabled === true,
    activeProfileIndex,
    nextProfileId: Math.max(1, nextProfileId),
    nextBreakpointId: Math.max(1, nextBreakpointId),
    profiles,
  };
}

function persistAdvancedConfig() {
  if (typeof window === "undefined" || !window.localStorage) {
    return;
  }
  try {
    window.localStorage.setItem(ADVANCED_CONFIG_STORAGE_KEY, JSON.stringify(state.advanced));
  } catch (error) {
    console.warn("Unable to persist advanced configuration.", error);
  }
}

function loadAdvancedConfig() {
  if (typeof window === "undefined" || !window.localStorage) {
    return;
  }
  try {
    const raw = window.localStorage.getItem(ADVANCED_CONFIG_STORAGE_KEY);
    if (!raw) {
      state.advanced = normalizeAdvancedConfig(state.advanced, {
        keepEmptyFoodSelection: false,
      });
      return;
    }
    const parsed = JSON.parse(raw);
    state.advanced = normalizeAdvancedConfig(parsed, {
      keepEmptyFoodSelection: true,
    });
  } catch (error) {
    console.warn("Unable to read advanced configuration; using defaults.", error);
    state.advanced = normalizeAdvancedConfig(state.advanced, {
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

  if (
    Object.prototype.hasOwnProperty.call(normalized, "ring_left") &&
    !Object.prototype.hasOwnProperty.call(normalized, "ring_right")
  ) {
    normalized.ring_right = normalizeNonNegativeInteger(normalized.ring_left, 0);
  }
  if (
    Object.prototype.hasOwnProperty.call(normalized, "ring_right") &&
    !Object.prototype.hasOwnProperty.call(normalized, "ring_left")
  ) {
    normalized.ring_left = normalizeNonNegativeInteger(normalized.ring_right, 0);
  }

  return normalized;
}

function persistGearSelection() {
  if (typeof window === "undefined" || !window.localStorage) {
    return;
  }
  try {
    const payload = {
      selectedGearBySlot: normalizePersistedGearSelectionMap(state.selectedGearBySlot),
      useHq: state?.gear?.useHq !== false,
    };
    window.localStorage.setItem(GEARSET_STORAGE_KEY, JSON.stringify(payload));
  } catch (error) {
    console.warn("Unable to persist gearset selection.", error);
  }
}

function loadGearSelection() {
  if (typeof window === "undefined" || !window.localStorage) {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(GEARSET_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
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
  } catch (error) {
    console.warn("Unable to read persisted gearset selection; using defaults.", error);
    return null;
  }
}

function hydrateAdvancedConfigAgainstData() {
  state.advanced = normalizeAdvancedConfig(state.advanced, {
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

    state.advanced = normalizeAdvancedConfig(
      {
        ...advancedPreset,
        enabled: true,
        activeProfileIndex: 0,
      },
      {
        keepEmptyFoodSelection: true,
      },
    );
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

  const defaultsBySlot = Object.fromEntries(defaults.map((row) => [row.slot, Number(row.id)]));
  if (Object.prototype.hasOwnProperty.call(defaultsBySlot, "ring")) {
    const ringId = normalizeNonNegativeInteger(defaultsBySlot.ring, 0);
    defaultsBySlot.ring_left = ringId;
    defaultsBySlot.ring_right = ringId;
    delete defaultsBySlot.ring;
  }
  return defaultsBySlot;
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
    nextMap.ring_left = leftRingId;
    nextMap.ring_right = rightRingId;
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

function foodRowByItemId(itemId) {
  const safeItemId = normalizeNonNegativeInteger(itemId, 0);
  if (safeItemId <= 0) {
    return null;
  }
  return getFoodRows().find((row) => normalizeNonNegativeInteger(row?.item_id, 0) === safeItemId) ?? null;
}

function computeFoodDeltaForTotals(totals, foodRow, useHq) {
  const deltas = {
    gathering: 0,
    perception: 0,
    gp: 0,
  };
  if (!foodRow || !Array.isArray(foodRow.effects)) {
    return deltas;
  }

  for (const effect of foodRow.effects) {
    const statKey = effect.stat;
    if (!STAT_KEYS.includes(statKey)) {
      continue;
    }

    const value = useHq && foodRow.can_be_hq ? Number(effect.hq_value) || 0 : Number(effect.nq_value) || 0;
    const maxCap = useHq && foodRow.can_be_hq ? Number(effect.hq_max) || 0 : Number(effect.nq_max) || 0;
    const baseStat = Number(totals?.[statKey]) || 0;

    let delta = 0;
    if (effect.is_relative) {
      delta = Math.floor((baseStat * value) / 100);
    } else {
      delta = value;
    }

    if (maxCap > 0) {
      delta = Math.min(delta, maxCap);
    }
    deltas[statKey] += Math.max(0, delta);
  }

  return deltas;
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

function activeAdvancedProfiles() {
  const profiles = Array.isArray(state?.advanced?.profiles) ? state.advanced.profiles : [];
  return profiles.filter((profile) => profile?.enabled !== false);
}

function enabledBreakpoints(profile) {
  const raw = Array.isArray(profile?.breakpoints) ? profile.breakpoints : [];
  return raw
    .map((bp, index) => normalizeBreakpoint(bp, index + 1))
    .filter((bp) => bp.enabled && STAT_KEYS.includes(bp.stat) && bp.value > 0);
}

function breakpointHit(updatedTotals, breakpoint) {
  const stat = String(breakpoint?.stat ?? "");
  const value = normalizeNonNegativeInteger(breakpoint?.value, 0);
  if (!STAT_KEYS.includes(stat) || value === 0) {
    return false;
  }
  return (Number(updatedTotals?.[stat]) || 0) >= value;
}

function priorityKey(priority) {
  return priority == null ? UNNUMBERED_PRIORITY_KEY : String(priority);
}

function buildPriorityLedger(breakpointResults) {
  const rows = Array.isArray(breakpointResults) ? breakpointResults : [];
  const hitByKey = Object.create(null);
  const enabledByKey = Object.create(null);
  const numericLevels = new Set();

  for (const row of rows) {
    const priority = normalizeOptionalPriority(row?.priority);
    const key = priorityKey(priority);
    enabledByKey[key] = (enabledByKey[key] ?? 0) + 1;
    if (row?.hit) {
      hitByKey[key] = (hitByKey[key] ?? 0) + 1;
    }
    if (priority != null) {
      numericLevels.add(priority);
    }
  }

  return {
    orderedNumericLevels: Array.from(numericLevels).sort((left, right) => right - left),
    hitByKey,
    enabledByKey,
  };
}

function comparePriorityLedgers(leftLedger, rightLedger) {
  const leftLevels = Array.isArray(leftLedger?.orderedNumericLevels) ? leftLedger.orderedNumericLevels : [];
  const rightLevels = Array.isArray(rightLedger?.orderedNumericLevels) ? rightLedger.orderedNumericLevels : [];
  const allNumericLevels = Array.from(new Set([...leftLevels, ...rightLevels])).sort((left, right) => right - left);

  for (const level of allNumericLevels) {
    const levelKey = String(level);
    const hitDiff = (Number(rightLedger?.hitByKey?.[levelKey]) || 0) - (Number(leftLedger?.hitByKey?.[levelKey]) || 0);
    if (hitDiff !== 0) {
      return hitDiff;
    }
  }

  const unnumberedHitDiff =
    (Number(rightLedger?.hitByKey?.[UNNUMBERED_PRIORITY_KEY]) || 0) -
    (Number(leftLedger?.hitByKey?.[UNNUMBERED_PRIORITY_KEY]) || 0);
  if (unnumberedHitDiff !== 0) {
    return unnumberedHitDiff;
  }

  return 0;
}

function mergePriorityLedgers(ledgers) {
  const rows = Array.isArray(ledgers) ? ledgers : [];
  const aggregateHitByKey = Object.create(null);
  const aggregateEnabledByKey = Object.create(null);
  const numericLevels = new Set();

  for (const ledger of rows) {
    const orderedLevels = Array.isArray(ledger?.orderedNumericLevels) ? ledger.orderedNumericLevels : [];
    for (const level of orderedLevels) {
      numericLevels.add(level);
      const key = String(level);
      aggregateHitByKey[key] = (aggregateHitByKey[key] ?? 0) + (Number(ledger?.hitByKey?.[key]) || 0);
      aggregateEnabledByKey[key] = (aggregateEnabledByKey[key] ?? 0) + (Number(ledger?.enabledByKey?.[key]) || 0);
    }

    aggregateHitByKey[UNNUMBERED_PRIORITY_KEY] =
      (aggregateHitByKey[UNNUMBERED_PRIORITY_KEY] ?? 0) +
      (Number(ledger?.hitByKey?.[UNNUMBERED_PRIORITY_KEY]) || 0);
    aggregateEnabledByKey[UNNUMBERED_PRIORITY_KEY] =
      (aggregateEnabledByKey[UNNUMBERED_PRIORITY_KEY] ?? 0) +
      (Number(ledger?.enabledByKey?.[UNNUMBERED_PRIORITY_KEY]) || 0);
  }

  return {
    orderedNumericLevels: Array.from(numericLevels).sort((left, right) => right - left),
    hitByKey: aggregateHitByKey,
    enabledByKey: aggregateEnabledByKey,
  };
}

function allowedFoodRowsForProfile(profile) {
  const rows = getFoodRows();
  const allowedIds = new Set(
    (Array.isArray(profile?.allowedFoodIds) ? profile.allowedFoodIds : [])
      .map((itemId) => normalizeNonNegativeInteger(itemId, 0))
      .filter((itemId) => itemId > 0),
  );
  if (allowedIds.size === 0) {
    return [];
  }
  return rows.filter((row) => allowedIds.has(normalizeNonNegativeInteger(row?.item_id, 0)));
}

function buildProfileFoodOption(baseTotals, profile, foodRow) {
  const useHq = Boolean(profile?.useHq && foodRow?.can_be_hq);
  const delta = computeFoodDeltaForTotals(baseTotals, foodRow, useHq);
  const updatedTotals = {
    gathering: (Number(baseTotals?.gathering) || 0) + delta.gathering,
    perception: (Number(baseTotals?.perception) || 0) + delta.perception,
    gp: (Number(baseTotals?.gp) || 0) + delta.gp,
  };
  const breakpoints = enabledBreakpoints(profile);
  const breakpointResults = breakpoints.map((breakpoint) => ({
    ...breakpoint,
    hit: breakpointHit(updatedTotals, breakpoint),
  }));
  const priorityLedger = buildPriorityLedger(breakpointResults);
  const hitCount = breakpointResults.reduce((count, row) => count + (row.hit ? 1 : 0), 0);
  const statSum =
    normalizeNonNegativeInteger(updatedTotals.gathering, 0) +
    normalizeNonNegativeInteger(updatedTotals.perception, 0) +
    normalizeNonNegativeInteger(updatedTotals.gp, 0);

  return {
    hitCount,
    enabledCount: breakpointResults.length,
    statSum,
    updatedTotals,
    priorityLedger,
    breakpointResults,
    food: foodRow
      ? {
          itemId: normalizeNonNegativeInteger(foodRow?.item_id, 0),
          name: String(foodRow?.name ?? "No food"),
          useHq,
          delta,
        }
      : {
          itemId: 0,
          name: "No food",
          useHq: false,
          delta: { gathering: 0, perception: 0, gp: 0 },
        },
  };
}

function evaluateProfileForTotals(baseTotals, profile) {
  const candidateRows = allowedFoodRowsForProfile(profile);
  const options =
    candidateRows.length > 0
      ? candidateRows.map((foodRow) => buildProfileFoodOption(baseTotals, profile, foodRow))
      : [buildProfileFoodOption(baseTotals, profile, null)];

  options.sort((left, right) => {
    const priorityDiff = comparePriorityLedgers(left?.priorityLedger, right?.priorityLedger);
    if (priorityDiff !== 0) {
      return priorityDiff;
    }
    const hitDiff = (Number(right?.hitCount) || 0) - (Number(left?.hitCount) || 0);
    if (hitDiff !== 0) {
      return hitDiff;
    }
    const sumDiff = (Number(right?.statSum) || 0) - (Number(left?.statSum) || 0);
    if (sumDiff !== 0) {
      return sumDiff;
    }
    const gatheringDiff =
      normalizeNonNegativeInteger(right?.updatedTotals?.gathering, 0) -
      normalizeNonNegativeInteger(left?.updatedTotals?.gathering, 0);
    if (gatheringDiff !== 0) {
      return gatheringDiff;
    }
    const perceptionDiff =
      normalizeNonNegativeInteger(right?.updatedTotals?.perception, 0) -
      normalizeNonNegativeInteger(left?.updatedTotals?.perception, 0);
    if (perceptionDiff !== 0) {
      return perceptionDiff;
    }
    const gpDiff =
      normalizeNonNegativeInteger(right?.updatedTotals?.gp, 0) -
      normalizeNonNegativeInteger(left?.updatedTotals?.gp, 0);
    if (gpDiff !== 0) {
      return gpDiff;
    }
    return normalizeNonNegativeInteger(left?.food?.itemId, 0) - normalizeNonNegativeInteger(right?.food?.itemId, 0);
  });

  const top = options[0];
  const bestOptions = options.filter(
    (candidate) =>
      comparePriorityLedgers(candidate?.priorityLedger, top?.priorityLedger) === 0 &&
      normalizeNonNegativeInteger(candidate?.hitCount, 0) === normalizeNonNegativeInteger(top?.hitCount, 0) &&
      normalizeNonNegativeInteger(candidate?.statSum, 0) === normalizeNonNegativeInteger(top?.statSum, 0),
  );

  return {
    profileName: String(profile?.name ?? "Profile"),
    profileId: String(profile?.id ?? ""),
    useHq: profile?.useHq !== false,
    bestOption: top,
    bestOptions,
  };
}

function cloneAdvancedProfileSummary(profileSummary) {
  const best = profileSummary?.bestOption;
  return {
    profileName: String(profileSummary?.profileName ?? "Profile"),
    profileId: String(profileSummary?.profileId ?? ""),
    enabledBreakpoints: normalizeNonNegativeInteger(best?.enabledCount, 0),
    breakpointsMet: normalizeNonNegativeInteger(best?.hitCount, 0),
    totals: summarizeTotals(best?.updatedTotals),
    food: best?.food ?? {
      itemId: 0,
      name: "No food",
      useHq: false,
      delta: { gathering: 0, perception: 0, gp: 0 },
    },
    breakpointResults: Array.isArray(best?.breakpointResults)
      ? best.breakpointResults.map((entry) => ({
          id: String(entry?.id ?? ""),
          name: String(entry?.name ?? "Breakpoint"),
          stat: STAT_KEYS.includes(String(entry?.stat ?? "")) ? String(entry.stat) : "gathering",
          value: normalizeNonNegativeInteger(entry?.value, 0),
          priority: normalizeOptionalPriority(entry?.priority),
          hit: Boolean(entry?.hit),
        }))
      : [],
  };
}

function compareAdvancedSummaries(left, right) {
  const priorityDiff = comparePriorityLedgers(left?.priorityLedger, right?.priorityLedger);
  if (priorityDiff !== 0) {
    return priorityDiff;
  }
  const hitDiff =
    normalizeNonNegativeInteger(right?.breakpointsMet, 0) -
    normalizeNonNegativeInteger(left?.breakpointsMet, 0);
  if (hitDiff !== 0) {
    return hitDiff;
  }
  const enabledDiff =
    normalizeNonNegativeInteger(right?.breakpointsEnabled, 0) -
    normalizeNonNegativeInteger(left?.breakpointsEnabled, 0);
  if (enabledDiff !== 0) {
    return enabledDiff;
  }
  const sumDiff =
    normalizeNonNegativeInteger(right?.tiebreakStatSum, 0) -
    normalizeNonNegativeInteger(left?.tiebreakStatSum, 0);
  if (sumDiff !== 0) {
    return sumDiff;
  }
  return 0;
}

function buildAdvancedSummaryFromProfileEvaluations(profileEvaluations) {
  const rows = Array.isArray(profileEvaluations) ? profileEvaluations : [];
  const scoringProfiles = rows.filter(
    (profileEval) => normalizeNonNegativeInteger(profileEval?.bestOption?.enabledCount, 0) > 0,
  );
  const breakpointsEnabled = scoringProfiles.reduce(
    (sum, profileEval) => sum + normalizeNonNegativeInteger(profileEval?.bestOption?.enabledCount, 0),
    0,
  );
  const breakpointsMet = scoringProfiles.reduce(
    (sum, profileEval) => sum + normalizeNonNegativeInteger(profileEval?.bestOption?.hitCount, 0),
    0,
  );
  const priorityLedger = mergePriorityLedgers(
    scoringProfiles.map((profileEval) => profileEval?.bestOption?.priorityLedger),
  );
  const tiebreakStatSum = rows.reduce(
    (sum, profileEval) => sum + normalizeNonNegativeInteger(profileEval?.bestOption?.statSum, 0),
    0,
  );

  return {
    breakpointsEnabled,
    breakpointsMet,
    priorityLedger,
    tiebreakStatSum,
  };
}

function buildAdvancedSummaryForTotals(baseTotals) {
  const safeTotals = summarizeTotals(baseTotals);
  const profiles = activeAdvancedProfiles();
  const profileEvaluations = profiles.map((profile) => evaluateProfileForTotals(safeTotals, profile));
  return buildAdvancedSummaryFromProfileEvaluations(profileEvaluations);
}

function sumSavedPlanMeldTotals(savedPlan) {
  const totals = {
    gathering: 0,
    perception: 0,
    gp: 0,
  };
  const pieces = Array.isArray(savedPlan?.pieceMelds) ? savedPlan.pieceMelds : [];
  for (const piece of pieces) {
    const melds = Array.isArray(piece?.melds) ? piece.melds : [];
    for (const meld of melds) {
      const statKey = String(meld?.stat ?? "").toLowerCase();
      if (!STAT_KEYS.includes(statKey)) {
        continue;
      }
      totals[statKey] += normalizeNonNegativeInteger(meld?.appliedValue, 0);
    }
  }
  return totals;
}

function savedPlanTotalsWithoutFood(savedPlan) {
  const base = summarizeTotals(savedPlan?.baseTotalsWithoutMeldsAndFood);
  const meldTotals = sumSavedPlanMeldTotals(savedPlan);
  const computedFromParts = summarizeTotals({
    gathering: base.gathering + meldTotals.gathering,
    perception: base.perception + meldTotals.perception,
    gp: base.gp + meldTotals.gp,
  });
  const hasBaseParts = computedFromParts.gathering + computedFromParts.perception + computedFromParts.gp > 0;
  if (hasBaseParts) {
    return computedFromParts;
  }

  const fallbackTotals = savedPlanTotals(savedPlan);
  const fallbackFoodDelta = summarizeTotals(savedPlan?.food?.delta);
  return summarizeTotals({
    gathering: Math.max(0, fallbackTotals.gathering - fallbackFoodDelta.gathering),
    perception: Math.max(0, fallbackTotals.perception - fallbackFoodDelta.perception),
    gp: Math.max(0, fallbackTotals.gp - fallbackFoodDelta.gp),
  });
}

function normalizeSavedPlanBreakpointFoodDraftEntry(entry, profile, fallbackFood) {
  const requestedFoodItemId = normalizeNonNegativeInteger(
    entry?.foodItemId,
    normalizeNonNegativeInteger(fallbackFood?.itemId, 0),
  );
  const selectedFoodRow = foodRowByItemId(requestedFoodItemId);
  const useHqDefault = entry?.useHq == null ? Boolean(fallbackFood?.useHq ?? profile?.useHq !== false) : Boolean(entry.useHq);
  const useHq = Boolean(useHqDefault && selectedFoodRow?.can_be_hq);
  return {
    foodItemId: selectedFoodRow ? normalizeNonNegativeInteger(selectedFoodRow?.item_id, 0) : 0,
    useHq,
  };
}

function evaluateSavedPlanBreakpointCheck(savedPlan, foodDraftByProfileId) {
  const baseTotals = savedPlanTotalsWithoutFood(savedPlan);
  const profiles = activeAdvancedProfiles();
  const perProfileDraft = foodDraftByProfileId && typeof foodDraftByProfileId === "object" ? foodDraftByProfileId : {};

  const profileEvaluations = profiles.map((profile) => {
    const profileId = String(profile?.id ?? "");
    const selectedDraft = normalizeSavedPlanBreakpointFoodDraftEntry(
      perProfileDraft[profileId],
      profile,
      savedPlan?.food,
    );
    const selectedFoodRow = foodRowByItemId(selectedDraft.foodItemId);
    const option = buildProfileFoodOption(
      baseTotals,
      {
        ...profile,
        useHq: selectedDraft.useHq,
      },
      selectedFoodRow,
    );
    return {
      profileName: String(profile?.name ?? "Profile"),
      profileId,
      useHq: selectedDraft.useHq,
      bestOption: option,
      bestOptions: [option],
      selectedFood: selectedDraft,
    };
  });

  const summary = buildAdvancedSummaryFromProfileEvaluations(profileEvaluations);
  return {
    breakpointsEnabled: summary.breakpointsEnabled,
    breakpointsMet: summary.breakpointsMet,
    priorityLedger: summary.priorityLedger,
    tiebreakStatSum: summary.tiebreakStatSum,
    baseTotals,
    profiles: profileEvaluations.map((profileEval) => cloneAdvancedProfileSummary(profileEval)),
    foodDraftByProfileId: Object.fromEntries(
      profileEvaluations.map((profileEval) => [String(profileEval?.profileId ?? ""), { ...profileEval.selectedFood }]),
    ),
  };
}

function applyAdvancedMode(results) {
  const rows = Array.isArray(results) ? results : [];
  const profiles = activeAdvancedProfiles();
  const activeScoringProfileCount = profiles.length;

  const evaluated = rows.map((row) => {
    const baseTotals = {
      gathering: normalizeNonNegativeInteger(row?.totalGathering, 0),
      perception: normalizeNonNegativeInteger(row?.totalPerception, 0),
      gp: normalizeNonNegativeInteger(row?.totalGp, 0),
    };
    const profileEvaluations = profiles.map((profile) => evaluateProfileForTotals(baseTotals, profile));
    const summary = buildAdvancedSummaryFromProfileEvaluations(profileEvaluations);

    const profilesForRow = profileEvaluations.map((profileEval) => cloneAdvancedProfileSummary(profileEval));

    const sourcePlans = Array.isArray(row?.plans) ? row.plans : [];
    const plans = sourcePlans.map((plan, planIndex) => {
      const planProfiles = profileEvaluations.map((profileEval) => {
        const optionsForProfile = Array.isArray(profileEval?.bestOptions) ? profileEval.bestOptions : [];
        const option =
          optionsForProfile[planIndex % Math.max(1, optionsForProfile.length)] ??
          profileEval?.bestOption ??
          buildProfileFoodOption(baseTotals, {}, null);
        return {
          profileName: String(profileEval?.profileName ?? "Profile"),
          profileId: String(profileEval?.profileId ?? ""),
          enabledBreakpoints: normalizeNonNegativeInteger(option?.enabledCount, 0),
          breakpointsMet: normalizeNonNegativeInteger(option?.hitCount, 0),
          totals: summarizeTotals(option?.updatedTotals),
          food: option?.food ?? {
            itemId: 0,
            name: "No food",
            useHq: false,
            delta: { gathering: 0, perception: 0, gp: 0 },
          },
          breakpointResults: Array.isArray(option?.breakpointResults)
            ? option.breakpointResults.map((entry) => ({
                id: String(entry?.id ?? ""),
                name: String(entry?.name ?? "Breakpoint"),
                stat: STAT_KEYS.includes(String(entry?.stat ?? "")) ? String(entry.stat) : "gathering",
                value: normalizeNonNegativeInteger(entry?.value, 0),
                priority: normalizeOptionalPriority(entry?.priority),
                hit: Boolean(entry?.hit),
              }))
            : [],
        };
      });

      const primaryProfileFood = planProfiles[0]?.food ?? row?.food ?? null;
      const primaryProfileTotals = planProfiles[0]?.totals ?? baseTotals;
      return {
        ...plan,
        food: primaryProfileFood,
        totalGathering: normalizeNonNegativeInteger(primaryProfileTotals.gathering, 0),
        totalPerception: normalizeNonNegativeInteger(primaryProfileTotals.perception, 0),
        totalGp: normalizeNonNegativeInteger(primaryProfileTotals.gp, 0),
        advanced: {
          baseTotals,
          profiles: planProfiles,
        },
      };
    });

    const primaryFood = profilesForRow[0]?.food ?? row?.food ?? null;
    const primaryTotals = profilesForRow[0]?.totals ?? baseTotals;
    return {
      ...row,
      score: summary.breakpointsMet,
      totalGathering: normalizeNonNegativeInteger(primaryTotals.gathering, 0),
      totalPerception: normalizeNonNegativeInteger(primaryTotals.perception, 0),
      totalGp: normalizeNonNegativeInteger(primaryTotals.gp, 0),
      food: primaryFood,
      meetsTargets: true,
      plans,
      advanced: {
        enabledProfileCount: activeScoringProfileCount,
        baseTotals,
        profiles: profilesForRow,
        breakpointsMet: summary.breakpointsMet,
        breakpointsEnabled: summary.breakpointsEnabled,
        priorityLedger: summary.priorityLedger,
        tiebreakStatSum: summary.tiebreakStatSum,
      },
    };
  });

  const ranked = evaluated.sort((left, right) => {
    const advancedDiff = compareAdvancedSummaries(left?.advanced, right?.advanced);
    if (advancedDiff !== 0) {
      return advancedDiff;
    }
    return (Number(right?.score) || 0) - (Number(left?.score) || 0);
  });

  // The engine returns the full Pareto frontier (up to thousands of rows) so we
  // can rank by breakpoint hits here; only keep the requested display count.
  const displayLimit = Math.max(1, normalizeNonNegativeInteger(state?.solve?.maxResults, 10));
  return ranked.slice(0, displayLimit);
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

function rankedFoodOptionsForTotals(resultTotals) {
  const options = getFoodRows()
    .map((foodRow) => buildFoodOptionForTotals(resultTotals, foodRow))
    .filter((option) => option.score > 0);

  options.sort((left, right) => {
    const scoreDiff = (Number(right?.score) || 0) - (Number(left?.score) || 0);
    if (scoreDiff !== 0) {
      return scoreDiff;
    }
    const gatheringDiff =
      (Number(right?.updatedTotals?.gathering) || 0) - (Number(left?.updatedTotals?.gathering) || 0);
    if (gatheringDiff !== 0) {
      return gatheringDiff;
    }
    const perceptionDiff =
      (Number(right?.updatedTotals?.perception) || 0) - (Number(left?.updatedTotals?.perception) || 0);
    if (perceptionDiff !== 0) {
      return perceptionDiff;
    }
    const gpDiff = (Number(right?.updatedTotals?.gp) || 0) - (Number(left?.updatedTotals?.gp) || 0);
    if (gpDiff !== 0) {
      return gpDiff;
    }
    return (Number(left?.food?.itemId) || 0) - (Number(right?.food?.itemId) || 0);
  });

  return options;
}

function applyFixedFood(results) {
  if (!state.food.isFixed) {
    const foodRows = getFoodRows();
    if (foodRows.length === 0) {
      return results;
    }
    return results.map((row) => {
      const totals = {
        gathering: Number(row.totalGathering) || 0,
        perception: Number(row.totalPerception) || 0,
        gp: Number(row.totalGp) || 0,
      };
      const rankedFoodOptions = rankedFoodOptionsForTotals(totals);
      if (rankedFoodOptions.length === 0) {
        return row;
      }
      const sourcePlans = Array.isArray(row?.plans) ? row.plans : [];
      const plans = sourcePlans.map((plan, planIndex) => {
        const option = rankedFoodOptions[planIndex % rankedFoodOptions.length] ?? rankedFoodOptions[0];
        const meetsTargets = totalsMeetTargets(option.updatedTotals);
        return {
          ...plan,
          food: option.food,
          totalGathering: option.updatedTotals.gathering,
          totalPerception: option.updatedTotals.perception,
          totalGp: option.updatedTotals.gp,
          meetsTargets,
        };
      });
      const primaryOption =
        (plans[0] && {
          updatedTotals: {
            gathering: Number(plans[0]?.totalGathering) || 0,
            perception: Number(plans[0]?.totalPerception) || 0,
            gp: Number(plans[0]?.totalGp) || 0,
          },
          food: plans[0]?.food ?? rankedFoodOptions[0].food,
          meetsTargets: Boolean(plans[0]?.meetsTargets),
        }) ??
        {
          updatedTotals: rankedFoodOptions[0].updatedTotals,
          food: rankedFoodOptions[0].food,
          meetsTargets: totalsMeetTargets(rankedFoodOptions[0].updatedTotals),
        };
      return {
        ...row,
        totalGathering: primaryOption.updatedTotals.gathering,
        totalPerception: primaryOption.updatedTotals.perception,
        totalGp: primaryOption.updatedTotals.gp,
        meetsTargets: primaryOption.meetsTargets,
        food: primaryOption.food,
        plans,
      };
    });
  }

  const foodRow = getSelectedFoodRow();
  if (!foodRow) {
    return results;
  }

  return results.map((row) => {
    const totals = {
      gathering: Number(row.totalGathering) || 0,
      perception: Number(row.totalPerception) || 0,
      gp: Number(row.totalGp) || 0,
    };
    const foodDelta = computeFoodDeltaForTotals(totals, foodRow, state.food.useHq);
    const updatedTotals = {
      gathering: totals.gathering + foodDelta.gathering,
      perception: totals.perception + foodDelta.perception,
      gp: totals.gp + foodDelta.gp,
    };
    const food = {
      itemId: Number(foodRow.item_id) || 0,
      name: foodRow.name,
      useHq: !!(state.food.useHq && foodRow.can_be_hq),
      delta: foodDelta,
    };
    const meetsTargets = totalsMeetTargets(updatedTotals);
    const sourcePlans = Array.isArray(row?.plans) ? row.plans : [];
    const plans = sourcePlans.map((plan) => ({
      ...plan,
      food,
      totalGathering: updatedTotals.gathering,
      totalPerception: updatedTotals.perception,
      totalGp: updatedTotals.gp,
      meetsTargets,
    }));

    return {
      ...row,
      totalGathering: updatedTotals.gathering,
      totalPerception: updatedTotals.perception,
      totalGp: updatedTotals.gp,
      meetsTargets,
      food,
      plans,
    };
  });
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
    nextMap.ring_right = Number(nextMap.ring_left);
  }
  state.selectedGearBySlot = nextMap;
  syncSelectedGearMap();
  persistGearSelection();
}

function promptRefineObjective() {
  if (typeof window === "undefined" || typeof window.prompt !== "function") {
    return REFINE_OBJECTIVES.IMPROVE_SCORE;
  }

  try {
    const message = [
      "Refine objective:",
      "1 = Improve current plan score",
      "2 = Hit new targets",
    ].join("\n");
    const rawChoice = window.prompt(message, "1");
    if (rawChoice == null) {
      return null;
    }
    const normalized = String(rawChoice).trim().toLowerCase();
    if (normalized === "2" || normalized === "hit" || normalized === "targets") {
      return REFINE_OBJECTIVES.HIT_NEW_TARGETS;
    }
    return REFINE_OBJECTIVES.IMPROVE_SCORE;
  } catch (error) {
    console.warn("Refine objective prompt unavailable; defaulting to score-improvement objective.", error);
    return REFINE_OBJECTIVES.IMPROVE_SCORE;
  }
}

function promptSingleTargetValue(label, fallbackValue) {
  if (typeof window === "undefined" || typeof window.prompt !== "function") {
    return normalizeNonNegativeInteger(fallbackValue, 0);
  }

  const defaultValue = String(normalizeNonNegativeInteger(fallbackValue, 0));
  const raw = window.prompt(`Target ${label}`, defaultValue);
  if (raw == null) {
    return null;
  }
  const trimmed = String(raw).trim();
  if (trimmed.length === 0) {
    return normalizeNonNegativeInteger(fallbackValue, 0);
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return Number.NaN;
  }
  return Math.floor(parsed);
}

function promptRefineTargets(savedPlan) {
  const baseline = savedPlanTotals(savedPlan);
  const currentTargets = summarizeTotals(state.targets);
  const defaults = hasAnyTargets(currentTargets) ? currentTargets : baseline;
  const gathering = promptSingleTargetValue("Gathering", defaults.gathering);
  if (gathering == null) {
    return null;
  }
  const perception = promptSingleTargetValue("Perception", defaults.perception);
  if (perception == null) {
    return null;
  }
  const gp = promptSingleTargetValue("GP", defaults.gp);
  if (gp == null) {
    return null;
  }

  const targets = { gathering, perception, gp };
  if (!Number.isFinite(targets.gathering) || !Number.isFinite(targets.perception) || !Number.isFinite(targets.gp)) {
    return Number.NaN;
  }
  return targets;
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
      if (!baselineMeld && candidateMeld) {
        changedPieceIndices.add(pieceIndex);
        lines.push(`${pieceLabel} ${slotTag}: add ${describeMeldShort(candidateMeld)}`);
        continue;
      }
      if (baselineMeld && !candidateMeld) {
        changedPieceIndices.add(pieceIndex);
        lines.push(`${pieceLabel} ${slotTag}: remove ${describeMeldShort(baselineMeld)}`);
        continue;
      }
      if (baselineMeld && candidateMeld && !meldEquivalent(baselineMeld, candidateMeld)) {
        changedPieceIndices.add(pieceIndex);
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
  };
}

function annotateResultsWithRefineDiff(results, baselinePlan) {
  const rows = Array.isArray(results) ? results : [];
  return rows.map((row) => {
    const plans = Array.isArray(row?.plans) ? row.plans : [];
    const plansWithDiff = plans.map((plan) => ({
      ...plan,
      adjustmentDiff: buildAdjustmentDiffForPlan(baselinePlan, plan),
    }));
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
    filtered = source.filter((row) => row?.meetsTargets);
  } else if (useAdvancedScoring && baselineAdvancedSummary) {
    filtered = source.filter((row) => compareAdvancedSummaries(baselineAdvancedSummary, row?.advanced) > 0);
  } else if (Number.isFinite(baselineScore)) {
    filtered = source.filter((row) => Number(row?.score) > baselineScore);
  }

  return [...filtered].sort((left, right) => {
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

  const gradeValueIndex = state.savedPlansUi.gradeValueIndexByStat;
  const previewByPlanId = {};
  const existingBreakpointFoodByPlanId =
    state.savedPlansUi.breakpointCheckFoodByPlanId && typeof state.savedPlansUi.breakpointCheckFoodByPlanId === "object"
      ? state.savedPlansUi.breakpointCheckFoodByPlanId
      : {};
  const nextBreakpointFoodByPlanId = {};
  const breakpointCheckPreviewByPlanId = {};
  const breakpointProfiles = activeAdvancedProfiles();

  for (const plan of state.savedPlans ?? []) {
    const planId = String(plan?.id ?? "");
    const draft = state.savedPlansUi.draftsByPlanId?.[planId];
    const previewPlan = draft
      ? applyDraftToSavedPlan(plan, draft, gradeValueIndex, {
          foodRows: getFoodRows(),
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
      );
    }
    nextBreakpointFoodByPlanId[planId] = normalizedFoodDraftByProfileId;
    breakpointCheckPreviewByPlanId[planId] = evaluateSavedPlanBreakpointCheck(
      previewPlan,
      normalizedFoodDraftByProfileId,
    );
  }
  state.savedPlansUi.previewByPlanId = previewByPlanId;
  state.savedPlansUi.breakpointCheckFoodByPlanId = nextBreakpointFoodByPlanId;
  state.savedPlansUi.breakpointCheckPreviewByPlanId = breakpointCheckPreviewByPlanId;
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
  refreshSavedPlansUiDerived();
  render();
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
  const profile = activeAdvancedProfiles().find((entry) => String(entry?.id ?? "") === safeProfileId);
  if (!profile) {
    return;
  }

  const existingPlanEntries =
    state.savedPlansUi.breakpointCheckFoodByPlanId?.[safePlanId] &&
    typeof state.savedPlansUi.breakpointCheckFoodByPlanId[safePlanId] === "object"
      ? state.savedPlansUi.breakpointCheckFoodByPlanId[safePlanId]
      : {};
  const currentEntry = normalizeSavedPlanBreakpointFoodDraftEntry(
    existingPlanEntries[safeProfileId],
    profile,
    planPreview?.food,
  );
  if (field === "foodItemId") {
    currentEntry.foodItemId = normalizeNonNegativeInteger(value, 0);
  } else if (field === "useHq") {
    currentEntry.useHq = Boolean(value);
  } else {
    return;
  }

  const normalizedEntry = normalizeSavedPlanBreakpointFoodDraftEntry(currentEntry, profile, planPreview?.food);
  state.savedPlansUi.breakpointCheckFoodByPlanId[safePlanId] = {
    ...existingPlanEntries,
    [safeProfileId]: normalizedEntry,
  };
  refreshSavedPlansUiDerived();
  render();
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

function defaultSavedPlanNameForVariant(resultIndex, planIndex, row) {
  return `Plan #${resultIndex + 1}.${planIndex + 1} - ${normalizeNonNegativeInteger(row?.totalGathering, 0)}/${normalizeNonNegativeInteger(row?.totalPerception, 0)}/${normalizeNonNegativeInteger(row?.totalGp, 0)}`;
}

function saveResultPlanVariant(resultIndex, planIndex) {
  const row = state.results?.[resultIndex];
  const planVariant = row?.plans?.[planIndex];
  if (!row || !planVariant) {
    setStatus("Cannot save plan variant: missing result row data.", true);
    return;
  }

  const defaultName = defaultSavedPlanNameForVariant(resultIndex, planIndex, row);
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
    refreshSavedPlansUiDerived();
    render();
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
  state.savedPlansUi.draftsByPlanId[safeId] = createDraftFromSavedPlan(plan);
  refreshSavedPlansUiDerived();
  render();
}

function updateSavedPlanDraftField({ planId, pieceIndex, meldIndex, field, value }) {
  const safeId = String(planId ?? "");
  const draft = state.savedPlansUi.draftsByPlanId?.[safeId];
  if (!draft) {
    return;
  }
  if (field === "name") {
    draft.name = String(value ?? "");
    refreshSavedPlansUiDerived();
    render();
    return;
  }
  if (field === "foodItemId") {
    draft.foodItemId = normalizeNonNegativeInteger(value, 0);
    refreshSavedPlansUiDerived();
    render();
    return;
  }
  if (field === "foodUseHq") {
    draft.foodUseHq = Boolean(value);
    refreshSavedPlansUiDerived();
    render();
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

  refreshSavedPlansUiDerived();
  render();
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
  refreshSavedPlansUiDerived();
  render();
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
  render();
}

async function refineSavedPlan(planId) {
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
  const objective = promptRefineObjective();
  if (!objective) {
    return;
  }

  let targetOverride = summarizeTotals(state.targets);
  if (objective === REFINE_OBJECTIVES.HIT_NEW_TARGETS) {
    const promptedTargets = promptRefineTargets(savedPlan);
    if (promptedTargets == null) {
      return;
    }
    if (!Number.isFinite(promptedTargets.gathering) || !Number.isFinite(promptedTargets.perception) || !Number.isFinite(promptedTargets.gp)) {
      setStatus("Invalid refine targets. Enter non-negative whole numbers.", true);
      return;
    }
    targetOverride = summarizeTotals(promptedTargets);
    state.targets = { ...targetOverride };
    state.draftTargets = { ...targetOverride };
  }

  syncSelectedGearToSavedPlan(savedPlan);

  const refineWithAdvanced = isAdvancedModeEnabled();
  const baselineTotals = savedPlanTotals(savedPlan);
  const baselineScore = refineWithAdvanced ? NaN : Number(scoreCandidate(baselineTotals, targetOverride));
  const baselineAdvancedSummary = refineWithAdvanced ? buildAdvancedSummaryForTotals(baselineTotals) : null;
  const objectiveLabel = refineObjectiveLabel(objective);
  const statusContext = `Refine from "${savedPlan.name}" (${objectiveLabel}).`;

  const solved = await runSolver({
    targetsOverride: targetOverride,
    forceLegacyMode: !refineWithAdvanced,
    skipDiversify: true,
    statusContext,
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
// pruning) and ask the engine for that whole frontier. applyAdvancedMode then
// ranks the frontier by breakpoint hits and keeps the display count. A small
// maxResults here would truncate the frontier by raw stat-sum and silently drop
// breakpoint-optimal builds (e.g. GP-heavy plans), which is why advanced
// previously returned worse plans than a hand-built set.
const ADVANCED_FRONTIER_RESULT_LIMIT = 4000;

function buildSolveInput(options = {}) {
  const targetOverride = options?.targetsOverride;
  const advancedActive = isAdvancedModeEnabled(options);
  const solveTargets = advancedActive
    ? { gathering: 0, perception: 0, gp: 0 }
    : targetOverride
      ? summarizeTotals(targetOverride)
      : state.targets;
  return {
    selectedGearRows: state.selectedGearRows,
    materiaRows: state.data?.materia?.rows,
    rules: state.data?.rules,
    targets: solveTargets,
    maxResults: advancedActive ? ADVANCED_FRONTIER_RESULT_LIMIT : state.solve.maxResults,
    maxBranches: state.solve.maxBranches,
    maxDurationMs: state.solve.timeBudgetMs,
    maxCandidatesPerPiece: 0,
    useBruteForce: state.solve.useBruteForce === true,
    useGearHq: state.gear.useHq,
    baseGathererGp: BASE_GATHERER_GP,
  };
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
    { keepEmptyFoodSelection: true },
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
    { keepEmptyFoodSelection: true },
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

function runSolveOnMainThread(solveInput, options = {}) {
  const startedAt = nowMs();
  const solveOutput = solveLegalityOnly(solveInput, {
    onProgress: options?.onProgress,
  });
  return {
    solveOutput,
    usedWorker: false,
    elapsedMs: Math.max(0, Math.round(nowMs() - startedAt)),
  };
}

async function runSolveInWorker(solveInput, options = {}) {
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

async function runSolver(options = {}) {
  if (!state.data) {
    return false;
  }

  const solveToken = ++latestSolveToken;
  syncSelectedGearMap();
  syncFoodSelection();
  beginSolveLoading(solveToken);
  const handleSolveProgress = (progress) => {
    if (solveToken !== latestSolveToken) {
      return;
    }
    updateSolveLoadingProgress(progress, solveToken);
  };

  const solveInput = buildSolveInput(options);
  let solveOutput = null;
  let solveMeta = {
    usedWorker: false,
    elapsedMs: 0,
  };

  try {
    if (typeof Worker !== "undefined") {
      try {
        const workerResponse = await runSolveInWorker(solveInput, {
          onProgress: handleSolveProgress,
        });
        solveOutput = workerResponse.solveOutput;
        solveMeta = {
          usedWorker: true,
          elapsedMs: normalizeNonNegativeInteger(workerResponse.elapsedMs, 0),
        };
      } catch (workerError) {
        console.error(workerError);
        teardownSolverWorker();
        const fallback = runSolveOnMainThread(solveInput, {
          onProgress: handleSolveProgress,
        });
        solveOutput = fallback.solveOutput;
        solveMeta = {
          usedWorker: false,
          elapsedMs: fallback.elapsedMs,
        };
      }
    } else {
      const fallback = runSolveOnMainThread(solveInput, {
        onProgress: handleSolveProgress,
      });
      solveOutput = fallback.solveOutput;
      solveMeta = {
        usedWorker: false,
        elapsedMs: fallback.elapsedMs,
      };
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
  const advancedActive = isAdvancedModeEnabled(options);
  const baseResults = Array.isArray(solveOutput?.results) ? solveOutput.results : [];
  const rawResultsWithFood = advancedActive ? applyAdvancedMode(baseResults) : applyFixedFood(baseResults);
  const maybePostProcessed =
    typeof options?.postProcessResults === "function"
      ? options.postProcessResults(rawResultsWithFood)
      : rawResultsWithFood;
  const nextResults = Array.isArray(maybePostProcessed) ? maybePostProcessed : rawResultsWithFood;
  state.results =
    options?.skipDiversify || advancedActive ? nextResults : diversifyDisplayOrderByScoreGp(nextResults);
  state.resultsUi.diffEnabledByPlanKey = {};
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
      state.solve.maxResults = Math.max(1, normalizeNonNegativeInteger(value, state.solve.maxResults));
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
        state.selectedGearBySlot.ring_left = normalizedItemId;
        state.selectedGearBySlot.ring_right = normalizedItemId;
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
      void refineSavedPlan(planId);
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
    onAdvancedEnabledChange: (enabled) => {
      state.advanced.enabled = Boolean(enabled);
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
