import { BASE_GATHERER_GP, sumSelectedGearTrackedStats } from "../utils/gear-stats.js";
import { iconUrlFromRow } from "../utils/icons.js";
import { normalizeNonNegativeInteger } from "../utils/normalize.js";

const FOOD_STAT_ORDER = Object.freeze(["gathering", "perception", "gp"]);
const FOOD_STAT_SHORT_LABELS = Object.freeze({
  gathering: "G",
  perception: "P",
  gp: "GP",
});

const IMAGE_PLACEHOLDER_SRC =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
const INITIAL_DROPDOWN_PRELOAD_COUNT = 12;
const NORMAL_MODE_MAX_RESULTS_LIMIT = 25;
const ADVANCED_MODE_MAX_RESULTS_LIMIT = 10;

const GRADE_ROMAN = Object.freeze(["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"]);

// Slot tiers the player can restrict grades for, matched to the meld-dot colors
// used throughout the results UI.
const GRADE_TIERS = Object.freeze([
  { key: "guaranteed", label: "Guaranteed", dotClass: "meld-dot guaranteed" },
  { key: "overmeldFirst", label: "First Overmeld", dotClass: "meld-dot overmeld-first" },
  { key: "overmeld", label: "Overmelds", dotClass: "meld-dot overmeld" },
]);

function gradeToRoman(grade) {
  const value = Number(grade) || 0;
  return GRADE_ROMAN[value] ?? String(value);
}

// Grades that are actually legal in each slot tier, ascending. Guaranteed slots
// accept any grade; overmeld slots only accept grades whose materia is meldable
// at that overmeld index (rate > 0) — e.g. the top grade of a tier can't be
// overmelded, so it never appears under First Overmeld / Overmelds. Mirrors the
// solver's isMateriaLegalForSlot so the chips match what the solver would allow.
function getAvailableGradesByTier(state) {
  const rows = Array.isArray(state?.data?.materia?.rows) ? state.data.materia.rows : [];
  const guaranteed = new Set();
  const overmeldFirst = new Set();
  const overmeld = new Set();
  for (const row of rows) {
    const grade = Number(row?.grade);
    if (!Number.isFinite(grade) || grade <= 0) {
      continue;
    }
    const safeGrade = Math.floor(grade);
    guaranteed.add(safeGrade);
    const allowedSlots = Array.isArray(row?.overmeld_allowed_slots) ? row.overmeld_allowed_slots : [];
    const rates = Array.isArray(row?.overmeld_rates_nq) ? row.overmeld_rates_nq : [];
    for (const slotRaw of allowedSlots) {
      const overmeldIndex = Math.floor(Number(slotRaw));
      if (!Number.isFinite(overmeldIndex) || overmeldIndex < 0) {
        continue;
      }
      const rate = Number(rates[overmeldIndex] ?? 0);
      if (!Number.isFinite(rate) || rate <= 0) {
        continue;
      }
      if (overmeldIndex === 0) {
        overmeldFirst.add(safeGrade);
      } else {
        overmeld.add(safeGrade);
      }
    }
  }
  const sortAsc = (set) => [...set].sort((a, b) => a - b);
  return {
    guaranteed: sortAsc(guaranteed),
    overmeldFirst: sortAsc(overmeldFirst),
    overmeld: sortAsc(overmeld),
  };
}

function disallowedGradesForTier(state, tierKey) {
  const list = state?.solve?.disallowedGradesByTier?.[tierKey];
  return Array.isArray(list) ? list : [];
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function maxResultsLimitForAdvancedEnabled(advancedEnabled) {
  return advancedEnabled ? ADVANCED_MODE_MAX_RESULTS_LIMIT : NORMAL_MODE_MAX_RESULTS_LIMIT;
}

function selectedGearTotals(state) {
  return sumSelectedGearTrackedStats(state?.selectedGearRows, {
    useHq: state?.gear?.useHq !== false,
    includeBaseGp: true,
  });
}

function hasPendingTargetChanges(state) {
  const draftTargets = state?.draftTargets ?? {};
  const solvedTargets = state?.targets ?? {};
  return (
    normalizeNonNegativeInteger(draftTargets.gathering) !== normalizeNonNegativeInteger(solvedTargets.gathering) ||
    normalizeNonNegativeInteger(draftTargets.perception) !== normalizeNonNegativeInteger(solvedTargets.perception) ||
    normalizeNonNegativeInteger(draftTargets.gp) !== normalizeNonNegativeInteger(solvedTargets.gp)
  );
}

function getSelectedFoodRow(state) {
  const selectedFoodId = Number(state?.food?.selectedFoodId);
  const foodRows = Array.isArray(state?.data?.food?.rows) ? state.data.food.rows : [];
  return foodRows.find((row) => Number(row?.item_id) === selectedFoodId) ?? null;
}

function getFoodEffectValue(effect, useHq) {
  if (!effect || typeof effect !== "object") {
    return 0;
  }
  return Number(useHq ? effect.hq_value : effect.nq_value) || 0;
}

function getFoodEffectMax(effect, useHq) {
  if (!effect || typeof effect !== "object") {
    return 0;
  }
  return Number(useHq ? effect.hq_max : effect.nq_max) || 0;
}

function summarizeFoodEffects(row, useHq) {
  if (!row || !Array.isArray(row.effects)) {
    return "no tracked stats";
  }

  const tokens = [];
  for (const statKey of FOOD_STAT_ORDER) {
    const effect = row.effects.find((candidate) => candidate?.stat === statKey);
    if (!effect) {
      continue;
    }

    const value = getFoodEffectValue(effect, useHq);
    const max = getFoodEffectMax(effect, useHq);
    const label = FOOD_STAT_SHORT_LABELS[statKey] ?? statKey;

    if (effect.is_relative) {
      const capText = max > 0 ? `(${max})` : "";
      tokens.push(`${label}+${value}%${capText}`);
      continue;
    }

    tokens.push(`${label}+${value}`);
  }

  return tokens.length > 0 ? tokens.join(" ") : "no tracked stats";
}

function foodEffectSortScore(row, useHq) {
  if (!row || !Array.isArray(row.effects)) {
    return 0;
  }

  return row.effects.reduce((total, effect) => {
    const value = getFoodEffectValue(effect, useHq);
    const max = getFoodEffectMax(effect, useHq);
    if (effect?.is_relative) {
      return total + (max > 0 ? max : value);
    }
    return total + value;
  }, 0);
}

function computeFoodDeltaForGearTotals(gearTotals, foodRow, useHq) {
  const deltas = {
    gathering: 0,
    perception: 0,
    gp: 0,
  };
  if (!foodRow || !Array.isArray(foodRow.effects)) {
    return deltas;
  }

  for (const effect of foodRow.effects) {
    const statKey = effect?.stat;
    if (!FOOD_STAT_ORDER.includes(statKey)) {
      continue;
    }

    const value = getFoodEffectValue(effect, useHq);
    const maxCap = getFoodEffectMax(effect, useHq);
    const baseStat = Number(gearTotals?.[statKey]) || 0;

    let delta = effect.is_relative ? Math.floor((baseStat * value) / 100) : value;
    if (maxCap > 0) {
      delta = Math.min(delta, maxCap);
    }
    deltas[statKey] += Math.max(0, delta);
  }

  return deltas;
}

function renderSelectedFoodStats(state, gearTotals) {
  const selectedRow = getSelectedFoodRow(state);
  if (!selectedRow) {
    return '<p class="muted">Selected food stats: n/a</p>';
  }

  const activeUseHq = !!(state?.food?.useHq && selectedRow.can_be_hq);
  const nqSummary = summarizeFoodEffects(selectedRow, false);
  const hqSummary = selectedRow.can_be_hq ? summarizeFoodEffects(selectedRow, true) : null;
  const activeDelta = computeFoodDeltaForGearTotals(gearTotals, selectedRow, activeUseHq);
  const qualitySummary = selectedRow.can_be_hq
    ? `NQ: ${nqSummary} | HQ: ${hqSummary}`
    : `NQ: ${nqSummary}`;
  const activeQualityLabel = activeUseHq ? "HQ" : "NQ";
  const selectedName = String(selectedRow?.name ?? "Food");
  const selectedIconUrl = iconUrlFromRow(selectedRow, {
    useHqVariant: activeUseHq && selectedRow?.can_be_hq === true,
  });
  const iconHtml = selectedIconUrl
    ? `<img class="item-icon item-icon-food" src="${selectedIconUrl}" alt="${escapeHtml(`${selectedName} icon`)}" loading="lazy" decoding="async">`
    : '<span class="item-icon item-icon-food item-icon-placeholder" aria-hidden="true"></span>';

  return `
    <div class="food-stats">
      <p class="item-with-icon">
        ${iconHtml}
        <span><strong>${escapeHtml(selectedName)}</strong> (${activeQualityLabel})</span>
      </p>
      <p class="muted">${escapeHtml(qualitySummary)}</p>
      <p class="muted">Active ${activeQualityLabel} bonus at current gear totals: G +${activeDelta.gathering}, P +${activeDelta.perception}, GP +${activeDelta.gp}</p>
    </div>
  `;
}

function buildFoodRowsSorted(state, useHqForSort = false) {
  const sourceRows = Array.isArray(state?.data?.food?.rows) ? state.data.food.rows : [];
  return [...sourceRows].sort((left, right) => {
    const ilvDiff = (Number(right?.item_level) || 0) - (Number(left?.item_level) || 0);
    if (ilvDiff !== 0) {
      return ilvDiff;
    }

    const rightScore = foodEffectSortScore(right, useHqForSort);
    const leftScore = foodEffectSortScore(left, useHqForSort);
    if (rightScore !== leftScore) {
      return rightScore - leftScore;
    }

    const nameDiff = String(left?.name ?? "").localeCompare(String(right?.name ?? ""));
    if (nameDiff !== 0) {
      return nameDiff;
    }

    return (Number(left?.item_id) || 0) - (Number(right?.item_id) || 0);
  });
}

function buildFoodDropdownEntries(state) {
  const foodRows = buildFoodRowsSorted(state, !!state?.food?.useHq);
  const selectedFoodId = Number(state?.food?.selectedFoodId);
  const entries = foodRows.map((row) => {
    const itemId = Number(row?.item_id) || 0;
    const useHqVariant = Boolean(state?.food?.useHq && row?.can_be_hq);
    const summary = summarizeFoodEffects(row, useHqVariant);
    const iconUrl = iconUrlFromRow(row, { useHqVariant });
    return {
      value: itemId,
      label: row?.name ?? `Food ${itemId}`,
      summary,
      iconUrl,
    };
  });

  entries.unshift({
    value: 0,
    label: "None",
    summary: "No food",
    iconUrl: "",
  });

  const selectedEntry =
    entries.find((entry) => entry.value === selectedFoodId) ??
    entries[0];

  return {
    entries,
    selectedEntry,
  };
}

function buildFoodDropdownOptionHtml(option, selected = false, disabled = false) {
  const iconHtml = option?.iconUrl
    ? `<img class="item-icon item-icon-food" src="${IMAGE_PLACEHOLDER_SRC}" data-src="${option.iconUrl}" alt="${escapeHtml(`${option?.label ?? "Food"} icon`)}" loading="lazy" decoding="async">`
    : '<span class="item-icon item-icon-food item-icon-placeholder" aria-hidden="true"></span>';

  return `
    <button
      type="button"
      class="icon-dropdown-option${selected ? " icon-dropdown-option-selected" : ""}"
      data-food-dropdown-value="${Number(option?.value) || 0}"
      title="${escapeHtml(option?.label ?? "")}"
      ${disabled ? "disabled" : ""}
    >
      <span class="item-with-icon">
        ${iconHtml}
        <span>${escapeHtml(option?.label ?? "Food")}</span>
      </span>
    </button>
  `;
}

function buildFoodDropdownHtml(state, disabled = false) {
  const { entries, selectedEntry } = buildFoodDropdownEntries(state);
  const selectedIconHtml = selectedEntry?.iconUrl
    ? `<img class="item-icon item-icon-food" src="${selectedEntry.iconUrl}" alt="${escapeHtml(`${selectedEntry?.label ?? "Food"} icon`)}" loading="lazy" decoding="async">`
    : '<span class="item-icon item-icon-food item-icon-placeholder" aria-hidden="true"></span>';
  const selectedSummary = selectedEntry?.summary ? ` - ${selectedEntry.summary}` : "";
  const optionsHtml = entries
    .map((entry) => buildFoodDropdownOptionHtml(entry, entry.value === selectedEntry.value, disabled))
    .join("");

  return `
    <div class="icon-dropdown${disabled ? " icon-dropdown-disabled" : ""}" data-food-dropdown="1" tabindex="0">
      <button type="button" id="food-select" class="icon-dropdown-trigger" data-food-dropdown-trigger aria-haspopup="listbox" aria-expanded="false" ${disabled ? "disabled" : ""}>
        <span class="item-with-icon">
          ${selectedIconHtml}
          <span class="icon-dropdown-trigger-label">${escapeHtml(selectedEntry?.label ?? "None")}${escapeHtml(selectedSummary)}</span>
        </span>
        <span class="icon-dropdown-caret" aria-hidden="true">&#9662;</span>
      </button>
      <div class="icon-dropdown-menu" role="listbox" aria-label="Food options">
        ${optionsHtml}
      </div>
    </div>
  `;
}

function closeFoodDropdown(container) {
  const dropdown = container.querySelector(".icon-dropdown[data-food-dropdown]");
  if (!dropdown) {
    return;
  }
  dropdown.classList.remove("open");
  const trigger = dropdown.querySelector("[data-food-dropdown-trigger]");
  if (trigger) {
    trigger.setAttribute("aria-expanded", "false");
  }
}

function loadPendingDropdownImage(img) {
  const nextSrc = img?.getAttribute("data-src");
  if (!nextSrc) {
    return;
  }
  img.setAttribute("src", nextSrc);
  img.removeAttribute("data-src");
}

function preloadTopDropdownImages(menu, limit = INITIAL_DROPDOWN_PRELOAD_COUNT) {
  const pendingImages = Array.from(menu.querySelectorAll("img[data-src]"));
  pendingImages
    .slice(0, Math.max(0, Number(limit) || 0))
    .forEach((img) => loadPendingDropdownImage(img));
}

function ensureFoodDropdownLazyImageLoading(dropdown) {
  const menu = dropdown.querySelector(".icon-dropdown-menu");
  if (!menu) {
    return;
  }

  // Start with top-of-list options so the first rows fill immediately.
  preloadTopDropdownImages(menu, INITIAL_DROPDOWN_PRELOAD_COUNT);

  const pendingImages = Array.from(menu.querySelectorAll("img[data-src]"));
  if (pendingImages.length === 0) {
    return;
  }

  if (typeof window !== "undefined" && "IntersectionObserver" in window) {
    if (!dropdown.__iconLazyObserver) {
      dropdown.__iconLazyObserver = new window.IntersectionObserver(
        (entries, observer) => {
          const visibleEntries = entries
            .filter((entry) => entry.isIntersecting)
            .sort((left, right) => {
              const leftTop = Number(left?.target?.offsetTop) || 0;
              const rightTop = Number(right?.target?.offsetTop) || 0;
              return leftTop - rightTop;
            });
          for (const entry of visibleEntries) {
            if (!entry.isIntersecting) {
              continue;
            }
            loadPendingDropdownImage(entry.target);
            observer.unobserve(entry.target);
          }
        },
        {
          root: menu,
          rootMargin: "80px 0px",
          threshold: 0.01,
        },
      );
    }

    pendingImages.forEach((img) => {
      dropdown.__iconLazyObserver.observe(img);
    });
    return;
  }

  pendingImages.slice(0, 20).forEach((img) => {
    loadPendingDropdownImage(img);
  });
}

function wireFoodDropdown(container, handlers = {}) {
  const dropdown = container.querySelector(".icon-dropdown[data-food-dropdown]");
  if (!dropdown) {
    return;
  }

  const trigger = dropdown.querySelector("[data-food-dropdown-trigger]");
  if (trigger && !trigger.disabled) {
    trigger.addEventListener("click", () => {
      const nextOpenState = !dropdown.classList.contains("open");
      closeFoodDropdown(container);
      if (nextOpenState) {
        dropdown.classList.add("open");
        trigger.setAttribute("aria-expanded", "true");
        ensureFoodDropdownLazyImageLoading(dropdown);
      }
    });
  }

  dropdown.addEventListener("focusout", (event) => {
    const nextFocused = event.relatedTarget;
    if (!nextFocused || !dropdown.contains(nextFocused)) {
      closeFoodDropdown(container);
    }
  });

  dropdown.querySelectorAll("[data-food-dropdown-value]").forEach((optionButton) => {
    optionButton.addEventListener("click", (event) => {
      const selectedValue = event.currentTarget.getAttribute("data-food-dropdown-value");
      closeFoodDropdown(container);
      handlers.onFoodSelectChange?.(selectedValue);
    });
  });
}

function wireTargetHandlers(container, handlers) {
  const targetPairs = [
    ["target-gathering", "gathering"],
    ["target-perception", "perception"],
    ["target-gp", "gp"],
  ];

  for (const [elementId, statKey] of targetPairs) {
    const input = container.querySelector(`#${elementId}`);
    if (!input) {
      continue;
    }
    input.addEventListener("change", (event) => {
      handlers.onTargetDraftChange?.(statKey, event.target.value);
    });
  }

  const solveButton = container.querySelector("#target-solve");
  if (solveButton) {
    solveButton.addEventListener("click", () => {
      handlers.onTargetSolve?.();
    });
  }
}

function wireFoodHandlers(container, handlers) {
  const fixedCheckbox = container.querySelector("#food-fixed");
  if (fixedCheckbox) {
    fixedCheckbox.addEventListener("change", (event) => {
      handlers.onFoodFixedChange?.(event.target.checked);
    });
  }

  wireFoodDropdown(container, handlers);

  const hqCheckbox = container.querySelector("#food-hq");
  if (hqCheckbox) {
    hqCheckbox.addEventListener("change", (event) => {
      handlers.onFoodQualityChange?.(event.target.checked);
    });
  }
}

function buildGradeEditorHtml(state) {
  const gradesByTier = getAvailableGradesByTier(state);
  const hasAnyGrades = GRADE_TIERS.some((tier) => (gradesByTier[tier.key] ?? []).length > 0);
  if (!hasAnyGrades) {
    return "";
  }
  const tiersHtml = GRADE_TIERS.map((tier) => {
    const disallowed = disallowedGradesForTier(state, tier.key);
    const grades = gradesByTier[tier.key] ?? [];
    const chips = grades
      .map((grade) => {
        const allowed = !disallowed.includes(grade);
        return `
          <button
            type="button"
            class="grade-chip${allowed ? " grade-chip-active" : ""}"
            data-grade-tier="${escapeHtml(tier.key)}"
            data-grade-value="${grade}"
            aria-pressed="${allowed ? "true" : "false"}"
            title="${allowed ? "Allowed" : "Disallowed"} — Grade ${escapeHtml(gradeToRoman(grade))}"
          >${escapeHtml(gradeToRoman(grade))}</button>`;
      })
      .join("");
    return `
      <div class="grade-tier">
        <div class="grade-tier-head">
          <span class="${escapeHtml(tier.dotClass)}"></span>
          <span>${escapeHtml(tier.label)}</span>
        </div>
        <div class="grade-chip-row">${chips}</div>
      </div>`;
  }).join("");

  return `
    <section class="subpanel" id="grade-editor">
      <h3>Materia Grades</h3>
      <p class="muted">Click a grade to allow/disallow it per slot tier. Disabled grades are excluded from every solve (and refine).</p>
      ${tiersHtml}
    </section>
  `;
}

function wireGradeHandlers(container, handlers) {
  container.querySelectorAll("[data-grade-tier][data-grade-value]").forEach((chip) => {
    chip.addEventListener("click", (event) => {
      const tier = event.currentTarget.getAttribute("data-grade-tier");
      const grade = normalizeNonNegativeInteger(event.currentTarget.getAttribute("data-grade-value"), 0);
      // aria-pressed reflects current allowed state; toggling flips it.
      const currentlyAllowed = event.currentTarget.getAttribute("aria-pressed") === "true";
      handlers.onGradeTierToggle?.({ tier, grade, allowed: !currentlyAllowed });
    });
  });
}

function wireSolveHandlers(container, handlers) {
  const solveButton = container.querySelector("#solve-run");
  if (solveButton) {
    solveButton.addEventListener("click", () => {
      handlers.onSolveNow?.();
    });
  }

  const maxResultsInput = container.querySelector("#solve-max-results");
  if (maxResultsInput) {
    maxResultsInput.addEventListener("change", (event) => {
      handlers.onMaxResultsChange?.(event.target.value);
    });
  }

  const timeBudgetInput = container.querySelector("#solve-budget");
  if (timeBudgetInput) {
    timeBudgetInput.addEventListener("change", (event) => {
      handlers.onTimeBudgetChange?.(event.target.value);
    });
  }

  const bruteForceCheckbox = container.querySelector("#solve-bruteforce");
  if (bruteForceCheckbox) {
    bruteForceCheckbox.addEventListener("change", (event) => {
      handlers.onBruteForceChange?.(event.target.checked);
    });
  }
}

export function renderControlsPanel(container, state, handlers = {}) {
  const timeBudgetSeconds = Math.round(state.solve.timeBudgetMs / 1000);
  const solveDiagnostics = state.solveDiagnostics;
  const visitedBranches = solveDiagnostics?.visitedBranches ?? 0;
  const terminatedEarly = solveDiagnostics?.terminatedEarly ? "yes" : "no";
  const terminatedByTime = solveDiagnostics?.terminatedByTime ? "yes" : "no";
  const elapsedMs = solveDiagnostics?.elapsedMs ?? 0;
  const targetPrunes = solveDiagnostics?.pruneCounts?.target_unreachable ?? 0;
  const scorePrunes = solveDiagnostics?.pruneCounts?.score_bound ?? 0;
  const bruteForceChecked = state?.solve?.useBruteForce ? "checked" : "";
  const foodRows = Array.isArray(state?.data?.food?.rows) ? state.data.food.rows : [];
  const foodDropdownDisabled = state.food.isFixed !== true;
  const hqDisabled = state.food.isFixed ? "" : "disabled";
  const hqChecked = state.food.useHq ? "checked" : "";
  const gearTotals = selectedGearTotals(state);
  const pendingTargetChanges = hasPendingTargetChanges(state);
  const draftTargets = state?.draftTargets ?? state?.targets ?? {};
  const advancedEnabled = state?.advanced?.enabled === true;
  const maxResultsLimit = maxResultsLimitForAdvancedEnabled(advancedEnabled);
  const maxResults = Math.min(
    maxResultsLimit,
    Math.max(1, normalizeNonNegativeInteger(state?.solve?.maxResults, maxResultsLimit)),
  );
  const timeBudgetInputHtml = advancedEnabled
    ? ""
    : `
        <div class="input-row">
          <label for="solve-budget">Time Budget (s)</label>
          <input id="solve-budget" type="number" min="1" value="${timeBudgetSeconds}">
        </div>
      `;

  const standardTargetAndFoodHtml = advancedEnabled
    ? ""
    : `
      <section class="subpanel" id="target-editor">
        <h3>Targets</h3>
        <div class="input-row">
          <label for="target-gathering">Gathering</label>
          <input id="target-gathering" type="number" min="0" value="${normalizeNonNegativeInteger(draftTargets.gathering)}">
        </div>
        <div class="input-row">
          <label for="target-perception">Perception</label>
          <input id="target-perception" type="number" min="0" value="${normalizeNonNegativeInteger(draftTargets.perception)}">
        </div>
        <div class="input-row">
          <label for="target-gp">GP</label>
          <input id="target-gp" type="number" min="0" value="${normalizeNonNegativeInteger(draftTargets.gp)}">
        </div>
        <div class="button-row">
          <button id="target-solve" type="button">Solve</button>
        </div>
        <p class="muted">${pendingTargetChanges ? "Target changes pending. Press Solve to apply." : "Targets are applied."}</p>
      </section>

      <section class="subpanel" id="food-editor">
        <h3>Food</h3>
        <label class="checkbox-row" for="food-fixed">
          <input id="food-fixed" type="checkbox" ${state.food.isFixed ? "checked" : ""}>
          <span>Pick my own food</span>
        </label>
        <div class="input-row input-row-wide">
          <label for="food-select">Food</label>
          ${buildFoodDropdownHtml(state, foodDropdownDisabled)}
        </div>
        <label class="checkbox-row" for="food-hq">
          <input id="food-hq" type="checkbox" ${hqChecked} ${hqDisabled}>
          <span>Use HQ values</span>
        </label>
        ${renderSelectedFoodStats(state, gearTotals)}
        <p class="muted">Food rows available: ${foodRows.length}</p>
      </section>
    `;

  container.innerHTML = `
    <h2>Inputs</h2>
    <div class="stack">
      <section class="subpanel" id="gear-editor"></section>

      <section class="subpanel" id="gear-totals">
        <h3>Current Stat Totals</h3>
        <div class="input-row">
          <label>Gathering</label>
          <span>${gearTotals.gathering}</span>
        </div>
        <div class="input-row">
          <label>Perception</label>
          <span>${gearTotals.perception}</span>
        </div>
        <div class="input-row">
          <label>GP</label>
          <span>${gearTotals.gp}</span>
        </div>
      </section>

      ${standardTargetAndFoodHtml}

      <section class="subpanel" id="solve-editor">
        <h3>Solve</h3>
        <div class="button-row">
          <button id="solve-run" type="button">${advancedEnabled ? "Solve Advanced" : "Solve"}</button>
        </div>
        <div class="input-row">
          <label for="solve-max-results">Max Results</label>
          <input id="solve-max-results" type="number" min="1" max="${maxResultsLimit}" value="${maxResults}">
        </div>
        ${timeBudgetInputHtml}
        <label class="checkbox-row" for="solve-bruteforce">
          <input id="solve-bruteforce" type="checkbox" ${bruteForceChecked}>
          <span>Brute force mode (Recommended for Advanced Mode)</span>
        </label>
        <p class="muted">Visited branches: ${visitedBranches} | Early-stop: ${terminatedEarly} | Time-stop: ${terminatedByTime}</p>
        <p class="muted">Prunes: target ${targetPrunes}, score ${scorePrunes} | Solve time: ${elapsedMs}ms</p>
      </section>

      ${buildGradeEditorHtml(state)}
    </div>
  `;

  wireTargetHandlers(container, handlers);
  wireFoodHandlers(container, handlers);
  wireSolveHandlers(container, handlers);
  wireGradeHandlers(container, handlers);
}
